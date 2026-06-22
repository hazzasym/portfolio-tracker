"use strict";

const CB = "?v=" + Date.now(); // cache-bust so fresh data shows after each daily update

const fmtTHB = (n) =>
  "฿" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtTHB2 = (n) =>
  "฿" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUSD2 = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const sign = (n) => (n >= 0 ? "+" : "");

const PALETTE = [
  "#4dabf7", "#2fbf71", "#e3b341", "#f0616d", "#9775fa", "#22b8cf",
  "#ff922b", "#a9e34b", "#f783ac", "#748ffc", "#63e6be", "#ffd43b",
];
const AXIS = "#8b98a5", GRID = "#2c3845";

// Stable, consistent colors across every chart.
const CLASS_COLORS = {
  "US Stock": "#4dabf7", "US Fund": "#22b8cf", "Thai Stock": "#2fbf71",
  "Gold": "#e3b341", "Cash": "#8b98a5",
};
const COLOR = { ticker: {}, class: {}, theme: {} };
function buildColors(portfolio) {
  Object.assign(COLOR.class, CLASS_COLORS);
  portfolio.holdings.forEach((h, i) => { COLOR.ticker[h.ticker] = PALETTE[i % PALETTE.length]; });
  (portfolio.watchlist || []).forEach((w, i) => {
    if (!COLOR.ticker[w.ticker]) COLOR.ticker[w.ticker] = PALETTE[(i + 5) % PALETTE.length];
  });
  const themes = [];
  portfolio.holdings.forEach((h) => {
    const t = h.theme && h.theme !== "-" ? h.theme : h.class;
    if (!themes.includes(t)) themes.push(t);
  });
  themes.forEach((t, i) => { COLOR.theme[t] = COLOR.class[t] || PALETTE[i % PALETTE.length]; });
}
function colorFor(kind, label) { return (COLOR[kind] && COLOR[kind][label]) || "#748ffc"; }

let DATA = {};
let allocChartRef = null;

async function getJSON(path) {
  const res = await fetch(path + CB);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function priceTHB(item, snap) {
  const rate = snap.usdthb && snap.usdthb.price;
  if (item.market === "CASH") return null;
  if (item.market === "GOLD") {
    if (snap.gold && snap.gold.ok && rate)
      return snap.gold.price * snap.gold.ozPerBahtWeight * rate;
    return null;
  }
  const q = snap.prices[item.symbol];
  if (!q || !q.ok) return null;
  if (item.market === "US") return rate ? q.price * rate : null;
  if (item.market === "TH") return q.price;
  return null;
}

function prevTHB(item, snap) {
  const rate = (snap.usdthb && (snap.usdthb.previousClose || snap.usdthb.price)) || null;
  if (item.market === "CASH") return null;
  if (item.market === "GOLD") {
    const pc = snap.gold && (snap.gold.previousClose || snap.gold.price);
    return pc && rate ? pc * snap.gold.ozPerBahtWeight * rate : null;
  }
  const q = snap.prices[item.symbol];
  if (!q || !q.ok) return null;
  const pc = q.previousClose || q.price;
  if (item.market === "US") return rate ? pc * rate : null;
  if (item.market === "TH") return pc;
  return null;
}

function computeHoldings(portfolio, snap) {
  const thisYear = new Date().getFullYear();
  const tax = portfolio.meta.withholdingTax || {};
  const rate = snap.usdthb && snap.usdthb.price;
  const inception = portfolio.meta.investmentDate;
  return portfolio.holdings.map((h) => {
    let nowPrice, value, valuedLive = true;
    if (h.market === "CASH") {
      nowPrice = null;
      value = h.buyValueTHB;
    } else {
      const p = priceTHB(h, snap);
      if (p == null) {
        nowPrice = null;
        value = h.buyValueTHB;
        valuedLive = false;
      } else {
        nowPrice = p;
        value = p * h.units;
      }
    }
    const prevP = prevTHB(h, snap);
    const prevValue = prevP != null ? prevP * h.units : value;

    // --- dividend analytics (actual payouts from Yahoo) ---
    const nativeQ = snap.prices && snap.prices[h.symbol];
    const nativePrice = nativeQ && nativeQ.ok ? nativeQ.price : null;
    const div = (snap.dividends && snap.dividends[h.symbol]) || null;
    let trailingYield = null, avg3yYield = null, divByYearYield = null;
    if (div && nativePrice) {
      trailingYield = div.ttm / nativePrice;
      const complete = Object.keys(div.byYear)
        .filter((y) => Number(y) < thisYear).sort();
      const last3 = complete.slice(-3);
      if (last3.length) {
        const avgPerShare = last3.reduce((s, y) => s + div.byYear[y], 0) / last3.length;
        avg3yYield = avgPerShare / nativePrice;
      }
      divByYearYield = {};
      last3.forEach((y) => { divByYearYield[y] = div.byYear[y] / nativePrice; });
    }
    const estYield = h.divYield || 0;
    // Income uses the actual trailing yield when available, else the estimate.
    const effYield = trailingYield != null ? trailingYield : estYield;
    const whtRate = tax[h.market] || 0;
    const annualIncomeGross = effYield * value;
    const annualIncomeNet = annualIncomeGross * (1 - whtRate);

    // Dividends actually received since the investment date (per-share payouts
    // x units, USD payouts converted at current FX), net of withholding tax.
    let incomeReceivedNet = 0;
    if (div && div.payouts && (h.market === "US" || h.market === "TH")) {
      const perShare = div.payouts
        .filter((p) => p[0] >= inception)
        .reduce((s, p) => s + p[1], 0);
      const gross = perShare * h.units * (h.market === "US" && rate ? rate : 1);
      incomeReceivedNet = gross * (1 - whtRate);
    }

    return {
      ...h,
      nowPrice,
      value,
      prevValue,
      cost: h.buyValueTHB,
      ret: (value - h.buyValueTHB) / h.buyValueTHB,
      dayChange: prevValue ? value / prevValue - 1 : 0,
      valuedLive,
      estYield,
      trailingYield,
      avg3yYield,
      divByYearYield,
      whtRate,
      annualIncomeGross,
      annualIncomeNet,
      annualIncome: annualIncomeNet,
      incomeReceivedNet,
    };
  });
}

function daysSince(dateStr) {
  return Math.max(1, Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000));
}

function renderCards(rows, snap, portfolio) {
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalCost = portfolio.meta.baseCapitalTHB;
  const pl = totalValue - totalCost;
  const priceRet = pl / totalCost;
  const incomeReceived = rows.reduce((s, r) => s + (r.incomeReceivedNet || 0), 0);
  const totalRet = (pl + incomeReceived) / totalCost; // total return incl. net income received
  const prevTotal = rows.reduce((s, r) => s + r.prevValue, 0);
  const dayChange = totalValue - prevTotal;
  const dayPct = prevTotal ? dayChange / prevTotal : 0;
  const annualDivNet = rows.reduce((s, r) => s + (r.annualIncomeNet || 0), 0);
  const annualDivGross = rows.reduce((s, r) => s + (r.annualIncomeGross || 0), 0);
  const portYield = totalValue ? annualDivNet / totalValue : 0;
  const days = daysSince(portfolio.meta.investmentDate);

  const cards = [
    { label: "Current Value", value: fmtTHB(totalValue),
      delta: `<span class="${cls(priceRet)}">${sign(pl)}${fmtTHB(pl)} (${fmtPct(priceRet)})</span> vs cost` },
    { label: `Total Return (${days}d)`, value: `<span class="${cls(totalRet)}">${fmtPct(totalRet)}</span>`,
      delta: `Price ${fmtPct(priceRet)} + income ${fmtPct(incomeReceived / totalCost)} <span class="muted">(net)</span>` },
    { label: "Day Change", value: `<span class="${cls(dayChange)}">${sign(dayChange)}${fmtTHB(dayChange)}</span>`,
      delta: `<span class="${cls(dayPct)}">${fmtPct(dayPct)}</span> vs prev close` },
    { label: "Annual Dividends (net of tax)", value: fmtTHB(annualDivNet),
      delta: `Net yield ${(portYield * 100).toFixed(2)}% · gross ${fmtTHB(annualDivGross)}` },
    { label: "USD / THB", value: snap.usdthb && snap.usdthb.ok ? snap.usdthb.price.toFixed(2) : "—",
      delta: `Buy rate ${portfolio.meta.buyExchangeRateUSDTHB}` },
  ];
  document.getElementById("cards").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="delta">${c.delta}</div></div>`)
    .join("");
}

function quoteFor(row, snap) {
  if (row.market === "GOLD") return snap.gold || null;
  return snap.prices && snap.prices[row.symbol] ? snap.prices[row.symbol] : null;
}

function formatNativePrice(row, snap) {
  if (row.market === "CASH") return '<span class="muted">Cash balance</span>';
  const q = quoteFor(row, snap);
  if (!q || !q.ok || q.price == null) return '<span class="muted">n/a</span>';
  if (row.market === "US") return `${fmtUSD2(q.price)} <span class="muted">USD</span>`;
  if (row.market === "TH") return `${fmtTHB2(q.price)} <span class="muted">THB</span>`;
  if (row.market === "GOLD") return `${fmtUSD2(q.price)} <span class="muted">/ oz</span>`;
  return '<span class="muted">n/a</span>';
}

function formatTHBUnit(row) {
  if (row.market === "CASH") return '<span class="muted">—</span>';
  if (row.nowPrice == null) return '<span class="muted">n/a</span>';
  const unit = row.market === "GOLD" ? ' <span class="muted">/ baht wt.</span>' : "";
  return `${fmtTHB2(row.nowPrice)}${unit}`;
}

function renderLatestPrices(rows, snap) {
  const stamp = document.getElementById("latestPricesStamp");
  if (stamp) {
    const updateText = snap.updatedAt
      ? new Date(snap.updatedAt).toLocaleString()
      : snap.date;
    stamp.textContent = `Snapshot ${snap.date} · updated ${updateText}`;
  }
  const sorted = rows.slice().sort((a, b) => b.value - a.value);
  document.querySelector("#latestPricesTable tbody").innerHTML = sorted.map((r) => {
    const day = r.market === "CASH" || !r.valuedLive
      ? '<span class="muted">—</span>'
      : `<span class="${cls(r.dayChange)}">${fmtPct(r.dayChange)}</span>`;
    return `<tr>
      <td class="ticker" data-label="Ticker">${r.ticker}</td>
      <td data-label="Asset">${r.name}</td>
      <td data-label="Market"><span class="tag">${r.class}</span></td>
      <td data-label="Native Price">${formatNativePrice(r, snap)}</td>
      <td data-label="THB / Unit">${formatTHBUnit(r)}</td>
      <td data-label="Day Change">${day}</td>
      <td data-label="Value">${fmtTHB(r.value)}</td>
    </tr>`;
  }).join("");
}

const HOLDING_COLS = [
  { label: "Ticker", key: (r) => r.ticker, type: "str" },
  { label: "Name", key: (r) => r.name, type: "str" },
  { label: "Class", key: (r) => r.class, type: "str" },
  { label: "Units", key: (r) => r.units, type: "num" },
  { label: "Buy Price", key: (r) => r.buyPriceTHB, type: "num" },
  { label: "Now Price", key: (r) => r.nowPrice ?? -1, type: "num" },
  { label: "Cost (THB)", key: (r) => r.cost, type: "num" },
  { label: "Value (THB)", key: (r) => r.value, type: "num" },
  { label: "Weight", key: (r) => r.value, type: "num" },
  { label: "Return", key: (r) => r.ret, type: "num" },
];
let holdingSort = { col: 7, dir: -1 }; // default: Value desc

function renderHoldingsTable(rows) {
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  // header with sort handlers
  const headRow = document.querySelector("#holdingsTable thead tr");
  headRow.innerHTML = HOLDING_COLS.map((c, i) => {
    const sorted = i === holdingSort.col;
    const arrow = sorted ? (holdingSort.dir === -1 ? "▼" : "▲") : "▲";
    return `<th class="sortable ${sorted ? "sorted" : ""}" data-col="${i}">${c.label}<span class="arrow">${arrow}</span></th>`;
  }).join("");
  headRow.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const i = +th.dataset.col;
    if (holdingSort.col === i) holdingSort.dir *= -1;
    else holdingSort = { col: i, dir: HOLDING_COLS[i].type === "str" ? 1 : -1 };
    renderHoldingsTable(rows);
  }));

  const col = HOLDING_COLS[holdingSort.col];
  const sorted = rows.slice().sort((a, b) => {
    const va = col.key(a), vb = col.key(b);
    const cmp = col.type === "str" ? String(va).localeCompare(String(vb)) : va - vb;
    return cmp * holdingSort.dir;
  });

  document.querySelector("#holdingsTable tbody").innerHTML = sorted.map((r) => {
    const weight = totalValue ? r.value / totalValue : 0;
    const nowP = r.nowPrice == null
      ? (r.market === "CASH" ? "—" : '<span class="muted">n/a</span>') : fmtTHB2(r.nowPrice);
    const buyP = r.market === "CASH" ? "—" : fmtTHB2(r.buyPriceTHB);
    return `<tr>
      <td class="ticker" data-label="Ticker">${r.ticker}</td>
      <td data-label="Name">${r.name}</td>
      <td data-label="Class"><span class="tag">${r.class}</span></td>
      <td data-label="Units">${r.market === "CASH" ? "—" : Number(r.units).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
      <td data-label="Buy Price">${buyP}</td><td data-label="Now Price">${nowP}</td>
      <td data-label="Cost">${fmtTHB(r.cost)}</td><td data-label="Value">${fmtTHB(r.value)}</td>
      <td data-label="Weight">${(weight * 100).toFixed(1)}%</td>
      <td data-label="Return" class="${cls(r.ret)}">${fmtPct(r.ret)}</td>
    </tr>`;
  }).join("");
}

/* ---------- #5 Benchmark comparison (rebased to first day = 100) ---------- */
function rebase(values) {
  const baseVal = values.find((v) => v != null);
  return values.map((v) => (v == null || !baseVal ? null : (v / baseVal) * 100));
}
function policyWeights(portfolio) {
  // Map target weights to benchmark sleeves by market.
  const w = { eq: 0, set: 0, gold: 0, cash: 0 };
  portfolio.holdings.forEach((h) => {
    const t = h.targetWeight || 0;
    if (h.market === "US") w.eq += t;
    else if (h.market === "TH") w.set += t;
    else if (h.market === "GOLD") w.gold += t;
    else if (h.market === "CASH") w.cash += t;
  });
  const sum = w.eq + w.set + w.gold + w.cash || 1;
  return { eq: w.eq / sum, set: w.set / sum, gold: w.gold / sum, cash: w.cash / sum };
}

function renderBenchChart(history, portfolio) {
  const labels = history.map((p) => p.date);
  const port = rebase(history.map((p) => p.totalValueTHB));
  const sp = rebase(history.map((p) => (p.benchmarks ? p.benchmarks.sp500THB : null)));
  const gold = rebase(history.map((p) => (p.benchmarks ? p.benchmarks.goldTHB : null)));
  const set = rebase(history.map((p) => (p.benchmarks ? p.benchmarks.setTHB : null)));

  // Blended policy benchmark = target-weighted mix of equity/SET/gold/cash(flat).
  const w = policyWeights(portfolio);
  const blended = labels.map((_, i) => {
    if (sp[i] == null || gold[i] == null || set[i] == null) return null;
    return w.eq * sp[i] + w.set * set[i] + w.gold * gold[i] + w.cash * 100;
  });

  const datasets = [
    { label: "My Portfolio", data: port, borderColor: "#4dabf7", backgroundColor: "rgba(77,171,247,.12)", fill: true, tension: 0.25, borderWidth: 2.5 },
    { label: "Policy Benchmark", data: blended, borderColor: "#ff922b", fill: false, tension: 0.25, borderWidth: 2.5 },
    { label: "S&P 500 (VOO)", data: sp, borderColor: "#e3b341", fill: false, tension: 0.25, borderDash: [6, 4], borderWidth: 1 },
    { label: "Gold", data: gold, borderColor: "#9775fa", fill: false, tension: 0.25, borderDash: [2, 3], borderWidth: 1 },
  ];
  new Chart(document.getElementById("benchChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, spanGaps: true,
      plugins: {
        legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "n/a" : c.parsed.y.toFixed(2)} (${c.parsed.y == null ? "" : fmtPct(c.parsed.y / 100 - 1)})` } },
      },
      scales: {
        x: { ticks: { color: AXIS, maxTicksLimit: 8 }, grid: { color: GRID } },
        y: { ticks: { color: AXIS, callback: (v) => v }, grid: { color: GRID } },
      },
    },
  });
}

/* ---------- #3 Allocation with grouping toggle ---------- */
function groupAlloc(rows, mode) {
  if (mode === "holding")
    return rows.slice().sort((a, b) => b.value - a.value).map((r) => [r.ticker, r.value]);
  const key = mode === "class" ? (r) => r.class
    : (r) => (r.theme && r.theme !== "-" ? r.theme : r.class);
  const map = {};
  rows.forEach((r) => { const k = key(r); map[k] = (map[k] || 0) + r.value; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function renderAllocChart(rows, mode) {
  const entries = groupAlloc(rows, mode);
  const kind = mode === "holding" ? "ticker" : mode; // class | theme
  if (allocChartRef) allocChartRef.destroy();
  allocChartRef = new Chart(document.getElementById("allocChart"), {
    type: "doughnut",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1]),
        backgroundColor: entries.map((e) => colorFor(kind, e[0])),
        borderColor: "#1a2129", borderWidth: 2 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#e6edf3", boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: (c) => {
          const tot = c.dataset.data.reduce((s, v) => s + v, 0);
          return `${c.label}: ${fmtTHB(c.parsed)} (${(c.parsed / tot * 100).toFixed(1)}%)`;
        } } },
      },
    },
  });
}

function setupAllocToggle(rows) {
  renderAllocChart(rows, "holding");
  document.querySelectorAll("#allocToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#allocToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderAllocChart(rows, btn.dataset.mode);
    });
  });
}

/* ---------- #6 Composition over time (stacked area) ---------- */
function renderCompositionChart(history) {
  const pts = history.filter((p) => p.byClass);
  if (!pts.length) return;
  const classes = [];
  pts.forEach((p) => Object.keys(p.byClass).forEach((c) => { if (!classes.includes(c)) classes.push(c); }));
  const datasets = classes.map((c) => ({
    label: c,
    data: pts.map((p) => p.byClass[c] || 0),
    backgroundColor: colorFor("class", c) + "cc",
    borderColor: colorFor("class", c),
    fill: true, tension: 0.2, pointRadius: pts.length > 40 ? 0 : 2,
  }));
  new Chart(document.getElementById("compositionChart"), {
    type: "line",
    data: { labels: pts.map((p) => p.date), datasets },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtTHB(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: AXIS, maxTicksLimit: 8 }, grid: { color: GRID } },
        y: { stacked: true, ticks: { color: AXIS, callback: (v) => "฿" + (v / 1e6).toFixed(0) + "M" }, grid: { color: GRID } },
      },
    },
  });
}

/* ---------- Risk & concentration ---------- */
function renderConcentration(rows) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const weights = rows.map((r) => r.value / total).sort((a, b) => b - a);
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const effN = 1 / hhi;
  const top1 = weights[0];
  const top3 = weights.slice(0, 3).reduce((s, w) => s + w, 0);

  // Theme/sector exposure (group; cash/gold fall back to their class label).
  const themeMap = {};
  rows.forEach((r) => {
    const k = r.theme && r.theme !== "-" ? r.theme : r.class;
    themeMap[k] = (themeMap[k] || 0) + r.value;
  });
  const themes = Object.entries(themeMap).sort((a, b) => b[1] - a[1]);
  const topTheme = themes[0];

  const equityVal = rows.filter((r) => r.market === "US" || r.market === "TH").reduce((s, r) => s + r.value, 0);

  const cards = [
    { label: "Largest Position", value: rows.slice().sort((a, b) => b.value - a.value)[0].ticker + " " + (top1 * 100).toFixed(1) + "%",
      delta: top1 > 0.15 ? '<span class="neg">High single-name risk</span>' : "Within 15% guideline" },
    { label: "Top-3 Concentration", value: (top3 * 100).toFixed(1) + "%",
      delta: "of total portfolio value" },
    { label: "Effective # Holdings", value: effN.toFixed(1),
      delta: `${rows.length} positions · HHI ${(hhi).toFixed(3)}` },
    { label: "Largest Theme", value: `${topTheme[0]} ${(topTheme[1] / total * 100).toFixed(0)}%`,
      delta: `Equity book ${(equityVal / total * 100).toFixed(0)}% of port` },
  ];
  document.getElementById("riskCards").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="delta">${c.delta}</div></div>`).join("");

  new Chart(document.getElementById("themeChart"), {
    type: "bar",
    data: { labels: themes.map((t) => t[0]),
      datasets: [{ data: themes.map((t) => t[1] / total * 100), backgroundColor: themes.map((t) => colorFor("theme", t[0])) }] },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.x.toFixed(1) + "% (" + fmtTHB(c.parsed.x / 100 * total) + ")" } } },
      scales: {
        x: { ticks: { color: AXIS, callback: (v) => v + "%" }, grid: { color: GRID } },
        y: { ticks: { color: AXIS }, grid: { display: false } },
      },
    },
  });
}

/* ---------- Risk metrics from daily history (vol, drawdown) ---------- */
function renderRiskMetrics(history) {
  const MIN = 15;
  const vals = history.map((p) => p.totalValueTHB).filter((v) => v != null);
  const note = document.getElementById("riskNote");
  if (vals.length < 3) {
    document.getElementById("riskMetrics").innerHTML = "";
    note.textContent = `Risk metrics (volatility, drawdown) appear once a few days of history accrue (currently ${vals.length}).`;
    return;
  }
  const rets = [];
  for (let i = 1; i < vals.length; i++) rets.push(vals[i] / vals[i - 1] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annVol = dailyVol * Math.sqrt(252);

  let peak = vals[0], maxDD = 0;
  vals.forEach((v) => { if (v > peak) peak = v; maxDD = Math.min(maxDD, v / peak - 1); });

  const best = Math.max(...rets), worst = Math.min(...rets);
  const limited = vals.length < MIN;

  const cards = [
    { label: "Volatility (annualized)", value: (annVol * 100).toFixed(1) + "%",
      delta: `Daily σ ${(dailyVol * 100).toFixed(2)}%` },
    { label: "Max Drawdown", value: `<span class="${maxDD < 0 ? "neg" : "muted"}">${(maxDD * 100).toFixed(2)}%</span>`,
      delta: "Peak-to-trough" },
    { label: "Best Day", value: `<span class="pos">${fmtPct(best)}</span>`, delta: "Single-day gain" },
    { label: "Worst Day", value: `<span class="neg">${fmtPct(worst)}</span>`, delta: "Single-day loss" },
  ];
  document.getElementById("riskMetrics").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="delta">${c.delta}</div></div>`).join("");
  note.innerHTML = limited
    ? `<strong>Note:</strong> based on only ${vals.length} days — treat as indicative; these stabilize after ~${MIN}+ trading days.`
    : `Computed from ${vals.length} daily observations.`;
}

/* ---------- FX attribution for USD holdings ---------- */
function renderFXAttribution(rows, snap, portfolio) {
  const buyRate = portfolio.meta.buyExchangeRateUSDTHB;
  const rate = snap.usdthb && snap.usdthb.price;
  const us = rows.filter((r) => r.market === "US" && r.nowPrice != null);
  if (!rate || !us.length) { document.getElementById("fxCards").innerHTML = ""; return; }

  const fxRet = rate / buyRate - 1;
  // USD sleeve P/L split: price effect (local) vs currency effect.
  let costSleeve = 0, curUSDxUnits = 0, buyUSDxUnits = 0;
  us.forEach((r) => {
    const buyUSD = r.buyPriceTHB / buyRate;
    const curUSD = r.nowPrice / rate; // back out native USD from THB price
    costSleeve += r.cost;
    curUSDxUnits += curUSD * r.units;
    buyUSDxUnits += buyUSD * r.units;
  });
  // Value if FX hadn't moved (held at buy rate):
  const valueAtBuyRate = curUSDxUnits * buyRate;
  const actualValue = curUSDxUnits * rate;
  const fxPL = actualValue - valueAtBuyRate;       // pure currency P/L
  const pricePL = valueAtBuyRate - buyUSDxUnits * buyRate; // local price P/L

  const cards = [
    { label: "THB / USD move", value: `<span class="${cls(fxRet)}">${fmtPct(fxRet)}</span>`,
      delta: `${buyRate.toFixed(2)} → ${rate.toFixed(2)}` },
    { label: "Currency P/L (USD sleeve)", value: `<span class="${cls(fxPL)}">${sign(fxPL)}${fmtTHB(fxPL)}</span>`,
      delta: "from THB/USD alone" },
    { label: "Local Price P/L (USD sleeve)", value: `<span class="${cls(pricePL)}">${sign(pricePL)}${fmtTHB(pricePL)}</span>`,
      delta: "from stock prices" },
    { label: "USD Sleeve Exposure", value: (costSleeve / portfolio.meta.baseCapitalTHB * 100).toFixed(0) + "%",
      delta: "of portfolio at cost" },
  ];
  document.getElementById("fxCards").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="delta">${c.delta}</div></div>`).join("");

  // Per-holding stacked decomposition: local price effect + currency effect = total THB return.
  const data = us.map((r) => {
    const buyUSD = r.buyPriceTHB / buyRate;
    const curUSD = r.nowPrice / rate;
    const local = curUSD / buyUSD - 1;        // local price return
    const total = r.ret;                       // THB total return
    return { t: r.ticker, local: local * 100, fx: (total - local) * 100, total: total * 100 };
  }).sort((a, b) => b.total - a.total);

  new Chart(document.getElementById("fxChart"), {
    type: "bar",
    data: {
      labels: data.map((d) => d.t),
      datasets: [
        { label: "Local price", data: data.map((d) => d.local), backgroundColor: "#4dabf7", stack: "s" },
        { label: "Currency (FX)", data: data.map((d) => d.fx), backgroundColor: "#ff922b", stack: "s" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${sign(c.parsed.y)}${c.parsed.y.toFixed(2)}pp` } } },
      scales: {
        x: { stacked: true, ticks: { color: AXIS }, grid: { display: false } },
        y: { stacked: true, ticks: { color: AXIS, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
    },
  });
}

/* ---------- #1 Current vs target allocation ---------- */
function renderTargetChart(rows) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const r = rows.slice().sort((a, b) => b.targetWeight - a.targetWeight);
  new Chart(document.getElementById("targetChart"), {
    type: "bar",
    data: {
      labels: r.map((x) => x.ticker),
      datasets: [
        { label: "Current %", data: r.map((x) => (x.value / total) * 100), backgroundColor: "#4dabf7" },
        { label: "Target %", data: r.map((x) => x.targetWeight * 100), backgroundColor: "#3a4756" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
    },
  });
}

function renderReturnChart(rows) {
  const r = rows.filter((x) => x.market !== "CASH").slice().sort((a, b) => b.ret - a.ret);
  new Chart(document.getElementById("returnChart"), {
    type: "bar",
    data: { labels: r.map((x) => x.ticker),
      datasets: [{ data: r.map((x) => x.ret * 100), backgroundColor: r.map((x) => (x.ret >= 0 ? "#2fbf71" : "#f0616d")) }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtPct(c.parsed.y / 100) } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
    },
  });
}

/* ---------- #4 Contribution to total return + movers ---------- */
function renderContribChart(rows, totalCost) {
  const r = rows.filter((x) => x.market !== "CASH")
    .map((x) => ({ t: x.ticker, c: (x.value - x.cost) / totalCost * 100 }))
    .sort((a, b) => b.c - a.c);
  new Chart(document.getElementById("contribChart"), {
    type: "bar",
    data: { labels: r.map((x) => x.t),
      datasets: [{ data: r.map((x) => x.c), backgroundColor: r.map((x) => (x.c >= 0 ? "#2fbf71" : "#f0616d")) }] },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${sign(c.parsed.x)}${c.parsed.x.toFixed(2)} pts of return` } } },
      scales: {
        x: { ticks: { color: AXIS, callback: (v) => v + "pt" }, grid: { color: GRID } },
        y: { ticks: { color: AXIS }, grid: { display: false } },
      },
    },
  });
}

function renderMovers(rows) {
  const live = rows.filter((r) => r.market !== "CASH" && r.valuedLive);
  if (!live.length) { document.getElementById("movers").innerHTML = '<p class="muted">No live price data.</p>'; return; }
  const sorted = live.slice().sort((a, b) => b.dayChange - a.dayChange);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const card = (who, r) => `<div class="mover">
      <div><div class="who">${who}</div><div class="name">${r.ticker} · ${r.name}</div></div>
      <div class="pct ${cls(r.dayChange)}">${fmtPct(r.dayChange)}</div></div>`;
  document.getElementById("movers").innerHTML = card("Top gainer today", top) + card("Top loser today", bottom);
}

/* ---------- #2 Dividend income (actual payouts vs estimate) ---------- */
const FREQ = { "3M": "Quarterly", "6M": "Semi-annual", "12M": "Annual", "": "—", "-": "—", "not-available": "—" };
const pctOrDash = (n) => (n == null ? '<span class="muted">—</span>' : (n * 100).toFixed(2) + "%");

function renderDividends(rows) {
  // Anything that pays (actual or estimated) is a dividend holding.
  const dv = rows.filter((r) => (r.trailingYield && r.trailingYield > 0) || r.estYield > 0)
    .sort((a, b) => b.annualIncome - a.annualIncome);

  new Chart(document.getElementById("divChart"), {
    type: "bar",
    data: { labels: dv.map((r) => r.ticker),
      datasets: [{ data: dv.map((r) => r.annualIncome), backgroundColor: dv.map((r) => colorFor("ticker", r.ticker)) }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtTHB(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => "฿" + (v / 1000).toFixed(0) + "k" }, grid: { color: GRID } },
      },
    },
  });

  let flagged = false;
  document.querySelector("#divTable tbody").innerHTML = dv.map((r) => {
    const diverges = r.trailingYield != null && Math.abs(r.trailingYield - r.estYield) > 0.005;
    if (diverges) flagged = true;
    const actualCell = r.trailingYield == null
      ? '<span class="muted">n/a</span>'
      : `<span class="${diverges ? (r.trailingYield > r.estYield ? "pos" : "neg") : ""}">${(r.trailingYield * 100).toFixed(2)}%${diverges ? " *" : ""}</span>`;
    return `<tr>
      <td class="ticker" data-label="Ticker">${r.ticker}</td>
      <td data-label="Freq">${FREQ[r.divFreq] || r.divFreq || "—"}</td>
      <td data-label="Est. Yield">${pctOrDash(r.estYield || null)}</td>
      <td data-label="Actual (TTM)">${actualCell}</td>
      <td data-label="3-yr Avg">${pctOrDash(r.avg3yYield)}</td>
      <td data-label="Net Income">${fmtTHB(r.annualIncome)}</td></tr>`;
  }).join("");
  const base = flagged
    ? '<strong>*</strong> actual trailing yield differs from your estimate by &gt;0.5pp. Thai stocks can include large special dividends, inflating the trailing figure.'
    : "Your estimates match the actual trailing yields closely.";
  document.getElementById("divNote").innerHTML = base +
    " Yields shown are gross; <em>Net Income</em> applies withholding tax (US 15%, Thai 10%).";

  renderDivTrendChart(dv);
}

function renderDivTrendChart(dv) {
  const payers = dv.filter((r) => r.divByYearYield && Object.keys(r.divByYearYield).length);
  const years = [];
  payers.forEach((r) => Object.keys(r.divByYearYield).forEach((y) => { if (!years.includes(y)) years.push(y); }));
  years.sort();
  const datasets = years.map((y, i) => ({
    label: y,
    data: payers.map((r) => (r.divByYearYield[y] != null ? r.divByYearYield[y] * 100 : 0)),
    backgroundColor: PALETTE[i % PALETTE.length],
  }));
  new Chart(document.getElementById("divTrendChart"), {
    type: "bar",
    data: { labels: payers.map((r) => r.ticker), datasets },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#e6edf3", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
    },
  });
}

/* ---------- watchlist + lookup ---------- */
function renderWatchlist(portfolio, snap) {
  const rows = (portfolio.watchlist || []).map((w) => {
    const now = priceTHB(w, snap);
    const change = now != null && w.refPriceTHB ? (now - w.refPriceTHB) / w.refPriceTHB : null;
    return { ...w, now, change };
  });
  document.querySelector("#watchTable tbody").innerHTML = rows.map((w) => `<tr>
      <td class="ticker" data-label="Ticker">${w.ticker}</td><td data-label="Name">${w.name}</td>
      <td data-label="Theme"><span class="tag">${w.theme || "-"}</span></td>
      <td data-label="Ref Price">${fmtTHB2(w.refPriceTHB)}</td>
      <td data-label="Now">${w.now == null ? '<span class="muted">n/a</span>' : fmtTHB2(w.now)}</td>
      <td data-label="Change" class="${w.change == null ? "muted" : cls(w.change)}">${w.change == null ? "—" : fmtPct(w.change)}</td>
    </tr>`).join("");
}

function setupLookup(portfolio, snap, rows) {
  const index = {};
  rows.forEach((r) => (index[r.ticker.toUpperCase()] = { kind: "holding", r }));
  (portfolio.watchlist || []).forEach((w) => {
    const key = w.ticker.toUpperCase();
    if (!index[key]) index[key] = { kind: "watch", w };
  });
  rows.forEach((r) => (index[r.symbol.toUpperCase()] = index[r.symbol.toUpperCase()] || { kind: "holding", r }));
  const out = document.getElementById("lookupResult");
  function run() {
    const q = document.getElementById("lookupInput").value.trim().toUpperCase();
    if (!q) { out.innerHTML = ""; return; }
    const hit = index[q];
    if (!hit) {
      out.innerHTML = `<div class="notice">No data for <strong>${q}</strong> yet.
        To track it, add it to <code>portfolio.json</code> &rarr; <code>watchlist</code>
        (use the Yahoo symbol, e.g. <code>${q}</code> or <code>${q}.BK</code> for Thai stocks) and commit.</div>`;
      return;
    }
    if (hit.kind === "holding") {
      const r = hit.r;
      out.innerHTML = `<div class="notice">
        <strong>${r.ticker}</strong> — ${r.name} <span class="tag">${r.class}</span><br/>
        In portfolio: ${Number(r.units).toLocaleString("en-US", { maximumFractionDigits: 2 })} units &middot;
        buy ${fmtTHB2(r.buyPriceTHB)} &rarr; now ${r.nowPrice == null ? "n/a" : fmtTHB2(r.nowPrice)} &middot;
        return <span class="${cls(r.ret)}">${fmtPct(r.ret)}</span><br/>
        Value ${fmtTHB(r.value)} &middot; theme: ${r.theme} &middot; div yield: ${r.divYield == null ? "-" : (r.divYield * 100).toFixed(2) + "%"}
        ${r.reason ? "<br/>Reason: " + r.reason : ""}</div>`;
    } else {
      const w = hit.w;
      const now = priceTHB(w, snap);
      const change = now != null && w.refPriceTHB ? (now - w.refPriceTHB) / w.refPriceTHB : null;
      out.innerHTML = `<div class="notice">
        <strong>${w.ticker}</strong> — ${w.name} <span class="tag">watchlist</span><br/>
        Ref (12 Jun) ${fmtTHB2(w.refPriceTHB)} &rarr; now ${now == null ? "n/a" : fmtTHB2(now)}
        ${change == null ? "" : `&middot; <span class="${cls(change)}">${fmtPct(change)}</span>`}<br/>
        ${w.theme ? "Theme: " + w.theme : ""} ${w.reason ? "&middot; " + w.reason : ""}</div>`;
    }
  }
  document.getElementById("lookupBtn").addEventListener("click", run);
  document.getElementById("lookupInput").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}

async function main() {
  try {
    const [portfolio, snap, history] = await Promise.all([
      getJSON("portfolio.json"), getJSON("prices.json"), getJSON("history.json").catch(() => []),
    ]);
    DATA = { portfolio, snap, history };
    buildColors(portfolio);
    const rows = computeHoldings(portfolio, snap);
    const totalCost = portfolio.meta.baseCapitalTHB;

    document.getElementById("subline").textContent =
      `${portfolio.meta.name} · invested ${portfolio.meta.investmentDate} · prices as of ${snap.date}`;
    document.getElementById("updatedAt").textContent =
      snap.updatedAt ? " Last update: " + new Date(snap.updatedAt).toLocaleString() : "";
    renderFreshness(snap);

    renderCards(rows, snap, portfolio); // persistent KPI bar
    renderLatestPrices(rows, snap);

    const hist = history || [];
    // Lazy per-tab renderers (charts only render once, when their tab is shown,
    // so hidden canvases never draw at zero width).
    const tabRenderers = {
      overview: () => {
        if (hist.length) renderBenchChart(hist, portfolio);
        setupAllocToggle(rows);
        renderMovers(rows);
      },
      performance: () => {
        if (hist.length) renderCompositionChart(hist);
        renderTargetChart(rows);
        renderReturnChart(rows);
        renderContribChart(rows, totalCost);
      },
      risk: () => {
        renderConcentration(rows);
        renderRiskMetrics(hist);
        renderFXAttribution(rows, snap, portfolio);
      },
      income: () => renderDividends(rows),
      holdings: () => {
        renderHoldingsTable(rows);
        renderWatchlist(portfolio, snap);
        setupLookup(portfolio, snap, rows);
      },
    };
    setupTabs(tabRenderers);
  } catch (e) {
    document.getElementById("subline").textContent = "Error loading data: " + e.message;
    console.error(e);
  }
}

function renderFreshness(snap) {
  const el = document.getElementById("freshness");
  if (!el) return;
  const today = new Date().toISOString().slice(0, 10);
  const dataDate = snap.date;
  const days = Math.round((new Date(today) - new Date(dataDate)) / 86400000);
  if (days <= 0) {
    el.className = "badge fresh";
    el.textContent = "Live · updated today";
  } else {
    el.className = "badge stale";
    el.textContent = days === 1 ? "Updated yesterday" : `Updated ${days}d ago`;
  }
  el.title = `Prices as of ${dataDate}` + (snap.updatedAt ? ` (${new Date(snap.updatedAt).toLocaleString()})` : "");
}

function setupTabs(renderers) {
  const rendered = new Set();
  function activate(tab) {
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.dataset.tab === tab));
    if (!rendered.has(tab)) {
      renderers[tab] && renderers[tab]();
      rendered.add(tab);
    } else {
      document.querySelectorAll(`.tab-panel[data-tab="${tab}"] canvas`).forEach((c) => {
        const ch = Chart.getChart(c);
        if (ch) ch.resize();
      });
    }
  }
  const tabNames = Object.keys(renderers);
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => activate(b.dataset.tab)));

  // Print / PDF: render every tab first (so all charts exist & are sized), then print.
  const printBtn = document.getElementById("printBtn");
  if (printBtn) printBtn.addEventListener("click", () => {
    const current = document.querySelector("#tabs button.active").dataset.tab;
    tabNames.forEach((t) => activate(t));
    activate(current);
    setTimeout(() => window.print(), 300);
  });

  activate("overview");
}

main();
