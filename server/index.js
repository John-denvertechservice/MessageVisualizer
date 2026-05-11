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

  const topSenders = db.prepare(`
    SELECT c.identifier, c.display_name, a.auth_count
    FROM auth_senders_summary a
    JOIN contacts c ON a.handle_id = c.handle_id
    ORDER BY a.auth_count DESC
    LIMIT 10
  `).all();

  const totalAuths = db.prepare(`
    SELECT SUM(auth_count) as total FROM auth_monthly_volume
  `).get().total || 0;

  return { totalAuths, monthly, topSenders: applyAliases(topSenders) };
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
