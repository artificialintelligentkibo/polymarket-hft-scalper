import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { Trader } from '../src/trader.js';

const TEST_PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123';

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

test('Trader getOrderStatus delegates to authenticated client getOrder', async () => {
  const candidate = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'false',
    SIMULATION_MODE: 'false',
    TEST_MODE: 'false',
    DRY_RUN: 'false',
    AUTH_MODE: 'EOA',
    SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
  });

  const trader = new Trader(candidate) as unknown as {
    initialize: () => Promise<void>;
    clobClient: {
      getOrder: (orderId: string) => Promise<unknown>;
    };
    getOrderStatus: (orderId: string) => Promise<unknown>;
  };

  let receivedOrderId: string | null = null;
  trader.initialize = async () => undefined;
  trader.clobClient = {
    getOrder: async (orderId: string) => {
      receivedOrderId = orderId;
      return { id: orderId, status: 'open' };
    },
  };

  const result = await trader.getOrderStatus('order-123');

  assert.equal(receivedOrderId, 'order-123');
  assert.deepEqual(result, { id: 'order-123', status: 'open' });
});

test('Trader cancelOrder forwards the expected orderID payload', async () => {
  const candidate = createConfig({
    ...process.env,
    PRODUCT_TEST_MODE: 'false',
    SIMULATION_MODE: 'false',
    TEST_MODE: 'false',
    DRY_RUN: 'false',
    AUTH_MODE: 'EOA',
    SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
  });

  const trader = new Trader(candidate) as unknown as {
    initialize: () => Promise<void>;
    clobClient: {
      cancelOrder: (payload: { orderID: string }) => Promise<void>;
    };
    cancelOrder: (orderId: string) => Promise<void>;
  };

  let receivedPayload: { orderID: string } | null = null;
  trader.initialize = async () => undefined;
  trader.clobClient = {
    cancelOrder: async (payload: { orderID: string }) => {
      receivedPayload = payload;
    },
  };

  await trader.cancelOrder('order-456');

  assert.deepEqual(receivedPayload, { orderID: 'order-456' });
});
