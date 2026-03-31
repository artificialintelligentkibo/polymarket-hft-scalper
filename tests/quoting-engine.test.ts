import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import type { MarketOrderbookSnapshot, Outcome } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { buildQuoteRefreshPlan } from '../src/quoting-engine.js';
import type { RiskAssessment } from '../src/risk-manager.js';
import type { StrategySignal } from '../src/strategy-types.js';

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'condition-1',
    title: 'BTC Up or Down - 10:00-10:05',
    liquidityUsd: 2500,
    volumeUsd: 8000,
    startTime: '2026-03-24T10:00:00.000Z',
    endTime: '2026-03-24T10:05:00.000Z',
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
      bids: [{ price: 0.5, size: 90 }],
      asks: [{ price: 0.52, size: 90 }],
      bestBid: 0.5,
      bestAsk: 0.52,
      midPrice: 0.51,
      spread: 0.02,
      spreadBps: 392.16,
      depthSharesBid: 90,
      depthSharesAsk: 90,
      depthNotionalBid: 45,
      depthNotionalAsk: 46.8,
      lastTradePrice: 0.51,
      lastTradeSize: 10,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.97,
      combinedAsk: 1.01,
      combinedMid: 0.99,
      combinedDiscount: -0.01,
      combinedPremium: 0.03,
      pairSpread: 0.04,
    },
  };
}

function createWideOrderbook(): MarketOrderbookSnapshot {
  return {
    marketId: 'market-1',
    title: 'BTC Up or Down - 10:00-10:05',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [{ price: 0.35, size: 100 }, { price: 0.3, size: 100 }],
      asks: [{ price: 0.55, size: 100 }, { price: 0.6, size: 100 }],
      bestBid: 0.35,
      bestAsk: 0.55,
      midPrice: 0.45,
      spread: 0.2,
      spreadBps: 4444.44,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 35,
      depthNotionalAsk: 55,
      lastTradePrice: 0.45,
      lastTradeSize: 12,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [{ price: 0.35, size: 100 }, { price: 0.3, size: 100 }],
      asks: [{ price: 0.55, size: 100 }, { price: 0.6, size: 100 }],
      bestBid: 0.35,
      bestAsk: 0.55,
      midPrice: 0.55,
      spread: 0.2,
      spreadBps: 3636.36,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 35,
      depthNotionalAsk: 55,
      lastTradePrice: 0.55,
      lastTradeSize: 12,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.7,
      combinedAsk: 1.1,
      combinedMid: 1,
      combinedDiscount: -0.1,
      combinedPremium: 0.1,
      pairSpread: 0.4,
    },
  };
}

function createNoFairValueOrderbook(): MarketOrderbookSnapshot {
  const orderbook = createWideOrderbook();
  orderbook.yes.midPrice = null;
  orderbook.yes.lastTradePrice = null;
  orderbook.no.midPrice = null;
  orderbook.no.lastTradePrice = null;
  return orderbook;
}

function createMmConfig(
  overrides: Record<string, string> = {}
) {
  return createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MM_AUTONOMOUS_QUOTES: 'true',
    MM_QUOTE_SHARES: '8',
    MM_MAX_GROSS_EXPOSURE_USD: '30',
    MM_MAX_NET_DIRECTIONAL: '25',
    MM_MIN_SPREAD_TICKS: '2',
    MM_REQUIRE_FAIR_VALUE: 'true',
    MM_MIN_BOOK_DEPTH_USD: '3',
    MM_MAX_CONCURRENT_MARKETS: '4',
    MM_INVENTORY_SKEW_FACTOR: '0.3',
    MM_MIN_EDGE_AFTER_FEE: '0.005',
    ...overrides,
  });
}

function createRiskAssessment(positionManager: PositionManager): RiskAssessment {
  return {
    snapshot: positionManager.getSnapshot(),
    blockedOutcomes: new Set<Outcome>(),
    forcedSignals: [],
  };
}

function createPendingQuoteExposure(
  yesShares: number,
  noShares: number,
  grossExposureUsd = 0
) {
  return {
    yesShares,
    noShares,
    grossExposureUsd,
  };
}

function seedInventory(
  positionManager: PositionManager,
  yesShares: number,
  noShares: number
): void {
  if (yesShares > 0) {
    positionManager.applyFill({
      outcome: 'YES',
      side: 'BUY',
      shares: yesShares,
      price: 0.5,
    });
  }

  if (noShares > 0) {
    positionManager.applyFill({
      outcome: 'NO',
      side: 'BUY',
      shares: noShares,
      price: 0.5,
    });
  }
}

function createSignal(
  overrides: Partial<StrategySignal> = {}
): StrategySignal {
  return {
    marketId: 'market-1',
    marketTitle: 'BTC Up or Down - 10:00-10:05',
    signalType: 'DYNAMIC_QUOTE_BOTH',
    priority: 200,
    generatedAt: Date.now(),
    action: 'BUY',
    outcome: 'YES',
    outcomeIndex: 0,
    shares: 12,
    targetPrice: 0.48,
    referencePrice: 0.5,
    tokenPrice: 0.48,
    midPrice: 0.48,
    fairValue: 0.5,
    edgeAmount: 0.02,
    combinedBid: 0.97,
    combinedAsk: 1.01,
    combinedMid: 0.99,
    combinedDiscount: -0.01,
    combinedPremium: 0.03,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: 'passive',
    reduceOnly: false,
    reason: 'test quote',
    ...overrides,
  };
}

test('quote refresh plan builds an entry quote plus opposite-side inventory quote', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'NO',
    side: 'BUY',
    shares: 9,
    price: 0.51,
  });

  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: {
        snapshot: positionManager.getSnapshot(),
        blockedOutcomes: new Set(),
        forcedSignals: [],
      },
      quoteSignals: [createSignal()],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.action === 'BUY' && signal.outcome === 'YES'), true);
  assert.equal(plan.signals.some((signal) => signal.action === 'SELL' && signal.outcome === 'NO'), true);
});

test('quote refresh plan suppresses new entry quotes on the overweight side', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 40,
    price: 0.48,
  });
  positionManager.applyFill({
    outcome: 'NO',
    side: 'BUY',
    shares: 5,
    price: 0.51,
  });

  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    MAX_IMBALANCE_PERCENT: '35',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: {
        snapshot: positionManager.getSnapshot(),
        blockedOutcomes: new Set(),
        forcedSignals: [],
      },
      quoteSignals: [createSignal({ outcome: 'YES', outcomeIndex: 0 })],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.action === 'BUY' && signal.outcome === 'YES'), false);
});

test('quote refresh plan emits deep Binance quote signals when deep assessment is available', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: {
        snapshot: positionManager.getSnapshot(),
        blockedOutcomes: new Set(),
        forcedSignals: [],
      },
      quoteSignals: [createSignal()],
      deepBinanceAssessment: {
        available: true,
        coin: 'BTC',
        symbol: 'btcusdt',
        reason: null,
        binanceBid: 84000,
        binanceAsk: 84010,
        binanceMid: 84005,
        binanceSpreadRatio: 0.00012,
        slotOpenMid: 83900,
        binanceMovePct: 0.125,
        volatilityRatio: 0.002,
        fundingRate: 0.0001,
        fundingBasis: 0.505,
        polymarketMid: 0.48,
        fairValue: 0.54,
        direction: 'UP',
      },
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.signalType === 'DEEP_BINANCE_SIGNAL'), true);
});

test('quote refresh plan blocks entry quotes when Binance spread is too wide', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);

  const runtimeConfig = createConfig({
    ...process.env,
    MARKET_MAKER_MODE: 'true',
    DYNAMIC_QUOTING_ENABLED: 'true',
    DEEP_BINANCE_MODE: 'true',
    MIN_BINANCE_SPREAD_THRESHOLD: '0.004',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: {
        snapshot: positionManager.getSnapshot(),
        blockedOutcomes: new Set(),
        forcedSignals: [],
      },
      quoteSignals: [createSignal()],
      deepBinanceAssessment: {
        available: true,
        coin: 'BTC',
        symbol: 'btcusdt',
        reason: null,
        binanceBid: 84000,
        binanceAsk: 84500,
        binanceMid: 84250,
        binanceSpreadRatio: 0.0059,
        slotOpenMid: 83900,
        binanceMovePct: 0.4,
        volatilityRatio: 0.006,
        fundingRate: 0.0002,
        fundingBasis: 0.51,
        polymarketMid: 0.48,
        fairValue: 0.56,
        direction: 'UP',
      },
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.action === 'BUY' && !signal.reduceOnly), false);
});

test('autonomous MM quotes are suppressed when sniper mode sees a directional Binance move', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const runtimeConfig = createMmConfig({
    SNIPER_MODE_ENABLED: 'true',
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.10',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      binanceAssessment: {
        available: true,
        coin: 'BTC',
        binancePrice: 84250,
        slotOpenPrice: 84000,
        binanceMovePct: 0.18,
        direction: 'UP',
        pmUpMid: 0.45,
        pmImpliedDirection: 'FLAT',
        directionalAgreement: true,
        edgeStrength: 0.18,
        sizeMultiplier: 1.2,
        urgencyBoost: false,
        contraSignal: false,
      },
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM quotes stay disabled when MM_AUTONOMOUS_QUOTES=false', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig({
      MM_AUTONOMOUS_QUOTES: 'false',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM generates dual-sided quotes when fair value and inventory are available', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 10, 10);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig(),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_BID').length, 2);
  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_ASK').length, 2);
  assert.deepEqual(
    plan.signals.map((signal) => `${signal.signalType}:${signal.outcome}`).sort(),
    [
      'MM_QUOTE_ASK:NO',
      'MM_QUOTE_ASK:YES',
      'MM_QUOTE_BID:NO',
      'MM_QUOTE_BID:YES',
    ]
  );
});

test('autonomous MM skips quotes when the captured spread does not clear fees', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig(),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM only emits asks after the gross exposure cap is reached', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);
  const runtimeConfig = createMmConfig({
    MM_MAX_GROSS_EXPOSURE_USD: '30',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    currentMMExposureUsd: runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD,
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.action === 'BUY'), false);
  assert.equal(plan.signals.some((signal) => signal.action === 'SELL'), true);
});

test('autonomous MM skews YES quotes lower when YES inventory is heavy', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const runtimeConfig = createMmConfig({
    MM_QUOTE_SHARES: '4',
    MM_INVENTORY_SKEW_FACTOR: '0.5',
  });

  const neutralPositionManager = new PositionManager(market.marketId, market.endTime);
  const neutralPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager: neutralPositionManager,
      riskAssessment: createRiskAssessment(neutralPositionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  const lightPositionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(lightPositionManager, 1, 0);
  const lightPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager: lightPositionManager,
      riskAssessment: createRiskAssessment(lightPositionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  const skewedPositionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(skewedPositionManager, 20, 0);
  const skewedPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager: skewedPositionManager,
      riskAssessment: createRiskAssessment(skewedPositionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  const neutralYesBid = neutralPlan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
  );
  const lightYesAsk = lightPlan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
  );
  const skewedYesBid = skewedPlan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
  );
  const skewedYesAsk = skewedPlan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
  );

  assert.ok(neutralYesBid?.targetPrice !== null);
  assert.ok(lightYesAsk?.targetPrice !== null);
  assert.ok(skewedYesBid?.targetPrice !== null);
  assert.ok(skewedYesAsk?.targetPrice !== null);
  assert.ok((skewedYesBid?.targetPrice ?? 0) < (neutralYesBid?.targetPrice ?? 0));
  assert.ok((skewedYesAsk?.targetPrice ?? 0) < (lightYesAsk?.targetPrice ?? 0));
});

test('autonomous MM skips quotes when fair value is required but unavailable', () => {
  const market = createMarket();
  const orderbook = createNoFairValueOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig({
      MM_REQUIRE_FAIR_VALUE: 'true',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM suppresses bids on a market that is over the concurrent-market limit', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      allowEntryQuotes: false,
    },
    runtimeConfig: createMmConfig(),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.some((signal) => signal.action === 'BUY'), false);
  assert.equal(plan.signals.some((signal) => signal.action === 'SELL'), true);
});

test('autonomous MM blocks YES bids when pending YES exposure already breaches directional limit', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 6);

  const runtimeConfig = createMmConfig({
    MM_QUOTE_SHARES: '4',
    MM_MAX_NET_DIRECTIONAL: '10',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      pendingQuoteExposure: createPendingQuoteExposure(7, 0, 2.45),
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
    ),
    false
  );
  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'NO'
    ),
    true
  );
});

test('autonomous MM allows YES bids again once pending YES exposure is gone', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 6);

  const runtimeConfig = createMmConfig({
    MM_QUOTE_SHARES: '4',
    MM_MAX_NET_DIRECTIONAL: '10',
  });

  const blockedPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      pendingQuoteExposure: createPendingQuoteExposure(7, 0, 2.45),
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  const clearedPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      pendingQuoteExposure: createPendingQuoteExposure(0, 0, 0),
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig,
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(
    blockedPlan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
    ),
    false
  );
  assert.equal(
    clearedPlan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
    ),
    true
  );
});
