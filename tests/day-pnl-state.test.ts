import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { createConfig } from '../src/config.js';
import {
  getDayPnlState,
  recordDayPnlDelta,
  resetDayPnlStateCache,
} from '../src/day-pnl-state.js';

test('day pnl state persists peak and drawdown across cache resets', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'day-pnl-state-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/day-pnl-state-test.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-18T12:00:00.000Z');

  recordDayPnlDelta(80, now, runtimeConfig);
  recordDayPnlDelta(-25, now, runtimeConfig);
  resetDayPnlStateCache();

  const restored = getDayPnlState(now, runtimeConfig);
  assert.equal(restored.dayPnl, 55);
  assert.equal(restored.peakPnl, 80);
  assert.equal(restored.drawdown, -25);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});
