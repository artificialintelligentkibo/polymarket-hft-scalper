import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { config, type AppConfig, type AuthMode, type SignatureType } from './config.js';
import { logger } from './logger.js';
import type { Outcome } from './clob-fetcher.js';

interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
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

export interface PlaceOrderRequest {
  marketId: string;
  marketTitle: string;
  tokenId: string;
  outcome: Outcome;
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  reason: string;
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
  simulation: boolean;
}

export class Trader {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly signerWallet: ethers.Wallet;
  private readonly executionContext: ExecutionContext;
  private clobClient: ClobClient;
  private apiCreds?: ApiCredentials;
  private initialized = false;
  private approvalsChecked = false;
  private readonly marketMetadataCache = new Map<string, MarketMetadata>();
  private readonly metadataTtlMs = 60 * 60 * 1000;
  private readonly erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ];
  private readonly ctfAbi = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
  ];

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signerWallet = (
      config.signerPrivateKey
        ? new ethers.Wallet(config.signerPrivateKey, this.provider)
        : ethers.Wallet.createRandom().connect(this.provider)
    ) as ethers.Wallet;
    this.executionContext = createExecutionContext(config, this.signerWallet.address);
    this.clobClient = this.createUnauthenticatedClient();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    logger.info('Initializing trader', {
      simulationMode: config.SIMULATION_MODE,
      testMode: config.TEST_MODE,
      authMode: this.executionContext.authMode,
      funderAddress: this.executionContext.funderAddress,
      signerAddress: this.executionContext.signerAddress,
    });

    if (!config.SIMULATION_MODE && !config.TEST_MODE) {
      await this.deriveApiCredentials();
      await this.ensureApprovals();
    }

    this.initialized = true;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<TradeExecutionResult> {
    await this.initialize();

    const validatedShares = roundTo(request.shares, 4);
    const metadata = await this.getMarketMetadata(request.tokenId);
    const validatedPrice = this.validatePrice(request.price, metadata.tickSize);
    const notionalUsd = roundTo(validatedShares * validatedPrice, 2);

    if (!Number.isFinite(validatedShares) || validatedShares <= 0) {
      throw new Error('Order shares must be positive.');
    }

    if (!Number.isFinite(validatedPrice) || validatedPrice <= 0) {
      throw new Error('Order price must be positive.');
    }

    if (config.SIMULATION_MODE || config.TEST_MODE) {
      logger.info('Simulation mode: skipping live order placement', {
        marketId: request.marketId,
        tokenId: request.tokenId,
        side: request.side,
        shares: validatedShares,
        price: validatedPrice,
        reason: request.reason,
        mode: config.TEST_MODE ? 'TEST_MODE' : 'SIMULATION_MODE',
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
        simulation: true,
      };
    }

    if (request.side === 'BUY') {
      await this.validateBalance(notionalUsd, metadata.negRisk);
    }

    const orderType = toOrderType(config.trading.orderType);
    const side = request.side === 'BUY' ? Side.BUY : Side.SELL;
    const orderOptions = {
      tickSize: metadata.tickSizeStr as any,
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
      orderType: config.trading.orderType,
    });

    const response =
      orderType === OrderType.GTC
        ? await this.clobClient.createAndPostOrder(
            {
              tokenID: request.tokenId,
              price: validatedPrice,
              size: validatedShares,
              side,
              feeRateBps: metadata.feeRateBps,
            },
            orderOptions,
            orderType,
            false,
            config.trading.postOnly
          )
        : await this.clobClient.createAndPostMarketOrder(
            {
              tokenID: request.tokenId,
              amount: request.side === 'BUY' ? notionalUsd : validatedShares,
              price: validatedPrice,
              side,
              feeRateBps: metadata.feeRateBps,
              orderType,
            },
            orderOptions,
            orderType
          );

    if (!response?.success) {
      const message = response?.errorMsg || response?.error || 'Unknown order error';
      throw new Error(`Order placement failed: ${message}`);
    }

    return {
      orderId: response.orderID,
      marketId: request.marketId,
      tokenId: request.tokenId,
      outcome: request.outcome,
      side: request.side,
      shares: validatedShares,
      price: validatedPrice,
      notionalUsd,
      simulation: false,
    };
  }

  private createUnauthenticatedClient(): ClobClient {
    return new ClobClient(
      config.clob.host,
      config.chainId as any,
      this.signerWallet,
      undefined,
      undefined,
      undefined,
      config.polymarketGeoToken || undefined
    );
  }

  private createAuthenticatedClient(creds: ApiCredentials): ClobClient {
    return new ClobClient(
      config.clob.host,
      config.chainId as any,
      this.signerWallet,
      {
        key: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      this.executionContext.signatureType,
      this.executionContext.funderAddress,
      config.polymarketGeoToken || undefined
    );
  }

  private async deriveApiCredentials(): Promise<void> {
    const bootstrapClient = this.createUnauthenticatedClient();
    const createOrDeriveApiKey = (bootstrapClient as any).createOrDeriveApiKey?.bind(bootstrapClient);

    const creds =
      (createOrDeriveApiKey
        ? await createOrDeriveApiKey()
        : await bootstrapClient.deriveApiKey().catch(() => bootstrapClient.createApiKey())) as any;

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

    const [tickSizeData, negRisk, feeRateRaw] = await Promise.all([
      this.clobClient.getTickSize(tokenId).catch(() => ({ minimum_tick_size: '0.01' })),
      this.clobClient.getNegRisk(tokenId).catch(() => false),
      this.clobClient.getFeeRateBps(tokenId).catch(() => 0),
    ]);

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

    const usdc = new ethers.Contract(config.contracts.usdc, this.erc20Abi, this.signerWallet);
    const ctf = new ethers.Contract(config.contracts.ctf, this.ctfAbi, this.signerWallet);
    const decimals = await usdc.decimals();
    const approvalAmount = ethers.utils.parseUnits(
      String(Math.max(config.strategy.maxShares * 0.99, 50)),
      decimals
    );
    const gasOverrides = await this.getGasOverrides();

    const usdcSpenders = [
      { name: 'CTF', address: config.contracts.ctf },
      { name: 'Exchange', address: config.contracts.exchange },
      { name: 'NegRiskExchange', address: config.contracts.negRiskExchange },
    ];

    for (const spender of usdcSpenders) {
      const allowance = await usdc.allowance(this.executionContext.funderAddress, spender.address);
      if (allowance.gte(approvalAmount)) {
        continue;
      }

      logger.info('Approving USDC.e spender', spender);
      const tx = await usdc.approve(spender.address, ethers.constants.MaxUint256, gasOverrides);
      await tx.wait();
    }

    const operators = [config.contracts.exchange, config.contracts.negRiskExchange];
    for (const operator of operators) {
      const approved = await ctf.isApprovedForAll(this.executionContext.funderAddress, operator);
      if (approved) {
        continue;
      }

      logger.info('Approving CTF operator', { operator });
      const tx = await ctf.setApprovalForAll(operator, true, gasOverrides);
      await tx.wait();
    }
  }

  private async validateBalance(requiredAmount: number, negRisk: boolean): Promise<void> {
    const usdc = new ethers.Contract(config.contracts.usdc, this.erc20Abi, this.provider);
    const decimals = await usdc.decimals();
    const required = ethers.utils.parseUnits(requiredAmount.toFixed(2), decimals);
    const owner = this.executionContext.funderAddress;
    const spender = negRisk ? config.contracts.negRiskExchange : config.contracts.exchange;

    const [balance, allowanceToCtf, allowanceToExchange] = await Promise.all([
      usdc.balanceOf(owner),
      usdc.allowance(owner, config.contracts.ctf),
      usdc.allowance(owner, spender),
    ]);

    if (balance.lt(required)) {
      throw new Error(
        `Insufficient USDC.e balance for ${owner}: ${ethers.utils.formatUnits(balance, decimals)} < ${requiredAmount}`
      );
    }

    if (allowanceToCtf.lt(required)) {
      throw new Error('USDC.e allowance to CTF is below the required order amount.');
    }

    if (allowanceToExchange.lt(required)) {
      throw new Error(`USDC.e allowance to ${spender} is below the required order amount.`);
    }
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const latestBlock = await this.provider.getBlock('latest');
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

function toOrderType(orderType: 'GTC' | 'FOK' | 'FAK'): OrderType {
  if (orderType === 'FOK') {
    return OrderType.FOK;
  }
  if (orderType === 'FAK') {
    return OrderType.FAK;
  }
  return OrderType.GTC;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isDryRunMode(candidate: AppConfig): boolean {
  return candidate.SIMULATION_MODE || candidate.TEST_MODE;
}
