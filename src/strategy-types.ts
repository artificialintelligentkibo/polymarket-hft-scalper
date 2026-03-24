import type { Outcome } from './clob-fetcher.js';

export type SignalAction = 'BUY' | 'SELL';
export type SignalUrgency = 'passive' | 'improve' | 'cross';
export type SignalType =
  | 'COMBINED_DISCOUNT_BUY_BOTH'
  | 'DEEP_BINANCE_SIGNAL'
  | 'DYNAMIC_QUOTE_BOTH'
  | 'EXTREME_BUY'
  | 'EXTREME_SELL'
  | 'FAIR_VALUE_BUY'
  | 'FAIR_VALUE_SELL'
  | 'INVENTORY_REBALANCE'
  | 'INVENTORY_REBALANCE_QUOTE'
  | 'RISK_LIMIT'
  | 'TRAILING_TAKE_PROFIT'
  | 'HARD_STOP'
  | 'SLOT_FLATTEN';

export const QUOTING_SIGNAL_TYPES = [
  'DEEP_BINANCE_SIGNAL',
  'DYNAMIC_QUOTE_BOTH',
  'INVENTORY_REBALANCE_QUOTE',
] as const satisfies readonly SignalType[];

export function isQuotingSignalType(signalType: SignalType): boolean {
  return QUOTING_SIGNAL_TYPES.includes(
    signalType as (typeof QUOTING_SIGNAL_TYPES)[number]
  );
}

export interface StrategySignal {
  readonly marketId: string;
  readonly marketTitle: string;
  readonly signalType: SignalType;
  readonly priority: number;
  readonly generatedAt?: number;
  readonly action: SignalAction;
  readonly outcome: Outcome;
  readonly outcomeIndex: 0 | 1;
  readonly shares: number;
  readonly targetPrice: number | null;
  readonly referencePrice: number | null;
  readonly tokenPrice: number | null;
  readonly midPrice: number | null;
  readonly fairValue: number | null;
  readonly edgeAmount: number;
  readonly combinedBid: number | null;
  readonly combinedAsk: number | null;
  readonly combinedMid: number | null;
  readonly combinedDiscount: number | null;
  readonly combinedPremium: number | null;
  readonly fillRatio: number;
  readonly capitalClamp: number;
  readonly priceMultiplier: number;
  readonly urgency: SignalUrgency;
  readonly reduceOnly: boolean;
  readonly reason: string;
}
