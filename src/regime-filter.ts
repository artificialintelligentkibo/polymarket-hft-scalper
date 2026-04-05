/**
 * Market Regime Filter
 *
 * Analyzes Binance price history to classify market regime as TRENDING or RANGING.
 * Used by the sniper engine to skip entries during choppy/ranging conditions
 * where directional bets have lower expected value.
 *
 * Runs locally with zero latency — no external dependencies, uses price data
 * already available from the Binance WebSocket feed.
 *
 * Design:
 * - Computed inline before each sniper entry evaluation
 * - Two metrics: ATR-based volatility ratio + directional efficiency ratio
 * - Configurable thresholds, fully feature-flagged (REGIME_FILTER_ENABLED)
 */

import type { RegimeFilterConfig } from './config.js';
import { logger } from './logger.js';
import { clamp, roundTo } from './utils.js';

// ─── Types ───────────────────────────────────────────────────────────

export type MarketRegime = 'TRENDING' | 'RANGING' | 'UNKNOWN';

export interface RegimeAssessment {
  /** Market regime classification. */
  readonly regime: MarketRegime;
  /** Directional efficiency ratio: |net move| / total path (0..1). Higher = more trending. */
  readonly efficiency: number;
  /** Normalized ATR: average range per bar / current price (0..1). Higher = more volatile. */
  readonly normalizedAtr: number;
  /** Raw directional move % over the lookback window. */
  readonly directionalMovePct: number;
  /** Coin symbol this assessment is for. */
  readonly coin: string;
  /** Whether the sniper should be allowed to enter. */
  readonly allowEntry: boolean;
  /** Human-readable reason for the decision. */
  readonly reason: string;
}

// ─── Micro-bar for internal aggregation ──────────────────────────────

interface MicroBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly startMs: number;
}

// ─── Core Class ──────────────────────────────────────────────────────

export class RegimeFilter {
  constructor(private readonly filterConfig: RegimeFilterConfig) {}

  get enabled(): boolean {
    return this.filterConfig.enabled;
  }

  /**
   * Assess market regime for a given coin using raw price samples.
   *
   * @param coin - Coin symbol (e.g. 'BTC')
   * @param priceSamples - Raw Binance price ticks with timestamps (from priceHistory)
   * @param nowMs - Current timestamp
   */
  assess(
    coin: string,
    priceSamples: ReadonlyArray<{ readonly price: number; readonly recordedAtMs: number }>,
    nowMs = Date.now(),
  ): RegimeAssessment {
    const cfg = this.filterConfig;

    // Filter samples to lookback window
    const windowStartMs = nowMs - cfg.lookbackWindowMs;
    const windowSamples = priceSamples.filter((s) => s.recordedAtMs >= windowStartMs);

    if (windowSamples.length < cfg.minSamplesRequired) {
      return {
        regime: 'UNKNOWN',
        efficiency: 0,
        normalizedAtr: 0,
        directionalMovePct: 0,
        coin,
        allowEntry: true, // Don't block when not enough data
        reason: `insufficient_samples (${windowSamples.length}/${cfg.minSamplesRequired})`,
      };
    }

    // Aggregate raw ticks into micro-bars
    const bars = this.aggregateBars(windowSamples, cfg.barIntervalMs);

    if (bars.length < 3) {
      return {
        regime: 'UNKNOWN',
        efficiency: 0,
        normalizedAtr: 0,
        directionalMovePct: 0,
        coin,
        allowEntry: true,
        reason: `insufficient_bars (${bars.length}/3)`,
      };
    }

    // Metric 1: Normalized ATR (average true range / price)
    const currentPrice = bars[bars.length - 1].close;
    const atrSum = bars.reduce((sum, bar) => sum + (bar.high - bar.low), 0);
    const avgRange = atrSum / bars.length;
    const normalizedAtr = currentPrice > 0 ? avgRange / currentPrice : 0;

    // Metric 2: Directional efficiency ratio
    // |net displacement| / total path traveled
    const netMove = Math.abs(bars[bars.length - 1].close - bars[0].open);
    const totalPath = bars.reduce((sum, bar) => sum + Math.abs(bar.close - bar.open), 0);
    const efficiency = totalPath > 0 ? netMove / totalPath : 0;

    // Directional move %
    const firstPrice = bars[0].open;
    const directionalMovePct = firstPrice > 0
      ? ((currentPrice - firstPrice) / firstPrice) * 100
      : 0;

    // Classification
    const isTrending =
      efficiency >= cfg.efficiencyThreshold &&
      normalizedAtr >= cfg.atrThreshold;

    const isRanging =
      efficiency < cfg.efficiencyThreshold * 0.7 ||
      normalizedAtr < cfg.atrThreshold * 0.5;

    let regime: MarketRegime;
    let allowEntry: boolean;
    let reason: string;

    if (isTrending) {
      regime = 'TRENDING';
      allowEntry = true;
      reason = `trending (eff=${roundTo(efficiency, 3)} atr=${roundTo(normalizedAtr, 5)} move=${roundTo(directionalMovePct, 3)}%)`;
    } else if (isRanging) {
      regime = 'RANGING';
      allowEntry = false;
      reason = `ranging (eff=${roundTo(efficiency, 3)} atr=${roundTo(normalizedAtr, 5)} move=${roundTo(directionalMovePct, 3)}%)`;
    } else {
      // Borderline — allow but log
      regime = 'TRENDING';
      allowEntry = true;
      reason = `borderline (eff=${roundTo(efficiency, 3)} atr=${roundTo(normalizedAtr, 5)} move=${roundTo(directionalMovePct, 3)}%)`;
    }

    return {
      regime,
      efficiency: roundTo(efficiency, 4),
      normalizedAtr: roundTo(normalizedAtr, 6),
      directionalMovePct: roundTo(directionalMovePct, 4),
      coin,
      allowEntry,
      reason,
    };
  }

  /**
   * Aggregate raw tick samples into fixed-interval micro-bars (OHLC).
   */
  private aggregateBars(
    samples: ReadonlyArray<{ readonly price: number; readonly recordedAtMs: number }>,
    barIntervalMs: number,
  ): MicroBar[] {
    if (samples.length === 0 || barIntervalMs <= 0) return [];

    const sorted = [...samples].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
    const bars: MicroBar[] = [];

    let barStart = sorted[0].recordedAtMs;
    let open = sorted[0].price;
    let high = sorted[0].price;
    let low = sorted[0].price;
    let close = sorted[0].price;

    for (let i = 1; i < sorted.length; i++) {
      const sample = sorted[i];

      if (sample.recordedAtMs >= barStart + barIntervalMs) {
        // Close current bar
        bars.push({ open, high, low, close, startMs: barStart });

        // Start new bar
        barStart = barStart + barIntervalMs * Math.floor((sample.recordedAtMs - barStart) / barIntervalMs);
        open = sample.price;
        high = sample.price;
        low = sample.price;
        close = sample.price;
      } else {
        // Update current bar
        high = Math.max(high, sample.price);
        low = Math.min(low, sample.price);
        close = sample.price;
      }
    }

    // Push last bar
    bars.push({ open, high, low, close, startMs: barStart });

    return bars;
  }
}
