import test from 'node:test';
import assert from 'node:assert/strict';
import type { BinanceEdgeAssessment } from '../src/binance-edge.js';
import { createConfig } from '../src/config.js';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import { logger } from '../src/logger.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { SniperEngine, estimateFairValueFromBinance } from '../src/sniper-engine.js';

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'condition-1',
    title: 'BTC Up or Down - 10:00-10:05',
    liquidityUsd: 2500,
    volumeUsd: 8000,
    startTime: '2026-03-31T10:00:00.000Z',
    endTime: '2026-03-31T10:05:00.000Z',
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

function createOrderbook(overrides: Partial<MarketOrderbookSnapshot> = {}): MarketOrderbookSnapshot {
  return {
    marketId: 'market-1',
    title: 'BTC Up or Down - 10:00-10:05',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [{ price: 0.47, size: 80 }],
      asks: [{ price: 0.49, size: 80 }],
      bestBid: 0.47,
      bestAsk: 0.49,
      midPrice: 0.48,
      spread: 0.02,
      spreadBps: 416.67,
      depthSharesBid: 80,
      depthSharesAsk: 80,
      depthNotionalBid: 37.6,
      depthNotionalAsk: 39.2,
      lastTradePrice: 0.48,
      lastTradeSize: 10,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [{ price: 0.49, size: 90 }],
      asks: [{ price: 0.51, size: 90 }],
      bestBid: 0.49,
      bestAsk: 0.51,
      midPrice: 0.5,
      spread: 0.02,
      spreadBps: 400,
      depthSharesBid: 90,
      depthSharesAsk: 90,
      depthNotionalBid: 44.1,
      depthNotionalAsk: 45.9,
      lastTradePrice: 0.5,
      lastTradeSize: 10,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.96,
      combinedAsk: 1.02,
      combinedMid: 0.99,
      combinedDiscount: -0.02,
      combinedPremium: 0.02,
      pairSpread: 0.06,
    },
    ...overrides,
  };
}

function createAssessment(
  overrides: Partial<BinanceEdgeAssessment> = {}
): BinanceEdgeAssessment {
  return {
    available: true,
    coin: 'BTC',
    binancePrice: 84_250,
    slotOpenPrice: 84_000,
    binanceMovePct: 0.25,
    direction: 'UP',
    pmUpMid: 0.48,
    pmImpliedDirection: 'FLAT',
    directionalAgreement: true,
    edgeStrength: 0.25,
    sizeMultiplier: 1.5,
    urgencyBoost: true,
    contraSignal: false,
    ...overrides,
  };
}

function createRuntimeConfig(overrides: Record<string, string> = {}) {
  return createConfig({
    ...process.env,
    SNIPER_MODE_ENABLED: 'true',
    BINANCE_EDGE_ENABLED: 'true',
    ...overrides,
  });
}

test('estimateFairValueFromBinance increases probability for favorable moves', () => {
  const favorable = estimateFairValueFromBinance(0.3, 'UP', 'YES', 0.003);
  const unfavorable = estimateFairValueFromBinance(0.3, 'UP', 'NO', 0.003);

  assert.ok(favorable > 0.5);
  assert.ok(unfavorable < 0.5);
});

test('sniper engine generates a BUY signal when Binance edge is large and PM still lags', () => {
  const runtimeConfig = createRuntimeConfig();
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const orderbook = createOrderbook({
    yes: {
      ...createOrderbook().yes,
      bestAsk: 0.52,
      midPrice: 0.5,
    },
  });

  const signals = engine.generateSignals({
    market,
    orderbook,
    positionManager,
    binanceAssessment: createAssessment(),
    binanceVelocityPctPerSec: 0.02,
    config: runtimeConfig.sniper,
    blockedOutcomes: new Set(),
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, 'SNIPER_BUY');
  assert.equal(signals[0]?.action, 'BUY');
  assert.equal(signals[0]?.outcome, 'YES');
  assert.equal(signals[0]?.urgency, 'cross');
});

test('sniper engine skips entry when Polymarket already repriced and lag is too small', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_MIN_PM_LAG: '0.03',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const orderbook = createOrderbook({
    yes: {
      ...createOrderbook().yes,
      bestAsk: 0.63,
      midPrice: 0.62,
    },
  });

  const signals = engine.generateSignals({
    market,
    orderbook,
    positionManager,
    binanceAssessment: createAssessment(),
    binanceVelocityPctPerSec: 0.02,
    config: runtimeConfig.sniper,
    blockedOutcomes: new Set(),
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  assert.equal(signals.length, 0);
});

test('sniper engine emits scalp exit after entry reprices in our favor', () => {
  const runtimeConfig = createRuntimeConfig();
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.52,
  });

  engine.recordExecution({
    market,
    signal: {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'SNIPER_BUY',
      priority: 1200,
      action: 'BUY',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 6,
      targetPrice: 0.52,
      referencePrice: 0.6,
      tokenPrice: 0.52,
      midPrice: 0.51,
      fairValue: 0.6,
      edgeAmount: 0.04,
      combinedBid: 0.96,
      combinedAsk: 1.02,
      combinedMid: 0.99,
      combinedDiscount: -0.02,
      combinedPremium: 0.02,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: false,
      reason: 'entry',
    },
    filledShares: 6,
    fillPrice: 0.52,
    executedAtMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  const signals = engine.generateSignals({
    market,
    orderbook: createOrderbook({
      yes: {
        ...createOrderbook().yes,
        bestBid: 0.61,
        bestAsk: 0.63,
        midPrice: 0.62,
      },
    }),
    positionManager,
    binanceAssessment: createAssessment(),
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:10.000Z'),
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, 'SNIPER_SCALP_EXIT');
  assert.equal(signals[0]?.action, 'SELL');
  assert.equal(signals[0]?.urgency, 'cross');
});

test('sniper engine emits reversal stop when Binance flips and pnl is below stop threshold', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_STOP_LOSS_PCT: '0.05',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 6,
    price: 0.52,
  });

  engine.recordExecution({
    market,
    signal: {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'SNIPER_BUY',
      priority: 1200,
      action: 'BUY',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 6,
      targetPrice: 0.52,
      referencePrice: 0.6,
      tokenPrice: 0.52,
      midPrice: 0.51,
      fairValue: 0.6,
      edgeAmount: 0.04,
      combinedBid: 0.96,
      combinedAsk: 1.02,
      combinedMid: 0.99,
      combinedDiscount: -0.02,
      combinedPremium: 0.02,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: false,
      reason: 'entry',
    },
    filledShares: 6,
    fillPrice: 0.52,
    executedAtMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  const signals = engine.generateSignals({
    market,
    orderbook: createOrderbook({
      yes: {
        ...createOrderbook().yes,
        bestBid: 0.45,
        bestAsk: 0.47,
        midPrice: 0.46,
      },
    }),
    positionManager,
    binanceAssessment: createAssessment({
      direction: 'DOWN',
      binanceMovePct: -0.22,
      directionalAgreement: false,
      contraSignal: true,
    }),
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:20.000Z'),
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, 'SNIPER_SCALP_EXIT');
  assert.equal(signals[0]?.action, 'SELL');
  assert.equal(signals[0]?.urgency, 'cross');
  assert.match(signals[0]?.reason ?? '', /reversal stop/i);
});

test('sniper rejection stats capture move_too_small and coin evaluation counts', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.20',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  const signals = engine.generateSignals({
    market,
    orderbook: createOrderbook(),
    positionManager,
    binanceAssessment: createAssessment({
      binanceMovePct: 0.08,
      edgeStrength: 0.08,
    }),
    binanceVelocityPctPerSec: 0.02,
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  assert.equal(signals.length, 0);
  const stats = engine.getStats();
  assert.equal(stats.lastRejection, 'move_too_small');
  assert.equal(stats.rejections.move_too_small, 1);
  assert.equal(stats.totalRejections, 1);
  assert.equal(stats.coinStats.BTC?.evaluations, 1);
});

test('sniper rejection stats capture ask_price_too_high', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_MAX_ENTRY_PRICE: '0.40',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  engine.generateSignals({
    market,
    orderbook: createOrderbook({
      yes: {
        ...createOrderbook().yes,
        bestAsk: 0.52,
      },
    }),
    positionManager,
    binanceAssessment: createAssessment(),
    binanceVelocityPctPerSec: 0.02,
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  const stats = engine.getStats();
  assert.equal(stats.lastRejection, 'ask_price_too_high');
  assert.equal(stats.rejections.ask_price_too_high, 1);
});

test('sniper tracks edge too low, near misses, and best edge seen', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.01',
    SNIPER_MIN_EDGE_AFTER_FEES: '0.010',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  engine.generateSignals({
    market,
    orderbook: createOrderbook({
      yes: {
        ...createOrderbook().yes,
        bestAsk: 0.505,
        midPrice: 0.5,
      },
    }),
    positionManager,
    binanceAssessment: createAssessment({
      binanceMovePct: 0.02,
      edgeStrength: 0.02,
    }),
    binanceVelocityPctPerSec: 0.03,
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  const stats = engine.getStats();
  assert.equal(stats.lastRejection, 'edge_too_low');
  assert.equal(stats.rejections.edge_too_low, 1);
  assert.ok(stats.nearMissCount >= 1);
  assert.ok(stats.bestEdgeSeen > 0);
});

test('sniper stats track generated and executed signals', () => {
  const runtimeConfig = createRuntimeConfig();
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const signals = engine.generateSignals({
    market,
    orderbook: createOrderbook({
      yes: {
        ...createOrderbook().yes,
        bestAsk: 0.52,
        midPrice: 0.5,
      },
    }),
    positionManager,
    binanceAssessment: createAssessment(),
    binanceVelocityPctPerSec: 0.02,
    config: runtimeConfig.sniper,
    nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
  });

  assert.equal(signals.length, 1);
  engine.recordExecution({
    market,
    signal: signals[0],
    filledShares: 6,
    fillPrice: 0.52,
    executedAtMs: Date.parse('2026-03-31T10:01:01.000Z'),
  });

  const stats = engine.getStats();
  assert.equal(stats.signalsGenerated, 1);
  assert.equal(stats.signalsExecuted, 1);
  assert.ok(stats.lastSignalAt !== null);
  assert.ok(stats.coinStats.BTC?.signals === 1);
  assert.equal(stats.coinStats.BTC?.evaluations, 1);
});

test('sniper rejection summary clears interval counts after periodic summary log', () => {
  const runtimeConfig = createRuntimeConfig({
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.20',
  });
  const engine = new SniperEngine(runtimeConfig);
  const market = createMarket();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const originalInfo = logger.info;
  let summaryLogged = false;
  logger.info = ((message: string) => {
    if (message === 'Sniper rejection summary (last 30s)') {
      summaryLogged = true;
    }
  }) as typeof logger.info;

  try {
    (engine as any).lastRejectionSummaryMs = Date.now() - 31_000;
    engine.generateSignals({
      market,
      orderbook: createOrderbook(),
      positionManager,
      binanceAssessment: createAssessment({
        binanceMovePct: 0.05,
        edgeStrength: 0.05,
      }),
      binanceVelocityPctPerSec: 0.01,
      config: runtimeConfig.sniper,
      nowMs: Date.parse('2026-03-31T10:01:00.000Z'),
    });
  } finally {
    logger.info = originalInfo;
  }

  assert.equal(summaryLogged, true);
  assert.equal(engine.getStats().totalRejections, 0);
});

test('sniper getStats returns a complete snapshot shape', () => {
  const runtimeConfig = createRuntimeConfig();
  const engine = new SniperEngine(runtimeConfig);

  const stats = engine.getStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.signalsGenerated, 0);
  assert.equal(stats.signalsExecuted, 0);
  assert.deepEqual(stats.rejections, {});
  assert.equal(stats.totalRejections, 0);
  assert.equal(stats.lastSignalAt, null);
  assert.equal(stats.lastRejection, null);
  assert.equal(stats.bestEdgeSeen, 0);
  assert.equal(stats.avgBinanceMove, null);
  assert.equal(stats.nearMissCount, 0);
  assert.deepEqual(stats.coinStats, {});
});
