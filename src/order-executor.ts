import type { ClobClient } from '@polymarket/clob-client';
import type { CircuitBreakerSnapshot } from './api-retry.js';
import {
  config,
  isDryRunMode,
  isPaperTradingEnabled,
  type AppConfig,
  type OrderMode,
} from './config.js';
import type { MarketOrderbookSnapshot, OrderbookLevel, TokenBookSnapshot } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import { OrderbookHistory } from './orderbook-history.js';
import { PaperTrader, type PaperMakerFill } from './paper-trader.js';
import { resolveProductTestUrgency } from './product-test-mode.js';
import type { StrategySignal } from './strategy-types.js';
import {
  Trader,
  type ApiCredentials,
  type TradeExecutionResult,
} from './trader.js';
import { roundTo, sleep } from './utils.js';

const MAKER_FALLBACK_DELAY_MS = 2_000;

export interface OrderExecutionReport extends TradeExecutionResult {
  attemptCount: number;
  urgency: StrategySignal['urgency'];
  latencySignalToOrderMs?: number;
  latencyRoundTripMs?: number;
}

export class OrderExecutor {
  private lastDispatchAt = 0;
  private readonly trader: Trader | null;
  private readonly runtimeConfig: AppConfig;
  private readonly orderbookHistory: OrderbookHistory;
  private readonly paperTrader: PaperTrader;

  constructor(trader?: Trader, runtimeConfig: AppConfig = config) {
    this.runtimeConfig = runtimeConfig;
    this.trader = isPaperTradingEnabled(this.runtimeConfig)
      ? trader ?? null
      : trader ?? new Trader(this.runtimeConfig);
    this.orderbookHistory = new OrderbookHistory();
    this.paperTrader = new PaperTrader(this.runtimeConfig.paperTrading, this.orderbookHistory);
  }

  async initialize(): Promise<void> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      await this.paperTrader.ensureReady();
      return;
    }

    await this.trader?.initialize();
  }

  async prewarmMarketMetadata(tokenIds: readonly string[]): Promise<void> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return;
    }

    try {
      await this.trader?.prewarmMarketMetadata(tokenIds);
    } catch (error) {
      logger.debug('Market metadata prewarm failed', {
        tokenCount: tokenIds.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordOrderbookSnapshot(orderbook: MarketOrderbookSnapshot): void {
    this.orderbookHistory.record(
      orderbook.marketId,
      orderbook,
      Date.parse(orderbook.timestamp) || Date.now()
    );
  }

  async executeSignal(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    signal: StrategySignal;
  }): Promise<OrderExecutionReport> {
    const { market, orderbook, signal } = params;
    const tokenId = signal.outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const attemptUrgencies = resolveExecutionAttemptUrgencies(signal, this.runtimeConfig);

    let lastExecution: OrderExecutionReport | null = null;
    for (let attemptIndex = 0; attemptIndex < attemptUrgencies.length; attemptIndex += 1) {
      const attemptSignal =
        attemptUrgencies[attemptIndex] === signal.urgency
          ? signal
          : {
              ...signal,
              urgency: attemptUrgencies[attemptIndex],
            };
      const executionPlan = this.buildExecutionPlan(attemptSignal, book);

      if (executionPlan.price === null) {
        throw new Error(
          `Could not derive execution price for ${signal.signalType} ${signal.outcome} ${signal.action}`
        );
      }

      const execution = await this.executePlannedOrder({
        market,
        orderbook,
        signal: attemptSignal,
        tokenId,
        executionPlan,
      });
      lastExecution = {
        ...execution,
        attemptCount: execution.attemptCount + attemptIndex,
      };

      if (
        attemptIndex === attemptUrgencies.length - 1 ||
        execution.fillConfirmed ||
        execution.filledShares > 0
      ) {
        return lastExecution;
      }

      logger.info('Maker preference improve attempt did not fill, retrying as taker', {
        marketId: market.marketId,
        signalType: signal.signalType,
        outcome: signal.outcome,
        makerOrderId: execution.orderId,
      });
      if (execution.orderId) {
        try {
          await this.cancelOrder(execution.orderId);
        } catch (error) {
          logger.debug('Maker preference cancel failed before taker retry', {
            orderId: execution.orderId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await sleep(MAKER_FALLBACK_DELAY_MS);
    }

    throw lastExecution ?? new Error('Order execution did not return a report.');
  }

  private async executePlannedOrder(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    signal: StrategySignal;
    tokenId: string;
    executionPlan: {
      price: number | null;
      postOnly: boolean;
      orderType: OrderMode;
      urgency: StrategySignal['urgency'];
    };
  }): Promise<OrderExecutionReport> {
    const { market, orderbook, signal, tokenId, executionPlan } = params;
    if (executionPlan.price === null) {
      throw new Error(
        `Could not derive execution price for ${signal.signalType} ${signal.outcome} ${signal.action}`
      );
    }

    if (isPaperTradingEnabled(this.runtimeConfig)) {
      await this.waitForRateLimit();
      const orderDispatchStartedAt = Date.now();
      const execution = await this.paperTrader.simulateOrder({
        marketId: market.marketId,
        marketTitle: market.title,
        signalType: signal.signalType,
        tokenId,
        outcome: signal.outcome,
        side: signal.action,
        shares: signal.shares,
        price: executionPlan.price,
        orderType: executionPlan.orderType,
        postOnly: executionPlan.postOnly,
        urgency: executionPlan.urgency,
        currentOrderbook: orderbook,
        signalGeneratedAt: signal.generatedAt,
      });
      const orderCompletedAt = Date.now();
      const latencySignalToOrderMs =
        signal.generatedAt !== undefined
          ? Math.max(0, orderDispatchStartedAt - signal.generatedAt)
          : undefined;
      const latencyRoundTripMs =
        signal.generatedAt !== undefined
          ? Math.max(0, orderCompletedAt - signal.generatedAt)
          : undefined;

      return {
        ...execution,
        attemptCount: 1,
        urgency: executionPlan.urgency,
        latencySignalToOrderMs,
        latencyRoundTripMs,
      };
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.runtimeConfig.trading.retryAttempts; attempt += 1) {
      await this.waitForRateLimit();

      try {
        const orderDispatchStartedAt = Date.now();
        const execution = await this.trader!.placeOrder({
          marketId: market.marketId,
          marketTitle: market.title,
          tokenId,
          outcome: signal.outcome,
          side: signal.action,
          shares: signal.shares,
          price: executionPlan.price,
          reason: signal.reason,
          postOnly: executionPlan.postOnly,
          orderType: executionPlan.orderType,
        });
        const orderCompletedAt = Date.now();
        const latencySignalToOrderMs =
          signal.generatedAt !== undefined
            ? Math.max(0, orderDispatchStartedAt - signal.generatedAt)
            : undefined;
        const latencyRoundTripMs =
          signal.generatedAt !== undefined
            ? Math.max(0, orderCompletedAt - signal.generatedAt)
            : undefined;

        return {
          ...execution,
          attemptCount: attempt,
          urgency: executionPlan.urgency,
          latencySignalToOrderMs,
          latencyRoundTripMs,
        };
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('Order attempt failed', {
          marketId: market.marketId,
          signalType: signal.signalType,
          attempt,
          message: lastError.message,
        });

        if (
          attempt < this.runtimeConfig.trading.retryAttempts &&
          shouldRetryOrderPlacement(lastError, executionPlan.postOnly)
        ) {
          await sleep(Math.min(150 * 2 ** (attempt - 1), 2_000));
        }
      }
    }

    throw lastError ?? new Error('Unknown order execution error');
  }

  async cancelAll(): Promise<void> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return;
    }
    await this.trader?.cancelAllOrders();
  }

  async getOrderStatus(orderId: string): Promise<unknown> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return {
        orderId,
        status: 'paper',
      };
    }
    return this.trader?.getOrderStatus(orderId);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return;
    }
    await this.trader?.cancelOrder(orderId);
  }

  async getApiCredentials(): Promise<ApiCredentials | null> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return null;
    }
    return this.trader?.getApiCredentials() ?? null;
  }

  async getOutcomeTokenBalance(tokenId: string, forceRefresh = false): Promise<number> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return 0;
    }
    return this.trader?.getOutcomeTokenBalance(tokenId, forceRefresh) ?? 0;
  }

  async getUsdcBalance(forceRefresh = false): Promise<number | null> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return null;
    }
    return this.trader?.getUsdcBalance(forceRefresh) ?? null;
  }

  invalidateBalanceValidationCache(): void {
    this.trader?.invalidateBalanceValidationCache();
  }

  invalidateOutcomeBalanceCache(tokenId?: string): void {
    this.trader?.invalidateOutcomeBalanceCache(tokenId);
  }

  getClobCircuitBreakerSnapshot(): CircuitBreakerSnapshot {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      return {
        name: 'clob',
        isOpen: false,
        consecutiveFailures: 0,
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
        openedAtMs: null,
        nextAttemptAtMs: null,
      };
    }

    return (
      this.trader?.getClobCircuitBreakerSnapshot() ?? {
        name: 'clob',
        isOpen: true,
        consecutiveFailures: 0,
        failureThreshold: 0,
        resetTimeoutMs: 0,
        openedAtMs: null,
        nextAttemptAtMs: null,
      }
    );
  }

  getAuthenticatedClient(): ClobClient {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      throw new Error('Authenticated CLOB client is unavailable in paper trading mode.');
    }
    if (!this.trader) {
      throw new Error('Authenticated CLOB client is unavailable.');
    }
    return this.trader.getAuthenticatedClient();
  }

  hasOpenPaperPosition(marketId: string): boolean {
    return this.paperTrader.hasOpenPosition(marketId);
  }

  resolvePaperSlot(params: {
    marketId: string;
    marketTitle?: string;
    winningOutcome: 'YES' | 'NO';
  }): { pnl: number; yesValue: number; noValue: number } | null {
    if (!isPaperTradingEnabled(this.runtimeConfig) || !this.paperTrader.hasOpenPosition(params.marketId)) {
      return null;
    }

    return this.paperTrader.resolveSlot(params);
  }

  /**
   * Tick pending maker orders against fresh orderbook snapshot.
   * Called every scan cycle when paper trading is enabled.
   */
  tickPaperPendingOrders(marketId: string, currentBook: MarketOrderbookSnapshot): PaperMakerFill[] {
    return this.paperTrader.tickPendingOrders(marketId, currentBook);
  }

  /**
   * Expire all pending maker orders for a market (slot ended / cleanup).
   */
  expirePaperPendingOrders(marketId: string): void {
    this.paperTrader.expirePendingOrders(marketId);
  }

  /** Phase 43: total pending BUY shares for a market. */
  getPaperPendingBuyShares(marketId: string): number {
    return this.paperTrader.getPendingBuyShares(marketId);
  }

  /** Phase 44c: revert a paper fill when runtime guard blocks it. */
  revertPaperFill(marketId: string, outcome: 'YES' | 'NO', side: 'BUY' | 'SELL', shares: number, price: number): void {
    this.paperTrader.revertMakerFill(marketId, outcome, side, shares, price);
  }

  /** Phase 44d: expire only BUY pending orders — keep SELL/exit orders alive. */
  expirePaperPendingBuyOrders(marketId: string): void {
    this.paperTrader.expirePendingBuyOrders(marketId);
  }

  /**
   * Get paper trading stats for dashboard / runtime status.
   */
  getPaperStats(): import('./paper-trader.js').PaperTradingStats {
    return this.paperTrader.getStats();
  }

  /**
   * Get paper trading virtual balance for compounding / sizing.
   */
  getPaperBalance(): number {
    return this.paperTrader.getBalance();
  }

  async close(): Promise<void> {
    if (isPaperTradingEnabled(this.runtimeConfig)) {
      this.paperTrader.printSummary();
      return;
    }
    await this.trader?.close();
  }

  private buildExecutionPlan(
    signal: StrategySignal,
    book: TokenBookSnapshot
  ): {
    price: number | null;
    postOnly: boolean;
    orderType: OrderMode;
    urgency: StrategySignal['urgency'];
  } {
    const effectiveUrgency = resolveExecutionUrgency(signal, this.runtimeConfig);
    const fallbackPrice =
      signal.targetPrice ?? signal.midPrice ?? signal.referencePrice ?? signal.tokenPrice;
    if (fallbackPrice === null) {
      return {
        price: null,
        postOnly: effectiveUrgency !== 'cross',
        orderType: this.runtimeConfig.trading.orderType,
        urgency: effectiveUrgency,
      };
    }

    const tick = inferTickSize(book, fallbackPrice);
    const bestBid = book.bestBid;
    const bestAsk = book.bestAsk;

    if (signal.action === 'BUY') {
      if (signal.signalType === 'LOTTERY_BUY' && effectiveUrgency !== 'cross') {
        const makerCap = bestAsk !== null ? Math.max(0.01, bestAsk - tick) : fallbackPrice;
        return {
          price: roundTo(Math.min(fallbackPrice, signal.targetPrice ?? fallbackPrice, makerCap), 6),
          postOnly: true,
          orderType: resolveOrderType(signal, this.runtimeConfig),
          urgency: effectiveUrgency,
        };
      }

      // 2026-04-08 OBI passive-routing fix:
      // OBI_ENTRY_BUY signals carry targetPrice = bestAsk (the price the OBI
      // engine wants to buy at, since the imbalance points up). The default
      // passive BUY routing below would `min(bestBid, targetPrice)` and place
      // the order AT the bestBid — which is the wrong side of an order-book
      // imbalance trade and was observed in the SOL 09:36 incident: signal
      // said bestAsk 0.31, executor placed passive BUY at 0.18, which then
      // filled 35 seconds later only after the market collapsed to 0.18 (we
      // caught a falling knife and got abandoned at 0.09).
      //
      // Force OBI maker BUYs (and similar top-of-book maker entries) to sit
      // at one tick BELOW the ask, so we are top-of-bid maker, never below
      // the touch. Still post-only — never crosses, never pays the spread.
      if (
        signal.signalType === 'OBI_ENTRY_BUY' &&
        effectiveUrgency !== 'cross' &&
        bestAsk !== null
      ) {
        const topOfBidCap = Math.max(0.01, bestAsk - tick);
        const desired = signal.targetPrice ?? topOfBidCap;
        return {
          price: roundTo(Math.min(desired, topOfBidCap), 6),
          postOnly: true,
          orderType: resolveOrderType(signal, this.runtimeConfig),
          urgency: effectiveUrgency,
        };
      }

      if (effectiveUrgency === 'cross') {
        return {
          price: bestAsk ?? fallbackPrice,
          postOnly: false,
          orderType: resolveOrderType(signal, this.runtimeConfig),
          urgency: effectiveUrgency,
        };
      }

      if (effectiveUrgency === 'improve') {
        const improvedBid = (bestBid ?? fallbackPrice) + tick * this.runtimeConfig.trading.improveTicks;
        const makerCap = bestAsk !== null ? Math.max(0.01, bestAsk - tick) : improvedBid;
        return {
          price: roundTo(Math.min(improvedBid, signal.targetPrice ?? improvedBid, makerCap), 6),
          postOnly: true,
          orderType: resolveOrderType(signal, this.runtimeConfig),
          urgency: effectiveUrgency,
        };
      }

      const passiveBid = Math.min(
        bestBid ?? Math.max(0.01, fallbackPrice - tick * this.runtimeConfig.trading.passiveTicks),
        signal.targetPrice ?? Number.POSITIVE_INFINITY
      );
      const makerCap = bestAsk !== null ? Math.max(0.01, bestAsk - tick) : passiveBid;
      return {
        price: roundTo(Math.min(passiveBid, makerCap), 6),
        postOnly: true,
        orderType: resolveOrderType(signal, this.runtimeConfig),
        urgency: effectiveUrgency,
      };
    }

    // Phase 44: VS_MM_ASK and OBI_MM_QUOTE_ASK should sit at their target price
    // (entry + edge), not at best ask. The standard passive SELL logic pushes price
    // UP to bestAsk, which makes the order unfillable when bestAsk > targetPrice.
    // These MM asks want to be inside the spread to attract fills.
    if (
      (signal.signalType === 'VS_MM_ASK' || signal.signalType === 'OBI_MM_QUOTE_ASK') &&
      effectiveUrgency !== 'cross' &&
      bestBid !== null
    ) {
      const makerFloor = bestBid + tick;
      const desired = signal.targetPrice ?? makerFloor;
      return {
        price: roundTo(Math.max(desired, makerFloor), 6),
        postOnly: true,
        orderType: resolveOrderType(signal, this.runtimeConfig),
        urgency: effectiveUrgency,
      };
    }

    if (effectiveUrgency === 'cross') {
      return {
        price: bestBid ?? fallbackPrice,
        postOnly: false,
        orderType: resolveOrderType(signal, this.runtimeConfig),
        urgency: effectiveUrgency,
      };
    }

    if (effectiveUrgency === 'improve') {
      const improvedAsk = (bestAsk ?? fallbackPrice) - tick * this.runtimeConfig.trading.improveTicks;
      const makerFloor = bestBid !== null ? bestBid + tick : improvedAsk;
      return {
        price: roundTo(Math.max(improvedAsk, signal.targetPrice ?? improvedAsk, makerFloor), 6),
        postOnly: true,
        orderType: resolveOrderType(signal, this.runtimeConfig),
        urgency: effectiveUrgency,
      };
    }

    const passiveAsk = Math.max(
      bestAsk ?? fallbackPrice + tick * this.runtimeConfig.trading.passiveTicks,
      signal.targetPrice ?? 0
    );
    const makerFloor = bestBid !== null ? bestBid + tick : passiveAsk;
    return {
      price: roundTo(Math.max(passiveAsk, makerFloor), 6),
      postOnly: true,
      orderType: resolveOrderType(signal, this.runtimeConfig),
      urgency: effectiveUrgency,
    };
  }

  private async waitForRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastDispatchAt;
    const waitMs = this.runtimeConfig.trading.rateLimitMs - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastDispatchAt = Date.now();
  }
}

function resolveOrderType(signal: StrategySignal, runtimeConfig: AppConfig): OrderMode {
  const urgency = resolveExecutionUrgency(signal, runtimeConfig);
  if (urgency === 'cross' && runtimeConfig.trading.orderTypeFallback !== 'NONE') {
    return runtimeConfig.trading.orderTypeFallback;
  }
  return runtimeConfig.trading.orderType;
}

function resolveExecutionUrgency(
  signal: StrategySignal,
  runtimeConfig: AppConfig
): StrategySignal['urgency'] {
  const urgency = resolveProductTestUrgency(signal.urgency, runtimeConfig);
  if (!runtimeConfig.MARKET_MAKER_MODE) {
    return urgency;
  }

  if (
    signal.signalType === 'SNIPER_BUY' ||
    signal.signalType === 'SNIPER_SCALP_EXIT' ||
    // Phase 9 (2026-04-08): OBI entries need TAKER execution — they grab
    // resting thin-side liquidity by design. Without this bypass, MM_MODE
    // silently downgrades 'cross' → 'passive'/'improve', causing 100% of
    // orders to be rejected by CLOB as "order crosses book".
    signal.signalType === 'OBI_ENTRY_BUY'
  ) {
    return urgency;
  }

  // CRITICAL: emergency exits MUST be able to cross the spread, otherwise
  // they sit as post-only and the position resolves at 0 on slot end.
  // Without this bypass, POST_ONLY_ONLY=true silently turns every stop-loss
  // / time-stop / slot-flatten into "hold to expiration → 100% loss".
  if (
    signal.reduceOnly === true &&
    (signal.signalType === 'HARD_STOP' ||
      signal.signalType === 'SLOT_FLATTEN' ||
      signal.signalType === 'TRAILING_TAKE_PROFIT' ||
      signal.signalType === 'OBI_REBALANCE_EXIT' ||
      signal.signalType === 'OBI_SCALP_EXIT' ||
      // Phase 44: VS exits MUST cross the spread in live, otherwise
      // POST_ONLY_ONLY=true turns them into resting makers that never fill.
      signal.signalType === 'VS_SCALP_EXIT' ||
      signal.signalType === 'VS_TIME_EXIT')
  ) {
    return urgency;
  }

  if (urgency !== 'cross') {
    return urgency;
  }

  return runtimeConfig.POST_ONLY_ONLY ? 'passive' : 'improve';
}

export function resolveExecutionAttemptUrgencies(
  signal: StrategySignal,
  runtimeConfig: AppConfig
): StrategySignal['urgency'][] {
  if (
    runtimeConfig.evKelly.preferMakerOrders &&
    signal.urgency === 'cross' &&
    !signal.reduceOnly &&
    (isPaperTradingEnabled(runtimeConfig) || isDryRunMode(runtimeConfig))
  ) {
    return ['improve', 'cross'];
  }

  return [signal.urgency];
}

function shouldRetryOrderPlacement(error: Error, postOnly: boolean): boolean {
  const message = error.message.toLowerCase();

  // Never retry — these errors are deterministic, condition won't change between attempts
  if (
    message.includes('not enough balance') ||
    message.includes('invalid amounts') ||
    message.includes('invalid amount') ||
    message.includes('min size')
  ) {
    return false;
  }

  if (!postOnly) {
    return true;
  }

  if (message.includes('post-only') && message.includes('cross')) {
    return false;
  }

  return true;
}

function inferTickSize(book: TokenBookSnapshot, fallbackPrice: number): number {
  const bidTick = inferSideTick(book.bids);
  const askTick = inferSideTick(book.asks);
  const minDifference = Math.min(
    ...[bidTick, askTick].filter((value): value is number => Number.isFinite(value) && value > 0)
  );
  if (Number.isFinite(minDifference) && minDifference > 0) {
    return roundTo(minDifference, 6);
  }

  if (fallbackPrice >= 0.5) {
    return 0.01;
  }

  return 0.005;
}

function inferSideTick(levels: OrderbookLevel[]): number {
  if (levels.length <= 1) {
    return Number.NaN;
  }

  const sorted = [...levels].sort((left, right) => left.price - right.price);
  const differences: number[] = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const difference = Math.abs(sorted[index].price - sorted[index - 1].price);
    if (difference > 0) {
      differences.push(difference);
    }
  }

  const finitePositiveDifferences = differences.filter(
    (value) => Number.isFinite(value) && value > 0
  );
  if (finitePositiveDifferences.length === 0) {
    return Number.NaN;
  }

  return Math.min(...finitePositiveDifferences);
}
