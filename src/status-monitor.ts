import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { config, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { writeStatusIncidentLog } from './reports.js';
import { asRecord, asString, formatLogTimestamp, getErrorMessage } from './utils.js';

export type PauseSource = 'manual' | 'incident';

export interface PauseStateSnapshot {
  readonly isPaused: boolean;
  readonly reason: string | null;
  readonly source: PauseSource | null;
  readonly since: string | null;
}

export interface IncidentSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly matchedKeywords: readonly string[];
}

export interface StatusControlCommand {
  readonly command: 'pause' | 'resume';
  readonly requestedAt: string;
  readonly reason: string;
}

interface StatusSummaryPayload {
  readonly activeIncidents?: unknown;
}

type FetchLike = typeof fetch;

const STATUS_SUMMARY_URL = 'https://status.polymarket.com/summary.json';
const STATUS_CONTROL_FILE_NAME = 'status-control.json';
const STATUS_REQUEST_TIMEOUT_MS = 15_000;
const INCIDENT_KEYWORDS = [
  'clob',
  'order',
  'confirmation',
  'latency',
  'delay',
  'outage',
  'api',
  'insert',
  'execution',
] as const;

export class StatusMonitor extends EventEmitter {
  private intervalId: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private state: PauseStateSnapshot = {
    isPaused: false,
    reason: null,
    source: null,
    since: null,
  };
  private manualPauseReason: string | null = null;
  private incidentPauseReason: string | null = null;
  private lastIncidentFingerprint: string | null = null;

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = () => Date.now()
  ) {
    super();
  }

  start(): void {
    if (this.intervalId) {
      return;
    }

    void this.checkNow();
    this.intervalId = setInterval(() => {
      void this.checkNow();
    }, this.runtimeConfig.STATUS_CHECK_INTERVAL_MS);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.clearResumeTimer();
  }

  isPaused(): boolean {
    return this.state.isPaused;
  }

  getState(): PauseStateSnapshot {
    return { ...this.state };
  }

  pauseManually(reason = 'Manual pause requested'): void {
    this.manualPauseReason = reason;
    this.clearResumeTimer();
    this.updatePauseState();
  }

  resumeManually(): void {
    this.manualPauseReason = null;
    this.updatePauseState();
  }

  async checkNow(): Promise<void> {
    if (!this.runtimeConfig.AUTO_PAUSE_ON_INCIDENT) {
      return;
    }

    try {
      const response = await fetchStatusSummary(this.fetchImpl);
      if (!response.ok) {
        throw new Error(`Status API returned ${response.status}`);
      }

      const payload = (await response.json()) as StatusSummaryPayload;
      const incidents = extractRelevantIncidents(payload);
      if (incidents.length > 0) {
        this.handleRelevantIncidents(incidents);
        return;
      }

      this.handleHealthyStatus();
    } catch (error) {
      logger.warn('Status monitor check failed', {
        message: getErrorMessage(error),
      });
    }
  }

  private handleRelevantIncidents(incidents: readonly IncidentSummary[]): void {
    const fingerprint = incidents
      .map((incident) => `${incident.id}:${incident.title}:${incident.updatedAt ?? 'n/a'}`)
      .join('|');
    this.incidentPauseReason = buildIncidentReason(incidents);
    this.clearResumeTimer();

    if (this.lastIncidentFingerprint !== fingerprint) {
      this.lastIncidentFingerprint = fingerprint;
      const warning = `BOT PAUSED - Polymarket status issue: ${this.incidentPauseReason}`;
      console.log('');
      console.log(chalk.red.bold('='.repeat(88)));
      console.log(chalk.red.bold(warning));
      console.log(chalk.red.bold('='.repeat(88)));
      console.log('');
      writeStatusIncidentLog(warning, this.now());
      logger.warn('Status monitor detected active Polymarket incident', {
        incidentCount: incidents.length,
        incidents: incidents.map((incident) => ({
          id: incident.id,
          title: incident.title,
          updatedAt: incident.updatedAt,
          matchedKeywords: incident.matchedKeywords,
        })),
      });
    }

    this.updatePauseState();
  }

  private handleHealthyStatus(): void {
    this.lastIncidentFingerprint = null;
    if (!this.incidentPauseReason) {
      return;
    }

    if (this.resumeTimer) {
      return;
    }

    logger.info('Polymarket status looks healthy; starting pause grace timer', {
      pauseGracePeriodMs: this.runtimeConfig.PAUSE_GRACE_PERIOD_MS,
    });

    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      this.incidentPauseReason = null;
      this.updatePauseState();
    }, this.runtimeConfig.PAUSE_GRACE_PERIOD_MS);
    this.resumeTimer.unref?.();
  }

  private updatePauseState(): void {
    const previous = this.state;
    const reason = this.manualPauseReason ?? this.incidentPauseReason;
    const source: PauseSource | null = this.manualPauseReason
      ? 'manual'
      : this.incidentPauseReason
        ? 'incident'
        : null;
    const isPaused = Boolean(reason);
    const next: PauseStateSnapshot = {
      isPaused,
      reason,
      source,
      since:
        isPaused
          ? previous.isPaused && previous.since
            ? previous.since
            : new Date(this.now()).toISOString()
          : null,
    };

    this.state = next;

    if (previous.isPaused === next.isPaused && previous.reason === next.reason) {
      return;
    }

    if (next.isPaused) {
      logger.warn('Pause state enabled', {
        source: next.source,
        reason: next.reason,
      });
      this.emit('pause', next);
      return;
    }

    logger.info('Pause state cleared; bot may resume entries', {
      resumedAt: formatLogTimestamp(new Date(this.now())),
    });
    this.emit('resume', next);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }
}

async function fetchStatusSummary(fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Status API request timed out after ${STATUS_REQUEST_TIMEOUT_MS}ms`));
  }, STATUS_REQUEST_TIMEOUT_MS);
  timeoutId.unref?.();

  try {
    return await fetchImpl(STATUS_SUMMARY_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getStatusControlPath(runtimeConfig: AppConfig = config): string {
  return path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, STATUS_CONTROL_FILE_NAME);
}

export function writeStatusControlCommand(
  command: StatusControlCommand['command'],
  runtimeConfig: AppConfig = config,
  reason = command === 'pause' ? 'Manual pause requested from CLI' : 'Manual resume requested from CLI'
): void {
  const filePath = getStatusControlPath(runtimeConfig);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        command,
        requestedAt: new Date().toISOString(),
        reason,
      } satisfies StatusControlCommand,
      null,
      2
    )}\n`,
    'utf8'
  );
}

export function consumeStatusControlCommand(
  runtimeConfig: AppConfig = config
): StatusControlCommand | null {
  const filePath = getStatusControlPath(runtimeConfig);
  try {
    const payload = readFileSync(filePath, 'utf8').trim();
    rmSync(filePath, { force: true });
    if (!payload) {
      return null;
    }

    const parsed = asRecord(JSON.parse(payload));
    if (!parsed) {
      return null;
    }

    const command = asString(parsed.command).toLowerCase();
    if (command !== 'pause' && command !== 'resume') {
      return null;
    }

    const requestedAt = asString(parsed.requestedAt) || new Date().toISOString();
    const reason =
      asString(parsed.reason) ||
      (command === 'pause'
        ? 'Manual pause requested from CLI'
        : 'Manual resume requested from CLI');

    return {
      command,
      requestedAt,
      reason,
    };
  } catch {
    return null;
  }
}

export function extractRelevantIncidents(payload: StatusSummaryPayload): IncidentSummary[] {
  const activeIncidents = Array.isArray(payload.activeIncidents) ? payload.activeIncidents : [];
  const incidents: IncidentSummary[] = [];

  for (const incident of activeIncidents) {
    const record = asRecord(incident);
    if (!record) {
      continue;
    }

    const title =
      asString(record.name) ||
      asString(record.title) ||
      asString(record.status) ||
      'Polymarket incident';
    const text = [
      title,
      asString(record.message),
      asString(record.impact),
      asString(record.status),
      asString(record.shortlink),
    ]
      .filter(Boolean)
      .join(' ');
    const normalized = text.toLowerCase();
    const matchedKeywords = INCIDENT_KEYWORDS.filter((keyword) => normalized.includes(keyword));
    if (matchedKeywords.length === 0) {
      continue;
    }

    incidents.push({
      id: asString(record.id) || title.toLowerCase().replace(/\s+/g, '-'),
      title,
      updatedAt: asString(record.updated_at) || asString(record.updatedAt) || null,
      matchedKeywords,
    });
  }

  return incidents;
}

function buildIncidentReason(incidents: readonly IncidentSummary[]): string {
  if (incidents.length === 0) {
    return 'Polymarket status incident';
  }

  const primary = incidents[0];
  const suffix = incidents.length > 1 ? ` (+${incidents.length - 1} more)` : '';
  return `${primary.title}${suffix}`;
}
