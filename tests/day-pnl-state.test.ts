import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { createConfig } from '../src/config.js';
import {
  evaluateDayDrawdown,
  getDayPnlState,
  isEntryHalted,
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

test('day pnl state records redeem deltas into day pnl', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'day-pnl-redeem-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/day-pnl-redeem-test.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-29T10:00:00.000Z');

  const state = recordDayPnlDelta(3, now, runtimeConfig);
  assert.equal(state.dayPnl, 3);
  assert.equal(getDayPnlState(now, runtimeConfig).dayPnl, 3);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});

test('day pnl drawdown recalculates after redeem-like recovery', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'day-pnl-drawdown-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/day-pnl-drawdown-test.json',
    MAX_DRAWDOWN_USDC: '-4',
  });
  const now = new Date('2026-03-29T10:05:00.000Z');

  recordDayPnlDelta(-5, now, runtimeConfig);
  const halted = evaluateDayDrawdown(now, runtimeConfig);
  assert.equal(halted.state.tradingHalted, true);
  assert.equal(isEntryHalted(now, runtimeConfig), true);

  const recovered = recordDayPnlDelta(8, now, runtimeConfig);
  assert.equal(recovered.dayPnl, 3);
  assert.equal(recovered.peakPnl, 3);
  assert.equal(recovered.drawdown, 0);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});
