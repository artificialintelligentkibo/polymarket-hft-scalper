import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { buildQuoteRefreshPlan } from '../src/quoting-engine.js';
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
