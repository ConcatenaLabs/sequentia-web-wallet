// The leaf maker's BTC desk: BTC for an asset, and an asset for BTC, in one hash-lock, from the
// maker's leaves and its own Bitcoin Lightning node. The user-mode composer's 'btc-gateway'
// source (user-trade-btc.js is the wallet's side; its header says why each order is safe).
//
//   The maker gives BTC: the wallet sends its Bitcoin invoice; the maker asks to receive the
//     asset under the invoice's hash (`lightning_receive` with `hash`), answers the operator's
//     invoice, and, once the wallet's leaf has paid it and the leaf received under the hash is
//     held for good (`lightning_receive_ready`), pays the wallet's invoice, learns the preimage
//     and claims.
//   The maker gives an asset: it makes a Bitcoin invoice of its own node's; the wallet asks to
//     receive the asset under its hash and sends the operator's invoice; the maker's leaf pays it
//     (`lightning_pay`, on the terms `lightning_pay_quote` read); when its node is paid it hands
//     the preimage to the operator, which settles its payment.
//
// HTTP, beside the maker's in-tree endpoints:
//   POST /v1/btc/firm {give_asset, want_asset, give, invoice?} -> { swap, invoice, give, want, expires_at }
//        give_asset 'BTC': `invoice` is the wallet's Bitcoin invoice for `give` sat; the answer's
//        invoice is the operator's, for `want` of the asset under the same hash.
//        want_asset 'BTC': the answer's invoice is the maker's Bitcoin invoice for `want` sat.
//   POST /v1/btc/lock {swap, invoice}  (the maker gives an asset) the operator's invoice for the
//        wallet's receive under the maker's hash: the maker's leaf pays it.
//   POST /v1/btc/paid {swap}           a nudge: the wallet paid; the maker follows at once.
//   POST /v1/btc/release {swap}        a firm offer nobody took.
//   POST /v1/btc/invoice {swap}        (the maker gives an asset, the swap locked) a new Bitcoin
//        invoice under the same hash and for the same amount when the one given runs out within
//        half an hour: -> { swap, invoice, expires_at }
//   GET  /v1/btc/swap/<id>             -> { swap, state }
//
// Its configuration, under the maker's own: "btc": { "rpc": "/…/lightning-rpc" (its node's socket),
//   "keep_sats": "100000" (what its channels keep), "invoice_seconds": 3600, "max_route_fee_sats":
//   "1000" (the most it pays to route a payment to a wallet's node),
//   "pairs": [ { "give": "BTC", "want": "<hex>", "rate_num", "rate_den", "min_give" },
//              { "give": "<hex>", "want": "BTC", … } ] } — or "price": true with the maker's price
// feed, its "assets" naming "BTC" too. Swaps are kept in the store directory (btc-swaps.json), so a
// restart follows every one it began.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { clnRpc, clnBitcoinWallet } from '../cln-rpc.mjs'
import { needSeconds, EXTRA_BLOCKS, INVOICE_LEFT_SECONDS } from '../../user-trade-btc.js'
import { perAsset, ladderOf, slicesOf, ladderQuotes, walkWant } from './leaf-maker-ladder.mjs'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const HEX = /^[0-9a-f]{64}$/
const OPEN = new Set(['offered', 'locking', 'locked', 'paying', 'claiming'])
// How long a payment the maker began may go unrecorded by its library before the swap is offered
// again, so the wallet's next lock pays it.
const LOCKING_SECONDS = 120
// How long an invoice of the desk's runs (`invoice_seconds` overrides it): long enough for the
// usual wait for the asset to be final, and renewed under the same hash past that (`reinvoice`).
const INVOICE_SECONDS = 4 * 3600

export function checkBtcConfig (b) {
  if (!b) return null
  if (!b.rpc) throw new Error('the BTC desk names no node socket (btc.rpc)')
  for (const p of b.pairs || []) {
    if (!((p.give === 'BTC' && HEX.test(p.want)) || (p.want === 'BTC' && HEX.test(p.give)))) throw new Error('a BTC pair names BTC and one asset id')
    if (!p.price && !(big(p.rate_num) > 0n && big(p.rate_den) > 0n)) throw new Error('a BTC pair\'s rate is two positive integers, or "price": true')
  }
  return b
}

export async function btcDesk ({ cfg, cmd, log, liveRates, onTrade }) {
  const b = checkBtcConfig(cfg.btc)
  if (!b) return null
  const lockingMs = Number(b.locking_seconds ?? LOCKING_SECONDS) * 1000
  const node = clnBitcoinWallet(clnRpc(b.rpc))
  const file = join(cfg.store_dir, 'btc-swaps.json')
  const swaps = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : [])
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(swaps), null, 1)); renameSync(file + '.tmp', file) }
  let sats = 0n, inbound = null
  const refreshBalance = async () => {
    try { sats = await node.balance() } catch (e) { log('btc balance:', e.message) }
    try { if (node.receivable) inbound = await node.receivable() } catch (e) { log('btc receivable:', e.message) }
  }
  await refreshBalance()

  // The operator caps what payments into its tree may hold, not yet claimed, in each asset (a
  // share of its pool), and publishes no figure for it: the maker reads it from the operator's
  // refusal, and gives no more BTC than the asset it would receive fits. A probe asks for far more
  // than any cap; the refusal keeps nothing (the library forgets a refused receive).
  const caps = new Map()   // asset -> { headroom, at }
  const capOf = (msg) => { const m = /is (\d+) \(\d+ ppm of its pool of \d+\): (\d+) is held/.exec(String(msg)); return m ? big(m[1]) - big(m[2]) : null }
  async function probeCaps () {
    for (const a of new Set((b.pairs || []).filter((p) => p.give === 'BTC').map((p) => p.want))) {
      const probe = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
      try { await cmd('lightning_receive', { asset: a, amount: '1000000000000000', hash: probe }); log('btc: the operator took a probe receive') } catch (e) {
        const h = capOf(e.message)
        if (h != null) caps.set(a, { headroom: h, at: Date.now() })
      }
    }
  }
  let probedAt = 0

  const pairOf = (give, want) => {
    const p = (b.pairs || []).find((x) => x.give === give && x.want === want)
    if (!p) return null
    if (!p.price) return p
    const r = liveRates().get(give + ':' + want)
    return r ? { ...p, ...r } : null
  }
  // What open swaps hold: sats the maker owes, atoms it has offered.
  const reserved = () => {
    const out = new Map()
    for (const s of swaps.values()) {
      if (!OPEN.has(s.state)) continue
      if (s.give_asset === 'BTC' && ['offered', 'paying'].includes(s.state)) out.set('BTC', (out.get('BTC') || 0n) + big(s.give))
      if (s.give_asset !== 'BTC' && ['offered', 'locking'].includes(s.state)) out.set(s.give_asset, (out.get(s.give_asset) || 0n) + big(s.give))
    }
    return out
  }

  // A pair's ladder now (leaf-maker-ladder.mjs): what the desk can give of it, in slices.
  function slicesFor (p0, spendable, margin, held = reserved()) {
    const p = pairOf(p0.give, p0.want)
    if (!p) return null
    let have = p.give === 'BTC' ? sats - big(b.keep_sats ?? 100000) - (held.get('BTC') || 0n)
      : (spendable.get(p.give) || 0n) - (held.get(p.give) || 0n) - big(perAsset(margin, p.give, 0))
    // BTC given only for as much of the asset as the operator's cap lets the maker receive, at the
    // ladder's worst rate.
    const lad = ladderOf(p0, cfg)
    // the ladder's worst rate, as an exact fraction: want atoms per give atom = wNum / wDen
    const wNum = big(p.rate_num) * BigInt(10000 + lad.stepBps * (lad.levels - 1)), wDen = big(p.rate_den) * 10000n
    const cap = p.give === 'BTC' ? caps.get(p.want) : null
    if (cap) {
      const fits = (cap.headroom * 9n / 10n) * wDen / wNum
      if (fits < have) have = fits
    }
    // An asset given for BTC only for as much as the maker's channels can be paid, less what open
    // swaps will pay it: a quote past that would ask a wallet for a payment the node cannot take.
    if (p.want === 'BTC' && inbound != null) {
      const owed = [...swaps.values()].filter((s) => OPEN.has(s.state) && s.want_asset === 'BTC').reduce((n, s) => n + big(s.want), 0n)
      const room = inbound * 9n / 10n - owed
      const fits = room > 0n ? room * wDen / wNum : 0n
      if (fits < have) have = fits
    }
    const min = big(p.min_give || 1)
    const slices = slicesOf(p, have, min, lad)
    return slices.length ? { slices, min, pair: p } : null
  }

  function quotes (spendable, margin) {
    const held = reserved(), out = []
    for (const p0 of b.pairs || []) {
      const sl = slicesFor(p0, spendable, margin, held)
      if (sl) out.push(...ladderQuotes(p0.give, p0.want, sl.slices, sl.min))
    }
    return out
  }

  async function firm (body, spendable, margin) {
    const p0 = (b.pairs || []).find((x) => x.give === body.give_asset && x.want === body.want_asset)
    const p = p0 ? pairOf(p0.give, p0.want) : null
    if (!p) return [404, { error: 'the maker quotes no such pair' }]
    const give = big(body.give)
    const sl = slicesFor(p0, spendable, margin)
    const w = sl && give >= sl.min ? walkWant(sl.slices, give) : null
    if (!w) return [409, { error: 'the maker does not hold that much now', quote: sl ? ladderQuotes(p0.give, p0.want, sl.slices, sl.min).pop() : null }]
    const want = w.want
    const id = `btc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const ttl = (cfg.offer_ttl_seconds ?? 300)
    if (p.give === 'BTC') {
      // The wallet's invoice: for exactly what is given, with time to run.
      const d = await node.decode(String(body.invoice || ''))
      if (d.sats !== give) return [409, { error: `the invoice asks ${d.sats} sat, not ${give}` }]
      if (d.expires_at - Date.now() / 1000 < ttl + 1800) return [409, { error: 'the invoice expires too soon' }]
      // The route to the wallet's node, its fee the maker's to pay and its whole lock what the
      // maker's leaf must outlast (a hosted node is reached through its service's node).
      let rt
      try { rt = await node.payRoute(String(body.invoice)) } catch (e) { return [409, { error: 'no route to the invoice\'s node now' }] }
      if (big(rt.fee) > big(b.max_route_fee_sats ?? 1000)) return [409, { error: `the route to the invoice's node costs ${rt.fee} sat, more than the maker pays` }]
      let r
      try { r = await cmd('lightning_receive', { asset: p.want, amount: String(want), hash: d.payment_hash, description: 'trade' }, true) }
      catch (e) { const h = capOf(e.message); if (h != null) caps.set(p.want, { headroom: h, at: Date.now() }); throw e }
      const s = { swap: id, give_asset: 'BTC', want_asset: p.want, give: String(give), want: String(want), hash: d.payment_hash, invoice_btc: body.invoice,
        min_final_cltv: d.min_final_cltv, route_delay: rt.delay, route_fee: String(rt.fee), invoice_x: r.invoice, state: 'offered', at: Date.now(), expires: Date.now() + ttl * 1000 }
      swaps.set(id, s); save()
      log('btc firm', id, 'gives', String(give), 'sat for', String(want), p.want.slice(0, 8))
      return [200, { swap: id, invoice: r.invoice, give: String(give), want: String(want), expires_at: Math.floor(s.expires / 1000) }]
    }
    // Under a preimage the desk keeps, so a wallet whose trade waited longer than the invoice runs
    // (its asset final only after Bitcoin blocks) is given a new invoice under the same hash.
    const ownPreimage = randomBytes(32).toString('hex')
    const inv = await node.invoice({ sats: want, description: 'trade', expiry: b.invoice_seconds ?? INVOICE_SECONDS, preimage: ownPreimage })
    const s = { swap: id, give_asset: p.give, want_asset: 'BTC', give: String(give), want: String(want), hash: inv.payment_hash, invoice_btc: inv.invoice, own_preimage: ownPreimage,
      state: 'offered', at: Date.now(), expires: Date.now() + ttl * 1000 }
    swaps.set(id, s); save()
    log('btc firm', id, 'gives', String(give), p.give.slice(0, 8), 'for', String(want), 'sat')
    return [200, { swap: id, invoice: inv.invoice, give: String(give), want: String(want), expires_at: Math.floor(s.expires / 1000) }]
  }

  // The wallet's receive under the maker's hash: paid from the maker's leaves, on the terms read.
  async function lock (body) {
    const s = swaps.get(String(body.swap || ''))
    if (!s || s.give_asset === 'BTC') return [404, { error: 'no such swap' }]
    // A payment begun and not recorded within LOCKING_SECONDS is offered again (tick), and a lock
    // asked while one is under way answers its state: the swap is paid once.
    if (s.state === 'locking' && Date.now() - (s.locking_at || 0) > lockingMs) s.state = 'offered'
    if (s.state !== 'offered') return [200, { swap: s.swap, state: s.state }]
    if (Date.now() > s.expires) return [409, { error: 'the offer lapsed' }]
    // The maker's own coins can move between its quote and its payment (a board, a settle, another
    // swap): the payment is then quoted again, for the same invoice, and made on the new quote.
    // The swap is 'locking' while the library pays, and 'locked' only once it has: a payment that
    // never completes (no coin free to spend it) cannot leave the swap 'locked' and unpaid.
    // Each attempt carries its own token: a call that returns or fails after a later attempt took
    // over changes nothing.
    const attempt = Date.now() + ':' + Math.random().toString(16).slice(2, 8)
    s.state = 'locking'; s.locking_at = Date.now(); s.attempt = attempt; s.invoice_x = body.invoice; save()
    const mine = () => s.attempt === attempt && s.state === 'locking'
    const back = () => { if (mine()) { s.state = 'offered'; save() } }
    for (let i = 0; ; i++) {
      let q
      try { q = await cmd('lightning_pay_quote', { invoice: String(body.invoice || ''), asset: s.give_asset }, true) } catch (e) { back(); throw e }
      if (q.payment_hash !== s.hash || q.asset !== s.give_asset || q.amount !== s.give) { back(); return [409, { error: 'the invoice is not for this swap' }] }
      if (!mine()) return [200, { swap: s.swap, state: s.state }]
      try { await cmd('lightning_pay', { invoice: body.invoice, asset: s.give_asset, shown: q }, true); break } catch (e) {
        if (i < 2 && /changed since it was shown/.test(String(e.message)) && mine()) continue
        back(); throw e
      }
    }
    if (mine() || s.state === 'offered') { s.state = 'locked'; save() }
    log('btc locked', s.swap, String(s.give), s.give_asset.slice(0, 8))
    return [200, { swap: s.swap, state: s.state }]
  }

  // A new invoice for a swap the desk has locked, under the same hash and for the same amount, when
  // the one the wallet holds runs out within half an hour: the wallet pays only once the asset it
  // receives is final, which can take longer than an invoice runs.
  async function reinvoice (body) {
    const s = swaps.get(String(body.swap || ''))
    if (!s || s.give_asset === 'BTC' || !s.own_preimage) return [404, { error: 'no such swap' }]
    if (s.state !== 'locked') return [409, { error: `the swap is ${s.state}`, state: s.state }]
    const d = await node.decode(s.invoice_btc)
    if (d.expires_at - Date.now() / 1000 > 1800) return [200, { swap: s.swap, invoice: s.invoice_btc, expires_at: d.expires_at }]
    const st = await node.invoiceStatus(s.hash)
    if (st.status === 'paid') return [409, { error: 'the invoice is paid', state: s.state }]
    await node.dropUnpaidInvoice(s.hash)
    const inv = await node.invoice({ sats: big(s.want), description: 'trade', expiry: b.invoice_seconds ?? INVOICE_SECONDS, preimage: s.own_preimage })
    if (inv.payment_hash !== s.hash) return [500, { error: 'the new invoice is under another hash' }]
    s.invoice_btc = inv.invoice; save()
    log('btc reinvoice', s.swap, 'runs to', inv.expires_at)
    return [200, { swap: s.swap, invoice: inv.invoice, expires_at: inv.expires_at }]
  }

  async function release (body) {
    const s = swaps.get(String(body.swap || ''))
    if (!s) return [404, { error: 'no such swap' }]
    if (s.state === 'offered') {
      s.state = 'released'; save()
      if (s.give_asset !== 'BTC') node.cancelInvoice(s.hash).catch(() => {})
    }
    return [200, { swap: s.swap, state: s.state }]
  }

  // Each open swap, moved on as far as it goes now (the caller syncs the library first).
  async function tick () {
    await refreshBalance()
    if (Date.now() - probedAt > 120000) { probedAt = Date.now(); await probeCaps() }
    const open = [...swaps.values()].filter((s) => OPEN.has(s.state))
    if (!open.length) return
    const receives = (await cmd('lightning_receives')) || {}
    const pays = (await cmd('lightning_payments')) || {}
    for (const s of open) {
      const was = s.state
      try { await step(s, receives[s.hash] || {}, pays[s.hash] || {}) } catch (e) { log('btc swap', s.swap, e.message) }
      // A swap settled: the trade it made goes to the market's trade log.
      if (was !== 'done' && s.state === 'done' && onTrade) onTrade(s)
    }
    save()
  }

  async function step (s, rcv, pay) {
    if (s.give_asset === 'BTC') {
      if (rcv.state === 'failed') { s.state = 'void'; log('btc swap', s.swap, 'void:', rcv.reason || ''); return }
      if (s.state === 'offered') {
        if (rcv.state !== 'issuing') { if (Date.now() > s.expires + 3600 * 1000 && rcv.state === 'waiting') s.state = 'lapsed'; return }
        // Only the library's refusal says the leaf will never do; an operator that does not answer
        // now (a restart) is asked again at the next pass, the wallet's payment held meanwhile.
        const r = await cmd('lightning_receive_ready', { hash: s.hash, need_seconds: needSeconds(s.route_delay || s.min_final_cltv) })
          .catch((e) => (e && (e.kind === 'refused' || /^refused\b/i.test(String(e.message))) ? { ready: false, never: e.message } : { ready: false, why: e.message }))
        if (r.never) { s.state = 'void'; log('btc swap', s.swap, 'not paid:', r.never); return }
        if (!r.ready) return
        const d = await node.decode(s.invoice_btc)
        if (d.expires_at - Date.now() / 1000 < INVOICE_LEFT_SECONDS) { s.state = 'void'; log('btc swap', s.swap, 'the wallet\'s invoice runs out'); return }
        s.state = 'paying'; save()
      }
      if (s.state === 'paying') {
        let st = await node.payStatus(s.hash)
        if (st.state === 'none') st = await node.pay({ invoice: s.invoice_btc, maxFeeSats: big(s.route_fee ?? b.max_route_fee_sats ?? 0), maxDelay: Number(s.route_delay || s.min_final_cltv || 18) + EXTRA_BLOCKS })
        if (st.state === 'failed') { s.state = 'offered'; log('btc swap', s.swap, 'payment failed:', st.reason || ''); return }
        if (st.state !== 'complete') return
        s.preimage = st.preimage
        await cmd('lightning_receive_preimage', { hash: s.hash, preimage: st.preimage })
        s.state = 'claiming'
        log('btc paid', s.swap, s.give, 'sat')
      }
      if (s.state === 'claiming' && rcv.state === 'received') { s.state = 'done'; log('btc done', s.swap) }
      return
    }
    // The maker gives an asset.
    // A payment its library records is a lock, whenever it was made (a pay call that outlived its
    // request); one begun and never recorded is offered again after LOCKING_SECONDS.
    if ((s.state === 'offered' || s.state === 'locking') && pay.state) { s.state = 'locked'; log('btc locked', s.swap, 'payment recorded') }
    if (s.state === 'locking') {
      if (Date.now() - (s.locking_at || 0) > lockingMs) { s.state = 'offered'; log('btc swap', s.swap, 'its payment never began: offered again') }
      return
    }
    if (s.state === 'offered') {
      if (Date.now() > s.expires) { s.state = 'lapsed'; node.cancelInvoice(s.hash).catch(() => {}) }
      return
    }
    if (pay.state === 'returned') { s.state = 'void'; node.cancelInvoice(s.hash).catch(() => {}); log('btc swap', s.swap, 'returned'); return }
    const inv = await node.invoiceStatus(s.hash)
    if (inv.status === 'paid' && inv.preimage) {
      if (pay.state !== 'paid') await cmd('lightning_post_preimage', { hash: s.hash, preimage: inv.preimage }).catch((e) => log('post preimage:', e.message))
      if (pay.state === 'paid') { s.state = 'done'; log('btc done', s.swap) }
    }
  }

  const route = async (method, p, body, spendable, margin) => {
    if (method === 'GET' && p.startsWith('/v1/btc/swap/')) { const s = swaps.get(p.slice('/v1/btc/swap/'.length)); return [s ? 200 : 404, s ? { swap: s.swap, state: s.state } : { error: 'no such swap' }] }
    if (method !== 'POST') return null
    if (p === '/v1/btc/firm') return firm(body, await spendable(), margin)
    if (p === '/v1/btc/lock') return lock(body)
    if (p === '/v1/btc/release') return release(body)
    if (p === '/v1/btc/invoice') return reinvoice(body)
    if (p === '/v1/btc/paid') return [200, { swap: body.swap, state: (swaps.get(String(body.swap)) || {}).state || null }]
    return null
  }

  return { quotes, route, tick, swaps }
}
