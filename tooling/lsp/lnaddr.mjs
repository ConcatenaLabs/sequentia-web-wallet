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
//   GET  /lnaddr/<name>                    { pubkey, code, id, sig, fresh, reused }: a receive code
//                                          of the wallet's, signed by the name's key (`pubkey`)
//   GET  /lnaddr/-/mine?pubkey=<hex>       { name, declined }: the name a key holds, and whether its
//                                          person removed it (the wallet then makes none by itself)
//   POST /lnaddr/-/register                { name, pubkey, ts, sig }
//   POST /lnaddr/-/release                 { name, ts, sig }: the name answers no lookup any more, stays
//                                          its key's, and the key is marked as declined until it
//                                          registers a name again
//   POST /lnaddr/-/decline                 { pubkey, ts, sig }: the same mark for a key with no name
//   POST /lnaddr/-/stock                   { name, ts, add: [{ id, code, sig }], drop: [id], sig }
//                                          -> { held: [id] }: the wallet's stock of signed codes
//   POST /lnaddr/-/wait                    { name, ts, min_sat, max_sat, sig }: held until a payer
//                                          asks something or `holdMs` passes -> { requests, held }
//   POST /lnaddr/-/answer                  { name, id, pr | code | refused, sig }
//
// A Sequentia payer's lookup (`GET /lnaddr/<name>`) is answered from the wallet's stock first, each
// code handed out once and never again while the stock lasts, a code whose single-use Sequentia
// part lapses within `serveMarginS` never; then, while the wallet is open, with a code it makes for
// the request; then with the most recent code handed out again (`reused: true`), which the payer
// pays without its single-use part. The service never makes a code nor changes one: each carries
// the name key's signature over the name, the domain and the code, which the payer checks.
//
// Lookups are limited per name and per network (an IPv4 /24, an IPv6 /48), so nobody drains a
// stock: past the name's limit a lookup gets the most recent code again rather than a new one, and
// past the network's it is refused for a minute. A lookup of a name nobody holds costs the network
// the same as one that finds a name, on both the Sequentia and the LNURL-pay routes, so walking
// the names is as slow as the network limit. New names are limited per network too (ten at
// once, then one every ten minutes), since every wallet registers one by itself. The client's address is the one the proxy in
// front adds last to X-Forwarded-For when the request comes from the loopback, else the socket's.
//
// A name is 3 to 32 of a-z 0-9 - _ (`-` alone never is one, so `/lnaddr/-/…` never names a name).
// One name per key: registering another releases the first. A released name is never given to
// another key: it stays its key's (which may take it back) and every lookup of it fails, so a payer
// holding it, or a page still showing it, never reaches another wallet; the open wallet's wait ends
// at once with 404. The names, their stocks and the keys
// that declined a name are kept in lnaddr-store.mjs (SQLite beside `storePath`, one row per name,
// written only when that name changes); who is online is kept in memory only. A name whose wallet
// has not been heard from for `idleStockS` loses its stock (never the name, so a payer who paid it
// before never pays a stranger at it): a payer then gets its most recent code again.
//
// `makeLnaddr(cfg).handle(req, res, url)` answers a request it owns and returns true, or returns
// false and leaves it alone; lsp-server.mjs calls it before its token check.
import crypto from 'node:crypto';
import { nameProblem, signedDigest, verifySig, verifyCode, codeId, requestUntil, lnurlMetadata, SKEW_S, NAME_WORDS } from '../../lnaddr.js';
import { decodeBolt11 } from '../../bolt11.js';
import { openNameStore } from './lnaddr-store.mjs';
import { readPayCode } from '../../pay-code.js';

export const OFFLINE = "The recipient's wallet is offline. Try again when it is open.";
export const BUSY = NAME_WORDS.busy;
export const NEW_BUSY = NAME_WORDS.newBusy;

// A token bucket per key: `burst` at once, then one every `everyMs`. -> take(key) true while allowed.
export function bucket ({ burst, everyMs, now = () => Date.now(), max = 50_000 }) {
  const m = new Map();
  return function take (k) {
    const t = now();
    let b = m.get(k);
    if (!b) { if (m.size >= max) m.delete(m.keys().next().value); b = { n: burst, at: t }; m.set(k, b); }
    b.n = Math.min(burst, b.n + (t - b.at) / everyMs); b.at = t;
    if (b.n < 1) return false;
    b.n -= 1; return true;
  };
}
// The network a request comes from: an IPv4 /24 or an IPv6 /48.
export function clientNet (req) {
  let ip = String((req.socket && req.socket.remoteAddress) || '');
  const loop = /^(127\.|::1$|::ffff:127\.)/.test(ip);
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (loop && xff) { const parts = String(xff).split(',').map((x) => x.trim()).filter(Boolean); if (parts.length) ip = parts[parts.length - 1]; }
  ip = ip.replace(/^::ffff:/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) {
    const [head] = ip.split('::'); const g = head.split(':').filter(Boolean);
    return `${[...g, '0', '0', '0'].slice(0, 3).join(':')}::/48`;
  }
  return ip || 'unknown';
}

export function makeLnaddr ({ domain, base, storePath, now = () => Date.now(), waitMs = 10_000, holdMs = 25_000,
  onlineMs = 60_000, minSat = 1, maxSat = null, maxNames = 100_000, maxPending = 20, log = () => {},
  stockMax = 20, serveMarginS = 2 * 3600, nameBurst = 5, nameEveryMs = 30_000, netBurst = 20, netEveryMs = 6_000,
  newBurst = 10, newEveryMs = 10 * 60_000, idleStockS = 90 * 86400, seenEveryS = 86400, pruneEveryMs = 6 * 3600_000 } = {}) {
  if (!domain || !base) throw new Error('lnaddr needs a domain and a base URL');
  // name -> { pubkey, at, seen, stock?: [{ id, code, sig, until }], last?, served?: [id] }; `seen`: when
  // the wallet itself last spoke (to the day, so an open wallet's link does not write every wait).
  const store = openNameStore({ storePath, log, now, nameOk: (n) => !nameProblem(n) });
  const online = new Map();         // name -> { seen, min_sat, max_sat }
  const waiters = new Map();        // name -> Set of (requests) => void
  const pending = new Map();        // name -> Map id -> { id, kind, msat?, at, done }

  const nameTake = bucket({ burst: nameBurst, everyMs: nameEveryMs, now });
  const netTake = bucket({ burst: netBurst, everyMs: netEveryMs, now });
  // New names per network: every wallet registers one by itself, so one network making wallets
  // by the thousand would fill `maxNames` for everyone else.
  const newTake = bucket({ burst: newBurst, everyMs: newEveryMs, now });
  const nowS = () => Math.floor(now() / 1000);
  // A name in use: held and not released. A released name stays its key's (a tombstone), so a payer
  // who kept it is told nobody goes by it, never sent to another wallet.
  const live = (n) => { if (nameProblem(n)) return null; const r = store.get(n); return r && !r.released ? r : null; };
  // The open wallet behind `n` hears at once when its name is released or moved: its wait ends.
  const wake = (n) => { for (const w of waiters.get(n) || []) w(); };
  function tombstone (n, rec) {
    const t = { pubkey: rec.pubkey, at: rec.at, seen: rec.seen ?? nowS(), released: nowS() };
    store.put(n, t); online.delete(n); wake(n);
  }
  // The wallet spoke: `seen` moves, at most once a day. -> whether the record changed.
  const touch = (rec) => { if (nowS() - (rec.seen ?? rec.at ?? 0) < seenEveryS) return false; rec.seen = nowS(); return true; };
  function pruneIdle () {
    try { const n = store.dropIdleStock(nowS() - idleStockS); if (n) log(`[lnaddr] dropped the stock of ${n} names idle for ${Math.round(idleStockS / 86400)} days`); }
    catch (e) { log('[lnaddr] prune:', e && e.message); }
  }
  pruneIdle();
  const pruner = pruneEveryMs ? setInterval(pruneIdle, pruneEveryMs) : null;
  pruner?.unref?.();
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
  // The codes of a name's stock that may still be handed out: a code whose Sequentia part lapses
  // within the margin is dropped.
  function liveStock (rec) {
    const t = now() / 1000;
    const before = (rec.stock || []).length;
    rec.stock = (rec.stock || []).filter((c) => c.until == null || c.until - t >= serveMarginS);
    return rec.stock.length !== before;
  }
  const codeOut = (n, rec, c, extra) => ({ ok: true, name: n, address: `${n}@${domain}`, pubkey: rec.pubkey, code: c.code, id: c.id, sig: c.sig, ...extra });
  function remember (rec, c) {
    rec.last = { id: c.id, code: c.code, sig: c.sig, until: c.until ?? null, at: Math.floor(now() / 1000) };
    rec.served = [...(rec.served || []).filter((x) => x !== c.id), c.id].slice(-200);
  }

  const routes = {
    async payRequest (req, res, n) {
      if (!netTake(clientNet(req))) return lnErr(res, 429, BUSY);
      if (!live(n)) return lnErr(res, 404, 'No wallet goes by that name here.');
      if (!isOnline(n)) return lnErr(res, 200, OFFLINE);
      const { lo, hi } = satBounds(n);
      if (hi < lo) return lnErr(res, 200, "The recipient's wallet can't take a payment over Lightning right now.");
      return send(res, 200, { tag: 'payRequest', callback: `${base}/lnaddr/-/pay/${n}`,
        minSendable: Number(lo * 1000n), maxSendable: Number(hi * 1000n), metadata: lnurlMetadata(n, domain) }, { cors: true });
    },
    async callback (req, res, n, url) {
      if (!netTake(clientNet(req))) return lnErr(res, 429, BUSY);
      if (!live(n)) return lnErr(res, 404, 'No wallet goes by that name here.');
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
    async code (req, res, n) {
      if (!netTake(clientNet(req))) return send(res, 429, { status: 'ERROR', reason: BUSY }, { cors: true });
      const rec = live(n);
      if (!rec) return send(res, 404, { status: 'ERROR', reason: 'No wallet goes by that name.' }, { cors: true });
      const again = () => { if (!rec.last) return false; send(res, 200, codeOut(n, rec, rec.last, { fresh: false, reused: true }), { cors: true }); return true; };
      // Past the name's limit: the most recent code again, never a new one.
      if (!nameTake(n)) return again() || send(res, 429, { status: 'ERROR', reason: BUSY }, { cors: true });
      const lapsed = liveStock(rec);
      if (rec.stock.length) {
        const c = rec.stock.shift();
        remember(rec, c); store.put(n, rec);
        for (const w of waiters.get(n) || []) w();      // the open wallet hears its stock went down
        return send(res, 200, codeOut(n, rec, c, { fresh: true, reused: false }), { cors: true });
      }
      if (lapsed) store.put(n, rec);
      if (isOnline(n)) {
        const ans = await ask(n, { kind: 'code' });
        // Read again: the record may have changed while the wallet answered.
        const now2 = ans && ans.code ? live(n) : null;
        if (now2 && now2.pubkey === rec.pubkey) {
          const c = { id: ans.id, code: ans.code, sig: ans.sig, until: requestUntil(ans.code) };
          remember(now2, c); store.put(n, now2);
          return send(res, 200, codeOut(n, now2, c, { fresh: true, reused: false }), { cors: true });
        }
      }
      return again() || send(res, 200, { status: 'ERROR', reason: OFFLINE }, { cors: true });
    },
    async stock (res, b) {
      const n = b && b.name, rec = live(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      const add = Array.isArray(b.add) ? b.add : null, drop = Array.isArray(b.drop) ? b.drop.map(String) : null;
      if (!add || !drop || add.length > stockMax || drop.length > 200) return fail(res, 400, 'add and drop are lists');
      for (const c of add) if (!c || typeof c.id !== 'string' || typeof c.code !== 'string' || typeof c.sig !== 'string') return fail(res, 400, 'each code is { id, code, sig }');
      if (!verifySig(rec.pubkey, signedDigest('stock', domain, n, b.ts, add.map((c) => c.id).join(','), drop.join(',')), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      // Each code: the name key's signature over it, its own id, a code the payer can read, and not one
      // handed out before (a replayed message must not put a code back).
      for (const c of add) {
        if (c.id !== codeId(c.code)) return fail(res, 400, 'a code\'s id is not its hash');
        if (!verifyCode(rec.pubkey, domain, n, c)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
        let pc = null; try { pc = readPayCode(c.code); } catch {}
        if (!pc || !pc.address) return fail(res, 400, 'not a receive code');
      }
      const gone = new Set([...drop, ...(rec.served || [])]);
      const stock = (rec.stock || []).filter((c) => !gone.has(c.id));
      const have = new Set(stock.map((c) => c.id));
      for (const c of add) {
        if (gone.has(c.id) || have.has(c.id)) continue;
        if (stock.length >= stockMax) break;
        stock.push({ id: c.id, code: c.code, sig: c.sig, until: requestUntil(c.code) }); have.add(c.id);
      }
      const before = JSON.stringify(rec.stock || []);
      rec.stock = stock; liveStock(rec);
      // An empty message (each top-up starts with one) changes nothing and writes nothing.
      if (touch(rec) || JSON.stringify(rec.stock) !== before) store.put(n, rec);
      return send(res, 200, { ok: true, held: rec.stock.map((c) => c.id) });
    },
    async mine (req, res, url) {
      // Each page start asks it: limited per network as lookups are.
      if (!netTake(clientNet(req))) return fail(res, 429, BUSY, { code: 'busy' });
      const pk = String(url.searchParams.get('pubkey') || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pk)) return fail(res, 400, 'pubkey is 32 bytes of hex');
      return send(res, 200, { ok: true, name: store.nameOf(pk), declined: store.declined(pk) });
    },
    async register (req, res, b) {
      const n = b && b.name, pk = String((b && b.pubkey) || '').toLowerCase();
      const p = nameProblem(n); if (p) return fail(res, 400, p, { code: 'invalid' });
      if (!/^[0-9a-f]{64}$/.test(pk)) return fail(res, 400, 'pubkey is 32 bytes of hex');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!verifySig(pk, signedDigest('register', domain, n, pk, b.ts), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      // A name released by another key is still taken: it is never anyone else's.
      const had = store.get(n);
      if (had && had.pubkey !== pk) return fail(res, 409, 'That name is taken. Choose another.', { code: 'taken' });
      if (!had && store.count() >= maxNames) return fail(res, 503, 'No more names can be registered here now.', { code: 'full' });
      if (!had && !newTake(clientNet(req))) return fail(res, 429, NEW_BUSY, { code: 'busy' });
      const old = store.nameOf(pk);
      if (old && old !== n) tombstone(old, store.get(old));
      if (!had) store.put(n, { pubkey: pk, at: nowS(), seen: nowS() });
      // Its own name again (a released one taken back, or one held already).
      else if (had.released) { delete had.released; had.seen = nowS(); store.put(n, had); }
      else if (touch(had)) store.put(n, had);
      // A name taken by the key's own wallet: the person wants one again.
      store.undecline(pk);
      return send(res, 200, { ok: true, name: n, address: `${n}@${domain}` });
    },
    async release (res, b) {
      const n = b && b.name, rec = live(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!verifySig(rec.pubkey, signedDigest('release', domain, n, b.ts), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      tombstone(n, rec);
      // Removed by its person: no wallet of this key makes one again by itself, on any device.
      store.decline(rec.pubkey, nowS());
      return send(res, 200, { ok: true });
    },
    // A key with no name whose person does not want one (a removal this service never saw).
    async decline (req, res, b) {
      const pk = String((b && b.pubkey) || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pk)) return fail(res, 400, 'pubkey is 32 bytes of hex');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!verifySig(pk, signedDigest('decline', domain, '-', pk, b.ts), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      if (!store.declined(pk)) {
        // Each mark is a row: limited per network as new names are.
        if (!newTake(clientNet(req))) return fail(res, 429, NEW_BUSY, { code: 'busy' });
        const held = store.nameOf(pk);
        if (held) tombstone(held, store.get(held));
        store.decline(pk, nowS());
      }
      return send(res, 200, { ok: true });
    },
    async wait (req, res, b) {
      const n = b && b.name, rec = live(n);
      if (!rec) return fail(res, 404, 'No wallet goes by that name.');
      if (!freshTs(b.ts)) return fail(res, 400, "The wallet's clock is off; set it right and try again.", { code: 'clock' });
      if (!/^[0-9]{1,16}$/.test(String(b.min_sat)) || !/^[0-9]{1,16}$/.test(String(b.max_sat))) return fail(res, 400, 'min_sat and max_sat are whole numbers');
      if (!verifySig(rec.pubkey, signedDigest('wait', domain, n, b.ts, b.min_sat, b.max_sat), b.sig)) return fail(res, 403, 'The signature does not verify.', { code: 'signature' });
      online.set(n, { seen: now(), min_sat: String(b.min_sat), max_sat: String(b.max_sat) });
      if (touch(rec)) store.put(n, rec);
      // Read when answered: payers may have taken codes meanwhile.
      const held = () => { const r = live(n); if (!r || r.pubkey !== rec.pubkey) return []; if (liveStock(r)) store.put(n, r); return r.stock.map((c) => c.id); };
      if (undelivered(n).length) return send(res, 200, { ok: true, requests: deliver(undelivered(n)), held: held() });
      const set = waiters.get(n) || new Set(); waiters.set(n, set);
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); set.delete(finish); resolve(); };
        const t = setTimeout(finish, holdMs);
        set.add(finish);
        // The response's close, not the request's: Node closes a request once its body is read.
        res.on('close', finish);
      });
      if (res.writableEnded || res.destroyed) return;
      // Released or moved while it waited: the wallet is told now, not at its next wait.
      const still = live(n);
      if (!still || still.pubkey !== rec.pubkey) return fail(res, 404, 'No wallet goes by that name.');
      online.set(n, { ...(online.get(n) || {}), seen: now() });
      return send(res, 200, { ok: true, requests: deliver(undelivered(n)), held: held() });
    },
    async answer (res, b) {
      const n = b && b.name, rec = live(n);
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
        let pc = null; try { pc = readPayCode(code); } catch {}
        if (!pc || !pc.address) return fail(res, 400, 'not a receive code');
        out = { code, id: entry.id, sig: String(b.sig) };
      }
      clearTimeout(entry.timer); q.delete(entry.id); entry.resolve(out);
      return send(res, 200, { ok: true });
    },
  };

  // A name as a scanner may send it: some keep `lightning:` or BIP353's `₿` in front, or upper case.
  function bareName (raw) {
    let v = String(raw); try { v = decodeURIComponent(v); } catch {}
    return v.trim().replace(/^(lightning:|\u20bf)/i, '').toLowerCase();
  }

  async function handle (req, res, url) {
    const p = url.pathname;
    let m;
    if (req.method === 'OPTIONS' && (p.startsWith('/.well-known/lnurlp/') || p.startsWith('/lnaddr/'))) {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'accept' });
      res.end(); return true;
    }
    if (req.method === 'GET' && (m = /^\/\.well-known\/lnurlp\/([^/]+)$/.exec(p))) { await routes.payRequest(req, res, bareName(m[1])); return true; }
    if (req.method === 'GET' && (m = /^\/lnaddr\/-\/pay\/([^/]+)$/.exec(p))) { await routes.callback(req, res, decodeURIComponent(m[1]).toLowerCase(), url); return true; }
    if (req.method === 'GET' && p === '/lnaddr/-/mine') { await routes.mine(req, res, url); return true; }
    if (req.method === 'POST' && (m = /^\/lnaddr\/-\/(register|release|decline|stock|wait|answer)$/.exec(p))) {
      const b = await readBody(req);
      if (!b) { fail(res, 400, 'the body is not JSON'); return true; }
      if (m[1] === 'wait' || m[1] === 'register' || m[1] === 'decline') await routes[m[1]](req, res, b); else await routes[m[1]](res, b);
      return true;
    }
    if (req.method === 'GET' && (m = /^\/lnaddr\/([^/]+)$/.exec(p)) && m[1] !== '-') { await routes.code(req, res, decodeURIComponent(m[1]).toLowerCase()); return true; }
    return false;
  }

  function close () { if (pruner) clearInterval(pruner); store.close(); }
  return { handle, store, isOnline, close, __test__: { pending, pruneIdle } };
}
