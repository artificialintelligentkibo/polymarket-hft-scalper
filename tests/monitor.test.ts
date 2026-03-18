import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import {
  fetchPaginatedGammaEventMarkets,
  flattenGammaEventMarkets,
  isLikelyFiveMinuteMarket,
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
    title: `Bitcoin Up or Down - Mar 18, 11:${String(index % 60).padStart(2, '0')}AM-11:${String(
      (index + 5) % 60
    ).padStart(2, '0')}AM ET`,
    slug: `bitcoin-up-or-down-${index}`,
    active: true,
    closed: false,
    markets: [
      {
        id: `market-${index}`,
        question: `Bitcoin Up or Down - sample ${index}?`,
        conditionId: `0x${conditionSuffix}`,
        slug: `bitcoin-up-or-down-${index}`,
        startDate: '2026-03-18T15:10:00Z',
        endDate: '2026-03-18T15:15:00Z',
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
  assert.equal(normalized?.durationMinutes, 5);
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
      durationMinutes: null,
    }),
    true
  );
  assert.equal(
    isLikelyFiveMinuteMarket({
      title: 'Bitcoin Up or Down - hourly',
      eventTitle: 'Bitcoin Up or Down',
      slug: 'bitcoin-up-or-down-hourly',
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

test('fetchPaginatedGammaEventMarkets paginates /events and flattens nested markets', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => createEvent(index));
  const secondPage = [createEvent(999)];
  const requestedOffsets: number[] = [];

  const fetchImpl: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === 'string'
          ? new URL(input)
          : new URL(input.url);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    requestedOffsets.push(offset);
    const payload = offset === 0 ? firstPage : secondPage;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };

  const result = await fetchPaginatedGammaEventMarkets({
    gammaUrl: 'https://gamma-api.polymarket.com',
    marketQueryLimit: 40,
    fetchImpl,
  });

  assert.deepEqual(requestedOffsets, [0, 200]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.events.length, 201);
  assert.equal(result.marketSources.length, 201);
});
