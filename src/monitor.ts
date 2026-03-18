import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { logger } from './logger.js';

export interface MarketCandidate {
  marketId: string;
  conditionId: string;
  title: string;
  slug?: string;
  liquidityUsd: number;
  volumeUsd: number;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
  yesOutcomeIndex: 0;
  noOutcomeIndex: 1;
  acceptingOrders: boolean;
}

type JsonRecord = Record<string, unknown>;

interface BinaryTokenSet {
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
}

export class MarketMonitor extends EventEmitter {
  private readonly seenSlots = new Map<string, MarketCandidate>();
  private readonly reportedSlots = new Set<string>();

  constructor() {
    super();
  }

  async scanEligibleMarkets(): Promise<MarketCandidate[]> {
    const markets = await this.fetchMarkets();
    const eligible = markets
      .map((market) => this.normalizeMarketCandidate(market))
      .filter((candidate): candidate is MarketCandidate => candidate !== null)
      .filter((candidate) => candidate.liquidityUsd >= config.strategy.minLiquidityUsd)
      .filter((candidate) => candidate.acceptingOrders)
      .filter((candidate) => this.passesWhitelist(candidate))
      .filter((candidate) => this.passesFiveMinuteFilter(candidate))
      .sort((left, right) => {
        const leftEnd = left.endTime ? Date.parse(left.endTime) : Number.MAX_SAFE_INTEGER;
        const rightEnd = right.endTime ? Date.parse(right.endTime) : Number.MAX_SAFE_INTEGER;
        if (leftEnd !== rightEnd) {
          return leftEnd - rightEnd;
        }
        return right.liquidityUsd - left.liquidityUsd;
      })
      .slice(0, config.runtime.marketQueryLimit);

    this.emitSlotEndedEvents(eligible);

    logger.debug('Market scan completed', {
      fetched: markets.length,
      eligible: eligible.length,
      minLiquidityUsd: config.strategy.minLiquidityUsd,
      whitelistSize: config.WHITELIST_CONDITION_IDS.length,
      testMode: config.TEST_MODE,
    });

    return eligible;
  }

  private async fetchMarkets(): Promise<JsonRecord[]> {
    const baseUrl = config.clob.gammaUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/markets`);
    url.searchParams.set('limit', String(config.runtime.marketQueryLimit * 2));
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Gamma API returned ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        return payload.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
      }

      const record = asRecord(payload);
      const markets = Array.isArray(record?.markets) ? record.markets : [];
      return markets.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
    } catch (error: any) {
      logger.warn('Could not fetch markets from Gamma API', {
        message: error?.message || 'Unknown error',
      });
      return [];
    }
  }

  private normalizeMarketCandidate(record: JsonRecord): MarketCandidate | null {
    const acceptingOrders =
      parseBoolean(record.acceptingOrders, true) && !parseBoolean(record.closed, false);
    const active =
      parseBoolean(record.active, true) &&
      !parseBoolean(record.archived, false) &&
      !parseBoolean(record.closed, false) &&
      !parseBoolean(record.resolved, false);

    if (!active) {
      return null;
    }

    const marketId =
      asString(record.conditionId) ||
      asString(record.condition_id) ||
      asString(record.id) ||
      asString(record.market);
    if (!marketId) {
      return null;
    }

    const tokens = parseBinaryTokens(record);
    if (!tokens) {
      return null;
    }

    const title =
      asString(record.question) ||
      asString(record.title) ||
      asString(record.marketTitle) ||
      asString(record.slug) ||
      marketId;

    const startTime = normalizeTimestamp(
      record.startDate ?? record.start_date ?? record.startTime ?? record.start_time
    );
    const endTime = normalizeTimestamp(
      record.endDate ?? record.end_date ?? record.endTime ?? record.end_time
    );

    return {
      marketId,
      conditionId: marketId,
      title,
      slug: asString(record.slug) || undefined,
      liquidityUsd: safeNumber(record.liquidity),
      volumeUsd: safeNumber(record.volume),
      startTime,
      endTime,
      durationMinutes: computeDurationMinutes(startTime, endTime),
      yesTokenId: tokens.yesTokenId,
      noTokenId: tokens.noTokenId,
      yesLabel: tokens.yesLabel,
      noLabel: tokens.noLabel,
      yesOutcomeIndex: 0,
      noOutcomeIndex: 1,
      acceptingOrders,
    };
  }

  private passesFiveMinuteFilter(candidate: MarketCandidate): boolean {
    if (!config.runtime.onlyFiveMinuteMarkets) {
      return true;
    }

    if (candidate.durationMinutes !== null) {
      return candidate.durationMinutes <= 5.5;
    }

    return /\b5\s*(?:min|minute|minutes|m)\b/i.test(candidate.title);
  }

  private passesWhitelist(candidate: MarketCandidate): boolean {
    if (config.WHITELIST_CONDITION_IDS.length === 0) {
      return true;
    }

    const allowed = new Set(
      config.WHITELIST_CONDITION_IDS.map((conditionId) => conditionId.toLowerCase())
    );
    return allowed.has(candidate.conditionId.toLowerCase());
  }

  private emitSlotEndedEvents(candidates: MarketCandidate[]): void {
    const activeKeys = new Set<string>();

    for (const candidate of candidates) {
      const slotKey = getSlotKey(candidate);
      activeKeys.add(slotKey);
      this.seenSlots.set(slotKey, candidate);

      if (this.isSlotEndingSoon(candidate) && !this.reportedSlots.has(slotKey)) {
        this.reportedSlots.add(slotKey);
        this.emit('slot-ended', candidate);
      }
    }

    for (const [slotKey, market] of this.seenSlots.entries()) {
      if (activeKeys.has(slotKey)) {
        continue;
      }

      if (!this.reportedSlots.has(slotKey)) {
        this.reportedSlots.add(slotKey);
        this.emit('slot-ended', market);
      }

      this.seenSlots.delete(slotKey);
    }
  }

  private isSlotEndingSoon(candidate: MarketCandidate): boolean {
    if (!candidate.endTime) {
      return false;
    }

    const endMs = Date.parse(candidate.endTime);
    if (!Number.isFinite(endMs)) {
      return false;
    }

    return endMs - Date.now() <= config.strategy.exitBeforeEndMs;
  }
}

export function getSlotKey(
  candidate: Pick<MarketCandidate, 'marketId' | 'startTime' | 'endTime'>
): string {
  return `${candidate.marketId}:${candidate.startTime || 'unknown'}:${candidate.endTime || 'unknown'}`;
}

function parseBinaryTokens(record: JsonRecord): BinaryTokenSet | null {
  const tokenRecords = Array.isArray(record.tokens) ? record.tokens : [];
  const directTokens = tokenRecords
    .map((token, index) => normalizeToken(asRecord(token), index))
    .filter(
      (
        token
      ): token is { tokenId: string; label: string; normalized: 'YES' | 'NO' | 'UNKNOWN' } =>
        token !== null
    );

  if (directTokens.length >= 2) {
    const yesToken = directTokens.find((token) => token.normalized === 'YES') ?? directTokens[0];
    const noToken =
      directTokens.find((token) => token.normalized === 'NO' && token.tokenId !== yesToken.tokenId) ??
      directTokens.find((token) => token.tokenId !== yesToken.tokenId);

    if (yesToken && noToken) {
      return {
        yesTokenId: yesToken.tokenId,
        noTokenId: noToken.tokenId,
        yesLabel: yesToken.label,
        noLabel: noToken.label,
      };
    }
  }

  const tokenIds = parseStringArray(record.clobTokenIds ?? record.tokenIds);
  const outcomes = parseStringArray(record.outcomes);
  if (tokenIds.length >= 2) {
    const yesIndex = outcomes.findIndex((outcome) => normalizeOutcomeLabel(outcome) === 'YES');
    const resolvedYesIndex = yesIndex >= 0 ? yesIndex : 0;
    const resolvedNoIndex = resolvedYesIndex === 0 ? 1 : 0;

    if (tokenIds[resolvedYesIndex] && tokenIds[resolvedNoIndex]) {
      return {
        yesTokenId: tokenIds[resolvedYesIndex],
        noTokenId: tokenIds[resolvedNoIndex],
        yesLabel: outcomes[resolvedYesIndex] || 'YES',
        noLabel: outcomes[resolvedNoIndex] || 'NO',
      };
    }
  }

  return null;
}

function normalizeToken(
  token: JsonRecord | null,
  index: number
): { tokenId: string; label: string; normalized: 'YES' | 'NO' | 'UNKNOWN' } | null {
  if (!token) {
    return null;
  }

  const tokenId =
    asString(token.token_id) ||
    asString(token.tokenId) ||
    asString(token.asset_id) ||
    asString(token.assetId) ||
    asString(token.id);
  if (!tokenId) {
    return null;
  }

  const label =
    asString(token.outcome) ||
    asString(token.label) ||
    asString(token.name) ||
    (index === 0 ? 'YES' : 'NO');

  return {
    tokenId,
    label,
    normalized: normalizeOutcomeLabel(label),
  };
}

function normalizeOutcomeLabel(value: unknown): 'YES' | 'NO' | 'UNKNOWN' {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'YES' || normalized === 'UP' || normalized === 'TRUE' || normalized === 'LONG') {
    return 'YES';
  }
  if (normalized === 'NO' || normalized === 'DOWN' || normalized === 'FALSE' || normalized === 'SHORT') {
    return 'NO';
  }
  return 'UNKNOWN';
}

function computeDurationMinutes(startTime: string | null, endTime: string | null): number | null {
  if (!startTime || !endTime) {
    return null;
  }

  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  return (endMs - startMs) / 60_000;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    } catch {
      return [];
    }
  }

  return [];
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return fallback;
}

function safeNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}
