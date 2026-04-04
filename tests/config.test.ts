import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  createConfig,
  isDryRunMode,
  isDeepBinanceEnabled,
  isDynamicQuotingEnabled,
  validateConfig,
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
  assert.equal(candidate.BAYESIAN_FV_ENABLED, false);
  assert.equal(candidate.BAYESIAN_FV_ALPHA, 0.35);
  assert.equal(candidate.STATUS_CHECK_INTERVAL_MS, 300000);
  assert.equal(candidate.AUTO_PAUSE_ON_INCIDENT, true);
  assert.equal(candidate.PAUSE_GRACE_PERIOD_MS, 60000);
  assert.equal(candidate.AUTO_REDEEM, false);
  assert.equal(candidate.REDEEM_INTERVAL_MS, 30000);
  assert.equal(candidate.FILL_POLL_INTERVAL_MS, 2500);
  assert.equal(candidate.FILL_POLL_TIMEOUT_MS, 120000);
  assert.equal(candidate.FILL_CANCEL_BEFORE_END_MS, 20000);
  assert.equal(candidate.SELL_AFTER_FILL_DELAY_MS, 8000);
  assert.equal(candidate.BALANCE_CACHE_TTL_MS, 10000);
  assert.equal(candidate.MARKET_MAKER_MODE, false);
  assert.equal(candidate.DYNAMIC_QUOTING_ENABLED, false);
  assert.equal(candidate.MM_POST_SNIPER_GRACE_WINDOW_MS, 15000);
  assert.equal(candidate.POST_ONLY_ONLY, true);
  assert.equal(candidate.QUOTING_INTERVAL_MS, 150);
  assert.equal(candidate.MAX_IMBALANCE_PERCENT, 35);
  assert.equal(candidate.QUOTING_SPREAD_TICKS, 2);
  assert.equal(candidate.REBALANCE_ON_IMBALANCE, true);
  assert.equal(candidate.DEEP_BINANCE_MODE, false);
  assert.equal(candidate.BINANCE_WS_ENABLED, true);
  assert.equal(candidate.BINANCE_DEPTH_LEVELS, 20);
  assert.equal(candidate.BINANCE_FUNDING_WEIGHT, 0.3);
  assert.equal(candidate.MIN_BINANCE_SPREAD_THRESHOLD, 0.004);
  assert.equal(candidate.DYNAMIC_SPREAD_VOL_FACTOR, 1.5);
  assert.equal(candidate.BINANCE_FAIR_VALUE_WEIGHT, 0.7);
  assert.equal(candidate.POLYMARKET_FAIR_VALUE_WEIGHT, 0.2);
  assert.equal(candidate.POLYMARKET_API_KEY, '');
  assert.equal(candidate.POLYMARKET_API_SECRET, '');
  assert.equal(candidate.POLYMARKET_API_PASSPHRASE, '');
  assert.equal(candidate.POLYMARKET_RELAYER_URL, 'https://relayer-v2.polymarket.com');
  assert.equal(candidate.POLYMARKET_RELAYER_KEY, '');
  assert.equal(candidate.POLYMARKET_RELAYER_KEY_ADDRESS, '');
  assert.equal(candidate.SNIPER_MODE_ENABLED, false);
  assert.equal(candidate.sniper.enabled, false);
  assert.equal(candidate.sniper.minBinanceMovePct, 0.1);
  assert.equal(candidate.sniper.strongBinanceMovePct, 0.3);
  assert.equal(candidate.sniper.minEdgeAfterFees, 0.01);
  assert.equal(candidate.sniper.takerFeePct, 0.0315);
  assert.equal(candidate.sniper.maxEntryPrice, 0.55);
  assert.equal(candidate.sniper.minEntryPrice, 0.03);
  assert.equal(candidate.sniper.minPmLagPct, 0.03);
  assert.equal(candidate.sniper.baseShares, 6);
  assert.equal(candidate.sniper.strongShares, 12);
  assert.equal(candidate.sniper.maxPositionShares, 20);
  assert.equal(candidate.sniper.maxConcurrentSameDirection, 2);
  assert.equal(candidate.sniper.cooldownMs, 3000);
  assert.equal(candidate.sniper.slotWarmupMs, 15000);
  assert.equal(candidate.sniper.exitBeforeEndMs, 30000);
  assert.equal(candidate.sniper.maxHoldMs, 0);
  assert.equal(candidate.sniper.scalpExitEdge, 0.08);
  assert.equal(candidate.sniper.makerExitGraceMs, 2500);
  assert.equal(candidate.sniper.stopLossPct, 0.15);
  assert.equal(candidate.sniper.velocityWindowMs, 5000);
  assert.equal(candidate.sniper.minVelocityPctPerSec, 0.005);
  assert.equal(candidate.sniper.volatilityScale, 0.003);
  assert.equal(candidate.lottery.enabled, false);
  assert.equal(candidate.lottery.maxRiskUsdc, 12);
  assert.equal(candidate.lottery.minCents, 0.03);
  assert.equal(candidate.lottery.maxCents, 0.07);
  assert.equal(candidate.lottery.relativePricingEnabled, true);
  assert.equal(candidate.lottery.relativePriceFactor, 0.25);
  assert.equal(candidate.lottery.relativeMaxCents, 0.07);
  assert.equal(candidate.lottery.takeProfitMinCents, 0.12);
  assert.equal(candidate.lottery.takeProfitMultiplier, 1.5);
  assert.equal(candidate.lottery.exitBeforeEndMs, 45000);
  assert.equal(candidate.lottery.onlyAfterSniper, true);
  assert.equal(candidate.lottery.maxPerSlot, 1);
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
  assert.equal(candidate.strategy.maxEntrySpread, 0.12);
  assert.equal(candidate.strategy.maxEntrySpreadCombinedDiscount, 0.08);
  assert.equal(candidate.strategy.maxEntrySpreadExtreme, 0.15);
  assert.equal(candidate.strategy.maxEntrySpreadFairValue, 0.06);
  assert.equal(candidate.strategy.maxEntrySpreadRebalance, 0.2);
  assert.equal(candidate.strategy.entryImbalanceBlockThreshold, 100);
  assert.equal(candidate.strategy.latencyPauseThresholdMs, 800);
  assert.equal(candidate.strategy.latencyResumeThresholdMs, 400);
  assert.equal(candidate.strategy.latencyPauseWindowSize, 10);
  assert.equal(candidate.strategy.latencyPauseSampleTtlMs, 90000);
  assert.equal(candidate.MM_QUOTE_SHARES, 6);
  assert.equal(candidate.MM_MAX_QUOTE_SHARES, 18);
  assert.equal(candidate.MM_MAX_GROSS_EXPOSURE_USD, 15);
  assert.equal(candidate.MM_MAX_NET_DIRECTIONAL, 10);
  assert.equal(candidate.MM_AUTONOMOUS_MIN_BID_PRICE, 0.1);
  assert.equal(candidate.MM_AUTONOMOUS_MAX_BID_PRICE, 0.9);
  assert.equal(candidate.MM_SLOT_WARMUP_MS, 2000);
  assert.equal(candidate.MM_OPENING_SEED_WINDOW_MS, 10000);
  assert.equal(candidate.MM_STOP_NEW_ENTRIES_BEFORE_END_MS, 60000);
  assert.equal(candidate.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS, 15000);
  assert.equal(candidate.MM_TOXIC_FLOW_BLOCK_MOVE_PCT, 0.08);
  assert.equal(candidate.MM_TOXIC_FLOW_CLEAR_MOVE_PCT, 0.05);
  assert.equal(candidate.MM_TOXIC_FLOW_MICROPRICE_TICKS, 1.5);
  assert.equal(candidate.MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS, 1);
  assert.equal(candidate.MM_TOXIC_FLOW_HOLD_MS, 5000);
  assert.equal(candidate.MM_SAME_SIDE_REENTRY_COOLDOWN_MS, 30000);
  assert.equal(candidate.MM_MAKER_MIN_EDGE, 0.003);
  assert.equal(candidate.MM_MIN_QUOTE_LIFETIME_MS, 1500);
  assert.equal(candidate.MM_REPRICE_DEADBAND_TICKS, 1);
  assert.equal(candidate.strategy.maxDrawdownUsdc, -15);
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

test('createConfig clamps BALANCE_CACHE_TTL_MS to zero or above', () => {
  const candidate = createConfig({
    ...process.env,
    BALANCE_CACHE_TTL_MS: '-1',
  });

  assert.equal(candidate.BALANCE_CACHE_TTL_MS, 0);
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

test('deep binance mode requires MM mode, quoting, and websocket flag', () => {
  const disabled = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'false',
  });
  const noWs = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
    BINANCE_WS_ENABLED: 'false',
  });
  const enabled = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
    BINANCE_WS_ENABLED: 'true',
  });

  assert.equal(isDeepBinanceEnabled(disabled), false);
  assert.equal(isDeepBinanceEnabled(noWs), false);
  assert.equal(isDeepBinanceEnabled(enabled), true);
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

test('validateConfig rejects BAYESIAN_FV_ALPHA outside [0, 1]', () => {
  const candidate = createConfig({
    ...process.env,
    BAYESIAN_FV_ALPHA: '1.25',
  });

  assert.throws(
    () => validateConfig(candidate),
    /BAYESIAN_FV_ALPHA must be in the range \[0, 1\]/
  );
});

test('validateConfig rejects MM_MAX_QUOTE_SHARES below the 6-share floor', () => {
  const candidate = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MM_QUOTE_SHARES: '8',
    MM_MAX_QUOTE_SHARES: '7',
  });

  assert.throws(
    () => validateConfig(candidate),
    /MM_MAX_QUOTE_SHARES must be greater than or equal to MM_QUOTE_SHARES/
  );
});

test('validateConfig rejects cancel windows that outlive the late-entry cutoff', () => {
  const candidate = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MM_STOP_NEW_ENTRIES_BEFORE_END_MS: '15000',
    MM_CANCEL_ALL_QUOTES_BEFORE_END_MS: '30000',
  });

  assert.throws(
    () => validateConfig(candidate),
    /MM_CANCEL_ALL_QUOTES_BEFORE_END_MS must be less than or equal to MM_STOP_NEW_ENTRIES_BEFORE_END_MS/
  );
});

test('validateConfig rejects toxic-flow clear thresholds above their block thresholds', () => {
  const candidate = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MM_TOXIC_FLOW_BLOCK_MOVE_PCT: '0.08',
    MM_TOXIC_FLOW_CLEAR_MOVE_PCT: '0.09',
  });

  assert.throws(
    () => validateConfig(candidate),
    /MM_TOXIC_FLOW_CLEAR_MOVE_PCT must be less than or equal to MM_TOXIC_FLOW_BLOCK_MOVE_PCT/
  );
});

test('validateConfig rejects toxic-flow clear microprice above the block threshold', () => {
  const candidate = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MM_TOXIC_FLOW_MICROPRICE_TICKS: '1.5',
    MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS: '2',
  });

  assert.throws(
    () => validateConfig(candidate),
    /MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS must be less than or equal to MM_TOXIC_FLOW_MICROPRICE_TICKS/
  );
});

test('config proxy supports key enumeration and spreading', () => {
  const keys = Object.keys(config);
  assert.equal(keys.includes('SIMULATION_MODE'), true);
  assert.equal(keys.includes('strategy'), true);

  const clone = { ...config };
  assert.equal(typeof clone.SIMULATION_MODE, 'boolean');
  assert.equal(typeof clone.strategy, 'object');
});
