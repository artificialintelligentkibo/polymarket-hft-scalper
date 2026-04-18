/**
 * Collateral Onramp — pUSD wrap/unwrap helpers for the Polymarket V2 upgrade.
 *
 * Starting April 22, 2026, Polymarket V2 uses its own ERC-20 `pUSD` as the
 * exchange collateral instead of USDC.e. Holders of legacy positions must
 * wrap their USDC.e into pUSD via the Collateral Onramp contract. Exit path
 * uses `unwrap()` to go back to USDC.e.
 *
 * This module is a pure helper — it does NOT run on start-up. Invoke from
 * `scripts/wrap-to-pusd.ts` or from application code explicitly.
 *
 * Contract interface (from the V2 migration notes):
 *
 *   function wrap(uint256 amount) external;     // USDC.e (6 dec) → pUSD (6 dec)
 *   function unwrap(uint256 amount) external;   // pUSD (6 dec) → USDC.e (6 dec)
 *
 * Addresses + ABI fragment are configuration-driven so we can finalize them
 * post-cutover without code changes.
 */

import { Contract, providers, Wallet, type BigNumber, utils } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const ONRAMP_ABI = [
  'function wrap(uint256 amount)',
  'function unwrap(uint256 amount)',
];

export interface OnrampContext {
  readonly provider: providers.Provider;
  readonly signer: Wallet;
  readonly usdcAddress: string;
  readonly pusdAddress: string;
  readonly onrampAddress: string;
}

export function buildOnrampContext(options: {
  readonly rpcUrl?: string;
  readonly privateKey?: string;
  readonly usdcAddress?: string;
  readonly pusdAddress?: string;
  readonly onrampAddress?: string;
} = {}): OnrampContext {
  const rpc = options.rpcUrl || config.rpcUrl;
  const privateKey = options.privateKey || config.signerPrivateKey;
  if (!privateKey) {
    throw new Error('Signer private key not configured (auth.signerPrivateKey)');
  }
  const provider = new providers.StaticJsonRpcProvider(rpc, config.chainId);
  const signer = new Wallet(privateKey, provider);

  const usdcAddress = options.usdcAddress || config.contracts.usdc;
  const pusdAddress = (options.pusdAddress || process.env.POLY_PUSD_ADDRESS || '').trim();
  const onrampAddress = (
    options.onrampAddress || process.env.POLY_COLLATERAL_ONRAMP_ADDRESS || ''
  ).trim();

  if (!pusdAddress) {
    throw new Error('pUSD address not configured (contracts.v2.collateral)');
  }
  if (!onrampAddress) {
    throw new Error('Collateral onramp address not configured (contracts.v2.collateralOnramp)');
  }

  return { provider, signer, usdcAddress, pusdAddress, onrampAddress };
}

/**
 * Wrap USDC.e → pUSD via the Collateral Onramp.
 *
 * Approves the onramp for the exact amount (or MaxUint256 if `infinite=true`)
 * before calling `wrap(amount)`. Returns the onramp tx hash.
 *
 * @param amountRaw amount in USDC.e smallest units (6 decimals)
 */
export async function wrapToPusd(
  ctx: OnrampContext,
  amountRaw: BigNumber,
  options: { infinite?: boolean } = {}
): Promise<{ approveTxHash?: string; wrapTxHash: string }> {
  const usdc = new Contract(ctx.usdcAddress, ERC20_ABI, ctx.signer);
  const onramp = new Contract(ctx.onrampAddress, ONRAMP_ABI, ctx.signer);

  const owner = await ctx.signer.getAddress();
  const current: BigNumber = await usdc.allowance(owner, ctx.onrampAddress);

  let approveTxHash: string | undefined;
  if (current.lt(amountRaw)) {
    const approveAmount = options.infinite
      ? utils.parseUnits('1000000000', 6) // 1B USDC — effectively infinite for this use case
      : amountRaw;
    logger.info('Approving USDC.e for Collateral Onramp', {
      onramp: ctx.onrampAddress,
      amount: utils.formatUnits(approveAmount, 6),
    });
    const approveTx = await usdc.approve(ctx.onrampAddress, approveAmount);
    await approveTx.wait();
    approveTxHash = approveTx.hash;
  }

  logger.info('Calling Onramp.wrap()', {
    amount: utils.formatUnits(amountRaw, 6),
    onramp: ctx.onrampAddress,
  });
  const wrapTx = await onramp.wrap(amountRaw);
  const receipt = await wrapTx.wait();
  return { approveTxHash, wrapTxHash: receipt.transactionHash };
}

/**
 * Unwrap pUSD → USDC.e via the Collateral Onramp.
 *
 * @param amountRaw amount in pUSD smallest units (6 decimals)
 */
export async function unwrapFromPusd(
  ctx: OnrampContext,
  amountRaw: BigNumber
): Promise<{ unwrapTxHash: string }> {
  const onramp = new Contract(ctx.onrampAddress, ONRAMP_ABI, ctx.signer);
  logger.info('Calling Onramp.unwrap()', {
    amount: utils.formatUnits(amountRaw, 6),
    onramp: ctx.onrampAddress,
  });
  const tx = await onramp.unwrap(amountRaw);
  const receipt = await tx.wait();
  return { unwrapTxHash: receipt.transactionHash };
}

/**
 * Read balances for the signer address in both USDC.e and pUSD.
 */
export async function readCollateralBalances(
  ctx: OnrampContext,
  address?: string
): Promise<{ usdc: BigNumber; pusd: BigNumber; owner: string }> {
  const owner = address || (await ctx.signer.getAddress());
  const usdc = new Contract(ctx.usdcAddress, ERC20_ABI, ctx.provider);
  const pusd = new Contract(ctx.pusdAddress, ERC20_ABI, ctx.provider);
  const [usdcBal, pusdBal] = await Promise.all([
    usdc.balanceOf(owner) as Promise<BigNumber>,
    pusd.balanceOf(owner) as Promise<BigNumber>,
  ]);
  return { usdc: usdcBal, pusd: pusdBal, owner };
}
