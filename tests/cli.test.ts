import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModeOverrides,
  applyEnvUpdatesToText,
  collectTodayResetTargets,
  resolveDisplayedDayPnl,
} from '../cli/helpers.js';
import { createConfig } from '../src/config.js';
import { recordDayPnlDelta, resetDayPnlStateCache } from '../src/day-pnl-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

test('buildModeOverrides returns safe simulation and product-test presets', () => {
  const simulation = buildModeOverrides('simulation');
  const productTest = buildModeOverrides('product_test');
  const production = buildModeOverrides('production');

  assert.equal(simulation.SIMULATION_MODE, 'true');
  assert.equal(simulation.DRY_RUN, 'true');
  assert.equal(productTest.PRODUCT_TEST_MODE, 'true');
  assert.equal(productTest.TEST_MAX_SLOTS, '1');
  assert.equal(production.PRODUCT_TEST_MODE, 'false');
  assert.equal(production.DRY_RUN, 'false');
});

test('applyEnvUpdatesToText updates existing values and preserves unrelated lines', () => {
  const initial = [
    'SIMULATION_MODE=false',
    'PRODUCT_TEST_MODE=false',
    '# keep this comment',
    'LOG_LEVEL=info',
    '',
  ].join('\n');

  const updated = applyEnvUpdatesToText(initial, {
    SIMULATION_MODE: 'true',
    DRY_RUN: 'true',
  });

  assert.match(updated, /SIMULATION_MODE=true/);
  assert.match(updated, /PRODUCT_TEST_MODE=false/);
  assert.match(updated, /DRY_RUN=true/);
  assert.match(updated, /# keep this comment/);
  assert.match(updated, /LOG_LEVEL=info/);
});

test('collectTodayResetTargets includes dated logs plus state and pid files', () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'scalper-cli-'));
  process.chdir(tempRoot);

  try {
    mkdirSync('logs', { recursive: true });
    mkdirSync('reports', { recursive: true });

    const dayKey = '2030-11-21';
    writeFileSync(path.join('logs', `trades_${dayKey}.jsonl`), '{}\n', 'utf8');
    writeFileSync(path.join('reports', `slot-reports_${dayKey}.log`), 'report\n', 'utf8');
    writeFileSync(path.join('reports', 'state.json'), '{}\n', 'utf8');
    writeFileSync(path.join('reports', 'runtime-status.json'), '{}\n', 'utf8');
    writeFileSync(path.join('reports', 'status-control.json'), '{}\n', 'utf8');
    writeFileSync(path.join('reports', 'polymarket-scalper.pid'), '123\n', 'utf8');
    writeFileSync(path.join('logs', 'events_2029-01-01.jsonl'), '{}\n', 'utf8');

    const runtimeConfig = createConfig({
      ...process.env,
      LOG_DIRECTORY: 'logs',
      REPORTS_DIR: './reports',
      STATE_FILE: './reports/state.json',
    });

    const targets = collectTodayResetTargets(runtimeConfig, dayKey).map((entry) =>
      path.relative(tempRoot, entry).replace(/\\/g, '/')
    );

    assert.deepEqual(
      targets.sort(),
      [
        `logs/trades_${dayKey}.jsonl`,
        'reports/polymarket-scalper.pid',
        'reports/runtime-status.json',
        'reports/status-control.json',
        `reports/slot-reports_${dayKey}.log`,
        'reports/state.json',
      ].sort()
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('package CLI entrypoints use source-first tsx execution and valid bin wrapper', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ) as {
    scripts?: Record<string, string>;
    bin?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.scalper, 'tsx cli/index.ts');
  assert.equal(packageJson.bin?.scalper, 'cli/index.js');
  assert.equal(existsSync(path.join(repoRoot, 'cli', 'index.ts')), true);
  assert.equal(existsSync(path.join(repoRoot, 'cli', 'index.js')), true);
  assert.equal(
    readFileSync(path.join(repoRoot, 'cli', 'index.ts'), 'utf8').includes('tsx/dist/cli.mjs'),
    false
  );
  assert.equal(
    readFileSync(path.join(repoRoot, 'cli', 'index.js'), 'utf8').includes('tsx/dist/cli.mjs'),
    false
  );
});

test('CLI source registers pause, resume, monitor, and dashboard commands', () => {
  const cliSource = readFileSync(path.join(repoRoot, 'cli', 'index.ts'), 'utf8');
  assert.equal(cliSource.includes(".command('pause')"), true);
  assert.equal(cliSource.includes(".command('resume')"), true);
  assert.equal(cliSource.includes(".command('monitor')"), true);
  assert.equal(cliSource.includes(".command('dashboard')"), true);
  assert.equal(cliSource.includes(".option('--watch'"), true);
});

test('dashboard day pnl display prefers day-pnl-state over stale runtime status values', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'cli-day-pnl-state.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/cli-day-pnl-state.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-29T12:01:00.000Z');

  recordDayPnlDelta(12, now, runtimeConfig);
  recordDayPnlDelta(-5, now, runtimeConfig);

  const resolved = resolveDisplayedDayPnl({
    runtimeConfig,
    runtimeStatus: {
      totalDayPnl: 999,
      dayDrawdown: -999,
    },
    now,
  });

  assert.equal(resolved.totalDayPnl, 7);
  assert.equal(resolved.drawdown, -5);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});

test('dashboard day pnl display refreshes when day state file changes on disk', async () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'cli-day-pnl-refresh.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/cli-day-pnl-refresh.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const now = new Date('2026-03-30T13:52:30.000Z');

  recordDayPnlDelta(1.44, now, runtimeConfig);

  const first = resolveDisplayedDayPnl({
    runtimeConfig,
    now,
  });
  assert.equal(first.totalDayPnl, 1.44);
  assert.equal(first.drawdown, 0);

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

  const refreshed = resolveDisplayedDayPnl({
    runtimeConfig,
    now,
  });
  assert.equal(refreshed.totalDayPnl, -0.83);
  assert.equal(refreshed.drawdown, -5.76);

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});
