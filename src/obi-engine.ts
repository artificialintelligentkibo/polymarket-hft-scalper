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
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
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
  readonly totalExits: number;
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
      readonly reason: 'runaway_abs' | 'contra_direction' | 'unavailable_required';
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
    'binanceGateEnabled' | 'binanceRunawayAbsPct' | 'binanceContraAbsPct'
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

  return { blocked: false, reason: null };
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class ObiEngine {
  private readonly positions = new Map<string, ObiPosition>();
  private readonly lastEntryMs = new Map<string, number>();
  /** Markets where we recently exited at a loss — extra cooldown applies. */
  private readonly lastLosingExitMs = new Map<string, number>();
  /** Last time getOrphanFlattenSignals emitted for a market — used to throttle. */
  private readonly lastOrphanEmitMs = new Map<string, number>();
  /** Last available USDC balance reported by host. Used for pre-flight check. */
  private availableUsdcBalance: number | null = null;
  private totalEntries = 0;
  private totalExits = 0;
  private totalShadowDecisions = 0;

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
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config, deepBinanceAssessment } = params;
    if (!config.enabled) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();

    // Slot timing checks based on MarketCandidate.startTime / endTime.
    const slotStartMs = parseTimeMs(market.startTime);
    const slotEndMs = parseTimeMs(market.endTime);
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

    // Already holding an OBI position on this market — do not stack a second
    // entry from the same engine. Existing position is managed via exits.
    if (this.positions.has(market.marketId)) {
      return [];
    }

    const candidates: ObiCandidate[] = [];
    for (const outcome of ['YES', 'NO'] as const) {
      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bidDepth = roundTo(book.depthNotionalBid, 4);
      const askDepth = roundTo(book.depthNotionalAsk, 4);
      const totalLiquidity = roundTo(bidDepth + askDepth, 4);
      if (totalLiquidity < config.minLiquidityUsd) continue;

      const thinSide: 'bid' | 'ask' = bidDepth <= askDepth ? 'bid' : 'ask';
      const thinDepth = thinSide === 'bid' ? bidDepth : askDepth;
      const thickDepth = thinSide === 'bid' ? askDepth : bidDepth;
      const ratio = safeRatio(thinDepth, thickDepth);

      if (thinDepth >= config.thinThresholdUsd) continue;
      if (ratio > config.entryImbalanceRatio) continue;

      const bestAsk = book.bestAsk;
      if (bestAsk === null) continue;
      if (bestAsk < config.minEntryPrice || bestAsk > config.maxEntryPrice) continue;

      const existingShares = positionManager.getShares(outcome);
      if (existingShares >= config.maxPositionShares) continue;

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

    // === Dust-trap prevention ===
    // CLOB requires 5 shares min AND $1 min notional. If the entry leaves the
    // position too small to be SOLD at any reasonable exit price, we'd get
    // stuck and the position would redeem at $0.
    //
    // Compute auto-sized shares: enough so that even at half the entry price,
    // the position is still above CLOB minimums with a safety buffer.
    const safetyBuffer = 1.5; // require 1.5x CLOB notional minimum at exit.
    const minSharesForExitNotional = Math.ceil(
      (config.clobMinNotionalUsd * safetyBuffer) / Math.max(0.05, chosen.bestAsk * 0.5)
    );
    const sizedShares = Math.max(
      config.entryShares,
      config.clobMinShares,
      minSharesForExitNotional
    );

    // Cap at maxPositionShares to respect risk limits.
    const finalShares = Math.min(sizedShares, config.maxPositionShares);
    if (finalShares < config.clobMinShares) {
      // Cannot satisfy CLOB minimums even at max position size — skip entry.
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

    const targetPrice = config.aggressiveEntry
      ? roundTo(Math.min(1, chosen.bestAsk + 0.01), 6)
      : roundTo(chosen.bestAsk, 6);

    const reason =
      `OBI thin ${chosen.thinSide} $${chosen.thinDepth.toFixed(2)} vs $${chosen.thickDepth.toFixed(2)}` +
      ` (ratio ${chosen.ratio.toFixed(3)}) | bestAsk ${chosen.bestAsk.toFixed(3)}`;

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
      urgency: config.aggressiveEntry ? 'improve' : 'passive',
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
      const askPrice = roundTo(
        Math.min(0.99, quoteRefPrice * (1 + config.mmAskSpreadTicks)),
        6
      );
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
    const livePnlUsd =
      bestBid !== null
        ? roundTo((bestBid - position.entryPrice) * liveShares, 4)
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
      this.totalExits += 1;
      this.lastLosingExitMs.set(market.marketId, nowMs);
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
    // now), the imbalance reversed; exit now before it gets worse.
    if (currentRatio >= config.imbalanceCollapseRatio) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would collapse-exit', {
          marketId: market.marketId,
          initialRatio: position.initialRatio,
          currentRatio,
          collapseRatio: config.imbalanceCollapseRatio,
        });
        return [];
      }
      this.totalExits += 1;
      if (livePnlUsd < 0) this.lastLosingExitMs.set(market.marketId, nowMs);
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI collapse: ratio ${currentRatio.toFixed(3)} >= ${config.imbalanceCollapseRatio.toFixed(3)}`,
          bestBid
        ),
      ];
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
      this.totalExits += 1;
      if (livePnlUsd < 0) this.lastLosingExitMs.set(market.marketId, nowMs);
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI cancel-all: ${slotEndMs - nowMs}ms to slot end`,
          bestBid
        ),
      ];
    }

    // Book healed / rebalanced.
    if (currentRatio >= config.exitRebalanceRatio) {
      if (config.shadowMode) {
        this.totalShadowDecisions += 1;
        logger.info('OBI engine (shadow) would rebalance exit', {
          marketId: market.marketId,
          initialRatio: position.initialRatio,
          currentRatio,
        });
        return [];
      }
      this.totalExits += 1;
      if (livePnlUsd < 0) this.lastLosingExitMs.set(market.marketId, nowMs);
      return [
        buildExit(
          'OBI_REBALANCE_EXIT',
          `OBI rebalance: ratio ${currentRatio.toFixed(3)} >= ${config.exitRebalanceRatio.toFixed(3)}`,
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
      this.totalExits += 1;
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
    // Hard give-up: once the slot has been over for this long, the orders
    // won't fill on any reasonable book and we should drop the position from
    // tracking so it can flow into auto-redeem instead of looping forever.
    const ORPHAN_GIVE_UP_AFTER_MS = 120_000;

    for (const [marketId, position] of this.positions.entries()) {
      if (excludeMarketIds?.has(marketId)) continue;
      if (position.slotEndMs === null) continue;
      const remainingMs = position.slotEndMs - nowMs;
      if (remainingMs > config.cancelAllBeforeEndMs) continue;

      // Slot has been over too long — give up emitting flatten signals so
      // the redeem path can take over. Clear tracking state.
      if (remainingMs < -ORPHAN_GIVE_UP_AFTER_MS) {
        logger.info('OBI orphan flatten given up — slot ended too long ago', {
          marketId,
          outcome: position.outcome,
          remainingMs,
        });
        this.positions.delete(marketId);
        this.lastOrphanEmitMs.delete(marketId);
        continue;
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

      this.totalExits += 1;
      this.lastLosingExitMs.set(marketId, nowMs);
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
  }

  /** Operational counters for the dashboard. */
  getStats(): ObiStatsSnapshot {
    return {
      activePositions: this.positions.size,
      totalEntries: this.totalEntries,
      totalExits: this.totalExits,
      totalShadowDecisions: this.totalShadowDecisions,
    };
  }
}
