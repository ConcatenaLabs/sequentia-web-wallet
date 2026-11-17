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
// store's path (`{ names: { <name>: record } }`) and leaves that file as it was.
//
// A rollback to the code before this store (which reads only that JSON file) first writes it from
// the store, with the service stopped (bin/deploy-web-wallet.sh in sequentia-testnet-ops does both):
//
//   node --experimental-sqlite tooling/lsp/lnaddr-store.mjs export <store path>
//
// The export keeps every name. A released or moved-away name goes out under a key no wallet holds
// (`released:<its key>`): the code before then refuses it to every key (it checks the key a name is
// held by), hands payers no code for it (it holds none), and never answers it as a wallet's own
// name, so neither a payer nor a removal is undone by a rollback. When this store opens again and
// the JSON file has changed since it last read or wrote it (the code before ran meanwhile), it
// takes back what that code did: a name made then is added, a name it released or moved away from
// is ended as here (and its key marked as declined when it holds no other name), and a held name's
// stock is taken from the file. Only a file this store exported tells a release apart from a name
// made here after the file was last read, so only then are names ended.
//
// Several processes may open the store (the service, `export`, a reader): each waits up to
// BUSY_MS for another's write, and opening or writing tries again a few times after that before it
// fails with SQLite's own "database is locked".
//
// It uses only what node:sqlite has in Node 22.11 run with --experimental-sqlite, the Node the
// testnet's LSP runs (its unit passes the flag; Node 22.13 and later need none): DatabaseSync,
// exec, prepare, and a statement's run, get and all; never iterate, nor the constructor's options.
//
// Where node:sqlite is missing (a Node before 22.5, or one started without --experimental-sqlite) the
// names are kept in memory and the JSON file at the store's path is written whole when something
// changed, at most every `flushMs`; but never once a SQLite store exists beside it, whose names
// that file does not hold: opening then fails. Opening also fails when the names file is there and
// cannot be read. With no store path, in memory only (the tests).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
function writeJsonAtomic (file, obj, text = JSON.stringify(obj)) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const validRec = (v) => v && typeof v === 'object' && typeof v.pubkey === 'string';
// The key an exported released name is held by: no wallet's (see the head of this file).
export const GONE = 'released:';
const shaOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// How long a connection waits for another's write, and how often opening or a write tries again
// after that wait (SQLite's busy and locked results, codes 5 and 6).
export const BUSY_MS = 5_000;
const TRIES = 3;
const isBusy = (e) => !!e && (e.errcode === 5 || e.errcode === 6 || /database (table )?is locked/.test(String(e.message)));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retrying (fn, tries = TRIES) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) { if (!isBusy(e) || i >= tries) throw e; pause(100 * 2 ** i); }
  }
}
// A connection to the store's file that waits for others' writes.
function connect (lib, file) {
  const db = new lib.DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  return db;
}

// Records in memory: what the tests and a Node without node:sqlite use. Each record is kept as
// text, so a caller's object is never the stored one (as with SQLite).
function memoryStore ({ jsonPath = null, flushMs = 5_000, log = () => {}, nameOk = () => true, now = () => Date.now() } = {}) {
  const names = new Map(), byKey = new Map(), declined = new Map();
  if (jsonPath) {
    const j = fs.existsSync(jsonPath) ? readJson(jsonPath, log) : {};
    if (!j) throw new Error(`the names file ${jsonPath} cannot be read; refusing to start with no names`);
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
    count: () => byKey.size,
    declined: (pk) => declined.has(pk),
    decline (pk, at) { declined.set(pk, at); changed(); },
    undecline (pk) { if (declined.delete(pk)) changed(); },
    dropIdleStock (cutoffS, limit = Infinity) {
      let n = 0;
      for (const [name, v] of names) {
        if (n >= limit) break;
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

function sqliteStore (sqlite, opts) {
  fs.mkdirSync(path.dirname(sqlitePathOf(opts.storePath)), { recursive: true });
  // Opening, the schema, the import and the merge, tried again while another process writes.
  return retrying(() => {
    const db = connect(sqlite, sqlitePathOf(opts.storePath));
    try { return openedStore(db, opts); } catch (e) { try { db.close(); } catch {} throw e; }
  });
}
function openedStore (db, { storePath, log = () => {}, nameOk = () => true, now = () => Date.now() }) {
  const file = sqlitePathOf(storePath);
  try { if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch {}
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
    // The names in use: a released name is kept for good but takes no place under the cap.
    count: db.prepare('SELECT count(*) AS n FROM names WHERE live = 1'),
    declined: db.prepare('SELECT 1 AS d FROM declined WHERE pubkey = ?'),
    decline: db.prepare('INSERT INTO declined (pubkey, at) VALUES (?, ?) ON CONFLICT (pubkey) DO UPDATE SET at = excluded.at'),
    undecline: db.prepare('DELETE FROM declined WHERE pubkey = ?'),
    // A batch of idle names' stock dropped in SQL, never read into the service: only the rows that
    // hold a stock are looked at (the index holds no other).
    idle: db.prepare("UPDATE names SET rec = json_remove(rec, '$.stock', '$.served'), stocked = 0 WHERE rowid IN (SELECT rowid FROM names WHERE stocked = 1 AND seen < ? LIMIT ?)"),
    meta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
  };
  const seenOf = (rec) => Math.floor(Number(rec.seen ?? rec.at ?? 0)) || 0;
  const stockedOf = (rec) => ((rec.stock && rec.stock.length) || (rec.served && rec.served.length) ? 1 : 0);
  const putRow = (name, rec) => q.put.run(name, rec.pubkey, JSON.stringify(rec), seenOf(rec), stockedOf(rec), rec.released ? 0 : 1);
  // A write transaction, its lock taken at BEGIN so it waits (busy_timeout) rather than fails later.
  const tx = (fn) => retrying(() => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } });
  const nowS = () => Math.floor(now() / 1000);
  const getRec = (n) => { const r = q.get.get(n); return r ? JSON.parse(r.rec) : null; };
  // The JSON file as this store last read or wrote it: { by: 'import' | 'export' | 'merge', sha }.
  const jsonSeen = () => { const r = q.meta.get('json'); try { return r ? JSON.parse(r.v) : null; } catch { return null; } };
  const readBytes = () => { try { return fs.readFileSync(storePath); } catch (e) { if (e.code !== 'ENOENT') log('[lnaddr] store unreadable:', e.message); return null; } };
  const parse = (bytes) => { try { return JSON.parse(bytes.toString('utf8')) || {}; } catch (e) { log('[lnaddr] JSON store unreadable:', e.message); return null; } };

  // The JSON file of the code before this store, imported once and left in place.
  // A names file that is there and cannot be read stops the store: starting on no names, or on
  // fewer than the file holds, is how a payer is sent to another key.
  const unreadable = () => new Error(`the names file ${storePath} cannot be read; refusing to start without the names it holds`);
  if (!q.meta.get('imported')) {
    const bytes = fs.existsSync(storePath) ? readBytes() : null, j = bytes && parse(bytes);
    if (fs.existsSync(storePath) && !j) throw unreadable();
    let n = 0, d = 0;
    tx(() => {
      if (j) {
        // A record of before has no `seen`: it counts from the import, never as idle at once.
        const at = nowS();
        for (const [name, v] of Object.entries(j.names || {})) if (nameOk(name) && validRec(v)) { if (v.seen == null) v.seen = at; putRow(name, v); n++; }
        for (const [k, at] of Object.entries(j.declined || {})) { q.decline.run(k, Number(at) || 0); d++; }
        q.setMeta.run('json', JSON.stringify({ by: 'import', sha: shaOf(bytes) }));
      }
      q.setMeta.run('imported', JSON.stringify({ from: j ? path.basename(storePath) : null, names: n, declined: d, at: nowS() }));
    });
    if (j) log(`[lnaddr] imported ${n} names from ${path.basename(storePath)} into ${path.basename(file)}; the JSON file is kept as it was`);
  } else {
    // The code before ran on the JSON file since this store last read or wrote it: what it did is
    // taken back (the head of this file).
    const seen = jsonSeen(), bytes = fs.existsSync(storePath) ? readBytes() : null;
    if (fs.existsSync(storePath) && !bytes) throw unreadable();
    if (bytes && (!seen || seen.sha !== shaOf(bytes))) {
      const j = seen ? parse(bytes) : null;
      if (seen && !j) throw unreadable();
      const c = j ? tx(() => mergeBack(j, seen.by === 'export')) : null;
      q.setMeta.run('json', JSON.stringify({ by: 'merge', sha: shaOf(bytes) }));
      if (c) log(`[lnaddr] took back from ${path.basename(storePath)}, written by the code before this store: ${c.added} names made, ${c.ended} released or moved away, ${c.updated} stocks`);
    }
  }
  function mergeBack (j, fromExport) {
    const names = j.names || {}, c = { added: 0, ended: 0, updated: 0 };
    const held = new Set(Object.values(names).filter((v) => validRec(v) && !v.released && !v.pubkey.startsWith(GONE)).map((v) => v.pubkey));
    for (const [n, v] of Object.entries(names)) {
      if (!nameOk(n) || !validRec(v) || v.released || v.pubkey.startsWith(GONE)) continue;
      const row = getRec(n);
      if (!row) { putRow(n, { ...v, seen: v.seen ?? nowS() }); c.added++; continue; }
      // A name ended here stays ended: the code before kept its row as it was given.
      if (row.released || row.pubkey !== v.pubkey) continue;
      const r = { ...row };
      for (const k of ['stock', 'last', 'served']) { if (v[k] === undefined) delete r[k]; else r[k] = v[k]; }
      putRow(n, r); c.updated++;
    }
    if (fromExport) {
      for (const { name, rec } of db.prepare('SELECT name, rec FROM names WHERE live = 1').all()) {
        if (Object.prototype.hasOwnProperty.call(names, name)) continue;
        const r = JSON.parse(rec);
        putRow(name, { pubkey: r.pubkey, at: r.at, seen: r.seen, released: nowS() }); c.ended++;
        if (!held.has(r.pubkey)) q.decline.run(r.pubkey, nowS());
      }
    }
    return c;
  }

  return {
    kind: 'sqlite',
    file,
    get: getRec,
    has: (n) => !!q.get.get(n),
    put: (n, rec) => { retrying(() => putRow(n, rec)); },
    del: (n) => { retrying(() => q.del.run(n)); },
    nameOf: (pk) => { const r = q.nameOf.get(pk); return r ? r.name : null; },
    count: () => Number(q.count.get().n),
    declined: (pk) => !!q.declined.get(pk),
    decline: (pk, at) => { retrying(() => q.decline.run(pk, at)); },
    undecline: (pk) => { retrying(() => q.undecline.run(pk)); },
    // -> how many names lost their stock: at most `limit`, so a caller runs it again until it
    // drops fewer.
    dropIdleStock (cutoffS, limit = 500) {
      return Number(retrying(() => q.idle.run(cutoffS, Number.isFinite(limit) ? limit : -1)).changes);
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
  // The names are in SQLite already: the JSON file is older than they are, and serving it would
  // free every name made since.
  if (fs.existsSync(sqlitePathOf(storePath))) throw new Error(`the names are in ${sqlitePathOf(storePath)}, and this Node cannot load node:sqlite (Node 22.13 or later, or 22.5 to 22.12 with --experimental-sqlite); refusing to serve the older ${path.basename(storePath)}`);
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

// The JSON file the code before this store reads, written from the store: for a rollback, with
// the service stopped. Every name goes out, the names in use first (the code before answers a key
// with the first name it finds for it), then each released or moved-away name under a key no
// wallet holds (GONE), so that code refuses it to everyone and serves it to no payer. The store
// records what it wrote, so that when it opens again it takes back what the code before did.
// -> { live, ended }: the names written of each kind.
export function exportJson (storePath) {
  const lib = loadSqlite();
  const file = sqlitePathOf(storePath);
  if (!lib || !fs.existsSync(file)) throw new Error(`no SQLite store at ${file}`);
  const db = connect(lib, file);
  try {
    const rows = retrying(() => {
      db.exec('BEGIN');
      try { return db.prepare('SELECT name, rec, live FROM names ORDER BY live DESC, name').all(); } finally { db.exec('COMMIT'); }
    });
    const names = {}, c = { live: 0, ended: 0 };
    for (const { name, rec, live } of rows) {
      const r = JSON.parse(rec);
      if (live) { names[name] = r; c.live++; } else { names[name] = { pubkey: GONE + r.pubkey, at: r.at, released: r.released }; c.ended++; }
    }
    const declined = Object.fromEntries(db.prepare('SELECT pubkey, at FROM declined').all().map((r) => [r.pubkey, r.at]));
    const out = JSON.stringify({ names, declined });
    writeJsonAtomic(storePath, null, out);
    retrying(() => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run('json', JSON.stringify({ by: 'export', sha: shaOf(Buffer.from(out)) })));
    return c;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'export' || !file) { console.error('usage: node lnaddr-store.mjs export <store path (the .json)>'); process.exit(2); }
  const c = exportJson(path.resolve(file));
  console.log(`wrote ${c.live} names in use and ${c.ended} released or moved-away names to ${path.resolve(file)}`);
}
