import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import {
  calculateFairValue,
  getDynamicSpreadTicks,
  shouldBlockSignalByBinanceSpread,
} from '../src/binance-deep-integration.js';

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
