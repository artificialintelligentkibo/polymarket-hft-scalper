import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
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

test('day pnl state refreshes from disk when another process writes a newer snapshot', async () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'day-pnl-live-refresh-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/day-pnl-live-refresh-test.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-30T13:52:30.000Z');

  recordDayPnlDelta(1.44, now, runtimeConfig);
  assert.equal(getDayPnlState(now, runtimeConfig).dayPnl, 1.44);

  await new Promise((resolve) => setTimeout(resolve, 15));
  writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        dayKey: '2026-03-30',
        dayPnl: -0.83,
        peakPnl: 4.93,
        drawdown: -5.76,
        tradingHalted: false,
        haltReason: null,
        updatedAt: '2026-03-30T13:52:25.000Z',
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const refreshed = getDayPnlState(now, runtimeConfig);
  assert.equal(refreshed.dayPnl, -0.83);
  assert.equal(refreshed.peakPnl, 4.93);
  assert.equal(refreshed.drawdown, -5.76);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});

test('day pnl state recreates zero snapshot after external reset without dashboard restart', async () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'day-pnl-reset-refresh-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/day-pnl-reset-refresh-test.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-30T13:53:00.000Z');

  recordDayPnlDelta(2.5, now, runtimeConfig);
  assert.equal(getDayPnlState(now, runtimeConfig).dayPnl, 2.5);

  await new Promise((resolve) => setTimeout(resolve, 15));
  rmSync(stateFile, { force: true });

  const resetState = getDayPnlState(now, runtimeConfig);
  assert.equal(resetState.dayPnl, 0);
  assert.equal(resetState.peakPnl, 0);
  assert.equal(resetState.drawdown, 0);

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
