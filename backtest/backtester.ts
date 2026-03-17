import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { logger, TradeLogger } from '../src/logger.js';
import { PositionManager } from '../src/position-manager.js';
import {
  hasBuyEdge,
  hasSellEdge,
  scaleSharesForLiquidity,
} from '../src/signal-scalper.js';
import type { Outcome } from '../src/clob-fetcher.js';

interface BacktestSample {
  timestampMs: number;
  marketId: string;
  marketTitle: string;
  outcome: Outcome;
  outcomeIndex: 0 | 1;
  tokenPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  liquidityUsd: number;
  depthShares: number;
  slotEnd: string | null;
}

interface BacktestSummary {
  samples: number;
  markets: number;
  entries: number;
  exits: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  maxSignedNet: number;
  forcedExitCount: number;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.resolve(process.cwd(), 'backtest', 'data', 'sample.jsonl');

  const samples = await loadSamples(inputPath);
  const summary = await runBacktest(samples);

  console.log(JSON.stringify(summary, null, 2));
}

export async function runBacktest(
  samples: BacktestSample[],
  tradeLogger?: TradeLogger
): Promise<BacktestSummary> {
  const managers = new Map<string, PositionManager>();
  const latestMarks = new Map<string, { YES: number | null; NO: number | null }>();
  const marketsSeen = new Set<string>();
  let entries = 0;
  let exits = 0;
  let wins = 0;
  let losses = 0;
  let maxSignedNet = 0;
  let maxDrawdown = 0;
  let peakEquity = 0;
  let forcedExitCount = 0;

  const orderedSamples = [...samples].sort((left, right) => left.timestampMs - right.timestampMs);

  for (const sample of orderedSamples) {
    marketsSeen.add(sample.marketId);
    const manager = getManager(managers, sample);
    const marks = latestMarks.get(sample.marketId) ?? { YES: null, NO: null };
    const markPrice = sample.bestBid ?? sample.midPrice ?? sample.tokenPrice;

    if (sample.outcome === 'YES') {
      marks.YES = markPrice;
    } else {
      marks.NO = markPrice;
    }

    latestMarks.set(sample.marketId, marks);
    manager.markToMarket(marks);

    const boundary = manager.getBoundaryCorrection(config.strategy);
    if (boundary && boundary.outcome === sample.outcome) {
      const executionPrice =
        boundary.action === 'BUY'
          ? sample.bestAsk ?? sample.midPrice ?? sample.tokenPrice
          : sample.bestBid ?? sample.midPrice ?? sample.tokenPrice;
      if (executionPrice !== null && executionPrice > 0) {
        const result = applySimulatedFill(manager, boundary.outcome, boundary.action, boundary.shares, executionPrice);
        if (boundary.action === 'BUY') {
          entries++;
        } else {
          exits++;
          if (result.realizedDelta > 0) wins++;
          if (result.realizedDelta < 0) losses++;
        }
      }
    }

    const timedExit = manager.getExitSignal(sample.outcome, new Date(sample.timestampMs), config.strategy);
    if (timedExit) {
      const executionPrice = sample.bestBid ?? sample.midPrice ?? sample.tokenPrice;
      if (executionPrice !== null && executionPrice > 0) {
        const result = applySimulatedFill(manager, sample.outcome, 'SELL', timedExit.shares, executionPrice);
        exits++;
        forcedExitCount++;
        if (result.realizedDelta > 0) wins++;
        if (result.realizedDelta < 0) losses++;
      }
      updateEquityStats(managers, () => {
        const equity = sumTotalPnl(managers);
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
        maxSignedNet = Math.max(maxSignedNet, Math.abs(manager.getSnapshot().signedNetShares));
      });
      continue;
    }

    const openShares = manager.getShares(sample.outcome);
    if (openShares > 0 && hasSellEdge(sample.tokenPrice, sample.midPrice)) {
      const executionPrice = sample.bestBid ?? sample.midPrice ?? sample.tokenPrice;
      if (executionPrice !== null && executionPrice > 0) {
        const result = applySimulatedFill(manager, sample.outcome, 'SELL', openShares, executionPrice);
        exits++;
        if (result.realizedDelta > 0) wins++;
        if (result.realizedDelta < 0) losses++;
      }
    } else if (hasBuyEdge(sample.tokenPrice, sample.midPrice)) {
      const executionPrice = sample.bestAsk ?? sample.midPrice ?? sample.tokenPrice;
      if (executionPrice !== null && executionPrice > 0) {
        const capacity = manager.getAvailableEntryCapacity(sample.outcome, config.strategy);
        const shares = Math.min(
          scaleSharesForLiquidity(sample.liquidityUsd, sample.depthShares, config),
          capacity
        );
        if (shares >= config.strategy.minShares) {
          applySimulatedFill(manager, sample.outcome, 'BUY', shares, executionPrice);
          entries++;
        }
      }
    }

    updateEquityStats(managers, () => {
      const equity = sumTotalPnl(managers);
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
      maxSignedNet = Math.max(maxSignedNet, Math.abs(manager.getSnapshot().signedNetShares));
    });

    if (tradeLogger) {
      const snapshot = manager.getSnapshot();
      await tradeLogger.logTrade({
        phase: 'backtest',
        timestampMs: sample.timestampMs,
        marketId: sample.marketId,
        marketTitle: sample.marketTitle,
        slotEnd: sample.slotEnd,
        tokenId: `${sample.marketId}:${sample.outcome}`,
        outcome: sample.outcome,
        outcomeIndex: sample.outcomeIndex,
        action: openShares > 0 && hasSellEdge(sample.tokenPrice, sample.midPrice) ? 'SELL' : 'BUY',
        reason: 'backtest-sample',
        tokenPrice: sample.tokenPrice,
        midPrice: sample.midPrice,
        bestBid: sample.bestBid,
        bestAsk: sample.bestAsk,
        shares: 0,
        notionalUsd: 0,
        liquidityUsd: sample.liquidityUsd,
        netYesShares: snapshot.yesShares,
        netNoShares: snapshot.noShares,
        signedNetShares: snapshot.signedNetShares,
        realizedPnl: snapshot.realizedPnl,
        unrealizedPnl: snapshot.unrealizedPnl,
        totalPnl: snapshot.totalPnl,
        simulationMode: true,
      });
    }
  }

  for (const [marketId, manager] of managers.entries()) {
    const marks = latestMarks.get(marketId) ?? { YES: null, NO: null };
    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      const openShares = manager.getShares(outcome);
      if (openShares <= 0) {
        continue;
      }

      const executionPrice = outcome === 'YES' ? marks.YES : marks.NO;
      if (executionPrice === null || executionPrice <= 0) {
        continue;
      }

      const result = applySimulatedFill(manager, outcome, 'SELL', openShares, executionPrice);
      exits++;
      forcedExitCount++;
      if (result.realizedDelta > 0) wins++;
      if (result.realizedDelta < 0) losses++;
    }
  }

  const realizedPnl = roundTo(sumRealizedPnl(managers), 4);
  const totalPnl = roundTo(sumTotalPnl(managers), 4);
  const summary: BacktestSummary = {
    samples: orderedSamples.length,
    markets: marketsSeen.size,
    entries,
    exits,
    wins,
    losses,
    realizedPnl,
    totalPnl,
    maxDrawdown: roundTo(maxDrawdown, 4),
    maxSignedNet: roundTo(maxSignedNet, 4),
    forcedExitCount,
  };

  if (tradeLogger) {
    await tradeLogger.logBacktestSummary(summary);
  }

  logger.info('Backtest completed', summary);
  return summary;
}

async function loadSamples(filePath: string): Promise<BacktestSample[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeSample(JSON.parse(line) as Record<string, unknown>))
    .filter((sample): sample is BacktestSample => sample !== null);
}

function normalizeSample(record: Record<string, unknown>): BacktestSample | null {
  const outcome = resolveOutcome(record);
  if (!outcome) {
    return null;
  }

  const timestampMs = normalizeTimestamp(record.timestamp_ms ?? record.timestamp);
  const marketId = asString(record.market_id ?? record.market_condition_id ?? record.marketId);
  if (!timestampMs || !marketId) {
    return null;
  }

  return {
    timestampMs,
    marketId,
    marketTitle:
      asString(record.market_title ?? record.marketTitle ?? record.title ?? record.question) ||
      marketId,
    outcome,
    outcomeIndex: outcome === 'YES' ? 0 : 1,
    tokenPrice: toNumberOrNull(record.token_price ?? record.tokenPrice),
    midPrice: toNumberOrNull(record.mid_price_orderbook ?? record.mid_price ?? record.midPrice),
    bestBid: toNumberOrNull(record.best_bid ?? record.bestBid),
    bestAsk: toNumberOrNull(record.best_ask ?? record.bestAsk),
    liquidityUsd:
      toNumberOrNull(record.liquidity_usd ?? record.liquidity) ?? config.strategy.minLiquidityUsd,
    depthShares:
      toNumberOrNull(record.depth_shares ?? record.depthShares ?? record.shares) ??
      config.strategy.minShares,
    slotEnd: normalizeTimeString(record.slot_end ?? record.slotEnd),
  };
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

function getManager(
  managers: Map<string, PositionManager>,
  sample: BacktestSample
): PositionManager {
  const existing = managers.get(sample.marketId);
  if (existing) {
    existing.setSlotEndsAt(sample.slotEnd);
    return existing;
  }

  const created = new PositionManager(sample.marketId, sample.slotEnd);
  managers.set(sample.marketId, created);
  return created;
}

function applySimulatedFill(
  manager: PositionManager,
  outcome: Outcome,
  side: 'BUY' | 'SELL',
  shares: number,
  price: number
): { realizedDelta: number } {
  const before = manager.getSnapshot().realizedPnl;
  manager.applyFill({
    outcome,
    side,
    shares,
    price,
  });
  const after = manager.getSnapshot().realizedPnl;
  return {
    realizedDelta: roundTo(after - before, 4),
  };
}

function updateEquityStats(
  managers: Map<string, PositionManager>,
  updater: () => void
): void {
  for (const manager of managers.values()) {
    manager.getSnapshot();
  }
  updater();
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
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
