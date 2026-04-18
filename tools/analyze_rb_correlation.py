#!/usr/bin/env python3
"""
Phase A RB shadow — offline correlation analyzer.

Joins `vs_decision` entry events (with attached `rb` snapshot context) to
`Paper slot resolved` events by marketId, and reports four views:

  1. Entry outcome by RB trend alignment   (UP/DOWN x LONG/SHORT synth-side)
  2. Entry outcome by recent fakeout       (any fakeout_* event in last 60s)
  3. Entry outcome by CNT-count stretch    (count bucket: 0-2, 3-5, 6+)
  4. SKIP reasons x RB state heatmap       (frequency only; no outcome)

Each 2-outcome cell is reported with Wilson 95% CI so you can see whether
the observed edge is statistically meaningful.

Usage:
    python3 tools/analyze_rb_correlation.py logs
    python3 tools/analyze_rb_correlation.py /apps/polymarket-hft-scalper/logs
    python3 tools/analyze_rb_correlation.py logs --since 2026-04-18

Input: one or more `events_YYYY-MM-DD.jsonl` files (or a directory).
Output: stdout report. Safe to pipe to tee / head.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Wilson 95% CI
# ---------------------------------------------------------------------------


def wilson_ci(successes: int, total: int, z: float = 1.96) -> tuple[float, float, float]:
    """Return (point, lo, hi) as floats in [0,1]. Empty input -> (0, 0, 0)."""
    if total <= 0:
        return 0.0, 0.0, 0.0
    p = successes / total
    denom = 1.0 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    half = (z / denom) * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))
    return p, max(0.0, centre - half), min(1.0, centre + half)


def fmt_ci(successes: int, total: int) -> str:
    p, lo, hi = wilson_ci(successes, total)
    if total == 0:
        return "   n=0"
    return f"{p*100:5.1f}% [{lo*100:4.1f}, {hi*100:4.1f}]  n={total}"


# ---------------------------------------------------------------------------
# Event loading
# ---------------------------------------------------------------------------


@dataclass
class DecisionEvent:
    ts: str
    coin: str | None
    action: str
    phase: str
    reason: str
    market_id: str | None
    rb: dict[str, Any]


@dataclass
class ResolutionEvent:
    ts: str
    market_id: str
    pnl: float
    winning_outcome: str


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def collect_files(root: Path, since: str | None) -> list[Path]:
    if root.is_file():
        return [root]
    if not root.is_dir():
        sys.exit(f"Input not found: {root}")
    files = sorted(root.glob("events_*.jsonl"))
    if since is not None:
        files = [f for f in files if f.name >= f"events_{since}.jsonl"]
    return files


def load_events(files: list[Path]) -> tuple[list[DecisionEvent], list[ResolutionEvent]]:
    decisions: list[DecisionEvent] = []
    resolutions: list[ResolutionEvent] = []
    for f in files:
        for entry in iter_jsonl(f):
            ev = entry.get("event")
            ctx = entry.get("context") or {}
            ts = entry.get("timestamp", "")
            if ev == "vs_decision":
                rb = ctx.get("rb")
                if not isinstance(rb, dict):
                    continue
                decisions.append(DecisionEvent(
                    ts=ts,
                    coin=ctx.get("coin"),
                    action=str(ctx.get("action", "")),
                    phase=str(ctx.get("phase", "")),
                    reason=str(ctx.get("reason", "")),
                    market_id=ctx.get("marketId"),
                    rb=rb,
                ))
            elif entry.get("message") == "Paper slot resolved":
                mid = ctx.get("marketId")
                if not isinstance(mid, str):
                    continue
                try:
                    pnl = float(ctx.get("pnl", 0.0))
                except (TypeError, ValueError):
                    pnl = 0.0
                resolutions.append(ResolutionEvent(
                    ts=ts,
                    market_id=mid,
                    pnl=pnl,
                    winning_outcome=str(ctx.get("winningOutcome", "")),
                ))
    return decisions, resolutions


# ---------------------------------------------------------------------------
# Joining
# ---------------------------------------------------------------------------


def build_resolution_index(resolutions: list[ResolutionEvent]) -> dict[str, ResolutionEvent]:
    idx: dict[str, ResolutionEvent] = {}
    for r in resolutions:
        idx[r.market_id] = r  # last wins — resolutions are idempotent
    return idx


def joined_entries(
    decisions: list[DecisionEvent],
    res_idx: dict[str, ResolutionEvent],
) -> list[tuple[DecisionEvent, ResolutionEvent]]:
    out: list[tuple[DecisionEvent, ResolutionEvent]] = []
    for d in decisions:
        if d.action != "ENTRY":
            continue
        if not d.market_id:
            continue
        r = res_idx.get(d.market_id)
        if r is None:
            continue
        out.append((d, r))
    return out


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def win_of(pnl: float) -> bool:
    return pnl > 0.0


def report_header(title: str) -> None:
    print()
    print(title)
    print("-" * len(title))


def report_trend_alignment(rows: list[tuple[DecisionEvent, ResolutionEvent]]) -> None:
    """Was RB trend aligned with the entry's directional bias?

    We don't know strict directional bias from entry alone (YES vs NO is
    parametric), so we bucket by (rb_trend, won/lost, pnl_sum). This is a
    descriptive read: "do we win more when trend=UP at entry?"
    """
    report_header("1. Entry outcome by RB trend at decision time")
    buckets: dict[str, dict[str, Any]] = defaultdict(lambda: {"wins": 0, "n": 0, "pnl": 0.0})
    for d, r in rows:
        trend = d.rb.get("trend") or "UNKNOWN"
        b = buckets[trend]
        b["n"] += 1
        b["pnl"] += r.pnl
        if win_of(r.pnl):
            b["wins"] += 1
    if not buckets:
        print("  (no entries joined to resolutions)")
        return
    print(f"  {'trend':<10} {'wins/n':<10} {'WR Wilson95':<30} {'SumPnL':>10} {'avg':>8}")
    for trend, b in sorted(buckets.items()):
        avg = b["pnl"] / b["n"] if b["n"] else 0.0
        ci_str = fmt_ci(b["wins"], b["n"])
        print(f"  {trend:<10} {b['wins']}/{b['n']:<8} {ci_str:<30} {b['pnl']:>10.2f} {avg:>8.3f}")


def report_fakeout_recency(rows: list[tuple[DecisionEvent, ResolutionEvent]]) -> None:
    """Entries when lastEvent was a fakeout AND ageMs <= 60_000 vs rest."""
    report_header("2. Entry outcome by recent fakeout signal (<=60s)")
    buckets: dict[str, dict[str, Any]] = defaultdict(lambda: {"wins": 0, "n": 0, "pnl": 0.0})
    for d, r in rows:
        rb = d.rb
        last_type = rb.get("lastEventType")
        last_age = rb.get("lastEventAgeMs")
        fresh_fakeout = (
            isinstance(last_type, str)
            and last_type.startswith("fakeout_")
            and isinstance(last_age, (int, float))
            and last_age <= 60_000
        )
        key = "fakeout_<=60s" if fresh_fakeout else "no_recent_fakeout"
        b = buckets[key]
        b["n"] += 1
        b["pnl"] += r.pnl
        if win_of(r.pnl):
            b["wins"] += 1
    if not buckets:
        print("  (no entries joined to resolutions)")
        return
    print(f"  {'state':<22} {'wins/n':<10} {'WR Wilson95':<30} {'SumPnL':>10} {'avg':>8}")
    for k, b in sorted(buckets.items()):
        avg = b["pnl"] / b["n"] if b["n"] else 0.0
        ci_str = fmt_ci(b["wins"], b["n"])
        print(f"  {k:<22} {b['wins']}/{b['n']:<8} {ci_str:<30} {b['pnl']:>10.2f} {avg:>8.3f}")


def report_count_stretch(rows: list[tuple[DecisionEvent, ResolutionEvent]]) -> None:
    """RB 'count' bucket: channel persistence. Larger count = more stretched."""
    report_header("3. Entry outcome by RB count bucket (channel stretch)")

    def bucket(c: int) -> str:
        if c <= 2:
            return "0-2"
        if c <= 5:
            return "3-5"
        return "6+"

    buckets: dict[str, dict[str, Any]] = defaultdict(lambda: {"wins": 0, "n": 0, "pnl": 0.0})
    for d, r in rows:
        raw = d.rb.get("count")
        try:
            c = int(raw) if raw is not None else -1
        except (TypeError, ValueError):
            c = -1
        key = bucket(c) if c >= 0 else "unknown"
        b = buckets[key]
        b["n"] += 1
        b["pnl"] += r.pnl
        if win_of(r.pnl):
            b["wins"] += 1
    if not buckets:
        print("  (no entries joined to resolutions)")
        return
    print(f"  {'count':<10} {'wins/n':<10} {'WR Wilson95':<30} {'SumPnL':>10} {'avg':>8}")
    for k in ("0-2", "3-5", "6+", "unknown"):
        if k not in buckets:
            continue
        b = buckets[k]
        avg = b["pnl"] / b["n"] if b["n"] else 0.0
        ci_str = fmt_ci(b["wins"], b["n"])
        print(f"  {k:<10} {b['wins']}/{b['n']:<8} {ci_str:<30} {b['pnl']:>10.2f} {avg:>8.3f}")


def report_skip_heatmap(decisions: list[DecisionEvent]) -> None:
    """Frequency: (skip_reason_head x rb_trend). No outcome (skips aren't resolved)."""
    report_header("4. SKIP reason x RB trend (frequency heatmap)")
    grid: dict[tuple[str, str], int] = defaultdict(int)
    reasons_seen: set[str] = set()
    trends_seen: set[str] = set()
    for d in decisions:
        if d.action != "SKIP":
            continue
        reason_head = d.reason.split()[0] if d.reason else "unknown"
        reason_head = reason_head.split("(")[0]  # strip "(1/2)" etc.
        trend = d.rb.get("trend") or "UNKNOWN"
        grid[(reason_head, trend)] += 1
        reasons_seen.add(reason_head)
        trends_seen.add(trend)
    if not grid:
        print("  (no SKIP decisions logged)")
        return
    trends = sorted(trends_seen)
    header = f"  {'reason':<34}" + "".join(f"{t:>10}" for t in trends) + f"{'Sum':>8}"
    print(header)
    for reason in sorted(reasons_seen, key=lambda r: -sum(grid[(r, t)] for t in trends)):
        row_sum = sum(grid[(reason, t)] for t in trends)
        cells = "".join(f"{grid[(reason, t)]:>10d}" for t in trends)
        print(f"  {reason:<34}{cells}{row_sum:>8d}")


def report_summary(
    decisions: list[DecisionEvent],
    resolutions: list[ResolutionEvent],
    joined: list[tuple[DecisionEvent, ResolutionEvent]],
) -> None:
    report_header("Summary")
    entries = sum(1 for d in decisions if d.action == "ENTRY")
    skips = sum(1 for d in decisions if d.action == "SKIP")
    exits = sum(1 for d in decisions if d.action == "EXIT")
    with_rb = sum(1 for d in decisions if d.rb.get("available") is True)
    print(f"  vs_decision events : {len(decisions):>6}  (entries={entries}, skips={skips}, exits={exits})")
    print(f"  rb available flag  : {with_rb:>6}  ({(with_rb/len(decisions)*100) if decisions else 0:.1f}%)")
    print(f"  resolutions        : {len(resolutions):>6}")
    print(f"  joined (entry->res) : {len(joined):>6}")
    if joined:
        tot_pnl = sum(r.pnl for _, r in joined)
        wins = sum(1 for _, r in joined if win_of(r.pnl))
        print(f"  overall WR         : {fmt_ci(wins, len(joined))}")
        print(f"  overall SumPnL       : {tot_pnl:+.2f}  avg={tot_pnl/len(joined):+.3f}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("path", type=Path, help="logs directory or single jsonl file")
    p.add_argument("--since", metavar="YYYY-MM-DD", default=None,
                   help="include only events from this date onwards")
    args = p.parse_args()

    files = collect_files(args.path, args.since)
    if not files:
        sys.exit("No events_*.jsonl files found.")

    print(f"Scanning {len(files)} file(s)" + (f" since {args.since}" if args.since else "") + ":")
    for f in files[-10:]:
        print(f"  - {f.name}")
    if len(files) > 10:
        print(f"  ... ({len(files) - 10} earlier files omitted)")

    decisions, resolutions = load_events(files)
    res_idx = build_resolution_index(resolutions)
    joined = joined_entries(decisions, res_idx)

    report_summary(decisions, resolutions, joined)
    report_trend_alignment(joined)
    report_fakeout_recency(joined)
    report_count_stretch(joined)
    report_skip_heatmap(decisions)
    print()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        os._exit(0)
