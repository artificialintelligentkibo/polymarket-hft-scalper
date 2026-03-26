import type { BinanceEdgeAssessment } from './binance-edge.js';
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface LatencyMomentumConfig {
  enabled: boolean;
  minMovePct: number;
  strongMovePct: number;
  maxEntryWindowMs: number;
  maxPmLagPct: number;
  pmMoveSensitivity: number;
  maxEntryPrice: number;
  minEntryPrice: number;
  baseShares: number;
  strongShares: number;
  maxPositionShares: number;
  cooldownMs: number;
  invertSignal: boolean;
}

export class LatencyMomentumEngine {
  private readonly lastEntryAt = new Map<string, number>();

  /**
   * Generates a taker-style latency signal when Binance has moved before Polymarket reprices.
   */
  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    binanceAssessment?: BinanceEdgeAssessment;
    config: LatencyMomentumConfig;
    blockedOutcomes?: ReadonlySet<Outcome>;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, binanceAssessment, config, blockedOutcomes } = params;
    if (!config.enabled || !binanceAssessment?.available) {
      return [];
    }

    const movePct = Math.abs(binanceAssessment.binanceMovePct);
    if (
      !Number.isFinite(movePct) ||
      movePct < config.minMovePct ||
      binanceAssessment.direction === 'FLAT'
    ) {
      return [];
    }

    const slotStartMs = market.startTime ? Date.parse(market.startTime) : Number.NaN;
    if (
      Number.isFinite(slotStartMs) &&
      Date.now() - slotStartMs > config.maxEntryWindowMs
    ) {
      return [];
    }

    const cooldownKey = market.marketId;
    const lastEntryAt = this.lastEntryAt.get(cooldownKey);
    if (lastEntryAt && Date.now() - lastEntryAt < config.cooldownMs) {
      return [];
    }

    const desiredOutcome = resolveLatencyOutcome(binanceAssessment.direction, config.invertSignal);
    if (blockedOutcomes?.has(desiredOutcome)) {
      return [];
    }

    const book = desiredOutcome === 'YES' ? orderbook.yes : orderbook.no;
    const bestAsk = book.bestAsk;
    if (
      bestAsk === null ||
      bestAsk < config.minEntryPrice ||
      bestAsk > config.maxEntryPrice
    ) {
      return [];
    }

    const pmDirectionalMovePct =
      calculatePmEquivalentMovePct({
        pmUpMid: binanceAssessment.pmUpMid,
        pmDirection: binanceAssessment.pmImpliedDirection,
        binanceDirection: binanceAssessment.direction,
        pmMoveSensitivity: config.pmMoveSensitivity,
      });
    const lagGap = roundTo(movePct - pmDirectionalMovePct, 4);
    if (lagGap < config.maxPmLagPct) {
      return [];
    }

    const currentShares = positionManager.getShares(desiredOutcome);
    const availableCapacity = Math.max(0, config.maxPositionShares - currentShares);
    const requestedShares =
      movePct >= config.strongMovePct ? config.strongShares : config.baseShares;
    const shares = roundTo(Math.min(requestedShares, availableCapacity), 4);
    if (shares <= 0) {
      return [];
    }

    logger.info('Latency momentum opportunity detected', {
      marketId: market.marketId,
      direction: binanceAssessment.direction,
      binanceMovePct: binanceAssessment.binanceMovePct,
      desiredOutcome,
      lagGap,
      bestAsk,
      shares,
    });

    return [
      {
        marketId: market.marketId,
        marketTitle: market.title,
        signalType: 'LATENCY_MOMENTUM_BUY',
        priority: 450,
        generatedAt: Date.now(),
        action: 'BUY',
        outcome: desiredOutcome,
        outcomeIndex: desiredOutcome === 'YES' ? 0 : 1,
        shares,
        targetPrice: roundTo(bestAsk, 6),
        referencePrice:
          binanceAssessment.binancePrice ?? binanceAssessment.slotOpenPrice,
        tokenPrice: book.lastTradePrice ?? bestAsk,
        midPrice: book.midPrice,
        fairValue: null,
        edgeAmount: lagGap,
        combinedBid: orderbook.combined.combinedBid,
        combinedAsk: orderbook.combined.combinedAsk,
        combinedMid: orderbook.combined.combinedMid,
        combinedDiscount: orderbook.combined.combinedDiscount,
        combinedPremium: orderbook.combined.combinedPremium,
        fillRatio: 1,
        capitalClamp: clamp(availableCapacity / Math.max(config.maxPositionShares, 1), 0.25, 1),
        priceMultiplier: movePct >= config.strongMovePct ? 1.5 : 1,
          urgency: 'cross',
        reduceOnly: false,
        reason: `Binance moved ${binanceAssessment.binanceMovePct.toFixed(4)}% ${binanceAssessment.direction} while Polymarket repriced only ${pmDirectionalMovePct.toFixed(4)}% equivalent and ${desiredOutcome} still offers ${bestAsk.toFixed(4)} ask`,
      },
    ];
  }

  recordExecution(params: {
    marketId: string;
  }): void {
    this.lastEntryAt.set(params.marketId, Date.now());
  }
}

export function resolveLatencyOutcome(
  direction: 'UP' | 'DOWN' | 'FLAT',
  invertSignal: boolean
): Outcome {
  const cheapOutcome: Outcome = direction === 'DOWN' ? 'YES' : 'NO';
  if (!invertSignal) {
    return cheapOutcome;
  }

  return cheapOutcome === 'YES' ? 'NO' : 'YES';
}

export function calculatePmEquivalentMovePct(params: {
  pmUpMid: number | null;
  pmDirection: 'UP' | 'DOWN' | 'FLAT';
  binanceDirection: 'UP' | 'DOWN' | 'FLAT';
  pmMoveSensitivity: number;
}): number {
  const { pmUpMid, pmDirection, binanceDirection, pmMoveSensitivity } = params;
  if (
    pmUpMid === null ||
    !Number.isFinite(pmUpMid) ||
    binanceDirection === 'FLAT' ||
    pmDirection !== binanceDirection ||
    !Number.isFinite(pmMoveSensitivity) ||
    pmMoveSensitivity <= 0
  ) {
    return 0;
  }

  return roundTo(Math.abs(pmUpMid - 0.5) / pmMoveSensitivity, 4);
}
