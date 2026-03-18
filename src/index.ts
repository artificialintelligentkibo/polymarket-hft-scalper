import { pathToFileURL } from 'node:url';
import { ClobFetcher, type MarketOrderbookSnapshot } from './clob-fetcher.js';
import { config, isDryRunMode, validateConfig } from './config.js';
import { buildFlattenSignals } from './flatten-signals.js';
import { logger, TradeLogger } from './logger.js';
import {
  MarketMonitor,
  describeDiscoveryMode,
  getSlotKey,
  type MarketCandidate,
} from './monitor.js';
import { OrderExecutor } from './order-executor.js';
import { PositionManager } from './position-manager.js';
import { RiskManager } from './risk-manager.js';
import { SignalScalper } from './signal-scalper.js';
import { ensureSlotResult, recordTrade, writeSlotReport } from './slot-reporter.js';
import type { StrategySignal } from './strategy-types.js';
import { pruneSetEntries, roundTo, sleep } from './utils.js';

const MAX_TRACKED_SLOT_REPORTS = 2_048;

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
      ensureSlotResult(
        slotKey,
        market.marketId,
        market.title,
        market.startTime,
        market.endTime
      );
      this.pendingSlotReports.add(slotKey);
      this.pruneSlotReportState();
    });
  }

  async initialize(): Promise<void> {
    validateConfig();
    await this.tradeLogger.ensureReady();
    await this.executor.initialize();
    const discoveryMode = describeDiscoveryMode(config);

    logger.info('Polymarket dual-sided market-maker initialized', {
      simulationMode: config.SIMULATION_MODE,
      testMode: config.TEST_MODE,
      dryRun: config.DRY_RUN,
      enableSignal: config.ENABLE_SIGNAL,
      minCombinedDiscount: config.strategy.minCombinedDiscount,
      extremeBuyThreshold: config.strategy.extremeBuyThreshold,
      extremeSellThreshold: config.strategy.extremeSellThreshold,
      maxSignalsPerTick: config.strategy.maxSignalsPerTick,
      discoveryMode: discoveryMode.mode,
      discoveryDescription: discoveryMode.description,
      whitelistSize: config.WHITELIST_CONDITION_IDS.length,
      coinsToTrade: config.COINS_TO_TRADE,
      filterFiveMinuteOnly: config.FILTER_5MIN_ONLY,
      minLiquidityUsd: config.MIN_LIQUIDITY_USD,
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
          await this.flushPendingReports();
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
      await this.flushPendingReports();
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

    await this.flushPendingReports();
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
      await this.maybeWriteSlotReport(slotKey);
      return;
    }

    for (const signal of signals) {
      try {
        await this.executeSignal(market, orderbook, positionManager, signal, slotKey);
      } catch (error: any) {
        logger.warn('Signal execution failed for market tick', {
          marketId: market.marketId,
          signalType: signal.signalType,
          outcome: signal.outcome,
          action: signal.action,
          message: error?.message || 'Unknown error',
        });
      }
    }

    await this.maybeWriteSlotReport(slotKey);
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
        resolveSlotOutcome(market, signal.outcome),
        realizedDelta,
        market.startTime,
        market.endTime
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

  private async maybeWriteSlotReport(slotKey: string): Promise<void> {
    if (!this.pendingSlotReports.has(slotKey) || this.printedSlotReports.has(slotKey)) {
      return;
    }

    try {
      await writeSlotReport(slotKey);
      this.pendingSlotReports.delete(slotKey);
      this.printedSlotReports.add(slotKey);
    } catch (error: any) {
      logger.warn('Could not write slot report', {
        slotKey,
        message: error?.message || 'Unknown error',
      });
    }

    this.pruneSlotReportState();
  }

  private async flushPendingReports(): Promise<void> {
    for (const slotKey of Array.from(this.pendingSlotReports)) {
      if (this.printedSlotReports.has(slotKey)) {
        this.pendingSlotReports.delete(slotKey);
        continue;
      }

      try {
        await writeSlotReport(slotKey);
        this.pendingSlotReports.delete(slotKey);
        this.printedSlotReports.add(slotKey);
      } catch (error: any) {
        logger.warn('Could not flush slot report', {
          slotKey,
          message: error?.message || 'Unknown error',
        });
      }
    }

    this.pruneSlotReportState();
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

      for (const signal of buildFlattenSignals({
        market,
        orderbook,
        snapshot,
        signalType,
        reasonPrefix: 'Graceful shutdown',
      })) {
        try {
          await this.executeSignal(market, orderbook, positionManager, signal, slotKey);
        } catch (error: any) {
          logger.warn('Shutdown flatten signal failed', {
            marketId,
            signalType: signal.signalType,
            outcome: signal.outcome,
            message: error?.message || 'Unknown error',
          });
        }
      }

      await this.maybeWriteSlotReport(slotKey);
    }
  }

  private pruneSlotReportState(): void {
    pruneSetEntries(this.pendingSlotReports, MAX_TRACKED_SLOT_REPORTS);
    pruneSetEntries(this.printedSlotReports, MAX_TRACKED_SLOT_REPORTS);
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

function resolveSlotOutcome(
  market: Pick<MarketCandidate, 'yesLabel' | 'noLabel'>,
  outcome: StrategySignal['outcome']
): 'Up' | 'Down' {
  const label = outcome === 'YES' ? market.yesLabel : market.noLabel;
  const normalized = String(label || '').trim().toUpperCase();
  if (
    normalized === 'DOWN' ||
    normalized === 'NO' ||
    normalized === 'FALSE' ||
    normalized === 'SHORT'
  ) {
    return 'Down';
  }

  if (
    normalized === 'UP' ||
    normalized === 'YES' ||
    normalized === 'TRUE' ||
    normalized === 'LONG'
  ) {
    return 'Up';
  }

  return outcome === 'YES' ? 'Up' : 'Down';
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
