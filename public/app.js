// Dashboard logic. Pulls JSON from the local API and renders charts.
// All processing stays in the browser; no third-party network calls beyond
// the Chart.js CDN load in index.html.

const fmt = new Intl.NumberFormat();
const fmtPct = (x) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const palette = {
  send: getCSS("--send"),
  recv: getCSS("--recv"),
  accent: getCSS("--accent"),
  ink: getCSS("--ink"),
  muted: getCSS("--muted"),
};

function getCSS(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

async function fetchJSON(path, init) {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Track live Chart.js instances so we can destroy + rebuild when aliases change.
const charts = {};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

// ---------- Summary cards ---------------------------------------------------

function renderSummary(data, authData) {
  const t = data.totals;
  const cards = [
    { label: "Conversational messages", value: fmt.format(t.total_messages), sub: `excludes reactions & system events` },
    { label: "Sent / Received", value: `${fmt.format(t.sent)} / ${fmt.format(t.received)}`, sub: `${fmtPct(t.sent / (t.total_messages || 1))} sent` },
    { label: "Active contacts", value: fmt.format(data.active_contacts), sub: `of ${fmt.format(data.meta.contacts_count || 0)} total handles` },
    { label: "Active chats", value: fmt.format(data.active_chats), sub: `of ${fmt.format(data.meta.chats_count || 0)} total threads` },
    { label: "Total OTPs Received", value: fmt.format(authData?.totalAuths || 0), sub: `authentication codes` },
    { label: "Total Promo Received", value: fmt.format(window.__promoData?.totalPromo || 0), sub: `promotional & spam` },
    { label: "Date range", value: `${fmtDate(t.first_ts)} → ${fmtDate(t.last_ts)}`, sub: `~${Math.round((t.last_ts - t.first_ts) / 86400 / 365.25 * 10) / 10} years` },
  ];
  const root = document.getElementById("summary-cards");
  if (root) {
    root.innerHTML = "";
    for (const c of cards) {
      root.append(el("div", { class: "card" }, [
        el("div", { class: "label" }, c.label),
        el("div", { class: "value" }, c.value),
        el("div", { class: "sub" }, c.sub),
      ]));
    }
  }
  const metaLine = document.getElementById("meta-line");
  if (metaLine) {
    metaLine.textContent =
      `Imported ${new Date(data.meta.imported_at).toLocaleString()} · ${fmt.format(Number(data.meta.source_chat_db_size) / 1_000_000 | 0)} MB chat.db`;
  }
}

// ---------- Top contacts (stacked bar: sent vs received) -------------------

function renderTopContacts(rows) {
  const ctx = document.getElementById("topContacts");
  if (!ctx) return;
  const labels = rows.map(r => r.display_name || r.identifier);
  if (charts.topContacts) charts.topContacts.destroy();
  charts.topContacts = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Received", data: rows.map(r => r.received_count), backgroundColor: palette.recv, stack: "msg" },
        { label: "Sent",     data: rows.map(r => r.sent_count),     backgroundColor: palette.send, stack: "msg" },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
        y: { stacked: true, ticks: { color: palette.ink, font: { size: 11 } }, grid: { display: false } },
      },
      plugins: {
        legend: { labels: { color: palette.ink } },
        tooltip: {
          callbacks: {
            afterLabel: (item) => {
              const r = rows[item.dataIndex];
              return `Total: ${fmt.format(r.total_messages)} · Reciprocity: ${fmtPct(r.reciprocity)}`;
            },
          },
        },
      },
    },
  });
}

// ---------- Monthly volume --------------------------------------------------

function renderMonthly(rows) {
  const ctx = document.getElementById("monthly");
  if (!ctx) return;
  if (charts.monthly) charts.monthly.destroy();
  charts.monthly = new Chart(ctx, {
    type: "line",
    data: {
      labels: rows.map(r => r.ym),
      datasets: [
        { label: "Sent",     data: rows.map(r => r.sent),     borderColor: palette.send, backgroundColor: palette.send + "33", tension: 0.25, fill: false },
        { label: "Received", data: rows.map(r => r.received), borderColor: palette.recv, backgroundColor: palette.recv + "33", tension: 0.25, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: palette.muted, maxTicksLimit: 18 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
      },
      plugins: { legend: { labels: { color: palette.ink } } },
    },
  });
}

// ---------- Authentication stats --------------------------------------------

function renderAuthStats(authData) {
  const { monthly, topSenders } = authData;

  const ctxM = document.getElementById("authMonthly");
  if (ctxM) {
    if (charts.authMonthly) charts.authMonthly.destroy();
    charts.authMonthly = new Chart(ctxM, {
      type: "bar",
      data: {
        labels: monthly.map(r => r.ym),
        datasets: [
          { label: "OTPs Received", data: monthly.map(r => r.auth_count), backgroundColor: palette.accent + "aa" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: palette.muted, maxTicksLimit: 18 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  const ctxS = document.getElementById("topAuthSenders");
  if (ctxS) {
    if (charts.topAuthSenders) charts.topAuthSenders.destroy();
    charts.topAuthSenders = new Chart(ctxS, {
      type: "bar",
      data: {
        labels: topSenders.map(r => r.display_name || r.identifier),
        datasets: [
          { label: "OTPs Sent", data: topSenders.map(r => r.auth_count), backgroundColor: palette.accent },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
          y: { ticks: { color: palette.ink, font: { size: 11 } }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
}

// ---------- Promotional stats -----------------------------------------------

function renderPromoStats(promoData) {
  if (!promoData) return;
  const { monthly, topSenders } = promoData;

  const ctxM = document.getElementById("promoMonthly");
  if (ctxM) {
    if (charts.promoMonthly) charts.promoMonthly.destroy();
    charts.promoMonthly = new Chart(ctxM, {
      type: "bar",
      data: {
        labels: monthly.map(r => r.ym),
        datasets: [
          { label: "Promo Received", data: monthly.map(r => r.promo_count), backgroundColor: palette.send + "aa" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: palette.muted, maxTicksLimit: 18 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  const ctxS = document.getElementById("topPromoSenders");
  if (ctxS) {
    if (charts.topPromoSenders) charts.topPromoSenders.destroy();
    charts.topPromoSenders = new Chart(ctxS, {
      type: "bar",
      data: {
        labels: topSenders.map(r => r.display_name || r.identifier),
        datasets: [
          { label: "Promo Sent", data: topSenders.map(r => r.promo_count), backgroundColor: palette.send },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
          y: { ticks: { color: palette.ink, font: { size: 11 } }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
}

// ---------- Hourly heatmap (CSS grid) ---------------------------------------

function renderHeatmap({ grid }) {
  const root = document.getElementById("heatmap");
  if (!root) return;
  root.innerHTML = "";

  let max = 0;
  for (const row of grid) for (const v of row) if (v > max) max = v;

  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Header row: corner + 24 hour labels.
  root.append(el("div", { class: "corner" }));
  for (let h = 0; h < 24; h++) {
    root.append(el("div", { class: "col-label" }, h % 3 === 0 ? String(h) : ""));
  }

  for (let d = 0; d < 7; d++) {
    root.append(el("div", { class: "row-label" }, dows[d]));
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h] || 0;
      const ratio = max ? v / max : 0;
      const cell = el("div", {
        class: "cell",
        data: { tip: `${dows[d]} ${h}:00 — ${fmt.format(v)} msgs` },
      });
      cell.style.background = blend("--accent-soft", "--hot", ratio);
      root.append(cell);
    }
  }
}

function blend(softVar, hotVar, ratio) {
  // Interpolate between two CSS color variables in HSL-ish RGB space.
  const a = parseColor(getCSS(softVar));
  const b = parseColor(getCSS(hotVar));
  const r = Math.round(a[0] + (b[0] - a[0]) * ratio);
  const g = Math.round(a[1] + (b[1] - a[1]) * ratio);
  const bl = Math.round(a[2] + (b[2] - a[2]) * ratio);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseColor(css) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = css;
  // Browsers normalize colors to rgb(r, g, b) or #rrggbb here.
  const norm = ctx.fillStyle;
  if (norm.startsWith("#")) {
    return [parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16), parseInt(norm.slice(5, 7), 16)];
  }
  const m = norm.match(/\d+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}

// ---------- Reciprocity scatter --------------------------------------------

function renderReciprocity(rows) {
  const ctx = document.getElementById("reciprocity");
  if (!ctx) return;
  const data = rows.map(r => ({
    x: r.total_messages,
    y: r.reciprocity ?? 0,
    label: r.display_name || r.identifier,
    sent: r.sent_count,
    received: r.received_count,
  }));
  if (charts.reciprocity) charts.reciprocity.destroy();
  charts.reciprocity = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [{
        label: "Contact",
        data,
        backgroundColor: palette.accent + "aa",
        borderColor: palette.accent,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "Total messages (log)", color: palette.muted },
             ticks: { color: palette.muted }, grid: { color: "rgba(128,128,128,0.1)" } },
        y: { min: 0, max: 1, title: { display: true, text: "Share you sent", color: palette.muted },
             ticks: { color: palette.muted, callback: (v) => (v * 100).toFixed(0) + "%" },
             grid: { color: "rgba(128,128,128,0.1)" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const d = item.raw;
              return `${d.label}: ${fmt.format(d.x)} msgs (${fmt.format(d.sent)} sent, ${fmt.format(d.received)} received) · ${fmtPct(d.y)}`;
            },
          },
        },
      },
    },
  });
}

// ---------- Contacts table (with editable aliases) -------------------------

function renderContactsTable(rows) {
  const tbody = document.getElementById("contacts-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const lastSeen = r.last_message_unix ? fmtDate(r.last_message_unix) : "";
    const tr = el("tr", { class: "contact-row", data: { identifier: r.identifier } });
    tr.append(el("td", { class: "num" }, String(i + 1)));
    tr.append(el("td", { class: "identifier" }, r.identifier));

    const input = el("input", {
      class: "alias-input",
      type: "text",
      placeholder: "add alias…",
      "aria-label": `Alias for ${r.identifier}`,
    });
    input.value = r.display_name || "";
    input.dataset.original = input.value;
    input.dataset.identifier = r.identifier;
    input.addEventListener("keydown", onAliasKey);
    input.addEventListener("blur", onAliasBlur);
    tr.append(el("td", {}, input));

    tr.append(el("td", { class: "num" }, fmt.format(r.total_messages)));
    tr.append(el("td", { class: "num" }, fmt.format(r.sent_count)));
    tr.append(el("td", { class: "num" }, fmt.format(r.received_count)));
    tr.append(el("td", { class: "num" }, fmtPct(r.reciprocity)));
    tr.append(el("td", {}, lastSeen));

    tr.addEventListener("mouseenter", () => showTermsPopover(tr, r.identifier));
    tr.addEventListener("mouseleave", hideTermsPopover);
    tbody.append(tr);
  });
}

// ---------- Top-terms hover popover ----------------------------------------
// Single shared popover, lazily fetched + cached by identifier. pointer-events
// is none in CSS so the popover never steals the row's mouseleave.

const termsCache = new Map();
let termsPopover = null;
let termsHoverTimer = null;
let termsActiveId = null;

function getTermsPopover() {
  if (!termsPopover) {
    termsPopover = el("div", { class: "terms-popover" });
    termsPopover.style.display = "none";
    document.body.append(termsPopover);
  }
  return termsPopover;
}

function hideTermsPopover() {
  if (termsHoverTimer) { clearTimeout(termsHoverTimer); termsHoverTimer = null; }
  termsActiveId = null;
  if (termsPopover) termsPopover.style.display = "none";
}

function fetchTopTerms(identifier) {
  if (termsCache.has(identifier)) return termsCache.get(identifier);
  const p = fetchJSON(`/api/contact-top-terms?identifier=${encodeURIComponent(identifier)}`)
    .catch((e) => { termsCache.delete(identifier); throw e; });
  termsCache.set(identifier, p);
  return p;
}

function showTermsPopover(row, identifier) {
  if (termsHoverTimer) clearTimeout(termsHoverTimer);
  termsActiveId = identifier;
  // Small delay so flicking the cursor across rows doesn't issue a fetch
  // for every row in passing.
  termsHoverTimer = setTimeout(async () => {
    let data;
    try { data = await fetchTopTerms(identifier); }
    catch { return; }
    // The user may have moved on while we awaited; only render if still hovered.
    if (termsActiveId !== identifier) return;

    const pop = getTermsPopover();
    pop.innerHTML = "";
    if (!data.terms || data.terms.length === 0) {
      pop.append(el("div", { class: "terms-empty" },
        "No top terms — needs a name + at least 20 messages."));
    } else {
      pop.append(el("div", { class: "terms-title" }, "Top vocabulary"));
      const chipRow = el("div", { class: "terms-chips" });
      for (const t of data.terms.slice(0, 8)) {
        chipRow.append(el("span", { class: "term-chip" }, t.term));
      }
      pop.append(chipRow);
    }
    // Make it visible offscreen first to measure, then place. Prefer right
    // of the row, fall back to below if there isn't room.
    pop.style.display = "block";
    pop.style.left = "-9999px";
    pop.style.top = "0px";
    const popRect = pop.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const margin = 12;
    let left = rect.right + 8;
    let top = rect.top;
    if (left + popRect.width > window.innerWidth - margin) {
      left = Math.max(margin, Math.min(rect.left, window.innerWidth - popRect.width - margin));
      top = rect.bottom + 4;
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }, 180);
}

function onAliasKey(e) {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  else if (e.key === "Escape") { e.target.value = e.target.dataset.original; e.target.blur(); }
}

async function onAliasBlur(e) {
  const input = e.target;
  const next = input.value.trim();
  const prev = input.dataset.original;
  if (next === prev) return;

  input.classList.remove("saved", "error");
  input.classList.add("saving");
  try {
    if (next.length === 0) {
      const url = `/api/aliases?identifier=${encodeURIComponent(input.dataset.identifier)}`;
      await fetchJSON(url, { method: "DELETE" });
    } else {
      await fetchJSON("/api/aliases", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: input.dataset.identifier, name: next }),
      });
    }
    input.dataset.original = next;
    input.classList.remove("saving");
    input.classList.add("saved");
    setTimeout(() => input.classList.remove("saved"), 600);
    await refreshContactViews();
  } catch (err) {
    console.error(err);
    input.classList.remove("saving");
    input.classList.add("error");
  }
}

async function refreshContactViews() {
  // Re-fetch the endpoints whose labels depend on aliases and rebuild
  // the affected charts + table. Summary is also refreshed to reflect
  // changes in auth/promo totals.
  const [summary, top, recip, auth, promo] = await Promise.all([
    fetchJSON("/api/summary"),
    fetchJSON("/api/contacts/top?limit=20"),
    fetchJSON("/api/reciprocity?min=50"),
    fetchJSON("/api/auth-stats"),
    fetchJSON("/api/promo-stats")
  ]);
  window.__promoData = promo;
  renderSummary(summary, auth);
  renderTopContacts(top);
  renderContactsTable(top);
  renderReciprocity(recip);
  renderAuthStats(auth);
  renderPromoStats(promo);
}

// ---------- Bootstrap -------------------------------------------------------

(async function main() {
  try {
    const [summary, top, monthly, heatmap, recip, authStats, promoStats] = await Promise.all([
      fetchJSON("/api/summary"),
      fetchJSON("/api/contacts/top?limit=20"),
      fetchJSON("/api/monthly"),
      fetchJSON("/api/heatmap"),
      fetchJSON("/api/reciprocity?min=50"),
      fetchJSON("/api/auth-stats"),
      fetchJSON("/api/promo-stats"),
    ]);
    window.__promoData = promoStats; // Store for renderSummary access
    renderSummary(summary, authStats);
    renderTopContacts(top);
    renderContactsTable(top);
    renderMonthly(monthly);
    renderHeatmap(heatmap);
    renderReciprocity(recip);
    renderAuthStats(authStats);
    renderPromoStats(promoStats);
  } catch (e) {
    console.error(e);
    document.body.append(el("pre", { class: "panel" }, `Failed to load: ${e.message}`));
  }
})();
