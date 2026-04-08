import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketOrderbookSnapshot, Outcome, TokenBookSnapshot } from '../src/clob-fetcher.js';
import type { MarketCandidate } from '../src/monitor.js';
import { ObiEngine, type ObiEngineConfig, checkObiBinanceGate } from '../src/obi-engine.js';
import type { DeepBinanceAssessment } from '../src/binance-deep-integration.js';
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
    // Phase 15: needs to be high enough to cover dust-safety minimum.
    // At bestAsk=0.21, worstExit=0.063, minShares=ceil(2.5/0.063)=40 → use 60.
    maxPositionShares: 60,
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
    hardStopUsd: 2.0,
    minEntryNotionalUsd: 0,
    clobMinNotionalUsd: 1.0,
    clobMinShares: 5,
    losingExitCooldownMs: 0,
    losingExitCooldownByCoinMs: 0,
    imbalanceCollapseRatio: 1.5,
    preflightBalanceCheck: false,
    binanceGateEnabled: false,
    binanceRunawayAbsPct: 0.30,
    binanceContraAbsPct: 0.15,
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

test('Phase 10: YES thin-bid alone is rejected (directional bug fix)', () => {
  // Phase 10 (2026-04-08): thin-BID is a BEARISH imbalance signal, so
  // "BUY YES on thin-bid" catches falling knives. Live loss -$1.38 on
  // 2026-04-08 12:49 (YES @ 0.54 → hard stop @ 0.31 in 4 seconds).
  // Engine must now REJECT thin-bid setups. The symmetric NO candidate
  // (which would have thin-ask in a mirrored book) would still be picked
  // up — see the next test for the mirror case.
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 4,     // YES thin bid (bearish → do NOT buy YES)
      yesAskDepth: 800,
      noBid: 0.78,
      noAsk: 0.80,
      noBidDepth: 400,    // NO balanced (no imbalance on NO side)
      noAskDepth: 400,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
});

test('Phase 10: mirrored book (YES thin-bid / NO thin-ask) picks NO side', () => {
  // In a real Polymarket binary market, YES thin-bid implies NO thin-ask
  // because NO = 1 - YES. Engine must pick the bullish NO side.
  // Using prices within baseConfig maxEntryPrice=0.5 bounds.
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.64,
      yesAsk: 0.65,
      yesBidDepth: 4,     // YES thin bid — skipped by Phase 10
      yesAskDepth: 800,
      noBid: 0.34,
      noAsk: 0.35,
      noBidDepth: 800,    // NO thick bid (thick side)
      noAskDepth: 4,      // NO thin ask (bullish for NO → BUY NO)
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  assert.equal(signals.length, 1);
  const sig = signals[0]!;
  assert.equal(sig.signalType, 'OBI_ENTRY_BUY');
  assert.equal(sig.outcome, 'NO');
  assert.equal(sig.action, 'BUY');
  assert.equal(sig.targetPrice, 0.35);
  assert.equal(sig.urgency, 'cross');
});

test('obi engine emits OBI_ENTRY_BUY for YES when YES has thin ASK (post-Phase 10)', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 800,   // YES thick bid
      yesAskDepth: 4,     // YES thin ask (bullish for YES → BUY YES)
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
  assert.equal(sig.urgency, 'cross');
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
      yesBidDepth: 800,  // Phase 10: thin-ASK
      yesAskDepth: 4,
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
  const ob = createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 });
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

test('Phase 8: extractCoinFromObiTitle normalises Polymarket binary slot titles', async () => {
  const { extractCoinFromObiTitle } = await import('../src/obi-engine.js');
  assert.equal(extractCoinFromObiTitle('Bitcoin Up or Down - April 8, 8:30AM-8:35AM ET'), 'BTC');
  assert.equal(extractCoinFromObiTitle('BTC Up or Down - April 8, 8:30AM ET'), 'BTC');
  assert.equal(extractCoinFromObiTitle('Ethereum Up or Down'), 'ETH');
  assert.equal(extractCoinFromObiTitle('SOL Up or Down'), 'SOL');
  assert.equal(extractCoinFromObiTitle('Solana Up or Down'), 'SOL');
  assert.equal(extractCoinFromObiTitle('XRP Up or Down'), 'XRP');
  assert.equal(extractCoinFromObiTitle('Will Trump win'), null);
  assert.equal(extractCoinFromObiTitle(''), null);
});

test('Phase 8: coin-wide cooldown blocks entries on a different SOL slot after a SOL hard stop', () => {
  // Reproduces the 11:00 → 11:06 cascade: hard stop on SOL slot A at T=0,
  // then a fresh SOL slot B with the same imbalance condition at T+6min.
  // Without coin cooldown the per-market cooldown wouldn't apply (different
  // marketId). With Phase 8 the engine refuses entry until cooldown expires.
  const engine = new ObiEngine();
  const cfg = baseConfig({
    losingExitCooldownByCoinMs: 600_000, // 10 min
    losingExitCooldownMs: 0,             // disable per-market guard
    cooldownMs: 0,                       // disable normal cooldown
    hardStopUsd: 1.0,
    slotWarmupMs: 0,
    stopEntryBeforeEndMs: 0,
  });

  // Slot end set far in the future so 11+ min later we're still in-window.
  const farFutureEnd = new Date(Date.parse(SLOT_START) + 60 * 60_000).toISOString();

  // === Slot A: SOL, take a position and hard-stop it ===
  const slotA = createMarket({
    marketId: 'sol-slot-a',
    title: 'SOL Up or Down - 11:00AM ET',
    endTime: farFutureEnd,
  });
  const obA = createOrderbook({
    noBid: 0.43,
    noAsk: 0.44,
    noBidDepth: 800,  // Phase 10: thick bid
    noAskDepth: 4,    // Phase 10: thin ask (bullish)
  });
  const sigsA = engine.generateSignals({
    market: slotA,
    orderbook: obA,
    positionManager: new PositionManager(slotA.marketId),
    config: cfg,
    nowMs: FIXED_NOW,
  });
  assert.equal(sigsA.length, 1, 'should enter SOL slot A on imbalance');

  // Simulate the fill + hard stop on slot A.
  engine.onEntryFill({
    marketId: slotA.marketId,
    marketTitle: slotA.title,
    outcome: 'NO',
    fillPrice: 0.44,
    filledShares: 7,
    totalLiveShares: 7,
    orderbook: obA,
    config: cfg,
    nowMs: FIXED_NOW + 1_000,
  });
  // Drive the price below hard stop to trigger losing exit.
  const obAStopped = createOrderbook({
    noBid: 0.20,
    noAsk: 0.21,
    noBidDepth: 600,
    noAskDepth: 600,
  });
  const exitSignals = engine.generateExitSignals({
    market: slotA,
    orderbook: obAStopped,
    positionManager: (() => {
      const pm = new PositionManager(slotA.marketId);
      pm.applyFill({ outcome: 'NO', side: 'BUY', shares: 7, price: 0.44 });
      return pm;
    })(),
    config: cfg,
    nowMs: FIXED_NOW + 5_000,
  });
  assert.ok(
    exitSignals.some((s) => s.reason?.startsWith('OBI hard stop')),
    'expected hard stop exit on slot A'
  );

  // === Slot B: a DIFFERENT SOL market 6 min later — must be blocked ===
  const slotB = createMarket({
    marketId: 'sol-slot-b',
    title: 'SOL Up or Down - 11:05AM ET',
    endTime: farFutureEnd,
  });
  const sigsB = engine.generateSignals({
    market: slotB,
    orderbook: obA, // same imbalance shape
    positionManager: new PositionManager(slotB.marketId),
    config: cfg,
    nowMs: FIXED_NOW + 6 * 60_000, // 6 min later
  });
  assert.deepEqual(
    sigsB,
    [],
    'coin cooldown must block SOL slot B 6 min after SOL slot A loss'
  );

  // === A different coin (BTC) at the same time should NOT be blocked ===
  const btcSlot = createMarket({
    marketId: 'btc-slot',
    title: 'Bitcoin Up or Down - 11:05AM ET',
    endTime: farFutureEnd,
  });
  const sigsBtc = engine.generateSignals({
    market: btcSlot,
    orderbook: obA,
    positionManager: new PositionManager(btcSlot.marketId),
    config: cfg,
    nowMs: FIXED_NOW + 6 * 60_000,
  });
  assert.equal(sigsBtc.length, 1, 'BTC slot must be allowed (different coin)');

  // === After cooldown elapses, SOL slot B is allowed again ===
  const sigsBLater = engine.generateSignals({
    market: createMarket({
      marketId: 'sol-slot-c',
      title: 'SOL Up or Down - 11:15AM ET',
      endTime: farFutureEnd,
    }),
    orderbook: obA,
    positionManager: new PositionManager('sol-slot-c'),
    config: cfg,
    nowMs: FIXED_NOW + 11 * 60_000, // 11 min later, past 10-min cooldown
  });
  assert.equal(sigsBLater.length, 1, 'SOL must be allowed again past cooldown');
});

test('Phase 8: coin cooldown set to 0 disables the gate entirely', () => {
  const engine = new ObiEngine();
  const cfg = baseConfig({
    losingExitCooldownByCoinMs: 0, // disabled
    losingExitCooldownMs: 0,
    cooldownMs: 0,
    hardStopUsd: 1.0,
    slotWarmupMs: 0,
  });

  // Trigger a hard stop on SOL.
  const slotA = createMarket({ marketId: 'sol-a', title: 'SOL Up or Down' });
  engine.onEntryFill({
    marketId: slotA.marketId,
    marketTitle: slotA.title,
    outcome: 'NO',
    fillPrice: 0.44,
    filledShares: 7,
    totalLiveShares: 7,
    orderbook: createOrderbook({ noBid: 0.43, noAsk: 0.44 }),
    config: cfg,
    nowMs: FIXED_NOW,
  });
  engine.generateExitSignals({
    market: slotA,
    orderbook: createOrderbook({ noBid: 0.20, noAsk: 0.21 }),
    positionManager: (() => {
      const pm = new PositionManager(slotA.marketId);
      pm.applyFill({ outcome: 'NO', side: 'BUY', shares: 7, price: 0.44 });
      return pm;
    })(),
    config: cfg,
    nowMs: FIXED_NOW + 5_000,
  });

  // Different SOL slot 1 second later — must be allowed.
  const slotB = createMarket({ marketId: 'sol-b', title: 'SOL Up or Down' });
  const sigs = engine.generateSignals({
    market: slotB,
    orderbook: createOrderbook({ noBid: 0.43, noAsk: 0.44, noBidDepth: 800, noAskDepth: 4 }),
    positionManager: new PositionManager(slotB.marketId),
    config: cfg,
    nowMs: FIXED_NOW + 6_000,
  });
  assert.equal(sigs.length, 1, 'with gate disabled, immediate re-entry allowed');
});

test('obi engine onEntryFill emits OBI_MM_QUOTE_ASK when enabled', () => {
  const engine = new ObiEngine();
  const ob = createOrderbook({
    yesBid: 0.20,
    yesAsk: 0.21,
    yesBidDepth: 800,  // Phase 10: flip to thin-ASK
    yesAskDepth: 4,
  });
  const followOns = engine.onEntryFill({
    marketId: 'market-1',
    outcome: 'YES',
    fillPrice: 0.21,
    filledShares: 8,
    totalLiveShares: 8,
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

test('OBI_MM_QUOTE_ASK never crosses book — regression for 2026-04-08 SOL/NO incident', () => {
  // Live incident: bot bought 9 NO @ 0.34, bestBid was 0.34 / bestAsk was 0.35.
  // The old formula `entryVWAP * (1 + 0.015) = 0.3451` got rounded by CLOB to a
  // tick that crossed bestBid → 6 consecutive "order crosses book" rejections.
  // After the fix, MM_QUOTE_ASK price must be:
  //   - on a valid tick grid (multiple of 0.01 for prices ≥ 0.10)
  //   - strictly above bestBid
  //   - at or above bestAsk (so post-only never matches)
  const engine = new ObiEngine();
  const ob = createOrderbook({
    noBid: 0.34,
    noAsk: 0.35,
    noBidDepth: 200,
    noAskDepth: 20,
  });
  const followOns = engine.onEntryFill({
    marketId: 'market-1',
    outcome: 'NO',
    fillPrice: 0.34,
    filledShares: 9,
    totalLiveShares: 9,
    orderbook: ob,
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  const ask = followOns.find((s) => s.signalType === 'OBI_MM_QUOTE_ASK');
  assert.ok(ask, 'expected OBI_MM_QUOTE_ASK');
  // Snapped UP to 0.01 tick grid: ceil(max(0.3451, 0.35) / 0.01) * 0.01 = 0.35
  assert.equal(ask!.targetPrice, 0.35);
  // Strictly above bestBid (would otherwise cross)
  assert.ok(ask!.targetPrice! > 0.34, 'targetPrice must be strictly above bestBid');
  // At least at bestAsk (joins queue, doesn't cross)
  assert.ok(ask!.targetPrice! >= 0.35, 'targetPrice must be ≥ bestAsk');
  // Tick alignment — no fractional cents
  const remainder = Math.round(ask!.targetPrice! * 1000) % 10;
  assert.equal(remainder, 0, 'targetPrice must be on 0.01 tick grid');
});

test('OBI_MM_QUOTE_ASK respects spread target when it sits above bestAsk', () => {
  // When spread target (entryVWAP * 1.05) is above bestAsk, the engine should
  // prefer the wider spread and snap it up to the tick grid.
  const engine = new ObiEngine();
  const ob = createOrderbook({
    yesBid: 0.20,
    yesAsk: 0.21,
    yesBidDepth: 800,  // Phase 10: flip to thin-ASK
    yesAskDepth: 4,
  });
  const followOns = engine.onEntryFill({
    marketId: 'market-1',
    outcome: 'YES',
    fillPrice: 0.20,
    filledShares: 8,
    totalLiveShares: 8,
    orderbook: ob,
    config: baseConfig({ mmAskSpreadTicks: 0.10 }), // 10% spread → 0.22
    nowMs: FIXED_NOW,
  });
  const ask = followOns.find((s) => s.signalType === 'OBI_MM_QUOTE_ASK');
  assert.ok(ask);
  // 0.20 * 1.10 = 0.22, snapped to 0.01 tick = 0.22
  assert.equal(ask!.targetPrice, 0.22);
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
    totalLiveShares: 8,
    orderbook: createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 }),
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
    totalLiveShares: 8,
    orderbook: createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 }),
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  // Move bid up to 0.30 (>= 0.20 * 1.08 = 0.216) but keep imbalance same
  // so that the rebalance exit does NOT trigger first.
  const scalpBook = createOrderbook({
    yesBid: 0.30,
    yesAsk: 0.31,
    yesBidDepth: 800,  // Phase 10: thin-ASK (imbalance for exit check)
    yesAskDepth: 4,
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
    orderbook: createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({ shadowMode: true }),
    nowMs: FIXED_NOW,
  });
  assert.deepEqual(signals, []);
  const after = engine.getStats();
  assert.equal(after.totalShadowDecisions, before.totalShadowDecisions + 1);
});

test('obi engine clearState removes per-market state but preserves losing-exit cooldown', () => {
  // 2026-04-08 whipsaw re-entry regression: market 0x3ff0a5a cycled
  // entry → exit (loss) → wallet reconcile → clearState → re-entry
  // → hard stop within ~60 seconds on the same marketId because the
  // losing-exit cooldown marker was wiped by clearState. Now clearState
  // must preserve lastLosingExitMs so the cooldown survives the
  // post-exit position cleanup.
  const engine = new ObiEngine();
  const market = createMarket();
  const ob = createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 });
  const cfg = baseConfig();
  const losingCooldownCfg = { ...cfg, losingExitCooldownMs: 300_000 };

  engine.onEntryFill({
    marketId: market.marketId,
    outcome: 'YES',
    fillPrice: 0.21,
    filledShares: 8,
    totalLiveShares: 8,
    orderbook: ob,
    config: losingCooldownCfg,
    nowMs: FIXED_NOW,
  });
  assert.equal(engine.getStats().activePositions, 1);

  // Trigger a losing exit so lastLosingExitMs is recorded.
  const pm = new PositionManager(market.marketId);
  pm.applyFill({ outcome: 'YES', side: 'BUY', shares: 8, price: 0.21 });
  // Force an imbalance collapse: position was entered with thinSide='ask'
  // (bullish setup per Phase 10), and the book now flips to thin-bid
  // (bearish) — ratio of stored thinSide inverts past imbalanceCollapseRatio.
  const collapseBook = createOrderbook({
    yesBid: 0.18,
    yesAsk: 0.19,
    yesBidDepth: 4,    // bid became thin — bearish collapse for YES
    yesAskDepth: 800,  // ask became thick
  });
  const exitSignals = engine.generateExitSignals({
    market,
    orderbook: collapseBook,
    positionManager: pm,
    config: losingCooldownCfg,
    nowMs: FIXED_NOW + 1_000,
  });
  assert.equal(exitSignals.length, 1, 'losing exit must be emitted');

  // Wallet reconcile-style cleanup: clearState after position closes.
  engine.clearState(market.marketId);
  assert.equal(engine.getStats().activePositions, 0);

  // Re-entry on the SAME marketId within the cooldown window must be
  // blocked, even though clearState was called.
  const reentrySignals = engine.generateSignals({
    market,
    orderbook: ob,
    positionManager: new PositionManager(market.marketId),
    config: losingCooldownCfg,
    nowMs: FIXED_NOW + 60_000, // 1 min later, well inside 5 min cooldown
  });
  assert.equal(
    reentrySignals.length,
    0,
    'losing-exit cooldown must persist across clearState'
  );
});

// Regression: 2026-04-08 XRP $5.28 incident.
//
// Two-clip partial fill (10 + 2 shares) used to overwrite the position state
// on the second call AND emit an MM_QUOTE_ASK sized to just the 2-share
// increment. The undersized quote then failed CLOB minimums and triggered
// dust-abandonment of the entire 12-share position.
//
// After the fix:
//   - the second onEntryFill must accumulate (12 total shares, VWAP price)
//   - the emitted MM_QUOTE_ASK must be sized to the FULL accumulated position
test('obi engine onEntryFill accumulates multi-clip partial fills (2026-04-08 regression)', () => {
  const engine = new ObiEngine();
  const ob = createOrderbook({
    yesBid: 0.43,
    yesAsk: 0.44,
    yesBidDepth: 800,  // Phase 10: thin-ASK
    yesAskDepth: 4,
  });

  // First clip: 10 shares filled @ $0.44
  const firstFollowOns = engine.onEntryFill({
    marketId: 'market-xrp',
    outcome: 'NO',
    fillPrice: 0.44,
    filledShares: 10,
    totalLiveShares: 10,
    orderbook: ob,
    config: baseConfig(),
    nowMs: FIXED_NOW,
  });
  const firstAsk = firstFollowOns.find((s) => s.signalType === 'OBI_MM_QUOTE_ASK');
  assert.ok(firstAsk, 'first MM_QUOTE_ASK expected');
  assert.equal(firstAsk!.shares, 10, 'first quote should be sized to 10 shares');

  // Second clip: 2 more shares fill @ $0.45 (slightly different price to
  // exercise VWAP). totalLiveShares is now 12.
  const secondFollowOns = engine.onEntryFill({
    marketId: 'market-xrp',
    outcome: 'NO',
    fillPrice: 0.45,
    filledShares: 2,
    totalLiveShares: 12,
    orderbook: ob,
    config: baseConfig(),
    nowMs: FIXED_NOW + 1_000,
  });
  const secondAsk = secondFollowOns.find((s) => s.signalType === 'OBI_MM_QUOTE_ASK');
  assert.ok(secondAsk, 'second MM_QUOTE_ASK expected');
  assert.equal(
    secondAsk!.shares,
    12,
    'second quote MUST be sized to FULL accumulated position (12), not increment (2)'
  );
  // Reference price should be VWAP of (10*0.44 + 2*0.45)/12 = 0.4417
  assert.ok(
    Math.abs((secondAsk!.referencePrice ?? 0) - 0.441667) < 0.001,
    `expected VWAP ~0.4417, got ${secondAsk!.referencePrice}`
  );

  // Position state should also be accumulated (single position, 12 shares).
  const positions = engine.getActivePositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.entryShares, 12);
});

// Regression: 2026-04-08 orphan-flatten spam.
//
// Once a slot ends, getOrphanFlattenSignals used to re-emit a flatten on
// every tick (~2.5s) with no throttle and no upper bound on lateness. After
// the fix:
//   - successive calls within 5s of an emit must NOT re-emit
//   - once the slot has been over for >120s, the position is dropped from
//     tracking and no further signals are emitted
test('obi engine getOrphanFlattenSignals throttles and gives up after 120s', () => {
  const engine = new ObiEngine();
  const slotEnd = '2026-04-08T05:50:00Z';
  const slotEndMs = Date.parse(slotEnd);

  engine.onEntryFill({
    marketId: 'market-orphan',
    marketTitle: 'Orphan Test',
    outcome: 'YES',
    fillPrice: 0.30,
    filledShares: 12,
    totalLiveShares: 12,
    orderbook: createOrderbook({ yesBidDepth: 800, yesAskDepth: 4 }),
    config: baseConfig(),
    slotEndTime: slotEnd,
    nowMs: slotEndMs - 60_000,
  });

  const pmFactory = (marketId: string) =>
    marketId === 'market-orphan'
      ? new FakePositionManager(marketId, { YES: 12, NO: 0 })
      : null;

  // First call after slot end — should emit.
  const first = engine.getOrphanFlattenSignals({
    positionManager: pmFactory,
    config: baseConfig(),
    nowMs: slotEndMs + 5_000,
  });
  assert.equal(first.length, 1, 'first call should emit one flatten signal');

  // Immediately after — throttled.
  const second = engine.getOrphanFlattenSignals({
    positionManager: pmFactory,
    config: baseConfig(),
    nowMs: slotEndMs + 6_000,
  });
  assert.equal(second.length, 0, 'second call within 5s must be throttled');

  // After throttle window expires — emits again.
  const third = engine.getOrphanFlattenSignals({
    positionManager: pmFactory,
    config: baseConfig(),
    nowMs: slotEndMs + 11_000,
  });
  assert.equal(third.length, 1, 'after throttle window, should emit again');

  // Far past slot end — give up entirely, position dropped from tracking.
  const fourth = engine.getOrphanFlattenSignals({
    positionManager: pmFactory,
    config: baseConfig(),
    nowMs: slotEndMs + 130_000,
  });
  assert.equal(fourth.length, 0, 'past 120s give-up window, must not emit');
  assert.equal(
    engine.getActivePositions().length,
    0,
    'position should be dropped from tracking after give-up'
  );
});

/* ------------------------------------------------------------------ */
/*  Binance runaway gate                                               */
/* ------------------------------------------------------------------ */

function makeAssessment(overrides: Partial<DeepBinanceAssessment> = {}): DeepBinanceAssessment {
  return {
    available: true,
    coin: 'BTC',
    symbol: 'BTCUSDT',
    reason: null,
    binanceBid: 70_000,
    binanceAsk: 70_001,
    binanceMid: 70_000.5,
    binanceSpreadRatio: 0.0001,
    slotOpenMid: 70_000,
    binanceMovePct: 0,
    volatilityRatio: 1,
    fundingRate: 0,
    fundingBasis: 0,
    polymarketMid: 0.5,
    fairValue: 0.5,
    direction: 'FLAT',
    ...overrides,
  };
}

test('checkObiBinanceGate: disabled gate always allows', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: 5, direction: 'UP' }),
    outcome: 'NO',
    config: {
      binanceGateEnabled: false,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('checkObiBinanceGate: missing assessment fail-open', () => {
  const decision = checkObiBinanceGate({
    assessment: null,
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('checkObiBinanceGate: unavailable assessment fail-open', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ available: false, binanceMovePct: 0.5 }),
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('checkObiBinanceGate: null movePct fail-open', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: null }),
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('checkObiBinanceGate: blocks runaway up regardless of outcome (YES)', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: 0.45, direction: 'UP' }),
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, true);
  if (decision.blocked) {
    assert.equal(decision.reason, 'runaway_abs');
    assert.equal(decision.outcome, 'YES');
  }
});

test('checkObiBinanceGate: blocks runaway down regardless of outcome (NO)', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: -0.50, direction: 'DOWN' }),
    outcome: 'NO',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, true);
  if (decision.blocked) assert.equal(decision.reason, 'runaway_abs');
});

test('checkObiBinanceGate: blocks contra-direction (UP + buy NO)', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: 0.20, direction: 'UP' }),
    outcome: 'NO',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, true);
  if (decision.blocked) {
    assert.equal(decision.reason, 'contra_direction');
    assert.equal(decision.direction, 'UP');
  }
});

test('checkObiBinanceGate: blocks contra-direction (DOWN + buy YES)', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: -0.18, direction: 'DOWN' }),
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, true);
  if (decision.blocked) assert.equal(decision.reason, 'contra_direction');
});

test('checkObiBinanceGate: allows with-flow (UP + buy YES)', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: 0.20, direction: 'UP' }),
    outcome: 'YES',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('checkObiBinanceGate: allows small move below contra threshold', () => {
  const decision = checkObiBinanceGate({
    assessment: makeAssessment({ binanceMovePct: 0.05, direction: 'UP' }),
    outcome: 'NO',
    config: {
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    },
  });
  assert.equal(decision.blocked, false);
});

test('obi engine: Binance runaway blocks entry signal', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 800,  // Phase 10: flip to thin-ASK (bullish for YES)
      yesAskDepth: 4,
      noBidDepth: 400,
      noAskDepth: 400,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    }),
    nowMs: FIXED_NOW,
    deepBinanceAssessment: makeAssessment({
      binanceMovePct: 0.45,
      direction: 'UP',
    }),
  });
  assert.deepEqual(signals, [], 'runaway slot must produce no entries');
});

test('obi engine: Binance with-flow allows entry signal', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 800,  // Phase 10: flip to thin-ASK (bullish for YES)
      yesAskDepth: 4,
      noBidDepth: 400,
      noAskDepth: 400,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    }),
    nowMs: FIXED_NOW,
    // YES entry (Up), Binance moving UP moderately → with-flow, allowed.
    deepBinanceAssessment: makeAssessment({
      binanceMovePct: 0.20,
      direction: 'UP',
    }),
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.outcome, 'YES');
});

test('obi engine: missing Binance assessment does not block (fail-open)', () => {
  const engine = new ObiEngine();
  const signals = engine.generateSignals({
    market: createMarket(),
    orderbook: createOrderbook({
      yesBid: 0.20,
      yesAsk: 0.21,
      yesBidDepth: 800,  // Phase 10: flip to thin-ASK (bullish for YES)
      yesAskDepth: 4,
      noBidDepth: 400,
      noAskDepth: 400,
    }),
    positionManager: new PositionManager('market-1'),
    config: baseConfig({
      binanceGateEnabled: true,
      binanceRunawayAbsPct: 0.30,
      binanceContraAbsPct: 0.15,
    }),
    nowMs: FIXED_NOW,
    // No assessment provided.
  });
  assert.equal(signals.length, 1);
});
