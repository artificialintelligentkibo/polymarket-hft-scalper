import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateOrderbookWalk } from '../src/paper-trader.js';

test('simulateOrderbookWalk averages across multiple ask levels for buys', () => {
  const walked = simulateOrderbookWalk(
    [
      { price: 0.03, size: 20 },
      { price: 0.04, size: 30 },
      { price: 0.05, size: 50 },
    ],
    50,
    'BUY'
  );

  assert.deepEqual(walked, {
    filledShares: 50,
    avgPrice: 0.036,
    slippage: 0.006,
  });
});

test('simulateOrderbookWalk averages across multiple bid levels for sells', () => {
  const walked = simulateOrderbookWalk(
    [
      { price: 0.55, size: 10 },
      { price: 0.54, size: 15 },
      { price: 0.53, size: 30 },
    ],
    20,
    'SELL'
  );

  assert.deepEqual(walked, {
    filledShares: 20,
    avgPrice: 0.545,
    slippage: 0.005,
  });
});
