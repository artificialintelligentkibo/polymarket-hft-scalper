/**
 * Trade Narrator — human-readable business log.
 *
 * Writes a separate log file (`reports/trade-journal_YYYY-MM-DD.log`)
 * that describes every meaningful trade event in plain English.
 * No technical spam — only entries, exits, results, and daily summaries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { roundTo } from './utils.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface NarratorTradeEntry {
  tradeId: number;
  marketTitle: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  layer: 'SNIPER' | 'LOTTERY' | 'MM_QUOTE';
  entryPrice: number;
  shares: number;
  entryTimeMs: number;
  /** Why the bot entered (Binance move, edge, etc.) */
  entryReason: string;
  /** Exit info, filled on close */
  exitPrice?: number;
  exitTimeMs?: number;
  exitReason?: string;
  exitSignalType?: string;
  pnlUsd?: number;
  /** MM asks posted after sniper entry */
  mmAsks: Array<{ price: number; timeMs: number }>;
  /** Whether this trade is still open */
  open: boolean;
}

export interface NarratorDaySummary {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnlUsd: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
  sniperPnl: number;
  lotteryPnl: number;
  mmPnl: number;
  redeemPnl: number;
}

/* ------------------------------------------------------------------ */
/*  Narrator                                                           */
/* ------------------------------------------------------------------ */

export class TradeNarrator {
  private readonly reportsDir: string;
  private currentDayKey = '';
  private logStream: fs.WriteStream | null = null;
  private tradeCounter = 0;
  private readonly activeTrades = new Map<string, NarratorTradeEntry>();
  private readonly closedTrades: NarratorTradeEntry[] = [];
  private redeemPnlAccumulator = 0;

  constructor(reportsDir = './reports') {
    this.reportsDir = reportsDir;
  }

  /* ================================================================ */
  /*  Public API — called from index.ts                                */
  /* ================================================================ */

  /** Bot started up. */
  logStartup(params: {
    balanceUsd: number | null;
    mode: string;
    sniperEnabled: boolean;
    lotteryEnabled: boolean;
    mmEnabled: boolean;
  }): void {
    this.ensureStream();
    const bal = params.balanceUsd !== null ? `$${params.balanceUsd.toFixed(2)}` : 'unknown';
    this.writeLine('');
    this.writeLine('═'.repeat(60));
    this.writeLine(`BOT STARTED — ${params.mode}`);
    this.writeLine(`Balance: ${bal}`);
    const modules: string[] = [];
    if (params.sniperEnabled) modules.push('Sniper');
    if (params.lotteryEnabled) modules.push('Lottery');
    if (params.mmEnabled) modules.push('Market Maker');
    this.writeLine(`Active modules: ${modules.join(', ') || 'none'}`);
    this.writeLine('═'.repeat(60));
    this.writeLine('');
  }

  /** Bot shutting down. */
  logShutdown(reason: string): void {
    this.writeDaySummary();
    this.writeLine('');
    this.writeLine('═'.repeat(60));
    this.writeLine(`BOT STOPPED — ${reason}`);
    this.writeLine('═'.repeat(60));
    this.closeStream();
  }

  /** Sniper BUY fill confirmed. */
  logSniperEntry(params: {
    marketId: string;
    marketTitle: string;
    outcome: 'YES' | 'NO';
    shares: number;
    price: number;
    binanceDirection: string;
    binanceMovePct: number;
    edge: number;
    reason: string;
  }): void {
    this.ensureStream();
    const id = ++this.tradeCounter;
    const key = this.tradeKey(params.marketId, params.outcome, 'SNIPER');
    const trade: NarratorTradeEntry = {
      tradeId: id,
      marketTitle: params.marketTitle,
      marketId: params.marketId,
      outcome: params.outcome,
      layer: 'SNIPER',
      entryPrice: params.price,
      shares: params.shares,
      entryTimeMs: Date.now(),
      entryReason: params.reason,
      mmAsks: [],
      open: true,
    };
    this.activeTrades.set(key, trade);

    const notional = roundTo(params.shares * params.price, 2);
    const time = this.formatTime(trade.entryTimeMs);
    this.writeLine('');
    this.writeLine(`Trade #${id} (${time}) — SNIPER ENTRY`);
    this.writeLine(`  Market: ${this.shortTitle(params.marketTitle)}`);
    this.writeLine(`  BUY ${params.outcome} — ${params.shares} shares @ $${params.price.toFixed(2)} ($${notional.toFixed(2)})`);
    this.writeLine(`  Binance ${params.binanceDirection} ${(Math.abs(params.binanceMovePct) * 100).toFixed(2)}%, edge ${(params.edge * 100).toFixed(1)}%`);
  }

  /** Sniper EXIT fill (scalp exit, trailing TP, stop-loss, slot-end, break-even). */
  logSniperExit(params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    shares: number;
    exitPrice: number;
    entryPrice: number;
    signalType: string;
    reason: string;
    pnlUsd: number;
  }): void {
    this.ensureStream();
    const key = this.tradeKey(params.marketId, params.outcome, 'SNIPER');
    const trade = this.activeTrades.get(key);

    const exitType = this.humanExitType(params.signalType, params.reason);
    const pnlSign = params.pnlUsd >= 0 ? '+' : '';
    const icon = params.pnlUsd >= 0 ? '✅' : '❌';
    const holdMs = trade ? Date.now() - trade.entryTimeMs : 0;
    const holdStr = this.formatDuration(holdMs);
    const pctChange = params.entryPrice > 0
      ? roundTo(((params.exitPrice - params.entryPrice) / params.entryPrice) * 100, 1)
      : 0;

    const id = trade?.tradeId ?? '?';
    const time = this.formatTime(Date.now());
    this.writeLine('');
    this.writeLine(`Trade #${id} (${time}) — ${exitType} ${icon}  ${pnlSign}$${params.pnlUsd.toFixed(2)}`);
    this.writeLine(`  SELL ${params.outcome} — ${params.shares} shares @ $${params.exitPrice.toFixed(2)} (entry $${params.entryPrice.toFixed(2)}, ${pctChange > 0 ? '+' : ''}${pctChange}%)`);
    this.writeLine(`  Held for ${holdStr}`);
    this.writeLine(`  ${this.humanExitExplanation(params.signalType, params.reason, params.pnlUsd)}`);

    if (trade) {
      trade.exitPrice = params.exitPrice;
      trade.exitTimeMs = Date.now();
      trade.exitReason = params.reason;
      trade.exitSignalType = params.signalType;
      trade.pnlUsd = params.pnlUsd;
      trade.open = false;
      this.activeTrades.delete(key);
      this.closedTrades.push(trade);
    }
  }

  /** Lottery BUY fill. */
  logLotteryEntry(params: {
    marketId: string;
    marketTitle: string;
    outcome: 'YES' | 'NO';
    shares: number;
    price: number;
    riskUsd: number;
  }): void {
    this.ensureStream();
    const id = ++this.tradeCounter;
    const key = this.tradeKey(params.marketId, params.outcome, 'LOTTERY');
    const trade: NarratorTradeEntry = {
      tradeId: id,
      marketTitle: params.marketTitle,
      marketId: params.marketId,
      outcome: params.outcome,
      layer: 'LOTTERY',
      entryPrice: params.price,
      shares: params.shares,
      entryTimeMs: Date.now(),
      entryReason: 'Opposite-side convex ticket after sniper fill',
      mmAsks: [],
      open: true,
    };
    this.activeTrades.set(key, trade);

    const time = this.formatTime(trade.entryTimeMs);
    this.writeLine(`  └─ Lottery #${id}: BUY ${params.outcome} — ${params.shares} shares @ $${params.price.toFixed(3)} (risk $${params.riskUsd.toFixed(2)})`);
  }

  /** Lottery EXIT (take-profit, stop-loss, time-stop, slot flatten, or redeem). */
  logLotteryExit(params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    exitPrice: number;
    shares: number;
    signalType: string;
    reason: string;
    pnlUsd: number;
  }): void {
    this.ensureStream();
    const key = this.tradeKey(params.marketId, params.outcome, 'LOTTERY');
    const trade = this.activeTrades.get(key);
    const id = trade?.tradeId ?? '?';
    const icon = params.pnlUsd >= 0 ? '✅' : '❌';
    const pnlSign = params.pnlUsd >= 0 ? '+' : '';

    const exitType = this.humanExitType(params.signalType, params.reason);
    this.writeLine(`  └─ Lottery #${id}: ${exitType} — SELL @ $${params.exitPrice.toFixed(3)}, ${pnlSign}$${params.pnlUsd.toFixed(2)} ${icon}`);

    if (trade) {
      trade.exitPrice = params.exitPrice;
      trade.exitTimeMs = Date.now();
      trade.exitReason = params.reason;
      trade.exitSignalType = params.signalType;
      trade.pnlUsd = params.pnlUsd;
      trade.open = false;
      this.activeTrades.delete(key);
      this.closedTrades.push(trade);
    }
  }

  /** MM quote posted (ask or bid). */
  logMMQuotePosted(params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    shares: number;
  }): void {
    // Only log MM asks that follow sniper entries (not spam every quote refresh)
    const sniperKey = this.tradeKey(params.marketId, params.outcome, 'SNIPER');
    const sniperTrade = this.activeTrades.get(sniperKey);
    if (sniperTrade && params.side === 'SELL') {
      // Only log first MM ask per trade to avoid spam
      if (sniperTrade.mmAsks.length === 0) {
        this.ensureStream();
        this.writeLine(`  └─ MM ASK posted: SELL ${params.outcome} — ${params.shares} shares @ $${params.price.toFixed(2)}`);
      }
      sniperTrade.mmAsks.push({ price: params.price, timeMs: Date.now() });
    }
  }

  /** MM quote fill (buy or sell). */
  logMMFill(params: {
    marketId: string;
    marketTitle: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
    pnlUsd: number;
  }): void {
    this.ensureStream();
    const id = ++this.tradeCounter;
    const time = this.formatTime(Date.now());
    const icon = params.pnlUsd >= 0 ? '✅' : '❌';
    const pnlSign = params.pnlUsd >= 0 ? '+' : '';
    this.writeLine(`  └─ MM Fill #${id} (${time}): ${params.side} ${params.outcome} — ${params.shares} shares @ $${params.price.toFixed(2)}, ${pnlSign}$${params.pnlUsd.toFixed(2)} ${icon}`);

    this.closedTrades.push({
      tradeId: id,
      marketTitle: params.marketTitle,
      marketId: params.marketId,
      outcome: params.outcome,
      layer: 'MM_QUOTE',
      entryPrice: params.price,
      shares: params.shares,
      entryTimeMs: Date.now(),
      entryReason: `MM ${params.side}`,
      exitPrice: params.price,
      exitTimeMs: Date.now(),
      pnlUsd: params.pnlUsd,
      mmAsks: [],
      open: false,
    });
  }

  /** Market resolved and redeemed. */
  logRedemption(params: {
    marketTitle: string;
    conditionId: string;
    winningOutcome: 'YES' | 'NO' | null;
    payoutUsd: number;
    costBasisUsd: number;
    pnlUsd: number;
  }): void {
    this.ensureStream();
    this.redeemPnlAccumulator = roundTo(this.redeemPnlAccumulator + params.pnlUsd, 2);
    const icon = params.pnlUsd >= 0 ? '✅' : '❌';
    const pnlSign = params.pnlUsd >= 0 ? '+' : '';
    const winner = params.winningOutcome ?? '???';
    const time = this.formatTime(Date.now());

    this.writeLine('');
    this.writeLine(`Redemption (${time}) ${icon}  ${pnlSign}$${params.pnlUsd.toFixed(2)}`);
    this.writeLine(`  Market: ${this.shortTitle(params.marketTitle)}`);
    this.writeLine(`  Winner: ${winner} | Payout: $${params.payoutUsd.toFixed(2)} | Cost basis: $${params.costBasisUsd.toFixed(2)}`);
  }

  /** Balance update (only log significant changes). */
  logBalanceUpdate(balanceUsd: number): void {
    // Only log at startup or when explicitly requested — not every refresh
    // The daily summary will show final balance
  }

  /** Write end-of-day summary. Can be called on day change or shutdown. */
  writeDaySummary(): void {
    if (this.closedTrades.length === 0 && this.redeemPnlAccumulator === 0) {
      return;
    }
    this.ensureStream();

    const summary = this.computeDaySummary();
    const winRate = summary.totalTrades > 0
      ? roundTo((summary.wins / summary.totalTrades) * 100, 0)
      : 0;

    this.writeLine('');
    this.writeLine('─'.repeat(60));
    this.writeLine(`DAY SUMMARY — ${summary.date}`);
    this.writeLine('─'.repeat(60));
    this.writeLine(`  Trades: ${summary.totalTrades} | Wins: ${summary.wins} | Losses: ${summary.losses} | Win rate: ${winRate}%`);
    this.writeLine(`  TOTAL PnL: ${summary.totalPnlUsd >= 0 ? '+' : ''}$${summary.totalPnlUsd.toFixed(2)}`);
    if (summary.sniperPnl !== 0) {
      this.writeLine(`    Sniper: ${summary.sniperPnl >= 0 ? '+' : ''}$${summary.sniperPnl.toFixed(2)}`);
    }
    if (summary.lotteryPnl !== 0) {
      this.writeLine(`    Lottery: ${summary.lotteryPnl >= 0 ? '+' : ''}$${summary.lotteryPnl.toFixed(2)}`);
    }
    if (summary.mmPnl !== 0) {
      this.writeLine(`    Market Maker: ${summary.mmPnl >= 0 ? '+' : ''}$${summary.mmPnl.toFixed(2)}`);
    }
    if (summary.redeemPnl !== 0) {
      this.writeLine(`    Redemptions: ${summary.redeemPnl >= 0 ? '+' : ''}$${summary.redeemPnl.toFixed(2)}`);
    }
    if (summary.bestTradeUsd !== 0) {
      this.writeLine(`  Best trade: +$${summary.bestTradeUsd.toFixed(2)}`);
    }
    if (summary.worstTradeUsd !== 0) {
      this.writeLine(`  Worst trade: $${summary.worstTradeUsd.toFixed(2)}`);
    }

    // List still-open trades
    const openTrades = Array.from(this.activeTrades.values());
    if (openTrades.length > 0) {
      this.writeLine(`  Open positions: ${openTrades.length}`);
      for (const t of openTrades) {
        const holdStr = this.formatDuration(Date.now() - t.entryTimeMs);
        this.writeLine(`    - #${t.tradeId} ${t.layer} ${t.outcome} @ $${t.entryPrice.toFixed(2)} (held ${holdStr})`);
      }
    }
    this.writeLine('─'.repeat(60));
  }

  /* ================================================================ */
  /*  Internal                                                         */
  /* ================================================================ */

  private computeDaySummary(): NarratorDaySummary {
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let bestTrade = 0;
    let worstTrade = 0;
    let sniperPnl = 0;
    let lotteryPnl = 0;
    let mmPnl = 0;

    for (const t of this.closedTrades) {
      const pnl = t.pnlUsd ?? 0;
      if (pnl > 0.005) wins++;
      else if (pnl < -0.005) losses++;
      else breakeven++;

      if (pnl > bestTrade) bestTrade = pnl;
      if (pnl < worstTrade) worstTrade = pnl;

      switch (t.layer) {
        case 'SNIPER': sniperPnl += pnl; break;
        case 'LOTTERY': lotteryPnl += pnl; break;
        case 'MM_QUOTE': mmPnl += pnl; break;
      }
    }

    const totalPnl = roundTo(sniperPnl + lotteryPnl + mmPnl + this.redeemPnlAccumulator, 2);

    return {
      date: this.currentDayKey || this.getDayKey(),
      totalTrades: this.closedTrades.length,
      wins,
      losses,
      breakeven,
      totalPnlUsd: totalPnl,
      bestTradeUsd: roundTo(bestTrade, 2),
      worstTradeUsd: roundTo(worstTrade, 2),
      sniperPnl: roundTo(sniperPnl, 2),
      lotteryPnl: roundTo(lotteryPnl, 2),
      mmPnl: roundTo(mmPnl, 2),
      redeemPnl: roundTo(this.redeemPnlAccumulator, 2),
    };
  }

  private tradeKey(marketId: string, outcome: string, layer: string): string {
    return `${layer}:${marketId}:${outcome}`;
  }

  private humanExitType(signalType: string, reason: string): string {
    if (reason.includes('break-even')) return 'BREAK-EVEN EXIT';
    if (reason.includes('stop-loss') || reason.includes('Lottery stop-loss')) return 'STOP-LOSS';
    if (reason.includes('time-stop') || reason.includes('time stop')) return 'TIME STOP';
    if (reason.includes('slot-end') || reason.includes('slot end')) return 'SLOT-END EXIT';
    if (reason.includes('reversal stop')) return 'REVERSAL STOP';

    switch (signalType) {
      case 'SNIPER_SCALP_EXIT': return 'SCALP EXIT';
      case 'TRAILING_TAKE_PROFIT': return 'TAKE PROFIT';
      case 'HARD_STOP': return 'STOP-LOSS';
      case 'SLOT_FLATTEN': return 'SLOT-END EXIT';
      case 'OBI_SCALP_EXIT': return 'OBI SCALP EXIT';
      case 'OBI_REBALANCE_EXIT': return 'OBI REBALANCE EXIT';
      default: return 'EXIT';
    }
  }

  private humanExitExplanation(signalType: string, reason: string, pnlUsd: number): string {
    if (reason.includes('break-even')) {
      return 'Price went up after entry but fell back — exited at breakeven to protect profit.';
    }
    if (reason.includes('stop-loss') || signalType === 'HARD_STOP') {
      return pnlUsd < -0.5
        ? 'Position moved against us — stopped out to limit the loss.'
        : 'Stop-loss triggered — small loss, damage contained.';
    }
    if (reason.includes('time-stop') || reason.includes('time stop')) {
      return 'Held too long without profit — exited on time stop.';
    }
    if (reason.includes('slot-end') || reason.includes('slot end')) {
      return 'Slot ending soon — exited to avoid holding through resolution.';
    }
    if (reason.includes('reversal')) {
      return 'Binance reversed direction — exited to cut the loss.';
    }
    if (signalType === 'SNIPER_SCALP_EXIT' && pnlUsd > 0) {
      return 'Price repriced in our favor — took the profit.';
    }
    if (signalType === 'TRAILING_TAKE_PROFIT') {
      return 'Price reached target — took profit.';
    }
    if (signalType === 'OBI_SCALP_EXIT' && pnlUsd > 0) {
      return 'Order book imbalance — scalp exit took profit.';
    }
    if (signalType === 'OBI_REBALANCE_EXIT') {
      return 'Order book rebalanced — exiting OBI position.';
    }
    return '';
  }

  /* ---- File I/O ---- */

  private ensureStream(): void {
    const dayKey = this.getDayKey();
    if (dayKey !== this.currentDayKey) {
      // Day rolled — write summary for previous day and reset
      if (this.currentDayKey && (this.closedTrades.length > 0 || this.redeemPnlAccumulator !== 0)) {
        this.writeDaySummary();
      }
      this.closeStream();
      this.currentDayKey = dayKey;
      this.tradeCounter = 0;
      this.closedTrades.length = 0;
      this.redeemPnlAccumulator = 0;
      // Don't clear activeTrades — they carry over midnight

      fs.mkdirSync(this.reportsDir, { recursive: true });
      const filePath = path.join(this.reportsDir, `trade-journal_${dayKey}.log`);
      this.logStream = fs.createWriteStream(filePath, { flags: 'a' });
    }
  }

  private writeLine(line: string): void {
    if (!this.logStream) return;
    this.logStream.write(line + '\n');
  }

  private closeStream(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  /* ---- Formatting helpers ---- */

  private getDayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  private formatTime(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    return `${mins}m ${remainSecs}s`;
  }

  private shortTitle(title: string): string {
    // Truncate long market titles
    return title.length > 55 ? title.slice(0, 52) + '...' : title;
  }
}
