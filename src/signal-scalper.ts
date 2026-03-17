import { pathToFileURL } from 'node:url';
import { config, validateConfig, type AppConfig } from './config.js';
import {
  ClobFetcher,
  type MarketOrderbookSnapshot,
  type Outcome,
  type TokenBookSnapshot,
} from './clob-fetcher.js';
import { logger, TradeLogger } from './logger.js';
import { MarketMonitor, type MarketCandidate } from './monitor.js';
import {
  PositionManager,
  type BoundaryCorrection,
  type PositionRiskLimits,
} from './position-manager.js';
import { Trader } from './trader.js';

export interface SignalDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  outcome: Outcome | null;
  shares: number;
  targetPrice: number | null;
  reason: string;
  tokenPrice: number | null;
  midPrice: number | null;
  outcomeIndex: 0 | 1 | null;
}

export function hasBuyEdge(
  tokenPrice: number | null,
  midPrice: number | null,
  threshold = config.strategy.entryBuyEdge
): boolean {
  return (
    tokenPrice !== null &&
    midPrice !== null &&
    Number.isFinite(tokenPrice) &&
    Number.isFinite(midPrice) &&
    tokenPrice < midPrice - threshold
  );
}

export function hasSellEdge(
  tokenPrice: number | null,
  midPrice: number | null,
  threshold = config.strategy.entrySellEdge
): boolean {
  return (
    tokenPrice !== null &&
    midPrice !== null &&
    Number.isFinite(tokenPrice) &&
    Number.isFinite(midPrice) &&
    tokenPrice > midPrice + threshold
  );
}

export function scaleSharesForLiquidity(
  liquidityUsd: number,
  depthShares: number,
  runtimeConfig: AppConfig = config
): number {
  const { minShares, maxShares, minLiquidityUsd, sizeLiquidityCapUsd } = runtimeConfig.strategy;
  const liquidityRange = Math.max(1, sizeLiquidityCapUsd - minLiquidityUsd);
  const clampedLiquidity = clamp(liquidityUsd, minLiquidityUsd, sizeLiquidityCapUsd);
  const liquidityScore = (clampedLiquidity - minLiquidityUsd) / liquidityRange;
  const rawShares = minShares + liquidityScore * (maxShares - minShares);
  const depthCap = Math.max(minShares, depthShares * 0.35);
  return roundTo(clamp(rawShares, minShares, Math.min(maxShares, depthCap)), 2);
}

export class SignalScalper {
  constructor(private readonly runtimeConfig: AppConfig = config) {}

  evaluate(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    now?: Date;
  }): SignalDecision {
    const now = params.now ?? new Date();
    const { market, orderbook, positionManager } = params;
    const limits: PositionRiskLimits = this.runtimeConfig.strategy;

    positionManager.setSlotEndsAt(market.endTime);
    positionManager.markToMarket({
      YES: orderbook.yes.bestBid ?? orderbook.yes.midPrice,
      NO: orderbook.no.bestBid ?? orderbook.no.midPrice,
    });

    const boundaryCorrection = positionManager.getBoundaryCorrection(limits);
    if (boundaryCorrection) {
      return this.fromBoundaryCorrection(boundaryCorrection, market, orderbook);
    }

    for (const outcome of ['YES', 'NO'] as Outcome[]) {
      const exit = positionManager.getExitSignal(outcome, now, limits);
      if (exit) {
        const book = this.getBookForOutcome(orderbook, outcome);
        return {
          action: 'SELL',
          outcome,
          shares: roundTo(exit.shares, 4),
          targetPrice: book.bestBid ?? exit.targetPrice,
          reason: exit.reason,
          tokenPrice: book.lastTradePrice,
          midPrice: book.midPrice,
          outcomeIndex: outcome === 'YES' ? 0 : 1,
        };
      }
    }

    const yesExitBySignal = this.getSellEdgeDecision(
      'YES',
      orderbook.yes,
      positionManager.getShares('YES')
    );
    if (yesExitBySignal) {
      return yesExitBySignal;
    }

    const noExitBySignal = this.getSellEdgeDecision(
      'NO',
      orderbook.no,
      positionManager.getShares('NO')
    );
    if (noExitBySignal) {
      return noExitBySignal;
    }

    if (!this.runtimeConfig.ENABLE_SIGNAL) {
      return holdDecision('Signal engine disabled via ENABLE_SIGNAL=false');
    }

    const candidates = [
      this.getBuyEdgeDecision('YES', market, orderbook.yes, positionManager),
      this.getBuyEdgeDecision('NO', market, orderbook.no, positionManager),
    ]
      .filter((decision): decision is SignalDecision => decision !== null)
      .sort((left, right) => {
        const leftEdge = (left.midPrice ?? 0) - (left.tokenPrice ?? 0);
        const rightEdge = (right.midPrice ?? 0) - (right.tokenPrice ?? 0);
        return rightEdge - leftEdge;
      });

    return candidates[0] ?? holdDecision('No entry or exit edge at current thresholds');
  }

  private getBuyEdgeDecision(
    outcome: Outcome,
    market: MarketCandidate,
    book: TokenBookSnapshot,
    positionManager: PositionManager
  ): SignalDecision | null {
    if (!hasBuyEdge(book.lastTradePrice, book.midPrice, this.runtimeConfig.strategy.entryBuyEdge)) {
      return null;
    }

    const bestAsk = book.bestAsk ?? book.midPrice;
    if (bestAsk === null) {
      return null;
    }

    const availableCapacity = positionManager.getAvailableEntryCapacity(
      outcome,
      this.runtimeConfig.strategy
    );
    if (availableCapacity < this.runtimeConfig.strategy.minShares) {
      return null;
    }

    const scaledShares = scaleSharesForLiquidity(
      market.liquidityUsd,
      book.depthSharesAsk,
      this.runtimeConfig
    );
    const shares = roundTo(
      clamp(
        Math.min(scaledShares, availableCapacity),
        this.runtimeConfig.strategy.minShares,
        this.runtimeConfig.strategy.maxShares
      ),
      2
    );

    if (shares < this.runtimeConfig.strategy.minShares) {
      return null;
    }

    return {
      action: 'BUY',
      outcome,
      shares,
      targetPrice: bestAsk,
      reason: `${outcome} last trade ${formatPrice(book.lastTradePrice)} is below mid ${formatPrice(book.midPrice)} by at least ${this.runtimeConfig.strategy.entryBuyEdge}`,
      tokenPrice: book.lastTradePrice,
      midPrice: book.midPrice,
      outcomeIndex: outcome === 'YES' ? 0 : 1,
    };
  }

  private getSellEdgeDecision(
    outcome: Outcome,
    book: TokenBookSnapshot,
    openShares: number
  ): SignalDecision | null {
    if (openShares <= 0) {
      return null;
    }

    if (!hasSellEdge(book.lastTradePrice, book.midPrice, this.runtimeConfig.strategy.entrySellEdge)) {
      return null;
    }

    const bestBid = book.bestBid ?? book.midPrice;
    if (bestBid === null) {
      return null;
    }

    return {
      action: 'SELL',
      outcome,
      shares: roundTo(openShares, 4),
      targetPrice: bestBid,
      reason: `${outcome} last trade ${formatPrice(book.lastTradePrice)} is above mid ${formatPrice(book.midPrice)} by at least ${this.runtimeConfig.strategy.entrySellEdge}`,
      tokenPrice: book.lastTradePrice,
      midPrice: book.midPrice,
      outcomeIndex: outcome === 'YES' ? 0 : 1,
    };
  }

  private fromBoundaryCorrection(
    correction: BoundaryCorrection,
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): SignalDecision {
    const book = this.getBookForOutcome(orderbook, correction.outcome);
    const targetPrice =
      correction.action === 'BUY' ? book.bestAsk ?? book.midPrice : book.bestBid ?? book.midPrice;

    return {
      action: correction.action,
      outcome: correction.outcome,
      shares: roundTo(correction.shares, 4),
      targetPrice,
      reason: correction.reason,
      tokenPrice: book.lastTradePrice,
      midPrice: book.midPrice,
      outcomeIndex: correction.outcome === 'YES' ? market.yesOutcomeIndex : market.noOutcomeIndex,
    };
  }

  private getBookForOutcome(
    snapshot: MarketOrderbookSnapshot,
    outcome: Outcome
  ): TokenBookSnapshot {
    return outcome === 'YES' ? snapshot.yes : snapshot.no;
  }
}

class HftScalperRuntime {
  private readonly monitor = new MarketMonitor();
  private readonly fetcher = new ClobFetcher();
  private readonly trader = new Trader();
  private readonly tradeLogger = new TradeLogger();
  private readonly signal = new SignalScalper();
  private readonly positions = new Map<string, PositionManager>();
  private running = false;

  async initialize(): Promise<void> {
    validateConfig();
    await this.tradeLogger.ensureReady();
    await this.trader.initialize();

    logger.info('Polymarket HFT scalper initialized', {
      simulationMode: config.SIMULATION_MODE,
      enableSignal: config.ENABLE_SIGNAL,
      entryBuyEdge: config.strategy.entryBuyEdge,
      entrySellEdge: config.strategy.entrySellEdge,
      minLiquidityUsd: config.strategy.minLiquidityUsd,
    });
  }

  async run(): Promise<void> {
    this.running = true;

    while (this.running) {
      try {
        await this.runCycle();
      } catch (error: any) {
        logger.error('Scan cycle failed', {
          message: error?.message || 'Unknown error',
        });
      }

      await sleep(config.runtime.marketScanIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    this.fetcher.close();
  }

  private async runCycle(): Promise<void> {
    const markets = await this.monitor.scanEligibleMarkets();
    if (markets.length === 0) {
      logger.debug('No eligible markets found for this cycle');
      return;
    }

    const tokenIds = markets.flatMap((market) => [market.yesTokenId, market.noTokenId]);
    await this.fetcher.subscribeAssets(tokenIds);

    await runWithConcurrency(markets, config.runtime.maxConcurrentMarkets, async (market) => {
      await this.processMarket(market);
    });
  }

  private async processMarket(market: MarketCandidate): Promise<void> {
    const orderbook = await this.fetcher.getMarketSnapshot(market);
    const positionManager = this.getPositionManager(market);
    const decision = this.signal.evaluate({
      market,
      orderbook,
      positionManager,
    });

    if (
      decision.action === 'HOLD' ||
      !decision.outcome ||
      decision.targetPrice === null ||
      decision.shares <= 0
    ) {
      return;
    }

    const tokenId = decision.outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const execution = await this.trader.placeOrder({
      marketId: market.marketId,
      marketTitle: market.title,
      tokenId,
      outcome: decision.outcome,
      side: decision.action,
      shares: decision.shares,
      price: decision.targetPrice,
      reason: decision.reason,
    });

    positionManager.applyFill({
      outcome: decision.outcome,
      side: decision.action,
      shares: execution.shares,
      price: execution.price,
      timestamp: new Date().toISOString(),
      orderId: execution.orderId,
    });

    const snapshot = positionManager.getSnapshot();
    const book = decision.outcome === 'YES' ? orderbook.yes : orderbook.no;

    await this.tradeLogger.logTrade({
      phase: 'live',
      timestampMs: Date.now(),
      marketId: market.marketId,
      marketTitle: market.title,
      slotStart: market.startTime,
      slotEnd: market.endTime,
      tokenId,
      outcome: decision.outcome,
      outcomeIndex: decision.outcome === 'YES' ? 0 : 1,
      action: decision.action,
      reason: decision.reason,
      tokenPrice: decision.tokenPrice,
      midPrice: decision.midPrice,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      shares: execution.shares,
      notionalUsd: execution.notionalUsd,
      liquidityUsd: market.liquidityUsd,
      netYesShares: snapshot.yesShares,
      netNoShares: snapshot.noShares,
      signedNetShares: snapshot.signedNetShares,
      realizedPnl: snapshot.realizedPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      totalPnl: snapshot.totalPnl,
      orderId: execution.orderId,
      simulationMode: execution.simulation,
    });

    logger.info('Trade executed', {
      marketId: market.marketId,
      outcome: decision.outcome,
      action: decision.action,
      shares: execution.shares,
      price: execution.price,
      reason: decision.reason,
      signedNetShares: snapshot.signedNetShares,
      totalPnl: snapshot.totalPnl,
    });
  }

  private getPositionManager(market: MarketCandidate): PositionManager {
    const existing = this.positions.get(market.marketId);
    if (existing) {
      existing.setSlotEndsAt(market.endTime);
      return existing;
    }

    const created = new PositionManager(market.marketId, market.endTime);
    this.positions.set(market.marketId, created);
    return created;
  }
}

export async function main(): Promise<void> {
  const runtime = new HftScalperRuntime();

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    runtime.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    runtime.stop();
    process.exit(0);
  });

  await runtime.initialize();
  await runtime.run();
}

function holdDecision(reason: string): SignalDecision {
  return {
    action: 'HOLD',
    outcome: null,
    shares: 0,
    targetPrice: null,
    reason,
    tokenPrice: null,
    midPrice: null,
    outcomeIndex: null,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatPrice(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  const queue = [...values];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await worker(next);
    }
  });

  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
