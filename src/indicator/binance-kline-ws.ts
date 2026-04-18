import WebSocket from 'ws';
import type { OneSecondKline } from './aggregator.js';
import type { IndicatorLogger } from './logger.js';

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

interface CombinedStreamMessage {
  stream?: string;
  data?: {
    e?: string;
    s?: string;
    k?: {
      t: number; // open time
      T: number; // close time
      s: string; // symbol
      i: string; // interval
      o: string;
      c: string;
      h: string;
      l: string;
      v: string;
      x: boolean; // is closed
    };
  };
}

export interface KlineStreamOptions {
  readonly wsUrl: string;
  readonly symbols: readonly string[];
  readonly sourceInterval: string;
  readonly logger: IndicatorLogger;
  readonly onClosedKline: (symbol: string, kline: OneSecondKline) => void;
}

export class BinanceKlineStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;

  constructor(private readonly opts: KlineStreamOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get reconnects(): number {
    return this.reconnectCount;
  }

  private buildUrl(): string {
    const streams = this.opts.symbols
      .map((s) => `${s.toLowerCase()}@kline_${this.opts.sourceInterval}`)
      .join('/');
    return `${this.opts.wsUrl}/stream?streams=${streams}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.buildUrl();
    this.opts.logger.info('ws_connecting', { url });
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.opts.logger.info('ws_open', { symbols: this.opts.symbols });
      this.backoffMs = BACKOFF_INITIAL_MS;
    });

    ws.on('message', (raw) => this.handleMessage(raw));

    ws.on('error', (err) => {
      this.opts.logger.warn('ws_error', { message: (err as Error).message });
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.() ?? '';
      this.opts.logger.warn('ws_close', { code, reason });
      this.ws = null;
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: unknown): void {
    let parsed: CombinedStreamMessage;
    try {
      parsed = JSON.parse(raw instanceof Buffer ? raw.toString('utf8') : String(raw));
    } catch (err) {
      this.opts.logger.warn('ws_parse_error', { message: (err as Error).message });
      return;
    }
    const k = parsed?.data?.k;
    if (!k || !k.x) return; // only interested in closed 1s klines
    const symbol = (parsed.data?.s ?? k.s ?? '').toUpperCase();
    if (!symbol) return;
    const kline: OneSecondKline = {
      openTime: k.t,
      closeTime: k.T,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    };
    try {
      this.opts.onClosedKline(symbol, kline);
    } catch (err) {
      this.opts.logger.error('ws_handler_error', { message: (err as Error).message, symbol });
    }
  }

  private scheduleReconnect(): void {
    this.reconnectCount += 1;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.opts.logger.info('ws_reconnect_scheduled', { delayMs: delay, totalReconnects: this.reconnectCount });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
