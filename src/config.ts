import dotenv from 'dotenv';
import type { EVKellyConfig } from './ev-kelly.js';
import type { LatencyMomentumConfig } from './latency-momentum.js';
import type { OrderBookImbalanceConfig } from './order-book-imbalance.js';
import type { ObiEngineConfig } from './obi-engine.js';
import type { VsEngineConfig } from './vs-engine.js';
import type { PairedArbConfig } from './paired-arbitrage.js';
import type { PaperTraderConfig } from './paper-trader.js';
import { parseLayerMultipliers } from './dynamic-compounder.js';
import { clamp, parseBooleanLoose, sanitizeConditionIds } from './utils.js';

export type AuthMode = 'EOA' | 'PROXY';
export type EntryStrategy = 'LEGACY' | 'PAIRED_ARBITRAGE' | 'LATENCY_MOMENTUM' | 'ALL';
/**
 * High-level strategy preset switcher applied on top of the existing config.
 * - CURRENT_SNIPER: zero changes; preserves the historical Binance-led
 *   sniper + lottery + MM behaviour. This is the default for backward compat.
 * - PAIRED_ARBITRAGE: forces ENTRY_STRATEGY=PAIRED_ARBITRAGE, enables
 *   PAIRED_ARB_ENABLED, and disables sniper / MM / lottery layers so the bot
 *   trades only googoogaga23-style YES+NO arbitrage with limit orders.
 * - ORDER_BOOK_IMBALANCE: placeholder for the vague-sourdough-style strategy.
 *   Not implemented yet — logs a warning and falls back to CURRENT_SNIPER.
 */
export type ActiveStrategy =
  | 'CURRENT_SNIPER'
  | 'PAIRED_ARBITRAGE'
  | 'ORDER_BOOK_IMBALANCE'
  | 'ALL';
export type SignatureType = 0 | 1 | 2;
export type OrderMode = 'GTC' | 'FOK' | 'FAK';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type OrderUrgency = 'passive' | 'improve' | 'cross';
export type TradeableCoin = 'BTC' | 'SOL' | 'XRP' | 'ETH' | 'BNB' | 'DOGE';
export type LayerConflictResolution = 'BLOCK' | 'OVERRIDE';

export interface PriceMultiplierLevel {
  readonly maxPrice: number;
  readonly multiplier: number;
}

/**
 * Sniper mode configuration for Binance-led aggressive taker entries.
 * This engine is intentionally feature-flagged so the legacy scalper remains
 * unchanged until `SNIPER_MODE_ENABLED=true`.
 */
export interface SniperConfig {
  /** Master switch for the sniper engine. Recommended production default (2026): false until paper-tested. */
  readonly enabled: boolean;
  /** Minimum Binance move percentage required before evaluating a taker entry. */
  readonly minBinanceMovePct: number;
  /** Move percentage that upgrades sizing from base shares to strong shares. */
  readonly strongBinanceMovePct: number;
  /** Minimum edge after taker fees required to buy aggressively. */
  readonly minEdgeAfterFees: number;
  /** Effective taker fee assumed by the sniper EV model. */
  readonly takerFeePct: number;
  /** Highest Polymarket ask price the sniper is allowed to pay. */
  readonly maxEntryPrice: number;
  /** Lowest Polymarket ask price considered valid (filters dust). */
  readonly minEntryPrice: number;
  /** Minimum absolute gap between Binance-implied fair value and PM ask. */
  readonly minPmLagPct: number;
  /** Base share size for normal-quality moves. */
  readonly baseShares: number;
  /** Share size for strong/high-conviction Binance moves. */
  readonly strongShares: number;
  /** Maximum sniper inventory per market/outcome. */
  readonly maxPositionShares: number;
  /**
   * Maximum number of same-direction sniper entries allowed inside the same
   * five-minute slot window after grouping by edge.
   * Recommended production default (2026): 2.
   */
  readonly maxConcurrentSameDirection: number;
  /** Cooldown between sniper entries on the same market. */
  readonly cooldownMs: number;
  /** Skip slot-open noise by waiting this long before first sniper entry. */
  readonly slotWarmupMs: number;
  /** Do not open new sniper entries inside this window before slot expiry. */
  readonly exitBeforeEndMs: number;
  /** Optional time stop; 0 means hold conviction entries to settlement. */
  readonly maxHoldMs: number;
  /** Profit target for fast repricing exits. */
  readonly scalpExitEdge: number;
  /** Short maker-first delay before a profitable scalp exit crosses the spread. */
  readonly makerExitGraceMs: number;
  /** Reversal loss threshold once Binance direction flips. */
  readonly stopLossPct: number;
  /** Once edge reaches this level, stop tightens to breakeven (0 = disabled). */
  readonly breakEvenEdge: number;
  /** Lookback window for Binance velocity confirmation. */
  readonly velocityWindowMs: number;
  /** Minimum signed velocity required to confirm the move is real. */
  readonly minVelocityPctPerSec: number;
  /** Move-to-probability calibration scale for Binance fair value estimation. */
  readonly volatilityScale: number;

  // === Phase 30B: Safety guards ported from OBI ===

  /** Minimum combined (bid+ask) orderbook liquidity to allow entry (0 = disabled). */
  readonly minLiquidityUsd: number;
  /** Block entry if |Binance move| exceeds this absolute threshold (0 = disabled). */
  readonly runawayAbsPct: number;
  /** After a losing exit on coin X, block new Sniper entries on any X slot for this duration. */
  readonly losingExitCooldownByCoinMs: number;
  /** Reject entry if available USDC < required notional × 1.05. */
  readonly preflightBalanceCheck: boolean;
  /** Available USDC balance for pre-flight check, refreshed externally. */
  availableBalanceUsd?: number;
}

/**
 * Dynamic compounding configuration for balance-aware position sizing.
 * When enabled, all layer sizes (sniper, MM, scalper) are recalculated
 * from current USDC balance on every cycle.
 */
export interface CompoundingConfig {
  /** Master switch. When false, the bot uses static sizing (unchanged behaviour). */
  readonly enabled: boolean;
  /** Fraction of bankroll for Layer 1 base size (default 0.008 = 0.8%). */
  readonly baseRiskPct: number;
  /** Maximum total exposure per market slot as fraction of bankroll (default 0.15 = 15%). */
  readonly maxSlotExposurePct: number;
  /** Dynamic global max exposure as fraction of bankroll (default 0.35 = 35%). */
  readonly globalExposurePct: number;
  /** Layer scaling multipliers, e.g. [1.0, 1.5, 2.0, 2.5, 3.0, 3.5]. */
  readonly layerMultipliers: readonly number[];
  /** If daily drawdown exceeds this fraction, reduce sizes by 50% (default 0.08 = 8%). */
  readonly drawdownGuardPct: number;
}

/**
 * Market regime filter configuration.
 * Classifies Binance price action as TRENDING or RANGING to filter
 * sniper entries during choppy conditions.
 */
export interface RegimeFilterConfig {
  /** Master switch. When false, sniper entries are never blocked by regime. */
  readonly enabled: boolean;
  /** Lookback window in milliseconds for regime calculation (default 300000 = 5 min). */
  readonly lookbackWindowMs: number;
  /** Micro-bar aggregation interval in milliseconds (default 10000 = 10 sec). */
  readonly barIntervalMs: number;
  /** Minimum raw price samples required before assessment (default 20). */
  readonly minSamplesRequired: number;
  /** Directional efficiency threshold (0..1). Below = ranging. Default 0.4. */
  readonly efficiencyThreshold: number;
  /** Normalized ATR threshold. Below = low volatility / ranging. Default 0.0003. */
  readonly atrThreshold: number;
}

export interface LotteryConfig {
  /** Master switch for convex opposite-side tickets. */
  readonly enabled: boolean;
  /** Maximum USDC risk per lottery ticket. */
  readonly maxRiskUsdc: number;
  /** Absolute floor for a lottery bid price. */
  readonly minCents: number;
  /** Legacy fixed-price ceiling for lottery bids. */
  readonly maxCents: number;
  /** Whether lottery bids should be anchored to the live opposite-side book. */
  readonly relativePricingEnabled: boolean;
  /** Fraction of the opposite-side best bid used as the initial lottery anchor. */
  readonly relativePriceFactor: number;
  /** Hard cap for relative lottery bids before order-executor post-only adjustment. */
  readonly relativeMaxCents: number;
  /** Minimum absolute bid price required before taking profit on a filled lottery ticket. */
  readonly takeProfitMinCents: number;
  /** Relative profit multiple required before taking profit on a filled lottery ticket. */
  readonly takeProfitMultiplier: number;
  /** Start forced lottery flattening this long before the slot ends. */
  readonly exitBeforeEndMs: number;
  /** Only trigger lottery entries after a confirmed sniper fill. */
  readonly onlyAfterSniper: boolean;
  /** Maximum number of lottery tickets allowed inside the same 5-minute slot. */
  readonly maxPerSlot: number;
  /** Stop-loss as fraction of entry price drop (0.5 = exit when mark ≤ 50% of entry). */
  readonly stopLossPct: number;
  /** Maximum hold time for lottery positions (ms); 0 = disabled. */
  readonly maxHoldMs: number;
}

export interface AppConfig {
  readonly PRODUCT_TEST_MODE: boolean;
  readonly SIMULATION_MODE: boolean;
  readonly TEST_MODE: boolean;
  readonly DRY_RUN: boolean;
  readonly TEST_MIN_TRADE_USDC: number;
  readonly TEST_MAX_SLOTS: number;
  readonly ENABLE_SIGNAL: boolean;
  readonly ENTRY_STRATEGY: EntryStrategy;
  /** High-level strategy preset (overrides several flags at startup). */
  readonly ACTIVE_STRATEGY: ActiveStrategy;
  readonly PAIRED_ARB_ENABLED: boolean;
  readonly LATENCY_MOMENTUM_ENABLED: boolean;
  readonly PAPER_TRADING_ENABLED: boolean;
  readonly EV_KELLY_ENABLED: boolean;
  readonly BAYESIAN_FV_ENABLED: boolean;
  readonly BAYESIAN_FV_ALPHA: number;
  readonly STATUS_CHECK_INTERVAL_MS: number;
  readonly AUTO_PAUSE_ON_INCIDENT: boolean;
  readonly PAUSE_GRACE_PERIOD_MS: number;
  readonly AUTO_REDEEM: boolean;
  readonly REDEEM_INTERVAL_MS: number;
  readonly FILL_POLL_INTERVAL_MS: number;
  readonly FILL_POLL_TIMEOUT_MS: number;
  readonly FILL_CANCEL_BEFORE_END_MS: number;
  readonly SELL_AFTER_FILL_DELAY_MS: number;
  readonly BALANCE_CACHE_TTL_MS: number;
  /** Enables Binance-led aggressive taker entry mode. */
  readonly SNIPER_MODE_ENABLED: boolean;
  /**
   * Enables the 2026 market-maker overlay while preserving the legacy scalper.
   * Recommended production default (2026): false until quoting has been
   * explicitly validated in PRODUCT_TEST_MODE and then promoted gradually.
   */
  readonly MARKET_MAKER_MODE: boolean;
  /**
   * Starts the dedicated quoting engine loop. This should normally be enabled
   * together with MARKET_MAKER_MODE; keeping it false leaves the legacy
   * per-signal execution path untouched.
   * Recommended production default (2026): false for backward compatibility.
   */
  readonly DYNAMIC_QUOTING_ENABLED: boolean;
  readonly MM_AUTO_ACTIVATE_AFTER_SNIPER: boolean;
  /** Short post-sniper window where autonomous MM may quote despite directional Binance moves. */
  readonly MM_POST_SNIPER_GRACE_WINDOW_MS: number;
  readonly LAYER_CONFLICT_RESOLUTION: LayerConflictResolution;
  readonly GLOBAL_MAX_EXPOSURE_USD: number;
  /**
   * When true, market-maker execution must remain passive/improve-only and
   * never intentionally cross the spread. In this codebase, `passive` is the
   * post-only quoting mode.
   * Recommended production default (2026): true.
   */
  readonly POST_ONLY_ONLY: boolean;
  /**
   * Quote refresh cadence for the dedicated market-maker loop.
   * Lower values are more competitive but increase cancel/repost pressure.
   * Recommended production default (2026): 150ms on stable infrastructure.
   */
  readonly QUOTING_INTERVAL_MS: number;
  /**
   * Inventory imbalance limit expressed as a percentage of gross exposure.
   * Above this threshold the quoting engine starts re-centering quotes to
   * reduce one-sided inventory accumulation.
   * Recommended production default (2026): 35.
   */
  readonly MAX_IMBALANCE_PERCENT: number;
  /**
   * Distance in ticks from the current best prices when reposting passive
   * market-maker quotes. Higher values are safer but less competitive.
   * Recommended production default (2026): 2.
   */
  readonly QUOTING_SPREAD_TICKS: number;
  /**
   * When true, inventory imbalance can be worked back into the book via
   * passive quote updates instead of forcing the legacy immediate rebalance.
   * Recommended production default (2026): true.
   */
  readonly REBALANCE_ON_IMBALANCE: boolean;
  /** Generate dual-sided quotes without waiting for scalper quote templates. */
  readonly MM_AUTONOMOUS_QUOTES: boolean;
  /** Keep autonomous quoting on even when scalper-driven quote signals are present. */
  readonly MM_ALWAYS_QUOTE: boolean;
  /** Base autonomous MM share size floor. Runtime sizing may scale above this, never below six. */
  readonly MM_QUOTE_SHARES: number;
  /** Maximum autonomous MM share size after dynamic scaling. */
  readonly MM_MAX_QUOTE_SHARES: number;
  /** Maximum total MM notional exposure across tracked markets in USDC. */
  readonly MM_MAX_GROSS_EXPOSURE_USD: number;
  /** Maximum allowed YES-minus-NO directional inventory in shares. */
  readonly MM_MAX_NET_DIRECTIONAL: number;
  /** Minimum quote width in ticks for autonomous MM quotes. */
  readonly MM_MIN_SPREAD_TICKS: number;
  /** Require a resolved fair value before autonomous MM quotes are posted. */
  readonly MM_REQUIRE_FAIR_VALUE: boolean;
  /** Minimum visible depth on both sides of the book before quoting. */
  readonly MM_MIN_BOOK_DEPTH_USD: number;
  /** Lowest autonomous MM bid price allowed for fresh entry quotes. */
  readonly MM_AUTONOMOUS_MIN_BID_PRICE: number;
  /** Highest autonomous MM bid price allowed for fresh entry quotes. */
  readonly MM_AUTONOMOUS_MAX_BID_PRICE: number;
  /** Delay after slot open before autonomous MM starts new entries. */
  readonly MM_SLOT_WARMUP_MS: number;
  /** Early slot window where autonomous MM only seeds the queue with base size. */
  readonly MM_OPENING_SEED_WINDOW_MS: number;
  /** Stop opening new autonomous MM inventory this far before slot end. */
  readonly MM_STOP_NEW_ENTRIES_BEFORE_END_MS: number;
  /** Cancel all autonomous MM quotes this far before slot end. */
  readonly MM_CANCEL_ALL_QUOTES_BEFORE_END_MS: number;
  /** Binance move threshold where autonomous MM degrades to ask-only. */
  readonly MM_TOXIC_FLOW_BLOCK_MOVE_PCT: number;
  /** Binance move threshold below which autonomous MM clears directional toxic hold. */
  readonly MM_TOXIC_FLOW_CLEAR_MOVE_PCT: number;
  /** Microprice imbalance threshold, measured in ticks, that blocks one-sided bids. */
  readonly MM_TOXIC_FLOW_MICROPRICE_TICKS: number;
  /** Microprice imbalance threshold below which autonomous MM clears toxic hold. */
  readonly MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS: number;
  /** Minimum hold time for autonomous MM toxic-flow suppression. */
  readonly MM_TOXIC_FLOW_HOLD_MS: number;
  /** Cooldown after toxic ASK_ONLY clears before autonomous MM may bid again. */
  readonly MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS: number;
  /** Cooldown after an autonomous MM fill before the same-side bid can re-enter. */
  readonly MM_SAME_SIDE_REENTRY_COOLDOWN_MS: number;
  /**
   * Gross inventory threshold, expressed in base MM quote clips, above which
   * new autonomous bids are blocked unless they reduce the current imbalance.
   */
  readonly MM_GROSS_REENTRY_THRESHOLD_CLIPS: number;
  /** Maximum number of markets allowed to carry active MM inventory/quotes. */
  readonly MM_MAX_CONCURRENT_MARKETS: number;
  /** Amount of inventory-based fair-value skew applied to autonomous quotes. */
  readonly MM_INVENTORY_SKEW_FACTOR: number;
  /** Minimum extra spread edge above fees for autonomous MM quotes. */
  readonly MM_MIN_EDGE_AFTER_FEE: number;
  /** Minimum extra spread edge required for passive maker MM quotes. */
  readonly MM_MAKER_MIN_EDGE: number;
  /** Minimum time to leave a passive MM quote resting before repricing it. */
  readonly MM_MIN_QUOTE_LIFETIME_MS: number;
  /** Maximum passive reprice drift tolerated before a quote is canceled and replaced. */
  readonly MM_REPRICE_DEADBAND_TICKS: number;
  /**
   * Enables the deeper Binance derivatives integration for the market-maker.
   * false = keep the existing lightweight Binance edge only.
   * true = blend Binance perpetual depth, funding, and short-horizon
   * directional state into quoting decisions.
   * Recommended production default (2026): false until validated on the
   * target VPS/network path; then true for production MM deployments.
   */
  readonly DEEP_BINANCE_MODE: boolean;
  /**
   * Controls whether the deep Binance module should maintain its WebSocket
   * connections. This can stay true even while DEEP_BINANCE_MODE=false so the
   * operator can pre-warm connectivity before enabling the feature flag.
   * Recommended production default (2026): true.
   */
  readonly BINANCE_WS_ENABLED: boolean;
  /**
   * Number of Binance depth levels retained per side for deep fair-value and
   * spread diagnostics. Higher values give better context but cost more CPU.
   * Recommended production default (2026): 20.
   */
  readonly BINANCE_DEPTH_LEVELS: number;
  /**
   * Weight assigned to funding-basis pressure when blending the synthetic
   * Polymarket fair value in deep Binance mode.
   * Recommended production default (2026): 0.3.
   */
  readonly BINANCE_FUNDING_WEIGHT: number;
  /**
   * Maximum allowed Binance spread ratio before new quote entry signals are
   * withheld. A value of 0.004 means 0.4% wide spread on Binance futures.
   * Recommended production default (2026): 0.004.
   */
  readonly MIN_BINANCE_SPREAD_THRESHOLD: number;
  /**
   * Multiplier used when converting observed Binance short-horizon volatility
   * into wider quoting spreads. Higher values widen quotes faster in volatile
   * conditions.
   * Recommended production default (2026): 1.5.
   */
  readonly DYNAMIC_SPREAD_VOL_FACTOR: number;
  /**
   * Weight assigned to Binance-derived directional fair value when deep
   * Binance mode is enabled.
   * Recommended production default (2026): 0.7.
   */
  readonly BINANCE_FAIR_VALUE_WEIGHT: number;
  /**
   * Weight assigned to the legacy Polymarket-only fair value component when
   * deep Binance mode is enabled.
   * Recommended production default (2026): 0.2.
   */
  readonly POLYMARKET_FAIR_VALUE_WEIGHT: number;
  readonly COINS_TO_TRADE: readonly TradeableCoin[];
  readonly FILTER_5MIN_ONLY: boolean;
  readonly MIN_LIQUIDITY_USD: number;
  readonly WHITELIST_CONDITION_IDS: readonly string[];
  readonly REPORTS_DIR: string;
  readonly LATENCY_LOG: string;
  readonly STATE_FILE: string;
  readonly REPORTS_FOLDER: string;
  readonly REPORTS_FILE_PREFIX: string;
  /** Phase 36: slot replay tracker for post-session analysis */
  readonly SLOT_REPLAY_ENABLED: boolean;
  readonly SLOT_REPLAY_SNAPSHOT_INTERVAL_MS: number;
  readonly POLYMARKET_API_KEY: string;
  readonly POLYMARKET_API_KEY_ADDRESS: string;
  readonly POLYMARKET_API_SECRET: string;
  readonly POLYMARKET_API_PASSPHRASE: string;
  readonly POLYMARKET_RELAYER_KEY: string;
  readonly POLYMARKET_RELAYER_KEY_ADDRESS: string;
  readonly POLYMARKET_RELAYER_URL: string;
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
    readonly binanceFvSensitivity: number;
    readonly fairValueBuyMaxPerSlot: number;
    readonly fairValueBuyCooldownMs: number;
    readonly inventoryRebalanceFvBlockMs: number;
    readonly binanceFvDecayWindowMs: number;
    readonly binanceFvDecayMinMultiplier: number;
    readonly trailingTakeProfit: number;
    readonly hardStopLoss: number;
    readonly hardStopCooldownMs: number;
    readonly maxDrawdownUsdc: number;
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
    readonly minEntryDepthUsd: number;
    readonly maxEntrySpread: number;
    readonly maxEntrySpreadCombinedDiscount: number;
    readonly maxEntrySpreadExtreme: number;
    readonly maxEntrySpreadFairValue: number;
    readonly maxEntrySpreadRebalance: number;
    readonly entryImbalanceBlockThreshold: number;
    readonly latencyPauseThresholdMs: number;
    readonly latencyResumeThresholdMs: number;
    readonly latencyPauseWindowSize: number;
    readonly latencyPauseSampleTtlMs: number;
    readonly maxSignalsPerTick: number;
    readonly priceMultiplierLevels: readonly PriceMultiplierLevel[];
    readonly exitBeforeEndMs: number;
  };
  readonly pairedArbitrage: PairedArbConfig;
  readonly latencyMomentum: LatencyMomentumConfig;
  /** Runtime sniper-engine configuration for Binance-led aggressive entries. */
  readonly sniper: SniperConfig;
  /** Market regime filter for sniper entry quality filtering. */
  readonly regimeFilter: RegimeFilterConfig;
  /** Runtime lottery-layer configuration for convex opposite-side tickets. */
  readonly lottery: LotteryConfig;
  readonly orderBookImbalance: OrderBookImbalanceConfig;
  readonly obiEngine: ObiEngineConfig;
  readonly vsEngine: VsEngineConfig;
  readonly paperTrading: PaperTraderConfig;
  readonly evKelly: EVKellyConfig;
  /** Dynamic balance-aware compounding engine configuration. */
  readonly compounding: CompoundingConfig;
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
    readonly marketScanCacheMs: number;
    readonly maxConcurrentMarkets: number;
    readonly marketQueryLimit: number;
    readonly onlyFiveMinuteMarkets: boolean;
    readonly gracefulShutdownTimeoutMs: number;
    readonly walletPositionRefreshMs: number;
    readonly walletFundsRefreshMs: number;
    /**
     * Phase 19 (2026-04-09): interval for the standalone wallet-funds refresh
     * timer that feeds the compounder drawdown guard between slot ticks.
     * Independent of walletFundsRefreshMs, which is a per-call throttle.
     */
    readonly walletFundsRefreshIntervalMs: number;
  };
  readonly dashboard: {
    readonly enabled: boolean;
    readonly port: number;
    readonly host: string;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly directory: string;
    readonly logToFile: boolean;
  };
  readonly binance: {
    readonly edgeEnabled: boolean;
    readonly symbols: readonly string[];
    readonly flatThreshold: number;
    readonly strongThreshold: number;
    readonly boostMultiplier: number;
    readonly reduceMultiplier: number;
    readonly blockOnStrongContra: boolean;
    readonly wsReconnectMs: number;
    readonly maxReconnectAttempts: number;
  };
}

const DEFAULT_WHITELIST_CONDITION_IDS = [] as const;
const DEFAULT_COINS_TO_TRADE = ['BTC', 'SOL', 'XRP', 'ETH', 'BNB', 'DOGE'] as const satisfies readonly TradeableCoin[];

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

function parseStringCsv(value: string | undefined, fallback: string): string[] {
  const raw = value?.trim() || fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCoinsToTrade(value?: string): TradeableCoin[] {
  const allowedCoins = new Set<TradeableCoin>(['BTC', 'SOL', 'XRP', 'ETH', 'BNB', 'DOGE']);
  const rawCoins =
    value?.trim() ||
    DEFAULT_COINS_TO_TRADE.join(',');

  const coins = rawCoins
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry): entry is TradeableCoin => allowedCoins.has(entry as TradeableCoin));

  return coins.length > 0 ? [...new Set(coins)] : [...DEFAULT_COINS_TO_TRADE];
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

function parseLayerConflictResolution(value?: string): LayerConflictResolution {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'BLOCK') {
    return 'BLOCK';
  }
  if (normalized === 'OVERRIDE') {
    return 'OVERRIDE';
  }
  throw new Error(`Invalid LAYER_CONFLICT_RESOLUTION: ${value}. Expected BLOCK or OVERRIDE.`);
}

function parseEntryStrategy(value?: string): EntryStrategy {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'LEGACY') {
    return 'LEGACY';
  }
  if (
    normalized === 'PAIRED_ARBITRAGE' ||
    normalized === 'LATENCY_MOMENTUM' ||
    normalized === 'ALL'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid ENTRY_STRATEGY: ${value}. Expected LEGACY, PAIRED_ARBITRAGE, LATENCY_MOMENTUM, or ALL.`
  );
}

function parseActiveStrategy(value?: string): ActiveStrategy {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized === 'CURRENT_SNIPER') {
    return 'CURRENT_SNIPER';
  }
  if (
    normalized === 'PAIRED_ARBITRAGE' ||
    normalized === 'ORDER_BOOK_IMBALANCE' ||
    normalized === 'ALL'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid ACTIVE_STRATEGY: ${value}. Expected CURRENT_SNIPER, PAIRED_ARBITRAGE, ORDER_BOOK_IMBALANCE, or ALL.`
  );
}

/**
 * Apply high-level strategy preset overrides on top of an env-built config.
 *
 * Backwards compatible: when ACTIVE_STRATEGY=CURRENT_SNIPER (default), the
 * input config is returned unchanged. Other presets clone the config and
 * mutate flags / nested layer toggles to match the requested mode so the
 * existing engines, signal-scalper, and quoting paths remain untouched.
 */
function applyStrategyPreset(input: AppConfig): AppConfig {
  const preset = input.ACTIVE_STRATEGY;
  if (preset === 'CURRENT_SNIPER') {
    console.log('[strategy] ACTIVE_STRATEGY=CURRENT_SNIPER (legacy sniper + lottery + MM)');
    return input;
  }

  if (preset === 'ORDER_BOOK_IMBALANCE') {
    // Deep Binance is allowed (and useful) in OBI mode purely as a price
    // feed for the runaway gate. We keep BINANCE_WS_ENABLED on whenever the
    // user opts in via DEEP_BINANCE_MODE, but always disable Binance edge
    // signal generation (we don't want regular Binance edge signals competing
    // with OBI entries).
    // Keep Binance WS when: DEEP_BINANCE_MODE (for runaway gate) OR VS_ENGINE (needs price feed)
    const keepBinanceWs = (input.DEEP_BINANCE_MODE && input.BINANCE_WS_ENABLED) || input.vsEngine.enabled;
    console.log(
      `[strategy] ACTIVE_STRATEGY=ORDER_BOOK_IMBALANCE — vague-sourdough OBI mode (standalone Layer 1, Binance ${
        keepBinanceWs ? 'price feed ON' + (input.vsEngine.enabled ? ' for VS Engine' : ' for runaway gate') : 'disabled'
      })`
    );
    return {
      ...input,
      SNIPER_MODE_ENABLED: false,
      sniper: { ...input.sniper, enabled: false },
      LATENCY_MOMENTUM_ENABLED: false,
      latencyMomentum: { ...input.latencyMomentum, enabled: false },
      PAIRED_ARB_ENABLED: false,
      pairedArbitrage: { ...input.pairedArbitrage, enabled: false },
      binance: { ...input.binance, edgeEnabled: false },
      BINANCE_WS_ENABLED: keepBinanceWs,
      obiEngine: { ...input.obiEngine, enabled: true },
      // OBI is a standalone Layer 1 engine with its own Layer 2 quoting
      // (OBI_MM_QUOTE_ASK). Running the regular MM_QUOTE engine in parallel
      // causes layer_conflict errors that block every OBI_ENTRY_BUY because
      // MM already owns the market. Disable the regular market maker here.
      MARKET_MAKER_MODE: false,
      DYNAMIC_QUOTING_ENABLED: false,
      MM_AUTO_ACTIVATE_AFTER_SNIPER: false,
      POST_ONLY_ONLY: true,
    };
  }

  if (preset === 'ALL') {
    // Phase 30: ALL mode — OBI + Sniper + Lottery run together.
    // OBI handles thin-side order book imbalance entries (mean-reversion).
    // Sniper handles Binance-led momentum entries (latency arb).
    // Lottery follows either as a convex follow-on bet.
    // Each strategy targets a different edge so they complement, not conflict.
    // Layer conflict resolution prevents both from entering the SAME market.
    const keepBinanceWs = input.DEEP_BINANCE_MODE && input.BINANCE_WS_ENABLED;
    console.log(
      '[strategy] ACTIVE_STRATEGY=ALL — OBI + Sniper + Lottery (multi-strategy mode)'
    );
    return {
      ...input,
      // OBI: enabled as standalone Layer 1 with its own quoting
      obiEngine: { ...input.obiEngine, enabled: true },
      // VS Engine: preserve user setting (has its own VS_ENGINE_ENABLED toggle)
      vsEngine: { ...input.vsEngine },
      // Sniper: enabled with Binance edge signals
      SNIPER_MODE_ENABLED: true,
      sniper: { ...input.sniper, enabled: true },
      // Binance: edge enabled for Sniper, WS on for both Sniper + OBI runaway gate
      binance: { ...input.binance, edgeEnabled: true },
      BINANCE_WS_ENABLED: keepBinanceWs || true,
      // Lottery: enabled as follow-on to both OBI and Sniper entries
      // (lottery already follows OBI_ENTRY_BUY via maybeScheduleLotteryFollowOn)
      // Latency momentum: disabled (overlaps with Sniper)
      LATENCY_MOMENTUM_ENABLED: false,
      latencyMomentum: { ...input.latencyMomentum, enabled: false },
      // Paired arb: disabled (different strategy class)
      PAIRED_ARB_ENABLED: false,
      pairedArbitrage: { ...input.pairedArbitrage, enabled: false },
      // MM: disabled — OBI has its own MM layer (OBI_MM_QUOTE_ASK).
      // Regular MM_QUOTE would conflict with both OBI and Sniper.
      MARKET_MAKER_MODE: false,
      DYNAMIC_QUOTING_ENABLED: false,
      MM_AUTO_ACTIVATE_AFTER_SNIPER: false,
    };
  }

  // PAIRED_ARBITRAGE: enable paired arb, disable sniper / MM / lottery / latency.
  console.log(
    '[strategy] ACTIVE_STRATEGY=PAIRED_ARBITRAGE — enabling paired arb engine, disabling sniper / MM / lottery / latency-momentum / binance-edge'
  );
  console.log('[strategy] Binance edge disabled for current strategy');
  return {
    ...input,
    ENTRY_STRATEGY: 'PAIRED_ARBITRAGE',
    PAIRED_ARB_ENABLED: true,
    SNIPER_MODE_ENABLED: false,
    MARKET_MAKER_MODE: false,
    DYNAMIC_QUOTING_ENABLED: false,
    LATENCY_MOMENTUM_ENABLED: false,
    POST_ONLY_ONLY: true,
    sniper: { ...input.sniper, enabled: false },
    lottery: { ...input.lottery, enabled: false },
    latencyMomentum: { ...input.latencyMomentum, enabled: false },
    pairedArbitrage: { ...input.pairedArbitrage, enabled: true },
    // Paired arb does not need Binance fair-value lookups; turning the feed
    // off here also prevents `BinanceEdgeProvider` from connecting to the WS
    // (shouldRunFeed() reads this flag) and silences "Binance edge
    // unavailable" debug spam in BinanceEdgeProvider.assess().
    binance: { ...input.binance, edgeEnabled: false },
  };
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
  const minLiquidityUsd = parseFloatOrDefault(env.MIN_LIQUIDITY_USD, '500');
  const reportsDir = (env.REPORTS_DIR || env.REPORTS_FOLDER || './reports').trim() || './reports';
  const reportsFilePrefix = (env.REPORTS_FILE_PREFIX || 'slot-reports').trim() || 'slot-reports';

  const baseConfig: AppConfig = {
    PRODUCT_TEST_MODE: parseBoolean(env.PRODUCT_TEST_MODE, false),
    SIMULATION_MODE: parseBoolean(env.SIMULATION_MODE, true),
    TEST_MODE: parseBoolean(env.TEST_MODE, false),
    DRY_RUN: parseBoolean(env.DRY_RUN, true),
    TEST_MIN_TRADE_USDC: Math.max(0.1, parseFloatOrDefault(env.TEST_MIN_TRADE_USDC, '1')),
    TEST_MAX_SLOTS: Math.max(1, parseIntOrDefault(env.TEST_MAX_SLOTS, '1')),
    ENABLE_SIGNAL: parseBoolean(env.ENABLE_SIGNAL, true),
    ENTRY_STRATEGY: parseEntryStrategy(env.ENTRY_STRATEGY),
    ACTIVE_STRATEGY: parseActiveStrategy(env.ACTIVE_STRATEGY),
    PAIRED_ARB_ENABLED: parseBoolean(env.PAIRED_ARB_ENABLED, false),
    LATENCY_MOMENTUM_ENABLED: parseBoolean(env.LATENCY_MOMENTUM_ENABLED, false),
    PAPER_TRADING_ENABLED: parseBoolean(env.PAPER_TRADING_ENABLED, false),
    EV_KELLY_ENABLED: parseBoolean(env.EV_KELLY_ENABLED, false),
    BAYESIAN_FV_ENABLED: parseBoolean(env.BAYESIAN_FV_ENABLED, false),
    BAYESIAN_FV_ALPHA: parseFloatOrDefault(env.BAYESIAN_FV_ALPHA, '0.35'),
    STATUS_CHECK_INTERVAL_MS: Math.max(
      60_000,
      parseIntOrDefault(env.STATUS_CHECK_INTERVAL_MS, '300000')
    ),
    AUTO_PAUSE_ON_INCIDENT: parseBoolean(env.AUTO_PAUSE_ON_INCIDENT, true),
    PAUSE_GRACE_PERIOD_MS: Math.max(
      0,
      parseIntOrDefault(env.PAUSE_GRACE_PERIOD_MS, '60000')
    ),
    AUTO_REDEEM: parseBoolean(env.AUTO_REDEEM, false),
    REDEEM_INTERVAL_MS: Math.max(5_000, parseIntOrDefault(env.REDEEM_INTERVAL_MS, '30000')),
    FILL_POLL_INTERVAL_MS: Math.max(
      500,
      parseIntOrDefault(env.FILL_POLL_INTERVAL_MS, '2500')
    ),
    FILL_POLL_TIMEOUT_MS: Math.max(
      5_000,
      parseIntOrDefault(env.FILL_POLL_TIMEOUT_MS, '120000')
    ),
    FILL_CANCEL_BEFORE_END_MS: Math.max(
      10_000,
      parseIntOrDefault(env.FILL_CANCEL_BEFORE_END_MS, '20000')
    ),
    SELL_AFTER_FILL_DELAY_MS: Math.max(
      2_000,
      parseIntOrDefault(env.SELL_AFTER_FILL_DELAY_MS, '8000')
    ),
    BALANCE_CACHE_TTL_MS: Math.max(
      0,
      parseIntOrDefault(env.BALANCE_CACHE_TTL_MS, '10000')
    ),
    SNIPER_MODE_ENABLED: parseBoolean(env.SNIPER_MODE_ENABLED, false),
    MARKET_MAKER_MODE: parseBoolean(env.MARKET_MAKER_MODE, false),
    DYNAMIC_QUOTING_ENABLED: parseBoolean(env.DYNAMIC_QUOTING_ENABLED, false),
    MM_AUTO_ACTIVATE_AFTER_SNIPER: parseBoolean(env.MM_AUTO_ACTIVATE_AFTER_SNIPER, true),
    MM_POST_SNIPER_GRACE_WINDOW_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_POST_SNIPER_GRACE_WINDOW_MS, '15000')
    ),
    LAYER_CONFLICT_RESOLUTION: parseLayerConflictResolution(env.LAYER_CONFLICT_RESOLUTION),
    GLOBAL_MAX_EXPOSURE_USD: parseFloatOrDefault(env.GLOBAL_MAX_EXPOSURE_USD, '50'),
    POST_ONLY_ONLY: parseBoolean(env.POST_ONLY_ONLY, true),
    QUOTING_INTERVAL_MS: Math.max(
      50,
      parseIntOrDefault(env.QUOTING_INTERVAL_MS, '150')
    ),
    MAX_IMBALANCE_PERCENT: parseFloatOrDefault(env.MAX_IMBALANCE_PERCENT, '35'),
    QUOTING_SPREAD_TICKS: Math.max(
      1,
      parseIntOrDefault(env.QUOTING_SPREAD_TICKS, '2')
    ),
    REBALANCE_ON_IMBALANCE: parseBoolean(env.REBALANCE_ON_IMBALANCE, true),
    MM_AUTONOMOUS_QUOTES: parseBoolean(env.MM_AUTONOMOUS_QUOTES, true),
    MM_ALWAYS_QUOTE: parseBoolean(env.MM_ALWAYS_QUOTE, false),
    MM_QUOTE_SHARES: Math.max(6, parseIntOrDefault(env.MM_QUOTE_SHARES, '6')),
    MM_MAX_QUOTE_SHARES: Math.max(6, parseIntOrDefault(env.MM_MAX_QUOTE_SHARES, '18')),
    MM_MAX_GROSS_EXPOSURE_USD: parseFloatOrDefault(env.MM_MAX_GROSS_EXPOSURE_USD, '15'),
    MM_MAX_NET_DIRECTIONAL: parseFloatOrDefault(env.MM_MAX_NET_DIRECTIONAL, '10'),
    MM_MIN_SPREAD_TICKS: Math.max(
      1,
      parseIntOrDefault(env.MM_MIN_SPREAD_TICKS, '2')
    ),
    MM_REQUIRE_FAIR_VALUE: parseBoolean(env.MM_REQUIRE_FAIR_VALUE, true),
    MM_MIN_BOOK_DEPTH_USD: parseFloatOrDefault(env.MM_MIN_BOOK_DEPTH_USD, '3'),
    MM_AUTONOMOUS_MIN_BID_PRICE: parseFloatOrDefault(env.MM_AUTONOMOUS_MIN_BID_PRICE, '0.10'),
    MM_AUTONOMOUS_MAX_BID_PRICE: parseFloatOrDefault(env.MM_AUTONOMOUS_MAX_BID_PRICE, '0.90'),
    MM_SLOT_WARMUP_MS: Math.max(0, parseIntOrDefault(env.MM_SLOT_WARMUP_MS, '2000')),
    MM_OPENING_SEED_WINDOW_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_OPENING_SEED_WINDOW_MS, '10000')
    ),
    MM_STOP_NEW_ENTRIES_BEFORE_END_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_STOP_NEW_ENTRIES_BEFORE_END_MS, '90000')
    ),
    MM_CANCEL_ALL_QUOTES_BEFORE_END_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS, '15000')
    ),
    MM_TOXIC_FLOW_BLOCK_MOVE_PCT: parseFloatOrDefault(
      env.MM_TOXIC_FLOW_BLOCK_MOVE_PCT,
      '0.08'
    ),
    MM_TOXIC_FLOW_CLEAR_MOVE_PCT: parseFloatOrDefault(
      env.MM_TOXIC_FLOW_CLEAR_MOVE_PCT,
      '0.05'
    ),
    MM_TOXIC_FLOW_MICROPRICE_TICKS: Math.max(
      0,
      parseFloatOrDefault(env.MM_TOXIC_FLOW_MICROPRICE_TICKS, '1.5')
    ),
    MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS: Math.max(
      0,
      parseFloatOrDefault(env.MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS, '1')
    ),
    MM_TOXIC_FLOW_HOLD_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_TOXIC_FLOW_HOLD_MS, '5000')
    ),
    MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS, '15000')
    ),
    MM_SAME_SIDE_REENTRY_COOLDOWN_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_SAME_SIDE_REENTRY_COOLDOWN_MS, '30000')
    ),
    MM_GROSS_REENTRY_THRESHOLD_CLIPS: Math.max(
      0,
      parseFloatOrDefault(env.MM_GROSS_REENTRY_THRESHOLD_CLIPS, '2')
    ),
    MM_MAX_CONCURRENT_MARKETS: Math.max(
      1,
      parseIntOrDefault(env.MM_MAX_CONCURRENT_MARKETS, '4')
    ),
    MM_INVENTORY_SKEW_FACTOR: clamp(
      parseFloatOrDefault(env.MM_INVENTORY_SKEW_FACTOR, '0.3'),
      0,
      1
    ),
    MM_MIN_EDGE_AFTER_FEE: parseFloatOrDefault(env.MM_MIN_EDGE_AFTER_FEE, '0.005'),
    MM_MAKER_MIN_EDGE: parseFloatOrDefault(env.MM_MAKER_MIN_EDGE, '0.003'),
    MM_MIN_QUOTE_LIFETIME_MS: Math.max(
      0,
      parseIntOrDefault(env.MM_MIN_QUOTE_LIFETIME_MS, '1500')
    ),
    MM_REPRICE_DEADBAND_TICKS: Math.max(
      0,
      parseIntOrDefault(env.MM_REPRICE_DEADBAND_TICKS, '1')
    ),
    DEEP_BINANCE_MODE: parseBoolean(env.DEEP_BINANCE_MODE, false),
    BINANCE_WS_ENABLED: parseBoolean(env.BINANCE_WS_ENABLED, true),
    BINANCE_DEPTH_LEVELS: Math.max(
      1,
      parseIntOrDefault(env.BINANCE_DEPTH_LEVELS, '20')
    ),
    BINANCE_FUNDING_WEIGHT: parseFloatOrDefault(env.BINANCE_FUNDING_WEIGHT, '0.3'),
    MIN_BINANCE_SPREAD_THRESHOLD: parseFloatOrDefault(
      env.MIN_BINANCE_SPREAD_THRESHOLD,
      '0.004'
    ),
    DYNAMIC_SPREAD_VOL_FACTOR: parseFloatOrDefault(
      env.DYNAMIC_SPREAD_VOL_FACTOR,
      '1.5'
    ),
    BINANCE_FAIR_VALUE_WEIGHT: parseFloatOrDefault(
      env.BINANCE_FAIR_VALUE_WEIGHT,
      '0.7'
    ),
    POLYMARKET_FAIR_VALUE_WEIGHT: parseFloatOrDefault(
      env.POLYMARKET_FAIR_VALUE_WEIGHT,
      '0.2'
    ),
    COINS_TO_TRADE: parseCoinsToTrade(env.COINS_TO_TRADE),
    FILTER_5MIN_ONLY: parseBoolean(
      env.FILTER_5MIN_ONLY ?? env.ONLY_FIVE_MINUTE_MARKETS,
      true
    ),
    MIN_LIQUIDITY_USD: minLiquidityUsd,
    WHITELIST_CONDITION_IDS: parseCsv(
      env.WHITELIST_CONDITION_IDS || DEFAULT_WHITELIST_CONDITION_IDS.join(',')
    ),
    REPORTS_DIR: reportsDir,
    LATENCY_LOG:
      (env.LATENCY_LOG || `${reportsDir}/latency_YYYY-MM-DD.log`).trim() ||
      `${reportsDir}/latency_YYYY-MM-DD.log`,
    STATE_FILE:
      (env.STATE_FILE || `${reportsDir}/state.json`).trim() ||
      `${reportsDir}/state.json`,
    REPORTS_FOLDER: reportsDir,
    REPORTS_FILE_PREFIX: reportsFilePrefix,
    SLOT_REPLAY_ENABLED: parseBoolean(env.SLOT_REPLAY_ENABLED, true),
    SLOT_REPLAY_SNAPSHOT_INTERVAL_MS: Math.max(
      5_000,
      parseIntOrDefault(env.SLOT_REPLAY_SNAPSHOT_INTERVAL_MS, '30000')
    ),
    POLYMARKET_API_KEY: (
      env.POLYMARKET_API_KEY ||
      env.RELAYER_API_KEY ||
      ''
    ).trim(),
    POLYMARKET_API_KEY_ADDRESS: (
      env.POLYMARKET_API_KEY_ADDRESS ||
      env.RELAYER_API_KEY_ADDRESS ||
      ''
    ).trim(),
    POLYMARKET_API_SECRET: (env.POLYMARKET_API_SECRET || '').trim(),
    POLYMARKET_API_PASSPHRASE: (env.POLYMARKET_API_PASSPHRASE || '').trim(),
    POLYMARKET_RELAYER_KEY: (
      env.POLYMARKET_RELAYER_KEY ||
      env.RELAYER_API_KEY ||
      ''
    ).trim(),
    POLYMARKET_RELAYER_KEY_ADDRESS: (
      env.POLYMARKET_RELAYER_KEY_ADDRESS ||
      env.RELAYER_API_KEY_ADDRESS ||
      env.POLYMARKET_API_KEY_ADDRESS ||
      ''
    ).trim(),
    POLYMARKET_RELAYER_URL: (
      env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com'
    ).trim(),
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
      exchange: (env.POLY_EXCHANGE_ADDRESS || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E').trim(),
      ctf: (env.POLY_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045').trim(),
      // V2 migration: collateral token — currently USDC.e, will migrate to "Polymarket USD".
      // Override via env when official new address is published.
      usdc: (env.POLY_COLLATERAL_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174').trim(),
      negRiskAdapter: (env.POLY_NEG_RISK_ADAPTER_ADDRESS || '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296').trim(),
      negRiskExchange: (env.POLY_NEG_RISK_EXCHANGE_ADDRESS || '0xC5d563A36AE78145C45a50134d48A1215220f80a').trim(),
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
      minCombinedDiscount: parseFloatOrDefault(env.MIN_COMBINED_DISCOUNT, '0.01'),
      extremeSellThreshold: parseFloatOrDefault(env.EXTREME_SELL_THRESHOLD, '0.93'),
      extremeBuyThreshold: parseFloatOrDefault(env.EXTREME_BUY_THRESHOLD, '0.04'),
      fairValueBuyThreshold: parseFloatOrDefault(env.FAIR_VALUE_BUY_THRESHOLD, '0.018'),
      fairValueSellThreshold: parseFloatOrDefault(env.FAIR_VALUE_SELL_THRESHOLD, '0.015'),
      binanceFvSensitivity: parseFloatOrDefault(env.BINANCE_FV_SENSITIVITY, '0.10'),
      fairValueBuyMaxPerSlot: Math.max(1, parseIntOrDefault(env.FV_BUY_MAX_PER_SLOT, '4')),
      fairValueBuyCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.FV_BUY_COOLDOWN_MS, '30000')
      ),
      inventoryRebalanceFvBlockMs: Math.max(
        0,
        parseIntOrDefault(env.INVENTORY_REBALANCE_FV_BLOCK_MS, '60000')
      ),
      binanceFvDecayWindowMs: Math.max(
        1_000,
        parseIntOrDefault(env.BINANCE_FV_DECAY_WINDOW_MS, '300000')
      ),
      binanceFvDecayMinMultiplier: parseFloatOrDefault(
        env.BINANCE_FV_DECAY_MIN_MULTIPLIER,
        '0.25'
      ),
      trailingTakeProfit: parseFloatOrDefault(env.TRAILING_TAKE_PROFIT, '0.012'),
      hardStopLoss: parseFloatOrDefault(env.HARD_STOP_LOSS, '0.025'),
      hardStopCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.HARD_STOP_COOLDOWN_MS, '15000')
      ),
      maxDrawdownUsdc: parseFloatOrDefault(env.MAX_DRAWDOWN_USDC, '-15'),
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
      minLiquidityUsd,
      sizeLiquidityCapUsd: parseFloatOrDefault(env.SIZE_LIQUIDITY_CAP_USD, '4000'),
      depthReferenceShares: parseFloatOrDefault(env.DEPTH_REFERENCE_SHARES, '180'),
      capitalReferenceShares: parseFloatOrDefault(env.CAPITAL_REFERENCE_SHARES, '120'),
      minEntryDepthUsd: parseFloatOrDefault(env.MIN_ENTRY_DEPTH_USD, '2'),
      maxEntrySpread: parseFloatOrDefault(env.MAX_ENTRY_SPREAD, '0.12'),
      maxEntrySpreadCombinedDiscount: parseFloatOrDefault(
        env.MAX_ENTRY_SPREAD_COMBINED_DISCOUNT,
        '0.08'
      ),
      maxEntrySpreadExtreme: parseFloatOrDefault(env.MAX_ENTRY_SPREAD_EXTREME, '0.15'),
      maxEntrySpreadFairValue: parseFloatOrDefault(env.MAX_ENTRY_SPREAD_FAIR_VALUE, '0.06'),
      maxEntrySpreadRebalance: parseFloatOrDefault(env.MAX_ENTRY_SPREAD_REBALANCE, '0.20'),
      entryImbalanceBlockThreshold: parseFloatOrDefault(
        env.ENTRY_IMBALANCE_BLOCK_THRESHOLD,
        '100'
      ),
      latencyPauseThresholdMs: Math.max(
        1,
        parseIntOrDefault(env.LATENCY_PAUSE_THRESHOLD_MS, '800')
      ),
      latencyResumeThresholdMs: Math.max(
        1,
        parseIntOrDefault(env.LATENCY_RESUME_THRESHOLD_MS, '400')
      ),
      latencyPauseWindowSize: Math.max(
        1,
        parseIntOrDefault(env.LATENCY_PAUSE_WINDOW_SIZE, '10')
      ),
      latencyPauseSampleTtlMs: Math.max(
        5_000,
        parseIntOrDefault(env.LATENCY_PAUSE_SAMPLE_TTL_MS, '90000')
      ),
      maxSignalsPerTick: Math.max(1, parseIntOrDefault(env.MAX_SIGNALS_PER_TICK, '2')),
      priceMultiplierLevels: parsePriceMultiplierLevels(env.PRICE_MULTIPLIER_LEVELS),
      exitBeforeEndMs: Math.max(0, parseIntOrDefault(env.EXIT_BEFORE_END_MS, '20000')),
    },
    pairedArbitrage: {
      enabled: parseBoolean(env.PAIRED_ARB_ENABLED, false),
      minNetEdge: parseFloatOrDefault(env.PAIRED_ARB_MIN_NET_EDGE, '0.02'),
      maxPairCost: parseFloatOrDefault(env.PAIRED_ARB_MAX_PAIR_COST, '0.97'),
      targetBalanceRatio: parseFloatOrDefault(env.PAIRED_ARB_TARGET_BALANCE_RATIO, '1.0'),
      balanceTolerance: parseFloatOrDefault(env.PAIRED_ARB_BALANCE_TOLERANCE, '0.15'),
      maxPositionPerSide: parseFloatOrDefault(env.PAIRED_ARB_MAX_PER_SIDE, '200'),
      minSharesPerLeg: parseFloatOrDefault(env.PAIRED_ARB_MIN_SHARES, '20'),
      maxSharesPerLeg: parseFloatOrDefault(env.PAIRED_ARB_MAX_SHARES, '80'),
      cooldownMs: Math.max(0, parseIntOrDefault(env.PAIRED_ARB_COOLDOWN_MS, '5000')),
      requireBothSidesLiquidity: parseBoolean(env.PAIRED_ARB_REQUIRE_BOTH_LIQUIDITY, true),
      minDepthPerSide: parseFloatOrDefault(env.PAIRED_ARB_MIN_DEPTH_USD, '3'),
      asyncEnabled: parseBoolean(env.PAIRED_ARB_ASYNC_ENABLED, true),
      asyncMaxEntryPrice: parseFloatOrDefault(env.PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE, '0.45'),
      asyncMinEdge: parseFloatOrDefault(env.PAIRED_ARB_ASYNC_MIN_EDGE, '0.01'),
      asyncMaxWaitMs: Math.max(
        1_000,
        parseIntOrDefault(env.PAIRED_ARB_ASYNC_MAX_WAIT_MS, '180000')
      ),
    },
    latencyMomentum: {
      enabled: parseBoolean(env.LATENCY_MOMENTUM_ENABLED, false),
      minMovePct: parseFloatOrDefault(env.LATENCY_MOMENTUM_MIN_MOVE_PCT, '0.30'),
      strongMovePct: parseFloatOrDefault(env.LATENCY_MOMENTUM_STRONG_MOVE_PCT, '0.50'),
      maxEntryWindowMs: Math.max(
        1_000,
        parseIntOrDefault(env.LATENCY_MOMENTUM_MAX_ENTRY_WINDOW_MS, '120000')
      ),
      maxPmLagPct: parseFloatOrDefault(env.LATENCY_MOMENTUM_MAX_PM_LAG_PCT, '0.10'),
      pmMoveSensitivity: parseFloatOrDefault(
        env.LATENCY_MOMENTUM_PM_MOVE_SENSITIVITY,
        '0.10'
      ),
      maxEntryPrice: parseFloatOrDefault(env.LATENCY_MOMENTUM_MAX_ENTRY_PRICE, '0.15'),
      minEntryPrice: parseFloatOrDefault(env.LATENCY_MOMENTUM_MIN_ENTRY_PRICE, '0.01'),
      baseShares: parseFloatOrDefault(env.LATENCY_MOMENTUM_BASE_SHARES, '30'),
      strongShares: parseFloatOrDefault(env.LATENCY_MOMENTUM_STRONG_SHARES, '60'),
      maxPositionShares: parseFloatOrDefault(env.LATENCY_MOMENTUM_MAX_POSITION_SHARES, '100'),
      cooldownMs: Math.max(
        0,
        parseIntOrDefault(env.LATENCY_MOMENTUM_COOLDOWN_MS, '10000')
      ),
      invertSignal: parseBoolean(env.LATENCY_MOMENTUM_INVERT_SIGNAL, false),
    },
    sniper: {
      enabled: parseBoolean(env.SNIPER_MODE_ENABLED, false),
      minBinanceMovePct: parseFloatOrDefault(env.SNIPER_MIN_BINANCE_MOVE_PCT, '0.10'),
      strongBinanceMovePct: parseFloatOrDefault(
        env.SNIPER_STRONG_BINANCE_MOVE_PCT,
        '0.30'
      ),
      minEdgeAfterFees: parseFloatOrDefault(env.SNIPER_MIN_EDGE_AFTER_FEES, '0.01'),
      takerFeePct: parseFloatOrDefault(
        env.SNIPER_TAKER_FEE_PCT ?? env.HIGH_FEE_TAKER_FEE,
        '0.0315'
      ),
      maxEntryPrice: parseFloatOrDefault(env.SNIPER_MAX_ENTRY_PRICE, '0.55'),
      minEntryPrice: parseFloatOrDefault(env.SNIPER_MIN_ENTRY_PRICE, '0.03'),
      minPmLagPct: parseFloatOrDefault(env.SNIPER_MIN_PM_LAG, '0.03'),
      baseShares: parseFloatOrDefault(env.SNIPER_BASE_SHARES, '6'),
      strongShares: parseFloatOrDefault(env.SNIPER_STRONG_SHARES, '12'),
      maxPositionShares: parseFloatOrDefault(env.SNIPER_MAX_POSITION_SHARES, '20'),
      maxConcurrentSameDirection: Math.max(
        1,
        parseIntOrDefault(env.SNIPER_MAX_CONCURRENT_SAME_DIRECTION, '2')
      ),
      cooldownMs: Math.max(0, parseIntOrDefault(env.SNIPER_COOLDOWN_MS, '3000')),
      slotWarmupMs: Math.max(0, parseIntOrDefault(env.SNIPER_SLOT_WARMUP_MS, '15000')),
      exitBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.SNIPER_EXIT_BEFORE_END_MS, '30000')
      ),
      maxHoldMs: Math.max(0, parseIntOrDefault(env.SNIPER_MAX_HOLD_MS, '0')),
      scalpExitEdge: parseFloatOrDefault(env.SNIPER_SCALP_EXIT_EDGE, '0.08'),
      makerExitGraceMs: Math.max(
        0,
        parseIntOrDefault(env.SNIPER_MAKER_EXIT_GRACE_MS, '2500')
      ),
      stopLossPct: parseFloatOrDefault(env.SNIPER_STOP_LOSS_PCT, '0.15'),
      breakEvenEdge: parseFloatOrDefault(env.SNIPER_BREAK_EVEN_EDGE, '0.04'),
      velocityWindowMs: Math.max(
        1_000,
        parseIntOrDefault(env.SNIPER_VELOCITY_WINDOW_MS, '5000')
      ),
      minVelocityPctPerSec: parseFloatOrDefault(
        env.SNIPER_MIN_VELOCITY_PCT_PER_SEC,
        '0.005'
      ),
      volatilityScale: parseFloatOrDefault(env.SNIPER_VOLATILITY_SCALE, '0.003'),
      // Phase 30B: Safety guards ported from OBI
      minLiquidityUsd: Math.max(0, parseFloatOrDefault(env.SNIPER_MIN_LIQUIDITY_USD, '100')),
      runawayAbsPct: Math.max(0, parseFloatOrDefault(env.SNIPER_RUNAWAY_ABS_PCT, '0.30')),
      losingExitCooldownByCoinMs: Math.max(0, parseIntOrDefault(env.SNIPER_LOSING_COOLDOWN_BY_COIN_MS, '300000')),
      preflightBalanceCheck: parseBoolean(env.SNIPER_PREFLIGHT_BALANCE_CHECK, true),
    },
    regimeFilter: {
      enabled: parseBoolean(env.REGIME_FILTER_ENABLED, false),
      lookbackWindowMs: Math.max(
        10_000,
        parseIntOrDefault(env.REGIME_FILTER_LOOKBACK_MS, '300000')
      ),
      barIntervalMs: Math.max(
        1_000,
        parseIntOrDefault(env.REGIME_FILTER_BAR_INTERVAL_MS, '10000')
      ),
      minSamplesRequired: Math.max(5, parseIntOrDefault(env.REGIME_FILTER_MIN_SAMPLES, '20')),
      efficiencyThreshold: clamp(
        parseFloatOrDefault(env.REGIME_FILTER_EFFICIENCY_THRESHOLD, '0.4'),
        0.1,
        0.9
      ),
      atrThreshold: clamp(
        parseFloatOrDefault(env.REGIME_FILTER_ATR_THRESHOLD, '0.0003'),
        0.00001,
        0.01
      ),
    },
    lottery: {
      enabled: parseBoolean(env.LOTTERY_LAYER_ENABLED, false),
      maxRiskUsdc: parseFloatOrDefault(env.LOTTERY_MAX_RISK_USDC, '12'),
      minCents: parseFloatOrDefault(env.LOTTERY_MIN_CENTS, '0.03'),
      maxCents: parseFloatOrDefault(env.LOTTERY_MAX_CENTS, '0.07'),
      relativePricingEnabled: parseBoolean(env.LOTTERY_RELATIVE_PRICING_ENABLED, true),
      relativePriceFactor: parseFloatOrDefault(env.LOTTERY_RELATIVE_PRICE_FACTOR, '0.25'),
      relativeMaxCents: parseFloatOrDefault(
        env.LOTTERY_RELATIVE_MAX_CENTS ?? env.LOTTERY_MAX_CENTS,
        '0.07'
      ),
      takeProfitMinCents: parseFloatOrDefault(env.LOTTERY_TAKE_PROFIT_MIN_CENTS, '0.12'),
      takeProfitMultiplier: parseFloatOrDefault(env.LOTTERY_TAKE_PROFIT_MULTIPLIER, '1.5'),
      exitBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.LOTTERY_EXIT_BEFORE_END_MS, '45000')
      ),
      onlyAfterSniper: parseBoolean(env.LOTTERY_ONLY_AFTER_SNIPER, true),
      maxPerSlot: Math.max(0, parseIntOrDefault(env.LOTTERY_MAX_PER_SLOT, '1')),
      stopLossPct: clamp(parseFloatOrDefault(env.LOTTERY_STOP_LOSS_PCT, '0.50'), 0.1, 0.9),
      maxHoldMs: Math.max(0, parseIntOrDefault(env.LOTTERY_MAX_HOLD_MS, '150000')),
    },
    orderBookImbalance: {
      enabled: parseBoolean(env.ORDER_BOOK_IMBALANCE_ENABLED, false),
      thinThresholdUsd: Math.max(
        0,
        parseFloatOrDefault(env.OBI_THIN_THRESHOLD_USD, '8')
      ),
      minLiquidityUsd: Math.max(
        0,
        parseFloatOrDefault(env.OBI_MIN_LIQUIDITY_USD, '500')
      ),
      entryImbalanceRatio: clamp(
        parseFloatOrDefault(env.OBI_ENTRY_IMBALANCE_RATIO, '0.35'),
        0.05,
        0.95
      ),
      exitRebalanceRatio: clamp(
        parseFloatOrDefault(env.OBI_EXIT_REBALANCE_RATIO, '0.65'),
        0.10,
        1.0
      ),
      keepStrongerLegPct: clamp(
        parseFloatOrDefault(env.OBI_KEEP_STRONGER_LEG_PCT, '0.50'),
        0,
        1
      ),
      shadowMode: parseBoolean(env.OBI_SHADOW_MODE, false),
    },
    obiEngine: {
      enabled: parseBoolean(env.OBI_ENGINE_ENABLED, false),
      thinThresholdUsd: Math.max(
        0,
        parseFloatOrDefault(env.OBI_THIN_THRESHOLD_USD, '8')
      ),
      minLiquidityUsd: Math.max(
        0,
        parseFloatOrDefault(env.OBI_MIN_LIQUIDITY_USD, '500')
      ),
      entryImbalanceRatio: clamp(
        parseFloatOrDefault(env.OBI_ENTRY_IMBALANCE_RATIO, '0.35'),
        0.05,
        0.95
      ),
      exitRebalanceRatio: clamp(
        parseFloatOrDefault(env.OBI_EXIT_REBALANCE_RATIO, '0.65'),
        0.10,
        1.0
      ),
      entryShares: Math.max(6, parseIntOrDefault(env.OBI_ENTRY_SHARES, '8')),
      maxPositionShares: Math.max(
        6,
        parseIntOrDefault(env.OBI_MAX_POSITION_SHARES, '20')
      ),
      cooldownMs: Math.max(0, parseIntOrDefault(env.OBI_COOLDOWN_MS, '15000')),
      slotWarmupMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_SLOT_WARMUP_MS, '5000')
      ),
      stopEntryBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_STOP_ENTRY_BEFORE_END_MS, '90000')
      ),
      cancelAllBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_CANCEL_ALL_BEFORE_END_MS, '20000')
      ),
      minEntryPrice: clamp(
        parseFloatOrDefault(env.OBI_MIN_ENTRY_PRICE, '0.30'),
        0,
        1
      ),
      maxEntryPrice: clamp(
        parseFloatOrDefault(env.OBI_MAX_ENTRY_PRICE, '0.50'),
        0,
        1
      ),
      scalpExitEdge: Math.max(
        0,
        parseFloatOrDefault(env.OBI_SCALP_EXIT_EDGE, '0.08')
      ),
      timeTakeProfitMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_TIME_TAKE_PROFIT_MS, '45000')
      ),
      timeTakeProfitMinEdge: Math.max(
        0,
        parseFloatOrDefault(env.OBI_TIME_TAKE_PROFIT_MIN_EDGE, '0.005')
      ),
      mmAskEnabled: parseBoolean(env.OBI_MM_ASK_ENABLED, true),
      mmBidOppositeEnabled: parseBoolean(env.OBI_MM_BID_OPPOSITE_ENABLED, false),
      mmAskSpreadTicks: Math.max(
        0,
        parseFloatOrDefault(env.OBI_MM_ASK_SPREAD_TICKS, '0.015')
      ),
      mmBidOppositeFactor: clamp(
        parseFloatOrDefault(env.OBI_MM_BID_OPPOSITE_FACTOR, '0.25'),
        0,
        1
      ),
      shadowMode: parseBoolean(env.OBI_SHADOW_MODE, false),
      aggressiveEntry: parseBoolean(env.OBI_AGGRESSIVE_ENTRY, false),
      // === Safety nets (after $10 live loss audit) ===
      hardStopUsd: Math.max(
        0.5,
        parseFloatOrDefault(env.OBI_HARD_STOP_USD, '2.0')
      ),
      minEntryNotionalUsd: Math.max(
        1,
        parseFloatOrDefault(env.OBI_MIN_ENTRY_NOTIONAL_USD, '3.0')
      ),
      clobMinNotionalUsd: Math.max(
        1,
        parseFloatOrDefault(env.OBI_CLOB_MIN_NOTIONAL_USD, '1.0')
      ),
      clobMinShares: Math.max(
        1,
        parseIntOrDefault(env.OBI_CLOB_MIN_SHARES, '5')
      ),
      losingExitCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_LOSING_EXIT_COOLDOWN_MS, '300000')
      ),
      // Phase 8 (2026-04-08): coin-wide cooldown after a losing exit. Default
      // 600s = 10 minutes ≈ skip the next 1-2 5-min slots of the same coin.
      // The 11:00 → 11:06 SOL cascade losses motivated this. Set to 0 to
      // disable the gate entirely (e.g. for backtests).
      losingExitCooldownByCoinMs: Math.max(
        0,
        parseIntOrDefault(env.OBI_LOSING_EXIT_COOLDOWN_BY_COIN_MS, '600000')
      ),
      imbalanceCollapseRatio: clamp(
        parseFloatOrDefault(env.OBI_IMBALANCE_COLLAPSE_RATIO, '1.5'),
        0.5,
        10
      ),
      preflightBalanceCheck: parseBoolean(
        env.OBI_PREFLIGHT_BALANCE_CHECK,
        true
      ),
      // === Binance runaway gate (2026-04-08 binary runaway fix) ===
      binanceGateEnabled: parseBoolean(env.OBI_BINANCE_GATE_ENABLED, true),
      binanceRunawayAbsPct: Math.max(
        0,
        parseFloatOrDefault(env.OBI_BINANCE_RUNAWAY_ABS_PCT, '0.30')
      ),
      binanceContraAbsPct: Math.max(
        0,
        parseFloatOrDefault(env.OBI_BINANCE_CONTRA_ABS_PCT, '0.15')
      ),
      // Phase 18 (2026-04-08): strict Binance directional alignment.
      // When true, OBI entries require Binance direction to match outcome
      // (UP→YES, DOWN→NO) and reject FLAT direction outright. Default off
      // to preserve historical behaviour; flip on for small bankrolls.
      binanceRequireAlignment: parseBoolean(
        env.OBI_BINANCE_REQUIRE_ALIGNMENT,
        false
      ),
      obiCompoundThresholdUsd: Math.max(
        0,
        parseFloatOrDefault(env.OBI_COMPOUND_THRESHOLD_USD, '100')
      ),
      maxRiskPerTradePct: clamp(
        parseFloatOrDefault(env.OBI_MAX_RISK_PER_TRADE_PCT, '0.15'),
        0.01,
        1.0
      ),
    },
    vsEngine: {
      enabled: parseBoolean(env.VS_ENGINE_ENABLED, false),
      shadowMode: parseBoolean(env.VS_SHADOW_MODE, true),
      // Fair value calculation
      defaultVolatility: Math.max(
        0.01,
        parseFloatOrDefault(env.VS_DEFAULT_VOLATILITY, '0.60')
      ),
      // Phase 44f: floor on vol to prevent CDF saturation when realized vol is near 0
      minVolatility: Math.max(
        0.005,
        parseFloatOrDefault(env.VS_MIN_VOLATILITY, '0.05')
      ),
      volLookbackMs: Math.max(
        10_000,
        parseIntOrDefault(env.VS_VOL_LOOKBACK_MS, '300000')
      ),
      minVolSamples: Math.max(
        3,
        parseIntOrDefault(env.VS_MIN_VOL_SAMPLES, '10')
      ),
      // Phase 1: Passive MM
      // Phase 52: disable MM phase when latency makes maker quotes toxic.
      // With 180ms avg latency, 100% of fills are staleQuote=true.
      mmPhaseEnabled: parseBoolean(env.VS_MM_PHASE_ENABLED, true),
      // Phase 57: default bumped 0.02 → 0.06. At 180ms latency, a 2-4¢ spread
      // is fully absorbed by adverse selection (every fill is staleQuote=true).
      // 6¢ spread gives the MM a realistic shot at spread capture vs VS's 50ms
      // latency at 2-3¢.
      mmSpreadCents: Math.max(
        0.005,
        parseFloatOrDefault(env.VS_MM_SPREAD_CENTS, '0.06')
      ),
      mmMinPrice: clamp(
        parseFloatOrDefault(env.VS_MM_MIN_PRICE, '0.10'),
        0.01,
        0.99
      ),
      mmMaxPrice: clamp(
        parseFloatOrDefault(env.VS_MM_MAX_PRICE, '0.90'),
        0.01,
        0.99
      ),
      mmShares: Math.max(
        1,
        parseIntOrDefault(env.VS_MM_SHARES, '7')
      ),
      mmMaxPositionShares: Math.max(
        1,
        parseIntOrDefault(env.VS_MM_MAX_POSITION_SHARES, '14')
      ),
      mmCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.VS_MM_COOLDOWN_MS, '5000')
      ),
      // Phase 2: Aggressive Momentum
      momentumThresholdSigmas: Math.max(
        0.1,
        parseFloatOrDefault(env.VS_MOMENTUM_THRESHOLD_SIGMAS, '1.0')
      ),
      momentumMaxBuyPrice: clamp(
        parseFloatOrDefault(env.VS_MOMENTUM_MAX_BUY_PRICE, '0.85'),
        0.50,
        0.98
      ),
      momentumShares: Math.max(
        1,
        parseIntOrDefault(env.VS_MOMENTUM_SHARES, '7')
      ),
      momentumMaxPositionShares: Math.max(
        1,
        parseIntOrDefault(env.VS_MOMENTUM_MAX_POSITION_SHARES, '20')
      ),
      // Exit
      targetExitPrice: clamp(
        parseFloatOrDefault(env.VS_TARGET_EXIT_PRICE, '0.97'),
        0.50,
        0.995
      ),
      makerAskMaxEdge: clamp(
        parseFloatOrDefault(env.VS_MAKER_ASK_MAX_EDGE, '0.02'),
        0.005,
        0.10
      ),
      timeExitBeforeEndMs: Math.max(
        1000,
        parseIntOrDefault(env.VS_TIME_EXIT_BEFORE_END_MS, '5000')
      ),
      timeExitMinPrice: clamp(
        parseFloatOrDefault(env.VS_TIME_EXIT_MIN_PRICE, '0.50'),
        0.01,
        0.99
      ),
      // Timing
      slotWarmupMs: Math.max(
        0,
        parseIntOrDefault(env.VS_SLOT_WARMUP_MS, '5000')
      ),
      stopEntryBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.VS_STOP_ENTRY_BEFORE_END_MS, '30000')
      ),
      cancelAllBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.VS_CANCEL_ALL_BEFORE_END_MS, '20000')
      ),
      momentumPhaseMs: Math.max(
        5000,
        parseIntOrDefault(env.VS_MOMENTUM_PHASE_MS, '30000')
      ),
      // Safety
      // Phase 49b: default changed from 0.05 to 0 (disabled).
      // 5-min binary markets oscillate ±15-20¢ naturally near 0.50.
      // Price-stop at 10¢ killed every position before maker-ask could fill.
      // Time-exit at T-15s is the real safety net. Re-enable via .env if needed.
      priceStopCents: clamp(
        parseFloatOrDefault(env.VS_PRICE_STOP_CENTS, '0'),
        0, // 0 = disabled
        0.20
      ),
      hardStopUsd: Math.max(
        0.5,
        parseFloatOrDefault(env.VS_HARD_STOP_USD, '3.0')
      ),
      cooldownMs: Math.max(
        0,
        parseIntOrDefault(env.VS_COOLDOWN_MS, '8000')
      ),
      losingExitCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.VS_LOSING_EXIT_COOLDOWN_MS, '300000')
      ),
      losingExitCooldownByCoinMs: Math.max(
        0,
        parseIntOrDefault(env.VS_LOSING_EXIT_COOLDOWN_BY_COIN_MS, '600000')
      ),
      preflightBalanceCheck: parseBoolean(
        env.VS_PREFLIGHT_BALANCE_CHECK,
        true
      ),
      minLiquidityUsd: Math.max(
        0,
        parseFloatOrDefault(env.VS_MIN_LIQUIDITY_USD, '200')
      ),
      minEntryPrice: clamp(
        parseFloatOrDefault(env.VS_MIN_ENTRY_PRICE, '0.10'),
        0,
        1
      ),
      maxEntryPrice: clamp(
        parseFloatOrDefault(env.VS_MAX_ENTRY_PRICE, '0.90'),
        0,
        1
      ),
      minDirectionThreshold: Math.max(
        0,
        parseFloatOrDefault(env.VS_MIN_DIRECTION_THRESHOLD, '0.03')
      ),
      // Phase 45a: two-sided MM + aggressor mode
      aggressorVolFloor: Math.max(
        0.005,
        parseFloatOrDefault(env.VS_AGGRESSOR_VOL_FLOOR, '0.02')
      ),
      aggressorMinEdge: Math.max(
        0.005,
        parseFloatOrDefault(env.VS_AGGRESSOR_MIN_EDGE, '0.03')
      ),
      mmTiltMaxCents: Math.max(
        0,
        parseFloatOrDefault(env.VS_MM_TILT_MAX_CENTS, '0.01')
      ),
      // Phase 48: cancel-on-Binance-move — if Binance moves > N% from quote
      // placement price, cancel stale maker quotes to avoid adverse selection.
      // Phase 51: lowered from 0.03 to 0.02 — logs showed 100% of fills had
      // staleQuote=true with ages up to 52s. 0.02% is closer to VS's 0.015-0.02%.
      staleCancelThresholdPct: Math.max(
        0,
        parseFloatOrDefault(env.VS_STALE_CANCEL_THRESHOLD_PCT, '0.02')
      ),
      // Phase 51: dynamic Binance-based position exit — when Binance moves against
      // a filled position by > N%, exit immediately at market (best bid).
      // 0.03 = 0.03% (~$20 on BTC@67k). This prevents holding losers 4+ min
      // until time-exit@0.01 — the single biggest source of losses.
      dynamicExitThresholdPct: Math.max(
        0,
        parseFloatOrDefault(env.VS_DYNAMIC_EXIT_THRESHOLD_PCT, '0.02')
      ),
      // Phase 51b: PM price guard — exit when PM bestBid drops below entry - N cents.
      // Tiered: 0.40-0.60 → 5¢, 0.30-0.40 → 4¢, 0.20-0.30 → 3¢, <0.20 → no guard.
      pmExitThresholdCents: Math.max(
        0,
        parseFloatOrDefault(env.VS_PM_EXIT_THRESHOLD_CENTS, '0.05')
      ),
      // Phase 53: position reversal — on dynamic exit, BUY opposite outcome
      reversalEnabled: parseBoolean(env.VS_REVERSAL_ENABLED, false),
      reversalMinBinanceMovePct: Math.max(
        0,
        parseFloatOrDefault(env.VS_REVERSAL_MIN_BINANCE_MOVE_PCT, '0.04')
      ),
      reversalMaxBuyPrice: Math.max(
        0.01,
        parseFloatOrDefault(env.VS_REVERSAL_MAX_BUY_PRICE, '0.85')
      ),
      // Phase 53: Binance tick warmup — require N ticks before first signal
      minWarmupTicks: Math.max(
        0,
        parseIntOrDefault(env.VS_MIN_WARMUP_TICKS, '3')
      ),
      // Phase 54: max aggressor entries per slot (marketId). 1 = no re-entry.
      // Data showed re-entry cycling was the dominant loss source: 2-3 small
      // maker wins wiped out by one late-slot re-entry crashing to time-exit.
      maxEntriesPerSlot: Math.max(
        0,
        parseIntOrDefault(env.VS_MAX_ENTRIES_PER_SLOT, '1')
      ),
      // Phase 55A: min hold time before dynamic exit fires (ms). Prevents
      // noise-panic in first seconds when maker-ask hasn't had chance to fill.
      dynExitMinHoldMs: Math.max(
        0,
        parseIntOrDefault(env.VS_DYN_EXIT_MIN_HOLD_MS, '15000')
      ),
      // Phase 55C: coin blacklist for VS engine (comma-separated, e.g. "DOGE").
      // DOGE default-excluded: tick-size:PM-gamma ratio causes catastrophic
      // slippage on thin books (4/6 largest losses were DOGE).
      coinBlacklist: (env.VS_COIN_BLACKLIST ?? 'DOGE')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
      // Phase 56: slippage floor for dynamic exit. If bestBid < entry*floorPct,
      // the thin-book cross would dump at catastrophic price (e.g. XRP @0.042
      // from entry 0.37). Instead, place a passive limit SELL @floor and let
      // time-exit act as the final safety net. 0 = disabled (legacy cross).
      dynExitMinPriceFloorPct: Math.max(
        0,
        parseFloatOrDefault(env.VS_DYN_EXIT_MIN_PRICE_FLOOR_PCT, '0.50')
      ),
      // Phase 56: fallback mode when bestBid < floor. 'limit_at_floor' submits
      // a passive limit SELL @ entry*floorPct. 'skip' aborts the exit and lets
      // time-exit flatten later. 'cross' preserves legacy behaviour (dump @bid).
      dynExitFallbackMode: (
        (env.VS_DYN_EXIT_FALLBACK_MODE ?? 'limit_at_floor').trim().toLowerCase()
      ) as 'limit_at_floor' | 'skip' | 'cross',
      // Phase 57: hard safety — if PM bestBid drops below this absolute floor,
      // never cross regardless of entryVwap or fallback mode. Stops catastrophic
      // dumps on thin books (e.g. bestBid 0.042 from entry 0.37). Time-exit
      // becomes the only remaining unwinder. 0 = disabled.
      dynExitMinBidForCross: clamp(
        parseFloatOrDefault(env.VS_DYN_EXIT_MIN_BID_FOR_CROSS, '0.20'),
        0,
        0.99
      ),
      // Phase 58F: cooldown after limit-at-floor fallback is placed. Prevents
      // WS-driven duplicate limit submissions while the first passive order
      // sits unfilled on the book. Default 15s — short enough to retry if the
      // market recovers, long enough to stop the spam loop observed in prod.
      dynExitFloorCooldownMs: Math.max(
        0,
        parseIntOrDefault(env.VS_DYN_EXIT_FLOOR_COOLDOWN_MS, '15000')
      ),
      // Phase 57: split dyn-exit cent thresholds by entry source. MM positions
      // (maker fills near 0.50) can tolerate tighter -3¢ cut; aggressor positions
      // (cross buys near 0.35) need wider -5¢ to absorb PM gamma. Values ≤ 0
      // disable the cent-based guard (legacy dynamic-pct path only).
      mmDynExitLossCents: Math.max(
        0,
        parseFloatOrDefault(env.VS_MM_DYN_EXIT_LOSS_CENTS, '0.03')
      ),
      aggDynExitLossCents: Math.max(
        0,
        parseFloatOrDefault(env.VS_AGG_DYN_EXIT_LOSS_CENTS, '0.05')
      ),
      // Phase 58: 4-phase model per DS3 analysis.
      // A: T-300 → -phaseBStartMs    → EARLY_MM (mid-anchored, both sides)
      // B: -phaseBStartMs → -phaseCStartMs  → ACCUMULATE (tilted maker, Binance side)  — 65% PnL
      // C: -phaseCStartMs → -phaseDStartMs  → CONTINUATION (taker fallback, capped price)
      // D: -phaseDStartMs → -timeExitBeforeEndMs → TAKE_PROFIT (sell losers, hold winners)
      phaseBStartBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.VS_PHASE_B_START_BEFORE_END_MS, '120000')
      ),
      phaseCStartBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.VS_PHASE_C_START_BEFORE_END_MS, '60000')
      ),
      phaseDStartBeforeEndMs: Math.max(
        0,
        parseIntOrDefault(env.VS_PHASE_D_START_BEFORE_END_MS, '30000')
      ),
      // Phase 58: Phase C taker fallback — only fires if Phase B accumulation
      // failed to fill target inventory. Tighter price cap than old aggressor.
      phaseCTakerEnabled: parseBoolean(env.VS_PHASE_C_TAKER_ENABLED, true),
      phaseCMaxBuyPrice: clamp(
        parseFloatOrDefault(env.VS_PHASE_C_MAX_BUY_PRICE, '0.70'),
        0.50,
        0.98
      ),
      // Phase 58: ACCUMULATE phase (B) config — tilted maker quotes.
      accumulateShares: Math.max(
        1,
        parseIntOrDefault(env.VS_ACCUMULATE_SHARES, '6')
      ),
      accumulateMaxFills: Math.max(
        1,
        parseIntOrDefault(env.VS_ACCUMULATE_MAX_FILLS, '4')
      ),
      accumulateRefillDelayMs: Math.max(
        0,
        parseIntOrDefault(env.VS_ACCUMULATE_REFILL_DELAY_MS, '5000')
      ),
      accumulateTiltMaxCents: Math.max(
        0,
        parseFloatOrDefault(env.VS_ACCUMULATE_TILT_MAX_CENTS, '0.05')
      ),
      // Phase 58I: anti-DCA — when true, block refill if PM mid < entry VWAP
      // (minus tolerance). Prevents ladder-buying into a losing position.
      // Default ON — observed BTC 0.54 → 0.48 → 0.39 → 0.34 ladder lost -$3.30.
      accumulateNoRefillOnDrawdown: parseBoolean(
        env.VS_ACCUMULATE_NO_REFILL_ON_DRAWDOWN,
        true
      ),
      // Cents of tolerance: mid can be up to this far below entryVwap and still
      // refill (covers passive-maker sitting slightly below current mid). 0 = strict.
      accumulateRefillMinPriceDelta: Math.max(
        0,
        parseFloatOrDefault(env.VS_ACCUMULATE_REFILL_MIN_PRICE_DELTA, '0.02')
      ),
      // Phase 58L: PM-FV divergence brake. When |PM_mid - FV| exceeds this,
      // skip ACCUMULATE — PM knows something Binance doesn't. Default 0.10.
      // Observed ETH loss had divergence 0.145 (mid=0.355 vs FV=0.50).
      // Set to 0 to disable.
      accumulateMaxFvMidDivergence: Math.max(
        0,
        parseFloatOrDefault(env.VS_ACCUMULATE_MAX_FV_MID_DIVERGENCE, '0.10')
      ),
      // Phase 58M: PM mid drift cancel. When an ACCUMULATE bid's PM mid
      // drifts DOWN by this many cents since placement, cancel the quote.
      // Prevents stale bid becoming adverse-selection bait. Default 0.02.
      // Set to 0 to disable.
      accumulatePmMidDriftCancel: Math.max(
        0,
        parseFloatOrDefault(env.VS_ACCUMULATE_PM_MID_DRIFT_CANCEL, '0.02')
      ),
      // Phase 58N: TAKE_PROFIT aggressive scalp. In Phase D window, cross
      // @bestBid when position profitable beyond minEdge, instead of passive
      // maker-ask. Winner-hold takes precedence (redeem @ $1 beats bestBid).
      takeProfitAggressiveEnabled: parseBoolean(
        env.VS_TAKE_PROFIT_AGGRESSIVE_ENABLED,
        true
      ),
      takeProfitAggressiveMinEdge: Math.max(
        0,
        parseFloatOrDefault(env.VS_TAKE_PROFIT_AGGRESSIVE_MIN_EDGE, '0.03')
      ),
      // Phase 58: asymmetric take-profit. When true, VS_TIME_EXIT SKIPS the
      // winning side (determined by Binance spot vs strike at T-exit) and lets
      // paper/real settlement redeem @ $1. Only losers are dumped @ bestBid.
      holdWinnersToResolution: parseBoolean(
        env.VS_HOLD_WINNERS_TO_RESOLUTION,
        true
      ),
      // Phase 58: master opt-in for 4-phase entry routing. When false,
      // generateSignals uses legacy 2-phase (PASSIVE_MM / MOMENTUM).
      // When true: EARLY_MM / ACCUMULATE / CONTINUATION / TAKE_PROFIT / EXIT.
      // Default false — foundation commit (asymmetric exits) is independent.
      phase58Enabled: parseBoolean(env.VS_PHASE58_ENABLED, false),
      // Phase 58O: shadow-mean-reversion logger. Pure logging, zero side
      // effects. Fires at CONTINUATION → TAKE_PROFIT transition when Binance
      // is consolidating (|Δ| < consolidationPct) AND PM yes-mid is extreme
      // (> extremeHigh or < extremeLow). Emits a JSONL event with full
      // context + a matching outcome event at slot resolution, so an
      // offline analyzer can compute win-rate and shadow PnL.
      shadowMeanReversionEnabled: parseBoolean(
        env.VS_SHADOW_MEAN_REVERSION_ENABLED,
        true
      ),
      shadowMrExtremeHigh: Math.max(
        0,
        Math.min(1, parseFloatOrDefault(env.VS_SHADOW_MR_EXTREME_HIGH, '0.65'))
      ),
      shadowMrExtremeLow: Math.max(
        0,
        Math.min(1, parseFloatOrDefault(env.VS_SHADOW_MR_EXTREME_LOW, '0.35'))
      ),
      shadowMrConsolidationPct: Math.max(
        0,
        parseFloatOrDefault(env.VS_SHADOW_MR_CONSOLIDATION_PCT, '0.02')
      ),
      shadowMrLookbackMs: Math.max(
        1_000,
        parseFloatOrDefault(env.VS_SHADOW_MR_LOOKBACK_MS, '15000')
      ),
      shadowMrSize: Math.max(
        0,
        parseFloatOrDefault(env.VS_SHADOW_MR_SIZE, '3')
      ),
      // Phase 58P: shadow-divergence-skip logger. Each time 58L aborts an
      // ACCUMULATE entry due to PM-FV divergence exceeding threshold, log
      // what we DIDN'T take. Outcome event at resolution tells us whether
      // our guard was correct (shadow loss) or too tight (shadow profit).
      shadowDivergenceSkipEnabled: parseBoolean(
        env.VS_SHADOW_DIVERGENCE_SKIP_ENABLED,
        true
      ),
      shadowDivergenceSize: Math.max(
        0,
        parseFloatOrDefault(env.VS_SHADOW_DIVERGENCE_SIZE, '6')
      ),
    },
    paperTrading: {
      enabled: parseBoolean(env.PAPER_TRADING_ENABLED, false),
      initialBalanceUsd: parseFloatOrDefault(env.PAPER_TRADING_INITIAL_BALANCE, '100'),
      tradeLogFile: (
        env.PAPER_TRADING_TRADE_LOG || `${reportsDir}/paper-trades.jsonl`
      ).trim() || `${reportsDir}/paper-trades.jsonl`,
      makerFeeRate: parseFloatOrDefault(env.PAPER_TRADING_MAKER_FEE_RATE, '0'),
      takerFeeRate: parseFloatOrDefault(env.PAPER_TRADING_TAKER_FEE_RATE, '0.02'),
      makerOrderTtlMs: Math.max(
        1000,
        // Phase 43b: reduced default from 300s (entire slot!) to 60s.
        // Stale maker orders that sit 2-3 minutes fill at terrible prices
        // and immediately hit hard-stop, causing unnecessary losses.
        parseIntOrDefault(env.PAPER_TRADING_MAKER_ORDER_TTL_MS, '60000')
      ),
      minOrderNotionalUsd: parseFloatOrDefault(env.PAPER_TRADING_MIN_ORDER_NOTIONAL, '1'),
      // Legacy fields — kept for backward compat, not used in new fill logic
      simulatedLatencyMinMs: Math.max(
        0,
        parseIntOrDefault(env.PAPER_TRADING_LATENCY_MIN_MS, '400')
      ),
      simulatedLatencyMaxMs: Math.max(
        0,
        parseIntOrDefault(env.PAPER_TRADING_LATENCY_MAX_MS, '1500')
      ),
      fillProbability: {
        passive: parseFloatOrDefault(env.PAPER_TRADING_FILL_PROB_PASSIVE, '0.40'),
        improve: parseFloatOrDefault(env.PAPER_TRADING_FILL_PROB_IMPROVE, '0.65'),
        cross: parseFloatOrDefault(env.PAPER_TRADING_FILL_PROB_CROSS, '0.95'),
      },
      slippageModel: {
        maxSlippageTicks: Math.max(
          0,
          parseIntOrDefault(env.PAPER_TRADING_MAX_SLIPPAGE_TICKS, '2')
        ),
        sizeImpactFactor: parseFloatOrDefault(
          env.PAPER_TRADING_SIZE_IMPACT_FACTOR,
          '0.5'
        ),
      },
      partialFillEnabled: parseBoolean(env.PAPER_TRADING_PARTIAL_FILLS, true),
      minFillRatio: parseFloatOrDefault(env.PAPER_TRADING_MIN_FILL_RATIO, '0.30'),
    },
    evKelly: {
      enabled: parseBoolean(env.EV_KELLY_ENABLED, false),
      minEVThreshold: parseFloatOrDefault(env.EV_MIN_THRESHOLD, '0.005'),
      minEVThresholdHighFee: parseFloatOrDefault(env.EV_MIN_THRESHOLD_HIGH_FEE, '0.008'),
      kellyFraction: parseFloatOrDefault(env.KELLY_FRACTION, '0.85'),
      maxBankrollPerTrade: parseFloatOrDefault(env.MAX_BANKROLL_PER_TRADE, '0.20'),
      preferMakerOrders: parseBoolean(env.PREFER_MAKER_ORDERS, true),
      defaultTakerFee: parseFloatOrDefault(env.DEFAULT_TAKER_FEE, '0.02'),
      highFeeTakerFee: parseFloatOrDefault(env.HIGH_FEE_TAKER_FEE, '0.0315'),
    },
    compounding: {
      enabled: parseBoolean(env.COMPOUNDING_ENABLED, false),
      baseRiskPct: clamp(parseFloatOrDefault(env.COMPOUNDING_BASE_RISK_PCT, '0.008'), 0.001, 0.05),
      maxSlotExposurePct: clamp(
        parseFloatOrDefault(env.COMPOUNDING_MAX_SLOT_EXPOSURE_PCT, '0.15'),
        0.05,
        0.30
      ),
      globalExposurePct: clamp(
        parseFloatOrDefault(env.COMPOUNDING_GLOBAL_EXPOSURE_PCT, '0.35'),
        0.10,
        0.60
      ),
      layerMultipliers: parseLayerMultipliers(env.COMPOUNDING_LAYER_MULTIPLIERS),
      drawdownGuardPct: clamp(
        parseFloatOrDefault(env.COMPOUNDING_DRAWDOWN_GUARD_PCT, '0.08'),
        0.02,
        0.25
      ),
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
      marketScanCacheMs: Math.max(
        0,
        parseIntOrDefault(env.MARKET_SCAN_CACHE_MS, '15000')
      ),
      maxConcurrentMarkets: Math.max(1, parseIntOrDefault(env.MAX_CONCURRENT_MARKETS, '6')),
      marketQueryLimit: Math.max(1, parseIntOrDefault(env.MARKET_QUERY_LIMIT, '80')),
      onlyFiveMinuteMarkets: parseBoolean(env.ONLY_FIVE_MINUTE_MARKETS, true),
      gracefulShutdownTimeoutMs: Math.max(
        1000,
        parseIntOrDefault(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, '12000')
      ),
      walletPositionRefreshMs: Math.max(
        5_000,
        parseIntOrDefault(env.WALLET_POSITION_REFRESH_MS, '30000')
      ),
      walletFundsRefreshMs: Math.max(
        5_000,
        parseIntOrDefault(env.WALLET_FUNDS_REFRESH_MS, '30000')
      ),
      walletFundsRefreshIntervalMs: Math.max(
        5_000,
        parseIntOrDefault(env.WALLET_FUNDS_REFRESH_INTERVAL_MS, '20000')
      ),
    },
    dashboard: {
      enabled: parseBoolean(env.DASHBOARD_ENABLED, false),
      port: Math.max(1, parseIntOrDefault(env.DASHBOARD_PORT, '3847')),
      host: (env.DASHBOARD_HOST || '0.0.0.0').trim(),
    },
    logging: {
      level: parseLogLevel(env.LOG_LEVEL),
      directory: (env.LOG_DIRECTORY || 'logs').trim(),
      logToFile: parseBoolean(env.LOG_TO_FILE, true),
    },
    binance: {
      edgeEnabled: parseBoolean(env.BINANCE_EDGE_ENABLED, false),
      symbols: parseStringCsv(
        env.BINANCE_SYMBOLS,
        'btcusdt,ethusdt,solusdt,xrpusdt,dogeusdt,bnbusdt,linkusdt'
      ),
      flatThreshold: parseFloatOrDefault(env.BINANCE_FLAT_THRESHOLD, '0.05'),
      strongThreshold: parseFloatOrDefault(env.BINANCE_STRONG_THRESHOLD, '0.20'),
      boostMultiplier: parseFloatOrDefault(env.BINANCE_BOOST_MULTIPLIER, '1.5'),
      reduceMultiplier: parseFloatOrDefault(env.BINANCE_REDUCE_MULTIPLIER, '0.5'),
      blockOnStrongContra: parseBoolean(env.BINANCE_BLOCK_STRONG_CONTRA, true),
      wsReconnectMs: Math.max(500, parseIntOrDefault(env.BINANCE_WS_RECONNECT_MS, '5000')),
      maxReconnectAttempts: Math.max(1, parseIntOrDefault(env.BINANCE_MAX_RECONNECT, '10')),
    },
  };

  return applyStrategyPreset(baseConfig);
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
  ownKeys() {
    return Reflect.ownKeys(getConfig() as object);
  },
  getOwnPropertyDescriptor(_target, property) {
    const descriptor = Object.getOwnPropertyDescriptor(getConfig() as object, property);
    if (!descriptor) {
      return undefined;
    }

    return {
      ...descriptor,
      configurable: true,
    };
  },
});

export function validateConfig(candidate: AppConfig = config): void {
  if (!isDryRunMode(candidate) && !isPaperTradingEnabled(candidate) && !candidate.signerPrivateKey) {
    throw new Error(
      'Missing signer private key. Set SIGNER_PRIVATE_KEY or PRIVATE_KEY for live trading.'
    );
  }

  if (candidate.auth.mode === 'PROXY' && !isDryRunMode(candidate) && !isPaperTradingEnabled(candidate)) {
    if (!candidate.auth.funderAddress) {
      throw new Error('FUNDER_ADDRESS is required in PROXY mode.');
    }
    if (candidate.auth.signatureType === undefined || candidate.auth.signatureType === 0) {
      throw new Error(
        'PROXY mode requires SIGNATURE_TYPE to be set to 1 (POLY_PROXY) or 2 (GNOSIS_SAFE).'
      );
    }
  }

  if (!isDryRunMode(candidate) && !isPaperTradingEnabled(candidate) && candidate.auth.mode === 'PROXY') {
    if (!candidate.POLYMARKET_API_KEY) {
      console.warn(
        'WARNING: POLYMARKET_API_KEY not set. Bot will attempt runtime derive (may fail with { privateKey } signer).'
      );
    }
    if (!candidate.POLYMARKET_RELAYER_KEY && candidate.AUTO_REDEEM) {
      console.warn(
        'WARNING: AUTO_REDEEM=true but POLYMARKET_RELAYER_KEY not set. Redeem will fail with 401.'
      );
    }
  }

  if (candidate.PRODUCT_TEST_MODE) {
    if (candidate.auth.mode !== 'PROXY') {
      throw new Error('PRODUCT_TEST_MODE requires AUTH_MODE=PROXY for safe live redeem coverage.');
    }

    if (!candidate.AUTO_REDEEM) {
      throw new Error('PRODUCT_TEST_MODE requires AUTO_REDEEM=true.');
    }
  }

  if (candidate.BAYESIAN_FV_ALPHA < 0 || candidate.BAYESIAN_FV_ALPHA > 1) {
    throw new Error('BAYESIAN_FV_ALPHA must be in the range [0, 1].');
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

  if (candidate.strategy.minEntryDepthUsd < 0) {
    throw new Error('MIN_ENTRY_DEPTH_USD must be zero or positive.');
  }

  if (candidate.strategy.maxEntrySpread <= 0) {
    throw new Error('MAX_ENTRY_SPREAD must be positive.');
  }

  if (candidate.strategy.maxEntrySpreadCombinedDiscount <= 0) {
    throw new Error('MAX_ENTRY_SPREAD_COMBINED_DISCOUNT must be positive.');
  }

  if (candidate.strategy.maxEntrySpreadExtreme <= 0) {
    throw new Error('MAX_ENTRY_SPREAD_EXTREME must be positive.');
  }

  if (candidate.strategy.maxEntrySpreadFairValue <= 0) {
    throw new Error('MAX_ENTRY_SPREAD_FAIR_VALUE must be positive.');
  }

  if (candidate.strategy.maxEntrySpreadRebalance <= 0) {
    throw new Error('MAX_ENTRY_SPREAD_REBALANCE must be positive.');
  }

  if (candidate.strategy.entryImbalanceBlockThreshold <= 0) {
    throw new Error('ENTRY_IMBALANCE_BLOCK_THRESHOLD must be positive.');
  }

  if (candidate.strategy.binanceFvSensitivity < 0) {
    throw new Error('BINANCE_FV_SENSITIVITY must be zero or positive.');
  }

  if (candidate.strategy.fairValueBuyMaxPerSlot < 1) {
    throw new Error('FV_BUY_MAX_PER_SLOT must be at least 1.');
  }

  if (candidate.strategy.fairValueBuyCooldownMs < 0) {
    throw new Error('FV_BUY_COOLDOWN_MS must be zero or positive.');
  }

  if (candidate.strategy.inventoryRebalanceFvBlockMs < 0) {
    throw new Error('INVENTORY_REBALANCE_FV_BLOCK_MS must be zero or positive.');
  }

  if (candidate.strategy.binanceFvDecayWindowMs < 1_000) {
    throw new Error('BINANCE_FV_DECAY_WINDOW_MS must be at least 1000.');
  }

  if (
    candidate.strategy.binanceFvDecayMinMultiplier <= 0 ||
    candidate.strategy.binanceFvDecayMinMultiplier > 1
  ) {
    throw new Error('BINANCE_FV_DECAY_MIN_MULTIPLIER must be in the range (0, 1].');
  }

  if (candidate.strategy.latencyPauseThresholdMs <= 0) {
    throw new Error('LATENCY_PAUSE_THRESHOLD_MS must be positive.');
  }

  if (candidate.strategy.latencyResumeThresholdMs <= 0) {
    throw new Error('LATENCY_RESUME_THRESHOLD_MS must be positive.');
  }

  if (
    candidate.strategy.latencyResumeThresholdMs >=
    candidate.strategy.latencyPauseThresholdMs
  ) {
    throw new Error(
      'LATENCY_RESUME_THRESHOLD_MS must be lower than LATENCY_PAUSE_THRESHOLD_MS.'
    );
  }

  if (candidate.strategy.latencyPauseWindowSize < 1) {
    throw new Error('LATENCY_PAUSE_WINDOW_SIZE must be at least 1.');
  }

  if (candidate.strategy.latencyPauseSampleTtlMs < 5_000) {
    throw new Error('LATENCY_PAUSE_SAMPLE_TTL_MS must be at least 5000.');
  }

  if (candidate.strategy.maxDrawdownUsdc >= 0) {
    throw new Error('MAX_DRAWDOWN_USDC must be negative.');
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

  if (
    candidate.pairedArbitrage.maxPairCost <= 0 ||
    candidate.pairedArbitrage.maxPairCost >= 1
  ) {
    throw new Error('PAIRED_ARB_MAX_PAIR_COST must be in the range (0, 1).');
  }

  if (candidate.pairedArbitrage.minNetEdge < 0) {
    throw new Error('PAIRED_ARB_MIN_NET_EDGE must be zero or positive.');
  }

  if (
    candidate.pairedArbitrage.maxSharesPerLeg <
    candidate.pairedArbitrage.minSharesPerLeg
  ) {
    throw new Error(
      'PAIRED_ARB_MAX_SHARES must be greater than or equal to PAIRED_ARB_MIN_SHARES.'
    );
  }

  if (candidate.pairedArbitrage.asyncMaxEntryPrice <= 0 || candidate.pairedArbitrage.asyncMaxEntryPrice >= 1) {
    throw new Error('PAIRED_ARB_ASYNC_MAX_ENTRY_PRICE must be in the range (0, 1).');
  }

  if (candidate.pairedArbitrage.asyncMinEdge < 0) {
    throw new Error('PAIRED_ARB_ASYNC_MIN_EDGE must be zero or positive.');
  }

  if (candidate.pairedArbitrage.asyncMaxWaitMs < 1_000) {
    throw new Error('PAIRED_ARB_ASYNC_MAX_WAIT_MS must be at least 1000.');
  }

  if (
    candidate.latencyMomentum.strongShares <
    candidate.latencyMomentum.baseShares
  ) {
    throw new Error(
      'LATENCY_MOMENTUM_STRONG_SHARES must be greater than or equal to LATENCY_MOMENTUM_BASE_SHARES.'
    );
  }

  if (candidate.latencyMomentum.pmMoveSensitivity <= 0) {
    throw new Error('LATENCY_MOMENTUM_PM_MOVE_SENSITIVITY must be positive.');
  }

  if (candidate.sniper.strongBinanceMovePct < candidate.sniper.minBinanceMovePct) {
    throw new Error(
      'SNIPER_STRONG_BINANCE_MOVE_PCT must be greater than or equal to SNIPER_MIN_BINANCE_MOVE_PCT.'
    );
  }

  if (candidate.sniper.strongShares < candidate.sniper.baseShares) {
    throw new Error(
      'SNIPER_STRONG_SHARES must be greater than or equal to SNIPER_BASE_SHARES.'
    );
  }

  if (candidate.sniper.maxPositionShares < candidate.sniper.baseShares) {
    throw new Error(
      'SNIPER_MAX_POSITION_SHARES must be greater than or equal to SNIPER_BASE_SHARES.'
    );
  }

  if (candidate.lottery.maxRiskUsdc <= 0) {
    throw new Error('LOTTERY_MAX_RISK_USDC must be positive.');
  }

  if (candidate.lottery.minCents <= 0 || candidate.lottery.minCents >= 1) {
    throw new Error('LOTTERY_MIN_CENTS must be in range (0, 1).');
  }

  if (candidate.lottery.maxCents <= candidate.lottery.minCents) {
    throw new Error('LOTTERY_MAX_CENTS must be greater than LOTTERY_MIN_CENTS.');
  }

  if (
    candidate.lottery.relativePriceFactor <= 0 ||
    candidate.lottery.relativePriceFactor > 1
  ) {
    throw new Error('LOTTERY_RELATIVE_PRICE_FACTOR must be in the range (0, 1].');
  }

  if (candidate.lottery.relativeMaxCents <= candidate.lottery.minCents) {
    throw new Error(
      'LOTTERY_RELATIVE_MAX_CENTS must be greater than LOTTERY_MIN_CENTS.'
    );
  }

  if (
    candidate.lottery.takeProfitMinCents <= 0 ||
    candidate.lottery.takeProfitMinCents >= 1
  ) {
    throw new Error('LOTTERY_TAKE_PROFIT_MIN_CENTS must be in range (0, 1).');
  }

  if (candidate.lottery.takeProfitMultiplier <= 1) {
    throw new Error('LOTTERY_TAKE_PROFIT_MULTIPLIER must be greater than 1.');
  }

  if (candidate.sniper.maxConcurrentSameDirection < 1) {
    throw new Error('SNIPER_MAX_CONCURRENT_SAME_DIRECTION must be at least 1.');
  }

  if (
    candidate.sniper.minEntryPrice <= 0 ||
    candidate.sniper.maxEntryPrice <= 0 ||
    candidate.sniper.maxEntryPrice >= 1 ||
    candidate.sniper.minEntryPrice >= candidate.sniper.maxEntryPrice
  ) {
    throw new Error(
      'SNIPER_MIN_ENTRY_PRICE and SNIPER_MAX_ENTRY_PRICE must be in the range (0, 1) with min < max.'
    );
  }

  if (candidate.sniper.takerFeePct < 0 || candidate.sniper.takerFeePct >= 1) {
    throw new Error('SNIPER_TAKER_FEE_PCT must be in the range [0, 1).');
  }

  if (candidate.sniper.minEdgeAfterFees < 0) {
    throw new Error('SNIPER_MIN_EDGE_AFTER_FEES must be zero or positive.');
  }

  if (candidate.sniper.minPmLagPct < 0) {
    throw new Error('SNIPER_MIN_PM_LAG must be zero or positive.');
  }

  if (candidate.sniper.velocityWindowMs < 1_000) {
    throw new Error('SNIPER_VELOCITY_WINDOW_MS must be at least 1000.');
  }

  if (candidate.sniper.minVelocityPctPerSec < 0) {
    throw new Error('SNIPER_MIN_VELOCITY_PCT_PER_SEC must be zero or positive.');
  }

  if (candidate.sniper.volatilityScale <= 0) {
    throw new Error('SNIPER_VOLATILITY_SCALE must be positive.');
  }

  if (candidate.paperTrading.initialBalanceUsd <= 0) {
    throw new Error('PAPER_TRADING_INITIAL_BALANCE must be positive.');
  }

  if (candidate.paperTrading.makerFeeRate < 0 || candidate.paperTrading.makerFeeRate > 0.1) {
    throw new Error('PAPER_TRADING_MAKER_FEE_RATE must be between 0 and 0.10.');
  }

  if (candidate.paperTrading.takerFeeRate < 0 || candidate.paperTrading.takerFeeRate > 0.1) {
    throw new Error('PAPER_TRADING_TAKER_FEE_RATE must be between 0 and 0.10.');
  }

  if (candidate.evKelly.minEVThreshold < 0 || candidate.evKelly.minEVThresholdHighFee < 0) {
    throw new Error('EV thresholds must be zero or positive.');
  }

  if (candidate.evKelly.kellyFraction < 0 || candidate.evKelly.kellyFraction > 1) {
    throw new Error('KELLY_FRACTION must be in the range [0, 1].');
  }

  if (
    candidate.evKelly.maxBankrollPerTrade <= 0 ||
    candidate.evKelly.maxBankrollPerTrade > 1
  ) {
    throw new Error('MAX_BANKROLL_PER_TRADE must be in the range (0, 1].');
  }

  if (
    candidate.evKelly.defaultTakerFee < 0 ||
    candidate.evKelly.highFeeTakerFee < 0 ||
    candidate.evKelly.highFeeTakerFee < candidate.evKelly.defaultTakerFee
  ) {
    throw new Error(
      'Taker fee configuration must be non-negative and HIGH_FEE_TAKER_FEE must be >= DEFAULT_TAKER_FEE.'
    );
  }

  if (candidate.TEST_MIN_TRADE_USDC <= 0) {
    throw new Error('TEST_MIN_TRADE_USDC must be positive.');
  }

  if (candidate.TEST_MAX_SLOTS < 1) {
    throw new Error('TEST_MAX_SLOTS must be at least 1.');
  }

  if (candidate.FILL_POLL_INTERVAL_MS < 500) {
    throw new Error('FILL_POLL_INTERVAL_MS must be at least 500.');
  }

  if (candidate.FILL_POLL_TIMEOUT_MS < 5_000) {
    throw new Error('FILL_POLL_TIMEOUT_MS must be at least 5000.');
  }

  if (candidate.FILL_CANCEL_BEFORE_END_MS < 10_000) {
    throw new Error('FILL_CANCEL_BEFORE_END_MS must be at least 10000.');
  }

  if (candidate.SELL_AFTER_FILL_DELAY_MS < 2_000) {
    throw new Error('SELL_AFTER_FILL_DELAY_MS must be at least 2000.');
  }

  if (candidate.QUOTING_INTERVAL_MS < 50) {
    throw new Error('QUOTING_INTERVAL_MS must be at least 50.');
  }

  if (candidate.runtime.marketScanCacheMs < 0) {
    throw new Error('MARKET_SCAN_CACHE_MS must be zero or positive.');
  }

  if (candidate.runtime.walletPositionRefreshMs < 5_000) {
    throw new Error('WALLET_POSITION_REFRESH_MS must be at least 5000.');
  }

  if (candidate.runtime.walletFundsRefreshMs < 5_000) {
    throw new Error('WALLET_FUNDS_REFRESH_MS must be at least 5000.');
  }

  if (candidate.MAX_IMBALANCE_PERCENT <= 0 || candidate.MAX_IMBALANCE_PERCENT > 100) {
    throw new Error('MAX_IMBALANCE_PERCENT must be in the range (0, 100].');
  }

  if (candidate.QUOTING_SPREAD_TICKS < 1) {
    throw new Error('QUOTING_SPREAD_TICKS must be at least 1.');
  }

  if (candidate.MM_MAX_GROSS_EXPOSURE_USD <= 0) {
    throw new Error('MM_MAX_GROSS_EXPOSURE_USD must be positive.');
  }

  if (candidate.MM_MAX_NET_DIRECTIONAL <= 0) {
    throw new Error('MM_MAX_NET_DIRECTIONAL must be positive.');
  }

  if (candidate.MM_QUOTE_SHARES < 6) {
    throw new Error('MM_QUOTE_SHARES must be at least 6.');
  }

  if (candidate.MM_MAX_QUOTE_SHARES < candidate.MM_QUOTE_SHARES) {
    throw new Error('MM_MAX_QUOTE_SHARES must be greater than or equal to MM_QUOTE_SHARES.');
  }

  if (
    candidate.MM_AUTONOMOUS_MIN_BID_PRICE < 0.01 ||
    candidate.MM_AUTONOMOUS_MIN_BID_PRICE >= 0.99
  ) {
    throw new Error('MM_AUTONOMOUS_MIN_BID_PRICE must be in the range [0.01, 0.99).');
  }

  if (
    candidate.MM_AUTONOMOUS_MAX_BID_PRICE <= 0.01 ||
    candidate.MM_AUTONOMOUS_MAX_BID_PRICE > 0.99
  ) {
    throw new Error('MM_AUTONOMOUS_MAX_BID_PRICE must be in the range (0.01, 0.99].');
  }

  if (candidate.MM_AUTONOMOUS_MIN_BID_PRICE >= candidate.MM_AUTONOMOUS_MAX_BID_PRICE) {
    throw new Error(
      'MM_AUTONOMOUS_MIN_BID_PRICE must be lower than MM_AUTONOMOUS_MAX_BID_PRICE.'
    );
  }

  if (candidate.MM_CANCEL_ALL_QUOTES_BEFORE_END_MS > candidate.MM_STOP_NEW_ENTRIES_BEFORE_END_MS) {
    throw new Error(
      'MM_CANCEL_ALL_QUOTES_BEFORE_END_MS must be less than or equal to MM_STOP_NEW_ENTRIES_BEFORE_END_MS.'
    );
  }

  if (candidate.MM_INVENTORY_SKEW_FACTOR < 0 || candidate.MM_INVENTORY_SKEW_FACTOR > 1) {
    throw new Error('MM_INVENTORY_SKEW_FACTOR must be in range [0, 1].');
  }

  if (candidate.MM_MIN_EDGE_AFTER_FEE < 0) {
    throw new Error('MM_MIN_EDGE_AFTER_FEE must be zero or positive.');
  }

  if (candidate.MM_MAKER_MIN_EDGE < 0) {
    throw new Error('MM_MAKER_MIN_EDGE must be zero or positive.');
  }

  if (candidate.MM_MIN_QUOTE_LIFETIME_MS < 0) {
    throw new Error('MM_MIN_QUOTE_LIFETIME_MS must be zero or positive.');
  }

  if (candidate.MM_REPRICE_DEADBAND_TICKS < 0) {
    throw new Error('MM_REPRICE_DEADBAND_TICKS must be zero or positive.');
  }

  if (candidate.MM_MIN_BOOK_DEPTH_USD < 0) {
    throw new Error('MM_MIN_BOOK_DEPTH_USD must be zero or positive.');
  }

  if (candidate.MM_TOXIC_FLOW_BLOCK_MOVE_PCT <= 0) {
    throw new Error('MM_TOXIC_FLOW_BLOCK_MOVE_PCT must be positive.');
  }

  if (candidate.MM_TOXIC_FLOW_CLEAR_MOVE_PCT <= 0) {
    throw new Error('MM_TOXIC_FLOW_CLEAR_MOVE_PCT must be positive.');
  }

  if (candidate.MM_TOXIC_FLOW_CLEAR_MOVE_PCT > candidate.MM_TOXIC_FLOW_BLOCK_MOVE_PCT) {
    throw new Error(
      'MM_TOXIC_FLOW_CLEAR_MOVE_PCT must be less than or equal to MM_TOXIC_FLOW_BLOCK_MOVE_PCT.'
    );
  }

  if (candidate.MM_TOXIC_FLOW_MICROPRICE_TICKS < 0) {
    throw new Error('MM_TOXIC_FLOW_MICROPRICE_TICKS must be zero or positive.');
  }

  if (candidate.MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS < 0) {
    throw new Error('MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS must be zero or positive.');
  }

  if (
    candidate.MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS > candidate.MM_TOXIC_FLOW_MICROPRICE_TICKS
  ) {
    throw new Error(
      'MM_TOXIC_FLOW_CLEAR_MICROPRICE_TICKS must be less than or equal to MM_TOXIC_FLOW_MICROPRICE_TICKS.'
    );
  }

  if (candidate.MM_TOXIC_FLOW_HOLD_MS < 0) {
    throw new Error('MM_TOXIC_FLOW_HOLD_MS must be zero or positive.');
  }

  if (candidate.MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS < 0) {
    throw new Error('MM_POST_ASK_ONLY_REENTRY_COOLDOWN_MS must be zero or positive.');
  }

  if (candidate.MM_SAME_SIDE_REENTRY_COOLDOWN_MS < 0) {
    throw new Error('MM_SAME_SIDE_REENTRY_COOLDOWN_MS must be zero or positive.');
  }

  if (candidate.MM_GROSS_REENTRY_THRESHOLD_CLIPS < 0) {
    throw new Error('MM_GROSS_REENTRY_THRESHOLD_CLIPS must be zero or positive.');
  }

  if (candidate.BINANCE_DEPTH_LEVELS < 1) {
    throw new Error('BINANCE_DEPTH_LEVELS must be at least 1.');
  }

  if (candidate.BINANCE_FUNDING_WEIGHT < 0) {
    throw new Error('BINANCE_FUNDING_WEIGHT must be zero or positive.');
  }

  if (candidate.MIN_BINANCE_SPREAD_THRESHOLD <= 0) {
    throw new Error('MIN_BINANCE_SPREAD_THRESHOLD must be positive.');
  }

  if (candidate.DYNAMIC_SPREAD_VOL_FACTOR <= 0) {
    throw new Error('DYNAMIC_SPREAD_VOL_FACTOR must be positive.');
  }

  if (candidate.BINANCE_FAIR_VALUE_WEIGHT < 0) {
    throw new Error('BINANCE_FAIR_VALUE_WEIGHT must be zero or positive.');
  }

  if (candidate.POLYMARKET_FAIR_VALUE_WEIGHT < 0) {
    throw new Error('POLYMARKET_FAIR_VALUE_WEIGHT must be zero or positive.');
  }

  if (
    candidate.BINANCE_FAIR_VALUE_WEIGHT === 0 &&
    candidate.POLYMARKET_FAIR_VALUE_WEIGHT === 0 &&
    candidate.BINANCE_FUNDING_WEIGHT === 0
  ) {
    throw new Error(
      'At least one of BINANCE_FAIR_VALUE_WEIGHT, POLYMARKET_FAIR_VALUE_WEIGHT, or BINANCE_FUNDING_WEIGHT must be positive.'
    );
  }
}

export function isDryRunMode(candidate: AppConfig = config): boolean {
  if (candidate.PRODUCT_TEST_MODE) {
    return false;
  }

  return candidate.SIMULATION_MODE || candidate.TEST_MODE || candidate.DRY_RUN;
}

export function isPaperTradingEnabled(candidate: AppConfig = config): boolean {
  return candidate.PAPER_TRADING_ENABLED && candidate.paperTrading.enabled;
}

export function isDynamicQuotingEnabled(candidate: AppConfig = config): boolean {
  return candidate.MARKET_MAKER_MODE && candidate.DYNAMIC_QUOTING_ENABLED;
}

export function isDeepBinanceEnabled(candidate: AppConfig = config): boolean {
  // Deep Binance is a standalone price feed used by:
  //   1. quoting-engine (only runs in MM mode anyway)
  //   2. OBI engine Binance runaway gate (runs in OBI standalone mode)
  // It must NOT require dynamic quoting to be enabled, otherwise the OBI
  // preset (which disables MM/quoting) can never use the Binance gate.
  return candidate.DEEP_BINANCE_MODE && candidate.BINANCE_WS_ENABLED;
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
