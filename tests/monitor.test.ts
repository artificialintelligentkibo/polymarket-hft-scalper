import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import {
  fetchGammaEventsPage,
  fetchPaginatedGammaEventMarkets,
  flattenGammaEventMarkets,
  isLikelyFiveMinuteMarket,
  MarketMonitor,
  matchesTradeableCoin,
  normalizeGammaMarketSource,
  selectEligibleMarkets,
  type MarketCandidate,
} from '../src/monitor.js';
import type { JsonRecord } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, relativePath), 'utf8')) as T;
}

function cloneCandidate(candidate: MarketCandidate, overrides: Partial<MarketCandidate>): MarketCandidate {
  return {
    ...candidate,
    ...overrides,
  };
}

function createEvent(index: number): JsonRecord {
  const conditionSuffix = index.toString(16).padStart(64, '0');
  return {
    id: `event-${index}`,
    title: `Bitcoin Up or Down - Nov 21, 10:${String(index % 60).padStart(2, '0')}AM-10:${String(
      (index + 5) % 60
    ).padStart(2, '0')}AM ET`,
    slug: `bitcoin-up-or-down-${index}`,
    startTime: '2030-11-21T15:10:00Z',
    endDate: '2030-11-21T15:15:00Z',
    seriesSlug: 'btc-up-or-down-5m',
    series: [
      {
        id: `series-${index}`,
        slug: 'btc-up-or-down-5m',
        recurrence: '5m',
        liquidity: 4236572.0073,
      },
    ],
    active: true,
    closed: false,
    markets: [
      {
        id: `market-${index}`,
        question: `Bitcoin Up or Down - sample ${index}?`,
        conditionId: `0x${conditionSuffix}`,
        slug: `bitcoin-up-or-down-${index}`,
        startDate: '2030-11-20T15:08:22Z',
        eventStartTime: '2030-11-21T15:10:00Z',
        endDate: '2030-11-21T15:15:00Z',
        outcomes: '["Up","Down"]',
        clobTokenIds: `["${1000 + index}","${2000 + index}"]`,
        liquidity: '1500',
        volume: '2500',
        active: true,
        closed: false,
        acceptingOrders: true,
      },
    ],
  } satisfies JsonRecord;
}

test('normalizeGammaMarketSource parses current Gamma payloads that expose clobTokenIds', () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  const flattened = flattenGammaEventMarkets(fixture);

  assert.equal(flattened.length, 1);

  const normalized = normalizeGammaMarketSource(flattened[0]);
  assert.ok(normalized);
  assert.equal(
    normalized?.conditionId,
    '0x1111111111111111111111111111111111111111111111111111111111111111'
  );
  assert.equal(
    normalized?.yesTokenId,
    '1029384756102938475610293847561029384756102938475610293847561029384756'
  );
  assert.equal(
    normalized?.noTokenId,
    '5647382910564738291056473829105647382910564738291056473829105647382910'
  );
  assert.equal(normalized?.yesLabel, 'Up');
  assert.equal(normalized?.noLabel, 'Down');
  assert.equal(normalized?.startTime, '2030-11-21T15:10:00.000Z');
  assert.equal(normalized?.durationMinutes, 5);
  assert.equal(normalized?.seriesSlug, 'btc-up-or-down-5m');
  assert.equal(normalized?.recurrence, '5m');
});

test('matchesTradeableCoin uses strict regex matching for symbols and full names', () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  const normalized = normalizeGammaMarketSource(flattenGammaEventMarkets(fixture)[0]);
  assert.ok(normalized);

  assert.equal(matchesTradeableCoin(normalized!, ['BTC', 'ETH'] as const), true);
  assert.equal(
    matchesTradeableCoin(
      {
        title: 'MegaETH governance token target this week?',
        eventTitle: 'MegaETH ecosystem market',
        slug: 'megaeth-governance-target',
        seriesSlug: undefined,
      },
      ['ETH'] as const
    ),
    false
  );
  assert.equal(
    matchesTradeableCoin(
      {
        title: 'Ethereum Up or Down - Mar 18, 11:10AM-11:15AM ET',
        eventTitle: undefined,
        slug: 'ethereum-up-or-down',
        seriesSlug: 'eth-up-or-down-5m',
      },
      ['ETH'] as const
    ),
    true
  );
});

test('isLikelyFiveMinuteMarket prefers parsed duration but falls back to resilient title hints', () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  const normalized = normalizeGammaMarketSource(flattenGammaEventMarkets(fixture)[0]);
  assert.ok(normalized);

  assert.equal(isLikelyFiveMinuteMarket(normalized!), true);
  assert.equal(
    isLikelyFiveMinuteMarket({
      title: 'Solana Up or Down - 11:10AM-11:15AM ET',
      eventTitle: 'Solana Up or Down',
      slug: 'solana-up-or-down-1110am-et',
      seriesSlug: 'sol-up-or-down-5m',
      recurrence: null,
      durationMinutes: null,
    }),
    true
  );
  assert.equal(
    isLikelyFiveMinuteMarket({
      title: 'Bitcoin Up or Down - hourly',
      eventTitle: 'Bitcoin Up or Down',
      slug: 'bitcoin-up-or-down-hourly',
      seriesSlug: 'btc-up-or-down-1h',
      recurrence: '1h',
      durationMinutes: 60,
    }),
    false
  );
});

test('selectEligibleMarkets preserves whitelist-only TEST_MODE and dynamic discovery behavior', () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  const baseCandidate = normalizeGammaMarketSource(flattenGammaEventMarkets(fixture)[0]);
  assert.ok(baseCandidate);

  const longEthCandidate = cloneCandidate(baseCandidate!, {
    conditionId: '0x2222222222222222222222222222222222222222222222222222222222222222',
    marketId: '0x2222222222222222222222222222222222222222222222222222222222222222',
    title: 'Ethereum price above $4000 by Friday?',
    eventTitle: 'Ethereum weekly market',
    slug: 'ethereum-price-above-4000-friday',
    durationMinutes: 60,
  });

  const testModeConfig = createConfig({
    ...process.env,
    TEST_MODE: 'true',
    FILTER_5MIN_ONLY: 'true',
    WHITELIST_CONDITION_IDS: baseCandidate!.conditionId,
    COINS_TO_TRADE: 'BTC,ETH,SOL,XRP',
    MIN_LIQUIDITY_USD: '500',
  });
  const testModeSelection = selectEligibleMarkets(
    [baseCandidate!, longEthCandidate],
    testModeConfig
  );
  assert.deepEqual(
    testModeSelection.eligible.map((candidate) => candidate.conditionId),
    [baseCandidate!.conditionId]
  );

  const dynamicConfig = createConfig({
    ...process.env,
    TEST_MODE: 'false',
    FILTER_5MIN_ONLY: 'false',
    WHITELIST_CONDITION_IDS: '',
    COINS_TO_TRADE: 'BTC,ETH,SOL,XRP',
    MIN_LIQUIDITY_USD: '500',
  });
  const dynamicSelection = selectEligibleMarkets([baseCandidate!, longEthCandidate], dynamicConfig);
  assert.deepEqual(
    dynamicSelection.eligible.map((candidate) => candidate.conditionId).sort(),
    [baseCandidate!.conditionId, longEthCandidate.conditionId].sort()
  );
});

test('selectEligibleMarkets drops stale slots even when Gamma still marks them active', () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  const baseCandidate = normalizeGammaMarketSource(flattenGammaEventMarkets(fixture)[0]);
  assert.ok(baseCandidate);

  const staleCandidate = cloneCandidate(baseCandidate!, {
    startTime: '2020-01-01T00:00:00.000Z',
    endTime: '2020-01-01T00:05:00.000Z',
    durationMinutes: 5,
  });

  const selection = selectEligibleMarkets(
    [staleCandidate],
    createConfig({
      ...process.env,
      TEST_MODE: 'false',
      FILTER_5MIN_ONLY: 'true',
      WHITELIST_CONDITION_IDS: '',
      COINS_TO_TRADE: 'BTC,ETH,SOL,XRP',
      MIN_LIQUIDITY_USD: '500',
    })
  );

  assert.equal(selection.eligible.length, 0);
  assert.equal(selection.summary.rejectionCounts['outside-slot-window'], 1);
});

test('fetchPaginatedGammaEventMarkets paginates with keyset cursors and flattens nested markets', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => createEvent(index));
  const secondPage = [createEvent(999)];
  const requestedUrls: URL[] = [];
  let callCount = 0;

  const fetchImpl: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === 'string'
          ? new URL(input)
          : new URL(input.url);
    requestedUrls.push(url);
    callCount += 1;

    // Keyset endpoint: return { events, next_cursor } wrapper
    if (url.pathname.includes('/events/keyset')) {
      const cursor = url.searchParams.get('after_cursor');
      const events = cursor ? secondPage : firstPage;
      const payload = {
        events,
        next_cursor: cursor ? null : 'cursor_page2',
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Fallback: legacy endpoint (shouldn't be hit in this test)
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await fetchPaginatedGammaEventMarkets({
    gammaUrl: 'https://gamma-api.polymarket.com',
    marketQueryLimit: 40,
    fetchImpl,
  });

  // Verify keyset endpoint used
  assert.ok(requestedUrls[0]?.pathname.includes('/events/keyset'));
  assert.equal(requestedUrls[0]?.searchParams.get('tag_id'), '21');
  assert.equal(requestedUrls[0]?.searchParams.get('related_tags'), 'true');
  // Second request should have cursor
  assert.equal(requestedUrls[1]?.searchParams.get('after_cursor'), 'cursor_page2');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.events.length, 201);
  assert.equal(result.marketSources.length, 201);
});

test('MarketMonitor caches eligible Gamma scans between fast loop iterations', async () => {
  const fixture = loadFixture<JsonRecord[]>('fixtures/gamma-crypto-5min-event-page.json');
  let fetchCount = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };
  const runtimeConfig = createConfig({
    ...process.env,
    TEST_MODE: 'false',
    FILTER_5MIN_ONLY: 'true',
    WHITELIST_CONDITION_IDS: '',
    COINS_TO_TRADE: 'BTC,ETH,SOL,XRP',
    MIN_LIQUIDITY_USD: '500',
    MARKET_QUERY_LIMIT: '10',
    MARKET_SCAN_CACHE_MS: '15000',
  });
  const monitor = new MarketMonitor(runtimeConfig, fetchImpl);
  const originalDateNow = Date.now;
  let nowMs = Date.parse('2030-11-21T15:11:00.000Z');
  Date.now = () => nowMs;

  try {
    const first = await monitor.scanEligibleMarkets();
    nowMs += 5_000;
    const second = await monitor.scanEligibleMarkets();
    nowMs += 20_000;
    const third = await monitor.scanEligibleMarkets();

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(third.length, 1);
    assert.equal(fetchCount, 2);
  } finally {
    Date.now = originalDateNow;
  }
});

test('fetchGammaEventsPage aborts hung Gamma requests with a timeout', async () => {
  const hangingFetch = ((_: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        'abort',
        () => {
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true }
      );
    })) as typeof fetch;

  await assert.rejects(
    () =>
      fetchGammaEventsPage({
        gammaUrl: 'https://gamma-api.polymarket.com',
        limit: 10,
        cursor: null,
        fetchImpl: hangingFetch,
        requestTimeoutMs: 5,
      }),
    /timed out/i
  );
});
