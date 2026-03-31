# Configuration Reference

For a browser-friendly environment-variable guide, open [CONFIG_HELP.html](./CONFIG_HELP.html). It is a visual companion to `.env.example` and is the quickest way to understand what each configuration section is used for before editing your live or paper setup.

## Three-Layer Strategy System

The runtime can now coordinate three independently switchable layers:

- `SNIPER`
- `MM_QUOTE`
- `PAIRED_ARB`

Recommended entry point:

```env
SNIPER_MODE_ENABLED=true
MARKET_MAKER_MODE=true
DYNAMIC_QUOTING_ENABLED=true
PAIRED_ARB_ENABLED=true
MM_AUTO_ACTIVATE_AFTER_SNIPER=true
LAYER_CONFLICT_RESOLUTION=BLOCK
GLOBAL_MAX_EXPOSURE_USD=50
```

Important notes:

- `ENTRY_STRATEGY` is still supported for backward compatibility, but coordinated production setups should prefer the layer switches above
- `SNIPER + MM_QUOTE` may coexist on one market
- `PAIRED_ARB` conflicts with both `SNIPER` and `MM_QUOTE`
- `MAX_DRAWDOWN_USDC` is still the global emergency stop

## Layer Coordination

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `SNIPER_MODE_ENABLED` | bool | `false` | Enables the sniper layer. |
| `MARKET_MAKER_MODE` | bool | `false` | Enables market-maker logic. |
| `DYNAMIC_QUOTING_ENABLED` | bool | `false` | Starts the dedicated quoting loop. |
| `PAIRED_ARB_ENABLED` | bool | `false` | Enables paired-arbitrage opportunities. |
| `MM_AUTO_ACTIVATE_AFTER_SNIPER` | bool | `true` | Activates MM quoting for a market after a confirmed sniper entry. |
| `LAYER_CONFLICT_RESOLUTION` | enum | `BLOCK` | `BLOCK` rejects conflicting layers on the same market. `OVERRIDE` allows them. |
| `GLOBAL_MAX_EXPOSURE_USD` | float | `50` | Shared gross exposure budget across all layers. |

## Recommended Three-Layer Production Baseline

```env
SNIPER_MODE_ENABLED=true
SNIPER_BASE_SHARES=6
SNIPER_STRONG_SHARES=10
SNIPER_MAX_POSITION_SHARES=12
SNIPER_MIN_BINANCE_MOVE_PCT=0.07
SNIPER_MIN_EDGE_AFTER_FEES=0.02
SNIPER_SCALP_EXIT_EDGE=0.04
SNIPER_STOP_LOSS_PCT=0.08
SNIPER_MAX_HOLD_MS=90000

MARKET_MAKER_MODE=true
DYNAMIC_QUOTING_ENABLED=true
MM_AUTO_ACTIVATE_AFTER_SNIPER=true
MM_QUOTE_SHARES=6
MM_MAX_GROSS_EXPOSURE_USD=10
MM_MAX_NET_DIRECTIONAL=8
MM_MIN_EDGE_AFTER_FEE=0.005
QUOTING_SPREAD_TICKS=3

PAIRED_ARB_ENABLED=true
PAIRED_ARB_MIN_NET_EDGE=0.008
PAIRED_ARB_MAX_PAIR_COST=0.995
PAIRED_ARB_MAX_SHARES=8

GLOBAL_MAX_EXPOSURE_USD=50
MAX_DRAWDOWN_USDC=-10
```

This bot still supports four legacy entry modes for backward compatibility:

- `ENTRY_STRATEGY=LEGACY`
- `ENTRY_STRATEGY=PAIRED_ARBITRAGE`
- `ENTRY_STRATEGY=LATENCY_MOMENTUM`
- `ENTRY_STRATEGY=ALL`

Exit and safety signals stay active in every mode.

## Strategy Selection

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `ENTRY_STRATEGY` | enum | `LEGACY` | Selects which entry engines are active. |
| `PAIRED_ARB_ENABLED` | bool | `false` | Enables paired-arbitrage entry generation. |
| `LATENCY_MOMENTUM_ENABLED` | bool | `false` | Enables Binance-led latency momentum entries. |
| `EV_KELLY_ENABLED` | bool | `false` | Enables EV filtering and Kelly resizing for non-paired entries. |
| `PAPER_TRADING_ENABLED` | bool | `false` | Replaces live CLOB execution with the paper simulator. |

Recommended starting points:

- `LEGACY`: only for backwards compatibility and comparison.
- `PAIRED_ARBITRAGE`: safest first paper mode.
- `LATENCY_MOMENTUM`: directional and latency-sensitive.
- `ALL`: highest activity, but disable weak legacy entries first.

When using `ALL`, strongly consider:

```env
EXTREME_BUY_THRESHOLD=0.001
FAIR_VALUE_BUY_THRESHOLD=9.99
```

That keeps paired arb + latency active while removing the legacy long-bias entries that caused most losses.

## Paired Arbitrage

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `PAIRED_ARB_MIN_NET_EDGE` | float | `0.02` | Minimum edge after estimated settlement fee. |
| `PAIRED_ARB_MAX_PAIR_COST` | float | `0.97` | Hard cap on projected `YES + NO` cost basis. |
| `PAIRED_ARB_TARGET_BALANCE_RATIO` | float | `1.0` | Target YES:NO inventory ratio. |
| `PAIRED_ARB_BALANCE_TOLERANCE` | float | `0.15` | Allowed imbalance before rebalance-only entries. |
| `PAIRED_ARB_MAX_PER_SIDE` | float | `200` | Maximum inventory per side per market. |
| `PAIRED_ARB_MIN_SHARES` | float | `20` | Configured per-leg minimum before CLOB floors are applied. |
| `PAIRED_ARB_MAX_SHARES` | float | `80` | Maximum shares per single leg. |
| `PAIRED_ARB_COOLDOWN_MS` | int | `5000` | Cooldown between paired entries in the same market. |
| `PAIRED_ARB_REQUIRE_BOTH_LIQUIDITY` | bool | `true` | Requires both sides to have minimum ask depth for synchronous pairs. |
| `PAIRED_ARB_MIN_DEPTH_USD` | float | `3` | Minimum ask depth per side. |
| `PAIRED_ARB_ASYNC_ENABLED` | bool | `true` | Enables gabagool-style async pairing. |
| `PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE` | float | `0.45` | Only starts a leg when the token is still cheap. |
| `PAIRED_ARB_ASYNC_MIN_EDGE` | float | `0.01` | Minimum discount versus async fair value. |
| `PAIRED_ARB_ASYNC_MAX_WAIT_MS` | int | `180000` | Maximum wait for the second leg before the async opportunity expires. |

Recommended tuning:

Conservative:

```env
PAIRED_ARB_MIN_NET_EDGE=0.02
PAIRED_ARB_MAX_PAIR_COST=0.97
PAIRED_ARB_ASYNC_ENABLED=false
```

Aggressive:

```env
PAIRED_ARB_MIN_NET_EDGE=0.005
PAIRED_ARB_MAX_PAIR_COST=0.995
PAIRED_ARB_ASYNC_ENABLED=true
PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE=0.45
```

Important safeguards:

- Paired BUY legs are atomic and exempt from `MAX_SIGNALS_PER_TICK`.
- If leg 2 fails, leg 1 is unwound immediately.
- `HARD_STOP` is deferred briefly while a paired leg is still pending completion.
- CLOB minimums still apply per leg: at least `5` shares and at least `$1` notional.

## Latency Momentum

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `LATENCY_MOMENTUM_MIN_MOVE_PCT` | float | `0.30` | Minimum Binance move to trigger an entry. |
| `LATENCY_MOMENTUM_STRONG_MOVE_PCT` | float | `0.50` | Larger move threshold for bigger size. |
| `LATENCY_MOMENTUM_MAX_ENTRY_WINDOW_MS` | int | `120000` | Limits entries to the early slot window. |
| `LATENCY_MOMENTUM_MAX_PM_LAG_PCT` | float | `0.10` | Blocks entries after Polymarket reprices too far. |
| `LATENCY_MOMENTUM_PM_MOVE_SENSITIVITY` | float | `0.10` | Converts PM repricing into equivalent Binance move. |
| `LATENCY_MOMENTUM_MIN_ENTRY_PRICE` | float | `0.01` | Rejects dust-priced entries. |
| `LATENCY_MOMENTUM_MAX_ENTRY_PRICE` | float | `0.15` | Keeps entries focused on cheap convexity. |
| `LATENCY_MOMENTUM_BASE_SHARES` | float | `30` | Base size for valid moves. |
| `LATENCY_MOMENTUM_STRONG_SHARES` | float | `60` | Larger size for stronger moves. |
| `LATENCY_MOMENTUM_MAX_POSITION_SHARES` | float | `100` | Per-market cap. |
| `LATENCY_MOMENTUM_COOLDOWN_MS` | int | `10000` | Cooldown per market. |
| `LATENCY_MOMENTUM_INVERT_SIGNAL` | bool | `false` | Flips the cheap-side mapping if needed for experimentation. |

## EV + Kelly

Paired arb is exempt. EV/Kelly applies to legacy and latency entries.

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `EV_MIN_THRESHOLD` | float | `0.005` | Minimum EV for normal-fee markets. |
| `EV_MIN_THRESHOLD_HIGH_FEE` | float | `0.008` | Higher threshold for 5-minute crypto fee regime. |
| `KELLY_FRACTION` | float | `0.85` | Fractional Kelly multiplier. |
| `MAX_BANKROLL_PER_TRADE` | float | `0.20` | Caps Kelly bankroll usage per trade. |
| `PREFER_MAKER_ORDERS` | bool | `true` | In simulation/paper mode, tries `improve` before `cross` for cross-urgency entries. |
| `DEFAULT_TAKER_FEE` | float | `0.02` | Baseline taker fee assumption. |
| `HIGH_FEE_TAKER_FEE` | float | `0.0315` | 5-minute crypto taker fee assumption. |

Signals are filtered with one of:

- `EV_NEGATIVE`
- `EV_TOO_LOW`
- `KELLY_SIZE_TOO_SMALL`
- `EXTREME_PRICE_SKIP`

## Paper Trading

| Parameter | Type | Default | Description |
|---|---|---:|---|
| `PAPER_TRADING_INITIAL_BALANCE` | float | `100` | Starting virtual bankroll. |
| `PAPER_TRADING_LATENCY_MIN_MS` | int | `400` | Lower bound for simulated latency. |
| `PAPER_TRADING_LATENCY_MAX_MS` | int | `1500` | Upper bound for simulated latency. |
| `PAPER_TRADING_FILL_PROB_PASSIVE` | float | `0.40` | Passive maker fill probability. |
| `PAPER_TRADING_FILL_PROB_IMPROVE` | float | `0.65` | Improve-order fill probability. |
| `PAPER_TRADING_FILL_PROB_CROSS` | float | `0.95` | Taker fill probability. |
| `PAPER_TRADING_MAX_SLIPPAGE_TICKS` | int | `2` | Max taker slippage in ticks. |
| `PAPER_TRADING_SIZE_IMPACT_FACTOR` | float | `0.5` | Extra slippage for large orders. |
| `PAPER_TRADING_PARTIAL_FILLS` | bool | `true` | Enables partial fills. |
| `PAPER_TRADING_MIN_FILL_RATIO` | float | `0.30` | Minimum partial fill ratio when a fill occurs. |
| `PAPER_TRADING_TRADE_LOG` | path | `./reports/paper-trades.jsonl` | JSONL output for simulated trades. |

## Parameters That Commonly Cause Losses

- `MAX_SIGNALS_PER_TICK`
  Paired buy legs are exempt now, but low values still suppress non-paired opportunities.
- `HARD_STOP_LOSS`
  For paired/async pairing paper tests, use something looser like `0.20-0.25`.
- `FAIR_VALUE_BUY_THRESHOLD`
  Set `9.99` to disable if you want to remove legacy directional entry.
- `EXTREME_BUY_THRESHOLD`
  Set `0.001` to effectively disable weak legacy dip-buy behavior while leaving extreme sells active.

## Environment Gotchas

- Do not rely on shell-exported overrides unless you mean to. `dotenv` does not replace existing environment variables by default.
- Verify an env var with:

```bash
node -e "require('dotenv').config(); console.log(process.env.ENTRY_STRATEGY)"
```

- Clear stale shell overrides before debugging config:

```bash
unset ENTRY_STRATEGY
unset PAPER_TRADING_ENABLED
```

- On PowerShell, prefer editing `.env` directly instead of mixing `$env:VAR=...` with dotenv-based runs.
