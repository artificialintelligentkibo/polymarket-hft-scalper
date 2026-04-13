import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CircuitBreakerSnapshot } from './api-retry.js';
import { config, isDryRunMode, isDynamicQuotingEnabled, type AppConfig } from './config.js';
import { getDayPnlState } from './day-pnl-state.js';
import type { StrategyLayer } from './strategy-types.js';
import { roundTo } from './utils.js';

export type RuntimeMode = 'simulation' | 'product_test' | 'production';

export interface RuntimeSignalSnapshot {
  readonly timestamp: string;
  readonly marketId: string;
  readonly strategyLayer: StrategyLayer;
  readonly signalType: string;
  readonly action: 'BUY' | 'SELL';
  readonly outcome: 'YES' | 'NO';
  readonly latencyMs: number | null;
}

export interface RuntimeLayerStatusSnapshot {
  readonly layer: StrategyLayer;
  readonly enabled: boolean;
  readonly status: 'ACTIVE' | 'WATCHING' | 'OFF';
  readonly positionCount: number;
  readonly marketCount: number;
  readonly exposureUsd: number;
  readonly pnlUsd: number;
}

export interface RuntimeGlobalExposureSnapshot {
  readonly sniperUsd: number;
  readonly mmUsd: number;
  readonly pairedArbUsd: number;
  readonly lotteryUsd: number;
  readonly obiUsd: number;
  readonly vsUsd: number;
  readonly totalUsd: number;
  readonly maxUsd: number;
}

export interface SkippedSignalRecord {
  readonly timestamp: string;
  readonly marketId: string;
  readonly signalType: string;
  readonly outcome: 'YES' | 'NO';
  readonly filterReason: string;
  readonly ev?: number;
  readonly details: string;
}

export interface RuntimeSlotSnapshot {
  readonly slotLabel: string;
  readonly marketId: string;
  readonly upPnl: number;
  readonly downPnl: number;
  readonly netPnl: number;
  readonly entries: number;
  readonly fills: number;
  readonly reportedAt: string;
}

export interface RuntimeMarketSnapshot {
  readonly marketId: string;
  readonly title: string;
  readonly coin: string | null;
  readonly slotStart: string | null;
  readonly slotEnd: string | null;
  readonly liquidityUsd: number;
  readonly pmUpMid: number | null;
  readonly pmDownMid: number | null;
  readonly combinedDiscount: number | null;
  readonly binanceMovePct: number | null;
  readonly binanceDirection: 'UP' | 'DOWN' | 'FLAT' | null;
  readonly pmDirection: 'UP' | 'DOWN' | 'FLAT';
  readonly action: string;
  readonly signalCount: number;
  readonly updatedAt: string;
}

export interface RuntimePositionSnapshot {
  readonly marketId: string;
  readonly title: string;
  readonly slotStart: string | null;
  readonly slotEnd: string | null;
  readonly dustAbandoned: boolean;
  readonly yesShares: number;
  readonly noShares: number;
  readonly grossExposureShares: number;
  readonly markValueUsd: number;
  readonly unrealizedPnl: number;
  readonly totalPnl: number;
  readonly roiPct: number | null;
  readonly updatedAt: string | null;
}

export interface RuntimeMmQuoteSnapshot {
  readonly marketId: string;
  readonly title: string;
  readonly coin: string | null;
  readonly bidPrice: number | null;
  readonly askPrice: number | null;
  readonly spread: number | null;
  readonly phase: string;
  readonly entryMode: string;
  readonly slotAgeMs: number | null;
  readonly timeToSlotEndMs: number | null;
  readonly blockedBidOutcomes: readonly ('YES' | 'NO')[];
  readonly toxicityFlags: readonly string[];
  readonly sellabilityCliffOutcomes: readonly ('YES' | 'NO')[];
  readonly selectedBidSharesYes: number | null;
  readonly selectedBidSharesNo: number | null;
  readonly yesShares: number;
  readonly noShares: number;
  readonly grossExposureUsd: number;
  readonly netDirectionalShares: number;
}

export interface SniperCoinStatsSnapshot {
  readonly evaluations: number;
  readonly signals: number;
  readonly avgMovePct: number;
  readonly maxMovePct: number;
}

export interface SniperDirectionWindowSnapshot {
  readonly direction: 'UP' | 'DOWN' | null;
  readonly activeCoins: readonly string[];
  readonly capacity: string;
}

export interface SniperStatsSnapshot {
  readonly enabled: boolean;
  readonly signalsGenerated: number;
  readonly signalsExecuted: number;
  readonly rejections: Record<string, number>;
  readonly totalRejections: number;
  readonly lastSignalAt: string | null;
  readonly lastRejection: string | null;
  readonly bestEdgeSeen: number;
  readonly avgBinanceMove: number | null;
  readonly nearMissCount: number;
  readonly coinStats: Record<string, SniperCoinStatsSnapshot>;
  readonly currentDirectionWindow: SniperDirectionWindowSnapshot | null;
}

export interface LotteryStatsSnapshot {
  readonly enabled: boolean;
  readonly totalTickets: number;
  readonly totalHits: number;
  readonly activeEntries: number;
  readonly hitRate: string;
  readonly totalRiskUsdc: number;
  readonly totalPayoutUsdc: number;
}

// ─── OBI Dashboard Stats ──────────────────────────────────────────

export interface ObiGateReasonStats {
  readonly count: number;
  readonly lastSeenAt: string | null;
}

export interface ObiCoinStats {
  readonly coin: string;
  readonly entries: number;
  readonly exits: number;
  readonly blocks: number;
  readonly refusals: number;
  readonly realizedPnl: number;
  readonly lastAction: string | null;
  readonly lastActionAt: string | null;
}

export interface ObiDecisionRecord {
  readonly timestamp: string;
  readonly coin: string | null;
  readonly action: string;
  readonly reason: string;
  readonly detail: string;
}

export interface ObiSessionStats {
  readonly enabled: boolean;
  readonly shadowMode: boolean;
  readonly entries: number;
  readonly exits: number;
  readonly wins: number;
  readonly losses: number;
  readonly redeems: number;
  readonly realizedPnl: number;
  readonly passRate: number;
  readonly gateReasons: Record<string, ObiGateReasonStats>;
  readonly totalGateBlocks: number;
  readonly totalGatePassed: number;
  readonly phase15Accepted: number;
  readonly phase15Refused: number;
  readonly phase15LastRefusal: string | null;
  readonly coinStats: Record<string, ObiCoinStats>;
  readonly recentDecisions: readonly ObiDecisionRecord[];
  readonly drawdownGuardActive: boolean;
  readonly drawdownGuardTriggers: number;
  readonly maxPositionShares: number;
  readonly obiSizeMultiplier: number;
  readonly maxEntryPrice: number;
  readonly cooldownMs: number;
  readonly stopEntryBeforeEndMs: number;
}

// ─── VS Engine Dashboard Stats ───────────────────────────────────

export interface VsCoinStats {
  readonly coin: string;
  readonly entries: number;
  readonly exits: number;
  readonly phase1Entries: number;
  readonly phase2Entries: number;
  readonly realizedPnl: number;
  readonly lastAction: string | null;
  readonly lastActionAt: string | null;
}

export interface VsDecisionRecord {
  readonly timestamp: string;
  readonly coin: string | null;
  readonly action: string;
  readonly phase: string;
  readonly reason: string;
  readonly fairValue: number | null;
}

export interface VsActivePosition {
  readonly coin: string;
  readonly outcome: 'YES' | 'NO';
  readonly shares: number;
  readonly entryVwap: number;
  readonly phase: 'MM' | 'MOMENTUM';
  readonly ageMs: number;
}

export interface VsSessionStats {
  readonly enabled: boolean;
  readonly shadowMode: boolean;
  readonly entries: number;
  readonly exits: number;
  readonly wins: number;
  readonly losses: number;
  readonly realizedPnl: number;
  readonly phase1Entries: number;
  readonly phase1Pnl: number;
  readonly phase2Entries: number;
  readonly phase2Pnl: number;
  readonly coinStats: Record<string, VsCoinStats>;
  readonly recentDecisions: readonly VsDecisionRecord[];
  readonly targetExitPrice: number;
  readonly momentumMaxBuyPrice: number;
  readonly defaultVolatility: number;
  // Phase 45a: two-sided MM + aggressor config & active positions
  readonly aggressorVolFloor: number;
  readonly aggressorMinEdge: number;
  readonly mmTiltMaxCents: number;
  readonly mmSpreadCents: number;
  readonly priceStopCents: number;
  readonly staleCancelThresholdPct: number;
  readonly staleCancels: number;
  readonly activePositions: readonly VsActivePosition[];
  readonly totalSignalsGenerated: number;
}

export interface RuntimeStatusSnapshot {
  readonly updatedAt: string;
  readonly pid: number | null;
  readonly running: boolean;
  readonly mode: RuntimeMode;
  readonly systemStatus: 'OK' | 'PAUSED';
  readonly isPaused: boolean;
  readonly pauseReason: string | null;
  readonly pauseSource: 'manual' | 'incident' | null;
  readonly activeSlotsCount: number;
  readonly openPositionsCount: number;
  readonly latencyPaused: boolean;
  readonly latencyPauseAverageMs: number | null;
  readonly apiCircuitBreakers: {
    readonly clob: CircuitBreakerSnapshot;
    readonly gamma: CircuitBreakerSnapshot;
  };
  readonly portfolioValueUsd: number | null;
  readonly walletCashUsd: number | null;
  readonly availableToTradeUsd: number | null;
  readonly totalDayPnl: number;
  readonly dayDrawdown: number;
  readonly costBasisTracked: number;
  readonly redeemPnlToday: number;
  readonly dustPositionsCount: number;
  readonly dustAbandonedCount: number;
  readonly dustAbandonedKeys: readonly string[];
  readonly blockedExitRemainderShares: number;
  readonly averageLatencyMs: number | null;
  readonly bayesianFvEnabled: boolean;
  readonly bayesianFvAlpha: number;
  readonly activeMarkets: readonly RuntimeMarketSnapshot[];
  readonly openPositions: readonly RuntimePositionSnapshot[];
  readonly strategyLayers: readonly RuntimeLayerStatusSnapshot[];
  readonly globalExposure: RuntimeGlobalExposureSnapshot;
  readonly sniperStats: SniperStatsSnapshot;
  readonly lotteryStats: LotteryStatsSnapshot;
  readonly mmEnabled: boolean;
  readonly mmAutonomousQuotes: boolean;
  readonly mmQuoteShares: number;
  readonly mmMaxQuoteShares: number;
  readonly mmMaxGrossExposure: number;
  readonly mmCurrentExposure: number;
  readonly mmPendingExposure: number;
  readonly mmPendingYesShares: number;
  readonly mmPendingNoShares: number;
  readonly mmActiveMarkets: number;
  readonly mmMaxConcurrentMarkets: number;
  readonly mmSlotWarmupMs: number;
  readonly mmOpeningSeedWindowMs: number;
  readonly mmStopNewEntriesBeforeEndMs: number;
  readonly mmCancelAllQuotesBeforeEndMs: number;
  readonly mmInventorySkew: number;
  readonly mmMaxNetDirectional: number;
  readonly mmQuotes: readonly RuntimeMmQuoteSnapshot[];
  readonly lastSignals: readonly RuntimeSignalSnapshot[];
  readonly recentSkippedSignals: readonly SkippedSignalRecord[];
  readonly lastSlotReport: RuntimeSlotSnapshot | null;
  readonly obiStats: ObiSessionStats | null;
  readonly vsStats: VsSessionStats | null;
  readonly paperStats: PaperTradingStatsSnapshot | null;
}

export interface PaperTradingStatsSnapshot {
  readonly enabled: boolean;
  readonly initialBalance: number;
  readonly currentBalance: number;
  readonly totalPnl: number;
  readonly totalPnlPct: number;
  readonly totalFees: number;
  readonly totalTrades: number;
  readonly totalFills: number;
  readonly totalExpired: number;
  readonly makerFills: number;
  readonly takerFills: number;
  readonly slotsResolved: number;
  readonly winRate: number;
  readonly avgWinUsd: number;
  readonly avgLossUsd: number;
  readonly maxDrawdownUsd: number;
  readonly sharpeRatio: number | null;
  readonly pendingOrders: number;
  readonly openPositions: number;
}

export function resolveRuntimeMode(runtimeConfig: AppConfig = config): RuntimeMode {
  if (runtimeConfig.PRODUCT_TEST_MODE) {
    return 'product_test';
  }

  if (isDryRunMode(runtimeConfig)) {
    return 'simulation';
  }

  return 'production';
}

export function getRuntimeStatusPath(runtimeConfig: AppConfig = config): string {
  return path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, 'runtime-status.json');
}

export function createRuntimeStatusSnapshot(
  overrides: Partial<RuntimeStatusSnapshot> = {},
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot {
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  return {
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    running: false,
    mode: resolveRuntimeMode(runtimeConfig),
    systemStatus: 'OK',
    isPaused: false,
    pauseReason: null,
    pauseSource: null,
    activeSlotsCount: 0,
    openPositionsCount: 0,
    latencyPaused: false,
    latencyPauseAverageMs: null,
    apiCircuitBreakers: {
      clob: createDefaultCircuitBreakerSnapshot('clob'),
      gamma: createDefaultCircuitBreakerSnapshot('gamma'),
    },
    portfolioValueUsd: null,
    walletCashUsd: null,
    availableToTradeUsd: null,
    totalDayPnl: dayState.dayPnl,
    dayDrawdown: dayState.drawdown,
    costBasisTracked: 0,
    redeemPnlToday: 0,
    dustPositionsCount: 0,
    dustAbandonedCount: 0,
    dustAbandonedKeys: [],
    blockedExitRemainderShares: 0,
    averageLatencyMs: null,
    bayesianFvEnabled: runtimeConfig.BAYESIAN_FV_ENABLED,
    bayesianFvAlpha: runtimeConfig.BAYESIAN_FV_ALPHA,
    activeMarkets: [],
    openPositions: [],
    strategyLayers: createDefaultStrategyLayersSnapshot(runtimeConfig),
    globalExposure: createDefaultGlobalExposureSnapshot(runtimeConfig),
    sniperStats: createDefaultSniperStatsSnapshot(runtimeConfig),
    lotteryStats: createDefaultLotteryStatsSnapshot(runtimeConfig),
    mmEnabled: isDynamicQuotingEnabled(runtimeConfig),
    mmAutonomousQuotes: runtimeConfig.MM_AUTONOMOUS_QUOTES,
    mmQuoteShares: runtimeConfig.MM_QUOTE_SHARES,
    mmMaxQuoteShares: runtimeConfig.MM_MAX_QUOTE_SHARES,
    mmMaxGrossExposure: runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD,
    mmCurrentExposure: 0,
    mmPendingExposure: 0,
    mmPendingYesShares: 0,
    mmPendingNoShares: 0,
    mmActiveMarkets: 0,
    mmMaxConcurrentMarkets: runtimeConfig.MM_MAX_CONCURRENT_MARKETS,
    mmSlotWarmupMs: runtimeConfig.MM_SLOT_WARMUP_MS,
    mmOpeningSeedWindowMs: runtimeConfig.MM_OPENING_SEED_WINDOW_MS,
    mmStopNewEntriesBeforeEndMs: runtimeConfig.MM_STOP_NEW_ENTRIES_BEFORE_END_MS,
    mmCancelAllQuotesBeforeEndMs: runtimeConfig.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS,
    mmInventorySkew: runtimeConfig.MM_INVENTORY_SKEW_FACTOR,
    mmMaxNetDirectional: runtimeConfig.MM_MAX_NET_DIRECTIONAL,
    mmQuotes: [],
    lastSignals: [],
    recentSkippedSignals: [],
    lastSlotReport: null,
    obiStats: null,
    vsStats: null,
    paperStats: null,
    ...overrides,
  };
}

export function readRuntimeStatus(
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot | null {
  try {
    const payload = readFileSync(getRuntimeStatusPath(runtimeConfig), 'utf8').trim();
    if (!payload) {
      return null;
    }

    const parsed = JSON.parse(payload) as Partial<RuntimeStatusSnapshot>;
    return normalizeRuntimeStatus(parsed, runtimeConfig);
  } catch {
    return null;
  }
}

export function writeRuntimeStatus(
  overrides: Partial<RuntimeStatusSnapshot>,
  runtimeConfig: AppConfig = config
): RuntimeStatusSnapshot {
  const next = normalizeRuntimeStatus(
    {
      ...(readRuntimeStatus(runtimeConfig) ?? createRuntimeStatusSnapshot({}, runtimeConfig)),
      ...overrides,
      updatedAt: new Date().toISOString(),
    },
    runtimeConfig
  );

  const filePath = getRuntimeStatusPath(runtimeConfig);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function resetRuntimeStatus(runtimeConfig: AppConfig = config): void {
  try {
    rmSync(getRuntimeStatusPath(runtimeConfig), { force: true });
  } catch {
    // ignore reset cleanup failures
  }
}

function normalizeRuntimeStatus(
  value: Partial<RuntimeStatusSnapshot>,
  runtimeConfig: AppConfig
): RuntimeStatusSnapshot {
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  const isPaused = Boolean(value.isPaused);
  const activeMarkets = Array.isArray(value.activeMarkets)
    ? value.activeMarkets
        .map(normalizeRuntimeMarket)
        .filter((entry): entry is RuntimeMarketSnapshot => entry !== null)
        .slice(0, 12)
    : [];
  const openPositions = Array.isArray(value.openPositions)
    ? value.openPositions
        .map(normalizeRuntimePosition)
        .filter((entry): entry is RuntimePositionSnapshot => entry !== null)
        .slice(0, 8)
    : [];
  const strategyLayerDefaults = createDefaultStrategyLayersSnapshot(runtimeConfig);
  const strategyLayerEntries = Array.isArray(value.strategyLayers)
    ? value.strategyLayers
        .map((entry) => normalizeRuntimeLayerStatus(entry, runtimeConfig))
        .filter((entry): entry is RuntimeLayerStatusSnapshot => entry !== null)
    : [];
  const strategyLayers = strategyLayerDefaults.map(
    (fallback) =>
      strategyLayerEntries.find((entry) => entry.layer === fallback.layer) ?? fallback
  );
  const mmQuotes = Array.isArray(value.mmQuotes)
    ? value.mmQuotes
        .map(normalizeRuntimeMmQuote)
        .filter((entry): entry is RuntimeMmQuoteSnapshot => entry !== null)
        .slice(0, 8)
    : [];
  return {
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt.trim()
        ? value.updatedAt
        : new Date().toISOString(),
    pid: typeof value.pid === 'number' && Number.isFinite(value.pid) ? Math.round(value.pid) : null,
    running: Boolean(value.running),
    mode: resolveRuntimeMode(runtimeConfig),
    systemStatus: isPaused ? 'PAUSED' : 'OK',
    isPaused,
    pauseReason: typeof value.pauseReason === 'string' && value.pauseReason.trim() ? value.pauseReason : null,
    pauseSource:
      value.pauseSource === 'manual' || value.pauseSource === 'incident'
        ? value.pauseSource
        : null,
    activeSlotsCount: normalizeCount(value.activeSlotsCount),
    openPositionsCount: Math.max(
      normalizeCount(value.openPositionsCount),
      openPositions.length
    ),
    latencyPaused: Boolean(value.latencyPaused),
    latencyPauseAverageMs: normalizeNullableNumber(value.latencyPauseAverageMs),
    apiCircuitBreakers: normalizeCircuitBreakers(value.apiCircuitBreakers),
    portfolioValueUsd: normalizeNullableNumber(value.portfolioValueUsd),
    walletCashUsd: normalizeNullableNumber(value.walletCashUsd),
    availableToTradeUsd: normalizeNullableNumber(value.availableToTradeUsd),
    totalDayPnl: dayState.dayPnl,
    dayDrawdown: dayState.drawdown,
    costBasisTracked: normalizeCount(value.costBasisTracked),
    redeemPnlToday: normalizeNumber(value.redeemPnlToday, 0),
    dustPositionsCount: normalizeCount(value.dustPositionsCount),
    dustAbandonedCount: normalizeCount(value.dustAbandonedCount),
    dustAbandonedKeys: Array.isArray(value.dustAbandonedKeys)
      ? value.dustAbandonedKeys
          .map((entry) => String(entry ?? '').trim())
          .filter((entry) => entry.length > 0)
          .slice(0, 10)
      : [],
    blockedExitRemainderShares: normalizeNumber(value.blockedExitRemainderShares, 0),
    averageLatencyMs: normalizeNullableNumber(value.averageLatencyMs),
    bayesianFvEnabled:
      typeof value.bayesianFvEnabled === 'boolean'
        ? value.bayesianFvEnabled
        : runtimeConfig.BAYESIAN_FV_ENABLED,
    bayesianFvAlpha: normalizeNumber(value.bayesianFvAlpha, runtimeConfig.BAYESIAN_FV_ALPHA),
    activeMarkets,
    openPositions,
    strategyLayers,
    globalExposure: normalizeGlobalExposure(value.globalExposure, runtimeConfig),
    sniperStats: normalizeSniperStats(value.sniperStats, runtimeConfig),
    lotteryStats: normalizeLotteryStats(value.lotteryStats, runtimeConfig),
    mmEnabled:
      typeof value.mmEnabled === 'boolean'
        ? value.mmEnabled
        : isDynamicQuotingEnabled(runtimeConfig),
    mmAutonomousQuotes:
      typeof value.mmAutonomousQuotes === 'boolean'
        ? value.mmAutonomousQuotes
        : runtimeConfig.MM_AUTONOMOUS_QUOTES,
    mmQuoteShares: normalizeNumber(value.mmQuoteShares, runtimeConfig.MM_QUOTE_SHARES),
    mmMaxQuoteShares: normalizeNumber(value.mmMaxQuoteShares, runtimeConfig.MM_MAX_QUOTE_SHARES),
    mmMaxGrossExposure: normalizeNumber(
      value.mmMaxGrossExposure,
      runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD
    ),
    mmCurrentExposure: normalizeNumber(value.mmCurrentExposure, 0),
    mmPendingExposure: normalizeNumber(value.mmPendingExposure, 0),
    mmPendingYesShares: normalizeNumber(value.mmPendingYesShares, 0),
    mmPendingNoShares: normalizeNumber(value.mmPendingNoShares, 0),
    mmActiveMarkets: normalizeCount(value.mmActiveMarkets),
    mmMaxConcurrentMarkets: Math.max(
      1,
      normalizeCount(value.mmMaxConcurrentMarkets) || runtimeConfig.MM_MAX_CONCURRENT_MARKETS
    ),
    mmSlotWarmupMs: normalizeCount(value.mmSlotWarmupMs) || runtimeConfig.MM_SLOT_WARMUP_MS,
    mmOpeningSeedWindowMs:
      normalizeCount(value.mmOpeningSeedWindowMs) || runtimeConfig.MM_OPENING_SEED_WINDOW_MS,
    mmStopNewEntriesBeforeEndMs:
      normalizeCount(value.mmStopNewEntriesBeforeEndMs) ||
      runtimeConfig.MM_STOP_NEW_ENTRIES_BEFORE_END_MS,
    mmCancelAllQuotesBeforeEndMs:
      normalizeCount(value.mmCancelAllQuotesBeforeEndMs) ||
      runtimeConfig.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS,
    mmInventorySkew: normalizeNumber(
      value.mmInventorySkew,
      runtimeConfig.MM_INVENTORY_SKEW_FACTOR
    ),
    mmMaxNetDirectional: normalizeNumber(
      value.mmMaxNetDirectional,
      runtimeConfig.MM_MAX_NET_DIRECTIONAL
    ),
    mmQuotes,
    lastSignals: Array.isArray(value.lastSignals)
      ? value.lastSignals
          .map(normalizeRuntimeSignal)
          .filter((entry): entry is RuntimeSignalSnapshot => entry !== null)
          .slice(-3)
      : [],
    recentSkippedSignals: Array.isArray(value.recentSkippedSignals)
      ? value.recentSkippedSignals
          .map(normalizeSkippedSignal)
          .filter((entry): entry is SkippedSignalRecord => entry !== null)
          .slice(-8)
      : [],
    lastSlotReport: normalizeRuntimeSlot(value.lastSlotReport),
    obiStats: value.obiStats && typeof value.obiStats === 'object'
      ? (value.obiStats as ObiSessionStats)
      : null,
    vsStats: value.vsStats && typeof value.vsStats === 'object'
      ? (value.vsStats as VsSessionStats)
      : null,
    paperStats: value.paperStats && typeof value.paperStats === 'object'
      ? (value.paperStats as PaperTradingStatsSnapshot)
      : null,
  };
}

function normalizeCircuitBreakers(
  value: unknown
): RuntimeStatusSnapshot['apiCircuitBreakers'] {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    clob: normalizeCircuitBreakerSnapshot(record.clob, 'clob'),
    gamma: normalizeCircuitBreakerSnapshot(record.gamma, 'gamma'),
  };
}

function normalizeCircuitBreakerSnapshot(
  value: unknown,
  name: string
): CircuitBreakerSnapshot {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name
        : name,
    isOpen: Boolean(record.isOpen),
    consecutiveFailures: normalizeCount(record.consecutiveFailures),
    failureThreshold: Math.max(1, normalizeCount(record.failureThreshold) || 5),
    resetTimeoutMs: Math.max(1_000, normalizeCount(record.resetTimeoutMs) || 30_000),
    openedAtMs: normalizeNullableInteger(record.openedAtMs),
    nextAttemptAtMs: normalizeNullableInteger(record.nextAttemptAtMs),
  };
}

function createDefaultCircuitBreakerSnapshot(name: string): CircuitBreakerSnapshot {
  return {
    name,
    isOpen: false,
    consecutiveFailures: 0,
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    openedAtMs: null,
    nextAttemptAtMs: null,
  };
}

function createDefaultSniperStatsSnapshot(
  runtimeConfig: AppConfig
): SniperStatsSnapshot {
  return {
    enabled: runtimeConfig.SNIPER_MODE_ENABLED,
    signalsGenerated: 0,
    signalsExecuted: 0,
    rejections: {},
    totalRejections: 0,
    lastSignalAt: null,
    lastRejection: null,
    bestEdgeSeen: 0,
    avgBinanceMove: null,
    nearMissCount: 0,
    coinStats: {},
    currentDirectionWindow: null,
  };
}

function createDefaultLotteryStatsSnapshot(
  runtimeConfig: AppConfig
): LotteryStatsSnapshot {
  return {
    enabled: runtimeConfig.lottery.enabled,
    totalTickets: 0,
    totalHits: 0,
    activeEntries: 0,
    hitRate: '0.0%',
    totalRiskUsdc: 0,
    totalPayoutUsdc: 0,
  };
}

function createDefaultStrategyLayersSnapshot(
  runtimeConfig: AppConfig
): RuntimeLayerStatusSnapshot[] {
  return [
    {
      layer: 'SNIPER',
      enabled: runtimeConfig.SNIPER_MODE_ENABLED,
      status: runtimeConfig.SNIPER_MODE_ENABLED ? 'WATCHING' : 'OFF',
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
    {
      layer: 'MM_QUOTE',
      enabled: runtimeConfig.MARKET_MAKER_MODE && isDynamicQuotingEnabled(runtimeConfig),
      status:
        runtimeConfig.MARKET_MAKER_MODE && isDynamicQuotingEnabled(runtimeConfig)
          ? 'WATCHING'
          : 'OFF',
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
    {
      layer: 'PAIRED_ARB',
      enabled: runtimeConfig.PAIRED_ARB_ENABLED,
      status: runtimeConfig.PAIRED_ARB_ENABLED ? 'WATCHING' : 'OFF',
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
    {
      layer: 'LOTTERY',
      enabled: runtimeConfig.lottery.enabled,
      status: runtimeConfig.lottery.enabled ? 'WATCHING' : 'OFF',
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
    {
      layer: 'OBI',
      enabled: runtimeConfig.obiEngine.enabled,
      status: runtimeConfig.obiEngine.enabled
        ? runtimeConfig.obiEngine.shadowMode
          ? 'WATCHING'
          : 'ACTIVE'
        : 'OFF',
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
    {
      layer: 'VS_ENGINE',
      enabled: runtimeConfig.vsEngine.enabled,
      status: (() => {
        if (!runtimeConfig.vsEngine.enabled) return 'OFF' as const;
        return runtimeConfig.vsEngine.shadowMode ? 'WATCHING' as const : 'ACTIVE' as const;
      })(),
      positionCount: 0,
      marketCount: 0,
      exposureUsd: 0,
      pnlUsd: 0,
    },
  ];
}

function createDefaultGlobalExposureSnapshot(
  runtimeConfig: AppConfig
): RuntimeGlobalExposureSnapshot {
  return {
    sniperUsd: 0,
    mmUsd: 0,
    pairedArbUsd: 0,
    lotteryUsd: 0,
    obiUsd: 0,
    vsUsd: 0,
    totalUsd: 0,
    maxUsd: runtimeConfig.GLOBAL_MAX_EXPOSURE_USD,
  };
}

function normalizeSniperStats(
  value: unknown,
  runtimeConfig: AppConfig
): SniperStatsSnapshot {
  if (!value || typeof value !== 'object') {
    return createDefaultSniperStatsSnapshot(runtimeConfig);
  }

  const record = value as Partial<SniperStatsSnapshot> & {
    coinStats?: Record<string, Partial<SniperCoinStatsSnapshot>>;
  };
  const rejections: Record<string, number> = {};
  if (record.rejections && typeof record.rejections === 'object') {
    for (const [reason, count] of Object.entries(record.rejections)) {
      const normalized = normalizeCount(count);
      if (reason.trim() && normalized > 0) {
        rejections[reason] = normalized;
      }
    }
  }

  const coinStats: Record<string, SniperCoinStatsSnapshot> = {};
  if (record.coinStats && typeof record.coinStats === 'object') {
    for (const [coin, stats] of Object.entries(record.coinStats)) {
      if (!coin.trim() || !stats || typeof stats !== 'object') {
        continue;
      }

      coinStats[coin] = {
        evaluations: normalizeCount(stats.evaluations),
        signals: normalizeCount(stats.signals),
        avgMovePct: normalizeNumber(stats.avgMovePct, 0),
        maxMovePct: normalizeNumber(stats.maxMovePct, 0),
      };
    }
  }

  const computedTotalRejections = Object.values(rejections).reduce((sum, count) => sum + count, 0);
  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : runtimeConfig.SNIPER_MODE_ENABLED,
    signalsGenerated: normalizeCount(record.signalsGenerated),
    signalsExecuted: normalizeCount(record.signalsExecuted),
    rejections,
    totalRejections: Math.max(
      normalizeCount(record.totalRejections),
      computedTotalRejections
    ),
    lastSignalAt:
      typeof record.lastSignalAt === 'string' && record.lastSignalAt.trim()
        ? record.lastSignalAt
        : null,
    lastRejection:
      typeof record.lastRejection === 'string' && record.lastRejection.trim()
        ? record.lastRejection
        : null,
    bestEdgeSeen: normalizeNumber(record.bestEdgeSeen, 0),
    avgBinanceMove:
      record.avgBinanceMove === null || record.avgBinanceMove === undefined
        ? null
        : normalizeNumber(record.avgBinanceMove, 0),
    nearMissCount: normalizeCount(record.nearMissCount),
    coinStats,
    currentDirectionWindow: normalizeSniperDirectionWindow(record.currentDirectionWindow),
  };
}

function normalizeLotteryStats(
  value: unknown,
  runtimeConfig: AppConfig
): LotteryStatsSnapshot {
  if (!value || typeof value !== 'object') {
    return createDefaultLotteryStatsSnapshot(runtimeConfig);
  }

  const record = value as Partial<LotteryStatsSnapshot>;
  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : runtimeConfig.lottery.enabled,
    totalTickets: normalizeCount(record.totalTickets),
    totalHits: normalizeCount(record.totalHits),
    activeEntries: normalizeCount(record.activeEntries),
    hitRate:
      typeof record.hitRate === 'string' && record.hitRate.trim()
        ? record.hitRate
        : '0.0%',
    totalRiskUsdc: normalizeNumber(record.totalRiskUsdc, 0),
    totalPayoutUsdc: normalizeNumber(record.totalPayoutUsdc, 0),
  };
}

function normalizeSniperDirectionWindow(
  value: unknown
): SniperDirectionWindowSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<SniperDirectionWindowSnapshot>;
  const activeCoins = Array.isArray(record.activeCoins)
    ? record.activeCoins
        .map((coin) => String(coin ?? '').trim().toUpperCase())
        .filter((coin) => coin.length > 0)
        .slice(0, 8)
    : [];
  const direction =
    record.direction === 'UP' || record.direction === 'DOWN' ? record.direction : null;
  const capacity =
    typeof record.capacity === 'string' && record.capacity.trim()
      ? record.capacity
      : `${activeCoins.length}/${activeCoins.length}`;

  if (!direction && activeCoins.length === 0 && !capacity.trim()) {
    return null;
  }

  return {
    direction,
    activeCoins,
    capacity,
  };
}

function normalizeRuntimeSignal(value: unknown): RuntimeSignalSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeSignalSnapshot>;
  const strategyLayer =
    record.strategyLayer === 'SNIPER' ||
    record.strategyLayer === 'MM_QUOTE' ||
    record.strategyLayer === 'PAIRED_ARB' ||
    record.strategyLayer === 'LOTTERY'
      ? record.strategyLayer
      : null;
  const action = record.action === 'BUY' || record.action === 'SELL' ? record.action : null;
  const outcome = record.outcome === 'YES' || record.outcome === 'NO' ? record.outcome : null;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
  const marketId = typeof record.marketId === 'string' ? record.marketId : '';
  const signalType = typeof record.signalType === 'string' ? record.signalType : '';

  if (!strategyLayer || !action || !outcome || !timestamp || !marketId || !signalType) {
    return null;
  }

  return {
    timestamp,
    marketId,
    strategyLayer,
    signalType,
    action,
    outcome,
    latencyMs: normalizeNullableNumber(record.latencyMs),
  };
}

function normalizeRuntimeLayerStatus(
  value: unknown,
  runtimeConfig: AppConfig
): RuntimeLayerStatusSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeLayerStatusSnapshot>;
  const layer =
    record.layer === 'SNIPER' ||
    record.layer === 'MM_QUOTE' ||
    record.layer === 'PAIRED_ARB' ||
    record.layer === 'LOTTERY'
      ? record.layer
      : null;
  const fallback = createDefaultStrategyLayersSnapshot(runtimeConfig).find(
    (entry) => entry.layer === layer
  );
  if (!layer || !fallback) {
    return null;
  }

  return {
    layer,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    status:
      record.status === 'ACTIVE' || record.status === 'WATCHING' || record.status === 'OFF'
        ? record.status
        : fallback.status,
    positionCount: normalizeCount(record.positionCount),
    marketCount: normalizeCount(record.marketCount),
    exposureUsd: normalizeNumber(record.exposureUsd, 0),
    pnlUsd: normalizeNumber(record.pnlUsd, 0),
  };
}

function normalizeGlobalExposure(
  value: unknown,
  runtimeConfig: AppConfig
): RuntimeGlobalExposureSnapshot {
  if (!value || typeof value !== 'object') {
    return createDefaultGlobalExposureSnapshot(runtimeConfig);
  }

  const record = value as Partial<RuntimeGlobalExposureSnapshot>;
  return {
    sniperUsd: normalizeNumber(record.sniperUsd, 0),
    mmUsd: normalizeNumber(record.mmUsd, 0),
    pairedArbUsd: normalizeNumber(record.pairedArbUsd, 0),
    lotteryUsd: normalizeNumber(record.lotteryUsd, 0),
    obiUsd: normalizeNumber(record.obiUsd, 0),
    vsUsd: normalizeNumber(record.vsUsd, 0),
    totalUsd: normalizeNumber(record.totalUsd, 0),
    maxUsd: normalizeNumber(record.maxUsd, runtimeConfig.GLOBAL_MAX_EXPOSURE_USD),
  };
}

function normalizeRuntimeSlot(value: unknown): RuntimeSlotSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeSlotSnapshot>;
  if (
    typeof record.slotLabel !== 'string' ||
    typeof record.marketId !== 'string' ||
    typeof record.reportedAt !== 'string'
  ) {
    return null;
  }

  return {
    slotLabel: record.slotLabel,
    marketId: record.marketId,
    upPnl: normalizeNumber(record.upPnl, 0),
    downPnl: normalizeNumber(record.downPnl, 0),
    netPnl: normalizeNumber(record.netPnl, 0),
    entries: normalizeCount(record.entries),
    fills: normalizeCount(record.fills),
    reportedAt: record.reportedAt,
  };
}

function normalizeSkippedSignal(value: unknown): SkippedSignalRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<SkippedSignalRecord>;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
  const marketId = typeof record.marketId === 'string' ? record.marketId : '';
  const signalType = typeof record.signalType === 'string' ? record.signalType : '';
  const outcome = record.outcome === 'YES' || record.outcome === 'NO' ? record.outcome : null;
  const filterReason =
    typeof record.filterReason === 'string' && record.filterReason.trim()
      ? record.filterReason
      : '';
  const details = typeof record.details === 'string' ? record.details : '';

  if (!timestamp || !marketId || !signalType || !outcome || !filterReason) {
    return null;
  }

  return {
    timestamp,
    marketId,
    signalType,
    outcome,
    filterReason,
    ev: normalizeNullableNumber(record.ev) ?? undefined,
    details,
  };
}

function normalizeRuntimeMarket(value: unknown): RuntimeMarketSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeMarketSnapshot>;
  if (typeof record.marketId !== 'string' || typeof record.title !== 'string') {
    return null;
  }

  return {
    marketId: record.marketId,
    title: record.title,
    coin: typeof record.coin === 'string' && record.coin.trim() ? record.coin.trim() : null,
    slotStart: typeof record.slotStart === 'string' && record.slotStart.trim() ? record.slotStart : null,
    slotEnd: typeof record.slotEnd === 'string' && record.slotEnd.trim() ? record.slotEnd : null,
    liquidityUsd: normalizeNumber(record.liquidityUsd, 0),
    pmUpMid: normalizeNullableNumber(record.pmUpMid),
    pmDownMid: normalizeNullableNumber(record.pmDownMid),
    combinedDiscount: normalizeNullableNumber(record.combinedDiscount),
    binanceMovePct: normalizeNullableNumber(record.binanceMovePct),
    binanceDirection:
      record.binanceDirection === 'UP' ||
      record.binanceDirection === 'DOWN' ||
      record.binanceDirection === 'FLAT'
        ? record.binanceDirection
        : null,
    pmDirection:
      record.pmDirection === 'UP' || record.pmDirection === 'DOWN' || record.pmDirection === 'FLAT'
        ? record.pmDirection
        : 'FLAT',
    action: typeof record.action === 'string' && record.action.trim() ? record.action : 'SCAN',
    signalCount: normalizeCount(record.signalCount),
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt.trim()
        ? record.updatedAt
        : new Date().toISOString(),
  };
}

function normalizeRuntimePosition(value: unknown): RuntimePositionSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimePositionSnapshot>;
  if (typeof record.marketId !== 'string' || typeof record.title !== 'string') {
    return null;
  }

  return {
    marketId: record.marketId,
    title: record.title,
    slotStart: typeof record.slotStart === 'string' && record.slotStart.trim() ? record.slotStart : null,
    slotEnd: typeof record.slotEnd === 'string' && record.slotEnd.trim() ? record.slotEnd : null,
    dustAbandoned: Boolean(record.dustAbandoned),
    yesShares: normalizeNumber(record.yesShares, 0),
    noShares: normalizeNumber(record.noShares, 0),
    grossExposureShares: normalizeNumber(record.grossExposureShares, 0),
    markValueUsd: normalizeNumber(record.markValueUsd, 0),
    unrealizedPnl: normalizeNumber(record.unrealizedPnl, 0),
    totalPnl: normalizeNumber(record.totalPnl, 0),
    roiPct: normalizeNullableNumber(record.roiPct),
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt : null,
  };
}

function normalizeRuntimeMmQuote(value: unknown): RuntimeMmQuoteSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<RuntimeMmQuoteSnapshot>;
  if (typeof record.marketId !== 'string' || typeof record.title !== 'string') {
    return null;
  }

  return {
    marketId: record.marketId,
    title: record.title,
    coin: typeof record.coin === 'string' && record.coin.trim() ? record.coin.trim() : null,
    bidPrice: normalizeNullablePrice(record.bidPrice),
    askPrice: normalizeNullablePrice(record.askPrice),
    spread: normalizeNullablePrice(record.spread),
    phase: typeof record.phase === 'string' && record.phase.trim() ? record.phase : 'UNKNOWN',
    entryMode:
      typeof record.entryMode === 'string' && record.entryMode.trim() ? record.entryMode : 'OFF',
    slotAgeMs: normalizeNullableNumber(record.slotAgeMs),
    timeToSlotEndMs: normalizeNullableNumber(record.timeToSlotEndMs),
    blockedBidOutcomes: Array.isArray(record.blockedBidOutcomes)
      ? record.blockedBidOutcomes
          .map((entry) => (entry === 'YES' || entry === 'NO' ? entry : null))
          .filter((entry): entry is 'YES' | 'NO' => entry !== null)
          .slice(0, 2)
      : [],
    toxicityFlags: Array.isArray(record.toxicityFlags)
      ? record.toxicityFlags
          .map((entry) => String(entry ?? '').trim())
          .filter((entry) => entry.length > 0)
          .slice(0, 6)
      : [],
    sellabilityCliffOutcomes: Array.isArray(record.sellabilityCliffOutcomes)
      ? record.sellabilityCliffOutcomes
          .map((entry) => (entry === 'YES' || entry === 'NO' ? entry : null))
          .filter((entry): entry is 'YES' | 'NO' => entry !== null)
          .slice(0, 2)
      : [],
    selectedBidSharesYes: normalizeNullableNumber(record.selectedBidSharesYes),
    selectedBidSharesNo: normalizeNullableNumber(record.selectedBidSharesNo),
    yesShares: normalizeNumber(record.yesShares, 0),
    noShares: normalizeNumber(record.noShares, 0),
    grossExposureUsd: normalizeNumber(record.grossExposureUsd, 0),
    netDirectionalShares: normalizeNumber(record.netDirectionalShares, 0),
  };
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTo(value, 4);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return roundTo(parsed, 4);
    }
  }

  return roundTo(fallback, 4);
}

function normalizeNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTo(value, 2);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundTo(parsed, 2) : null;
  }

  return null;
}

function normalizeNullablePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTo(value, 4);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundTo(parsed, 4) : null;
  }

  return null;
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  return 0;
}

function normalizeNullableInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
