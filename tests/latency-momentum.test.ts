import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePmEquivalentMovePct,
  resolveLatencyOutcome,
} from '../src/latency-momentum.js';

test('resolveLatencyOutcome chooses the cheap side and respects invert flag', () => {
  assert.equal(resolveLatencyOutcome('UP', false), 'NO');
  assert.equal(resolveLatencyOutcome('DOWN', false), 'YES');
  assert.equal(resolveLatencyOutcome('UP', true), 'YES');
  assert.equal(resolveLatencyOutcome('DOWN', true), 'NO');
});

test('calculatePmEquivalentMovePct only credits PM repricing when direction matches Binance', () => {
  assert.equal(
    calculatePmEquivalentMovePct({
      pmUpMid: 0.53,
      pmDirection: 'UP',
      binanceDirection: 'UP',
      pmMoveSensitivity: 0.1,
    }),
    0.3
  );

  assert.equal(
    calculatePmEquivalentMovePct({
      pmUpMid: 0.53,
      pmDirection: 'UP',
      binanceDirection: 'DOWN',
      pmMoveSensitivity: 0.1,
    }),
    0
  );
});
