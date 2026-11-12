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
// The longest a payment waits to be made after its review: the longest leaves.js waits for a
// round (RELEASE_WAIT_MS).
export const PENDING_MOST_MS = 3 * 3600_000

const keyOf = (tag) => PENDING_SENDS_KEY + '.' + tag

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
  return { resume, dropped }
}
