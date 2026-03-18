import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayerTxType } from '@polymarket/builder-relayer-client';
import {
  buildRedeemTransaction,
  groupRedeemablePositions,
  normalizeRedeemablePosition,
  resolveAutoRedeemerStatus,
  type RedeemablePosition,
} from '../src/auto-redeemer.js';
import { createConfig } from '../src/config.js';

test('normalizeRedeemablePosition keeps current Data API redeemable fields', () => {
  const position = normalizeRedeemablePosition({
    proxyWallet: '0x1111111111111111111111111111111111111111',
    asset: '12345',
    conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    size: '14.25',
    redeemable: true,
    negativeRisk: false,
    title: 'Bitcoin Up or Down - sample',
    outcome: 'Up',
    outcomeIndex: 0,
    endDate: '2030-11-21T15:15:00Z',
  });

  assert.ok(position);
  assert.equal(position?.size, 14.25);
  assert.equal(position?.outcomeIndex, 0);
  assert.equal(position?.proxyWallet, '0x1111111111111111111111111111111111111111');
});

test('groupRedeemablePositions aggregates binary positions by conditionId', () => {
  const positions: RedeemablePosition[] = [
    {
      conditionId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      asset: 'yes-token',
      title: 'Solana Up or Down',
      outcome: 'Up',
      outcomeIndex: 0,
      size: 11.5,
      redeemable: true,
      negativeRisk: false,
      proxyWallet: '0x2222222222222222222222222222222222222222',
      endDate: null,
    },
    {
      conditionId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      asset: 'no-token',
      title: 'Solana Up or Down',
      outcome: 'Down',
      outcomeIndex: 1,
      size: 4.25,
      redeemable: true,
      negativeRisk: false,
      proxyWallet: '0x2222222222222222222222222222222222222222',
      endDate: null,
    },
  ];

  const groups = groupRedeemablePositions(positions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.yesShares, 11.5);
  assert.equal(groups[0]?.noShares, 4.25);
  assert.deepEqual(groups[0]?.outcomeIndexes, [0, 1]);
});

test('resolveAutoRedeemerStatus only enables in live proxy mode', () => {
  const dryRunConfig = createConfig({
    ...process.env,
    AUTO_REDEEM: 'true',
    DRY_RUN: 'true',
    TEST_MODE: 'false',
    SIMULATION_MODE: 'false',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x3333333333333333333333333333333333333333',
    POLYMARKET_API_KEY: 'relayer-test-key',
    SIGNER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f094538e5b0032c0f2d50cf1fbd8c8a1490c6f68',
  });

  const dryRunStatus = resolveAutoRedeemerStatus(
    dryRunConfig,
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
  );
  assert.equal(dryRunStatus.enabled, false);

  const liveProxyConfig = createConfig({
    ...process.env,
    AUTO_REDEEM: 'true',
    DRY_RUN: 'false',
    TEST_MODE: 'false',
    SIMULATION_MODE: 'false',
    AUTH_MODE: 'PROXY',
    SIGNATURE_TYPE: '1',
    FUNDER_ADDRESS: '0x3333333333333333333333333333333333333333',
    POLYMARKET_API_KEY: 'relayer-test-key',
    SIGNER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f094538e5b0032c0f2d50cf1fbd8c8a1490c6f68',
  });

  const liveProxyStatus = resolveAutoRedeemerStatus(
    liveProxyConfig,
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
  );
  assert.equal(liveProxyStatus.enabled, true);
  assert.equal(liveProxyStatus.positionsUser, '0x3333333333333333333333333333333333333333');
  assert.equal(liveProxyStatus.relayTxType, RelayerTxType.PROXY);
});

test('buildRedeemTransaction creates CTF redeem calldata for binary markets', () => {
  const runtimeConfig = createConfig({
    ...process.env,
    AUTO_REDEEM: 'true',
  });

  const transaction = buildRedeemTransaction(
    {
      conditionId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      title: 'Bitcoin Up or Down',
      negativeRisk: false,
      proxyWallet: '0x4444444444444444444444444444444444444444',
      positionCount: 1,
      totalShares: 18,
      yesShares: 18,
      noShares: 0,
      outcomeIndexes: [0],
    },
    runtimeConfig
  );

  assert.ok(transaction);
  assert.equal(transaction?.to, runtimeConfig.contracts.ctf);
  assert.equal(transaction?.value, '0');
  assert.match(transaction?.data || '', /^0x[a-fA-F0-9]+$/);
});
