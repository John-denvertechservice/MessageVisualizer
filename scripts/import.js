#!/usr/bin/env node
// ETL: read chat.db (read-only) -> write derived viz.sqlite with
// normalized tables and pre-computed aggregates for the local dashboard.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import natural from "natural";
import { removeStopwords, eng } from "stopword";
import { buildContactIndex, lookupContact } from "./contacts.js";

const tokenizer = new natural.WordTokenizer();
const sentimentAnalyzer = new natural.SentimentAnalyzer(
  "English",
  natural.PorterStemmer,
  "afinn",
);

function analyzeText(text) {
  if (!text) return { sentiment: null, tokens: [] };
  const raw = tokenizer.tokenize(text.toLowerCase()) || [];
  const cleaned = raw.filter(
    (t) => t.length >= 3 && !/^\d+$/.test(t) && !/^https?$/.test(t),
  );
  const tokens = removeStopwords(cleaned, eng);
  if (tokens.length === 0) return { sentiment: null, tokens: [] };
  return { sentiment: sentimentAnalyzer.getSentiment(tokens), tokens };
}

// Defaults point at the live macOS paths so a fresh checkout on any Mac
// works with `npm run import` once Terminal has Full Disk Access. Override
// either path via env vars to read from a local copy instead.
const CHAT_DB_PATH = process.env.CHAT_DB_PATH
  || join(homedir(), "Library/Messages/chat.db");
const VIZ_DB_PATH = process.env.VIZ_DB_PATH
  || resolve("data/viz.sqlite");
const ADDRESSBOOK_ROOT = process.env.ADDRESSBOOK_ROOT
  || join(homedir(), "Library/Application Support/AddressBook");

function log(...args) {
  console.log("[import]", ...args);
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function openReadOnly(path) {
  if (!existsSync(path)) {
    throw new Error(`source db not found: ${path}`);
  }
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    if (err.code === 'ERR_SQLITE_ERROR' && err.message.includes('unable to open database file')) {
      console.error(`\n[import] ERROR: Cannot read ${path}`);
      console.error(`[import] This is usually a macOS permission issue.`);
      console.error(`[import] Please grant your Terminal 'Full Disk Access' in:`);
      console.error(`[import] System Settings → Privacy & Security → Full Disk Access\n`);
      process.exit(1);
    }
    throw err;
  }
}

function buildSchema(viz) {
  viz.exec(`
    DROP TABLE IF EXISTS meta;
    DROP TABLE IF EXISTS contacts;
    DROP TABLE IF EXISTS chats;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS contact_summary;
    DROP TABLE IF EXISTS monthly_volume;
    DROP TABLE IF EXISTS hourly_heatmap;
    DROP TABLE IF EXISTS chat_summary;

    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE promo_monthly_volume (
      ym TEXT PRIMARY KEY,
      promo_count INTEGER
    );

    CREATE TABLE promo_senders_summary (
      handle_id INTEGER PRIMARY KEY,
      promo_count INTEGER
    );

    CREATE TABLE contacts (
      handle_id INTEGER PRIMARY KEY,
      identifier TEXT,
      service TEXT,
      country TEXT,
      display_name TEXT
    );

    CREATE TABLE chats (
      chat_id INTEGER PRIMARY KEY,
      guid TEXT,
      display_name TEXT,
      chat_identifier TEXT,
      service_name TEXT,
      is_group INTEGER
    );

    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      handle_id INTEGER,
      is_from_me INTEGER,
      ts_unix INTEGER,
      year INTEGER,
      month INTEGER,
      dow INTEGER,
      hour INTEGER,
      text_len INTEGER,
      has_attachment INTEGER,
      service TEXT,
      item_type INTEGER,
      is_reaction INTEGER,
      auth_type TEXT,
      promo_type TEXT
    );

    CREATE INDEX idx_messages_handle ON messages(handle_id);
    CREATE INDEX idx_messages_chat ON messages(chat_id);
    CREATE INDEX idx_messages_ts ON messages(ts_unix);

    -- One row per unique identifier (phone/email), collapsing iMessage + SMS
    -- duplicates that share a number. handle_ids is a comma-separated list of
    -- the underlying chat.db handle ROWIDs that map to this identifier.
    CREATE TABLE contact_summary (
      identifier TEXT PRIMARY KEY,
      display_name TEXT,
      handle_ids TEXT,
      services TEXT,
      total_messages INTEGER,
      sent_count INTEGER,
      received_count INTEGER,
      first_message_unix INTEGER,
      last_message_unix INTEGER,
      attachments_count INTEGER,
      reciprocity REAL
    );

    CREATE TABLE chat_summary (
      chat_id INTEGER PRIMARY KEY,
      display_name TEXT,
      chat_identifier TEXT,
      is_group INTEGER,
      total_messages INTEGER,
      sent_count INTEGER,
      received_count INTEGER,
      first_message_unix INTEGER,
      last_message_unix INTEGER
    );

    CREATE TABLE monthly_volume (
      ym TEXT PRIMARY KEY,
      sent INTEGER,
      received INTEGER,
      total INTEGER
    );

    CREATE TABLE hourly_heatmap (
      dow INTEGER,
      hour INTEGER,
      count INTEGER,
      PRIMARY KEY (dow, hour)
    );

    CREATE TABLE auth_monthly_volume (
      ym TEXT PRIMARY KEY,
      auth_count INTEGER
    );

    CREATE TABLE auth_senders_summary (
      handle_id INTEGER PRIMARY KEY,
      auth_count INTEGER
    );

    CREATE TABLE contact_sentiment (
      identifier TEXT PRIMARY KEY,
      sent_msgs INTEGER,
      received_msgs INTEGER,
      sent_sentiment_avg REAL,
      received_sentiment_avg REAL
    );

    CREATE TABLE contact_top_terms (
      identifier TEXT,
      rank INTEGER,
      term TEXT,
      score REAL,
      PRIMARY KEY (identifier, rank)
    );

    CREATE TABLE sentiment_monthly (
      ym TEXT PRIMARY KEY,
      sent_avg REAL,
      received_avg REAL,
      sent_count INTEGER,
      received_count INTEGER
    );
  `);
}

function importContacts(chat, viz, contactIndex) {
  const rows = chat.prepare(`
    SELECT ROWID AS handle_id, id AS identifier, service, country
    FROM handle
  `).all();

  const insert = viz.prepare(`
    INSERT INTO contacts (handle_id, identifier, service, country, display_name)
    VALUES (?, ?, ?, ?, ?)
  `);

  let matched = 0;
  for (const r of rows) {
    const display = lookupContact(contactIndex, r.identifier);
    if (display) matched++;
    insert.run(r.handle_id, r.identifier, r.service, r.country, display);
  }
  log(`contacts: ${rows.length} (${matched} matched to AddressBook)`);
  return { count: rows.length, matched };
}

function importChats(chat, viz) {
  const rows = chat.prepare(`
    SELECT ROWID AS chat_id, guid, display_name, chat_identifier, service_name, style
    FROM chat
  `).all();

  const insert = viz.prepare(`
    INSERT INTO chats (chat_id, guid, display_name, chat_identifier, service_name, is_group)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    // style 43 = group iMessage, 45 = direct. Anything other than 45 we treat as group.
    const isGroup = r.style === 45 ? 0 : 1;
    insert.run(r.chat_id, r.guid, r.display_name, r.chat_identifier, r.service_name, isGroup);
  }
  log(`chats: ${rows.length}`);
  return rows.length;
}

function buildOneOnOneMap(chat) {
  // chat.db only puts the recipient's handle_id on incoming messages.
  // Sent messages always have handle_id=0; the recipient must be inferred
  // from chat_handle_join for the message's chat. For 1:1 chats this is
  // unambiguous; for group chats it's not, so we leave handle_id null.
  const rows = chat.prepare(`
    SELECT chat_id, handle_id
    FROM chat_handle_join
  `).all();
  const byChat = new Map();
  for (const r of rows) {
    const arr = byChat.get(r.chat_id) || [];
    arr.push(r.handle_id);
    byChat.set(r.chat_id, arr);
  }
  const oneOnOne = new Map();
  for (const [chatId, handles] of byChat) {
    if (handles.length === 1) oneOnOne.set(chatId, handles[0]);
  }
  return oneOnOne;
}

function importMessages(chat, viz, oneOnOne) {
  // Per-handle token bags + sentiment accumulators. Built during the main
  // message pass so we don't have to re-iterate. Aggregated by identifier
  // (not handle) later, since one contact can have multiple handles.
  const nlpByHandle = new Map(); // handle_id -> { tokens: Map<word,count>, sentSum, sentCount, recvSum, recvCount }
  const sentByMonth = new Map(); // 'YYYY-MM' -> { sentSum, sentCount, recvSum, recvCount }

  function ensureHandle(id) {
    let row = nlpByHandle.get(id);
    if (!row) {
      row = { tokens: new Map(), sentSum: 0, sentCount: 0, recvSum: 0, recvCount: 0 };
      nlpByHandle.set(id, row);
    }
    return row;
  }
  function ensureMonth(ym) {
    let row = sentByMonth.get(ym);
    if (!row) {
      row = { sentSum: 0, sentCount: 0, recvSum: 0, recvCount: 0 };
      sentByMonth.set(ym, row);
    }
    return row;
  }

  // Pull per-message rows joined to chat_message_join. A message can join
  // multiple chats; GROUP BY m.ROWID keeps one row per message.
  // Apple's `date` field is nanoseconds since 2001-01-01 UTC for modern rows.
  // We convert in SQL so the returned value fits in a JS Number — raw
  // nanoseconds exceed Number.MAX_SAFE_INTEGER and would throw on read.
  const stmt = chat.prepare(`
    SELECT
      m.ROWID AS message_id,
      cmj.chat_id AS chat_id,
      m.handle_id AS handle_id,
      m.is_from_me AS is_from_me,
      CAST(
        CASE
          WHEN m.date > 1000000000000 THEN m.date / 1000000000
          ELSE m.date
        END + 978307200 AS INTEGER
      ) AS ts_unix,
      LENGTH(COALESCE(m.text, '')) AS text_len,
      m.text AS text,
      m.cache_has_attachments AS has_attachment,
      m.service AS service,
      m.item_type AS item_type,
      CASE WHEN m.associated_message_guid IS NOT NULL THEN 1 ELSE 0 END AS is_reaction
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE m.date IS NOT NULL AND m.date > 0
    GROUP BY m.ROWID
  `);

  const insert = viz.prepare(`
    INSERT INTO messages (
      message_id, chat_id, handle_id, is_from_me, ts_unix,
      year, month, dow, hour, text_len, has_attachment,
      service, item_type, is_reaction, auth_type, promo_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  viz.exec("BEGIN");
  for (const r of stmt.iterate()) {
    const ts = r.ts_unix;
    // Render time fields in the user's local timezone so heatmap "hour" and
    // "day-of-week" reflect their lived schedule, not UTC.
    const d = new Date(ts * 1000);

    // Resolve counterparty: incoming -> handle_id is already the sender;
    // outgoing -> look up the chat's single handle if 1:1, else null.
    let handleId = r.handle_id ?? null;
    if (r.is_from_me === 1) {
      handleId = oneOnOne.get(r.chat_id) ?? null;
    } else if (handleId === 0) {
      handleId = null;
    }

    // Categorize auth & promo messages
    let authType = null;
    let promoType = null;
    const text = r.text || '';
    if (!r.is_from_me && text) {
      const lower = text.toLowerCase();
      if (/(code|otp|verification|auth|login|passcode|security code|one time password)/.test(lower) && /\b\d{4,8}\b/.test(lower)) {
        authType = 'otp';
      }
      if (/(unsubscribe|opt out|reply stop|text stop|to stop|msg&data rates|msg&data|msg & data|promotional|discount|promo code|sale|offer)/.test(lower)) {
        promoType = 'promo';
      }
    }

    // NLP: skip reactions, auth/promo, non-text rows. handleId is the
    // counterparty for both directions, so all stats roll up to one contact.
    const eligible =
      r.item_type === 0 && !r.is_reaction && !authType && !promoType && text && handleId != null;
    if (eligible) {
      const { sentiment, tokens } = analyzeText(text);
      if (sentiment != null) {
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const monthRow = ensureMonth(ym);
        const handleRow = ensureHandle(handleId);
        if (r.is_from_me === 1) {
          monthRow.sentSum += sentiment; monthRow.sentCount += 1;
          handleRow.sentSum += sentiment; handleRow.sentCount += 1;
        } else {
          monthRow.recvSum += sentiment; monthRow.recvCount += 1;
          handleRow.recvSum += sentiment; handleRow.recvCount += 1;
        }
        // Token bag is intentionally side-agnostic — top terms describe the
        // conversation, not which party said them. Limit to <=200 tokens/msg
        // so a single pasted blob can't dominate a contact's vocabulary.
        const slice = tokens.length > 200 ? tokens.slice(0, 200) : tokens;
        for (const tok of slice) {
          handleRow.tokens.set(tok, (handleRow.tokens.get(tok) || 0) + 1);
        }
      }
    }

    insert.run(
      r.message_id,
      r.chat_id ?? null,
      handleId,
      r.is_from_me ? 1 : 0,
      ts,
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDay(),
      d.getHours(),
      r.text_len ?? 0,
      r.has_attachment ? 1 : 0,
      r.service,
      r.item_type ?? 0,
      r.is_reaction ?? 0,
      authType,
      promoType
    );
    count++;
  }
  viz.exec("COMMIT");
  log(`messages: ${count} inserted`);
  return { count, nlpByHandle, sentByMonth };
}

function buildNlpAggregates(viz, nlpByHandle, sentByMonth) {
  // Roll handle-level NLP up to identifier-level using contact_summary's
  // handle_ids field. Only contacts matched to AddressBook (display_name set)
  // and with enough messages get TF-IDF; everyone else still gets sentiment.
  const contacts = viz.prepare(`
    SELECT identifier, display_name, handle_ids, total_messages
    FROM contact_summary
    WHERE total_messages > 0
  `).all();

  const TFIDF_MIN_MSGS = 20;
  const perContact = []; // { identifier, tokens: Map, sentSum, sentCount, recvSum, recvCount, eligibleForTfidf }

  for (const c of contacts) {
    const handleIds = String(c.handle_ids || "")
      .split(",")
      .map((s) => Number.parseInt(s, 10))
      .filter(Number.isFinite);
    const merged = { tokens: new Map(), sentSum: 0, sentCount: 0, recvSum: 0, recvCount: 0 };
    for (const h of handleIds) {
      const src = nlpByHandle.get(h);
      if (!src) continue;
      merged.sentSum += src.sentSum;
      merged.sentCount += src.sentCount;
      merged.recvSum += src.recvSum;
      merged.recvCount += src.recvCount;
      for (const [tok, n] of src.tokens) {
        merged.tokens.set(tok, (merged.tokens.get(tok) || 0) + n);
      }
    }
    perContact.push({
      identifier: c.identifier,
      ...merged,
      eligibleForTfidf: !!c.display_name && c.total_messages >= TFIDF_MIN_MSGS,
    });
  }

  // contact_sentiment: insert anyone who had at least one scored message.
  const insertSent = viz.prepare(`
    INSERT INTO contact_sentiment (identifier, sent_msgs, received_msgs, sent_sentiment_avg, received_sentiment_avg)
    VALUES (?, ?, ?, ?, ?)
  `);
  let sentRows = 0;
  for (const c of perContact) {
    if (c.sentCount === 0 && c.recvCount === 0) continue;
    insertSent.run(
      c.identifier,
      c.sentCount,
      c.recvCount,
      c.sentCount > 0 ? c.sentSum / c.sentCount : null,
      c.recvCount > 0 ? c.recvSum / c.recvCount : null,
    );
    sentRows++;
  }

  // TF-IDF top terms — natural.TfIdf wants one document per contact. We
  // expand each Map<token,count> back to an array so token frequency is
  // preserved (TfIdf counts occurrences in the passed array).
  const tfidf = new natural.TfIdf();
  const tfidfContacts = perContact.filter((c) => c.eligibleForTfidf && c.tokens.size > 0);
  for (const c of tfidfContacts) {
    const doc = [];
    for (const [tok, n] of c.tokens) {
      for (let i = 0; i < n; i++) doc.push(tok);
    }
    tfidf.addDocument(doc);
  }

  const insertTerm = viz.prepare(`
    INSERT INTO contact_top_terms (identifier, rank, term, score) VALUES (?, ?, ?, ?)
  `);
  let termRows = 0;
  tfidfContacts.forEach((c, docIdx) => {
    // listTerms returns sorted desc by tfidf score; take top 20.
    const terms = tfidf.listTerms(docIdx).slice(0, 20);
    terms.forEach((t, i) => {
      insertTerm.run(c.identifier, i + 1, t.term, t.tfidf);
      termRows++;
    });
  });

  // Monthly sentiment trend.
  const insertMonth = viz.prepare(`
    INSERT INTO sentiment_monthly (ym, sent_avg, received_avg, sent_count, received_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  const months = [...sentByMonth.keys()].sort();
  for (const ym of months) {
    const r = sentByMonth.get(ym);
    insertMonth.run(
      ym,
      r.sentCount > 0 ? r.sentSum / r.sentCount : null,
      r.recvCount > 0 ? r.recvSum / r.recvCount : null,
      r.sentCount,
      r.recvCount,
    );
  }

  log(
    `nlp: contact_sentiment=${sentRows}, contact_top_terms=${termRows} ` +
      `(${tfidfContacts.length} contacts, min ${TFIDF_MIN_MSGS} msgs + named), ` +
      `sentiment_monthly=${months.length}`,
  );
}

function buildAggregates(viz) {
  // Real conversational messages only: item_type=0, exclude reactions.
  // Reactions and system-event rows distort response analytics.

  viz.exec(`
    INSERT INTO contact_summary (
      identifier, display_name, handle_ids, services,
      total_messages, sent_count, received_count,
      first_message_unix, last_message_unix,
      attachments_count, reciprocity
    )
    SELECT
      c.identifier,
      MAX(c.display_name) AS display_name,
      GROUP_CONCAT(DISTINCT c.handle_id) AS handle_ids,
      GROUP_CONCAT(DISTINCT c.service) AS services,
      COUNT(m.message_id) AS total_messages,
      SUM(CASE WHEN m.is_from_me=1 THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN m.is_from_me=0 THEN 1 ELSE 0 END) AS received_count,
      MIN(m.ts_unix),
      MAX(m.ts_unix),
      SUM(CASE WHEN m.has_attachment=1 THEN 1 ELSE 0 END),
      CASE WHEN COUNT(m.message_id)=0 THEN NULL
           ELSE 1.0 * SUM(CASE WHEN m.is_from_me=1 THEN 1 ELSE 0 END) / COUNT(m.message_id)
      END
    FROM contacts c
    LEFT JOIN messages m
      ON m.handle_id = c.handle_id
      AND m.item_type = 0
      AND m.is_reaction = 0
    WHERE c.identifier IS NOT NULL
    GROUP BY c.identifier;
  `);

  viz.exec(`
    INSERT INTO chat_summary (
      chat_id, display_name, chat_identifier, is_group,
      total_messages, sent_count, received_count,
      first_message_unix, last_message_unix
    )
    SELECT
      ch.chat_id,
      ch.display_name,
      ch.chat_identifier,
      ch.is_group,
      COUNT(m.message_id),
      SUM(CASE WHEN m.is_from_me=1 THEN 1 ELSE 0 END),
      SUM(CASE WHEN m.is_from_me=0 THEN 1 ELSE 0 END),
      MIN(m.ts_unix),
      MAX(m.ts_unix)
    FROM chats ch
    LEFT JOIN messages m
      ON m.chat_id = ch.chat_id
      AND m.item_type = 0
      AND m.is_reaction = 0
    GROUP BY ch.chat_id;
  `);

  viz.exec(`
    INSERT INTO monthly_volume (ym, sent, received, total)
    SELECT
      printf('%04d-%02d', year, month) AS ym,
      SUM(CASE WHEN is_from_me=1 THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN is_from_me=0 THEN 1 ELSE 0 END) AS received,
      COUNT(*) AS total
    FROM messages
    WHERE item_type=0 AND is_reaction=0
    GROUP BY year, month
    ORDER BY year, month;
  `);

  viz.exec(`
    INSERT INTO hourly_heatmap (dow, hour, count)
    SELECT dow, hour, COUNT(*) AS c
    FROM messages
    WHERE item_type=0 AND is_reaction=0
    GROUP BY dow, hour;
  `);

  viz.exec(`
    INSERT INTO auth_monthly_volume (ym, auth_count)
    SELECT
      printf('%04d-%02d', year, month) AS ym,
      COUNT(*) AS auth_count
    FROM messages
    WHERE auth_type = 'otp'
    GROUP BY year, month
    ORDER BY year, month;
  `);

  viz.exec(`
    INSERT INTO auth_senders_summary (handle_id, auth_count)
    SELECT handle_id, COUNT(*) AS auth_count
    FROM messages
    WHERE auth_type = 'otp' AND handle_id IS NOT NULL
    GROUP BY handle_id;
  `);

  viz.exec(`
    INSERT INTO promo_monthly_volume (ym, promo_count)
    SELECT
      printf('%04d-%02d', year, month) AS ym,
      COUNT(*) AS promo_count
    FROM messages
    WHERE promo_type = 'promo'
    GROUP BY year, month
    ORDER BY year, month;
  `);

  viz.exec(`
    INSERT INTO promo_senders_summary (handle_id, promo_count)
    SELECT handle_id, COUNT(*) AS promo_count
    FROM messages
    WHERE promo_type = 'promo' AND handle_id IS NOT NULL
    GROUP BY handle_id;
  `);

  log("aggregates: contact_summary, chat_summary, monthly_volume, hourly_heatmap, auth_monthly_volume, auth_senders_summary, promo_monthly_volume, promo_senders_summary built");
}

function loadContactIndex(root) {
  // Reads any *.abcddb files found under `root` and returns a normalized
  // identifier->display_name Map. If no files are reachable (most often
  // because Terminal lacks Full Disk Access), we continue gracefully — UI
  // falls back to raw identifiers and any user-set aliases.
  const { index, files } = buildContactIndex(root);
  if (files.length === 0) {
    log(`AddressBook: no readable .abcddb files under ${root}`);
    log(`  grant Terminal Full Disk Access to autopopulate names from Contacts`);
    log(`  (System Settings → Privacy & Security → Full Disk Access)`);
  } else {
    log(`AddressBook: indexed ${index.size} keys from ${files.length} db file(s)`);
    for (const f of files) log(`  - ${f}`);
  }
  return index;
}

function writeMeta(viz, info) {
  const stmt = viz.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(info)) {
    stmt.run(k, String(v));
  }
}

function main() {
  log(`source: ${CHAT_DB_PATH}`);
  log(`output: ${VIZ_DB_PATH}`);

  ensureDir(VIZ_DB_PATH);
  if (existsSync(VIZ_DB_PATH)) {
    rmSync(VIZ_DB_PATH);
    log("removed previous viz.sqlite");
  }

  const chat = openReadOnly(CHAT_DB_PATH);
  const viz = new DatabaseSync(VIZ_DB_PATH);
  viz.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

  buildSchema(viz);

  const contactIndex = loadContactIndex(ADDRESSBOOK_ROOT);

  const t0 = Date.now();
  const contactsResult = importContacts(chat, viz, contactIndex);
  const chatsCount = importChats(chat, viz);
  const oneOnOne = buildOneOnOneMap(chat);
  const { count: messagesCount, nlpByHandle, sentByMonth } = importMessages(chat, viz, oneOnOne);
  buildAggregates(viz);
  buildNlpAggregates(viz, nlpByHandle, sentByMonth);

  writeMeta(viz, {
    schema_version: "2",
    imported_at: new Date().toISOString(),
    source_chat_db: CHAT_DB_PATH,
    source_chat_db_size: statSync(CHAT_DB_PATH).size,
    addressbook_root: ADDRESSBOOK_ROOT,
    addressbook_keys: contactIndex.size,
    contacts_count: contactsResult.count,
    contacts_matched: contactsResult.matched,
    chats_count: chatsCount,
    messages_count: messagesCount,
  });

  viz.exec("VACUUM;");
  chat.close();
  viz.close();

  const ms = Date.now() - t0;
  log(`done in ${ms}ms`);
}

main();
