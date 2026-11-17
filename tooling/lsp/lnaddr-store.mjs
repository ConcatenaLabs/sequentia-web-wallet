// The payment names' store (lnaddr.mjs): one record per name, written when that name changes and
// never the whole store at once, so a lookup costs the same with ten names or a hundred thousand.
//
// A name's record: { pubkey, at, seen, stock?, last?, served?, released? } (lnaddr.mjs says what each
// is; a `released` name stays its key's and answers no lookup, so it is never anyone else's), plus
// one mark per key whose person removed its name (`declined`), which keeps the wallet from making
// one again by itself on any device.
//
// Kept in SQLite (node:sqlite) at the store's path with `.json` replaced by `.sqlite`, one row per
// name. The first start with a SQLite store imports the JSON file the service used to keep at the
// store's path (`{ names: { <name>: record } }`) and leaves that file as it was, so a rollback to
// the code that reads it finds every name it held. `export` writes the JSON file from the SQLite
// store, for a rollback that keeps the names made since:
//
//   node tooling/lsp/lnaddr-store.mjs export <store path>
//
// It uses only what node:sqlite has in Node 22.11 run with --experimental-sqlite, the Node the
// testnet's LSP runs (its unit passes the flag; Node 22.13 and later need none): DatabaseSync,
// exec, prepare, and a statement's run, get and all; never iterate, nor the constructor's options.
//
// Where node:sqlite is missing (a Node before 22.5, or one started without --experimental-sqlite) the
// names are kept in memory and the JSON file at the store's path is written whole when something
// changed, at most every `flushMs`. With no store path, in memory only (the tests).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const sqlitePathOf = (storePath) => storePath.replace(/\.json$/i, '') + '.sqlite';
// Whether this Node can load node:sqlite as it was started (22.13 and later, or 22.5 to 22.12 with
// --experimental-sqlite).
export const sqliteAvailable = () => !!loadSqlite();

function loadSqlite () {
  // node:sqlite warns once that it is experimental; that warning says nothing to an operator.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => { if (String((w && w.message) || w).includes('SQLite')) return; return emit.call(process, w, ...a); };
  try { return require('node:sqlite'); } catch { return null; } finally { process.emitWarning = emit; }
}

function readJson (file, log) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') log('[lnaddr] store unreadable:', e.message); return null; }
}
function writeJsonAtomic (file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const validRec = (v) => v && typeof v === 'object' && typeof v.pubkey === 'string';

// Records in memory: what the tests and a Node without node:sqlite use. Each record is kept as
// text, so a caller's object is never the stored one (as with SQLite).
function memoryStore ({ jsonPath = null, flushMs = 5_000, log = () => {}, nameOk = () => true, now = () => Date.now() } = {}) {
  const names = new Map(), byKey = new Map(), declined = new Map();
  if (jsonPath) {
    const j = readJson(jsonPath, log) || {};
    const at = Math.floor(now() / 1000);
    for (const [n, v] of Object.entries(j.names || {})) if (nameOk(n) && validRec(v)) { if (v.seen == null) v.seen = at; names.set(n, JSON.stringify(v)); if (!v.released) byKey.set(v.pubkey, n); }
    for (const [k, at] of Object.entries(j.declined || {})) declined.set(k, Number(at) || 0);
  }
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!jsonPath) return;
    const out = {}; for (const [n, v] of names) out[n] = JSON.parse(v);
    writeJsonAtomic(jsonPath, { names: out, declined: Object.fromEntries(declined) });
  };
  const changed = () => { if (jsonPath && !timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); } };
  return {
    kind: jsonPath ? 'json' : 'memory',
    get: (n) => { const v = names.get(n); return v ? JSON.parse(v) : null; },
    has: (n) => names.has(n),
    put (n, rec) {
      const old = names.get(n); if (old) { const o = JSON.parse(old); if (byKey.get(o.pubkey) === n) byKey.delete(o.pubkey); }
      names.set(n, JSON.stringify(rec)); if (!rec.released) byKey.set(rec.pubkey, n); changed();
    },
    del (n) { const v = names.get(n); if (!v) return; const o = JSON.parse(v); if (byKey.get(o.pubkey) === n) byKey.delete(o.pubkey); names.delete(n); changed(); },
    nameOf: (pk) => byKey.get(pk) || null,
    count: () => names.size,
    declined: (pk) => declined.has(pk),
    decline (pk, at) { declined.set(pk, at); changed(); },
    undecline (pk) { if (declined.delete(pk)) changed(); },
    dropIdleStock (cutoffS) {
      let n = 0;
      for (const [name, v] of names) {
        const r = JSON.parse(v);
        if ((r.seen ?? r.at ?? 0) < cutoffS && ((r.stock && r.stock.length) || (r.served && r.served.length))) { delete r.stock; delete r.served; names.set(name, JSON.stringify(r)); n++; }
      }
      if (n) changed();
      return n;
    },
    all: () => Object.fromEntries([...names].map(([n, v]) => [n, JSON.parse(v)])),
    allDeclined: () => Object.fromEntries(declined),
    close: flush,
  };
}

function sqliteStore (sqlite, { storePath, log = () => {}, nameOk = () => true, now = () => Date.now() }) {
  const file = sqlitePathOf(storePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  const db = new sqlite.DatabaseSync(file);
  if (fresh) { try { fs.chmodSync(file, 0o600); } catch {} }
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, rec TEXT NOT NULL, seen INTEGER NOT NULL, stocked INTEGER NOT NULL, live INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS names_live_pubkey ON names (pubkey) WHERE live = 1;
    CREATE INDEX IF NOT EXISTS names_stocked_seen ON names (seen) WHERE stocked = 1;
    CREATE TABLE IF NOT EXISTS declined (pubkey TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const q = {
    get: db.prepare('SELECT rec FROM names WHERE name = ?'),
    put: db.prepare('INSERT INTO names (name, pubkey, rec, seen, stocked, live) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET pubkey = excluded.pubkey, rec = excluded.rec, seen = excluded.seen, stocked = excluded.stocked, live = excluded.live'),
    del: db.prepare('DELETE FROM names WHERE name = ?'),
    nameOf: db.prepare('SELECT name FROM names WHERE pubkey = ? AND live = 1 LIMIT 1'),
    count: db.prepare('SELECT count(*) AS n FROM names'),
    declined: db.prepare('SELECT 1 AS d FROM declined WHERE pubkey = ?'),
    decline: db.prepare('INSERT INTO declined (pubkey, at) VALUES (?, ?) ON CONFLICT (pubkey) DO UPDATE SET at = excluded.at'),
    undecline: db.prepare('DELETE FROM declined WHERE pubkey = ?'),
    // Only the rows that hold a stock are read: the index holds no other.
    idle: db.prepare('SELECT name, rec FROM names WHERE stocked = 1 AND seen < ?'),
    meta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
  };
  const seenOf = (rec) => Math.floor(Number(rec.seen ?? rec.at ?? 0)) || 0;
  const stockedOf = (rec) => ((rec.stock && rec.stock.length) || (rec.served && rec.served.length) ? 1 : 0);
  const putRow = (name, rec) => q.put.run(name, rec.pubkey, JSON.stringify(rec), seenOf(rec), stockedOf(rec), rec.released ? 0 : 1);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // The JSON file of the code before this store, imported once and left in place.
  if (!q.meta.get('imported') && fs.existsSync(storePath)) {
    const j = readJson(storePath, log);
    if (j) {
      let n = 0, d = 0;
      tx(() => {
        // A record of before has no `seen`: it counts from the import, never as idle at once.
        const at = Math.floor(now() / 1000);
        for (const [name, v] of Object.entries(j.names || {})) if (nameOk(name) && validRec(v)) { if (v.seen == null) v.seen = at; putRow(name, v); n++; }
        for (const [k, at] of Object.entries(j.declined || {})) { q.decline.run(k, Number(at) || 0); d++; }
        q.setMeta.run('imported', JSON.stringify({ from: path.basename(storePath), names: n, declined: d, at: Math.floor(now() / 1000) }));
      });
      log(`[lnaddr] imported ${n} names from ${path.basename(storePath)} into ${path.basename(file)}; the JSON file is kept as it was`);
    }
  }
  if (!q.meta.get('imported')) q.setMeta.run('imported', JSON.stringify({ from: null }));

  return {
    kind: 'sqlite',
    file,
    get: (n) => { const r = q.get.get(n); return r ? JSON.parse(r.rec) : null; },
    has: (n) => !!q.get.get(n),
    put: (n, rec) => { putRow(n, rec); },
    del: (n) => { q.del.run(n); },
    nameOf: (pk) => { const r = q.nameOf.get(pk); return r ? r.name : null; },
    count: () => Number(q.count.get().n),
    declined: (pk) => !!q.declined.get(pk),
    decline: (pk, at) => { q.decline.run(pk, at); },
    undecline: (pk) => { q.undecline.run(pk); },
    dropIdleStock (cutoffS) {
      const rows = q.idle.all(cutoffS);
      tx(() => { for (const { name, rec } of rows) { const r = JSON.parse(rec); delete r.stock; delete r.served; putRow(name, r); } });
      return rows.length;
    },
    all: () => Object.fromEntries(db.prepare('SELECT name, rec FROM names').all().map((r) => [r.name, JSON.parse(r.rec)])),
    allDeclined: () => Object.fromEntries(db.prepare('SELECT pubkey, at FROM declined').all().map((r) => [r.pubkey, r.at])),
    close: () => { try { db.close(); } catch {} },
  };
}

// The store for `storePath` (the JSON file's path; '' or null: in memory only).
export function openNameStore ({ storePath = null, log = () => {}, nameOk = () => true, now = () => Date.now(), flushMs = 5_000, sqlite = undefined } = {}) {
  if (!storePath) return memoryStore({ log, nameOk });
  const lib = sqlite === undefined ? loadSqlite() : sqlite;
  if (lib) return sqliteStore(lib, { storePath, log, nameOk, now });
  log('[lnaddr] node:sqlite is not available in this Node; names are kept in the JSON file, written whole when they change');
  return memoryStore({ jsonPath: storePath, flushMs, log, nameOk, now });
}

// The store opened only to be read. Node 22.11 ignores DatabaseSync's `readOnly` option (it
// opens, creates and writes as if it were not given), so the connection is made read-only with a
// pragma instead, which every SQLite honours.
function openToRead (lib, file) {
  const db = new lib.DatabaseSync(file);
  db.exec('PRAGMA query_only = ON');
  return db;
}

// Every name the store at `storePath` holds, as { <name>: record }.
export function readStoreNames (storePath) {
  const lib = loadSqlite();
  if (lib && fs.existsSync(sqlitePathOf(storePath))) {
    const db = openToRead(lib, sqlitePathOf(storePath));
    try { return Object.fromEntries(db.prepare('SELECT name, rec FROM names').all().map((r) => [r.name, JSON.parse(r.rec)])); } finally { db.close(); }
  }
  return (readJson(storePath, () => {}) || {}).names || {};
}

// The JSON file the code before this store reads, written from the store: for a rollback.
export function exportJson (storePath) {
  const lib = loadSqlite();
  if (!lib || !fs.existsSync(sqlitePathOf(storePath))) throw new Error(`no SQLite store at ${sqlitePathOf(storePath)}`);
  const db = openToRead(lib, sqlitePathOf(storePath));
  try {
    // A released name is left out: the code before reads every record as a name in use.
    const names = Object.fromEntries(db.prepare('SELECT name, rec FROM names WHERE live = 1').all().map((r) => [r.name, JSON.parse(r.rec)]));
    const declined = Object.fromEntries(db.prepare('SELECT pubkey, at FROM declined').all().map((r) => [r.pubkey, r.at]));
    writeJsonAtomic(storePath, { names, declined });
    return Object.keys(names).length;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'export' || !file) { console.error('usage: node lnaddr-store.mjs export <store path (the .json)>'); process.exit(2); }
  const n = exportJson(path.resolve(file));
  console.log(`wrote ${n} names to ${path.resolve(file)}`);
}
