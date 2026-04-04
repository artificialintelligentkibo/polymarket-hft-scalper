import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { OrderExecutor, resolveExecutionAttemptUrgencies } from '../src/order-executor.js';
import type { StrategySignal } from '../src/strategy-types.js';

function createSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down',
    signalType: 'LATENCY_MOMENTUM_BUY',
    priority: 100,
    action: 'BUY',
    outcome: 'YES',
    outcomeIndex: 0,
    shares: 12,
    targetPrice: 0.12,
    referencePrice: 0.15,
    tokenPrice: 0.12,
    midPrice: 0.11,
    fairValue: 0.16,
    edgeAmount: 0.05,
    combinedBid: null,
    combinedAsk: null,
    combinedMid: null,
    combinedDiscount: null,
    combinedPremium: null,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: 'cross',
    reduceOnly: false,
    reason: 'test',
    ...overrides,
  };
}

test('maker preference tries improve before cross in simulation flows', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    EV_KELLY_ENABLED: 'true',
    PREFER_MAKER_ORDERS: 'true',
    PAPER_TRADING_ENABLED: 'true',
    SIMULATION_MODE: 'false',
    DRY_RUN: 'false',
  });

  assert.deepEqual(resolveExecutionAttemptUrgencies(createSignal(), runtimeConfig), [
    'improve',
    'cross',
  ]);
});

test('live execution keeps direct cross urgency even when maker preference is enabled', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    EV_KELLY_ENABLED: 'true',
    PREFER_MAKER_ORDERS: 'true',
    PAPER_TRADING_ENABLED: 'false',
    SIMULATION_MODE: 'false',
    DRY_RUN: 'false',
  });

  assert.deepEqual(resolveExecutionAttemptUrgencies(createSignal(), runtimeConfig), ['cross']);
});

test('paper trading reports a closed CLOB circuit breaker snapshot', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    PAPER_TRADING_ENABLED: 'true',
    SIMULATION_MODE: 'false',
    DRY_RUN: 'true',
  });

  const executor = new OrderExecutor(undefined, runtimeConfig);
  const snapshot = executor.getClobCircuitBreakerSnapshot();

  assert.equal(snapshot.name, 'clob');
  assert.equal(snapshot.isOpen, false);
  assert.equal(snapshot.failureThreshold, 5);
  assert.equal(snapshot.resetTimeoutMs, 30_000);
});

test('lottery passive buys respect the configured cheap target price', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
  });

  const executor = new OrderExecutor(undefined, runtimeConfig) as any;
  const plan = executor.buildExecutionPlan(
    createSignal({
      signalType: 'LOTTERY_BUY',
      urgency: 'passive',
      targetPrice: 0.07,
      referencePrice: 0.07,
      tokenPrice: 0.07,
      midPrice: 0.07,
    }),
    {
      bids: [{ price: 0.53, size: 100 }],
      asks: [{ price: 0.54, size: 100 }],
      bestBid: 0.53,
      bestAsk: 0.54,
    }
  );

  assert.equal(plan.price, 0.07);
  assert.equal(plan.postOnly, true);
  assert.equal(plan.urgency, 'passive');
});

test('lottery passive buys preserve relative-priced targets without drifting to the live book', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
  });

  const executor = new OrderExecutor(undefined, runtimeConfig) as any;
  const plan = executor.buildExecutionPlan(
    createSignal({
      signalType: 'LOTTERY_BUY',
      urgency: 'passive',
      targetPrice: 0.1325,
      referencePrice: 0.1325,
      tokenPrice: 0.1325,
      midPrice: 0.1325,
    }),
    {
      bids: [{ price: 0.61, size: 100 }],
      asks: [{ price: 0.62, size: 100 }],
      bestBid: 0.61,
      bestAsk: 0.62,
    }
  );

  assert.equal(plan.price, 0.1325);
  assert.equal(plan.postOnly, true);
  assert.equal(plan.urgency, 'passive');
});

test('passive MM bids respect the quote target instead of joining a richer live best bid', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    POST_ONLY_ONLY: 'true',
  });

  const executor = new OrderExecutor(undefined, runtimeConfig) as any;
  const plan = executor.buildExecutionPlan(
    createSignal({
      signalType: 'MM_QUOTE_BID',
      urgency: 'passive',
      targetPrice: 0.29,
      referencePrice: 0.29,
      tokenPrice: 0.29,
      midPrice: 0.29,
    }),
    {
      bids: [{ price: 0.35, size: 100 }],
      asks: [{ price: 0.36, size: 100 }],
      bestBid: 0.35,
      bestAsk: 0.36,
    }
  );

  assert.equal(plan.price, 0.29);
  assert.equal(plan.postOnly, true);
  assert.equal(plan.urgency, 'passive');
});

test('passive MM asks respect the quote target instead of walking down to the live ask', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    POST_ONLY_ONLY: 'true',
  });

  const executor = new OrderExecutor(undefined, runtimeConfig) as any;
  const plan = executor.buildExecutionPlan(
    createSignal({
      signalType: 'MM_QUOTE_ASK',
      action: 'SELL',
      outcome: 'NO',
      outcomeIndex: 1,
      urgency: 'passive',
      targetPrice: 0.29,
      referencePrice: 0.29,
      tokenPrice: 0.29,
      midPrice: 0.29,
    }),
    {
      bids: [{ price: 0.21, size: 100 }],
      asks: [{ price: 0.23, size: 100 }],
      bestBid: 0.21,
      bestAsk: 0.23,
    }
  );

  assert.equal(plan.price, 0.29);
  assert.equal(plan.postOnly, true);
  assert.equal(plan.urgency, 'passive');
});
