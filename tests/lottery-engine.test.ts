import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';
import { createConfig } from '../src/config.js';
import { LotteryEngine } from '../src/lottery-engine.js';
import type { MarketCandidate } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';

function createMarket(): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'ETH Up or Down',
    liquidityUsd: 2500,
    volumeUsd: 6000,
    startTime: '2026-03-31T16:00:00.000Z',
    endTime: '2026-03-31T16:05:00.000Z',
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
    title: 'ETH Up or Down',
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [{ price: 0.05, size: 400 }],
      asks: [{ price: 0.06, size: 400 }],
      bestBid: 0.05,
      bestAsk: 0.06,
      midPrice: 0.055,
      spread: 0.01,
      spreadBps: 0,
      depthSharesBid: 400,
      depthSharesAsk: 400,
      depthNotionalBid: 20,
      depthNotionalAsk: 24,
      lastTradePrice: 0.055,
      lastTradeSize: 20,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [{ price: 0.04, size: 300 }],
      asks: [{ price: 0.05, size: 300 }],
      bestBid: 0.04,
      bestAsk: 0.05,
      midPrice: 0.045,
      spread: 0.01,
      spreadBps: 0,
      depthSharesBid: 300,
      depthSharesAsk: 300,
      depthNotionalBid: 12,
      depthNotionalAsk: 15,
      lastTradePrice: 0.045,
      lastTradeSize: 15,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    combined: {
      combinedBid: 0.09,
      combinedAsk: 0.11,
      combinedMid: 0.1,
      combinedDiscount: 0.9,
      combinedPremium: -0.9,
      pairSpread: 0.02,
    },
  };
}

test('lottery engine stays inert when the layer is disabled', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    LOTTERY_LAYER_ENABLED: 'false',
  });
  const engine = new LotteryEngine(runtimeConfig);
  const signal = engine.generateLotterySignal({
    market: createMarket(),
    orderbook: createOrderbook(),
    positionManager: new PositionManager('market-1'),
    triggerSignalType: 'SNIPER_BUY',
    triggerOutcome: 'YES',
    triggerFillPrice: 0.43,
    triggerFilledShares: 6,
    config: runtimeConfig.lottery,
    slotKey: 'slot-1',
  });

  assert.equal(signal, null);
});

test('lottery engine generates a passive opposite-side ticket within the configured risk budget', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    LOTTERY_LAYER_ENABLED: 'true',
    LOTTERY_MAX_RISK_USDC: '12',
    LOTTERY_MIN_CENTS: '0.03',
    LOTTERY_MAX_CENTS: '0.07',
  });
  const engine = new LotteryEngine(runtimeConfig);
  const signal = engine.generateLotterySignal({
    market: createMarket(),
    orderbook: createOrderbook(),
    positionManager: new PositionManager('market-1'),
    triggerSignalType: 'SNIPER_BUY',
    triggerOutcome: 'YES',
    triggerFillPrice: 0.31,
    triggerFilledShares: 6,
    config: runtimeConfig.lottery,
    slotKey: 'slot-1',
  });

  assert.ok(signal);
  assert.equal(signal.signalType, 'LOTTERY_BUY');
  assert.equal(signal.strategyLayer, 'LOTTERY');
  assert.equal(signal.outcome, 'NO');
  assert.equal(signal.urgency, 'passive');
  assert.equal(signal.reduceOnly, false);
  assert.equal(signal.targetPrice, 0.05);
  assert.equal(signal.shares <= 240, true);
  assert.equal(signal.shares * (signal.targetPrice ?? 0) <= 12, true);
});

test('lottery engine enforces one ticket per slot and tracks stats after execution', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    LOTTERY_LAYER_ENABLED: 'true',
    LOTTERY_MAX_PER_SLOT: '1',
  });
  const engine = new LotteryEngine(runtimeConfig);
  const params = {
    market: createMarket(),
    orderbook: createOrderbook(),
    positionManager: new PositionManager('market-1'),
    triggerSignalType: 'SNIPER_BUY',
    triggerOutcome: 'NO' as const,
    triggerFillPrice: 0.42,
    triggerFilledShares: 6,
    config: runtimeConfig.lottery,
    slotKey: 'slot-1',
  };

  const first = engine.generateLotterySignal(params);
  assert.ok(first);
  engine.recordExecution({
    marketId: params.market.marketId,
    outcome: first.outcome,
    filledShares: 100,
    fillPrice: first.targetPrice ?? 0.05,
    signalType: first.signalType,
    slotKey: params.slotKey,
  });

  const second = engine.generateLotterySignal(params);
  const stats = engine.getStats();

  assert.equal(second, null);
  assert.equal(stats.totalTickets, 1);
  assert.equal(stats.activeEntries, 1);
  assert.equal(stats.totalRiskUsdc > 0, true);
});
