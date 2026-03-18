# polymarket-hft-scalper

Dual-sided Polymarket CLOB market-maker for 5-minute markets. The runtime now combines:

- combined discount detection across both outcomes
- extreme buy / extreme sell zones
- fair-value mean reversion
- inventory rebalance on imbalance
- risk-enforced flatten, hard stop, and trailing take-profit
- post-only execution with urgency tiers and retry logic
- JSONL trade logs with signal metadata and slot-level PnL reporting

## Strategy Model

Priority order per tick:

1. `COMBINED_DISCOUNT_BUY_BOTH`
2. `EXTREME_BUY` / `EXTREME_SELL`
3. `FAIR_VALUE_BUY` / `FAIR_VALUE_SELL`
4. `INVENTORY_REBALANCE`

Risk exits override all of the above:

- `SLOT_FLATTEN`
- `HARD_STOP`
- `TRAILING_TAKE_PROFIT`
- `RISK_LIMIT`

The engine evaluates both `YES` and `NO` every cycle and executes at most `MAX_SIGNALS_PER_TICK=2`.

## Repository Layout

```text
src/
  clob-fetcher.ts
  config.ts
  index.ts
  logger.ts
  monitor.ts
  order-executor.ts
  position-manager.ts
  risk-manager.ts
  signal-scalper.ts
  slot-reporter.ts
  strategy-types.ts
  trader.ts
backtest/
  backtester.ts
comparison/
  compare-with-target.ts
  output/
tests/
  comparison.test.ts
  monitor.test.ts
  position-manager.test.ts
  risk-manager.test.ts
  signal-scalper.test.ts
```

## Key Configuration

Main strategy controls live in [src/config.ts](/C:/GitHub/polymarket-hft-scalper/src/config.ts):

- `MIN_COMBINED_DISCOUNT`
- `EXTREME_SELL_THRESHOLD`
- `EXTREME_BUY_THRESHOLD`
- `FAIR_VALUE_BUY_THRESHOLD`
- `FAIR_VALUE_SELL_THRESHOLD`
- `INVENTORY_IMBALANCE_THRESHOLD`
- `MAX_SIGNALS_PER_TICK`
- `PRICE_MULTIPLIER_LEVELS`
- `MAX_NET_YES=200`
- `MAX_NET_NO=250`
- `COINS_TO_TRADE=BTC,SOL,XRP`
- `FILTER_5MIN_ONLY=true`
- `MIN_LIQUIDITY_USD=500`

Sizing is now driven by:

- `priceMultiplier`
- `fillRatio`
- `capitalClamp`

## Runtime Flow

The main loop in [src/index.ts](/C:/GitHub/polymarket-hft-scalper/src/index.ts) runs:

1. Gamma `/events` pagination with `limit` + `offset`, `tag_id=21`, and upcoming-slot ordering by end time
2. robust Gamma normalization using `clobTokenIds`, `outcomes`, `question/title/slug`, `startTime` / `eventStartTime`, and start/end timestamps
3. whitelist filter via `WHITELIST_CONDITION_IDS` in `TEST_MODE`, otherwise dynamic `COINS_TO_TRADE` + optional 5-minute slot filter
4. duration-first 5-minute detection with title / slug fallbacks
5. orderbook sync from CLOB WebSocket + REST fallback
6. risk assessment
7. top-2 signal generation
8. post-only / improve / cross execution
9. JSONL trade logging
10. slot-end console reporting

## Slot Reports

The slot reporter aggregates realized PnL per slot and prints:

- `Up PNL`
- `Down PNL`
- `NET PNL`
- `TOTAL DAY PNL`

This is triggered when the monitor emits `slot-ended` and also during graceful shutdown.

## Running

Install dependencies:

```bash
npm install
```

Create your env file:

```bash
cp .env.example .env
```

Dry-run / simulation test:

```bash
TEST_MODE=true
SIMULATION_MODE=true
DRY_RUN=true
WHITELIST_CONDITION_IDS=0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0,0x3756c929609555f5b6cd8a8231d083400ea92397873fcd5ca24182186766e2e7
npm start
```

Dynamic 5-minute crypto slot scan for BTC / SOL / XRP:

```bash
TEST_MODE=false
WHITELIST_CONDITION_IDS=
COINS_TO_TRADE=BTC,SOL,XRP
FILTER_5MIN_ONLY=true
MIN_LIQUIDITY_USD=500
npm start
```

One-liner:

```bash
COINS_TO_TRADE=BTC,SOL,XRP FILTER_5MIN_ONLY=true npm start
```

Add `ETH` if you want:

```bash
COINS_TO_TRADE=BTC,SOL,XRP,ETH FILTER_5MIN_ONLY=true npm start
```

In `TEST_MODE=true`, the runtime ignores the coin filter and only trades markets from `WHITELIST_CONDITION_IDS`.

Dynamic scan no longer depends on a stale manual whitelist. Out of the box it:

- pages Gamma `/events` until enough active crypto candidates are collected or the safety cap is reached
- orders active crypto events by the nearest ending slots first so recurring `Up or Down` markets are surfaced early
- normalizes current payloads that expose token IDs via `clobTokenIds`
- prefers recurring slot timestamps from `startTime` / `eventStartTime` instead of treating market `startDate` as the slot open
- matches `BTC|Bitcoin`, `ETH|Ethereum`, `SOL|Solana`, `XRP` with strict whole-word regexes
- detects 5-minute markets primarily from parsed duration (`<= 5.5m`) and secondarily from `Up or Down` / clock-range / slug hints

Live-like runtime without simulation:

```bash
SIMULATION_MODE=false
TEST_MODE=false
DRY_RUN=false
npm start
```

## Backtest

The backtester now groups both outcomes into a single paired market snapshot and reports:

- realized and total PnL
- slot PnL
- win-rate per signal type
- forced exit count
- Sharpe based on slot-level returns
- optional comparison with observed trade logs

Run:

```bash
npm run backtest -- backtest/data/sample.jsonl
```

Compare against observed trades:

```bash
npm run backtest -- backtest/data/sample.jsonl path/to/observed-trades.jsonl
```

## Comparison With Target Wallet

Use the comparison module when you want to see how closely the scalper reproduces the original `vague-sourdough` trade stream from the copy-bot logs.

What it does:

- finds the newest copy-bot log in `../polymarket-copy-bot/logs/trades_*.jsonl` by default
- finds the newest scalper log in `./logs/trades_*.jsonl` or falls back to `./logs/scalper_*.log`
- filters both sides to the last `2` hours by default
- matches trades by `market_condition_id` plus an `8s` timestamp tolerance
- classifies each comparison row as `MATCH`, `NEAR`, `MISS`, `ONLY_TARGET`, or `ONLY_OURS`
- writes both `comparison/output/last_comparison.csv` and `comparison/output/last_comparison.md`

Run it:

```bash
npm run compare
```

Change the lookback window:

```bash
npm run compare -- --hours=6
```

If the target log lives somewhere else, set:

```bash
COMPARISON_TARGET_LOG_PATH=/absolute/path/to/trades_2026-03-18.jsonl
```

The console summary shows:

- target trade count in window
- our trade count in window
- status counts
- overall match rate defined as `(MATCH + NEAR) / total comparison rows`

## Tests

```bash
npm test
```

Current test coverage focuses on:

- Gamma event pagination and event -> market flattening
- current Gamma payload normalization with `clobTokenIds`
- strict coin matching and 5-minute detection
- target-vs-scalper trade normalization and tolerant comparison matching
- whitelist-vs-dynamic selection behavior
- combined discount dual-entry behavior
- inventory rebalance generation
- position risk caps
- slot-end flattening

## Logging

Trade JSONL logs now include:

- `signalType`
- `edgeAmount`
- `combinedBid`
- `combinedAsk`
- `combinedMid`
- `combinedDiscount`
- `combinedPremium`
- `fillRatio`
- `capitalClamp`
- `priceMultiplier`
- `urgency`
- `wasMaker`
- `inventoryImbalance`
- `grossExposureShares`
- full PnL snapshot

## Notes

- There is no external database; state is in-memory and JSONL only.
- Graceful shutdown calls `cancelAllOrders()` and then flattens inventory.
- `TEST_MODE`, `SIMULATION_MODE`, and `DRY_RUN` all bypass live execution.
