import { EventEmitter } from 'node:events';
import {
  CircuitBreaker,
  type CircuitBreakerSnapshot,
  retryWithBackoff,
} from './api-retry.js';
import { config, type AppConfig, type TradeableCoin } from './config.js';
import { logger } from './logger.js';
import {
  asRecord,
  asString,
  normalizeTimestampString,
  parseBooleanLoose,
  parseStringArray,
  pruneMapEntries,
  pruneSetEntries,
  safeNumber,
  type JsonRecord,
} from './utils.js';

export interface MarketCandidate {
  marketId: string;
  conditionId: string;
  title: string;
  eventTitle?: string;
  slug?: string;
  seriesSlug?: string;
  recurrence?: string | null;
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

export interface GammaMarketSource {
  market: JsonRecord;
  event: JsonRecord | null;
}

export type MarketDiscoveryMode = 'TEST_WHITELIST' | 'WHITELIST_OVERRIDE' | 'DYNAMIC_SCAN';

export type CandidateRejectionReason =
  | 'normalization-failed'
  | 'below-liquidity'
  | 'not-accepting-orders'
  | 'outside-slot-window'
  | 'not-whitelisted'
  | 'coin-mismatch'
  | 'not-5-minute';

export interface MarketScanSummary {
  mode: MarketDiscoveryMode;
  pagesFetched: number;
  fetchedEventCount: number;
  flattenedMarketCount: number;
  normalizedCandidateCount: number;
  coinMatchedCount: number;
  fiveMinuteMatchedCount: number;
  finalEligibleCount: number;
  rejectionCounts: Partial<Record<CandidateRejectionReason, number>>;
  rejectionSamples: Partial<Record<CandidateRejectionReason, string>>;
}

interface BinaryTokenSet {
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
}

interface CandidateFilterResult {
  eligible: MarketCandidate[];
  summary: Omit<
    MarketScanSummary,
    'pagesFetched' | 'fetchedEventCount' | 'flattenedMarketCount' | 'finalEligibleCount'
  >;
}

interface GammaEventFetchResult {
  events: JsonRecord[];
  marketSources: GammaMarketSource[];
  pagesFetched: number;
}

type FetchLike = typeof fetch;

const MAX_TRACKED_SLOTS = 2_048;
const GAMMA_CRYPTO_TAG_ID = '21';
const GAMMA_EVENT_PAGE_LIMIT = 200;
const MAX_GAMMA_EVENT_PAGES = 6;
const MARKET_DISCOVERY_BUFFER_MULTIPLIER = 6;
const STALE_SLOT_GRACE_MS = 60_000;
const GAMMA_REQUEST_TIMEOUT_MS = 8_000;
let preferredGammaOrderField: 'endDate' | 'end_date' | null | undefined;
const CLOCK_RANGE_PATTERN =
  /\b\d{1,2}:\d{2}\s?(?:AM|PM)\s*-\s*\d{1,2}:\d{2}\s?(?:AM|PM)\b/i;
const UP_OR_DOWN_PATTERN = /\bup\s+or\s+down\b/i;
const FIVE_MINUTE_SLUG_PATTERN = /\b(?:up-or-down|up-down|5m|5-min|5min|five-minute)\b/i;
const COIN_PATTERNS: Record<TradeableCoin, RegExp> = {
  BTC: /(^|[^A-Z0-9])(BTC|BITCOIN)(?=$|[^A-Z0-9])/i,
  ETH: /(^|[^A-Z0-9])(ETH|ETHEREUM)(?=$|[^A-Z0-9])/i,
  SOL: /(^|[^A-Z0-9])(SOL|SOLANA)(?=$|[^A-Z0-9])/i,
  XRP: /(^|[^A-Z0-9])(XRP)(?=$|[^A-Z0-9])/i,
};

export class MarketMonitor extends EventEmitter {
  private readonly seenSlots = new Map<string, MarketCandidate>();
  private readonly reportedSlots = new Set<string>();
  private readonly gammaCircuitBreaker = new CircuitBreaker({
    name: 'gamma',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
  });

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    super();
  }

  async scanEligibleMarkets(): Promise<MarketCandidate[]> {
    const discoveryMode = describeDiscoveryMode(this.runtimeConfig);
    let fetched: GammaEventFetchResult;
    try {
      fetched = await fetchPaginatedGammaEventMarkets({
        gammaUrl: this.runtimeConfig.clob.gammaUrl,
        marketQueryLimit: this.runtimeConfig.runtime.marketQueryLimit,
        fetchImpl: this.fetchImpl,
        breaker: this.gammaCircuitBreaker,
      });
    } catch (error: any) {
      logger.warn('Could not fetch active Gamma events for market discovery', {
        mode: discoveryMode.mode,
        message: error?.message || 'Unknown error',
      });
      return [];
    }

    const normalizedCandidates: MarketCandidate[] = [];
    const normalizationRejections = createRejectionStore();

    for (const source of fetched.marketSources) {
      const candidate = normalizeGammaMarketSource(source);
      if (!candidate) {
        recordRejection(
          normalizationRejections,
          'normalization-failed',
          formatRawSourceForLog(source)
        );
        continue;
      }

      normalizedCandidates.push(candidate);
    }

    const selection = selectEligibleMarkets(normalizedCandidates, this.runtimeConfig);
    mergeRejections(selection.summary.rejectionCounts, normalizationRejections.counts);
    mergeSamples(selection.summary.rejectionSamples, normalizationRejections.samples);

    const eligible = selection.eligible
      .sort((left, right) => {
        const leftEnd = left.endTime ? Date.parse(left.endTime) : Number.MAX_SAFE_INTEGER;
        const rightEnd = right.endTime ? Date.parse(right.endTime) : Number.MAX_SAFE_INTEGER;
        if (leftEnd !== rightEnd) {
          return leftEnd - rightEnd;
        }
        return right.liquidityUsd - left.liquidityUsd;
      })
      .slice(
        0,
        this.runtimeConfig.PRODUCT_TEST_MODE
          ? this.runtimeConfig.TEST_MAX_SLOTS
          : this.runtimeConfig.runtime.marketQueryLimit
      );

    this.emitSlotEndedEvents(eligible);

    const summary: MarketScanSummary = {
      ...selection.summary,
      pagesFetched: fetched.pagesFetched,
      fetchedEventCount: fetched.events.length,
      flattenedMarketCount: fetched.marketSources.length,
      normalizedCandidateCount: normalizedCandidates.length,
      finalEligibleCount: eligible.length,
    };

    const scanLabel =
      discoveryMode.mode === 'DYNAMIC_SCAN'
        ? this.runtimeConfig.FILTER_5MIN_ONLY
          ? 'Active 5-minute crypto markets found'
          : 'Active crypto markets found'
        : 'Active whitelist markets found';

    console.log(`${scanLabel}: ${eligible.length}`);
    for (const market of eligible) {
      console.log(
        `   ${market.title} | ID: ${market.conditionId} | Liq: $${market.liquidityUsd.toFixed(2)}`
      );
    }

    if (this.runtimeConfig.PRODUCT_TEST_MODE && eligible[0]) {
      logger.debug('PRODUCT_TEST_MODE pinned a single active slot', {
        conditionId: eligible[0].conditionId,
        title: eligible[0].title,
        testMaxSlots: this.runtimeConfig.TEST_MAX_SLOTS,
        testMinTradeUsdc: this.runtimeConfig.TEST_MIN_TRADE_USDC,
      });
    }

    logger.debug('Gamma market scan stage counts', {
      mode: summary.mode,
      description: discoveryMode.description,
      pagesFetched: summary.pagesFetched,
      fetchedEventCount: summary.fetchedEventCount,
      flattenedMarketCount: summary.flattenedMarketCount,
      normalizedCandidateCount: summary.normalizedCandidateCount,
      coinMatchedCount: summary.coinMatchedCount,
      fiveMinuteMatchedCount: summary.fiveMinuteMatchedCount,
      finalEligibleCount: summary.finalEligibleCount,
      whitelistSize: this.runtimeConfig.WHITELIST_CONDITION_IDS.length,
      coinsToTrade: this.runtimeConfig.COINS_TO_TRADE,
      filterFiveMinuteOnly: this.runtimeConfig.FILTER_5MIN_ONLY,
      minLiquidityUsd: this.runtimeConfig.MIN_LIQUIDITY_USD,
      rejectionCounts: summary.rejectionCounts,
    });

    if (Object.keys(summary.rejectionSamples).length > 0) {
      logger.debug('Gamma market scan rejection samples', summary.rejectionSamples);
    }

    return eligible;
  }

  getGammaCircuitBreakerSnapshot(): CircuitBreakerSnapshot {
    return this.gammaCircuitBreaker.getSnapshot();
  }

  private emitSlotEndedEvents(candidates: MarketCandidate[]): void {
    const activeKeys = new Set<string>();

    for (const candidate of candidates) {
      const slotKey = getSlotKey(candidate);
      activeKeys.add(slotKey);
      this.seenSlots.delete(slotKey);
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

    pruneMapEntries(this.seenSlots, MAX_TRACKED_SLOTS);
    pruneSetEntries(this.reportedSlots, MAX_TRACKED_SLOTS);
  }

  private isSlotEndingSoon(candidate: MarketCandidate): boolean {
    if (!candidate.endTime) {
      return false;
    }

    const endMs = Date.parse(candidate.endTime);
    if (!Number.isFinite(endMs)) {
      return false;
    }

    return endMs - Date.now() <= this.runtimeConfig.strategy.exitBeforeEndMs;
  }
}

export async function fetchPaginatedGammaEventMarkets(params: {
  gammaUrl: string;
  marketQueryLimit: number;
  fetchImpl?: FetchLike;
  breaker?: CircuitBreaker;
}): Promise<GammaEventFetchResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const targetMarketCount = Math.max(
    params.marketQueryLimit * MARKET_DISCOVERY_BUFFER_MULTIPLIER,
    GAMMA_EVENT_PAGE_LIMIT
  );
  const events: JsonRecord[] = [];
  const marketSources: GammaMarketSource[] = [];
  const seenConditionIds = new Set<string>();
  let pagesFetched = 0;

  for (
    let pageIndex = 0;
    pageIndex < MAX_GAMMA_EVENT_PAGES && marketSources.length < targetMarketCount;
    pageIndex += 1
  ) {
    const offset = pageIndex * GAMMA_EVENT_PAGE_LIMIT;
    const page = await fetchGammaEventsPage({
      gammaUrl: params.gammaUrl,
      limit: GAMMA_EVENT_PAGE_LIMIT,
      offset,
      fetchImpl,
      breaker: params.breaker,
    });

    if (page.length === 0) {
      break;
    }

    pagesFetched += 1;
    events.push(...page);

    for (const source of flattenGammaEventMarkets(page)) {
      const conditionId = extractConditionId(source.market);
      const dedupeKey = conditionId || extractMarketId(source.market);
      if (!dedupeKey) {
        continue;
      }

      const normalizedKey = dedupeKey.toLowerCase();
      if (seenConditionIds.has(normalizedKey)) {
        continue;
      }

      seenConditionIds.add(normalizedKey);
      marketSources.push(source);
    }

    if (page.length < GAMMA_EVENT_PAGE_LIMIT) {
      break;
    }
  }

  return {
    events,
    marketSources,
    pagesFetched,
  };
}

export async function fetchGammaEventsPage(params: {
  gammaUrl: string;
  limit: number;
  offset: number;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  breaker?: CircuitBreaker;
}): Promise<JsonRecord[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestTimeoutMs = params.requestTimeoutMs ?? GAMMA_REQUEST_TIMEOUT_MS;
  const orderCandidates = buildOrderCandidates(preferredGammaOrderField);
  let lastError: Error | null = null;

  for (const orderField of orderCandidates) {
    const url = new URL(`${params.gammaUrl.replace(/\/+$/, '')}/events`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('tag_id', GAMMA_CRYPTO_TAG_ID);
    url.searchParams.set('related_tags', 'true');
    url.searchParams.set('limit', String(params.limit));
    url.searchParams.set('offset', String(params.offset));

    if (orderField) {
      url.searchParams.set('order', orderField);
      url.searchParams.set('ascending', 'true');
    }

    try {
      const payload = await retryWithBackoff(
        async () => {
          const response = await fetchWithTimeout(
            fetchImpl,
            url,
            {
              method: 'GET',
              headers: {
                accept: 'application/json',
              },
            },
            requestTimeoutMs
          );

          if (!response.ok) {
            const errorText = await safeReadResponseText(response);
            const error = new Error(
              `Gamma events API returned ${response.status}${errorText ? `: ${errorText}` : ''}`
            ) as Error & { status?: number };
            error.status = response.status;
            throw error;
          }

          return (await response.json()) as unknown;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
          breaker: params.breaker,
          respectOpenState: false,
        }
      );

      preferredGammaOrderField = orderField;
      if (Array.isArray(payload)) {
        return payload.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
      }

      const record = asRecord(payload);
      const events = Array.isArray(record?.events) ? record.events : [];
      return events.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error && typeof error === 'object' && 'status' in error
          ? Number((error as { status?: number }).status)
          : Number.NaN;
      const isOrderValidationError =
        status === 400 &&
        /order fields are not valid/i.test(message);

      if (isOrderValidationError && orderField) {
        if (preferredGammaOrderField === orderField) {
          preferredGammaOrderField = undefined;
        }
        lastError = new Error(
          `Gamma events API rejected order field "${orderField}": ${message}`
        );
        continue;
      }

      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Gamma API request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeoutId.unref?.();

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Gamma API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildOrderCandidates(
  preferred: 'endDate' | 'end_date' | null | undefined
): ReadonlyArray<'endDate' | 'end_date' | null> {
  const defaults = ['endDate', 'end_date', null] as const;
  if (preferred === undefined) {
    return defaults;
  }

  return [preferred, ...defaults.filter((candidate) => candidate !== preferred)];
}

export function flattenGammaEventMarkets(events: readonly JsonRecord[]): GammaMarketSource[] {
  const flattened: GammaMarketSource[] = [];

  for (const event of events) {
    const markets = Array.isArray(event.markets) ? event.markets : [];
    for (const market of markets) {
      const normalizedMarket = asRecord(market);
      if (!normalizedMarket) {
        continue;
      }

      flattened.push({
        market: normalizedMarket,
        event,
      });
    }
  }

  return flattened;
}

export function normalizeGammaMarketSource(source: GammaMarketSource): MarketCandidate | null {
  const record = source.market;
  const event = source.event;
  const active =
    parseBooleanLoose(record.active ?? event?.active, true) &&
    !parseBooleanLoose(record.archived ?? event?.archived, false) &&
    !parseBooleanLoose(record.closed ?? event?.closed, false) &&
    !parseBooleanLoose(record.resolved, false);

  if (!active) {
    return null;
  }

  const conditionId = extractConditionId(record);
  if (!conditionId) {
    return null;
  }

  const tokens = parseBinaryTokens(record);
  if (!tokens) {
    return null;
  }

  const title =
    asString(record.question) ||
    asString(record.title) ||
    asString(event?.title) ||
    asString(event?.question) ||
    asString(record.slug) ||
    conditionId;
  const eventTitle = asString(event?.title) || asString(record.title) || undefined;
  const slug = asString(record.slug) || asString(event?.slug) || undefined;
  const series = getPrimarySeries(event, record);
  const seriesSlug =
    asString(record.seriesSlug) ||
    asString(event?.seriesSlug) ||
    asString(series?.slug) ||
    undefined;
  const recurrence = asString(series?.recurrence) || null;
  const startTime = normalizeTimestamp(
    record.eventStartTime ??
      record.event_start_time ??
      event?.startTime ??
      event?.eventStartTime ??
      record.startTime ??
      record.start_time ??
      record.gameStartTime ??
      record.game_start_time ??
      record.startDate ??
      record.start_date ??
      event?.startDate ??
      event?.start_date
  );
  const endTime = normalizeTimestamp(
    record.endDate ??
      record.end_date ??
      record.endTime ??
      record.end_time ??
      event?.endDate ??
      event?.end_date
  );
  const liquidityUsd = pickFiniteNumber(
    record.liquidityClob,
    record.liquidityNum,
    record.liquidity,
    event?.liquidityClob,
    event?.liquidity
  );
  const volumeUsd = pickFiniteNumber(
    record.volumeClob,
    record.volumeNum,
    record.volume,
    event?.volumeClob,
    event?.volume
  );
  const acceptingOrders =
    parseBooleanLoose(
      record.acceptingOrders ??
        record.enableOrderBook ??
        event?.acceptingOrders ??
        event?.enableOrderBook,
      true
    ) &&
    !parseBooleanLoose(record.closed ?? event?.closed, false);

  return {
    marketId: conditionId,
    conditionId,
    title,
    eventTitle,
    slug,
    seriesSlug,
    recurrence,
    liquidityUsd,
    volumeUsd,
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

export function selectEligibleMarkets(
  candidates: readonly MarketCandidate[],
  runtimeConfig: Pick<
    AppConfig,
    'TEST_MODE' | 'FILTER_5MIN_ONLY' | 'MIN_LIQUIDITY_USD' | 'WHITELIST_CONDITION_IDS' | 'COINS_TO_TRADE'
  >
): CandidateFilterResult {
  const whitelist = new Set(
    runtimeConfig.WHITELIST_CONDITION_IDS.map((conditionId) => conditionId.toLowerCase())
  );
  const mode = resolveDiscoveryMode(runtimeConfig);
  const rejectionStore = createRejectionStore();
  const eligible: MarketCandidate[] = [];
  let coinMatchedCount = 0;
  let fiveMinuteMatchedCount = 0;

  for (const candidate of candidates) {
    if (isExpiredSlotCandidate(candidate)) {
      recordRejection(rejectionStore, 'outside-slot-window', formatCandidateForLog(candidate));
      continue;
    }

    if (candidate.liquidityUsd < runtimeConfig.MIN_LIQUIDITY_USD) {
      recordRejection(rejectionStore, 'below-liquidity', formatCandidateForLog(candidate));
      continue;
    }

    if (!candidate.acceptingOrders) {
      recordRejection(rejectionStore, 'not-accepting-orders', formatCandidateForLog(candidate));
      continue;
    }

    if (mode !== 'DYNAMIC_SCAN') {
      if (!whitelist.has(candidate.conditionId.toLowerCase())) {
        recordRejection(rejectionStore, 'not-whitelisted', formatCandidateForLog(candidate));
        continue;
      }

      eligible.push(candidate);
      continue;
    }

    if (!matchesTradeableCoin(candidate, runtimeConfig.COINS_TO_TRADE)) {
      recordRejection(rejectionStore, 'coin-mismatch', formatCandidateForLog(candidate));
      continue;
    }

    coinMatchedCount += 1;

    if (runtimeConfig.FILTER_5MIN_ONLY && !isLikelyFiveMinuteMarket(candidate)) {
      recordRejection(rejectionStore, 'not-5-minute', formatCandidateForLog(candidate));
      continue;
    }

    if (runtimeConfig.FILTER_5MIN_ONLY) {
      fiveMinuteMatchedCount += 1;
    }

    eligible.push(candidate);
  }

  return {
    eligible,
    summary: {
      mode,
      normalizedCandidateCount: candidates.length,
      coinMatchedCount,
      fiveMinuteMatchedCount: runtimeConfig.FILTER_5MIN_ONLY ? fiveMinuteMatchedCount : coinMatchedCount,
      rejectionCounts: rejectionStore.counts,
      rejectionSamples: rejectionStore.samples,
    },
  };
}

export function describeDiscoveryMode(
  runtimeConfig: Pick<
    AppConfig,
    'TEST_MODE' | 'FILTER_5MIN_ONLY' | 'WHITELIST_CONDITION_IDS' | 'COINS_TO_TRADE'
  >
): { mode: MarketDiscoveryMode; description: string } {
  const mode = resolveDiscoveryMode(runtimeConfig);

  if (mode === 'TEST_WHITELIST') {
    return {
      mode,
      description: 'TEST_MODE whitelist-only market selection',
    };
  }

  if (mode === 'WHITELIST_OVERRIDE') {
    return {
      mode,
      description: 'manual whitelist override market selection',
    };
  }

  return {
    mode,
    description: runtimeConfig.FILTER_5MIN_ONLY
      ? `dynamic ${runtimeConfig.COINS_TO_TRADE.join('/')} 5-minute crypto discovery`
      : `dynamic ${runtimeConfig.COINS_TO_TRADE.join('/')} crypto discovery`,
  };
}

export function matchesTradeableCoin(
  candidate: Pick<MarketCandidate, 'title' | 'eventTitle' | 'slug' | 'seriesSlug'>,
  coinsToTrade: readonly TradeableCoin[]
): boolean {
  const haystack = [candidate.title, candidate.eventTitle, candidate.slug, candidate.seriesSlug]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ');

  return coinsToTrade.some((coin) => COIN_PATTERNS[coin].test(haystack));
}

export function isLikelyFiveMinuteMarket(
  candidate: Pick<
    MarketCandidate,
    'title' | 'eventTitle' | 'slug' | 'seriesSlug' | 'recurrence' | 'durationMinutes'
  >
): boolean {
  const durationMinutes = candidate.durationMinutes;
  if (durationMinutes !== null && durationMinutes > 0 && durationMinutes <= 5.5) {
    return true;
  }

  if (durationMinutes !== null && durationMinutes > 5.5) {
    return false;
  }

  const normalizedRecurrence = String(candidate.recurrence || '')
    .trim()
    .toLowerCase();
  if (
    normalizedRecurrence === '5m' ||
    normalizedRecurrence === '5min' ||
    normalizedRecurrence === '5-min' ||
    normalizedRecurrence === 'five-minute'
  ) {
    return true;
  }

  const titleText = [candidate.title, candidate.eventTitle].filter(Boolean).join(' ');
  const hasUpOrDown = UP_OR_DOWN_PATTERN.test(titleText);
  const hasClockRange = CLOCK_RANGE_PATTERN.test(titleText);
  const hasSlugHint = FIVE_MINUTE_SLUG_PATTERN.test(
    [candidate.slug, candidate.seriesSlug].filter(Boolean).join(' ')
  );

  return hasUpOrDown && (hasClockRange || hasSlugHint);
}

export function getSlotKey(
  candidate: Pick<MarketCandidate, 'marketId' | 'startTime' | 'endTime'>
): string {
  return `${candidate.marketId}:${candidate.startTime || 'unknown'}:${candidate.endTime || 'unknown'}`;
}

function resolveDiscoveryMode(
  runtimeConfig: Pick<
    AppConfig,
    'TEST_MODE' | 'WHITELIST_CONDITION_IDS'
  >
): MarketDiscoveryMode {
  if (runtimeConfig.TEST_MODE) {
    return 'TEST_WHITELIST';
  }

  if (runtimeConfig.WHITELIST_CONDITION_IDS.length > 0) {
    return 'WHITELIST_OVERRIDE';
  }

  return 'DYNAMIC_SCAN';
}

function createRejectionStore(): {
  counts: Partial<Record<CandidateRejectionReason, number>>;
  samples: Partial<Record<CandidateRejectionReason, string>>;
} {
  return {
    counts: {},
    samples: {},
  };
}

function recordRejection(
  store: ReturnType<typeof createRejectionStore>,
  reason: CandidateRejectionReason,
  sample: string
): void {
  store.counts[reason] = (store.counts[reason] ?? 0) + 1;
  if (!store.samples[reason]) {
    store.samples[reason] = sample;
  }
}

function mergeRejections(
  target: Partial<Record<CandidateRejectionReason, number>>,
  source: Partial<Record<CandidateRejectionReason, number>>
): void {
  for (const [reason, count] of Object.entries(source)) {
    const key = reason as CandidateRejectionReason;
    target[key] = (target[key] ?? 0) + (count ?? 0);
  }
}

function mergeSamples(
  target: Partial<Record<CandidateRejectionReason, string>>,
  source: Partial<Record<CandidateRejectionReason, string>>
): void {
  for (const [reason, sample] of Object.entries(source)) {
    const key = reason as CandidateRejectionReason;
    if (!target[key] && sample) {
      target[key] = sample;
    }
  }
}

function extractConditionId(record: JsonRecord): string {
  return (
    asString(record.conditionId) ||
    asString(record.condition_id) ||
    asString(record.market)
  );
}

function extractMarketId(record: JsonRecord): string {
  return (
    asString(record.id) ||
    asString(record.marketId) ||
    extractConditionId(record)
  );
}

function parseBinaryTokens(record: JsonRecord): BinaryTokenSet | null {
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

  const tokenRecords = Array.isArray(record.tokens) ? record.tokens : [];
  const directTokens = tokenRecords
    .map((token, index) => normalizeToken(asRecord(token), index))
    .filter(
      (
        token
      ): token is { tokenId: string; label: string; normalized: 'YES' | 'NO' | 'UNKNOWN' } =>
        token !== null
    );

  if (directTokens.length < 2) {
    return null;
  }

  const yesToken = directTokens.find((token) => token.normalized === 'YES') ?? directTokens[0];
  const noToken =
    directTokens.find((token) => token.normalized === 'NO' && token.tokenId !== yesToken.tokenId) ??
    directTokens.find((token) => token.tokenId !== yesToken.tokenId);

  if (!yesToken || !noToken) {
    return null;
  }

  return {
    yesTokenId: yesToken.tokenId,
    noTokenId: noToken.tokenId,
    yesLabel: yesToken.label,
    noLabel: noToken.label,
  };
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

function pickFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    const next = safeNumber(value, Number.NaN);
    if (Number.isFinite(next) && next >= 0) {
      return next;
    }
  }

  return 0;
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
  return normalizeTimestampString(value);
}

function getPrimarySeries(event: JsonRecord | null, record: JsonRecord): JsonRecord | null {
  const eventSeries = Array.isArray(event?.series) ? event.series : [];
  const recordSeries = Array.isArray(record.series) ? record.series : [];
  return (
    eventSeries.map(asRecord).find((entry): entry is JsonRecord => entry !== null) ??
    recordSeries.map(asRecord).find((entry): entry is JsonRecord => entry !== null) ??
    null
  );
}

function isExpiredSlotCandidate(
  candidate: Pick<MarketCandidate, 'endTime'>,
  nowMs = Date.now()
): boolean {
  if (!candidate.endTime) {
    return false;
  }

  const endMs = Date.parse(candidate.endTime);
  if (!Number.isFinite(endMs)) {
    return false;
  }

  return endMs < nowMs - STALE_SLOT_GRACE_MS;
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function formatCandidateForLog(candidate: MarketCandidate): string {
  return [
    candidate.title,
    candidate.slug ? `slug=${candidate.slug}` : '',
    candidate.seriesSlug ? `series=${candidate.seriesSlug}` : '',
    `conditionId=${candidate.conditionId}`,
    `liq=${candidate.liquidityUsd.toFixed(2)}`,
    candidate.durationMinutes !== null ? `duration=${candidate.durationMinutes.toFixed(2)}m` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatRawSourceForLog(source: GammaMarketSource): string {
  const title =
    asString(source.market.question) ||
    asString(source.market.title) ||
    asString(source.event?.title) ||
    asString(source.market.slug) ||
    'unknown-market';
  const conditionId = extractConditionId(source.market) || 'missing-condition-id';
  return `${title} | conditionId=${conditionId}`;
}
