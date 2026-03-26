# Strategy Guide

## Why the Old 5-Minute Directional Model Loses

5-minute crypto Up/Down markets are extremely efficient around the midpoint. Buying one side because it looks "cheap" is usually just buying directional variance plus taker fees. If the market reprices before the slot resolves, the bot gets stopped out or flattened at a loss long before expiry.

That is why `EXTREME_BUY` and `FAIR_VALUE_BUY` underperform on these very short slots unless they are heavily filtered or disabled.

## How Paired Arbitrage Works

Binary settlement is still `YES + NO = $1.00`.

If the bot can buy:

- `YES @ 0.46`
- `NO @ 0.51`

then total cost is `0.97`. Even after fee assumptions, the combined expiry payout is still positive if the effective paired cost stays below the configured cap.

The implementation now does three important things:

1. Treats paired buy legs atomically when both are present in the same tick.
2. Unwinds leg 1 immediately if leg 2 fails.
3. Temporarily defers `HARD_STOP` while a paired leg is still pending completion.

## Async Pairing, Gabagool-Style

Real opportunities often do not appear as simultaneous `YES + NO < 1.00`.

Instead, one side briefly gets cheap first. The async pairing mode allows the bot to:

1. Buy a cheap starter leg below async fair value.
2. Wait for the opposite side to become cheap enough later in the slot.
3. Complete the pair if projected combined cost still stays below `PAIRED_ARB_MAX_PAIR_COST`.

This increases frequency substantially, but it also creates temporary directional exposure. That is why the code now tracks pending paired-arb protection and uses a larger hard-stop budget for paired testing.

## When Latency Momentum Works

Latency momentum only works when:

- Binance spot moves first.
- Polymarket has not fully repriced yet.
- The cheap convexity token is still cheap enough to justify fees.

The engine now compares Binance move with how much Polymarket has already repriced, instead of only checking distance from `0.50`.

That matters because:

- a market at `0.60` is not automatically "lagging"
- it is only lagging if Binance implies it should already be much further away than that

## Fee Reality: 3.15% Changes Everything

For 5-minute crypto Up/Down markets, fee assumptions matter more than almost any signal tweak.

At `3.15%` taker fee, many trades that look slightly positive on raw price are still negative EV after costs. That is why EV/Kelly filtering now uses:

- a normal fee threshold for regular markets
- a stricter threshold for 5-minute crypto markets

Paired arb is exempt because its edge is based on combined payout parity rather than directional expectation.

## EV and Kelly in Practice

The EV/Kelly layer is meant to do two things:

1. Reject entries that are positive only before fees.
2. Resize surviving entries so a single bad directional trade does not dominate the session.

This is most useful for:

- latency momentum
- any remaining legacy directional entries

It is intentionally not applied to reduce-only exits or paired arb entries.

## Market Maker Preference

When `PREFER_MAKER_ORDERS=true`, simulation and paper flows try:

1. `improve`
2. then fallback to `cross`

This models the intended "maker if possible, taker if necessary" workflow without weakening the live order path before full live cancel/status reconciliation is validated.

## February 2026 Latency Change

The practical effect of Polymarket's 2026 latency deterioration is simple:

- momentum windows got shorter
- synchronous paired discounts got rarer
- paper trading must model latency and stale orderbook risk realistically

That is why the simulator now:

- keeps orderbook history
- replays fills against delayed snapshots
- applies partial fills and slippage by urgency

## Recommended First Paper Test

```env
ENTRY_STRATEGY=PAIRED_ARBITRAGE
PAIRED_ARB_ENABLED=true
PAIRED_ARB_ASYNC_ENABLED=true
PAIRED_ARB_MIN_NET_EDGE=0.005
PAIRED_ARB_MAX_PAIR_COST=0.995
PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE=0.45
PAIRED_ARB_MIN_SHARES=5
PAIRED_ARB_MAX_SHARES=12
MAX_SIGNALS_PER_TICK=4
EV_KELLY_ENABLED=true
PREFER_MAKER_ORDERS=true
PAPER_TRADING_ENABLED=true
SIMULATION_MODE=false
BINANCE_EDGE_ENABLED=true
COINS_TO_TRADE=BTC,ETH,SOL
HARD_STOP_LOSS=0.25
FAIR_VALUE_BUY_THRESHOLD=9.99
EXTREME_BUY_THRESHOLD=0.001
```

What to watch in the dashboard:

- `recentSkippedSignals` for `EV_NEGATIVE`, `EV_TOO_LOW`, or `MAX_SIGNALS`
- slot skipped counts
- whether paired buys are completing or frequently unwinding
- whether latency entries survive the EV filter often enough to matter
