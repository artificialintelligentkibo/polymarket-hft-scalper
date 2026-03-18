import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';

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

test('createConfig defaults to dynamic BTC/SOL/XRP market scan when whitelist is empty', () => {
  const candidate = createConfig({
    ...process.env,
    WHITELIST_CONDITION_IDS: '',
    COINS_TO_TRADE: 'btc,sol,xrp,eth',
    FILTER_5MIN_ONLY: 'true',
    MIN_LIQUIDITY_USD: '500',
  });

  assert.deepEqual(candidate.WHITELIST_CONDITION_IDS, []);
  assert.deepEqual(candidate.COINS_TO_TRADE, ['BTC', 'SOL', 'XRP', 'ETH']);
  assert.equal(candidate.FILTER_5MIN_ONLY, true);
  assert.equal(candidate.MIN_LIQUIDITY_USD, 500);
  assert.equal(candidate.REPORTS_DIR, './reports');
  assert.equal(candidate.LATENCY_LOG, './reports/latency_YYYY-MM-DD.log');
  assert.equal(candidate.STATE_FILE, './reports/state.json');
  assert.equal(candidate.REPORTS_FOLDER, './reports');
  assert.equal(candidate.REPORTS_FILE_PREFIX, 'slot-reports');
  assert.equal(candidate.AUTO_REDEEM, true);
  assert.equal(candidate.REDEEM_INTERVAL_MS, 30000);
  assert.equal(candidate.POLYMARKET_API_KEY, '');
  assert.equal(candidate.POLYMARKET_RELAYER_URL, 'https://relayer-v2.polymarket.com');
  assert.equal(candidate.strategy.minCombinedDiscount, 0.01);
  assert.equal(candidate.strategy.extremeBuyThreshold, 0.04);
  assert.equal(candidate.strategy.minEntryDepthUsd, 5);
  assert.equal(candidate.strategy.maxEntrySpread, 0.2);
  assert.equal(candidate.strategy.entryImbalanceBlockThreshold, 100);
  assert.equal(candidate.strategy.maxDrawdownUsdc, -100);
  assert.equal(candidate.strategy.hardStopCooldownMs, 15000);
});
