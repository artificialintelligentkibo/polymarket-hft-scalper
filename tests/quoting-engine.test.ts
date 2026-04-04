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

function createLowPriceOrderbook(): MarketOrderbookSnapshot {
  return {
    marketId: 'market-1',
    title: 'BTC Up or Down - 10:00-10:05',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [{ price: 0.14, size: 60 }],
      asks: [{ price: 0.18, size: 60 }],
      bestBid: 0.14,
      bestAsk: 0.18,
      midPrice: 0.16,
      spread: 0.04,
      spreadBps: 2500,
      depthSharesBid: 60,
      depthSharesAsk: 60,
      depthNotionalBid: 8.4,
      depthNotionalAsk: 10.8,
      lastTradePrice: 0.16,
      lastTradeSize: 8,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [{ price: 0.82, size: 60 }],
      asks: [{ price: 0.86, size: 60 }],
      bestBid: 0.82,
      bestAsk: 0.86,
      midPrice: 0.84,
      spread: 0.04,
      spreadBps: 476.19,
      depthSharesBid: 60,
      depthSharesAsk: 60,
      depthNotionalBid: 49.2,
      depthNotionalAsk: 51.6,
      lastTradePrice: 0.84,
      lastTradeSize: 8,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.96,
      combinedAsk: 1.04,
      combinedMid: 1,
      combinedDiscount: -0.04,
      combinedPremium: 0.04,
      pairSpread: 0.08,
    },
  };
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

  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_BID').length, 0);
  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_ASK').length, 2);
  assert.equal(plan.mmDiagnostics?.entryMode, 'ASK_ONLY');
  assert.ok(plan.mmDiagnostics?.toxicityFlags.includes('binance_up_0.1800'));
});

test('autonomous MM keeps Binance bid suppression until the toxic-flow hold expires', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const runtimeConfig = createMmConfig({
    MM_TOXIC_FLOW_BLOCK_MOVE_PCT: '0.08',
    MM_TOXIC_FLOW_CLEAR_MOVE_PCT: '0.05',
    MM_TOXIC_FLOW_HOLD_MS: '5000',
  });
  const firstNow = new Date('2026-03-24T10:01:00.000Z');
  const heldNow = new Date('2026-03-24T10:01:03.000Z');
  const clearedNow = new Date('2026-03-24T10:01:06.500Z');

  const firstPlan = buildQuoteRefreshPlan({
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
    now: firstNow,
  });

  const heldPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      binanceAssessment: {
        available: true,
        coin: 'BTC',
        binancePrice: 84035,
        slotOpenPrice: 84000,
        binanceMovePct: 0.04,
        direction: 'UP',
        pmUpMid: 0.45,
        pmImpliedDirection: 'FLAT',
        directionalAgreement: false,
        edgeStrength: 0.04,
        sizeMultiplier: 1,
        urgencyBoost: false,
        contraSignal: false,
      },
    },
    behaviorState: firstPlan.mmBehaviorState ?? undefined,
    runtimeConfig,
    now: heldNow,
  });

  const clearedPlan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      binanceAssessment: {
        available: true,
        coin: 'BTC',
        binancePrice: 84035,
        slotOpenPrice: 84000,
        binanceMovePct: 0.04,
        direction: 'UP',
        pmUpMid: 0.45,
        pmImpliedDirection: 'FLAT',
        directionalAgreement: false,
        edgeStrength: 0.04,
        sizeMultiplier: 1,
        urgencyBoost: false,
        contraSignal: false,
      },
    },
    behaviorState: heldPlan.mmBehaviorState ?? undefined,
    runtimeConfig,
    now: clearedNow,
  });

  assert.ok(
    (firstPlan.mmBehaviorState?.globalBidBlockUntilMs ?? 0) >= firstNow.getTime() + 5000
  );
  assert.equal(
    heldPlan.signals.some((signal) => signal.signalType === 'MM_QUOTE_BID'),
    false
  );
  assert.equal(heldPlan.mmDiagnostics?.entryMode, 'ASK_ONLY');
  assert.ok(heldPlan.mmDiagnostics?.toxicityFlags.includes('binance_hold'));
  assert.equal(
    clearedPlan.signals.some((signal) => signal.signalType === 'MM_QUOTE_BID'),
    true
  );
});

test('post-sniper MM grace window bypasses directional suppression for the activated market', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 8, 8);

  const now = new Date('2026-03-24T10:01:00.000Z');
  const runtimeConfig = createMmConfig({
    SNIPER_MODE_ENABLED: 'true',
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.10',
    MM_POST_SNIPER_GRACE_WINDOW_MS: '15000',
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
      activationTrigger: {
        triggerLayer: 'SNIPER',
        entryOutcome: 'YES',
        entryPrice: 0.33,
        entryShares: 6,
        activatedAtMs: now.getTime() - 5000,
      },
    },
    runtimeConfig,
    now,
  });

  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_BID').length, 2);
  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_ASK').length, 2);
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
    runtimeConfig: createMmConfig({
      POST_ONLY_ONLY: 'false',
    }),
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

test('autonomous MM warmup keeps asks live but blocks new bids right after slot open', () => {
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
    runtimeConfig: createMmConfig({
      MM_QUOTE_SHARES: '6',
      POST_ONLY_ONLY: 'false',
    }),
    now: new Date('2026-03-24T10:00:01.000Z'),
  });

  assert.equal(plan.mmDiagnostics?.phase, 'WARMUP');
  assert.equal(plan.mmDiagnostics?.entryMode, 'OFF');
  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_BID').length, 0);
  assert.equal(plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_ASK').length, 2);
});

test('autonomous MM scales bids above the 6-share floor when spread and depth are strong', () => {
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
    runtimeConfig: createMmConfig({
      MM_QUOTE_SHARES: '6',
      MM_MAX_QUOTE_SHARES: '18',
      MM_MIN_SPREAD_TICKS: '1',
      POST_ONLY_ONLY: 'false',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  const bidSignals = plan.signals.filter((signal) => signal.signalType === 'MM_QUOTE_BID');
  assert.equal(bidSignals.length, 2);
  assert.deepEqual(
    bidSignals.map((signal) => signal.shares).sort((left, right) => left - right),
    [12, 12]
  );
  assert.equal(plan.mmDiagnostics?.selectedBidSharesYes, 12);
  assert.equal(plan.mmDiagnostics?.selectedBidSharesNo, 12);
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
    runtimeConfig: createMmConfig({
      POST_ONLY_ONLY: 'false',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM uses maker-aware spread logic for passive quotes on thin markets', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes.bestBid = 0.47;
  orderbook.yes.bestAsk = 0.48;
  orderbook.yes.midPrice = 0.475;
  orderbook.yes.spread = 0.01;
  orderbook.yes.bids = [{ price: 0.47, size: 80 }];
  orderbook.yes.asks = [{ price: 0.48, size: 80 }];
  orderbook.no.bestBid = 0.52;
  orderbook.no.bestAsk = 0.53;
  orderbook.no.midPrice = 0.525;
  orderbook.no.spread = 0.01;
  orderbook.no.bids = [{ price: 0.52, size: 90 }];
  orderbook.no.asks = [{ price: 0.53, size: 90 }];

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
      MM_MIN_SPREAD_TICKS: '1',
      MM_MAKER_MIN_EDGE: '0.003',
      POST_ONLY_ONLY: 'true',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.ok(plan.signals.some((signal) => signal.signalType === 'MM_QUOTE_BID'));
  assert.ok(plan.signals.some((signal) => signal.signalType === 'MM_QUOTE_ASK'));
});

test('thin spreads are still rejected when passive maker mode is disabled', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes.bestBid = 0.47;
  orderbook.yes.bestAsk = 0.48;
  orderbook.yes.midPrice = 0.475;
  orderbook.yes.spread = 0.01;
  orderbook.yes.bids = [{ price: 0.47, size: 80 }];
  orderbook.yes.asks = [{ price: 0.48, size: 80 }];
  orderbook.no.bestBid = 0.52;
  orderbook.no.bestAsk = 0.53;
  orderbook.no.midPrice = 0.525;
  orderbook.no.spread = 0.01;
  orderbook.no.bids = [{ price: 0.52, size: 90 }];
  orderbook.no.asks = [{ price: 0.53, size: 90 }];

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
      MM_MIN_SPREAD_TICKS: '1',
      MM_MAKER_MIN_EDGE: '0.003',
      POST_ONLY_ONLY: 'false',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('post-sniper MM fast path still emits a reduce-only ask when the regular MM spread is too thin', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 0);

  const now = new Date('2026-03-24T10:01:00.000Z');
  const runtimeConfig = createMmConfig({
    SNIPER_MODE_ENABLED: 'true',
    SNIPER_MIN_BINANCE_MOVE_PCT: '0.10',
    MM_POST_SNIPER_GRACE_WINDOW_MS: '15000',
    MM_QUOTE_SHARES: '6',
    POST_ONLY_ONLY: 'false',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      activationTrigger: {
        triggerLayer: 'SNIPER',
        entryOutcome: 'YES',
        entryPrice: 0.35,
        entryShares: 6,
        activatedAtMs: now.getTime() - 5000,
      },
    },
    runtimeConfig,
    now,
  });

  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
    ),
    true
  );
  assert.equal(
    plan.signals.some((signal) => signal.signalType === 'MM_QUOTE_BID'),
    false
  );
});

test('post-sniper MM fast path still emits when autonomous MM is disabled', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 0);

  const now = new Date('2026-03-24T10:01:00.000Z');
  const runtimeConfig = createMmConfig({
    MM_AUTONOMOUS_QUOTES: 'false',
    MM_POST_SNIPER_GRACE_WINDOW_MS: '15000',
    MM_QUOTE_SHARES: '6',
    POST_ONLY_ONLY: 'true',
  });

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      activationTrigger: {
        triggerLayer: 'SNIPER',
        entryOutcome: 'YES',
        entryPrice: 0.35,
        entryShares: 6,
        activatedAtMs: now.getTime() - 5_000,
      },
    },
    runtimeConfig,
    now,
  });

  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
    ),
    true
  );
  assert.equal(
    plan.signals.some((signal) => signal.signalType === 'MM_QUOTE_BID'),
    false
  );
});

test('post-sniper MM asks stay above entry with a passive maker floor', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes = {
    ...orderbook.yes,
    bids: [
      { price: 0.34, size: 100 },
      { price: 0.33, size: 100 },
    ],
    asks: [
      { price: 0.35, size: 100 },
      { price: 0.36, size: 100 },
    ],
    bestBid: 0.34,
    bestAsk: 0.35,
    midPrice: 0.345,
    spread: 0.01,
    spreadBps: 289.86,
    depthSharesBid: 100,
    depthSharesAsk: 100,
    depthNotionalBid: 34,
    depthNotionalAsk: 35,
    lastTradePrice: 0.35,
  };
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 0);
  const now = new Date('2026-03-24T10:01:00.000Z');

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
      activationTrigger: {
        triggerLayer: 'SNIPER',
        entryOutcome: 'YES',
        entryPrice: 0.37,
        entryShares: 6,
        activatedAtMs: now.getTime() - 5_000,
      },
    },
    runtimeConfig: createMmConfig({
      MM_POST_SNIPER_GRACE_WINDOW_MS: '15000',
      MM_QUOTE_SHARES: '6',
      POST_ONLY_ONLY: 'false',
    }),
    now,
  });

  const askSignal = plan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
  );

  assert.ok(askSignal);
  assert.equal(askSignal?.urgency, 'passive');
  assert.ok((askSignal?.targetPrice ?? 0) >= 0.38);
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

test('autonomous MM biases toward exits when YES inventory is heavy', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const runtimeConfig = createMmConfig({
    MM_QUOTE_SHARES: '6',
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
  seedInventory(lightPositionManager, 5, 0);
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
  assert.ok(skewedYesAsk?.targetPrice !== null);
  assert.equal(skewedYesBid, undefined);
  assert.ok((neutralYesBid?.targetPrice ?? 0) > 0);
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

test('autonomous MM blocks same-side rebids during the reentry cooldown window', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const now = new Date('2026-03-24T10:01:00.000Z');

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    behaviorState: {
      globalBidBlockUntilMs: null,
      toxicBidBlockUntilMs: {},
      sameSideBidBlockUntilMs: {
        NO: now.getTime() + 15_000,
      },
    },
    runtimeConfig: createMmConfig({
      MM_QUOTE_SHARES: '6',
      MM_SAME_SIDE_REENTRY_COOLDOWN_MS: '30000',
    }),
    now,
  });

  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'NO'
    ),
    false
  );
  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
    ),
    true
  );
  assert.equal(plan.mmDiagnostics?.selectedBidSharesNo, null);
  assert.notEqual(plan.mmDiagnostics?.selectedBidSharesYes, null);
});

test('autonomous MM blocks same-side rebids when directional inventory already equals the base clip', () => {
  const market = createMarket();
  const orderbook = createWideOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 0, 6);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig({
      MM_QUOTE_SHARES: '6',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'NO'
    ),
    false
  );
  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_BID' && signal.outcome === 'YES'
    ),
    true
  );
  assert.equal(
    plan.signals.some(
      (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'NO'
    ),
    true
  );
});

test('autonomous MM blocks entry bids when the quoted price is outside the allowed band', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes = {
    ...orderbook.yes,
    bids: [{ price: 0.94, size: 100 }],
    asks: [{ price: 0.96, size: 100 }],
    bestBid: 0.94,
    bestAsk: 0.96,
    midPrice: 0.95,
    spread: 0.02,
    depthSharesBid: 100,
    depthSharesAsk: 100,
    depthNotionalBid: 94,
    depthNotionalAsk: 96,
    lastTradePrice: 0.95,
  };
  orderbook.no = {
    ...orderbook.no,
    bids: [{ price: 0.02, size: 100 }],
    asks: [{ price: 0.04, size: 100 }],
    bestBid: 0.02,
    bestAsk: 0.04,
    midPrice: 0.03,
    spread: 0.02,
    depthSharesBid: 100,
    depthSharesAsk: 100,
    depthNotionalBid: 2,
    depthNotionalAsk: 4,
    lastTradePrice: 0.03,
  };
  const positionManager = new PositionManager(market.marketId, market.endTime);

  const plan = buildQuoteRefreshPlan({
    context: {
      market,
      orderbook,
      positionManager,
      riskAssessment: createRiskAssessment(positionManager),
      quoteSignals: [],
    },
    runtimeConfig: createMmConfig({
      MM_AUTONOMOUS_MIN_BID_PRICE: '0.10',
      MM_AUTONOMOUS_MAX_BID_PRICE: '0.90',
    }),
    now: new Date('2026-03-24T10:01:00.000Z'),
  });

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM skips dust asks that do not meet the minimum tradable size', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 0.7, 0.7);
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

  assert.equal(plan.signals.length, 0);
});

test('autonomous MM sellability cliff lifts passive asks before the position becomes unsellable', () => {
  const market = createMarket();
  const orderbook = createLowPriceOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  seedInventory(positionManager, 6, 0);
  const runtimeConfig = createMmConfig({
    MM_QUOTE_SHARES: '6',
    POST_ONLY_ONLY: 'true',
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

  const askSignal = plan.signals.find(
    (signal) => signal.signalType === 'MM_QUOTE_ASK' && signal.outcome === 'YES'
  );
  assert.ok(askSignal);
  assert.equal(askSignal.targetPrice, 0.166667);
  assert.match(askSignal.reason, /sellabilityCliff=true/);
  assert.deepEqual(plan.mmDiagnostics?.sellabilityCliffOutcomes, ['YES']);
});
