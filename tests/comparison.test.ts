import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compareTrades,
  findLatestMatchingFile,
  loadTradesFromLog,
  normalizeOurTradeRecord,
  normalizeTargetTradeRecord,
  parseCliArgs,
} from '../comparison/compare-with-target.js';

test('parseCliArgs honors --hours and --tolerance overrides', () => {
  const parsed = parseCliArgs(['--hours=6', '--tolerance', '12']);

  assert.equal(parsed.hours, 6);
  assert.equal(parsed.toleranceSeconds, 12);
});

test('normalizeTargetTradeRecord parses copy-bot simulation schema', () => {
  const normalized = normalizeTargetTradeRecord({
    timestamp_ms: 1_763_001_200_000,
    market_condition_id: '0xabc123',
    market_title: 'Bitcoin Up or Down - sample slot',
    action: 'BUY',
    outcome: 'UP',
    token_price: 0.441,
    shares: 12,
    simulated_pnl_if_closed_now: 4.2,
    target_tx_hash_or_id: '0xtarget',
  });

  assert.ok(normalized);
  assert.equal(normalized?.marketConditionId, '0xabc123');
  assert.equal(normalized?.action, 'BUY');
  assert.equal(normalized?.outcome, 'YES');
  assert.equal(normalized?.price, 0.441);
  assert.equal(normalized?.pnl, 4.2);
});

test('normalizeOurTradeRecord parses scalper trade schema', () => {
  const normalized = normalizeOurTradeRecord({
    timestampMs: 1_763_001_203_000,
    marketId: '0xabc123',
    marketTitle: 'Bitcoin Up or Down - sample slot',
    action: 'BUY',
    outcome: 'YES',
    signalType: 'COMBINED_DISCOUNT_BUY_BOTH',
    tokenPrice: 0.444,
    shares: 11,
    totalPnl: 3.8,
  });

  assert.ok(normalized);
  assert.equal(normalized?.marketConditionId, '0xabc123');
  assert.equal(normalized?.signalType, 'COMBINED_DISCOUNT_BUY_BOTH');
  assert.equal(normalized?.price, 0.444);
  assert.equal(normalized?.pnl, 3.8);
});

test('compareTrades classifies matches and unmatched rows correctly', () => {
  const targetTrade = normalizeTargetTradeRecord({
    timestamp_ms: 1_763_001_200_000,
    market_condition_id: '0xabc123',
    market_title: 'Bitcoin Up or Down - sample slot',
    action: 'BUY',
    outcome: 'YES',
    token_price: 0.441,
    shares: 12,
    simulated_pnl_if_closed_now: 4.2,
  });
  const ourMatch = normalizeOurTradeRecord({
    timestampMs: 1_763_001_206_000,
    marketId: '0xabc123',
    marketTitle: 'Bitcoin Up or Down - sample slot',
    action: 'BUY',
    outcome: 'YES',
    signalType: 'FAIR_VALUE_BUY',
    tokenPrice: 0.447,
    shares: 11,
    totalPnl: 3.8,
  });
  const ourOnly = normalizeOurTradeRecord({
    timestampMs: 1_763_001_400_000,
    marketId: '0xdef456',
    marketTitle: 'Solana Up or Down - sample slot',
    action: 'SELL',
    outcome: 'NO',
    signalType: 'INVENTORY_REBALANCE',
    tokenPrice: 0.551,
    shares: 9,
    totalPnl: 1.1,
  });

  assert.ok(targetTrade);
  assert.ok(ourMatch);
  assert.ok(ourOnly);

  const result = compareTrades([targetTrade!], [ourMatch!, ourOnly!], 8);

  assert.equal(result.summary.matchCount, 1);
  assert.equal(result.summary.onlyOursCount, 1);
  assert.equal(result.summary.totalRows, 2);
  assert.equal(result.summary.matchRate, 0.5);
  assert.deepEqual(
    result.rows.map((row) => row.status).sort(),
    ['MATCH', 'ONLY_OURS']
  );
});

test('findLatestMatchingFile picks the newest matching log file', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comparison-logs-'));
  const logsDirectory = path.join(root, 'logs');
  await mkdir(logsDirectory, { recursive: true });

  const older = path.join(logsDirectory, 'trades_2026-03-17.jsonl');
  const newer = path.join(logsDirectory, 'trades_2026-03-18.jsonl');

  writeFileSync(older, '{}\n', 'utf8');
  writeFileSync(newer, '{}\n', 'utf8');
  await utimes(older, new Date('2026-03-17T00:00:00Z'), new Date('2026-03-17T00:00:00Z'));
  await utimes(newer, new Date('2026-03-18T00:00:00Z'), new Date('2026-03-18T00:00:00Z'));

  const latest = await findLatestMatchingFile([logsDirectory], ['trades_*.jsonl']);
  assert.equal(latest, newer);
});

test('loadTradesFromLog streams JSONL and ignores non-JSON noise', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comparison-jsonl-'));
  const filePath = path.join(root, 'trades_2026-03-18.jsonl');

  writeFileSync(
    filePath,
    [
      'noise line',
      JSON.stringify({
        timestamp_ms: 1_763_001_200_000,
        market_condition_id: '0xabc123',
        market_title: 'Bitcoin Up or Down - sample slot',
        action: 'BUY',
        outcome: 'YES',
        token_price: 0.441,
        shares: 12,
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  const trades = await loadTradesFromLog(filePath, 'target', 1_763_001_100_000);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.marketConditionId, '0xabc123');
});
