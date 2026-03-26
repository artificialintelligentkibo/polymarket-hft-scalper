import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PairedArbitrageEngine,
  meetsClobMinimums,
  resolveMinimumTradableShares,
  type PairedArbConfig,
  type PairPosition,
} from '../src/paired-arbitrage.js';

function createPairedConfig(overrides: Partial<PairedArbConfig> = {}): PairedArbConfig {
  return {
    enabled: true,
    minNetEdge: 0.02,
    maxPairCost: 0.97,
    targetBalanceRatio: 1,
    balanceTolerance: 0.15,
    maxPositionPerSide: 200,
    minSharesPerLeg: 20,
    maxSharesPerLeg: 80,
    cooldownMs: 0,
    requireBothSidesLiquidity: true,
    minDepthPerSide: 3,
    ...overrides,
  };
}

function createPairPosition(overrides: Partial<PairPosition> = {}): PairPosition {
  return {
    marketId: 'market-1',
    yesShares: 40,
    noShares: 40,
    yesCostBasis: 0.46,
    noCostBasis: 0.47,
    combinedCostBasis: 0.93,
    pairedShares: 40,
    unpairedShares: 0,
    guaranteedPayout: 40,
    guaranteedProfit: 2,
    createdAt: Date.now(),
    lastEntryAt: 0,
    ...overrides,
  };
}

test('resolveMinimumTradableShares enforces both shares and $1 notional floors', () => {
  assert.equal(resolveMinimumTradableShares(0.5, 2), 5);
  assert.equal(resolveMinimumTradableShares(0.03, 20), 33.3334);
});

test('calculateLegSizes blocks paired entries when a low-price leg cannot meet $1 notional', () => {
  const engine = new PairedArbitrageEngine() as any;
  const legSizes = engine.calculateLegSizes({
    position: undefined,
    bestAskYes: 0.03,
    bestAskNo: 0.94,
    depthYes: 20,
    depthNo: 20,
    config: createPairedConfig(),
  });

  assert.deepEqual(legSizes, {
    yesShares: 0,
    noShares: 0,
  });
});

test('canImprovePairCost rejects legs that miss CLOB minimums even when pair cost is attractive', () => {
  const engine = new PairedArbitrageEngine() as any;
  const canImprove = engine.canImprovePairCost(
    createPairPosition(),
    'YES',
    20,
    0.03,
    createPairedConfig()
  );

  assert.equal(meetsClobMinimums(20, 0.03), false);
  assert.equal(canImprove, false);
});

test('generateSignals uses one cross leg and one improve leg for fresh paired entries', () => {
  const engine = new PairedArbitrageEngine();
  const signals = engine.generateSignals({
    market: {
      marketId: 'market-1',
      conditionId: 'market-1',
      title: 'BTC 5m paired arb',
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
    },
    orderbook: {
      marketId: 'market-1',
      title: 'BTC 5m paired arb',
      timestamp: new Date().toISOString(),
      yes: {
        tokenId: 'yes-token',
        bids: [{ price: 0.44, size: 80 }],
        asks: [{ price: 0.45, size: 80 }],
        bestBid: 0.44,
        bestAsk: 0.45,
        midPrice: 0.445,
        spread: 0.01,
        spreadBps: 0,
        depthSharesBid: 80,
        depthSharesAsk: 80,
        depthNotionalBid: 35.2,
        depthNotionalAsk: 36,
        lastTradePrice: 0.445,
        lastTradeSize: 10,
        source: 'rest',
        updatedAt: new Date().toISOString(),
      },
      no: {
        tokenId: 'no-token',
        bids: [{ price: 0.46, size: 80 }],
        asks: [{ price: 0.48, size: 80 }],
        bestBid: 0.46,
        bestAsk: 0.48,
        midPrice: 0.47,
        spread: 0.02,
        spreadBps: 0,
        depthSharesBid: 80,
        depthSharesAsk: 80,
        depthNotionalBid: 36.8,
        depthNotionalAsk: 38.4,
        lastTradePrice: 0.47,
        lastTradeSize: 10,
        source: 'rest',
        updatedAt: new Date().toISOString(),
      },
      combined: {
        combinedBid: 0.9,
        combinedAsk: 0.93,
        combinedMid: 0.915,
        combinedDiscount: 0.07,
        combinedPremium: -0.07,
        pairSpread: 0.03,
      },
    },
    positionManager: {
      getShares: () => 0,
      getAvgEntryPrice: () => 0,
    } as any,
    config: createPairedConfig({
      minNetEdge: 0.03,
    }),
  });

  assert.equal(signals.length, 2);
  assert.equal(signals.filter((signal) => signal.urgency === 'cross').length, 1);
  assert.equal(signals.filter((signal) => signal.urgency === 'improve').length, 1);
  assert.equal(signals.find((signal) => signal.urgency === 'cross')?.outcome, 'YES');
});
