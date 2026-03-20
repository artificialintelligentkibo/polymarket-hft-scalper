import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config, type LogLevel } from './config.js';
import type { Outcome } from './clob-fetcher.js';
import type { SignalType, SignalUrgency } from './strategy-types.js';
import { roundTo } from './utils.js';

export interface LoggerOptions {
  name?: string;
  level?: LogLevel;
  directory?: string;
  logToFile?: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  name: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface CryptoPricesAtTime {
  BTC: number;
  ETH: number;
  SOL: number;
  XRP: number;
}

export interface TradeLogInput {
  phase: 'live' | 'backtest';
  timestampMs: number;
  slotKey: string;
  marketId: string;
  marketTitle: string;
  slotStart?: string | null;
  slotEnd?: string | null;
  tokenId: string;
  outcome: Outcome;
  outcomeIndex: 0 | 1;
  action: 'BUY' | 'SELL';
  reason: string;
  signalType: SignalType;
  priority: number;
  urgency: SignalUrgency;
  reduceOnly: boolean;
  tokenPrice: number | null;
  referencePrice: number | null;
  fairValue: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  combinedBid: number | null;
  combinedAsk: number | null;
  combinedMid: number | null;
  combinedDiscount: number | null;
  combinedPremium: number | null;
  edgeAmount: number;
  shares: number;
  notionalUsd: number;
  liquidityUsd: number;
  fillRatio: number;
  capitalClamp: number;
  priceMultiplier: number;
  inventoryImbalance: number;
  grossExposureShares: number;
  netYesShares: number;
  netNoShares: number;
  signedNetShares: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  slotEntryCount?: number;
  slotFillCount?: number;
  upExposureUsd?: number;
  downExposureUsd?: number;
  dayPnl?: number;
  peakDayPnl?: number;
  dayDrawdown?: number;
  latencySignalToOrderMs?: number;
  latencyRoundTripMs?: number;
  orderId?: string | null;
  wasMaker: boolean | null;
  simulationMode: boolean;
  dryRun: boolean;
  testMode: boolean;
}

export interface TradeLogRecord extends TradeLogInput {
  timestamp: string;
  crypto_prices_at_time: CryptoPricesAtTime;
}

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CACHE_WINDOW_MS = 60_000;
const BINANCE_SYMBOLS = {
  BTC: 'BTC/USDT',
  ETH: 'ETH/USDT',
  SOL: 'SOL/USDT',
  XRP: 'XRP/USDT',
} as const;

type CryptoSymbol = keyof typeof BINANCE_SYMBOLS;

interface OhlcvCapableExchange {
  loadMarkets(): Promise<unknown>;
  fetchOHLCV(
    symbol: string,
    timeframe?: string,
    since?: number,
    limit?: number
  ): Promise<Array<[number, number, number, number, number, number]>>;
}

const cryptoPriceCache = new Map<number, CryptoPricesAtTime>();
const cryptoPriceFetches = new Map<number, Promise<void>>();
let exchangePromise: Promise<OhlcvCapableExchange> | undefined;
let lastKnownCryptoPrices = emptyCryptoPrices();

export class StructuredLogger {
  constructor(private readonly baseOptions: LoggerOptions = {}) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', 'app', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', 'app', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', 'app', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', 'app', message, context);
  }

  event(event: string, message: string, context?: Record<string, unknown>): void {
    this.write('info', event, message, context);
  }

  private write(
    level: LogLevel,
    event: string,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const options = this.resolveOptions();
    if (!this.shouldWrite(options.level, level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      name: options.name,
      event,
      message,
      context: context && Object.keys(context).length > 0 ? context : undefined,
    };

    this.emitConsole(entry);

    if (options.logToFile) {
      void this.appendToFile(entry, options.directory);
    }
  }

  private resolveOptions(): Required<LoggerOptions> {
    return {
      name: this.baseOptions.name ?? 'polymarket-hft-scalper',
      level: this.baseOptions.level ?? config.logging.level,
      directory: this.baseOptions.directory ?? config.logging.directory,
      logToFile: this.baseOptions.logToFile ?? config.logging.logToFile,
    };
  }

  private shouldWrite(minLevel: LogLevel, level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[minLevel];
  }

  private emitConsole(entry: LogEntry): void {
    const serializedContext = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    const line = `[${entry.timestamp}] [${entry.level}] [${entry.event}] ${entry.message}${serializedContext}`;

    if (entry.level === 'warn') {
      console.warn(line);
      return;
    }

    if (entry.level === 'error') {
      console.error(line);
      return;
    }

    console.log(line);
  }

  private async appendToFile(entry: LogEntry, directory: string): Promise<void> {
    try {
      const resolvedDirectory = path.resolve(process.cwd(), directory);
      await mkdir(resolvedDirectory, { recursive: true });
      const filePath = path.join(
        resolvedDirectory,
        `events_${entry.timestamp.slice(0, 10)}.jsonl`
      );
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] [error] [logger] Failed to persist log entry`,
        error
      );
    }
  }
}

export class TradeLogger {
  async ensureReady(): Promise<string> {
    await ensureLogsDirectory();
    return getLogsDirectory();
  }

  async logTrade(input: TradeLogInput): Promise<TradeLogRecord> {
    await ensureLogsDirectory();

    const record: TradeLogRecord = {
      ...input,
      timestamp: new Date(input.timestampMs).toISOString(),
      tokenPrice: safeNumberOrNull(input.tokenPrice),
      referencePrice: safeNumberOrNull(input.referencePrice),
      fairValue: safeNumberOrNull(input.fairValue),
      midPrice: safeNumberOrNull(input.midPrice),
      bestBid: safeNumberOrNull(input.bestBid),
      bestAsk: safeNumberOrNull(input.bestAsk),
      combinedBid: safeNumberOrNull(input.combinedBid),
      combinedAsk: safeNumberOrNull(input.combinedAsk),
      combinedMid: safeNumberOrNull(input.combinedMid),
      combinedDiscount: safeNumberOrNull(input.combinedDiscount),
      combinedPremium: safeNumberOrNull(input.combinedPremium),
      edgeAmount: roundTo(input.edgeAmount, 6),
      shares: roundTo(input.shares, 4),
      notionalUsd: roundTo(input.notionalUsd, 2),
      liquidityUsd: roundTo(input.liquidityUsd, 2),
      fillRatio: roundTo(input.fillRatio, 4),
      capitalClamp: roundTo(input.capitalClamp, 4),
      priceMultiplier: roundTo(input.priceMultiplier, 4),
      inventoryImbalance: roundTo(input.inventoryImbalance, 4),
      grossExposureShares: roundTo(input.grossExposureShares, 4),
      netYesShares: roundTo(input.netYesShares, 4),
      netNoShares: roundTo(input.netNoShares, 4),
      signedNetShares: roundTo(input.signedNetShares, 4),
      realizedPnl: roundTo(input.realizedPnl, 4),
      unrealizedPnl: roundTo(input.unrealizedPnl, 4),
      totalPnl: roundTo(input.totalPnl, 4),
      slotEntryCount: safePositiveCount(input.slotEntryCount),
      slotFillCount: safePositiveCount(input.slotFillCount),
      upExposureUsd: safeNumberOrNull(input.upExposureUsd ?? null),
      downExposureUsd: safeNumberOrNull(input.downExposureUsd ?? null),
      dayPnl: safeNumberOrNull(input.dayPnl ?? null),
      peakDayPnl: safeNumberOrNull(input.peakDayPnl ?? null),
      dayDrawdown: safeNumberOrNull(input.dayDrawdown ?? null),
      latencySignalToOrderMs: safeLatency(input.latencySignalToOrderMs),
      latencyRoundTripMs: safeLatency(input.latencyRoundTripMs),
      crypto_prices_at_time: await getCryptoPrices(input.timestampMs),
    };

    await appendToJsonl('trades', record, input.timestampMs);
    return record;
  }

  async logBacktestSummary(summary: Record<string, unknown>, timestampMs = Date.now()): Promise<void> {
    await ensureLogsDirectory();
    await appendToJsonl('backtest_summary', summary, timestampMs);
  }
}

export async function ensureLogsDirectory(): Promise<string> {
  const directory = getLogsDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function getCryptoPrices(timestampMs: number): Promise<CryptoPricesAtTime> {
  const minuteBucket = Math.floor(timestampMs / CACHE_WINDOW_MS) * CACHE_WINDOW_MS;
  const cached = cryptoPriceCache.get(minuteBucket);
  if (cached) {
    return cached;
  }

  scheduleCryptoPriceFetch(minuteBucket);
  return lastKnownCryptoPrices;
}

async function appendToJsonl(
  prefix: string,
  record: Record<string, unknown>,
  timestampMs: number
): Promise<void> {
  const filePath = path.join(
    getLogsDirectory(),
    `${prefix}_${new Date(timestampMs).toISOString().slice(0, 10)}.jsonl`
  );
  try {
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [error] [trade-logger] Failed to append ${prefix} entry`,
      error
    );
  }
}

async function getBinanceExchange(): Promise<OhlcvCapableExchange> {
  if (!exchangePromise) {
    exchangePromise = import('ccxt').then(async (ccxtModule) => {
      const ExchangeCtor = (
        ccxtModule as unknown as {
          binance: new (options?: object) => OhlcvCapableExchange;
        }
      ).binance;
      const exchange = new ExchangeCtor({
        enableRateLimit: true,
        options: {
          defaultType: 'spot',
        },
      });
      await exchange.loadMarkets();
      return exchange;
    });
  }

  return exchangePromise;
}

async function fetchCandleClose(
  exchange: OhlcvCapableExchange,
  symbol: string,
  minuteBucket: number
): Promise<number> {
  const candles = await exchange.fetchOHLCV(symbol, '1m', minuteBucket, 1);
  const directClose = extractClosePrice(candles[0]);
  if (directClose > 0) {
    return directClose;
  }

  const fallbackCandles = await exchange.fetchOHLCV(
    symbol,
    '1m',
    minuteBucket - CACHE_WINDOW_MS,
    2
  );
  const exactFallback = fallbackCandles.find((entry) => entry?.[0] === minuteBucket);
  const fallbackClose = extractClosePrice(exactFallback ?? fallbackCandles.at(-1));
  if (fallbackClose > 0) {
    return fallbackClose;
  }

  throw new Error(`No Binance OHLCV candle returned for ${symbol} @ ${minuteBucket}`);
}

function extractClosePrice(
  candle?: [number, number, number, number, number, number]
): number {
  const close = Number(candle?.[4] ?? 0);
  return Number.isFinite(close) && close > 0 ? close : 0;
}

function pruneOldPriceCache(latestBucket: number): void {
  for (const bucket of cryptoPriceCache.keys()) {
    if (latestBucket - bucket > CACHE_WINDOW_MS * 10) {
      cryptoPriceCache.delete(bucket);
    }
  }
}

function scheduleCryptoPriceFetch(minuteBucket: number): void {
  if (cryptoPriceCache.has(minuteBucket) || cryptoPriceFetches.has(minuteBucket)) {
    return;
  }

  const task = (async () => {
    try {
      const exchange = await getBinanceExchange();
      const entries = await Promise.all(
        (Object.entries(BINANCE_SYMBOLS) as Array<[CryptoSymbol, string]>).map(
          async ([symbolKey, symbol]) => {
            const price = await fetchCandleClose(exchange, symbol, minuteBucket);
            return [symbolKey, price] as const;
          }
        )
      );

      const snapshot = Object.fromEntries(entries) as CryptoPricesAtTime;
      cryptoPriceCache.set(minuteBucket, snapshot);
      lastKnownCryptoPrices = snapshot;
      pruneOldPriceCache(minuteBucket);
      return;
    } catch (error: any) {
      logger.warn('Could not fetch CCXT crypto prices', {
        timestampMs: minuteBucket,
        message: error?.message || 'Unknown error',
      });

      if (!cryptoPriceCache.has(minuteBucket)) {
        cryptoPriceCache.set(minuteBucket, lastKnownCryptoPrices);
      }
      pruneOldPriceCache(minuteBucket);
    } finally {
      cryptoPriceFetches.delete(minuteBucket);
    }
  })();

  cryptoPriceFetches.set(minuteBucket, task);
  void task;
}

function getLogsDirectory(): string {
  return path.resolve(process.cwd(), config.logging.directory);
}

function emptyCryptoPrices(): CryptoPricesAtTime {
  return {
    BTC: 0,
    ETH: 0,
    SOL: 0,
    XRP: 0,
  };
}

function safeNumberOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}

function safeLatency(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, roundTo(value, 0));
}

function safePositiveCount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.round(value));
}

export const logger = new StructuredLogger();
