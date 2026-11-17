// lnaddr-store.mjs and the name service on it: the JSON file of before imported once and kept, the
// export a rollback uses, one record written per change and none per read, the stock of an idle
// name dropped (never the name), the store without node:sqlite, and a lookup that misses costing
// the same as one that finds a name. Under node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeLnaddr } from './lnaddr.mjs';
import { openNameStore, readStoreNames, exportJson, sqlitePathOf } from './lnaddr-store.mjs';
import { nameKey, signedDigest, signWith, signCode } from '../../lnaddr.js';
import { buildPayCode } from '../../pay-code.js';

const DOMAIN = 'sequentiatestnet.com';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lnaddr-store-'));

async function serve (storePath, cfg = {}) {
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = makeLnaddr({ domain: DOMAIN, base, storePath, waitMs: 500, holdMs: 300, onlineMs: 1000, ...cfg });
  server.on('request', async (req, res) => { if (await svc.handle(req, res, new URL(req.url, 'http://x'))) return; res.writeHead(401); res.end('{}'); });
  return { svc, base, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }).finally(() => svc.close()) };
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

test('the JSON file of before: imported once on the first start, and left as it was', async () => {
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
    // A name added to the JSON file afterwards is not imported again: the store is the SQLite one.
    const j = oldJson(k); j.names.carol = { pubkey: 'ef'.repeat(32), at: 1 }; fs.writeFileSync(file, JSON.stringify(j));
    logs.length = 0;
    s = await serve(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.doesNotMatch(logs.join('\n'), /imported/);
    assert.equal((await get(`${s.base}/lnaddr/carol`)).status, 404);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${'ab'.repeat(32)}`)).body.name, 'bob');
  } finally { await s.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export: the JSON file the code before reads, written from the store, for a rollback', async () => {
  const dir = tmp(), file = path.join(dir, 'lnaddr-names.json'), k = nameKey(PHRASE);
  const s = await serve(file);
  try {
    const t = ts();
    const regB = (name) => ({ name, pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, name, k.pub, t)) });
    assert.equal((await post(`${s.base}/lnaddr/-/register`, regB('olddora'))).status, 200);
    // Moved to another name: the first is kept as released, which the code before cannot read.
    assert.equal((await post(`${s.base}/lnaddr/-/register`, regB('dora'))).status, 200);
  } finally { await s.close(); }
  assert.equal(fs.existsSync(file), false);
  assert.equal(exportJson(file), 1);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.names.dora.pubkey, k.pub);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(j.names.olddora, undefined, 'a released name is left out of the export');
  assert.deepEqual(Object.keys(readStoreNames(file)).sort(), ['dora', 'olddora']);
  fs.rmSync(dir, { recursive: true, force: true });
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
    clock += 89 * 86400_000; s.svc.__test__.pruneIdle();
    assert.equal(s.svc.store.get('fred').stock.length, add.length - 1);
    // 91 days on: the stock goes, the name and its last code stay.
    clock += 2 * 86400_000; s.svc.__test__.pruneIdle();
    const rec = s.svc.store.get('fred');
    assert.equal(rec.stock, undefined); assert.equal(rec.served, undefined); assert.equal(rec.pubkey, k.pub);
    const again = await get(`${s.base}/lnaddr/fred`);
    assert.equal(again.status, 200); assert.equal(again.body.reused, true, 'a payer gets its most recent code again, at its own key');
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${k.pub}`)).body.name, 'fred');
    // Its wallet speaks again: seen moves, and the stock it leaves is kept.
    t = Math.floor(clock / 1000);
    await post(`${s.base}/lnaddr/-/stock`, { name: 'fred', ts: t, add: [c2], drop: [], sig: signWith(k.priv, signedDigest('stock', DOMAIN, 'fred', t, c2.id, '')) });
    s.svc.__test__.pruneIdle();
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
test('the store as the deployed service wrote it: imported whole, and the file left for the way back', async () => {
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
    // Names released or moved away from before this store left no record: nothing marks them, so
    // they stay free, as they were (another key may take them).
    for (const n of ['oldbob', 'gonename']) {
      const t2 = ts();
      assert.equal((await post(`${s.base}/lnaddr/-/register`, { name: n, pubkey: other.pub, ts: t2, sig: signWith(other.priv, signedDigest('register', DOMAIN, n, other.pub, t2)) })).status, 200, n);
    }
    assert.deepEqual(fs.readFileSync(file), bytes, 'the JSON file is untouched');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
