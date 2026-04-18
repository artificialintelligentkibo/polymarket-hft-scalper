import type { IndicatorLogger } from './logger.js';
import type { SnapshotStore } from './snapshot-writer.js';

export interface RetentionOptions {
  readonly store: SnapshotStore;
  readonly logger: IndicatorLogger;
  readonly levelsRetentionMs: number;
  readonly eventsRetentionMs: number;
  readonly intervalMs?: number;
}

export class RetentionRunner {
  private timer: NodeJS.Timeout | null = null;
  private readonly interval: number;

  constructor(private readonly opts: RetentionOptions) {
    this.interval = opts.intervalMs ?? 5 * 60 * 1000;
  }

  start(): void {
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.interval);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnce(): void {
    const now = Date.now();
    const levelsCut = now - this.opts.levelsRetentionMs;
    const eventsCut = now - this.opts.eventsRetentionMs;
    try {
      const levelsRemoved = this.opts.store.deleteLevelsOlderThan(levelsCut);
      const eventsRemoved = this.opts.store.deleteEventsOlderThan(eventsCut);
      this.opts.logger.info('retention_sweep', {
        levelsRemoved,
        eventsRemoved,
        levelsCutoff: levelsCut,
        eventsCutoff: eventsCut,
      });
    } catch (err) {
      this.opts.logger.error('retention_error', { message: (err as Error).message });
    }
  }
}
