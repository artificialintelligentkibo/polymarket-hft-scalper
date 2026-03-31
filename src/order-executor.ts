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
import { PaperTrader } from './paper-trader.js';
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

        if (attempt < this.runtimeConfig.trading.retryAttempts) {
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
    winningOutcome: 'YES' | 'NO';
  }): { pnl: number; yesValue: number; noValue: number } | null {
    if (!isPaperTradingEnabled(this.runtimeConfig) || !this.paperTrader.hasOpenPosition(params.marketId)) {
      return null;
    }

    return this.paperTrader.resolveSlot(params);
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
          price: roundTo(Math.min(improvedBid, makerCap), 6),
          postOnly: true,
          orderType: resolveOrderType(signal, this.runtimeConfig),
          urgency: effectiveUrgency,
        };
      }

      const passiveBid = bestBid ?? Math.max(0.01, fallbackPrice - tick * this.runtimeConfig.trading.passiveTicks);
      const makerCap = bestAsk !== null ? Math.max(0.01, bestAsk - tick) : passiveBid;
      return {
        price: roundTo(Math.min(passiveBid, makerCap), 6),
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
        price: roundTo(Math.max(improvedAsk, makerFloor), 6),
        postOnly: true,
        orderType: resolveOrderType(signal, this.runtimeConfig),
        urgency: effectiveUrgency,
      };
    }

    const passiveAsk = bestAsk ?? fallbackPrice + tick * this.runtimeConfig.trading.passiveTicks;
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
    signal.signalType === 'SNIPER_SCALP_EXIT'
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
