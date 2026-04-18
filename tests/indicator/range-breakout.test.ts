import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeBreakoutEngine } from '../../src/indicator/range-breakout.js';
import { toHeikinAshi } from '../../src/indicator/heikin-ashi.js';
import type { HeikinAshiCandle, OhlcCandle, RangeBreakoutParams } from '../../src/indicator/types.js';

const FAST_PARAMS: RangeBreakoutParams = {
  channelWidth: 2.0,
  atrLen: 5,
  smaLen: 3,
  maxCount: 20,
  warmupBars: 10,
};

function bar(openTime: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { openTime, closeTime: openTime + 9_999, open: o, high: h, low: l, close: c, volume: 0 };
}

function feedSeries(engine: RangeBreakoutEngine, raws: OhlcCandle[]): HeikinAshiCandle[] {
  const out: HeikinAshiCandle[] = [];
  let prev: HeikinAshiCandle | undefined;
  for (const r of raws) {
    const ha = toHeikinAshi(r, prev);
    prev = ha;
    engine.ingest(ha);
    out.push(ha);
  }
  return out;
}

function makeFlatThenTrend(n: number, trendStartIdx: number, jump: number): OhlcCandle[] {
  const out: OhlcCandle[] = [];
  let base = 100;
  for (let i = 0; i < n; i += 1) {
    if (i >= trendStartIdx) base += jump;
    const open = base - 0.1;
    const close = base + 0.1;
    const high = base + 0.3;
    const low = base - 0.3;
    out.push(bar(i * 10_000, open, high, low, close));
  }
  return out;
}

test('engine does not initialize before warmup + atrLen + smaLen', () => {
  const engine = new RangeBreakoutEngine('BTCUSDT', FAST_PARAMS);
  const series = makeFlatThenTrend(5, 999, 0);
  feedSeries(engine, series);
  assert.equal(engine.state.initialized, false);
});

test('engine initializes after sufficient history', () => {
  const engine = new RangeBreakoutEngine('BTCUSDT', FAST_PARAMS);
  // need at least warmupBars=10 + atrLen=5 + smaLen=3 - ~ish. 40 bars safe.
  const series = makeFlatThenTrend(40, 999, 0);
  feedSeries(engine, series);
  assert.equal(engine.state.initialized, true);
  assert.ok(!Number.isNaN(engine.state.value));
  assert.ok(!Number.isNaN(engine.state.valueUpper));
  assert.ok(engine.state.valueUpper > engine.state.value);
  assert.ok(engine.state.valueLower < engine.state.value);
  assert.ok(engine.state.valueUpperMid > engine.state.value);
  assert.ok(engine.state.valueLowerMid < engine.state.value);
});

test('strong uptrend beyond upper eventually triggers reset and sets bullish trend', () => {
  const engine = new RangeBreakoutEngine('BTCUSDT', FAST_PARAMS);
  const flat = makeFlatThenTrend(40, 999, 0);
  feedSeries(engine, flat);
  assert.equal(engine.state.initialized, true);
  const upperBefore = engine.state.valueUpper;

  // Inject a huge spike that clearly breaks above valueUpper.
  const spikeStart = flat[flat.length - 1]!.closeTime + 1;
  const spikeCandles: OhlcCandle[] = [];
  let base = flat[flat.length - 1]!.close;
  for (let i = 0; i < 30; i += 1) {
    base += 50;
    spikeCandles.push(bar(spikeStart + i * 10_000, base - 1, base + 2, base - 1, base + 1));
  }
  feedSeries(engine, spikeCandles);

  assert.equal(engine.state.trend, true, 'trend should be bullish after break');
  assert.ok(engine.state.lastCrossUpper !== null, 'lastCrossUpper should be set');
  // Channel should have re-seeded higher than original upper
  assert.ok(engine.state.value > upperBefore, 'channel re-seeded at new hl2 higher than prior upper');
});

test('valueUpperMid equals avg(value, valueUpper) and valueLowerMid equals avg(value, valueLower)', () => {
  const engine = new RangeBreakoutEngine('BTCUSDT', FAST_PARAMS);
  feedSeries(engine, makeFlatThenTrend(40, 999, 0));
  assert.equal(engine.state.valueUpperMid, (engine.state.value + engine.state.valueUpper) / 2);
  assert.equal(engine.state.valueLowerMid, (engine.state.value + engine.state.valueLower) / 2);
});

test('barsProcessed increments per ingest', () => {
  const engine = new RangeBreakoutEngine('BTCUSDT', FAST_PARAMS);
  const series = makeFlatThenTrend(25, 999, 0);
  feedSeries(engine, series);
  assert.equal(engine.state.barsProcessed, 25);
});
