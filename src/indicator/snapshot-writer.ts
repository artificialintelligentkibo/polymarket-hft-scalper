import { DatabaseSync } from 'node:sqlite';
import type { LevelRow, LevelSnapshot, RangeEvent } from './types.js';

const LEVELS_DDL = `
CREATE TABLE IF NOT EXISTS levels (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  value REAL NOT NULL,
  value_upper REAL NOT NULL,
  value_lower REAL NOT NULL,
  value_upper_mid REAL NOT NULL,
  value_lower_mid REAL NOT NULL,
  trend INTEGER NOT NULL,
  count INTEGER NOT NULL,
  cross_upper INTEGER NOT NULL,
  cross_lower INTEGER NOT NULL,
  reset_now INTEGER NOT NULL,
  last_bar_close_ts INTEGER NOT NULL,
  fresh INTEGER NOT NULL,
  PRIMARY KEY(ts, symbol)
);
CREATE INDEX IF NOT EXISTS idx_levels_symbol_ts ON levels(symbol, ts DESC);

CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  event_type TEXT NOT NULL,
  price REAL NOT NULL,
  level_ref REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_symbol_ts ON events(symbol, ts DESC);
`;

export interface SnapshotStoreOptions {
  readonly dbPath: string;
}

export class SnapshotStore {
  private readonly db: DatabaseSync;
  private readonly insertLevelStmt;
  private readonly insertEventStmt;
  private readonly cache: Map<string, LevelSnapshot> = new Map();

  constructor(opts: SnapshotStoreOptions) {
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(LEVELS_DDL);
    this.insertLevelStmt = this.db.prepare(
      `INSERT OR REPLACE INTO levels
        (ts, symbol, value, value_upper, value_lower, value_upper_mid, value_lower_mid,
         trend, count, cross_upper, cross_lower, reset_now, last_bar_close_ts, fresh)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (ts, symbol, event_type, price, level_ref) VALUES (?, ?, ?, ?, ?)`,
    );
  }

  insertLevelRow(row: LevelRow): void {
    this.insertLevelStmt.run(
      row.ts,
      row.symbol,
      row.value,
      row.valueUpper,
      row.valueLower,
      row.valueUpperMid,
      row.valueLowerMid,
      row.trend ? 1 : 0,
      row.count,
      row.crossUpper ? 1 : 0,
      row.crossLower ? 1 : 0,
      row.resetNow ? 1 : 0,
      row.lastBarCloseTs,
      row.fresh ? 1 : 0,
    );
    this.cache.set(row.symbol, {
      symbol: row.symbol,
      ts: row.ts,
      lastBarCloseTs: row.lastBarCloseTs,
      fresh: row.fresh,
      barsProcessed: row.barsProcessed,
      value: row.value,
      valueUpper: row.valueUpper,
      valueLower: row.valueLower,
      valueUpperMid: row.valueUpperMid,
      valueLowerMid: row.valueLowerMid,
      trend: row.trend,
      count: row.count,
      lastCrossUpper: row.lastCrossUpper,
      lastCrossLower: row.lastCrossLower,
    });
  }

  insertEvent(ev: RangeEvent): void {
    this.insertEventStmt.run(ev.ts, ev.symbol, ev.eventType, ev.price, ev.levelRef);
  }

  getCached(symbol: string): LevelSnapshot | undefined {
    return this.cache.get(symbol);
  }

  listCachedSymbols(): string[] {
    return [...this.cache.keys()];
  }

  queryEvents(symbol: string, since: number, limit: number): RangeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT ts, symbol, event_type AS eventType, price, level_ref AS levelRef
         FROM events WHERE symbol = ? AND ts >= ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(symbol, since, limit);
    return (rows as unknown as RangeEvent[]).map((r) => ({
      ts: Number(r.ts),
      symbol: String(r.symbol),
      eventType: r.eventType,
      price: Number(r.price),
      levelRef: Number(r.levelRef),
    }));
  }

  deleteLevelsOlderThan(tsMs: number): number {
    const info = this.db.prepare('DELETE FROM levels WHERE ts < ?').run(tsMs);
    return Number(info.changes ?? 0);
  }

  deleteEventsOlderThan(tsMs: number): number {
    const info = this.db.prepare('DELETE FROM events WHERE ts < ?').run(tsMs);
    return Number(info.changes ?? 0);
  }

  countLevels(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM levels').get() as { n: number };
    return r.n;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}
