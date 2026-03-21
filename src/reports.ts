import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Outcome } from './clob-fetcher.js';
import type { SignalType } from './strategy-types.js';
import { formatLogTimestamp, getErrorMessage, sanitizeInlineText } from './utils.js';

export interface LatencyLogEntry {
  readonly timestampMs: number;
  readonly marketId: string;
  readonly marketTitle: string;
  readonly signalType: SignalType;
  readonly action: 'BUY' | 'SELL';
  readonly outcome: Outcome;
  readonly orderId?: string | null;
  readonly latencySignalToOrderMs?: number;
  readonly latencyRoundTripMs?: number;
  readonly binanceEdge?: boolean;
  readonly binanceMovePct?: number;
  readonly simulationMode: boolean;
  readonly dryRun: boolean;
  readonly testMode: boolean;
}

let slotReportQueue = Promise.resolve();
let latencyQueue = Promise.resolve();
let redeemQueue = Promise.resolve();
let productTestQueue = Promise.resolve();
let statusIncidentQueue = Promise.resolve();
const reportWriteFailures = new Map<
  'slot-report' | 'latency' | 'redeem' | 'product-test' | 'status-incident',
  number
>();

export function getReportsDirectory(): string {
  return path.resolve(process.cwd(), config.REPORTS_DIR);
}

export async function ensureReportsDirectory(): Promise<string> {
  const directory = getReportsDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}

export function writeSlotReportToFile(payload: string, dayKey = formatDayKey(new Date())): void {
  const filePath = path.join(
    getReportsDirectory(),
    `${config.REPORTS_FILE_PREFIX}_${dayKey}.log`
  );
  slotReportQueue = enqueueAppend(slotReportQueue, filePath, payload, 'slot-report');
}

export function writeLatencyLog(entry: LatencyLogEntry): void {
  const line = formatLatencyLogEntry(entry);
  const filePath = resolveLatencyLogPath(new Date(entry.timestampMs));
  latencyQueue = enqueueAppend(latencyQueue, filePath, line, 'latency');
}

export function writeRedeemLog(line: string, timestampMs = Date.now()): void {
  const filePath = path.join(
    getReportsDirectory(),
    `redeem_log_${formatDayKey(new Date(timestampMs))}.log`
  );
  redeemQueue = enqueueAppend(redeemQueue, filePath, ensureTrailingNewline(line), 'redeem');
}

export function writeProductTestSummary(payload: string, timestampMs = Date.now()): void {
  const filePath = path.join(
    getReportsDirectory(),
    `product-test-summary_${formatDayKey(new Date(timestampMs))}.log`
  );
  productTestQueue = enqueueAppend(
    productTestQueue,
    filePath,
    ensureTrailingNewline(payload),
    'product-test'
  );
}

export function writeStatusIncidentLog(line: string, timestampMs = Date.now()): void {
  const filePath = path.join(getReportsDirectory(), 'status-incidents.log');
  const payload = `[${formatLogTimestamp(new Date(timestampMs))}] ${sanitizeInlineText(line)}\n`;
  statusIncidentQueue = enqueueAppend(
    statusIncidentQueue,
    filePath,
    payload,
    'status-incident'
  );
}

function resolveLatencyLogPath(value: Date): string {
  const relativePath = config.LATENCY_LOG.replace('YYYY-MM-DD', formatDayKey(value));
  return path.resolve(process.cwd(), relativePath);
}

function formatLatencyLogEntry(entry: LatencyLogEntry): string {
  return [
    `[${formatLogTimestamp(new Date(entry.timestampMs))}]`,
    `signal=${entry.signalType}`,
    `market=${entry.marketId}`,
    `title="${sanitizeInlineText(entry.marketTitle)}"`,
    `side=${entry.action}`,
    `outcome=${entry.outcome}`,
    `signalToOrderMs=${formatLatencyValue(entry.latencySignalToOrderMs)}`,
    `roundTripMs=${formatLatencyValue(entry.latencyRoundTripMs)}`,
    `binanceEdge=${entry.binanceEdge === true}`,
    `binanceMovePct=${formatPercentValue(entry.binanceMovePct)}`,
    `orderId=${entry.orderId || 'n/a'}`,
    `simulation=${entry.simulationMode}`,
    `dryRun=${entry.dryRun}`,
    `testMode=${entry.testMode}`,
  ].join(' ') + '\n';
}

function enqueueAppend(
  queue: Promise<void>,
  filePath: string,
  payload: string,
  channel: 'slot-report' | 'latency' | 'redeem' | 'product-test' | 'status-incident'
): Promise<void> {
  const task = queue.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, payload, 'utf8');
    reportWriteFailures.delete(channel);
  });

  void task.catch((error) => {
    const failureCount = (reportWriteFailures.get(channel) ?? 0) + 1;
    reportWriteFailures.set(channel, failureCount);
    console.error(
      `[reports] Failed to write ${channel} file (consecutive failures: ${failureCount})`,
      getErrorMessage(error)
    );
  });

  return task.then(
    () => undefined,
    () => undefined
  );
}

function formatDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLatencyValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.max(0, Math.round(value))}`;
}

function formatPercentValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }

  const normalized = value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
  return `${normalized}%`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
