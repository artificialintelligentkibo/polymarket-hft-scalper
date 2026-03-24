import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  createConfig,
  isDryRunMode,
  isDynamicQuotingEnabled,
} from '../src/config.js';

test('createConfig filters invalid and duplicate whitelist condition ids', () => {
  const candidate = createConfig({
    ...process.env,
    WHITELIST_CONDITION_IDS: [
      '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
      '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
      '0x16822849127587408787308210005791098679610832512872612902331299021053059486007',
      'not-a-condition-id',
    ].join(','),
  });

  assert.deepEqual(candidate.WHITELIST_CONDITION_IDS, [
    '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
  ]);
});

test('createConfig defaults to dynamic BTC/SOL/XRP/ETH market scan when whitelist is empty', () => {
  const candidate = createConfig({
    ...process.env,
    WHITELIST_CONDITION_IDS: '',
  });

  assert.deepEqual(candidate.WHITELIST_CONDITION_IDS, []);
  assert.deepEqual(candidate.COINS_TO_TRADE, ['BTC', 'SOL', 'XRP', 'ETH']);
  assert.equal(candidate.FILTER_5MIN_ONLY, true);
  assert.equal(candidate.MIN_LIQUIDITY_USD, 500);
  assert.equal(candidate.SIMULATION_MODE, true);
  assert.equal(candidate.DRY_RUN, true);
  assert.equal(candidate.REPORTS_DIR, './reports');
  assert.equal(candidate.LATENCY_LOG, './reports/latency_YYYY-MM-DD.log');
  assert.equal(candidate.STATE_FILE, './reports/state.json');
  assert.equal(candidate.REPORTS_FOLDER, './reports');
  assert.equal(candidate.REPORTS_FILE_PREFIX, 'slot-reports');
  assert.equal(candidate.PRODUCT_TEST_MODE, false);
  assert.equal(candidate.TEST_MIN_TRADE_USDC, 1);
  assert.equal(candidate.TEST_MAX_SLOTS, 1);
  assert.equal(candidate.STATUS_CHECK_INTERVAL_MS, 300000);
  assert.equal(candidate.AUTO_PAUSE_ON_INCIDENT, true);
  assert.equal(candidate.PAUSE_GRACE_PERIOD_MS, 60000);
  assert.equal(candidate.AUTO_REDEEM, false);
  assert.equal(candidate.REDEEM_INTERVAL_MS, 30000);
  assert.equal(candidate.FILL_POLL_INTERVAL_MS, 2500);
  assert.equal(candidate.FILL_POLL_TIMEOUT_MS, 120000);
  assert.equal(candidate.FILL_CANCEL_BEFORE_END_MS, 20000);
  assert.equal(candidate.SELL_AFTER_FILL_DELAY_MS, 8000);
  assert.equal(candidate.MARKET_MAKER_MODE, false);
  assert.equal(candidate.DYNAMIC_QUOTING_ENABLED, false);
  assert.equal(candidate.POST_ONLY_ONLY, true);
  assert.equal(candidate.QUOTING_INTERVAL_MS, 150);
  assert.equal(candidate.MAX_IMBALANCE_PERCENT, 35);
  assert.equal(candidate.QUOTING_SPREAD_TICKS, 2);
  assert.equal(candidate.REBALANCE_ON_IMBALANCE, true);
  assert.equal(candidate.POLYMARKET_API_KEY, '');
  assert.equal(candidate.POLYMARKET_API_SECRET, '');
  assert.equal(candidate.POLYMARKET_API_PASSPHRASE, '');
  assert.equal(candidate.POLYMARKET_RELAYER_URL, 'https://relayer-v2.polymarket.com');
  assert.equal(candidate.POLYMARKET_RELAYER_KEY, '');
  assert.equal(candidate.POLYMARKET_RELAYER_KEY_ADDRESS, '');
  assert.equal(candidate.strategy.minCombinedDiscount, 0.01);
  assert.equal(candidate.strategy.extremeSellThreshold, 0.93);
  assert.equal(candidate.strategy.extremeBuyThreshold, 0.04);
  assert.equal(candidate.strategy.fairValueBuyThreshold, 0.018);
  assert.equal(candidate.strategy.fairValueSellThreshold, 0.015);
  assert.equal(candidate.strategy.binanceFvSensitivity, 0.1);
  assert.equal(candidate.strategy.fairValueBuyMaxPerSlot, 4);
  assert.equal(candidate.strategy.fairValueBuyCooldownMs, 30000);
  assert.equal(candidate.strategy.inventoryRebalanceFvBlockMs, 60000);
  assert.equal(candidate.strategy.binanceFvDecayWindowMs, 300000);
  assert.equal(candidate.strategy.binanceFvDecayMinMultiplier, 0.25);
  assert.equal(candidate.strategy.minEntryDepthUsd, 2);
  assert.equal(candidate.strategy.maxEntrySpread, 0.3);
  assert.equal(candidate.strategy.entryImbalanceBlockThreshold, 100);
  assert.equal(candidate.strategy.latencyPauseThresholdMs, 800);
  assert.equal(candidate.strategy.latencyResumeThresholdMs, 400);
  assert.equal(candidate.strategy.latencyPauseWindowSize, 10);
  assert.equal(candidate.strategy.latencyPauseSampleTtlMs, 90000);
  assert.equal(candidate.strategy.maxDrawdownUsdc, -100);
  assert.equal(candidate.strategy.hardStopCooldownMs, 15000);
  assert.equal(candidate.binance.edgeEnabled, false);
  assert.deepEqual(candidate.binance.symbols, [
    'btcusdt',
    'ethusdt',
    'solusdt',
    'xrpusdt',
    'dogeusdt',
    'bnbusdt',
    'linkusdt',
  ]);
  assert.equal(candidate.binance.flatThreshold, 0.05);
  assert.equal(candidate.binance.strongThreshold, 0.2);
  assert.equal(candidate.binance.boostMultiplier, 1.5);
  assert.equal(candidate.binance.reduceMultiplier, 0.5);
  assert.equal(candidate.binance.blockOnStrongContra, true);
});

test('createConfig resolves dedicated relayer credentials with backward-compatible fallbacks', () => {
  const explicit = createConfig({
    ...process.env,
    POLYMARKET_RELAYER_KEY: 'relayer-key',
    POLYMARKET_RELAYER_KEY_ADDRESS: '0x1111111111111111111111111111111111111111',
    RELAYER_API_KEY: 'legacy-relayer-key',
    RELAYER_API_KEY_ADDRESS: '0x2222222222222222222222222222222222222222',
    POLYMARKET_API_KEY_ADDRESS: '0x3333333333333333333333333333333333333333',
  });

  assert.equal(explicit.POLYMARKET_RELAYER_KEY, 'relayer-key');
  assert.equal(
    explicit.POLYMARKET_RELAYER_KEY_ADDRESS,
    '0x1111111111111111111111111111111111111111'
  );

  const fallback = createConfig({
    ...process.env,
    POLYMARKET_RELAYER_KEY: '',
    POLYMARKET_RELAYER_KEY_ADDRESS: '',
    RELAYER_API_KEY: 'legacy-relayer-key',
    RELAYER_API_KEY_ADDRESS: '0x2222222222222222222222222222222222222222',
    POLYMARKET_API_KEY_ADDRESS: '0x3333333333333333333333333333333333333333',
  });

  assert.equal(fallback.POLYMARKET_RELAYER_KEY, 'legacy-relayer-key');
  assert.equal(
    fallback.POLYMARKET_RELAYER_KEY_ADDRESS,
    '0x2222222222222222222222222222222222222222'
  );
});

test('createConfig clamps fill cancel guard to at least 10 seconds', () => {
  const candidate = createConfig({
    ...process.env,
    FILL_CANCEL_BEFORE_END_MS: '5000',
  });

  assert.equal(candidate.FILL_CANCEL_BEFORE_END_MS, 10000);
});

test('createConfig clamps SELL_AFTER_FILL_DELAY_MS to at least 2 seconds', () => {
  const candidate = createConfig({
    ...process.env,
    SELL_AFTER_FILL_DELAY_MS: '1000',
  });

  assert.equal(candidate.SELL_AFTER_FILL_DELAY_MS, 2000);
});

test('dynamic quoting requires both MARKET_MAKER_MODE and DYNAMIC_QUOTING_ENABLED', () => {
  const makerOnly = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'false',
  });
  const fullMm = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
  });

  assert.equal(isDynamicQuotingEnabled(makerOnly), false);
  assert.equal(isDynamicQuotingEnabled(fullMm), true);
});

test('PRODUCT_TEST_MODE overrides simulation and dry-run execution checks', () => {
  const candidate = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'true',
    SIMULATION_MODE: 'true',
    DRY_RUN: 'true',
    TEST_MODE: 'false',
    AUTO_REDEEM: 'true',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    SIGNER_PRIVATE_KEY: '0x0123456789012345678901234567890123456789012345678901234567890123',
  });

  assert.equal(candidate.PRODUCT_TEST_MODE, true);
  assert.equal(isDryRunMode(candidate), false);
});

test('config proxy supports key enumeration and spreading', () => {
  const keys = Object.keys(config);
  assert.equal(keys.includes('SIMULATION_MODE'), true);
  assert.equal(keys.includes('strategy'), true);

  const clone = { ...config };
  assert.equal(typeof clone.SIMULATION_MODE, 'boolean');
  assert.equal(typeof clone.strategy, 'object');
});
