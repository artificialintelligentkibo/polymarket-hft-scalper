# Strategy Layers

This runtime can operate as a coordinated three-layer system modeled on the real Polymarket trading pattern seen in high-frequency 5-minute crypto wallets such as vague-sourdough.

## Overview

```text
ORCHESTRATOR (src/index.ts)
  -> SNIPER
  -> MM_QUOTE
  -> PAIRED_ARB
  -> shared risk, exposure, and conflict rules
```

The important change is not just that all three layers exist. The important change is that they now share one orchestration path, one global exposure budget, and one set of coexistence rules.

## Layer 1: SNIPER

Purpose:

- directional, Binance-led entries
- fast repricing capture
- highest urgency among non-arbitrage entries

Entry logic:

- requires Binance move, PM lag, and edge after fees
- sizes with sniper base/strong share settings
- respects sniper cooldown and correlated-direction window

Exit logic:

- `SNIPER_SCALP_EXIT` when Polymarket reprices above entry
- Binance reversal stop if the move flips against the position
- time stop when `SNIPER_MAX_HOLD_MS` is reached and the trade is not working

Legacy `HARD_STOP`, `TRAILING_TAKE_PROFIT`, and `SLOT_FLATTEN` are suppressed for tagged sniper positions because sniper manages its own exits.

## Layer 2: MM_QUOTE

Purpose:

- passive quote placement
- spread capture and inventory smoothing
- optional auto-activation after a sniper fill

Behavior:

- runs through `src/quoting-engine.ts`
- respects market-maker limits, skew, concurrent-market cap, and pending quote exposure
- can coexist with sniper on the same market

When `MM_AUTO_ACTIVATE_AFTER_SNIPER=true`, a confirmed `SNIPER_BUY` arms quote management for that market and tightens the opposite-side quote slightly to attract hedging fills.

## Layer 3: PAIRED_ARB

Purpose:

- both outcomes cheap at the same time
- low directional dependence
- prefers settlement rather than routine scalp exits

Behavior:

- atomic paired legs when both sides are present in one tick
- can still use async accumulation if enabled
- protected from sniper-style hard stops and trailing exits
- only the global `RISK_LIMIT` emergency brake can force the position out early

## Layer Interaction Rules

Allowed:

- `SNIPER + MM_QUOTE`
- same layer across multiple markets within per-layer caps

Blocked:

- `SNIPER + PAIRED_ARB`
- `MM_QUOTE + PAIRED_ARB`

Conflict handling is controlled by:

```env
LAYER_CONFLICT_RESOLUTION=BLOCK
```

`BLOCK` is the recommended production mode.

## Shared Risk Layer

Per-layer limits still apply:

- sniper position caps
- MM gross/net inventory caps
- paired-arb per-side limits

Shared controls now apply on top:

```env
GLOBAL_MAX_EXPOSURE_USD=50
MAX_DRAWDOWN_USDC=-10
```

Meaning:

- when total exposure reaches `GLOBAL_MAX_EXPOSURE_USD`, fresh entries are blocked across all layers
- `MAX_DRAWDOWN_USDC` remains the emergency stop for the whole runtime

## Recommended Profiles

Conservative:

```env
SNIPER_MODE_ENABLED=true
MARKET_MAKER_MODE=true
DYNAMIC_QUOTING_ENABLED=true
PAIRED_ARB_ENABLED=false
SNIPER_BASE_SHARES=6
SNIPER_STRONG_SHARES=8
SNIPER_MAX_POSITION_SHARES=10
MM_MAX_GROSS_EXPOSURE_USD=8
GLOBAL_MAX_EXPOSURE_USD=25
```

Moderate:

```env
SNIPER_MODE_ENABLED=true
MARKET_MAKER_MODE=true
DYNAMIC_QUOTING_ENABLED=true
PAIRED_ARB_ENABLED=true
SNIPER_BASE_SHARES=6
SNIPER_STRONG_SHARES=10
SNIPER_MAX_POSITION_SHARES=12
MM_MAX_GROSS_EXPOSURE_USD=10
PAIRED_ARB_MAX_SHARES=8
GLOBAL_MAX_EXPOSURE_USD=50
```

Aggressive:

```env
SNIPER_MODE_ENABLED=true
MARKET_MAKER_MODE=true
DYNAMIC_QUOTING_ENABLED=true
PAIRED_ARB_ENABLED=true
SNIPER_BASE_SHARES=8
SNIPER_STRONG_SHARES=12
SNIPER_MAX_POSITION_SHARES=16
MM_MAX_GROSS_EXPOSURE_USD=15
PAIRED_ARB_MAX_SHARES=10
GLOBAL_MAX_EXPOSURE_USD=75
```

## Dashboard Guide

The production dashboard now includes:

- `portfolio`, `cash`, and `available` in the header
- `STRATEGY LAYERS` with per-layer status, position count, exposure, and PnL
- `RECENT SIGNALS` with a `LAYER` column

Interpretation:

- `ACTIVE` means the layer currently has live inventory or active MM markets
- `WATCHING` means enabled but not currently deployed
- `OFF` means disabled in config

`Position abandoned for redeem - below CLOB minimum sell size` is expected for tiny dust tails after a live partial exit and is not the same as a failed exit loop.

## Troubleshooting

Why is SNIPER not trading?

- check `SNIPER_MIN_BINANCE_MOVE_PCT`
- check `SNIPER_MIN_EDGE_AFTER_FEES`
- inspect `sniperStats.rejections` in `runtime-status.json`

Why is MM_QUOTE not starting after sniper?

- confirm `MARKET_MAKER_MODE=true`
- confirm `DYNAMIC_QUOTING_ENABLED=true`
- confirm `MM_AUTO_ACTIVATE_AFTER_SNIPER=true`

Why is PAIRED_ARB not firing?

- verify both sides are below `PAIRED_ARB_MAX_PAIR_COST`
- check minimum depth and share floors
- check market conflict rules if sniper or MM are already active on that market

Why are new entries blocked?

- inspect `globalExposure.totalUsd`
- inspect `MAX_DRAWDOWN_USDC`
- check the recent skipped signals list for `global_exposure_limit` or `layer_conflict`
