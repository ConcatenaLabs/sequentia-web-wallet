// lnaddr-store.mjs and the name service on it: the JSON file of before imported once and kept; the
// export a rollback uses, run against the service deployed before this store, and what that
// service did taken back afterwards; several processes on one store; one record written per change
// and none per read; the stock of an idle name dropped (never the name); the store without
// node:sqlite; and a lookup that misses costing the same as one that finds a name. Under node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { makeLnaddr } from './lnaddr.mjs';
import { makeLnaddr as makeLnaddrBefore } from './testdata/lnaddr-before.mjs';
import { openNameStore, readStoreNames, exportJson, sqlitePathOf, sqliteAvailable, GONE } from './lnaddr-store.mjs';
import { nameKey, signedDigest, signWith, signCode } from '../../lnaddr.js';
import { buildPayCode } from '../../pay-code.js';

const DOMAIN = 'sequentiatestnet.com';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
// The SQLite store's own tests need node:sqlite as this Node was started; without it the service
// keeps the JSON file, which the test of that path checks.
const SQLITE = sqliteAvailable() ? {} : { skip: 'node:sqlite is not in this Node (22.13 and later, or 22.5 to 22.12 with --experimental-sqlite)' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lnaddr-store-'));

// `make`: this service (lnaddr.mjs) or the one deployed before this store (testdata/lnaddr-before.mjs,
// web aee65e85), which reads and writes only the JSON file.
async function serve (storePath, cfg = {}, make = makeLnaddr) {
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = make({ domain: DOMAIN, base, storePath, waitMs: 500, holdMs: 300, onlineMs: 1000, ...cfg });
  server.on('request', async (req, res) => { if (await svc.handle(req, res, new URL(req.url, 'http://x'))) return; res.writeHead(401); res.end('{}'); });
  return { svc, base, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }).finally(() => svc.close && svc.close()) };
}
const get = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const ts = () => Math.floor(Date.now() / 1000);
const ADDRESSES = [ADDRESS, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c'];

// A JSON store as the code before lnaddr-store.mjs wrote it.
function oldJson (k) {
  const c = signCode(k.priv, DOMAIN, 'alice', buildPayCode({ address: ADDRESS }));
  return { names: { alice: { pubkey: k.pub, at: 1_700_000_000, stock: [{ ...c, until: null }] }, bob: { pubkey: 'ab'.repeat(32), at: 1_700_000_001 }, 'Not A Name': { pubkey: 'cd'.repeat(32) } } };
}

test('the JSON file of before: imported once on the first start, and left as it was', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json'), k = nameKey(PHRASE);
  fs.writeFileSync(file, JSON.stringify(oldJson(k)), { mode: 0o600 });
  const bytes = fs.readFileSync(file);
  const logs = [];
  let s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
  try {
    assert.match(logs.join('\n'), /imported 2 names from lnaddr-names\.json/);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${k.pub}`)).body.name, 'alice');
    const r = await get(`${s.base}/lnaddr/alice`);
    assert.equal(r.status, 200); assert.equal(r.body.fresh, true, 'its stock came with it');
    assert.deepEqual(fs.readFileSync(file), bytes, 'the JSON file is untouched');
    assert.equal(fs.statSync(sqlitePathOf(file)).mode & 0o777, 0o600);
    await s.close();
    // Started again on the same file: not imported again, nothing taken back.
    logs.length = 0;
    s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.doesNotMatch(logs.join('\n'), /imported|took back/);
    await s.close();
    // The file changed since (the code before ran on it, as after a rollback without an export): a
    // name it holds and the store does not is taken back, nothing is imported again.
    const j = oldJson(k); j.names.carol = { pubkey: 'ef'.repeat(32), at: 1 }; fs.writeFileSync(file, JSON.stringify(j));
    logs.length = 0;
    s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.doesNotMatch(logs.join('\n'), /imported/);
    assert.match(logs.join('\n'), /took back .*: 1 names made, 0 released or moved away/);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${'ef'.repeat(32)}`)).body.name, 'carol');
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${'ab'.repeat(32)}`)).body.name, 'bob');
  } finally { await s.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Signed requests to a name service at `base`, for the key of `phrase`.
const KEYS = {
  a: nameKey(PHRASE),
  b: nameKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'),
  c: nameKey('legal winner thank year wave sausage worth useful legal winner thank yellow'),
  d: nameKey('letter advice cage absurd amount doctor acoustic avoid letter advice cage above'),
  x: nameKey('scheme spot photo card baby mountain device kick cradle pact join borrow'),
};
const at = (base) => ({
  reg: (k, name) => { const t = ts(); return post(`${base}/lnaddr/-/register`, { name, pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, name, k.pub, t)) }).then((r) => r.status); },
  rel: (k, name) => { const t = ts(); return post(`${base}/lnaddr/-/release`, { name, ts: t, sig: signWith(k.priv, signedDigest('release', DOMAIN, name, t)) }).then((r) => r.status); },
  stock: (k, name, address) => { const c = signCode(k.priv, DOMAIN, name, buildPayCode({ address })), t = ts(); return post(`${base}/lnaddr/-/stock`, { name, ts: t, add: [c], drop: [], sig: signWith(k.priv, signedDigest('stock', DOMAIN, name, t, c.id, '')) }).then((r) => r.status); },
  mine: (k) => get(`${base}/lnaddr/-/mine?pubkey=${k.pub}`).then((r) => r.body),
  // What a payer gets for a name: the code and its key, or nothing.
  pay: (name) => get(`${base}/lnaddr/${name}`).then((r) => ({ status: r.status, pubkey: r.body.pubkey || null, code: r.body.code || null })),
});
// The names of a store as a rollback finds them: A holds livename; B released gonename; C moved
// from oldname to newname. Each held name has a code in stock.
async function threeNames (base) {
  const s = at(base);
  assert.equal(await s.reg(KEYS.a, 'livename'), 200); assert.equal(await s.stock(KEYS.a, 'livename', ADDRESSES[0]), 200);
  assert.equal(await s.reg(KEYS.b, 'gonename'), 200); assert.equal(await s.rel(KEYS.b, 'gonename'), 200);
  assert.equal(await s.reg(KEYS.c, 'oldname'), 200); assert.equal(await s.reg(KEYS.c, 'newname'), 200);
  assert.equal(await s.stock(KEYS.c, 'newname', ADDRESSES[1]), 200);
}

test('export: every name goes out; a released or moved-away one under a key no wallet holds', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  const s = await serve(file);
  try { await threeNames(s.base); } finally { await s.close(); }
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(exportJson(file), { live: 2, ended: 2 });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(j.names), ['livename', 'newname', 'gonename', 'oldname'], 'the names in use first');
  assert.equal(j.names.livename.pubkey, KEYS.a.pub); assert.equal(j.names.newname.pubkey, KEYS.c.pub);
  assert.equal(j.names.gonename.pubkey, GONE + KEYS.b.pub); assert.equal(j.names.oldname.pubkey, GONE + KEYS.c.pub);
  assert.equal(j.names.gonename.stock, undefined); assert.equal(j.names.gonename.last, undefined);
  assert.ok(j.declined[KEYS.b.pub], 'the removal goes out too');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The rollback (KR59): this store, its export, then the service deployed before this store on that
// file. A released or moved-away name must stay nobody else's there, and a payer must get no code
// for it.
test('rolled back to the service before this store: released and moved-away names stay nobody else\'s', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  let s = await serve(file);
  try { await threeNames(s.base); } finally { await s.close(); }
  exportJson(file);
  s = await serve(file, {}, makeLnaddrBefore);
  try {
    const old = at(s.base);
    for (const n of ['gonename', 'oldname']) {
      assert.equal(await old.reg(KEYS.x, n), 409, `${n}: another key's claim is refused`);
      const p = await old.pay(n);
      assert.equal(p.code, null, `${n}: a payer gets no code`); assert.notEqual(p.pubkey, KEYS.x.pub);
      assert.equal(await old.stock(KEYS.x, n, ADDRESSES[2]), 403, `${n}: no key can stock it`);
    }
    // Each key's own name, as before; a removed name is never answered as its key's again.
    assert.equal((await old.mine(KEYS.a)).name, 'livename');
    assert.equal((await old.mine(KEYS.c)).name, 'newname');
    assert.equal((await old.mine(KEYS.b)).name, null);
    const p = await old.pay('livename');
    assert.equal(p.pubkey, KEYS.a.pub); assert.ok(p.code, 'a held name is paid from its stock as before');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('back from the rollback: what the service before this store did is taken back', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  let s = await serve(file);
  try { await threeNames(s.base); } finally { await s.close(); }
  exportJson(file);
  // While rolled back: D takes a new name; C releases newname; A moves to livename2.
  s = await serve(file, {}, makeLnaddrBefore);
  try {
    const old = at(s.base);
    assert.equal(await old.reg(KEYS.d, 'rollbackname'), 200);
    assert.equal(await old.rel(KEYS.c, 'newname'), 200);
    assert.equal(await old.reg(KEYS.a, 'livename2'), 200);
  } finally { await s.close(); }
  const logs = [];
  s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
  try {
    const now = at(s.base);
    assert.match(logs.join('\n'), /took back .*: 2 names made, 2 released or moved away/);
    assert.equal((await now.mine(KEYS.d)).name, 'rollbackname');
    assert.equal(await now.reg(KEYS.x, 'rollbackname'), 409, 'a name made while rolled back is its key\'s');
    for (const n of ['newname', 'livename', 'gonename', 'oldname']) {
      assert.equal((await now.pay(n)).status, 404, `${n}: ended`);
      assert.equal(await now.reg(KEYS.x, n), 409, `${n}: nobody else's`);
    }
    assert.deepEqual([(await now.mine(KEYS.c)).name, (await now.mine(KEYS.c)).declined], [null, true], 'C released its name: marked as declined');
    assert.deepEqual([(await now.mine(KEYS.a)).name, (await now.mine(KEYS.a)).declined], ['livename2', false], 'A moved: not declined');
    assert.equal((await now.mine(KEYS.b)).declined, true);
    // Opened again with the file unchanged: nothing more is taken back.
    await s.close(); logs.length = 0;
    s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.doesNotMatch(logs.join('\n'), /took back/);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rolled back without an export: names the service before made are added, none ended', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  fs.writeFileSync(file, JSON.stringify({ names: {} }));
  let s = await serve(file);
  try { assert.equal(await at(s.base).reg(KEYS.a, 'madehere'), 200); } finally { await s.close(); }
  // The service before ran on the file as imported (it knows nothing of madehere) and made a name.
  s = await serve(file, {}, makeLnaddrBefore);
  try { assert.equal(await at(s.base).reg(KEYS.d, 'madethere'), 200); } finally { await s.close(); }
  s = await serve(file);
  try {
    const now = at(s.base);
    assert.equal((await now.mine(KEYS.d)).name, 'madethere');
    assert.equal((await now.mine(KEYS.a)).name, 'madehere', 'a name the file never held is not ended');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Several processes on one store (KR59): each waits for another's write instead of failing.
test('several processes open and write one store at once: each waits, none fails', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  const script = path.join(dir, 'writer.mjs');
  fs.writeFileSync(script, `
    import { openNameStore } from ${JSON.stringify(new URL('./lnaddr-store.mjs', import.meta.url).href)};
    const [file, who, hold] = process.argv.slice(2);
    const st = openNameStore({ storePath: file });
    if (hold) { st.put('holder', { pubkey: 'ff'.repeat(32), at: 1, seen: 1 }); }
    for (let i = 0; i < 100; i++) st.put(who + i, { pubkey: who.padEnd(64, '0'), at: i, seen: i });
    st.close();
  `);
  const run = (...a) => new Promise((ok) => {
    const p = spawn(process.execPath, [...process.execArgv.filter((x) => x.startsWith('--experimental-sqlite')), script, file, ...a], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => ok({ code, err: err.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n').trim() }));
  });
  try {
    const out = await Promise.all(['aa', 'bb', 'cc', 'dd'].map((w) => run(w)));
    for (const o of out) assert.deepEqual(o, { code: 0, err: '' });
    // One process holds the write lock for a second while two others open and write.
    const lib = createRequire(import.meta.url)('node:sqlite');
    const db = new lib.DatabaseSync(sqlitePathOf(file));
    db.exec('BEGIN IMMEDIATE');
    const waiting = Promise.all(['ee', 'ff'].map((w) => run(w)));
    await new Promise((ok) => setTimeout(ok, 1000));
    db.exec('COMMIT'); db.close();
    for (const o of await waiting) assert.deepEqual(o, { code: 0, err: '' });
    assert.equal(Object.keys(readStoreNames(file)).length, 600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one record written per change; a lookup or an empty stock message writes nothing', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json'), k = nameKey(PHRASE);
  const s = await serve(file);
  let puts = 0;
  const put = s.svc.store.put; s.svc.store.put = (...a) => { puts++; return put(...a); };
  try {
    let t = ts();
    await post(`${s.base}/lnaddr/-/register`, { name: 'erin', pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, 'erin', k.pub, t)) });
    assert.equal(puts, 1, 'a new name: one record');
    const stock = (add, drop = []) => { const t2 = ts(); return { name: 'erin', ts: t2, add, drop, sig: signWith(k.priv, signedDigest('stock', DOMAIN, 'erin', t2, add.map((c) => c.id).join(','), drop.join(','))) }; };
    puts = 0;
    for (let i = 0; i < 5; i++) assert.equal((await post(`${s.base}/lnaddr/-/stock`, stock([]))).status, 200);
    assert.equal(puts, 0, 'an empty stock message changes nothing');
    const c = signCode(k.priv, DOMAIN, 'erin', buildPayCode({ address: ADDRESS }));
    await post(`${s.base}/lnaddr/-/stock`, stock([c]));
    assert.equal(puts, 1, 'a code added: one write');
    puts = 0;
    assert.equal((await get(`${s.base}/lnaddr/erin`)).body.fresh, true);
    assert.equal(puts, 1, 'a code handed out: one write');
    puts = 0;
    for (let i = 0; i < 3; i++) assert.equal((await get(`${s.base}/lnaddr/erin`)).body.reused, true);
    assert.equal((await get(`${s.base}/lnaddr/nobody`)).status, 404);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${k.pub}`)).body.name, 'erin');
    assert.equal(puts, 0, 'lookups that change nothing write nothing');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a name idle for months loses its stock, never the name', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json'), k = nameKey(PHRASE);
  let clock = Date.now();
  const s = await serve(file, { now: () => clock, pruneEveryMs: 0 });
  try {
    let t = Math.floor(clock / 1000);
    await post(`${s.base}/lnaddr/-/register`, { name: 'fred', pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, 'fred', k.pub, t)) });
    const [c0, c1, c2] = ADDRESSES.map((address) => signCode(k.priv, DOMAIN, 'fred', buildPayCode({ address })));
    const add = [c0, c1];
    t = Math.floor(clock / 1000);
    const r = await post(`${s.base}/lnaddr/-/stock`, { name: 'fred', ts: t, add, drop: [], sig: signWith(k.priv, signedDigest('stock', DOMAIN, 'fred', t, add.map((c) => c.id).join(','), '')) });
    assert.equal(r.body.held.length, add.length);
    assert.equal((await get(`${s.base}/lnaddr/fred`)).body.fresh, true);
    // 89 days on: kept.
    clock += 89 * 86400_000; s.svc.__test__.pruneAll();
    assert.equal(s.svc.store.get('fred').stock.length, add.length - 1);
    // 91 days on: the stock goes, the name and its last code stay.
    clock += 2 * 86400_000; s.svc.__test__.pruneAll();
    const rec = s.svc.store.get('fred');
    assert.equal(rec.stock, undefined); assert.equal(rec.served, undefined); assert.equal(rec.pubkey, k.pub);
    const again = await get(`${s.base}/lnaddr/fred`);
    assert.equal(again.status, 200); assert.equal(again.body.reused, true, 'a payer gets its most recent code again, at its own key');
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${k.pub}`)).body.name, 'fred');
    // Its wallet speaks again: seen moves, and the stock it leaves is kept.
    t = Math.floor(clock / 1000);
    await post(`${s.base}/lnaddr/-/stock`, { name: 'fred', ts: t, add: [c2], drop: [], sig: signWith(k.priv, signedDigest('stock', DOMAIN, 'fred', t, c2.id, '')) });
    s.svc.__test__.pruneAll();
    assert.deepEqual(s.svc.store.get('fred').stock.map((c) => c.id), [c2.id]);
    assert.equal(s.svc.store.get('fred').seen, t);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without node:sqlite: names and removals are kept in the JSON file, written when they change', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  const logs = [];
  let st = openNameStore({ storePath: file, sqlite: null, flushMs: 20, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(st.kind, 'json'); assert.match(logs.join(''), /node:sqlite is not available/);
  st.put('gina', { pubkey: 'aa'.repeat(32), at: 1, seen: 1 }); st.decline('bb'.repeat(32), 2);
  st.close();
  st = openNameStore({ storePath: file, sqlite: null, flushMs: 20 });
  assert.equal(st.nameOf('aa'.repeat(32)), 'gina'); assert.equal(st.declined('bb'.repeat(32)), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).names.gina.at, 1, 'the format the code before reads');
  st.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lookup of a name nobody holds costs the network what a lookup that finds one does, on both routes', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json'), k = nameKey(PHRASE);
  const s = await serve(file, { netBurst: 3, netEveryMs: 60_000 });
  try {
    const t = ts();
    await post(`${s.base}/lnaddr/-/register`, { name: 'hana', pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, 'hana', k.pub, t)) });
    assert.equal((await get(`${s.base}/.well-known/lnurlp/nobody1`)).status, 404);
    assert.equal((await get(`${s.base}/lnaddr/nobody2`)).status, 404);
    assert.equal((await get(`${s.base}/.well-known/lnurlp/hana`)).status, 200);
    // The network's limit is spent, whichever of them found a name.
    assert.equal((await get(`${s.base}/.well-known/lnurlp/nobody3`)).status, 429);
    assert.equal((await get(`${s.base}/.well-known/lnurlp/hana`)).status, 429);
    assert.equal((await get(`${s.base}/lnaddr/hana`)).status, 429);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// testdata/lnaddr-names-before.json was written by the name service as deployed before this store
// (web aee65e85): alicename with a stock, one code handed out (`last`, `served`); bobname, its key's
// second name (the first, oldbob, moved away from); gonename registered and then released.
test('the store as the deployed service wrote it: imported whole, and the file left for the way back', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  fs.copyFileSync(new URL('./testdata/lnaddr-names-before.json', import.meta.url), file);
  const bytes = fs.readFileSync(file);
  const before = JSON.parse(bytes).names;
  const a = nameKey(PHRASE), b = nameKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), other = nameKey('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const s = await serve(file);
  try {
    assert.deepEqual(Object.keys(readStoreNames(file)).sort(), Object.keys(before).sort());
    for (const [n, v] of Object.entries(before)) assert.deepEqual({ ...readStoreNames(file)[n], seen: undefined }, { ...v, seen: undefined }, n);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${a.pub}`)).body.name, 'alicename');
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${b.pub}`)).body.name, 'bobname');
    // The stock left, then the code handed out last, again.
    const first = await get(`${s.base}/lnaddr/alicename`);
    assert.equal(first.body.fresh, true); assert.equal(first.body.id, before.alicename.stock[0].id);
    const again = await get(`${s.base}/lnaddr/alicename`);
    assert.equal(again.body.reused, true);
    // Known exception (web #813): names released or moved away from before this store left no
    // record, so nothing marks them and another key may take them, as before.
    for (const n of ['oldbob', 'gonename']) {
      const t2 = ts();
      assert.equal((await post(`${s.base}/lnaddr/-/register`, { name: n, pubkey: other.pub, ts: t2, sig: signWith(other.priv, signedDigest('register', DOMAIN, n, other.pub, t2)) })).status, 200, n);
    }
    assert.deepEqual(fs.readFileSync(file), bytes, 'the JSON file is untouched');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// RV80 F3: never fewer names than the store holds.
test('names in SQLite and a Node without node:sqlite: the store refuses to open on the older JSON', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  fs.writeFileSync(file, JSON.stringify({ names: {} }));
  const s = await serve(file);
  try { assert.equal(await at(s.base).reg(KEYS.a, 'madehere'), 200); } finally { await s.close(); }
  assert.throws(() => openNameStore({ storePath: file, sqlite: null }), /the names are in .*lnaddr-names\.sqlite, and this Node cannot load node:sqlite .*refusing to serve the older lnaddr-names\.json/);
  // Where no SQLite store exists yet, the JSON file still serves (a Node before node:sqlite).
  const other = path.join(dir, 'other.json');
  assert.equal(openNameStore({ storePath: other, sqlite: null }).kind, 'json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a names file that cannot be read: the service answers 503 and imports nothing, then imports it once it reads', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  fs.writeFileSync(file, '{"names": {"alice": {"pubkey": "' + KEYS.a.pub + '", "at": 1}');   // cut short
  const logs = [];
  let s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
  try {
    assert.match(logs.join('\n'), /REFUSING to serve payment names: the names file .* cannot be read/);
    assert.match(s.svc.broken(), /cannot be read/);
    for (const u of ['/lnaddr/alice', '/lnaddr/-/mine?pubkey=' + KEYS.a.pub, '/.well-known/lnurlp/alice']) assert.equal((await get(s.base + u)).status, 503, u);
    assert.equal(await at(s.base).reg(KEYS.x, 'alice'), 503, 'nobody registers while the names are unknown');
    await s.close();
    // The same file with no SQLite store beside it (a Node without node:sqlite): refused too.
    const alone = path.join(dir, 'alone.json'); fs.copyFileSync(file, alone);
    assert.throws(() => openNameStore({ storePath: alone, sqlite: null }), /the names file .*alone\.json cannot be read/);
    fs.writeFileSync(file, JSON.stringify({ names: { alice: { pubkey: KEYS.a.pub, at: 1 } } }));
    s = await serve(file);
    assert.equal((await at(s.base).mine(KEYS.a)).name, 'alice', 'imported once the file reads');
    assert.equal(await at(s.base).reg(KEYS.x, 'alice'), 409);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a names file changed since and cut short: refused, never skipped', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  fs.writeFileSync(file, JSON.stringify({ names: {} }));
  let s = await serve(file);
  try { assert.equal(await at(s.base).reg(KEYS.a, 'madehere'), 200); } finally { await s.close(); }
  fs.writeFileSync(file, '{"names": {');
  s = await serve(file);
  try { assert.equal((await get(`${s.base}/lnaddr/madehere`)).status, 503); } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// RV80 F5: the idle stock dropped in batches, the service answering between them.
test('idle stock: dropped a batch at a time, the service answering between batches', SQLITE, async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  const st = openNameStore({ storePath: file });
  const code = signCode(KEYS.a.priv, DOMAIN, 'n0', buildPayCode({ address: ADDRESS }));
  for (let i = 0; i < 1_200; i++) st.put('n' + i, { pubkey: i.toString(16).padStart(64, '0'), at: 1, seen: 1, stock: [{ ...code, until: null }], served: ['x'] });
  assert.equal(st.dropIdleStock(1_000, 500), 500, 'one batch');
  st.close();
  const logs = [];
  const s = await serve(file, { pruneBatch: 300, pruneGapMs: 20, pruneEveryMs: 0, log: (...a) => logs.push(a.join(' ')) });
  try {
    // Between batches a lookup is answered.
    await new Promise((ok) => setTimeout(ok, 30));
    const mid = readStoreNames(file), left = Object.values(mid).filter((r) => r.stock).length;
    assert.ok(left > 0 && left < 700, `pruning under way: ${left} names still stocked`);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${(5).toString(16).padStart(64, '0')}`)).body.name, 'n5');
    const t0 = Date.now();
    while (Object.values(readStoreNames(file)).some((r) => r.stock) && Date.now() - t0 < 5_000) await new Promise((ok) => setTimeout(ok, 20));
    const after = readStoreNames(file);
    assert.equal(Object.values(after).filter((r) => r.stock || r.served).length, 0);
    assert.equal(Object.keys(after).length, 1_200, 'every name kept');
    assert.match(logs.join('\n'), /dropped the stock of 700 names idle for 90 days/);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// RV80 F6: the cap counts names in use; released names are kept outside it.
test('the cap on names counts the names in use, not the released ones', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json');
  const s = await serve(file, { maxNames: 2 });
  try {
    const n = at(s.base);
    assert.equal(await n.reg(KEYS.a, 'first'), 200); assert.equal(await n.rel(KEYS.a, 'first'), 200);
    assert.equal(await n.reg(KEYS.b, 'second'), 200);
    assert.equal(await n.reg(KEYS.c, 'third'), 200, 'the released name takes no place');
    assert.equal(await n.reg(KEYS.d, 'fourth'), 503, 'two names in use: full');
    assert.equal(await n.reg(KEYS.x, 'first'), 409, 'and the released name is still nobody else\'s');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
