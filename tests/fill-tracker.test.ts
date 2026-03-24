import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import {
  FillTracker,
  normalizeTrackedOrderStatus,
  shouldCancelPendingOrder,
  type PendingOrder,
} from '../src/fill-tracker.js';

function createFillTrackerConfig() {
  return createConfig({
    ...process.env,
    FILL_POLL_INTERVAL_MS: '2500',
    FILL_POLL_TIMEOUT_MS: '120000',
    FILL_CANCEL_BEFORE_END_MS: '20000',
  });
}

function createPendingOrder(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return {
    orderId: 'order-1',
    marketId: 'market-1',
    slotKey: 'slot-1',
    tokenId: 'token-1',
    outcome: 'YES',
    side: 'BUY',
    submittedShares: 4,
    submittedPrice: 0.44,
    signalType: 'FAIR_VALUE_BUY',
    placedAt: 10_000,
    slotEndTime: new Date(100_000).toISOString(),
    lastCheckedAt: 0,
    filledSharesSoFar: 0,
    ...overrides,
  };
}

test('normalizeTrackedOrderStatus parses order fill fields from multiple response shapes', () => {
  const direct = normalizeTrackedOrderStatus({
    status: 'FILLED',
    sizeMatched: '3.5',
    avgPrice: '0.47',
  });
  assert.deepEqual(direct, {
    status: 'filled',
    filledShares: 3.5,
    fillPrice: 0.47,
  });

  const nested = normalizeTrackedOrderStatus({
    order: {
      status: 'open',
      filled_size: '1.25',
      price: '0.42',
    },
  });
  assert.deepEqual(nested, {
    status: 'open',
    filledShares: 1.25,
    fillPrice: 0.42,
  });
});

test('FillTracker confirms fills immediately from realtime WS events', () => {
  const tracker = new FillTracker(
    {
      getOrderStatus: async () => ({ status: 'open', sizeMatched: '0' }),
      cancelOrder: async () => undefined,
    },
    createFillTrackerConfig(),
    { now: () => 20_000 }
  );

  tracker.setRealtimeFeedConnected(true);
  tracker.registerPendingOrder(createPendingOrder());
  tracker.recordRealtimeFills([
    {
      tradeId: 'trade-1',
      orderId: 'order-1',
      marketId: 'market-1',
      tokenId: 'token-1',
      outcome: 'YES',
      side: 'BUY',
      matchedShares: 2.5,
      fillPrice: 0.44,
      status: 'matched',
      matchedAtMs: 20_100,
    },
  ]);

  const fills = tracker.drainConfirmedFills();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].filledShares, 2.5);
  assert.equal(fills[0].fillPrice, 0.44);
  assert.equal(tracker.hasPendingOrderFor('market-1', 'YES'), true);
});

test('FillTracker falls back to REST polling only when realtime feed is unavailable', async () => {
  let nowMs = 20_000;
  let statusPayload: unknown = {
    status: 'open',
    sizeMatched: '2.5',
    avgPrice: '0.44',
  };
  let pollCount = 0;

  const tracker = new FillTracker(
    {
      getOrderStatus: async () => {
        pollCount += 1;
        return statusPayload;
      },
      cancelOrder: async () => undefined,
    },
    createFillTrackerConfig(),
    { now: () => nowMs }
  );

  tracker.setRealtimeFeedConnected(false);
  tracker.registerPendingOrder(createPendingOrder());

  await tracker.pollAllPending();
  assert.equal(pollCount, 1);
  assert.equal(tracker.drainConfirmedFills().length, 1);

  nowMs = 24_000;
  await tracker.pollAllPending();
  assert.equal(pollCount, 1);

  nowMs = 31_500;
  statusPayload = {
    status: 'filled',
    sizeMatched: '4.0',
    avgPrice: '0.45',
  };
  await tracker.pollAllPending();
  assert.equal(pollCount, 2);

  const secondDrain = tracker.drainConfirmedFills();
  assert.equal(secondDrain.length, 1);
  assert.equal(secondDrain[0].filledShares, 1.5);
  assert.equal(tracker.hasPendingOrderFor('market-1', 'YES'), false);
});

test('FillTracker cancels stale orders that are about to age out or reach slot end', async () => {
  let nowMs = 95_000;
  const cancelledOrderIds: string[] = [];
  const tracker = new FillTracker(
    {
      getOrderStatus: async () => ({
        status: 'open',
        sizeMatched: '0',
      }),
      cancelOrder: async (orderId: string) => {
        cancelledOrderIds.push(orderId);
      },
    },
    createFillTrackerConfig(),
    { now: () => nowMs }
  );

  tracker.registerPendingOrder(
    createPendingOrder({
      orderId: 'stale-order',
      placedAt: 0,
      slotEndTime: new Date(nowMs + 5_000).toISOString(),
    })
  );

  await tracker.pollAllPending();

  assert.deepEqual(cancelledOrderIds, ['stale-order']);
  assert.equal(tracker.hasPendingOrderFor('market-1', 'YES'), false);
});

test('shouldCancelPendingOrder returns true for timeout and slot-end thresholds', () => {
  const pending = createPendingOrder({
    placedAt: 0,
    slotEndTime: new Date(40_000).toISOString(),
  });

  assert.equal(
    shouldCancelPendingOrder({
      nowMs: 130_000,
      pending,
      timeoutMs: 120_000,
      cancelBeforeEndMs: 20_000,
    }),
    true
  );

  assert.equal(
    shouldCancelPendingOrder({
      nowMs: 25_500,
      pending,
      timeoutMs: 120_000,
      cancelBeforeEndMs: 20_000,
    }),
    true
  );
});
