import type { BinanceEdgeAssessment } from './binance-edge.js';
import { config, isDynamicQuotingEnabled, type AppConfig } from './config.js';
import type { DynamicCompounder } from './dynamic-compounder.js';
import { applyEVKellyFilter } from './ev-kelly.js';
import { LatencyMomentumEngine } from './latency-momentum.js';
import type { MarketOrderbookSnapshot, Outcome, TokenBookSnapshot } from './clob-fetcher.js';
import { logger } from './logger.js';
import { LotteryEngine } from './lottery-engine.js';
import type { MarketCandidate } from './monitor.js';
import { PairedArbitrageEngine } from './paired-arbitrage.js';
import type { PositionManager } from './position-manager.js';
import type { SkippedSignalRecord } from './runtime-status.js';
import {
  clampProductTestShares,
  getEffectiveStrategyConfig,
  resolveProductTestUrgency,
} from './product-test-mode.js';
import type { RiskAssessment } from './risk-manager.js';
import type { SniperStatsSnapshot } from './runtime-status.js';
import { SniperEngine, type SniperCandidate } from './sniper-engine.js';
import { resolveStrategyLayer, type StrategySignal } from './strategy-types.js';
import { clamp, OUTCOMES, roundTo } from './utils.js';

export interface SizeCalculationResult {
  shares: number;
  priceMultiplier: number;
  fillRatio: number;
  capitalClamp: number;
}

export interface FairValueBinanceAdjustment {
  direction: 'UP' | 'DOWN' | 'FLAT';
  movePct: number;
}

interface FairValueBuyCadenceState {
  count: number;
  lastExecutedAtMs: number;
  expiresAtMs: number;
}

interface InventoryRebalanceBlockState {
  blockedUntilMs: number;
  expiresAtMs: number;
}

interface EntryGuardEvaluation {
  multiplier: number;
  reason: 'ok' | 'missing_entry_ask' | 'spread_too_wide';
  spread: number | null;
  spreadThreshold: number;
}

const SMOOTHED_FAIR_VALUE_TTL_MS = 15 * 60_000;

export class SignalScalper {
  private readonly fairValueBuyCadence = new Map<string, FairValueBuyCadenceState>();
  private readonly inventoryRebalanceBlocks = new Map<string, InventoryRebalanceBlockState>();
  private readonly pairedArbEngine = new PairedArbitrageEngine();
  private readonly latencyMomentumEngine = new LatencyMomentumEngine();
  private readonly sniperEngine: SniperEngine;
  private readonly lotteryEngine: LotteryEngine;
  private readonly recentSkippedSignals: SkippedSignalRecord[] = [];
  private readonly smoothedScalperFV = new Map<string, number>();
  private readonly smoothedScalperFvSeenAtMs = new Map<string, number>();
  private readonly currentTickFairValueCache = new Map<string, number | null>();
  private compounder: DynamicCompounder | null = null;

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    lotteryEngine?: LotteryEngine
  ) {
    this.sniperEngine = new SniperEngine(runtimeConfig);
    this.lotteryEngine = lotteryEngine ?? new LotteryEngine(runtimeConfig);
  }

  /** Attach a DynamicCompounder for balance-aware sizing (optional). */
  setCompounder(compounder: DynamicCompounder): void {
    this.compounder = compounder;
    this.sniperEngine.setCompounder(compounder);
  }

  /**
   * Returns the compounding multiplier for legacy scalper calculateTradeSize() calls.
   * Returns 1.0 when compounding is disabled (no-op).
   */
  private getCompoundingMultiplier(referencePrice: number): number {
    if (!this.compounder?.enabled) return 1.0;
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    return this.compounder.getScalperSizeMultiplier(strategy.baseOrderShares, referencePrice);
  }

  recordExecution(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    filledShares?: number;
    fillPrice?: number;
    executedAtMs?: number;
  }): void {
    const executedAtMs = params.executedAtMs ?? Date.now();
    this.pruneFairValueControlState(executedAtMs);
    const key = buildFairValueControlKey(params.market, params.signal.outcome);
    const expiresAtMs = resolveFairValueControlExpiryMs(params.market, executedAtMs);

    if (
      params.signal.action === 'BUY' &&
      (params.signal.signalType === 'PAIRED_ARB_BUY_YES' ||
        params.signal.signalType === 'PAIRED_ARB_BUY_NO' ||
        params.signal.signalType === 'PAIRED_ARB_REBALANCE')
    ) {
      const filledShares = params.filledShares ?? params.signal.shares;
      const fillPrice =
        params.fillPrice ??
        params.signal.targetPrice ??
        params.signal.referencePrice ??
        params.signal.tokenPrice ??
        0.5;
      if (filledShares > 0) {
        this.pairedArbEngine.applyFill({
          marketId: params.market.marketId,
          outcome: params.signal.outcome,
          shares: filledShares,
          price: fillPrice,
        });
      }
    }

    if (
      params.signal.action === 'BUY' &&
      params.signal.signalType === 'LATENCY_MOMENTUM_BUY'
    ) {
      this.latencyMomentumEngine.recordExecution({
        marketId: params.market.marketId,
      });
    }

    this.sniperEngine.recordExecution(params);

    if (params.signal.signalType === 'FAIR_VALUE_BUY' && params.signal.action === 'BUY') {
      const current = this.fairValueBuyCadence.get(key);
      this.fairValueBuyCadence.set(key, {
        count: (current?.count ?? 0) + 1,
        lastExecutedAtMs: executedAtMs,
        expiresAtMs,
      });
      return;
    }

    if (
      params.signal.signalType === 'INVENTORY_REBALANCE' &&
      params.signal.action === 'SELL' &&
      this.runtimeConfig.strategy.inventoryRebalanceFvBlockMs > 0
    ) {
      this.inventoryRebalanceBlocks.set(key, {
        blockedUntilMs:
          executedAtMs + this.runtimeConfig.strategy.inventoryRebalanceFvBlockMs,
        expiresAtMs,
      });
    }
  }

  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    riskAssessment: RiskAssessment;
    binanceFairValueAdjustment?: FairValueBinanceAdjustment;
    binanceAssessment?: BinanceEdgeAssessment;
    binanceVelocityPctPerSec?: number | null;
    sniperEntryOverride?: readonly StrategySignal[] | null;
    now?: Date;
  }): StrategySignal[] {
    this.recentSkippedSignals.splice(0, this.recentSkippedSignals.length);
    this.currentTickFairValueCache.clear();
    const now = params.now ?? new Date();
    const {
      market,
      orderbook,
      positionManager,
      riskAssessment,
      binanceFairValueAdjustment,
      binanceAssessment,
      binanceVelocityPctPerSec,
      sniperEntryOverride,
    } = params;
    this.pruneFairValueControlState(now.getTime());
    this.pruneSmoothedFairValues(now.getTime());
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    const pairedProtectionEnabled =
      this.runtimeConfig.PAIRED_ARB_ENABLED &&
      (this.runtimeConfig.ENTRY_STRATEGY === 'PAIRED_ARBITRAGE' ||
        this.runtimeConfig.ENTRY_STRATEGY === 'ALL');

    const filteredForcedSignals = this.filterForcedSignalsForSniper(
      market,
      riskAssessment.forcedSignals
    );
    if (filteredForcedSignals.length > 0) {
      const protectedForcedSignals = pairedProtectionEnabled
        ? this.pairedArbEngine.protectSignals({
            marketId: market.marketId,
            positionManager,
            signals: filteredForcedSignals,
          })
        : [...filteredForcedSignals];
      const forcedSelection = takeTopSignals(protectedForcedSignals, strategy.maxSignalsPerTick);
      for (const skippedSignal of forcedSelection.skipped) {
        this.recordSkippedSignal(skippedSignal, 'MAX_SIGNALS', 'takeTopSignals limit');
      }
      return forcedSelection.selected;
    }

    const lotteryExitSignals = this.runtimeConfig.lottery.enabled
      ? this.lotteryEngine.generateExitSignals({
          market,
          orderbook,
          positionManager,
          nowMs: now.getTime(),
          config: this.runtimeConfig.lottery,
        })
      : [];

    if (!this.runtimeConfig.ENABLE_SIGNAL) {
      return lotteryExitSignals;
    }

    const sniperExitSignals = this.runtimeConfig.sniper.enabled
      ? this.sniperEngine.generateExitSignals({
          market,
          orderbook,
          positionManager,
          binanceAssessment,
          config: this.runtimeConfig.sniper,
          nowMs: now.getTime(),
        })
      : [];
    if (sniperExitSignals.length > 0 || lotteryExitSignals.length > 0) {
      return [...sniperExitSignals, ...lotteryExitSignals];
    }

    const sniperSignals: StrategySignal[] = this.runtimeConfig.sniper.enabled
      ? sniperEntryOverride
        ? [...sniperEntryOverride]
        : this.sniperEngine.generateSignals({
            market,
            orderbook,
            positionManager,
            binanceAssessment,
            binanceVelocityPctPerSec,
            config: this.runtimeConfig.sniper,
            blockedOutcomes: riskAssessment.blockedOutcomes,
            nowMs: now.getTime(),
          })
      : [];
    if (sniperSignals.length > 0) {
      return [...sniperSignals];
    }

    if (
      this.runtimeConfig.SNIPER_MODE_ENABLED &&
      this.sniperEngine.hasActiveEntryForMarket(market.marketId)
    ) {
      return [];
    }

    if (!this.isEntryWindowOpen(market, now)) {
      return [];
    }

    const entryStrategy = this.runtimeConfig.ENTRY_STRATEGY;
    const groups: StrategySignal[][] = [];
    const legacySignals = [
      ...this.getCombinedDiscountSignals(market, orderbook, positionManager, riskAssessment),
      ...this.getExtremeSignals(market, orderbook, positionManager, riskAssessment),
      ...this.getFairValueSignals(
        market,
        orderbook,
        positionManager,
        riskAssessment,
        now,
        binanceFairValueAdjustment
      ),
    ];

    if (entryStrategy === 'LEGACY' || entryStrategy === 'ALL') {
      groups.push(legacySignals);
    } else {
      groups.push(legacySignals.filter((signal) => signal.reduceOnly));
    }

    groups.push(
      this.getInventoryRebalanceSignals(market, orderbook, positionManager, riskAssessment)
    );

    if (
      (entryStrategy === 'PAIRED_ARBITRAGE' || entryStrategy === 'ALL') &&
      this.runtimeConfig.PAIRED_ARB_ENABLED
    ) {
      groups.push(
        this.pairedArbEngine.generateSignals({
          market,
          orderbook,
          positionManager,
          config: this.runtimeConfig.pairedArbitrage,
          blockedOutcomes: riskAssessment.blockedOutcomes,
        })
      );
    }

    if (
      (entryStrategy === 'LATENCY_MOMENTUM' || entryStrategy === 'ALL') &&
      this.runtimeConfig.LATENCY_MOMENTUM_ENABLED &&
      !this.runtimeConfig.SNIPER_MODE_ENABLED
    ) {
      groups.push(
        this.latencyMomentumEngine.generateSignals({
          market,
          orderbook,
          positionManager,
          binanceAssessment,
          config: this.runtimeConfig.latencyMomentum,
          blockedOutcomes: riskAssessment.blockedOutcomes,
        })
      );
    }

    const protectedSignals = pairedProtectionEnabled
      ? this.pairedArbEngine.protectSignals({
          marketId: market.marketId,
          positionManager,
          signals: groups.flat(),
        })
      : groups.flat();
    const flattened = mergeSignals(protectedSignals);
    const evFilteredSignals = this.applyEVKellySignals(flattened);
    const topSelection = takeTopSignals(evFilteredSignals, strategy.maxSignalsPerTick);
    for (const skippedSignal of topSelection.skipped) {
      this.recordSkippedSignal(skippedSignal, 'MAX_SIGNALS', 'takeTopSignals limit');
    }
    return transformSignalsForMarketMaker(topSelection.selected, this.runtimeConfig);
  }

  drainSkippedSignals(): SkippedSignalRecord[] {
    const drained = [...this.recentSkippedSignals];
    this.recentSkippedSignals.splice(0, this.recentSkippedSignals.length);
    return drained;
  }

  getSniperStats(): SniperStatsSnapshot {
    return this.sniperEngine.getStats();
  }

  hasActiveSniperEntryForMarket(marketId: string): boolean {
    return this.sniperEngine.hasActiveEntryForMarket(marketId);
  }

  clearSniperEntry(marketId: string, outcome: Outcome): void {
    this.sniperEngine.clearActiveEntry(marketId, outcome);
  }

  recordFailedSniperExit(params: {
    marketId: string;
    outcome: Outcome;
  }): void {
    this.sniperEngine.recordFailedExit(params);
  }

  evaluateSniperCandidate(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    riskAssessment: RiskAssessment;
    binanceAssessment?: BinanceEdgeAssessment;
    binanceVelocityPctPerSec?: number | null;
    now?: Date;
  }): SniperCandidate | null {
    if (!this.runtimeConfig.sniper.enabled) {
      return null;
    }

    return this.sniperEngine.evaluateEntryCandidate({
      market: params.market,
      orderbook: params.orderbook,
      positionManager: params.positionManager,
      binanceAssessment: params.binanceAssessment,
      binanceVelocityPctPerSec: params.binanceVelocityPctPerSec,
      config: this.runtimeConfig.sniper,
      blockedOutcomes: params.riskAssessment.blockedOutcomes,
      nowMs: params.now?.getTime(),
    });
  }

  selectSniperSignals(
    candidates: readonly SniperCandidate[],
    now: Date = new Date()
  ): StrategySignal[] {
    if (!this.runtimeConfig.sniper.enabled) {
      return [];
    }

    return this.sniperEngine.selectSignals(
      candidates,
      this.runtimeConfig.sniper,
      now.getTime()
    );
  }

  setPairedArbPending(marketId: string): void {
    this.pairedArbEngine.setPending(marketId);
  }

  /**
   * Applies EMA smoothing per market/outcome FV stream.
   * The smoothing state is keyed by market/outcome/variant so each strategy path
   * carries its own prior, while the per-tick cache prevents multiple updates
   * from the same orderbook snapshot inside one generateSignals pass.
   */
  private smoothFairValue(
    marketId: string,
    outcome: Outcome,
    rawFairValue: number | null,
    variant: string = 'base',
    nowMs: number = Date.now()
  ): number | null {
    if (rawFairValue === null || !this.runtimeConfig.BAYESIAN_FV_ENABLED) {
      return rawFairValue;
    }

    const key = `${marketId}:${outcome}:${variant}`;
    const cached = this.currentTickFairValueCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const prev = this.smoothedScalperFV.get(key);
    const alpha = this.runtimeConfig.BAYESIAN_FV_ALPHA;
    const smoothed =
      prev === undefined || !Number.isFinite(prev)
        ? rawFairValue
        : roundTo(alpha * rawFairValue + (1 - alpha) * prev, 6);
    const clamped = clamp(smoothed, 0.001, 0.999);

    this.smoothedScalperFV.set(key, clamped);
    this.smoothedScalperFvSeenAtMs.set(key, nowMs);
    this.currentTickFairValueCache.set(key, clamped);
    logger.debug('Bayesian FV smoothing applied', {
      key,
      rawFairValue,
      prevSmoothedFV: prev ?? null,
      newSmoothedFV: clamped,
      alpha,
    });

    return clamped;
  }

  private getCombinedDiscountSignals(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    riskAssessment: RiskAssessment
  ): StrategySignal[] {
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    const upAsk = orderbook.yes.bestAsk;
    const downAsk = orderbook.no.bestAsk;
    const combinedAsk =
      upAsk !== null && downAsk !== null ? roundTo(upAsk + downAsk, 6) : null;
    const combinedDiscount =
      combinedAsk !== null ? roundTo(1 - combinedAsk, 6) : null;

    logger.debug(
      `combined: market=${market.marketId} upAsk=${formatMaybePrice(upAsk)} downAsk=${formatMaybePrice(
        downAsk
      )} sum=${formatMaybePrice(combinedAsk)} discount=${formatMaybePrice(combinedDiscount)}`
    );

    if (
      combinedDiscount === null ||
      combinedAsk === null ||
      upAsk === null ||
      downAsk === null ||
      upAsk <= 0.01 ||
      downAsk <= 0.01 ||
      combinedDiscount < strategy.minCombinedDiscount
    ) {
      return [];
    }

    const signals: StrategySignal[] = [];
    for (const outcome of OUTCOMES as readonly Outcome[]) {
      if (riskAssessment.blockedOutcomes.has(outcome)) {
        continue;
      }

      const book = getBookForOutcome(orderbook, outcome);
      if (!hasValidEntryAsk(book)) {
        continue;
      }
      const bestAsk = book.bestAsk;
      const rawFairValue = estimateFairValue(orderbook, outcome);
      const fairValue = this.smoothFairValue(market.marketId, outcome, rawFairValue, 'scalper-base');
      const entryGuard = resolveEntryGuardMultiplier(
        book,
        'COMBINED_DISCOUNT_BUY_BOTH',
        this.runtimeConfig
      );
      if (entryGuard.multiplier <= 0) {
        logEntryGuardRejection(market, outcome, 'COMBINED_DISCOUNT_BUY_BOTH', entryGuard);
        continue;
      }

      const size = calculateTradeSize({
        action: 'BUY',
        signalType: 'COMBINED_DISCOUNT_BUY_BOTH',
        edgeAmount: combinedDiscount,
        availableCapacity: positionManager.getAvailableEntryCapacity(outcome, strategy),
        depthShares: book.depthSharesAsk,
        liquidityUsd: market.liquidityUsd,
        price: bestAsk,
        referenceEdge: strategy.minCombinedDiscount,
        runtimeConfig: this.runtimeConfig,
        entryGuardMultiplier: entryGuard.multiplier,
        compoundingMultiplier: this.getCompoundingMultiplier(bestAsk),
      });

      if (size.shares < strategy.minShares) {
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
          fairValue,
          edgeAmount: combinedDiscount,
          priceMultiplier: size.priceMultiplier,
          fillRatio: size.fillRatio,
          capitalClamp: size.capitalClamp,
          urgency: resolveProductTestUrgency('improve', this.runtimeConfig),
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
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    const signals: StrategySignal[] = [];

    for (const outcome of OUTCOMES as readonly Outcome[]) {
      const book = getBookForOutcome(orderbook, outcome);
      const openShares = positionManager.getShares(outcome);
      const rawFairValue = estimateFairValue(orderbook, outcome);
      const fairValue = this.smoothFairValue(market.marketId, outcome, rawFairValue, 'scalper-base');

      if (
        !riskAssessment.blockedOutcomes.has(outcome) &&
        hasValidEntryAsk(book)
      ) {
        const bestAsk = book.bestAsk;
        const entryGuard = resolveEntryGuardMultiplier(book, 'EXTREME_BUY', this.runtimeConfig);
        if (entryGuard.multiplier <= 0) {
          logEntryGuardRejection(market, outcome, 'EXTREME_BUY', entryGuard);
          continue;
        }
        const edge = strategy.extremeBuyThreshold - bestAsk;
        if (edge >= 0) {
          const size = calculateTradeSize({
            action: 'BUY',
            signalType: 'EXTREME_BUY',
            edgeAmount: edge,
            availableCapacity: positionManager.getAvailableEntryCapacity(outcome, strategy),
            depthShares: book.depthSharesAsk,
            liquidityUsd: market.liquidityUsd,
            price: bestAsk,
            referenceEdge: strategy.extremeBuyThreshold,
            runtimeConfig: this.runtimeConfig,
            entryGuardMultiplier: entryGuard.multiplier,
            compoundingMultiplier: this.getCompoundingMultiplier(bestAsk),
          });

          if (size.shares >= strategy.minShares) {
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
                referencePrice: strategy.extremeBuyThreshold,
                tokenPrice: book.lastTradePrice ?? bestAsk,
                midPrice: book.midPrice,
                fairValue,
                edgeAmount: edge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: resolveProductTestUrgency('improve', this.runtimeConfig),
                reduceOnly: false,
                reason: `${outcome} ask ${formatPrice(bestAsk)} is inside the extreme buy zone`,
              })
            );
          }
        }
      }

      if (openShares > 0 && hasExecutableBid(book)) {
        const executableBid = book.bestBid;
        const edge = executableBid - strategy.extremeSellThreshold;
        if (edge >= 0) {
          const size = calculateTradeSize({
            action: 'SELL',
            signalType: 'EXTREME_SELL',
            edgeAmount: edge,
            availableCapacity: openShares,
            depthShares: book.depthSharesBid,
            liquidityUsd: market.liquidityUsd,
            price: executableBid,
            referenceEdge: 1 - strategy.extremeSellThreshold,
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
                targetPrice: executableBid,
                referencePrice: strategy.extremeSellThreshold,
                tokenPrice: book.lastTradePrice ?? executableBid,
                midPrice: book.midPrice,
                fairValue,
                edgeAmount: edge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: resolveProductTestUrgency('cross', this.runtimeConfig),
                reduceOnly: true,
                reason: `${outcome} bid ${formatPrice(executableBid)} is inside the extreme sell zone`,
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
    riskAssessment: RiskAssessment,
    now: Date,
    binanceFairValueAdjustment?: FairValueBinanceAdjustment
  ): StrategySignal[] {
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    const signals: StrategySignal[] = [];
    const effectiveBinanceAdjustment = applyBinanceFairValueDecay(
      binanceFairValueAdjustment,
      market.startTime,
      now,
      this.runtimeConfig
    );
    const nowMs = now.getTime();
    const fairValueVariant =
      effectiveBinanceAdjustment &&
      effectiveBinanceAdjustment.direction !== 'FLAT' &&
      Number.isFinite(effectiveBinanceAdjustment.movePct)
        ? 'scalper-binance'
        : 'scalper-base';

    for (const outcome of OUTCOMES as readonly Outcome[]) {
      const book = getBookForOutcome(orderbook, outcome);
      const rawFairValue = estimateFairValue(
        orderbook,
        outcome,
        effectiveBinanceAdjustment,
        this.runtimeConfig
      );
      const fairValue = this.smoothFairValue(
        market.marketId,
        outcome,
        rawFairValue,
        fairValueVariant,
        nowMs
      );
      const openShares = positionManager.getShares(outcome);

      if (
        !riskAssessment.blockedOutcomes.has(outcome) &&
        fairValue !== null &&
        hasValidEntryAsk(book)
      ) {
        const bestAsk = book.bestAsk;
        const fairValueBuyBlock = this.getFairValueBuyBlockState(market, outcome, nowMs);
        if (fairValueBuyBlock) {
          logger.debug('FAIR_VALUE_BUY blocked by cadence control', {
            marketId: market.marketId,
            outcome,
            reason: fairValueBuyBlock.reason,
            remainingMs: fairValueBuyBlock.remainingMs,
          });
          continue;
        }
        const adaptedBuyThreshold = adaptiveFairValueThreshold(
          strategy.fairValueBuyThreshold,
          bestAsk
        );
        const entryGuard = resolveEntryGuardMultiplier(book, 'FAIR_VALUE_BUY', this.runtimeConfig);
        if (entryGuard.multiplier <= 0) {
          logEntryGuardRejection(market, outcome, 'FAIR_VALUE_BUY', entryGuard);
          continue;
        }
        const buyEdge = fairValue - bestAsk;
        if (buyEdge >= adaptedBuyThreshold) {
          const size = calculateTradeSize({
            action: 'BUY',
            signalType: 'FAIR_VALUE_BUY',
            edgeAmount: buyEdge,
            availableCapacity: positionManager.getAvailableEntryCapacity(outcome, strategy),
            depthShares: book.depthSharesAsk,
            liquidityUsd: market.liquidityUsd,
            price: bestAsk,
            referenceEdge: adaptedBuyThreshold,
            runtimeConfig: this.runtimeConfig,
            entryGuardMultiplier: entryGuard.multiplier,
            compoundingMultiplier: this.getCompoundingMultiplier(bestAsk),
          });

          if (size.shares >= strategy.minShares) {
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
                midPrice: book.midPrice,
                fairValue,
                edgeAmount: buyEdge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: resolveProductTestUrgency('passive', this.runtimeConfig),
                reduceOnly: false,
                reason: `${outcome} ask ${formatPrice(bestAsk)} is below fair value ${formatFairValueObservation(fairValue, rawFairValue, this.runtimeConfig)}`,
              })
            );
          }
        }
      }

      if (fairValue !== null && hasExecutableBid(book) && openShares > 0) {
        const executableBid = book.bestBid;
        const adaptedSellThreshold = adaptiveFairValueThreshold(
          strategy.fairValueSellThreshold,
          executableBid
        );
        const sellEdge = executableBid - fairValue;
        if (sellEdge >= adaptedSellThreshold) {
          const size = calculateTradeSize({
            action: 'SELL',
            signalType: 'FAIR_VALUE_SELL',
            edgeAmount: sellEdge,
            availableCapacity: openShares,
            depthShares: book.depthSharesBid,
            liquidityUsd: market.liquidityUsd,
            price: executableBid,
            referenceEdge: adaptedSellThreshold,
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
                targetPrice: executableBid,
                referencePrice: fairValue,
                tokenPrice: book.lastTradePrice ?? executableBid,
                midPrice: book.midPrice,
                fairValue,
                edgeAmount: sellEdge,
                priceMultiplier: size.priceMultiplier,
                fillRatio: size.fillRatio,
                capitalClamp: size.capitalClamp,
                urgency: resolveProductTestUrgency('improve', this.runtimeConfig),
                reduceOnly: true,
                reason: `${outcome} bid ${formatPrice(executableBid)} is above fair value ${formatFairValueObservation(fairValue, rawFairValue, this.runtimeConfig)}`,
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
    const strategy = getEffectiveStrategyConfig(this.runtimeConfig);
    const imbalanceState = positionManager.getInventoryImbalanceState(strategy);
    if (!imbalanceState.dominantOutcome || imbalanceState.suggestedReduceShares <= 0) {
      return [];
    }

    const outcome = imbalanceState.dominantOutcome;
    const book = getBookForOutcome(orderbook, outcome);
    const bestBid = book.bestBid ?? book.midPrice;
    const rawFairValue = estimateFairValue(orderbook, outcome);
    const fairValue = this.smoothFairValue(market.marketId, outcome, rawFairValue, 'scalper-base');
    if (bestBid === null) {
      return [];
    }
    const entryGuard = resolveEntryGuardMultiplier(
      book,
      'INVENTORY_REBALANCE',
      this.runtimeConfig
    );
    if (entryGuard.multiplier <= 0) {
      logEntryGuardRejection(market, outcome, 'INVENTORY_REBALANCE', entryGuard);
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
      referenceEdge: strategy.inventoryImbalanceThreshold,
      runtimeConfig: this.runtimeConfig,
      allowBelowMin: true,
      entryGuardMultiplier: entryGuard.multiplier,
    });

    if (size.shares <= 0) {
      return [];
    }

    return [
      buildSignal({
        market,
        orderbook,
        signalType:
          isDynamicQuotingEnabled(this.runtimeConfig) &&
          this.runtimeConfig.REBALANCE_ON_IMBALANCE
            ? 'INVENTORY_REBALANCE_QUOTE'
            : 'INVENTORY_REBALANCE',
        priority: 100,
        action: 'SELL',
        outcome,
        shares: size.shares,
        targetPrice: bestBid,
        referencePrice: 0,
        tokenPrice: book.lastTradePrice ?? bestBid,
        midPrice: book.midPrice,
        fairValue,
        edgeAmount: imbalanceState.excess,
        priceMultiplier: size.priceMultiplier,
        fillRatio: size.fillRatio,
        capitalClamp: size.capitalClamp,
        urgency: resolveProductTestUrgency(
          isDynamicQuotingEnabled(this.runtimeConfig) ? 'passive' : 'improve',
          this.runtimeConfig
        ),
        reduceOnly: true,
        reason: `Inventory imbalance ${formatPrice(imbalanceState.imbalance)} exceeded threshold ${strategy.inventoryImbalanceThreshold}`,
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

  private getFairValueBuyBlockState(
    market: MarketCandidate,
    outcome: Outcome,
    nowMs: number
  ): { reason: 'rebalance-block' | 'cooldown' | 'slot-cap'; remainingMs: number | null } | null {
    const key = buildFairValueControlKey(market, outcome);
    const rebalanceBlock = this.inventoryRebalanceBlocks.get(key);
    if (rebalanceBlock && rebalanceBlock.blockedUntilMs > nowMs) {
      return {
        reason: 'rebalance-block',
        remainingMs: Math.max(0, rebalanceBlock.blockedUntilMs - nowMs),
      };
    }

    const cadenceState = this.fairValueBuyCadence.get(key);
    if (!cadenceState) {
      return null;
    }

    if (cadenceState.count >= this.runtimeConfig.strategy.fairValueBuyMaxPerSlot) {
      return {
        reason: 'slot-cap',
        remainingMs: null,
      };
    }

    const cooldownMs = this.runtimeConfig.strategy.fairValueBuyCooldownMs;
    if (cooldownMs > 0 && nowMs - cadenceState.lastExecutedAtMs < cooldownMs) {
      return {
        reason: 'cooldown',
        remainingMs: Math.max(0, cooldownMs - (nowMs - cadenceState.lastExecutedAtMs)),
      };
    }

    return null;
  }

  private pruneFairValueControlState(nowMs: number): void {
    pruneControlStateMap(this.fairValueBuyCadence, nowMs);
    pruneControlStateMap(this.inventoryRebalanceBlocks, nowMs);
  }

  private pruneSmoothedFairValues(nowMs: number): void {
    for (const [key, seenAtMs] of this.smoothedScalperFvSeenAtMs.entries()) {
      if (!Number.isFinite(seenAtMs) || nowMs - seenAtMs > SMOOTHED_FAIR_VALUE_TTL_MS) {
        this.smoothedScalperFvSeenAtMs.delete(key);
        this.smoothedScalperFV.delete(key);
      }
    }
  }

  private applyEVKellySignals(signals: StrategySignal[]): StrategySignal[] {
    if (!this.runtimeConfig.EV_KELLY_ENABLED || !this.runtimeConfig.evKelly.enabled) {
      return signals;
    }

    const bankroll = resolveKellyBankroll(this.runtimeConfig);
    const nextSignals: StrategySignal[] = signals
      .map((signal) => {
        const result = applyEVKellyFilter({
          signal,
          bankroll,
          marketTitle: signal.marketTitle,
          config: this.runtimeConfig.evKelly,
        });
        if (!result.approved) {
          const marketProb = resolveSignalMarketProbability(signal);
          const executionPrice = resolveSignalExecutionPrice(signal);
          const minEV =
            result.takerFee > this.runtimeConfig.evKelly.defaultTakerFee
              ? this.runtimeConfig.evKelly.minEVThresholdHighFee
              : this.runtimeConfig.evKelly.minEVThreshold;
          this.recordSkippedSignal(
            signal,
            result.filterReason ?? 'EV_FILTERED',
            `trueProb=${resolveSignalTrueProbability(signal).toFixed(3)} price=${executionPrice.toFixed(3)} min=${minEV.toFixed(3)}`,
            result.ev,
            {
              trueProb: resolveSignalTrueProbability(signal),
              marketProb,
              price: executionPrice,
              takerFee: result.takerFee,
              minEV,
            }
          );
          return null;
        }

        const nextSignal: StrategySignal = {
          ...signal,
          shares: roundTo(result.adjustedShares, 4),
          evScore: Number.isFinite(result.ev) ? result.ev : undefined,
          kellyAdjustedShares: roundTo(result.adjustedShares, 4),
          filterReason: null,
        };
        return nextSignal;
      })
      .filter((signal): signal is StrategySignal => signal !== null);
    return nextSignals;
  }

  private recordSkippedSignal(
    signal: StrategySignal,
    filterReason: string,
    details: string,
    ev?: number,
    context: Record<string, unknown> = {}
  ): void {
    const record: SkippedSignalRecord = {
      timestamp: new Date().toISOString(),
      marketId: signal.marketId,
      signalType: signal.signalType,
      outcome: signal.outcome,
      filterReason,
      ev: typeof ev === 'number' && Number.isFinite(ev) ? roundTo(ev, 6) : undefined,
      details,
    };
    this.recentSkippedSignals.push(record);
    while (this.recentSkippedSignals.length > 24) {
      this.recentSkippedSignals.shift();
    }

    logger.event('signal_filtered', 'Signal filtered', {
      signalType: signal.signalType,
      outcome: signal.outcome,
      filterReason,
      ev: record.ev,
      ...context,
      details,
    });
  }

  private filterForcedSignalsForSniper(
    market: MarketCandidate,
    forcedSignals: readonly StrategySignal[]
  ): StrategySignal[] {
    if (!this.runtimeConfig.SNIPER_MODE_ENABLED) {
      return [...forcedSignals];
    }

    const nextSignals: StrategySignal[] = [];
    for (const signal of forcedSignals) {
      if (!this.sniperEngine.shouldSuppressLegacyForcedSignal(signal)) {
        nextSignals.push(signal);
        continue;
      }

      this.recordSkippedSignal(
        signal,
        'SNIPER_OWNS_EXIT',
        `Suppressed ${signal.signalType} while sniper entry is active on ${market.marketId}`
      );
    }

    return nextSignals;
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
  entryGuardMultiplier?: number;
  /** Optional multiplier from DynamicCompounder (balance-aware scaling). */
  compoundingMultiplier?: number;
}): SizeCalculationResult {
  const runtimeConfig = params.runtimeConfig ?? config;
  const strategy = getEffectiveStrategyConfig(runtimeConfig);
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
  const compounding = clamp(params.compoundingMultiplier ?? 1, 0.1, 5.0);
  const rawShares =
    strategy.baseOrderShares *
    priceMultiplier *
    fillRatio *
    capitalClamp *
    liquidityClamp *
    clamp(params.entryGuardMultiplier ?? 1, 0, 1) *
    compounding;
  const minShares = params.allowBelowMin ? 0.01 : strategy.minShares;
  const preliminaryShares = roundTo(
    clamp(rawShares, minShares, Math.min(strategy.maxShares, params.availableCapacity)),
    4
  );
  const shares = clampProductTestShares(
    preliminaryShares,
    params.price ?? 1,
    runtimeConfig
  );

  return {
    shares,
    priceMultiplier,
    fillRatio,
    capitalClamp,
  };
}

export function adaptiveFairValueThreshold(
  baseThreshold: number,
  price: number
): number {
  if (!Number.isFinite(price) || price <= 0) {
    return baseThreshold;
  }

  const distanceFromExtreme = Math.min(price, 1 - price);
  if (distanceFromExtreme < 0.1) {
    return Math.max(0.002, roundTo(baseThreshold * 0.15, 6));
  }

  if (distanceFromExtreme < 0.3) {
    const transition = (distanceFromExtreme - 0.1) / 0.2;
    return roundTo(baseThreshold * (0.15 + transition * 0.85), 6);
  }

  return roundTo(baseThreshold, 6);
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
    generatedAt: Date.now(),
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
      strategyLayer: resolveStrategyLayer(params.signalType),
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

function transformSignalsForMarketMaker(
  signals: readonly StrategySignal[],
  runtimeConfig: AppConfig
): StrategySignal[] {
  if (!isDynamicQuotingEnabled(runtimeConfig)) {
    return [...signals];
  }

  return signals.map((signal) => {
    if (signal.signalType === 'INVENTORY_REBALANCE_QUOTE') {
      return {
        ...signal,
        urgency: resolveProductTestUrgency('passive', runtimeConfig),
        strategyLayer: resolveStrategyLayer(signal.signalType),
      };
    }

    if (
      signal.signalType === 'COMBINED_DISCOUNT_BUY_BOTH' ||
      signal.signalType === 'EXTREME_BUY' ||
      signal.signalType === 'EXTREME_SELL' ||
      signal.signalType === 'FAIR_VALUE_BUY' ||
      signal.signalType === 'FAIR_VALUE_SELL'
    ) {
      return {
        ...signal,
        signalType: 'DYNAMIC_QUOTE_BOTH',
        urgency: resolveProductTestUrgency('passive', runtimeConfig),
        strategyLayer: resolveStrategyLayer('DYNAMIC_QUOTE_BOTH'),
      };
    }

    return signal;
  });
}

function takeTopSignals(
  signals: StrategySignal[],
  maxSignals: number
): { selected: StrategySignal[]; skipped: StrategySignal[] } {
  const pairedArbSignals = signals.filter(isAtomicPairedArbSignal);
  const otherSignals = signals.filter((signal) => !isAtomicPairedArbSignal(signal));
  const sortedOtherSignals = sortSignals(otherSignals);
  const limit = Math.max(1, maxSignals);

  return {
    selected: sortSignals([...pairedArbSignals, ...sortedOtherSignals.slice(0, limit)]),
    skipped: sortedOtherSignals.slice(limit),
  };
}

function buildFairValueControlKey(market: MarketCandidate, outcome: Outcome): string {
  return `${market.marketId}:${market.startTime ?? 'no-start'}:${outcome}`;
}

function resolveFairValueControlExpiryMs(
  market: MarketCandidate,
  nowMs: number
): number {
  const endMs = market.endTime ? Date.parse(market.endTime) : Number.NaN;
  if (Number.isFinite(endMs)) {
    return endMs + 2 * 60_000;
  }

  const startMs = market.startTime ? Date.parse(market.startTime) : Number.NaN;
  if (Number.isFinite(startMs)) {
    return startMs + 15 * 60_000;
  }

  return nowMs + 10 * 60_000;
}

function pruneControlStateMap<T extends { expiresAtMs: number }>(
  state: Map<string, T>,
  nowMs: number
): void {
  for (const [key, value] of state.entries()) {
    if (!Number.isFinite(value.expiresAtMs) || value.expiresAtMs <= nowMs) {
      state.delete(key);
    }
  }
}

function applyBinanceFairValueDecay(
  adjustment: FairValueBinanceAdjustment | undefined,
  slotStartTime: string | null,
  now: Date,
  runtimeConfig: AppConfig
): FairValueBinanceAdjustment | undefined {
  if (!adjustment || adjustment.direction === 'FLAT') {
    return adjustment;
  }

  const slotStartMs = slotStartTime ? Date.parse(slotStartTime) : Number.NaN;
  if (!Number.isFinite(slotStartMs)) {
    return adjustment;
  }

  const elapsedMs = Math.max(0, now.getTime() - slotStartMs);
  const decayWindowMs = runtimeConfig.strategy.binanceFvDecayWindowMs;
  const minMultiplier = runtimeConfig.strategy.binanceFvDecayMinMultiplier;
  const decayProgress = clamp(elapsedMs / Math.max(1, decayWindowMs), 0, 1);
  const decayMultiplier = roundTo(
    clamp(1 - decayProgress * (1 - minMultiplier), minMultiplier, 1),
    6
  );

  return {
    ...adjustment,
    movePct: roundTo(adjustment.movePct * decayMultiplier, 6),
  };
}

function getBookForOutcome(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome
): TokenBookSnapshot {
  return outcome === 'YES' ? snapshot.yes : snapshot.no;
}

export function estimateFairValue(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome,
  binanceAdjustment?: FairValueBinanceAdjustment,
  runtimeConfig: AppConfig = config
): number | null {
  const noFairValue = estimateLegacyFairValue(snapshot, 'NO');
  let baseFairValue: number | null = null;

  if (outcome === 'NO') {
    baseFairValue = noFairValue;
  } else if (noFairValue !== null) {
    baseFairValue = roundTo(1 - noFairValue, 6);
  } else {
    const yesFairValue = estimateLegacyFairValue(snapshot, 'YES');
    if (yesFairValue !== null) {
      baseFairValue = yesFairValue;
    }
  }

  if (baseFairValue === null) {
    return null;
  }

  if (
    !binanceAdjustment ||
    binanceAdjustment.direction === 'FLAT' ||
    !Number.isFinite(binanceAdjustment.movePct) ||
    runtimeConfig.strategy.binanceFvSensitivity <= 0
  ) {
    return baseFairValue;
  }

  const binanceFvBoost =
    binanceAdjustment.movePct * runtimeConfig.strategy.binanceFvSensitivity;
  const isYes = outcome === 'YES';
  const binanceUp = binanceAdjustment.direction === 'UP';
  const adjustmentSign = isYes === binanceUp ? 1 : -1;
  const adjustedFairValue =
    baseFairValue + adjustmentSign * Math.abs(binanceFvBoost);

  return roundTo(clamp(adjustedFairValue, 0.001, 0.999), 6);
}

function formatPrice(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

function formatMaybePrice(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(4);
}

function formatFairValueObservation(
  smoothedFairValue: number | null,
  rawFairValue: number | null,
  runtimeConfig: AppConfig
): string {
  if (smoothedFairValue === null || !Number.isFinite(smoothedFairValue)) {
    return 'n/a';
  }

  if (
    !runtimeConfig.BAYESIAN_FV_ENABLED ||
    rawFairValue === null ||
    !Number.isFinite(rawFairValue)
  ) {
    return formatPrice(smoothedFairValue);
  }

  return `${formatPrice(smoothedFairValue)} (raw: ${formatPrice(rawFairValue)}, alpha=${runtimeConfig.BAYESIAN_FV_ALPHA.toFixed(2)})`;
}

function hasExecutableBid(book: TokenBookSnapshot): book is TokenBookSnapshot & { bestBid: number } {
  return isFinitePositivePrice(book.bestBid) && book.depthNotionalBid > 0;
}

function hasValidEntryAsk(
  book: TokenBookSnapshot
): book is TokenBookSnapshot & { bestAsk: number } {
  return isFinitePositivePrice(book.bestAsk) && book.bestAsk > 0.01;
}

function resolveEntryGuardMultiplier(
  book: TokenBookSnapshot,
  signalType: StrategySignal['signalType'],
  runtimeConfig: AppConfig
): EntryGuardEvaluation {
  if (!hasValidEntryAsk(book)) {
    return {
      multiplier: 0,
      reason: 'missing_entry_ask',
      spread: null,
      spreadThreshold: resolveSpreadThresholdForSignalType(signalType, runtimeConfig),
    };
  }

  const depthThreshold = Math.max(runtimeConfig.strategy.minEntryDepthUsd, 0);
  const spreadThreshold = Math.max(
    resolveSpreadThresholdForSignalType(signalType, runtimeConfig),
    0.000001
  );
  const depth = Math.max(0, book.depthNotionalAsk);
  const spread =
    book.spread ??
    (isFinitePositivePrice(book.bestBid) ? book.bestAsk - book.bestBid : null);

  const depthMultiplier =
    depthThreshold <= 0
      ? 1
      : depth >= depthThreshold
        ? 1
        : depth >= depthThreshold * 0.5
          ? 0.5
          : depth > 0
            ? 0.25
            : 0;

  const spreadMultiplier =
    spread === null || !Number.isFinite(spread)
      ? 0.5
      : spread <= 0
        ? 0
        : spread <= spreadThreshold
          ? 1
          : spread <= spreadThreshold * 1.5
            ? 0.5
            : spread <= spreadThreshold * 2
            ? 0.25
            : 0;

  return {
    multiplier: Math.min(depthMultiplier, spreadMultiplier),
    reason: spreadMultiplier <= 0 ? 'spread_too_wide' : 'ok',
    spread,
    spreadThreshold,
  };
}

function resolveSpreadThresholdForSignalType(
  signalType: StrategySignal['signalType'],
  runtimeConfig: AppConfig
): number {
  switch (signalType) {
    case 'COMBINED_DISCOUNT_BUY_BOTH':
      return runtimeConfig.strategy.maxEntrySpreadCombinedDiscount;
    case 'EXTREME_BUY':
    case 'EXTREME_SELL':
      return runtimeConfig.strategy.maxEntrySpreadExtreme;
    case 'FAIR_VALUE_BUY':
    case 'FAIR_VALUE_SELL':
      return runtimeConfig.strategy.maxEntrySpreadFairValue;
    case 'INVENTORY_REBALANCE':
    case 'INVENTORY_REBALANCE_QUOTE':
      return runtimeConfig.strategy.maxEntrySpreadRebalance;
    default:
      return runtimeConfig.strategy.maxEntrySpread;
  }
}

function logEntryGuardRejection(
  market: Pick<MarketCandidate, 'marketId'>,
  outcome: Outcome,
  signalType: StrategySignal['signalType'],
  entryGuard: EntryGuardEvaluation
): void {
  if (entryGuard.reason !== 'spread_too_wide') {
    return;
  }

  logger.debug('Entry rejected by spread guard', {
    marketId: market.marketId,
    outcome,
    signalType,
    reason: 'spread_too_wide',
    spread: entryGuard.spread,
    spreadThreshold: entryGuard.spreadThreshold,
  });
}

function estimateLegacyFairValue(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome
): number | null {
  const own = getBookForOutcome(snapshot, outcome);
  const opposite = getBookForOutcome(snapshot, outcome === 'YES' ? 'NO' : 'YES');
  const normalizedMid = normalizePairedFairValues(own.midPrice, opposite.midPrice);
  if (normalizedMid) {
    return normalizedMid.left;
  }

  const normalizedLastTrade = normalizePairedFairValues(
    own.lastTradePrice,
    opposite.lastTradePrice
  );
  if (normalizedLastTrade) {
    return normalizedLastTrade.left;
  }

  if (opposite.midPrice !== null) {
    return roundTo(1 - opposite.midPrice, 6);
  }

  if (opposite.lastTradePrice !== null) {
    return roundTo(1 - opposite.lastTradePrice, 6);
  }

  return null;
}

function normalizePairedFairValues(
  left: number | null,
  right: number | null
): { left: number; right: number } | null {
  if (left === null || right === null) {
    return null;
  }

  const total = left + right;
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return {
    left: roundTo(left / total, 6),
    right: roundTo(right / total, 6),
  };
}

function isFinitePositivePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function sortSignals(signals: readonly StrategySignal[]): StrategySignal[] {
  return [...signals].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.reduceOnly !== right.reduceOnly) {
      return left.reduceOnly ? -1 : 1;
    }
    return right.edgeAmount - left.edgeAmount;
  });
}

function isAtomicPairedArbSignal(signal: StrategySignal): boolean {
  return (
    signal.signalType === 'PAIRED_ARB_BUY_YES' || signal.signalType === 'PAIRED_ARB_BUY_NO'
  );
}

function resolveKellyBankroll(runtimeConfig: AppConfig): number {
  return Math.max(
    runtimeConfig.paperTrading.initialBalanceUsd,
    runtimeConfig.strategy.capitalReferenceShares,
    runtimeConfig.strategy.maxNetYes,
    runtimeConfig.strategy.maxNetNo
  );
}

function resolveSignalMarketProbability(signal: StrategySignal): number {
  return clamp(signal.midPrice ?? signal.tokenPrice ?? signal.targetPrice ?? 0.5, 0.0001, 0.9999);
}

function resolveSignalExecutionPrice(signal: StrategySignal): number {
  return clamp(signal.targetPrice ?? signal.tokenPrice ?? signal.midPrice ?? 0.5, 0.0001, 0.9999);
}

function resolveSignalTrueProbability(signal: StrategySignal): number {
  return clamp(signal.fairValue ?? signal.referencePrice ?? resolveSignalMarketProbability(signal), 0.0001, 0.9999);
}
