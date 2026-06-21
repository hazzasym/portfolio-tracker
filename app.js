"use strict";

const CB = "?v=" + Date.now(); // cache-bust so fresh data shows after each daily update

const fmtTHB = (n) =>
  "฿" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtTHB2 = (n) =>
  "฿" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const sign = (n) => (n >= 0 ? "+" : "");

const PALETTE = [
  "#4dabf7", "#2fbf71", "#e3b341", "#f0616d", "#9775fa", "#22b8cf",
  "#ff922b", "#a9e34b", "#f783ac", "#748ffc", "#63e6be", "#ffd43b",
];
const AXIS = "#8b98a5", GRID = "#2c3845";

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
    return {
      ...h,
      nowPrice,
      value,
      prevValue,
      cost: h.buyValueTHB,
      ret: (value - h.buyValueTHB) / h.buyValueTHB,
      dayChange: prevValue ? value / prevValue - 1 : 0,
      valuedLive,
    };
  });
}

function renderCards(rows, snap, portfolio) {
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalCost = portfolio.meta.baseCapitalTHB;
  const pl = totalValue - totalCost;
  const ret = pl / totalCost;
  const prevTotal = rows.reduce((s, r) => s + r.prevValue, 0);
  const dayChange = totalValue - prevTotal;
  const dayPct = prevTotal ? dayChange / prevTotal : 0;
  const annualDiv = rows.reduce((s, r) => s + (r.divYield ? r.divYield * r.value : 0), 0);
  const portYield = totalValue ? annualDiv / totalValue : 0;

  const cards = [
    { label: "Current Value", value: fmtTHB(totalValue),
      delta: `<span class="${cls(ret)}">${sign(pl)}${fmtTHB(pl)} (${fmtPct(ret)})</span> vs cost` },
    { label: "Total Return (since 12 Jun)", value: `<span class="${cls(ret)}">${fmtPct(ret)}</span>`,
      delta: `Cost basis ${fmtTHB(totalCost)}` },
    { label: "Day Change", value: `<span class="${cls(dayChange)}">${sign(dayChange)}${fmtTHB(dayChange)}</span>`,
      delta: `<span class="${cls(dayPct)}">${fmtPct(dayPct)}</span> vs prev close` },
    { label: "Est. Annual Dividends", value: fmtTHB(annualDiv),
      delta: `Portfolio yield ${(portYield * 100).toFixed(2)}%` },
    { label: "USD / THB", value: snap.usdthb && snap.usdthb.ok ? snap.usdthb.price.toFixed(2) : "—",
      delta: `Buy rate ${portfolio.meta.buyExchangeRateUSDTHB}` },
  ];
  document.getElementById("cards").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="delta">${c.delta}</div></div>`)
    .join("");
}

function renderHoldingsTable(rows) {
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  document.querySelector("#holdingsTable tbody").innerHTML = rows
    .slice().sort((a, b) => b.value - a.value)
    .map((r) => {
      const weight = totalValue ? r.value / totalValue : 0;
      const nowP = r.nowPrice == null
        ? (r.market === "CASH" ? "—" : '<span class="muted">n/a</span>') : fmtTHB2(r.nowPrice);
      const buyP = r.market === "CASH" ? "—" : fmtTHB2(r.buyPriceTHB);
      return `<tr>
        <td class="ticker">${r.ticker}</td>
        <td>${r.name}</td>
        <td><span class="tag">${r.class}</span></td>
        <td>${r.market === "CASH" ? "—" : Number(r.units).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td>${buyP}</td><td>${nowP}</td>
        <td>${fmtTHB(r.cost)}</td><td>${fmtTHB(r.value)}</td>
        <td>${(weight * 100).toFixed(1)}%</td>
        <td class="${cls(r.ret)}">${fmtPct(r.ret)}</td>
      </tr>`;
    }).join("");
}

/* ---------- #5 Benchmark comparison (rebased to 12 Jun) ---------- */
function renderBenchChart(history, portfolio) {
  const base = portfolio.meta.baseCapitalTHB;
  const voo = portfolio.holdings.find((h) => h.ticker === "VOO");
  const goldH = portfolio.holdings.find((h) => h.market === "GOLD");
  const vooBuy = voo ? voo.buyPriceTHB : null;
  const goldBuy = goldH ? goldH.buyPriceTHB : null;

  const labels = ["2026-06-12", ...history.map((p) => p.date)];
  const idx = (arr) => [100, ...arr];

  const port = history.map((p) => (p.totalValueTHB / base) * 100);
  const sp = history.map((p) =>
    p.benchmarks && p.benchmarks.sp500THB && vooBuy ? (p.benchmarks.sp500THB / vooBuy) * 100 : null);
  const gold = history.map((p) =>
    p.benchmarks && p.benchmarks.goldTHB && goldBuy ? (p.benchmarks.goldTHB / goldBuy) * 100 : null);

  const datasets = [
    { label: "My Portfolio", data: idx(port), borderColor: "#4dabf7", backgroundColor: "rgba(77,171,247,.12)", fill: true, tension: 0.25 },
    { label: "S&P 500 (VOO)", data: idx(sp), borderColor: "#e3b341", fill: false, tension: 0.25, borderDash: [6, 4] },
    { label: "Gold", data: idx(gold), borderColor: "#9775fa", fill: false, tension: 0.25, borderDash: [2, 3] },
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
  if (allocChartRef) allocChartRef.destroy();
  allocChartRef = new Chart(document.getElementById("allocChart"), {
    type: "doughnut",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1]),
        backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]),
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
  const datasets = classes.map((c, i) => ({
    label: c,
    data: pts.map((p) => p.byClass[c] || 0),
    backgroundColor: PALETTE[i % PALETTE.length] + "cc",
    borderColor: PALETTE[i % PALETTE.length],
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

/* ---------- #2 Dividend income ---------- */
const FREQ = { "3M": "Quarterly", "6M": "Semi-annual", "12M": "Annual", "": "—", "-": "—", "not-available": "—" };
function renderDividends(rows) {
  const dv = rows.filter((r) => r.divYield).map((r) => ({ ...r, annual: r.divYield * r.value }))
    .sort((a, b) => b.annual - a.annual);
  new Chart(document.getElementById("divChart"), {
    type: "bar",
    data: { labels: dv.map((r) => r.ticker),
      datasets: [{ data: dv.map((r) => r.annual), backgroundColor: dv.map((_, i) => PALETTE[i % PALETTE.length]) }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtTHB(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => "฿" + (v / 1000).toFixed(0) + "k" }, grid: { color: GRID } },
      },
    },
  });
  document.querySelector("#divTable tbody").innerHTML = dv.map((r) => `<tr>
      <td class="ticker">${r.ticker}</td>
      <td>${(r.divYield * 100).toFixed(2)}%</td>
      <td>${FREQ[r.divFreq] || r.divFreq || "—"}</td>
      <td>${fmtTHB(r.annual)}</td></tr>`).join("");
}

/* ---------- watchlist + lookup ---------- */
function renderWatchlist(portfolio, snap) {
  const rows = (portfolio.watchlist || []).map((w) => {
    const now = priceTHB(w, snap);
    const change = now != null && w.refPriceTHB ? (now - w.refPriceTHB) / w.refPriceTHB : null;
    return { ...w, now, change };
  });
  document.querySelector("#watchTable tbody").innerHTML = rows.map((w) => `<tr>
      <td class="ticker">${w.ticker}</td><td>${w.name}</td>
      <td><span class="tag">${w.theme || "-"}</span></td>
      <td>${fmtTHB2(w.refPriceTHB)}</td>
      <td>${w.now == null ? '<span class="muted">n/a</span>' : fmtTHB2(w.now)}</td>
      <td class="${w.change == null ? "muted" : cls(w.change)}">${w.change == null ? "—" : fmtPct(w.change)}</td>
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
    const rows = computeHoldings(portfolio, snap);
    const totalCost = portfolio.meta.baseCapitalTHB;

    document.getElementById("subline").textContent =
      `${portfolio.meta.name} · invested ${portfolio.meta.investmentDate} · prices as of ${snap.date}`;
    document.getElementById("updatedAt").textContent =
      snap.updatedAt ? " Last update: " + new Date(snap.updatedAt).toLocaleString() : "";

    renderCards(rows, snap, portfolio);
    if (history && history.length) {
      renderBenchChart(history, portfolio);
      renderCompositionChart(history);
    }
    setupAllocToggle(rows);
    renderTargetChart(rows);
    renderReturnChart(rows);
    renderContribChart(rows, totalCost);
    renderMovers(rows);
    renderHoldingsTable(rows);
    renderDividends(rows);
    renderWatchlist(portfolio, snap);
    setupLookup(portfolio, snap, rows);
  } catch (e) {
    document.getElementById("subline").textContent = "Error loading data: " + e.message;
    console.error(e);
  }
}

main();
