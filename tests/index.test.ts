import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketMakerRuntime,
  evaluateLatencyPauseState,
  filterSignalsForApiEntryGate,
  filterSignalsForLatencyPause,
  filterSignalsForSniperCorrelationLimit,
  getRequiredSettledShares,
  hasSettledOutcomeBalance,
  pruneLatencyPauseSamples,
  pruneExpiredSettlementCooldowns,
  resolveReduceOnlySellGuard,
  reconcileQuoteRefreshPlan,
  resolveSettledOutcomeSellExecution,
  shouldBlockSniperSelectionForApiGate,
  shouldDeferSignalForSettlement,
} from '../src/index.js';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import type { StrategySignal } from '../src/strategy-types.js';
import { resetConfigCache } from '../src/config.js';
import { clearDayPnlStateFile, resetDayPnlStateCache } from '../src/day-pnl-state.js';
import { getSlotMetrics, recordSettlementPnl, resetSlotReporterState } from '../src/slot-reporter.js';

function createSignal(
  overrides: Partial<StrategySignal> = {}
): StrategySignal {
  return {
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down',
    signalType: 'FAIR_VALUE_BUY',
    priority: 100,
    action: 'BUY',
    outcome: 'YES',
    outcomeIndex: 0,
    shares: 12,
    targetPrice: 0.45,
    referencePrice: 0.47,
    tokenPrice: 0.45,
    midPrice: 0.46,
    fairValue: 0.47,
    edgeAmount: 0.02,
    combinedBid: null,
    combinedAsk: null,
    combinedMid: null,
    combinedDiscount: null,
    combinedPremium: null,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: 'passive',
    reduceOnly: false,
    reason: 'test',
    ...overrides,
  };
}

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'BTC Up or Down',
    liquidityUsd: 1000,
    volumeUsd: 2000,
    startTime: '2026-03-26T10:00:00.000Z',
    endTime: '2026-03-26T10:05:00.000Z',
    durationMinutes: 5,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesLabel: 'Up',
    noLabel: 'Down',
    yesOutcomeIndex: 0,
    noOutcomeIndex: 1,
    acceptingOrders: true,
  };
}

function createOrderbook(): MarketOrderbookSnapshot {
  return {
    marketId: 'market-1',
    title: 'BTC Up or Down',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [{ price: 0.44, size: 100 }],
      asks: [{ price: 0.45, size: 100 }],
      bestBid: 0.44,
      bestAsk: 0.45,
      midPrice: 0.445,
      spread: 0.01,
      spreadBps: 0,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 44,
      depthNotionalAsk: 45,
      lastTradePrice: 0.445,
      lastTradeSize: 5,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [{ price: 0.53, size: 100 }],
      asks: [{ price: 0.54, size: 100 }],
      bestBid: 0.53,
      bestAsk: 0.54,
      midPrice: 0.535,
      spread: 0.01,
      spreadBps: 0,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 53,
      depthNotionalAsk: 54,
      lastTradePrice: 0.535,
      lastTradeSize: 5,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.97,
      combinedAsk: 0.99,
      combinedMid: 0.98,
      combinedDiscount: 0.01,
      combinedPremium: -0.01,
      pairSpread: 0.02,
    },
  };
}

function createExecutionReport(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    marketId: 'market-1',
    tokenId: 'yes-token',
    outcome: 'YES',
    side: 'BUY',
    shares: 12,
    price: 0.45,
    notionalUsd: 5.4,
    filledShares: 12,
    fillPrice: 0.45,
    fillConfirmed: true,
    simulation: true,
    wasMaker: null,
    postOnly: false,
    orderType: 'GTC',
    balanceCacheHits: 0,
    balanceCacheMisses: 0,
    balanceCacheHitRatePct: null,
    attemptCount: 1,
    urgency: 'cross',
    ...overrides,
  };
}

test('latency pause activates when rolling average exceeds threshold', () => {
  const evaluation = evaluateLatencyPauseState({
    samples: Array.from({ length: 10 }, () => 900),
    latencyPaused: false,
    pauseThresholdMs: 800,
    resumeThresholdMs: 400,
  });

  assert.equal(evaluation.latencyPaused, true);
  assert.equal(evaluation.transition, 'pause');
  assert.equal((evaluation.averageLatencyMs ?? 0) >= 900, true);
});

test('latency pause deactivates when average drops below resume threshold', () => {
  const evaluation = evaluateLatencyPauseState({
    samples: Array.from({ length: 10 }, () => 300),
    latencyPaused: true,
    pauseThresholdMs: 800,
    resumeThresholdMs: 400,
  });

  assert.equal(evaluation.latencyPaused, false);
  assert.equal(evaluation.transition, 'resume');
  assert.equal((evaluation.averageLatencyMs ?? 0) <= 300, true);
});

test('hysteresis prevents flapping between pause and resume', () => {
  const evaluation = evaluateLatencyPauseState({
    samples: Array.from({ length: 10 }, () => 600),
    latencyPaused: true,
    pauseThresholdMs: 800,
    resumeThresholdMs: 400,
  });

  assert.equal(evaluation.latencyPaused, true);
  assert.equal(evaluation.transition, 'none');
});

test('pruneLatencyPauseSamples removes stale latency history', () => {
  const samples = pruneLatencyPauseSamples(
    [
      { valueMs: 1100, recordedAtMs: 10_000 },
      { valueMs: 900, recordedAtMs: 40_000 },
      { valueMs: 320, recordedAtMs: 96_000 },
    ],
    100_000,
    30_000
  );

  assert.deepEqual(samples, [{ valueMs: 320, recordedAtMs: 96_000 }]);
});

test('stale latency samples no longer justify keeping the gate paused', () => {
  const staleSamples = pruneLatencyPauseSamples(
    [
      { valueMs: 1200, recordedAtMs: 5_000 },
      { valueMs: 1150, recordedAtMs: 6_000 },
      { valueMs: 1000, recordedAtMs: 7_000 },
    ],
    120_000,
    30_000
  );

  const evaluation = evaluateLatencyPauseState({
    samples: staleSamples.map((sample) => sample.valueMs),
    latencyPaused: true,
    pauseThresholdMs: 800,
    resumeThresholdMs: 400,
  });

  assert.equal(staleSamples.length, 0);
  assert.equal(evaluation.averageLatencyMs, null);
  assert.equal(evaluation.transition, 'none');
});

test('exit signals always pass through during latency pause', () => {
  const buySignal = createSignal({
    signalType: 'FAIR_VALUE_BUY',
    action: 'BUY',
    reduceOnly: false,
  });
  const hardStop = createSignal({
    signalType: 'HARD_STOP',
    action: 'SELL',
    reduceOnly: true,
    outcome: 'NO',
    outcomeIndex: 1,
  });
  const fairValueSell = createSignal({
    signalType: 'FAIR_VALUE_SELL',
    action: 'SELL',
    reduceOnly: true,
    outcome: 'NO',
    outcomeIndex: 1,
  });

  const filtered = filterSignalsForLatencyPause(
    [buySignal, hardStop, fairValueSell],
    true
  );

  assert.deepEqual(
    filtered.map((signal) => signal.signalType),
    ['HARD_STOP', 'FAIR_VALUE_SELL']
  );
});

test('exit signals always pass through when sniper correlated entries are suppressed', () => {
  const buySignal = createSignal({
    signalType: 'FAIR_VALUE_BUY',
    action: 'BUY',
    reduceOnly: false,
  });
  const hardStop = createSignal({
    signalType: 'HARD_STOP',
    action: 'SELL',
    reduceOnly: true,
    outcome: 'NO',
    outcomeIndex: 1,
  });
  const sniperExit = createSignal({
    signalType: 'SNIPER_SCALP_EXIT',
    action: 'SELL',
    reduceOnly: true,
    outcome: 'NO',
    outcomeIndex: 1,
  });

  const filtered = filterSignalsForSniperCorrelationLimit(
    [buySignal, hardStop, sniperExit],
    true
  );

  assert.deepEqual(
    filtered.map((signal) => signal.signalType),
    ['HARD_STOP', 'SNIPER_SCALP_EXIT']
  );
});

test('reduce-only signals pass through while the bot is paused', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.statusMonitor = {
    isPaused: () => true,
    getState: () => ({ reason: 'manual pause', source: 'manual' }),
  };
  runtime.recordSkippedSignal = () => {};

  const filtered = runtime.applyPauseFilter(createMarket(), [
    createSignal({ signalType: 'FAIR_VALUE_BUY', action: 'BUY', reduceOnly: false }),
    createSignal({
      signalType: 'TRAILING_TAKE_PROFIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'NO',
      outcomeIndex: 1,
    }),
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.signalType, 'TRAILING_TAKE_PROFIT');
});

test('API entry gate is bypassed in simulation/paper mode so entry signals survive', () => {
  const entrySignal = createSignal({
    signalType: 'PAIRED_ARB_BUY_YES',
    action: 'BUY',
    reduceOnly: false,
  });

  const filtered = filterSignalsForApiEntryGate({
    signals: [entrySignal],
    apiEntryGateOpen: true,
    dryRunMode: true,
    paperTradingEnabled: true,
  });

  assert.equal(filtered.bypassed, true);
  assert.equal(filtered.allowedSignals.length, 1);
  assert.equal(filtered.allowedSignals[0]?.signalType, 'PAIRED_ARB_BUY_YES');
});

test('API entry gate still blocks live entry signals when the gate is open', () => {
  const entrySignal = createSignal({
    signalType: 'PAIRED_ARB_BUY_YES',
    action: 'BUY',
    reduceOnly: false,
  });
  const reduceOnlySignal = createSignal({
    signalType: 'HARD_STOP',
    action: 'SELL',
    reduceOnly: true,
    outcome: 'NO',
    outcomeIndex: 1,
  });

  const filtered = filterSignalsForApiEntryGate({
    signals: [entrySignal, reduceOnlySignal],
    apiEntryGateOpen: true,
    dryRunMode: false,
    paperTradingEnabled: false,
  });

  assert.equal(filtered.bypassed, false);
  assert.deepEqual(
    filtered.allowedSignals.map((signal) => signal.signalType),
    ['HARD_STOP']
  );
});

test('sniper selection bypasses API gate in simulation and paper mode', () => {
  assert.equal(
    shouldBlockSniperSelectionForApiGate({
      apiEntryGateOpen: true,
      dryRunMode: true,
      paperTradingEnabled: true,
    }),
    false
  );

  assert.equal(
    shouldBlockSniperSelectionForApiGate({
      apiEntryGateOpen: true,
      dryRunMode: false,
      paperTradingEnabled: false,
    }),
    true
  );
});

test('settlement cooldown defers sell signals except hard stops', () => {
  assert.equal(
    shouldDeferSignalForSettlement({
      signal: createSignal({
        signalType: 'TRAILING_TAKE_PROFIT',
        action: 'SELL',
        reduceOnly: true,
      }),
      cooldownUntilMs: 10_000,
      nowMs: 5_000,
    }),
    true
  );

  assert.equal(
    shouldDeferSignalForSettlement({
      signal: createSignal({
        signalType: 'HARD_STOP',
        action: 'SELL',
        reduceOnly: true,
      }),
      cooldownUntilMs: 10_000,
      nowMs: 5_000,
    }),
    false
  );

  assert.equal(
    shouldDeferSignalForSettlement({
      signal: createSignal({
        signalType: 'FAIR_VALUE_BUY',
        action: 'BUY',
        reduceOnly: false,
      }),
      cooldownUntilMs: 10_000,
      nowMs: 5_000,
    }),
    false
  );
});

test('pruneExpiredSettlementCooldowns removes expired entries', () => {
  const pruned = pruneExpiredSettlementCooldowns(
    new Map([
      ['market-1:YES', 15_000],
      ['market-1:NO', 4_000],
    ]),
    10_000
  );

  assert.deepEqual(Array.from(pruned.entries()), [['market-1:YES', 15_000]]);
});

test('settled outcome balance requires a small confirmation margin before SELL', () => {
  assert.equal(getRequiredSettledShares(10), 9.9);
  assert.equal(hasSettledOutcomeBalance(9.89, 10), false);
  assert.equal(hasSettledOutcomeBalance(9.9, 10), true);
});

test('settled outcome sell execution clamps live exits to tradable settled balance', () => {
  const result = resolveSettledOutcomeSellExecution({
    signal: createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'NO',
      outcomeIndex: 1,
      shares: 8,
    }),
    availableShares: 7.7005,
    referencePrice: 0.49,
  });

  assert.equal(result.ready, true);
  assert.equal(result.requiredShares, 7.92);
  assert.equal(result.availableShares, 7.7005);
  assert.equal(result.executionShares, 7.7005);
});

test('settled outcome sell execution marks sub-minimum settled dust for redeem cleanup', () => {
  const result = resolveSettledOutcomeSellExecution({
    signal: createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'NO',
      outcomeIndex: 1,
      shares: 8,
    }),
    availableShares: 0.29,
    referencePrice: 0.49,
  });

  assert.equal(result.ready, false);
  assert.equal(result.executionShares, 0);
  assert.equal(result.abandonToRedeem, true);
});

test('reduce-only sell guard blocks sub-minimum exits and reports the blocked remainder', () => {
  const result = resolveReduceOnlySellGuard({
    signal: createSignal({
      signalType: 'TRAILING_TAKE_PROFIT',
      action: 'SELL',
      reduceOnly: true,
      shares: 2.53,
    }),
    availableShares: 2.53,
    referencePrice: 0.5,
  });

  assert.equal(result.skip, true);
  assert.equal(result.reason, 'below_minimum');
  assert.equal(result.executionShares, 0);
  assert.equal(result.blockedRemainderShares, 2.53);
});

test('reduce-only sell guard preserves dust remainder after a valid partial exit', () => {
  const result = resolveReduceOnlySellGuard({
    signal: createSignal({
      signalType: 'TRAILING_TAKE_PROFIT',
      action: 'SELL',
      reduceOnly: true,
      shares: 5,
    }),
    availableShares: 7.53,
    referencePrice: 0.5,
  });

  assert.equal(result.skip, false);
  assert.equal(result.executionShares, 5);
  assert.equal(result.remainingShares, 2.53);
  assert.equal(result.blockedRemainderShares, 2.53);
});

test('sub-minimum reduce-only exits are not submitted to the executor', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 2.53,
    price: 0.5,
  });

  let executorCalls = 0;
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.executor = {
    executeSignal: async () => {
      executorCalls += 1;
      return createExecutionReport({
        side: 'SELL',
        shares: 2.53,
        filledShares: 2.53,
      });
    },
  };
  runtime.recordSkippedSignal = () => {};

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'TRAILING_TAKE_PROFIT',
      action: 'SELL',
      reduceOnly: true,
      shares: 2.53,
      urgency: 'cross',
    }),
    'slot-1'
  );

  assert.equal(result, null);
  assert.equal(executorCalls, 0);
  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), true);
});

test('dust-abandoned reduce-only exits are suppressed on subsequent ticks', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 2.86,
    price: 0.03,
  });

  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  let executorCalls = 0;
  runtime.executor = {
    executeSignal: async () => {
      executorCalls += 1;
      return createExecutionReport({
        side: 'SELL',
        shares: 2.86,
        filledShares: 2.86,
      });
    },
  };
  runtime.recordSkippedSignal = () => {};

  const signal = createSignal({
    signalType: 'SLOT_FLATTEN',
    action: 'SELL',
    reduceOnly: true,
    shares: 2.86,
    targetPrice: 0.03,
    referencePrice: 0.03,
    tokenPrice: 0.03,
    midPrice: 0.03,
    fairValue: 0.03,
    urgency: 'cross',
  });

  await runtime.executeSignal(market, orderbook, positionManager, signal, 'slot-1');
  await runtime.executeSignal(market, orderbook, positionManager, signal, 'slot-1');

  const filtered = runtime.filterDustAbandonedSignals(market, [
    signal,
  ]);

  assert.equal(executorCalls, 0);
  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), true);
  assert.equal(filtered.length, 0);
});

test('dust-abandoned positions are cleared by redeem cleanup', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.dustAbandonedPositions.add('market-1:YES');

  runtime.clearDustAbandonmentForCondition('market-1');

  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), false);
});

test('dust-abandoned positions are pruned when inventory disappears', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.dustAbandonedPositions.add('market-1:YES');

  runtime.pruneDustAbandonedPositions();

  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), false);
});

test('recheckDustAbandonmentOnRecovery lifts flag when bid recovers above CLOB minimum', () => {
  // 2026-04-08 SOL 09:35 regression: position abandoned at $0.09 must be
  // re-eligible to trade when price recovers to ~$0.50.
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();

  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.18,
  });
  runtime.positions.set(market.marketId, positionManager);
  runtime.dustAbandonedPositions.add('market-1:YES');

  // Build a healthy orderbook with bestBid 0.50 — 10 * 0.50 = $5 notional,
  // far above the $1 CLOB minimum.
  const orderbook = createOrderbook();
  (orderbook.yes as any).bestBid = 0.50;
  (orderbook.yes as any).bestAsk = 0.51;

  runtime.recheckDustAbandonmentOnRecovery(market, orderbook);

  assert.equal(
    runtime.dustAbandonedPositions.has('market-1:YES'),
    false,
    'flag must be lifted once notional recovers',
  );
});

test('recheckDustAbandonmentOnRecovery keeps flag when bid is still too low', () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();

  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.18,
  });
  runtime.positions.set(market.marketId, positionManager);
  runtime.dustAbandonedPositions.add('market-1:YES');

  // bestBid 0.08 → 10 * 0.08 = $0.80 < $1 minimum, still abandoned.
  const orderbook = createOrderbook();
  (orderbook.yes as any).bestBid = 0.08;
  (orderbook.yes as any).bestAsk = 0.09;

  runtime.recheckDustAbandonmentOnRecovery(market, orderbook);

  assert.equal(
    runtime.dustAbandonedPositions.has('market-1:YES'),
    true,
    'flag must persist when notional still below minimum',
  );
});

test('recheckDustAbandonmentOnRecovery removes flag when shares are zero', () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();

  // Position manager exists but has no shares (already exited or never had).
  const positionManager = new PositionManager(market.marketId, market.endTime);
  runtime.positions.set(market.marketId, positionManager);
  runtime.dustAbandonedPositions.add('market-1:YES');

  const orderbook = createOrderbook();

  runtime.recheckDustAbandonmentOnRecovery(market, orderbook);

  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), false);
});

test('rememberRestingObiMakerOrder + cancelPendingObiMakerQuotes uses backup registry', async () => {
  // Variant A4: orders that aged out of fillTracker.pendingOrders must still
  // be cancelled via the resting-orders registry.
  const runtime = new MarketMakerRuntime() as any;
  const cancelledOrderIds: string[] = [];
  runtime.executor = {
    cancelOrder: async (orderId: string) => {
      cancelledOrderIds.push(orderId);
    },
  };
  // fillTracker has no record of this order — it's only in our registry.
  runtime.fillTracker = {
    getPendingOrders: () => [],
    forgetPendingOrder: () => {},
  };

  runtime.rememberRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'NO',
    orderId: '0xRESTING_QUOTE_FROM_FIRST_FILL',
  });

  const cancelled = await runtime.cancelPendingObiMakerQuotes({
    marketId: 'market-1',
    outcome: 'NO',
    triggeredBy: 'OBI_MM_QUOTE_ASK',
  });

  assert.equal(cancelled, 1);
  assert.deepEqual(cancelledOrderIds, ['0xRESTING_QUOTE_FROM_FIRST_FILL']);
  assert.equal(
    runtime.getRestingObiMakerOrderIds('market-1', 'NO').length,
    0,
    'registry must be cleared after successful cancel',
  );
});

test('cancelPendingObiMakerQuotes dedupes orders present in both fillTracker and resting registry', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const cancelledOrderIds: string[] = [];
  runtime.executor = {
    cancelOrder: async (orderId: string) => {
      cancelledOrderIds.push(orderId);
    },
  };
  runtime.fillTracker = {
    getPendingOrders: () => [
      {
        orderId: '0xORDER_A',
        marketId: 'market-1',
        outcome: 'YES',
        side: 'SELL',
        signalType: 'OBI_MM_QUOTE_ASK',
        submittedShares: 9,
        submittedPrice: 0.37,
      },
    ],
    forgetPendingOrder: () => {},
  };

  runtime.rememberRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'YES',
    orderId: '0xORDER_A', // duplicate of fillTracker entry
  });
  runtime.rememberRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'YES',
    orderId: '0xORDER_B', // additional entry only in registry
  });

  const cancelled = await runtime.cancelPendingObiMakerQuotes({
    marketId: 'market-1',
    outcome: 'YES',
    triggeredBy: 'OBI_REBALANCE_EXIT',
  });

  assert.equal(cancelled, 2);
  assert.deepEqual(cancelledOrderIds.sort(), ['0xORDER_A', '0xORDER_B']);
});

test('forgetRestingObiMakerOrder removes only the targeted orderId', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.rememberRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'NO',
    orderId: '0xA',
  });
  runtime.rememberRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'NO',
    orderId: '0xB',
  });

  runtime.forgetRestingObiMakerOrder({
    marketId: 'market-1',
    outcome: 'NO',
    orderId: '0xA',
  });

  const remaining = runtime.getRestingObiMakerOrderIds('market-1', 'NO');
  assert.deepEqual(remaining, ['0xB']);
});

test('cancelPendingObiMakerQuotes returns 0 when nothing pending', async () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.executor = {
    cancelOrder: async () => {
      throw new Error('should not be called');
    },
  };
  runtime.fillTracker = {
    getPendingOrders: () => [],
    forgetPendingOrder: () => {},
  };

  const cancelled = await runtime.cancelPendingObiMakerQuotes({
    marketId: 'market-1',
    outcome: 'YES',
    triggeredBy: 'OBI_REBALANCE_EXIT',
  });

  assert.equal(cancelled, 0);
});

test('recheckDustAbandonmentOnRecovery is no-op when not abandoned', () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();

  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.50,
  });
  runtime.positions.set(market.marketId, positionManager);

  const orderbook = createOrderbook();

  // Should not throw, should not add anything.
  runtime.recheckDustAbandonmentOnRecovery(market, orderbook);

  assert.equal(runtime.dustAbandonedPositions.size, 0);
});

// Regression: 2026-04-08 OBI race condition.
//
// When an OBI entry fills, the engine immediately posts a resting
// OBI_MM_QUOTE_ASK that locks the underlying outcome tokens as collateral.
// If the book reverses on the next tick and the engine fires an exit
// (OBI_REBALANCE_EXIT for hard stop / collapse / rebalance, or
// OBI_SCALP_EXIT), the exit is rejected by CLOB with
// "balance is not enough -> sum of active orders: N" because the same
// shares are committed to the resting maker.
//
// Fix: cancelPendingObiMakerQuotes is called before any OBI exit, walking
// the FillTracker for matching maker orders and cancelling them.
test('OBI exit signal cancels pending OBI_MM_QUOTE_ASK before submitting exit', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 8,
    price: 0.39,
  });

  const cancelledOrderIds: string[] = [];
  const callOrder: string[] = [];

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.executor = {
    executeSignal: async () => {
      callOrder.push('executeSignal');
      return createExecutionReport({
        side: 'SELL',
        shares: 8,
        filledShares: 8,
        fillPrice: 0.32,
        simulation: false,
      });
    },
    cancelOrder: async (orderId: string) => {
      callOrder.push(`cancelOrder:${orderId}`);
      cancelledOrderIds.push(orderId);
    },
    getOutcomeTokenBalance: async () => 8,
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };
  runtime.fillTracker = {
    getPendingOrders: () => [
      {
        orderId: 'maker-order-1',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'SELL',
        submittedShares: 8,
        submittedPrice: 0.396,
        signalType: 'OBI_MM_QUOTE_ASK',
        placedAt: Date.now(),
        slotEndTime: market.endTime!,
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
    ],
    forgetPendingOrder: () => {},
    hasPendingOrderFor: () => false,
    registerPendingOrder: () => {},
  };
  runtime.recordSkippedSignal = () => {};

  const exitSignal = createSignal({
    signalType: 'OBI_REBALANCE_EXIT',
    action: 'SELL',
    reduceOnly: true,
    shares: 8,
    targetPrice: 0.32,
    referencePrice: 0.39,
    tokenPrice: 0.32,
    midPrice: 0.355,
    fairValue: 0.39,
    urgency: 'cross',
  });

  await runtime.executeSignal(market, orderbook, positionManager, exitSignal, 'slot-1');

  assert.deepEqual(
    cancelledOrderIds,
    ['maker-order-1'],
    'pending OBI_MM_QUOTE_ASK must be cancelled before exit'
  );
  assert.equal(callOrder[0], 'cancelOrder:maker-order-1', 'cancel must happen first');
  assert.equal(callOrder[1], 'executeSignal', 'exit submission must happen after cancel');
});

test('non-OBI exit signal does not cancel pending OBI_MM_QUOTE_ASK', async () => {
  // Sanity: a SLOT_FLATTEN or SNIPER_SCALP_EXIT must not touch OBI maker
  // orders — the helper is scoped to OBI exits only so we don't accidentally
  // interfere with sniper or other layer behaviour.
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 8,
    price: 0.39,
  });

  const cancelledOrderIds: string[] = [];

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.executor = {
    executeSignal: async () =>
      createExecutionReport({
        side: 'SELL',
        shares: 8,
        filledShares: 8,
        simulation: false,
      }),
    cancelOrder: async (orderId: string) => {
      cancelledOrderIds.push(orderId);
    },
    getOutcomeTokenBalance: async () => 8,
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };
  runtime.fillTracker = {
    getPendingOrders: () => [
      {
        orderId: 'maker-order-1',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'SELL',
        submittedShares: 8,
        submittedPrice: 0.396,
        signalType: 'OBI_MM_QUOTE_ASK',
        placedAt: Date.now(),
        slotEndTime: market.endTime!,
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
    ],
    forgetPendingOrder: () => {},
    hasPendingOrderFor: () => false,
    registerPendingOrder: () => {},
  };
  runtime.recordSkippedSignal = () => {};

  const slotFlatten = createSignal({
    signalType: 'SLOT_FLATTEN',
    action: 'SELL',
    reduceOnly: true,
    shares: 8,
    targetPrice: 0.32,
    referencePrice: 0.39,
    tokenPrice: 0.32,
    midPrice: 0.355,
    fairValue: 0.39,
    urgency: 'cross',
  });

  await runtime.executeSignal(market, orderbook, positionManager, slotFlatten, 'slot-1');

  assert.deepEqual(
    cancelledOrderIds,
    [],
    'non-OBI exit signals must not cancel OBI maker orders'
  );
});

test('executeSignal keeps the live pending-order cooldown until fill confirmation arrives', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.recordSkippedSignal = () => {};
  runtime.pendingLiveOrders.set(`${market.marketId}:YES`, Date.now() + 15_000);
  runtime.fillTracker = {
    hasPendingOrderFor: () => false,
  };

  let executorCalls = 0;
  runtime.executor = {
    executeSignal: async () => {
      executorCalls += 1;
      return createExecutionReport({
        simulation: false,
        fillConfirmed: false,
        orderId: 'resting-order',
        tokenId: 'yes-token',
      });
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'MM_QUOTE_BID',
      strategyLayer: 'MM_QUOTE',
      action: 'BUY',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 6,
      targetPrice: 0.44,
      referencePrice: 0.45,
      tokenPrice: 0.44,
      midPrice: 0.445,
      fairValue: 0.45,
      urgency: 'passive',
    }),
    'slot-1'
  );

  assert.equal(result, null);
  assert.equal(executorCalls, 0);
  assert.equal(runtime.hasPendingLiveOrder(`${market.marketId}:YES`), true);
});

test('valid SLOT_FLATTEN orders still execute normally above the minimum size', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  let executorCalls = 0;
  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.executor = {
    getOutcomeTokenBalance: async () => 6,
    executeSignal: async (params: { signal: StrategySignal }) => {
      executorCalls += 1;
      assert.equal(params.signal.signalType, 'SLOT_FLATTEN');
      return createExecutionReport({
        side: 'SELL',
        shares: 6,
        filledShares: 6,
        price: 0.5,
        fillPrice: 0.5,
      });
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'SLOT_FLATTEN',
      action: 'SELL',
      reduceOnly: true,
      shares: 6,
      targetPrice: 0.5,
      referencePrice: 0.5,
      tokenPrice: 0.5,
      midPrice: 0.5,
      fairValue: 0.5,
      urgency: 'cross',
    }),
    'slot-1'
  );

  assert.equal(executorCalls, 1);
  assert.equal(result?.fillConfirmed, true);
  assert.equal(runtime.dustAbandonedPositions.size, 0);
});

test('confirmed sniper buys can trigger a best-effort lottery ticket on the opposite side', async () => {
  const originalLotteryEnabled = process.env.LOTTERY_LAYER_ENABLED;
  const originalLotteryMin = process.env.LOTTERY_MIN_CENTS;
  const originalLotteryMax = process.env.LOTTERY_MAX_CENTS;
  const originalLotteryRisk = process.env.LOTTERY_MAX_RISK_USDC;
  process.env.LOTTERY_LAYER_ENABLED = 'true';
  process.env.LOTTERY_MIN_CENTS = '0.03';
  process.env.LOTTERY_MAX_CENTS = '0.07';
  process.env.LOTTERY_MAX_RISK_USDC = '10';
  resetConfigCache();

  try {
    const runtime = new MarketMakerRuntime() as any;
    const market = createMarket();
    const orderbook = createOrderbook();

    const positionManager = new PositionManager(market.marketId, market.endTime);
    const calls: string[] = [];
    let releaseLottery: (() => void) | null = null;

    runtime.syncRuntimeStatus = () => {};
    runtime.statusMonitor = {
      isPaused: () => false,
      getState: () => ({ reason: null, source: null }),
    };
    runtime.executor = {
      executeSignal: async (params: { signal: StrategySignal }) => {
        calls.push(params.signal.signalType);
        if (params.signal.signalType === 'LOTTERY_BUY') {
          assert.equal(params.signal.outcome, 'NO');
          assert.equal(params.signal.urgency, 'passive');
          assert.equal(params.signal.strategyLayer, 'LOTTERY');
          assert.equal(params.signal.targetPrice, 0.07);
          return new Promise((resolve) => {
            releaseLottery = () =>
              resolve(
                createExecutionReport({
                  orderId: 'lottery-order',
                  tokenId: 'no-token',
                  outcome: 'NO',
                  side: 'BUY',
                  shares: 100,
                  filledShares: 100,
                  price: 0.05,
                  fillPrice: 0.05,
                })
              );
          });
        }

        return createExecutionReport({
          orderId: 'sniper-order',
          tokenId: 'yes-token',
          outcome: 'YES',
          side: 'BUY',
          shares: 6,
          filledShares: 6,
          price: 0.32,
          fillPrice: 0.32,
        });
      },
      invalidateOutcomeBalanceCache: () => {},
      invalidateBalanceValidationCache: () => {},
    };

    const result = await runtime.executeSignal(
      market,
      orderbook,
      positionManager,
      createSignal({
        signalType: 'SNIPER_BUY',
        priority: 1200,
        action: 'BUY',
        outcome: 'YES',
        shares: 6,
        targetPrice: 0.32,
        referencePrice: 0.32,
        tokenPrice: 0.32,
        midPrice: 0.32,
        fairValue: 0.48,
        urgency: 'cross',
        strategyLayer: 'SNIPER',
      }),
      'slot-1'
    );

    assert.equal(result?.fillConfirmed, true);
    assert.equal(positionManager.getShares('YES'), 6);
    assert.equal(positionManager.getShares('NO'), 0);
    assert.equal(runtime.lotteryEngine.getStats().totalTickets, 0);

    await Promise.resolve();
    if (!releaseLottery) {
      throw new Error('Expected lottery follow-on task to start');
    }
    (releaseLottery as () => void)();
    await runtime.flushBackgroundTasks();

    assert.deepEqual(calls, ['SNIPER_BUY', 'LOTTERY_BUY']);
    assert.equal(positionManager.getShares('YES'), 6);
    assert.equal(positionManager.getShares('NO'), 100);
    assert.equal(positionManager.getPositionLayer('NO'), 'LOTTERY');
    assert.equal(runtime.lotteryEngine.getStats().totalTickets, 1);
  } finally {
    process.env.LOTTERY_LAYER_ENABLED = originalLotteryEnabled;
    process.env.LOTTERY_MIN_CENTS = originalLotteryMin;
    process.env.LOTTERY_MAX_CENTS = originalLotteryMax;
    process.env.LOTTERY_MAX_RISK_USDC = originalLotteryRisk;
    resetConfigCache();
  }
});

test('lottery follow-ons do not pollute the displayed average latency', async () => {
  const originalLotteryEnabled = process.env.LOTTERY_LAYER_ENABLED;
  const originalLotteryMin = process.env.LOTTERY_MIN_CENTS;
  const originalLotteryMax = process.env.LOTTERY_MAX_CENTS;
  const originalLotteryRisk = process.env.LOTTERY_MAX_RISK_USDC;
  process.env.LOTTERY_LAYER_ENABLED = 'true';
  process.env.LOTTERY_MIN_CENTS = '0.03';
  process.env.LOTTERY_MAX_CENTS = '0.07';
  process.env.LOTTERY_MAX_RISK_USDC = '10';
  resetConfigCache();

  try {
    const runtime = new MarketMakerRuntime() as any;
    const market = createMarket();
    const orderbook = createOrderbook();
    const positionManager = new PositionManager(market.marketId, market.endTime);

    runtime.syncRuntimeStatus = () => {};
    runtime.statusMonitor = {
      isPaused: () => false,
      getState: () => ({ reason: null, source: null }),
    };
    runtime.executor = {
      executeSignal: async (params: { signal: StrategySignal }) => {
        if (params.signal.signalType === 'LOTTERY_BUY') {
          return createExecutionReport({
            orderId: 'lottery-order',
            tokenId: 'no-token',
            outcome: 'NO',
            side: 'BUY',
            shares: 100,
            filledShares: 100,
            price: 0.05,
            fillPrice: 0.05,
            latencySignalToOrderMs: 2,
            latencyRoundTripMs: 9_000,
          });
        }

        return createExecutionReport({
          orderId: 'sniper-order',
          tokenId: 'yes-token',
          outcome: 'YES',
          side: 'BUY',
          shares: 6,
          filledShares: 6,
          price: 0.32,
          fillPrice: 0.32,
          latencySignalToOrderMs: 80,
          latencyRoundTripMs: 150,
        });
      },
      invalidateOutcomeBalanceCache: () => {},
      invalidateBalanceValidationCache: () => {},
    };

    const result = await runtime.executeSignal(
      market,
      orderbook,
      positionManager,
      createSignal({
        signalType: 'SNIPER_BUY',
        priority: 1200,
        action: 'BUY',
        outcome: 'YES',
        shares: 6,
        targetPrice: 0.32,
        referencePrice: 0.32,
        tokenPrice: 0.32,
        midPrice: 0.32,
        fairValue: 0.48,
        urgency: 'cross',
        strategyLayer: 'SNIPER',
      }),
      'slot-1'
    );

    assert.equal(result?.fillConfirmed, true);
    await runtime.flushBackgroundTasks();

    assert.equal(runtime.getAverageLatencyMs(), 150);
    assert.equal(runtime.recentSignals.some((signal: { signalType: string; latencyMs: number | null }) => signal.signalType === 'LOTTERY_BUY' && signal.latencyMs === 9000), true);
  } finally {
    process.env.LOTTERY_LAYER_ENABLED = originalLotteryEnabled;
    process.env.LOTTERY_MIN_CENTS = originalLotteryMin;
    process.env.LOTTERY_MAX_CENTS = originalLotteryMax;
    process.env.LOTTERY_MAX_RISK_USDC = originalLotteryRisk;
    resetConfigCache();
  }
});

test('live reduce-only exits are clamped to the settled token balance after BUY fills', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'NO',
    side: 'BUY',
    shares: 8,
    price: 0.49,
  });

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.recordSkippedSignal = () => {};
  runtime.settlementStartedAt.set('market-1:NO', Date.now() - 1_000);
  runtime.settlementAttempts.set('market-1:NO', 0);

  let submittedSignal: StrategySignal | null = null;
  runtime.executor = {
    getOutcomeTokenBalance: async () => 7.7005,
    executeSignal: async (params: { signal: StrategySignal }) => {
      submittedSignal = params.signal;
      return createExecutionReport({
        outcome: 'NO',
        side: 'SELL',
        shares: 7.7005,
        filledShares: 7.7005,
        price: 0.49,
        fillPrice: 0.49,
      });
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'NO',
      outcomeIndex: 1,
      shares: 8,
      targetPrice: 0.49,
      referencePrice: 0.49,
      tokenPrice: 0.49,
      midPrice: 0.49,
      fairValue: 0.49,
      urgency: 'cross',
    }),
    'slot-1'
  );

  if (!submittedSignal) {
    throw new Error('Expected the reduce-only exit signal to be submitted.');
  }
  const submitted = submittedSignal as StrategySignal;
  assert.equal(submitted.shares, 7.7005);
  assert.match(submitted.reason, /clamped to settled balance 7\.7005/);
  assert.equal(result?.fillConfirmed, true);
  assert.equal(positionManager.getShares('NO'), 0.2995);
});

test('settled sub-minimum sniper exits are abandoned for redeem instead of retrying forever', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 5,
    price: 0.49,
  });

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.recordSkippedSignal = () => {};
  runtime.settlementStartedAt.set('market-1:YES', Date.now() - 1_000);
  runtime.settlementAttempts.set('market-1:YES', 0);

  let executorCalls = 0;
  runtime.executor = {
    getOutcomeTokenBalance: async () => 4.8092,
    executeSignal: async () => {
      executorCalls += 1;
      return createExecutionReport();
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      shares: 5,
      targetPrice: 0.49,
      referencePrice: 0.49,
      tokenPrice: 0.49,
      midPrice: 0.49,
      fairValue: 0.49,
      urgency: 'cross',
    }),
    'slot-1'
  );

  assert.equal(result, null);
  assert.equal(executorCalls, 0);
  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), true);
  assert.equal(runtime.settlementStartedAt.has('market-1:YES'), false);
});

test('hard stops clamp to wallet balance and abandon sub-minimum live inventory', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 5,
    price: 0.49,
  });

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.recordSkippedSignal = () => {};

  let executorCalls = 0;
  runtime.executor = {
    getOutcomeTokenBalance: async () => 4.7984,
    executeSignal: async () => {
      executorCalls += 1;
      return createExecutionReport();
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'HARD_STOP',
      action: 'SELL',
      reduceOnly: true,
      shares: 5,
      targetPrice: 0.49,
      referencePrice: 0.49,
      tokenPrice: 0.49,
      midPrice: 0.49,
      fairValue: 0.49,
      urgency: 'cross',
    }),
    'slot-1'
  );

  assert.equal(result, null);
  assert.equal(executorCalls, 0);
  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), true);
});

test('failed live sniper exits cancel the resting order and re-arm HARD_STOP fallback', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.45,
  });

  runtime.syncRuntimeStatus = () => {};
  runtime.statusMonitor = {
    isPaused: () => false,
    getState: () => ({ reason: null, source: null }),
  };
  runtime.recordSkippedSignal = () => {};
  runtime.settlementStartedAt.set('market-1:YES', Date.now() - 1_000);
  runtime.settlementAttempts.set('market-1:YES', 0);
  runtime.tradeLogger = {
    logTrade: async () => {},
  };
  runtime.productTestMode = {
    recordExecution: () => {},
  };
  runtime.quotingEngine = {
    activateForMarket: () => {},
  };
  runtime.lotteryEngine = {
    recordExecution: () => {},
    recordExit: () => {},
  };
  runtime.syncBlockedExitRemainderFromInventory = () => {};
  runtime.recordCostBasisFill = () => {};
  runtime.updateLatencyPause = () => {};
  runtime.recordRuntimeSignal = () => {};
  runtime.getAverageLatencyMs = () => null;
  runtime.getLatencyPauseAverageMs = () => null;

  let cancelledOrderId: string | null = null;
  let pendingOrderRegistered = false;
  let fallbackRearmed: { marketId: string; outcome: StrategySignal['outcome'] } | null = null;
  runtime.signalEngine = {
    recordFailedSniperExit: (params: { marketId: string; outcome: StrategySignal['outcome'] }) => {
      fallbackRearmed = params;
    },
  };
  runtime.fillTracker = {
    registerPendingOrder: () => {
      pendingOrderRegistered = true;
    },
    forgetPendingOrder: () => {},
    hasPendingOrderFor: () => false,
  };
  runtime.executor = {
    getOutcomeTokenBalance: async () => 6,
    executeSignal: async () =>
      createExecutionReport({
        simulation: false,
        orderId: 'exit-order',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'SELL',
        shares: 6,
        filledShares: 0,
        fillConfirmed: false,
        price: 0.23,
        fillPrice: null,
        urgency: 'cross',
      }),
    cancelOrder: async (orderId: string) => {
      cancelledOrderId = orderId;
    },
    invalidateOutcomeBalanceCache: () => {},
    invalidateBalanceValidationCache: () => {},
  };

  const result = await runtime.executeSignal(
    market,
    orderbook,
    positionManager,
    createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 6,
      targetPrice: 0.23,
      referencePrice: 0.45,
      tokenPrice: 0.23,
      midPrice: 0.23,
      fairValue: 0.45,
      urgency: 'cross',
    }),
    'slot-1'
  );

  assert.equal(result?.fillConfirmed, false);
  assert.equal(cancelledOrderId, 'exit-order');
  assert.deepEqual(fallbackRearmed, {
    marketId: market.marketId,
    outcome: 'YES',
  });
  assert.equal(pendingOrderRegistered, false);
  assert.equal(runtime.pendingLiveOrders.size, 0);
});

test('abandoning a dust sniper position clears sniper ownership immediately', () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  let cleared: { marketId: string; outcome: StrategySignal['outcome'] } | null = null;
  runtime.signalEngine = {
    clearSniperEntry: (marketId: string, outcome: StrategySignal['outcome']) => {
      cleared = { marketId, outcome };
    },
  };

  runtime.abandonPositionForRedeem({
    market,
    signal: createSignal({
      signalType: 'SNIPER_SCALP_EXIT',
      action: 'SELL',
      reduceOnly: true,
      outcome: 'YES',
      outcomeIndex: 0,
    }),
    requestedShares: 6,
    minimumShares: 10,
    referencePrice: 0.1,
  });

  assert.deepEqual(cleared, {
    marketId: market.marketId,
    outcome: 'YES',
  });
  assert.equal(runtime.dustAbandonedPositions.has('market-1:YES'), true);
});

test('redeem-success clears local runtime positions for settled conditions', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  runtime.syncRuntimeStatus = () => {};
  runtime.resolutionChecker = {
    checkResolution: async () => ({
      conditionId: market.conditionId,
      resolved: false,
      winningOutcome: null,
      yesFinalPrice: null,
      noFinalPrice: null,
      checkedAt: new Date(),
    }),
  };

  await runtime.handleRedeemSuccess({
    timestampMs: Date.now(),
    conditionId: market.conditionId,
    title: market.title,
    redeemedAmount: 6,
    yesShares: 6,
    noShares: 0,
  });

  assert.equal(runtime.positions.has(market.marketId), false);
});

test('redeem-success defers live redeem pnl until payout is verified', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  let syncedOverrides: Record<string, unknown> | null = null;
  runtime.syncRuntimeStatus = (overrides: Record<string, unknown>) => {
    syncedOverrides = overrides;
  };
  runtime.costBasisLedger.recordBuy({
    conditionId: market.conditionId,
    marketTitle: market.title,
    shares: 6,
    price: 0.5,
  });
  runtime.resolutionChecker = {
    checkResolution: async () => ({
      conditionId: market.conditionId,
      resolved: false,
      winningOutcome: null,
      yesFinalPrice: 0.52,
      noFinalPrice: 0.48,
      checkedAt: new Date(),
    }),
  };

  await runtime.handleRedeemSuccess({
    timestampMs: Date.now(),
    conditionId: market.conditionId,
    title: market.title,
    redeemedAmount: 6,
    yesShares: 6,
    noShares: 0,
  });

  assert.equal(runtime.redeemPnlToday, 0);
  assert.equal(runtime.costBasisLedger.size, 0);
  assert.equal(runtime.positions.has(market.marketId), false);
  assert.deepEqual(syncedOverrides, {});
});

test('redeem-success records redeem pnl when the winning outcome is verified', async () => {
  resetSlotReporterState();
  resetDayPnlStateCache();
  clearDayPnlStateFile();
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  let syncedOverrides: Record<string, unknown> | null = null;
  runtime.syncRuntimeStatus = (overrides: Record<string, unknown>) => {
    syncedOverrides = overrides;
  };
  runtime.costBasisLedger.recordBuy({
    conditionId: market.conditionId,
    marketTitle: market.title,
    shares: 6,
    price: 0.5,
  });
  runtime.resolutionChecker = {
    checkResolution: async () => ({
      conditionId: market.conditionId,
      resolved: true,
      winningOutcome: 'YES',
      yesFinalPrice: 1,
      noFinalPrice: 0,
      checkedAt: new Date(),
    }),
  };

  await runtime.handleRedeemSuccess({
    timestampMs: Date.now(),
    conditionId: market.conditionId,
    title: market.title,
    redeemedAmount: 6,
    yesShares: 6,
    noShares: 0,
  });

  assert.equal(runtime.redeemPnlToday, 3);
  assert.equal(runtime.costBasisLedger.size, 0);
  assert.equal(runtime.positions.has(market.marketId), false);
  assert.ok(syncedOverrides);
  assert.equal(typeof syncedOverrides['totalDayPnl'], 'number');
  assert.equal(typeof syncedOverrides['dayDrawdown'], 'number');
  const slotMetrics = getSlotMetrics(`${market.marketId}:${market.startTime}:${market.endTime}`);
  assert.equal(slotMetrics?.total, 3);
  clearDayPnlStateFile();
  resetDayPnlStateCache();
});

test('slot report snapshots reflect settlement pnl after a report refresh', () => {
  resetSlotReporterState();
  resetDayPnlStateCache();
  clearDayPnlStateFile();

  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  let syncedOverrides: Record<string, unknown> | null = null;
  runtime.syncRuntimeStatus = (overrides: Record<string, unknown>) => {
    syncedOverrides = overrides;
  };
  runtime.markets.set(market.marketId, market);

  recordSettlementPnl({
    slotKey: `${market.marketId}:${market.startTime}:${market.endTime}`,
    marketId: market.marketId,
    marketTitle: market.title,
    pnl: 1.75,
    outcome: 'Up',
    slotStart: market.startTime,
    slotEnd: market.endTime,
    now: new Date(),
  });

  runtime.writeSlotReportSnapshot(`${market.marketId}:${market.startTime}:${market.endTime}`);

  const slotMetrics = getSlotMetrics(`${market.marketId}:${market.startTime}:${market.endTime}`);
  assert.equal(slotMetrics?.total, 1.75);
  assert.equal(slotMetrics?.upPnl, 1.75);
  assert.ok(syncedOverrides);
  const lastSlotReport = syncedOverrides?.['lastSlotReport'] as { netPnl?: number } | undefined;
  assert.equal(lastSlotReport?.netPnl, 1.75);
  clearDayPnlStateFile();
  resetDayPnlStateCache();
});

test('live wallet reconciliation clears zero-balance ghost positions', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  runtime.executor = {
    getOutcomeTokenBalance: async () => 0,
    invalidateOutcomeBalanceCache: () => {},
  };

  await runtime.reconcileLivePositionsWithWallet(true);

  assert.equal(runtime.positions.has(market.marketId), false);
});

test('live wallet reconciliation preserves fresh fills while settlement confirmation is active', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  runtime.settlementStartedAt.set(`${market.marketId}:YES`, Date.now());
  runtime.executor = {
    getOutcomeTokenBalance: async () => 0,
    invalidateOutcomeBalanceCache: () => {},
  };

  await runtime.reconcileLivePositionsWithWallet(true);

  assert.equal(runtime.positions.has(market.marketId), true);
});

test('live wallet reconciliation preserves positions with non-zero balances', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.5,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  runtime.executor = {
    getOutcomeTokenBalance: async (tokenId: string) =>
      tokenId === market.yesTokenId ? 6 : 0,
    invalidateOutcomeBalanceCache: () => {},
  };

  await runtime.reconcileLivePositionsWithWallet(true);

  assert.equal(runtime.positions.has(market.marketId), true);
});

test('wallet-backed live positions appear in runtime snapshots even without local fill state', async () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.walletPositionSnapshots = new Map([
    [
      'wallet-market-1',
      {
        marketId: 'wallet-market-1',
        title: 'Bitcoin Up or Down - March 30, 9:55AM',
        slotStart: null,
        slotEnd: null,
        dustAbandoned: false,
        yesShares: 6,
        noShares: 0,
        grossExposureShares: 6,
        markValueUsd: 0.03,
        unrealizedPnl: -2.25,
        totalPnl: -2.25,
        roiPct: -98.68,
        updatedAt: new Date().toISOString(),
      },
    ],
  ]);
  const snapshots = runtime.buildRuntimePositionSnapshots();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.marketId, 'wallet-market-1');
  assert.equal(snapshots[0]?.yesShares, 6);
  assert.equal(snapshots[0]?.totalPnl, -2.25);
});

test('wallet-backed live positions enrich local runtime snapshots with actual wallet shares', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 4,
    price: 0.4,
  });

  runtime.markets.set(market.marketId, market);
  runtime.positions.set(market.marketId, positionManager);
  runtime.walletPositionSnapshots = new Map([
    [
      market.marketId,
      {
        marketId: market.marketId,
        title: market.title,
        slotStart: null,
        slotEnd: null,
        dustAbandoned: false,
        yesShares: 6,
        noShares: 0,
        grossExposureShares: 6,
        markValueUsd: 2.28,
        unrealizedPnl: -2.25,
        totalPnl: -2.25,
        roiPct: -98.68,
        updatedAt: new Date().toISOString(),
      },
    ],
  ]);
  const snapshots = runtime.buildRuntimePositionSnapshots();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.marketId, market.marketId);
  assert.equal(snapshots[0]?.yesShares, 6);
  assert.equal(snapshots[0]?.markValueUsd, 2.28);
  assert.equal(snapshots[0]?.totalPnl, -2.25);
});

test('pending quote exposure counts only remaining BUY quote shares', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.fillTracker = {
    getPendingOrders: () => [
      {
        orderId: 'quote-buy-yes',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'BUY',
        submittedShares: 8,
        submittedPrice: 0.4,
        signalType: 'MM_QUOTE_BID',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 3,
      },
      {
        orderId: 'quote-buy-no',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'no-token',
        outcome: 'NO',
        side: 'BUY',
        submittedShares: 2,
        submittedPrice: 0.55,
        signalType: 'DYNAMIC_QUOTE_BOTH',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
      {
        orderId: 'quote-sell',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'SELL',
        submittedShares: 5,
        submittedPrice: 0.52,
        signalType: 'MM_QUOTE_ASK',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
      {
        orderId: 'non-quote-buy',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'BUY',
        submittedShares: 9,
        submittedPrice: 0.38,
        signalType: 'FAIR_VALUE_BUY',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
      {
        orderId: 'other-market',
        marketId: 'market-2',
        slotKey: 'slot-2',
        tokenId: 'yes-token-2',
        outcome: 'YES',
        side: 'BUY',
        submittedShares: 7,
        submittedPrice: 0.31,
        signalType: 'MM_QUOTE_BID',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 2,
      },
    ],
  };

  assert.deepEqual(runtime.getPendingQuoteExposure('market-1'), {
    yesShares: 5,
    noShares: 2,
    grossExposureUsd: 3.1,
  });
  assert.deepEqual(runtime.getPendingQuoteExposure(), {
    yesShares: 10,
    noShares: 2,
    grossExposureUsd: 4.65,
  });
});

test('quote refresh retention keeps unchanged pending MM orders in the queue', () => {
  const plan = reconcileQuoteRefreshPlan({
    activeQuoteOrders: [
      {
        orderId: 'quote-1',
        marketId: 'market-1',
        outcome: 'YES',
        action: 'SELL',
        signalType: 'MM_QUOTE_ASK',
        targetPrice: 0.42,
        shares: 6,
        urgency: 'passive',
        placedAtMs: 10_000,
      },
    ],
    refreshedSignals: [
      createSignal({
        signalType: 'MM_QUOTE_ASK',
        action: 'SELL',
        reduceOnly: true,
        outcome: 'YES',
        outcomeIndex: 0,
        shares: 6,
        targetPrice: 0.42,
        urgency: 'passive',
        reason: 'Post-sniper MM ask',
      }),
    ],
    trackedPendingQuoteOrderIds: ['quote-1'],
    nowMs: 12_000,
    minQuoteLifetimeMs: 1500,
    repriceDeadbandTicks: 1,
  });

  assert.equal(plan.keptOrders.length, 1);
  assert.equal(plan.staleOrders.length, 0);
  assert.equal(plan.newSignals.length, 0);
  assert.equal(plan.deadbandRetainedCount, 0);
  assert.equal(plan.oldestQueueAgeMs, 2000);
});

test('quote refresh retention preserves passive MM orders inside the deadband window', () => {
  const plan = reconcileQuoteRefreshPlan({
    activeQuoteOrders: [
      {
        orderId: 'quote-1',
        marketId: 'market-1',
        outcome: 'YES',
        action: 'SELL',
        signalType: 'MM_QUOTE_ASK',
        targetPrice: 0.42,
        shares: 6,
        urgency: 'passive',
        placedAtMs: 10_000,
      },
    ],
    refreshedSignals: [
      createSignal({
        signalType: 'MM_QUOTE_ASK',
        action: 'SELL',
        reduceOnly: true,
        outcome: 'YES',
        outcomeIndex: 0,
        shares: 6,
        targetPrice: 0.425,
        urgency: 'passive',
        reason: 'Post-sniper MM ask',
      }),
    ],
    trackedPendingQuoteOrderIds: ['quote-1'],
    nowMs: 10_900,
    minQuoteLifetimeMs: 1500,
    repriceDeadbandTicks: 1,
  });

  assert.equal(plan.keptOrders.length, 1);
  assert.equal(plan.staleOrders.length, 0);
  assert.equal(plan.newSignals.length, 0);
  assert.equal(plan.deadbandRetainedCount, 1);
});

test('quote refresh retention replaces passive MM orders once they age past the minimum lifetime', () => {
  const plan = reconcileQuoteRefreshPlan({
    activeQuoteOrders: [
      {
        orderId: 'quote-1',
        marketId: 'market-1',
        outcome: 'YES',
        action: 'SELL',
        signalType: 'MM_QUOTE_ASK',
        targetPrice: 0.42,
        shares: 6,
        urgency: 'passive',
        placedAtMs: 10_000,
      },
    ],
    refreshedSignals: [
      createSignal({
        signalType: 'MM_QUOTE_ASK',
        action: 'SELL',
        reduceOnly: true,
        outcome: 'YES',
        outcomeIndex: 0,
        shares: 6,
        targetPrice: 0.425,
        urgency: 'passive',
        reason: 'Post-sniper MM ask',
      }),
    ],
    trackedPendingQuoteOrderIds: ['quote-1'],
    nowMs: 12_000,
    minQuoteLifetimeMs: 1500,
    repriceDeadbandTicks: 1,
  });

  assert.equal(plan.keptOrders.length, 0);
  assert.equal(plan.staleOrders.length, 1);
  assert.equal(plan.newSignals.length, 1);
});

test('tracked resting MM asks block duplicate post-sniper sell placement', () => {
  const runtime = new MarketMakerRuntime() as any;
  runtime.fillTracker = {
    getPendingOrders: () => [],
  };

  assert.equal(
    runtime.hasTrackedRestingMmAskOrder({
      marketId: 'market-1',
      outcome: 'YES',
      quoteOrders: [
        {
          orderId: 'quote-1',
          marketId: 'market-1',
          outcome: 'YES',
          action: 'SELL',
          signalType: 'MM_QUOTE_ASK',
          targetPrice: 0.42,
          shares: 6,
          urgency: 'passive',
          placedAtMs: 10_000,
        },
      ],
    }),
    true
  );

  runtime.fillTracker = {
    getPendingOrders: () => [
      {
        orderId: 'pending-1',
        marketId: 'market-1',
        slotKey: 'slot-1',
        tokenId: 'yes-token',
        outcome: 'YES',
        side: 'SELL',
        submittedShares: 6,
        submittedPrice: 0.42,
        signalType: 'MM_QUOTE_ASK',
        strategyLayer: 'MM_QUOTE',
        placedAt: Date.now(),
        slotEndTime: new Date(Date.now() + 60_000).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      },
    ],
  };

  assert.equal(
    runtime.hasTrackedRestingMmAskOrder({
      marketId: 'market-1',
      outcome: 'YES',
      quoteOrders: [],
    }),
    true
  );
});

test('cancelQuoteOrder keeps tracking when quote cancellation fails', async () => {
  const runtime = new MarketMakerRuntime() as any;
  let forgotPending = 0;
  let forgotQuote = 0;

  runtime.executor = {
    cancelOrder: async () => {
      throw new Error('cancel failed');
    },
  };
  runtime.fillTracker = {
    forgetPendingOrder: () => {
      forgotPending += 1;
    },
  };
  runtime.quotingEngine = {
    forgetQuoteOrder: () => {
      forgotQuote += 1;
    },
  };

  const cancelled = await runtime.cancelQuoteOrder({
    orderId: 'quote-1',
    marketId: 'market-1',
    outcome: 'YES',
    action: 'SELL',
    signalType: 'MM_QUOTE_ASK',
    targetPrice: 0.42,
    shares: 6,
    urgency: 'passive',
    placedAtMs: 10_000,
  });

  assert.equal(cancelled, false);
  assert.equal(forgotPending, 0);
  assert.equal(forgotQuote, 0);
  assert.equal(runtime.pendingLiveOrders.has('market-1:YES'), true);
});

test('layer coordination gives post-sniper MM ask a maker-first window before scalp exit', () => {
  const originalGraceMs = process.env.SNIPER_MAKER_EXIT_GRACE_MS;
  process.env.SNIPER_MAKER_EXIT_GRACE_MS = '2500';
  resetConfigCache();

  try {
    const runtime = new MarketMakerRuntime() as any;
    const market = createMarket();
    const positionManager = new PositionManager(market.marketId, market.endTime);
    const skipped: Array<{ filterReason: string; details: string }> = [];

    runtime.recordSkippedSignal = (params: { filterReason: string; details: string }) => {
      skipped.push(params);
    };
    runtime.quotingEngine = {
      hasActiveMMMarket: () => false,
      getQuoteOrders: () => [],
      getActiveMMMarketIds: () => [],
    };
    runtime.postSniperMakerAskStartedAt.set('market-1:YES', Date.now());

    const filtered = runtime.applyLayerCoordinationFilters(
      market,
      positionManager,
      [
        createSignal({
          signalType: 'SNIPER_SCALP_EXIT',
          action: 'SELL',
          reduceOnly: true,
          outcome: 'YES',
          outcomeIndex: 0,
          shares: 6,
          targetPrice: 0.42,
          referencePrice: 0.35,
          tokenPrice: 0.42,
          midPrice: 0.415,
          fairValue: 0.35,
          urgency: 'cross',
          reason: 'Sniper scalp exit: bid 0.420 repriced 7.00% above entry',
        }),
      ]
    );

    assert.equal(filtered.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.filterReason, 'MM_MAKER_FIRST');
  } finally {
    process.env.SNIPER_MAKER_EXIT_GRACE_MS = originalGraceMs;
    resetConfigCache();
  }
});

test('maker-first coordination does not block sniper time stops', () => {
  const originalGraceMs = process.env.SNIPER_MAKER_EXIT_GRACE_MS;
  process.env.SNIPER_MAKER_EXIT_GRACE_MS = '2500';
  resetConfigCache();

  try {
    const runtime = new MarketMakerRuntime() as any;
    const market = createMarket();
    const positionManager = new PositionManager(market.marketId, market.endTime);

    runtime.recordSkippedSignal = () => {};
    runtime.quotingEngine = {
      hasActiveMMMarket: () => false,
      getQuoteOrders: () => [],
      getActiveMMMarketIds: () => [],
    };
    runtime.postSniperMakerAskStartedAt.set('market-1:YES', Date.now());

    const filtered = runtime.applyLayerCoordinationFilters(
      market,
      positionManager,
      [
        createSignal({
          signalType: 'SNIPER_SCALP_EXIT',
          action: 'SELL',
          reduceOnly: true,
          outcome: 'YES',
          outcomeIndex: 0,
          shares: 6,
          targetPrice: 0.3,
          referencePrice: 0.4,
          tokenPrice: 0.3,
          midPrice: 0.305,
          fairValue: 0.4,
          urgency: 'cross',
          reason: 'Sniper time stop: held 62000ms with pnl -10.00%',
        }),
      ]
    );

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.reason, 'Sniper time stop: held 62000ms with pnl -10.00%');
  } finally {
    process.env.SNIPER_MAKER_EXIT_GRACE_MS = originalGraceMs;
    resetConfigCache();
  }
});

test('executePairedArbAtomic unwinds leg1 when leg2 does not fill', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const calls: StrategySignal[] = [];
  let pendingMarketId: string | null = null;
  runtime.signalEngine.setPairedArbPending = (marketId: string) => {
    pendingMarketId = marketId;
  };
  runtime.executeSignal = async (
    _market: MarketCandidate,
    _orderbook: MarketOrderbookSnapshot,
    _positionManager: PositionManager,
    signal: StrategySignal
  ) => {
    calls.push(signal);
    if (calls.length === 1) {
      return createExecutionReport();
    }
    if (calls.length === 2) {
      return createExecutionReport({
        orderId: 'order-2',
        tokenId: 'no-token',
        outcome: 'NO',
        price: 0.54,
        fillPrice: null,
        filledShares: 0,
        fillConfirmed: false,
      });
    }
    return createExecutionReport({
      orderId: 'order-3',
      side: 'SELL',
      action: 'SELL',
    });
  };

  await runtime.executePairedArbAtomic(
    createMarket(),
    createOrderbook(),
    new PositionManager('market-1'),
    [
      { signal: createSignal({ signalType: 'PAIRED_ARB_BUY_YES', priority: 501, outcome: 'YES', urgency: 'cross' }) },
      { signal: createSignal({ signalType: 'PAIRED_ARB_BUY_NO', priority: 500, outcome: 'NO', outcomeIndex: 1, urgency: 'improve', targetPrice: 0.54, tokenPrice: 0.54, midPrice: 0.535 }) },
    ],
    'slot-1'
  );

  assert.equal(pendingMarketId, 'market-1');
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.signalType, 'HARD_STOP');
  assert.equal(calls[2]?.action, 'SELL');
  assert.equal(calls[2]?.outcome, 'YES');
});

test('executePairedArbAtomic sizes leg2 to the actual leg1 fill', async () => {
  const runtime = new MarketMakerRuntime() as any;
  const calls: StrategySignal[] = [];
  let pendingMarketId: string | null = null;
  runtime.signalEngine.setPairedArbPending = (marketId: string) => {
    pendingMarketId = marketId;
  };
  runtime.executeSignal = async (
    _market: MarketCandidate,
    _orderbook: MarketOrderbookSnapshot,
    _positionManager: PositionManager,
    signal: StrategySignal
  ) => {
    calls.push(signal);
    return createExecutionReport({
      orderId: `order-${calls.length}`,
      tokenId: signal.outcome === 'YES' ? 'yes-token' : 'no-token',
      outcome: signal.outcome,
      price: signal.targetPrice ?? 0.45,
      fillPrice: signal.targetPrice ?? 0.45,
      filledShares: calls.length === 1 ? 11.38 : signal.shares,
    });
  };

  const [leg1, leg2] = await runtime.executePairedArbAtomic(
    createMarket(),
    createOrderbook(),
    new PositionManager('market-1'),
    [
      { signal: createSignal({ signalType: 'PAIRED_ARB_BUY_YES', priority: 501, outcome: 'YES', urgency: 'cross' }) },
      { signal: createSignal({ signalType: 'PAIRED_ARB_BUY_NO', priority: 500, outcome: 'NO', outcomeIndex: 1, urgency: 'cross', targetPrice: 0.54, tokenPrice: 0.54, midPrice: 0.535 }) },
    ],
    'slot-1'
  );

  assert.equal(pendingMarketId, 'market-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.shares, 11.38);
  assert.match(calls[1]?.reason ?? '', /adjusted to match leg1 fill of 11\.38/);
  assert.ok(leg1);
  assert.ok(leg2);
  assert.equal(leg2?.filledShares, 11.38);
});
