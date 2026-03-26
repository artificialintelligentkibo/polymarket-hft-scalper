import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLatencyPauseState,
  filterSignalsForApiEntryGate,
  filterSignalsForLatencyPause,
  getRequiredSettledShares,
  hasSettledOutcomeBalance,
  pruneLatencyPauseSamples,
  pruneExpiredSettlementCooldowns,
  shouldDeferSignalForSettlement,
} from '../src/index.js';
import type { StrategySignal } from '../src/strategy-types.js';

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
