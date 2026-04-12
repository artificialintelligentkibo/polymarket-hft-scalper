import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderbookHistory } from '../src/orderbook-history.js';
import { PaperTrader, simulateOrderbookWalk } from '../src/paper-trader.js';

function createPaperTrader(initialBalanceUsd = 100) {
  return new PaperTrader(
    {
      enabled: true,
      initialBalanceUsd,
      tradeLogFile: 'tmp/paper-trader.test.jsonl',
      makerFeeRate: 0,
      takerFeeRate: 0, // zero fees for test simplicity
      makerOrderTtlMs: 300_000,
      minOrderNotionalUsd: 1,
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
    },
    new OrderbookHistory()
  );
}

/**
 * Helper: directly simulate a taker fill against a synthetic book.
 * Creates a single-level book at the given price with enough depth.
 */
async function applyFillViaTaker(
  trader: PaperTrader,
  params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
  }
) {
  const emptyBook = {
    tokenId: 'tok',
    bids: [] as any[],
    asks: [] as any[],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    depthSharesBid: 0,
    depthSharesAsk: 0,
    depthNotionalBid: 0,
    depthNotionalAsk: 0,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest' as const,
    updatedAt: new Date().toISOString(),
  };

  // Build a book with liquidity at the desired price
  const bookWithLiquidity = {
    ...emptyBook,
    asks: params.side === 'BUY' ? [{ price: params.price, size: params.shares * 2 }] : [],
    bids: params.side === 'SELL' ? [{ price: params.price, size: params.shares * 2 }] : [],
    bestAsk: params.side === 'BUY' ? params.price : null,
    bestBid: params.side === 'SELL' ? params.price : null,
  };

  const yesBook = params.outcome === 'YES' ? bookWithLiquidity : emptyBook;
  const noBook = params.outcome === 'NO' ? bookWithLiquidity : emptyBook;

  await trader.simulateOrder({
    marketId: params.marketId,
    marketTitle: 'Test Market',
    signalType: 'SNIPER_BUY' as any,
    tokenId: 'tok',
    outcome: params.outcome,
    side: params.side,
    shares: params.shares,
    price: params.price,
    orderType: 'GTC' as any,
    postOnly: false,
    urgency: 'cross', // taker = instant fill
    currentOrderbook: {
      marketId: params.marketId,
      title: 'Test Market',
      timestamp: new Date().toISOString(),
      yes: yesBook,
      no: noBook,
      combined: {
        combinedBid: null,
        combinedAsk: null,
        combinedMid: null,
        combinedDiscount: null,
        combinedPremium: null,
        pairSpread: null,
      },
    },
  });
}

test('simulateOrderbookWalk averages across multiple ask levels for buys', () => {
  // 20 @ 0.03 + 30 @ 0.04 = 0.60 + 1.20 = 1.80 / 50 = 0.036
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
      { price: 0.54, size: 10 },
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

test('paper trader resolves a YES winner with the correct positive pnl', async () => {
  const trader = createPaperTrader();
  await applyFillViaTaker(trader, {
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
  assert.equal(trader.hasOpenPosition('market-1'), false);
});

test('paper trader resolves a YES loser with the correct negative pnl', async () => {
  const trader = createPaperTrader();
  await applyFillViaTaker(trader, {
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
  assert.equal(trader.hasOpenPosition('market-1'), false);
});

test('paper trader gives the same paired-arb pnl when YES wins', async () => {
  const trader = createPaperTrader();
  await applyFillViaTaker(trader, {
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });
  await applyFillViaTaker(trader, {
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
});

test('paper trader gives the same paired-arb pnl when NO wins', async () => {
  const trader = createPaperTrader();
  await applyFillViaTaker(trader, {
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.35,
  });
  await applyFillViaTaker(trader, {
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
});

test('paper trader keeps an unbalanced losing side negative instead of phantom positive', async () => {
  const trader = createPaperTrader();
  await applyFillViaTaker(trader, {
    marketId: 'market-1',
    outcome: 'YES',
    side: 'BUY',
    shares: 32,
    price: 0.32,
  });
  await applyFillViaTaker(trader, {
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

  // 32 YES at 0.32 = 10.24 cost, pays 0 (lost)
  // 6 NO at 0.62 = 3.72 cost, pays 6 (won)
  // PnL = 0 + 6 - 10.24 - 3.72 = -7.96
  assert.ok(resolution.pnl < 0, `Expected negative PnL but got ${resolution.pnl}`);
  assert.equal(resolution.noValue, 6);
  assert.equal(resolution.yesValue, 0);
});

test('pending maker order fills when book crosses price', async () => {
  const history = new OrderbookHistory();
  const trader = new PaperTrader(
    {
      enabled: true,
      initialBalanceUsd: 100,
      tradeLogFile: 'tmp/paper-trader.test.jsonl',
      makerFeeRate: 0,
      takerFeeRate: 0.02,
      makerOrderTtlMs: 300_000,
      minOrderNotionalUsd: 1,
      simulatedLatencyMinMs: 0,
      simulatedLatencyMaxMs: 0,
      fillProbability: { passive: 1, improve: 1, cross: 1 },
      slippageModel: { maxSlippageTicks: 0, sizeImpactFactor: 1 },
      partialFillEnabled: true,
      minFillRatio: 1,
    },
    history
  );

  const emptyTokenBook = {
    tokenId: 'tok',
    bids: [] as any[],
    asks: [{ price: 0.55, size: 100 }],
    bestBid: null,
    bestAsk: 0.55,
    midPrice: null,
    spread: null,
    spreadBps: null,
    depthSharesBid: 0,
    depthSharesAsk: 100,
    depthNotionalBid: 0,
    depthNotionalAsk: 55,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest' as const,
    updatedAt: new Date().toISOString(),
  };

  const marketBook = {
    marketId: 'market-1',
    title: 'Test',
    timestamp: new Date().toISOString(),
    yes: emptyTokenBook,
    no: { ...emptyTokenBook, asks: [], bestAsk: null, depthSharesAsk: 0, depthNotionalAsk: 0 },
    combined: {
      combinedBid: null, combinedAsk: null, combinedMid: null,
      combinedDiscount: null, combinedPremium: null, pairSpread: null,
    },
  };

  // Submit a passive BUY at 0.49 (below ask of 0.55 → queued as pending)
  const result = await trader.simulateOrder({
    marketId: 'market-1',
    marketTitle: 'Test',
    signalType: 'OBI_ENTRY_BUY' as any,
    tokenId: 'tok',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.49,
    orderType: 'GTC' as any,
    postOnly: true,
    urgency: 'passive',
    currentOrderbook: marketBook,
  });

  assert.equal(result.fillConfirmed, false, 'Should not be filled immediately');
  assert.equal(trader.hasOpenPosition('market-1'), false, 'No position yet');
  assert.equal(trader.getPendingOrderCount(), 1, 'Should have 1 pending order');

  // Tick 1: book hasn't crossed yet (bestAsk still 0.55)
  trader.tickPendingOrders('market-1', marketBook);
  assert.equal(trader.hasOpenPosition('market-1'), false, 'Still no fill');
  assert.equal(trader.getPendingOrderCount(), 1);

  // Tick 2: book crosses! Someone sells at 0.49
  const crossedBook = {
    ...marketBook,
    yes: {
      ...emptyTokenBook,
      asks: [{ price: 0.49, size: 50 }],
      bestAsk: 0.49,
    },
  };
  trader.tickPendingOrders('market-1', crossedBook);
  assert.equal(trader.hasOpenPosition('market-1'), true, 'Should be filled now');
  assert.equal(trader.getPendingOrderCount(), 0, 'No more pending');
  // Balance should be 100 - 10*0.49 = 95.10 (maker fee = 0)
  assert.equal(trader.getBalance(), 95.1);
});

test('pending maker order expires when market ends', async () => {
  const history = new OrderbookHistory();
  const trader = new PaperTrader(
    {
      enabled: true,
      initialBalanceUsd: 100,
      tradeLogFile: 'tmp/paper-trader.test.jsonl',
      makerFeeRate: 0,
      takerFeeRate: 0.02,
      makerOrderTtlMs: 1, // 1ms TTL = expires immediately
      minOrderNotionalUsd: 1,
      simulatedLatencyMinMs: 0,
      simulatedLatencyMaxMs: 0,
      fillProbability: { passive: 1, improve: 1, cross: 1 },
      slippageModel: { maxSlippageTicks: 0, sizeImpactFactor: 1 },
      partialFillEnabled: true,
      minFillRatio: 1,
    },
    history
  );

  const emptyTokenBook = {
    tokenId: 'tok',
    bids: [] as any[],
    asks: [{ price: 0.55, size: 100 }],
    bestBid: null,
    bestAsk: 0.55,
    midPrice: null,
    spread: null,
    spreadBps: null,
    depthSharesBid: 0,
    depthSharesAsk: 100,
    depthNotionalBid: 0,
    depthNotionalAsk: 55,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest' as const,
    updatedAt: new Date().toISOString(),
  };

  const marketBook = {
    marketId: 'market-1',
    title: 'Test',
    timestamp: new Date().toISOString(),
    yes: emptyTokenBook,
    no: { ...emptyTokenBook, asks: [], bestAsk: null },
    combined: {
      combinedBid: null, combinedAsk: null, combinedMid: null,
      combinedDiscount: null, combinedPremium: null, pairSpread: null,
    },
  };

  await trader.simulateOrder({
    marketId: 'market-1',
    marketTitle: 'Test',
    signalType: 'OBI_ENTRY_BUY' as any,
    tokenId: 'tok',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.49,
    orderType: 'GTC' as any,
    postOnly: true,
    urgency: 'passive',
    currentOrderbook: marketBook,
  });

  // Wait for TTL to expire
  await new Promise(r => setTimeout(r, 5));

  // Tick should expire the order
  trader.tickPendingOrders('market-1', marketBook);
  assert.equal(trader.hasOpenPosition('market-1'), false, 'Should not be filled');
  assert.equal(trader.getPendingOrderCount(), 0, 'Order expired');
  assert.equal(trader.getBalance(), 100, 'Balance unchanged');
});

test('taker order applies fee correctly', async () => {
  const trader = new PaperTrader(
    {
      enabled: true,
      initialBalanceUsd: 100,
      tradeLogFile: 'tmp/paper-trader.test.jsonl',
      makerFeeRate: 0,
      takerFeeRate: 0.02,
      makerOrderTtlMs: 300_000,
      minOrderNotionalUsd: 1,
      simulatedLatencyMinMs: 0,
      simulatedLatencyMaxMs: 0,
      fillProbability: { passive: 1, improve: 1, cross: 1 },
      slippageModel: { maxSlippageTicks: 0, sizeImpactFactor: 1 },
      partialFillEnabled: true,
      minFillRatio: 1,
    },
    new OrderbookHistory()
  );

  const tokenBook = {
    tokenId: 'tok',
    bids: [] as any[],
    asks: [{ price: 0.40, size: 100 }],
    bestBid: null,
    bestAsk: 0.40,
    midPrice: null,
    spread: null,
    spreadBps: null,
    depthSharesBid: 0,
    depthSharesAsk: 100,
    depthNotionalBid: 0,
    depthNotionalAsk: 40,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest' as const,
    updatedAt: new Date().toISOString(),
  };

  await trader.simulateOrder({
    marketId: 'market-1',
    marketTitle: 'Test',
    signalType: 'SNIPER_BUY' as any,
    tokenId: 'tok',
    outcome: 'YES',
    side: 'BUY',
    shares: 10,
    price: 0.40,
    orderType: 'GTC' as any,
    postOnly: false,
    urgency: 'cross',
    currentOrderbook: {
      marketId: 'market-1',
      title: 'Test',
      timestamp: new Date().toISOString(),
      yes: tokenBook,
      no: { ...tokenBook, asks: [], bestAsk: null },
      combined: {
        combinedBid: null, combinedAsk: null, combinedMid: null,
        combinedDiscount: null, combinedPremium: null, pairSpread: null,
      },
    },
  });

  // 10 shares at 0.40 = $4.00 cost
  // Fee = 0.02 * min(0.40, 0.60) * 10 = 0.02 * 0.40 * 10 = $0.08
  // Balance = 100 - 4.00 - 0.08 = 95.92
  assert.equal(trader.getBalance(), 95.92);
  assert.equal(trader.hasOpenPosition('market-1'), true);
});
