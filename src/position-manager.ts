import type { Outcome } from './clob-fetcher.js';

export type TradeSide = 'BUY' | 'SELL';

export interface Fill {
  outcome: Outcome;
  side: TradeSide;
  shares: number;
  price: number;
  timestamp?: string;
  orderId?: string;
}

export interface PositionRiskLimits {
  maxNetYes: number;
  maxNetNo: number;
  trailingTakeProfit: number;
  hardStopLoss: number;
  exitBeforeEndMs: number;
}

export interface PositionSnapshot {
  marketId: string;
  slotEndsAt: string | null;
  yesShares: number;
  noShares: number;
  yesAvgEntryPrice: number;
  noAvgEntryPrice: number;
  signedNetShares: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  lastUpdatedAt: string | null;
}

export interface ExitSignal {
  outcome: Outcome;
  shares: number;
  reason: string;
  targetPrice: number | null;
}

export interface BoundaryCorrection {
  action: TradeSide;
  outcome: Outcome;
  shares: number;
  reason: string;
}

interface OutcomeState {
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
  lastMarkPrice: number | null;
  peakMarkPrice: number | null;
  lastFillAt: string | null;
}

const EPSILON = 0.000001;

export class PositionManager {
  private readonly yes: OutcomeState = this.createEmptyState();
  private readonly no: OutcomeState = this.createEmptyState();
  private slotEndsAt: string | null;

  constructor(private readonly marketId: string, slotEndsAt?: string | null) {
    this.slotEndsAt = slotEndsAt ?? null;
  }

  setSlotEndsAt(slotEndsAt: string | null): void {
    this.slotEndsAt = slotEndsAt;
  }

  getSnapshot(): PositionSnapshot {
    const yesUnrealized = this.getOutcomeUnrealized('YES');
    const noUnrealized = this.getOutcomeUnrealized('NO');
    const realizedPnl = this.yes.realizedPnl + this.no.realizedPnl;
    const unrealizedPnl = yesUnrealized + noUnrealized;

    return {
      marketId: this.marketId,
      slotEndsAt: this.slotEndsAt,
      yesShares: roundTo(this.yes.shares, 4),
      noShares: roundTo(this.no.shares, 4),
      yesAvgEntryPrice: roundTo(this.yes.avgEntryPrice, 6),
      noAvgEntryPrice: roundTo(this.no.avgEntryPrice, 6),
      signedNetShares: roundTo(this.getSignedNetShares(), 4),
      realizedPnl: roundTo(realizedPnl, 4),
      unrealizedPnl: roundTo(unrealizedPnl, 4),
      totalPnl: roundTo(realizedPnl + unrealizedPnl, 4),
      lastUpdatedAt: this.resolveLastUpdatedAt(),
    };
  }

  getShares(outcome: Outcome): number {
    return roundTo(this.getState(outcome).shares, 4);
  }

  getAvgEntryPrice(outcome: Outcome): number {
    return roundTo(this.getState(outcome).avgEntryPrice, 6);
  }

  getSignedNetShares(): number {
    return this.yes.shares - this.no.shares;
  }

  getAvailableEntryCapacity(outcome: Outcome, limits: PositionRiskLimits): number {
    const signedNet = this.getSignedNetShares();
    if (outcome === 'YES') {
      return Math.max(0, limits.maxNetYes - signedNet);
    }
    return Math.max(0, signedNet - limits.maxNetNo);
  }

  markToMarket(marks: Partial<Record<Outcome, number | null>>): void {
    if (marks.YES !== undefined) {
      this.updateMarkState(this.yes, marks.YES);
    }
    if (marks.NO !== undefined) {
      this.updateMarkState(this.no, marks.NO);
    }
  }

  applyFill(fill: Fill): PositionSnapshot {
    if (!Number.isFinite(fill.shares) || fill.shares <= 0) {
      throw new Error('Fill shares must be positive.');
    }

    if (!Number.isFinite(fill.price) || fill.price <= 0) {
      throw new Error('Fill price must be positive.');
    }

    const state = this.getState(fill.outcome);
    const timestamp = fill.timestamp ?? new Date().toISOString();

    if (fill.side === 'BUY') {
      const totalCost = state.avgEntryPrice * state.shares + fill.price * fill.shares;
      state.shares += fill.shares;
      state.avgEntryPrice = state.shares > EPSILON ? totalCost / state.shares : 0;
      state.lastFillAt = timestamp;
      state.lastMarkPrice = fill.price;
      state.peakMarkPrice = Math.max(state.peakMarkPrice ?? fill.price, fill.price);
      return this.getSnapshot();
    }

    if (fill.shares > state.shares + EPSILON) {
      throw new Error(
        `Cannot sell ${fill.shares} ${fill.outcome} shares when only ${state.shares} are open`
      );
    }

    const closedShares = Math.min(fill.shares, state.shares);
    state.realizedPnl += (fill.price - state.avgEntryPrice) * closedShares;
    state.shares = Math.max(0, state.shares - closedShares);
    state.lastFillAt = timestamp;
    state.lastMarkPrice = fill.price;

    if (state.shares <= EPSILON) {
      state.shares = 0;
      state.avgEntryPrice = 0;
      state.peakMarkPrice = null;
      state.lastMarkPrice = null;
    }

    return this.getSnapshot();
  }

  getBoundaryCorrection(limits: PositionRiskLimits): BoundaryCorrection | null {
    const signedNet = this.getSignedNetShares();

    if (signedNet > limits.maxNetYes + EPSILON) {
      const excessShares = roundTo(signedNet - limits.maxNetYes, 4);
      if (this.yes.shares > EPSILON) {
        return {
          action: 'SELL',
          outcome: 'YES',
          shares: Math.min(excessShares, this.yes.shares),
          reason: `Net YES ${roundTo(signedNet, 4)} exceeded cap ${limits.maxNetYes}`,
        };
      }

      return {
        action: 'BUY',
        outcome: 'NO',
        shares: excessShares,
        reason: `Net YES ${roundTo(signedNet, 4)} exceeded cap ${limits.maxNetYes}; flipping into NO`,
      };
    }

    if (signedNet < limits.maxNetNo - EPSILON) {
      const excessShares = roundTo(limits.maxNetNo - signedNet, 4);
      if (this.no.shares > EPSILON) {
        return {
          action: 'SELL',
          outcome: 'NO',
          shares: Math.min(excessShares, this.no.shares),
          reason: `Net NO ${roundTo(signedNet, 4)} exceeded cap ${limits.maxNetNo}`,
        };
      }

      return {
        action: 'BUY',
        outcome: 'YES',
        shares: excessShares,
        reason: `Net NO ${roundTo(signedNet, 4)} exceeded cap ${limits.maxNetNo}; flipping into YES`,
      };
    }

    return null;
  }

  getExitSignal(
    outcome: Outcome,
    now: Date,
    limits: PositionRiskLimits
  ): ExitSignal | null {
    const state = this.getState(outcome);
    if (state.shares <= EPSILON) {
      return null;
    }

    const mark = state.lastMarkPrice;
    if (this.slotEndsAt) {
      const slotEndMs = Date.parse(this.slotEndsAt);
      if (Number.isFinite(slotEndMs) && slotEndMs - now.getTime() <= limits.exitBeforeEndMs) {
        return {
          outcome,
          shares: roundTo(state.shares, 4),
          reason: 'Slot is ending, flattening inventory',
          targetPrice: mark,
        };
      }
    }

    if (mark !== null && mark <= state.avgEntryPrice - limits.hardStopLoss) {
      return {
        outcome,
        shares: roundTo(state.shares, 4),
        reason: `Hard stop triggered at ${roundTo(mark, 4)} vs entry ${roundTo(state.avgEntryPrice, 4)}`,
        targetPrice: mark,
      };
    }

    if (
      mark !== null &&
      state.peakMarkPrice !== null &&
      state.peakMarkPrice - state.avgEntryPrice >= limits.trailingTakeProfit &&
      mark <= state.peakMarkPrice - limits.trailingTakeProfit
    ) {
      return {
        outcome,
        shares: roundTo(state.shares, 4),
        reason: `Trailing take-profit triggered after peak ${roundTo(state.peakMarkPrice, 4)}`,
        targetPrice: mark,
      };
    }

    return null;
  }

  private getOutcomeUnrealized(outcome: Outcome): number {
    const state = this.getState(outcome);
    if (state.shares <= EPSILON || state.lastMarkPrice === null) {
      return 0;
    }

    return (state.lastMarkPrice - state.avgEntryPrice) * state.shares;
  }

  private updateMarkState(state: OutcomeState, mark: number | null): void {
    if (mark === null || !Number.isFinite(mark) || mark <= 0) {
      return;
    }

    state.lastMarkPrice = mark;
    if (state.shares > EPSILON) {
      state.peakMarkPrice = Math.max(state.peakMarkPrice ?? mark, mark);
    } else {
      state.peakMarkPrice = mark;
    }
  }

  private getState(outcome: Outcome): OutcomeState {
    return outcome === 'YES' ? this.yes : this.no;
  }

  private resolveLastUpdatedAt(): string | null {
    if (!this.yes.lastFillAt && !this.no.lastFillAt) {
      return null;
    }

    const yesTimestamp = this.yes.lastFillAt ? Date.parse(this.yes.lastFillAt) : 0;
    const noTimestamp = this.no.lastFillAt ? Date.parse(this.no.lastFillAt) : 0;
    return yesTimestamp >= noTimestamp ? this.yes.lastFillAt : this.no.lastFillAt;
  }

  private createEmptyState(): OutcomeState {
    return {
      shares: 0,
      avgEntryPrice: 0,
      realizedPnl: 0,
      lastMarkPrice: null,
      peakMarkPrice: null,
      lastFillAt: null,
    };
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
