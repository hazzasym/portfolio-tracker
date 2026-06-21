#!/usr/bin/env python3
"""Fetch daily prices for the portfolio and write prices.json + append history.json.

Uses Yahoo Finance's public chart endpoint via the standard library only
(no API key, no third-party packages). Designed to run in GitHub Actions.

Outputs (written next to this repo's root):
  - prices.json  : latest snapshot of all symbol prices + USD/THB + gold
  - history.json : appended daily series of total portfolio value (THB)
"""
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTFOLIO = os.path.join(ROOT, "portfolio.json")
PRICES = os.path.join(ROOT, "prices.json")
HISTORY = os.path.join(ROOT, "history.json")

GOLD_SYMBOL = "GC=X"  # fallback handled below
HEADERS = {"User-Agent": "Mozilla/5.0 (portfolio-tracker)"}


def fetch_quote(symbol):
    """Return dict with price, currency, previousClose for a Yahoo symbol."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?interval=1d&range=5d"
    )
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            meta = data["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            if price is None:
                raise ValueError("no regularMarketPrice")
            return {
                "price": float(price),
                "currency": meta.get("currency"),
                "previousClose": float(prev) if prev is not None else None,
                "ok": True,
            }
        except Exception as e:  # noqa: BLE001 - we want to retry on anything
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    print(f"  ! failed to fetch {symbol}: {last_err}")
    return {"price": None, "currency": None, "previousClose": None, "ok": False,
            "error": str(last_err)}


def fetch_dividends(symbol):
    """Return {'byYear': {year: total/share}, 'ttm': trailing-12-month/share}.

    Pulls ~5 years of dividend events from Yahoo so we can show the real
    payout trend and trailing yield, not just a manual estimate.
    """
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?interval=1wk&range=5y&events=div"
    )
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            result = data["chart"]["result"][0]
            events = (result.get("events") or {}).get("dividends") or {}
            rows = sorted(
                (datetime.fromtimestamp(v["date"], timezone.utc), float(v["amount"]))
                for v in events.values()
            )
            by_year = {}
            for dt, amt in rows:
                y = str(dt.year)
                by_year[y] = round(by_year.get(y, 0.0) + amt, 6)
            cutoff = datetime.now(timezone.utc).timestamp() - 365 * 24 * 3600
            ttm = round(sum(a for dt, a in rows if dt.timestamp() >= cutoff), 6)
            return {"byYear": by_year, "ttm": ttm, "count": len(rows), "ok": True}
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.0 * (attempt + 1))
    print(f"  ! failed dividends for {symbol}: {last_err}")
    return {"byYear": {}, "ttm": 0.0, "count": 0, "ok": False}


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def main():
    portfolio = load_json(PORTFOLIO, None)
    if portfolio is None:
        raise SystemExit("portfolio.json not found")

    meta = portfolio["meta"]
    oz_per_baht = meta.get("ozPerBahtWeight", 0.490147)

    # Collect every symbol we need a live price for.
    symbols = set()
    for h in portfolio["holdings"]:
        if h["market"] in ("US", "TH"):
            symbols.add(h["symbol"])
    for w in portfolio.get("watchlist", []):
        symbols.add(w["symbol"])

    print("Fetching USD/THB ...")
    usdthb = fetch_quote("THB=X")

    print("Fetching gold (GC=F) ...")
    gold = fetch_quote("GC=F")

    prices = {}
    for sym in sorted(symbols):
        print(f"Fetching {sym} ...")
        prices[sym] = fetch_quote(sym)

    # Dividend history (per-share) for equities/funds so the page can show the
    # real trailing yield and multi-year trend vs the manual estimate.
    dividends = {}
    for sym in sorted(symbols):
        print(f"Fetching dividends {sym} ...")
        dividends[sym] = fetch_dividends(sym)

    now = datetime.now(timezone.utc)
    snapshot = {
        "updatedAt": now.isoformat(),
        "date": now.strftime("%Y-%m-%d"),
        "usdthb": usdthb,
        "gold": {**gold, "ozPerBahtWeight": oz_per_baht},
        "prices": prices,
        "dividends": dividends,
    }

    with open(PRICES, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
    print(f"Wrote {PRICES}")

    # --- compute total portfolio value in THB for the history series ---
    rate = usdthb["price"]
    gold_thb = gold["price"] * oz_per_baht * rate if (gold["ok"] and rate) else None
    total = 0.0
    valued = True
    by_class = {}

    def add_class(cls_name, amount):
        by_class[cls_name] = round(by_class.get(cls_name, 0.0) + amount, 2)

    for h in portfolio["holdings"]:
        mk = h["market"]
        cls_name = h.get("class", mk)
        if mk == "CASH":
            total += h["buyValueTHB"]
            add_class(cls_name, h["buyValueTHB"])
            continue
        if mk == "GOLD":
            if gold_thb is not None:
                v = gold_thb * h["units"]
            else:
                v = h["buyValueTHB"]
                valued = False
            total += v
            add_class(cls_name, v)
            continue
        q = prices.get(h["symbol"], {})
        if not q.get("ok"):
            total += h["buyValueTHB"]
            add_class(cls_name, h["buyValueTHB"])
            valued = False
            continue
        if mk == "US":
            v = q["price"] * rate * h["units"] if rate else h["buyValueTHB"]
            if not rate:
                valued = False
        elif mk == "TH":
            v = q["price"] * h["units"]
        else:
            v = h["buyValueTHB"]
        total += v
        add_class(cls_name, v)

    # Benchmark raw price levels (THB) so the page can rebase to the buy date.
    voo = prices.get("VOO", {})
    sp500_thb = voo["price"] * rate if (voo.get("ok") and rate) else None

    history = load_json(HISTORY, [])
    today = now.strftime("%Y-%m-%d")
    point = {
        "date": today,
        "totalValueTHB": round(total, 2),
        "usdthb": rate,
        "complete": valued,
        "byClass": by_class,
        "benchmarks": {"sp500THB": sp500_thb, "goldTHB": gold_thb},
    }
    # Replace today's point if it already exists, else append.
    history = [p for p in history if p.get("date") != today]
    history.append(point)
    history.sort(key=lambda p: p["date"])
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    print(f"Wrote {HISTORY} (total today: {total:,.0f} THB)")


if __name__ == "__main__":
    main()
