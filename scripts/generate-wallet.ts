#!/usr/bin/env tsx
/**
 * generate-wallet.ts — create a fresh Ethereum EOA (Polygon-compatible).
 *
 * Produces a new random keypair and prints the address + private key + mnemonic
 * to stdout. Optionally writes the private key to a file with 0o600 perms
 * (Unix) so nothing ever sits in shell history.
 *
 * USAGE
 *   tsx scripts/generate-wallet.ts                      # print to stdout only
 *   tsx scripts/generate-wallet.ts --out wallet.secret  # also write to file
 *   tsx scripts/generate-wallet.ts --mnemonic           # also show mnemonic
 *   tsx scripts/generate-wallet.ts --quiet              # private key only (for piping)
 *
 * SECURITY NOTES
 *   • Run in a trusted shell, never paste the output anywhere online.
 *   • On Unix/macOS: `chmod 600 wallet.secret` is applied automatically.
 *   • On Windows: restrict ACL via `icacls wallet.secret /inheritance:r /grant:r "%USERNAME%:F"`.
 *   • The address derived from this key is the "SIGNER" address. It is NOT your
 *     Polymarket funder (proxy) address — that one is created by Polymarket the
 *     first time you deposit.
 */

import { writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { Wallet } from 'ethers';

interface Args {
  out: string | null;
  showMnemonic: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: null, showMnemonic: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--mnemonic') args.showMnemonic = true;
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--out') args.out = argv[++i] ?? null;
    else if (a?.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

function printHelp(): void {
  const text = `
generate-wallet.ts — create a fresh Ethereum EOA

Usage:
  tsx scripts/generate-wallet.ts [--out <path>] [--mnemonic] [--quiet]

Options:
  --out <path>   Write private key to <path> (0o600 on Unix). No newline.
  --mnemonic     Also print the 12-word recovery phrase.
  --quiet, -q    Print only the raw private key (hex) to stdout. No other output.
  --help, -h     Show this message.

Next steps after generation:
  1. Save the private key in a password manager.
  2. Copy the ADDRESS and fund it with ~0.5 MATIC for gas (via bridge or CEX).
  3. Go to polymarket.com, sign in with this EOA (MetaMask/Rabby), deposit USDC.
  4. On polymarket.com → Settings → copy your PROXY (funder) address.
  5. Paste SIGNER key + FUNDER address into config/bot-config.jsonc.
  6. Run: tsx scripts/derive-clob-creds.ts  to get CLOB API credentials.
`.trim();
  process.stdout.write(text + '\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const wallet = Wallet.createRandom();

  if (args.quiet) {
    process.stdout.write(wallet.privateKey + '\n');
    return;
  }

  process.stdout.write('\n=== NEW WALLET GENERATED ===\n\n');
  process.stdout.write(`Address:     ${wallet.address}\n`);
  process.stdout.write(`Private key: ${wallet.privateKey}\n`);
  if (args.showMnemonic && wallet.mnemonic?.phrase) {
    process.stdout.write(`Mnemonic:    ${wallet.mnemonic.phrase}\n`);
  }
  process.stdout.write('\n');

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    writeFileSync(outPath, wallet.privateKey, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(outPath, 0o600);
    } catch {
      /* Windows will ignore — user must icacls manually */
    }
    process.stdout.write(`Private key written to: ${outPath} (perms 0o600)\n`);
    if (process.platform === 'win32') {
      process.stdout.write(
        `  Windows users: restrict ACL manually:\n` +
          `  icacls "${outPath}" /inheritance:r /grant:r "%USERNAME%:F"\n`
      );
    }
    process.stdout.write('\n');
  }

  process.stdout.write('⚠️  BACK UP THE PRIVATE KEY NOW. If lost, the wallet is gone forever.\n');
  process.stdout.write('⚠️  NEVER paste it into chat apps, screenshots, or public repos.\n\n');
  process.stdout.write('Next: see docs/WALLET_SETUP.md for the full onboarding flow.\n\n');
}

main();
