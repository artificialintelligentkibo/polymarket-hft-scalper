import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createConfig } from '../src/config.js';
import { recordDayPnlDelta, resetDayPnlStateCache } from '../src/day-pnl-state.js';
import { readRuntimeStatus, writeRuntimeStatus } from '../src/runtime-status.js';

test('runtime status reads and writes day pnl from day-pnl-state as the source of truth', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-truth');
  const runtimeStatusPath = path.join(reportsDir, 'runtime-status.json');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-truth',
    STATE_FILE: './reports/runtime-status-truth/state.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-29T12:10:00.000Z');

  recordDayPnlDelta(12, now, runtimeConfig);
  recordDayPnlDelta(-4, now, runtimeConfig);
  writeFileSync(
    runtimeStatusPath,
    `${JSON.stringify({ running: true, totalDayPnl: 999, dayDrawdown: -999 }, null, 2)}\n`,
    'utf8'
  );

  const status = readRuntimeStatus(runtimeConfig);
  assert.ok(status);
  assert.equal(status.totalDayPnl, 8);
  assert.equal(status.dayDrawdown, -4);

  writeRuntimeStatus(
    {
      running: true,
      totalDayPnl: 777,
      dayDrawdown: -777,
    },
    runtimeConfig
  );

  const persisted = JSON.parse(readFileSync(runtimeStatusPath, 'utf8')) as {
    totalDayPnl: number;
    dayDrawdown: number;
  };
  assert.equal(persisted.totalDayPnl, 8);
  assert.equal(persisted.dayDrawdown, -4);

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});
