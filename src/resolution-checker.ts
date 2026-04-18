import { config } from './config.js';
import { logger } from './logger.js';
import {
  asRecord,
  asString,
  parseBooleanLoose,
  parseStringArray,
  roundTo,
  toFiniteNumberOrNull,
  type JsonRecord,
} from './utils.js';

const DEFAULT_RESOLUTION_TIMEOUT_MS = 5_000;

export interface MarketResolution {
  readonly conditionId: string;
  readonly resolved: boolean;
  readonly winningOutcome: 'YES' | 'NO' | null;
  readonly yesFinalPrice: number | null;
  readonly noFinalPrice: number | null;
  readonly checkedAt: Date;
}

/**
 * Converts verified market resolution into the actual redeem payout in USDC.
 * Only the winning side pays out in binary markets.
 */
export function resolveVerifiedRedeemPayoutUsd(params: {
  yesShares: unknown;
  noShares: unknown;
  winningOutcome: 'YES' | 'NO' | null;
}): number {
  const yesShares = normalizeSettlementShares(params.yesShares);
  const noShares = normalizeSettlementShares(params.noShares);
  if (params.winningOutcome === 'YES') {
    return yesShares;
  }
  if (params.winningOutcome === 'NO') {
    return noShares;
  }

  return 0;
}

/**
 * Fetches market resolution from Gamma so redeem PnL can use a verified winner
 * instead of inferring payout from raw share counts.
 */
export class ResolutionChecker {
  constructor(
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly gammaUrl?: string;
      readonly requestTimeoutMs?: number;
      readonly now?: () => Date;
      readonly useKeysetPagination?: boolean;
    } = {}
  ) {}

  /**
   * Resolves the winner for a condition id using the Polymarket Gamma markets API.
   */
  async checkResolution(params: {
    conditionId: string;
    slug?: string | null;
  }): Promise<MarketResolution> {
    const checkedAt = this.now();
    const conditionId = String(params.conditionId || '').trim();
    if (!conditionId) {
      return {
        conditionId,
        resolved: false,
        winningOutcome: null,
        yesFinalPrice: null,
        noFinalPrice: null,
        checkedAt,
      };
    }

    try {
      const market =
        (await this.fetchMarketByConditionId(conditionId)) ??
        (params.slug ? await this.fetchMarketBySlug(params.slug) : null);
      return resolveMarketResolutionFromRecord(conditionId, market, checkedAt);
    } catch (error) {
      logger.warn('Market resolution lookup failed', {
        conditionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        conditionId,
        resolved: false,
        winningOutcome: null,
        yesFinalPrice: null,
        noFinalPrice: null,
        checkedAt,
      };
    }
  }

  private async fetchMarketByConditionId(conditionId: string): Promise<JsonRecord | null> {
    const baseUrl = this.gammaUrl().replace(/\/+$/, '');
    const match = (records: readonly JsonRecord[]): JsonRecord | null =>
      records.find(
        (record) =>
          String(record.conditionId ?? record.condition_id ?? '').trim().toLowerCase() ===
          conditionId.toLowerCase()
      ) ?? null;

    // V2 migration: try /markets/keyset first when the toggle is on, fall back to /markets.
    if (this.useKeysetPagination()) {
      try {
        const keysetUrl = new URL(`${baseUrl}/markets/keyset`);
        keysetUrl.searchParams.set('condition_ids', conditionId);
        keysetUrl.searchParams.set('limit', '10');
        const payload = await this.fetchJson(keysetUrl);
        const hit = match(extractMarketRecords(payload));
        if (hit) {
          return hit;
        }
      } catch (error) {
        logger.warn('Gamma /markets/keyset lookup failed, falling back to /markets', {
          conditionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const url = new URL(`${baseUrl}/markets`);
    url.searchParams.set('condition_ids', conditionId);
    url.searchParams.set('limit', '10');

    const payload = await this.fetchJson(url);
    return match(extractMarketRecords(payload));
  }

  private async fetchMarketBySlug(slug: string): Promise<JsonRecord | null> {
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedSlug) {
      return null;
    }

    const url = new URL(
      `${this.gammaUrl().replace(/\/+$/, '')}/markets/slug/${encodeURIComponent(normalizedSlug)}`
    );
    const payload = await this.fetchJson(url);
    return asRecord(payload);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`Resolution check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();

    try {
      const response = await this.fetchImpl()(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Gamma markets API returned ${response.status}${body ? `: ${body.trim()}` : ''}`
        );
      }

      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Resolution check timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private gammaUrl(): string {
    return this.options.gammaUrl ?? config.clob.gammaUrl;
  }

  private useKeysetPagination(): boolean {
    return this.options.useKeysetPagination ?? config.clob.useKeysetPagination ?? false;
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }
}

function resolveMarketResolutionFromRecord(
  conditionId: string,
  market: JsonRecord | null,
  checkedAt: Date
): MarketResolution {
  if (!market) {
    return {
      conditionId,
      resolved: false,
      winningOutcome: null,
      yesFinalPrice: null,
      noFinalPrice: null,
      checkedAt,
    };
  }

  const explicitWinner = resolveExplicitWinner(market);
  const prices = resolveOutcomePrices(market);
  const winningOutcome = explicitWinner ?? resolveWinnerFromPrices(prices);

  return {
    conditionId,
    resolved: winningOutcome !== null,
    winningOutcome,
    yesFinalPrice: prices.yesFinalPrice,
    noFinalPrice: prices.noFinalPrice,
    checkedAt,
  };
}

function extractMarketRecords(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }

  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const nestedRecords = Array.isArray(record.markets) ? record.markets : Array.isArray(record.data) ? record.data : [];
  if (nestedRecords.length > 0) {
    return nestedRecords
      .map(asRecord)
      .filter((entry): entry is JsonRecord => entry !== null);
  }

  return [record];
}

function resolveExplicitWinner(record: JsonRecord): 'YES' | 'NO' | null {
  const directWinner = normalizeOutcomeLabel(
    record.winningOutcome ?? record.winner ?? record.result
  );
  if (directWinner !== 'UNKNOWN') {
    return directWinner;
  }

  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  const winningTokens = tokens
    .map(asRecord)
    .filter((token): token is JsonRecord => token !== null)
    .filter((token) => parseBooleanLoose(token.winner ?? token.isWinner, false));

  if (winningTokens.length !== 1) {
    return null;
  }

  const winner = normalizeOutcomeLabel(
    winningTokens[0].outcome ?? winningTokens[0].label ?? winningTokens[0].name
  );
  return winner === 'UNKNOWN' ? null : winner;
}

function resolveOutcomePrices(record: JsonRecord): {
  yesFinalPrice: number | null;
  noFinalPrice: number | null;
} {
  let yesFinalPrice: number | null = null;
  let noFinalPrice: number | null = null;

  const labels = parseStringArray(record.outcomes);
  const prices = parseNumericArray(record.outcomePrices);
  for (let index = 0; index < labels.length; index += 1) {
    const normalized = normalizeOutcomeLabel(labels[index]);
    const price = prices[index] ?? null;
    if (normalized === 'YES') {
      yesFinalPrice = price;
    } else if (normalized === 'NO') {
      noFinalPrice = price;
    }
  }

  if (yesFinalPrice !== null || noFinalPrice !== null) {
    return { yesFinalPrice, noFinalPrice };
  }

  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  for (const token of tokens) {
    const tokenRecord = asRecord(token);
    if (!tokenRecord) {
      continue;
    }

    const normalized = normalizeOutcomeLabel(
      tokenRecord.outcome ?? tokenRecord.label ?? tokenRecord.name
    );
    const price =
      toFiniteNumberOrNull(tokenRecord.price) ??
      toFiniteNumberOrNull(tokenRecord.lastPrice) ??
      toFiniteNumberOrNull(tokenRecord.finalPrice);
    if (price === null) {
      continue;
    }

    if (normalized === 'YES') {
      yesFinalPrice = roundTo(price, 4);
    } else if (normalized === 'NO') {
      noFinalPrice = roundTo(price, 4);
    }
  }

  return { yesFinalPrice, noFinalPrice };
}

function resolveWinnerFromPrices(prices: {
  yesFinalPrice: number | null;
  noFinalPrice: number | null;
}): 'YES' | 'NO' | null {
  if (
    prices.yesFinalPrice !== null &&
    prices.noFinalPrice !== null &&
    prices.yesFinalPrice >= 0.99 &&
    prices.noFinalPrice <= 0.01
  ) {
    return 'YES';
  }

  if (
    prices.yesFinalPrice !== null &&
    prices.noFinalPrice !== null &&
    prices.noFinalPrice >= 0.99 &&
    prices.yesFinalPrice <= 0.01
  ) {
    return 'NO';
  }

  return null;
}

function parseNumericArray(value: unknown): Array<number | null> {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNullablePrice(entry));
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => normalizeNullablePrice(entry));
      }
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeNullablePrice(value: unknown): number | null {
  const numeric = toFiniteNumberOrNull(value);
  return numeric === null ? null : roundTo(Math.max(0, numeric), 4);
}

function normalizeSettlementShares(value: unknown): number {
  const numeric = toFiniteNumberOrNull(value);
  return numeric === null ? 0 : roundTo(Math.max(0, numeric), 4);
}

function normalizeOutcomeLabel(value: unknown): 'YES' | 'NO' | 'UNKNOWN' {
  const normalized = asString(value).toUpperCase();
  if (
    normalized === 'YES' ||
    normalized === 'UP' ||
    normalized === 'TRUE' ||
    normalized === 'LONG'
  ) {
    return 'YES';
  }
  if (
    normalized === 'NO' ||
    normalized === 'DOWN' ||
    normalized === 'FALSE' ||
    normalized === 'SHORT'
  ) {
    return 'NO';
  }

  return 'UNKNOWN';
}
