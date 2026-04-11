# Polymarket HFT Scalper Setup Guide

This guide covers the current platform layout: credentials, runtime modes, config profiles, CLI control, and both dashboard surfaces.

## Prerequisites

- Node.js 18+
- npm
- Python 3.9+ for one-time CLOB credential generation
- A Polymarket account with funded USDC balance
- A wallet you control directly, such as MetaMask or Rabby

## Step 1: Understand The Two Wallet Addresses

You need two different addresses:

| Address | Where it comes from | What it is used for |
|---|---|---|
| Signer / EOA | Your browser wallet | Signs orders and API auth |
| Funder / Proxy | Polymarket profile address | Holds Polymarket USDC and positions |

Where to find them:

- Signer / EOA
  Open your wallet and copy the normal wallet address.
- Funder / Proxy
  Open Polymarket, go to `Settings -> Profile`, and copy the `Address` field.

These are not interchangeable.

## Step 2: Export The Signer Private Key

For MetaMask:

1. Open MetaMask.
2. Open account details.
3. Reveal the private key.
4. Copy the hex string into `SIGNER_PRIVATE_KEY`.

The address derived from this key must match the signer address shown in Polymarket relayer settings.

## Step 3: Get The Relayer Key

1. Open Polymarket.
2. Go to `Settings -> Relayer API Keys`.
3. Create or open a key.
4. Copy:

- `POLYMARKET_RELAYER_KEY`
- `POLYMARKET_RELAYER_KEY_ADDRESS`

These are for gasless relayer actions such as redeem and approve flow. They are not the same as CLOB API credentials.

## Step 4: Generate CLOB API Credentials

Use Python once. Re-running this flow invalidates old credentials.

```bash
python3 -m venv /tmp/poly
source /tmp/poly/bin/activate
pip install py-clob-client

python3 -c "
from py_clob_client.client import ClobClient

c = ClobClient(
    'https://clob.polymarket.com',
    key='YOUR_SIGNER_PRIVATE_KEY',
    chain_id=137,
    signature_type=2,
    funder='YOUR_FUNDER_ADDRESS'
)
creds = c.create_or_derive_api_creds()
print(f'POLYMARKET_API_KEY={creds.api_key}')
print(f'POLYMARKET_API_SECRET={creds.api_secret}')
print(f'POLYMARKET_API_PASSPHRASE={creds.api_passphrase}')
"
```

Fill these into:

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`
- `POLYMARKET_API_KEY_ADDRESS`

`POLYMARKET_API_KEY_ADDRESS` should be the signer address derived from `SIGNER_PRIVATE_KEY`.

## Step 5: Create `.env`

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

Then edit `.env` and fill the authentication section first.

## Step 6: Pick A Starting Profile

The repository now ships several useful starting points.

| File | Best for |
|---|---|
| `.env.example` | Clean baseline with every major section visible |
| `.env.live` | Current live-style OBI platform profile with Binance feed and dashboard data |
| `.env.imbalance.example` | OBI-first live rollout with heavy commentary |
| `.env.obi-minimum-risk.example` | Safest small-balance OBI-only deployment |

Recommended approach:

1. Start from `.env.example` if you want to understand every group manually.
2. Start from `.env.obi-minimum-risk.example` if you want the safest OBI live baseline.
3. Start from `.env.live` if you specifically want the newer OBI plus dashboard platform shape.

## Step 7: Choose Runtime Mode

The runtime supports three operating modes.

### Simulation

No real orders. Safest first check.

```env
SIMULATION_MODE=true
DRY_RUN=true
PRODUCT_TEST_MODE=false
```

### Product Test

Real orders, tiny size, tightly constrained rollout.

```env
SIMULATION_MODE=false
DRY_RUN=false
PRODUCT_TEST_MODE=true
AUTO_REDEEM=true
TEST_MAX_SLOTS=1
```

### Production

Normal live runtime.

```env
SIMULATION_MODE=false
DRY_RUN=false
PRODUCT_TEST_MODE=false
```

If you use the CLI, you can switch modes with:

```powershell
npm run scalper -- switch --mode simulation
npm run scalper -- switch --mode product_test
npm run scalper -- switch --mode production
```

## Step 8: Verify Credentials

Check that the private key resolves to the expected signer address:

```powershell
node -e "const { ethers } = require('ethers'); const dotenv = require('dotenv'); const env = dotenv.config().parsed; const wallet = new ethers.Wallet(env.SIGNER_PRIVATE_KEY); console.log('Derived signer:', wallet.address); console.log('Expected signer: must match POLYMARKET_API_KEY_ADDRESS and the signer shown in Polymarket relayer settings.');"
```

Also sanity-check:

- `FUNDER_ADDRESS` matches Polymarket profile address
- `POLYMARKET_RELAYER_KEY_ADDRESS` matches relayer settings
- `POLYMARKET_API_KEY_ADDRESS` matches the signer wallet

## Step 9: Start The Runtime

Basic start:

```powershell
npm install
npm start
```

Useful control commands:

```powershell
npm run scalper -- start
npm run scalper -- stop
npm run scalper -- status
npm run scalper -- pause
npm run scalper -- resume
npm run scalper -- dashboard
npm run scalper -- monitor
```

Recommended first run:

1. `npm run scalper -- status`
2. `npm start`
3. `npm run scalper -- dashboard`
4. Confirm balances, mode, status, and active markets

## Step 10: Enable The Dashboards

### Terminal Dashboard

```powershell
npm run scalper -- dashboard
```

This is the main operator view and now includes OBI- and VS-specific sections when those engines are enabled.

### HTTP Dashboard

Turn it on in `.env`:

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=3847
```

Then open:

```text
http://localhost:3847
```

The HTTP dashboard reads `reports/runtime-status.json`.

## Step 11: Pick A Strategy Rollout Path

### Safest OBI Rollout

Use `.env.obi-minimum-risk.example` or replicate its structure:

- `ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE`
- `OBI_ENGINE_ENABLED=true`
- `OBI_SHADOW_MODE=false` or `true` for observation
- `VS_ENGINE_ENABLED=false`
- low global exposure

### OBI Plus VS Observation

Use the live platform shape:

- `ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE`
- `OBI_ENGINE_ENABLED=true`
- `VS_ENGINE_ENABLED=true`
- `BINANCE_WS_ENABLED=true`
- optionally keep `VS_SHADOW_MODE=true` first

### Multi-Strategy Platform Mode

Only when you intentionally want orchestration across engines:

- `ACTIVE_STRATEGY=ALL`
- `SNIPER_MODE_ENABLED=true`
- `OBI_ENGINE_ENABLED=true`
- `LOTTERY_LAYER_ENABLED=true`
- regular `MM_QUOTE` remains disabled by preset design

## Step 12: Confirm Reports Are Being Written

After startup, expect these files to appear under `reports/`:

- `runtime-status.json`
- `slot-reports_*.log`
- `trade-journal_*.log`
- `latency_*.log`

If `LOG_TO_FILE=true`, expect structured logs under `logs/`.

## Troubleshooting

| Problem | Usual cause | What to check |
|---|---|---|
| `invalid signature` | Wrong signer type or stale creds | `SIGNATURE_TYPE`, regenerated CLOB creds |
| `Unauthorized` or invalid API key | CLOB credentials were re-derived | Generate once again and update `.env` |
| Relayer `401` | Wrong relayer key or address mismatch | `POLYMARKET_RELAYER_KEY` and `POLYMARKET_RELAYER_KEY_ADDRESS` |
| Bot starts but shows no balances | Bad auth or wallet refresh issue | funder address, signer address, runtime logs |
| Dashboard is empty | Runtime never wrote status | confirm `npm start` is running and `reports/runtime-status.json` exists |
| OBI blocks everything | Gate too strict or Binance alignment required | `OBI_BINANCE_*`, liquidity thresholds, recent OBI decisions |
| VS shows `no_binance_data` | Binance feed disabled | `BINANCE_WS_ENABLED=true`, `DEEP_BINANCE_MODE` if needed |
| HTTP dashboard not reachable | Disabled or wrong bind host | `DASHBOARD_ENABLED`, `DASHBOARD_HOST`, `DASHBOARD_PORT` |

## Final Safety Notes

- Never commit real secrets.
- Do not re-run CLOB credential derivation casually.
- For live rollouts, prefer `PRODUCT_TEST_MODE` before full production.
- For OBI experiments, shadow mode is the safest first step.
- The current platform has multiple engines, but shared risk still matters. Keep `GLOBAL_MAX_EXPOSURE_USD` and drawdown limits conservative until you trust the deployment.
