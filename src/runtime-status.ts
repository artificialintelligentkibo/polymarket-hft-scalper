import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, isDryRunMode, type AppConfig } from './config.js';
import { getDayPnlState } from './day-pnl-state.js';
import { roundTo } from './utils.js';

export type RuntimeMode = 'simulation' | 'product_test' | 'production';

export interface RuntimeSignalSnapshot {
  readonly timestamp: string;
  readonly marketId: string;
  readonly signalType: string;
  readonly action: 'BUY' | 'SELL';
  readonly outcome: 'YES' | 'NO';
  readonly latencyMs: number | null;
}

export interface RuntimeSlotSnapshot {
  readonly slotLabel: string;
  readonly marketId: string;
  readonly upPnl: number;
  readonly downPnl: number;
  readonly netPnl: number;
  readonly entries: number;
  readonly fills: number;
  readonly reportedAt: string;
}

export interface RuntimeStatusSnapshot {
  readonly updatedAt: string;
  readonly pid: number | null;
  readonly running: boolean;
  readonly mode: RuntimeMode;
  readonly systemStatus: 'OK' | 'PAUSED';
  readonly isPaused: boolean;
  readonly pauseReason: string | null;
  readonly pauseSource: 'manual' | 'incident' | null;
  readonly activeSlotsCount: number;
  readonly totalDayPnl: number;
  readonly dayDrawdown: number;
  readonly averageLatencyMs: number | null;
  readonly lastSignals: readonly RuntimeSignalSnapshot[];
  readonly lastSlotReport: RuntimeSlotSnapshot | null;
}

export function resolveRuntimeMode(runtimeConfig: AppConfig = config): RuntimeMode {
  if (runtimeConfig.PRODUCT_TEST_MODE) {
    return 'product_test';
  }

  if (isDryRunMode(runtimeConfig)) {
    return 'simulation';
  }

  return 'production';
}

export function getRuntimeStatusPath(runtimeConfig: AppConfig = config): string {
  return path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, 'runtime-status.json');
}

export function createRuntimeStatusSnapshot(
  overrides: Partial<RuntimeStatusSnapshot> = {},
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot {
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  return {
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    running: false,
    mode: resolveRuntimeMode(runtimeConfig),
    systemStatus: 'OK',
    isPaused: false,
    pauseReason: null,
    pauseSource: null,
    activeSlotsCount: 0,
    totalDayPnl: dayState.dayPnl,
    dayDrawdown: dayState.drawdown,
    averageLatencyMs: null,
    lastSignals: [],
    lastSlotReport: null,
    ...overrides,
  };
}

export function readRuntimeStatus(
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot | null {
  try {
    const payload = readFileSync(getRuntimeStatusPath(runtimeConfig), 'utf8').trim();
    if (!payload) {
      return null;
    }

    const parsed = JSON.parse(payload) as Partial<RuntimeStatusSnapshot>;
    return normalizeRuntimeStatus(parsed, runtimeConfig);
  } catch {
    return null;
  }
}

export function writeRuntimeStatus(
  overrides: Partial<RuntimeStatusSnapshot>,
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot {
  const next = normalizeRuntimeStatus(
    {
      ...(readRuntimeStatus(runtimeConfig) ?? createRuntimeStatusSnapshot({}, runtimeConfig)),
      ...overrides,
      updatedAt: new Date().toISOString(),
    },
    runtimeConfig
  );

  const filePath = getRuntimeStatusPath(runtimeConfig);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function resetRuntimeStatus(runtimeConfig: AppConfig = config): void {
  try {
    rmSync(getRuntimeStatusPath(runtimeConfig), { force: true });
  } catch {
    // ignore reset cleanup failures
  }
}

function normalizeRuntimeStatus(
  value: Partial<RuntimeStatusSnapshot>,
  runtimeConfig: AppConfig
): RuntimeStatusSnapshot {
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  const isPaused = Boolean(value.isPaused);
  return {
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt.trim()
        ? value.updatedAt
        : new Date().toISOString(),
    pid: typeof value.pid === 'number' && Number.isFinite(value.pid) ? Math.round(value.pid) : null,
    running: Boolean(value.running),
    mode:
      value.mode === 'simulation' || value.mode === 'product_test' || value.mode === 'production'
        ? value.mode
        : resolveRuntimeMode(runtimeConfig),
    systemStatus: isPaused ? 'PAUSED' : 'OK',
    isPaused,
    pauseReason: typeof value.pauseReason === 'string' && value.pauseReason.trim() ? value.pauseReason : null,
    pauseSource:
      value.pauseSource === 'manual' || value.pauseSource === 'incident'
        ? value.pauseSource
        : null,
    activeSlotsCount: normalizeCount(value.activeSlotsCount),
    totalDayPnl: normalizeNumber(value.totalDayPnl, dayState.dayPnl),
    dayDrawdown: normalizeNumber(value.dayDrawdown, dayState.drawdown),
    averageLatencyMs: normalizeNullableNumber(value.averageLatencyMs),
    lastSignals: Array.isArray(value.lastSignals)
      ? value.lastSignals
          .map(normalizeRuntimeSignal)
          .filter((entry): entry is RuntimeSignalSnapshot => entry !== null)
          .slice(-3)
      : [],
    lastSlotReport: normalizeRuntimeSlot(value.lastSlotReport),
  };
}

function normalizeRuntimeSignal(value: unknown): RuntimeSignalSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeSignalSnapshot>;
  const action = record.action === 'BUY' || record.action === 'SELL' ? record.action : null;
  const outcome = record.outcome === 'YES' || record.outcome === 'NO' ? record.outcome : null;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
  const marketId = typeof record.marketId === 'string' ? record.marketId : '';
  const signalType = typeof record.signalType === 'string' ? record.signalType : '';

  if (!action || !outcome || !timestamp || !marketId || !signalType) {
    return null;
  }

  return {
    timestamp,
    marketId,
    signalType,
    action,
    outcome,
    latencyMs: normalizeNullableNumber(record.latencyMs),
  };
}

function normalizeRuntimeSlot(value: unknown): RuntimeSlotSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeSlotSnapshot>;
  if (
    typeof record.slotLabel !== 'string' ||
    typeof record.marketId !== 'string' ||
    typeof record.reportedAt !== 'string'
  ) {
    return null;
  }

  return {
    slotLabel: record.slotLabel,
    marketId: record.marketId,
    upPnl: normalizeNumber(record.upPnl, 0),
    downPnl: normalizeNumber(record.downPnl, 0),
    netPnl: normalizeNumber(record.netPnl, 0),
    entries: normalizeCount(record.entries),
    fills: normalizeCount(record.fills),
    reportedAt: record.reportedAt,
  };
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTo(value, 4);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return roundTo(parsed, 4);
    }
  }

  return roundTo(fallback, 4);
}

function normalizeNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTo(value, 2);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundTo(parsed, 2) : null;
  }

  return null;
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  return 0;
}
