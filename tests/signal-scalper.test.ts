import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import { createConfig } from '../src/config.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { RiskManager } from '../src/risk-manager.js';
import {
  SignalScalper,
  adaptiveFairValueThreshold,
  calculateTradeSize,
  estimateFairValue,
  resolvePriceMultiplier,
} from '../src/signal-scalper.js';

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'BTC 5m test market',
    liquidityUsd: 1800,
    volumeUsd: 5000,
    startTime: '2026-03-18T10:00:00.000Z',
    endTime: '2026-03-18T10:05:00.000Z',
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
    title: 'BTC 5m test market',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [],
      asks: [],
      bestBid: 0.43,
      bestAsk: 0.44,
      midPrice: 0.455,
      spread: 0.01,
      spreadBps: 219.78,
      depthSharesBid: 160,
      depthSharesAsk: 140,
      depthNotionalBid: 68.8,
      depthNotionalAsk: 61.6,
      lastTradePrice: 0.442,
      lastTradeSize: 20,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [],
      asks: [],
      bestBid: 0.45,
      bestAsk: 0.46,
      midPrice: 0.47,
      spread: 0.01,
      spreadBps: 212.77,
      depthSharesBid: 150,
      depthSharesAsk: 135,
      depthNotionalBid: 67.5,
      depthNotionalAsk: 62.1,
      lastTradePrice: 0.461,
      lastTradeSize: 18,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.88,
      combinedAsk: 0.9,
      combinedMid: 0.925,
      combinedDiscount: 0.1,
      combinedPremium: -0.12,
      pairSpread: 0.02,
    },
  };
}

function createLowPriceFairValueOrderbook(): MarketOrderbookSnapshot {
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 0.99,
    combinedAsk: 1.01,
    combinedMid: 1,
    combinedDiscount: -0.01,
    combinedPremium: 0.01,
    pairSpread: 0.02,
  };
  orderbook.yes.bestBid = 0.024;
  orderbook.yes.bestAsk = 0.03;
  orderbook.yes.midPrice = 0.025;
  orderbook.yes.lastTradePrice = 0.025;
  orderbook.yes.spread = 0.006;
  orderbook.yes.depthSharesAsk = 120;
  orderbook.yes.depthNotionalAsk = 3.6;
  orderbook.no.bestBid = 0.97;
  orderbook.no.bestAsk = 0.98;
  orderbook.no.midPrice = 0.975;
  orderbook.no.lastTradePrice = 0.975;
  orderbook.no.spread = 0.01;
  orderbook.no.depthSharesAsk = 110;
  orderbook.no.depthNotionalAsk = 107.8;
  return orderbook;
}

function createBinanceFvSignalEngine(
  overrides: Record<string, string> = {}
): SignalScalper {
  return createLegacySignalEngine({
    EXTREME_BUY_THRESHOLD: '0.02',
    BINANCE_FV_SENSITIVITY: '0.10',
    ...overrides,
  });
}

function createLegacySignalEngine(
  overrides: Record<string, string> = {}
): SignalScalper {
  return new SignalScalper(
    createConfig({
      ENTRY_STRATEGY: 'LEGACY',
      PAIRED_ARB_ENABLED: 'false',
      LATENCY_MOMENTUM_ENABLED: 'false',
      ...overrides,
    })
  );
}

function createPairedSignalEngine(
  overrides: Record<string, string> = {}
): SignalScalper {
  return new SignalScalper(
    createConfig({
      ENTRY_STRATEGY: 'PAIRED_ARBITRAGE',
      PAIRED_ARB_ENABLED: 'true',
      LATENCY_MOMENTUM_ENABLED: 'false',
      ...overrides,
    })
  );
}

test('combined discount emits dual-sided BUY signals capped at two', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createLegacySignalEngine();

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.signalType), [
    'COMBINED_DISCOUNT_BUY_BOTH',
    'COMBINED_DISCOUNT_BUY_BOTH',
  ]);
  assert.deepEqual(
    signals.map((signal) => signal.outcome).sort(),
    ['NO', 'YES']
  );
});

test('paired arb ignores MAX_SIGNALS_PER_TICK so both legs survive together', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager(
    createConfig({
      ENTRY_STRATEGY: 'PAIRED_ARBITRAGE',
      PAIRED_ARB_ENABLED: 'true',
      LATENCY_MOMENTUM_ENABLED: 'false',
      MAX_SIGNALS_PER_TICK: '1',
      PAIRED_ARB_MIN_NET_EDGE: '0.03',
    })
  );
  const signalEngine = createPairedSignalEngine({
    MAX_SIGNALS_PER_TICK: '1',
    PAIRED_ARB_MIN_NET_EDGE: '0.03',
  });

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });
  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  assert.deepEqual(
    signals
      .filter((signal) => signal.signalType === 'PAIRED_ARB_BUY_YES' || signal.signalType === 'PAIRED_ARB_BUY_NO')
      .map((signal) => signal.outcome)
      .sort(),
    ['NO', 'YES']
  );
});

test('hard stop is deferred while a paired arb leg is still pending completion', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 12,
    price: 0.45,
  });

  const signalEngine = createPairedSignalEngine();
  signalEngine.recordExecution({
    market,
    signal: {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'PAIRED_ARB_BUY_YES',
      priority: 500,
      generatedAt: Date.parse('2026-03-18T10:02:00.000Z'),
      action: 'BUY',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 12,
      targetPrice: 0.45,
      referencePrice: 0.93,
      tokenPrice: 0.45,
      midPrice: 0.445,
      fairValue: null,
      edgeAmount: 0.03,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: false,
      reason: 'paired starter',
    },
    filledShares: 12,
    fillPrice: 0.45,
    executedAtMs: Date.parse('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment: {
      snapshot: positionManager.getSnapshot(),
      blockedOutcomes: new Set(),
      forcedSignals: [
        {
          marketId: market.marketId,
          marketTitle: market.title,
          signalType: 'HARD_STOP',
          priority: 950,
          generatedAt: Date.parse('2026-03-18T10:02:01.000Z'),
          action: 'SELL',
          outcome: 'YES',
          outcomeIndex: 0,
          shares: 12,
          targetPrice: 0.2,
          referencePrice: 0.2,
          tokenPrice: 0.2,
          midPrice: 0.2,
          fairValue: 0.2,
          edgeAmount: 12,
          combinedBid: orderbook.combined.combinedBid,
          combinedAsk: orderbook.combined.combinedAsk,
          combinedMid: orderbook.combined.combinedMid,
          combinedDiscount: orderbook.combined.combinedDiscount,
          combinedPremium: orderbook.combined.combinedPremium,
          fillRatio: 1,
          capitalClamp: 1,
          priceMultiplier: 1,
          urgency: 'cross',
          reduceOnly: true,
          reason: 'forced hard stop',
        },
      ],
    },
    now: new Date('2026-03-18T10:02:01.000Z'),
  });

  assert.equal(signals.some((signal) => signal.signalType === 'HARD_STOP'), false);
});

test('smoothFairValue applies EMA once per tick and preserves the expected sequence', () => {
  const signalEngine = createLegacySignalEngine({
    BAYESIAN_FV_ENABLED: 'true',
    BAYESIAN_FV_ALPHA: '0.35',
  }) as any;

  const tick1 = signalEngine.smoothFairValue('market-1', 'YES', 0.55, 'scalper-base', 1);
  signalEngine.currentTickFairValueCache.clear();
  const tick2 = signalEngine.smoothFairValue('market-1', 'YES', 0.6, 'scalper-base', 2);
  signalEngine.currentTickFairValueCache.clear();
  const tick3 = signalEngine.smoothFairValue('market-1', 'YES', 0.5, 'scalper-base', 3);

  assert.equal(tick1, 0.55);
  assert.equal(tick2, 0.5675);
  assert.equal(tick3, 0.543875);
});

test('async paired arb can start with a single cheap leg when combined ask is not simultaneously discounted', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes.bestBid = 0.39;
  orderbook.yes.bestAsk = 0.4;
  orderbook.yes.midPrice = 0.4;
  orderbook.yes.lastTradePrice = 0.4;
  orderbook.no.bestBid = 0.54;
  orderbook.no.bestAsk = 0.6;
  orderbook.no.midPrice = 0.55;
  orderbook.no.lastTradePrice = 0.55;
  orderbook.combined = {
    combinedBid: 0.93,
    combinedAsk: 1.0,
    combinedMid: 0.975,
    combinedDiscount: 0,
    combinedPremium: 0,
    pairSpread: 0.07,
  };

  const positionManager = new PositionManager(market.marketId, market.endTime);
  const runtimeConfig = createConfig({
    ENTRY_STRATEGY: 'PAIRED_ARBITRAGE',
    PAIRED_ARB_ENABLED: 'true',
    LATENCY_MOMENTUM_ENABLED: 'false',
    PAIRED_ARB_MAX_PAIR_COST: '0.98',
    PAIRED_ARB_ASYNC_ENABLED: 'true',
    PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE: '0.45',
    PAIRED_ARB_ASYNC_MIN_EDGE: '0.01',
  });
  const riskManager = new RiskManager(runtimeConfig);
  const signalEngine = new SignalScalper(runtimeConfig);

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment: riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
      now: new Date('2026-03-18T10:02:00.000Z'),
    }),
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, 'PAIRED_ARB_BUY_YES');
  assert.equal(signals[0]?.outcome, 'YES');
});

test('inventory rebalance emits a reduce-only sell on dominant inventory', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 0.98,
    combinedAsk: 1.02,
    combinedMid: 1,
    combinedDiscount: -0.02,
    combinedPremium: -0.02,
    pairSpread: 0.04,
  };
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createLegacySignalEngine();

  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 140,
    price: 0.44,
  });

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const rebalanceSignal = signals.find((signal) => signal.signalType === 'INVENTORY_REBALANCE');
  assert.ok(rebalanceSignal);
  assert.equal(rebalanceSignal?.action, 'SELL');
  assert.equal(rebalanceSignal?.outcome, 'YES');
  assert.equal(rebalanceSignal?.reduceOnly, true);
});

test('trade size uses price multiplier, fill ratio, and capital clamp', () => {
  const size = calculateTradeSize({
    action: 'BUY',
    signalType: 'FAIR_VALUE_BUY',
    edgeAmount: 0.03,
    availableCapacity: 80,
    depthShares: 150,
    liquidityUsd: 2500,
    price: 0.18,
    referenceEdge: 0.018,
  });

  assert.equal(resolvePriceMultiplier(0.18) > 1, true);
  assert.equal(size.shares >= 8, true);
  assert.equal(size.priceMultiplier > 1, true);
  assert.equal(size.fillRatio > 0, true);
  assert.equal(size.capitalClamp > 0, true);
});

test('adaptiveFairValueThreshold returns reduced threshold for extreme prices', () => {
  const base = 0.018;
  const extremeLow = adaptiveFairValueThreshold(base, 0.03);
  const extremeHigh = adaptiveFairValueThreshold(base, 0.97);
  const transition = adaptiveFairValueThreshold(base, 0.2);

  assert.equal(extremeLow < 0.005, true);
  assert.equal(extremeLow >= 0.002, true);
  assert.equal(Math.abs(extremeLow - extremeHigh) < 0.0001, true);
  assert.equal(adaptiveFairValueThreshold(base, 0.5), base);
  assert.equal(transition > extremeLow, true);
  assert.equal(transition < base, true);
});

test('trade size does not use referenceEdge as a synthetic price fallback', () => {
  const size = calculateTradeSize({
    action: 'BUY',
    signalType: 'FAIR_VALUE_BUY',
    edgeAmount: 0.03,
    availableCapacity: 80,
    depthShares: 150,
    liquidityUsd: 2500,
    price: null,
    referenceEdge: 0.018,
    runtimeConfig: createConfig({
      ...process.env,
      PRODUCT_TEST_MODE: 'true',
      TEST_MIN_TRADE_USDC: '1',
    }),
  });

  assert.equal(size.shares <= 1, true);
});

test('fair value buy uses paired normalization rather than raw single-book mid', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 0.97,
    combinedAsk: 1.01,
    combinedMid: 0.99,
    combinedDiscount: -0.01,
    combinedPremium: 0.01,
    pairSpread: 0.04,
  };
  orderbook.yes.bestBid = 0.42;
  orderbook.yes.bestAsk = 0.44;
  orderbook.yes.midPrice = 0.43;
  orderbook.no.bestBid = 0.49;
  orderbook.no.bestAsk = 0.57;
  orderbook.no.midPrice = 0.495;

  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createLegacySignalEngine();

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const fairValueBuy = signals.find(
    (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
  );

  assert.ok(fairValueBuy);
  assert.equal((fairValueBuy?.fairValue ?? 0) > (orderbook.yes.midPrice ?? 0), true);
  assert.equal((fairValueBuy?.referencePrice ?? 0) > orderbook.yes.bestAsk, true);
});

test('fair value sell can reduce YES inventory when YES is rich versus parity', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 1.04,
    combinedAsk: 1.08,
    combinedMid: 1.06,
    combinedDiscount: -0.08,
    combinedPremium: 0.04,
    pairSpread: 0.04,
  };
  orderbook.yes.bestBid = 0.7;
  orderbook.yes.bestAsk = 0.72;
  orderbook.yes.midPrice = 0.71;
  orderbook.yes.depthSharesBid = 160;
  orderbook.yes.depthNotionalBid = 112;
  orderbook.no.bestBid = 0.34;
  orderbook.no.bestAsk = 0.36;
  orderbook.no.midPrice = 0.35;

  const positionManager = new PositionManager(market.marketId, market.endTime);
  positionManager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 24,
    price: 0.44,
  });

  const riskManager = new RiskManager();
  const signalEngine = createLegacySignalEngine();
  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const fairValueSell = signals.find(
    (signal) => signal.signalType === 'FAIR_VALUE_SELL' && signal.outcome === 'YES'
  );

  assert.ok(fairValueSell);
  assert.equal(fairValueSell?.action, 'SELL');
  assert.equal((fairValueSell?.fairValue ?? 0) < (orderbook.yes.bestBid ?? 0), true);
});

test('estimateFairValue keeps each outcome on its own normalized side', () => {
  const orderbook = createOrderbook();
  orderbook.yes.midPrice = 0.37;
  orderbook.no.midPrice = 0.63;
  orderbook.yes.lastTradePrice = 0.37;
  orderbook.no.lastTradePrice = 0.63;
  orderbook.yes.bestAsk = 0.39;
  orderbook.no.bestAsk = 0.65;

  const yesFairValue = estimateFairValue(orderbook, 'YES');
  const noFairValue = estimateFairValue(orderbook, 'NO');

  assert.ok(yesFairValue !== null);
  assert.ok(noFairValue !== null);
  assert.equal(Math.abs((yesFairValue ?? 0) - 0.37) < 0.000001, true);
  assert.equal(Math.abs((noFairValue ?? 0) - 0.63) < 0.000001, true);
  assert.equal(Math.abs((yesFairValue ?? 0) - orderbook.yes.bestAsk) < 0.05, true);
  assert.equal(Math.abs((noFairValue ?? 0) - orderbook.no.bestAsk) < 0.05, true);
});

test('Binance UP boosts YES fair value above the base fair value', () => {
  const orderbook = createOrderbook();
  orderbook.yes.midPrice = 0.5;
  orderbook.no.midPrice = 0.5;
  orderbook.yes.lastTradePrice = 0.5;
  orderbook.no.lastTradePrice = 0.5;
  orderbook.yes.bestAsk = 0.52;

  const runtimeConfig = createConfig({
    ...process.env,
    BINANCE_FV_SENSITIVITY: '0.10',
  });
  const baseFairValue = estimateFairValue(orderbook, 'YES', undefined, runtimeConfig);
  const adjustedFairValue = estimateFairValue(
    orderbook,
    'YES',
    {
      direction: 'UP',
      movePct: 0.25,
    },
    runtimeConfig
  );

  assert.equal(baseFairValue, 0.5);
  assert.equal(adjustedFairValue, 0.525);
  assert.equal((adjustedFairValue ?? 0) > (orderbook.yes.bestAsk ?? 0), true);
});

test('Binance DOWN reduces YES fair value below the base fair value', () => {
  const orderbook = createOrderbook();
  orderbook.yes.midPrice = 0.5;
  orderbook.no.midPrice = 0.5;
  orderbook.yes.lastTradePrice = 0.5;
  orderbook.no.lastTradePrice = 0.5;

  const runtimeConfig = createConfig({
    ...process.env,
    BINANCE_FV_SENSITIVITY: '0.10',
  });
  const adjustedFairValue = estimateFairValue(
    orderbook,
    'YES',
    {
      direction: 'DOWN',
      movePct: -0.3,
    },
    runtimeConfig
  );

  assert.equal(adjustedFairValue, 0.47);
  assert.equal((adjustedFairValue ?? 0) < 0.5, true);
});

test('estimateFairValue returns base fair value when Binance data is unavailable', () => {
  const orderbook = createOrderbook();
  orderbook.yes.midPrice = 0.5;
  orderbook.no.midPrice = 0.5;
  orderbook.yes.lastTradePrice = 0.5;
  orderbook.no.lastTradePrice = 0.5;

  const runtimeConfig = createConfig({
    ...process.env,
    BINANCE_FV_SENSITIVITY: '0.10',
  });
  const baseFairValue = estimateFairValue(orderbook, 'YES', undefined, runtimeConfig);
  const unchangedFairValue = estimateFairValue(orderbook, 'YES', undefined, runtimeConfig);

  assert.equal(unchangedFairValue, baseFairValue);
});

test('estimateFairValue ignores flat Binance moves', () => {
  const orderbook = createOrderbook();
  orderbook.yes.midPrice = 0.5;
  orderbook.no.midPrice = 0.5;
  orderbook.yes.lastTradePrice = 0.5;
  orderbook.no.lastTradePrice = 0.5;

  const runtimeConfig = createConfig({
    ...process.env,
    BINANCE_FV_SENSITIVITY: '0.10',
  });
  const baseFairValue = estimateFairValue(orderbook, 'YES', undefined, runtimeConfig);
  const flatAdjustedFairValue = estimateFairValue(
    orderbook,
    'YES',
    {
      direction: 'FLAT',
      movePct: 0.02,
    },
    runtimeConfig
  );

  assert.equal(flatAdjustedFairValue, baseFairValue);
});

test('binance-informed fair value can create a YES buy signal in the low-price zone', () => {
  const market = createMarket();
  const orderbook = createLowPriceFairValueOrderbook();

  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createBinanceFvSignalEngine();

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    binanceFairValueAdjustment: {
      direction: 'UP',
      movePct: 0.25,
    },
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const fairValueBuy = signals.find(
    (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
  );

  assert.ok(fairValueBuy);
  assert.equal((fairValueBuy?.fairValue ?? 0) > (orderbook.yes.bestAsk ?? 0), true);
});

test('fair value buy cooldown blocks repeated same-slot entries for 30 seconds', () => {
  const market = createMarket();
  const orderbook = createLowPriceFairValueOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createBinanceFvSignalEngine();
  const binanceFairValueAdjustment = {
    direction: 'UP' as const,
    movePct: 0.25,
  };

  const firstNow = new Date('2026-03-18T10:02:00.000Z');
  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: firstNow,
  });
  const firstSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    binanceFairValueAdjustment,
    now: firstNow,
  });
  const fairValueBuy = firstSignals.find(
    (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
  );

  assert.ok(fairValueBuy);
  signalEngine.recordExecution({
    market,
    signal: fairValueBuy!,
    executedAtMs: firstNow.getTime(),
  });

  const blockedSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    binanceFairValueAdjustment,
    now: new Date('2026-03-18T10:02:10.000Z'),
  });
  assert.equal(
    blockedSignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    false
  );

  const resumedSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    binanceFairValueAdjustment,
    now: new Date('2026-03-18T10:02:31.000Z'),
  });
  assert.equal(
    resumedSignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    true
  );
});

test('fair value buy per-slot cap blocks further entries after the configured max', () => {
  const market = createMarket();
  const orderbook = createLowPriceFairValueOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createBinanceFvSignalEngine({
    FV_BUY_MAX_PER_SLOT: '3',
  });
  const binanceFairValueAdjustment = {
    direction: 'UP' as const,
    movePct: 0.25,
  };

  for (const timestamp of [
    '2026-03-18T10:02:00.000Z',
    '2026-03-18T10:02:31.000Z',
    '2026-03-18T10:03:02.000Z',
  ]) {
    const now = new Date(timestamp);
    const riskAssessment = riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
      now,
    });
    const signals = signalEngine.generateSignals({
      market,
      orderbook,
      positionManager,
      riskAssessment,
      binanceFairValueAdjustment,
      now,
    });
    const fairValueBuy = signals.find(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    );
    assert.ok(fairValueBuy);
    signalEngine.recordExecution({
      market,
      signal: fairValueBuy!,
      executedAtMs: now.getTime(),
    });
  }

  const cappedSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment: riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
      now: new Date('2026-03-18T10:03:40.000Z'),
    }),
    binanceFairValueAdjustment,
    now: new Date('2026-03-18T10:03:40.000Z'),
  });

  assert.equal(
    cappedSignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    false
  );
});

test('market-maker mode rewrites non-risk entry signals into quoting signal types', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager(
    createConfig({
      ENTRY_STRATEGY: 'LEGACY',
      PAIRED_ARB_ENABLED: 'false',
      LATENCY_MOMENTUM_ENABLED: 'false',
      MARKET_MAKER_MODE: 'true',
      DYNAMIC_QUOTING_ENABLED: 'true',
    })
  );
  const signalEngine = new SignalScalper(
    createConfig({
      ENTRY_STRATEGY: 'LEGACY',
      PAIRED_ARB_ENABLED: 'false',
      LATENCY_MOMENTUM_ENABLED: 'false',
      MARKET_MAKER_MODE: 'true',
      DYNAMIC_QUOTING_ENABLED: 'true',
    })
  );

  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  assert.equal(
    signals.some((signal) => signal.signalType === 'DYNAMIC_QUOTE_BOTH'),
    true
  );
});

test('inventory rebalance blocks same-outcome fair value buy for 60 seconds', () => {
  const market = createMarket();
  const orderbook = createLowPriceFairValueOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createBinanceFvSignalEngine();
  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  signalEngine.recordExecution({
    market,
    signal: {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'INVENTORY_REBALANCE',
      priority: 100,
      generatedAt: Date.parse('2026-03-18T10:02:00.000Z'),
      action: 'SELL',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: 12,
      targetPrice: 0.03,
      referencePrice: 0,
      tokenPrice: 0.03,
      midPrice: 0.025,
      fairValue: 0.03,
      edgeAmount: 1,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'improve',
      reduceOnly: true,
      reason: 'rebalance',
    },
    executedAtMs: Date.parse('2026-03-18T10:02:00.000Z'),
  });

  const blockedSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    binanceFairValueAdjustment: {
      direction: 'UP',
      movePct: 0.25,
    },
    now: new Date('2026-03-18T10:02:30.000Z'),
  });

  assert.equal(
    blockedSignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    false
  );
});

test('binance fair value boost decays as the slot ages', () => {
  const market = createMarket();
  const orderbook = createLowPriceFairValueOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createBinanceFvSignalEngine();
  const binanceFairValueAdjustment = {
    direction: 'UP' as const,
    movePct: 0.25,
  };

  const earlySignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment: riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
      now: new Date('2026-03-18T10:00:05.000Z'),
    }),
    binanceFairValueAdjustment,
    now: new Date('2026-03-18T10:00:05.000Z'),
  });
  const lateSignals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment: riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
      now: new Date('2026-03-18T10:04:50.000Z'),
    }),
    binanceFairValueAdjustment,
    now: new Date('2026-03-18T10:04:50.000Z'),
  });

  assert.equal(
    earlySignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    true
  );
  assert.equal(
    lateSignals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    false
  );
});

test('extreme buy skips degenerate entry books with negligible ask depth', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 0.99,
    combinedAsk: 1.01,
    combinedMid: 1,
    combinedDiscount: -0.01,
    combinedPremium: -0.01,
    pairSpread: 0.02,
  };
  orderbook.yes.bestBid = 0.01;
  orderbook.yes.bestAsk = 0.03;
  orderbook.yes.midPrice = 0.02;
  orderbook.yes.spread = 0.02;
  orderbook.yes.depthSharesAsk = 1;
  orderbook.yes.depthNotionalAsk = 0.03;

  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = createLegacySignalEngine();
  const riskAssessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-18T10:02:00.000Z'),
  });

  assert.equal(
    signals.some(
      (signal) => signal.signalType === 'EXTREME_BUY' && signal.outcome === 'YES'
    ),
    false
  );
});

test('fair value buy is rejected when spread exceeds the fair-value-specific guard', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  orderbook.yes.bestBid = 0.34;
  orderbook.yes.bestAsk = 0.42;
  orderbook.yes.midPrice = 0.45;
  orderbook.yes.spread = 0.08;
  orderbook.yes.lastTradePrice = 0.41;
  orderbook.no.bestBid = 0.55;
  orderbook.no.bestAsk = 0.56;
  orderbook.no.midPrice = 0.55;
  orderbook.no.lastTradePrice = 0.55;

  const signalEngine = createBinanceFvSignalEngine({
    FAIR_VALUE_BUY_THRESHOLD: '0.005',
    MAX_ENTRY_SPREAD: '0.12',
    MAX_ENTRY_SPREAD_FAIR_VALUE: '0.06',
  });
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskAssessment = new RiskManager().checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-24T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-24T10:02:00.000Z'),
  });

  assert.equal(
    signals.some(
      (signal) => signal.signalType === 'FAIR_VALUE_BUY' && signal.outcome === 'YES'
    ),
    false
  );
});

test('extreme buy still passes when spread fits the extreme-specific guard', () => {
  const market = createMarket();
  market.startTime = '2026-03-24T10:00:00.000Z';
  market.endTime = '2026-03-24T10:05:00.000Z';
  const orderbook = createOrderbook();
  orderbook.combined = {
    combinedBid: 0.94,
    combinedAsk: 1.02,
    combinedMid: 0.98,
    combinedDiscount: -0.02,
    combinedPremium: 0.02,
    pairSpread: 0.08,
  };
  orderbook.no.bestAsk = 0.9;
  orderbook.yes.bestBid = 0.02;
  orderbook.yes.bestAsk = 0.12;
  orderbook.yes.midPrice = 0.07;
  orderbook.yes.spread = 0.1;
  orderbook.yes.lastTradePrice = 0.11;

  const signalEngine = createBinanceFvSignalEngine({
    EXTREME_BUY_THRESHOLD: '0.20',
    MAX_ENTRY_SPREAD: '0.12',
    MAX_ENTRY_SPREAD_EXTREME: '0.15',
  });
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskAssessment = new RiskManager().checkRiskLimits({
    market,
    orderbook,
    positionManager,
    now: new Date('2026-03-24T10:02:00.000Z'),
  });

  const signals = signalEngine.generateSignals({
    market,
    orderbook,
    positionManager,
    riskAssessment,
    now: new Date('2026-03-24T10:02:00.000Z'),
  });

  assert.equal(
    signals.some(
      (signal) => signal.signalType === 'EXTREME_BUY' && signal.outcome === 'YES'
    ),
    true
  );
});
