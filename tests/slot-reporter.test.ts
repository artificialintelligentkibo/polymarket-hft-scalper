import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSlotMetrics,
  recordSettlementPnl,
  recordSkippedSignal,
  resetSlotReporterState,
} from '../src/slot-reporter.js';
import { clearDayPnlStateFile, resetDayPnlStateCache } from '../src/day-pnl-state.js';

test('slot reporter tracks skipped signals per slot', () => {
  resetSlotReporterState();
  resetDayPnlStateCache();
  clearDayPnlStateFile();
  recordSkippedSignal({
    slotKey: 'slot-1',
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down',
    slotStart: '2026-03-26T10:00:00.000Z',
    slotEnd: '2026-03-26T10:05:00.000Z',
  });

  const metrics = getSlotMetrics('slot-1');
  assert.equal(metrics?.skippedCount, 1);
  clearDayPnlStateFile();
  resetDayPnlStateCache();
});

test('slot reporter records settlement pnl into slot totals', () => {
  resetSlotReporterState();
  resetDayPnlStateCache();
  clearDayPnlStateFile();

  const dayState = recordSettlementPnl({
    slotKey: 'slot-1',
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down',
    pnl: 3,
    outcome: 'Up',
    slotStart: '2026-03-26T10:00:00.000Z',
    slotEnd: '2026-03-26T10:05:00.000Z',
    now: new Date(),
  });

  const metrics = getSlotMetrics('slot-1');
  assert.equal(metrics?.upPnl, 3);
  assert.equal(metrics?.downPnl, 0);
  assert.equal(metrics?.total, 3);
  assert.equal(dayState.dayPnl, 3);

  clearDayPnlStateFile();
  resetDayPnlStateCache();
});
