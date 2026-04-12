/**
 * Phase 36: Slot Replay Tracker
 *
 * Records price snapshots, entry/exit events, and resolution outcomes for
 * every traded slot. Writes a JSONL log (`reports/slot-replay_YYYY-MM-DD.jsonl`)
 * that enables post-session analysis:
 *
 *   - Did we exit too early / too late?
 *   - How much PnL did we leave on the table?
 *   - What was the optimal exit point?
 *   - Should we hold to resolution more often?
 *
 * Pure data collection — no trading decisions. Wired into index.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Outcome } from './clob-fetcher.js';
import type { SignalType } from './strategy-types.js';

/* ── Interfaces ─────────────────────────────────────────────────────── */

export interface SlotReplayEntry {
  ts: number;
  price: number;
  shares: number;
  outcome: Outcome;
  signalType: SignalType;
  binanceSpot: number | null;
  fairValue: number | null;
  timeLeftMs: number;
  phase?: 'MM' | 'MOMENTUM' | null;
}

export interface SlotReplayExit {
  ts: number;
  price: number;
  shares: number;
  outcome: Outcome;
  reason: string;
  signalType: SignalType;
  binanceSpot: number | null;
  fairValue: number | null;
  timeLeftMs: number;
}

export interface SlotReplaySnapshot {
  ts: number;
  timeLeftMs: number;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  binanceSpot: number | null;
  fairValue: number | null;
  obiRatio: number | null;
}

export interface SlotResolution {
  winner: 'YES' | 'NO' | null;
  resolvePrice: number;
  binanceFinal: number | null;
  checkedAtMs: number;
}

export type ExitTiming =
  | 'PERFECT'      // exit was correct — resolve would have been worse or same
  | 'EARLY_WIN'    // exited profitable, but holding would have given more
  | 'EARLY_LOSS'   // exited at loss, but resolve would have been profitable
  | 'SAVED'        // exited at loss (or small profit), resolve would have been worse
  | 'NO_EXIT'      // never exited — went to resolution
  | 'NO_ENTRY';    // tracked but never entered

export interface SlotReplayAnalysis {
  exitPnl: number;
  holdToResolvePnl: number | null;
  missedPnl: number | null;
  exitTiming: ExitTiming;
  bidAtT30s: number | null;
  bidAtT10s: number | null;
  bidAtT5s: number | null;
}

export interface SlotReplayRecord {
  coin: string | null;
  marketId: string;
  conditionId: string;
  slot: string;           // e.g. "22:45-22:50"
  startTime: string | null;
  endTime: string | null;
  strategy: 'OBI' | 'VS_ENGINE' | 'BOTH' | 'NONE';
  entries: SlotReplayEntry[];
  snapshots: SlotReplaySnapshot[];
  exits: SlotReplayExit[];
  resolution: SlotResolution | null;
  analysis: SlotReplayAnalysis | null;
}

/* ── Internal slot state ────────────────────────────────────────────── */

interface ActiveSlot {
  coin: string | null;
  marketId: string;
  conditionId: string;
  title: string;
  startTime: string | null;
  endTime: string | null;
  slotEndMs: number;
  strategy: 'OBI' | 'VS_ENGINE' | 'BOTH' | 'NONE';
  entries: SlotReplayEntry[];
  snapshots: SlotReplaySnapshot[];
  exits: SlotReplayExit[];
  lastSnapshotMs: number;
}

/* ── Tracker ────────────────────────────────────────────────────────── */

export class SlotReplayTracker {
  private readonly slots = new Map<string, ActiveSlot>();
  private logStream: fs.WriteStream | null = null;
  private currentDayKey = '';
  private readonly reportsDir: string;
  private readonly snapshotIntervalMs: number;

  /** Slots awaiting resolution check (marketId → partial record). */
  private readonly pendingResolution = new Map<string, {
    record: SlotReplayRecord;
    conditionId: string;
    scheduledAtMs: number;
  }>();

  constructor(params: {
    reportsDir: string;
    snapshotIntervalMs?: number;
  }) {
    this.reportsDir = params.reportsDir;
    this.snapshotIntervalMs = params.snapshotIntervalMs ?? 30_000;
  }

  /* ── Slot lifecycle ───────────────────────────────────────────────── */

  /**
   * Ensure a slot is being tracked. Called on every market tick.
   * Idempotent — only creates state on first call per marketId.
   */
  ensureSlot(params: {
    marketId: string;
    conditionId: string;
    title: string;
    coin: string | null;
    startTime: string | null;
    endTime: string | null;
  }): void {
    if (this.slots.has(params.marketId)) return;
    const slotEndMs = params.endTime ? new Date(params.endTime).getTime() : Date.now() + 300_000;
    this.slots.set(params.marketId, {
      coin: params.coin,
      marketId: params.marketId,
      conditionId: params.conditionId,
      title: params.title,
      startTime: params.startTime,
      endTime: params.endTime,
      slotEndMs,
      strategy: 'NONE',
      entries: [],
      snapshots: [],
      exits: [],
      lastSnapshotMs: 0,
    });
  }

  /**
   * Record a price snapshot. Called from the main scan loop on every tick.
   * Respects snapshotIntervalMs to avoid flooding.
   */
  recordSnapshot(params: {
    marketId: string;
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
    binanceSpot: number | null;
    fairValue: number | null;
    obiRatio: number | null;
  }): void {
    const slot = this.slots.get(params.marketId);
    if (!slot) return;

    const now = Date.now();
    if (now - slot.lastSnapshotMs < this.snapshotIntervalMs) return;

    slot.lastSnapshotMs = now;
    slot.snapshots.push({
      ts: now,
      timeLeftMs: Math.max(0, slot.slotEndMs - now),
      yesBid: params.yesBid,
      yesAsk: params.yesAsk,
      noBid: params.noBid,
      noAsk: params.noAsk,
      binanceSpot: params.binanceSpot,
      fairValue: params.fairValue,
      obiRatio: params.obiRatio,
    });
  }

  /**
   * Record an entry fill.
   */
  recordEntry(params: {
    marketId: string;
    price: number;
    shares: number;
    outcome: Outcome;
    signalType: SignalType;
    binanceSpot: number | null;
    fairValue: number | null;
    phase?: 'MM' | 'MOMENTUM' | null;
    strategy: 'OBI' | 'VS_ENGINE';
  }): void {
    const slot = this.slots.get(params.marketId);
    if (!slot) return;

    const now = Date.now();
    slot.entries.push({
      ts: now,
      price: params.price,
      shares: params.shares,
      outcome: params.outcome,
      signalType: params.signalType,
      binanceSpot: params.binanceSpot,
      fairValue: params.fairValue,
      timeLeftMs: Math.max(0, slot.slotEndMs - now),
      phase: params.phase ?? null,
    });

    // Update strategy tag
    if (slot.strategy === 'NONE') {
      slot.strategy = params.strategy;
    } else if (slot.strategy !== params.strategy) {
      slot.strategy = 'BOTH';
    }
  }

  /**
   * Record an exit fill.
   */
  recordExit(params: {
    marketId: string;
    price: number;
    shares: number;
    outcome: Outcome;
    reason: string;
    signalType: SignalType;
    binanceSpot: number | null;
    fairValue: number | null;
  }): void {
    const slot = this.slots.get(params.marketId);
    if (!slot) return;

    const now = Date.now();
    slot.exits.push({
      ts: now,
      price: params.price,
      shares: params.shares,
      outcome: params.outcome,
      reason: params.reason,
      signalType: params.signalType,
      binanceSpot: params.binanceSpot,
      fairValue: params.fairValue,
      timeLeftMs: Math.max(0, slot.slotEndMs - now),
    });
  }

  /**
   * Finalize a slot — build the record, write to JSONL, schedule resolution check.
   * Called from clearPositionStateForMarket or when slot expires.
   */
  finalizeSlot(
    marketId: string,
    resolveCallback?: (conditionId: string) => Promise<{
      winner: 'YES' | 'NO' | null;
      binanceFinal: number | null;
    } | null>
  ): void {
    const slot = this.slots.get(marketId);
    if (!slot) return;

    // Only write slots that had at least one entry or snapshot
    if (slot.entries.length === 0 && slot.snapshots.length === 0) {
      this.slots.delete(marketId);
      return;
    }

    const record = this.buildRecord(slot);

    // If we have entries, try to get resolution later
    if (slot.entries.length > 0 && resolveCallback) {
      this.pendingResolution.set(marketId, {
        record,
        conditionId: slot.conditionId,
        scheduledAtMs: Date.now(),
      });
      // Schedule resolution check after 60s (slot needs time to resolve)
      setTimeout(() => {
        this.resolveAndWrite(marketId, resolveCallback).catch(() => {
          // If resolution fails, write without it
          this.writeRecord(record);
          this.pendingResolution.delete(marketId);
        });
      }, 60_000);
    } else {
      // No entries or no callback — write immediately without resolution
      this.writeRecord(record);
    }

    this.slots.delete(marketId);
  }

  /**
   * Check and resolve all pending resolution requests.
   * Called periodically from the main loop.
   */
  async flushPendingResolutions(
    resolveCallback: (conditionId: string) => Promise<{
      winner: 'YES' | 'NO' | null;
      binanceFinal: number | null;
    } | null>
  ): Promise<number> {
    let flushed = 0;
    const staleThresholdMs = 5 * 60_000; // 5 minutes max wait

    for (const [marketId, pending] of this.pendingResolution) {
      if (Date.now() - pending.scheduledAtMs < 45_000) continue; // too early

      try {
        const result = await resolveCallback(pending.conditionId);
        if (result && result.winner) {
          pending.record.resolution = {
            winner: result.winner,
            resolvePrice: result.winner === 'YES' ? 1.0 : 0.0,
            binanceFinal: result.binanceFinal,
            checkedAtMs: Date.now(),
          };
          pending.record.analysis = this.computeAnalysis(pending.record);
        } else if (Date.now() - pending.scheduledAtMs > staleThresholdMs) {
          // Stale — write without resolution
        } else {
          continue; // not resolved yet, keep waiting
        }
      } catch {
        if (Date.now() - pending.scheduledAtMs < staleThresholdMs) continue;
      }

      this.writeRecord(pending.record);
      this.pendingResolution.delete(marketId);
      flushed++;
    }

    return flushed;
  }

  /* ── Reset / cleanup ──────────────────────────────────────────────── */

  clearState(marketId?: string): void {
    if (marketId) {
      this.slots.delete(marketId);
      this.pendingResolution.delete(marketId);
    } else {
      // Full reset
      this.slots.clear();
      this.pendingResolution.clear();
    }
  }

  /** Number of actively tracked slots */
  get activeSlotCount(): number {
    return this.slots.size;
  }

  /** Number of slots awaiting resolution */
  get pendingResolutionCount(): number {
    return this.pendingResolution.size;
  }

  /* ── Record building ──────────────────────────────────────────────── */

  private buildRecord(slot: ActiveSlot): SlotReplayRecord {
    const slotLabel = this.formatSlotLabel(slot.startTime, slot.endTime);
    return {
      coin: slot.coin,
      marketId: slot.marketId,
      conditionId: slot.conditionId,
      slot: slotLabel,
      startTime: slot.startTime,
      endTime: slot.endTime,
      strategy: slot.strategy,
      entries: slot.entries,
      snapshots: slot.snapshots,
      exits: slot.exits,
      resolution: null,
      analysis: null,
    };
  }

  private computeAnalysis(record: SlotReplayRecord): SlotReplayAnalysis {
    const { entries, exits, resolution, snapshots } = record;

    // Calculate actual exit PnL
    let exitPnl = 0;
    for (const exit of exits) {
      const matchingEntry = this.findBestEntryMatch(entries, exit.outcome);
      if (matchingEntry) {
        exitPnl += (exit.price - matchingEntry.price) * exit.shares;
      }
    }

    // Calculate hold-to-resolve PnL
    let holdToResolvePnl: number | null = null;
    if (resolution && resolution.winner) {
      const resolvePrice = resolution.resolvePrice;
      holdToResolvePnl = 0;
      for (const entry of entries) {
        const held = entry.outcome === resolution.winner ? resolvePrice : 0;
        holdToResolvePnl += (held - entry.price) * entry.shares;
      }
    }

    // Determine exit timing
    let exitTiming: ExitTiming = 'NO_ENTRY';
    if (entries.length === 0) {
      exitTiming = 'NO_ENTRY';
    } else if (exits.length === 0) {
      exitTiming = 'NO_EXIT';
    } else if (holdToResolvePnl !== null) {
      const missedPnl = holdToResolvePnl - exitPnl;
      if (exitPnl >= 0 && missedPnl <= 0.05) {
        exitTiming = 'PERFECT';
      } else if (exitPnl >= 0 && holdToResolvePnl > exitPnl) {
        exitTiming = 'EARLY_WIN';
      } else if (exitPnl < 0 && holdToResolvePnl > 0) {
        exitTiming = 'EARLY_LOSS';
      } else if (holdToResolvePnl <= exitPnl) {
        exitTiming = 'SAVED';
      } else {
        exitTiming = 'PERFECT';
      }
    }

    // Find bids at key time points
    const endMs = record.endTime ? new Date(record.endTime).getTime() : 0;
    const entryOutcome = entries[0]?.outcome ?? 'YES';

    return {
      exitPnl: round4(exitPnl),
      holdToResolvePnl: holdToResolvePnl !== null ? round4(holdToResolvePnl) : null,
      missedPnl: holdToResolvePnl !== null ? round4(holdToResolvePnl - exitPnl) : null,
      exitTiming,
      bidAtT30s: this.findBidNearTime(snapshots, endMs - 30_000, entryOutcome),
      bidAtT10s: this.findBidNearTime(snapshots, endMs - 10_000, entryOutcome),
      bidAtT5s: this.findBidNearTime(snapshots, endMs - 5_000, entryOutcome),
    };
  }

  private findBestEntryMatch(
    entries: SlotReplayEntry[],
    outcome: Outcome
  ): SlotReplayEntry | null {
    // Find the entry that matches the outcome (VWAP-like: use first matching)
    return entries.find((e) => e.outcome === outcome) ?? entries[0] ?? null;
  }

  private findBidNearTime(
    snapshots: SlotReplaySnapshot[],
    targetMs: number,
    outcome: Outcome
  ): number | null {
    if (snapshots.length === 0 || targetMs <= 0) return null;
    let closest: SlotReplaySnapshot | null = null;
    let closestDiff = Infinity;
    for (const snap of snapshots) {
      const diff = Math.abs(snap.ts - targetMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = snap;
      }
    }
    if (!closest || closestDiff > 15_000) return null; // must be within 15s
    return outcome === 'YES' ? closest.yesBid : closest.noBid;
  }

  /* ── File I/O ─────────────────────────────────────────────────────── */

  private writeRecord(record: SlotReplayRecord): void {
    this.ensureStream();
    if (!this.logStream) return;
    try {
      this.logStream.write(JSON.stringify(record) + '\n');
    } catch { /* best effort */ }
  }

  private ensureStream(): void {
    const dayKey = this.getDayKey();
    if (dayKey !== this.currentDayKey) {
      this.closeStream();
      this.currentDayKey = dayKey;
      fs.mkdirSync(this.reportsDir, { recursive: true });
      const filePath = path.join(this.reportsDir, `slot-replay_${dayKey}.jsonl`);
      this.logStream = fs.createWriteStream(filePath, { flags: 'a' });
    }
  }

  private closeStream(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  private getDayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  private formatSlotLabel(startTime: string | null, endTime: string | null): string {
    if (!startTime || !endTime) return 'unknown';
    try {
      const start = new Date(startTime);
      const end = new Date(endTime);
      const hh1 = String(start.getUTCHours()).padStart(2, '0');
      const mm1 = String(start.getUTCMinutes()).padStart(2, '0');
      const hh2 = String(end.getUTCHours()).padStart(2, '0');
      const mm2 = String(end.getUTCMinutes()).padStart(2, '0');
      return `${hh1}:${mm1}-${hh2}:${mm2}`;
    } catch {
      return 'unknown';
    }
  }

  private async resolveAndWrite(
    marketId: string,
    resolveCallback: (conditionId: string) => Promise<{
      winner: 'YES' | 'NO' | null;
      binanceFinal: number | null;
    } | null>
  ): Promise<void> {
    const pending = this.pendingResolution.get(marketId);
    if (!pending) return;

    try {
      const result = await resolveCallback(pending.conditionId);
      if (result && result.winner) {
        pending.record.resolution = {
          winner: result.winner,
          resolvePrice: result.winner === 'YES' ? 1.0 : 0.0,
          binanceFinal: result.binanceFinal,
          checkedAtMs: Date.now(),
        };
        pending.record.analysis = this.computeAnalysis(pending.record);
      }
    } catch { /* write without resolution */ }

    this.writeRecord(pending.record);
    this.pendingResolution.delete(marketId);
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
