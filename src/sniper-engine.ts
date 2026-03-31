import type { BinanceEdgeAssessment } from './binance-edge.js';
import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import type { AppConfig, SniperConfig } from './config.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { SniperStatsSnapshot } from './runtime-status.js';
import type { StrategySignal } from './strategy-types.js';
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
  private readonly lastEntryAt = new Map<string, number>();
  private readonly rejectionCounts = new Map<SniperRejection, number>();
  private readonly coinEvals = new Map<string, CoinEvalState>();
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

  shouldSuppressLegacyForcedSignal(
    signal: Pick<StrategySignal, 'marketId' | 'outcome' | 'signalType'>
  ): boolean {
    if (
      !this.runtimeConfig.SNIPER_MODE_ENABLED ||
      !this.hasActiveEntryFor(signal.marketId, signal.outcome)
    ) {
      return false;
    }

    if (signal.signalType === 'TRAILING_TAKE_PROFIT') {
      return true;
    }

    return signal.signalType === 'SLOT_FLATTEN' && this.runtimeConfig.sniper.maxHoldMs === 0;
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

    const existing = this.activeEntries.get(key);
    if (!existing) {
      return;
    }

    const remainingShares = roundTo(existing.shares - shares, 4);
    if (remainingShares <= 0.0001) {
      this.activeEntries.delete(key);
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

    const assessment = params.binanceAssessment;
    if (!assessment?.available) {
      this.trackCoinEval(coin, 0, false);
      return this.reject({
        ...evaluationBase,
        rejection: 'no_binance_data',
      });
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
      return this.reject({
        ...evaluationBase,
        rejection: 'direction_flat',
      });
    }

    if (!Number.isFinite(movePct) || movePct < params.config.minBinanceMovePct) {
      return this.reject({
        ...evaluationBase,
        rejection: 'move_too_small',
      });
    }

    if (
      !supportsSniperVelocity(
        assessment.direction,
        params.binanceVelocityPctPerSec ?? null,
        params.config.minVelocityPctPerSec
      )
    ) {
      return this.reject({
        ...evaluationBase,
        rejection: 'velocity_too_low',
      });
    }

    const slotStartMs = Date.parse(params.market.startTime);
    const slotEndMs = Date.parse(params.market.endTime);
    if (Number.isFinite(slotStartMs) && nowMs - slotStartMs < params.config.slotWarmupMs) {
      return this.reject({
        ...evaluationBase,
        rejection: 'slot_too_early',
      });
    }
    if (Number.isFinite(slotEndMs) && slotEndMs - nowMs < params.config.exitBeforeEndMs) {
      return this.reject({
        ...evaluationBase,
        rejection: 'slot_too_late',
      });
    }

    const expectedWinner = resolveSniperExpectedWinner(assessment.direction);
    if (!expectedWinner || params.blockedOutcomes?.has(expectedWinner)) {
      return this.reject({
        ...evaluationBase,
        rejection: 'outcome_blocked',
      });
    }

    const marketCooldownAt = this.lastEntryAt.get(params.market.marketId);
    if (
      marketCooldownAt !== undefined &&
      nowMs - marketCooldownAt < params.config.cooldownMs
    ) {
      return this.reject({
        ...evaluationBase,
        rejection: 'cooldown_active',
      });
    }

    const currentWinnerShares = params.positionManager.getShares(expectedWinner);
    const oppositeWinnerShares = params.positionManager.getShares(
      expectedWinner === 'YES' ? 'NO' : 'YES'
    );
    if (oppositeWinnerShares > 0.0001 || currentWinnerShares >= params.config.maxPositionShares) {
      return this.reject({
        ...evaluationBase,
        rejection: 'max_position_reached',
      });
    }

    const book = expectedWinner === 'YES' ? params.orderbook.yes : params.orderbook.no;
    const bestAsk = book.bestAsk;
    if (bestAsk === null) {
      return this.reject({
        ...evaluationBase,
        rejection: 'no_ask_available',
      });
    }
    if (bestAsk < params.config.minEntryPrice) {
      return this.reject({
        ...evaluationBase,
        bestAsk,
        rejection: 'ask_price_too_low',
      });
    }
    if (bestAsk > params.config.maxEntryPrice) {
      return this.reject({
        ...evaluationBase,
        bestAsk,
        rejection: 'ask_price_too_high',
      });
    }

    const binanceImpliedFV = estimateFairValueFromBinance(
      assessment.binanceMovePct,
      assessment.direction,
      expectedWinner,
      params.config.volatilityScale
    );
    const totalCost = roundTo(bestAsk * (1 + params.config.takerFeePct), 6);
    const edge = roundTo(binanceImpliedFV - totalCost, 6);
    this.trackEdge(edge);
    this.trackNearMiss(edge, params.config.minEdgeAfterFees);
    if (edge < params.config.minEdgeAfterFees) {
      return this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        impliedFV: binanceImpliedFV,
        rejection: 'edge_too_low',
      });
    }

    const pmLag = roundTo(Math.abs(binanceImpliedFV - bestAsk), 6);
    if (pmLag < params.config.minPmLagPct) {
      return this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        pmLag,
        impliedFV: binanceImpliedFV,
        rejection: 'pm_already_repriced',
      });
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
      return this.reject({
        ...evaluationBase,
        bestAsk,
        edge,
        pmLag,
        impliedFV: binanceImpliedFV,
        rejection: 'max_position_reached',
      });
    }

    this.totalSignals += 1;
    this.lastSignalAt = new Date(nowMs).toISOString();
    this.trackCoinSignal(assessment.coin);
    logger.info('Sniper signal generated', {
      marketId: params.market.marketId,
      coin: assessment.coin,
      direction: assessment.direction,
      binanceMovePct: roundTo(assessment.binanceMovePct, 4),
      expectedWinner,
      bestAsk: roundTo(bestAsk, 4),
      impliedFV: roundTo(binanceImpliedFV, 4),
      edge: roundTo(edge, 4),
      pmLag: roundTo(pmLag, 4),
      shares,
    });

    return [
      {
        marketId: params.market.marketId,
        marketTitle: params.market.title,
        signalType: 'SNIPER_BUY',
        priority: 1_200,
        generatedAt: nowMs,
        action: 'BUY',
        outcome: expectedWinner,
        outcomeIndex: expectedWinner === 'YES' ? 0 : 1,
        shares,
        targetPrice: roundTo(bestAsk, 6),
        referencePrice: binanceImpliedFV,
        tokenPrice: book.lastTradePrice ?? bestAsk,
        midPrice: book.midPrice,
        fairValue: binanceImpliedFV,
        edgeAmount: edge,
        combinedBid: params.orderbook.combined.combinedBid,
        combinedAsk: params.orderbook.combined.combinedAsk,
        combinedMid: params.orderbook.combined.combinedMid,
        combinedDiscount: params.orderbook.combined.combinedDiscount,
        combinedPremium: params.orderbook.combined.combinedPremium,
        fillRatio: 1,
        capitalClamp: 1,
        priceMultiplier: movePct >= params.config.strongBinanceMovePct ? 1.5 : 1,
        urgency: 'cross',
        reduceOnly: false,
        reason:
          `Sniper BUY ${expectedWinner}: Binance ${assessment.direction} ${movePct.toFixed(3)}%` +
          ` | PM ask ${bestAsk.toFixed(3)}` +
          ` | impliedFV ${binanceImpliedFV.toFixed(3)}` +
          ` | edge ${(edge * 100).toFixed(2)}% after ${(params.config.takerFeePct * 100).toFixed(2)}% fee`,
      },
    ];
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
    };
  }

  private generateExitSignals(params: {
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
        this.activeEntries.delete(buildSniperEntryKey(entry.marketId, entry.outcome));
        continue;
      }

      const book = entry.outcome === 'YES' ? params.orderbook.yes : params.orderbook.no;
      const bestBid = book.bestBid;
      if (bestBid === null) {
        continue;
      }

      const exitShares = roundTo(Math.min(currentShares, entry.shares), 4);
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
            urgency: 'improve',
            reason: `Sniper time stop: held ${(params.nowMs - entry.enteredAtMs)}ms with pnl ${(pnlEdge * 100).toFixed(2)}%`,
            nowMs: params.nowMs,
          }),
        ];
      }
    }

    return [];
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
