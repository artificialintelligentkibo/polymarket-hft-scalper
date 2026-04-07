import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketOrderbookSnapshot, Outcome, TokenBookSnapshot } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { ObiEngine, type ObiEngineConfig } from '../src/obi-engine.js';
import { PositionManager } from '../src/position-manager.js';

const FIXED_NOW = Date.parse('2026-04-07T16:01:00.000Z');
const SLOT_START = '2026-04-07T16:00:00.000Z';
const SLOT_END = '2026-04-07T16:05:00.000Z';

function baseConfig(overrides: Partial<ObiEngineConfig> = {}): ObiEngineConfig {
  return {
    enabled: true,
    thinThresholdUsd: 8,
    minLiquidityUsd: 500,
    entryImbalanceRatio: 0.35,
    exitRebalanceRatio: 0.65,
    entryShares: 8,
    maxPositionShares: 20,
    cooldownMs: 15_000,
    slotWarmupMs: 5_000,
    stopEntryBeforeEndMs: 60_000,
    cancelAllBeforeEndMs: 20_000,
    minEntryPrice: 0.04,
    maxEntryPrice: 0.5,
    scalpExitEdge: 0.08,
    mmAskEnabled: true,
    mmBidOppositeEnabled: false,
    mmAskSpreadTicks: 0.015,
    mmBidOppositeFactor: 0.25,
    shadowMode: false,
    aggressiveEntry: false,
    ...overrides,
  };
}

function createMarket(overrides: Partial<MarketCandidate> = {}): MarketCandidate {
  return {
    marketId: 'market-1',
    conditionId: 'market-1',
    title: 'BTC Up or Down',
    liquidityUsd: 2_500,
    volumeUsd: 6_000,
    startTime: SLOT_START,
    endTime: SLOT_END,
    durationMinutes: 5,
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesLabel: 'Up',
    noLabel: 'Down',
    yesOutcomeIndex: 0,
    noOutcomeIndex: 1,
    acceptingOrders: true,
    ...overrides,
  };
}

function makeBook(params: {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  bidDepth: number;
  askDepth: number;
}): TokenBookSnapshot {
  return {
    tokenId: params.tokenId,
    bids: [{ price: params.bestBid, size: 100 }],
    asks: [{ price: params.bestAsk, size: 100 }],
    bestBid: params.bestBid,
    bestAsk: params.bestAsk,
    midPrice: (params.bestBid + params.bestAsk) / 2,
    spread: params.bestAsk - params.bestBid,
    spreadBps: 0,
    depthSharesBid: 100,
    depthSharesAsk: 100,
    depthNotionalBid: params.bidDepth,
    depthNotionalAsk: params.askDepth,
    lastTradePrice: (params.bestBid + params.bestAsk) / 2,
    lastTradeSize: 10,
    source: 'rest',
    updatedAt: new Date().toISOString(),
  };
}

interface BookOpts {
  yesBid?: number;
  yesAsk?: number;
  yesBidDepth?: number;
  yesAskDepth?: number;
  noBid?: number;
  noAsk?: number;
  noBidDepth?: number;
  noAskDepth?: number;
}

function createOrderbook(opts: BookOpts = {}): MarketOrderbookSnapshot {
  const yes = makeBook({
    tokenId: 'yes-token',
    bestBid: opts.yesBid ?? 0.20,
    bestAsk: opts.yesAsk ?? 0.21,
    bidDepth: opts.yesBidDepth ?? 5,
    askDepth: opts.yesAskDepth ?? 600,
  });
  const no = makeBook({
    tokenId: 'no-token',
    bestBid: opts.noBid ?? 0.78,
    bestAsk: opts.noAsk ?? 0.80,
    bidDepth: opts.noBidDepth ?? 400,
    askDepth: opts.noAskDepth ?? 400,
  });
  return {
    marketId: 'market-1',
    title: 'BTC Up or Down',
    timestamp: new Date().toISOString(),
    yes,
    no,
    combined: {
      combinedBid: (yes.bestBid ?? 0) + (no.bestBid ?? 0),
      combinedAsk: (yes.bestAsk ?? 0) + (no.bestAsk ?? 0),
      combinedMid: 1,
      combinedDiscount: 0,
      combinedPremium: 0,
      pairSpread: 0,
    },
  };
}

test('obi engine returns no signals when disabled', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook(),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ enabled: false }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
});

test('obi engine skips outcomes with insufficient total liquidity', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBidDepth: 5,
      yesAskDepth: 50,
      noBidDepth: 50,
      noAskDepth: 50,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ minLiquidityUsd: 500 }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
});

test('obi engine skips when thin depth >= thin threshold', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBidDepth: 50,
      yesAskDepth: 800,
      noBidDepth: 800,
      noAskDepth: 800,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ thinThresholdUsd: 8 }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
});

test('obi engine skips when imbalance ratio above threshold', () => {
  const engine = new ObiEngine();
  // thin = 7, thick = 8 -> ratio 0.875 > 0.35
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBidDepth: 7,
      yesAskDepth: 8,
      noBidDepth: 700,
      noAskDepth: 700,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ minLiquidityUsd: 10 }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
});

test('obi engine emits OBI_ENTRY_BUY for YES when YES has thin bid', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 4,
      yesAskDepth: 800,
      noBid: 0.78,
      noAsk: 0.80,
      noBidDepth: 400,
      noAskDepth: 400,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.equal(signals.length, 1);
  const sig = signals[0]!;
  assert.equal(sig.signalType, 'OBI_ENTRY_BUY');
  assert.equal(sig.outcome, 'YES');
  assert.equal(sig.action, 'BUY');
  assert.equal(sig.targetPrice, 0.21);
  assert.equal(sig.urgency, 'passive');
  assert.equal(sig.strategyLayer, 'OBI');
});

test('obi engine emits OBI_ENTRY_BUY for NO when NO has thin ask', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBidDepth: 600,
      yesAskDepth: 600,
      noBid: 0.30,
      noAsk: 0.32,
      noBidDepth: 800,
      noAskDepth: 5,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.outcome, 'NO');
  assert.equal(signals[0]!.targetPrice, 0.32);
});

test('obi engine returns no entries during slot warmup', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBidDepth: 4,
      yesAskDepth: 800,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ slotWarmupMs: 30_000 }),
    nowMs: Date.parse(SLOT_START) + 1_000,
  });
  assert.deepEqual(signals, []);
});

test('obi engine respects cooldown window', () => {
  const engine = new ObiEngine();
  const cfg = baseConfig({ cooldownMs: 30_000 });
  const market = createMarket();
  const ob = createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 });
  const pm = new PositionManager('market-1');
  const first = engine.generateSignals({
    market,
    orderbook: ob,
    positionManager: pm,
    config: cfg,
    nowMs: FIXED_NOW,
  });
  assert.equal(first.length, 1);
  const second = engine.generateSignals({
    market,
    orderbook: ob,
    positionManager: pm,
    config: cfg,
    nowMs: FIXED_NOW + 5_000,
  });
  assert.deepEqual(second, []);
});

test('obi engine onEntryFill emits OBI_MM_QUOTE_ASK when enabled', () => {
  const engine = new ObiEngine();
  const ob = createOrderbook({
    yesBid: 0.20,
    yesAsk: 0.21,
    yesBidDepth: 4,
    yesAskDepth: 800,
  });
  const followOns = engine.onEntryFill({
    marketId: 'market-1',
    outcome: 'YES',
    fillPrice: 0.21,
    filledShares: 8,
    orderbook: ob,
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.ok(followOns.length >= 1);
  const ask = followOns.find((s) => s.signalType === 'OBI_MM_QUOTE_ASK');
  assert.ok(ask, 'expected OBI_MM_QUOTE_ASK');
  assert.equal(ask!.action, 'SELL');
  assert.equal(ask!.outcome, 'YES');
  assert.equal(ask!.reduceOnly, true);
  assert.equal(ask!.urgency, 'passive');
});

class FakePositionManager extends PositionManager {
  constructor(marketId: string, private readonly stub: Record<Outcome, number>) {
    super(marketId);
  }
  override getShares(outcome: Outcome): number {
    return this.stub[outcome];
  }
}

test('obi engine emits OBI_REBALANCE_EXIT when ratio recovers', () => {
  const engine = new ObiEngine();
  const market = createMarket();
  // Step 1: open position via onEntryFill (records initial state).
  engine.onEntryFill({
    marketId: market.marketId,
    outcome: 'YES',
    fillPrice: 0.21,
    filledShares: 8,
    orderbook: createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 }),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  // Step 2: book has rebalanced — bid now equals ask.
  const recoveredBook = createOrderbook({
    yesBid: 0.22,
    yesAsk: 0.23,
    yesBidDepth: 700,
    yesAskDepth: 700,
  });
  const exitSignals = engine.generateExitSignals({
    market,
    orderbook: recoveredBook,
    positionManager: new FakePositionManager(market.marketId, { YES: 8, NO: 0 }),
    config: baseConfig(),
    nowMs: FIXED_NOW + 10_000,
  });
  assert.equal(exitSignals.length, 1);
  assert.equal(exitSignals[0]!.signalType, 'OBI_REBALANCE_EXIT');
  assert.equal(exitSignals[0]!.action, 'SELL');
  assert.equal(exitSignals[0]!.reduceOnly, true);
});

test('obi engine emits OBI_SCALP_EXIT when bid moves above entry+edge', () => {
  const engine = new ObiEngine();
  const market = createMarket();
  engine.onEntryFill({
    marketId: market.marketId,
    outcome: 'YES',
    fillPrice: 0.20,
    filledShares: 8,
    orderbook: createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 }),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  // Move bid up to 0.30 (>= 0.20 * 1.08 = 0.216) but keep imbalance same
  // so that the rebalance exit does NOT trigger first.
  const scalpBook = createOrderbook({
    yesBid: 0.30,
    yesAsk: 0.31,
    yesBidDepth: 4,
    yesAskDepth: 800,
  });
  const exitSignals = engine.generateExitSignals({
    market,
    orderbook: scalpBook,
    positionManager: new FakePositionManager(market.marketId, { YES: 8, NO: 0 }),
    config: baseConfig(),
    nowMs: FIXED_NOW + 8_000,
  });
  assert.equal(exitSignals.length, 1);
  assert.equal(exitSignals[0]!.signalType, 'OBI_SCALP_EXIT');
});

test('obi engine shadow mode logs but emits no signals', () => {
  const engine = new ObiEngine();
  const before = engine.getStats();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ shadowMode: true }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
  const after = engine.getStats();
  assert.equal(after.totalShadowDecisions, before.totalShadowDecisions + 1);
});

test('obi engine clearState removes per-market state', () => {
  const engine = new ObiEngine();
  const market = createMarket();
  engine.onEntryFill({
    marketId: market.marketId,
    outcome: 'YES',
    fillPrice: 0.21,
    filledShares: 8,
    orderbook: createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 }),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.equal(engine.getStats().activePositions, 1);
  engine.clearState(market.marketId);
  assert.equal(engine.getStats().activePositions, 0);

  // After clearing, the cooldown is also gone, so a new entry is allowed.
  const signals = engine.generateSignals({
    market,
    orderbook: createOrderbook({ yesBidDepth: 4, yesAskDepth: 800 }),
    positionManager: new PositionManager(market.marketId),
    config: baseConfig(),
    nowMs: FIXED_NOW + 1_000,
  });
  assert.equal(signals.length, 1);
});
