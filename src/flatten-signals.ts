import type { MarketOrderbookSnapshot } from './clob-fetcher.js';
import type { MarketCandidate } from './monitor.js';
import type { PositionSnapshot } from './position-manager.js';
import type { StrategySignal } from './strategy-types.js';

export function buildFlattenSignals(params: {
  market: MarketCandidate;
  orderbook: MarketOrderbookSnapshot;
  snapshot: PositionSnapshot;
  signalType: StrategySignal['signalType'];
  reasonPrefix: string;
}): StrategySignal[] {
  const { market, orderbook, snapshot, signalType, reasonPrefix } = params;
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
      reason: `${reasonPrefix} flatten for ${market.yesLabel || 'YES'} inventory`,
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
      reason: `${reasonPrefix} flatten for ${market.noLabel || 'NO'} inventory`,
    });
  }

  return signals;
}
