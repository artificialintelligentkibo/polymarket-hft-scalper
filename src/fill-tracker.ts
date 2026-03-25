import type { AppConfig } from './config.js';
import type { Outcome, UserTradeFillEvent } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { SignalType } from './strategy-types.js';
import { roundTo } from './utils.js';

const REST_FALLBACK_POLL_INTERVAL_MS = 10_000;
const ORPHAN_FILL_TTL_MS = 60_000;
const REALTIME_FILL_DEDUPE_TTL_MS = 10 * 60_000;

export interface PendingOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly slotKey: string;
  readonly tokenId: string;
  readonly outcome: Outcome;
  readonly side: 'BUY' | 'SELL';
  readonly submittedShares: number;
  readonly submittedPrice: number;
  readonly signalType: SignalType;
  readonly placedAt: number;
  readonly slotEndTime: string;
  readonly lastCheckedAt: number;
  readonly filledSharesSoFar: number;
}

export interface ConfirmedFill {
  readonly orderId: string;
  readonly marketId: string;
  readonly slotKey: string;
  readonly tokenId: string;
  readonly outcome: Outcome;
  readonly side: 'BUY' | 'SELL';
  readonly filledShares: number;
  readonly fillPrice: number;
  readonly signalType: SignalType;
  readonly filledAt: number;
}

export interface FillTrackerClient {
  getOrderStatus(orderId: string): Promise<unknown>;
  cancelOrder(orderId: string): Promise<void>;
}

export interface FillTrackerOptions {
  readonly now?: () => number;
}

interface NormalizedOrderStatus {
  readonly status: string | null;
  readonly filledShares: number;
  readonly fillPrice: number | null;
}

export function normalizeTrackedOrderStatus(value: unknown): NormalizedOrderStatus {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const nestedOrder =
    record.order && typeof record.order === 'object'
      ? (record.order as Record<string, unknown>)
      : {};

  const status = normalizeOptionalString(
    record.status ?? record.orderStatus ?? nestedOrder.status ?? nestedOrder.orderStatus
  );
  const filledShares = normalizeFiniteNumber(
    record.sizeMatched ??
      record.size_matched ??
      record.filledSize ??
      record.filled_size ??
      record.matchedSize ??
      record.matched_size ??
      nestedOrder.sizeMatched ??
      nestedOrder.size_matched ??
      nestedOrder.filledSize ??
      nestedOrder.filled_size
  );
  const fillPrice = normalizeNullableNumber(
    record.avgPrice ??
      record.averagePrice ??
      record.average_price ??
      record.fillPrice ??
      record.fill_price ??
      record.price ??
      nestedOrder.avgPrice ??
      nestedOrder.averagePrice ??
      nestedOrder.average_price ??
      nestedOrder.fillPrice ??
      nestedOrder.fill_price ??
      nestedOrder.price
  );

  return {
    status: status ? status.toLowerCase() : null,
    filledShares: roundTo(Math.max(0, filledShares), 4),
    fillPrice,
  };
}

export function shouldCancelPendingOrder(params: {
  nowMs: number;
  pending: PendingOrder;
  timeoutMs: number;
  cancelBeforeEndMs: number;
}): boolean {
  const timedOut = params.nowMs - params.pending.placedAt > params.timeoutMs;
  const slotEndMs = Date.parse(params.pending.slotEndTime);
  const timeToEndMs = Number.isFinite(slotEndMs)
    ? slotEndMs - params.nowMs
    : Number.POSITIVE_INFINITY;
  return timedOut || timeToEndMs < params.cancelBeforeEndMs;
}

export class FillTracker {
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly confirmedFills: ConfirmedFill[] = [];
  private readonly orphanRealtimeFills = new Map<string, UserTradeFillEvent[]>();
  private readonly processedRealtimeFillKeys = new Map<string, number>();
  private readonly now: () => number;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private realtimeFeedConnected = false;
  private lastFallbackPollAtMs = 0;

  constructor(
    private readonly client: FillTrackerClient,
    private readonly runtimeConfig: AppConfig,
    options: FillTrackerOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  registerPendingOrder(order: PendingOrder): void {
    this.pendingOrders.set(order.orderId, order);
    logger.info('Registered pending order for fill tracking', {
      orderId: order.orderId,
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      submittedShares: order.submittedShares,
      submittedPrice: order.submittedPrice,
    });

    this.applyOrphanRealtimeFills(order.orderId);
  }

  start(): void {
    if (this.pollIntervalId) {
      return;
    }

    this.pollIntervalId = setInterval(() => {
      void this.pollAllPending();
    }, this.runtimeConfig.FILL_POLL_INTERVAL_MS);
    this.pollIntervalId.unref?.();
  }

  stop(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    this.realtimeFeedConnected = false;
  }

  setRealtimeFeedConnected(connected: boolean): void {
    this.realtimeFeedConnected = connected;
    if (connected) {
      this.lastFallbackPollAtMs = 0;
    }
  }

  recordRealtimeFills(events: readonly UserTradeFillEvent[]): void {
    if (events.length === 0) {
      return;
    }

    this.pruneOrphanRealtimeFills();
    this.pruneProcessedRealtimeFillKeys();

    for (const event of events) {
      if (!event.orderId || event.matchedShares <= 0) {
        continue;
      }

      const status = String(event.status ?? '').toLowerCase();
      if (status === 'failed') {
        continue;
      }

      const fillKey = `${event.tradeId}:${event.orderId}`;
      if (this.processedRealtimeFillKeys.has(fillKey)) {
        continue;
      }
      this.processedRealtimeFillKeys.set(fillKey, this.now());

      const pending = this.pendingOrders.get(event.orderId);
      if (pending) {
        this.applyRealtimeFill(pending, event);
        continue;
      }

      const bucket = this.orphanRealtimeFills.get(event.orderId) ?? [];
      bucket.push(event);
      this.orphanRealtimeFills.set(event.orderId, bucket);
    }
  }

  drainConfirmedFills(): ConfirmedFill[] {
    if (this.confirmedFills.length === 0) {
      return [];
    }

    return this.confirmedFills.splice(0, this.confirmedFills.length);
  }

  hasPendingOrderFor(marketId: string, outcome: Outcome): boolean {
    for (const pending of this.pendingOrders.values()) {
      if (pending.marketId === marketId && pending.outcome === outcome) {
        return true;
      }
    }

    return false;
  }

  forgetPendingOrder(orderId: string): void {
    this.pendingOrders.delete(orderId);
    this.orphanRealtimeFills.delete(orderId);
  }

  getPendingCount(): number {
    return this.pendingOrders.size;
  }

  async pollAllPending(): Promise<void> {
    if (this.pollInFlight || this.pendingOrders.size === 0) {
      return;
    }

    const nowMs = this.now();
    const shouldPollRest =
      !this.realtimeFeedConnected &&
      nowMs - this.lastFallbackPollAtMs >= Math.max(
        REST_FALLBACK_POLL_INTERVAL_MS,
        this.runtimeConfig.FILL_POLL_INTERVAL_MS
      );

    if (shouldPollRest) {
      this.lastFallbackPollAtMs = nowMs;
    }

    this.pollInFlight = true;
    try {
      for (const [orderId, pending] of Array.from(this.pendingOrders.entries())) {
        await this.pollPendingOrder(orderId, pending, shouldPollRest);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollPendingOrder(
    orderId: string,
    pending: PendingOrder,
    shouldPollRest: boolean
  ): Promise<void> {
    const nowMs = this.now();
    try {
      if (
        shouldCancelPendingOrder({
          nowMs,
          pending,
          timeoutMs: this.runtimeConfig.FILL_POLL_TIMEOUT_MS,
          cancelBeforeEndMs: this.runtimeConfig.FILL_CANCEL_BEFORE_END_MS,
        })
      ) {
        await this.cancelAndRemove(orderId);
        return;
      }

      if (!shouldPollRest) {
        this.pendingOrders.set(orderId, {
          ...pending,
          lastCheckedAt: nowMs,
        });
        return;
      }

      const orderStatus = await this.client.getOrderStatus(orderId);
      const normalized = normalizeTrackedOrderStatus(orderStatus);
      const nextFilledShares = Math.max(normalized.filledShares, pending.filledSharesSoFar);
      const deltaShares = roundTo(nextFilledShares - pending.filledSharesSoFar, 4);

      if (deltaShares > 0) {
        this.queueConfirmedFill({
          orderId,
          marketId: pending.marketId,
          slotKey: pending.slotKey,
          tokenId: pending.tokenId,
          outcome: pending.outcome,
          side: pending.side,
          filledShares: deltaShares,
          fillPrice: normalized.fillPrice ?? pending.submittedPrice,
          signalType: pending.signalType,
          filledAt: nowMs,
        });

        logger.info('REST fill detected for pending order', {
          orderId,
          marketId: pending.marketId,
          outcome: pending.outcome,
          side: pending.side,
          newFills: deltaShares,
          totalFilled: nextFilledShares,
          submittedShares: pending.submittedShares,
        });
      }

      const nextPending: PendingOrder = {
        ...pending,
        lastCheckedAt: nowMs,
        filledSharesSoFar: nextFilledShares,
      };

      const isTerminal =
        normalized.status === 'filled' ||
        normalized.status === 'cancelled' ||
        normalized.status === 'expired' ||
        normalized.status === 'canceled' ||
        nextFilledShares >= pending.submittedShares * 0.99;

      if (isTerminal) {
        this.pendingOrders.delete(orderId);
        return;
      }

      this.pendingOrders.set(orderId, nextPending);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('Fill poll error for order', { orderId, message });
    }
  }

  private applyRealtimeFill(pending: PendingOrder, event: UserTradeFillEvent): void {
    const cappedDelta = roundTo(
      Math.max(
        0,
        Math.min(
          event.matchedShares,
          Math.max(0, pending.submittedShares - pending.filledSharesSoFar)
        )
      ),
      4
    );
    if (cappedDelta <= 0) {
      return;
    }

    this.queueConfirmedFill({
      orderId: pending.orderId,
      marketId: pending.marketId,
      slotKey: pending.slotKey,
      tokenId: pending.tokenId,
      outcome: pending.outcome,
      side: pending.side,
      filledShares: cappedDelta,
      fillPrice: event.fillPrice,
      signalType: pending.signalType,
      filledAt: event.matchedAtMs,
    });

    const totalFilled = roundTo(pending.filledSharesSoFar + cappedDelta, 4);
    logger.info('Realtime fill detected for pending order', {
      orderId: pending.orderId,
      marketId: pending.marketId,
      outcome: pending.outcome,
      side: pending.side,
      newFills: cappedDelta,
      totalFilled,
      submittedShares: pending.submittedShares,
    });

    if (totalFilled >= pending.submittedShares * 0.99) {
      this.pendingOrders.delete(pending.orderId);
      return;
    }

    this.pendingOrders.set(pending.orderId, {
      ...pending,
      filledSharesSoFar: totalFilled,
      lastCheckedAt: this.now(),
    });
  }

  private applyOrphanRealtimeFills(orderId: string): void {
    const fills = this.orphanRealtimeFills.get(orderId);
    const pending = this.pendingOrders.get(orderId);
    if (!fills || fills.length === 0 || !pending) {
      return;
    }

    this.orphanRealtimeFills.delete(orderId);
    for (const fill of fills) {
      const latestPending = this.pendingOrders.get(orderId);
      if (!latestPending) {
        return;
      }
      this.applyRealtimeFill(latestPending, fill);
    }
  }

  private queueConfirmedFill(fill: ConfirmedFill): void {
    this.confirmedFills.push(fill);
  }

  private async cancelAndRemove(orderId: string): Promise<void> {
    try {
      await this.client.cancelOrder(orderId);
      logger.info('Cancelled unfilled resting order', { orderId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('Cancel failed while removing pending order', { orderId, message });
    } finally {
      this.pendingOrders.delete(orderId);
      this.orphanRealtimeFills.delete(orderId);
    }
  }

  private pruneOrphanRealtimeFills(): void {
    const cutoffMs = this.now() - ORPHAN_FILL_TTL_MS;
    for (const [orderId, fills] of this.orphanRealtimeFills.entries()) {
      const next = fills.filter((fill) => fill.matchedAtMs >= cutoffMs);
      if (next.length === 0) {
        this.orphanRealtimeFills.delete(orderId);
        continue;
      }
      this.orphanRealtimeFills.set(orderId, next);
    }
  }

  private pruneProcessedRealtimeFillKeys(): void {
    const cutoffMs = this.now() - REALTIME_FILL_DEDUPE_TTL_MS;
    for (const [fillKey, recordedAtMs] of this.processedRealtimeFillKeys.entries()) {
      if (recordedAtMs < cutoffMs) {
        this.processedRealtimeFillKeys.delete(fillKey);
      }
    }
  }
}

function normalizeFiniteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeNullableNumber(value: unknown): number | null {
  const normalized = normalizeFiniteNumber(value);
  return normalized > 0 ? roundTo(normalized, 6) : null;
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}
