import { EventEmitter } from 'node:events';
import { RelayClient, RelayerTxType, type Transaction } from '@polymarket/builder-relayer-client';
import { ethers } from 'ethers';
import { config, isDryRunMode, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { writeRedeemLog } from './reports.js';
import { formatLogTimestamp, getErrorMessage, roundTo, sanitizeInlineText } from './utils.js';

const DATA_API_POSITIONS_URL = 'https://data-api.polymarket.com/positions';
const POSITIONS_PAGE_LIMIT = 500;
const MAX_POSITION_PAGES = 10;
const RECENT_REDEEM_TTL_MS = 10 * 60 * 1000;
const MAX_RELAYER_POLL_COUNT = 100;
const TOKEN_DECIMALS = 6;
const DEFAULT_PROXY_GAS_LIMIT = ethers.BigNumber.from('10000000');
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SAFE_INIT_CODE_HASH =
  '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf';
const PROXY_INIT_CODE_HASH =
  '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b';
const SAFE_FACTORY_NAME = 'Polymarket Contract Proxy Factory';
const PROXY_FACTORY_ADDRESS = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const RELAY_HUB_ADDRESS = '0xD216153c06E857cD7f72665E0aF1d7D82172F494';
const SAFE_FACTORY_ADDRESS = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';

const PROXY_FACTORY_INTERFACE = new ethers.utils.Interface([
  'function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)',
]);

const CTF_INTERFACE = new ethers.utils.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

const NEG_RISK_ADAPTER_INTERFACE = new ethers.utils.Interface([
  'function redeemPositions(bytes32 _conditionId, uint256[] _amounts)',
]);

export interface RedeemablePosition {
  readonly conditionId: string;
  readonly asset: string;
  readonly title: string;
  readonly outcome: string;
  readonly outcomeIndex: number | null;
  readonly size: number;
  readonly redeemable: boolean;
  readonly negativeRisk: boolean;
  readonly proxyWallet: string | null;
  readonly endDate: string | null;
}

export interface RedeemGroup {
  readonly conditionId: string;
  readonly title: string;
  readonly negativeRisk: boolean;
  readonly proxyWallet: string | null;
  readonly positionCount: number;
  readonly totalShares: number;
  readonly yesShares: number;
  readonly noShares: number;
  readonly outcomeIndexes: readonly number[];
}

export interface RedeemerStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly relayTxType: RelayerTxType | null;
  readonly positionsUser: string | null;
  readonly apiKeyAddress: string | null;
}

export interface AutoRedeemerOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly relayerUrl?: string;
}

interface RedeemExecutionResult {
  readonly transactionId: string | null;
  readonly transactionHash: string | null;
  readonly state: string | null;
}

export class AutoRedeemer extends EventEmitter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly relayerUrl: string;
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly signerWallet: ethers.Wallet | null;
  private readonly status: RedeemerStatus;
  private readonly relayClient: RelayClient | null;
  private readonly recentlyRedeemed = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private cycleInFlight = false;

  constructor(
    private readonly runtimeConfig: AppConfig = config,
    options: AutoRedeemerOptions = {}
  ) {
    super();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.relayerUrl = options.relayerUrl ?? runtimeConfig.POLYMARKET_RELAYER_URL;
    this.provider = new ethers.providers.JsonRpcProvider(runtimeConfig.rpcUrl);
    this.signerWallet = runtimeConfig.signerPrivateKey
      ? new ethers.Wallet(runtimeConfig.signerPrivateKey, this.provider)
      : null;
    this.status = resolveAutoRedeemerStatus(runtimeConfig, this.signerWallet?.address);
    this.relayClient =
      this.status.enabled && this.signerWallet && this.status.relayTxType
        ? new RelayClient(
            this.relayerUrl,
            runtimeConfig.chainId,
            this.signerWallet,
            undefined,
            this.status.relayTxType
          )
        : null;
  }

  start(): void {
    if (!this.status.enabled) {
      logger.info('Auto redeem is disabled', {
        reason: this.status.reason,
        autoRedeem: this.runtimeConfig.AUTO_REDEEM,
        authMode: this.runtimeConfig.auth.mode,
        signatureType: this.runtimeConfig.auth.signatureType,
      });
      return;
    }

    if (!this.relayClient || !this.status.positionsUser) {
      logger.warn('Auto redeem could not start because relayer dependencies are unavailable', {
        reason: this.status.reason,
      });
      return;
    }

    if (this.timer) {
      return;
    }

    logger.info('Starting auto redeemer', {
      intervalMs: this.runtimeConfig.REDEEM_INTERVAL_MS,
      positionsUser: this.status.positionsUser,
      relayType: this.status.relayTxType,
      relayerUrl: this.relayerUrl,
      apiKeyAddress: this.status.apiKeyAddress,
    });

    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.runtimeConfig.REDEEM_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
    logger.info('Auto redeemer stopped');
  }

  async tick(): Promise<void> {
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    if (!this.relayClient || !this.status.positionsUser) {
      return;
    }

    if (this.cycleInFlight) {
      logger.debug('Skipping auto redeem cycle because a previous cycle is still running');
      return;
    }

    this.cycleInFlight = true;
    this.pruneRecentlyRedeemed();

    try {
      const positions = await this.fetchRedeemablePositions(this.status.positionsUser);
      const groups = groupRedeemablePositions(positions).filter(
        (group) => !this.wasRecentlyRedeemed(group.conditionId)
      );

      logger.debug('Auto redeem poll completed', {
        positionsUser: this.status.positionsUser,
        redeemablePositions: positions.length,
        redeemableConditions: groups.length,
      });

      for (const group of groups) {
        await this.redeemGroup(group);
      }
    } catch (error: any) {
      const message = getErrorMessage(error);
      logger.warn('Auto redeem cycle failed', {
        positionsUser: this.status.positionsUser,
        message,
      });
      this.logRedeemLine('FAILED', {
        conditionId: 'n/a',
        title: 'Auto redeem cycle',
        detail: message,
      });
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async fetchRedeemablePositions(userAddress: string): Promise<RedeemablePosition[]> {
    const positions: RedeemablePosition[] = [];

    for (let page = 0; page < MAX_POSITION_PAGES; page += 1) {
      const offset = page * POSITIONS_PAGE_LIMIT;
      const url = new URL(DATA_API_POSITIONS_URL);
      url.searchParams.set('user', userAddress.toLowerCase());
      url.searchParams.set('redeemable', 'true');
      url.searchParams.set('sizeThreshold', '0');
      url.searchParams.set('limit', String(POSITIONS_PAGE_LIMIT));
      url.searchParams.set('offset', String(offset));

      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Positions API returned ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as unknown;
      const pageRows = Array.isArray(payload) ? payload : [];
      const normalized = pageRows
        .map((entry) => normalizeRedeemablePosition(entry))
        .filter((entry): entry is RedeemablePosition => entry !== null);

      positions.push(...normalized);

      if (pageRows.length < POSITIONS_PAGE_LIMIT) {
        break;
      }
    }

    return positions;
  }

  private async redeemGroup(group: RedeemGroup): Promise<void> {
    if (!this.relayClient) {
      return;
    }

    const transaction = buildRedeemTransaction(group, this.runtimeConfig);
    if (!transaction) {
      logger.warn('Skipping redeemable condition because no valid transaction could be built', {
        conditionId: group.conditionId,
        title: group.title,
        negativeRisk: group.negativeRisk,
      });
      this.logRedeemLine('SKIPPED', {
        conditionId: group.conditionId,
        title: group.title,
        detail: 'No valid redeem transaction could be built',
      });
      return;
    }

    const startedAt = this.now();
    try {
      logger.info('Submitting gasless redeem', {
        conditionId: group.conditionId,
        title: group.title,
        relayType: this.status.relayTxType,
        negativeRisk: group.negativeRisk,
        totalShares: roundTo(group.totalShares, 4),
      });

      const execution = await this.submitRedeemTransaction(
        transaction,
        `redeem ${group.conditionId}`
      );
      if (!execution.transactionId || !execution.state) {
        throw new Error('Relayer did not return a confirmed redeem transaction.');
      }
      this.recentlyRedeemed.set(group.conditionId, this.now());

      logger.info('Gasless redeem completed', {
        conditionId: group.conditionId,
        title: group.title,
        transactionId: execution.transactionId,
        transactionHash: execution.transactionHash,
        state: execution.state,
        latencyMs: this.now() - startedAt,
      });

      this.logRedeemLine('REDEEMED', {
        conditionId: group.conditionId,
        title: group.title,
        detail: [
          `txId=${execution.transactionId ?? 'n/a'}`,
          `txHash=${execution.transactionHash ?? 'n/a'}`,
          `state=${execution.state ?? 'unknown'}`,
          `shares=${roundTo(group.totalShares, 4)}`,
          `relayType=${this.status.relayTxType ?? 'n/a'}`,
        ].join(' '),
      });
      this.emit('redeem-success', {
        timestampMs: this.now(),
        conditionId: group.conditionId,
        title: group.title,
        redeemedAmount: roundTo(group.totalShares, 4),
        yesShares: roundTo(group.yesShares, 4),
        noShares: roundTo(group.noShares, 4),
        transactionId: execution.transactionId,
        transactionHash: execution.transactionHash,
        state: execution.state,
      });
    } catch (error: any) {
      const message = getErrorMessage(error);
      logger.warn('Gasless redeem failed', {
        conditionId: group.conditionId,
        title: group.title,
        message,
      });
      this.logRedeemLine('FAILED', {
        conditionId: group.conditionId,
        title: group.title,
        detail: message,
      });
      this.emit('redeem-failed', {
        timestampMs: this.now(),
        conditionId: group.conditionId,
        title: group.title,
        message,
      });
    }
  }

  private async submitRedeemTransaction(
    transaction: Transaction,
    metadata: string
  ): Promise<RedeemExecutionResult> {
    if (!this.relayClient || !this.signerWallet || !this.status.relayTxType) {
      throw new Error('Relayer client is not initialized.');
    }

    const relayerKey =
      this.runtimeConfig.POLYMARKET_RELAYER_KEY || this.runtimeConfig.POLYMARKET_API_KEY;
    const relayerKeyAddress =
      this.runtimeConfig.POLYMARKET_RELAYER_KEY_ADDRESS || this.status.apiKeyAddress;
    if (!relayerKey || !relayerKeyAddress) {
      throw new Error(
        'Relayer credentials required. Set POLYMARKET_RELAYER_KEY and POLYMARKET_RELAYER_KEY_ADDRESS in .env. Get these from Polymarket -> Settings -> Relayer API Keys.'
      );
    }

    const request =
      this.status.relayTxType === RelayerTxType.SAFE
        ? await this.buildSafeRequest(transaction, metadata)
        : await this.buildProxyRequest(transaction, metadata);
    const response = await this.fetchImpl(new URL('/submit', `${this.relayerUrl}/`), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        RELAYER_API_KEY:
          this.runtimeConfig.POLYMARKET_RELAYER_KEY || this.runtimeConfig.POLYMARKET_API_KEY,
        RELAYER_API_KEY_ADDRESS:
          this.runtimeConfig.POLYMARKET_RELAYER_KEY_ADDRESS ||
          this.status.apiKeyAddress ||
          '',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Relayer submit failed with ${response.status} ${response.statusText}: ${body || 'empty body'}`
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const transactionId = normalizeOptionalString(
      payload.transactionID ?? payload.transactionId
    );
    const initialHash = normalizeOptionalString(payload.transactionHash ?? payload.hash);
    const initialState = normalizeOptionalString(payload.state);

    if (!transactionId) {
      throw new Error('Relayer submit response did not include transactionID.');
    }

    const result = await this.relayClient.pollUntilState(
      transactionId,
      ['STATE_MINED', 'STATE_CONFIRMED'],
      'STATE_FAILED',
      MAX_RELAYER_POLL_COUNT
    );

    if (!result) {
      return {
        transactionId,
        transactionHash: initialHash,
        state: null,
      };
    }

    return {
      transactionId,
      transactionHash: normalizeOptionalString(result.transactionHash) ?? initialHash,
      state: normalizeOptionalString(result.state) ?? initialState,
    };
  }

  private async buildProxyRequest(
    transaction: Transaction,
    metadata: string
  ): Promise<Record<string, unknown>> {
    if (!this.relayClient || !this.signerWallet) {
      throw new Error('Relayer client is not initialized.');
    }

    const from = await this.signerWallet.getAddress();
    const relayPayload = await this.relayClient.getRelayPayload(from, RelayerTxType.PROXY);
    const encodedProxyData = PROXY_FACTORY_INTERFACE.encodeFunctionData('proxy', [[
      {
        typeCode: 1,
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
      },
    ]]);
    const gasLimit = await this.estimateProxyGasLimit(
      this.signerWallet,
      PROXY_FACTORY_ADDRESS,
      from,
      encodedProxyData
    );
    const structHash = ethers.utils.keccak256(
      ethers.utils.hexConcat([
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes('rlx:')),
        from,
        PROXY_FACTORY_ADDRESS,
        encodedProxyData,
        hexZeroPadNumber('0'),
        hexZeroPadNumber('0'),
        hexZeroPadNumber(gasLimit.toString()),
        hexZeroPadNumber(relayPayload.nonce),
        RELAY_HUB_ADDRESS,
        relayPayload.address,
      ])
    );
    const signature = await this.signerWallet.signMessage(ethers.utils.arrayify(structHash));

    return {
      from,
      to: PROXY_FACTORY_ADDRESS,
      proxyWallet: deriveProxyWallet(from, PROXY_FACTORY_ADDRESS),
      data: encodedProxyData,
      nonce: relayPayload.nonce,
      signature,
      signatureParams: {
        gasPrice: '0',
        gasLimit: gasLimit.toString(),
        relayerFee: '0',
        relayHub: RELAY_HUB_ADDRESS,
        relay: relayPayload.address,
      },
      type: RelayerTxType.PROXY,
      metadata,
    };
  }

  private async buildSafeRequest(
    transaction: Transaction,
    metadata: string
  ): Promise<Record<string, unknown>> {
    if (!this.relayClient || !this.signerWallet) {
      throw new Error('Relayer client is not initialized.');
    }

    const from = await this.signerWallet.getAddress();
    const safeAddress = deriveSafe(from, SAFE_FACTORY_ADDRESS);
    const deployed = await this.relayClient.getDeployed(safeAddress);
    if (!deployed) {
      await this.deploySafe(from, safeAddress);
    }

    const noncePayload = await this.relayClient.getNonce(from, RelayerTxType.SAFE);
    const structHash = ethers.utils._TypedDataEncoder.hash(
      {
        chainId: this.runtimeConfig.chainId,
        verifyingContract: safeAddress,
      },
      {
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      {
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: noncePayload.nonce,
      }
    );
    const signature = await this.signerWallet.signMessage(ethers.utils.arrayify(structHash));

    return {
      from,
      to: transaction.to,
      proxyWallet: safeAddress,
      data: transaction.data,
      nonce: noncePayload.nonce,
      signature: packSafeSignature(signature),
      signatureParams: {
        gasPrice: '0',
        operation: '0',
        safeTxnGas: '0',
        baseGas: '0',
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
      },
      type: RelayerTxType.SAFE,
      metadata,
    };
  }

  private async deploySafe(from: string, safeAddress: string): Promise<void> {
    if (!this.signerWallet) {
      throw new Error('Signer wallet is not initialized.');
    }

    const relayerKey =
      this.runtimeConfig.POLYMARKET_RELAYER_KEY || this.runtimeConfig.POLYMARKET_API_KEY;
    const relayerKeyAddress =
      this.runtimeConfig.POLYMARKET_RELAYER_KEY_ADDRESS ||
      this.status.apiKeyAddress ||
      from;
    if (!relayerKey || !relayerKeyAddress) {
      throw new Error(
        'Relayer credentials required. Set POLYMARKET_RELAYER_KEY and POLYMARKET_RELAYER_KEY_ADDRESS in .env. Get these from Polymarket -> Settings -> Relayer API Keys.'
      );
    }

    logger.info('Deploying Safe before redeem', {
      signer: from,
      safeAddress,
    });

    const signature = await this.signerWallet._signTypedData(
      {
        name: SAFE_FACTORY_NAME,
        chainId: this.runtimeConfig.chainId,
        verifyingContract: SAFE_FACTORY_ADDRESS,
      },
      {
        CreateProxy: [
          { name: 'paymentToken', type: 'address' },
          { name: 'payment', type: 'uint256' },
          { name: 'paymentReceiver', type: 'address' },
        ],
      },
      {
        paymentToken: ZERO_ADDRESS,
        payment: '0',
        paymentReceiver: ZERO_ADDRESS,
      }
    );

    const response = await this.fetchImpl(new URL('/submit', `${this.relayerUrl}/`), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        RELAYER_API_KEY: relayerKey,
        RELAYER_API_KEY_ADDRESS: relayerKeyAddress,
      },
      body: JSON.stringify({
        from,
        to: SAFE_FACTORY_ADDRESS,
        proxyWallet: safeAddress,
        data: '0x',
        signature,
        signatureParams: {
          paymentToken: ZERO_ADDRESS,
          payment: '0',
          paymentReceiver: ZERO_ADDRESS,
        },
        type: 'SAFE-CREATE',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Safe deploy submit failed with ${response.status} ${response.statusText}: ${body || 'empty body'}`
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const transactionId = normalizeOptionalString(
      payload.transactionID ?? payload.transactionId
    );
    if (!transactionId) {
      throw new Error('Safe deploy did not return transactionID.');
    }

    const result = await this.relayClient?.pollUntilState(
      transactionId,
      ['STATE_MINED', 'STATE_CONFIRMED'],
      'STATE_FAILED',
      MAX_RELAYER_POLL_COUNT
    );
    if (!result) {
      throw new Error('Safe deploy did not reach STATE_MINED/STATE_CONFIRMED.');
    }
  }

  private async estimateProxyGasLimit(
    signerWallet: ethers.Wallet,
    to: string,
    from: string,
    data: string
  ): Promise<ethers.BigNumber> {
    try {
      return await signerWallet.estimateGas({
        from,
        to,
        data,
      });
    } catch (error) {
      logger.warn('Could not estimate proxy redeem gas, using fallback gas limit', {
        message: getErrorMessage(error),
      });
      return DEFAULT_PROXY_GAS_LIMIT;
    }
  }

  private wasRecentlyRedeemed(conditionId: string): boolean {
    const lastRedeemedAt = this.recentlyRedeemed.get(conditionId);
    return lastRedeemedAt !== undefined && this.now() - lastRedeemedAt < RECENT_REDEEM_TTL_MS;
  }

  private pruneRecentlyRedeemed(): void {
    const now = this.now();
    for (const [conditionId, redeemedAt] of this.recentlyRedeemed.entries()) {
      if (now - redeemedAt > RECENT_REDEEM_TTL_MS) {
        this.recentlyRedeemed.delete(conditionId);
      }
    }
  }

  private logRedeemLine(
    status: 'REDEEMED' | 'FAILED' | 'SKIPPED',
    entry: {
      conditionId: string;
      title: string;
      detail: string;
    }
  ): void {
    const timestamp = new Date(this.now());
    writeRedeemLog(
      `[${formatLogTimestamp(timestamp)}] status=${status} conditionId=${entry.conditionId} title="${sanitizeInlineText(
        entry.title
      )}" ${entry.detail}`,
      timestamp.getTime()
    );
  }
}

export function resolveAutoRedeemerStatus(
  runtimeConfig: AppConfig,
  signerAddress?: string
): RedeemerStatus {
  if (!runtimeConfig.AUTO_REDEEM) {
    return {
      enabled: false,
      reason: 'AUTO_REDEEM=false',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  if (isDryRunMode(runtimeConfig)) {
    return {
      enabled: false,
      reason: 'disabled in SIMULATION_MODE / TEST_MODE / DRY_RUN',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  if (runtimeConfig.auth.mode !== 'PROXY') {
    return {
      enabled: false,
      reason: 'auto redeem is only enabled in PROXY mode',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  if (!runtimeConfig.signerPrivateKey || !signerAddress) {
    return {
      enabled: false,
      reason: 'missing signer private key',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  if (!runtimeConfig.auth.funderAddress) {
    return {
      enabled: false,
      reason: 'missing FUNDER_ADDRESS for proxy wallet position polling',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  if (!runtimeConfig.POLYMARKET_RELAYER_KEY && !runtimeConfig.POLYMARKET_API_KEY) {
    return {
      enabled: false,
      reason: 'missing POLYMARKET_RELAYER_KEY (or POLYMARKET_API_KEY fallback) for relayer submit',
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }

  try {
    return {
      enabled: true,
      reason: 'enabled',
      relayTxType:
        runtimeConfig.auth.signatureType === 2 ? RelayerTxType.SAFE : RelayerTxType.PROXY,
      positionsUser: ethers.utils.getAddress(runtimeConfig.auth.funderAddress),
      apiKeyAddress: ethers.utils.getAddress(
        runtimeConfig.POLYMARKET_RELAYER_KEY_ADDRESS ||
          runtimeConfig.POLYMARKET_API_KEY_ADDRESS ||
          signerAddress
      ),
    };
  } catch (error: any) {
    return {
      enabled: false,
      reason: `invalid proxy/API key address configuration: ${error?.message || 'Unknown error'}`,
      relayTxType: null,
      positionsUser: null,
      apiKeyAddress: null,
    };
  }
}

export function normalizeRedeemablePosition(value: unknown): RedeemablePosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const conditionId = String(record.conditionId ?? '').trim();
  const asset = String(record.asset ?? '').trim();
  const title = String(record.title ?? '').trim();
  const outcome = String(record.outcome ?? '').trim();
  const size = safeFiniteNumber(record.size);
  const outcomeIndex = safeIntegerOrNull(record.outcomeIndex);
  const proxyWallet = sanitizeAddress(record.proxyWallet);
  const redeemable = Boolean(record.redeemable);
  const negativeRisk = Boolean(record.negativeRisk);
  const endDate = normalizeOptionalString(record.endDate);

  if (!isConditionId(conditionId) || !asset || size <= 0 || !redeemable) {
    return null;
  }

  return {
    conditionId,
    asset,
    title: title || conditionId,
    outcome,
    outcomeIndex,
    size,
    redeemable,
    negativeRisk,
    proxyWallet,
    endDate,
  };
}

export function groupRedeemablePositions(
  positions: readonly RedeemablePosition[]
): RedeemGroup[] {
  const groups = new Map<
    string,
    {
      title: string;
      negativeRisk: boolean;
      proxyWallet: string | null;
      positionCount: number;
      totalShares: number;
      yesShares: number;
      noShares: number;
      outcomeIndexes: Set<number>;
    }
  >();

  for (const position of positions) {
    if (!position.redeemable || position.size <= 0) {
      continue;
    }

    const existing = groups.get(position.conditionId) ?? {
      title: position.title || position.conditionId,
      negativeRisk: position.negativeRisk,
      proxyWallet: position.proxyWallet,
      positionCount: 0,
      totalShares: 0,
      yesShares: 0,
      noShares: 0,
      outcomeIndexes: new Set<number>(),
    };

    existing.positionCount += 1;
    existing.totalShares += position.size;
    existing.negativeRisk = existing.negativeRisk || position.negativeRisk;
    existing.title = existing.title || position.title || position.conditionId;
    existing.proxyWallet = existing.proxyWallet ?? position.proxyWallet;

    if (position.outcomeIndex === 0) {
      existing.yesShares += position.size;
      existing.outcomeIndexes.add(0);
    } else if (position.outcomeIndex === 1) {
      existing.noShares += position.size;
      existing.outcomeIndexes.add(1);
    }

    groups.set(position.conditionId, existing);
  }

  return Array.from(groups.entries()).map(([conditionId, group]) => ({
    conditionId,
    title: group.title,
    negativeRisk: group.negativeRisk,
    proxyWallet: group.proxyWallet,
    positionCount: group.positionCount,
    totalShares: roundTo(group.totalShares, 4),
    yesShares: roundTo(group.yesShares, 4),
    noShares: roundTo(group.noShares, 4),
    outcomeIndexes: Array.from(group.outcomeIndexes.values()).sort((left, right) => left - right),
  }));
}

export function buildRedeemTransaction(
  group: RedeemGroup,
  runtimeConfig: AppConfig
): Transaction | null {
  if (!isConditionId(group.conditionId)) {
    return null;
  }

  if (group.negativeRisk) {
    const amounts = [toTokenAmount(group.yesShares), toTokenAmount(group.noShares)];
    if (amounts.every((amount) => amount.isZero())) {
      return null;
    }

    return {
      to: runtimeConfig.contracts.negRiskAdapter,
      data: NEG_RISK_ADAPTER_INTERFACE.encodeFunctionData('redeemPositions', [
        group.conditionId,
        amounts,
      ]),
      value: '0',
    };
  }

  if (group.outcomeIndexes.some((index) => index !== 0 && index !== 1)) {
    return null;
  }

  return {
    to: runtimeConfig.contracts.ctf,
    data: CTF_INTERFACE.encodeFunctionData('redeemPositions', [
      runtimeConfig.contracts.usdc,
      ethers.constants.HashZero,
      group.conditionId,
      [1, 2],
    ]),
    value: '0',
  };
}

function toTokenAmount(size: number): ethers.BigNumber {
  const normalized = Number.isFinite(size) && size > 0 ? size : 0;
  return ethers.utils.parseUnits(normalized.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS);
}

function isConditionId(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

function safeFiniteNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function safeIntegerOrNull(value: unknown): number | null {
  const numeric = safeFiniteNumber(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function sanitizeAddress(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }
  try {
    return ethers.utils.getAddress(normalized);
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function deriveProxyWallet(address: string, proxyFactory: string): string {
  const salt = ethers.utils.keccak256(ethers.utils.solidityPack(['address'], [address]));
  return ethers.utils.getCreate2Address(proxyFactory, salt, PROXY_INIT_CODE_HASH);
}

function deriveSafe(address: string, safeFactory: string): string {
  const salt = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address'], [address])
  );
  return ethers.utils.getCreate2Address(safeFactory, salt, SAFE_INIT_CODE_HASH);
}

function packSafeSignature(signature: string): string {
  const split = ethers.utils.splitSignature(signature);
  let adjustedV = split.v;
  if (adjustedV === 0 || adjustedV === 1) {
    adjustedV += 31;
  } else if (adjustedV === 27 || adjustedV === 28) {
    adjustedV += 4;
  } else {
    throw new Error(`Invalid signature v value: ${adjustedV}`);
  }

  return ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(split.r, 32),
    ethers.utils.hexZeroPad(split.s, 32),
    ethers.utils.hexZeroPad(ethers.utils.hexlify(adjustedV), 1),
  ]);
}

function hexZeroPadNumber(value: string): string {
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(ethers.BigNumber.from(value)), 32);
}
