#!/usr/bin/env node
// A live leaf maker: it holds leaves of one operator's tree, quotes in-tree swaps for the pairs
// its configuration names, and settles each in one reassignment with the wallet that takes it.
// It is the in-tree source of the user-mode composer's single-step book
// (tooling/lsp/single-step-book.mjs 'leaf-maker'; user-trade.js settles against it).
//
// It quotes only what it holds: a quote's `max_give` is what its leaf library can pay now
// (its live coins, less the coin of any open offline-refresh plan; a firm offer's coins are held
// for it and are not live), less a margin for the swap's own fees. Nothing it cannot fill is
// quoted.
//
// HTTP (JSON; CORS open, since a page may reach it from another origin):
//   GET  /health              -> { ok, operator, genesis_hash }
//   GET  /v1/quotes           -> { operator, genesis_hash, as_of, quotes: [{ give_asset, want_asset, rate_num, rate_den,
//                                  min_give, max_give }] }   (the maker gives give_asset and wants
//                                  ceil(give × rate_num / rate_den) of want_asset; with a ladder, one
//                                  quote a level, each carrying the depth of the levels before it), from
//                                  the holdings read at `as_of` (unix seconds): every pass and every offer
//                                  renews them, and a quote never waits on the library
//   POST /v1/firm {give_asset, want_asset, give}  -> { swap, offer, give, want, expires_at }: an in-tree swap
//                                  offer of the leaf library's (`swap_offer`), its coins held until it is
//                                  completed, released or lapses (`offer_ttl_seconds`), priced by walking
//                                  the ladder's levels: never above ceil(give × the rate of any quote
//                                  whose max_give carries `give`)
//   POST /v1/accept {swap, accept} -> { swap, state: 'done' }: completes the swap (`swap_complete`, the
//                                  operator co-signing); asked again it answers the same. When the
//                                  operator refuses the completion, nothing is co-signed and the offer
//                                  is gone: 409 { error, swap, gone: true, code, whose, coin, offer? },
//                                  `whose` naming the side whose coin the operator refused ('taker' when
//                                  the wallet's coin was spent elsewhere), `offer` a new firm offer at the
//                                  same give, at the live price when it asks no more than before (the shape of
//                                  /v1/firm's answer) when it can make one; asked again, the same answer
//   POST /v1/release {swap}       -> { swap, state: 'releasing' }: cancels a firm offer nobody took; answered
//                                  at once, the cancel ahead of the upkeep and of any later firm
//   GET  /v1/swap/<id>            -> { swap, state }
//   GET  /v1/explain              -> read-only: its budget and what fills it (by asset, kind, state and
//                                  the library's lineage), held back at caps, headroom, working sizes,
//                                  why each asset is not offered (README: "The live leaf maker")
//
// Run:  node tooling/lsp/leaf-maker.mjs --config maker.json
//       node tooling/lsp/leaf-maker.mjs --config maker.json --init   (draws the maker's phrase, once;
//            LWK_PKG names the wallet kit's lwk_wasm build when ../../pkg is not there)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --ask-faucet URL ASSET TICKER
//            (a receive request paid by the testnet faucet as a leaf; prints what came, exits)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --address    (its on-chain address)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --held ASSET (atoms it holds in leaves)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --pay FILE   (pays the receive
//            requests in FILE from its leaves, in the tree; for a drill's wallets)
//       node tooling/lsp/leaf-maker.mjs --config maker.json --receive ASSET ATOMS   (a receive
//            request for at most ATOMS of ASSET, cut to its instant budget's room; another
//            maker's --pay then moves those coins to it in the tree)
// The one-shot modes open the maker's store: stop its service first.
//
// The configuration (JSON) names the maker's own wallet and nothing else's:
//   { "wallet": "leaf-maker-1",                 a name of the maker's own; a service or treasury
//                                                wallet's name (treasury, reserve, faucet, bridge,
//                                                sbtc, pool, fee, service) is refused
//     "mnemonic_file": "/path/mnemonic",        mode 0600, the maker's own phrase (--init writes it)
//     "store_dir": "/path/store",               the leaf library's store
//     "operator": { "server": "https://…/arca", "node_url": "https://…/node", "node_user": "…",
//                   "node_password_file": "/path/…" },
//     "listen": "127.0.0.1:9979",
//     "pairs": [ { "give": "<asset hex>", "want": "<asset hex>", "rate_num": "1", "rate_den": "1",
//                  "min_give": "10000" } ],      or "price": true in place of the rate, priced from
//     "prices": { "url": "https://…/prices",    the price server's feed with the spread on the
//                 "spread_bps": 100,             maker's side, read every minute; a pair whose
//                 "assets": { "<hex>": { "ticker": "USDX", "precision": 8 } } },   price is missing
//                                                or older than ten minutes is not quoted
//     "ladder": { "levels": 8, "step_bps": 25, "growth": 1.25, "first": "5000000" },   optional, and a
//                                                pair may carry its own: what it holds of an asset it
//                                                gives is quoted at `levels` price levels, each
//                                                `step_bps` further from its rate and `growth` times
//                                                larger than the one before, level 1 `first` atoms
//                                                (else the holding split over the levels), one quote
//                                                a level, cumulative (quote k: level k's rate, the
//                                                depth of levels 1..k); a firm offer walks the levels
//                                                (leaf-maker-ladder.mjs). Without it, one level of
//                                                all it holds
//     "fee_margin": "2000",                      atoms of each asset kept back for a swap's fees
//     "offer_ttl_seconds": 300, "sync_seconds": 20, "settle_seconds": 600,
//     "board_keep": "100000",                    on-chain atoms of each asset it gives that it keeps
//                                                (for exit fees); what it holds above that is boarded.
//                                                This, coin_size and fee_margin each take one figure
//                                                for every asset, or { "<asset hex>": "atoms", …,
//                                                "default": "atoms" }
//     "coin_size": "2000000",                    optional: boards in coins of at most this many atoms
//                                                (and never above a working coin), one a pass;
//                                                a coin of a round larger than this is merged only
//                                                once twice `max_coins` are live
//     "max_coins": 32,                           optional, one figure or one an asset: past it, coins
//                                                are merged (boards and small coins first), and at
//                                                twice it boards stop
//     "merge_max_coins": 4,                      optional: no merge makes a coin of more than this
//                                                many `coin_size`, nor above a working coin
//     "exit_delay_units": 36,                    optional; the operator's default otherwise
//     "rest": { … },                             optional: orders resting in the tree, a ladder a
//                                                pair, listed on SeqDEX's relay (leaf-maker-rest.mjs
//                                                says how)
//     "instant_budget": "0.1",                  optional: the share of the operator's bond, at its
//                                                node's rate, the maker holds out of round at most
//                                                ("off" for none; default 0.1, a tenth). The lower of
//                                                it and the share the operator suggests is taken;
//                                                quotes are cut to the room left, and past it the
//                                                maker says it takes the rest after its next round
//     "report": { "relay": "http://…" },        optional: where its trades are reported (else the
//                                                resting desk's relay); trade-report.mjs says how
//     "btc": { … } }                             optional: BTC for an asset and an asset for BTC in
//                                                one hash-lock, from the maker's own Bitcoin
//                                                Lightning node (leaf-maker-btc.mjs says how)
// Every coin the maker receives is refreshed in the operator's next round once it has rested
// `settle_seconds`, so what it trades settles as the takers' coins do; on its first pass after a
// start, every coin it already holds; and at once, all of them, when an offer is refused because
// it would hold more out of round than the operator's bond covers, or than its instant budget, or
// when it holds more than half its budget out of round. For each asset it gives it keeps four
// working coins worth at most a quarter of its budget each (D94; workingSizes and the README's
// "Working coins"), cut inside rounds, and quotes no more than such a coin pays.
// A coin of a round is refreshed again only when it is merged (past `max_coins`): every refresh of
// a coin of a round keeps the operator's capital out until the node it leaves comes back.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leafLibraryThread } from '../leaf-node.mjs'
import { spendableFrom } from '../../user-trade.js'
import { btcDesk } from './leaf-maker-btc.mjs'
import { restDesk } from './leaf-maker-rest.mjs'
import { tradeReporter, makerRelayKey } from './trade-report.mjs'
import { perAsset, ladderOf, slicesOf, ladderQuotes, walkWant } from './leaf-maker-ladder.mjs'

// The maker is the only store of its phrase: its sync leaves out the catch-up between stores of one
// phrase, which finds nothing here and reads every coin ever served to its mailbox to find that out.
// It reads the coins it holds only (`held`), not the thousands it traded away, each as the store
// holds it (`brief`): no dates, notes or exit fees, whose reads (an exit fee of a board reads every
// on-chain script the maker ever drew) held the library for seconds ahead of every firm offer. A
// library without these arguments ignores them and does as before.
export const SYNC_ARGS = Object.freeze({ catch_up: false })
// The upkeep's sync leaves the watchtowers' step out and runs it next as a command of its own
// (`deposits`): a firm offer or an acceptance, which goes ahead of the upkeep's queue, then waits
// for one of the two at most, not for both. A library without the argument deposits in its sync,
// and refuses the command (`no command`), which the upkeep passes over in silence.
export const UPKEEP_SYNC_ARGS = Object.freeze({ ...SYNC_ARGS, deposits: false })
// The library runs one command at a time, and a command that has started runs to its end: a firm
// offer queued ahead of everything still waits out a sync already under way (14 s on the box,
// 13.8 s for the firm offer behind it, web #659), or a `deposits` (17 s). So the upkeep asks for
// both in slices of SLICE_MS (`budget_ms`): a library that takes the argument stops at the first
// point past it where the command can stop (between its steps, and between the items of a long
// step), answers `more: true`, and goes on where it stopped at the next call. Each slice is a
// command of its own in the queue, and a taker's firm offer or acceptance, queued first, runs
// between two of them: it waits for one slice at most. A library without the argument runs the
// whole command in one call and answers without `more`, as before. SLICES_MOST bounds one pass.
export const SLICE_MS = 1000
export const SLICES_MOST = 600
export async function sliced (cmd, name, args) {
  let r = null
  for (let i = 0; i < SLICES_MOST; i++) {
    r = await cmd(name, { ...(args || {}), budget_ms: SLICE_MS })
    if (!(r && typeof r === 'object' && !Array.isArray(r) && r.more === true)) break
  }
  return r
}
// The upkeep's sync, then its deposits as a command of their own (UPKEEP_SYNC_ARGS), each in
// slices; each failure logged, a library without the deposits command passed over in silence.
export async function upkeepSync (cmd, log) {
  try { await sliced(cmd, 'sync', UPKEEP_SYNC_ARGS) } catch (e) { log('sync:', e.message) }
  try { await sliced(cmd, 'deposits', {}) } catch (e) { if (!/no command/.test(String(e && e.message))) log('deposits:', e.message) }
}
export const HELD_COINS = Object.freeze({ held: true, brief: true })

// The live coins of an asset the maker keeps by default (`max_coins` per asset overrides it): enough
// for its offers at once, few enough that the library reads its store quickly before each command.
export const MAX_COINS = 32
// The most coins of an asset merged in one pass: four participations of 16.
export const MERGE_PER_PASS = 64

// Whether a coin is one of the maker's resting orders (an `order-3` leaf, or an `order-2` one from
// before it). Its order rests in the tree until a taker fills it or the resting desk cancels it; a
// refresh of it cancels the order, which the desk then rests again from another coin, and the
// operator fronts that coin anew. So a resting order is neither merged nor counted among the coins
// the maker keeps (`max_coins`).
export const isOrderCoin = (c) => !!c && typeof c.template === 'string' && c.template.startsWith('order-')

// The coins of `asset` to merge once more than `cap` are live, in one participation, MERGE_PER_PASS
// at most. A coin it received is left out (its own settling refreshes it), as are those in `exclude`
// and its resting orders (isOrderCoin), which count for nothing towards the cap.
// Every coin of a round given up keeps the operator's capital out until its lowest node comes back,
// while a board costs it nothing (its forfeit pays the operator back at once). So, under twice the
// cap: boards first, then coins of a round of at most `small` atoms (the maker's coin size), down to
// MERGE_TO of the cap. A merge's own coin is larger than that and is not merged again, which would
// front the whole of it at every coin that comes in. At twice the cap, the smallest coins of all,
// as few as bring the count back under it. None when fewer than two qualify.
export const MERGE_TO = 0.75
// With `most` (atoms), the coins merged in one pass hold at most that much together, so no merge
// makes a coin larger: a swap pays from the coins the maker holds, its change is out of round until
// its next round, and a coin many times the maker's trades put most of it out of round at every
// trade (`merge_max_coins` in the configuration: `most` is that many `coin_size`).
// With `working` (the asset's working-coin size, atoms), only crumbs are merged (coinShape): a
// working coin or a reserve is what a cut makes and keeps, and merging it would hand the next cut
// its coin (web wallet #783).
export function coinsToMerge (coins, asset, cap, exclude = [], small = null, most = null, working = null) {
  const live = (coins || []).filter((c) => c && c.asset === asset && c.state === 'live' && !isOrderCoin(c))
  if (live.length <= cap) return []
  const b = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
  const full = live.length >= 2 * cap
  const limit = small != null && !full ? b(small) : null
  let pool = live.filter((c) => c.kind !== 'transfer' && !exclude.includes(c.leaf_id) && (c.kind === 'board' || limit == null || b(c.value) <= limit) &&
    (working == null || coinShape(c.value, working) === 'crumb'))
    .sort((x, y) => ((x.kind === 'board') !== (y.kind === 'board') ? (x.kind === 'board' ? -1 : 1)
      : b(x.value) < b(y.value) ? -1 : b(x.value) > b(y.value) ? 1 : 0))
  if (most != null) {
    // The smallest first, as many as fit together under `most`.
    pool = pool.slice().sort((x, y) => (b(x.value) < b(y.value) ? -1 : b(x.value) > b(y.value) ? 1 : 0))
    let sum = 0n, k = 0
    while (k < pool.length && sum + b(pool[k].value) <= b(most)) { sum += b(pool[k].value); k++ }
    pool = pool.slice(0, k)
  }
  const target = full ? 2 * cap - Math.max(1, Math.floor(cap / 4)) : Math.floor(cap * MERGE_TO)
  const n = Math.min(MERGE_PER_PASS, live.length - target + 1, pool.length)
  return n < 2 ? [] : pool.slice(0, n).map((c) => c.leaf_id)
}

// The most the coins of `asset` merged in one pass hold together (coinsToMerge's `most`): the
// configuration's `merge_max_coins` times the asset's `coin_size`, and never more than a working
// coin (`working`, its atoms, when the budget gives one), so no merge makes a coin larger than a
// working coin; null (no bound) without any of them.
export function mergeMost (cfg, asset, working = null) {
  const k = Number(cfg && cfg.merge_max_coins)
  const coin = perAsset(cfg && cfg.coin_size, asset, null)
  const most = !(k >= 2) || coin == null ? null : big(coin) * BigInt(Math.floor(k))
  if (working == null) return most
  return most == null || big(working) < most ? big(working) : most
}

// What the maker holds out of round when an offer is refused for it, from its last reading of
// its coins: the coins received out of round (kind transfer or fill) in each state that counts,
// by state and asset (`name` gives an asset's ticker). The refusal's figure adds the payment asked.
// `unread`: a coin the maker knows its last trade made, not read from its library yet (knownCoins).
const HELD_OUT = ['live', 'offered', 'sending', 'given', 'forfeited', 'unread']
// Whether a coin counts against the budget as held out of round, as the library counts it (bond.rs
// `at_risk`): a coin of kind transfer or fill in a state that counts, except a live one whose lineage
// the library names as its own (`own`: its change, a piece it paid itself) or a trade's with its
// owner's exit (`trade`), which is at risk to nobody (`lineageOf`: leaf -> lineage, from coin_places;
// a coin it names none for counts). Without that exception a large change of its own, which it never
// settles (receivedOnly), would hold the room at nothing for good, every pair empty (web #778).
// A library that names the mark itself (arca #893: coin_places' `at_risk`, the same function as its
// bond's out_of_round) is read instead of this mirror: `lineageOf.atRisk` (leaf -> { at_risk,
// state }, the coin's state when it was marked) decides a coin whose state has not moved since.
// The mirror decides the rest, as that library counts when it names the mark (`lineageOf.marked`:
// a coin of its own lineage given to a round counts nothing, arca #889 fixed), and as an older one
// counts otherwise (given to a round, it counts at its whole value, #889's defect included), since
// the room must match what the library refuses. This is the one place that decides it.
export function heldOut (c, lineageOf = null) {
  if (!c || (c.kind !== 'transfer' && c.kind !== 'fill') || !HELD_OUT.includes(c.state)) return false
  const m = lineageOf && lineageOf.atRisk && lineageOf.atRisk.get(c.leaf_id)
  if (m && typeof m.at_risk === 'boolean' && m.state === c.state) return m.at_risk
  const l = lineageOf && lineageOf.get(c.leaf_id)
  const own = l === 'own' || l === 'trade'
  if (own && c.state === 'live') return false
  if (own && c.state === 'given' && lineageOf.marked) return false
  return true
}
// What the library's coin_places answer says of each coin into `lineageOf` (a Map: leaf ->
// lineage; `hopsOf`: leaf -> hops): its lineage and depth, and, when it names the mark (arca #893),
// whether it counts the coin against the budget now (`lineageOf.atRisk`, `lineageOf.marked`).
// `asked`: the coins the read was for, each marked as read in its state now, so a coin the answer
// names no mark for is not asked again until its state moves.
export function learnPlaces (places, lineageOf, hopsOf, asked = []) {
  if (!lineageOf.atRisk) lineageOf.atRisk = new Map()
  for (const c of (places && places.coins) || []) {
    if (!c || !c.leaf_id) continue
    if (c.lineage) lineageOf.set(c.leaf_id, c.lineage)
    if (hopsOf && Number.isFinite(c.hops)) hopsOf.set(c.leaf_id, c.hops)
    if ('at_risk' in c) { lineageOf.marked = true; lineageOf.atRisk.set(c.leaf_id, { at_risk: c.at_risk, state: c.state }) }
  }
  for (const c of asked) {
    if (!lineageOf.has(c.leaf_id)) lineageOf.set(c.leaf_id, null)
    const m = lineageOf.atRisk.get(c.leaf_id)
    if (lineageOf.marked && (!m || m.state !== c.state)) lineageOf.atRisk.set(c.leaf_id, { at_risk: null, state: c.state })
  }
}
// Whether coin_places is to be read again for `coins` (those of kind transfer or fill in a state
// that counts): one whose lineage is not known yet, or, from a library that names the mark, one
// whose state moved since it was marked.
export function placesStale (coins, lineageOf) {
  return (coins || []).some((c) => (c.state === 'live' && !lineageOf.has(c.leaf_id)) ||
    (lineageOf.marked && (() => { const m = lineageOf.atRisk && lineageOf.atRisk.get(c.leaf_id); return !m || m.state !== c.state })()))
}
export function outOfRoundSummary (coins, name = (a) => a, lineageOf = null) {
  const by = new Map()
  for (const c of coins || []) {
    if (!heldOut(c, lineageOf)) continue
    const k = c.state + ' ' + name(c.asset)
    const e = by.get(k) || { n: 0, atoms: 0n, largest: 0n }
    const v = big(c.value)
    e.n++; e.atoms += v; if (v > e.largest) e.largest = v
    by.set(k, e)
  }
  return [...by].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, e]) => `${k}: ${e.n} coin(s), ${e.atoms} atoms, the largest ${e.largest}`).join('; ') || 'none'
}

// The library's refusal of a payment that would leave the wallet holding more out of round than the
// operator's bond covers, or than its instant budget (a share of the bond).
export const OUT_OF_ROUND_FULL = /would hold out of round .* (more than the bond|past its instant budget)/

// The assets the operator takes on no more refreshes of now: its info shows as much of the asset in
// flight as its cap (`in_flight` at or past `in_flight_cap`), so a refresh of it waits until earlier
// ones come back. A coin of such an asset that the maker received out of round stays out of round
// all that time and counts against its instant budget, and past the budget the maker takes nothing
// in any pair. So the maker takes none of these assets in (no quote and no firm offer that wants
// one), and keeps giving them and trading every other pair. The same rule holds for every asset.
export function cappedAssets (info) {
  const out = new Set()
  const si = (info && info.server_info) || info || {}
  for (const a of si.assets || []) {
    if (!a || typeof a.asset !== 'string' || a.in_flight_cap == null) continue
    let used, cap
    try { used = BigInt(a.in_flight ?? 0); cap = BigInt(a.in_flight_cap) } catch { continue }
    if (used >= cap) out.add(a.asset)
  }
  return out
}
// What the operator can still take on of each asset it caps (`in_flight_cap` − `in_flight` in its
// info, never below 0): a refresh of more than that waits until earlier ones come back. -> Map.
export function headroomOf (info) {
  const out = new Map()
  const si = (info && info.server_info) || info || {}
  for (const a of si.assets || []) {
    if (!a || typeof a.asset !== 'string' || a.in_flight_cap == null) continue
    try { const h = BigInt(a.in_flight_cap) - BigInt(a.in_flight ?? 0); out.set(a.asset, h > 0n ? h : 0n) } catch {}
  }
  return out
}
// The share of an asset's headroom the maker counts on: other wallets refresh too.
export const HEADROOM_SHARE = { num: 9n, den: 10n }
// The assets the maker takes in no more of (sequentia-testnet-ops, web #659): those the operator
// caps now (cappedAssets), and those of which it already holds out of round (`outOfRound`, the
// library's bond answer: [{ asset, value }]) as much as the operator can take on in its rounds now
// (its headroom, at HEADROOM_SHARE): what it took in past that could not be refreshed at all, and
// would count against its budget, and so stop every pair, until the cap frees. -> Set.
export function intakeStopped (info, outOfRound) {
  const out = cappedAssets(info)
  const room = headroomOf(info)
  for (const h of outOfRound || []) {
    const r = h && room.get(h.asset)
    if (r == null) continue
    if (big(h.value) > 0n && big(h.value) >= (r * HEADROOM_SHARE.num) / HEADROOM_SHARE.den) out.add(h.asset)
  }
  return out
}
// What the maker can still take in of each asset the operator caps, judged from its coins as they
// are now (`coins`, the latest view, with what its last trades made), not from the last minute's
// reading: the share of the operator's headroom it counts on (HEADROOM_SHARE of cap less in flight,
// `info`) less what it holds out of round of the asset already (heldOut, `lineageOf`). A quote and
// a firm offer that want more are cut to it, so two offers in one minute never take in past what
// the operator can refresh (web #778, case c: 150,000 taken in against 90,000). -> Map asset ->
// atoms, only capped assets; empty without the operator's info.
export function intakeLeft (coins, info, lineageOf = null) {
  const out = new Map()
  if (!info) return out
  for (const [a, r] of headroomOf(info)) out.set(a, (r * HEADROOM_SHARE.num) / HEADROOM_SHARE.den)
  for (const c of coins || []) if (out.has(c && c.asset) && heldOut(c, lineageOf)) out.set(c.asset, out.get(c.asset) - big(c.value))
  for (const [a, v] of out) if (v < 0n) out.set(a, 0n)
  return out
}
// Two bounds on what is taken in (asset -> atoms, or null for none), the lower of each asset's.
export function lowerRoom (x, y) {
  if (!x) return y || null
  if (!y) return x
  const out = new Map(x)
  for (const [a, v] of y) out.set(a, out.has(a) && out.get(a) < v ? out.get(a) : v)
  return out
}
// The due coins of each settle group that the operator can take in this round: of an asset it caps,
// the smallest first, as many as fit together in its headroom (at HEADROOM_SHARE). A participation
// of more than the headroom is held back by the operator and withdrawn, then asked again whole ten
// minutes later, and never fits while the cap stays near full: the coins stayed out of round, and
// counted against the budget, for good (web #659: 5.33 million SEQ on the BTC desk). The rest wait
// for a later pass. `coins` gives the values. -> { groups (settleGroups' shape), waiting: [{ asset,
// leaves }] }.
//
// A received coin larger than the share of the headroom alone (`alone`: the leaves that may go so)
// is given by itself when nothing smaller of its asset fits: it counts against the budget at its
// whole value whether it is live or given, so holding it back never makes room, and only a
// refresh ends it. The operator runs it as soon as it can (when what it opens fits, or by its
// rule for refreshes that bring a node back, arca server/src/rounds.rs `CapJudge`); meanwhile
// the library takes it back after 120 s and the maker gives it again GIVE_UP_AGAIN_MS later.
export function withinHeadroom (groups, coins, headroom, alone = null) {
  const of = new Map((coins || []).map((c) => [c && c.leaf_id, c]))
  const out = [], waiting = []
  for (const g of groups || []) {
    const r = headroom && headroom.get(g.asset)
    if (r == null) { out.push(g); continue }
    const most = (r * HEADROOM_SHARE.num) / HEADROOM_SHARE.den
    const sorted = g.leaves.slice().sort((x, y) => { const a = big(of.get(x) && of.get(x).value), b = big(of.get(y) && of.get(y).value); return a < b ? -1 : a > b ? 1 : 0 })
    const take = [], rest = []
    let sum = 0n
    for (const id of sorted) { const v = big(of.get(id) && of.get(id).value); if (sum + v <= most) { take.push(id); sum += v } else rest.push(id) }
    if (!take.length && alone) { const i = rest.findIndex((id) => alone.has(id)); if (i >= 0) take.push(...rest.splice(i, 1)) }
    if (take.length) out.push({ ...g, leaves: take })
    if (rest.length) waiting.push({ asset: g.asset, leaves: rest })
  }
  return { groups: out, waiting }
}
// The quotes and the pairs named for after the next round, less those that want a capped asset.
export function withoutCapped (quotes, later, capped) {
  if (!capped || !capped.size) return { quotes, later }
  return { quotes: (quotes || []).filter((q) => !capped.has(q.want_asset)), later: (later || []).filter((x) => !capped.has(x.want_asset)) }
}
// The refusal of a firm offer that wants a capped asset (`name`: its ticker, or its id).
export function cappedRefusal (name) {
  return `the maker takes no ${name} now: the operator is refreshing as much ${name} as it takes on at once, so ${name} received now would wait out of round and hold the maker's other pairs back`
}

// What the maker holds out of round that the operator's cap holds back (web wallet #502): of each
// asset it holds out of round (`outOfRound`, the library's `bond` answer: [{ asset, value }]), all
// of it when refreshing it would take what the operator has in flight of the asset past its cap.
// Those coins wait out of round until earlier refreshes come back, whatever the maker does. ->
// Map asset -> atoms.
export function heldAtCap (outOfRound, info) {
  const si = (info && info.server_info) || info || {}
  const caps = new Map()
  for (const a of si.assets || []) {
    if (!a || typeof a.asset !== 'string' || a.in_flight_cap == null) continue
    try { caps.set(a.asset, { used: BigInt(a.in_flight ?? 0), cap: BigInt(a.in_flight_cap) }) } catch {}
  }
  const out = new Map()
  for (const h of outOfRound || []) {
    const c = h && caps.get(h.asset)
    const v = big(h && h.value)
    if (c && v > 0n && c.used + v > c.cap) out.set(h.asset, v)
  }
  return out
}
// What stays held back (`prev`, the last pass's heldAtCap or heldBack) beside what the cap holds
// back now (`now`): an asset the cap held back stays so while the maker still holds at least as
// much of it out of round (`outOfRound`), counted at what was held back. The cap freeing lets its refresh run, but only in the
// operator's next round: until the coins are refreshed they still fill the budget, and dropping
// the widening as soon as the cap frees deferred every other pair for that round. -> Map.
export function heldBack (prev, now, outOfRound) {
  const out = new Map(now || [])
  const held = new Map((outOfRound || []).map((h) => [h && h.asset, big(h && h.value)]))
  for (const [a, v] of prev || []) {
    if (out.has(a)) continue
    const h = held.get(a) || 0n
    // At most what was held back: coins taken in since count against the budget as any others.
    if (h > 0n && h >= v) out.set(a, v)
  }
  return out
}
// What is held back, kept in the store across a restart: a maker restarted after the cap freed
// would otherwise forget coins whose refresh still waits, and go back to its base share at once.
// `text` is the file's contents (or null); -> Map asset -> atoms. heldBackText writes one.
export function heldBackFrom (text) {
  try {
    const j = JSON.parse(text || '{}')
    return new Map(Object.entries(j).filter(([a, v]) => /^[0-9a-f]{64}$/.test(a) && /^\d+$/.test(String(v))).map(([a, v]) => [a, BigInt(v)]))
  } catch { return new Map() }
}
export const heldBackText = (m) => JSON.stringify(Object.fromEntries([...m].map(([a, v]) => [a, String(v)])))
// The share of the bond, in millionths, the maker sets as its own instant budget: its configured
// share (`basePpm`), plus what it holds that the cap holds back (`stuck`, from heldAtCap), worth
// `atoms * rate / 1e8` reference atoms at the node's fee exchange rates (`rates`: asset -> rate),
// over the bond's value (`bondValue`, reference atoms). So coins of one asset the operator cannot
// refresh now take none of the room the maker's other pairs trade in: they stop only that asset's
// own intake, which cappedAssets already stops. The library still takes the lower of this and the
// operator's suggestion, and refuses whatever the bond does not cover. An asset the node does not
// price adds nothing: no room is made for what cannot be weighed. Never past the whole bond.
export function budgetPpm (basePpm, stuck, rates, bondValue) {
  const bond = big(bondValue)
  if (!stuck || !stuck.size || bond <= 0n) return basePpm
  let worth = 0n
  for (const [a, v] of stuck) {
    const r = rates && rates.get(a)
    if (r == null || big(r) <= 0n) continue
    worth += (v * big(r)) / 100_000_000n
  }
  const extra = Number((worth * 1_000_000n + bond - 1n) / bond)
  return Math.min(1_000_000, basePpm + extra)
}
// A share in millionths as the library's `instant_budget` takes it ("0.1").
export const shareText = (ppm) => String(ppm / 1_000_000)

// The share of the operator's bond the maker holds out of round at most, unless its configuration
// names another ("off" for none): a tenth, so that a double-sign of what the maker holds at once
// costs the operator ten times what it could take from it.
export const DEFAULT_INSTANT_BUDGET = '0.1'

// Working coins (D94). A swap pays from one coin, and that coin's whole worth is then out of round
// until the next round: its change, and what the taker pays in its place. So for each asset it
// gives, the maker keeps WORKING_COUNT coins worth at most 1/WORKING_SHARE of its instant budget
// shared among the assets it gives (so the first trade in every one of them together puts at most
// that share out of round), at its node's rates, and the rest in larger reserve coins that a small
// swap does not reach (the library pays a swap from the smallest coin that pays it alone, a coin
// already out of round first, whose spend puts nothing more out of round). The size is derived from
// the budget at every pass, never a fixed number of atoms; coins are cut to it inside rounds (a
// refresh in pieces), never by a payment to itself out of round.
export const WORKING_SHARE = 4n
export const WORKING_COUNT = 4
const atomsOf = (value, rate) => (big(rate) > 0n ? (big(value) * 100_000_000n) / big(rate) : null)
const worthOf = (atoms, rate) => (big(atoms) * big(rate)) / 100_000_000n

// The size of a working coin of each asset the node prices: a quarter of the instant budget (the
// library's `bond` answer, `instant_budget.value`, reference atoms) shared among the `given` assets
// the maker gives (one when not named), in atoms at `rates` (asset -> reference atoms per 1e8
// atoms, as the library weighs the budget). -> Map asset -> atoms, empty while no budget is set.
export function workingSizes (bond, rates, given = 1) {
  const b = bond && bond.instant_budget
  const out = new Map()
  if (!b || b.value == null) return out
  const n = BigInt(Math.max(1, Number(given) || 1))
  const q = big(b.value) / WORKING_SHARE / n
  if (q <= 0n) return out
  for (const [a, r] of rates || []) { const n = atomsOf(q, r); if (n != null && n > 0n) out.set(a, n) }
  return out
}

// How long a coin the maker gave up in a round, and the library took back (a refresh that waited
// for the operator's funds or its in-flight cap, WITHDRAW_AFTER 120 s, or one a swap needed), is
// left before it is given up again: the library's own RETRY_AFTER for received coins. Without it
// the maker would give the coin up and take it back every pass while the cap stays full.
export const GIVE_UP_AGAIN_MS = 600_000

// What a coin of `value` atoms is beside the asset's working-coin size `size` (web wallet #783),
// the one rule the cut (shapeFor) and the merge (coinsToMerge) both read, so neither takes what the
// other makes:
// - 'crumb': under half a working coin. It pays no trade of a working coin's size; merges gather
//   crumbs, and a cut never makes one.
// - 'working': from half a working coin up to a coin that cannot be cut into one working coin and a
//   rest of at least `floor` (cutFloor). A cut makes these and a merge never takes them.
// - 'reserve': larger, a coin a cut can take: one working coin and a rest worth holding, once the
//   refresh's fee is paid (at most MAX_REFRESH_FEE_PPM of the coin, the library's own bound).
// The working size is worked out from the budget and the node's rates at every pass and moves by a
// few atoms a minute; a coin cut at last minute's size stays a working coin until the size falls
// by about a third or doubles, and only such a move reshapes the coins. -> 'crumb' | 'working' |
// 'reserve'.
export const MAX_REFRESH_FEE_PPM = 10_000n
// What of a coin is left once a refresh's fee is paid, at the most the library pays without being
// told a bound (DEFAULT_MAX_FEE_PPM in arca bark/src/arca/round.rs).
const afterFee = (v) => big(v) - (big(v) * MAX_REFRESH_FEE_PPM + 999_999n) / 1_000_000n
// The smallest rest a cut leaves beside its working coins: half a working coin (anything smaller
// is a crumb, which the merges would take), and never less than the asset's smallest quote
// (`least`, atoms: a coin under it quotes nothing).
export function cutFloor (size, least = null) {
  const half = (big(size) + 1n) / 2n
  const l = least == null ? 0n : big(least)
  return l > half ? l : half
}
export function coinShape (value, size, least = null) {
  const v = big(value), s = big(size)
  if (v * 2n < s) return 'crumb'
  return afterFee(v) >= s + cutFloor(s, least) ? 'reserve' : 'working'
}

// Working coins a cut makes beyond those missing, so the next trades' replenishments come from
// them and not from another cut: every cut gives a whole reserve to a round, and the operator
// fronts all of it until the reserve's old leaf comes back.
export const WORKING_FEEDER = 4
// The coin of `asset` to cut into working coins of `size` this pass, when fewer than WORKING_COUNT
// of its live coins are working coins (coinShape): its smallest reserve coin of a round or a board
// (never one received out of round, which settling takes into a round already, nor a resting
// order's) that holds every missing piece and WORKING_FEEDER more, else its smallest reserve, cut
// into as many of those as it holds beside a rest of at least cutFloor (`least`, the asset's
// smallest quote) once the fee is paid: so a cut never leaves a crumb and is never made for a coin
// a few atoms over the size. One cut of an asset at a time: none while one of its reserves is given
// to a round, nor for GIVE_UP_AGAIN_MS after the library took one back (`gaveUp`: leaf -> when the
// maker gave it up), since another reserve given meanwhile is fronted whole as well. And none of a
// coin larger than HEADROOM_SHARE of the operator's headroom in the asset (`headroom`, of an asset
// it caps): the operator cannot take it on, and it would wait given. -> { leaf, piece, pieces }, or
// { waits, leaf, value, headroom } when the coin it would cut is larger than that, or null.
export function shapeFor (coins, asset, size, gaveUp = new Map(), now = Date.now(), least = null, headroom = null) {
  if (size == null || big(size) <= 0n) return null
  const s = big(size)
  const mine = (coins || []).filter((c) => c && c.asset === asset && !isOrderCoin(c))
  const reserveOf = (c) => (c.kind === 'batch' || c.kind === 'board') && coinShape(c.value, s, least) === 'reserve'
  if (mine.some((c) => c.state === 'given' && reserveOf(c))) return null
  const live = mine.filter((c) => c.state === 'live')
  // Crumbs a swap's change left do not count: they pay no trade of a working coin's size (merges
  // gather them).
  const working = live.filter((c) => coinShape(c.value, s, least) === 'working').length
  if (working >= WORKING_COUNT) return null
  const reserve = live.filter(reserveOf).sort((x, y) => (big(x.value) < big(y.value) ? -1 : big(x.value) > big(y.value) ? 1 : 0))
  if (reserve.some((c) => gaveUp && now - (gaveUp.get(c.leaf_id) ?? -Infinity) < GIVE_UP_AGAIN_MS)) return null
  if (!reserve.length) return null
  const holds = (c) => Number((afterFee(c.value) - cutFloor(s, least)) / s)
  const want = WORKING_COUNT - working + WORKING_FEEDER
  const coin = reserve.find((c) => holds(c) >= want) || reserve[0]
  const room = headroom && headroom.get(asset)
  if (room != null && big(coin.value) > (big(room) * HEADROOM_SHARE.num) / HEADROOM_SHARE.den) return { waits: true, leaf: coin.leaf_id, value: String(coin.value), headroom: String(room) }
  return { leaf: coin.leaf_id, piece: String(s), pieces: Math.min(want, holds(coin), MAX_CUT_PIECES) }
}
// The most pieces one cut asks for: the library makes at most 14 (MAX_PIECES in arca
// bark/src/arca/round.rs) beside the rest.
export const MAX_CUT_PIECES = 14

// The room left in the maker's instant budget now, in reference atoms, from its coins as they are
// (`coins`, the latest reading) rather than from the last pass: the budget's value (`budgetValue`,
// the library's `bond` answer, which moves only with the bond asset's rate) less the worth of what
// it holds out of round (coins received or made by a payment out of round, kind transfer or fill,
// in a state the library counts), and less the worth of every coin an open firm offer holds (state
// offered, a coin of a round or a board), which is out of round in full once its swap completes.
// A coin of an asset the node does not price leaves no room at all (it cannot be weighed). Null
// without a budget. So a swap that completes takes its room at the next reading of the coins, which
// the maker makes at every offer and completion, and two offers open at once never pass the budget
// together (web wallet #632, #653).
export function roomNow (budgetValue, coins, rates, lineageOf = null) {
  if (budgetValue == null) return null
  let room = big(budgetValue)
  for (const c of coins || []) {
    if (!c) continue
    const out = heldOut(c, lineageOf)
    const offered = c.state === 'offered' && c.kind !== 'transfer' && c.kind !== 'fill'
    if (!out && !offered) continue
    const r = rates && rates.get(c.asset)
    if (r == null || big(r) <= 0n) return 0n
    room -= worthOf(c.value, r)
  }
  return room < 0n ? 0n : room
}

// The coins as the maker knows them now (web #659): its last reading of the library's coins
// (`coins`, read from `from`, ms), with what it did itself since then (`changes`), so that its book
// is never emptied while it reads its coins again or reshapes them: it offers from what it holds,
// less what its trades took and what it gave to a round, and the next reading corrects it. Each
// change is { at (ms), kind, id, leaves, made }:
//   offered: a firm offer of its own holds `leaves` (the library's swap_offer names them);
//   given:   `leaves` given to a round (a settle, a merge, a cut);
//   done:    `leaves` spent by a trade or a payment, which made `made` ([{ asset, value }]: the
//            change and what it was paid, out of round); each is a coin of kind transfer in state
//            `unread`, which the room counts (it is out of round) and nothing quotes (it is not
//            live) until a reading names it.
// A change older than the reading is in it already and is passed over; one whose coins the reading
// no longer holds as live or offered (the reading came after it) changes nothing. So the view never
// offers a coin the maker knows it gave or spent, and never counts a trade twice against its room.
export const UNREAD = 'unread'
export function knownCoins (coins, changes, from = 0) {
  const out = new Map((coins || []).filter(Boolean).map((c) => [c.leaf_id, c]))
  for (const ch of changes || []) {
    if (!ch || ch.at < from) continue
    const here = (ch.leaves || []).filter((id) => { const c = out.get(id); return c && (c.state === 'live' || c.state === 'offered') })
    if (ch.kind === 'offered') { for (const id of here) out.set(id, { ...out.get(id), state: 'offered' }); continue }
    if (ch.kind === 'given') { for (const id of here) if (out.get(id).state === 'live') out.set(id, { ...out.get(id), state: 'given' }); continue }
    if (ch.kind === 'done' && here.length) {
      for (const id of here) out.delete(id)
      ;(ch.made || []).forEach((m, i) => { if (m && big(m.value) > 0n) out.set(`unread:${ch.id}:${i}`, { leaf_id: `unread:${ch.id}:${i}`, asset: m.asset, value: String(m.value), kind: 'transfer', state: UNREAD }) })
    }
  }
  return [...out.values()]
}
// What a trade made for the maker, from the library's swap_offer answer (its `details.outputs`: what
// it is paid, and its change), else what the offer asked: [{ asset, value }].
export function madeBy (offer, wantAsset, want) {
  const outs = offer && offer.details && Array.isArray(offer.details.outputs) ? offer.details.outputs : null
  const made = outs ? outs.map((o) => ({ asset: o && o.asset, value: String((o && o.value) ?? 0) })).filter((o) => typeof o.asset === 'string' && big(o.value) > 0n) : []
  return made.length ? made : [{ asset: wantAsset, value: String(want) }]
}
// The coins a library answer names as spent or held by it (swap_offer's `details.inputs`,
// lightning_pay's `inputs`): leaf ids.
export function leavesOf (answer) {
  const xs = (answer && answer.details && answer.details.inputs) || (answer && answer.inputs) || []
  return (Array.isArray(xs) ? xs : []).map((x) => (typeof x === 'string' ? x : x && x.leaf_id)).filter((x) => typeof x === 'string')
}

// What the maker's budget holds, for its explain answer: the coins that count against its room
// (held out of round, and coins of a round its open offers hold), by asset, kind and state, each
// with its count, atoms, worth (reference atoms at `rates`, null where unpriced) and largest coin;
// `name` gives an asset's ticker. -> [{ asset, kind, state, n, atoms, worth, largest }], the
// largest worth first.
export function budgetHeld (coins, rates, name = (a) => a, lineageOf = null) {
  const by = new Map()
  for (const c of coins || []) {
    if (!c) continue
    const out = heldOut(c, lineageOf)
    const offered = c.state === 'offered' && c.kind !== 'transfer' && c.kind !== 'fill'
    if (!out && !offered) continue
    const k = c.asset + ' ' + c.kind + ' ' + c.state
    const e = by.get(k) || { asset: name(c.asset), kind: c.kind, state: c.state, n: 0, atoms: 0n, worth: 0n, priced: true, largest: 0n }
    const r = rates && rates.get(c.asset)
    e.n++; e.atoms += big(c.value); if (big(c.value) > e.largest) e.largest = big(c.value)
    if (r == null || big(r) <= 0n) e.priced = false; else e.worth += worthOf(c.value, r)
    by.set(k, e)
  }
  return [...by.values()].sort((x, y) => (y.worth > x.worth ? 1 : y.worth < x.worth ? -1 : 0))
    .map((e) => ({ asset: e.asset, kind: e.kind, state: e.state, n: e.n, atoms: String(e.atoms), worth: e.priced ? String(e.worth) : null, largest: String(e.largest) }))
}

// The library's coin_places answer summed for the explain answer: the coins it holds by how they
// were made (`lineage`: own, a round's, a board's or its own change; trade, paid by a trade whose
// checkpoints all have their owner's exit; received, a payment or a trade without it, which is what
// the library counts against the budget at its whole value), asset, kind and state, with the most
// reassignments since a round of any of them (`hops`). -> [{ lineage, asset, kind, state, n, atoms,
// hops_most }].
export function lineageSummary (places, name = (a) => a) {
  const by = new Map()
  for (const c of (places && places.coins) || []) {
    if (!c || ['spent', 'exited', 'lost'].includes(c.state)) continue
    const k = [c.lineage, c.asset, c.kind, c.state].join(' ')
    const e = by.get(k) || { lineage: c.lineage || null, asset: name(c.asset), kind: c.kind, state: c.state, n: 0, atoms: 0n, hops_most: null }
    e.n++; e.atoms += big(c.value)
    if (Number.isFinite(c.hops) && (e.hops_most == null || c.hops > e.hops_most)) e.hops_most = c.hops
    by.set(k, e)
  }
  return [...by.values()].sort((x, y) => (y.atoms > x.atoms ? 1 : y.atoms < x.atoms ? -1 : 0)).map((e) => ({ ...e, atoms: String(e.atoms) }))
}

// The room left (`roomValue`, reference atoms) in atoms of each asset `rates` prices, rounded down:
// what a quote or a firm offer may take in of the asset it wants, from the same reading as the coin
// it gives from (roomNow). Null without a budget.
export function roomAtomsOf (roomValue, rates) {
  if (roomValue == null) return null
  const m = new Map()
  for (const [a, r] of rates || []) if (big(r) > 0n) m.set(a, (big(roomValue) * 100_000_000n) / big(r))
  return m
}

// What a swap paying from coin `c` adds to what the maker holds out of round, at `rate`: its whole
// worth for a coin of a round or a board (its change goes out of round), nothing for one already
// out of round (received or a swap's change, kind transfer or fill), whose change stays out of
// round and is smaller. The library pays from such a coin first.
export function costOf (c, rate) {
  return c && (c.kind === 'transfer' || c.kind === 'fill') ? 0n : worthOf(c.value, rate)
}

// What the maker can give of each asset now without holding more out of round than its budget:
// its largest live coin of the asset whose spend fits in the room left (costOf: a coin already out
// of round always does) (`roomValue`,
// reference atoms, roomNow), since that coin is out of round once a swap pays from it; nothing when
// none fits, and nothing of an asset the node does not price, which no budget can bound (#654).
// `sp` is what it can pay (asset -> atoms); with no budget (`roomValue` null) it stays as it is. A
// quote and a firm offer sized on this are never refused for the budget.
export function budgetedSpendable (sp, coins, roomValue, rates) {
  if (roomValue == null) return sp
  const out = new Map(sp)
  for (const [a, v] of sp || []) {
    const r = rates && rates.get(a)
    if (r == null || big(r) <= 0n) { out.set(a, 0n); continue }
    let best = 0n
    for (const c of coins || []) {
      if (!c || c.asset !== a || c.state !== 'live' || isOrderCoin(c)) continue
      const x = big(c.value)
      if (x > best && costOf(c, r) <= big(roomValue)) best = x
    }
    out.set(a, best < big(v) ? best : big(v))
  }
  return out
}

// Whether the maker holds out of round more than half its budget (the library's `bond` answer):
// it then settles what it received at once, not only on its timer.
export function pastHalfBudget (bond) {
  const b = bond && bond.instant_budget
  if (!b || b.value == null || b.held_value == null) return false
  return big(b.held_value) * 2n > big(b.value)
}

// The received coins due for settling, by asset, each with the piece its refresh is cut into (a
// working coin's size, when known): -> [{ asset, leaves, piece }].
export function settleGroups (coins, due, sizes) {
  const by = new Map()
  const of = new Map((coins || []).map((c) => [c.leaf_id, c]))
  for (const id of due || []) {
    const c = of.get(id)
    const a = c ? c.asset : ''
    if (!by.has(a)) by.set(a, [])
    by.get(a).push(id)
  }
  return [...by].map(([asset, leaves]) => ({ asset, leaves, piece: sizes && sizes.has(asset) ? String(sizes.get(asset)) : null }))
}

// What of an asset stays in the book once the upkeep gives `giving` (leaf ids) to a round: `need`,
// the largest quote it publishes now (a swap pays from one coin, so its largest free coin whose
// spend fits the room left, `roomValue` reference atoms at `rates`, as costOf weighs it: a coin
// already out of round always does; any coin without a budget); `target`, the smaller of that and a working coin (`sizes`), an ordinary trade; and
// `best`, the largest coin that would stay free and fit. A coin smaller than `least` (the smallest
// quote of the asset, its pairs' `min_give`) quotes nothing and counts for nothing. Free means
// live, not a resting order, not held as spent elsewhere.
export function bookAfter (coins, asset, giving, { roomValue = null, rates = null, sizes = null, least = null } = {}) {
  const gone = new Set(giving || [])
  const r = rates && rates.get(asset)
  const min = big(perAsset(least, asset, '1'))
  const fits = (c) => big(c.value) >= min && (roomValue == null || (r != null && big(r) > 0n && costOf(c, r) <= big(roomValue)))
  const free = (coins || []).filter((c) => c && c.asset === asset && c.state === 'live' && !isOrderCoin(c) && c.spent_elsewhere_until == null)
  let need = 0n, best = 0n
  for (const c of free) {
    if (!fits(c)) continue
    const v = big(c.value)
    if (v > need) need = v
    if (!gone.has(c.leaf_id) && v > best) best = v
  }
  const size = sizes && sizes.get(asset)
  const target = size != null && big(size) > 0n && big(size) < need ? big(size) : need
  return { need, target, best, free, fits }
}

// The coins the upkeep gives to a round this pass, of those due (`due`, leaf ids), so that it
// never gives the last free coin of an asset it quotes (sequentia-testnet-ops #235). Of each
// asset, what stays free must fill at least `target` (bookAfter); else the due coin its largest
// quote is sized on stays out and the rest go now. That coin goes in a later turn: once no coin of
// the asset is in a round, it goes when what is free beside it quotes (the asset then stays in the
// book at that smaller quote). An asset whose only free coin is itself due, with none in a round,
// cannot both keep it and settle it: it is kept while the maker can wait (`must` false), and goes
// whole when it must settle (`must`: past half its budget, or an offer refused for what it holds
// out of round), the asset then out of the book for the minute its round takes. It is never split
// by a payment to itself out of round: the library pays such a payment from whatever coin it picks,
// a reserve of millions among them, whose change is then held out of round at its whole value and
// fills the budget, which empties every pair (web #659). -> { give: [leaf ids], keep: [{ leaf,
// asset }] }.
export function keepFree (coins, due, opts = {}) {
  const of = new Map((coins || []).map((c) => [c && c.leaf_id, c]))
  const byAsset = new Map()
  for (const id of due || []) {
    const c = of.get(id)
    const a = c ? c.asset : ''
    if (!byAsset.has(a)) byAsset.set(a, [])
    byAsset.get(a).push(id)
  }
  const give = [], keep = []
  for (const [asset, ids] of byAsset) {
    const b = bookAfter(coins, asset, ids, opts)
    if (b.need === 0n || b.best >= b.target) { give.push(...ids); continue }
    // The due coin the largest quote is sized on: the largest that fits.
    const mine = ids.map((id) => of.get(id)).filter((c) => c && b.free.includes(c) && b.fits(c))
      .sort((x, y) => (big(y.value) > big(x.value) ? 1 : big(y.value) < big(x.value) ? -1 : 0))
    if (!mine.length) { give.push(...ids); continue }
    const top = mine[0]
    const others = ids.filter((id) => id !== top.leaf_id)
    // The other due coins go now and the top one stays; it stays too while coins of the asset are
    // in a round, whose coins come back to fill its place.
    const inRound = (coins || []).some((c) => c && c.asset === asset && c.state === 'given' && !isOrderCoin(c))
    if (others.length || inRound) { give.push(...others); keep.push({ leaf: top.leaf_id, asset }); continue }
    // Alone, beside smaller free coins: it goes, and the asset stays in the book at the smaller.
    if (b.best > 0n || opts.must) { give.push(top.leaf_id); continue }
    keep.push({ leaf: top.leaf_id, asset })
  }
  return { give, keep }
}

// Why the maker offers none of `asset` now, in words for its log, or null when it offers some:
// it holds none; every coin of it is in a round; every coin of it is held by an open offer or a
// BTC lock; its node prices it not; or no coin's spend fits the room left in its budget (roomNow).
// A coin smaller than `least` (the asset's smallest quote) counts for nothing.
export function whyUnoffered (coins, asset, roomValue, rates, least = null) {
  const min = big(perAsset(least, asset, '1'))
  const mine = (coins || []).filter((c) => c && c.asset === asset && !isOrderCoin(c) && big(c.value) >= min)
  const live = mine.filter((c) => c.state === 'live' && c.spent_elsewhere_until == null)
  const r = rates && rates.get(asset)
  if (live.length) {
    if (roomValue == null) return null
    if (r == null || big(r) <= 0n) return 'its node does not price it'
    if (live.some((c) => costOf(c, r) <= big(roomValue))) return null
    return 'no coin of it fits the room left in its budget, until a round takes in what it holds out of round'
  }
  if (!mine.length) return 'it holds none'
  if (mine.some((c) => c.state === 'given')) return 'every coin of it is in a round, until the round is final'
  if (mine.some((c) => c.state === 'offered' || c.state === 'sending')) return 'every coin of it is held by an open offer or a lock'
  if (mine.some((c) => c.state === 'at_depth_limit')) return 'every coin of it that would pay is at the operator\'s depth limit of reassignments, until a round refreshes it'
  return 'no coin of it is live (' + [...new Set(mine.map((c) => c.state))].join(', ') + ')'
}

// The smallest quote of each asset the maker gives, in-tree and at its BTC desk (its pairs'
// `min_give`): asset -> atoms.
export function leastGives (cfg) {
  const out = {}
  for (const p of [...((cfg && cfg.pairs) || []), ...((cfg && cfg.btc && cfg.btc.pairs) || [])]) {
    if (!p || p.give === 'BTC') continue
    const m = big(p.min_give || 1)
    if (out[p.give] == null || m < big(out[p.give])) out[p.give] = String(m)
  }
  return out
}

// The room left in the maker's instant budget, in atoms of each asset its node prices, from the
// library's `bond` answer: null when no budget is set or the bond does not stand (then the
// library's own refusals are the only bound).
export function budgetRoom (bond) {
  const b = bond && bond.instant_budget
  if (!b || !b.room_atoms || typeof b.room_atoms !== 'object') return null
  const m = new Map()
  for (const [a, v] of Object.entries(b.room_atoms)) m.set(a, big(v))
  return m
}

// Quotes cut to the room left: a quote whose most wanted (max_give at its rate, rounded up) is
// more than the room in the asset it wants is cut to what the room buys and marked
// `after_next_round`; one cut below its least is left out, and its pair is named in `later`
// instead, so a taker can say the rest comes after the maker's next round.
export function capQuotes (quotes, room) {
  if (!room) return { quotes, later: [] }
  const out = [], later = []
  for (const q of quotes || []) {
    const r = room.get(q.want_asset)
    const num = big(q.rate_num), den = big(q.rate_den)
    if (r == null || num <= 0n || den <= 0n) { out.push(q); continue }
    const max = big(q.max_give)
    if (ceilDiv(max * num, den) <= r) { out.push(q); continue }
    const fit = (r * den) / num
    if (fit < big(q.min_give || 1)) {
      if (!later.some((x) => x.give_asset === q.give_asset && x.want_asset === q.want_asset)) later.push({ give_asset: q.give_asset, want_asset: q.want_asset })
      continue
    }
    out.push({ ...q, max_give: String(fit), after_next_round: true })
  }
  return { quotes: out, later }
}

// The received coins (`kind` transfer, live) to refresh now: each one rested `restMs` since `seen`
// first noted it at `now`; every one when `all` (an offer was refused for what the maker holds out
// of round); and on the `first` pass after a start, every one already held, whose rest is unknown
// and was most likely spent already: a restart never makes them wait out a whole rest again.
export function receivedDue (coins, seen, now, restMs, { all = false, first = false } = {}) {
  const due = []
  for (const c of coins || []) {
    if (!c || c.state !== 'live' || c.kind !== 'transfer') continue
    if (!seen.has(c.leaf_id)) seen.set(c.leaf_id, first ? now - restMs - 1 : now)
    if (all || now - seen.get(c.leaf_id) > restMs) due.push(c.leaf_id)
  }
  return due
}

// Of the due coins, those of received lineage only (`lineageOf`: leaf -> the library's coin_places
// lineage, own, trade or received): a coin the maker made itself (the change of its own payment, a
// piece it cut out of round) is of its own lineage, at risk to nobody while it is live, and is never
// given to a refresh merely for being of kind transfer. Given to one, a library counts it at risk at
// its whole value while the participation is pending (web #659: three such coins of 5.33 million
// tSEQ the operator's headroom could not take, every pair of the BTC desk empty). A coin whose
// lineage the library does not name (an older library) counts as received, as before.
export function receivedOnly (due, lineageOf) {
  return (due || []).filter((id) => ((lineageOf && lineageOf.get(id)) ?? 'received') === 'received')
}

// The coins of its own lineage (or a trade's with its owner's exit) of kind transfer or fill that the
// maker refreshes all the same, each when the operator can take it whole now (within HEADROOM_SHARE
// of its headroom in the asset, or the asset uncapped), so that it never waits given at the cap,
// where the library counts it at its whole value (arca #889):
//   - one larger than a working coin of its asset (`sizes`, a reserve by coinShape): the library pays a swap from a coin
//     out of round first, and a swap's change on an operator without checkpoint exits is received
//     (at risk whole) until refreshed, so a large coin of its own turns into a large coin at risk at
//     the next trade (web #778, case a: 848,792 at risk after a trade of 20,000);
//   - one `hops` reassignments deep or more, at most two short of the operator's `depth_limit`
//     (`hopsOf`: leaf -> hops, coin_places): past the limit the operator co-signs no payment of it,
//     and a swap's change is a reassignment deeper each time, which only a refresh starts again.
// Not one given up within GIVE_UP_AGAIN_MS (`gaveUp`), nor a resting order's. -> leaf ids.
export function ownToRefresh (coins, { lineageOf = null, hopsOf = null, sizes = null, depthLimit = null, headroom = null, gaveUp = null, now = Date.now() } = {}) {
  const out = []
  for (const c of coins || []) {
    if (!c || c.state !== 'live' || (c.kind !== 'transfer' && c.kind !== 'fill') || isOrderCoin(c)) continue
    const l = lineageOf && lineageOf.get(c.leaf_id)
    if (l !== 'own' && l !== 'trade') continue
    if (gaveUp && now - (gaveUp.get(c.leaf_id) ?? -Infinity) < GIVE_UP_AGAIN_MS) continue
    const size = sizes && sizes.get(c.asset)
    const hops = hopsOf && hopsOf.get(c.leaf_id)
    // Larger than a working coin by the rule the cut and the merge read (coinShape): a coin a few
    // atoms over this minute's size is a working coin, not refreshed for it (web wallet #783).
    const large = size != null && coinShape(c.value, size) === 'reserve'
    const deep = depthLimit != null && Number.isFinite(hops) && hops >= depthLimit - 2
    if (!large && !deep) continue
    const r = headroom && headroom.get(c.asset)
    if (r != null && big(c.value) > (r * HEADROOM_SHARE.num) / HEADROOM_SHARE.den) continue
    out.push(c.leaf_id)
  }
  return out
}

// The operator's limit of reassignments since a round (its info's `depth_limit`), or null.
export const depthLimitOf = (info) => { const si = (info && info.server_info) || info; return si && Number.isFinite(si.depth_limit) ? si.depth_limit : null }
// The coins as a quote or a firm offer may pay from them: a live coin of kind transfer or fill whose
// reassignments since a round (`hopsOf`: leaf -> hops, coin_places) have reached the operator's
// `depthLimit` pays nothing out of round ("more are at the operator's depth limit"), so it is shown
// as `at_depth_limit` and quotes nothing, and keepFree does not keep it to keep its asset offered:
// a book that quotes it refuses every firm offer it sized on it (case d of web #778). -> coins.
export function payableView (coins, hopsOf, depthLimit) {
  if (depthLimit == null || !hopsOf) return coins
  return (coins || []).map((c) => (c && c.state === 'live' && (c.kind === 'transfer' || c.kind === 'fill') && (hopsOf.get(c.leaf_id) ?? -1) >= depthLimit ? { ...c, state: 'at_depth_limit' } : c))
}
// The received coins (kind transfer, live) within two reassignments of the operator's depth limit,
// due now whatever their rest: a round is the only way such a coin pays again, and a swap paying
// from it makes change one reassignment deeper (ownToRefresh does the same for its own coins).
export function deepDue (coins, hopsOf, depthLimit) {
  if (depthLimit == null || !hopsOf) return []
  return (coins || []).filter((c) => c && c.state === 'live' && c.kind === 'transfer' && (hopsOf.get(c.leaf_id) ?? -1) >= depthLimit - 2).map((c) => c.leaf_id)
}

// The arguments of a library command. One ahead of the queue (`first`) answers a taker (a firm
// offer, an acceptance, a swap's state): its start re-checks only the coins, each against the chain
// and its lineage watched (`recheck: 'coins'`), and leaves the following of the participations'
// rounds, which gives coins back and guards no spend, to the upkeep's sync on its timer. That part
// reads every released round again: five seconds and more on a busy machine, ahead of every answer.
export function commandArgs (args, first) {
  return first ? { ...(args || {}), recheck: 'coins' } : (args || {})
}

// Every library command's time, summed up once a period (`times_seconds`, ten minutes) in one
// line: `times {"<command>": {n, p50, p95, max, waited_max}, ...}` in milliseconds, where `waited`
// is its time in the queue before it ran. What says how fast the maker answers below the time
// a `slow` line needs. -> { add(name, ms, waited), line() }: line() answers the period's
// summary and starts the next, or null when no command ran.
export const TIMES_SECONDS = 600
// A command slower than this (`slow_ms`) is logged with what it cost (`slow <command> <ms> ms {…}`).
export const SLOW_MS = 2000
export function commandTimes () {
  let by = new Map()
  const at = (v, q) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * q) - 1))]
  return {
    add (name, ms, waited = 0) {
      const e = by.get(name) || { ms: [], waited: 0 }
      e.ms.push(ms); e.waited = Math.max(e.waited, waited); by.set(name, e)
    },
    line () {
      if (!by.size) return null
      const out = {}
      for (const [name, e] of [...by].sort(([x], [y]) => (x < y ? -1 : 1))) {
        const v = e.ms.slice().sort((x, y) => x - y)
        out[name] = { n: v.length, p50: at(v, 0.5), p95: at(v, 0.95), max: v[v.length - 1], waited_max: e.waited }
      }
      by = new Map()
      return 'times ' + JSON.stringify(out)
    },
  }
}

// The forfeits of every round the operator holds for them, handed over ahead of the queue on a
// timer of their own (`forfeit_seconds`): the operator broadcasts a round built without a sweep
// only once every participation in it has handed its forfeits over, and drops it, voiding the
// maker's refresh and holding back everyone else in it, when they have not come within its window
// (`info.fills.forfeit_window_seconds`, ten minutes). The upkeep's pass (a sync, the resting desk,
// the boards) can run longer than that. One pass at a time; a library without the command
// (`no command`) is passed over in silence. -> a function to run on the timer.
export const FORFEIT_SECONDS = 30
export function forfeitPass (cmd, log) {
  let running = false
  return async () => {
    if (running) return null
    running = true
    try {
      const r = await cmd('hand_over_forfeits', {}, true)
      for (const h of (r && r.held) || []) if (h && (h.refused || h.error)) log('forfeits:', h.participation, h.refused || h.error)
      return r
    } catch (e) {
      if (!/no command/.test(String(e && e.message))) log('forfeits:', e && e.message)
      return null
    } finally { running = false }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const log = (...a) => console.log(new Date().toISOString(), ...a)

// The library's arguments for the state of the swaps `ids`: read by their ids (`swaps`), not every offer
// the maker ever made, each of whose rows holds its coins' records. A library without the argument
// answers every swap, which swapStates reads the same way.
export const swapsArgs = (ids) => ({ swaps: [...ids] })
// The state of each of `ids` in the library's `swaps` answer: Map id -> state (null when unknown).
export function swapStates (answer, ids) {
  const by = new Map((answer || []).map((s) => [s && s.swap, (s && s.state) || null]))
  return new Map([...ids].map((id) => [id, by.get(id) ?? null]))
}

export const REFUSED_WALLETS = /(treasury|reserve|faucet|bridge|sbtc|pool|fee|service|founder|drip)/i

// A pair's rate from the price server's feed (`/prices`: { TICKER: price or {price} }, each in
// the same reference unit per whole unit of the asset), with the maker's spread: the maker wants
// `rate_num` atoms of what it wants for every `rate_den` atoms it gives. Null when either price is
// missing, so nothing is quoted on a price the maker does not have. A price whose `as_of` (unix
// seconds of the feed's reading) is more than PRICE_MAX_AGE_S old counts as missing: its source has
// stopped answering, and the feed only kept its last reading. A seeded price (`static`) has no age.
export const PRICE_MAX_AGE_S = 600
export function priceOf (prices, t, now = Date.now()) {
  // The feed's own key first (it names bitcoin `tBTC` on the testnet), then the ticker in capitals.
  const v = prices && (prices[String(t.ticker)] ?? prices[String(t.ticker).toUpperCase()])
  if (v && typeof v === 'object' && !v.static && Number(v.as_of) > 0 && now / 1000 - Number(v.as_of) > PRICE_MAX_AGE_S) return null
  const n = Number(v && typeof v === 'object' ? v.price : v)
  return n > 0 ? n : null
}
export function rateFromPrices (prices, give, want, spreadBps, now = Date.now()) {
  const p = (t) => priceOf(prices, t, now)
  const pg = p(give), pw = p(want)
  if (!pg || !pw) return null
  const DEN = 100000000n
  // atoms of `want` per atom of `give`, the spread on the maker's side.
  const ratio = (pg / pw) * 10 ** ((want.precision ?? 8) - (give.precision ?? 8)) * (1 + Number(spreadBps || 0) / 10000)
  const num = BigInt(Math.ceil(ratio * Number(DEN)))
  if (num <= 0n) return null
  return { rate_num: String(num), rate_den: String(DEN) }
}

// Whether a pair's freshly read rate replaces the one quoted now: a rate more than twice, or less
// than half, of the current one is a reading the maker does not trust at once (a feed that
// glitched would have it give its coins away), and is taken only once `JUMP_READS` readings in a
// row say so; meanwhile the current rate stays. `jumps` counts those readings per pair.
// -> the rate to quote.
export const JUMP_READS = 3
export function steadyRate (key, prev, next, jumps) {
  if (!prev || !next) { jumps.delete(key); return next }
  const ratio = (Number(next.rate_num) / Number(next.rate_den)) / (Number(prev.rate_num) / Number(prev.rate_den))
  if (ratio <= 2 && ratio >= 0.5) { jumps.delete(key); return next }
  const n = (jumps.get(key) || 0) + 1
  if (n < JUMP_READS) { jumps.set(key, n); return prev }
  jumps.delete(key)
  return next
}

export function checkConfig (c) {
  if (!c || typeof c !== 'object') throw new Error('the configuration is not an object')
  if (!c.wallet || REFUSED_WALLETS.test(String(c.wallet))) throw new Error(`refused: the maker runs only a wallet of its own, never a service or treasury wallet (${JSON.stringify(c.wallet)})`)
  for (const k of ['mnemonic_file', 'store_dir', 'listen']) if (!c[k]) throw new Error(`the configuration names no ${k}`)
  if (REFUSED_WALLETS.test(String(c.mnemonic_file)) || REFUSED_WALLETS.test(String(c.store_dir))) throw new Error('refused: the phrase or store is a service or treasury wallet\'s')
  if (!c.operator || !c.operator.server || !c.operator.node_url) throw new Error('the configuration names no operator')
  for (const p of c.pairs || []) {
    if (!/^[0-9a-f]{64}$/.test(p.give) || !/^[0-9a-f]{64}$/.test(p.want) || p.give === p.want) throw new Error('a pair names two asset ids')
    if (!p.price && !(big(p.rate_num) > 0n && big(p.rate_den) > 0n)) throw new Error('a pair\'s rate is two positive integers, or "price": true with the configuration\'s price feed')
    if (p.price && !(c.prices && c.prices.url && c.prices.assets && c.prices.assets[p.give] && c.prices.assets[p.want])) throw new Error('a pair priced from the feed needs prices.url and both assets in prices.assets')
  }
  return c
}

// The quotes, from what the library can pay now and what open offers hold: a pair's depth at the
// levels of its ladder (leaf-maker-ladder.mjs), one quote a level, cumulative.
export function quotesFrom (pairs, spendable, held, margin, rates = new Map(), cfg = null) {
  const out = []
  for (const p0 of pairs || []) {
    const sl = slicesFor(p0, spendable, held, margin, rates, cfg)
    if (sl) out.push(...ladderQuotes(p0.give, p0.want, sl.slices, sl.min))
  }
  return out
}

// A pair's ladder now: its rate (fixed, or from the feed), what the maker can give of it, and the
// slices of that. Null when the pair is not quoted (no live price, or not enough to give).
export function slicesFor (p0, spendable, held, margin, rates = new Map(), cfg = null) {
  const r = p0.price ? rates.get(p0.give + ':' + p0.want) : null
  if (p0.price && !r) return null
  const p = r ? { ...p0, ...r } : p0
  const have = (spendable.get(p.give) || 0n) - (held.get(p.give) || 0n) - big(perAsset(margin, p.give, 0))
  const min = big(p.min_give || 1)
  const slices = slicesOf(p, have, min, ladderOf(p0, cfg))
  return slices.length ? { slices, min, pair: p } : null
}

// A completion the operator refused (`swap_complete`): the library's `swap_refused`, or, from a
// library that leaves such an offer open, the server's own refusal. Nothing was co-signed. Any
// other answer (the operator not reached, the request standing to be posted again) is not one.
export function completionRefused (e) {
  return !!e && (e.kind === 'swap_refused' || e.kind === 'server_refused')
}

// What the offer made in place of a gone one asks, from the live price `live` (what a firm offer
// of the same give asks now): the live price when it asks no more than the gone offer did
// (`before`), else none, so the taker asks for a new price.
export function againWant (before, live) {
  return live != null && big(live) <= big(before) ? big(live) : null
}

// The answer to an acceptance of a swap that is not open here and was never refused: its state
// only, never `gone`, which says nothing was co-signed. A swap the maker cancelled at its lapse
// may still have been co-signed (an answer that never came back, taken by a later sync).
export function notOpenAnswer (st) {
  return { error: `the swap is ${st || 'unknown'} here`, state: st || null }
}

// How long the answer to an acceptance whose completion was refused is kept for the same
// acceptance handed over again.
export const GONE_KEEP_MS = 15 * 60 * 1000

// The answer to an acceptance whose completion the operator refused: the offer is gone (`gone`),
// whose coin the operator named (`whose`: 'taker' when the wallet's own coin was spent elsewhere,
// which it learns by cancelling its acceptance), and the offer made in its place at the same
// price (`offer`, the shape of a firm offer's answer), or none.
export function goneAnswer (swap, e, again) {
  return { error: String((e && e.message) || 'the operator refused the completion'), swap: String(swap), gone: true,
    code: (e && e.code) || null, whose: (e && e.whose) || null, coin: (e && e.coin) || null, ...(again ? { offer: again } : {}) }
}

async function main () {
  const cfgPath = arg('--config')
  if (!cfgPath) { console.error('usage: leaf-maker.mjs --config maker.json [--init]'); process.exit(2) }
  const cfg = checkConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  if (process.argv.includes('--init')) {
    if (existsSync(cfg.mnemonic_file)) { console.log(`the maker's phrase is already at ${cfg.mnemonic_file}`); return }
    const pkg = process.env.LWK_PKG || join(here, '..', '..', 'pkg')
    const lwk = await import(join(pkg, 'lwk_wasm.js'))
    lwk.initSync({ module: readFileSync(join(pkg, 'lwk_wasm_bg.wasm')) })
    writeFileSync(cfg.mnemonic_file, lwk.Mnemonic.fromRandom(12).toString() + '\n', { mode: 0o600 })
    chmodSync(cfg.mnemonic_file, 0o600)
    console.log(`wrote the maker's phrase to ${cfg.mnemonic_file}`)
    return
  }
  // --reporter-key: the key the maker signs its trade reports and listings with, for the relay's
  // -trade-reporters; exits.
  if (process.argv.includes('--reporter-key')) { console.log(makerRelayKey(cfg.store_dir).pub); return }
  const mnemonic = readFileSync(cfg.mnemonic_file, 'utf8').trim()
  const op = cfg.operator
  const nodePassword = op.node_password_file ? readFileSync(op.node_password_file, 'utf8').trim() : (op.node_password || '')
  // The library on a thread of its own: the maker answers HTTP while a long command runs, and a
  // taker's acceptance or a firm offer goes ahead of the maker's own upkeep.
  // A command slower than `slow_ms` (two seconds) is logged by name: the upkeep's long ones are what a
  // firm offer waits behind.
  const times = commandTimes()
  const lib = await leafLibraryThread(cfg.store_dir, {
    slowMs: Number(cfg.slow_ms ?? SLOW_MS),
    onSlow: (name, ms, detail) => log('slow', name, ms, 'ms', detail ? JSON.stringify(detail) : ''),
    onTime: (name, ms, waited) => times.add(name, ms, waited),
  })
  setInterval(() => { const l = times.line(); if (l) log(l) }, (cfg.times_seconds ?? TIMES_SECONDS) * 1000).unref()
  const w = (await lib.exists(mnemonic)) ? await lib.open(mnemonic, nodePassword) : await lib.create(mnemonic, {
    server: op.server, node_url: op.node_url, node_user: op.node_user, node_password: nodePassword,
    ...(cfg.exit_delay_units ? { exit_delay_units: cfg.exit_delay_units } : {}),
    ...(cfg.min_exit_delay_units ? { min_exit_delay_units: cfg.min_exit_delay_units } : {}),
  })
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const cmd = (name, args, first = false) => w.command(name, commandArgs(args, first), { first })
  const info = await cmd('info')
  // --address: the maker's on-chain address (to fund what it boards), then exits.
  if (process.argv.includes('--address')) { console.log(JSON.stringify({ address: (await cmd('address')).address })); process.exit(0) }
  // --held ASSET: what the maker holds of an asset in leaves (every state), after a sync; exits.
  const hi = process.argv.indexOf('--held')
  if (hi > 0) {
    try { await cmd('sync', SYNC_ARGS) } catch (e) { log('sync:', e.message) }
    const st = ((await cmd('balance')).arca || {})[process.argv[hi + 1]] || {}
    console.log(String(Object.values(st).reduce((n, v) => n + big(v), 0n)))
    process.exit(0)
  }
  // --receive ASSET ATOMS: a receive request for at most ATOMS of ASSET into the maker's leaves,
  // cut to the room its instant budget leaves, so a payment to it is not refused for holding too
  // much out of round; prints { request, atoms } (request null and atoms "0" when there is no room
  // until its next round, error when the library refuses) and exits. How the box moves a maker's
  // coins to another maker in the tree: this on the receiver, then --pay on the payer.
  const ri = process.argv.indexOf('--receive')
  if (ri > 0) {
    const [asset, want] = process.argv.slice(ri + 1, ri + 3)
    if (!/^[0-9a-f]{64}$/.test(asset || '') || !(big(want) > 0n)) { console.error('usage: --receive <asset hex> <atoms>'); process.exit(2) }
    try { await cmd('sync', SYNC_ARGS) } catch (e) { log('sync:', e.message) }
    let atoms = big(want)
    try { const room = budgetRoom(await cmd('bond', {})); if (room && room.has(asset) && room.get(asset) < atoms) atoms = room.get(asset) } catch (e) { log('bond:', e.message) }
    if (atoms <= 0n) { console.log(JSON.stringify({ request: null, atoms: '0' })); process.exit(0) }
    try {
      const r = await cmd('receive', { asset, amount: String(atoms) })
      console.log(JSON.stringify({ request: r.request, atoms: String(atoms) }))
      process.exit(0)
    } catch (e) { console.log(JSON.stringify({ request: null, atoms: '0', error: e.message })); process.exit(3) }
  }
  // --pay FILE: pays each receive request in FILE (one a line) from the maker's leaves, out of
  // round, in the tree, then exits: how a drill's wallets are funded from the maker.
  const pi = process.argv.indexOf('--pay')
  if (pi > 0) {
    await cmd('sync', SYNC_ARGS)
    const out = []
    for (const req of readFileSync(process.argv[pi + 1], 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) {
      try { const r = await cmd('send', { request: req }); out.push({ ok: true, sent: r.sent || r.value || null }) } catch (e) { out.push({ ok: false, error: e.message }) }
    }
    console.log(JSON.stringify(out))
    process.exit(out.every((x) => x.ok) ? 0 : 3)
  }
  // --ask-faucet URL ASSET TICKER: a receive request in that asset, paid by the testnet faucet as
  // a leaf; prints what the faucet paid, and exits. The faucet pays its own tier, so a caller that
  // needs more asks again or names the shortfall.
  const ai = process.argv.indexOf('--ask-faucet')
  if (ai > 0) {
    const [url, asset, ticker] = process.argv.slice(ai + 1, ai + 4)
    const req = await cmd('receive', { asset })
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: req.request, asset: ticker }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { console.log(JSON.stringify({ ok: false, status: r.status, error: j.error || null })); process.exit(3) }
    await pause(3000)
    const mb = (await cmd('sync', SYNC_ARGS)).mailbox || {}
    const got = (mb.accepted || []).filter((x) => x.asset === asset).reduce((n, x) => n + big(x.value), 0n)
    console.log(JSON.stringify({ ok: true, paid: j.leaf && j.leaf.atoms ? String(j.leaf.atoms) : null, received: String(got) }))
    process.exit(0)
  }
  const address = await cmd('address')
  log(`leaf maker ${cfg.wallet}: operator ${info.operator}, chain ${info.genesis_hash}, on-chain address ${address.address}`)
  // Its instant budget, in the library: what it takes out of round at once, a share of the bond.
  let ownPpm = null
  try { const b = await cmd('instant_budget', { share: String(cfg.instant_budget ?? DEFAULT_INSTANT_BUDGET) }); ownPpm = b.instant_budget_ppm ?? null; log('instant budget:', JSON.stringify(b)) } catch (e) { log('instant budget:', e.message) }
  const basePpm = ownPpm
  // The node's fee exchange rates, as the library reads them (getfeeexchangerates, labels through
  // dumpassetlabels): what the maker weighs coins the cap holds back with.
  const nodeCall = async (method) => {
    const r = await fetch(op.node_url, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${op.node_user || ''}:${nodePassword}`).toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'leaf-maker', method, params: [] }) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) throw new Error(`${method}: ${(j && j.error && j.error.message) || 'HTTP ' + r.status}`)
    return j.result
  }
  const nodeRates = async () => {
    const [rates, labels] = await Promise.all([nodeCall('getfeeexchangerates'), nodeCall('dumpassetlabels')])
    const m = new Map()
    for (const [k, v] of Object.entries(rates || {})) m.set((labels && labels[k]) || k, v)
    return m
  }
  // The room left in it, read with the bond on every pass of the upkeep (null: no bound to cut by).
  // Coins the operator's cap holds back out of round (heldAtCap) widen the maker's own share by
  // what they are worth (budgetPpm), and the share goes back once they are refreshed.
  const heldBackFile = join(cfg.store_dir, 'held-back.json')
  // The assets it gives: in-tree, and at its BTC desk.
  const givesOf = () => new Set([...(cfg.pairs || []), ...((cfg.btc && cfg.btc.pairs) || [])].map((x) => x.give).filter((a) => a !== 'BTC'))
  let room = null, lastInfo = null, heldBackLog = '', stuckPrev = heldBackFrom(existsSync(heldBackFile) ? readFileSync(heldBackFile, 'utf8') : null)
  // The budget as the last pass read it (D94): the bond answer, the node's rates, each asset's
  // working-coin size, and the room left in reference atoms.
  let bondNow = null, ratesNow = new Map(), sizes = new Map(), budgetValue = null, sizesLog = ''
  const readRoom = async (first = false) => {
    let bond = null
    try { bond = await cmd('bond', {}, first); room = budgetRoom(bond) } catch (e) { log('bond:', e.message); return }
    bondNow = bond
    budgetValue = bond && bond.instant_budget && bond.instant_budget.value != null ? big(bond.instant_budget.value) : null
    try { ratesNow = await nodeRates() } catch (e) { log('rates:', e.message) }
    sizes = workingSizes(bond, ratesNow, givesOf().size)
    const sl = [...sizes].filter(([a]) => givesOf().has(a)).map(([a, v]) => tickerOf(a) + ' ' + v).sort().join(', ')
    if (sl !== sizesLog) { log('working coins of at most:', sl || 'none (no budget)'); sizesLog = sl }
    const b = bond && bond.instant_budget
    if (basePpm == null || !b || !lastInfo || first) return
    try {
      const stuck = heldBack(stuckPrev, heldAtCap(bond.out_of_round, lastInfo), bond.out_of_round)
      if (heldBackText(stuck) !== heldBackText(stuckPrev)) { try { writeFileSync(heldBackFile, heldBackText(stuck)) } catch (e) { log('held back:', e.message) } }
      stuckPrev = stuck
      const now = [...stuck].map(([a, v]) => tickerOf(a) + ' ' + v).sort().join(', ')
      const want = stuck.size ? budgetPpm(basePpm, stuck, await nodeRates(), b.bond_value) : basePpm
      if (now !== heldBackLog) { log(now ? 'held out of round while the operator refreshes no more of it, or until its refresh runs: ' + now + '; its own budget share goes to ' + want + ' millionths, so its other pairs keep their room' : 'nothing held back at the cap: its own budget share is ' + basePpm + ' millionths again'); heldBackLog = now }
      if (want !== ownPpm) {
        const r = await cmd('instant_budget', { share: shareText(want) })
        ownPpm = r.instant_budget_ppm ?? want
        room = budgetRoom(await cmd('bond', {}))
      }
    } catch (e) { log('budget:', e.message) }
  }

  // Rates from the price feed, read every minute; a rate older than ten minutes is not quoted.
  const rates = new Map()
  const jumps = new Map()
  let ratesAt = 0
  const liveRates = () => (Date.now() - ratesAt < 10 * 60 * 1000 ? rates : new Map())
  async function readPrices () {
    if (!cfg.prices || !cfg.prices.url) return
    try {
      const r = await fetch(cfg.prices.url, { signal: AbortSignal.timeout(20000) })
      const j = await r.json()
      const old = Object.values(cfg.prices.assets || {}).filter((t) => t && t.ticker && priceOf(j, t) === null && priceOf(j, t, 0) !== null).map((t) => t.ticker)
      if (old.length) log('prices: older than', PRICE_MAX_AGE_S, 's, not quoted:', [...new Set(old)].join(', '))
      for (const p of [...(cfg.pairs || []), ...((cfg.btc && cfg.btc.pairs) || [])]) {
        if (!p.price) continue
        const key = p.give + ':' + p.want
        const read = rateFromPrices(j, cfg.prices.assets[p.give], cfg.prices.assets[p.want], cfg.prices.spread_bps)
        const rate = steadyRate(key, rates.get(key), read, jumps)
        if (read && rate !== read) log('prices: a reading of', key, 'far from the rate quoted now is held back', JSON.stringify(read))
        if (rate) rates.set(key, rate); else rates.delete(key)
      }
      ratesAt = Date.now()
    } catch (e) { log('prices:', e.message) }
  }
  await readPrices()
  setInterval(readPrices, 60000)
  // Every trade it settles is reported to the relay's trade log, when it names a relay.
  const reporter = tradeReporter({ cfg, log })
  if (reporter) log('trades are reported to', reporter.relay, 'signed by', reporter.pub)
  const reportTrade = (t) => { if (reporter) { try { reporter.report(t) } catch (e) { log('report:', e.message) } } }
  // BTC for an asset and back, from the maker's own Bitcoin Lightning node, when it has one.
  // The operator's answer on a payment into its tree, read straight from it: the desk's steps
  // between the upkeep's passes do not wait behind the library's queue.
  const lookup = async (hash) => {
    const r = await fetch(String(op.server).replace(/\/+$/, '') + '/v1/lightning_receive_status', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment_hash: hash }), signal: AbortSignal.timeout(5000) })
    return r.ok ? r.json() : null
  }
  // The assets the operator takes no more refreshes of (cappedAssets), read from its info every
  // minute straight from it: no library command, so the read never waits behind the upkeep.
  let capped = new Set()
  const tickerOf = (a) => (cfg.prices && cfg.prices.assets && cfg.prices.assets[a] && cfg.prices.assets[a].ticker) || a
  const readCaps = async () => {
    try {
      const r = await fetch(String(op.server).replace(/\/+$/, '') + '/v1/info', { signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error('the operator answered HTTP ' + r.status)
      lastInfo = await r.json()
      const next = intakeStopped(lastInfo, bondNow && bondNow.out_of_round)
      const was = [...capped].sort().join(), now = [...next].sort().join()
      if (was !== now) log(next.size ? 'takes in none of ' + [...next].map(tickerOf).join(', ') + ': the operator refreshes no more of it now, or no more than it holds out of round already' : 'takes in every asset again')
      capped = next
    } catch (e) { log('caps:', e.message) }
  }
  await readCaps()
  setInterval(readCaps, 60000)
  // A lock the desk paid: the coins it spent leave the book at once, and what is out of round of it
  // (the payment held for the wallet, and the change) counts against the room until it is read.
  const onPaid = (sw, paid) => {
    noteChange('done', leavesOf(paid), [{ asset: sw.give_asset, value: String(sw.give) }, ...(paid && paid.change ? [{ asset: sw.give_asset, value: String(paid.change) }] : [])], 'btc:' + sw.swap)
    readHoldings(true).catch(() => {})
  }
  const desk = await btcDesk({ cfg, cmd, log, liveRates, lookup, onPaid, onTrade: (s) => reportTrade({ rail: 'btc-gateway', id: s.swap, give_asset: s.give_asset, give: s.give, want_asset: s.want_asset, want: s.want }) })
  if (desk) setInterval(() => { desk.stepNow().catch((e) => log('btc:', e.message)) }, Number(cfg.btc.step_seconds ?? 2) * 1000)
  if (desk) log('the BTC desk is open')

  const firm = new Map()   // swap -> { give_asset, give, expires }
  const gone = new Map()   // swap whose completion the operator refused -> { body, at }
  const gaveUp = new Map()    // leaf -> when the maker gave it up in a round (a cut or a settle)
  let noPieces = false        // the library answered a refresh in pieces with one leaf: no cuts
  const seen = new Map()   // leaf_id -> first seen (ms), for settling received coins
  // An offer refused because the maker holds too much out of round (the operator's bond caps it):
  // every coin it received is refreshed at the next pass, not after its rest, and that pass runs now.
  let outOfRoundFull = false
  let firstPass = true
  let busy = false
  let lastBoardRefusal = null
  let keptLog = ''   // the coins kept out of a settle, as last logged
  let waitLog = ''   // the received coins waiting for the operator's headroom, as last logged
  let ownLog = ''    // the coins of its own lineage left out of a settle, as last logged
  let ownRefLog = '' // the coins of its own lineage it refreshes all the same, as last logged
  const cutWaits = new Map()    // asset -> why its cut waits (shapeFor's `waits`), for /v1/explain
  const lineageOf = new Map()   // leaf -> its lineage (coin_places), or null when the library names none
  const hopsOf = new Map()      // leaf -> its reassignments since a round (coin_places)
  const unoffered = new Map()   // asset -> why it is offered no more, as last logged
  // What the maker can pay now. `first` asks the library ahead of its queue (a firm offer); the
  // quotes are served from the last reading (`holdings`), which every pass of the upkeep and every
  // offer and completion renew, so a quote never waits on the library: with a hundred coins and
  // resting orders a pass can hold the library for minutes, and a quote that waited on it was
  // no quote at all.
  // Each reading keeps the coins it was made from (`holdings.coins`): the upkeep's pass reads them
  // once and counts, settles and merges from that reading.
  // What it did itself since a reading (knownCoins): its offers, trades and gives, each noted at
  // once, so the book between two readings is what it knows it holds, never empty for the reading.
  let changes = []
  const noteChange = (kind, leaves, made = [], id = null) => { if (leaves && leaves.length) changes.push({ at: Date.now(), kind, leaves: [...leaves], made, id }) }
  const forgetChange = (id) => { changes = changes.filter((c) => c.id !== id) }
  const readHoldings = async (first = false) => {
    const from = Date.now()
    const coins = (await cmd('coins', HELD_COINS, first)) || []
    const plans = await cmd('plans', {}, first).catch(() => ({ plans: [] }))
    const sp = spendableFrom(coins, plans)
    // Only a reading begun later than the one in hand replaces it (two may run at once).
    if (!holdings || from >= holdings.from) {
      holdings = { sp, coins, plans, at: Date.now(), from }
      changes = changes.filter((c) => c.at >= from)
    }
    return holdings
  }
  // A reading with what the maker did since: { sp, coins }.
  const known = (h) => {
    if (!h) return h
    const coins = knownCoins(h.coins, changes, h.from ?? h.at)
    return { ...h, coins, sp: spendableFrom(coins, h.plans) }
  }
  const spendable = async (first = false) => (await readHoldings(first)).sp
  let holdings = null
  let firstReading = null   // the reading a quote asked for before the first one, while it runs
  // Orders resting in the tree, a ladder a pair, listed on the relay (leaf-maker-rest.mjs).
  // It rests from the pass's reading (passHoldings), not one of its own.
  let passHoldings = null
  const rester = await restDesk({ cfg, cmd, log, liveRates, spendable: async () => new Map((passHoldings || await readHoldings()).sp) })
  if (rester) log('the resting desk is open, its listings signed by', rester.makerPub)

  async function swapState (id, first = false) { return swapStates(await cmd('swaps', swapsArgs([id]), first), [id]).get(id) }

  // The upkeep leaves the library free at least as long as its last pass held it, so a taker's
  // firm offer or acceptance is as likely to find it idle as busy.
  let passEnd = 0, passTook = 0, lastHold = 0
  const HOLDINGS_FOR_FIRM_MS = 5 * 60 * 1000
  // What a firm offer is sized on: the upkeep's last reading while it is fresh, else a reading
  // asked ahead of the queue.
  // An offer or a completion since the last reading changed the coins: the book is the reading with
  // what the maker knows it did since (known), read again at once ahead of the queue, never a book
  // emptied until the reading answers (web #659, which on a busy library was tens of seconds).
  // The room a view leaves, and what that room takes in of each asset; the pass's bond answer
  // without a budget.
  const roomOf = (h) => roomNow(budgetValue, h.coins, ratesNow, lineageOf)
  const wantRoomOf = (h) => lowerRoom(budgetValue == null ? room : roomAtomsOf(roomOf(h), ratesNow), intakeLeft(h.coins, lastInfo, lineageOf))
  let firmReading = null
  const firmHoldings = async () => {
    const h = known(holdings && Date.now() - holdings.at < HOLDINGS_FOR_FIRM_MS ? holdings : await readHoldings(true))
    firmReading = h
    return budgetedSpendable(h.sp, payableView(h.coins, hopsOf, depthLimitOf(lastInfo)), roomOf(h), ratesNow)
  }
  // The terms of a firm offer of `give` of `give_asset` for `want_asset`, with every check a firm
  // offer passes: the pair quoted, its want asset taken now (not capped), the maker holding that
  // much, the price walked on the ladder at the live rate, and what it takes in within its room.
  // -> { pair, give, want }, or { refused: [status, body] }.
  async function firmTerms (b) {
    if (b.want_asset && capped.has(b.want_asset)) return { refused: [409, { error: cappedRefusal(tickerOf(b.want_asset)), capped: true }] }
    const pair0 = (cfg.pairs || []).find((x) => x.give === b.give_asset && x.want === b.want_asset)
    if (!pair0) return { refused: [404, { error: 'the maker quotes no such pair' }] }
    const give = big(b.give)
    // Sized on the holdings the upkeep read last (each library command can take tens of seconds
    // on a wallet of a hundred coins): the library refuses an offer it cannot pay, and the
    // reading is renewed after the offer.
    const sl = slicesFor(pair0, await firmHoldings(), new Map(), cfg.fee_margin || 0, liveRates(), cfg)
    const w = sl && give >= sl.min ? walkWant(sl.slices, give) : null
    if (!w) return { refused: [409, { error: 'the maker does not hold that much now', quote: sl ? ladderQuotes(pair0.give, pair0.want, sl.slices, sl.min).pop() : null }] }
    const pair = sl.pair
    // More than the room left in its instant budget, from the same reading: the rest after its
    // next round.
    const wantRoom = firmReading ? wantRoomOf(firmReading) : room
    if (wantRoom && wantRoom.has(pair.want) && w.want > wantRoom.get(pair.want)) {
      return { refused: [409, { error: 'the maker takes this much after its next round', after_next_round: true,
        quote: capQuotes(ladderQuotes(pair0.give, pair0.want, sl.slices, sl.min), wantRoom).quotes.pop() || null }] }
    }
    return { pair, give, want: w.want }
  }
  const HOLD_MS = 90_000, HOLD_EVERY_MS = 180_000
  async function tick () {
    if (busy || Date.now() - passEnd < passTook) return
    busy = true
    const t0 = Date.now()
    try { await tickOnce() } catch (e) { log('tick:', e.message) } finally { busy = false; passEnd = Date.now(); passTook = passEnd - t0 }
  }
  async function tickOnce () {
    {
      await upkeepSync(cmd, log)
      // The coins it holds, read once for the pass.
      passHoldings = null
      try { passHoldings = await readHoldings() } catch (e) { log('holdings:', e.message) }
      await readRoom()
      if (desk) { try { await desk.tick() } catch (e) { log('btc:', e.message) } }
      let changed = false
      if (rester) { try { changed = !!(await rester.tick()) } catch (e) { log('rest:', e.message) } }
      if (reporter && reporter.pending().length) { try { await reporter.flush() } catch (e) { log('report:', e.message) } }
      // What it holds on the chain of an asset it gives, above what it keeps, comes into the
      // tree: a board, its fee in the asset boarded when the node takes it for fees, else in
      // another asset the maker holds on the chain that the node takes (the wallet rule; never a
      // fallback to one privileged asset).
      // Its live coins of each asset, its resting orders left out: past `max_coins` it merges
      // (coinsToMerge), and at twice that it boards no more.
      const counted = new Map()
      for (const c of (passHoldings && passHoldings.coins) || []) if (c && c.state === 'live' && !isOrderCoin(c)) counted.set(c.asset, (counted.get(c.asset) || 0) + 1)
      const cap = (a) => Number(perAsset(cfg.max_coins, a, String(MAX_COINS)))
      try {
        const onchain = ((await cmd('balance')) || {}).sequentia_onchain || {}
        // The assets it gives: in-tree, and for BTC at its desk.
        const gives = [...(cfg.pairs || []), ...((cfg.btc && cfg.btc.pairs) || []).filter((x) => x.give !== 'BTC')]
        for (const a of new Set(gives.map((x) => x.give))) {
          let amount = big(onchain[a]) - big(perAsset(cfg.board_keep, a, '100000'))
          // In coins of `coin_size`, one a pass: a firm offer holds the coins it spends until it
          // is taken or released, so a maker of one coin serves one taker at a time.
          const coin = perAsset(cfg.coin_size, a, null)
          if (coin && amount > big(coin)) amount = big(coin)
          // Never a board above a working coin's size, which is derived from the budget.
          if (sizes.has(a) && amount > sizes.get(a)) amount = sizes.get(a)
          if (amount < big((gives.find((x) => x.give === a) || {}).min_give || 1)) continue
          if ((counted.get(a) || 0) >= 2 * cap(a)) continue
          const feeAssets = [a, ...Object.keys(onchain).filter((x) => x !== a && big(onchain[x]) > 0n).sort((x, y) => (big(onchain[y]) > big(onchain[x]) ? 1 : -1))]
          let done = false, why = null
          for (const fee of feeAssets) {
            try {
              const q = await cmd('board_quote', { asset: a, amount: String(amount), fee_asset: fee })
              await cmd('board', { asset: a, amount: String(amount), fee_asset: fee, shown: q.fee })
              log('boarded', String(amount), a.slice(0, 8), 'fee', JSON.stringify(q.fee))
              done = true; changed = true; break
            } catch (e) { why = e.message; if (!/not accepted for fees/.test(e.message)) break }
          }
          if (!done && why !== lastBoardRefusal) { lastBoardRefusal = why; log('board:', why) }
        }
      } catch (e) { log('board:', e.message) }
      const t = Date.now()
      if (firm.size) {
        const ids = [...firm.keys()]
        let states = null
        try { states = swapStates(await cmd('swaps', swapsArgs(ids)), ids) } catch (e) { log('swaps:', e.message) }
        for (const id of states ? ids : []) {
          const f = firm.get(id)
          if (!f) continue
          if (states.get(id) !== 'open') { firm.delete(id); continue }
          if (t > f.expires) { try { await cmd('swap_cancel', { swap: id }); forgetChange(id) } catch (e) { log('cancel', id, e.message) } firm.delete(id); changed = true }
        }
      }
      // Coins it received, once rested, are refreshed in the operator's next round; all of them at
      // once when an offer was refused for what the maker holds out of round. From the pass's
      // reading, unless the pass rested, boarded or cancelled since, or a taker's offer or
      // acceptance read the coins again since (each renews the holdings): the latest reading.
      if (changed) { try { await readHoldings() } catch (e) { log('holdings:', e.message) } }
      const coins = (holdings && holdings.coins) || []
      // The lineage of each coin of kind transfer or fill it holds, read once from the library
      // (coin_places) and kept, since a coin's lineage does not change: a live one of its own counts
      // nothing against the room (heldOut), and only received ones are settled (receivedOnly).
      const learnLineage = async (cs) => {
        if (!placesStale(cs, lineageOf)) return
        // A coin the library names no lineage for (an older library) counts as received; a read that
        // failed is asked again at the next pass.
        try { learnPlaces(await cmd('coin_places', {}), lineageOf, hopsOf, cs) } catch (e) { if (/no command/.test(String(e && e.message))) learnPlaces(null, lineageOf, hopsOf, cs); else log('coin_places:', e.message) }
      }
      await learnLineage(coins.filter((c) => c && (c.kind === 'transfer' || c.kind === 'fill') && HELD_OUT.includes(c.state) && c.state !== 'unread'))
      // One line whenever an asset it gives stops being offered, saying why, and when it is again.
      {
        const room = roomNow(budgetValue, coins, ratesNow, lineageOf), least = leastGives(cfg)
        for (const a of givesOf()) {
          const why = whyUnoffered(payableView(coins, hopsOf, depthLimitOf(lastInfo)), a, room, ratesNow, least)
          if (why !== (unoffered.get(a) ?? null)) { log(why ? 'offers no ' + tickerOf(a) + ' now: ' + why : 'offers ' + tickerOf(a) + ' again'); if (why) unoffered.set(a, why); else unoffered.delete(a) }
        }
      }
      // Past half its budget out of round, every received coin is settled now, not on its timer.
      const half = pastHalfBudget(bondNow)
      // A coin given up already and taken back (its refresh waited for the operator) waits
      // GIVE_UP_AGAIN_MS before it is given up again, so a full in-flight cap is not met with the
      // same participation every pass (#655).
      const due = receivedDue(coins, seen, t, (cfg.settle_seconds ?? 600) * 1000, { all: outOfRoundFull || half, first: firstPass })
        .filter((id) => t - (gaveUp.get(id) ?? -Infinity) >= GIVE_UP_AGAIN_MS)
      firstPass = false
      // Received coins near the operator's depth limit, due now whatever their rest (deepDue).
      for (const id of deepDue(coins, hopsOf, depthLimitOf(lastInfo))) if (!due.includes(id) && t - (gaveUp.get(id) ?? -Infinity) >= GIVE_UP_AGAIN_MS) due.push(id)
      // Settled only when received (receivedOnly).
      { const ids = new Set(due); await learnLineage(coins.filter((c) => c && ids.has(c.leaf_id))) }
      const ownDue = due.filter((id) => !receivedOnly([id], lineageOf).length)
      if (ownDue.length) { due.splice(0, due.length, ...receivedOnly(due, lineageOf)) }
      const ownText = ownDue.length ? String(ownDue.length) : ''
      if (ownText !== ownLog) { if (ownText) log('leaves', ownText, 'coin(s) of its own lineage out of its settle: made by itself, at risk to nobody'); ownLog = ownText }
      if (lineageOf.size > 4096) for (const id of [...lineageOf.keys()].slice(0, 2048)) { lineageOf.delete(id); hopsOf.delete(id); if (lineageOf.atRisk) lineageOf.atRisk.delete(id) }
      // Its own coins that are too large or too deep to keep, when the operator can take each now.
      const own = ownToRefresh(coins, { lineageOf, hopsOf, sizes, depthLimit: depthLimitOf(lastInfo),
        headroom: lastInfo ? headroomOf(lastInfo) : null, gaveUp, now: t }).filter((id) => !due.includes(id))
      const ownRefText = own.slice().sort().join()
      if (ownRefText !== ownRefLog) { if (own.length) log('refreshes', own.length, 'coin(s) of its own lineage larger than a working coin, or near the depth limit, that the operator can take now'); ownRefLog = ownRefText }
      due.push(...own)
      for (const [id, at] of gaveUp) if (t - at > 6 * GIVE_UP_AGAIN_MS) gaveUp.delete(id)
      // Never the last free coin of an asset it quotes (keepFree): of each asset, the coin its
      // largest quote is sized on stays out while nothing else free fills a working coin's trade,
      // and goes in a later turn; an asset's only free coin, due itself, waits until the maker must
      // settle, then goes whole.
      const book = { roomValue: roomNow(budgetValue, coins, ratesNow, lineageOf), rates: ratesNow, sizes, least: leastGives(cfg), must: outOfRoundFull || half }
      const plan = keepFree(payableView(coins, hopsOf, depthLimitOf(lastInfo)), due, book)
      const gave = new Set()   // the leaves this pass gave up or spent: given, as the next pass reads them
      const asNow = () => coins.map((c) => (c && gave.has(c.leaf_id) ? { ...c, state: 'given' } : c))
      const settling = [...plan.give]
      const keptText = plan.keep.map((k) => tickerOf(k.asset) + ' ' + k.leaf.slice(0, 12)).sort().join(', ')
      if (keptText !== keptLog) { if (keptText) log('keeps out of its round, so the asset stays offered (it settles in a later turn):', keptText); keptLog = keptText }
      // Each asset in its own participation, its new value cut into working coins (a refresh in
      // pieces), so settling never makes a coin larger than a working coin but a reserve of the rest.
      const fit = withinHeadroom(settleGroups(coins, settling, sizes), coins, lastInfo ? headroomOf(lastInfo) : null, new Set(receivedOnly(settling, lineageOf)))
      const waitText = fit.waiting.map((w) => tickerOf(w.asset) + ' ' + w.leaves.length).sort().join(', ')
      if (waitText !== waitLog) { if (waitText) log('settles in parts the operator can take on now; waiting for its headroom:', waitText); waitLog = waitText }
      for (const g of fit.groups) {
        try {
          const args = { leaves: g.leaves, ...(g.piece ? { piece: g.piece } : {}) }
          const q = await cmd('quote', args)
          const r = await cmd('participate', { ...args, shown: q.coins })
          log('settling', g.leaves.length, 'received coins of', tickerOf(g.asset) + (g.piece ? ' in pieces of ' + g.piece : '') +
            (outOfRoundFull ? ' (offers refused for what it holds out of round)' : half ? ' (past half its budget out of round)' : '') + ':',
            JSON.stringify((r.participations || []).map((p) => p.state || p.error)))
          for (const d of g.leaves) { seen.delete(d); gaveUp.set(d, t); gave.add(d) }
          noteChange('given', g.leaves)
        } catch (e) { log('settle:', e.message) }
      }
      if (due.length) outOfRoundFull = false
      // More live coins of an asset than `max_coins`: boards and the smallest coins are merged in
      // the operator's next round (coinsToMerge), MERGE_PER_PASS at most a pass (the library gives
      // up 16 a participation), so every command it makes reads a store of bounded size.
      for (const [a, n] of counted) {
        if (n <= cap(a)) continue
        const merge = coinsToMerge(coins, a, cap(a), due, perAsset(cfg.coin_size, a, null), mergeMost(cfg, a, sizes.get(a) ?? null), sizes.get(a) ?? null)
        if (merge.length < 2) continue
        try {
          const q = await cmd('quote', { leaves: merge })
          const r = await cmd('participate', { leaves: merge, shown: q.coins })
          for (const d of merge) gave.add(d)
          noteChange('given', merge)
          log('merging', merge.length, 'coins of', a.slice(0, 8), `(${n} held, at most ${cap(a)}):`, JSON.stringify((r.participations || []).map((p) => p.state || p.error)))
        } catch (e) { log('merge:', e.message) }
      }
      // Working coins: an asset it gives with fewer than WORKING_COUNT coins of a working size has
      // its smallest reserve coin cut into them in the next round.
      for (const a of givesOf()) {
        const s = shapeFor(coins, a, sizes.get(a) ?? null, gaveUp, Date.now(), perAsset(book.least, a, null), lastInfo ? headroomOf(lastInfo) : null)
        if (s && s.waits) cutWaits.set(a, `its smallest reserve that would be cut (${s.value}) is larger than the operator can take on now (nine tenths of its headroom, ${s.headroom}): it waits`)
        else cutWaits.delete(a)
        if (!s || s.waits) continue
        // A cut gives its coin to a round too: not while nothing else free of the asset would
        // fill a working coin's trade (keepFree's rule); it is cut in a later turn.
        const after = bookAfter(asNow(), a, [s.leaf], book)
        if (after.need > 0n && after.best < after.target) continue
        try {
          const args = { leaves: [s.leaf], piece: s.piece, pieces: s.pieces }
          const q = await cmd('quote', args)
          // A library that does not cut a refresh into pieces answers no `pieces`: it would give the
          // coin back whole, and the next pass would cut it again, so nothing is given up.
          if (!q || !q.pieces) { if (!noPieces) log('working coins: this leaf library does not cut a refresh into pieces; coins are left as they are'); noPieces = true; continue }
          const r = await cmd('participate', { ...args, shown: q.coins })
          gaveUp.set(s.leaf, Date.now()); gave.add(s.leaf); noteChange('given', [s.leaf])
          log('cutting a coin of', tickerOf(a), 'into', s.pieces, 'working coins of', s.piece, 'and a reserve:', JSON.stringify((r.participations || []).map((p) => p.state || p.error)))
        } catch (e) { log('working coins:', e.message) }
      }
      // What it gave up this pass is no longer quoted: the coins read again now, not at the next
      // pass, so a quote read meanwhile names only coins a firm offer can still pay from.
      if (gave.size) { try { await readHoldings() } catch (e) { log('holdings:', e.message) } }
    }
  }

  const send = (res, code, v) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' })
    res.end(JSON.stringify(v))
  }
  const body = (req) => new Promise((ok) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(p).toString() || '{}')) } catch { ok(null) } }) })

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname.replace(/\/+$/, '')
    if (req.method === 'OPTIONS') return send(res, 200, {})
    let asked = null
    try {
      if (req.method === 'GET' && (p === '/health' || p === '')) return send(res, 200, { ok: true, operator: info.operator, genesis_hash: info.genesis_hash })
      if (req.method === 'GET' && p === '/v1/quotes') {
        // A taker reading quotes asks for a firm offer next: the upkeep's next commands wait 90 s
        // so the offer finds the library free, at most once every three minutes so a reader that
        // polls cannot stop the upkeep.
        if (Date.now() - lastHold > HOLD_EVERY_MS) { lastHold = Date.now(); lib.hold(HOLD_MS) }
        // Before its first reading (just started, the library reading its store) it quotes
        // nothing, at once: a taker asks the other sources rather than waiting on this one.
        if (!holdings) { if (!firstReading) firstReading = spendable(true).catch(() => {}).finally(() => { firstReading = null }); return send(res, 200, { operator: info.operator, genesis_hash: info.genesis_hash, as_of: null, quotes: [] }) }
        // What it can give without passing its budget once a swap's coin is out of round (D94):
        // a price it shows is one it would confirm.
        const view = known(holdings)
        const sp = budgetedSpendable(view.sp, payableView(view.coins, hopsOf, depthLimitOf(lastInfo)), roomOf(view), ratesNow)
        // In-tree quotes are cut to the room left in its instant budget; a pair cut to nothing is
        // named in `after_next_round`.
        // And none that wants an asset the operator refreshes no more of now.
        const cut = capQuotes(quotesFrom(cfg.pairs, sp, new Map(), cfg.fee_margin || 0, liveRates(), cfg), wantRoomOf(view))
        const kept = withoutCapped([...cut.quotes, ...(desk ? desk.quotes(sp, cfg.fee_margin || 0) : [])], cut.later, capped)
        return send(res, 200, { operator: info.operator, genesis_hash: info.genesis_hash, as_of: Math.floor(holdings.at / 1000),
          quotes: kept.quotes, ...(kept.later.length ? { after_next_round: kept.later } : {}) })
      }
      if (req.method === 'GET' && p === '/v1/explain') {
        // Why the book is what it is, read-only: the budget and what fills it, by how each coin was
        // made, what the maker takes in no more of and why each asset it gives is not offered. The
        // coins' lineage is the library's (coin_places), asked in the queue and waited on 20 s at
        // most; the rest is the maker's last reading.
        const view = holdings ? known(holdings) : null
        let lineage = null
        try { lineage = lineageSummary(await Promise.race([cmd('coin_places', {}), new Promise((_, no) => setTimeout(() => no(new Error('the library is busy: not read within 20 s')), 20000))]), tickerOf) } catch (e) { lineage = { error: e.message } }
        const named = (m) => Object.fromEntries([...(m || [])].map(([a, v]) => [tickerOf(a), String(v)]))
        const ib = bondNow && bondNow.instant_budget
        return send(res, 200, {
          as_of: Math.floor(Date.now() / 1000), reading_at: holdings ? Math.floor(holdings.at / 1000) : null, changes_since_reading: changes.length,
          budget: ib ? { ppm: ib.ppm ?? null, own_ppm: ib.own_ppm ?? null, operator_ppm: ib.operator_ppm ?? null, value: ib.value ?? null, held_value: ib.held_value ?? null, room: ib.room ?? null } : null,
          room_now: view && budgetValue != null ? String(roomOf(view)) : null,
          counts_against_room: view ? budgetHeld(view.coins, ratesNow, tickerOf, lineageOf) : null,
          at_risk_from: lineageOf.marked ? 'the library (coin_places at_risk)' : 'mirrored from lineage and state',
          cut_waits: Object.fromEntries([...cutWaits].map(([a, why]) => [tickerOf(a), why])),
          library_out_of_round: ((bondNow && bondNow.out_of_round) || []).map((h) => ({ asset: tickerOf(h.asset), value: String(h.value) })),
          coins_by_lineage: lineage,
          held_back_at_cap: named(stuckPrev), operator_headroom: lastInfo ? named(headroomOf(lastInfo)) : null,
          takes_in_none_of: [...capped].map(tickerOf), working_coin_sizes: named(sizes),
          not_offered: Object.fromEntries([...unoffered].map(([a, why]) => [tickerOf(a), why])),
          kept_out_of_settle: keptLog || null, waiting_for_headroom: waitLog || null, open_offers: firm.size,
          btc_swaps: desk ? Object.entries([...desk.swaps.values()].reduce((m, x) => { m[x.state] = (m[x.state] || 0) + 1; return m }, {})).reduce((o, [k, v]) => ({ ...o, [k]: v }), {}) : null,
        })
      }
      if (req.method === 'GET' && p.startsWith('/v1/swap/')) { const id = p.slice('/v1/swap/'.length); return send(res, 200, { swap: id, state: await swapState(id, true) }) }
      if (desk && req.method === 'GET' && p.startsWith('/v1/btc/')) { const r = await desk.route('GET', p, {}); if (r) return send(res, r[0], r[1]) }
      if (req.method !== 'POST') return send(res, 404, { error: 'no such path' })
      const b = await body(req)
      if (!b) return send(res, 400, { error: 'the body is not JSON' })
      asked = b
      if (p === '/v1/firm' || p === '/v1/btc/firm') {
        if (b.want_asset && capped.has(b.want_asset)) return send(res, 409, { error: cappedRefusal(tickerOf(b.want_asset)), capped: true })
      }
      if (desk && p.startsWith('/v1/btc/')) {
        const r = await desk.route('POST', p, b, firmHoldings, cfg.fee_margin || 0)
        if (r) { if (p === '/v1/btc/paid') tick(); return send(res, r[0], r[1]) }
      }
      if (p === '/v1/firm') {
        const asked = Date.now()
        const t = await firmTerms(b)
        if (t.refused) return send(res, t.refused[0], t.refused[1])
        const { pair, give, want } = t
        const o = await cmd('swap_offer', { give_asset: pair.give, give: String(give), want_asset: pair.want, want: String(want) }, true)
        const expires = Date.now() + (cfg.offer_ttl_seconds ?? 300) * 1000
        firm.set(o.swap, { give_asset: pair.give, give, want_asset: pair.want, want, expires, leaves: leavesOf(o), made: madeBy(o, pair.want, want) })
        // Its coins held for the offer from now on, and read again at once, ahead of the queue (a
        // quote's 90 s hold lets only such commands run), which corrects the book (#659).
        noteChange('offered', leavesOf(o), [], o.swap)
        readHoldings(true).catch(() => {})
        log('firm', o.swap.slice(0, 12), 'gives', String(give), pair.give.slice(0, 8), 'for', String(want), pair.want.slice(0, 8),
          'in', Date.now() - asked, 'ms')
        return send(res, 200, { swap: o.swap, offer: o.offer, give: String(give), want: String(want), expires_at: Math.floor(expires / 1000) })
      }
      if (p === '/v1/accept') {
        const st = await swapState(b.swap, true)
        if (st === 'done') return send(res, 200, { swap: b.swap, state: 'done' })
        // An offer whose completion the operator refused is gone: asked again, the same answer, at
        // once, with the offer made in its place (`gone`).
        if (gone.has(b.swap)) return send(res, 409, gone.get(b.swap).body)
        if (st !== 'open') return send(res, 409, notOpenAnswer(st))
        let r
        try { r = await cmd('swap_complete', { accept: String(b.accept || '') }, true) } catch (e) {
          if (!completionRefused(e)) throw e
          // The operator refused it: nothing was co-signed and the offer is withdrawn, its coins the
          // maker's again (a library that leaves it open has it cancelled here). The taker is told at
          // once, with a new offer at the same price from what the maker holds now when it can make
          // one, so the wallet goes ahead in seconds rather than handing the acceptance over again.
          if (e.kind !== 'swap_refused') await cmd('swap_cancel', { swap: String(b.swap) }, true).catch((x) => log('cancel', String(b.swap).slice(0, 12), x.message))
          const f = firm.get(b.swap)
          firm.delete(b.swap)
          forgetChange(b.swap)
          let again = null
          if (f) {
            try {
              // Priced as a firm offer is now, with its checks; made only when the live price asks
              // no more than the gone offer did, so a refused acceptance never holds a price.
              const t = await firmTerms({ give_asset: f.give_asset, want_asset: f.want_asset, give: String(f.give) })
              const want = t.refused ? null : againWant(f.want, t.want)
              if (want == null) log('no new offer for', String(b.swap).slice(0, 12) + ':', t.refused ? t.refused[1].error : `the price moved (${t.want} for ${f.want} asked before)`)
              else {
                const o = await cmd('swap_offer', { give_asset: f.give_asset, give: String(f.give), want_asset: f.want_asset, want: String(want) }, true)
                const expires = Date.now() + (cfg.offer_ttl_seconds ?? 300) * 1000
                firm.set(o.swap, { ...f, want, expires, leaves: leavesOf(o), made: madeBy(o, f.want_asset, want) })
                noteChange('offered', leavesOf(o), [], o.swap)
                again = { swap: o.swap, offer: o.offer, give: String(f.give), want: String(want), expires_at: Math.floor(expires / 1000) }
              }
            } catch (x) { log('no new offer for', String(b.swap).slice(0, 12) + ':', x.message) }
          }
          readHoldings(true).catch(() => {})
          const body = goneAnswer(b.swap, e, again)
          gone.set(b.swap, { body, at: Date.now() })
          for (const [k, v] of gone) if (Date.now() - v.at > GONE_KEEP_MS) gone.delete(k)
          log('refused completion', String(b.swap).slice(0, 12), (e.whose ? `(the ${e.whose}'s coin)` : '') + ':', e.message,
            again ? '; offered again as ' + again.swap.slice(0, 12) : '; no new offer')
          return send(res, 409, body)
        }
        const f = firm.get(b.swap)
        if (f) reportTrade({ rail: 'leaf-maker', id: b.swap, give_asset: f.give_asset, give: f.give, want_asset: f.want_asset, want: f.want })
        firm.delete(b.swap)
        // The offer's coins spent, its change and what it was paid out of round and not read yet;
        // read again at once, ahead of the queue, which corrects the book (#659).
        if (f) noteChange('done', f.leaves, f.made, b.swap)
        readHoldings(true).catch(() => {})
        log('done', String(r.swap).slice(0, 12))
        return send(res, 200, { swap: b.swap, state: 'done' })
      }
      if (p === '/v1/release') {
        // Answered at once: the cancel goes into the library's queue ahead of the upkeep, and a
        // taker's next firm, also ahead of the upkeep, queues behind it, so the coins this offer
        // held are free by the time that firm runs. Waiting for the cancel here made a taker
        // wait out whatever upkeep command was running (a sync can take tens of seconds). Once
        // cancelled, the coins are read again ahead of the queue, so the coin the offer held is
        // quoted again at once rather than at the upkeep's next pass.
        firm.delete(b.swap)
        cmd('swap_cancel', { swap: String(b.swap || '') }, true)
          .then((x) => { forgetChange(String(b.swap || '')); return x })
          .then(() => readHoldings(true).catch(() => {}))
          .catch((e) => { if (!/not open|no such|unknown/i.test(e.message)) log('release', e.message) })
        return send(res, 200, { swap: b.swap, state: 'releasing' })
      }
      return send(res, 404, { error: 'no such path' })
    } catch (e) {
      log('refused', p, e.message)
      const full = OUT_OF_ROUND_FULL.test(e.message || '')
      if (full) {
        log('holds out of round, by its last reading:', outOfRoundSummary(holdings && holdings.coins, tickerOf, lineageOf), '; asked to take', asked && asked.want_asset ? tickerOf(asked.want_asset) : '?')
        outOfRoundFull = true; readRoom(true).catch(() => {}); setImmediate(tick)
      }
      return send(res, 409, { error: e.message, kind: e.kind || null, ...(full ? { after_next_round: true } : {}) })
    }
  })
  const [host, port] = String(cfg.listen).split(':')
  srv.listen(Number(port), host || '127.0.0.1', () => log(`leaf maker listening on ${host}:${srv.address().port}`))
  tick()
  setInterval(tick, (cfg.sync_seconds ?? 20) * 1000)
  setInterval(forfeitPass(cmd, log), (cfg.forfeit_seconds ?? FORFEIT_SECONDS) * 1000)
  const stop = () => { log('stopping'); srv.close(); lib.stop(); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message || e); process.exit(1) })
