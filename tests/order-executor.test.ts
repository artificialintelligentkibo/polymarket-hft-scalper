import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { resolveExecutionAttemptUrgencies } from '../src/order-executor.js';
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
