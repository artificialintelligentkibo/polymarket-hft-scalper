import WebSocket from 'ws';
import { config, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { asRecord, asString, roundTo } from './utils.js';

export interface BinanceEdgeAssessment {
  available: boolean;
  coin: string;
  binancePrice: number | null;
  slotOpenPrice: number | null;
  binanceMovePct: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
  pmUpMid: number | null;
  pmImpliedDirection: 'UP' | 'DOWN' | 'FLAT';
  directionalAgreement: boolean;
  edgeStrength: number;
  sizeMultiplier: number;
  urgencyBoost: boolean;
  contraSignal: boolean;
  unavailableReason?: string;
}

interface SlotOpenReference {
  readonly openPrice: number;
  readonly createdAt: number;
}

interface BinancePriceSample {
  readonly price: number;
  readonly recordedAtMs: number;
}

const BINANCE_STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';
const SLOT_OPEN_TTL_MS = 10 * 60_000;
const PRICE_HISTORY_TTL_MS = 20 * 60_000;
const MAX_PRICE_SAMPLES_PER_SYMBOL = 4_096;

export const COIN_TO_BINANCE: Record<string, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
  DOGE: 'dogeusdt',
  BNB: 'bnbusdt',
  LINK: 'linkusdt',
};

/** Phase 48b: reverse lookup — Binance symbol → coin name (e.g. 'btcusdt' → 'BTC') */
const BINANCE_TO_COIN: Record<string, string> = Object.fromEntries(
  Object.entries(COIN_TO_BINANCE).map(([coin, sym]) => [sym, coin])
);

/** Phase 48b: callback type for real-time price update listeners */
export type BinancePriceUpdateCallback = (coin: string, price: number) => void;

export class BinanceEdgeProvider {
  private ws: WebSocket | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private connected = false;
  private readonly lastPrices = new Map<string, number>();
  private readonly lastPriceUpdatedAt = new Map<string, number>();
  private readonly slotOpenPrices = new Map<string, SlotOpenReference>();
  private readonly priceHistory = new Map<string, BinancePriceSample[]>();
  /** Phase 48b: registered listeners for real-time price updates */
  private readonly priceUpdateListeners: BinancePriceUpdateCallback[] = [];

  constructor(private readonly runtimeConfig: AppConfig = config) {}

  start(): void {
    if (!this.shouldRunFeed() || this.ws || this.reconnectTimer) {
      return;
    }

    this.startHeartbeat();
    this.connect();
  }

  /**
   * Phase 48b: Register a callback that fires on every Binance WS price update.
   * Used by VS Engine to cancel stale quotes within ~50-100ms of a price move.
   * Callbacks receive (coin: 'BTC'|'ETH'|..., price: number).
   * Callbacks MUST be fast and non-throwing — they run on the WS message path.
   */
  onPriceUpdate(callback: BinancePriceUpdateCallback): void {
    this.priceUpdateListeners.push(callback);
  }

  stop(): void {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
  }

  isReady(): boolean {
    return this.runtimeConfig.binance.edgeEnabled && this.lastPrices.size > 0;
  }

  hasMarketData(): boolean {
    return this.lastPrices.size > 0;
  }

  /**
   * Returns raw price history samples for a coin.
   * Used by RegimeFilter for market regime classification.
   */
  getPriceHistory(coin: string): ReadonlyArray<{ readonly price: number; readonly recordedAtMs: number }> {
    const symbol = COIN_TO_BINANCE[coin.toUpperCase()];
    if (!symbol) return [];
    this.prunePriceHistory();
    return this.priceHistory.get(symbol) ?? [];
  }

  getLatestPrice(coin: string): number | null {
    const symbol = COIN_TO_BINANCE[coin.toUpperCase()];
    if (!symbol) {
      return null;
    }

    // Phase 40: return null if price is stale — prevents VS Engine and other
    // consumers from using outdated prices after WebSocket disconnect.
    const STALE_PRICE_THRESHOLD_MS = 30_000;
    const lastUpdate = this.lastPriceUpdatedAt.get(symbol);
    if (lastUpdate && Date.now() - lastUpdate > STALE_PRICE_THRESHOLD_MS) {
      return null;
    }

    return this.lastPrices.get(symbol) ?? null;
  }

  getPriceAt(coin: string, timestampMs: number): number | null {
    const symbol = COIN_TO_BINANCE[coin.toUpperCase()];
    if (!symbol || !Number.isFinite(timestampMs)) {
      return null;
    }

    this.prunePriceHistory();
    const history = this.priceHistory.get(symbol);
    if (!history || history.length === 0) {
      return null;
    }

    let bestSample: BinancePriceSample | null = null;
    for (const sample of history) {
      if (bestSample === null) {
        bestSample = sample;
        continue;
      }

      const sampleDistance = Math.abs(sample.recordedAtMs - timestampMs);
      const bestDistance = Math.abs(bestSample.recordedAtMs - timestampMs);
      if (
        sampleDistance < bestDistance ||
        (sampleDistance === bestDistance &&
          sample.recordedAtMs <= timestampMs &&
          bestSample.recordedAtMs > timestampMs)
      ) {
        bestSample = sample;
      }
    }

    return bestSample?.price ?? null;
  }

  getVelocityPctPerSec(
    coin: string,
    windowMs: number,
    nowMs = Date.now()
  ): number | null {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      return null;
    }

    const latestPrice = this.getLatestPrice(coin);
    const referencePrice = this.getPriceAt(coin, nowMs - windowMs);
    if (
      latestPrice === null ||
      referencePrice === null ||
      !Number.isFinite(latestPrice) ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      return null;
    }

    const movePct = ((latestPrice - referencePrice) / referencePrice) * 100;
    return roundTo(movePct / (windowMs / 1000), 6);
  }

  assess(params: {
    coin: string;
    slotStartTime: string | null;
    pmUpMid: number | null;
    signalAction: 'BUY' | 'SELL';
    signalOutcome: 'YES' | 'NO';
  }): BinanceEdgeAssessment {
    const coin = params.coin.toUpperCase();

    // Hard guard: when Binance edge is disabled (e.g. PAIRED_ARBITRAGE preset
    // or BINANCE_EDGE_ENABLED=false), short-circuit silently without any
    // "Binance edge unavailable" debug spam. Sniper / latency-momentum that
    // need this assessment should never be reached in those modes anyway.
    if (!this.runtimeConfig.binance.edgeEnabled) {
      return createUnavailableAssessment(coin, params.pmUpMid);
    }

    const symbol = COIN_TO_BINANCE[coin];
    const binancePrice = symbol ? this.lastPrices.get(symbol) ?? null : null;
    const slotOpenPrice = this.getSlotOpenPrice(coin, params.slotStartTime);

    if (!symbol) {
      return createUnavailableAssessment(coin, params.pmUpMid, 'no_binance_symbol');
    }

    if (binancePrice === null) {
      return createUnavailableAssessment(coin, params.pmUpMid, 'no_binance_price');
    }

    // Phase 40: Stale price guard — if the last Binance price update is older
    // than 30s, the WebSocket likely disconnected. Using a stale price inflates
    // binanceMovePct to 10-20% (fake), causing false SNIPER entries.
    // Observed 2026-04-12: overnight BTC "moves" of 10-20% were stale data.
    const STALE_PRICE_THRESHOLD_MS = 30_000;
    const lastUpdateMs = this.lastPriceUpdatedAt.get(symbol);
    if (lastUpdateMs && Date.now() - lastUpdateMs > STALE_PRICE_THRESHOLD_MS) {
      return createUnavailableAssessment(coin, params.pmUpMid, 'stale_price');
    }

    if (slotOpenPrice === null) {
      return createUnavailableAssessment(coin, params.pmUpMid, 'no_slot_open_price');
    }

    const binanceMovePct = roundTo(((binancePrice - slotOpenPrice) / slotOpenPrice) * 100, 4);
    const direction = resolveMoveDirection(
      binanceMovePct,
      this.runtimeConfig.binance.flatThreshold
    );
    const pmImpliedDirection = resolvePmDirection(params.pmUpMid);
    const signalBetsUp =
      (params.signalAction === 'BUY' && params.signalOutcome === 'YES') ||
      (params.signalAction === 'SELL' && params.signalOutcome === 'NO');
    const binanceSaysUp = direction === 'UP';
    const directionalAgreement = direction === 'FLAT' || signalBetsUp === binanceSaysUp;
    const edgeStrength = Math.abs(binanceMovePct);

    let sizeMultiplier = 1;
    let urgencyBoost = false;
    let contraSignal = false;

    if (edgeStrength < this.runtimeConfig.binance.flatThreshold) {
      sizeMultiplier = 1;
    } else if (directionalAgreement) {
      if (edgeStrength >= this.runtimeConfig.binance.strongThreshold) {
        sizeMultiplier = this.runtimeConfig.binance.boostMultiplier;
        urgencyBoost = true;
      } else {
        sizeMultiplier = roundTo(1 + (this.runtimeConfig.binance.boostMultiplier - 1) * 0.4, 4);
      }
    } else {
      contraSignal = true;
      if (
        edgeStrength >= this.runtimeConfig.binance.strongThreshold &&
        this.runtimeConfig.binance.blockOnStrongContra
      ) {
        sizeMultiplier = 0;
      } else {
        sizeMultiplier = this.runtimeConfig.binance.reduceMultiplier;
      }
    }

    return {
      available: true,
      coin,
      binancePrice,
      slotOpenPrice,
      binanceMovePct,
      direction,
      pmUpMid: params.pmUpMid,
      pmImpliedDirection,
      directionalAgreement,
      edgeStrength,
      sizeMultiplier,
      urgencyBoost,
      contraSignal,
    };
  }

  recordSlotOpen(coin: string, slotStartTime: string | null): void {
    const normalizedCoin = coin.toUpperCase();
    const symbol = COIN_TO_BINANCE[normalizedCoin];
    if (!symbol || !slotStartTime) {
      return;
    }

    const key = buildSlotKey(normalizedCoin, slotStartTime);
    if (this.slotOpenPrices.has(key)) {
      this.pruneSlotOpens();
      return;
    }

    const price = this.lastPrices.get(symbol);
    if (!price || !Number.isFinite(price) || price <= 0) {
      return;
    }

    // Phase 40: Don't record slot open from stale prices — a disconnected
    // WebSocket would lock in an old price as the slot reference, inflating
    // all subsequent binanceMovePct calculations for this slot.
    const STALE_PRICE_THRESHOLD_MS = 30_000;
    const lastUpdate = this.lastPriceUpdatedAt.get(symbol);
    if (lastUpdate && Date.now() - lastUpdate > STALE_PRICE_THRESHOLD_MS) {
      return;
    }

    this.slotOpenPrices.set(key, {
      openPrice: price,
      createdAt: Date.now(),
    });

    this.pruneSlotOpens();
  }

  getSlotOpenPrice(coin: string, slotStartTime: string | null): number | null {
    if (!slotStartTime) {
      return null;
    }

    this.pruneSlotOpens();
    return this.slotOpenPrices.get(buildSlotKey(coin.toUpperCase(), slotStartTime))?.openPrice ?? null;
  }

  ingestPriceTick(symbol: string, price: number, recordedAtMs = Date.now()): void {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }

    const normalizedSymbol = symbol.toLowerCase();
    this.connected = true;
    this.lastPrices.set(normalizedSymbol, price);
    this.lastPriceUpdatedAt.set(normalizedSymbol, Date.now());
    const history = this.priceHistory.get(normalizedSymbol) ?? [];
    history.push({
      price,
      recordedAtMs,
    });
    if (history.length > MAX_PRICE_SAMPLES_PER_SYMBOL) {
      history.splice(0, history.length - MAX_PRICE_SAMPLES_PER_SYMBOL);
    }
    this.priceHistory.set(normalizedSymbol, history);
    this.prunePriceHistory();

    // Phase 48b: fire real-time price update callbacks
    if (this.priceUpdateListeners.length > 0) {
      const coin = BINANCE_TO_COIN[normalizedSymbol];
      if (coin) {
        for (const cb of this.priceUpdateListeners) {
          try {
            cb(coin, price);
          } catch {
            // Callbacks must not crash the WS message handler
          }
        }
      }
    }
  }

  private connect(): void {
    const streamUrl = `${BINANCE_STREAM_BASE}${this.runtimeConfig.binance.symbols
      .map((symbol) => `${symbol.toLowerCase()}@miniTicker`)
      .join('/')}`;
    const ws = new WebSocket(streamUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Binance WebSocket connected', {
        symbols: this.runtimeConfig.binance.symbols,
      });
    });

    ws.on('message', (payload) => {
      this.handleMessage(payload.toString());
    });

    ws.on('ping', (data) => {
      ws.pong(data);
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.ws = undefined;
      logger.warn('Binance WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      this.connected = false;
      logger.warn('Binance WebSocket error', {
        message: error.message,
      });
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const payload = asRecord(parsed);
    const data = asRecord(payload?.data);
    if (!data) {
      return;
    }

    const symbol = asString(data.s).toLowerCase() || asString(payload?.stream).split('@')[0]?.toLowerCase();
    const price = Number.parseFloat(asString(data.c));
    if (!symbol || !Number.isFinite(price) || price <= 0) {
      return;
    }

    this.ingestPriceTick(symbol, price);
  }

  private scheduleReconnect(): void {
    if (!this.shouldRunFeed()) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= this.runtimeConfig.binance.maxReconnectAttempts) {
      logger.error('Binance WebSocket reconnect limit reached', {
        maxReconnectAttempts: this.runtimeConfig.binance.maxReconnectAttempts,
      });
      return;
    }

    const attempt = this.reconnectAttempts + 1;
    const delay = this.runtimeConfig.binance.wsReconnectMs * 2 ** this.reconnectAttempts;
    this.reconnectAttempts = attempt;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();

    logger.warn('Scheduling Binance WebSocket reconnect', {
      attempt,
      delayMs: delay,
    });
  }

  private pruneSlotOpens(): void {
    const cutoff = Date.now() - SLOT_OPEN_TTL_MS;
    for (const [key, reference] of this.slotOpenPrices.entries()) {
      if (reference.createdAt < cutoff) {
        this.slotOpenPrices.delete(key);
      }
    }
  }

  private prunePriceHistory(): void {
    const cutoff = Date.now() - PRICE_HISTORY_TTL_MS;
    for (const [symbol, samples] of this.priceHistory.entries()) {
      const next = samples.filter((sample) => sample.recordedAtMs >= cutoff);
      if (next.length === 0) {
        this.priceHistory.delete(symbol);
        continue;
      }
      this.priceHistory.set(symbol, next);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      logger.debug('Binance WS health', {
        connected: this.connected,
        symbols: this.lastPrices.size,
        slotOpenPrices: this.slotOpenPrices.size,
        priceHistorySymbols: this.priceHistory.size,
        reconnectAttempts: this.reconnectAttempts,
      });
    }, 60_000);
    this.heartbeatTimer.unref?.();
  }

  private shouldRunFeed(): boolean {
    return (
      this.runtimeConfig.binance.edgeEnabled ||
      this.runtimeConfig.LATENCY_MOMENTUM_ENABLED ||
      this.runtimeConfig.PAPER_TRADING_ENABLED ||
      this.runtimeConfig.vsEngine.enabled
    );
  }
}

export function extractCoinFromTitle(title: string): string | null {
  const upper = String(title || '').toUpperCase();
  for (const coin of Object.keys(COIN_TO_BINANCE)) {
    if (upper.includes(coin)) {
      return coin;
    }
  }
  if (/\bBITCOIN\b/i.test(title)) {
    return 'BTC';
  }
  if (/\bETHEREUM\b/i.test(title)) {
    return 'ETH';
  }
  if (/\bSOLANA\b/i.test(title)) {
    return 'SOL';
  }
  return null;
}

function buildSlotKey(coin: string, slotStartTime: string): string {
  return `${coin}:${slotStartTime}`;
}

function createUnavailableAssessment(
  coin: string,
  pmUpMid: number | null,
  reason?: string
): BinanceEdgeAssessment {
  if (reason) {
    logger.debug('Binance edge unavailable', {
      coin,
      reason,
    });
  }

  return {
    available: false,
    coin,
    binancePrice: null,
    slotOpenPrice: null,
    binanceMovePct: 0,
    direction: 'FLAT',
    pmUpMid,
    pmImpliedDirection: resolvePmDirection(pmUpMid),
    directionalAgreement: true,
    edgeStrength: 0,
    sizeMultiplier: 1,
    urgencyBoost: false,
    contraSignal: false,
    unavailableReason: reason,
  };
}

function resolveMoveDirection(
  movePct: number,
  flatThreshold: number
): 'UP' | 'DOWN' | 'FLAT' {
  if (movePct > flatThreshold) {
    return 'UP';
  }
  if (movePct < -flatThreshold) {
    return 'DOWN';
  }
  return 'FLAT';
}

function resolvePmDirection(pmUpMid: number | null): 'UP' | 'DOWN' | 'FLAT' {
  if (pmUpMid === null || !Number.isFinite(pmUpMid)) {
    return 'FLAT';
  }
  if (pmUpMid > 0.52) {
    return 'UP';
  }
  if (pmUpMid < 0.48) {
    return 'DOWN';
  }
  return 'FLAT';
}
