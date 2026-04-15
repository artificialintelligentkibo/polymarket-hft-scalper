#!/usr/bin/env python3
"""
Analyze Phase 58P shadow-divergence-skip logger output.

For each ACCUMULATE skip triggered by the Phase 58L PM-FV divergence guard,
pair it with its matching resolution outcome and compute what the skip
would have earned (or lost) if we had taken the trade.

Usage:
    python3 tools/analyze_shadow_divergence_skips.py [LOGDIR]

A NEGATIVE net shadow PnL means the 58L guard is correct (we'd have lost
money by taking those trades). A POSITIVE net shadow PnL means the guard
is too tight — consider raising the divergence threshold.
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

    skips: dict[str, dict] = {}       # key = f"{marketId}:{outcome}"
    outcomes: dict[str, dict] = {}

    for ev, ctx in iter_events(pattern):
        if ev == "shadow_pm_fv_divergence_skip":
            key = f"{ctx.get('marketId')}:{ctx.get('outcome')}"
            skips[key] = ctx   # keep last occurrence
        elif ev == "shadow_pm_fv_divergence_skip_outcome":
            key = f"{ctx.get('marketId')}:{ctx.get('outcome')}"
            outcomes[key] = ctx

    matched: list[tuple[dict, dict]] = []
    pending: list[dict] = []
    for key, skip in skips.items():
        out = outcomes.get(key)
        if out is None:
            pending.append(skip)
        else:
            matched.append((skip, out))

    print("=" * 60)
    print("SHADOW PM-FV DIVERGENCE SKIP ANALYSIS")
    print("=" * 60)
    print(f"Log dir:  {log_dir}")
    print(f"Skips:    {len(skips)}")
    print(f"Resolved: {len(matched)}")
    print(f"Pending:  {len(pending)}")

    if not matched:
        print("\nNo resolved skips yet.")
        return 0

    # Bucket by divergence magnitude to see if the guard threshold is right.
    buckets: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    by_coin: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    by_vs_binance: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for skip, out in matched:
        div = float(skip.get("divergence", 0))
        if div < 0.12:
            label = "0.10-0.12"
        elif div < 0.15:
            label = "0.12-0.15"
        elif div < 0.20:
            label = "0.15-0.20"
        else:
            label = ">=0.20"
        buckets[label].append((skip, out))
        by_coin[skip.get("coin") or "?"].append((skip, out))
        against = skip.get("shadow_betting_against_binance")
        if against is None:
            against = out.get("shadow_betting_against_binance")
        bin_label = (
            "AGAINST_BINANCE" if against is True
            else "WITH_BINANCE" if against is False
            else "UNKNOWN"
        )
        by_vs_binance[bin_label].append((skip, out))

    def summarize(label: str, pairs: list[tuple[dict, dict]]) -> None:
        correct = sum(1 for _, o in pairs if o.get("shadow_correct"))
        pnl = sum(float(o.get("shadow_pnl", 0)) for _, o in pairs)
        cost = sum(float(s.get("shadow_cost", 0)) for s, _ in pairs)
        wr = correct / len(pairs) * 100 if pairs else 0.0
        roi = pnl / cost * 100 if cost > 0 else 0.0
        print(
            f"  {label:<16} n={len(pairs):>3}  "
            f"hits={correct:>3} ({wr:5.1f}%)  "
            f"pnl=${pnl:+.2f}  cost=${cost:.2f}  ROI={roi:+.1f}%"
        )

    print("\nBy divergence bucket:")
    for label in ["0.10-0.12", "0.12-0.15", "0.15-0.20", ">=0.20"]:
        if buckets.get(label):
            summarize(label, buckets[label])

    print("\nBy coin:")
    for coin in sorted(by_coin):
        summarize(coin, by_coin[coin])

    print("\nBy Binance alignment:")
    for label in ("AGAINST_BINANCE", "WITH_BINANCE", "UNKNOWN"):
        if by_vs_binance.get(label):
            summarize(label, by_vs_binance[label])

    total_correct = sum(1 for _, o in matched if o.get("shadow_correct"))
    total_pnl = sum(float(o.get("shadow_pnl", 0)) for _, o in matched)
    total_cost = sum(float(s.get("shadow_cost", 0)) for s, _ in matched)
    wr = total_correct / len(matched) * 100
    roi = total_pnl / total_cost * 100 if total_cost > 0 else 0.0

    print("\n" + "-" * 60)
    print("TOTAL")
    print(f"  n={len(matched)}  hits={total_correct} ({wr:.1f}%)")
    print(f"  net shadow PnL: ${total_pnl:+.2f}  (cost ${total_cost:.2f})")
    print(f"  per skip: ${total_pnl / len(matched):+.3f}")
    print(f"  ROI: {roi:+.1f}%")

    verdict: str
    if total_pnl < -0.5:
        verdict = "GUARD CORRECT — skipped trades were net losers."
    elif total_pnl > 0.5:
        verdict = (
            "GUARD TOO TIGHT — skipped trades were net profitable. "
            "Consider raising VS_ACCUMULATE_MAX_FV_MID_DIVERGENCE."
        )
    else:
        verdict = "INCONCLUSIVE — PnL near zero, keep collecting data."
    print(f"\nVerdict: {verdict}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
