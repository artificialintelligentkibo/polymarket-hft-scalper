import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import { createConfig } from '../src/config.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { RiskManager } from '../src/risk-manager.js';
import { SignalScalper, calculateTradeSize, resolvePriceMultiplier } from '../src/signal-scalper.js';

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

test('combined discount emits dual-sided BUY signals capped at two', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = new SignalScalper();

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
  const signalEngine = new SignalScalper();

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
    combinedBid: 0.91,
    combinedAsk: 0.94,
    combinedMid: 0.925,
    combinedDiscount: 0.005,
    combinedPremium: -0.09,
    pairSpread: 0.03,
  };
  orderbook.yes.bestBid = 0.42;
  orderbook.yes.bestAsk = 0.44;
  orderbook.yes.midPrice = 0.43;
  orderbook.no.bestBid = 0.49;
  orderbook.no.bestAsk = 0.5;
  orderbook.no.midPrice = 0.495;

  const positionManager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();
  const signalEngine = new SignalScalper();

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
  const signalEngine = new SignalScalper();
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
  const signalEngine = new SignalScalper();
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
