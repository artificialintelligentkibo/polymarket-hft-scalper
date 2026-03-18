import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeCombinedBookMetrics, type MarketOrderbookSnapshot, type Outcome } from '../src/clob-fetcher.js';
import { config } from '../src/config.js';
import { buildFlattenSignals } from '../src/flatten-signals.js';
import { logger, TradeLogger } from '../src/logger.js';
import type { MarketCandidate } from '../src/monitor.js';
import { getSlotKey } from '../src/monitor.js';
import { PositionManager } from '../src/position-manager.js';
import { RiskManager } from '../src/risk-manager.js';
import { SignalScalper } from '../src/signal-scalper.js';
import type { SignalType, StrategySignal } from '../src/strategy-types.js';
import {
  asString,
  normalizeTimestampString,
  roundTo,
  toFiniteNumberOrNull,
} from '../src/utils.js';

interface RawBacktestSample {
  timestampMs: number;
  marketId: string;
  marketTitle: string;
  slotStart: string | null;
  slotEnd: string | null;
  liquidityUsd: number;
  outcome: Outcome;
  tokenPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depthSharesBid: number;
  depthSharesAsk: number;
}

interface PairedBacktestSample {
  timestampMs: number;
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
}

interface SignalTypeStats {
  signalType: SignalType;
  trades: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  winRate: number;
}

interface ObservedTradeComparison {
  observedTrades: number;
  matchedTrades: number;
  matchRate: number;
}

interface BacktestSummary {
  samples: number;
  pairedSamples: number;
  markets: number;
  realizedPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  forcedExitCount: number;
  signalTypeStats: SignalTypeStats[];
  slotPnl: Array<{ slotKey: string; pnl: number }>;
  observedComparison?: ObservedTradeComparison | null;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.resolve(process.cwd(), 'backtest', 'data', 'sample.jsonl');
  const observedPath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : null;

  const pairedSamples = await loadPairedSamples(inputPath);
  const observedTrades = observedPath ? await loadObservedTrades(observedPath) : [];
  const summary = await runBacktest(pairedSamples, observedTrades);

  console.log(JSON.stringify(summary, null, 2));
}

export async function runBacktest(
  samples: PairedBacktestSample[],
  observedTrades: ObservedTradeRecord[] = [],
  tradeLogger?: TradeLogger
): Promise<BacktestSummary> {
  const managers = new Map<string, PositionManager>();
  const latestBooks = new Map<string, MarketOrderbookSnapshot>();
  const marketsSeen = new Set<string>();
  const riskManager = new RiskManager();
  const signalEngine = new SignalScalper();
  const signalStats = new Map<SignalType, { trades: number; wins: number; losses: number; realizedPnl: number }>();
  const slotPnl = new Map<string, number>();
  const equitySeries: number[] = [];
  let peakEquity = 0;
  let maxDrawdown = 0;
  let forcedExitCount = 0;
  let executedSignals = 0;

  const orderedSamples = [...samples].sort((left, right) => left.timestampMs - right.timestampMs);

  for (const sample of orderedSamples) {
    marketsSeen.add(sample.market.marketId);
    latestBooks.set(sample.market.marketId, sample.orderbook);

    const manager = getManager(managers, sample.market);
    const riskAssessment = riskManager.checkRiskLimits({
      market: sample.market,
      orderbook: sample.orderbook,
      positionManager: manager,
      now: new Date(sample.timestampMs),
    });
    const signals = signalEngine.generateSignals({
      market: sample.market,
      orderbook: sample.orderbook,
      positionManager: manager,
      riskAssessment,
      now: new Date(sample.timestampMs),
    });

    for (const signal of signals) {
      executedSignals += 1;
      const executionPrice = resolveBacktestPrice(signal, sample.orderbook);
      if (executionPrice === null || executionPrice <= 0) {
        continue;
      }

      const before = manager.getSnapshot();
      const after = manager.applyFill({
        outcome: signal.outcome,
        side: signal.action,
        shares: signal.shares,
        price: executionPrice,
        timestamp: new Date(sample.timestampMs).toISOString(),
      });
      const realizedDelta = roundTo(after.realizedPnl - before.realizedPnl, 4);
      const slotKey = getSlotKey(sample.market);

      if (realizedDelta !== 0) {
        slotPnl.set(slotKey, roundTo((slotPnl.get(slotKey) ?? 0) + realizedDelta, 4));
      }

      if (
        signal.signalType === 'SLOT_FLATTEN' ||
        signal.signalType === 'HARD_STOP' ||
        signal.signalType === 'TRAILING_TAKE_PROFIT' ||
        signal.signalType === 'RISK_LIMIT'
      ) {
        forcedExitCount += 1;
      }

      const stats = signalStats.get(signal.signalType) ?? {
        trades: 0,
        wins: 0,
        losses: 0,
        realizedPnl: 0,
      };
      stats.trades += 1;
      stats.realizedPnl = roundTo(stats.realizedPnl + realizedDelta, 4);
      if (realizedDelta > 0) {
        stats.wins += 1;
      }
      if (realizedDelta < 0) {
        stats.losses += 1;
      }
      signalStats.set(signal.signalType, stats);

      if (tradeLogger) {
        const book = signal.outcome === 'YES' ? sample.orderbook.yes : sample.orderbook.no;
        await tradeLogger.logTrade({
          phase: 'backtest',
          timestampMs: sample.timestampMs,
          slotKey,
          marketId: sample.market.marketId,
          marketTitle: sample.market.title,
          slotStart: sample.market.startTime,
          slotEnd: sample.market.endTime,
          tokenId: `${sample.market.marketId}:${signal.outcome}`,
          outcome: signal.outcome,
          outcomeIndex: signal.outcomeIndex,
          action: signal.action,
          reason: signal.reason,
          signalType: signal.signalType,
          priority: signal.priority,
          urgency: signal.urgency,
          reduceOnly: signal.reduceOnly,
          tokenPrice: signal.tokenPrice,
          referencePrice: signal.referencePrice,
          fairValue: signal.fairValue,
          midPrice: signal.midPrice,
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          combinedBid: signal.combinedBid,
          combinedAsk: signal.combinedAsk,
          combinedMid: signal.combinedMid,
          combinedDiscount: signal.combinedDiscount,
          combinedPremium: signal.combinedPremium,
          edgeAmount: signal.edgeAmount,
          shares: signal.shares,
          notionalUsd: signal.shares * executionPrice,
          liquidityUsd: sample.market.liquidityUsd,
          fillRatio: signal.fillRatio,
          capitalClamp: signal.capitalClamp,
          priceMultiplier: signal.priceMultiplier,
          inventoryImbalance: after.inventoryImbalance,
          grossExposureShares: after.grossExposureShares,
          netYesShares: after.yesShares,
          netNoShares: after.noShares,
          signedNetShares: after.signedNetShares,
          realizedPnl: after.realizedPnl,
          unrealizedPnl: after.unrealizedPnl,
          totalPnl: after.totalPnl,
          wasMaker: null,
          simulationMode: true,
          dryRun: true,
          testMode: true,
        });
      }
    }

    const equity = sumTotalPnl(managers);
    equitySeries.push(equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
  }

  for (const [marketId, manager] of managers.entries()) {
    const snapshot = manager.getSnapshot();
    if (snapshot.yesShares <= 0 && snapshot.noShares <= 0) {
      continue;
    }

    const orderbook = latestBooks.get(marketId);
    const market = samples.find((sample) => sample.market.marketId === marketId)?.market;
    if (!orderbook || !market) {
      continue;
    }

    for (const signal of buildFlattenSignals({
      market,
      orderbook,
      snapshot,
      signalType: 'SLOT_FLATTEN',
      reasonPrefix: 'Backtest final',
    })) {
      const before = manager.getSnapshot();
      const executionPrice = resolveBacktestPrice(signal, orderbook);
      if (executionPrice === null || executionPrice <= 0) {
        continue;
      }

      const after = manager.applyFill({
        outcome: signal.outcome,
        side: signal.action,
        shares: signal.shares,
        price: executionPrice,
      });
      const realizedDelta = roundTo(after.realizedPnl - before.realizedPnl, 4);
      const stats = signalStats.get(signal.signalType) ?? {
        trades: 0,
        wins: 0,
        losses: 0,
        realizedPnl: 0,
      };
      stats.trades += 1;
      stats.realizedPnl = roundTo(stats.realizedPnl + realizedDelta, 4);
      if (realizedDelta > 0) {
        stats.wins += 1;
      }
      if (realizedDelta < 0) {
        stats.losses += 1;
      }
      signalStats.set(signal.signalType, stats);
      forcedExitCount += 1;
    }
  }

  const realizedPnl = roundTo(sumRealizedPnl(managers), 4);
  const totalPnl = roundTo(sumTotalPnl(managers), 4);
  const slotPnlRows = Array.from(slotPnl.entries())
    .map(([slotKey, pnl]) => ({ slotKey, pnl: roundTo(pnl, 4) }))
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey));
  const observedComparison = compareAgainstObservedTrades(samples, observedTrades);

  const summary: BacktestSummary = {
    samples: countRawSamples(samples),
    pairedSamples: orderedSamples.length,
    markets: marketsSeen.size,
    realizedPnl,
    totalPnl,
    maxDrawdown: roundTo(maxDrawdown, 4),
    sharpe: roundTo(computeSharpe(slotPnlRows.map((entry) => entry.pnl)), 4),
    forcedExitCount,
    signalTypeStats: Array.from(signalStats.entries())
      .map(([signalType, stats]) => ({
        signalType,
        trades: stats.trades,
        wins: stats.wins,
        losses: stats.losses,
        realizedPnl: roundTo(stats.realizedPnl, 4),
        winRate: stats.trades > 0 ? roundTo(stats.wins / stats.trades, 4) : 0,
      }))
      .sort((left, right) => left.signalType.localeCompare(right.signalType)),
    slotPnl: slotPnlRows,
    observedComparison,
  };

  if (tradeLogger) {
    await tradeLogger.logBacktestSummary({
      ...summary,
      executedSignals,
    });
  }

  logger.info('Backtest completed', summary);
  return summary;
}

async function loadPairedSamples(filePath: string): Promise<PairedBacktestSample[]> {
  const raw = await readFile(filePath, 'utf8');
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRawSample(JSON.parse(line) as Record<string, unknown>))
    .filter((sample): sample is RawBacktestSample => sample !== null);

  const grouped = new Map<string, { YES?: RawBacktestSample; NO?: RawBacktestSample }>();
  for (const row of rows) {
    const key = `${row.marketId}:${row.timestampMs}`;
    const existing = grouped.get(key) ?? {};
    existing[row.outcome] = row;
    grouped.set(key, existing);
  }

  const pairedSamples: PairedBacktestSample[] = [];
  for (const entry of grouped.values()) {
    const seed = entry.YES ?? entry.NO;
    if (!seed) {
      continue;
    }

    const yes = entry.YES ?? buildMissingSide(seed, 'YES');
    const no = entry.NO ?? buildMissingSide(seed, 'NO');
    const market = buildMarketCandidate(seed, yes, no);
    const orderbook = buildOrderbook(seed, market, yes, no);
    pairedSamples.push({
      timestampMs: seed.timestampMs,
      market,
      orderbook,
    });
  }

  return pairedSamples.sort((left, right) => left.timestampMs - right.timestampMs);
}

async function loadObservedTrades(filePath: string): Promise<ObservedTradeRecord[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeObservedTrade(JSON.parse(line) as Record<string, unknown>))
    .filter((record): record is ObservedTradeRecord => record !== null);
}

function normalizeRawSample(record: Record<string, unknown>): RawBacktestSample | null {
  const outcome = resolveOutcome(record);
  if (!outcome) {
    return null;
  }

  const timestampMs = normalizeTimestamp(record.timestamp_ms ?? record.timestamp);
  const marketId = asString(record.market_id ?? record.market_condition_id ?? record.marketId);
  if (!timestampMs || !marketId) {
    return null;
  }

  const liquidityUsd =
    toFiniteNumberOrNull(record.liquidity_usd ?? record.liquidity) ??
    config.strategy.minLiquidityUsd;
  const bestBid = toFiniteNumberOrNull(record.best_bid ?? record.bestBid);
  const bestAsk = toFiniteNumberOrNull(record.best_ask ?? record.bestAsk);

  return {
    timestampMs,
    marketId,
    marketTitle:
      asString(record.market_title ?? record.marketTitle ?? record.title ?? record.question) ||
      marketId,
    slotStart: normalizeTimeString(record.slot_start ?? record.slotStart),
    slotEnd: normalizeTimeString(record.slot_end ?? record.slotEnd),
    liquidityUsd,
    outcome,
    tokenPrice: toFiniteNumberOrNull(record.token_price ?? record.tokenPrice),
    midPrice: toFiniteNumberOrNull(
      record.mid_price_orderbook ?? record.mid_price ?? record.midPrice
    ),
    bestBid,
    bestAsk,
    depthSharesBid:
      toFiniteNumberOrNull(
        record.depth_shares_bid ?? record.depthSharesBid ?? record.depth_shares
      ) ??
      config.strategy.minShares,
    depthSharesAsk:
      toFiniteNumberOrNull(
        record.depth_shares_ask ?? record.depthSharesAsk ?? record.depth_shares
      ) ??
      config.strategy.minShares,
  };
}

function buildMarketCandidate(
  seed: RawBacktestSample,
  yes: RawBacktestSample,
  no: RawBacktestSample
): MarketCandidate {
  return {
    marketId: seed.marketId,
    conditionId: seed.marketId,
    title: seed.marketTitle,
    liquidityUsd: Math.max(yes.liquidityUsd, no.liquidityUsd),
    volumeUsd: 0,
    startTime: seed.slotStart,
    endTime: seed.slotEnd,
    durationMinutes: computeDurationMinutes(seed.slotStart, seed.slotEnd),
    yesTokenId: `${seed.marketId}:YES`,
    noTokenId: `${seed.marketId}:NO`,
    yesLabel: 'Up',
    noLabel: 'Down',
    yesOutcomeIndex: 0,
    noOutcomeIndex: 1,
    acceptingOrders: true,
  };
}

function buildOrderbook(
  seed: RawBacktestSample,
  market: MarketCandidate,
  yes: RawBacktestSample,
  no: RawBacktestSample
): MarketOrderbookSnapshot {
  const yesBook = {
    tokenId: market.yesTokenId,
    bids: buildSyntheticLevels(yes.bestBid, yes.depthSharesBid),
    asks: buildSyntheticLevels(yes.bestAsk, yes.depthSharesAsk),
    bestBid: yes.bestBid,
    bestAsk: yes.bestAsk,
    midPrice: yes.midPrice,
    spread:
      yes.bestBid !== null && yes.bestAsk !== null ? roundTo(yes.bestAsk - yes.bestBid, 6) : null,
    spreadBps:
      yes.bestBid !== null && yes.bestAsk !== null && yes.midPrice
        ? roundTo(((yes.bestAsk - yes.bestBid) / yes.midPrice) * 10_000, 2)
        : null,
    depthSharesBid: yes.depthSharesBid,
    depthSharesAsk: yes.depthSharesAsk,
    depthNotionalBid: roundTo((yes.bestBid ?? 0) * yes.depthSharesBid, 4),
    depthNotionalAsk: roundTo((yes.bestAsk ?? 0) * yes.depthSharesAsk, 4),
    lastTradePrice: yes.tokenPrice,
    lastTradeSize: yes.depthSharesBid,
    source: 'rest' as const,
    updatedAt: new Date(seed.timestampMs).toISOString(),
  };
  const noBook = {
    tokenId: market.noTokenId,
    bids: buildSyntheticLevels(no.bestBid, no.depthSharesBid),
    asks: buildSyntheticLevels(no.bestAsk, no.depthSharesAsk),
    bestBid: no.bestBid,
    bestAsk: no.bestAsk,
    midPrice: no.midPrice,
    spread:
      no.bestBid !== null && no.bestAsk !== null ? roundTo(no.bestAsk - no.bestBid, 6) : null,
    spreadBps:
      no.bestBid !== null && no.bestAsk !== null && no.midPrice
        ? roundTo(((no.bestAsk - no.bestBid) / no.midPrice) * 10_000, 2)
        : null,
    depthSharesBid: no.depthSharesBid,
    depthSharesAsk: no.depthSharesAsk,
    depthNotionalBid: roundTo((no.bestBid ?? 0) * no.depthSharesBid, 4),
    depthNotionalAsk: roundTo((no.bestAsk ?? 0) * no.depthSharesAsk, 4),
    lastTradePrice: no.tokenPrice,
    lastTradeSize: no.depthSharesBid,
    source: 'rest' as const,
    updatedAt: new Date(seed.timestampMs).toISOString(),
  };

  return {
    marketId: market.marketId,
    title: market.title,
    timestamp: new Date(seed.timestampMs).toISOString(),
    yes: yesBook,
    no: noBook,
    combined: computeCombinedBookMetrics(yesBook, noBook),
  };
}

function resolveBacktestPrice(
  signal: StrategySignal,
  orderbook: MarketOrderbookSnapshot
): number | null {
  const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;

  if (signal.action === 'BUY') {
    if (signal.urgency === 'cross') {
      return book.bestAsk ?? signal.targetPrice;
    }
    if (signal.urgency === 'improve') {
      return Math.min(book.bestAsk ?? signal.targetPrice ?? 1, signal.targetPrice ?? book.bestAsk ?? 1);
    }
    return signal.targetPrice ?? book.bestBid ?? book.bestAsk;
  }

  if (signal.urgency === 'cross') {
    return book.bestBid ?? signal.targetPrice;
  }
  if (signal.urgency === 'improve') {
    return Math.max(book.bestBid ?? 0, signal.targetPrice ?? book.bestBid ?? 0);
  }
  return signal.targetPrice ?? book.bestAsk ?? book.bestBid;
}

function getManager(
  managers: Map<string, PositionManager>,
  market: MarketCandidate
): PositionManager {
  const existing = managers.get(market.marketId);
  if (existing) {
    existing.setSlotEndsAt(market.endTime);
    return existing;
  }

  const created = new PositionManager(market.marketId, market.endTime);
  managers.set(market.marketId, created);
  return created;
}

function sumRealizedPnl(managers: Map<string, PositionManager>): number {
  let total = 0;
  for (const manager of managers.values()) {
    total += manager.getSnapshot().realizedPnl;
  }
  return total;
}

function sumTotalPnl(managers: Map<string, PositionManager>): number {
  let total = 0;
  for (const manager of managers.values()) {
    total += manager.getSnapshot().totalPnl;
  }
  return total;
}

function computeSharpe(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  if (!Number.isFinite(stdDev) || stdDev === 0) {
    return 0;
  }

  return (mean / stdDev) * Math.sqrt(values.length);
}

interface ObservedTradeRecord {
  timestampMs: number;
  marketId: string;
  outcome: Outcome;
  action: 'BUY' | 'SELL';
}

function normalizeObservedTrade(record: Record<string, unknown>): ObservedTradeRecord | null {
  const timestampMs = normalizeTimestamp(record.timestamp_ms ?? record.timestamp);
  const marketId = asString(record.market_id ?? record.marketId);
  const outcome = resolveOutcome(record);
  const action = String(record.action ?? '').trim().toUpperCase();

  if (!timestampMs || !marketId || !outcome || (action !== 'BUY' && action !== 'SELL')) {
    return null;
  }

  return {
    timestampMs,
    marketId,
    outcome,
    action,
  };
}

function compareAgainstObservedTrades(
  samples: PairedBacktestSample[],
  observedTrades: ObservedTradeRecord[]
): ObservedTradeComparison | null {
  if (observedTrades.length === 0) {
    return null;
  }

  const observedKeys = new Set(
    observedTrades.map((trade) => `${trade.marketId}:${trade.outcome}:${trade.action}:${bucketMinute(trade.timestampMs)}`)
  );

  let matchedTrades = 0;
  for (const sample of samples) {
    const minuteBucket = bucketMinute(sample.timestampMs);
    if (observedKeys.has(`${sample.market.marketId}:YES:BUY:${minuteBucket}`)) {
      matchedTrades += 1;
    }
    if (observedKeys.has(`${sample.market.marketId}:NO:BUY:${minuteBucket}`)) {
      matchedTrades += 1;
    }
  }

  return {
    observedTrades: observedTrades.length,
    matchedTrades,
    matchRate: observedTrades.length > 0 ? roundTo(matchedTrades / observedTrades.length, 4) : 0,
  };
}

function buildMissingSide(seed: RawBacktestSample, outcome: Outcome): RawBacktestSample {
  return {
    ...seed,
    outcome,
    tokenPrice: null,
    midPrice: null,
    bestBid: null,
    bestAsk: null,
    depthSharesBid: config.strategy.minShares,
    depthSharesAsk: config.strategy.minShares,
  };
}

function buildSyntheticLevels(price: number | null, size: number): Array<{ price: number; size: number }> {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return [];
  }

  return [
    {
      price: roundTo(price, 6),
      size: roundTo(size, 4),
    },
  ];
}

function resolveOutcome(record: Record<string, unknown>): Outcome | null {
  const direct = String(record.resolved_outcome ?? record.outcome ?? '').trim().toUpperCase();
  if (direct === 'YES' || direct === 'UP') {
    return 'YES';
  }
  if (direct === 'NO' || direct === 'DOWN') {
    return 'NO';
  }

  const outcomeIndex = Number(record.outcomeIndex ?? record.outcome_index);
  if (Number.isFinite(outcomeIndex)) {
    return outcomeIndex === 0 ? 'YES' : 'NO';
  }

  return null;
}

function computeDurationMinutes(startTime: string | null, endTime: string | null): number | null {
  if (!startTime || !endTime) {
    return null;
  }
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return (endMs - startMs) / 60_000;
}

function countRawSamples(samples: PairedBacktestSample[]): number {
  return samples.length * 2;
}

function bucketMinute(timestampMs: number): number {
  return Math.floor(timestampMs / 60_000);
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTimeString(value: unknown): string | null {
  return normalizeTimestampString(value);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
