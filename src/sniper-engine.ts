import type { BinanceEdgeAssessment } from './binance-edge.js';
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import type { AppConfig, SniperConfig } from './config.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { SniperStatsSnapshot } from './runtime-status.js';
import { resolveStrategyLayer, type StrategySignal } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface SniperEntry {
  readonly marketId: string;
  readonly conditionId: string;
  readonly outcome: Outcome;
  readonly entryPrice: number;
  readonly shares: number;
  readonly enteredAtMs: number;
  readonly binanceDirectionAtEntry: 'UP' | 'DOWN';
  readonly binanceMoveAtEntry: number;
}

export type SniperRejection =
  | 'no_binance_data'
  | 'move_too_small'
  | 'direction_flat'
  | 'outcome_blocked'
  | 'ask_price_too_high'
  | 'ask_price_too_low'
  | 'no_ask_available'
  | 'edge_too_low'
  | 'pm_already_repriced'
  | 'slot_too_early'
  | 'slot_too_late'
  | 'cooldown_active'
  | 'max_position_reached'
  | 'velocity_too_low'
  | 'correlated_risk_limit'
  | 'signal_generated';

interface SniperEvaluation {
  readonly marketId: string;
  readonly coin: string;
  readonly rejection: SniperRejection;
  readonly binanceMovePct: number | null;
  readonly direction: string | null;
  readonly bestAsk: number | null;
  readonly edge: number | null;
  readonly pmLag: number | null;
  readonly impliedFV: number | null;
}

interface CoinEvalState {
  evals: number;
  signals: number;
  moves: number[];
}

interface DirectionWindowEntry {
  readonly coin: string;
  readonly marketId: string;
  readonly enteredAtMs: number;
  readonly edge: number;
}

interface DirectionWindowState {
  readonly direction: 'UP' | 'DOWN';
  readonly windowStartMs: number;
  entries: DirectionWindowEntry[];
}

export interface SniperCandidate {
  readonly market: MarketCandidate;
  readonly orderbook: MarketOrderbookSnapshot;
  readonly binanceAssessment: BinanceEdgeAssessment;
  readonly expectedWinner: Outcome;
  readonly bestAsk: number;
  readonly impliedFV: number;
  readonly edge: number;
  readonly pmLag: number;
  readonly shares: number;
  readonly coin: string;
  readonly nowMs: number;
  readonly slotStartMs: number | null;
  readonly slotEndMs: number | null;
  readonly evaluation: Omit<SniperEvaluation, 'rejection'>;
}

export function estimateFairValueFromBinance(
  binanceMovePct: number,
  direction: 'UP' | 'DOWN' | 'FLAT',
  targetOutcome: Outcome,
  volatilityScale: number
): number {
  if (!Number.isFinite(binanceMovePct) || direction === 'FLAT') {
    return 0.5;
  }

  const safeVolatilityScale = Math.max(0.0001, volatilityScale);
  const absMoveDecimal = Math.abs(binanceMovePct) / 100;
  const zScore = absMoveDecimal / safeVolatilityScale;
  const probabilityShift = 1 / (1 + Math.exp(-1.7 * zScore));
  const favorable =
    (direction === 'UP' && targetOutcome === 'YES') ||
    (direction === 'DOWN' && targetOutcome === 'NO');
  const raw = favorable ? probabilityShift : 1 - probabilityShift;
  return roundTo(clamp(raw, 0.001, 0.999), 6);
}

export function resolveSniperExpectedWinner(
  direction: 'UP' | 'DOWN' | 'FLAT'
): Outcome | null {
  if (direction === 'UP') {
    return 'YES';
  }
  if (direction === 'DOWN') {
    return 'NO';
  }
  return null;
}

export function buildSniperEntryKey(marketId: string, outcome: Outcome): string {
  return `${marketId}:${outcome}`;
}

export class SniperEngine {
  private readonly activeEntries = new Map<string, SniperEntry>();
  private readonly hardStopFallbackKeys = new Set<string>();
  private readonly lastEntryAt = new Map<string, number>();
  private readonly rejectionCounts = new Map<SniperRejection, number>();
  private readonly coinEvals = new Map<string, CoinEvalState>();
  private readonly directionWindows = new Map<string, DirectionWindowState>();
  private lastRejectionSummaryMs = Date.now();
  private totalSignals = 0;
  private totalExecuted = 0;
  private bestEdge = 0;
  private lastSignalAt: string | null = null;
  private lastRejectionReason: string | null = null;
  private nearMissCount = 0;

  private static readonly REJECTION_SUMMARY_INTERVAL_MS = 30_000;
  private static readonly MAX_COIN_MOVE_SAMPLES = 500;

  constructor(private readonly runtimeConfig: AppConfig) {}

  hasActiveEntryForMarket(marketId: string): boolean {
    for (const entry of this.activeEntries.values()) {
      if (entry.marketId === marketId) {
        return true;
      }
    }

    return false;
  }

  hasActiveEntryFor(marketId: string, outcome: Outcome): boolean {
    return this.activeEntries.has(buildSniperEntryKey(marketId, outcome));
  }

  clearActiveEntry(marketId: string, outcome: Outcome): void {
    const key = buildSniperEntryKey(marketId, outcome);
    this.activeEntries.delete(key);
    this.hardStopFallbackKeys.delete(key);
  }

  recordFailedExit(params: {
    marketId: string;
    outcome: Outcome;
  }): void {
    if (!this.runtimeConfig.SNIPER_MODE_ENABLED) {
      return;
    }

    const key = buildSniperEntryKey(params.marketId, params.outcome);
    if (!this.activeEntries.has(key)) {
      return;
    }

    this.hardStopFallbackKeys.add(key);
  }

  shouldSuppressLegacyForcedSignal(
    signal: Pick<StrategySignal, 'marketId' | 'outcome' | 'signalType'>
  ): boolean {
    const key = buildSniperEntryKey(signal.marketId, signal.outcome);
    if (
      !this.runtimeConfig.SNIPER_MODE_ENABLED ||
      !this.activeEntries.has(key)
    ) {
      return false;
    }

    if (
      signal.signalType === 'HARD_STOP' &&
      this.hardStopFallbackKeys.has(key)
    ) {
      return false;
    }

    return (
      signal.signalType === 'TRAILING_TAKE_PROFIT' ||
      signal.signalType === 'HARD_STOP' ||
      signal.signalType === 'SLOT_FLATTEN'
    );
  }

  recordExecution(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    filledShares?: number;
    fillPrice?: number;
    executedAtMs?: number;
  }): void {
    if (!this.runtimeConfig.SNIPER_MODE_ENABLED) {
      return;
    }

    const executedAtMs = params.executedAtMs ?? Date.now();
    const shares = Math.max(0, roundTo(params.filledShares ?? params.signal.shares, 4));
    if (shares <= 0) {
      return;
    }

    if (params.signal.signalType === 'SNIPER_BUY') {
      this.totalExecuted += 1;
    }

    const key = buildSniperEntryKey(params.market.marketId, params.signal.outcome);
    if (params.signal.signalType === 'SNIPER_BUY' && params.signal.action === 'BUY') {
      this.hardStopFallbackKeys.delete(key);
      const nextPrice =
        params.fillPrice ??
        params.signal.targetPrice ??
        params.signal.referencePrice ??
        params.signal.tokenPrice ??
        0.5;
      const existing = this.activeEntries.get(key);
      const combinedShares = roundTo((existing?.shares ?? 0) + shares, 4);
      const weightedEntryPrice =
        existing && combinedShares > 0
          ? roundTo(
              ((existing.entryPrice * existing.shares) + nextPrice * shares) / combinedShares,
              6
            )
          : roundTo(nextPrice, 6);

      this.activeEntries.set(key, {
        marketId: params.market.marketId,
        conditionId: params.market.conditionId,
        outcome: params.signal.outcome,
        entryPrice: weightedEntryPrice,
        shares: combinedShares,
        enteredAtMs: existing?.enteredAtMs ?? executedAtMs,
        binanceDirectionAtEntry:
          params.signal.outcome === 'YES' ? 'UP' : 'DOWN',
        binanceMoveAtEntry: params.signal.edgeAmount,
      });
      this.lastEntryAt.set(params.market.marketId, executedAtMs);
      return;
    }

    if (params.signal.action !== 'SELL') {
      return;
    }

    this.hardStopFallbackKeys.delete(key);

    const existing = this.activeEntries.get(key);
    if (!existing) {
      return;
    }

    const remainingShares = roundTo(existing.shares - shares, 4);
    if (remainingShares <= 0.0001) {
      this.clearActiveEntry(params.market.marketId, params.signal.outcome);
      return;
    }

    this.activeEntries.set(key, {
      ...existing,
      shares: remainingShares,
    });
  }

  generateSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    binanceAssessment?: BinanceEdgeAssessment;
    binanceVelocityPctPerSec?: number | null;
    config: SniperConfig;
    blockedOutcomes?: ReadonlySet<Outcome>;
    nowMs?: number;
  }): StrategySignal[] {
    const nowMs = params.nowMs ?? Date.now();
    const exits = this.generateExitSignals({
      market: params.market,
      orderbook: params.orderbook,
      positionManager: params.positionManager,
      binanceAssessment: params.binanceAssessment,
      config: params.config,
      nowMs,
    });
    if (exits.length > 0) {
      return exits;
    }

    if (!params.config.enabled) {
      return [];
    }

    const candidate = this.evaluateEntryCandidate({
      ...params,
      nowMs,
    });
    if (!candidate) {
      return [];
    }

    return this.selectSignals([candidate], params.config, nowMs);
  }

  evaluateEntryCandidate(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    binanceAssessment?: BinanceEdgeAssessment;
    binanceVelocityPctPerSec?: number | null;
    config: SniperConfig;
    blockedOutcomes?: ReadonlySet<Outcome>;
    nowMs?: number;
  }): SniperCandidate | null {
    const nowMs = params.nowMs ?? Date.now();
    const coin = params.binanceAssessment?.coin ?? resolveCoinLabel(params.market.title);
    const evaluationBase: Omit<SniperEvaluation, 'rejection'> = {
      marketId: params.market.marketId,
      coin,
      binanceMovePct: params.binanceAssessment?.binanceMovePct ?? null,
      direction: params.binanceAssessment?.direction ?? null,
      bestAsk: null,
      edge: null,
      pmLag: null,
      impliedFV: null,
    };
    const assessment = params.binanceAssessment;
    if (!assessment?.available) {
      this.trackCoinEval(coin, 0, false);
      this.reject({
        ...evaluationBase,
        rejection: 'no_binance_data',
      });
      return null;
    }

    this.trackCoinEval(assessment.coin, assessment.binanceMovePct, false);
    logger.debug('Sniper: evaluating', {
      marketId: params.market.marketId,
      coin: assessment.coin,
      binanceMovePct: assessment.binanceMovePct,
      direction: assessment.direction,
      pmUpMid: assessment.pmUpMid,
      velocityPctPerSec: params.binanceVelocityPctPerSec ?? null,
    });

    const movePct = Math.abs(assessment.binanceMovePct);
    if (assessment.direction === 'FLAT') {
      this.reject({
        ...evaluationBase,
        rejection: 'direction_flat',
      });
      return null;
    }

    if (!Number.isFinite(movePct) || movePct < params.config.minBinanceMovePct) {
      this.reject({
        ...evaluationBase,
        rejection: 'move_too_small',
      });
      return null;
    }

    if (
      !supportsSniperVelocity(
        assessment.direction,
        params.binanceVelocityPctPerSec ?? null,
        params.config.minVelocityPctPerSec
      )
    ) {
      this.reject({
        ...evaluationBase,
        rejection: 'velocity_too_low',
      });
      return null;
    }

    const slotStartMs = parseSlotBoundary(params.market.startTime);
    const slotEndMs = parseSlotBoundary(params.market.endTime);
    if (slotStartMs !== null && nowMs - slotStartMs < params.config.slotWarmupMs) {
      this.reject({
        ...evaluationBase,
        rejection: 'slot_too_early',
      });
      return null;
    }
    if (slotEndMs !== null && slotEndMs - nowMs < params.config.exitBeforeEndMs) {
      this.reject({
        ...evaluationBase,
        rejection: 'slot_too_late',
      });
      return null;
    }

    const expectedWinner = resolveSniperExpectedWinner(assessment.direction);
    if (!expectedWinner || params.blockedOutcomes?.has(expectedWinner)) {
      this.reject({
        ...evaluationBase,
        rejection: 'outcome_blocked',
      });
      return null;
    }

    const marketCooldownAt = this.lastEntryAt.get(params.market.marketId);
    if (
      marketCooldownAt !== undefined &&
      nowMs - marketCooldownAt < params.config.cooldownMs
    ) {
      this.reject({
        ...evaluationBase,
        rejection: 'cooldown_active',
      });
      return null;
    }

    const currentWinnerShares = params.positionManager.getShares(expectedWinner);
    const oppositeWinnerShares = params.positionManager.getShares(
      expectedWinner === 'YES' ? 'NO' : 'YES'
    );
    if (oppositeWinnerShares > 0.0001 || currentWinnerShares >= params.config.maxPositionShares) {
      this.reject({
        ...evaluationBase,
        rejection: 'max_position_reached',
      });
      return null;
    }

    const book = expectedWinner === 'YES' ? params.orderbook.yes : params.orderbook.no;
    const bestAsk = book.bestAsk;
    if (bestAsk === null) {
      this.reject({
        ...evaluationBase,
        rejection: 'no_ask_available',
      });
      return null;
    }
    if (bestAsk < params.config.minEntryPrice) {
      this.reject({
        ...evaluationBase,
        bestAsk,
        rejection: 'ask_price_too_low',
      });
      return null;
    }
    if (bestAsk > params.config.maxEntryPrice) {
      this.reject({
        ...evaluationBase,
        bestAsk,
        rejection: 'ask_price_too_high',
      });
      return null;
    }

    const impliedFV = estimateFairValueFromBinance(
      assessment.binanceMovePct,
      assessment.direction,
      expectedWinner,
      params.config.volatilityScale
    );
    const totalCost = roundTo(bestAsk * (1 + params.config.takerFeePct), 6);
    const edge = roundTo(impliedFV - totalCost, 6);
    this.trackEdge(edge);
    this.trackNearMiss(edge, params.config.minEdgeAfterFees);
    if (edge < params.config.minEdgeAfterFees) {
      this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        impliedFV,
        rejection: 'edge_too_low',
      });
      return null;
    }

    const pmLag = roundTo(Math.abs(impliedFV - bestAsk), 6);
    if (pmLag < params.config.minPmLagPct) {
      this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        pmLag,
        impliedFV,
        rejection: 'pm_already_repriced',
      });
      return null;
    }

    const requestedShares =
      movePct >= params.config.strongBinanceMovePct
        ? params.config.strongShares
        : params.config.baseShares;
    const shares = roundTo(
      Math.min(requestedShares, Math.max(0, params.config.maxPositionShares - currentWinnerShares)),
      4
    );
    if (shares <= 0) {
      this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        pmLag,
        impliedFV,
        rejection: 'max_position_reached',
      });
      return null;
    }

    return {
      market: params.market,
      orderbook: params.orderbook,
      binanceAssessment: assessment,
      expectedWinner,
      bestAsk,
      impliedFV,
      edge,
      pmLag,
      shares,
      coin: assessment.coin,
      nowMs,
      slotStartMs,
      slotEndMs,
      evaluation: {
        ...evaluationBase,
        bestAsk,
        edge,
        pmLag,
        impliedFV,
      },
    };
  }

  selectSignals(
    candidates: readonly SniperCandidate[],
    config: SniperConfig,
    nowMs: number = Date.now()
  ): StrategySignal[] {
    if (candidates.length === 0) {
      this.pruneDirectionWindows(nowMs);
      return [];
    }

    this.pruneDirectionWindows(nowMs);
    const grouped = new Map<string, SniperCandidate[]>();
    for (const candidate of candidates) {
      const key = this.buildDirectionWindowKey(
        candidate.binanceAssessment.direction,
        candidate.slotStartMs,
        candidate.nowMs
      );
      const existing = grouped.get(key) ?? [];
      existing.push(candidate);
      grouped.set(key, existing);
    }

    const selectedSignals: StrategySignal[] = [];
    for (const [windowKey, group] of grouped.entries()) {
      if (group.length === 0) {
        continue;
      }

      const direction = group[0]?.binanceAssessment.direction;
      if (direction !== 'UP' && direction !== 'DOWN') {
        continue;
      }

      const windowStartMs = resolveDirectionWindowStart(group[0]?.slotStartMs, nowMs);
      const window = this.directionWindows.get(windowKey) ?? {
        direction,
        windowStartMs,
        entries: [],
      };
      const usedCoins = new Set(window.entries.map((entry) => entry.coin));
      let remainingCapacity = Math.max(0, config.maxConcurrentSameDirection - window.entries.length);

      const ranked = [...group].sort((left, right) => right.edge - left.edge);
      for (const candidate of ranked) {
        if (usedCoins.has(candidate.coin) || remainingCapacity <= 0) {
          this.reject({
            ...candidate.evaluation,
            rejection: 'correlated_risk_limit',
          });
          continue;
        }

        usedCoins.add(candidate.coin);
        remainingCapacity -= 1;
        this.recordDirectionEntry(windowKey, candidate, nowMs);
        selectedSignals.push(this.buildEntrySignal(candidate));
      }
    }

    return selectedSignals;
  }

  getStats(): SniperStatsSnapshot {
    const rejections: Record<string, number> = {};
    for (const [reason, count] of this.rejectionCounts.entries()) {
      rejections[reason] = count;
    }

    const coinStats: SniperStatsSnapshot['coinStats'] = {};
    let moveSum = 0;
    let moveCount = 0;
    for (const [coin, data] of this.coinEvals.entries()) {
      const moves = data.moves.filter((move) => Number.isFinite(move) && move >= 0);
      const avgMovePct =
        moves.length > 0
          ? roundTo(moves.reduce((sum, move) => sum + move, 0) / moves.length, 4)
          : 0;
      const maxMovePct = moves.length > 0 ? roundTo(Math.max(...moves), 4) : 0;
      coinStats[coin] = {
        evaluations: data.evals,
        signals: data.signals,
        avgMovePct,
        maxMovePct,
      };
      moveSum += moves.reduce((sum, move) => sum + move, 0);
      moveCount += moves.length;
    }

    return {
      enabled: this.runtimeConfig.SNIPER_MODE_ENABLED,
      signalsGenerated: this.totalSignals,
      signalsExecuted: this.totalExecuted,
      rejections,
      totalRejections: Object.values(rejections).reduce((sum, count) => sum + count, 0),
      lastSignalAt: this.lastSignalAt,
      lastRejection: this.lastRejectionReason,
      bestEdgeSeen: roundTo(this.bestEdge, 4),
      avgBinanceMove:
        moveCount > 0 ? roundTo(moveSum / moveCount, 4) : null,
      nearMissCount: this.nearMissCount,
      coinStats,
      currentDirectionWindow: this.getCurrentDirectionWindowSnapshot(),
    };
  }

  generateExitSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    binanceAssessment?: BinanceEdgeAssessment;
    config: SniperConfig;
    nowMs: number;
  }): StrategySignal[] {
    const candidates = Array.from(this.activeEntries.values()).filter(
      (entry) => entry.marketId === params.market.marketId
    );
    if (candidates.length === 0) {
      return [];
    }

    for (const entry of candidates) {
      const currentShares = params.positionManager.getShares(entry.outcome);
      if (currentShares <= 0.0001) {
        this.clearActiveEntry(entry.marketId, entry.outcome);
        continue;
      }

      const book = entry.outcome === 'YES' ? params.orderbook.yes : params.orderbook.no;
      const bestBid = book.bestBid;
      if (bestBid === null) {
        continue;
      }

      const exitShares = roundTo(Math.min(currentShares, entry.shares), 4);
      if (roundTo(exitShares * bestBid, 6) < 1) {
        this.clearActiveEntry(entry.marketId, entry.outcome);
        continue;
      }
      const pnlEdge = roundTo(bestBid - entry.entryPrice, 6);
      if (pnlEdge >= params.config.scalpExitEdge) {
        return [
          buildSniperExitSignal(params.market, params.orderbook, {
            entry,
            shares: exitShares,
            bestBid,
            edgeAmount: pnlEdge,
            signalType: 'SNIPER_SCALP_EXIT',
            urgency: 'cross',
            reason: `Sniper scalp exit: bid ${bestBid.toFixed(3)} repriced ${(pnlEdge * 100).toFixed(2)}% above entry`,
            nowMs: params.nowMs,
          }),
        ];
      }

      const directionFlipped =
        params.binanceAssessment?.available &&
        params.binanceAssessment.direction !== 'FLAT' &&
        params.binanceAssessment.direction !== entry.binanceDirectionAtEntry;
      if (directionFlipped && pnlEdge <= -params.config.stopLossPct) {
        return [
          buildSniperExitSignal(params.market, params.orderbook, {
            entry,
            shares: exitShares,
            bestBid,
            edgeAmount: pnlEdge,
            signalType: 'SNIPER_SCALP_EXIT',
            urgency: 'cross',
            reason: `Sniper reversal stop: Binance flipped against ${entry.binanceDirectionAtEntry} and pnl ${(pnlEdge * 100).toFixed(2)}%`,
            nowMs: params.nowMs,
          }),
        ];
      }

      if (
        params.config.maxHoldMs > 0 &&
        params.nowMs - entry.enteredAtMs > params.config.maxHoldMs &&
        pnlEdge < 0
      ) {
        return [
          buildSniperExitSignal(params.market, params.orderbook, {
            entry,
            shares: exitShares,
            bestBid,
            edgeAmount: pnlEdge,
            signalType: 'SNIPER_SCALP_EXIT',
            urgency: 'cross',
            reason: `Sniper time stop: held ${(params.nowMs - entry.enteredAtMs)}ms with pnl ${(pnlEdge * 100).toFixed(2)}%`,
            nowMs: params.nowMs,
          }),
        ];
      }
    }

    return [];
  }

  private buildEntrySignal(candidate: SniperCandidate): StrategySignal {
    const movePct = Math.abs(candidate.binanceAssessment.binanceMovePct);
    const book = candidate.expectedWinner === 'YES' ? candidate.orderbook.yes : candidate.orderbook.no;
    this.totalSignals += 1;
    this.lastSignalAt = new Date(candidate.nowMs).toISOString();
    this.trackCoinSignal(candidate.coin);
    logger.info('Sniper signal generated', {
      marketId: candidate.market.marketId,
      coin: candidate.coin,
      direction: candidate.binanceAssessment.direction,
      binanceMovePct: roundTo(candidate.binanceAssessment.binanceMovePct, 4),
      expectedWinner: candidate.expectedWinner,
      bestAsk: roundTo(candidate.bestAsk, 4),
      impliedFV: roundTo(candidate.impliedFV, 4),
      edge: roundTo(candidate.edge, 4),
      pmLag: roundTo(candidate.pmLag, 4),
      shares: candidate.shares,
    });

    return {
      marketId: candidate.market.marketId,
      marketTitle: candidate.market.title,
      signalType: 'SNIPER_BUY',
      priority: 1_200,
      generatedAt: candidate.nowMs,
      action: 'BUY',
      outcome: candidate.expectedWinner,
      outcomeIndex: candidate.expectedWinner === 'YES' ? 0 : 1,
      shares: candidate.shares,
      targetPrice: roundTo(candidate.bestAsk, 6),
      referencePrice: candidate.impliedFV,
      tokenPrice: book.lastTradePrice ?? candidate.bestAsk,
      midPrice: book.midPrice,
      fairValue: candidate.impliedFV,
      edgeAmount: candidate.edge,
      combinedBid: candidate.orderbook.combined.combinedBid,
      combinedAsk: candidate.orderbook.combined.combinedAsk,
      combinedMid: candidate.orderbook.combined.combinedMid,
      combinedDiscount: candidate.orderbook.combined.combinedDiscount,
      combinedPremium: candidate.orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier:
        movePct >= this.runtimeConfig.sniper.strongBinanceMovePct ? 1.5 : 1,
      urgency: 'cross',
      reduceOnly: false,
      reason:
        `Sniper BUY ${candidate.expectedWinner}: Binance ${candidate.binanceAssessment.direction} ${movePct.toFixed(3)}%` +
        ` | PM ask ${candidate.bestAsk.toFixed(3)}` +
        ` | impliedFV ${candidate.impliedFV.toFixed(3)}` +
        ` | edge ${(candidate.edge * 100).toFixed(2)}% after ${(this.runtimeConfig.sniper.takerFeePct * 100).toFixed(2)}% fee`,
      strategyLayer: resolveStrategyLayer('SNIPER_BUY'),
    };
  }

  private reject(evaluation: SniperEvaluation): StrategySignal[] {
    this.logRejection(evaluation);
    return [];
  }

  private logRejection(evaluation: SniperEvaluation): void {
    logger.debug('Sniper: rejected', {
      marketId: evaluation.marketId,
      coin: evaluation.coin,
      rejection: evaluation.rejection,
      binanceMovePct:
        evaluation.binanceMovePct !== null
          ? roundTo(evaluation.binanceMovePct, 4)
          : null,
      direction: evaluation.direction,
      bestAsk: evaluation.bestAsk !== null ? roundTo(evaluation.bestAsk, 4) : null,
      edge: evaluation.edge !== null ? roundTo(evaluation.edge, 4) : null,
      pmLag: evaluation.pmLag !== null ? roundTo(evaluation.pmLag, 4) : null,
      impliedFV:
        evaluation.impliedFV !== null ? roundTo(evaluation.impliedFV, 4) : null,
    });

    this.lastRejectionReason = evaluation.rejection;
    this.rejectionCounts.set(
      evaluation.rejection,
      (this.rejectionCounts.get(evaluation.rejection) ?? 0) + 1
    );

    const nowMs = Date.now();
    if (
      nowMs - this.lastRejectionSummaryMs <
      SniperEngine.REJECTION_SUMMARY_INTERVAL_MS
    ) {
      return;
    }

    this.lastRejectionSummaryMs = nowMs;
    const summary: Record<string, number> = {};
    for (const [reason, count] of this.rejectionCounts.entries()) {
      summary[reason] = count;
    }
    const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      logger.info('Sniper rejection summary (last 30s)', {
        total,
        ...summary,
      });
      this.rejectionCounts.clear();
    }
  }

  private trackCoinEval(coin: string, movePct: number, isSignal: boolean): void {
    const normalizedCoin = coin.trim().toUpperCase() || 'UNKNOWN';
    const existing = this.coinEvals.get(normalizedCoin) ?? {
      evals: 0,
      signals: 0,
      moves: [],
    };
    existing.evals += 1;
    if (isSignal) {
      existing.signals += 1;
    }
    existing.moves.push(Math.abs(movePct));
    if (existing.moves.length > SniperEngine.MAX_COIN_MOVE_SAMPLES) {
      existing.moves.shift();
    }
    this.coinEvals.set(normalizedCoin, existing);
  }

  private trackCoinSignal(coin: string): void {
    const normalizedCoin = coin.trim().toUpperCase() || 'UNKNOWN';
    const existing = this.coinEvals.get(normalizedCoin) ?? {
      evals: 0,
      signals: 0,
      moves: [],
    };
    existing.signals += 1;
    this.coinEvals.set(normalizedCoin, existing);
  }

  private trackNearMiss(edge: number, threshold: number): void {
    if (edge > 0 && edge < threshold && edge >= threshold - 0.005) {
      this.nearMissCount += 1;
    }
  }

  private trackEdge(edge: number): void {
    if (edge > this.bestEdge) {
      this.bestEdge = edge;
    }
  }

  private pruneDirectionWindows(nowMs: number): void {
    for (const [key, window] of this.directionWindows.entries()) {
      window.entries = window.entries.filter(
        (entry) => nowMs - entry.enteredAtMs < 5 * 60_000
      );
      if (
        window.entries.length === 0 &&
        nowMs - window.windowStartMs >= 5 * 60_000
      ) {
        this.directionWindows.delete(key);
      }
    }
  }

  private recordDirectionEntry(
    windowKey: string,
    candidate: SniperCandidate,
    nowMs: number
  ): void {
    const direction = candidate.binanceAssessment.direction;
    if (direction !== 'UP' && direction !== 'DOWN') {
      return;
    }

    const windowStartMs = resolveDirectionWindowStart(candidate.slotStartMs, nowMs);
    const window = this.directionWindows.get(windowKey) ?? {
      direction,
      windowStartMs,
      entries: [],
    };
    window.entries = window.entries.filter(
      (entry) => nowMs - entry.enteredAtMs < 5 * 60_000
    );
    if (window.entries.some((entry) => entry.coin === candidate.coin)) {
      this.directionWindows.set(windowKey, window);
      return;
    }

    window.entries.push({
      coin: candidate.coin,
      marketId: candidate.market.marketId,
      enteredAtMs: nowMs,
      edge: candidate.edge,
    });
    this.directionWindows.set(windowKey, window);
  }

  private buildDirectionWindowKey(
    direction: 'UP' | 'DOWN' | 'FLAT',
    slotStartMs: number | null,
    nowMs: number
  ): string {
    return `${direction}:${resolveDirectionWindowStart(slotStartMs, nowMs)}`;
  }

  private getCurrentDirectionWindowSnapshot(): SniperStatsSnapshot['currentDirectionWindow'] {
    let current: DirectionWindowState | null = null;
    for (const window of this.directionWindows.values()) {
      if (window.entries.length === 0) {
        continue;
      }

      if (!current || window.windowStartMs > current.windowStartMs) {
        current = window;
      }
    }

    if (!current) {
      return null;
    }

    const activeCoins = Array.from(
      new Set(current.entries.map((entry) => entry.coin))
    );
    return {
      direction: current.direction,
      activeCoins,
      capacity: `${activeCoins.length}/${this.runtimeConfig.sniper.maxConcurrentSameDirection}`,
    };
  }
}

function buildSniperExitSignal(
  market: MarketCandidate,
  orderbook: MarketOrderbookSnapshot,
  params: {
    entry: SniperEntry;
    shares: number;
    bestBid: number;
    edgeAmount: number;
    signalType: 'SNIPER_SCALP_EXIT';
    urgency: StrategySignal['urgency'];
    reason: string;
    nowMs: number;
  }
): StrategySignal {
  return {
    marketId: market.marketId,
    marketTitle: market.title,
    signalType: params.signalType,
    priority: 980,
    generatedAt: params.nowMs,
    action: 'SELL',
    outcome: params.entry.outcome,
    outcomeIndex: params.entry.outcome === 'YES' ? 0 : 1,
    shares: params.shares,
    targetPrice: roundTo(params.bestBid, 6),
    referencePrice: params.entry.entryPrice,
    tokenPrice: params.bestBid,
    midPrice: params.entry.outcome === 'YES' ? orderbook.yes.midPrice : orderbook.no.midPrice,
    fairValue: params.entry.entryPrice,
    edgeAmount: params.edgeAmount,
    combinedBid: orderbook.combined.combinedBid,
    combinedAsk: orderbook.combined.combinedAsk,
    combinedMid: orderbook.combined.combinedMid,
    combinedDiscount: orderbook.combined.combinedDiscount,
    combinedPremium: orderbook.combined.combinedPremium,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: params.urgency,
    reduceOnly: true,
    reason: params.reason,
    strategyLayer: resolveStrategyLayer(params.signalType),
  };
}

function supportsSniperVelocity(
  direction: 'UP' | 'DOWN' | 'FLAT',
  velocityPctPerSec: number | null,
  minVelocityPctPerSec: number
): boolean {
  if (minVelocityPctPerSec <= 0 || velocityPctPerSec === null || direction === 'FLAT') {
    return true;
  }

  if (direction === 'UP') {
    return velocityPctPerSec >= minVelocityPctPerSec;
  }

  return velocityPctPerSec <= -minVelocityPctPerSec;
}

function resolveCoinLabel(title: string): string {
  const prefix = title.trim().split(/\s+/)[0];
  return prefix ? prefix.toUpperCase() : 'UNKNOWN';
}

function parseSlotBoundary(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveDirectionWindowStart(slotStartMs: number | null, nowMs: number): number {
  if (slotStartMs !== null) {
    return slotStartMs;
  }

  const slotSizeMs = 5 * 60_000;
  return Math.floor(nowMs / slotSizeMs) * slotSizeMs;
}
