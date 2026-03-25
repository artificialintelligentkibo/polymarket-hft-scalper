import {
  ClobClient,
  OrderType,
  Side,
  type CreateOrderOptions,
  type TickSize,
} from '@polymarket/clob-client';
import { ethers } from 'ethers';
import {
  config,
  isDryRunMode,
  type AppConfig,
  type AuthMode,
  type OrderMode,
  type SignatureType,
} from './config.js';
import {
  CircuitBreaker,
  type CircuitBreakerSnapshot,
  retryWithBackoff,
} from './api-retry.js';
import { logger } from './logger.js';
import { clampProductTestShares } from './product-test-mode.js';
import type { Outcome } from './clob-fetcher.js';
import { roundTo } from './utils.js';

export interface ApiCredentials {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

interface ExecutionContext {
  authMode: AuthMode;
  signatureType: SignatureType;
  signerAddress: string;
  funderAddress: string;
}

interface MarketMetadata {
  tickSize: number;
  tickSizeStr: string;
  negRisk: boolean;
  feeRateBps: number;
  updatedAt: number;
}

interface BigNumberCacheEntry {
  readonly value: ethers.BigNumber;
  readonly expiresAtMs: number;
}

interface CacheMetricsSnapshot {
  readonly hits: number;
  readonly misses: number;
}

type ClobChainId = ConstructorParameters<typeof ClobClient>[1];

export interface PlaceOrderRequest {
  marketId: string;
  marketTitle: string;
  tokenId: string;
  outcome: Outcome;
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  reason: string;
  postOnly?: boolean;
  orderType?: OrderMode;
}

export interface TradeExecutionResult {
  orderId: string;
  marketId: string;
  tokenId: string;
  outcome: Outcome;
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  notionalUsd: number;
  filledShares: number;
  fillPrice: number | null;
  fillConfirmed: boolean;
  simulation: boolean;
  wasMaker: boolean | null;
  postOnly: boolean;
  orderType: OrderMode;
  balanceCacheHits: number;
  balanceCacheMisses: number;
  balanceCacheHitRatePct: number | null;
}

export class Trader {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly signerWallet: ethers.Wallet;
  private readonly clobSigner: ethers.Wallet;
  private readonly executionContext: ExecutionContext;
  private clobClient: ClobClient;
  private apiCreds?: ApiCredentials;
  private initialized = false;
  private approvalsChecked = false;
  private readonly marketMetadataCache = new Map<string, MarketMetadata>();
  private readonly metadataTtlMs = 60 * 60 * 1000;
  private readonly tokenDecimals = 6;
  private readonly clobCircuitBreaker = new CircuitBreaker({
    name: 'clob',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
  });
  private readonly balanceCache = new Map<string, BigNumberCacheEntry>();
  private readonly allowanceCache = new Map<string, BigNumberCacheEntry>();
  private readonly outcomeBalanceCache = new Map<string, BigNumberCacheEntry>();
  private usdcDecimalsPromise: Promise<number> | null = null;
  private balanceCacheHits = 0;
  private balanceCacheMisses = 0;
  private readonly erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ];
  private readonly ctfAbi = [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
  ];

  constructor(private readonly runtimeConfig: AppConfig = config) {
    this.provider = new ethers.providers.JsonRpcProvider(runtimeConfig.rpcUrl);
    if (!runtimeConfig.signerPrivateKey && !isDryRunMode(runtimeConfig)) {
      throw new Error('Missing signer private key for live trading.');
    }
    this.signerWallet = (
      runtimeConfig.signerPrivateKey
        ? new ethers.Wallet(runtimeConfig.signerPrivateKey, this.provider)
        : ethers.Wallet.createRandom().connect(this.provider)
    ) as ethers.Wallet;
    this.clobSigner = new ethers.Wallet(
      runtimeConfig.signerPrivateKey || ethers.Wallet.createRandom().privateKey
    );
    this.executionContext = createExecutionContext(runtimeConfig, this.signerWallet.address);
    this.clobClient = this.createUnauthenticatedClient();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    logger.info('Initializing trader', {
      simulationMode: this.runtimeConfig.SIMULATION_MODE,
      testMode: this.runtimeConfig.TEST_MODE,
      dryRun: this.runtimeConfig.DRY_RUN,
      authMode: this.executionContext.authMode,
      funderAddress: this.executionContext.funderAddress,
      signerAddress: this.executionContext.signerAddress,
    });

    if (!isDryRunMode(this.runtimeConfig)) {
      await this.deriveApiCredentials();
      await this.ensureApprovals();
    }

    this.initialized = true;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<TradeExecutionResult> {
    await this.initialize();

    const metadata = await this.getMarketMetadata(request.tokenId);
    const validatedPrice = this.validatePrice(request.price, metadata.tickSize);
    const validatedShares = clampProductTestShares(
      roundTo(request.shares, 4),
      validatedPrice,
      this.runtimeConfig
    );
    const notionalUsd = roundTo(validatedShares * validatedPrice, 2);
    const orderType = request.orderType ?? this.runtimeConfig.trading.orderType;
    const postOnly =
      this.runtimeConfig.PRODUCT_TEST_MODE
        ? true
        : request.postOnly ?? this.runtimeConfig.trading.defaultPostOnly;

    if (!Number.isFinite(validatedShares) || validatedShares <= 0) {
      throw new Error('Order shares must be positive.');
    }

    if (!Number.isFinite(validatedPrice) || validatedPrice <= 0) {
      throw new Error('Order price must be positive.');
    }

    if (this.runtimeConfig.PRODUCT_TEST_MODE && notionalUsd > this.runtimeConfig.TEST_MIN_TRADE_USDC * 3) {
      throw new Error(
        `PRODUCT_TEST_MODE rejected order notional $${notionalUsd.toFixed(2)} above safe cap`
      );
    }

    const cacheMetricsBefore = this.snapshotCacheMetrics();

    if (isDryRunMode(this.runtimeConfig)) {
      logger.info('Dry-run mode: skipping live order placement', {
        marketId: request.marketId,
        tokenId: request.tokenId,
        side: request.side,
        shares: validatedShares,
        price: validatedPrice,
        reason: request.reason,
        mode: this.runtimeConfig.TEST_MODE
          ? 'TEST_MODE'
          : this.runtimeConfig.SIMULATION_MODE
            ? 'SIMULATION_MODE'
            : 'DRY_RUN',
        productTestMode: this.runtimeConfig.PRODUCT_TEST_MODE,
      });

      return {
        orderId: `sim-${request.side.toLowerCase()}-${request.tokenId}-${Date.now()}`,
        marketId: request.marketId,
        tokenId: request.tokenId,
        outcome: request.outcome,
        side: request.side,
        shares: validatedShares,
        price: validatedPrice,
        notionalUsd,
        filledShares: validatedShares,
        fillPrice: validatedPrice,
        fillConfirmed: true,
        simulation: true,
        wasMaker: null,
        postOnly,
        orderType,
        balanceCacheHits: 0,
        balanceCacheMisses: 0,
        balanceCacheHitRatePct: null,
      };
    }

    if (request.side === 'BUY') {
      await this.validateBalance(notionalUsd, metadata.negRisk);
    }

    const orderTypeValue = toOrderType(orderType);
    const side = request.side === 'BUY' ? Side.BUY : Side.SELL;
    const orderOptions: Partial<CreateOrderOptions> = {
      tickSize: metadata.tickSizeStr as TickSize,
      negRisk: metadata.negRisk,
    };

    logger.info('Posting gasless order', {
      marketId: request.marketId,
      tokenId: request.tokenId,
      outcome: request.outcome,
      side: request.side,
      shares: validatedShares,
      price: validatedPrice,
      feeRateBps: metadata.feeRateBps,
      orderType,
      postOnly,
      productTestMode: this.runtimeConfig.PRODUCT_TEST_MODE,
    });

    const response = await this.executeClobCall(
      'placeOrder',
      async () =>
        orderTypeValue === OrderType.GTC
          ? this.clobClient.createAndPostOrder(
              {
                tokenID: request.tokenId,
                price: validatedPrice,
                size: validatedShares,
                side,
                feeRateBps: metadata.feeRateBps,
              },
              orderOptions,
              orderTypeValue,
              false,
              postOnly
            )
          : this.clobClient.createAndPostMarketOrder(
              {
                tokenID: request.tokenId,
                amount: request.side === 'BUY' ? notionalUsd : validatedShares,
                price: validatedPrice,
                side,
                feeRateBps: metadata.feeRateBps,
                orderType: orderTypeValue === OrderType.FAK ? OrderType.FAK : OrderType.FOK,
              },
              orderOptions,
              orderTypeValue === OrderType.FAK ? OrderType.FAK : OrderType.FOK
            ),
      {
        maxAttempts: 1,
      }
    );

    if (!response?.success) {
      const message = response?.errorMsg || response?.error || 'Unknown order error';
      throw new Error(`Order placement failed: ${message}`);
    }

    const fillSummary = extractFillSummary({
      response,
      submittedShares: validatedShares,
      submittedPrice: validatedPrice,
      orderType,
      postOnly,
    });

    return {
      orderId: response.orderID,
      marketId: request.marketId,
      tokenId: request.tokenId,
      outcome: request.outcome,
      side: request.side,
      shares: validatedShares,
      price: validatedPrice,
      notionalUsd,
      filledShares: fillSummary.filledShares,
      fillPrice: fillSummary.fillPrice,
      fillConfirmed: fillSummary.fillConfirmed,
      simulation: false,
      wasMaker: fillSummary.wasMaker,
      postOnly,
      orderType,
      ...this.computeCacheMetricsDelta(cacheMetricsBefore),
    };
  }

  async cancelAllOrders(): Promise<void> {
    await this.initialize();

    if (isDryRunMode(this.runtimeConfig)) {
      logger.info('Dry-run mode: skipping cancelAllOrders');
      return;
    }

    const client = this.clobClient as any;

    if (typeof client.cancelAll === 'function') {
      await this.executeClobCall('cancelAll', () => client.cancelAll());
      return;
    }

    if (typeof client.cancelAllOrders === 'function') {
      await this.executeClobCall('cancelAllOrders', () => client.cancelAllOrders());
      return;
    }

    logger.warn('Authenticated client does not expose cancel-all functionality');
  }

  async getOrderStatus(orderId: string): Promise<unknown> {
    await this.initialize();

    const client = this.clobClient as any;
    if (typeof client.getOrder === 'function') {
      return this.executeClobCall('getOrder', () => client.getOrder(orderId));
    }

    throw new Error('Authenticated client does not expose getOrder');
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.initialize();

    if (isDryRunMode(this.runtimeConfig)) {
      logger.info('Dry-run mode: skipping cancelOrder', { orderId });
      return;
    }

    const client = this.clobClient as any;
    if (typeof client.cancelOrder === 'function') {
      await this.executeClobCall('cancelOrder', () =>
        client.cancelOrder({ orderID: orderId })
      );
      return;
    }

    throw new Error('Authenticated client does not expose cancelOrder');
  }

  getAuthenticatedClient(): ClobClient {
    return this.clobClient;
  }

  async getApiCredentials(): Promise<ApiCredentials | null> {
    await this.initialize();
    return this.apiCreds ?? null;
  }

  async getOutcomeTokenBalance(
    tokenId: string,
    forceRefresh = false
  ): Promise<number> {
    await this.initialize();

    if (isDryRunMode(this.runtimeConfig)) {
      return Number.POSITIVE_INFINITY;
    }

    const ctf = new ethers.Contract(
      this.runtimeConfig.contracts.ctf,
      this.ctfAbi,
      this.provider
    );
    const owner = this.executionContext.funderAddress;
    const key = this.buildOutcomeBalanceCacheKey(owner, tokenId);
    const balance = await this.readCachedBigNumber({
      cache: this.outcomeBalanceCache,
      key,
      forceRefresh,
      loader: () =>
        retryWithBackoff(
          async () => ctf.balanceOf(owner, tokenId),
          {
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 2_000,
          }
        ),
    });

    return Number.parseFloat(
      ethers.utils.formatUnits(balance, this.tokenDecimals)
    );
  }

  invalidateBalanceValidationCache(): void {
    this.balanceCache.clear();
    this.allowanceCache.clear();
  }

  invalidateOutcomeBalanceCache(tokenId?: string): void {
    if (!tokenId) {
      this.outcomeBalanceCache.clear();
      return;
    }

    const owner = this.executionContext.funderAddress;
    this.outcomeBalanceCache.delete(this.buildOutcomeBalanceCacheKey(owner, tokenId));
  }

  getClobCircuitBreakerSnapshot(): CircuitBreakerSnapshot {
    return this.clobCircuitBreaker.getSnapshot();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private createUnauthenticatedClient(): ClobClient {
    return new ClobClient(
      this.runtimeConfig.clob.host,
      this.runtimeConfig.chainId as ClobChainId,
      this.clobSigner,
      undefined,
      undefined,
      undefined,
      this.runtimeConfig.polymarketGeoToken || undefined
    );
  }

  private createAuthenticatedClient(creds: ApiCredentials): ClobClient {
    return new ClobClient(
      this.runtimeConfig.clob.host,
      this.runtimeConfig.chainId as ClobChainId,
      this.clobSigner,
      {
        key: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      this.executionContext.signatureType,
      this.executionContext.funderAddress,
      this.runtimeConfig.polymarketGeoToken || undefined
    );
  }

  private async deriveApiCredentials(): Promise<void> {
    const envKey = this.runtimeConfig.POLYMARKET_API_KEY;
    const envSecret = this.runtimeConfig.POLYMARKET_API_SECRET;
    const envPassphrase = this.runtimeConfig.POLYMARKET_API_PASSPHRASE;

    if (envKey && envSecret && envPassphrase) {
      this.apiCreds = {
        apiKey: envKey,
        secret: envSecret,
        passphrase: envPassphrase,
      };
      this.clobClient = this.createAuthenticatedClient(this.apiCreds);
      logger.info('Using CLOB API credentials from environment variables');
      return;
    }

    logger.warn('No CLOB API credentials in .env - attempting runtime derive');
    const bootstrapClient = this.createUnauthenticatedClient();
    const createOrDeriveApiKey = (bootstrapClient as any).createOrDeriveApiKey?.bind(
      bootstrapClient
    );

    const creds =
      (createOrDeriveApiKey
        ? await createOrDeriveApiKey()
        : await bootstrapClient
            .deriveApiKey()
            .catch(() => bootstrapClient.createApiKey())) as any;

    const apiKey = creds?.apiKey || creds?.key;
    if (!apiKey || !creds?.secret || !creds?.passphrase) {
      throw new Error('Could not derive/create Polymarket API credentials.');
    }

    this.apiCreds = {
      apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };
    this.clobClient = this.createAuthenticatedClient(this.apiCreds);
  }

  private async getMarketMetadata(tokenId: string): Promise<MarketMetadata> {
    const cached = this.marketMetadataCache.get(tokenId);
    if (cached && Date.now() - cached.updatedAt < this.metadataTtlMs) {
      return cached;
    }

    const [tickSizeData, negRisk, feeRateRaw] = await this.executeClobCall(
      'getMarketMetadata',
      async () =>
        Promise.all([
          this.clobClient.getTickSize(tokenId).catch(() => ({ minimum_tick_size: '0.01' })),
          this.clobClient.getNegRisk(tokenId).catch(() => false),
          this.clobClient.getFeeRateBps(tokenId).catch(() => 0),
        ])
    );

    const tickSizeStr =
      String((tickSizeData as any)?.minimum_tick_size || tickSizeData || '0.01').trim() || '0.01';
    const metadata: MarketMetadata = {
      tickSize: Number.parseFloat(tickSizeStr) || 0.01,
      tickSizeStr,
      negRisk: Boolean(negRisk),
      feeRateBps: normalizeFeeRateBps(feeRateRaw),
      updatedAt: Date.now(),
    };

    this.marketMetadataCache.set(tokenId, metadata);
    return metadata;
  }

  private validatePrice(price: number, tickSize: number): number {
    const rounded = Math.round(price / tickSize) * tickSize;
    return Math.max(0.01, Math.min(0.99, roundTo(rounded, 6)));
  }

  private async ensureApprovals(): Promise<void> {
    if (this.approvalsChecked) {
      return;
    }
    this.approvalsChecked = true;

    if (this.executionContext.authMode === 'PROXY') {
      logger.info('Skipping auto-approval transactions in PROXY mode', {
        funderAddress: this.executionContext.funderAddress,
      });
      return;
    }

    const usdc = new ethers.Contract(this.runtimeConfig.contracts.usdc, this.erc20Abi, this.signerWallet);
    const ctf = new ethers.Contract(this.runtimeConfig.contracts.ctf, this.ctfAbi, this.signerWallet);
    const decimals = await this.getUsdcDecimals();
    const boundedApprovalUsd = roundTo(
      Math.max(
        (this.runtimeConfig.strategy.maxNetYes + this.runtimeConfig.strategy.maxNetNo) * 1.1,
        this.runtimeConfig.strategy.capitalReferenceShares,
        100
      ),
      2
    );
    const approvalAmount = ethers.utils.parseUnits(
      String(boundedApprovalUsd),
      decimals
    );
    const gasOverrides = await this.getGasOverrides();

    const usdcSpenders = [
      { name: 'CTF', address: this.runtimeConfig.contracts.ctf },
      { name: 'Exchange', address: this.runtimeConfig.contracts.exchange },
      { name: 'NegRiskExchange', address: this.runtimeConfig.contracts.negRiskExchange },
    ];

    for (const spender of usdcSpenders) {
      const allowance = await retryWithBackoff(
        async () =>
          usdc.allowance(this.executionContext.funderAddress, spender.address),
        {
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
        }
      );
      if (allowance.gte(approvalAmount)) {
        continue;
      }

      logger.info('Approving USDC.e spender', spender);
      const tx = await usdc.approve(spender.address, approvalAmount, gasOverrides);
      await tx.wait();
      this.invalidateBalanceValidationCache();
    }

    const operators = [
      this.runtimeConfig.contracts.exchange,
      this.runtimeConfig.contracts.negRiskExchange,
    ];
    for (const operator of operators) {
      const approved = await retryWithBackoff(
        async () =>
          ctf.isApprovedForAll(this.executionContext.funderAddress, operator),
        {
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
        }
      );
      if (approved) {
        continue;
      }

      logger.info('Approving CTF operator', { operator });
      const tx = await ctf.setApprovalForAll(operator, true, gasOverrides);
      await tx.wait();
    }
  }

  private async validateBalance(requiredAmount: number, negRisk: boolean): Promise<void> {
    const decimals = await this.getUsdcDecimals();
    const required = ethers.utils.parseUnits(requiredAmount.toFixed(2), decimals);
    const owner = this.executionContext.funderAddress;
    const spender = negRisk
      ? this.runtimeConfig.contracts.negRiskExchange
      : this.runtimeConfig.contracts.exchange;

    await this.validateBalanceSnapshot({
      owner,
      spender,
      required,
      requiredAmount,
      decimals,
      forceRefresh: false,
    }).catch(async (error) => {
      if (!isInsufficientBalanceError(error) || this.runtimeConfig.BALANCE_CACHE_TTL_MS <= 0) {
        throw error;
      }

      logger.debug('Retrying balance validation with fresh RPC state', {
        owner,
        spender,
        requiredAmount,
      });

      await this.validateBalanceSnapshot({
        owner,
        spender,
        required,
        requiredAmount,
        decimals,
        forceRefresh: true,
      });
    });
  }

  private async validateBalanceSnapshot(params: {
    owner: string;
    spender: string;
    required: ethers.BigNumber;
    requiredAmount: number;
    decimals: number;
    forceRefresh: boolean;
  }): Promise<void> {
    const [balance, allowanceToCtf, allowanceToExchange] = await Promise.all([
      this.getUsdcBalance(params.owner, params.forceRefresh),
      this.getUsdcAllowance(params.owner, this.runtimeConfig.contracts.ctf, params.forceRefresh),
      this.getUsdcAllowance(params.owner, params.spender, params.forceRefresh),
    ]);

    if (balance.lt(params.required)) {
      throw new Error(
        `Insufficient USDC.e balance for ${params.owner}: ${ethers.utils.formatUnits(
          balance,
          params.decimals
        )} < ${params.requiredAmount}`
      );
    }

    if (allowanceToCtf.lt(params.required)) {
      throw new Error('USDC.e allowance to CTF is below the required order amount.');
    }

    if (allowanceToExchange.lt(params.required)) {
      throw new Error(
        `USDC.e allowance to ${params.spender} is below the required order amount.`
      );
    }
  }

  private async getUsdcBalance(owner: string, forceRefresh: boolean): Promise<ethers.BigNumber> {
    const usdc = new ethers.Contract(this.runtimeConfig.contracts.usdc, this.erc20Abi, this.provider);
    return this.readCachedBigNumber({
      cache: this.balanceCache,
      key: `balance:${owner.toLowerCase()}`,
      forceRefresh,
      loader: () =>
        retryWithBackoff(
          async () => usdc.balanceOf(owner),
          {
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 2_000,
          }
        ),
    });
  }

  private async getUsdcAllowance(
    owner: string,
    spender: string,
    forceRefresh: boolean
  ): Promise<ethers.BigNumber> {
    const usdc = new ethers.Contract(this.runtimeConfig.contracts.usdc, this.erc20Abi, this.provider);
    return this.readCachedBigNumber({
      cache: this.allowanceCache,
      key: `allowance:${owner.toLowerCase()}:${spender.toLowerCase()}`,
      forceRefresh,
      loader: () =>
        retryWithBackoff(
          async () => usdc.allowance(owner, spender),
          {
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 2_000,
          }
        ),
    });
  }

  private async getUsdcDecimals(): Promise<number> {
    if (!this.usdcDecimalsPromise) {
      const usdc = new ethers.Contract(this.runtimeConfig.contracts.usdc, this.erc20Abi, this.provider);
      this.usdcDecimalsPromise = retryWithBackoff(
        async () => Number(await usdc.decimals()),
        {
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
        }
      );
    }

    return this.usdcDecimalsPromise;
  }

  private async readCachedBigNumber(params: {
    cache: Map<string, BigNumberCacheEntry>;
    key: string;
    forceRefresh: boolean;
    loader: () => Promise<ethers.BigNumber>;
  }): Promise<ethers.BigNumber> {
    const nowMs = Date.now();
    const ttlMs = this.runtimeConfig.BALANCE_CACHE_TTL_MS;
    if (!params.forceRefresh && ttlMs > 0) {
      const cached = params.cache.get(params.key);
      if (cached && cached.expiresAtMs > nowMs) {
        this.balanceCacheHits += 1;
        return cached.value;
      }
    }

    this.balanceCacheMisses += 1;
    const value = await params.loader();
    if (ttlMs > 0) {
      params.cache.set(params.key, {
        value,
        expiresAtMs: nowMs + ttlMs,
      });
    }

    return value;
  }

  private snapshotCacheMetrics(): CacheMetricsSnapshot {
    return {
      hits: this.balanceCacheHits,
      misses: this.balanceCacheMisses,
    };
  }

  private computeCacheMetricsDelta(
    before: CacheMetricsSnapshot
  ): Pick<
    TradeExecutionResult,
    'balanceCacheHits' | 'balanceCacheMisses' | 'balanceCacheHitRatePct'
  > {
    const hits = Math.max(0, this.balanceCacheHits - before.hits);
    const misses = Math.max(0, this.balanceCacheMisses - before.misses);
    const total = hits + misses;
    return {
      balanceCacheHits: hits,
      balanceCacheMisses: misses,
      balanceCacheHitRatePct: total > 0 ? roundTo((hits / total) * 100, 2) : null,
    };
  }

  private buildOutcomeBalanceCacheKey(owner: string, tokenId: string): string {
    return `ctf-balance:${owner.toLowerCase()}:${tokenId}`;
  }

  private async executeClobCall<T>(
    operation: string,
    fn: () => Promise<T>,
    options: { respectOpenState?: boolean; maxAttempts?: number } = {}
  ): Promise<T> {
    return retryWithBackoff(
      async () => fn(),
      {
        maxAttempts: Math.max(
          1,
          options.maxAttempts ?? this.runtimeConfig.trading.retryAttempts
        ),
        baseDelayMs: 250,
        maxDelayMs: 2_000,
        breaker: this.clobCircuitBreaker,
        respectOpenState: options.respectOpenState ?? false,
      }
    ).catch((error) => {
      logger.warn('CLOB API call failed', {
        operation,
        message: error instanceof Error ? error.message : String(error),
        circuitBreakerOpen: this.clobCircuitBreaker.getSnapshot().isOpen,
      });
      throw error;
    });
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const [feeData, latestBlock] = await retryWithBackoff(
      async () =>
        Promise.all([
          this.provider.getFeeData(),
          this.provider.getBlock('latest'),
        ]),
      {
        maxAttempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 2_000,
      }
    );
    const minPriority = ethers.utils.parseUnits('30', 'gwei');
    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || minPriority;
    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('60', 'gwei');

    const baseFee = latestBlock?.baseFeePerGas;
    if (baseFee) {
      const targetMaxFee = baseFee.mul(2).add(maxPriority);
      if (maxFee.lt(targetMaxFee)) {
        maxFee = targetMaxFee;
      }
    }

    if (maxPriority.lt(minPriority)) {
      maxPriority = minPriority;
    }
    if (maxFee.lt(maxPriority)) {
      maxFee = maxPriority;
    }

    return {
      maxPriorityFeePerGas: maxPriority,
      maxFeePerGas: maxFee,
    };
  }
}

function normalizeFeeRateBps(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }

  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    return normalizeFeeRateBps(
      record.fee_rate_bps ?? record.feeRateBps ?? record.fee_rate ?? record.feeRate
    );
  }

  return 0;
}

function isInsufficientBalanceError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error ?? '').toLowerCase();

  return (
    message.includes('insufficient balance') ||
    message.includes('not enough balance') ||
    message.includes('allowance')
  );
}

function extractFillSummary(params: {
  response: Record<string, unknown>;
  submittedShares: number;
  submittedPrice: number;
  orderType: OrderMode;
  postOnly: boolean;
}): {
  filledShares: number;
  fillPrice: number | null;
  fillConfirmed: boolean;
  wasMaker: boolean | null;
} {
  const { response, submittedShares, submittedPrice, orderType, postOnly } = params;
  const numericShareCandidates = [
    response.sizeMatched,
    response.size_matched,
    response.filledSize,
    response.filled_size,
    response.matchedSize,
    response.matched_size,
    response.executedSize,
    response.executed_size,
    (response.order as Record<string, unknown> | undefined)?.filledSize,
    (response.order as Record<string, unknown> | undefined)?.filled_size,
  ];
  const numericPriceCandidates = [
    response.avgPrice,
    response.averagePrice,
    response.average_price,
    response.fillPrice,
    response.fill_price,
    (response.order as Record<string, unknown> | undefined)?.avgPrice,
    (response.order as Record<string, unknown> | undefined)?.averagePrice,
  ];

  const explicitFilledShares = numericShareCandidates
    .map(toFiniteNumberOrNull)
    .find((value): value is number => value !== null && value >= 0);
  const explicitFillPrice = numericPriceCandidates
    .map(toFiniteNumberOrNull)
    .find((value): value is number => value !== null && value > 0);
  const rawStatus = String(
    response.status ??
      response.orderStatus ??
      (response.order as Record<string, unknown> | undefined)?.status ??
      ''
  )
    .trim()
    .toLowerCase();

  if (explicitFilledShares !== undefined) {
    return {
      filledShares: roundTo(explicitFilledShares, 4),
      fillPrice: explicitFilledShares > 0 ? roundTo(explicitFillPrice ?? submittedPrice, 6) : null,
      fillConfirmed: explicitFilledShares > 0,
      wasMaker: explicitFilledShares > 0 ? (postOnly ? true : null) : null,
    };
  }

  if (rawStatus === 'filled' || rawStatus === 'matched' || rawStatus === 'executed') {
    return {
      filledShares: roundTo(submittedShares, 4),
      fillPrice: roundTo(explicitFillPrice ?? submittedPrice, 6),
      fillConfirmed: true,
      wasMaker: postOnly ? true : null,
    };
  }

  const assumeImmediateFill = orderType !== 'GTC' || !postOnly;
  if (assumeImmediateFill) {
    return {
      filledShares: roundTo(submittedShares, 4),
      fillPrice: roundTo(explicitFillPrice ?? submittedPrice, 6),
      fillConfirmed: true,
      wasMaker: postOnly ? true : null,
    };
  }

  logger.warn('Live order accepted without explicit fill confirmation; treating as resting order', {
    orderId: String(response.orderID ?? response.orderId ?? ''),
    status: rawStatus || 'unknown',
    submittedShares,
    submittedPrice,
    orderType,
    postOnly,
  });

  return {
    filledShares: 0,
    fillPrice: null,
    fillConfirmed: false,
    wasMaker: null,
  };
}

function resolveSignerAddress(candidate: AppConfig, signerAddress: string): string {
  if (isDryRunMode(candidate) && !candidate.signerPrivateKey) {
    return ethers.constants.AddressZero;
  }
  return ethers.utils.getAddress(signerAddress);
}

function resolveFunderAddress(candidate: AppConfig, signerAddress: string): string {
  if (isDryRunMode(candidate) && !candidate.auth.funderAddress) {
    return ethers.constants.AddressZero;
  }

  if (candidate.auth.mode === 'PROXY') {
    return ethers.utils.getAddress(candidate.auth.funderAddress);
  }

  return signerAddress;
}

function getActiveSignatureType(candidate: AppConfig): SignatureType {
  if (candidate.auth.signatureType !== undefined) {
    return candidate.auth.signatureType;
  }
  if (isDryRunMode(candidate)) {
    return 0;
  }
  return candidate.auth.mode === 'EOA' ? 0 : 1;
}

function createExecutionContext(candidate: AppConfig, signerAddress: string): ExecutionContext {
  const resolvedSigner = resolveSignerAddress(candidate, signerAddress);
  return {
    authMode: candidate.auth.mode,
    signatureType: getActiveSignatureType(candidate),
    signerAddress: resolvedSigner,
    funderAddress: resolveFunderAddress(candidate, resolvedSigner),
  };
}

function toOrderType(orderType: OrderMode): OrderType.GTC | OrderType.FOK | OrderType.FAK {
  if (orderType === 'FOK') {
    return OrderType.FOK;
  }
  if (orderType === 'FAK') {
    return OrderType.FAK;
  }
  return OrderType.GTC;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
