#!/usr/bin/env node
// Drives a purchase paid in BTC on a lock straight from the maker (htlc-2) through the page's own
// trade engine, against the operator repository's harness, and checks at every step that neither
// side can take what it has not paid for:
//
//   paid       the maker locks at once and the buyer holds the lock before anything of its own
//              moved; meanwhile the operator knows no preimage, the maker's invoice is unpaid, a
//              claim with any other preimage is refused, and so is a wrong preimage posted to the
//              operator; the library marks the lock paid before the BTC goes out (so it goes home at
//              its home date unless claimed); the buyer pays, the preimage comes out with the BTC
//              payment, the buyer claims, and the maker's swap is done;
//   failed     the maker locks, the library marks the lock paid, and the buyer's BTC payment is
//              refused before anything went out: the page clears the mark (`lock_unpaid`) before
//              the trade comes back, so past the lock's home date the buyer does not take it on the
//              chain (an exit it could never finish without the preimage), and from the timeout
//              the lock comes back to the maker out of round; no BTC moved;
//   abandoned  the maker locks, and the buyer (its page closed) never pays: the lock stays the
//              buyer's to claim only with a preimage nobody revealed, the maker's coin is not
//              refunded before the timeout, and comes back to the maker from it; no BTC moved.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 node tooling/btc-lock-drive.mjs <evidence-dir>
//
// The harness runs with ARCA_OPERATOR_LIGHTNING=1 and ARCA_OPERATOR_BTC_LIGHTNING (at least 1):
// the maker's desk is on its hub, and the buyer on the last wallets' node. Needs pkg/ (phrases).
// Nothing here is used by the deployed wallet.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { harness, startMaker, makerReady, freePort, sleep, lwkFrom } from './user-mode-stack.mjs'
import { leafLibrary } from './leaf-node.mjs'
import { clnRpc, clnBitcoinWallet } from './cln-rpc.mjs'
import { createEngine } from '../user-trade.js'
import { needSeconds } from '../user-trade-btc.js'

const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const out = resolve(process.argv[2] || join(tmpdir(), 'btc-lock-drive'))
mkdirSync(out, { recursive: true })
const logFile = join(out, 'drive.log')
writeFileSync(logFile, '')
const T0 = Date.now()
const note = (s) => { s = ((Date.now() - T0) / 1000).toFixed(0).padStart(5) + 's ' + s; console.log(s); appendFileSync(logFile, s + '\n') }
let failures = 0
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))
function check (name, ok, detail) { note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : show(detail)) : ''}`); if (!ok) failures++ }
async function until (what, f, ms = 300000, every = 1500) {
  const end = Date.now() + ms
  for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(every) }
}
const H = harness(control)
const sha = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
let maker = null

async function main () {
  const st = await H.state()
  if (!st.lightning || !st.btc_lightning || !(st.btc_lightning.wallets || []).length) throw new Error('the harness runs no Lightning (ARCA_OPERATOR_LIGHTNING=1 ARCA_OPERATOR_BTC_LIGHTNING=1)')
  const X = st.x
  const op = async (path, body) => { const r = await fetch(st.server + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }
  const info = await (await fetch(st.server + '/v1/info')).json()
  note(`operator ${st.server}: templates ${show(info.templates && info.templates.list)}, finality ${show(info.finality)}`)
  if (!st.bond) { await H.c('/bond_post', { amount: 50000000 }); note('posted the operator\'s bond (the maker gives out of round only within the budget it stands for)') }

  let pumpOn = true, pumping = false
  const pump = setInterval(async () => { if (!pumpOn || pumping) return; pumping = true; try { await H.pump() } catch {} finally { pumping = false } }, 2500)

  // ---- the maker: X for BTC from its desk on the hub ----
  const lwk = await lwkFrom()
  const hub = clnRpc(st.btc_lightning.hub)
  maker = await startMaker(H, st, join(out, 'maker'), { pairs: [{ give: X, want: st.y, rate_num: '1', rate_den: '1', min_give: '10000' }], fund: [[X, 20000000]],
    port: await freePort(), lwk, settleSeconds: 20, syncSeconds: 3, exitDelayUnits: 3, coinSize: 2000000,
    btc: { rpc: st.btc_lightning.hub, keep_sats: '200000', invoice_seconds: 3600, pairs: [{ give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }] } })
  note(`maker pid ${maker.proc.pid} at ${maker.url}`)
  await makerReady(H, maker, X)
  await until('the desk quoting X for BTC', async () => { try { return ((await (await fetch(maker.url + '/v1/quotes')).json()).quotes || []).some((q) => q.give_asset === X && q.want_asset === 'BTC') } catch { return false } }, 300000, 3000)

  // ---- the buyer: the page's engine, its leaves and its own Bitcoin Lightning node ----
  const lib = await leafLibrary(join(out, 'buyer-store'))
  const w = lib.create(lwk.Mnemonic.fromRandom(12).toString(), { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 3, min_exit_delay_units: 3 })
  const btcRpc = clnRpc(st.btc_lightning.wallets[st.btc_lightning.wallets.length - 1])
  const btc0 = clnBitcoinWallet(btcRpc)
  // The failed purchase's payment is refused before anything is sent, as the wallet's Lightning
  // service answers a payment it declines (HTTP 400/403).
  let failPay = false
  const btc = new Proxy(btc0, { get (t, k) { if (k === 'pay' && failPay) return async () => ({ state: 'failed', reason: 'declined before anything was sent' }); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v } })
  const mem = new Map()
  const fetchJson = async (url, init) => { const r = await fetch(url, init ? { ...init, headers: { 'content-type': 'application/json' } } : undefined); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.body = j; throw e } return j }
  const eng = createEngine({ leaves: w, fetchJson, makers: () => [maker.url], relayBook: async () => [], relayFills: async () => [],
    admitted: () => ({ pairs: { chains: { [st.genesis_hash]: { pairs: [{ pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }, genesis: st.genesis_hash }),
    store: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }, tag: () => 'drive', btc, log: (...a) => appendFileSync(join(out, 'engine.log'), a.map(String).join(' ') + '\n') })
  w.command('sync')
  const swapOf = async (id) => (await (await fetch(maker.url + '/v1/btc/swap/' + id)).json()).state
  const pays = async (hash) => ((await btcRpc('listpays', { payment_hash: hash })).pays || []).filter((p) => p.status === 'complete').length
  const makerInvoice = async (hash) => (((await hub('listinvoices', { payment_hash: hash })).invoices || [])[0] || {}).status
  const lockReady = (hash, rec) => { try { w.command('sync') } catch {} try { return w.command('lock_ready', { hash, need_seconds: needSeconds(rec.routeDelay || rec.minFinalCltv) }) } catch (e) { return { refused: e.message } } }
  const buy = async (amount) => {
    const q = await until('a ticket for BTC to X', async () => { const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount }); return q.ok ? q : (note('     no ticket yet: ' + q.why), null) }, 180000, 5000)
    const t = Date.now()
    const r = await eng.confirm(q.choice, q.ticket)
    return { q, r, t }
  }

  // ---- the paid purchase ----
  const a = await buy('60000')
  check('the purchase asks the maker for a lock straight to the wallet (htlc-2)', a.r.leg === 'htlc-2' && a.r.state === 'waiting', { leg: a.r.leg, state: a.r.state })
  const held = await until('the lock held by the buyer', async () => { const r = lockReady(a.r.hash, a.r); return r.ready ? r : null }, 120000, 1000)
  check('the lock is held, out of round, before anything of the buyer\'s moved', held.ready === true && (await pays(a.r.hash)) === 0, { held_after_s: ((Date.now() - a.t) / 1000).toFixed(1), leaf: held.leaf_id, value: held.value, home_in: held.home_in })
  const ls1 = await op('/v1/lock_status', { payment_hash: a.r.hash })
  check('the operator holds the lock and knows no preimage', ls1.status === 200 && !ls1.body.preimage && (ls1.body.locks || []).length === 1, ls1.body)
  check('the maker\'s invoice is unpaid and its swap locked', (await makerInvoice(a.r.hash)) === 'unpaid' && (await swapOf(a.r.swap)) === 'locked')
  const wrong = randomBytes(32).toString('hex')
  let refusal = null
  try { w.command('lock_claim', { hash: a.r.hash, preimage: wrong }) } catch (e) { refusal = e.message }
  check('a claim with another preimage is refused by the buyer\'s own library', /does not open hash/.test(String(refusal)), refusal)
  const lp = await op('/v1/lock_preimage', { payment_hash: a.r.hash, preimage: wrong })
  check('a wrong preimage posted to the operator is refused', lp.status >= 400, { status: lp.status, body: lp.body })
  // The page's next step: it pays, learns the preimage, claims.
  let rec = null
  rec = await until('the purchase settled', async () => { const r = await eng.advance(eng.records().find((x) => x.id === a.r.id)); return r.state === 'settled' ? r : null }, 300000, 2000)
  const ls2 = await op('/v1/lock_status', { payment_hash: a.r.hash })
  check('the BTC was paid once, and the preimage came out with it', (await pays(a.r.hash)) === 1 && rec.preimage && sha(rec.preimage) === a.r.hash && ls2.body.preimage === rec.preimage && (await makerInvoice(a.r.hash)) === 'paid',
    { pays: await pays(a.r.hash), lock_status: ls2.body.locks })
  const payeeLock = (w.command('locks') || []).find((l) => l.role === 'payee' && l.hash === a.r.hash) || {}
  check('the library marked the lock paid before the BTC went out', payeeLock.paid === true && rec.markedPaid === true, { paid: payeeLock.paid, state: payeeLock.state })
  check('the buyer claimed the lock and settled the claimed coin', rec.receiveState === 'received' && (rec.settleTargets || [])[0] && !!rec.settleTargets[0].leaf_id, { settle: rec.settleTargets })
  await until('the maker\'s swap done', async () => (await swapOf(a.r.swap)) === 'done', 120000, 2000)
  check('the maker\'s swap is done', true)
  check('what the buyer got: at least the ticket\'s amount out', true, { ticket_out: a.q.ticket.amountOut, ticket_in: a.q.ticket.amountIn, fees: a.q.ticket.fees })

  // ---- the failed purchase: locked, marked paid, its BTC payment refused ----
  failPay = true
  const c = await buy('40000')
  check('the failed purchase asks for a lock too', c.r.leg === 'htlc-2', { leg: c.r.leg })
  await until('the third lock held', async () => { const r = lockReady(c.r.hash, c.r); return r.ready ? r : null }, 120000, 1000)
  const rc = await until('the failed purchase back', async () => { const r = await eng.advance(eng.records().find((x) => x.id === c.r.id)); return r.state === 'returned' ? r : null }, 120000, 2000)
  failPay = false
  const cl = (w.command('locks') || []).find((l) => l.role === 'payee' && l.hash === c.r.hash) || {}
  check('its payment failed and nothing was paid; the lock was marked paid before, and its mark is cleared now', (await pays(c.r.hash)) === 0 && rc.markedPaid === false && cl.paid === false && cl.state === 'held',
    { why: rc.why, markedPaid: rc.markedPaid, lock: { state: cl.state, paid: cl.paid, unpaid_at: cl.unpaid_at } })
  const stc = await op('/v1/lock_status', { payment_hash: c.r.hash })
  const Tc = Number((stc.body.locks || [])[0] && stc.body.locks[0].timeout)

  // ---- the abandoned purchase: locked, never paid ----
  const b = await buy('50000')
  check('the second purchase asks for a lock too', b.r.leg === 'htlc-2', { leg: b.r.leg })
  const held2 = await until('the second lock held', async () => { const r = lockReady(b.r.hash, b.r); return r.ready ? r : null }, 120000, 1000)
  const st2 = await op('/v1/lock_status', { payment_hash: b.r.hash })
  const T = Number((st2.body.locks || [])[0] && (st2.body.locks[0].timeout ?? 0)) || Number(held2.timeout)
  note(`     the page closes here: the lock is held (timeout median ${T}), and nothing of the buyer's has moved`)
  // Before the timeout: the maker's coin stays locked, its swap 'locked'.
  await sleep(10000)
  check('before the timeout the maker\'s lock stands, unpaid, unclaimed', (await swapOf(b.r.swap)) === 'locked' && !(await op('/v1/lock_status', { payment_hash: b.r.hash })).body.preimage && (await pays(b.r.hash)) === 0)
  // The chain's clock past the timeout.
  const median = async () => (await H.rpc('getblockchaininfo')).mediantime
  let m = await median()
  // Past the failed purchase's home date (its timeout less the unroll, the buyer's exit delay of 3
  // units and ten minutes), short of its timeout: the buyer, the page's library syncing, does not
  // take the cleared lock on the chain.
  const home = Tc - 3600 - 3 * 512 - 600
  note(`     median ${m}, the failed purchase's lock: home date about ${home}, timeout ${Tc}`)
  while (m < home + 300) { await H.advance(Math.min(86400, home + 600 - m)); await H.produce(); await H.bury().catch(() => {}); m = await median() }
  let sc = null
  for (let i = 0; i < 6; i++) { await H.pump().catch(() => {}); try { sc = w.command('sync') } catch (e) { sc = { error: e.message } } await sleep(2000) }
  const cl2 = (w.command('locks') || []).find((l) => l.role === 'payee' && l.hash === c.r.hash) || {}
  let cc = []; try { cc = (w.command('coins') || []).filter((x) => x.leaf_id === cl2.leaf_id) } catch (e) { note('     coins: ' + e.message) }
  check('past its home date the buyer does not take the cleared lock on the chain', Tc - m > 0 && cc.length === 1 && cc[0].state === 'lock_in' && !(sc && sc.exits || []).some((e) => e.leaf_id === cl2.leaf_id),
    { median: m, to_timeout: Tc - m, coin: cc.map((x) => ({ state: x.state, note: x.note })), exits: sc && sc.exits })
  note(`     median ${m}, the abandoned lock's timeout ${T}: ${T - m} s to go`)
  const Tmax = Math.max(T, Tc)
  while (m < Tmax + 120) { await H.advance(Math.min(86400, Tmax + 600 - m)); await H.produce(); await H.bury().catch(() => {}); m = await median() }
  note(`     median ${m}, past the timeouts`)
  const backC = await until('the failed purchase\'s swap void (its lock refunded out of round)', async () => { await H.pump().catch(() => {}); try { w.command('sync') } catch {} return (await swapOf(c.r.swap)) === 'void' }, 600000, 4000).catch(() => false)
  const ls4 = await op('/v1/lock_status', { payment_hash: c.r.hash })
  check('from the timeout the failed purchase\'s lock came back to the maker out of round, no BTC moved', backC && (ls4.body.locks || []).some((l) => l.state === 'refunded') && (await pays(c.r.hash)) === 0,
    { swap: await swapOf(c.r.swap), lock_status: ls4.body.locks })
  const back = await until('the maker\'s swap void (its lock refunded from the timeout)', async () => { await H.pump().catch(() => {}); return (await swapOf(b.r.swap)) === 'void' }, 600000, 4000).catch(() => false)
  const ls3 = await op('/v1/lock_status', { payment_hash: b.r.hash })
  check('from the timeout the lock came back to the maker, the preimage never out, no BTC moved', back && !ls3.body.preimage && (await pays(b.r.hash)) === 0 && (ls3.body.locks || []).some((l) => l.state === 'refunded'), { swap: await swapOf(b.r.swap), lock_status: ls3.body })
  const after = lockReady(b.r.hash, b.r)
  check('the buyer\'s library will not pay for it any more', !after.ready, after)
  clearInterval(pump); pumpOn = false
  writeFileSync(join(out, 'maker.log'), maker.log.join(''))
}

main().catch((e) => { failures++; note('FAIL ' + (e.stack || e.message)) }).finally(async () => {
  if (maker) { try { writeFileSync(join(out, 'maker.log'), maker.log.join('')) } catch {} await maker.stop().catch(() => {}) }
  note(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
})
