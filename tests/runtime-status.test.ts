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
  const now = new Date();

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

test('runtime status mode reflects current config, not stale file contents', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-mode-truth');
  const runtimeStatusPath = path.join(reportsDir, 'runtime-status.json');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-mode-truth',
    STATE_FILE: './reports/runtime-status-mode-truth/state.json',
    SIMULATION_MODE: 'false',
    DRY_RUN: 'false',
    PAPER_TRADING_ENABLED: 'false',
    PRODUCT_TEST_MODE: 'false',
  });

  writeFileSync(
    runtimeStatusPath,
    `${JSON.stringify({ running: true, mode: 'simulation' }, null, 2)}\n`,
    'utf8'
  );

  const status = writeRuntimeStatus({}, runtimeConfig);
  assert.equal(status.mode, 'production');

  const persisted = JSON.parse(readFileSync(runtimeStatusPath, 'utf8')) as { mode: string };
  assert.equal(persisted.mode, 'production');

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});

test('runtime status mode switches when config changes between simulation and production', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-mode-switch');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const simulationConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-mode-switch',
    STATE_FILE: './reports/runtime-status-mode-switch/state.json',
    SIMULATION_MODE: 'true',
    DRY_RUN: 'true',
    PRODUCT_TEST_MODE: 'false',
  });
  const productionConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-mode-switch',
    STATE_FILE: './reports/runtime-status-mode-switch/state.json',
    SIMULATION_MODE: 'false',
    DRY_RUN: 'false',
    PAPER_TRADING_ENABLED: 'false',
    PRODUCT_TEST_MODE: 'false',
  });

  const simulationStatus = writeRuntimeStatus({}, simulationConfig);
  assert.equal(simulationStatus.mode, 'simulation');

  const productionStatus = writeRuntimeStatus({}, productionConfig);
  assert.equal(productionStatus.mode, 'production');

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});

test('runtime status preserves dust abandonment fields for dashboard visibility', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-dust');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-dust',
    STATE_FILE: './reports/runtime-status-dust/state.json',
  });

  const status = writeRuntimeStatus(
    {
      dustPositionsCount: 1,
      dustAbandonedCount: 1,
      dustAbandonedKeys: ['market-1:YES'],
      blockedExitRemainderShares: 2.86,
      openPositions: [
        {
          marketId: 'market-1',
          title: 'BTC Up or Down',
          slotStart: null,
          slotEnd: null,
          dustAbandoned: true,
          yesShares: 2.86,
          noShares: 0,
          grossExposureShares: 2.86,
          markValueUsd: 0.09,
          unrealizedPnl: -2.77,
          totalPnl: -2.77,
          roiPct: -96.86,
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    runtimeConfig
  );

  assert.equal(status.dustAbandonedCount, 1);
  assert.deepEqual(status.dustAbandonedKeys, ['market-1:YES']);
  assert.equal(status.openPositions[0]?.dustAbandoned, true);

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});

test('runtime status preserves pending MM exposure fields for dashboard visibility', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-mm-pending');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-mm-pending',
    STATE_FILE: './reports/runtime-status-mm-pending/state.json',
  });

  const status = writeRuntimeStatus(
    {
      mmCurrentExposure: 7.79,
      mmPendingExposure: 2.45,
      mmPendingYesShares: 5,
      mmPendingNoShares: 0,
    },
    runtimeConfig
  );

  assert.equal(status.mmCurrentExposure, 7.79);
  assert.equal(status.mmPendingExposure, 2.45);
  assert.equal(status.mmPendingYesShares, 5);
  assert.equal(status.mmPendingNoShares, 0);

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});

test('runtime status preserves wallet fund fields for production header visibility', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-wallet-funds');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-wallet-funds',
    STATE_FILE: './reports/runtime-status-wallet-funds/state.json',
  });

  const status = writeRuntimeStatus(
    {
      walletCashUsd: 83.27,
      portfolioValueUsd: 87.72,
      availableToTradeUsd: 80.82,
    },
    runtimeConfig
  );

  assert.equal(status.walletCashUsd, 83.27);
  assert.equal(status.portfolioValueUsd, 87.72);
  assert.equal(status.availableToTradeUsd, 80.82);

  const persisted = readRuntimeStatus(runtimeConfig);
  assert.ok(persisted);
  assert.equal(persisted.walletCashUsd, 83.27);
  assert.equal(persisted.portfolioValueUsd, 87.72);
  assert.equal(persisted.availableToTradeUsd, 80.82);

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});

test('runtime status preserves strategy layer snapshots and signal layers for dashboard visibility', () => {
  const reportsDir = path.resolve(process.cwd(), 'reports', 'runtime-status-layers');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    REPORTS_DIR: './reports/runtime-status-layers',
    STATE_FILE: './reports/runtime-status-layers/state.json',
  });

  const status = writeRuntimeStatus(
    {
      strategyLayers: [
        {
          layer: 'SNIPER',
          enabled: true,
          status: 'ACTIVE',
          positionCount: 2,
          marketCount: 2,
          exposureUsd: 6.5,
          pnlUsd: 0.42,
        },
        {
          layer: 'MM_QUOTE',
          enabled: true,
          status: 'WATCHING',
          positionCount: 0,
          marketCount: 1,
          exposureUsd: 1.25,
          pnlUsd: 0,
        },
        {
          layer: 'PAIRED_ARB',
          enabled: false,
          status: 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
        {
          layer: 'LOTTERY',
          enabled: true,
          status: 'ACTIVE',
          positionCount: 1,
          marketCount: 1,
          exposureUsd: 0.31,
          pnlUsd: -0.12,
        },
      ],
      globalExposure: {
        sniperUsd: 6.5,
        mmUsd: 1.25,
        pairedArbUsd: 0,
        lotteryUsd: 0.31,
        obiUsd: 0,
        vsUsd: 0,
        totalUsd: 8.06,
        maxUsd: 50,
      },
      lotteryStats: {
        enabled: true,
        totalTickets: 4,
        totalHits: 1,
        activeEntries: 1,
        hitRate: '25.0%',
        totalRiskUsdc: 18.4,
        totalPayoutUsdc: 24.6,
      },
      lastSignals: [
        {
          timestamp: new Date().toISOString(),
          marketId: 'market-1',
          strategyLayer: 'LOTTERY',
          signalType: 'LOTTERY_BUY',
          action: 'BUY',
          outcome: 'NO',
          latencyMs: 712,
        },
      ],
    },
    runtimeConfig
  );

  assert.equal(status.strategyLayers[0]?.layer, 'SNIPER');
  assert.equal(status.strategyLayers[0]?.status, 'ACTIVE');
  assert.equal(status.globalExposure.totalUsd, 8.06);
  assert.equal(status.lotteryStats.totalTickets, 4);
  assert.equal(status.lastSignals[0]?.strategyLayer, 'LOTTERY');

  rmSync(reportsDir, { recursive: true, force: true });
  resetDayPnlStateCache();
});
