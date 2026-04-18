import test from 'node:test';
import assert from 'node:assert/strict';
import { BarAggregator, aggregateBatch, type OneSecondKline } from '../../src/indicator/aggregator.js';

function kl(openTime: number, o: number, h: number, l: number, c: number, vol = 1): OneSecondKline {
  return { openTime, closeTime: openTime + 999, open: o, high: h, low: l, close: c, volume: vol };
}

test('windowStartFor aligns to 10s boundary', () => {
  assert.equal(BarAggregator.windowStartFor(0, 10_000), 0);
  assert.equal(BarAggregator.windowStartFor(9_999, 10_000), 0);
  assert.equal(BarAggregator.windowStartFor(10_000, 10_000), 10_000);
  assert.equal(BarAggregator.windowStartFor(15_432, 10_000), 10_000);
});

test('BarAggregator emits on window closer and returns correct OHLCV', () => {
  const agg = new BarAggregator(10_000);
  const start = 1_700_000_000_000;
  let emitted: ReturnType<BarAggregator['ingest']> = null;
  for (let i = 0; i < 10; i += 1) {
    const open = 100 + i;
    const close = 100 + i + 0.5;
    const high = 100 + i + 1;
    const low = 100 + i - 0.5;
    const out = agg.ingest(kl(start + i * 1000, open, high, low, close, 2));
    if (out !== null) emitted = out;
  }
  assert.ok(emitted !== null, 'expected emission at boundary');
  assert.equal(emitted.candle.openTime, start);
  assert.equal(emitted.candle.closeTime, start + 9_999);
  assert.equal(emitted.candle.open, 100);
  assert.equal(emitted.candle.close, 109.5);
  assert.equal(emitted.candle.high, 110);
  assert.equal(emitted.candle.low, 99.5);
  assert.equal(emitted.candle.volume, 20);
  assert.equal(emitted.dropped, 0);
});

test('BarAggregator does NOT emit before boundary closer arrives', () => {
  const agg = new BarAggregator(10_000);
  const start = 1_700_000_000_000;
  for (let i = 0; i < 9; i += 1) {
    const out = agg.ingest(kl(start + i * 1000, 100, 100, 100, 100));
    assert.equal(out, null, `bar ${i} should not emit`);
  }
});

test('BarAggregator tolerates ≤2 missing slots and logs dropped count', () => {
  const agg = new BarAggregator(10_000, 2);
  const start = 1_700_000_000_000;
  let emitted: ReturnType<BarAggregator['ingest']> = null;
  const presentIndices = [0, 1, 3, 4, 5, 6, 7, 8, 9]; // missing slot 2
  for (const i of presentIndices) {
    const out = agg.ingest(kl(start + i * 1000, 100, 100, 100, 100));
    if (out !== null) emitted = out;
  }
  assert.ok(emitted !== null, 'expected emission with 1 missing slot');
  assert.equal(emitted.dropped, 1);
});

test('BarAggregator skips emission when >maxMissing slots missing', () => {
  const agg = new BarAggregator(10_000, 2);
  const start = 1_700_000_000_000;
  // provide only slot 0 and slot 9 (closer)
  let emitted: ReturnType<BarAggregator['ingest']> = null;
  emitted = agg.ingest(kl(start + 0, 100, 100, 100, 100)) ?? emitted;
  emitted = agg.ingest(kl(start + 9_000, 100, 100, 100, 100)) ?? emitted;
  assert.equal(emitted, null, 'should not emit with 8 missing slots');
});

test('aggregateBatch produces one window per 10 1s klines', () => {
  const start = 0;
  const klines: OneSecondKline[] = [];
  for (let i = 0; i < 30; i += 1) {
    klines.push(kl(start + i * 1000, 1 + i, 1 + i, 1 + i, 1 + i));
  }
  const out = aggregateBatch(klines, 10_000);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.openTime, 0);
  assert.equal(out[1]!.openTime, 10_000);
  assert.equal(out[2]!.openTime, 20_000);
  assert.equal(out[0]!.open, 1);
  assert.equal(out[0]!.close, 10);
});

test('aggregateBatch skips incomplete trailing window', () => {
  const klines: OneSecondKline[] = [];
  for (let i = 0; i < 15; i += 1) {
    klines.push(kl(i * 1000, 1, 1, 1, 1));
  }
  const out = aggregateBatch(klines, 10_000);
  assert.equal(out.length, 1, 'only the first 10s window is complete');
});
