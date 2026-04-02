import type { MarketOrderbookSnapshot, Outcome } from './clob-fetcher.js';
import type { AppConfig, LotteryConfig } from './config.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionManager } from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';
import { clamp, roundTo } from './utils.js';

export interface LotteryEntry {
  readonly marketId: string;
  readonly outcome: Outcome;
  readonly shares: number;
  readonly entryPrice: number;
  readonly triggerSignalType: string;
  readonly enteredAtMs: number;
  readonly maxRiskUsdc: number;
}

export class LotteryEngine {
  private readonly activeEntries = new Map<string, LotteryEntry>();
  private readonly slotLotteryCounts = new Map<string, number>();
  private totalTickets = 0;
  private totalHits = 0;
  private totalRiskUsdc = 0;
  private totalPayoutUsdc = 0;

  constructor(private readonly runtimeConfig: AppConfig) {}

  generateExitSignals(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    nowMs: number;
    config: LotteryConfig;
  }): StrategySignal[] {
    const { market, orderbook, positionManager, nowMs, config } = params;
    const slotEndMs = market.endTime ? Date.parse(market.endTime) : Number.NaN;
    const timeToEndMs = Number.isFinite(slotEndMs) ? slotEndMs - nowMs : Number.POSITIVE_INFINITY;
    const signals: StrategySignal[] = [];

    for (const outcome of ['YES', 'NO'] as const satisfies readonly Outcome[]) {
      const entry = this.activeEntries.get(this.getEntryKey(market.marketId, outcome));
      if (!entry) {
        continue;
      }

      const availableShares = roundTo(
        Math.min(positionManager.getShares(outcome), entry.shares),
        4
      );
      if (availableShares <= 0) {
        continue;
      }

      const book = outcome === 'YES' ? orderbook.yes : orderbook.no;
      const bestBid =
        book.bestBid !== null && Number.isFinite(book.bestBid) ? roundTo(book.bestBid, 6) : null;
      const markPrice =
        bestBid ??
        (book.midPrice !== null && Number.isFinite(book.midPrice) ? roundTo(book.midPrice, 6) : null) ??
        (book.bestAsk !== null && Number.isFinite(book.bestAsk) ? roundTo(book.bestAsk, 6) : null);
      if (markPrice === null || markPrice <= 0) {
        continue;
      }

      const takeProfitPrice = roundTo(
        Math.max(config.takeProfitMinCents, entry.entryPrice * config.takeProfitMultiplier),
        6
      );

      if (bestBid !== null && bestBid >= takeProfitPrice) {
        signals.push({
          marketId: market.marketId,
          marketTitle: market.title,
          signalType: 'TRAILING_TAKE_PROFIT',
          priority: 985,
          generatedAt: nowMs,
          action: 'SELL',
          outcome,
          outcomeIndex: outcome === 'YES' ? 0 : 1,
          shares: availableShares,
          targetPrice: bestBid,
          referencePrice: entry.entryPrice,
          tokenPrice: bestBid,
          midPrice: book.midPrice,
          fairValue: null,
          edgeAmount: roundTo(bestBid - entry.entryPrice, 6),
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
          reason:
            `Lottery take-profit: bid ${bestBid.toFixed(3)} reached target ${takeProfitPrice.toFixed(3)} ` +
            `vs entry ${entry.entryPrice.toFixed(3)}`,
          strategyLayer: 'LOTTERY',
        });
        continue;
      }

      if (timeToEndMs <= config.exitBeforeEndMs) {
        signals.push({
          marketId: market.marketId,
          marketTitle: market.title,
          signalType: 'SLOT_FLATTEN',
          priority: 980,
          generatedAt: nowMs,
          action: 'SELL',
          outcome,
          outcomeIndex: outcome === 'YES' ? 0 : 1,
          shares: availableShares,
          targetPrice: markPrice,
          referencePrice: entry.entryPrice,
          tokenPrice: markPrice,
          midPrice: book.midPrice,
          fairValue: null,
          edgeAmount: roundTo(markPrice - entry.entryPrice, 6),
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
          reason:
            `Lottery slot-end exit: ${Math.max(0, timeToEndMs)}ms before slot end ` +
            `at ${markPrice.toFixed(3)} vs entry ${entry.entryPrice.toFixed(3)}`,
          strategyLayer: 'LOTTERY',
        });
      }
    }

    return signals;
  }

  generateLotterySignal(params: {
    market: MarketCandidate;
    orderbook: MarketOrderbookSnapshot;
    positionManager: PositionManager;
    triggerSignalType: string;
    triggerOutcome: Outcome;
    triggerFillPrice: number;
    triggerFilledShares: number;
    config: LotteryConfig;
    slotKey: string;
  }): StrategySignal | null {
    const { market, orderbook, positionManager, config, slotKey } = params;
    const skip = (reason: string, details?: Record<string, unknown>): null => {
      logger.debug('Lottery ticket skipped', {
        marketId: market.marketId,
        triggerSignalType: params.triggerSignalType,
        triggerOutcome: params.triggerOutcome,
        reason,
        details,
      });
      return null;
    };

    if (!config.enabled) {
      return skip('disabled');
    }

    if (config.onlyAfterSniper && params.triggerSignalType !== 'SNIPER_BUY') {
      return skip('trigger_not_sniper');
    }

    const lotteryOutcome: Outcome = params.triggerOutcome === 'YES' ? 'NO' : 'YES';
    const key = this.getEntryKey(market.marketId, lotteryOutcome);
    if (this.activeEntries.has(key)) {
      return skip('existing_ticket', {
        lotteryOutcome,
      });
    }

    const existingLayer = positionManager.getPositionLayer(lotteryOutcome);
    if (
      positionManager.getShares(lotteryOutcome) > 0 &&
      existingLayer !== null &&
      existingLayer !== 'LOTTERY'
    ) {
      return skip('existing_non_lottery_inventory', {
        lotteryOutcome,
        existingLayer,
        shares: positionManager.getShares(lotteryOutcome),
      });
    }

    const slotCount = this.slotLotteryCounts.get(slotKey) ?? 0;
    if (slotCount >= config.maxPerSlot) {
      return skip('slot_limit', {
        slotKey,
        slotCount,
        maxPerSlot: config.maxPerSlot,
      });
    }

    const book = lotteryOutcome === 'YES' ? orderbook.yes : orderbook.no;
    if (
      (book.bestBid === null || !Number.isFinite(book.bestBid)) &&
      (book.bestAsk === null || !Number.isFinite(book.bestAsk))
    ) {
      return skip('missing_book_prices', {
        lotteryOutcome,
      });
    }

    const pricing = this.resolveLotteryTargetPrice({
      book,
      triggerFillPrice: params.triggerFillPrice,
      config,
    });
    const targetPrice = pricing.targetPrice;
    const shares = roundTo(
      Math.min(
        config.maxRiskUsdc / targetPrice,
        config.maxRiskUsdc / config.minCents
      ),
      4
    );
    const riskUsdc = roundTo(shares * targetPrice, 4);
    if (shares < 5 || riskUsdc < 1) {
      return skip('below_clob_minimum', {
        lotteryOutcome,
        shares,
        riskUsdc,
        targetPrice,
      });
    }

    logger.info('Lottery ticket generated', {
      marketId: market.marketId,
      lotteryOutcome,
      triggerOutcome: params.triggerOutcome,
      triggerFillPrice: roundTo(params.triggerFillPrice, 4),
      triggerFilledShares: roundTo(params.triggerFilledShares, 4),
      currentBestBid: book.bestBid,
      currentBestAsk: book.bestAsk,
      pricingMode: pricing.mode,
      pricingAnchorSource: pricing.anchorSource,
      pricingAnchorPrice: pricing.anchorPrice,
      rawTargetPrice: pricing.rawTargetPrice,
      targetPrice,
      shares: roundTo(shares, 2),
      riskUsdc: roundTo(riskUsdc, 2),
      maxRiskUsdc: config.maxRiskUsdc,
    });

    return {
      marketId: market.marketId,
      marketTitle: market.title,
      signalType: 'LOTTERY_BUY',
      priority: 100,
      generatedAt: Date.now(),
      action: 'BUY',
      outcome: lotteryOutcome,
      outcomeIndex: lotteryOutcome === 'YES' ? 0 : 1,
      shares,
      targetPrice,
      referencePrice: null,
      tokenPrice: book.lastTradePrice ?? book.bestBid ?? book.bestAsk ?? targetPrice,
      midPrice: book.midPrice,
      fairValue: null,
      edgeAmount: 0,
      combinedBid: orderbook.combined.combinedBid,
      combinedAsk: orderbook.combined.combinedAsk,
      combinedMid: orderbook.combined.combinedMid,
      combinedDiscount: orderbook.combined.combinedDiscount,
      combinedPremium: orderbook.combined.combinedPremium,
      fillRatio: 1,
      capitalClamp: 1,
      priceMultiplier: 1,
      urgency: 'passive',
      reduceOnly: false,
      reason:
        `Lottery ticket: resting opposite-side ${lotteryOutcome} bid @${targetPrice.toFixed(3)} ` +
        `after SNIPER ${params.triggerOutcome} fill | ` +
        `risk $${riskUsdc.toFixed(2)} / max $${config.maxRiskUsdc.toFixed(2)}`,
      strategyLayer: 'LOTTERY',
    };
  }

  recordExecution(params: {
    marketId: string;
    outcome: Outcome;
    filledShares: number;
    fillPrice: number;
    signalType: string;
    slotKey: string;
  }): void {
    const key = this.getEntryKey(params.marketId, params.outcome);
    const notionalUsd = roundTo(
      Math.max(0, params.filledShares) * Math.max(0, params.fillPrice),
      4
    );
    if (params.filledShares <= 0 || params.fillPrice <= 0 || notionalUsd <= 0) {
      return;
    }

    const existing = this.activeEntries.get(key);
    if (existing) {
      const nextShares = roundTo(existing.shares + params.filledShares, 4);
      const nextEntryPrice = roundTo(
        (existing.entryPrice * existing.shares + params.fillPrice * params.filledShares) /
          nextShares,
        6
      );
      this.activeEntries.set(key, {
        ...existing,
        shares: nextShares,
        entryPrice: nextEntryPrice,
      });
      this.totalRiskUsdc = roundTo(this.totalRiskUsdc + notionalUsd, 4);
      logger.info('Lottery ticket filled', {
        marketId: params.marketId,
        outcome: params.outcome,
        filledShares: roundTo(params.filledShares, 4),
        fillPrice: roundTo(params.fillPrice, 6),
        totalShares: nextShares,
        avgEntryPrice: nextEntryPrice,
        ticketCount: this.totalTickets,
        activeEntries: this.activeEntries.size,
      });
      return;
    }

    this.totalTickets += 1;
    this.totalRiskUsdc = roundTo(this.totalRiskUsdc + notionalUsd, 4);
    this.slotLotteryCounts.set(
      params.slotKey,
      (this.slotLotteryCounts.get(params.slotKey) ?? 0) + 1
    );
    this.activeEntries.set(key, {
      marketId: params.marketId,
      outcome: params.outcome,
      shares: roundTo(params.filledShares, 4),
      entryPrice: roundTo(params.fillPrice, 6),
      triggerSignalType: params.signalType,
      enteredAtMs: Date.now(),
      maxRiskUsdc: notionalUsd,
    });
    logger.info('Lottery ticket filled', {
      marketId: params.marketId,
      outcome: params.outcome,
      filledShares: roundTo(params.filledShares, 4),
      fillPrice: roundTo(params.fillPrice, 6),
      totalShares: roundTo(params.filledShares, 4),
      avgEntryPrice: roundTo(params.fillPrice, 6),
      ticketCount: this.totalTickets,
      activeEntries: this.activeEntries.size,
    });
  }

  recordSettlement(params: {
    marketId: string;
    outcome: Outcome;
    payoutUsd: number;
  }): void {
    const key = this.getEntryKey(params.marketId, params.outcome);
    if (!this.activeEntries.has(key)) {
      return;
    }

    if (params.payoutUsd > 0) {
      this.totalHits += 1;
      this.totalPayoutUsdc = roundTo(this.totalPayoutUsdc + params.payoutUsd, 4);
    }
    this.activeEntries.delete(key);
  }

  recordExit(marketId: string, outcome: Outcome): void {
    this.activeEntries.delete(this.getEntryKey(marketId, outcome));
  }

  isLotteryPosition(marketId: string, outcome: Outcome): boolean {
    return this.activeEntries.has(this.getEntryKey(marketId, outcome));
  }

  getStats(): {
    enabled: boolean;
    totalTickets: number;
    totalHits: number;
    activeEntries: number;
    hitRate: string;
    totalRiskUsdc: number;
    totalPayoutUsdc: number;
  } {
    return {
      enabled: this.runtimeConfig.lottery.enabled,
      totalTickets: this.totalTickets,
      totalHits: this.totalHits,
      activeEntries: this.activeEntries.size,
      hitRate:
        this.totalTickets > 0
          ? `${roundTo((this.totalHits / this.totalTickets) * 100, 1).toFixed(1)}%`
          : '0.0%',
      totalRiskUsdc: roundTo(this.totalRiskUsdc, 2),
      totalPayoutUsdc: roundTo(this.totalPayoutUsdc, 2),
    };
  }

  private getEntryKey(marketId: string, outcome: Outcome): string {
    return `${marketId}:${outcome}`;
  }

  private resolveLotteryTargetPrice(params: {
    book: MarketOrderbookSnapshot['yes'] | MarketOrderbookSnapshot['no'];
    triggerFillPrice: number;
    config: LotteryConfig;
  }): {
    targetPrice: number;
    rawTargetPrice: number;
    anchorPrice: number;
    anchorSource: 'best_bid' | 'mid_price' | 'best_ask' | 'trigger_complement' | 'fixed_cap';
    mode: 'relative' | 'fixed';
  } {
    const { book, triggerFillPrice, config } = params;
    const triggerComplement = clamp(1 - triggerFillPrice, 0.01, 0.99);
    const bestBid =
      book.bestBid !== null && Number.isFinite(book.bestBid) ? Math.max(0.01, book.bestBid) : null;
    const midPrice =
      book.midPrice !== null && Number.isFinite(book.midPrice) ? Math.max(0.01, book.midPrice) : null;
    const bestAsk =
      book.bestAsk !== null && Number.isFinite(book.bestAsk) ? Math.max(0.01, book.bestAsk) : null;

    if (config.relativePricingEnabled) {
      const anchorPrice = bestBid ?? midPrice ?? bestAsk ?? triggerComplement;
      const anchorSource =
        bestBid !== null
          ? 'best_bid'
          : midPrice !== null
            ? 'mid_price'
            : bestAsk !== null
              ? 'best_ask'
              : 'trigger_complement';
      const rawTargetPrice = roundTo(anchorPrice * config.relativePriceFactor, 6);
      return {
        targetPrice: roundTo(
          clamp(rawTargetPrice, config.minCents, config.relativeMaxCents),
          6
        ),
        rawTargetPrice,
        anchorPrice: roundTo(anchorPrice, 6),
        anchorSource,
        mode: 'relative',
      };
    }

    const anchorPrice = bestBid ?? config.maxCents;
    return {
      targetPrice: roundTo(clamp(anchorPrice, config.minCents, config.maxCents), 6),
      rawTargetPrice: roundTo(anchorPrice, 6),
      anchorPrice: roundTo(anchorPrice, 6),
      anchorSource: bestBid !== null ? 'best_bid' : 'fixed_cap',
      mode: 'fixed',
    };
  }
}
