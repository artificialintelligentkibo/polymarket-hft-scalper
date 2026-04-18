#!/usr/bin/env tsx
/**
 * Migrate legacy .env → config/bot-config.jsonc.
 *
 * Usage:
 *   npx tsx scripts/migrate-env-to-config.ts              # read .env, write config/bot-config.jsonc
 *   npx tsx scripts/migrate-env-to-config.ts --source .env.live --out config/bot-config.jsonc
 *   npx tsx scripts/migrate-env-to-config.ts --dry-run    # print diff, do not write
 *
 * Behaviour
 *   - Reads the template at config/bot-config.example.jsonc to know which
 *     structured keys exist.
 *   - Maps known env vars into structured sections; unknown vars go to
 *     `extraEnv`.
 *   - Never overwrites an existing config/bot-config.jsonc unless --force
 *     is passed. Default: refuses and tells user to delete it first.
 *   - Prints a summary of variables mapped + skipped.
 *
 * After migration: review the generated file, chmod 600 it on Unix,
 * and restart the bot. The legacy .env becomes optional.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Args {
  readonly source: string;
  readonly out: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let source = path.join(repoRoot, '.env');
  let out = path.join(repoRoot, 'config', 'bot-config.jsonc');
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source':
        source = path.resolve(argv[i + 1]);
        i += 1;
        break;
      case '--out':
        out = path.resolve(argv[i + 1]);
        i += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown argument: ${arg}\n`);
        printHelp();
        process.exit(2);
    }
  }

  return { source, out, dryRun, force };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: migrate-env-to-config.ts [options]\n\n` +
      `  --source <path>   input .env file (default: ./.env)\n` +
      `  --out <path>      output jsonc (default: ./config/bot-config.jsonc)\n` +
      `  --dry-run         print result, do not write\n` +
      `  --force           overwrite existing --out\n` +
      `  -h, --help        show this help\n`
  );
}

function parseEnvFile(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result.set(key, value);
  }
  return result;
}

// Inverse of STRUCTURED_TO_ENV in src/settings-loader.ts.
// Keep in sync when adding new structured keys there.
const ENV_TO_PATH: Record<string, string> = {
  SIMULATION_MODE: 'mode.simulation',
  DRY_RUN: 'mode.dryRun',
  TEST_MODE: 'mode.testMode',
  PRODUCT_TEST_MODE: 'mode.productTest',
  PAPER_TRADING_ENABLED: 'mode.paperTrading',
  ENABLE_SIGNAL: 'mode.enableSignal',

  AUTH_MODE: 'auth.authMode',
  SIGNATURE_TYPE: 'auth.signatureType',
  SIGNER_PRIVATE_KEY: 'auth.signerPrivateKey',
  FUNDER_ADDRESS: 'auth.funderAddress',
  POLYMARKET_API_KEY: 'auth.clob.apiKey',
  POLYMARKET_API_SECRET: 'auth.clob.apiSecret',
  POLYMARKET_API_PASSPHRASE: 'auth.clob.apiPassphrase',
  POLYMARKET_API_KEY_ADDRESS: 'auth.clob.apiKeyAddress',
  POLYMARKET_RELAYER_KEY: 'auth.relayer.key',
  POLYMARKET_RELAYER_KEY_ADDRESS: 'auth.relayer.keyAddress',

  CLOB_API_VERSION: 'polymarket.apiVersion',
  CLOB_HOST: 'polymarket.clobHost',
  CLOB_HOST_V2: 'polymarket.clobHostV2',
  CLOB_WS_URL: 'polymarket.clobWsUrl',
  GAMMA_API_URL: 'polymarket.gammaApiUrl',
  POLYMARKET_RELAYER_URL: 'polymarket.relayerUrl',
  RPC_URL: 'polymarket.rpcUrl',
  CHAIN_ID: 'polymarket.chainId',
  POLYMARKET_GEO_TOKEN: 'polymarket.geoToken',
  GAMMA_USE_KEYSET_PAGINATION: 'polymarket.useKeysetPagination',
  ORDERBOOK_DEPTH_LEVELS: 'polymarket.orderBookDepthLevels',
  ORDERBOOK_REFRESH_MS: 'polymarket.orderBookRefreshMs',
  CLOB_WS_INITIAL_DUMP: 'polymarket.clobWsInitialDump',

  POLY_CTF_ADDRESS: 'contracts.ctf',
  POLY_NEG_RISK_ADAPTER_ADDRESS: 'contracts.negRiskAdapter',
  POLY_EXCHANGE_ADDRESS: 'contracts.v1.exchange',
  POLY_NEG_RISK_EXCHANGE_ADDRESS: 'contracts.v1.negRiskExchange',
  POLY_COLLATERAL_ADDRESS: 'contracts.v1.collateral',
  POLY_EXCHANGE_V2_ADDRESS: 'contracts.v2.exchange',
  POLY_NEG_RISK_EXCHANGE_V2_ADDRESS: 'contracts.v2.negRiskExchange',
  POLY_PUSD_ADDRESS: 'contracts.v2.collateral',
  POLY_COLLATERAL_ONRAMP_ADDRESS: 'contracts.v2.collateralOnramp',

  COINS_TO_TRADE: 'market.coinsToTrade',
  FILTER_5MIN_ONLY: 'market.filter5MinOnly',
  MIN_LIQUIDITY_USD: 'market.minLiquidityUsd',
  WHITELIST_CONDITION_IDS: 'market.whitelistConditionIds',
  MARKET_SCAN_INTERVAL_MS: 'market.scanIntervalMs',
  MAX_CONCURRENT_MARKETS: 'market.maxConcurrentMarkets',
  MARKET_QUERY_LIMIT: 'market.queryLimit',

  MAX_DRAWDOWN_USDC: 'risk.maxDrawdownUsdc',
  GLOBAL_MAX_EXPOSURE_USD: 'risk.globalMaxExposureUsd',
  HARD_STOP_LOSS: 'risk.hardStopLoss',
  HARD_STOP_COOLDOWN_MS: 'risk.hardStopCooldownMs',
  TRAILING_TAKE_PROFIT: 'risk.trailingTakeProfit',
  SLIPPAGE_TOLERANCE: 'risk.slippageTolerance',
  SIZE_LIQUIDITY_CAP_USD: 'risk.sizeLiquidityCapUsd',

  ACTIVE_STRATEGY: 'strategy.active',
  ENTRY_STRATEGY: 'strategy.entryStrategy',
  MARKET_MAKER_MODE: 'strategy.marketMakerMode',
  SNIPER_MODE_ENABLED: 'strategy.sniperEnabled',
  PAIRED_ARB_ENABLED: 'strategy.pairedArbEnabled',
  LATENCY_MOMENTUM_ENABLED: 'strategy.latencyMomentumEnabled',
  ORDER_BOOK_IMBALANCE_ENABLED: 'strategy.orderBookImbalanceEnabled',
  OBI_ENGINE_ENABLED: 'strategy.obiEngineEnabled',
  LOTTERY_LAYER_ENABLED: 'strategy.lotteryLayerEnabled',
  REGIME_FILTER_ENABLED: 'strategy.regimeFilterEnabled',
  AUTO_REDEEM: 'strategy.autoRedeem',

  BINANCE_EDGE_ENABLED: 'binance.edgeEnabled',
  BINANCE_WS_ENABLED: 'binance.wsEnabled',
  BINANCE_SYMBOLS: 'binance.symbols',
  BINANCE_FLAT_THRESHOLD: 'binance.flatThreshold',
  BINANCE_STRONG_THRESHOLD: 'binance.strongThreshold',
  BINANCE_BOOST_MULTIPLIER: 'binance.boostMultiplier',
  BINANCE_REDUCE_MULTIPLIER: 'binance.reduceMultiplier',
  BINANCE_BLOCK_STRONG_CONTRA: 'binance.blockStrongContra',
  BINANCE_FV_SENSITIVITY: 'binance.fvSensitivity',
  DEEP_BINANCE_MODE: 'binance.deepMode',
  BINANCE_DEPTH_LEVELS: 'binance.depthLevels',
  BINANCE_FUNDING_WEIGHT: 'binance.fundingWeight',
  BINANCE_FAIR_VALUE_WEIGHT: 'binance.fairValueWeight',
  BINANCE_FV_DECAY_WINDOW_MS: 'binance.fvDecayWindowMs',
  BINANCE_FV_DECAY_MIN_MULTIPLIER: 'binance.fvDecayMinMultiplier',
  BINANCE_WS_RECONNECT_MS: 'binance.wsReconnectMs',
  BINANCE_MAX_RECONNECT: 'binance.maxReconnectAttempts',

  ORDER_TYPE: 'execution.orderType',
  ORDER_TYPE_FALLBACK: 'execution.orderTypeFallback',
  POST_ONLY: 'execution.postOnly',
  POST_ONLY_ONLY: 'execution.postOnlyOnly',
  ORDER_RETRY_ATTEMPTS: 'execution.orderRetryAttempts',
  ORDER_RATE_LIMIT_MS: 'execution.orderRateLimitMs',
  PASSIVE_TICKS: 'execution.passiveTicks',
  IMPROVE_TICKS: 'execution.improveTicks',
  CROSS_TICKS: 'execution.crossTicks',
  FILL_POLL_INTERVAL_MS: 'execution.fillPollIntervalMs',
  FILL_POLL_TIMEOUT_MS: 'execution.fillPollTimeoutMs',
  FILL_CANCEL_BEFORE_END_MS: 'execution.fillCancelBeforeEndMs',
  BALANCE_CACHE_TTL_MS: 'execution.balanceCacheTtlMs',
  SELL_AFTER_FILL_DELAY_MS: 'execution.sellAfterFillDelayMs',
  EXIT_BEFORE_END_MS: 'execution.exitBeforeEndMs',

  MIN_SHARES: 'sizing.minShares',
  MAX_SHARES: 'sizing.maxShares',
  BASE_ORDER_SHARES: 'sizing.baseOrderShares',
  MAX_NET_YES: 'sizing.maxNetYes',
  MAX_NET_NO: 'sizing.maxNetNo',
  INVENTORY_IMBALANCE_THRESHOLD: 'sizing.inventoryImbalanceThreshold',
  INVENTORY_REBALANCE_FRACTION: 'sizing.inventoryRebalanceFraction',
  DEPTH_REFERENCE_SHARES: 'sizing.depthReferenceShares',
  CAPITAL_REFERENCE_SHARES: 'sizing.capitalReferenceShares',

  COMPOUNDING_ENABLED: 'compounding.enabled',
  COMPOUNDING_BASE_RISK_PCT: 'compounding.baseRiskPct',
  COMPOUNDING_MAX_SLOT_EXPOSURE_PCT: 'compounding.maxSlotExposurePct',
  COMPOUNDING_GLOBAL_EXPOSURE_PCT: 'compounding.globalExposurePct',
  COMPOUNDING_LAYER_MULTIPLIERS: 'compounding.layerMultipliers',
  COMPOUNDING_DRAWDOWN_GUARD_PCT: 'compounding.drawdownGuardPct',

  MIN_ENTRY_DEPTH_USD: 'entryGuards.minEntryDepthUsd',
  MAX_ENTRY_SPREAD: 'entryGuards.maxEntrySpread',
  MAX_ENTRY_SPREAD_COMBINED_DISCOUNT: 'entryGuards.maxEntrySpreadCombinedDiscount',
  MAX_ENTRY_SPREAD_EXTREME: 'entryGuards.maxEntrySpreadExtreme',
  MAX_ENTRY_SPREAD_FAIR_VALUE: 'entryGuards.maxEntrySpreadFairValue',
  MAX_ENTRY_SPREAD_REBALANCE: 'entryGuards.maxEntrySpreadRebalance',
  ENTRY_IMBALANCE_BLOCK_THRESHOLD: 'entryGuards.entryImbalanceBlockThreshold',
  MAX_SIGNALS_PER_TICK: 'entryGuards.maxSignalsPerTick',
  PRICE_MULTIPLIER_LEVELS: 'entryGuards.priceMultiplierLevels',
  MIN_COMBINED_DISCOUNT: 'entryGuards.minCombinedDiscount',
  EXTREME_SELL_THRESHOLD: 'entryGuards.extremeSellThreshold',
  EXTREME_BUY_THRESHOLD: 'entryGuards.extremeBuyThreshold',
  FAIR_VALUE_BUY_THRESHOLD: 'entryGuards.fairValueBuyThreshold',
  FAIR_VALUE_SELL_THRESHOLD: 'entryGuards.fairValueSellThreshold',

  LATENCY_PAUSE_THRESHOLD_MS: 'latency.pauseThresholdMs',
  LATENCY_RESUME_THRESHOLD_MS: 'latency.resumeThresholdMs',
  LATENCY_PAUSE_WINDOW_SIZE: 'latency.pauseWindowSize',
  LATENCY_PAUSE_SAMPLE_TTL_MS: 'latency.pauseSampleTtlMs',

  LOG_LEVEL: 'logging.level',
  LOG_TO_FILE: 'logging.toFile',
  LOG_DIRECTORY: 'logging.directory',
  REPORTS_DIR: 'logging.reportsDir',
  REPORTS_FILE_PREFIX: 'logging.reportsFilePrefix',
  STATE_FILE: 'logging.stateFile',
  LATENCY_LOG: 'logging.latencyLog',

  STATUS_CHECK_INTERVAL_MS: 'monitoring.statusCheckIntervalMs',
  AUTO_PAUSE_ON_INCIDENT: 'monitoring.autoPauseOnIncident',
  PAUSE_GRACE_PERIOD_MS: 'monitoring.pauseGracePeriodMs',
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 'monitoring.gracefulShutdownTimeoutMs',
  REDEEM_INTERVAL_MS: 'monitoring.redeemIntervalMs',

  TEST_MIN_TRADE_USDC: 'productTest.minTradeUsdc',
  TEST_MAX_SLOTS: 'productTest.maxSlots',

  DASHBOARD_ENABLED: 'dashboard.enabled',
  DASHBOARD_HOST: 'dashboard.host',
  DASHBOARD_PORT: 'dashboard.port',
};

function coerceForJson(envName: string, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // Booleans
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  // Numbers (but NOT for keys that must stay strings — e.g. chain ids, addresses)
  const numericKeys = new Set([
    'CHAIN_ID',
    'SIGNATURE_TYPE',
  ]);
  if (numericKeys.has(envName) && /^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && !/^0[xX]/.test(trimmed)) {
    const keepAsString = new Set([
      'SIGNER_PRIVATE_KEY',
      'FUNDER_ADDRESS',
      'POLYMARKET_API_KEY',
      'POLYMARKET_API_SECRET',
      'POLYMARKET_API_PASSPHRASE',
      'POLYMARKET_API_KEY_ADDRESS',
      'POLYMARKET_RELAYER_KEY',
      'POLYMARKET_RELAYER_KEY_ADDRESS',
      'POLYMARKET_GEO_TOKEN',
    ]);
    if (!keepAsString.has(envName)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
  }
  // CSV arrays for known list-style keys
  const arrayKeys = new Set(['COINS_TO_TRADE', 'WHITELIST_CONDITION_IDS']);
  if (arrayKeys.has(envName)) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

function setAtPath(root: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.');
  let current: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const existing = current[part];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function buildOutputJson(envVars: Map<string, string>): {
  config: Record<string, unknown>;
  mapped: number;
  extras: number;
} {
  const config: Record<string, unknown> = { version: '1.0.0' };
  const extraEnv: Record<string, string> = {};
  let mapped = 0;
  let extras = 0;

  for (const [name, rawValue] of envVars.entries()) {
    if (ENV_TO_PATH[name]) {
      const jsonValue = coerceForJson(name, rawValue);
      setAtPath(config, ENV_TO_PATH[name], jsonValue);
      mapped += 1;
    } else {
      extraEnv[name] = rawValue;
      extras += 1;
    }
  }

  if (Object.keys(extraEnv).length > 0) {
    config.extraEnv = extraEnv;
  }
  return { config, mapped, extras };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.source)) {
    process.stderr.write(`source file not found: ${args.source}\n`);
    process.exit(1);
  }
  if (fs.existsSync(args.out) && !args.force && !args.dryRun) {
    process.stderr.write(
      `target already exists: ${args.out}\n` +
        `refusing to overwrite without --force. Review or delete it first.\n`
    );
    process.exit(1);
  }

  const envText = fs.readFileSync(args.source, 'utf8');
  const envVars = parseEnvFile(envText);
  const { config, mapped, extras } = buildOutputJson(envVars);

  const header =
    `// Generated by scripts/migrate-env-to-config.ts\n` +
    `// Source: ${path.basename(args.source)}\n` +
    `// Generated: ${new Date().toISOString()}\n` +
    `//\n` +
    `// Review this file, especially the auth and contracts sections.\n` +
    `// After review: chmod 600 on Unix/macOS, or restrict ACL on Windows.\n` +
    `// See config/bot-config.example.jsonc for full schema documentation.\n\n`;

  const json = JSON.stringify(config, null, 2);
  const output = `${header}${json}\n`;

  process.stdout.write(
    `Read ${envVars.size} env vars from ${args.source}\n` +
      `Mapped to structured keys: ${mapped}\n` +
      `Passed through as extraEnv: ${extras}\n`
  );

  if (args.dryRun) {
    process.stdout.write(`\n--- DRY RUN: would write to ${args.out} ---\n\n`);
    process.stdout.write(output);
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, output, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(
    `\nWrote: ${args.out}\n` +
      `Permissions set to 0600 (owner read/write only).\n` +
      `\nNext steps:\n` +
      `  1. Review the generated file\n` +
      `  2. Run: npm start\n` +
      `  3. Verify logs show values match expectations\n` +
      `  4. (Optional) delete or archive the legacy ${path.basename(args.source)}\n`
  );
}

main();
