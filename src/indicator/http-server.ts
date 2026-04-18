import Fastify, { type FastifyInstance } from 'fastify';
import type { IndicatorLogger } from './logger.js';
import type { SnapshotStore } from './snapshot-writer.js';

export interface HttpServerDeps {
  readonly store: SnapshotStore;
  readonly logger: IndicatorLogger;
  readonly expectedSymbols: readonly string[];
  readonly isBootstrapped: (symbol: string) => boolean;
  readonly wsConnected: () => boolean;
}

export interface HttpServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly deps: HttpServerDeps;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { store, expectedSymbols, isBootstrapped, wsConnected } = opts.deps;

  app.get('/health', async (_req, reply) => {
    const bootstrap: Record<string, boolean> = {};
    let allBootstrapped = true;
    for (const s of expectedSymbols) {
      const done = isBootstrapped(s);
      bootstrap[s] = done;
      if (!done) allBootstrapped = false;
    }
    const ok = allBootstrapped && wsConnected();
    reply.code(ok ? 200 : 503);
    return {
      ok,
      symbols: [...expectedSymbols],
      bootstrapComplete: bootstrap,
      wsConnected: wsConnected(),
    };
  });

  app.get<{ Params: { symbol: string } }>('/levels/:symbol', async (req, reply) => {
    const symbol = req.params.symbol.toUpperCase();
    const snap = store.getCached(symbol);
    if (snap === undefined) {
      reply.code(404);
      return { error: 'symbol_unknown_or_not_bootstrapped', symbol };
    }
    return {
      symbol: snap.symbol,
      ts: snap.ts,
      lastBarCloseTs: snap.lastBarCloseTs,
      fresh: snap.fresh,
      barsProcessed: snap.barsProcessed,
      value: snap.value,
      valueUpper: snap.valueUpper,
      valueLower: snap.valueLower,
      valueUpperMid: snap.valueUpperMid,
      valueLowerMid: snap.valueLowerMid,
      trend: snap.trend,
      count: snap.count,
      lastCrossUpper: snap.lastCrossUpper,
      lastCrossLower: snap.lastCrossLower,
    };
  });

  app.get<{ Params: { symbol: string }; Querystring: { since?: string; limit?: string } }>(
    '/events/:symbol',
    async (req, reply) => {
      const symbol = req.params.symbol.toUpperCase();
      const since = Number(req.query.since ?? 0);
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100), 1000);
      if (!expectedSymbols.map((s) => s.toUpperCase()).includes(symbol)) {
        reply.code(404);
        return { error: 'symbol_unknown', symbol };
      }
      return store.queryEvents(symbol, Number.isFinite(since) ? since : 0, limit);
    },
  );

  await app.listen({ port: opts.port, host: opts.host ?? '127.0.0.1' });
  opts.deps.logger.info('http_listening', { port: opts.port, host: opts.host ?? '127.0.0.1' });
  return app;
}
