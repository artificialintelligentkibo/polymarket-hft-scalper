/**
 * VS Engine — Binance Latency Arb Strategy (vague-sourdough replica)
 *
 * Two-phase strategy per 5-minute slot:
 *   Phase 1 (T-300s to T-30s): Passive MM around CDF-derived fair value
 *   Phase 2 (T-30s to T-5s):   Aggressive momentum buying when Binance
 *                                "already knows the answer"
 *
 * Fair value formula: P(Up) = Φ((spot - strike) / (σ · √(t/300)))
 *   spot   = current Binance price
 *   strike = Binance price at slot open
 *   σ      = realized 5-min volatility from Binance price history
 *   t      = seconds remaining until slot end
 *   Φ      = normal CDF (Abramowitz & Stegun approximation)
 *
 * Pure module — no I/O, no timers. The host wires it into the existing
 * processPreparedMarket / FillTracker pipeline.
 */

import type {
  MarketOrderbookSnapshot,
  Outcome,
  TokenBookSnapshot,
} from './clob-fetcher.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';
import { resolveStrategyLayer } from './strategy-types.js';
import { logger } from './logger.js';
import { roundTo } from './utils.js';
import type { VsSessionStats, VsCoinStats, VsDecisionRecord } from './runtime-status.js';

/* ------------------------------------------------------------------ */
/*  Binance feed interface (BinanceEdgeProvider implements this)       */
/* ------------------------------------------------------------------ */

export interface VsBinanceFeed {
  getLatestPrice(coin: string): number | null;
  getSlotOpenPrice(coin: string, slotStartTime: string | null): number | null;
  getPriceHistory(
    coin: string
  ): ReadonlyArray<{ readonly price: number; readonly recordedAtMs: number }>;
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export interface VsEngineConfig {
  readonly enabled: boolean;
  readonly shadowMode: boolean;
  // Fair value calculation
  readonly defaultVolatility: number;
  readonly volLookbackMs: number;
  readonly minVolSamples: number;
  // Phase 1: Passive MM
  readonly mmSpreadCents: number;
  readonly mmMinPrice: number;
  readonly mmMaxPrice: number;
  readonly mmShares: number;
  readonly mmMaxPositionShares: number;
  readonly mmCooldownMs: number;
  // Phase 2: Aggressive Momentum
  readonly momentumThresholdSigmas: number;
  readonly momentumMaxBuyPrice: number;
  readonly momentumShares: number;
  readonly momentumMaxPositionShares: number;
  // Exit
  readonly targetExitPrice: number;
  readonly timeExitBeforeEndMs: number;
  readonly timeExitMinPrice: number;
  // Timing
  readonly slotWarmupMs: number;
  readonly stopEntryBeforeEndMs: number;
  readonly cancelAllBeforeEndMs: number;
  readonly momentumPhaseMs: number;
  // Safety
  readonly hardStopUsd: number;
  readonly cooldownMs: number;
  readonly losingExitCooldownMs: number;
  readonly losingExitCooldownByCoinMs: number;
  readonly preflightBalanceCheck: boolean;
  readonly minLiquidityUsd: number;
  readonly minEntryPrice: number;
  readonly maxEntryPrice: number;
}

/* ------------------------------------------------------------------ */
/*  Math helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normal CDF approximation (Abramowitz & Stegun 26.2.17).
 * Accuracy: |error| < 7.5e-8
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate fair value for 5-min binary option using CDF:
 * P(Up) = Φ((spot - strike) / (σ · √(t/300)))
 *
 * @param spot   - Current Binance spot price
 * @param strike - Binance price at slot open
 * @param vol    - Realized volatility (fraction, not percent)
 * @param timeRemainingSec - Seconds until slot closes
 * @returns probability [0.001, 0.999]
 */
export function calculatePhiFairValue(
  spot: number,
  strike: number,
  vol: number,
  timeRemainingSec: number
): number {
  if (strike <= 0 || vol <= 0 || timeRemainingSec <= 0) {
    return 0.5;
  }
  // Normalize time: 300s = full slot
  const sqrtT = Math.sqrt(Math.max(timeRemainingSec, 0.1) / 300);
  const d = ((spot - strike) / strike) / (vol * sqrtT);
  return Math.max(0.001, Math.min(0.999, normalCDF(d)));
}

/**
 * Estimate realized 5-min volatility from price history.
 * Returns annualized fraction (e.g. 0.60 = 60%).
 */
export function estimateRealizedVolatility(
  history: ReadonlyArray<{ readonly price: number; readonly recordedAtMs: number }>,
  lookbackMs: number,
  minSamples: number
): number | null {
  const now = Date.now();
  const cutoff = now - lookbackMs;
  const samples = history.filter((s) => s.recordedAtMs >= cutoff);
  if (samples.length < minSamples) return null;

  // Calculate log returns
  const logReturns: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1].price > 0) {
      logReturns.push(Math.log(samples[i].price / samples[i - 1].price));
    }
  }
  if (logReturns.length < 2) return null;

  // Standard deviation of log returns
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Average time between samples in seconds
  const totalTimeMs = samples[samples.length - 1].recordedAtMs - samples[0].recordedAtMs;
  const avgIntervalSec = totalTimeMs / (samples.length - 1) / 1000;
  if (avgIntervalSec <= 0) return null;

  // Annualize: multiply by sqrt(periodsPerYear)
  // 1 year ≈ 365.25 * 24 * 3600 seconds
  const periodsPerYear = (365.25 * 24 * 3600) / avgIntervalSec;
  return stdDev * Math.sqrt(periodsPerYear);
}

/* ------------------------------------------------------------------ */
/*  Phase resolution                                                   */
/* ------------------------------------------------------------------ */

export type VsPhase = 'NONE' | 'PASSIVE_MM' | 'MOMENTUM' | 'EXIT';

export function resolvePhase(
  slotEndMs: number,
  nowMs: number,
  warmupMs: number,
  slotStartMs: number,
  momentumPhaseMs: number,
  timeExitBeforeEndMs: number
): VsPhase {
  const elapsed = nowMs - slotStartMs;
  const remaining = slotEndMs - nowMs;

  if (elapsed < warmupMs) return 'NONE';
  if (remaining <= timeExitBeforeEndMs) return 'EXIT';
  if (remaining <= momentumPhaseMs) return 'MOMENTUM';
  return 'PASSIVE_MM';
}

/* ------------------------------------------------------------------ */
/*  Internal position state                                            */
/* ------------------------------------------------------------------ */

interface VsPosition {
  readonly marketId: string;
  readonly marketTitle: string;
  outcome: Outcome;
  entryVwap: number;
  totalShares: number;
  readonly enteredAtMs: number;
  readonly phase: 'MM' | 'MOMENTUM';
  readonly slotEndMs: number;
  readonly slotStartMs: number;
  readonly strikePrice: number;
}

/* ------------------------------------------------------------------ */
/*  Coin extraction from market title                                  */
/* ------------------------------------------------------------------ */

function extractCoin(title: string): string | null {
  const match = title.match(
    /\b(Bitcoin|Ethereum|Solana|XRP|Dogecoin|BNB)\b/i
  );
  if (!match) return null;
  const name = match[1].toLowerCase();
  const MAP: Record<string, string> = {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    xrp: 'XRP',
    dogecoin: 'DOGE',
    bnb: 'BNB',
  };
  return MAP[name] ?? null;
}

/* ------------------------------------------------------------------ */
/*  VS Engine class                                                    */
/* ------------------------------------------------------------------ */

const MAX_RECENT_DECISIONS = 15;
const ORPHAN_GIVE_UP_AFTER_MS = 60_000;

export class VsEngine {
  /* ── Position tracking ─────────────────────────────────────────── */
  private readonly positions = new Map<string, VsPosition>();
  private readonly lastEntryMs = new Map<string, number>();
  private readonly lastLosingExitMs = new Map<string, number>();
  private readonly lastLosingExitMsByCoin = new Map<string, number>();
  private readonly lastOrphanEmitMs = new Map<string, number>();
  private availableUsdcBalance: number | null = null;

  /* ── Session stats ─────────────────────────────────────────────── */
  private totalEntries = 0;
  private totalExitSignals = 0;
  private totalConfirmedExits = 0;
  private wins = 0;
  private losses = 0;
  private realizedPnl = 0;
  private phase1Entries = 0;
  private phase1Pnl = 0;
  private phase2Entries = 0;
  private phase2Pnl = 0;
  private readonly coinStats = new Map<string, {
    entries: number;
    exits: number;
    phase1Entries: number;
    phase2Entries: number;
    realizedPnl: number;
    lastAction: string | null;
    lastActionAt: string | null;
  }>();
  private recentDecisions: VsDecisionRecord[] = [];

  /* ── Public API ─────────────────────────────────────────────────── */

  setAvailableUsdcBalance(usdc: number): void {
    this.availableUsdcBalance = usdc;
  }

  hasPosition(marketId: string): boolean {
    return this.positions.has(marketId);
  }

  getActivePositions(): ReadonlyMap<string, VsPosition> {
    return this.positions;
  }

  clearState(marketId: string): void {
    this.positions.delete(marketId);
    this.lastEntryMs.delete(marketId);
    this.lastOrphanEmitMs.delete(marketId);
  }

  /* ── Entry signal generation ────────────────────────────────────── */

  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: VsEngineConfig;
    binanceFeed: VsBinanceFeed;
    vsSizeMultiplier?: number;
    nowMs?: number;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config, binanceFeed } = params;
    const nowMs = params.nowMs ?? Date.now();

    if (!config.enabled) return [];

    const coin = extractCoin(market.title);
    if (!coin) return [];

    // Time checks
    const slotEndMs = market.endTime ? new Date(market.endTime).getTime() : null;
    const slotStartMs = market.startTime ? new Date(market.startTime).getTime() : null;
    if (!slotEndMs || !slotStartMs) return [];

    const phase = resolvePhase(
      slotEndMs, nowMs, config.slotWarmupMs, slotStartMs,
      config.momentumPhaseMs, config.timeExitBeforeEndMs
    );
    if (phase === 'NONE' || phase === 'EXIT') return [];

    // Already positioned? Don't enter more (for now)
    if (this.positions.has(market.marketId)) return [];

    // Cooldown
    const lastEntry = this.lastEntryMs.get(market.marketId);
    if (lastEntry && nowMs - lastEntry < config.cooldownMs) return [];

    // Losing exit cooldowns
    const lastLoss = this.lastLosingExitMs.get(market.marketId);
    if (lastLoss && nowMs - lastLoss < config.losingExitCooldownMs) return [];
    if (coin) {
      const lastCoinLoss = this.lastLosingExitMsByCoin.get(coin);
      if (lastCoinLoss && nowMs - lastCoinLoss < config.losingExitCooldownByCoinMs) return [];
    }

    // Liquidity check
    if (market.liquidityUsd < config.minLiquidityUsd) {
      this.recordDecision(coin, 'SKIP', phase, 'low_liquidity', null);
      return [];
    }

    // Binance data
    const spotPrice = binanceFeed.getLatestPrice(coin);
    const strikePrice = binanceFeed.getSlotOpenPrice(coin, market.startTime);
    if (!spotPrice || !strikePrice) {
      this.recordDecision(coin, 'SKIP', phase, 'no_binance_data', null);
      return [];
    }

    // Realized volatility
    const priceHistory = binanceFeed.getPriceHistory(coin);
    const realizedVol = estimateRealizedVolatility(
      priceHistory, config.volLookbackMs, config.minVolSamples
    );
    const vol = realizedVol ?? config.defaultVolatility;

    // Fair value
    const timeRemainingSec = (slotEndMs - nowMs) / 1000;
    const fairValueUp = calculatePhiFairValue(spotPrice, strikePrice, vol, timeRemainingSec);
    const fairValueDown = 1 - fairValueUp;

    if (phase === 'PASSIVE_MM') {
      return this.generatePassiveMMSignals(
        market, orderbook, positionManager, config, coin, fairValueUp,
        fairValueDown, spotPrice, strikePrice, slotEndMs, slotStartMs,
        params.vsSizeMultiplier ?? 1
      );
    }

    if (phase === 'MOMENTUM') {
      return this.generateMomentumSignals(
        market, orderbook, positionManager, config, coin, fairValueUp,
        fairValueDown, vol, spotPrice, strikePrice, slotEndMs, slotStartMs,
        params.vsSizeMultiplier ?? 1
      );
    }

    return [];
  }

  /* ── Phase 1: Passive MM ────────────────────────────────────────── */

  private generatePassiveMMSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    config: VsEngineConfig,
    coin: string,
    fairValueUp: number,
    fairValueDown: number,
    spotPrice: number,
    strikePrice: number,
    slotEndMs: number,
    slotStartMs: number,
    sizeMultiplier: number
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    // Determine which side to favor based on Binance direction
    const movePct = ((spotPrice - strikePrice) / strikePrice) * 100;
    const favorUp = movePct > 0;

    // Quote on the favored side only (accumulate inventory in Binance direction)
    const outcome: Outcome = favorUp ? 'YES' : 'NO';
    const fairValue = favorUp ? fairValueUp : fairValueDown;
    const book: TokenBookSnapshot = favorUp ? orderbook.yes : orderbook.no;

    // Price guard
    const bidPrice = roundTo(Math.max(fairValue - config.mmSpreadCents, config.mmMinPrice), 2);
    if (bidPrice < config.minEntryPrice || bidPrice > config.maxEntryPrice) {
      this.recordDecision(coin, 'SKIP', 'PASSIVE_MM', `price_out_of_range bid=${bidPrice}`, fairValue);
      return [];
    }

    // Position capacity check
    const currentShares = positionManager.getShares(outcome);
    if (currentShares >= config.mmMaxPositionShares) {
      this.recordDecision(coin, 'SKIP', 'PASSIVE_MM', 'max_position_reached', fairValue);
      return [];
    }

    // Balance check
    const shares = Math.round(config.mmShares * sizeMultiplier);
    if (config.preflightBalanceCheck && this.availableUsdcBalance !== null) {
      const cost = shares * bidPrice;
      if (cost > this.availableUsdcBalance * 0.9) {
        this.recordDecision(coin, 'SKIP', 'PASSIVE_MM', 'insufficient_balance', fairValue);
        return [];
      }
    }

    this.recordDecision(coin, 'ENTRY', 'PASSIVE_MM',
      `FV=${roundTo(fairValue, 3)} bid=${bidPrice} move=${roundTo(movePct, 3)}%`, fairValue);

    if (config.shadowMode) return [];

    signals.push(this.buildSignal({
      market,
      orderbook,
      signalType: 'VS_ENTRY_BUY',
      action: 'BUY',
      outcome,
      shares,
      targetPrice: bidPrice,
      fairValue,
      urgency: 'passive',
      reason: `VS Phase1: FV=${roundTo(fairValue, 3)} bid@${bidPrice} move=${roundTo(movePct, 3)}%`,
      reduceOnly: false,
      priority: 800,
      edgeAmount: Math.abs(movePct),
    }));

    return signals;
  }

  /* ── Phase 2: Aggressive Momentum ───────────────────────────────── */

  private generateMomentumSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    config: VsEngineConfig,
    coin: string,
    fairValueUp: number,
    fairValueDown: number,
    vol: number,
    spotPrice: number,
    strikePrice: number,
    slotEndMs: number,
    slotStartMs: number,
    sizeMultiplier: number
  ): StrategySignal[] {
    // Calculate z-score: how many sigmas away from strike
    const sqrtT = Math.sqrt(Math.max((slotEndMs - Date.now()) / 1000, 0.1) / 300);
    const zScore = ((spotPrice - strikePrice) / strikePrice) / (vol * sqrtT);

    // Need strong directional signal
    if (Math.abs(zScore) < config.momentumThresholdSigmas) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `zScore=${roundTo(zScore, 2)} < threshold=${config.momentumThresholdSigmas}`, null);
      return [];
    }

    // Determine winning outcome
    const outcome: Outcome = zScore > 0 ? 'YES' : 'NO';
    const fairValue = zScore > 0 ? fairValueUp : fairValueDown;
    const book: TokenBookSnapshot = zScore > 0 ? orderbook.yes : orderbook.no;

    // Don't buy above max price
    const bestAsk = book.bestAsk;
    if (!bestAsk || bestAsk > config.momentumMaxBuyPrice) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `ask=${bestAsk ?? 'null'} > max=${config.momentumMaxBuyPrice}`, fairValue);
      return [];
    }

    // Position capacity
    const currentShares = positionManager.getShares(outcome);
    if (currentShares >= config.momentumMaxPositionShares) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM', 'max_position_reached', fairValue);
      return [];
    }

    const shares = Math.round(config.momentumShares * sizeMultiplier);

    // Balance check
    if (config.preflightBalanceCheck && this.availableUsdcBalance !== null) {
      const cost = shares * bestAsk;
      if (cost > this.availableUsdcBalance * 0.9) {
        this.recordDecision(coin, 'SKIP', 'MOMENTUM', 'insufficient_balance', fairValue);
        return [];
      }
    }

    this.recordDecision(coin, 'ENTRY', 'MOMENTUM',
      `zScore=${roundTo(zScore, 2)} FV=${roundTo(fairValue, 3)} ask=${bestAsk}`, fairValue);

    if (config.shadowMode) return [];

    return [this.buildSignal({
      market,
      orderbook,
      signalType: 'VS_MOMENTUM_BUY',
      action: 'BUY',
      outcome,
      shares,
      targetPrice: bestAsk,
      fairValue,
      urgency: 'cross',
      reason: `VS Phase2: zScore=${roundTo(zScore, 2)} FV=${roundTo(fairValue, 3)} buying ${outcome}@${bestAsk}`,
      reduceOnly: false,
      priority: 950,
      edgeAmount: Math.abs(zScore),
    })];
  }

  /* ── Exit signal generation ─────────────────────────────────────── */

  generateExitSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: VsEngineConfig;
    nowMs?: number;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config } = params;
    const nowMs = params.nowMs ?? Date.now();
    const position = this.positions.get(market.marketId);
    if (!position) return [];

    const liveShares = positionManager.getShares(position.outcome);
    if (liveShares < 1) {
      this.clearState(market.marketId);
      return [];
    }

    const book: TokenBookSnapshot =
      position.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const bestBid = book.bestBid;

    const slotEndMs = market.endTime ? new Date(market.endTime).getTime() : position.slotEndMs;
    const remaining = slotEndMs - nowMs;

    // Time exit: forced flatten at T-5s
    if (remaining <= config.timeExitBeforeEndMs) {
      if (!bestBid || bestBid < config.timeExitMinPrice) return [];

      this.totalExitSignals += 1;
      return [this.buildSignal({
        market,
        orderbook,
        signalType: 'VS_TIME_EXIT',
        action: 'SELL',
        outcome: position.outcome,
        shares: liveShares,
        targetPrice: bestBid,
        fairValue: null,
        urgency: 'cross',
        reason: `VS time-exit: ${roundTo(remaining / 1000, 1)}s left, selling @${bestBid}`,
        reduceOnly: true,
        priority: 980,
        edgeAmount: 0,
      })];
    }

    // Scalp exit: bid >= target (0.97)
    if (bestBid && bestBid >= config.targetExitPrice) {
      this.totalExitSignals += 1;
      return [this.buildSignal({
        market,
        orderbook,
        signalType: 'VS_SCALP_EXIT',
        action: 'SELL',
        outcome: position.outcome,
        shares: liveShares,
        targetPrice: bestBid,
        fairValue: null,
        urgency: 'cross',
        reason: `VS scalp-exit: bid=${bestBid} >= target=${config.targetExitPrice}`,
        reduceOnly: true,
        priority: 960,
        edgeAmount: bestBid - position.entryVwap,
      })];
    }

    // MM ask: place resting sell above entry to capture profit
    if (bestBid && bestBid > position.entryVwap) {
      const askPrice = roundTo(Math.min(bestBid + 0.01, config.targetExitPrice), 2);
      this.totalExitSignals += 1;
      return [this.buildSignal({
        market,
        orderbook,
        signalType: 'VS_MM_ASK',
        action: 'SELL',
        outcome: position.outcome,
        shares: liveShares,
        targetPrice: askPrice,
        fairValue: null,
        urgency: 'passive',
        reason: `VS maker-ask: @${askPrice} (entry=${roundTo(position.entryVwap, 3)})`,
        reduceOnly: true,
        priority: 850,
        edgeAmount: askPrice - position.entryVwap,
      })];
    }

    return [];
  }

  /* ── Fill handling ──────────────────────────────────────────────── */

  onEntryFill(params: {
    marketId: string;
    marketTitle: string;
    outcome: Outcome;
    fillPrice: number;
    filledShares: number;
    slotEndTime: string | null;
    slotStartTime: string | null;
    strikePrice: number;
    phase: 'MM' | 'MOMENTUM';
  }): StrategySignal[] {
    const existing = this.positions.get(params.marketId);
    if (existing) {
      // Average in
      const totalShares = existing.totalShares + params.filledShares;
      const newVwap =
        (existing.entryVwap * existing.totalShares +
          params.fillPrice * params.filledShares) /
        totalShares;
      existing.entryVwap = newVwap;
      existing.totalShares = totalShares;
    } else {
      this.positions.set(params.marketId, {
        marketId: params.marketId,
        marketTitle: params.marketTitle,
        outcome: params.outcome,
        entryVwap: params.fillPrice,
        totalShares: params.filledShares,
        enteredAtMs: Date.now(),
        phase: params.phase,
        slotEndMs: params.slotEndTime ? new Date(params.slotEndTime).getTime() : Date.now() + 300_000,
        slotStartMs: params.slotStartTime ? new Date(params.slotStartTime).getTime() : Date.now(),
        strikePrice: params.strikePrice,
      });
    }
    this.lastEntryMs.set(params.marketId, Date.now());
    this.totalEntries += 1;
    if (params.phase === 'MM') this.phase1Entries += 1;
    else this.phase2Entries += 1;

    return []; // VS doesn't emit follow-on MM quotes on entry (exit signals handle that)
  }

  /* ── Emergency hard stop sweep ──────────────────────────────────── */

  getEmergencyHardStopSignals(params: {
    getPositionManager: (marketId: string) => PositionManager | undefined;
    getOrderbook: (marketId: string) => MarketOrderbookSnapshot | undefined;
    getMarket: (marketId: string) => MarketCandidate | undefined;
    config: VsEngineConfig;
  }): StrategySignal[] {
    const signals: StrategySignal[] = [];
    for (const [marketId, position] of this.positions) {
      const pm = params.getPositionManager(marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares < 1) {
        this.clearState(marketId);
        continue;
      }
      const orderbook = params.getOrderbook(marketId);
      const market = params.getMarket(marketId);
      if (!orderbook || !market) continue;

      const book = position.outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestBid = book.bestBid;
      if (!bestBid) continue;

      const unrealized = (bestBid - position.entryVwap) * liveShares;
      if (unrealized <= -params.config.hardStopUsd) {
        signals.push(this.buildSignal({
          market,
          orderbook,
          signalType: 'VS_SCALP_EXIT',
          action: 'SELL',
          outcome: position.outcome,
          shares: liveShares,
          targetPrice: bestBid,
          fairValue: null,
          urgency: 'cross',
          reason: `VS hard-stop: unrealized=${roundTo(unrealized, 2)} <= -${params.config.hardStopUsd}`,
          reduceOnly: true,
          priority: 990,
          edgeAmount: 0,
        }));
      }
    }
    return signals;
  }

  /* ── Orphan flatten (slot ended) ────────────────────────────────── */

  getOrphanFlattenSignals(params: {
    getPositionManager: (marketId: string) => PositionManager | undefined;
    getOrderbook: (marketId: string) => MarketOrderbookSnapshot | undefined;
    getMarket: (marketId: string) => MarketCandidate | undefined;
    config: VsEngineConfig;
    nowMs?: number;
  }): StrategySignal[] {
    const nowMs = params.nowMs ?? Date.now();
    const signals: StrategySignal[] = [];

    for (const [marketId, position] of this.positions) {
      const remaining = position.slotEndMs - nowMs;
      if (remaining > 0) continue; // slot still active

      const pm = params.getPositionManager(marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares < 1) {
        this.clearState(marketId);
        continue;
      }

      // Give up after ORPHAN_GIVE_UP_AFTER_MS
      if (remaining < -ORPHAN_GIVE_UP_AFTER_MS) {
        const lastLog = this.lastOrphanEmitMs.get(marketId);
        if (!lastLog || nowMs - lastLog > 30_000) {
          logger.warn('VS orphan: slot ended, position still has shares — continuing exit attempts', {
            marketId, outcome: position.outcome, liveShares: roundTo(liveShares, 4),
          });
          this.lastOrphanEmitMs.set(marketId, nowMs);
        }
      }

      const orderbook = params.getOrderbook(marketId);
      const market = params.getMarket(marketId);
      if (!orderbook || !market) continue;

      const book = position.outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestBid = book.bestBid;
      if (!bestBid || bestBid < 0.01) continue;

      signals.push(this.buildSignal({
        market,
        orderbook,
        signalType: 'VS_TIME_EXIT',
        action: 'SELL',
        outcome: position.outcome,
        shares: liveShares,
        targetPrice: bestBid,
        fairValue: null,
        urgency: 'cross',
        reason: `VS orphan-flatten: slot ended ${roundTo(-remaining / 1000, 0)}s ago`,
        reduceOnly: true,
        priority: 985,
        edgeAmount: 0,
      }));
    }

    return signals;
  }

  /* ── Stats recording ────────────────────────────────────────────── */

  recordEntryForStats(coin: string | null, detail: string): void {
    if (!coin) return;
    const stats = this.getOrCreateCoinStats(coin);
    stats.entries += 1;
    stats.lastAction = 'entry';
    stats.lastActionAt = new Date().toISOString();
  }

  recordExitForStats(coin: string | null, pnl: number, exitType: string): void {
    this.totalConfirmedExits += 1;
    this.realizedPnl += pnl;
    if (pnl > 0) this.wins += 1;
    else if (pnl < 0) this.losses += 1;

    if (coin) {
      const stats = this.getOrCreateCoinStats(coin);
      stats.exits += 1;
      stats.realizedPnl += pnl;
      stats.lastAction = 'exit';
      stats.lastActionAt = new Date().toISOString();
    }

    if (pnl < 0) {
      // Record losing exit for cooldown
      // We don't know marketId here, so skip per-market cooldown
      if (coin) {
        this.lastLosingExitMsByCoin.set(coin, Date.now());
      }
    }
  }

  recordPhaseForStats(phase: 'MM' | 'MOMENTUM', pnl: number): void {
    if (phase === 'MM') this.phase1Pnl += pnl;
    else this.phase2Pnl += pnl;
  }

  getSessionStats(config: VsEngineConfig): VsSessionStats {
    const coinStatsObj: Record<string, VsCoinStats> = {};
    for (const [coin, stats] of this.coinStats) {
      coinStatsObj[coin] = {
        coin,
        entries: stats.entries,
        exits: stats.exits,
        phase1Entries: stats.phase1Entries,
        phase2Entries: stats.phase2Entries,
        realizedPnl: roundTo(stats.realizedPnl, 4),
        lastAction: stats.lastAction,
        lastActionAt: stats.lastActionAt,
      };
    }

    return {
      enabled: config.enabled,
      shadowMode: config.shadowMode,
      entries: this.totalEntries,
      exits: this.totalConfirmedExits,
      wins: this.wins,
      losses: this.losses,
      realizedPnl: roundTo(this.realizedPnl, 4),
      phase1Entries: this.phase1Entries,
      phase1Pnl: roundTo(this.phase1Pnl, 4),
      phase2Entries: this.phase2Entries,
      phase2Pnl: roundTo(this.phase2Pnl, 4),
      coinStats: coinStatsObj,
      recentDecisions: this.recentDecisions.slice(-MAX_RECENT_DECISIONS),
      targetExitPrice: config.targetExitPrice,
      momentumMaxBuyPrice: config.momentumMaxBuyPrice,
      defaultVolatility: config.defaultVolatility,
    };
  }

  /* ── Private helpers ────────────────────────────────────────────── */

  private getOrCreateCoinStats(coin: string) {
    let stats = this.coinStats.get(coin);
    if (!stats) {
      stats = {
        entries: 0, exits: 0, phase1Entries: 0, phase2Entries: 0,
        realizedPnl: 0, lastAction: null, lastActionAt: null,
      };
      this.coinStats.set(coin, stats);
    }
    return stats;
  }

  private recordDecision(
    coin: string | null,
    action: string,
    phase: string,
    reason: string,
    fairValue: number | null
  ): void {
    this.recentDecisions.push({
      timestamp: new Date().toISOString(),
      coin,
      action,
      phase,
      reason,
      fairValue: fairValue !== null ? roundTo(fairValue, 4) : null,
    });
    if (this.recentDecisions.length > MAX_RECENT_DECISIONS * 2) {
      this.recentDecisions = this.recentDecisions.slice(-MAX_RECENT_DECISIONS);
    }
  }

  private buildSignal(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    signalType: StrategySignal['signalType'];
    action: 'BUY' | 'SELL';
    outcome: Outcome;
    shares: number;
    targetPrice: number | null;
    fairValue: number | null;
    urgency: StrategySignal['urgency'];
    reason: string;
    reduceOnly: boolean;
    priority: number;
    edgeAmount: number;
  }): StrategySignal {
    const outcomeBook =
      params.outcome === 'YES' ? params.orderbook.yes : params.orderbook.no;
    return {
      marketId: params.market.marketId,
      marketTitle: params.market.title,
      signalType: params.signalType,
      priority: params.priority,
      generatedAt: Date.now(),
      action: params.action,
      outcome: params.outcome,
      outcomeIndex: params.outcome === 'YES' ? 0 : 1,
      shares: params.shares,
      targetPrice: params.targetPrice,
      referencePrice: outcomeBook.bestAsk ?? outcomeBook.bestBid ?? null,
      tokenPrice: outcomeBook.midPrice,
      midPrice: outcomeBook.midPrice,
      fairValue: params.fairValue,
      edgeAmount: params.edgeAmount,
      combinedBid: params.orderbook.combined.combinedBid,
      combinedAsk: params.orderbook.combined.combinedAsk,
      combinedMid: params.orderbook.combined.combinedMid,
      combinedDiscount: params.orderbook.combined.combinedDiscount,
      combinedPremium: params.orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: params.urgency,
      reduceOnly: params.reduceOnly,
      reason: params.reason,
      strategyLayer: resolveStrategyLayer(params.signalType),
    };
  }
}
