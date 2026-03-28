import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import {
  BinanceDeepIntegration,
  calculateFairValue,
  getDynamicSpreadTicks,
  shouldBlockSignalByBinanceSpread,
} from '../src/binance-deep-integration.js';

function createDeepIntegrationConfig(overrides: Record<string, string> = {}) {
  return createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
    BINANCE_WS_ENABLED: 'true',
    BINANCE_FAIR_VALUE_WEIGHT: '0',
    POLYMARKET_FAIR_VALUE_WEIGHT: '1',
    BINANCE_FUNDING_WEIGHT: '0',
    BAYESIAN_FV_ENABLED: 'true',
    BAYESIAN_FV_ALPHA: '0.35',
    ...overrides,
  });
}

function seedDeepIntegrationState(
  integration: BinanceDeepIntegration,
  slotStartTime: string
): void {
  const stateful = integration as any;
  stateful.books.set('btcusdt', {
    bestBid: 99,
    bestAsk: 101,
    fundingRate: 0,
    lastMarkPrice: 100,
    updatedAtMs: 0,
    recentMidSamples: [],
  });
  stateful.slotOpenMids.set(`BTC:${slotStartTime}`, {
    openMid: 100,
    recordedAtMs: 0,
  });
}

test('calculateFairValue blends Binance move, Polymarket mid, and funding basis', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
    BINANCE_FAIR_VALUE_WEIGHT: '0.7',
    POLYMARKET_FAIR_VALUE_WEIGHT: '0.2',
    BINANCE_FUNDING_WEIGHT: '0.3',
    BINANCE_FV_SENSITIVITY: '0.1',
  });

  const fairValue = calculateFairValue({
    binanceMid: 84_500,
    slotOpenMid: 84_000,
    polymarketMid: 0.52,
    fundingRate: 0.0001,
    binanceMovePct: 0.595238,
    runtimeConfig,
  });

  assert.equal(fairValue > 0.52, true);
  assert.equal(fairValue < 0.7, true);
});

test('shouldBlockSignalByBinanceSpread blocks only when Binance spread exceeds threshold', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    MIN_BINANCE_SPREAD_THRESHOLD: '0.004',
  });

  assert.equal(
    shouldBlockSignalByBinanceSpread({
      binanceSpreadRatio: 0.005,
      runtimeConfig,
    }),
    true
  );
  assert.equal(
    shouldBlockSignalByBinanceSpread({
      binanceSpreadRatio: 0.003,
      runtimeConfig,
    }),
    false
  );
});

test('getDynamicSpreadTicks widens quotes as volatility rises', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    DYNAMIC_SPREAD_VOL_FACTOR: '1.5',
  });

  const baseTicks = 2;
  const calmTicks = getDynamicSpreadTicks({
    baseTicks,
    volatilityRatio: 0.001,
    runtimeConfig,
  });
  const volatileTicks = getDynamicSpreadTicks({
    baseTicks,
    volatilityRatio: 0.01,
    runtimeConfig,
  });

  assert.equal(calmTicks >= baseTicks, true);
  assert.equal(volatileTicks > calmTicks, true);
});

test('deep fair value smoothing disabled returns the raw fair value', () => {
  const runtimeConfig = createDeepIntegrationConfig({
    BAYESIAN_FV_ENABLED: 'false',
  });
  const integration = new BinanceDeepIntegration(runtimeConfig);
  const slotStartTime = '2026-03-28T10:00:00.000Z';
  seedDeepIntegrationState(integration, slotStartTime);

  const assessment = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime,
    polymarketMid: 0.55,
  });

  assert.equal(
    assessment.fairValue,
    calculateFairValue({
      binanceMid: 100,
      slotOpenMid: 100,
      polymarketMid: 0.55,
      fundingRate: 0,
      binanceMovePct: 0,
      runtimeConfig,
    })
  );
});

test('deep fair value smoothing seeds from the first raw observation and resets on a new slot', () => {
  const runtimeConfig = createDeepIntegrationConfig();
  const integration = new BinanceDeepIntegration(runtimeConfig);
  const firstSlot = '2026-03-28T10:00:00.000Z';
  const secondSlot = '2026-03-28T10:05:00.000Z';
  seedDeepIntegrationState(integration, firstSlot);

  const firstAssessment = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime: firstSlot,
    polymarketMid: 0.55,
  });

  seedDeepIntegrationState(integration, secondSlot);
  const resetAssessment = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime: secondSlot,
    polymarketMid: 0.42,
  });

  assert.equal(firstAssessment.fairValue, 0.55);
  assert.equal(resetAssessment.fairValue, 0.42);
});

test('deep fair value smoothing follows the configured EMA formula across ticks', () => {
  const runtimeConfig = createDeepIntegrationConfig({
    BAYESIAN_FV_ALPHA: '0.35',
  });
  const integration = new BinanceDeepIntegration(runtimeConfig);
  const slotStartTime = '2026-03-28T10:00:00.000Z';
  seedDeepIntegrationState(integration, slotStartTime);

  const tick1 = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime,
    polymarketMid: 0.55,
  });
  const tick2 = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime,
    polymarketMid: 0.6,
  });
  const tick3 = integration.calculateFairValue({
    coin: 'BTC',
    slotStartTime,
    polymarketMid: 0.5,
  });

  assert.equal(tick1.fairValue, 0.55);
  assert.equal(tick2.fairValue, 0.5675);
  assert.equal(tick3.fairValue, 0.543875);
});
