import { getDayPnlState, recordDayPnlDelta } from './day-pnl-state.js';
import { writeSlotReportToFile } from './reports.js';
import { formatDayKey, formatLogTimestamp, pruneMapEntries } from './utils.js';

export type SlotOutcome = 'Up' | 'Down';

export interface SlotMetrics {
  readonly slotKey: string;
  readonly marketId: string;
  readonly marketTitle: string;
  readonly slotStart: string | null;
  readonly slotEnd: string | null;
  readonly dayKey: string;
  readonly upPnl: number;
  readonly downPnl: number;
  readonly total: number;
  readonly entryCount: number;
  readonly fillCount: number;
  readonly skippedCount: number;
  readonly upExposureUsd: number;
  readonly downExposureUsd: number;
  readonly updatedAt: string;
}

interface SlotResult {
  slotKey: string;
  marketId: string;
  marketTitle: string;
  slotStart: string | null;
  slotEnd: string | null;
  dayKey: string;
  upPnl: number;
  downPnl: number;
  total: number;
  entryCount: number;
  fillCount: number;
  skippedCount: number;
  upExposureUsd: number;
  downExposureUsd: number;
  updatedAt: string;
}

const slotResults = new Map<string, SlotResult>();
const MAX_SLOT_RESULTS = 2_048;

export function ensureSlotResult(
  slotKey: string,
  marketId: string,
  marketTitle: string,
  slotStart?: string | null,
  slotEnd?: string | null
): SlotResult {
  const existing = slotResults.get(slotKey);
  if (existing) {
    if (marketTitle && !existing.marketTitle) {
      existing.marketTitle = marketTitle;
    }
    if (slotStart) {
      existing.slotStart = slotStart;
    }
    if (slotEnd) {
      existing.slotEnd = slotEnd;
    }
    existing.dayKey = formatDayKey(new Date(existing.updatedAt || Date.now()));
    return existing;
  }

  const now = new Date();
  const created: SlotResult = {
    slotKey,
    marketId,
    marketTitle,
    slotStart: slotStart ?? null,
    slotEnd: slotEnd ?? null,
    dayKey: formatDayKey(now),
    upPnl: 0,
    downPnl: 0,
    total: 0,
    entryCount: 0,
    fillCount: 0,
    skippedCount: 0,
    upExposureUsd: 0,
    downExposureUsd: 0,
    updatedAt: now.toISOString(),
  };

  slotResults.set(slotKey, created);
  pruneMapEntries(slotResults, MAX_SLOT_RESULTS);
  return created;
}

export function recordExecution(params: {
  slotKey: string;
  marketId: string;
  marketTitle: string;
  outcome: SlotOutcome;
  action: 'BUY' | 'SELL';
  notionalUsd: number;
  slotStart?: string | null;
  slotEnd?: string | null;
}): void {
  const data = ensureSlotResult(
    params.slotKey,
    params.marketId,
    params.marketTitle,
    params.slotStart,
    params.slotEnd
  );
  data.dayKey = formatDayKey(new Date());
  data.fillCount += 1;
  if (params.action === 'BUY') {
    data.entryCount += 1;
  }

  const normalizedNotional = Number.isFinite(params.notionalUsd) ? Math.abs(params.notionalUsd) : 0;
  if (params.outcome === 'Up') {
    data.upExposureUsd = roundCurrency(data.upExposureUsd + normalizedNotional);
  } else {
    data.downExposureUsd = roundCurrency(data.downExposureUsd + normalizedNotional);
  }

  data.updatedAt = new Date().toISOString();
}

export function recordTrade(
  slotKey: string,
  marketId: string,
  marketTitle: string,
  outcome: SlotOutcome,
  pnl: number,
  slotStart?: string | null,
  slotEnd?: string | null
): void {
  const data = ensureSlotResult(slotKey, marketId, marketTitle, slotStart, slotEnd);
  data.dayKey = formatDayKey(new Date());
  if (outcome === 'Up') {
    data.upPnl = roundCurrency(data.upPnl + pnl);
  } else {
    data.downPnl = roundCurrency(data.downPnl + pnl);
  }
  data.total = roundCurrency(data.total + pnl);
  data.updatedAt = new Date().toISOString();
  recordDayPnlDelta(pnl, new Date(data.updatedAt));
}

export function recordSkippedSignal(params: {
  slotKey: string;
  marketId: string;
  marketTitle: string;
  slotStart?: string | null;
  slotEnd?: string | null;
}): void {
  const data = ensureSlotResult(
    params.slotKey,
    params.marketId,
    params.marketTitle,
    params.slotStart,
    params.slotEnd
  );
  data.skippedCount += 1;
  data.updatedAt = new Date().toISOString();
}

export function getSlotMetrics(slotKey: string): SlotMetrics | null {
  const entry = slotResults.get(slotKey);
  return entry ? { ...entry } : null;
}

export function resetSlotReporterState(): void {
  slotResults.clear();
}

export function getTotalDayPnl(dayKey = formatDayKey(new Date())): number {
  if (dayKey === formatDayKey(new Date())) {
    return getDayPnlState().dayPnl;
  }

  return roundCurrency(
    Array.from(slotResults.values())
      .filter((entry) => entry.dayKey === dayKey)
      .reduce((sum, entry) => sum + entry.total, 0)
  );
}

export function printSlotReport(slotKey?: string): void {
  const rows = (slotKey
    ? [slotResults.get(slotKey)].filter((entry): entry is SlotResult => entry !== undefined)
    : Array.from(slotResults.values())
  ).filter(hasReportableActivity);

  if (rows.length === 0) {
    return;
  }

  const dayKey = rows[0]?.dayKey ?? formatDayKey(new Date());
  const totalDayPnl = getTotalDayPnl(dayKey);
  const dayState = getDayPnlState();
  const tableRows = rows.map((entry) => ({
    Slot: truncate(formatSlotLabel(entry), 30),
    Market: `${entry.marketId.slice(0, 12)}...`,
    Entries: entry.entryCount,
    Fills: entry.fillCount,
    Skipped: entry.skippedCount,
    'Up PNL': entry.upPnl.toFixed(2),
    'Down PNL': entry.downPnl.toFixed(2),
    'NET PNL': entry.total.toFixed(2),
  }));

  console.log('\n[slot-report] === SLOT REPORT ===');
  console.table(tableRows);
  console.log(
    `[slot-report] TOTAL DAY PNL (${dayKey}): $${totalDayPnl.toFixed(2)} | Peak: $${dayState.peakPnl.toFixed(2)} | Drawdown: $${dayState.drawdown.toFixed(2)}\n`
  );
  writeSlotReportToFile(formatSlotReport(rows, dayKey), dayKey);
}

function formatSlotReport(rows: readonly SlotResult[], dayKey: string): string {
  const generatedAt = formatLogTimestamp(new Date());
  const totalDayPnl = getTotalDayPnl(dayKey);
  const dayState = getDayPnlState();
  const reportRows = rows.map((entry) => [
    padRight(formatSlotLabel(entry), 30),
    padRight(truncateMarketId(entry.marketId), 23),
    padLeft(String(entry.entryCount), 7),
    padLeft(String(entry.fillCount), 5),
    padLeft(String(entry.skippedCount), 7),
    padLeft(formatSigned(entry.upPnl), 9),
    padLeft(formatSigned(entry.downPnl), 9),
    padLeft(formatSigned(entry.total), 9),
  ]);

  const details = rows.map(
    (entry) =>
      `   metrics | slot=${formatSlotLabel(entry)} | upExposure=${formatSigned(entry.upExposureUsd)} | downExposure=${formatSigned(entry.downExposureUsd)} | entries=${entry.entryCount} | fills=${entry.fillCount}`
  );

  const lines = [
    `[${generatedAt}] === SLOT REPORT ===`,
    `${padRight('Slot', 30)} | ${padRight('Market', 23)} | ${padLeft('Entries', 7)} | ${padLeft(
      'Fills',
      5
    )} | ${padLeft('Skipped', 7)} | ${padLeft('Up PNL', 9)} | ${padLeft('Down PNL', 9)} | ${padLeft('NET PNL', 9)}`,
    ...reportRows.map((parts) => parts.join(' | ')),
    ...details,
    `TOTAL DAY PNL: ${formatSigned(totalDayPnl)} | PEAK PNL: ${formatSigned(dayState.peakPnl)} | DRAWDOWN: ${formatSigned(dayState.drawdown)}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function hasReportableActivity(entry: SlotResult): boolean {
  return entry.fillCount > 0 || Math.abs(entry.total) > 0.000001;
}

function formatSlotLabel(entry: SlotResult): string {
  const assetLabel = extractAssetLabel(entry.marketTitle);
  const timeRange = formatSlotRange(entry.slotStart, entry.slotEnd);

  if (assetLabel && timeRange) {
    return `${assetLabel} ${timeRange}`;
  }

  if (timeRange) {
    return truncate(entry.marketTitle, 18)
      ? `${truncate(entry.marketTitle, 18)} ${timeRange}`
      : timeRange;
  }

  return truncate(entry.marketTitle || entry.marketId, 30);
}

function extractAssetLabel(title: string): string {
  const normalized = String(title || '').trim();
  if (!normalized) {
    return '';
  }

  if (/\b(BTC|BITCOIN)\b/i.test(normalized)) {
    return 'Bitcoin';
  }
  if (/\b(ETH|ETHEREUM)\b/i.test(normalized)) {
    return 'Ethereum';
  }
  if (/\b(SOL|SOLANA)\b/i.test(normalized)) {
    return 'Solana';
  }
  if (/\bXRP\b/i.test(normalized)) {
    return 'XRP';
  }

  return truncate(normalized, 12);
}

function formatSlotRange(slotStart: string | null, slotEnd: string | null): string {
  const start = parseFiniteDate(slotStart);
  const end = parseFiniteDate(slotEnd);
  if (!start || !end) {
    return '';
  }

  return `${formatTime(start)}-${formatTime(end)}`;
}

function truncateMarketId(value: string): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= 14) {
    return normalized;
  }
  return `${normalized.slice(0, 10)}...`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function formatSigned(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  const sign = normalized >= 0 ? '+' : '';
  return `${sign}${normalized.toFixed(2)}`;
}

function formatTime(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseFiniteDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function padRight(value: string, width: number): string {
  return truncate(value, width).padEnd(width, ' ');
}

function padLeft(value: string, width: number): string {
  const truncated = value.length > width ? value.slice(0, width) : value;
  return truncated.padStart(width, ' ');
}

function roundCurrency(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 10_000) / 10_000;
}
