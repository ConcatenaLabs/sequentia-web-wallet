// Buying a restricted asset with bitcoin as one trade. Bitcoin buys an asset X that the book
// trades for the restricted asset R; the wallet shows one ticket (the bitcoin paid, the R received,
// every fee) and asks for one confirmation. The first step is the engine's own bitcoin purchase of
// X; once it has settled, the second step trades that X for R on the chain under R's policy server
// (restricted-engine.js), at terms giving at least the R the ticket showed. When the second step
// cannot go (no offer at those terms, a refusal), the person is told what they now hold, and the
// step is tried again by itself until COMPOSED_SECOND_MS have passed since the first settled.
//
// The composed trade keeps a record of its own (source 'composed'); each step keeps the engine's
// usual record, marked `partOf` the composed one, and is followed as any trade is. The Trade tab
// shows the composed record; History shows the steps, which are what moved.

import { restrictedQuote } from './restricted-engine.js'

export const COMPOSED_SECOND_MS = 24 * 3600_000
// The second step is asked for at most this often while it cannot go.
export const COMPOSED_RETRY_MS = 60_000

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The composed ticket for paying `amount` sats for `receiveAsset` (restricted), through the first of
// `vias` that prices both steps. `quoteFirst(via)` is the engine's own quote of bitcoin for `via`;
// `drop(choice)` lets go of a firm first step that is not used.
// -> { ok: true, ticket, choice, moving } | { ok: false, first } (no via priced both steps; `first`:
//    the last first step's answer when it was refused, else null)
export async function composedQuote (R, { receiveAsset, vias, quoteFirst, drop }) {
  let first = null
  for (const via of vias || []) {
    const q1 = await quoteFirst(via)
    if (!q1 || !q1.ok) { first = q1 || first; continue }
    first = null
    const got = big(q1.ticket.amountOut)
    // The second step pays its fee from the X the first brings, when its fee is in X.
    const feeAsset = await R.feeAsset(via, receiveAsset)
    const fee = feeAsset === via ? big(await R.fee(via)) : 0n
    const q2 = got > fee ? await restrictedQuote(R, { payAsset: via, receiveAsset, amount: got - fee, arriving: got }).catch(() => null) : null
    if (!q2 || !q2.ok) { drop(q1.choice); continue }
    const spent = big(q2.ticket.amountIn) + (feeAsset === via ? big(q2.choice.fee) : 0n)
    const keep = got - spent
    const ticket = { payAsset: 'BTC', receiveAsset, amountIn: q1.ticket.amountIn, amountOut: q2.ticket.amountOut,
      fees: [...(q1.ticket.fees || []), ...(q2.ticket.fees || [])], source: 'composed', via,
      ...(keep > 0n ? { keep: String(keep) } : {}) }
    return { ok: true, ticket, moving: !!q1.moving,
      choice: { source: 'composed', first: q1.choice, firstTicket: q1.ticket, via, viaAtoms: String(got - fee) } }
  }
  return { ok: false, first }
}

// Moves a composed trade on. `E`: the engine's own pieces:
//   records() put(rec) now() confirm(choice, ticket, extra) -> the step's record (throws on a refusal)
// -> the composed record.
export async function composedAdvance (R, rec, E) {
  const all = E.records()
  const step = (id) => (id ? all.find((r) => r.id === id) || null : null)
  // A page closed between the composed record and its first step: the step is the one marked as its.
  if (!rec.first) {
    const one = all.find((r) => r.partOf === rec.id)
    if (one) rec.first = one.id
    else if (E.now() - (rec.at || 0) >= 10 * 60_000) { rec.state = 'failed'; rec.error = 'the first step was never made' }
    return E.put(rec)
  }
  const one = step(rec.first)
  if (!one) return E.put(rec)
  if (!rec.firstSettledAt) {
    // Until its first step settles, the trade is where that step is: waiting for the other side,
    // or sent.
    if (['sent', 'waiting'].includes(one.state) && rec.state !== one.state) {
      rec.state = one.state; rec.sentAt = rec.sentAt || E.now()
      if (one.state === 'waiting') rec.waitingSince = rec.waitingSince || E.now()
    }
    // The first step came back: nothing of the wallet's moved for good, so nor did the trade.
    if (['returned', 'failed', 'undone'].includes(one.state)) {
      rec.state = 'returned'; rec.returnedAt = E.now(); rec.error = one.error || null
      if ((one.feesPaid || []).length) rec.feesPaid = one.feesPaid
      return E.put(rec)
    }
    if (one.state !== 'settled') return E.put(rec)
    rec.firstSettledAt = E.now(); rec.state = 'sent'
  }
  const two = step(rec.second)
  if (two) {
    if (two.state === 'settled') { rec.state = 'settled'; rec.settledAt = E.now(); rec.viaHeld = false; return E.put(rec) }
    if (!['returned', 'failed', 'undone'].includes(two.state)) return E.put(rec)
    // The second step moved nothing: the X is still the wallet's, and the step is tried again.
    rec.second = null; rec.viaHeld = true
  }
  if (E.now() - rec.firstSettledAt >= COMPOSED_SECOND_MS) {
    // The first step's X stays the wallet's: the trade ends there, and says so.
    rec.state = 'settled'; rec.settledAt = E.now(); rec.viaHeld = true; rec.ended = 'via'
    return E.put(rec)
  }
  if (rec.secondTriedAt && E.now() - rec.secondTriedAt < COMPOSED_RETRY_MS) return E.put(rec)
  rec.secondTriedAt = E.now()
  const q = await restrictedQuote(R, { payAsset: rec.via, receiveAsset: rec.ticket.receiveAsset, amount: big(rec.viaAtoms) }).catch(() => null)
  // Only at terms giving at least what the ticket showed.
  if (!q || !q.ok || big(q.ticket.amountOut) < big(rec.ticket.amountOut)) { rec.viaHeld = true; return E.put(rec) }
  E.put(rec)
  try {
    const r2 = await E.confirm(q.choice, q.ticket, { partOf: rec.id })
    rec.second = r2.id; rec.viaHeld = false
  } catch (e) {
    // Refused before anything moved (its own record says so): the X is still the wallet's.
    rec.viaHeld = true; rec.secondError = e && e.message
  }
  return E.put(rec)
}

// The record of a composed trade's step, which the Trade tab and its notices leave to the composed
// record.
export const isStep = (r) => !!(r && r.partOf)
