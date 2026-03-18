import { pathToFileURL } from 'node:url';
import { ClobFetcher, type MarketOrderbookSnapshot } from './clob-fetcher.js';
import { config, isDryRunMode, validateConfig } from './config.js';
import { logger, TradeLogger } from './logger.js';
import { MarketMonitor, getSlotKey, type MarketCandidate } from './monitor.js';
import { OrderExecutor } from './order-executor.js';
import { PositionManager } from './position-manager.js';
import { RiskManager } from './risk-manager.js';
import { SignalScalper } from './signal-scalper.js';
import { ensureSlotResult, printSlotReport, recordTrade } from './slot-reporter.js';
import type { StrategySignal } from './strategy-types.js';

class MarketMakerRuntime {
  private readonly monitor = new MarketMonitor();
  private readonly fetcher = new ClobFetcher();
  private readonly executor = new OrderExecutor();
  private readonly tradeLogger = new TradeLogger();
  private readonly riskManager = new RiskManager();
  private readonly signalEngine = new SignalScalper();
  private readonly positions = new Map<string, PositionManager>();
  private readonly markets = new Map<string, MarketCandidate>();
  private readonly latestBooks = new Map<string, MarketOrderbookSnapshot>();
  private readonly pendingSlotReports = new Set<string>();
  private readonly printedSlotReports = new Set<string>();
  private running = false;
  private stopping = false;

  constructor() {
    this.monitor.on('slot-ended', (market: MarketCandidate) => {
      const slotKey = getSlotKey(market);
      ensureSlotResult(slotKey, market.marketId, market.title);
      this.pendingSlotReports.add(slotKey);
    });
  }

  async initialize(): Promise<void> {
    validateConfig();
    await this.tradeLogger.ensureReady();
    await this.executor.initialize();

    logger.info('Polymarket dual-sided market-maker initialized', {
      simulationMode: config.SIMULATION_MODE,
      testMode: config.TEST_MODE,
      dryRun: config.DRY_RUN,
      enableSignal: config.ENABLE_SIGNAL,
      minCombinedDiscount: config.strategy.minCombinedDiscount,
      extremeBuyThreshold: config.strategy.extremeBuyThreshold,
      extremeSellThreshold: config.strategy.extremeSellThreshold,
      maxSignalsPerTick: config.strategy.maxSignalsPerTick,
      whitelistSize: config.WHITELIST_CONDITION_IDS.length,
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

      if (!this.running) {
        break;
      }

      await sleep(config.runtime.marketScanIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.running = false;

    logger.info('Graceful shutdown started', { reason });

    try {
      await withTimeout(
        (async () => {
          await this.executor.cancelAll();
          await this.flattenAllOpenPositions('SLOT_FLATTEN');
          this.printPendingReports();
          await this.executor.close();
        })(),
        config.runtime.gracefulShutdownTimeoutMs
      );
    } catch (error: any) {
      logger.warn('Graceful shutdown timed out or failed', {
        reason,
        message: error?.message || 'Unknown error',
      });
    } finally {
      this.fetcher.close();
    }
  }

  private async runCycle(): Promise<void> {
    const markets = await this.monitor.scanEligibleMarkets();
    if (markets.length === 0) {
      logger.debug('No eligible markets found for this cycle');
      this.printPendingReports();
      return;
    }

    for (const market of markets) {
      this.markets.set(market.marketId, market);
    }

    const tokenIds = markets.flatMap((market) => [market.yesTokenId, market.noTokenId]);
    await this.fetcher.subscribeAssets(tokenIds);

    await runWithConcurrency(markets, config.runtime.maxConcurrentMarkets, async (market) => {
      await this.processMarket(market);
    });

    this.printPendingReports();
  }

  private async processMarket(market: MarketCandidate): Promise<void> {
    const slotKey = getSlotKey(market);
    const orderbook = await this.fetcher.getMarketSnapshot(market);
    this.latestBooks.set(market.marketId, orderbook);

    const positionManager = this.getPositionManager(market);
    const riskAssessment = this.riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
    });
    const signals = this.signalEngine.generateSignals({
      market,
      orderbook,
      positionManager,
      riskAssessment,
    });

    if (signals.length === 0) {
      this.maybePrintSlotReport(slotKey);
      return;
    }

    for (const signal of signals) {
      await this.executeSignal(market, orderbook, positionManager, signal, slotKey);
    }

    this.maybePrintSlotReport(slotKey);
  }

  private async executeSignal(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    signal: StrategySignal,
    slotKey: string
  ): Promise<void> {
    if (signal.targetPrice === null || signal.shares <= 0) {
      return;
    }

    const tokenId = signal.outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const beforeSnapshot = positionManager.getSnapshot();
    const startedAt = Date.now();
    const execution = await this.executor.executeSignal({
      market,
      orderbook,
      signal,
    });
    const afterSnapshot = positionManager.applyFill({
      outcome: signal.outcome,
      side: signal.action,
      shares: execution.shares,
      price: execution.price,
      timestamp: new Date().toISOString(),
      orderId: execution.orderId,
    });
    const realizedDelta = roundTo(afterSnapshot.realizedPnl - beforeSnapshot.realizedPnl, 4);

    if (realizedDelta !== 0) {
      recordTrade(
        slotKey,
        market.marketId,
        market.title,
        signal.outcome === 'YES' ? 'Up' : 'Down',
        realizedDelta
      );
    }

    await this.tradeLogger.logTrade({
      phase: 'live',
      timestampMs: startedAt,
      slotKey,
      marketId: market.marketId,
      marketTitle: market.title,
      slotStart: market.startTime,
      slotEnd: market.endTime,
      tokenId,
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
      shares: execution.shares,
      notionalUsd: execution.notionalUsd,
      liquidityUsd: market.liquidityUsd,
      fillRatio: signal.fillRatio,
      capitalClamp: signal.capitalClamp,
      priceMultiplier: signal.priceMultiplier,
      inventoryImbalance: afterSnapshot.inventoryImbalance,
      grossExposureShares: afterSnapshot.grossExposureShares,
      netYesShares: afterSnapshot.yesShares,
      netNoShares: afterSnapshot.noShares,
      signedNetShares: afterSnapshot.signedNetShares,
      realizedPnl: afterSnapshot.realizedPnl,
      unrealizedPnl: afterSnapshot.unrealizedPnl,
      totalPnl: afterSnapshot.totalPnl,
      orderId: execution.orderId,
      wasMaker: execution.wasMaker,
      simulationMode: execution.simulation,
      dryRun: isDryRunMode(config),
      testMode: config.TEST_MODE,
    });

    logger.info('Signal executed', {
      marketId: market.marketId,
      signalType: signal.signalType,
      outcome: signal.outcome,
      action: signal.action,
      shares: execution.shares,
      price: execution.price,
      urgency: signal.urgency,
      wasMaker: execution.wasMaker,
      signedNetShares: afterSnapshot.signedNetShares,
      totalPnl: afterSnapshot.totalPnl,
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

  private maybePrintSlotReport(slotKey: string): void {
    if (!this.pendingSlotReports.has(slotKey) || this.printedSlotReports.has(slotKey)) {
      return;
    }

    printSlotReport(slotKey);
    this.pendingSlotReports.delete(slotKey);
    this.printedSlotReports.add(slotKey);
  }

  private printPendingReports(): void {
    for (const slotKey of Array.from(this.pendingSlotReports)) {
      if (this.printedSlotReports.has(slotKey)) {
        this.pendingSlotReports.delete(slotKey);
        continue;
      }

      printSlotReport(slotKey);
      this.pendingSlotReports.delete(slotKey);
      this.printedSlotReports.add(slotKey);
    }
  }

  private async flattenAllOpenPositions(signalType: StrategySignal['signalType']): Promise<void> {
    for (const [marketId, positionManager] of this.positions.entries()) {
      const snapshot = positionManager.getSnapshot();
      if (snapshot.yesShares <= 0 && snapshot.noShares <= 0) {
        continue;
      }

      const market = this.markets.get(marketId);
      if (!market) {
        logger.warn('Skipping shutdown flatten because market metadata is missing', { marketId });
        continue;
      }

      const orderbook =
        this.latestBooks.get(marketId) ?? (await this.fetcher.getMarketSnapshot(market));
      const slotKey = getSlotKey(market);

      for (const signal of buildFlattenSignals(market, orderbook, snapshot, signalType)) {
        await this.executeSignal(market, orderbook, positionManager, signal, slotKey);
      }

      this.maybePrintSlotReport(slotKey);
    }
  }
}

export async function main(): Promise<void> {
  const runtime = new MarketMakerRuntime();

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    void runtime.shutdown('SIGINT').finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    void runtime.shutdown('SIGTERM').finally(() => process.exit(0));
  });

  await runtime.initialize();
  await runtime.run();
}

function buildFlattenSignals(
  market: MarketCandidate,
  orderbook: MarketOrderbookSnapshot,
  snapshot: ReturnType<PositionManager['getSnapshot']>,
  signalType: StrategySignal['signalType']
): StrategySignal[] {
  const signals: StrategySignal[] = [];

  if (snapshot.yesShares > 0) {
    signals.push({
      marketId: market.marketId,
      marketTitle: market.title,
      signalType,
      priority: 1000,
      action: 'SELL',
      outcome: 'YES',
      outcomeIndex: 0,
      shares: snapshot.yesShares,
      targetPrice: orderbook.yes.bestBid ?? orderbook.yes.midPrice,
      referencePrice: orderbook.yes.bestBid ?? orderbook.yes.midPrice,
      tokenPrice: orderbook.yes.lastTradePrice,
      midPrice: orderbook.yes.midPrice,
      fairValue: orderbook.yes.midPrice,
      edgeAmount: snapshot.yesShares,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: true,
      reason: 'Graceful shutdown flatten for YES inventory',
    });
  }

  if (snapshot.noShares > 0) {
    signals.push({
      marketId: market.marketId,
      marketTitle: market.title,
      signalType,
      priority: 1000,
      action: 'SELL',
      outcome: 'NO',
      outcomeIndex: 1,
      shares: snapshot.noShares,
      targetPrice: orderbook.no.bestBid ?? orderbook.no.midPrice,
      referencePrice: orderbook.no.bestBid ?? orderbook.no.midPrice,
      tokenPrice: orderbook.no.lastTradePrice,
      midPrice: orderbook.no.midPrice,
      fairValue: orderbook.no.midPrice,
      edgeAmount: snapshot.noShares,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'cross',
      reduceOnly: true,
      reason: 'Graceful shutdown flatten for NO inventory',
    });
  }

  return signals;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
