/**
 * OBI Engine — standalone Layer 1 strategy replicating vague-sourdough's
 * order-book-imbalance scalper.
 *
 * Unlike the `OrderBookImbalanceFilter` (which is only a gate for the MM
 * activation path), this engine generates its OWN entry signals, follow-on
 * MM quotes, and exit signals. It does not depend on Binance fair-value
 * lookups, the sniper, or the lottery layer.
 *
 * Lifecycle (per market tick):
 *   1. `generateSignals(...)` -> may emit a single OBI_ENTRY_BUY when the
 *      orderbook shows a thin side and the imbalance ratio is below the
 *      configured threshold.
 *   2. After the entry fill confirms, the engine `onEntryFill(...)` returns
 *      Layer-2 maker quotes (OBI_MM_QUOTE_ASK and optionally
 *      OBI_MM_QUOTE_BID on the opposite outcome).
 *   3. On every subsequent tick, `generateExitSignals(...)` may emit
 *      OBI_REBALANCE_EXIT (book healed) or OBI_SCALP_EXIT (price moved in
 *      our favor by `scalpExitEdge`).
 *   4. `clearState(marketId)` is called by the host when the market is
 *      retired or its position is fully unwound.
 *
 * Pure module — no I/O, no timers. The host wires it into the existing
 * processPreparedMarket / FillTracker pipeline.
 */

import type { DeepBinanceAssessment } from './binance-deep-integration.js';
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

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export interface ObiEngineConfig {
  readonly enabled: boolean;
  readonly thinThresholdUsd: number;
  readonly minLiquidityUsd: number;
  readonly entryImbalanceRatio: number;
  readonly exitRebalanceRatio: number;
  readonly entryShares: number;
  readonly maxPositionShares: number;
  readonly cooldownMs: number;
  readonly slotWarmupMs: number;
  readonly stopEntryBeforeEndMs: number;
  readonly cancelAllBeforeEndMs: number;
  readonly minEntryPrice: number;
  readonly maxEntryPrice: number;
  readonly scalpExitEdge: number;
  readonly mmAskEnabled: boolean;
  readonly mmBidOppositeEnabled: boolean;
  readonly mmAskSpreadTicks: number;
  readonly mmBidOppositeFactor: number;
  readonly shadowMode: boolean;
  readonly aggressiveEntry: boolean;
  // === Safety nets (added after $10 live loss audit) ===
  /** Hard $ stop: exit immediately when position PnL drops below -hardStopUsd. */
  readonly hardStopUsd: number;
  /** Min entry notional in USD. Entry is rejected if shares*price < this. */
  readonly minEntryNotionalUsd: number;
  /** CLOB minimum sell notional. Used to prevent dust positions at entry. */
  readonly clobMinNotionalUsd: number;
  /** CLOB minimum sell shares. Used to prevent dust positions at entry. */
  readonly clobMinShares: number;
  /** After a losing exit, refuse new entries on the same market for this long. */
  readonly losingExitCooldownMs: number;
  /**
   * Phase 8 (2026-04-08): after a losing exit on coin X, refuse new entries
   * on ANY market that is also coin X for this long. The 11:00 → 11:06 SOL
   * losses showed that consecutive 5-min slots of the same coin tend to
   * collapse together (continued runaway). A coin-wide cooldown lets the
   * volatility cool off before re-engaging. Set to 0 to disable.
   */
  readonly losingExitCooldownByCoinMs: number;
  /** Catastrophic flip ratio: exit immediately when currentRatio >= this (book fully reversed). */
  readonly imbalanceCollapseRatio: number;
  /** When set, generateSignals returns no entries if available USDC < required notional. */
  readonly preflightBalanceCheck: boolean;
  // === Binance runaway gate (2026-04-08 binary runaway fix) ===
  /** Master switch for the Binance-based runaway gate on OBI entries. */
  readonly binanceGateEnabled: boolean;
  /**
   * Absolute |binanceMovePct| above which OBI entries are blocked on any
   * outcome (%). A 5-min BTC/ETH/SOL/XRP slot that already moved this
   * much is a runaway: the "winning" outcome is rapidly pricing to $1,
   * the "losing" outcome is pricing to $0, and OBI mean-reversion edge
   * evaporates. Typical sensible values: 0.25–0.40 for BTC/ETH, up to
   * 0.60 for SOL/XRP (higher base vol).
   */
  readonly binanceRunawayAbsPct: number;
  /**
   * Absolute |binanceMovePct| above which OBI entries are blocked ONLY
   * when the chosen outcome contradicts Binance direction. Allows
   * with-flow OBI scalps on moderate moves (0.1–0.25%) while cutting
   * contra-trend entries that historically ended in hard stops.
   */
  readonly binanceContraAbsPct: number;
  /**
   * Phase 18 (2026-04-08): when true, REQUIRE Binance direction to align
   * with the chosen outcome (UP→YES, DOWN→NO). FLAT direction or any
   * misalignment blocks the entry regardless of magnitude. This is
   * stricter than `binanceContraAbsPct` (which only blocks when the move
   * is already large) — it refuses entries where Binance has no clear
   * directional opinion at all.
   *
   * Live incident 2026-04-08 16:07: SOL OBI entry on YES with Binance
   * FLAT (+1.2%) → SOL crashed to 0.01 within 2 minutes → full $8.55 loss.
   * The contra gate didn't fire because absMove (0.012) was below 0.15.
   */
  readonly binanceRequireAlignment: boolean;
  /**
   * Phase 21: OBI compounding threshold. When bankroll exceeds this USD
   * value, entryShares and maxPositionShares scale up linearly (up to 5×).
   * Below this threshold sizing stays static. Set to 0 to disable compounding.
   */
  readonly obiCompoundThresholdUsd: number;
  /**
   * Phase 22: maximum fraction of available balance risked per single OBI
   * entry. Prevents a single bad trade from wiping 20%+ of the bankroll.
   * E.g. 0.15 = max 15% of balance on one position. Set to 1.0 to disable.
   */
  readonly maxRiskPerTradePct: number;
  /**
   * Phase 26: time-based take-profit. If a position has been held for longer
   * than this many milliseconds AND is profitable (bestBid > entryPrice by
   * at least `timeTakeProfitMinEdge`), exit immediately. Prevents profitable
   * positions from drifting back to break-even/loss while waiting for the
   * full scalpExitEdge target. Set to 0 to disable.
   */
  readonly timeTakeProfitMs: number;
  /**
   * Minimum price edge (absolute, e.g. 0.005 = half a cent) required for
   * time-based take-profit to trigger. Prevents closing at break-even where
   * fees would eat the "profit". Only relevant when timeTakeProfitMs > 0.
   */
  readonly timeTakeProfitMinEdge: number;
}

/* ------------------------------------------------------------------ */
/*  Per-market state                                                   */
/* ------------------------------------------------------------------ */

interface ObiPosition {
  readonly marketId: string;
  readonly outcome: Outcome;
  /** VWAP entry price across all partial fills accumulated into this position. */
  entryPrice: number;
  /** Total accumulated shares across all partial fills. */
  entryShares: number;
  readonly enteredAtMs: number;
  readonly initialRatio: number;
  readonly thinSide: 'bid' | 'ask';
  /** Slot end time in ms (parsed at entry). Used by orphan slot-end heartbeat. */
  readonly slotEndMs: number | null;
  /** Last orderbook snapshot for this market (refreshed from exit ticks). */
  lastOrderbook?: MarketOrderbookSnapshot;
  /** Cached title for orphan flatten signals. */
  readonly marketTitle: string;
}

export interface ObiStatsSnapshot {
  readonly activePositions: number;
  readonly totalEntries: number;
  readonly totalExits: number;           // confirmed fills only
  readonly totalExitSignals: number;     // all exit signals generated (debug)
  readonly totalShadowDecisions: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function safeRatio(thin: number, thick: number): number {
  if (!Number.isFinite(thin) || !Number.isFinite(thick) || thick <= 0) {
    return 0;
  }
  return roundTo(thin / thick, 4);
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function outcomeIndex(outcome: Outcome): 0 | 1 {
  return outcome === 'YES' ? 0 : 1;
}

/**
 * Infer the price tick size for a Polymarket binary book. We try to derive
 * it from the spacing between actual book levels first; if that fails (sparse
 * book) we fall back to 0.01 for prices ≥ 0.10 (the OBI universe) and 0.001
 * for sub-cent micro markets.
 */
function inferObiTickSize(book: TokenBookSnapshot, fallbackPrice: number): number {
  const sideTick = (levels: ReadonlyArray<{ price: number }>): number => {
    if (levels.length < 2) return Number.NaN;
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    let minDiff = Number.POSITIVE_INFINITY;
    for (let i = 1; i < sorted.length; i += 1) {
      const diff = sorted[i].price - sorted[i - 1].price;
      if (diff > 0 && diff < minDiff) minDiff = diff;
    }
    return Number.isFinite(minDiff) ? minDiff : Number.NaN;
  };
  const fromBids = sideTick(book.bids);
  const fromAsks = sideTick(book.asks);
  const candidates = [fromBids, fromAsks].filter((v) => Number.isFinite(v) && v > 0);
  if (candidates.length > 0) {
    return roundTo(Math.min(...candidates), 6);
  }
  return fallbackPrice >= 0.1 ? 0.01 : 0.001;
}

interface ObiCandidate {
  readonly outcome: Outcome;
  readonly thinSide: 'bid' | 'ask';
  readonly thinDepth: number;
  readonly thickDepth: number;
  readonly ratio: number;
  readonly bestAsk: number;
  readonly bestBid: number | null;
  readonly midPrice: number | null;
  readonly totalLiquidity: number;
}

/* ------------------------------------------------------------------ */
/*  Binance runaway gate                                               */
/* ------------------------------------------------------------------ */

export type ObiBinanceGateDecision =
  | { readonly blocked: false; readonly reason: null }
  | {
      readonly blocked: true;
      readonly reason:
        | 'runaway_abs'
        | 'contra_direction'
        | 'unavailable_required'
        | 'flat_direction'
        | 'misaligned_strict';
      readonly movePct: number | null;
      readonly direction: 'UP' | 'DOWN' | 'FLAT' | null;
      readonly outcome: Outcome;
    };

/**
 * Decide whether to block an OBI entry on the given outcome based on the
 * deep Binance assessment of the underlying coin.
 *
 * Two distinct block conditions:
 *
 *   1. |binanceMovePct| >= binanceRunawayAbsPct
 *      → blanket block regardless of direction. The slot already moved
 *        too much; the outcome is rapidly pricing to 0 or 1 and our
 *        mean-reversion edge is gone.
 *
 *   2. |binanceMovePct| >= binanceContraAbsPct AND chosen outcome
 *      contradicts Binance direction
 *      → UP direction + buying NO (bet on DOWN) is contra, DOWN + YES is
 *        contra. Allows with-flow entries at moderate moves but cuts
 *        contra-trend entries that historically hit hard stops.
 *
 * Fail-open: if assessment is missing, unavailable, or the gate is
 * disabled, returns blocked=false. The 2026-04-08 runaway fix is
 * specifically for markets where we HAVE Binance data and chose to
 * ignore it.
 */
export function checkObiBinanceGate(params: {
  readonly assessment: DeepBinanceAssessment | undefined | null;
  readonly outcome: Outcome;
  readonly config: Pick<
    ObiEngineConfig,
    | 'binanceGateEnabled'
    | 'binanceRunawayAbsPct'
    | 'binanceContraAbsPct'
    | 'binanceRequireAlignment'
  >;
}): ObiBinanceGateDecision {
  const { assessment, outcome, config } = params;
  if (!config.binanceGateEnabled) {
    return { blocked: false, reason: null };
  }
  if (!assessment || !assessment.available) {
    return { blocked: false, reason: null };
  }
  if (
    assessment.binanceMovePct === null ||
    !Number.isFinite(assessment.binanceMovePct)
  ) {
    return { blocked: false, reason: null };
  }

  const movePct = assessment.binanceMovePct;
  const absMove = Math.abs(movePct);
  const direction = assessment.direction;

  // (1) Absolute runaway: block regardless of direction.
  if (absMove >= config.binanceRunawayAbsPct) {
    return {
      blocked: true,
      reason: 'runaway_abs',
      movePct,
      direction,
      outcome,
    };
  }

  // (2) Directional contradiction: block if the chosen outcome fights
  // the Binance move and the move is already material.
  if (absMove >= config.binanceContraAbsPct) {
    const contradicts =
      (direction === 'UP' && outcome === 'NO') ||
      (direction === 'DOWN' && outcome === 'YES');
    if (contradicts) {
      return {
        blocked: true,
        reason: 'contra_direction',
        movePct,
        direction,
        outcome,
      };
    }
  }

  // (3) Phase 18: strict directional alignment requirement.
  // Block any entry where Binance is FLAT (no directional opinion) or
  // where the chosen outcome doesn't match the Binance direction.
  // This is the gate that would have stopped the SOL 16:07 loss.
  if (config.binanceRequireAlignment) {
    if (direction === 'FLAT') {
      return {
        blocked: true,
        reason: 'flat_direction',
        movePct,
        direction,
        outcome,
      };
    }
    const misaligned =
      (direction === 'UP' && outcome === 'NO') ||
      (direction === 'DOWN' && outcome === 'YES');
    if (misaligned) {
      return {
        blocked: true,
        reason: 'misaligned_strict',
        movePct,
        direction,
        outcome,
      };
    }
  }

  return { blocked: false, reason: null };
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

/**
 * Phase 8 (2026-04-08): extract the underlying coin name from a Polymarket
 * binary slot title. Polymarket uses titles like "Bitcoin Up or Down - April
 * 8, 8:30AM-8:35AM ET" or "SOL Up or Down - ...". We normalize to a stable
 * uppercase ticker (BTC, ETH, SOL, XRP) so the coin-wide cooldown can match
 * across naming variants. Returns null if no recognized coin appears.
 */
export function extractCoinFromObiTitle(title: string): string | null {
  if (!title) return null;
  const upper = title.toUpperCase();
  if (/\bBITCOIN\b|\bBTC\b/.test(upper)) return 'BTC';
  if (/\bETHEREUM\b|\bETH\b/.test(upper)) return 'ETH';
  if (/\bSOLANA\b|\bSOL\b/.test(upper)) return 'SOL';
  if (/\bRIPPLE\b|\bXRP\b/.test(upper)) return 'XRP';
  if (/\bBNB\b/.test(upper)) return 'BNB';
  if (/\bDOGECOIN\b|\bDOGE\b/.test(upper)) return 'DOGE';
  return null;
}

export class ObiEngine {
  private readonly positions = new Map<string, ObiPosition>();
  private readonly lastEntryMs = new Map<string, number>();
  /** Phase 36: last computed imbalance ratio per market (for slot replay). */
  private readonly lastImbalanceRatios = new Map<string, number>();
  /** Phase 21 diagnostic: throttle "no candidates" log to once per market+slot. */
  private readonly lastDiagLogMs = new Map<string, number>();
  /** Markets where we recently exited at a loss — extra cooldown applies. */
  private readonly lastLosingExitMs = new Map<string, number>();
  /**
   * Phase 8: coin-wide cooldown after a losing exit. Map key is the
   * normalized coin ticker (BTC/ETH/SOL/XRP); value is the timestamp of
   * the most recent losing exit on that coin across ALL slots. Used to
   * skip the next slot(s) of a coin that just collapsed.
   */
  private readonly lastLosingExitMsByCoin = new Map<string, number>();
  /** Last time getOrphanFlattenSignals emitted for a market — used to throttle. */
  private readonly lastOrphanEmitMs = new Map<string, number>();

  /**
   * Phase 8: record a losing exit on both per-market and per-coin maps.
   * Centralised so adding new exit reasons doesn't require touching every
   * call site.
   */
  private recordLosingExit(market: MarketCandidate, nowMs: number): void {
    this.lastLosingExitMs.set(market.marketId, nowMs);
    const coin = extractCoinFromObiTitle(market.title);
    if (coin !== null) {
      this.lastLosingExitMsByCoin.set(coin, nowMs);
    }
  }
  /** Last available USDC balance reported by host. Used for pre-flight check. */
  private availableUsdcBalance: number | null = null;
  private totalEntries = 0;
  private totalExitSignals = 0;   // counts every exit signal GENERATED (may not fill)
  private totalConfirmedExits = 0; // counts only confirmed SELL fills (via recordExitForStats)
  private totalShadowDecisions = 0;

  // ─── OBI Session Stats (Phase 20: dashboard) ──────────────────
  private readonly gateBlockCounts = new Map<string, number>();
  private readonly gateBlockLastSeen = new Map<string, string>();
  private gatePassed = 0;
  private phase15Accepted = 0;
  private phase15Refused = 0;
  private phase15LastRefusal: string | null = null;
  private sessionWins = 0;
  private sessionLosses = 0;
  private sessionRedeems = 0;
  private sessionRealizedPnl = 0;
  private readonly coinEntries = new Map<string, number>();
  private readonly coinExits = new Map<string, number>();
  private readonly coinBlocks = new Map<string, number>();
  private readonly coinRefusals = new Map<string, number>();
  private readonly coinPnl = new Map<string, number>();
  private readonly coinLastAction = new Map<string, string>();
  private readonly coinLastActionAt = new Map<string, string>();
  private readonly recentDecisions: Array<{
    timestamp: string;
    coin: string | null;
    action: string;
    reason: string;
    detail: string;
  }> = [];
  private drawdownGuardTriggers = 0;

  /** Record a Binance gate block decision for dashboard stats. */
  recordGateBlock(reason: string, coin: string | null): void {
    this.gateBlockCounts.set(reason, (this.gateBlockCounts.get(reason) ?? 0) + 1);
    this.gateBlockLastSeen.set(reason, new Date().toISOString());
    if (coin) this.coinBlocks.set(coin, (this.coinBlocks.get(coin) ?? 0) + 1);
    this.pushDecision(coin, 'BLOCKED', reason, '');
  }

  /** Record a Binance gate pass for dashboard stats. */
  recordGatePass(coin: string | null): void {
    this.gatePassed++;
  }

  /** Record a Phase 15 dust-safety refusal. */
  recordPhase15Refusal(coin: string | null, detail: string): void {
    this.phase15Refused++;
    this.phase15LastRefusal = detail;
    if (coin) this.coinRefusals.set(coin, (this.coinRefusals.get(coin) ?? 0) + 1);
    this.pushDecision(coin, 'REFUSED', 'Phase 15 dust-safety', detail);
  }

  /** Record a Phase 15 pass (entry accepted). */
  recordPhase15Accept(coin: string | null): void {
    this.phase15Accepted++;
  }

  /** Record an entry fill for dashboard stats. */
  recordEntryForStats(coin: string | null, detail: string): void {
    if (coin) {
      this.coinEntries.set(coin, (this.coinEntries.get(coin) ?? 0) + 1);
      this.coinLastAction.set(coin, 'entry');
      this.coinLastActionAt.set(coin, new Date().toISOString());
    }
    this.pushDecision(coin, 'ENTRY ✓', 'fill confirmed', detail);
  }

  /** Record an exit for dashboard stats. Only called on confirmed SELL fills. */
  recordExitForStats(coin: string | null, pnl: number, exitType: string): void {
    this.totalConfirmedExits++;
    if (coin) {
      this.coinExits.set(coin, (this.coinExits.get(coin) ?? 0) + 1);
      this.coinPnl.set(coin, (this.coinPnl.get(coin) ?? 0) + pnl);
      this.coinLastAction.set(coin, exitType.toLowerCase());
      this.coinLastActionAt.set(coin, new Date().toISOString());
    }
    this.sessionRealizedPnl += pnl;
    if (pnl >= 0) this.sessionWins++;
    else this.sessionLosses++;
    this.pushDecision(coin, exitType, pnl >= 0 ? 'win' : 'loss', `PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }

  /** Record a redeem event for stats. Counts as confirmed exit. */
  recordRedeemForStats(coin: string | null, pnl: number): void {
    this.sessionRedeems++;
    this.totalConfirmedExits++;
    this.sessionRealizedPnl += pnl;
    if (pnl >= 0) this.sessionWins++;
    else this.sessionLosses++;
    if (coin) {
      this.coinPnl.set(coin, (this.coinPnl.get(coin) ?? 0) + pnl);
      this.coinExits.set(coin, (this.coinExits.get(coin) ?? 0) + 1);
      this.coinLastAction.set(coin, 'redeem');
      this.coinLastActionAt.set(coin, new Date().toISOString());
    }
    this.pushDecision(coin, 'REDEEM ✓', 'Phase 17', `PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }

  /** Record drawdown guard trigger for stats. */
  recordDrawdownGuardTrigger(): void {
    this.drawdownGuardTriggers++;
  }

  private pushDecision(coin: string | null, action: string, reason: string, detail: string): void {
    this.recentDecisions.push({
      timestamp: new Date().toISOString(),
      coin,
      action,
      reason,
      detail,
    });
    // Keep last 12
    while (this.recentDecisions.length > 12) {
      this.recentDecisions.shift();
    }
  }

  /** Build stats snapshot for runtime-status sync. */
  getSessionStats(cfg: ObiEngineConfig, drawdownGuardActive: boolean, obiSizeMultiplier = 1.0): import('./runtime-status.js').ObiSessionStats {
    const totalDecisions = this.gatePassed + [...this.gateBlockCounts.values()].reduce((a, b) => a + b, 0);
    const gateReasons: Record<string, import('./runtime-status.js').ObiGateReasonStats> = {};
    for (const reason of ['runaway_abs', 'contra_direction', 'flat_direction', 'misaligned_strict', 'unavailable_required']) {
      gateReasons[reason] = {
        count: this.gateBlockCounts.get(reason) ?? 0,
        lastSeenAt: this.gateBlockLastSeen.get(reason) ?? null,
      };
    }
    const coins = new Set([
      ...this.coinEntries.keys(), ...this.coinExits.keys(),
      ...this.coinBlocks.keys(), ...this.coinRefusals.keys(), ...this.coinPnl.keys(),
    ]);
    const coinStats: Record<string, import('./runtime-status.js').ObiCoinStats> = {};
    for (const coin of coins) {
      coinStats[coin] = {
        coin,
        entries: this.coinEntries.get(coin) ?? 0,
        exits: this.coinExits.get(coin) ?? 0,
        blocks: this.coinBlocks.get(coin) ?? 0,
        refusals: this.coinRefusals.get(coin) ?? 0,
        realizedPnl: this.coinPnl.get(coin) ?? 0,
        lastAction: this.coinLastAction.get(coin) ?? null,
        lastActionAt: this.coinLastActionAt.get(coin) ?? null,
      };
    }
    const totalBlocks = [...this.gateBlockCounts.values()].reduce((a, b) => a + b, 0);
    return {
      enabled: cfg.enabled,
      shadowMode: false,
      entries: this.totalEntries,
      exits: this.totalConfirmedExits,
      wins: this.sessionWins,
      losses: this.sessionLosses,
      redeems: this.sessionRedeems,
      realizedPnl: this.sessionRealizedPnl,
      passRate: totalDecisions > 0 ? this.gatePassed / totalDecisions : 0,
      gateReasons,
      totalGateBlocks: totalBlocks,
      totalGatePassed: this.gatePassed,
      phase15Accepted: this.phase15Accepted,
      phase15Refused: this.phase15Refused,
      phase15LastRefusal: this.phase15LastRefusal,
      coinStats,
      recentDecisions: [...this.recentDecisions],
      drawdownGuardActive,
      drawdownGuardTriggers: this.drawdownGuardTriggers,
      maxPositionShares: Math.round(cfg.maxPositionShares * obiSizeMultiplier),
      obiSizeMultiplier: roundTo(obiSizeMultiplier, 2),
      maxEntryPrice: cfg.maxEntryPrice,
      cooldownMs: cfg.cooldownMs,
      stopEntryBeforeEndMs: cfg.stopEntryBeforeEndMs,
    };
  }

  /**
   * Update the cached USDC balance. Host should call this each cycle from
   * the same source the order executor uses, so generateSignals can pre-flight
   * filter entries that the executor would just reject anyway.
   */
  setAvailableUsdcBalance(usdc: number | null): void {
    this.availableUsdcBalance =
      usdc !== null && Number.isFinite(usdc) ? usdc : null;
  }

  /** Generate entry signals for the given market tick. */
  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: ObiEngineConfig;
    nowMs?: number;
    /**
     * Optional deep Binance fair-value assessment for the underlying coin.
     * When provided AND `config.binanceGateEnabled` is true, the runaway gate
     * will block entries on slots where Binance has already moved past
     * `binanceRunawayAbsPct`, or where the chosen outcome contradicts the
     * Binance direction past `binanceContraAbsPct`. Fail-open: missing /
     * unavailable assessment is treated as "no opinion" and never blocks.
     */
    deepBinanceAssessment?: DeepBinanceAssessment | null;
    /**
     * Phase 21: compounding multiplier from DynamicCompounder. Scales
     * entryShares and maxPositionShares when bankroll exceeds threshold.
     * Defaults to 1.0 (no scaling) when compounder is disabled or absent.
     */
    obiSizeMultiplier?: number;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config, deepBinanceAssessment } = params;
    if (!config.enabled) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();

    // Slot timing checks based on MarketCandidate.startTime / endTime.
    const slotStartMs = parseTimeMs(market.startTime);
    const slotEndMs = parseTimeMs(market.endTime);

    // Phase 22: hard guard — never enter a slot that has already ended.
    // Protects against stale market candidates and clock drift on VPS.
    if (slotEndMs !== null && nowMs >= slotEndMs) {
      return [];
    }
    // Also reject if slot hasn't started yet (future slot from discovery).
    if (slotStartMs !== null && nowMs < slotStartMs) {
      return [];
    }

    if (slotStartMs !== null && nowMs - slotStartMs < config.slotWarmupMs) {
      return [];
    }
    if (slotEndMs !== null && slotEndMs - nowMs < config.stopEntryBeforeEndMs) {
      return [];
    }

    // Cooldown gate (normal).
    const lastEntry = this.lastEntryMs.get(market.marketId);
    if (lastEntry !== undefined && nowMs - lastEntry < config.cooldownMs) {
      return [];
    }

    // Re-entry guard: after a losing exit, refuse new entries on same market
    // for an extended cooldown. Prevents averaging into collapsed imbalances.
    const lastLosingExit = this.lastLosingExitMs.get(market.marketId);
    if (
      lastLosingExit !== undefined &&
      nowMs - lastLosingExit < config.losingExitCooldownMs
    ) {
      return [];
    }

    // Phase 8: coin-wide cooldown. After a losing exit on (e.g.) SOL, refuse
    // new entries on ANY SOL slot for `losingExitCooldownByCoinMs`. The 11:00
    // → 11:06 SOL cascade losses showed that a coin's volatility tends to
    // persist across consecutive 5-min slots. The per-market cooldown
    // doesn't help because the next slot has a fresh marketId.
    if (config.losingExitCooldownByCoinMs > 0) {
      const coin = extractCoinFromObiTitle(market.title);
      if (coin !== null) {
        const lastCoinLoss = this.lastLosingExitMsByCoin.get(coin);
        if (
          lastCoinLoss !== undefined &&
          nowMs - lastCoinLoss < config.losingExitCooldownByCoinMs
        ) {
          logger.info('OBI engine entry skipped — coin-wide cooldown active', {
            marketId: market.marketId,
            marketTitle: market.title,
            coin,
            sinceLastLossMs: nowMs - lastCoinLoss,
            cooldownMs: config.losingExitCooldownByCoinMs,
          });
          return [];
        }
      }
    }

    // Already holding an OBI position on this market — do not stack a second
    // entry from the same engine. Existing position is managed via exits.
    if (this.positions.has(market.marketId)) {
      return [];
    }

    const candidates: ObiCandidate[] = [];
    // Phase 21 diagnostic: track per-outcome skip reasons for this tick.
    const skipReasons: Array<{ outcome: string; reason: string; detail: string }> = [];

    for (const outcome of ['YES', 'NO'] as const) {
      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bidDepth = roundTo(book.depthNotionalBid, 4);
      const askDepth = roundTo(book.depthNotionalAsk, 4);
      const totalLiquidity = roundTo(bidDepth + askDepth, 4);
      if (totalLiquidity < config.minLiquidityUsd) {
        skipReasons.push({ outcome, reason: 'low_liquidity', detail: `total=$${totalLiquidity} need=$${config.minLiquidityUsd}` });
        continue;
      }

      const thinSide: 'bid' | 'ask' = bidDepth <= askDepth ? 'bid' : 'ask';
      const thinDepth = thinSide === 'bid' ? bidDepth : askDepth;
      const thickDepth = thinSide === 'bid' ? askDepth : bidDepth;
      const ratio = safeRatio(thinDepth, thickDepth);
      // Phase 36: cache best (lowest) ratio for slot replay
      const prevRatio = this.lastImbalanceRatios.get(market.marketId);
      if (prevRatio === undefined || ratio < prevRatio) {
        this.lastImbalanceRatios.set(market.marketId, ratio);
      }

      if (thinDepth >= config.thinThresholdUsd) {
        skipReasons.push({ outcome, reason: 'not_thin', detail: `thinSide=${thinSide} depth=$${thinDepth.toFixed(2)} threshold=$${config.thinThresholdUsd}` });
        continue;
      }
      if (ratio > config.entryImbalanceRatio) {
        skipReasons.push({ outcome, reason: 'ratio_too_high', detail: `ratio=${ratio.toFixed(4)} max=${config.entryImbalanceRatio}` });
        continue;
      }

      // Phase 10 (2026-04-08) — DIRECTIONAL BUG FIX:
      // Classical LOB imbalance is DIRECTIONAL, not symmetric.
      //   thin ask + thick bid = buying pressure  → price ↑ → BUY ✓
      //   thin bid + thick ask = selling pressure → price ↓ → SELL (not BUY!)
      //
      // The old code treated both cases as "BUY this outcome" which produced
      // a catastrophic -$1.38 loss on 2026-04-08 12:49 (YES bought at 0.54
      // with thin bid $24 vs thick ask $320 → price collapsed to 0.31 within
      // 4 seconds, hard-stopped with full loss).
      //
      // In Polymarket binary markets the two outcomes are mirrored:
      //   YES thin bid  ⇔  NO thin ask  (same liquidity imbalance)
      // so the symmetric NO candidate will still be picked up on the NO
      // iteration of this loop with the CORRECT direction.
      //
      // Therefore: only accept thin-ASK candidates (bullish imbalance for
      // the current outcome). This is the ONLY setup where "BUY thin side"
      // aligns with the mean-reversion thesis vague-sourdough actually
      // trades ("wait for book to rebalance, price returns to thick side").
      if (thinSide === 'bid') {
        skipReasons.push({ outcome, reason: 'thin_bid_not_ask', detail: `bidDepth=$${bidDepth.toFixed(2)} askDepth=$${askDepth.toFixed(2)}` });
        continue;
      }

      const bestAsk = book.bestAsk;
      if (bestAsk === null) {
        skipReasons.push({ outcome, reason: 'no_best_ask', detail: 'null' });
        continue;
      }
      if (bestAsk < config.minEntryPrice || bestAsk > config.maxEntryPrice) {
        skipReasons.push({ outcome, reason: 'price_out_of_range', detail: `bestAsk=${bestAsk} range=[${config.minEntryPrice},${config.maxEntryPrice}]` });
        continue;
      }

      const existingShares = positionManager.getShares(outcome);
      // Phase 21: use compounded max for the pre-filter too.
      const preFilterMax = Math.round(config.maxPositionShares * (params.obiSizeMultiplier ?? 1.0));
      if (existingShares >= preFilterMax) continue;

      candidates.push({
        outcome,
        thinSide,
        thinDepth,
        thickDepth,
        ratio,
        bestAsk,
        bestBid: book.bestBid,
        midPrice: book.midPrice,
        totalLiquidity,
      });
    }

    if (candidates.length === 0) {
      // Phase 21 diagnostic: log why no candidates were found.
      // Throttle to once per market per slot to avoid log spam.
      const diagKey = `${market.marketId}:${market.startTime ?? 'unknown'}`;
      if (!this.lastDiagLogMs.has(diagKey)) {
        this.lastDiagLogMs.set(diagKey, nowMs);
        const topReasons = skipReasons.map(s => `${s.outcome}:${s.reason}(${s.detail})`);
        logger.info('OBI no candidates — all outcomes filtered', {
          marketId: market.marketId,
          marketTitle: market.title,
          skipReasons: topReasons,
        });
        this.pushDecision(
          extractCoinFromObiTitle(market.title),
          'SKIP',
          skipReasons[0]?.reason ?? 'unknown',
          skipReasons.map(s => `${s.outcome}:${s.reason}`).join(', ')
        );
      }
      return [];
    }

    // Pick strongest imbalance.
    candidates.sort((a, b) => a.ratio - b.ratio);
    const chosen = candidates[0]!;

    // === Binance runaway gate (2026-04-08 binary runaway fix) ===
    // Block OBI entries when the underlying coin has already moved past the
    // configured threshold for the current 5-min slot. Mean-reversion edge
    // evaporates on runaway slots and we historically end up holding the
    // losing-side until redemption at $0. Fail-open if assessment missing.
    const gateDecision = checkObiBinanceGate({
      assessment: deepBinanceAssessment ?? null,
      outcome: chosen.outcome,
      config,
    });
    if (gateDecision.blocked) {
      const coin = extractCoinFromObiTitle(market.title);
      this.recordGateBlock(gateDecision.reason, coin);
      logger.info('OBI engine entry blocked by Binance gate', {
        marketId: market.marketId,
        marketTitle: market.title,
        reason: gateDecision.reason,
        outcome: gateDecision.outcome,
        binanceMovePct: gateDecision.movePct,
        binanceDirection: gateDecision.direction,
        runawayAbsPct: config.binanceRunawayAbsPct,
        contraAbsPct: config.binanceContraAbsPct,
      });
      return [];
    }

    // === Dust-trap prevention (Phase 23 — GATE ONLY, no forced scaling) ===
    //
    // HISTORY OF THIS BUG:
    // Phase 11-22 used minSharesForExitNotional inside Math.max() to FORCE
    // shares UP to the dust-safety minimum. At bestAsk=0.46 this forced 37
    // shares ($17.02) instead of the configured 6 shares ($2.76). This
    // INCREASED losses 6× on wrong-side trades:
    //   - SOL 37sh × $0.46 = $17.02 → lost $16.79 (should have been ~$2.76)
    //   - ETH 39sh × $0.43 = $16.77 → won $22.00 (lucky, but oversized)
    //
    // Phase 23 (2026-04-09): minSharesForExitNotional is now ONLY a gate
    // check — if the configured entry size can't satisfy it, the entry is
    // REFUSED instead of being silently inflated. This respects the user's
    // configured position size and risk limits.
    //
    // For 5-minute binary markets, dust-trapping costs at most ~$0.50-1.00
    // of unrecoverable value (shares × crashedPrice that we can't sell).
    // Inflating positions to avoid this trivial loss was catastrophically
    // wrong — it turned $3 risks into $17 risks.
    //
    // Gate parameters: buffer=1.0 (just the CLOB minimum), worst-exit=50%
    // drawdown. This is lenient enough to allow 6-share entries at typical
    // OBI prices (0.30-0.50) while still blocking truly dangerous tiny
    // positions at extreme prices.
    const dustSafetyBuffer = 1.0;
    const dustWorstExitPrice = Math.max(0.05, chosen.bestAsk * 0.50);
    const minSharesForExitNotional = Math.ceil(
      (config.clobMinNotionalUsd * dustSafetyBuffer) / dustWorstExitPrice
    );
    // Phase 21: compounding — scale entry and cap by multiplier.
    // Multiplier is 1.0 below threshold (no change), up to 5.0 at high bankroll.
    const mult = params.obiSizeMultiplier ?? 1.0;
    const compoundedEntryShares = Math.round(config.entryShares * mult);
    const compoundedMaxShares = Math.round(config.maxPositionShares * mult);

    // Phase 23: size ONLY from configured shares — no dust-safety inflation.
    const sizedShares = Math.max(
      compoundedEntryShares,
      config.clobMinShares,
    );

    // Cap at compounded maxPositionShares to respect risk limits.
    const finalShares = Math.min(sizedShares, compoundedMaxShares);
    if (finalShares < config.clobMinShares) {
      // Cannot satisfy CLOB minimums even at max position size — skip entry.
      return [];
    }

    // Phase 23 gate: refuse entry if position is too small to exit via CLOB
    // sell. At typical OBI prices (0.30-0.50) with 6 shares this passes:
    //   0.46 entry → worstExit=0.23 → need ceil(1/0.23)=5 → 6≥5 ✅
    //   0.30 entry → worstExit=0.15 → need ceil(1/0.15)=7 → 6<7 ❌ refused
    // If refused, the position is too small to safely exit. User should
    // increase OBI_ENTRY_SHARES or narrow OBI_MIN_ENTRY_PRICE.
    if (finalShares < minSharesForExitNotional) {
      const coin = extractCoinFromObiTitle(market.title);
      this.recordPhase15Refusal(coin, `bestAsk=${chosen.bestAsk} need=${minSharesForExitNotional} cap=${compoundedMaxShares}`);
      logger.info('OBI entry refused — dust-safety gate (position too small to exit)', {
        marketId: market.marketId,
        outcome: chosen.outcome,
        bestAsk: chosen.bestAsk,
        finalShares,
        minSharesForExitNotional,
        maxPositionShares: compoundedMaxShares,
        obiSizeMultiplier: mult,
        dustWorstExitPrice,
        hint: 'increase OBI_ENTRY_SHARES or raise OBI_MIN_ENTRY_PRICE',
      });
      return [];
    }

    const entryNotional = roundTo(finalShares * chosen.bestAsk, 4);
    if (entryNotional < config.minEntryNotionalUsd) {
      return [];
    }

    // === Pre-flight USDC balance check ===
    // Avoid generating signals the executor will just reject. Reserve a 5%
    // buffer for fees and price drift.
    if (config.preflightBalanceCheck && this.availableUsdcBalance !== null) {
      const requiredUsdc = entryNotional * 1.05;
      if (this.availableUsdcBalance < requiredUsdc) {
        return [];
      }
    }

    // === Phase 22: max-risk-per-trade guard ===
    // Prevents a single OBI entry from risking more than X% of the bankroll.
    // Live incident 2026-04-09: ETH YES 33sh @ $0.26 = $8.58 = 21% of $40
    // balance → full loss on wrong-side redeem. With 15% cap and $40 balance
    // the max entry would be $6.00 → ~23 shares @ 0.26, limiting loss.
    if (config.maxRiskPerTradePct < 1.0 && this.availableUsdcBalance !== null) {
      const maxNotional = this.availableUsdcBalance * config.maxRiskPerTradePct;
      if (entryNotional > maxNotional) {
        const coin = extractCoinFromObiTitle(market.title);
        logger.info('OBI entry refused — exceeds max risk per trade', {
          marketId: market.marketId,
          outcome: chosen.outcome,
          bestAsk: chosen.bestAsk,
          entryNotional,
          maxNotional: roundTo(maxNotional, 2),
          balanceUsd: roundTo(this.availableUsdcBalance, 2),
          maxRiskPct: config.maxRiskPerTradePct,
        });
        this.pushDecision(coin, 'REFUSED', 'max_risk_per_trade',
          `$${entryNotional.toFixed(2)} > ${(config.maxRiskPerTradePct * 100).toFixed(0)}% of $${this.availableUsdcBalance.toFixed(2)}`);
        return [];
      }
    }

    if (config.shadowMode) {
      this.totalShadowDecisions += 1;
      logger.info('OBI engine (shadow) would enter', {
        marketId: market.marketId,
        outcome: chosen.outcome,
        thinSide: chosen.thinSide,
        thinDepthUsd: chosen.thinDepth,
        thickDepthUsd: chosen.thickDepth,
        ratio: chosen.ratio,
        bestAsk: chosen.bestAsk,
      });
      return [];
    }

    // Phase 9 (2026-04-08): OBI entry must be TAKER (IOC), not post-only maker.
    // Thesis: "grab the thin side before book rebalances" = we buy resting ask
    // liquidity → by definition this crosses the book. Previous behaviour
    // (passive @ bestAsk, or improve @ bestAsk+tick) produced 4/7 "order
    // crosses book" rejections and 0 fills. vague-sourdough uses limit orders
    // on the OPPOSITE side for passive MM layer — not for initial entry.
    //
    // Price = bestAsk. `urgency: 'cross'` below signals executor to use IOC
    // and NOT downgrade in MARKET_MAKER_MODE (see order-executor bypass list).
    const targetPrice = roundTo(chosen.bestAsk, 6);

    const reason =
      `OBI thin ${chosen.thinSide} $${chosen.thinDepth.toFixed(2)} vs $${chosen.thickDepth.toFixed(2)}` +
      ` (ratio ${chosen.ratio.toFixed(3)}) | bestAsk ${chosen.bestAsk.toFixed(3)}`;

    // Phase 14 (2026-04-08): emit Binance assessment on every OBI entry so we
    // can post-mortem losing trades and verify whether the runaway gate is
    // actually catching volatile slots. On 2026-04-08 two entries hit hard
    // stop / dust on markets where Binance had already moved significantly
    // but gate fail-open'd because assessment was null or below threshold.
    const entCoin = extractCoinFromObiTitle(market.title);
    this.recordGatePass(entCoin);
    this.recordPhase15Accept(entCoin);

    logger.info('OBI entry accepted — Binance diagnostic snapshot', {
      marketId: market.marketId,
      marketTitle: market.title,
      outcome: chosen.outcome,
      thinSide: chosen.thinSide,
      thinDepthUsd: chosen.thinDepth,
      thickDepthUsd: chosen.thickDepth,
      ratio: chosen.ratio,
      bestAsk: chosen.bestAsk,
      finalShares,
      entryNotional,
      obiSizeMultiplier: mult,
      binanceHasAssessment: deepBinanceAssessment !== null && deepBinanceAssessment !== undefined,
      binanceAvailable: deepBinanceAssessment?.available ?? null,
      binanceCoin: deepBinanceAssessment?.coin ?? null,
      binanceMovePct: deepBinanceAssessment?.binanceMovePct ?? null,
      binanceDirection: deepBinanceAssessment?.direction ?? null,
      binanceVolatilityRatio: deepBinanceAssessment?.volatilityRatio ?? null,
      binanceFundingRate: deepBinanceAssessment?.fundingRate ?? null,
      gateRunawayAbsPct: config.binanceRunawayAbsPct,
      gateContraAbsPct: config.binanceContraAbsPct,
    });

    this.lastEntryMs.set(market.marketId, nowMs);

    const signal: StrategySignal = {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'OBI_ENTRY_BUY',
      priority: 900,
      generatedAt: nowMs,
      action: 'BUY',
      outcome: chosen.outcome,
      outcomeIndex: outcomeIndex(chosen.outcome),
      shares: finalShares,
      targetPrice,
      referencePrice: chosen.midPrice,
      tokenPrice: chosen.midPrice ?? chosen.bestAsk,
      midPrice: chosen.midPrice,
      fairValue: chosen.midPrice,
      edgeAmount: roundTo(chosen.totalLiquidity - chosen.thinDepth, 4),
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: false,
      reason,
      strategyLayer: resolveStrategyLayer('OBI_ENTRY_BUY'),
    };

    return [signal];
  }

  /**
   * Called immediately after an OBI_ENTRY_BUY fill is confirmed. Records the
   * position and returns Layer-2 MM quote signals.
   *
   * IMPORTANT — partial fill semantics: this is invoked once per fill event.
   * For multi-clip entries (e.g. 10 + 2 shares) it will be called multiple
   * times with `filledShares` being the *increment* of that fill, not the
   * accumulated total. We therefore:
   *   - merge into any existing position (VWAP entry price, summed shares),
   *   - quote MM_QUOTE_ASK against the *total* live position from
   *     positionManager (so the maker quote is sized correctly even after
   *     repeated partial fills),
   *   - never overwrite slotEndMs / initialRatio / thinSide on a re-entry,
   *     since those describe the original entry intent.
   */
  onEntryFill(params: {
    marketId: string;
    marketTitle?: string;
    outcome: Outcome;
    fillPrice: number;
    filledShares: number;
    orderbook: MarketOrderbookSnapshot;
    config: ObiEngineConfig;
    /** Total live shares on this outcome AFTER this fill was applied. */
    totalLiveShares: number;
    nowMs?: number;
    /** Slot end time (ISO string from MarketCandidate.endTime). */
    slotEndTime?: string | null;
  }): StrategySignal[] {
    const {
      marketId,
      outcome,
      fillPrice,
      filledShares,
      orderbook,
      config,
      totalLiveShares,
    } = params;
    const nowMs = params.nowMs ?? Date.now();
    const title = params.marketTitle ?? marketId;

    const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
    const existing = this.positions.get(marketId);

    if (existing && existing.outcome === outcome) {
      // Accumulate partial fill into existing position via VWAP. We do not
      // touch initialRatio / thinSide / slotEndMs — they describe the original
      // entry context and must stay stable across partial fills.
      const priorShares = existing.entryShares;
      const newShares = roundTo(priorShares + filledShares, 6);
      if (newShares > 0) {
        existing.entryPrice = roundTo(
          (existing.entryPrice * priorShares + fillPrice * filledShares) /
            newShares,
          6
        );
        existing.entryShares = newShares;
      }
      existing.lastOrderbook = orderbook;
    } else {
      const bidDepth = roundTo(book.depthNotionalBid, 4);
      const askDepth = roundTo(book.depthNotionalAsk, 4);
      const thinSide: 'bid' | 'ask' = bidDepth <= askDepth ? 'bid' : 'ask';
      const thinDepth = thinSide === 'bid' ? bidDepth : askDepth;
      const thickDepth = thinSide === 'bid' ? askDepth : bidDepth;
      const initialRatio = safeRatio(thinDepth, thickDepth);
      const slotEndMs = parseTimeMs(params.slotEndTime ?? null);

      this.positions.set(marketId, {
        marketId,
        outcome,
        entryPrice: fillPrice,
        entryShares: filledShares,
        enteredAtMs: nowMs,
        initialRatio,
        thinSide,
        slotEndMs,
        lastOrderbook: orderbook,
        marketTitle: title,
      });
    }
    // Lock cooldown on confirmed fill so even if generateSignals re-runs we
    // don't re-enter immediately.
    this.lastEntryMs.set(marketId, nowMs);
    this.totalEntries += 1;

    // Use total live shares for the maker quote, not just this fill's
    // increment, otherwise repeated partial fills produce undersized quotes
    // that fail CLOB minimums and trigger dust-abandonment of the entire
    // healthy position.
    const quoteShares = roundTo(
      Math.max(0, Number.isFinite(totalLiveShares) ? totalLiveShares : filledShares),
      4
    );
    // Reference price for the maker quote is the position's accumulated VWAP
    // (so spread is computed against actual cost basis, not just this clip).
    const quoteRefPrice = this.positions.get(marketId)?.entryPrice ?? fillPrice;

    if (config.shadowMode) {
      logger.info('OBI engine (shadow) onEntryFill', {
        marketId,
        outcome,
        fillPrice,
        filledShares,
        accumulatedShares: quoteShares,
        accumulatedEntryPrice: quoteRefPrice,
      });
      return [];
    }

    const signals: StrategySignal[] = [];

    if (config.mmAskEnabled && quoteShares > 0) {
      // Bug fix (2026-04-08 SOL/NO incident): the previous calculation
      //   askPrice = quoteRefPrice * (1 + spread)
      // ignored the live book entirely. With entryVWAP=0.34 and spread=0.015
      // it produced 0.3451, which CLOB normalizes to a valid tick and
      // crosses bestBid → 6 consecutive "invalid post-only order: order
      // crosses book" rejections.
      //
      // Correct logic: place the ask at max(spread target, current bestAsk),
      // also guaranteeing we sit at least 1 tick above the current bestBid,
      // then snap UP to the tick grid so CLOB never normalizes us into a
      // crossing price.
      const tick = inferObiTickSize(book, quoteRefPrice);
      const spreadTarget = quoteRefPrice * (1 + config.mmAskSpreadTicks);
      const bestAskFloor =
        book.bestAsk !== null && book.bestAsk > 0 ? book.bestAsk : 0;
      const bestBidFloor =
        book.bestBid !== null && book.bestBid > 0 ? book.bestBid + tick : 0;
      const safeFloor = Math.max(bestAskFloor, bestBidFloor, quoteRefPrice + tick);
      const rawAsk = Math.max(spreadTarget, safeFloor);
      const snappedAsk = Math.ceil(rawAsk / tick - 1e-9) * tick;
      const askPrice = roundTo(Math.min(0.99, snappedAsk), 4);
      signals.push({
        marketId,
        marketTitle: title,
        signalType: 'OBI_MM_QUOTE_ASK',
        priority: 850,
        generatedAt: nowMs,
        action: 'SELL',
        outcome,
        outcomeIndex: outcomeIndex(outcome),
        shares: quoteShares,
        targetPrice: askPrice,
        referencePrice: quoteRefPrice,
        tokenPrice: book.midPrice ?? quoteRefPrice,
        midPrice: book.midPrice,
        fairValue: quoteRefPrice,
        edgeAmount: roundTo(askPrice - quoteRefPrice, 6),
        combinedBid: orderbook.combined.combinedBid,
        combinedAsk: orderbook.combined.combinedAsk,
        combinedMid: orderbook.combined.combinedMid,
        combinedDiscount: orderbook.combined.combinedDiscount,
        combinedPremium: orderbook.combined.combinedPremium,
        fillRatio: 1,
        capitalClamp: 1,
        priceMultiplier: 1,
        urgency: 'passive',
        reduceOnly: true,
        reason: `OBI maker ASK ${outcome} @ ${askPrice.toFixed(3)} (entry VWAP ${quoteRefPrice.toFixed(3)}, total ${quoteShares.toFixed(2)} shares)`,
        strategyLayer: resolveStrategyLayer('OBI_MM_QUOTE_ASK'),
      });
    }

    if (config.mmBidOppositeEnabled) {
      const oppositeOutcome: Outcome = outcome === 'YES' ? 'NO' : 'YES';
      const oppositeBook = oppositeOutcome === 'YES' ? orderbook.yes : orderbook.no;
      const oppBestBid = oppositeBook.bestBid;
      if (oppBestBid !== null && oppBestBid > 0) {
        const bidPrice = roundTo(
          Math.max(0.01, oppBestBid * config.mmBidOppositeFactor),
          6
        );
        signals.push({
          marketId,
          marketTitle: title,
          signalType: 'OBI_MM_QUOTE_BID',
          priority: 840,
          generatedAt: nowMs,
          action: 'BUY',
          outcome: oppositeOutcome,
          outcomeIndex: outcomeIndex(oppositeOutcome),
          shares: quoteShares,
          targetPrice: bidPrice,
          referencePrice: oppBestBid,
          tokenPrice: oppositeBook.midPrice ?? bidPrice,
          midPrice: oppositeBook.midPrice,
          fairValue: oppBestBid,
          edgeAmount: roundTo(oppBestBid - bidPrice, 6),
          combinedBid: orderbook.combined.combinedBid,
          combinedAsk: orderbook.combined.combinedAsk,
          combinedMid: orderbook.combined.combinedMid,
          combinedDiscount: orderbook.combined.combinedDiscount,
          combinedPremium: orderbook.combined.combinedPremium,
          fillRatio: 1,
          capitalClamp: 1,
          priceMultiplier: 1,
          urgency: 'passive',
          reduceOnly: false,
          reason: `OBI maker BID ${oppositeOutcome} @ ${bidPrice.toFixed(3)} (oppBestBid ${oppBestBid.toFixed(3)})`,
          strategyLayer: resolveStrategyLayer('OBI_MM_QUOTE_BID'),
        });
      }
    }

    return signals;
  }

  /** Generate exit signals for any active position on this market. */
  generateExitSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: ObiEngineConfig;
    nowMs?: number;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config } = params;
    if (!config.enabled) return [];

    const position = this.positions.get(market.marketId);
    if (!position) return [];

    // Refresh stored orderbook so the orphan slot-end heartbeat has fresh
    // data even if the host stops calling generateExitSignals on this market.
    position.lastOrderbook = orderbook;

    // If position has been fully sold off elsewhere, drop state and stop.
    const liveShares = positionManager.getShares(position.outcome);
    if (liveShares <= 0) {
      return [];
    }

    // Phase 30D: if remaining shares are below minimum CLOB order size (1 share),
    // they are untradeable dust. Clear OBI state so we stop generating futile
    // exit signals every cycle. The shares will be auto-redeemed at settlement.
    const DUST_THRESHOLD_SHARES = 1;
    if (liveShares < DUST_THRESHOLD_SHARES) {
      logger.info('OBI: dust shares below min CLOB order — clearing state for auto-redeem', {
        marketId: market.marketId,
        outcome: position.outcome,
        liveShares: roundTo(liveShares, 4),
        threshold: DUST_THRESHOLD_SHARES,
      });
      this.clearState(market.marketId);
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();
    const slotEndMs = parseTimeMs(market.endTime) ?? position.slotEndMs;
    const book = position.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const bestBid = book.bestBid;
    const bidDepth = roundTo(book.depthNotionalBid, 4);
    const askDepth = roundTo(book.depthNotionalAsk, 4);
    const thinDepth = position.thinSide === 'bid' ? bidDepth : askDepth;
    const thickDepth = position.thinSide === 'bid' ? askDepth : bidDepth;
    const currentRatio = safeRatio(thinDepth, thickDepth);

    // Compute live PnL for hard-stop and tracking.
    // Phase 28: when bestBid is null (bid side wiped out), fall back to
    // bestAsk * 0.9 as a pessimistic estimate. Previously defaulted to 0,
    // which silently disabled the hard stop (0 <= -$2 = false).
    const pnlPrice = bestBid ?? (book.bestAsk !== null ? roundTo(book.bestAsk * 0.9, 4) : null);
    const livePnlUsd =
      pnlPrice !== null
        ? roundTo((pnlPrice - position.entryPrice) * liveShares, 4)
        : 0;

    const buildExit = (
      signalType: 'OBI_REBALANCE_EXIT' | 'OBI_SCALP_EXIT',
      reason: string,
      targetPrice: number | null
    ): StrategySignal => ({
      marketId: market.marketId,
      marketTitle: market.title,
      signalType,
      priority: 950,
      generatedAt: nowMs,
      action: 'SELL',
      outcome: position.outcome,
      outcomeIndex: outcomeIndex(position.outcome),
      shares: liveShares,
      targetPrice,
      referencePrice: position.entryPrice,
      tokenPrice: book.midPrice ?? targetPrice,
      midPrice: book.midPrice,
      fairValue: position.entryPrice,
      edgeAmount: 0,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: true,
      reason,
      strategyLayer: resolveStrategyLayer(signalType),
    });

    // === Hard PnL stop ===
    // Exit immediately when the position is more than `hardStopUsd` underwater.
    // This is the safety net that prevents -$5 redemptions.
    if (livePnlUsd <= -config.hardStopUsd && bestBid !== null) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would hard-stop', {
          marketId: market.marketId,
          entryPrice: position.entryPrice,
          bestBid,
          livePnlUsd,
          hardStopUsd: config.hardStopUsd,
        });
        return [];
      }
      this.totalExitSignals += 1;
      this.recordLosingExit(market, nowMs);
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI hard stop: pnl $${livePnlUsd.toFixed(2)} <= -$${config.hardStopUsd.toFixed(2)}`,
          bestBid
        ),
      ];
    }

    // === Imbalance collapse: book fully reversed against us ===
    // Originally we entered the thin side (low ratio). If currentRatio has
    // exploded past `imbalanceCollapseRatio` (e.g. 2.0 = 2x heavier on our side
    // now), the imbalance reversed.
    //
    // Phase 27: only exit on collapse if bestBid >= entryPrice OR if the loss
    // already exceeds half the hard stop (emergency bail). When bestBid < entry,
    // selling locks in a loss with the same EV as redeem minus spread costs.
    // On 5-min slots the tail risk is limited, so holding for redeem is better
    // than paying the spread to crystallise a loss. The hard stop (-$2) still
    // catches catastrophic moves.
    if (currentRatio >= config.imbalanceCollapseRatio) {
      const collapseInProfit = bestBid !== null && bestBid >= position.entryPrice;
      const emergencyBail = livePnlUsd <= -(config.hardStopUsd * 0.5);
      if (collapseInProfit || emergencyBail) {
        if (config.shadowMode) {
          this.totalShadowDecisions += 1;
          logger.info('OBI engine (shadow) would collapse-exit', {
            marketId: market.marketId,
            initialRatio: position.initialRatio,
            currentRatio,
            collapseRatio: config.imbalanceCollapseRatio,
            bestBid,
            entryPrice: position.entryPrice,
            emergencyBail,
          });
          return [];
        }
        this.totalExitSignals += 1;
        if (livePnlUsd < 0) this.recordLosingExit(market, nowMs);
        return [
          buildExit(
            'OBI_REBALANCE_EXIT',
            `OBI collapse: ratio ${currentRatio.toFixed(3)} >= ${config.imbalanceCollapseRatio.toFixed(3)}${emergencyBail ? ' (emergency bail)' : `, bid ${bestBid!.toFixed(3)} >= entry ${position.entryPrice.toFixed(3)}`}`,
            bestBid
          ),
        ];
      }
    }

    // Cancel-all / forced flatten window before slot end.
    if (
      slotEndMs !== null &&
      slotEndMs - nowMs <= config.cancelAllBeforeEndMs
    ) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would flatten before slot end', {
          marketId: market.marketId,
          outcome: position.outcome,
          shares: liveShares,
        });
        return [];
      }
      this.totalExitSignals += 1;
      if (livePnlUsd < 0) this.recordLosingExit(market, nowMs);
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI cancel-all: ${slotEndMs - nowMs}ms to slot end`,
          bestBid
        ),
      ];
    }

    // Book healed / rebalanced.
    // Phase 27: only exit on rebalance if bestBid >= entryPrice (profitable or
    // breakeven). When the book rebalances but the price dropped below entry,
    // selling locks in a guaranteed loss. Holding for redeem at ~$0.50 entry
    // has better EV (+$0.07) than a -$0.56 rebalance exit. Collapse exits
    // (ratio >= imbalanceCollapseRatio, checked above) still fire at any price
    // as an emergency measure. Scalp exit and time-TP also only fire in profit.
    if (
      currentRatio >= config.exitRebalanceRatio &&
      bestBid !== null &&
      bestBid >= position.entryPrice
    ) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would rebalance exit', {
          marketId: market.marketId,
          initialRatio: position.initialRatio,
          currentRatio,
          bestBid,
          entryPrice: position.entryPrice,
        });
        return [];
      }
      this.totalExitSignals += 1;
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI rebalance: ratio ${currentRatio.toFixed(3)} >= ${config.exitRebalanceRatio.toFixed(3)}, bid ${bestBid.toFixed(3)} >= entry ${position.entryPrice.toFixed(3)}`,
          bestBid
        ),
      ];
    }

    // Phase 26: time-based take-profit. If position is in profit (even small)
    // and has been held longer than timeTakeProfitMs, take the money and run.
    // Smart money exits fast — waiting for the full scalpExitEdge target often
    // means the edge evaporates and the position drifts to break-even or loss.
    if (
      config.timeTakeProfitMs > 0 &&
      bestBid !== null &&
      bestBid > position.entryPrice + config.timeTakeProfitMinEdge &&
      nowMs - position.enteredAtMs >= config.timeTakeProfitMs
    ) {
      const holdSec = Math.round((nowMs - position.enteredAtMs) / 1000);
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would time-take-profit', {
          marketId: market.marketId,
          entryPrice: position.entryPrice,
          bestBid,
          holdSec,
          edge: roundTo(bestBid - position.entryPrice, 4),
        });
        return [];
      }
      this.totalExitSignals += 1;
      return [
        buildExit(
          'OBI_SCALP_EXIT',
          `OBI time-TP: held ${holdSec}s, bid ${bestBid.toFixed(3)} > entry ${position.entryPrice.toFixed(3)} + ${config.timeTakeProfitMinEdge} (edge ${roundTo(bestBid - position.entryPrice, 4)})`,
          bestBid
        ),
      ];
    }

    // Scalp profit-taking.
    if (
      bestBid !== null &&
      bestBid >= position.entryPrice * (1 + config.scalpExitEdge)
    ) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would scalp exit', {
          marketId: market.marketId,
          entryPrice: position.entryPrice,
          bestBid,
        });
        return [];
      }
      this.totalExitSignals += 1;
      return [
        buildExit(
          'OBI_SCALP_EXIT',
          `OBI scalp: bid ${bestBid.toFixed(3)} >= entry ${position.entryPrice.toFixed(3)} * (1+${config.scalpExitEdge.toFixed(3)})`,
          bestBid
        ),
      ];
    }

    return [];
  }

  /**
   * Independent slot-end safety net. Walks ALL tracked OBI positions and
   * returns flatten signals for any whose slot end is within
   * `cancelAllBeforeEndMs`, regardless of whether the host is currently
   * processing them. This is the fix for positions that fall out of the
   * candidate list right before slot end and never get a normal exit tick.
   *
   * Host should call this once per processing cycle, AFTER it has processed
   * all the per-market ticks. Excluded markets are those for which a normal
   * exit was already emitted in this cycle.
   *
   * The signals use the position's stored lastOrderbook (refreshed on the
   * latest tick this market was processed). If no orderbook is stored, the
   * signal still goes out with a defensive low targetPrice so the executor
   * can cross the spread.
   */
  /**
   * Phase 16 (2026-04-08): emergency hard-stop sweep.
   *
   * The normal hard-stop check lives inside generateExitSignals, which is
   * only called by the host loop when a market is in the eligible-candidate
   * list. If a market falls out of that list (slot ageing, filtering,
   * candidate-pool churn) while we still hold a position, hard stop is
   * silently bypassed and the position can implode.
   *
   * Live incident 2026-04-08 16:07: SOL OBI position bought at 0.45 with
   * hardStopUsd=0.60. Best ask collapsed 0.45→0.01 over 2.5 minutes. Hard
   * stop never fired (no log line at all). Position lost full $8.55.
   *
   * This sweep iterates ALL tracked OBI positions every cycle (called from
   * the host's main loop), pulls the freshest orderbook via callback, and
   * unconditionally fires the hard-stop signal if livePnl < -hardStopUsd.
   * Independent of the per-market candidate loop.
   *
   * Fallback: when bestBid is null (one-sided book), uses bestAsk * 0.9
   * as a defensive estimate so we still detect crashes from the ask side.
   */
  getEmergencyHardStopSignals(params: {
    positionManager: (marketId: string) => PositionManager | null;
    getOrderbook: (marketId: string) => MarketOrderbookSnapshot | null;
    config: ObiEngineConfig;
    excludeMarketIds?: Set<string>;
    nowMs?: number;
  }): StrategySignal[] {
    const { positionManager, getOrderbook, config, excludeMarketIds } = params;
    if (!config.enabled) return [];
    const nowMs = params.nowMs ?? Date.now();
    const out: StrategySignal[] = [];

    // Throttle: 3s between repeat hard-stop emits per market. Cancel + sell
    // typically settles within 1-2s; we don't want to spam fills.
    const HARD_STOP_THROTTLE_MS = 3_000;

    for (const [marketId, position] of this.positions.entries()) {
      if (excludeMarketIds?.has(marketId)) continue;

      const pm = positionManager(marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares <= 0) continue;

      // Phase 31: dust check — sub-1-share positions can't be sold on CLOB.
      // Don't waste cycles generating hard-stop signals for dust.
      if (liveShares < 1) {
        this.clearState(marketId);
        continue;
      }

      // Pull fresh orderbook from host. Fall back to last cached on the
      // position object if host has nothing newer.
      const orderbook = getOrderbook(marketId) ?? position.lastOrderbook ?? null;
      if (!orderbook) continue;
      const book = position.outcome === 'YES' ? orderbook.yes : orderbook.no;

      // Defensive PnL price: prefer bestBid (what we'd actually realise on
      // a market sell), fall back to bestAsk * 0.9 if the bid side is empty
      // or zero. The 0.9 multiplier mirrors a typical market-impact haircut
      // and is intentionally pessimistic so we err on the side of firing.
      let pnlPrice: number | null = null;
      let priceSource: 'bestBid' | 'bestAsk*0.9' | null = null;
      if (book.bestBid !== null && book.bestBid > 0) {
        pnlPrice = book.bestBid;
        priceSource = 'bestBid';
      } else if (book.bestAsk !== null && book.bestAsk > 0) {
        pnlPrice = roundTo(book.bestAsk * 0.9, 6);
        priceSource = 'bestAsk*0.9';
      }
      if (pnlPrice === null) continue;

      const livePnlUsd = roundTo(
        (pnlPrice - position.entryPrice) * liveShares,
        4
      );

      if (livePnlUsd > -config.hardStopUsd) continue;

      // Throttle repeat emits.
      const lastEmit = this.lastOrphanEmitMs.get(marketId);
      if (lastEmit !== undefined && nowMs - lastEmit < HARD_STOP_THROTTLE_MS) {
        continue;
      }

      logger.warn('OBI emergency hard stop (sweep path)', {
        marketId,
        outcome: position.outcome,
        entryPrice: position.entryPrice,
        liveShares,
        pnlPrice,
        priceSource,
        livePnlUsd,
        hardStopUsd: config.hardStopUsd,
        reason: 'sweep detected loss beyond hard-stop, market may be outside candidate loop',
      });

      this.lastOrphanEmitMs.set(marketId, nowMs);
      this.totalExitSignals += 1;
      this.recordLosingExit(
        { marketId, title: position.marketTitle } as MarketCandidate,
        nowMs
      );

      out.push({
        marketId,
        marketTitle: position.marketTitle,
        signalType: 'OBI_REBALANCE_EXIT',
        priority: 999,
        generatedAt: nowMs,
        action: 'SELL',
        outcome: position.outcome,
        outcomeIndex: outcomeIndex(position.outcome),
        shares: liveShares,
        targetPrice: pnlPrice,
        referencePrice: position.entryPrice,
        tokenPrice: pnlPrice,
        midPrice: orderbook.combined?.combinedMid ?? pnlPrice,
        fairValue: position.entryPrice,
        edgeAmount: 0,
        combinedBid: orderbook.combined?.combinedBid ?? 0,
        combinedAsk: orderbook.combined?.combinedAsk ?? 0,
        combinedMid: orderbook.combined?.combinedMid ?? 0,
        combinedDiscount: 0,
        combinedPremium: 0,
        fillRatio: 1,
        capitalClamp: 1,
        priceMultiplier: 1,
        urgency: 'cross',
        reduceOnly: true,
        reason: `OBI emergency hard stop (sweep): pnl $${livePnlUsd.toFixed(2)} <= -$${config.hardStopUsd.toFixed(2)} via ${priceSource}`,
        strategyLayer: resolveStrategyLayer('OBI_REBALANCE_EXIT'),
      });
    }

    return out;
  }

  getOrphanFlattenSignals(params: {
    positionManager: (marketId: string) => PositionManager | null;
    config: ObiEngineConfig;
    excludeMarketIds?: Set<string>;
    nowMs?: number;
  }): StrategySignal[] {
    const { positionManager, config, excludeMarketIds } = params;
    if (!config.enabled) return [];
    const nowMs = params.nowMs ?? Date.now();
    const out: StrategySignal[] = [];

    // Throttle: do not re-emit a flatten for the same market within this
    // window. Crossing-spread sells take a few seconds to propagate through
    // FillTracker; without this throttle, every 2.5s tick re-fires the same
    // exit and we get the orphan-flatten spam observed in the 2026-04-08
    // XRP slot.
    const ORPHAN_EMIT_THROTTLE_MS = 5_000;
    // Phase 12 (2026-04-08): was 120s, reduced to 30s after observing
    // ETH 9:00 slot dust on 2026-04-08 13:00 — 9 shares at price 0.11
    // (notional $0.99) failed MIN_ORDER_SIZE filter on every flatten
    // attempt and we spammed 9 "orphan flatten emitted" WARN logs over
    // 60 seconds, each one hitting the same filter rejection. At this
    // point the position is dust — stop pretending we can still exit it.
    // Phase 28: increased from 30s to 60s. With the notional floor bypass
    // for reduce-only sells, orphan flattens can now succeed at low prices.
    // Give more time before giving up to redeem.
    const ORPHAN_GIVE_UP_AFTER_MS = 60_000;

    for (const [marketId, position] of this.positions.entries()) {
      if (excludeMarketIds?.has(marketId)) continue;
      if (position.slotEndMs === null) continue;
      const remainingMs = position.slotEndMs - nowMs;
      if (remainingMs > config.cancelAllBeforeEndMs) continue;

      // Slot has been over too long — give up on DUST positions only.
      // Phase 32: NEVER give up on positions with ≥ 1 tradeable share.
      // Previously this unconditionally deleted ALL positions after 60s,
      // causing 31 entries / 0 exits overnight — positions with 2-3 shares
      // became zombies with no exit mechanism.
      if (remainingMs < -ORPHAN_GIVE_UP_AFTER_MS) {
        const pm = positionManager(marketId);
        const liveShares = pm ? pm.getShares(position.outcome) : 0;
        if (liveShares < 1) {
          logger.info('OBI orphan flatten given up — dust position, slot ended too long ago', {
            marketId,
            outcome: position.outcome,
            liveShares: roundTo(liveShares, 4),
            remainingMs,
          });
          this.positions.delete(marketId);
          this.lastOrphanEmitMs.delete(marketId);
          continue;
        }
        // Position still has tradeable shares — keep tracking and continue
        // to emit flatten signals below. Just throttle to avoid spam.
        // Log only once per 30s to avoid log flood.
        const lastGiveUpLog = this.lastOrphanEmitMs.get(marketId);
        if (!lastGiveUpLog || nowMs - lastGiveUpLog > 30_000) {
          logger.warn('OBI orphan flatten: slot ended but position still has tradeable shares — continuing exits', {
            marketId,
            outcome: position.outcome,
            liveShares: roundTo(liveShares, 4),
            remainingMs,
            elapsed: `${Math.round(-remainingMs / 1000)}s past slot end`,
          });
        }
        // Fall through to emit flatten signal below
      }

      const lastEmit = this.lastOrphanEmitMs.get(marketId);
      if (lastEmit !== undefined && nowMs - lastEmit < ORPHAN_EMIT_THROTTLE_MS) {
        continue;
      }

      const pm = positionManager(marketId);
      if (!pm) continue;
      const liveShares = pm.getShares(position.outcome);
      if (liveShares <= 0) continue;

      // Defensive target price: use stored book best bid if available,
      // otherwise drop to a guaranteed-cross price (1 cent above 0).
      let targetPrice: number | null = null;
      let combinedBid = 0;
      let combinedAsk = 0;
      let combinedMid = 0;
      if (position.lastOrderbook) {
        const book =
          position.outcome === 'YES'
            ? position.lastOrderbook.yes
            : position.lastOrderbook.no;
        targetPrice = book.bestBid;
        combinedBid = position.lastOrderbook.combined.combinedBid ?? 0;
        combinedAsk = position.lastOrderbook.combined.combinedAsk ?? 0;
        combinedMid = position.lastOrderbook.combined.combinedMid ?? 0;
      }
      if (targetPrice === null || targetPrice <= 0) {
        targetPrice = 0.01;
      }

      // Phase 12 (2026-04-08): dust detection — if current shares × current
      // best bid is below the CLOB min notional + a small buffer, the
      // downstream MIN_ORDER_SIZE filter USED TO reject every flatten attempt.
      //
      // Phase 28 UPDATE: resolveReduceOnlySellGuard now bypasses the notional
      // floor for reduce-only sells, so the downstream filter no longer blocks
      // emergency exits. Only skip truly tiny dust residuals (< 1 share),
      // NOT full positions at low prices (e.g. 7sh × $0.14 = $0.98 was wrongly
      // classified as "dust" and abandoned to redeem → -$3.23 loss).
      const REAL_DUST_SHARES = 1; // below 1 share is real dust
      if (liveShares < REAL_DUST_SHARES) {
        logger.info('OBI orphan flatten skipped — position is real dust, forcing redeem', {
          marketId,
          outcome: position.outcome,
          liveShares,
          targetPrice,
          remainingMs,
          reason: 'less than 1 share — true dust residual, let redeem handle',
        });
        // Propagate to coin cooldown (this is effectively a losing exit).
        this.lastLosingExitMs.set(marketId, nowMs);
        const dustCoin = extractCoinFromObiTitle(position.marketTitle);
        if (dustCoin !== null) {
          this.lastLosingExitMsByCoin.set(dustCoin, nowMs);
        }
        // Drop engine-side tracking so we never emit for this market again.
        // The host's dust-abandon path (and redeem-on-settlement) take over.
        this.positions.delete(marketId);
        this.lastOrphanEmitMs.delete(marketId);
        continue;
      }

      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        this.lastOrphanEmitMs.set(marketId, nowMs);
        logger.info('OBI engine (shadow) orphan slot-end flatten', {
          marketId,
          outcome: position.outcome,
          shares: liveShares,
          remainingMs,
          targetPrice,
        });
        continue;
      }

      this.totalExitSignals += 1;
      this.lastLosingExitMs.set(marketId, nowMs);
      // Phase 8: orphan flattens are usually losing — propagate to coin map
      // so we don't immediately re-enter another slot of the same coin.
      const orphanCoin = extractCoinFromObiTitle(position.marketTitle);
      if (orphanCoin !== null) {
        this.lastLosingExitMsByCoin.set(orphanCoin, nowMs);
      }
      this.lastOrphanEmitMs.set(marketId, nowMs);
      logger.warn('OBI orphan slot-end flatten emitted', {
        marketId,
        outcome: position.outcome,
        shares: liveShares,
        remainingMs,
        targetPrice,
      });

      out.push({
        marketId,
        marketTitle: position.marketTitle,
        signalType: 'OBI_REBALANCE_EXIT',
        priority: 999,
        generatedAt: nowMs,
        action: 'SELL',
        outcome: position.outcome,
        outcomeIndex: outcomeIndex(position.outcome),
        shares: liveShares,
        targetPrice,
        referencePrice: position.entryPrice,
        tokenPrice: targetPrice,
        midPrice: targetPrice,
        fairValue: position.entryPrice,
        edgeAmount: 0,
        combinedBid,
        combinedAsk,
        combinedMid,
        combinedDiscount: 0,
        combinedPremium: 0,
        fillRatio: 1,
        capitalClamp: 1,
        priceMultiplier: 1,
        urgency: 'cross',
        reduceOnly: true,
        reason: `OBI orphan flatten: ${remainingMs}ms to slot end (market not in candidate list)`,
        strategyLayer: resolveStrategyLayer('OBI_REBALANCE_EXIT'),
      });
    }

    return out;
  }

  /** Snapshot of currently tracked OBI positions (for diagnostics / dashboard). */
  getActivePositions(): readonly Readonly<ObiPosition>[] {
    return Array.from(this.positions.values());
  }

  /** Check if a market is tracked by the OBI engine. */
  hasPosition(marketId: string): boolean {
    return this.positions.has(marketId);
  }

  /**
   * Drop per-market state. Called by host on market cleanup.
   *
   * NOTE (2026-04-08 whipsaw re-entry fix): we intentionally do NOT clear
   * `lastLosingExitMs` here. The wallet reconcile path calls clearState as
   * soon as PositionManager gross exposure drops to 0 after an exit fill,
   * which used to wipe the re-entry cooldown marker and allow the engine
   * to re-enter the same cascading market within seconds. The 08:02-08:03
   * session on market 0x3ff0a5a cycled entry → abandon → lucky ask fill
   * → re-entry → hard stop all on the same marketId in ~60s because the
   * losing-exit cooldown was cleared mid-cascade. Each 5-minute slot has
   * a unique marketId so the map entry is bounded by slot lifecycle.
   */
  clearState(marketId: string): void {
    this.positions.delete(marketId);
    this.lastEntryMs.delete(marketId);
    this.lastOrphanEmitMs.delete(marketId);
    this.lastImbalanceRatios.delete(marketId);
  }

  /** Get entry price for a position (used by sync fill PnL calculation). */
  getPositionEntryPrice(marketId: string): number | null {
    return this.positions.get(marketId)?.entryPrice ?? null;
  }

  /** Phase 36: last computed imbalance ratio for slot replay tracker. */
  getLastImbalanceRatio(marketId: string): number | null {
    return this.lastImbalanceRatios.get(marketId) ?? null;
  }

  /** Operational counters for the dashboard. */
  getStats(): ObiStatsSnapshot {
    return {
      activePositions: this.positions.size,
      totalEntries: this.totalEntries,
      totalExits: this.totalConfirmedExits,
      totalExitSignals: this.totalExitSignals,
      totalShadowDecisions: this.totalShadowDecisions,
    };
  }
}
