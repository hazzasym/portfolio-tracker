#!/usr/bin/env python3
"""One-off (re-runnable) backfill of history.json from the investment date.

Reconstructs daily portfolio value, per-class composition, and benchmark price
levels from `meta.investmentDate` to today using Yahoo's historical daily
closes. Holdings/units are fixed (from portfolio.json), so the reconstruction
is accurate. Missing days per symbol (market holidays) are forward-filled.

Run once after deploying; the daily job keeps extending history.json afterward.
"""
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTFOLIO = os.path.join(ROOT, "portfolio.json")
HISTORY = os.path.join(ROOT, "history.json")
HEADERS = {"User-Agent": "Mozilla/5.0 (portfolio-tracker)"}


def hist_closes(symbol, period1, period2):
    """Return {YYYY-MM-DD: close} of daily closes for a Yahoo symbol."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?period1={period1}&period2={period2}&interval=1d"
    )
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.load(resp)
            result = data["chart"]["result"][0]
            ts = result.get("timestamp") or []
            closes = result["indicators"]["quote"][0].get("close") or []
            out = {}
            for t, c in zip(ts, closes):
                if c is None:
                    continue
                d = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
                out[d] = float(c)
            return out
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    print(f"  ! failed history for {symbol}: {last_err}")
    return {}


def main():
    with open(PORTFOLIO, "r", encoding="utf-8") as f:
        portfolio = json.load(f)
    meta = portfolio["meta"]
    oz_per_baht = meta.get("ozPerBahtWeight", 0.490147)
    start = datetime.strptime(meta["investmentDate"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    period1 = int(start.timestamp()) - 86400  # pad a day to be safe
    period2 = int(datetime.now(timezone.utc).timestamp()) + 86400

    us_th = [h for h in portfolio["holdings"] if h["market"] in ("US", "TH")]
    series = {}
    for h in us_th:
        print(f"History {h['symbol']} ...")
        series[h["symbol"]] = hist_closes(h["symbol"], period1, period2)
    print("History THB=X ...")
    fx = hist_closes("THB=X", period1, period2)
    print("History GC=F ...")
    gold = hist_closes("GC=F", period1, period2)
    print("History ^SET.BK ...")
    setidx = hist_closes("^SET.BK", period1, period2)

    voo = next((h for h in portfolio["holdings"] if h["ticker"] == "VOO"), None)
    gold_h = next((h for h in portfolio["holdings"] if h["market"] == "GOLD"), None)

    all_dates = set(fx) | set(gold) | set(setidx)
    for d in series.values():
        all_dates |= set(d)
    # Iterate ALL dates (incl. days just before the investment date) so the
    # forward-fill is seeded; only emit points from the investment date on.
    all_dates = sorted(all_dates)
    start_str = meta["investmentDate"]

    last = {sym: None for sym in series}
    last_fx = last_gold = last_set = None
    points = []
    for d in all_dates:
        for sym, sdict in series.items():
            if d in sdict:
                last[sym] = sdict[d]
        if d in fx:
            last_fx = fx[d]
        if d in gold:
            last_gold = gold[d]
        if d in setidx:
            last_set = setidx[d]
        if d < start_str:
            continue
        # Only emit once every needed series has a value to forward-fill from.
        if last_fx is None or last_gold is None or any(v is None for v in last.values()):
            continue

        total = 0.0
        by_class = {}
        for h in portfolio["holdings"]:
            mk, cls = h["market"], h.get("class", h["market"])
            if mk == "CASH":
                v = h["buyValueTHB"]
            elif mk == "GOLD":
                v = last_gold * oz_per_baht * last_fx * h["units"]
            elif mk == "US":
                v = last[h["symbol"]] * last_fx * h["units"]
            elif mk == "TH":
                v = last[h["symbol"]] * h["units"]
            else:
                v = h["buyValueTHB"]
            total += v
            by_class[cls] = round(by_class.get(cls, 0.0) + v, 2)

        sp500_thb = last[voo["symbol"]] * last_fx if voo else None
        gold_thb = last_gold * oz_per_baht * last_fx
        points.append({
            "date": d,
            "totalValueTHB": round(total, 2),
            "usdthb": last_fx,
            "complete": True,
            "byClass": by_class,
            "benchmarks": {"sp500THB": round(sp500_thb, 4) if sp500_thb else None,
                           "goldTHB": round(gold_thb, 4),
                           "setTHB": round(last_set, 4) if last_set else None},
        })

    # Merge with any existing live points (live wins for matching dates).
    existing = {}
    if os.path.exists(HISTORY):
        with open(HISTORY, "r", encoding="utf-8") as f:
            for p in json.load(f):
                existing[p["date"]] = p
    merged = {p["date"]: p for p in points}
    merged.update(existing)  # keep live snapshots over reconstructed ones
    out = sorted(merged.values(), key=lambda p: p["date"])
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {HISTORY}: {len(out)} points ({out[0]['date']} -> {out[-1]['date']})")


if __name__ == "__main__":
    main()
