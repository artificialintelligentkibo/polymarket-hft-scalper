import { config, isDynamicQuotingEnabled, type AppConfig } from './config.js';
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import { evaluateDayDrawdown } from './day-pnl-state.js';
import { buildFlattenSignals } from './flatten-signals.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import { getEffectiveStrategyConfig, resolveProductTestUrgency } from './product-test-mode.js';
import type {
  BoundaryCorrection,
  ExitSignal,
  PositionManager,
  PositionSnapshot,
} from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';
import { OUTCOMES } from './utils.js';

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
    const limits = getEffectiveStrategyConfig(this.runtimeConfig);

    positionManager.setSlotEndsAt(market.endTime);
    positionManager.markToMarket({
      YES: orderbook.yes.midPrice ?? orderbook.yes.bestBid ?? orderbook.yes.lastTradePrice,
      NO: orderbook.no.midPrice ?? orderbook.no.bestBid ?? orderbook.no.lastTradePrice,
    });

    const blockedOutcomes = new Set<Outcome>();
    const drawdownEvaluation = evaluateDayDrawdown(now, this.runtimeConfig);
    if (drawdownEvaluation.justHalted) {
      logger.warn('RISK_STOP_DRAWDOWN triggered', {
        marketId: market.marketId,
        dayPnl: drawdownEvaluation.state.dayPnl,
        peakPnl: drawdownEvaluation.state.peakPnl,
        drawdown: drawdownEvaluation.state.drawdown,
        threshold: this.runtimeConfig.strategy.maxDrawdownUsdc,
      });
    }

    if (drawdownEvaluation.state.tradingHalted) {
      blockedOutcomes.add('YES');
      blockedOutcomes.add('NO');

      const forcedSignals = buildFlattenSignals({
        market,
        orderbook,
        snapshot: positionManager.getSnapshot(),
        signalType: 'RISK_LIMIT',
        reasonPrefix: 'RISK_STOP_DRAWDOWN',
      });

      return {
        snapshot: positionManager.getSnapshot(),
        blockedOutcomes,
        forcedSignals: sortSignals(forcedSignals).slice(0, limits.maxSignalsPerTick),
      };
    }

    const forcedSignals: StrategySignal[] = [];
    const boundary = positionManager.getBoundaryCorrection(limits, {
      useQuoteRebalance:
        isDynamicQuotingEnabled(this.runtimeConfig) &&
        this.runtimeConfig.REBALANCE_ON_IMBALANCE,
    });
    if (boundary) {
      forcedSignals.push(this.fromBoundaryCorrection(boundary, market, orderbook));
    }

    for (const outcome of OUTCOMES as readonly Outcome[]) {
      const exit = positionManager.getExitSignal(outcome, now, limits);
      if (exit) {
        forcedSignals.push(this.fromExitSignal(exit, market, orderbook));
      }
    }

    if (
      positionManager.getAvailableEntryCapacity('YES', limits) <
        limits.minShares ||
      positionManager.isEntryCoolingDown('YES', now)
    ) {
      blockedOutcomes.add('YES');
    }
    if (
      positionManager.getAvailableEntryCapacity('NO', limits) <
        limits.minShares ||
      positionManager.isEntryCoolingDown('NO', now)
    ) {
      blockedOutcomes.add('NO');
    }

    const imbalanceState = positionManager.getInventoryImbalanceState(limits);
    if (
      imbalanceState.dominantOutcome &&
      Math.abs(imbalanceState.imbalance) >= this.runtimeConfig.strategy.entryImbalanceBlockThreshold
    ) {
      blockedOutcomes.add(imbalanceState.dominantOutcome);
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
      generatedAt: Date.now(),
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
      urgency: resolveProductTestUrgency(
        correction.signalType === 'INVENTORY_REBALANCE_QUOTE' ? 'passive' : 'cross',
        this.runtimeConfig
      ),
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
      generatedAt: Date.now(),
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
      urgency: resolveProductTestUrgency('cross', this.runtimeConfig),
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
