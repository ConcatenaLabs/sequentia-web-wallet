// LEAVES: coins held as leaves of an operator's tree, and the wallet's mode.
//
// The mode is one setting, kept for each wallet, user mode until the user changes it.
// User mode is one figure per asset, and the wallet chooses how value moves. Developer
// mode names every rail side by side (on-chain, leaves, Lightning), each with its
// balance and its manual controls, and shows the developer tools: the Leaves tab and the
// Contracts tab. In developer mode the Leaves tab lets each step be taken by hand:
// boarding an on-chain coin into the operator's tree, a receive request and a payment
// to one, the mailbox (read by sync), "settle now" (a refresh into the next round,
// followed to its new leaf), and the exit drill (one leaf taken on-chain by the wallet
// alone, every step and fee shown before it is broadcast, until its claim is final); a
// board, too, shows its fee before it is signed. Every leaf shows its dates
// and the schedule sync keeps for it.
//
// A wallet that joined an operator keeps its leaf wallet open and syncing on the
// library's schedule while the page is open, in either mode: its coins must be
// refreshed or taken home on their dates. In user mode nothing of leaves is shown or
// reachable; their value counts in each asset's one figure and in the headline.
//
// What the wallet does by itself, in either mode, is the library's `care`, then a read
// and a watch of the operator's bond: after a sync, at most every ten minutes and at the
// first sync after the page opens, once the page shows what the wallet holds and never
// ahead of a command or a payment a person asked for, which it waits for (in user mode on the
// page's operator, the bond's watch, which can hold the wallet for most of a minute, runs at most
// hourly and only after two quiet minutes). Care takes up
// every open claim named for one of the wallet's receive keys (scanning the addresses
// the kit handed out and 20 more), cancels each refresh plan whose coin has moved, and
// signs a plan for every leaf of a round at once (`plan_within`: PLAN_EVERY_ROUND_LEAF),
// so that a wallet closed across that coin's expiry keeps it, whenever it closes. A coin
// received or boarded out of round is refreshed into a round first once its refresh
// could run within ten days, since that refresh costs a fee; it is free to pay until
// then. A planned coin is paid out of round by no wallet, so a payment the unplanned
// coins cannot cover is paid through the next round, by itself: the library refuses it
// naming the planned coins whose release covers it (kind `planned`), the wallet gives
// those up in the next round (`plan_release`) for leaves of its own no plan names, syncs
// until that round is final, and asks again. The person waits one round and sees
// nothing else. Developer mode lists distributions, claims and plans, marks each planned
// leaf, and has Cancel, and Release (`plan_release` of the plan's current leaf).
//
// Nothing about a leaf is computed here. The operator wallet library runs in a
// dedicated worker (leaves/worker.js, its wasm in leaves/pkg): every script, record,
// check, store write, fee and refusal is the library's. This module asks it, shows what
// it answers, and shows every refusal in the library's own words.
//
// Everything outside the worker is injected, so the module runs under Node with a fake
// worker (leaves.test.mjs).
//
// ctx:
//   makeWorker()        -> a Worker-like object (postMessage, onmessage, onerror)
//   store               localStorage-alike
//   walletTag()         the wallet's tag (what is kept for each wallet is keyed by it)
//   mnemonic()          the wallet's phrase
//   el(tag, cls, text)  builds a node; text is set as text, never markup
//   assetMeta(hex)      -> { ticker, precision }
//   fmtAtoms(atoms, precision) -> a decimal string
//   refValueStr(key, atoms) -> '≈ $1.23' or ''   (key 'BTC' or an asset hex)
//   btcOnchain()        -> BigInt sats on the Bitcoin side
//   lnFor(kind)         -> BigInt atoms on Lightning ('BTC' or an asset hex)
//   onChange()          called when leaf balances change (the Balance tab re-renders)
//   onModeChange(mode)  called when the user changes the mode
//   onEvent(name, data) the leaf events: 'leafArrived', 'leafSyncDue'
//   askFaucet(body)     optional: asks the testnet faucet to pay a receive request as a leaf
//                       ({ request, asset? }); answers the faucet's JSON or throws its error
//   claimScan()         optional: how many receive keys `care` looks for claims under
//                       (the kit wallet's next receive index and 20 more)
//   careEveryMs         optional: how often `care` runs at most (default CARE_EVERY_MS)
//   now()               optional clock, ms
//   tickMs              optional: how often the schedule is read (default 60 s)
//   pinned()            optional: the page's operator ({ server, node_url, operator }, the key
//                       pinned), which a wallet in user mode joins by itself (default-arca.js)
//   serverInfo(server)  optional: the operator server's own `info` (GET <server>/v1/info), read
//                       before joining it, so a server showing another key is never joined
//   onBoarded()         optional: called once coins were boarded (the page reads the chain again,
//                       so the coins the board spent are not counted twice)
//   onchainQuiet()      optional: true while the page's own on-chain payment may still be
//                       spending coins (the leaf wallet then boards nothing)

// The mode's words, the same in every Sequentia wallet (this one, the extension and
// Ambra): change them in all three together.
import { expandRequest } from './pay-code.js'
import { pinnedOperator, checkPinned, treeRoute, arrivingAtoms, boardCandidates, boardAll, JOIN_RETRY_MS } from './default-arca.js'

export const MODE_WORDS = Object.freeze({
  title: 'Mode',
  user: 'User mode',
  userLine: 'One figure per asset, and the wallet chooses how value moves.',
  developer: 'Developer mode',
  developerLine: 'Every rail by name, side by side (on-chain, leaves and Lightning), each with its balance and its manual controls, and the developer tools.',
  note: 'Kept for this wallet. Sites that ask the wallet for its mode follow it.',
})

export const MODE_KEY = 'swk.mode'                  // + '.' + the wallet's tag
export const LEGACY_DEV_MODE_KEY = 'swk.devMode'     // one setting for every wallet, before
export const JOINED_KEY = 'swk.leaves.joined'        // + '.' + tag: this wallet joined an operator
export const ADDRESS_KEY = 'swk.leaves.address'      // + '.' + tag: the leaf address handed to pages
export const NODE_PASSWORD_KEY = 'swk.leaves.nodePassword'
export const CODE_KEY = 'swk.leaves.code'            // + '.' + tag: the receive code default mode shows
export const RESTORED_KEY = 'swk.leaves.restored'    // + '.' + tag: the join's restore has run to its end
// A receive code is shown again while it has at least this long before it lapses.
export const CODE_MARGIN_S = 86_400
// User mode: how often the open page reads the wallet's mailbox, so that a payment to its receive
// code shows within seconds rather than at the schedule's next sync.
export const MAILBOX_POLL_MS = 10_000
export const MAILBOX_QUIET_MS = 20_000
// User mode: the watch of the operator's bond (which may read a long stretch of the chain, and
// holds the wallet while it does) runs at most this often, and only once the page has been
// left alone for BOND_QUIET_MS; the bond itself is read at care's pace in either mode.
export const BOND_WATCH_EVERY_MS = 3600_000
export const BOND_QUIET_MS = 120_000
export const TICK_MS = 60_000
// How often `care` runs at most, after a sync or a tick of the schedule.
export const CARE_EVERY_MS = 10 * 60_000
// `care`'s planning reach: every leaf of a round is planned at the first care after it
// is made (the library's PLAN_EVERY_ROUND_LEAF).
export const PLAN_EVERY_ROUND_LEAF = 4294967295
// A payment through a release: how often the wallet syncs while it waits for the round
// that frees the planned coins, how long it waits at most, and how many releases one
// payment may need (a release can fall short by the new leaf's own margins).
export const RELEASE_POLL_MS = 15_000
export const RELEASE_WAIT_MS = 3 * 3600_000
export const RELEASE_TRIES = 3

// The arguments `care` runs with: the page's claim scan, and every leaf of a round planned.
export function careArgs (scan) {
  const a = { plan_within: PLAN_EVERY_ROUND_LEAF }
  if (scan) a.scan = scan
  return a
}

// Whether the coins a release gave up are done with: none of them is still the wallet's
// to spend or in the round that gives them up (their round final, the forfeits handed
// over at sync), so the new leaves are held and the payment can be asked again.
const RELEASING = new Set(['live', 'pending', 'given', 'offered', 'sending', 'forfeited'])
export function releaseDone (coins, released) {
  const by = new Map((coins || []).map((c) => [c.leaf_id, c]))
  return (released || []).every((id) => { const c = by.get(id); return !c || !RELEASING.has(c.state) })
}

// The assets the operator serves under the supervised profile (`info`'s `supervised`
// entry): a coin of one is held only as a landing-1 leaf, landing in the wallet's own key.
export function supervisedAssets (info) {
  return ((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : [])
    .filter((a) => a && a.supervised && typeof a.asset === 'string').map((a) => a.asset)
}

// The assets the operator serves issuer-operated (`info`'s `issuer` entry): their batches'
// sweeps can only burn, and the issuer mints each round's float through a mint limiter.
export function issuerAssets (info) {
  return ((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : [])
    .filter((a) => a && a.issuer && typeof a.asset === 'string').map((a) => a.asset)
}

// What of each asset its issuer has frozen for this wallet: every held leaf whose landing
// the node shows frozen (or the asset paused), and every on-chain coin the leaf wallet
// counts frozen (a leaf taken home by its landing stays frozen there).
// -> Map(asset -> BigInt atoms)
export function frozenAtoms (coins, balance) {
  const out = new Map()
  const add = (a, v) => { if (!a) return; out.set(a, (out.get(a) || 0n) + big(v)) }
  for (const c of coins || []) {
    if (!HELD.has(c.state) || !c.frozen) continue
    // A leaf whose exit's claim is out is the on-chain coin the claim made, counted below.
    if (c.state === 'exiting' && String(c.note || '').startsWith('claimed by')) continue
    if (c.frozen.frozen || c.frozen.paused) add(c.asset, c.value)
  }
  for (const [a, v] of Object.entries((balance && balance.sequentia_onchain_frozen) || {})) add(a, v)
  return out
}

// The one plain sentence a frozen holding gets, in either mode, beside its asset's figure.
export function frozenSentence (amount, ticker) {
  return `${amount} ${ticker} is frozen by its issuer: it can't be sent until the issuer lifts the freeze.`
}

// A refusal for user mode: the bond's, a frozen coin's and one the operator declines said
// plainly; every other refusal as it is.
export function plainRefusal (e) {
  const m = String((e && e.message) || '')
  if (e && e.code === 'declined') return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: DECLINED_WORDS })
  if (bondRefusal(e)) return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: BOND_WORDS.refused })
  // A receive code is paid once: the operator refuses a second payment to its key.
  if (e && e.code === 'key_reused') return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: CODE_PAID_WORDS })
  if ((e && e.code === 'frozen') || /\bfrozen\b|\bpaused\b/i.test(m)) {
    return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: 'This asset is frozen by its issuer for this wallet: nothing was sent.' })
  }
  return e
}

// A payment the operator's signer refuses for what it asks, which it would refuse again
// however often it were asked (the server's `declined`): the library has put the coins back.
export const DECLINED_WORDS = 'This payment was declined; nothing was sent.'

export const CODE_PAID_WORDS = 'This receive code was paid already: ask for a new one. Nothing was sent.'

// A refusal of the operator's equivocation bond (missing, in notice, or worth less than
// what the wallet would hold out of round on it): the library's gate, said plainly.
export function bondRefusal (e) {
  return /\bbond\b/i.test(String((e && e.message) || ''))
}
export const BOND_WORDS = Object.freeze({
  refused: 'Not accepted: the security deposit that backs these instant payments is missing or being withdrawn, so this wallet takes no payment that rests on it. Nothing was signed.',
})

// The user composer's pairs, as the operator serves them: a pair with a supervised asset
// keeps only the in-tree swap with a live maker, since the operator serves no take, no
// resting order and no Lightning payment in such an asset.
export function servedPairs (pairs, supervised) {
  const sup = new Set(supervised || [])
  if (!pairs || !pairs.chains || !sup.size) return pairs
  const chains = {}
  for (const [g, c] of Object.entries(pairs.chains)) {
    chains[g] = { ...c, pairs: (c.pairs || []).map((p) => (sup.has(p.pay) || sup.has(p.receive))
      ? { ...p, sources: (p.sources || []).filter((x) => x === 'leaf-maker') } : p) }
  }
  return { ...pairs, chains }
}

// The current coin of each open or stopped plan: the leaf its next step gives up.
export function plannedCoins (plans) {
  const out = new Map()
  for (const p of plans || []) {
    if (p.state !== 'open' && p.state !== 'stopped') continue
    const current = ((p.steps || []).filter((st) => st.leaf_id).map((st) => st.leaf_id).pop()) || p.coin
    out.set(current, p)
  }
  return out
}

// Whether `care` runs now: at the first chance after the page opens, then at most every
// CARE_EVERY_MS. `last` is when it last ran (ms), or null.
export function careDue (last, nowMs, every = CARE_EVERY_MS) {
  return last == null || nowMs - last >= every
}

// What a `care` answer did, counted: claims taken up (a leaf id came back), plans made,
// plans cancelled. Anything at all means the balance may have moved.
export function careSummary (answer) {
  const a = answer || {}
  const claims = Array.isArray(a.claims) ? a.claims : []
  const planned = Array.isArray(a.planned) ? a.planned : []
  const cancelled = Array.isArray(a.cancelled) ? a.cancelled : []
  const refreshing = Array.isArray(a.refreshing) ? a.refreshing : []
  return {
    taken: claims.filter((c) => c && c.taken_up && !c.error).length,
    held: claims.filter((c) => c && c.leaf_id && (c.held || c.error)).length,
    planned: planned.filter((p) => p && p.plan_id).length,
    unplanned: planned.filter((p) => p && p.error).length,
    cancelled: cancelled.filter((p) => p && p.state === 'cancelled').length,
    refreshing: refreshing.filter((r) => r && r.participation && !r.error).length,
    later: Number(a.not_yet_planned || 0),
  }
}

const tagged = (key, tag) => key + '.' + (tag || 'default')

// 'developer' or 'user', for the wallet of `tag`. The one setting kept before modes were
// kept for each wallet becomes the first wallet's that reads it, once.
export function walletMode (store, tag) {
  try {
    const v = store.getItem(tagged(MODE_KEY, tag))
    if (v === 'developer' || v === 'user') return v
    if (store.getItem(LEGACY_DEV_MODE_KEY) === '1') {
      store.setItem(tagged(MODE_KEY, tag), 'developer')
      store.removeItem(LEGACY_DEV_MODE_KEY)
      return 'developer'
    }
  } catch {}
  return 'user'
}

export function setWalletMode (store, tag, mode) {
  if (mode !== 'developer' && mode !== 'user') throw new Error("the mode is 'developer' or 'user'")
  try { store.setItem(tagged(MODE_KEY, tag), mode); store.removeItem(LEGACY_DEV_MODE_KEY) } catch {}
  return mode
}

export function devModeOn (store, tag) { return walletMode(store, tag) === 'developer' }

export function joinedOperator (store, tag) {
  try { return store.getItem(tagged(JOINED_KEY, tag)) === '1' } catch { return false }
}
function setJoined (store, tag) { try { store.setItem(tagged(JOINED_KEY, tag), '1') } catch {} }

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

// A refusal from the library: its kind, and its message in its own words.
export class LeafError extends Error {
  constructor (e) {
    super(e && e.message ? e.message : String(e))
    this.kind = (e && e.kind) || 'error'
    this.code = e && e.code
    this.status = e && e.status
    // A payment that planned coins could cover: their asset, and which to give up.
    if (e && e.asset) this.asset = e.asset
    if (e && Array.isArray(e.release)) this.release = e.release
  }
}

export class LeafClient {
  constructor (makeWorker) {
    this.worker = makeWorker()
    this.next = 1
    this.pending = new Map()
    this.worker.onmessage = (ev) => {
      const m = ev.data || {}
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.ok(m.value); else p.no(new LeafError(m.error))
    }
    this.worker.onerror = (ev) => {
      const err = new LeafError({ kind: 'worker', message: 'the leaf wallet could not start: ' + ((ev && ev.message) || 'the worker failed') })
      for (const p of this.pending.values()) p.no(err)
      this.pending.clear()
      this.failed = err
    }
  }

  call (op, args = {}) {
    if (this.failed) return Promise.reject(this.failed)
    const id = this.next++
    return new Promise((ok, no) => {
      this.pending.set(id, { ok, no })
      this.worker.postMessage({ id, op, args })
    })
  }

  exists (mnemonic) { return this.call('exists', { mnemonic }) }
  create (mnemonic, config) { return this.call('create', { mnemonic, config }) }
  open (mnemonic, nodePassword) { return this.call('open', { mnemonic, nodePassword }) }
  // -> { result, start }
  run (command, args = {}) { return this.call('run', { command, args }) }
}

// ---------------------------------------------------------------------------
// What the library's answers mean for the screens (pure; tested)
// ---------------------------------------------------------------------------

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The library's balance: per asset, leaf atoms by state, and on-chain atoms.
// `leaves` is what the asset's figure counts: the library's `held` (leaves and its own
// on-chain coins together, a leaf whose exit's claim is out counted once, as the claim's
// output, and a leaf awaiting a preimage nowhere) less its `sequentia_onchain`, whose coins
// sit at the phrase's own keys and are counted by the page's on-chain scan. A library that
// gives no `held` is read by its states.
// -> Map(asset -> { leaves, states: { state: BigInt }, onchain })
export function leafBalances (balance) {
  const out = new Map()
  const row = (a) => { if (!out.has(a)) out.set(a, { leaves: 0n, states: {}, onchain: 0n }); return out.get(a) }
  for (const [a, states] of Object.entries((balance && balance.arca) || {})) {
    const r = row(a)
    for (const [s, v] of Object.entries(states || {})) { r.states[s] = (r.states[s] || 0n) + big(v); r.leaves += big(v) }
  }
  for (const [a, v] of Object.entries((balance && balance.sequentia_onchain) || {})) row(a).onchain += big(v)
  const held = balance && balance.held
  if (held && typeof held === 'object') {
    for (const r of out.values()) r.leaves = 0n
    for (const [a, v] of Object.entries(held)) { const r = row(a); const l = big(v) - r.onchain; r.leaves = l > 0n ? l : 0n }
  }
  return out
}

// The rails table: BTC first and always (it is the other chain, and a tree on this
// chain holds none), then every Sequentia asset held on any rail, in ticker order.
export function railRows ({ balances, btcOnchain = 0n, lnFor = () => 0n, tickerOf = (h) => h, lnAssets = [] }) {
  const rows = [{ kind: 'BTC', onchain: big(btcOnchain), leaves: null, states: {}, lightning: big(lnFor('BTC')) }]
  const keys = new Set([...balances.keys(), ...lnAssets])
  const seq = []
  for (const h of keys) {
    const b = balances.get(h) || { leaves: 0n, states: {}, onchain: 0n }
    const lightning = big(lnFor(h))
    if (b.leaves + b.onchain + lightning <= 0n) continue
    seq.push({ kind: h, onchain: b.onchain, leaves: b.leaves, states: b.states, lightning })
  }
  seq.sort((x, y) => String(tickerOf(x.kind)).localeCompare(String(tickerOf(y.kind))))
  return rows.concat(seq)
}

// The assets a receive request may name: those the operator serves, in the order of its
// published list (the library's `info`, read when the wallet joined or opened), then any
// other asset the wallet already holds leaves of. A fresh wallet, or one whose coins have
// not confirmed yet, can still ask for an asset the operator serves; an asset it does not
// serve is offered only when leaves of it are held. When the operator's list could not be
// read, every asset the leaf wallet holds, as before it was known.
export function receiveAssets (info, balances) {
  const listed = ((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : [])
    .map((a) => a && a.asset).filter((a) => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a))
  const held = [...balances.entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a)
  if (!listed.length) return [...balances.keys()]
  return [...new Set([...listed, ...held])]
}

// The assets to ask the testnet faucet for, for a request: the one it names, or else each
// asset the operator serves (a leaf can hold nothing else). Which of them the faucet pays as
// leaves is the faucet's to say; it refuses the others in its own words.
export function faucetAssets (info, requested) {
  if (requested) return [requested]
  return ((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : [])
    .map((a) => a && a.asset).filter((a) => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a))
}

// What the faucet is sent: the request in place of an address, and the asset by the label
// the faucet knows it by. The Sequence token (SEQ) is the faucet's request with no asset.
export function faucetRequestBody (request, label) {
  const body = { request }
  if (label && !/^t?SEQ$/.test(label)) body.asset = label
  return body
}

// States in which a coin is still the wallet's business.
const HELD = new Set(['pending', 'live', 'offered', 'sending', 'given', 'forfeited', 'exiting'])
export function heldCoins (coins) { return (coins || []).filter((c) => HELD.has(c.state)) }

// Whether something is moving that sync must follow now, whatever the schedule says:
// a coin pending, being sent, held for an in-tree swap (the other wallet completes it,
// and only a sync reads what it pays this one), given to a participation, under a
// forfeit or on its way out, or a participation not yet done.
const DONE_PARTICIPATION = new Set(['released', 'void', 'expired', 'refused'])
export function inFlight (coins, participations) {
  if ((coins || []).some((c) => ['pending', 'sending', 'offered', 'given', 'forfeited', 'exiting'].includes(c.state))) return true
  return (participations || []).some((p) => !DONE_PARTICIPATION.has(p.state) && !p.released)
}

// Whether to sync now. The time to hold to is the schedule's next_sync_at as it was
// first given after the last sync (`held`): a schedule that moves that time on at every
// read (a coin given to a refresh reads now + 1 h each time, and is not `due` until its
// home date) is still synced once the time first given arrives. Also when the schedule
// is due, and while something moves. Answers { sync, why, held } (the time to hold to
// next: null once a sync runs).
export function syncDecision (schedule, held, moving) {
  const s = schedule || {}
  const at = typeof held === 'number' ? held : (typeof s.next_sync_at === 'number' ? s.next_sync_at : null)
  if (s.due) return { sync: true, why: 'schedule', held: null }
  if (at != null && typeof s.now === 'number' && s.now >= at) return { sync: true, why: 'time', held: null }
  if (moving) return { sync: true, why: 'moving', held: null }
  return { sync: false, why: null, held: at }
}

// When the page next asks: the schedule's own time when it is near, otherwise the
// next tick. A schedule that is due is due now.
export function nextAskMs (schedule, tickMs = TICK_MS) {
  if (!schedule) return tickMs
  if (schedule.due) return 0
  const next = schedule.next_sync_at
  const now = schedule.now
  if (typeof next !== 'number' || typeof now !== 'number') return tickMs
  return Math.max(0, Math.min(tickMs, (next - now) * 1000))
}

// A median time for people: the UTC date and how far it is from the chain's now.
export function when (t, now) {
  if (typeof t !== 'number') return '—'
  const iso = new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  if (typeof now !== 'number') return iso
  const d = t - now
  const abs = Math.abs(d)
  const span = abs >= 86400 ? `${Math.floor(abs / 86400)} d ${Math.floor((abs % 86400) / 3600)} h`
    : abs >= 3600 ? `${Math.floor(abs / 3600)} h ${Math.floor((abs % 3600) / 60)} min`
      : `${Math.floor(abs / 60)} min`
  return `${iso} (${d >= 0 ? 'in ' + span : span + ' ago'})`
}

// The steps of one exit answer, for the drill's log.
export function exitSteps (answer) {
  return ((answer && answer.broadcast) || []).map((s) => ({
    txid: s.txid,
    what: s.step || s.kind || s.what || '',
    vsize: s.vsize,
    fees: (Array.isArray(s.fee) ? s.fee : (s.fee ? [s.fee] : [])).map((f) => ({ asset: f.asset, amount: String(f.amount ?? '') })),
  }))
}

// ---------------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------------

export function mountLeaves (ctx, root, settingsRoot) {
  const { el } = ctx
  const now = ctx.now || (() => Date.now())
  const tickMs = ctx.tickMs || TICK_MS
  const careEvery = ctx.careEveryMs || CARE_EVERY_MS
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = (m) => { try { (ctx.log || console.log)(m) } catch {} }
  const S = { client: null, open: false, busy: false, balance: null, coins: [], participations: [], schedule: null,
    refusals: [], last: null, drill: null, quote: null, timer: null, showHistory: false, error: null, info: null, form: {},
    careAt: null, lastCare: null, plans: null, claims: null, distributions: null }
  // What is typed into a form survives a re-render (sync re-renders the panels by itself).
  const bind = (node) => {
    if (S.form[node.id] != null) node.value = S.form[node.id]
    const keep = () => { S.form[node.id] = node.value }
    node.addEventListener('input', keep); node.addEventListener('change', keep)
    return node
  }
  const val = (id) => String(S.form[id] ?? '').trim()

  const tick = (h) => { try { return ctx.assetMeta(h).ticker || h.slice(0, 8) } catch { return h.slice(0, 8) } }
  const prec = (h) => { try { return ctx.assetMeta(h).precision ?? 0 } catch { return 0 } }
  const amt = (h, atoms) => {
    const a = big(atoms)
    const ref = ctx.refValueStr ? ctx.refValueStr(h, a) : ''
    return `${ctx.fmtAtoms(a, prec(h))} ${tick(h)} (${a} atoms)${ref ? ' ' + ref : ''}`
  }
  const short = (s) => (s && s.length > 20) ? s.slice(0, 10) + '…' + s.slice(-6) : (s || '')
  const kv = (k, v) => { const r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); const s = el('span', 'v mono-inline'); if (v && typeof v === 'object' && v.nodeType) s.appendChild(v); else s.textContent = String(v ?? ''); r.appendChild(s); return r }
  const card = (title) => { const c = el('div', 'card'); c.appendChild(el('label', 'lbl', title)); return c }
  const button = (text, onclick, cls) => { const b = el('button', cls || '', text); b.onclick = onclick; return b }
  const errBox = (e) => {
    const box = el('div', 'status err leaf-refusal')
    box.textContent = e.message
    if (e.kind || e.code) box.appendChild(el('div', 'sub', [e.kind, e.code, e.status].filter(Boolean).join(' · ')))
    return box
  }

  // ---- talking to the library ----
  // One action at a time: a click while sync runs waits for it rather than being lost.
  async function act (what, f) {
    S.queued = (S.queued || 0) + 1
    if (S.busy) render()
    while (S.busy) await new Promise((r) => setTimeout(r, 100))
    S.queued--
    S.busy = true; S.error = null; render()
    try {
      const v = await f()
      S.last = { what, value: v }
      return v
    } catch (e) {
      S.error = { what, e }
      throw e
    } finally {
      try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e }
      S.busy = false
      render()
    }
  }

  async function run (command, args) {
    const v = await S.client.run(command, args)
    if (v && v.start && v.start.witness && v.start.witness.error) S.startNote = v.start.witness.error.message
    else if (v && v.start && v.start.recheck && v.start.recheck.error) S.startNote = v.start.recheck.error.message
    else S.startNote = null
    if (v && v.start && v.start.recheck && Array.isArray(v.start.recheck.changes) && v.start.recheck.changes.length) S.recheckNote = v.start.recheck
    return v.result
  }

  async function reload () {
    if (!S.open) return
    const [b, c, p, s, r] = [await run('balance'), await run('coins'), await run('participations'), await run('schedule'), await run('refusals')]
    S.balance = b; S.coins = c || []; S.participations = p || []; S.schedule = s; S.refusals = r || []
    // The plans are shown in developer mode only; reading them asks nothing of the operator.
    if (dev()) { try { const pl = await run('plans'); S.plans = (pl && pl.plans) || [] } catch { S.plans = null } }
    if (ctx.onChange) try { ctx.onChange() } catch {}
  }

  // The balance read again soon, once nothing else is running: a trade that brought coins in.
  function refreshSoon () {
    if (!S.open) return
    clearTimeout(S.refreshTimer)
    S.refreshTimer = setTimeout(async () => {
      if (S.busy) { refreshSoon(); return }
      S.busy = true
      try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e } finally { S.busy = false; render() }
    }, 500)
  }

  const tag = () => { try { return ctx.walletTag ? ctx.walletTag() : 'default' } catch { return 'default' } }
  const dev = () => devModeOn(ctx.store, tag())
  const emit = (name, data) => { if (ctx.onEvent) try { ctx.onEvent(name, data) } catch {} }
  const arrivals = (mb) => { for (const c of ((mb && mb.accepted) || [])) emit('leafArrived', { leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? ''), kind: c.kind }) }

  // Opens the leaf wallet: in developer mode always (the tab shows the join form when
  // this wallet has joined none), in user mode when it has joined an operator, whose coins it
  // then syncs without showing them, or else when the page names an operator: a wallet in user
  // mode joins that one by itself (joinPinned), and one that cannot (the server unreachable, or
  // showing another key) works as it did without, and tries again later.
  const pinned = () => { try { return ctx.pinned ? pinnedOperator(ctx.pinned()) : null } catch { return null } }
  async function start () {
    if (S.open || S.starting) return
    const auto = dev() ? null : pinned()
    if (!dev() && !joinedOperator(ctx.store, tag()) && !auto) return
    S.starting = true
    clearTimeout(S.joinTimer)
    try {
      if (!S.client) S.client = new LeafClient(ctx.makeWorker)
      const m = ctx.mnemonic()
      const has = await S.client.exists(m)
      if (!has && !auto) { S.open = false; render(); return }
      if (!has) await joinPinned(m, auto)
      else {
        let pw = null; try { pw = ctx.store.getItem(NODE_PASSWORD_KEY) } catch {}
        await S.client.open(m, pw || undefined)
        S.info = await run('info')
        // A wallet joined by itself is opened only under the key the page pins.
        if (auto && !joinedOperator(ctx.store, tag())) checkPinned(S.info && S.info.operator, auto, 'the wallet')
        setJoined(ctx.store, tag())
        // A wallet this page joined by itself whose restore was cut short restores now.
        if (auto) await restoreOnce()
        S.open = true
      }
      S.joinError = null
      S.openedAt = now()
    } catch (e) {
      S.open = false
      S.joinError = e
      log('[leaves] could not open' + (auto ? ' (tried again in two minutes)' : '') + ': ' + ((e && e.message) || e))
      if (auto) S.joinTimer = setTimeout(() => { start().catch(() => {}) }, JOIN_RETRY_MS)
      render()
      throw e
    } finally { S.starting = false }
    await reload()
    // The resume pass: one sync when the leaf wallet opens, whatever the schedule says. A
    // wallet closed for a while may have coins a plan's step replaced, payments in its
    // mailbox, or an exit to move on; the schedule wakes a planned coin only at its plan's
    // date, so without this the page would show the coin the step gave up until then.
    // In user mode on the page's operator the pass waits, as the rest of the upkeep does, for a
    // moment nobody is asking the wallet for anything: what it holds is on the page already,
    // and a person who acts at once is not kept behind it.
    if (!dev() && pinned()) S.openSyncDue = true
    else await openSync()
    if (ctx.onOpen) try { ctx.onOpen() } catch {}
    await upkeep()
    schedule()
    watchMailbox()
  }

  // ---- user mode: what is paid to the wallet shows within seconds ----
  // The library's `mailbox` (what sync reads first) every few seconds while the page is open,
  // never while the wallet is busy or a person waits on it; what it takes shows at once.
  function watchMailbox () {
    clearTimeout(S.mailTimer)
    if (!S.open || dev() || !pinned()) return
    S.mailTimer = setTimeout(async () => {
      // Not while a person waits on the wallet, nor between the steps of what they asked (a
      // trade's quote asks the library several times, with the network in between).
      if (S.open && !dev() && !S.busy && !S.asked && now() - (S.lastAsked || 0) > MAILBOX_QUIET_MS) {
        S.busy = true
        const t0 = now()
        try {
          const v = await run('mailbox')
          if (now() - t0 > 2000) log(`[leaves] mailbox read: ${now() - t0} ms`)
          if (v && ((v.accepted || []).length || (v.pending || []).length)) {
            arrivals(v)
            try { await reload() } catch {}
          }
        } catch {} finally { S.busy = false }
      }
      watchMailbox()
    }, ctx.mailboxPollMs || MAILBOX_POLL_MS)
  }

  async function openSync () {
    S.openSyncDue = false
    S.busy = true; render()
    const tSync = now()
    try {
      const v = await run('sync')
      log(`[leaves] sync at open: ${now() - tSync} ms`)
      arrivals(v && v.mailbox)
      S.lastSync = { at: now(), value: v, auto: true, why: 'open' }
    } catch (e) { S.lastSync = { at: now(), error: e, auto: true, why: 'open' } }
    try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e }
    // What the wallet holds is on the page now; its own upkeep comes after.
    S.busy = false; render()
  }

  // Joins the page's operator, as the join form does with what a person types: the server must
  // show the pinned key before anything is created, and the wallet's answer must name it after.
  // A phrase that already holds coins with this operator (another browser, Ambra, the
  // extension) finds them under its mailbox key: restore once, as the join form does.
  async function joinPinned (m, cfg) {
    log('[leaves] joining ' + cfg.server)
    if (!ctx.serverInfo) throw new LeafError({ kind: 'refused', message: 'the page cannot read the operator\u2019s server' })
    const si = await ctx.serverInfo(cfg.server)
    checkPinned(si && si.operator, cfg, 'the server')
    const info = await S.client.create(m, { server: cfg.server, node_url: cfg.node_url })
    S.info = info && info.result
    checkPinned(S.info && S.info.operator, cfg, 'the wallet')
    setJoined(ctx.store, tag())
    try { ctx.store.removeItem(NODE_PASSWORD_KEY) } catch {}
    S.autoJoined = { at: now() }
    // Open once restored: until then the page works as it does without the tree (the address,
    // what is on the chain), rather than waiting on what the restore holds up.
    await restoreOnce()
    S.open = true
  }

  // The join's restore, run to its end once: a page closed while it ran restores again when it
  // next opens, so a phrase's coins are never left behind by a tab closed too soon.
  async function restoreOnce () {
    const key = tagged(RESTORED_KEY, tag())
    try { if (ctx.store.getItem(key)) return } catch {}
    const t0 = now()
    try {
      S.restored = await run('restore')
      try { ctx.store.setItem(key, String(now())) } catch {}
      log(`[leaves] restore: ${now() - t0} ms`)
    } catch (e) { S.restored = { error: e.message }; log('[leaves] restore: ' + e.message) }
  }

  // ---- what a person asks for comes first ----
  // A command of the page API or a payment of the composer, waiting or running, counts
  // here. The wallet's own upkeep (care, and the bond's watch, whose first run may read
  // a long stretch of the chain) starts only while none does, and what it put off runs
  // once the last one is done.
  async function asking (f) {
    S.asked = (S.asked || 0) + 1
    S.lastAsked = now()
    try { return await f() } finally {
      S.asked--
      S.lastAsked = now()
      if (!S.asked && S.upkeepLater) upkeepSoon(0)
    }
  }
  function upkeepSoon (ms) {
    clearTimeout(S.upkeepTimer)
    S.upkeepTimer = setTimeout(() => { upkeep().catch(() => {}) }, ms)
  }
  async function upkeep () {
    if (!S.open) return
    await new Promise((r) => setTimeout(r, 0))   // the page paints what it holds first
    if (S.busy || S.asked) { S.upkeepLater = true; if (!S.asked) upkeepSoon(1000); return }
    // In user mode on the page's operator, upkeep also leaves room between the steps of what a
    // person asked (a trade's quote asks the library several times, with the network between).
    if (!dev() && pinned()) { const quiet = Math.min(now() - (S.lastAsked || 0), now() - (S.openedAt || 0)); if (quiet < MAILBOX_QUIET_MS) { S.upkeepLater = true; upkeepSoon(MAILBOX_QUIET_MS - quiet + 500); return } }
    S.upkeepLater = false
    if (S.openSyncDue) await openSync()
    if (S.asked) { S.upkeepLater = true; return }
    S.busy = true; render()
    try {
      if (careDue(S.careAt, now(), careEvery)) await careIfDue()
      else if (S.bondLater) await bondIfIdle()
      await boardArrivals()
    } finally { S.busy = false; render() }
  }

  // ---- user mode: coins that land on the chain go into the tree by themselves ----
  // Each asset the operator serves, held at the phrase's keys on the chain at least at its
  // smallest leaf, is boarded whole less its fee (default-arca.js boardAll: the fee the library
  // quoted for that very board, in the asset boarded). Never in developer mode, whose Board card
  // is the person's; never while a person waits on the wallet, or while the page's own on-chain
  // payment may still be spending coins; coins the library refused to board are asked again
  // only once they change. The coin shows as arriving until the board is final.
  async function boardArrivals () {
    if (!S.open || dev() || !pinned() || S.asked) return
    try { if (ctx.onchainQuiet && ctx.onchainQuiet()) { upkeepSoon(30_000); return } } catch {}
    await coverReceiveKeys()
    const refused = S.boardRefused || (S.boardRefused = new Map())
    try { S.balance = await run('balance') } catch (e) { log('[leaves] balance before boarding: ' + (e && e.message)); return }
    log('[leaves] on the chain: ' + JSON.stringify((S.balance && S.balance.sequentia_onchain) || {}))
    let boarded = false
    for (const c of boardCandidates(S.balance, S.info)) {
      if (S.asked) { S.upkeepLater = true; break }
      // The same coins the library refused to board are not asked again until they change.
      if (refused.get(c.asset) === String(c.onchain)) continue
      try {
        const v = await boardAll(run, c)
        if (v) { boarded = true; S.lastBoard = { at: now(), asset: c.asset, value: v }; emit('leafArrived', { asset: c.asset, value: String(c.onchain), kind: 'board' }) }
        else refused.set(c.asset, String(c.onchain))
        log(`[leaves] board of ${c.asset.slice(0, 8)}: ${v ? 'boarded ' + (v.value || '') : 'nothing to board after the fee'}`)
      } catch (e) { refused.set(c.asset, String(c.onchain)); S.lastBoard = { at: now(), asset: c.asset, error: e }; log(`[leaves] board of ${c.asset.slice(0, 8)} refused: ${e && e.message}`) }
    }
    if (boarded) {
      try { await reload() } catch {}
      // The page's own reading of the chain still counts the coins the board spent: it reads again.
      if (ctx.onBoarded) try { ctx.onBoarded() } catch {}
    }
  }

  // The leaf wallet finds its on-chain coins by a gap of 20 unused keys past the last key it
  // handed out or saw holding an UNSPENT coin (its node's scantxoutset), where this page finds them
  // by a gap past the last key with any history. Keys used and spent before the leaf wallet looked
  // (before it joined, or by the page's own payments), or skipped by the address the page shares
  // with Bitcoin, leave a coin the page shows at a key the leaf wallet never reads: default mode
  // then never boards it, and a trade finds nothing to pay from. So the leaf wallet is handed keys
  // (`address`, each the next key) until its window covers every key this page has handed out,
  // once per key, remembered per wallet. -> how many keys it was handed now.
  const WINDOW_KEY = 'swk.leaves.window'
  async function coverReceiveKeys () {
    const target = claimScan()
    if (!target) return 0
    let had = 0
    try { had = Number(ctx.store.getItem(tagged(WINDOW_KEY, tag())) || 0) } catch {}
    // The window reaches 20 keys past the last one handed out: hand out up to `target - 20`.
    const want = target - 20
    if (!(want > had)) return 0
    let n = 0
    for (let i = had; i < want; i++) {
      if (S.asked) break
      try { await run('address') } catch (e) { log('[leaves] handing the leaf wallet its keys: ' + (e && e.message)); break }
      n++
      try { ctx.store.setItem(tagged(WINDOW_KEY, tag()), String(i + 1)) } catch {}
    }
    if (n) log(`[leaves] the leaf wallet reads its on-chain coins up to key ${had + n + 20} now (${n} key(s) handed to it)`)
    return n
  }

  // ---- what the wallet does by itself: claims taken up, plans kept ----
  const claimScan = () => { try { const n = ctx.claimScan ? Number(ctx.claimScan()) : NaN; return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined } catch { return undefined } }
  async function careIfDue () {
    if (!S.open || !careDue(S.careAt, now(), careEvery)) return
    if (S.asked) { S.upkeepLater = true; return }
    S.careAt = now()
    const t0 = now()
    try {
      const v = await run('care', careArgs(claimScan()))
      log(`[leaves] care: ${now() - t0} ms`)
      S.lastCare = { at: now(), value: v }
      const sum = careSummary(v)
      if (sum.taken || sum.planned || sum.cancelled || sum.refreshing) await reload()
      for (const c of (v && v.claims) || []) if (c && c.taken_up && !c.error) emit('leafArrived', { leaf_id: c.leaf_id, value: String(c.value ?? ''), kind: 'claim' })
    } catch (e) { S.lastCare = { at: now(), error: e } }
    await bondIfIdle()
  }

  // The bond's watch, unless a person is waiting: then once they are not.
  async function bondIfIdle () {
    if (S.asked) { S.bondLater = true; S.upkeepLater = true; return }
    S.bondLater = false
    await watchBond()
  }

  // The operator's bond, at care's pace, in either mode: read (a bond seen bonded is
  // required from then on, so a wallet that saw one refuses to receive once it is gone or
  // in notice), and watched: the wallet's evidence against the chain and the mempool, and
  // a slash sent should the operator key have signed twice under one salt.
  async function watchBond () {
    const t0 = now()
    try { S.bond = await run('bond') } catch (e) { S.bond = { error: e } }
    if (!dev() && pinned()) {
      const quiet = Math.min(now() - (S.lastAsked || 0), now() - (S.openedAt || 0))
      if (S.watchedAt != null && now() - S.watchedAt < BOND_WATCH_EVERY_MS) return
      if (quiet < BOND_QUIET_MS) { S.bondLater = true; upkeepSoon(BOND_QUIET_MS - quiet + 1000); return }
    }
    S.watchedAt = now()
    try { S.lastWatch = { at: now(), value: await run('watch_bond', {}) } } catch (e) { S.lastWatch = { at: now(), error: e } }
    log(`[leaves] bond read and watched: ${now() - t0} ms`)
  }

  // ---- the schedule: sync by itself while the page is open ----
  function schedule () {
    clearTimeout(S.timer)
    if (!S.open) return
    const wait = inFlight(S.coins, S.participations) ? Math.min(tickMs, 30_000) : nextAskMs(S.schedule, tickMs)
    S.nextAsk = now() + wait
    S.timer = setTimeout(autoSync, wait)
    render()
  }

  async function autoSync () {
    if (!S.open) return
    if (S.busy) { S.timer = setTimeout(autoSync, 5000); return }
    try {
      const s = await run('schedule')
      S.schedule = s
      if (s.due) emit('leafSyncDue', { now: s.now, next_sync_at: s.next_sync_at, why: s.why ?? null })
      const d = syncDecision(s, S.heldFor, inFlight(S.coins, S.participations))
      S.heldFor = d.held
      if (d.sync && !S.busy) {
        S.busy = true; render()
        try {
          const v = await run('sync')
          arrivals(v && v.mailbox)
          S.lastSync = { at: now(), value: v, auto: true }
        } catch (e) { S.lastSync = { at: now(), error: e, auto: true } }
        try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e }
        try { await careIfDue() } finally { S.busy = false }
      } else if (!S.busy && careDue(S.careAt, now(), careEvery)) {
        S.busy = true
        try { await careIfDue() } finally { S.busy = false }
      }
    } catch (e) { S.lastSync = { at: now(), error: e, auto: true } }
    schedule()
  }

  async function syncNow () {
    try {
      await act('sync', async () => {
        try {
          const v = await run('sync')
          S.heldFor = null
          arrivals(v && v.mailbox)
          S.lastSync = { at: now(), value: v, auto: false }
          await careIfDue()
          return v
        } catch (e) { S.lastSync = { at: now(), error: e, auto: false }; throw e }
      })
    } catch {}
    schedule()
  }

  // ---- paying from a planned coin: through the next round, by itself ----
  // A command the library refuses with kind `planned` (the unplanned coins fall short, the
  // planned ones it names would cover it) is asked again once those coins are given up in
  // the next round for leaves no plan names: plan_release, then sync until that round is
  // final and the new leaves are held. Every other answer and refusal is the library's.
  async function paying (command, args) {
    for (let i = 0; ; i++) {
      try { return await run(command, args) } catch (e) {
        // Coins too many payments from a round (the operator's `depth_limit`) are refreshed in the
        // next round, by themselves, and the payment asked again once that round is final: the
        // same wait as a release, which a person in user mode never has to ask for.
        if (e instanceof LeafError && e.code === 'depth_limit' && i < RELEASE_TRIES && args && args.asset) {
          const leaves = (S.coins && S.coins.length ? S.coins : (await run('coins')) || [])
            .filter((c) => c.asset === args.asset && c.state === 'live').map((c) => c.leaf_id)
          if (!leaves.length) throw e
          S.releasing = { coins: leaves, asset: args.asset, since: now(), command, why: 'depth' }
          render()
          try {
            const q = await run('quote', { leaves })
            await run('participate', { leaves, shown: q.coins })
            log(`[leaves] ${leaves.length} coin(s) refreshed in the next round before paying`)
            await waitReleased(leaves)
          } finally { S.releasing = null; render() }
          continue
        }
        if (!(e instanceof LeafError) || e.kind !== 'planned' || !e.release || !e.release.length || i >= RELEASE_TRIES) throw e
        S.releasing = { coins: e.release, asset: e.asset, since: now(), command }
        render()
        try {
          const r = await run('plan_release', { leaves: e.release })
          S.releasing.answer = r
          await waitReleased(e.release)
        } finally { S.releasing = null; render() }
      }
    }
  }

  // A trade from coins an open plan keeps (the trade engine's `release`): they are given up in the
  // next round for leaves no plan names, and the trade is asked again once that round is final.
  // One release at a time; a second ask while one runs answers the one running.
  function releaseFor (asset, leaves) {
    if (S.releasing) return { releasing: S.releasing.coins.length, asset: S.releasing.asset }
    if (!S.open || !Array.isArray(leaves) || !leaves.length) return null
    S.releasing = { coins: leaves.slice(), asset, since: now(), command: 'trade' }
    render()
    ;(async () => {
      try {
        S.releasing.answer = await run('plan_release', { leaves })
        log(`[leaves] ${leaves.length} planned coin(s) of ${String(asset).slice(0, 8)} given up in the next round to be traded`)
        await waitReleased(leaves)
      } catch (e) { log(`[leaves] release for a trade: ${e && e.message}`) } finally { S.releasing = null; render() }
    })()
    return { releasing: leaves.length, asset }
  }

  async function waitReleased (coins) {
    const until = now() + RELEASE_WAIT_MS
    for (;;) {
      try { const v = await run('sync'); arrivals(v && v.mailbox); S.lastSync = { at: now(), value: v, auto: true, why: 'release' } } catch {}
      let cs = null
      try { cs = await run('coins'); S.coins = cs || [] } catch {}
      if (cs && releaseDone(cs, coins)) return
      if (now() >= until) {
        throw new LeafError({ kind: 'refused', message: 'the next round did not free the coins this payment needs in time; nothing was paid, and the payment can be asked again' })
      }
      await sleep(RELEASE_POLL_MS)
    }
  }

  // ---- render ----
  function render () {
    if (settingsRoot) renderSettings()
    if (!root) return
    root.innerHTML = ''
    if (!dev()) {
      root.appendChild(el('div', 'muted', 'Leaves are a developer-mode rail. Choose developer mode in Settings to work with them.'))
      return
    }
    if (!S.open) { renderJoin(); return }
    if (S.busy || S.queued) root.appendChild(el('div', 'status leaf-busy', 'Working…'))
    if (S.error) { const c = card('Refused: ' + S.error.what); c.appendChild(errBox(S.error.e)); root.appendChild(c) }
    if (S.reloadError) { const c = card('Could not read the wallet'); c.appendChild(errBox(S.reloadError)); root.appendChild(c) }
    if (S.startNote) { const c = card('At the start of the last command'); c.appendChild(el('div', 'warn', S.startNote)); root.appendChild(c) }
    if (S.releasing) {
      const c = card('Paying through the next round'); c.id = 'leafReleasing'
      c.appendChild(el('div', 'status', `${S.releasing.command}: the unplanned leaves fall short, so ${S.releasing.coins.length} planned leaf(s) (${S.releasing.coins.map(short).join(', ')}) are given up in the next round for leaves no plan names; the payment is asked again once that round is final.`))
      root.appendChild(c)
    }
    renderRails(); renderBoard(); renderReceive(); renderSend(); renderSync(); renderCare(); renderBond(); renderSupply(); renderCoins(); renderDrill(); renderParticipations(); renderRefusals()
  }

  function renderJoin () {
    const c = card('Join an operator')
    c.id = 'leafJoin'
    c.appendChild(el('p', 'sub', 'The wallet keeps leaves against one operator. It pins the operator\'s key and the node\'s chain when it joins, and refuses any server that names another. The node must validate its anchors (-validateanchor) and keep a transaction index (-txindex).'))
    const f = (id, label, ph, type) => { const d = el('div', 'field'); d.appendChild(el('label', 'lbl', label)); const i = el('input'); i.id = id; i.placeholder = ph || ''; if (type) i.type = type; bind(i); d.appendChild(i); c.appendChild(d); return i }
    f('leafServer', 'Operator server URL', 'https://…/operator')
    f('leafNodeUrl', 'Node JSON-RPC URL', 'https://…/node')
    f('leafNodeUser', 'Node RPC user (optional)', '')
    f('leafNodePassword', 'Node RPC password (optional)', '', 'password')
    f('leafDelay', 'Exit delay asked, in 512-second units (optional)', 'the library\'s default: 36 hours')
    f('leafMinDelay', 'Least exit delay accepted, in 512-second units (optional)', 'the library\'s default: 36 hours')
    const go = button('Join', async () => {
      const v = val
      const config = { server: v('leafServer'), node_url: v('leafNodeUrl') }
      if (v('leafNodeUser')) config.node_user = v('leafNodeUser')
      if (v('leafNodePassword')) config.node_password = v('leafNodePassword')
      if (v('leafDelay')) config.exit_delay_units = v('leafDelay')
      if (v('leafMinDelay')) config.min_exit_delay_units = v('leafMinDelay')
      try {
        await act('join', async () => {
          if (!S.client) S.client = new LeafClient(ctx.makeWorker)
          const info = await S.client.create(ctx.mnemonic(), config)
          setJoined(ctx.store, tag())
          // A phrase that already holds leaves with this operator (another browser, Ambra, the
          // extension) finds them under its mailbox key: restore once, as Ambra's join does.
          try { S.restored = (await S.client.run('restore')).result } catch (e) { S.restored = { error: e.message } }
          try { if (config.node_password) ctx.store.setItem(NODE_PASSWORD_KEY, config.node_password); else ctx.store.removeItem(NODE_PASSWORD_KEY) } catch {}
          S.open = true
          S.joined = info.result
          S.info = info.result
          return info
        })
        schedule()
      } catch {}
    }, 'primary')
    go.id = 'btnLeafJoin'
    const row = el('div', 'row'); row.style.marginTop = '12px'; row.appendChild(go); c.appendChild(row)
    if (S.error) c.appendChild(errBox(S.error.e))
    root.appendChild(c)
  }

  function renderRails () {
    const c = card('Balances per rail')
    c.id = 'leafRails'
    if (S.joined) {
      c.appendChild(el('div', 'warn', `Compare the operator key ${S.joined.operator} with the one the operator publishes through a channel you trust: the wallet has pinned it, and refuses any server that names another.`))
    }
    const balances = leafBalances(S.balance)
    let lnAssets = []; try { lnAssets = ctx.lnAssets ? ctx.lnAssets() : [] } catch {}
    const rows = railRows({ balances, btcOnchain: ctx.btcOnchain(), lnFor: ctx.lnFor, tickerOf: tick, lnAssets })
    const t = el('table', 'leaf-rails')
    const head = el('tr'); for (const h of ['Asset', 'On-chain', 'Leaves', 'Lightning']) head.appendChild(el('th', null, h)); t.appendChild(head)
    for (const r of rows) {
      const tr = el('tr'); tr.dataset.asset = r.kind
      const key = r.kind
      const fmt = (v) => key === 'BTC' ? `${ctx.fmtAtoms(v, 8)} BTC (${v} sat)` : amt(key, v)
      tr.appendChild(el('td', null, key === 'BTC' ? 'BTC' : tick(key)))
      tr.appendChild(el('td', 'leaf-onchain', fmt(r.onchain)))
      const lt = el('td', 'leaf-leaves')
      if (r.leaves === null) lt.textContent = 'none: a tree on Sequentia holds no BTC'
      else {
        lt.appendChild(el('div', null, fmt(r.leaves)))
        for (const [s, v] of Object.entries(r.states)) lt.appendChild(el('div', 'sub', `${s}: ${v} atoms`))
      }
      tr.appendChild(lt)
      tr.appendChild(el('td', 'leaf-ln', fmt(r.lightning)))
      t.appendChild(tr)
    }
    c.appendChild(t)
    c.appendChild(el('p', 'sub', 'On-chain is what the leaf wallet reads from its node. A coin received out of round and not yet refreshed is operator-confirmed: it relies on the operator and its sender not colluding until a round settles it. A round is final once its block is certified and its Bitcoin anchor is buried two blocks.'))
    root.appendChild(c)
  }

  function assetSelect (id, assets, emptyLabel) {
    const s = el('select'); s.id = id
    if (emptyLabel != null) { const o = el('option', null, emptyLabel); o.value = ''; s.appendChild(o) }
    for (const a of assets) { const o = el('option', null, `${tick(a)} · ${short(a)}`); o.value = a; s.appendChild(o) }
    bind(s)
    if (S.form[id] == null) S.form[id] = s.value
    return s
  }

  function field (c, label, node) { const d = el('div', 'field'); d.appendChild(el('label', 'lbl', label)); d.appendChild(node); c.appendChild(d); return node }

  function resultBox (what) {
    if (!S.last || S.last.what !== what) return null
    const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(S.last.value, null, 1); return pre
  }

  function renderBoard () {
    const c = card('Board')
    c.id = 'leafBoard'
    c.appendChild(el('p', 'sub', 'Brings an on-chain coin into the operator\'s tree. The operator registers the board before it is broadcast, so a refused board spends nothing; the coin is spendable once the board is final. The fee is paid in the asset boarded unless another is named.'))
    const onchain = [...leafBalances(S.balance).entries()].filter(([, v]) => v.onchain > 0n).map(([a]) => a)
    const all = [...new Set([...onchain, ...leafBalances(S.balance).keys()])]
    field(c, 'Asset', assetSelect('leafBoardAsset', onchain))
    const a = el('input'); a.id = 'leafBoardAmount'; field(c, 'Amount, in atoms', bind(a))
    field(c, 'Fee asset', assetSelect('leafBoardFee', all, 'the asset boarded'))
    // The fee is shown before anything is signed: the library quotes the board, and
    // boards only on the fee shown.
    const b = button('Board', async () => {
      const args = { asset: val('leafBoardAsset'), amount: val('leafBoardAmount') }
      if (val('leafBoardFee')) args.fee_asset = val('leafBoardFee')
      try { const q = await act('board_quote', () => run('board_quote', args)); S.boardQuote = { args, q }; render() } catch {}
    }, 'primary')
    b.id = 'btnLeafBoard'; b.disabled = S.busy
    const ad = button('Show an on-chain address', () => act('address', () => run('address')).catch(() => {}), 'ghost')
    ad.id = 'btnLeafAddress'; ad.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); r.appendChild(ad); c.appendChild(r)
    if (S.last && S.last.what === 'address') {
      const a2 = el('div', 'mono'); a2.id = 'leafAddress'; a2.textContent = S.last.value.address || ''
      a2.dataset.script = S.last.value.script_pubkey || ''
      c.appendChild(el('div', 'sub', 'An address of this wallet on the leaf wallet\'s chain, the same key as the wallet\'s own addresses: pay it to have a coin to board, or a fee coin for an exit.'))
      c.appendChild(a2)
    }
    if (S.boardQuote) {
      const { args, q } = S.boardQuote
      const box = el('div', 'warn leaf-quote'); box.id = 'leafBoardQuote'
      box.appendChild(el('div', null, `Board ${amt(args.asset, args.amount)}: fee ${amt(q.fee.asset, q.fee.amount)}, the node's floor now; ${q.vsize} vB, spending ${q.inputs} coin(s). The board goes ahead only on this fee.`))
      const r2 = el('div', 'row'); r2.style.marginTop = '8px'
      const ok = button('Sign and board', async () => {
        S.boardQuote = null
        act('board', () => run('board', { ...args, shown: q.fee })).catch(() => {})
      }, 'primary'); ok.id = 'btnLeafBoardConfirm'; ok.disabled = S.busy
      const no = button('Cancel', () => { S.boardQuote = null; render() }, 'ghost')
      r2.appendChild(ok); r2.appendChild(no); box.appendChild(r2)
      c.appendChild(box)
    }
    const out = resultBox('board'); if (out) c.appendChild(out)
    root.appendChild(c)
  }

  function renderReceive () {
    const c = card('Receive')
    c.id = 'leafReceive'
    c.appendChild(el('p', 'sub', 'A single-use receive request: a fresh key, this wallet\'s mailbox and the exit delay asked for. The payment arrives in the mailbox, which sync reads.'))
    field(c, 'Asset (optional)', assetSelect('leafRecvAsset', receiveAssets(S.info, leafBalances(S.balance)), 'any'))
    const a = el('input'); a.id = 'leafRecvAmount'; field(c, 'Amount, in atoms (optional)', bind(a))
    const b = button('Make a receive request', () => {
      const args = { asset: val('leafRecvAsset') || null, amount: val('leafRecvAmount') || null }
      act('receive', () => run('receive', args)).then((v) => { S.request = { text: (v && v.request) || '', asset: args.asset }; S.faucet = null; render() }).catch(() => {})
    })
    b.id = 'btnLeafReceive'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    if (S.request && S.request.text) {
      const t = el('textarea', 'mono'); t.id = 'leafRequest'; t.rows = 4; t.readOnly = true; t.value = S.request.text
      c.appendChild(t)
      if (ctx.askFaucet) renderFaucetAsk(c)
    }
    root.appendChild(c)
  }

  // The testnet faucet pays a receive request as a leaf, out of round, from its own wallet
  // on the operator: the request names the operator, the chain and this wallet's mailbox,
  // and the faucet refuses one for another operator or chain. The coin is in the mailbox
  // once the faucet answers; the sync that follows reads it.
  function renderFaucetAsk (c) {
    const choices = faucetAssets(S.info, S.request.asset)
    if (!choices.length) return
    c.appendChild(el('p', 'sub', 'On the testnet, the faucet can pay this request as a leaf.'))
    field(c, 'Asset to ask the faucet for', assetSelect('leafFaucetAsset', choices))
    const fb = button('Ask the testnet faucet to pay it', async () => {
      const asset = val('leafFaucetAsset') || choices[0]
      S.faucet = { busy: true }; render()
      try {
        const answer = await ctx.askFaucet(faucetRequestBody(S.request.text, tick(asset)))
        S.faucet = { answer }
      } catch (e) { S.faucet = { error: e } }
      render()
      if (S.faucet && S.faucet.answer) syncNow()
    }, 'ghost')
    fb.id = 'btnLeafFaucet'; fb.disabled = S.busy || !!(S.faucet && S.faucet.busy)
    const r = el('div', 'row'); r.style.marginTop = '8px'; r.appendChild(fb); c.appendChild(r)
    const f = S.faucet
    if (f && f.busy) c.appendChild(el('div', 'status', 'Asking the faucet…'))
    if (f && f.answer) {
      const l = f.answer.leaf || {}
      const d = el('div', 'status ok'); d.id = 'leafFaucetAnswer'
      d.textContent = `The faucet paid ${l.asset ? amt(l.asset, l.atoms) : (f.answer.amount + ' ' + f.answer.asset)} into this request; sync reads it from the mailbox.`
      c.appendChild(d)
    }
    if (f && f.error) { const d = el('div', 'status err'); d.id = 'leafFaucetAnswer'; d.textContent = 'The faucet refused: ' + (f.error.message || String(f.error)); c.appendChild(d) }
  }

  function renderSend () {
    const c = card('Send to a receive request')
    c.id = 'leafSend'
    c.appendChild(el('p', 'sub', 'Pays a receive request out of round: coins of the asset, those furthest from their exit date first, each into a checkpoint, then the reassignment into the receiver\'s leaf and the change. No asset is a default.'))
    const t = el('textarea', 'mono'); t.id = 'leafSendRequest'; t.rows = 3; field(c, 'Receive request', bind(t))
    const assets = [...leafBalances(S.balance).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a)
    field(c, 'Asset', assetSelect('leafSendAsset', assets, 'the request\'s'))
    const a = el('input'); a.id = 'leafSendAmount'; field(c, 'Amount, in atoms', bind(a))
    const b = button('Send', () => {
      const args = { request: val('leafSendRequest'), amount: val('leafSendAmount') || null, asset: val('leafSendAsset') || null }
      act('send', () => paying('send', args)).catch(() => {})
    }, 'primary')
    b.id = 'btnLeafSend'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    const out = resultBox('send'); if (out) c.appendChild(out)
    root.appendChild(c)
  }

  function renderSync () {
    const c = card('Sync and schedule')
    c.id = 'leafSync'
    const s = S.schedule || {}
    c.dataset.now = String(s.now ?? ''); c.dataset.next = String(s.next_sync_at ?? ''); c.dataset.due = String(!!s.due)
    if (S.lastSync) { c.dataset.lastSyncAt = String(S.lastSync.at); c.dataset.lastSyncAuto = String(!!S.lastSync.auto) }
    c.appendChild(kv('Chain time (median)', when(s.now)))
    c.appendChild(kv('Next sync the schedule asks for', s.next_sync_at == null ? 'none: nothing held off the chain, nothing awaited' : when(s.next_sync_at, s.now)))
    c.appendChild(kv('Due now', s.due ? 'yes' : 'no'))
    if (s.why) c.appendChild(kv('Why', s.why))
    if (S.nextAsk) c.appendChild(kv('This page asks again', new Date(S.nextAsk).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')))
    for (const rq of s.receive_requests || []) {
      c.appendChild(kv('Receive request ' + short(rq.owner || ''), `${rq.state}; handed out ${when(rq.asked_at, s.now)}; ${rq.state === 'lapsed' ? 'lapsed ' + when(rq.lapsed_at, s.now) : 'lapses ' + when(rq.lapses_at, s.now)}`))
    }
    const b = button('Sync now', () => syncNow()); b.id = 'btnLeafSync'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    if (S.lastSync) {
      const ls = S.lastSync
      c.appendChild(el('div', 'sub', `Last sync: ${new Date(ls.at).toISOString()} (${ls.auto ? 'by itself, on the schedule' : 'asked here'})`))
      if (ls.error) c.appendChild(errBox(ls.error))
      else {
        const v = ls.value || {}
        const mb = v.mailbox || {}
        const sum = el('div', 'leaf-sync-summary')
        sum.appendChild(el('div', null, `Mailbox: ${(mb.accepted || []).length} accepted, ${(mb.refused || []).length} refused, ${(mb.waiting || []).length} waiting`))
        for (const a of mb.accepted || []) sum.appendChild(el('div', 'sub', `accepted ${short(a.leaf_id)}: ${amt(a.asset, a.value)}, ${a.state}${a.note ? '; ' + a.note : ''}`))
        for (const a of mb.refused || []) sum.appendChild(el('div', 'sub leaf-refusal', `refused: ${a.reason || JSON.stringify(a)}`))
        for (const p of v.participations || []) sum.appendChild(el('div', 'sub', `participation ${short(p.participation)}: ${p.state}${p.note ? '; ' + p.note : ''}`))
        for (const e of v.exits || []) sum.appendChild(el('div', 'sub', `exit ${short(e.leaf_id)}: ${e.state}${e.next ? '; ' + e.next : ''}${e.error ? '; ' + e.error : ''}`))
        c.appendChild(sum)
        const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(v, null, 1)
        const d = el('details'); d.appendChild(el('summary', 'sub', 'What sync answered')); d.appendChild(pre); c.appendChild(d)
      }
    }
    root.appendChild(c)
  }

  // Developer mode's view of what the wallet does by itself.
  function renderCare () {
    const c = card('Kept by itself: claims and refresh plans')
    c.id = 'leafCare'
    c.appendChild(el('p', 'sub', 'After a sync, at most every ten minutes, the wallet takes up every claim named for one of its addresses and signs a refresh plan for every leaf of a round, so a closed wallet keeps it across its expiry. A leaf received or boarded out of round is free to pay, and is refreshed into a round once its refresh could run within ten days. A planned leaf is paid out of round by no wallet: a payment the unplanned leaves cannot cover gives the planned leaves it needs up in the next round and is made once that round is final, by itself. Release does that for one plan now.'))
    const lc = S.lastCare
    if (lc) {
      c.dataset.careAt = String(lc.at)
      if (lc.error) c.appendChild(errBox(lc.error))
      else {
        const sum = careSummary(lc.value)
        c.dataset.taken = String(sum.taken); c.dataset.planned = String(sum.planned); c.dataset.cancelled = String(sum.cancelled); c.dataset.refreshing = String(sum.refreshing)
        c.appendChild(kv('Last run', new Date(lc.at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')))
        c.appendChild(kv('Claims taken up', `${sum.taken}${sum.held ? `, ${sum.held} held for a later run` : ''}`))
        c.appendChild(kv('Plans signed', `${sum.planned}${sum.unplanned ? `, ${sum.unplanned} refused by the operator` : ''}; ${sum.later} leaf(s) not yet near their refresh`))
        c.appendChild(kv('Plans cancelled (their leaf moved)', String(sum.cancelled)))
        c.appendChild(kv('Leaves of no round refreshed into one, to be planned', String(sum.refreshing)))
        for (const x of (lc.value && lc.value.refreshing) || []) if (x && x.error) c.appendChild(el('div', 'sub leaf-refusal', `${short(x.coin)}: ${x.error}`))
        for (const p of (lc.value && lc.value.planned) || []) if (p && p.error) c.appendChild(el('div', 'sub leaf-refusal', `${short(p.coin)}: ${p.error}`))
        for (const x of (lc.value && lc.value.claims) || []) if (x && (x.refused || x.error)) c.appendChild(el('div', 'sub leaf-refusal', `claim ${x.claim}: ${x.refused || x.error}`))
        const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(lc.value, null, 1)
        const d = el('details'); d.appendChild(el('summary', 'sub', 'What care answered')); d.appendChild(pre); c.appendChild(d)
      }
    } else c.appendChild(el('div', 'muted', 'Not run yet in this page.'))
    const plans = S.plans || []
    const list = el('div'); list.id = 'leafPlans'
    if (!plans.length) list.appendChild(el('div', 'muted', 'No refresh plans.'))
    for (const p of plans) {
      const row = el('div', 'leaf-plan'); row.dataset.plan = p.plan_id; row.dataset.state = p.state
      row.appendChild(el('div', null, `Plan ${short(p.plan_id)} · ${p.state} · leaf ${short(p.coin)} · ${amt(p.asset, p.value)}`))
      row.appendChild(el('div', 'sub', `covers it until ${when(p.covered_until, (S.schedule || {}).now)} at the earliest; sync by ${when(p.sync_by, (S.schedule || {}).now)}; steps: ${(p.steps || []).map((st) => st.state || 'waiting').join(', ')}`))
      if (p.state === 'open') {
        const r = el('div', 'row'); r.style.marginTop = '6px'
        const cancel = button('Cancel', () => cancelPlan(p.plan_id), 'ghost'); cancel.disabled = S.busy
        const current = ((p.steps || []).filter((st) => st.leaf_id).map((st) => st.leaf_id).pop()) || p.coin
        const release = button('Release', () => releasePlan(p.plan_id, current), 'ghost'); release.disabled = S.busy
        r.appendChild(cancel); r.appendChild(release); row.appendChild(r)
      }
      list.appendChild(row)
    }
    c.appendChild(list)
    const r = el('div', 'row'); r.style.marginTop = '10px'
    const lookC = button('Look up claims', async () => { try { const scan = claimScan(); S.claims = await act('claims', () => run('claims', scan ? { scan } : {})) } catch {} }, 'ghost'); lookC.id = 'btnLeafClaims'
    const lookD = button('Distributions paid from here', async () => { try { S.distributions = await act('distributions', () => run('distributions')) } catch {} }, 'ghost')
    const now1 = button('Run now', async () => { S.careAt = null; try { await act('care', () => careIfDue()) } catch {} }, 'ghost'); now1.id = 'btnLeafCare'
    for (const b of [now1, lookC, lookD]) { b.disabled = S.busy; r.appendChild(b) }
    c.appendChild(r)
    if (Array.isArray(S.claims)) {
      const d = el('div'); d.id = 'leafClaimList'
      if (!S.claims.length) d.appendChild(el('div', 'muted', 'No claims under this wallet\'s addresses.'))
      for (const x of S.claims) d.appendChild(el('div', 'sub', `${x.distribution ? short(x.distribution) + ':' + x.index : ''} · ${amt(x.asset, x.value)} · ${x.state}${x.held ? ' · held as ' + short(x.held) : ''} · to ${short(x.address)}`))
      c.appendChild(d)
    }
    if (S.distributions != null) {
      const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(S.distributions, null, 1)
      const d = el('details'); d.open = true; d.appendChild(el('summary', 'sub', 'Distributions')); d.appendChild(pre); c.appendChild(d)
    }
    root.appendChild(c)
  }

  // Developer mode's view of the operator's bond: its asset, value and state, and the watch.
  function renderBond () {
    const c = card('The operator\'s bond')
    c.id = 'leafBond'
    c.appendChild(el('p', 'sub', 'The operator\'s equivocation bond: two messages its key signed under one coin\'s salt burn it whole. The wallet reads it at care\'s pace and, once it has seen it bonded, takes no payment out of round while it is missing or in notice, nor more than it is worth. It also watches its evidence against the chain and sends the slash itself should the operator key sign twice.'))
    const b = S.bond
    if (!b) c.appendChild(el('div', 'muted', 'Not read yet in this page.'))
    else if (b.error) c.appendChild(errBox(b.error))
    else {
      c.dataset.state = String(b.state || '')
      c.appendChild(kv('State', b.state))
      if (b.asset) c.appendChild(kv('Bond', amt(b.asset, b.value)))
      if (b.coin) c.appendChild(kv('Coin', b.coin))
      if (b.withdrawable_at != null) c.appendChild(kv('Withdrawable', when(b.withdrawable_at, (S.schedule || {}).now)))
      c.appendChild(kv('Required by this wallet', b.required ? 'yes: seen bonded' : 'no: never seen bonded'))
      c.appendChild(kv('Covers what this wallet holds out of round', b.covers ? 'yes' : 'no'))
      if (b.why) c.appendChild(el('div', 'sub', b.why))
    }
    const w = S.lastWatch
    if (w) {
      if (w.error) c.appendChild(errBox(w.error))
      else {
        const v = w.value || {}
        const ev = v.evidence || {}
        c.dataset.slashed = String((v.slashed || []).length)
        c.appendChild(kv('Last watch', `${new Date(w.at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}: ${ev.lines ?? 0} evidence line(s), ${ev.salts ?? 0} salt(s), ${(v.slashed || []).length} slash(es) sent`))
        const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(v, null, 1)
        const d = el('details'); d.appendChild(el('summary', 'sub', 'What watch_bond answered')); d.appendChild(pre); c.appendChild(d)
      }
    }
    const r = el('div', 'row'); r.style.marginTop = '10px'
    const go = button('Watch now', async () => { try { await act('watch_bond', () => watchBond()) } catch {} }, 'ghost'); go.id = 'btnLeafWatchBond'; go.disabled = S.busy
    r.appendChild(go); c.appendChild(r)
    root.appendChild(c)
  }

  // Developer mode: each asset the operator serves issuer-operated, with its supply report,
  // every mint and burn the operator lists read again from the wallet's own node.
  function renderSupply () {
    const assets = issuerAssets(S.info)
    if (!assets.length) return
    const c = card('Issuer-operated assets')
    c.id = 'leafSupply'
    c.appendChild(el('p', 'sub', 'The operator serves these assets issuer-operated: each round\'s float is minted by the issuer through its mint limiter, and every batch\'s sweep can only burn. Supply asks the operator for its report and reads each mint and burn it lists again on this wallet\'s node; it does not prove the list complete.'))
    S.supply = S.supply || {}
    for (const a of assets) {
      const row = el('div', 'leaf-supply'); row.dataset.asset = a
      row.appendChild(el('div', null, tick(a)))
      const r = S.supply[a]
      if (r && r.error) row.appendChild(errBox(r.error))
      else if (r) {
        row.dataset.checked = String(!!r.checked_on_the_node)
        for (const k of ['minted', 'burned', 'in_batches']) if (r[k] != null && typeof r[k] !== 'object') row.appendChild(kv(k.replace('_', ' '), amt(a, r[k])))
        row.appendChild(kv('Checked on this node', r.checked_on_the_node ? 'yes: every listed mint and burn agrees' : 'no'))
        const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(r, null, 1)
        const d = el('details'); d.appendChild(el('summary', 'sub', 'The report')); d.appendChild(pre); row.appendChild(d)
      }
      const b = button('Supply', async () => { try { S.supply[a] = await act('supply', () => run('supply', { asset: a })) } catch (e) { S.supply[a] = { error: e } } render() }, 'ghost')
      b.dataset.action = 'supply'; b.disabled = S.busy
      row.appendChild(b)
      c.appendChild(row)
    }
    root.appendChild(c)
  }

  async function cancelPlan (id) {
    try { await act('plan_cancel', () => run('plan_cancel', { plan: id })) } catch {}
    schedule()
  }

  // Release: the plan's current leaf given up in the next round for a leaf of the wallet's
  // own that no plan names (plan_release); the plan ends once that round is final.
  async function releasePlan (id, leaf) {
    try { await act('plan_release', () => run('plan_release', { leaves: [leaf] })) } catch {}
    schedule()
  }

  async function settle (leaves) {
    try {
      const q = await act('quote', () => run('quote', { leaves }))
      S.quote = { leaves, coins: q.coins }
      render()
    } catch {}
  }

  async function confirmSettle () {
    const q = S.quote
    if (!q) return
    try {
      await act('participate', () => run('participate', { leaves: q.leaves, shown: q.coins }))
      S.quote = null
    } catch {}
    schedule()
  }

  // Each run of the drill is quoted first: what it would broadcast, each fee, and the
  // claim's; the run broadcasts only on the fees shown.
  async function drill (leafId, feeAsset) {
    S.drill = S.drill && S.drill.leaf === leafId ? S.drill : { leaf: leafId, runs: [] }
    const args = { leaf_id: leafId }
    if (feeAsset) args.fee_asset = feeAsset
    try {
      const q = await act('exit_quote', () => run('exit_quote', args))
      S.drill.quote = q
    } catch (e) { S.drill.runs.push({ at: now(), error: e }) }
    render()
  }

  async function drillConfirm () {
    const q = S.drill && S.drill.quote
    if (!q) return
    S.drill.quote = null
    const args = { leaf_id: S.drill.leaf, shown: q.unroll || {} }
    if (q.fee_asset) args.fee_asset = q.fee_asset
    try {
      const v = await act('exit', () => run('exit', args))
      S.drill.runs.push({ at: now(), value: v })
    } catch (e) { S.drill.runs.push({ at: now(), error: e }) }
    schedule()
    render()
  }

  function coinCard (co, s) {
    const d = el('div', 'leaf-coin'); d.dataset.leaf = co.leaf_id; d.dataset.state = co.state
    d.dataset.kind = co.kind || ''; d.dataset.asset = co.asset || ''; d.dataset.value = String(co.value ?? '')
    if (co.standing) d.dataset.standing = co.standing
    for (const k of ['expiry', 'exit_deadline', 'sync_daily_from', 'refresh_from', 'home_from', 'exit_by']) if (co[k] != null) d.dataset[k.replace(/_(\w)/g, (_, x) => x.toUpperCase())] = String(co[k])
    const head = el('div', 'arow-head')
    head.appendChild(el('span', 'tk', tick(co.asset)))
    head.appendChild(el('span', 'grow mono-inline', short(co.leaf_id)))
    head.appendChild(el('span', 'amt', amt(co.asset, co.value)))
    d.appendChild(head)
    d.appendChild(kv('State', co.standing && co.standing !== co.state ? `${co.state} (${co.standing})` : co.state))
    d.appendChild(kv('Kind', co.kind + (co.rests_on_board ? ', rests on a board' : '')))
    d.appendChild(kv('Expiry', when(co.expiry, s.now)))
    d.appendChild(kv('Exit deadline', when(co.exit_deadline, s.now)))
    for (const [k, label] of [['sync_daily_from', 'Synced daily from'], ['refresh_from', 'Refreshed from (the free window)'], ['home_from', 'Taken home from'], ['exit_by', 'Exit by']]) {
      if (co[k] != null) d.appendChild(kv(label, when(co[k], s.now)))
    }
    if (co.exit_fee) d.appendChild(kv('Exit fee coin', [co.exit_fee.fee_coin, co.exit_fee.note].filter(Boolean).join(': ')))
    if (co.batch_profile) { d.dataset.batchProfile = co.batch_profile; d.appendChild(kv('Batch', co.batch_profile === 'issuer-operated' ? 'issuer-operated: its sweep can only burn' : co.batch_profile + ': its sweep pays the operator')) }
    if (co.landing) {
      d.dataset.landing = co.landing
      d.appendChild(kv('Lands at', `${co.landing} (this wallet's landing key: a supervised asset's leaf leaves the tree only there)`))
    }
    if (co.frozen) {
      const fz = !!(co.frozen.frozen || co.frozen.paused)
      d.dataset.frozen = String(fz)
      d.appendChild(kv('Frozen', fz ? (co.frozen.paused ? 'yes: the issuer paused the asset' : 'yes: the issuer froze this landing') : 'no'))
      if (fz) d.appendChild(el('div', 'warn leaf-frozen', frozenSentence(ctx.fmtAtoms(big(co.value), prec(co.asset)), tick(co.asset))))
      if (co.frozen.note) d.appendChild(el('div', 'sub', co.frozen.note))
    }
    const plan = plannedCoins(S.plans).get(co.leaf_id)
    if (plan) { d.dataset.planned = plan.plan_id; d.appendChild(kv('Planned', `plan ${short(plan.plan_id)}, ${plan.state}: paid out of round only once released into the next round`)) }
    if (co.note) d.appendChild(el('div', 'sub', co.note))
    if (co.spent_by) d.appendChild(kv('Spent by', co.spent_by))
    if (HELD.has(co.state) && co.state !== 'exiting') {
      const r = el('div', 'row'); r.style.marginTop = '8px'
      const st = button('Settle now', () => settle([co.leaf_id])); st.dataset.action = 'settle'; st.disabled = S.busy || co.state !== 'live'
      const ex = button('Exit drill', () => drill(co.leaf_id)); ex.dataset.action = 'exit'; ex.disabled = S.busy
      ex.className = 'danger'
      r.appendChild(st); r.appendChild(ex); d.appendChild(r)
    }
    return d
  }

  function renderCoins () {
    const c = card('Leaves and their dates')
    c.id = 'leafCoins'
    const s = S.schedule || {}
    const held = heldCoins(S.coins)
    if (!held.length) c.appendChild(el('div', 'muted', 'No leaves held.'))
    for (const co of held) c.appendChild(coinCard(co, s))
    if (S.quote) {
      const q = el('div', 'warn leaf-quote')
      q.id = 'leafQuote'
      q.appendChild(el('div', null, 'Settle now: each coin is given up for one new leaf in the next round, under a fresh key. The operator\'s fee, coin by coin, before anything is signed:'))
      for (const qc of S.quote.coins || []) q.appendChild(el('div', 'sub', `${short(qc.leaf_id)}: fee ${amt(qc.asset, qc.fee)}, ${qc.ppm} ppm of ${qc.value} (the wallet's bound ${qc.bound_ppm} ppm)`))
      const r = el('div', 'row'); r.style.marginTop = '8px'
      const ok = button('Sign and hand over', () => confirmSettle(), 'primary'); ok.id = 'btnLeafSettleConfirm'
      const no = button('Cancel', () => { S.quote = null; render() }, 'ghost')
      r.appendChild(ok); r.appendChild(no); q.appendChild(r)
      c.appendChild(q)
    }
    const others = (S.coins || []).filter((x) => !HELD.has(x.state))
    if (others.length) {
      const d = el('details'); d.appendChild(el('summary', 'sub', `${others.length} coin(s) no longer held (spent, exited, lost)`))
      for (const co of others) d.appendChild(coinCard(co, s))
      c.appendChild(d)
    }
    root.appendChild(c)
  }

  function renderDrill () {
    if (!S.drill) return
    const c = card('Exit drill')
    c.id = 'leafDrill'
    const coin = (S.coins || []).find((x) => x.leaf_id === S.drill.leaf)
    c.appendChild(el('p', 'sub', 'The leaf is taken on-chain from its record alone, without the operator: each node of its path, then, once the exit delay has run, the claim to one of this wallet\'s addresses. Each run goes as far as the chain allows; run it again, or let sync move it on, until the claim is final.'))
    c.appendChild(kv('Leaf', S.drill.leaf))
    c.appendChild(kv('Its state now', coin ? coin.state : 'unknown'))
    if (coin && coin.state === 'exited') c.appendChild(el('div', 'status ok leaf-final', 'The claim is final: the coin is on-chain, in this wallet.'))
    S.drill.runs.forEach((r, i) => {
      const d = el('div', 'leaf-drill-run'); d.dataset.run = String(i)
      if (r.error) { d.appendChild(el('div', null, `Run ${i + 1}: refused`)); d.appendChild(errBox(r.error)) } else {
        const v = r.value || {}
        d.appendChild(el('div', null, `Run ${i + 1}: ${v.state}`))
        for (const st of exitSteps(v)) d.appendChild(el('div', 'sub', `broadcast ${st.what ? st.what + ' ' : ''}${short(st.txid)}, ${st.vsize} vB, fee ${st.fees.map((f) => amt(f.asset, f.amount)).join(' + ') || 'none'}`))
        if (v.claim) d.appendChild(el('div', 'sub', `claim ${typeof v.claim === 'string' ? v.claim : v.claim.txid}`))
        if (v.next) d.appendChild(el('div', 'sub', 'next: ' + v.next))
        if (v.error) d.appendChild(el('div', 'sub leaf-refusal', v.error))
        if (v.note) d.appendChild(el('div', 'sub', v.note))
      }
      c.appendChild(d)
    })
    if (S.drill.quote) {
      const q = S.drill.quote
      const box = el('div', 'warn leaf-quote'); box.id = 'leafExitQuote'
      box.appendChild(el('div', null, (q.steps || []).length ? 'This run broadcasts, before anything is signed for the chain:' : 'This run broadcasts nothing before the claim.'))
      ;(q.steps || []).forEach((st, i) => box.appendChild(el('div', 'sub', `transaction ${i + 1}: ${st.vsize} vB, fee ${(st.fee || []).map((f) => amt(f.asset, f.amount)).join(' + ') || 'none'}, paid from ${st.paid_by}`)))
      const cl = q.claim || {}
      box.appendChild(el('div', 'sub', cl.error ? `the claim: ${cl.error}` : `the claim, once the leaf is in a block and its exit delay of ${q.exit_delay_seconds} s has run: fee about ${(cl.fee || []).map((f) => amt(f.asset, f.amount)).join(' + ') || 'none'} at the floor then`))
      const r2 = el('div', 'row'); r2.style.marginTop = '8px'
      const ok = button('Broadcast on these fees', () => drillConfirm(), 'danger'); ok.id = 'btnLeafExitConfirm'; ok.disabled = S.busy
      const no = button('Cancel', () => { S.drill.quote = null; render() }, 'ghost')
      r2.appendChild(ok); r2.appendChild(no); box.appendChild(r2)
      c.appendChild(box)
    } else if (!coin || coin.state !== 'exited') {
      const b = button('Run the exit again', () => drill(S.drill.leaf)); b.id = 'btnLeafExitAgain'; b.disabled = S.busy
      const r = el('div', 'row'); r.style.marginTop = '8px'; r.appendChild(b); c.appendChild(r)
    }
    root.appendChild(c)
  }

  function renderParticipations () {
    const c = card('Participations')
    c.id = 'leafParticipations'
    if (!(S.participations || []).length) c.appendChild(el('div', 'muted', 'None.'))
    for (const p of S.participations || []) {
      const d = el('div', 'leaf-participation'); d.dataset.state = p.state
      d.appendChild(kv('Participation', short(p.participation)))
      d.appendChild(kv('State', p.state + (p.released && p.state !== 'released' ? ', released' : '')))
      if (p.round) d.appendChild(kv('Round', p.round))
      for (const g of p.gives || []) d.appendChild(el('div', 'sub', `gives ${short(g.leaf_id)} (${g.state})`))
      for (const n of p.new_leaves || []) d.appendChild(el('div', 'sub', `new leaf ${n.leaf_id ? short(n.leaf_id) : 'not yet held'}: ${amt(n.asset, n.value)}${n.state ? ' (' + n.state + ')' : ''}`))
      c.appendChild(d)
    }
    root.appendChild(c)
  }

  function renderRefusals () {
    const c = card('Refusals')
    c.id = 'leafRefusals'
    c.appendChild(el('p', 'sub', 'Every refusal the leaf wallet made, in its own words.'))
    const list = Array.isArray(S.refusals) ? S.refusals : (S.refusals && S.refusals.refusals) || []
    if (!list.length) c.appendChild(el('div', 'muted', 'None.'))
    for (const r of list.slice(-50).reverse()) c.appendChild(el('div', 'sub leaf-refusal', `${r.at ? new Date((r.at > 1e12 ? r.at : r.at * 1000)).toISOString() + ' ' : ''}${r.what ? r.what + ': ' : ''}${r.reason || r.message || JSON.stringify(r)}`))
    root.appendChild(c)
  }

  function renderSettings () {
    settingsRoot.innerHTML = ''
    const c = card(MODE_WORDS.title)
    c.id = 'walletModeCard'
    const current = walletMode(ctx.store, tag())
    for (const m of ['user', 'developer']) {
      const lab = el('label', 'mode-choice'); lab.style.display = 'flex'; lab.style.flexWrap = 'nowrap'; lab.style.gap = '8px'; lab.style.alignItems = 'flex-start'; lab.style.marginTop = '6px'
      const r = el('input'); r.type = 'radio'; r.name = 'walletMode'; r.value = m; r.id = m === 'user' ? 'modeUser' : 'modeDeveloper'
      r.style.width = 'auto'; r.checked = current === m
      r.onchange = () => { if (r.checked) changeMode(m) }
      r.style.flex = '0 0 auto'; r.style.marginTop = '3px'
      const t = el('span'); t.style.flex = '1 1 auto'
      t.appendChild(el('b', null, MODE_WORDS[m]))
      t.appendChild(el('div', 'sub', m === 'user' ? MODE_WORDS.userLine : MODE_WORDS.developerLine))
      lab.appendChild(r); lab.appendChild(t); c.appendChild(lab)
    }
    c.appendChild(el('p', 'sub', MODE_WORDS.note))
    if (dev() && S.open && S.info) {
      c.appendChild(kv('Operator server', S.info.server))
      c.appendChild(kv('Operator key (pinned)', S.info.operator))
      c.appendChild(kv('Node', S.info.node))
      c.appendChild(kv('Chain', `${S.info.chain} · ${short(S.info.genesis_hash)}`))
      c.appendChild(kv('Mailbox key', S.info.mailbox_key))
      if (S.info.keepers && S.info.keepers.note) c.appendChild(el('div', 'sub', S.info.keepers.note))
    }
    settingsRoot.appendChild(c)
  }

  // The leaf wallet stays open across a change of mode: only what is shown, and what a
  // page may reach, follows it.
  async function changeMode (m) {
    setWalletMode(ctx.store, tag(), m)
    if (ctx.onModeChange) try { ctx.onModeChange(m) } catch {}
    if (m === 'developer') { try { await start() } catch (e) { S.error = { what: 'open', e } } }
    else watchMailbox()
    render()
  }

  // ---- for the page API (wallet-api.js): the library's commands, one at a time ----
  async function command (cmd, args) {
    if (!S.open) throw new LeafError({ kind: 'refused', message: 'this wallet has not joined a leaf operator: join one in the wallet\u2019s Leaves tab' })
    return await asking(() => act(cmd, () => paying(cmd, args || {})))
  }
  // One on-chain address of the leaf wallet, the same each time a page asks: taking a
  // new one on every ask would let a page grow the wallet's scan without end.
  async function address () {
    const key = tagged(ADDRESS_KEY, tag())
    try { const v = JSON.parse(ctx.store.getItem(key) || 'null'); if (v && v.address) return v } catch {}
    const a = await command('address')
    const v = { address: a.address, script_pubkey: a.script_pubkey }
    try { ctx.store.setItem(key, JSON.stringify(v)) } catch {}
    return v
  }

  // `quick`: the code shown before is shown at once while it has a day before it lapses, without
  // waiting for the library (busy with the sync that opens it); a coin that arrives meanwhile
  // (leafArrived) has the page ask again, and then the library says whether it was paid.
  async function receiveCode ({ quick = false } = {}) {
    const key = tagged(CODE_KEY, tag())
    let kept = null; try { kept = JSON.parse(ctx.store.getItem(key) || 'null') } catch {}
    if (quick && kept && kept.text && kept.until && kept.until - now() / 1000 > CODE_MARGIN_S) return kept
    if (kept && kept.text && kept.owner) {
      let s = null; try { s = await asking(() => run('schedule')); S.schedule = s } catch {}
      const r = ((s && s.receive_requests) || []).find((x) => x.owner === kept.owner)
      if (r && r.state === 'waiting' && (r.lapses_at == null || r.lapses_at - ((s && s.now) || 0) > CODE_MARGIN_S)) return kept
    }
    const v = await command('receive', {})
    const out = { text: v.request, owner: (v.details && v.details.owner) || null, until: (v.details && v.details.until) || null }
    try { ctx.store.setItem(key, JSON.stringify(out)) } catch {}
    return out
  }

  const api = {
    state: S,
    render,
    start: async () => { try { await start() } catch (e) { S.error = { what: 'open', e }; render() } },
    // Leaf atoms of an asset, for the Balance tab's rows and headline total.
    mode: () => walletMode(ctx.store, tag()),
    setMode: (m) => changeMode(m),
    isOpen: () => S.open,
    command,
    // A command for the user composer, asked directly (no reload after it), paid through
    // the next round when it needs a planned coin.
    pay: (cmd, args) => {
      if (!S.open) return Promise.reject(new LeafError({ kind: 'refused', message: 'this wallet holds no leaves' }))
      return asking(() => paying(cmd, args || {})).catch((e) => { throw dev() ? e : plainRefusal(e) })
    },
    // What of an asset its issuer has frozen for this wallet, in atoms (both modes).
    frozenAtoms: (hex) => frozenAtoms(S.coins, S.balance).get(hex) || 0n,
    // The assets the operator serves supervised.
    supervisedAssets: () => supervisedAssets(S.info),
    address,
    leafAtoms: (hex) => { const b = leafBalances(S.balance).get(hex); return b ? b.leaves : 0n },
    leafAssets: () => [...leafBalances(S.balance).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a),
    syncNow,
    // ---- default mode (default-arca.js) ----
    // What of an asset is arriving (held, not yet spendable), in atoms.
    arriving: (hex) => arrivingAtoms(S.balance, hex),
    // The receive code a payment to `text` would go in the tree under, or null.
    treeRoute: (text) => (S.open ? treeRoute(text, S.info) : null),
    // A receive request as a receive code carries it (short, or the library's spelling) as the
    // library's request this wallet pays in the tree, or null when it is for another operator.
    payable: (text) => (S.open ? expandRequest(text, S.info) : null),
    // The receive code default mode shows: the one shown before while it is unpaid and has a
    // day before it lapses, or a new one. -> { text, owner }
    receiveCode,
    // Pays a receive code in the tree, as a person asked (first in line, through the next round
    // when it needs a planned coin), and reads what it moved.
    payCode: (text, amount, asset) => {
      const t0 = now()
      return asking(async () => {
        while (S.busy) await sleep(50)
        const t1 = now()
        const v = await act('send', () => paying('send', { request: text, amount: String(amount), asset })).catch((e) => { throw dev() ? e : plainRefusal(e) })
        log(`[leaves] send: waited ${t1 - t0} ms for the wallet, paid in ${now() - t1} ms`)
        if (ctx.onChange) try { ctx.onChange() } catch {}
        return v
      })
    },
    // A payment to an address out of the tree, paid in the operator's next settlement: the
    // library's quote, then the payment made only on that quote (`shown`).
    offboardQuote: (args) => command('offboard_quote', args),
    offboard: (args) => command('offboard', args).then((v) => { if (ctx.onChange) try { ctx.onChange() } catch {} return v }),
    // The operator's interval between settlements, in seconds, or null.
    roundInterval: () => { const f = S.info && S.info.server_info && S.info.server_info.fills; return (f && f.round_interval_seconds) || null },
    // Boards the chain's new coins soon (the page calls it when its own scan sees them).
    boardSoon: () => { if (S.open && !dev()) upkeepSoon(2000) },
    releaseFor: (asset, leaves) => releaseFor(asset, leaves),
    refreshSoon: () => refreshSoon(),
    joinError: () => S.joinError || null,
    stop: () => { clearTimeout(S.timer); clearTimeout(S.upkeepTimer); clearTimeout(S.joinTimer); clearTimeout(S.mailTimer); clearTimeout(S.refreshTimer) },
  }
  render()
  return api
}
