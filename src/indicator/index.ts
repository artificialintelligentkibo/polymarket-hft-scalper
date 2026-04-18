import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { BarAggregator, aggregateBatch, type OneSecondKline } from './aggregator.js';
import { BinanceKlineStream } from './binance-kline-ws.js';
import { backfillKlines } from './binance-rest-backfill.js';
import { toHeikinAshi } from './heikin-ashi.js';
import { startHttpServer } from './http-server.js';
import { createLogger, type IndicatorLogger } from './logger.js';
import { RangeBreakoutEngine } from './range-breakout.js';
import { RetentionRunner } from './retention.js';
import { SnapshotStore } from './snapshot-writer.js';
import type {
  HeikinAshiCandle,
  IndicatorConfig,
  LevelRow,
  RangeBreakoutParams,
  RangeEvent,
} from './types.js';

loadDotenv();

function parseIntEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseListEnv(key: string, fallback: readonly string[]): readonly string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function loadConfig(): IndicatorConfig {
  return {
    httpPort: parseIntEnv('INDICATOR_HTTP_PORT', 7788),
    symbols: parseListEnv('INDICATOR_SYMBOLS', [
      'BTCUSDT',
      'ETHUSDT',
      'XRPUSDT',
      'BNBUSDT',
      'SOLUSDT',
      'DOGEUSDT',
    ]),
    channelWidth: parseFloatEnv('INDICATOR_CHANNEL_WIDTH', 4.0),
    atrLen: parseIntEnv('INDICATOR_ATR_LEN', 200),
    smaLen: parseIntEnv('INDICATOR_SMA_LEN', 100),
    maxCount: parseIntEnv('INDICATOR_MAX_COUNT', 100),
    warmupBars: parseIntEnv('INDICATOR_WARMUP_BARS', 301),
    dbPath: process.env.INDICATOR_DB_PATH ?? './data/indicator.db',
    retentionHours: parseIntEnv('INDICATOR_RETENTION_HOURS', 5),
    eventsRetentionHours: parseIntEnv('INDICATOR_EVENTS_RETENTION_HOURS', 24),
    klineInterval: process.env.INDICATOR_KLINE_INTERVAL ?? '10s',
    klineSourceInterval: process.env.INDICATOR_KLINE_SOURCE_INTERVAL ?? '1s',
    bootstrapBars: parseIntEnv('INDICATOR_BOOTSTRAP_BARS', 6000),
    aggregationWindowMs: parseIntEnv('INDICATOR_AGGREGATION_WINDOW_MS', 10_000),
    binanceWsUrl: process.env.INDICATOR_BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
    binanceRestBase: process.env.INDICATOR_BINANCE_REST_BASE ?? 'https://api.binance.com',
    logLevel: ((process.env.INDICATOR_LOG_LEVEL ?? 'info') as IndicatorConfig['logLevel']),
  };
}

interface PerSymbol {
  readonly symbol: string;
  readonly aggregator: BarAggregator;
  readonly engine: RangeBreakoutEngine;
  prevHa: HeikinAshiCandle | undefined;
  bootstrapComplete: boolean;
  bufferedLive: OneSecondKline[];
  bootstrapHighWatermarkCloseMs: number;
  lastCrossUpper: number | null;
  lastCrossLower: number | null;
  lastFlags: { crossUpper: boolean; crossLower: boolean; resetNow: boolean };
}

class IndicatorService {
  private readonly cfg: IndicatorConfig;
  private readonly logger: IndicatorLogger;
  private readonly store: SnapshotStore;
  private readonly perSymbol: Map<string, PerSymbol> = new Map();
  private stream: BinanceKlineStream | null = null;
  private retention: RetentionRunner | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private httpApp: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  private stopped = false;

  constructor(cfg: IndicatorConfig) {
    this.cfg = cfg;
    this.logger = createLogger(cfg.logLevel);
    mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
    this.store = new SnapshotStore({ dbPath: cfg.dbPath });
  }

  async start(): Promise<void> {
    this.logger.info('service_start', {
      symbols: this.cfg.symbols,
      httpPort: this.cfg.httpPort,
      klineInterval: this.cfg.klineInterval,
      bootstrapBars: this.cfg.bootstrapBars,
      aggregationWindowMs: this.cfg.aggregationWindowMs,
    });

    const params: RangeBreakoutParams = {
      channelWidth: this.cfg.channelWidth,
      atrLen: this.cfg.atrLen,
      smaLen: this.cfg.smaLen,
      maxCount: this.cfg.maxCount,
      warmupBars: this.cfg.warmupBars,
    };
    for (const symbol of this.cfg.symbols) {
      this.perSymbol.set(symbol, {
        symbol,
        aggregator: new BarAggregator(this.cfg.aggregationWindowMs),
        engine: new RangeBreakoutEngine(symbol, params),
        prevHa: undefined,
        bootstrapComplete: false,
        bufferedLive: [],
        bootstrapHighWatermarkCloseMs: 0,
        lastCrossUpper: null,
        lastCrossLower: null,
        lastFlags: { crossUpper: false, crossLower: false, resetNow: false },
      });
    }

    this.httpApp = await startHttpServer({
      port: this.cfg.httpPort,
      deps: {
        store: this.store,
        logger: this.logger,
        expectedSymbols: this.cfg.symbols,
        isBootstrapped: (s) => this.perSymbol.get(s.toUpperCase())?.bootstrapComplete === true,
        wsConnected: () => this.stream?.connected === true,
      },
    });

    this.stream = new BinanceKlineStream({
      wsUrl: this.cfg.binanceWsUrl,
      symbols: this.cfg.symbols,
      sourceInterval: this.cfg.klineSourceInterval,
      logger: this.logger,
      onClosedKline: (symbol, kline) => this.handleLiveKline(symbol, kline),
    });
    this.stream.start();

    // Bootstrap all symbols in parallel
    await Promise.allSettled(this.cfg.symbols.map((s) => this.bootstrapSymbol(s)));

    this.retention = new RetentionRunner({
      store: this.store,
      logger: this.logger,
      levelsRetentionMs: this.cfg.retentionHours * 3600 * 1000,
      eventsRetentionMs: this.cfg.eventsRetentionHours * 3600 * 1000,
    });
    this.retention.start();

    this.snapshotTimer = setInterval(() => this.writePerSecondSnapshots(), 1000);
    this.healthTimer = setInterval(() => this.logHealth(), 5 * 60 * 1000);

    process.on('SIGINT', () => void this.shutdown());
    process.on('SIGTERM', () => void this.shutdown());
  }

  private async bootstrapSymbol(symbol: string): Promise<void> {
    const state = this.perSymbol.get(symbol);
    if (state === undefined) return;
    const startedAt = Date.now();
    this.logger.info('bootstrap_start', { symbol, bars: this.cfg.bootstrapBars });
    try {
      const klines = await backfillKlines({
        symbol,
        interval: this.cfg.klineSourceInterval,
        bars: this.cfg.bootstrapBars,
        restBase: this.cfg.binanceRestBase,
        logger: this.logger,
      });

      const windowBars = aggregateBatch(klines, this.cfg.aggregationWindowMs);
      let prevHa: HeikinAshiCandle | undefined;
      for (const bar of windowBars) {
        const ha = toHeikinAshi(bar, prevHa);
        prevHa = ha;
        const result = state.engine.ingest(ha);
        for (const ev of result.events) this.store.insertEvent(ev);
        state.lastFlags = {
          crossUpper: result.crossUpper,
          crossLower: result.crossLower,
          resetNow: result.resetNow,
        };
      }
      state.prevHa = prevHa;
      state.bootstrapHighWatermarkCloseMs =
        windowBars.length > 0 ? windowBars[windowBars.length - 1]!.closeTime : 0;
      state.lastCrossUpper = state.engine.state.lastCrossUpper;
      state.lastCrossLower = state.engine.state.lastCrossLower;
      state.bootstrapComplete = true;

      this.logger.info('bootstrap_ready', {
        symbol,
        barsProcessed: state.engine.state.barsProcessed,
        initialized: state.engine.state.initialized,
        value: state.engine.state.value,
        valueUpper: state.engine.state.valueUpper,
        valueLower: state.engine.state.valueLower,
        tookMs: Date.now() - startedAt,
      });

      // Drain any buffered live klines that arrived during bootstrap
      const buffered = state.bufferedLive;
      state.bufferedLive = [];
      for (const k of buffered) {
        if (k.closeTime <= state.bootstrapHighWatermarkCloseMs) continue;
        this.ingestLiveKline(state, k);
      }
    } catch (err) {
      this.logger.error('bootstrap_failed', {
        symbol,
        message: (err as Error).message,
      });
    }
  }

  private handleLiveKline(symbol: string, kline: OneSecondKline): void {
    const state = this.perSymbol.get(symbol);
    if (state === undefined) return;
    if (!state.bootstrapComplete) {
      state.bufferedLive.push(kline);
      const bufferMax = (this.cfg.aggregationWindowMs / 1000) * 4;
      if (state.bufferedLive.length > bufferMax) {
        state.bufferedLive.splice(0, state.bufferedLive.length - bufferMax);
      }
      return;
    }
    this.ingestLiveKline(state, kline);
  }

  private ingestLiveKline(state: PerSymbol, kline: OneSecondKline): void {
    const emission = state.aggregator.ingest(kline);
    if (emission === null) return;
    const ha = toHeikinAshi(emission.candle, state.prevHa);
    state.prevHa = ha;
    const result = state.engine.ingest(ha);
    for (const ev of result.events) {
      this.store.insertEvent(ev);
      this.logger.info('range_event', {
        symbol: state.symbol,
        eventType: ev.eventType,
        price: ev.price,
        levelRef: ev.levelRef,
        ts: ev.ts,
      });
    }
    state.lastFlags = {
      crossUpper: result.crossUpper,
      crossLower: result.crossLower,
      resetNow: result.resetNow,
    };
    state.lastCrossUpper = state.engine.state.lastCrossUpper;
    state.lastCrossLower = state.engine.state.lastCrossLower;
    this.logger.debug('kline_close', {
      symbol: state.symbol,
      closeTime: emission.candle.closeTime,
      close: emission.candle.close,
      resetNow: result.resetNow,
      count: state.engine.state.count,
    });
    if (result.resetNow) {
      this.logger.info('channel_reset', {
        symbol: state.symbol,
        cause: result.crossUpper ? 'bull_break' : result.crossLower ? 'bear_break' : 'max_count',
        value: state.engine.state.value,
        valueUpper: state.engine.state.valueUpper,
        valueLower: state.engine.state.valueLower,
      });
    }
    // Immediate snapshot so cache reflects the new bar close ASAP
    this.writeSnapshot(state, Date.now(), true);
  }

  private writePerSecondSnapshots(): void {
    const now = Date.now();
    for (const state of this.perSymbol.values()) {
      if (!state.engine.state.initialized) continue;
      this.writeSnapshot(state, now, false);
    }
  }

  private writeSnapshot(state: PerSymbol, now: number, fromBarClose: boolean): void {
    const s = state.engine.state;
    if (!s.initialized) return;
    const fresh = now - s.lastCandleCloseTime < this.cfg.aggregationWindowMs + 1_000;
    const row: LevelRow = {
      symbol: state.symbol,
      ts: now,
      lastBarCloseTs: s.lastCandleCloseTime,
      fresh,
      barsProcessed: s.barsProcessed,
      value: s.value,
      valueUpper: s.valueUpper,
      valueLower: s.valueLower,
      valueUpperMid: s.valueUpperMid,
      valueLowerMid: s.valueLowerMid,
      trend: s.trend,
      count: s.count,
      lastCrossUpper: s.lastCrossUpper,
      lastCrossLower: s.lastCrossLower,
      crossUpper: fromBarClose ? state.lastFlags.crossUpper : false,
      crossLower: fromBarClose ? state.lastFlags.crossLower : false,
      resetNow: fromBarClose ? state.lastFlags.resetNow : false,
    };
    try {
      this.store.insertLevelRow(row);
    } catch (err) {
      this.logger.error('snapshot_insert_error', {
        symbol: state.symbol,
        message: (err as Error).message,
      });
    }
  }

  private logHealth(): void {
    const summary = [...this.perSymbol.values()].map((s) => ({
      symbol: s.symbol,
      bootstrap: s.bootstrapComplete,
      barsProcessed: s.engine.state.barsProcessed,
      initialized: s.engine.state.initialized,
      value: s.engine.state.value,
    }));
    this.logger.info('health', {
      wsConnected: this.stream?.connected === true,
      wsReconnects: this.stream?.reconnects ?? 0,
      rowsInLevels: this.store.countLevels(),
      symbols: summary,
    });
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('service_shutdown', {});
    if (this.snapshotTimer !== null) clearInterval(this.snapshotTimer);
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.retention?.stop();
    this.stream?.stop();
    try {
      await this.httpApp?.close();
    } catch {
      // ignore
    }
    try {
      this.store.close();
    } catch {
      // ignore
    }
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const svc = new IndicatorService(cfg);
  await svc.start();
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      name: 'range-indicator',
      event: 'fatal',
      message: (err as Error).message,
      stack: (err as Error).stack,
    }) + '\n',
  );
  process.exit(1);
});
