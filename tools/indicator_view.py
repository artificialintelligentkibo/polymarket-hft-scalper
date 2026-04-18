#!/usr/bin/env python3
"""Terminal viewer for the range-indicator HTTP service.

Usage:
  python3 tools/indicator_view.py            # snapshot of current levels (all 6 coins)
  python3 tools/indicator_view.py events     # latest 20 events across all coins
  python3 tools/indicator_view.py BTCUSDT    # raw JSON for a single coin
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:7788"
SYMBOLS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BNBUSDT", "SOLUSDT", "DOGEUSDT"]


def fetch(path: str):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=3) as r:
        return json.loads(r.read())


def fmt_price(x: float) -> str:
    if x >= 1000:
        return f"{x:,.2f}"
    if x >= 1:
        return f"{x:.4f}"
    return f"{x:.6f}"


def show_levels():
    health = fetch("/health")
    print(f"health: ok={health['ok']}  ws={health['wsConnected']}")
    print()
    cols = ["SYMBOL", "TR", "VALUE", "UPPER", "UP_MID", "LOW_MID", "LOWER", "CNT", "FRESH", "LAST_BAR_UTC"]
    widths = [8, 3, 13, 13, 13, 13, 13, 4, 5, 12]
    header = "  ".join(c.ljust(w) for c, w in zip(cols, widths))
    print(header)
    print("-" * len(header))
    for s in SYMBOLS:
        try:
            d = fetch(f"/levels/{s}")
        except Exception as e:
            print(f"{s:<8}  ERROR {e}")
            continue
        trend = "UP" if d["trend"] else "DN"
        ts = time.strftime("%H:%M:%SZ", time.gmtime(d["lastBarCloseTs"] / 1000))
        row = [
            d["symbol"],
            trend,
            fmt_price(d["value"]),
            fmt_price(d["valueUpper"]),
            fmt_price(d["valueUpperMid"]),
            fmt_price(d["valueLowerMid"]),
            fmt_price(d["valueLower"]),
            str(d["count"]),
            "yes" if d["fresh"] else "NO",
            ts,
        ]
        print("  ".join(c.ljust(w) for c, w in zip(row, widths)))


def show_events():
    since = int(time.time() * 1000) - 60 * 60 * 1000  # last 60 min
    rows = []
    for s in SYMBOLS:
        try:
            evs = fetch(f"/events/{s}?since={since}&limit=50")
        except Exception:
            continue
        rows.extend(evs)
    rows.sort(key=lambda r: r["ts"], reverse=True)
    rows = rows[:20]
    cols = ["TIME_UTC", "SYMBOL", "EVENT", "PRICE", "LEVEL_REF"]
    widths = [12, 8, 14, 13, 13]
    header = "  ".join(c.ljust(w) for c, w in zip(cols, widths))
    print(f"last 20 events (window 60min):")
    print(header)
    print("-" * len(header))
    for r in rows:
        ts = time.strftime("%H:%M:%SZ", time.gmtime(r["ts"] / 1000))
        row = [ts, r["symbol"], r["eventType"], fmt_price(r["price"]), fmt_price(r["levelRef"])]
        print("  ".join(c.ljust(w) for c, w in zip(row, widths)))


def show_single(sym: str):
    print(json.dumps(fetch(f"/levels/{sym}"), indent=2))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "events":
        show_events()
    elif arg and arg.upper() in SYMBOLS:
        show_single(arg.upper())
    else:
        show_levels()


if __name__ == "__main__":
    main()
