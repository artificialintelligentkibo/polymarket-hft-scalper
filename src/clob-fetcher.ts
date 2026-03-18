import { ClobClient } from '@polymarket/clob-client';
import WebSocket from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';

export type Outcome = 'YES' | 'NO';

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface TokenBookSnapshot {
  tokenId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  depthSharesBid: number;
  depthSharesAsk: number;
  depthNotionalBid: number;
  depthNotionalAsk: number;
  lastTradePrice: number | null;
  lastTradeSize: number | null;
  source: 'rest' | 'ws';
  updatedAt: string;
}

export interface CombinedBookMetrics {
  combinedBid: number | null;
  combinedAsk: number | null;
  combinedMid: number | null;
  combinedDiscount: number | null;
  combinedPremium: number | null;
  pairSpread: number | null;
}

export interface MarketOrderbookSnapshot {
  marketId: string;
  title: string;
  timestamp: string;
  yes: TokenBookSnapshot;
  no: TokenBookSnapshot;
  combined: CombinedBookMetrics;
}

interface TokenMarketState extends TokenBookSnapshot {}

type JsonRecord = Record<string, unknown>;

export class ClobFetcher {
  private readonly client: ClobClient;
  private readonly states = new Map<string, TokenMarketState>();
  private readonly subscribedAssets = new Set<string>();
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | undefined;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.client = new ClobClient(config.clob.host, config.chainId as any);
  }

  async subscribeAssets(tokenIds: string[]): Promise<void> {
    const nextIds = tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean);
    if (nextIds.length === 0) {
      return;
    }

    for (const tokenId of nextIds) {
      this.subscribedAssets.add(tokenId);
    }

    await this.ensureConnected();
    this.sendSubscription(nextIds);
  }

  async getMarketSnapshot(market: MarketCandidate): Promise<MarketOrderbookSnapshot> {
    await this.subscribeAssets([market.yesTokenId, market.noTokenId]);

    const [yes, no] = await Promise.all([
      this.getTokenSnapshot(market.yesTokenId),
      this.getTokenSnapshot(market.noTokenId),
    ]);

    return {
      marketId: market.marketId,
      title: market.title,
      timestamp: new Date().toISOString(),
      yes,
      no,
      combined: computeCombinedBookMetrics(yes, no),
    };
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  private async getTokenSnapshot(tokenId: string): Promise<TokenBookSnapshot> {
    const cached = this.states.get(tokenId);
    if (cached) {
      const updatedMs = Date.parse(cached.updatedAt);
      if (Number.isFinite(updatedMs) && Date.now() - updatedMs < config.clob.snapshotRefreshMs) {
        return cached;
      }
    }

    return this.refreshTokenSnapshot(tokenId);
  }

  private async refreshTokenSnapshot(tokenId: string): Promise<TokenBookSnapshot> {
    const [orderbook, lastTrade] = await Promise.all([
      this.client.getOrderBook(tokenId),
      this.fetchLastTradePrice(tokenId),
    ]);

    const normalized = normalizeTokenBook(tokenId, orderbook, config.clob.bookDepthLevels);
    const nextState: TokenMarketState = {
      ...normalized,
      lastTradePrice: lastTrade.price ?? normalized.lastTradePrice,
      lastTradeSize: lastTrade.size ?? normalized.lastTradeSize,
      source: 'rest',
      updatedAt: new Date().toISOString(),
    };

    this.states.set(tokenId, nextState);
    return nextState;
  }

  private async fetchLastTradePrice(
    tokenId: string
  ): Promise<{ price: number | null; size: number | null }> {
    try {
      const response = await (this.client as any).getLastTradePrice?.(tokenId);
      const record = asRecord(response);
      const price = toNumber(record?.price ?? response);
      const size = toNumber(record?.size);
      return {
        price: Number.isFinite(price) && price > 0 ? price : null,
        size: Number.isFinite(size) && size > 0 ? size : null,
      };
    } catch {
      return { price: null, size: null };
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }

    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(config.clob.wsUrl);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.startPingInterval();
          if (this.subscribedAssets.size > 0) {
            this.sendSubscription(Array.from(this.subscribedAssets), true);
          }
          resolve();
        });

        this.ws.on('message', (payload: WebSocket.Data) => {
          this.handleMessage(payload.toString());
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.ws = null;
          if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
          }
        });

        this.ws.on('error', (error: Error) => {
          reject(error);
        });

        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10_000);
      } catch (error) {
        reject(error);
      }
    }).catch((error: any) => {
      logger.warn('CLOB WebSocket connection failed, REST fallback remains active', {
        message: error?.message || 'Unknown error',
      });
    });
  }

  private sendSubscription(tokenIds: string[], initialDump = false): void {
    if (!this.ws || !this.isConnected || tokenIds.length === 0) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: 'market',
        assets_ids: tokenIds,
        initial_dump: initialDump || config.clob.initialDump,
      })
    );
  }

  private handleMessage(data: string): void {
    if (!data || data === 'PING') {
      this.ws?.send('PONG');
      return;
    }

    if (data === 'PONG') {
      return;
    }

    try {
      const payload = JSON.parse(data) as unknown;
      const messages = Array.isArray(payload) ? payload : [payload];
      for (const message of messages) {
        this.applyMessage(asRecord(message));
      }
    } catch (error) {
      logger.debug('Ignoring malformed CLOB WebSocket payload', {
        message: String(error),
      });
    }
  }

  private applyMessage(message: JsonRecord | null): void {
    if (!message) {
      return;
    }

    const event = asString(message.event) || asString(message.event_type);
    if (event.toLowerCase() === 'ping') {
      this.ws?.send(JSON.stringify({ event: 'pong' }));
      return;
    }

    const tokenId =
      asString(message.asset_id) ||
      asString(message.token_id) ||
      asString(message.assetId) ||
      asString(message.tokenId);
    if (!tokenId) {
      return;
    }

    const existing = this.states.get(tokenId) ?? createEmptyState(tokenId);
    const nextState: TokenMarketState = {
      ...existing,
      updatedAt: new Date().toISOString(),
      source: 'ws',
    };

    if (event === 'last_trade_price') {
      const price = toNumber(message.price);
      const size = toNumber(message.size);
      nextState.lastTradePrice =
        Number.isFinite(price) && price > 0 ? price : nextState.lastTradePrice;
      nextState.lastTradeSize =
        Number.isFinite(size) && size > 0 ? size : nextState.lastTradeSize;
    }

    if (message.bids || message.asks) {
      const normalized = normalizeTokenBook(tokenId, message, config.clob.bookDepthLevels);
      nextState.bids = normalized.bids;
      nextState.asks = normalized.asks;
      nextState.bestBid = normalized.bestBid;
      nextState.bestAsk = normalized.bestAsk;
      nextState.midPrice = normalized.midPrice;
      nextState.spread = normalized.spread;
      nextState.spreadBps = normalized.spreadBps;
      nextState.depthSharesBid = normalized.depthSharesBid;
      nextState.depthSharesAsk = normalized.depthSharesAsk;
      nextState.depthNotionalBid = normalized.depthNotionalBid;
      nextState.depthNotionalAsk = normalized.depthNotionalAsk;
    }

    this.states.set(tokenId, nextState);
  }

  private startPingInterval(): void {
    if (this.pingInterval) {
      return;
    }

    this.pingInterval = setInterval(() => {
      if (!this.ws || !this.isConnected) {
        return;
      }

      try {
        this.ws.send('PING');
      } catch {
        this.ws.ping();
      }
    }, 50_000);

    this.pingInterval.unref?.();
  }
}

export function computeCombinedBookMetrics(
  yes: Pick<TokenBookSnapshot, 'bestBid' | 'bestAsk' | 'midPrice'>,
  no: Pick<TokenBookSnapshot, 'bestBid' | 'bestAsk' | 'midPrice'>
): CombinedBookMetrics {
  const combinedBid = sumPair(yes.bestBid, no.bestBid);
  const combinedAsk = sumPair(yes.bestAsk, no.bestAsk);
  const combinedMid = sumPair(yes.midPrice, no.midPrice);
  const combinedDiscount =
    combinedAsk !== null ? roundTo(1 - combinedAsk, 6) : null;
  const combinedPremium =
    combinedBid !== null ? roundTo(combinedBid - 1, 6) : null;
  const pairSpread =
    combinedAsk !== null && combinedBid !== null ? roundTo(combinedAsk - combinedBid, 6) : null;

  return {
    combinedBid,
    combinedAsk,
    combinedMid,
    combinedDiscount,
    combinedPremium,
    pairSpread,
  };
}

export function normalizeTokenBook(
  tokenId: string,
  payload: unknown,
  depthLevels = 5
): TokenBookSnapshot {
  const record = asRecord(payload);
  const bids = extractLevels(record?.bids, 'desc');
  const asks = extractLevels(record?.asks, 'asc');
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midPrice =
    bestBid !== null && bestAsk !== null ? roundTo((bestBid + bestAsk) / 2, 6) : null;
  const spread =
    bestBid !== null && bestAsk !== null ? roundTo(bestAsk - bestBid, 6) : null;
  const spreadBps =
    spread !== null && midPrice !== null && midPrice > 0
      ? roundTo((spread / midPrice) * 10_000, 2)
      : null;
  const sliceDepth = Math.max(1, depthLevels);
  const depthBids = bids.slice(0, sliceDepth);
  const depthAsks = asks.slice(0, sliceDepth);
  const depthSharesBid = roundTo(sumSizes(depthBids), 4);
  const depthSharesAsk = roundTo(sumSizes(depthAsks), 4);
  const depthNotionalBid = roundTo(sumNotional(depthBids), 4);
  const depthNotionalAsk = roundTo(sumNotional(depthAsks), 4);

  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    spreadBps,
    depthSharesBid,
    depthSharesAsk,
    depthNotionalBid,
    depthNotionalAsk,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest',
    updatedAt: new Date().toISOString(),
  };
}

function createEmptyState(tokenId: string): TokenMarketState {
  return {
    tokenId,
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    depthSharesBid: 0,
    depthSharesAsk: 0,
    depthNotionalBid: 0,
    depthNotionalAsk: 0,
    lastTradePrice: null,
    lastTradeSize: null,
    source: 'rest',
    updatedAt: new Date().toISOString(),
  };
}

function extractLevels(candidate: unknown, direction: 'asc' | 'desc'): OrderbookLevel[] {
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate
    .map((level) => normalizeLevel(level))
    .filter((level): level is OrderbookLevel => level !== null)
    .sort((left, right) =>
      direction === 'asc' ? left.price - right.price : right.price - left.price
    );
}

function normalizeLevel(level: unknown): OrderbookLevel | null {
  const record = asRecord(level);
  if (!record) {
    return null;
  }

  const price = toNumber(
    record.price ?? record.p ?? record.rate ?? record.value ?? record.limit_price
  );
  const size = toNumber(
    record.size ?? record.s ?? record.quantity ?? record.shares ?? record.amount
  );

  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
    return null;
  }

  return {
    price: roundTo(price, 6),
    size: roundTo(size, 4),
  };
}

function sumSizes(levels: OrderbookLevel[]): number {
  return levels.reduce((total, level) => total + level.size, 0);
}

function sumNotional(levels: OrderbookLevel[]): number {
  return levels.reduce((total, level) => total + level.price * level.size, 0);
}

function sumPair(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }

  return roundTo(left + right, 6);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    return Number.parseFloat(value);
  }
  return Number.NaN;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}
