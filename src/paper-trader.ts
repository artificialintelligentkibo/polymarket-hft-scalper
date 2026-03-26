import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  MarketOrderbookSnapshot,
  OrderbookLevel,
  Outcome,
  TokenBookSnapshot,
} from './clob-fetcher.js';
import { logger } from './logger.js';
import type { OrderMode } from './config.js';
import type { OrderbookHistory } from './orderbook-history.js';
import type { SignalType, SignalUrgency } from './strategy-types.js';
import type { TradeExecutionResult } from './trader.js';
import { clamp, roundTo, sleep } from './utils.js';

export interface PaperTraderConfig {
  enabled: boolean;
  simulatedLatencyMinMs: number;
  simulatedLatencyMaxMs: number;
  fillProbability: {
    passive: number;
    improve: number;
    cross: number;
  };
  slippageModel: {
    maxSlippageTicks: number;
    sizeImpactFactor: number;
  };
  partialFillEnabled: boolean;
  minFillRatio: number;
  initialBalanceUsd: number;
  tradeLogFile: string;
}

export interface PaperTrade {
  readonly timestamp: string;
  readonly marketId: string;
  readonly marketTitle: string;
  readonly signalType: SignalType;
  readonly outcome: Outcome;
  readonly side: 'BUY' | 'SELL';
  readonly requestedShares: number;
  readonly filledShares: number;
  readonly requestedPrice: number;
  readonly fillPrice: number | null;
  readonly slippage: number;
  readonly simulatedLatencyMs: number;
  readonly fillProbabilityUsed: number;
  readonly urgency: SignalUrgency;
  readonly virtualBalance: number;
  readonly virtualPnl: number;
  readonly paperMode: true;
}

export interface ResolvedPaperSlot {
  readonly marketId: string;
  readonly pnl: number;
  readonly resolvedAtMs: number;
}

interface PaperPositionState {
  yes: number;
  no: number;
  yesCost: number;
  noCost: number;
  realizedPnl: number;
}

export class PaperTrader {
  private balance: number;
  private readonly positions = new Map<string, PaperPositionState>();
  private readonly tradeLog: PaperTrade[] = [];
  private readonly resolvedSlots: ResolvedPaperSlot[] = [];
  private totalPnl = 0;
  private summaryPrinted = false;

  constructor(
    private readonly runtimeConfig: PaperTraderConfig,
    private readonly orderbookHistory: OrderbookHistory
  ) {
    this.balance = runtimeConfig.initialBalanceUsd;
  }

  async ensureReady(): Promise<void> {
    const tradeLogPath = path.resolve(process.cwd(), this.runtimeConfig.tradeLogFile);
    await mkdir(path.dirname(tradeLogPath), { recursive: true });
  }

  /**
   * Simulates a Polymarket order against the latest known orderbook.
   */
  async simulateOrder(params: {
    marketId: string;
    marketTitle: string;
    signalType: SignalType;
    tokenId: string;
    outcome: Outcome;
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
    orderType: OrderMode;
    postOnly: boolean;
    urgency: SignalUrgency;
    currentOrderbook: MarketOrderbookSnapshot;
    signalGeneratedAt?: number;
  }): Promise<TradeExecutionResult> {
    await this.ensureReady();

    const latencyMs = randomInt(
      this.runtimeConfig.simulatedLatencyMinMs,
      this.runtimeConfig.simulatedLatencyMaxMs
    );
    await sleep(latencyMs);

    const targetTimeMs = (params.signalGeneratedAt ?? Date.now()) + latencyMs;
    const latestBook =
      this.orderbookHistory.getAt(params.marketId, targetTimeMs) ??
      this.orderbookHistory.getLatest(params.marketId) ??
      params.currentOrderbook;
    const initialBook = resolveBookForOutcome(params.currentOrderbook, params.outcome);
    const fillBook = resolveBookForOutcome(latestBook, params.outcome);

    let fillProbability = this.resolveFillProbability({
      urgency: params.urgency,
      side: params.side,
      requestedPrice: params.price,
      initialBook,
      latestBook: fillBook,
    });

    let fill = this.buildUnfilledFill(params.side, params.price);
    if (Math.random() <= fillProbability) {
      fill =
        params.urgency === 'cross'
          ? this.simulateCrossFill({
              side: params.side,
              shares: params.shares,
              requestedPrice: params.price,
              book: fillBook,
            })
          : this.simulatePassiveFill({
              side: params.side,
              shares: params.shares,
              requestedPrice: params.price,
              urgency: params.urgency,
              book: fillBook,
              fillProbability,
            });
    }

    if (!this.runtimeConfig.partialFillEnabled && fill.filledShares > 0 && fill.filledShares < params.shares) {
      fill = this.buildUnfilledFill(params.side, params.price);
    }

    fill = this.constrainFillByInventoryAndCash(params, fill);
    fillProbability = clamp(fillProbability, 0, 1);

    if (fill.filledShares > 0 && fill.avgPrice !== null) {
      this.applySimulatedFill({
        marketId: params.marketId,
        outcome: params.outcome,
        side: params.side,
        shares: fill.filledShares,
        price: fill.avgPrice,
      });
    }

    this.totalPnl = this.getPnL();

    const trade: PaperTrade = {
      timestamp: new Date().toISOString(),
      marketId: params.marketId,
      marketTitle: params.marketTitle,
      signalType: params.signalType,
      outcome: params.outcome,
      side: params.side,
      requestedShares: roundTo(params.shares, 4),
      filledShares: roundTo(fill.filledShares, 4),
      requestedPrice: roundTo(params.price, 6),
      fillPrice: fill.avgPrice !== null ? roundTo(fill.avgPrice, 6) : null,
      slippage: roundTo(fill.slippage, 6),
      simulatedLatencyMs: latencyMs,
      fillProbabilityUsed: roundTo(fillProbability, 4),
      urgency: params.urgency,
      virtualBalance: roundTo(this.balance, 4),
      virtualPnl: roundTo(this.totalPnl, 4),
      paperMode: true,
    };
    this.tradeLog.push(trade);
    await this.appendTradeLog(trade);

    return {
      orderId: buildPaperOrderId(params.marketId, params.signalType),
      marketId: params.marketId,
      tokenId: params.tokenId,
      outcome: params.outcome,
      side: params.side,
      shares: roundTo(params.shares, 4),
      price: roundTo(params.price, 6),
      notionalUsd: roundTo(params.shares * params.price, 2),
      filledShares: roundTo(fill.filledShares, 4),
      fillPrice: fill.avgPrice !== null ? roundTo(fill.avgPrice, 6) : null,
      fillConfirmed: fill.filledShares > 0,
      simulation: true,
      wasMaker: fill.filledShares > 0 ? params.urgency !== 'cross' : null,
      postOnly: params.postOnly,
      orderType: params.orderType,
      balanceCacheHits: 0,
      balanceCacheMisses: 0,
      balanceCacheHitRatePct: null,
    };
  }

  resolveSlot(params: {
    marketId: string;
    winningOutcome: 'YES' | 'NO';
  }): { pnl: number; yesValue: number; noValue: number } {
    const position = this.positions.get(params.marketId);
    if (!position) {
      return {
        pnl: 0,
        yesValue: 0,
        noValue: 0,
      };
    }

    const yesValue = params.winningOutcome === 'YES' ? roundTo(position.yes, 4) : 0;
    const noValue = params.winningOutcome === 'NO' ? roundTo(position.no, 4) : 0;
    const payout = yesValue + noValue;
    const remainingCost = position.yes * position.yesCost + position.no * position.noCost;
    const pnl = roundTo(position.realizedPnl + payout - remainingCost, 4);

    this.balance = roundTo(this.balance + payout, 4);
    this.positions.delete(params.marketId);
    this.totalPnl = this.getPnL();
    this.resolvedSlots.push({
      marketId: params.marketId,
      pnl,
      resolvedAtMs: Date.now(),
    });

    return {
      pnl,
      yesValue,
      noValue,
    };
  }

  printSummary(): void {
    if (this.summaryPrinted) {
      return;
    }
    this.summaryPrinted = true;

    const durationMs =
      this.tradeLog.length >= 2
        ? Date.parse(this.tradeLog.at(-1)?.timestamp ?? '') -
          Date.parse(this.tradeLog[0].timestamp)
        : 0;
    const wins = this.resolvedSlots.filter((entry) => entry.pnl > 0);
    const losses = this.resolvedSlots.filter((entry) => entry.pnl < 0);
    const fillStats = summarizeFillRates(this.tradeLog);
    const strategySummary = summarizeStrategies(this.tradeLog);
    const endingBalance = roundTo(this.balance, 4);
    const endingPnl = roundTo(this.getPnL(), 4);

    console.log('=== PAPER TRADING SUMMARY ===');
    console.log(
      `Duration: ${formatDuration(durationMs)} | Slots: ${this.resolvedSlots.length} | Trades: ${this.tradeLog.length}`
    );
    console.log(
      `Balance: $${this.runtimeConfig.initialBalanceUsd.toFixed(2)} -> $${endingBalance.toFixed(2)} (${formatSignedPercent(
        this.runtimeConfig.initialBalanceUsd,
        endingBalance
      )})`
    );
    console.log(
      `Win rate: ${wins.length}/${this.resolvedSlots.length || 0} slots (${formatWinRate(
        wins.length,
        this.resolvedSlots.length
      )})`
    );
    console.log(
      `Avg profit per winning slot: ${formatSignedUsd(averagePnl(wins))}`
    );
    console.log(`Avg loss per losing slot: ${formatSignedUsd(averagePnl(losses))}`);
    console.log(
      `Biggest win: ${formatSignedUsd(maxPnl(wins))} | Biggest loss: ${formatSignedUsd(minPnl(losses))}`
    );
    console.log('Strategy breakdown:');
    for (const entry of strategySummary) {
      console.log(
        `  ${entry.label.padEnd(18)} ${entry.trades} trades | ${formatSignedUsd(entry.pnl)} | fill ${entry.fillRate}`
      );
    }
    console.log(
      `Fill rate: cross=${fillStats.cross} | improve=${fillStats.improve} | passive=${fillStats.passive}`
    );
    console.log(
      `Avg simulated latency: ${Math.round(averageLatency(this.tradeLog))}ms | Net PnL: ${formatSignedUsd(
        endingPnl
      )}`
    );
  }

  getBalance(): number {
    return roundTo(this.balance, 4);
  }

  getPnL(): number {
    let markedValue = 0;
    for (const [marketId, position] of this.positions.entries()) {
      const book = this.orderbookHistory.getLatest(marketId);
      const yesMark = book?.yes.midPrice ?? book?.yes.bestBid ?? book?.yes.lastTradePrice ?? 0;
      const noMark = book?.no.midPrice ?? book?.no.bestBid ?? book?.no.lastTradePrice ?? 0;
      markedValue += position.yes * yesMark + position.no * noMark;
    }

    return roundTo(this.balance + markedValue - this.runtimeConfig.initialBalanceUsd, 4);
  }

  hasOpenPosition(marketId: string): boolean {
    const position = this.positions.get(marketId);
    if (!position) {
      return false;
    }

    return position.yes > 0 || position.no > 0;
  }

  private resolveFillProbability(params: {
    urgency: SignalUrgency;
    side: 'BUY' | 'SELL';
    requestedPrice: number;
    initialBook: TokenBookSnapshot;
    latestBook: TokenBookSnapshot;
  }): number {
    const base = this.runtimeConfig.fillProbability[params.urgency];
    const initialReference =
      params.side === 'BUY'
        ? params.initialBook.bestAsk ?? params.initialBook.midPrice ?? params.requestedPrice
        : params.initialBook.bestBid ?? params.initialBook.midPrice ?? params.requestedPrice;
    const latestReference =
      params.side === 'BUY'
        ? params.latestBook.bestAsk ?? params.latestBook.midPrice ?? initialReference
        : params.latestBook.bestBid ?? params.latestBook.midPrice ?? initialReference;

    if (!Number.isFinite(initialReference) || !Number.isFinite(latestReference)) {
      return clamp(base, 0.05, 0.99);
    }

    const adverseMove =
      params.side === 'BUY'
        ? Math.max(0, latestReference - initialReference)
        : Math.max(0, initialReference - latestReference);
    const favorableMove =
      params.side === 'BUY'
        ? Math.max(0, initialReference - latestReference)
        : Math.max(0, latestReference - initialReference);
    const driftPenalty = adverseMove * 3;
    const driftBoost = favorableMove * 1.5;

    return clamp(base - driftPenalty + driftBoost, 0.05, 0.99);
  }

  private simulateCrossFill(params: {
    side: 'BUY' | 'SELL';
    shares: number;
    requestedPrice: number;
    book: TokenBookSnapshot;
  }): {
    filledShares: number;
    avgPrice: number | null;
    slippage: number;
  } {
    const levels = params.side === 'BUY' ? params.book.asks : params.book.bids;
    const walked = simulateOrderbookWalk(levels, params.shares, params.side);
    if (walked.filledShares <= 0) {
      return this.buildUnfilledFill(params.side, params.requestedPrice);
    }

    const topPrice =
      params.side === 'BUY'
        ? params.book.bestAsk ?? walked.avgPrice
        : params.book.bestBid ?? walked.avgPrice;
    const sizeRatio = params.shares / Math.max(params.shares, totalBookShares(levels));
    const extraTicks = Math.floor(
      Math.random() *
        (this.runtimeConfig.slippageModel.maxSlippageTicks + 1) *
        clamp(sizeRatio / Math.max(0.01, this.runtimeConfig.slippageModel.sizeImpactFactor), 0.25, 1)
    );
    const tickSize = inferTickSize(params.book, params.requestedPrice);
    const extraSlippage = extraTicks * tickSize;
    const avgPrice =
      params.side === 'BUY'
        ? walked.avgPrice + extraSlippage
        : Math.max(0.001, walked.avgPrice - extraSlippage);

    return {
      filledShares: walked.filledShares,
      avgPrice: roundTo(avgPrice, 6),
      slippage: roundTo(
        params.side === 'BUY'
          ? Math.max(0, avgPrice - topPrice)
          : Math.max(0, topPrice - avgPrice),
        6
      ),
    };
  }

  private simulatePassiveFill(params: {
    side: 'BUY' | 'SELL';
    shares: number;
    requestedPrice: number;
    urgency: SignalUrgency;
    book: TokenBookSnapshot;
    fillProbability: number;
  }): {
    filledShares: number;
    avgPrice: number | null;
    slippage: number;
  } {
    const bookCrossed =
      params.side === 'BUY'
        ? (params.book.bestAsk ?? Number.POSITIVE_INFINITY) <= params.requestedPrice
        : (params.book.bestBid ?? 0) >= params.requestedPrice;
    const queuePenalty = params.urgency === 'passive' ? 0.65 : 0.85;
    const effectiveProbability = clamp(
      params.fillProbability * (bookCrossed ? 1 : queuePenalty),
      0,
      0.99
    );

    if (Math.random() > effectiveProbability) {
      return this.buildUnfilledFill(params.side, params.requestedPrice);
    }

    const fillRatio = this.runtimeConfig.partialFillEnabled
      ? clamp(
          this.runtimeConfig.minFillRatio +
            Math.random() * (1 - this.runtimeConfig.minFillRatio),
          this.runtimeConfig.minFillRatio,
          1
        )
      : 1;

    return {
      filledShares: roundTo(params.shares * fillRatio, 4),
      avgPrice: roundTo(params.requestedPrice, 6),
      slippage: 0,
    };
  }

  private constrainFillByInventoryAndCash(
    params: {
      marketId: string;
      outcome: Outcome;
      side: 'BUY' | 'SELL';
      shares: number;
      price: number;
    },
    fill: {
      filledShares: number;
      avgPrice: number | null;
      slippage: number;
    }
  ): {
    filledShares: number;
    avgPrice: number | null;
    slippage: number;
  } {
    if (fill.filledShares <= 0 || fill.avgPrice === null) {
      return fill;
    }

    if (params.side === 'BUY') {
      const maxAffordableShares = this.balance / Math.max(fill.avgPrice, 0.0001);
      const affordableShares = roundTo(Math.min(fill.filledShares, maxAffordableShares), 4);
      if (affordableShares <= 0) {
        return this.buildUnfilledFill(params.side, params.price);
      }

      return {
        ...fill,
        filledShares: affordableShares,
      };
    }

    const position = this.positions.get(params.marketId) ?? createEmptyPaperPosition();
    const availableShares = params.outcome === 'YES' ? position.yes : position.no;
    const sellableShares = roundTo(Math.min(fill.filledShares, availableShares), 4);
    if (sellableShares <= 0) {
      return this.buildUnfilledFill(params.side, params.price);
    }

    return {
      ...fill,
      filledShares: sellableShares,
    };
  }

  private applySimulatedFill(params: {
    marketId: string;
    outcome: Outcome;
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
  }): void {
    const position = this.positions.get(params.marketId) ?? createEmptyPaperPosition();
    const key = params.outcome === 'YES' ? 'yes' : 'no';
    const costKey = params.outcome === 'YES' ? 'yesCost' : 'noCost';

    if (params.side === 'BUY') {
      const previousShares = position[key];
      const nextShares = roundTo(previousShares + params.shares, 4);
      const nextCost =
        nextShares > 0
          ? (position[costKey] * previousShares + params.price * params.shares) / nextShares
          : 0;
      position[key] = nextShares;
      position[costKey] = roundTo(nextCost, 6);
      this.balance = roundTo(this.balance - params.shares * params.price, 4);
      this.positions.set(params.marketId, position);
      return;
    }

    const previousShares = position[key];
    const closedShares = Math.min(previousShares, params.shares);
    position.realizedPnl = roundTo(
      position.realizedPnl + (params.price - position[costKey]) * closedShares,
      4
    );
    position[key] = roundTo(Math.max(0, previousShares - closedShares), 4);
    if (position[key] <= 0) {
      position[key] = 0;
      position[costKey] = 0;
    }
    this.balance = roundTo(this.balance + closedShares * params.price, 4);
    if (position.yes <= 0 && position.no <= 0 && position.realizedPnl === 0) {
      this.positions.delete(params.marketId);
      return;
    }

    this.positions.set(params.marketId, position);
  }

  private buildUnfilledFill(
    _side: 'BUY' | 'SELL',
    _requestedPrice: number
  ): {
    filledShares: number;
    avgPrice: number | null;
    slippage: number;
  } {
    return {
      filledShares: 0,
      avgPrice: null,
      slippage: 0,
    };
  }

  private async appendTradeLog(trade: PaperTrade): Promise<void> {
    const tradeLogPath = path.resolve(process.cwd(), this.runtimeConfig.tradeLogFile);
    await appendFile(tradeLogPath, `${JSON.stringify(trade)}\n`, 'utf8');
  }
}

function resolveBookForOutcome(snapshot: MarketOrderbookSnapshot, outcome: Outcome): TokenBookSnapshot {
  return outcome === 'YES' ? snapshot.yes : snapshot.no;
}

export function simulateOrderbookWalk(
  levels: OrderbookLevel[],
  shares: number,
  side: 'BUY' | 'SELL'
): { filledShares: number; avgPrice: number; slippage: number } {
  const orderedLevels =
    side === 'BUY'
      ? [...levels].sort((left, right) => left.price - right.price)
      : [...levels].sort((left, right) => right.price - left.price);

  let remainingShares = shares;
  let filledShares = 0;
  let totalNotional = 0;

  for (const level of orderedLevels) {
    if (remainingShares <= 0) {
      break;
    }

    const availableShares = Math.max(0, level.size);
    if (availableShares <= 0) {
      continue;
    }

    const consumedShares = Math.min(remainingShares, availableShares);
    filledShares += consumedShares;
    totalNotional += consumedShares * level.price;
    remainingShares -= consumedShares;
  }

  if (filledShares <= 0) {
    return {
      filledShares: 0,
      avgPrice: 0,
      slippage: 0,
    };
  }

  const avgPrice = totalNotional / filledShares;
  const topPrice = orderedLevels[0]?.price ?? avgPrice;
  const slippage =
    side === 'BUY'
      ? Math.max(0, avgPrice - topPrice)
      : Math.max(0, topPrice - avgPrice);

  return {
    filledShares: roundTo(filledShares, 4),
    avgPrice: roundTo(avgPrice, 6),
    slippage: roundTo(slippage, 6),
  };
}

function inferTickSize(book: TokenBookSnapshot, fallbackPrice: number): number {
  const prices = [...book.bids, ...book.asks]
    .map((level) => level.price)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  for (let index = 1; index < prices.length; index += 1) {
    const difference = roundTo(Math.abs(prices[index] - prices[index - 1]), 6);
    if (difference > 0) {
      return difference;
    }
  }

  return fallbackPrice >= 0.5 ? 0.01 : 0.005;
}

function totalBookShares(levels: readonly OrderbookLevel[]): number {
  return levels.reduce((sum, level) => sum + Math.max(0, level.size), 0);
}

function createEmptyPaperPosition(): PaperPositionState {
  return {
    yes: 0,
    no: 0,
    yesCost: 0,
    noCost: 0,
    realizedPnl: 0,
  };
}

function buildPaperOrderId(marketId: string, signalType: SignalType): string {
  return `paper-${signalType.toLowerCase()}-${marketId}-${Date.now()}`;
}

function randomInt(min: number, max: number): number {
  const lower = Math.max(0, Math.floor(Math.min(min, max)));
  const upper = Math.max(lower, Math.floor(Math.max(min, max)));
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function summarizeStrategies(trades: readonly PaperTrade[]): Array<{
  label: string;
  trades: number;
  pnl: number;
  fillRate: string;
}> {
  const buckets = new Map<string, { trades: number; filled: number; pnl: number }>();

  for (const trade of trades) {
    const key = classifySignal(trade.signalType);
    const bucket = buckets.get(key) ?? { trades: 0, filled: 0, pnl: 0 };
    bucket.trades += 1;
    if (trade.filledShares > 0) {
      bucket.filled += 1;
    }
    if (trade.fillPrice !== null) {
      const signedNotional =
        trade.side === 'BUY'
          ? -trade.fillPrice * trade.filledShares
          : trade.fillPrice * trade.filledShares;
      bucket.pnl = roundTo(bucket.pnl + signedNotional, 4);
    }
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([label, bucket]) => ({
      label,
      trades: bucket.trades,
      pnl: roundTo(bucket.pnl, 4),
      fillRate: formatWinRate(bucket.filled, bucket.trades),
    }))
    .sort((left, right) => right.trades - left.trades);
}

function summarizeFillRates(trades: readonly PaperTrade[]): Record<SignalUrgency, string> {
  const stats: Record<SignalUrgency, { total: number; filled: number }> = {
    passive: { total: 0, filled: 0 },
    improve: { total: 0, filled: 0 },
    cross: { total: 0, filled: 0 },
  };

  for (const trade of trades) {
    stats[trade.urgency].total += 1;
    if (trade.filledShares > 0) {
      stats[trade.urgency].filled += 1;
    }
  }

  return {
    passive: formatWinRate(stats.passive.filled, stats.passive.total),
    improve: formatWinRate(stats.improve.filled, stats.improve.total),
    cross: formatWinRate(stats.cross.filled, stats.cross.total),
  };
}

function averageLatency(trades: readonly PaperTrade[]): number {
  if (trades.length === 0) {
    return 0;
  }

  const total = trades.reduce((sum, trade) => sum + trade.simulatedLatencyMs, 0);
  return total / trades.length;
}

function classifySignal(signalType: SignalType): string {
  if (signalType.startsWith('PAIRED_ARB')) {
    return 'PAIRED_ARB';
  }
  if (signalType.startsWith('LATENCY_MOMENTUM')) {
    return 'LATENCY_MOMENTUM';
  }
  if (signalType.startsWith('FAIR_VALUE')) {
    return 'FAIR_VALUE';
  }
  if (signalType.startsWith('EXTREME')) {
    return 'EXTREME';
  }
  return signalType;
}

function averagePnl(entries: readonly ResolvedPaperSlot[]): number {
  if (entries.length === 0) {
    return 0;
  }

  const total = entries.reduce((sum, entry) => sum + entry.pnl, 0);
  return total / entries.length;
}

function maxPnl(entries: readonly ResolvedPaperSlot[]): number {
  if (entries.length === 0) {
    return 0;
  }

  return Math.max(...entries.map((entry) => entry.pnl));
}

function minPnl(entries: readonly ResolvedPaperSlot[]): number {
  if (entries.length === 0) {
    return 0;
  }

  return Math.min(...entries.map((entry) => entry.pnl));
}

function formatSignedUsd(value: number): string {
  const rounded = roundTo(value, 2);
  return `${rounded >= 0 ? '+' : ''}$${rounded.toFixed(2)}`;
}

function formatWinRate(filled: number, total: number): string {
  if (total <= 0) {
    return '0%';
  }

  return `${roundTo((filled / total) * 100, 1)}%`;
}

function formatSignedPercent(start: number, end: number): string {
  if (start <= 0) {
    return '0.0%';
  }

  const pct = ((end - start) / start) * 100;
  return `${pct >= 0 ? '+' : ''}${roundTo(pct, 2).toFixed(2)}%`;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0m';
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
