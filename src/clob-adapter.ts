/**
 * CLOB Client Adapter — centralizes ClobClient construction for V2 migration.
 *
 * This module isolates all ClobClient initialization so the future v6 upgrade
 * is localized to a single file. It also wires optional builder attribution
 * when POLY_BUILDER_* env vars are present.
 *
 * @module clob-adapter
 */

import { ClobClient } from '@polymarket/clob-client';
import type { ApiKeyCreds, Chain } from '@polymarket/clob-client';
import type { SignatureType } from '@polymarket/clob-client';
import type { ClobSigner } from '@polymarket/clob-client';
import { logger } from './logger.js';

// Builder attribution types — optional, only when builder-signing-sdk is available
let BuilderConfigClass: (new (opts: { localBuilderCreds: BuilderApiKeyCreds }) => unknown) | null = null;

interface BuilderApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

// Lazy-load builder-signing-sdk to avoid hard dependency when not configured
async function loadBuilderConfig(): Promise<typeof BuilderConfigClass> {
  if (BuilderConfigClass !== null) return BuilderConfigClass;
  try {
    const mod = await import('@polymarket/builder-signing-sdk');
    BuilderConfigClass = mod.BuilderConfig;
    return BuilderConfigClass;
  } catch {
    return null;
  }
}

export interface BuilderAttribution {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

export interface ClobAdapterConfig {
  readonly host: string;
  readonly chainId: number;
  readonly geoBlockToken?: string;
  readonly builder?: BuilderAttribution | null;
}

/**
 * Create an unauthenticated ClobClient (for API key derivation).
 */
export function createUnauthenticatedClobClient(
  config: ClobAdapterConfig,
  signer: ClobSigner
): ClobClient {
  return new ClobClient(
    config.host,
    config.chainId as Chain,
    signer,
    undefined,
    undefined,
    undefined,
    config.geoBlockToken || undefined
  );
}

/**
 * Create an authenticated ClobClient with optional builder attribution.
 */
export async function createAuthenticatedClobClient(
  config: ClobAdapterConfig,
  signer: ClobSigner,
  creds: ApiKeyCreds,
  signatureType: SignatureType,
  funderAddress: string
): Promise<ClobClient> {
  let builderConfig: unknown = undefined;

  if (config.builder) {
    const BC = await loadBuilderConfig();
    if (BC) {
      builderConfig = new BC({
        localBuilderCreds: {
          key: config.builder.apiKey,
          secret: config.builder.secret,
          passphrase: config.builder.passphrase,
        },
      });
      logger.info('Builder attribution configured for CLOB client', {
        builderApiKey: config.builder.apiKey.slice(0, 8) + '...',
      });
    } else {
      logger.warn(
        'POLY_BUILDER_* env vars set but @polymarket/builder-signing-sdk not available — builder attribution disabled'
      );
    }
  }

  return new ClobClient(
    config.host,
    config.chainId as Chain,
    signer,
    creds,
    signatureType,
    funderAddress,
    config.geoBlockToken || undefined,
    undefined, // useServerTime
    builderConfig as undefined
  );
}

/**
 * Parse builder attribution config from environment variables.
 * Returns null if builder env vars are not set.
 */
export function parseBuilderConfig(env: Record<string, string | undefined>): BuilderAttribution | null {
  const apiKey = env.POLY_BUILDER_API_KEY?.trim();
  const secret = env.POLY_BUILDER_SECRET?.trim();
  const passphrase = env.POLY_BUILDER_PASSPHRASE?.trim();

  if (!apiKey || !secret || !passphrase) {
    return null;
  }

  return { apiKey, secret, passphrase };
}
