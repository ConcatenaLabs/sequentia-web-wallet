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
// signs a plan for a leaf of a round once its first step could run within the library's
// reach (ten days), so a leaf stays free to trade and pay out of round for most of its life,
// and a wallet closed across its expiry keeps it; one closed earlier and kept away past the
// expiry finds the coin repaid by the operator, less its late-refresh fee. A coin
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
//   onEvent(name, data) the leaf events: 'leafArrived', 'leafSyncDue', 'codeUsed' (the receive
//                       code kept for Receive was paid or lapsed: show a new one)
//   askFaucet(body)     optional: asks the testnet faucet to pay a receive request as a leaf
//                       ({ request, asset? }); answers the faucet's JSON or throws its error
//   claimScan()         optional: how many receive keys `care` looks for claims under
//                       (the kit wallet's next receive index and 20 more)
//   careEveryMs         optional: how often `care` runs at most (default CARE_EVERY_MS)
//   refreshNeedMs       optional: how often the library's refresh rule is asked (default REFRESH_NEED_MS)
//   claimsEveryMs       optional: how often `claims` is read at most (default CLAIMS_EVERY_MS)
//   boardRoom(asset)    optional: how many more atoms of the asset the wallet moves into the tree
//                       by itself (ark-limits.js), null for no limit
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
//   holdsTx(txid)       optional: whether the page's own reading of the chain holds a transaction
//                       (true, false, or undefined when it cannot tell): a board's coins come off
//                       that reading exactly until it holds the board (onchainLessBoards)

// The mode's words, the same in every Sequentia wallet (this one, the extension and
// Ambra): change them in all three together.
import { expandRequest } from './pay-code.js'
import { pinnedOperator, defaultWatchtowers, checkPinned, treeRoute, arrivingAtoms, redoingAtoms, keptSafeAtoms, anchorDepth, boardCandidates, boardAll, boardSpent, onchainLessBoards, JOIN_RETRY_MS, CLAIMS_EVERY_MS, vestingLots, vestingAtoms, vestingAssets, vestingFor, vestingRefusal, vestedOpen,
  homeCoins, unreachableOf, homeQuote as quoteHome, homeTake, homeUnderWay as underWay } from './default-arca.js'

export const MODE_WORDS = Object.freeze({
  title: 'Mode',
  user: 'User mode',
  userLine: 'One figure per asset, and the wallet chooses how value moves.',
  developer: 'Developer mode',
  developerLine: 'Every way the wallet can move value, side by side, each with its own balance and controls, and the developer tools.',
  note: 'Kept for this wallet. Sites that ask the wallet for its mode follow it.',
})

export const MODE_KEY = 'swk.mode'                  // + '.' + the wallet's tag
export const LEGACY_DEV_MODE_KEY = 'swk.devMode'     // one setting for every wallet, before
export const JOINED_KEY = 'swk.leaves.joined'        // + '.' + tag: this wallet joined an operator
export const ADDRESS_KEY = 'swk.leaves.address'      // + '.' + tag: the leaf address handed to pages
export const NODE_PASSWORD_KEY = 'swk.leaves.nodePassword'
export const CODE_KEY = 'swk.leaves.code'            // + '.' + tag: the receive code default mode shows
export const BOARDS_KEY = 'swk.leaves.boardSpent'   // + '.' + tag: what a board just made spent on the chain
export const RESTORED_KEY = 'swk.leaves.restored'    // + '.' + tag: the join's restore has run to its end
// A first restore the operator did not answer is asked again this often, until it answers.
export const RESTORE_RETRY_MS = 30_000
// A first restore still running after RESTORE_SLOW_MS is a long history being checked: the page
// says it takes a few minutes. One still running after RESTORE_LONG_MS takes far longer than any
// history should: the page says so, and a payment waiting for it stops waiting.
export const RESTORE_SLOW_MS = 120_000
export const RESTORE_LONG_MS = 1_800_000
export const BALANCE_KEY = 'swk.leaves.balance'      // + '.' + tag: the library's last balance, shown until it opens
export const PLACES_KEY = 'swk.leaves.places'        // + '.' + tag: the library's last coin_places, with that balance
export const VESTING_KEY = 'swk.leaves.vesting'      // + '.' + tag: what vests later, as `claims` last listed it
export const HOME_KEY = 'swk.leaves.home'            // + '.' + tag: the coins a person sent home, and when
// A receive code is shown again while it has at least this long before it lapses.
export const CODE_MARGIN_S = 86_400

// Whether the receive code `kept` can still be shown, by the schedule read at `readAt` (ms): a
// paid request leaves `receive_requests`, a lapsed one is no longer `waiting`, and one near its
// lapse is shown no more. -> false when the schedule says it is used up, true when it says it is
// open, null when it cannot say (no schedule, or one read before the code was handed out: a new
// request is not in an older list). A receive code is paid once: the operator refuses a second
// payment to its key (409 key_reused).
export function codeOpen (kept, schedule, readAt) {
  if (!kept || !kept.owner || !schedule || readAt == null || readAt < (kept.made || 0)) return null
  const r = (schedule.receive_requests || []).find((x) => x.owner === kept.owner)
  return !!r && r.state === 'waiting' && (r.lapses_at == null || r.lapses_at - (schedule.now || 0) > CODE_MARGIN_S)
}
// User mode: how often the open page reads the wallet's mailbox, so that a payment to its receive
// code shows within seconds rather than at the schedule's next sync.
export const MAILBOX_POLL_MS = 10_000
export const MAILBOX_QUIET_MS = 20_000
// A payment another service says it made to the wallet's receive code (the faucet's): how long the
// page reads the mailbox for it, and how often, before it says the coin is still on its way.
export const TAKE_IN_MS = 45_000
export const TAKE_IN_EVERY_MS = 2_000
// How often user mode asks the library to refresh what it received out of round.
export const REFRESH_EVERY_MS = 120_000
// What the wallet received out of round is refreshed when the library says it must
// (`refresh_needed`, D95: a coin one reassignment short of the operator's limit, more than half of
// what the wallet may hold out of round over every asset, a coin near its expiry, or the person
// gone REFRESH_IDLE_MS). The page asks it every REFRESH_NEED_MS and at once on every receipt, and
// counts the person's idle time. A coin given up in a round is not spendable until the round is
// final, so a wallet in use gives up only what must go now.
export const REFRESH_IDLE_MS = 120_000
export const REFRESH_NEED_MS = 30_000
// How soon the refresh rule is asked again when an ask at once met the wallet's own upkeep.
export const NEED_RETRY_MS = 2_000
// The arguments of the library's `refresh_needed`: the whole seconds since the person last asked
// anything of the wallet (or opened it).
export function refreshNeededArgs (lastAsked, openedAt, at) {
  return { idle_seconds: Math.max(0, Math.floor((at - Math.max(lastAsked || 0, openedAt || 0)) / 1000)) }
}
// How long care opens no channel in an asset after a payment closed one to spend its side, so a
// person sending it has the time a payment takes, reloads included (kept in the store): ten
// minutes for an asset of the tree, whose round is final in a Sequentia block; an hour for
// Bitcoin, whose blocks come every ten minutes or slower. Channels are still read and folded.
export const CHANNEL_HOLD_AFTER_MS = 10 * 60_000
export const CHANNEL_HOLD_BTC_MS = 60 * 60_000
export const CHANNEL_HOLDS_KEY = 'leaves.channelHolds'
export function channelHoldMs (asset) { return asset === 'BTC' ? CHANNEL_HOLD_BTC_MS : CHANNEL_HOLD_AFTER_MS }
// The assets whose hold `holds` ({ asset: until }) still runs at `at`.
export function heldAssets (holds, at) {
  return Object.entries(holds || {}).filter(([, until]) => Number(until) > at).map(([a]) => a).sort()
}
// Whether user mode refreshes what it receives out of round by itself: on unless the page sets
// window.SEQ_REFRESH_RECEIVED = false. The library gives a coin up only where the operator can
// fund its refresh and takes back a refresh that waits, so a coin received stays the wallet's to pay with.
export function refreshReceivedOn () {
  try { return !(typeof window !== 'undefined' && window.SEQ_REFRESH_RECEIVED === false) } catch { return true }
}
// How a command's time is said in its slow line: its own part, and the wait, named after the
// commands it waited behind (`behind`, each once, in the order asked), or "other commands" when the
// page knows none (web wallet #667).
export function waitedWords (own, waited, behind = []) {
  const who = behind && behind.length ? [...new Set(behind)].join(', ') : 'other commands'
  return ` (own ${own} ms, waited ${waited} ms behind ${who})`
}

// The library's commands that only read (bark/src/arca/command.rs reads_only): a quote's.
export const COMPOSER_READS = new Set(['address', 'balance', 'coins', 'record', 'refusals', 'participations', 'schedule', 'orders',
  'swaps', 'plans', 'info', 'supply', 'board_quote', 'quote', 'settle_quote', 'take_quote', 'order_fill_quote', 'order_quote',
  'order_rest_quote', 'order_fill_resting_quote', 'order_cancel_resting_quote', 'offboard_quote', 'lightning_pay_quote',
  'lightning_receive_quote', 'plan_quote', 'swap_read', 'btc_swap_read'])
// User mode: the watch of the operator's bond (which may read a long stretch of the chain, and
// holds the wallet while it does) runs at most this often, and only once the page has been
// left alone for BOND_QUIET_MS; the bond itself is read at care's pace in either mode.
export const BOND_WATCH_EVERY_MS = 3600_000
export const BOND_QUIET_MS = 120_000
export const TICK_MS = 60_000
// How often `care` runs at most, after a sync or a tick of the schedule.
export const CARE_EVERY_MS = 10 * 60_000
// A payment through a release: how often the wallet syncs while it waits for the round
// that frees the planned coins, how long it waits at most, and how many releases one
// payment may need (a release can fall short by the new leaf's own margins).
export const RELEASE_POLL_MS = 15_000
// How often a payment that waits for the wallet's own round reads whether it has ended.
export const ROUND_POLL_MS = 5_000
export const RELEASE_WAIT_MS = 3 * 3600_000
export const RELEASE_TRIES = 3

// The arguments `care` runs with: the page's claim scan, and the wallet's channels cared for
// (each read and its credit folded, and one opened in each asset the operator makes channels
// of, from half of the wallet's leaves of it). Its planning reach is the library's own: a leaf
// of a round is planned once its first step could run within ten days.
// While a payment closes a channel to spend its side (`holdChannels`), care neither reads, folds nor
// opens channels, so it never puts half of the side just freed back into a channel before the
// payment is made.
// `noOpen` names the assets care opens no channel in (held after a payment, being sent, or held too
// little of): their channels are still read and folded.
// In default mode (`channels` false) care neither opens nor folds a channel: the wallet keeps its
// money in coins, and closes any channel it still holds into a coin at the next round
// (`channelsToClose`).
export function careArgs (scan, holdChannels = false, noOpen = [], channels = true) {
  const a = { channels: channels && !holdChannels }
  if (!channels) { if (scan) a.scan = scan; return a }
  if (scan) a.scan = scan
  if (!holdChannels && noOpen && noOpen.length) a.no_open = [...new Set(noOpen)].sort()
  return a
}

// How often an open page in user mode reads its channels from the operator while it is in
// view and was used, opened or paid within CHANNEL_FAST_FOR_MS: a payment into one is in the
// asset's figure within this and the read's own time. Otherwise (out of view, or left alone) it
// reads them every CHANNEL_POLL_IDLE_MS. Each read runs the library's witness, which the
// operator hands out at a bounded rate, so only wallets in use read fast.
export const CHANNEL_POLL_MS = 300
export const CHANNEL_POLL_IDLE_MS = 5000
export const CHANNEL_FAST_FOR_MS = 3 * 60_000

const bigOf = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The credit a channel read brought in: each channel whose credit grew, and by how much.
export function channelArrivals (before, after) {
  const was = new Map((before || []).filter((c) => c && !c.error).map((c) => [c.leaf_id, bigOf(c.credit)]))
  const out = []
  for (const c of after || []) {
    if (!c || c.error || !was.has(c.leaf_id)) continue
    const d = bigOf(c.credit) - was.get(c.leaf_id)
    if (d > 0n) out.push({ leaf_id: c.leaf_id, asset: c.asset, atoms: d })
  }
  return out
}

// The wallet's channels a payer can pay now, by asset (live, their round final): what a
// receive code names (the library's `receive` puts them under `channels`).
export function payableChannels (channels) {
  const m = {}
  for (const c of channels || []) if (c && c.coin_state === 'live' && c.final === true && !(c.asset in m)) m[c.asset] = c.leaf_id
  return m
}

// Default mode's instant limit: 500 US dollars, in atoms of the reference unit (an atom is a
// hundred-millionth of a dollar). The library counts a payment received as the wallet's own at
// once up to it (the lowest of this, the operator's suggestion and the bond's share), and shows
// one past it as arriving until a round makes it the wallet's (the library's `coin_places`).
// Developer mode sets none: every payment counts at once there, as it always has.
export const DEFAULT_INSTANT_LIMIT = '50000000000'
export function instantLimitArgs (developer) { return { value: developer ? 'off' : DEFAULT_INSTANT_LIMIT } }
// The library's `require_checkpoint_exit` for the mode: on in default mode once the operator offers
// the exit (the leaf wallet's `info`, its `server_info.checkpoint_exit`), off otherwise.
export function requireExitArgs (developer, info) {
  const offered = !!(info && info.server_info && info.server_info.checkpoint_exit === true)
  return { on: !developer && offered }
}
// What to set `require_checkpoint_exit` to now, given the leaf wallet's `info` as last read, the
// switch as last set (`applied`, its arguments as JSON, or null when not set this session) and
// whether this wallet's operator has ever offered the exit (`seen`, kept in the store for the
// wallet and that operator): the mode's
// arguments when they differ from it, else null. In default mode the switch only ever goes on: once
// the operator has offered the exit, an answer that no longer offers it (or an older operator's,
// without the field) leaves it on, so an operator cannot take the exit away by what it says, and
// trades it cannot make with the exit read "Not offered right now". An `info` without the
// operator's answer (it could not be reached) changes nothing. Developer mode is off whatever the
// operator says.
export const EXIT_SEEN_KEY = 'leaves.exitSeen'
export function exitSwitch (developer, info, applied, seen = false) {
  const si = info && info.server_info
  const reached = !!si && typeof si === 'object' && !si.unreachable
  let args
  if (developer) args = { on: false }
  else if (seen || (reached && si.checkpoint_exit === true)) args = { on: true }
  else if (!reached || applied != null) return null
  else args = { on: false }
  return JSON.stringify(args) === applied ? null : args
}

// What of each asset is arriving, by the library's places (`coin_places`): coins received past
// the instant limit, coins not final yet, and coins on their way home on the chain (`exiting`):
// what the wallet cannot trade or send until a round, or its claim, has made it its own. Default
// mode's figure leaves it out. -> Map(asset -> BigInt)
export function arrivingByAsset (places) {
  const m = new Map()
  for (const c of arrivingCoins(places)) m.set(c.asset, (m.get(c.asset) || 0n) + c.atoms)
  return m
}
// The coins arriving, each { leaf_id, asset, atoms }, in the library's order.
export function arrivingCoins (places, claims = {}) {
  const out = []
  for (const c of (places && Array.isArray(places.coins)) ? places.coins : []) {
    if (c && c.place === 'arriving') out.push({ leaf_id: c.leaf_id, asset: c.asset, atoms: bigOf(c.value), state: c.state, kind: c.kind, channel: c.channel === true, claimFrom: claims[c.leaf_id] || null })
  }
  return out
}
// The coins a refresh gives up (`refresh_received`'s `leaves`): when the only rule the library's
// `refresh_needed` gives is `arriving`, those coins alone, so what counts already stays spendable;
// otherwise every received coin (null).
export function refreshLeaves (needed) {
  // The rule `shape` names coins settled on their own (shapeCoins), not by this refresh.
  const reasons = ((needed && Array.isArray(needed.reasons)) ? needed.reasons : []).filter((r) => r && r.rule !== 'shape')
  if (!reasons.length || reasons.some((r) => r.rule !== 'arriving')) return null
  return [...new Set(reasons.flatMap((r) => r.coins || []))]
}

// The wallet's coins of `asset` its own refresh holds in a round (`given` or `forfeited`): in the
// figure, as the person's own money being moved, yet past being taken back for a payment. A
// payment they would make waits for that round (`paying`), about a minute, and then goes ahead.
export function inRoundCoins (coins, asset) {
  return (coins || []).filter((c) => c && c.asset === asset && (c.state === 'given' || c.state === 'forfeited')).map((c) => c.leaf_id)
}

// When each coin coming home from a dead trade can be claimed home (median time, seconds), by leaf
// id, from the library's `swaps`: each entry `returning`, its `return.coins` (one with its
// `claim_from` absent is left out: its time is not known yet).
export function returnClaims (swaps) {
  const out = {}
  for (const s of Array.isArray(swaps) ? swaps : []) {
    if (!s || s.state !== 'returning' || !s.return) continue
    for (const c of s.return.coins || []) if (c && c.leaf_id && Number(c.claim_from) > 0) out[c.leaf_id] = Number(c.claim_from)
  }
  return out
}

// The channel coins default mode closes into plain coins at the next round: each live one.
export function channelsToClose (channels) {
  return (channels || []).filter((c) => c && c.coin_state === 'live' && c.leaf_id).map((c) => c.leaf_id)
}

// Whether a kept receive code names the channels the wallet can be paid over now: a code
// made before a channel opened (or after it closed) is made again.
export function codeNamesChannels (kept, channels) {
  const now = payableChannels(channels)
  const had = (kept && kept.channels) || {}
  const ka = Object.keys(had).sort(); const na = Object.keys(now).sort()
  return ka.length === na.length && ka.every((a, i) => a === na[i] && had[a] === now[a])
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

// A refusal for developer mode: the plain sentence first, when there is one, then the server's own
// words in brackets ("This receive code was paid already… (… 409 key_reused …)"), so a developer
// reads what to do as well as what the server said.
export function devRefusal (e) {
  const p = plainRefusal(e)
  if (p === e) return e
  return new LeafError({ kind: p.kind, code: p.code, status: p.status, message: `${p.message} (${String((e && e.message) || e)})` })
}

// A refusal for user mode: the bond's, a frozen coin's and one the operator declines said
// plainly; every other refusal as it is.
export function plainRefusal (e) {
  const m = String((e && e.message) || '')
  // The operator's own reason, when it asks for the wallet to be updated: said so, plainly.
  if (e && e.code === 'declined' && /\bupdate the wallet\b/i.test(m)) return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: UPDATE_WORDS })
  if (e && e.code === 'declined') return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: DECLINED_WORDS })
  // The bond stands, but the wallet holds what it was paid in the last minutes out of round up to
  // what the bond covers: it takes more once those coins are settled in the next round.
  if (holdingRefusal(e)) return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: BOND_WORDS.holding })
  if (bondRefusal(e)) return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: BOND_WORDS.refused })
  // A coin that has not vested (the operator's `vesting`): its date, plainly.
  const vested = vestingRefusal(e)
  if (vested) return new LeafError({ kind: e.kind || 'refused', code: e.code, status: e.status, message: vested })
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
// The operator declines what an out-of-date wallet asks (one that hands its forfeits over only
// after a round is broadcast, to an operator building batches without a sweep), and says to
// update it: in its words, plainly.
export const UPDATE_WORDS = 'This wallet is out of date for this: update it, then try again. Nothing was taken.'

export const CODE_PAID_WORDS = 'This receive code was paid already: ask for a new one. Nothing was sent.'

// A refusal of the operator's equivocation bond (missing, in notice, or worth less than
// what the wallet would hold out of round on it): the library's gate, said plainly.
export function bondRefusal (e) {
  return /\bbond\b/i.test(String((e && e.message) || ''))
}
export const BOND_WORDS = Object.freeze({
  refused: 'Not accepted: the security deposit that backs these instant payments is missing or being withdrawn, so this wallet takes no payment that rests on it. Nothing was signed.',
  holding: 'Not yet: this wallet is settling what it was just paid, and takes a new instant payment once that is done, in a few minutes. Nothing was signed.',
})
// The library's refusal of a payment that would leave the wallet holding more out of round than
// the operator's bond covers, or than its instant budget: the bond stands, and room comes back
// once what the wallet holds is refreshed in a round.
export function holdingRefusal (e) {
  return /would hold out of round/i.test(String((e && e.message) || ''))
}

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
    // A payment the wallet's side of its channels could cover: which channel leaves to close.
    if (e && Array.isArray(e.close)) this.close = e.close
    // A spend that waits only for a round (`settle_first`): the coins to put through it first.
    if (e && Array.isArray(e.coins)) this.coins = e.coins
    // And, for a payment to a receive code, the most it can pay once they are closed and that
    // payment's fee, with the leaves the close gives back counted (the library's `most`, `fee`).
    if (e && e.most != null) this.most = String(e.most)
    if (e && e.fee != null) this.fee = String(e.fee)
    // What the command cost before it was refused, where the library says (its `cost`).
    if (e && e.cost) this.cost = e.cost
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

// A list of the library's answer, or none: a part the library could not read comes as `{ error }`
// in its list's place (a sync with the operator gone answers `participations` so), never a list.
export function listOf (v) { return Array.isArray(v) ? v : [] }
// That part's refusal, in the library's words, or null.
export function partError (v) {
  if (!v || Array.isArray(v) || typeof v !== 'object' || v.error == null) return null
  return typeof v.error === 'string' ? v.error : String(v.error.message || JSON.stringify(v.error))
}

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
// The last transaction an exit drill broadcast (its claim, else its last step), for Speed up.
export function lastBroadcast (runs) {
  for (const r of [...(runs || [])].reverse()) {
    const v = r && r.value
    if (!v) continue
    if (v.claim) return typeof v.claim === 'string' ? v.claim : v.claim.txid
    const steps = v.broadcast || []
    if (steps.length) return steps[steps.length - 1].txid
  }
  return null
}

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
// The coins the library's rule `shape` names (`refresh_needed`): too deep for part of them to be
// traded, so they go through the next round first (`settle_first`). The library names them at once
// while the wallet keeps another coin of the asset that still trades and the operator refreshes
// them for nothing, else only once the person has left the wallet alone.
export function shapeCoins (needed) {
  const reasons = (needed && Array.isArray(needed.reasons)) ? needed.reasons : []
  return [...new Set(reasons.filter((r) => r && r.rule === 'shape').flatMap((r) => r.coins || []))]
}
// The library's `settle_first` arguments for the rule `shape`'s coins: cut into a few coins of the
// asset when the rule says so (`spread`, so the wallet trades on from one while another is in a
// round), and never at more than the fee bound the rule gives (`max_fee_ppm`: 0 while the person
// uses the wallet, since nobody asked for that refresh). -> null when the rule names no coin.
export function shapeSettleArgs (needed) {
  const coins = shapeCoins(needed)
  if (!coins.length) return null
  const rules = ((needed && Array.isArray(needed.reasons)) ? needed.reasons : []).filter((r) => r && r.rule === 'shape')
  const args = { coins }
  if (rules.some((r) => r.spread === true)) args.spread = true
  const bounds = rules.map((r) => r.max_fee_ppm).filter((f) => f != null && Number.isFinite(Number(f))).map(Number)
  if (bounds.length) args.max_fee_ppm = Math.min(...bounds)
  return args
}
// Whether `refresh_needed`'s answer asks for a refresh of what was received (`refresh_received`): a
// rule other than `shape`, whose coins are settled on their own (shapeSettleArgs).
export function receivedRefreshAsked (needed) {
  const reasons = (needed && Array.isArray(needed.reasons)) ? needed.reasons : []
  return reasons.some((r) => r && r.rule !== 'shape')
}
// ---------------------------------------------------------------------------

export function mountLeaves (ctx, root, settingsRoot) {
  const { el } = ctx
  const now = ctx.now || (() => Date.now())
  const tickMs = ctx.tickMs || TICK_MS
  const careEvery = ctx.careEveryMs || CARE_EVERY_MS
  const needEvery = ctx.refreshNeedMs || REFRESH_NEED_MS
  const claimsEvery = ctx.claimsEveryMs || CLAIMS_EVERY_MS
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = (m) => { try { (ctx.log || console.log)(m) } catch {} }
  const S = { client: null, open: false, busy: false, balance: null, coins: [], participations: [], schedule: null,
    refusals: [], last: null, drill: null, quote: null, timer: null, showHistory: false, error: null, info: null, form: {},
    careAt: null, lastCare: null, plans: null, claims: null, distributions: null, kept: null, claimsAt: null, vesting: null }
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
  // One action at a time: a click while sync runs waits for it rather than being lost. What the
  // action changed is read again before it answers; with `answerFirst` (a payment a person waits
  // on), it answers as soon as the library has, and the read follows (reloadAfter).
  async function act (what, f, { answerFirst = false } = {}) {
    S.queued = (S.queued || 0) + 1
    if (S.busy) render()
    while (S.busy) await new Promise((r) => setTimeout(r, 100))
    S.queued--
    S.busy = true; S.error = null; render()
    const t0 = now()
    try {
      const v = await f()
      S.last = { what, value: v }
      return v
    } catch (e) {
      S.error = { what, e }
      throw e
    } finally {
      // An action that held the wallet over ten seconds says so, by name: every command asked
      // meanwhile waited for it, and their own lines show only the wait. One whose own command
      // only waited behind another (the library runs one command at a time) says that instead,
      // so the line names the action that held it, never one that waited.
      if (now() - t0 > 10000) {
        const r = S.lastRun
        if (r && r.at >= t0 && r.waited > 10000) log(`[leaves] ${what} waited ${r.waited} ms behind another library command (its own ${r.command} took ${r.own} ms)`)
        else log(`[leaves] ${what} held the wallet ${now() - t0} ms`)
      }
      if (answerFirst) reloadAfter()
      else { try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e } }
      S.busy = false
      render()
    }
  }

  // The wallet read again after an action, once nothing else runs: a command asked meanwhile (the
  // next step of what a person asked) goes first, and the read waits for the next free moment.
  function reloadAfter (ms = 0) {
    S.reloadDue = true
    clearTimeout(S.reloadTimer)
    S.reloadTimer = setTimeout(async () => {
      if (!S.reloadDue || !S.open) return
      if (S.busy || S.queued || S.asked) { reloadAfter(200); return }
      S.busy = true
      try { await reload({ yieldTo: () => S.queued > 0 || S.asked > 0 }); S.reloadError = null } catch (e) { S.reloadError = e } finally { S.busy = false; render() }
    }, ms)
    if (S.reloadTimer && typeof S.reloadTimer.unref === 'function') S.reloadTimer.unref()
  }

  // A command's time from asking to its answer, split into its own work (the library's cost, its
  // start and the command) and the wait behind other commands, since the library runs one at a
  // time: kept as S.lastRun, and said (`said`) when the library gave its cost. A refusal from a
  // library that gives no cost counts as all its own.
  // `behind` names the commands that were asked before it and still running or waiting when it was
  // asked: the wait is said as theirs (web wallet #667: a trade's price that waited half a minute
  // behind the bond watch says so).
  function timing (command, took, cost, behind = []) {
    const ms = (p) => Number((cost && cost[p] && cost[p].ms) || 0)
    const known = !!(cost && cost.command)
    const own = known ? Math.min(took, ms('start') + ms('command')) : took
    S.lastRun = { command, took, own, waited: took - own, at: now(), behind }
    return { own, waited: took - own, said: known ? waitedWords(own, took - own, behind) : '' }
  }

  async function run (command, args) {
    const t0 = now()
    const behind = (S.inflight || []).map((x) => x.command)
    const me = { command }
    S.inflight = [...(S.inflight || []), me]
    let v
    try { v = await S.client.run(command, args) } catch (e) {
      S.inflight = (S.inflight || []).filter((x) => x !== me)
      // A command refused after holding the wallet over ten seconds is named as one that answered
      // is: a refusal holds every command behind it just as long.
      const took = now() - t0
      const t = timing(command, took, e && e.cost, behind)
      if (took > 10000) {
        let cost = ''
        try { cost = e && e.cost ? ' ' + JSON.stringify({ cost: e.cost }).slice(0, 900) : '' } catch {}
        log(`[leaves] slow ${command} ${took} ms${t.said}, refused: ${String((e && e.message) || e).slice(0, 300)}${cost}`)
      }
      throw e
    }
    // A command over ten seconds says so, with what the library says it cost (and a sync its
    // steps): the one long command that holds every other behind it can then be named.
    S.inflight = (S.inflight || []).filter((x) => x !== me)
    const took = now() - t0
    const t = timing(command, took, v && v.cost, behind)
    if (took > 10000) {
      let cost = ''
      // The re-check every command starts with, by part (its coins' bases, their lineages, the
      // participations' rounds), when that is where the time went: what names a slow start.
      const re = v && v.start && v.start.recheck
      try { cost = JSON.stringify({ cost: v && v.cost, recheck: re ? { ms: re.ms, read_again: re.read_again, changes: (re.changes || []).length } : undefined,
        steps: v && v.result && v.result.cost_by_step }).slice(0, 1200) } catch {}
      log(`[leaves] slow ${command} ${took} ms${t.said} ${cost}`)
    }
    if (v && v.start && v.start.witness && v.start.witness.error) S.startNote = v.start.witness.error.message
    else if (v && v.start && v.start.recheck && v.start.recheck.error) S.startNote = v.start.recheck.error.message
    else S.startNote = null
    if (v && v.start && v.start.recheck && Array.isArray(v.start.recheck.changes) && v.start.recheck.changes.length) S.recheckNote = v.start.recheck
    return v.result
  }

  // What the wallet holds, read again: commands that only read, one after another, each answering
  // from the look at the chain the first made (shared_view), so the whole read costs the node one
  // request rather than one a command. With `yieldTo`, a read stops between two commands when it
  // says so (someone asked the wallet for something), and is read again after (reloadAfter).
  async function reload ({ yieldTo = null } = {}) {
    if (!S.open) return
    const t = now()
    S.reloadDue = false
    const read = (cmd) => run(cmd, { shared_view: true })
    const gaveWay = () => { if (yieldTo && yieldTo()) { reloadAfter(200); return true } return false }
    const b = await read('balance')
    // Where each coin stands (the library's `coin_places`), read with the balance in default mode,
    // so the figure leaves out what is arriving from the same reading. A library without it leaves
    // the figure as the balance says.
    let pl = null
    if (!dev()) {
      try { pl = await read('coin_places') } catch {}
      // When each coin coming home from a dead trade can be claimed (the library's swaps'
      // `return`, a trade of this page's or not: a restore, a fill), for its line's hours.
      try { S.claimFrom = returnClaims(await read('swaps')) } catch {}
    }
    S.balance = b
    S.places = pl
    try { ctx.store.setItem(tagged(BALANCE_KEY, tag()), JSON.stringify(b)) } catch {}
    try { ctx.store.setItem(tagged(PLACES_KEY, tag()), JSON.stringify(pl)) } catch {}
    if (ctx.onChange) try { ctx.onChange() } catch {}
    if (gaveWay()) return
    const [c, p, s, r] = [await read('coins'), await read('participations'), await read('schedule'), await read('refusals')]
    S.coins = c || []; S.participations = p || []; S.refusals = r || []
    readSchedule(s, t)
    if (gaveWay()) return
    // The channels, as the wallet holds them (asking nothing). When those a payer can pay
    // change, the page's receive code is made again, to name them.
    const was = JSON.stringify(payableChannels(S.channels))
    try { S.channels = (await read('channels')) || [] } catch { S.channels = [] }
    if (JSON.stringify(payableChannels(S.channels)) !== was) emit('channelsChanged', { channels: payableChannels(S.channels) })
    // The plans are shown in developer mode only; reading them asks nothing of the operator.
    if (dev()) { try { const pl = await read('plans'); S.plans = (pl && pl.plans) || [] } catch { S.plans = null } }
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
      // A trade just used up some of a coin's room: the refresh rule is asked now, not at the next
      // turn of its timer, so a coin with none left goes into the next round while others trade.
      needSoon(0)
    }, 500)
  }

  const tag = () => { try { return ctx.walletTag ? ctx.walletTag() : 'default' } catch { return 'default' } }
  // What the balance shows: the library's answer once it has given one this session; until then the
  // last one it gave this wallet, so a reload opens on the figures it closed on (display only:
  // nothing is paid or chosen from it, and every command waits for the library itself).
  const shown = () => {
    if (S.balance) return S.balance
    const k = tag()
    if (!S.kept || S.kept.tag !== k) { let v = null; try { v = JSON.parse(ctx.store.getItem(tagged(BALANCE_KEY, k)) || 'null') } catch {} S.kept = { tag: k, v } }
    return S.kept.v
  }
  // A payment another service says it has made to this wallet (the faucet, paying the receive
  // code), counted as arriving from that moment until the library's balance holds it, or for two
  // minutes at most: the person sees it the moment they are told it was sent.
  S.expected = []
  // The places read with the balance shown (`coin_places`), kept with it.
  const shownPlaces = () => {
    if (S.balance) return S.places || null
    const k = tag()
    if (!S.keptPlaces || S.keptPlaces.tag !== k) { let v = null; try { v = JSON.parse(ctx.store.getItem(tagged(PLACES_KEY, k)) || 'null') } catch {} S.keptPlaces = { tag: k, v } }
    return S.keptPlaces.v
  }
  const placesOn = () => !dev() && !!shownPlaces()
  // What the asset's figure counts in the tree: in default mode, all of it but what is arriving, so
  // the figure is what the wallet can trade or send now; in developer mode, everything held.
  const liveLeaves = (hex) => {
    const b = leafBalances(shown()).get(hex)
    const all = b ? b.leaves : 0n
    if (dev()) return all
    const a = arrivingByAsset(shownPlaces()).get(hex) || 0n
    return all > a ? all - a : 0n
  }
  const expecting = (hex) => {
    const t = now()
    S.expected = S.expected.filter((x) => t < x.until && liveLeaves(x.hex) < x.base + x.atoms)
    return S.expected.filter((x) => x.hex === hex).reduce((n, x) => n + x.atoms, 0n)
  }
  const dev = () => devModeOn(ctx.store, tag())
  const emit = (name, data) => {
    if (ctx.onEvent) try { ctx.onEvent(name, data) } catch {}
    // Every receipt has the library's refresh rule asked at once (`refresh_needed`).
    if (name === 'leafArrived') needSoon(0)
  }
  // Every schedule read also says whether the receive code kept for the page was paid (or lapsed)
  // meanwhile, by this page or while it was closed: the code is then forgotten and the page told
  // ('codeUsed'), so Receive shows a new one rather than a code no sender can pay again.
  const readSchedule = (s, at) => {
    S.schedule = s; S.scheduleAt = at
    const key = tagged(CODE_KEY, tag())
    let kept = null; try { kept = JSON.parse(ctx.store.getItem(key) || 'null') } catch {}
    if (codeOpen(kept, s, at) !== false) return
    try { ctx.store.removeItem(key) } catch {}
    emit('codeUsed', { owner: kept.owner })
  }
  // Every sync's answer: what arrived, what the catch-up changed, and whether the operator answered.
  const synced = (v) => { arrivals(v && v.mailbox); caughtUp(v && v.caught_up); noteUnreachable(unreachableOf(v, 'sync')) }
  function noteUnreachable (u) {
    if (u === undefined) return
    const was = !!S.unreachable
    S.unreachable = u ? { ...u, since: (S.unreachable && S.unreachable.since) || now() } : null
    if (was !== !!u) {
      log(u ? '[leaves] the operator cannot be reached: ' + u.why : '[leaves] the operator answers again')
      if (ctx.onChange) try { ctx.onChange() } catch {}
    }
  }
  // Every coin the library takes in, by whichever read (a sync, the mailbox watch, takeIn): the
  // page told, and the asset kept with when, for takeIn.
  const arrivals = (mb) => {
    for (const c of listOf(mb && mb.accepted)) {
      S.arrived = [...(S.arrived || []).slice(-49), { asset: String(c.asset || '').toLowerCase(), at: now() }]
      emit('leafArrived', { leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? ''), kind: c.kind })
    }
  }
  // What the sync's catch-up with the phrase's other wallets changed (the library runs one at most
  // every ten minutes): coins they made taken in, coins of this store they gave up dropped.
  const caughtUp = (c) => {
    if (!c || typeof c !== 'object') return
    if (c.error) { log('[leaves] catch up: ' + c.error); return }
    const took = (c.restored || []).length, gone = (c.given_elsewhere || []).length
    if (took || gone) log(`[leaves] caught up: ${took} coin(s) taken in, ${gone} given up by another wallet of the phrase`)
  }

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
        noteUnreachable(unreachableOf(S.info, 'info'))
        // A wallet joined by itself is opened only under the key the page pins.
        if (auto && !joinedOperator(ctx.store, tag())) checkPinned(S.info && S.info.operator, auto, 'the wallet')
        setJoined(ctx.store, tag())
        // A wallet this page joined by itself whose restore was cut short restores now.
        if (auto) await restoreOnce()
        S.open = true
      }
      S.joinError = null
      S.openedAt = now()
      await applyLimit()
      // The other operators' watchtowers, beside the operator's own: the wallet deposits each
      // coin with them too, sealed, at its next sync.
      try { await run('set_default_watchtowers', { urls: defaultWatchtowers(ctx.pinned && ctx.pinned()) }) } catch (e) {
        log('[leaves] default watchtowers not set: ' + ((e && e.message) || e))
      }
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
    watchChannels()
  }

  // ---- user mode: a payment into a channel shows at once ----
  // While the page is open in user mode and the wallet holds a live channel, it reads its
  // channels from the operator every CHANNEL_POLL_MS while the page is in view and in use (one
  // short command; channelPollMs), never while another command of the wallet runs; a channel that was paid reads
  // the balance again, so the asset's figure moves at once. A person's command waits at most
  // one such read, and none while the page holds the reads (`holdReads`, while a person reviews
  // a payment the wallet is about to make).
  function channelPollMs () {
    const used = Math.max(S.lastAsked || 0, S.openedAt || 0, S.channelIn || 0)
    if ((ctx.visible && !ctx.visible()) || now() - used > CHANNEL_FAST_FOR_MS) return CHANNEL_POLL_IDLE_MS
    return ctx.channelPollMs || CHANNEL_POLL_MS
  }
  function watchChannels () {
    clearTimeout(S.chanTimer)
    if (!S.open || dev() || !pinned() || S.stopped) return
    S.chanTimer = setTimeout(async () => {
      const live = (S.channels || []).some((c) => c && c.coin_state === 'live')
      if (live && S.open && !dev() && !S.busy && !S.asked && !(now() < (S.holdUntil || 0))) {
        S.busy = true
        try {
          const before = S.channels || []
          const after = await run('channel_sync')
          if (Array.isArray(after)) S.channels = after.map((c) => ({ ...(before.find((x) => x.leaf_id === c.leaf_id) || {}), ...c }))
          const came = channelArrivals(before, S.channels)
          if (came.length) {
            S.channelIn = now()
            try { S.balance = await run('balance') } catch {}
            // The code shown was paid: a new one shows, as after any payment to it.
            try { ctx.store.removeItem(tagged(CODE_KEY, tag())) } catch {}
            for (const a of came) emit('leafArrived', { leaf_id: a.leaf_id, asset: a.asset, value: String(a.atoms), kind: 'channel' })
            if (ctx.onChange) try { ctx.onChange() } catch {}
          }
        } catch {} finally { S.busy = false }
      }
      watchChannels()
    }, channelPollMs())
    if (S.chanTimer && typeof S.chanTimer.unref === 'function') S.chanTimer.unref()
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
      if (S.open && !dev() && !S.busy && !S.asked && !reviewing() && now() - (S.lastAsked || 0) > MAILBOX_QUIET_MS) {
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

  // ---- a payment another service made to the receive code: taken in at once ----
  // The faucet answers once its coin is in the wallet's mailbox, so the library's `mailbox` (a read
  // of seconds) takes it in, never a whole sync, which can sit in a round for a minute or more.
  // Like what a person asks, it goes before the wallet's own upkeep and waits only for a command
  // already running. It reads again every TAKE_IN_EVERY_MS until a coin of `asset` has arrived since
  // `since` (by this read or any other) or `ms` have passed; then the balance is read again, so the
  // figure holds the coin before the page says Received. -> whether the coin arrived.
  async function takeIn ({ asset, since = 0, ms = TAKE_IN_MS } = {}) {
    if (!S.open) return false
    const hex = String(asset || '').toLowerCase()
    const until = now() + ms
    const came = () => (S.arrived || []).some((a) => a.asset === hex && a.at >= since)
    return await asking(async () => {
      while (!came()) {
        while (S.busy && now() < until && !came()) await sleep(100)
        if (came()) break
        if (S.busy) return false
        S.busy = true
        const t0 = now()
        try { arrivals(await run('mailbox')) } catch (e) { log('[leaves] mailbox read: ' + ((e && e.message) || e)) } finally { S.busy = false }
        if (now() - t0 > 2000) log(`[leaves] mailbox read: ${now() - t0} ms`)
        if (came()) break
        if (now() >= until) return false
        await sleep(ctx.takeInEveryMs || TAKE_IN_EVERY_MS)
      }
      const free = now() + 10_000
      while (S.busy && now() < free) await sleep(50)
      if (S.busy) { reloadAfter(); return true }
      S.busy = true
      try {
        S.balance = await run('balance')
        try { ctx.store.setItem(tagged(BALANCE_KEY, tag()), JSON.stringify(S.balance)) } catch {}
        if (ctx.onChange) try { ctx.onChange() } catch {}
      } catch {} finally { S.busy = false }
      reloadAfter()
      return true
    })
  }

  async function openSync () {
    S.openSyncDue = false
    S.busy = true; render()
    const tSync = now()
    try {
      const v = await run('sync')
      log(`[leaves] sync at open: ${now() - tSync} ms`)
      synced(v)
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
  // While it runs the wallet is finding what it holds (`restoring`): the page says so, rather than
  // showing what it has read so far as all there is, and a payment asked meanwhile waits for it.
  // Every request the library makes in it is bounded (the operator's at 60 s, the node's at
  // 120 s), so it returns. When it returns because the operator does not answer, the wallet has
  // found nothing: it is not opened empty, as if it held nothing, but stays finding, says why
  // (`stalled`), and restores again every RESTORE_RETRY_MS until the operator answers.
  async function restoreOnce () {
    const key = tagged(RESTORED_KEY, tag())
    try { if (ctx.store.getItem(key)) return } catch {}
    const t0 = now()
    S.restoring = { since: t0, stalled: null, slow: null }
    emit('restoring', { since: t0 })
    // How long it has run, said as it goes (`restoreSlow`): never a spinner with no end in sight.
    const slowAfter = (ms, level) => setTimeout(() => {
      if (!S.restoring || S.restoring.since !== t0) return
      S.restoring = { ...S.restoring, slow: level }
      log(`[leaves] restore still running after ${Math.round((now() - t0) / 1000)} s (${level})`)
      emit('restoring', { since: t0, slow: level })
    }, ms)
    const timers = [slowAfter(ctx.restoreSlowMs ?? RESTORE_SLOW_MS, 'slow'), slowAfter(ctx.restoreLongMs ?? RESTORE_LONG_MS, 'long')]
    try {
      for (;;) {
        try {
          S.restored = await run('restore')
          try { ctx.store.setItem(key, String(now())) } catch {}
          log(`[leaves] restore: ${now() - t0} ms`)
          depositsOwed(S.restored)
          return
        } catch (e) {
          S.restored = { error: e.message }
          log('[leaves] restore: ' + e.message)
          if (!(e && e.kind === 'unreachable') || S.stopped) return
          const first = !S.restoring.stalled
          S.restoring = { ...S.restoring, stalled: { why: e.message, since: (S.restoring.stalled && S.restoring.stalled.since) || now() } }
          if (first) emit('restoring', { since: t0, stalled: true })
          await sleep(RESTORE_RETRY_MS)
          if (S.stopped) return
        }
      }
    } finally {
      for (const t of timers) clearTimeout(t)
      // The caller opens the wallet next and the page is drawn again once it has read the balance.
      S.restoring = null
    }
  }

  // A restore leaves the watchtowers' deposits of what it found owed (`deposits.owed`): they are
  // made at once, not awaited, so the wallet opens without them. A page closed first has the next
  // sync make them first.
  function depositsOwed (restored) {
    if (!(restored && restored.deposits && restored.deposits.owed)) return
    run('deposits').then(() => log('[leaves] deposits after the restore: made'), (e) => log('[leaves] deposits after the restore: ' + ((e && e.message) || e)))
  }

  // A person reviewing a payment the wallet is about to make (`holdReads`): the wallet's own upkeep
  // (a sync, the mailbox read, care) does not start meanwhile, so Send never waits for one.
  const reviewing = () => now() < (S.holdUntil || 0)

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
    // At the wallet's opening the rule is asked at once: a payment that arrived while it was closed
    // goes into the next round now, not after the timer's first turn.
    if (!S.needTimer) needSoon(0)
    await new Promise((r) => setTimeout(r, 0))   // the page paints what it holds first
    if (S.busy || S.asked || reviewing()) { S.upkeepLater = true; if (!S.asked) upkeepSoon(1000); return }
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
      await refreshReceived()
    } finally { S.busy = false; render() }
  }

  // The library's refresh rule asked on a timer, every REFRESH_NEED_MS while the wallet is open, and
  // at once on a receipt: nothing else need run the upkeep for a coin that arrives later (RV29).
  function needSoon (ms, urgent = ms === 0) {
    if (S.stopped) return
    clearTimeout(S.needTimer)
    S.needTimer = setTimeout(async () => {
      S.needTimer = null
      if (S.stopped) return
      if (S.open && !dev() && pinned() && !S.busy && !S.asked) {
        S.busy = true
        try { await refreshReceived() } catch {} finally { S.busy = false }
      } else if (urgent && S.open && !dev() && pinned() && S.busy && !S.asked) {
        // Asked at once (a receipt, the wallet's opening) while its own upkeep held it, the person
        // asking nothing: asked again in a moment, not at the next turn of the timer, so a payment
        // arriving goes into the next round at once.
        needSoon(NEED_RETRY_MS, true)
        return
      }
      needSoon()
    }, ms ?? needEvery)
  }

  // ---- user mode: what is received out of round is refreshed at the next round ----
  // A coin another wallet paid this one out of round rests on its senders until it is refreshed
  // in a round (until then a sender together with the operator could spend it again). In user
  // mode the library gives every such coin up in the operator's next round for a coin of its own
  // (`refresh_received`), at most once every REFRESH_EVERY_MS, never ahead of a person, never
  // while the page's own on-chain payment may still be spending coins, and only once the person
  // has left the wallet alone REFRESH_IDLE_MS, unless the library's `refresh_needed` says it is needed now, or a payment
  // was refused for what the wallet holds out of round (settleSoon). Developer mode does it
  // only when asked. Until the round is final the coin counts as arriving. Nothing is said unless
  // it goes wrong: a refusal is kept in S.lastRefresh and asked again at the next turn.
  // On unless the page sets window.SEQ_REFRESH_RECEIVED = false. The library gives up a coin only
  // with an operator that takes back a refresh that waits, and only as much of each asset as the
  // operator can fund now; a refresh that still waits is taken back after two minutes, and a
  // payment or a trade that needs its coins takes it back first.
  async function refreshReceived () {
    if (!refreshReceivedOn()) return
    if (!S.open || dev() || !pinned() || S.asked) return
    const paced = S.refreshedAt != null && now() - S.refreshedAt < REFRESH_EVERY_MS
    // Only when the library's rule says so (D95), or at once after a payment was refused for what
    // the wallet holds out of round (settleSoon). The idle rule keeps the pace of one refresh every
    // REFRESH_EVERY_MS; a rule that needs it now does not wait for the pace.
    let only = null
    let shape = null
    let received = true
    if (!S.settleNow) {
      let v
      try { v = await run('refresh_needed', refreshNeededArgs(S.lastAsked, S.openedAt, now())) } catch (e) {
        // A library without the rule: refreshed as before, on the pace alone.
        if (!/no command|unknown command/i.test(String((e && e.message) || ''))) { log('[leaves] refresh_needed: ' + (e && e.message)); return }
        v = { needed: true, reasons: [{ rule: 'pace' }] }
      }
      if (!v || !v.needed) return
      // A library that says which coins go now (`give_up`, one coin of each asset kept back so no
      // asset is all in a round at once) is followed exactly; an older one as before.
      only = Array.isArray(v.give_up) ? v.give_up : refreshLeaves(v)
      shape = shapeSettleArgs(v)
      received = Array.isArray(v.give_up) ? v.give_up.length > 0 : receivedRefreshAsked(v)
      const rules = (v.reasons || []).map((r) => r.rule)
      const now_ = rules.filter((r) => r !== 'idle' && r !== 'pace')
      if (!now_.length && paced) return
      if (now_.length) log('[leaves] refreshing what was received now: ' + now_.join(', '))
    }
    try { if (ctx.onchainQuiet && ctx.onchainQuiet()) return } catch {}
    S.settleNow = false
    // Only `shape` asked: what was received stays as it is (it still pays at once).
    if (received) try {
      S.refreshedAt = now()
      const v = await run('refresh_received', only ? { leaves: only } : {})
      S.lastRefresh = { at: now(), value: v }
      const n = ((v && v.refreshed) || []).length
      if (n) { log(`[leaves] ${n} coin(s) received out of round given up in the next round`); await reload() }
      for (const l of (v && v.left) || []) log(`[leaves] a received coin left as it is: ${l.why}`)
    } catch (e) { S.lastRefresh = { at: now(), error: e }; log('[leaves] refreshing what was received: ' + (e && e.message)) }
    // Coins too deep for a part of them to be traded (the rule `shape`): through the next round,
    // cut into a few coins when the rule says so, at no more than the rule's fee bound, so the next
    // trades from them go at once. Never while the person asks anything.
    if (shape && !S.asked) {
      try {
        const v = await run('settle_first', shape)
        const n = ((v && v.settling) || []).length
        if (n) { log(`[leaves] ${n} coin(s) too deep to trade part of given up in the next round`); await reload() }
      } catch (e) { log('[leaves] settling coins too deep to trade part of: ' + (e && e.message)) }
    }
  }

  // ---- user mode: coins that land on the chain go into the tree by themselves ----
  // Each asset the operator serves, held at the phrase's keys on the chain at least at its
  // smallest leaf, is boarded whole less its fee (default-arca.js boardAll: the fee the library
  // quoted for that very board, in the asset boarded). Never in developer mode, whose Board card
  // is the person's; never while a person waits on the wallet, or while the page's own on-chain
  // payment may still be spending coins; coins the library refused to board are asked again
  // only once they change. The coin shows as arriving until the board is final.
  function boardsKept () {
    try { return JSON.parse(ctx.store.getItem(tagged(BOARDS_KEY, tag())) || '{}') || {} } catch { return {} }
  }
  function keepBoard (asset, rec) {
    const all = boardsKept()
    if (rec) all[asset] = rec; else delete all[asset]
    try { ctx.store.setItem(tagged(BOARDS_KEY, tag()), JSON.stringify(all)) } catch {}
  }
  async function boardArrivals () {
    if (!S.open || dev() || !pinned() || S.asked) return
    try { if (ctx.onchainQuiet && ctx.onchainQuiet()) { upkeepSoon(30_000); return } } catch {}
    await coverReceiveKeys()
    const refused = S.boardRefused || (S.boardRefused = new Map())
    try { S.balance = await run('balance') } catch (e) { log('[leaves] balance before boarding: ' + (e && e.message)); return }
    log('[leaves] on the chain: ' + JSON.stringify((S.balance && S.balance.sequentia_onchain) || {}))
    let boarded = false
    for (const c0 of boardCandidates(S.balance, S.info)) {
      if (S.asked) { S.upkeepLater = true; break }
      // The page's limit on what the wallet holds in the tree (ark-limits.js): the rest of the
      // coins stay on the chain.
      let room = null; try { room = ctx.boardRoom ? ctx.boardRoom(c0.asset) : null } catch {}
      if (room != null && room < c0.min) continue
      const c = room != null && room < c0.onchain ? { ...c0, onchain: room } : c0
      // The same coins the library refused to board are not asked again until they change.
      if (refused.get(c.asset) === String(c.onchain)) continue
      try {
        const v = await boardAll(run, c)
        if (v) {
          boarded = true; S.lastBoard = { at: now(), asset: c.asset, value: v }
          // Until the page's reading of the chain shows the board's coins spent, they are taken off
          // it: the board's leaf counts as arriving from now (onchainLessBoards).
          if (v.spent) keepBoard(c.asset, boardSpent(c.onchain, v.spent, now(), v.txid))
          emit('leafArrived', { asset: c.asset, value: String(c.onchain), kind: 'board' })
        }
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
  const channelsHeld = () => S.channelsHeldUntil != null && now() < S.channelsHeldUntil
  // The per-asset holds, in the store so a reload keeps them.
  const readHolds = () => { try { return JSON.parse(ctx.store.getItem(tagged(CHANNEL_HOLDS_KEY, tag())) || '{}') || {} } catch { return {} } }
  const holdChannel = (asset) => {
    if (!asset) return
    const h = readHolds(), at = now()
    for (const [a, until] of Object.entries(h)) if (!(Number(until) > at)) delete h[a]
    h[asset] = at + channelHoldMs(asset)
    try { ctx.store.setItem(tagged(CHANNEL_HOLDS_KEY, tag()), JSON.stringify(h)) } catch {}
  }
  // No channel opened in an asset held after a payment, nor in one the page names (being sent, or
  // held too little of: ctx.noOpenChannels).
  const noOpen = () => {
    let page = []
    try { page = (ctx.noOpenChannels && ctx.noOpenChannels()) || [] } catch {}
    return [...heldAssets(readHolds(), now()), ...page]
  }
  // Default mode keeps no channel: each live channel coin is given up in the next round for a plain
  // coin of the wallet's side, once (a participation already waiting for it is left alone).
  async function closeChannels () {
    const ids = channelsToClose(S.channels).filter((id) => !(S.coins || []).some((c) => c.leaf_id === id && c.state !== 'live'))
    if (!ids.length) return
    try {
      const q = await run('quote', { leaves: ids })
      await run('participate', { leaves: ids, shown: q.coins })
      log(`[leaves] closing ${ids.length} channel(s) into coins at the next round`)
    }
    catch (e) { log('[leaves] closing channels: ' + ((e && e.message) || e)) }
  }
  // The instant limit the mode asks of the library (instantLimitArgs); a library without it is left
  // as it is.
  // Default mode also trades only with its owner's exit on every checkpoint (the library's
  // `require_checkpoint_exit`), so what a trade gives always comes home if the trade dies: from the
  // moment its operator offers the exit (`info.checkpoint_exit`). Before that it trades as it always
  // has, with no exit asked and nothing refused for the want of one (requireExitArgs).
  // The operator can begin offering the exit while the page is open: its `info` is read again at
  // each care, and the switch set on when it does (exitSwitch). Once offered, it stays on.
  async function applyLimit () {
    try { await run('instant_limit', instantLimitArgs(dev())) } catch (e) { log('[leaves] instant limit: ' + ((e && e.message) || e)) }
    await applyExit(null)
  }
  async function applyExit (applied) {
    const si = S.info && S.info.server_info
    // Kept for the wallet and its operator together, and written only from default mode's own
    // operator's answer (the page's pinned one, when it pins one): a developer-mode join to another
    // server, or another operator, neither sets it nor reads it.
    const op = S.info && typeof S.info.operator === 'string' ? S.info.operator : null
    const pin = pinned()
    const key = op ? tagged(EXIT_SEEN_KEY, tag()) + '.' + op : null
    if (key && !dev() && (!pin || pin.operator === op) && si && typeof si === 'object' && si.checkpoint_exit === true) { try { ctx.store.setItem(key, '1') } catch {} }
    let seen = false; try { seen = !!key && ctx.store.getItem(key) === '1' } catch {}
    const args = exitSwitch(dev(), S.info, applied, seen)
    if (!args) return
    try { await run('require_checkpoint_exit', args); S.exitApplied = JSON.stringify(args) } catch (e) { log('[leaves] checkpoint exit: ' + ((e && e.message) || e)) }
  }
  async function infoAgain () {
    try {
      const v = await run('info')
      if (v && typeof v === 'object') S.info = v
      noteUnreachable(unreachableOf(v, 'info'))
    } catch (e) { log('[leaves] info: ' + ((e && e.message) || e)); return }
    await applyExit(S.exitApplied ?? null)
  }
  const receiveArgs = () => (dev() ? {} : { channels: false })
  async function careIfDue () {
    if (!S.open || !careDue(S.careAt, now(), careEvery)) return
    if (S.asked) { S.upkeepLater = true; return }
    S.careAt = now()
    await infoAgain()
    const t0 = now()
    try {
      const v = await run('care', careArgs(claimScan(), channelsHeld(), noOpen(), dev()))
      if (!dev()) await closeChannels()
      log(`[leaves] care: ${now() - t0} ms`)
      S.lastCare = { at: now(), value: v }
      const sum = careSummary(v)
      const ch = (v && v.channels) || {}
      const chMoved = ((ch.folded || []).length + (ch.opened || []).filter((o) => o && o.participation).length) > 0
      if (sum.taken || sum.planned || sum.cancelled || sum.refreshing || chMoved) await reload()
      for (const c of (v && v.claims) || []) if (c && c.taken_up && !c.error) emit('leafArrived', { leaf_id: c.leaf_id, value: String(c.value ?? ''), kind: 'claim' })
    } catch (e) { S.lastCare = { at: now(), error: e } }
    await claimsIfDue(true)
    await bondIfIdle()
  }

  // What vests later (default-arca.js vestingLots): the library's `claims`, read at most every
  // CLAIMS_EVERY_MS and after each care, in either mode, and kept for the wallet, so the figure
  // shows it from the last reading while the wallet opens, syncs or is offline. A claim whose
  // date has passed and that care has not taken up yet has care run at its next chance.
  async function claimsIfDue (force = false) {
    if (!S.open) return
    if (!force && S.claimsAt != null && now() - S.claimsAt < claimsEvery) return
    if (S.asked) { S.upkeepLater = true; return }
    S.claimsAt = now()
    try {
      const scan = claimScan()
      const v = await run('claims', scan ? { scan } : {})
      const lots = vestingLots(v)
      const was = JSON.stringify(vestingKept())
      S.vesting = { tag: tag(), lots }
      try { ctx.store.setItem(tagged(VESTING_KEY, tag()), JSON.stringify(lots)) } catch {}
      if (vestedOpen(v)) { S.careAt = null; upkeepSoon(2000) }
      if (JSON.stringify(lots) !== was && ctx.onChange) try { ctx.onChange() } catch {}
    } catch (e) { log('[leaves] claims: ' + (e && e.message)) }
  }
  // What vests later as last read: this session's reading, else the one kept for this wallet.
  function vestingKept () {
    const k = tag()
    if (!S.vesting || S.vesting.tag !== k) {
      let v = null
      try { v = JSON.parse(ctx.store.getItem(tagged(VESTING_KEY, k)) || 'null') } catch {}
      S.vesting = { tag: k, lots: Array.isArray(v) ? v : [] }
    }
    return S.vesting.lots
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
    // A person waiting on the wallet (a trade's quote, a payment) comes first: a sync started
    // between the steps of what they asked held the next step for its whole length.
    if (S.busy || S.asked || reviewing()) { S.timer = setTimeout(autoSync, S.asked || reviewing() ? 2000 : 5000); return }
    try {
      const t = now()
      const s = await run('schedule')
      readSchedule(s, t)
      if (s.due) emit('leafSyncDue', { now: s.now, next_sync_at: s.next_sync_at, why: s.why ?? null })
      const d = syncDecision(s, S.heldFor, inFlight(S.coins, S.participations))
      S.heldFor = d.held
      if (S.asked) { S.timer = setTimeout(autoSync, 2000); return }
      if (d.sync && !S.busy) {
        S.busy = true; render()
        try {
          const v = await run('sync')
          synced(v)
          S.lastSync = { at: now(), value: v, auto: true }
        } catch (e) { S.lastSync = { at: now(), error: e, auto: true } }
        try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e }
        try { await careIfDue() } finally { S.busy = false }
      } else if (!S.busy && careDue(S.careAt, now(), careEvery)) {
        S.busy = true
        try { await careIfDue() } finally { S.busy = false }
      } else if (!S.busy) {
        S.busy = true
        try { await claimsIfDue() } finally { S.busy = false }
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
          synced(v)
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
            await roundWait(() => waitReleased(leaves, { turns: true }))
          } finally { S.releasing = null; render() }
          continue
        }
        // What the wallet shows, held back only for want of a round (the library's `settle_first`,
        // naming the coins: at the operator's depth limit, still arriving, trade proceeds for a leg
        // leaving the tree, or of a format the other side does not read): those coins go through the
        // next round (`settle_first`, which gives up nothing twice), and the payment is asked again
        // once it is through, about a minute later. Nothing is refused for it.
        // An offboard's quote answers at once, as the library gave it: the page reviews the payment
        // then, and the offboard made on that review settles first.
        if (e instanceof LeafError && e.kind === 'settle_first' && i < RELEASE_TRIES && command !== 'offboard_quote') {
          const coins = e.coins && e.coins.length ? e.coins : null
          // Cut into a few coins of the asset (`spread`, the same fee): what is paid or traded next goes
          // from one while another is in a round.
          const ask = coins ? { coins, spread: true } : { asset: e.asset, spread: true }
          S.releasing = { coins: coins || [], asset: e.asset, since: now(), command, why: 'settle' }
          render()
          try {
            log(`[leaves] ${command}: ${coins ? coins.length : 'the'} coin(s) it needs go through the next round first; paid once through`)
            await roundWait(() => waitSettled(ask))
          } finally { S.releasing = null; render() }
          continue
        }
        // What the wallet's side of a channel would cover (the library's `in_channel`, naming the
        // channel leaves): they are closed into the next round, a leaf of the wallet's own given
        // back for each side, and the payment asked again once that round is final. Care leaves
        // channels alone meanwhile, and for a while after, so it does not put the side back.
        if (e instanceof LeafError && e.kind === 'in_channel' && e.close && e.close.length && i < RELEASE_TRIES) {
          S.releasing = { coins: e.close, asset: e.asset, since: now(), command, why: 'channel' }
          S.channelsHeldUntil = now() + RELEASE_WAIT_MS
          render()
          try {
            const q = await run('quote', { leaves: e.close })
            await run('participate', { leaves: e.close, shown: q.coins })
            log(`[leaves] ${command}: ${e.close.length} channel(s) closed into the next round; paid once it is final`)
            await roundWait(() => waitReleased(e.close, { turns: true }))
          } finally { S.releasing = null; S.channelsHeldUntil = null; holdChannel(e.asset); render() }
          continue
        }
        // Refused for want of coins while the wallet's own refresh of the asset is in a round,
        // past being taken back: what the figure shows is the person's, so the payment waits for
        // that round (about a minute) and is asked again once it is final; it is not refused.
        const payAsset = args && (args.asset || args.give_asset)
        if (e instanceof LeafError && e.kind === 'refused' && /in live coins/.test(String(e.message || '')) && payAsset && i < RELEASE_TRIES) {
          let cs = S.coins
          try { cs = (await run('coins')) || cs; S.coins = cs } catch {}
          const held = inRoundCoins(cs, payAsset)
          if (held.length) {
            S.releasing = { coins: held, asset: payAsset, since: now(), command, why: 'round' }
            render()
            log(`[leaves] ${command}: waits for the round that refreshes ${held.length} coin(s) of its asset, then goes ahead`)
            try { await roundWait(() => waitOutOfRound(held)) } finally { S.releasing = null; render() }
            continue
          }
        }
        if (!(e instanceof LeafError) || e.kind !== 'planned' || !e.release || !e.release.length || i >= RELEASE_TRIES) throw e
        S.releasing = { coins: e.release, asset: e.asset, since: now(), command }
        render()
        try {
          const r = await run('plan_release', { leaves: e.release })
          S.releasing.answer = r
          log(`[leaves] ${command}: ${e.release.length} planned coin(s) given up in the next round; paid once it is final`)
          await roundWait(() => waitReleased(e.release, { turns: true }))
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
        await waitReleased(leaves, { yieldToPerson: true })
      } catch (e) { log(`[leaves] release for a trade: ${e && e.message}`) } finally { S.releasing = null; render() }
    })()
    return { releasing: leaves.length, asset }
  }

  // A payment waiting for a round (to free planned coins, or to refresh coins too many payments
  // deep) waits minutes, up to RELEASE_WAIT_MS: meanwhile it neither holds the wallet (`busy`) nor
  // counts as a person asking, so other commands, the mailbox and channel reads and the upkeep go
  // on, and a payment to the wallet still shows; the wait's own commands take their turn
  // (`turns`). The payment takes the wallet back for its retry.
  async function roundWait (f) {
    const busy = S.busy; const asked = (S.asked || 0) > 0
    if (busy) S.busy = false
    if (asked) S.asked--
    try { return await f() } finally {
      if (asked) S.asked++
      if (busy) { while (S.busy) await sleep(50); S.busy = true }
    }
  }

  // Puts through the next round what a `settle_first` refusal named (`ask`: its coins, or its asset),
  // asking the library again every ROUND_POLL_MS (it gives up nothing twice), after a sync, until it
  // answers ready: nothing it named is settling or waiting any more. Up to RELEASE_WAIT_MS. A library
  // without the command answers as before (the refusal stands).
  async function waitSettled (ask) {
    const until = now() + RELEASE_WAIT_MS
    for (let first = true; ; first = false) {
      while (S.busy) await sleep(50)
      S.busy = true
      let v = null
      try {
        if (!first) { try { const s = await run('sync'); synced(s) } catch {} }
        v = await run('settle_first', ask)
        if (v && (v.settling || []).length) log(`[leaves] ${v.settling.length} coin(s) given up in the next round to settle first`)
      } finally { S.busy = false }
      if (!v || v.ready) { try { S.coins = (await run('coins')) || S.coins } catch {}; return v }
      if (now() >= until) throw new LeafError({ kind: 'refused', message: 'the next round did not settle the coins this needs in time; nothing was paid, and it can be asked again' })
      await sleep(ROUND_POLL_MS)
    }
  }

  // Until none of `coins` is in the wallet's own round any more (`given`, `forfeited`): spent by a
  // round that went through, or live again after one that failed. Either way the payment is asked
  // again at once. Read every ROUND_POLL_MS, up to RELEASE_WAIT_MS.
  async function waitOutOfRound (coins) {
    const until = now() + RELEASE_WAIT_MS
    for (;;) {
      while (S.busy) await sleep(50)
      S.busy = true
      try {
        try { const v = await run('sync'); synced(v) } catch {}
        try { S.coins = (await run('coins')) || S.coins } catch {}
      } finally { S.busy = false }
      if (!inRoundCoins((S.coins || []).filter((c) => coins.includes(c.leaf_id)), S.releasing ? S.releasing.asset : null).length) return
      if (now() >= until) throw new LeafError({ kind: 'refused', message: 'the wallet\'s own round did not end in time; nothing was paid, and the payment can be asked again' })
      await sleep(ROUND_POLL_MS)
    }
  }

  // `yieldToPerson`: the release runs in the background (one a trade's quote asked for), so a
  // person waiting on the wallet comes first and the round is followed between their steps. A
  // release inside the person's own payment never waits for itself.
  async function waitReleased (coins, { yieldToPerson = false, turns = false } = {}) {
    const until = now() + RELEASE_WAIT_MS
    const turn = async (g) => {
      if (!turns) return g()
      while (S.busy) await sleep(50)
      S.busy = true
      try { return await g() } finally { S.busy = false }
    }
    for (;;) {
      while (yieldToPerson && S.asked && now() < until) await sleep(500)
      try { const v = await turn(() => run('sync')); synced(v); S.lastSync = { at: now(), value: v, auto: true, why: 'release' } } catch {}
      let cs = null
      try { cs = await turn(() => run('coins')); S.coins = cs || [] } catch {}
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
    if (S.unreachable) {
      const c = card('The operator cannot be reached'); c.id = 'leafUnreachable'
      c.appendChild(el('div', 'warn', S.unreachable.note || S.unreachable.why))
      c.appendChild(el('div', 'sub', `Since ${new Date(S.unreachable.since).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}. Each leaf below still goes home from this wallet's record and the chain alone: its Exit drill asks nothing of the operator.`))
      root.appendChild(c)
    }
    // Each panel on its own: one that cannot be drawn says so in its place, and never hides the
    // leaves and their exit drill below it.
    const panels = [['Balances per rail', renderRails], ['Board', renderBoard], ['Receive', renderReceive], ['Send', renderSend],
      ['Leaves and their dates', renderCoins], ['Exit drill', renderDrill], ['Sync and schedule', renderSync], ['Kept by itself', renderCare],
      ['Channels', renderChannels], ['Bond', renderBond], ['Supply', renderSupply], ['Participations', renderParticipations], ['Refusals', renderRefusals]]
    for (const [name, draw] of panels) {
      try { draw() } catch (e) {
        log(`[leaves] the ${name} panel: ${(e && e.stack) || e}`)
        const c = card(name); c.appendChild(errBox({ message: 'This panel could not be drawn: ' + ((e && e.message) || e) })); root.appendChild(c)
      }
    }
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
          try { S.restored = (await S.client.run('restore')).result; depositsOwed(S.restored) } catch (e) { S.restored = { error: e.message } }
          try { if (config.node_password) ctx.store.setItem(NODE_PASSWORD_KEY, config.node_password); else ctx.store.removeItem(NODE_PASSWORD_KEY) } catch {}
          S.open = true
          S.joined = info.result
          S.info = info.result
          await applyLimit()
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
    const head = el('tr'); for (const h of ['Asset', 'On-chain', 'Ark', 'Lightning']) head.appendChild(el('th', null, h)); t.appendChild(head)
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
  // once the faucet answers; a mailbox read (takeIn) takes it in.
  function renderFaucetAsk (c) {
    const choices = faucetAssets(S.info, S.request.asset)
    if (!choices.length) return
    c.appendChild(el('p', 'sub', 'On the testnet, the faucet can pay this request as a leaf.'))
    field(c, 'Asset to ask the faucet for', assetSelect('leafFaucetAsset', choices))
    const fb = button('Ask the testnet faucet to pay it', async () => {
      const asset = val('leafFaucetAsset') || choices[0]
      S.faucet = { busy: true }; render()
      const since = now()
      try {
        const answer = await ctx.askFaucet(faucetRequestBody(S.request.text, tick(asset)))
        S.faucet = { answer }
      } catch (e) { S.faucet = { error: e } }
      render()
      const l = S.faucet && S.faucet.answer && S.faucet.answer.leaf
      if (l && l.asset) takeIn({ asset: l.asset, since }).then(() => render()).catch(() => {})
    }, 'ghost')
    fb.id = 'btnLeafFaucet'; fb.disabled = S.busy || !!(S.faucet && S.faucet.busy)
    const r = el('div', 'row'); r.style.marginTop = '8px'; r.appendChild(fb); c.appendChild(r)
    const f = S.faucet
    if (f && f.busy) c.appendChild(el('div', 'status', 'Asking the faucet…'))
    if (f && f.answer) {
      const l = f.answer.leaf || {}
      const d = el('div', 'status ok'); d.id = 'leafFaucetAnswer'
      d.textContent = `The faucet paid ${l.asset ? amt(l.asset, l.atoms) : (f.answer.amount + ' ' + f.answer.asset)} into this request; the wallet reads it from its mailbox.`
      c.appendChild(d)
    }
    if (f && f.error) { const d = el('div', 'status err'); d.id = 'leafFaucetAnswer'; d.textContent = 'The faucet refused: ' + (f.error.message || String(f.error)); c.appendChild(d) }
  }

  function renderSend () {
    const c = card('Send to a receive request')
    c.id = 'leafSend'
    c.appendChild(el('p', 'sub', 'Pays a receive request or a payment code. By a channel: when the text names the receiver\'s channel in the asset and this wallet\'s channel there can pay it, at once and with no round. By a leaf: out of round, coins of the asset, those furthest from their exit date first, each into a checkpoint, then the reassignment into the receiver\'s leaf and the change. Either way, when the route is left to the wallet. No asset is a default.'))
    const t = el('textarea', 'mono'); t.id = 'leafSendRequest'; t.rows = 3; field(c, 'Receive request or payment code', bind(t))
    const assets = [...leafBalances(S.balance).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a)
    field(c, 'Asset', assetSelect('leafSendAsset', assets, 'the request\'s'))
    const a = el('input'); a.id = 'leafSendAmount'; field(c, 'Amount, in atoms', bind(a))
    const rt = el('select'); rt.id = 'leafSendRoute'
    for (const [v, l] of [['any', 'Either way'], ['channel', 'By a channel'], ['leaf', 'By a leaf']]) { const o = el('option', null, l); o.value = v; rt.appendChild(o) }
    field(c, 'Route', bind(rt))
    const b = button('Send', () => {
      const args = { request: val('leafSendRequest'), amount: val('leafSendAmount') || null, asset: val('leafSendAsset') || null, route: val('leafSendRoute') || 'any' }
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
    for (const rq of listOf(s.receive_requests)) {
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
        const mb = (v.mailbox && typeof v.mailbox === 'object') ? v.mailbox : {}
        const sum = el('div', 'leaf-sync-summary')
        if (v.unreachable) sum.appendChild(el('div', 'warn leaf-unreachable', `The operator could not be reached: ${v.unreachable.why || ''}`))
        sum.appendChild(el('div', null, `Mailbox: ${listOf(mb.accepted).length} accepted, ${listOf(mb.refused).length} refused, ${listOf(mb.waiting).length} waiting`))
        for (const a of listOf(mb.accepted)) sum.appendChild(el('div', 'sub', `accepted ${short(a.leaf_id)}: ${amt(a.asset, a.value)}, ${a.state}${a.note ? '; ' + a.note : ''}`))
        for (const a of listOf(mb.refused)) sum.appendChild(el('div', 'sub leaf-refusal', `refused: ${a.reason || JSON.stringify(a)}`))
        for (const p of listOf(v.participations)) sum.appendChild(el('div', 'sub', `participation ${short(p.participation)}: ${p.state}${p.note ? '; ' + p.note : ''}`))
        for (const e of listOf(v.exits)) sum.appendChild(el('div', 'sub', `exit ${short(e.leaf_id)}: ${e.state}${e.next ? '; ' + e.next : ''}${e.error ? '; ' + e.error : ''}`))
        // A part the library could not read, said in its words rather than left out.
        for (const k of ['mailbox', 'participations', 'exits', 'forfeits', 'boards', 'transfers', 'refresh', 'held', 'lightning', 'offboards', 'owed', 'deposits', 'reboards', 'orders', 'resting', 'plans']) {
          const err = partError(v[k]); if (err) sum.appendChild(el('div', 'sub leaf-refusal', `${k}: ${err}`))
        }
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
    c.appendChild(el('p', 'sub', 'After a sync, at most every ten minutes, the wallet takes up every claim named for one of its addresses and signs a refresh plan for a leaf of a round once its refresh could run within ten days, so a closed wallet keeps it across its expiry. A leaf received or boarded out of round is free to pay, and is refreshed into a round once its refresh could run within ten days. A planned leaf is paid out of round by no wallet: a payment the unplanned leaves cannot cover gives the planned leaves it needs up in the next round and is made once that round is final, by itself. Release does that for one plan now.'))
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

  // Developer mode's channels: each with its state, both sides, its credit and the note,
  // and Read, Fold, Close into a round (Settle now's quote, then the round) and Exit (the
  // channel's own exit, one step a run); Open, the payment code, and a payment by hand.
  function renderChannels () {
    const c = card('Channels')
    c.id = 'leafChannels'
    c.appendChild(el('p', 'sub', 'A channel leaf holds a balance for this wallet and one for the operator. A payment from it into another wallet\'s channel of the same operator is final for the receiver at once, with no round between: the operator signs the receiver a credit note, enforceable on the chain without anyone\'s help, against capacity already in the receiver\'s leaf. The payer relies on the operator for that one request: the operator could co-sign the payer\'s new state and keep the receiver\'s note back. Care opens a channel in each asset the operator makes channels of, half of the wallet\'s leaves of it in it, folds the credit it was paid, and closes it into a round near its expiry; an exit takes it home on the chain alone.'))
    const list = S.channels || []
    if (!list.length) c.appendChild(el('div', 'muted', 'No channels.'))
    for (const ch of list) {
      const d = el('div', 'leaf-channel'); d.dataset.leaf = ch.leaf_id; d.dataset.state = ch.coin_state || ''
      const st = ch.state || {}
      d.appendChild(el('div', null, `${tick(ch.asset)} channel ${short(ch.leaf_id)} · ${ch.coin_state || '?'}${ch.final ? ', final' : ', not final'}${ch.pending ? ' · a state sent, not answered' : ''}`))
      d.appendChild(kv('This wallet\'s side', amt(ch.asset, ch.balance)))
      d.appendChild(kv('The operator\'s side', amt(ch.asset, ch.operator_side)))
      d.appendChild(kv('State', `${st.number ?? 0}: this wallet ${st.owner ?? '?'}, operator ${st.operator ?? '?'}, folded ${st.folded ?? 0}`))
      d.appendChild(kv('Credit (notes)', `${ch.credit ?? 0}, of which not folded ${ch.credit_not_folded ?? 0}`))
      const r = el('div', 'row'); r.style.marginTop = '6px'
      const b1 = button('Read', async () => { try { await act('channel_sync', () => run('channel_sync', { leaf_id: ch.leaf_id })) } catch {} }, 'ghost')
      const b2 = button('Fold', async () => { try { await act('channel_fold', () => run('channel_fold', { leaf_id: ch.leaf_id })) } catch {} }, 'ghost')
      const b3 = button('Close into a round', () => settle([ch.leaf_id]), 'ghost')
      const b4 = button('Exit', async () => { try { S.channelExit = { leaf: ch.leaf_id, value: await act('channel_exit', () => run('channel_exit', { leaf_id: ch.leaf_id })) } } catch {} }, 'danger')
      b1.dataset.action = 'read'; b2.dataset.action = 'fold'; b3.dataset.action = 'close'; b4.dataset.action = 'exit'
      b2.disabled = S.busy || !(BigInt(ch.credit_not_folded || 0) > 0n) || ch.coin_state !== 'live'
      b3.disabled = S.busy || ch.coin_state !== 'live'
      b4.disabled = S.busy || !['live', 'exiting', 'given', 'pending'].includes(ch.coin_state)
      b1.disabled = S.busy
      for (const b of [b1, b2, b3, b4]) r.appendChild(b)
      d.appendChild(r)
      if (S.channelExit && S.channelExit.leaf === ch.leaf_id) {
        const v = S.channelExit.value || {}
        const x = el('div', 'sub'); x.id = 'leafChannelExit'
        x.textContent = `exit: ${v.state}${(v.steps || []).length ? ' · broadcast ' + v.steps.map((s2) => `${s2.what} ${short(s2.txid)} ${s2.vsize} vB`).join(', ') : ''}${v.next ? ' · next: ' + v.next : ''}${v.error ? ' · ' + v.error : ''}`
        d.appendChild(x)
      }
      c.appendChild(d)
    }
    const r = el('div', 'row'); r.style.marginTop = '10px'
    const code = button('Payment code', async () => { try { S.channelCodeText = (await act('channel_code', () => run('channel_code'))).code } catch {} }, 'ghost'); code.id = 'btnLeafChannelCode'
    code.disabled = S.busy; r.appendChild(code)
    c.appendChild(r)
    if (S.channelCodeText) { const t = el('textarea', 'mono'); t.id = 'leafChannelCode'; t.rows = 3; t.readOnly = true; t.value = S.channelCodeText; c.appendChild(t) }
    // Open by hand: the coins of one asset, the operator\'s side, what is kept beside it.
    const f = (id, label, ph) => { const dd = el('div', 'field'); dd.appendChild(el('label', 'lbl', label)); const i = el('input'); i.id = id; i.placeholder = ph || ''; bind(i); dd.appendChild(i); c.appendChild(dd); return i }
    f('leafChOpenLeaves', 'Open: the leaves to give up (comma separated; every live leaf of one asset when empty)', '')
    f('leafChOpenCapacity', 'The operator\'s side, in atoms', 'at most what the operator publishes')
    f('leafChOpenKeep', 'Kept in a plain leaf beside it, in atoms (optional)', '')
    const r2 = el('div', 'row')
    const open = button('Open in the next round', async () => {
      const args = { capacity: val('leafChOpenCapacity') }
      const ls = val('leafChOpenLeaves'); if (ls) args.leaves = ls.split(',').map((x) => x.trim()).filter(Boolean)
      if (val('leafChOpenKeep')) args.keep = val('leafChOpenKeep')
      try { await act('channel_open', () => run('channel_open', args)) } catch {}
      schedule()
    })
    open.id = 'btnLeafChannelOpen'; open.disabled = S.busy; r2.appendChild(open); c.appendChild(r2)
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
    // After a restore the library checks the wallet's earlier leaves a few at each sync; what it
    // holds now is whole meanwhile (`balance.history`).
    const hist = S.balance && S.balance.history
    if (hist && hist.loading) { const h = el('div', 'sub leaf-history-loading', `Earlier leaves still being checked after the restore: ${hist.left} left, a few at each sync. What the wallet holds now is complete.`); h.id = 'leafHistoryLoading'; c.appendChild(h) }
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
      const r = el('div', 'row'); r.style.marginTop = '8px'; r.appendChild(b)
      // The last transaction the exit broadcast, sped up by a child (`speed_up`): the library
      // finds the output of the wallet's it spends, and says why when there is none.
      const last = lastBroadcast(S.drill.runs)
      if (last) {
        const sp = button('Speed up', () => speedUp(last), 'ghost'); sp.id = 'btnLeafSpeedUp'; sp.disabled = S.busy
        r.appendChild(sp)
      }
      c.appendChild(r)
    }
    root.appendChild(c)
  }

  async function speedUp (txid) {
    try {
      const v = await act('speed_up', () => run('speed_up', { txid }))
      S.drill.runs.push({ at: now(), value: { state: 'sped up', note: `child ${v.child} spends ${v.spends}; the waiting transactions and it pay ${v.rate_per_kvb} reference atoms a kvB together, fee ${amt(v.fee.asset, v.fee.amount)}${v.second_input ? ', a second input paying it' : ''}${v.replaced ? ', replacing ' + v.replaced : ''}` } })
    } catch (e) { S.drill.runs.push({ at: now(), error: e }) }
    render()
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
    if (S.open) { await applyLimit(); S.places = null; reloadAfter(0) }
    if (ctx.onModeChange) try { ctx.onModeChange(m) } catch {}
    if (m === 'developer') { try { await start() } catch (e) { log('[leaves] open: ' + ((e && e.stack) || e)); S.error = { what: 'open', e } } }
    else watchMailbox()
    render()
  }

  // ---- for the page API (wallet-api.js): the library's commands, one at a time ----
  async function command (cmd, args) {
    if (!S.open) throw new LeafError({ kind: 'refused', message: 'this wallet has not joined a leaf operator: join one in the wallet\u2019s Leaves tab' })
    try { return await asking(() => act(cmd, () => paying(cmd, args || {}))) } catch (e) {
      // Refused for what the wallet holds out of round (a large payment just received, such as
      // the faucet's five assets): what it received is given up in the next round at the next
      // turn of the upkeep, not after the refresh's usual pace, so room comes back sooner.
      if (holdingRefusal(e)) settleSoon()
      throw e
    }
  }
  function settleSoon () {
    if (S.refreshedAt != null) log('[leaves] holding past what the bond covers: what was received is settled at once')
    S.refreshedAt = null
    S.settleNow = true
    S.upkeepLater = true
    if (!S.asked) upkeepSoon(0)
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

  // `quick`: the code shown before is shown at once while it has a day before it lapses and no
  // schedule read so far says it was paid, without waiting for the library (busy with the sync
  // that opens it); the next schedule read that says so has the page ask again ('codeUsed'), as a
  // coin that arrives does (leafArrived).
  async function receiveCode ({ quick = false } = {}) {
    const key = tagged(CODE_KEY, tag())
    let kept = null; try { kept = JSON.parse(ctx.store.getItem(key) || 'null') } catch {}
    // A code made before the wallet's channels changed names the wrong ones: made again. Default
    // mode's code names none: every payment to it comes as a coin.
    if (kept && !codeNamesChannels(kept, dev() ? S.channels : [])) kept = null
    if (quick && kept && kept.text && kept.until && kept.until - now() / 1000 > CODE_MARGIN_S && codeOpen(kept, S.schedule, S.scheduleAt) !== false) return kept
    if (kept && kept.text && kept.owner) {
      const t = now()
      let s = null; try { s = await asking(() => run('schedule')); S.schedule = s; S.scheduleAt = t } catch {}
      if (codeOpen(kept, s, t)) return kept
    }
    const made = now()
    const v = await command('receive', receiveArgs())
    const out = { text: v.request, owner: (v.details && v.details.owner) || null, until: (v.details && v.details.until) || null,
      channels: (v.details && v.details.channels) || {}, made }
    try { ctx.store.setItem(key, JSON.stringify(out)) } catch {}
    return out
  }

  // ---- every coin home, from the wallet's record and the chain alone ----
  // What default mode offers while the operator cannot be reached (and developer mode's exit drill
  // does a coin at a time): default-arca.js's homeQuote and homeTake, on this wallet's library.
  // Nothing here asks the operator, and nothing is decided here: which coin can go, its path, its
  // fees and its claim are the library's. What this page sent, and when, is kept for its words.
  const homeKept = () => { try { return JSON.parse(ctx.store.getItem(tagged(HOME_KEY, tag())) || '{}') || {} } catch { return {} } }
  const keepHome = (m) => { try { ctx.store.setItem(tagged(HOME_KEY, tag()), JSON.stringify(m)) } catch {} }
  const homeQuote = () => quoteHome(run, S.coins, listOf(S.channels).map((c) => c && c.leaf_id))
  async function takeHome (q) {
    const r = await homeTake(run, q, { now, log })
    keepHome({ ...homeKept(), ...r.kept })
    schedule()
    return r
  }
  function homeUnderWay () {
    const kept = homeKept()
    const r = underWay(S.coins, kept, !!S.unreachable)
    if (S.coins && S.coins.length && Object.keys(r.kept).length !== Object.keys(kept).length) keepHome(r.kept)
    return r.list
  }

  const api = {
    state: S,
    render,
    start: async () => { try { await start() } catch (e) { log('[leaves] open: ' + ((e && e.stack) || e)); S.error = { what: 'open', e }; render() } },
    // Leaf atoms of an asset, for the Balance tab's rows and headline total.
    mode: () => walletMode(ctx.store, tag()),
    setMode: (m) => changeMode(m),
    isOpen: () => S.open,
    command,
    // A person's span of work (a trade's quote, its confirmation): the wallet's own upkeep waits
    // until it is over, not only while one of its commands runs.
    hold: async (f) => { S.holds = (S.holds || 0) + 1; try { return await asking(f) } finally { S.holds-- } },
    // A command for the user composer, asked directly (no reload after it), paid through
    // the next round when it needs a planned coin.
    // A read (a price, the coins) is asked as it is: freeing planned coins and following the next
    // round is for a payment, never for a quote, whose person waits on its answer.
    // A read or a sync the composer asks while nobody waits on it (`hold`: a quote, a
    // confirmation) is how it follows its open trades, every few seconds: the wallet's own work,
    // not a person asking, so it never keeps the mailbox and channel reads off for as long as a
    // trade is open. What its sync takes in is told as any sync's is.
    pay: (cmd, args) => {
      if (!S.open) return Promise.reject(new LeafError({ kind: 'refused', message: 'this wallet holds no leaves' }))
      const read = COMPOSER_READS.has(String(cmd))
      const fail = (e) => { throw dev() ? devRefusal(e) : plainRefusal(e) }
      if (!S.holds && read) return run(cmd, args || {}).catch(fail)
      if (!S.holds && cmd === 'sync') return run('sync', args || {}).then((v) => { try { synced(v) } catch {} return v }).catch(fail)
      return asking(() => (read ? run(cmd, args || {}) : paying(cmd, args || {}))).catch(fail)
    },
    // What of an asset its issuer has frozen for this wallet, in atoms (both modes).
    frozenAtoms: (hex) => frozenAtoms(S.coins, S.balance).get(hex) || 0n,
    // The assets the operator serves supervised.
    supervisedAssets: () => supervisedAssets(S.info),
    address,
    // In default mode, with the library's places read, the figure is what the wallet can trade or
    // send now: a payment arriving, or one the library has not taken in yet, is in the activity
    // list alone (arrivingPayments). Otherwise what is held, and what is expected, as before.
    leafAtoms: (hex) => liveLeaves(hex) + (placesOn() ? 0n : expecting(hex)),
    // Default mode's payments arriving (shown in the activity list, never in the figure): each coin
    // the library places as arriving, and each payment another service says it made that the
    // library has not taken in yet. -> [{ asset, atoms, leaf_id? }]
    arrivingPayments: () => {
      if (!placesOn()) return []
      const out = arrivingCoins(shownPlaces(), S.claimFrom || {}).map((c) => ({ ...c }))
      for (const x of S.expected) if (expecting(x.hex) > 0n) out.push({ asset: x.hex, atoms: x.atoms })
      return out
    },
    receiveArgs,
    // Whether the wallet boards `atoms` of `asset` held at its address by itself (the operator
    // serves the asset, and it is at least its smallest leaf): such a deposit is arriving until its
    // board is final.
    boardable: (asset, atoms) => {
      const a = ((S.info && S.info.server_info && S.info.server_info.assets) || []).find((x) => x && x.asset === asset)
      return !!a && big(atoms) >= bigOf(a.min_leaf)
    },
    // The Bitcoin blocks that bury a block's anchor before the wallet calls it final (the operator's).
    anchorDepth: () => (S.info && Number.isFinite(Number(S.info.anchor_depth)) ? Number(S.info.anchor_depth) : null),
    // The assets the figure holds some of (and, as before places are read, those expected).
    leafAssets: () => [...new Set([...[...leafBalances(shown()).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a), ...S.expected.map((x) => x.hex)])].filter((h) => liveLeaves(h) + (placesOn() ? 0n : expecting(h)) > 0n),
    // A payment made to this wallet that the library has not taken in yet: `hex`, `atoms`.
    // `ms`: how long it is counted as arriving at most (two minutes unless said).
    expect: (hex, atoms, ms = 120000) => {
      if (!/^[0-9a-f]{64}$/.test(String(hex || '')) || !(big(atoms) > 0n)) return
      S.expected.push({ hex, atoms: big(atoms), base: liveLeaves(hex), until: now() + ms })
      if (ctx.onChange) try { ctx.onChange() } catch {}
    },
    syncNow,
    takeIn,
    // The receive code the faucet (or any payer the page hears from) has just paid: forgotten, so
    // the next one shown is new. A code is paid once.
    forgetCode: (owner) => {
      const key = tagged(CODE_KEY, tag())
      try { const kept = JSON.parse(ctx.store.getItem(key) || 'null'); if (kept && (!owner || kept.owner === owner)) ctx.store.removeItem(key) } catch {}
    },
    // ---- every coin home (default mode's "Take my coins home") ----
    // While the operator cannot be reached, as the library last said: the coins that could go home
    // ({ leaf_id, asset, value }) and since when; else null.
    homeOffer: () => {
      if (!S.open || !S.unreachable) return null
      const coins = homeCoins(S.coins).map((c) => ({ leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? '') }))
      return coins.length ? { coins, since: S.unreachable.since } : null
    },
    // Each coin's exit, quoted: { quotes: [{ coin, quote }], channels: [coin], refused: [{ coin, error }] }.
    homeQuote: () => asking(async () => { while (S.busy) await sleep(50); return act('home_quote', () => homeQuote()) }),
    // Broadcasts what homeQuote quoted, each on the fees it showed: { started, refused }.
    takeHome: (q) => asking(async () => { while (S.busy) await sleep(50); return act('home', () => takeHome(q)) }),
    homeUnderWay,
    // ---- default mode (default-arca.js) ----
    // What of an asset is arriving (held, not yet spendable), in atoms.
    // What of the figure is not spendable yet: nothing in default mode with places read (the figure
    // holds none of it); else the library's arriving states and what is expected.
    arriving: (hex) => (placesOn() ? 0n : arrivingAtoms(shown(), hex) + expecting(hex)),
    // Default mode with places read: what of an asset is on its way to the wallet and in no figure
    // yet (the coins the library places as arriving, and payments it has not taken in yet), in
    // atoms. A payment or a move out of it goes through after the next settlement (`paying`,
    // `settle_first`), so it counts in what can be sent. Otherwise 0n: the figure holds it.
    onItsWay: (hex) => (placesOn() ? (arrivingByAsset(shownPlaces()).get(hex) || 0n) + expecting(hex) : 0n),
    // Of what is arriving, what is being redone after a Bitcoin reorganisation, in atoms.
    redoing: (hex) => redoingAtoms(S.coins, hex),
    // What was moved out to keep it safe while the wallet was away, until it is put back, in atoms.
    keptSafe: (hex) => keptSafeAtoms(shown(), hex),
    // What vests later (a vesting allocation), as `claims` last listed it: each asset's entries
    // ({ asset, vest, vests, atoms }), earliest first; in atoms; and the assets anything vests in.
    // Part of the figure, never of what can be spent.
    vesting: (hex) => (hex ? vestingFor(vestingKept(), hex) : vestingKept()),
    vestingAtoms: (hex) => vestingAtoms(vestingKept(), hex),
    vestingAssets: () => vestingAssets(vestingKept()),
    // Whether the library has given its balance this session (the figures are its own, not the
    // last ones kept), or the wallet has nothing with an operator to read.
    balanceRead: () => !!S.balance,
    // Whether the wallet is finding what it holds: the restore of a wallet opened in this browser
    // for the first time (or whose first restore was cut short), until it returns.
    restoring: () => !!S.restoring,
    // While restoring, since when the operator has not answered the restore (it is tried again
    // every RESTORE_RETRY_MS): { why, since }, else null.
    restoreStalled: () => (S.restoring && S.restoring.stalled) || null,
    // While restoring, how long it has run: 'slow' past RESTORE_SLOW_MS (a long history), 'long'
    // past RESTORE_LONG_MS (far longer than any history should take), else null.
    restoreSlow: () => (S.restoring && S.restoring.slow) || null,
    // Whether this wallet has, or joins by itself, a wallet with an operator whose balance is to be read.
    expected: () => !!(S.open || S.starting || joinedOperator(ctx.store, tag()) || (!dev() && pinned())),
    // The operator's anchor depth, as the library follows it (0: a coin is spendable once its
    // block is certified), or null before the library has said.
    anchorDepth: () => anchorDepth(S.info),
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
        const v = await act('send', () => paying('send', { request: text, amount: String(amount), asset }), { answerFirst: true }).catch((e) => { throw dev() ? devRefusal(e) : plainRefusal(e) })
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
    // The operator's smallest leaf of an asset, in atoms (an output below it is refused), or 0n.
    minLeaf: (hex) => { const a = ((S.info && S.info.server_info && S.info.server_info.assets) || []).find((x) => x && x.asset === hex); return a ? big(a.min_leaf) : 0n },
    roundInterval: () => { const f = S.info && S.info.server_info && S.info.server_info.fills; return (f && f.round_interval_seconds) || null },
    // The chain's block interval the operator follows, in seconds, or null.
    blockSeconds: () => { const f = S.info && S.info.server_info && S.info.server_info.fills; return (f && f.block_seconds) || null },
    // Boards the chain's new coins soon (the page calls it when its own scan sees them).
    boardSoon: () => { if (S.open && !dev()) upkeepSoon(2000) },
    releaseFor: (asset, leaves) => releaseFor(asset, leaves),
    // What a payment to a receive code would cost, paying nothing (the library's `send_quote`): its
    // route, its fee in the asset paid and the coins it gives up, or the payment's own refusal.
    sendQuote: (text, amount, asset) => asking(() => act('send_quote', () => run('send_quote', { request: text, amount: String(amount), asset }), { answerFirst: true })),
    // Why a payment waits for a round, while it does: 'channel' (a channel's side set free first),
    // 'depth' or a plan's release; null when none waits.
    releasing: () => (S.releasing ? { why: S.releasing.why || 'planned', asset: S.releasing.asset, coins: S.releasing.coins.length, since: S.releasing.since } : null),
    refreshSoon: () => refreshSoon(),
    joinError: () => S.joinError || null,
    // `atoms` of an asset as the page's own reading of the chain shows them, less what a board just
    // made spent that the reading does not show spent yet (default-arca.js onchainLessBoards).
    onchainLessBoards: (hex, atoms) => {
      const all = boardsKept()
      if (!all[hex]) return big(atoms)
      const r = onchainLessBoards(all[hex], atoms, now(), ctx.holdsTx)
      if (r.seen) keepBoard(hex, null)
      return r.atoms
    },
    // ---- the wallet's own upkeep outside this module (lightning-to-ark.js) ----
    // What the library said of itself and the operator (`info`), and the coins as last read.
    info: () => S.info,
    coins: () => S.coins,
    // Whether a person is using the wallet now, or did within the last twenty seconds.
    personBusy: () => !!S.asked || now() - (S.lastAsked || 0) < MAILBOX_QUIET_MS,
    // A command of the wallet's own, run when nothing else runs and never counted as a person's.
    own: async (cmd, args) => {
      if (!S.open) throw new LeafError({ kind: 'refused', message: 'this wallet holds no leaves' })
      while (S.busy) await sleep(50)
      S.busy = true
      try { return await run(cmd, args || {}) } finally { S.busy = false }
    },
    // The wallet's channels as it holds them (the library's `channels`).
    channels: () => S.channels || [],
    // Holds the channel reads for `ms` (0 lets them go on): while a person reviews a payment,
    // so the payment never waits for one.
    holdReads: (ms) => { S.holdUntil = ms > 0 ? now() + ms : 0 },
    // The assets the operator serves in the tree.
    servedAssets: () => (((S.info && S.info.server_info && S.info.server_info.assets) || []).map((a) => a && a.asset).filter(Boolean)),
    stop: () => { S.stopped = true; clearTimeout(S.chanTimer); clearTimeout(S.timer); clearTimeout(S.upkeepTimer); clearTimeout(S.joinTimer); clearTimeout(S.mailTimer); clearTimeout(S.refreshTimer); clearTimeout(S.needTimer) },
  }
  render()
  return api
}
