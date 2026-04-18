/**
 * Settings loader — bridges config/bot-config.jsonc → process.env.
 *
 * Imported once at the very top of each runtime entrypoint (src/index.ts,
 * cli/index.ts) BEFORE any `import` that reads process.env or config.
 *
 * Precedence (lowest → highest):
 *   1. src/config.ts defaults
 *   2. .env (legacy, read lazily by dotenv inside src/config.ts)
 *   3. config/bot-config.jsonc  (this loader populates process.env; never
 *                                overwrites already-set vars)
 *   4. Real process.env (shell exports — always win because we never overwrite)
 *
 * Behaviour
 *   - Missing jsonc → silently no-op (legacy .env continues to work).
 *   - Malformed jsonc → logs to stderr and continues; do not halt startup
 *     because operators sometimes edit the file by hand.
 *   - Comments: line `//` and block /* *\/ are stripped before JSON.parse.
 *   - Trailing commas: NOT supported — keep the file valid JSON after
 *     comment stripping. The example template is hand-authored clean.
 *
 * Side effect: calls once on import and caches result on `globalThis` so
 * repeated imports (test files, CLI + main) are idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOADER_FLAG = '__polymarket_hft_settings_loaded__';
const ENV_PATH_OVERRIDE = process.env.BOT_CONFIG_PATH;
const DEFAULT_FILENAME = 'bot-config.jsonc';

type Primitive = string | number | boolean | null;
type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };

interface SettingsFile {
  readonly version?: string;
  readonly mode?: Record<string, JsonValue>;
  readonly auth?: {
    authMode?: string;
    signatureType?: number | string;
    signerPrivateKey?: string;
    funderAddress?: string;
    clob?: {
      apiKey?: string;
      apiSecret?: string;
      apiPassphrase?: string;
      apiKeyAddress?: string;
    };
    relayer?: {
      key?: string;
      keyAddress?: string;
    };
  };
  readonly polymarket?: Record<string, JsonValue>;
  readonly contracts?: {
    ctf?: string;
    negRiskAdapter?: string;
    v1?: Record<string, string>;
    v2?: Record<string, string>;
  };
  readonly market?: Record<string, JsonValue>;
  readonly risk?: Record<string, JsonValue>;
  readonly strategy?: Record<string, JsonValue>;
  readonly binance?: Record<string, JsonValue>;
  readonly execution?: Record<string, JsonValue>;
  readonly sizing?: Record<string, JsonValue>;
  readonly compounding?: Record<string, JsonValue>;
  readonly entryGuards?: Record<string, JsonValue>;
  readonly latency?: Record<string, JsonValue>;
  readonly logging?: Record<string, JsonValue>;
  readonly monitoring?: Record<string, JsonValue>;
  readonly productTest?: Record<string, JsonValue>;
  readonly dashboard?: Record<string, JsonValue>;
  readonly extraEnv?: Record<string, Primitive>;
}

/**
 * Map from structured JSONC paths → env var names used by src/config.ts.
 * Keep this in sync with bot-config.example.jsonc comments.
 */
const STRUCTURED_TO_ENV: ReadonlyArray<readonly [string, string]> = [
  // mode
  ['mode.simulation', 'SIMULATION_MODE'],
  ['mode.dryRun', 'DRY_RUN'],
  ['mode.testMode', 'TEST_MODE'],
  ['mode.productTest', 'PRODUCT_TEST_MODE'],
  ['mode.paperTrading', 'PAPER_TRADING_ENABLED'],
  ['mode.enableSignal', 'ENABLE_SIGNAL'],

  // auth (secrets)
  ['auth.authMode', 'AUTH_MODE'],
  ['auth.signatureType', 'SIGNATURE_TYPE'],
  ['auth.signerPrivateKey', 'SIGNER_PRIVATE_KEY'],
  ['auth.funderAddress', 'FUNDER_ADDRESS'],
  ['auth.clob.apiKey', 'POLYMARKET_API_KEY'],
  ['auth.clob.apiSecret', 'POLYMARKET_API_SECRET'],
  ['auth.clob.apiPassphrase', 'POLYMARKET_API_PASSPHRASE'],
  ['auth.clob.apiKeyAddress', 'POLYMARKET_API_KEY_ADDRESS'],
  ['auth.relayer.key', 'POLYMARKET_RELAYER_KEY'],
  ['auth.relayer.keyAddress', 'POLYMARKET_RELAYER_KEY_ADDRESS'],

  // polymarket infrastructure
  ['polymarket.apiVersion', 'CLOB_API_VERSION'],
  ['polymarket.clobHost', 'CLOB_HOST'],
  ['polymarket.clobHostV2', 'CLOB_HOST_V2'],
  ['polymarket.clobWsUrl', 'CLOB_WS_URL'],
  ['polymarket.gammaApiUrl', 'GAMMA_API_URL'],
  ['polymarket.relayerUrl', 'POLYMARKET_RELAYER_URL'],
  ['polymarket.rpcUrl', 'RPC_URL'],
  ['polymarket.chainId', 'CHAIN_ID'],
  ['polymarket.geoToken', 'POLYMARKET_GEO_TOKEN'],
  ['polymarket.useKeysetPagination', 'GAMMA_USE_KEYSET_PAGINATION'],
  ['polymarket.orderBookDepthLevels', 'ORDERBOOK_DEPTH_LEVELS'],
  ['polymarket.orderBookRefreshMs', 'ORDERBOOK_REFRESH_MS'],
  ['polymarket.clobWsInitialDump', 'CLOB_WS_INITIAL_DUMP'],

  // contracts — v1 is default, v2 fields get their own keys
  ['contracts.ctf', 'POLY_CTF_ADDRESS'],
  ['contracts.negRiskAdapter', 'POLY_NEG_RISK_ADAPTER_ADDRESS'],
  ['contracts.v1.exchange', 'POLY_EXCHANGE_ADDRESS'],
  ['contracts.v1.negRiskExchange', 'POLY_NEG_RISK_EXCHANGE_ADDRESS'],
  ['contracts.v1.collateral', 'POLY_COLLATERAL_ADDRESS'],
  ['contracts.v2.exchange', 'POLY_EXCHANGE_V2_ADDRESS'],
  ['contracts.v2.negRiskExchange', 'POLY_NEG_RISK_EXCHANGE_V2_ADDRESS'],
  ['contracts.v2.collateral', 'POLY_PUSD_ADDRESS'],
  ['contracts.v2.collateralOnramp', 'POLY_COLLATERAL_ONRAMP_ADDRESS'],

  // market
  ['market.coinsToTrade', 'COINS_TO_TRADE'],
  ['market.filter5MinOnly', 'FILTER_5MIN_ONLY'],
  ['market.minLiquidityUsd', 'MIN_LIQUIDITY_USD'],
  ['market.whitelistConditionIds', 'WHITELIST_CONDITION_IDS'],
  ['market.scanIntervalMs', 'MARKET_SCAN_INTERVAL_MS'],
  ['market.maxConcurrentMarkets', 'MAX_CONCURRENT_MARKETS'],
  ['market.queryLimit', 'MARKET_QUERY_LIMIT'],

  // risk
  ['risk.maxDrawdownUsdc', 'MAX_DRAWDOWN_USDC'],
  ['risk.globalMaxExposureUsd', 'GLOBAL_MAX_EXPOSURE_USD'],
  ['risk.hardStopLoss', 'HARD_STOP_LOSS'],
  ['risk.hardStopCooldownMs', 'HARD_STOP_COOLDOWN_MS'],
  ['risk.trailingTakeProfit', 'TRAILING_TAKE_PROFIT'],
  ['risk.slippageTolerance', 'SLIPPAGE_TOLERANCE'],
  ['risk.sizeLiquidityCapUsd', 'SIZE_LIQUIDITY_CAP_USD'],

  // strategy
  ['strategy.active', 'ACTIVE_STRATEGY'],
  ['strategy.entryStrategy', 'ENTRY_STRATEGY'],
  ['strategy.marketMakerMode', 'MARKET_MAKER_MODE'],
  ['strategy.sniperEnabled', 'SNIPER_MODE_ENABLED'],
  ['strategy.pairedArbEnabled', 'PAIRED_ARB_ENABLED'],
  ['strategy.latencyMomentumEnabled', 'LATENCY_MOMENTUM_ENABLED'],
  ['strategy.orderBookImbalanceEnabled', 'ORDER_BOOK_IMBALANCE_ENABLED'],
  ['strategy.obiEngineEnabled', 'OBI_ENGINE_ENABLED'],
  ['strategy.lotteryLayerEnabled', 'LOTTERY_LAYER_ENABLED'],
  ['strategy.regimeFilterEnabled', 'REGIME_FILTER_ENABLED'],
  ['strategy.autoRedeem', 'AUTO_REDEEM'],

  // binance
  ['binance.edgeEnabled', 'BINANCE_EDGE_ENABLED'],
  ['binance.wsEnabled', 'BINANCE_WS_ENABLED'],
  ['binance.symbols', 'BINANCE_SYMBOLS'],
  ['binance.flatThreshold', 'BINANCE_FLAT_THRESHOLD'],
  ['binance.strongThreshold', 'BINANCE_STRONG_THRESHOLD'],
  ['binance.boostMultiplier', 'BINANCE_BOOST_MULTIPLIER'],
  ['binance.reduceMultiplier', 'BINANCE_REDUCE_MULTIPLIER'],
  ['binance.blockStrongContra', 'BINANCE_BLOCK_STRONG_CONTRA'],
  ['binance.fvSensitivity', 'BINANCE_FV_SENSITIVITY'],
  ['binance.deepMode', 'DEEP_BINANCE_MODE'],
  ['binance.depthLevels', 'BINANCE_DEPTH_LEVELS'],
  ['binance.fundingWeight', 'BINANCE_FUNDING_WEIGHT'],
  ['binance.fairValueWeight', 'BINANCE_FAIR_VALUE_WEIGHT'],
  ['binance.fvDecayWindowMs', 'BINANCE_FV_DECAY_WINDOW_MS'],
  ['binance.fvDecayMinMultiplier', 'BINANCE_FV_DECAY_MIN_MULTIPLIER'],
  ['binance.wsReconnectMs', 'BINANCE_WS_RECONNECT_MS'],
  ['binance.maxReconnectAttempts', 'BINANCE_MAX_RECONNECT'],

  // execution
  ['execution.orderType', 'ORDER_TYPE'],
  ['execution.orderTypeFallback', 'ORDER_TYPE_FALLBACK'],
  ['execution.postOnly', 'POST_ONLY'],
  ['execution.postOnlyOnly', 'POST_ONLY_ONLY'],
  ['execution.orderRetryAttempts', 'ORDER_RETRY_ATTEMPTS'],
  ['execution.orderRateLimitMs', 'ORDER_RATE_LIMIT_MS'],
  ['execution.passiveTicks', 'PASSIVE_TICKS'],
  ['execution.improveTicks', 'IMPROVE_TICKS'],
  ['execution.crossTicks', 'CROSS_TICKS'],
  ['execution.fillPollIntervalMs', 'FILL_POLL_INTERVAL_MS'],
  ['execution.fillPollTimeoutMs', 'FILL_POLL_TIMEOUT_MS'],
  ['execution.fillCancelBeforeEndMs', 'FILL_CANCEL_BEFORE_END_MS'],
  ['execution.balanceCacheTtlMs', 'BALANCE_CACHE_TTL_MS'],
  ['execution.sellAfterFillDelayMs', 'SELL_AFTER_FILL_DELAY_MS'],
  ['execution.exitBeforeEndMs', 'EXIT_BEFORE_END_MS'],

  // sizing
  ['sizing.minShares', 'MIN_SHARES'],
  ['sizing.maxShares', 'MAX_SHARES'],
  ['sizing.baseOrderShares', 'BASE_ORDER_SHARES'],
  ['sizing.maxNetYes', 'MAX_NET_YES'],
  ['sizing.maxNetNo', 'MAX_NET_NO'],
  ['sizing.inventoryImbalanceThreshold', 'INVENTORY_IMBALANCE_THRESHOLD'],
  ['sizing.inventoryRebalanceFraction', 'INVENTORY_REBALANCE_FRACTION'],
  ['sizing.depthReferenceShares', 'DEPTH_REFERENCE_SHARES'],
  ['sizing.capitalReferenceShares', 'CAPITAL_REFERENCE_SHARES'],

  // compounding
  ['compounding.enabled', 'COMPOUNDING_ENABLED'],
  ['compounding.baseRiskPct', 'COMPOUNDING_BASE_RISK_PCT'],
  ['compounding.maxSlotExposurePct', 'COMPOUNDING_MAX_SLOT_EXPOSURE_PCT'],
  ['compounding.globalExposurePct', 'COMPOUNDING_GLOBAL_EXPOSURE_PCT'],
  ['compounding.layerMultipliers', 'COMPOUNDING_LAYER_MULTIPLIERS'],
  ['compounding.drawdownGuardPct', 'COMPOUNDING_DRAWDOWN_GUARD_PCT'],

  // entry guards
  ['entryGuards.minEntryDepthUsd', 'MIN_ENTRY_DEPTH_USD'],
  ['entryGuards.maxEntrySpread', 'MAX_ENTRY_SPREAD'],
  ['entryGuards.maxEntrySpreadCombinedDiscount', 'MAX_ENTRY_SPREAD_COMBINED_DISCOUNT'],
  ['entryGuards.maxEntrySpreadExtreme', 'MAX_ENTRY_SPREAD_EXTREME'],
  ['entryGuards.maxEntrySpreadFairValue', 'MAX_ENTRY_SPREAD_FAIR_VALUE'],
  ['entryGuards.maxEntrySpreadRebalance', 'MAX_ENTRY_SPREAD_REBALANCE'],
  ['entryGuards.entryImbalanceBlockThreshold', 'ENTRY_IMBALANCE_BLOCK_THRESHOLD'],
  ['entryGuards.maxSignalsPerTick', 'MAX_SIGNALS_PER_TICK'],
  ['entryGuards.priceMultiplierLevels', 'PRICE_MULTIPLIER_LEVELS'],
  ['entryGuards.minCombinedDiscount', 'MIN_COMBINED_DISCOUNT'],
  ['entryGuards.extremeSellThreshold', 'EXTREME_SELL_THRESHOLD'],
  ['entryGuards.extremeBuyThreshold', 'EXTREME_BUY_THRESHOLD'],
  ['entryGuards.fairValueBuyThreshold', 'FAIR_VALUE_BUY_THRESHOLD'],
  ['entryGuards.fairValueSellThreshold', 'FAIR_VALUE_SELL_THRESHOLD'],

  // latency
  ['latency.pauseThresholdMs', 'LATENCY_PAUSE_THRESHOLD_MS'],
  ['latency.resumeThresholdMs', 'LATENCY_RESUME_THRESHOLD_MS'],
  ['latency.pauseWindowSize', 'LATENCY_PAUSE_WINDOW_SIZE'],
  ['latency.pauseSampleTtlMs', 'LATENCY_PAUSE_SAMPLE_TTL_MS'],

  // logging
  ['logging.level', 'LOG_LEVEL'],
  ['logging.toFile', 'LOG_TO_FILE'],
  ['logging.directory', 'LOG_DIRECTORY'],
  ['logging.reportsDir', 'REPORTS_DIR'],
  ['logging.reportsFilePrefix', 'REPORTS_FILE_PREFIX'],
  ['logging.stateFile', 'STATE_FILE'],
  ['logging.latencyLog', 'LATENCY_LOG'],

  // monitoring
  ['monitoring.statusCheckIntervalMs', 'STATUS_CHECK_INTERVAL_MS'],
  ['monitoring.autoPauseOnIncident', 'AUTO_PAUSE_ON_INCIDENT'],
  ['monitoring.pauseGracePeriodMs', 'PAUSE_GRACE_PERIOD_MS'],
  ['monitoring.gracefulShutdownTimeoutMs', 'GRACEFUL_SHUTDOWN_TIMEOUT_MS'],
  ['monitoring.redeemIntervalMs', 'REDEEM_INTERVAL_MS'],

  // product test
  ['productTest.minTradeUsdc', 'TEST_MIN_TRADE_USDC'],
  ['productTest.maxSlots', 'TEST_MAX_SLOTS'],

  // dashboard
  ['dashboard.enabled', 'DASHBOARD_ENABLED'],
  ['dashboard.host', 'DASHBOARD_HOST'],
  ['dashboard.port', 'DASHBOARD_PORT'],
];

function resolveRepoRoot(): string {
  // settings-loader.ts lives at src/settings-loader.ts, so repo root is one up.
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '..');
}

function resolveConfigPath(): string {
  if (ENV_PATH_OVERRIDE && ENV_PATH_OVERRIDE.trim()) {
    return path.resolve(ENV_PATH_OVERRIDE.trim());
  }
  return path.join(resolveRepoRoot(), 'config', DEFAULT_FILENAME);
}

function stripJsoncComments(source: string): string {
  // Remove /* ... */ blocks, then // ... line comments.
  // Preserves // and /* inside double-quoted strings.
  let out = '';
  let i = 0;
  const len = source.length;
  let inString = false;
  let escape = false;

  while (i < len) {
    const ch = source[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && i + 1 < len) {
      const next = source[i + 1];
      if (next === '/') {
        // line comment
        i += 2;
        while (i < len && source[i] !== '\n') i += 1;
        continue;
      }
      if (next === '*') {
        // block comment
        i += 2;
        while (i + 1 < len && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function getByPath(obj: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyEnvValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(',');
  }
  // Nested object — unsupported here; user should flatten via extraEnv.
  return null;
}

function setEnvIfAbsent(name: string, value: string | null, applied: string[]): void {
  if (value === null) return;
  if (value === '') return; // empty strings are treated as "use default" — don't set
  if (Object.prototype.hasOwnProperty.call(process.env, name) && process.env[name] !== undefined) {
    return; // real env wins
  }
  process.env[name] = value;
  applied.push(name);
}

export interface LoadSettingsResult {
  readonly loaded: boolean;
  readonly path: string;
  readonly appliedVars: readonly string[];
  readonly skippedReason?: string;
}

export function loadBotSettings(): LoadSettingsResult {
  const g = globalThis as Record<string, unknown>;
  if (g[LOADER_FLAG]) {
    return g[LOADER_FLAG] as LoadSettingsResult;
  }

  const filePath = resolveConfigPath();
  const applied: string[] = [];
  let result: LoadSettingsResult;

  if (!fs.existsSync(filePath)) {
    result = {
      loaded: false,
      path: filePath,
      appliedVars: [],
      skippedReason: 'file-not-found',
    };
    g[LOADER_FLAG] = result;
    return result;
  }

  let parsed: SettingsFile;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const stripped = stripJsoncComments(raw);
    parsed = JSON.parse(stripped) as SettingsFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[settings-loader] failed to parse ${filePath}: ${message}\n` +
        `[settings-loader] continuing with .env fallback; fix the file and restart.\n`
    );
    result = {
      loaded: false,
      path: filePath,
      appliedVars: [],
      skippedReason: `parse-error: ${message}`,
    };
    g[LOADER_FLAG] = result;
    return result;
  }

  // Structured keys
  for (const [jsonPath, envName] of STRUCTURED_TO_ENV) {
    const raw = getByPath(parsed, jsonPath);
    const value = stringifyEnvValue(raw);
    setEnvIfAbsent(envName, value, applied);
  }

  // extraEnv catch-all (always stringified)
  if (parsed.extraEnv && typeof parsed.extraEnv === 'object') {
    for (const [name, value] of Object.entries(parsed.extraEnv)) {
      const stringified = stringifyEnvValue(value);
      setEnvIfAbsent(name, stringified, applied);
    }
  }

  result = {
    loaded: true,
    path: filePath,
    appliedVars: applied,
  };
  g[LOADER_FLAG] = result;
  return result;
}

// Side-effect: populate on import.
loadBotSettings();
