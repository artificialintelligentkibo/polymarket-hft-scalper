# Wallet Setup — polymarket-hft-scalper

Step-by-step guide to going from zero to a fully-configured bot. Follow the
sections in order. Allow ~30 minutes end-to-end (most of it waiting for a
Polygon bridge).

---

## 0. Vocabulary (read once, saves hours later)

| Term | What it is |
|---|---|
| **Signer** | Your EOA (Externally Owned Account). A normal Ethereum keypair with a private key. The bot signs orders and EIP-712 messages with this key. Lives on your machine. |
| **Funder / Proxy wallet** | The on-chain address that actually **holds your USDC and positions**. Created automatically by Polymarket the first time you sign in. It is NOT equal to the signer. |
| **Magic Link** | Polymarket-managed signer (created via email login). `SIGNATURE_TYPE=1`. Not applicable for this bot. |
| **EOA (MetaMask/Rabby)** | Self-custody signer, you control the private key. `SIGNATURE_TYPE=2`. **This is what we use.** |
| **CLOB API creds** | `(apiKey, secret, passphrase)` triplet issued by Polymarket's gateway. Deterministic — same signer always yields the same triplet. Authenticates order placement. |
| **Relayer key** | Separate credential for gasless on-chain actions (redeem, approve). Issued from Polymarket Settings → Relayer API Keys. |

---

## 1. Generate a fresh signer wallet

Never reuse a wallet that already holds real funds on another service.

```bash
tsx scripts/generate-wallet.ts --out .secrets/signer.key
```

The script prints:

```
Address:     0xABC...123     ← this is your SIGNER address
Private key: 0x<64 hex chars>
```

The file is written with `0o600` permissions (owner read/write only) on Unix.
On Windows, lock it down manually:

```powershell
icacls .secrets\signer.key /inheritance:r /grant:r "%USERNAME%:F"
```

**Back up the private key into your password manager NOW.** If you lose it,
every USDC and every open position held by the associated proxy wallet is
unreachable forever.

---

## 2. Fund the signer with ~0.5 MATIC (for gas)

The signer needs a small amount of MATIC on Polygon to sign/settle
transactions. Options:

- Bridge from Ethereum: https://portal.polygon.technology
- Buy directly on a CEX (Binance / OKX / Kraken) that supports MATIC
  withdrawal to Polygon
- Any other on-ramp you trust

Send ~0.5 MATIC to the signer address from step 1. Verify on Polygonscan:

```
https://polygonscan.com/address/<SIGNER_ADDRESS>
```

---

## 3. Create the Polymarket proxy (funder) wallet

1. Go to https://polymarket.com
2. Click **Sign in → MetaMask / Rabby / WalletConnect**
3. Connect the signer wallet from step 1
4. Polymarket will detect you have no proxy yet and ask you to sign a creation
   message (EIP-712 — no gas cost, just a signature)
5. Once done, your **Settings → Profile → Address** page shows your proxy
   (funder) address. Copy it.

You now have:
- `SIGNER_ADDRESS` — from step 1 (controls orders)
- `FUNDER_ADDRESS` — from step 3 (holds funds)

They are **different**. The bot needs both.

---

## 4. Deposit USDC into the funder

Two clean options:

### (a) Bridge USDC from Ethereum
Use https://portal.polymarket.com or Polymarket's built-in deposit flow.
Receive USDC.e on Polygon in the **funder** address.

### (b) Withdraw USDC (Polygon / USDC-e) from a CEX
- Binance: withdraw network = "Polygon", asset = "USDC"
- OKX: withdraw network = "Polygon", asset = "USDC-POS"
- Coinbase: withdraw network = "Polygon", asset = "USDC"

**Destination = FUNDER_ADDRESS (not signer).** Small test first (e.g. $5) to
confirm the address pathing is correct.

After the deposit settles, check:

```
https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=<FUNDER_ADDRESS>
```

You should see your USDC.e balance.

> **V2 cutover note (April 22, 2026):** after the upgrade, USDC.e will be wrapped
> into Polymarket's own pUSD collateral token via the Collateral Onramp.
> `scripts/wrap-to-pusd.ts` (shipped with Scope C) handles this automatically.
> Pre-cutover you only need plain USDC.e.

---

## 5. Create the config file

```bash
cp config/bot-config.example.jsonc config/bot-config.jsonc
chmod 600 config/bot-config.jsonc            # Unix
# Windows:
# icacls config\bot-config.jsonc /inheritance:r /grant:r "%USERNAME%:F"
```

Open `config/bot-config.jsonc` and fill in the `auth` section:

```jsonc
"auth": {
  "authMode": "PROXY",
  "signatureType": 2,

  "signerPrivateKey": "0x<the private key from step 1>",
  "funderAddress":    "0x<the proxy address from step 3>",

  "clob": {
    "apiKey":        "",      // filled in step 6
    "apiSecret":     "",
    "apiPassphrase": "",
    "apiKeyAddress": ""       // your SIGNER address
  },

  "relayer": {
    "key":        "",         // filled in step 7
    "keyAddress": ""
  }
}
```

The config file is git-ignored by default (see [.gitignore](../.gitignore)).

---

## 6. Derive CLOB API credentials

Run:

```bash
tsx scripts/derive-clob-creds.ts
```

The script signs a request with your private key and Polymarket returns a
`(apiKey, secret, passphrase)` triplet. The operation is **deterministic** —
re-running later yields the same triplet.

Paste the output into `config/bot-config.jsonc → auth.clob`:

```jsonc
"clob": {
  "apiKey":        "d3f4c1b2-...",
  "apiSecret":     "base64-secret-here",
  "apiPassphrase": "16-char-string",
  "apiKeyAddress": "0x<SIGNER_ADDRESS>"
}
```

**Troubleshooting**

| Error | Fix |
|---|---|
| `signer has never been registered` | You skipped step 3. Sign in to polymarket.com first. |
| `403 Cloudflare` / geo block | Set `polymarket.geoToken` in the config (use ssh to a VPS in a supported region, or request a token from support). |
| `Wrong host for chain` | Check `polymarket.clobHost` matches your `polymarket.apiVersion`. |

---

## 7. (Optional) Get a relayer key

Required only if you want the bot to call redeem / approve gaslessly.

1. polymarket.com → Settings → **Relayer API Keys** → *Generate new*
2. Copy the key and the address it is bound to
3. Paste into `auth.relayer`:

```jsonc
"relayer": {
  "key":        "<opaque string>",
  "keyAddress": "0x<SIGNER_ADDRESS>"
}
```

If you leave this blank, redeem transactions fall back to on-chain (costs gas
from the signer).

---

## 8. Verify everything end-to-end

```bash
tsx scripts/verify-setup.ts
```

Expected output (all green):

```
  [✓] SIGNER_PRIVATE_KEY                    0xABC...123
  [✓] FUNDER_ADDRESS                        0xDEF...456
  [✓] CLOB API triplet                      present
  [✓] CLOB API version                      v1 → https://clob.polymarket.com
  [✓] RPC reachable                         https://polygon.drpc.org
  [✓] Signer MATIC balance                  0.5000 MATIC
  [✓] Funder USDC.e balance                 25.00 USDC
  [✓] CLOB /time                            status 200
  [✓] Gamma /markets                        status 200
  [✓] CLOB auth (getOpenOrders)             credentials accepted

Summary: 9 ok, 0 warn, 0 fail
```

If anything is red/yellow, re-read the corresponding section above. Do **not**
proceed to live trading until the summary shows `0 fail`.

---

## 9. Start the bot

Start in simulation first — zero risk, validates the full pipeline:

```jsonc
// config/bot-config.jsonc
"mode": {
  "simulation": true,
  "dryRun": true,
  ...
}
```

```bash
npm start
```

Watch `reports/runtime-status.json` and `reports/trade-journal_*.log` for 5–10
minutes. Once you see quote updates + simulated fills cycling cleanly, switch
to live:

```jsonc
"mode": {
  "simulation": false,
  "dryRun": false,
  ...
}
```

Start with tight risk limits — see `docs/CONFIGURATION.md` and
`memory/SESSION_HANDOFF_*.md` for battle-tested defaults.

---

## Security checklist (read before going live)

- [ ] Private key is ONLY in `config/bot-config.jsonc` (or a real secrets
      manager), never in `.env` committed to a repo, never in shell history
- [ ] `config/bot-config.jsonc` has 0600 / equivalent ACL
- [ ] Repo has `config/bot-config.jsonc` in `.gitignore` (verify with
      `git check-ignore -v config/bot-config.jsonc`)
- [ ] Funder address has **only** the capital you can afford to lose
- [ ] Signer has MATIC for gas but **no USDC** (keep USDC in the proxy)
- [ ] VPS: SSH key-only auth, no password login, firewall restricts inbound
- [ ] You have a copy of the private key in an offline password manager

---

## Going to V2 (April 22, 2026)

At cutover:

1. Set `polymarket.apiVersion: "v2"` in the config
2. Point `polymarket.clobHost` at the V2 URL
3. Run `tsx scripts/wrap-to-pusd.ts` to convert USDC.e → pUSD
4. Re-run `tsx scripts/verify-setup.ts` to confirm everything still works
5. Restart the bot

Details: `docs/V2_MIGRATION.md`.
