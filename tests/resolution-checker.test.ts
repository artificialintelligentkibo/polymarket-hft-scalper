import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ResolutionChecker,
  resolveVerifiedRedeemPayoutUsd,
} from '../src/resolution-checker.js';

function createMarketPayload(overrides: Record<string, unknown> = {}) {
  return [
    {
      conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      slug: 'bitcoin-updown-5m-1',
      outcomes: '["Up","Down"]',
      outcomePrices: '[1,0]',
      closed: true,
      ...overrides,
    },
  ];
}

test('resolution checker resolves YES winner from Gamma market outcome prices', async () => {
  let requestedUrl: URL | undefined;
  const checker = new ResolutionChecker({
    fetchImpl: async (input) => {
      requestedUrl =
        input instanceof URL
          ? input
          : typeof input === 'string'
            ? new URL(input)
            : new URL(input.url);

      return new Response(JSON.stringify(createMarketPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await checker.checkResolution({
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  });

  assert.ok(requestedUrl instanceof URL);
  assert.equal(requestedUrl.searchParams.get('condition_ids'), result.conditionId);
  assert.equal(result.resolved, true);
  assert.equal(result.winningOutcome, 'YES');
  assert.equal(result.yesFinalPrice, 1);
  assert.equal(result.noFinalPrice, 0);
});

test('resolution checker resolves NO winner from Gamma market outcome prices', async () => {
  const checker = new ResolutionChecker({
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          createMarketPayload({
            outcomePrices: '[0,1]',
          })
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      ),
  });

  const result = await checker.checkResolution({
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  });

  assert.equal(result.resolved, true);
  assert.equal(result.winningOutcome, 'NO');
  assert.equal(result.yesFinalPrice, 0);
  assert.equal(result.noFinalPrice, 1);
});

test('resolution checker falls back to unresolved when prices are ambiguous', async () => {
  const checker = new ResolutionChecker({
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          createMarketPayload({
            outcomePrices: '[0.52,0.48]',
            closed: false,
          })
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      ),
  });

  const result = await checker.checkResolution({
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  });

  assert.equal(result.resolved, false);
  assert.equal(result.winningOutcome, null);
  assert.equal(result.yesFinalPrice, 0.52);
  assert.equal(result.noFinalPrice, 0.48);
});

test('resolution checker handles API failures without crashing', async () => {
  const checker = new ResolutionChecker({
    fetchImpl: async () =>
      new Response('upstream unavailable', {
        status: 503,
      }),
  });

  const result = await checker.checkResolution({
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  });

  assert.equal(result.resolved, false);
  assert.equal(result.winningOutcome, null);
  assert.equal(result.yesFinalPrice, null);
  assert.equal(result.noFinalPrice, null);
});

test('verified redeem payout uses winning YES shares only', () => {
  assert.equal(
    resolveVerifiedRedeemPayoutUsd({
      yesShares: 20.78,
      noShares: 3.14,
      winningOutcome: 'YES',
    }),
    20.78
  );
});

test('verified redeem payout uses winning NO shares only', () => {
  assert.equal(
    resolveVerifiedRedeemPayoutUsd({
      yesShares: 20.78,
      noShares: 3.14,
      winningOutcome: 'NO',
    }),
    3.14
  );
});
