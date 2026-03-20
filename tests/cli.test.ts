import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModeOverrides,
  applyEnvUpdatesToText,
  collectTodayResetTargets,
} from '../cli/helpers.js';
import { createConfig } from '../src/config.js';

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
