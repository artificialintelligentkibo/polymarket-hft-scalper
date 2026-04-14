import type { Outcome } from './clob-fetcher.js';

export type SignalAction = 'BUY' | 'SELL';
export type SignalUrgency = 'passive' | 'improve' | 'cross';
export type StrategyLayer = 'SNIPER' | 'MM_QUOTE' | 'PAIRED_ARB' | 'LOTTERY' | 'OBI' | 'VS_ENGINE';
export type SignalType =
  | 'COMBINED_DISCOUNT_BUY_BOTH'
  | 'DEEP_BINANCE_SIGNAL'
  | 'DYNAMIC_QUOTE_BOTH'
  | 'EXTREME_BUY'
  | 'EXTREME_SELL'
  | 'FAIR_VALUE_BUY'
  | 'FAIR_VALUE_SELL'
  | 'LATENCY_MOMENTUM_BUY'
  | 'LOTTERY_BUY'
  | 'MM_QUOTE_ASK'
  | 'MM_QUOTE_BID'
  | 'INVENTORY_REBALANCE'
  | 'INVENTORY_REBALANCE_QUOTE'
  | 'OBI_ENTRY_BUY'
  | 'OBI_SCALP_EXIT'
  | 'OBI_REBALANCE_EXIT'
  | 'OBI_MM_QUOTE_ASK'
  | 'OBI_MM_QUOTE_BID'
  | 'PAIRED_ARB_BUY_YES'
  | 'PAIRED_ARB_BUY_NO'
  | 'PAIRED_ARB_REBALANCE'
  | 'RISK_LIMIT'
  | 'SNIPER_BUY'
  | 'SNIPER_SCALP_EXIT'
  | 'TRAILING_TAKE_PROFIT'
  | 'HARD_STOP'
  | 'SLOT_FLATTEN'
  | 'VS_ENTRY_BUY'
  | 'VS_MM_BID'
  | 'VS_MM_ASK'
  | 'VS_MOMENTUM_BUY'
  | 'VS_SCALP_EXIT'
  | 'VS_DYNAMIC_EXIT'
  | 'VS_TIME_EXIT';

export const QUOTING_SIGNAL_TYPES = [
  'DEEP_BINANCE_SIGNAL',
  'DYNAMIC_QUOTE_BOTH',
  'INVENTORY_REBALANCE_QUOTE',
  'MM_QUOTE_BID',
  'MM_QUOTE_ASK',
  // Phase 25: OBI_MM_QUOTE_ASK/BID removed — they must go through the direct
  // execution path so the bot actually posts resting sell orders after entry.
  // Previously they were trapped in quotingEngine.syncMarketContext() and never
  // executed, causing ALL positions to go to redeem instead of scalp-exiting.
] as const satisfies readonly SignalType[];

export function isQuotingSignalType(signalType: SignalType): boolean {
  return QUOTING_SIGNAL_TYPES.includes(
    signalType as (typeof QUOTING_SIGNAL_TYPES)[number]
  );
}

/**
 * True for OBI position-exit signals (collapse, hard-stop, scalp, rebalance,
 * orphan flatten — all of which are emitted as either OBI_REBALANCE_EXIT or
 * OBI_SCALP_EXIT depending on the trigger). These signals must FIRST cancel
 * any pending OBI_MM_QUOTE_ASK on the same market+outcome, otherwise the
 * resting maker order locks the underlying shares as collateral and the
 * exit fails with "balance not enough" until the maker times out.
 */
export function isObiExitSignal(signalType: SignalType): boolean {
  return signalType === 'OBI_REBALANCE_EXIT' || signalType === 'OBI_SCALP_EXIT';
}

/**
 * True for VS Engine exit signals. Must cancel pending VS_MM_BID/ASK
 * before executing, same pattern as OBI exits.
 */
export function isVsExitSignal(signalType: SignalType): boolean {
  return signalType === 'VS_SCALP_EXIT' || signalType === 'VS_TIME_EXIT' || signalType === 'VS_DYNAMIC_EXIT';
}

export function bypassesBinanceEdge(signalType: SignalType): boolean {
  return (
    signalType === 'LATENCY_MOMENTUM_BUY' ||
    signalType === 'MM_QUOTE_BID' ||
    signalType === 'MM_QUOTE_ASK' ||
    signalType === 'LOTTERY_BUY' ||
    signalType === 'PAIRED_ARB_BUY_YES' ||
    signalType === 'PAIRED_ARB_BUY_NO' ||
    signalType === 'PAIRED_ARB_REBALANCE' ||
    signalType === 'SNIPER_BUY' ||
    signalType === 'SNIPER_SCALP_EXIT' ||
    signalType === 'OBI_ENTRY_BUY' ||
    signalType === 'OBI_SCALP_EXIT' ||
    signalType === 'OBI_REBALANCE_EXIT' ||
    signalType === 'OBI_MM_QUOTE_ASK' ||
    signalType === 'OBI_MM_QUOTE_BID' ||
    signalType === 'VS_ENTRY_BUY' ||
    signalType === 'VS_MM_BID' ||
    signalType === 'VS_MM_ASK' ||
    signalType === 'VS_MOMENTUM_BUY' ||
    signalType === 'VS_SCALP_EXIT' ||
    signalType === 'VS_DYNAMIC_EXIT' ||
    signalType === 'VS_TIME_EXIT'
  );
}

export function resolveStrategyLayer(signalType: SignalType): StrategyLayer {
  switch (signalType) {
    case 'SNIPER_BUY':
    case 'SNIPER_SCALP_EXIT':
    case 'LATENCY_MOMENTUM_BUY':
    case 'COMBINED_DISCOUNT_BUY_BOTH':
    case 'EXTREME_BUY':
    case 'EXTREME_SELL':
    case 'FAIR_VALUE_BUY':
    case 'FAIR_VALUE_SELL':
    case 'INVENTORY_REBALANCE':
    case 'RISK_LIMIT':
    case 'TRAILING_TAKE_PROFIT':
    case 'HARD_STOP':
    case 'SLOT_FLATTEN':
      return 'SNIPER';
    case 'MM_QUOTE_BID':
    case 'MM_QUOTE_ASK':
    case 'DYNAMIC_QUOTE_BOTH':
    case 'INVENTORY_REBALANCE_QUOTE':
    case 'DEEP_BINANCE_SIGNAL':
      return 'MM_QUOTE';
    case 'PAIRED_ARB_BUY_YES':
    case 'PAIRED_ARB_BUY_NO':
    case 'PAIRED_ARB_REBALANCE':
      return 'PAIRED_ARB';
    case 'LOTTERY_BUY':
      return 'LOTTERY';
    case 'OBI_ENTRY_BUY':
    case 'OBI_SCALP_EXIT':
    case 'OBI_REBALANCE_EXIT':
    case 'OBI_MM_QUOTE_ASK':
    case 'OBI_MM_QUOTE_BID':
      return 'OBI';
    case 'VS_ENTRY_BUY':
    case 'VS_MM_BID':
    case 'VS_MM_ASK':
    case 'VS_MOMENTUM_BUY':
    case 'VS_SCALP_EXIT':
    case 'VS_DYNAMIC_EXIT':
    case 'VS_TIME_EXIT':
      return 'VS_ENGINE';
    default:
      return 'SNIPER';
  }
}

/**
 * Returns true if two strategy layers conflict and should NOT coexist
 * on the same market. When LAYER_CONFLICT_RESOLUTION=BLOCK, the second
 * signal is dropped.
 *
 * Phase 30: OBI and SNIPER are now allowed to coexist. They target
 * different edges (OBI = mean-reversion, Sniper = Binance momentum)
 * and rarely fire on the same market simultaneously. When they do,
 * per-market position limits and global exposure caps prevent over-sizing.
 * OBI + MM_QUOTE is also allowed since OBI has its own MM layer.
 */
export function isLayerConflict(
  existingLayer: StrategyLayer | null,
  newLayer: StrategyLayer
): boolean {
  if (existingLayer === null || existingLayer === newLayer) {
    return false;
  }

  // Allowed pairs — these can coexist on the same market:
  const ALLOWED_PAIRS: ReadonlySet<string> = new Set([
    'SNIPER:MM_QUOTE',
    'MM_QUOTE:SNIPER',
    'SNIPER:LOTTERY',
    'LOTTERY:SNIPER',
    'MM_QUOTE:LOTTERY',
    'LOTTERY:MM_QUOTE',
    'OBI:LOTTERY',
    'LOTTERY:OBI',
    // Phase 30: OBI + SNIPER allowed in ALL mode
    'OBI:SNIPER',
    'SNIPER:OBI',
    // OBI + MM_QUOTE allowed (OBI has its own MM layer)
    'OBI:MM_QUOTE',
    'MM_QUOTE:OBI',
    // VS_ENGINE + LOTTERY allowed (convex follow-on)
    'VS_ENGINE:LOTTERY',
    'LOTTERY:VS_ENGINE',
    // VS_ENGINE + MM_QUOTE allowed (VS has its own quoting)
    'VS_ENGINE:MM_QUOTE',
    'MM_QUOTE:VS_ENGINE',
    // VS_ENGINE + SNIPER allowed (different edges)
    'VS_ENGINE:SNIPER',
    'SNIPER:VS_ENGINE',
    // Phase 53: OBI + VS_ENGINE allowed — different signals (book imbalance vs Binance arb)
    // They naturally avoid collision: OBI enters on thin-side rebalance, VS on Binance momentum.
    'OBI:VS_ENGINE',
    'VS_ENGINE:OBI',
  ]);

  return !ALLOWED_PAIRS.has(`${existingLayer}:${newLayer}`);
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
  readonly filterReason?: string | null;
  readonly evScore?: number;
  readonly kellyAdjustedShares?: number;
  readonly urgency: SignalUrgency;
  readonly reduceOnly: boolean;
  readonly reason: string;
  readonly strategyLayer?: StrategyLayer;
}
