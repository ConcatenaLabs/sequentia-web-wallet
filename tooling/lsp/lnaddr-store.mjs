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
// takes back what that code did. After an export, the file is the truth for the time rolled back:
// a name made then is added; a name the code before released or moved away from is ended as here
// (and its key marked as declined when it holds no other name); a name another key took there is
// that key's here too, and ended for the key that held it (declined likewise); a held name's
// stock is taken from the file. A name released here before the rollback stays ended whatever the
// file says, since that code refuses it to every key. Each name that changed hands is logged.
//
// Only a file this store exported tells a release apart from a name made here after the file was
// last read, so after any other write of the file (a rollback without the export) no name is
// ended, and a name the file and this store give to different keys, or a key holding a name in
// each, stops the store from opening (the service answers 503) with the command that settles it,
// run with the service stopped and the service started again afterwards:
//
//   node --experimental-sqlite tooling/lsp/lnaddr-store.mjs resolve <store path> file|store
//
// `file`: each such name is the file's key's, and a key's other name ends; `store`: each stays as
// this store has it, and the file's other name for the key ends. Either way an ended name stays
// its key's, and a name released here is never given to another key.
//
// One process writes the store at a time: the service, or an export or a resolve run with it
// stopped. Each holds the lock file beside the store (`<store>.sqlite.lock`, an SQLite file held
// in an exclusive transaction, so the lock is the operating system's and ends with its process
// however that ends) while the store is open, and a second writer is refused at once with a
// message that says so. Past opening, the service never waits for a lock: a write that meets one
// (a reader's tool holding the file) fails that one request at once, so no request holds the
// service's event loop.
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

// How long a connection waits for another's write while the store opens, before the service
// serves (an export and a resolve wait so throughout): only a reader's tool can hold one then.
export const BUSY_MS = 5_000;
const isBusy = (e) => !!e && (e.errcode === 5 || e.errcode === 6 || /database (table )?is locked/.test(String(e.message)));
// A connection to the store's file that waits for others' writes.
function connect (lib, file) {
  const db = new lib.DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  return db;
}
// The lock file of the one process that writes the store (the head of this file). -> the
// connection holding it, whose close() lets it go.
export const lockPathOf = (storePath) => sqlitePathOf(storePath) + '.lock';
function takeLock (lib, storePath) {
  const file = lockPathOf(storePath);
  let db = null;
  try {
    db = new lib.DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
  } catch (e) {
    try { if (db) db.close(); } catch {}
    if (isBusy(e)) throw new Error(`the name store ${sqlitePathOf(storePath)} is open in another process (the LSP, an export or a resolve); one process writes it at a time, so stop that one first`);
    throw e;
  }
  try { if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch {}
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
  const lock = takeLock(sqlite, opts.storePath);
  let db = null;
  try {
    db = connect(sqlite, sqlitePathOf(opts.storePath));
    const st = openedStore(db, opts);
    // Serving: a write that meets a lock fails its request at once (the head of this file).
    db.exec('PRAGMA busy_timeout = 0');
    const close = st.close;
    st.close = () => { close(); try { lock.close(); } catch {} };
    return st;
  } catch (e) { try { if (db) db.close(); } catch {} try { lock.close(); } catch {} throw e; }
}
function openedStore (db, { storePath, log = () => {}, nameOk = () => true, now = () => Date.now(), onConflict = null }) {
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
    namesOf: db.prepare('SELECT name FROM names WHERE pubkey = ? AND live = 1'),
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
  // A write transaction, its lock taken at BEGIN.
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
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
      if (c) {
        log(`[lnaddr] took back from ${path.basename(storePath)}, written by the code before this store: ${c.added} names made, ${c.ended} released or moved away, ${c.moved} changed hands, ${c.updated} stocks`);
        for (const t of c.conflicts) log(`[lnaddr] conflict: ${t}`);
      }
    } else if (onConflict) log(`[lnaddr] ${path.basename(storePath)} is as this store last read or wrote it: nothing to resolve`);
  }
  // What the code before did to the JSON file `j`, taken back (the head of this file).
  // -> { added, ended, moved, updated, conflicts: [text] }. A merge not from an export throws on a
  // name the file and this store give to different keys, unless `onConflict` chose a side.
  function mergeBack (j, fromExport) {
    const names = j.names || {}, c = { added: 0, ended: 0, moved: 0, updated: 0, conflicts: [] };
    const side = fromExport ? 'file' : onConflict, open = [], ended = new Set();
    const k8 = (k) => k.slice(0, 16);
    const end = (n, r) => { putRow(n, { pubkey: r.pubkey, at: r.at, seen: r.seen ?? nowS(), released: nowS() }); ended.add(r.pubkey); };
    // The file's name for each key: the first it holds (the code before answers a key with it).
    const fileOf = new Map();
    for (const [n, v] of Object.entries(names)) {
      if (!nameOk(n) || !validRec(v) || v.released || v.pubkey.startsWith(GONE)) continue;
      if (!fileOf.has(v.pubkey)) { fileOf.set(v.pubkey, n); continue; }
      // A second name of one key, which the code before never makes: ended, and kept its key's.
      const row = getRec(n);
      if (!row || row.pubkey === v.pubkey) { if (!row || !row.released) { end(n, { ...v, seen: v.seen ?? nowS() }); c.ended++; } }
      c.conflicts.push(`${n} is a second name of ${k8(v.pubkey)} in the file (beside ${fileOf.get(v.pubkey)}): ended`);
    }
    for (const [k, n] of fileOf) {
      const v = names[n], row = getRec(n);
      if (!row) { putRow(n, { ...v, seen: v.seen ?? nowS() }); q.undecline.run(k); c.added++; continue; }
      if (row.pubkey === k) {
        // A name ended here stays ended: the code before kept its row as it was given.
        if (row.released) continue;
        const r = { ...row };
        for (const f of ['stock', 'last', 'served']) { if (v[f] === undefined) delete r[f]; else r[f] = v[f]; }
        putRow(n, r); c.updated++; continue;
      }
      // Held by one key here and by another in the file.
      if (row.released) { c.conflicts.push(`${n} is ${k8(k)}'s in the file and was released here by ${k8(row.pubkey)}: it stays ended, never another key's`); continue; }
      if (!side) { open.push(`${n} (${k8(row.pubkey)}'s here, ${k8(k)}'s in the file)`); continue; }
      if (side === 'file') {
        putRow(n, { ...v, seen: v.seen ?? nowS() }); q.undecline.run(k); c.moved++;
        if (fromExport) ended.add(row.pubkey);
        c.conflicts.push(`${n} was ${k8(row.pubkey)}'s here and is ${k8(k)}'s in the file: now ${k8(k)}'s, and ended for ${k8(row.pubkey)}`);
      } else c.conflicts.push(`${n} is ${k8(row.pubkey)}'s here and was ${k8(k)}'s in the file: kept ${k8(row.pubkey)}'s`);
    }
    // One name a key: a key holding its file name and another here.
    for (const [k, n] of fileOf) {
      const mine = getRec(n);
      if (!mine || mine.pubkey !== k || mine.released) continue;
      const others = q.namesOf.all(k).map((r) => r.name).filter((x) => x !== n && !Object.prototype.hasOwnProperty.call(names, x));
      if (!others.length || fromExport) continue;      // after an export the loop below ends them
      if (!side) { open.push(`${k8(k)} holds ${others.join(', ')} here and ${n} in the file`); continue; }
      const drop = side === 'file' ? others : [n];
      for (const x of drop) end(x, getRec(x));
      c.ended += drop.length;
      c.conflicts.push(`${k8(k)} held ${others.join(', ')} here and ${n} in the file: ${drop.join(', ')} ended`);
    }
    if (open.length) {
      throw new Error(`the names file ${storePath} changed since this store last read it, not by an export, and ${open.length} of its names are held by other keys here: ${open.slice(0, 5).join('; ')}${open.length > 5 ? '; …' : ''}. ` +
        `Settle it with the service stopped, then start the service again: node --experimental-sqlite tooling/lsp/lnaddr-store.mjs resolve ${storePath} file (each goes as the file has it) or ... resolve ${storePath} store (each stays as this store has it)`);
    }
    if (fromExport) {
      for (const { name, rec } of db.prepare('SELECT name, rec FROM names WHERE live = 1').all()) {
        if (Object.prototype.hasOwnProperty.call(names, name)) continue;
        end(name, JSON.parse(rec)); c.ended++;
      }
    }
    // A key that lost its name here and holds none now: its person released it (the code before
    // gives a name to another key only once it is released or moved away from).
    if (fromExport) for (const k of ended) if (!q.nameOf.get(k)) q.decline.run(k, nowS());
    return c;
  }

  return {
    kind: 'sqlite',
    file,
    get: getRec,
    has: (n) => !!q.get.get(n),
    put: (n, rec) => { putRow(n, rec); },
    del: (n) => { q.del.run(n); },
    nameOf: (pk) => { const r = q.nameOf.get(pk); return r ? r.name : null; },
    count: () => Number(q.count.get().n),
    declined: (pk) => !!q.declined.get(pk),
    decline: (pk, at) => { q.decline.run(pk, at); },
    undecline: (pk) => { q.undecline.run(pk); },
    // -> how many names lost their stock: at most `limit`, so a caller runs it again until it
    // drops fewer.
    dropIdleStock (cutoffS, limit = 500) {
      return Number(q.idle.run(cutoffS, Number.isFinite(limit) ? limit : -1).changes);
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
  const lock = takeLock(lib, storePath);
  let db = null;
  try {
    db = connect(lib, file);
    db.exec('BEGIN');
    let rows;
    try { rows = db.prepare('SELECT name, rec, live FROM names ORDER BY live DESC, name').all(); } finally { db.exec('COMMIT'); }
    const names = {}, c = { live: 0, ended: 0 };
    for (const { name, rec, live } of rows) {
      const r = JSON.parse(rec);
      if (live) { names[name] = r; c.live++; } else { names[name] = { pubkey: GONE + r.pubkey, at: r.at, released: r.released }; c.ended++; }
    }
    const declined = Object.fromEntries(db.prepare('SELECT pubkey, at FROM declined').all().map((r) => [r.pubkey, r.at]));
    const out = JSON.stringify({ names, declined });
    writeJsonAtomic(storePath, null, out);
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run('json', JSON.stringify({ by: 'export', sha: shaOf(Buffer.from(out)) }));
    return c;
  } finally { try { if (db) db.close(); } catch {} lock.close(); }
}

// A names file the store refused to take back, settled (the head of this file): `side` 'file' or
// 'store' says whose key keeps each name the two give to different keys. Run with the service
// stopped; it logs what it did.
export function resolveJson (storePath, side, { log = () => {}, nameOk = () => true } = {}) {
  if (side !== 'file' && side !== 'store') throw new Error("say which side keeps a name held by different keys: 'file' or 'store'");
  const lib = loadSqlite();
  if (!lib || !fs.existsSync(sqlitePathOf(storePath))) throw new Error(`no SQLite store at ${sqlitePathOf(storePath)}`);
  sqliteStore(lib, { storePath, log, nameOk, onConflict: side }).close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, file, side] = process.argv.slice(2);
  const usage = 'usage: node --experimental-sqlite lnaddr-store.mjs export <store path (the .json)>\n       node --experimental-sqlite lnaddr-store.mjs resolve <store path (the .json)> file|store';
  if (!file || (cmd !== 'export' && cmd !== 'resolve')) { console.error(usage); process.exit(2); }
  try {
    if (cmd === 'export') {
      const c = exportJson(path.resolve(file));
      console.log(`wrote ${c.live} names in use and ${c.ended} released or moved-away names to ${path.resolve(file)}`);
    } else {
      const { nameProblem } = await import('../../lnaddr.js');
      resolveJson(path.resolve(file), side, { log: (...a) => console.log(...a), nameOk: (n) => !nameProblem(n) });
    }
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
