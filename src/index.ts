import { AutoRedeemer } from './auto-redeemer.js';
import { pathToFileURL } from 'node:url';
import { ClobFetcher, type MarketOrderbookSnapshot } from './clob-fetcher.js';
import { config, isDryRunMode, validateConfig } from './config.js';
import { getDayPnlState } from './day-pnl-state.js';
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
import { ProductTestModeController } from './product-test-mode.js';
import { writeLatencyLog } from './reports.js';
import { RiskManager } from './risk-manager.js';
import { writeRuntimeStatus, type RuntimeSignalSnapshot } from './runtime-status.js';
import { SignalScalper } from './signal-scalper.js';
import {
  ensureSlotResult,
  getSlotMetrics,
  printSlotReport,
  recordExecution,
  recordTrade,
} from './slot-reporter.js';
import type { StrategySignal } from './strategy-types.js';
import { pruneSetEntries, roundTo, sleep } from './utils.js';

const MAX_TRACKED_SLOT_REPORTS = 2_048;
const UNCONFIRMED_ORDER_COOLDOWN_MS = 15_000;

class MarketMakerRuntime {
  private readonly monitor = new MarketMonitor();
  private readonly fetcher = new ClobFetcher();
  private readonly executor = new OrderExecutor();
  private readonly tradeLogger = new TradeLogger();
  private readonly riskManager = new RiskManager();
  private readonly signalEngine = new SignalScalper();
  private readonly redeemer = new AutoRedeemer();
  private readonly productTestMode = new ProductTestModeController();
  private readonly positions = new Map<string, PositionManager>();
  private readonly markets = new Map<string, MarketCandidate>();
  private readonly latestBooks = new Map<string, MarketOrderbookSnapshot>();
  private readonly marketWork = new Map<string, Promise<void>>();
  private readonly pendingSlotReports = new Set<string>();
  private readonly printedSlotReports = new Set<string>();
  private readonly pendingLiveOrders = new Map<string, number>();
  private readonly recentSignals: RuntimeSignalSnapshot[] = [];
  private readonly recentLatencySamples: number[] = [];
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

    this.redeemer.on('redeem-success', (payload) => {
      this.productTestMode.recordRedeemSuccess(payload);
      if (this.productTestMode.isCompleted()) {
        logger.info('PRODUCT_TEST_MODE completed after redeem success');
        this.stop();
      }
    });

    this.redeemer.on('redeem-failed', (payload) => {
      this.productTestMode.recordRedeemFailure(
        String(payload?.conditionId ?? ''),
        String(payload?.message ?? 'Unknown redeem error')
      );
      if (this.productTestMode.isCompleted()) {
        logger.warn('PRODUCT_TEST_MODE completed with redeem failure');
        this.stop();
      }
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
      effectiveDryRun: isDryRunMode(config),
      productTestMode: config.PRODUCT_TEST_MODE,
      testMinTradeUsdc: config.TEST_MIN_TRADE_USDC,
      testMaxSlots: config.TEST_MAX_SLOTS,
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
      autoRedeem: config.AUTO_REDEEM,
      redeemIntervalMs: config.REDEEM_INTERVAL_MS,
    });
    this.syncRuntimeStatus({
      running: true,
      pid: process.pid,
      activeSlotsCount: 0,
      lastSignals: [],
      averageLatencyMs: null,
    });
    this.redeemer.start();
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

    if (!this.stopping) {
      await this.shutdown('RUN_LOOP_STOPPED');
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
      this.syncRuntimeStatus({
        running: false,
        pid: process.pid,
        activeSlotsCount: 0,
      });
      this.pendingLiveOrders.clear();
      this.redeemer.stop();
      this.fetcher.close();
    }
  }

  private async runCycle(): Promise<void> {
    const scannedMarkets = await this.monitor.scanEligibleMarkets();
    const markets = this.productTestMode.selectMarkets(scannedMarkets);
    this.syncRuntimeStatus({
      running: true,
      activeSlotsCount: markets.length,
    });
    if (markets.length === 0) {
      if (this.productTestMode.maybeFinalizePending()) {
        logger.info('PRODUCT_TEST_MODE finalized without additional market activity');
        this.stop();
      } else {
        logger.debug('No eligible markets found for this cycle');
      }
      this.printPendingReports();
      return;
    }

    for (const market of markets) {
      this.markets.set(market.marketId, market);
    }

    const tokenIds = markets.flatMap((market) => [market.yesTokenId, market.noTokenId]);
    await this.fetcher.subscribeAssets(tokenIds);

    await runWithConcurrency(markets, config.runtime.maxConcurrentMarkets, async (market) => {
      await this.runSerializedMarketTask(market.marketId, async () => {
        await this.processMarket(market);
      });
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
      try {
        await this.executeSignal(market, orderbook, positionManager, signal, slotKey);
      } catch (error: any) {
        this.productTestMode.recordExecutionError(
          `Signal execution failed for ${market.marketId} ${signal.signalType} ${signal.outcome}: ${error?.message || 'Unknown error'}`
        );
        logger.warn('Signal execution failed for market tick', {
          marketId: market.marketId,
          signalType: signal.signalType,
          outcome: signal.outcome,
          action: signal.action,
          message: error?.message || 'Unknown error',
        });
      }
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

    const pendingOrderKey = this.getPendingOrderKey(market.marketId, signal.outcome);
    if (this.hasPendingLiveOrder(pendingOrderKey)) {
      logger.debug('Skipping signal because live resting order is still pending', {
        marketId: market.marketId,
        signalType: signal.signalType,
        outcome: signal.outcome,
        action: signal.action,
      });
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
    const effectiveShares = execution.fillConfirmed ? execution.filledShares : 0;
    const effectivePrice = execution.fillPrice ?? execution.price;
    const effectiveNotionalUsd = execution.fillConfirmed
      ? roundTo(effectiveShares * effectivePrice, 2)
      : 0;
    const afterSnapshot =
      effectiveShares > 0
        ? positionManager.applyFill({
            outcome: signal.outcome,
            side: signal.action,
            shares: effectiveShares,
            price: effectivePrice,
            timestamp: new Date().toISOString(),
            orderId: execution.orderId,
          })
        : beforeSnapshot;

    if (effectiveShares > 0) {
      this.clearPendingLiveOrder(pendingOrderKey);
      recordExecution({
        slotKey,
        marketId: market.marketId,
        marketTitle: market.title,
        outcome: resolveSlotOutcome(market, signal.outcome),
        action: signal.action,
        notionalUsd: effectiveNotionalUsd,
        slotStart: market.startTime,
        slotEnd: market.endTime,
      });
    } else if (!execution.simulation) {
      this.rememberPendingLiveOrder(pendingOrderKey);
      logger.warn('Live order submitted without confirmed fill; skipped position mutation', {
        marketId: market.marketId,
        signalType: signal.signalType,
        outcome: signal.outcome,
        action: signal.action,
        orderId: execution.orderId,
        submittedShares: execution.shares,
        submittedPrice: execution.price,
      });
    }

    const realizedDelta =
      effectiveShares > 0
        ? roundTo(afterSnapshot.realizedPnl - beforeSnapshot.realizedPnl, 4)
        : 0;

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
    const completedAt = Date.now();
    if (effectiveShares > 0 && signal.signalType === 'HARD_STOP' && signal.action === 'SELL') {
      positionManager.setEntryCooldown(
        signal.outcome,
        config.strategy.hardStopCooldownMs,
        new Date(completedAt)
      );
    }

    const slotMetrics = getSlotMetrics(slotKey);
    const dayState = getDayPnlState(new Date(completedAt));
    const latencyRoundTripMs =
      signal.generatedAt !== undefined ? Math.max(0, completedAt - signal.generatedAt) : undefined;

    this.productTestMode.recordExecution({
      market,
      signal,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
    });

    writeLatencyLog({
      timestampMs: completedAt,
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: signal.signalType,
      action: signal.action,
      outcome: signal.outcome,
      orderId: execution.orderId,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
      simulationMode: execution.simulation,
      dryRun: isDryRunMode(config),
      testMode: config.TEST_MODE,
    });

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
      urgency: execution.urgency,
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
      shares: effectiveShares,
      notionalUsd: effectiveNotionalUsd,
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
      slotEntryCount: slotMetrics?.entryCount,
      slotFillCount: slotMetrics?.fillCount,
      upExposureUsd: slotMetrics?.upExposureUsd,
      downExposureUsd: slotMetrics?.downExposureUsd,
      dayPnl: dayState.dayPnl,
      peakDayPnl: dayState.peakPnl,
      dayDrawdown: dayState.drawdown,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
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
      shares: effectiveShares,
      submittedShares: execution.shares,
      price: effectivePrice,
      urgency: execution.urgency,
      wasMaker: execution.wasMaker,
      fillConfirmed: execution.fillConfirmed,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
      signedNetShares: afterSnapshot.signedNetShares,
      totalPnl: afterSnapshot.totalPnl,
      dayDrawdown: dayState.drawdown,
    });

    this.recordRuntimeSignal({
      timestamp: new Date(completedAt).toISOString(),
      marketId: market.marketId,
      signalType: signal.signalType,
      action: signal.action,
      outcome: signal.outcome,
      latencyMs:
        latencyRoundTripMs ?? execution.latencySignalToOrderMs ?? null,
    });
    this.syncRuntimeStatus({
      totalDayPnl: dayState.dayPnl,
      dayDrawdown: dayState.drawdown,
      lastSignals: this.recentSignals,
      averageLatencyMs: this.getAverageLatencyMs(),
    });
  }

  private recordRuntimeSignal(signal: RuntimeSignalSnapshot): void {
    this.recentSignals.push(signal);
    while (this.recentSignals.length > 3) {
      this.recentSignals.shift();
    }

    if (signal.latencyMs !== null && Number.isFinite(signal.latencyMs)) {
      this.recentLatencySamples.push(Math.max(0, signal.latencyMs));
      while (this.recentLatencySamples.length > 64) {
        this.recentLatencySamples.shift();
      }
    }
  }

  private getAverageLatencyMs(): number | null {
    if (this.recentLatencySamples.length === 0) {
      return null;
    }

    const total = this.recentLatencySamples.reduce((sum, value) => sum + value, 0);
    return roundTo(total / this.recentLatencySamples.length, 2);
  }

  private syncRuntimeStatus(overrides: Parameters<typeof writeRuntimeStatus>[0]): void {
    writeRuntimeStatus(
      {
        running: this.running && !this.stopping,
        pid: process.pid,
        totalDayPnl: getDayPnlState().dayPnl,
        dayDrawdown: getDayPnlState().drawdown,
        lastSignals: this.recentSignals,
        averageLatencyMs: this.getAverageLatencyMs(),
        ...overrides,
      },
      config
    );
  }

  private recordRuntimeSlotReport(slotKey: string): void {
    const metrics = getSlotMetrics(slotKey);
    if (!metrics) {
      return;
    }

    this.syncRuntimeStatus({
      lastSlotReport: {
        slotLabel: metrics.marketTitle || slotKey,
        marketId: metrics.marketId,
        upPnl: metrics.upPnl,
        downPnl: metrics.downPnl,
        netPnl: metrics.total,
        entries: metrics.entryCount,
        fills: metrics.fillCount,
        reportedAt: metrics.updatedAt,
      },
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

  private getPendingOrderKey(marketId: string, outcome: StrategySignal['outcome']): string {
    return `${marketId}:${outcome}`;
  }

  private async runSerializedMarketTask(
    marketId: string,
    task: () => Promise<void>
  ): Promise<void> {
    const previous = this.marketWork.get(marketId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = previous.then(() => current);
    this.marketWork.set(marketId, chain);
    await previous;

    try {
      await task();
    } finally {
      releaseCurrent();
      if (this.marketWork.get(marketId) === chain) {
        this.marketWork.delete(marketId);
      }
    }
  }

  private hasPendingLiveOrder(key: string): boolean {
    const pendingUntil = this.pendingLiveOrders.get(key);
    if (!pendingUntil) {
      return false;
    }

    if (pendingUntil <= Date.now()) {
      this.pendingLiveOrders.delete(key);
      return false;
    }

    return true;
  }

  private rememberPendingLiveOrder(key: string): void {
    this.pendingLiveOrders.set(key, Date.now() + UNCONFIRMED_ORDER_COOLDOWN_MS);
  }

  private clearPendingLiveOrder(key: string): void {
    this.pendingLiveOrders.delete(key);
  }

  private maybePrintSlotReport(slotKey: string): void {
    if (!this.pendingSlotReports.has(slotKey) || this.printedSlotReports.has(slotKey)) {
      return;
    }

    printSlotReport(slotKey);
    this.recordRuntimeSlotReport(slotKey);
    this.notifyProductTestSlotReport(slotKey);
    this.pendingSlotReports.delete(slotKey);
    this.printedSlotReports.add(slotKey);
    this.pruneSlotReportState();
  }

  private printPendingReports(): void {
    for (const slotKey of Array.from(this.pendingSlotReports)) {
      if (this.printedSlotReports.has(slotKey)) {
        this.pendingSlotReports.delete(slotKey);
        continue;
      }

      printSlotReport(slotKey);
      this.recordRuntimeSlotReport(slotKey);
      this.notifyProductTestSlotReport(slotKey);
      this.pendingSlotReports.delete(slotKey);
      this.printedSlotReports.add(slotKey);
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

      this.maybePrintSlotReport(slotKey);
    }
  }

  private pruneSlotReportState(): void {
    pruneSetEntries(this.pendingSlotReports, MAX_TRACKED_SLOT_REPORTS);
    pruneSetEntries(this.printedSlotReports, MAX_TRACKED_SLOT_REPORTS);
  }

  private notifyProductTestSlotReport(slotKey: string): void {
    const metrics = getSlotMetrics(slotKey);
    const market = this.findMarketBySlotKey(slotKey);
    if (!market) {
      return;
    }

    this.productTestMode.recordSlotReport(market, metrics);
    if (this.productTestMode.isCompleted()) {
      logger.info('PRODUCT_TEST_MODE completed after slot reporting');
      this.stop();
    }
  }

  private findMarketBySlotKey(slotKey: string): MarketCandidate | undefined {
    for (const market of this.markets.values()) {
      if (getSlotKey(market) === slotKey) {
        return market;
      }
    }

    return undefined;
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
  void main().catch((error) => {
    logger.error('Fatal runtime error', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
