# polymarket-hft-scalper

Multi-strategy Polymarket trading platform for 5-minute crypto markets.

This repository is no longer "one bot with one entry model". The runtime now acts as an orchestrator for multiple trading engines, shared risk controls, live dashboards, CLI controls, and reporting layers:

- `SNIPER` for Binance-led directional taker entries
- `MM_QUOTE` for passive quote management and inventory shaping
- `PAIRED_ARB` for `YES + NO < 1.00` market-neutral entries
- `LOTTERY` for small convex follow-on tickets
- `OBI` for standalone order-book imbalance trading
- `VS_ENGINE` for Binance latency arbitrage with slot-open fair value

Useful docs:

- [SETUP.md](SETUP.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/STRATEGY_GUIDE.md](docs/STRATEGY_GUIDE.md)
- [docs/STRATEGY_LAYERS.md](docs/STRATEGY_LAYERS.md)
- [docs/CONFIG_HELP.html](docs/CONFIG_HELP.html)

## What It Is Now

The platform now combines:

- preset-based orchestration through `ACTIVE_STRATEGY`
- per-engine toggles and safety controls
- terminal dashboard via `scalper dashboard`
- optional HTTP dashboard from `src/dashboard-server.ts`
- runtime snapshots in `reports/runtime-status.json`
- slot reports, latency logs, trade journal, and auto-redeem flow
- pause/resume control, Polymarket incident monitoring, and wallet-funds refresh

The main orchestrator is [src/index.ts](src/index.ts). Configuration is parsed and validated in [src/config.ts](src/config.ts). Shared runtime status is defined in [src/runtime-status.ts](src/runtime-status.ts).

## Strategy Stack

| Layer | Role | Typical usage |
|---|---|---|
| `SNIPER` | Fast Binance-led directional entries | Momentum or repricing edge |
| `MM_QUOTE` | Passive spread capture | Inventory management and queueing |
| `PAIRED_ARB` | `YES + NO` parity capture | Lowest directional exposure |
| `LOTTERY` | Small opposite-side convex tickets | Follow-on after a fill |
| `OBI` | Thin-side order-book imbalance engine | Mean-reversion/scalp flow |
| `VS_ENGINE` | Slot-open Binance latency arb | Fair-value MM plus late momentum |

The important change is coordination. These layers now share one runtime, one exposure budget, one dashboard surface, and one conflict-resolution model.

## Strategy Presets

`ACTIVE_STRATEGY` is the top-level preset switch. It applies overrides on top of the raw `.env`.

| Preset | What it does |
|---|---|
| `CURRENT_SNIPER` | Leaves your flags as configured. Best thought of as "manual compatibility mode". |
| `ORDER_BOOK_IMBALANCE` | Forces `OBI` on, disables sniper/latency/paired-arb entries, disables regular `MM_QUOTE`, keeps Binance price feed only when needed for OBI/VS. |
| `PAIRED_ARBITRAGE` | Runs paired arb only and turns off directional engines and regular MM. |
| `ALL` | Enables multi-strategy mode centered on `OBI + SNIPER`, keeps `VS_ENGINE` if explicitly enabled, and works well with `LOTTERY_LAYER_ENABLED=true` when you want follow-on convexity. Regular `MM_QUOTE` stays disabled to avoid layer conflicts. |

Important nuance:

- `VS_ENGINE` is controlled by its own `VS_ENGINE_ENABLED` flag.
- Regular `MM_QUOTE` is intentionally disabled by the `ORDER_BOOK_IMBALANCE` and `ALL` presets.
- `CURRENT_SNIPER` does not force a legacy shape; it simply avoids preset overrides.

## Quick Start

1. Install dependencies.

```powershell
npm install
```

2. Copy a config template.

```powershell
Copy-Item .env.example .env
```

3. Fill in authentication and API credentials.

4. Pick a starting profile:

- `.env.example`
  Clean baseline with all major sections.
- `.env.live`
  Live OBI-focused platform profile with Binance feed, runtime dashboard data, and strict gates.
- `.env.imbalance.example`
  OBI-first live profile with comments tuned around shadow-to-live rollout.
- `.env.obi-minimum-risk.example`
  Safest low-balance OBI-only profile.

5. Choose runtime mode:

- Simulation: `SIMULATION_MODE=true`, `DRY_RUN=true`
- Product test: `PRODUCT_TEST_MODE=true`, `SIMULATION_MODE=false`, `DRY_RUN=false`
- Production: `SIMULATION_MODE=false`, `DRY_RUN=false`, `PRODUCT_TEST_MODE=false`

6. Start the bot or open the dashboard.

```powershell
npm start
npm run scalper -- status
npm run scalper -- dashboard
```

## Dashboards And Control

The project now has two dashboard surfaces.

### Terminal Dashboard

```powershell
npm run scalper -- dashboard
```

What it shows depends on the active engines:

- active markets with PM/Binance state
- live positions
- OBI session stats, Binance gate breakdown, and recent OBI decisions
- VS Engine stats and recent VS decisions
- strategy-layer status for non-OBI-focused modes
- recent signals, lottery stats, and MM exposure where relevant

The terminal dashboard is the fastest way to monitor the runtime during live trading.

### HTTP Dashboard

Enable the built-in web dashboard:

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=3847
```

Then open `http://<host>:<port>`.

The web dashboard reads `reports/runtime-status.json` and shows:

- portfolio and wallet balances
- layer status
- open positions
- recent signals
- OBI metrics
- sniper metrics
- exposure summaries

## CLI Commands

The CLI entrypoint lives in [cli/index.ts](cli/index.ts).

```powershell
npm run scalper -- start
npm run scalper -- stop
npm run scalper -- status
npm run scalper -- pause
npm run scalper -- resume
npm run scalper -- dashboard
npm run scalper -- monitor
npm run scalper -- monitor --watch
npm run scalper -- switch --mode simulation
npm run scalper -- reset
```

Command summary:

- `start`
  Starts the runtime in the background.
- `stop`
  Gracefully stops the runtime and clears process tracking.
- `status`
  Prints current mode, pause state, PnL, latency, and recent runtime health.
- `pause` / `resume`
  Stops or resumes new entries while keeping exits and safety logic alive.
- `dashboard`
  Opens the live terminal dashboard.
- `monitor`
  Runs a one-shot Polymarket incident check.
- `monitor --watch`
  Uses the terminal dashboard loop.
- `switch --mode ...`
  Rewrites `.env` mode flags and restarts the runtime.
- `reset`
  Clears reports, logs, runtime status, and day-PnL state.

## Configuration Model

Configuration is no longer just "entry thresholds". The control stack is:

1. Runtime mode flags such as `SIMULATION_MODE`, `DRY_RUN`, and `PRODUCT_TEST_MODE`
2. `ACTIVE_STRATEGY` preset overrides
3. Engine flags such as `OBI_ENGINE_ENABLED`, `SNIPER_MODE_ENABLED`, `VS_ENGINE_ENABLED`
4. Shared execution and risk controls
5. Dashboard, monitoring, and reporting settings

Start with [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the grouped explanation, then use [docs/CONFIG_HELP.html](docs/CONFIG_HELP.html) as a browser-friendly quick map.

## Reports And Runtime Files

The runtime now writes several operator-facing outputs:

- `reports/runtime-status.json`
  Canonical runtime snapshot used by the dashboards.
- `reports/slot-reports_YYYY-MM-DD.log`
  Slot-level PnL and activity summaries.
- `reports/trade-journal_YYYY-MM-DD.log`
  Human-readable trade narration from `TradeNarrator`.
- `reports/latency_YYYY-MM-DD.log`
  Latency samples and infrastructure diagnostics.
- `reports/state.json`
  Runtime state persistence.
- `logs/`
  Structured log files when `LOG_TO_FILE=true`.

## Development Scripts

```powershell
npm start
npm run dev
npm run build
npm test
npm run backtest
npm run compare
```

Script summary:

- `npm start`
  Runs `tsx src/index.ts`
- `npm run dev`
  Runs the runtime in watch mode
- `npm run build`
  TypeScript compile
- `npm test`
  Test suite
- `npm run backtest`
  Historical backtester
- `npm run compare`
  Comparison against target-wallet behavior

## Repository Layout

```text
src/
  config.ts
  index.ts
  runtime-status.ts
  sniper-engine.ts
  quoting-engine.ts
  order-book-imbalance.ts
  obi-engine.ts
  vs-engine.ts
  paired-arbitrage.ts
  lottery-engine.ts
  dashboard-server.ts
  trade-narrator.ts
cli/
  index.ts
docs/
  CONFIGURATION.md
  CONFIG_HELP.html
  STRATEGY_GUIDE.md
  STRATEGY_LAYERS.md
tests/
reports/
```

## Recommended Operating Path

For most new live rollouts:

1. Start from `.env.obi-minimum-risk.example` or `.env.live`
2. Validate credentials and dashboard
3. Run `PRODUCT_TEST_MODE` before full production
4. Keep `OBI_SHADOW_MODE=true` when testing new OBI variants
5. Turn on `VS_ENGINE_ENABLED` only after Binance feed health is confirmed
6. Use `ALL` mode only when you explicitly want multi-strategy orchestration

## Notes

- Polymarket CLOB minimums still matter. Small balances create real dust and exit constraints.
- `ORDER_BOOK_IMBALANCE_ENABLED` is a filter for MM activation. `OBI_ENGINE_ENABLED` is the standalone OBI strategy. They are not the same thing.
- In `ORDER_BOOK_IMBALANCE` and `ALL`, regular `MM_QUOTE` is intentionally disabled because OBI already has its own follow-on quoting path.
- `VS_ENGINE` can run alongside the platform, but same-market layer conflicts still apply.
- The safest source of truth for exact defaults and validation ranges is [src/config.ts](src/config.ts).
