# Polymarket V2 Migration Guide

**Cutover: April 22, 2026** (~1 hour downtime window).

This guide documents every bot change required for the Polymarket V2 upgrade
and the toggles that let you run the old code path until cutover day.

---

## What changes upstream

| Area | V1 (current) | V2 (from April 22, 2026) |
|---|---|---|
| CLOB host | `https://clob.polymarket.com` | new URL, TBD (staged at `clob-v2.polymarket.com`) |
| CLOB SDK | `@polymarket/clob-client@^5.8.1` | `@polymarket/clob-client-v2@1.0.0` |
| EIP-712 domain version | `"1"` | `"2"` |
| Exchange contract | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | `0xE111180000d2663C0091e4f400237545B87B996B` |
| NegRisk Exchange contract | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | `0xe2222d279d744050d28e00520010520000310F59` |
| Collateral token | USDC.e (`0x2791...84174`) | pUSD (address TBD) |
| Order struct | `{ nonce, feeRateBps, taker, ... }` | removes `nonce/feeRateBps/taker`, adds `timestamp/metadata/builder` |
| Gamma pagination | offset-based `/markets?offset=N` | cursor-based `/markets/keyset?after_cursor=...` |

Legacy offset-based pagination deprecates **three weeks after April 10, 2026**.

---

## Toggles shipped in this repo

All toggles live in `config/bot-config.jsonc` and map to process.env variables
for backwards compatibility.

### 1. Keyset pagination (Scope A)

```jsonc
"polymarket": {
  "useKeysetPagination": false   // GAMMA_USE_KEYSET_PAGINATION
}
```

- `false` (default): legacy `/markets` + `?offset` code path.
- `true`: bot requests `/markets/keyset` first and falls back to `/markets` on
  any error. Safe to enable now — the keyset endpoints are already live.

Files affected:
- [src/monitor.ts](../src/monitor.ts) — `fetchPaginatedGammaEventMarkets`
- [src/resolution-checker.ts](../src/resolution-checker.ts) — `fetchMarketByConditionId`

### 2. CLOB API version (Scope B)

```jsonc
"polymarket": {
  "apiVersion": "v1",                                    // CLOB_API_VERSION
  "clobHost":   "https://clob.polymarket.com",           // CLOB_HOST
  "clobHostV2": "https://clob-v2.polymarket.com"         // CLOB_HOST_V2
}
```

`resolveClobHost()` in [src/clob-adapter.ts](../src/clob-adapter.ts) picks
`clobHostV2` when `apiVersion === "v2"`, else `clobHost`.

The full V2 SDK wiring is sketched in
[src/clob-v2-adapter.ts](../src/clob-v2-adapter.ts):
- Lazy import of `@polymarket/clob-client-v2` (not installed by default)
- Fails loudly if `apiVersion=v2` but SDK is missing
- `assertV2OrderShape()` helper for catching V1 struct leaks

### 3. Contract addresses (Scope B/C)

```jsonc
"contracts": {
  "v1": { "exchange": "...", "negRiskExchange": "...", "collateral": "..." },
  "v2": { "exchange": "...", "negRiskExchange": "...", "collateral": "", "collateralOnramp": "" }
}
```

Populate `contracts.v2.collateral` (pUSD address) and
`contracts.v2.collateralOnramp` at cutover. Until then they are empty — the
V2 code path refuses to run without them, which is the safe default.

### 4. Collateral onramp (Scope C)

```bash
tsx scripts/wrap-to-pusd.ts --amount 100    # USDC.e → pUSD
tsx scripts/wrap-to-pusd.ts --unwrap --amount 50  # pUSD → USDC.e
```

Helpers: [src/collateral-onramp.ts](../src/collateral-onramp.ts).
Contract interface assumed (verify against Polymarket's final ABI):

```solidity
function wrap(uint256 amount) external;    // 1:1 USDC.e → pUSD
function unwrap(uint256 amount) external;  // 1:1 pUSD → USDC.e
```

---

## Cutover-day playbook

### T-7 days (April 15)
- [ ] Enable `useKeysetPagination: true` and let the bot run overnight on the
      new pagination code path. Watch logs for keyset-related errors.
- [ ] `npm install @polymarket/clob-client-v2` (once Polymarket publishes it).
- [ ] Manually verify `contracts.v2.collateral` + `collateralOnramp` values
      once Polymarket publishes the post-cutover addresses.

### T-1 day (April 21, evening)
- [ ] Stop the bot cleanly:
      ```bash
      ssh <user>@<vps> "pm2 stop polymarket-hft-scalper"
      ```
- [ ] Exit all open positions OR accept that they settle through the V2 redeem
      path automatically.
- [ ] `git pull` the final V2-ready code onto the VPS.

### T-0 (April 22, cutover window)
- [ ] Wait for Polymarket to announce the V2 API is live.
- [ ] Wrap collateral:
      ```bash
      tsx scripts/wrap-to-pusd.ts --all
      ```
- [ ] Edit `config/bot-config.jsonc`:
      ```jsonc
      "polymarket": {
        "apiVersion": "v2",
        "clobHost":   "<new V2 production URL>",
        "useKeysetPagination": true
      }
      ```
- [ ] Run verification:
      ```bash
      tsx scripts/verify-setup.ts
      ```
- [ ] Start the bot in simulation first (`mode.simulation: true`), then flip
      back to live after 10 minutes of clean quote activity.

### T+24h
- [ ] Compare realized PnL distribution against pre-cutover baseline —
      flag >2σ divergence for investigation (order struct bug, fee model
      change, etc.).

---

## Rollback plan

If V2 goes poorly in the first hour:

1. `pm2 stop polymarket-hft-scalper`
2. Unwrap pUSD → USDC.e if you can still reach the onramp:
   ```bash
   tsx scripts/wrap-to-pusd.ts --unwrap --all
   ```
3. There is NO technical rollback to V1 — Polymarket deprecates the V1
   exchange at cutover. If V2 is broken, the only option is to pause trading
   and wait for Polymarket to fix it.

---

## References

- [Polymarket V2 upgrade announcement](https://docs.polymarket.com) — check for latest.
- [Keyset pagination API](https://docs.polymarket.com) — `/markets/keyset`, `/events/keyset`.
- [src/clob-adapter.ts](../src/clob-adapter.ts) — V1 adapter, host resolution.
- [src/clob-v2-adapter.ts](../src/clob-v2-adapter.ts) — V2 adapter skeleton.
- [src/collateral-onramp.ts](../src/collateral-onramp.ts) — wrap/unwrap helpers.
- [docs/WALLET_SETUP.md](WALLET_SETUP.md) — fresh deployment from scratch.
