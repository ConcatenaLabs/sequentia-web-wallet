// lnaddr.mjs over HTTP: names, signatures, the LNURL-pay answers, and one payment end to end with
// a stub wallet (lnaddr.js's mountLnAddress, its invoices made here) answering over the link.
// Under node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeLnaddr, OFFLINE } from './lnaddr.mjs';
import { nameKey, signedDigest, signWith, mountLnAddress, resolveLnAddress } from '../../lnaddr.js';
import { decodeBolt11 } from '../../bolt11.js';
import { buildPayCode, readPayCode } from '../../pay-code.js';

const DOMAIN = 'sequentiatestnet.com';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function toGroups (hex) { const out = []; let acc = 0, bits = 0; for (let i = 0; i < hex.length; i += 2) { acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function polymod (v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = (((c & 0x1ffffff) << 5) ^ x) >>> 0; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c = (c ^ G[i]) >>> 0; } return c; }
// A Bitcoin testnet invoice of `msat`, valid checksum, zero signature (as bolt11.test.mjs builds them).
function fakeInvoice (msat, prefix = 'lntb') {
  const hrp = `${prefix}${BigInt(msat) / 100n}n`;
  const g = [0, 0, 0, 0, 0, 0, 0]; const p = toGroups('33'.repeat(32));
  g.push(1, p.length >> 5, p.length & 31, ...p);
  for (let i = 0; i < 104; i++) g.push(0);
  const pre = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(pre.concat(g, [0, 0, 0, 0, 0, 0])) ^ 1;
  for (let i = 0; i < 6; i++) g.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + g.map((x) => CS[x]).join('');
}

// The service builds its callback from `base`; the tests' service is told it after listening.
async function serveAt (opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'lnaddr-'));
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = makeLnaddr({ domain: DOMAIN, base, storePath: path.join(dir, 'lnaddr-names.json'), waitMs: 1500, holdMs: 800, onlineMs: 3000, ...(opts.cfg || {}) });
  server.on('request', async (req, res) => { if (await svc.handle(req, res, new URL(req.url, 'http://x'))) return; res.writeHead(401); res.end('{"ok":false}'); });
  return { svc, base, dir, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}
const get = async (url) => { const r = await fetch(url); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.json() }; };
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const ts = () => Math.floor(Date.now() / 1000);
const reg = (k, name, t = ts()) => ({ name, pubkey: k.pub, ts: t, sig: signWith(k.priv, signedDigest('register', DOMAIN, name, k.pub, t)) });
const rel = (k, name, t = ts()) => ({ name, ts: t, sig: signWith(k.priv, signedDigest('release', DOMAIN, name, t)) });

test('names: first come first served, held and released by their key', async () => {
  const s = await serveAt();
  const a = nameKey(PHRASE), b = nameKey(OTHER);
  try {
    let r = await post(`${s.base}/lnaddr/-/register`, reg(a, 'alice'));
    assert.deepEqual(r, { status: 200, body: { ok: true, name: 'alice', address: 'alice@sequentiatestnet.com' } });
    r = await post(`${s.base}/lnaddr/-/register`, reg(b, 'alice'));
    assert.equal(r.status, 409); assert.equal(r.body.error, 'That name is taken. Choose another.');
    r = await post(`${s.base}/lnaddr/-/register`, reg(a, 'alice'));
    assert.equal(r.status, 200, 'the same key registers it again');
    // A signature by another key over the first key's request.
    const forged = { ...reg(a, 'bob'), sig: reg(b, 'bob').sig };
    r = await post(`${s.base}/lnaddr/-/register`, forged);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'signature');
    r = await post(`${s.base}/lnaddr/-/register`, reg(a, 'bob', ts() - 3600));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'clock');
    r = await post(`${s.base}/lnaddr/-/register`, { ...reg(a, 'Bob') });
    assert.equal(r.status, 400); assert.match(r.body.error, /^A name has 3 to 32 characters/);
    // The name a key holds, for a wallet restored elsewhere.
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${a.pub}`)).body.name, 'alice');
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${b.pub}`)).body.name, null);
    // One name per key: a second one moves it.
    r = await post(`${s.base}/lnaddr/-/register`, reg(a, 'alice2'));
    assert.equal(r.status, 200);
    assert.equal((await get(`${s.base}/lnaddr/-/mine?pubkey=${a.pub}`)).body.name, 'alice2');
    assert.equal((await get(`${s.base}/.well-known/lnurlp/alice`)).status, 404, 'the first is free again');
    // Release only by the holder.
    r = await post(`${s.base}/lnaddr/-/release`, rel(b, 'alice2'));
    assert.equal(r.status, 403);
    r = await post(`${s.base}/lnaddr/-/release`, rel(a, 'alice2'));
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    r = await post(`${s.base}/lnaddr/-/register`, reg(b, 'alice2'));
    assert.equal(r.status, 200, 'a released name is anyone\'s');
    // The store outlives a restart.
    await s.close();
    const s2 = await serveAt({ dir: s.dir });
    try {
      assert.equal((await get(`${s2.base}/lnaddr/-/mine?pubkey=${b.pub}`)).body.name, 'alice2');
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'lnaddr-names.json'), 'utf8')).names.alice2.pubkey, b.pub);
      assert.equal((fs.statSync(path.join(s.dir, 'lnaddr-names.json')).mode & 0o777), 0o600);
    } finally { await s2.close(); }
  } finally { await s.close().catch(() => {}); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('LNURL-pay answers for a name nobody holds, and for a wallet that is not open', async () => {
  const s = await serveAt();
  try {
    let r = await get(`${s.base}/.well-known/lnurlp/nobody`);
    assert.deepEqual(r, { status: 404, cors: '*', body: { status: 'ERROR', reason: 'No wallet goes by that name here.' } });
    await post(`${s.base}/lnaddr/-/register`, reg(nameKey(PHRASE), 'alice'));
    r = await get(`${s.base}/.well-known/lnurlp/alice`);
    assert.deepEqual(r.body, { status: 'ERROR', reason: OFFLINE });
    assert.equal(OFFLINE, "The recipient's wallet is offline. Try again when it is open.");
    r = await get(`${s.base}/lnaddr/-/pay/alice?amount=21000`);
    assert.deepEqual(r.body, { status: 'ERROR', reason: OFFLINE });
    r = await get(`${s.base}/lnaddr/alice`);
    assert.deepEqual(r.body, { status: 'ERROR', reason: OFFLINE }, 'no code was ever given');
    assert.equal((await get(`${s.base}/lnaddr/-/pay/alice?amount=abc`)).status, 400);
  } finally { await s.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('end to end: a payer pays alice@ in an amount it chooses; the open wallet makes the invoice', async () => {
  const s = await serveAt();
  const k = nameKey(PHRASE);
  const asked = [];
  let codes = 0, mode = 'good';
  const store = new Map();
  const wallet = mountLnAddress({
    base: s.base, domain: DOMAIN, key: () => k,
    invoice: async (msat) => { asked.push(msat); if (mode === 'refuse') throw new Error('the ark is closed'); if (mode === 'slow') await new Promise((ok) => setTimeout(ok, 400)); return fakeInvoice(mode === 'short' ? msat - 1000n : msat); },
    code: async () => buildPayCode({ address: ADDRESS, ark: 'tark1qexample', sequentia: `sqr1qcode${++codes}` }),
    limits: () => ({ min_sat: 1000, max_sat: 2_000_000 }),
    store: { get: (x) => store.get(x) ?? null, set: (x, v) => (v == null ? store.delete(x) : store.set(x, v)) },
    retryMs: 200,
  });
  try {
    assert.equal(await wallet.register('alice'), 'alice');
    assert.equal(wallet.address(), 'alice@sequentiatestnet.com');
    await new Promise((ok) => setTimeout(ok, 150));            // its first wait reaches the service

    // The payer's wallet: the payRequest, then the callback with the amount chosen.
    const p = await get(`${s.base}/.well-known/lnurlp/alice`);
    assert.equal(p.status, 200); assert.equal(p.cors, '*');
    assert.deepEqual(p.body, { tag: 'payRequest', callback: `${s.base}/lnaddr/-/pay/alice`, minSendable: 1_000_000, maxSendable: 2_000_000_000,
      metadata: '[["text/plain","Payment to alice@sequentiatestnet.com"],["text/identifier","alice@sequentiatestnet.com"]]' });
    const t0 = Date.now();
    const c = await get(`${p.body.callback}?amount=21000000`);
    const ms = Date.now() - t0;
    assert.equal(c.status, 200);
    assert.deepEqual(Object.keys(c.body).sort(), ['pr', 'routes']);
    assert.deepEqual(c.body.routes, []);
    const d = decodeBolt11(c.body.pr);
    assert.equal(d.chain, 'btc'); assert.equal(d.amountMsat, 21_000_000n);
    assert.deepEqual(asked, [21_000_000n]);
    console.log(`  invoice for 21,000 sats from the open wallet in ${ms} ms: ${c.body.pr.slice(0, 24)}…`);

    // Outside the wallet's limits, or not whole satoshis: refused before the wallet is asked.
    assert.match((await get(`${p.body.callback}?amount=999000`)).body.reason, /^This wallet takes between 1000 and 2000000 sats\.$/);
    assert.match((await get(`${p.body.callback}?amount=21000500`)).body.reason, /whole satoshis/);
    assert.equal(asked.length, 1);

    // A wallet whose invoice is for another amount is never handed on: the payer is told at once.
    mode = 'short';
    assert.deepEqual((await get(`${p.body.callback}?amount=5000000`)).body, { status: 'ERROR', reason: "The recipient's wallet can't take this payment right now." });
    mode = 'refuse';
    assert.deepEqual((await get(`${p.body.callback}?amount=5000000`)).body, { status: 'ERROR', reason: "The recipient's wallet can't take this payment right now." });
    mode = 'good';

    // Somebody else answering alice's request, with its live id: refused; and alice's own key over
    // an invoice for another amount: refused. The payer gets the wallet's own invoice.
    const thief = nameKey(OTHER);
    mode = 'slow';
    const pay = get(`${p.body.callback}?amount=7000000`);
    let id = null;
    for (let i = 0; i < 50 && !id; i++) { await new Promise((ok) => setTimeout(ok, 10)); id = [...(s.svc.__test__.pending.get('alice')?.keys() || [])][0] || null; }
    assert.ok(id, 'the request is pending');
    const theirs = fakeInvoice(7_000_000n, 'lntb');
    let w = await post(`${s.base}/lnaddr/-/answer`, { name: 'alice', id, pr: theirs, sig: signWith(thief.priv, signedDigest('invoice', DOMAIN, 'alice', id, theirs)) });
    assert.deepEqual(w, { status: 403, body: { ok: false, error: 'The signature does not verify.' } });
    w = await post(`${s.base}/lnaddr/-/answer`, { name: 'alice', id: 'f'.repeat(32), pr: theirs, sig: signWith(k.priv, signedDigest('invoice', DOMAIN, 'alice', 'f'.repeat(32), theirs)) });
    assert.equal(w.status, 410, 'a request that does not exist');
    const paid = await pay;
    assert.equal(decodeBolt11(paid.body.pr).amountMsat, 7_000_000n, 'the wallet\'s own invoice');
    mode = 'good';

    // alice's own key over an invoice for another amount: refused, and the payer told at once.
    mode = 'slow';
    const pay2 = get(`${p.body.callback}?amount=8000000`);
    let id2 = null;
    for (let i = 0; i < 50 && !id2; i++) { await new Promise((ok) => setTimeout(ok, 10)); id2 = [...(s.svc.__test__.pending.get('alice')?.keys() || [])][0] || null; }
    const short = fakeInvoice(6_000_000n);
    w = await post(`${s.base}/lnaddr/-/answer`, { name: 'alice', id: id2, pr: short, sig: signWith(k.priv, signedDigest('invoice', DOMAIN, 'alice', id2, short)) });
    assert.deepEqual(w, { status: 400, body: { ok: false, error: 'the invoice is not for the amount asked' } });
    assert.deepEqual((await pay2).body, { status: 'ERROR', reason: "The recipient's wallet can't take this payment right now." });
    await new Promise((ok) => setTimeout(ok, 450));             // the wallet's own late answer finds the request ended
    mode = 'good';

    // A Sequentia wallet paying alice@ gets a new receive code each time, and resolves it.
    const r1 = await resolveLnAddress({ text: 'alice@sequentiatestnet.com', asset: 'ab'.repeat(32), domain: DOMAIN, base: s.base, decode: decodeBolt11 });
    const r2 = await resolveLnAddress({ text: 'Alice@SequentiaTestnet.com', asset: 'BTC', domain: DOMAIN, base: s.base, decode: decodeBolt11 });
    assert.equal(r1.fresh, true);
    assert.equal(readPayCode(r1.code).sequentia, 'sqr1qcode1');
    assert.equal(readPayCode(r2.code).sequentia, 'sqr1qcode2');

    // The wallet closes: the payer hears it is offline, and a Sequentia wallet gets the last code
    // without its single-use part.
    wallet.stop();
    await new Promise((ok) => setTimeout(ok, 3200));
    assert.deepEqual((await get(`${s.base}/.well-known/lnurlp/alice`)).body, { status: 'ERROR', reason: OFFLINE });
    const last = await get(`${s.base}/lnaddr/alice`);
    assert.equal(last.body.fresh, false);
    assert.deepEqual(readPayCode(last.body.code), { ...readPayCode(buildPayCode({ address: ADDRESS, ark: 'tark1qexample' })) });
    assert.equal(readPayCode(last.body.code).sequentia, null);

    // Back open, it answers again; then it releases the name.
    wallet.start();
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal((await get(`${s.base}/.well-known/lnurlp/alice`)).body.tag, 'payRequest');
    await wallet.release();
    assert.equal(wallet.name(), null);
    assert.equal((await get(`${s.base}/.well-known/lnurlp/alice`)).status, 404);
  } finally { wallet.stop(); await s.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('a wallet whose answer does not come in time: the payer hears it is offline after the wait', async () => {
  const s = await serveAt({ cfg: { waitMs: 600 } });
  const k = nameKey(PHRASE);
  const wallet = mountLnAddress({ base: s.base, domain: DOMAIN, key: () => k,
    invoice: () => new Promise(() => {}), code: async () => '', limits: () => ({ min_sat: 1, max_sat: 100000 }),
    store: { get: () => null, set: () => {} }, retryMs: 200 });
  try {
    await wallet.register('slowpoke');
    await new Promise((ok) => setTimeout(ok, 150));
    const t0 = Date.now();
    const r = await get(`${s.base}/lnaddr/-/pay/slowpoke?amount=1000`);
    const ms = Date.now() - t0;
    assert.deepEqual(r.body, { status: 'ERROR', reason: OFFLINE });
    assert.ok(ms >= 550 && ms < 1500, `answered after the wait (${ms} ms)`);
  } finally { wallet.stop(); await s.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
