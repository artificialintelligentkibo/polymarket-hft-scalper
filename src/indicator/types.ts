/**
 * Shared types for the Range Breakout Indicator Service.
 * Any consumer (including the main bot in a later phase) should import from here.
 */

export interface OhlcCandle {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface HeikinAshiCandle extends OhlcCandle {
  readonly haOpen: number;
  readonly haHigh: number;
  readonly haLow: number;
  readonly haClose: number;
}

export type RangeEventType =
  | 'bull_break'
  | 'bear_break'
  | 'buy_signal'
  | 'sell_signal'
  | 'fakeout_up'
  | 'fakeout_dn';

export interface RangeEvent {
  readonly ts: number;
  readonly symbol: string;
  readonly eventType: RangeEventType;
  readonly price: number;
  readonly levelRef: number;
}

export interface RangeBreakoutParams {
  readonly channelWidth: number;
  readonly atrLen: number;
  readonly smaLen: number;
  readonly maxCount: number;
  readonly warmupBars: number;
}

export interface RangeBreakoutState {
  readonly symbol: string;
  value: number;
  valueUpper: number;
  valueLower: number;
  valueUpperMid: number;
  valueLowerMid: number;
  count: number;
  trend: boolean;
  initialized: boolean;
  lastCandleCloseTime: number;
  barsProcessed: number;
  lastCrossUpper: number | null;
  lastCrossLower: number | null;
}

export interface RangeBreakoutTickResult {
  readonly crossUpper: boolean;
  readonly crossLower: boolean;
  readonly resetNow: boolean;
  readonly buySignal: boolean;
  readonly sellSignal: boolean;
  readonly fakeoutUp: boolean;
  readonly fakeoutDn: boolean;
  readonly events: readonly RangeEvent[];
}

export interface LevelSnapshot {
  readonly symbol: string;
  readonly ts: number;
  readonly lastBarCloseTs: number;
  readonly fresh: boolean;
  readonly barsProcessed: number;
  readonly value: number;
  readonly valueUpper: number;
  readonly valueLower: number;
  readonly valueUpperMid: number;
  readonly valueLowerMid: number;
  readonly trend: boolean;
  readonly count: number;
  readonly lastCrossUpper: number | null;
  readonly lastCrossLower: number | null;
}

export interface LevelRow extends LevelSnapshot {
  readonly crossUpper: boolean;
  readonly crossLower: boolean;
  readonly resetNow: boolean;
}

export interface IndicatorConfig {
  readonly httpPort: number;
  readonly symbols: readonly string[];
  readonly channelWidth: number;
  readonly atrLen: number;
  readonly smaLen: number;
  readonly maxCount: number;
  readonly warmupBars: number;
  readonly dbPath: string;
  readonly retentionHours: number;
  readonly eventsRetentionHours: number;
  readonly klineInterval: string;
  readonly klineSourceInterval: string;
  readonly bootstrapBars: number;
  readonly aggregationWindowMs: number;
  readonly binanceWsUrl: string;
  readonly binanceRestBase: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}
