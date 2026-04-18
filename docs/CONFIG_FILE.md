# Configuration File Reference

The bot is driven by `config/bot-config.jsonc` — a JSON-with-comments file
that replaces the legacy sprawl of `.env` variables. The example template
`config/bot-config.example.jsonc` is tracked in git; your personalized copy
is **git-ignored** and must be created manually.

---

## Loader order

```
src/config.ts defaults
    ↓ (overridden by)
.env  (legacy, still supported as a fallback)
    ↓ (overridden by)
config/bot-config.jsonc
    ↓ (overridden by)
real process.env  (shell exports — always win)
```

The precedence lets you:
- Keep a canonical config in the JSONC file
- Override one knob for a single run:
  `VS_MM_SHARES=6 npm start`
- Drop in secrets from a secret manager (AWS Secrets Manager, 1Password CLI,
  etc.) via real `process.env` — they take priority over the file.

---

## Files on disk

| Path | Tracked? | Permissions | Purpose |
|---|---|---|---|
| `config/bot-config.example.jsonc` | yes | 0644 | Template — no secrets |
| `config/bot-config.jsonc` | **no** (.gitignore) | 0600 on Unix | Your real config |
| `config/bot-config.*.jsonc` | **no** (.gitignore) | 0600 on Unix | Variant configs (e.g. `bot-config.staging.jsonc`) |
| `.env` | **no** (.gitignore) | 0600 on Unix | Legacy fallback, still honored |

**Permissions are enforced by the tooling, not git.** After copying the
example, lock it down:

```bash
# Unix / macOS
chmod 600 config/bot-config.jsonc

# Windows (PowerShell)
icacls config\bot-config.jsonc /inheritance:r /grant:r "%USERNAME%:F"
```

---

## Quick start

```bash
# 1. Create your config from the template
cp config/bot-config.example.jsonc config/bot-config.jsonc
chmod 600 config/bot-config.jsonc

# 2. Fill in the auth section (signer key + funder address)
#    See docs/WALLET_SETUP.md for generating these from scratch.
$EDITOR config/bot-config.jsonc

# 3. Derive CLOB API creds + paste them in
tsx scripts/derive-clob-creds.ts

# 4. Verify everything works
tsx scripts/verify-setup.ts
```

---

## Migrating from `.env`

If you already have a working `.env`:

```bash
tsx scripts/migrate-env-to-config.ts --source .env --out config/bot-config.jsonc
```

The script:
- Parses `.env` (dotenv-compatible syntax, supports quoted values)
- Maps known keys into the structured sections (`auth`, `polymarket`, `risk`,
  etc.)
- Puts unrecognized keys under `extraEnv` as a flat catch-all
- Writes with `mode 0o600`
- Refuses to overwrite an existing output without `--force`

After running, double-check the structured sections match your intent.
`--dry-run` prints the would-be output without writing.

---

## Section guide

The template file itself is the most up-to-date reference — inline comments
spell out every field and which env var it maps to. High-level shape:

```jsonc
{
  "mode":       { /* simulation / dry-run / product test */ },
  "auth":       { /* signer key, funder, CLOB creds, relayer key — SECRETS */ },
  "polymarket": { /* hosts, API version, keyset toggle */ },
  "contracts":  { /* V1 + V2 on-chain addresses */ },
  "market":     { /* coin whitelist, scan interval, query limits */ },
  "risk":       { /* hard stops, drawdown, trailing */ },
  "strategy":   { /* engine enable flags + preset */ },
  "binance":    { /* fair-value feed */ },
  "execution":  { /* latency monitor, retry policy */ },
  "sizing":     { /* per-signal sizing */ },
  "compounding":{ /* compounding caps */ },
  "entryGuards":{ /* Phase 58 divergence / drift brakes */ },
  "latency":    { /* adaptive latency quantiles */ },
  "logging":    { /* verbosity, file rotation */ },
  "monitoring": { /* runtime-status.json cadence */ },
  "productTest":{ /* tiny-size live test mode */ },
  "dashboard":  { /* HTTP status endpoint */ },
  "extraEnv":   { /* catch-all for unmapped keys */ }
}
```

The `extraEnv` catch-all exists specifically so you can add experimental
knobs without having to first teach the loader about them — everything in
`extraEnv` is merged directly into `process.env`. Fields you promote to a
structured section can then be removed from `extraEnv`.

---

## Secret handling

The config file holds private keys. Treat accordingly:

1. **Never commit.** `.gitignore` already blocks `config/bot-config.jsonc`
   and `config/bot-config.*.jsonc` patterns — verify with:
   ```bash
   git check-ignore -v config/bot-config.jsonc
   ```
2. **File perms.** Always `chmod 600` (or the Windows equivalent). Anyone
   with read access to the file has full control of the wallet.
3. **Prefer a secrets manager for prod.** Injecting the private key via
   `SIGNER_PRIVATE_KEY` as a real env var (AWS Secrets Manager → systemd
   environment file, or `op run --`) takes priority over the config file
   and means the key never hits disk. The loader supports this path
   automatically.
4. **Don't screenshot.** The `auth` block is at the top of the file —
   trivially exposed if you paste unredacted screenshots.
5. **Rotate on compromise.** `tsx scripts/derive-clob-creds.ts` with a new
   signer key produces fresh API creds. There is no way to revoke existing
   creds without rotating the signer.

---

## Loader internals

Implementation: [src/settings-loader.ts](../src/settings-loader.ts).

The loader:
- Runs as a **side effect** on first import of the module
- Resolves the path via `BOT_CONFIG_PATH` override, else
  `config/bot-config.jsonc` relative to the repo root
- Strips JSONC comments (hand-written string-aware parser — preserves `//`
  inside double-quoted strings)
- Walks `STRUCTURED_TO_ENV` (array of `[jsonPath, envName]` tuples) and
  populates `process.env[envName]` only if the value is missing/empty
- Never overrides a real `process.env` value
- Treats empty strings in JSON as "use default"

It is wired first in both entry points:
- [src/index.ts](../src/index.ts)
- [cli/index.ts](../cli/index.ts)

Idempotent: subsequent imports are no-ops thanks to a `globalThis` flag.

---

## Troubleshooting

**Problem:** bot boots with default values, ignores my config file.
- Check the file actually exists at `config/bot-config.jsonc`
- Check `BOT_CONFIG_PATH` env isn't pointing somewhere else
- Check the JSONC syntax — stray trailing commas or unquoted keys will cause
  `JSON.parse` to throw and the loader warns on stderr then gives up
- Verify real `process.env` isn't overriding your file values —
  `env | grep POLY` will list the culprits

**Problem:** `settings-loader: failed to parse config/bot-config.jsonc`
- JSONC allows `//` and `/* ... */` comments but NOT trailing commas or
  single-quoted strings. Run the file through an online JSONC validator.

**Problem:** secret leaked to git.
- Rotate the signer immediately (`tsx scripts/generate-wallet.ts`)
- Derive new CLOB creds (`tsx scripts/derive-clob-creds.ts`)
- Move remaining funds to the new funder before the attacker drains them
- `git filter-repo` or BFG to scrub history if the repo is public
