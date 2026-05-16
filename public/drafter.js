// Drafter — picks a contact / group, loads conversation context from the
// local API, and asks the Anthropic API to draft a reply. Everything else
// (API key, drafts, per-contact persona + settings) lives in localStorage.

const fmt = new Intl.NumberFormat();
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

const $ = (id) => document.getElementById(id);

// Storage. Drafts/persona/settings are keyed per-target so switching contacts
// reloads their state.
const STORE = {
  apiKey:    () => localStorage.getItem("drafter:api_key") || "",
  setApiKey: (v) => v ? localStorage.setItem("drafter:api_key", v) : localStorage.removeItem("drafter:api_key"),
  model:     () => localStorage.getItem("drafter:model") || "claude-sonnet-4-6",
  setModel:  (v) => localStorage.setItem("drafter:model", v),
  persona:    (k) => localStorage.getItem("drafter:persona:" + k) || "",
  setPersona: (k, v) => v ? localStorage.setItem("drafter:persona:" + k, v) : localStorage.removeItem("drafter:persona:" + k),
  draft:    (k) => localStorage.getItem("drafter:draft:" + k) || "",
  setDraft: (k, v) => v ? localStorage.setItem("drafter:draft:" + k, v) : localStorage.removeItem("drafter:draft:" + k),
  settings: (k) => {
    const raw = localStorage.getItem("drafter:settings:" + k);
    if (raw) { try { return JSON.parse(raw); } catch {} }
    return { tone: "warm", context: 50, instructions: "" };
  },
  setSettings: (k, v) => localStorage.setItem("drafter:settings:" + k, JSON.stringify(v)),
};

const TONE_INSTRUCTIONS = {
  casual: "Write in a casual, conversational tone. Use contractions. Friendly and relaxed.",
  warm:   "Write with warmth and genuine care. Express feeling without being overwrought.",
  direct: "Be concise and direct. Skip pleasantries. Get to the point.",
  formal: "Use polished, professional language. Avoid contractions. Be courteous.",
};

// Pre-2020 iMessage tapbacks land in chat.db as ordinary messages with bodies
// like: Liked "their actual text". Filtering them keeps Drafter context clean.
const TAPBACK_RX = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned|Removed [a-z ]+) ["""].+/;

let target = null;           // { kind: 'handle'|'chat', id, label, sublabel, isGroup, count }
let thread = [];             // filtered messages currently displayed
let allContacts = [];
let allGroups = [];
let filterType = "all";      // 'all' | 'contacts' | 'groups'
let additionalContexts = []; // [{ kind, id, label, messages }]

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false || c === "") continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

function targetKey(t) {
  return t.kind === "handle" ? `handle:${t.id}` : `chat:${t.id}`;
}

function getRadio(name) {
  const r = document.querySelector(`input[name="${name}"]:checked`);
  return r ? r.value : null;
}
function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
    r.checked = r.value === String(value);
  });
}

// ---- Contact list filter tabs ---------------------------------------------

function renderFilterTabs() {
  const root = $("contact-filter-tabs");
  root.innerHTML = "";
  for (const [value, label] of [["all", "All"], ["contacts", "Direct"], ["groups", "Groups"]]) {
    root.append(el("button", {
      class: "filter-tab" + (filterType === value ? " active" : ""),
      type: "button",
      onclick: () => {
        filterType = value;
        renderFilterTabs();
        renderContactList($("contact-search").value);
      },
    }, label));
  }
}

// ---- Contact list ---------------------------------------------------------

function renderContactList(filter = "") {
  const root = $("contact-list");
  root.innerHTML = "";
  const f = filter.trim().toLowerCase();

  const contactItems = allContacts.map((c) => ({
    kind: "handle",
    id: c.identifier,
    label: c.display_name || c.identifier,
    sublabel: c.display_name ? c.identifier : "",
    count: c.total_messages,
    isGroup: false,
  }));

  const groupItems = allGroups.map((g) => ({
    kind: "chat",
    id: g.chat_id,
    label: g.display_name || g.chat_identifier || `Group ${g.chat_id}`,
    sublabel: "Group chat",
    count: g.total_messages,
    isGroup: true,
  }));

  const pool = filterType === "contacts" ? contactItems
             : filterType === "groups"   ? groupItems
             : [...contactItems, ...groupItems];

  const items = pool.filter((item) =>
    !f
    || item.label.toLowerCase().includes(f)
    || (item.sublabel && item.sublabel.toLowerCase().includes(f))
  );

  if (items.length === 0) {
    root.append(el("div", { class: "empty-state" }, "No matches."));
    return;
  }

  for (const item of items) {
    const isActive = target && target.kind === item.kind && String(target.id) === String(item.id);
    root.append(el("button", {
      class: "contact-item" + (isActive ? " active" : ""),
      type: "button",
      onclick: () => selectTarget(item),
    }, [
      el("div", { class: "contact-main" }, [
        el("div", { class: "contact-label" }, item.label),
        item.sublabel ? el("div", { class: "contact-sub" }, item.sublabel) : null,
      ]),
      el("div", { class: "contact-meta" }, [
        item.isGroup ? el("span", { class: "group-flag" }, "group") : null,
        el("span", {}, `${fmt.format(item.count)} msgs`),
      ]),
    ]));
  }
}

// ---- Target selection & thread load ---------------------------------------

async function selectTarget(item) {
  target = item;
  additionalContexts = [];

  const key = targetKey(item);
  const s = STORE.settings(key);

  $("drafting-panel").hidden = false;
  $("drafting-title").textContent = item.label;
  $("drafting-sub").textContent =
    (item.isGroup ? "Group chat · " : "")
    + `${fmt.format(item.count)} total messages`
    + (item.sublabel && !item.isGroup ? ` · ${item.sublabel}` : "");

  setRadio("tone", s.tone);
  setRadio("context", s.context);
  $("persona").value = STORE.persona(key);
  $("instructions").value = s.instructions || "";
  $("draft").value = STORE.draft(key);
  $("generate-status").textContent = "";

  renderContactList($("contact-search").value);
  await loadThread();
  renderOptionalContextPicker();
}

async function loadThread() {
  if (!target) return;
  const limit = Number(getRadio("context")) || 50;
  const url = target.kind === "handle"
    ? `/api/messages?handle=${encodeURIComponent(target.id)}&limit=${limit}`
    : `/api/messages?chat_id=${target.id}&limit=${limit}`;
  const preview = $("thread-preview");
  preview.innerHTML = "";
  preview.append(el("div", { class: "empty-state" }, "Loading…"));
  let data;
  try { data = await fetchJSON(url); }
  catch (e) {
    preview.innerHTML = "";
    preview.append(el("div", { class: "empty-state" }, `Failed to load: ${e.message}`));
    return;
  }
  thread = (data.messages || []).filter(
    (m) => m.text && !TAPBACK_RX.test(m.text),
  );
  renderThread();
}

function renderThread() {
  const root = $("thread-preview");
  root.innerHTML = "";
  if (thread.length === 0) {
    root.append(el("div", { class: "empty-state" }, "No text messages in this window."));
    return;
  }
  for (const m of thread) {
    const dir = m.is_from_me ? "me" : "them";
    const author = m.is_from_me
      ? "Me"
      : (target.kind === "chat"
          ? (m.author_display_name || m.author_identifier || "Unknown")
          : target.label);
    root.append(el("div", { class: `thread-msg ${dir}` }, [
      el("div", { class: "thread-author" }, author),
      el("div", { class: "thread-text" }, m.text),
      el("div", { class: "thread-time" }, fmtTime(m.ts_unix)),
    ]));
  }
  // Scroll to most recent — that's where a reply attaches.
  root.scrollTop = root.scrollHeight;
}

// ---- Optional additional context -----------------------------------------

async function toggleAdditionalContext(item, checked) {
  // Always remove first so toggling on re-fetches a fresh copy.
  additionalContexts = additionalContexts.filter(
    (c) => !(c.kind === item.kind && String(c.id) === String(item.id))
  );
  if (!checked) return;

  const limit = Number(getRadio("context")) || 50;
  const url = item.kind === "handle"
    ? `/api/messages?handle=${encodeURIComponent(item.id)}&limit=${limit}`
    : `/api/messages?chat_id=${item.id}&limit=${limit}`;

  try {
    const data = await fetchJSON(url);
    const messages = (data.messages || []).filter(
      (m) => m.text && !TAPBACK_RX.test(m.text)
    );
    additionalContexts.push({ kind: item.kind, id: item.id, label: item.label, messages });
  } catch (e) {
    console.error("Failed to load additional context:", e);
  }
}

function renderOptionalContextPicker() {
  const section = $("optional-context-section");
  if (!target) { section.hidden = true; return; }

  // For a direct contact, offer group chats as supplemental context.
  // For a group thread, offer direct contacts as supplemental context.
  const options = target.kind === "handle"
    ? allGroups.map((g) => ({
        kind: "chat",
        id: g.chat_id,
        label: g.display_name || g.chat_identifier || `Group ${g.chat_id}`,
        count: g.total_messages,
      }))
    : allContacts.map((c) => ({
        kind: "handle",
        id: c.identifier,
        label: c.display_name || c.identifier,
        count: c.total_messages,
      }));

  if (options.length === 0) { section.hidden = true; return; }

  section.hidden = false;
  section.innerHTML = "";

  section.append(el("h3", { class: "section-sub" },
    target.kind === "handle"
      ? "Optional: include group context"
      : "Optional: include direct message context"
  ));
  section.append(el("p", { class: "hint" },
    target.kind === "handle"
      ? "Add recent messages from a group chat as supplementary background. The primary draft context remains the direct conversation above."
      : "Add a direct message thread as supplementary background. The primary draft context remains the group thread above."
  ));

  const list = el("div", { class: "context-option-list" });
  for (const opt of options) {
    const isChecked = additionalContexts.some(
      (c) => c.kind === opt.kind && String(c.id) === String(opt.id)
    );
    const cb = el("input", { type: "checkbox" });
    cb.checked = isChecked;
    cb.addEventListener("change", async (e) => {
      cb.disabled = true;
      await toggleAdditionalContext(opt, e.target.checked);
      cb.disabled = false;
    });
    list.append(el("label", { class: "context-option" }, [
      cb,
      el("span", { class: "context-option-label" }, opt.label),
      el("span", { class: "context-option-count" }, `${fmt.format(opt.count)} msgs`),
    ]));
  }
  section.append(list);
}

// ---- Generate draft -------------------------------------------------------

async function generateDraft() {
  if (!target) return;
  const apiKey = STORE.apiKey();
  if (!apiKey) {
    $("generate-status").textContent = "Set your Anthropic API key in Settings first.";
    return;
  }
  if (thread.length === 0) {
    $("generate-status").textContent = "No conversation context to draft against.";
    return;
  }

  const tone = getRadio("tone") || "warm";
  const persona = $("persona").value.trim();
  const instructions = $("instructions").value.trim();
  const model = STORE.model();

  // System prompt
  const systemParts = [
    target.kind === "chat"
      ? `You are drafting a message reply on behalf of the user (referred to as "Me") in a group chat.`
      : `You are drafting a message reply on behalf of the user (referred to as "Me") in a one-on-one conversation.`,
    `Tone guidance: ${TONE_INSTRUCTIONS[tone]}`,
  ];
  if (persona) systemParts.push(`Persona: ${persona}`);
  if (additionalContexts.length > 0) {
    systemParts.push(
      `Supplementary context from other threads is provided after the primary conversation. ` +
      `Use it only as background — the primary thread is the conversation being replied to.`
    );
  }
  systemParts.push(`Output only the draft text, with no preamble, quotes, or commentary.`);
  const systemPrompt = systemParts.join("\n\n");

  // Primary context — direct messages for contacts, group thread for groups.
  const primaryLines = thread.map((m) => {
    const author = m.is_from_me
      ? "Me"
      : (target.kind === "chat"
          ? (m.author_display_name || m.author_identifier || "Unknown")
          : target.label);
    return `${author}: ${m.text}`;
  });
  const primaryHeader = target.kind === "chat"
    ? `Group chat — ${target.label} (${thread.length} messages, oldest → newest):`
    : `Direct conversation with ${target.label} (${thread.length} messages, oldest → newest):`;

  const userParts = [primaryHeader, primaryLines.join("\n")];

  // Optional supplementary contexts appended after primary.
  for (const ctx of additionalContexts) {
    if (ctx.messages.length === 0) continue;
    const ctxLines = ctx.messages.map((m) => {
      const author = m.is_from_me
        ? "Me"
        : (ctx.kind === "chat"
            ? (m.author_display_name || m.author_identifier || "Unknown")
            : ctx.label);
      return `${author}: ${m.text}`;
    });
    const ctxHeader = ctx.kind === "chat"
      ? `Supplementary context — group chat "${ctx.label}" (${ctx.messages.length} messages, oldest → newest):`
      : `Supplementary context — direct thread with ${ctx.label} (${ctx.messages.length} messages, oldest → newest):`;
    userParts.push(ctxHeader);
    userParts.push(ctxLines.join("\n"));
  }

  if (instructions) userParts.push(`Additional instructions: ${instructions}`);
  userParts.push(`Draft a reply.`);
  const userContent = userParts.join("\n\n");

  $("generate-btn").disabled = true;
  $("generate-status").textContent = "Generating…";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!r.ok) {
      const raw = await r.text();
      let msg = `HTTP ${r.status}`;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error?.message) msg = parsed.error.message;
      } catch {}
      throw new Error(msg);
    }
    const json = await r.json();
    const text = (json.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    $("draft").value = text;
    STORE.setDraft(targetKey(target), text);
    const usage = json.usage || {};
    $("generate-status").textContent =
      `Done · ${fmt.format(usage.input_tokens || 0)} in / ${fmt.format(usage.output_tokens || 0)} out`;
  } catch (e) {
    $("generate-status").textContent = `Error: ${e.message}`;
  } finally {
    $("generate-btn").disabled = false;
  }
}

// ---- Wiring ---------------------------------------------------------------

function attachHandlers() {
  $("api-key").value = STORE.apiKey();
  $("api-key").addEventListener("change", (e) => STORE.setApiKey(e.target.value.trim()));

  $("model").value = STORE.model();
  $("model").addEventListener("change", (e) => STORE.setModel(e.target.value));

  $("contact-search").addEventListener("input", (e) => renderContactList(e.target.value));

  document.querySelectorAll('input[name="tone"], input[name="context"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!target) return;
      const key = targetKey(target);
      const s = STORE.settings(key);
      s.tone = getRadio("tone");
      s.context = Number(getRadio("context"));
      STORE.setSettings(key, s);
      if (r.name === "context") {
        // Context window change invalidates any fetched additional context.
        additionalContexts = [];
        renderOptionalContextPicker();
        loadThread();
      }
    });
  });

  $("persona").addEventListener("change", (e) => {
    if (!target) return;
    STORE.setPersona(targetKey(target), e.target.value);
  });
  $("instructions").addEventListener("change", (e) => {
    if (!target) return;
    const key = targetKey(target);
    const s = STORE.settings(key);
    s.instructions = e.target.value;
    STORE.setSettings(key, s);
  });

  $("draft").addEventListener("input", (e) => {
    if (!target) return;
    STORE.setDraft(targetKey(target), e.target.value);
  });

  $("generate-btn").addEventListener("click", generateDraft);
  $("copy-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("draft").value);
      $("generate-status").textContent = "Copied to clipboard.";
    } catch {
      $("generate-status").textContent = "Copy failed.";
    }
  });
  $("clear-btn").addEventListener("click", () => {
    if (!target) return;
    $("draft").value = "";
    STORE.setDraft(targetKey(target), "");
    $("generate-status").textContent = "";
  });
}

(async function init() {
  attachHandlers();
  renderFilterTabs();
  try {
    const [contacts, chats] = await Promise.all([
      fetchJSON("/api/contacts/top?limit=50"),
      fetchJSON("/api/chats/top?limit=20"),
    ]);
    allContacts = contacts;
    allGroups = chats.filter((c) => c.is_group);
    renderContactList("");
  } catch (e) {
    document.body.append(el("pre", { class: "panel" }, `Failed to load: ${e.message}`));
  }
})();
