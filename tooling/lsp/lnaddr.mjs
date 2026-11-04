// Payment names (`name@<domain>`): the service side of ../../lnaddr.js.
//
// A wallet registers a name with its name key; a Lightning wallet pays the name over LNURL-pay
// (LUD-06, LUD-16) and the service asks the recipient's open wallet for an invoice of the amount
// the payer chose; a Sequentia wallet asks for the name's receive code. The service holds no key
// and makes no invoice: everything it hands a payer is signed by the name's key, and it checks
// each signature before it does.
//
//   GET  /.well-known/lnurlp/<name>        the payRequest (LUD-06), no token
//   GET  /lnaddr/-/pay/<name>?amount=<msat> its callback: { pr, routes: [] }
//   GET  /lnaddr/<name>                    { code, fresh }: the wallet's own new receive code when
//                                          it is open, else the last one it gave without its
//                                          single-use Sequentia part (`fresh: false`)
//   GET  /lnaddr/-/mine?pubkey=<hex>       the name a key holds
//   POST /lnaddr/-/register                { name, pubkey, ts, sig }
//   POST /lnaddr/-/release                 { name, ts, sig }
//   POST /lnaddr/-/wait                    { name, ts, min_sat, max_sat, sig }: held until a payer
//                                          asks something or `holdMs` passes -> { requests }
//   POST /lnaddr/-/answer                  { name, id, pr | code | refused, sig }
//
// A name is 3 to 32 of a-z 0-9 - _ (`-` alone never is one, so `/lnaddr/-/…` never names a name).
// One name per key: registering another releases the first. The names are kept in one JSON file
// (`storePath`), written whole and renamed into place; who is online is kept in memory only.
//
// `makeLnaddr(cfg).handle(req, res, url)` answers a request it owns and returns true, or returns
// false and leaves it alone; lsp-server.mjs calls it before its token check.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nameProblem, signedDigest, verifySig, lnurlMetadata, SKEW_S } from '../../lnaddr.js';
import { decodeBolt11 } from '../../bolt11.js';
import { readPayCode, buildPayCode } from '../../pay-code.js';

export const OFFLINE = "The recipient's wallet is offline. Try again when it is open.";

export function makeLnaddr ({ domain, base, storePath, now = () => Date.now(), waitMs = 10_000, holdMs = 25_000,
  onlineMs = 60_000, minSat = 1, maxSat = null, maxNames = 100_000, maxPending = 20, log = () => {} } = {}) {
  if (!domain || !base) throw new Error('lnaddr needs a domain and a base URL');
  const names = new Map();          // name -> { pubkey, at, code?, code_at? }
  const online = new Map();         // name -> { seen, min_sat, max_sat }
  const waiters = new Map();        // name -> Set of (requests) => void
  const pending = new Map();        // name -> Map id -> { id, kind, msat?, at, done }

  if (storePath) {
    try {
      const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      for (const [n, v] of Object.entries((j && j.names) || {})) if (!nameProblem(n) && v && typeof v.pubkey === 'string') names.set(n, v);
    } catch (e) { if (e.code !== 'ENOENT') log('[lnaddr] store unreadable, starting empty:', e.message); }
  }
  function save () {
    if (!storePath) return;
    const tmp = `${storePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ names: Object.fromEntries(names) }), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  }
  const nameOf = (pubkey) => { for (const [n, v] of names) if (v.pubkey === pubkey) return n; return null; };
  const freshTs = (ts) => Number.isSafeInteger(Number(ts)) && Math.abs(Number(ts) - now() / 1000) <= SKEW_S;
  const isOnline = (n) => { const o = online.get(n); return !!o && (now() - o.seen <= onlineMs || (waiters.get(n)?.size || 0) > 0); };
  const satBounds = (n) => {
    const o = online.get(n) || {};
    let lo = BigInt(Math.max(1, Number(minSat) || 1)), hi = maxSat != null ? BigInt(maxSat) : null;
    try { if (o.min_sat != null && BigInt(o.min_sat) > lo) lo = BigInt(o.min_sat); } catch {}
    try { if (o.max_sat != null && (hi == null || BigInt(o.max_sat) < hi)) hi = BigInt(o.max_sat); } catch {}
    return { lo, hi: hi == null ? lo : hi };
  };

  // Ask the open wallet behind `n` something; resolves with its answer or null after `waitMs`.
  function ask (n, req) {
    const q = pending.get(n) || new Map(); pending.set(n, q);
    if (q.size >= maxPending) return Promise.resolve({ busy: true });
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const entry = { id, ...req, at: now(), resolve };
      q.set(id, entry);
      entry.timer = setTimeout(() => { q.delete(id); resolve(null); }, waitMs);
      for (const w of waiters.get(n) || []) w();
    });
  }
  // The requests not handed to the wallet yet, each handed once: a wallet that asks again while it
  // makes an invoice is held, not answered the same request at once.
  const undelivered = (n) => [...(pending.get(n)?.values() || [])].filter((e) => !e.delivered);
  const deliver = (list) => list.map((e) => { e.delivered = true; return e.kind === 'invoice' ? { id: e.id, kind: e.kind, msat: String(e.msat) } : { id: e.id, kind: e.kind }; });

  function send (res, code, obj, { cors = false } = {}) {
    const body = JSON.stringify(obj);
    const h = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' };
    if (cors) h['access-control-allow-origin'] = '*';
    res.writeHead(code, h); res.end(body);
  }
  const lnErr = (res, code, reason) => send(res, code, { status: 'ERROR', reason }, { cors: true });
  const fail = (res, code, error, extra = {}) => send(res, code, { ok: false, error, ...extra });
  function readBody (req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 16 << 10) { req.destroy(); resolve(null); } });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  // A code as served when the wallet is not there to make a new one: its single-use Sequentia part
  // left out, the address and the Ark part kept (both take any number of payments).
  function lasting (code) {
    let c = null; try { c = readPayCode(code); } catch {}
    if (!c || !c.address) return null;
    return buildPayCode({ address: c.address, ark: c.ark || undefined });
  }

  const routes = {
    async payRequest (res, n) {
      if (nameProblem(n) || !names.has(n)) return lnErr(res, 404, 'No wallet goes by that name here.');
      if (!isOnline(n)) return lnErr(res, 200, OFFLINE);
      const { lo, hi } = satBounds(n);
      if (hi < lo) return lnErr(res, 200, "The recipient's wallet can't take a payment over Lightning right now.");
      return send(res, 200, { tag: 'payRequest', callback: `${base}/lnaddr/-/pay/${n}`,
        minSendable: Number(lo * 1000n), maxSendable: Number(hi * 1000n), metadata: lnurlMetadata(n, domain) }, { cors: true });
    },
    async callback (res, n, url) {
      if (nameProblem(n) || !names.has(n)) return lnErr(res, 404, 'No wallet goes by that name here.');
      const a = url.searchParams.get('amount');
      if (!/^[1-9][0-9]{0,17}$/.test(a || '')) return lnErr(res, 400, 'The amount is missing or not a number of millisatoshis.');
      const msat = BigInt(a);
      if (!isOnline(n)) return lnErr(res, 200, OFFLINE);
      if (msat % 1000n !== 0n) return lnErr(res, 200, 'This wallet takes whole satoshis only.');
      const { lo, hi } = satBounds(n);
      if (msat < lo * 1000n || msat > hi * 1000n) return lnErr(res, 200, `This wallet takes between ${lo} and ${hi} sats.`);
      const ans = await ask(n, { kind: 'invoice', msat });
      if (!ans) return lnErr(res, 200, OFFLINE);
      if (ans.busy) return lnErr(res, 200, "The recipient's wallet is busy. Try again in a minute.");
      if (ans.refused) return lnErr(res, 200, "The recipient's wallet can't take this payment right now.");
      return send(res, 200, { pr: ans.pr, routes: [] }, { cors: true });
    },
    async code (res, n) {
      if (nameProblem(n) || !names.has(n)) return send(res, 404, { status: 'ERROR', reason: 'No wallet goes by that name.' }, { cors: true });
      const rec = names.get(n);
      if (isOnline(n)) {
        const ans = await ask(n, { kind: 'code' });
        if (ans && ans.code) return send(res, 200, { ok: true, name: n, address: `${n}@${domain}`, code: ans.code, fresh: true }, { cors: true });
      }
      if (rec.code) return send(res, 200, { ok: true, name: n, address: `${n}@${domain}`, code: rec.code, fresh: false }, { cors: true });
      return send(res, 200, { status: 'ERROR', reason: OFFLINE }, { cors: true });
    },
    async mine (res, url) {
      const pk = String(url.searchParams.get('pubkey') || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pk)) return fail(res, 400, 'pubkey is 32 bytes of hex');
      return send(res, 200, { ok: true, name: nameOf(pk) });
    },
    async register (res, b) {
      const n = b && b.name, pk = String((b && b.pubkey) || '').toLowerCase();
      const p = nameProblem(n); if (p) return fail(res, 400, p, { code: 'invalid' });
      if (!/^[0-9a-f]{64}$/.test(pk)) return fail(res, 400, 'pubkey is 32 bytes of hex');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!verifySig(pk, signedDigest('register', domain, n, pk, b.ts), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      const had = names.get(n);
      if (had && had.pubkey !== pk) return fail(res, 409, 'That name is taken. Choose another.', { code: 'taken' });
      if (!had && names.size >= maxNames) return fail(res, 503, 'No more names can be registered here now.', { code: 'full' });
      const old = nameOf(pk);
      if (old && old !== n) { names.delete(old); online.delete(old); }
      names.set(n, had || { pubkey: pk, at: Math.floor(now() / 1000) });
      save();
      return send(res, 200, { ok: true, name: n, address: `${n}@${domain}` });
    },
    async release (res, b) {
      const n = b && b.name, rec = !nameProblem(n) && names.get(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!verifySig(rec.pubkey, signedDigest('release', domain, n, b.ts), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      names.delete(n); online.delete(n); save();
      return send(res, 200, { ok: true });
    },
    async wait (req, res, b) {
      const n = b && b.name, rec = !nameProblem(n) && names.get(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!/^[0-9]{1,16}$/.test(String(b.min_sat)) || !/^[0-9]{1,16}$/.test(String(b.max_sat))) return fail(res, 400, 'min_sat and max_sat are whole numbers');
      if (!verifySig(rec.pubkey, signedDigest('wait', domain, n, b.ts, b.min_sat, b.max_sat), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      online.set(n, { seen: now(), min_sat: String(b.min_sat), max_sat: String(b.max_sat) });
      if (undelivered(n).length) return send(res, 200, { ok: true, requests: deliver(undelivered(n)) });
      const set = waiters.get(n) || new Set(); waiters.set(n, set);
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); set.delete(finish); resolve(); };
        const t = setTimeout(finish, holdMs);
        set.add(finish);
        // The response's close, not the request's: Node closes a request once its body is read.
        res.on('close', finish);
      });
      online.set(n, { ...(online.get(n) || {}), seen: now() });
      if (res.writableEnded || res.destroyed) return;
      return send(res, 200, { ok: true, requests: deliver(undelivered(n)) });
    },
    async answer (res, b) {
      const n = b && b.name, rec = !nameProblem(n) && names.get(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      const q = pending.get(n), entry = q && q.get(String(b.id || ''));
      if (!entry) return fail(res, 410, 'That request has ended.');
      let out;
      if (b.refused) {
        if (!verifySig(rec.pubkey, signedDigest('refuse', domain, n, entry.id), b.sig)) return fail(res, 403, 'The signature does not verify.');
        out = { refused: true };
      } else if (entry.kind === 'invoice') {
        const pr = String(b.pr || '');
        if (!verifySig(rec.pubkey, signedDigest('invoice', domain, n, entry.id, pr), b.sig)) return fail(res, 403, 'The signature does not verify.');
        // The wallet's own answer, but not one a payer can pay as asked: the payer is told at once.
        const d = decodeBolt11(pr);
        const why = !d.ok || d.chain !== 'btc' ? 'not a Bitcoin invoice'
          : d.amountMsat == null || BigInt(d.amountMsat) !== entry.msat ? 'the invoice is not for the amount asked' : null;
        if (why) { clearTimeout(entry.timer); q.delete(entry.id); entry.resolve({ refused: true }); return fail(res, 400, why); }
        out = { pr };
      } else {
        const code = String(b.code || '');
        if (!verifySig(rec.pubkey, signedDigest('code', domain, n, entry.id, code), b.sig)) return fail(res, 403, 'The signature does not verify.');
        const keepAs = lasting(code);
        if (!keepAs) return fail(res, 400, 'not a receive code');
        if (rec.code !== keepAs) { rec.code = keepAs; rec.code_at = Math.floor(now() / 1000); save(); }
        out = { code };
      }
      clearTimeout(entry.timer); q.delete(entry.id); entry.resolve(out);
      return send(res, 200, { ok: true });
    },
  };

  async function handle (req, res, url) {
    const p = url.pathname;
    let m;
    if (req.method === 'OPTIONS' && (p.startsWith('/.well-known/lnurlp/') || p.startsWith('/lnaddr/'))) {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'accept' });
      res.end(); return true;
    }
    if (req.method === 'GET' && (m = /^\/\.well-known\/lnurlp\/([^/]+)$/.exec(p))) { await routes.payRequest(res, decodeURIComponent(m[1]).toLowerCase()); return true; }
    if (req.method === 'GET' && (m = /^\/lnaddr\/-\/pay\/([^/]+)$/.exec(p))) { await routes.callback(res, decodeURIComponent(m[1]).toLowerCase(), url); return true; }
    if (req.method === 'GET' && p === '/lnaddr/-/mine') { await routes.mine(res, url); return true; }
    if (req.method === 'POST' && (m = /^\/lnaddr\/-\/(register|release|wait|answer)$/.exec(p))) {
      const b = await readBody(req);
      if (!b) { fail(res, 400, 'the body is not JSON'); return true; }
      if (m[1] === 'wait') await routes.wait(req, res, b); else await routes[m[1]](res, b);
      return true;
    }
    if (req.method === 'GET' && (m = /^\/lnaddr\/([^/]+)$/.exec(p)) && m[1] !== '-') { await routes.code(res, decodeURIComponent(m[1]).toLowerCase()); return true; }
    return false;
  }

  return { handle, names, isOnline, __test__: { pending } };
}
