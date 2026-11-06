// The leaf maker's resting desk: orders resting as leaves in the operator's tree, a ladder of them
// per pair, each listed on SeqDEX's relay (`resting_leaf`), the depth of the wallets' 'leaf-resting'
// source and of the SeqDEX site's default view.
//
// Each pass (`interval_seconds`) it keeps one order resting per pair and level:
//   - a level with no order, or whose order was filled whole, cancelled, not rested, or reached its
//     time, is rested again at the feed's rate of now (`order_rest_quote`, then `order_rest`);
//   - a resting order whose rate is more than `reprice_bps` off the feed's, that the feed's mid has
//     moved through (it sells at or below mid * (1 + guard_bps), the rule every maker of the books
//     follows), or that fills have brought below `refill_pct` (25) percent of its size, is cancelled
//     (`order_cancel_resting_quote`, `order_cancel_resting`, and its relay listing cancelled), and
//     rested again on a later pass;
//   - an order that rests at the operator and has no live listing (never posted, or the relay
//     restarted and lost it, or its listing is near its end) is posted to the relay.
// A level is never rested at a rate that crosses the pair's combined best bid on the relay, or comes
// within `guard_bps` of it (the relay's ticker: every rail of the on-chain book, both orientations);
// such a level waits for a later pass.
// A part fill moves the order to a coin holding the rest; the relay follows it there. What a fill
// brings in is a received coin, refreshed in a round by the maker's own loop.
//
// Configuration, under the maker's own:
//   "rest": { "relay": "http://127.0.0.1:9955", "days": 7, "reprice_bps": 300, "guard_bps": 10, "refill_pct": 25, "interval_seconds": 60,
//             "max_new_per_pass": 6,
//             "pairs": [ { "give": "<hex>", "want": "<hex>", "price": true,
//                          "ladder": { "levels": 8, "step_bps": 25, "growth": 1.4, "first": "5000000" } } ] }
// A pair rests `levels` orders, level k `first` × growth^k atoms of `give`, at the feed's rate
// (the maker's spread included) step_bps × k further from it. An order is rested only from coins
// the maker can spend now; a level it cannot fund waits for a later pass. A level cancelled to be
// repriced is rested again at what its coin came back with (restSize), so the library rests it
// from that coin alone and the operator fronts no change beside it.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import * as seqob from '../../seqob.js'
import { ladderOf } from './leaf-maker-ladder.mjs'
import { makerRelayKey } from './trade-report.mjs'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const hex = (b) => Buffer.from(b).toString('hex')
const DONE = new Set(['filled', 'cancelled', 'expired', 'refunded', 'landed', 'exited'])

// The size of each level of a pair's resting ladder, in atoms of `give`.
export function restSizes (p, cfg) {
  const lad = ladderOf(p, cfg)
  const first = lad.first || big(p.min_give || 0)
  if (first <= 0n) return []
  return Array.from({ length: lad.levels }, (_, k) => BigInt(Math.floor(Number(first) * Math.pow(lad.growth, k))))
}

// The order of level k: `size` atoms of give for the whole `want` it asks, at the pair's rate
// (want atoms per give atom, rate_num/rate_den) step_bps × k further from it. The order's own rate
// is want/size, so its price is a whole number of atoms, as an offer must state it.
export function restTerms (size, rate, stepBps, k) {
  const num = big(rate.rate_num) * BigInt(10000 + stepBps * k), den = big(rate.rate_den) * 10000n
  const want = ceilDiv(big(size) * num, den)
  return { amount: big(size), want, rate_num: want, rate_den: big(size) }
}

// The size to rest level `size` at again: the value its cancelled order's coin came back with
// (`back`, the order's value less the cancel's fee) when that is within a thousandth of the size,
// else the size. Resting the level at its own coin's value lets the library give up that coin and
// nothing else; at the full size the coin falls short by the fee, and the library takes a larger
// coin, whose change the operator fronts anew while the order rests beside it.
export const BACK_WITHIN = 1000n
export function restSize (size, back) {
  const s = big(size), b = big(back)
  return b > 0n && b <= s && b * BACK_WITHIN >= s * (BACK_WITHIN - 1n) ? b : s
}

// Whether an order rested at rate `r` (want per give) is more than `bps` off `now`.
export function offPrice (r, now, bps) {
  const a = Number(r.rate_num) / Number(r.rate_den), b = Number(now.rate_num) / Number(now.rate_den)
  return b > 0 && Math.abs(a / b - 1) * 10000 > Number(bps)
}

// Whether the feed's mid has moved through an order rested at rate `r` (want per give): it sells
// at or below mid * (1 + guardBps). `now` is the feed's rate with the maker's spread on it
// (rateFromPrices), so the mid is `now` without the spread.
export function throughMid (r, now, spreadBps, guardBps) {
  const a = Number(r.rate_num) / Number(r.rate_den)
  const mid = Number(now.rate_num) / Number(now.rate_den) / (1 + Number(spreadBps || 0) / 10000)
  return mid > 0 && a <= mid * (1 + Number(guardBps ?? 10) / 10000)
}

// Whether an order at rate `r` (want atoms per give atom) would cross, or come within guardBps of,
// the book's best bid for give in want (`bid`, in the same terms; 0 when there is none).
export function crossesBook (r, bid, guardBps) {
  const a = Number(r.rate_num) / Number(r.rate_den)
  return bid > 0 && a <= bid * (1 + Number(guardBps ?? 10) / 10000)
}

// The pair's combined best bid on the relay (its ticker), in atoms of `want` per atom of `give`.
async function bestBid (relay, give, want) {
  try {
    const r = await fetch(`${relay}/v1/market/${give}/${want}/ticker`, { signal: AbortSignal.timeout(10000) })
    const j = await r.json()
    return Number(j.best_bid) || 0
  } catch { return 0 }
}

// The offer that lists a resting order on the relay, from the operator's view of it.
export function restOffer (rec, served, op, nowUnix, marginSecs) {
  const t = served.terms || {}
  const refundBy = Number(t.expiry) - (marginSecs || 6 * 3600)
  const exitBy = served.expiry != null ? Number(served.expiry) - 3 * 86400 : Infinity
  const expires = Math.min(nowUnix + 7 * 86400 - 60, refundBy, exitBy)
  if (expires <= nowUnix + 600) return null
  return {
    offer_id: rec.offer_id, schema_version: 1, pair: { base_asset: served.asset, quote_asset: t.asset_b }, trade_dir: 'TRADE_DIR_SELL',
    base_amount: big(rec.amount).toString(), offer_amount: big(rec.amount).toString(), offer_asset: served.asset,
    want_amount: ((big(rec.amount) * big(t.rate_num)) / big(t.rate_den)).toString(), want_asset: t.asset_b,
    allow_partial: true, min_fill: String(t.min_lot), created_at_unix: String(nowUnix), expires_at_unix: String(expires),
    resting_leaf: { operator_url: op.server, operator_key: op.operator, order_id: served.order, asset_a: served.asset, asset_b: t.asset_b,
      rate_num: String(t.rate_num), rate_den: String(t.rate_den), min_lot: String(t.min_lot), landed_maker: t.maker,
      landed_expiry: Number(t.expiry), refund_key: t.refund_key, coin: served.coin, value: String(served.value) },
  }
}

// The orders the desk follows, read a command at a time, each command one read of the operator's
// (the library reads it a hundred orders at a time): the orders by their ids, and the desk's own as the
// library's store holds them (`brief`), not asked of the operator. A maker rests orders all day, and
// asking after every one it ever rested took thirty reads of the operator a command, seconds that a
// firm offer waited behind. A library without `brief` asks after them all, as before.
export const RESTING_PER_READ = 64
export const restingArgs = (ids) => ({ orders: [...ids], brief: true })

export async function restDesk ({ cfg, cmd, log, liveRates, spendable }) {
  const r = cfg.rest
  if (!r || !(r.pairs || []).length) return null
  const file = join(cfg.store_dir, 'rest-orders.json')
  let recs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(recs, null, 1)); renameSync(file + '.tmp', file) }
  // One key for the maker's listings, kept beside its store: the relay sees one maker.
  const { priv, pub: makerPub } = makerRelayKey(cfg.store_dir)
  const relay = r.relay || 'http://127.0.0.1:9955'
  let lastPass = 0

  async function tick () {
    if (Date.now() - lastPass < (r.interval_seconds ?? 60) * 1000) return
    lastPass = Date.now()
    seqob.setSeqobBase(relay)
    const info = await cmd('info')
    const op = { server: info.server, operator: info.operator }
    const margin = Number(((info.server_info || {}).fills || {}).order_margin_seconds || 0)
    const now = Math.floor(Date.now() / 1000)
    // What the library's store says of the orders it rested (restingArgs: its own as stored, not
    // asked of the operator), and what the operator says of each still followed, by its id.
    const ids0 = recs.filter((x) => x.order && !x.done).map((x) => x.order)
    const first = await cmd('order_resting', restingArgs(ids0.slice(0, RESTING_PER_READ)))
    const mine = first.orders || []
    let changed = false
    for (const rec of recs) {
      const m = mine.find((o) => o.rested_by === rec.rested_by)
      if (m && m.order && !rec.order) { rec.order = m.order }
      if (m && m.state === 'not_rested') { rec.done = 'not_rested' }
    }
    const ids = recs.filter((x) => x.order && !x.done).map((x) => x.order)
    const others = [...(first.others || [])]
    const asked = new Set(ids0.slice(0, RESTING_PER_READ))
    const rest = ids.filter((id) => !asked.has(id))
    for (let i = 0; i < rest.length; i += RESTING_PER_READ) others.push(...((await cmd('order_resting', restingArgs(rest.slice(i, i + RESTING_PER_READ)))).others || []))
    const listed = new Set()
    try { for (const o of (await seqob.fetchMyOrders(makerPub))) listed.add(o.offer_id || o.offerId) } catch {}
    const rates = liveRates()
    for (const rec of recs) {
      if (rec.done || !rec.order) continue
      const served = others.find((o) => o.order === rec.order)
      if (!served) continue
      if (DONE.has(served.state)) { rec.done = served.state; log('rest', rec.slot, rec.order.slice(0, 12), served.state); continue }
      if (served.state !== 'resting') continue
      const p = (r.pairs || []).find((x) => x.give + ':' + x.want === rec.slot.split('#')[0])
      const rate = p && (p.price ? rates.get(p.give + ':' + p.want) : p)
      // A level filled down to a small remainder is rested again at its whole size, as a level
      // filled whole is: what is left of it is too little for the trades it is there for.
      const low = big(served.value || 0) * 100n < big(rec.amount) * BigInt(r.refill_pct ?? 25)
      const through = p && p.price && rate && throughMid(rec, rate, (cfg.prices || {}).spread_bps, r.guard_bps)
      if ((rate && offPrice(rec, rate, r.reprice_bps ?? 300)) || through || low) {
        try {
          const q = await cmd('order_cancel_resting_quote', { order: rec.order })
          await cmd('order_cancel_resting', { order: rec.order, shown: q })
          // What its coin comes back with: the level is rested again from it, at that value.
          if (!low) rec.back = String(((q || {}).gets || {}).amount || '')
          try { await seqob.signAndCancel(rec.offer_id, priv, now) } catch {}
          rec.done = low ? 'refilled' : 'repriced'
          changed = true
          log('rest', rec.slot, rec.order.slice(0, 12), low ? `holds ${served.value} of ${rec.amount}: cancelled to be rested at its whole size` : through ? 'the feed\'s mid moved through it: cancelled to be rested at the feed\'s rate' : 'cancelled to be rested at the feed\'s rate')
        } catch (e) { log('rest cancel', rec.slot, e.message) }
        continue
      }
      // listed again when the relay has no live listing of it (a restart), or the listing is near its end
      const due = !listed.has(rec.offer_id) || !rec.relay_expires || Number(rec.relay_expires) - now < 3600 || rec.posted_coin !== served.coin
      if (!due) continue
      const offer = restOffer(rec, served, op, now, margin)
      if (!offer) continue
      try {
        offer.created_at_unix = String(now)
        await seqob.postRestingOffer(offer, priv)
        rec.relay_expires = Number(offer.expires_at_unix); rec.posted_coin = served.coin
        log('rest', rec.slot, rec.order.slice(0, 12), 'listed at the relay')
      } catch (e) {
        if (/already resting|already listed/i.test(e.message)) { rec.posted_coin = served.coin; rec.relay_expires = rec.relay_expires || now + 3600 } else log('rest post', rec.slot, e.message)
      }
    }
    // Levels with no live order are rested again, from coins spendable now.
    let made = 0
    const sp = await spendable()
    const med = now - 3600
    for (const p of r.pairs || []) {
      const rate = p.price ? rates.get(p.give + ':' + p.want) : p
      if (!rate) continue
      const lad = ladderOf(p, cfg)
      const sizes = restSizes(p, cfg)
      let bid = null
      for (let k = 0; k < sizes.length && made < (r.max_new_per_pass ?? 6); k++) {
        const slot = `${p.give}:${p.want}#${k}`
        if (recs.some((x) => x.slot === slot && !x.done)) continue
        // A level cancelled to be repriced is rested again at what its coin came back with.
        const prior = recs.filter((x) => x.slot === slot && x.done === 'repriced' && x.back && !x.reused).pop()
        const size = restSize(sizes[k], prior && prior.back)
        const t = restTerms(size, rate, lad.stepBps, k)
        if (bid === null) bid = await bestBid(relay, p.give, p.want)
        if (crossesBook(t, bid, r.guard_bps)) { log('rest', slot, `not rested: its rate would cross the book's best bid ${bid}`); continue }
        if ((sp.get(p.give) || 0n) < t.amount + big(cfg.fee_margin_rest || 0)) break
        const args = { sell: p.give, amount: t.amount.toString(), want: p.want, rate_num: t.rate_num.toString(), rate_den: t.rate_den.toString(),
          min_lot: String(t.amount / 100n > 0n ? t.amount / 100n : 1n), expiry: med + Math.floor((r.days ?? 7) * 86400) }
        try {
          const q = await cmd('order_rest_quote', args, true)
          const res = await cmd('order_rest', { ...args, shown: q }, true)
          recs.push({ slot, rested_by: res.order, order: null, offer_id: hex(randomBytes(16)), amount: t.amount.toString(),
            rate_num: t.rate_num.toString(), rate_den: t.rate_den.toString(), at: now })
          if (prior) prior.reused = true
          sp.set(p.give, (sp.get(p.give) || 0n) - t.amount)
          made++
          changed = true
          log('rest', slot, 'rested', t.amount.toString(), 'for', t.want.toString())
        } catch (e) { log('rest', slot, e.message); break }
      }
    }
    // keep the record short: what ended more than a day ago goes
    recs = recs.filter((x) => !x.done || now - (x.at || now) < 86400)
    save()
    return changed
  }

  return { tick, makerPub, records: () => recs }
}
