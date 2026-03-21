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
  product-test-mode.ts
  reports.ts
  auto-redeemer.ts
  binance-edge.ts
  risk-manager.ts
  signal-scalper.ts
  slot-reporter.ts
  status-monitor.ts
  strategy-types.ts
  trader.ts
backtest/
  backtester.ts
comparison/
  compare-with-target.ts
  output/
reports/
  .gitignore
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
- `MIN_ENTRY_DEPTH_USD`
- `MAX_ENTRY_SPREAD`
- `ENTRY_IMBALANCE_BLOCK_THRESHOLD`
- `MAX_DRAWDOWN_USDC`
- `HARD_STOP_COOLDOWN_MS`
- `INVENTORY_IMBALANCE_THRESHOLD`
- `MAX_SIGNALS_PER_TICK`
- `PRICE_MULTIPLIER_LEVELS`
- `MAX_NET_YES=200`
- `MAX_NET_NO=250`
- `COINS_TO_TRADE=BTC,SOL,XRP,ETH`
- `FILTER_5MIN_ONLY=true`
- `MIN_LIQUIDITY_USD=500`
- `AUTO_REDEEM=false`
- `REDEEM_INTERVAL_MS=30000`
- `PRODUCT_TEST_MODE=false`
- `TEST_MIN_TRADE_USDC=1`
- `TEST_MAX_SLOTS=1`
- `STATUS_CHECK_INTERVAL_MS=300000`
- `AUTO_PAUSE_ON_INCIDENT=true`
- `PAUSE_GRACE_PERIOD_MS=60000`
- `BINANCE_EDGE_ENABLED=false`
- `BINANCE_FLAT_THRESHOLD=0.05`
- `BINANCE_STRONG_THRESHOLD=0.20`
- `BINANCE_BOOST_MULTIPLIER=1.5`
- `BINANCE_REDUCE_MULTIPLIER=0.5`
- `POLYMARKET_API_KEY=...`
- `POLYMARKET_API_KEY_ADDRESS=...`
- `POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com`
- `REPORTS_DIR=./reports`
- `LATENCY_LOG=./reports/latency_YYYY-MM-DD.log`
- `STATE_FILE=./reports/state.json`
- `REPORTS_FOLDER=./reports`
- `REPORTS_FILE_PREFIX=slot-reports`

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
11. background gasless auto-redeem for resolved proxy-wallet positions
12. Polymarket status monitoring with auto-pause / auto-resume
13. optional Binance latency-edge post-filter for entry signals

## Reports

Slot reports still print to the console exactly as before, and are now also duplicated into `./reports/slot-reports_YYYY-MM-DD.log`.

Latency metrics are written separately to `./reports/latency_YYYY-MM-DD.log`.

What goes into `reports/`:

- slot report blocks duplicated from the console stream
- `Up PNL`
- `Down PNL`
- `NET PNL`
- `TOTAL DAY PNL`
- persisted `state.json` with day PnL / peak PnL / drawdown for restart-safe risk limits
- `runtime-status.json` for the CLI (`scalper status`) with current mode, PID, active slots, recent signals, and last slot report
- per-signal latency lines with `signalToOrderMs` and `roundTripMs`
- gasless redeem activity in `redeem_log_YYYY-MM-DD.log`
- product-test coverage summaries in `product-test-summary_YYYY-MM-DD.log`
- Polymarket incident events in `status-incidents.log`

The runtime creates `REPORTS_DIR` automatically when needed.

Example block:

```text
[2026-03-18 14:04:43] === SLOT REPORT ===
Slot                           | Market                  | Entries | Fills |    Up PNL |  Down PNL |    NET PNL
Solana 10:00-10:05             | 0x5f34c201...           |       3 |     5 |    +46.02 |      -5.91 |    +40.10
XRP 10:00-10:05                | 0xcb43642c...           |       2 |     4 |     -0.54 |     +67.61 |    +67.06
TOTAL DAY PNL: +390.53 | PEAK PNL: +412.10 | DRAWDOWN: -21.57
```

Example latency line:

```text
[2026-03-18 14:04:43] signal=FAIR_VALUE_BUY market=0xabc... title="Bitcoin Up or Down" side=BUY outcome=YES signalToOrderMs=42 roundTripMs=97 orderId=sim-buy-123 simulation=true dryRun=true testMode=false
```

Example redeem line:

```text
[2026-03-18 14:05:12] status=REDEEMED conditionId=0xabc... title="Bitcoin Up or Down - Mar 18, 2:00PM-2:05PM ET" txId=019... txHash=0xdef... state=STATE_CONFIRMED shares=28.0000 relayType=PROXY
```

Example product-test summary:

```text
[2026-03-19 10:05:42] PRODUCT TEST SUMMARY - PASSED 9/9 features
Slot: Bitcoin Up or Down - Mar 19, 10:00AM-10:05AM ET | conditionId=0xabc...
Tested: FAIR_VALUE_BUY, FAIR_VALUE_SELL, EXTREME_BUY, EXTREME_SELL, INVENTORY_REBALANCE, TRAILING_TAKE_PROFIT, HARD_STOP, SLOT_FLATTEN, AUTO_REDEEM
Final PnL: +$3.24 | Redeemed: +$12.87
Avg latency: 214ms | Day PnL: +$3.24 | Drawdown: -$0.00
Success rate: 100.00%
Status: PASSED
```

## Auto Redeem

Resolved 5-minute slots can now be redeemed automatically through Polymarket's gasless relayer when the runtime is operating in proxy-wallet mode.

Behavior:

- polls the Data API every `REDEEM_INTERVAL_MS` for `redeemable=true` positions under the configured proxy wallet
- groups redeemable rows by `conditionId`
- submits a gasless redeem through the official Polymarket relayer client
- writes append-only activity to `./reports/redeem_log_YYYY-MM-DD.log`

Guardrails:

- runs only when `AUTH_MODE=PROXY`
- automatically stays disabled in `SIMULATION_MODE`, `TEST_MODE`, and `DRY_RUN`
- uses the proxy wallet from `FUNDER_ADDRESS` for Data API polling
- uses the configured signer key to sign the relayer request
- authenticates relayer `/submit` with `POLYMARKET_API_KEY` and `POLYMARKET_API_KEY_ADDRESS`

Helper command:

```bash
npm run reports
```

## CLI Control

The repo now ships with a single `scalper` CLI so you can manage the bot without hand-editing `.env` for every run.

Install dependencies first:

```bash
npm install
```

Available commands:

```bash
npm run scalper -- status
npm run scalper -- dashboard
npm run scalper -- start
npm run scalper -- stop
npm run scalper -- pause
npm run scalper -- resume
npm run scalper -- monitor
npm run scalper -- monitor --watch
npm run scalper -- reset
npm run scalper -- switch --mode simulation
npm run scalper -- switch --mode product_test
npm run scalper -- switch --mode production
```

What each command does:

- `scalper reset`
  Deletes today’s files from `./logs/` and `./reports/`, resets persisted day PnL / drawdown state to zero, clears runtime status, and stops the bot first so in-memory positions and slot-report state are dropped safely.
- `scalper switch --mode simulation`
  Updates `.env` to safe dry-run simulation settings, then restarts the bot.
- `scalper switch --mode product_test`
  Updates `.env` to tiny-size live `PRODUCT_TEST_MODE` settings, then restarts the bot.
- `scalper switch --mode production`
  Updates `.env` to live production settings, then restarts the bot.
- `scalper start`
  Stops any existing `polymarket-scalper` process, then starts the bot in the background with `pm2` when available. If `pm2` is not installed, it falls back to `nohup` on Unix-like systems or a detached background process otherwise.
- `scalper stop`
  Sends a graceful stop so the runtime can cancel open orders and flatten through its normal shutdown path.
- `scalper pause`
  Forces the bot into pause mode. New entries are blocked, but safety exits and redeem continue to work.
- `scalper resume`
  Clears a manual pause and lets the bot resume entries if there is no active Polymarket incident.
- `scalper monitor`
  Runs a one-shot Polymarket status check and prints any active incidents that match trading-impact keywords.
- `scalper monitor --watch`
  Launches the live terminal monitor/dashboard and refreshes it continuously.
- `scalper dashboard`
  Opens the live runtime dashboard directly. The screen is styled like a trading console and shows active markets, current positions, performance stats, pause state, and recent signals from `runtime-status.json`.

Example:

```bash
npm run scalper -- dashboard
```
- `scalper status`
  Prints a colorized summary with running state, PID, current mode, pause status, day PnL, active slots, last slot report, average latency, and the last 3 executed signals.

## System Status Monitor

The runtime now polls `https://status.polymarket.com/summary.json` every `STATUS_CHECK_INTERVAL_MS`.

If an active incident mentions CLOB, order flow, confirmation delays, latency, API issues, inserts, or execution problems, the bot:

- prints a large red warning in the console
- writes an entry to `./reports/status-incidents.log`
- pauses new entries automatically
- keeps safety exits (`HARD_STOP`, `TRAILING_TAKE_PROFIT`, `SLOT_FLATTEN`, risk flatten) and redeem enabled

When incidents clear, the bot auto-resumes after `PAUSE_GRACE_PERIOD_MS`.

## Binance Latency Edge

`BINANCE_EDGE_ENABLED=true` enables a Binance WebSocket enhancement layer on top of the existing Polymarket signal engine.

What it does:

- subscribes to Binance `@miniTicker` spot streams
- snapshots Binance price at slot open per coin / slot
- compares current Binance move vs Polymarket `YES` mid
- boosts, reduces, or blocks entry signals after they are generated
- never blocks reduce-only safety exits

Relevant env vars:

```bash
BINANCE_EDGE_ENABLED=false
BINANCE_SYMBOLS=btcusdt,ethusdt,solusdt,xrpusdt,dogeusdt,bnbusdt,linkusdt
BINANCE_FLAT_THRESHOLD=0.05
BINANCE_STRONG_THRESHOLD=0.20
BINANCE_BOOST_MULTIPLIER=1.5
BINANCE_REDUCE_MULTIPLIER=0.5
BINANCE_BLOCK_STRONG_CONTRA=true
```

The CLI reads `.env` if present; otherwise it seeds settings from `.env.example` and writes the first real `.env` during `scalper switch`.

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
AUTO_REDEEM=true
REDEEM_INTERVAL_MS=30000
POLYMARKET_API_KEY=your-relayer-api-key
POLYMARKET_API_KEY_ADDRESS=0xYourKeyOwnerAddress
npm start
```

One-liner:

```bash
COINS_TO_TRADE=BTC,SOL,XRP FILTER_5MIN_ONLY=true npm start
```

## Product Test Mode (Safe Live Testing)

`PRODUCT_TEST_MODE` is a live safety overlay for validating the full runtime against a real 5-minute market with tiny size.

What it does:

- overrides `SIMULATION_MODE` and `DRY_RUN`, so real post-only gasless orders are placed
- pins the runtime to a single active 5-minute slot
- keeps size tiny with a `$1` target and a hard safety clamp around `1-3` shares / roughly `$1-3` notional per order
- caps inventory to `YES<=30` and `NO<=40`
- never crosses the spread in this mode; `cross` urgency is downgraded to `improve`
- waits for slot flatten, then tracks gasless auto-redeem and writes a dedicated summary file

Requirements:

- `AUTH_MODE=PROXY`
- `AUTO_REDEEM=true`
- valid `SIGNER_PRIVATE_KEY`, `FUNDER_ADDRESS`, `POLYMARKET_API_KEY`, and `POLYMARKET_API_KEY_ADDRESS`

Run:

```bash
PRODUCT_TEST_MODE=true
SIMULATION_MODE=true
DRY_RUN=true
TEST_MODE=false
COINS_TO_TRADE=BTC,SOL,XRP
FILTER_5MIN_ONLY=true
AUTH_MODE=PROXY
SIGNATURE_TYPE=1
AUTO_REDEEM=true
TEST_MIN_TRADE_USDC=1
TEST_MAX_SLOTS=1
npm start
```

You can also launch it as a one-liner:

```bash
PRODUCT_TEST_MODE=true npm start
```

When enabled, the bot will stop after the selected slot is summarized in `./reports/product-test-summary_YYYY-MM-DD.log`.

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
- skips degenerate entry books with missing bids/asks, negligible ask depth, or spreads above `MAX_ENTRY_SPREAD`
- halts new entries once persisted day drawdown breaches `MAX_DRAWDOWN_USDC`

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
- `slotEntryCount`
- `slotFillCount`
- `upExposureUsd`
- `downExposureUsd`
- `dayPnl`
- `peakDayPnl`
- `dayDrawdown`
- full PnL snapshot

## Notes

- There is no external database; runtime state is in-memory plus small files in `reports/` such as `state.json`.
- Graceful shutdown calls `cancelAllOrders()` and then flattens inventory.
- `TEST_MODE`, `SIMULATION_MODE`, and `DRY_RUN` all bypass live execution.
