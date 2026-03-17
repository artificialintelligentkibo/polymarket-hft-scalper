import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/position-manager.js';
import {
  SignalScalper,
  hasBuyEdge,
  hasSellEdge,
  scaleSharesForLiquidity,
} from '../src/signal-scalper.js';
import type { MarketCandidate } from '../src/monitor.js';
import type { MarketOrderbookSnapshot } from '../src/clob-fetcher.js';

test('buy and sell edge helpers follow configured thresholds', () => {
  assert.equal(hasBuyEdge(0.45, 0.47, 0.018), true);
  assert.equal(hasBuyEdge(0.453, 0.47, 0.018), false);
  assert.equal(hasSellEdge(0.49, 0.47, 0.015), true);
  assert.equal(hasSellEdge(0.482, 0.47, 0.015), false);
});

test('liquidity-based sizing stays within configured bounds', () => {
  assert.equal(scaleSharesForLiquidity(500, 100), 8);
  assert.equal(scaleSharesForLiquidity(2500, 200), 35);
});

test('signal scalper emits BUY when token trades below mid by threshold', () => {
  const signal = new SignalScalper();
  const positionManager = new PositionManager('market-1');

  const market: MarketCandidate = {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'BTC 5m test market',
    liquidityUsd: 1800,
    volumeUsd: 5000,
    startTime: null,
    endTime: null,
    durationMinutes: 5,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesLabel: 'Up',
    noLabel: 'Down',
    yesOutcomeIndex: 0,
    noOutcomeIndex: 1,
    acceptingOrders: true,
  };

  const orderbook: MarketOrderbookSnapshot = {
    marketId: 'market-1',
    title: market.title,
    timestamp: new Date().toISOString(),
    yes: {
      tokenId: 'yes-token',
      bids: [],
      asks: [],
      bestBid: 0.45,
      bestAsk: 0.455,
      midPrice: 0.47,
      spread: 0.005,
      spreadBps: 106.38,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 45,
      depthNotionalAsk: 45.5,
      lastTradePrice: 0.449,
      lastTradeSize: 20,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
    no: {
      tokenId: 'no-token',
      bids: [],
      asks: [],
      bestBid: 0.53,
      bestAsk: 0.535,
      midPrice: 0.5325,
      spread: 0.005,
      spreadBps: 93.9,
      depthSharesBid: 100,
      depthSharesAsk: 100,
      depthNotionalBid: 53,
      depthNotionalAsk: 53.5,
      lastTradePrice: 0.534,
      lastTradeSize: 20,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    },
  };

  const decision = signal.evaluate({
    market,
    orderbook,
    positionManager,
  });

  assert.equal(decision.action, 'BUY');
  assert.equal(decision.outcome, 'YES');
  assert.equal(decision.targetPrice, 0.455);
});
