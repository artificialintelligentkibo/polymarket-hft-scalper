# Polymarket HFT Scalper - Setup Guide

## Prerequisites

- Node.js 18+
- Python 3.9+ (for credential generation only)
- MetaMask (or other browser wallet)
- Polymarket.com account with deposited USDC

## Step 1: Polymarket Account Setup

1. Go to [polymarket.com](https://polymarket.com) and connect your MetaMask wallet
2. This creates a **proxy wallet** - note the address from Settings -> Profile -> "Address"
3. Deposit USDC to your Polymarket account (minimum $50 for testing)

## Step 2: Identify Your Addresses

You have **two** addresses:

| Address | Where to find | Role |
|---------|---------------|------|
| **Signer** (EOA) | MetaMask -> Account Details | Signs orders and API requests |
| **Funder** (Proxy) | Polymarket -> Settings -> Profile -> "Address" | Holds USDC and tokens |

## Step 3: Export MetaMask Private Key

1. Open MetaMask
2. Click the account menu next to account name -> Account Details
3. Click "Show Private Key" -> enter password
4. Copy the hex string (this is your `SIGNER_PRIVATE_KEY`)

## Step 4: Get Relayer API Key

1. Go to Polymarket -> Settings -> Relayer API Keys
2. Click "+ Create New" if no keys exist
3. Copy the full API key value -> this is `POLYMARKET_RELAYER_KEY`
4. Note the "Signer Address" shown -> this is `POLYMARKET_RELAYER_KEY_ADDRESS`

## Step 5: Generate CLOB API Credentials

```bash
python3 -m venv /tmp/poly
source /tmp/poly/bin/activate
pip install py-clob-client

python3 -c "
from py_clob_client.client import ClobClient
c = ClobClient(
    'https://clob.polymarket.com',
    key='YOUR_SIGNER_PRIVATE_KEY_HERE',
    chain_id=137,
    signature_type=2,   # 2 for MetaMask, 1 for email/Magic Link
    funder='YOUR_FUNDER_ADDRESS_HERE'
)
creds = c.create_or_derive_api_creds()
print(f'POLYMARKET_API_KEY={creds.api_key}')
print(f'POLYMARKET_API_SECRET={creds.api_secret}')
print(f'POLYMARKET_API_PASSPHRASE={creds.api_passphrase}')
"
```

**WARNING:** Running this again will INVALIDATE previous credentials.
Save the output immediately. Do NOT run it multiple times.

## Step 6: Configure .env

```bash
cp .env.example .env
nano .env
```

Fill in Section 1 (Authentication) with values from Steps 3-5.

## Step 7: Verify Configuration

```bash
# Check signer address matches
node -e "
const { ethers } = require('ethers');
const w = new ethers.Wallet(require('dotenv').config().parsed.SIGNER_PRIVATE_KEY);
console.log('Signer:', w.address);
console.log('Expected: should match Relayer API Keys -> Signer Address');
"
```

## Step 8: Test Run

```bash
# Simulation mode (default — no real orders)
npm start

# Product test (1 real slot, tiny size)
# Edit .env: PRODUCT_TEST_MODE=true, AUTO_REDEEM=true,
#            SIMULATION_MODE=false, DRY_RUN=false
npm start

# Full live
# Edit .env: SIMULATION_MODE=false, DRY_RUN=false
npm start
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `invalid signature` | Wrong SIGNATURE_TYPE or stale CLOB credentials | MetaMask=2, re-derive credentials |
| `Unauthorized/Invalid api key` | Credentials were invalidated by re-derive | Re-run Step 5, update .env |
| `unsupported signer type` | Wrong signer format in ClobClient | Ensure clobSigner is Wallet without provider |
| `Trading restricted in your region` | VPS IP is geo-blocked | Use non-EU/non-US VPS, or run from allowed region |
| `Relayer 401 invalid authorization` | CLOB key used instead of Relayer key | Set POLYMARKET_RELAYER_KEY from Step 4 |
| `Gasless redeem failed 400` | Relayer key address mismatch | Verify POLYMARKET_RELAYER_KEY_ADDRESS matches Relayer page |
