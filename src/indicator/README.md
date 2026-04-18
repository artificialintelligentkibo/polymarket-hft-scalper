# Range Breakout Indicator Service

Separate PM2 app `range-indicator`. Consumes Binance 1s klines, aggregates into
boundary-aligned 10s bars, converts to Heikin-Ashi, runs the Pine v6 "Range
Breakout Discontinuous" state machine, and exposes current levels over HTTP.

Infrastructure only. The main bot does not currently read from this service.

## Process separation

- Runs as its own Node process under PM2 (`ecosystem.config.cjs` app `range-indicator`)
- Opens its own WebSocket to `wss://stream.binance.com:9443` (kline streams only;
  independent of the main bot's depth WS)
- Writes to its own SQLite file at `./data/indicator.db`
- Serves HTTP on `127.0.0.1:${INDICATOR_HTTP_PORT}` (default 7788), localhost-only

## Data flow

```
Binance 1s kline WS ──> BarAggregator (1s → 10s, boundary-aligned)
                            │
                            ▼
                     toHeikinAshi (10s OHLC → HA)
                            │
                            ▼
                  RangeBreakoutEngine (Pine v6 state machine)
                            │
                   ┌────────┴────────┐
                   ▼                 ▼
            SnapshotStore      RangeEvent[]
             (SQLite +             │
              in-memory            ▼
              cache)          SnapshotStore.events
                   │
                   ▼
             HTTP /levels/:symbol ◄── main bot (future phase)
```

## Bootstrap

On startup, per symbol:

1. Paginate `/api/v3/klines?interval=1s&limit=1000` backwards to fetch
   `INDICATOR_BOOTSTRAP_BARS` 1s klines (default 6000, ~100 min).
2. Aggregate to boundary-aligned 10s bars.
3. Apply HA + state machine sequentially.
4. Mark `bootstrapComplete=true` and drain any live WS klines that arrived during
   bootstrap.

Bootstrap budget: 6 coins × 6 REST calls × weight 5 = 180 weight. 1m limit is 6000.

## HTTP API

- `GET /health` → `{ok, symbols, bootstrapComplete, wsConnected}`. 503 until all
  symbols bootstrapped and WS connected.
- `GET /levels/:symbol` → current 5 levels + freshness flag. 404 if unknown symbol.
- `GET /events/:symbol?since=<ts>&limit=100` → last N events.

## Configuration

All `INDICATOR_*` env vars listed in `.env.example`. Defaults match the Pine v6
reference (channelWidth=4.0, atrLen=200, smaLen=100, warmupBars=301).

## SQLite schema

Two tables: `levels` (per-second snapshots, 5h retention) and `events` (bull/bear
breaks + signals, 24h retention). Cleanup sweep every 5 minutes.

Storage projection: ~6 rows/sec in `levels` × 5h ≈ 108k rows ≈ 15 MB steady state.

## Algorithm notes

The `RangeBreakoutEngine` ports the supplied Pine v6 indicator. Key details:

- ATR is Wilder's RMA over `atrLen` of TR on HA bars.
- The "smoothed ATR" used for channel width is an SMA over `smaLen` of the RMA
  series. Width = smoothedAtr × channelWidth.
- Seed fires on the first bar where `barIndex >= warmupBars` AND smoothedAtr is
  defined (the Pine `bar_index == seedBar` constraint is lifted for robustness
  since this service has no MQ5 lookback emulation).
- On reset (cross_upper / cross_lower / count ≥ maxCount), the channel re-seeds
  at current hl2 and the count resets.
- Signals (buy/sell/fakeout) are emitted for logging only; no trading decisions
  happen in this service.

## Running

Local dev:

```
# Ensure ./data exists or let the service create it
tsx src/indicator/index.ts
```

Production (VPS):

```
pm2 start ecosystem.config.cjs --only range-indicator
pm2 logs range-indicator
```

## Debugging

- `curl -s localhost:7788/health | jq` — overall state
- `curl -s localhost:7788/levels/BTCUSDT | jq` — current levels
- Pretty-print pino-style logs: `pm2 logs range-indicator | jq -c .`
- Inspect persisted rows: `sqlite3 data/indicator.db "SELECT * FROM levels WHERE symbol='BTCUSDT' ORDER BY ts DESC LIMIT 5"`
