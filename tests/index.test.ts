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
  resolveSettledOutcomeSellExecution,
  shouldBlockSniperSelectionForApiGate,
  shouldDeferSignalForSettlement,
} from '../src/index.js';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import type { StrategySignal } from '../src/strategy-types.js';
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

  assert.equal(submittedSignal?.shares, 7.7005);
  assert.match(submittedSignal?.reason ?? '', /clamped to settled balance 7\.7005/);
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
