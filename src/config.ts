import dotenv from 'dotenv';
import { parseBooleanLoose, sanitizeConditionIds } from './utils.js';

export type AuthMode = 'EOA' | 'PROXY';
export type SignatureType = 0 | 1 | 2;
export type OrderMode = 'GTC' | 'FOK' | 'FAK';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type OrderUrgency = 'passive' | 'improve' | 'cross';

export interface PriceMultiplierLevel {
  readonly maxPrice: number;
  readonly multiplier: number;
}

export interface AppConfig {
  readonly SIMULATION_MODE: boolean;
  readonly TEST_MODE: boolean;
  readonly DRY_RUN: boolean;
  readonly ENABLE_SIGNAL: boolean;
  readonly WHITELIST_CONDITION_IDS: readonly string[];
  readonly signerPrivateKey: string;
  readonly polymarketGeoToken: string;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly auth: {
    readonly mode: AuthMode;
    readonly signatureType?: SignatureType;
    readonly funderAddress: string;
  };
  readonly contracts: {
    readonly exchange: string;
    readonly ctf: string;
    readonly usdc: string;
    readonly negRiskAdapter: string;
    readonly negRiskExchange: string;
  };
  readonly clob: {
    readonly host: string;
    readonly wsUrl: string;
    readonly gammaUrl: string;
    readonly bookDepthLevels: number;
    readonly snapshotRefreshMs: number;
    readonly initialDump: boolean;
  };
  readonly strategy: {
    readonly minCombinedDiscount: number;
    readonly extremeSellThreshold: number;
    readonly extremeBuyThreshold: number;
    readonly fairValueBuyThreshold: number;
    readonly fairValueSellThreshold: number;
    readonly trailingTakeProfit: number;
    readonly hardStopLoss: number;
    readonly minShares: number;
    readonly maxShares: number;
    readonly baseOrderShares: number;
    readonly maxNetYes: number;
    readonly maxNetNo: number;
    readonly inventoryImbalanceThreshold: number;
    readonly inventoryRebalanceFraction: number;
    readonly minLiquidityUsd: number;
    readonly sizeLiquidityCapUsd: number;
    readonly depthReferenceShares: number;
    readonly capitalReferenceShares: number;
    readonly maxSignalsPerTick: number;
    readonly priceMultiplierLevels: readonly PriceMultiplierLevel[];
    readonly exitBeforeEndMs: number;
  };
  readonly trading: {
    readonly slippageTolerance: number;
    readonly orderType: OrderMode;
    readonly orderTypeFallback: 'GTC' | 'NONE';
    readonly defaultPostOnly: boolean;
    readonly retryAttempts: number;
    readonly rateLimitMs: number;
    readonly passiveTicks: number;
    readonly improveTicks: number;
    readonly crossTicks: number;
  };
  readonly runtime: {
    readonly marketScanIntervalMs: number;
    readonly maxConcurrentMarkets: number;
    readonly marketQueryLimit: number;
    readonly onlyFiveMinuteMarkets: boolean;
    readonly gracefulShutdownTimeoutMs: number;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly directory: string;
    readonly logToFile: boolean;
  };
}

const DEFAULT_WHITELIST_CONDITION_IDS = [
  '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
  '0x3756c929609555f5b6cd8a8231d083400ea92397873fcd5ca24182186766e2e7',
  '0x353c312ca497e5a3717cff6e2c9e726990b19d12ef4f92f0d3d08817e5191a5e',
  '0x934b2c51f64502b5bd57c9dfe53bfeac741670c4f75087f3fa6ac896c4f93df2',
  '0xfedc9d713e247326bc6b670892972d1a695ff55be3d537e84f1931a1ca8a14b2',
  '0xf24222bdbd20e5f8d4b7a87e0819fd59f01ac03a674f82e0313d4bcbb85ced4b',
  '0x640ca566076f4d2d1347de0ec5dd4e80adf30d4080cec3d41c97f89e8224fbc8',
  '0xd258957f8f3a02378595e4cc6f1008475b0735b2bb54a7ee183a47d6366f2eb9',
  '0x2a626f38a60c757f1075cbfc822de66d9695c63696ac91723cf954b5fa349759',
  '0x240b5f2c500401a38e89d5c55552cffc2fdde3693d975248cb1857cd0b93dd22',
  '0xf0e5ad608f1ace28b7e97d30a261f30148eb0ee4ace84749fc450a245fff6c34',
  '0x25eb2598ab563785f8181aa0ab46598d83aa36720cc3c988b4f841c91c6445fc',
  '0x5a8f6fb58fbc41595923b86b8f04f6955eb440cbf2b7e28091ddeb3e7843d953',
  '0xa2cad512d328f85d05bbc659509eb9a51ee6671cfabf8535440d43ff03a92bd9',
  '0x5d09131387b023b28ba95c5b27647dd31a5db413b75fb0c5309f9e11746d6112',
] as const;

let dotenvLoaded = false;
let configCache: AppConfig | undefined;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  return parseBooleanLoose(value, fallback);
}

function parseFloatOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseFloat(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : Number.parseFloat(fallback);
}

function parseIntOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(parsed) ? parsed : Number.parseInt(fallback, 10);
}

function parseCsv(value?: string): string[] {
  return sanitizeConditionIds(
    !value
      ? []
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
  );
}

function parseAuthMode(value?: string): AuthMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'EOA') {
    return 'EOA';
  }
  if (normalized === 'PROXY') {
    return 'PROXY';
  }
  throw new Error(`Invalid AUTH_MODE: ${value}. Expected EOA or PROXY.`);
}

function parseSignatureType(value?: string): SignatureType | undefined {
  if (!value || value.trim() === '') {
    return undefined;
  }

  if (value === '0' || value === '1' || value === '2') {
    return Number.parseInt(value, 10) as SignatureType;
  }

  throw new Error(`Invalid SIGNATURE_TYPE: ${value}. Expected 0, 1, or 2.`);
}

function parseOrderMode(value?: string): OrderMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'GTC') {
    return 'GTC';
  }
  if (normalized === 'FOK' || normalized === 'FAK') {
    return normalized;
  }
  throw new Error(`Invalid ORDER_TYPE: ${value}. Expected GTC, FOK, or FAK.`);
}

function parseLogLevel(value?: string): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }
  return 'info';
}

function parsePriceMultiplierLevels(value?: string): PriceMultiplierLevel[] {
  const raw =
    value?.trim() ||
    '0.20:1.65,0.35:1.35,0.50:1.15,0.70:1.00,1.00:0.85';

  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [price, multiplier] = entry.split(':').map((part) => part.trim());
      const maxPrice = Number.parseFloat(price);
      const valueMultiplier = Number.parseFloat(multiplier);
      if (!Number.isFinite(maxPrice) || !Number.isFinite(valueMultiplier)) {
        throw new Error(
          `Invalid PRICE_MULTIPLIER_LEVELS entry: ${entry}. Expected maxPrice:multiplier.`
        );
      }

      return {
        maxPrice,
        multiplier: valueMultiplier,
      } satisfies PriceMultiplierLevel;
    })
    .sort((left, right) => left.maxPrice - right.maxPrice);

  if (parsed.length === 0) {
    throw new Error('PRICE_MULTIPLIER_LEVELS must contain at least one level.');
  }

  return parsed;
}

function resolveSignerPrivateKey(env: NodeJS.ProcessEnv): string {
  return (
    env.SIGNER_PRIVATE_KEY ||
    env.EXECUTION_WALLET_PRIVATE_KEY ||
    env.PRIVATE_KEY ||
    ''
  ).trim();
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    SIMULATION_MODE: parseBoolean(env.SIMULATION_MODE, false),
    TEST_MODE: parseBoolean(env.TEST_MODE, false),
    DRY_RUN: parseBoolean(env.DRY_RUN, false),
    ENABLE_SIGNAL: parseBoolean(env.ENABLE_SIGNAL, true),
    WHITELIST_CONDITION_IDS: parseCsv(
      env.WHITELIST_CONDITION_IDS || DEFAULT_WHITELIST_CONDITION_IDS.join(',')
    ),
    signerPrivateKey: resolveSignerPrivateKey(env),
    polymarketGeoToken: (env.POLYMARKET_GEO_TOKEN || '').trim(),
    rpcUrl: (env.RPC_URL || 'https://polygon.drpc.org').trim(),
    chainId: parseIntOrDefault(env.CHAIN_ID, '137'),
    auth: {
      mode: parseAuthMode(env.AUTH_MODE),
      signatureType: parseSignatureType(env.SIGNATURE_TYPE),
      funderAddress: (env.FUNDER_ADDRESS || '').trim(),
    },
    contracts: {
      exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
      usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
      negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    },
    clob: {
      host: (env.CLOB_HOST || 'https://clob.polymarket.com').trim(),
      wsUrl: (
        env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
      ).trim(),
      gammaUrl: (env.GAMMA_API_URL || 'https://gamma-api.polymarket.com').trim(),
      bookDepthLevels: Math.max(1, parseIntOrDefault(env.ORDERBOOK_DEPTH_LEVELS, '5')),
      snapshotRefreshMs: Math.max(250, parseIntOrDefault(env.ORDERBOOK_REFRESH_MS, '1500')),
      initialDump: parseBoolean(env.CLOB_WS_INITIAL_DUMP, true),
    },
    strategy: {
      minCombinedDiscount: parseFloatOrDefault(env.MIN_COMBINED_DISCOUNT, '0.035'),
      extremeSellThreshold: parseFloatOrDefault(env.EXTREME_SELL_THRESHOLD, '0.74'),
      extremeBuyThreshold: parseFloatOrDefault(env.EXTREME_BUY_THRESHOLD, '0.26'),
      fairValueBuyThreshold: parseFloatOrDefault(env.FAIR_VALUE_BUY_THRESHOLD, '0.018'),
      fairValueSellThreshold: parseFloatOrDefault(env.FAIR_VALUE_SELL_THRESHOLD, '0.015'),
      trailingTakeProfit: parseFloatOrDefault(env.TRAILING_TAKE_PROFIT, '0.012'),
      hardStopLoss: parseFloatOrDefault(env.HARD_STOP_LOSS, '0.025'),
      minShares: parseFloatOrDefault(env.MIN_SHARES, '8'),
      maxShares: parseFloatOrDefault(env.MAX_SHARES, '35'),
      baseOrderShares: parseFloatOrDefault(env.BASE_ORDER_SHARES, '12'),
      maxNetYes: parseFloatOrDefault(env.MAX_NET_YES, '200'),
      maxNetNo: parseFloatOrDefault(env.MAX_NET_NO, '250'),
      inventoryImbalanceThreshold: parseFloatOrDefault(
        env.INVENTORY_IMBALANCE_THRESHOLD,
        '90'
      ),
      inventoryRebalanceFraction: parseFloatOrDefault(
        env.INVENTORY_REBALANCE_FRACTION,
        '0.45'
      ),
      minLiquidityUsd: parseFloatOrDefault(env.MIN_LIQUIDITY_USD, '500'),
      sizeLiquidityCapUsd: parseFloatOrDefault(env.SIZE_LIQUIDITY_CAP_USD, '4000'),
      depthReferenceShares: parseFloatOrDefault(env.DEPTH_REFERENCE_SHARES, '180'),
      capitalReferenceShares: parseFloatOrDefault(env.CAPITAL_REFERENCE_SHARES, '120'),
      maxSignalsPerTick: Math.max(1, parseIntOrDefault(env.MAX_SIGNALS_PER_TICK, '2')),
      priceMultiplierLevels: parsePriceMultiplierLevels(env.PRICE_MULTIPLIER_LEVELS),
      exitBeforeEndMs: Math.max(0, parseIntOrDefault(env.EXIT_BEFORE_END_MS, '20000')),
    },
    trading: {
      slippageTolerance: parseFloatOrDefault(env.SLIPPAGE_TOLERANCE, '0.02'),
      orderType: parseOrderMode(env.ORDER_TYPE),
      orderTypeFallback:
        (env.ORDER_TYPE_FALLBACK || 'GTC').trim().toUpperCase() === 'NONE' ? 'NONE' : 'GTC',
      defaultPostOnly: parseBoolean(env.POST_ONLY, true),
      retryAttempts: Math.max(1, parseIntOrDefault(env.ORDER_RETRY_ATTEMPTS, '3')),
      rateLimitMs: Math.max(0, parseIntOrDefault(env.ORDER_RATE_LIMIT_MS, '350')),
      passiveTicks: Math.max(1, parseIntOrDefault(env.PASSIVE_TICKS, '1')),
      improveTicks: Math.max(1, parseIntOrDefault(env.IMPROVE_TICKS, '1')),
      crossTicks: Math.max(0, parseIntOrDefault(env.CROSS_TICKS, '0')),
    },
    runtime: {
      marketScanIntervalMs: Math.max(
        250,
        parseIntOrDefault(env.MARKET_SCAN_INTERVAL_MS, '2500')
      ),
      maxConcurrentMarkets: Math.max(1, parseIntOrDefault(env.MAX_CONCURRENT_MARKETS, '6')),
      marketQueryLimit: Math.max(1, parseIntOrDefault(env.MARKET_QUERY_LIMIT, '80')),
      onlyFiveMinuteMarkets: parseBoolean(env.ONLY_FIVE_MINUTE_MARKETS, true),
      gracefulShutdownTimeoutMs: Math.max(
        1000,
        parseIntOrDefault(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, '12000')
      ),
    },
    logging: {
      level: parseLogLevel(env.LOG_LEVEL),
      directory: (env.LOG_DIRECTORY || 'logs').trim(),
      logToFile: parseBoolean(env.LOG_TO_FILE, true),
    },
  };
}

export function getConfig(): AppConfig {
  if (!configCache) {
    if (!dotenvLoaded) {
      dotenv.config();
      dotenvLoaded = true;
    }

    configCache = deepFreeze(createConfig()) as AppConfig;
  }

  return configCache;
}

export function resetConfigCache(): void {
  configCache = undefined;
  dotenvLoaded = false;
}

export const config: AppConfig = new Proxy({} as AppConfig, {
  get(_target, property, receiver) {
    return Reflect.get(getConfig() as object, property, receiver);
  },
  has(_target, property) {
    return property in getConfig();
  },
});

export function validateConfig(candidate: AppConfig = config): void {
  if (!isDryRunMode(candidate) && !candidate.signerPrivateKey) {
    throw new Error(
      'Missing signer private key. Set SIGNER_PRIVATE_KEY or PRIVATE_KEY for live trading.'
    );
  }

  if (candidate.auth.mode === 'PROXY' && !isDryRunMode(candidate)) {
    if (!candidate.auth.funderAddress) {
      throw new Error('FUNDER_ADDRESS is required in PROXY mode.');
    }
    if (candidate.auth.signatureType === undefined || candidate.auth.signatureType === 0) {
      throw new Error(
        'PROXY mode requires SIGNATURE_TYPE to be set to 1 (POLY_PROXY) or 2 (GNOSIS_SAFE).'
      );
    }
  }

  if (candidate.strategy.minShares <= 0 || candidate.strategy.maxShares <= 0) {
    throw new Error('MIN_SHARES and MAX_SHARES must be positive.');
  }

  if (candidate.strategy.maxShares < candidate.strategy.minShares) {
    throw new Error('MAX_SHARES must be greater than or equal to MIN_SHARES.');
  }

  if (candidate.strategy.baseOrderShares <= 0) {
    throw new Error('BASE_ORDER_SHARES must be positive.');
  }

  if (candidate.strategy.maxNetYes <= 0 || candidate.strategy.maxNetNo <= 0) {
    throw new Error('MAX_NET_YES and MAX_NET_NO must be positive.');
  }

  if (candidate.strategy.inventoryImbalanceThreshold <= 0) {
    throw new Error('INVENTORY_IMBALANCE_THRESHOLD must be positive.');
  }

  if (
    candidate.strategy.inventoryRebalanceFraction <= 0 ||
    candidate.strategy.inventoryRebalanceFraction > 1
  ) {
    throw new Error('INVENTORY_REBALANCE_FRACTION must be in the range (0, 1].');
  }

  if (candidate.strategy.maxSignalsPerTick < 1 || candidate.strategy.maxSignalsPerTick > 10) {
    throw new Error('MAX_SIGNALS_PER_TICK must be between 1 and 10.');
  }
}

export function isDryRunMode(candidate: AppConfig = config): boolean {
  return candidate.SIMULATION_MODE || candidate.TEST_MODE || candidate.DRY_RUN;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }

  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }

  return value;
}
