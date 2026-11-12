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
//  * rebuildOrder takes back such an order from what the person says they asked for in return.
//    Everything else is the wallet's or the chain's: the asset and amount locked (the output),
//    the maker key and payout (the wallet's key at an index), the lock (the median time or the
//    height a day after one of the blocks just below the funding), and the generation of asset
//    byte order. A candidate is accepted only when it derives the output's very script.
//
// Every read goes through `io.get(path)`: the parsed answer, or null for a 404 (the explorer's
// "not found"); anything else throws, and a thrown read decides nothing.

import { explorerScriptHash } from './explorer-script-hash.js'
import { planPlaceOrder } from './covenant-order.js'
import { computeRate, covenantMinLot, covenantDerivationIds, orderExpiry, orderExpiryTime, leafProductFits } from './covenant-flow.js'

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
//   known          Set of script hex the wallet accounts for (its own, its records', its payouts)
//   checked        optional { has(txid), add(txid) }: transactions already read with nothing left
export async function findUnrecordedLocks (io, { known, checked } = {}) {
  const out = []
  for (const { txid } of await io.ownSpends()) {
    if (checked && checked.has(txid)) continue
    const tx = await io.get(`/tx/${txid}`)
    if (!tx) continue
    let open = 0
    for (let n = 0; n < (tx.vout || []).length; n++) {
      const o = tx.vout[n], spk = lc(o.scriptpubkey)
      if (!/^5120[0-9a-f]{64}$/.test(spk) || o.value == null || !o.asset) continue
      if (known && known.has(spk)) continue
      const sp = await io.get(`/tx/${txid}/outspend/${n}`)
      if (sp && sp.spent) continue
      open++
      out.push({ txid, vout: n, spkHex: spk, asset: lc(o.asset), value: BigInt(o.value),
        height: tx.status && tx.status.confirmed ? Number(tx.status.block_height) : null,
        time: tx.status && tx.status.block_time ? Number(tx.status.block_time) : null })
    }
    if (!open && checked && tx.status && tx.status.confirmed) checked.add(txid)
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

// The record of the order locking `lock` ({ txid, vout, spkHex, asset (display), value }), if
// one of the candidates derives its script; else null.
//   receive   display ids of the asset asked for (one, or every asset the wallet knows)
//   recvAtoms what the person says they asked for, in atoms (the amount and its neighbours)
//   makers    [{ index, program, internalKey }]: the wallet's maker keys
//   expiries  from expiryCandidates
// About half a millisecond a candidate: one asset, three amounts, fifteen keys and the 75 locks
// take a few seconds; the search yields to the page as it goes.
export async function rebuildOrder ({ lock, receive, recvAtoms, makers, expiries }) {
  const spk = lc(lock.spkHex), sell = BigInt(lock.value), minLot = covenantMinLot(sell)
  let tried = 0
  for (const idsInternal of [true, false]) {
    for (const b of receive) {
      if (lc(b) === lc(lock.asset)) continue
      for (const recv of recvAtoms) {
        if (BigInt(recv) < 1n) continue
        const { rateNum, rateDen } = computeRate(sell, BigInt(recv))
        if (!leafProductFits(sell, rateNum, rateDen)) continue
        for (const m of makers) {
          for (const expiry of expiries) {
            if (++tried % 250 === 0) await new Promise((r) => setTimeout(r, 0))   // the page stays responsive
            let plan
            try {
              plan = planPlaceOrder({ ...covenantDerivationIds(lc(lock.asset), lc(b), idsInternal), sellAtoms: sell,
                rateNum, rateDen, minLot, expiryLocktime: expiry, makerProg: m.program, makerX: m.internalKey })
            } catch { continue }
            if (lc(plan.spkHex) !== spk) continue
            return {
              offerId: null, pay: lc(lock.asset), receive: lc(b),
              sellAtoms: String(sell), recvAtoms: String(BigInt(recv)),
              makerIndex: m.index, covTxid: lock.txid, covVout: lock.vout, spkHex: spk,
              expiry, created: Date.now(), posted: false, idsInternal, recovered: true,
            }
          }
        }
      }
    }
  }
  return null
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
