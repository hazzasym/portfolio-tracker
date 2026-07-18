# 📈 Investment Portfolio Tracker

A simple static web page that visualizes my investment portfolio and tracks its
value over time (all values in **THB**). Built for an investment class — not
financial advice.

Initial investment: **12 June 2026**, cost basis **฿100,000,000**.

Round 2 became effective on **12 July 2026**. The portfolio value immediately
before the change is preserved in `portfolio_snapshots.json`; the dashboard
shows both the locked Round 1 price gain/loss and the new Round 2 gain/loss.
The only allocation change was moving the 10% cash sleeve into **K-SF-A**.
Because 12 July was not a business day, the entry uses KAsset's 10 July NAV
of 11.9964. The PDF's 1.10% figure is retained as a reference yield and is
not counted as dividend income; fund performance is tracked through NAV.

## What it shows

- **Current portfolio value** and total return vs the 12 June investment date
- **Round 2 gain/loss** vs the saved 12 July portfolio snapshot
- **Day change** vs previous close, and live USD/THB rate
- **Dividend income from actual payouts** — pulls each holding's real dividends (last ~5 yrs), shows trailing-12-month yield, **3-year average**, and your estimate side by side, plus a yield-by-year trend chart
- **Total return** (price + net dividends received) over the holding period
- **Portfolio vs benchmarks** — rebased to 100 on 12 Jun vs a **target-weighted policy benchmark** (the fair comparison), plus S&P 500 (VOO) and gold references
- **Risk & concentration** — largest position, top-3 concentration, effective # of holdings (HHI), theme/sector exposure, plus annualized volatility & max drawdown (once enough daily history accrues)
- **Currency (FX) impact** — splits USD holdings' returns into local price effect vs THB/USD currency effect
- **Net-of-tax dividends** — income shown after US (15%) / Thai (10%) withholding tax
- **Composition over time** — stacked area of asset-class mix
- **Allocation** doughnut with a toggle: by holding / asset class / theme
- **Current vs target allocation** bar (shows rebalancing drift)
- **Return-by-holding** and **contribution-to-total-return** charts
- **Movers today** — biggest gainer / loser
- **Dividend income** chart + table (uses each holding's yield & frequency)
- **Per-holding table**: units, buy price, current price, value, weight, return (sortable)
- **Stock lookup** + a **watchlist** of other tickers you're considering

### Presentation
- **Tabbed dashboard** (Overview / Performance / Risk & FX / Income / Holdings) with a persistent KPI bar
- **Mobile-friendly**: tables collapse into stacked cards on phones
- **Consistent colors** per asset class/holding across all charts; **ⓘ tooltips** explain the jargon
- **Freshness badge** (live / stale), **loading skeletons**, and **Print → Save as PDF** for sharing

## How it works (no backend needed)

| File | Purpose |
|------|---------|
| `portfolio.json` | Your holdings + watchlist. **Edit this to change the port.** |
| `portfolio_snapshots.json` | Append-only portfolio-change baselines and locked gain/loss snapshots. |
| `scripts/fetch_prices.py` | Fetches daily Yahoo prices and official KAsset NAVs (stdlib only, no API key). |
| `prices.json` | Latest price snapshot (auto-generated). |
| `history.json` | Daily series of total portfolio value (auto-appended). |
| `index.html` / `app.js` / `style.css` | The web page (Chart.js via CDN). |
| `.github/workflows/update-prices.yml` | Runs the script daily and commits the new data. |

Prices: US stocks/funds in USD × USD/THB, Thai stocks (`.BK`) in THB, and
Gold (99.99) via international gold spot (`GC=F`) converted to THB per
baht-weight (`ozPerBahtWeight` in `portfolio.json`). K-SF-A uses the official
KAsset NAV history. Cash is held at face value.

If a required live quote is missing, `prices.json` is marked incomplete and
the dashboard labels the value as a partial estimate. That run does not append
or replace a gain/loss point in `history.json`.

## Run locally

```bash
python3 scripts/fetch_prices.py       # refresh prices.json + history.json (today)
python3 scripts/apply_portfolio_changes.py  # one-off migration for dated replacements
python3 scripts/backfill_history.py   # one-off: reconstruct history from the
                                      # investment date using historical closes
python3 -m http.server 8000           # then open http://localhost:8000
```

The time-series charts (composition, portfolio-vs-benchmark) are built from
`history.json`, which gains **one point per day**. Run `backfill_history.py`
once to populate past days from your investment date; after that the daily job
keeps extending it.

## Deploy to GitHub Pages (so friends can view it)

1. Create a GitHub repo and push this folder.
2. Repo **Settings → Pages** → *Build and deployment* → Source: **Deploy from a
   branch**, Branch: `main`, Folder: `/ (root)`. Save.
3. Your site appears at `https://<username>.github.io/<repo>/`.
4. **Settings → Actions → General → Workflow permissions** → enable
   **Read and write permissions** (so the daily job can commit price updates).

The `Update prices` workflow runs twice a day: around **22:30 Bangkok time** for
same-day local viewing, and again after the US market close. It can also be
triggered manually from the **Actions** tab. It updates `prices.json` /
`history.json`; the page reads them on load.

## Change / manage the portfolio

Edit `portfolio.json` and commit:

- **Change a holding** — update its `units` / `buyPriceTHB` / `buyValueTHB`.
- **Add a holding** — copy an entry in `holdings`. Set `market` to `US`, `TH`,
  `TH_FUND`, `GOLD`, or `CASH`, and `symbol` to the market-data identifier
  (Thai stocks use Yahoo `.BK`, e.g. `PTT.BK`; supported KAsset funds use the
  fund code, e.g. `K-SF-A`).
- **Change the portfolio mid-stream** — first append the closing snapshot to
  `portfolio_snapshots.json`; use `startsOn` and `replaces` on a replacement
  holding so prior history remains on the old allocation.
- **Track a stock without buying** — add it to `watchlist` with its Yahoo
  `symbol` and a `refPriceTHB`. The daily job will start fetching its price and
  it'll appear in the Lookup/Watchlist sections.

After committing, GitHub Pages updates automatically and the next daily run
picks up new tickers.
