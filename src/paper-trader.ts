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
import { resolveStrategyLayer, type SignalType, type SignalUrgency, type StrategyLayer } from './strategy-types.js';
import type { TradeExecutionResult } from './trader.js';
import { clamp, roundTo, sleep } from './utils.js';

/* ================================================================
 * CONFIG
 * ================================================================ */

export interface PaperTraderConfig {
  readonly enabled: boolean;
  /** Virtual starting balance in USDC */
  readonly initialBalanceUsd: number;
  /** Path to JSONL trade log */
  readonly tradeLogFile: string;
  /** Maker fee rate (Polymarket: 0% for maker) */
  readonly makerFeeRate: number;
  /** Taker fee rate (Polymarket: 2% standard, 3.15% high-fee) */
  readonly takerFeeRate: number;
  /** Max seconds a pending maker order lives before expiry */
  readonly makerOrderTtlMs: number;
  /** Minimum order notional (Polymarket: $1) */
  readonly minOrderNotionalUsd: number;

  /* ---- legacy fields kept for backward compat (ignored in new logic) ---- */
  readonly simulatedLatencyMinMs: number;
  readonly simulatedLatencyMaxMs: number;
  readonly fillProbability: {
    readonly passive: number;
    readonly improve: number;
    readonly cross: number;
  };
  readonly slippageModel: {
    readonly maxSlippageTicks: number;
    readonly sizeImpactFactor: number;
  };
  readonly partialFillEnabled: boolean;
  readonly minFillRatio: number;
}

/* ================================================================
 * TRADE LOG TYPES
 * ================================================================ */

export interface PaperMakerFill {
  readonly marketId: string;
  readonly outcome: Outcome;
  readonly side: 'BUY' | 'SELL';
  readonly shares: number;
  readonly price: number;
  readonly signalType: SignalType;
  readonly strategyLayer: StrategyLayer;
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
  readonly fee: number;
  readonly wasMaker: boolean;
  readonly urgency: SignalUrgency;
  readonly fillSource: 'INSTANT_TAKER' | 'PENDING_MAKER_CROSSED' | 'PENDING_MAKER_EXPIRED' | 'NONE';
  readonly virtualBalance: number;
  readonly virtualPnl: number;
  readonly paperMode: true;
}

export interface ResolvedPaperSlot {
  readonly marketId: string;
  readonly marketTitle: string;
  readonly winningOutcome: 'YES' | 'NO';
  readonly pnl: number;
  readonly resolvedAtMs: number;
}

/* ================================================================
 * PENDING ORDER — sits in queue until book crosses the price
 * ================================================================ */

interface PendingPaperOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly marketTitle: string;
  readonly signalType: SignalType;
  readonly tokenId: string;
  readonly outcome: Outcome;
  readonly side: 'BUY' | 'SELL';
  readonly shares: number;
  readonly price: number;
  /** When the caller invoked simulateOrder (pre-latency). */
  readonly submittedAtMs: number;
  /** When the order became visible on the book (post submission latency). */
  readonly createdAtMs: number;
  /** TTL expiry — relative to createdAtMs (time live on book), not submission. */
  readonly expiresAtMs: number;
  /** How much size stood at our exact price level the moment we joined the queue (FIFO assumption). */
  readonly initialDepthAhead: number;
  /** Live queue counter — shares ahead of us at our price. Fills only when this reaches 0. */
  depthAheadShares: number;
  /** Size seen at our price on the previous tick — used to compute "eaten" volume deltas. */
  prevLevelSize: number;
  /** Submission latency actually applied (ms) — kept for diagnostics. */
  readonly submissionLatencyMs: number;
}

/* ================================================================
 * POSITION STATE
 * ================================================================ */

interface PaperPositionState {
  yes: number;
  no: number;
  yesCost: number;
  noCost: number;
  realizedPnl: number;
  totalFees: number;
  entryCount: number;
  exitCount: number;
}

/* ================================================================
 * ANALYTICS
 * ================================================================ */

export interface PaperTradingStats {
  readonly enabled: boolean;
  readonly initialBalance: number;
  readonly currentBalance: number;
  readonly totalPnl: number;
  readonly totalPnlPct: number;
  readonly totalFees: number;
  readonly totalTrades: number;
  readonly totalFills: number;
  readonly totalExpired: number;
  readonly makerFills: number;
  readonly takerFills: number;
  readonly slotsResolved: number;
  readonly winRate: number;
  readonly avgWinUsd: number;
  readonly avgLossUsd: number;
  readonly maxDrawdownUsd: number;
  readonly sharpeRatio: number | null;
  readonly pendingOrders: number;
  readonly openPositions: number;
  readonly strategyBreakdown: readonly PaperStrategyBreakdown[];
  readonly recentTrades: readonly PaperTrade[];
  readonly recentResolutions: readonly ResolvedPaperSlot[];
}

export interface PaperStrategyBreakdown {
  readonly strategy: string;
  readonly trades: number;
  readonly fills: number;
  readonly expired: number;
  readonly pnl: number;
  readonly fillRate: string;
}

/* ================================================================
 * MAIN CLASS
 * ================================================================ */

export class PaperTrader {
  private balance: number;
  private peakBalance: number;
  private maxDrawdownUsd = 0;
  private readonly positions = new Map<string, PaperPositionState>();
  private readonly pendingOrders = new Map<string, PendingPaperOrder[]>();
  private readonly tradeLog: PaperTrade[] = [];
  private readonly resolvedSlots: ResolvedPaperSlot[] = [];
  private readonly dailyReturns: number[] = [];
  private lastDayPnl = 0;
  private lastDayDate = '';
  private summaryPrinted = false;

  constructor(
    private readonly runtimeConfig: PaperTraderConfig,
    private readonly orderbookHistory: OrderbookHistory
  ) {
    this.balance = runtimeConfig.initialBalanceUsd;
    this.peakBalance = this.balance;
  }

  async ensureReady(): Promise<void> {
    const tradeLogPath = path.resolve(process.cwd(), this.runtimeConfig.tradeLogFile);
    await mkdir(path.dirname(tradeLogPath), { recursive: true });
  }

  /* ================================================================
   * SUBMIT ORDER — entry point replacing old simulateOrder
   * Taker (cross) → instant fill against book
   * Maker (passive/improve) → queue as pending, wait for cross
   * ================================================================ */
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

    // Polymarket enforces a min notional — paper used to silently accept
    // sub-dollar orders that live would bounce with a MIN_SIZE error.
    const notional = params.shares * params.price;
    if (notional < this.runtimeConfig.minOrderNotionalUsd) {
      logger.debug('Paper order below min notional — rejected', {
        marketId: params.marketId,
        signalType: params.signalType,
        shares: params.shares,
        price: params.price,
        notional: roundTo(notional, 4),
        minOrderNotionalUsd: this.runtimeConfig.minOrderNotionalUsd,
      });
      return this.buildTradeResult(params, 0, 0, 0, false);
    }

    const isTaker = params.urgency === 'cross';

    if (isTaker) {
      return this.executeTakerOrder(params);
    }

    // Maker order → add to pending queue
    return this.enqueueMakerOrder(params);
  }

  /* ================================================================
   * TICK PENDING ORDERS — called every orderbook refresh cycle
   * Checks all pending maker orders against current book state.
   * If price has crossed → fill the order (maker fee).
   * ================================================================ */
  tickPendingOrders(marketId: string, currentBook: MarketOrderbookSnapshot): PaperMakerFill[] {
    const pending = this.pendingOrders.get(marketId);
    if (!pending || pending.length === 0) return [];

    const nowMs = Date.now();
    const remaining: PendingPaperOrder[] = [];
    const fills: PaperMakerFill[] = [];

    for (const order of pending) {
      // Check expiry
      if (nowMs >= order.expiresAtMs) {
        this.logExpiredOrder(order);
        continue;
      }

      const book = order.outcome === 'YES' ? currentBook.yes : currentBook.no;

      // Advance queue position by the amount eaten at our price level since
      // the last tick. This replaces the old "crossed => instant fill" model,
      // which inflated paper fill rates by giving us priority we didn't earn.
      this.advanceQueuePosition(order, book);

      // Fill only when BOTH conditions hold:
      //   1. The book has crossed our limit (someone's marketable on the other side)
      //   2. There's nobody ahead of us at our price (depthAhead reached 0)
      const crossed = this.checkMakerOrderCrossed(order, book);

      if (crossed && order.depthAheadShares <= 0) {
        const actualFilled = this.fillMakerOrder(order, book);
        if (actualFilled > 0) {
          fills.push({
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            shares: actualFilled,
            price: order.price,
            signalType: order.signalType,
            strategyLayer: resolveStrategyLayer(order.signalType),
          });
        }
      } else {
        remaining.push(order);
      }
    }

    if (remaining.length > 0) {
      this.pendingOrders.set(marketId, remaining);
    } else {
      this.pendingOrders.delete(marketId);
    }

    return fills;
  }

  /* ================================================================
   * REVERT A MAKER FILL — Phase 44d: undo PaperTrader state when
   * runtime guard blocks a fill (e.g. max position exceeded).
   * Without this, PaperTrader balance diverges from positionManager.
   *
   * Must properly restore: shares, balance, VWAP cost basis,
   * realizedPnl (for SELL reverts), and totalFees.
   * ================================================================ */
  revertMakerFill(marketId: string, outcome: Outcome, side: 'BUY' | 'SELL', shares: number, price: number): void {
    const position = this.positions.get(marketId) ?? createEmptyPaperPosition();
    const key = outcome === 'YES' ? 'yes' : 'no';
    const costKey = outcome === 'YES' ? 'yesCost' : 'noCost';

    // Maker fee for the reverted portion (same formula as fillMakerOrder)
    const fee = roundTo(
      this.runtimeConfig.makerFeeRate * Math.min(price, 1 - price) * shares,
      6
    );

    if (side === 'BUY') {
      // Undo BUY: remove shares, refund balance, recalculate VWAP
      const prevShares = position[key];
      const prevCost = position[costKey]; // current VWAP
      const newShares = roundTo(Math.max(0, prevShares - shares), 4);

      if (newShares <= 0) {
        position[key] = 0;
        position[costKey] = 0;
      } else {
        position[key] = newShares;
        // Recalculate VWAP: remove the reverted portion's contribution.
        // totalCost = prevCost * prevShares; remove shares * price → newCost / newShares
        const totalCostBefore = prevCost * prevShares;
        const totalCostAfter = totalCostBefore - price * shares;
        position[costKey] = roundTo(Math.max(0, totalCostAfter / newShares), 6);
      }
      this.balance = roundTo(this.balance + shares * price + fee, 4);
      position.totalFees = roundTo(Math.max(0, position.totalFees - fee), 6);
      position.entryCount = Math.max(0, position.entryCount - 1);
    } else {
      // Undo SELL: add shares back, deduct proceeds, revert realizedPnl
      const costBasis = position[costKey]; // may be 0 if position was fully closed
      position[key] = roundTo(position[key] + shares, 4);
      this.balance = roundTo(this.balance - shares * price + fee, 4);
      // Revert realized PnL: the original SELL added (price - costBasis) * shares - fee
      const revertedPnl = (price - costBasis) * shares - fee;
      position.realizedPnl = roundTo(position.realizedPnl - revertedPnl, 4);
      position.totalFees = roundTo(Math.max(0, position.totalFees - fee), 6);
      position.exitCount = Math.max(0, position.exitCount - 1);
    }

    if (position.yes <= 0 && position.no <= 0 && Math.abs(position.realizedPnl) < 0.0001) {
      this.positions.delete(marketId);
    } else {
      this.positions.set(marketId, position);
    }

    logger.info('Paper maker fill REVERTED (runtime guard)', {
      marketId, outcome, side, shares, price, fee,
      balance: roundTo(this.balance, 4),
    });
  }

  /* ================================================================
   * EXPIRE ALL PENDING — called on slot end / market cleanup
   * ================================================================ */
  expirePendingOrders(marketId: string): void {
    const pending = this.pendingOrders.get(marketId);
    if (!pending || pending.length === 0) return;

    for (const order of pending) {
      this.logExpiredOrder(order);
    }
    this.pendingOrders.delete(marketId);
  }

  /* ================================================================
   * EXPIRE PENDING BUY ONLY — Phase 44d: when position cap is hit,
   * only expire BUY orders. Keep SELL/exit orders alive so the
   * position can still exit via pending maker asks.
   * ================================================================ */
  expirePendingBuyOrders(marketId: string): void {
    const pending = this.pendingOrders.get(marketId);
    if (!pending || pending.length === 0) return;

    const remaining: PendingPaperOrder[] = [];
    for (const order of pending) {
      if (order.side === 'BUY') {
        this.logExpiredOrder(order);
      } else {
        remaining.push(order);
      }
    }

    if (remaining.length > 0) {
      this.pendingOrders.set(marketId, remaining);
    } else {
      this.pendingOrders.delete(marketId);
    }
  }

  /* ================================================================
   * CANCEL PENDING — cancel a specific pending order by orderId
   * Returns true if found and cancelled.
   * ================================================================ */
  cancelPendingOrder(orderId: string): boolean {
    for (const [marketId, orders] of this.pendingOrders.entries()) {
      const idx = orders.findIndex(o => o.orderId === orderId);
      if (idx !== -1) {
        const order = orders[idx];
        orders.splice(idx, 1);
        if (orders.length === 0) {
          this.pendingOrders.delete(marketId);
        }
        logger.debug('Paper pending order cancelled', {
          orderId: order.orderId,
          signalType: order.signalType,
          price: order.price,
          shares: order.shares,
        });
        return true;
      }
    }
    return false;
  }

  /* ================================================================
   * RESOLVE SLOT — market settles, calculate final PnL
   * ================================================================ */
  resolveSlot(params: {
    marketId: string;
    marketTitle?: string;
    winningOutcome: 'YES' | 'NO';
  }): { pnl: number; yesValue: number; noValue: number } {
    // First expire any pending orders for this market
    this.expirePendingOrders(params.marketId);

    const position = this.positions.get(params.marketId);
    if (!position) {
      return { pnl: 0, yesValue: 0, noValue: 0 };
    }

    // Winning shares pay $1 each, losing shares pay $0
    const yesValue = params.winningOutcome === 'YES' ? position.yes : 0;
    const noValue = params.winningOutcome === 'NO' ? position.no : 0;
    const payout = yesValue + noValue;

    // Remaining cost basis
    const remainingCost =
      position.yes * position.yesCost + position.no * position.noCost;

    const pnl = roundTo(position.realizedPnl + payout - remainingCost, 4);

    this.balance = roundTo(this.balance + payout, 4);
    this.positions.delete(params.marketId);
    this.updateDrawdown();

    const resolved: ResolvedPaperSlot = {
      marketId: params.marketId,
      marketTitle: params.marketTitle ?? params.marketId,
      winningOutcome: params.winningOutcome,
      pnl,
      resolvedAtMs: Date.now(),
    };
    this.resolvedSlots.push(resolved);
    this.trackDailyReturn();

    logger.info('Paper slot resolved', {
      marketId: params.marketId,
      winningOutcome: params.winningOutcome,
      pnl: roundTo(pnl, 4),
      balance: roundTo(this.balance, 4),
    });

    return { pnl: roundTo(pnl, 4), yesValue: roundTo(yesValue, 4), noValue: roundTo(noValue, 4) };
  }

  /* ================================================================
   * GETTERS
   * ================================================================ */

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
    if (!position) return false;
    return position.yes > 0 || position.no > 0;
  }

  hasPendingOrders(marketId: string): boolean {
    const pending = this.pendingOrders.get(marketId);
    return !!pending && pending.length > 0;
  }

  /** Phase 43: total pending BUY shares for a market (prevents duplicate entries). */
  getPendingBuyShares(marketId: string): number {
    const pending = this.pendingOrders.get(marketId);
    if (!pending) return 0;
    return pending
      .filter(o => o.side === 'BUY')
      .reduce((sum, o) => sum + o.shares, 0);
  }

  getPendingOrderCount(): number {
    let count = 0;
    for (const orders of this.pendingOrders.values()) {
      count += orders.length;
    }
    return count;
  }

  /* ================================================================
   * STATS — comprehensive analytics for dashboard
   * ================================================================ */
  getStats(): PaperTradingStats {
    const fills = this.tradeLog.filter(t => t.filledShares > 0);
    const expired = this.tradeLog.filter(t => t.fillSource === 'PENDING_MAKER_EXPIRED');
    const makerFills = fills.filter(t => t.wasMaker);
    const takerFills = fills.filter(t => !t.wasMaker);
    const wins = this.resolvedSlots.filter(r => r.pnl > 0);
    const losses = this.resolvedSlots.filter(r => r.pnl < 0);
    const totalPnl = this.getPnL();
    const totalFees = this.tradeLog.reduce((sum, t) => sum + t.fee, 0);

    return {
      enabled: this.runtimeConfig.enabled,
      initialBalance: this.runtimeConfig.initialBalanceUsd,
      currentBalance: roundTo(this.balance, 4),
      totalPnl: roundTo(totalPnl, 4),
      totalPnlPct: this.runtimeConfig.initialBalanceUsd > 0
        ? roundTo((totalPnl / this.runtimeConfig.initialBalanceUsd) * 100, 2)
        : 0,
      totalFees: roundTo(totalFees, 4),
      totalTrades: this.tradeLog.length,
      totalFills: fills.length,
      totalExpired: expired.length,
      makerFills: makerFills.length,
      takerFills: takerFills.length,
      slotsResolved: this.resolvedSlots.length,
      winRate: this.resolvedSlots.length > 0
        ? roundTo((wins.length / this.resolvedSlots.length) * 100, 1)
        : 0,
      avgWinUsd: wins.length > 0
        ? roundTo(wins.reduce((s, w) => s + w.pnl, 0) / wins.length, 4)
        : 0,
      avgLossUsd: losses.length > 0
        ? roundTo(losses.reduce((s, l) => s + l.pnl, 0) / losses.length, 4)
        : 0,
      maxDrawdownUsd: roundTo(this.maxDrawdownUsd, 4),
      sharpeRatio: this.computeSharpe(),
      pendingOrders: this.getPendingOrderCount(),
      openPositions: this.positions.size,
      strategyBreakdown: this.computeStrategyBreakdown(),
      recentTrades: this.tradeLog.slice(-20),
      recentResolutions: this.resolvedSlots.slice(-10),
    };
  }

  /* ================================================================
   * PRINT SUMMARY — for graceful shutdown
   * ================================================================ */
  printSummary(): void {
    if (this.summaryPrinted) return;
    this.summaryPrinted = true;

    const stats = this.getStats();
    const durationMs =
      this.tradeLog.length >= 2
        ? Date.parse(this.tradeLog.at(-1)?.timestamp ?? '') -
          Date.parse(this.tradeLog[0].timestamp)
        : 0;

    console.log('');
    console.log('=== PAPER TRADING SUMMARY ===');
    console.log(
      `Duration: ${formatDuration(durationMs)} | Slots: ${stats.slotsResolved} | Trades: ${stats.totalTrades} | Fills: ${stats.totalFills} | Expired: ${stats.totalExpired}`
    );
    console.log(
      `Balance: $${stats.initialBalance.toFixed(2)} -> $${stats.currentBalance.toFixed(2)} (${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(2)}%)`
    );
    console.log(
      `Fees paid: $${stats.totalFees.toFixed(4)} | Max drawdown: $${stats.maxDrawdownUsd.toFixed(2)}`
    );
    console.log(
      `Win rate: ${stats.winRate.toFixed(1)}% (${this.resolvedSlots.filter(r => r.pnl > 0).length}W / ${this.resolvedSlots.filter(r => r.pnl < 0).length}L)`
    );
    console.log(
      `Avg win: ${formatSignedUsd(stats.avgWinUsd)} | Avg loss: ${formatSignedUsd(stats.avgLossUsd)}`
    );
    console.log(
      `Maker fills: ${stats.makerFills} | Taker fills: ${stats.takerFills} | Fill rate: ${stats.totalTrades > 0 ? roundTo((stats.totalFills / stats.totalTrades) * 100, 1) : 0}%`
    );
    if (stats.sharpeRatio !== null) {
      console.log(`Sharpe ratio: ${stats.sharpeRatio.toFixed(2)}`);
    }

    if (stats.strategyBreakdown.length > 0) {
      console.log('Strategy breakdown:');
      for (const entry of stats.strategyBreakdown) {
        console.log(
          `  ${entry.strategy.padEnd(22)} ${entry.fills}/${entry.trades} fills | ${formatSignedUsd(entry.pnl)} | expired: ${entry.expired}`
        );
      }
    }
    console.log('');
  }

  /* ================================================================
   * PRIVATE: TAKER (CROSS) EXECUTION — instant fill against book
   * ================================================================ */
  private async executeTakerOrder(params: {
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
  }): Promise<TradeExecutionResult> {
    // Submission latency: simulates the signal → exchange round-trip during
    // which the book can (and usually does) move against us. We then walk
    // against the FRESHEST available book — not the snapshot the caller
    // captured — which is how adverse selection bleeds into taker fills.
    const submissionLatencyMs = this.computeSubmissionLatencyMs();
    if (submissionLatencyMs > 0) {
      await sleep(submissionLatencyMs);
    }

    const latestSnapshot = this.orderbookHistory.getLatest(params.marketId);
    const snapshot = latestSnapshot ?? params.currentOrderbook;
    const book = params.outcome === 'YES' ? snapshot.yes : snapshot.no;

    // Walk the book to find realistic fill
    const levels = params.side === 'BUY' ? book.asks : book.bids;
    const walked = simulateOrderbookWalk(levels, params.shares, params.side);

    // Constrain by balance/inventory
    let filledShares = walked.filledShares;
    let avgPrice = walked.avgPrice;

    if (filledShares > 0 && avgPrice > 0) {
      if (params.side === 'BUY') {
        // Calculate fee: Polymarket fee = feeRate * min(price, 1-price) * shares
        const feePerShare = this.runtimeConfig.takerFeeRate * Math.min(avgPrice, 1 - avgPrice);
        const totalCost = filledShares * avgPrice + filledShares * feePerShare;
        if (totalCost > this.balance) {
          // Reduce to what we can afford
          const costPerShare = avgPrice + feePerShare;
          filledShares = costPerShare > 0 ? Math.floor(this.balance / costPerShare) : 0;
        }
      } else {
        // SELL: constrain to held shares
        const position = this.positions.get(params.marketId);
        const heldShares = params.outcome === 'YES'
          ? (position?.yes ?? 0)
          : (position?.no ?? 0);
        filledShares = Math.min(filledShares, heldShares);
      }
    }

    // Apply fee
    const fee = filledShares > 0 && avgPrice > 0
      ? roundTo(this.runtimeConfig.takerFeeRate * Math.min(avgPrice, 1 - avgPrice) * filledShares, 6)
      : 0;

    // Apply fill to position state
    if (filledShares > 0 && avgPrice > 0) {
      this.applyFill({
        marketId: params.marketId,
        outcome: params.outcome,
        side: params.side,
        shares: filledShares,
        price: avgPrice,
        fee,
        isMaker: false,
      });
    }

    // Log trade
    const trade: PaperTrade = {
      timestamp: new Date().toISOString(),
      marketId: params.marketId,
      marketTitle: params.marketTitle,
      signalType: params.signalType,
      outcome: params.outcome,
      side: params.side,
      requestedShares: roundTo(params.shares, 4),
      filledShares: roundTo(filledShares, 4),
      requestedPrice: roundTo(params.price, 6),
      fillPrice: filledShares > 0 ? roundTo(avgPrice, 6) : null,
      slippage: roundTo(walked.slippage, 6),
      fee: roundTo(fee, 6),
      wasMaker: false,
      urgency: params.urgency,
      fillSource: filledShares > 0 ? 'INSTANT_TAKER' : 'NONE',
      virtualBalance: roundTo(this.balance, 4),
      virtualPnl: roundTo(this.getPnL(), 4),
      paperMode: true,
    };
    this.tradeLog.push(trade);
    await this.appendTradeLog(trade);

    // Phase 44c: fix wasMaker — taker fills should report false (Bug 3)
    return this.buildTradeResult(params, filledShares, avgPrice, fee, false);
  }

  /* ================================================================
   * PRIVATE: MAKER ORDER ENQUEUE
   * ================================================================ */
  private async enqueueMakerOrder(params: {
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
  }): Promise<TradeExecutionResult> {
    await this.ensureReady();

    const book = params.outcome === 'YES'
      ? params.currentOrderbook.yes
      : params.currentOrderbook.no;

    // Check if the order would cross the book immediately
    // (e.g. BUY at 0.50 when bestAsk is 0.49 → instant fill as taker)
    const wouldCross = params.side === 'BUY'
      ? (book.bestAsk !== null && params.price >= book.bestAsk)
      : (book.bestBid !== null && params.price <= book.bestBid);

    if (wouldCross) {
      // Post-only would be rejected in real Polymarket. Log and return unfilled.
      if (params.postOnly) {
        logger.debug('Paper maker order would cross book (post-only rejected)', {
          signalType: params.signalType,
          side: params.side,
          price: params.price,
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
        });

        const trade: PaperTrade = {
          timestamp: new Date().toISOString(),
          marketId: params.marketId,
          marketTitle: params.marketTitle,
          signalType: params.signalType,
          outcome: params.outcome,
          side: params.side,
          requestedShares: roundTo(params.shares, 4),
          filledShares: 0,
          requestedPrice: roundTo(params.price, 6),
          fillPrice: null,
          slippage: 0,
          fee: 0,
          wasMaker: true,
          urgency: params.urgency,
          fillSource: 'NONE',
          virtualBalance: roundTo(this.balance, 4),
          virtualPnl: roundTo(this.getPnL(), 4),
          paperMode: true,
        };
        this.tradeLog.push(trade);
        await this.appendTradeLog(trade);

        return this.buildTradeResult(params, 0, 0, 0, false);
      }
    }

    // Submission latency: real orders take tens to hundreds of ms to reach the
    // book after the caller decides to submit. Paper used to skip this, which
    // (a) inflated fill rate by giving orders unrealistic queue priority and
    // (b) obscured taker adverse selection during the "in flight" window.
    const submittedAtMs = Date.now();
    const submissionLatencyMs = this.computeSubmissionLatencyMs();
    if (submissionLatencyMs > 0) {
      await sleep(submissionLatencyMs);
    }
    const createdAtMs = Date.now();

    // After latency, prefer the freshest snapshot we have. If the main loop
    // refreshed the book during the sleep, we reflect that here.
    const latestSnapshot = this.orderbookHistory.getLatest(params.marketId);
    const bookAtRest = latestSnapshot !== null
      ? (params.outcome === 'YES' ? latestSnapshot.yes : latestSnapshot.no)
      : book;

    // Re-check crossing against the post-latency book. If someone took the
    // liquidity during our submission window, we land as a passive maker
    // normally; if the book moved AGAINST us (our price no longer crosses),
    // we still enqueue as maker. This is the "slipped into maker" case.
    const ourSideLevels = params.side === 'BUY' ? bookAtRest.bids : bookAtRest.asks;
    const initialDepthAhead = findLevelSize(ourSideLevels, params.price);

    const orderId = buildPaperOrderId(params.marketId, params.signalType);
    const pendingOrder: PendingPaperOrder = {
      orderId,
      marketId: params.marketId,
      marketTitle: params.marketTitle,
      signalType: params.signalType,
      tokenId: params.tokenId,
      outcome: params.outcome,
      side: params.side,
      shares: params.shares,
      price: params.price,
      submittedAtMs,
      createdAtMs,
      expiresAtMs: createdAtMs + this.runtimeConfig.makerOrderTtlMs,
      initialDepthAhead,
      depthAheadShares: initialDepthAhead,
      prevLevelSize: initialDepthAhead,
      submissionLatencyMs,
    };

    const existing = this.pendingOrders.get(params.marketId) ?? [];
    existing.push(pendingOrder);
    this.pendingOrders.set(params.marketId, existing);

    logger.debug('Paper maker order queued', {
      orderId,
      signalType: params.signalType,
      side: params.side,
      outcome: params.outcome,
      price: params.price,
      shares: params.shares,
      ttlMs: this.runtimeConfig.makerOrderTtlMs,
      submissionLatencyMs,
      initialDepthAhead,
    });

    // Return "pending" result — not yet filled
    // The main loop should treat this as fillConfirmed=false
    return {
      orderId,
      marketId: params.marketId,
      tokenId: params.tokenId,
      outcome: params.outcome,
      side: params.side,
      shares: roundTo(params.shares, 4),
      price: roundTo(params.price, 6),
      notionalUsd: roundTo(params.shares * params.price, 2),
      filledShares: 0,
      fillPrice: null,
      fillConfirmed: false,
      simulation: true,
      wasMaker: true,
      postOnly: params.postOnly,
      orderType: params.orderType,
      balanceCacheHits: 0,
      balanceCacheMisses: 0,
      balanceCacheHitRatePct: null,
    };
  }

  /* ================================================================
   * PRIVATE: ADVANCE QUEUE POSITION
   *
   * Each tick, compare the current resting size at our price against what
   * we saw on the previous tick. If size shrank, that volume got taken
   * ahead of us → shift the queue forward. If size grew, new joiners
   * arrived behind us (FIFO) → depth unchanged. If our level disappeared
   * entirely without us filling, we assume the queue was cancelled out,
   * which puts us first when/if the level re-emerges.
   * ================================================================ */
  private advanceQueuePosition(order: PendingPaperOrder, book: TokenBookSnapshot): void {
    const levels = order.side === 'BUY' ? book.bids : book.asks;
    const currentLevelSize = findLevelSize(levels, order.price);

    const eaten = Math.max(0, order.prevLevelSize - currentLevelSize);
    if (eaten > 0) {
      order.depthAheadShares = Math.max(0, order.depthAheadShares - eaten);
    }

    // Level vanished without us filling — treat remaining queue as cancelled
    // so that on the next crossing event we're first in line.
    if (currentLevelSize === 0 && order.depthAheadShares > 0) {
      order.depthAheadShares = 0;
    }

    order.prevLevelSize = currentLevelSize;
  }

  /* ================================================================
   * PRIVATE: COMPUTE SUBMISSION LATENCY
   * Uniform random in [min, max] from config. Returns 0 if max <= 0.
   * ================================================================ */
  private computeSubmissionLatencyMs(): number {
    const min = Math.max(0, this.runtimeConfig.simulatedLatencyMinMs | 0);
    const max = Math.max(min, this.runtimeConfig.simulatedLatencyMaxMs | 0);
    if (max <= 0) return 0;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /* ================================================================
   * PRIVATE: CHECK IF MAKER ORDER IS CROSSED
   * BUY at price P fills when someone sells at P or lower (bestAsk <= P)
   * SELL at price P fills when someone buys at P or higher (bestBid >= P)
   * ================================================================ */
  private checkMakerOrderCrossed(order: PendingPaperOrder, book: TokenBookSnapshot): boolean {
    if (order.side === 'BUY') {
      // Our buy limit sits at `order.price`. It fills when the ask side
      // has resting liquidity at or below our price.
      return book.bestAsk !== null && book.bestAsk <= order.price;
    }
    // Our sell limit sits at `order.price`. It fills when bid >= our price.
    return book.bestBid !== null && book.bestBid >= order.price;
  }

  /* ================================================================
   * PRIVATE: FILL A MAKER ORDER (crossed)
   * ================================================================ */
  private fillMakerOrder(order: PendingPaperOrder, book: TokenBookSnapshot): number {
    // Maker fills at the limit price (not the crossing price)
    const fillPrice = order.price;

    // Constrain by balance (BUY) or inventory (SELL)
    let filledShares = order.shares;

    if (order.side === 'BUY') {
      // Maker fee = 0% on Polymarket
      const fee = this.runtimeConfig.makerFeeRate * Math.min(fillPrice, 1 - fillPrice) * filledShares;
      const totalCost = filledShares * fillPrice + fee;
      if (totalCost > this.balance) {
        const costPerShare = fillPrice + this.runtimeConfig.makerFeeRate * Math.min(fillPrice, 1 - fillPrice);
        filledShares = costPerShare > 0 ? Math.floor(this.balance / costPerShare) : 0;
      }
    } else {
      const position = this.positions.get(order.marketId);
      const held = order.outcome === 'YES' ? (position?.yes ?? 0) : (position?.no ?? 0);
      filledShares = Math.min(filledShares, held);
    }

    if (filledShares <= 0) {
      this.logExpiredOrder(order);
      return 0;
    }

    const fee = roundTo(
      this.runtimeConfig.makerFeeRate * Math.min(fillPrice, 1 - fillPrice) * filledShares,
      6
    );

    this.applyFill({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      shares: filledShares,
      price: fillPrice,
      fee,
      isMaker: true,
    });

    const waitMs = Date.now() - order.createdAtMs;
    const totalTimeFromSubmissionMs = Date.now() - order.submittedAtMs;

    const trade: PaperTrade = {
      timestamp: new Date().toISOString(),
      marketId: order.marketId,
      marketTitle: order.marketTitle,
      signalType: order.signalType,
      outcome: order.outcome,
      side: order.side,
      requestedShares: roundTo(order.shares, 4),
      filledShares: roundTo(filledShares, 4),
      requestedPrice: roundTo(order.price, 6),
      fillPrice: roundTo(fillPrice, 6),
      slippage: 0, // Maker always fills at limit price
      fee: roundTo(fee, 6),
      wasMaker: true,
      urgency: 'passive',
      fillSource: 'PENDING_MAKER_CROSSED',
      virtualBalance: roundTo(this.balance, 4),
      virtualPnl: roundTo(this.getPnL(), 4),
      paperMode: true,
    };
    this.tradeLog.push(trade);
    void this.appendTradeLog(trade);

    logger.info('Paper maker order FILLED', {
      orderId: order.orderId,
      signalType: order.signalType,
      side: order.side,
      outcome: order.outcome,
      price: fillPrice,
      shares: filledShares,
      fee: roundTo(fee, 6),
      submissionLatencyMs: order.submissionLatencyMs,
      waitMs,
      totalTimeFromSubmissionMs,
      initialDepthAhead: order.initialDepthAhead,
      balance: roundTo(this.balance, 4),
    });

    return filledShares;
  }

  /* ================================================================
   * PRIVATE: LOG EXPIRED ORDER
   * ================================================================ */
  private logExpiredOrder(order: PendingPaperOrder): void {
    const trade: PaperTrade = {
      timestamp: new Date().toISOString(),
      marketId: order.marketId,
      marketTitle: order.marketTitle,
      signalType: order.signalType,
      outcome: order.outcome,
      side: order.side,
      requestedShares: roundTo(order.shares, 4),
      filledShares: 0,
      requestedPrice: roundTo(order.price, 6),
      fillPrice: null,
      slippage: 0,
      fee: 0,
      wasMaker: true,
      urgency: 'passive',
      fillSource: 'PENDING_MAKER_EXPIRED',
      virtualBalance: roundTo(this.balance, 4),
      virtualPnl: roundTo(this.getPnL(), 4),
      paperMode: true,
    };
    this.tradeLog.push(trade);
    void this.appendTradeLog(trade);

    logger.debug('Paper maker order expired unfilled', {
      orderId: order.orderId,
      signalType: order.signalType,
      side: order.side,
      price: order.price,
      shares: order.shares,
      livedMs: Date.now() - order.createdAtMs,
      submissionLatencyMs: order.submissionLatencyMs,
      initialDepthAhead: order.initialDepthAhead,
      remainingDepthAhead: order.depthAheadShares,
    });
  }

  /* ================================================================
   * PRIVATE: APPLY FILL TO POSITION + BALANCE
   * ================================================================ */
  private applyFill(params: {
    marketId: string;
    outcome: Outcome;
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
    fee: number;
    isMaker: boolean;
  }): void {
    const position = this.positions.get(params.marketId) ?? createEmptyPaperPosition();
    const key = params.outcome === 'YES' ? 'yes' : 'no';
    const costKey = params.outcome === 'YES' ? 'yesCost' : 'noCost';

    if (params.side === 'BUY') {
      const previousShares = position[key];
      const nextShares = roundTo(previousShares + params.shares, 4);
      // VWAP cost basis
      const nextCost = nextShares > 0
        ? (position[costKey] * previousShares + params.price * params.shares) / nextShares
        : 0;
      position[key] = nextShares;
      position[costKey] = roundTo(nextCost, 6);
      // Deduct cost + fee from balance
      this.balance = roundTo(this.balance - params.shares * params.price - params.fee, 4);
      position.totalFees = roundTo(position.totalFees + params.fee, 6);
      position.entryCount += 1;
    } else {
      const previousShares = position[key];
      const closedShares = Math.min(previousShares, params.shares);
      // Realized PnL = (sell price - cost basis) * shares - fee
      position.realizedPnl = roundTo(
        position.realizedPnl + (params.price - position[costKey]) * closedShares - params.fee,
        4
      );
      position[key] = roundTo(Math.max(0, previousShares - closedShares), 4);
      if (position[key] <= 0) {
        position[key] = 0;
        // Phase 44e: preserve costKey (VWAP) even when shares reach 0.
        // revertMakerFill needs the original cost basis to correctly
        // undo realized PnL. Previously zeroed here, causing SELL
        // reverts after full close to read costBasis=0, producing
        // wildly wrong PnL (e.g. -1.00 instead of +1.00).
      }
      // Add proceeds to balance (fee already deducted from realizedPnl)
      this.balance = roundTo(this.balance + closedShares * params.price - params.fee, 4);
      position.totalFees = roundTo(position.totalFees + params.fee, 6);
      position.exitCount += 1;
    }

    if (position.yes <= 0 && position.no <= 0 && Math.abs(position.realizedPnl) < 0.0001) {
      this.positions.delete(params.marketId);
    } else {
      this.positions.set(params.marketId, position);
    }

    this.updateDrawdown();
  }

  /* ================================================================
   * PRIVATE: BUILD TRADE RESULT for order-executor compatibility
   * ================================================================ */
  private buildTradeResult(
    params: {
      marketId: string;
      tokenId: string;
      outcome: Outcome;
      side: 'BUY' | 'SELL';
      shares: number;
      price: number;
      orderType: OrderMode;
      postOnly: boolean;
    },
    filledShares: number,
    avgPrice: number,
    fee: number,
    wasMaker: boolean
  ): TradeExecutionResult {
    return {
      orderId: buildPaperOrderId(params.marketId, 'PAPER' as SignalType),
      marketId: params.marketId,
      tokenId: params.tokenId,
      outcome: params.outcome,
      side: params.side,
      shares: roundTo(params.shares, 4),
      price: roundTo(params.price, 6),
      notionalUsd: roundTo(params.shares * params.price, 2),
      filledShares: roundTo(filledShares, 4),
      fillPrice: filledShares > 0 ? roundTo(avgPrice, 6) : null,
      fillConfirmed: filledShares > 0,
      simulation: true,
      wasMaker: filledShares > 0 ? wasMaker : null,
      postOnly: params.postOnly,
      orderType: params.orderType,
      balanceCacheHits: 0,
      balanceCacheMisses: 0,
      balanceCacheHitRatePct: null,
    };
  }

  /* ================================================================
   * PRIVATE: ANALYTICS HELPERS
   * ================================================================ */
  private updateDrawdown(): void {
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }
    const drawdown = this.peakBalance - this.balance;
    if (drawdown > this.maxDrawdownUsd) {
      this.maxDrawdownUsd = drawdown;
    }
  }

  private trackDailyReturn(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastDayDate !== today) {
      if (this.lastDayDate !== '') {
        this.dailyReturns.push(this.getPnL() - this.lastDayPnl);
      }
      this.lastDayPnl = this.getPnL();
      this.lastDayDate = today;
    }
  }

  private computeSharpe(): number | null {
    if (this.dailyReturns.length < 3) return null;
    const mean = this.dailyReturns.reduce((s, r) => s + r, 0) / this.dailyReturns.length;
    const variance = this.dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / this.dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 0.0001) return null;
    // Annualized Sharpe (assume ~365 trading days for crypto)
    return roundTo((mean / stdDev) * Math.sqrt(365), 2);
  }

  private computeStrategyBreakdown(): PaperStrategyBreakdown[] {
    const buckets = new Map<string, { trades: number; fills: number; expired: number; pnl: number }>();

    for (const trade of this.tradeLog) {
      const key = classifySignal(trade.signalType);
      const bucket = buckets.get(key) ?? { trades: 0, fills: 0, expired: 0, pnl: 0 };
      bucket.trades += 1;
      if (trade.filledShares > 0) {
        bucket.fills += 1;
        const signedNotional = trade.side === 'BUY'
          ? -(trade.fillPrice ?? 0) * trade.filledShares - trade.fee
          : (trade.fillPrice ?? 0) * trade.filledShares - trade.fee;
        bucket.pnl = roundTo(bucket.pnl + signedNotional, 4);
      }
      if (trade.fillSource === 'PENDING_MAKER_EXPIRED') {
        bucket.expired += 1;
      }
      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .map(([strategy, b]) => ({
        strategy,
        trades: b.trades,
        fills: b.fills,
        expired: b.expired,
        pnl: roundTo(b.pnl, 4),
        fillRate: b.trades > 0 ? `${roundTo((b.fills / b.trades) * 100, 1)}%` : '0%',
      }))
      .sort((a, b) => b.trades - a.trades);
  }

  /* ================================================================
   * PRIVATE: TRADE LOG
   * ================================================================ */
  private async appendTradeLog(trade: PaperTrade): Promise<void> {
    try {
      const tradeLogPath = path.resolve(process.cwd(), this.runtimeConfig.tradeLogFile);
      await appendFile(tradeLogPath, `${JSON.stringify(trade)}\n`, 'utf8');
    } catch {
      // Non-critical
    }
  }
}

/* ================================================================
 * PURE FUNCTIONS — orderbook walk, helpers
 * ================================================================ */

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
    if (remainingShares <= 0) break;
    const availableShares = Math.max(0, level.size);
    if (availableShares <= 0) continue;

    const consumedShares = Math.min(remainingShares, availableShares);
    filledShares += consumedShares;
    totalNotional += consumedShares * level.price;
    remainingShares -= consumedShares;
  }

  if (filledShares <= 0) {
    return { filledShares: 0, avgPrice: 0, slippage: 0 };
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

/**
 * Return the resting size at an exact price level, or 0 if no such level.
 * Polymarket ticks are $0.01, but prices on the wire are floats, so a tight
 * tolerance avoids FP-equality misses.
 */
export function findLevelSize(levels: readonly OrderbookLevel[], price: number): number {
  const TOL = 1e-6;
  for (const level of levels) {
    if (Math.abs(level.price - price) < TOL) return level.size;
  }
  return 0;
}

function createEmptyPaperPosition(): PaperPositionState {
  return {
    yes: 0,
    no: 0,
    yesCost: 0,
    noCost: 0,
    realizedPnl: 0,
    totalFees: 0,
    entryCount: 0,
    exitCount: 0,
  };
}

function buildPaperOrderId(marketId: string, signalType: SignalType | string): string {
  return `paper-${signalType.toLowerCase()}-${marketId.slice(0, 8)}-${Date.now()}`;
}

function classifySignal(signalType: SignalType): string {
  if (signalType.startsWith('OBI_')) return 'OBI';
  if (signalType.startsWith('VS_')) return 'VS_ENGINE';
  if (signalType.startsWith('PAIRED_ARB')) return 'PAIRED_ARB';
  if (signalType.startsWith('LATENCY_MOMENTUM')) return 'LATENCY_MOMENTUM';
  if (signalType.startsWith('LOTTERY')) return 'LOTTERY';
  if (signalType.startsWith('SNIPER')) return 'SNIPER';
  if (signalType.startsWith('MM_')) return 'MARKET_MAKER';
  if (signalType.startsWith('FAIR_VALUE')) return 'FAIR_VALUE';
  if (signalType.startsWith('EXTREME')) return 'EXTREME';
  return signalType;
}

function formatSignedUsd(value: number): string {
  const rounded = roundTo(value, 2);
  return `${rounded >= 0 ? '+' : ''}$${rounded.toFixed(2)}`;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0m';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
