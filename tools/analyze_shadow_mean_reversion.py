#!/usr/bin/env python3
"""
Analyze Phase 58O shadow-mean-reversion logger output.

Scans ``logs/events_*.jsonl`` (default) and pairs each
``shadow_mean_reversion`` opportunity with its matching
``shadow_mean_reversion_outcome`` via ``marketId``.

Usage:
    python3 tools/analyze_shadow_mean_reversion.py [LOGDIR]

If LOGDIR is omitted, ``./logs`` is used.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from glob import glob


def iter_events(pattern: str):
    for path in sorted(glob(pattern)):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ctx = entry.get("context") or {}
                    ev = ctx.get("event")
                    if ev:
                        yield ev, ctx
        except OSError:
            continue


def main() -> int:
    log_dir = sys.argv[1] if len(sys.argv) > 1 else "logs"
    pattern = os.path.join(log_dir, "events_*.jsonl")

    opps: dict[str, dict] = {}
    outcomes: dict[str, dict] = {}

    for ev, ctx in iter_events(pattern):
        if ev == "shadow_mean_reversion":
            mid = ctx.get("marketId")
            if mid:
                opps[mid] = ctx
        elif ev == "shadow_mean_reversion_outcome":
            mid = ctx.get("marketId")
            if mid:
                outcomes[mid] = ctx

    matched: list[tuple[dict, dict]] = []
    pending: list[dict] = []
    for mid, opp in opps.items():
        out = outcomes.get(mid)
        if out is None:
            pending.append(opp)
        else:
            matched.append((opp, out))

    print("=" * 60)
    print("SHADOW MEAN-REVERSION ANALYSIS")
    print("=" * 60)
    print(f"Log dir:      {log_dir}")
    print(f"Opportunities: {len(opps)}")
    print(f"Resolved:      {len(matched)}")
    print(f"Pending:       {len(pending)}")

    if not matched:
        print("\nNo resolved opportunities yet.")
        return 0

    by_side: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    by_coin: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    by_vs_binance: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for opp, out in matched:
        side = opp.get("extreme_side") or "UNKNOWN"
        coin = opp.get("coin") or "?"
        by_side[side].append((opp, out))
        by_coin[coin].append((opp, out))
        # Prefer the value recorded on the opportunity event; fall back to
        # the outcome event in case only one side carries the field.
        against = opp.get("shadow_betting_against_binance")
        if against is None:
            against = out.get("shadow_betting_against_binance")
        label = (
            "AGAINST_BINANCE" if against is True
            else "WITH_BINANCE" if against is False
            else "UNKNOWN"
        )
        by_vs_binance[label].append((opp, out))

    def summarize(label: str, pairs: list[tuple[dict, dict]]) -> tuple[int, float]:
        correct = sum(1 for _, o in pairs if o.get("shadow_correct"))
        pnl = sum(float(o.get("shadow_pnl", 0)) for _, o in pairs)
        avg_entry = (
            sum(float(o.get("shadow_entry_price", 0)) for _, o in pairs) / len(pairs)
            if pairs
            else 0.0
        )
        wr = correct / len(pairs) * 100 if pairs else 0.0
        print(
            f"  {label:<16} n={len(pairs):>3}  "
            f"hits={correct:>3} ({wr:5.1f}%)  "
            f"avg_entry={avg_entry:.3f}  "
            f"pnl=${pnl:+.2f}"
        )
        return correct, pnl

    print("\nBy extreme side:")
    for side in sorted(by_side):
        summarize(side, by_side[side])

    print("\nBy coin:")
    for coin in sorted(by_coin):
        summarize(coin, by_coin[coin])

    print("\nBy Binance alignment:")
    for label in ("AGAINST_BINANCE", "WITH_BINANCE", "UNKNOWN"):
        if by_vs_binance.get(label):
            summarize(label, by_vs_binance[label])

    total_correct = sum(1 for _, o in matched if o.get("shadow_correct"))
    total_pnl = sum(float(o.get("shadow_pnl", 0)) for _, o in matched)
    wr = total_correct / len(matched) * 100
    per_opp = total_pnl / len(matched)
    total_cost = sum(float(opp.get("shadow_cost", 0)) for opp, _ in matched)

    print("\n" + "-" * 60)
    print("TOTAL")
    print(f"  n={len(matched)}  hits={total_correct} ({wr:.1f}%)")
    print(f"  net shadow PnL: ${total_pnl:+.2f}")
    print(f"  per opportunity: ${per_opp:+.3f}")
    print(f"  total capital deployed (shadow): ${total_cost:.2f}")
    if total_cost > 0:
        print(f"  ROI: {total_pnl / total_cost * 100:+.1f}%")

    # Breakeven reference: if entry is e, need WR >= e to break even.
    avg_entry = (
        sum(float(opp.get("shadow_entry_price", 0)) for opp, _ in matched)
        / len(matched)
    )
    print(f"  avg shadow entry: {avg_entry:.3f}  "
          f"→ breakeven WR: {avg_entry * 100:.1f}%")

    return 0


if __name__ == "__main__":
    sys.exit(main())
