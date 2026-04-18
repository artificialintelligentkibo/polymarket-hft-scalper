import type { OhlcCandle } from './types.js';

/**
 * Aggregates 1-second klines into a fixed-window OHLC bar aligned to wall-clock boundaries.
 * Default window = 10_000 ms (10s bars aligned to :00, :10, :20, :30, :40, :50).
 *
 * Binance 1s kline closeTime format: openTime + 1000 - 1 → ends in x999 ms.
 * The last 1s kline of a 10s window has closeTime where (closeTime + 1) % windowMs === 0.
 */

export interface AggregatorEmission {
  readonly candle: OhlcCandle;
  readonly dropped: number;
  readonly filledInterpolation: boolean;
}

export interface OneSecondKline {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export class BarAggregator {
  private readonly windowMs: number;
  private readonly slots: number;
  private readonly maxMissing: number;
  private readonly buffer: Map<number, OneSecondKline> = new Map();
  private currentWindowStart: number | null = null;

  constructor(windowMs = 10_000, maxMissing = 2) {
    if (windowMs % 1000 !== 0) throw new Error('windowMs must be multiple of 1000');
    this.windowMs = windowMs;
    this.slots = windowMs / 1000;
    this.maxMissing = maxMissing;
  }

  /** Align a millisecond timestamp down to its containing window start. */
  static windowStartFor(tsMs: number, windowMs: number): number {
    return Math.floor(tsMs / windowMs) * windowMs;
  }

  /** Discard any partial window state (e.g. after WS reconnect). */
  reset(): void {
    this.buffer.clear();
    this.currentWindowStart = null;
  }

  /**
   * Ingest one 1s kline. Returns a finalised window candle if, after this kline,
   * the window that kline belongs to is now closed.
   *
   * A window closes when we observe a kline whose closeTime is at the window
   * boundary (i.e. (closeTime + 1) % windowMs === 0). At that point, we emit
   * the accumulated window even if some 1s slots are missing (up to maxMissing).
   * If more than maxMissing slots are missing, we return null and log the caller
   * can handle the drop.
   */
  ingest(kline: OneSecondKline): AggregatorEmission | null {
    const windowStart = BarAggregator.windowStartFor(kline.openTime, this.windowMs);
    if (this.currentWindowStart === null) {
      this.currentWindowStart = windowStart;
    } else if (windowStart > this.currentWindowStart) {
      // Late arrival for a newer window — flush the old window (may be incomplete) and advance.
      // This case is defensive; normal WS order is openTime-ascending.
      const flushed = this.flushCurrent();
      this.currentWindowStart = windowStart;
      this.buffer.set(kline.openTime, kline);
      if (flushed !== null && (kline.closeTime + 1) % this.windowMs === 0) {
        // The new kline itself also closes its own window. Emit sequentially is not supported
        // in one call; caller should drain via ingest again next tick.
      }
      return flushed;
    } else if (windowStart < this.currentWindowStart) {
      // Stale kline for a prior window — ignore.
      return null;
    }
    this.buffer.set(kline.openTime, kline);

    const isWindowCloser = (kline.closeTime + 1) % this.windowMs === 0;
    if (!isWindowCloser) return null;

    return this.flushCurrent();
  }

  private flushCurrent(): AggregatorEmission | null {
    if (this.currentWindowStart === null) return null;
    const windowStart = this.currentWindowStart;
    const entries: OneSecondKline[] = [];
    for (let offset = 0; offset < this.slots; offset += 1) {
      const openTime = windowStart + offset * 1000;
      const kl = this.buffer.get(openTime);
      if (kl !== undefined) entries.push(kl);
    }
    this.buffer.clear();
    this.currentWindowStart = null;

    const missing = this.slots - entries.length;
    if (missing > this.maxMissing) return null;
    if (entries.length === 0) return null;

    const ordered = entries.sort((a, b) => a.openTime - b.openTime);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const e of ordered) {
      if (e.high > high) high = e.high;
      if (e.low < low) low = e.low;
      volume += e.volume;
    }
    const candle: OhlcCandle = {
      openTime: windowStart,
      closeTime: windowStart + this.windowMs - 1,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    };
    return { candle, dropped: missing, filledInterpolation: missing > 0 };
  }
}

/**
 * Stateless helper: aggregate a chronologically-ordered array of 1s klines into
 * boundary-aligned window candles. Used for REST backfill bootstrap.
 */
export function aggregateBatch(klines: readonly OneSecondKline[], windowMs = 10_000): OhlcCandle[] {
  if (klines.length === 0) return [];
  const slots = windowMs / 1000;
  const byWindow = new Map<number, OneSecondKline[]>();
  for (const k of klines) {
    const ws = BarAggregator.windowStartFor(k.openTime, windowMs);
    const list = byWindow.get(ws);
    if (list) list.push(k);
    else byWindow.set(ws, [k]);
  }
  const out: OhlcCandle[] = [];
  const windowStarts = [...byWindow.keys()].sort((a, b) => a - b);
  for (const ws of windowStarts) {
    const entries = byWindow.get(ws)!;
    if (entries.length > slots) {
      // Duplicates shouldn't happen in a clean fetch; trim keeping first N to preserve order.
      entries.length = slots;
    }
    const missing = slots - entries.length;
    // For batch, require a full window (strict): skip windows with missing slots.
    // Historical data from REST shouldn't have gaps for normal symbols.
    if (missing > 0) continue;
    const ordered = entries.sort((a, b) => a.openTime - b.openTime);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const e of ordered) {
      if (e.high > high) high = e.high;
      if (e.low < low) low = e.low;
      volume += e.volume;
    }
    out.push({
      openTime: ws,
      closeTime: ws + windowMs - 1,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    });
  }
  return out;
}
