import type { OneSecondKline } from './aggregator.js';
import type { IndicatorLogger } from './logger.js';

const REST_DEFAULT_LIMIT = 1000;
const COURTESY_DELAY_MS = 100;

type RawKline = [
  number, // openTime
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // closeTime
  string, // quoteVolume
  number, // trades
  string, // takerBase
  string, // takerQuote
  string, // ignore
];

function parseKlines(raw: unknown): OneSecondKline[] {
  if (!Array.isArray(raw)) throw new Error('Binance response not an array');
  const out: OneSecondKline[] = [];
  for (const row of raw as RawKline[]) {
    out.push({
      openTime: row[0]!,
      closeTime: row[6]!,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    });
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BackfillOptions {
  readonly symbol: string;
  readonly interval: string;
  readonly bars: number;
  readonly restBase: string;
  readonly logger: IndicatorLogger;
  readonly perCallLimit?: number;
}

/**
 * Paginate /api/v3/klines backwards from now to fetch `bars` 1s klines.
 * Returns chronologically-ordered array (oldest first).
 */
export async function backfillKlines(opts: BackfillOptions): Promise<OneSecondKline[]> {
  const { symbol, interval, bars, restBase, logger } = opts;
  const limit = opts.perCallLimit ?? REST_DEFAULT_LIMIT;
  const collected: OneSecondKline[] = [];
  let endTime: number | undefined;
  let remaining = bars;
  let attempts = 0;
  const upperSymbol = symbol.toUpperCase();

  while (remaining > 0 && attempts < 50) {
    attempts += 1;
    const callLimit = Math.min(limit, remaining);
    const params = new URLSearchParams({
      symbol: upperSymbol,
      interval,
      limit: String(callLimit),
    });
    if (endTime !== undefined) params.set('endTime', String(endTime));
    const url = `${restBase}/api/v3/klines?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'range-indicator/1.0' },
      });
    } catch (err) {
      logger.warn('backfill_fetch_error', {
        symbol: upperSymbol,
        attempt: attempts,
        message: (err as Error).message,
      });
      await sleep(1000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('backfill_bad_status', {
        symbol: upperSymbol,
        status: res.status,
        bodySnippet: body.slice(0, 200),
      });
      if (res.status === 429 || res.status === 418) await sleep(5000);
      else await sleep(1000);
      continue;
    }

    let batch: OneSecondKline[];
    try {
      const raw = await res.json();
      batch = parseKlines(raw);
    } catch (err) {
      logger.warn('backfill_parse_error', {
        symbol: upperSymbol,
        message: (err as Error).message,
      });
      await sleep(1000);
      continue;
    }

    if (batch.length === 0) {
      logger.warn('backfill_empty_batch', { symbol: upperSymbol, endTime });
      break;
    }

    // prepend in chronological order
    collected.unshift(...batch);
    remaining -= batch.length;

    const oldest = batch[0]!;
    endTime = oldest.openTime - 1;

    await sleep(COURTESY_DELAY_MS);
  }

  logger.info('backfill_complete', {
    symbol: upperSymbol,
    barsRequested: bars,
    barsFetched: collected.length,
    calls: attempts,
  });
  return collected;
}
