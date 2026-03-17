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

test('position manager generates boundary correction when YES cap is breached', () => {
  const manager = new PositionManager('market-2');
  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 70,
    price: 0.5,
  });

  const correction = manager.getBoundaryCorrection({
    maxNetYes: 65,
    maxNetNo: -75,
    trailingTakeProfit: 0.012,
    hardStopLoss: 0.025,
    exitBeforeEndMs: 20_000,
  });

  assert.deepEqual(correction, {
    action: 'SELL',
    outcome: 'YES',
    shares: 5,
    reason: 'Net YES 70 exceeded cap 65',
  });
});

test('position manager triggers trailing take-profit after retrace', () => {
  const manager = new PositionManager('market-3');
  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.4,
  });

  manager.markToMarket({ YES: 0.415 });
  manager.markToMarket({ YES: 0.403 });

  const exit = manager.getExitSignal('YES', new Date(), {
    maxNetYes: 65,
    maxNetNo: -75,
    trailingTakeProfit: 0.012,
    hardStopLoss: 0.025,
    exitBeforeEndMs: 20_000,
  });

  assert.equal(exit?.outcome, 'YES');
  assert.equal(exit?.shares, 10);
  assert.match(exit?.reason || '', /Trailing take-profit/);
});
