import { AutoRedeemer } from './auto-redeemer.js';
import { pathToFileURL } from 'node:url';
import type { BinanceEdgeAssessment } from './binance-edge.js';
import { BinanceEdgeProvider, extractCoinFromTitle } from './binance-edge.js';
import {
  BinanceDeepIntegration,
  type DeepBinanceAssessment,
} from './binance-deep-integration.js';
import {
  ClobFetcher,
  ClobUserStream,
  type MarketOrderbookSnapshot,
} from './clob-fetcher.js';
import {
  config,
  isDryRunMode,
  isDeepBinanceEnabled,
  isDynamicQuotingEnabled,
  isPaperTradingEnabled,
  validateConfig,
} from './config.js';
import { CostBasisLedger } from './cost-basis-ledger.js';
import { getDayPnlState, recordDayPnlDelta } from './day-pnl-state.js';
import { FillTracker, type ConfirmedFill } from './fill-tracker.js';
import { buildFlattenSignals } from './flatten-signals.js';
import { logger, TradeLogger } from './logger.js';
import {
  MarketMonitor,
  describeDiscoveryMode,
  getSlotKey,
  type MarketCandidate,
} from './monitor.js';
import { OrderExecutor, type OrderExecutionReport } from './order-executor.js';
import { meetsClobMinimums, resolveMinimumTradableShares } from './paired-arbitrage.js';
import { PositionManager } from './position-manager.js';
import { ProductTestModeController } from './product-test-mode.js';
import {
  buildQuoteRefreshPlan,
  countActiveMMMarkets,
  QuotingEngine,
  type ActiveQuoteOrder,
  type QuoteRefreshPlan,
} from './quoting-engine.js';
import { writeLatencyLog } from './reports.js';
import { RiskManager } from './risk-manager.js';
import {
  type RuntimeMmQuoteSnapshot,
  writeRuntimeStatus,
  type RuntimeMarketSnapshot,
  type RuntimePositionSnapshot,
  type RuntimeSignalSnapshot,
  type SkippedSignalRecord,
} from './runtime-status.js';
import {
  SignalScalper,
  type FairValueBinanceAdjustment,
} from './signal-scalper.js';
import {
  StatusMonitor,
  consumeStatusControlCommand,
  type PauseStateSnapshot,
} from './status-monitor.js';
import {
  ensureSlotResult,
  getSlotMetrics,
  printSlotReport,
  recordExecution,
  recordSkippedSignal as recordSlotReporterSkip,
  recordTrade,
} from './slot-reporter.js';
import {
  bypassesBinanceEdge,
  isQuotingSignalType,
  type StrategySignal,
} from './strategy-types.js';
import { formatDayKey, pruneSetEntries, roundTo, sleep } from './utils.js';

const MAX_TRACKED_SLOT_REPORTS = 2_048;
const UNCONFIRMED_ORDER_COOLDOWN_MS = 15_000;

interface SignalExecutionCandidate {
  readonly signal: StrategySignal;
  readonly binanceAssessment?: BinanceEdgeAssessment;
}

interface RuntimeMarketActionSnapshot {
  readonly action: string;
  readonly signalCount: number;
  readonly updatedAt: string;
}

export interface LatencyPauseEvaluation {
  readonly latencyPaused: boolean;
  readonly averageLatencyMs: number | null;
  readonly transition: 'pause' | 'resume' | 'none';
}

export interface LatencySample {
  readonly valueMs: number;
  readonly recordedAtMs: number;
}

export class MarketMakerRuntime {
  private readonly monitor = new MarketMonitor();
  private readonly fetcher = new ClobFetcher();
  private readonly userStream = new ClobUserStream();
  private readonly executor = new OrderExecutor();
  private readonly statusMonitor = new StatusMonitor();
  private readonly binanceEdge = new BinanceEdgeProvider();
  private readonly deepBinance = new BinanceDeepIntegration();
  private readonly tradeLogger = new TradeLogger();
  private readonly riskManager = new RiskManager();
  private readonly signalEngine = new SignalScalper();
  private readonly quotingEngine = new QuotingEngine();
  private readonly redeemer = new AutoRedeemer();
  private readonly fillTracker = new FillTracker(
    {
      getOrderStatus: (orderId) => this.executor.getOrderStatus(orderId),
      cancelOrder: (orderId) => this.executor.cancelOrder(orderId),
    },
    config
  );
  private readonly productTestMode = new ProductTestModeController();
  private readonly positions = new Map<string, PositionManager>();
  private readonly markets = new Map<string, MarketCandidate>();
  private readonly latestBooks = new Map<string, MarketOrderbookSnapshot>();
  private readonly marketActions = new Map<string, RuntimeMarketActionSnapshot>();
  private readonly marketWork = new Map<string, Promise<void>>();
  private readonly pendingSlotReports = new Set<string>();
  private readonly printedSlotReports = new Set<string>();
  private readonly costBasisLedger = new CostBasisLedger();
  private readonly blockedExitRemainders = new Map<
    string,
    {
      marketId: string;
      outcome: StrategySignal['outcome'];
      shares: number;
      updatedAt: string;
    }
  >();
  private readonly pendingLiveOrders = new Map<string, number>();
  private readonly settlementCooldowns = new Map<string, number>();
  private readonly settlementStartedAt = new Map<string, number>();
  private readonly settlementAttempts = new Map<string, number>();
  private readonly paperResolutionTimers = new Map<string, NodeJS.Timeout>();
  private userStreamCredentials: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null = null;
  private userStreamStarted = false;
  private readonly recentSignals: RuntimeSignalSnapshot[] = [];
  private readonly recentSkippedSignals: SkippedSignalRecord[] = [];
  private readonly recentLatencySamples: number[] = [];
  private readonly latencyWindow: LatencySample[] = [];
  private latencyPaused = false;
  private readonly activeMarketIds = new Set<string>();
  private redeemPnlToday = 0;
  private redeemPnlDayKey = formatDayKey(new Date());
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
      this.schedulePaperResolution(market);
      this.pruneSlotReportState();
    });

    this.redeemer.on('redeem-success', (payload) => {
      this.productTestMode.recordRedeemSuccess(payload);
      const conditionId = String(payload?.conditionId ?? '').trim();
      const redeemedShares = Number(payload?.redeemedAmount ?? 0);
      const redeemedAt = resolveRedeemTimestamp(payload?.timestampMs);

      this.resetRedeemPnlDayIfNeeded(redeemedAt);
      if (conditionId && redeemedShares > 0) {
        const entry = this.costBasisLedger.get(conditionId);
        const result = this.costBasisLedger.calculateRedeemPnl(conditionId, redeemedShares);
        if (result.found && Number.isFinite(result.pnl)) {
          const dayState = recordDayPnlDelta(result.pnl, redeemedAt, config);
          this.redeemPnlToday = roundTo(this.redeemPnlToday + result.pnl, 4);
          logger.info('Redeem PnL recorded', {
            conditionId,
            title: String(payload?.title ?? entry?.marketTitle ?? 'Unknown'),
            redeemedShares,
            costBasis: entry?.totalCostUsd ?? 0,
            soldShares: entry?.soldShares ?? 0,
            soldCostUsd: entry?.soldCostUsd ?? 0,
            soldProceeds: entry?.soldProceeds ?? 0,
            remainingShares: result.remainingShares,
            remainingCost: result.remainingCost,
            redeemPayout: result.redeemPayout,
            redeemPnl: result.pnl,
            newDayPnl: dayState.dayPnl,
          });
          this.syncRuntimeStatus({
            totalDayPnl: dayState.dayPnl,
            dayDrawdown: dayState.drawdown,
          });
        } else {
          logger.warn('Redeem PnL skipped — no cost basis', {
            conditionId,
            redeemedShares,
            reason: 'Position may have been opened before bot restart or by another system',
          });
        }

        this.costBasisLedger.consume(conditionId);
      }
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

    this.statusMonitor.on('pause', (state: PauseStateSnapshot) => {
      logger.warn('BOT PAUSED', {
        source: state.source,
        reason: state.reason,
      });
      this.syncRuntimeStatus({
        isPaused: true,
        systemStatus: 'PAUSED',
        pauseReason: state.reason,
        pauseSource: state.source,
      });
    });

    this.statusMonitor.on('resume', (state: PauseStateSnapshot) => {
      logger.info('BOT RESUMED', {
        source: state.source,
      });
      this.syncRuntimeStatus({
        isPaused: false,
        systemStatus: 'OK',
        pauseReason: null,
        pauseSource: null,
      });
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
      isPaused: this.statusMonitor.isPaused(),
      systemStatus: this.statusMonitor.isPaused() ? 'PAUSED' : 'OK',
      pauseReason: this.statusMonitor.getState().reason,
      pauseSource: this.statusMonitor.getState().source,
      activeSlotsCount: 0,
      openPositionsCount: 0,
      latencyPaused: false,
      latencyPauseAverageMs: null,
      activeMarkets: [],
      openPositions: [],
      lastSignals: [],
      recentSkippedSignals: [],
      averageLatencyMs: null,
    });
    this.statusMonitor.start();
    this.binanceEdge.start();
    this.deepBinance.start();
    if (isDynamicQuotingEnabled(config)) {
      this.quotingEngine.start(async (plan) => {
        await this.handleQuoteRefresh(plan);
      });
    }
    if (!isDryRunMode(config)) {
      if (!isPaperTradingEnabled(config)) {
        this.userStream.on('fills', (fills) => {
          this.fillTracker.recordRealtimeFills(fills);
        });
        this.userStream.on('connection', ({ connected }) => {
          this.fillTracker.setRealtimeFeedConnected(Boolean(connected));
        });
        this.userStreamCredentials = await this.executor.getApiCredentials();
        this.fillTracker.start();
      }
    }
    if (!isPaperTradingEnabled(config)) {
      this.redeemer.start();
    }
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

      this.consumeControlCommands();
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
    this.fillTracker.stop();
    this.userStream.stop();

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
      this.activeMarketIds.clear();
      this.marketActions.clear();
      this.syncRuntimeStatus({
        running: false,
        pid: process.pid,
        isPaused: this.statusMonitor.isPaused(),
        systemStatus: this.statusMonitor.isPaused() ? 'PAUSED' : 'OK',
        pauseReason: this.statusMonitor.getState().reason,
        pauseSource: this.statusMonitor.getState().source,
        activeSlotsCount: 0,
        activeMarkets: [],
      });
      this.pendingLiveOrders.clear();
      this.settlementCooldowns.clear();
      this.settlementStartedAt.clear();
      this.settlementAttempts.clear();
      for (const timer of this.paperResolutionTimers.values()) {
        clearTimeout(timer);
      }
      this.paperResolutionTimers.clear();
      this.userStreamCredentials = null;
      this.userStreamStarted = false;
      this.redeemer.stop();
      this.quotingEngine.stop();
      this.statusMonitor.stop();
      this.binanceEdge.stop();
      this.deepBinance.stop();
      this.fetcher.close();
    }
  }

  private async runCycle(): Promise<void> {
    this.resetRedeemPnlDayIfNeeded();
    for (const fill of this.fillTracker.drainConfirmedFills()) {
      this.applyConfirmedFill(fill);
    }
    this.costBasisLedger.prune(30 * 60 * 1000);
    this.pruneBlockedExitRemainders();
    this.pruneSettlementConfirmationState();

    this.consumeControlCommands();
    this.refreshLatencyPauseState();
    const scannedMarkets = await this.monitor.scanEligibleMarkets();
    const markets = this.productTestMode.selectMarkets(scannedMarkets);
    this.setActiveMarkets(markets);
    if (isDynamicQuotingEnabled(config)) {
      for (const order of this.quotingEngine.removeInactiveMarkets(this.activeMarketIds)) {
        await this.cancelQuoteOrder(order);
      }
    }
    this.syncRuntimeStatus({
      running: true,
      isPaused: this.statusMonitor.isPaused(),
      systemStatus: this.statusMonitor.isPaused() ? 'PAUSED' : 'OK',
      pauseReason: this.statusMonitor.getState().reason,
      pauseSource: this.statusMonitor.getState().source,
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
    if (!isDryRunMode(config) && !isPaperTradingEnabled(config)) {
      try {
        if (!this.userStreamStarted && this.userStreamCredentials) {
          await this.userStream.start(this.userStreamCredentials);
          this.userStreamStarted = true;
        }
        await this.userStream.syncMarkets(markets.map((market) => market.conditionId));
      } catch (error: any) {
        logger.debug('Failed to sync authenticated user stream markets', {
          message: error?.message || 'Unknown error',
        });
      }
    }

    await runWithConcurrency(markets, config.runtime.maxConcurrentMarkets, async (market) => {
      await this.runSerializedMarketTask(market.marketId, async () => {
        await this.processMarket(market);
      });
    });

    this.syncRuntimeStatus({
      activeSlotsCount: markets.length,
    });
    this.printPendingReports();
  }

  private async processMarket(market: MarketCandidate): Promise<void> {
    const slotKey = getSlotKey(market);
    const orderbook = await this.fetcher.getMarketSnapshot(market);
    this.latestBooks.set(market.marketId, orderbook);
    this.executor.recordOrderbookSnapshot(orderbook);

    const positionManager = this.getPositionManager(market);
    const riskAssessment = this.riskManager.checkRiskLimits({
      market,
      orderbook,
      positionManager,
    });
    const binanceFairValueAdjustment = this.getBinanceFairValueAdjustment(market, orderbook);
    const binanceAssessment = this.getPrimaryBinanceAssessment(market, orderbook);
    const deepBinanceAssessment = this.getDeepBinanceAssessment(market, orderbook);
    const signals = this.signalEngine.generateSignals({
      market,
      orderbook,
      positionManager,
      riskAssessment,
      binanceFairValueAdjustment,
      binanceAssessment,
    });
    this.rememberSkippedSignals(this.signalEngine.drainSkippedSignals());
    const statusPausedSignals = this.applyPauseFilter(market, signals);
    const apiGuardSignals = this.applyApiCircuitBreakerFilter(
      market,
      statusPausedSignals
    );
    const latencyPausedSignals = this.applyLatencyPauseFilter(
      market,
      apiGuardSignals
    );
    const quoteSignals = isDynamicQuotingEnabled(config)
      ? latencyPausedSignals.filter((signal) => isQuotingSignalType(signal.signalType))
      : [];
    const directSignals = isDynamicQuotingEnabled(config)
      ? latencyPausedSignals.filter((signal) => !isQuotingSignalType(signal.signalType))
      : latencyPausedSignals;
    if (isDynamicQuotingEnabled(config)) {
      const allowEntryQuotes = this.shouldAllowMarketMakingEntries(
        market.marketId,
        positionManager
      );
      this.quotingEngine.syncMarketContext({
        market,
        orderbook,
        positionManager,
        riskAssessment,
        quoteSignals,
        allowEntryQuotes,
        binanceFairValueAdjustment,
        deepBinanceAssessment,
      });
    }
    const executionCandidates = this.applyBinanceEdge(market, orderbook, directSignals);
    this.rememberMarketAction(market, signals, executionCandidates, positionManager, quoteSignals);

    if (executionCandidates.length === 0 && quoteSignals.length === 0) {
      this.syncRuntimeStatus({
        recentSkippedSignals: this.recentSkippedSignals,
      });
      this.maybePrintSlotReport(slotKey);
      return;
    }

    const pairedCandidates = executionCandidates.filter((candidate) =>
      isAtomicPairedArbExecutionCandidate(candidate.signal)
    );
    const otherCandidates =
      pairedCandidates.length === 2 &&
      new Set(pairedCandidates.map((candidate) => candidate.signal.outcome)).size === 2
        ? executionCandidates.filter(
            (candidate) => !isAtomicPairedArbExecutionCandidate(candidate.signal)
          )
        : executionCandidates;

    if (
      pairedCandidates.length === 2 &&
      new Set(pairedCandidates.map((candidate) => candidate.signal.outcome)).size === 2
    ) {
      try {
        await this.executePairedArbAtomic(
          market,
          orderbook,
          positionManager,
          pairedCandidates,
          slotKey
        );
      } catch (error: any) {
        this.productTestMode.recordExecutionError(
          `Atomic paired execution failed for ${market.marketId}: ${error?.message || 'Unknown error'}`
        );
        logger.warn('Atomic paired execution failed for market tick', {
          marketId: market.marketId,
          message: error?.message || 'Unknown error',
        });
      }
    }

    for (const candidate of otherCandidates) {
      try {
        await this.executeSignal(
          market,
          orderbook,
          positionManager,
          candidate.signal,
          slotKey,
          candidate.binanceAssessment
        );
      } catch (error: any) {
        this.productTestMode.recordExecutionError(
          `Signal execution failed for ${market.marketId} ${candidate.signal.signalType} ${candidate.signal.outcome}: ${error?.message || 'Unknown error'}`
        );
        logger.warn('Signal execution failed for market tick', {
          marketId: market.marketId,
          signalType: candidate.signal.signalType,
          outcome: candidate.signal.outcome,
          action: candidate.signal.action,
          message: error?.message || 'Unknown error',
        });
      }
    }

    this.syncRuntimeStatus({
      recentSkippedSignals: this.recentSkippedSignals,
    });
    this.maybePrintSlotReport(slotKey);
  }

  private async executeSignal(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    signal: StrategySignal,
    slotKey: string,
    binanceAssessment?: BinanceEdgeAssessment
  ): Promise<OrderExecutionReport | null> {
    if (signal.shares <= 0) {
      return null;
    }

    if (
      signal.targetPrice === null &&
      signal.midPrice === null &&
      signal.referencePrice === null &&
      signal.tokenPrice === null
    ) {
      return null;
    }

    if (this.statusMonitor.isPaused() && !signal.reduceOnly) {
      logger.warn('Execution skipped because bot is paused', {
        marketId: market.marketId,
        signalType: signal.signalType,
        outcome: signal.outcome,
        action: signal.action,
        reason: this.statusMonitor.getState().reason,
      });
      return null;
    }

    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const exitGuardPrice = resolveReduceOnlySellReferencePrice({
      signal,
      outcome: signal.outcome,
      book,
      positionManager,
    });
    const guardedSell = resolveReduceOnlySellGuard({
      signal,
      availableShares: positionManager.getShares(signal.outcome),
      referencePrice: exitGuardPrice,
    });
    if (signal.action === 'SELL' && signal.reduceOnly) {
      this.setBlockedExitRemainder(
        market.marketId,
        signal.outcome,
        guardedSell.blockedRemainderShares
      );
      if (guardedSell.skip) {
        this.recordSkippedSignal({
          signal,
          filterReason: 'MIN_ORDER_SIZE',
          details: `shares=${guardedSell.requestedShares.toFixed(4)} minimum=${guardedSell.minimumShares.toFixed(4)}`,
        });
        logger.warn('Reduce-only exit skipped below minimum order size', {
          marketId: market.marketId,
          signalType: signal.signalType,
          outcome: signal.outcome,
          requestedShares: guardedSell.requestedShares,
          minimumShares: guardedSell.minimumShares,
          blockedExitRemainderShares: guardedSell.blockedRemainderShares,
          referencePrice: exitGuardPrice,
          reason: guardedSell.reason,
        });
        return null;
      }
    }

    const executionSignal =
      guardedSell.executionShares > 0 &&
      roundTo(guardedSell.executionShares, 4) !== roundTo(signal.shares, 4)
        ? {
            ...signal,
            shares: guardedSell.executionShares,
            reason: `${signal.reason} | adjusted to executable size ${guardedSell.executionShares.toFixed(4)}`,
          }
        : signal;

    const paperTradingEnabled = isPaperTradingEnabled(config);
    const pendingOrderKey = this.getPendingOrderKey(market.marketId, executionSignal.outcome);
    if (!paperTradingEnabled) {
      const trackerPending = this.fillTracker.hasPendingOrderFor(
        market.marketId,
        executionSignal.outcome
      );
      if (!trackerPending) {
        this.clearPendingLiveOrder(pendingOrderKey);
      }

      if (this.hasPendingLiveOrder(pendingOrderKey) || trackerPending) {
        logger.debug('Skipping signal because live resting order is still pending', {
          marketId: market.marketId,
          signalType: executionSignal.signalType,
          outcome: executionSignal.outcome,
          action: executionSignal.action,
        });
        return null;
      }
    }

    const nowMs = Date.now();
    const tokenId = executionSignal.outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const settlementCooldownKey = getSettlementCooldownKey(
      market.marketId,
      executionSignal.outcome
    );
    const settlementCooldownUntil = this.settlementCooldowns.get(settlementCooldownKey);
    if (
      !paperTradingEnabled &&
      executionSignal.action === 'SELL' &&
      executionSignal.signalType !== 'HARD_STOP'
    ) {
      if (
        shouldDeferSignalForSettlement({
          signal: executionSignal,
          cooldownUntilMs: settlementCooldownUntil,
          nowMs,
        })
      ) {
        logger.debug('SELL deferred: waiting for token settlement after BUY fill', {
          marketId: market.marketId,
          signalType: executionSignal.signalType,
          outcome: executionSignal.outcome,
          remainingMs: Math.max(0, (settlementCooldownUntil ?? nowMs) - nowMs),
        });
        return null;
      }

      const settlementReady = await this.confirmSettlementForSell({
        market,
        signal: executionSignal,
        tokenId,
        nowMs,
      });
      if (!settlementReady) {
        return null;
      }
    }

    const beforeSnapshot = positionManager.getSnapshot();
    const startedAt = Date.now();
    const execution = await this.executor.executeSignal({
      market,
      orderbook,
      signal: executionSignal,
    });
    const effectiveShares = execution.fillConfirmed ? execution.filledShares : 0;
    const effectivePrice = execution.fillPrice ?? execution.price;
    const effectiveNotionalUsd = execution.fillConfirmed
      ? roundTo(effectiveShares * effectivePrice, 2)
      : 0;
    const afterSnapshot =
      effectiveShares > 0
        ? positionManager.applyFill({
            outcome: executionSignal.outcome,
            side: executionSignal.action,
            shares: effectiveShares,
            price: effectivePrice,
            timestamp: new Date().toISOString(),
            orderId: execution.orderId,
          })
        : beforeSnapshot;

    if (effectiveShares > 0) {
      this.recordCostBasisFill({
        market,
        side: executionSignal.action,
        shares: effectiveShares,
        price: effectivePrice,
      });
      this.syncBlockedExitRemainderFromInventory(
        market.marketId,
        executionSignal.outcome,
        executionSignal.outcome === 'YES' ? afterSnapshot.yesShares : afterSnapshot.noShares,
        effectivePrice
      );
      this.clearPendingLiveOrder(pendingOrderKey);
      recordExecution({
        slotKey,
        marketId: market.marketId,
        marketTitle: market.title,
        outcome: resolveSlotOutcome(market, executionSignal.outcome),
        action: executionSignal.action,
        notionalUsd: effectiveNotionalUsd,
        slotStart: market.startTime,
        slotEnd: market.endTime,
      });
    } else if (!execution.simulation) {
      this.rememberPendingLiveOrder(pendingOrderKey);
      this.fillTracker.registerPendingOrder({
        orderId: execution.orderId,
        marketId: market.marketId,
        slotKey,
        tokenId,
        outcome: executionSignal.outcome,
        side: executionSignal.action,
        submittedShares: execution.shares,
        submittedPrice: execution.price,
        signalType: executionSignal.signalType,
        placedAt: startedAt,
        slotEndTime:
          market.endTime ??
          new Date(startedAt + config.FILL_POLL_TIMEOUT_MS).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      });
      logger.warn('Live order submitted without confirmed fill; skipped position mutation', {
        marketId: market.marketId,
        signalType: executionSignal.signalType,
        outcome: executionSignal.outcome,
        action: executionSignal.action,
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
        resolveSlotOutcome(market, executionSignal.outcome),
        realizedDelta,
        market.startTime,
        market.endTime
      );
    }
    const completedAt = Date.now();
    if (!paperTradingEnabled && effectiveShares > 0 && executionSignal.action === 'BUY') {
      this.armSettlementConfirmation(market.marketId, executionSignal.outcome, completedAt);
      this.executor.invalidateOutcomeBalanceCache(tokenId);
      this.executor.invalidateBalanceValidationCache();
    } else if (!paperTradingEnabled && effectiveShares > 0 && executionSignal.action === 'SELL') {
      this.clearSettlementConfirmation(market.marketId, executionSignal.outcome);
      this.executor.invalidateOutcomeBalanceCache(tokenId);
      this.executor.invalidateBalanceValidationCache();
    }
    if (
      effectiveShares > 0 &&
      executionSignal.signalType === 'HARD_STOP' &&
      executionSignal.action === 'SELL'
    ) {
      positionManager.setEntryCooldown(
        executionSignal.outcome,
        config.strategy.hardStopCooldownMs,
        new Date(completedAt)
      );
    }
    if (effectiveShares > 0) {
      this.signalEngine.recordExecution({
        market,
        signal: executionSignal,
        filledShares: effectiveShares,
        fillPrice: effectivePrice,
        executedAtMs: completedAt,
      });
    }

    const slotMetrics = getSlotMetrics(slotKey);
    const dayState = getDayPnlState(new Date(completedAt));
    const latencyRoundTripMs =
      executionSignal.generatedAt !== undefined
        ? Math.max(0, completedAt - executionSignal.generatedAt)
        : undefined;
    this.updateLatencyPause(latencyRoundTripMs ?? execution.latencySignalToOrderMs);

    this.productTestMode.recordExecution({
      market,
      signal: executionSignal,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
    });

    writeLatencyLog({
      timestampMs: completedAt,
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: executionSignal.signalType,
      action: executionSignal.action,
      outcome: executionSignal.outcome,
      orderId: execution.orderId,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
      binanceEdge: binanceAssessment?.available,
      binanceMovePct: binanceAssessment?.available ? binanceAssessment.binanceMovePct : undefined,
      balanceCacheHits: execution.balanceCacheHits,
      balanceCacheMisses: execution.balanceCacheMisses,
      balanceCacheHitRatePct: execution.balanceCacheHitRatePct,
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
      outcome: executionSignal.outcome,
      outcomeIndex: executionSignal.outcomeIndex,
      action: executionSignal.action,
      reason: executionSignal.reason,
      signalType: executionSignal.signalType,
      priority: executionSignal.priority,
      urgency: execution.urgency,
      reduceOnly: executionSignal.reduceOnly,
      tokenPrice: executionSignal.tokenPrice,
      referencePrice: executionSignal.referencePrice,
      fairValue: executionSignal.fairValue,
      midPrice: executionSignal.midPrice,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      combinedBid: executionSignal.combinedBid,
      combinedAsk: executionSignal.combinedAsk,
      combinedMid: executionSignal.combinedMid,
      combinedDiscount: executionSignal.combinedDiscount,
      combinedPremium: executionSignal.combinedPremium,
      edgeAmount: executionSignal.edgeAmount,
      shares: effectiveShares,
      notionalUsd: effectiveNotionalUsd,
      liquidityUsd: market.liquidityUsd,
      fillRatio: executionSignal.fillRatio,
      capitalClamp: executionSignal.capitalClamp,
      priceMultiplier: executionSignal.priceMultiplier,
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
      binanceEdgeAvailable: binanceAssessment?.available,
      binanceMovePct: binanceAssessment?.available ? binanceAssessment.binanceMovePct : undefined,
      binanceDirection: binanceAssessment?.available ? binanceAssessment.direction : undefined,
      binanceSizeMultiplier:
        binanceAssessment?.available ? binanceAssessment.sizeMultiplier : undefined,
      binanceContraSignal:
        binanceAssessment?.available ? binanceAssessment.contraSignal : undefined,
      orderId: execution.orderId,
      wasMaker: execution.wasMaker,
      simulationMode: execution.simulation,
      dryRun: isDryRunMode(config),
      testMode: config.TEST_MODE,
    });

    logger.info('Signal executed', {
      marketId: market.marketId,
      signalType: executionSignal.signalType,
      outcome: executionSignal.outcome,
      action: executionSignal.action,
      reason: executionSignal.reason,
      fairValue: executionSignal.fairValue,
      shares: effectiveShares,
      submittedShares: execution.shares,
      price: effectivePrice,
      urgency: execution.urgency,
      wasMaker: execution.wasMaker,
      fillConfirmed: execution.fillConfirmed,
      latencySignalToOrderMs: execution.latencySignalToOrderMs,
      latencyRoundTripMs,
      binanceDirection: binanceAssessment?.available ? binanceAssessment.direction : undefined,
      binanceMovePct: binanceAssessment?.available ? binanceAssessment.binanceMovePct : undefined,
      binanceSizeMultiplier:
        binanceAssessment?.available ? binanceAssessment.sizeMultiplier : undefined,
      signedNetShares: afterSnapshot.signedNetShares,
      totalPnl: afterSnapshot.totalPnl,
      dayDrawdown: dayState.drawdown,
    });

    this.recordRuntimeSignal({
      timestamp: new Date(completedAt).toISOString(),
      marketId: market.marketId,
      signalType: executionSignal.signalType,
      action: executionSignal.action,
      outcome: executionSignal.outcome,
      latencyMs:
        latencyRoundTripMs ?? execution.latencySignalToOrderMs ?? null,
    });
    this.syncRuntimeStatus({
      totalDayPnl: dayState.dayPnl,
      dayDrawdown: dayState.drawdown,
      lastSignals: this.recentSignals,
      recentSkippedSignals: this.recentSkippedSignals,
      averageLatencyMs: this.getAverageLatencyMs(),
      latencyPaused: this.latencyPaused,
      latencyPauseAverageMs: this.getLatencyPauseAverageMs(),
    });
    return execution;
  }

  private async executePairedArbAtomic(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    candidates: readonly SignalExecutionCandidate[],
    slotKey: string
  ): Promise<[OrderExecutionReport | null, OrderExecutionReport | null]> {
    const orderedCandidates = [...candidates].sort((left, right) => {
      if (left.signal.priority !== right.signal.priority) {
        return right.signal.priority - left.signal.priority;
      }
      return left.signal.outcome.localeCompare(right.signal.outcome);
    });
    const [firstCandidate, secondCandidate] = orderedCandidates;
    if (!firstCandidate || !secondCandidate) {
      return [null, null];
    }

    this.signalEngine.setPairedArbPending(market.marketId);

    const leg1 = await this.executeSignal(
      market,
      orderbook,
      positionManager,
      firstCandidate.signal,
      slotKey,
      firstCandidate.binanceAssessment
    );
    if (!leg1 || !leg1.fillConfirmed || leg1.filledShares <= 0) {
      return [leg1, null];
    }

    const adjustedLeg2Signal: StrategySignal = {
      ...secondCandidate.signal,
      shares: roundTo(Math.min(secondCandidate.signal.shares, leg1.filledShares), 4),
      reason: `${secondCandidate.signal.reason} | adjusted to match leg1 fill of ${leg1.filledShares}`,
    };

    const leg2 = await this.executeSignal(
      market,
      orderbook,
      positionManager,
      adjustedLeg2Signal,
      slotKey,
      secondCandidate.binanceAssessment
    );
    if (!leg2 || !leg2.fillConfirmed || leg2.filledShares <= 0) {
      if (leg2?.orderId && !leg2.simulation && !leg2.fillConfirmed) {
        try {
          await this.executor.cancelOrder(leg2.orderId);
        } catch (error) {
          logger.debug('Paired arb leg2 cancel failed during atomic unwind', {
            marketId: market.marketId,
            orderId: leg2.orderId,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.fillTracker.forgetPendingOrder(leg2.orderId);
          this.clearPendingLiveOrder(this.getPendingOrderKey(market.marketId, secondCandidate.signal.outcome));
        }
      }

      logger.warn('Paired arb leg2 failed, unwinding leg1', {
        marketId: market.marketId,
        leg1Outcome: firstCandidate.signal.outcome,
        leg1Shares: leg1.filledShares,
      });
      await this.unwindPairedLeg(
        market,
        orderbook,
        positionManager,
        firstCandidate.signal,
        leg1,
        slotKey
      );
      return [leg1, null];
    }

    return [leg1, leg2];
  }

  private async unwindPairedLeg(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    positionManager: PositionManager,
    signal: StrategySignal,
    execution: OrderExecutionReport,
    slotKey: string
  ): Promise<OrderExecutionReport | null> {
    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const targetPrice = book.bestBid ?? book.midPrice ?? execution.fillPrice ?? execution.price;
    if (targetPrice === null || !Number.isFinite(targetPrice) || targetPrice <= 0) {
      logger.warn('Paired arb unwind skipped because no executable bid was available', {
        marketId: market.marketId,
        outcome: signal.outcome,
      });
      return null;
    }

    const unwindSignal: StrategySignal = {
      ...signal,
      signalType: 'HARD_STOP',
      priority: 999,
      action: 'SELL',
      shares: roundTo(execution.filledShares, 4),
      targetPrice,
      referencePrice: execution.fillPrice ?? execution.price,
      tokenPrice: book.lastTradePrice ?? targetPrice,
      midPrice: book.midPrice,
      fairValue: book.midPrice,
      edgeAmount: roundTo(execution.filledShares, 4),
      urgency: 'cross',
      reduceOnly: true,
      reason: 'Atomic paired-arb unwind after second leg failed',
    };

    return this.executeSignal(market, orderbook, positionManager, unwindSignal, slotKey);
  }

  private applyConfirmedFill(fill: ConfirmedFill): void {
    const market = this.markets.get(fill.marketId);
    if (!market) {
      if (!this.fillTracker.hasPendingOrderFor(fill.marketId, fill.outcome)) {
        this.clearPendingLiveOrder(this.getPendingOrderKey(fill.marketId, fill.outcome));
      }
      logger.warn('Skipping confirmed fill because market metadata is missing', {
        orderId: fill.orderId,
        marketId: fill.marketId,
        signalType: fill.signalType,
      });
      return;
    }

    const positionManager = this.getPositionManager(market);
    const beforeSnapshot = positionManager.getSnapshot();
    const afterSnapshot = positionManager.applyFill({
      outcome: fill.outcome,
      side: fill.side,
      shares: fill.filledShares,
      price: fill.fillPrice,
      timestamp: new Date(fill.filledAt).toISOString(),
      orderId: fill.orderId,
    });
    this.syncBlockedExitRemainderFromInventory(
      fill.marketId,
      fill.outcome,
      fill.outcome === 'YES' ? afterSnapshot.yesShares : afterSnapshot.noShares,
      fill.fillPrice
    );
    this.recordCostBasisFill({
      market,
      side: fill.side,
      shares: fill.filledShares,
      price: fill.fillPrice,
      filledAt: fill.filledAt,
    });
    if (fill.side === 'BUY') {
      this.armSettlementConfirmation(fill.marketId, fill.outcome, fill.filledAt);
      this.executor.invalidateOutcomeBalanceCache(fill.tokenId);
      this.executor.invalidateBalanceValidationCache();
    } else {
      this.clearSettlementConfirmation(fill.marketId, fill.outcome);
      this.executor.invalidateOutcomeBalanceCache(fill.tokenId);
      this.executor.invalidateBalanceValidationCache();
    }
    const notionalUsd = roundTo(fill.filledShares * fill.fillPrice, 2);
    const pendingOrderKey = this.getPendingOrderKey(fill.marketId, fill.outcome);
    if (!this.fillTracker.hasPendingOrderFor(fill.marketId, fill.outcome)) {
      this.clearPendingLiveOrder(pendingOrderKey);
    }

    recordExecution({
      slotKey: fill.slotKey,
      marketId: fill.marketId,
      marketTitle: market.title,
      outcome: resolveSlotOutcome(market, fill.outcome),
      action: fill.side,
      notionalUsd,
      slotStart: market.startTime,
      slotEnd: market.endTime,
    });

    const realizedDelta = roundTo(afterSnapshot.realizedPnl - beforeSnapshot.realizedPnl, 4);
    if (realizedDelta !== 0) {
      recordTrade(
        fill.slotKey,
        fill.marketId,
        market.title,
        resolveSlotOutcome(market, fill.outcome),
        realizedDelta,
        market.startTime,
        market.endTime
      );
    }

    if (fill.signalType === 'HARD_STOP' && fill.side === 'SELL') {
      positionManager.setEntryCooldown(
        fill.outcome,
        config.strategy.hardStopCooldownMs,
        new Date(fill.filledAt)
      );
    }

    this.signalEngine.recordExecution({
      market,
      signal: createTrackedSignal(market, fill),
      filledShares: fill.filledShares,
      fillPrice: fill.fillPrice,
      executedAtMs: fill.filledAt,
    });

    const dayState = getDayPnlState(new Date(fill.filledAt));
    logger.info('Applied confirmed fill from fill tracker', {
      orderId: fill.orderId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      filledShares: fill.filledShares,
      fillPrice: fill.fillPrice,
      signalType: fill.signalType,
      netYesAfter: afterSnapshot.yesShares,
      netNoAfter: afterSnapshot.noShares,
      totalPnl: afterSnapshot.totalPnl,
    });
    this.syncRuntimeStatus({
      totalDayPnl: dayState.dayPnl,
      dayDrawdown: dayState.drawdown,
      recentSkippedSignals: this.recentSkippedSignals,
      averageLatencyMs: this.getAverageLatencyMs(),
      latencyPaused: this.latencyPaused,
      latencyPauseAverageMs: this.getLatencyPauseAverageMs(),
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

  private rememberSkippedSignals(records: readonly SkippedSignalRecord[]): void {
    for (const record of records) {
      this.recentSkippedSignals.push(record);
    }
    while (this.recentSkippedSignals.length > 24) {
      this.recentSkippedSignals.shift();
    }
  }

  private recordSkippedSignal(params: {
    signal: StrategySignal;
    filterReason: string;
    details: string;
    ev?: number;
    context?: Record<string, unknown>;
  }): void {
    const record: SkippedSignalRecord = {
      timestamp: new Date().toISOString(),
      marketId: params.signal.marketId,
      signalType: params.signal.signalType,
      outcome: params.signal.outcome,
      filterReason: params.filterReason,
      ev:
        typeof params.ev === 'number' && Number.isFinite(params.ev)
          ? roundTo(params.ev, 6)
          : undefined,
      details: params.details,
    };
    this.rememberSkippedSignals([record]);
    const market = this.markets.get(params.signal.marketId);
    if (market) {
      recordSlotReporterSkip({
        slotKey: getSlotKey(market),
        marketId: market.marketId,
        marketTitle: market.title,
        slotStart: market.startTime,
        slotEnd: market.endTime,
      });
    }
    logger.event('signal_filtered', 'Signal filtered', {
      signalType: params.signal.signalType,
      outcome: params.signal.outcome,
      filterReason: params.filterReason,
      ev: record.ev,
      details: params.details,
      ...(params.context ?? {}),
    });
  }

  private getAverageLatencyMs(): number | null {
    if (this.recentLatencySamples.length === 0) {
      return null;
    }

    const total = this.recentLatencySamples.reduce((sum, value) => sum + value, 0);
    return roundTo(total / this.recentLatencySamples.length, 2);
  }

  private getLatencyPauseAverageMs(): number | null {
    const samples = pruneLatencyPauseSamples(
      this.latencyWindow,
      Date.now(),
      config.strategy.latencyPauseSampleTtlMs
    );
    if (samples.length === 0) {
      return null;
    }

    const total = samples.reduce((sum, sample) => sum + sample.valueMs, 0);
    return roundTo(total / samples.length, 2);
  }

  private refreshLatencyPauseState(nowMs = Date.now()): void {
    const prunedSamples = pruneLatencyPauseSamples(
      this.latencyWindow,
      nowMs,
      config.strategy.latencyPauseSampleTtlMs
    );
    if (prunedSamples.length !== this.latencyWindow.length) {
      this.latencyWindow.splice(0, this.latencyWindow.length, ...prunedSamples);
    }

    if (this.latencyWindow.length < 3) {
      if (this.latencyPaused) {
        this.latencyPaused = false;
        logger.info('LATENCY_PAUSE_OFF: stale latency samples expired, resuming entries', {
          sampleCount: this.latencyWindow.length,
          ttlMs: config.strategy.latencyPauseSampleTtlMs,
        });
        this.syncRuntimeStatus({
          latencyPaused: false,
          latencyPauseAverageMs: null,
        });
      }
      return;
    }

    const evaluation = evaluateLatencyPauseState({
      samples: this.latencyWindow.map((sample) => sample.valueMs),
      latencyPaused: this.latencyPaused,
      pauseThresholdMs: config.strategy.latencyPauseThresholdMs,
      resumeThresholdMs: config.strategy.latencyResumeThresholdMs,
    });
    if (evaluation.averageLatencyMs === null || evaluation.transition === 'none') {
      return;
    }

    if (evaluation.transition === 'pause') {
      this.latencyPaused = true;
      logger.warn('LATENCY_PAUSE_ON: blocking new entries due to high latency', {
        avgLatencyMs: roundTo(evaluation.averageLatencyMs, 0),
        threshold: config.strategy.latencyPauseThresholdMs,
        window: this.latencyWindow.length,
      });
      this.syncRuntimeStatus({
        latencyPaused: true,
        latencyPauseAverageMs: evaluation.averageLatencyMs,
      });
      return;
    }

    if (evaluation.transition === 'resume') {
      this.latencyPaused = false;
      logger.info('LATENCY_PAUSE_OFF: latency recovered, resuming entries', {
        avgLatencyMs: roundTo(evaluation.averageLatencyMs, 0),
        threshold: config.strategy.latencyResumeThresholdMs,
      });
      this.syncRuntimeStatus({
        latencyPaused: false,
        latencyPauseAverageMs: evaluation.averageLatencyMs,
      });
    }
  }

  private updateLatencyPause(latencyMs: number | undefined): void {
    if (latencyMs === undefined || !Number.isFinite(latencyMs)) {
      return;
    }

    this.latencyWindow.push({
      valueMs: latencyMs,
      recordedAtMs: Date.now(),
    });
    while (this.latencyWindow.length > config.strategy.latencyPauseWindowSize) {
      this.latencyWindow.shift();
    }

    this.refreshLatencyPauseState();
  }

  private getApiCircuitBreakers() {
    return {
      clob: this.executor.getClobCircuitBreakerSnapshot(),
      gamma: this.monitor.getGammaCircuitBreakerSnapshot(),
    };
  }

  private isApiEntryGateOpen(): boolean {
    const snapshots = this.getApiCircuitBreakers();
    return snapshots.clob.isOpen || snapshots.gamma.isOpen;
  }

  private syncRuntimeStatus(overrides: Parameters<typeof writeRuntimeStatus>[0]): void {
    const openPositions = this.buildRuntimePositionSnapshots();
    const dayState = getDayPnlState();
    this.resetRedeemPnlDayIfNeeded();
    this.pruneBlockedExitRemainders();
    const exitRemainderSummary = this.getBlockedExitRemainderSummary();
    writeRuntimeStatus(
      {
        running: this.running && !this.stopping,
        pid: process.pid,
        systemStatus: this.statusMonitor.isPaused() ? 'PAUSED' : 'OK',
        isPaused: this.statusMonitor.isPaused(),
        pauseReason: this.statusMonitor.getState().reason,
        pauseSource: this.statusMonitor.getState().source,
        totalDayPnl: dayState.dayPnl,
        dayDrawdown: dayState.drawdown,
        costBasisTracked: this.costBasisLedger.size,
        redeemPnlToday: this.redeemPnlToday,
        dustPositionsCount: exitRemainderSummary.dustPositionsCount,
        blockedExitRemainderShares: exitRemainderSummary.blockedExitRemainderShares,
        lastSignals: this.recentSignals,
        recentSkippedSignals: this.recentSkippedSignals,
        averageLatencyMs: this.getAverageLatencyMs(),
        latencyPaused: this.latencyPaused,
        latencyPauseAverageMs: this.getLatencyPauseAverageMs(),
        apiCircuitBreakers: this.getApiCircuitBreakers(),
        activeMarkets: this.buildRuntimeMarketSnapshots(),
        openPositions,
        openPositionsCount: openPositions.length,
        mmEnabled: isDynamicQuotingEnabled(config),
        mmAutonomousQuotes: config.MM_AUTONOMOUS_QUOTES,
        mmQuoteShares: config.MM_QUOTE_SHARES,
        mmMaxGrossExposure: config.MM_MAX_GROSS_EXPOSURE_USD,
        mmCurrentExposure: this.quotingEngine.getCurrentMMExposureUsd(),
        mmActiveMarkets: countActiveMMMarkets(this.quotingEngine),
        mmMaxConcurrentMarkets: config.MM_MAX_CONCURRENT_MARKETS,
        mmInventorySkew: config.MM_INVENTORY_SKEW_FACTOR,
        mmMaxNetDirectional: config.MM_MAX_NET_DIRECTIONAL,
        mmQuotes: this.buildRuntimeMmQuoteSnapshots(),
        ...overrides,
      },
      config
    );
  }

  private recordCostBasisFill(params: {
    market: MarketCandidate;
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
    filledAt?: number;
  }): void {
    const shares = Number.isFinite(params.shares) ? Math.max(0, params.shares) : 0;
    const price = Number.isFinite(params.price) ? Math.max(0, params.price) : 0;
    if (shares <= 0 || price <= 0) {
      return;
    }

    const timestamp =
      typeof params.filledAt === 'number' && Number.isFinite(params.filledAt)
        ? new Date(params.filledAt).toISOString()
        : new Date().toISOString();
    if (params.side === 'BUY') {
      this.costBasisLedger.recordBuy({
        conditionId: params.market.conditionId,
        marketTitle: params.market.title,
        shares,
        price,
        timestamp,
      });
      return;
    }

    this.costBasisLedger.recordSell({
      conditionId: params.market.conditionId,
      shares,
      price,
      timestamp,
    });
  }

  private resetRedeemPnlDayIfNeeded(now: Date = new Date()): void {
    const dayKey = formatDayKey(now);
    if (dayKey === this.redeemPnlDayKey) {
      return;
    }

    this.redeemPnlDayKey = dayKey;
    this.redeemPnlToday = 0;
  }

  private setBlockedExitRemainder(
    marketId: string,
    outcome: StrategySignal['outcome'],
    shares: number
  ): void {
    const normalizedShares = roundTo(Math.max(0, shares), 4);
    const key = getSettlementCooldownKey(marketId, outcome);
    if (normalizedShares <= 0) {
      this.blockedExitRemainders.delete(key);
      return;
    }

    this.blockedExitRemainders.set(key, {
      marketId,
      outcome,
      shares: normalizedShares,
      updatedAt: new Date().toISOString(),
    });
  }

  private syncBlockedExitRemainderFromInventory(
    marketId: string,
    outcome: StrategySignal['outcome'],
    remainingShares: number,
    referencePrice: number | null
  ): void {
    const normalizedShares = roundTo(Math.max(0, remainingShares), 4);
    if (normalizedShares <= 0) {
      this.setBlockedExitRemainder(marketId, outcome, 0);
      return;
    }

    const minimumShares = resolveMinimumTradableShares(referencePrice ?? Number.NaN, 0);
    if (normalizedShares < minimumShares) {
      this.setBlockedExitRemainder(marketId, outcome, normalizedShares);
      return;
    }

    this.setBlockedExitRemainder(marketId, outcome, 0);
  }

  private pruneBlockedExitRemainders(): void {
    for (const [key, remainder] of this.blockedExitRemainders.entries()) {
      const positionManager = this.positions.get(remainder.marketId);
      if (!positionManager || positionManager.getShares(remainder.outcome) <= 0) {
        this.blockedExitRemainders.delete(key);
      }
    }
  }

  private getBlockedExitRemainderSummary(): {
    dustPositionsCount: number;
    blockedExitRemainderShares: number;
  } {
    return {
      dustPositionsCount: this.blockedExitRemainders.size,
      blockedExitRemainderShares: roundTo(
        Array.from(this.blockedExitRemainders.values()).reduce(
          (sum, entry) => sum + entry.shares,
          0
        ),
        4
      ),
    };
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

  private shouldAllowMarketMakingEntries(
    marketId: string,
    positionManager: PositionManager
  ): boolean {
    const activeCount = countActiveMMMarkets(this.quotingEngine);
    if (activeCount < config.MM_MAX_CONCURRENT_MARKETS) {
      return true;
    }

    if (
      this.quotingEngine.hasActiveMMMarket(marketId) ||
      positionManager.getSnapshot().grossExposureShares > 0
    ) {
      return true;
    }

    logger.debug('MM quote skipped', {
      marketId,
      reason: 'concurrent_limit',
      details: {
        activeMMMarkets: activeCount,
        maxConcurrentMarkets: config.MM_MAX_CONCURRENT_MARKETS,
      },
    });
    return false;
  }

  private getPendingOrderKey(marketId: string, outcome: StrategySignal['outcome']): string {
    return `${marketId}:${outcome}`;
  }

  private armSettlementConfirmation(
    marketId: string,
    outcome: StrategySignal['outcome'],
    baseTimeMs: number
  ): void {
    const key = getSettlementCooldownKey(marketId, outcome);
    this.settlementCooldowns.set(key, baseTimeMs);
    this.settlementStartedAt.set(key, baseTimeMs);
    this.settlementAttempts.set(key, 0);
    logger.debug('Settlement confirmation armed after BUY fill', {
      marketId,
      outcome,
      tokenSettlementCheckAt: new Date(baseTimeMs).toISOString(),
    });
  }

  private clearSettlementConfirmation(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): void {
    const key = getSettlementCooldownKey(marketId, outcome);
    this.settlementCooldowns.delete(key);
    this.settlementStartedAt.delete(key);
    this.settlementAttempts.delete(key);
  }

  private async confirmSettlementForSell(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    tokenId: string;
    nowMs: number;
  }): Promise<boolean> {
    const key = getSettlementCooldownKey(params.market.marketId, params.signal.outcome);
    if (!this.settlementStartedAt.has(key)) {
      return true;
    }

    const requiredShares = getRequiredSettledShares(params.signal.shares);
    let latestBalance = 0;
    let attempts = this.settlementAttempts.get(key) ?? 0;

    for (let index = 0; index < 3; index += 1) {
      const forceRefresh = index > 0;
      latestBalance = await this.executor.getOutcomeTokenBalance(params.tokenId, forceRefresh);
      attempts += 1;
      if (hasSettledOutcomeBalance(latestBalance, params.signal.shares)) {
        const startedAtMs = this.settlementStartedAt.get(key) ?? params.nowMs;
        const delayMs = Math.max(0, Date.now() - startedAtMs);
        this.clearSettlementConfirmation(params.market.marketId, params.signal.outcome);
        logger.info('Token settlement confirmed after BUY fill', {
          marketId: params.market.marketId,
          outcome: params.signal.outcome,
          requiredShares,
          availableShares: roundTo(latestBalance, 4),
          attempts,
          settlementDelayMs: delayMs,
        });
        return true;
      }

      if (index < 2) {
        await sleep(1_000);
      }
    }

    const nextCheckAtMs = Date.now() + 1_000;
    this.settlementCooldowns.set(key, nextCheckAtMs);
    this.settlementAttempts.set(key, attempts);
    logger.debug('SELL deferred: waiting for settled token balance after BUY fill', {
      marketId: params.market.marketId,
      signalType: params.signal.signalType,
      outcome: params.signal.outcome,
      requiredShares,
      availableShares: roundTo(latestBalance, 4),
      attempts,
      nextCheckAt: new Date(nextCheckAtMs).toISOString(),
    });
    return false;
  }

  private pruneSettlementConfirmationState(nowMs = Date.now()): void {
    const maxAgeMs = Math.max(config.FILL_POLL_TIMEOUT_MS, 5 * 60_000);
    for (const [key, startedAtMs] of Array.from(this.settlementStartedAt.entries())) {
      if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs <= maxAgeMs) {
        continue;
      }

      this.settlementStartedAt.delete(key);
      this.settlementAttempts.delete(key);
      this.settlementCooldowns.delete(key);
    }
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

  private setActiveMarkets(markets: readonly MarketCandidate[]): void {
    this.activeMarketIds.clear();
    for (const market of markets) {
      this.activeMarketIds.add(market.marketId);
    }

    for (const marketId of Array.from(this.marketActions.keys())) {
      if (!this.activeMarketIds.has(marketId)) {
        this.marketActions.delete(marketId);
      }
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

  private consumeControlCommands(): void {
    const command = consumeStatusControlCommand(config);
    if (!command) {
      return;
    }

    if (command.command === 'pause') {
      this.statusMonitor.pauseManually(command.reason);
      return;
    }

    this.statusMonitor.resumeManually();
  }

  private applyPauseFilter(
    market: MarketCandidate,
    signals: StrategySignal[]
  ): StrategySignal[] {
    if (!this.statusMonitor.isPaused()) {
      return signals;
    }

    const allowed = signals.filter((signal) => signal.reduceOnly);
    for (const blockedSignal of signals.filter((signal) => !signal.reduceOnly)) {
      this.recordSkippedSignal({
        signal: blockedSignal,
        filterReason: 'PAUSED',
        details: this.statusMonitor.getState().reason ?? 'manual/runtime pause',
      });
    }
    const blockedCount = signals.length - allowed.length;
    if (blockedCount > 0) {
      logger.warn('Skipping new entry signals because bot is paused', {
        marketId: market.marketId,
        blockedSignals: blockedCount,
        reason: this.statusMonitor.getState().reason,
      });
    }

    return allowed;
  }

  private applyLatencyPauseFilter(
    market: MarketCandidate,
    signals: StrategySignal[]
  ): StrategySignal[] {
    const allowed = filterSignalsForLatencyPause(signals, this.latencyPaused);
    const allowedSet = new Set(allowed);
    for (const blockedSignal of signals) {
      if (!allowedSet.has(blockedSignal)) {
        this.recordSkippedSignal({
          signal: blockedSignal,
          filterReason: 'LATENCY_PAUSE',
          details: `avgLatencyMs=${this.getLatencyPauseAverageMs() ?? 'n/a'}`,
        });
      }
    }
    if (allowed.length < signals.length) {
      logger.debug('Latency pause filtered entry signals', {
        marketId: market.marketId,
        original: signals.length,
        remaining: allowed.length,
        blocked: signals.length - allowed.length,
        avgLatencyMs: this.getLatencyPauseAverageMs(),
      });
    }

    return allowed;
  }

  private applyApiCircuitBreakerFilter(
    market: MarketCandidate,
    signals: StrategySignal[]
  ): StrategySignal[] {
    const filterResult = filterSignalsForApiEntryGate({
      signals,
      apiEntryGateOpen: this.isApiEntryGateOpen(),
      dryRunMode: isDryRunMode(config),
      paperTradingEnabled: isPaperTradingEnabled(config),
    });

    if (!filterResult.apiEntryGateOpen) {
      return filterResult.allowedSignals;
    }

    if (filterResult.bypassed) {
      logger.info('API circuit breaker bypassed for simulation/paper mode', {
        marketId: market.marketId,
        original: signals.length,
        remaining: filterResult.allowedSignals.length,
        circuitBreakers: this.getApiCircuitBreakers(),
        dryRunMode: isDryRunMode(config),
        paperTradingEnabled: isPaperTradingEnabled(config),
      });
      return filterResult.allowedSignals;
    }

    if (filterResult.allowedSignals.length < signals.length) {
      const allowedSet = new Set(filterResult.allowedSignals);
      for (const blockedSignal of signals) {
        if (!allowedSet.has(blockedSignal)) {
          this.recordSkippedSignal({
            signal: blockedSignal,
            filterReason: 'API_CIRCUIT_BREAKER',
            details: 'live API entry gate open',
          });
        }
      }
      logger.warn('API circuit breaker filtered new entry signals', {
        marketId: market.marketId,
        original: signals.length,
        remaining: filterResult.allowedSignals.length,
        blocked: signals.length - filterResult.allowedSignals.length,
        circuitBreakers: this.getApiCircuitBreakers(),
      });
    }

    return filterResult.allowedSignals;
  }

  private applyBinanceEdge(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot,
    signals: StrategySignal[]
  ): SignalExecutionCandidate[] {
    if (!this.binanceEdge.isReady()) {
      return signals.map((signal) => ({ signal }));
    }

    const coin = extractCoinFromTitle(market.title);
    if (!coin) {
      return signals.map((signal) => ({ signal }));
    }

    this.binanceEdge.recordSlotOpen(coin, market.startTime);

    return signals
      .map((signal): SignalExecutionCandidate | null => {
        if (signal.reduceOnly) {
          return { signal };
        }

        if (bypassesBinanceEdge(signal.signalType)) {
          if (signal.signalType === 'LATENCY_MOMENTUM_BUY') {
            const assessment = this.binanceEdge.assess({
              coin,
              slotStartTime: market.startTime,
              pmUpMid: orderbook.yes.midPrice,
              signalAction: signal.action,
              signalOutcome: signal.outcome,
            });
            return {
              signal,
              binanceAssessment: assessment.available ? assessment : undefined,
            };
          }

          return { signal };
        }

        const assessment = this.binanceEdge.assess({
          coin,
          slotStartTime: market.startTime,
          pmUpMid: orderbook.yes.midPrice,
          signalAction: signal.action,
          signalOutcome: signal.outcome,
        });

        if (!assessment.available) {
          return { signal };
        }

        if (assessment.edgeStrength >= config.binance.flatThreshold) {
          logger.info('Binance edge assessed', {
            coin,
            binanceMovePct: assessment.binanceMovePct,
            direction: assessment.direction,
            pmDirection: assessment.pmImpliedDirection,
            agreement: assessment.directionalAgreement,
            sizeMultiplier: assessment.sizeMultiplier,
            contraSignal: assessment.contraSignal,
            signalType: signal.signalType,
            signalOutcome: signal.outcome,
          });
        }

        if (assessment.sizeMultiplier === 0) {
          this.recordSkippedSignal({
            signal,
            filterReason: 'BINANCE_CONTRA',
            details: `Binance ${assessment.direction} contradicted ${signal.action} ${signal.outcome}`,
          });
          logger.info('Binance edge BLOCKED signal', {
            signalType: signal.signalType,
            outcome: signal.outcome,
            reason: `Binance ${assessment.direction} contradicts ${signal.action} ${signal.outcome}`,
          });
          return null;
        }

        const adjustedShares = roundTo(signal.shares * assessment.sizeMultiplier, 4);
        if (adjustedShares <= 0) {
          this.recordSkippedSignal({
            signal,
            filterReason: 'BINANCE_SIZE_ZERO',
            details: `Binance multiplier reduced shares to ${adjustedShares.toFixed(4)}`,
          });
          return null;
        }

        return {
          signal: {
            ...signal,
            shares: adjustedShares,
            urgency:
              assessment.urgencyBoost && signal.urgency === 'passive'
                ? 'improve'
                : signal.urgency,
          },
          binanceAssessment: assessment,
        };
      })
      .filter((candidate): candidate is SignalExecutionCandidate => candidate !== null);
  }

  private getPrimaryBinanceAssessment(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): BinanceEdgeAssessment | undefined {
    const coin = extractCoinFromTitle(market.title);
    if (!coin || !this.binanceEdge.hasMarketData()) {
      return undefined;
    }

    this.binanceEdge.recordSlotOpen(coin, market.startTime);
    return this.binanceEdge.assess({
      coin,
      slotStartTime: market.startTime,
      pmUpMid: orderbook.yes.midPrice,
      signalAction: 'BUY',
      signalOutcome: 'YES',
    });
  }

  private schedulePaperResolution(market: MarketCandidate): void {
    if (!isPaperTradingEnabled(config) || this.paperResolutionTimers.has(market.marketId)) {
      return;
    }

    const endMs = market.endTime ? Date.parse(market.endTime) : Number.NaN;
    if (!Number.isFinite(endMs)) {
      return;
    }

    const delayMs = Math.max(0, endMs - Date.now()) + 1_000;
    const timer = setTimeout(() => {
      this.paperResolutionTimers.delete(market.marketId);
      void this.resolvePaperSlot(market);
    }, delayMs);
    timer.unref?.();
    this.paperResolutionTimers.set(market.marketId, timer);
  }

  private async resolvePaperSlot(market: MarketCandidate): Promise<void> {
    if (!isPaperTradingEnabled(config) || !this.executor.hasOpenPaperPosition(market.marketId)) {
      return;
    }

    const coin = extractCoinFromTitle(market.title);
    if (!coin) {
      return;
    }

    const slotOpenPrice = this.binanceEdge.getSlotOpenPrice(coin, market.startTime);
    const slotEndMs = market.endTime ? Date.parse(market.endTime) : Number.NaN;
    const slotClosePrice =
      Number.isFinite(slotEndMs)
        ? this.binanceEdge.getPriceAt(coin, slotEndMs)
        : null;
    const latestPrice = this.binanceEdge.getLatestPrice(coin);
    const settlementPrice = slotClosePrice ?? latestPrice;
    if (
      slotOpenPrice === null ||
      settlementPrice === null ||
      !Number.isFinite(slotOpenPrice) ||
      !Number.isFinite(settlementPrice)
    ) {
      logger.debug('Paper slot resolution skipped due to missing Binance reference', {
        marketId: market.marketId,
        coin,
      });
      return;
    }

    const winningOutcome: 'YES' | 'NO' = settlementPrice >= slotOpenPrice ? 'YES' : 'NO';
    const resolution = this.executor.resolvePaperSlot({
      marketId: market.marketId,
      winningOutcome,
    });
    if (!resolution) {
      return;
    }

    logger.info('Paper slot resolved', {
      marketId: market.marketId,
      winningOutcome,
      slotOpenPrice,
      slotClosePrice,
      latestPrice,
      settlementPrice,
      pnl: resolution.pnl,
    });

    this.positions.delete(market.marketId);
    this.latestBooks.delete(market.marketId);
    this.marketActions.delete(market.marketId);
  }

  private getBinanceFairValueAdjustment(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): FairValueBinanceAdjustment | undefined {
    if (!config.binance.edgeEnabled) {
      return undefined;
    }

    const coin = extractCoinFromTitle(market.title);
    if (!coin) {
      return undefined;
    }

    this.binanceEdge.recordSlotOpen(coin, market.startTime);
    const assessment = this.binanceEdge.assess({
      coin,
      slotStartTime: market.startTime,
      pmUpMid: orderbook.yes.midPrice,
      signalAction: 'BUY',
      signalOutcome: 'YES',
    });

    if (!assessment.available) {
      return undefined;
    }

    return {
      direction: assessment.direction,
      movePct: assessment.binanceMovePct,
    };
  }

  private getDeepBinanceAssessment(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): DeepBinanceAssessment | undefined {
    if (!isDeepBinanceEnabled(config)) {
      return undefined;
    }

    const coin = extractCoinFromTitle(market.title);
    if (!coin || !market.startTime) {
      return undefined;
    }

    this.deepBinance.recordSlotOpen(coin, market.startTime);
    const polymarketMid =
      orderbook.yes.midPrice ??
      orderbook.yes.lastTradePrice ??
      orderbook.yes.bestBid ??
      orderbook.yes.bestAsk;

    return this.deepBinance.calculateFairValue({
      coin,
      slotStartTime: market.startTime,
      polymarketMid,
    });
  }

  private rememberMarketAction(
    market: MarketCandidate,
    signals: readonly StrategySignal[],
    executionCandidates: readonly SignalExecutionCandidate[],
    positionManager: PositionManager,
    quoteSignals: readonly StrategySignal[] = []
  ): void {
    const snapshot = positionManager.getSnapshot();
    const entrySignals = signals.filter((signal) => !signal.reduceOnly);
    const nextCandidate = executionCandidates[0]?.signal;
    const nextQuote = quoteSignals[0];

    let action = 'SCAN';
    if (this.statusMonitor.isPaused() && entrySignals.length > 0) {
      action = 'PAUSED';
    } else if (nextCandidate) {
      action =
        nextCandidate.action === 'BUY'
          ? `ENTER ${nextCandidate.outcome}`
          : `EXIT ${nextCandidate.outcome}`;
    } else if (nextQuote) {
      action =
        nextQuote.signalType === 'INVENTORY_REBALANCE_QUOTE'
          ? `REB ${nextQuote.outcome}`
          : `QUOTE ${nextQuote.outcome}`;
    } else if (snapshot.grossExposureShares > 0) {
      action = 'MONITOR';
    }

    this.marketActions.set(market.marketId, {
      action,
      signalCount: executionCandidates.length,
      updatedAt: new Date().toISOString(),
    });
  }

  private buildRuntimeMarketSnapshots(): RuntimeMarketSnapshot[] {
    return Array.from(this.activeMarketIds)
      .map((marketId) => {
        const market = this.markets.get(marketId);
        if (!market) {
          return null;
        }

        const orderbook = this.latestBooks.get(marketId);
        const coin = extractCoinFromTitle(market.title);
        const pmUpMid = normalizeRuntimeNumber(orderbook?.yes.midPrice);
        const pmDownMid = normalizeRuntimeNumber(orderbook?.no.midPrice);
        const combinedDiscount = normalizeRuntimeNumber(orderbook?.combined.combinedDiscount);
        const assessment =
          coin && orderbook
            ? this.binanceEdge.assess({
                coin,
                slotStartTime: market.startTime,
                pmUpMid,
                signalAction: 'BUY',
                signalOutcome: 'YES',
              })
            : undefined;
        const actionSnapshot = this.marketActions.get(marketId);

        return {
          marketId: market.marketId,
          title: market.title,
          coin,
          slotStart: market.startTime,
          slotEnd: market.endTime,
          liquidityUsd: roundTo(market.liquidityUsd, 2),
          pmUpMid,
          pmDownMid,
          combinedDiscount,
          binanceMovePct:
            assessment && assessment.available ? assessment.binanceMovePct : null,
          binanceDirection:
            assessment && assessment.available ? assessment.direction : null,
          pmDirection:
            assessment?.pmImpliedDirection ??
            (pmUpMid === null ? 'FLAT' : pmUpMid > 0.52 ? 'UP' : pmUpMid < 0.48 ? 'DOWN' : 'FLAT'),
          action: actionSnapshot?.action ?? 'SCAN',
          signalCount: actionSnapshot?.signalCount ?? 0,
          updatedAt: actionSnapshot?.updatedAt ?? new Date().toISOString(),
        } satisfies RuntimeMarketSnapshot;
      })
      .filter((entry): entry is RuntimeMarketSnapshot => entry !== null)
      .sort((left, right) => {
        const leftEnd = left.slotEnd ? Date.parse(left.slotEnd) : Number.POSITIVE_INFINITY;
        const rightEnd = right.slotEnd ? Date.parse(right.slotEnd) : Number.POSITIVE_INFINITY;
        return leftEnd - rightEnd;
      })
      .slice(0, 8);
  }

  private buildRuntimeMmQuoteSnapshots(): RuntimeMmQuoteSnapshot[] {
    return this.quotingEngine
      .getActiveMMMarketIds()
      .map((marketId) => {
        const market = this.markets.get(marketId) ?? this.quotingEngine.getContext(marketId)?.market;
        const context = this.quotingEngine.getContext(marketId);
        if (!market || !context) {
          return null;
        }

        const orders = this.quotingEngine.getQuoteOrders(marketId);
        const bidPrice = resolveQuoteOrderPrice(orders, 'BUY');
        const askPrice = resolveQuoteOrderPrice(orders, 'SELL');
        const spread =
          bidPrice !== null && askPrice !== null
            ? roundTo(askPrice - bidPrice, 4)
            : null;
        const snapshot = context.positionManager.getSnapshot();
        const orderbook = this.latestBooks.get(marketId) ?? context.orderbook;

        return {
          marketId,
          title: market.title,
          coin: extractCoinFromTitle(market.title),
          bidPrice,
          askPrice,
          spread,
          yesShares: roundTo(snapshot.yesShares, 4),
          noShares: roundTo(snapshot.noShares, 4),
          grossExposureUsd: roundTo(
            snapshot.yesShares * (orderbook.yes.midPrice ?? 0.5) +
              snapshot.noShares * (orderbook.no.midPrice ?? 0.5),
            4
          ),
          netDirectionalShares: roundTo(snapshot.yesShares - snapshot.noShares, 4),
        } satisfies RuntimeMmQuoteSnapshot;
      })
      .filter((entry): entry is RuntimeMmQuoteSnapshot => entry !== null)
      .sort((left, right) => right.grossExposureUsd - left.grossExposureUsd)
      .slice(0, Math.max(4, config.MM_MAX_CONCURRENT_MARKETS));
  }

  private buildRuntimePositionSnapshots(): RuntimePositionSnapshot[] {
    return Array.from(this.positions.entries())
      .map(([marketId, positionManager]) => {
        const snapshot = positionManager.getSnapshot();
        if (snapshot.grossExposureShares <= 0) {
          return null;
        }

        const market = this.markets.get(marketId);
        const orderbook = this.latestBooks.get(marketId);
        const yesMark =
          normalizeRuntimeNumber(orderbook?.yes.midPrice) ??
          normalizeRuntimeNumber(orderbook?.yes.bestBid) ??
          (snapshot.yesShares > 0 ? snapshot.yesAvgEntryPrice : null);
        const noMark =
          normalizeRuntimeNumber(orderbook?.no.midPrice) ??
          normalizeRuntimeNumber(orderbook?.no.bestBid) ??
          (snapshot.noShares > 0 ? snapshot.noAvgEntryPrice : null);
        const markValueUsd = roundTo(
          snapshot.yesShares * (yesMark ?? 0) + snapshot.noShares * (noMark ?? 0),
          2
        );
        const roiPct =
          markValueUsd > 0 ? roundTo((snapshot.totalPnl / markValueUsd) * 100, 2) : null;

        return {
          marketId,
          title: market?.title ?? marketId,
          slotStart: market?.startTime ?? null,
          slotEnd: market?.endTime ?? null,
          yesShares: snapshot.yesShares,
          noShares: snapshot.noShares,
          grossExposureShares: snapshot.grossExposureShares,
          markValueUsd,
          unrealizedPnl: snapshot.unrealizedPnl,
          totalPnl: snapshot.totalPnl,
          roiPct,
          updatedAt: snapshot.lastUpdatedAt,
        } satisfies RuntimePositionSnapshot;
      })
      .filter((entry): entry is RuntimePositionSnapshot => entry !== null)
      .sort((left, right) => Math.abs(right.markValueUsd) - Math.abs(left.markValueUsd))
      .slice(0, 8);
  }

  private async handleQuoteRefresh(plan: QuoteRefreshPlan): Promise<void> {
    if (!this.running || this.stopping) {
      return;
    }

    const market = this.markets.get(plan.marketId);
    const quoteContext = this.quotingEngine.getContext(plan.marketId);
    if (!market || !quoteContext) {
      return;
    }

    await this.runSerializedMarketTask(plan.marketId, async () => {
      const orderbook = await this.fetcher.getMarketSnapshot(market);
      this.latestBooks.set(plan.marketId, orderbook);
      const positionManager = this.getPositionManager(market);
      const riskAssessment = this.riskManager.checkRiskLimits({
        market,
        orderbook,
        positionManager,
        now: new Date(),
      });
      const deepBinanceAssessment = this.getDeepBinanceAssessment(market, orderbook);
      const refreshedPlan = buildQuoteRefreshPlan({
        context: {
          ...quoteContext,
          orderbook,
          positionManager,
          riskAssessment,
          deepBinanceAssessment,
        },
        activeQuoteOrders: plan.activeQuoteOrders,
        currentMMExposureUsd: this.quotingEngine.getCurrentMMExposureUsd(),
        runtimeConfig: config,
        now: new Date(),
      });

      for (const order of plan.activeQuoteOrders) {
        await this.cancelQuoteOrder(order);
      }

      const nextActiveOrders: ActiveQuoteOrder[] = [];

      for (const signal of refreshedPlan.signals) {
        const execution = await this.executeSignal(
          market,
          orderbook,
          positionManager,
          signal,
          refreshedPlan.slotKey
        );

        if (
          execution &&
          execution.orderId &&
          !execution.simulation &&
          !execution.fillConfirmed
        ) {
          nextActiveOrders.push({
            orderId: execution.orderId,
            marketId: market.marketId,
            outcome: signal.outcome,
            action: signal.action,
            signalType: signal.signalType,
            targetPrice: signal.targetPrice,
            shares: signal.shares,
          });
        }
      }

      this.quotingEngine.replaceQuoteOrders(refreshedPlan.marketId, nextActiveOrders);
    });
  }

  private async cancelQuoteOrder(order: ActiveQuoteOrder): Promise<void> {
    try {
      await this.executor.cancelOrder(order.orderId);
    } catch (error) {
      logger.debug('Quote cancel failed', {
        orderId: order.orderId,
        marketId: order.marketId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.fillTracker.forgetPendingOrder(order.orderId);
      this.quotingEngine.forgetQuoteOrder(order.orderId);
      this.clearPendingLiveOrder(this.getPendingOrderKey(order.marketId, order.outcome));
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

function normalizeRuntimeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? roundTo(value, 4) : null;
}

function resolveQuoteOrderPrice(
  orders: readonly ActiveQuoteOrder[],
  action: StrategySignal['action']
): number | null {
  const prices = orders
    .filter((order) => order.action === action)
    .map((order) => order.targetPrice)
    .filter((price): price is number => price !== null && Number.isFinite(price));

  if (prices.length === 0) {
    return null;
  }

  return roundTo(action === 'BUY' ? Math.max(...prices) : Math.min(...prices), 4);
}

function isAtomicPairedArbExecutionCandidate(signal: Pick<StrategySignal, 'signalType'>): boolean {
  return signal.signalType === 'PAIRED_ARB_BUY_YES' || signal.signalType === 'PAIRED_ARB_BUY_NO';
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

function createTrackedSignal(
  market: MarketCandidate,
  fill: ConfirmedFill
): StrategySignal {
  return {
    marketId: fill.marketId,
    marketTitle: market.title,
    signalType: fill.signalType,
    priority: 0,
    action: fill.side,
    outcome: fill.outcome,
    outcomeIndex: fill.outcome === 'YES' ? 0 : 1,
    shares: fill.filledShares,
    targetPrice: fill.fillPrice,
    referencePrice: fill.fillPrice,
    tokenPrice: fill.fillPrice,
    midPrice: fill.fillPrice,
    fairValue: null,
    edgeAmount: 0,
    combinedBid: null,
    combinedAsk: null,
    combinedMid: null,
    combinedDiscount: null,
    combinedPremium: null,
    fillRatio: 1,
    capitalClamp: 1,
    priceMultiplier: 1,
    urgency: 'passive',
    reduceOnly: fill.side === 'SELL',
    reason: 'Confirmed via fill tracker',
    generatedAt: fill.filledAt,
  };
}

function getSettlementCooldownKey(
  marketId: string,
  outcome: StrategySignal['outcome']
): string {
  return `${marketId}:${outcome}`;
}

function resolveRedeemTimestamp(timestampMs: unknown): Date {
  const numeric =
    typeof timestampMs === 'number'
      ? timestampMs
      : typeof timestampMs === 'string'
        ? Number.parseFloat(timestampMs)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return new Date();
  }

  const timestamp = new Date(numeric);
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

export function shouldDeferSignalForSettlement(params: {
  signal: Pick<StrategySignal, 'action' | 'signalType'>;
  cooldownUntilMs: number | undefined;
  nowMs: number;
}): boolean {
  if (params.signal.action !== 'SELL') {
    return false;
  }

  if (params.signal.signalType === 'HARD_STOP') {
    return false;
  }

  return params.cooldownUntilMs !== undefined && params.nowMs < params.cooldownUntilMs;
}

export function getRequiredSettledShares(requestedShares: number): number {
  return Math.max(0.01, roundTo(requestedShares * 0.99, 4));
}

export function hasSettledOutcomeBalance(
  availableShares: number,
  requestedShares: number
): boolean {
  return availableShares >= getRequiredSettledShares(requestedShares);
}

export function pruneExpiredSettlementCooldowns(
  cooldowns: ReadonlyMap<string, number>,
  nowMs: number
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [key, untilMs] of cooldowns.entries()) {
    if (Number.isFinite(untilMs) && untilMs >= nowMs) {
      next.set(key, untilMs);
    }
  }

  return next;
}

export function filterSignalsForLatencyPause(
  signals: readonly StrategySignal[],
  latencyPaused: boolean
): StrategySignal[] {
  if (!latencyPaused) {
    return [...signals];
  }

  return signals.filter((signal) => signal.reduceOnly || signal.action === 'SELL');
}

export interface ReduceOnlySellGuardResult {
  readonly skip: boolean;
  readonly reason:
    | 'not_reduce_only_sell'
    | 'no_inventory'
    | 'invalid_price'
    | 'below_minimum'
    | 'valid';
  readonly requestedShares: number;
  readonly executionShares: number;
  readonly minimumShares: number;
  readonly remainingShares: number;
  readonly blockedRemainderShares: number;
}

export function resolveReduceOnlySellGuard(params: {
  signal: Pick<StrategySignal, 'action' | 'reduceOnly' | 'shares'>;
  availableShares: number;
  referencePrice: number | null;
}): ReduceOnlySellGuardResult {
  const availableShares = roundTo(Math.max(0, params.availableShares), 4);
  const requestedShares = roundTo(
    Math.min(availableShares, Math.max(0, params.signal.shares)),
    4
  );
  const price =
    params.referencePrice !== null &&
    Number.isFinite(params.referencePrice) &&
    params.referencePrice > 0
      ? params.referencePrice
      : null;
  const minimumShares = resolveMinimumTradableShares(price ?? Number.NaN, 0);

  if (params.signal.action !== 'SELL' || !params.signal.reduceOnly) {
    const remainingShares = roundTo(Math.max(0, availableShares - requestedShares), 4);
    return {
      skip: false,
      reason: 'not_reduce_only_sell',
      requestedShares,
      executionShares: requestedShares,
      minimumShares,
      remainingShares,
      blockedRemainderShares: 0,
    };
  }

  if (requestedShares <= 0 || availableShares <= 0) {
    return {
      skip: true,
      reason: 'no_inventory',
      requestedShares,
      executionShares: 0,
      minimumShares,
      remainingShares: availableShares,
      blockedRemainderShares: 0,
    };
  }

  if (price === null) {
    return {
      skip: true,
      reason: 'invalid_price',
      requestedShares,
      executionShares: 0,
      minimumShares,
      remainingShares: availableShares,
      blockedRemainderShares: requestedShares,
    };
  }

  if (!meetsClobMinimums(requestedShares, price)) {
    return {
      skip: true,
      reason: 'below_minimum',
      requestedShares,
      executionShares: 0,
      minimumShares,
      remainingShares: availableShares,
      blockedRemainderShares: requestedShares,
    };
  }

  const remainingShares = roundTo(Math.max(0, availableShares - requestedShares), 4);
  return {
    skip: false,
    reason: 'valid',
    requestedShares,
    executionShares: requestedShares,
    minimumShares,
    remainingShares,
    blockedRemainderShares:
      remainingShares > 0 && remainingShares < minimumShares ? remainingShares : 0,
  };
}

export function filterSignalsForApiEntryGate(params: {
  signals: readonly StrategySignal[];
  apiEntryGateOpen: boolean;
  dryRunMode: boolean;
  paperTradingEnabled: boolean;
}): {
  allowedSignals: StrategySignal[];
  apiEntryGateOpen: boolean;
  bypassed: boolean;
} {
  if (!params.apiEntryGateOpen) {
    return {
      allowedSignals: [...params.signals],
      apiEntryGateOpen: false,
      bypassed: false,
    };
  }

  if (params.dryRunMode || params.paperTradingEnabled) {
    return {
      allowedSignals: [...params.signals],
      apiEntryGateOpen: true,
      bypassed: true,
    };
  }

  return {
    allowedSignals: filterSignalsForLatencyPause(params.signals, true),
    apiEntryGateOpen: true,
    bypassed: false,
  };
}

export function pruneLatencyPauseSamples(
  samples: readonly LatencySample[],
  nowMs: number,
  ttlMs: number
): LatencySample[] {
  return samples.filter(
    (sample) =>
      Number.isFinite(sample.valueMs) &&
      sample.valueMs >= 0 &&
      Number.isFinite(sample.recordedAtMs) &&
      nowMs - sample.recordedAtMs <= ttlMs
  );
}

export function evaluateLatencyPauseState(params: {
  samples: readonly number[];
  latencyPaused: boolean;
  pauseThresholdMs: number;
  resumeThresholdMs: number;
}): LatencyPauseEvaluation {
  const samples = params.samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (samples.length < 3) {
    return {
      latencyPaused: params.latencyPaused,
      averageLatencyMs: null,
      transition: 'none',
    };
  }

  const averageLatencyMs = roundTo(
    samples.reduce((sum, value) => sum + value, 0) / samples.length,
    2
  );
  if (!params.latencyPaused && averageLatencyMs > params.pauseThresholdMs) {
    return {
      latencyPaused: true,
      averageLatencyMs,
      transition: 'pause',
    };
  }

  if (params.latencyPaused && averageLatencyMs < params.resumeThresholdMs) {
    return {
      latencyPaused: false,
      averageLatencyMs,
      transition: 'resume',
    };
  }

  return {
    latencyPaused: params.latencyPaused,
    averageLatencyMs,
    transition: 'none',
  };
}

function resolveReduceOnlySellReferencePrice(params: {
  signal: Pick<
    StrategySignal,
    'action' | 'reduceOnly' | 'outcome' | 'targetPrice' | 'referencePrice' | 'tokenPrice'
  >;
  outcome: StrategySignal['outcome'];
  book: MarketOrderbookSnapshot['yes'] | MarketOrderbookSnapshot['no'];
  positionManager: PositionManager;
}): number | null {
  return (
    params.signal.targetPrice ??
    params.book.bestBid ??
    params.book.midPrice ??
    params.signal.referencePrice ??
    params.signal.tokenPrice ??
    params.positionManager.getAvgEntryPrice(params.outcome)
  );
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
