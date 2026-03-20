import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, type AppConfig } from './config.js';
import { formatDayKey, roundTo } from './utils.js';

export interface DayPnlStateSnapshot {
  readonly dayKey: string;
  readonly dayPnl: number;
  readonly peakPnl: number;
  readonly drawdown: number;
  readonly tradingHalted: boolean;
  readonly haltReason: string | null;
  readonly updatedAt: string;
}

export interface DayPnlEvaluation {
  readonly state: DayPnlStateSnapshot;
  readonly justHalted: boolean;
}

interface PersistedDayPnlState extends DayPnlStateSnapshot {}

let stateCache: PersistedDayPnlState | null = null;

export function getDayPnlState(
  now: Date = new Date(),
  runtimeConfig: AppConfig = config
): DayPnlStateSnapshot {
  return { ...loadOrCreateState(now, runtimeConfig) };
}

export function recordDayPnlDelta(
  deltaPnl: number,
  now: Date = new Date(),
  runtimeConfig: AppConfig = config
): DayPnlStateSnapshot {
  const state = loadOrCreateState(now, runtimeConfig);
  if (!Number.isFinite(deltaPnl) || deltaPnl === 0) {
    return { ...state };
  }

  state.dayPnl = roundTo(state.dayPnl + deltaPnl, 4);
  state.peakPnl = roundTo(Math.max(state.peakPnl, state.dayPnl), 4);
  state.drawdown = roundTo(state.dayPnl - state.peakPnl, 4);
  state.updatedAt = now.toISOString();
  persistState(state, runtimeConfig);
  return { ...state };
}

export function evaluateDayDrawdown(
  now: Date = new Date(),
  runtimeConfig: AppConfig = config
): DayPnlEvaluation {
  const state = loadOrCreateState(now, runtimeConfig);
  const threshold = runtimeConfig.strategy.maxDrawdownUsdc;
  const shouldHalt = state.drawdown <= threshold;
  let justHalted = false;

  if (shouldHalt && !state.tradingHalted) {
    state.tradingHalted = true;
    state.haltReason = `Drawdown ${state.drawdown.toFixed(2)} breached limit ${threshold.toFixed(2)}`;
    state.updatedAt = now.toISOString();
    persistState(state, runtimeConfig);
    justHalted = true;
  }

  return {
    state: { ...state },
    justHalted,
  };
}

export function resetDayPnlStateCache(): void {
  stateCache = null;
}

export function resetDayPnlState(
  now: Date = new Date(),
  runtimeConfig: AppConfig = config
): DayPnlStateSnapshot {
  const next = createEmptyState(formatDayKey(now), now.toISOString());
  stateCache = next;
  persistState(next, runtimeConfig);
  return { ...next };
}

export function clearDayPnlStateFile(runtimeConfig: AppConfig = config): void {
  stateCache = null;
  try {
    rmSync(resolveStateFilePath(runtimeConfig), { force: true });
  } catch {
    // ignore reset cleanup failures
  }
}

function loadOrCreateState(
  now: Date,
  runtimeConfig: AppConfig
): PersistedDayPnlState {
  const currentDayKey = formatDayKey(now);
  if (stateCache && stateCache.dayKey === currentDayKey) {
    return stateCache;
  }

  const persisted = readPersistedState(runtimeConfig);
  if (persisted && persisted.dayKey === currentDayKey) {
    stateCache = normalizeState(persisted, currentDayKey, persisted.updatedAt);
    return stateCache;
  }

  stateCache = createEmptyState(currentDayKey, now.toISOString());
  persistState(stateCache, runtimeConfig);
  return stateCache;
}

function readPersistedState(runtimeConfig: AppConfig): PersistedDayPnlState | null {
  try {
    const payload = readFileSync(resolveStateFilePath(runtimeConfig), 'utf8').trim();
    if (!payload) {
      return null;
    }

    const parsed = JSON.parse(payload) as Partial<PersistedDayPnlState>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const dayKey = typeof parsed.dayKey === 'string' ? parsed.dayKey : '';
    if (!dayKey) {
      return null;
    }

    return normalizeState(parsed, dayKey, parsed.updatedAt);
  } catch {
    return null;
  }
}

function persistState(state: PersistedDayPnlState, runtimeConfig: AppConfig): void {
  const filePath = resolveStateFilePath(runtimeConfig);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function normalizeState(
  value: Partial<PersistedDayPnlState>,
  dayKey: string,
  updatedAt?: string
): PersistedDayPnlState {
  return {
    dayKey,
    dayPnl: normalizeFinite(value.dayPnl),
    peakPnl: normalizeFinite(value.peakPnl),
    drawdown: normalizeFinite(value.drawdown),
    tradingHalted: Boolean(value.tradingHalted),
    haltReason: typeof value.haltReason === 'string' ? value.haltReason : null,
    updatedAt:
      typeof updatedAt === 'string' && updatedAt.trim()
        ? updatedAt
        : new Date().toISOString(),
  };
}

function createEmptyState(dayKey: string, updatedAt: string): PersistedDayPnlState {
  return {
    dayKey,
    dayPnl: 0,
    peakPnl: 0,
    drawdown: 0,
    tradingHalted: false,
    haltReason: null,
    updatedAt,
  };
}

function resolveStateFilePath(runtimeConfig: AppConfig): string {
  return path.resolve(process.cwd(), runtimeConfig.STATE_FILE);
}

function normalizeFinite(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? roundTo(numeric, 4) : 0;
}
