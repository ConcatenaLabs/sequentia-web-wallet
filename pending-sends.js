// A payment in the tree that waits for its coins to settle first (leaves.js paying: a receive code's
// `send`, an address's `offboard`) is written down while it waits, so that a page closed meanwhile
// makes it when the wallet is next open, once and only once.
//
// Each record is { id, kind: 'code' | 'address', asset, atoms, to, shown?, at, state }. Its state is
// what the library was last told (leaves.js `stage`): 'asking' while the library is asked to pay it
// (it may sign), 'waiting' after an answer that signed nothing (it waits for a round). A page that
// opens finds:
//   - 'waiting': nothing of it was signed: asked again (resumable);
//   - 'asking': the page closed while the library was being asked, and it may have paid: never
//     asked again (dropped, and said in the console); what it became shows in Balance and Activity
//     as any payment's does.
// A record ends (is removed) once the payment is made or refused, and lapses after PENDING_MOST_MS.

export const PENDING_SENDS_KEY = 'swk.leaves.pendingSends'
// The ends of payments made after the page was closed that did not go (refused, lapsed), or that
// the page cannot tell went (closed while the library was asked): each said once, on Balance.
export const PENDING_ENDS_KEY = 'swk.leaves.pendingEnds'
// The longest a payment waits to be made after its review: the longest leaves.js waits for a
// round (RELEASE_WAIT_MS).
export const PENDING_MOST_MS = 3 * 3600_000

const keyOf = (tag) => PENDING_SENDS_KEY + '.' + tag
const endsKey = (tag) => PENDING_ENDS_KEY + '.' + tag

export function pendingSends (store, tag) {
  try { const v = JSON.parse(store.getItem(keyOf(tag)) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function save (store, tag, list) {
  try { if (list.length) store.setItem(keyOf(tag), JSON.stringify(list)); else if (store.removeItem) store.removeItem(keyOf(tag)); else store.setItem(keyOf(tag), '[]') } catch {}
}
export function putPending (store, tag, rec) {
  const list = pendingSends(store, tag).filter((r) => r.id !== rec.id)
  list.push(rec)
  save(store, tag, list)
  return rec
}
export function dropPending (store, tag, id) {
  save(store, tag, pendingSends(store, tag).filter((r) => r.id !== id))
}
// The stage hook leaves.js calls (payCode / offboard `stage`): writes each stage of `rec` down
// before the library is asked, so a page that closes then finds it as it was.
export function stageWriter (store, tag, rec) {
  return (stage) => { rec.state = stage; putPending(store, tag, rec) }
}
// What a page that opens does with the records it finds, at `nowMs`: the ones it asks again
// (`resume`, kept in the store until they end), and the ones it drops (`dropped`, each with why:
// 'asking' or 'lapsed', removed from the store here).
export function takePending (store, tag, nowMs = Date.now()) {
  const resume = [], dropped = []
  for (const r of pendingSends(store, tag)) {
    if (!r || !r.id) continue
    if (nowMs - Number(r.at || 0) > PENDING_MOST_MS) dropped.push({ ...r, why: 'lapsed' })
    else if (r.state === 'waiting') resume.push(r)
    else dropped.push({ ...r, why: 'asking' })
  }
  save(store, tag, resume)
  for (const d of dropped) noteEnd(store, tag, d, d.why === 'asking' ? 'unknown' : 'lapsed', nowMs)
  return { resume, dropped }
}

// The same payment (asset, amount, recipient) written down and not ended: a second one asked
// while it is open would pay it twice. -> the record, or null.
export function samePending (store, tag, { asset, atoms, to }) {
  return pendingSends(store, tag).find((r) => r.asset === asset && String(r.atoms) === String(atoms) && r.to === to) || null
}

// The ends to say: `why` is 'refused' or 'lapsed' (nothing left the wallet), or 'unknown' (the
// page closed while the library was asked; it may have gone).
export function pendingEnds (store, tag) {
  try { const v = JSON.parse(store.getItem(endsKey(tag)) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
export function noteEnd (store, tag, rec, why, nowMs = Date.now()) {
  const list = pendingEnds(store, tag).filter((e) => e.id !== rec.id)
  list.push({ id: rec.id, kind: rec.kind, asset: rec.asset, atoms: String(rec.atoms), to: rec.to, why, at: nowMs })
  try { store.setItem(endsKey(tag), JSON.stringify(list.slice(-20))) } catch {}
}
export function markEndTold (store, tag, id) {
  const list = pendingEnds(store, tag).filter((e) => e.id !== id)
  try { if (list.length) store.setItem(endsKey(tag), JSON.stringify(list)); else if (store.removeItem) store.removeItem(endsKey(tag)); else store.setItem(endsKey(tag), '[]') } catch {}
}
