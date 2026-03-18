import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  compareAsc,
  formatISO,
  isValid,
  parseISO,
  subHours,
} from 'date-fns';

type JsonRecord = Record<string, unknown>;
type TradeSource = 'target' | 'ours';
type TradeAction = 'BUY' | 'SELL' | 'UNKNOWN';
type TradeOutcome = 'YES' | 'NO' | 'UNKNOWN';
type ComparisonStatus = 'MATCH' | 'NEAR' | 'MISS' | 'ONLY_TARGET' | 'ONLY_OURS';

export interface CliOptions {
  readonly hours: number;
  readonly toleranceSeconds: number;
}

export interface NormalizedTrade {
  readonly source: TradeSource;
  readonly sourceFile: string;
  readonly timestamp: string;
  readonly timestampMs: number;
  readonly marketConditionId: string;
  readonly marketTitle: string;
  readonly action: TradeAction;
  readonly outcome: TradeOutcome;
  readonly signalType: string;
  readonly price: number | null;
  readonly shares: number | null;
  readonly pnl: number | null;
  readonly targetTxHash: string | null;
  readonly raw: JsonRecord;
}

export interface ComparisonRow {
  readonly marketTitle: string;
  readonly marketConditionId: string;
  readonly targetTime: string | null;
  readonly ourTime: string | null;
  readonly targetActionOutcome: string;
  readonly ourSignalType: string;
  readonly status: ComparisonStatus;
  readonly timeDiffSeconds: number | null;
  readonly priceDiff: number | null;
  readonly sharesDiff: number | null;
  readonly pnlDiff: number | null;
  readonly targetPrice: number | null;
  readonly ourPrice: number | null;
  readonly targetShares: number | null;
  readonly ourShares: number | null;
}

export interface ComparisonSummary {
  readonly totalRows: number;
  readonly targetCount: number;
  readonly ourCount: number;
  readonly matchCount: number;
  readonly nearCount: number;
  readonly missCount: number;
  readonly onlyTargetCount: number;
  readonly onlyOursCount: number;
  readonly matchedOrNearCount: number;
  readonly matchRate: number;
}

export interface ComparisonResult {
  readonly rows: ComparisonRow[];
  readonly summary: ComparisonSummary;
}

const DEFAULT_WINDOW_HOURS = 2;
const DEFAULT_TOLERANCE_SECONDS = 8;
const OUTPUT_DIRECTORY = path.resolve(process.cwd(), 'comparison', 'output');
const TARGET_PATTERNS = ['trades_*.jsonl'];
const OUR_PATTERNS = ['trades_*.jsonl', 'scalper_*.log'];
const DEFAULT_TARGET_LOG_ROOTS = [
  path.resolve(process.cwd(), '..', 'polymarket-copy-bot', 'logs'),
  '/home/node/.openclaw/workspace/polymarket-copy-bot/logs',
] as const;
const DEFAULT_OUR_LOG_ROOTS = [path.resolve(process.cwd(), 'logs')] as const;
const globRegexCache = new Map<string, RegExp>();

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let hours = DEFAULT_WINDOW_HOURS;
  let toleranceSeconds = DEFAULT_TOLERANCE_SECONDS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--hours=')) {
      hours = parsePositiveNumber(arg.slice('--hours='.length), DEFAULT_WINDOW_HOURS);
      continue;
    }
    if (arg === '--hours') {
      hours = parsePositiveNumber(argv[index + 1], DEFAULT_WINDOW_HOURS);
      index += 1;
      continue;
    }
    if (arg.startsWith('--tolerance=')) {
      toleranceSeconds = parsePositiveNumber(
        arg.slice('--tolerance='.length),
        DEFAULT_TOLERANCE_SECONDS
      );
      continue;
    }
    if (arg === '--tolerance') {
      toleranceSeconds = parsePositiveNumber(argv[index + 1], DEFAULT_TOLERANCE_SECONDS);
      index += 1;
    }
  }

  return {
    hours,
    toleranceSeconds,
  };
}

export async function findLatestMatchingFile(
  roots: readonly string[],
  patterns: readonly string[]
): Promise<string | null> {
  const candidates: Array<{ filePath: string; sortMs: number; mtimeMs: number }> = [];

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const stats = await tryStat(resolvedRoot);
    if (!stats) {
      continue;
    }

    if (stats.isFile()) {
      candidates.push({
        filePath: resolvedRoot,
        sortMs: extractLogDateMs(path.basename(resolvedRoot)) ?? stats.mtimeMs,
        mtimeMs: stats.mtimeMs,
      });
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    const entries = await readdir(resolvedRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!patterns.some((pattern) => matchGlob(entry.name, pattern))) {
        continue;
      }

      const filePath = path.join(resolvedRoot, entry.name);
      const fileStats = await stat(filePath);
      candidates.push({
        filePath,
        sortMs: extractLogDateMs(entry.name) ?? fileStats.mtimeMs,
        mtimeMs: fileStats.mtimeMs,
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.sortMs !== left.sortMs) {
      return right.sortMs - left.sortMs;
    }
    return right.mtimeMs - left.mtimeMs;
  });
  return candidates[0]?.filePath ?? null;
}

export async function loadTradesFromLog(
  filePath: string,
  source: TradeSource,
  sinceMs: number
): Promise<NormalizedTrade[]> {
  const trades: NormalizedTrade[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const input = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of input) {
      const record = parseJsonRecordFromLine(line);
      if (!record) {
        continue;
      }

      const normalized =
        source === 'target'
          ? normalizeTargetTradeRecord(record, filePath)
          : normalizeOurTradeRecord(record, filePath);

      if (!normalized || normalized.timestampMs < sinceMs) {
        continue;
      }

      trades.push(normalized);
    }
  } finally {
    input.close();
  }

  trades.sort((left, right) => left.timestampMs - right.timestampMs);
  return trades;
}

export function normalizeTargetTradeRecord(
  record: JsonRecord,
  sourceFile = 'target'
): NormalizedTrade | null {
  const marketConditionId = normalizeConditionId(
    firstString(record, ['market_condition_id', 'marketConditionId', 'conditionId', 'marketId'])
  );
  const timestampMs = extractTimestampMs(record, ['timestamp_ms', 'timestampMs'], ['timestamp']);
  if (!marketConditionId || timestampMs === null) {
    return null;
  }

  const simulatedPnl = firstNumber(record, ['simulated_pnl_if_closed_now']);
  const realizedPnl = firstNumber(record, ['realized_pnl_target']);
  const action = normalizeAction(record.action ?? record.side);
  const outcome = normalizeOutcome(record.resolved_outcome ?? record.outcome);

  return {
    source: 'target',
    sourceFile,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    marketConditionId,
    marketTitle:
      firstString(record, ['market_title', 'marketTitle', 'title']) || marketConditionId,
    action,
    outcome,
    signalType:
      firstString(record, ['signalType', 'signal_type']) || `${action}_${outcome}`,
    price: firstNumber(record, ['token_price', 'tokenPrice', 'price']),
    shares: firstNumber(record, ['shares']),
    pnl: simulatedPnl ?? realizedPnl,
    targetTxHash: firstString(record, ['target_tx_hash_or_id', 'target_tx_hash', 'txHash']) || null,
    raw: record,
  };
}

export function normalizeOurTradeRecord(
  record: JsonRecord,
  sourceFile = 'ours'
): NormalizedTrade | null {
  const marketConditionId = normalizeConditionId(
    firstString(record, ['marketId', 'market_condition_id', 'marketConditionId', 'conditionId'])
  );
  const timestampMs = extractTimestampMs(record, ['timestampMs', 'timestamp_ms'], ['timestamp']);
  if (!marketConditionId || timestampMs === null) {
    return null;
  }

  const action = normalizeAction(record.action ?? record.side);
  const outcome = normalizeOutcome(record.outcome);

  return {
    source: 'ours',
    sourceFile,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    marketConditionId,
    marketTitle:
      firstString(record, ['marketTitle', 'market_title', 'title']) || marketConditionId,
    action,
    outcome,
    signalType:
      firstString(record, ['signalType', 'signal_type', 'reason']) || `${action}_${outcome}`,
    price: firstNumber(record, ['tokenPrice', 'token_price', 'referencePrice', 'price']),
    shares: firstNumber(record, ['shares']),
    pnl: firstNumber(record, ['totalPnl', 'realizedPnl', 'unrealizedPnl', 'total_pnl']),
    targetTxHash: firstString(record, ['orderId', 'order_id', 'txHash']) || null,
    raw: record,
  };
}

export function compareTrades(
  targetTrades: readonly NormalizedTrade[],
  ourTrades: readonly NormalizedTrade[],
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): ComparisonResult {
  const sortedTargetTrades = [...targetTrades].sort((left, right) => left.timestampMs - right.timestampMs);
  const sortedOurTrades = [...ourTrades].sort((left, right) => left.timestampMs - right.timestampMs);
  const rows: ComparisonRow[] = [];
  const usedOurIndexes = new Set<number>();
  const ourIndexesByMarket = new Map<string, number[]>();

  sortedOurTrades.forEach((trade, index) => {
    const bucket = ourIndexesByMarket.get(trade.marketConditionId) ?? [];
    bucket.push(index);
    ourIndexesByMarket.set(trade.marketConditionId, bucket);
  });

  for (const targetTrade of sortedTargetTrades) {
    const marketIndexes = ourIndexesByMarket.get(targetTrade.marketConditionId) ?? [];
    let bestCandidateIndex = -1;
    let bestCandidateScore = Number.POSITIVE_INFINITY;

    for (const ourIndex of marketIndexes) {
      if (usedOurIndexes.has(ourIndex)) {
        continue;
      }

      const ourTrade = sortedOurTrades[ourIndex];
      const timeDiffSeconds = absoluteTimeDiffSeconds(targetTrade, ourTrade);
      if (timeDiffSeconds > toleranceSeconds) {
        continue;
      }

      const score = scoreCandidate(targetTrade, ourTrade, timeDiffSeconds);
      if (score < bestCandidateScore) {
        bestCandidateScore = score;
        bestCandidateIndex = ourIndex;
      }
    }

    if (bestCandidateIndex < 0) {
      rows.push(buildComparisonRow(targetTrade, null, 'ONLY_TARGET'));
      continue;
    }

    usedOurIndexes.add(bestCandidateIndex);
    const ourTrade = sortedOurTrades[bestCandidateIndex];
    rows.push(
      buildComparisonRow(
        targetTrade,
        ourTrade,
        classifyMatchStatus(targetTrade, ourTrade, toleranceSeconds)
      )
    );
  }

  sortedOurTrades.forEach((ourTrade, index) => {
    if (!usedOurIndexes.has(index)) {
      rows.push(buildComparisonRow(null, ourTrade, 'ONLY_OURS'));
    }
  });

  rows.sort((left, right) => compareRowTimestamps(left, right));

  return {
    rows,
    summary: summarizeComparison(rows, targetTrades.length, ourTrades.length),
  };
}

export function renderMarkdownTable(
  rows: readonly ComparisonRow[],
  summary: ComparisonSummary,
  metadata: {
    readonly targetLogPath: string;
    readonly ourLogPath: string;
    readonly hours: number;
    readonly toleranceSeconds: number;
  }
): string {
  const header = [
    '# Comparison with target wallet',
    '',
    `- Generated at: ${formatISO(new Date())}`,
    `- Target log: ${metadata.targetLogPath}`,
    `- Our log: ${metadata.ourLogPath}`,
    `- Lookback window: ${metadata.hours}h`,
    `- Time tolerance: ${metadata.toleranceSeconds}s`,
    `- Target trades: ${summary.targetCount}`,
    `- Our trades: ${summary.ourCount}`,
    `- Match rate: ${(summary.matchRate * 100).toFixed(2)}%`,
    `- Status counts: MATCH=${summary.matchCount}, NEAR=${summary.nearCount}, MISS=${summary.missCount}, ONLY_TARGET=${summary.onlyTargetCount}, ONLY_OURS=${summary.onlyOursCount}`,
    '',
    '| Market | Target Time | Our Time | Target | Our Signal | Price | Shares | Status | PnL Diff |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const body = rows.map(
    (row) =>
      `| ${sanitizeMarkdownCell(row.marketTitle)} | ${sanitizeMarkdownCell(
        row.targetTime ?? '-'
      )} | ${sanitizeMarkdownCell(row.ourTime ?? '-')} | ${sanitizeMarkdownCell(
        row.targetActionOutcome
      )} | ${sanitizeMarkdownCell(row.ourSignalType)} | ${sanitizeMarkdownCell(
        formatPriceComparison(row)
      )} | ${sanitizeMarkdownCell(formatSharesComparison(row))} | ${row.status} | ${sanitizeMarkdownCell(
        formatDiff(row.pnlDiff, 4)
      )} |`
  );

  return [...header, ...body, ''].join('\n');
}

export function buildCsv(rows: readonly ComparisonRow[]): string {
  const header = [
    'marketTitle',
    'marketConditionId',
    'targetTime',
    'ourTime',
    'targetActionOutcome',
    'ourSignalType',
    'priceComparison',
    'sharesComparison',
    'status',
    'pnlDiff',
    'timeDiffSeconds',
  ];
  const lines = [header.join(',')];

  for (const row of rows) {
    const values = [
      row.marketTitle,
      row.marketConditionId,
      row.targetTime ?? '',
      row.ourTime ?? '',
      row.targetActionOutcome,
      row.ourSignalType,
      formatPriceComparison(row),
      formatSharesComparison(row),
      row.status,
      row.pnlDiff === null ? '' : row.pnlDiff.toFixed(4),
      row.timeDiffSeconds === null ? '' : row.timeDiffSeconds.toString(),
    ];
    lines.push(values.map(escapeCsvCell).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const targetLogPath = await resolveTargetLogPath();
  const ourLogPath = await resolveOurLogPath();
  const sinceMs = subHours(new Date(), options.hours).getTime();

  if (!targetLogPath) {
    throw new Error(
      'Could not find a target trade log. Set COMPARISON_TARGET_LOG_PATH or place trades_*.jsonl in ../polymarket-copy-bot/logs.'
    );
  }

  if (!ourLogPath) {
    throw new Error(
      'Could not find a scalper log in ./logs/trades_*.jsonl or ./logs/scalper_*.log.'
    );
  }

  console.log(`[compare] Target log: ${targetLogPath}`);
  console.log(`[compare] Our log: ${ourLogPath}`);
  console.log(
    `[compare] Window: last ${options.hours}h | tolerance: ${options.toleranceSeconds}s`
  );

  const [targetTrades, ourTrades] = await Promise.all([
    loadTradesFromLog(targetLogPath, 'target', sinceMs),
    loadTradesFromLog(ourLogPath, 'ours', sinceMs),
  ]);

  console.log(
    `[compare] Loaded ${targetTrades.length} target trades and ${ourTrades.length} scalper trades in window`
  );

  const result = compareTrades(targetTrades, ourTrades, options.toleranceSeconds);
  console.table(
    result.rows.map((row) => ({
      Market: truncateForConsole(row.marketTitle),
      'Target Time': row.targetTime ?? '-',
      'Our Time': row.ourTime ?? '-',
      'Target Action': row.targetActionOutcome,
      'Our Signal': row.ourSignalType,
      Price: formatPriceComparison(row),
      Shares: formatSharesComparison(row),
      Status: row.status,
      'PnL Diff': formatDiff(row.pnlDiff, 4),
    }))
  );
  console.log(
    `[compare] Match rate: ${(result.summary.matchRate * 100).toFixed(2)}% ` +
      `(${result.summary.matchedOrNearCount}/${result.summary.totalRows})`
  );
  console.log(
    `[compare] Status counts: MATCH=${result.summary.matchCount}, ` +
      `NEAR=${result.summary.nearCount}, MISS=${result.summary.missCount}, ` +
      `ONLY_TARGET=${result.summary.onlyTargetCount}, ONLY_OURS=${result.summary.onlyOursCount}`
  );

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(OUTPUT_DIRECTORY, 'last_comparison.csv'),
      buildCsv(result.rows),
      'utf8'
    ),
    writeFile(
      path.join(OUTPUT_DIRECTORY, 'last_comparison.md'),
      renderMarkdownTable(result.rows, result.summary, {
        targetLogPath,
        ourLogPath,
        hours: options.hours,
        toleranceSeconds: options.toleranceSeconds,
      }),
      'utf8'
    ),
  ]);

  console.log(
    `[compare] Wrote ${path.join(OUTPUT_DIRECTORY, 'last_comparison.csv')} and ${path.join(
      OUTPUT_DIRECTORY,
      'last_comparison.md'
    )}`
  );
}

function compareRowTimestamps(left: ComparisonRow, right: ComparisonRow): number {
  const leftDate = parseOptionalTimestamp(left.targetTime ?? left.ourTime);
  const rightDate = parseOptionalTimestamp(right.targetTime ?? right.ourTime);
  if (!leftDate || !rightDate) {
    return 0;
  }
  return compareAsc(leftDate, rightDate);
}

function summarizeComparison(
  rows: readonly ComparisonRow[],
  targetCount: number,
  ourCount: number
): ComparisonSummary {
  let matchCount = 0;
  let nearCount = 0;
  let missCount = 0;
  let onlyTargetCount = 0;
  let onlyOursCount = 0;

  for (const row of rows) {
    if (row.status === 'MATCH') {
      matchCount += 1;
    } else if (row.status === 'NEAR') {
      nearCount += 1;
    } else if (row.status === 'MISS') {
      missCount += 1;
    } else if (row.status === 'ONLY_TARGET') {
      onlyTargetCount += 1;
    } else {
      onlyOursCount += 1;
    }
  }

  const totalRows = rows.length;
  const matchedOrNearCount = matchCount + nearCount;

  return {
    totalRows,
    targetCount,
    ourCount,
    matchCount,
    nearCount,
    missCount,
    onlyTargetCount,
    onlyOursCount,
    matchedOrNearCount,
    matchRate: totalRows > 0 ? matchedOrNearCount / totalRows : 0,
  };
}

function buildComparisonRow(
  targetTrade: NormalizedTrade | null,
  ourTrade: NormalizedTrade | null,
  status: ComparisonStatus
): ComparisonRow {
  return {
    marketTitle:
      targetTrade?.marketTitle ||
      ourTrade?.marketTitle ||
      targetTrade?.marketConditionId ||
      ourTrade?.marketConditionId ||
      'UNKNOWN',
    marketConditionId:
      targetTrade?.marketConditionId || ourTrade?.marketConditionId || 'unknown-market',
    targetTime: targetTrade?.timestamp ?? null,
    ourTime: ourTrade?.timestamp ?? null,
    targetActionOutcome: targetTrade ? `${targetTrade.action} ${targetTrade.outcome}` : '-',
    ourSignalType: ourTrade?.signalType || '-',
    status,
    timeDiffSeconds:
      targetTrade && ourTrade ? absoluteTimeDiffSeconds(targetTrade, ourTrade) : null,
    priceDiff: differenceIfPresent(targetTrade?.price ?? null, ourTrade?.price ?? null),
    sharesDiff: differenceIfPresent(targetTrade?.shares ?? null, ourTrade?.shares ?? null),
    pnlDiff: differenceIfPresent(targetTrade?.pnl ?? null, ourTrade?.pnl ?? null),
    targetPrice: targetTrade?.price ?? null,
    ourPrice: ourTrade?.price ?? null,
    targetShares: targetTrade?.shares ?? null,
    ourShares: ourTrade?.shares ?? null,
  };
}

function classifyMatchStatus(
  targetTrade: NormalizedTrade,
  ourTrade: NormalizedTrade,
  toleranceSeconds: number
): ComparisonStatus {
  const timeDiffSeconds = absoluteTimeDiffSeconds(targetTrade, ourTrade);
  const sameAction =
    targetTrade.action !== 'UNKNOWN' &&
    ourTrade.action !== 'UNKNOWN' &&
    targetTrade.action === ourTrade.action;
  const sameOutcome =
    targetTrade.outcome !== 'UNKNOWN' &&
    ourTrade.outcome !== 'UNKNOWN' &&
    targetTrade.outcome === ourTrade.outcome;
  const priceDiff = absoluteNullableDifference(targetTrade.price, ourTrade.price);
  const sharesDiff = absoluteNullableDifference(targetTrade.shares, ourTrade.shares);
  const sharesBaseline = Math.max(targetTrade.shares ?? 0, ourTrade.shares ?? 0, 1);
  const priceTight = priceDiff === null || priceDiff <= 0.01;
  const priceLoose = priceDiff === null || priceDiff <= 0.03;
  const sharesTight = sharesDiff === null || sharesDiff <= Math.max(2, sharesBaseline * 0.25);
  const sharesLoose = sharesDiff === null || sharesDiff <= Math.max(5, sharesBaseline * 0.5);

  if (timeDiffSeconds <= toleranceSeconds && sameAction && sameOutcome && priceTight && sharesTight) {
    return 'MATCH';
  }

  if (
    timeDiffSeconds <= toleranceSeconds &&
    (sameAction || sameOutcome) &&
    priceLoose &&
    sharesLoose
  ) {
    return 'NEAR';
  }

  return 'MISS';
}

function scoreCandidate(
  targetTrade: NormalizedTrade,
  ourTrade: NormalizedTrade,
  timeDiffSeconds: number
): number {
  const actionPenalty =
    targetTrade.action !== 'UNKNOWN' &&
    ourTrade.action !== 'UNKNOWN' &&
    targetTrade.action !== ourTrade.action
      ? 25
      : 0;
  const outcomePenalty =
    targetTrade.outcome !== 'UNKNOWN' &&
    ourTrade.outcome !== 'UNKNOWN' &&
    targetTrade.outcome !== ourTrade.outcome
      ? 20
      : 0;
  const pricePenalty = absoluteNullableDifference(targetTrade.price, ourTrade.price) ?? 0;
  const sharesPenalty =
    (absoluteNullableDifference(targetTrade.shares, ourTrade.shares) ?? 0) / 10;

  return timeDiffSeconds + actionPenalty + outcomePenalty + pricePenalty + sharesPenalty;
}

function absoluteTimeDiffSeconds(left: NormalizedTrade, right: NormalizedTrade): number {
  return Math.abs(left.timestampMs - right.timestampMs) / 1000;
}

function differenceIfPresent(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return right - left;
}

function absoluteNullableDifference(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return Math.abs(right - left);
}

function formatPriceComparison(row: ComparisonRow): string {
  return `${formatNullableNumber(row.targetPrice, 4)} -> ${formatNullableNumber(
    row.ourPrice,
    4
  )} (${formatDiff(row.priceDiff, 4)})`;
}

function formatSharesComparison(row: ComparisonRow): string {
  return `${formatNullableNumber(row.targetShares, 4)} -> ${formatNullableNumber(
    row.ourShares,
    4
  )} (${formatDiff(row.sharesDiff, 4)})`;
}

function formatNullableNumber(value: number | null, decimals: number): string {
  return value === null ? '-' : value.toFixed(decimals);
}

function formatDiff(value: number | null, decimals: number): string {
  if (value === null) {
    return '-';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}

function truncateForConsole(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function sanitizeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeCsvCell(value: string): string {
  const escaped = value.replaceAll('"', '""');
  const guarded = /^[=+\-@]/.test(escaped) ? `'${escaped}` : escaped;
  return `"${guarded}"`;
}

async function resolveTargetLogPath(): Promise<string | null> {
  const envPath = process.env.COMPARISON_TARGET_LOG_PATH?.trim();
  if (envPath) {
    const explicit = await findLatestMatchingFile([envPath], TARGET_PATTERNS);
    if (explicit) {
      return explicit;
    }
  }

  return findLatestMatchingFile(DEFAULT_TARGET_LOG_ROOTS, TARGET_PATTERNS);
}

async function resolveOurLogPath(): Promise<string | null> {
  return findLatestMatchingFile(DEFAULT_OUR_LOG_ROOTS, OUR_PATTERNS);
}

function parseJsonRecordFromLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = new Set<string>([trimmed]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.add(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractTimestampMs(
  record: JsonRecord,
  numericKeys: readonly string[],
  stringKeys: readonly string[]
): number | null {
  for (const key of numericKeys) {
    const value = firstNumber(record, [key]);
    if (value !== null) {
      if (value > 1_000_000_000_000) {
        return Math.round(value);
      }
      if (value > 1_000_000_000) {
        return Math.round(value * 1000);
      }
    }
  }

  for (const key of stringKeys) {
    const parsed = parseOptionalTimestamp(firstString(record, [key]));
    if (parsed) {
      return parsed.getTime();
    }
  }

  return null;
}

function parseOptionalTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = parseISO(value);
  if (isValid(parsed)) {
    return parsed;
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function normalizeConditionId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAction(value: unknown): TradeAction {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'BUY') {
    return 'BUY';
  }
  if (normalized === 'SELL') {
    return 'SELL';
  }
  return 'UNKNOWN';
}

function normalizeOutcome(value: unknown): TradeOutcome {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'YES' || normalized === 'UP' || normalized === 'TRUE' || normalized === 'LONG') {
    return 'YES';
  }
  if (normalized === 'NO' || normalized === 'DOWN' || normalized === 'FALSE' || normalized === 'SHORT') {
    return 'NO';
  }
  return 'UNKNOWN';
}

function firstString(record: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function matchGlob(fileName: string, pattern: string): boolean {
  let regex = globRegexCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    regex = new RegExp(`^${escaped}$`, 'i');
    globRegexCache.set(pattern, regex);
  }
  return regex.test(fileName);
}

function extractLogDateMs(fileName: string): number | null {
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }

  const parsed = parseISO(`${match[1]}T00:00:00Z`);
  return isValid(parsed) ? parsed.getTime() : null;
}

async function tryStat(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  return pathToFileURL(path.resolve(entrypoint)).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  void main().catch((error) => {
    console.error('[compare] Failed to compare trade logs');
    console.error(error);
    process.exitCode = 1;
  });
}
