import type { StrategySignal } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface EVKellyConfig {
  enabled: boolean;
  minEVThreshold: number;
  minEVThresholdHighFee: number;
  kellyFraction: number;
  maxBankrollPerTrade: number;
  preferMakerOrders: boolean;
  defaultTakerFee: number;
  highFeeTakerFee: number;
}

export interface EVKellyResult {
  approved: boolean;
  ev: number;
  kellyFraction: number;
  adjustedShares: number;
  filterReason: string | null;
  takerFee: number;
  useMaker: boolean;
}

export function calculateEV(params: {
  trueProb: number;
  marketProb: number;
  price: number;
  side: 'YES' | 'NO';
  takerFee: number;
}): number {
  const trueProb = clamp(params.trueProb, 0, 1);
  const price = clamp(params.price, 0.0001, 0.9999);
  const takerFee = clamp(params.takerFee, 0, 0.25);
  return roundTo(trueProb * (1 - takerFee) - price, 6);
}

export function calculateKellySize(params: {
  trueProb: number;
  marketProb: number;
  bankroll: number;
  price: number;
  kellyFraction: number;
  maxBankrollPct: number;
}): number {
  const trueProb = clamp(params.trueProb, 0, 1);
  const marketProb = clamp(params.marketProb, 0.0001, 0.9999);
  const price = clamp(params.price, 0.0001, 0.9999);
  const bankroll = Math.max(0, params.bankroll);
  const edge = Math.max(0, trueProb - marketProb);
  const odds = (1 - marketProb) / marketProb;
  const fullKelly = odds > 0 ? edge / odds : 0;
  const cappedKellyFraction = clamp(params.kellyFraction, 0, 1);
  const cappedBankrollPct = clamp(params.maxBankrollPct, 0, 1);
  const stakeUsd = bankroll * Math.min(fullKelly * cappedKellyFraction, cappedBankrollPct);
  return roundTo(stakeUsd / price, 4);
}

export function getTakerFee(
  marketTitle: string,
  config: EVKellyConfig
): number {
  const normalized = marketTitle.trim().toUpperCase();
  const isFiveMinuteCryptoUpDown =
    /\bUP OR DOWN\b/.test(normalized) &&
    /\b(BTC|BITCOIN|ETH|ETHEREUM|SOL|SOLANA|XRP)\b/.test(normalized);

  return roundTo(
    isFiveMinuteCryptoUpDown ? config.highFeeTakerFee : config.defaultTakerFee,
    6
  );
}

export function applyEVKellyFilter(params: {
  signal: StrategySignal;
  bankroll: number;
  marketTitle: string;
  config: EVKellyConfig;
}): EVKellyResult {
  const { signal, config } = params;
  if (!config.enabled || signal.reduceOnly || isPairedArbSignal(signal)) {
    return {
      approved: true,
      ev: Number.POSITIVE_INFINITY,
      kellyFraction: clamp(config.kellyFraction, 0, 1),
      adjustedShares: signal.shares,
      filterReason: null,
      takerFee: getTakerFee(params.marketTitle, config),
      useMaker: config.preferMakerOrders && signal.urgency === 'cross',
    };
  }

  const marketProb = clamp(
    signal.midPrice ?? signal.tokenPrice ?? signal.targetPrice ?? 0.5,
    0.0001,
    0.9999
  );
  const price = clamp(signal.targetPrice ?? signal.tokenPrice ?? marketProb, 0.0001, 0.9999);
  const trueProb = clamp(signal.fairValue ?? signal.referencePrice ?? marketProb, 0.0001, 0.9999);
  const takerFee = getTakerFee(params.marketTitle, config);
  const minEVThreshold =
    takerFee > config.defaultTakerFee ? config.minEVThresholdHighFee : config.minEVThreshold;

  if (marketProb <= 0.02 || marketProb >= 0.98) {
    return {
      approved: false,
      ev: calculateEV({
        trueProb,
        marketProb,
        price,
        side: signal.outcome,
        takerFee,
      }),
      kellyFraction: 0,
      adjustedShares: 0,
      filterReason: 'EXTREME_PRICE_SKIP',
      takerFee,
      useMaker: false,
    };
  }

  const ev = calculateEV({
    trueProb,
    marketProb,
    price,
    side: signal.outcome,
    takerFee,
  });
  if (ev <= 0) {
    return {
      approved: false,
      ev,
      kellyFraction: 0,
      adjustedShares: 0,
      filterReason: 'EV_NEGATIVE',
      takerFee,
      useMaker: false,
    };
  }

  if (ev < minEVThreshold) {
    return {
      approved: false,
      ev,
      kellyFraction: 0,
      adjustedShares: 0,
      filterReason: 'EV_TOO_LOW',
      takerFee,
      useMaker: false,
    };
  }

  const adjustedShares = Math.min(
    signal.shares,
    calculateKellySize({
      trueProb,
      marketProb,
      bankroll: params.bankroll,
      price,
      kellyFraction: config.kellyFraction,
      maxBankrollPct: config.maxBankrollPerTrade,
    })
  );

  if (adjustedShares < 1) {
    return {
      approved: false,
      ev,
      kellyFraction: 0,
      adjustedShares,
      filterReason: 'KELLY_SIZE_TOO_SMALL',
      takerFee,
      useMaker: false,
    };
  }

  return {
    approved: true,
    ev,
    kellyFraction: clamp(config.kellyFraction, 0, 1),
    adjustedShares: roundTo(adjustedShares, 4),
    filterReason: null,
    takerFee,
    useMaker: config.preferMakerOrders && signal.urgency === 'cross',
  };
}

export function isPairedArbSignal(signal: Pick<StrategySignal, 'signalType'>): boolean {
  return (
    signal.signalType === 'PAIRED_ARB_BUY_YES' ||
    signal.signalType === 'PAIRED_ARB_BUY_NO' ||
    signal.signalType === 'PAIRED_ARB_REBALANCE'
  );
}
