/**
 * Dynamic Multi-Layer Compounding Engine
 *
 * Recalculates position sizes in real time based on current USDC balance,
 * enabling exponential growth through reinvestment of profits.
 *
 * Design principles:
 * - Purely additive: when disabled (COMPOUNDING_ENABLED=false) the bot is
 *   unchanged — all existing sizing paths remain untouched.
 * - Single source of truth for balance-aware sizing adjustments.
 * - Hooks into existing sniper, MM, and legacy scalper via multiplier pattern.
 */

import type { CompoundingConfig } from './config.js';
import { logger } from './logger.js';
import { clamp, roundTo } from './utils.js';

// ─── Layer Definitions ───────────────────────────────────────────────

export interface LayerSizing {
  /** Layer index (1-based). Layer 1 = sniper, 2–6 = scale-in / MM. */
  readonly layer: number;
  /** Multiplier applied to base size for this layer (e.g. 1.0, 1.5, 2.0). */
  readonly multiplier: number;
  /** Absolute USD size for this layer at current balance. */
  readonly sizeUsd: number;
  /** Approximate share count at the given price. */
  readonly shares: number;
}

export interface CompoundingSnapshot {
  /** Current bankroll (USDC) used for calculations. */
  readonly bankrollUsd: number;
  /** Layer-1 base size in USD (bankroll × BASE_RISK_PCT). */
  readonly baseSizeUsd: number;
  /** All layer sizes at current balance. */
  readonly layers: readonly LayerSizing[];
  /** Total USD across all layers (must not exceed maxSlotExposurePct × bankroll). */
  readonly totalSlotExposureUsd: number;
  /** Dynamic global max exposure (bankroll × GLOBAL_EXPOSURE_PCT). */
  readonly dynamicGlobalMaxExposureUsd: number;
  /** Whether drawdown guard has triggered (reduces sizes by 50%). */
  readonly drawdownGuardActive: boolean;
  /** Timestamp of last recalculation. */
  readonly updatedAtMs: number;
}

// ─── Default Layer Multipliers ───────────────────────────────────────

const DEFAULT_LAYER_MULTIPLIERS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5] as const;

// ─── Core Class ──────────────────────────────────────────────────────

export class DynamicCompounder {
  private latestSnapshot: CompoundingSnapshot | null = null;
  private dayStartBalanceUsd: number | null = null;
  private dayStartKey: string | null = null;
  private drawdownGuardActive = false;

  constructor(private readonly compoundingConfig: CompoundingConfig) {}

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Returns true if the compounding engine is enabled and should influence sizing.
   */
  get enabled(): boolean {
    return this.compoundingConfig.enabled;
  }

  /**
   * Recalculate all layer sizes from current balance.
   * Called on every balance cache refresh and before signal evaluation.
   */
  recalculate(currentBalanceUsd: number, priceEstimate = 0.5): CompoundingSnapshot {
    this.updateDrawdownGuard(currentBalanceUsd);

    const cfg = this.compoundingConfig;
    const multipliers = cfg.layerMultipliers.length > 0
      ? cfg.layerMultipliers
      : [...DEFAULT_LAYER_MULTIPLIERS];

    const drawdownFactor = this.drawdownGuardActive ? 0.5 : 1.0;
    const baseSizeUsd = roundTo(currentBalanceUsd * cfg.baseRiskPct * drawdownFactor, 4);

    const layers: LayerSizing[] = [];
    let totalExposure = 0;
    const maxSlotExposure = currentBalanceUsd * cfg.maxSlotExposurePct;

    for (let i = 0; i < multipliers.length; i++) {
      const layerSizeUsd = roundTo(baseSizeUsd * multipliers[i], 4);

      // Check if adding this layer would exceed per-slot cap
      if (totalExposure + layerSizeUsd > maxSlotExposure && i > 0) {
        break;
      }

      const shares = priceEstimate > 0
        ? roundTo(layerSizeUsd / priceEstimate, 4)
        : 0;

      layers.push({
        layer: i + 1,
        multiplier: multipliers[i],
        sizeUsd: layerSizeUsd,
        shares,
      });

      totalExposure += layerSizeUsd;
    }

    const dynamicGlobalMax = roundTo(currentBalanceUsd * cfg.globalExposurePct, 2);

    const snapshot: CompoundingSnapshot = {
      bankrollUsd: currentBalanceUsd,
      baseSizeUsd,
      layers,
      totalSlotExposureUsd: roundTo(totalExposure, 4),
      dynamicGlobalMaxExposureUsd: dynamicGlobalMax,
      drawdownGuardActive: this.drawdownGuardActive,
      updatedAtMs: Date.now(),
    };

    this.latestSnapshot = snapshot;

    logger.debug('Compounding: recalculated', {
      balance: roundTo(currentBalanceUsd, 2),
      baseSizeUsd: snapshot.baseSizeUsd,
      layerCount: layers.length,
      totalSlotExposure: snapshot.totalSlotExposureUsd,
      dynamicGlobalMax,
      drawdownGuard: this.drawdownGuardActive,
      layer1Shares: layers[0]?.shares ?? 0,
      lastLayerShares: layers[layers.length - 1]?.shares ?? 0,
    });

    return snapshot;
  }

  /**
   * Get shares for a specific layer (1-based index).
   * Returns 0 if layer is out of range or no snapshot.
   */
  getLayerShares(layerIndex: number, priceEstimate?: number): number {
    const snap = this.latestSnapshot;
    if (!snap) return 0;

    const layer = snap.layers.find((l) => l.layer === layerIndex);
    if (!layer) return 0;

    // If a different price estimate is given, recalculate shares for this layer
    if (priceEstimate !== undefined && priceEstimate > 0) {
      return roundTo(layer.sizeUsd / priceEstimate, 4);
    }

    return layer.shares;
  }

  /**
   * Get the sniper (Layer 1) share count, split into base/strong.
   * Returns 0 when no snapshot is available (caller should fallback to static config).
   */
  getSniperShares(
    isStrongMove: boolean,
    priceEstimate: number,
  ): { base: number; strong: number } {
    const snap = this.latestSnapshot;
    if (!snap || snap.layers.length === 0) {
      return { base: 0, strong: 0 };
    }

    const layer1 = snap.layers[0];
    const baseShares = priceEstimate > 0
      ? roundTo(layer1.sizeUsd / priceEstimate, 4)
      : layer1.shares;

    // Strong shares use layer 2 sizing if available, otherwise 2× layer 1
    const layer2 = snap.layers.length > 1 ? snap.layers[1] : null;
    const strongShares = layer2
      ? (priceEstimate > 0 ? roundTo(layer2.sizeUsd / priceEstimate, 4) : layer2.shares)
      : roundTo(baseShares * 2, 4);

    return { base: baseShares, strong: strongShares };
  }

  /**
   * Get MM quote shares (replaces static MM_QUOTE_SHARES when compounding is on).
   * Uses Layer 2 sizing by default (MM is post-sniper).
   */
  getMMQuoteShares(priceEstimate: number): number {
    const snap = this.latestSnapshot;
    if (!snap || snap.layers.length < 2) {
      return 0;
    }

    // MM quotes use Layer 2 (first scale-in layer)
    const mmLayer = snap.layers[1];
    return priceEstimate > 0
      ? roundTo(mmLayer.sizeUsd / priceEstimate, 4)
      : mmLayer.shares;
  }

  /**
   * Get the lottery layer sizing.
   * Uses the smallest layer size but capped at lotteryMaxRiskUsd.
   */
  getLotteryShares(priceEstimate: number, lotteryMaxRiskUsd: number): number {
    const snap = this.latestSnapshot;
    if (!snap) return 0;

    const lotteryBudget = Math.min(snap.baseSizeUsd, lotteryMaxRiskUsd);
    return priceEstimate > 0
      ? roundTo(lotteryBudget / priceEstimate, 4)
      : 0;
  }

  /**
   * Returns the dynamic GLOBAL_MAX_EXPOSURE_USD.
   * When compounding is enabled, this overrides the static config value.
   */
  getDynamicGlobalMaxExposure(): number | null {
    return this.latestSnapshot?.dynamicGlobalMaxExposureUsd ?? null;
  }

  /**
   * Get a balance-aware multiplier for the legacy calculateTradeSize() path.
   * This is applied as an additional factor to baseOrderShares, keeping
   * the existing fill-ratio / capital-clamp / liquidity-clamp logic intact.
   *
   * Multiplier = (balance × BASE_RISK_PCT) / (staticBaseOrderShares × referencePrice)
   * Clamped to [1.0, 5.0] — compounding only scales UP, never reduces below static sizes.
   * This ensures small balances still trade at their configured static sizes.
   */
  getScalperSizeMultiplier(staticBaseOrderShares: number, referencePrice: number): number {
    const snap = this.latestSnapshot;
    if (!snap || staticBaseOrderShares <= 0 || referencePrice <= 0) {
      return 1.0;
    }

    const staticNotional = staticBaseOrderShares * referencePrice;
    if (staticNotional <= 0) return 1.0;

    return clamp(snap.baseSizeUsd / staticNotional, 1.0, 5.0);
  }

  /**
   * OBI-specific compounding multiplier.
   *
   * Unlike sniper/MM which scale from baseSizeUsd, OBI uses a simple
   * threshold model: below `thresholdUsd` the multiplier is 1.0 (static
   * sizes unchanged), above it scales linearly up to 5×.
   *
   * Formula: clamp(bankroll / threshold, 1.0, 5.0)
   *   $40  / $200 = 0.20 → clamped to 1.0 (no change)
   *   $200 / $200 = 1.0  → 1× (start of scaling)
   *   $400 / $200 = 2.0  → 2× entry/max shares
   *   $1000/ $200 = 5.0  → 5× (cap)
   *
   * Drawdown guard is already baked into bankrollUsd via recalculate(),
   * so during drawdown the bankroll figure is halved → multiplier drops.
   */
  getObiSizeMultiplier(thresholdUsd: number): number {
    const snap = this.latestSnapshot;
    if (!snap || thresholdUsd <= 0) return 1.0;
    return clamp(snap.bankrollUsd / thresholdUsd, 1.0, 5.0);
  }

  /**
   * Check if sufficient balance exists to open the requested layers.
   * Returns the number of layers that can be funded.
   */
  getAffordableLayers(
    currentBalanceUsd: number,
    feeBufferPct = 0.10,
  ): number {
    const snap = this.latestSnapshot;
    if (!snap) return 0;

    const available = currentBalanceUsd * (1 - feeBufferPct);
    let cumulative = 0;
    let count = 0;

    for (const layer of snap.layers) {
      cumulative += layer.sizeUsd;
      if (cumulative > available) break;
      count++;
    }

    return count;
  }

  /**
   * Returns the latest snapshot for external reporting.
   */
  getSnapshot(): CompoundingSnapshot | null {
    return this.latestSnapshot;
  }

  // ─── Private ─────────────────────────────────────────────────────

  /**
   * Drawdown guard: if balance drops >drawdownGuardPct from day-start,
   * reduce all sizes by 50% until next day or recovery.
   */
  private updateDrawdownGuard(currentBalanceUsd: number): void {
    const todayKey = new Date().toISOString().slice(0, 10);

    // New day → reset
    if (this.dayStartKey !== todayKey) {
      this.dayStartKey = todayKey;
      this.dayStartBalanceUsd = currentBalanceUsd;
      this.drawdownGuardActive = false;
      return;
    }

    if (this.dayStartBalanceUsd === null) {
      this.dayStartBalanceUsd = currentBalanceUsd;
      return;
    }

    const drawdownPct = (this.dayStartBalanceUsd - currentBalanceUsd) / this.dayStartBalanceUsd;
    const threshold = this.compoundingConfig.drawdownGuardPct;

    if (!this.drawdownGuardActive && drawdownPct >= threshold) {
      this.drawdownGuardActive = true;
      logger.warn('Compounding: DRAWDOWN GUARD activated', {
        dayStart: roundTo(this.dayStartBalanceUsd, 2),
        current: roundTo(currentBalanceUsd, 2),
        drawdownPct: roundTo(drawdownPct * 100, 2),
        threshold: roundTo(threshold * 100, 2),
      });
    } else if (this.drawdownGuardActive && drawdownPct < threshold * 0.5) {
      // Recovery: deactivate when drawdown < half the threshold
      this.drawdownGuardActive = false;
      logger.info('Compounding: drawdown guard deactivated (recovery)', {
        current: roundTo(currentBalanceUsd, 2),
        drawdownPct: roundTo(drawdownPct * 100, 2),
      });
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Parse layer multipliers from env string like "1.0,1.5,2.0,2.5,3.0,3.5".
 */
export function parseLayerMultipliers(raw: string | undefined): number[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_LAYER_MULTIPLIERS];

  const parsed = raw
    .split(',')
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  return parsed.length > 0 ? parsed : [...DEFAULT_LAYER_MULTIPLIERS];
}
