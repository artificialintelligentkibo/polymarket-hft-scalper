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
  readonly minVolatility: number;
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
  /** Phase 35D: max edge (in price units) for VS MM ASK above entry VWAP.
   *  Prevents absurd ask prices like entry=0.49 ask=0.58 (+18% edge). */
  readonly makerAskMaxEdge: number;
  readonly timeExitBeforeEndMs: number;
  readonly timeExitMinPrice: number;
  // Timing
  readonly slotWarmupMs: number;
  readonly stopEntryBeforeEndMs: number;
  readonly cancelAllBeforeEndMs: number;
  readonly momentumPhaseMs: number;
  // Safety
  readonly hardStopUsd: number;
  /** Phase 47: price-stop — if position is N cents underwater, market-out immediately.
   *  VS median hold < 60s. Holding losers 4+ min until time-exit@0.10 is fatal. */
  readonly priceStopCents: number;
  readonly cooldownMs: number;
  readonly losingExitCooldownMs: number;
  readonly losingExitCooldownByCoinMs: number;
  readonly preflightBalanceCheck: boolean;
  readonly minLiquidityUsd: number;
  readonly minEntryPrice: number;
  readonly maxEntryPrice: number;
  // Direction filter — prevent YES/NO flipping when FV ≈ 0.50
  readonly minDirectionThreshold: number;
  // Phase 45a: two-sided MM + aggressor mode
  readonly aggressorVolFloor: number;
  readonly aggressorMinEdge: number;
  readonly mmTiltMaxCents: number;
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
  /** Phase 36: last computed fair value per market (for slot replay). */
  private readonly lastFairValues = new Map<string, number>();
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

  /** Phase 45a: composite key for per-outcome position tracking. */
  private positionKey(marketId: string, outcome: Outcome): string {
    return `${marketId}:${outcome}`;
  }

  hasPosition(marketId: string): boolean {
    return (
      this.positions.has(this.positionKey(marketId, 'YES')) ||
      this.positions.has(this.positionKey(marketId, 'NO'))
    );
  }

  hasPositionForOutcome(marketId: string, outcome: Outcome): boolean {
    return this.positions.has(this.positionKey(marketId, outcome));
  }

  getActivePositions(): ReadonlyMap<string, VsPosition> {
    return this.positions;
  }

  /** Phase 45a: get position by marketId and outcome (composite key lookup). */
  getPosition(marketId: string, outcome: Outcome): VsPosition | undefined {
    return this.positions.get(this.positionKey(marketId, outcome));
  }

  /** Phase 36: last computed fair value for slot replay tracker. */
  getLastFairValue(marketId: string): number | null {
    return this.lastFairValues.get(marketId) ?? null;
  }

  clearState(marketId: string, outcome?: Outcome): void {
    if (outcome) {
      // Phase 45a: clear specific outcome position
      this.positions.delete(this.positionKey(marketId, outcome));
    } else {
      // Clear both outcomes
      this.positions.delete(this.positionKey(marketId, 'YES'));
      this.positions.delete(this.positionKey(marketId, 'NO'));
    }
    this.lastFairValues.delete(marketId);
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

    // Realized volatility — with floor to prevent CDF saturation.
    // Phase 44f: when realized vol is extremely low (e.g. 0.01), the CDF
    // pushes FV to ~1.00 for any meaningful price move, causing bidPrice
    // to exceed maxEntryPrice and block ALL entries. Floor at minVolatility
    // (default 0.05) ensures FV stays in a tradeable range.
    const priceHistory = binanceFeed.getPriceHistory(coin);
    const realizedVol = estimateRealizedVolatility(
      priceHistory, config.volLookbackMs, config.minVolSamples
    );
    const rawVol = realizedVol ?? config.defaultVolatility;
    const vol = Math.max(rawVol, config.minVolatility);

    // Fair value
    const timeRemainingSec = (slotEndMs - nowMs) / 1000;
    const fairValueUp = calculatePhiFairValue(spotPrice, strikePrice, vol, timeRemainingSec);
    const fairValueDown = 1 - fairValueUp;

    // Phase 36: cache last FV for slot replay tracker
    this.lastFairValues.set(market.marketId, fairValueUp);

    if (phase === 'PASSIVE_MM') {
      return this.generatePassiveMMSignals(
        market, orderbook, positionManager, config, coin, fairValueUp,
        fairValueDown, spotPrice, strikePrice, slotEndMs, slotStartMs,
        params.vsSizeMultiplier ?? 1, nowMs
      );
    }

    if (phase === 'MOMENTUM') {
      // Phase 45d: pass rawVol (not clamped vol) so aggressor can apply its
      // own aggressorVolFloor (0.02) independently of the global minVolatility (0.05).
      return this.generateMomentumSignals(
        market, orderbook, positionManager, config, coin, fairValueUp,
        fairValueDown, rawVol, spotPrice, strikePrice, slotEndMs, slotStartMs,
        params.vsSizeMultiplier ?? 1, nowMs
      );
    }

    return [];
  }

  /* ── Phase 1: Passive MM (Binance-skewed inventory accumulation) ─── */

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
    sizeMultiplier: number,
    nowMs: number
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    // Phase 46: vague-sourdough insight — MM phase accumulates inventory
    // toward Binance direction (BUY:SELL = 4:1 at open). Not equal two-sided.
    // Use CDF FV as anchor (like vague-sourdough), with Binance skew.
    const yesMid = orderbook.yes.midPrice ?? 0.50;
    const noMid = orderbook.no.midPrice ?? 0.50;

    // Binance direction determines which side to favor
    const movePct = ((spotPrice - strikePrice) / strikePrice) * 100;
    const absMove = Math.abs(movePct);
    const binanceUp = movePct > 0;
    const binanceDown = movePct < 0;
    const binanceFlat = absMove < 0.01; // < 0.01% = essentially flat

    // Phase 47: Single-outcome MM — quote bid+ask on ONE side, not BUY both.
    // Buying YES+NO simultaneously = complete set purchase (arbitrage at best,
    // guaranteed loss at worst). Real MM = bid+ask on same outcome, capture spread.
    //
    // Directional → only the Binance-favored side.
    // Flat → pick the side closer to 0.50 (most liquid, tightest spread).
    //   This avoids the complete-set trap while staying active on FLAT markets.
    let sideToQuote: Outcome;
    if (binanceFlat) {
      // Pick the side whose mid is closer to 0.50 (most balanced = best for MM)
      const yesDist = Math.abs(yesMid - 0.50);
      const noDist = Math.abs(noMid - 0.50);
      sideToQuote = yesDist <= noDist ? 'YES' : 'NO';
    } else if (binanceUp) {
      sideToQuote = 'YES';
    } else {
      sideToQuote = 'NO';
    }
    const sidesToQuote: readonly Outcome[] = [sideToQuote];

    // Bid pricing: anchor on Polymarket mid with spread below
    const yesBaseBid = yesMid - config.mmSpreadCents;
    const yesBidPrice = roundTo(Math.max(yesBaseBid, config.mmMinPrice), 2);
    const noBaseBid = noMid - config.mmSpreadCents;
    const noBidPrice = roundTo(Math.max(noBaseBid, config.mmMinPrice), 2);

    const shares = Math.round(config.mmShares * sizeMultiplier);

    // Track running budget so quotes don't exceed balance
    let budgetRemaining = (this.availableUsdcBalance ?? Infinity) * 0.9;

    for (const side of sidesToQuote) {
      const outcome: Outcome = side;
      const bidPrice = side === 'YES' ? yesBidPrice : noBidPrice;
      const mid = side === 'YES' ? yesMid : noMid;
      const outcomeFV = side === 'YES' ? fairValueUp : fairValueDown;

      // Skip near-resolved markets (mid < 0.10 or mid > 0.90)
      if (mid < 0.10 || mid > 0.90) {
        this.recordDecision(coin, 'SKIP', 'PASSIVE_MM',
          `market_resolved_${outcome} mid=${roundTo(mid, 3)}`, outcomeFV);
        continue;
      }

      // Don't double up — if already holding this outcome, let exit handle it
      if (this.hasPositionForOutcome(market.marketId, outcome)) {
        this.recordDecision(coin, 'SKIP', 'PASSIVE_MM',
          `already_holding_${outcome}`, outcomeFV);
        continue;
      }

      // Position capacity check per outcome
      const currentShares = positionManager.getShares(outcome);
      if (currentShares >= config.mmMaxPositionShares) {
        this.recordDecision(coin, 'SKIP', 'PASSIVE_MM',
          `max_position_${outcome}`, outcomeFV);
        continue;
      }

      // Price guard
      if (bidPrice < config.minEntryPrice || bidPrice > config.maxEntryPrice) {
        this.recordDecision(coin, 'SKIP', 'PASSIVE_MM',
          `price_out_of_range_${outcome} bid=${bidPrice}`, outcomeFV);
        continue;
      }

      // Balance check — cumulative
      if (config.preflightBalanceCheck && this.availableUsdcBalance !== null) {
        const cost = shares * bidPrice;
        if (cost > budgetRemaining) {
          this.recordDecision(coin, 'SKIP', 'PASSIVE_MM',
            `insufficient_balance_${outcome} cost=${roundTo(cost, 2)} budget=${roundTo(budgetRemaining, 2)}`, outcomeFV);
          continue;
        }
      }

      const skewLabel = binanceFlat ? 'FLAT' : (binanceUp ? 'UP' : 'DOWN');
      this.recordDecision(coin, 'ENTRY', 'PASSIVE_MM',
        `${outcome} mid=${roundTo(mid, 3)} bid=${bidPrice} skew=${skewLabel} move=${roundTo(movePct, 3)}%`,
        outcomeFV);

      if (config.shadowMode) continue;

      // Lock cooldown on signal GENERATION
      this.lastEntryMs.set(market.marketId, nowMs);

      // Deduct from running budget
      budgetRemaining -= shares * bidPrice;

      signals.push(this.buildSignal({
        market,
        orderbook,
        signalType: 'VS_MM_BID',
        action: 'BUY',
        outcome,
        shares,
        targetPrice: bidPrice,
        fairValue: outcomeFV,
        urgency: 'passive',
        reason: `VS MM: ${outcome} mid=${roundTo(mid, 3)} bid@${bidPrice} ${skewLabel} ${roundTo(movePct, 3)}%`,
        reduceOnly: false,
        priority: 800,
        edgeAmount: absMove,
      }));
    }

    return signals;
  }

  /* ── Phase 2: Aggressor (market edge near expiry) ────────────────── */

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
    sizeMultiplier: number,
    nowMs: number
  ): StrategySignal[] {
    // Phase 46: Aggressor MUST follow Binance direction.
    // vague-sourdough insight: in final 30s, Binance "already knows the answer".
    // Only buy the side Binance favors. Never bet against Binance.
    const movePct = ((spotPrice - strikePrice) / strikePrice) * 100;
    const absMove = Math.abs(movePct);
    const binanceUp = movePct > 0;

    // Phase 46: Require minimum move to aggress. If flat, no momentum signal.
    // Aggressor needs clear direction — flat = no edge, just noise.
    if (absMove < 0.01) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `flat_market move=${roundTo(movePct, 4)}% — no direction`, fairValueUp);
      return [];
    }

    // Phase 46: Only aggress in Binance direction
    const outcome: Outcome = binanceUp ? 'YES' : 'NO';

    // Phase 45a: Aggressor mode — use tighter vol floor for near-expiry CDF edge.
    // Near expiry (T-10s), even a +0.3% BTC move with σ=0.02 gives meaningful edge.
    const aggressorVol = Math.max(vol, config.aggressorVolFloor);
    const timeRemainingSec = (slotEndMs - nowMs) / 1000;
    const aggressorFV = calculatePhiFairValue(spotPrice, strikePrice, aggressorVol, timeRemainingSec);

    // Edge for the Binance-indicated side only
    const outcomeFV = outcome === 'YES' ? aggressorFV : (1 - aggressorFV);
    const bestAsk = outcome === 'YES' ? orderbook.yes.bestAsk : orderbook.no.bestAsk;
    const edge = outcomeFV - (bestAsk ?? 1);

    // Need minimum edge to aggress
    if (edge < config.aggressorMinEdge) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `edge=${roundTo(edge, 4)} < min=${config.aggressorMinEdge} (${outcome} FV=${roundTo(outcomeFV, 3)} vol=${roundTo(aggressorVol, 4)} move=${roundTo(movePct, 3)}%)`, outcomeFV);
      return [];
    }

    // Phase 45c + 46 fix: sanity check — if market price diverges >0.20 from CDF FV,
    // the market has information the CDF doesn't capture (e.g. outcome nearly decided).
    // CRITICAL: when midPrice is null (no bids on this side), use bestAsk as proxy.
    // Fallback to 0.50 was hiding the divergence when one side had no liquidity.
    const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
    const marketMid = book.midPrice ?? book.bestAsk ?? book.bestBid ?? null;
    if (marketMid === null) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `no_market_data_${outcome}`, outcomeFV);
      return [];
    }
    if (Math.abs(outcomeFV - marketMid) > 0.20) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `fv_market_divergence ${outcome} FV=${roundTo(outcomeFV, 3)} mid=${roundTo(marketMid, 3)} gap=${roundTo(Math.abs(outcomeFV - marketMid), 3)}`,
        outcomeFV);
      return [];
    }

    // Don't buy above max price
    if (!bestAsk || bestAsk > config.momentumMaxBuyPrice) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM',
        `ask=${bestAsk ?? 'null'} > max=${config.momentumMaxBuyPrice}`, outcomeFV);
      return [];
    }

    // Position capacity
    const currentShares = positionManager.getShares(outcome);
    if (currentShares >= config.momentumMaxPositionShares) {
      this.recordDecision(coin, 'SKIP', 'MOMENTUM', 'max_position_reached', outcomeFV);
      return [];
    }

    const shares = Math.round(config.momentumShares * sizeMultiplier);

    // Balance check
    if (config.preflightBalanceCheck && this.availableUsdcBalance !== null) {
      const cost = shares * bestAsk;
      if (cost > this.availableUsdcBalance * 0.9) {
        this.recordDecision(coin, 'SKIP', 'MOMENTUM', 'insufficient_balance', outcomeFV);
        return [];
      }
    }

    const skewLabel = binanceUp ? 'UP' : 'DOWN';
    this.recordDecision(coin, 'ENTRY', 'MOMENTUM',
      `${outcome} edge=${roundTo(edge, 4)} FV=${roundTo(outcomeFV, 3)} ask=${bestAsk} ${skewLabel} ${roundTo(movePct, 3)}% vol=${roundTo(aggressorVol, 4)}`,
      outcomeFV);

    if (config.shadowMode) return [];

    // Lock cooldown on signal GENERATION
    this.lastEntryMs.set(market.marketId, nowMs);

    return [this.buildSignal({
      market,
      orderbook,
      signalType: 'VS_MOMENTUM_BUY',
      action: 'BUY',
      outcome,
      shares,
      targetPrice: bestAsk,
      fairValue: outcomeFV,
      urgency: 'cross',
      reason: `VS Aggressor: ${outcome} edge=${roundTo(edge, 4)} FV=${roundTo(outcomeFV, 3)} @${bestAsk} ${skewLabel} ${roundTo(movePct, 3)}%`,
      reduceOnly: false,
      priority: 950,
      edgeAmount: edge,
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
    const signals: StrategySignal[] = [];

    // Phase 45a: iterate both YES and NO positions for this market
    for (const outcome of ['YES', 'NO'] as const) {
      const key = this.positionKey(market.marketId, outcome);
      const position = this.positions.get(key);
      if (!position) continue;

      const liveShares = positionManager.getShares(position.outcome);
      if (liveShares < 1) {
        this.clearState(market.marketId, outcome);
        continue;
      }

      const book: TokenBookSnapshot =
        position.outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestBid = book.bestBid;

      const slotEndMs = market.endTime ? new Date(market.endTime).getTime() : position.slotEndMs;
      const remaining = slotEndMs - nowMs;

      // Phase 47: Price-stop — if position is N¢ underwater, market-out NOW.
      // VS median hold < 60s. Holding losers 4+ min until time-exit@0.10 is fatal.
      // A 5¢ stop on 6 shares = $0.30 loss, vs $2.40 at time-exit.
      if (config.priceStopCents > 0 && bestBid) {
        const stopPrice = position.entryVwap - config.priceStopCents;
        if (bestBid <= stopPrice) {
          this.totalExitSignals += 1;
          const loss = roundTo((bestBid - position.entryVwap) * liveShares, 2);
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
            reason: `VS price-stop: ${outcome} bid=${bestBid} <= stop=${roundTo(stopPrice, 3)} (entry=${roundTo(position.entryVwap, 3)} loss=${loss})`,
            reduceOnly: true,
            priority: 970,
            edgeAmount: bestBid - position.entryVwap,
          }));
          continue;
        }
      }

      // Time exit: forced flatten at T-5s
      if (remaining <= config.timeExitBeforeEndMs) {
        if (!bestBid || bestBid < config.timeExitMinPrice) continue;

        this.totalExitSignals += 1;
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
          reason: `VS time-exit: ${roundTo(remaining / 1000, 1)}s left, selling ${outcome}@${bestBid}`,
          reduceOnly: true,
          priority: 980,
          edgeAmount: 0,
        }));
        continue;
      }

      // Scalp exit: bid >= target AND bid > entry (never sell at a loss via scalp)
      if (bestBid && bestBid >= config.targetExitPrice && bestBid > position.entryVwap) {
        this.totalExitSignals += 1;
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
          reason: `VS scalp-exit: ${outcome} bid=${bestBid} >= target=${config.targetExitPrice} entry=${roundTo(position.entryVwap, 3)}`,
          reduceOnly: true,
          priority: 960,
          edgeAmount: bestBid - position.entryVwap,
        }));
        continue;
      }

      // MM ask: place resting sell above entry to capture profit.
      // Phase 35D: cap the ask at entry + makerAskMaxEdge (default 0.02).
      if (bestBid && bestBid > position.entryVwap) {
        const maxAskByEdge = position.entryVwap + config.makerAskMaxEdge;
        const askPrice = roundTo(
          Math.min(bestBid + 0.01, maxAskByEdge, config.targetExitPrice),
          2
        );
        // Don't place ask below entry (would lock in a loss as maker)
        if (askPrice <= position.entryVwap) continue;
        this.totalExitSignals += 1;
        signals.push(this.buildSignal({
          market,
          orderbook,
          signalType: 'VS_MM_ASK',
          action: 'SELL',
          outcome: position.outcome,
          shares: liveShares,
          targetPrice: askPrice,
          fairValue: null,
          urgency: 'passive',
          reason: `VS maker-ask: ${outcome}@${askPrice} (entry=${roundTo(position.entryVwap, 3)}, maxEdge=${config.makerAskMaxEdge})`,
          reduceOnly: true,
          priority: 850,
          edgeAmount: askPrice - position.entryVwap,
        }));
      }
    }

    return signals;
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
    // Phase 45a: composite key for per-outcome position tracking
    const key = this.positionKey(params.marketId, params.outcome);
    const existing = this.positions.get(key);
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
      this.positions.set(key, {
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
    // Phase 35C: DON'T reset lastEntryMs here — it's already set on signal
    // GENERATION (generatePassiveMMSignals / generateMomentumSignals).
    // Resetting on fill arrival would reopen the cooldown window, allowing
    // duplicate entries when async fills arrive after the signal-gen lock.
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
    for (const [posKey, position] of this.positions) {
      const pm = params.getPositionManager(position.marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares < 1) {
        this.clearState(position.marketId, position.outcome);
        continue;
      }
      const orderbook = params.getOrderbook(position.marketId);
      const market = params.getMarket(position.marketId);
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

    for (const [posKey, position] of this.positions) {
      const remaining = position.slotEndMs - nowMs;
      if (remaining > 0) continue; // slot still active

      const pm = params.getPositionManager(position.marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares < 1) {
        this.clearState(position.marketId, position.outcome);
        continue;
      }

      // Give up after ORPHAN_GIVE_UP_AFTER_MS
      if (remaining < -ORPHAN_GIVE_UP_AFTER_MS) {
        const lastLog = this.lastOrphanEmitMs.get(position.marketId);
        if (!lastLog || nowMs - lastLog > 30_000) {
          logger.warn('VS orphan: slot ended, position still has shares — continuing exit attempts', {
            marketId: position.marketId, outcome: position.outcome, liveShares: roundTo(liveShares, 4),
          });
          this.lastOrphanEmitMs.set(position.marketId, nowMs);
        }
      }

      const orderbook = params.getOrderbook(position.marketId);
      const market = params.getMarket(position.marketId);
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

    // Phase 45a: expose active positions for dashboard
    const nowMs = Date.now();
    const activePositions: Array<VsSessionStats['activePositions'][number]> = [];
    for (const [, pos] of this.positions) {
      const coin = extractCoin(pos.marketTitle) ?? '?';
      activePositions.push({
        coin,
        outcome: pos.outcome,
        shares: roundTo(pos.totalShares, 2),
        entryVwap: roundTo(pos.entryVwap, 4),
        phase: pos.phase,
        ageMs: nowMs - pos.enteredAtMs,
      });
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
      aggressorVolFloor: config.aggressorVolFloor,
      aggressorMinEdge: config.aggressorMinEdge,
      mmTiltMaxCents: config.mmTiltMaxCents,
      mmSpreadCents: config.mmSpreadCents,
      priceStopCents: config.priceStopCents,
      activePositions,
      totalSignalsGenerated: this.totalExitSignals + this.totalEntries,
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
