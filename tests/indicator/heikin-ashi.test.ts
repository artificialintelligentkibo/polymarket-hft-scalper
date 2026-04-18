import test from 'node:test';
import assert from 'node:assert/strict';
import { toHeikinAshi, toHeikinAshiSeries } from '../../src/indicator/heikin-ashi.js';
import type { OhlcCandle } from '../../src/indicator/types.js';

function bar(openTime: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { openTime, closeTime: openTime + 9_999, open: o, high: h, low: l, close: c, volume: 0 };
}

test('first HA bar seeds HA_Open = (open + close) / 2', () => {
  const ha = toHeikinAshi(bar(0, 10, 12, 9, 11));
  assert.equal(ha.haOpen, 10.5);
  assert.equal(ha.haClose, (10 + 12 + 9 + 11) / 4); // 10.5
  assert.equal(ha.haHigh, Math.max(12, 10.5, 10.5));
  assert.equal(ha.haLow, Math.min(9, 10.5, 10.5));
});

test('subsequent HA_Open uses avg of prev HA_Open and HA_Close', () => {
  const b0 = bar(0, 10, 12, 9, 11);
  const ha0 = toHeikinAshi(b0);
  const b1 = bar(10_000, 11, 14, 10, 13);
  const ha1 = toHeikinAshi(b1, ha0);
  assert.equal(ha1.haOpen, (ha0.haOpen + ha0.haClose) / 2);
  assert.equal(ha1.haClose, (11 + 14 + 10 + 13) / 4);
  assert.ok(ha1.haHigh >= ha1.haOpen && ha1.haHigh >= ha1.haClose);
  assert.ok(ha1.haLow <= ha1.haOpen && ha1.haLow <= ha1.haClose);
});

test('toHeikinAshiSeries chains sequentially', () => {
  const series = toHeikinAshiSeries([
    bar(0, 100, 110, 90, 105),
    bar(10_000, 105, 120, 95, 115),
    bar(20_000, 115, 125, 100, 110),
  ]);
  assert.equal(series.length, 3);
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]!;
    const curr = series[i]!;
    assert.equal(curr.haOpen, (prev.haOpen + prev.haClose) / 2);
  }
});
