import { config, type AppConfig } from './config.js';
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import type { MarketCandidate } from './monitor.js';
import type {
  BoundaryCorrection,
  ExitSignal,
  PositionManager,
  PositionSnapshot,
} from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';

export interface RiskAssessment {
  snapshot: PositionSnapshot;
  blockedOutcomes: ReadonlySet<Outcome>;
  forcedSignals: readonly StrategySignal[];
}

export class RiskManager {
  constructor(private readonly runtimeConfig: AppConfig = config) {}

  checkRiskLimits(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    now?: Date;
  }): RiskAssessment {
    const now = params.now ?? new Date();
    const { market, orderbook, positionManager } = params;
    const limits = this.runtimeConfig.strategy;

    positionManager.setSlotEndsAt(market.endTime);
    positionManager.markToMarket({
      YES: orderbook.yes.bestBid ?? orderbook.yes.midPrice,
      NO: orderbook.no.bestBid ?? orderbook.no.midPrice,
    });

    const forcedSignals: StrategySignal[] = [];
    const boundary = positionManager.getBoundaryCorrection(limits);
    if (boundary) {
      forcedSignals.push(this.fromBoundaryCorrection(boundary, market, orderbook));
    }

    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      const exit = positionManager.getExitSignal(outcome, now, limits);
      if (exit) {
        forcedSignals.push(this.fromExitSignal(exit, market, orderbook));
      }
    }

    const blockedOutcomes = new Set<Outcome>();
    if (positionManager.getAvailableEntryCapacity('YES', limits) < this.runtimeConfig.strategy.minShares) {
      blockedOutcomes.add('YES');
    }
    if (positionManager.getAvailableEntryCapacity('NO', limits) < this.runtimeConfig.strategy.minShares) {
      blockedOutcomes.add('NO');
    }

    return {
      snapshot: positionManager.getSnapshot(),
      blockedOutcomes,
      forcedSignals: sortSignals(forcedSignals).slice(0, limits.maxSignalsPerTick),
    };
  }

  private fromBoundaryCorrection(
    correction: BoundaryCorrection,
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): StrategySignal {
    const book = correction.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const targetPrice = book.bestBid ?? book.midPrice;

    return {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: correction.signalType,
      priority: 900,
      action: correction.action,
      outcome: correction.outcome,
      outcomeIndex: correction.outcome === 'YES' ? 0 : 1,
      shares: correction.shares,
      targetPrice,
      referencePrice: targetPrice,
      tokenPrice: book.lastTradePrice ?? targetPrice,
      midPrice: book.midPrice,
      fairValue: book.midPrice,
      edgeAmount: correction.shares,
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
      reason: correction.reason,
    };
  }

  private fromExitSignal(
    exit: ExitSignal,
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): StrategySignal {
    const book = exit.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const targetPrice = book.bestBid ?? exit.targetPrice ?? book.midPrice;

    return {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: exit.signalType,
      priority: exit.signalType === 'SLOT_FLATTEN' ? 1000 : 950,
      action: 'SELL',
      outcome: exit.outcome,
      outcomeIndex: exit.outcome === 'YES' ? 0 : 1,
      shares: exit.shares,
      targetPrice,
      referencePrice: targetPrice,
      tokenPrice: book.lastTradePrice ?? targetPrice,
      midPrice: book.midPrice,
      fairValue: book.midPrice,
      edgeAmount: exit.shares,
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
      reason: exit.reason,
    };
  }
}

function sortSignals(signals: StrategySignal[]): StrategySignal[] {
  return [...signals].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return right.shares - left.shares;
  });
}
