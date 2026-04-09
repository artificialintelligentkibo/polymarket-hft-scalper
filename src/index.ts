import { AutoRedeemer } from './auto-redeemer.js';
import { pathToFileURL } from 'node:url';
import { TradeNarrator } from './trade-narrator.js';
import type { BinanceEdgeAssessment } from './binance-edge.js';
import { BinanceEdgeProvider, extractCoinFromTitle } from './binance-edge.js';
import { DynamicCompounder } from './dynamic-compounder.js';
import { RegimeFilter } from './regime-filter.js';
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
import {
  FillTracker,
  type ConfirmedFill,
  type PendingOrder,
} from './fill-tracker.js';
import { buildFlattenSignals } from './flatten-signals.js';
import { LotteryEngine } from './lottery-engine.js';
import { logger, TradeLogger } from './logger.js';
import {
  MarketMonitor,
  describeDiscoveryMode,
  getSlotKey,
  type MarketCandidate,
} from './monitor.js';
import { OrderBookImbalanceFilter } from './order-book-imbalance.js';
import { ObiEngine, extractCoinFromObiTitle } from './obi-engine.js';
import { OrderExecutor, type OrderExecutionReport } from './order-executor.js';
import { meetsClobMinimums, resolveMinimumTradableShares } from './paired-arbitrage.js';
import { PositionManager } from './position-manager.js';
import { ProductTestModeController } from './product-test-mode.js';
import {
  buildQuoteRefreshPlan,
  countActiveMMMarkets,
  QuotingEngine,
  type ActiveQuoteOrder,
  type PendingQuoteExposureSnapshot,
  type QuoteRefreshPlan,
} from './quoting-engine.js';
import { writeLatencyLog } from './reports.js';
import type { ProductTestRedeemRecord } from './product-test-mode.js';
import {
  ResolutionChecker,
  resolveVerifiedRedeemPayoutUsd,
} from './resolution-checker.js';
import { RiskManager, type RiskAssessment } from './risk-manager.js';
import {
  resolveRuntimeMode,
  type RuntimeGlobalExposureSnapshot,
  type RuntimeLayerStatusSnapshot,
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
  recordSettlementPnl,
  recordExecution,
  recordSkippedSignal as recordSlotReporterSkip,
  recordTrade,
} from './slot-reporter.js';
import {
  bypassesBinanceEdge,
  isLayerConflict,
  isObiExitSignal,
  isQuotingSignalType,
  resolveStrategyLayer,
  type StrategyLayer,
  type StrategySignal,
} from './strategy-types.js';
import { formatDayKey, pruneSetEntries, roundTo, safeNumber, sleep } from './utils.js';

const MAX_TRACKED_SLOT_REPORTS = 2_048;
const UNCONFIRMED_ORDER_COOLDOWN_MS = 15_000;
const LIVE_POSITION_RECONCILIATION_EPSILON = 0.0001;
const POSITIONS_API_URL = 'https://data-api.polymarket.com/positions';
const POSITIONS_PAGE_LIMIT = 500;
const MAX_POSITION_PAGES = 10;

interface SignalExecutionCandidate {
  readonly signal: StrategySignal;
  readonly binanceAssessment?: BinanceEdgeAssessment;
}

interface PreparedMarketTick {
  readonly market: MarketCandidate;
  readonly slotKey: string;
  readonly orderbook: MarketOrderbookSnapshot;
  readonly positionManager: PositionManager;
  readonly riskAssessment: RiskAssessment;
  readonly binanceFairValueAdjustment?: FairValueBinanceAdjustment;
  readonly binanceAssessment?: BinanceEdgeAssessment;
  readonly binanceVelocityPctPerSec?: number | null;
  readonly deepBinanceAssessment?: DeepBinanceAssessment;
}

interface SniperSelectionPlan {
  readonly overrides: Map<string, readonly StrategySignal[]>;
  readonly suppressedMarkets: ReadonlySet<string>;
}

interface RuntimeMarketActionSnapshot {
  readonly action: string;
  readonly signalCount: number;
  readonly updatedAt: string;
}

interface RuntimeWalletFundsSnapshot {
  readonly walletCashUsd: number | null;
  readonly updatedAt: string | null;
}

interface LayerExposureAccumulator {
  sniperUsd: number;
  mmUsd: number;
  pairedArbUsd: number;
  lotteryUsd: number;
  obiUsd: number;
  totalUsd: number;
  maxUsd: number;
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
  private readonly lotteryEngine = new LotteryEngine(config);
  private readonly signalEngine = new SignalScalper(config, this.lotteryEngine);
  private readonly quotingEngine = new QuotingEngine();
  private readonly compounder = new DynamicCompounder(config.compounding);
  private readonly regimeFilter = new RegimeFilter(config.regimeFilter);
  private readonly orderBookImbalance = new OrderBookImbalanceFilter(config.orderBookImbalance);
  private readonly obiEngine = new ObiEngine();
  private readonly redeemer = new AutoRedeemer();
  private readonly narrator = new TradeNarrator(config.REPORTS_DIR);
  private readonly resolutionChecker = new ResolutionChecker();
  private readonly fillTracker = new FillTracker(
    {
      getOrderStatus: (orderId) => this.executor.getOrderStatus(orderId),
      cancelOrder: (orderId) => this.executor.cancelOrder(orderId),
    },
    config,
    {
      onTrackedFillDetected: (fill) => {
        this.handleTrackedFillDetected(fill);
      },
    }
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
  private readonly dustAbandonedPositions = new Set<string>();
  /**
   * Per-(marketId+outcome) registry of OBI maker orderIds that are still
   * resting on CLOB (submitted, not yet filled or cancelled). The fillTracker
   * map is the primary source of truth, but it can drop entries on
   * timeout/poll cycles before the order actually fills, leaving us blind
   * to collateral that's still locked. This registry is the belt-and-braces
   * backup for cancelPendingObiMakerQuotes (Variant A4 / 2026-04-08).
   */
  private readonly restingObiMakerOrders = new Map<string, Set<string>>();
  private readonly pendingLiveOrders = new Map<string, number>();
  private readonly postSniperMakerAskStartedAt = new Map<string, number>();
  private readonly settlementCooldowns = new Map<string, number>();
  private readonly settlementStartedAt = new Map<string, number>();
  private readonly settlementAttempts = new Map<string, number>();
  private readonly paperResolutionTimers = new Map<string, NodeJS.Timeout>();
  private walletPositionSnapshots = new Map<string, RuntimePositionSnapshot>();
  private lastWalletPositionRefreshAtMs = 0;
  private walletFundsSnapshot: RuntimeWalletFundsSnapshot = {
    walletCashUsd: null,
    updatedAt: null,
  };
  private lastWalletFundsRefreshAtMs = 0;
  /**
   * Phase 19 (2026-04-09): standalone periodic timer that refreshes wallet
   * funds snapshot independently of the slot-processing loop. Before Phase 19,
   * `refreshWalletFundsSnapshot()` was called only from `runCycle()` (line ~910),
   * which made the compounder's drawdown guard blind between slot ticks.
   * A catastrophic drop could silently reach −39% before the next recalculate,
   * well past the configured 8% drawdown threshold.
   *
   * This timer fires every WALLET_FUNDS_REFRESH_INTERVAL_MS (default 20s) and
   * ensures `compounder.recalculate()` sees a fresh balance on a predictable
   * cadence, so the drawdown guard can activate at its configured threshold.
   *
   * Safety: the timer only calls the existing refresh path — no new logic,
   * no sizing math changes. Guard activation still just halves size factor
   * (0.5×), never halts entries or closes positions.
   */
  private walletFundsRefreshTimer: NodeJS.Timeout | null = null;
  private userStreamCredentials: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null = null;
  private userStreamStarted = false;
  private readonly recentSignals: RuntimeSignalSnapshot[] = [];
  private readonly recentSkippedSignals: SkippedSignalRecord[] = [];
  private readonly recentLatencySamples: number[] = [];
  private readonly backgroundTasks = new Set<Promise<void>>();
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
      void this.handleRedeemSuccess(payload).catch((error) => {
        logger.error('Redeem success handler failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
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

  private async handleRedeemSuccess(payload: unknown): Promise<void> {
    this.productTestMode.recordRedeemSuccess(payload as ProductTestRedeemRecord);
    const conditionId = String((payload as { conditionId?: unknown })?.conditionId ?? '').trim();
    const redeemSettlement = resolveRedeemSettlementAmounts({
      redeemedShares: (payload as { redeemedAmount?: unknown })?.redeemedAmount,
      yesShares: (payload as { yesShares?: unknown })?.yesShares,
      noShares: (payload as { noShares?: unknown })?.noShares,
    });
    const redeemedShares = redeemSettlement.redeemedShares;
    const redeemedAt = resolveRedeemTimestamp(
      (payload as { timestampMs?: unknown })?.timestampMs
    );

    this.resetRedeemPnlDayIfNeeded(redeemedAt);
    if (conditionId && redeemedShares > 0) {
      const entry = this.costBasisLedger.get(conditionId);
      const market = this.findTrackedMarketByConditionId(conditionId);
      const resolution = await this.resolutionChecker.checkResolution({
        conditionId,
        slug: market?.slug ?? null,
      });

      // Phase 24 (2026-04-09): balance-based payout verification.
      //
      // CRITICAL BUG FOUND: Phase 17 derived the ETH NO winner from CLOB
      // prices (noFinalPrice=0.565 → "NO won"), but the on-chain oracle
      // resolved YES. Payout was $0 but bot reported +$22 phantom profit.
      // The $38.59 discrepancy caused the dashboard to show +$5.20 day PnL
      // while the actual balance dropped $33.79.
      //
      // Fix: after redeem, fetch REAL wallet balance and compare to the
      // last known balance. The delta is the actual payout from this redeem.
      // This overrides both the resolution checker AND the CLOB-derived
      // fallback, ensuring PnL always matches the real wallet.
      const balanceBeforeRedeem =
        typeof this.walletFundsSnapshot.walletCashUsd === 'number' &&
        Number.isFinite(this.walletFundsSnapshot.walletCashUsd)
          ? this.walletFundsSnapshot.walletCashUsd
          : null;

      let balanceVerifiedPayoutUsd: number | null = null;
      if (balanceBeforeRedeem !== null) {
        try {
          // Phase 24b: wait for Safe relay to deliver USDC + RPC to index state.
          // Without delay, balance reads stale (164ms after tx mined = same value).
          // Retry once more if first attempt shows zero delta.
          await sleep(5000);
          let postRedeemBalance = await this.executor.getUsdcBalance(true);
          let delta = typeof postRedeemBalance === 'number' && Number.isFinite(postRedeemBalance)
            ? roundTo(postRedeemBalance - balanceBeforeRedeem, 4)
            : -1;

          // Retry once if delta is zero/negative — RPC may still be stale
          if (delta <= 0.001) {
            logger.info('Phase 24b: first balance check showed no change, retrying after 5s...');
            await sleep(5000);
            postRedeemBalance = await this.executor.getUsdcBalance(true);
            delta = typeof postRedeemBalance === 'number' && Number.isFinite(postRedeemBalance)
              ? roundTo(postRedeemBalance - balanceBeforeRedeem, 4)
              : -1;
          }

          if (
            typeof postRedeemBalance === 'number' &&
            Number.isFinite(postRedeemBalance)
          ) {
            // Delta should be >= 0 (redeem only adds USDC, never removes).
            // Negative delta can happen from concurrent trades; ignore those.
            balanceVerifiedPayoutUsd = Math.max(0, delta);

            // Update the wallet snapshot so subsequent redeems use fresh base.
            this.walletFundsSnapshot = {
              walletCashUsd: roundTo(postRedeemBalance, 2),
              updatedAt: new Date().toISOString(),
            };
            this.lastWalletFundsRefreshAtMs = Date.now();
            if (this.compounder.enabled && postRedeemBalance > 0) {
              this.compounder.recalculate(postRedeemBalance);
            }

            logger.info('Phase 24: balance-verified redeem payout', {
              conditionId,
              balanceBefore: roundTo(balanceBeforeRedeem, 2),
              balanceAfter: roundTo(postRedeemBalance, 2),
              balanceDelta: delta,
              verifiedPayout: balanceVerifiedPayoutUsd,
              yesShares: redeemSettlement.yesShares,
              noShares: redeemSettlement.noShares,
              resolutionWinner: resolution.winningOutcome ?? 'unverified',
            });
          }
        } catch (error) {
          logger.debug('Phase 24: post-redeem balance check failed, falling back', {
            conditionId,
            error: String(error),
          });
        }
      }

      // Use balance-verified payout if available, otherwise fall back to
      // resolution-based calculation.
      const actualPayoutUsd = balanceVerifiedPayoutUsd !== null
        ? balanceVerifiedPayoutUsd
        : resolveVerifiedRedeemPayoutUsd({
            yesShares: redeemSettlement.yesShares,
            noShares: redeemSettlement.noShares,
            winningOutcome: resolution.winningOutcome,
          });

      let dayStateOverride:
        | {
            totalDayPnl: number;
            dayDrawdown: number;
          }
        | null = null;

      if (!entry) {
        logger.warn('Redeem PnL skipped - no cost basis', {
          conditionId,
          title: String((payload as { title?: unknown })?.title ?? market?.title ?? 'Unknown'),
          redeemedShares,
          yesShares: redeemSettlement.yesShares,
          noShares: redeemSettlement.noShares,
          winningOutcome: resolution.winningOutcome,
          yesFinalPrice: resolution.yesFinalPrice,
          noFinalPrice: resolution.noFinalPrice,
          reason: 'Position may have been opened before bot restart or by another system',
        });
      } else if (resolution.resolved && resolution.winningOutcome) {
        const result = this.costBasisLedger.calculateRedeemPnl(
          conditionId,
          redeemedShares,
          actualPayoutUsd
        );
        const lotteryMarketId = market?.marketId ?? conditionId;
        this.lotteryEngine.recordSettlement({
          marketId: lotteryMarketId,
          outcome: resolution.winningOutcome,
          payoutUsd: actualPayoutUsd,
        });
        if (result.found && Number.isFinite(result.pnl)) {
          const dayState = market
            ? recordSettlementPnl({
                slotKey: getSlotKey(market),
                marketId: market.marketId,
                marketTitle: market.title,
                pnl: result.pnl,
                outcome: resolveSlotOutcome(market, resolution.winningOutcome),
                slotStart: market.startTime,
                slotEnd: market.endTime,
                now: redeemedAt,
              })
            : recordDayPnlDelta(result.pnl, redeemedAt, config);
          this.redeemPnlToday = roundTo(this.redeemPnlToday + result.pnl, 4);
          logger.info('Redeem PnL recorded', {
            conditionId,
            title: String((payload as { title?: unknown })?.title ?? entry.marketTitle ?? 'Unknown'),
            redeemedShares,
            yesShares: redeemSettlement.yesShares,
            noShares: redeemSettlement.noShares,
            pairedShares: redeemSettlement.pairedShares,
            winningOutcome: resolution.winningOutcome,
            yesFinalPrice: resolution.yesFinalPrice,
            noFinalPrice: resolution.noFinalPrice,
            actualPayoutUsd,
            costBasis: entry.totalCostUsd,
            soldShares: entry.soldShares,
            soldCostUsd: entry.soldCostUsd,
            soldProceeds: entry.soldProceeds,
            remainingShares: result.remainingShares,
            remainingCost: result.remainingCost,
            redeemPayout: result.redeemPayout,
            redeemPnl: result.pnl,
            newDayPnl: dayState.dayPnl,
          });
          dayStateOverride = {
            totalDayPnl: dayState.dayPnl,
            dayDrawdown: dayState.drawdown,
          };

          // Narrator: log redemption
          try {
            this.narrator.logRedemption({
              marketTitle: String((payload as { title?: unknown })?.title ?? entry.marketTitle ?? 'Unknown'),
              conditionId,
              winningOutcome: resolution.winningOutcome,
              payoutUsd: actualPayoutUsd,
              costBasisUsd: entry.totalCostUsd,
              pnlUsd: result.pnl,
            });
          } catch { /* best-effort */ }
        }
      } else {
        // Phase 17+24 fallback: resolution checker failed to verify winner.
        //
        // Phase 24 upgrade: when balance-verified payout is available, use it
        // INSTEAD of CLOB-derived winner. CLOB prices are unreliable:
        //   - Live incident 2026-04-09: ETH NO noFinalPrice=0.565 → derived
        //     "NO won", but oracle resolved YES → payout was $0, not $38.59.
        //     Bot reported phantom +$22 profit while real balance dropped $33.79.
        //
        // Balance-verified payout is ground truth: it's the actual USDC delta
        // measured from the wallet before/after redeem.
        //
        // Legacy Phase 17 CLOB derivation is kept as last resort when balance
        // check fails (e.g. RPC error during post-redeem balance fetch).
        const useBalanceVerified = balanceVerifiedPayoutUsd !== null;
        let derivedWinningOutcome: 'YES' | 'NO' | null = null;

        if (useBalanceVerified) {
          // Determine winner from actual payout: if we got paid, our side won.
          const heldYes = redeemSettlement.yesShares > 0;
          const heldNo = redeemSettlement.noShares > 0;
          if (balanceVerifiedPayoutUsd! > 0.01) {
            // We got paid → our side won
            derivedWinningOutcome = heldNo && !heldYes ? 'NO' : 'YES';
          } else {
            // We got $0 → our side lost
            derivedWinningOutcome = heldNo && !heldYes ? 'YES' : 'NO';
          }
          logger.info('Phase 24: using balance-verified payout for PnL', {
            conditionId,
            balanceVerifiedPayoutUsd,
            derivedWinningOutcome,
            heldYes: redeemSettlement.yesShares,
            heldNo: redeemSettlement.noShares,
            clobYesFinalPrice: resolution.yesFinalPrice,
            clobNoFinalPrice: resolution.noFinalPrice,
          });
        } else {
          // Legacy Phase 17: derive from CLOB prices (unreliable but better than nothing)
          if (
            resolution.yesFinalPrice !== null &&
            resolution.noFinalPrice !== null
          ) {
            derivedWinningOutcome =
              resolution.yesFinalPrice >= resolution.noFinalPrice ? 'YES' : 'NO';
          } else if (resolution.yesFinalPrice !== null) {
            derivedWinningOutcome =
              resolution.yesFinalPrice >= 0.5 ? 'YES' : 'NO';
          } else if (resolution.noFinalPrice !== null) {
            derivedWinningOutcome =
              resolution.noFinalPrice >= 0.5 ? 'NO' : 'YES';
          }
        }

        if (derivedWinningOutcome !== null) {
          // Phase 24: use balance-verified payout when available, else CLOB-derived
          const derivedPayoutUsd = useBalanceVerified
            ? balanceVerifiedPayoutUsd!
            : resolveVerifiedRedeemPayoutUsd({
                yesShares: redeemSettlement.yesShares,
                noShares: redeemSettlement.noShares,
                winningOutcome: derivedWinningOutcome,
              });
          const result = this.costBasisLedger.calculateRedeemPnl(
            conditionId,
            redeemedShares,
            derivedPayoutUsd
          );
          if (result.found && Number.isFinite(result.pnl)) {
            const dayState = market
              ? recordSettlementPnl({
                  slotKey: getSlotKey(market),
                  marketId: market.marketId,
                  marketTitle: market.title,
                  pnl: result.pnl,
                  outcome: resolveSlotOutcome(market, derivedWinningOutcome),
                  slotStart: market.startTime,
                  slotEnd: market.endTime,
                  now: redeemedAt,
                })
              : recordDayPnlDelta(result.pnl, redeemedAt, config);
            this.redeemPnlToday = roundTo(this.redeemPnlToday + result.pnl, 4);
            // OBI redeem stats for dashboard
            if (config.obiEngine.enabled) {
              const redeemCoinTitle = String(
                (payload as { title?: unknown })?.title ??
                  entry.marketTitle ?? ''
              );
              const redeemCoin = extractCoinFromObiTitle(redeemCoinTitle);
              this.obiEngine.recordRedeemForStats(redeemCoin, result.pnl);
            }
            logger.warn(
              useBalanceVerified
                ? 'Redeem PnL recorded from BALANCE VERIFICATION (Phase 24)'
                : 'Redeem PnL recorded from derived resolution (Phase 17 fallback)',
              {
                conditionId,
                title: String(
                  (payload as { title?: unknown })?.title ??
                    entry.marketTitle ??
                    'Unknown'
                ),
                redeemedShares,
                yesShares: redeemSettlement.yesShares,
                noShares: redeemSettlement.noShares,
                derivedWinningOutcome,
                yesFinalPrice: resolution.yesFinalPrice,
                noFinalPrice: resolution.noFinalPrice,
                derivedPayoutUsd,
                balanceVerifiedPayoutUsd,
                costBasis: entry.totalCostUsd,
                redeemPnl: result.pnl,
                newDayPnl: dayState.dayPnl,
                source: useBalanceVerified ? 'balance-delta' : 'clob-prices',
              }
            );
            dayStateOverride = {
              totalDayPnl: dayState.dayPnl,
              dayDrawdown: dayState.drawdown,
            };
          } else {
            logger.warn(
              'Redeem PnL deferred - cost basis lookup failed despite derived winner',
              {
                conditionId,
                derivedWinningOutcome,
                yesFinalPrice: resolution.yesFinalPrice,
                noFinalPrice: resolution.noFinalPrice,
              }
            );
          }
        } else {
          logger.warn('Redeem PnL deferred - market resolution unavailable', {
            conditionId,
            title: String(
              (payload as { title?: unknown })?.title ??
                entry.marketTitle ??
                'Unknown'
            ),
            redeemedShares,
            yesShares: redeemSettlement.yesShares,
            noShares: redeemSettlement.noShares,
            pairedShares: redeemSettlement.pairedShares,
            yesFinalPrice: resolution.yesFinalPrice,
            noFinalPrice: resolution.noFinalPrice,
            costBasis: entry.totalCostUsd,
            soldShares: entry.soldShares,
            soldCostUsd: entry.soldCostUsd,
            soldProceeds: entry.soldProceeds,
            reason:
              'Resolution lookup did not return a verified winning outcome AND no CLOB final prices available',
          });
        }
      }

      this.costBasisLedger.consume(conditionId);
      this.clearDustAbandonmentForCondition(conditionId);
      const clearedMarketIds = this.clearPositionStateForCondition(conditionId);
      if (clearedMarketIds.length > 0) {
        logger.info('Cleared local runtime positions after redeem settlement', {
          conditionId,
          marketIds: clearedMarketIds,
        });
      }
      if (market) {
        this.writeSlotReportSnapshot(getSlotKey(market));
      }
      this.syncRuntimeStatus(dayStateOverride ?? {});
    }

    if (this.productTestMode.isCompleted()) {
      logger.info('PRODUCT_TEST_MODE completed after redeem success');
      this.stop();
    }
  }

  async initialize(): Promise<void> {
    validateConfig();
    await this.tradeLogger.ensureReady();
    await this.executor.initialize();

    // Wire up dynamic compounding engine (no-op when COMPOUNDING_ENABLED=false)
    if (this.compounder.enabled) {
      this.signalEngine.setCompounder(this.compounder);
      this.quotingEngine.setCompounder(this.compounder);
      logger.info('Dynamic compounding engine enabled', {
        baseRiskPct: config.compounding.baseRiskPct,
        maxSlotExposurePct: config.compounding.maxSlotExposurePct,
        globalExposurePct: config.compounding.globalExposurePct,
        layers: config.compounding.layerMultipliers.length,
        drawdownGuardPct: config.compounding.drawdownGuardPct,
      });

      // Seed initial balance so compounding sizes are ready before first signal
      if (!isDryRunMode(config) && !isPaperTradingEnabled(config)) {
        try {
          const initialBalance = await this.executor.getUsdcBalance(true);
          if (typeof initialBalance === 'number' && Number.isFinite(initialBalance) && initialBalance > 0) {
            this.compounder.recalculate(initialBalance);
            logger.info('Compounding: initial balance seeded', {
              balance: roundTo(initialBalance, 2),
              snapshot: this.compounder.getSnapshot(),
            });
          }
        } catch {
          logger.warn('Compounding: failed to seed initial balance, will retry on next refresh');
        }
      }

      // Phase 19: standalone wallet funds refresh timer so drawdown guard
      // sees balance changes between slot ticks (not only when runCycle runs).
      if (!isDryRunMode(config) && !isPaperTradingEnabled(config)) {
        const intervalMs = config.runtime.walletFundsRefreshIntervalMs;
        this.walletFundsRefreshTimer = setInterval(() => {
          // Fire-and-forget; refreshWalletFundsSnapshot has its own throttle
          // (walletFundsRefreshMs) so rapid re-entrancy is a no-op.
          void this.refreshWalletFundsSnapshot(true).catch(() => {
            /* error already logged inside */
          });
        }, intervalMs);
        this.walletFundsRefreshTimer.unref?.();
        logger.info('Compounding: wallet funds refresh timer started', {
          intervalMs,
        });
      }
    }

    // Wire up regime filter (no-op when REGIME_FILTER_ENABLED=false)
    if (this.regimeFilter.enabled) {
      this.signalEngine.setRegimeFilter(this.regimeFilter, this.binanceEdge);
      logger.info('Market regime filter enabled', {
        lookbackWindowMs: config.regimeFilter.lookbackWindowMs,
        barIntervalMs: config.regimeFilter.barIntervalMs,
        efficiencyThreshold: config.regimeFilter.efficiencyThreshold,
        atrThreshold: config.regimeFilter.atrThreshold,
      });
    }

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

    // Narrator: log startup with fresh balance
    try {
      let startupBalance: number | null = null;
      if (!isDryRunMode(config) && !isPaperTradingEnabled(config)) {
        try {
          const bal = await this.executor.getUsdcBalance(false);
          if (typeof bal === 'number' && Number.isFinite(bal)) startupBalance = roundTo(bal, 2);
        } catch { /* fallback to null */ }
      }
      this.narrator.logStartup({
        balanceUsd: startupBalance,
        mode: isDryRunMode(config) ? 'DRY RUN' : isPaperTradingEnabled(config) ? 'PAPER' : 'LIVE',
        sniperEnabled: config.SNIPER_MODE_ENABLED,
        lotteryEnabled: config.lottery.enabled,
        mmEnabled: isDynamicQuotingEnabled(config),
      });
    } catch { /* narrator is best-effort */ }
  }

  /**
   * Returns the effective global max exposure USD, using dynamic compounding
   * override when enabled. Never goes below the static config value —
   * compounding only scales UP exposure limits as balance grows.
   */
  private getEffectiveGlobalMaxExposure(): number {
    if (this.compounder.enabled) {
      const dynamic = this.compounder.getDynamicGlobalMaxExposure();
      if (dynamic !== null && dynamic > config.GLOBAL_MAX_EXPOSURE_USD) return dynamic;
    }
    return config.GLOBAL_MAX_EXPOSURE_USD;
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
    try { this.narrator.logShutdown(reason); } catch { /* best-effort */ }
    if (this.walletFundsRefreshTimer) {
      clearInterval(this.walletFundsRefreshTimer);
      this.walletFundsRefreshTimer = null;
    }
    this.fillTracker.stop();
    this.userStream.stop();

    try {
      await withTimeout(
        (async () => {
          await this.flushBackgroundTasks();
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

  /**
   * Narrator helper — routes an execution to the appropriate narrator method.
   */
  private narrateExecution(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    shares: number;
    price: number;
    realizedDelta: number;
    beforeOutcomeLayer: StrategyLayer | null;
    binanceAssessment?: BinanceEdgeAssessment;
  }): void {
    const { market, signal, shares, price, realizedDelta, beforeOutcomeLayer, binanceAssessment } = params;

    // --- Sniper BUY entry ---
    if (signal.signalType === 'SNIPER_BUY' && signal.action === 'BUY') {
      this.narrator.logSniperEntry({
        marketId: market.marketId,
        marketTitle: market.title,
        outcome: signal.outcome,
        shares,
        price,
        binanceDirection: binanceAssessment?.available ? binanceAssessment.direction : 'UNKNOWN',
        binanceMovePct: binanceAssessment?.available ? binanceAssessment.binanceMovePct : 0,
        edge: signal.edgeAmount ?? 0,
        reason: signal.reason ?? '',
      });
      return;
    }

    // --- Lottery EXIT (when layer is LOTTERY) ---
    if (signal.action === 'SELL' && beforeOutcomeLayer === 'LOTTERY') {
      this.narrator.logLotteryExit({
        marketId: market.marketId,
        outcome: signal.outcome,
        exitPrice: price,
        shares,
        signalType: signal.signalType,
        reason: signal.reason ?? '',
        pnlUsd: realizedDelta,
      });
      return;
    }

    // --- Sniper EXIT (scalp, trailing TP, hard stop, slot flatten) ---
    if (
      signal.action === 'SELL' &&
      (signal.signalType === 'SNIPER_SCALP_EXIT' ||
        signal.signalType === 'TRAILING_TAKE_PROFIT' ||
        signal.signalType === 'HARD_STOP' ||
        signal.signalType === 'SLOT_FLATTEN')
    ) {
      this.narrator.logSniperExit({
        marketId: market.marketId,
        outcome: signal.outcome,
        shares,
        exitPrice: price,
        entryPrice: signal.referencePrice ?? price,
        signalType: signal.signalType,
        reason: signal.reason ?? '',
        pnlUsd: realizedDelta,
      });
      return;
    }

    // --- Lottery BUY entry ---
    if (signal.signalType === 'LOTTERY_BUY' && signal.action === 'BUY') {
      this.narrator.logLotteryEntry({
        marketId: market.marketId,
        marketTitle: market.title,
        outcome: signal.outcome,
        shares,
        price,
        riskUsd: roundTo(shares * price, 2),
      });
      return;
    }

    // --- MM quote fills ---
    if (signal.signalType === 'MM_QUOTE_BID' || signal.signalType === 'MM_QUOTE_ASK') {
      this.narrator.logMMFill({
        marketId: market.marketId,
        marketTitle: market.title,
        outcome: signal.outcome,
        side: signal.action,
        shares,
        price,
        pnlUsd: realizedDelta,
      });
      return;
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
    for (const market of markets) {
      this.markets.set(market.marketId, market);
    }
    const walletPositionRefreshPromise = this.refreshWalletPositionSnapshots();
    const walletFundsRefreshPromise = this.refreshWalletFundsSnapshot();
    await walletPositionRefreshPromise;
    await this.reconcileLivePositionsWithWallet();
    await walletFundsRefreshPromise;
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

    const tokenIds = markets.flatMap((market) => [market.yesTokenId, market.noTokenId]);
    const metadataPrewarmPromise = this.executor.prewarmMarketMetadata?.(tokenIds) ?? Promise.resolve();
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
    await metadataPrewarmPromise;

    const cycleNow = new Date();
    const preparedTicks = await this.prepareMarketTicks(markets);
    const sniperSelectionPlan = config.SNIPER_MODE_ENABLED
      ? this.buildSniperEntryOverrides(preparedTicks, cycleNow)
      : {
          overrides: new Map<string, readonly StrategySignal[]>(),
          suppressedMarkets: new Set<string>(),
        };

    // Feed the OBI engine the latest USDC balance so its pre-flight check
    // can refuse entries when we cannot afford them, instead of generating
    // signals the executor will reject.
    if (config.obiEngine.enabled) {
      this.obiEngine.setAvailableUsdcBalance(
        this.walletFundsSnapshot.walletCashUsd ?? null
      );
    }

    const preparedMarketIds = new Set<string>(
      preparedTicks.map((p) => p.market.marketId)
    );

    await runWithConcurrency(
      preparedTicks,
      config.runtime.maxConcurrentMarkets,
      async (preparedTick) => {
        await this.runSerializedMarketTask(preparedTick.market.marketId, async () => {
          await this.processPreparedMarket(
            preparedTick,
            sniperSelectionPlan.overrides.get(preparedTick.market.marketId) ?? undefined,
            sniperSelectionPlan.suppressedMarkets.has(preparedTick.market.marketId)
          );
        });
      }
    );

    // === Phase 16: OBI emergency hard-stop sweep ===
    // Iterates ALL tracked OBI positions every cycle (independent of the
    // per-market candidate loop) and fires hard-stop SELL signals on any
    // position whose unrealised PnL is past -hardStopUsd. Catches the
    // 2026-04-08 SOL incident where a position fell out of the candidate
    // list mid-slot and the in-loop hard stop was silently bypassed.
    if (config.obiEngine.enabled) {
      try {
        // NOTE: do NOT exclude preparedMarketIds here. The throttle inside
        // getEmergencyHardStopSignals (3s) prevents double-firing if the
        // in-loop generateExitSignals already emitted. The point of the
        // sweep is to be a safety net even for in-loop markets, in case
        // generateExitSignals returned early for any reason.
        const hardStops = this.obiEngine.getEmergencyHardStopSignals({
          positionManager: (marketId) => this.positions.get(marketId) ?? null,
          getOrderbook: (marketId) => this.latestBooks.get(marketId) ?? null,
          config: config.obiEngine,
        });
        for (const sig of hardStops) {
          const stopBook = this.latestBooks.get(sig.marketId);
          const stopPosManager = this.positions.get(sig.marketId);
          const stopMarket = this.markets.get(sig.marketId);
          if (!stopBook || !stopPosManager || !stopMarket) {
            logger.warn('OBI hard-stop sweep skipped: missing context', {
              marketId: sig.marketId,
              hasBook: !!stopBook,
              hasPosManager: !!stopPosManager,
              hasMarket: !!stopMarket,
            });
            continue;
          }
          this.scheduleBackgroundTask(async () => {
            try {
              await this.executeSignal(
                stopMarket,
                stopBook,
                stopPosManager,
                sig,
                getSlotKey(stopMarket)
              );
            } catch (error) {
              logger.warn('OBI hard-stop sweep execution failed', {
                marketId: sig.marketId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }
      } catch (error) {
        logger.warn('OBI hard-stop sweep failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // === Phase 26: OBI full exit sweep for orphaned positions ===
    // The main processPreparedMarket() loop only calls generateExitSignals()
    // for markets that pass scanEligibleMarkets() entry filters (price range,
    // liquidity, etc.). After entry, if the market price drifts outside
    // OBI_MIN_ENTRY_PRICE–OBI_MAX_ENTRY_PRICE, the market falls out of the
    // candidate list and generateExitSignals() is NEVER called. Result: every
    // position silently goes to redeem (50/50 coin flip) instead of scalp-
    // exiting. This sweep fetches a fresh orderbook for EVERY OBI position
    // not already processed and runs the full exit-signal evaluation (hard
    // stop, imbalance collapse, rebalance, scalp profit, slot flatten).
    if (config.obiEngine.enabled) {
      try {
        const activePositions = this.obiEngine.getActivePositions();
        for (const pos of activePositions) {
          if (preparedMarketIds.has(pos.marketId)) continue; // already processed in main loop

          const exitMarket = this.markets.get(pos.marketId);
          if (!exitMarket) {
            logger.debug('Phase 26 exit sweep: no cached market candidate', {
              marketId: pos.marketId,
            });
            continue;
          }

          let exitBook = this.latestBooks.get(pos.marketId) ?? null;

          // Fetch a FRESH orderbook so exit decisions use live prices, not
          // stale data from the entry tick. Best-effort: if the fetch fails,
          // fall back to the cached book (better than skipping entirely).
          try {
            exitBook = await this.fetcher.getMarketSnapshot(exitMarket);
            this.latestBooks.set(pos.marketId, exitBook);
            this.executor.recordOrderbookSnapshot(exitBook);
          } catch (fetchErr) {
            logger.debug('Phase 26 exit sweep: orderbook fetch failed, using cached', {
              marketId: pos.marketId,
              message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
            });
          }

          if (!exitBook) {
            logger.debug('Phase 26 exit sweep: no orderbook available', {
              marketId: pos.marketId,
            });
            continue;
          }

          const exitPosManager = this.getPositionManager(exitMarket);
          const exitSignals = this.obiEngine.generateExitSignals({
            market: exitMarket,
            orderbook: exitBook,
            positionManager: exitPosManager,
            config: config.obiEngine,
          });

          for (const sig of exitSignals) {
            logger.info('Phase 26 exit sweep: executing orphan exit signal', {
              marketId: sig.marketId,
              signalType: sig.signalType,
              reason: sig.reason,
              targetPrice: sig.targetPrice,
            });
            this.scheduleBackgroundTask(async () => {
              try {
                await this.executeSignal(
                  exitMarket,
                  exitBook!,
                  exitPosManager,
                  sig,
                  getSlotKey(exitMarket)
                );
              } catch (error) {
                logger.warn('Phase 26 exit sweep execution failed', {
                  marketId: sig.marketId,
                  signalType: sig.signalType,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            });
          }
        }
      } catch (error) {
        logger.warn('Phase 26 exit sweep failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // === OBI orphan slot-end safety net ===
    // After the normal per-market cycle, check if any OBI position is held on
    // a market that just dropped from the candidate list and is approaching
    // slot end. Without this, the position would silently redeem at $0.
    if (config.obiEngine.enabled) {
      try {
        const orphanFlattens = this.obiEngine.getOrphanFlattenSignals({
          positionManager: (marketId) => this.positions.get(marketId) ?? null,
          config: config.obiEngine,
          excludeMarketIds: preparedMarketIds,
        });
        for (const sig of orphanFlattens) {
          const orphanBook = this.latestBooks.get(sig.marketId);
          const orphanPosManager = this.positions.get(sig.marketId);
          const orphanMarket = this.markets.get(sig.marketId);
          if (!orphanBook || !orphanPosManager || !orphanMarket) {
            logger.warn('OBI orphan flatten skipped: missing context', {
              marketId: sig.marketId,
              hasBook: !!orphanBook,
              hasPosManager: !!orphanPosManager,
              hasMarket: !!orphanMarket,
            });
            continue;
          }
          this.scheduleBackgroundTask(async () => {
            try {
              await this.executeSignal(
                orphanMarket,
                orphanBook,
                orphanPosManager,
                sig,
                getSlotKey(orphanMarket)
              );
            } catch (error) {
              logger.warn('OBI orphan flatten execution failed', {
                marketId: sig.marketId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }
      } catch (error) {
        logger.warn('OBI orphan flatten check failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.syncRuntimeStatus({
      activeSlotsCount: markets.length,
    });
    this.printPendingReports();
  }

  private async prepareMarketTicks(
    markets: readonly MarketCandidate[]
  ): Promise<PreparedMarketTick[]> {
    const prepared: PreparedMarketTick[] = [];
    await runWithConcurrency(
      markets,
      config.runtime.maxConcurrentMarkets,
      async (market) => {
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
        const binanceVelocityPctPerSec = this.getBinanceVelocityPctPerSec(market);
        const deepBinanceAssessment = this.getDeepBinanceAssessment(market, orderbook);
        prepared.push({
          market,
          slotKey: getSlotKey(market),
          orderbook,
          positionManager,
          riskAssessment,
          binanceFairValueAdjustment,
          binanceAssessment,
          binanceVelocityPctPerSec,
          deepBinanceAssessment,
        } satisfies PreparedMarketTick);
      }
    );

    return prepared;
  }

  private handleTrackedFillDetected(fill: ConfirmedFill): void {
    if (
      isDynamicQuotingEnabled(config) &&
      (fill.signalType === 'MM_QUOTE_BID' || fill.signalType === 'MM_QUOTE_ASK')
    ) {
      this.quotingEngine.noteAutonomousQuoteDetectedFill({
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        signalType: fill.signalType,
        filledAtMs: fill.filledAt,
      });
    }
  }

  private buildSniperEntryOverrides(
    preparedTicks: readonly PreparedMarketTick[],
    now: Date
  ): SniperSelectionPlan {
    const overrides = new Map<string, readonly StrategySignal[]>();
    const suppressedMarkets = new Set<string>();
    for (const preparedTick of preparedTicks) {
      overrides.set(preparedTick.market.marketId, []);
    }

    if (
      this.statusMonitor.isPaused() ||
      this.latencyPaused ||
      shouldBlockSniperSelectionForApiGate({
        apiEntryGateOpen: this.isApiEntryGateOpen(),
        dryRunMode: isDryRunMode(config),
        paperTradingEnabled: isPaperTradingEnabled(config),
      })
    ) {
      return {
        overrides,
        suppressedMarkets,
      };
    }

    const candidateMarketIds = new Set<string>();
    const candidates = preparedTicks.flatMap((preparedTick) => {
      if (preparedTick.riskAssessment.forcedSignals.length > 0) {
        return [];
      }

      if (this.signalEngine.hasActiveSniperEntryForMarket(preparedTick.market.marketId)) {
        return [];
      }

      const candidate = this.signalEngine.evaluateSniperCandidate({
        market: preparedTick.market,
        orderbook: preparedTick.orderbook,
        positionManager: preparedTick.positionManager,
        riskAssessment: preparedTick.riskAssessment,
        binanceAssessment: preparedTick.binanceAssessment,
        binanceVelocityPctPerSec: preparedTick.binanceVelocityPctPerSec,
        now,
      });
      if (!candidate) {
        return [];
      }

      candidateMarketIds.add(preparedTick.market.marketId);
      return [candidate];
    });

    const selectedSignals = this.signalEngine.selectSniperSignals(candidates, now);
    const selectedMarketIds = new Set<string>();
    for (const signal of selectedSignals) {
      selectedMarketIds.add(signal.marketId);
      overrides.set(signal.marketId, [signal]);
    }

    for (const marketId of candidateMarketIds) {
      if (!selectedMarketIds.has(marketId)) {
        suppressedMarkets.add(marketId);
      }
    }

    return {
      overrides,
      suppressedMarkets,
    };
  }

  private async processPreparedMarket(
    preparedTick: PreparedMarketTick,
    sniperEntryOverride?: readonly StrategySignal[],
    suppressDirectionalEntries: boolean = false
  ): Promise<void> {
    const {
      market,
      slotKey,
      orderbook,
      positionManager,
      riskAssessment,
      binanceFairValueAdjustment,
      binanceAssessment,
      binanceVelocityPctPerSec,
      deepBinanceAssessment,
    } = preparedTick;

    // 2026-04-08 dust-abandon recovery: if this market has a dust-abandoned
    // position and the orderbook just printed a healthier best bid, lift the
    // flag so OBI exit signals can re-engage instead of waiting for redeem.
    this.recheckDustAbandonmentOnRecovery(market, orderbook);

    // Phase 22 (2026-04-09): when OBI engine is the active strategy, SKIP the
    // legacy signal engine entirely. The legacy engine (COMBINED_DISCOUNT_BUY_BOTH,
    // EXTREME_BUY, etc.) has NO Phase 15–22 safety guards and produced catastrophic
    // losses: 6× XRP buys at 49¢ → sold at 28¢ = -$7.34, and 2× ETH buys that
    // dust-trapped for -$16.26. OBI is the sole entry engine when enabled.
    const signals: StrategySignal[] = config.obiEngine.enabled
      ? []
      : this.signalEngine.generateSignals({
          market,
          orderbook,
          positionManager,
          riskAssessment,
          binanceFairValueAdjustment,
          binanceAssessment,
          binanceVelocityPctPerSec,
          sniperEntryOverride,
        });
    if (!config.obiEngine.enabled) {
      this.rememberSkippedSignals(this.signalEngine.drainSkippedSignals());
    }

    if (config.obiEngine.enabled) {
      // Phase 21: OBI compounding — scale entry/max shares with bankroll growth.
      const obiMult = this.compounder.enabled
        ? this.compounder.getObiSizeMultiplier(config.obiEngine.obiCompoundThresholdUsd)
        : 1.0;
      const obiEntrySignals = this.obiEngine.generateSignals({
        market,
        orderbook,
        positionManager,
        config: config.obiEngine,
        deepBinanceAssessment,
        obiSizeMultiplier: obiMult,
      });
      const obiExitSignals = this.obiEngine.generateExitSignals({
        market,
        orderbook,
        positionManager,
        config: config.obiEngine,
      });
      for (const sig of obiEntrySignals) signals.push(sig);
      for (const sig of obiExitSignals) signals.push(sig);
    }
    const sniperFilteredSignals = this.applySniperCorrelationFilter(
      market,
      signals,
      suppressDirectionalEntries
    );
    const dustFilteredSignals = this.filterDustAbandonedSignals(market, sniperFilteredSignals);
    const statusPausedSignals = this.applyPauseFilter(market, dustFilteredSignals);
    const apiGuardSignals = this.applyApiCircuitBreakerFilter(
      market,
      statusPausedSignals
    );
    const latencyPausedSignals = this.applyLatencyPauseFilter(
      market,
      apiGuardSignals
    );
    const coordinatedSignals = this.applyLayerCoordinationFilters(
      market,
      positionManager,
      latencyPausedSignals
    );
    const quoteSignals = isDynamicQuotingEnabled(config)
      ? coordinatedSignals.filter((signal) => isQuotingSignalType(signal.signalType))
      : [];
    const directSignals = isDynamicQuotingEnabled(config)
      ? coordinatedSignals.filter((signal) => !isQuotingSignalType(signal.signalType))
      : coordinatedSignals;
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
        pendingQuoteExposure: this.getPendingQuoteExposure(market.marketId),
        binanceFairValueAdjustment,
        binanceAssessment,
        deepBinanceAssessment,
      });
    }
    const executionCandidates = this.sortExecutionCandidatesByLayerPriority(
      this.applyBinanceEdge(market, orderbook, directSignals)
    );
    this.rememberMarketAction(
      market,
      coordinatedSignals,
      executionCandidates,
      positionManager,
      quoteSignals
    );

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

    if (
      signal.reduceOnly &&
      signal.action === 'SELL' &&
      this.isDustAbandoned(market.marketId, signal.outcome)
    ) {
      return null;
    }

    const book = signal.outcome === 'YES' ? orderbook.yes : orderbook.no;
    const exitGuardPrice = resolveReduceOnlySellReferencePrice({
      signal,
      outcome: signal.outcome,
      book,
      positionManager,
    });
    const fullAvailableShares = positionManager.getShares(signal.outcome);
    let guardedSell = resolveReduceOnlySellGuard({
      signal,
      availableShares: fullAvailableShares,
      referencePrice: exitGuardPrice,
    });
    if (signal.action === 'SELL' && signal.reduceOnly) {
      this.setBlockedExitRemainder(
        market.marketId,
        signal.outcome,
        guardedSell.blockedRemainderShares
      );
      if (guardedSell.skip) {
        // Before condemning the position to redeem, check whether the FULL
        // available position would also fail the minimum-size guard. If the
        // full position IS still sellable, this signal is just undersized
        // (e.g. an MM quote sized to a partial-fill increment) and we should
        // skip it WITHOUT abandoning — a subsequent exit signal will use the
        // full position size and clear cleanly. Without this check, one
        // undersized maker quote would freeze the entire healthy position
        // until slot-end redeem (the 2026-04-08 XRP $5.28 incident).
        const fullPositionGuard = resolveReduceOnlySellGuard({
          signal: { ...signal, shares: fullAvailableShares },
          availableShares: fullAvailableShares,
          referencePrice: exitGuardPrice,
        });
        if (!fullPositionGuard.skip) {
          this.recordSkippedSignal({
            signal,
            filterReason: 'MIN_ORDER_SIZE',
            details: `signalShares=${guardedSell.requestedShares.toFixed(4)} minimum=${guardedSell.minimumShares.toFixed(4)} fullAvailable=${fullAvailableShares.toFixed(4)} (full position still sellable, not abandoning)`,
          });
          logger.debug(
            'Reduce-only SELL skipped because signal undersized vs full position; not abandoning',
            {
              marketId: market.marketId,
              signalType: signal.signalType,
              outcome: signal.outcome,
              signalShares: roundTo(guardedSell.requestedShares, 4),
              minimumShares: roundTo(guardedSell.minimumShares, 4),
              fullAvailableShares: roundTo(fullAvailableShares, 4),
            }
          );
          return null;
        }
        this.recordSkippedSignal({
          signal,
          filterReason: 'MIN_ORDER_SIZE',
          details: `shares=${guardedSell.requestedShares.toFixed(4)} minimum=${guardedSell.minimumShares.toFixed(4)} fullAvailable=${fullAvailableShares.toFixed(4)}`,
        });
        this.abandonPositionForRedeem({
          market,
          signal,
          requestedShares: guardedSell.requestedShares,
          minimumShares: guardedSell.minimumShares,
          referencePrice: exitGuardPrice,
        });
        return null;
      }
    }

    let executionSignal =
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
        referencePrice: exitGuardPrice,
      });
      if (!settlementReady.ready) {
        if (settlementReady.abandonToRedeem) {
          this.skipReduceOnlySellForDust({
            market,
            signal: executionSignal,
            requestedShares: settlementReady.availableShares,
            minimumShares: settlementReady.minimumShares,
            referencePrice: exitGuardPrice,
            details: `settledShares=${settlementReady.availableShares.toFixed(4)} minimum=${settlementReady.minimumShares.toFixed(4)}`,
          });
          this.clearSettlementConfirmation(market.marketId, executionSignal.outcome);
        }
        return null;
      }

      if (
        settlementReady.executionShares > 0 &&
        roundTo(settlementReady.executionShares, 4) !== roundTo(executionSignal.shares, 4)
      ) {
        guardedSell = resolveReduceOnlySellGuard({
          signal: executionSignal,
          availableShares: settlementReady.executionShares,
          referencePrice: exitGuardPrice,
        });
        this.setBlockedExitRemainder(
          market.marketId,
          executionSignal.outcome,
          guardedSell.blockedRemainderShares
        );
        executionSignal = {
          ...executionSignal,
          shares: guardedSell.executionShares,
          reason: `${executionSignal.reason} | clamped to settled balance ${guardedSell.executionShares.toFixed(4)}`,
        };
        logger.info('Live reduce-only SELL clamped to settled token balance', {
          marketId: market.marketId,
          signalType: executionSignal.signalType,
          outcome: executionSignal.outcome,
          requestedShares: roundTo(signal.shares, 4),
          executionShares: guardedSell.executionShares,
          availableShares: settlementReady.availableShares,
        });
      }
    }
    if (!paperTradingEnabled && executionSignal.action === 'SELL' && executionSignal.reduceOnly) {
      const reconciledSignal = await this.reconcileLiveReduceOnlySellSignal({
        market,
        signal: executionSignal,
        tokenId,
        referencePrice: exitGuardPrice,
      });
      if (!reconciledSignal) {
        return null;
      }
      executionSignal = reconciledSignal;
    }

    const beforeSnapshot = positionManager.getSnapshot();
    const beforeOutcomeLayer = positionManager.getPositionLayer(executionSignal.outcome);

    // OBI exit signals (OBI_REBALANCE_EXIT / OBI_SCALP_EXIT — the umbrella
    // type for hard stop, collapse, rebalance, scalp, orphan flatten) must
    // first cancel any pending OBI_MM_QUOTE_ASK on the same market+outcome
    // so the resting maker order's collateral is released before we try to
    // submit the cross-spread exit. See cancelPendingObiMakerQuotes for the
    // full rationale (2026-04-08 race condition).
    //
    // Phase 7 (2026-04-08): for HARD STOP / COLLAPSE / CANCEL-ALL exits we
    // bypass the 500ms sleep and parallelise cancels — every millisecond
    // counts when the book is collapsing (live SOL trade lost extra $0.50+
    // because the old sequential cancel-wait took 2.5s to release collateral).
    // Phase 13 (2026-04-08): instrument emergency OBI exits end-to-end so
    // we can finally pinpoint where the 2.5s signal→order latency comes
    // from. Live observed: hard stop 2582ms, MM exit quote 2603ms, both
    // on 2026-04-08 post-12:48. Trade budget is 100-300ms.
    const obiExitIsEmergency =
      !paperTradingEnabled &&
      isObiExitSignal(executionSignal.signalType) &&
      executionSignal.action === 'SELL' &&
      this.isEmergencyObiExit(executionSignal);
    const obiLatencyT0 = executionSignal.generatedAt ?? Date.now();
    const obiLatencyEnterExecute = Date.now();

    if (
      !paperTradingEnabled &&
      isObiExitSignal(executionSignal.signalType) &&
      executionSignal.action === 'SELL'
    ) {
      const emergency = this.isEmergencyObiExit(executionSignal);
      await this.cancelPendingObiMakerQuotes({
        marketId: market.marketId,
        outcome: executionSignal.outcome,
        triggeredBy: executionSignal.signalType,
        emergency,
      });
    }

    const obiLatencyPostCancel = Date.now();
    const startedAt = Date.now();
    const execution = await this.executor.executeSignal({
      market,
      orderbook,
      signal: executionSignal,
    });
    const executionCompletedAt = Date.now();

    if (obiExitIsEmergency) {
      logger.warn('OBI emergency exit latency breakdown', {
        marketId: market.marketId,
        signalType: executionSignal.signalType,
        reason: executionSignal.reason,
        t0SignalGeneratedAt: obiLatencyT0,
        msSignalToExecuteEntry: obiLatencyEnterExecute - obiLatencyT0,
        msCancelQuotes: obiLatencyPostCancel - obiLatencyEnterExecute,
        msExecutorSubmit: executionCompletedAt - obiLatencyPostCancel,
        msTotalSignalToSubmit: executionCompletedAt - obiLatencyT0,
        executorLatencySignalToOrderMs: execution.latencySignalToOrderMs,
        executorLatencyRoundTripMs: execution.latencyRoundTripMs,
      });
    }
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
            strategyLayer:
              executionSignal.strategyLayer ??
              resolveStrategyLayer(executionSignal.signalType),
          })
        : beforeSnapshot;

    if (effectiveShares > 0) {
      if (
        isDynamicQuotingEnabled(config) &&
        (executionSignal.signalType === 'MM_QUOTE_BID' ||
          executionSignal.signalType === 'MM_QUOTE_ASK')
      ) {
        this.quotingEngine.noteAutonomousQuoteFill({
          marketId: market.marketId,
          outcome: executionSignal.outcome,
          side: executionSignal.action,
          signalType: executionSignal.signalType,
          filledAtMs: executionCompletedAt,
          afterYesShares: afterSnapshot.yesShares,
          afterNoShares: afterSnapshot.noShares,
        });
      }
      if (executionSignal.signalType === 'LOTTERY_BUY' && executionSignal.action === 'BUY') {
        this.lotteryEngine.recordExecution({
          marketId: market.marketId,
          outcome: executionSignal.outcome,
          filledShares: effectiveShares,
          fillPrice: effectivePrice,
          signalType: executionSignal.signalType,
          slotKey,
        });
      }
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
    } else if (
      !execution.simulation &&
      executionSignal.signalType === 'SNIPER_SCALP_EXIT' &&
      executionSignal.action === 'SELL'
    ) {
      let exitOrderCancelled = !execution.orderId;
      if (execution.orderId) {
        try {
          await this.executor.cancelOrder(execution.orderId);
          exitOrderCancelled = true;
        } catch (error) {
          logger.warn('Failed to cancel unfilled sniper exit order', {
            marketId: market.marketId,
            outcome: executionSignal.outcome,
            orderId: execution.orderId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (exitOrderCancelled) {
        if (execution.orderId) {
          this.fillTracker.forgetPendingOrder(execution.orderId);
        }
        this.clearPendingLiveOrder(pendingOrderKey);
        this.clearPostSniperMakerAskSignal(market.marketId, executionSignal.outcome);
        this.signalEngine.recordFailedSniperExit({
          marketId: market.marketId,
          outcome: executionSignal.outcome,
        });
        logger.warn('Sniper exit was not filled; HARD_STOP fallback re-armed', {
          marketId: market.marketId,
          outcome: executionSignal.outcome,
          orderId: execution.orderId,
          submittedShares: execution.shares,
          submittedPrice: execution.price,
        });
      } else {
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
          strategyLayer:
            executionSignal.strategyLayer ?? resolveStrategyLayer(executionSignal.signalType),
          placedAt: startedAt,
          slotEndTime:
            market.endTime ??
            new Date(startedAt + config.FILL_POLL_TIMEOUT_MS).toISOString(),
          lastCheckedAt: 0,
          filledSharesSoFar: 0,
        });
      }
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
        strategyLayer:
          executionSignal.strategyLayer ?? resolveStrategyLayer(executionSignal.signalType),
        placedAt: startedAt,
        slotEndTime:
          market.endTime ??
          new Date(startedAt + config.FILL_POLL_TIMEOUT_MS).toISOString(),
        lastCheckedAt: 0,
        filledSharesSoFar: 0,
      });
      // Variant A4: also remember OBI maker quotes in our backup registry,
      // so cancelPendingObiMakerQuotes can find them even if fillTracker
      // drops them on a poll-timeout cycle before the order actually fills.
      if (
        executionSignal.signalType === 'OBI_MM_QUOTE_ASK' ||
        executionSignal.signalType === 'OBI_MM_QUOTE_BID'
      ) {
        this.rememberRestingObiMakerOrder({
          marketId: market.marketId,
          outcome: executionSignal.outcome,
          orderId: execution.orderId,
        });
      }
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
    const completedAt = executionCompletedAt;
    if (
      !execution.simulation &&
      execution.orderId &&
      !execution.fillConfirmed &&
      executionSignal.signalType === 'MM_QUOTE_ASK' &&
      executionSignal.reason.startsWith('Post-sniper MM ask')
    ) {
      this.notePostSniperMakerAskSignal(
        market.marketId,
        executionSignal.outcome,
        completedAt
      );
    }
    if (!paperTradingEnabled && effectiveShares > 0 && executionSignal.action === 'BUY') {
      this.armSettlementConfirmation(market.marketId, executionSignal.outcome, completedAt);
      this.executor.invalidateOutcomeBalanceCache(tokenId);
      this.executor.invalidateBalanceValidationCache();
    } else if (!paperTradingEnabled && effectiveShares > 0 && executionSignal.action === 'SELL') {
      this.clearSettlementConfirmation(market.marketId, executionSignal.outcome);
      this.clearPostSniperMakerAskSignal(market.marketId, executionSignal.outcome);
      this.executor.invalidateOutcomeBalanceCache(tokenId);
      this.executor.invalidateBalanceValidationCache();
    }
    if (
      effectiveShares > 0 &&
      executionSignal.signalType === 'SNIPER_BUY' &&
      executionSignal.action === 'BUY' &&
      isDynamicQuotingEnabled(config) &&
      config.MM_AUTO_ACTIVATE_AFTER_SNIPER
    ) {
      const obiAllowsMM = this.orderBookImbalance.shouldAllowMMActivation({
        marketId: market.marketId,
        orderbook,
        entryOutcome: executionSignal.outcome,
        coin: extractCoinFromTitle(market.title) ?? undefined,
      });
      if (obiAllowsMM) {
        this.quotingEngine.activateForMarket(market.marketId, {
          triggerLayer: 'SNIPER',
          entryOutcome: executionSignal.outcome,
          entryPrice: effectivePrice,
          entryShares: effectiveShares,
        });
        logger.info('MM_QUOTE activated after sniper entry', {
          marketId: market.marketId,
          outcome: executionSignal.outcome,
          price: roundTo(effectivePrice, 4),
          shares: roundTo(effectiveShares, 4),
        });
      }
    }
    if (
      effectiveShares > 0 &&
      executionSignal.signalType === 'SNIPER_BUY' &&
      executionSignal.action === 'BUY' &&
      config.lottery.enabled
    ) {
      this.maybeScheduleLotteryFollowOn({
        market,
        orderbook,
        positionManager,
        triggerSignalType: executionSignal.signalType,
        triggerOutcome: executionSignal.outcome,
        triggerFillPrice: effectivePrice,
        triggerFilledShares: effectiveShares,
        slotKey,
        failureLogMessage: 'Lottery ticket execution failed',
      });
    }
    if (
      effectiveShares > 0 &&
      executionSignal.action === 'SELL' &&
      beforeOutcomeLayer === 'LOTTERY' &&
      positionManager.getShares(executionSignal.outcome) <= LIVE_POSITION_RECONCILIATION_EPSILON
    ) {
      this.lotteryEngine.recordExit(market.marketId, executionSignal.outcome);
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

    // Narrator: log trade events
    if (effectiveShares > 0) {
      try {
        this.narrateExecution({
          market,
          signal: executionSignal,
          shares: effectiveShares,
          price: effectivePrice,
          realizedDelta,
          beforeOutcomeLayer,
          binanceAssessment,
        });
      } catch { /* narrator is best-effort */ }
    }

    const slotMetrics = getSlotMetrics(slotKey);
    const dayState = getDayPnlState(new Date(completedAt));
    const latencyRoundTripMs =
      execution.latencyRoundTripMs ??
      (executionSignal.generatedAt !== undefined
        ? Math.max(0, completedAt - executionSignal.generatedAt)
        : undefined);
    if (this.shouldTrackLatencyForSignal(executionSignal)) {
      this.updateLatencyPause(latencyRoundTripMs ?? execution.latencySignalToOrderMs);
    }

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
      strategyLayer:
        executionSignal.strategyLayer ?? resolveStrategyLayer(executionSignal.signalType),
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
    const beforeOutcomeLayer = positionManager.getPositionLayer(fill.outcome);
    const afterSnapshot = positionManager.applyFill({
      outcome: fill.outcome,
      side: fill.side,
      shares: fill.filledShares,
      price: fill.fillPrice,
      timestamp: new Date(fill.filledAt).toISOString(),
      orderId: fill.orderId,
      strategyLayer: fill.strategyLayer ?? resolveStrategyLayer(fill.signalType),
    });
    if (
      isDynamicQuotingEnabled(config) &&
      (fill.signalType === 'MM_QUOTE_BID' || fill.signalType === 'MM_QUOTE_ASK')
    ) {
      this.quotingEngine.noteAutonomousQuoteFill({
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        signalType: fill.signalType,
        filledAtMs: fill.filledAt,
        afterYesShares: afterSnapshot.yesShares,
        afterNoShares: afterSnapshot.noShares,
      });
    }
    if (fill.signalType === 'LOTTERY_BUY' && fill.side === 'BUY') {
      this.lotteryEngine.recordExecution({
        marketId: fill.marketId,
        outcome: fill.outcome,
        filledShares: fill.filledShares,
        fillPrice: fill.fillPrice,
        signalType: fill.signalType,
        slotKey: fill.slotKey,
      });
    }
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
      if (
        fill.signalType === 'SNIPER_BUY' &&
        isDynamicQuotingEnabled(config) &&
        config.MM_AUTO_ACTIVATE_AFTER_SNIPER
      ) {
        const obiOrderbook =
          this.latestBooks.get(fill.marketId) ??
          this.quotingEngine.getContext(fill.marketId)?.orderbook;
        const obiAllowsMM = obiOrderbook
          ? this.orderBookImbalance.shouldAllowMMActivation({
              marketId: fill.marketId,
              orderbook: obiOrderbook,
              entryOutcome: fill.outcome,
              coin: extractCoinFromTitle(market.title) ?? undefined,
            })
          : !this.orderBookImbalance.enabled;
        if (obiAllowsMM) {
          this.quotingEngine.activateForMarket(fill.marketId, {
            triggerLayer: 'SNIPER',
            entryOutcome: fill.outcome,
            entryPrice: fill.fillPrice,
            entryShares: fill.filledShares,
          });
          logger.info('MM_QUOTE activated after delayed sniper fill', {
            marketId: fill.marketId,
            outcome: fill.outcome,
            price: roundTo(fill.fillPrice, 4),
            shares: roundTo(fill.filledShares, 4),
          });
        }
      }
      if (fill.signalType === 'OBI_ENTRY_BUY' && config.obiEngine.enabled) {
        const obiCoin = extractCoinFromObiTitle(market.title);
        this.obiEngine.recordEntryForStats(obiCoin, `${fill.outcome} ${fill.filledShares}sh @${roundTo(fill.fillPrice, 3)}`);
        const obiBook =
          this.latestBooks.get(fill.marketId) ??
          this.quotingEngine.getContext(fill.marketId)?.orderbook;
        if (obiBook) {
          // Use the post-fill cumulative position from positionManager so the
          // engine can quote MM ASK against the FULL position size (handles
          // multi-clip partial fills correctly).
          const totalLiveShares = positionManager.getShares(fill.outcome);
          const mmSignals = this.obiEngine.onEntryFill({
            marketId: fill.marketId,
            marketTitle: market.title,
            outcome: fill.outcome,
            fillPrice: fill.fillPrice,
            filledShares: fill.filledShares,
            orderbook: obiBook,
            config: config.obiEngine,
            totalLiveShares,
            slotEndTime: market.endTime,
          });
          for (const obiSignal of mmSignals) {
            const obiOrderbook = obiBook;
            this.scheduleBackgroundTask(async () => {
              try {
                // Variant A2 (2026-04-08 MM refresh race): onEntryFill fires
                // on EVERY partial fill of OBI_ENTRY_BUY, and each call emits
                // a fresh OBI_MM_QUOTE_ASK sized against the accumulated
                // position. The previous OBI_MM_QUOTE_ASK from the earlier
                // partial fill is still resting on CLOB, locking the same
                // shares as collateral ("sum of active orders: N"). Without
                // cancelling first, the new quote fails with "balance is
                // not enough" and retries storm. Reuse the exit-path helper
                // — it cancels by (marketId, outcome, side=SELL,
                // OBI_MM_QUOTE_*) which matches what we need here.
                if (
                  obiSignal.signalType === 'OBI_MM_QUOTE_ASK' ||
                  obiSignal.signalType === 'OBI_MM_QUOTE_BID'
                ) {
                  // Variant A3 (2026-04-08 stale-quote guard): onEntryFill
                  // schedules maker-quote signals as background tasks. By the
                  // time the task runs, an exit may already have closed the
                  // position (e.g. fast OBI_REBALANCE_EXIT immediately after
                  // the entry fill). Posting an OBI_MM_QUOTE_ASK for a
                  // position that no longer exists wastes a round-trip and
                  // can collide with residual CLOB state ("sum of active
                  // orders" ≥ balance). Re-check PositionManager just before
                  // dispatch and skip the signal if the position is gone or
                  // below CLOB minimum.
                  const currentShares = positionManager.getShares(obiSignal.outcome);
                  const minShares = resolveMinimumTradableShares(
                    obiSignal.targetPrice ?? obiSignal.referencePrice ?? Number.NaN,
                    0
                  );
                  if (currentShares < minShares) {
                    logger.info('OBI maker quote skipped - position closed or dust before dispatch', {
                      marketId: fill.marketId,
                      outcome: obiSignal.outcome,
                      signalType: obiSignal.signalType,
                      currentShares: roundTo(currentShares, 4),
                      minShares: roundTo(minShares, 4),
                    });
                    return;
                  }
                  await this.cancelPendingObiMakerQuotes({
                    marketId: fill.marketId,
                    outcome: obiSignal.outcome,
                    triggeredBy: obiSignal.signalType,
                  });
                }
                await this.executeSignal(
                  market,
                  obiOrderbook,
                  positionManager,
                  obiSignal,
                  fill.slotKey
                );
              } catch (error) {
                logger.debug('OBI follow-on quote execution failed', {
                  marketId: fill.marketId,
                  signalType: obiSignal.signalType,
                  outcome: obiSignal.outcome,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            });
          }
        }
      }
      if (fill.signalType === 'SNIPER_BUY' && config.lottery.enabled) {
        const orderbook =
          this.latestBooks.get(fill.marketId) ?? this.quotingEngine.getContext(fill.marketId)?.orderbook;
        if (orderbook) {
          this.maybeScheduleLotteryFollowOn({
            market,
            orderbook,
            positionManager,
            triggerSignalType: fill.signalType,
            triggerOutcome: fill.outcome,
            triggerFillPrice: fill.fillPrice,
            triggerFilledShares: fill.filledShares,
            slotKey: fill.slotKey,
            failureLogMessage: 'Lottery ticket execution failed after delayed sniper fill',
          });
        }
      }
    } else {
      this.clearSettlementConfirmation(fill.marketId, fill.outcome);
      this.executor.invalidateOutcomeBalanceCache(fill.tokenId);
      this.executor.invalidateBalanceValidationCache();
    }
    const pendingOrderStillTracked = this.fillTracker
      .getPendingOrders()
      .some((pending) => pending.orderId === fill.orderId);
    if (!pendingOrderStillTracked) {
      this.quotingEngine.forgetQuoteOrder(fill.orderId);
    }
    if (fill.signalType === 'MM_QUOTE_ASK' && fill.side === 'SELL') {
      this.clearPostSniperMakerAskSignal(fill.marketId, fill.outcome);
    }
    if (
      fill.side === 'SELL' &&
      beforeOutcomeLayer === 'LOTTERY' &&
      positionManager.getShares(fill.outcome) <= LIVE_POSITION_RECONCILIATION_EPSILON
    ) {
      this.lotteryEngine.recordExit(fill.marketId, fill.outcome);
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

    // OBI exit stats for dashboard
    if (
      config.obiEngine.enabled &&
      fill.side === 'SELL' &&
      isObiExitSignal(fill.signalType)
    ) {
      const exitCoin = extractCoinFromObiTitle(market.title);
      this.obiEngine.recordExitForStats(exitCoin, realizedDelta, fill.signalType);
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

    // Narrator: log delayed confirmed fill
    try {
      const trackedSignal = createTrackedSignal(market, fill);
      this.narrateExecution({
        market,
        signal: trackedSignal,
        shares: fill.filledShares,
        price: fill.fillPrice,
        realizedDelta,
        beforeOutcomeLayer,
      });
    } catch { /* narrator is best-effort */ }

    // Variant A4: drop the orderId from the resting OBI registry once a
    // fill is confirmed so cancelPendingObiMakerQuotes doesn't try to
    // cancel an already-completed order on the next exit cycle.
    if (
      fill.signalType === 'OBI_MM_QUOTE_ASK' ||
      fill.signalType === 'OBI_MM_QUOTE_BID'
    ) {
      this.forgetRestingObiMakerOrder({
        marketId: fill.marketId,
        outcome: fill.outcome,
        orderId: fill.orderId,
      });
    }

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

    if (
      signal.signalType !== 'LOTTERY_BUY' &&
      signal.latencyMs !== null &&
      Number.isFinite(signal.latencyMs)
    ) {
      this.recentLatencySamples.push(Math.max(0, signal.latencyMs));
      while (this.recentLatencySamples.length > 64) {
        this.recentLatencySamples.shift();
      }
    }
  }

  private shouldTrackLatencyForSignal(
    signal: Pick<StrategySignal, 'signalType' | 'strategyLayer'>
  ): boolean {
    return (signal.strategyLayer ?? resolveStrategyLayer(signal.signalType)) !== 'LOTTERY';
  }

  private maybeScheduleLotteryFollowOn(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    triggerSignalType: StrategySignal['signalType'];
    triggerOutcome: StrategySignal['outcome'];
    triggerFillPrice: number;
    triggerFilledShares: number;
    slotKey: string;
    failureLogMessage: string;
  }): void {
    if (!config.lottery.enabled || this.stopping) {
      return;
    }

    const lotterySignal = this.lotteryEngine.generateLotterySignal({
      market: params.market,
      orderbook: params.orderbook,
      positionManager: params.positionManager,
      triggerSignalType: params.triggerSignalType,
      triggerOutcome: params.triggerOutcome,
      triggerFillPrice: params.triggerFillPrice,
      triggerFilledShares: params.triggerFilledShares,
      config: config.lottery,
      slotKey: params.slotKey,
    });
    if (!lotterySignal) {
      return;
    }

    if (!this.shouldAllowFollowOnEntry(params.market.marketId, params.positionManager, lotterySignal)) {
      return;
    }

    this.scheduleBackgroundTask(async () => {
      try {
        const lotteryExecution = await this.executeSignal(
          params.market,
          params.orderbook,
          params.positionManager,
          lotterySignal,
          params.slotKey
        );
        if (lotteryExecution?.fillConfirmed && lotteryExecution.filledShares > 0) {
          logger.info('Lottery ticket filled', {
            marketId: params.market.marketId,
            outcome: lotterySignal.outcome,
            shares: lotteryExecution.filledShares,
            price: lotteryExecution.fillPrice ?? lotteryExecution.price,
            riskUsdc: roundTo(
              lotteryExecution.filledShares * (lotteryExecution.fillPrice ?? lotteryExecution.price),
              2
            ),
          });
        }
      } catch (error) {
        logger.debug(params.failureLogMessage, {
          marketId: params.market.marketId,
          outcome: lotterySignal.outcome,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private scheduleBackgroundTask(taskFactory: () => Promise<void>): void {
    let task: Promise<void>;
    task = Promise.resolve()
      .then(taskFactory)
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
    this.backgroundTasks.add(task);
  }

  private async flushBackgroundTasks(): Promise<void> {
    if (this.backgroundTasks.size === 0) {
      return;
    }

    await Promise.allSettled([...this.backgroundTasks]);
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

  private applyLayerCoordinationFilters(
    market: MarketCandidate,
    positionManager: PositionManager,
    signals: readonly StrategySignal[]
  ): StrategySignal[] {
    if (signals.length === 0) {
      return [];
    }

    const pendingQuoteExposure = this.getPendingQuoteExposure();
    const simulatedExposure: LayerExposureAccumulator = {
      ...this.getGlobalExposure(pendingQuoteExposure),
    };
    const plannedLayers = new Set<StrategyLayer>(
      this.getActiveLayersForMarket(market.marketId, positionManager)
    );
    const allowed: StrategySignal[] = [];
    const atomicPairedSignals = signals.filter((signal) =>
      isAtomicPairedArbExecutionCandidate(signal)
    );
    const hasValidAtomicPair =
      atomicPairedSignals.length === 2 &&
      new Set(atomicPairedSignals.map((signal) => signal.outcome)).size === 2;

    if (atomicPairedSignals.length > 0) {
      if (!hasValidAtomicPair) {
        for (const signal of atomicPairedSignals) {
          this.recordSkippedSignal({
            signal,
            filterReason: 'invalid_atomic_pair',
            details: 'Paired arbitrage requires both YES and NO entry legs in the same tick.',
          });
        }
      } else {
        const pairLayer = this.resolveSignalLayer(atomicPairedSignals[0]);
        const conflictingLayers =
          config.LAYER_CONFLICT_RESOLUTION === 'BLOCK'
            ? Array.from(plannedLayers).filter((layer) => isLayerConflict(layer, pairLayer))
            : [];
        const pairExposureUsd = roundTo(
          atomicPairedSignals.reduce(
            (sum, signal) => sum + this.estimateSignalExposureUsd(signal),
            0
          ),
          4
        );
        const effectivePairMaxExposure = this.getEffectiveGlobalMaxExposure();
        const exceedsGlobalLimit =
          simulatedExposure.totalUsd + pairExposureUsd > effectivePairMaxExposure;

        if (conflictingLayers.length > 0) {
          for (const signal of atomicPairedSignals) {
            this.recordSkippedSignal({
              signal,
              filterReason: 'layer_conflict',
              details: `Layer ${pairLayer} conflicts with active market layers ${conflictingLayers.join(', ')}.`,
              context: {
                marketId: market.marketId,
                existingLayers: conflictingLayers,
                requestedLayer: pairLayer,
              },
            });
          }
        } else if (exceedsGlobalLimit) {
          for (const signal of atomicPairedSignals) {
            this.recordSkippedSignal({
              signal,
              filterReason: 'global_exposure_limit',
              details: `Global exposure cap ${effectivePairMaxExposure.toFixed(2)} would be exceeded by paired arbitrage entry.`,
              context: {
                marketId: market.marketId,
                totalExposureUsd: simulatedExposure.totalUsd,
                requestedExposureUsd: pairExposureUsd,
                maxExposureUsd: effectivePairMaxExposure,
              },
            });
          }
        } else {
          allowed.push(...atomicPairedSignals);
          plannedLayers.add(pairLayer);
          this.addExposureToLayer(simulatedExposure, pairLayer, pairExposureUsd);
        }
      }
    }

    for (const signal of signals) {
      if (isAtomicPairedArbExecutionCandidate(signal)) {
        continue;
      }

      if (this.shouldDeferSniperScalpExitForMakerAsk(market, signal)) {
        this.recordSkippedSignal({
          signal,
          filterReason: 'MM_MAKER_FIRST',
          details: `Deferred sniper scalp exit for ${config.sniper.makerExitGraceMs}ms to give post-sniper MM ask a maker-first fill window.`,
          context: {
            marketId: market.marketId,
            outcome: signal.outcome,
            graceMs: config.sniper.makerExitGraceMs,
          },
        });
        continue;
      }

      if (!this.isEntrySignal(signal)) {
        allowed.push(signal);
        continue;
      }

      const requestedLayer = this.resolveSignalLayer(signal);
      const conflictingLayers =
        config.LAYER_CONFLICT_RESOLUTION === 'BLOCK'
          ? Array.from(plannedLayers).filter((layer) => isLayerConflict(layer, requestedLayer))
          : [];
      if (conflictingLayers.length > 0) {
        this.recordSkippedSignal({
          signal,
          filterReason: 'layer_conflict',
          details: `Layer ${requestedLayer} conflicts with active market layers ${conflictingLayers.join(', ')}.`,
          context: {
            marketId: market.marketId,
            existingLayers: conflictingLayers,
            requestedLayer,
          },
        });
        continue;
      }

      const requestedExposureUsd = this.estimateSignalExposureUsd(signal);
      const effectiveMaxExposure = this.getEffectiveGlobalMaxExposure();
      if (
        simulatedExposure.totalUsd + requestedExposureUsd >
        effectiveMaxExposure
      ) {
        this.recordSkippedSignal({
          signal,
          filterReason: 'global_exposure_limit',
          details: `Global exposure cap ${effectiveMaxExposure.toFixed(2)} would be exceeded by this entry.`,
          context: {
            marketId: market.marketId,
            totalExposureUsd: simulatedExposure.totalUsd,
            requestedExposureUsd,
            maxExposureUsd: effectiveMaxExposure,
          },
        });
        continue;
      }

      allowed.push(signal);
      plannedLayers.add(requestedLayer);
      this.addExposureToLayer(simulatedExposure, requestedLayer, requestedExposureUsd);
    }

    return allowed;
  }

  private shouldDeferSniperScalpExitForMakerAsk(
    market: MarketCandidate,
    signal: StrategySignal
  ): boolean {
    if (
      config.sniper.makerExitGraceMs <= 0 ||
      signal.signalType !== 'SNIPER_SCALP_EXIT' ||
      signal.action !== 'SELL' ||
      !signal.reduceOnly ||
      !signal.reason.startsWith('Sniper scalp exit:')
    ) {
      return false;
    }

    const key = this.getPostSniperMakerAskKey(market.marketId, signal.outcome);
    const startedAtMs = this.postSniperMakerAskStartedAt.get(key);
    if (!startedAtMs) {
      return false;
    }

    if (Date.now() - startedAtMs > config.sniper.makerExitGraceMs) {
      this.postSniperMakerAskStartedAt.delete(key);
      return false;
    }

    return true;
  }

  private notePostSniperMakerAskSignal(
    marketId: string,
    outcome: StrategySignal['outcome'],
    nowMs: number
  ): void {
    const key = this.getPostSniperMakerAskKey(marketId, outcome);
    const startedAtMs = this.postSniperMakerAskStartedAt.get(key);
    if (startedAtMs && nowMs - startedAtMs <= config.sniper.makerExitGraceMs) {
      return;
    }

    this.postSniperMakerAskStartedAt.set(key, nowMs);
  }

  private clearPostSniperMakerAskSignal(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): void {
    this.postSniperMakerAskStartedAt.delete(
      this.getPostSniperMakerAskKey(marketId, outcome)
    );
  }

  private getPostSniperMakerAskKey(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): string {
    return `${marketId}:${outcome}`;
  }

  private sortExecutionCandidatesByLayerPriority(
    candidates: readonly SignalExecutionCandidate[]
  ): SignalExecutionCandidate[] {
    return [...candidates].sort((left, right) => {
      const leftPriority = this.getExecutionPriority(left.signal);
      const rightPriority = this.getExecutionPriority(right.signal);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      if (left.signal.priority !== right.signal.priority) {
        return left.signal.priority - right.signal.priority;
      }

      return left.signal.generatedAt ?? 0 - (right.signal.generatedAt ?? 0);
    });
  }

  private getExecutionPriority(signal: StrategySignal): number {
    if (signal.reduceOnly) {
      return 0;
    }

    switch (this.resolveSignalLayer(signal)) {
      case 'PAIRED_ARB':
        return 1;
      case 'SNIPER':
        return 2;
      case 'MM_QUOTE':
        return 3;
      case 'LOTTERY':
        return 4;
      default:
        return 5;
    }
  }

  private isEntrySignal(signal: StrategySignal): boolean {
    return signal.action === 'BUY' && !signal.reduceOnly;
  }

  private resolveSignalLayer(
    signal: Pick<StrategySignal, 'signalType' | 'strategyLayer'>
  ): StrategyLayer {
    return signal.strategyLayer ?? resolveStrategyLayer(signal.signalType);
  }

  private estimateSignalExposureUsd(signal: StrategySignal): number {
    const referencePrice =
      signal.targetPrice ??
      signal.referencePrice ??
      signal.tokenPrice ??
      signal.midPrice ??
      signal.fairValue ??
      0.5;
    return roundTo(Math.max(0, signal.shares) * Math.max(0, referencePrice), 4);
  }

  private addExposureToLayer(
    exposure: LayerExposureAccumulator,
    layer: StrategyLayer,
    amountUsd: number
  ): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return;
    }

    switch (layer) {
      case 'SNIPER':
        exposure.sniperUsd = roundTo(exposure.sniperUsd + amountUsd, 4);
        break;
      case 'MM_QUOTE':
        exposure.mmUsd = roundTo(exposure.mmUsd + amountUsd, 4);
        break;
      case 'PAIRED_ARB':
        exposure.pairedArbUsd = roundTo(exposure.pairedArbUsd + amountUsd, 4);
        break;
      case 'LOTTERY':
        exposure.lotteryUsd = roundTo(exposure.lotteryUsd + amountUsd, 4);
        break;
      case 'OBI':
        exposure.obiUsd = roundTo(exposure.obiUsd + amountUsd, 4);
        break;
    }

    exposure.totalUsd = roundTo(
      exposure.sniperUsd +
        exposure.mmUsd +
        exposure.pairedArbUsd +
        exposure.lotteryUsd +
        exposure.obiUsd,
      4
    );
  }

  private getActiveLayersForMarket(
    marketId: string,
    positionManager: PositionManager
  ): StrategyLayer[] {
    const layers = new Set<StrategyLayer>(positionManager.getActivePositionLayers());
    if (this.quotingEngine.hasActiveMMMarket(marketId)) {
      layers.add('MM_QUOTE');
    }
    return Array.from(layers);
  }

  private collectLayerRuntimeSummary(
    pendingQuoteExposure: PendingQuoteExposureSnapshot = this.getPendingQuoteExposure()
  ): {
    readonly strategyLayers: readonly RuntimeLayerStatusSnapshot[];
    readonly globalExposure: RuntimeGlobalExposureSnapshot;
  } {
    const base = new Map<StrategyLayer, RuntimeLayerStatusSnapshot>([
      [
        'SNIPER',
        {
          layer: 'SNIPER',
          enabled: config.SNIPER_MODE_ENABLED,
          status: config.SNIPER_MODE_ENABLED ? 'WATCHING' : 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
      ],
      [
        'MM_QUOTE',
        {
          layer: 'MM_QUOTE',
          enabled: config.MARKET_MAKER_MODE && isDynamicQuotingEnabled(config),
          status:
            config.MARKET_MAKER_MODE && isDynamicQuotingEnabled(config) ? 'WATCHING' : 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
      ],
      [
        'PAIRED_ARB',
        {
          layer: 'PAIRED_ARB',
          enabled: config.PAIRED_ARB_ENABLED,
          status: config.PAIRED_ARB_ENABLED ? 'WATCHING' : 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
      ],
      [
        'LOTTERY',
        {
          layer: 'LOTTERY',
          enabled: config.lottery.enabled,
          status: config.lottery.enabled ? 'WATCHING' : 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
      ],
      [
        'OBI',
        {
          layer: 'OBI',
          enabled: config.obiEngine.enabled,
          status: config.obiEngine.enabled
            ? config.obiEngine.shadowMode
              ? 'WATCHING'
              : 'ACTIVE'
            : 'OFF',
          positionCount: 0,
          marketCount: 0,
          exposureUsd: 0,
          pnlUsd: 0,
        },
      ],
    ]);
    const layerMarkets = new Map<StrategyLayer, Set<string>>([
      ['SNIPER', new Set<string>()],
      ['MM_QUOTE', new Set<string>()],
      ['PAIRED_ARB', new Set<string>()],
      ['LOTTERY', new Set<string>()],
      ['OBI', new Set<string>()],
    ]);

    for (const [marketId, positionManager] of this.positions.entries()) {
      const snapshot = positionManager.getSnapshot();
      if (snapshot.grossExposureShares <= 0) {
        continue;
      }

      for (const outcome of ['YES', 'NO'] as const) {
        const shares = positionManager.getShares(outcome);
        if (shares <= 0) {
          continue;
        }

        const layer = this.resolveOutcomeLayer(marketId, positionManager, outcome);
        const markPrice = this.resolveOutcomeMarkPrice(marketId, positionManager, outcome, snapshot);
        const exposureUsd = roundTo(shares * markPrice, 4);
        const pnlUsd = positionManager.getOutcomeTotalPnl(outcome);
        const existing = base.get(layer);
        if (!existing) {
          continue;
        }

        base.set(layer, {
          ...existing,
          status: existing.enabled ? 'ACTIVE' : 'OFF',
          positionCount: existing.positionCount + 1,
          exposureUsd: roundTo(existing.exposureUsd + exposureUsd, 4),
          pnlUsd: roundTo(existing.pnlUsd + pnlUsd, 4),
        });
        layerMarkets.get(layer)?.add(marketId);
      }
    }

    const mmMarketIds = new Set(this.quotingEngine.getActiveMMMarketIds());
    const mmLayer = base.get('MM_QUOTE');
    if (mmLayer && mmLayer.enabled && mmLayer.status !== 'ACTIVE' && mmMarketIds.size > 0) {
      base.set('MM_QUOTE', {
        ...mmLayer,
        status: 'ACTIVE',
      });
    }
    const mmMarkets = layerMarkets.get('MM_QUOTE');
    if (mmMarkets) {
      for (const marketId of mmMarketIds) {
        mmMarkets.add(marketId);
      }
    }

    if (pendingQuoteExposure.grossExposureUsd > 0 && mmLayer) {
      const current = base.get('MM_QUOTE') ?? mmLayer;
      base.set('MM_QUOTE', {
        ...current,
        status: current.enabled ? 'ACTIVE' : 'OFF',
        exposureUsd: roundTo(current.exposureUsd + pendingQuoteExposure.grossExposureUsd, 4),
      });
    }

    const strategyLayers = (
      ['SNIPER', 'MM_QUOTE', 'PAIRED_ARB', 'LOTTERY', 'OBI'] as const
    ).map((layer) => {
      const snapshot = base.get(layer)!;
      return {
        ...snapshot,
        marketCount: layerMarkets.get(layer)?.size ?? 0,
      } satisfies RuntimeLayerStatusSnapshot;
    });

    return {
      strategyLayers,
      globalExposure: {
        sniperUsd: strategyLayers.find((entry) => entry.layer === 'SNIPER')?.exposureUsd ?? 0,
        mmUsd: strategyLayers.find((entry) => entry.layer === 'MM_QUOTE')?.exposureUsd ?? 0,
        pairedArbUsd:
          strategyLayers.find((entry) => entry.layer === 'PAIRED_ARB')?.exposureUsd ?? 0,
        lotteryUsd:
          strategyLayers.find((entry) => entry.layer === 'LOTTERY')?.exposureUsd ?? 0,
        obiUsd: strategyLayers.find((entry) => entry.layer === 'OBI')?.exposureUsd ?? 0,
        totalUsd: roundTo(
          strategyLayers.reduce((sum, entry) => sum + entry.exposureUsd, 0),
          4
        ),
        maxUsd: config.GLOBAL_MAX_EXPOSURE_USD,
      },
    };
  }

  private getGlobalExposure(
    pendingQuoteExposure: PendingQuoteExposureSnapshot = this.getPendingQuoteExposure()
  ): RuntimeGlobalExposureSnapshot {
    return this.collectLayerRuntimeSummary(pendingQuoteExposure).globalExposure;
  }

  private resolveOutcomeLayer(
    marketId: string,
    positionManager: PositionManager,
    outcome: 'YES' | 'NO'
  ): StrategyLayer {
    const layer = positionManager.getPositionLayer(outcome);
    if (layer) {
      return layer;
    }

    return this.quotingEngine.hasActiveMMMarket(marketId) ? 'MM_QUOTE' : 'SNIPER';
  }

  private resolveOutcomeMarkPrice(
    marketId: string,
    positionManager: PositionManager,
    outcome: 'YES' | 'NO',
    snapshot: ReturnType<PositionManager['getSnapshot']>
  ): number {
    const orderbook =
      this.latestBooks.get(marketId) ?? this.quotingEngine.getContext(marketId)?.orderbook;
    const book = outcome === 'YES' ? orderbook?.yes : orderbook?.no;
    const fallbackEntryPrice =
      outcome === 'YES' ? snapshot.yesAvgEntryPrice : snapshot.noAvgEntryPrice;
    return (
      normalizeRuntimeNumber(book?.midPrice) ??
      normalizeRuntimeNumber(book?.bestBid) ??
      fallbackEntryPrice ??
      positionManager.getAvgEntryPrice(outcome) ??
      0.5
    );
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
    const pendingQuoteExposure = this.getPendingQuoteExposure();
    const layerSummary = this.collectLayerRuntimeSummary(pendingQuoteExposure);
    const walletCashUsd =
      typeof this.walletFundsSnapshot.walletCashUsd === 'number' &&
      Number.isFinite(this.walletFundsSnapshot.walletCashUsd)
        ? roundTo(this.walletFundsSnapshot.walletCashUsd, 2)
        : null;
    const openPositionValueUsd = roundTo(
      openPositions.reduce((sum, position) => sum + position.markValueUsd, 0),
      2
    );
    const portfolioValueUsd =
      walletCashUsd !== null ? roundTo(walletCashUsd + openPositionValueUsd, 2) : null;
    const availableToTradeUsd =
      walletCashUsd !== null
        ? roundTo(Math.max(0, walletCashUsd - pendingQuoteExposure.grossExposureUsd), 2)
        : null;
    this.resetRedeemPnlDayIfNeeded();
    this.pruneBlockedExitRemainders();
    this.pruneDustAbandonedPositions();
    const exitRemainderSummary = this.getBlockedExitRemainderSummary();
    writeRuntimeStatus(
      {
        running: this.running && !this.stopping,
        mode: resolveRuntimeMode(config),
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
        dustAbandonedCount: this.dustAbandonedPositions.size,
        dustAbandonedKeys: Array.from(this.dustAbandonedPositions).slice(0, 10),
        blockedExitRemainderShares: exitRemainderSummary.blockedExitRemainderShares,
        lastSignals: this.recentSignals,
        recentSkippedSignals: this.recentSkippedSignals,
        averageLatencyMs: this.getAverageLatencyMs(),
        latencyPaused: this.latencyPaused,
        latencyPauseAverageMs: this.getLatencyPauseAverageMs(),
        apiCircuitBreakers: this.getApiCircuitBreakers(),
        portfolioValueUsd,
        walletCashUsd,
        availableToTradeUsd,
        activeMarkets: this.buildRuntimeMarketSnapshots(),
        openPositions,
        openPositionsCount: openPositions.length,
        strategyLayers: layerSummary.strategyLayers,
        globalExposure: layerSummary.globalExposure,
        sniperStats: this.signalEngine.getSniperStats(),
        lotteryStats: this.lotteryEngine.getStats(),
        mmEnabled: isDynamicQuotingEnabled(config),
        mmAutonomousQuotes: config.MM_AUTONOMOUS_QUOTES,
        mmQuoteShares: config.MM_QUOTE_SHARES,
        mmMaxQuoteShares: config.MM_MAX_QUOTE_SHARES,
        mmMaxGrossExposure: config.MM_MAX_GROSS_EXPOSURE_USD,
        mmCurrentExposure: this.quotingEngine.getCurrentMMExposureUsd(),
        mmPendingExposure: pendingQuoteExposure.grossExposureUsd,
        mmPendingYesShares: pendingQuoteExposure.yesShares,
        mmPendingNoShares: pendingQuoteExposure.noShares,
        mmActiveMarkets: countActiveMMMarkets(this.quotingEngine),
        mmMaxConcurrentMarkets: config.MM_MAX_CONCURRENT_MARKETS,
        mmSlotWarmupMs: config.MM_SLOT_WARMUP_MS,
        mmOpeningSeedWindowMs: config.MM_OPENING_SEED_WINDOW_MS,
        mmStopNewEntriesBeforeEndMs: config.MM_STOP_NEW_ENTRIES_BEFORE_END_MS,
        mmCancelAllQuotesBeforeEndMs: config.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS,
        mmInventorySkew: config.MM_INVENTORY_SKEW_FACTOR,
        mmMaxNetDirectional: config.MM_MAX_NET_DIRECTIONAL,
        mmQuotes: this.buildRuntimeMmQuoteSnapshots(),
        obiStats: config.obiEngine.enabled
          ? this.obiEngine.getSessionStats(
              config.obiEngine,
              this.compounder.getSnapshot()?.drawdownGuardActive ?? false,
              this.compounder.enabled
                ? this.compounder.getObiSizeMultiplier(config.obiEngine.obiCompoundThresholdUsd)
                : 1.0
            )
          : null,
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

  /**
   * Clears local runtime inventory state for a market after redeem settlement
   * or wallet reconciliation confirms the position no longer exists on-chain.
   */
  private clearPositionStateForMarket(marketId: string): void {
    const market = this.markets.get(marketId);
    this.lotteryEngine.recordExit(marketId, 'YES');
    this.lotteryEngine.recordExit(marketId, 'NO');
    this.positions.delete(marketId);
    this.latestBooks.delete(marketId);
    this.orderBookImbalance.clearState(marketId);
    this.obiEngine.clearState(marketId);
    this.marketActions.delete(marketId);
    this.clearDustAbandonmentForMarket(marketId);
    // Variant A4: drop any tracked resting OBI maker orders for this market.
    this.restingObiMakerOrders.delete(this.getRestingObiKey(marketId, 'YES'));
    this.restingObiMakerOrders.delete(this.getRestingObiKey(marketId, 'NO'));
    this.clearSettlementConfirmation(marketId, 'YES');
    this.clearSettlementConfirmation(marketId, 'NO');
    if (market) {
      this.executor.invalidateOutcomeBalanceCache(market.yesTokenId);
      this.executor.invalidateOutcomeBalanceCache(market.noTokenId);
    }
  }

  /**
   * Clears all locally tracked market state associated with a settled condition.
   */
  private clearPositionStateForCondition(conditionId: string): string[] {
    const clearedMarketIds = new Set<string>();
    for (const market of this.markets.values()) {
      if (market.conditionId !== conditionId) {
        continue;
      }

      this.clearPositionStateForMarket(market.marketId);
      clearedMarketIds.add(market.marketId);
    }

    if (clearedMarketIds.size === 0 && this.positions.has(conditionId)) {
      this.clearPositionStateForMarket(conditionId);
      clearedMarketIds.add(conditionId);
    }

    return Array.from(clearedMarketIds.values());
  }

  private findTrackedMarketByConditionId(conditionId: string): MarketCandidate | null {
    for (const market of this.markets.values()) {
      if (market.conditionId === conditionId) {
        return market;
      }
    }

    return null;
  }

  /**
   * Reconciles locally tracked live positions with actual conditional-token
   * balances and removes stale zero-balance ghosts from the dashboard/runtime.
   */
  private async reconcileLivePositionsWithWallet(force = false): Promise<void> {
    if (
      (!force && (isDryRunMode(config) || isPaperTradingEnabled(config))) ||
      this.positions.size === 0
    ) {
      return;
    }

    for (const [marketId, positionManager] of Array.from(this.positions.entries())) {
      const snapshot = positionManager.getSnapshot();
      if (snapshot.grossExposureShares <= 0) {
        this.clearPositionStateForMarket(marketId);
        continue;
      }

      const market = this.markets.get(marketId);
      if (!market) {
        continue;
      }

      try {
        const [yesBalance, noBalance] = await Promise.all([
          this.executor.getOutcomeTokenBalance(market.yesTokenId),
          this.executor.getOutcomeTokenBalance(market.noTokenId),
        ]);
        const normalizedYesBalance = roundTo(Math.max(0, yesBalance), 4);
        const normalizedNoBalance = roundTo(Math.max(0, noBalance), 4);
        if (
          normalizedYesBalance <= LIVE_POSITION_RECONCILIATION_EPSILON &&
          normalizedNoBalance <= LIVE_POSITION_RECONCILIATION_EPSILON
        ) {
          if (this.hasPendingSettlementConfirmationForSnapshot(marketId, snapshot)) {
            logger.debug(
              'Skipped stale live position cleanup while token settlement confirmation is active',
              {
                marketId,
                conditionId: market.conditionId,
                localYesShares: snapshot.yesShares,
                localNoShares: snapshot.noShares,
                walletYesShares: normalizedYesBalance,
                walletNoShares: normalizedNoBalance,
              }
            );
            continue;
          }

          logger.info('Cleared stale live position after wallet balance reconciliation', {
            marketId,
            conditionId: market.conditionId,
            localYesShares: snapshot.yesShares,
            localNoShares: snapshot.noShares,
            walletYesShares: normalizedYesBalance,
            walletNoShares: normalizedNoBalance,
          });
          this.clearPositionStateForMarket(marketId);
        }
      } catch (error: any) {
        logger.debug('Live position reconciliation skipped due to balance check failure', {
          marketId,
          conditionId: market.conditionId,
          message: error?.message || 'Unknown error',
        });
      }
    }
  }

  /**
   * Refreshes wallet-backed live positions so the dashboard can show holdings
   * that were opened before the current process started or outside local memory.
   */
  private async refreshWalletPositionSnapshots(force = false): Promise<void> {
    if (isDryRunMode(config) || isPaperTradingEnabled(config)) {
      this.walletPositionSnapshots = new Map();
      this.lastWalletPositionRefreshAtMs = 0;
      return;
    }

    const positionsUser = this.resolvePositionsApiUser();
    if (!positionsUser) {
      return;
    }

    const nowMs = Date.now();
    if (
      !force &&
      nowMs - this.lastWalletPositionRefreshAtMs < config.runtime.walletPositionRefreshMs
    ) {
      return;
    }

    try {
      const snapshots = await this.fetchWalletPositionSnapshots(positionsUser);
      this.walletPositionSnapshots = new Map(
        snapshots.map((snapshot) => [snapshot.marketId, snapshot] as const)
      );
      this.lastWalletPositionRefreshAtMs = nowMs;
    } catch (error: any) {
      logger.debug('Wallet position snapshot refresh failed', {
        positionsUser,
        message: error?.message || 'Unknown error',
      });
    }
  }

  private async refreshWalletFundsSnapshot(force = false): Promise<void> {
    if (isDryRunMode(config) || isPaperTradingEnabled(config)) {
      this.walletFundsSnapshot = {
        walletCashUsd: null,
        updatedAt: null,
      };
      this.lastWalletFundsRefreshAtMs = 0;
      return;
    }

    const nowMs = Date.now();
    if (
      !force &&
      nowMs - this.lastWalletFundsRefreshAtMs < config.runtime.walletFundsRefreshMs
    ) {
      return;
    }

    try {
      const walletCashUsd = await this.executor.getUsdcBalance(false);
      const validBalance =
        typeof walletCashUsd === 'number' && Number.isFinite(walletCashUsd)
          ? roundTo(walletCashUsd, 2)
          : null;
      this.walletFundsSnapshot = {
        walletCashUsd: validBalance,
        updatedAt: new Date(nowMs).toISOString(),
      };
      this.lastWalletFundsRefreshAtMs = nowMs;

      // Recalculate compounding sizes on every balance refresh
      if (this.compounder.enabled && validBalance !== null && validBalance > 0) {
        this.compounder.recalculate(validBalance);
      }
    } catch (error) {
      logger.debug('Wallet funds snapshot refresh failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Returns the wallet address that should be used for live position polling.
   */
  private resolvePositionsApiUser(): string | null {
    const funderAddress = String(config.auth.funderAddress || '').trim();
    return funderAddress || null;
  }

  /**
   * Fetches open wallet positions from Polymarket's positions API and converts
   * them into dashboard/runtime snapshots.
   */
  private async fetchWalletPositionSnapshots(
    positionsUser: string
  ): Promise<RuntimePositionSnapshot[]> {
    const grouped = new Map<
      string,
      {
        title: string;
        yesShares: number;
        noShares: number;
        markValueUsd: number;
        totalPnl: number;
        roiPct: number | null;
      }
    >();

    for (let page = 0; page < MAX_POSITION_PAGES; page += 1) {
      const offset = page * POSITIONS_PAGE_LIMIT;
      const url = new URL(POSITIONS_API_URL);
      url.searchParams.set('user', positionsUser.toLowerCase());
      url.searchParams.set('sizeThreshold', '0');
      url.searchParams.set('limit', String(POSITIONS_PAGE_LIMIT));
      url.searchParams.set('offset', String(offset));

      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Positions API returned ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as unknown;
      const rows = Array.isArray(payload) ? payload : [];
      for (const row of rows) {
        const normalized = normalizeWalletPositionRow(row);
        if (!normalized) {
          continue;
        }

        const existing = grouped.get(normalized.marketId) ?? {
          title: normalized.title,
          yesShares: 0,
          noShares: 0,
          markValueUsd: 0,
          totalPnl: 0,
          roiPct: null,
        };

        if (normalized.outcome === 'YES') {
          existing.yesShares = roundTo(existing.yesShares + normalized.shares, 4);
        } else {
          existing.noShares = roundTo(existing.noShares + normalized.shares, 4);
        }

        existing.title = existing.title || normalized.title;
        existing.markValueUsd = roundTo(existing.markValueUsd + normalized.markValueUsd, 4);
        existing.totalPnl = roundTo(existing.totalPnl + normalized.totalPnl, 4);
        existing.roiPct =
          normalized.roiPct !== null
            ? roundTo(
                (existing.roiPct ?? 0) + normalized.roiPct,
                4
              )
            : existing.roiPct;

        grouped.set(normalized.marketId, existing);
      }

      if (rows.length < POSITIONS_PAGE_LIMIT) {
        break;
      }
    }

    const snapshots: RuntimePositionSnapshot[] = [];
    for (const [marketId, snapshot] of grouped.entries()) {
      const grossExposureShares = roundTo(snapshot.yesShares + snapshot.noShares, 4);
      if (grossExposureShares <= LIVE_POSITION_RECONCILIATION_EPSILON) {
        continue;
      }

      const roiPct =
        snapshot.roiPct !== null
          ? roundTo(snapshot.roiPct, 2)
          : snapshot.markValueUsd > 0
            ? roundTo((snapshot.totalPnl / snapshot.markValueUsd) * 100, 2)
            : null;

      snapshots.push({
        marketId,
        title: snapshot.title || marketId,
        slotStart: null,
        slotEnd: null,
        dustAbandoned: false,
        yesShares: roundTo(snapshot.yesShares, 4),
        noShares: roundTo(snapshot.noShares, 4),
        grossExposureShares,
        markValueUsd: roundTo(snapshot.markValueUsd, 2),
        unrealizedPnl: roundTo(snapshot.totalPnl, 2),
        totalPnl: roundTo(snapshot.totalPnl, 2),
        roiPct,
        updatedAt: new Date().toISOString(),
      });
    }

    return snapshots.sort((left, right) => Math.abs(right.markValueUsd) - Math.abs(left.markValueUsd));
  }

  private filterDustAbandonedSignals(
    market: MarketCandidate,
    signals: readonly StrategySignal[]
  ): StrategySignal[] {
    return signals.filter((signal) => {
      if (!signal.reduceOnly || signal.action !== 'SELL') {
        return true;
      }

      return !this.isDustAbandoned(market.marketId, signal.outcome);
    });
  }

  /**
   * Cancel any pending OBI maker quotes (OBI_MM_QUOTE_ASK / OBI_MM_QUOTE_BID)
   * for the given market+outcome BEFORE submitting an OBI exit signal.
   *
   * Why this exists: when an OBI entry fills, the engine immediately posts
   * a resting OBI_MM_QUOTE_ASK at entry+spread to capture the rebalance.
   * Polymarket CLOB locks the underlying outcome tokens as collateral for
   * that resting sell ("sum of active orders: N"). On the next tick, if
   * the book reverses and the engine emits an exit signal (HARD_STOP /
   * COLLAPSE / REBALANCE / SCALP — all containerised as OBI_REBALANCE_EXIT
   * or OBI_SCALP_EXIT), the new sell order is rejected by CLOB with
   * "balance is not enough -> balance: N, sum of active orders: N" because
   * the exact same shares are already committed to the resting maker.
   *
   * The 2026-04-08 XRP / BTC sessions reproduced this multiple times. The
   * exit eventually got through after retries, but at significantly worse
   * prices because the book moved during the retry storm.
   *
   * Fix: before any OBI exit, walk the FillTracker for pending OBI maker
   * orders on the same (marketId, outcome) and cancel them. Wait briefly
   * for CLOB to release collateral. Then proceed with the exit.
   *
   * Returns the number of orders successfully cancelled.
   */
  private getRestingObiKey(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): string {
    return `${marketId}:${outcome}`;
  }

  /** Register an OBI maker orderId as resting on CLOB. */
  private rememberRestingObiMakerOrder(params: {
    marketId: string;
    outcome: StrategySignal['outcome'];
    orderId: string;
  }): void {
    const key = this.getRestingObiKey(params.marketId, params.outcome);
    let set = this.restingObiMakerOrders.get(key);
    if (!set) {
      set = new Set<string>();
      this.restingObiMakerOrders.set(key, set);
    }
    set.add(params.orderId);
  }

  /** Drop an OBI maker orderId from the resting registry (on fill or cancel). */
  private forgetRestingObiMakerOrder(params: {
    marketId: string;
    outcome: StrategySignal['outcome'];
    orderId: string;
  }): void {
    const key = this.getRestingObiKey(params.marketId, params.outcome);
    const set = this.restingObiMakerOrders.get(key);
    if (!set) return;
    set.delete(params.orderId);
    if (set.size === 0) {
      this.restingObiMakerOrders.delete(key);
    }
  }

  /** All resting OBI maker orderIds for a (marketId, outcome). */
  private getRestingObiMakerOrderIds(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): string[] {
    const set = this.restingObiMakerOrders.get(
      this.getRestingObiKey(marketId, outcome)
    );
    return set ? Array.from(set) : [];
  }

  private async cancelPendingObiMakerQuotes(params: {
    marketId: string;
    outcome: StrategySignal['outcome'];
    triggeredBy: StrategySignal['signalType'];
    /**
     * Emergency mode (Phase 7, 2026-04-08): when true, fire all cancels in
     * parallel via Promise.allSettled and skip the post-cancel sleep entirely.
     * Used for hard-stop / collapse / cancel-all exits where every millisecond
     * of latency directly costs PnL because the book is collapsing.
     *
     * Trade-off: emergency cancels do not give CLOB time to release the
     * collateral before the cross-spread exit is submitted. The exit may
     * encounter a "sum of active orders" race and trigger retry-loop logic
     * in OrderExecutor. That's an acceptable price vs. waiting 500ms+ while
     * the price falls another 5-10 cents.
     */
    emergency?: boolean;
  }): Promise<number> {
    const emergency = params.emergency === true;
    const pending = this.fillTracker
      .getPendingOrders()
      .filter(
        (order) =>
          order.marketId === params.marketId &&
          order.outcome === params.outcome &&
          order.side === 'SELL' &&
          (order.signalType === 'OBI_MM_QUOTE_ASK' ||
            order.signalType === 'OBI_MM_QUOTE_BID')
      );

    // Variant A4 (2026-04-08): also include orderIds we tracked in our own
    // resting-orders registry that may have aged out of fillTracker.pendingOrders
    // but are still locking collateral on CLOB. Build a deduped list of orderIds
    // to cancel.
    const orderIdsToCancel = new Set<string>(pending.map((p) => p.orderId));
    for (const orderId of this.getRestingObiMakerOrderIds(
      params.marketId,
      params.outcome
    )) {
      orderIdsToCancel.add(orderId);
    }

    if (orderIdsToCancel.size === 0) {
      return 0;
    }

    // For logging purposes, build a lookup of pending order metadata by ID.
    const pendingById = new Map(pending.map((p) => [p.orderId, p]));

    const cancelOne = async (orderId: string): Promise<boolean> => {
      const order = pendingById.get(orderId);
      try {
        await this.executor.cancelOrder(orderId);
        this.fillTracker.forgetPendingOrder(orderId);
        this.forgetRestingObiMakerOrder({
          marketId: params.marketId,
          outcome: params.outcome,
          orderId,
        });
        this.clearPendingLiveOrder(
          this.getPendingOrderKey(params.marketId, params.outcome)
        );
        logger.info('Cancelled pending OBI maker quote', {
          marketId: params.marketId,
          outcome: params.outcome,
          triggeredBy: params.triggeredBy,
          cancelledOrderId: orderId,
          cancelledSignalType: order?.signalType ?? 'OBI_MM_QUOTE_REGISTRY',
          cancelledShares: order?.submittedShares,
          cancelledPrice: order?.submittedPrice,
          source: order ? 'fillTracker' : 'restingRegistry',
          emergency,
        });
        return true;
      } catch (error) {
        // Don't block the exit on a cancel failure — the placeOrder will
        // either retry past it or fail with the same balance error, which
        // is at least no worse than before this fix.
        logger.warn('Failed to cancel pending OBI maker quote', {
          marketId: params.marketId,
          outcome: params.outcome,
          triggeredBy: params.triggeredBy,
          orderId,
          emergency,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    let cancelledCount = 0;

    if (emergency) {
      // Phase 7: parallel cancels, no per-cancel await ordering, no sleep.
      // We DO still await Promise.allSettled because cancelOrder() RPCs are
      // cheap (~50-100ms) and parallelising them is much faster than the old
      // sequential N×100ms loop. The post-cancel 500ms sleep is what really
      // killed us — that's gone in emergency mode.
      const results = await Promise.allSettled(
        Array.from(orderIdsToCancel).map((orderId) => cancelOne(orderId))
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value === true) {
          cancelledCount += 1;
        }
      }
    } else {
      // Normal exit (rebalance / scalp): sequential cancel + 500ms wait, the
      // original safe path that prevents sum-of-active-orders races.
      for (const orderId of orderIdsToCancel) {
        if (await cancelOne(orderId)) {
          cancelledCount += 1;
        }
      }
      if (cancelledCount > 0) {
        // Brief pause to let CLOB release the collateral on the cancelled
        // orders. 500ms is comfortably above the observed network round-trip
        // (~50-100ms) and gives CLOB enough time to release collateral.
        await sleep(500);
      }
    }

    return cancelledCount;
  }

  /**
   * Phase 7 (2026-04-08): detect emergency OBI exits where every millisecond
   * of latency translates directly into worse fill price. We distinguish them
   * by inspecting the `reason` string set by the engine in obi-engine.ts:
   *
   *   - "OBI hard stop: pnl ..."   → position is bleeding past hardStopUsd
   *   - "OBI collapse: ratio ..."  → imbalance reversed against us
   *   - "OBI cancel-all: ..."      → slot is about to settle
   *
   * Normal exits ("OBI rebalance: ratio ..." book-healed and OBI_SCALP_EXIT
   * take-profit) keep the original safe path with 500ms collateral wait.
   */
  private isEmergencyObiExit(signal: StrategySignal): boolean {
    if (!isObiExitSignal(signal.signalType)) return false;
    const reason = signal.reason ?? '';
    return (
      reason.startsWith('OBI hard stop') ||
      reason.startsWith('OBI collapse') ||
      reason.startsWith('OBI cancel-all')
    );
  }

  private abandonPositionForRedeem(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    requestedShares: number;
    minimumShares: number;
    referencePrice: number | null;
  }): void {
    const key = this.getMarketOutcomeKey(params.market.marketId, params.signal.outcome);
    if (this.dustAbandonedPositions.has(key)) {
      return;
    }

    this.dustAbandonedPositions.add(key);
    this.signalEngine.clearSniperEntry(params.market.marketId, params.signal.outcome);
    logger.info('Position abandoned for redeem - below CLOB minimum sell size', {
      marketId: params.market.marketId,
      signalType: params.signal.signalType,
      outcome: params.signal.outcome,
      requestedShares: params.requestedShares,
      minimumShares: params.minimumShares,
      referencePrice: params.referencePrice,
      estimatedValue: roundTo(params.requestedShares * (params.referencePrice ?? 0), 4),
      reason:
        'Shares too few to sell at current price. Auto-redeem or settlement cleanup will handle the remainder.',
    });
  }

  private getMarketOutcomeKey(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): string {
    return getSettlementCooldownKey(marketId, outcome);
  }

  private isDustAbandoned(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): boolean {
    return this.dustAbandonedPositions.has(this.getMarketOutcomeKey(marketId, outcome));
  }

  private hasDustAbandonedMarket(marketId: string): boolean {
    return this.isDustAbandoned(marketId, 'YES') || this.isDustAbandoned(marketId, 'NO');
  }

  private clearDustAbandonmentForMarket(marketId: string): void {
    this.dustAbandonedPositions.delete(this.getMarketOutcomeKey(marketId, 'YES'));
    this.dustAbandonedPositions.delete(this.getMarketOutcomeKey(marketId, 'NO'));
    this.setBlockedExitRemainder(marketId, 'YES', 0);
    this.setBlockedExitRemainder(marketId, 'NO', 0);
  }

  private clearDustAbandonmentForCondition(conditionId: string): void {
    let cleared = false;
    for (const market of this.markets.values()) {
      if (market.conditionId !== conditionId) {
        continue;
      }

      this.clearDustAbandonmentForMarket(market.marketId);
      cleared = true;
    }

    if (!cleared) {
      this.clearDustAbandonmentForMarket(conditionId);
    }
  }

  private pruneBlockedExitRemainders(): void {
    for (const [key, remainder] of this.blockedExitRemainders.entries()) {
      const positionManager = this.positions.get(remainder.marketId);
      if (!positionManager || positionManager.getShares(remainder.outcome) <= 0) {
        this.blockedExitRemainders.delete(key);
      }
    }
  }

  private pruneDustAbandonedPositions(): void {
    for (const key of Array.from(this.dustAbandonedPositions)) {
      const [marketId, outcome] = key.split(':') as [string, StrategySignal['outcome']];
      const positionManager = this.positions.get(marketId);
      if (!positionManager || positionManager.getShares(outcome) <= 0) {
        this.dustAbandonedPositions.delete(key);
      }
    }
  }

  /**
   * Re-check a dust-abandoned position when a fresh orderbook is available.
   * If the current best bid * shares is large enough to clear the CLOB
   * minimum-notional gate (with safety buffer), we lift the dust-abandon
   * flag so the next OBI exit signal can fire normally.
   *
   * This is the 2026-04-08 fix for the SOL 09:35 case where price recovered
   * from $0.09 → $0.50 (5x) after we abandoned at $0.09, and we permanently
   * lost the ability to trade out of a winning position.
   */
  private recheckDustAbandonmentOnRecovery(
    market: MarketCandidate,
    orderbook: MarketOrderbookSnapshot
  ): void {
    for (const outcome of ['YES', 'NO'] as const) {
      const key = this.getMarketOutcomeKey(market.marketId, outcome);
      if (!this.dustAbandonedPositions.has(key)) continue;

      const positionManager = this.positions.get(market.marketId);
      if (!positionManager) continue;

      const shares = positionManager.getShares(outcome);
      if (shares <= 0) {
        this.dustAbandonedPositions.delete(key);
        continue;
      }

      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestBid = book.bestBid;
      if (bestBid === null || !Number.isFinite(bestBid) || bestBid <= 0) continue;

      const minimumShares = resolveMinimumTradableShares(bestBid, 0);
      // Require a 20% safety buffer above the bare minimum so that minor
      // price wiggles between this re-check and the next exit attempt don't
      // immediately re-trigger abandonment.
      const requiredShares = roundTo(minimumShares * 1.2, 4);
      if (shares >= requiredShares) {
        this.dustAbandonedPositions.delete(key);
        logger.info('Dust-abandoned position recovered — lifting flag', {
          marketId: market.marketId,
          marketTitle: market.title,
          outcome,
          shares: roundTo(shares, 4),
          bestBid,
          notional: roundTo(shares * bestBid, 4),
          minimumShares,
          requiredShares,
        });
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
    const globalExposure = this.getGlobalExposure();
    const effectiveMaxExposure = this.getEffectiveGlobalMaxExposure();
    if (globalExposure.totalUsd >= effectiveMaxExposure) {
      logger.debug('MM quote skipped', {
        marketId,
        reason: 'global_exposure_limit',
        details: {
          totalExposureUsd: globalExposure.totalUsd,
          maxExposureUsd: effectiveMaxExposure,
        },
      });
      return false;
    }

    if (config.LAYER_CONFLICT_RESOLUTION === 'BLOCK') {
      const conflictingLayers = this.getActiveLayersForMarket(marketId, positionManager).filter(
        (layer) => isLayerConflict(layer, 'MM_QUOTE')
      );
      if (conflictingLayers.length > 0) {
        logger.debug('MM quote skipped', {
          marketId,
          reason: 'layer_conflict',
          details: {
            existingLayers: conflictingLayers,
            requestedLayer: 'MM_QUOTE',
          },
        });
        return false;
      }
    }

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

  private shouldAllowFollowOnEntry(
    marketId: string,
    positionManager: PositionManager,
    signal: StrategySignal
  ): boolean {
    if (!this.isEntrySignal(signal)) {
      return true;
    }

    if (config.LAYER_CONFLICT_RESOLUTION === 'BLOCK') {
      const requestedLayer = this.resolveSignalLayer(signal);
      const conflictingLayers = this.getActiveLayersForMarket(marketId, positionManager).filter(
        (layer) => isLayerConflict(layer, requestedLayer)
      );
      if (conflictingLayers.length > 0) {
        logger.debug('Follow-on layer entry skipped', {
          marketId,
          signalType: signal.signalType,
          reason: 'layer_conflict',
          details: {
            existingLayers: conflictingLayers,
            requestedLayer,
          },
        });
        return false;
      }
    }

    const globalExposure = this.getGlobalExposure();
    const requestedExposureUsd = this.estimateSignalExposureUsd(signal);
    const effectiveMaxExposureForLayer = this.getEffectiveGlobalMaxExposure();
    if (globalExposure.totalUsd + requestedExposureUsd > effectiveMaxExposureForLayer) {
      logger.debug('Follow-on layer entry skipped', {
        marketId,
        signalType: signal.signalType,
        reason: 'global_exposure_limit',
        details: {
          totalExposureUsd: globalExposure.totalUsd,
          requestedExposureUsd,
          maxExposureUsd: effectiveMaxExposureForLayer,
        },
      });
      return false;
    }

    return true;
  }

  /**
   * Aggregates unconfirmed live quote buys so MM limits treat pending bids as
   * inventory until fills confirm or the orders disappear from tracking.
   */
  private getPendingQuoteExposure(
    marketId?: string
  ): PendingQuoteExposureSnapshot {
    let yesShares = 0;
    let noShares = 0;
    let grossExposureUsd = 0;

    for (const pending of this.fillTracker.getPendingOrders()) {
      if (marketId && pending.marketId !== marketId) {
        continue;
      }
      if (pending.side !== 'BUY' || !isQuotingSignalType(pending.signalType)) {
        continue;
      }

      const remainingShares = resolvePendingOrderRemainingShares(pending);
      if (remainingShares <= 0) {
        continue;
      }

      if (pending.outcome === 'YES') {
        yesShares += remainingShares;
      } else {
        noShares += remainingShares;
      }
      grossExposureUsd += remainingShares * pending.submittedPrice;
    }

    return {
      yesShares: roundTo(yesShares, 4),
      noShares: roundTo(noShares, 4),
      grossExposureUsd: roundTo(grossExposureUsd, 4),
    };
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

  private hasSettlementConfirmation(
    marketId: string,
    outcome: StrategySignal['outcome']
  ): boolean {
    return this.settlementStartedAt.has(getSettlementCooldownKey(marketId, outcome));
  }

  private hasPendingSettlementConfirmationForSnapshot(
    marketId: string,
    snapshot: ReturnType<PositionManager['getSnapshot']>
  ): boolean {
    return (
      (snapshot.yesShares > LIVE_POSITION_RECONCILIATION_EPSILON &&
        this.hasSettlementConfirmation(marketId, 'YES')) ||
      (snapshot.noShares > LIVE_POSITION_RECONCILIATION_EPSILON &&
        this.hasSettlementConfirmation(marketId, 'NO'))
    );
  }

  private skipReduceOnlySellForDust(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    requestedShares: number;
    minimumShares: number;
    referencePrice: number | null;
    details: string;
  }): void {
    this.setBlockedExitRemainder(
      params.market.marketId,
      params.signal.outcome,
      params.requestedShares
    );
    this.recordSkippedSignal({
      signal: params.signal,
      filterReason: 'MIN_ORDER_SIZE',
      details: params.details,
    });
    this.abandonPositionForRedeem({
      market: params.market,
      signal: params.signal,
      requestedShares: params.requestedShares,
      minimumShares: params.minimumShares,
      referencePrice: params.referencePrice,
    });
  }

  private async reconcileLiveReduceOnlySellSignal(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    tokenId: string;
    referencePrice: number | null;
  }): Promise<StrategySignal | null> {
    const latestBalance = await this.executor.getOutcomeTokenBalance(params.tokenId, true);
    const guardedSell = resolveReduceOnlySellGuard({
      signal: params.signal,
      availableShares: latestBalance,
      referencePrice: params.referencePrice,
    });

    this.setBlockedExitRemainder(
      params.market.marketId,
      params.signal.outcome,
      guardedSell.blockedRemainderShares
    );

    if (guardedSell.skip) {
      if (latestBalance > 0 && guardedSell.reason === 'below_minimum') {
        this.clearPostSniperMakerAskSignal(params.market.marketId, params.signal.outcome);
        if (params.signal.signalType === 'MM_QUOTE_ASK') {
          logger.info('MM quote skipped', {
            marketId: params.market.marketId,
            reason: 'below_minimum_size',
            details: {
              outcome: params.signal.outcome,
              walletShares: roundTo(Math.max(0, latestBalance), 4),
              minimumShares: guardedSell.minimumShares,
              referencePrice: params.referencePrice,
            },
          });
        }
        this.skipReduceOnlySellForDust({
          market: params.market,
          signal: params.signal,
          requestedShares: roundTo(Math.max(0, latestBalance), 4),
          minimumShares: guardedSell.minimumShares,
          referencePrice: params.referencePrice,
          details: `walletShares=${roundTo(Math.max(0, latestBalance), 4).toFixed(4)} minimum=${guardedSell.minimumShares.toFixed(4)}`,
        });
        this.clearSettlementConfirmation(params.market.marketId, params.signal.outcome);
        return null;
      }

      return params.signal;
    }

    if (roundTo(guardedSell.executionShares, 4) === roundTo(params.signal.shares, 4)) {
      return params.signal;
    }

    logger.info('Live reduce-only SELL clamped to wallet outcome balance', {
      marketId: params.market.marketId,
      signalType: params.signal.signalType,
      outcome: params.signal.outcome,
      requestedShares: roundTo(params.signal.shares, 4),
      executionShares: guardedSell.executionShares,
      availableShares: roundTo(Math.max(0, latestBalance), 4),
    });
    return {
      ...params.signal,
      shares: guardedSell.executionShares,
      reason: `${params.signal.reason} | clamped to wallet balance ${guardedSell.executionShares.toFixed(4)}`,
    };
  }

  private async confirmSettlementForSell(params: {
    market: MarketCandidate;
    signal: StrategySignal;
    tokenId: string;
    nowMs: number;
    referencePrice: number | null;
  }): Promise<SettledOutcomeSellExecutionResolution> {
    const key = getSettlementCooldownKey(params.market.marketId, params.signal.outcome);
    if (!this.settlementStartedAt.has(key)) {
      return {
        ready: true,
        requiredShares: getRequiredSettledShares(params.signal.shares),
        availableShares: roundTo(params.signal.shares, 4),
        executionShares: roundTo(params.signal.shares, 4),
        abandonToRedeem: false,
        minimumShares: 0,
      };
    }

    let latestBalance = 0;
    let attempts = this.settlementAttempts.get(key) ?? 0;
    let lastResolution: SettledOutcomeSellExecutionResolution | null = null;

    for (let index = 0; index < 3; index += 1) {
      const forceRefresh = index > 0;
      latestBalance = await this.executor.getOutcomeTokenBalance(params.tokenId, forceRefresh);
      attempts += 1;
      lastResolution = resolveSettledOutcomeSellExecution({
        signal: params.signal,
        availableShares: latestBalance,
        referencePrice: params.referencePrice,
      });
      if (lastResolution.ready) {
        const startedAtMs = this.settlementStartedAt.get(key) ?? params.nowMs;
        const delayMs = Math.max(0, Date.now() - startedAtMs);
        this.clearSettlementConfirmation(params.market.marketId, params.signal.outcome);
        logger.info('Token settlement confirmed after BUY fill', {
          marketId: params.market.marketId,
          outcome: params.signal.outcome,
          requiredShares: lastResolution.requiredShares,
          availableShares: lastResolution.availableShares,
          executionShares: lastResolution.executionShares,
          attempts,
          settlementDelayMs: delayMs,
        });
        return lastResolution;
      }

      if (index < 2) {
        await sleep(1_000);
      }
    }

    if (lastResolution?.abandonToRedeem) {
      this.settlementAttempts.delete(key);
      return lastResolution;
    }

    const requiredShares = getRequiredSettledShares(params.signal.shares);
    const nextCheckAtMs = Date.now() + 1_000;
    this.settlementCooldowns.set(key, nextCheckAtMs);
    this.settlementAttempts.set(key, attempts);
    const nextCheckAt = new Date(nextCheckAtMs).toISOString();
    if (params.signal.signalType === 'MM_QUOTE_ASK' && attempts <= 3) {
      logger.info('MM quote skipped', {
        marketId: params.market.marketId,
        reason: 'waiting_for_settlement',
        details: {
          outcome: params.signal.outcome,
          requiredShares,
          availableShares: roundTo(latestBalance, 4),
          nextCheckAt,
        },
      });
    } else {
      logger.debug('SELL deferred: waiting for settled token balance after BUY fill', {
        marketId: params.market.marketId,
        signalType: params.signal.signalType,
        outcome: params.signal.outcome,
        requiredShares,
        availableShares: roundTo(latestBalance, 4),
        attempts,
        nextCheckAt,
      });
    }
    return {
      ready: false,
      requiredShares,
      availableShares: roundTo(latestBalance, 4),
      executionShares: 0,
      abandonToRedeem: false,
      minimumShares: resolveMinimumTradableShares(params.referencePrice ?? Number.NaN, 0),
    };
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

  private writeSlotReportSnapshot(slotKey: string): void {
    printSlotReport(slotKey);
    this.recordRuntimeSlotReport(slotKey);
    this.notifyProductTestSlotReport(slotKey);
  }

  private maybePrintSlotReport(slotKey: string): void {
    if (!this.pendingSlotReports.has(slotKey) || this.printedSlotReports.has(slotKey)) {
      return;
    }

    this.writeSlotReportSnapshot(slotKey);
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

      this.writeSlotReportSnapshot(slotKey);
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

  private applySniperCorrelationFilter(
    market: MarketCandidate,
    signals: StrategySignal[],
    suppressDirectionalEntries: boolean
  ): StrategySignal[] {
    const allowed = filterSignalsForSniperCorrelationLimit(
      signals,
      suppressDirectionalEntries
    );
    if (!suppressDirectionalEntries) {
      return allowed;
    }

    const allowedSet = new Set(allowed);
    for (const blockedSignal of signals) {
      if (!allowedSet.has(blockedSignal)) {
        this.recordSkippedSignal({
          signal: blockedSignal,
          filterReason: 'SNIPER_CORRELATED_LIMIT',
          details: 'Skipped because higher-edge same-direction sniper candidates already consumed the slot capacity',
        });
      }
    }

    if (allowed.length < signals.length) {
      logger.debug('Sniper correlated risk limit suppressed legacy entry signals', {
        marketId: market.marketId,
        original: signals.length,
        remaining: allowed.length,
        blocked: signals.length - allowed.length,
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
          if (
            signal.signalType === 'LATENCY_MOMENTUM_BUY' ||
            signal.signalType === 'SNIPER_BUY' ||
            signal.signalType === 'SNIPER_SCALP_EXIT'
          ) {
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
    if (!coin) {
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

  private getBinanceVelocityPctPerSec(market: MarketCandidate): number | null {
    if (!config.SNIPER_MODE_ENABLED) {
      return null;
    }

    const coin = extractCoinFromTitle(market.title);
    if (!coin) {
      return null;
    }

    return this.binanceEdge.getVelocityPctPerSec(coin, config.sniper.velocityWindowMs);
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

    recordSettlementPnl({
      slotKey: getSlotKey(market),
      marketId: market.marketId,
      marketTitle: market.title,
      pnl: resolution.pnl,
      outcome: resolveSlotOutcome(market, winningOutcome),
      slotStart: market.startTime,
      slotEnd: market.endTime,
    });

    this.positions.delete(market.marketId);
    this.clearDustAbandonmentForMarket(market.marketId);
    this.latestBooks.delete(market.marketId);
    this.marketActions.delete(market.marketId);
    this.writeSlotReportSnapshot(getSlotKey(market));
    const dayState = getDayPnlState();
    this.syncRuntimeStatus({
      totalDayPnl: dayState.dayPnl,
      dayDrawdown: dayState.drawdown,
    });
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
    } else if (this.hasDustAbandonedMarket(market.marketId)) {
      action = 'DUST WAIT';
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
        // Fallback to deep Binance (futures) when legacy edge (spot) is
        // unavailable — the deep integration is always connected for OBI gate.
        const deepAssessment =
          !(assessment && assessment.available) && coin && market.startTime
            ? this.deepBinance.calculateFairValue({
                coin,
                slotStartTime: market.startTime,
                polymarketMid: pmUpMid,
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
            assessment && assessment.available
              ? assessment.binanceMovePct
              : deepAssessment && deepAssessment.available
                ? deepAssessment.binanceMovePct
                : null,
          binanceDirection:
            assessment && assessment.available
              ? assessment.direction
              : deepAssessment && deepAssessment.available
                ? deepAssessment.direction
                : null,
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
      .map<RuntimeMmQuoteSnapshot | null>((marketId) => {
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
        const diagnostics = this.quotingEngine.getMmDiagnostics(marketId);

        return {
          marketId,
          title: market.title,
          coin: extractCoinFromTitle(market.title),
          bidPrice,
          askPrice,
          spread,
          phase: diagnostics?.phase ?? 'UNKNOWN',
          entryMode: diagnostics?.entryMode ?? 'OFF',
          slotAgeMs: diagnostics?.slotAgeMs ?? null,
          timeToSlotEndMs: diagnostics?.timeToSlotEndMs ?? null,
          blockedBidOutcomes: diagnostics?.blockedBidOutcomes ?? [],
          toxicityFlags: diagnostics?.toxicityFlags ?? [],
          sellabilityCliffOutcomes: diagnostics?.sellabilityCliffOutcomes ?? [],
          selectedBidSharesYes: diagnostics?.selectedBidSharesYes ?? null,
          selectedBidSharesNo: diagnostics?.selectedBidSharesNo ?? null,
          yesShares: roundTo(snapshot.yesShares, 4),
          noShares: roundTo(snapshot.noShares, 4),
          grossExposureUsd: roundTo(
            snapshot.yesShares * (orderbook.yes.midPrice ?? 0.5) +
              snapshot.noShares * (orderbook.no.midPrice ?? 0.5),
            4
          ),
          netDirectionalShares: roundTo(snapshot.yesShares - snapshot.noShares, 4),
        };
      })
      .filter((entry): entry is RuntimeMmQuoteSnapshot => entry !== null)
      .sort((left, right) => right.grossExposureUsd - left.grossExposureUsd)
      .slice(0, Math.max(4, config.MM_MAX_CONCURRENT_MARKETS));
  }

  private buildRuntimePositionSnapshots(): RuntimePositionSnapshot[] {
    const localSnapshots = Array.from(this.positions.entries())
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
          dustAbandoned: this.hasDustAbandonedMarket(marketId),
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
      .filter((entry): entry is RuntimePositionSnapshot => entry !== null);

    const merged = new Map<string, RuntimePositionSnapshot>();
    for (const walletSnapshot of this.walletPositionSnapshots.values()) {
      merged.set(walletSnapshot.marketId, walletSnapshot);
    }

    for (const localSnapshot of localSnapshots) {
      const walletSnapshot = merged.get(localSnapshot.marketId);
      if (!walletSnapshot) {
        merged.set(localSnapshot.marketId, localSnapshot);
        continue;
      }

      merged.set(localSnapshot.marketId, {
        ...localSnapshot,
        title: localSnapshot.title || walletSnapshot.title,
        yesShares: walletSnapshot.yesShares,
        noShares: walletSnapshot.noShares,
        grossExposureShares: walletSnapshot.grossExposureShares,
        markValueUsd:
          walletSnapshot.markValueUsd > 0 ? walletSnapshot.markValueUsd : localSnapshot.markValueUsd,
        unrealizedPnl: walletSnapshot.unrealizedPnl,
        totalPnl: walletSnapshot.totalPnl,
        roiPct: walletSnapshot.roiPct,
      });
    }

    return Array.from(merged.values())
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
      const currentActiveQuoteOrders = this.quotingEngine.getQuoteOrders(plan.marketId);
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
          pendingQuoteExposure: this.getPendingQuoteExposure(market.marketId),
          deepBinanceAssessment,
        },
        activeQuoteOrders: currentActiveQuoteOrders,
        currentMMExposureUsd: roundTo(
          this.quotingEngine.getCurrentMMExposureUsd() +
            this.getPendingQuoteExposure().grossExposureUsd,
          4
        ),
        behaviorState: this.quotingEngine.getMmBehaviorState(plan.marketId),
        runtimeConfig: config,
        now: new Date(),
      });
      this.quotingEngine.replaceMmDiagnostics(plan.marketId, refreshedPlan.mmDiagnostics);
      this.quotingEngine.replaceMmBehaviorState(plan.marketId, refreshedPlan.mmBehaviorState);

      const trackedPendingQuoteOrderIds = new Set(
        this.fillTracker
          .getPendingOrders()
          .filter((pending) => isQuotingSignalType(pending.signalType))
          .map((pending) => pending.orderId)
      );
      const retentionPlan = reconcileQuoteRefreshPlan({
        activeQuoteOrders: currentActiveQuoteOrders,
        refreshedSignals: refreshedPlan.signals,
        trackedPendingQuoteOrderIds,
        nowMs: Date.now(),
        minQuoteLifetimeMs: config.MM_MIN_QUOTE_LIFETIME_MS,
        repriceDeadbandTicks: config.MM_REPRICE_DEADBAND_TICKS,
      });

      const failedCancelOrders: ActiveQuoteOrder[] = [];
      for (const order of retentionPlan.staleOrders) {
        const cancelled = await this.cancelQuoteOrder(order);
        if (!cancelled) {
          failedCancelOrders.push(order);
        }
      }

      const nextActiveOrders: ActiveQuoteOrder[] = [
        ...retentionPlan.keptOrders,
        ...failedCancelOrders,
      ];

      for (const signal of retentionPlan.newSignals) {
        if (
          signal.signalType === 'MM_QUOTE_ASK' &&
          this.hasTrackedRestingMmAskOrder({
            marketId: market.marketId,
            outcome: signal.outcome,
            quoteOrders: nextActiveOrders,
          })
        ) {
          logger.info('MM quote skipped', {
            marketId: market.marketId,
            reason: 'resting_order_exists',
            details: {
              outcome: signal.outcome,
              signalType: signal.signalType,
            },
          });
          continue;
        }

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
            urgency: signal.urgency,
            placedAtMs: Date.now(),
          });
        }
      }

      this.quotingEngine.replaceQuoteOrders(refreshedPlan.marketId, nextActiveOrders);
      if (
        retentionPlan.staleOrders.length > 0 ||
        retentionPlan.newSignals.length > 0 ||
        retentionPlan.deadbandRetainedCount > 0
      ) {
        logger.info('MM quote retention', {
          marketId: refreshedPlan.marketId,
          kept: retentionPlan.keptOrders.length,
          canceled: retentionPlan.staleOrders.length,
          new: retentionPlan.newSignals.length,
          deadbandRetained: retentionPlan.deadbandRetainedCount,
          oldestQueueMs: retentionPlan.oldestQueueAgeMs ?? 0,
          phase: refreshedPlan.mmDiagnostics?.phase ?? 'UNKNOWN',
          entryMode: refreshedPlan.mmDiagnostics?.entryMode ?? 'OFF',
          slotAgeMs: refreshedPlan.mmDiagnostics?.slotAgeMs ?? null,
          timeToSlotEndMs: refreshedPlan.mmDiagnostics?.timeToSlotEndMs ?? null,
        });
      }
    });
  }

  private async cancelQuoteOrder(order: ActiveQuoteOrder): Promise<boolean> {
    try {
      await this.executor.cancelOrder(order.orderId);
      this.fillTracker.forgetPendingOrder(order.orderId);
      this.quotingEngine.forgetQuoteOrder(order.orderId);
      this.clearPendingLiveOrder(this.getPendingOrderKey(order.marketId, order.outcome));
      return true;
    } catch (error) {
      this.rememberPendingLiveOrder(this.getPendingOrderKey(order.marketId, order.outcome));
      logger.warn('Quote cancel failed; retaining local tracking', {
        orderId: order.orderId,
        marketId: order.marketId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private hasTrackedRestingMmAskOrder(params: {
    marketId: string;
    outcome: StrategySignal['outcome'];
    quoteOrders: readonly ActiveQuoteOrder[];
  }): boolean {
    if (
      params.quoteOrders.some(
        (order) =>
          order.marketId === params.marketId &&
          order.signalType === 'MM_QUOTE_ASK' &&
          order.action === 'SELL' &&
          order.outcome === params.outcome
      )
    ) {
      return true;
    }

    return this.fillTracker
      .getPendingOrders()
      .some(
        (pending) =>
          pending.marketId === params.marketId &&
          pending.signalType === 'MM_QUOTE_ASK' &&
          pending.side === 'SELL' &&
          pending.outcome === params.outcome
      );
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

const QUOTE_PRICE_EPSILON = 0.000001;
const QUOTE_SHARES_EPSILON = 0.0001;

export interface QuoteRefreshRetentionPlan {
  readonly keptOrders: readonly ActiveQuoteOrder[];
  readonly staleOrders: readonly ActiveQuoteOrder[];
  readonly newSignals: readonly StrategySignal[];
  readonly deadbandRetainedCount: number;
  readonly oldestQueueAgeMs: number | null;
}

export function reconcileQuoteRefreshPlan(params: {
  activeQuoteOrders: readonly ActiveQuoteOrder[];
  refreshedSignals: readonly StrategySignal[];
  trackedPendingQuoteOrderIds?: Iterable<string>;
  nowMs: number;
  minQuoteLifetimeMs: number;
  repriceDeadbandTicks: number;
}): QuoteRefreshRetentionPlan {
  const trackedPendingQuoteOrderIds = params.trackedPendingQuoteOrderIds
    ? new Set(params.trackedPendingQuoteOrderIds)
    : null;
  const matchedOrderIds = new Set<string>();
  const keptOrders: ActiveQuoteOrder[] = [];
  const newSignals: StrategySignal[] = [];
  let deadbandRetainedCount = 0;

  for (const signal of params.refreshedSignals) {
    const retained = findRetainedQuoteOrder({
      signal,
      activeQuoteOrders: params.activeQuoteOrders,
      matchedOrderIds,
      trackedPendingQuoteOrderIds,
      nowMs: params.nowMs,
      minQuoteLifetimeMs: params.minQuoteLifetimeMs,
      repriceDeadbandTicks: params.repriceDeadbandTicks,
    });

    if (!retained) {
      newSignals.push(signal);
      continue;
    }

    matchedOrderIds.add(retained.order.orderId);
    keptOrders.push(retained.order);
    if (retained.reason === 'deadband') {
      deadbandRetainedCount += 1;
    }
  }

  const staleOrders = params.activeQuoteOrders.filter(
    (order) => !matchedOrderIds.has(order.orderId)
  );
  const oldestQueueAgeMs =
    keptOrders.length > 0
      ? Math.max(
          0,
          params.nowMs - Math.min(...keptOrders.map((order) => order.placedAtMs))
        )
      : null;

  return {
    keptOrders,
    staleOrders,
    newSignals,
    deadbandRetainedCount,
    oldestQueueAgeMs,
  };
}

async function runWithConcurrency<T>(
  values: readonly T[],
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

function findRetainedQuoteOrder(params: {
  signal: StrategySignal;
  activeQuoteOrders: readonly ActiveQuoteOrder[];
  matchedOrderIds: ReadonlySet<string>;
  trackedPendingQuoteOrderIds: ReadonlySet<string> | null;
  nowMs: number;
  minQuoteLifetimeMs: number;
  repriceDeadbandTicks: number;
}): { order: ActiveQuoteOrder; reason: 'exact' | 'deadband' } | null {
  for (const order of params.activeQuoteOrders) {
    if (params.matchedOrderIds.has(order.orderId)) {
      continue;
    }
    if (
      params.trackedPendingQuoteOrderIds &&
      !params.trackedPendingQuoteOrderIds.has(order.orderId)
    ) {
      continue;
    }
    if (!matchesQuoteRefreshIdentity(order, params.signal)) {
      continue;
    }
    if (matchesQuoteRefreshExactly(order, params.signal)) {
      return { order, reason: 'exact' };
    }
    if (
      shouldRetainPassiveQuoteOrder({
        order,
        signal: params.signal,
        nowMs: params.nowMs,
        minQuoteLifetimeMs: params.minQuoteLifetimeMs,
        repriceDeadbandTicks: params.repriceDeadbandTicks,
      })
    ) {
      return { order, reason: 'deadband' };
    }
  }

  return null;
}

function matchesQuoteRefreshIdentity(order: ActiveQuoteOrder, signal: StrategySignal): boolean {
  return (
    order.marketId === signal.marketId &&
    order.signalType === signal.signalType &&
    order.outcome === signal.outcome &&
    order.action === signal.action &&
    order.urgency === signal.urgency
  );
}

function matchesQuoteRefreshExactly(order: ActiveQuoteOrder, signal: StrategySignal): boolean {
  return (
    nearlyEqualNullablePrice(order.targetPrice, signal.targetPrice) &&
    nearlyEqualShares(order.shares, signal.shares)
  );
}

function shouldRetainPassiveQuoteOrder(params: {
  order: ActiveQuoteOrder;
  signal: StrategySignal;
  nowMs: number;
  minQuoteLifetimeMs: number;
  repriceDeadbandTicks: number;
}): boolean {
  if (
    params.repriceDeadbandTicks <= 0 ||
    params.minQuoteLifetimeMs <= 0 ||
    params.signal.urgency !== 'passive' ||
    params.order.urgency !== 'passive' ||
    !isQuotingSignalType(params.signal.signalType) ||
    params.signal.targetPrice === null ||
    params.order.targetPrice === null ||
    !nearlyEqualShares(params.order.shares, params.signal.shares)
  ) {
    return false;
  }

  const queueAgeMs = Math.max(0, params.nowMs - params.order.placedAtMs);
  if (queueAgeMs >= params.minQuoteLifetimeMs) {
    return false;
  }

  const tick = estimateQuoteDeadbandTick(params.order.targetPrice, params.signal.targetPrice);
  const allowedDrift = tick * params.repriceDeadbandTicks + QUOTE_PRICE_EPSILON;
  return Math.abs(params.order.targetPrice - params.signal.targetPrice) <= allowedDrift;
}

function estimateQuoteDeadbandTick(currentPrice: number, nextPrice: number): number {
  return Math.max(currentPrice, nextPrice) >= 0.5 ? 0.01 : 0.005;
}

function nearlyEqualNullablePrice(
  left: number | null,
  right: number | null,
  epsilon = QUOTE_PRICE_EPSILON
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return Math.abs(left - right) <= epsilon;
}

function nearlyEqualShares(left: number, right: number, epsilon = QUOTE_SHARES_EPSILON): boolean {
  return Math.abs(left - right) <= epsilon;
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

function resolveRedeemSettlementAmounts(params: {
  redeemedShares: unknown;
  yesShares: unknown;
  noShares: unknown;
}): {
  redeemedShares: number;
  yesShares: number;
  noShares: number;
  pairedShares: number;
} {
  const redeemedShares = normalizeRedeemSettlementShares(params.redeemedShares);
  const yesShares = normalizeRedeemSettlementShares(params.yesShares);
  const noShares = normalizeRedeemSettlementShares(params.noShares);
  const pairedShares = roundTo(Math.min(yesShares, noShares), 4);

  return {
    redeemedShares,
    yesShares,
    noShares,
    pairedShares,
  };
}

function normalizeRedeemSettlementShares(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? roundTo(Math.max(0, numeric), 4) : 0;
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

export interface SettledOutcomeSellExecutionResolution {
  readonly ready: boolean;
  readonly requiredShares: number;
  readonly availableShares: number;
  readonly executionShares: number;
  readonly abandonToRedeem: boolean;
  readonly minimumShares: number;
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

export function filterSignalsForSniperCorrelationLimit(
  signals: readonly StrategySignal[],
  suppressDirectionalEntries: boolean
): StrategySignal[] {
  if (!suppressDirectionalEntries) {
    return [...signals];
  }

  return signals.filter((signal) => signal.reduceOnly || signal.action === 'SELL');
}

export function shouldBlockSniperSelectionForApiGate(params: {
  apiEntryGateOpen: boolean;
  dryRunMode: boolean;
  paperTradingEnabled: boolean;
}): boolean {
  return (
    params.apiEntryGateOpen &&
    !params.dryRunMode &&
    !params.paperTradingEnabled
  );
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

export function resolveSettledOutcomeSellExecution(params: {
  signal: Pick<StrategySignal, 'action' | 'reduceOnly' | 'shares'>;
  availableShares: number;
  referencePrice: number | null;
}): SettledOutcomeSellExecutionResolution {
  const availableShares = roundTo(Math.max(0, params.availableShares), 4);
  const requestedShares = roundTo(Math.max(0, params.signal.shares), 4);
  const requiredShares = getRequiredSettledShares(requestedShares);
  if (hasSettledOutcomeBalance(availableShares, requestedShares)) {
    return {
      ready: true,
      requiredShares,
      availableShares,
      executionShares: requestedShares,
      abandonToRedeem: false,
      minimumShares: 0,
    };
  }

  const guardedSell = resolveReduceOnlySellGuard({
    signal: params.signal,
    availableShares,
    referencePrice: params.referencePrice,
  });
  if (!guardedSell.skip && guardedSell.executionShares > 0) {
    return {
      ready: true,
      requiredShares,
      availableShares,
      executionShares: guardedSell.executionShares,
      abandonToRedeem: false,
      minimumShares: guardedSell.minimumShares,
    };
  }

  return {
    ready: false,
    requiredShares,
    availableShares,
    executionShares: 0,
    abandonToRedeem: availableShares > 0 && guardedSell.reason === 'below_minimum',
    minimumShares: guardedSell.minimumShares,
  };
}

function resolvePendingOrderRemainingShares(pending: PendingOrder): number {
  return roundTo(
    Math.max(0, pending.submittedShares - pending.filledSharesSoFar),
    4
  );
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

interface NormalizedWalletPositionRow {
  readonly marketId: string;
  readonly title: string;
  readonly outcome: 'YES' | 'NO';
  readonly shares: number;
  readonly markValueUsd: number;
  readonly totalPnl: number;
  readonly roiPct: number | null;
}

function normalizeWalletPositionRow(value: unknown): NormalizedWalletPositionRow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const marketId = String(
    record.conditionId ??
      record.condition_id ??
      record.market ??
      record.marketId ??
      record.market_id ??
      ''
  ).trim();
  const title = String(record.title ?? record.question ?? marketId).trim() || marketId;
  const shares = roundTo(
    Math.max(0, safeNumber(record.size ?? record.balance ?? record.shares, 0)),
    4
  );
  if (!marketId || shares <= LIVE_POSITION_RECONCILIATION_EPSILON) {
    return null;
  }

  const outcome = resolveWalletPositionOutcome(record);
  if (!outcome) {
    return null;
  }

  const currentPrice = safeNumber(
    record.curPrice ??
      record.cur_price ??
      record.currentPrice ??
      record.current_price ??
      record.price,
    Number.NaN
  );
  const markValueUsd = roundTo(
    Math.max(
      0,
      safeNumber(record.currentValue ?? record.current_value, Number.NaN)
    ),
    4
  );
  const fallbackMarkValueUsd =
    Number.isFinite(currentPrice) && currentPrice >= 0
      ? roundTo(shares * currentPrice, 4)
      : 0;
  const totalPnl = roundTo(
    safeNumber(
      record.cashPnl ??
        record.cash_pnl ??
        record.totalPnl ??
        record.total_pnl ??
        record.pnl,
      0
    ),
    4
  );
  const roiPct = normalizeRuntimeNumber(
    safeNumber(
      record.percentPnl ??
        record.percent_pnl ??
        record.roi ??
        record.roiPct ??
        record.roi_pct,
      Number.NaN
    )
  );

  return {
    marketId,
    title,
    outcome,
    shares,
    markValueUsd: markValueUsd > 0 ? markValueUsd : fallbackMarkValueUsd,
    totalPnl,
    roiPct: roiPct !== null ? roundTo(roiPct, 4) : null,
  };
}

function resolveWalletPositionOutcome(
  record: Record<string, unknown>
): 'YES' | 'NO' | null {
  const outcomeIndexValue = safeNumber(
    record.outcomeIndex ?? record.outcome_index,
    Number.NaN
  );
  if (outcomeIndexValue === 0) {
    return 'YES';
  }
  if (outcomeIndexValue === 1) {
    return 'NO';
  }

  const outcomeLabel = String(record.outcome ?? record.side ?? '').trim().toUpperCase();
  if (
    outcomeLabel === 'YES' ||
    outcomeLabel === 'UP' ||
    outcomeLabel === 'TRUE' ||
    outcomeLabel === 'LONG'
  ) {
    return 'YES';
  }
  if (
    outcomeLabel === 'NO' ||
    outcomeLabel === 'DOWN' ||
    outcomeLabel === 'FALSE' ||
    outcomeLabel === 'SHORT'
  ) {
    return 'NO';
  }

  return null;
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
