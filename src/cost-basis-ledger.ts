import { roundTo } from './utils.js';

export interface CostBasisEntry {
  conditionId: string;
  marketTitle: string;
  totalCostUsd: number;
  totalShares: number;
  soldShares: number;
  soldProceeds: number;
  createdAt: string;
  updatedAt: string;
}

export interface RedeemPnlCalculation {
  pnl: number;
  remainingShares: number;
  remainingCost: number;
  redeemPayout: number;
  found: boolean;
}

/**
 * Tracks cumulative cost basis per conditionId across BUY fills so redeem
 * payouts can be bridged into realized day PnL after settlement.
 */
export class CostBasisLedger {
  private readonly entries = new Map<string, CostBasisEntry>();

  /**
   * Record a BUY fill and increase tracked cost basis for the condition.
   */
  recordBuy(params: {
    conditionId: string;
    marketTitle: string;
    shares: number;
    price: number;
    timestamp?: string;
  }): void {
    const conditionId = String(params.conditionId || '').trim();
    const shares = normalizePositive(params.shares);
    const price = normalizePositive(params.price);
    if (!conditionId || shares <= 0 || price <= 0) {
      return;
    }

    const timestamp = normalizeTimestamp(params.timestamp);
    const entry = this.entries.get(conditionId);
    if (!entry) {
      this.entries.set(conditionId, {
        conditionId,
        marketTitle: params.marketTitle || 'Unknown market',
        totalCostUsd: roundTo(shares * price, 4),
        totalShares: roundTo(shares, 4),
        soldShares: 0,
        soldProceeds: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return;
    }

    entry.marketTitle = params.marketTitle || entry.marketTitle;
    entry.totalCostUsd = roundTo(entry.totalCostUsd + shares * price, 4);
    entry.totalShares = roundTo(entry.totalShares + shares, 4);
    entry.updatedAt = timestamp;
  }

  /**
   * Record a SELL fill so remaining redeem basis can exclude sold inventory.
   */
  recordSell(params: {
    conditionId: string;
    shares: number;
    price: number;
    timestamp?: string;
  }): void {
    const conditionId = String(params.conditionId || '').trim();
    const shares = normalizePositive(params.shares);
    const price = normalizePositive(params.price);
    if (!conditionId || shares <= 0 || price <= 0) {
      return;
    }

    const entry = this.entries.get(conditionId);
    if (!entry) {
      return;
    }

    entry.soldShares = roundTo(Math.min(entry.totalShares, entry.soldShares + shares), 4);
    entry.soldProceeds = roundTo(entry.soldProceeds + shares * price, 4);
    entry.updatedAt = normalizeTimestamp(params.timestamp);
  }

  /**
   * Calculate redeem PnL for shares held through settlement.
   */
  calculateRedeemPnl(conditionId: string, redeemedShares: number): RedeemPnlCalculation {
    const normalizedConditionId = String(conditionId || '').trim();
    const entry = this.entries.get(normalizedConditionId);
    if (!entry) {
      return {
        pnl: 0,
        remainingShares: 0,
        remainingCost: 0,
        redeemPayout: 0,
        found: false,
      };
    }

    const remainingShares = roundTo(Math.max(0, entry.totalShares - entry.soldShares), 4);
    const remainingCost = roundTo(Math.max(0, entry.totalCostUsd - entry.soldProceeds), 4);
    const normalizedRedeemedShares = normalizePositive(redeemedShares);
    if (normalizedRedeemedShares <= 0) {
      return {
        pnl: 0,
        remainingShares,
        remainingCost,
        redeemPayout: 0,
        found: true,
      };
    }

    const effectiveRedeemedShares = roundTo(
      Math.min(normalizedRedeemedShares, remainingShares),
      4
    );
    const redeemPayout = roundTo(effectiveRedeemedShares, 4);
    return {
      pnl: roundTo(redeemPayout - remainingCost, 4),
      remainingShares,
      remainingCost,
      redeemPayout,
      found: true,
    };
  }

  /**
   * Remove and return a tracked condition after settlement is complete.
   */
  consume(conditionId: string): CostBasisEntry | undefined {
    const normalizedConditionId = String(conditionId || '').trim();
    if (!normalizedConditionId) {
      return undefined;
    }

    const entry = this.entries.get(normalizedConditionId);
    if (!entry) {
      return undefined;
    }

    this.entries.delete(normalizedConditionId);
    return { ...entry };
  }

  /**
   * Remove entries whose last update is older than the supplied TTL.
   */
  prune(maxAgeMs: number, now: Date = new Date()): void {
    const ttlMs = Math.max(0, Math.trunc(maxAgeMs));
    if (ttlMs <= 0) {
      return;
    }

    const nowMs = now.getTime();
    for (const [conditionId, entry] of this.entries.entries()) {
      const updatedAtMs = Date.parse(entry.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        this.entries.delete(conditionId);
        continue;
      }

      if (nowMs - updatedAtMs > ttlMs) {
        this.entries.delete(conditionId);
      }
    }
  }

  /**
   * Return the current tracked entry for debugging or dashboards.
   */
  get(conditionId: string): CostBasisEntry | undefined {
    const normalizedConditionId = String(conditionId || '').trim();
    const entry = this.entries.get(normalizedConditionId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Number of condition ids currently tracked in the ledger.
   */
  get size(): number {
    return this.entries.size;
  }
}

function normalizePositive(value: number): number {
  return Number.isFinite(value) ? roundTo(Math.max(0, value), 4) : 0;
}

function normalizeTimestamp(value?: string): string {
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}
