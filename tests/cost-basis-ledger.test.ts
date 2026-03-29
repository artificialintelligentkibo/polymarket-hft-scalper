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

test('cost basis ledger calculates redeem pnl for a full hold', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 10);
  assert.equal(result.found, true);
  assert.equal(result.remainingShares, 10);
  assert.equal(result.remainingCost, 5);
  assert.equal(result.redeemPayout, 10);
  assert.equal(result.pnl, 5);
});

test('cost basis ledger calculates redeem pnl after partial sells', () => {
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

  const result = ledger.calculateRedeemPnl('cond-1', 6);
  assert.equal(result.found, true);
  assert.equal(result.remainingShares, 6);
  assert.equal(result.remainingCost, 3);
  assert.equal(result.redeemPayout, 6);
  assert.equal(result.pnl, 3);
});

test('cost basis ledger avoids double counting between sell pnl and redeem pnl', () => {
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

  const realizedSellPnl = 0.8;
  const redeem = ledger.calculateRedeemPnl('cond-1', 6);
  assert.equal(redeem.pnl, 3);
  assert.equal(realizedSellPnl + redeem.pnl, 3.8);
});

test('cost basis ledger returns zero pnl for zero-share redeem payloads', () => {
  const ledger = new CostBasisLedger();
  ledger.recordBuy({
    conditionId: 'cond-1',
    marketTitle: 'ETH up',
    shares: 10,
    price: 0.5,
  });

  const result = ledger.calculateRedeemPnl('cond-1', 0);
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
