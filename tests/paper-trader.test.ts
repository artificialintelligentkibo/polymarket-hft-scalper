import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderbookHistory } from '../src/orderbook-history.js';
import { PaperTrader, simulateOrderbookWalk } from '../src/paper-trader.js';

function createPaperTrader(initialBalanceUsd = 100) {
  return new PaperTrader(
    {
      enabled: true,
      simulatedLatencyMinMs: 0,
      simulatedLatencyMaxMs: 0,
      fillProbability: {
        passive: 1,
        improve: 1,
        cross: 1,
      },
      slippageModel: {
        maxSlippageTicks: 0,
        sizeImpactFactor: 1,
      },
      partialFillEnabled: true,
      minFillRatio: 1,
      initialBalanceUsd,
      tradeLogFile: 'tmp/paper-trader.test.jsonl',
    },
    new OrderbookHistory()
  ) as any;
}

test('simulateOrderbookWalk averages across multiple ask levels for buys', () => {
  const walked = simulateOrderbookWalk(
    [
      { price: 0.03, size: 20 },
      { price: 0.04, size: 30 },
      { price: 0.05, size: 50 },
    ],
    50,
    'BUY'
  );

  assert.deepEqual(walked, {
    filledShares: 50,
    avgPrice: 0.036,
    slippage: 0.006,
  });
});

test('simulateOrderbookWalk averages across multiple bid levels for sells', () => {
  const walked = simulateOrderbookWalk(
    [
      { price: 0.55, size: 10 },
      { price: 0.54, size: 15 },
      { price: 0.53, size: 30 },
    ],
    20,
    'SELL'
  );

  assert.deepEqual(walked, {
    filledShares: 20,
    avgPrice: 0.545,
    slippage: 0.005,
  });
});

test('paper trader resolves a YES winner with the correct positive pnl', () => {
  const trader = createPaperTrader();
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });

  const resolution = trader.resolveSlot({
    marketId: 'market-1',
    winningOutcome: 'YES',
  });

  assert.deepEqual(resolution, {
    pnl: 6.5,
    yesValue: 10,
    noValue: 0,
  });
  assert.equal(trader.getBalance(), 106.5);
  assert.equal(trader.getPnL(), 6.5);
  assert.equal(trader.hasOpenPosition('market-1'), false);
});

test('paper trader resolves a YES loser with the correct negative pnl', () => {
  const trader = createPaperTrader();
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });

  const resolution = trader.resolveSlot({
    marketId: 'market-1',
    winningOutcome: 'NO',
  });

  assert.deepEqual(resolution, {
    pnl: -3.5,
    yesValue: 0,
    noValue: 0,
  });
  assert.equal(trader.getBalance(), 96.5);
  assert.equal(trader.getPnL(), -3.5);
  assert.equal(trader.hasOpenPosition('market-1'), false);
});

test('paper trader gives the same paired-arb pnl when YES wins', () => {
  const trader = createPaperTrader();
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'NO',
    side: 'BUY',
    shares: 10,
    price: 0.6,
  });

  const resolution = trader.resolveSlot({
    marketId: 'market-1',
    winningOutcome: 'YES',
  });

  assert.deepEqual(resolution, {
    pnl: 0.5,
    yesValue: 10,
    noValue: 0,
  });
  assert.equal(trader.getBalance(), 100.5);
  assert.equal(trader.getPnL(), 0.5);
});

test('paper trader gives the same paired-arb pnl when NO wins', () => {
  const trader = createPaperTrader();
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'NO',
    side: 'BUY',
    shares: 10,
    price: 0.6,
  });

  const resolution = trader.resolveSlot({
    marketId: 'market-1',
    winningOutcome: 'NO',
  });

  assert.deepEqual(resolution, {
    pnl: 0.5,
    yesValue: 0,
    noValue: 10,
  });
  assert.equal(trader.getBalance(), 100.5);
  assert.equal(trader.getPnL(), 0.5);
});

test('paper trader keeps an unbalanced losing side negative instead of phantom positive', () => {
  const trader = createPaperTrader();
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 32,
    price: 0.32,
  });
  trader.applySimulatedFill({
    marketId: 'market-1',
    outcome: 'NO',
    side: 'BUY',
    shares: 6,
    price: 0.62,
  });

  const resolution = trader.resolveSlot({
    marketId: 'market-1',
    winningOutcome: 'NO',
  });

  assert.deepEqual(resolution, {
    pnl: -7.96,
    yesValue: 0,
    noValue: 6,
  });
  assert.equal(trader.getBalance(), 92.04);
  assert.equal(trader.getPnL(), -7.96);
});
