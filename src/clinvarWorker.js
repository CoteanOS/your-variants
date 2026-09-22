/**
 * clinvarWorker.js  - runs in a Web Worker (required for OPFS).
 * Owns the SQLite DB. Talk to it via clinvarClient.js, not directly.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const DB_FILENAME = "clinvar.sqlite";
let db = null;
let poolUtil = null;

const SELECT_COLS = `
  variation_id, allele_id, type, name, gene_symbol,
  clinical_significance, clin_sig_simple, review_status,
  last_evaluated, rsid, phenotypes, chromosome, pos, ref, alt,
  number_submitters
`;

async function streamDownload(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    self.postMessage({ type: "progress", received, total });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function init({ url, forceReload = false }) {
  const sqlite3 = await sqlite3InitModule();
  if (!poolUtil) {
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      name: "yourvariants-pool",
      initialCapacity: 2,
    });
  }
  const present = poolUtil.getFileNames().some((f) => f.endsWith(DB_FILENAME));
  if (forceReload && present) poolUtil.unlink("/" + DB_FILENAME);
  if (!present || forceReload) {
    const bytes = await streamDownload(url);
    poolUtil.importDb("/" + DB_FILENAME, bytes);
  }
  db = new poolUtil.OpfsSAHPoolDb("/" + DB_FILENAME);
  db.exec("PRAGMA query_only = ON;");
  return { ok: true, cached: present && !forceReload, meta: readMeta() };
}

/** Read the self-describing meta table, if the DB has one. */
function readMeta() {
  try {
    const rows = db.selectObjects("SELECT key, value FROM meta");
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {}; // older DBs built before meta existed
  }
}

const methods = {
  init,

  lookupByGene: ({ gene, limit = 500 }) =>
    db.selectObjects(
      `SELECT ${SELECT_COLS} FROM variants WHERE gene_symbol = ? LIMIT ?`,
      [String(gene).toUpperCase(), limit]
    ),

  lookupByRsid: ({ rsid }) => {
    const n = Number(String(rsid).replace(/^rs/i, ""));
    if (!Number.isFinite(n)) return [];
    return db.selectObjects(
      `SELECT ${SELECT_COLS} FROM variants WHERE rsid = ?`,
      [n]
    );
  },

  /**
   * Batch match: load all the user's rsids into a temp table, then JOIN
   * against ClinVar in one query. Returns matching ClinVar variant rows.
   */
  matchRsids: ({ rsids }) => {
    db.exec("PRAGMA query_only = OFF;");
    db.exec("DROP TABLE IF EXISTS _user_rsids;");
    db.exec("CREATE TEMP TABLE _user_rsids (rsid INTEGER PRIMARY KEY);");
    db.exec("BEGIN;");
    const stmt = db.prepare("INSERT OR IGNORE INTO _user_rsids (rsid) VALUES (?)");
    try {
      for (const r of rsids) {
        if (!Number.isFinite(r)) continue;
        stmt.bind([r]);
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.finalize();
    }
    db.exec("COMMIT;");
    const rows = db.selectObjects(
      `SELECT v.* FROM variants v JOIN _user_rsids u ON v.rsid = u.rsid`
    );
    db.exec("DROP TABLE IF EXISTS _user_rsids;");
    db.exec("PRAGMA query_only = ON;");
    return rows;
  },
};

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const result = await methods[method](args || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
