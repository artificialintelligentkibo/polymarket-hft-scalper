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

test('FillTracker emits only fill deltas and keeps partially filled orders pending', async () => {
  let nowMs = 20_000;
  let statusPayload: unknown = {
    status: 'open',
    sizeMatched: '2.5',
    avgPrice: '0.44',
  };

  const tracker = new FillTracker(
    {
      getOrderStatus: async () => statusPayload,
      cancelOrder: async () => undefined,
    },
    createFillTrackerConfig(),
    { now: () => nowMs }
  );

  tracker.registerPendingOrder(createPendingOrder());

  await tracker.pollAllPending();
  const firstDrain = tracker.drainConfirmedFills();
  assert.equal(firstDrain.length, 1);
  assert.equal(firstDrain[0].filledShares, 2.5);
  assert.equal(firstDrain[0].fillPrice, 0.44);
  assert.equal(tracker.hasPendingOrderFor('market-1', 'YES'), true);

  nowMs = 25_000;
  statusPayload = {
    status: 'filled',
    sizeMatched: '4.0',
    avgPrice: '0.45',
  };

  await tracker.pollAllPending();
  const secondDrain = tracker.drainConfirmedFills();
  assert.equal(secondDrain.length, 1);
  assert.equal(secondDrain[0].filledShares, 1.5);
  assert.equal(secondDrain[0].fillPrice, 0.45);
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
