# Configuration Reference

This repository now has a layered configuration model. The most important thing to understand is that not every flag is equal:

1. runtime mode flags decide whether you are simulating, product-testing, or trading live
2. `ACTIVE_STRATEGY` can override several engine flags
3. per-engine settings tune behavior inside that preset
4. shared execution, risk, and dashboard settings apply across the whole platform

Source of truth:

- [src/config.ts](../src/config.ts)
- [README.md](../README.md)
- [STRATEGY_GUIDE.md](./STRATEGY_GUIDE.md)
- [STRATEGY_LAYERS.md](./STRATEGY_LAYERS.md)

## Configuration Precedence

At startup the runtime follows this order:

1. load `.env`
2. parse and clamp values in `createConfig()`
3. apply `ACTIVE_STRATEGY` preset overrides
4. expose nested engine configs such as `sniper`, `obiEngine`, and `vsEngine`
5. derive runtime/dashboard state from the final config

The practical consequence is simple: if `ACTIVE_STRATEGY` disables a layer, the raw flag you set below it may no longer matter.

## Runtime Modes

| Variables | Meaning |
|---|---|
| `SIMULATION_MODE=true`, `DRY_RUN=true` | No real orders. Safest first-run mode. |
| `PRODUCT_TEST_MODE=true`, `SIMULATION_MODE=false`, `DRY_RUN=false` | Real orders with constrained rollout. |
| `SIMULATION_MODE=false`, `DRY_RUN=false`, `PRODUCT_TEST_MODE=false` | Normal production. |
| `TEST_MIN_TRADE_USDC`, `TEST_MAX_SLOTS` | Product-test sizing and scope. |
| `ENABLE_SIGNAL` | Master gate for entry generation. |
| `AUTO_REDEEM`, `REDEEM_INTERVAL_MS` | Automatic redeem loop after settlement. |

Recommended usage:

- start in simulation for credential and dashboard validation
- use product test for first live rollout
- only then promote to production

## Strategy Presets

`ACTIVE_STRATEGY` is the main top-level selector.

| Preset | Runtime behavior |
|---|---|
| `CURRENT_SNIPER` | No preset override. Best treated as manual compatibility mode. |
| `ORDER_BOOK_IMBALANCE` | Enables `OBI`, disables sniper/latency/paired arb, disables regular `MM_QUOTE`, keeps Binance feed only when needed for OBI gate or `VS_ENGINE`. |
| `PAIRED_ARBITRAGE` | Enables paired arb only, disables directional engines and regular MM, disables Binance edge signals. |
| `ALL` | Enables `OBI + SNIPER`, keeps `VS_ENGINE` if explicitly enabled, disables regular `MM_QUOTE`, disables paired arb and latency momentum, and can be combined with `LOTTERY_LAYER_ENABLED=true` for follow-on tickets. |

Important preset rules from the code:

- `ORDER_BOOK_IMBALANCE` forces `POST_ONLY_ONLY=true`
- `ORDER_BOOK_IMBALANCE` disables regular `MARKET_MAKER_MODE` and `DYNAMIC_QUOTING_ENABLED`
- `ALL` also disables regular `MARKET_MAKER_MODE` and `DYNAMIC_QUOTING_ENABLED`
- `VS_ENGINE` is preserved through `ORDER_BOOK_IMBALANCE` and `ALL` if `VS_ENGINE_ENABLED=true`
- `CURRENT_SNIPER` does not guarantee sniper-only behavior; it simply leaves your other flags alone

## Market Universe And Feeds

These variables decide what the platform looks at and which external feeds it maintains.

| Variable | Purpose |
|---|---|
| `COINS_TO_TRADE` | Coin universe, for example `BTC,ETH,SOL,XRP,BNB,DOGE` |
| `FILTER_5MIN_ONLY` | Restricts scanning to 5-minute markets |
| `MIN_LIQUIDITY_USD` | Global market-liquidity floor before most engines care |
| `WHITELIST_CONDITION_IDS` | Optional allow-list for exact condition IDs |
| `BINANCE_EDGE_ENABLED` | Enables Binance edge assessment used by sniper and related logic |
| `BINANCE_SYMBOLS` | Binance instruments to subscribe to |
| `BINANCE_WS_ENABLED` | Maintains Binance WebSocket feed |
| `DEEP_BINANCE_MODE` | Enables deeper Binance integration for richer signals and OBI/VS support |
| `BINANCE_DEPTH_LEVELS` | Futures/depth retention size |
| `BINANCE_FUNDING_WEIGHT` | Deep Binance fair-value blend weight |
| `MIN_BINANCE_SPREAD_THRESHOLD` | Blocks usage when Binance spread quality is too poor |
| `DYNAMIC_SPREAD_VOL_FACTOR` | Widens MM behavior under volatility |
| `BINANCE_FAIR_VALUE_WEIGHT`, `POLYMARKET_FAIR_VALUE_WEIGHT` | Blend weights for deep fair value |

Wallet refresh and infrastructure controls:

| Variable | Purpose |
|---|---|
| `WALLET_POSITION_REFRESH_MS` | Position refresh cadence |
| `WALLET_FUNDS_REFRESH_MS` | Wallet-funds cache/refresh cadence |
| `WALLET_FUNDS_REFRESH_INTERVAL_MS` | Interval used by runtime funds polling |
| `MARKET_SCAN_INTERVAL_MS` | Main scan loop cadence |
| `MARKET_QUERY_LIMIT` | Query size against market source |
| `MAX_CONCURRENT_MARKETS` | Max markets processed per loop |

## Sniper And Legacy Directional Engine

The sniper path is the Binance-led aggressive directional engine. It lives alongside the older legacy directional signals in `signal-scalper.ts`, but the sniper-specific engine is the important modern path.

Core sniper variables:

| Variable | Purpose |
|---|---|
| `SNIPER_MODE_ENABLED` | Master switch |
| `SNIPER_MIN_BINANCE_MOVE_PCT` | Minimum Binance move before evaluation |
| `SNIPER_STRONG_BINANCE_MOVE_PCT` | Bigger move threshold for stronger size |
| `SNIPER_MIN_EDGE_AFTER_FEES` | Minimum edge after fees |
| `SNIPER_TAKER_FEE_PCT` | Taker-fee assumption |
| `SNIPER_MIN_ENTRY_PRICE`, `SNIPER_MAX_ENTRY_PRICE` | Entry price band |
| `SNIPER_MIN_PM_LAG` | Minimum Polymarket lag versus Binance |
| `SNIPER_BASE_SHARES`, `SNIPER_STRONG_SHARES` | Base and strong clip sizes |
| `SNIPER_MAX_POSITION_SHARES` | Per-market cap |
| `SNIPER_MAX_CONCURRENT_SAME_DIRECTION` | Same-direction capacity within a slot |
| `SNIPER_COOLDOWN_MS` | Per-market cooldown |
| `SNIPER_SLOT_WARMUP_MS` | Ignore slot-open noise |
| `SNIPER_EXIT_BEFORE_END_MS` | Stop entering near slot end |
| `SNIPER_MAX_HOLD_MS` | Optional time stop |
| `SNIPER_SCALP_EXIT_EDGE` | Profit target |
| `SNIPER_STOP_LOSS_PCT` | Reversal stop |
| `SNIPER_BREAK_EVEN_EDGE` | Tighten to break-even once edge is favorable |
| `SNIPER_VELOCITY_WINDOW_MS`, `SNIPER_MIN_VELOCITY_PCT_PER_SEC` | Velocity confirmation |
| `SNIPER_VOLATILITY_SCALE` | Move-to-fair-value calibration |
| `SNIPER_MIN_LIQUIDITY_USD` | Optional liquidity floor |
| `SNIPER_RUNAWAY_ABS_PCT` | Block runaway moves |
| `SNIPER_LOSING_COOLDOWN_BY_COIN_MS` | Coin-wide cooldown after a losing exit |
| `SNIPER_PREFLIGHT_BALANCE_CHECK` | Refuse entries that cannot be funded |

Legacy directional entries still use:

- `ENTRY_STRATEGY`
- `MIN_COMBINED_DISCOUNT`
- `EXTREME_BUY_THRESHOLD`
- `EXTREME_SELL_THRESHOLD`
- `FAIR_VALUE_BUY_THRESHOLD`
- `FAIR_VALUE_SELL_THRESHOLD`

For modern deployments, those legacy thresholds are usually tightened or pushed out of reach when OBI or paired arb is the real entry engine.

## Market Maker And Deep Binance

Regular `MM_QUOTE` is the autonomous quote-management layer. It is separate from OBI's own follow-on quotes and separate from VS Engine's phase-1 quoting.

Core MM variables:

| Variable | Purpose |
|---|---|
| `MARKET_MAKER_MODE` | Enables regular MM logic |
| `DYNAMIC_QUOTING_ENABLED` | Starts the dedicated quoting loop |
| `MM_AUTO_ACTIVATE_AFTER_SNIPER` | Post-sniper MM activation |
| `POST_ONLY_ONLY` | Maker-only behavior |
| `QUOTING_INTERVAL_MS` | Quote refresh cadence |
| `MM_QUOTE_SHARES`, `MM_MAX_QUOTE_SHARES` | Quote sizing |
| `MM_MAX_GROSS_EXPOSURE_USD` | Total MM notional cap |
| `MM_MAX_NET_DIRECTIONAL` | Directional inventory cap |
| `MM_MIN_SPREAD_TICKS`, `QUOTING_SPREAD_TICKS` | Quote-width controls |
| `MM_REQUIRE_FAIR_VALUE` | Only quote with resolved fair value |
| `MM_MIN_BOOK_DEPTH_USD` | Liquidity floor for quoting |
| `MM_AUTONOMOUS_QUOTES`, `MM_ALWAYS_QUOTE` | Independent quote generation |
| `MM_SLOT_WARMUP_MS` | Delay after slot open |
| `MM_OPENING_SEED_WINDOW_MS` | Light early seeding window |
| `MM_STOP_NEW_ENTRIES_BEFORE_END_MS` | Stop fresh MM inventory near expiry |
| `MM_CANCEL_ALL_QUOTES_BEFORE_END_MS` | Cancel all quotes before slot end |
| `MM_MAKER_MIN_EDGE` | Minimum passive edge |
| `MM_MIN_QUOTE_LIFETIME_MS` | Minimum rest time before reprice |
| `MM_REPRICE_DEADBAND_TICKS` | Repricing deadband |
| `MM_INVENTORY_SKEW_FACTOR` | Inventory-based fair-value skew |
| `MM_MAX_CONCURRENT_MARKETS` | Max active MM markets |

Toxic-flow and re-entry controls:

- `MM_TOXIC_FLOW_BLOCK_MOVE_PCT`
- `MM_TOXIC_FLOW_CLEAR_MOVE_PCT`
- `MM_TOXIC_FLOW_MICROPRICE_TICKS`
- `MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS`
- `MM_TOXIC_FLOW_HOLD_MS`
- `MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS`
- `MM_SAME_SIDE_REENTRY_COOLDOWN_MS`
- `MM_GROSS_REENTRY_THRESHOLD_CLIPS`

Important platform note:

- the `ORDER_BOOK_IMBALANCE` and `ALL` presets disable this regular MM layer on purpose
- OBI has its own maker follow-on path through `OBI_MM_QUOTE_ASK`
- VS Engine has its own phase-1 quoting path through `VS_MM_BID` and `VS_MM_ASK`

## OBI Filter Versus OBI Engine

This is the most common source of confusion in the repo.

### `ORDER_BOOK_IMBALANCE_ENABLED`

This is a filter only. It gates whether regular MM activation should be allowed.

Key variables:

| Variable | Purpose |
|---|---|
| `ORDER_BOOK_IMBALANCE_ENABLED` | Master switch for the filter |
| `OBI_THIN_THRESHOLD_USD` | Thin-side depth threshold |
| `OBI_MIN_LIQUIDITY_USD` | Total liquidity floor |
| `OBI_ENTRY_IMBALANCE_RATIO` | Entry imbalance ratio |
| `OBI_EXIT_REBALANCE_RATIO` | Rebalance threshold |
| `OBI_KEEP_STRONGER_LEG_PCT` | Partial keep on rebalance |
| `OBI_SHADOW_MODE` | Observe/log only |

### `OBI_ENGINE_ENABLED`

This is the standalone OBI strategy. It can enter, post maker follow-ons, and exit independently of regular MM.

Core OBI engine variables:

| Variable | Purpose |
|---|---|
| `OBI_ENGINE_ENABLED` | Master switch |
| `OBI_SHADOW_MODE` | Shadow or active mode |
| `OBI_ENTRY_SHARES`, `OBI_MAX_POSITION_SHARES` | Entry size and cap |
| `OBI_MIN_ENTRY_PRICE`, `OBI_MAX_ENTRY_PRICE` | Entry price band |
| `OBI_COOLDOWN_MS` | Per-market cooldown |
| `OBI_SLOT_WARMUP_MS` | Ignore first milliseconds of slot |
| `OBI_STOP_ENTRY_BEFORE_END_MS` | Stop new entries near expiry |
| `OBI_CANCEL_ALL_BEFORE_END_MS` | Cancel and flatten near expiry |
| `OBI_SCALP_EXIT_EDGE` | Main profit target |
| `OBI_TIME_TAKE_PROFIT_MS` | Time-based take-profit trigger |
| `OBI_TIME_TAKE_PROFIT_MIN_EDGE` | Minimum edge for time take-profit |
| `OBI_MM_ASK_ENABLED` | Post maker ask after entry fill |
| `OBI_MM_ASK_SPREAD_TICKS` | OBI maker spread |
| `OBI_MM_BID_OPPOSITE_ENABLED` | Optional opposite-side bid |
| `OBI_MM_BID_OPPOSITE_FACTOR` | Opposite-side sizing fraction |
| `OBI_AGGRESSIVE_ENTRY` | Allows more aggressive entry style |

OBI safety variables:

| Variable | Purpose |
|---|---|
| `OBI_HARD_STOP_USD` | Hard PnL stop |
| `OBI_MIN_ENTRY_NOTIONAL_USD` | Minimum entry notional |
| `OBI_CLOB_MIN_NOTIONAL_USD` | CLOB sell floor |
| `OBI_CLOB_MIN_SHARES` | CLOB share floor |
| `OBI_LOSING_EXIT_COOLDOWN_MS` | Same-market losing-exit cooldown |
| `OBI_LOSING_EXIT_COOLDOWN_BY_COIN_MS` | Coin-wide losing-exit cooldown |
| `OBI_IMBALANCE_COLLAPSE_RATIO` | Immediate reverse-book exit |
| `OBI_PREFLIGHT_BALANCE_CHECK` | Skip entries that cannot be funded |
| `OBI_COMPOUND_THRESHOLD_USD` | Balance level where OBI sizes can scale up |
| `OBI_MAX_RISK_PER_TRADE_PCT` | Max fraction of available balance risked per OBI entry |

OBI Binance gate variables:

| Variable | Purpose |
|---|---|
| `OBI_BINANCE_GATE_ENABLED` | Master switch |
| `OBI_BINANCE_RUNAWAY_ABS_PCT` | Block runaway moves on any side |
| `OBI_BINANCE_CONTRA_ABS_PCT` | Block contra-direction entries above threshold |
| `OBI_BINANCE_REQUIRE_ALIGNMENT` | Require strict direction alignment |

The terminal dashboard surfaces OBI-specific gate reasons such as:

- `misaligned_strict`
- `flat_direction`
- `runaway_abs`
- `contra_direction`
- `unavailable_required`

## VS Engine

`VS_ENGINE` is the Binance latency arbitrage engine with two phases:

1. passive MM around CDF-derived fair value
2. late momentum buys when Binance already implies the answer

Core VS variables:

| Variable | Purpose |
|---|---|
| `VS_ENGINE_ENABLED` | Master switch |
| `VS_SHADOW_MODE` | Shadow versus active |
| `VS_DEFAULT_VOLATILITY` | Fallback realized volatility |
| `VS_VOL_LOOKBACK_MS` | Lookback for realized volatility |
| `VS_MIN_VOL_SAMPLES` | Minimum history samples |
| `VS_MM_SPREAD_CENTS` | Phase-1 quote width |
| `VS_MM_MIN_PRICE`, `VS_MM_MAX_PRICE` | MM price band |
| `VS_MM_SHARES`, `VS_MM_MAX_POSITION_SHARES` | Phase-1 sizing |
| `VS_MM_COOLDOWN_MS` | Phase-1 quote cooldown |
| `VS_MOMENTUM_THRESHOLD_SIGMAS` | Phase-2 z-score threshold |
| `VS_MOMENTUM_MAX_BUY_PRICE` | Max price for aggressive buy |
| `VS_MOMENTUM_SHARES`, `VS_MOMENTUM_MAX_POSITION_SHARES` | Phase-2 sizing |
| `VS_TARGET_EXIT_PRICE` | Preferred profit target |
| `VS_TIME_EXIT_BEFORE_END_MS` | Time exit near slot end |
| `VS_TIME_EXIT_MIN_PRICE` | Min acceptable price for time exit |
| `VS_SLOT_WARMUP_MS` | Warmup after slot open |
| `VS_STOP_ENTRY_BEFORE_END_MS` | Stop fresh entries before expiry |
| `VS_CANCEL_ALL_BEFORE_END_MS` | Cancel resting VS maker quotes |
| `VS_MOMENTUM_PHASE_MS` | Last window where phase-2 momentum activates |

VS safety variables:

| Variable | Purpose |
|---|---|
| `VS_HARD_STOP_USD` | Hard stop |
| `VS_COOLDOWN_MS` | Per-market cooldown |
| `VS_LOSING_EXIT_COOLDOWN_MS` | Same-market cooldown after losing exit |
| `VS_LOSING_EXIT_COOLDOWN_BY_COIN_MS` | Coin-wide cooldown |
| `VS_PREFLIGHT_BALANCE_CHECK` | Funding gate |
| `VS_MIN_LIQUIDITY_USD` | Liquidity floor |
| `VS_MIN_ENTRY_PRICE`, `VS_MAX_ENTRY_PRICE` | Entry band |
| `VS_MIN_DIRECTION_THRESHOLD` | Prevent YES/NO flipping when FV is too close to `0.50` |

Practical VS requirements:

- Binance feed must be healthy
- slot-open Binance price must be captured
- shadow mode is strongly recommended before going live

## Paired Arbitrage

Paired arb is the market-neutral engine for cases where combined cost is below eventual payout.

| Variable | Purpose |
|---|---|
| `PAIRED_ARB_ENABLED` | Master switch |
| `ENTRY_STRATEGY=PAIRED_ARBITRAGE` | Legacy selector still used by the preset |
| `PAIRED_ARB_MIN_NET_EDGE` | Minimum net edge after fee assumption |
| `PAIRED_ARB_MAX_PAIR_COST` | Max combined entry cost |
| `PAIRED_ARB_TARGET_BALANCE_RATIO` | Desired YES:NO balance |
| `PAIRED_ARB_BALANCE_TOLERANCE` | Allowed deviation before rebalance-only behavior |
| `PAIRED_ARB_MAX_PER_SIDE` | Max inventory per side |
| `PAIRED_ARB_MIN_SHARES`, `PAIRED_ARB_MAX_SHARES` | Per-leg size bounds |
| `PAIRED_ARB_COOLDOWN_MS` | Cooldown |
| `PAIRED_ARB_REQUIRE_BOTH_LIQUIDITY` | Require both sides to have enough depth |
| `PAIRED_ARB_MIN_DEPTH_USD` | Minimum per-side depth |
| `PAIRED_ARB_ASYNC_ENABLED` | Enable asynchronous pairing |
| `PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE` | Cheap starter-leg ceiling |
| `PAIRED_ARB_ASYNC_MIN_EDGE` | Async starter-leg edge |
| `PAIRED_ARB_ASYNC_MAX_WAIT_MS` | How long the second leg may wait |

Behavioral notes:

- synchronous paired legs are treated atomically
- if leg two fails, leg one is unwound
- paired-arb entries are exempt from the normal `MAX_SIGNALS_PER_TICK` cap

## Lottery Layer

Lottery is the convex follow-on layer. It usually buys the opposite outcome after a confirmed fill.

| Variable | Purpose |
|---|---|
| `LOTTERY_LAYER_ENABLED` | Master switch |
| `LOTTERY_MAX_RISK_USDC` | Max ticket cost |
| `LOTTERY_MIN_CENTS`, `LOTTERY_MAX_CENTS` | Legacy price band |
| `LOTTERY_RELATIVE_PRICING_ENABLED` | Anchor to live opposite-side book |
| `LOTTERY_RELATIVE_PRICE_FACTOR` | Relative anchor factor |
| `LOTTERY_RELATIVE_MAX_CENTS` | Hard cap for relative pricing |
| `LOTTERY_TAKE_PROFIT_MIN_CENTS` | Minimum bid before profit-taking |
| `LOTTERY_TAKE_PROFIT_MULTIPLIER` | Profit multiple versus entry |
| `LOTTERY_EXIT_BEFORE_END_MS` | Force flatten near expiry |
| `LOTTERY_ONLY_AFTER_SNIPER` | Restrict to sniper-trigger flow |
| `LOTTERY_MAX_PER_SLOT` | Per-slot cap |
| `LOTTERY_STOP_LOSS_PCT` | Stop-loss fraction |
| `LOTTERY_MAX_HOLD_MS` | Max hold duration |

Lottery is best treated as optional convexity, not the primary engine.

## EV, Kelly, Regime Filter, And Compounding

These modules modify sizing or quality rather than creating their own independent strategy layer.

### EV And Kelly

| Variable | Purpose |
|---|---|
| `EV_KELLY_ENABLED` | Master switch |
| `EV_MIN_THRESHOLD` | Normal EV floor |
| `EV_MIN_THRESHOLD_HIGH_FEE` | Higher EV floor for expensive markets |
| `KELLY_FRACTION` | Fractional Kelly multiplier |
| `MAX_BANKROLL_PER_TRADE` | Cap on Kelly sizing |
| `PREFER_MAKER_ORDERS` | Prefer maker-style execution when possible |
| `DEFAULT_TAKER_FEE`, `HIGH_FEE_TAKER_FEE` | Fee assumptions |

### Regime Filter

The regime filter is currently a sniper-quality filter based on Binance price action.

| Variable | Purpose |
|---|---|
| `REGIME_FILTER_ENABLED` | Master switch |
| `REGIME_FILTER_LOOKBACK_MS` | Lookback window |
| `REGIME_FILTER_BAR_INTERVAL_MS` | Micro-bar aggregation interval |
| `REGIME_FILTER_MIN_SAMPLES` | Minimum price samples |
| `REGIME_FILTER_EFFICIENCY_THRESHOLD` | Directional efficiency threshold |
| `REGIME_FILTER_ATR_THRESHOLD` | Normalized ATR threshold |

### Dynamic Compounding

| Variable | Purpose |
|---|---|
| `COMPOUNDING_ENABLED` | Master switch |
| `COMPOUNDING_BASE_RISK_PCT` | Base-risk fraction |
| `COMPOUNDING_MAX_SLOT_EXPOSURE_PCT` | Max exposure per slot |
| `COMPOUNDING_GLOBAL_EXPOSURE_PCT` | Global exposure as fraction of bankroll |
| `COMPOUNDING_LAYER_MULTIPLIERS` | Layer scale ladder |
| `COMPOUNDING_DRAWDOWN_GUARD_PCT` | Reduce sizes after drawdown |

Compounding matters especially for OBI because the runtime exposes an OBI size multiplier and drawdown-guard status in the dashboard.

## Shared Risk And Execution

These settings affect multiple engines at once.

### Global Risk

| Variable | Purpose |
|---|---|
| `GLOBAL_MAX_EXPOSURE_USD` | Shared exposure budget |
| `MAX_DRAWDOWN_USDC` | Whole-runtime emergency cutoff |
| `MAX_NET_YES`, `MAX_NET_NO` | Global directional inventory caps |
| `HARD_STOP_LOSS` | Legacy/global stop-loss setting |
| `HARD_STOP_COOLDOWN_MS` | Stop-loss cooldown |
| `TRAILING_TAKE_PROFIT` | Legacy/global trailing take-profit |
| `EXIT_BEFORE_END_MS` | Global slot-end exit timing |

### Position Sizing

| Variable | Purpose |
|---|---|
| `MIN_SHARES`, `MAX_SHARES` | Generic size clamps |
| `BASE_ORDER_SHARES` | Legacy/default order size |
| `PRICE_MULTIPLIER_LEVELS` | Price-based size ladder |
| `INVENTORY_IMBALANCE_THRESHOLD` | Inventory imbalance guard |
| `INVENTORY_REBALANCE_FRACTION` | Rebalance amount |

### Execution

| Variable | Purpose |
|---|---|
| `SLIPPAGE_TOLERANCE` | Max acceptable slippage |
| `ORDER_TYPE` | Primary order mode |
| `ORDER_TYPE_FALLBACK` | Fallback order mode |
| `POST_ONLY` | Default post-only flag |
| `ORDER_RETRY_ATTEMPTS` | Retry budget |
| `ORDER_RATE_LIMIT_MS` | Executor rate limit |
| `PASSIVE_TICKS`, `IMPROVE_TICKS`, `CROSS_TICKS` | Urgency-tick controls |

### Fill Tracking

| Variable | Purpose |
|---|---|
| `FILL_POLL_INTERVAL_MS` | Fill polling cadence |
| `FILL_POLL_TIMEOUT_MS` | Stop tracking after timeout |
| `FILL_CANCEL_BEFORE_END_MS` | Cancel stale orders before slot end |
| `BALANCE_CACHE_TTL_MS` | Balance/allowance cache |
| `SELL_AFTER_FILL_DELAY_MS` | Legacy sell-after-fill delay |

## Monitoring, Dashboard, And Logging

### Runtime Health And Incident Monitoring

| Variable | Purpose |
|---|---|
| `STATUS_CHECK_INTERVAL_MS` | Polymarket-status polling cadence |
| `AUTO_PAUSE_ON_INCIDENT` | Pause new entries when incidents match keywords |
| `PAUSE_GRACE_PERIOD_MS` | Delay before auto-pause takes effect |
| `LATENCY_PAUSE_THRESHOLD_MS` | Entry-gate threshold on latency |
| `LATENCY_RESUME_THRESHOLD_MS` | Resume threshold |
| `LATENCY_PAUSE_WINDOW_SIZE` | Rolling window size |
| `LATENCY_PAUSE_SAMPLE_TTL_MS` | Sample retention |

### Dashboard

| Variable | Purpose |
|---|---|
| `DASHBOARD_ENABLED` | Enable HTTP dashboard |
| `DASHBOARD_HOST` | Bind host |
| `DASHBOARD_PORT` | HTTP port |

The terminal dashboard is always available through the CLI and does not require these flags.

### Reports And Logs

| Variable | Purpose |
|---|---|
| `REPORTS_DIR` | Runtime output directory |
| `LATENCY_LOG` | Latency log path |
| `STATE_FILE` | Persistent state file |
| `REPORTS_FILE_PREFIX` | Slot-report prefix |
| `LOG_LEVEL` | Logging level |
| `LOG_TO_FILE` | Enable file logging |
| `LOG_DIRECTORY` | Log directory |

## Recommended Starting Profiles

Use the shipped env files intentionally:

- `.env.example`
  Best when you want to understand the full structure.
- `.env.live`
  Best when you want the newer OBI-led platform shape with Binance feed and dashboard data.
- `.env.imbalance.example`
  Best when you want a heavily commented OBI rollout path.
- `.env.obi-minimum-risk.example`
  Best when balance is small and capital preservation matters more than activity.

## Common Misunderstandings

- `ORDER_BOOK_IMBALANCE_ENABLED` is not the same as `OBI_ENGINE_ENABLED`
- `CURRENT_SNIPER` does not mean "only sniper"
- `ORDER_BOOK_IMBALANCE` and `ALL` disable regular `MM_QUOTE` on purpose
- `VS_ENGINE_ENABLED=true` still needs a healthy Binance feed
- dashboards read runtime status; if `reports/runtime-status.json` is stale, the UI will also be stale
