import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import { createConfig } from '../src/config.js';
import { recordDayPnlDelta, resetDayPnlStateCache } from '../src/day-pnl-state.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { RiskManager } from '../src/risk-manager.js';

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'ETH 5m test market',
    liquidityUsd: 2000,
    volumeUsd: 6000,
    startTime: '2026-03-18T11:00:00.000Z',
    endTime: '2026-03-18T11:05:00.000Z',
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
    title: 'ETH 5m test market',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [],
      asks: [],
      bestBid: 0.48,
      bestAsk: 0.49,
      midPrice: 0.485,
      spread: 0.01,
      spreadBps: 206.19,
      depthSharesBid: 120,
      depthSharesAsk: 110,
      depthNotionalBid: 57.6,
      depthNotionalAsk: 53.9,
      lastTradePrice: 0.487,
      lastTradeSize: 15,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [],
      asks: [],
      bestBid: 0.5,
      bestAsk: 0.51,
      midPrice: 0.505,
      spread: 0.01,
      spreadBps: 198.02,
      depthSharesBid: 115,
      depthSharesAsk: 100,
      depthNotionalBid: 57.5,
      depthNotionalAsk: 51,
      lastTradePrice: 0.504,
      lastTradeSize: 12,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.98,
      combinedAsk: 1,
      combinedMid: 0.99,
      combinedDiscount: 0,
      combinedPremium: -0.02,
      pairSpread: 0.02,
    },
  };
}

test('risk manager emits slot flatten signal near end of slot', () => {
  const market = createMarket();
  const orderbook = createOrderbook();
  const manager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager();

  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 25,
    price: 0.45,
  });

  const assessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager: manager,
    now: new Date('2026-03-18T11:04:50.000Z'),
  });

  assert.equal(assessment.forcedSignals.length > 0, true);
  assert.equal(assessment.forcedSignals[0]?.signalType, 'SLOT_FLATTEN');
  assert.equal(assessment.forcedSignals[0]?.action, 'SELL');
});

test('risk manager halts entries and flattens inventory after drawdown breach', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'risk-manager-test-state.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/risk-manager-test-state.json',
    MAX_DRAWDOWN_USDC: '-100',
  });
  const market = createMarket();
  const orderbook = createOrderbook();
  const manager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager(runtimeConfig);

  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 20,
    price: 0.45,
  });

  const now = new Date('2026-03-18T11:02:00.000Z');
  recordDayPnlDelta(120, now, runtimeConfig);
  recordDayPnlDelta(-235, now, runtimeConfig);

  const assessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager: manager,
    now,
  });

  assert.equal(assessment.blockedOutcomes.has('YES'), true);
  assert.equal(assessment.blockedOutcomes.has('NO'), true);
  assert.equal(assessment.forcedSignals.length > 0, true);
  assert.equal(assessment.forcedSignals[0]?.signalType, 'RISK_LIMIT');
  assert.equal(assessment.forcedSignals[0]?.action, 'SELL');

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});

test('risk manager keeps reduce-only flatten signals when drawdown halt is active', () => {
  const stateFile = path.resolve(process.cwd(), 'reports', 'risk-manager-reduce-only-test.json');
  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();

  const runtimeConfig = createConfig({
    ...process.env,
    STATE_FILE: './reports/risk-manager-reduce-only-test.json',
    MAX_DRAWDOWN_USDC: '-10',
  });
  const market = createMarket();
  const orderbook = createOrderbook();
  const manager = new PositionManager(market.marketId, market.endTime);
  const riskManager = new RiskManager(runtimeConfig);

  manager.applyFill({
    outcome: 'YES',
    side: 'BUY',
    shares: 8,
    price: 0.45,
  });
  recordDayPnlDelta(20, new Date('2026-03-18T11:01:00.000Z'), runtimeConfig);
  recordDayPnlDelta(-40, new Date('2026-03-18T11:02:00.000Z'), runtimeConfig);

  const assessment = riskManager.checkRiskLimits({
    market,
    orderbook,
    positionManager: manager,
    now: new Date('2026-03-18T11:02:00.000Z'),
  });
  const flattenSignal = assessment.forcedSignals.find((signal) => signal.signalType === 'RISK_LIMIT');

  assert.ok(flattenSignal);
  assert.equal(flattenSignal.reduceOnly, true);
  assert.equal(flattenSignal.action, 'SELL');

  rmSync(stateFile, { force: true });
  resetDayPnlStateCache();
});
