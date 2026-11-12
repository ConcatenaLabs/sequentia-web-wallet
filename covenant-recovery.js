// covenant-recovery.js: where a resting order's coins are, when its record does not say, and how
// the wallet takes back an order whose record is gone.
//
// A resting covenant order's record (swap.js PLACED) is the only copy of its terms until the
// order is listed: the price and the asset asked for are inside the covenant script's taproot
// commitment, which the chain shows only as a hash. So:
//
//  * locateFunding finds the order's output on the chain for a record written before its funding
//    transaction's id was known, and says the funding never landed only when two different reads
//    agree: the explorer's index of the order's script (its coins and its history, the mempool
//    included), and then either the funding transaction asked for by its id (records written
//    since that id is kept before the broadcast) or the wallet's own history (older records).
//    One empty answer is never enough, and the page asks twice, ten minutes apart, before it
//    puts such a record away (it is archived, never deleted).
//
//  * findUnrecordedLocks lists what the wallet paid to a taproot script it has no record of and
//    that is still there: an order whose record is gone looks exactly like that (so does a
//    payment to someone's taproot address; the wallet cannot tell them apart until terms match).
//
//  * ordersFromNotes rebuilds an order exactly from the note the wallet wrote to itself in the
//    order's funding transaction (order-note.js): every order placed with a note comes back from
//    the phrase alone, filled in part or not, listed or not.
//
//  * searchOrder takes back an order without a note: first from terms the page derives itself (the
//    market's prices around the funding), then from what the person says they asked for in
//    return, exactly or within a range. Everything else is the wallet's or the chain's: the asset and amount locked (the output),
//    the maker key and payout (the wallet's key at an index), the lock (the median time or the
//    height a day after one of the blocks just below the funding), and the generation of asset
//    byte order. A candidate is accepted only when it derives the output's very script.
//
// Every read goes through `io.get(path)`: the parsed answer, or null for a 404 (the explorer's
// "not found"); anything else throws, and a thrown read decides nothing.

import { explorerScriptHash } from './explorer-script-hash.js'
import { computeRate, covenantMinLot, covenantDerivationIds, orderExpiry, orderExpiryTime, leafProductFits, isTimeLock } from './covenant-flow.js'
import { spkMatcher, leafHash, buildFillLeaf, buildRefundLeaf } from './covenant.js'
import { noteOfScript } from './order-note.js'

export const FUNDING_GRACE_MS = 10 * 60 * 1000      // a record younger than this may still be funding
export const ABSENT_RECHECK_MS = 10 * 60 * 1000     // a funding seen absent is put away only when absent again this much later
export const PLACEMENT_TIP_DEPTH = 15               // the tips an order may have been placed at, below its funding's block
export const PLACEMENT_HEIGHT_DEPTH = 60             // the same for a height lock, read from the wallet's own (later) tip

const lc = (h) => String(h || '').toLowerCase()
const voutPaying = (tx, spk) => (tx && Array.isArray(tx.vout) ? tx.vout.findIndex((o) => lc(o.scriptpubkey) === spk) : -1)

// Where the order of `rec` rests, or that its funding never landed.
//   -> { found: { txid, vout } }   the output (unspent, or already spent by a fill or a refund)
//   -> { absent: true }            both reads say no funding exists, in a block or in the mempool
//   -> { wait: why }               too young, or a read could not tell
// io.ownPayment(spk, sinceMs) -> { txid, vout } | null: the wallet's own transactions since then
// that pay `spk` (throws when the wallet cannot tell yet). Used for records without `fundTxid`.
export async function locateFunding (rec, io, now = Date.now()) {
  const spk = lc(rec.spkHex)
  if (!spk) return { wait: 'no script' }
  const id = await explorerScriptHash(spk)
  const coins = await io.get(`/scripthash/${id}/utxo`)
  if (Array.isArray(coins) && coins.length) {
    const c = coins.find((u) => String(u.value) === String(rec.sellAtoms)) || coins[0]
    return { found: { txid: c.txid, vout: Number(c.vout) } }
  }
  const hist = await io.get(`/scripthash/${id}/txs`)
  for (const tx of Array.isArray(hist) ? hist : []) {
    const v = voutPaying(tx, spk)
    if (v >= 0) return { found: { txid: tx.txid, vout: v } }
  }
  if (now - Number(rec.created || 0) < FUNDING_GRACE_MS) return { wait: 'young' }
  if (rec.fundTxid) {
    const st = await io.get(`/tx/${rec.fundTxid}/status`)
    if (st) {
      const tx = await io.get(`/tx/${rec.fundTxid}`)
      const v = voutPaying(tx, spk)
      return v >= 0 ? { found: { txid: rec.fundTxid, vout: v } } : { wait: 'its funding pays another script' }
    }
  } else {
    if (!io.ownPayment) return { wait: 'no second read' }
    const own = await io.ownPayment(spk, Number(rec.created || 0))
    if (own) return { found: own }
  }
  return { absent: true }
}

// Where an order's coin rests now, read from the chain by its script: a fill spends the coin and
// rests what is left at the same script in the fill's transaction, so a record's first outpoint
// says nothing about the coin after a fill.
// Only an explicit coin of the asset the order locked is the order's: the script is public, so
// anyone can pay a coin of another asset, or a blinded one, to it, and the refund cannot take
// those (web wallet #723).
//   -> { coin: { txid, vout, value, confirmed } }  what rests now (the largest, if several)
//   -> { done: true, settled }                     nothing rests: filled whole or taken back;
//                                                  settled only once every spend is in a block
//   -> { none: true }                              the script has no history at all
export async function restingCoin (rec, io) {
  const id = await explorerScriptHash(lc(rec.spkHex))
  const coins = await io.get(`/scripthash/${id}/utxo`)
  const own = (Array.isArray(coins) ? coins : []).filter((c) =>
    c && c.asset && lc(c.asset) === lc(rec.pay) && c.value != null && /^\d+$/.test(String(c.value)))
  if (own.length) {
    const c = own.reduce((a, b) => (BigInt(b.value) > BigInt(a.value) ? b : a))
    return { coin: { txid: c.txid, vout: Number(c.vout), value: BigInt(c.value), confirmed: !!(c.status && c.status.confirmed) } }
  }
  const hist = await io.get(`/scripthash/${id}/txs`)
  const txs = Array.isArray(hist) ? hist : []
  if (!txs.length) return { none: true }
  return { done: true, settled: txs.every((t) => t.status && t.status.confirmed) }
}

// What the page does with a record after locateFunding: fill in its outpoint, note a first
// absence, or say it is to be archived (absent again at least ABSENT_RECHECK_MS later).
//   -> 'found' | 'noted' | 'archive' | 'wait'
export function applyLocate (rec, res, now = Date.now()) {
  if (res && res.found) {
    rec.covTxid = res.found.txid; rec.covVout = res.found.vout; delete rec.absentAt
    return 'found'
  }
  if (res && res.absent) {
    if (!rec.absentAt) { rec.absentAt = now; return 'noted' }
    return now - Number(rec.absentAt) >= ABSENT_RECHECK_MS ? 'archive' : 'wait'
  }
  return 'wait'
}

// The outputs this wallet paid to a taproot script it holds no record of, still unspent.
//   io.ownSpends() -> [{ txid }]   the wallet's transactions that spent its coins
//   known          Set of script hex the wallet's records account for now (not listed, but a
//                  transaction paying one is read again next time: the record may go)
//   stable         Set of script hex the wallet derives itself (its addresses, its order payouts)
//   checked        optional { has(txid), add(txid) }: transactions with no taproot output but
//                  ones in `stable`, which can never need listing; nothing else is remembered
export async function findUnrecordedLocks (io, { known, stable, checked } = {}) {
  const out = []
  for (const { txid } of await io.ownSpends()) {
    if (checked && checked.has(txid)) continue
    const tx = await io.get(`/tx/${txid}`)
    if (!tx) continue
    let open = 0
    for (let n = 0; n < (tx.vout || []).length; n++) {
      const o = tx.vout[n], spk = lc(o.scriptpubkey)
      if (!/^5120[0-9a-f]{64}$/.test(spk) || o.value == null || !o.asset) continue
      if (stable && stable.has(spk)) continue
      open++
      if (known && known.has(spk)) continue
      const sp = await io.get(`/tx/${txid}/outspend/${n}`)
      if (sp && sp.spent) continue   // spent now (a block or the mempool); read again next time
      out.push({ txid, vout: n, spkHex: spk, asset: lc(o.asset), value: BigInt(o.value),
        height: tx.status && tx.status.confirmed ? Number(tx.status.block_height) : null,
        time: tx.status && tx.status.block_time ? Number(tx.status.block_time) : null })
    }
    if (!open && checked) checked.add(txid)
  }
  return out
}

// The orders the wallet's notes rebuild (order-note.js). For each transaction the wallet paid from
// that carries a note, the note's terms are tried against every taproot output beside it; an order
// is kept only when they derive that output's very script. A part-filled order rests at the same
// script, so its funding output (spent by the fill) still rebuilds it: `sellAtoms` is what the
// funding locked, and restingCoin says where its coin is now.
//   io             as for findUnrecordedLocks
//   open(noteHex)  -> terms | null: order-note.js openNote under the wallet's note key
//   makerAt(index) -> { index, program, internalKey }: the wallet's maker key at that index
//   known          Set of script hex the wallet's records (kept or archived) account for
//   checked        optional { has(txid), add(txid) }: transactions without a note, never read again.
//                  A transaction with a note is read each time, whatever explains its outputs now:
//                  the record that does may go, and the note is then what rebuilds the order.
// A read that fails skips its transaction only: it is left unchecked, so the next scan asks again,
// and what this scan found is kept.
// -> [rec], each with the funding's outpoint in covTxid/covVout and fundTxid
export async function ordersFromNotes (io, { open, makerAt, known, checked } = {}) {
  const out = []
  for (const { txid } of await io.ownSpends()) {
    if (checked && checked.has(txid)) continue
    try {
      const tx = await io.get(`/tx/${txid}`)
      if (!tx) continue
      const vout = Array.isArray(tx.vout) ? tx.vout : []
      const notes = vout.map((o) => noteOfScript(o.scriptpubkey)).filter(Boolean)
      if (!notes.length) { if (checked) checked.add(txid); continue }
      const locks = []
      vout.forEach((o, n) => {
        const spk = lc(o.scriptpubkey)
        if (/^5120[0-9a-f]{64}$/.test(spk) && o.value != null && o.asset && !(known && known.has(spk))) {
          locks.push({ txid, vout: n, spkHex: spk, asset: lc(o.asset), value: BigInt(o.value) })
        }
      })
      for (const note of notes) {
        if (!locks.length) break
        const terms = await open(note)
        if (!terms) continue
        let m
        try { m = makerAt(terms.makerIndex) } catch { continue }
        for (let i = 0; i < locks.length; i++) {
          const res = await searchOrder({ lock: locks[i], candidates: [{ asset: terms.receive, recv: terms.recvAtoms }], makers: [m], expiries: [terms.expiry] })
          if (!res.rec) continue
          out.push({ ...res.rec, fundTxid: txid, fromNote: true })
          locks.splice(i, 1)
          break
        }
      }
    } catch { /* this transaction is read again next time */ }
  }
  return out
}

// The refund locks an order funded at `height` (null: not in a block yet) can carry: a day after
// the median time of one of the blocks just below it (the page reads the explorer's tip when it
// places an order), or a day of blocks after one of the heights below it (the wallet's own tip,
// when no median time could be read).
export async function expiryCandidates (io, height) {
  const tip = Number(await io.get('/blocks/tip/height'))
  const top = (height == null ? tip + 1 : Number(height)) - 1
  const times = new Set(), heights = new Set()
  for (let h = top; h >= Math.max(1, top - PLACEMENT_TIP_DEPTH + 1); h--) {
    const hash = await io.get(`/block-height/${h}`)
    const b = hash ? await io.get(`/block/${String(hash).trim()}`) : null
    const mt = b && Number(b.mediantime)
    if (mt > 0) times.add(orderExpiryTime(mt))
  }
  for (let h = top; h >= Math.max(1, top - PLACEMENT_HEIGHT_DEPTH + 1); h--) heights.add(orderExpiry(h))
  return [...times, ...heights]
}

// The record of the order locking `lock` ({ txid, vout, spkHex, asset (display), value }), found
// among candidate terms; null when none derives its script.
//   candidates [{ asset (display id asked for), recv (atoms) }], likeliest first
//   makers     [{ index, program, internalKey }]: the wallet's maker keys, likeliest first
//   expiries   from expiryCandidates (median-time locks first, then heights)
//   budgetMs   stop looking after this long (the answer is then { rec: null, complete: false })
// Each candidate costs about 0.2 ms (spkMatcher): its fill leaf once per key, then one root and one
// multiplication of the base point per lock. The search runs in passes, likeliest first: the asset
// byte order of every order placed since that fix and median-time locks; then height locks; then
// the older byte order. It yields to the page at least every SLICE_MS of work, however slow the
// device, and stops once budgetMs has passed.
export const SLICE_MS = 12
export async function searchOrder ({ lock, candidates, makers, expiries, budgetMs = 60_000, now = () => Date.now(),
  pause = () => new Promise((resolve) => setTimeout(resolve, 0)) }) {
  const spk = lc(lock.spkHex), sell = BigInt(lock.value), minLot = covenantMinLot(sell)
  const matches = spkMatcher(spk)
  const times = expiries.filter((e) => isTimeLock(e)), heights = expiries.filter((e) => !isTimeLock(e))
  const refundH = new Map()   // `${index}:${expiry}` -> leaf hash
  const refund = (m, e) => { const k = m.index + ':' + e; let h = refundH.get(k); if (!h) { h = leafHash(buildRefundLeaf(e, m.internalKey)); refundH.set(k, h) } return h }
  const t0 = now(); let tried = 0, sliceAt = t0
  for (const [idsInternal, locks] of [[true, times], [true, heights], [false, expiries]]) {
    if (!locks.length) continue
    for (const c of candidates) {
      if (lc(c.asset) === lc(lock.asset) || BigInt(c.recv) < 1n) continue
      const { rateNum, rateDen } = computeRate(sell, BigInt(c.recv))
      if (!leafProductFits(sell, rateNum, rateDen)) continue
      const ids = covenantDerivationIds(lc(lock.asset), lc(c.asset), idsInternal)
      for (const m of makers) {
        let fillH
        try { fillH = leafHash(buildFillLeaf(ids.assetA, ids.assetB, rateNum, rateDen, minLot, m.program, 1)) } catch { continue }
        for (const expiry of locks) {
          tried++
          const t = now()
          if (t - sliceAt >= SLICE_MS) {
            if (t - t0 > budgetMs) return { rec: null, complete: false, tried }
            await pause()   // the page stays responsive
            sliceAt = now()
          }
          if (!matches(fillH, refund(m, expiry))) continue
          return { tried, complete: true, rec: {
            offerId: null, pay: lc(lock.asset), receive: lc(c.asset),
            sellAtoms: String(sell), recvAtoms: String(BigInt(c.recv)),
            makerIndex: m.index, covTxid: lock.txid, covVout: lock.vout, spkHex: spk,
            expiry, created: Date.now(), posted: false, idsInternal, recovered: true,
          } }
        }
      }
    }
  }
  return { rec: null, complete: true, tried }
}

// rebuildOrder: searchOrder over every asset in `receive` with every amount in `recvAtoms`.
export async function rebuildOrder ({ lock, receive, recvAtoms, makers, expiries, budgetMs }) {
  const candidates = []
  for (const asset of receive) for (const recv of recvAtoms) candidates.push({ asset, recv })
  return (await searchOrder({ lock, candidates, makers, expiries, budgetMs })).rec
}

// The amounts asked for that an order placed at one of `ratios` (atoms of the asked asset per atom
// locked: the market's trades around the funding, its book) could carry, as the composer makes
// them: the price itself, the price and its inverse rounded to one to four significant digits, and
// the amount received rounded the same way, each rounded to an atom down, to the nearest, and up.
export function amountsFromRatios (sell, ratios, precLock, precAsked) {
  const out = new Map(), S = Number(sell), scale = Math.pow(10, Number(precAsked) - Number(precLock))
  const add = (x) => { if (!(x > 0) || !Number.isFinite(x)) return; for (const f of [Math.floor, Math.round, Math.ceil]) { const a = f(x); if (a >= 1) out.set(String(a), BigInt(a)) } }
  const sig = (x, d) => Number(x.toPrecision(d))
  for (const r of ratios) {
    if (!(r > 0) || !Number.isFinite(r)) continue
    add(S * r)
    const p = r / scale   // the price in whole units of the asked asset per whole unit locked
    for (let d = 1; d <= 4; d++) {
      add(S * sig(p, d) * scale)
      add(S * scale / sig(1 / p, d))
      const recvUnits = S * r / Math.pow(10, Number(precAsked))
      add(sig(recvUnits, d) * Math.pow(10, Number(precAsked)))
    }
  }
  return [...out.values()]
}

// The amounts within `pct` percent of `amountText` (in the asset's precision), nearest first. When
// there are more than `cap` of them, only the roundest: amounts on the finest step that keeps them
// within `cap` (a person who does not remember an amount exactly remembers a round one).
export function amountsInRange (amountText, pct, precision, cap = 2000) {
  const c = recvCandidates(amountText, precision)[0]
  if (!c) return []
  const p = Math.max(0, Number(pct) || 0)
  const span = BigInt(Math.floor(Number(c) * p / 100))
  const lo = c - span > 0n ? c - span : 1n, hi = c + span
  let step = 1n
  while ((hi - lo) / step + 1n > BigInt(cap)) step *= 10n
  const out = new Set([c])
  for (let a = ((lo + step - 1n) / step) * step; a <= hi; a += step) out.add(a)
  for (const a of [c - 1n, c + 1n]) if (a > 0n) out.add(a)
  const d = (a) => (a > c ? a - c : c - a)
  return [...out].sort((a, b) => (d(a) < d(b) ? -1 : d(a) > d(b) ? 1 : 0))
}

// The atoms a person's "I asked for N" can mean: N as written in the asset's precision, and the
// atom either side (a price typed in the composer can round either way).
export function recvCandidates (amountText, precision) {
  const s = String(amountText || '').trim().replace(/,/g, '')
  if (!/^\d*(\.\d*)?$/.test(s) || !/\d/.test(s)) return []
  const [i, f = ''] = s.split('.')
  const p = Number(precision) || 0
  if (f.length > p && /[1-9]/.test(f.slice(p))) return []
  const atoms = BigInt((i || '0') + f.slice(0, p).padEnd(p, '0'))
  return [atoms, atoms - 1n, atoms + 1n].filter((a) => a > 0n)
}
