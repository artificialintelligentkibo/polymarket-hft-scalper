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
}

/* ------------------------------------------------------------------ */
/*  Per-market state                                                   */
/* ------------------------------------------------------------------ */

interface ObiPosition {
  readonly marketId: string;
  readonly outcome: Outcome;
  readonly entryPrice: number;
  readonly entryShares: number;
  readonly enteredAtMs: number;
  readonly initialRatio: number;
  readonly thinSide: 'bid' | 'ask';
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
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class ObiEngine {
  private readonly positions = new Map<string, ObiPosition>();
  private readonly lastEntryMs = new Map<string, number>();
  private totalEntries = 0;
  private totalExits = 0;
  private totalShadowDecisions = 0;

  /** Generate entry signals for the given market tick. */
  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: ObiEngineConfig;
    nowMs?: number;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config } = params;
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

    // Cooldown gate.
    const lastEntry = this.lastEntryMs.get(market.marketId);
    if (lastEntry !== undefined && nowMs - lastEntry < config.cooldownMs) {
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
      shares: config.entryShares,
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
   * Called immediately after an OBI_ENTRY_BUY fill is confirmed. Records
   * the position and returns Layer-2 MM quote signals.
   */
  onEntryFill(params: {
    marketId: string;
    marketTitle?: string;
    outcome: Outcome;
    fillPrice: number;
    filledShares: number;
    orderbook: MarketOrderbookSnapshot;
    config: ObiEngineConfig;
    nowMs?: number;
  }): StrategySignal[] {
    const { marketId, outcome, fillPrice, filledShares, orderbook, config } = params;
    const nowMs = params.nowMs ?? Date.now();
    const title = params.marketTitle ?? marketId;

    const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
    const bidDepth = roundTo(book.depthNotionalBid, 4);
    const askDepth = roundTo(book.depthNotionalAsk, 4);
    const thinSide: 'bid' | 'ask' = bidDepth <= askDepth ? 'bid' : 'ask';
    const thinDepth = thinSide === 'bid' ? bidDepth : askDepth;
    const thickDepth = thinSide === 'bid' ? askDepth : bidDepth;
    const initialRatio = safeRatio(thinDepth, thickDepth);

    this.positions.set(marketId, {
      marketId,
      outcome,
      entryPrice: fillPrice,
      entryShares: filledShares,
      enteredAtMs: nowMs,
      initialRatio,
      thinSide,
    });
    this.totalEntries += 1;

    if (config.shadowMode) {
      logger.info('OBI engine (shadow) onEntryFill', {
        marketId,
        outcome,
        fillPrice,
        filledShares,
        initialRatio,
      });
      return [];
    }

    const signals: StrategySignal[] = [];

    if (config.mmAskEnabled && filledShares > 0) {
      const askPrice = roundTo(
        Math.min(0.99, fillPrice * (1 + config.mmAskSpreadTicks)),
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
        shares: filledShares,
        targetPrice: askPrice,
        referencePrice: fillPrice,
        tokenPrice: book.midPrice ?? fillPrice,
        midPrice: book.midPrice,
        fairValue: fillPrice,
        edgeAmount: roundTo(askPrice - fillPrice, 6),
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
        reason: `OBI maker ASK ${outcome} @ ${askPrice.toFixed(3)} (entry ${fillPrice.toFixed(3)})`,
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
          shares: filledShares,
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

    // If position has been fully sold off elsewhere, drop state and stop.
    const liveShares = positionManager.getShares(position.outcome);
    if (liveShares <= 0) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();
    const slotEndMs = parseTimeMs(market.endTime);
    const book = position.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const bestBid = book.bestBid;
    const bidDepth = roundTo(book.depthNotionalBid, 4);
    const askDepth = roundTo(book.depthNotionalAsk, 4);
    const thinDepth = position.thinSide === 'bid' ? bidDepth : askDepth;
    const thickDepth = position.thinSide === 'bid' ? askDepth : bidDepth;
    const currentRatio = safeRatio(thinDepth, thickDepth);

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

  /** Drop per-market state. Called by host on market cleanup. */
  clearState(marketId: string): void {
    this.positions.delete(marketId);
    this.lastEntryMs.delete(marketId);
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
