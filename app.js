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

let DATA = {};

async function getJSON(path) {
  const res = await fetch(path + CB);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/** current price in THB for a holding/watch item given the price snapshot */
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

/** previous-close price in THB (for daily change) */
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
        value = h.buyValueTHB; // fall back to cost if price missing
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

  const cards = [
    {
      label: "Current Value",
      value: fmtTHB(totalValue),
      delta: `<span class="${cls(ret)}">${sign(pl)}${fmtTHB(pl)} (${fmtPct(ret)})</span> vs cost`,
    },
    {
      label: "Total Return (since 12 Jun)",
      value: `<span class="${cls(ret)}">${fmtPct(ret)}</span>`,
      delta: `Cost basis ${fmtTHB(totalCost)}`,
    },
    {
      label: "Day Change",
      value: `<span class="${cls(dayChange)}">${sign(dayChange)}${fmtTHB(dayChange)}</span>`,
      delta: `<span class="${cls(dayPct)}">${fmtPct(dayPct)}</span> vs prev close`,
    },
    {
      label: "USD / THB",
      value: snap.usdthb && snap.usdthb.ok ? snap.usdthb.price.toFixed(2) : "—",
      delta: `Buy rate ${portfolio.meta.buyExchangeRateUSDTHB}`,
    },
  ];

  document.getElementById("cards").innerHTML = cards
    .map(
      (c) => `<div class="card"><div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="delta">${c.delta}</div></div>`
    )
    .join("");
}

function renderHoldingsTable(rows) {
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const body = rows
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((r) => {
      const weight = totalValue ? r.value / totalValue : 0;
      const nowP = r.nowPrice == null
        ? (r.market === "CASH" ? "—" : '<span class="muted">n/a</span>')
        : fmtTHB2(r.nowPrice);
      const buyP = r.market === "CASH" ? "—" : fmtTHB2(r.buyPriceTHB);
      return `<tr>
        <td class="ticker">${r.ticker}</td>
        <td>${r.name}</td>
        <td><span class="tag">${r.class}</span></td>
        <td>${r.market === "CASH" ? "—" : Number(r.units).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td>${buyP}</td>
        <td>${nowP}</td>
        <td>${fmtTHB(r.cost)}</td>
        <td>${fmtTHB(r.value)}</td>
        <td>${(weight * 100).toFixed(1)}%</td>
        <td class="${cls(r.ret)}">${fmtPct(r.ret)}</td>
      </tr>`;
    })
    .join("");
  document.querySelector("#holdingsTable tbody").innerHTML = body;
}

function renderHistoryChart(history) {
  const labels = history.map((p) => p.date);
  const values = history.map((p) => p.totalValueTHB);
  new Chart(document.getElementById("historyChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Portfolio value (THB)",
        data: values,
        borderColor: "#4dabf7",
        backgroundColor: "rgba(77,171,247,0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: history.length > 40 ? 0 : 3,
      }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtTHB(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: "#8b98a5", maxTicksLimit: 8 }, grid: { color: "#2c3845" } },
        y: { ticks: { color: "#8b98a5", callback: (v) => "฿" + (v / 1e6).toFixed(1) + "M" },
          grid: { color: "#2c3845" } },
      },
    },
  });
}

function renderAllocChart(rows) {
  const sorted = rows.slice().sort((a, b) => b.value - a.value);
  new Chart(document.getElementById("allocChart"), {
    type: "doughnut",
    data: {
      labels: sorted.map((r) => r.ticker),
      datasets: [{ data: sorted.map((r) => r.value),
        backgroundColor: sorted.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: "#1a2129", borderWidth: 2 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#e6edf3", boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtTHB(c.parsed)}` } },
      },
    },
  });
}

function renderReturnChart(rows) {
  const r = rows.filter((x) => x.market !== "CASH").slice().sort((a, b) => b.ret - a.ret);
  new Chart(document.getElementById("returnChart"), {
    type: "bar",
    data: {
      labels: r.map((x) => x.ticker),
      datasets: [{ label: "Return %", data: r.map((x) => x.ret * 100),
        backgroundColor: r.map((x) => (x.ret >= 0 ? "#2fbf71" : "#f0616d")) }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtPct(c.parsed.y / 100) } } },
      scales: {
        x: { ticks: { color: "#8b98a5" }, grid: { display: false } },
        y: { ticks: { color: "#8b98a5", callback: (v) => v + "%" }, grid: { color: "#2c3845" } },
      },
    },
  });
}

function renderWatchlist(portfolio, snap) {
  const rows = (portfolio.watchlist || []).map((w) => {
    const now = priceTHB(w, snap);
    const change = now != null && w.refPriceTHB ? (now - w.refPriceTHB) / w.refPriceTHB : null;
    return { ...w, now, change };
  });
  document.querySelector("#watchTable tbody").innerHTML = rows
    .map((w) => `<tr>
      <td class="ticker">${w.ticker}</td>
      <td>${w.name}</td>
      <td><span class="tag">${w.theme || "-"}</span></td>
      <td>${fmtTHB2(w.refPriceTHB)}</td>
      <td>${w.now == null ? '<span class="muted">n/a</span>' : fmtTHB2(w.now)}</td>
      <td class="${w.change == null ? "muted" : cls(w.change)}">${w.change == null ? "—" : fmtPct(w.change)}</td>
    </tr>`)
    .join("");
}

function setupLookup(portfolio, snap, rows) {
  const index = {};
  rows.forEach((r) => (index[r.ticker.toUpperCase()] = { kind: "holding", r }));
  (portfolio.watchlist || []).forEach((w) => {
    const key = w.ticker.toUpperCase();
    if (!index[key]) index[key] = { kind: "watch", w };
  });
  // also allow lookup by yahoo symbol
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
  document.getElementById("lookupInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

async function main() {
  try {
    const [portfolio, snap, history] = await Promise.all([
      getJSON("portfolio.json"),
      getJSON("prices.json"),
      getJSON("history.json").catch(() => []),
    ]);
    DATA = { portfolio, snap, history };

    const rows = computeHoldings(portfolio, snap);
    document.getElementById("subline").textContent =
      `${portfolio.meta.name} · invested ${portfolio.meta.investmentDate} · prices as of ${snap.date}`;
    document.getElementById("updatedAt").textContent =
      snap.updatedAt ? " Last update: " + new Date(snap.updatedAt).toLocaleString() : "";

    renderCards(rows, snap, portfolio);
    renderHoldingsTable(rows);
    renderAllocChart(rows);
    renderReturnChart(rows);
    if (history && history.length) renderHistoryChart(history);
    renderWatchlist(portfolio, snap);
    setupLookup(portfolio, snap, rows);
  } catch (e) {
    document.getElementById("subline").textContent = "Error loading data: " + e.message;
    console.error(e);
  }
}

main();
