// User-defined display names for handle identifiers (phone/email).
// Stored in a JSON file outside viz.sqlite so they survive `npm run import`
// (which drops and rebuilds the derived database).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PATH = resolve("data/aliases.json");

let store = new Map();
let path = DEFAULT_PATH;

export function loadAliases(filePath = DEFAULT_PATH) {
  path = filePath;
  store = new Map();
  if (!existsSync(path)) return store;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === "string" && typeof v === "string" && v.length > 0) {
        store.set(k, v);
      }
    }
  } catch (e) {
    console.error(`[aliases] failed to read ${path}: ${e.message} — starting empty`);
  }
  return store;
}

function persist() {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file then rename. Avoids leaving a half-written file
  // if the process crashes mid-save.
  const tmp = path + ".tmp";
  const obj = Object.fromEntries(store);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function getAlias(identifier) {
  return store.get(identifier) || null;
}

export function getAllAliases() {
  return Object.fromEntries(store);
}

export function setAlias(identifier, name) {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("identifier must be a non-empty string");
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0) {
    store.delete(identifier);
  } else {
    if (trimmed.length > 200) throw new Error("name too long");
    store.set(identifier, trimmed);
  }
  persist();
  return trimmed.length > 0 ? trimmed : null;
}

export function deleteAlias(identifier) {
  const had = store.delete(identifier);
  if (had) persist();
  return had;
}

export function applyAliases(rows) {
  // Overlay aliases onto any rows that have an `identifier` field. Preserves
  // any existing display_name (from AddressBook autopopulation) only if no
  // user alias is set — user-provided always wins.
  return rows.map(r => {
    if (!r || typeof r.identifier !== "string") return r;
    const alias = store.get(r.identifier);
    if (alias) return { ...r, display_name: alias };
    return r;
  });
}
