import { logger } from './logger.js';
import { pruneMapEntries, roundTo } from './utils.js';

export type SlotOutcome = 'Up' | 'Down';

interface SlotResult {
  slotKey: string;
  marketId: string;
  marketTitle: string;
  dayKey: string;
  upPnl: number;
  downPnl: number;
  total: number;
  updatedAt: string;
}

const slotResults = new Map<string, SlotResult>();
const MAX_SLOT_RESULTS = 2_048;

export function ensureSlotResult(
  slotKey: string,
  marketId: string,
  marketTitle: string
): SlotResult {
  const existing = slotResults.get(slotKey);
  if (existing) {
    if (marketTitle && !existing.marketTitle) {
      existing.marketTitle = marketTitle;
    }
    existing.dayKey = getLocalDayKey(new Date(existing.updatedAt || Date.now()));
    return existing;
  }

  const now = new Date();
  const created: SlotResult = {
    slotKey,
    marketId,
    marketTitle,
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
  pnl: number
): void {
  const data = ensureSlotResult(slotKey, marketId, marketTitle);
  data.dayKey = getLocalDayKey(new Date());
  if (outcome === 'Up') {
    data.upPnl += pnl;
  } else {
    data.downPnl += pnl;
  }
  data.total += pnl;
  data.updatedAt = new Date().toISOString();
}

export function printSlotReport(slotKey?: string): void {
  const rows = slotKey
    ? [slotResults.get(slotKey)].filter((entry): entry is SlotResult => entry !== undefined)
    : Array.from(slotResults.values());
  const dayKey = rows[0]?.dayKey ?? getLocalDayKey(new Date());
  const totalDayPnl = getTotalDayPnl(dayKey);
  const tableRows = rows.map((entry) => ({
    Slot: truncate(entry.marketTitle || entry.marketId),
    Market: `${entry.marketId.slice(0, 12)}...`,
    'Up PNL': entry.upPnl.toFixed(2),
    'Down PNL': entry.downPnl.toFixed(2),
    'NET PNL': entry.total.toFixed(2),
  }));

  console.log('\n[slot-report] === SLOT REPORT ===');
  console.table(tableRows);
  console.log(`[slot-report] TOTAL DAY PNL (${dayKey}): $${totalDayPnl.toFixed(2)}\n`);
  logger.event('slot-report', 'Slot report emitted', {
    slotKey,
    rows: rows.map((entry) => ({
      slotKey: entry.slotKey,
      marketId: entry.marketId,
      marketTitle: entry.marketTitle,
      upPnl: roundTo(entry.upPnl, 4),
      downPnl: roundTo(entry.downPnl, 4),
      netPnl: roundTo(entry.total, 4),
    })),
    totalDayPnl: roundTo(totalDayPnl, 4),
  });
}

export function getTotalDayPnl(dayKey = getLocalDayKey(new Date())): number {
  return Array.from(slotResults.values())
    .filter((entry) => entry.dayKey === dayKey)
    .reduce((sum, entry) => sum + entry.total, 0);
}

function truncate(value: string): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= 28) {
    return normalized;
  }
  return `${normalized.slice(0, 25)}...`;
}

function getLocalDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
