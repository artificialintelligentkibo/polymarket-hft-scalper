import type { AppConfig } from './config.js';
import type { Outcome } from './clob-fetcher.js';
import { logger } from './logger.js';
import type { SignalType } from './strategy-types.js';
import { roundTo } from './utils.js';

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
  const nestedOrder = (record.order &&
  typeof record.order === 'object'
    ? record.order
    : {}) as Record<string, unknown>;

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
  const timeToEndMs = Number.isFinite(slotEndMs) ? slotEndMs - params.nowMs : Number.POSITIVE_INFINITY;
  return timedOut || timeToEndMs < params.cancelBeforeEndMs;
}

export class FillTracker {
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly confirmedFills: ConfirmedFill[] = [];
  private readonly now: () => number;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private pollInFlight = false;

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
  }

  getPendingCount(): number {
    return this.pendingOrders.size;
  }

  async pollAllPending(): Promise<void> {
    if (this.pollInFlight || this.pendingOrders.size === 0) {
      return;
    }

    this.pollInFlight = true;
    try {
      for (const [orderId, pending] of Array.from(this.pendingOrders.entries())) {
        await this.pollPendingOrder(orderId, pending);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollPendingOrder(orderId: string, pending: PendingOrder): Promise<void> {
    try {
      const orderStatus = await this.client.getOrderStatus(orderId);
      const normalized = normalizeTrackedOrderStatus(orderStatus);
      const nextFilledShares = Math.max(normalized.filledShares, pending.filledSharesSoFar);
      const deltaShares = roundTo(nextFilledShares - pending.filledSharesSoFar, 4);

      if (deltaShares > 0) {
        this.confirmedFills.push({
          orderId,
          marketId: pending.marketId,
          slotKey: pending.slotKey,
          tokenId: pending.tokenId,
          outcome: pending.outcome,
          side: pending.side,
          filledShares: deltaShares,
          fillPrice: normalized.fillPrice ?? pending.submittedPrice,
          signalType: pending.signalType,
          filledAt: this.now(),
        });

        logger.info('Fill detected for pending order', {
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
        lastCheckedAt: this.now(),
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

      if (
        shouldCancelPendingOrder({
          nowMs: this.now(),
          pending: nextPending,
          timeoutMs: this.runtimeConfig.FILL_POLL_TIMEOUT_MS,
          cancelBeforeEndMs: this.runtimeConfig.FILL_CANCEL_BEFORE_END_MS,
        })
      ) {
        await this.cancelAndRemove(orderId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('Fill poll error for order', { orderId, message });
    }
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
