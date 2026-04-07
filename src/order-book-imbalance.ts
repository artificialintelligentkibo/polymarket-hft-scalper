/**
 * Order Book Imbalance Filter.
 *
 * Optional filter used as a *gate* for Layer 2 (MM) activation.
 * This is NOT a standalone strategy — it is a guardrail that lets MM
 * quote only when the Polymarket order book shows a meaningful liquidity
 * imbalance, matching the vague-sourdough style described in
 * https://x.com/retrovalix/status/2041191137507983769
 *
 * Design principles:
 * - Purely additive: when ORDER_BOOK_IMBALANCE_ENABLED=false the filter
 *   always returns `allow=true` and the bot behaves exactly as before.
 * - Composition: the filter is a small pure class — no engines are
 *   modified. It is called from the MM activation branches in index.ts.
 * - Stateless snapshot evaluation + per-market rebalance tracking so the
 *   caller can decide whether an *already active* MM layer should be
 *   forced to flatten because the imbalance has collapsed.
 */

import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import { logger } from './logger.js';
import { roundTo } from './utils.js';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export interface OrderBookImbalanceConfig {
  /** Master switch. When false, `evaluate()` always returns allow=true. */
  readonly enabled: boolean;
  /** Thin side depth (USD) below which we consider the book imbalanced. */
  readonly thinThresholdUsd: number;
  /** Minimum total top-of-book liquidity (bid + ask USD) required. */
  readonly minLiquidityUsd: number;
  /** Ratio of (thin/thick) below which the book is treated as imbalanced. */
  readonly entryImbalanceRatio: number;
  /** Ratio above which an already-open MM leg should be closed (rebalanced). */
  readonly exitRebalanceRatio: number;
  /**
   * When a rebalance is detected, keep this fraction of the stronger leg
   * instead of flattening 100%. 0 = flatten everything, 1 = keep all.
   */
  readonly keepStrongerLegPct: number;
  /**
   * When true, the filter only *observes* and logs the decision without
   * blocking or forcing MM actions. Used to shadow-test OBI in production.
   */
  readonly shadowMode: boolean;
}

/* ------------------------------------------------------------------ */
/*  Result                                                             */
/* ------------------------------------------------------------------ */

export interface OrderBookImbalanceDecision {
  /** Whether the filter is allowing the MM layer to activate / stay on. */
  readonly allow: boolean;
  /** The side that is thin (weak), which is where MM should quote. */
  readonly thinSide: 'bid' | 'ask' | null;
  /** The outcome (YES / NO) on which the imbalance was detected. */
  readonly outcome: Outcome | null;
  /** USD depth of the thin side (top N levels). */
  readonly thinDepthUsd: number;
  /** USD depth of the thick side. */
  readonly thickDepthUsd: number;
  /** Computed ratio (thin / thick). */
  readonly ratio: number;
  /** Total top-of-book liquidity (bid + ask) across both legs. */
  readonly totalLiquidityUsd: number;
  /** Human-readable description for logs / narrator. */
  readonly reason: string;
}

/* ------------------------------------------------------------------ */
/*  Per-market state (for rebalance detection on active MM legs)       */
/* ------------------------------------------------------------------ */

interface ActiveOBIState {
  readonly marketId: string;
  readonly detectedAtMs: number;
  readonly initialRatio: number;
  readonly thinSide: 'bid' | 'ask';
  readonly outcome: Outcome;
}

/* ------------------------------------------------------------------ */
/*  Filter                                                             */
/* ------------------------------------------------------------------ */

export class OrderBookImbalanceFilter {
  private readonly activeStates = new Map<string, ActiveOBIState>();

  constructor(private readonly config: OrderBookImbalanceConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Evaluates the current orderbook and returns an allow/deny decision
   * plus diagnostic info. If the filter is disabled the result is always
   * `allow=true` with a synthetic reason so callers need no extra guard.
   */
  evaluate(
    orderbook: MarketOrderbookSnapshot,
    triggerOutcome?: Outcome,
  ): OrderBookImbalanceDecision {
    if (!this.config.enabled) {
      return {
        allow: true,
        thinSide: null,
        outcome: null,
        thinDepthUsd: 0,
        thickDepthUsd: 0,
        ratio: 0,
        totalLiquidityUsd: 0,
        reason: 'OBI filter disabled (pass-through)',
      };
    }

    // Prefer the outcome the sniper just entered on — that's the leg MM
    // would post an ask for. Fall back to evaluating both sides and picking
    // the most imbalanced one.
    const candidates: Outcome[] =
      triggerOutcome !== undefined ? [triggerOutcome] : ['YES', 'NO'];
    let best: OrderBookImbalanceDecision | null = null;

    for (const outcome of candidates) {
      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bidDepth = roundTo(book.depthNotionalBid, 4);
      const askDepth = roundTo(book.depthNotionalAsk, 4);
      const totalLiquidityUsd = roundTo(bidDepth + askDepth, 4);

      if (totalLiquidityUsd < this.config.minLiquidityUsd) {
        const reason = `OBI skip (${outcome}): total liquidity $${totalLiquidityUsd.toFixed(2)} < min $${this.config.minLiquidityUsd.toFixed(0)}`;
        if (!best) {
          best = {
            allow: false,
            thinSide: null,
            outcome,
            thinDepthUsd: Math.min(bidDepth, askDepth),
            thickDepthUsd: Math.max(bidDepth, askDepth),
            ratio: safeRatio(Math.min(bidDepth, askDepth), Math.max(bidDepth, askDepth)),
            totalLiquidityUsd,
            reason,
          };
        }
        continue;
      }

      const thinSide: 'bid' | 'ask' = bidDepth <= askDepth ? 'bid' : 'ask';
      const thinDepth = thinSide === 'bid' ? bidDepth : askDepth;
      const thickDepth = thinSide === 'bid' ? askDepth : bidDepth;
      const ratio = safeRatio(thinDepth, thickDepth);

      const imbalanced =
        thinDepth < this.config.thinThresholdUsd &&
        ratio <= this.config.entryImbalanceRatio;

      const reason = imbalanced
        ? `OBI allow (${outcome}): thin ${thinSide} $${thinDepth.toFixed(2)} vs thick $${thickDepth.toFixed(2)} (ratio ${ratio.toFixed(2)})`
        : `OBI block (${outcome}): thin ${thinSide} $${thinDepth.toFixed(2)} ≥ thresh $${this.config.thinThresholdUsd.toFixed(0)} (ratio ${ratio.toFixed(2)})`;

      const decision: OrderBookImbalanceDecision = {
        allow: imbalanced,
        thinSide,
        outcome,
        thinDepthUsd: thinDepth,
        thickDepthUsd: thickDepth,
        ratio,
        totalLiquidityUsd,
        reason,
      };

      if (!best || decision.allow) {
        best = decision;
        if (decision.allow) break;
      }
    }

    return (
      best ?? {
        allow: false,
        thinSide: null,
        outcome: null,
        thinDepthUsd: 0,
        thickDepthUsd: 0,
        ratio: 0,
        totalLiquidityUsd: 0,
        reason: 'OBI: no candidate outcomes to evaluate',
      }
    );
  }

  /**
   * Called from MM activation path. Returns true if MM should activate.
   * In shadow mode the filter logs the decision but always returns true,
   * so operators can A/B-compare without altering real behaviour.
   */
  shouldAllowMMActivation(params: {
    marketId: string;
    orderbook: MarketOrderbookSnapshot;
    entryOutcome: Outcome;
    coin?: string;
  }): boolean {
    const decision = this.evaluate(params.orderbook, params.entryOutcome);

    // Shadow-mode logging: write the decision but never block.
    if (this.config.shadowMode) {
      logger.info('OBI filter (shadow)', {
        marketId: params.marketId,
        coin: params.coin,
        wouldAllow: decision.allow,
        thinSide: decision.thinSide,
        thinDepthUsd: decision.thinDepthUsd,
        thickDepthUsd: decision.thickDepthUsd,
        ratio: decision.ratio,
        reason: decision.reason,
      });
      return true;
    }

    if (!this.config.enabled) {
      return true;
    }

    if (decision.allow && decision.thinSide) {
      this.activeStates.set(params.marketId, {
        marketId: params.marketId,
        detectedAtMs: Date.now(),
        initialRatio: decision.ratio,
        thinSide: decision.thinSide,
        outcome: decision.outcome ?? params.entryOutcome,
      });
      logger.info('OBI filter: allowing MM layer 2', {
        marketId: params.marketId,
        coin: params.coin,
        thinSide: decision.thinSide,
        thinDepthUsd: decision.thinDepthUsd,
        thickDepthUsd: decision.thickDepthUsd,
        ratio: decision.ratio,
        totalLiquidityUsd: decision.totalLiquidityUsd,
      });
    } else {
      logger.debug('OBI filter: blocking MM layer 2', {
        marketId: params.marketId,
        coin: params.coin,
        reason: decision.reason,
      });
    }

    return decision.allow;
  }

  /**
   * Check whether the imbalance on an active MM market has collapsed.
   * Returns a recommendation: 'hold' (keep quoting), 'flatten' (exit full),
   * or 'partial' (keep `keepStrongerLegPct` of the stronger side).
   */
  checkRebalance(
    marketId: string,
    orderbook: MarketOrderbookSnapshot,
  ): 'hold' | 'flatten' | 'partial' {
    if (!this.config.enabled) return 'hold';
    const state = this.activeStates.get(marketId);
    if (!state) return 'hold';

    const book = state.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const bidDepth = roundTo(book.depthNotionalBid, 4);
    const askDepth = roundTo(book.depthNotionalAsk, 4);
    const thinDepth = state.thinSide === 'bid' ? bidDepth : askDepth;
    const thickDepth = state.thinSide === 'bid' ? askDepth : bidDepth;
    const ratio = safeRatio(thinDepth, thickDepth);

    if (ratio >= this.config.exitRebalanceRatio) {
      logger.info('OBI rebalance detected', {
        marketId,
        initialRatio: state.initialRatio,
        currentRatio: ratio,
        thinDepthUsd: thinDepth,
        thickDepthUsd: thickDepth,
      });
      this.activeStates.delete(marketId);
      return this.config.keepStrongerLegPct > 0 ? 'partial' : 'flatten';
    }

    return 'hold';
  }

  /** Clear per-market state when the market closes or MM deactivates. */
  clearState(marketId: string): void {
    this.activeStates.delete(marketId);
  }

  /** For monitoring / dashboard. */
  getActiveStates(): readonly ActiveOBIState[] {
    return [...this.activeStates.values()];
  }
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
