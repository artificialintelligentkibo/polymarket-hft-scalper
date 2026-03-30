import {
  config,
  isDeepBinanceEnabled,
  isDynamicQuotingEnabled,
  type AppConfig,
} from './config.js';
import {
  getDynamicSpreadTicks,
  shouldBlockSignalByBinanceSpread,
  type DeepBinanceAssessment,
} from './binance-deep-integration.js';
import type {
  MarketOrderbookSnapshot,
  Outcome,
  TokenBookSnapshot,
} from './clob-fetcher.js';
import { getTakerFee } from './ev-kelly.js';
import { logger } from './logger.js';
import { getSlotKey, type MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { RiskAssessment } from './risk-manager.js';
import {
  estimateFairValue,
  type FairValueBinanceAdjustment,
} from './signal-scalper.js';
import type { SignalType, StrategySignal } from './strategy-types.js';
import { isQuotingSignalType } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface QuoteContext {
  readonly market: MarketCandidate;
  readonly orderbook: MarketOrderbookSnapshot;
  readonly positionManager: PositionManager;
  readonly riskAssessment: RiskAssessment;
  readonly quoteSignals: readonly StrategySignal[];
  readonly allowEntryQuotes?: boolean;
  readonly pendingQuoteExposure?: PendingQuoteExposureSnapshot;
  readonly binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  readonly deepBinanceAssessment?: DeepBinanceAssessment;
}

export interface PendingQuoteExposureSnapshot {
  readonly yesShares: number;
  readonly noShares: number;
  readonly grossExposureUsd: number;
}

export interface ActiveQuoteOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly outcome: Outcome;
  readonly action: StrategySignal['action'];
  readonly signalType: SignalType;
  readonly targetPrice: number | null;
  readonly shares: number;
}

export interface QuoteRefreshPlan {
  readonly marketId: string;
  readonly slotKey: string;
  readonly activeQuoteOrders: readonly ActiveQuoteOrder[];
  readonly signals: readonly StrategySignal[];
}

export function buildQuoteRefreshPlan(params: {
  context: QuoteContext;
  activeQuoteOrders?: readonly ActiveQuoteOrder[];
  runtimeConfig?: AppConfig;
  currentMMExposureUsd?: number;
  now?: Date;
}): QuoteRefreshPlan {
  const runtimeConfig = params.runtimeConfig ?? config;
  const activeQuoteOrders = [...(params.activeQuoteOrders ?? [])];
  const signals = isDynamicQuotingEnabled(runtimeConfig)
    ? buildMarketMakerQuoteSignals({
        ...params,
        runtimeConfig,
        currentMMExposureUsd: params.currentMMExposureUsd,
      })
    : [];

  return {
    marketId: params.context.market.marketId,
    slotKey: getSlotKey(params.context.market),
    activeQuoteOrders,
    signals,
  };
}

export function buildMarketMakerQuoteSignals(params: {
  context: QuoteContext;
  runtimeConfig?: AppConfig;
  currentMMExposureUsd?: number;
  now?: Date;
}): StrategySignal[] {
  const runtimeConfig = params.runtimeConfig ?? config;
  if (!isDynamicQuotingEnabled(runtimeConfig)) {
    return [];
  }

  const now = params.now ?? new Date();
  const builtSignals: StrategySignal[] = [];
  const quoteSpreadTicks = resolveQuoteSpreadTicks(
    runtimeConfig,
    params.context.deepBinanceAssessment
  );
  const snapshot = params.context.positionManager.getSnapshot();
  const imbalancePercent = resolveInventoryImbalancePercent(snapshot);
  const overweightOutcome =
    imbalancePercent > runtimeConfig.MAX_IMBALANCE_PERCENT
      ? snapshot.inventoryImbalance > 0
        ? 'YES'
      : snapshot.inventoryImbalance < 0
          ? 'NO'
          : null
      : null;

  if (
    runtimeConfig.MM_AUTONOMOUS_QUOTES &&
    (params.context.quoteSignals.length === 0 || runtimeConfig.MM_ALWAYS_QUOTE)
  ) {
    builtSignals.push(
      ...generateAutonomousQuoteSignals({
        context: params.context,
        runtimeConfig,
        quoteSpreadTicks,
        currentMMExposureUsd: params.currentMMExposureUsd ?? 0,
        now,
      })
    );
  }

  for (const signal of params.context.quoteSignals) {
    if (!isQuotingSignalType(signal.signalType)) {
      continue;
    }

    if (signal.signalType === 'INVENTORY_REBALANCE_QUOTE') {
      const rebalanceQuote = buildReduceOnlyQuoteSignal({
        market: params.context.market,
        orderbook: params.context.orderbook,
        template: signal,
        runtimeConfig,
        binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
        deepBinanceAssessment: params.context.deepBinanceAssessment,
        quoteSpreadTicks,
        now,
      });
      if (rebalanceQuote) {
        builtSignals.push(rebalanceQuote);
      }
      continue;
    }

    if (signal.reduceOnly || signal.action === 'SELL') {
      const reduceOnlyQuote = buildReduceOnlyQuoteSignal({
        market: params.context.market,
        orderbook: params.context.orderbook,
        template: signal,
        runtimeConfig,
        binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
        deepBinanceAssessment: params.context.deepBinanceAssessment,
        quoteSpreadTicks,
        now,
      });
      if (reduceOnlyQuote) {
        builtSignals.push(reduceOnlyQuote);
      }
      continue;
    }

    if (params.context.allowEntryQuotes === false) {
      logger.debug('MM quote skipped', {
        marketId: params.context.market.marketId,
        reason: 'concurrent_limit',
        details: {
          signalType: signal.signalType,
          outcome: signal.outcome,
        },
      });
      continue;
    }

    if (
      params.context.riskAssessment.blockedOutcomes.has(signal.outcome) ||
      overweightOutcome === signal.outcome
    ) {
      continue;
    }

    const entryQuote = buildEntryQuoteSignal({
      market: params.context.market,
      orderbook: params.context.orderbook,
      template: signal,
      runtimeConfig,
      binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
      deepBinanceAssessment: params.context.deepBinanceAssessment,
      quoteSpreadTicks,
      now,
    });
    if (entryQuote) {
      builtSignals.push(entryQuote);
    }

    const oppositeOutcome = getOppositeOutcome(signal.outcome);
    const oppositeShares = params.context.positionManager.getShares(oppositeOutcome);
    if (oppositeShares <= 0) {
      continue;
    }

    const oppositeQuote = buildReduceOnlyQuoteSignal({
      market: params.context.market,
      orderbook: params.context.orderbook,
      template: {
        ...signal,
        action: 'SELL',
        outcome: oppositeOutcome,
        outcomeIndex: oppositeOutcome === 'YES' ? 0 : 1,
        shares: Math.min(signal.shares, oppositeShares),
        reduceOnly: true,
        reason: `${signal.reason} | Opposite-side inventory quote`,
      },
      runtimeConfig,
      binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
      deepBinanceAssessment: params.context.deepBinanceAssessment,
      quoteSpreadTicks,
      now,
    });
    if (oppositeQuote) {
      builtSignals.push(oppositeQuote);
    }
  }

  return mergeQuoteSignals(builtSignals);
}

/**
 * Generates autonomous dual-sided quote signals for market making.
 * Bids can be suppressed by inventory, gross exposure, or concurrent-market
 * limits, while asks remain available to reduce existing inventory.
 */
function generateAutonomousQuoteSignals(params: {
  context: QuoteContext;
  runtimeConfig: AppConfig;
  quoteSpreadTicks: number;
  currentMMExposureUsd: number;
  now: Date;
}): StrategySignal[] {
  const { context, runtimeConfig, now } = params;
  const snapshot = context.positionManager.getSnapshot();
  const pendingQuoteExposure = normalizePendingQuoteExposure(
    context.pendingQuoteExposure
  );
  const effectiveSnapshot = applyPendingQuoteExposure(snapshot, pendingQuoteExposure);
  const imbalancePercent = resolveInventoryImbalancePercent(effectiveSnapshot);
  const overweightOutcome =
    imbalancePercent > runtimeConfig.MAX_IMBALANCE_PERCENT
      ? effectiveSnapshot.inventoryImbalance > 0
        ? 'YES'
        : effectiveSnapshot.inventoryImbalance < 0
          ? 'NO'
          : null
      : null;
  const netInventory = roundTo(
    effectiveSnapshot.yesShares - effectiveSnapshot.noShares,
    4
  );
  const skewFactor = runtimeConfig.MM_INVENTORY_SKEW_FACTOR;
  const skewAdjustment =
    -clamp(
      netInventory / Math.max(1, runtimeConfig.MM_MAX_NET_DIRECTIONAL),
      -1,
      1
    ) * skewFactor;
  const quoteSpreadTicks = Math.max(
    params.quoteSpreadTicks,
    runtimeConfig.MM_MIN_SPREAD_TICKS
  );
  const builtSignals: StrategySignal[] = [];
  let projectedExposureUsd = Math.max(0, roundTo(params.currentMMExposureUsd, 4));

  for (const outcome of ['YES', 'NO'] as const satisfies readonly Outcome[]) {
    const book = getBookForOutcome(context.orderbook, outcome);
    if (
      book.depthNotionalBid < runtimeConfig.MM_MIN_BOOK_DEPTH_USD ||
      book.depthNotionalAsk < runtimeConfig.MM_MIN_BOOK_DEPTH_USD
    ) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason: 'low_depth',
        details: {
          outcome,
          bidDepthUsd: roundTo(book.depthNotionalBid, 4),
          askDepthUsd: roundTo(book.depthNotionalAsk, 4),
          minDepthUsd: runtimeConfig.MM_MIN_BOOK_DEPTH_USD,
        },
      });
      continue;
    }

    const fairValue = resolveQuoteFairValue(
      context.orderbook,
      outcome,
      runtimeConfig,
      context.binanceFairValueAdjustment,
      context.deepBinanceAssessment
    );
    if (runtimeConfig.MM_REQUIRE_FAIR_VALUE && fairValue === null) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason: 'no_fair_value',
        details: { outcome },
      });
      continue;
    }

    const pricingAnchor =
      fairValue ??
      book.midPrice ??
      book.lastTradePrice ??
      book.bestBid ??
      book.bestAsk;
    if (pricingAnchor === null || !Number.isFinite(pricingAnchor)) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason: 'no_fair_value',
        details: {
          outcome,
          fairValue,
        },
      });
      continue;
    }

    const tick = inferQuoteTick(book, pricingAnchor);
    const skewedFairValue = roundTo(
      clamp(
        pricingAnchor + skewAdjustment * tick * quoteSpreadTicks,
        0.01,
        0.99
      ),
      6
    );
    const bidPrice = resolveBuyQuotePrice(book, skewedFairValue, quoteSpreadTicks);
    const askPrice = resolveSellQuotePrice(book, skewedFairValue, quoteSpreadTicks);
    if (bidPrice === null || askPrice === null) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason: 'spread_too_thin',
        details: {
          outcome,
          bidPrice,
          askPrice,
        },
      });
      continue;
    }

    const takerFee = getTakerFee(context.market.title, runtimeConfig.evKelly);
    const minProfitableSpread = Math.max(
      takerFee + runtimeConfig.MM_MIN_EDGE_AFTER_FEE,
      tick * runtimeConfig.MM_MIN_SPREAD_TICKS
    );
    const actualSpread = roundTo(askPrice - bidPrice, 6);
    if (actualSpread < minProfitableSpread) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason: 'spread_too_thin',
        details: {
          outcome,
          actualSpread,
          minProfitableSpread,
        },
      });
      continue;
    }

    const bidShares = roundTo(runtimeConfig.MM_QUOTE_SHARES, 4);
    const bidNotionalUsd = roundTo(bidShares * bidPrice, 4);
    const entryCapacity = resolvePendingAwareEntryCapacity({
      outcome,
      snapshot,
      pendingQuoteExposure,
      maxNetYes: runtimeConfig.strategy.maxNetYes,
      maxNetNo: runtimeConfig.strategy.maxNetNo,
    });
    const projectedDirectionalInventory =
      netInventory + (outcome === 'YES' ? bidShares : -bidShares);
    const increasesDirectionalRisk =
      Math.abs(projectedDirectionalInventory) > runtimeConfig.MM_MAX_NET_DIRECTIONAL &&
      Math.abs(projectedDirectionalInventory) >= Math.abs(netInventory);

    if (
      context.allowEntryQuotes === false ||
      context.riskAssessment.blockedOutcomes.has(outcome) ||
      overweightOutcome === outcome ||
      entryCapacity < bidShares ||
      increasesDirectionalRisk ||
      projectedExposureUsd + bidNotionalUsd > runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD
    ) {
      logger.debug('MM quote skipped', {
        marketId: context.market.marketId,
        reason:
          context.allowEntryQuotes === false
            ? 'concurrent_limit'
            : projectedExposureUsd + bidNotionalUsd > runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD
              ? 'exposure_limit'
              : 'inventory_limit',
        details: {
          outcome,
          entryCapacity,
          overweightOutcome,
          projectedExposureUsd: roundTo(projectedExposureUsd + bidNotionalUsd, 4),
          maxExposureUsd: runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD,
          netInventory: roundTo(netInventory, 4),
          projectedDirectionalInventory: roundTo(projectedDirectionalInventory, 4),
          maxDirectionalInventory: runtimeConfig.MM_MAX_NET_DIRECTIONAL,
        },
      });
    } else {
      builtSignals.push(
        buildAutonomousSignal({
          market: context.market,
          orderbook: context.orderbook,
          runtimeConfig,
          action: 'BUY',
          outcome,
          signalType: 'MM_QUOTE_BID',
          shares: bidShares,
          targetPrice: bidPrice,
          referencePrice: fairValue ?? pricingAnchor,
          fairValue: skewedFairValue,
          actualSpread,
          reason: 'Autonomous MM bid',
          now,
        })
      );
      projectedExposureUsd += bidNotionalUsd;
      logger.debug('MM autonomous quote generated', {
        marketId: context.market.marketId,
        outcome,
        action: 'BID',
        price: bidPrice,
        fairValue,
        skewedFairValue,
        spread: actualSpread,
        inventorySkew: roundTo(skewAdjustment, 6),
        grossExposure: roundTo(projectedExposureUsd, 4),
      });
    }

    const openShares = context.positionManager.getShares(outcome);
    const askShares = Math.min(roundTo(runtimeConfig.MM_QUOTE_SHARES, 4), openShares);
    if (askShares <= 0) {
      continue;
    }

    builtSignals.push(
      buildAutonomousSignal({
        market: context.market,
        orderbook: context.orderbook,
        runtimeConfig,
        action: 'SELL',
        outcome,
        signalType: 'MM_QUOTE_ASK',
        shares: askShares,
        targetPrice: askPrice,
        referencePrice: fairValue ?? pricingAnchor,
        fairValue: skewedFairValue,
        actualSpread,
        reason: 'Autonomous MM ask',
        now,
      })
    );
    logger.debug('MM autonomous quote generated', {
      marketId: context.market.marketId,
      outcome,
      action: 'ASK',
      price: askPrice,
      fairValue,
      skewedFairValue,
      spread: actualSpread,
      inventorySkew: roundTo(skewAdjustment, 6),
      grossExposure: roundTo(projectedExposureUsd, 4),
    });
  }

  return builtSignals;
}

function buildAutonomousSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  runtimeConfig: AppConfig;
  action: 'BUY' | 'SELL';
  outcome: Outcome;
  signalType: Extract<SignalType, 'MM_QUOTE_BID' | 'MM_QUOTE_ASK'>;
  shares: number;
  targetPrice: number;
  referencePrice: number;
  fairValue: number;
  actualSpread: number;
  reason: string;
  now: Date;
}): StrategySignal {
  const book = getBookForOutcome(params.orderbook, params.outcome);
  const edgeAmount =
    params.action === 'BUY'
      ? roundTo(Math.max(0, params.referencePrice - params.targetPrice), 6)
      : roundTo(Math.max(0, params.targetPrice - params.referencePrice), 6);

  return {
    marketId: params.market.marketId,
    marketTitle: params.market.title,
    signalType: params.signalType,
    priority: params.action === 'BUY' ? 150 : 140,
    generatedAt: params.now.getTime(),
    action: params.action,
    outcome: params.outcome,
    outcomeIndex: params.outcome === 'YES' ? 0 : 1,
    shares: roundTo(params.shares, 4),
    targetPrice: params.targetPrice,
    referencePrice: roundTo(params.referencePrice, 6),
    tokenPrice: book.lastTradePrice ?? params.targetPrice,
    midPrice: book.midPrice,
    fairValue: roundTo(params.fairValue, 6),
    edgeAmount,
    combinedBid: params.orderbook.combined.combinedBid,
    combinedAsk: params.orderbook.combined.combinedAsk,
    combinedMid: params.orderbook.combined.combinedMid,
    combinedDiscount: params.orderbook.combined.combinedDiscount,
    combinedPremium: params.orderbook.combined.combinedPremium,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: resolveQuoteUrgency(params.runtimeConfig),
    reduceOnly: params.action === 'SELL',
    reason: `${params.reason} | spread=${params.actualSpread.toFixed(4)}`,
  };
}

export class QuotingEngine {
  private readonly contexts = new Map<string, QuoteContext>();
  private readonly activeQuoteOrders = new Map<string, ActiveQuoteOrder[]>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private onRefreshPlan: ((plan: QuoteRefreshPlan) => Promise<void>) | null = null;

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    private readonly now: () => Date = () => new Date()
  ) {}

  isEnabled(): boolean {
    return isDynamicQuotingEnabled(this.runtimeConfig);
  }

  start(onRefreshPlan: (plan: QuoteRefreshPlan) => Promise<void>): void {
    if (!this.isEnabled() || this.refreshTimer) {
      return;
    }

    this.onRefreshPlan = onRefreshPlan;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, this.runtimeConfig.QUOTING_INTERVAL_MS);
    this.refreshTimer.unref?.();
    logger.info('Quoting engine started', {
      intervalMs: this.runtimeConfig.QUOTING_INTERVAL_MS,
      postOnlyOnly: this.runtimeConfig.POST_ONLY_ONLY,
    });
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contexts.clear();
    this.activeQuoteOrders.clear();
    this.onRefreshPlan = null;
  }

  syncMarketContext(context: QuoteContext): void {
    if (!this.isEnabled()) {
      return;
    }

    this.contexts.set(context.market.marketId, context);
  }

  getContext(marketId: string): QuoteContext | undefined {
    return this.contexts.get(marketId);
  }

  /**
   * Returns the currently tracked quote orders for a market.
   */
  getQuoteOrders(marketId: string): readonly ActiveQuoteOrder[] {
    return [...(this.activeQuoteOrders.get(marketId) ?? [])];
  }

  /**
   * Returns true when a market already carries MM inventory or resting quotes.
   */
  hasActiveMMMarket(marketId: string): boolean {
    const quoteOrders = this.activeQuoteOrders.get(marketId);
    if (quoteOrders && quoteOrders.length > 0) {
      return true;
    }

    const context = this.contexts.get(marketId);
    return Boolean(context && context.positionManager.getSnapshot().grossExposureShares > 0);
  }

  /**
   * Returns market IDs that currently have active MM inventory or resting quotes.
   */
  getActiveMMMarketIds(): string[] {
    const marketIds = new Set<string>([
      ...this.contexts.keys(),
      ...this.activeQuoteOrders.keys(),
    ]);

    return Array.from(marketIds).filter((marketId) => this.hasActiveMMMarket(marketId));
  }

  /**
   * Returns total notional MM exposure across all tracked markets.
   */
  getCurrentMMExposureUsd(): number {
    let total = 0;
    for (const context of this.contexts.values()) {
      const snapshot = context.positionManager.getSnapshot();
      const yesMid = context.orderbook.yes.midPrice ?? 0.5;
      const noMid = context.orderbook.no.midPrice ?? 0.5;
      total += snapshot.yesShares * yesMid + snapshot.noShares * noMid;
    }

    return roundTo(total, 4);
  }

  replaceQuoteOrders(marketId: string, orders: readonly ActiveQuoteOrder[]): void {
    if (orders.length === 0) {
      this.activeQuoteOrders.delete(marketId);
      return;
    }

    this.activeQuoteOrders.set(marketId, [...orders]);
  }

  forgetQuoteOrder(orderId: string): void {
    for (const [marketId, orders] of this.activeQuoteOrders.entries()) {
      const next = orders.filter((order) => order.orderId !== orderId);
      if (next.length !== orders.length) {
        if (next.length > 0) {
          this.activeQuoteOrders.set(marketId, next);
        } else {
          this.activeQuoteOrders.delete(marketId);
        }
      }
    }
  }

  removeInactiveMarkets(activeMarketIds: Iterable<string>): ActiveQuoteOrder[] {
    const active = new Set(activeMarketIds);
    const staleOrders: ActiveQuoteOrder[] = [];

    for (const marketId of Array.from(this.contexts.keys())) {
      if (!active.has(marketId)) {
        this.contexts.delete(marketId);
      }
    }

    for (const [marketId, orders] of this.activeQuoteOrders.entries()) {
      if (!active.has(marketId)) {
        staleOrders.push(...orders);
        this.activeQuoteOrders.delete(marketId);
      }
    }

    return staleOrders;
  }

  private async refreshAll(): Promise<void> {
    if (!this.isEnabled() || !this.onRefreshPlan || this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      for (const [marketId, context] of this.contexts.entries()) {
        const plan = buildQuoteRefreshPlan({
          context,
          activeQuoteOrders: this.activeQuoteOrders.get(marketId) ?? [],
          currentMMExposureUsd: this.getCurrentMMExposureUsd(),
          runtimeConfig: this.runtimeConfig,
          now: this.now(),
        });

        if (plan.activeQuoteOrders.length === 0 && plan.signals.length === 0) {
          continue;
        }

        await this.onRefreshPlan(plan);
      }
    } catch (error) {
      logger.warn('Quoting engine refresh failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshInFlight = false;
    }
  }
}

/**
 * Counts the markets that currently have MM inventory or live quote orders.
 */
export function countActiveMMMarkets(quotingEngine: QuotingEngine): number {
  return quotingEngine.getActiveMMMarketIds().length;
}

function buildEntryQuoteSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  template: StrategySignal;
  runtimeConfig: AppConfig;
  binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  deepBinanceAssessment?: DeepBinanceAssessment;
  quoteSpreadTicks: number;
  now: Date;
}): StrategySignal | null {
  const book = getBookForOutcome(params.orderbook, params.template.outcome);
  if (
    params.deepBinanceAssessment &&
    shouldBlockSignalByBinanceSpread({
      binanceSpreadRatio: params.deepBinanceAssessment.binanceSpreadRatio,
      runtimeConfig: params.runtimeConfig,
    })
  ) {
    return null;
  }

  const fairValue = resolveQuoteFairValue(
    params.orderbook,
    params.template.outcome,
    params.runtimeConfig,
    params.binanceFairValueAdjustment,
    params.deepBinanceAssessment
  );
  const targetPrice = resolveBuyQuotePrice(book, fairValue, params.quoteSpreadTicks);
  if (targetPrice === null) {
    return null;
  }

  return {
    ...params.template,
    signalType: resolveQuoteSignalType(params.template, params.deepBinanceAssessment),
    action: 'BUY',
    targetPrice,
    referencePrice: fairValue ?? params.template.referencePrice,
    fairValue,
    tokenPrice: book.lastTradePrice ?? targetPrice,
    midPrice: book.midPrice,
    urgency: resolveQuoteUrgency(params.runtimeConfig),
    generatedAt: params.now.getTime(),
    reduceOnly: false,
    reason: `${params.template.reason} | Market-maker bid quote`,
  };
}

function buildReduceOnlyQuoteSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  template: StrategySignal;
  runtimeConfig: AppConfig;
  binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  deepBinanceAssessment?: DeepBinanceAssessment;
  quoteSpreadTicks: number;
  now: Date;
}): StrategySignal | null {
  const book = getBookForOutcome(params.orderbook, params.template.outcome);
  const fairValue = resolveQuoteFairValue(
    params.orderbook,
    params.template.outcome,
    params.runtimeConfig,
    params.binanceFairValueAdjustment,
    params.deepBinanceAssessment
  );
  const targetPrice = resolveSellQuotePrice(book, fairValue, params.quoteSpreadTicks);
  if (targetPrice === null || params.template.shares <= 0) {
    return null;
  }

  return {
    ...params.template,
    signalType:
      params.template.signalType === 'INVENTORY_REBALANCE_QUOTE'
        ? 'INVENTORY_REBALANCE_QUOTE'
        : resolveQuoteSignalType(params.template, params.deepBinanceAssessment),
    action: 'SELL',
    targetPrice,
    referencePrice: fairValue ?? params.template.referencePrice,
    fairValue,
    tokenPrice: book.lastTradePrice ?? targetPrice,
    midPrice: book.midPrice,
    urgency: resolveQuoteUrgency(params.runtimeConfig),
    generatedAt: params.now.getTime(),
    reduceOnly: true,
    reason:
      params.template.signalType === 'INVENTORY_REBALANCE_QUOTE'
        ? `${params.template.reason} | Passive rebalance quote`
        : `${params.template.reason} | Market-maker ask quote`,
  };
}

function mergeQuoteSignals(signals: readonly StrategySignal[]): StrategySignal[] {
  const byOutcomeAction = new Map<string, StrategySignal>();
  for (const signal of signals) {
    const key = `${signal.outcome}:${signal.action}`;
    const existing = byOutcomeAction.get(key);
    if (!existing || signal.priority > existing.priority || signal.shares > existing.shares) {
      byOutcomeAction.set(key, signal);
    }
  }

  return Array.from(byOutcomeAction.values()).sort((left, right) => right.priority - left.priority);
}

function resolveInventoryImbalancePercent(snapshot: {
  inventoryImbalance: number;
  grossExposureShares: number;
}): number {
  if (snapshot.grossExposureShares <= 0) {
    return 0;
  }

  return roundTo(
    (Math.abs(snapshot.inventoryImbalance) / snapshot.grossExposureShares) * 100,
    4
  );
}

function normalizePendingQuoteExposure(
  exposure?: PendingQuoteExposureSnapshot | null
): PendingQuoteExposureSnapshot {
  return {
    yesShares: roundTo(Math.max(0, exposure?.yesShares ?? 0), 4),
    noShares: roundTo(Math.max(0, exposure?.noShares ?? 0), 4),
    grossExposureUsd: roundTo(Math.max(0, exposure?.grossExposureUsd ?? 0), 4),
  };
}

function applyPendingQuoteExposure(
  snapshot: {
    yesShares: number;
    noShares: number;
  },
  pendingQuoteExposure: PendingQuoteExposureSnapshot
): {
  yesShares: number;
  noShares: number;
  inventoryImbalance: number;
  grossExposureShares: number;
} {
  const yesShares = roundTo(
    Math.max(0, snapshot.yesShares + pendingQuoteExposure.yesShares),
    4
  );
  const noShares = roundTo(
    Math.max(0, snapshot.noShares + pendingQuoteExposure.noShares),
    4
  );

  return {
    yesShares,
    noShares,
    inventoryImbalance: roundTo(yesShares - noShares, 4),
    grossExposureShares: roundTo(yesShares + noShares, 4),
  };
}

function resolvePendingAwareEntryCapacity(params: {
  outcome: Outcome;
  snapshot: {
    yesShares: number;
    noShares: number;
  };
  pendingQuoteExposure: PendingQuoteExposureSnapshot;
  maxNetYes: number;
  maxNetNo: number;
}): number {
  const confirmedShares =
    params.outcome === 'YES' ? params.snapshot.yesShares : params.snapshot.noShares;
  const pendingShares =
    params.outcome === 'YES'
      ? params.pendingQuoteExposure.yesShares
      : params.pendingQuoteExposure.noShares;
  const effectiveShares = roundTo(Math.max(0, confirmedShares + pendingShares), 4);
  const maxShares = params.outcome === 'YES' ? params.maxNetYes : params.maxNetNo;
  return Math.max(0, roundTo(maxShares - effectiveShares, 4));
}

function getBookForOutcome(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome
): TokenBookSnapshot {
  return outcome === 'YES' ? snapshot.yes : snapshot.no;
}

function getOppositeOutcome(outcome: Outcome): Outcome {
  return outcome === 'YES' ? 'NO' : 'YES';
}

function resolveQuoteUrgency(runtimeConfig: AppConfig): StrategySignal['urgency'] {
  return runtimeConfig.POST_ONLY_ONLY ? 'passive' : 'improve';
}

function resolveBuyQuotePrice(
  book: TokenBookSnapshot,
  fairValue: number | null,
  quoteSpreadTicks: number
): number | null {
  const fallback = fairValue ?? book.midPrice ?? book.bestBid ?? book.bestAsk;
  if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) {
    return null;
  }

  const tick = inferQuoteTick(book, fallback);
  const upperBound =
    book.bestAsk !== null && Number.isFinite(book.bestAsk)
      ? Math.max(0.01, book.bestAsk - tick)
      : Math.max(0.01, fallback);
  const lowerBound =
    book.bestBid !== null && Number.isFinite(book.bestBid)
      ? Math.max(0.01, book.bestBid)
      : 0.01;
  const desired = Math.min(fallback, upperBound) - tick * Math.max(0, quoteSpreadTicks - 1);
  return normalizeQuotePrice(desired, lowerBound, upperBound);
}

function resolveSellQuotePrice(
  book: TokenBookSnapshot,
  fairValue: number | null,
  quoteSpreadTicks: number
): number | null {
  const fallback = fairValue ?? book.midPrice ?? book.bestAsk ?? book.bestBid;
  if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) {
    return null;
  }

  const tick = inferQuoteTick(book, fallback);
  const lowerBound =
    book.bestBid !== null && Number.isFinite(book.bestBid)
      ? Math.min(0.99, book.bestBid + tick)
      : Math.min(0.99, fallback);
  const upperBound =
    book.bestAsk !== null && Number.isFinite(book.bestAsk)
      ? Math.min(0.99, book.bestAsk)
      : 0.99;
  const desired = Math.max(fallback, lowerBound) + tick * Math.max(0, quoteSpreadTicks - 1);
  return normalizeQuotePrice(desired, lowerBound, upperBound);
}

function resolveQuoteFairValue(
  orderbook: MarketOrderbookSnapshot,
  outcome: Outcome,
  runtimeConfig: AppConfig,
  binanceFairValueAdjustment?: FairValueBinanceAdjustment,
  deepBinanceAssessment?: DeepBinanceAssessment
): number | null {
  if (
    isDeepBinanceEnabled(runtimeConfig) &&
    deepBinanceAssessment?.available &&
    deepBinanceAssessment.fairValue !== null
  ) {
    return outcome === 'YES'
      ? deepBinanceAssessment.fairValue
      : roundTo(clamp(1 - deepBinanceAssessment.fairValue, 0.001, 0.999), 6);
  }

  return estimateFairValue(
    orderbook,
    outcome,
    binanceFairValueAdjustment,
    runtimeConfig
  );
}

function resolveQuoteSpreadTicks(
  runtimeConfig: AppConfig,
  deepBinanceAssessment?: DeepBinanceAssessment
): number {
  if (
    !isDeepBinanceEnabled(runtimeConfig) ||
    !deepBinanceAssessment?.available
  ) {
    return runtimeConfig.QUOTING_SPREAD_TICKS;
  }

  return getDynamicSpreadTicks({
    baseTicks: runtimeConfig.QUOTING_SPREAD_TICKS,
    volatilityRatio: deepBinanceAssessment.volatilityRatio,
    runtimeConfig,
  });
}

function resolveQuoteSignalType(
  template: StrategySignal,
  deepBinanceAssessment?: DeepBinanceAssessment
): SignalType {
  if (template.signalType === 'INVENTORY_REBALANCE_QUOTE') {
    return 'INVENTORY_REBALANCE_QUOTE';
  }

  if (template.signalType === 'MM_QUOTE_BID' || template.signalType === 'MM_QUOTE_ASK') {
    return template.signalType;
  }

  return deepBinanceAssessment?.available && deepBinanceAssessment.fairValue !== null
    ? 'DEEP_BINANCE_SIGNAL'
    : 'DYNAMIC_QUOTE_BOTH';
}

function normalizeQuotePrice(
  desired: number,
  lowerBound: number,
  upperBound: number
): number | null {
  const minBound = Math.max(0.01, Math.min(lowerBound, upperBound));
  const maxBound = Math.min(0.99, Math.max(lowerBound, upperBound));
  if (!Number.isFinite(minBound) || !Number.isFinite(maxBound) || minBound > maxBound) {
    return null;
  }

  return roundTo(clamp(desired, minBound, maxBound), 6);
}

function inferQuoteTick(book: TokenBookSnapshot, fallbackPrice: number): number {
  const differences = collectLevelDifferences(book.bids).concat(collectLevelDifferences(book.asks));
  const positiveDifferences = differences.filter(
    (value) => Number.isFinite(value) && value > 0
  );
  if (positiveDifferences.length > 0) {
    return roundTo(Math.min(...positiveDifferences), 6);
  }

  return fallbackPrice >= 0.5 ? 0.01 : 0.005;
}

function collectLevelDifferences(levels: readonly { price: number }[]): number[] {
  if (levels.length <= 1) {
    return [];
  }

  const sorted = [...levels].sort((left, right) => left.price - right.price);
  const differences: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = Math.abs(sorted[index].price - sorted[index - 1].price);
    if (difference > 0) {
      differences.push(difference);
    }
  }

  return differences;
}
