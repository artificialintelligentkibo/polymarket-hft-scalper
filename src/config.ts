import dotenv from 'dotenv';

dotenv.config();

export type AuthMode = 'EOA' | 'PROXY';
export type SignatureType = 0 | 1 | 2;
export type OrderMode = 'GTC' | 'FOK' | 'FAK';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  SIMULATION_MODE: boolean;
  ENABLE_SIGNAL: boolean;
  signerPrivateKey: string;
  polymarketGeoToken: string;
  rpcUrl: string;
  chainId: number;
  auth: {
    mode: AuthMode;
    signatureType?: SignatureType;
    funderAddress: string;
  };
  contracts: {
    exchange: string;
    ctf: string;
    usdc: string;
    negRiskAdapter: string;
    negRiskExchange: string;
  };
  clob: {
    host: string;
    wsUrl: string;
    gammaUrl: string;
    bookDepthLevels: number;
    snapshotRefreshMs: number;
    initialDump: boolean;
  };
  strategy: {
    entryBuyEdge: number;
    entrySellEdge: number;
    trailingTakeProfit: number;
    hardStopLoss: number;
    minShares: number;
    maxShares: number;
    maxNetYes: number;
    maxNetNo: number;
    minLiquidityUsd: number;
    sizeLiquidityCapUsd: number;
    exitBeforeEndMs: number;
  };
  trading: {
    slippageTolerance: number;
    orderType: OrderMode;
    orderTypeFallback: 'GTC' | 'NONE';
    postOnly: boolean;
  };
  runtime: {
    marketScanIntervalMs: number;
    maxConcurrentMarkets: number;
    marketQueryLimit: number;
    onlyFiveMinuteMarkets: boolean;
  };
  logging: {
    level: LogLevel;
    directory: string;
    logToFile: boolean;
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  return value.trim().toLowerCase() === 'true';
}

function parseFloatOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseFloat(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : Number.parseFloat(fallback);
}

function parseIntOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(parsed) ? parsed : Number.parseInt(fallback, 10);
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
    ENABLE_SIGNAL: parseBoolean(env.ENABLE_SIGNAL, true),
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
      entryBuyEdge: parseFloatOrDefault(env.ENTRY_BUY_EDGE, '0.018'),
      entrySellEdge: parseFloatOrDefault(env.ENTRY_SELL_EDGE, '0.015'),
      trailingTakeProfit: parseFloatOrDefault(env.TRAILING_TAKE_PROFIT, '0.012'),
      hardStopLoss: parseFloatOrDefault(env.HARD_STOP_LOSS, '0.025'),
      minShares: parseFloatOrDefault(env.MIN_SHARES, '8'),
      maxShares: parseFloatOrDefault(env.MAX_SHARES, '35'),
      maxNetYes: parseFloatOrDefault(env.MAX_NET_YES, '65'),
      maxNetNo: parseFloatOrDefault(env.MAX_NET_NO, '-75'),
      minLiquidityUsd: parseFloatOrDefault(env.MIN_LIQUIDITY_USD, '500'),
      sizeLiquidityCapUsd: parseFloatOrDefault(env.SIZE_LIQUIDITY_CAP_USD, '2500'),
      exitBeforeEndMs: Math.max(0, parseIntOrDefault(env.EXIT_BEFORE_END_MS, '20000')),
    },
    trading: {
      slippageTolerance: parseFloatOrDefault(env.SLIPPAGE_TOLERANCE, '0.02'),
      orderType: parseOrderMode(env.ORDER_TYPE),
      orderTypeFallback:
        (env.ORDER_TYPE_FALLBACK || 'GTC').trim().toUpperCase() === 'NONE' ? 'NONE' : 'GTC',
      postOnly: parseBoolean(env.POST_ONLY, false),
    },
    runtime: {
      marketScanIntervalMs: Math.max(
        250,
        parseIntOrDefault(env.MARKET_SCAN_INTERVAL_MS, '2500')
      ),
      maxConcurrentMarkets: Math.max(1, parseIntOrDefault(env.MAX_CONCURRENT_MARKETS, '6')),
      marketQueryLimit: Math.max(1, parseIntOrDefault(env.MARKET_QUERY_LIMIT, '80')),
      onlyFiveMinuteMarkets: parseBoolean(env.ONLY_FIVE_MINUTE_MARKETS, true),
    },
    logging: {
      level: parseLogLevel(env.LOG_LEVEL),
      directory: (env.LOG_DIRECTORY || 'logs').trim(),
      logToFile: parseBoolean(env.LOG_TO_FILE, true),
    },
  };
}

export const config = createConfig();

export function validateConfig(candidate: AppConfig = config): void {
  if (!candidate.SIMULATION_MODE && !candidate.signerPrivateKey) {
    throw new Error(
      'Missing signer private key. Set SIGNER_PRIVATE_KEY or PRIVATE_KEY for live trading.'
    );
  }

  if (candidate.auth.mode === 'PROXY' && !candidate.SIMULATION_MODE) {
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

  if (candidate.strategy.maxNetYes <= 0) {
    throw new Error('MAX_NET_YES must be positive.');
  }

  if (candidate.strategy.maxNetNo >= 0) {
    throw new Error('MAX_NET_NO must be negative.');
  }
}
