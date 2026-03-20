import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { Trader } from '../src/trader.js';

test('Trader refuses live construction without a signer private key', () => {
  const candidate = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'false',
    SIMULATION_MODE: 'false',
    TEST_MODE: 'false',
    DRY_RUN: 'false',
    AUTH_MODE: 'EOA',
    SIGNER_PRIVATE_KEY: '',
    PRIVATE_KEY: '',
    EXECUTION_WALLET_PRIVATE_KEY: '',
  });

  assert.throws(() => new Trader(candidate), /Missing signer private key/i);
});
