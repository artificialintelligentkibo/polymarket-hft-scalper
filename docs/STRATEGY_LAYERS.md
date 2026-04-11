# Strategy Layers

This document focuses on orchestration. The repo now contains several engines, but the important operational question is how they coexist inside one runtime.

## Overview

```text
src/index.ts
  -> shared market scan
  -> shared position manager
  -> shared order executor
  -> shared runtime-status and dashboards
  -> strategy layers:
       SNIPER
       MM_QUOTE
       PAIRED_ARB
       LOTTERY
       OBI
       VS_ENGINE
```

The layers are not just "enabled or disabled". They also have:

- conflict rules
- priority rules
- shared exposure accounting
- shared reporting and dashboard state

## Layer Catalog

| Layer | Main signals | Primary job |
|---|---|---|
| `SNIPER` | `SNIPER_BUY`, `SNIPER_SCALP_EXIT` | Binance-led directional entries and fast exits |
| `MM_QUOTE` | `MM_QUOTE_BID`, `MM_QUOTE_ASK` | Regular passive quoting and inventory shaping |
| `PAIRED_ARB` | `PAIRED_ARB_BUY_YES`, `PAIRED_ARB_BUY_NO`, `PAIRED_ARB_REBALANCE` | Binary parity capture |
| `LOTTERY` | `LOTTERY_BUY` plus shared exits | Cheap convex follow-on tickets |
| `OBI` | `OBI_ENTRY_BUY`, `OBI_SCALP_EXIT`, `OBI_REBALANCE_EXIT`, `OBI_MM_QUOTE_*` | Standalone order-book imbalance trading |
| `VS_ENGINE` | `VS_ENTRY_BUY`, `VS_MM_BID`, `VS_MM_ASK`, `VS_MOMENTUM_BUY`, `VS_SCALP_EXIT`, `VS_TIME_EXIT` | Binance latency arb with slot-open fair value |

## SNIPER

Purpose:

- aggressive Binance-led entry
- fast PM repricing capture
- directional edge rather than parity edge

Entry path:

- uses Binance move, PM lag, and fee-aware edge
- can be filtered by regime and correlation windows
- supports balance preflight checks

Exit path:

- sniper scalp exits
- reversal logic
- time stop
- shared slot-end cleanup

Typical coexistence:

- can coexist with `MM_QUOTE`
- can coexist with `LOTTERY`
- can coexist with `OBI`
- can coexist with `VS_ENGINE`
- should not coexist with `PAIRED_ARB` on the same market

## MM_QUOTE

Purpose:

- regular passive quoting
- inventory smoothing
- optional post-sniper spread capture

Important boundary:

- this is the regular quoting engine
- it is not the same as OBI maker follow-ons
- it is not the same as VS phase-1 quoting

Typical coexistence:

- can coexist with `SNIPER`
- can coexist with `LOTTERY`
- can coexist with `OBI`
- can coexist with `VS_ENGINE`
- should not coexist with `PAIRED_ARB` on the same market

Preset caveat:

- `ORDER_BOOK_IMBALANCE` disables it
- `ALL` disables it

That is intentional. OBI and VS already have their own quote paths.

## PAIRED_ARB

Purpose:

- buy both outcomes when payout parity is favorable
- minimize reliance on direction

Behavior:

- synchronous paired legs are atomic
- async starter-leg behavior is allowed when configured
- normal directional signal caps do not apply the same way

Coexistence:

- should run alone on a market
- conflicts with `SNIPER`, `MM_QUOTE`, `LOTTERY`, `OBI`, and `VS_ENGINE`

Operational rule:

- when paired arb is the chosen edge, prefer the `PAIRED_ARBITRAGE` preset and keep the runtime simple

## LOTTERY

Purpose:

- small fixed-risk opposite-side tickets
- convex follow-on after a trigger fill

Behavior:

- usually follows `SNIPER_BUY`
- may also coexist with other layers at the platform level
- uses fixed ticket-risk logic rather than broad inventory sizing

Coexistence:

- can coexist with `SNIPER`
- can coexist with `MM_QUOTE`
- can coexist with `OBI`
- can coexist with `VS_ENGINE`
- should not coexist with `PAIRED_ARB` on the same market

## OBI

Purpose:

- trade PM order-book imbalance directly
- enter on thin-side structures
- exit on scalp, rebalance, hard stop, collapse, time take-profit, or slot-end cleanup

Behavior:

- maintains its own position state
- can post `OBI_MM_QUOTE_ASK`
- has its own Binance gate and dust protections
- exposes rich runtime stats in the dashboard

Coexistence:

- can coexist with `SNIPER`
- can coexist with `MM_QUOTE`
- can coexist with `LOTTERY`
- does not coexist with `PAIRED_ARB`
- does not coexist with `VS_ENGINE` on the same market under current conflict rules

Important distinction:

- OBI as a layer is not the same as the OBI filter used to gate regular MM activation

## VS_ENGINE

Purpose:

- trade a modeled fair value from Binance slot-open data and realized volatility
- use phase-1 passive quotes and phase-2 momentum

Behavior:

- maintains its own state and stats
- cancels resting VS maker quotes before exits
- tracks its own hard-stop and orphan cleanup path

Coexistence:

- can coexist with `SNIPER`
- can coexist with `MM_QUOTE`
- can coexist with `LOTTERY`
- does not coexist with `PAIRED_ARB`
- does not coexist with `OBI` on the same market under current conflict rules

## Conflict Resolution

The code uses `isLayerConflict()` from [src/strategy-types.ts](../src/strategy-types.ts).

Allowed same-market pairs:

- `SNIPER + MM_QUOTE`
- `SNIPER + LOTTERY`
- `MM_QUOTE + LOTTERY`
- `OBI + SNIPER`
- `OBI + MM_QUOTE`
- `OBI + LOTTERY`
- `VS_ENGINE + SNIPER`
- `VS_ENGINE + MM_QUOTE`
- `VS_ENGINE + LOTTERY`

Blocked same-market combinations:

- anything involving `PAIRED_ARB` with another layer
- `OBI + VS_ENGINE`
- `OBI + PAIRED_ARB`
- `VS_ENGINE + PAIRED_ARB`

Runtime behavior is controlled by:

```env
LAYER_CONFLICT_RESOLUTION=BLOCK
```

`BLOCK` is the recommended live setting.

## Shared Risk Layer

Every layer still has local controls, but they all feed into shared platform limits.

Global controls:

- `GLOBAL_MAX_EXPOSURE_USD`
- `MAX_DRAWDOWN_USDC`
- `MAX_NET_YES`
- `MAX_NET_NO`
- latency gate and API circuit-breaker gate

The runtime exposes per-layer and global exposure in `runtime-status.json`, including:

- `sniperUsd`
- `mmUsd`
- `pairedArbUsd`
- `lotteryUsd`
- `obiUsd`
- `vsUsd`
- `totalUsd`

## Priority And Execution Notes

Some execution rules matter more than the raw layer list:

- paired-arb buy legs are treated atomically
- OBI exits cancel pending OBI maker orders before trying to sell
- VS exits cancel pending VS maker orders before trying to sell
- slot-end flattening is still the universal last-resort cleanup path
- pause mode blocks new entries but keeps safety exits alive

This means the runtime is not simply "pick the highest-priority signal". It also coordinates collateral, pending quotes, and cleanup timing.

## Dashboard Mapping

The terminal dashboard adapts to the active layers.

When OBI is active, you will usually see:

- `ACTIVE MARKETS`
- `OBI POSITIONS`
- `OBI SESSION`
- `BINANCE GATE`
- `RECENT OBI DECISIONS`

When VS is active, you will also see:

- `VS ENGINE`
- `RECENT VS DECISIONS`

When OBI is not the dominant layer, you will see the more generic platform view:

- `MM QUOTES`
- `BOT PERFORMANCE STATS`
- `STRATEGY LAYERS`
- `SNIPER ENGINE`
- `LOTTERY LAYER`
- `RECENT SIGNALS`

The HTTP dashboard uses the same `runtime-status.json` data but renders it as a web page.

## Recommended Layer Combinations

### OBI-first live trading

Use:

- `ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE`
- `OBI_ENGINE_ENABLED=true`
- optional `VS_ENGINE_ENABLED=true`

Why:

- cleanest live mental model
- most explicit OBI telemetry
- avoids regular MM conflicts

### Paired-arb only

Use:

- `ACTIVE_STRATEGY=PAIRED_ARBITRAGE`

Why:

- simplest low-directionality deployment
- no need to reason about mixed-layer coexistence

### Full platform

Use:

- `ACTIVE_STRATEGY=ALL`

Why:

- highest activity
- mixes OBI, sniper, and lottery
- still respects shared exposure and conflict rules

## Common Layer Confusion

- `MM_QUOTE` is not `OBI_MM_QUOTE_ASK`
- `MM_QUOTE` is not `VS_MM_BID` or `VS_MM_ASK`
- `CURRENT_SNIPER` is not the same thing as "only sniper"
- OBI and VS can both be enabled in the platform, but current same-market conflict rules still block them from owning the same market together

## Bottom Line

The layer model is now one of the core product features of the repo. If documentation or operations ignore that model, the runtime becomes hard to reason about. If you keep the layer boundaries clear, the platform is much easier to run safely.
