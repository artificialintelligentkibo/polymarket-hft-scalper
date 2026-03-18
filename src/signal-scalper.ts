import { config, type AppConfig } from './config.js';
import type { MarketOrderbookSnapshot, Outcome, TokenBookSnapshot } from './clob-fetcher.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { RiskAssessment } from './risk-manager.js';
import type { StrategySignal } from './strategy-types.js';

export interface SizeCalculationResult {
  shares: number;
  priceMultiplier: number;
  fillRatio: number;
  capitalClamp: number;
}

export class SignalScalper {
  constructor(private readonly runtimeConfig: AppConfig = config) {}

  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    riskAssessment: RiskAssessment;
    now?: Date;
  }): StrategySignal[] {
    const now = params.now ?? new Date();
    const { market, orderbook, positionManager, riskAssessment } = params;

    if (riskAssessment.forcedSignals.length > 0) {
      return takeTopSignals(
        riskAssessment.forcedSignals,
        this.runtimeConfig.strategy.maxSignalsPerTick
      );
    }

    if (!this.runtimeConfig.ENABLE_SIGNAL) {
      return [];
    }

    if (!this.isEntryWindowOpen(market, now)) {
      return [];
    }

    const groups: StrategySignal[][] = [
      this.getCombinedDiscountSignals(market, orderbook, positionManager, riskAssessment),
      this.getExtremeSignals(market, orderbook, positionManager, riskAssessment),
      this.getFairValueSignals(market, orderbook, positionManager, riskAssessment),
      this.getInventoryRebalanceSignals(market, orderbook, positionManager, riskAssessment),
    ];

    const flattened = mergeSignals(groups.flat());
    return takeTopSignals(flattened, this.runtimeConfig.strategy.maxSignalsPerTick);
  }

  private getCombinedDiscountSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    riskAssessment: RiskAssessment
  ): StrategySignal[] {
    const combinedDiscount = orderbook.combined.combinedDiscount;
    const combinedAsk = orderbook.combined.combinedAsk;

    if (
      combinedDiscount === null ||
      combinedAsk === null ||
      combinedDiscount < this.runtimeConfig.strategy.minCombinedDiscount
    ) {
      return [];
    }

    const signals: StrategySignal[] = [];
    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      if (riskAssessment.blockedOutcomes.has(outcome)) {
        continue;
      }

      const book = getBookForOutcome(orderbook, outcome);
      const bestAsk = book.bestAsk;
      if (bestAsk === null) {
        continue;
      }

      const size = calculateTradeSize({
        action: 'BUY',
        signalType: 'COMBINED_DISCOUNT_BUY_BOTH',
        edgeAmount: combinedDiscount,
        availableCapacity: positionManager.getAvailableEntryCapacity(
          outcome,
          this.runtimeConfig.strategy
        ),
        depthShares: book.depthSharesAsk,
        liquidityUsd: market.liquidityUsd,
        price: bestAsk,
        referenceEdge: this.runtimeConfig.strategy.minCombinedDiscount,
        runtimeConfig: this.runtimeConfig,
      });

      if (size.shares < this.runtimeConfig.strategy.minShares) {
        continue;
      }

      signals.push(
        buildSignal({
          market,
          orderbook,
          signalType: 'COMBINED_DISCOUNT_BUY_BOTH',
          priority: 400,
          action: 'BUY',
          outcome,
          shares: size.shares,
          targetPrice: bestAsk,
          referencePrice: combinedAsk,
          tokenPrice: book.lastTradePrice ?? bestAsk,
          midPrice: book.midPrice,
          fairValue: book.midPrice,
          edgeAmount: combinedDiscount,
          priceMultiplier: size.priceMultiplier,
          fillRatio: size.fillRatio,
          capitalClamp: size.capitalClamp,
          urgency: 'improve',
          reduceOnly: false,
          reason: `Combined ask ${formatPrice(combinedAsk)} is discounted by ${formatPrice(combinedDiscount)} versus parity`,
        })
      );
    }

    return signals;
  }

  private getExtremeSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    riskAssessment: RiskAssessment
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      const book = getBookForOutcome(orderbook, outcome);
      const bestAsk = book.bestAsk;
      const bestBid = book.bestBid;
      const openShares = positionManager.getShares(outcome);

      if (!riskAssessment.blockedOutcomes.has(outcome) && bestAsk !== null) {
        const edge = this.runtimeConfig.strategy.extremeBuyThreshold - bestAsk;
        if (edge >= 0) {
          const size = calculateTradeSize({
            action: 'BUY',
            signalType: 'EXTREME_BUY',
            edgeAmount: edge,
            availableCapacity: positionManager.getAvailableEntryCapacity(
              outcome,
              this.runtimeConfig.strategy
            ),
            depthShares: book.depthSharesAsk,
            liquidityUsd: market.liquidityUsd,
            price: bestAsk,
            referenceEdge: this.runtimeConfig.strategy.extremeBuyThreshold,
            runtimeConfig: this.runtimeConfig,
          });

          if (size.shares >= this.runtimeConfig.strategy.minShares) {
            signals.push(
              buildSignal({
                market,
                orderbook,
                signalType: 'EXTREME_BUY',
                priority: 300,
                action: 'BUY',
                outcome,
                shares: size.shares,
                targetPrice: bestAsk,
                referencePrice: this.runtimeConfig.strategy.extremeBuyThreshold,
                tokenPrice: book.lastTradePrice ?? bestAsk,
                midPrice: book.midPrice,
                fairValue: book.midPrice,
                edgeAmount: edge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: 'improve',
                reduceOnly: false,
                reason: `${outcome} ask ${formatPrice(bestAsk)} is inside the extreme buy zone`,
              })
            );
          }
        }
      }

      if (openShares > 0 && bestBid !== null) {
        const edge = bestBid - this.runtimeConfig.strategy.extremeSellThreshold;
        if (edge >= 0) {
          const size = calculateTradeSize({
            action: 'SELL',
            signalType: 'EXTREME_SELL',
            edgeAmount: edge,
            availableCapacity: openShares,
            depthShares: book.depthSharesBid,
            liquidityUsd: market.liquidityUsd,
            price: bestBid,
            referenceEdge: 1 - this.runtimeConfig.strategy.extremeSellThreshold,
            runtimeConfig: this.runtimeConfig,
            allowBelowMin: true,
          });

          if (size.shares > 0) {
            signals.push(
              buildSignal({
                market,
                orderbook,
                signalType: 'EXTREME_SELL',
                priority: 300,
                action: 'SELL',
                outcome,
                shares: size.shares,
                targetPrice: bestBid,
                referencePrice: this.runtimeConfig.strategy.extremeSellThreshold,
                tokenPrice: book.lastTradePrice ?? bestBid,
                midPrice: book.midPrice,
                fairValue: book.midPrice,
                edgeAmount: edge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: 'cross',
                reduceOnly: true,
                reason: `${outcome} bid ${formatPrice(bestBid)} is inside the extreme sell zone`,
              })
            );
          }
        }
      }
    }

    return signals;
  }

  private getFairValueSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    riskAssessment: RiskAssessment
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      const book = getBookForOutcome(orderbook, outcome);
      const bestAsk = book.bestAsk;
      const bestBid = book.bestBid;
      const fairValue = book.midPrice;
      const openShares = positionManager.getShares(outcome);

      if (
        !riskAssessment.blockedOutcomes.has(outcome) &&
        fairValue !== null &&
        bestAsk !== null
      ) {
        const buyEdge = fairValue - bestAsk;
        if (buyEdge >= this.runtimeConfig.strategy.fairValueBuyThreshold) {
          const size = calculateTradeSize({
            action: 'BUY',
            signalType: 'FAIR_VALUE_BUY',
            edgeAmount: buyEdge,
            availableCapacity: positionManager.getAvailableEntryCapacity(
              outcome,
              this.runtimeConfig.strategy
            ),
            depthShares: book.depthSharesAsk,
            liquidityUsd: market.liquidityUsd,
            price: bestAsk,
            referenceEdge: this.runtimeConfig.strategy.fairValueBuyThreshold,
            runtimeConfig: this.runtimeConfig,
          });

          if (size.shares >= this.runtimeConfig.strategy.minShares) {
            signals.push(
              buildSignal({
                market,
                orderbook,
                signalType: 'FAIR_VALUE_BUY',
                priority: 200,
                action: 'BUY',
                outcome,
                shares: size.shares,
                targetPrice: bestAsk,
                referencePrice: fairValue,
                tokenPrice: book.lastTradePrice ?? bestAsk,
                midPrice: fairValue,
                fairValue,
                edgeAmount: buyEdge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: 'passive',
                reduceOnly: false,
                reason: `${outcome} ask ${formatPrice(bestAsk)} is below fair value ${formatPrice(fairValue)}`,
              })
            );
          }
        }
      }

      if (fairValue !== null && bestBid !== null && openShares > 0) {
        const sellEdge = bestBid - fairValue;
        if (sellEdge >= this.runtimeConfig.strategy.fairValueSellThreshold) {
          const size = calculateTradeSize({
            action: 'SELL',
            signalType: 'FAIR_VALUE_SELL',
            edgeAmount: sellEdge,
            availableCapacity: openShares,
            depthShares: book.depthSharesBid,
            liquidityUsd: market.liquidityUsd,
            price: bestBid,
            referenceEdge: this.runtimeConfig.strategy.fairValueSellThreshold,
            runtimeConfig: this.runtimeConfig,
            allowBelowMin: true,
          });

          if (size.shares > 0) {
            signals.push(
              buildSignal({
                market,
                orderbook,
                signalType: 'FAIR_VALUE_SELL',
                priority: 200,
                action: 'SELL',
                outcome,
                shares: size.shares,
                targetPrice: bestBid,
                referencePrice: fairValue,
                tokenPrice: book.lastTradePrice ?? bestBid,
                midPrice: fairValue,
                fairValue,
                edgeAmount: sellEdge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: 'improve',
                reduceOnly: true,
                reason: `${outcome} bid ${formatPrice(bestBid)} is above fair value ${formatPrice(fairValue)}`,
              })
            );
          }
        }
      }
    }

    return signals;
  }

  private getInventoryRebalanceSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    riskAssessment: RiskAssessment
  ): StrategySignal[] {
    const imbalanceState = positionManager.getInventoryImbalanceState(this.runtimeConfig.strategy);
    if (!imbalanceState.dominantOutcome || imbalanceState.suggestedReduceShares <= 0) {
      return [];
    }

    const outcome = imbalanceState.dominantOutcome;
    const book = getBookForOutcome(orderbook, outcome);
    const bestBid = book.bestBid ?? book.midPrice;
    if (bestBid === null) {
      return [];
    }

    const size = calculateTradeSize({
      action: 'SELL',
      signalType: 'INVENTORY_REBALANCE',
      edgeAmount: imbalanceState.excess,
      availableCapacity: Math.min(
        positionManager.getShares(outcome),
        imbalanceState.suggestedReduceShares
      ),
      depthShares: book.depthSharesBid,
      liquidityUsd: market.liquidityUsd,
      price: bestBid,
      referenceEdge: this.runtimeConfig.strategy.inventoryImbalanceThreshold,
      runtimeConfig: this.runtimeConfig,
      allowBelowMin: true,
    });

    if (size.shares <= 0) {
      return [];
    }

    return [
      buildSignal({
        market,
        orderbook,
        signalType: 'INVENTORY_REBALANCE',
        priority: 100,
        action: 'SELL',
        outcome,
        shares: size.shares,
        targetPrice: bestBid,
        referencePrice: 0,
        tokenPrice: book.lastTradePrice ?? bestBid,
        midPrice: book.midPrice,
        fairValue: book.midPrice,
        edgeAmount: imbalanceState.excess,
        priceMultiplier: size.priceMultiplier,
        fillRatio: size.fillRatio,
        capitalClamp: size.capitalClamp,
        urgency: 'improve',
        reduceOnly: true,
        reason: `Inventory imbalance ${formatPrice(imbalanceState.imbalance)} exceeded threshold ${this.runtimeConfig.strategy.inventoryImbalanceThreshold}`,
      }),
    ];
  }

  private isEntryWindowOpen(market: MarketCandidate, now: Date): boolean {
    if (!market.endTime) {
      return true;
    }

    const endMs = Date.parse(market.endTime);
    if (!Number.isFinite(endMs)) {
      return true;
    }

    return endMs - now.getTime() > this.runtimeConfig.strategy.exitBeforeEndMs;
  }
}

export function calculateTradeSize(params: {
  action: 'BUY' | 'SELL';
  signalType: StrategySignal['signalType'];
  edgeAmount: number;
  availableCapacity: number;
  depthShares: number;
  liquidityUsd: number;
  price: number | null;
  referenceEdge: number;
  runtimeConfig?: AppConfig;
  allowBelowMin?: boolean;
}): SizeCalculationResult {
  const runtimeConfig = params.runtimeConfig ?? config;
  const strategy = runtimeConfig.strategy;
  const priceMultiplier = resolvePriceMultiplier(params.price, runtimeConfig);
  const normalizedDepth = params.depthShares / Math.max(1, strategy.depthReferenceShares);
  const normalizedEdge =
    params.referenceEdge > 0 ? params.edgeAmount / params.referenceEdge : 1;
  const fillRatio = roundTo(clamp(normalizedDepth * normalizedEdge, 0.25, 1.75), 4);
  const capacityBase =
    params.action === 'SELL' ? strategy.maxShares : strategy.capitalReferenceShares;
  const capitalClamp = roundTo(
    clamp(params.availableCapacity / Math.max(1, capacityBase), 0.2, 1),
    4
  );
  const liquidityClamp = clamp(
    params.liquidityUsd / Math.max(strategy.minLiquidityUsd, strategy.sizeLiquidityCapUsd),
    0.35,
    1
  );
  const rawShares =
    strategy.baseOrderShares *
    priceMultiplier *
    fillRatio *
    capitalClamp *
    liquidityClamp;
  const minShares = params.allowBelowMin ? 0.01 : strategy.minShares;
  const shares = roundTo(
    clamp(rawShares, minShares, Math.min(strategy.maxShares, params.availableCapacity)),
    4
  );

  return {
    shares,
    priceMultiplier,
    fillRatio,
    capitalClamp,
  };
}

export function resolvePriceMultiplier(
  price: number | null,
  runtimeConfig: AppConfig = config
): number {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return 1;
  }

  for (const level of runtimeConfig.strategy.priceMultiplierLevels) {
    if (price <= level.maxPrice) {
      return level.multiplier;
    }
  }

  return runtimeConfig.strategy.priceMultiplierLevels.at(-1)?.multiplier ?? 1;
}

function buildSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  signalType: StrategySignal['signalType'];
  priority: number;
  action: 'BUY' | 'SELL';
  outcome: Outcome;
  shares: number;
  targetPrice: number | null;
  referencePrice: number | null;
  tokenPrice: number | null;
  midPrice: number | null;
  fairValue: number | null;
  edgeAmount: number;
  priceMultiplier: number;
  fillRatio: number;
  capitalClamp: number;
  urgency: StrategySignal['urgency'];
  reduceOnly: boolean;
  reason: string;
}): StrategySignal {
  return {
    marketId: params.market.marketId,
    marketTitle: params.market.title,
    signalType: params.signalType,
    priority: params.priority,
    action: params.action,
    outcome: params.outcome,
    outcomeIndex: params.outcome === 'YES' ? 0 : 1,
    shares: roundTo(params.shares, 4),
    targetPrice: params.targetPrice,
    referencePrice: params.referencePrice,
    tokenPrice: params.tokenPrice,
    midPrice: params.midPrice,
    fairValue: params.fairValue,
    edgeAmount: roundTo(params.edgeAmount, 6),
    combinedBid: params.orderbook.combined.combinedBid,
    combinedAsk: params.orderbook.combined.combinedAsk,
    combinedMid: params.orderbook.combined.combinedMid,
    combinedDiscount: params.orderbook.combined.combinedDiscount,
    combinedPremium: params.orderbook.combined.combinedPremium,
    fillRatio: params.fillRatio,
    capitalClamp: params.capitalClamp,
    priceMultiplier: params.priceMultiplier,
    urgency: params.urgency,
    reduceOnly: params.reduceOnly,
    reason: params.reason,
  };
}

function mergeSignals(signals: StrategySignal[]): StrategySignal[] {
  const byOutcomeAction = new Map<string, StrategySignal>();

  for (const signal of signals) {
    const key = `${signal.outcome}:${signal.action}`;
    const existing = byOutcomeAction.get(key);
    if (!existing) {
      byOutcomeAction.set(key, signal);
      continue;
    }

    if (
      signal.priority > existing.priority ||
      (signal.priority === existing.priority && signal.edgeAmount > existing.edgeAmount)
    ) {
      byOutcomeAction.set(key, signal);
    }
  }

  return Array.from(byOutcomeAction.values());
}

function takeTopSignals(signals: StrategySignal[], maxSignals: number): StrategySignal[] {
  return [...signals]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      if (left.reduceOnly !== right.reduceOnly) {
        return left.reduceOnly ? -1 : 1;
      }
      return right.edgeAmount - left.edgeAmount;
    })
    .slice(0, Math.max(1, maxSignals));
}

function getBookForOutcome(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome
): TokenBookSnapshot {
  return outcome === 'YES' ? snapshot.yes : snapshot.no;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatPrice(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}
