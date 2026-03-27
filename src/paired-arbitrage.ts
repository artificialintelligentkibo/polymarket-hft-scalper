import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

const ESTIMATED_SETTLEMENT_FEE = 0.02;
export const MIN_CLOB_ORDER_NOTIONAL_USD = 1;
export const MIN_CLOB_ORDER_SHARES = 5;
const PENDING_HARD_STOP_PROTECTION_MS = 10_000;

export interface PairedArbConfig {
  enabled: boolean;
  minNetEdge: number;
  maxPairCost: number;
  targetBalanceRatio: number;
  balanceTolerance: number;
  maxPositionPerSide: number;
  minSharesPerLeg: number;
  maxSharesPerLeg: number;
  cooldownMs: number;
  requireBothSidesLiquidity: boolean;
  minDepthPerSide: number;
  asyncEnabled: boolean;
  asyncMaxEntryPrice: number;
  asyncMinEdge: number;
  asyncMaxWaitMs: number;
}

export interface PairPosition {
  marketId: string;
  yesShares: number;
  noShares: number;
  yesCostBasis: number;
  noCostBasis: number;
  combinedCostBasis: number;
  pairedShares: number;
  unpairedShares: number;
  guaranteedPayout: number;
  guaranteedProfit: number;
  createdAt: number;
  lastEntryAt: number;
}

interface PairPositionMeta {
  createdAt: number;
  lastEntryAt: number;
}

export class PairedArbitrageEngine {
  private readonly positions = new Map<string, PairPosition>();
  private readonly metadata = new Map<string, PairPositionMeta>();
  private readonly pendingProtectionUntilMs = new Map<string, number>();

  /**
   * Generates paired entry or rebalance signals when YES + NO is cheaply mispriced.
   */
  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: PairedArbConfig;
    blockedOutcomes?: ReadonlySet<Outcome>;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config, blockedOutcomes } = params;
    if (!config.enabled) {
      return [];
    }

    const bestAskYes = orderbook.yes.bestAsk;
    const bestAskNo = orderbook.no.bestAsk;
    if (
      bestAskYes === null ||
      bestAskNo === null ||
      bestAskYes <= 0 ||
      bestAskNo <= 0
    ) {
      return [];
    }

    const position = this.resolvePosition(market.marketId, positionManager);
    const nowMs = Date.now();
    if (position && config.cooldownMs > 0 && nowMs - position.lastEntryAt < config.cooldownMs) {
      return [];
    }

    const combinedAsk = roundTo(bestAskYes + bestAskNo, 6);
    const netEdge = roundTo(1 - combinedAsk - ESTIMATED_SETTLEMENT_FEE, 6);

    const signals: StrategySignal[] = [];
    const syncEligible =
      combinedAsk < config.maxPairCost &&
      (!config.requireBothSidesLiquidity ||
        (orderbook.yes.depthNotionalAsk >= config.minDepthPerSide &&
          orderbook.no.depthNotionalAsk >= config.minDepthPerSide)) &&
      netEdge >= config.minNetEdge;

    if (syncEligible) {
      const legSizes = this.calculateLegSizes({
        position,
        bestAskYes,
        bestAskNo,
        depthYes: orderbook.yes.depthSharesAsk,
        depthNo: orderbook.no.depthSharesAsk,
        config,
      });

      let yesShares = legSizes.yesShares;
      let noShares = legSizes.noShares;

      if (blockedOutcomes?.has('YES')) {
        yesShares = 0;
      }
      if (blockedOutcomes?.has('NO')) {
        noShares = 0;
      }

      if (yesShares > 0 && noShares === 0 && (position?.noShares ?? 0) <= 0) {
        return [];
      }
      if (noShares > 0 && yesShares === 0 && (position?.yesShares ?? 0) <= 0) {
        return [];
      }

      const aggressiveOutcome =
        yesShares > 0 && noShares > 0
          ? bestAskYes <= bestAskNo
            ? 'YES'
            : 'NO'
          : null;
      if (yesShares > 0) {
        const signalType =
          noShares > 0 ? 'PAIRED_ARB_BUY_YES' : 'PAIRED_ARB_REBALANCE';
        signals.push(
          buildPairedSignal({
            market,
            orderbook,
            signalType,
            outcome: 'YES',
            shares: yesShares,
            targetPrice: bestAskYes,
            edgeAmount: netEdge,
            priority: aggressiveOutcome === 'YES' ? 501 : 500,
            urgency: yesShares > 0 && noShares > 0 ? 'cross' : 'improve',
            reason:
              noShares > 0
                ? `YES + NO ask ${combinedAsk.toFixed(4)} leaves ${netEdge.toFixed(4)} net paired edge`
                : `Rebalancing YES inventory to restore paired arb ratio at ${bestAskYes.toFixed(4)}`,
          })
        );
      }

      if (noShares > 0) {
        const signalType =
          yesShares > 0 ? 'PAIRED_ARB_BUY_NO' : 'PAIRED_ARB_REBALANCE';
        signals.push(
          buildPairedSignal({
            market,
            orderbook,
            signalType,
            outcome: 'NO',
            shares: noShares,
            targetPrice: bestAskNo,
            edgeAmount: netEdge,
            priority: aggressiveOutcome === 'NO' ? 501 : 500,
            urgency: yesShares > 0 && noShares > 0 ? 'cross' : 'improve',
            reason:
              yesShares > 0
                ? `YES + NO ask ${combinedAsk.toFixed(4)} leaves ${netEdge.toFixed(4)} net paired edge`
                : `Rebalancing NO inventory to restore paired arb ratio at ${bestAskNo.toFixed(4)}`,
          })
        );
      }

      if (signals.length === 2) {
        this.setPending(market.marketId);
      }
    }

    if (signals.length > 0) {
      logger.info('Paired arbitrage opportunity detected', {
        marketId: market.marketId,
        combinedAsk,
        netEdge,
        yesShares:
          signals.find((signal) => signal.outcome === 'YES')?.shares ?? 0,
        noShares:
          signals.find((signal) => signal.outcome === 'NO')?.shares ?? 0,
        pairedShares: position?.pairedShares ?? 0,
      });
    }

    if (signals.length > 0) {
      return signals;
    }

    return this.generateAsyncPairingSignals(params);
  }

  /**
   * Generates gabagool-style async pairing entries when a single side becomes cheap.
   */
  generateAsyncPairingSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    config: PairedArbConfig;
    blockedOutcomes?: ReadonlySet<Outcome>;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, config, blockedOutcomes } = params;
    if (!config.enabled || !config.asyncEnabled) {
      return [];
    }

    const position = this.resolvePosition(market.marketId, positionManager);
    const nowMs = Date.now();
    if (
      position &&
      position.unpairedShares > 0 &&
      nowMs - position.lastEntryAt > config.asyncMaxWaitMs
    ) {
      this.pendingProtectionUntilMs.delete(market.marketId);
      return [];
    }

    const signals: StrategySignal[] = [];
    for (const outcome of ['YES', 'NO'] as const) {
      if (blockedOutcomes?.has(outcome)) {
        continue;
      }

      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestAsk = book.bestAsk;
      if (
        bestAsk === null ||
        bestAsk <= 0 ||
        bestAsk > config.asyncMaxEntryPrice ||
        book.depthNotionalAsk < config.minDepthPerSide
      ) {
        continue;
      }

      const fairValue = estimateAsyncFairValue(orderbook, outcome);
      const edge = fairValue === null ? null : roundTo(fairValue - bestAsk, 6);
      if (edge === null || edge < config.asyncMinEdge) {
        continue;
      }

      const currentShares = outcome === 'YES' ? position?.yesShares ?? 0 : position?.noShares ?? 0;
      const oppositeShares = outcome === 'YES' ? position?.noShares ?? 0 : position?.yesShares ?? 0;
      const currentCostBasis =
        outcome === 'YES' ? position?.yesCostBasis ?? 0 : position?.noCostBasis ?? 0;
      const oppositeCostBasis =
        outcome === 'YES' ? position?.noCostBasis ?? 0 : position?.yesCostBasis ?? 0;
      const projectedLegCost = computeWeightedAverage(
        currentCostBasis,
        currentShares,
        bestAsk,
        Math.max(0, desiredAsyncSizingHint(oppositeShares, currentShares, config, bestAsk))
      );
      const projectedOppositePrice =
        oppositeShares > 0
          ? oppositeCostBasis
          : outcome === 'YES'
            ? orderbook.no.midPrice ?? orderbook.no.bestAsk
            : orderbook.yes.midPrice ?? orderbook.yes.bestAsk;
      if (
        projectedOppositePrice !== null &&
        Number.isFinite(projectedOppositePrice) &&
        roundTo(projectedLegCost + projectedOppositePrice, 6) > config.maxPairCost
      ) {
        continue;
      }
      const capShares = roundTo(
        Math.max(
          0,
          Math.min(
            config.maxSharesPerLeg,
            config.maxPositionPerSide - currentShares,
            book.depthSharesAsk
          )
        ),
        4
      );
      const minimumShares = resolveMinimumTradableShares(bestAsk, config.minSharesPerLeg);
      const desiredShares = desiredAsyncSizingHint(oppositeShares, currentShares, config, bestAsk);
      const shares = roundTo(clamp(desiredShares, 0, capShares), 4);
      if (shares < minimumShares || !meetsClobMinimums(shares, bestAsk)) {
        continue;
      }

      if (!this.canImprovePairCost(position, outcome, shares, bestAsk, config)) {
        continue;
      }

      signals.push(
        buildPairedSignal({
          market,
          orderbook,
          signalType: outcome === 'YES' ? 'PAIRED_ARB_BUY_YES' : 'PAIRED_ARB_BUY_NO',
          outcome,
          shares,
          targetPrice: bestAsk,
          edgeAmount: edge,
          priority: oppositeShares > currentShares ? 495 : 490,
          urgency: oppositeShares > currentShares ? 'cross' : 'improve',
          reason:
            oppositeShares > currentShares
              ? `Async pairing completion for ${outcome} at ${bestAsk.toFixed(4)} with projected pair cost below ${config.maxPairCost.toFixed(4)}`
              : `Async pairing starter for ${outcome} at ${bestAsk.toFixed(4)} (${edge.toFixed(4)} below async fair value)`,
        })
      );
    }

    if (signals.length > 0) {
      logger.info('Async paired arbitrage opportunity detected', {
        marketId: market.marketId,
        signalCount: signals.length,
        outcomes: signals.map((signal) => signal.outcome),
      });
    }

    return signals;
  }

  /**
   * Calculates per-leg sizes while preserving pair economics and balance.
   */
  private calculateLegSizes(params: {
    position: PairPosition | undefined;
    bestAskYes: number;
    bestAskNo: number;
    depthYes: number;
    depthNo: number;
    config: PairedArbConfig;
  }): { yesShares: number; noShares: number } {
    const { position, bestAskYes, bestAskNo, depthYes, depthNo, config } = params;
    const currentYes = position?.yesShares ?? 0;
    const currentNo = position?.noShares ?? 0;
    const minYesShares = resolveMinimumTradableShares(bestAskYes, config.minSharesPerLeg);
    const minNoShares = resolveMinimumTradableShares(bestAskNo, config.minSharesPerLeg);
    const targetNo = currentYes * config.targetBalanceRatio;
    const targetYes = currentNo * config.targetBalanceRatio;
    const imbalanceRatio =
      Math.max(currentYes, currentNo) > 0
        ? Math.abs(currentYes - currentNo) / Math.max(currentYes, currentNo)
        : 0;

    const capYes = roundTo(
      Math.max(0, Math.min(config.maxSharesPerLeg, config.maxPositionPerSide - currentYes, depthYes)),
      4
    );
    const capNo = roundTo(
      Math.max(0, Math.min(config.maxSharesPerLeg, config.maxPositionPerSide - currentNo, depthNo)),
      4
    );

    if (imbalanceRatio > config.balanceTolerance) {
      if (currentYes < targetYes) {
        const neededShares = roundTo(targetYes - currentYes, 4);
        const shares = clamp(Math.max(neededShares, minYesShares), 0, capYes);
        if (
          shares >= minYesShares &&
          this.canImprovePairCost(position, 'YES', shares, bestAskYes, config)
        ) {
          return { yesShares: roundTo(shares, 4), noShares: 0 };
        }
      }

      if (currentNo < targetNo) {
        const neededShares = roundTo(targetNo - currentNo, 4);
        const shares = clamp(Math.max(neededShares, minNoShares), 0, capNo);
        if (
          shares >= minNoShares &&
          this.canImprovePairCost(position, 'NO', shares, bestAskNo, config)
        ) {
          return { yesShares: 0, noShares: roundTo(shares, 4) };
        }
      }
    }

    const pairShares = roundTo(Math.min(capYes, capNo), 4);
    const minPairShares = roundTo(Math.max(minYesShares, minNoShares), 4);
    if (pairShares < minPairShares) {
      return { yesShares: 0, noShares: 0 };
    }

    if (!this.canImprovePairCost(position, 'YES', pairShares, bestAskYes, config)) {
      return { yesShares: 0, noShares: 0 };
    }
    if (!this.canImprovePairCost(position, 'NO', pairShares, bestAskNo, config)) {
      return { yesShares: 0, noShares: 0 };
    }

    return {
      yesShares: pairShares,
      noShares: pairShares,
    };
  }

  /**
   * Updates the paired state after a confirmed buy fill.
   */
  applyFill(params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    shares: number;
    price: number;
  }): void {
    const current = this.positions.get(params.marketId) ?? createEmptyPairPosition(params.marketId);
    const outcomeKey = params.outcome === 'YES' ? 'yesShares' : 'noShares';
    const costKey = params.outcome === 'YES' ? 'yesCostBasis' : 'noCostBasis';
    const previousShares = current[outcomeKey];
    const nextShares = roundTo(previousShares + params.shares, 4);
    const nextCostBasis =
      nextShares > 0
        ? (current[costKey] * previousShares + params.price * params.shares) / nextShares
        : 0;

    current[outcomeKey] = nextShares;
    current[costKey] = roundTo(nextCostBasis, 6);
    current.createdAt = current.createdAt || Date.now();
    current.lastEntryAt = Date.now();

    const normalized = finalizePairPosition(current);
    this.positions.set(params.marketId, normalized);
    this.metadata.set(params.marketId, {
      createdAt: normalized.createdAt,
      lastEntryAt: normalized.lastEntryAt,
    });
    if (normalized.unpairedShares > 0) {
      this.pendingProtectionUntilMs.set(
        params.marketId,
        Date.now() + PENDING_HARD_STOP_PROTECTION_MS
      );
    } else {
      this.pendingProtectionUntilMs.delete(params.marketId);
    }
  }

  /**
   * Estimates paired vs directional PnL using the latest mark prices.
   */
  getPositionPnL(
    marketId: string,
    currentMidYes: number,
    currentMidNo: number
  ): {
    guaranteedProfit: number;
    atRiskPnL: number;
    totalEstimatedPnL: number;
  } {
    const position = this.positions.get(marketId);
    if (!position) {
      return {
        guaranteedProfit: 0,
        atRiskPnL: 0,
        totalEstimatedPnL: 0,
      };
    }

    const unpairedYes = Math.max(0, position.yesShares - position.pairedShares);
    const unpairedNo = Math.max(0, position.noShares - position.pairedShares);
    const atRiskPnl =
      unpairedYes * (currentMidYes - position.yesCostBasis) +
      unpairedNo * (currentMidNo - position.noCostBasis);

    return {
      guaranteedProfit: roundTo(position.guaranteedProfit, 4),
      atRiskPnL: roundTo(atRiskPnl, 4),
      totalEstimatedPnL: roundTo(position.guaranteedProfit + atRiskPnl, 4),
    };
  }

  protectSignals(params: {
    marketId: string;
    positionManager: PositionManager;
    signals: readonly StrategySignal[];
  }): StrategySignal[] {
    const position = this.resolvePosition(params.marketId, params.positionManager);
    return params.signals
      .map((signal) => {
        if (
          signal.marketId === params.marketId &&
          signal.signalType === 'HARD_STOP' &&
          this.isPairedArbPending(params.marketId)
        ) {
          logger.info('HARD_STOP deferred for pending paired arb position', {
            marketId: params.marketId,
            outcome: signal.outcome,
            shares: signal.shares,
          });
          return null;
        }

        if (!position || position.pairedShares <= 0) {
          return signal;
        }

        if (signal.marketId !== params.marketId || signal.action !== 'SELL') {
          return signal;
        }

        const protectedCapacity = this.getProtectedSellCapacity(position, signal.outcome);
        if (protectedCapacity <= 0) {
          return null;
        }

        if (protectedCapacity >= signal.shares) {
          return signal;
        }

        return {
          ...signal,
          shares: roundTo(protectedCapacity, 4),
          reason: `${signal.reason} | paired-arb protected ${position.pairedShares.toFixed(4)} matched shares`,
        };
      })
      .filter((signal): signal is StrategySignal => signal !== null);
  }

  isPairedArbPending(marketId: string, nowMs = Date.now()): boolean {
    const pendingUntilMs = this.pendingProtectionUntilMs.get(marketId);
    if (!pendingUntilMs) {
      return false;
    }

    if (pendingUntilMs <= nowMs) {
      this.pendingProtectionUntilMs.delete(marketId);
      return false;
    }

    return true;
  }

  setPending(marketId: string): void {
    this.pendingProtectionUntilMs.set(
      marketId,
      Date.now() + PENDING_HARD_STOP_PROTECTION_MS
    );
  }

  private resolvePosition(marketId: string, positionManager: PositionManager): PairPosition | undefined {
    const yesShares = positionManager.getShares('YES');
    const noShares = positionManager.getShares('NO');
    if (yesShares <= 0 && noShares <= 0) {
      const existing = this.positions.get(marketId);
      if (existing) {
        this.positions.delete(marketId);
      }
      this.pendingProtectionUntilMs.delete(marketId);
      return undefined;
    }

    const metadata = this.metadata.get(marketId);
    const next = finalizePairPosition({
      marketId,
      yesShares,
      noShares,
      yesCostBasis: positionManager.getAvgEntryPrice('YES'),
      noCostBasis: positionManager.getAvgEntryPrice('NO'),
      combinedCostBasis: 0,
      pairedShares: 0,
      unpairedShares: 0,
      guaranteedPayout: 0,
      guaranteedProfit: 0,
      createdAt: metadata?.createdAt ?? Date.now(),
      lastEntryAt: metadata?.lastEntryAt ?? 0,
    });
    this.positions.set(marketId, next);
    if (next.unpairedShares <= 0) {
      this.pendingProtectionUntilMs.delete(marketId);
    }
    return next;
  }

  private canImprovePairCost(
    position: PairPosition | undefined,
    outcome: Outcome,
    shares: number,
    price: number,
    config: PairedArbConfig
  ): boolean {
    if (shares <= 0 || !meetsClobMinimums(shares, price)) {
      return false;
    }

    const nextYesCost =
      outcome === 'YES'
        ? computeWeightedAverage(position?.yesCostBasis ?? 0, position?.yesShares ?? 0, price, shares)
        : position?.yesCostBasis ?? 0;
    const nextNoCost =
      outcome === 'NO'
        ? computeWeightedAverage(position?.noCostBasis ?? 0, position?.noShares ?? 0, price, shares)
        : position?.noCostBasis ?? 0;

    if ((position?.yesShares ?? 0) <= 0 && (position?.noShares ?? 0) <= 0) {
      return nextYesCost + nextNoCost <= config.maxPairCost;
    }

    if (outcome === 'YES' && (position?.noShares ?? 0) > 0) {
      return nextYesCost + (position?.noCostBasis ?? 0) <= config.maxPairCost;
    }

    if (outcome === 'NO' && (position?.yesShares ?? 0) > 0) {
      return (position?.yesCostBasis ?? 0) + nextNoCost <= config.maxPairCost;
    }

    return false;
  }

  private getProtectedSellCapacity(position: PairPosition, outcome: Outcome): number {
    const totalShares = outcome === 'YES' ? position.yesShares : position.noShares;
    return roundTo(Math.max(0, totalShares - position.pairedShares), 4);
  }
}

function buildPairedSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  signalType: StrategySignal['signalType'];
  priority: number;
  outcome: Outcome;
  shares: number;
  targetPrice: number;
  edgeAmount: number;
  urgency: StrategySignal['urgency'];
  reason: string;
}): StrategySignal {
  const book = params.outcome === 'YES' ? params.orderbook.yes : params.orderbook.no;

  return {
    marketId: params.market.marketId,
    marketTitle: params.market.title,
    signalType: params.signalType,
    priority: params.priority,
    generatedAt: Date.now(),
    action: 'BUY',
    outcome: params.outcome,
    outcomeIndex: params.outcome === 'YES' ? 0 : 1,
    shares: roundTo(params.shares, 4),
    targetPrice: roundTo(params.targetPrice, 6),
    referencePrice: params.orderbook.combined.combinedAsk,
    tokenPrice: book.lastTradePrice ?? params.targetPrice,
    midPrice: book.midPrice,
    fairValue: null,
    edgeAmount: roundTo(params.edgeAmount, 6),
    combinedBid: params.orderbook.combined.combinedBid,
    combinedAsk: params.orderbook.combined.combinedAsk,
    combinedMid: params.orderbook.combined.combinedMid,
    combinedDiscount: params.orderbook.combined.combinedDiscount,
    combinedPremium: params.orderbook.combined.combinedPremium,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: params.urgency,
    reduceOnly: false,
    reason: params.reason,
  };
}

export function resolveMinimumTradableShares(
  price: number,
  configuredMinShares: number
): number {
  if (!Number.isFinite(price) || price <= 0) {
    return roundTo(Math.max(configuredMinShares, MIN_CLOB_ORDER_SHARES), 4);
  }

  const notionalFloorShares = roundTo(
    Math.ceil((MIN_CLOB_ORDER_NOTIONAL_USD / price) * 10_000) / 10_000,
    4
  );
  return roundTo(
    Math.max(configuredMinShares, MIN_CLOB_ORDER_SHARES, notionalFloorShares),
    4
  );
}

export function meetsClobMinimums(shares: number, price: number): boolean {
  if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) {
    return false;
  }

  return (
    shares >= MIN_CLOB_ORDER_SHARES &&
    roundTo(shares * price, 6) >= MIN_CLOB_ORDER_NOTIONAL_USD
  );
}

function computeWeightedAverage(
  currentPrice: number,
  currentShares: number,
  nextPrice: number,
  nextShares: number
): number {
  const totalShares = currentShares + nextShares;
  if (totalShares <= 0) {
    return 0;
  }

  return roundTo((currentPrice * currentShares + nextPrice * nextShares) / totalShares, 6);
}

function createEmptyPairPosition(marketId: string): PairPosition {
  return {
    marketId,
    yesShares: 0,
    noShares: 0,
    yesCostBasis: 0,
    noCostBasis: 0,
    combinedCostBasis: 0,
    pairedShares: 0,
    unpairedShares: 0,
    guaranteedPayout: 0,
    guaranteedProfit: 0,
    createdAt: Date.now(),
    lastEntryAt: 0,
  };
}

function finalizePairPosition(position: PairPosition): PairPosition {
  const pairedShares = roundTo(Math.min(position.yesShares, position.noShares), 4);
  const combinedCostBasis = roundTo(position.yesCostBasis + position.noCostBasis, 6);
  const guaranteedPayout = roundTo(pairedShares, 4);
  const guaranteedProfit = roundTo(
    pairedShares * Math.max(0, 1 - combinedCostBasis - ESTIMATED_SETTLEMENT_FEE),
    4
  );

  return {
    ...position,
    pairedShares,
    combinedCostBasis,
    unpairedShares: roundTo(Math.abs(position.yesShares - position.noShares), 4),
    guaranteedPayout,
    guaranteedProfit,
  };
}

function estimateAsyncFairValue(
  orderbook: MarketOrderbookSnapshot,
  outcome: Outcome
): number | null {
  const own = outcome === 'YES' ? orderbook.yes : orderbook.no;
  const opposite = outcome === 'YES' ? orderbook.no : orderbook.yes;
  if (own.midPrice !== null && opposite.midPrice !== null) {
    const total = own.midPrice + opposite.midPrice;
    if (Number.isFinite(total) && total > 0) {
      return roundTo(own.midPrice / total, 6);
    }
  }

  if (opposite.midPrice !== null) {
    return roundTo(1 - opposite.midPrice, 6);
  }

  if (opposite.bestAsk !== null) {
    return roundTo(1 - opposite.bestAsk, 6);
  }

  return own.midPrice ?? own.bestAsk ?? own.lastTradePrice;
}

function desiredAsyncSizingHint(
  oppositeShares: number,
  currentShares: number,
  config: PairedArbConfig,
  bestAsk: number
): number {
  const minimumShares = resolveMinimumTradableShares(bestAsk, config.minSharesPerLeg);
  return roundTo(
    oppositeShares > currentShares
      ? Math.max(minimumShares, oppositeShares - currentShares)
      : minimumShares,
    4
  );
}
