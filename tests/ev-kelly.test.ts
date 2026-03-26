import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEVKellyFilter,
  calculateKellySize,
  getTakerFee,
} from '../src/ev-kelly.js';
import type { StrategySignal } from '../src/strategy-types.js';

const baseSignal: StrategySignal = {
  marketId: 'market-1',
  marketTitle: 'Bitcoin Up or Down',
  signalType: 'FAIR_VALUE_BUY',
  priority: 100,
  action: 'BUY',
  outcome: 'YES',
  outcomeIndex: 0,
  shares: 20,
  targetPrice: 0.5,
  referencePrice: 0.5,
  tokenPrice: 0.5,
  midPrice: 0.5,
  fairValue: 0.49,
  edgeAmount: 0.01,
  combinedBid: null,
  combinedAsk: null,
  combinedMid: null,
  combinedDiscount: null,
  combinedPremium: null,
  fillRatio: 1,
  capitalClamp: 1,
  priceMultiplier: 1,
  urgency: 'cross',
  reduceOnly: false,
  reason: 'test',
};

const config = {
  enabled: true,
  minEVThreshold: 0.005,
  minEVThresholdHighFee: 0.008,
  kellyFraction: 0.85,
  maxBankrollPerTrade: 0.2,
  preferMakerOrders: true,
  defaultTakerFee: 0.02,
  highFeeTakerFee: 0.0315,
};

test('applyEVKellyFilter blocks negative EV entries', () => {
  const result = applyEVKellyFilter({
    signal: {
      ...baseSignal,
      targetPrice: 0.52,
      tokenPrice: 0.52,
      midPrice: 0.52,
      fairValue: 0.49,
    },
    bankroll: 100,
    marketTitle: 'General binary market',
    config,
  });

  assert.equal(result.approved, false);
  assert.equal(result.filterReason, 'EV_NEGATIVE');
});

test('applyEVKellyFilter uses higher EV threshold for 5-minute crypto up/down markets', () => {
  const result = applyEVKellyFilter({
    signal: {
      ...baseSignal,
      targetPrice: 0.49,
      tokenPrice: 0.49,
      midPrice: 0.49,
      fairValue: 0.511,
    },
    bankroll: 100,
    marketTitle: 'BTC Up or Down - 5m',
    config,
  });

  assert.equal(result.approved, false);
  assert.equal(result.filterReason, 'EV_TOO_LOW');
  assert.equal(result.takerFee, 0.0315);
});

test('calculateKellySize stays positive and caps bankroll usage', () => {
  const shares = calculateKellySize({
    trueProb: 0.6,
    marketProb: 0.5,
    bankroll: 100,
    price: 0.5,
    kellyFraction: 0.85,
    maxBankrollPct: 0.2,
  });

  assert.equal(shares > 0, true);
  assert.equal(shares <= 40, true);
});

test('getTakerFee returns high fee for 5-minute crypto up/down titles', () => {
  assert.equal(getTakerFee('Bitcoin Up or Down - 5m', config), 0.0315);
  assert.equal(getTakerFee('Will CPI exceed estimates?', config), 0.02);
});
