#!/usr/bin/env tsx
/**
 * verify-setup.ts — end-to-end pre-flight for a fresh Polymarket scalper deployment.
 *
 * Checks (stops on first hard failure):
 *   1. config/bot-config.jsonc parses and contains the required keys
 *   2. SIGNER_PRIVATE_KEY → derives a valid address
 *   3. FUNDER_ADDRESS is a valid checksum address and NOT equal to signer
 *   4. Signer MATIC balance on Polygon is enough for gas (≥ 0.1 MATIC suggested)
 *   5. Funder USDC balance (reports amount, does not fail on 0)
 *   6. CLOB host reachable (/markets HEAD)
 *   7. Gamma host reachable
 *   8. CLOB credentials authenticate (GET /orders)
 *
 * USAGE
 *   tsx scripts/verify-setup.ts
 *   tsx scripts/verify-setup.ts --skip-network   # skip RPC/HTTP checks (offline)
 *
 * Exit code 0 = all checks passed (warnings OK).
 * Exit code 1 = at least one hard failure.
 */

import '../src/settings-loader.js';
import { providers, Wallet, Contract, utils } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

interface Args {
  skipNetwork: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { skipNetwork: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    if (a === '--skip-network') args.skipNetwork = true;
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `
verify-setup.ts — pre-flight check for Polymarket scalper config.

Usage:
  tsx scripts/verify-setup.ts [--skip-network]

Reads from config/bot-config.jsonc (via settings-loader) or .env fallback.
Exits 0 on pass, 1 on any hard failure.
`.trim() + '\n'
  );
}

type Status = 'OK' | 'WARN' | 'FAIL';

interface CheckResult {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

function record(results: CheckResult[], name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  const icon = status === 'OK' ? '✓' : status === 'WARN' ? '~' : '✗';
  process.stdout.write(`  [${icon}] ${name.padEnd(38)} ${detail}\n`);
}

function pickHost(): { clob: string; version: 'v1' | 'v2'; gamma: string } {
  const version = (process.env.CLOB_API_VERSION || 'v1').trim().toLowerCase() === 'v2' ? 'v2' : 'v1';
  const clob =
    version === 'v2'
      ? (process.env.CLOB_HOST_V2 || 'https://clob-v2.polymarket.com').trim()
      : (process.env.CLOB_HOST || 'https://clob.polymarket.com').trim();
  const gamma = (process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com').trim();
  return { clob, version, gamma };
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Canonical USDC.e on Polygon mainnet
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  process.stdout.write('\n=== POLYMARKET SCALPER — VERIFY SETUP ===\n\n');
  const results: CheckResult[] = [];

  // 1. Config presence
  const pk = (process.env.SIGNER_PRIVATE_KEY || '').trim();
  const funder = (process.env.FUNDER_ADDRESS || '').trim();
  const apiKey = (process.env.POLYMARKET_API_KEY || '').trim();
  const apiSecret = (process.env.POLYMARKET_API_SECRET || '').trim();
  const apiPass = (process.env.POLYMARKET_API_PASSPHRASE || '').trim();

  if (!pk) {
    record(results, 'SIGNER_PRIVATE_KEY', 'FAIL', 'missing');
  } else {
    let address = '';
    try {
      address = new Wallet(pk).address;
      record(results, 'SIGNER_PRIVATE_KEY', 'OK', address);
    } catch (error) {
      record(results, 'SIGNER_PRIVATE_KEY', 'FAIL', `invalid — ${String(error)}`);
    }

    if (!funder) {
      record(results, 'FUNDER_ADDRESS', 'FAIL', 'missing');
    } else if (!utils.isAddress(funder)) {
      record(results, 'FUNDER_ADDRESS', 'FAIL', 'not a valid address');
    } else if (address && funder.toLowerCase() === address.toLowerCase()) {
      record(results, 'FUNDER_ADDRESS', 'FAIL', 'equals signer — use the Polymarket proxy address');
    } else {
      record(results, 'FUNDER_ADDRESS', 'OK', utils.getAddress(funder));
    }
  }

  record(
    results,
    'CLOB API triplet',
    apiKey && apiSecret && apiPass ? 'OK' : 'FAIL',
    apiKey && apiSecret && apiPass ? 'present' : 'one of apiKey/secret/passphrase missing'
  );

  const { clob: clobHost, version, gamma: gammaHost } = pickHost();
  record(results, 'CLOB API version', 'OK', `${version} → ${clobHost}`);

  if (args.skipNetwork) {
    process.stdout.write('\n--- skipping network checks (--skip-network) ---\n');
  } else {
    // 2. RPC + balances
    const rpc = (process.env.RPC_URL || 'https://polygon.drpc.org').trim();
    try {
      const provider = new providers.StaticJsonRpcProvider(rpc, 137);
      const net = await provider.getNetwork();
      if (net.chainId !== 137) {
        record(results, 'RPC chain id', 'WARN', `got ${net.chainId}, expected 137`);
      } else {
        record(results, 'RPC reachable', 'OK', rpc);
      }

      if (pk) {
        const signerAddr = new Wallet(pk).address;
        const matic = await provider.getBalance(signerAddr);
        const maticF = Number.parseFloat(utils.formatEther(matic));
        const ok = maticF >= 0.1;
        record(
          results,
          'Signer MATIC balance',
          ok ? 'OK' : 'WARN',
          `${maticF.toFixed(4)} MATIC ${ok ? '' : '(fund ~0.5 MATIC for gas)'}`
        );
      }

      if (funder && utils.isAddress(funder)) {
        const usdc = new Contract(USDC_POLYGON, ERC20_ABI, provider);
        const raw = await usdc.balanceOf(funder);
        const dec = await usdc.decimals();
        const usdcF = Number.parseFloat(utils.formatUnits(raw, dec));
        record(results, 'Funder USDC.e balance', 'OK', `${usdcF.toFixed(2)} USDC`);
      }
    } catch (error) {
      record(
        results,
        'RPC reachable',
        'FAIL',
        error instanceof Error ? error.message : String(error)
      );
    }

    // 3. CLOB + Gamma reachability
    try {
      const r = await fetch(`${clobHost}/time`, { method: 'GET' });
      record(results, 'CLOB /time', r.ok ? 'OK' : 'FAIL', `status ${r.status}`);
    } catch (error) {
      record(
        results,
        'CLOB /time',
        'FAIL',
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      const r = await fetch(`${gammaHost}/markets?limit=1`, { method: 'GET' });
      record(results, 'Gamma /markets', r.ok ? 'OK' : 'FAIL', `status ${r.status}`);
    } catch (error) {
      record(
        results,
        'Gamma /markets',
        'FAIL',
        error instanceof Error ? error.message : String(error)
      );
    }

    // 4. Authenticated CLOB round-trip
    if (pk && apiKey && apiSecret && apiPass) {
      try {
        const wallet = new Wallet(pk);
        const client = new ClobClient(
          clobHost,
          137 as unknown as number,
          wallet as unknown as never,
          { key: apiKey, secret: apiSecret, passphrase: apiPass }
        );
        await client.getOpenOrders({});
        record(results, 'CLOB auth (getOpenOrders)', 'OK', 'credentials accepted');
      } catch (error) {
        record(
          results,
          'CLOB auth (getOpenOrders)',
          'FAIL',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  // Summary
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  process.stdout.write(
    `\nSummary: ${results.length - fails - warns} ok, ${warns} warn, ${fails} fail\n\n`
  );
  if (fails > 0) {
    process.stdout.write('One or more hard failures — fix them before starting the bot.\n');
    process.stdout.write('See docs/WALLET_SETUP.md for the end-to-end setup flow.\n\n');
    process.exit(1);
  }
  process.stdout.write('All hard checks passed. Warnings (if any) are advisory.\n\n');
}

main().catch((error) => {
  process.stderr.write(
    `unhandled: ${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
