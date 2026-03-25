import { config, type AppConfig } from './config.js';
import type { Outcome } from './clob-fetcher.js';
import { getDayPnlState } from './day-pnl-state.js';
import { getSlotKey, type MarketCandidate } from './monitor.js';
import type { SlotMetrics } from './slot-reporter.js';
import type { SignalType, SignalUrgency, StrategySignal } from './strategy-types.js';
import { writeProductTestSummary } from './reports.js';
import { formatLogTimestamp, roundTo, sanitizeInlineText } from './utils.js';

const PRODUCT_TEST_REQUIRED_FEATURES = [
  'FAIR_VALUE_BUY',
  'FAIR_VALUE_SELL',
  'EXTREME_BUY',
  'EXTREME_SELL',
  'INVENTORY_REBALANCE',
  'TRAILING_TAKE_PROFIT',
  'HARD_STOP',
  'SLOT_FLATTEN',
  'AUTO_REDEEM',
] as const;

const PRODUCT_TEST_MIN_SHARES = 1;
const PRODUCT_TEST_MAX_SHARES = 3;
const PRODUCT_TEST_MAX_NOTIONAL_MULTIPLIER = 3;
const PRODUCT_TEST_INVENTORY_IMBALANCE_FLOOR = 60;
const PRODUCT_TEST_MAX_NET_YES = 30;
const PRODUCT_TEST_MAX_NET_NO = 40;

export type ProductTestFeature =
  | (typeof PRODUCT_TEST_REQUIRED_FEATURES)[number]
  | 'AUTO_REDEEM';

export interface ProductTestExecutionRecord {
  readonly timestampMs: number;
  readonly signalType: SignalType;
  readonly action: StrategySignal['action'];
  readonly outcome: Outcome;
  readonly latencySignalToOrderMs?: number;
  readonly latencyRoundTripMs?: number;
}

function isProductTestFeature(
  signalType: SignalType
): signalType is Exclude<ProductTestFeature, 'AUTO_REDEEM'> {
  return PRODUCT_TEST_REQUIRED_FEATURES.includes(
    signalType as Exclude<ProductTestFeature, 'AUTO_REDEEM'>
  );
}

export interface ProductTestRedeemRecord {
  readonly timestampMs: number;
  readonly conditionId: string;
  readonly title: string;
  readonly redeemedAmount: number;
  readonly transactionId?: string | null;
  readonly transactionHash?: string | null;
  readonly state?: string | null;
}

type StrategyConfig = AppConfig['strategy'];

export function getEffectiveStrategyConfig(
  runtimeConfig: AppConfig = config
): StrategyConfig {
  if (!runtimeConfig.PRODUCT_TEST_MODE) {
    return runtimeConfig.strategy;
  }

  return {
    ...runtimeConfig.strategy,
    minShares: PRODUCT_TEST_MIN_SHARES,
    maxShares: Math.min(runtimeConfig.strategy.maxShares, PRODUCT_TEST_MAX_SHARES),
    baseOrderShares: Math.min(
      runtimeConfig.strategy.baseOrderShares,
      Math.max(PRODUCT_TEST_MIN_SHARES, runtimeConfig.TEST_MIN_TRADE_USDC)
    ),
    maxNetYes: Math.min(runtimeConfig.strategy.maxNetYes, PRODUCT_TEST_MAX_NET_YES),
    maxNetNo: Math.min(runtimeConfig.strategy.maxNetNo, PRODUCT_TEST_MAX_NET_NO),
    inventoryImbalanceThreshold: Math.max(
      runtimeConfig.strategy.inventoryImbalanceThreshold,
      PRODUCT_TEST_INVENTORY_IMBALANCE_FLOOR
    ),
  };
}

export function clampProductTestShares(
  shares: number,
  price: number,
  runtimeConfig: AppConfig = config
): number {
  if (!runtimeConfig.PRODUCT_TEST_MODE) {
    return roundTo(shares, 4);
  }

  const effectiveStrategy = getEffectiveStrategyConfig(runtimeConfig);
  const safePrice = Number.isFinite(price) && price > 0 ? price : 1;
  const maxNotionalUsd = Math.max(
    runtimeConfig.TEST_MIN_TRADE_USDC,
    runtimeConfig.TEST_MIN_TRADE_USDC * PRODUCT_TEST_MAX_NOTIONAL_MULTIPLIER
  );
  const maxSharesByNotional = maxNotionalUsd / safePrice;
  const maxAllowedShares = Math.max(
    PRODUCT_TEST_MIN_SHARES,
    Math.min(effectiveStrategy.maxShares, maxSharesByNotional)
  );

  return roundTo(
    Math.max(PRODUCT_TEST_MIN_SHARES, Math.min(shares, maxAllowedShares)),
    4
  );
}

export function resolveProductTestUrgency(
  urgency: SignalUrgency,
  runtimeConfig: AppConfig = config
): SignalUrgency {
  if (!runtimeConfig.PRODUCT_TEST_MODE) {
    return urgency;
  }

  return urgency === 'cross' ? 'improve' : urgency;
}

export class ProductTestModeController {
  private selectedMarket: MarketCandidate | null = null;
  private selectedSlotKey: string | null = null;
  private slotMetrics: SlotMetrics | null = null;
  private slotSettledAtMs: number | null = null;
  private completed = false;
  private summaryWritten = false;
  private redeemAttemptFinished = false;
  private redeemRecord: ProductTestRedeemRecord | null = null;
  private readonly observedFeatures = new Set<ProductTestFeature>();
  private readonly executionRecords: ProductTestExecutionRecord[] = [];
  private readonly warnings: string[] = [];
  private readonly errors: string[] = [];

  constructor(private readonly runtimeConfig: AppConfig = config) {}

  isEnabled(): boolean {
    return this.runtimeConfig.PRODUCT_TEST_MODE;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  selectMarkets(markets: readonly MarketCandidate[]): MarketCandidate[] {
    if (!this.isEnabled()) {
      return [...markets];
    }

    if (this.completed) {
      return [];
    }

    this.maybeFinalizePending();

    if (this.completed) {
      return [];
    }

    if (this.selectedMarket) {
      const activeMatch = markets.find(
        (candidate) => candidate.conditionId === this.selectedMarket?.conditionId
      );

      return activeMatch ? [activeMatch] : [];
    }

    const firstMarket = markets[0];
    if (!firstMarket) {
      return [];
    }

    this.selectedMarket = firstMarket;
    this.selectedSlotKey = getSlotKey(firstMarket);

    if (markets.length > 1) {
      this.addWarning(
        `PRODUCT_TEST_MODE pinned the first eligible slot and skipped ${markets.length - 1} additional markets`
      );
    }

    return [firstMarket];
  }

  recordExecution(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    latencySignalToOrderMs?: number;
    latencyRoundTripMs?: number;
  }): void {
    if (!this.matchesSelectedMarket(params.market)) {
      return;
    }

    if (isProductTestFeature(params.signal.signalType)) {
      this.observedFeatures.add(params.signal.signalType);
    }
    this.executionRecords.push({
      timestampMs: Date.now(),
      signalType: params.signal.signalType,
      action: params.signal.action,
      outcome: params.signal.outcome,
      latencySignalToOrderMs: params.latencySignalToOrderMs,
      latencyRoundTripMs: params.latencyRoundTripMs,
    });
  }

  recordSlotReport(market: MarketCandidate, metrics: SlotMetrics | null): void {
    if (!this.matchesSelectedMarket(market) || !metrics) {
      return;
    }

    this.slotMetrics = metrics;
    this.slotSettledAtMs = Date.now();
    this.maybeFinalizePending();
  }

  recordRedeemSuccess(record: ProductTestRedeemRecord): void {
    if (!this.matchesSelectedConditionId(record.conditionId)) {
      return;
    }

    this.redeemAttemptFinished = true;
    this.redeemRecord = record;
    this.observedFeatures.add('AUTO_REDEEM');
    this.maybeFinalizePending();
  }

  recordRedeemFailure(conditionId: string, message: string): void {
    if (!this.matchesSelectedConditionId(conditionId)) {
      return;
    }

    this.redeemAttemptFinished = true;
    this.addError(`Auto redeem failed: ${message}`);
    this.maybeFinalizePending();
  }

  recordExecutionWarning(message: string): void {
    if (!this.isEnabled()) {
      return;
    }

    this.addWarning(message);
  }

  recordExecutionError(message: string): void {
    if (!this.isEnabled()) {
      return;
    }

    this.addError(message);
  }

  maybeFinalizePending(nowMs = Date.now()): boolean {
    if (!this.isEnabled() || this.summaryWritten || !this.selectedMarket || !this.slotMetrics) {
      return false;
    }

    const settledAtMs = this.slotSettledAtMs ?? nowMs;
    const waitedLongEnough =
      nowMs - settledAtMs >= Math.max(this.runtimeConfig.REDEEM_INTERVAL_MS * 2, 60_000);

    if (!this.redeemAttemptFinished && !waitedLongEnough) {
      return false;
    }

    if (!this.redeemAttemptFinished && waitedLongEnough) {
      this.addWarning('Auto redeem did not finish before the product-test summary timeout');
    }

    const summary = this.buildSummary(nowMs);
    writeProductTestSummary(summary, nowMs);
    console.log(`\n${summary}`);
    this.summaryWritten = true;
    this.completed = true;
    return true;
  }

  private buildSummary(timestampMs: number): string {
    const testedFeatures = PRODUCT_TEST_REQUIRED_FEATURES.filter((feature) =>
      this.observedFeatures.has(feature)
    );
    const missingFeatures = PRODUCT_TEST_REQUIRED_FEATURES.filter(
      (feature) => !this.observedFeatures.has(feature)
    );
    const successRate = PRODUCT_TEST_REQUIRED_FEATURES.length
      ? roundTo((testedFeatures.length / PRODUCT_TEST_REQUIRED_FEATURES.length) * 100, 2)
      : 0;
    const averageLatencyMs =
      this.executionRecords.length > 0
        ? roundTo(
            this.executionRecords.reduce((sum, record) => {
              const latency =
                record.latencyRoundTripMs ?? record.latencySignalToOrderMs ?? 0;
              return sum + latency;
            }, 0) / this.executionRecords.length,
            2
          )
        : 0;
    const status =
      this.errors.length > 0
        ? 'FAILED'
        : missingFeatures.length === 0
          ? 'PASSED'
          : 'PARTIAL';
    const slot = this.selectedMarket;
    const pnl = this.slotMetrics?.total ?? 0;
    const redeemedAmount = this.redeemRecord?.redeemedAmount ?? 0;
    const dayState = getDayPnlState(new Date(timestampMs));

    const lines = [
      `[${formatLogTimestamp(new Date(timestampMs))}] PRODUCT TEST SUMMARY - ${status} ${testedFeatures.length}/${PRODUCT_TEST_REQUIRED_FEATURES.length} features`,
      `Slot: ${sanitizeInlineText(slot?.title || 'n/a')} | conditionId=${slot?.conditionId || 'n/a'}`,
      `Tested: ${testedFeatures.join(', ') || 'none'}`,
      missingFeatures.length > 0 ? `Missing: ${missingFeatures.join(', ')}` : '',
      ...this.executionRecords.map((record) => {
        const latency =
          record.latencyRoundTripMs ?? record.latencySignalToOrderMs ?? undefined;
        return `  [${formatLogTimestamp(new Date(record.timestampMs))}] ${record.signalType} ${record.action} ${record.outcome} latency=${formatLatency(latency)}`;
      }),
      `Final PnL: ${formatUsd(pnl)} | Redeemed: ${formatUsd(redeemedAmount)}`,
      `Avg latency: ${formatLatency(averageLatencyMs)} | Day PnL: ${formatUsd(dayState.dayPnl)} | Drawdown: ${formatUsd(dayState.drawdown)}`,
      `Success rate: ${successRate.toFixed(2)}%`,
      this.warnings.length > 0 ? `Warnings: ${this.warnings.join(' ; ')}` : '',
      this.errors.length > 0 ? `Errors: ${this.errors.join(' ; ')}` : '',
      `Status: ${status}`,
      '',
    ];

    return lines.filter(Boolean).join('\n');
  }

  private matchesSelectedMarket(market: MarketCandidate): boolean {
    return Boolean(
      this.selectedMarket &&
        market.conditionId === this.selectedMarket.conditionId &&
        (!this.selectedSlotKey || getSlotKey(market) === this.selectedSlotKey)
    );
  }

  private matchesSelectedConditionId(conditionId: string): boolean {
    return Boolean(
      this.selectedMarket &&
        conditionId.trim().toLowerCase() === this.selectedMarket.conditionId.toLowerCase()
    );
  }

  private addWarning(message: string): void {
    if (!message || this.warnings.includes(message)) {
      return;
    }
    this.warnings.push(message);
  }

  private addError(message: string): void {
    if (!message || this.errors.includes(message)) {
      return;
    }
    this.errors.push(message);
  }
}

function formatUsd(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return `${normalized >= 0 ? '+' : '-'}$${Math.abs(normalized).toFixed(2)}`;
}

function formatLatency(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }

  return `${Math.max(0, Math.round(value))}ms`;
}
