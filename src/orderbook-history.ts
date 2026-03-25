import type { MarketOrderbookSnapshot } from './clob-fetcher.js';

export interface OrderbookSnapshotPoint {
  readonly timestampMs: number;
  readonly book: MarketOrderbookSnapshot;
}

export class OrderbookHistory {
  private readonly snapshots = new Map<string, OrderbookSnapshotPoint[]>();

  constructor(private readonly maxAgeMs = 30_000) {}

  record(marketId: string, book: MarketOrderbookSnapshot, timestampMs = Date.now()): void {
    const points = this.snapshots.get(marketId) ?? [];
    points.push({
      timestampMs,
      book,
    });
    this.snapshots.set(marketId, this.prunePoints(points, timestampMs));
  }

  getAt(marketId: string, timestampMs: number): MarketOrderbookSnapshot | null {
    const points = this.snapshots.get(marketId);
    if (!points || points.length === 0) {
      return null;
    }

    const pruned = this.prunePoints(points, Date.now());
    this.snapshots.set(marketId, pruned);

    let best: OrderbookSnapshotPoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const point of pruned) {
      const distance = Math.abs(point.timestampMs - timestampMs);
      if (distance <= bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }

    return best?.book ?? null;
  }

  getLatest(marketId: string): MarketOrderbookSnapshot | null {
    const points = this.snapshots.get(marketId);
    if (!points || points.length === 0) {
      return null;
    }

    const pruned = this.prunePoints(points, Date.now());
    this.snapshots.set(marketId, pruned);
    return pruned.at(-1)?.book ?? null;
  }

  clear(marketId: string): void {
    this.snapshots.delete(marketId);
  }

  clearAll(): void {
    this.snapshots.clear();
  }

  private prunePoints(
    points: readonly OrderbookSnapshotPoint[],
    nowMs: number
  ): OrderbookSnapshotPoint[] {
    const cutoffMs = nowMs - this.maxAgeMs;
    return points.filter((point) => point.timestampMs >= cutoffMs);
  }
}
