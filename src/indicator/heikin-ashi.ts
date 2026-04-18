import type { HeikinAshiCandle, OhlcCandle } from './types.js';

/**
 * Compute the next Heikin-Ashi candle from a raw OHLC candle.
 * If `prev` is undefined, seeds HA_Open = (open + close) / 2 per the standard formula.
 */
export function toHeikinAshi(candle: OhlcCandle, prev?: HeikinAshiCandle): HeikinAshiCandle {
  const haClose = (candle.open + candle.high + candle.low + candle.close) / 4;
  const haOpen = prev === undefined ? (candle.open + candle.close) / 2 : (prev.haOpen + prev.haClose) / 2;
  const haHigh = Math.max(candle.high, haOpen, haClose);
  const haLow = Math.min(candle.low, haOpen, haClose);
  return {
    ...candle,
    haOpen,
    haHigh,
    haLow,
    haClose,
  };
}

/** Transform a chronologically-ordered series of OHLC candles into HA candles. */
export function toHeikinAshiSeries(candles: readonly OhlcCandle[]): HeikinAshiCandle[] {
  const out: HeikinAshiCandle[] = [];
  let prev: HeikinAshiCandle | undefined;
  for (const c of candles) {
    const ha = toHeikinAshi(c, prev);
    out.push(ha);
    prev = ha;
  }
  return out;
}
