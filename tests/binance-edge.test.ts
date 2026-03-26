import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceEdgeProvider } from '../src/binance-edge.js';
import { createConfig } from '../src/config.js';

function createEdgeProvider() {
  return new BinanceEdgeProvider(
    createConfig({
      ...process.env,
      BINANCE_EDGE_ENABLED: 'true',
      BINANCE_FLAT_THRESHOLD: '0.05',
      BINANCE_STRONG_THRESHOLD: '0.20',
      BINANCE_BOOST_MULTIPLIER: '1.5',
      BINANCE_REDUCE_MULTIPLIER: '0.5',
      BINANCE_BLOCK_STRONG_CONTRA: 'true',
    })
  );
}

test('returns neutral when Binance shows flat movement', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);
  provider.recordSlotOpen('BTC', '2026-03-21T10:00:00.000Z');
  provider.ingestPriceTick('btcusdt', 100.02);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:00:00.000Z',
    pmUpMid: 0.5,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.available, true);
  assert.equal(assessment.direction, 'FLAT');
  assert.equal(assessment.sizeMultiplier, 1);
  assert.equal(assessment.urgencyBoost, false);
});

test('boosts size when Binance confirms BUY YES and price is up', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);
  provider.recordSlotOpen('BTC', '2026-03-21T10:05:00.000Z');
  provider.ingestPriceTick('btcusdt', 100.35);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:05:00.000Z',
    pmUpMid: 0.56,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.direction, 'UP');
  assert.equal(assessment.directionalAgreement, true);
  assert.equal(assessment.sizeMultiplier, 1.5);
  assert.equal(assessment.urgencyBoost, true);
});

test('blocks signal when Binance strongly contradicts', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);
  provider.recordSlotOpen('BTC', '2026-03-21T10:10:00.000Z');
  provider.ingestPriceTick('btcusdt', 99.7);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:10:00.000Z',
    pmUpMid: 0.55,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.direction, 'DOWN');
  assert.equal(assessment.contraSignal, true);
  assert.equal(assessment.sizeMultiplier, 0);
});

test('reduces size on mild contradiction', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);
  provider.recordSlotOpen('BTC', '2026-03-21T10:15:00.000Z');
  provider.ingestPriceTick('btcusdt', 99.9);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:15:00.000Z',
    pmUpMid: 0.55,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.direction, 'DOWN');
  assert.equal(assessment.sizeMultiplier, 0.5);
});

test('handles missing Binance data gracefully', () => {
  const provider = createEdgeProvider();
  const assessment = provider.assess({
    coin: 'MSTR',
    slotStartTime: '2026-03-21T10:20:00.000Z',
    pmUpMid: 0.5,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.available, false);
  assert.equal(assessment.sizeMultiplier, 1);
});

test('tracks slot open price correctly across slot boundaries', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 84500);
  provider.recordSlotOpen('BTC', '2026-03-21T10:00:00.000Z');
  provider.ingestPriceTick('btcusdt', 84700);

  const slotOneAssessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:00:00.000Z',
    pmUpMid: 0.54,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  provider.recordSlotOpen('BTC', '2026-03-21T10:05:00.000Z');
  provider.ingestPriceTick('btcusdt', 84650);

  const slotTwoAssessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:05:00.000Z',
    pmUpMid: 0.49,
    signalAction: 'BUY',
    signalOutcome: 'NO',
  });

  assert.equal(slotOneAssessment.binanceMovePct > 0.2, true);
  assert.equal(slotOneAssessment.direction, 'UP');
  assert.equal(Math.abs(slotTwoAssessment.binanceMovePct) < 0.1, true);
  assert.equal(slotTwoAssessment.direction, 'DOWN');
});

test('assess remains available during reconnect gaps when cached prices exist', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);
  provider.recordSlotOpen('BTC', '2026-03-21T10:30:00.000Z');
  provider.ingestPriceTick('btcusdt', 100.25);
  Reflect.set(provider as unknown as object, 'connected', false);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:30:00.000Z',
    pmUpMid: 0.54,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.available, true);
  assert.equal(assessment.direction, 'UP');
});

test('assess reports explicit reason when slot open is missing', () => {
  const provider = createEdgeProvider();
  provider.ingestPriceTick('btcusdt', 100);

  const assessment = provider.assess({
    coin: 'BTC',
    slotStartTime: '2026-03-21T10:35:00.000Z',
    pmUpMid: 0.52,
    signalAction: 'BUY',
    signalOutcome: 'YES',
  });

  assert.equal(assessment.available, false);
  assert.equal(assessment.unavailableReason, 'no_slot_open_price');
});

test('getPriceAt returns the nearest cached Binance sample around slot close', () => {
  const provider = createEdgeProvider();
  const baseMs = Date.now();
  provider.ingestPriceTick('btcusdt', 100, baseMs + 1_000);
  provider.ingestPriceTick('btcusdt', 101, baseMs + 5_000);
  provider.ingestPriceTick('btcusdt', 102, baseMs + 9_000);

  assert.equal(provider.getPriceAt('BTC', baseMs + 4_600), 101);
  assert.equal(provider.getPriceAt('BTC', baseMs + 8_800), 102);
});
