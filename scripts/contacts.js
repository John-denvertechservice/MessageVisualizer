// Read macOS AddressBook (.abcddb) files and build an identifier->display_name
// index that can be joined to chat.db handles.
//
// AddressBook on macOS is a Core Data SQLite store. Each "source" (Local,
// iCloud, Google CardDAV, etc.) has its own AddressBook-v22.abcddb under
// ~/Library/Application Support/AddressBook/Sources/<UUID>/. There's also a
// top-level merged AddressBook-v22.abcddb. The schema we care about:
//
//   ZABCDRECORD          : Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME,
//                          ZORGANIZATION, ZRECORDTYPE
//   ZABCDPHONENUMBER     : ZOWNER (-> ZABCDRECORD.Z_PK), ZFULLNUMBER
//   ZABCDEMAILADDRESS    : ZOWNER (-> ZABCDRECORD.Z_PK), ZADDRESS
//
// Schemas vary slightly across macOS versions; we tolerate missing columns
// by querying defensively and skipping bad files.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function discoverAbcddb(root) {
  // Walk root looking for *.abcddb files. Caller passes src/ which the user
  // populated by hand (or a copy of ~/Library/Application Support/AddressBook).
  const found = [];
  if (!existsSync(root)) return found;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".abcddb")) found.push(full);
    }
  }
  walk(root);
  return found;
}

function buildDisplayName(r) {
  const nick = (r.ZNICKNAME || "").trim();
  if (nick) return nick;
  const first = (r.ZFIRSTNAME || "").trim();
  const last = (r.ZLASTNAME || "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const org = (r.ZORGANIZATION || "").trim();
  if (org) return org;
  return null;
}

// Normalize a phone number to a comparable key.
// Output is a string of digits; if a leading country code is present we keep
// it. We also produce a "last 10" fallback so US numbers match whether or not
// chat.db stored the +1 prefix.
function normalizePhones(raw) {
  if (!raw) return [];
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return [];
  const keys = new Set();
  keys.add(digits);                                  // full digits
  keys.add(digits.replace(/^0+/, ""));               // strip leading zeros
  if (digits.length >= 10) keys.add(digits.slice(-10)); // last 10 (US fallback)
  if (digits.length === 10) keys.add("1" + digits);  // assume US country code
  return [...keys].filter(Boolean);
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function readSingleDb(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    console.warn(`[contacts] skipping ${path}: ${e.message}`);
    return [];
  }

  // Defensive column probe — different macOS versions name things slightly
  // differently. We only want a stable subset.
  const records = (() => {
    try {
      return db.prepare(`
        SELECT Z_PK,
               ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION
        FROM ZABCDRECORD
      `).all();
    } catch (e) {
      console.warn(`[contacts] ZABCDRECORD missing in ${path}: ${e.message}`);
      return [];
    }
  })();

  const phones = (() => {
    try {
      return db.prepare(`
        SELECT ZOWNER AS owner, ZFULLNUMBER AS number
        FROM ZABCDPHONENUMBER
      `).all();
    } catch { return []; }
  })();

  const emails = (() => {
    try {
      return db.prepare(`
        SELECT ZOWNER AS owner, ZADDRESS AS address
        FROM ZABCDEMAILADDRESS
      `).all();
    } catch { return []; }
  })();

  db.close();

  const byPk = new Map();
  for (const r of records) byPk.set(r.Z_PK, buildDisplayName(r));

  const out = [];
  for (const p of phones) {
    const name = byPk.get(p.owner);
    if (!name) continue;
    for (const k of normalizePhones(p.number)) out.push({ key: k, name, kind: "phone" });
  }
  for (const e of emails) {
    const name = byPk.get(e.owner);
    if (!name) continue;
    const k = normalizeEmail(e.address);
    if (k) out.push({ key: k, name, kind: "email" });
  }
  return out;
}

// Build a Map<normalizedIdentifier, displayName>. Walks `root` for *.abcddb
// files (e.g. ~/Library/Application Support/AddressBook on macOS, which has
// one db at the top level plus per-source dbs under Sources/<UUID>/). When
// the same key appears in multiple dbs, the longest non-empty name wins —
// a heuristic that prefers full "First Last" entries over short fragments.
export function buildContactIndex(root) {
  const dbs = discoverAbcddb(root);
  if (dbs.length === 0) {
    return { index: new Map(), files: [], root };
  }
  const index = new Map();
  for (const path of dbs) {
    let size = 0;
    try { size = statSync(path).size; } catch {}
    if (size === 0) continue;
    const rows = readSingleDb(path);
    for (const { key, name } of rows) {
      const cur = index.get(key);
      if (!cur || (name && name.length > cur.length)) index.set(key, name);
    }
  }
  return { index, files: dbs, root };
}

// Normalize a chat.db handle identifier the same way we keyed the index, so
// the import pass can do `index.get(normalizeHandleIdentifier(id))`.
export function normalizeHandleIdentifier(identifier) {
  if (!identifier) return null;
  if (identifier.includes("@")) return normalizeEmail(identifier);
  // Phone: prefer the most-informative key (with country code if present).
  const digits = identifier.replace(/\D+/g, "");
  if (!digits) return null;
  return digits;
}

// Try a handful of normalized variants until one hits the index.
export function lookupContact(index, identifier) {
  if (!identifier) return null;
  if (identifier.includes("@")) {
    return index.get(normalizeEmail(identifier)) || null;
  }
  const digits = identifier.replace(/\D+/g, "");
  if (!digits) return null;
  const candidates = [
    digits,
    digits.replace(/^0+/, ""),
    digits.slice(-10),
    digits.length === 10 ? "1" + digits : null,
  ].filter(Boolean);
  for (const c of candidates) {
    const hit = index.get(c);
    if (hit) return hit;
  }
  return null;
}
