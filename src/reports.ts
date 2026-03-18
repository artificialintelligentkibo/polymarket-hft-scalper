import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Outcome } from './clob-fetcher.js';
import type { SignalType } from './strategy-types.js';

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
  readonly simulationMode: boolean;
  readonly dryRun: boolean;
  readonly testMode: boolean;
}

let slotReportQueue = Promise.resolve();
let latencyQueue = Promise.resolve();

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

function resolveLatencyLogPath(value: Date): string {
  const relativePath = config.LATENCY_LOG.replace('YYYY-MM-DD', formatDayKey(value));
  return path.resolve(process.cwd(), relativePath);
}

function formatLatencyLogEntry(entry: LatencyLogEntry): string {
  return [
    `[${formatTimestamp(new Date(entry.timestampMs))}]`,
    `signal=${entry.signalType}`,
    `market=${entry.marketId}`,
    `title="${sanitizeInline(entry.marketTitle)}"`,
    `side=${entry.action}`,
    `outcome=${entry.outcome}`,
    `signalToOrderMs=${formatLatencyValue(entry.latencySignalToOrderMs)}`,
    `roundTripMs=${formatLatencyValue(entry.latencyRoundTripMs)}`,
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
  channel: 'slot-report' | 'latency'
): Promise<void> {
  const task = queue.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, payload, 'utf8');
  });

  void task.catch((error) => {
    console.error(`[reports] Failed to write ${channel} file`, error);
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

function formatTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatLatencyValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.max(0, Math.round(value))}`;
}

function sanitizeInline(value: string): string {
  return String(value || '').replace(/[\r\n"]/g, ' ').trim();
}
