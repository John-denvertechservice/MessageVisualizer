#!/usr/bin/env node
// Local-only HTTP server. Reads from data/viz.sqlite (read-only), serves
// JSON API plus static files from public/.

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import {
  applyAliases,
  deleteAlias,
  getAllAliases,
  loadAliases,
  setAlias,
} from "./aliases.js";

const PORT = Number(process.env.PORT) || 3000;
const VIZ_DB_PATH = process.env.VIZ_DB_PATH || resolve("data/viz.sqlite");
const ALIASES_PATH = process.env.ALIASES_PATH || resolve("data/aliases.json");
const PUBLIC_DIR = resolve("public");

if (!existsSync(VIZ_DB_PATH)) {
  console.error(`viz.sqlite not found at ${VIZ_DB_PATH}`);
  console.error("Run `npm run import` first (with CHAT_DB_PATH set if your chat.db is elsewhere).");
  process.exit(1);
}

const db = new DatabaseSync(VIZ_DB_PATH, { readOnly: true });
loadAliases(ALIASES_PATH);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, "forbidden");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendError(res, 404, "not found");
  }
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const data = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": type,
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

// ---- API handlers ----------------------------------------------------------

function apiSummary() {
  const meta = db.prepare("SELECT key, value FROM meta").all();
  const metaObj = Object.fromEntries(meta.map(r => [r.key, r.value]));

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_messages,
      SUM(CASE WHEN is_from_me=1 THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN is_from_me=0 THEN 1 ELSE 0 END) AS received,
      SUM(CASE WHEN has_attachment=1 THEN 1 ELSE 0 END) AS attachments,
      MIN(ts_unix) AS first_ts,
      MAX(ts_unix) AS last_ts
    FROM messages
    WHERE item_type=0 AND is_reaction=0
  `).get();

  const contactCount = db.prepare(`
    SELECT COUNT(*) AS n FROM contact_summary WHERE total_messages > 0
  `).get().n;

  const chatCount = db.prepare(`
    SELECT COUNT(*) AS n FROM chat_summary WHERE total_messages > 0
  `).get().n;

  return {
    meta: metaObj,
    totals,
    active_contacts: contactCount,
    active_chats: chatCount,
  };
}

function apiTopContacts(limit) {
  const rows = db.prepare(`
    SELECT
      identifier,
      display_name,
      services,
      total_messages,
      sent_count,
      received_count,
      attachments_count,
      reciprocity,
      first_message_unix,
      last_message_unix
    FROM contact_summary
    WHERE total_messages > 0
    ORDER BY total_messages DESC
    LIMIT ?
  `).all(limit);
  return applyAliases(rows);
}

function apiHeatmap() {
  const rows = db.prepare(`
    SELECT dow, hour, count FROM hourly_heatmap
  `).all();
  // Pad missing cells so the frontend can assume a full 7x24 grid.
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) grid[r.dow][r.hour] = r.count;
  return { grid };
}

function apiMonthly() {
  return db.prepare(`
    SELECT ym, sent, received, total
    FROM monthly_volume
    ORDER BY ym ASC
  `).all();
}

function apiReciprocity(min) {
  const rows = db.prepare(`
    SELECT identifier, display_name, total_messages, sent_count,
           received_count, reciprocity
    FROM contact_summary
    WHERE total_messages >= ?
    ORDER BY total_messages DESC
    LIMIT 200
  `).all(min);
  return applyAliases(rows);
}

function apiTopChats(limit) {
  return db.prepare(`
    SELECT chat_id, display_name, chat_identifier, is_group,
           total_messages, sent_count, received_count,
           first_message_unix, last_message_unix
    FROM chat_summary
    WHERE total_messages > 0
    ORDER BY total_messages DESC
    LIMIT ?
  `).all(limit);
}

function apiAuthStats() {
  const monthly = db.prepare(`
    SELECT ym, auth_count
    FROM auth_monthly_volume
    ORDER BY ym ASC
  `).all();

  const allSenders = db.prepare(`
    SELECT c.handle_id, c.identifier, c.display_name, a.auth_count
    FROM auth_senders_summary a
    JOIN contacts c ON a.handle_id = c.handle_id
    ORDER BY a.auth_count DESC
  `).all();

  const withAliases = applyAliases(allSenders);

  const topSenders = [];
  let excludedCount = 0;
  const excludedHandles = [];

  for (const s of withAliases) {
    if (s.display_name) {
      excludedCount += s.auth_count;
      excludedHandles.push(s.handle_id);
    } else {
      topSenders.push(s);
    }
  }

  let totalAuths = db.prepare(`
    SELECT SUM(auth_count) as total FROM auth_monthly_volume
  `).get().total || 0;
  totalAuths -= excludedCount;

  if (excludedHandles.length > 0) {
    const placeholders = excludedHandles.map(() => '?').join(',');
    const excludedMonthly = db.prepare(`
      SELECT printf('%04d-%02d', year, month) AS ym, COUNT(*) as auth_count
      FROM messages
      WHERE auth_type = 'otp' AND handle_id IN (${placeholders})
      GROUP BY year, month
    `).all(...excludedHandles);

    const excludedMap = new Map(excludedMonthly.map(m => [m.ym, m.auth_count]));
    for (const m of monthly) {
      m.auth_count -= (excludedMap.get(m.ym) || 0);
    }
  }

  return { totalAuths, monthly, topSenders: topSenders.slice(0, 10) };
}

function apiPromoStats() {
  const monthly = db.prepare(`
    SELECT ym, promo_count
    FROM promo_monthly_volume
    ORDER BY ym ASC
  `).all();

  const allSenders = db.prepare(`
    SELECT c.handle_id, c.identifier, c.display_name, p.promo_count
    FROM promo_senders_summary p
    JOIN contacts c ON p.handle_id = c.handle_id
    ORDER BY p.promo_count DESC
  `).all();

  const withAliases = applyAliases(allSenders);

  const topSenders = [];
  let excludedCount = 0;
  const excludedHandles = [];

  for (const s of withAliases) {
    if (s.display_name) {
      excludedCount += s.promo_count;
      excludedHandles.push(s.handle_id);
    } else {
      topSenders.push(s);
    }
  }

  let totalPromo = db.prepare(`
    SELECT SUM(promo_count) as total FROM promo_monthly_volume
  `).get().total || 0;
  totalPromo -= excludedCount;

  if (excludedHandles.length > 0) {
    const placeholders = excludedHandles.map(() => '?').join(',');
    const excludedMonthly = db.prepare(`
      SELECT printf('%04d-%02d', year, month) AS ym, COUNT(*) as promo_count
      FROM messages
      WHERE promo_type = 'promo' AND handle_id IN (${placeholders})
      GROUP BY year, month
    `).all(...excludedHandles);

    const excludedMap = new Map(excludedMonthly.map(m => [m.ym, m.promo_count]));
    for (const m of monthly) {
      m.promo_count -= (excludedMap.get(m.ym) || 0);
    }
  }

  return { totalPromo, monthly, topSenders: topSenders.slice(0, 10) };
}

function apiSentimentMonthly() {
  return db.prepare(`
    SELECT ym, sent_avg, received_avg, sent_count, received_count
    FROM sentiment_monthly
    ORDER BY ym ASC
  `).all();
}

function apiContactSentiment(limit) {
  // Join on contact_summary so callers get total_messages for sorting/display
  // without a second round-trip, and pass through applyAliases so user-set
  // names override AddressBook display_name.
  const rows = db.prepare(`
    SELECT
      cs.identifier,
      cs.display_name,
      cs.total_messages,
      s.sent_msgs,
      s.received_msgs,
      s.sent_sentiment_avg,
      s.received_sentiment_avg
    FROM contact_sentiment s
    JOIN contact_summary cs ON cs.identifier = s.identifier
    WHERE cs.total_messages > 0
    ORDER BY cs.total_messages DESC
    LIMIT ?
  `).all(limit);
  return applyAliases(rows);
}

function apiMessagesByHandle(identifier, limit) {
  // Resolve identifier -> all handle_ids it owns. contact_summary collapses
  // iMessage + SMS handles for the same number into one identifier; we want
  // both threads merged in the result.
  const summary = db.prepare(`
    SELECT identifier, display_name, total_messages, handle_ids
    FROM contact_summary
    WHERE identifier = ?
  `).get(identifier);
  if (!summary || !summary.handle_ids) {
    return { contact: null, messages: [] };
  }
  const handleIds = String(summary.handle_ids)
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter(Number.isFinite);
  if (handleIds.length === 0) return { contact: applyAliases([summary])[0], messages: [] };

  const placeholders = handleIds.map(() => "?").join(",");
  // Secondary sort on message_id keeps ordering stable when two rows share
  // the same ts_unix (rare but possible — chat.db rounds to the second).
  const rows = db.prepare(`
    SELECT message_id, is_from_me, ts_unix, text, has_attachment
    FROM messages
    WHERE handle_id IN (${placeholders})
      AND item_type = 0
      AND is_reaction = 0
    ORDER BY ts_unix DESC, message_id DESC
    LIMIT ?
  `).all(...handleIds, limit);

  return {
    contact: applyAliases([summary])[0],
    // Reverse so the response reads chronologically — easier for the Drafter
    // to feed straight into an LLM prompt without re-sorting client-side.
    messages: rows.reverse(),
  };
}

function apiMessagesByChat(chatId, limit) {
  const chat = db.prepare(`
    SELECT chat_id, display_name, chat_identifier, is_group, total_messages
    FROM chat_summary
    WHERE chat_id = ?
  `).get(chatId);
  if (!chat) return { chat: null, messages: [] };

  const rows = db.prepare(`
    SELECT
      m.message_id,
      m.is_from_me,
      m.ts_unix,
      m.text,
      m.has_attachment,
      m.handle_id        AS author_handle_id,
      c.identifier       AS author_identifier,
      c.display_name     AS author_display_name
    FROM messages m
    LEFT JOIN contacts c ON c.handle_id = m.handle_id
    WHERE m.chat_id = ?
      AND m.item_type = 0
      AND m.is_reaction = 0
    ORDER BY m.ts_unix DESC, m.message_id DESC
    LIMIT ?
  `).all(chatId, limit);

  // Overlay user-set aliases on each author. applyAliases keys on identifier
  // and writes display_name, so re-shape the row, alias it, then map fields
  // back. Authors with no identifier (system rows, deleted handles) are left
  // as-is.
  const aliased = rows.map((m) => {
    if (!m.author_identifier) return m;
    const [a] = applyAliases([
      { identifier: m.author_identifier, display_name: m.author_display_name },
    ]);
    return { ...m, author_display_name: a.display_name };
  });

  return { chat, messages: aliased.reverse() };
}

function apiContactTopTerms(identifier) {
  const terms = db.prepare(`
    SELECT rank, term, score
    FROM contact_top_terms
    WHERE identifier = ?
    ORDER BY rank ASC
  `).all(identifier);
  const contact = db.prepare(`
    SELECT identifier, display_name, total_messages
    FROM contact_summary
    WHERE identifier = ?
  `).get(identifier);
  return { contact: contact ? applyAliases([contact])[0] : null, terms };
}

function readJSONBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---- Router ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // --- Aliases (read + write) ---
    if (path === "/api/aliases") {
      if (method === "GET") {
        return sendJSON(res, 200, getAllAliases());
      }
      if (method === "PUT") {
        const body = await readJSONBody(req);
        const { identifier, name } = body;
        if (typeof identifier !== "string" || identifier.length === 0) {
          return sendError(res, 400, "identifier required");
        }
        const stored = setAlias(identifier, name);
        return sendJSON(res, 200, { identifier, name: stored });
      }
      if (method === "DELETE") {
        const id = url.searchParams.get("identifier");
        if (!id) return sendError(res, 400, "identifier required");
        const removed = deleteAlias(id);
        return sendJSON(res, 200, { identifier: id, removed });
      }
      return sendError(res, 405, "method not allowed");
    }

    // --- Read-only endpoints (GET only) ---
    if (method !== "GET") return sendError(res, 405, "method not allowed");

    if (path === "/api/summary") {
      return sendJSON(res, 200, apiSummary());
    }
    if (path === "/api/contacts/top") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 25);
      return sendJSON(res, 200, apiTopContacts(limit));
    }
    if (path === "/api/heatmap") {
      return sendJSON(res, 200, apiHeatmap());
    }
    if (path === "/api/monthly") {
      return sendJSON(res, 200, apiMonthly());
    }
    if (path === "/api/reciprocity") {
      const min = clampInt(url.searchParams.get("min"), 1, 100000, 50);
      return sendJSON(res, 200, apiReciprocity(min));
    }
    if (path === "/api/chats/top") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 25);
      return sendJSON(res, 200, apiTopChats(limit));
    }
    if (path === "/api/auth-stats") {
      return sendJSON(res, 200, apiAuthStats());
    }
    if (path === "/api/promo-stats") {
      return sendJSON(res, 200, apiPromoStats());
    }
    if (path === "/api/sentiment-monthly") {
      return sendJSON(res, 200, apiSentimentMonthly());
    }
    if (path === "/api/contact-sentiment") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 25);
      return sendJSON(res, 200, apiContactSentiment(limit));
    }
    if (path === "/api/contact-top-terms") {
      const id = url.searchParams.get("identifier");
      if (!id) return sendError(res, 400, "identifier required");
      return sendJSON(res, 200, apiContactTopTerms(id));
    }
    if (path === "/api/messages") {
      const handle = url.searchParams.get("handle");
      const chatIdRaw = url.searchParams.get("chat_id");
      if (handle && chatIdRaw) {
        return sendError(res, 400, "specify handle or chat_id, not both");
      }
      const limit = clampInt(url.searchParams.get("limit"), 1, 500, 50);
      if (handle) return sendJSON(res, 200, apiMessagesByHandle(handle, limit));
      if (chatIdRaw) {
        const chatId = Number.parseInt(chatIdRaw, 10);
        if (!Number.isFinite(chatId)) return sendError(res, 400, "invalid chat_id");
        return sendJSON(res, 200, apiMessagesByChat(chatId, limit));
      }
      return sendError(res, 400, "handle or chat_id required");
    }
    if (path.startsWith("/api/")) {
      return sendError(res, 404, "unknown endpoint");
    }
    return serveStatic(req, res);
  } catch (e) {
    console.error("error:", e);
    return sendError(res, 500, e.message);
  }
});

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`messages-visualizer listening at http://localhost:${PORT}`);
  console.log(`  db: ${VIZ_DB_PATH}`);
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});
