import WebSocket from 'ws';
import { config, isDeepBinanceEnabled, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { clamp, roundTo } from './utils.js';

export type DeepBinanceDirection = 'UP' | 'DOWN' | 'FLAT';

export interface DeepBinanceAssessment {
  readonly available: boolean;
  readonly coin: string;
  readonly symbol: string | null;
  readonly reason: string | null;
  readonly binanceBid: number | null;
  readonly binanceAsk: number | null;
  readonly binanceMid: number | null;
  readonly binanceSpreadRatio: number | null;
  readonly slotOpenMid: number | null;
  readonly binanceMovePct: number | null;
  readonly volatilityRatio: number | null;
  readonly fundingRate: number | null;
  readonly fundingBasis: number | null;
  readonly polymarketMid: number | null;
  readonly fairValue: number | null;
  readonly direction: DeepBinanceDirection;
}

interface DeepBinanceMidSample {
  readonly value: number;
  readonly recordedAtMs: number;
}

interface DeepBinanceBookState {
  bestBid: number | null;
  bestAsk: number | null;
  fundingRate: number | null;
  lastMarkPrice: number | null;
  updatedAtMs: number | null;
  recentMidSamples: DeepBinanceMidSample[];
}

interface SlotOpenSnapshot {
  readonly openMid: number;
  readonly recordedAtMs: number;
}

export interface DeepBinanceFairValueParams {
  readonly binanceMid: number;
  readonly slotOpenMid: number;
  readonly polymarketMid: number;
  readonly fundingRate: number;
  readonly binanceMovePct: number;
  readonly runtimeConfig?: AppConfig;
}

const BINANCE_FUTURES_WS_URL = 'wss://fstream.binance.com/stream?streams=';
const DEFAULT_VOLATILITY_WINDOW_MS = 60_000;
const DEFAULT_SLOT_RETENTION_MS = 15 * 60_000;

const COIN_TO_BINANCE_FUTURES: Record<string, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
  BNB: 'bnbusdt',
  DOGE: 'dogeusdt',
};

export function calculateFairValue(params: DeepBinanceFairValueParams): number {
  const runtimeConfig = params.runtimeConfig ?? config;
  const totalWeight =
    runtimeConfig.BINANCE_FAIR_VALUE_WEIGHT +
    runtimeConfig.POLYMARKET_FAIR_VALUE_WEIGHT +
    runtimeConfig.BINANCE_FUNDING_WEIGHT;

  if (totalWeight <= 0) {
    return roundTo(clamp(params.polymarketMid, 0.001, 0.999), 6);
  }

  // Convert Binance price discovery into the same 0..1 probability space that
  // Polymarket tokens use. The slot-open move is the stable directional anchor.
  const normalizedBinanceComponent = clamp(
    0.5 + params.binanceMovePct * runtimeConfig.strategy.binanceFvSensitivity,
    0.001,
    0.999
  );

  // Funding is kept deliberately conservative so it nudges fair value instead
  // of dominating it. Typical funding rates are tiny, so this produces a
  // shallow 0.45..0.55 directional basis.
  const fundingBasis = clamp(0.5 + params.fundingRate * 50, 0.45, 0.55);

  const weightedFairValue =
    normalizedBinanceComponent * runtimeConfig.BINANCE_FAIR_VALUE_WEIGHT +
    clamp(params.polymarketMid, 0.001, 0.999) * runtimeConfig.POLYMARKET_FAIR_VALUE_WEIGHT +
    fundingBasis * runtimeConfig.BINANCE_FUNDING_WEIGHT;

  return roundTo(clamp(weightedFairValue / totalWeight, 0.001, 0.999), 6);
}

export function shouldBlockSignalByBinanceSpread(params: {
  readonly binanceSpreadRatio: number | null;
  readonly runtimeConfig?: AppConfig;
}): boolean {
  const runtimeConfig = params.runtimeConfig ?? config;
  if (
    params.binanceSpreadRatio === null ||
    !Number.isFinite(params.binanceSpreadRatio) ||
    params.binanceSpreadRatio <= 0
  ) {
    return false;
  }

  return params.binanceSpreadRatio > runtimeConfig.MIN_BINANCE_SPREAD_THRESHOLD;
}

export function getDynamicSpreadTicks(params: {
  readonly baseTicks: number;
  readonly volatilityRatio: number | null;
  readonly runtimeConfig?: AppConfig;
}): number {
  const runtimeConfig = params.runtimeConfig ?? config;
  if (
    params.volatilityRatio === null ||
    !Number.isFinite(params.volatilityRatio) ||
    params.volatilityRatio <= 0
  ) {
    return Math.max(1, Math.round(params.baseTicks));
  }

  const multiplier = 1 + params.volatilityRatio * 100 * runtimeConfig.DYNAMIC_SPREAD_VOL_FACTOR;
  return clamp(Math.round(params.baseTicks * multiplier), Math.max(1, params.baseTicks), 12);
}

export class BinanceDeepIntegration {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private readonly books = new Map<string, DeepBinanceBookState>();
  private readonly slotOpenMids = new Map<string, SlotOpenSnapshot>();
  private readonly smoothedFairValues = new Map<string, number>();

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    private readonly now: () => number = () => Date.now()
  ) {}

  start(): void {
    if (!isDeepBinanceEnabled(this.runtimeConfig) || this.started) {
      return;
    }

    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.books.clear();
    this.slotOpenMids.clear();
    this.smoothedFairValues.clear();
  }

  isReady(coin?: string): boolean {
    if (!isDeepBinanceEnabled(this.runtimeConfig)) {
      return false;
    }

    if (!coin) {
      return Array.from(this.books.values()).some(
        (state) => state.bestBid !== null && state.bestAsk !== null
      );
    }

    const symbol = resolveFuturesSymbol(coin);
    if (!symbol) {
      return false;
    }

    const state = this.books.get(symbol);
    return Boolean(state && state.bestBid !== null && state.bestAsk !== null);
  }

  recordSlotOpen(coin: string, slotStartTime: string): void {
    const symbol = resolveFuturesSymbol(coin);
    if (!symbol || !slotStartTime) {
      return;
    }

    const key = buildSlotKey(coin, slotStartTime);
    if (this.slotOpenMids.has(key)) {
      return;
    }

    const state = this.books.get(symbol);
    const mid = resolveBookMid(state);
    if (mid === null) {
      return;
    }

    this.slotOpenMids.set(key, {
      openMid: mid,
      recordedAtMs: this.now(),
    });
    this.pruneSlotOpenSnapshots();
  }

  calculateFairValue(params: {
    coin: string;
    slotStartTime: string;
    polymarketMid: number | null;
  }): DeepBinanceAssessment {
    const symbol = resolveFuturesSymbol(params.coin);
    if (!symbol) {
      return createUnavailableAssessment(params.coin, null, 'unsupported_coin');
    }

    const state = this.books.get(symbol);
    const binanceMid = resolveBookMid(state);
    if (binanceMid === null) {
      return createUnavailableAssessment(params.coin, symbol, 'no_binance_mid');
    }

    const slotOpen = this.slotOpenMids.get(buildSlotKey(params.coin, params.slotStartTime));
    if (!slotOpen) {
      return createUnavailableAssessment(params.coin, symbol, 'no_slot_open_mid', state);
    }

    const spreadRatio =
      state !== undefined &&
      state.bestBid !== null &&
      state.bestAsk !== null &&
      binanceMid > 0
        ? roundTo((state.bestAsk - state.bestBid) / binanceMid, 6)
        : null;
    const binanceMovePct = roundTo(((binanceMid - slotOpen.openMid) / slotOpen.openMid) * 100, 6);
    const volatilityRatio = resolveVolatilityRatio(state, this.now());
    const fundingRate = state?.fundingRate ?? 0;
    const fundingBasis = roundTo(clamp(0.5 + fundingRate * 50, 0.45, 0.55), 6);
    const direction = resolveDirection(binanceMovePct, this.runtimeConfig);

    const fairValue =
      params.polymarketMid !== null && Number.isFinite(params.polymarketMid)
        ? calculateFairValue({
            binanceMid,
            slotOpenMid: slotOpen.openMid,
            polymarketMid: params.polymarketMid,
            fundingRate,
            binanceMovePct,
            runtimeConfig: this.runtimeConfig,
          })
        : null;
    const smoothedFairValue =
      fairValue !== null
        ? this.applyFairValueSmoothing(params.coin, params.slotStartTime, fairValue)
        : null;

    return {
      available: true,
      coin: params.coin.toUpperCase(),
      symbol,
      reason: null,
      binanceBid: state?.bestBid ?? null,
      binanceAsk: state?.bestAsk ?? null,
      binanceMid,
      binanceSpreadRatio: spreadRatio,
      slotOpenMid: slotOpen.openMid,
      binanceMovePct,
      volatilityRatio,
      fundingRate,
      fundingBasis,
      polymarketMid: params.polymarketMid,
      fairValue: smoothedFairValue,
      direction,
    };
  }

  shouldBlockSignalByBinanceSpread(assessment: DeepBinanceAssessment): boolean {
    return shouldBlockSignalByBinanceSpread({
      binanceSpreadRatio: assessment.binanceSpreadRatio,
      runtimeConfig: this.runtimeConfig,
    });
  }

  getDynamicSpreadTicks(
    assessment: Pick<DeepBinanceAssessment, 'volatilityRatio'>,
    baseTicks: number = this.runtimeConfig.QUOTING_SPREAD_TICKS
  ): number {
    return getDynamicSpreadTicks({
      baseTicks,
      volatilityRatio: assessment.volatilityRatio,
      runtimeConfig: this.runtimeConfig,
    });
  }

  /**
   * Applies EMA smoothing to the deep fair value stream for a single slot.
   * A new slot key seeds from the raw observation, so smoothing resets
   * automatically when slotStartTime changes.
   */
  private applyFairValueSmoothing(
    coin: string,
    slotStartTime: string,
    rawFairValue: number
  ): number {
    if (!this.runtimeConfig.BAYESIAN_FV_ENABLED) {
      return rawFairValue;
    }

    const key = buildSlotKey(coin, slotStartTime);
    const prev = this.smoothedFairValues.get(key);
    const alpha = this.runtimeConfig.BAYESIAN_FV_ALPHA;
    const smoothed =
      prev === undefined || !Number.isFinite(prev)
        ? rawFairValue
        : roundTo(alpha * rawFairValue + (1 - alpha) * prev, 6);
    const clamped = clamp(smoothed, 0.001, 0.999);

    this.smoothedFairValues.set(key, clamped);
    logger.debug('Bayesian FV smoothing applied', {
      key,
      rawFairValue,
      prevSmoothedFV: prev ?? null,
      newSmoothedFV: clamped,
      alpha,
    });

    return clamped;
  }

  private connect(): void {
    const streams = resolveStreams(this.runtimeConfig);
    if (streams.length === 0) {
      logger.warn('Deep Binance integration disabled because no supported symbols were selected');
      return;
    }

    const url = `${BINANCE_FUTURES_WS_URL}${streams.join('/')}`;
    this.socket = new WebSocket(url);

    this.socket.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info('Deep Binance WebSocket connected', {
        symbols: resolveEnabledSymbols(this.runtimeConfig),
        depthLevels: resolveDepthStreamLevels(this.runtimeConfig.BINANCE_DEPTH_LEVELS),
      });
    });

    this.socket.on('message', (payload) => {
      this.handleMessage(normalizeWsPayload(payload));
    });

    this.socket.on('error', (error) => {
      logger.warn('Deep Binance WebSocket error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    this.socket.on('close', () => {
      logger.warn('Deep Binance WebSocket closed');
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || !isDeepBinanceEnabled(this.runtimeConfig) || this.reconnectTimer) {
      return;
    }

    if (this.reconnectAttempts >= this.runtimeConfig.binance.maxReconnectAttempts) {
      logger.warn('Deep Binance reconnect attempts exhausted', {
        attempts: this.reconnectAttempts,
      });
      return;
    }

    const delayMs = Math.min(
      this.runtimeConfig.binance.wsReconnectMs * 2 ** this.reconnectAttempts,
      60_000
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    const stream = typeof (payload as { stream?: unknown }).stream === 'string'
      ? (payload as { stream: string }).stream
      : '';
    const data = (payload as { data?: unknown }).data;
    if (!stream || !data || typeof data !== 'object') {
      return;
    }

    const symbol = stream.split('@')[0]?.toLowerCase();
    if (!symbol) {
      return;
    }

    const state = this.books.get(symbol) ?? createEmptyBookState();
    if (stream.includes('@depth')) {
      const bids = normalizeLevels((data as { b?: unknown }).b, this.runtimeConfig.BINANCE_DEPTH_LEVELS);
      const asks = normalizeLevels((data as { a?: unknown }).a, this.runtimeConfig.BINANCE_DEPTH_LEVELS);
      state.bestBid = bids[0]?.price ?? state.bestBid;
      state.bestAsk = asks[0]?.price ?? state.bestAsk;
      state.updatedAtMs = this.now();
      const mid = resolveBookMid(state);
      if (mid !== null) {
        state.recentMidSamples.push({
          value: mid,
          recordedAtMs: this.now(),
        });
        state.recentMidSamples = pruneMidSamples(state.recentMidSamples, this.now());
      }
    } else if (stream.includes('@markPrice')) {
      const markPrice = Number.parseFloat(String((data as { p?: unknown }).p ?? ''));
      const fundingRate = Number.parseFloat(String((data as { r?: unknown }).r ?? ''));
      if (Number.isFinite(markPrice) && markPrice > 0) {
        state.lastMarkPrice = markPrice;
      }
      if (Number.isFinite(fundingRate)) {
        state.fundingRate = fundingRate;
      }
      state.updatedAtMs = this.now();
    }

    this.books.set(symbol, state);
    this.pruneSlotOpenSnapshots();
  }

  private pruneSlotOpenSnapshots(): void {
    const cutoff = this.now() - DEFAULT_SLOT_RETENTION_MS;
    for (const [key, snapshot] of this.slotOpenMids.entries()) {
      if (snapshot.recordedAtMs < cutoff) {
        this.slotOpenMids.delete(key);
      }
    }

    for (const key of this.smoothedFairValues.keys()) {
      if (!this.slotOpenMids.has(key)) {
        this.smoothedFairValues.delete(key);
      }
    }
  }
}

function resolveEnabledSymbols(runtimeConfig: AppConfig): string[] {
  return runtimeConfig.COINS_TO_TRADE.map((coin) => resolveFuturesSymbol(coin)).filter(
    (symbol): symbol is string => Boolean(symbol)
  );
}

function resolveStreams(runtimeConfig: AppConfig): string[] {
  const depthLevels = resolveDepthStreamLevels(runtimeConfig.BINANCE_DEPTH_LEVELS);
  const symbols = resolveEnabledSymbols(runtimeConfig);
  return symbols.flatMap((symbol) => [
    `${symbol}@depth${depthLevels}@100ms`,
    `${symbol}@markPrice@1s`,
  ]);
}

function resolveDepthStreamLevels(requestedLevels: number): 5 | 10 | 20 {
  if (requestedLevels >= 20) {
    return 20;
  }
  if (requestedLevels >= 10) {
    return 10;
  }
  return 5;
}

function resolveFuturesSymbol(coin: string): string | null {
  return COIN_TO_BINANCE_FUTURES[coin.toUpperCase()] ?? null;
}

function resolveBookMid(state: DeepBinanceBookState | undefined): number | null {
  if (!state) {
    return null;
  }
  if (
    state.bestBid !== null &&
    state.bestAsk !== null &&
    Number.isFinite(state.bestBid) &&
    Number.isFinite(state.bestAsk) &&
    state.bestBid > 0 &&
    state.bestAsk > 0
  ) {
    return roundTo((state.bestBid + state.bestAsk) / 2, 6);
  }
  if (state.lastMarkPrice !== null && Number.isFinite(state.lastMarkPrice) && state.lastMarkPrice > 0) {
    return roundTo(state.lastMarkPrice, 6);
  }

  return null;
}

function normalizeLevels(raw: unknown, maxLevels: number): Array<{ price: number; size: number }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const levels: Array<{ price: number; size: number }> = [];
  for (const entry of raw.slice(0, maxLevels)) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const price = Number.parseFloat(String(entry[0]));
    const size = Number.parseFloat(String(entry[1]));
    if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0) {
      levels.push({ price, size });
    }
  }

  return levels;
}

function pruneMidSamples(
  samples: readonly DeepBinanceMidSample[],
  nowMs: number
): DeepBinanceMidSample[] {
  const cutoff = nowMs - DEFAULT_VOLATILITY_WINDOW_MS;
  return samples.filter((sample) => sample.recordedAtMs >= cutoff);
}

function resolveVolatilityRatio(
  state: DeepBinanceBookState | undefined,
  nowMs: number
): number | null {
  if (!state) {
    return null;
  }

  const samples = pruneMidSamples(state.recentMidSamples, nowMs);
  state.recentMidSamples = samples;
  if (samples.length < 2) {
    return null;
  }

  const mids = samples.map((sample) => sample.value);
  const maxMid = Math.max(...mids);
  const minMid = Math.min(...mids);
  const currentMid = mids[mids.length - 1];
  if (!Number.isFinite(currentMid) || currentMid <= 0) {
    return null;
  }

  return roundTo((maxMid - minMid) / currentMid, 6);
}

function resolveDirection(
  movePct: number,
  runtimeConfig: AppConfig
): DeepBinanceDirection {
  if (movePct > runtimeConfig.binance.flatThreshold) {
    return 'UP';
  }
  if (movePct < -runtimeConfig.binance.flatThreshold) {
    return 'DOWN';
  }
  return 'FLAT';
}

function createEmptyBookState(): DeepBinanceBookState {
  return {
    bestBid: null,
    bestAsk: null,
    fundingRate: null,
    lastMarkPrice: null,
    updatedAtMs: null,
    recentMidSamples: [],
  };
}

function createUnavailableAssessment(
  coin: string,
  symbol: string | null,
  reason: string,
  state?: DeepBinanceBookState
): DeepBinanceAssessment {
  return {
    available: false,
    coin: coin.toUpperCase(),
    symbol,
    reason,
    binanceBid: state?.bestBid ?? null,
    binanceAsk: state?.bestAsk ?? null,
    binanceMid: resolveBookMid(state),
    binanceSpreadRatio: null,
    slotOpenMid: null,
    binanceMovePct: null,
    volatilityRatio: null,
    fundingRate: state?.fundingRate ?? null,
    fundingBasis: null,
    polymarketMid: null,
    fairValue: null,
    direction: 'FLAT',
  };
}

function buildSlotKey(coin: string, slotStartTime: string): string {
  return `${coin.toUpperCase()}:${slotStartTime}`;
}

function normalizeWsPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  if (Array.isArray(payload)) {
    return Buffer.concat(
      payload.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(entry)))
    ).toString('utf8');
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }

  return String(payload);
}
