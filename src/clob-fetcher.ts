import { ClobClient } from '@polymarket/clob-client';
import WebSocket from 'ws';
import { config, type AppConfig } from './config.js';
import { logger } from './logger.js';
import type { MarketCandidate } from './monitor.js';
import {
  asRecord,
  asString,
  roundTo,
  toFiniteNumberOrNull,
  type JsonRecord,
} from './utils.js';

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

type ClobChainId = ConstructorParameters<typeof ClobClient>[1];

const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

export class ClobFetcher {
  private readonly client: ClobClient;
  private readonly states = new Map<string, TokenBookSnapshot>();
  private readonly subscribedAssets = new Set<string>();
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | undefined;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;

  constructor(private readonly runtimeConfig: AppConfig = config) {
    this.client = new ClobClient(
      runtimeConfig.clob.host,
      runtimeConfig.chainId as ClobChainId
    );
  }

  async subscribeAssets(tokenIds: string[]): Promise<void> {
    const nextIds = tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean);
    if (nextIds.length === 0) {
      return;
    }

    for (const tokenId of nextIds) {
      this.subscribedAssets.add(tokenId);
    }

    if (this.isConnected) {
      this.sendSubscription(nextIds);
      return;
    }

    void this.ensureConnected().catch((error: any) => {
        logger.warn('CLOB WebSocket subscribe failed, REST fallback remains active', {
          message: error?.message || 'Unknown error',
        });
      });
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
    this.manualClose = true;
    this.clearReconnectTimer();
    this.stopPingInterval();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  private async getTokenSnapshot(tokenId: string): Promise<TokenBookSnapshot> {
    const cached = this.states.get(tokenId);
    if (cached) {
      const updatedMs = Date.parse(cached.updatedAt);
      if (
        Number.isFinite(updatedMs) &&
        Date.now() - updatedMs < this.runtimeConfig.clob.snapshotRefreshMs
      ) {
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

    const normalized = normalizeTokenBook(
      tokenId,
      orderbook,
      this.runtimeConfig.clob.bookDepthLevels
    );
    const nextState: TokenBookSnapshot = {
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
      const price = toFiniteNumberOrNull(record?.price ?? response);
      const size = toFiniteNumberOrNull(record?.size);
      return {
        price: price && price > 0 ? price : null,
        size: size && size > 0 ? size : null,
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
    this.manualClose = false;
    this.clearReconnectTimer();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.runtimeConfig.clob.wsUrl);
      this.ws = ws;

      const timeoutId = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          ws.close();
        }
        finish(new Error('WebSocket connection timeout'));
      }, WS_CONNECT_TIMEOUT_MS);
      timeoutId.unref?.();

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempt = 0;
        this.startPingInterval();
        if (this.subscribedAssets.size > 0) {
          this.sendSubscription(Array.from(this.subscribedAssets), true);
        }
        finish();
      });

      ws.on('message', (payload: WebSocket.Data) => {
        this.handleMessage(payload.toString());
      });

      ws.on('close', (code, reasonBuffer) => {
        const reason =
          typeof reasonBuffer === 'string'
            ? reasonBuffer
            : reasonBuffer?.toString?.() || 'Unknown reason';
        const wasConnected = this.isConnected;

        this.handleDisconnect();

        if (!settled) {
          finish(new Error(`WebSocket closed before ready (${code}: ${reason})`));
          return;
        }

        if (!this.manualClose && this.subscribedAssets.size > 0) {
          logger.warn('CLOB WebSocket closed, scheduling reconnect', {
            code,
            reason,
            wasConnected,
          });
          this.scheduleReconnect();
        }
      });

      ws.on('error', (error: Error) => {
        logger.warn('CLOB WebSocket error', {
          message: error.message,
        });

        if (!settled) {
          finish(error);
        }
      });
    });
  }

  private sendSubscription(tokenIds: string[], initialDump = false): void {
    if (!this.ws || !this.isConnected || tokenIds.length === 0) {
      return;
    }

    try {
      this.ws.send(
        JSON.stringify({
          type: 'market',
          assets_ids: tokenIds,
          initial_dump: initialDump || this.runtimeConfig.clob.initialDump,
        })
      );
    } catch (error: any) {
      logger.warn('CLOB WebSocket subscription send failed', {
        message: error?.message || 'Unknown error',
      });
      this.handleDisconnect();
      this.scheduleReconnect();
    }
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
    const nextState: TokenBookSnapshot = {
      ...existing,
      updatedAt: new Date().toISOString(),
      source: 'ws',
    };

    if (event === 'last_trade_price') {
      const price = toFiniteNumberOrNull(message.price);
      const size = toFiniteNumberOrNull(message.size);
      nextState.lastTradePrice = price && price > 0 ? price : nextState.lastTradePrice;
      nextState.lastTradeSize = size && size > 0 ? size : nextState.lastTradeSize;
    }

    if (message.bids || message.asks) {
      const normalized = normalizeTokenBook(
        tokenId,
        message,
        this.runtimeConfig.clob.bookDepthLevels
      );
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

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;
    this.stopPingInterval();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer || this.connectPromise) {
      return;
    }

    const delayMs = Math.min(
      WS_RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      WS_RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error: any) => {
        logger.warn('CLOB WebSocket reconnect attempt failed', {
          attempt: this.reconnectAttempt,
          message: error?.message || 'Unknown error',
        });
        this.scheduleReconnect();
      });
    }, delayMs);

    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export function computeCombinedBookMetrics(
  yes: Pick<TokenBookSnapshot, 'bestBid' | 'bestAsk' | 'midPrice'>,
  no: Pick<TokenBookSnapshot, 'bestBid' | 'bestAsk' | 'midPrice'>
): CombinedBookMetrics {
  const combinedBid = sumPair(yes.bestBid, no.bestBid);
  const combinedAsk = sumPair(yes.bestAsk, no.bestAsk);
  const combinedMid = sumPair(yes.midPrice, no.midPrice);
  const combinedDiscount = combinedAsk !== null ? roundTo(1 - combinedAsk, 6) : null;
  const combinedPremium = combinedBid !== null ? roundTo(combinedBid - 1, 6) : null;
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

function createEmptyState(tokenId: string): TokenBookSnapshot {
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

  const price =
    toFiniteNumberOrNull(
      record.price ?? record.p ?? record.rate ?? record.value ?? record.limit_price
    ) ?? Number.NaN;
  const size =
    toFiniteNumberOrNull(
      record.size ?? record.s ?? record.quantity ?? record.shares ?? record.amount
    ) ?? Number.NaN;

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
