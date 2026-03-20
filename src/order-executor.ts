import { config, type AppConfig, type OrderMode } from './config.js';
import type { MarketOrderbookSnapshot, OrderbookLevel, TokenBookSnapshot } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import { resolveProductTestUrgency } from './product-test-mode.js';
import type { StrategySignal } from './strategy-types.js';
import { Trader, type TradeExecutionResult } from './trader.js';
import { roundTo, sleep } from './utils.js';

export interface OrderExecutionReport extends TradeExecutionResult {
  attemptCount: number;
  urgency: StrategySignal['urgency'];
  latencySignalToOrderMs?: number;
  latencyRoundTripMs?: number;
}

export class OrderExecutor {
  private lastDispatchAt = 0;

  constructor(
    private readonly trader: Trader = new Trader(),
    private readonly runtimeConfig: AppConfig = config
  ) {}

  async initialize(): Promise<void> {
    await this.trader.initialize();
  }

  async executeSignal(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    signal: StrategySignal;
  }): Promise<OrderExecutionReport> {
    const { market, orderbook, signal } = params;
    const tokenId = signal.outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const executionPlan = this.buildExecutionPlan(signal, book);

    if (executionPlan.price === null) {
      throw new Error(
        `Could not derive execution price for ${signal.signalType} ${signal.outcome} ${signal.action}`
      );
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.runtimeConfig.trading.retryAttempts; attempt += 1) {
      await this.waitForRateLimit();

      try {
        const orderDispatchStartedAt = Date.now();
        const execution = await this.trader.placeOrder({
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
    await this.trader.cancelAllOrders();
  }

  async close(): Promise<void> {
    await this.trader.close();
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
    const effectiveUrgency = resolveProductTestUrgency(signal.urgency, this.runtimeConfig);
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
  const urgency = resolveProductTestUrgency(signal.urgency, runtimeConfig);
  if (urgency === 'cross' && runtimeConfig.trading.orderTypeFallback !== 'NONE') {
    return runtimeConfig.trading.orderTypeFallback;
  }
  return runtimeConfig.trading.orderType;
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
