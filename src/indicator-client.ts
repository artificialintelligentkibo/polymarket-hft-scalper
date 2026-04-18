import type { StructuredLogger } from './logger.js';

export type TrendDir = 'UP' | 'DOWN' | null;

export type Coin = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'BNB' | 'DOGE';

export interface RbLastEvent {
  type: string;
  ts: number;
  ageMs: number;
  price: number;
  levelRef: number;
}

export interface RbSnapshot {
  symbol: string;
  ts: number;
  lastBarCloseTs: number;
  fresh: boolean;
  trend: TrendDir;
  count: number;
  value: number;
  valueUpper: number;
  valueLower: number;
  valueUpperMid: number;
  valueLowerMid: number;
  channelPos: number;
  channelPosRaw: number;
  channelWidthPct: number;
  lastEvent: RbLastEvent | null;
  available: boolean;
}

export interface IndicatorClientOptions {
  readonly baseUrl: string;
  readonly symbols: string[];
  readonly pollIntervalMs?: number;
  readonly httpTimeoutMs?: number;
  readonly staleThresholdMs?: number;
  readonly logger?: StructuredLogger;
}

interface LevelsRaw {
  symbol: string;
  ts: number;
  lastBarCloseTs: number;
  fresh: boolean;
  barsProcessed: number;
  value: number;
  valueUpper: number;
  valueLower: number;
  valueUpperMid: number;
  valueLowerMid: number;
  trend: boolean;
  count: number;
  lastCrossUpper: number | null;
  lastCrossLower: number | null;
}

interface EventRaw {
  ts: number;
  symbol: string;
  eventType: string;
  price: number;
  levelRef: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_STALE_MS = 15_000;
const EVENT_BUFFER_SIZE = 50;
const HEALTH_WARN_INTERVAL_MS = 60_000;

const COIN_TO_SYMBOL: Record<Coin, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  BNB: 'BNBUSDT',
  DOGE: 'DOGEUSDT',
};

function isCoin(v: string): v is Coin {
  return v in COIN_TO_SYMBOL;
}

export class IndicatorClient {
  private readonly baseUrl: string;
  private readonly symbols: string[];
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly logger?: StructuredLogger;

  private readonly levels = new Map<string, LevelsRaw>();
  private readonly levelsFetchedAt = new Map<string, number>();
  private readonly events = new Map<string, EventRaw[]>();
  private readonly maxEventTsSeen = new Map<string, number>();

  private pollTimer: NodeJS.Timeout | null = null;
  private unreachableSinceMs: number | null = null;
  private lastUnreachableWarnAt = 0;
  private lastConnectedAt = 0;
  private running = false;

  constructor(opts: IndicatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.symbols = [...opts.symbols];
    this.pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = opts.httpTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.staleMs = opts.staleThresholdMs ?? DEFAULT_STALE_MS;
    this.logger = opts.logger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  healthStatus(): {
    freshCount: number;
    totalSymbols: number;
    unreachableMs: number;
    lastConnectedAt: number;
  } {
    const now = Date.now();
    let freshCount = 0;
    for (const s of this.symbols) {
      const f = this.levelsFetchedAt.get(s);
      if (f !== undefined && now - f <= this.staleMs) freshCount += 1;
    }
    return {
      freshCount,
      totalSymbols: this.symbols.length,
      unreachableMs: this.unreachableSinceMs === null ? 0 : now - this.unreachableSinceMs,
      lastConnectedAt: this.lastConnectedAt,
    };
  }

  getSnapshot(coin: string, spotPrice: number): RbSnapshot {
    const coinUpper = coin.toUpperCase();
    const symbol = isCoin(coinUpper) ? COIN_TO_SYMBOL[coinUpper] : coinUpper;
    const raw = this.levels.get(symbol);
    const fetchedAt = this.levelsFetchedAt.get(symbol) ?? 0;
    const now = Date.now();

    if (raw === undefined) {
      return this.unavailableSnapshot(symbol, now);
    }

    const available = now - fetchedAt <= this.staleMs;
    const width = raw.valueUpper - raw.valueLower;
    const channelPosRaw = width > 0 ? (spotPrice - raw.valueLower) / width : 0;
    const channelPos = Math.max(0, Math.min(1, channelPosRaw));
    const channelWidthPct = raw.value > 0 ? (width / raw.value) * 100 : 0;
    const eventsArr = this.events.get(symbol) ?? [];
    const last = eventsArr.length > 0 ? eventsArr[eventsArr.length - 1]! : null;
    const lastEvent: RbLastEvent | null = last === null
      ? null
      : {
          type: last.eventType,
          ts: last.ts,
          ageMs: now - last.ts,
          price: last.price,
          levelRef: last.levelRef,
        };

    return {
      symbol,
      ts: now,
      lastBarCloseTs: raw.lastBarCloseTs,
      fresh: raw.fresh,
      trend: raw.trend ? 'UP' : 'DOWN',
      count: raw.count,
      value: raw.value,
      valueUpper: raw.valueUpper,
      valueLower: raw.valueLower,
      valueUpperMid: raw.valueUpperMid,
      valueLowerMid: raw.valueLowerMid,
      channelPos,
      channelPosRaw,
      channelWidthPct,
      lastEvent,
      available,
    };
  }

  getEventsWithin(coin: string, windowMs: number): RbLastEvent[] {
    const coinUpper = coin.toUpperCase();
    const symbol = isCoin(coinUpper) ? COIN_TO_SYMBOL[coinUpper] : coinUpper;
    const buf = this.events.get(symbol) ?? [];
    const now = Date.now();
    const cutoff = now - windowMs;
    return buf
      .filter((e) => e.ts >= cutoff)
      .map((e) => ({
        type: e.eventType,
        ts: e.ts,
        ageMs: now - e.ts,
        price: e.price,
        levelRef: e.levelRef,
      }));
  }

  private unavailableSnapshot(symbol: string, now: number): RbSnapshot {
    return {
      symbol,
      ts: now,
      lastBarCloseTs: 0,
      fresh: false,
      trend: null,
      count: 0,
      value: 0,
      valueUpper: 0,
      valueLower: 0,
      valueUpperMid: 0,
      valueLowerMid: 0,
      channelPos: 0,
      channelPosRaw: 0,
      channelWidthPct: 0,
      lastEvent: null,
      available: false,
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      await this.pollOnce();
      const elapsed = Date.now() - startedAt;
      const delay = Math.max(0, this.pollMs - elapsed);
      if (!this.running) return;
      await new Promise<void>((resolve) => {
        this.pollTimer = setTimeout(() => resolve(), delay);
      });
    }
  }

  private async pollOnce(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const sym of this.symbols) {
      tasks.push(this.fetchLevels(sym));
      tasks.push(this.fetchEvents(sym));
    }
    await Promise.allSettled(tasks);

    const now = Date.now();
    let freshCount = 0;
    for (const s of this.symbols) {
      const f = this.levelsFetchedAt.get(s);
      if (f !== undefined && now - f <= this.staleMs) freshCount += 1;
    }

    if (freshCount > 0) {
      if (this.unreachableSinceMs !== null) {
        this.logger?.event('rb_client_reconnected', 'IndicatorClient reachable', {
          unreachableMs: now - this.unreachableSinceMs,
          freshCount,
        });
        this.unreachableSinceMs = null;
      }
      this.lastConnectedAt = now;
    } else {
      if (this.unreachableSinceMs === null) {
        this.unreachableSinceMs = now;
      }
      if (now - this.lastUnreachableWarnAt > HEALTH_WARN_INTERVAL_MS) {
        this.logger?.warn('IndicatorClient unreachable', {
          event: 'rb_client_unreachable',
          unreachableMs: now - (this.unreachableSinceMs ?? now),
        });
        this.lastUnreachableWarnAt = now;
      }
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchLevels(symbol: string): Promise<void> {
    try {
      const raw = (await this.fetchJson(`/levels/${symbol}`)) as LevelsRaw | { error: string };
      if (
        raw !== null &&
        typeof raw === 'object' &&
        'value' in raw &&
        typeof (raw as LevelsRaw).value === 'number'
      ) {
        this.levels.set(symbol, raw as LevelsRaw);
        this.levelsFetchedAt.set(symbol, Date.now());
      }
    } catch {
      /* swallow — caller handles via staleness tracking */
    }
  }

  private async fetchEvents(symbol: string): Promise<void> {
    try {
      const since = this.maxEventTsSeen.get(symbol) ?? 0;
      const raw = (await this.fetchJson(
        `/events/${symbol}?since=${since + 1}&limit=20`,
      )) as EventRaw[];
      if (!Array.isArray(raw) || raw.length === 0) return;

      const buf = this.events.get(symbol) ?? [];
      const seen = new Set(buf.map((e) => e.ts));
      for (const ev of raw) {
        if (!seen.has(ev.ts)) {
          buf.push(ev);
          seen.add(ev.ts);
        }
      }
      buf.sort((a, b) => a.ts - b.ts);
      while (buf.length > EVENT_BUFFER_SIZE) buf.shift();
      this.events.set(symbol, buf);

      let maxTs = since;
      for (const ev of buf) {
        if (ev.ts > maxTs) maxTs = ev.ts;
      }
      this.maxEventTsSeen.set(symbol, maxTs);
    } catch {
      /* swallow */
    }
  }
}

export function serializeRb(snap: RbSnapshot): Record<string, unknown> {
  return {
    trend: snap.trend,
    count: snap.count,
    channelPos: Number.isFinite(snap.channelPos) ? Number(snap.channelPos.toFixed(4)) : 0,
    channelPosRaw: Number.isFinite(snap.channelPosRaw) ? Number(snap.channelPosRaw.toFixed(4)) : 0,
    channelWidthPct: Number.isFinite(snap.channelWidthPct) ? Number(snap.channelWidthPct.toFixed(4)) : 0,
    lastEventType: snap.lastEvent ? snap.lastEvent.type : null,
    lastEventAgeMs: snap.lastEvent ? snap.lastEvent.ageMs : null,
    fresh: snap.fresh,
    available: snap.available,
    value: snap.value,
    valueUpper: snap.valueUpper,
    valueLower: snap.valueLower,
    valueUpperMid: snap.valueUpperMid,
    valueLowerMid: snap.valueLowerMid,
    lastBarCloseTs: snap.lastBarCloseTs,
  };
}
