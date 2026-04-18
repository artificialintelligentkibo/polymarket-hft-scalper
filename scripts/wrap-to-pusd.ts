#!/usr/bin/env tsx
/**
 * wrap-to-pusd.ts — convert USDC.e → pUSD via the Polymarket Collateral Onramp.
 *
 * Required for the April 22, 2026 V2 cutover. Before trading on V2 the funder
 * (or the signer acting on behalf of the funder) must wrap their USDC.e into
 * pUSD. This script handles approve + wrap + verification in one go.
 *
 * USAGE
 *   tsx scripts/wrap-to-pusd.ts --amount 100        # wrap 100 USDC.e → 100 pUSD
 *   tsx scripts/wrap-to-pusd.ts --all               # wrap entire signer balance
 *   tsx scripts/wrap-to-pusd.ts --unwrap --amount 50  # reverse direction
 *   tsx scripts/wrap-to-pusd.ts --dry-run --amount 100
 *
 * PREREQUISITES
 *   • contracts.v2.collateral         set (pUSD address)
 *   • contracts.v2.collateralOnramp   set (onramp address)
 *   • Signer has the USDC.e to wrap (or pUSD to unwrap) at the signer address
 *   • Signer has ~0.05 MATIC for gas
 *
 * NOTE
 *   This script operates on the SIGNER's balance, not the funder's. If your
 *   USDC.e sits on the funder/proxy, move it to the signer first via the
 *   Polymarket relayer or manually via MetaMask → Send.
 */

import '../src/settings-loader.js';
import { utils } from 'ethers';
import {
  buildOnrampContext,
  readCollateralBalances,
  wrapToPusd,
  unwrapFromPusd,
} from '../src/collateral-onramp.js';

interface Args {
  amount: string | null;
  all: boolean;
  unwrap: boolean;
  infinite: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    amount: null,
    all: false,
    unwrap: false,
    infinite: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--all') args.all = true;
    else if (a === '--unwrap') args.unwrap = true;
    else if (a === '--infinite-approve') args.infinite = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--amount') args.amount = argv[++i] ?? null;
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `
wrap-to-pusd.ts — Polymarket V2 collateral onramp helper.

Usage:
  tsx scripts/wrap-to-pusd.ts --amount <usdc_amount>
  tsx scripts/wrap-to-pusd.ts --all
  tsx scripts/wrap-to-pusd.ts --unwrap --amount <pusd_amount>

Flags:
  --amount <n>         Human amount (USDC.e units, e.g. 100.5).
  --all                Wrap the full signer balance (ignores --amount).
  --unwrap             Reverse direction: pUSD → USDC.e.
  --infinite-approve   Approve the onramp for ~1B tokens (skips future approves).
  --dry-run            Print what would happen, don't broadcast.
  --help               Show this message.

Env:
  POLY_PUSD_ADDRESS                 — pUSD token address (or contracts.v2.collateral)
  POLY_COLLATERAL_ONRAMP_ADDRESS    — onramp address (or contracts.v2.collateralOnramp)
`.trim() + '\n'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const ctx = buildOnrampContext();
  const before = await readCollateralBalances(ctx);

  process.stdout.write('\n=== COLLATERAL ONRAMP ===\n');
  process.stdout.write(`Signer:        ${before.owner}\n`);
  process.stdout.write(`USDC.e:        ${ctx.usdcAddress}\n`);
  process.stdout.write(`pUSD:          ${ctx.pusdAddress}\n`);
  process.stdout.write(`Onramp:        ${ctx.onrampAddress}\n`);
  process.stdout.write(`Balance (pre): ${utils.formatUnits(before.usdc, 6)} USDC.e / ${utils.formatUnits(before.pusd, 6)} pUSD\n\n`);

  let amountRaw;
  if (args.all) {
    amountRaw = args.unwrap ? before.pusd : before.usdc;
  } else if (args.amount) {
    amountRaw = utils.parseUnits(args.amount, 6);
  } else {
    process.stderr.write('ERROR: must pass --amount <n> or --all\n');
    process.exit(2);
    return;
  }

  if (amountRaw.isZero()) {
    process.stderr.write('ERROR: resolved amount is zero — nothing to do\n');
    process.exit(2);
    return;
  }

  const direction = args.unwrap ? 'UNWRAP (pUSD → USDC.e)' : 'WRAP (USDC.e → pUSD)';
  process.stdout.write(`Action:        ${direction}\n`);
  process.stdout.write(`Amount:        ${utils.formatUnits(amountRaw, 6)}\n\n`);

  if (args.dryRun) {
    process.stdout.write('[dry-run] skipping broadcast.\n\n');
    return;
  }

  if (args.unwrap) {
    const { unwrapTxHash } = await unwrapFromPusd(ctx, amountRaw);
    process.stdout.write(`unwrap tx:     ${unwrapTxHash}\n`);
  } else {
    const { approveTxHash, wrapTxHash } = await wrapToPusd(ctx, amountRaw, {
      infinite: args.infinite,
    });
    if (approveTxHash) {
      process.stdout.write(`approve tx:    ${approveTxHash}\n`);
    }
    process.stdout.write(`wrap tx:       ${wrapTxHash}\n`);
  }

  const after = await readCollateralBalances(ctx);
  process.stdout.write(
    `\nBalance (post): ${utils.formatUnits(after.usdc, 6)} USDC.e / ${utils.formatUnits(after.pusd, 6)} pUSD\n\n`
  );
}

main().catch((error) => {
  process.stderr.write(
    `ERROR: ${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
