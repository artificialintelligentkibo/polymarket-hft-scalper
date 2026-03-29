import assert from 'node:assert/strict';
import test from 'node:test';
import { CostBasisLedger } from '../src/cost-basis-ledger.js';

test('cost basis ledger tracks a basic BUY fill', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
    timestamp: '2026-03-29T09:00:00.000Z',
  });

  const entry = ledger.get('cond-1');
  assert.ok(entry);
  assert.equal(entry.totalCostUsd, 5);
  assert.equal(entry.totalShares, 10);
  assert.equal(entry.soldShares, 0);
  assert.equal(entry.soldCostUsd, 0);
  assert.equal(entry.soldProceeds, 0);
});

test('cost basis ledger aggregates multiple BUY fills', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 6,
    price: 0.4,
  });
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 4,
    price: 0.6,
  });

  const entry = ledger.get('cond-1');
  assert.ok(entry);
  assert.equal(entry.totalCostUsd, 4.8);
  assert.equal(entry.totalShares, 10);
});

test('cost basis ledger tracks SELL fills against remaining basis', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });
  ledger.recordSell({
    conditionId: 'cond-1',
    shares: 4,
    price: 0.7,
  });

  const entry = ledger.get('cond-1');
  assert.ok(entry);
  assert.equal(entry.soldShares, 4);
  assert.equal(entry.soldCostUsd, 2);
  assert.equal(entry.soldProceeds, 2.8);
});

test('cost basis ledger calculates paired redeem pnl without phantom profit', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.5,
  });
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 12, 6);
  assert.equal(result.found, true);
  assert.equal(result.remainingShares, 12);
  assert.equal(result.remainingCost, 6);
  assert.equal(result.redeemPayout, 6);
  assert.equal(result.pnl, 0);
});

test('cost basis ledger calculates profitable paired redeem pnl from actual payout', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.4,
  });
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.4,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 12, 6);
  assert.equal(result.found, true);
  assert.equal(result.remainingShares, 12);
  assert.equal(result.remainingCost, 4.8);
  assert.equal(result.redeemPayout, 6);
  assert.equal(result.pnl, 1.2);
});

test('cost basis ledger calculates redeem pnl after partial sells using actual payout', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.5,
  });
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'BTC up/down',
    shares: 6,
    price: 0.5,
  });
  ledger.recordSell({
    conditionId: 'cond-1',
    shares: 6,
    price: 0.8,
  });

  const realizedSellPnl = 1.8;
  const redeem = ledger.calculateRedeemPnl('cond-1', 6, 6);
  assert.equal(redeem.remainingShares, 6);
  assert.equal(redeem.remainingCost, 3);
  assert.equal(redeem.redeemPayout, 6);
  assert.equal(redeem.pnl, 3);
  assert.equal(realizedSellPnl + redeem.pnl, 4.8);
});

test('cost basis ledger calculates single-sided winning redeem pnl from actual payout', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 6,
    price: 0.3,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 6, 6);
  assert.equal(result.found, true);
  assert.equal(result.remainingShares, 6);
  assert.equal(result.remainingCost, 1.8);
  assert.equal(result.redeemPayout, 6);
  assert.equal(result.pnl, 4.2);
});

test('cost basis ledger retains backward-compatible redeem payout when actual payout is omitted', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 10);
  assert.equal(result.found, true);
  assert.equal(result.redeemPayout, 10);
  assert.equal(result.pnl, 5);
});

test('cost basis ledger records zero-payout redeems as losses on remaining cost basis', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 10, 0);
  assert.equal(result.found, true);
  assert.equal(result.redeemPayout, 0);
  assert.equal(result.pnl, -5);
});

test('cost basis ledger returns zero pnl for zero-share redeem payloads', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 0, 0);
  assert.equal(result.found, true);
  assert.equal(result.pnl, 0);
  assert.equal(result.redeemPayout, 0);
});

test('cost basis ledger reports unknown condition ids conservatively', () => {
  const ledger = new CostBasisLedger();

  const result = ledger.calculateRedeemPnl('missing', 5);
  assert.equal(result.found, false);
  assert.equal(result.pnl, 0);
  assert.equal(result.redeemPayout, 0);
});

test('cost basis ledger prunes stale entries', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
    timestamp: '2026-03-29T09:00:00.000Z',
  });

  ledger.prune(30 * 60 * 1000, new Date('2026-03-29T09:31:00.000Z'));
  assert.equal(ledger.get('cond-1'), undefined);
});

test('cost basis ledger consume removes tracked entries', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const consumed = ledger.consume('cond-1');
  assert.ok(consumed);
  assert.equal(consumed.conditionId, 'cond-1');
  assert.equal(ledger.size, 0);
});
