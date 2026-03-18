import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/position-manager.js';

test('position manager realizes pnl on sell', () => {
  const manager = new PositionManager('market-1');
  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.4,
  });

  const snapshot = manager.applyFill({
    outcome: 'YES',
    side: 'SELL',
    shares: 4,
    price: 0.43,
  });

  assert.equal(snapshot.yesShares, 6);
  assert.equal(snapshot.realizedPnl, 0.12);
});

test('position manager enforces absolute YES cap breaches via boundary correction', () => {
  const manager = new PositionManager('market-2');
  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 210,
    price: 0.5,
  });

  const correction = manager.getBoundaryCorrection({
    maxNetYes: 200,
    maxNetNo: 250,
    inventoryImbalanceThreshold: 90,
    inventoryRebalanceFraction: 0.45,
    trailingTakeProfit: 0.012,
    hardStopLoss: 0.025,
    exitBeforeEndMs: 20_000,
  });

  assert.deepEqual(correction, {
    signalType: 'RISK_LIMIT',
    action: 'SELL',
    outcome: 'YES',
    shares: 10,
    reason: 'YES exposure 210 exceeded cap 200',
  });
});

test('position manager reports inventory imbalance state', () => {
  const manager = new PositionManager('market-3');
  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 150,
    price: 0.4,
  });
  manager.applyFill({
    outcome: 'NO',
    side: 'BUY',
    shares: 20,
    price: 0.41,
  });

  const imbalance = manager.getInventoryImbalanceState({
    maxNetYes: 200,
    maxNetNo: 250,
    inventoryImbalanceThreshold: 90,
    inventoryRebalanceFraction: 0.45,
    trailingTakeProfit: 0.012,
    hardStopLoss: 0.025,
    exitBeforeEndMs: 20_000,
  });

  assert.equal(imbalance.dominantOutcome, 'YES');
  assert.equal(imbalance.excess > 0, true);
  assert.equal(imbalance.suggestedReduceShares > 0, true);
});
