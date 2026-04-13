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
import type { SignalType, SignalUrgency, StrategyLayer } from './strategy-types.js';
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
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
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

      // Check if book has crossed our price
      const book = order.outcome === 'YES' ? currentBook.yes : currentBook.no;
      const crossed = this.checkMakerOrderCrossed(order, book);

      if (crossed) {
        const actualFilled = this.fillMakerOrder(order, book);
        // Phase 44c: only report fills with actual shares (Bug 1 fix —
        // previously used order.shares which is the REQUESTED amount,
        // not the actual filled amount after balance/inventory clamping).
        if (actualFilled > 0) {
          fills.push({
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            shares: actualFilled,
            price: order.price,
            signalType: order.signalType,
            strategyLayer: order.signalType === 'LOTTERY_BUY' ? 'LOTTERY' as const
              : order.signalType === 'OBI_ENTRY_BUY' ? 'OBI' as const
              : order.signalType.startsWith('VS_') ? 'VS_ENGINE' as const
              : 'SNIPER' as const,
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
   * REVERT A MAKER FILL — Phase 44c: undo PaperTrader state when
   * runtime guard blocks a fill (e.g. max position exceeded).
   * Without this, PaperTrader balance diverges from positionManager.
   * ================================================================ */
  revertMakerFill(marketId: string, outcome: Outcome, side: 'BUY' | 'SELL', shares: number, price: number): void {
    const position = this.positions.get(marketId) ?? createEmptyPaperPosition();
    const key = outcome === 'YES' ? 'yes' : 'no';
    const costKey = outcome === 'YES' ? 'yesCost' : 'noCost';

    if (side === 'BUY') {
      // Undo: remove shares, refund balance
      position[key] = roundTo(Math.max(0, position[key] - shares), 4);
      if (position[key] <= 0) {
        position[key] = 0;
        position[costKey] = 0;
      }
      this.balance = roundTo(this.balance + shares * price, 4);
      position.entryCount = Math.max(0, position.entryCount - 1);
    } else {
      // Undo: add shares back, deduct proceeds
      position[key] = roundTo(position[key] + shares, 4);
      this.balance = roundTo(this.balance - shares * price, 4);
      position.exitCount = Math.max(0, position.exitCount - 1);
    }

    if (position.yes <= 0 && position.no <= 0 && Math.abs(position.realizedPnl) < 0.0001) {
      this.positions.delete(marketId);
    } else {
      this.positions.set(marketId, position);
    }

    logger.info('Paper maker fill REVERTED (runtime guard)', {
      marketId, outcome, side, shares, price,
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
    const book = params.outcome === 'YES'
      ? params.currentOrderbook.yes
      : params.currentOrderbook.no;

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

    const orderId = buildPaperOrderId(params.marketId, params.signalType);
    const nowMs = Date.now();

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
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.runtimeConfig.makerOrderTtlMs,
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

    const latencyMs = Date.now() - order.createdAtMs;

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
      waitMs: latencyMs,
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
        position[costKey] = 0;
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
