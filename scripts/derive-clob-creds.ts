#!/usr/bin/env tsx
/**
 * derive-clob-creds.ts — create (or recover) Polymarket CLOB API credentials.
 *
 * Polymarket CLOB authenticates order placement with a (key, secret, passphrase)
 * triplet that is derived deterministically from the signer's private key.
 *   • First run against a fresh signer → new creds are CREATED.
 *   • Subsequent runs → SAME creds are RECOVERED (deterministic).
 * The creds are NOT on-chain and NOT exchange-wide: they live on Polymarket's
 * API gateway and are scoped to the signer address.
 *
 * USAGE
 *   tsx scripts/derive-clob-creds.ts                    # uses config/bot-config.jsonc or .env
 *   tsx scripts/derive-clob-creds.ts --key 0xabc...     # override signer key
 *   tsx scripts/derive-clob-creds.ts --host https://clob-v2.polymarket.com
 *   tsx scripts/derive-clob-creds.ts --chain 137
 *   tsx scripts/derive-clob-creds.ts --json             # machine-readable output
 *
 * WHAT TO DO WITH THE OUTPUT
 *   Paste the printed values into config/bot-config.jsonc → auth.clob:
 *     "apiKey":        "POLYMARKET_API_KEY"
 *     "apiSecret":     "POLYMARKET_API_SECRET"
 *     "apiPassphrase": "POLYMARKET_API_PASSPHRASE"
 *     "apiKeyAddress": "<signer address — NOT funder>"
 */

import '../src/settings-loader.js';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

interface Args {
  key: string | null;
  host: string | null;
  chain: number | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { key: null, host: null, chain: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--key') args.key = argv[++i] ?? null;
    else if (a === '--host') args.host = argv[++i] ?? null;
    else if (a === '--chain') {
      const raw = argv[++i];
      args.chain = raw ? Number.parseInt(raw, 10) : null;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `
derive-clob-creds.ts — get Polymarket CLOB API credentials for your signer.

Usage:
  tsx scripts/derive-clob-creds.ts [--key 0x...] [--host URL] [--chain 137] [--json]

Environment (read automatically from config/bot-config.jsonc + .env):
  SIGNER_PRIVATE_KEY       required if --key not given
  CLOB_HOST                default: https://clob.polymarket.com
  CLOB_HOST_V2             used if CLOB_API_VERSION=v2
  CLOB_API_VERSION         "v1" | "v2"
  CHAIN_ID                 default: 137

Flags:
  --key <hex>    Override SIGNER_PRIVATE_KEY for this invocation only.
  --host <url>   Override CLOB host (e.g. point at V2 pre-cutover).
  --chain <id>   Override chain id.
  --json         Emit a JSON object { apiKey, secret, passphrase, address } only.
  --help         Show this message.

Notes:
  • Deterministic: re-running with the same signer yields the same creds.
  • The apiKeyAddress is the SIGNER address, not the funder/proxy.
`.trim() + '\n'
  );
}

function pickHost(cliHost: string | null): string {
  if (cliHost) return cliHost;
  const version = (process.env.CLOB_API_VERSION || 'v1').trim().toLowerCase();
  if (version === 'v2') {
    return (process.env.CLOB_HOST_V2 || 'https://clob-v2.polymarket.com').trim();
  }
  return (process.env.CLOB_HOST || 'https://clob.polymarket.com').trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const privateKey = (args.key || process.env.SIGNER_PRIVATE_KEY || '').trim();
  if (!privateKey) {
    process.stderr.write(
      'ERROR: no signer private key. Set SIGNER_PRIVATE_KEY in config/bot-config.jsonc\n' +
        '       (auth.signerPrivateKey) or pass --key 0x...\n'
    );
    process.exit(2);
  }

  const host = pickHost(args.host);
  const chainId = args.chain ?? Number.parseInt(process.env.CHAIN_ID || '137', 10);

  const wallet = new Wallet(privateKey);
  const client = new ClobClient(host, chainId as unknown as number, wallet as unknown as never);

  if (!args.json) {
    process.stdout.write('\n=== DERIVING CLOB API CREDENTIALS ===\n');
    process.stdout.write(`Host:     ${host}\n`);
    process.stdout.write(`Chain:    ${chainId}\n`);
    process.stdout.write(`Signer:   ${wallet.address}\n\n`);
  }

  let creds: { apiKey?: string; key?: string; secret?: string; passphrase?: string };
  const maybeCreateOrDerive = (client as unknown as {
    createOrDeriveApiKey?: () => Promise<typeof creds>;
  }).createOrDeriveApiKey;

  try {
    if (maybeCreateOrDerive) {
      creds = await maybeCreateOrDerive.call(client);
    } else {
      try {
        creds = await client.deriveApiKey();
      } catch {
        creds = await client.createApiKey();
      }
    }
  } catch (error) {
    process.stderr.write(
      `ERROR: CLOB credential derivation failed — ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.stderr.write(
      'Common causes: wrong host for chain, signer has never been registered (try depositing first),\n' +
        'or Cloudflare/geo block (set POLYMARKET_GEO_TOKEN).\n'
    );
    process.exit(1);
  }

  const apiKey = creds.apiKey || creds.key;
  if (!apiKey || !creds.secret || !creds.passphrase) {
    process.stderr.write('ERROR: Polymarket returned an incomplete credential payload.\n');
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          apiKey,
          secret: creds.secret,
          passphrase: creds.passphrase,
          address: wallet.address,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  process.stdout.write('--- paste into config/bot-config.jsonc → auth.clob ---\n');
  process.stdout.write(`  "apiKey":        "${apiKey}",\n`);
  process.stdout.write(`  "apiSecret":     "${creds.secret}",\n`);
  process.stdout.write(`  "apiPassphrase": "${creds.passphrase}",\n`);
  process.stdout.write(`  "apiKeyAddress": "${wallet.address}"\n`);
  process.stdout.write('------------------------------------------------------\n\n');
  process.stdout.write('⚠️  Re-running this script with the SAME signer returns the SAME creds.\n');
  process.stdout.write('⚠️  Treat secret + passphrase like a password — store in a vault.\n\n');
}

main().catch((error) => {
  process.stderr.write(`unhandled: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
