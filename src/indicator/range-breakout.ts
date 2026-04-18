import type {
  HeikinAshiCandle,
  RangeBreakoutParams,
  RangeBreakoutState,
  RangeBreakoutTickResult,
  RangeEvent,
} from './types.js';

const MAX_HA_HISTORY = 1000;

function trueRange(curr: HeikinAshiCandle, prev: HeikinAshiCandle | undefined): number {
  const hl = curr.haHigh - curr.haLow;
  if (prev === undefined) return hl;
  const hc = Math.abs(curr.haHigh - prev.haClose);
  const lc = Math.abs(curr.haLow - prev.haClose);
  return Math.max(hl, hc, lc);
}

/**
 * Pine-style Wilder RMA (ta.rma): seed with SMA over `length`, then
 * rma[i] = (rma[i-1] * (length - 1) + x[i]) / length.
 * Returns NaN when not enough samples to produce a value.
 */
function rmaUpdate(prevRma: number, value: number, length: number): number {
  return (prevRma * (length - 1) + value) / length;
}

function smaUpdate(series: readonly number[], length: number): number {
  if (series.length < length) return NaN;
  let sum = 0;
  for (let i = series.length - length; i < series.length; i += 1) sum += series[i]!;
  return sum / length;
}

export class RangeBreakoutEngine {
  readonly state: RangeBreakoutState;
  private readonly params: RangeBreakoutParams;
  private readonly haHistory: HeikinAshiCandle[] = [];
  private readonly atrSeries: number[] = [];
  private currentAtrRma: number = NaN;
  private trSumForSeed = 0;

  constructor(symbol: string, params: RangeBreakoutParams) {
    this.params = params;
    this.state = {
      symbol,
      value: NaN,
      valueUpper: NaN,
      valueLower: NaN,
      valueUpperMid: NaN,
      valueLowerMid: NaN,
      count: 0,
      trend: false,
      initialized: false,
      lastCandleCloseTime: 0,
      barsProcessed: 0,
      lastCrossUpper: null,
      lastCrossLower: null,
    };
  }

  /**
   * Feed one newly-confirmed HA candle (chronological order).
   * Returns which signals fired for this bar.
   */
  ingest(candle: HeikinAshiCandle): RangeBreakoutTickResult {
    const prev = this.haHistory[this.haHistory.length - 1];
    const tr = trueRange(candle, prev);

    // Wilder RMA of TR over atrLen
    const { atrLen, smaLen, warmupBars, channelWidth, maxCount } = this.params;
    if (this.haHistory.length < atrLen) {
      this.trSumForSeed += tr;
      if (this.haHistory.length + 1 === atrLen) {
        this.currentAtrRma = this.trSumForSeed / atrLen;
      }
    } else {
      this.currentAtrRma = rmaUpdate(this.currentAtrRma, tr, atrLen);
    }

    // SMA of ATR over smaLen to form the smoothed ATR series used for width
    if (!Number.isNaN(this.currentAtrRma)) {
      this.atrSeries.push(this.currentAtrRma);
      if (this.atrSeries.length > smaLen * 4) {
        this.atrSeries.splice(0, this.atrSeries.length - smaLen * 4);
      }
    }
    const smoothedAtr = smaUpdate(this.atrSeries, smaLen);
    const width = Number.isNaN(smoothedAtr) ? NaN : smoothedAtr * channelWidth;

    this.haHistory.push(candle);
    if (this.haHistory.length > MAX_HA_HISTORY) {
      this.haHistory.splice(0, this.haHistory.length - MAX_HA_HISTORY);
    }
    this.state.lastCandleCloseTime = candle.closeTime;
    this.state.barsProcessed += 1;

    const hl2 = (candle.haHigh + candle.haLow) / 2;
    const barIndex = this.state.barsProcessed - 1;
    const events: RangeEvent[] = [];

    // Seed if not initialized and we have enough history and width is defined.
    const canSeed = !this.state.initialized && barIndex >= warmupBars && !Number.isNaN(width);
    if (canSeed) {
      this.seed(hl2, width);
      return {
        crossUpper: false,
        crossLower: false,
        resetNow: false,
        buySignal: false,
        sellSignal: false,
        fakeoutUp: false,
        fakeoutDn: false,
        events,
      };
    }

    if (!this.state.initialized) {
      return {
        crossUpper: false,
        crossLower: false,
        resetNow: false,
        buySignal: false,
        sellSignal: false,
        fakeoutUp: false,
        fakeoutDn: false,
        events,
      };
    }

    // We have a prior bar (haHistory already contains current; prev is the one before current-insertion)
    // After push, current is at len-1 and prev bar is at len-2.
    const currentLow = candle.haLow;
    const currentHigh = candle.haHigh;
    const prevBar = this.haHistory[this.haHistory.length - 2];
    if (prevBar === undefined) {
      return {
        crossUpper: false,
        crossLower: false,
        resetNow: false,
        buySignal: false,
        sellSignal: false,
        fakeoutUp: false,
        fakeoutDn: false,
        events,
      };
    }
    const prevLow = prevBar.haLow;
    const prevHigh = prevBar.haHigh;

    const crossUpper = currentLow > this.state.valueUpper && prevLow <= this.state.valueUpper;
    const crossLower = currentHigh < this.state.valueLower && prevHigh >= this.state.valueLower;

    if (currentLow > this.state.valueUpper || currentHigh < this.state.valueLower) {
      this.state.count += 1;
    } else {
      this.state.count = 0;
    }

    const resetNow = crossUpper || crossLower || this.state.count >= maxCount;

    if (resetNow) {
      if (crossUpper) {
        this.state.trend = true;
        this.state.lastCrossUpper = candle.closeTime;
        events.push({
          ts: candle.closeTime,
          symbol: this.state.symbol,
          eventType: 'bull_break',
          price: currentLow,
          levelRef: this.state.valueUpper,
        });
      }
      if (crossLower) {
        this.state.trend = false;
        this.state.lastCrossLower = candle.closeTime;
        events.push({
          ts: candle.closeTime,
          symbol: this.state.symbol,
          eventType: 'bear_break',
          price: currentHigh,
          levelRef: this.state.valueLower,
        });
      }
      if (!Number.isNaN(width)) {
        this.seed(hl2, width);
      }
    }

    // Signals (Pine: using low, low[1], low[10]). low[0]=current, low[1]=prev, low[10]=10 bars back.
    // haHistory after push: current at len-1, prev at len-2, 10-bars-back at len-11.
    const ten = this.haHistory[this.haHistory.length - 11];
    const buySignal =
      !resetNow &&
      ten !== undefined &&
      currentLow > this.state.valueLowerMid &&
      prevLow <= this.state.valueLowerMid &&
      ten.haLow > this.state.valueLowerMid;
    const sellSignal =
      !resetNow &&
      ten !== undefined &&
      currentHigh < this.state.valueUpperMid &&
      prevHigh >= this.state.valueUpperMid &&
      ten.haHigh < this.state.valueUpperMid;
    const fakeoutUp =
      !resetNow && currentHigh < this.state.valueUpper && prevHigh >= this.state.valueUpper;
    const fakeoutDn =
      !resetNow && currentLow > this.state.valueLower && prevLow <= this.state.valueLower;

    if (buySignal) {
      events.push({
        ts: candle.closeTime,
        symbol: this.state.symbol,
        eventType: 'buy_signal',
        price: currentLow,
        levelRef: this.state.valueLowerMid,
      });
    }
    if (sellSignal) {
      events.push({
        ts: candle.closeTime,
        symbol: this.state.symbol,
        eventType: 'sell_signal',
        price: currentHigh,
        levelRef: this.state.valueUpperMid,
      });
    }
    if (fakeoutUp) {
      events.push({
        ts: candle.closeTime,
        symbol: this.state.symbol,
        eventType: 'fakeout_up',
        price: currentHigh,
        levelRef: this.state.valueUpper,
      });
    }
    if (fakeoutDn) {
      events.push({
        ts: candle.closeTime,
        symbol: this.state.symbol,
        eventType: 'fakeout_dn',
        price: currentLow,
        levelRef: this.state.valueLower,
      });
    }

    return {
      crossUpper,
      crossLower,
      resetNow,
      buySignal,
      sellSignal,
      fakeoutUp,
      fakeoutDn,
      events,
    };
  }

  private seed(hl2: number, width: number): void {
    this.state.value = hl2;
    this.state.valueUpper = hl2 + width;
    this.state.valueLower = hl2 - width;
    this.state.valueUpperMid = (this.state.value + this.state.valueUpper) / 2;
    this.state.valueLowerMid = (this.state.value + this.state.valueLower) / 2;
    this.state.count = 0;
    this.state.initialized = true;
  }
}
