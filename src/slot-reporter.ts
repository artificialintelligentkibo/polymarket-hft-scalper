import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pruneMapEntries } from './utils.js';

export type SlotOutcome = 'Up' | 'Down';

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
  updatedAt: string;
}

const slotResults = new Map<string, SlotResult>();
const MAX_SLOT_RESULTS = 2_048;
let writeQueue = Promise.resolve();

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
    existing.dayKey = getLocalDayKey(new Date(existing.updatedAt || Date.now()));
    return existing;
  }

  const now = new Date();
  const created: SlotResult = {
    slotKey,
    marketId,
    marketTitle,
    slotStart: slotStart ?? null,
    slotEnd: slotEnd ?? null,
    dayKey: getLocalDayKey(now),
    upPnl: 0,
    downPnl: 0,
    total: 0,
    updatedAt: now.toISOString(),
  };

  slotResults.set(slotKey, created);
  pruneMapEntries(slotResults, MAX_SLOT_RESULTS);
  return created;
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
  data.dayKey = getLocalDayKey(new Date());
  if (outcome === 'Up') {
    data.upPnl += pnl;
  } else {
    data.downPnl += pnl;
  }
  data.total += pnl;
  data.updatedAt = new Date().toISOString();
}

export function getTotalDayPnl(dayKey = getLocalDayKey(new Date())): number {
  return Array.from(slotResults.values())
    .filter((entry) => entry.dayKey === dayKey)
    .reduce((sum, entry) => sum + entry.total, 0);
}

export async function writeSlotReport(slotKey?: string): Promise<string | null> {
  const rows = slotKey
    ? [slotResults.get(slotKey)].filter((entry): entry is SlotResult => entry !== undefined)
    : Array.from(slotResults.values());

  if (rows.length === 0) {
    return null;
  }

  const dayKey = rows[0]?.dayKey ?? getLocalDayKey(new Date());
  const filePath = getReportFilePath(dayKey);
  const payload = formatSlotReport(rows, dayKey);

  const task = writeQueue.then(async () => {
    await mkdir(getReportsDirectory(), { recursive: true });
    await appendFile(filePath, payload, 'utf8');
    return filePath;
  });

  writeQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

function formatSlotReport(rows: readonly SlotResult[], dayKey: string): string {
  const generatedAt = formatLogTimestamp(new Date());
  const totalDayPnl = getTotalDayPnl(dayKey);
  const reportRows = rows.map((entry) => [
    padRight(formatSlotLabel(entry), 30),
    padRight(truncateMarketId(entry.marketId), 23),
    padLeft(formatSigned(entry.upPnl), 9),
    padLeft(formatSigned(entry.downPnl), 9),
    padLeft(formatSigned(entry.total), 9),
  ]);

  const lines = [
    `[${generatedAt}] === SLOT REPORT ===`,
    `${padRight('Slot', 30)} | ${padRight('Market', 23)} | ${padLeft('Up PNL', 9)} | ${padLeft(
      'Down PNL',
      9
    )} | ${padLeft('NET PNL', 9)}`,
    ...reportRows.map((parts) => parts.join(' | ')),
    `TOTAL DAY PNL: ${formatSigned(totalDayPnl)}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
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

function getReportsDirectory(): string {
  return path.resolve(process.cwd(), config.REPORTS_FOLDER);
}

function getReportFilePath(dayKey: string): string {
  return path.join(
    getReportsDirectory(),
    `${config.REPORTS_FILE_PREFIX}_${dayKey}.log`
  );
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

function formatLogTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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

function getLocalDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
