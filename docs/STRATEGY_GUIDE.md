# Strategy Guide

This repository now behaves like a platform with several distinct edges, not one monolithic strategy. The right question is no longer "which threshold should I tweak?" but "which edge am I trying to deploy?"

## The Core Mental Model

Each engine targets a different source of edge:

| Engine | Edge type | Character |
|---|---|---|
| `OBI` | Polymarket order-book imbalance | Mean-reversion / scalp |
| `VS_ENGINE` | Binance slot-open fair value and late momentum | Structured latency arb |
| `SNIPER` | Fast Binance-led repricing | Directional / aggressive |
| `MM_QUOTE` | Passive spread capture | Inventory management |
| `PAIRED_ARB` | Binary parity | Market-neutral |
| `LOTTERY` | Cheap opposite-side convexity | Small fixed-risk asymmetric bet |

That means the repo is now best understood as an orchestrator of edges, not as a single 5-minute scalper.

## Start By Choosing A Preset

Use `ACTIVE_STRATEGY` to decide the broad deployment shape first.

### `ORDER_BOOK_IMBALANCE`

Use this when:

- OBI is your main engine
- you want the cleanest modern live path
- you do not want regular MM or paired arb interfering
- you may want to run `VS_ENGINE` alongside OBI as a separate engine

Best for:

- live OBI trading
- small-balance rollouts
- careful staged deployment with shadow mode

### `PAIRED_ARBITRAGE`

Use this when:

- you want the lowest directional dependence
- you want to exploit `YES + NO < 1.00`
- you prefer settlement-parity logic over momentum logic

Best for:

- paper testing
- lower-latency sensitivity
- conservative first exposure to the market

### `ALL`

Use this when:

- you intentionally want a multi-strategy platform
- you want OBI and sniper-style edges in one runtime
- you may optionally layer in lottery follow-ons with `LOTTERY_LAYER_ENABLED=true`
- you understand the conflict rules and shared exposure budget

Best for:

- higher-activity experiments
- operators who actively monitor the dashboard
- accounts large enough to tolerate several edge types

### `CURRENT_SNIPER`

Use this when:

- you want manual control of flags without preset overrides
- you are preserving backward-compatible config behavior

Best for:

- migration from older configs
- debugging exact flag interactions

## OBI: Thin-Side Order-Book Imbalance

`OBI` is now a real standalone engine. That is the single biggest strategic change in the repo.

What it looks for:

- a thin side on Polymarket
- enough total top-of-book liquidity
- an imbalance ratio below the configured threshold
- a price band where a scalp or rebalance exit is plausible

What it does after entry:

- tracks the position itself
- can post a maker ask through `OBI_MM_QUOTE_ASK`
- can exit on scalp, rebalance, collapse, hard stop, time take-profit, or slot-end cleanup

Why operators like it:

- it is driven by observable PM book structure, not only by Binance momentum
- it has explicit dust and balance protections
- its dashboard surface is rich and operationally useful

What to watch:

- `OBI_SHADOW_MODE`
- `OBI_BINANCE_REQUIRE_ALIGNMENT`
- `OBI_MIN_ENTRY_NOTIONAL_USD`
- `OBI_CLOB_MIN_NOTIONAL_USD`
- `OBI_TIME_TAKE_PROFIT_MS`
- recent OBI decisions in the terminal dashboard

Common OBI mistake:

- confusing the OBI filter with the OBI engine. `ORDER_BOOK_IMBALANCE_ENABLED` only gates MM activation. `OBI_ENGINE_ENABLED` is the actual strategy.

## VS Engine: Binance Latency Arb

`VS_ENGINE` is a newer, more structured latency-arb design.

Its two phases:

1. phase 1 quotes around CDF-derived fair value
2. phase 2 buys momentum late in the slot when Binance strongly implies the outcome

What makes it different from sniper:

- it uses slot-open strike and realized volatility
- it reasons in terms of probability and z-score, not just move size
- it has explicit time-exit logic close to slot end

When to use it:

- you want a more model-driven latency-arb layer
- you trust your Binance feed quality
- you are comfortable running in shadow mode first

What to watch:

- `VS_SHADOW_MODE`
- `VS_DEFAULT_VOLATILITY`
- `VS_MOMENTUM_THRESHOLD_SIGMAS`
- `VS_TARGET_EXIT_PRICE`
- `VS_TIME_EXIT_BEFORE_END_MS`
- recent VS decisions in the dashboard

Best rollout path:

1. run `ORDER_BOOK_IMBALANCE` preset
2. keep `OBI` active
3. enable `VS_ENGINE_ENABLED=true`
4. keep `VS_SHADOW_MODE=true`
5. verify Binance feed health and decision quality before going live

## Sniper: Binance-Led Directional Entries

`SNIPER` is still the fast directional taker engine.

It works best when:

- Binance moves first
- Polymarket is lagging
- the PM ask is still within acceptable price and fee bounds
- velocity confirms the move is real

It works poorly when:

- Binance is flat or noisy
- PM has already repriced
- fees consume the apparent edge
- the slot is already too late

That is why the current platform usually treats sniper as one engine among many, not the entire product.

Useful controls:

- `SNIPER_MIN_BINANCE_MOVE_PCT`
- `SNIPER_MIN_EDGE_AFTER_FEES`
- `SNIPER_MIN_PM_LAG`
- `SNIPER_MAX_ENTRY_PRICE`
- `SNIPER_MAX_CONCURRENT_SAME_DIRECTION`
- `REGIME_FILTER_ENABLED`

## Regular MM Quote Engine

Regular `MM_QUOTE` is the passive spread-capture engine from `quoting-engine.ts`.

Use it when:

- you want passive quoting as a first-class layer
- you are not in an OBI- or ALL-style preset that intentionally disables it
- you can actively monitor inventory and quote health

Do not confuse it with:

- OBI maker follow-ons
- VS phase-1 MM

Those are separate quoting paths with different signal types and different control surfaces.

## Paired Arb: Low-Directionality Deployment

Paired arb remains the safest conceptual entry for many operators.

Why:

- the final payout is structurally bounded by `YES + NO = 1.00`
- the edge is parity-based rather than purely directional
- it does not need the same kind of Binance momentum timing as sniper

Modern paired-arb behavior:

- synchronous entries are atomic
- async starter legs are supported
- temporary directional risk exists while a pair is incomplete
- pending paired protection prevents some premature hard-stop behavior

Good first paper configuration:

```env
ACTIVE_STRATEGY=PAIRED_ARBITRAGE
PAIRED_ARB_ENABLED=true
PAIRED_ARB_ASYNC_ENABLED=true
PAIRED_ARB_MIN_NET_EDGE=0.005
PAIRED_ARB_MAX_PAIR_COST=0.995
PAPER_TRADING_ENABLED=true
```

## Lottery: Follow-On Convexity

Lottery is not a primary engine. It is a follow-on layer.

Use it when:

- you already have a trigger fill
- the opposite side is still very cheap
- you want fixed-risk convex upside

Avoid treating it as:

- a replacement for main entries
- a general-purpose mean-reversion engine

Best thought of as:

- occasional asymmetry
- capped downside equal to ticket cost
- optional, not mandatory

## Filters And Sizing Layers

The platform also has supporting layers that change quality or size:

- `EV_KELLY_ENABLED`
  Rejects weak edges and resizes surviving entries.
- `REGIME_FILTER_ENABLED`
  Blocks sniper entries in ranging Binance conditions.
- `COMPOUNDING_ENABLED`
  Adapts sizing to bankroll and drawdown.

These are not substitute strategies. They are quality and bankroll controls.

## Suggested Deployment Paths

### 1. Smallest-Risk Live Path

Use:

- `.env.obi-minimum-risk.example`
- `ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE`
- `OBI_ENGINE_ENABLED=true`
- `VS_ENGINE_ENABLED=false`

Why:

- one clear engine
- conservative exposure
- simple dashboard interpretation

### 2. OBI With VS Observation

Use:

- `ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE`
- `OBI_ENGINE_ENABLED=true`
- `VS_ENGINE_ENABLED=true`
- `VS_SHADOW_MODE=true`

Why:

- OBI handles live flow
- VS collects shadow diagnostics
- the dashboard shows both decision streams

### 3. Full Platform Mode

Use:

- `ACTIVE_STRATEGY=ALL`
- `SNIPER_MODE_ENABLED=true`
- `OBI_ENGINE_ENABLED=true`
- `LOTTERY_LAYER_ENABLED=true`

Only do this when:

- you understand shared exposure
- you monitor conflicts and recent decisions
- you accept that multiple edge families are running at once

## What To Watch In The Dashboard

For OBI rollouts:

- `ACTIVE MARKETS`
- `OBI SESSION`
- `BINANCE GATE`
- `RECENT OBI DECISIONS`

For VS rollouts:

- `VS ENGINE`
- `RECENT VS DECISIONS`
- price/feed availability

For non-OBI platform views:

- `STRATEGY LAYERS`
- `SNIPER ENGINE`
- `LOTTERY LAYER`
- `RECENT SIGNALS`

Universal health checks:

- mode and pause state
- portfolio, cash, available balance
- latency gate
- day PnL and drawdown

## Common Strategic Mistakes

- enabling `ALL` without understanding that regular `MM_QUOTE` is still disabled by preset design
- assuming `CURRENT_SNIPER` means only sniper is active
- running `VS_ENGINE` without a healthy Binance feed
- treating lottery as a main edge instead of a follow-on layer
- using very small balances without respecting CLOB minimum notional and dust behavior

## Bottom Line

The right way to use this repo now is:

1. choose the edge you want
2. pick the preset that matches that edge
3. keep the dashboard open
4. only then tune thresholds

That sequence matches how the current codebase is actually designed.
