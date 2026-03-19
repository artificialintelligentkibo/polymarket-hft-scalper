import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import {
  clampProductTestShares,
  getEffectiveStrategyConfig,
  ProductTestModeController,
  resolveProductTestUrgency,
} from '../src/product-test-mode.js';
import type { MarketCandidate } from '../src/monitor.js';

function createCandidate(id: string, title: string): MarketCandidate {
  return {
    marketId: id,
    conditionId: id,
    title,
    liquidityUsd: 1500,
    volumeUsd: 3200,
    startTime: '2030-03-19T10:00:00.000Z',
    endTime: '2030-03-19T10:05:00.000Z',
    durationMinutes: 5,
    yesTokenId: `${id}-yes`,
    noTokenId: `${id}-no`,
    yesLabel: 'Up',
    noLabel: 'Down',
    yesOutcomeIndex: 0,
    noOutcomeIndex: 1,
    acceptingOrders: true,
  };
}

test('product test strategy overlay clamps caps and trade size defaults', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'true',
    TEST_MIN_TRADE_USDC: '1',
    AUTO_REDEEM: 'true',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    SIGNER_PRIVATE_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
  });

  const strategy = getEffectiveStrategyConfig(runtimeConfig);
  assert.equal(strategy.minShares, 1);
  assert.equal(strategy.maxShares, 3);
  assert.equal(strategy.maxNetYes, 30);
  assert.equal(strategy.maxNetNo, 40);
  assert.equal(strategy.inventoryImbalanceThreshold >= 60, true);
});

test('product test shares and urgency are clamped to safe live-test values', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'true',
    TEST_MIN_TRADE_USDC: '1',
    AUTO_REDEEM: 'true',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    SIGNER_PRIVATE_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
  });

  assert.equal(clampProductTestShares(12, 0.95, runtimeConfig) <= 3, true);
  assert.equal(resolveProductTestUrgency('cross', runtimeConfig), 'improve');
});

test('product test controller pins the first eligible slot and ignores the rest', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'true',
    TEST_MAX_SLOTS: '1',
    AUTO_REDEEM: 'true',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    SIGNER_PRIVATE_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
  });
  const controller = new ProductTestModeController(runtimeConfig);
  const first = createCandidate(
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'Bitcoin Up or Down'
  );
  const second = createCandidate(
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'Ethereum Up or Down'
  );

  assert.deepEqual(
    controller.selectMarkets([first, second]).map((market) => market.conditionId),
    [first.conditionId]
  );
  assert.deepEqual(
    controller.selectMarkets([first, second]).map((market) => market.conditionId),
    [first.conditionId]
  );
});
