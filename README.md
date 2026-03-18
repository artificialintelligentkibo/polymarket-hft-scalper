# Polymarket HFT Scalper

Standalone Polymarket scalper repo built from the proven pieces of `polymarket-copy-bot`, but stripped of copy-trading logic. This project keeps the gasless trader, JSONL logging, CCXT enrichment, and CLOB connectivity, then swaps in a dedicated short-horizon mean-reversion signal for 5-minute markets.

## Repo Layout

```text
polymarket-hft-scalper/
├── src/
│   ├── config.ts
│   ├── clob-fetcher.ts
│   ├── signal-scalper.ts
│   ├── position-manager.ts
│   ├── trader.ts
│   ├── logger.ts
│   └── monitor.ts
├── backtest/
│   └── backtester.ts
├── .env.example
├── README.md
└── package.json
```

## Stack

- `@polymarket/clob-client` for gasless order posting
- `ws` for CLOB WebSocket subscriptions
- native `fetch` for Gamma market discovery
- `ccxt` for crypto context snapshots in logs
- TypeScript + `tsx`

## Strategy

The signal is implemented literally from the reconstructed rules:

- Trade only the binary `outcomeIndex` tokens:
  - `0` => `YES` / `UP`
  - `1` => `NO` / `DOWN`
- Entry BUY condition:
  - `token_price < mid_price_orderbook - 0.018`
- Inventory SELL condition:
  - `token_price > mid_price_orderbook + 0.015`
- Position sizing:
  - `8` to `35` shares, scaled by market liquidity and available book depth
- Net inventory controls:
  - `MAX_NET_YES = +65`
  - `MAX_NET_NO = -75`
  - when breached, the engine auto-flips with the opposite corrective action
- Exits:
  - trailing take-profit distance: `0.012`
  - hard stop distance: `0.025`
  - flatten before slot end
- Market filter:
  - liquidity strictly above `$500`
  - optionally only 5-minute markets

## Important Assumptions

Two parts of the original reverse-engineered behavior needed a deterministic implementation choice:

1. `Trailing take-profit +0.012`
   - implemented as: once peak mark is at least `entry + 0.012`, exit on a `0.012` retrace from the peak
2. `SELL if token_price > mid + 0.015`
   - implemented as an inventory reduction signal, not naked shorting
   - the strategy only sells inventory it already owns

These assumptions are explicit in code and easy to change.

## Components

### `src/monitor.ts`

- pulls active Gamma markets
- extracts binary token IDs
- filters by liquidity and 5-minute duration
- drops markets that are too close to slot end

### `src/clob-fetcher.ts`

- subscribes to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- tracks `last_trade_price` from WebSocket
- refreshes full bid/ask books from REST when local state is stale
- computes real `bestBid`, `bestAsk`, `midPrice`, spread, and depth

### `src/signal-scalper.ts`

- evaluates entry/exit edges
- applies net position correction before new entries
- sizes orders from liquidity
- orchestrates live runtime loops

### `src/position-manager.ts`

- tracks YES / NO inventory separately
- computes signed net exposure `yesShares - noShares`
- marks unrealized PnL
- triggers hard stop, trailing stop, and slot-end exits

### `src/trader.ts`

- derives or creates Polymarket API credentials from the configured signer
- supports `EOA` and `PROXY` style auth
- places gasless orders through the Polymarket SDK
- preserves approval and balance checks needed for live trading

### `src/logger.ts`

- writes structured app events
- writes JSONL trade records
- enriches each record with CCXT crypto snapshots
- captures realized / unrealized PnL and signed net inventory

## Running

```bash
npm install
cp .env.example .env
npm start
```

Simulation mode:

```bash
SIMULATION_MODE=true
ENABLE_SIGNAL=true
npm start
```

Backtest:

```bash
npm run backtest -- backtest/data/sample.jsonl
```

Tests:

```bash
npm test
```

## Logging

Trade logs are written as JSONL under `logs/` and include:

- timestamp
- market / slot metadata
- token price, mid, best bid, best ask
- action, shares, notional
- net YES / net NO inventory
- realized, unrealized, and total PnL
- crypto prices from Binance via CCXT

## Backtest Notes

`backtest/backtester.ts` is designed to run on JSONL logs that already contain `token_price` and `mid_price_orderbook`, including the simulation logs produced by the earlier reverse-engineering workflow.

The included sample dataset is synthetic and exists to verify that:

- entries fire on the configured discount to mid
- exits fire on the configured premium to mid
- hard stop logic works
- summary PnL aggregation is stable

## Sample Results

On the included synthetic dataset in [backtest/data/sample.jsonl](/C:/GitHub/polymarket-hft-scalper/backtest/data/sample.jsonl), the expected baseline result is:

- `samples`: `6`
- `markets`: `3`
- `entries`: `3`
- `exits`: `3`
- `wins`: `1`
- `losses`: `2`
- `realizedPnl`: about `+0.0827`
- `maxSignedNet`: about `25.55` shares
- `forcedExitCount`: `1`

This is intentionally a sanity-check dataset, not a profitability claim. It proves that:

- discount-to-mid entries fire
- premium-to-mid exits fire
- hard stop logic closes losing inventory
- net inventory never exceeds the configured caps on the sample flow

## Simulation + Slot Reports

```bash
TEST_MODE=true SIMULATION_MODE=true WHITELIST_CONDITION_IDS="0x3f5dc93e...,0x3756c929..." npm start
```

In this mode the bot can be constrained to a manual whitelist of `conditionId` values, trade only the selected 5-minute slots, and print a console report after each slot ends.

What the runtime does:

- filters markets by `WHITELIST_CONDITION_IDS` when the list is non-empty
- treats `TEST_MODE` the same as simulation for order placement
- flattens positions into the slot-end window
- prints per-slot `Up`, `Down`, and `NET` PnL
- keeps a cumulative day total in memory for the process lifetime

### Quick Test

1. Copy [`.env.example`](/C:/GitHub/polymarket-hft-scalper/.env.example) to `.env`
2. Set:

```bash
TEST_MODE=true
SIMULATION_MODE=true
WHITELIST_CONDITION_IDS=0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0,0x3756c929609555f5b6cd8a8231d083400ea92397873fcd5ca24182186766e2e7
```

3. Run:

```bash
npm start
```

Expected behavior:

- the bot trades only the whitelisted slots
- each ending 5-minute slot prints a console summary table
- `TOTAL DAY PNL` accumulates across slot reports

## Next Steps

- wire a persistent position snapshot store if you want restart-safe inventory
- add per-market concurrency locks if you plan to run many slots in parallel
- add maker/taker fill reconciliation from the user WebSocket channel for production
