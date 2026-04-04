import {
  config,
  isDeepBinanceEnabled,
  isDynamicQuotingEnabled,
  type AppConfig,
} from './config.js';
import type { BinanceEdgeAssessment } from './binance-edge.js';
import {
  getDynamicSpreadTicks,
  shouldBlockSignalByBinanceSpread,
  type DeepBinanceAssessment,
} from './binance-deep-integration.js';
import type {
  MarketOrderbookSnapshot,
  Outcome,
  TokenBookSnapshot,
} from './clob-fetcher.js';
import { getTakerFee } from './ev-kelly.js';
import { logger } from './logger.js';
import { getSlotKey, type MarketCandidate } from './monitor.js';
import { resolveMinimumTradableShares } from './paired-arbitrage.js';
import type { PositionManager } from './position-manager.js';
import type { RiskAssessment } from './risk-manager.js';
import {
  estimateFairValue,
  type FairValueBinanceAdjustment,
} from './signal-scalper.js';
import {
  isQuotingSignalType,
  resolveStrategyLayer,
  type SignalType,
  type StrategyLayer,
  type StrategySignal,
} from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface QuoteContext {
  readonly market: MarketCandidate;
  readonly orderbook: MarketOrderbookSnapshot;
  readonly positionManager: PositionManager;
  readonly riskAssessment: RiskAssessment;
  readonly quoteSignals: readonly StrategySignal[];
  readonly allowEntryQuotes?: boolean;
  readonly pendingQuoteExposure?: PendingQuoteExposureSnapshot;
  readonly binanceAssessment?: BinanceEdgeAssessment;
  readonly binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  readonly deepBinanceAssessment?: DeepBinanceAssessment;
  readonly activationTrigger?: QuoteActivationTrigger;
}

export interface QuoteActivationTrigger {
  readonly triggerLayer: StrategyLayer;
  readonly entryOutcome: Outcome;
  readonly entryPrice: number;
  readonly entryShares: number;
  readonly activatedAtMs: number;
}

export interface PendingQuoteExposureSnapshot {
  readonly yesShares: number;
  readonly noShares: number;
  readonly grossExposureUsd: number;
}

export interface ActiveQuoteOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly outcome: Outcome;
  readonly action: StrategySignal['action'];
  readonly signalType: SignalType;
  readonly targetPrice: number | null;
  readonly shares: number;
  readonly urgency: StrategySignal['urgency'];
  readonly placedAtMs: number;
}

export interface QuoteRefreshPlan {
  readonly marketId: string;
  readonly slotKey: string;
  readonly activeQuoteOrders: readonly ActiveQuoteOrder[];
  readonly signals: readonly StrategySignal[];
  readonly mmDiagnostics: MmMarketDiagnostics | null;
  readonly mmBehaviorState: MmBehaviorState | null;
}

export type MmQuotePhase =
  | 'PRE_OPEN'
  | 'WARMUP'
  | 'OPENING_SEED'
  | 'NORMAL'
  | 'LATE_ASK_ONLY'
  | 'FINAL_CANCEL'
  | 'UNKNOWN';

export type MmEntryMode = 'OFF' | 'ASK_ONLY' | 'ONE_SIDED' | 'NORMAL';

export interface MmMarketDiagnostics {
  readonly phase: MmQuotePhase;
  readonly entryMode: MmEntryMode;
  readonly slotAgeMs: number | null;
  readonly timeToSlotEndMs: number | null;
  readonly directionalMovePct: number | null;
  readonly yesMicropriceBiasTicks: number | null;
  readonly noMicropriceBiasTicks: number | null;
  readonly blockedBidOutcomes: readonly Outcome[];
  readonly toxicityFlags: readonly string[];
  readonly sellabilityCliffOutcomes: readonly Outcome[];
  readonly selectedBidSharesYes: number | null;
  readonly selectedBidSharesNo: number | null;
}

export interface MmBehaviorState {
  readonly globalBidBlockUntilMs: number | null;
  readonly toxicBidBlockUntilMs: Readonly<Partial<Record<Outcome, number>>>;
  readonly sameSideBidBlockUntilMs: Readonly<Partial<Record<Outcome, number>>>;
  readonly lastAskOnlyBidBlockAtMs: number | null;
}

interface MarketMakerQuoteBuildResult {
  readonly signals: readonly StrategySignal[];
  readonly mmDiagnostics: MmMarketDiagnostics | null;
  readonly mmBehaviorState: MmBehaviorState | null;
}

interface AutonomousMmAssessment {
  readonly phase: MmQuotePhase;
  readonly slotAgeMs: number | null;
  readonly timeToSlotEndMs: number | null;
  readonly directionalMovePct: number | null;
  readonly yesMicropriceBiasTicks: number | null;
  readonly noMicropriceBiasTicks: number | null;
  readonly blockedBidOutcomes: readonly Outcome[];
  readonly toxicityFlags: readonly string[];
  readonly allowBidQuotes: boolean;
  readonly allowAskQuotes: boolean;
  readonly entryMode: MmEntryMode;
  readonly postSniperGraceActive: boolean;
  readonly mmBehaviorState: MmBehaviorState;
}

export function buildQuoteRefreshPlan(params: {
  context: QuoteContext;
  activeQuoteOrders?: readonly ActiveQuoteOrder[];
  runtimeConfig?: AppConfig;
  currentMMExposureUsd?: number;
  behaviorState?: MmBehaviorState;
  now?: Date;
}): QuoteRefreshPlan {
  const runtimeConfig = params.runtimeConfig ?? config;
  const activeQuoteOrders = [...(params.activeQuoteOrders ?? [])];
  const quoteBuild = isDynamicQuotingEnabled(runtimeConfig)
    ? buildMarketMakerQuoteSignals({
        ...params,
        runtimeConfig,
        activeQuoteOrders,
        currentMMExposureUsd: params.currentMMExposureUsd,
        behaviorState: params.behaviorState,
      })
    : { signals: [], mmDiagnostics: null, mmBehaviorState: null };

  return {
    marketId: params.context.market.marketId,
    slotKey: getSlotKey(params.context.market),
    activeQuoteOrders,
    signals: quoteBuild.signals,
    mmDiagnostics: quoteBuild.mmDiagnostics,
    mmBehaviorState: quoteBuild.mmBehaviorState,
  };
}

export function buildMarketMakerQuoteSignals(params: {
  context: QuoteContext;
  activeQuoteOrders?: readonly ActiveQuoteOrder[];
  runtimeConfig?: AppConfig;
  currentMMExposureUsd?: number;
  behaviorState?: MmBehaviorState;
  now?: Date;
}): MarketMakerQuoteBuildResult {
  const runtimeConfig = params.runtimeConfig ?? config;
  if (!isDynamicQuotingEnabled(runtimeConfig)) {
    return {
      signals: [],
      mmDiagnostics: null,
      mmBehaviorState: null,
    };
  }

  const now = params.now ?? new Date();
  const builtSignals: StrategySignal[] = [];
  const quoteSpreadTicks = resolveQuoteSpreadTicks(
    runtimeConfig,
    params.context.deepBinanceAssessment
  );
  const snapshot = params.context.positionManager.getSnapshot();
  const imbalancePercent = resolveInventoryImbalancePercent(snapshot);
  const overweightOutcome =
    imbalancePercent > runtimeConfig.MAX_IMBALANCE_PERCENT
      ? snapshot.inventoryImbalance > 0
        ? 'YES'
      : snapshot.inventoryImbalance < 0
          ? 'NO'
          : null
      : null;
  const autonomousAssessment = assessAutonomousMmContext({
    context: params.context,
    runtimeConfig,
    behaviorState: params.behaviorState,
    now,
  });
  let mmDiagnostics = createMmDiagnosticsSnapshot(autonomousAssessment);

  const postSniperResult = generatePostSniperAskSignals({
      context: params.context,
      runtimeConfig,
      quoteSpreadTicks,
      mmDiagnostics,
      now,
    });
  mmDiagnostics = postSniperResult.diagnostics;
  builtSignals.push(...postSniperResult.signals);

  if (
    runtimeConfig.MM_AUTONOMOUS_QUOTES &&
    (params.context.quoteSignals.length === 0 || runtimeConfig.MM_ALWAYS_QUOTE)
  ) {
    const autonomousResult = generateAutonomousQuoteSignals({
        context: params.context,
        activeQuoteOrders: params.activeQuoteOrders ?? [],
        runtimeConfig,
        quoteSpreadTicks,
        currentMMExposureUsd: params.currentMMExposureUsd ?? 0,
        assessment: autonomousAssessment,
        behaviorState: autonomousAssessment.mmBehaviorState,
        diagnostics: mmDiagnostics,
        now,
      });
    mmDiagnostics = autonomousResult.diagnostics;
    builtSignals.push(...autonomousResult.signals);
  }

  for (const signal of params.context.quoteSignals) {
    if (!isQuotingSignalType(signal.signalType)) {
      continue;
    }

    if (signal.signalType === 'INVENTORY_REBALANCE_QUOTE') {
      const rebalanceQuote = buildReduceOnlyQuoteSignal({
        market: params.context.market,
        orderbook: params.context.orderbook,
        template: signal,
        runtimeConfig,
        binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
        deepBinanceAssessment: params.context.deepBinanceAssessment,
        quoteSpreadTicks,
        now,
      });
      if (rebalanceQuote) {
        builtSignals.push(rebalanceQuote);
      }
      continue;
    }

    if (signal.reduceOnly || signal.action === 'SELL') {
      const reduceOnlyQuote = buildReduceOnlyQuoteSignal({
        market: params.context.market,
        orderbook: params.context.orderbook,
        template: signal,
        runtimeConfig,
        binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
        deepBinanceAssessment: params.context.deepBinanceAssessment,
        quoteSpreadTicks,
        now,
      });
      if (reduceOnlyQuote) {
        builtSignals.push(reduceOnlyQuote);
      }
      continue;
    }

    if (params.context.allowEntryQuotes === false) {
      logger.debug('MM quote skipped', {
        marketId: params.context.market.marketId,
        reason: 'concurrent_limit',
        details: {
          signalType: signal.signalType,
          outcome: signal.outcome,
        },
      });
      continue;
    }

    if (
      params.context.riskAssessment.blockedOutcomes.has(signal.outcome) ||
      overweightOutcome === signal.outcome
    ) {
      continue;
    }

    const entryQuote = buildEntryQuoteSignal({
      market: params.context.market,
      orderbook: params.context.orderbook,
      template: signal,
      runtimeConfig,
      binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
      deepBinanceAssessment: params.context.deepBinanceAssessment,
      quoteSpreadTicks,
      now,
    });
    if (entryQuote) {
      builtSignals.push(entryQuote);
    }

    const oppositeOutcome = getOppositeOutcome(signal.outcome);
    const oppositeShares = params.context.positionManager.getShares(oppositeOutcome);
    if (oppositeShares <= 0) {
      continue;
    }

    const oppositeQuote = buildReduceOnlyQuoteSignal({
      market: params.context.market,
      orderbook: params.context.orderbook,
      template: {
        ...signal,
        action: 'SELL',
        outcome: oppositeOutcome,
        outcomeIndex: oppositeOutcome === 'YES' ? 0 : 1,
        shares: Math.min(signal.shares, oppositeShares),
        reduceOnly: true,
        reason: `${signal.reason} | Opposite-side inventory quote`,
      },
      runtimeConfig,
      binanceFairValueAdjustment: params.context.binanceFairValueAdjustment,
      deepBinanceAssessment: params.context.deepBinanceAssessment,
      quoteSpreadTicks,
      now,
    });
    if (oppositeQuote) {
      builtSignals.push(oppositeQuote);
    }
  }

  return {
    signals: mergeQuoteSignals(builtSignals),
    mmDiagnostics,
    mmBehaviorState: autonomousAssessment.mmBehaviorState,
  };
}

/**
 * Generates autonomous dual-sided quote signals for market making.
 * Bids can be suppressed by inventory, gross exposure, or concurrent-market
 * limits, while asks remain available to reduce existing inventory.
 */
function createMmDiagnosticsSnapshot(
  assessment: AutonomousMmAssessment
): MmMarketDiagnostics {
  return {
    phase: assessment.phase,
    entryMode: assessment.entryMode,
    slotAgeMs: assessment.slotAgeMs,
    timeToSlotEndMs: assessment.timeToSlotEndMs,
    directionalMovePct: assessment.directionalMovePct,
    yesMicropriceBiasTicks: assessment.yesMicropriceBiasTicks,
    noMicropriceBiasTicks: assessment.noMicropriceBiasTicks,
    blockedBidOutcomes: [...assessment.blockedBidOutcomes],
    toxicityFlags: [...assessment.toxicityFlags],
    sellabilityCliffOutcomes: [],
    selectedBidSharesYes: null,
    selectedBidSharesNo: null,
  };
}

function normalizeMmBehaviorState(
  state?: MmBehaviorState | null,
  nowMs?: number
): MmBehaviorState {
  return {
    globalBidBlockUntilMs:
      state?.globalBidBlockUntilMs !== null &&
      state?.globalBidBlockUntilMs !== undefined &&
      (nowMs === undefined || state.globalBidBlockUntilMs > nowMs)
        ? state.globalBidBlockUntilMs
        : null,
    toxicBidBlockUntilMs: pruneExpiredOutcomeBlockMap(state?.toxicBidBlockUntilMs, nowMs),
    sameSideBidBlockUntilMs: pruneExpiredOutcomeBlockMap(
      state?.sameSideBidBlockUntilMs,
      nowMs
    ),
    lastAskOnlyBidBlockAtMs:
      state?.lastAskOnlyBidBlockAtMs !== null &&
      state?.lastAskOnlyBidBlockAtMs !== undefined &&
      Number.isFinite(state.lastAskOnlyBidBlockAtMs)
        ? state.lastAskOnlyBidBlockAtMs
        : null,
  };
}

function pruneExpiredOutcomeBlockMap(
  map?: Readonly<Partial<Record<Outcome, number>>>,
  nowMs?: number
): Partial<Record<Outcome, number>> {
  const next: Partial<Record<Outcome, number>> = {};
  for (const outcome of ['YES', 'NO'] as const satisfies readonly Outcome[]) {
    const untilMs = map?.[outcome];
    if (
      untilMs !== undefined &&
      Number.isFinite(untilMs) &&
      (nowMs === undefined || untilMs > nowMs)
    ) {
      next[outcome] = untilMs;
    }
  }
  return next;
}

function resolveMicropriceToxicFlag(outcome: Outcome, biasTicks: number): string {
  return `${outcome.toLowerCase()}_microprice_${biasTicks > 0 ? 'up' : 'down'}_${Math.abs(
    biasTicks
  ).toFixed(2)}t`;
}

function assessAutonomousMmContext(params: {
  context: QuoteContext;
  runtimeConfig: AppConfig;
  behaviorState?: MmBehaviorState;
  now: Date;
}): AutonomousMmAssessment {
  const slotState = resolveMmSlotState({
    market: params.context.market,
    runtimeConfig: params.runtimeConfig,
    now: params.now,
  });
  const nowMs = params.now.getTime();
  const previousBehaviorState = normalizeMmBehaviorState(params.behaviorState, nowMs);
  const postSniperGraceActive = isPostSniperMmGraceWindowActive({
    activationTrigger: params.context.activationTrigger,
    runtimeConfig: params.runtimeConfig,
    now: params.now,
  });
  const toxicityFlags: string[] = [];
  const blockedBidOutcomes = new Set<Outcome>();
  let globalBidBlockUntilMs = previousBehaviorState.globalBidBlockUntilMs;
  let lastAskOnlyBidBlockAtMs = previousBehaviorState.lastAskOnlyBidBlockAtMs;
  const toxicBidBlockUntilMs = {
    ...previousBehaviorState.toxicBidBlockUntilMs,
  };
  const binanceAssessment = params.context.binanceAssessment;
  const directionalMovePct =
    binanceAssessment?.available === true
      ? roundTo(Math.abs(binanceAssessment.binanceMovePct), 6)
      : null;
  const hasDirectionalBias =
    directionalMovePct !== null && binanceAssessment?.direction !== 'FLAT';
  const rawBinanceToxic =
    !postSniperGraceActive &&
    hasDirectionalBias &&
    directionalMovePct >= params.runtimeConfig.MM_TOXIC_FLOW_BLOCK_MOVE_PCT;
  const directionalHoldShouldExtend =
    !postSniperGraceActive &&
    hasDirectionalBias &&
    directionalMovePct > params.runtimeConfig.MM_TOXIC_FLOW_CLEAR_MOVE_PCT;

  if (rawBinanceToxic) {
    globalBidBlockUntilMs = Math.max(
      globalBidBlockUntilMs ?? 0,
      nowMs + params.runtimeConfig.MM_TOXIC_FLOW_HOLD_MS
    );
    toxicityFlags.push(
      `binance_${String(binanceAssessment?.direction ?? 'flat').toLowerCase()}_${directionalMovePct.toFixed(4)}`
    );
  } else if (postSniperGraceActive) {
    toxicityFlags.push('post_sniper_grace');
  } else if (globalBidBlockUntilMs !== null && globalBidBlockUntilMs > nowMs) {
    if (directionalHoldShouldExtend) {
      globalBidBlockUntilMs = Math.max(
        globalBidBlockUntilMs,
        nowMs + params.runtimeConfig.MM_TOXIC_FLOW_HOLD_MS
      );
    }
    toxicityFlags.push('binance_hold');
  } else {
    globalBidBlockUntilMs = null;
  }

  const yesMicropriceBiasTicks = resolveMicropriceBiasTicks(params.context.orderbook.yes);
  const noMicropriceBiasTicks = resolveMicropriceBiasTicks(params.context.orderbook.no);
  for (const [outcome, biasTicks] of [
    ['YES', yesMicropriceBiasTicks],
    ['NO', noMicropriceBiasTicks],
  ] as const) {
    const previousHoldUntilMs = toxicBidBlockUntilMs[outcome];
    const rawMicropriceToxic =
      biasTicks !== null &&
      Math.abs(biasTicks) >= params.runtimeConfig.MM_TOXIC_FLOW_MICROPRICE_TICKS;
    const micropriceHoldShouldExtend =
      biasTicks !== null &&
      Math.abs(biasTicks) > params.runtimeConfig.MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS;

    if (rawMicropriceToxic) {
      toxicBidBlockUntilMs[outcome] = Math.max(
        previousHoldUntilMs ?? 0,
        nowMs + params.runtimeConfig.MM_TOXIC_FLOW_HOLD_MS
      );
      blockedBidOutcomes.add(outcome);
      toxicityFlags.push(resolveMicropriceToxicFlag(outcome, biasTicks));
      continue;
    }

    if (previousHoldUntilMs !== undefined && previousHoldUntilMs > nowMs) {
      if (micropriceHoldShouldExtend) {
        toxicBidBlockUntilMs[outcome] = Math.max(
          previousHoldUntilMs,
          nowMs + params.runtimeConfig.MM_TOXIC_FLOW_HOLD_MS
        );
      }
      blockedBidOutcomes.add(outcome);
      toxicityFlags.push(`${outcome.toLowerCase()}_microprice_hold`);
      continue;
    }

    delete toxicBidBlockUntilMs[outcome];
  }

  const toxicAskOnlyActive =
    (globalBidBlockUntilMs !== null && globalBidBlockUntilMs > nowMs) ||
    blockedBidOutcomes.size >= 2;
  if (toxicAskOnlyActive) {
    lastAskOnlyBidBlockAtMs = nowMs;
  }
  const postAskOnlyReentryCooldownActive =
    !toxicAskOnlyActive &&
    lastAskOnlyBidBlockAtMs !== null &&
    params.runtimeConfig.MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS > 0 &&
    nowMs - lastAskOnlyBidBlockAtMs <
      params.runtimeConfig.MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS;
  if (!toxicAskOnlyActive && !postAskOnlyReentryCooldownActive) {
    lastAskOnlyBidBlockAtMs = null;
  }

  let allowBidQuotes = true;
  let allowAskQuotes = true;
  let entryMode: MmEntryMode = 'NORMAL';

  if (slotState.phase === 'PRE_OPEN' || slotState.phase === 'WARMUP') {
    allowBidQuotes = false;
    entryMode = 'OFF';
  } else if (slotState.phase === 'LATE_ASK_ONLY') {
    allowBidQuotes = false;
    entryMode = 'ASK_ONLY';
  } else if (slotState.phase === 'FINAL_CANCEL') {
    allowBidQuotes = false;
    allowAskQuotes = false;
    entryMode = 'OFF';
  }

  if (
    allowBidQuotes &&
    globalBidBlockUntilMs !== null &&
    globalBidBlockUntilMs > nowMs
  ) {
    allowBidQuotes = false;
    entryMode = 'ASK_ONLY';
  } else if (allowBidQuotes && blockedBidOutcomes.size >= 2) {
    allowBidQuotes = false;
    entryMode = 'ASK_ONLY';
  } else if (allowBidQuotes && postAskOnlyReentryCooldownActive) {
    allowBidQuotes = false;
    entryMode = 'ASK_ONLY';
    toxicityFlags.push('post_ask_only_cooldown');
  } else if (allowBidQuotes && blockedBidOutcomes.size === 1) {
    entryMode = 'ONE_SIDED';
  }

  return {
    phase: slotState.phase,
    slotAgeMs: slotState.slotAgeMs,
    timeToSlotEndMs: slotState.timeToSlotEndMs,
    directionalMovePct,
    yesMicropriceBiasTicks,
    noMicropriceBiasTicks,
    blockedBidOutcomes: Array.from(blockedBidOutcomes),
    toxicityFlags,
    allowBidQuotes,
    allowAskQuotes,
    entryMode,
    postSniperGraceActive,
    mmBehaviorState: {
      globalBidBlockUntilMs,
      toxicBidBlockUntilMs,
      sameSideBidBlockUntilMs: previousBehaviorState.sameSideBidBlockUntilMs,
      lastAskOnlyBidBlockAtMs,
    },
  };
}

function resolveMmSlotState(params: {
  market: MarketCandidate;
  runtimeConfig: AppConfig;
  now: Date;
}): {
  phase: MmQuotePhase;
  slotAgeMs: number | null;
  timeToSlotEndMs: number | null;
} {
  const startMs = params.market.startTime ? Date.parse(params.market.startTime) : Number.NaN;
  const endMs = params.market.endTime ? Date.parse(params.market.endTime) : Number.NaN;
  const slotAgeMs = Number.isFinite(startMs)
    ? Math.max(0, params.now.getTime() - startMs)
    : null;
  const timeToSlotEndMs = Number.isFinite(endMs)
    ? Math.max(0, endMs - params.now.getTime())
    : null;

  if (Number.isFinite(startMs) && params.now.getTime() < startMs) {
    return {
      phase: 'PRE_OPEN',
      slotAgeMs: roundTo(params.now.getTime() - startMs, 0),
      timeToSlotEndMs,
    };
  }

  if (
    timeToSlotEndMs !== null &&
    timeToSlotEndMs <= params.runtimeConfig.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS
  ) {
    return {
      phase: 'FINAL_CANCEL',
      slotAgeMs,
      timeToSlotEndMs,
    };
  }

  if (
    timeToSlotEndMs !== null &&
    timeToSlotEndMs <= params.runtimeConfig.MM_STOP_NEW_ENTRIES_BEFORE_END_MS
  ) {
    return {
      phase: 'LATE_ASK_ONLY',
      slotAgeMs,
      timeToSlotEndMs,
    };
  }

  if (slotAgeMs !== null && slotAgeMs < params.runtimeConfig.MM_SLOT_WARMUP_MS) {
    return {
      phase: 'WARMUP',
      slotAgeMs,
      timeToSlotEndMs,
    };
  }

  if (
    slotAgeMs !== null &&
    slotAgeMs <
      params.runtimeConfig.MM_SLOT_WARMUP_MS + params.runtimeConfig.MM_OPENING_SEED_WINDOW_MS
  ) {
    return {
      phase: 'OPENING_SEED',
      slotAgeMs,
      timeToSlotEndMs,
    };
  }

  if (slotAgeMs === null && timeToSlotEndMs === null) {
    return {
      phase: 'UNKNOWN',
      slotAgeMs: null,
      timeToSlotEndMs: null,
    };
  }

  return {
    phase: 'NORMAL',
    slotAgeMs,
    timeToSlotEndMs,
  };
}

function resolveMicropriceBiasTicks(book: TokenBookSnapshot): number | null {
  if (
    book.bestBid === null ||
    book.bestAsk === null ||
    !Number.isFinite(book.bestBid) ||
    !Number.isFinite(book.bestAsk)
  ) {
    return null;
  }

  const totalDepth = Math.max(0, book.depthSharesBid) + Math.max(0, book.depthSharesAsk);
  if (totalDepth <= 0) {
    return null;
  }

  const midPrice = roundTo((book.bestBid + book.bestAsk) / 2, 6);
  const tick = inferQuoteTick(book, midPrice);
  if (!Number.isFinite(tick) || tick <= 0) {
    return null;
  }

  const microprice =
    (book.bestBid * Math.max(0, book.depthSharesAsk) +
      book.bestAsk * Math.max(0, book.depthSharesBid)) /
    totalDepth;

  return roundTo((microprice - midPrice) / tick, 4);
}

function resolveAutonomousBidShares(params: {
  runtimeConfig: AppConfig;
  actualSpread: number;
  minProfitableSpread: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  phase: MmQuotePhase;
  timeToSlotEndMs: number | null;
}): number {
  const baseShares = roundTo(Math.max(6, params.runtimeConfig.MM_QUOTE_SHARES), 4);
  const maxShares = roundTo(
    Math.max(baseShares, params.runtimeConfig.MM_MAX_QUOTE_SHARES),
    4
  );
  if (params.phase === 'OPENING_SEED') {
    return baseShares;
  }

  let size = baseShares;
  const spreadMultiple =
    params.minProfitableSpread > 0
      ? params.actualSpread / params.minProfitableSpread
      : 1;
  const depthMultiple =
    Math.min(params.bidDepthUsd, params.askDepthUsd) /
    Math.max(0.0001, params.runtimeConfig.MM_MIN_BOOK_DEPTH_USD);

  if (params.phase === 'NORMAL' && spreadMultiple >= 1.5) {
    size += baseShares;
  }
  if (params.phase === 'NORMAL' && spreadMultiple >= 2.25 && depthMultiple >= 3) {
    size += baseShares;
  }
  if (
    params.timeToSlotEndMs !== null &&
    params.timeToSlotEndMs <= params.runtimeConfig.MM_STOP_NEW_ENTRIES_BEFORE_END_MS * 2
  ) {
    size = Math.min(size, baseShares * 2);
  }

  return roundTo(clamp(size, baseShares, maxShares), 4);
}

function assessSellabilityCliff(params: {
  book: TokenBookSnapshot;
  openShares: number;
  fallbackAskPrice: number;
  fairValue: number | null;
}): {
  atRisk: boolean;
  adjustedAskPrice: number | null;
} {
  if (!Number.isFinite(params.openShares) || params.openShares <= 0) {
    return {
      atRisk: false,
      adjustedAskPrice: params.fallbackAskPrice,
    };
  }

  const referencePrice =
    params.fairValue ??
    params.book.midPrice ??
    params.book.bestBid ??
    params.book.bestAsk ??
    params.fallbackAskPrice;
  const minimumSharesAtReference = resolveMinimumTradableShares(referencePrice, 0);
  if (params.openShares >= minimumSharesAtReference) {
    return {
      atRisk: false,
      adjustedAskPrice: params.fallbackAskPrice,
    };
  }

  const tick = inferQuoteTick(params.book, Math.max(params.fallbackAskPrice, referencePrice));
  const bestPassiveExit =
    params.book.bestBid !== null && Number.isFinite(params.book.bestBid)
      ? roundTo(clamp(params.book.bestBid + tick, 0.01, 0.99), 6)
      : params.fallbackAskPrice;
  const notionalFloorPrice = roundTo(clamp(1 / params.openShares, 0.01, 0.99), 6);

  return {
    atRisk: true,
    adjustedAskPrice: roundTo(
      clamp(Math.max(bestPassiveExit, notionalFloorPrice), 0.01, 0.99),
      6
    ),
  };
}

function resolvePhaseSkipReason(phase: MmQuotePhase): string {
  switch (phase) {
    case 'PRE_OPEN':
      return 'slot_not_open';
    case 'WARMUP':
      return 'slot_warmup';
    case 'LATE_ASK_ONLY':
      return 'late_slot';
    case 'FINAL_CANCEL':
      return 'final_cancel_window';
    default:
      return 'entry_mode_blocked';
  }
}

function generateAutonomousQuoteSignals(params: {
  context: QuoteContext;
  activeQuoteOrders: readonly ActiveQuoteOrder[];
  runtimeConfig: AppConfig;
  quoteSpreadTicks: number;
  currentMMExposureUsd: number;
  assessment: AutonomousMmAssessment;
  behaviorState: MmBehaviorState;
  diagnostics: MmMarketDiagnostics;
  now: Date;
}): { signals: readonly StrategySignal[]; diagnostics: MmMarketDiagnostics } {
  const { context, runtimeConfig, now, assessment } = params;
  const diagnostics = { ...params.diagnostics };
  const behaviorState = normalizeMmBehaviorState(params.behaviorState, now.getTime());
  const snapshot = context.positionManager.getSnapshot();
  const pendingQuoteExposure = normalizePendingQuoteExposure(
    context.pendingQuoteExposure
  );
  const effectiveSnapshot = applyPendingQuoteExposure(snapshot, pendingQuoteExposure);
  const imbalancePercent = resolveInventoryImbalancePercent(effectiveSnapshot);
  const overweightOutcome =
    imbalancePercent > runtimeConfig.MAX_IMBALANCE_PERCENT
      ? effectiveSnapshot.inventoryImbalance > 0
        ? 'YES'
        : effectiveSnapshot.inventoryImbalance < 0
          ? 'NO'
          : null
      : null;
  const netInventory = roundTo(
    effectiveSnapshot.yesShares - effectiveSnapshot.noShares,
    4
  );
  const skewFactor = runtimeConfig.MM_INVENTORY_SKEW_FACTOR;
  const skewAdjustment =
    -clamp(
      netInventory / Math.max(1, runtimeConfig.MM_MAX_NET_DIRECTIONAL),
      -1,
      1
    ) * skewFactor;
  const quoteSpreadTicks = Math.max(
    params.quoteSpreadTicks,
    runtimeConfig.MM_MIN_SPREAD_TICKS
  );
  const builtSignals: StrategySignal[] = [];
  let projectedExposureUsd = Math.max(0, roundTo(params.currentMMExposureUsd, 4));

  if (!assessment.allowBidQuotes && !assessment.allowAskQuotes) {
    logMmQuoteSkip({
      context,
      runtimeConfig,
      now,
      reason: resolvePhaseSkipReason(assessment.phase),
      details: {
        phase: assessment.phase,
        entryMode: assessment.entryMode,
        slotAgeMs: assessment.slotAgeMs,
        timeToSlotEndMs: assessment.timeToSlotEndMs,
        toxicityFlags: assessment.toxicityFlags,
      },
    });
    return {
      signals: [],
      diagnostics,
    };
  }

  for (const outcome of ['YES', 'NO'] as const satisfies readonly Outcome[]) {
    const perOutcomeSpreadTicks =
      context.activationTrigger?.triggerLayer === 'SNIPER' &&
      context.activationTrigger.entryOutcome !== outcome
        ? Math.max(runtimeConfig.MM_MIN_SPREAD_TICKS, params.quoteSpreadTicks - 1)
        : quoteSpreadTicks;
    const book = getBookForOutcome(context.orderbook, outcome);
    if (
      book.depthNotionalBid < runtimeConfig.MM_MIN_BOOK_DEPTH_USD ||
      book.depthNotionalAsk < runtimeConfig.MM_MIN_BOOK_DEPTH_USD
    ) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'low_depth',
        details: {
          outcome,
          bidDepthUsd: roundTo(book.depthNotionalBid, 4),
          askDepthUsd: roundTo(book.depthNotionalAsk, 4),
          minDepthUsd: runtimeConfig.MM_MIN_BOOK_DEPTH_USD,
        },
      });
      continue;
    }

    const fairValue = resolveQuoteFairValue(
      context.orderbook,
      outcome,
      runtimeConfig,
      context.binanceFairValueAdjustment,
      context.deepBinanceAssessment
    );
    if (runtimeConfig.MM_REQUIRE_FAIR_VALUE && fairValue === null) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'no_fair_value',
        details: { outcome },
      });
      continue;
    }

    const pricingAnchor =
      fairValue ??
      book.midPrice ??
      book.lastTradePrice ??
      book.bestBid ??
      book.bestAsk;
    if (pricingAnchor === null || !Number.isFinite(pricingAnchor)) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'no_fair_value',
        details: {
          outcome,
          fairValue,
        },
      });
      continue;
    }

    const tick = inferQuoteTick(book, pricingAnchor);
    const skewedFairValue = roundTo(
      clamp(
        pricingAnchor + skewAdjustment * tick * quoteSpreadTicks,
        0.01,
        0.99
      ),
      6
    );
    const bidPrice = resolveBuyQuotePrice(book, skewedFairValue, perOutcomeSpreadTicks);
    const askPrice = resolveSellQuotePrice(book, skewedFairValue, perOutcomeSpreadTicks);
    if (bidPrice === null || askPrice === null) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'spread_too_thin',
        details: {
          outcome,
          bidPrice,
          askPrice,
        },
      });
      continue;
    }

    const isPassiveMakerQuote = resolveQuoteUrgency(runtimeConfig) === 'passive';
    const takerFee = getTakerFee(context.market.title, runtimeConfig.evKelly);
    const effectiveFee = isPassiveMakerQuote ? 0 : takerFee;
    const requiredEdge = isPassiveMakerQuote
      ? runtimeConfig.MM_MAKER_MIN_EDGE
      : runtimeConfig.MM_MIN_EDGE_AFTER_FEE;
    const minProfitableSpread = Math.max(
      effectiveFee + requiredEdge,
      tick * runtimeConfig.MM_MIN_SPREAD_TICKS
    );
    const actualSpread = roundTo(askPrice - bidPrice, 6);
    if (actualSpread < minProfitableSpread) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'spread_too_thin',
        details: {
          outcome,
          actualSpread,
          minProfitableSpread,
          quoteMode: isPassiveMakerQuote ? 'maker' : 'aggressive',
          effectiveFee,
        },
      });
      continue;
    }

    const bidBlockedByMode =
      !assessment.allowBidQuotes ||
      (assessment.entryMode === 'ONE_SIDED' &&
        assessment.blockedBidOutcomes.includes(outcome));
    if (bidBlockedByMode) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason:
          assessment.entryMode === 'ONE_SIDED' &&
          assessment.blockedBidOutcomes.includes(outcome)
            ? 'toxic_flow'
            : resolvePhaseSkipReason(assessment.phase),
        details: {
          outcome,
          phase: assessment.phase,
          entryMode: assessment.entryMode,
          blockedBidOutcomes: assessment.blockedBidOutcomes,
          toxicityFlags: assessment.toxicityFlags,
          slotAgeMs: assessment.slotAgeMs,
          timeToSlotEndMs: assessment.timeToSlotEndMs,
        },
      });
    } else if (
      bidPrice < runtimeConfig.MM_AUTONOMOUS_MIN_BID_PRICE ||
      bidPrice > runtimeConfig.MM_AUTONOMOUS_MAX_BID_PRICE
    ) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'price_out_of_band',
        details: {
          outcome,
          bidPrice,
          minBidPrice: runtimeConfig.MM_AUTONOMOUS_MIN_BID_PRICE,
          maxBidPrice: runtimeConfig.MM_AUTONOMOUS_MAX_BID_PRICE,
          phase: assessment.phase,
          slotAgeMs: assessment.slotAgeMs,
          timeToSlotEndMs: assessment.timeToSlotEndMs,
        },
      });
    } else {
      const sameSideBidBlockUntilMs = behaviorState.sameSideBidBlockUntilMs[outcome] ?? null;
      const sameSideBidBlockActive =
        sameSideBidBlockUntilMs !== null && sameSideBidBlockUntilMs > now.getTime();
      const dominantDirectionalShares =
        outcome === 'YES'
          ? Math.max(0, effectiveSnapshot.yesShares - effectiveSnapshot.noShares)
          : Math.max(0, effectiveSnapshot.noShares - effectiveSnapshot.yesShares);
      const sameSideInventoryBlocked =
        dominantDirectionalShares >= Math.max(6, runtimeConfig.MM_QUOTE_SHARES);
      const bidShares = resolveAutonomousBidShares({
        runtimeConfig,
        actualSpread,
        minProfitableSpread,
        bidDepthUsd: book.depthNotionalBid,
        askDepthUsd: book.depthNotionalAsk,
        phase: assessment.phase,
        timeToSlotEndMs: assessment.timeToSlotEndMs,
      });
      const bidNotionalUsd = roundTo(bidShares * bidPrice, 4);
      const projectedGrossExposureShares = roundTo(
        effectiveSnapshot.grossExposureShares + bidShares,
        4
      );
      const currentAbsoluteNetInventory = roundTo(Math.abs(netInventory), 4);
      const projectedAbsoluteNetInventory = roundTo(
        Math.abs(netInventory + (outcome === 'YES' ? bidShares : -bidShares)),
        4
      );
      const grossReentryThresholdShares = resolveGrossReentryThresholdShares({
        runtimeConfig,
      });
      const grossInventoryReentryBlocked =
        grossReentryThresholdShares !== null &&
        projectedGrossExposureShares >= grossReentryThresholdShares &&
        projectedAbsoluteNetInventory > currentAbsoluteNetInventory + 0.0001;
      const minimumBidShares = resolveMinimumTradableShares(bidPrice, 6);
      const entryCapacity = resolvePendingAwareEntryCapacity({
        outcome,
        snapshot,
        pendingQuoteExposure,
        maxNetYes: runtimeConfig.strategy.maxNetYes,
        maxNetNo: runtimeConfig.strategy.maxNetNo,
      });
      const projectedDirectionalInventory =
        netInventory + (outcome === 'YES' ? bidShares : -bidShares);
      const increasesDirectionalRisk =
        Math.abs(projectedDirectionalInventory) > runtimeConfig.MM_MAX_NET_DIRECTIONAL &&
        Math.abs(projectedDirectionalInventory) >= Math.abs(netInventory);

      if (
        sameSideBidBlockActive ||
        sameSideInventoryBlocked ||
        grossInventoryReentryBlocked ||
        bidShares < minimumBidShares ||
        context.allowEntryQuotes === false ||
        context.riskAssessment.blockedOutcomes.has(outcome) ||
        overweightOutcome === outcome ||
        entryCapacity < bidShares ||
        increasesDirectionalRisk ||
        projectedExposureUsd + bidNotionalUsd > runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD
      ) {
        logMmQuoteSkip({
          context,
          runtimeConfig,
          now,
          reason:
            sameSideBidBlockActive || sameSideInventoryBlocked
              ? 'same_side_reentry'
              : grossInventoryReentryBlocked
              ? 'gross_inventory_reentry'
              : bidShares < minimumBidShares
              ? 'below_minimum_size'
              : context.allowEntryQuotes === false
              ? 'concurrent_limit'
              : projectedExposureUsd + bidNotionalUsd > runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD
                ? 'exposure_limit'
                : 'inventory_limit',
          details: {
            outcome,
            bidShares,
            minimumBidShares,
            sameSideBidBlockActive,
            sameSideBidBlockUntilMs,
            dominantDirectionalShares: roundTo(dominantDirectionalShares, 4),
            currentGrossExposureShares: roundTo(effectiveSnapshot.grossExposureShares, 4),
            projectedGrossExposureShares,
            grossReentryThresholdShares,
            currentAbsoluteNetInventory,
            projectedAbsoluteNetInventory,
            entryCapacity,
            overweightOutcome,
            projectedExposureUsd: roundTo(projectedExposureUsd + bidNotionalUsd, 4),
            maxExposureUsd: runtimeConfig.MM_MAX_GROSS_EXPOSURE_USD,
            netInventory: roundTo(netInventory, 4),
            projectedDirectionalInventory: roundTo(projectedDirectionalInventory, 4),
            maxDirectionalInventory: runtimeConfig.MM_MAX_NET_DIRECTIONAL,
            phase: assessment.phase,
            entryMode: assessment.entryMode,
            toxicityFlags: assessment.toxicityFlags,
          },
        });
      } else {
        if (outcome === 'YES') {
          diagnostics.selectedBidSharesYes = bidShares;
        } else {
          diagnostics.selectedBidSharesNo = bidShares;
        }
        builtSignals.push(
          buildAutonomousSignal({
            market: context.market,
            orderbook: context.orderbook,
            runtimeConfig,
            action: 'BUY',
            outcome,
            signalType: 'MM_QUOTE_BID',
            shares: bidShares,
            targetPrice: bidPrice,
            referencePrice: fairValue ?? pricingAnchor,
            fairValue: skewedFairValue,
            actualSpread,
            reason: 'Autonomous MM bid',
            diagnostics,
            now,
          })
        );
        projectedExposureUsd += bidNotionalUsd;
        logger.debug('MM autonomous quote generated', {
          marketId: context.market.marketId,
          outcome,
          action: 'BID',
          price: bidPrice,
          fairValue,
          skewedFairValue,
          spread: actualSpread,
          inventorySkew: roundTo(skewAdjustment, 6),
          grossExposure: roundTo(projectedExposureUsd, 4),
          phase: assessment.phase,
          bidShares,
          toxicityFlags: assessment.toxicityFlags,
        });
      }
    }

    if (!assessment.allowAskQuotes) {
      continue;
    }

    const openShares = context.positionManager.getShares(outcome);
    const askShares = Math.min(roundTo(Math.max(6, runtimeConfig.MM_QUOTE_SHARES), 4), openShares);
    if (askShares <= 0) {
      continue;
    }

    const sellabilityCliff = assessSellabilityCliff({
      book,
      openShares: askShares,
      fallbackAskPrice: askPrice,
      fairValue: fairValue ?? pricingAnchor,
    });
    if (sellabilityCliff.atRisk && !diagnostics.sellabilityCliffOutcomes.includes(outcome)) {
      diagnostics.sellabilityCliffOutcomes = [...diagnostics.sellabilityCliffOutcomes, outcome];
    }
    const autonomousAskPrice = sellabilityCliff.adjustedAskPrice ?? askPrice;
    const minimumAskShares = resolveMinimumTradableShares(autonomousAskPrice, 0);
    if (askShares < minimumAskShares) {
      logMmQuoteSkip({
        context,
        runtimeConfig,
        now,
        reason: 'below_minimum_size',
        details: {
          outcome,
          mode: 'autonomous_ask',
          askShares,
          minimumShares: minimumAskShares,
          askPrice: autonomousAskPrice,
          phase: assessment.phase,
          sellabilityCliff: sellabilityCliff.atRisk,
        },
      });
      continue;
    }

    builtSignals.push(
      buildAutonomousSignal({
        market: context.market,
        orderbook: context.orderbook,
        runtimeConfig,
        action: 'SELL',
        outcome,
        signalType: 'MM_QUOTE_ASK',
        shares: askShares,
        targetPrice: autonomousAskPrice,
        referencePrice: fairValue ?? pricingAnchor,
        fairValue: skewedFairValue,
        actualSpread,
        reason: 'Autonomous MM ask',
        diagnostics,
        cliffAdjusted: sellabilityCliff.atRisk,
        now,
      })
    );
    logger.debug('MM autonomous quote generated', {
      marketId: context.market.marketId,
      outcome,
      action: 'ASK',
      price: autonomousAskPrice,
      fairValue,
      skewedFairValue,
      spread: actualSpread,
      inventorySkew: roundTo(skewAdjustment, 6),
      grossExposure: roundTo(projectedExposureUsd, 4),
      phase: assessment.phase,
      sellabilityCliff: sellabilityCliff.atRisk,
    });
  }

  return {
    signals: builtSignals,
    diagnostics,
  };
}

function generatePostSniperAskSignals(params: {
  context: QuoteContext;
  runtimeConfig: AppConfig;
  quoteSpreadTicks: number;
  mmDiagnostics: MmMarketDiagnostics;
  now: Date;
}): { signals: readonly StrategySignal[]; diagnostics: MmMarketDiagnostics } {
  const { context, runtimeConfig, now } = params;
  const diagnostics = { ...params.mmDiagnostics };
  if (
    !isPostSniperMmGraceWindowActive({
      activationTrigger: context.activationTrigger,
      runtimeConfig,
      now,
    }) ||
    context.activationTrigger?.triggerLayer !== 'SNIPER'
  ) {
    return {
      signals: [],
      diagnostics,
    };
  }

  const outcome = context.activationTrigger.entryOutcome;
  const openShares = roundTo(Math.max(0, context.positionManager.getShares(outcome)), 4);
  if (openShares <= 0) {
    return {
      signals: [],
      diagnostics,
    };
  }

  const book = getBookForOutcome(context.orderbook, outcome);
  const fairValue = resolveQuoteFairValue(
    context.orderbook,
    outcome,
    runtimeConfig,
    context.binanceFairValueAdjustment,
    context.deepBinanceAssessment
  );
  const askPrice = resolvePostSniperAskPrice({
    book,
    fairValue,
    entryPrice: context.activationTrigger.entryPrice,
    quoteSpreadTicks: Math.max(1, params.quoteSpreadTicks - 1),
    runtimeConfig,
  });
  if (askPrice === null) {
    logMmQuoteSkip({
      context,
      runtimeConfig,
      now,
      reason: 'spread_too_thin',
      details: {
        outcome,
        mode: 'post_sniper_ask',
      },
    });
    return {
      signals: [],
      diagnostics,
    };
  }

  const askShares = Math.min(roundTo(runtimeConfig.MM_QUOTE_SHARES, 4), openShares);
  const sellabilityCliff = assessSellabilityCliff({
    book,
    openShares: askShares,
    fallbackAskPrice: askPrice,
    fairValue: fairValue ?? context.activationTrigger.entryPrice,
  });
  if (sellabilityCliff.atRisk && !diagnostics.sellabilityCliffOutcomes.includes(outcome)) {
    diagnostics.sellabilityCliffOutcomes = [...diagnostics.sellabilityCliffOutcomes, outcome];
  }
  const postSniperAskPrice = sellabilityCliff.adjustedAskPrice ?? askPrice;
  const minimumShares = resolveMinimumTradableShares(postSniperAskPrice, 0);
  if (askShares < minimumShares) {
    logMmQuoteSkip({
      context,
      runtimeConfig,
      now,
      reason: 'below_minimum_size',
      details: {
        outcome,
        mode: 'post_sniper_ask',
        askShares,
        minimumShares,
        askPrice: postSniperAskPrice,
        sellabilityCliff: sellabilityCliff.atRisk,
      },
    });
    return {
      signals: [],
      diagnostics,
    };
  }

  const referencePrice =
    fairValue ?? book.midPrice ?? book.bestAsk ?? book.bestBid ?? askPrice;
  const actualSpread = roundTo(
    Math.max(0, askPrice - (book.bestBid ?? askPrice)),
    6
  );

  return {
    signals: [
      buildAutonomousSignal({
        market: context.market,
        orderbook: context.orderbook,
        runtimeConfig,
        action: 'SELL',
        outcome,
        signalType: 'MM_QUOTE_ASK',
        shares: askShares,
        targetPrice: postSniperAskPrice,
        referencePrice,
        fairValue: referencePrice,
        actualSpread,
        reason: 'Post-sniper MM ask',
        urgencyOverride: 'passive',
        diagnostics,
        cliffAdjusted: sellabilityCliff.atRisk,
        now,
      }),
    ],
    diagnostics,
  };
}

function isPostSniperMmGraceWindowActive(params: {
  activationTrigger?: QuoteActivationTrigger;
  runtimeConfig: AppConfig;
  now: Date;
}): boolean {
  const { activationTrigger, runtimeConfig, now } = params;
  if (
    !activationTrigger ||
    activationTrigger.triggerLayer !== 'SNIPER' ||
    runtimeConfig.MM_POST_SNIPER_GRACE_WINDOW_MS <= 0
  ) {
    return false;
  }

  return now.getTime() - activationTrigger.activatedAtMs <= runtimeConfig.MM_POST_SNIPER_GRACE_WINDOW_MS;
}

function logMmQuoteSkip(params: {
  context: QuoteContext;
  runtimeConfig: AppConfig;
  now: Date;
  reason: string;
  details: Record<string, unknown>;
}): void {
  const payload = {
    marketId: params.context.market.marketId,
    reason: params.reason,
    details: params.details,
  };

  if (shouldPromoteMmSkipLog(params)) {
    logger.info('MM quote skipped', payload);
    return;
  }

  logger.debug('MM quote skipped', payload);
}

function shouldPromoteMmSkipLog(params: {
  context: QuoteContext;
  reason: string;
}): boolean {
  if (params.context.activationTrigger?.triggerLayer !== 'SNIPER') {
    return false;
  }

  return params.reason === 'spread_too_thin' || params.reason === 'below_minimum_size';
}

function buildAutonomousSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  runtimeConfig: AppConfig;
  action: 'BUY' | 'SELL';
  outcome: Outcome;
  signalType: Extract<SignalType, 'MM_QUOTE_BID' | 'MM_QUOTE_ASK'>;
  shares: number;
  targetPrice: number;
  referencePrice: number;
  fairValue: number;
  actualSpread: number;
  reason: string;
  diagnostics: MmMarketDiagnostics;
  cliffAdjusted?: boolean;
  urgencyOverride?: StrategySignal['urgency'];
  now: Date;
}): StrategySignal {
  const book = getBookForOutcome(params.orderbook, params.outcome);
  const edgeAmount =
    params.action === 'BUY'
      ? roundTo(Math.max(0, params.referencePrice - params.targetPrice), 6)
      : roundTo(Math.max(0, params.targetPrice - params.referencePrice), 6);
  const reasonDetails = [
    `spread=${params.actualSpread.toFixed(4)}`,
    `phase=${params.diagnostics.phase.toLowerCase()}`,
    `mode=${params.diagnostics.entryMode.toLowerCase()}`,
    `size=${roundTo(params.shares, 4).toFixed(4)}`,
  ];
  if (params.diagnostics.slotAgeMs !== null) {
    reasonDetails.push(`slotAgeMs=${Math.max(0, Math.round(params.diagnostics.slotAgeMs))}`);
  }
  if (params.diagnostics.timeToSlotEndMs !== null) {
    reasonDetails.push(
      `timeLeftMs=${Math.max(0, Math.round(params.diagnostics.timeToSlotEndMs))}`
    );
  }
  if (params.diagnostics.toxicityFlags.length > 0) {
    reasonDetails.push(`tox=${params.diagnostics.toxicityFlags.join(',')}`);
  }
  if (params.cliffAdjusted) {
    reasonDetails.push('sellabilityCliff=true');
  }

  return {
    marketId: params.market.marketId,
    marketTitle: params.market.title,
    signalType: params.signalType,
    priority: params.action === 'BUY' ? 150 : 140,
    generatedAt: params.now.getTime(),
    action: params.action,
    outcome: params.outcome,
    outcomeIndex: params.outcome === 'YES' ? 0 : 1,
    shares: roundTo(params.shares, 4),
    targetPrice: params.targetPrice,
    referencePrice: roundTo(params.referencePrice, 6),
    tokenPrice: book.lastTradePrice ?? params.targetPrice,
    midPrice: book.midPrice,
    fairValue: roundTo(params.fairValue, 6),
    edgeAmount,
    combinedBid: params.orderbook.combined.combinedBid,
    combinedAsk: params.orderbook.combined.combinedAsk,
    combinedMid: params.orderbook.combined.combinedMid,
    combinedDiscount: params.orderbook.combined.combinedDiscount,
    combinedPremium: params.orderbook.combined.combinedPremium,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: params.urgencyOverride ?? resolveQuoteUrgency(params.runtimeConfig),
    reduceOnly: params.action === 'SELL',
    reason: `${params.reason} | ${reasonDetails.join(' | ')}`,
  };
}

function isSameSideInventoryDominant(params: {
  outcome: Outcome;
  yesShares: number;
  noShares: number;
  baseShares: number;
}): boolean {
  const dominantDirectionalShares =
    params.outcome === 'YES'
      ? Math.max(0, params.yesShares - params.noShares)
      : Math.max(0, params.noShares - params.yesShares);

  return dominantDirectionalShares >= Math.max(6, params.baseShares);
}

function resolveGrossReentryThresholdShares(params: {
  runtimeConfig: AppConfig;
}): number | null {
  if (params.runtimeConfig.MM_GROSS_REENTRY_THRESHOLD_CLIPS <= 0) {
    return null;
  }

  const baseShares = Math.max(6, params.runtimeConfig.MM_QUOTE_SHARES);
  return roundTo(baseShares * params.runtimeConfig.MM_GROSS_REENTRY_THRESHOLD_CLIPS, 4);
}

export class QuotingEngine {
  private readonly contexts = new Map<string, QuoteContext>();
  private readonly activeQuoteOrders = new Map<string, ActiveQuoteOrder[]>();
  private readonly activationTriggers = new Map<string, QuoteActivationTrigger>();
  private readonly marketDiagnostics = new Map<string, MmMarketDiagnostics>();
  private readonly mmBehaviorStates = new Map<string, MmBehaviorState>();
  private readonly marketLifecycleSignatures = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private onRefreshPlan: ((plan: QuoteRefreshPlan) => Promise<void>) | null = null;

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    private readonly now: () => Date = () => new Date()
  ) {}

  isEnabled(): boolean {
    return isDynamicQuotingEnabled(this.runtimeConfig);
  }

  start(onRefreshPlan: (plan: QuoteRefreshPlan) => Promise<void>): void {
    if (!this.isEnabled() || this.refreshTimer) {
      return;
    }

    this.onRefreshPlan = onRefreshPlan;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, this.runtimeConfig.QUOTING_INTERVAL_MS);
    this.refreshTimer.unref?.();
    logger.info('Quoting engine started', {
      intervalMs: this.runtimeConfig.QUOTING_INTERVAL_MS,
      postOnlyOnly: this.runtimeConfig.POST_ONLY_ONLY,
    });
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contexts.clear();
    this.activeQuoteOrders.clear();
    this.activationTriggers.clear();
    this.marketDiagnostics.clear();
    this.mmBehaviorStates.clear();
    this.marketLifecycleSignatures.clear();
    this.onRefreshPlan = null;
  }

  activateForMarket(
    marketId: string,
    trigger: {
      triggerLayer: StrategyLayer;
      entryOutcome: Outcome;
      entryPrice: number;
      entryShares: number;
    }
  ): void {
    this.activationTriggers.set(marketId, {
      ...trigger,
      activatedAtMs: this.now().getTime(),
    });
  }

  syncMarketContext(context: QuoteContext): void {
    if (!this.isEnabled()) {
      return;
    }

    this.contexts.set(context.market.marketId, {
      ...context,
      activationTrigger:
        context.activationTrigger ?? this.activationTriggers.get(context.market.marketId),
    });
  }

  getContext(marketId: string): QuoteContext | undefined {
    return this.contexts.get(marketId);
  }

  getMmDiagnostics(marketId: string): MmMarketDiagnostics | undefined {
    const diagnostics = this.marketDiagnostics.get(marketId);
    return diagnostics ? { ...diagnostics } : undefined;
  }

  getMmBehaviorState(marketId: string): MmBehaviorState | undefined {
    const behaviorState = this.mmBehaviorStates.get(marketId);
    return behaviorState ? normalizeMmBehaviorState(behaviorState) : undefined;
  }

  replaceMmDiagnostics(marketId: string, diagnostics: MmMarketDiagnostics | null): void {
    if (!diagnostics) {
      this.marketDiagnostics.delete(marketId);
      this.marketLifecycleSignatures.delete(marketId);
      return;
    }

    this.marketDiagnostics.set(marketId, { ...diagnostics });
    this.maybeLogLifecycleTransition(marketId, diagnostics);
  }

  replaceMmBehaviorState(marketId: string, behaviorState: MmBehaviorState | null): void {
    if (!behaviorState) {
      this.mmBehaviorStates.delete(marketId);
      return;
    }

    this.mmBehaviorStates.set(marketId, normalizeMmBehaviorState(behaviorState));
  }

  noteAutonomousQuoteDetectedFill(params: {
    marketId: string;
    outcome: Outcome;
    side: StrategySignal['action'];
    signalType: SignalType;
    filledAtMs: number;
  }): void {
    if (params.signalType !== 'MM_QUOTE_BID' || params.side !== 'BUY') {
      return;
    }

    const nextState = normalizeMmBehaviorState(
      this.mmBehaviorStates.get(params.marketId),
      params.filledAtMs
    );
    const sameSideBidBlockUntilMs = {
      ...nextState.sameSideBidBlockUntilMs,
      [params.outcome]:
        params.filledAtMs + this.runtimeConfig.MM_SAME_SIDE_REENTRY_COOLDOWN_MS,
    };

    this.replaceMmBehaviorState(params.marketId, {
      ...nextState,
      sameSideBidBlockUntilMs,
    });
  }

  noteAutonomousQuoteFill(params: {
    marketId: string;
    outcome: Outcome;
    side: StrategySignal['action'];
    signalType: SignalType;
    filledAtMs: number;
    afterYesShares: number;
    afterNoShares: number;
  }): void {
    const nextState = normalizeMmBehaviorState(
      this.mmBehaviorStates.get(params.marketId),
      params.filledAtMs
    );
    const sameSideBidBlockUntilMs = {
      ...nextState.sameSideBidBlockUntilMs,
    };

    if (params.signalType === 'MM_QUOTE_BID' && params.side === 'BUY') {
      sameSideBidBlockUntilMs[params.outcome] =
        params.filledAtMs + this.runtimeConfig.MM_SAME_SIDE_REENTRY_COOLDOWN_MS;
    } else if (
      params.side === 'SELL' &&
      !isSameSideInventoryDominant({
        outcome: params.outcome,
        yesShares: params.afterYesShares,
        noShares: params.afterNoShares,
        baseShares: this.runtimeConfig.MM_QUOTE_SHARES,
      })
    ) {
      delete sameSideBidBlockUntilMs[params.outcome];
    }

    this.replaceMmBehaviorState(params.marketId, {
      ...nextState,
      sameSideBidBlockUntilMs,
    });
  }

  /**
   * Returns the currently tracked quote orders for a market.
   */
  getQuoteOrders(marketId: string): readonly ActiveQuoteOrder[] {
    return [...(this.activeQuoteOrders.get(marketId) ?? [])];
  }

  /**
   * Returns true when a market already carries MM inventory or resting quotes.
   */
  hasActiveMMMarket(marketId: string): boolean {
    const quoteOrders = this.activeQuoteOrders.get(marketId);
    if (quoteOrders && quoteOrders.length > 0) {
      return true;
    }

    const context = this.contexts.get(marketId);
    return Boolean(context && context.positionManager.getSnapshot().grossExposureShares > 0);
  }

  /**
   * Returns market IDs that currently have active MM inventory or resting quotes.
   */
  getActiveMMMarketIds(): string[] {
    const marketIds = new Set<string>([
      ...this.contexts.keys(),
      ...this.activeQuoteOrders.keys(),
    ]);

    return Array.from(marketIds).filter((marketId) => this.hasActiveMMMarket(marketId));
  }

  /**
   * Returns total notional MM exposure across all tracked markets.
   */
  getCurrentMMExposureUsd(): number {
    let total = 0;
    for (const context of this.contexts.values()) {
      const snapshot = context.positionManager.getSnapshot();
      const yesMid = context.orderbook.yes.midPrice ?? 0.5;
      const noMid = context.orderbook.no.midPrice ?? 0.5;
      total += snapshot.yesShares * yesMid + snapshot.noShares * noMid;
    }

    return roundTo(total, 4);
  }

  replaceQuoteOrders(marketId: string, orders: readonly ActiveQuoteOrder[]): void {
    if (orders.length === 0) {
      this.activeQuoteOrders.delete(marketId);
      return;
    }

    this.activeQuoteOrders.set(marketId, [...orders]);
  }

  forgetQuoteOrder(orderId: string): void {
    for (const [marketId, orders] of this.activeQuoteOrders.entries()) {
      const next = orders.filter((order) => order.orderId !== orderId);
      if (next.length !== orders.length) {
        if (next.length > 0) {
          this.activeQuoteOrders.set(marketId, next);
        } else {
          this.activeQuoteOrders.delete(marketId);
        }
      }
    }
  }

  removeInactiveMarkets(activeMarketIds: Iterable<string>): ActiveQuoteOrder[] {
    const active = new Set(activeMarketIds);
    const staleOrders: ActiveQuoteOrder[] = [];

    for (const marketId of Array.from(this.contexts.keys())) {
      if (!active.has(marketId)) {
        this.contexts.delete(marketId);
        this.activationTriggers.delete(marketId);
        this.marketDiagnostics.delete(marketId);
        this.mmBehaviorStates.delete(marketId);
        this.marketLifecycleSignatures.delete(marketId);
      }
    }

    for (const [marketId, orders] of this.activeQuoteOrders.entries()) {
      if (!active.has(marketId)) {
        staleOrders.push(...orders);
        this.activeQuoteOrders.delete(marketId);
        this.activationTriggers.delete(marketId);
        this.marketDiagnostics.delete(marketId);
        this.mmBehaviorStates.delete(marketId);
        this.marketLifecycleSignatures.delete(marketId);
      }
    }

    return staleOrders;
  }

  private async refreshAll(): Promise<void> {
    if (!this.isEnabled() || !this.onRefreshPlan || this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      for (const [marketId, context] of this.contexts.entries()) {
        const plan = buildQuoteRefreshPlan({
          context,
          activeQuoteOrders: this.activeQuoteOrders.get(marketId) ?? [],
          currentMMExposureUsd: this.getCurrentMMExposureUsd(),
          behaviorState: this.mmBehaviorStates.get(marketId),
          runtimeConfig: this.runtimeConfig,
          now: this.now(),
        });
        this.replaceMmDiagnostics(marketId, plan.mmDiagnostics);
        this.replaceMmBehaviorState(marketId, plan.mmBehaviorState);

        if (plan.activeQuoteOrders.length === 0 && plan.signals.length === 0) {
          continue;
        }

        await this.onRefreshPlan(plan);
      }
    } catch (error) {
      logger.warn('Quoting engine refresh failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshInFlight = false;
    }
  }

  private maybeLogLifecycleTransition(
    marketId: string,
    diagnostics: MmMarketDiagnostics
  ): void {
    const signature = [
      diagnostics.phase,
      diagnostics.entryMode,
      diagnostics.blockedBidOutcomes.join(','),
      diagnostics.toxicityFlags.join(','),
    ].join('|');
    if (this.marketLifecycleSignatures.get(marketId) === signature) {
      return;
    }

    this.marketLifecycleSignatures.set(marketId, signature);
    logger.info('MM lifecycle state changed', {
      marketId,
      phase: diagnostics.phase,
      entryMode: diagnostics.entryMode,
      slotAgeMs: diagnostics.slotAgeMs,
      timeToSlotEndMs: diagnostics.timeToSlotEndMs,
      blockedBidOutcomes: diagnostics.blockedBidOutcomes,
      toxicityFlags: diagnostics.toxicityFlags,
      selectedBidSharesYes: diagnostics.selectedBidSharesYes,
      selectedBidSharesNo: diagnostics.selectedBidSharesNo,
    });
  }
}

/**
 * Counts the markets that currently have MM inventory or live quote orders.
 */
export function countActiveMMMarkets(quotingEngine: QuotingEngine): number {
  return quotingEngine.getActiveMMMarketIds().length;
}

function buildEntryQuoteSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  template: StrategySignal;
  runtimeConfig: AppConfig;
  binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  deepBinanceAssessment?: DeepBinanceAssessment;
  quoteSpreadTicks: number;
  now: Date;
}): StrategySignal | null {
  const book = getBookForOutcome(params.orderbook, params.template.outcome);
  if (
    params.deepBinanceAssessment &&
    shouldBlockSignalByBinanceSpread({
      binanceSpreadRatio: params.deepBinanceAssessment.binanceSpreadRatio,
      runtimeConfig: params.runtimeConfig,
    })
  ) {
    return null;
  }

  const fairValue = resolveQuoteFairValue(
    params.orderbook,
    params.template.outcome,
    params.runtimeConfig,
    params.binanceFairValueAdjustment,
    params.deepBinanceAssessment
  );
  const targetPrice = resolveBuyQuotePrice(book, fairValue, params.quoteSpreadTicks);
  if (targetPrice === null) {
    return null;
  }

  return {
    ...params.template,
    signalType: resolveQuoteSignalType(params.template, params.deepBinanceAssessment),
    action: 'BUY',
    targetPrice,
    referencePrice: fairValue ?? params.template.referencePrice,
    fairValue,
    tokenPrice: book.lastTradePrice ?? targetPrice,
    midPrice: book.midPrice,
    urgency: resolveQuoteUrgency(params.runtimeConfig),
    generatedAt: params.now.getTime(),
    reduceOnly: false,
    reason: `${params.template.reason} | Market-maker bid quote`,
    strategyLayer: resolveStrategyLayer('MM_QUOTE_BID'),
  };
}

function buildReduceOnlyQuoteSignal(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  template: StrategySignal;
  runtimeConfig: AppConfig;
  binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  deepBinanceAssessment?: DeepBinanceAssessment;
  quoteSpreadTicks: number;
  now: Date;
}): StrategySignal | null {
  const book = getBookForOutcome(params.orderbook, params.template.outcome);
  const fairValue = resolveQuoteFairValue(
    params.orderbook,
    params.template.outcome,
    params.runtimeConfig,
    params.binanceFairValueAdjustment,
    params.deepBinanceAssessment
  );
  const targetPrice = resolveSellQuotePrice(book, fairValue, params.quoteSpreadTicks);
  if (targetPrice === null || params.template.shares <= 0) {
    return null;
  }

  return {
    ...params.template,
    signalType:
      params.template.signalType === 'INVENTORY_REBALANCE_QUOTE'
        ? 'INVENTORY_REBALANCE_QUOTE'
        : resolveQuoteSignalType(params.template, params.deepBinanceAssessment),
    action: 'SELL',
    targetPrice,
    referencePrice: fairValue ?? params.template.referencePrice,
    fairValue,
    tokenPrice: book.lastTradePrice ?? targetPrice,
    midPrice: book.midPrice,
    urgency: resolveQuoteUrgency(params.runtimeConfig),
    generatedAt: params.now.getTime(),
    reduceOnly: true,
    reason:
      params.template.signalType === 'INVENTORY_REBALANCE_QUOTE'
        ? `${params.template.reason} | Passive rebalance quote`
        : `${params.template.reason} | Market-maker ask quote`,
    strategyLayer:
      params.template.signalType === 'INVENTORY_REBALANCE_QUOTE'
        ? resolveStrategyLayer('INVENTORY_REBALANCE_QUOTE')
        : resolveStrategyLayer('MM_QUOTE_ASK'),
  };
}

function mergeQuoteSignals(signals: readonly StrategySignal[]): StrategySignal[] {
  const byOutcomeAction = new Map<string, StrategySignal>();
  for (const signal of signals) {
    const key = `${signal.outcome}:${signal.action}`;
    const existing = byOutcomeAction.get(key);
    if (!existing || signal.priority > existing.priority || signal.shares > existing.shares) {
      byOutcomeAction.set(key, signal);
    }
  }

  return Array.from(byOutcomeAction.values()).sort((left, right) => right.priority - left.priority);
}

function resolveInventoryImbalancePercent(snapshot: {
  inventoryImbalance: number;
  grossExposureShares: number;
}): number {
  if (snapshot.grossExposureShares <= 0) {
    return 0;
  }

  return roundTo(
    (Math.abs(snapshot.inventoryImbalance) / snapshot.grossExposureShares) * 100,
    4
  );
}

function normalizePendingQuoteExposure(
  exposure?: PendingQuoteExposureSnapshot | null
): PendingQuoteExposureSnapshot {
  return {
    yesShares: roundTo(Math.max(0, exposure?.yesShares ?? 0), 4),
    noShares: roundTo(Math.max(0, exposure?.noShares ?? 0), 4),
    grossExposureUsd: roundTo(Math.max(0, exposure?.grossExposureUsd ?? 0), 4),
  };
}

function applyPendingQuoteExposure(
  snapshot: {
    yesShares: number;
    noShares: number;
  },
  pendingQuoteExposure: PendingQuoteExposureSnapshot
): {
  yesShares: number;
  noShares: number;
  inventoryImbalance: number;
  grossExposureShares: number;
} {
  const yesShares = roundTo(
    Math.max(0, snapshot.yesShares + pendingQuoteExposure.yesShares),
    4
  );
  const noShares = roundTo(
    Math.max(0, snapshot.noShares + pendingQuoteExposure.noShares),
    4
  );

  return {
    yesShares,
    noShares,
    inventoryImbalance: roundTo(yesShares - noShares, 4),
    grossExposureShares: roundTo(yesShares + noShares, 4),
  };
}

function resolvePendingAwareEntryCapacity(params: {
  outcome: Outcome;
  snapshot: {
    yesShares: number;
    noShares: number;
  };
  pendingQuoteExposure: PendingQuoteExposureSnapshot;
  maxNetYes: number;
  maxNetNo: number;
}): number {
  const confirmedShares =
    params.outcome === 'YES' ? params.snapshot.yesShares : params.snapshot.noShares;
  const pendingShares =
    params.outcome === 'YES'
      ? params.pendingQuoteExposure.yesShares
      : params.pendingQuoteExposure.noShares;
  const effectiveShares = roundTo(Math.max(0, confirmedShares + pendingShares), 4);
  const maxShares = params.outcome === 'YES' ? params.maxNetYes : params.maxNetNo;
  return Math.max(0, roundTo(maxShares - effectiveShares, 4));
}

function getBookForOutcome(
  snapshot: MarketOrderbookSnapshot,
  outcome: Outcome
): TokenBookSnapshot {
  return outcome === 'YES' ? snapshot.yes : snapshot.no;
}

function getOppositeOutcome(outcome: Outcome): Outcome {
  return outcome === 'YES' ? 'NO' : 'YES';
}

function resolveQuoteUrgency(runtimeConfig: AppConfig): StrategySignal['urgency'] {
  return runtimeConfig.POST_ONLY_ONLY ? 'passive' : 'improve';
}

function resolveBuyQuotePrice(
  book: TokenBookSnapshot,
  fairValue: number | null,
  quoteSpreadTicks: number
): number | null {
  const fallback = fairValue ?? book.midPrice ?? book.bestBid ?? book.bestAsk;
  if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) {
    return null;
  }

  const tick = inferQuoteTick(book, fallback);
  const upperBound =
    book.bestAsk !== null && Number.isFinite(book.bestAsk)
      ? Math.max(0.01, book.bestAsk - tick)
      : Math.max(0.01, fallback);
  const lowerBound =
    book.bestBid !== null && Number.isFinite(book.bestBid)
      ? Math.max(0.01, book.bestBid)
      : 0.01;
  const desired = Math.min(fallback, upperBound) - tick * Math.max(0, quoteSpreadTicks - 1);
  return normalizeQuotePrice(desired, lowerBound, upperBound);
}

function resolveSellQuotePrice(
  book: TokenBookSnapshot,
  fairValue: number | null,
  quoteSpreadTicks: number
): number | null {
  const fallback = fairValue ?? book.midPrice ?? book.bestAsk ?? book.bestBid;
  if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) {
    return null;
  }

  const tick = inferQuoteTick(book, fallback);
  const lowerBound =
    book.bestBid !== null && Number.isFinite(book.bestBid)
      ? Math.min(0.99, book.bestBid + tick)
      : Math.min(0.99, fallback);
  const upperBound =
    book.bestAsk !== null && Number.isFinite(book.bestAsk)
      ? Math.min(0.99, book.bestAsk)
      : 0.99;
  const desired = Math.max(fallback, lowerBound) + tick * Math.max(0, quoteSpreadTicks - 1);
  return normalizeQuotePrice(desired, lowerBound, upperBound);
}

function resolvePostSniperAskPrice(params: {
  book: TokenBookSnapshot;
  fairValue: number | null;
  entryPrice: number;
  quoteSpreadTicks: number;
  runtimeConfig: AppConfig;
}): number | null {
  const fallback =
    params.fairValue ??
    params.book.midPrice ??
    params.book.bestAsk ??
    params.book.bestBid ??
    params.entryPrice;
  if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) {
    return null;
  }

  const tick = inferQuoteTick(params.book, Math.max(fallback, params.entryPrice));
  const lowerBound =
    params.book.bestBid !== null && Number.isFinite(params.book.bestBid)
      ? Math.min(0.99, params.book.bestBid + tick)
      : Math.min(0.99, params.entryPrice + tick);
  const desiredFromFairValue =
    Math.max(fallback, lowerBound) + tick * Math.max(0, params.quoteSpreadTicks - 1);
  const breakEvenFloor = roundTo(
    clamp(
      params.entryPrice + Math.max(tick, params.runtimeConfig.MM_MAKER_MIN_EDGE),
      0.01,
      0.99
    ),
    6
  );

  return normalizeQuotePrice(
    Math.max(desiredFromFairValue, breakEvenFloor),
    lowerBound,
    0.99
  );
}

function resolveQuoteFairValue(
  orderbook: MarketOrderbookSnapshot,
  outcome: Outcome,
  runtimeConfig: AppConfig,
  binanceFairValueAdjustment?: FairValueBinanceAdjustment,
  deepBinanceAssessment?: DeepBinanceAssessment
): number | null {
  if (
    isDeepBinanceEnabled(runtimeConfig) &&
    deepBinanceAssessment?.available &&
    deepBinanceAssessment.fairValue !== null
  ) {
    return outcome === 'YES'
      ? deepBinanceAssessment.fairValue
      : roundTo(clamp(1 - deepBinanceAssessment.fairValue, 0.001, 0.999), 6);
  }

  return estimateFairValue(
    orderbook,
    outcome,
    binanceFairValueAdjustment,
    runtimeConfig
  );
}

function resolveQuoteSpreadTicks(
  runtimeConfig: AppConfig,
  deepBinanceAssessment?: DeepBinanceAssessment
): number {
  if (
    !isDeepBinanceEnabled(runtimeConfig) ||
    !deepBinanceAssessment?.available
  ) {
    return runtimeConfig.QUOTING_SPREAD_TICKS;
  }

  return getDynamicSpreadTicks({
    baseTicks: runtimeConfig.QUOTING_SPREAD_TICKS,
    volatilityRatio: deepBinanceAssessment.volatilityRatio,
    runtimeConfig,
  });
}

function resolveQuoteSignalType(
  template: StrategySignal,
  deepBinanceAssessment?: DeepBinanceAssessment
): SignalType {
  if (template.signalType === 'INVENTORY_REBALANCE_QUOTE') {
    return 'INVENTORY_REBALANCE_QUOTE';
  }

  if (template.signalType === 'MM_QUOTE_BID' || template.signalType === 'MM_QUOTE_ASK') {
    return template.signalType;
  }

  return deepBinanceAssessment?.available && deepBinanceAssessment.fairValue !== null
    ? 'DEEP_BINANCE_SIGNAL'
    : 'DYNAMIC_QUOTE_BOTH';
}

function normalizeQuotePrice(
  desired: number,
  lowerBound: number,
  upperBound: number
): number | null {
  const minBound = Math.max(0.01, Math.min(lowerBound, upperBound));
  const maxBound = Math.min(0.99, Math.max(lowerBound, upperBound));
  if (!Number.isFinite(minBound) || !Number.isFinite(maxBound) || minBound > maxBound) {
    return null;
  }

  return roundTo(clamp(desired, minBound, maxBound), 6);
}

function inferQuoteTick(book: TokenBookSnapshot, fallbackPrice: number): number {
  const differences = collectLevelDifferences(book.bids).concat(collectLevelDifferences(book.asks));
  const positiveDifferences = differences.filter(
    (value) => Number.isFinite(value) && value > 0
  );
  if (positiveDifferences.length > 0) {
    return roundTo(Math.min(...positiveDifferences), 6);
  }

  return fallbackPrice >= 0.5 ? 0.01 : 0.005;
}

function collectLevelDifferences(levels: readonly { price: number }[]): number[] {
  if (levels.length <= 1) {
    return [];
  }

  const sorted = [...levels].sort((left, right) => left.price - right.price);
  const differences: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = Math.abs(sorted[index].price - sorted[index - 1].price);
    if (difference > 0) {
      differences.push(difference);
    }
  }

  return differences;
}
