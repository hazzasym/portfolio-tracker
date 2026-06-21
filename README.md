# 📈 Investment Portfolio Tracker

A simple static web page that visualizes my investment portfolio and tracks its
value over time (all values in **THB**). Built for an investment class — not
financial advice.

Initial investment: **12 June 2026**, cost basis **฿100,000,000**.

## What it shows

- **Current portfolio value** and total return vs the 12 June investment date
- **Day change** vs previous close, and live USD/THB rate
- **Estimated annual dividend income** + portfolio yield
- **Portfolio vs benchmarks** — your value rebased to 100 on 12 Jun vs S&P 500 (VOO) and gold
- **Composition over time** — stacked area of asset-class mix
- **Allocation** doughnut with a toggle: by holding / asset class / theme
- **Current vs target allocation** bar (shows rebalancing drift)
- **Return-by-holding** and **contribution-to-total-return** charts
- **Movers today** — biggest gainer / loser
- **Dividend income** chart + table (uses each holding's yield & frequency)
- **Per-holding table**: units, buy price, current price, value, weight, return
- **Stock lookup** + a **watchlist** of other tickers you're considering

## How it works (no backend needed)

| File | Purpose |
|------|---------|
| `portfolio.json` | Your holdings + watchlist. **Edit this to change the port.** |
| `scripts/fetch_prices.py` | Fetches daily prices from Yahoo Finance (stdlib only, no API key). |
| `prices.json` | Latest price snapshot (auto-generated). |
| `history.json` | Daily series of total portfolio value (auto-appended). |
| `index.html` / `app.js` / `style.css` | The web page (Chart.js via CDN). |
| `.github/workflows/update-prices.yml` | Runs the script daily and commits the new data. |

Prices: US stocks/funds in USD × USD/THB, Thai stocks (`.BK`) in THB, and
Gold (99.99) via international gold spot (`GC=F`) converted to THB per
baht-weight (`ozPerBahtWeight` in `portfolio.json`). Cash is held at face value.

## Run locally

```bash
python3 scripts/fetch_prices.py     # refresh prices.json + history.json
python3 -m http.server 8000         # then open http://localhost:8000
```

## Deploy to GitHub Pages (so friends can view it)

1. Create a GitHub repo and push this folder.
2. Repo **Settings → Pages** → *Build and deployment* → Source: **Deploy from a
   branch**, Branch: `main`, Folder: `/ (root)`. Save.
3. Your site appears at `https://<username>.github.io/<repo>/`.
4. **Settings → Actions → General → Workflow permissions** → enable
   **Read and write permissions** (so the daily job can commit price updates).

The `Update prices` workflow runs once a day (and can be triggered manually from
the **Actions** tab). It updates `prices.json` / `history.json`; the page reads
them on load.

## Change / manage the portfolio

Edit `portfolio.json` and commit:

- **Change a holding** — update its `units` / `buyPriceTHB` / `buyValueTHB`.
- **Add a holding** — copy an entry in `holdings`. Set `market` to `US`, `TH`,
  `GOLD`, or `CASH`, and `symbol` to the Yahoo ticker (Thai stocks use `.BK`,
  e.g. `PTT.BK`).
- **Track a stock without buying** — add it to `watchlist` with its Yahoo
  `symbol` and a `refPriceTHB`. The daily job will start fetching its price and
  it'll appear in the Lookup/Watchlist sections.

After committing, GitHub Pages updates automatically and the next daily run
picks up new tickers.
