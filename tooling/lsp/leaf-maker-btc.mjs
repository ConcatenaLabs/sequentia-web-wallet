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
//   GET  /v1/btc/swap/<id>             -> { swap, state }
//
// Its configuration, under the maker's own: "btc": { "rpc": "/…/lightning-rpc" (its node's socket),
//   "keep_sats": "100000" (what its channels keep), "invoice_seconds": 3600,
//   "pairs": [ { "give": "BTC", "want": "<hex>", "rate_num", "rate_den", "min_give" },
//              { "give": "<hex>", "want": "BTC", … } ] } — or "price": true with the maker's price
// feed, its "assets" naming "BTC" too. Swaps are kept in the store directory (btc-swaps.json), so a
// restart follows every one it began.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { clnRpc, clnBitcoinWallet } from '../cln-rpc.mjs'
import { needSeconds, EXTRA_BLOCKS, INVOICE_LEFT_SECONDS } from '../../user-trade-btc.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const HEX = /^[0-9a-f]{64}$/
const OPEN = new Set(['offered', 'locked', 'paying', 'claiming'])

export function checkBtcConfig (b) {
  if (!b) return null
  if (!b.rpc) throw new Error('the BTC desk names no node socket (btc.rpc)')
  for (const p of b.pairs || []) {
    if (!((p.give === 'BTC' && HEX.test(p.want)) || (p.want === 'BTC' && HEX.test(p.give)))) throw new Error('a BTC pair names BTC and one asset id')
    if (!p.price && !(big(p.rate_num) > 0n && big(p.rate_den) > 0n)) throw new Error('a BTC pair\'s rate is two positive integers, or "price": true')
  }
  return b
}

export async function btcDesk ({ cfg, cmd, log, liveRates }) {
  const b = checkBtcConfig(cfg.btc)
  if (!b) return null
  const node = clnBitcoinWallet(clnRpc(b.rpc))
  const file = join(cfg.store_dir, 'btc-swaps.json')
  const swaps = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : [])
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(swaps), null, 1)); renameSync(file + '.tmp', file) }
  let sats = 0n
  const refreshBalance = async () => { try { sats = await node.balance() } catch (e) { log('btc balance:', e.message) } }
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
      if (s.give_asset !== 'BTC' && s.state === 'offered') out.set(s.give_asset, (out.get(s.give_asset) || 0n) + big(s.give))
    }
    return out
  }

  function quotes (spendable, margin) {
    const held = reserved(), out = []
    for (const p0 of b.pairs || []) {
      const p = pairOf(p0.give, p0.want)
      if (!p) continue
      let have = p.give === 'BTC' ? sats - big(b.keep_sats ?? 100000) - (held.get('BTC') || 0n)
        : (spendable.get(p.give) || 0n) - (held.get(p.give) || 0n) - big(margin)
      // BTC given only for as much of the asset as the operator's cap lets the maker receive.
      const cap = p.give === 'BTC' ? caps.get(p.want) : null
      if (cap) { const fits = (cap.headroom * 9n / 10n) * big(p.rate_den) / big(p.rate_num); if (fits < have) have = fits }
      const min = big(p.min_give || 1)
      if (have < min) continue
      out.push({ give_asset: p.give, want_asset: p.want, rate_num: String(p.rate_num), rate_den: String(p.rate_den), min_give: String(min), max_give: String(have) })
    }
    return out
  }

  async function firm (body, spendable, margin) {
    const p = pairOf(body.give_asset, body.want_asset)
    if (!p) return [404, { error: 'the maker quotes no such pair' }]
    const q = quotes(spendable, margin).find((x) => x.give_asset === p.give && x.want_asset === p.want)
    const give = big(body.give)
    if (!q || give < big(q.min_give) || give > big(q.max_give)) return [409, { error: 'the maker does not hold that much now', quote: q || null }]
    const want = ceilDiv(give * big(p.rate_num), big(p.rate_den))
    const id = `btc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const ttl = (cfg.offer_ttl_seconds ?? 300)
    if (p.give === 'BTC') {
      // The wallet's invoice: for exactly what is given, with time to run.
      const d = await node.decode(String(body.invoice || ''))
      if (d.sats !== give) return [409, { error: `the invoice asks ${d.sats} sat, not ${give}` }]
      if (d.expires_at - Date.now() / 1000 < ttl + 1800) return [409, { error: 'the invoice expires too soon' }]
      let r
      try { r = await cmd('lightning_receive', { asset: p.want, amount: String(want), hash: d.payment_hash, description: 'trade' }, true) }
      catch (e) { const h = capOf(e.message); if (h != null) caps.set(p.want, { headroom: h, at: Date.now() }); throw e }
      const s = { swap: id, give_asset: 'BTC', want_asset: p.want, give: String(give), want: String(want), hash: d.payment_hash, invoice_btc: body.invoice,
        min_final_cltv: d.min_final_cltv, invoice_x: r.invoice, state: 'offered', at: Date.now(), expires: Date.now() + ttl * 1000 }
      swaps.set(id, s); save()
      log('btc firm', id, 'gives', String(give), 'sat for', String(want), p.want.slice(0, 8))
      return [200, { swap: id, invoice: r.invoice, give: String(give), want: String(want), expires_at: Math.floor(s.expires / 1000) }]
    }
    const inv = await node.invoice({ sats: want, description: 'trade', expiry: b.invoice_seconds ?? 3600 })
    const s = { swap: id, give_asset: p.give, want_asset: 'BTC', give: String(give), want: String(want), hash: inv.payment_hash, invoice_btc: inv.invoice,
      state: 'offered', at: Date.now(), expires: Date.now() + ttl * 1000 }
    swaps.set(id, s); save()
    log('btc firm', id, 'gives', String(give), p.give.slice(0, 8), 'for', String(want), 'sat')
    return [200, { swap: id, invoice: inv.invoice, give: String(give), want: String(want), expires_at: Math.floor(s.expires / 1000) }]
  }

  // The wallet's receive under the maker's hash: paid from the maker's leaves, on the terms read.
  async function lock (body) {
    const s = swaps.get(String(body.swap || ''))
    if (!s || s.give_asset === 'BTC') return [404, { error: 'no such swap' }]
    if (s.state !== 'offered') return [200, { swap: s.swap, state: s.state }]
    if (Date.now() > s.expires) return [409, { error: 'the offer lapsed' }]
    const q = await cmd('lightning_pay_quote', { invoice: String(body.invoice || ''), asset: s.give_asset }, true)
    if (q.payment_hash !== s.hash || q.asset !== s.give_asset || q.amount !== s.give) return [409, { error: 'the invoice is not for this swap' }]
    s.state = 'locked'; s.invoice_x = body.invoice; save()
    try { await cmd('lightning_pay', { invoice: body.invoice, asset: s.give_asset, shown: q }, true) }
    catch (e) { s.state = 'offered'; save(); throw e }
    log('btc locked', s.swap, String(s.give), s.give_asset.slice(0, 8))
    return [200, { swap: s.swap, state: s.state }]
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
      try { await step(s, receives[s.hash] || {}, pays[s.hash] || {}) } catch (e) { log('btc swap', s.swap, e.message) }
    }
    save()
  }

  async function step (s, rcv, pay) {
    if (s.give_asset === 'BTC') {
      if (rcv.state === 'failed') { s.state = 'void'; log('btc swap', s.swap, 'void:', rcv.reason || ''); return }
      if (s.state === 'offered') {
        if (rcv.state !== 'issuing') { if (Date.now() > s.expires + 3600 * 1000 && rcv.state === 'waiting') s.state = 'lapsed'; return }
        const r = await cmd('lightning_receive_ready', { hash: s.hash, need_seconds: needSeconds(s.min_final_cltv) }).catch((e) => ({ ready: false, never: e.message }))
        if (r.never) { s.state = 'void'; log('btc swap', s.swap, 'not paid:', r.never); return }
        if (!r.ready) return
        const d = await node.decode(s.invoice_btc)
        if (d.expires_at - Date.now() / 1000 < INVOICE_LEFT_SECONDS) { s.state = 'void'; log('btc swap', s.swap, 'the wallet\'s invoice runs out'); return }
        s.state = 'paying'; save()
      }
      if (s.state === 'paying') {
        let st = await node.payStatus(s.hash)
        if (st.state === 'none') st = await node.pay({ invoice: s.invoice_btc, maxFeeSats: big(b.max_route_fee_sats ?? 0), maxDelay: Number(s.min_final_cltv || 18) + EXTRA_BLOCKS })
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
    if (p === '/v1/btc/paid') return [200, { swap: body.swap, state: (swaps.get(String(body.swap)) || {}).state || null }]
    return null
  }

  return { quotes, route, tick, swaps }
}
