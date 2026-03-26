import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSlotMetrics,
  recordSkippedSignal,
  resetSlotReporterState,
} from '../src/slot-reporter.js';

test('slot reporter tracks skipped signals per slot', () => {
  resetSlotReporterState();
  recordSkippedSignal({
    slotKey: 'slot-1',
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down',
    slotStart: '2026-03-26T10:00:00.000Z',
    slotEnd: '2026-03-26T10:05:00.000Z',
  });

  const metrics = getSlotMetrics('slot-1');
  assert.equal(metrics?.skippedCount, 1);
});
