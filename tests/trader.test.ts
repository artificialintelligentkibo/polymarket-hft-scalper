import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
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

test('Trader prewarmMarketMetadata fetches cold token metadata once and reuses cache', async () => {
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
      getTickSize: (tokenId: string) => Promise<unknown>;
      getNegRisk: (tokenId: string) => Promise<boolean>;
      getFeeRateBps: (tokenId: string) => Promise<number>;
    };
    executeClobCall: (operation: string, fn: () => Promise<unknown>) => Promise<unknown>;
    prewarmMarketMetadata: (tokenIds: readonly string[]) => Promise<void>;
    getMarketMetadata: (tokenId: string) => Promise<unknown>;
  };

  let metadataCalls = 0;
  trader.initialize = async () => undefined;
  trader.clobClient = {
    getTickSize: async () => ({ minimum_tick_size: '0.01' }),
    getNegRisk: async () => false,
    getFeeRateBps: async () => 1000,
  };
  trader.executeClobCall = async (_operation: string, fn: () => Promise<unknown>) => {
    metadataCalls += 1;
    return fn();
  };

  await trader.prewarmMarketMetadata(['token-a', 'token-a', 'token-b']);
  await trader.getMarketMetadata('token-a');
  await trader.getMarketMetadata('token-b');

  assert.equal(metadataCalls, 2);
});

test('Trader validateBalance uses a fresh funding snapshot for small repeated buys', async () => {
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
    getUsdcDecimals: () => Promise<number>;
    validateBalance: (requiredAmount: number, negRisk: boolean) => Promise<void>;
    validateBalanceSnapshot: () => Promise<unknown>;
    fundingValidationSnapshot: {
      owner: string;
      spender: string;
      usdcBalance: ethers.BigNumber;
      allowanceToCtf: ethers.BigNumber;
      allowanceToSpender: ethers.BigNumber;
      updatedAtMs: number;
    } | null;
    executionContext: {
      funderAddress: string;
    };
    runtimeConfig: {
      contracts: {
        exchange: string;
      };
    };
  };

  let chainValidationCalls = 0;
  trader.getUsdcDecimals = async () => 6;
  trader.validateBalanceSnapshot = async () => {
    chainValidationCalls += 1;
    throw new Error('validateBalanceSnapshot should not be called when the fast snapshot is fresh');
  };
  trader.fundingValidationSnapshot = {
    owner: trader.executionContext.funderAddress,
    spender: trader.runtimeConfig.contracts.exchange,
    usdcBalance: ethers.utils.parseUnits('40', 6),
    allowanceToCtf: ethers.utils.parseUnits('40', 6),
    allowanceToSpender: ethers.utils.parseUnits('40', 6),
    updatedAtMs: Date.now(),
  };

  await trader.validateBalance(2, false);

  assert.equal(chainValidationCalls, 0);
  assert.ok(
    trader.fundingValidationSnapshot &&
      trader.fundingValidationSnapshot.usdcBalance.lt(ethers.utils.parseUnits('40', 6))
  );
});
