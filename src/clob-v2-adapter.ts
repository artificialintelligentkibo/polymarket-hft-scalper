/**
 * CLOB V2 Adapter — skeleton.
 *
 * Active from April 22, 2026. Until then this module is dormant and only the
 * V1 code path in `clob-adapter.ts` runs.
 *
 * Design goals:
 *   • Dynamic import of `@polymarket/clob-client-v2` so the codebase still
 *     compiles and runs when the package isn't installed yet.
 *   • One thin interface shared with V1 so callers don't branch per version.
 *   • Fail loudly if V2 is requested but the package is missing — we do NOT
 *     silently fall back to V1, because the wrong host + V1 SDK post-cutover
 *     will produce cryptic order rejections.
 *
 * Key differences from V1 (documented here as a checklist; implementation
 * stubs below will be filled when the V2 SDK ships and we cut over):
 *
 *   1. EIP-712 domain version "1" → "2"
 *   2. Exchange contract addresses:
 *        V2 Exchange:          0xE111180000d2663C0091e4f400237545B87B996B
 *        V2 NegRisk Exchange:  0xe2222d279d744050d28e00520010520000310F59
 *   3. Order struct changes:
 *        - REMOVE: nonce, feeRateBps, taker
 *        - ADD:    timestamp, metadata (bytes), builder (address)
 *   4. Collateral: USDC.e → pUSD (via Collateral Onramp `wrap()` — see
 *      `src/collateral-onramp.ts`, scope C)
 *   5. Gamma endpoints: cursor pagination (/markets/keyset, /events/keyset)
 *      — already handled by the `clob.useKeysetPagination` toggle in V1 code.
 */

import type { ApiKeyCreds } from '@polymarket/clob-client';
import { logger } from './logger.js';
import type { BuilderAttribution, ClobAdapterConfig } from './clob-adapter.js';

const V2_PACKAGE_NAME = '@polymarket/clob-client-v2';

export const V2_EXCHANGE_ADDRESSES = {
  exchange: '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskExchange: '0xe2222d279d744050d28e00520010520000310F59',
} as const;

export const V2_DOMAIN_VERSION = '2';

interface V2ClobClientLike {
  // Filled in when the real V2 SDK is pinned. Kept as `unknown` for now so the
  // TypeScript build does not depend on a package that may not be installed.
  readonly __brand?: 'clob-v2-client';
}

let cachedV2Module: unknown | null = null;
let v2ModuleLoadAttempted = false;

async function loadV2Module(): Promise<unknown | null> {
  if (v2ModuleLoadAttempted) {
    return cachedV2Module;
  }
  v2ModuleLoadAttempted = true;
  try {
    cachedV2Module = await import(/* @vite-ignore */ V2_PACKAGE_NAME);
  } catch (error) {
    cachedV2Module = null;
    logger.warn('CLOB V2 SDK not installed', {
      packageName: V2_PACKAGE_NAME,
      message: error instanceof Error ? error.message : String(error),
      hint: `npm install ${V2_PACKAGE_NAME} once available`,
    });
  }
  return cachedV2Module;
}

/**
 * Returns true when the V2 SDK is importable. Safe to call at any time.
 */
export async function isV2SdkAvailable(): Promise<boolean> {
  return (await loadV2Module()) !== null;
}

/**
 * Create an unauthenticated V2 CLOB client.
 *
 * @throws Error if the V2 SDK is not installed.
 */
export async function createUnauthenticatedV2Client(
  _config: ClobAdapterConfig,
  _signer: unknown
): Promise<V2ClobClientLike> {
  const mod = await loadV2Module();
  if (!mod) {
    throw new Error(
      `CLOB V2 path requested but ${V2_PACKAGE_NAME} is not installed. ` +
        `Run: npm install ${V2_PACKAGE_NAME}`
    );
  }
  // Concrete wiring deferred until the V2 SDK constructor is pinned.
  throw new Error(
    'createUnauthenticatedV2Client: concrete wiring pending V2 SDK finalization. ' +
      'See src/clob-v2-adapter.ts for the checklist.'
  );
}

/**
 * Create an authenticated V2 CLOB client with optional builder attribution.
 *
 * @throws Error if the V2 SDK is not installed.
 */
export async function createAuthenticatedV2Client(
  _config: ClobAdapterConfig,
  _signer: unknown,
  _creds: ApiKeyCreds,
  _signatureType: number,
  _funderAddress: string,
  _builder?: BuilderAttribution | null
): Promise<V2ClobClientLike> {
  const mod = await loadV2Module();
  if (!mod) {
    throw new Error(
      `CLOB V2 path requested but ${V2_PACKAGE_NAME} is not installed. ` +
        `Run: npm install ${V2_PACKAGE_NAME}`
    );
  }
  throw new Error(
    'createAuthenticatedV2Client: concrete wiring pending V2 SDK finalization. ' +
      'See src/clob-v2-adapter.ts for the checklist.'
  );
}

/**
 * Sanity-check V2 order parameters before submission.
 * Callers can use this to catch obvious struct mistakes (e.g. still passing
 * `nonce` from a V1 code path) early.
 */
export function assertV2OrderShape(order: Record<string, unknown>): void {
  const forbiddenKeys = ['nonce', 'feeRateBps', 'taker'];
  const requiredKeys = ['timestamp'];
  for (const key of forbiddenKeys) {
    if (key in order) {
      throw new Error(`V2 order must not contain '${key}' — V1 struct leaked into V2 path`);
    }
  }
  for (const key of requiredKeys) {
    if (!(key in order)) {
      throw new Error(`V2 order missing required field '${key}'`);
    }
  }
}
