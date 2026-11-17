// The maker keeps its book against an operator whose in-flight cap is nearly full, against the real
// leaf wallet library (LEAVES_PKG, or the page's leaves/pkg), the real maker (leaf-maker.mjs in a
// process of its own) and a real operator (web #778).
//
// - The deadlock: a coin of the maker's own lineage, of kind transfer (the change of a payment to
//   itself, as keepFree's old split made), larger than the operator's headroom in its asset and
//   than half the maker's budget. It is no coin received: it is never given to a refresh the cap
//   cannot take, and never counted against the room, so every pair stays offered.
// - Received coins against a small headroom: takers pay the maker an asset until what it holds of
//   it out of round reaches the headroom. It takes in no more of that asset, every other pair stays
//   offered, what it received settles in parts within the headroom, and a sale past its share of
//   the headroom in one trade is refused and quoted at what is left of it.
// - Depth: forty trades in a row on one pair, both ways. Every trade's change is a reassignment
//   deeper each time; the operator refuses none of the maker's offers for depth, every trade
//   completes (a taker refused while the maker's instant budget waits for a round asks again), and
//   the book is offered at every reading of the five minutes after.
//
// The book is read once a second (/v1/quotes) and the maker's explain answer (/v1/explain) at each
// step. It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs)
// with three more assets listed for fees (ARCA_OPERATOR_MORE_ASSETS=3) and the control paths that
// set an asset's in-flight cap and the bond's instant budget, its control address in
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm (../../pkg or LWK_PKG); it skips itself otherwise.
// - A BTC purchase's lock (b): the maker pays a few units of an asset into a buyer's receive over
//   Lightning, and its book stays offered through the lock, the purchase and the trades after it.
//   It needs the harness's Lightning legs and Bitcoin side (ARCA_OPERATOR_LIGHTNING=1,
//   ARCA_OPERATOR_BTC_LIGHTNING=1) and skips itself without them, and runs on the harness's X and Y
//   (its Lightning peer takes no channel in the more assets). The maker here boards in working
//   coins and holds no reserve, so it shows which coin each lock took and the book through it, not
//   the testnet's reserve-holding maker: it passes on a library before arca #911 as well.
// - A firm offer asked while the maker syncs (e): answered within one slice of the sync, not after
//   the whole pass (`budget_ms`, the maker's `sync in N slices` line).
// - A maker of a large store (f), as a busy maker's on the testnet: some 700 coins on X and Y, the
//   operator behind a proxy that holds each request (LEAF_MAKER_OPERATOR_DELAY_MS, 250 ms). A firm
//   offer asked during a sync (one every LEAF_MAKER_PROBE_MS, 15 s) is answered within a slice, every
//   pass of the sync ends within its bound (`sync_pass_bound_ms`), and the rest of the upkeep (BTC
//   purchases completed, received coins settled), whose commands run between the sync's slices, is
//   done. It needs the harness's Lightning legs and Bitcoin side, as b does.
// - A maker of a large store through an hour of trades (g): its upkeep, its sync's passes and ten
//   sales of an asset for BTC, each to Settled, at the box's link and settings (see the case).
// - A pass's time on a store with a long-running maker's history (s): the large store, with the
//   participations one of the testnet's makers holds (LEAF_MAKER_STORE_HISTORY, main by default),
//   its sync run in whole passes and in slices by one library and another in turn (LEAVES_PKG and
//   LEAF_MAKER_OLD_PKG), and sized (`--size`). See the case.
// LEAF_MAKER_CASES (a, c, d; every one when unset; b, e, f, g, n and s, only when named) picks the cases.
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test tooling/lsp/leaf-maker-headroom-library.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { leafLibraryThread } from '../leaf-node.mjs'
import { harness, launchMaker, makerReady, freePort, sleep, lwkFrom } from '../user-mode-stack.mjs'
import { clnRpc } from '../cln-rpc.mjs'
import { needSeconds } from '../../user-trade-btc.js'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('../../leaves/pkg', import.meta.url).pathname
const LWK = process.env.LWK_PKG || new URL('../../pkg', import.meta.url).pathname
const CASES = (process.env.LEAF_MAKER_CASES || 'a,c,d').split(',')
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package'
    : !existsSync(join(LWK, 'lwk_wasm_bg.wasm')) ? 'needs the wallet kit (LWK_PKG)' : false
const skipCase = (c) => skip || (CASES.includes(c) ? false : 'not in LEAF_MAKER_CASES')

// The bond the operator posts and the share of it the maker holds out of round at most: a budget
// of 500,000 reference atoms (every asset here is listed at 1:1).
const BOND = 5_000_000
const BUDGET_SHARE = '0.1'
const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(0) + 's'

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(30000) })).json()

async function stack (more = 3) {
  const H = harness(CONTROL)
  let st = await H.state()
  st.more = st.more || []
  assert.ok(st.more.length >= more, 'the harness serves three more assets (ARCA_OPERATOR_MORE_ASSETS=3)')
  if (!st.bond) {
    await H.c('/bond_post', { amount: BOND, instant_budget_fraction: 0.5 }); st = await H.state()
    // The operator funds its rounds from its own coins of each asset.
    for (const a of [...new Set([st.x, st.y, ...st.more].filter(Boolean))]) await H.c('/fund_server', { asset: a, amount: 200000000 })
    await H.produce(); await H.bury()
  }
  const info = await getJson(st.server.replace(/\/+$/, '') + '/v1/info')
  console.log(at(), 'operator: finality', JSON.stringify(info.finality ?? null), 'depth_limit', info.depth_limit, 'checkpoint_exit', info.checkpoint_exit,
    'bond', JSON.stringify(info.bond ? { instant_budget_ppm: info.bond.instant_budget_ppm } : null))
  return { H, st, lwk: await lwkFrom(LWK) }
}
const opInfo = (st) => getJson(st.server.replace(/\/+$/, '') + '/v1/info')
const inFlightOf = async (st, asset) => { const a = ((await opInfo(st)).assets || []).find((x) => x.asset === asset) || {}; return { in_flight: BigInt(a.in_flight ?? 0), cap: a.in_flight_cap ?? null } }
// Sets the operator's in-flight cap of `asset` so that its headroom is `room` atoms now (null: none).
async function headroom (H, st, asset, room) {
  if (room == null) return H.c('/fees', { asset, in_flight_cap: null })
  const { in_flight } = await inFlightOf(st, asset)
  return H.c('/fees', { asset, in_flight_cap: Number(in_flight + BigInt(room)) })
}

// Something of `asset` in flight, as on the testnet (where 41 million of a 44 million cap were): the
// operator's cap holds nothing back while nothing of the asset is in flight (a refresh larger than
// the cap then runs), and it publishes what is in flight only of an asset it caps. Value stays in
// flight while a node it rests on holds a coin nobody has given up: W pays R 20,000 out of round
// (R never refreshes), then refreshes its change, which rests on the same node. -> in flight.
async function makeInFlight (H, st, W, R, asset) {
  if ((await inFlightOf(st, asset)).cap == null) await H.c('/fees', { asset, in_flight_cap: 1e15 })
  // What is in flight is traced to a round's batch leaf (a board's coin counts for nothing): W's
  // coin of a board is refreshed into a round first.
  const liveOf = async () => { await W.t('sync').catch(() => {}); return (await W.t('coins')).filter((x) => x.asset === asset && x.state === 'live') }
  if (!(await liveOf()).some((x) => x.kind !== 'board')) {
    const b = (await liveOf()).sort((x, y) => Number(BigInt(y.value) - BigInt(x.value)))[0]
    if (!b) throw new Error('the wallet holds no live coin of ' + asset.slice(0, 8))
    const q = await W.t('quote', { leaves: [b.leaf_id] })
    await W.t('participate', { leaves: [b.leaf_id], shown: q.coins })
    for (let i = 0; i < 90 && !(await liveOf()).some((x) => x.kind !== 'board'); i++) { await H.pump().catch(() => {}); await sleep(1000) }
  }
  for (let k = 0; k < 3; k++) {
    let { in_flight } = await inFlightOf(st, asset)
    if (in_flight > 0n) return in_flight
    const req = await R.t('receive', { asset, amount: '20000' })
    // Once the round's new coin is the wallet's to spend (its round final).
    for (let i = 0; ; i++) {
      try { await W.t('send', { request: req.request, amount: '20000' }); break } catch (e) { if (i > 180) throw e; await H.pump().catch(() => {}); await W.t('sync').catch(() => {}); await sleep(1000) }
    }
    let c = null
    for (let i = 0; i < 60 && !c; i++) {
      await W.t('sync').catch(() => {})
      c = (await W.t('coins')).filter((x) => x.asset === asset && x.state === 'live' && x.kind === 'transfer').sort((x, y) => Number(BigInt(y.value) - BigInt(x.value)))[0]
      if (!c) { await H.pump().catch(() => {}); await sleep(1000) }
    }
    if (!c) throw new Error('the wallet holds no change of ' + asset.slice(0, 8))
    const q = await W.t('quote', { leaves: [c.leaf_id] })
    await W.t('participate', { leaves: [c.leaf_id], shown: q.coins })
    for (let i = 0; i < 60; i++) {
      await H.pump().catch(() => {}); await W.t('sync').catch(() => {})
      if ((await inFlightOf(st, asset)).in_flight > 0n) break
      await sleep(1000)
    }
  }
  const { in_flight } = await inFlightOf(st, asset)
  console.log(at(), 'in flight of', asset.slice(0, 8), String(in_flight))
  return in_flight
}

// A wallet of the leaf library on the harness: `assets` boarded, one coin each.
async function wallet (H, st, lwk, dir, mnemonic, boards, extra = {}) {
  const config = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 1, min_exit_delay_units: 1, ...extra }
  const lib = await leafLibraryThread(dir)
  const W = (await lib.exists(mnemonic)) ? await lib.open(mnemonic, st.node_password) : await lib.create(mnemonic, config)
  const t = (c, a = {}) => W.command(c, a)
  const addr = await t('address')
  for (const [a, v] of boards) await H.fund(addr.script_pubkey, a, v + 300000)
  await H.produce()
  for (const [a, v] of boards) {
    for (let i = 0; ; i++) {
      try { await t('sync'); const q = await t('board_quote', { asset: a, amount: String(v), fee_asset: a }); await t('board', { asset: a, amount: String(v), fee_asset: a, shown: q.fee }); break } catch (e) { if (i > 30) throw e; await H.produce(); await sleep(1000) }
    }
  }
  for (let i = 0; i < 90; i++) {
    await H.produce(); await H.bury(); await t('sync')
    const live = new Set((await t('coins')).filter((c) => c.state === 'live').map((c) => c.asset))
    if (boards.every(([a]) => live.has(a))) break
    await sleep(1000)
  }
  return { lib, t, stop: () => lib.stop() }
}

// A taker's own change, refreshed into a round: a sale may pay from its change (the library pays
// from a coin already at risk first, then the smallest that pays alone), a reassignment deeper each time, and past the operator's depth
// limit it pays no more ("more are at the operator's depth limit"). -> once the round's new
// coins are the taker's to spend: a live coin of a round in each asset refreshed.
async function refreshChange (H, W) {
  await W.t('sync').catch(() => {})
  const out = (await W.t('coins')).filter((c) => c.state === 'live' && (c.kind === 'transfer' || c.kind === 'fill'))
  if (!out.length) return
  const ch = out.map((c) => c.leaf_id), assets = [...new Set(out.map((c) => c.asset))]
  try { const q = await W.t('quote', { leaves: ch }); await W.t('participate', { leaves: ch, shown: q.coins }) } catch (e) { console.log(at(), 'taker refresh:', e.message); return }
  for (let i = 0; i < 300; i++) {
    await H.pump().catch(() => {}); await W.t('sync').catch(() => {})
    const live = (await W.t('coins')).filter((c) => c.state === 'live')
    if (assets.every((a) => live.some((c) => c.asset === a && c.kind === 'batch'))) return
    await sleep(1000)
  }
  console.log(at(), 'taker refresh: its round did not come back within 300 s')
}

// The maker's configuration, as startMaker writes it, with its budget share named.
function makerConfig (dir, st, port, mnemonic, pairs, extra = {}) {
  mkdirSync(dir, { recursive: true })
  const mnemonicFile = join(dir, 'mnemonic')
  writeFileSync(mnemonicFile, mnemonic, { mode: 0o600 })
  const cfg = { wallet: 'leaf-maker-regtest', mnemonic_file: mnemonicFile, store_dir: join(dir, 'store'), listen: `127.0.0.1:${port}`,
    operator: { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password },
    exit_delay_units: 1, min_exit_delay_units: 1, pairs, fee_margin: '2000', sync_seconds: 3, settle_seconds: 30, offer_ttl_seconds: 300,
    board_keep: '100000', instant_budget: BUDGET_SHARE, ...extra }
  writeFileSync(join(dir, 'maker.json'), JSON.stringify(cfg, null, 2))
  return cfg
}

// The book read once a second: for each pair named, the readings it was offered in and not.
function watchBook (maker, pairs, name) {
  const key = (g, w) => name(g) + '->' + name(w)
  const seen = new Map(pairs.map(([g, w]) => [key(g, w), { on: 0, off: 0, offAt: [], recent: [] }]))
  let on = true, readings = 0, errors = 0
  const run = (async () => {
    while (on) {
      try {
        const qs = (await getJson(maker.url + '/v1/quotes')).quotes || []
        readings++
        for (const [g, w] of pairs) {
          const s = seen.get(key(g, w))
          const on = qs.some((q) => q.give_asset === g && q.want_asset === w && BigInt(q.max_give) > 0n)
          if (on) s.on++
          else { s.off++; if (s.offAt.length < 20) s.offAt.push(at()) }
          s.recent.push(on); if (s.recent.length > 300) s.recent.shift()
        }
      } catch { errors++ }
      await sleep(1000)
    }
  })()
  return { seen,
    stop: async () => {
      on = false; await run
      const lastOff = Object.fromEntries([...seen].map(([k, s]) => [k, s.recent.filter((x) => !x).length]))
      return { readings, errors, lastOff, pairs: Object.fromEntries([...seen].map(([k, s]) => [k, { on: s.on, off: s.off, offAt: s.offAt }])) }
    },
    reset: () => { for (const s of seen.values()) { s.on = 0; s.off = 0; s.offAt = []; s.recent = [] } } }
}
const explain = async (maker, label) => {
  try {
    const e = await getJson(maker.url + '/v1/explain')
    console.log(at(), 'explain', label + ':', JSON.stringify({ room_now: e.room_now, budget: e.budget && e.budget.value, counts: e.counts_against_room, lineage: e.coins_by_lineage,
      library_out_of_round: e.library_out_of_round, headroom: e.operator_headroom, takes_in_none_of: e.takes_in_none_of, not_offered: e.not_offered,
      waiting_for_headroom: e.waiting_for_headroom, kept: e.kept_out_of_settle, at_risk_from: e.at_risk_from, at_risk_decided: e.at_risk_decided }))
    return e
  } catch (x) { console.log(at(), 'explain', label + ': none (' + x.message + ')'); return null }
}
const pumpLoop = (H, every = 2000) => {
  let on = true
  const run = (async () => { while (on) { try { await H.pump() } catch {} await sleep(every) } })()
  return async () => { on = false; await run }
}
// A trade with the maker: the taker asks a firm offer of `give` of `give_asset`, takes it, and the
// maker completes it. -> the firm answer's time, ms.
async function trade (maker, t, give_asset, want_asset, give, tries = 60) {
  const first = Date.now()
  let firstRefused = null
  for (let i = 0; ; i++) {
    const asked = Date.now()
    const f = await post(maker.url + '/v1/firm', { give_asset, want_asset, give: String(give) })
    const ms = Date.now() - asked
    if (f.status === 200) {
      const read = await t('swap_read', { offer: f.body.offer })
      const acc = await t('swap_accept', { offer: f.body.offer, shown: read })
      const done = await post(maker.url + '/v1/accept', { swap: f.body.swap, accept: acc.accept })
      assert.equal(done.status, 200, JSON.stringify(done.body))
      await t('mailbox').catch(() => {})
      return { ms, refusals: i, waited_ms: Date.now() - first, ...(firstRefused ? { first_refusal: JSON.stringify(firstRefused).slice(0, 200) } : {}) }
    }
    if (i >= tries) return { ms, refused: f.body, refusals: i, waited_ms: Date.now() - first }
    if (!firstRefused) firstRefused = f.body
    await sleep(2000)
  }
}
// With LEAF_MAKER_LOG set (a path prefix), each case's maker log and last explain answer are
// written there when the case ends.
const dumpMaker = async (maker, tag) => {
  if (!process.env.LEAF_MAKER_LOG || !maker) return
  let e = null
  try { e = await getJson(maker.url + '/v1/explain') } catch (x) { e = { error: x.message } }
  writeFileSync(process.env.LEAF_MAKER_LOG + '-' + tag + '.log', maker.log.join('') + '\n--- explain at the end:\n' + JSON.stringify(e, null, 1) + '\n')
}
const logLines = (maker, from, re) => maker.log.slice(from).join('').split('\n').filter((l) => re.test(l))

test('a: a coin of the maker\'s own lineage larger than the headroom never stops its book', { skip: skipCase('a'), timeout: 3_600_000 }, async () => {
  const { H, st, lwk } = await stack()
  const X = st.x, M = st.more[0]
  const name = (a) => (a === X ? 'X' : a === M ? 'M0' : a.slice(0, 6))
  const dir = mkdtempSync(join(tmpdir(), 'maker-headroom-a-'))
  const stops = []
  let makerOf = null
  try {
    // The maker's store made first: M0 boarded as one coin of 900,000 and refreshed into a round (as
    // the box's reserve was a coin of a round), then a payment of 30,000 of it to itself, as
    // keepFree's old split made one: its change, about 870,000, of its own lineage and of kind
    // transfer, on the round's batch leaf, so that its refresh opens its whole value under the
    // operator's cap; and X boarded.
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const pairs = [{ give: M, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: X, want: M, rate_num: '1', rate_den: '1', min_give: '10000' }]
    const cfg = makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs)
    const seed = await wallet(H, st, lwk, cfg.store_dir, mnemonic, [[M, 900000], [X, 400000]])
    {
      const b = (await seed.t('coins')).find((c) => c.asset === M && c.state === 'live')
      const q = await seed.t('quote', { leaves: [b.leaf_id] })
      await seed.t('participate', { leaves: [b.leaf_id], shown: q.coins })
    }
    const req = await seed.t('receive', { asset: M, amount: '30000' })
    for (let i = 0; ; i++) {
      try { await seed.t('send', { request: req.request, amount: '30000' }); break } catch (e) { if (i > 180) throw e; await H.pump().catch(() => {}); await seed.t('sync').catch(() => {}); await sleep(1000) }
    }
    for (let i = 0; i < 5; i++) { await H.produce(); await seed.t('sync').catch(() => {}) }
    const places = await seed.t('coin_places', {})
    console.log(at(), 'the maker\'s coins after its payment to itself:', JSON.stringify((places.coins || []).filter((c) => c.state !== 'spent').map((c) => [name(c.asset), c.kind, c.lineage, c.state, c.value, c.hops])))
    const own = (places.coins || []).filter((c) => c.asset === M && c.kind === 'transfer' && c.lineage === 'own' && c.state === 'live').sort((x, y) => Number(BigInt(y.value) - BigInt(x.value)))[0]
    assert.ok(own, 'the payment to itself left a coin of its own lineage, of kind transfer')
    await seed.stop()
    // The taker, and some M0 in flight, then the operator's headroom in M0 smaller than that coin:
    // 200,000.
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 400000], [M, 400000]])
    stops.push(() => T.stop())
    const R = await wallet(H, st, lwk, join(dir, 'r'), lwk.Mnemonic.fromRandom(12).toString(), [])
    stops.push(() => R.stop())
    assert.ok(await makeInFlight(H, st, T, R, M) > 0n, 'some M0 is in flight')
    await headroom(H, st, M, 200000)
    console.log(at(), 'M0 in flight', JSON.stringify(await inFlightOf(st, M), (k, v) => (typeof v === 'bigint' ? String(v) : v)))
    const maker = await launchMaker(H, join(dir, 'maker'), port, null)
    maker.url = `http://127.0.0.1:${port}`
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    await makerReady(H, maker, X, 300000)
    const book = watchBook(maker, [[M, X], [X, M]], name)
    stops.push(() => book.stop())
    await explain(maker, 'at start')
    // The taker trades once each way, so that the maker holds coins it received: its upkeep settles.
    console.log(at(), 'trade M0 for X:', JSON.stringify(await trade(maker, T.t, M, X, 20000, 5)))
    console.log(at(), 'trade X for M0:', JSON.stringify(await trade(maker, T.t, X, M, 20000, 5)))
    // Ten minutes through the upkeep's settles and the rounds (settle_seconds 30).
    book.reset()
    for (let i = 0; i < 10; i++) { await sleep(60000); await explain(maker, 'minute ' + (i + 1)) }
    const r = await book.stop()
    const lines = logLines(maker, 0, /settling|own lineage|waiting for its headroom|offers no|takes in none|held back|keeps out/)
    console.log('the maker said:\n' + lines.map((l) => l.slice(0, 300)).join('\n'))
    console.log('the book over ten minutes:', JSON.stringify(r))
    // Never empty for good. On today's library (f8e98e1b) the book stops once, after the first
    // trade: the library pays it from the large coin out of round (arca #892), and on an operator
    // without checkpoint exits the swap's change is received, at risk at its whole value until a
    // round refreshes it (and counted whole while given, arca #889). The stop's length is printed.
    for (const [k, s] of Object.entries(r.pairs)) {
      console.log(`${k}: not offered in ${s.off} of ${s.on + s.off} readings`)
      assert.equal(r.lastOff[k], 0, `${k} offered at every reading of the last five minutes`)
    }
  } finally {
    await dumpMaker(makerOf, 'a')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('c: received coins against a small headroom stop that asset\'s intake only, and settle in parts', { skip: skipCase('c'), timeout: 3_600_000 }, async () => {
  const { H, st, lwk } = await stack()
  const X = st.x, M = st.more[1], N = st.more[2]
  const name = (a) => (a === X ? 'X' : a === M ? 'M1' : a === N ? 'M2' : a.slice(0, 6))
  const dir = mkdtempSync(join(tmpdir(), 'maker-headroom-c-'))
  const stops = []
  let makerOf = null
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const pairs = [M, N].flatMap((m) => [{ give: m, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: X, want: m, rate_num: '1', rate_den: '1', min_give: '10000' }])
    // The operator's suggested share (0.5): working coins large against the harness operator's
    // fixed margins, which the library bounds at 1% of a coin, as the testnet's coins are.
    makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5' })
    const maker = await launchMaker(H, join(dir, 'maker'), port, [[M, 400000], [N, 400000], [X, 700000]])
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    for (const a of [M, N, X]) await makerReady(H, maker, a, 300000)
    // Its working coins cut before the cap is set (a cut is a refresh of a whole coin).
    for (let i = 0; i < 180 && !logLines(maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    await sleep(60000)
    await explain(maker, 'shaped')
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 600000], [M, 600000], [N, 300000]])
    stops.push(() => T.stop())
    const R = await wallet(H, st, lwk, join(dir, 'r'), lwk.Mnemonic.fromRandom(12).toString(), [])
    stops.push(() => R.stop())
    assert.ok(await makeInFlight(H, st, T, R, M) > 0n, 'some M1 is in flight')
    // The headroom in M1: 100,000 (the maker counts on 90,000 of it).
    await headroom(H, st, M, 100000)
    const book = watchBook(maker, [[M, X], [X, M], [N, X], [X, N]], name)
    stops.push(() => book.stop())
    // The taker sells M1 to the maker, 30,000 at a time, until the maker takes in no more of it.
    const sold = []
    for (let i = 0; i < 6; i++) {
      const r = await trade(maker, T.t, X, M, 30000, 5)
      sold.push(r)
      console.log(at(), 'the maker buys 30,000 M1:', JSON.stringify(r))
      await explain(maker, 'after sale ' + (i + 1))
      if (r.refused) break
      if (i % 2 === 1) await refreshChange(H, T)
    }
    const stoppedAt = book.seen.get('X->M1').offAt[0]
    console.log(at(), 'X->M1 first not offered at', stoppedAt)
    // The other pairs trade on.
    console.log(at(), 'trade M2 for X:', JSON.stringify(await trade(maker, T.t, N, X, 20000)))
    console.log(at(), 'trade X for M2:', JSON.stringify(await trade(maker, T.t, X, N, 20000)))
    // The headroom returns: no cap. What waited settles; intake of M1 opens again.
    await sleep(120000)
    await explain(maker, 'capped two minutes')
    await headroom(H, st, M, null)
    for (let i = 0; i < 5; i++) { await sleep(60000); await explain(maker, 'cap lifted, minute ' + (i + 1)) }
    // A sale larger than the maker's share of the headroom in one trade: the cap set again at
    // 100,000, the taker offers 120,000 M1 at once. The maker takes in no coin larger than nine
    // tenths of the headroom: it refuses, and quotes what is left of that share.
    await makeInFlight(H, st, T, R, M)
    await headroom(H, st, M, 100000)
    await sleep(65000)
    await refreshChange(H, T)
    const big = await trade(maker, T.t, X, M, 120000, 5)
    console.log(at(), 'the maker buys 120,000 M1 in one trade:', JSON.stringify(big))
    assert.ok(big.refused && big.refused.after_next_round, 'the sale past its share of the headroom is refused for after its next round')
    assert.ok(!big.refused.quote || BigInt(big.refused.quote.max_give) <= 90_000n, 'quoted at most nine tenths of the headroom: ' + JSON.stringify(big.refused.quote))
    for (let i = 0; i < 4; i++) { await sleep(60000); await explain(maker, 'large coin, minute ' + (i + 1)) }
    const r = await book.stop()
    const lines = logLines(maker, 0, /settling|own lineage|waiting for its headroom|offers no|takes in|held back|keeps out/)
    console.log('the maker said:\n' + lines.map((l) => l.slice(0, 300)).join('\n'))
    console.log('the book:', JSON.stringify(r))
    assert.ok(sold.some((s) => s.refused) || r.pairs['X->M1'].off > 0, 'the maker stopped taking in M1 at its headroom')
    for (const k of ['M1->X', 'M2->X', 'X->M2']) assert.equal(r.pairs[k].off, 0, `${k} offered at every reading (${r.pairs[k].off} not, at ${r.pairs[k].offAt.join(' ')})`)
    assert.ok(lines.some((l) => /settling \d+ received coins of/.test(l) && (l.includes(M) || l.includes(M.slice(0, 8)))), 'what it received of M1 settled')
  } finally {
    await dumpMaker(makerOf, 'c')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('d: forty trades in a row on one pair, both ways: quoted throughout, no depth refusal', { skip: skipCase('d'), timeout: 3_600_000 }, async () => {
  const { H, st, lwk } = await stack()
  const X = st.x, M = st.more[2]
  const name = (a) => (a === X ? 'X' : a === M ? 'M2' : a.slice(0, 6))
  const dir = mkdtempSync(join(tmpdir(), 'maker-depth-d-'))
  const stops = []
  let makerOf = null
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const pairs = [{ give: M, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: X, want: M, rate_num: '1', rate_den: '1', min_give: '10000' }]
    // The operator's suggested share (0.5): working coins large against the harness operator's
    // fixed margins, which the library bounds at 1% of a coin, as the testnet's coins are.
    makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5' })
    const maker = await launchMaker(H, join(dir, 'maker'), port, [[M, 1500000], [X, 1500000]])
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    for (const a of [M, X]) await makerReady(H, maker, a, 300000)
    for (let i = 0; i < 180 && !logLines(maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    await sleep(60000)
    const book = watchBook(maker, [[M, X], [X, M]], name)
    stops.push(() => book.stop())
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 800000], [M, 800000]])
    stops.push(() => T.stop())
    const results = []
    for (let i = 0; i < 40; i++) {
      const [g, w] = i % 2 ? [X, M] : [M, X]
      // Trades of 110,000 to 150,000, so that what the maker receives is large against the harness
      // operator's fixed margins (about 700 to 1,000 atoms), as a testnet trade is against its own:
      // the library pays a swap from a received coin first, and refuses one whose margins pass its
      // 1% bound (arca #869).
      // A taker trades within the quote: at most its max_give, waiting while it is under the least.
      let size = 110000 + (i % 5) * 10000
      for (let k = 0; k < 30; k++) {
        const q = ((await getJson(maker.url + '/v1/quotes')).quotes || []).filter((x) => x.give_asset === g && x.want_asset === w)
        const most = q.reduce((m, x) => (BigInt(x.max_give) > m ? BigInt(x.max_give) : m), 0n)
        if (most >= 10000n) { if (BigInt(size) > most) size = Number(most); break }
        await sleep(2000)
      }
      // A taker refused for the maker's instant budget (`after_next_round`: its coins wait for their
      // round) asks again, as a wallet does, for up to about four minutes.
      const r = await trade(maker, T.t, g, w, size, 120)
      results.push({ i, pair: name(g) + '->' + name(w), size, ...r })
      // The taker's change, refreshed every other trade: this case is the maker's depth, not its.
      if (i % 2 === 1) await refreshChange(H, T)
      if (i % 5 === 4) {
        const e = await explain(maker, 'after trade ' + (i + 1))
        const hops = (Array.isArray(e && e.coins_by_lineage) ? e.coins_by_lineage : []).map((x) => [x.lineage, x.asset, x.kind, x.state, x.n, x.hops_most])
        console.log(at(), 'hops by lineage after trade', i + 1, JSON.stringify(hops))
      }
    }
    for (let i = 0; i < 5; i++) { await sleep(60000); await explain(maker, 'after the trades, minute ' + (i + 1)) }
    const r = await book.stop()
    const depth = logLines(maker, 0, /depth/i)
    const lines = logLines(maker, 0, /settling|own lineage|merging|cutting|offers no|depth/)
    console.log('the maker said:\n' + lines.map((l) => l.slice(0, 300)).join('\n'))
    console.log('trades:', JSON.stringify(results.map((x) => [x.i, x.pair, x.size, x.ms, x.refusals, x.waited_ms, x.refused ? JSON.stringify(x.refused).slice(0, 200) : 'ok'])))
    const waits = results.filter((x) => x.first_refusal)
    console.log(`waits: ${waits.length} of 40 trades waited, the longest ${Math.max(0, ...results.map((x) => x.waited_ms))} ms; first refusals:`, JSON.stringify(waits.map((x) => [x.i, x.waited_ms, x.first_refusal])))
    console.log('the book:', JSON.stringify(r))
    for (const [k, s] of Object.entries(r.pairs)) console.log(`${k}: not offered in ${s.off} of ${s.on + s.off} readings`)
    assert.equal(results.filter((x) => x.refused).length, 0, 'every trade completed, a taker asking again through a pause of the instant budget')
    assert.equal(depth.length, 0, 'no depth refusal: ' + depth.join('\n'))
    // While four million of trades pass a budget of 2.5 million, a pair is off between rounds; it is
    // offered at every reading of the five minutes after the trades.
    for (const [k] of Object.entries(r.pairs)) assert.equal(r.lastOff[k], 0, `${k} offered at every reading of the last five minutes`)
  } finally {
    await dumpMaker(makerOf, 'd')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// The book read every `everyMs`: at each reading, how many of `pairs` are offered. -> { stop() }
// answering the readings as [ms since start, offered].
function countBook (maker, pairs, everyMs = 5000) {
  let on = true
  const readings = []
  const t0 = Date.now()
  const run = (async () => {
    while (on) {
      try {
        const qs = (await getJson(maker.url + '/v1/quotes')).quotes || []
        readings.push([Date.now() - t0, pairs.filter(([g, w]) => qs.some((q) => q.give_asset === g && q.want_asset === w && BigInt(q.max_give) > 0n)).length])
      } catch { readings.push([Date.now() - t0, null]) }
      await sleep(everyMs)
    }
  })()
  return { t0, readings, stop: async () => { on = false; await run; return readings } }
}

// One purchase with BTC, as the page makes it (user-trade-btc.js): the maker's firm offer of `give`
// of `asset` for BTC, the buyer's receive under the hash of the maker's invoice, the maker's lock,
// the buyer's leaf ready, the BTC paid from the buyer's node, the preimage handed to the operator
// and the leaf claimed. -> the times of each step (ms after the lock) and what the library said
// while the leaf was not ready.
async function btcPurchase (maker, T, ln, asset, give) {
  const f = await post(maker.url + '/v1/btc/firm', { give_asset: asset, want_asset: 'BTC', give: String(give) })
  assert.equal(f.status, 200, 'a firm offer: ' + JSON.stringify(f.body))
  const d = await ln('decode', { string: f.body.invoice })
  const hash = d.payment_hash
  const rq = await T.t('lightning_receive_quote', { asset, amount: String(give) }).catch(() => null)
  const r = await T.t('lightning_receive', { asset, amount: String(give), hash, max_fee_ppm: 20000 })
  const lockAt = Date.now()
  const lock = await post(maker.url + '/v1/btc/lock', { swap: f.body.swap, invoice: r.invoice })
  const locked = Date.now() - lockAt
  const said = []
  let ready = null
  for (let i = 0; i < 1800 && !ready; i++) {
    await T.t('sync').catch(() => {})
    const a = await T.t('lightning_receive_ready', { hash, need_seconds: needSeconds(d.min_final_cltv_expiry ?? 18) }).catch((e) => ({ error: e.message }))
    if (a && a.ready) { ready = Date.now() - lockAt; break }
    const last = said[said.length - 1]
    const w = a && (a.error || a.waiting_for)
    if (!last || last.waiting_for !== w) said.push({ at: Date.now() - lockAt, waiting_for: w, usual_in_seconds: a && a.usual_in_seconds, final_in_seconds: a && a.final_in_seconds })
    await sleep(1000)
  }
  assert.ok(ready != null, 'the leaf bought is ready within 30 minutes: ' + JSON.stringify(said))
  const paid = await ln('pay', { bolt11: f.body.invoice })
  assert.equal(paid.status, 'complete', JSON.stringify(paid))
  await T.t('lightning_post_preimage', { hash, preimage: paid.payment_preimage }).catch((e) => console.log(at(), 'post preimage:', e.message))
  await T.t('lightning_receive_preimage', { hash, preimage: paid.payment_preimage })
  let received = null
  for (let i = 0; i < 300 && received == null; i++) {
    await T.t('sync').catch(() => {})
    const st = ((await T.t('lightning_receives')) || {})[hash] || {}
    if (st.state === 'received') received = Date.now() - lockAt
    else await sleep(1000)
  }
  return { swap: f.body.swap, give, want_sats: f.body.want, lock_ms: locked, lock: lock.body, ready_ms: ready, received_ms: received, said, quote: rq && { fee: rq.fee, claimed: rq.claimed } }
}

test('b: a BTC purchase\'s lock of a few units leaves the maker\'s book offered, through the purchase and the trades after it', { skip: skipCase('b'), timeout: 3_600_000 }, async (tc) => {
  // The two assets every harness serves (its Lightning peer takes no channel in the more assets).
  const { H, st, lwk } = await stack(0)
  if (!(st.lightning && st.btc_lightning && st.btc_lightning.wallets && st.btc_lightning.wallets.length)) return tc.skip('needs the harness\'s Lightning legs and Bitcoin side (ARCA_OPERATOR_LIGHTNING, ARCA_OPERATOR_BTC_LIGHTNING)')
  const X = st.x, M0 = st.y
  const name = (a) => (a === X ? 'X' : a === M0 ? 'Y' : a === 'BTC' ? 'BTC' : a.slice(0, 6))
  // The Lightning harness's node lists X alone for fees: Y at 1:1 too, so that the maker's node
  // prices it (an asset its node does not price is not offered).
  const rates = await H.rpc('getfeeexchangerates')
  if (!rates[M0]) await H.rpc('setfeeexchangerates', [{ ...rates, [M0]: 100000000 }])
  const dir = mkdtempSync(join(tmpdir(), 'maker-btc-b-'))
  const stops = []
  let makerOf = null
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const assets = [X, M0]
    const pairs = []
    for (const g of assets) for (const w of assets) if (g !== w) pairs.push({ give: g, want: w, rate_num: '1', rate_den: '1', min_give: '10000' })
    // The maker gives X for BTC as the drill's desk does: 0.55 sat an atom.
    const btc = { rpc: st.btc_lightning.hub, keep_sats: '200000', invoice_seconds: 3600, pairs: [{ give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }] }
    // A payment over Lightning needs an exit delay longer than the operator's two units for it.
    makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5', exit_delay_units: 3, btc })
    const maker = await launchMaker(H, join(dir, 'maker'), port, assets.map((a) => [a, 1500000]))
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    for (const a of assets) await makerReady(H, maker, a, 300000)
    for (let i = 0; i < 180 && !logLines(maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    await sleep(60000)
    const all = [...pairs.map((p) => [p.give, p.want]), [X, 'BTC']]
    const book = countBook(maker, all, 5000)
    stops.push(() => book.stop())
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 800000], [M0, 800000]], { exit_delay_units: 3 })
    stops.push(() => T.stop())
    const ln = clnRpc(st.btc_lightning.wallets[0])
    const e0 = await explain(maker, 'before the purchases')
    console.log(at(), 'working coin sizes', JSON.stringify(e0 && e0.working_coin_sizes))
    const purchases = [], marks = []
    for (let k = 0; k < 3; k++) {
      marks.push({ k, lock_at: Date.now() - book.t0 })
      const from = maker.log.length
      const p = await btcPurchase(maker, T, ln, X, 20000)
      p.locked_from = logLines(maker, from, /btc locked/).map((l) => l.slice(0, 300))
      purchases.push(p)
      console.log(at(), 'purchase', k + 1, JSON.stringify(p))
      // The trades after it, which on the testnet spent a lock's large change (arca #892, #911).
      for (const [g, w] of [[X, M0], [M0, X]]) console.log(at(), 'trade', name(g) + '->' + name(w), JSON.stringify(await trade(maker, T.t, g, w, 30000, 120)))
      await explain(maker, 'after purchase ' + (k + 1))
      await sleep(240000)
    }
    const r = await book.stop()
    const n = all.length
    console.log('the book (ms, pairs offered of ' + n + '):', JSON.stringify(r))
    for (const m of marks) {
      const w = r.filter(([t]) => t >= m.lock_at && t <= m.lock_at + 300000).map(([, c]) => c)
      console.log(`after lock ${m.k + 1}: ${w.length} readings in 5 min, offered pairs least ${Math.min(...w.filter((c) => c != null))}, most ${Math.max(...w.filter((c) => c != null))}; readings below ${n}: ${w.filter((c) => c != null && c < n).length}`)
    }
    const lines = logLines(maker, 0, /btc locked|settling|own lineage|merging|cutting|offers no|depth|slices/)
    console.log('the maker said:\n' + lines.map((l) => l.slice(0, 300)).join('\n'))
    for (const p of purchases) assert.ok(p.received_ms != null, 'each purchase is received')
    // On the testnet, after each lock 35 of 42 pairs were off for 2.5 to 4 minutes; here no reading
    // from the first lock on has more than one pair off.
    const after = r.filter(([t, c]) => t >= marks[0].lock_at && c != null)
    assert.ok(after.every(([, c]) => c >= n - 1), 'the book stays offered through every lock: ' + JSON.stringify(after.filter(([, c]) => c < n - 1)))
  } finally {
    await dumpMaker(makerOf, 'b')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// A proxy to the operator that holds each request `delayMs` before passing it on, as a distant
// operator does (on the testnet a maker's sync took 14 s): the maker's sync then runs past its
// slices. -> { url, close() }.
async function slowProxy (target, delayMs) {
  const to = new URL(target)
  const held = { ms: delayMs }
  // Every request passed on, as [when it came (ms), its path, the operator's time on it (ms), its
  // status]: what the maker asked of the operator, and when.
  const calls = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    const came = Date.now()
    req.on('data', (d) => chunks.push(d))
    req.on('end', () => setTimeout(() => {
      const sent = Date.now()
      const up = http.request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: { ...req.headers, host: to.host } }, (r) => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res)
        r.on('end', () => calls.push([came, String(req.url).replace(/^.*\/v1\//, '').replace(/\?.*$/, ''), Date.now() - sent, r.statusCode]))
      })
      up.on('error', (e) => { try { res.writeHead(502); res.end(e.message) } catch {} })
      up.end(Buffer.concat(chunks))
    }, held.ms))
  })
  const port = await freePort()
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${port}${to.pathname === '/' ? '' : to.pathname}`, calls, delay: (ms) => { held.ms = ms }, close: () => new Promise((ok) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => ok()) }) }
}

// The maker's `sync in N slices: T ms, the longest S ms` lines as intervals: [start, end, longest] (ms).
const slicePasses = (maker) => maker.log.join('').split('\n').map((l) => l.match(/^(\S+Z) .*\bsync in (\d+) slices: (\d+) ms, the longest (\d+) ms/))
  .filter(Boolean).map((m) => { const end = Date.parse(m[1]); return { start: end - Number(m[3]), end, slices: Number(m[2]), longest: Number(m[4]) } })

test('e: a firm offer asked while the maker syncs is answered within a slice of the sync', { skip: skipCase('e'), timeout: 3_600_000 }, async () => {
  const { H, st, lwk } = await stack()
  const X = st.x, M = st.more[2], P = st.more[1]
  const name = (a) => (a === X ? 'X' : a === M ? 'M2' : a === P ? 'M1' : a.slice(0, 6))
  const dir = mkdtempSync(join(tmpdir(), 'maker-slice-e-'))
  const stops = []
  let makerOf = null
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const pairs = [{ give: M, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: X, want: M, rate_num: '1', rate_den: '1', min_give: '10000' },
      { give: P, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }]
    // The maker reaches the operator through a proxy that holds each request (LEAF_MAKER_OPERATOR_DELAY_MS,
    // 250 ms), so its syncs run for seconds, past their slices, as on the testnet.
    const proxy = await slowProxy(st.server, Number(process.env.LEAF_MAKER_OPERATOR_DELAY_MS || 250))
    stops.push(() => proxy.close())
    const cfg = makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5' })
    writeFileSync(join(dir, 'maker', 'maker.json'), JSON.stringify({ ...cfg, operator: { ...cfg.operator, server: proxy.url } }, null, 2))
    const maker = await launchMaker(H, join(dir, 'maker'), port, [[M, 1500000], [X, 1500000], [P, 1500000]])
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    // The prober, from the maker's start: a firm offer of M1 every second, released at once, each
    // answer timed, an offer or a refusal (an answer is what a taker waits for).
    const probes = []
    let probing = true
    const prober = (async () => {
      while (probing) {
        const asked = Date.now()
        try {
          const f = await post(maker.url + '/v1/firm', { give_asset: P, want_asset: X, give: '10000' })
          probes.push({ asked, ms: Date.now() - asked, status: f.status })
          if (f.status === 200) await post(maker.url + '/v1/release', { swap: f.body.swap }).catch(() => {})
        } catch (e) { probes.push({ asked, ms: Date.now() - asked, error: e.message }) }
        await sleep(1000)
      }
    })()
    stops.push(async () => { probing = false; await prober })
    for (const a of [M, X, P]) await makerReady(H, maker, a, 300000)
    for (let i = 0; i < 180 && !logLines(maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 800000], [M, 800000]])
    stops.push(() => T.stop())
    // Trades on M2 and X, whose settles give the maker's sync rounds to follow.
    for (let i = 0; i < 16; i++) {
      const [g, w] = i % 2 ? [X, M] : [M, X]
      // The taker's own coins can be in a round: it says so and goes on (this case times the maker).
      try { console.log(at(), 'trade', i + 1, name(g) + '->' + name(w), JSON.stringify(await trade(maker, T.t, g, w, 50000, 120))) } catch (e) { console.log(at(), 'trade', i + 1, 'taker:', e.message.slice(0, 160)) }
      if (i % 2 === 1) await refreshChange(H, T)
    }
    await sleep(120000)
    probing = false; await prober
    const passes = slicePasses(maker)
    const during = probes.filter((p) => p.status).map((p) => ({ ...p, pass: passes.find((x) => p.asked >= x.start && p.asked <= x.end) })).filter((p) => p.pass)
    const outside = probes.filter((p) => p.status && !passes.some((x) => p.asked >= x.start && p.asked <= x.end)).map((p) => p.ms).sort((a, b) => a - b)
    const q = (v, f) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : null)
    console.log(`passes in slices: ${passes.length}; their time in all, most ${Math.max(0, ...passes.map((x) => x.end - x.start))} ms; the longest slice ${Math.max(0, ...passes.map((x) => x.longest))} ms; slices most ${Math.max(0, ...passes.map((x) => x.slices))}`)
    console.log(`firm offers: ${probes.length} asked, ${probes.filter((p) => p.status === 200).length} answered with an offer, ${probes.filter((p) => p.status && p.status !== 200).length} refused; outside a pass p50 ${q(outside, 0.5)} ms, p95 ${q(outside, 0.95)}, most ${outside[outside.length - 1] ?? null}`)
    console.log('asked during a pass in slices [ms, its pass in all, its longest slice]:', JSON.stringify(during.map((p) => [p.ms, p.pass.end - p.pass.start, p.pass.longest])))
    console.log('refused or failed:', JSON.stringify(probes.filter((p) => p.status !== 200).slice(0, 20)))
    assert.ok(during.length > 0, 'some firm offers were asked during a sync in slices')
    // Answered within one slice of the pass and its own run, never after the whole pass.
    const late = during.filter((p) => p.ms > p.pass.longest + (q(outside, 0.95) ?? 1000) + 500)
    assert.deepEqual(late.map((p) => [p.ms, p.pass.end - p.pass.start, p.pass.longest]), [], 'each answered within a slice')
  } finally {
    await dumpMaker(makerOf, 'e')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// A maker of a large store (f). The maker's store is made first: X and Y boarded as one coin of
// 8,000,000 each, each refreshed into fourteen pieces and a reserve, and each of those into
// fourteen pieces and a reserve again (225 coins of each asset), and ten of each asset's smallest
// into fourteen more (some 730 live coins in all); `max_coins` keeps the maker from merging them.
test('f: a maker of a large store answers within a slice, and its upkeep waits on no pass without bound', { skip: skipCase('f'), timeout: 10_800_000 }, async (tc) => {
  const { H, st, lwk } = await stack(0)
  if (!(st.lightning && st.btc_lightning && st.btc_lightning.wallets && st.btc_lightning.wallets.length)) return tc.skip('needs the harness\'s Lightning legs and Bitcoin side (ARCA_OPERATOR_LIGHTNING, ARCA_OPERATOR_BTC_LIGHTNING)')
  const X = st.x, Y = st.y
  const name = (a) => (a === X ? 'X' : a === Y ? 'Y' : a === 'BTC' ? 'BTC' : a.slice(0, 6))
  const rates = await H.rpc('getfeeexchangerates')
  if (!rates[Y]) await H.rpc('setfeeexchangerates', [{ ...rates, [Y]: 100000000 }])
  const dir = mkdtempSync(join(tmpdir(), 'maker-large-f-'))
  const stops = []
  let makerOf = null
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const assets = [X, Y]
    const pairs = []
    for (const g of assets) for (const w of assets) if (g !== w) pairs.push({ give: g, want: w, rate_num: '1', rate_den: '1', min_give: '10000' })
    const btc = { rpc: st.btc_lightning.hub, keep_sats: '200000', invoice_seconds: 3600, pairs: [{ give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }] }
    const delay = Number(process.env.LEAF_MAKER_OPERATOR_DELAY_MS || 250)
    const proxy = await slowProxy(st.server, 0)
    stops.push(() => proxy.close())
    const boundMs = 300000
    // Its command times every minute (`times`): how long each of the upkeep's commands waited in the
    // queue.
    const cfg = makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5', exit_delay_units: 3, btc, max_coins: 2000,
      sync_pass_bound_ms: boundMs, times_seconds: 60 })
    writeFileSync(join(dir, 'maker', 'maker.json'), JSON.stringify({ ...cfg, operator: { ...cfg.operator, server: proxy.url } }, null, 2))
    // The store, through the proxy (no delay while it is made).
    const seed = await wallet(H, st, lwk, cfg.store_dir, mnemonic, [[X, 8000000], [Y, 8000000]], { server: proxy.url, exit_delay_units: 3 })
    const live = async () => { await seed.t('sync').catch(() => {}); return (await seed.t('coins')).filter((c) => c.state === 'live') }
    const split = async (coins, piece) => {
      for (const c of coins) {
        const args = { leaves: [c.leaf_id], piece: String(piece), pieces: 14 }
        const q = await seed.t('quote', args)
        await seed.t('participate', { ...args, shown: q.coins })
      }
      const want = (await live()).length + coins.length * 14
      for (let i = 0; i < 300; i++) { await H.pump().catch(() => {}); if ((await live()).length >= want) break; await sleep(1000) }
    }
    const value = (c) => BigInt(c.value)
    await split(await live(), 500000)
    await split(await live(), 30000)
    const small = (await live()).filter((c) => value(c) === 30000n)
    await split(assets.flatMap((a) => small.filter((c) => c.asset === a).slice(0, 10)), 2000)
    const made = await live()
    console.log(at(), 'the maker\'s store:', made.length, 'live coins:', assets.map((a) => name(a) + ' ' + made.filter((c) => c.asset === a).length).join(', '))
    assert.ok(made.length >= 600, 'a store as large as a busy maker\'s: ' + made.length)
    await seed.stop()
    proxy.delay(delay)
    const maker = await launchMaker(H, join(dir, 'maker'), port, null)
    maker.url = `http://127.0.0.1:${port}`
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    // A firm offer and its release cost the library seconds on a store this large (each command's
    // start re-checks every coin), and go ahead of the upkeep: asked every second they would hold
    // the library from the upkeep for good. One every LEAF_MAKER_PROBE_MS (15 s), as takers come.
    const probeMs = Number(process.env.LEAF_MAKER_PROBE_MS || 15000)
    const probes = []
    let probing = true
    const prober = (async () => {
      while (probing) {
        const asked = Date.now()
        try {
          const f = await post(maker.url + '/v1/firm', { give_asset: Y, want_asset: X, give: '10000' })
          probes.push({ asked, ms: Date.now() - asked, status: f.status })
          if (f.status === 200) await post(maker.url + '/v1/release', { swap: f.body.swap }).catch(() => {})
        } catch (e) { probes.push({ asked, ms: Date.now() - asked, error: e.message }) }
        await sleep(probeMs)
      }
    })()
    stops.push(async () => { probing = false; await prober })
    for (const a of assets) await makerReady(H, maker, a, 300000)
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 800000], [Y, 800000]], { exit_delay_units: 3 })
    stops.push(() => T.stop())
    const ln = clnRpc(st.btc_lightning.wallets[0])
    // Trades both ways (the maker settles what it receives, settle_seconds 30), and purchases with
    // BTC between them.
    // Takers come one every LEAF_MAKER_TRADE_GAP_MS (20 s): back to back, each command costing the
    // library seconds on this store and going ahead of the upkeep, they would hold it for minutes.
    const gapMs = Number(process.env.LEAF_MAKER_TRADE_GAP_MS || 20000)
    const purchases = []
    for (let k = 0; k < 2; k++) {
      for (const [g, w] of [[X, Y], [Y, X], [X, Y]]) {
        try { console.log(at(), 'trade', name(g) + '->' + name(w), JSON.stringify(await trade(maker, T.t, g, w, 30000, 120))) } catch (e) { console.log(at(), 'trade taker:', e.message.slice(0, 160)) }
        await sleep(gapMs)
      }
      await refreshChange(H, T)
      const p = await btcPurchase(maker, T, ln, X, 20000)
      purchases.push(p)
      console.log(at(), 'purchase', k + 1, JSON.stringify({ lock_ms: p.lock_ms, ready_ms: p.ready_ms, received_ms: p.received_ms }))
    }
    await sleep(180000)
    probing = false; await prober
    const passes = slicePasses(maker)
    const during = probes.filter((p) => p.status).map((p) => ({ ...p, pass: passes.find((x) => p.asked >= x.start && p.asked <= x.end) })).filter((p) => p.pass)
    const outside = probes.filter((p) => p.status && !passes.some((x) => p.asked >= x.start && p.asked <= x.end)).map((p) => p.ms).sort((a, b) => a - b)
    const q = (v, f) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : null)
    // The longest wait in the queue of each of the upkeep's own commands (not the sync's, not a
    // taker's), over the `times` lines.
    const TAKERS = new Set(['sync', 'deposits', 'swap_offer', 'swap_complete', 'swap_cancel', 'swap_read', 'lightning_pay', 'lightning_pay_quote', 'hand_over_forfeits'])
    const waited = {}
    for (const l of logLines(maker, 0, / times \{/)) {
      for (const [k, v] of Object.entries(JSON.parse(l.slice(l.indexOf('times ') + 6)))) if (!TAKERS.has(k)) waited[k] = Math.max(waited[k] || 0, v.waited_max || 0)
    }
    const errors = logLines(maker, 0, /\berror: /)
    const settles = logLines(maker, 0, /settling \d+ received coins/)
    console.log(`passes in slices: ${passes.length}; their time in all, most ${Math.max(0, ...passes.map((x) => x.end - x.start))} ms; the longest slice ${Math.max(0, ...passes.map((x) => x.longest))} ms; slices most ${Math.max(0, ...passes.map((x) => x.slices))}`)
    console.log(`the upkeep's commands, the longest wait in the queue of each: ${JSON.stringify(waited)}; errors: ${errors.length}; settles: ${settles.length}`)
    console.log(`firm offers: ${probes.length} asked, ${probes.filter((p) => p.status === 200).length} answered with an offer; outside a pass p50 ${q(outside, 0.5)} ms, p95 ${q(outside, 0.95)}, most ${outside[outside.length - 1] ?? null}; during a pass most ${Math.max(0, ...during.map((p) => p.ms))} ms (${during.length})`)
    console.log('purchases:', JSON.stringify(purchases.map((p) => ({ lock_ms: p.lock_ms, ready_ms: p.ready_ms, received_ms: p.received_ms }))))
    console.log('the maker said:\n' + logLines(maker, 0, /slices|error|settling|btc/).map((l) => l.slice(0, 300)).join('\n'))
    const longest = Math.max(0, ...passes.map((x) => x.longest))
    // Each firm offer during a pass answered within a slice and its own run.
    const late = during.filter((p) => p.ms > p.pass.longest + (q(outside, 0.95) ?? 1000) + 500)
    assert.deepEqual(late.map((p) => [p.ms, p.pass.end - p.pass.start, p.pass.longest]), [], 'each answered within a slice')
    // No pass past its bound.
    assert.deepEqual(errors, [], 'no pass past its bound')
    // Every purchase received, and the coins the maker received settled.
    for (const p of purchases) assert.ok(p.received_ms != null, 'each purchase is received')
    assert.ok(settles.length > 0, 'the maker settled the coins it received')
  } finally {
    await dumpMaker(makerOf, 'f')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// The store of a busy maker (g): X and Y boarded as one coin of 8,000,000 each, each refreshed
// into fourteen pieces and a reserve, each of those into fourteen again, and twelve of each asset's
// smallest into fourteen more (some 760 live coins). Made through `server` (the proxy, no delay
// while it is made). -> the live coins.
async function largeStore (H, st, lwk, storeDir, mnemonic, server, assets) {
  const seed = await wallet(H, st, lwk, storeDir, mnemonic, assets.map((a) => [a, 8000000]), { server, exit_delay_units: 3 })
  const live = async () => { await seed.t('sync').catch(() => {}); return (await seed.t('coins')).filter((c) => c.state === 'live') }
  const split = async (coins, piece) => {
    for (const c of coins) {
      const args = { leaves: [c.leaf_id], piece: String(piece), pieces: 14 }
      const q = await seed.t('quote', args)
      await seed.t('participate', { ...args, shown: q.coins })
    }
    const want = (await live()).length + coins.length * 14
    for (let i = 0; i < 300; i++) { await H.pump().catch(() => {}); if ((await live()).length >= want) break; await sleep(1000) }
  }
  await split(await live(), 500000)
  await split(await live(), 30000)
  const small = (await live()).filter((c) => BigInt(c.value) === 30000n)
  await split(assets.flatMap((a) => small.filter((c) => c.asset === a).slice(0, 12)), 2000)
  const made = await live()
  await seed.stop()
  return made
}

// The history a long-running maker's store holds beside its coins, as the testnet's main maker's
// held it (read from its store file: 2,089 participations the operator refused, each giving up 53
// coins on average with a body of 13.7 kB, from a library that gave up more than 16 coins in one;
// 6,264 void ones, 2.6 coins and 2.3 kB each; 43 expired). The library reads these rows (the coins
// whose refresh was refused) in its sync and its schedule. They are written into a store the
// harness made (its coins, the given lists naming them), with the maker stopped, by
// `storeHistory`. LEAF_MAKER_STORE_HISTORY: 'main' for this shape, or a JSON of the same form.
export const MAIN_MAKER_HISTORY = Object.freeze({ refused: { n: 2089, given: 53, body: 13738 }, void: { n: 6264, given: 2.6, body: 2345 },
  expired: { n: 43, given: 2, body: 2450 } })
// The same of the testnet's two other leaf makers ('agents', 'btc' in LEAF_MAKER_STORE_HISTORY).
export const MAKER_HISTORIES = Object.freeze({ main: MAIN_MAKER_HISTORY,
  agents: { refused: { n: 156, given: 3, body: 1384 }, void: { n: 2068, given: 8.2, body: 2549 } },
  btc: { refused: { n: 68, given: 2.8, body: 1336 }, void: { n: 448, given: 8.5, body: 2628 } } })
const historyOf = (v) => MAKER_HISTORIES[v] || JSON.parse(v)
export async function storeHistory (storeDir, shape) {
  const { readdirSync, readFileSync, writeFileSync, statSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const opaque = join(storeDir, '.leaf-wallet', '.opaque')
  const HEADER = 4096
  const file = readdirSync(opaque).map((n) => join(opaque, n)).filter((f) => {
    const b = readFileSync(f); return b.length > HEADER + 16 && b.subarray(HEADER, HEADER + 15).toString() === 'SQLite format 3'
  }).sort((a, b) => statSync(b).size - statSync(a).size)[0]
  if (!file) throw new Error('no store file in ' + opaque)
  const img = readFileSync(file)
  const tmp = file + '.history.db'
  writeFileSync(tmp, img.subarray(HEADER))
  const db = new DatabaseSync(tmp)
  const coins = db.prepare('SELECT leaf_id FROM coin ORDER BY created_at').all().map((r) => r.leaf_id)
  const add = db.prepare("INSERT INTO participation (id, body, given, wanted, state, created_at) VALUES (?, ?, ?, '[]', ?, ?)")
  let k = 0, made = 0
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN')
  for (const [state, s] of Object.entries(shape)) {
    for (let i = 0; i < s.n; i++) {
      // A whole number of coins, the mean over the rows `given`.
      const n = Math.max(1, Math.floor((i + 1) * s.given) - Math.floor(i * s.given))
      const given = []
      for (let j = 0; j < n; j++) given.push(coins[(k++) % coins.length])
      const id = createHash('sha256').update(`history ${state} ${i}`).digest('hex')
      add.run(id, JSON.stringify({ history: 'x'.repeat(Math.max(0, s.body - 14)) }), JSON.stringify(given), state, now - 86400 * 7 + made)
      made++
    }
  }
  db.exec('COMMIT')
  db.close()
  writeFileSync(file, Buffer.concat([img.subarray(0, HEADER), readFileSync(tmp)]))
  rmSync(tmp, { force: true })
  return { participations: made, coins: coins.length }
}

// One sale of an asset for BTC, as the page makes it (user-trade-btc.js, selling): the wallet's
// Bitcoin invoice for `sats`, the maker's firm offer under its hash (`give_asset` BTC), the wallet's
// leaf paying the operator's invoice for the asset, and the nudge (`/v1/btc/paid`). Then followed as
// the page follows it: the BTC on the wallet's invoice is "Received", and once the wallet's payment
// of the asset is settled with the preimage (the maker's claim, or the wallet's own hand-over of the
// preimage, which the operator refuses while the maker's leaf is still being made) it is "Settled".
// -> the times of each step (ms after the firm offer was asked).
async function btcSale (maker, T, ln, asset, sats, boundMs) {
  const t0 = Date.now()
  const label = `sale-${t0}-${Math.random().toString(16).slice(2, 8)}`
  const inv = await ln('invoice', { amount_msat: sats * 1000, label, description: 'trade', expiry: 3600 })
  const f = await post(maker.url + '/v1/btc/firm', { give_asset: 'BTC', want_asset: asset, give: String(sats), invoice: inv.bolt11 })
  const offerMs = Date.now() - t0
  if (f.status !== 200) return { offer_ms: offerMs, refused: JSON.stringify(f.body).slice(0, 200) }
  const q = await T.t('lightning_pay_quote', { invoice: f.body.invoice, asset })
  assert.equal(q.payment_hash, inv.payment_hash, 'the maker\'s invoice is under the wallet\'s hash')
  const r = await T.t('lightning_pay', { invoice: f.body.invoice, asset, shown: q })
  const sentMs = Date.now() - t0
  post(maker.url + '/v1/btc/paid', { swap: f.body.swap }).catch(() => {})
  let received = null, settled = null, preimage = null, posted = 0
  const refusals = new Set()
  while (Date.now() - t0 < boundMs * 3) {
    await T.t('sync').catch(() => {})
    if (received == null) {
      const i = ((await ln('listinvoices', { label })).invoices || [])[0] || {}
      if (i.status === 'paid') { received = Date.now() - t0; preimage = i.payment_preimage }
    }
    if (received != null) {
      const p = ((await T.t('lightning_payments')) || {})[inv.payment_hash] || {}
      if (p.state === 'paid') { settled = Date.now() - t0; break }
      try { await T.t('lightning_post_preimage', { hash: inv.payment_hash, preimage }); posted++ } catch (e) { refusals.add(String(e.message).slice(0, 120)) }
    }
    await sleep(2000)
  }
  return { swap: f.body.swap, sats, give: f.body.want, change: r.change || '0', offer_ms: offerMs, sent_ms: sentMs, received_ms: received, settled_ms: settled,
    preimage_posts: posted, preimage_refusals: [...refusals] }
}

// The maker's passes of its sync, from its own records: each `sync pass {n, start, end, ms, slices,
// library, longest}` line the maker logs as a pass ends, with the operator calls its slices made
// (`slow sync` lines, logged for every command at `slow_ms` 1). -> [{ start, end, ms, slices,
// longest, library, operator }]
function syncPasses (maker) {
  const lines = maker.log.join('').split('\n')
  const slices = lines.map((l) => l.match(/^(\S+Z) slow sync (\d+) ms (\{.*\})$/)).filter(Boolean).map((m) => {
    let c = {}; try { c = JSON.parse(m[3]).cost || {} } catch {}
    return { end: Date.parse(m[1]), operator: ((c.command && c.command.operator) || 0) + ((c.start && c.start.operator) || 0) }
  })
  return passRecords(maker, 'sync').map((p) => ({ ...p, operator: slices.filter((x) => x.end >= p.start && x.end <= p.end + 50).reduce((n, x) => n + x.operator, 0) }))
}
// The maker's own records of the passes of one of its loops (`sync` or `upkeep`), in order.
function passRecords (maker, loop) {
  return maker.log.join('').split('\n').map((l) => l.match(new RegExp('^\\S+Z ' + loop + ' pass (\\{.*\\})$'))).filter(Boolean)
    .map((m) => JSON.parse(m[1])).sort((a, b) => a.start - b.start)
}
// The passes overlapping [from, to]: a pass that crosses the window's edge counts in it.
const overlapping = (passes, from, to) => passes.filter((p) => p.end >= from && p.start <= to)
// The gaps between the ends of the passes overlapping [from, to], and the last one up to `to` (the
// gap still open when the window ends).
function gapsIn (passes, from, to) {
  const ends = passes.map((p) => p.end).filter((e) => e <= to)
  const g = []
  for (let i = 1; i < ends.length; i++) if (ends[i] >= from) g.push(ends[i] - ends[i - 1])
  if (ends.length) g.push(to - ends[ends.length - 1])
  return g
}
const stats = (v) => {
  const s = [...v].sort((a, b) => a - b)
  const q = (f) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : null)
  return { n: s.length, p50: q(0.5), p95: q(0.95), most: s.length ? s[s.length - 1] : null }
}

// A maker of a large store through an hour of trades (g), as the testnet's makers run: the store as
// f makes it, the operator behind a proxy at the box's link (LEAF_MAKER_OPERATOR_DELAY_MS, 140 ms: a
// maker there reaches its operator through the public address), the BTC desk as the BTC maker's
// (both ways, paying a small purchase on the operator's acceptance), `sync_seconds` 20 and
// `settle_seconds` 600 as the box's, and slices of LEAF_MAKER_SLICE_MS (1000; 0, whole syncs). The
// sync's passes are read alone first (LEAF_MAKER_QUIET_MINUTES, 5), then for
// LEAF_MAKER_TRADE_MINUTES (60): a firm offer every LEAF_MAKER_PROBE_MS (15 s), a trade every
// LEAF_MAKER_TRADE_GAP_MS (20 s), and a sale of X for BTC every tenth of the time (ten sales). The
// box's busiest maker made four swap offers in ten minutes (2026-11-15): 60 s and 120 s are some
// three times that, the defaults some twenty times. Read: each pass of the sync (time, slices, the longest slice,
// operator calls), the upkeep's period and its longest gap (`/health`, read every 2 s), each firm
// offer's answer during a pass and outside one, each sale from its offer to Received and Settled,
// and every call the maker made of the operator by path (the proxy). The figures go to
// LEAF_MAKER_FIGURES (a path) as JSON. LEAF_MAKER_SCRIPT runs another checkout's maker on the same
// case. It passes when no upkeep gap and no pass is past `sync_pass_bound_ms`, every sale is
// Settled within SALE_SETTLED_MS of its offer, and the firm offers asked during a pass are answered
// in FIRM_DURING_P50_MS at the median. LEAF_MAKER_OPERATOR_BUILD names the operator's build in the
// figures (a debug build answers `holding_back` several times slower than a release one).
const SALE_SETTLED_MS = 10 * 60_000
const FIRM_DURING_P50_MS = 5000
test('g: a maker of a large store through an hour of trades: its upkeep, its sync, and ten sales for BTC', { skip: skipCase('g'), timeout: 4 * 3_600_000 }, async (tc) => {
  const { H, st, lwk } = await stack(0)
  if (!(st.lightning && st.btc_lightning && st.btc_lightning.wallets && st.btc_lightning.wallets.length)) return tc.skip('needs the harness\'s Lightning legs and Bitcoin side (ARCA_OPERATOR_LIGHTNING, ARCA_OPERATOR_BTC_LIGHTNING)')
  const X = st.x, Y = st.y
  const name = (a) => (a === X ? 'X' : a === Y ? 'Y' : a === 'BTC' ? 'BTC' : a.slice(0, 6))
  const rates = await H.rpc('getfeeexchangerates')
  if (!rates[Y]) await H.rpc('setfeeexchangerates', [{ ...rates, [Y]: 100000000 }])
  const dir = mkdtempSync(join(tmpdir(), 'maker-large-g-'))
  const stops = []
  let makerOf = null
  const env = (k, d) => Number(process.env[k] ?? d)
  const sliceMs = env('LEAF_MAKER_SLICE_MS', 1000), delay = env('LEAF_MAKER_OPERATOR_DELAY_MS', 140)
  const quietMin = env('LEAF_MAKER_QUIET_MINUTES', 5), tradeMin = env('LEAF_MAKER_TRADE_MINUTES', 60)
  const probeMs = env('LEAF_MAKER_PROBE_MS', 15000), gapMs = env('LEAF_MAKER_TRADE_GAP_MS', 20000)
  const boundMs = 300000
  // How often the chain moves on (a round built, a block made and buried): every 2 s by default;
  // LEAF_MAKER_PUMP_MS 60000 is the testnet's block spacing, where most commands find the tip their
  // last re-check ran at and re-check only the lineages.
  const pumpMs = env('LEAF_MAKER_PUMP_MS', 2000)
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const assets = [X, Y]
    const pairs = []
    for (const g of assets) for (const w of assets) if (g !== w) pairs.push({ give: g, want: w, rate_num: '1', rate_den: '1', min_give: '10000' })
    const btc = { rpc: st.btc_lightning.hub, keep_sats: '20000', invoice_seconds: 3600, max_route_fee_sats: '1000',
      unfinal_max_sats: '50000', unfinal_total_sats: '500000', unfinal_window_seconds: 7200,
      pairs: [{ give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }, { give: 'BTC', want: X, rate_num: '20', rate_den: '11', min_give: '5000' }] }
    const proxy = await slowProxy(st.server, 0)
    stops.push(() => proxy.close())
    const cfg = makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5', exit_delay_units: 3, btc, max_coins: 2000,
      sync_seconds: 20, settle_seconds: 600, slice_ms: sliceMs, sync_pass_bound_ms: boundMs, times_seconds: 60, slow_ms: 1 })
    writeFileSync(join(dir, 'maker', 'maker.json'), JSON.stringify({ ...cfg, operator: { ...cfg.operator, server: proxy.url } }, null, 2))
    const made = await largeStore(H, st, lwk, cfg.store_dir, mnemonic, proxy.url, assets)
    console.log(at(), 'the maker\'s store:', made.length, 'live coins:', assets.map((a) => name(a) + ' ' + made.filter((c) => c.asset === a).length).join(', '))
    assert.ok(made.length >= 720, 'a store as large as the testnet\'s makers\': ' + made.length)
    // The history of a long-running maker's store, written in with the store closed (storeHistory).
    const historyShape = process.env.LEAF_MAKER_STORE_HISTORY
    if (historyShape) console.log(at(), 'history written into the maker\'s store:',
      JSON.stringify(await storeHistory(cfg.store_dir, historyOf(historyShape))))
    proxy.delay(delay)
    const callsFrom = proxy.calls.length
    const maker = await launchMaker(H, join(dir, 'maker'), port, null)
    maker.url = `http://127.0.0.1:${port}`
    makerOf = maker
    stops.push(() => maker.stop())
    const started = Date.now()
    const stopPump = pumpLoop(H, pumpMs); stops.push(stopPump)
    // The upkeep's and the sync's records, every 2 s.
    const health = []
    let watching = true
    const watcher = (async () => { while (watching) { try { health.push({ at: Date.now(), ...(await getJson(maker.url + '/health')) }) } catch {} await sleep(2000) } })()
    stops.push(async () => { watching = false; await watcher })
    for (const a of assets) await makerReady(H, maker, a, 300000)
    console.log(at(), 'the maker quotes; its passes read alone for', quietMin, 'min')
    await sleep(quietMin * 60_000)
    const quietEnd = Date.now()
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 3000000], [Y, 800000]], { exit_delay_units: 3 })
    stops.push(() => T.stop())
    // The taker's coins in pieces, as a wallet that trades holds them: its sales and its trades run
    // side by side, each paying from a coin of its own.
    {
      const coins = (await T.t('coins')).filter((c) => c.state === 'live')
      for (const [a, piece] of [[X, 200000], [Y, 100000]]) {
        const c = coins.find((x) => x.asset === a)
        const args = { leaves: [c.leaf_id], piece: String(piece), pieces: a === X ? 14 : 7 }
        const q = await T.t('quote', args)
        await T.t('participate', { ...args, shown: q.coins })
      }
      for (let i = 0; i < 300; i++) { await H.pump().catch(() => {}); await T.t('sync').catch(() => {}); if ((await T.t('coins')).filter((c) => c.state === 'live').length >= 20) break; await sleep(1000) }
      console.log(at(), 'the taker holds', (await T.t('coins')).filter((c) => c.state === 'live').length, 'live coins')
    }
    const ln = clnRpc(st.btc_lightning.wallets[0])
    // A firm offer every 15 s, released at once.
    const probes = []
    let probing = true
    const prober = (async () => {
      while (probing) {
        const asked = Date.now()
        try {
          const f = await post(maker.url + '/v1/firm', { give_asset: Y, want_asset: X, give: '10000' })
          probes.push({ asked, ms: Date.now() - asked, status: f.status })
          if (f.status === 200) await post(maker.url + '/v1/release', { swap: f.body.swap }).catch(() => {})
        } catch (e) { probes.push({ asked, ms: Date.now() - asked, error: e.message }) }
        await sleep(probeMs)
      }
    })()
    stops.push(async () => { probing = false; await prober })
    const tradeStart = Date.now()
    const callsTrading = proxy.calls.length
    const sales = [], trades = []
    const salesRunning = []
    const every = tradeMin * 60_000 / 10
    for (let k = 0; k < 10; k++) {
      const due = tradeStart + k * every
      salesRunning.push(btcSale(maker, T, ln, X, 11000, SALE_SETTLED_MS).then((s) => { s.k = k + 1; s.at = due - tradeStart; sales.push(s); console.log(at(), 'sale', k + 1, JSON.stringify(s)) },
        (e) => { sales.push({ k: k + 1, error: e.message.slice(0, 200) }); console.log(at(), 'sale', k + 1, 'error:', e.message.slice(0, 200)) }))
      for (let i = 0; Date.now() < due + every; i++) {
        const [g, w] = i % 2 ? [Y, X] : [X, Y]
        try { const t = await trade(maker, T.t, g, w, 30000, 20); trades.push(t); console.log(at(), 'trade', name(g) + '->' + name(w), JSON.stringify(t)) } catch (e) { trades.push({ error: e.message.slice(0, 160) }); console.log(at(), 'trade taker:', e.message.slice(0, 160)) }
        // The taker's change, refreshed every sixth trade, as a wallet's upkeep keeps it under the
        // operator's depth limit.
        if (i % 6 === 5) await refreshChange(H, T)
        await sleep(Math.max(0, Math.min(gapMs, due + every - Date.now())))
      }
    }
    const tradeEnd = Date.now()
    await Promise.all(salesRunning)
    probing = false; await prober
    watching = false; await watcher
    // The figures.
    const passes = syncPasses(maker), upkeeps = passRecords(maker, 'upkeep')
    const quiet = overlapping(passes, started, quietEnd)
    const busy = overlapping(passes, tradeStart, tradeEnd)
    const inPass = (t) => passes.find((x) => t >= x.start && t <= x.end)
    const during = probes.filter((p) => p.status && inPass(p.asked)), outside = probes.filter((p) => p.status && !inPass(p.asked))
    const lastHealth = health[health.length - 1] || {}
    const pick = (p) => ({ ms: p.ms, slices: p.slices, longest: p.longest, library: p.library, operator: p.operator })
    const hours = (tradeEnd - tradeStart) / 3_600_000
    const offersMade = probes.filter((p) => p.status === 200).length + trades.filter((t) => t.ms != null && !t.refused).length + sales.filter((x) => x.swap).length
    const byPath = (from, to) => {
      const m = {}
      for (const [t, path, ms, code] of proxy.calls.slice(callsFrom)) {
        if (t < from || t > to) continue
        const e = m[path] || (m[path] = { calls: 0, ms: 0, failed: 0 }); e.calls++; e.ms += ms; if (code >= 400) e.failed++
      }
      return m
    }
    const figures = {
      settings: { operator_build: process.env.LEAF_MAKER_OPERATOR_BUILD || null, history: process.env.LEAF_MAKER_STORE_HISTORY || null, slice_ms: sliceMs, pump_ms: pumpMs, operator_delay_ms: delay, probe_ms: probeMs, trade_gap_ms: gapMs, sync_seconds: 20, bound_ms: boundMs, maker: process.env.LEAF_MAKER_SCRIPT || 'this checkout', library: PKG },
      store: { live: made.length, X: made.filter((c) => c.asset === X).length, Y: made.filter((c) => c.asset === Y).length },
      quiet: { minutes: quietMin, passes: quiet.map(pick), ms: stats(quiet.map((p) => p.ms)), library: stats(quiet.map((p) => p.library)), operator: stats(quiet.map((p) => p.operator)) },
      trading: { minutes: (tradeEnd - tradeStart) / 60000, passes: busy.length, ms: stats(busy.map((p) => p.ms)), library: stats(busy.map((p) => p.library)),
        slices: stats(busy.map((p) => p.slices)), longest_slice: stats(busy.map((p) => p.longest)), operator: stats(busy.map((p) => p.operator)),
        // A pass still under way when the run ends, from /health.
        under_way_at_end_ms: lastHealth.sync ? lastHealth.sync.under_way_ms : null },
      upkeep: { gaps: stats(gapsIn(upkeeps, tradeStart, tradeEnd)), library: stats(overlapping(upkeeps, tradeStart, tradeEnd).map((p) => p.library)), last: lastHealth.upkeep || null },
      sync: { gaps: stats(gapsIn(passes, tradeStart, tradeEnd)), last: lastHealth.sync || null },
      health: { not_ok: health.filter((h) => h.ok === false).length, readings: health.length },
      // The records parsed against the maker's own count of its passes (/health at the end).
      records: { sync: passes.length, sync_health: lastHealth.sync ? lastHealth.sync.passes : null, upkeep: upkeeps.length, upkeep_health: lastHealth.upkeep ? lastHealth.upkeep.passes : null },
      workload: { firm_offers_made: offersMade, per_hour: hours > 0 ? Math.round(offersMade / hours) : null },
      firm: { asked: probes.length, offers: probes.filter((p) => p.status === 200).length, during: stats(during.map((p) => p.ms)), outside: stats(outside.map((p) => p.ms)) },
      trades: { made: trades.filter((t) => t.ms != null && !t.refused).length, refused: trades.filter((t) => t.refused).length, failed: trades.filter((t) => t.error).length,
        firm_ms: stats(trades.filter((t) => t.ms != null).map((t) => t.ms)) },
      sales: sales.sort((a, b) => a.k - b.k),
      sale_settled: stats(sales.filter((s) => s.settled_ms != null).map((s) => s.settled_ms)),
      sale_received: stats(sales.filter((s) => s.received_ms != null).map((s) => s.received_ms)),
      operator_calls_trading: byPath(tradeStart, tradeEnd),
      errors: logLines(maker, 0, /\berror: /).map((l) => l.slice(0, 300)),
    }
    console.log('figures:', JSON.stringify(figures, null, 1))
    if (process.env.LEAF_MAKER_FIGURES) writeFileSync(process.env.LEAF_MAKER_FIGURES, JSON.stringify({ figures, health, probes, calls: proxy.calls.slice(callsFrom) }, null, 1))
    assert.equal(sales.length, 10, 'ten sales')
    assert.deepEqual(sales.filter((s) => !(s.settled_ms <= SALE_SETTLED_MS)).map((s) => [s.k, s.received_ms, s.settled_ms, s.refused || s.error || null]), [], 'every sale Settled within ' + SALE_SETTLED_MS + ' ms of its offer')
    assert.equal(figures.records.sync, figures.records.sync_health, 'one record a sync pass, as /health counts them')
    assert.equal(figures.records.upkeep, figures.records.upkeep_health, 'one record an upkeep pass, as /health counts them')
    assert.ok((figures.upkeep.gaps.most ?? Infinity) <= boundMs, 'no gap of the upkeep past the bound, the last one open included: ' + figures.upkeep.gaps.most)
    assert.ok((figures.sync.gaps.most ?? Infinity) <= boundMs, 'no gap between two sync passes past the bound: ' + figures.sync.gaps.most)
    assert.equal(figures.health.not_ok, 0, 'the maker never stopped quoting')
    assert.deepEqual(figures.errors, [], 'no pass past its bound')
    // A person's firm offer asked during a pass waits for no slice it does not need.
    assert.ok((figures.firm.during.p50 ?? 0) <= FIRM_DURING_P50_MS, 'firm offers during a pass p50 within ' + FIRM_DURING_P50_MS + ' ms: ' + figures.firm.during.p50)
  } finally {
    await dumpMaker(makerOf, 'g')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})

// A pass's time, library against library (s): the store g makes, with the participation history of
// one of the testnet's makers written in (LEAF_MAKER_STORE_HISTORY: main, agents or btc; main by
// default), the operator behind the box's link (140 ms). The maker's service is not started: its
// one-shot `--pass-time` runs passes of its sync on the store, in a process of its own for each
// library in turn (this checkout's, LEAVES_PKG, and LEAF_MAKER_OLD_PKG), whole passes then passes in
// slices of a second (LEAF_MAKER_S_ROUNDS more rounds of one each, in turn), each run cut at
// LEAF_MAKER_PASS_LIMIT_MS (600 s) and said so; `--size` sizes the
// store. The figures go to LEAF_MAKER_FIGURES. It passes when this library's passes are no slower than
// the other's (within a tenth), whole and in slices, and its passes in slices end within the bound.
test('s: a pass\'s time on a store with a maker\'s history, library against library', { skip: skipCase('s'), timeout: 4 * 3_600_000 }, async () => {
  const { H, st, lwk } = await stack(0)
  const X = st.x, Y = st.y
  const rates = await H.rpc('getfeeexchangerates')
  if (!rates[Y]) await H.rpc('setfeeexchangerates', [{ ...rates, [Y]: 100000000 }])
  const OLD = process.env.LEAF_MAKER_OLD_PKG
  assert.ok(OLD && existsSync(join(OLD, 'leaf_wallet_bg.wasm')), 'LEAF_MAKER_OLD_PKG names the library to compare with')
  const shape = process.env.LEAF_MAKER_STORE_HISTORY || 'main'
  const limitMs = Number(process.env.LEAF_MAKER_PASS_LIMIT_MS || 600_000)
  const dir = mkdtempSync(join(tmpdir(), 'maker-pass-s-'))
  const { spawn } = await import('node:child_process')
  const proxy = await slowProxy(st.server, 0)
  try {
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const port = await freePort()
    const pairs = [{ give: X, want: Y, rate_num: '1', rate_den: '1', min_give: '10000' }]
    const cfg = makerConfig(join(dir, 'maker'), st, port, mnemonic, pairs, { instant_budget: '0.5', exit_delay_units: 3, max_coins: 2000,
      sync_seconds: 20, settle_seconds: 600 })
    writeFileSync(join(dir, 'maker', 'maker.json'), JSON.stringify({ ...cfg, operator: { ...cfg.operator, server: proxy.url } }, null, 2))
    const made = await largeStore(H, st, lwk, cfg.store_dir, mnemonic, proxy.url, [X, Y])
    console.log(at(), 'the store:', made.length, 'live coins; history', shape, JSON.stringify(await storeHistory(cfg.store_dir, historyOf(shape))))
    proxy.delay(Number(process.env.LEAF_MAKER_OPERATOR_DELAY_MS || 140))
    const script = new URL('./leaf-maker.mjs', import.meta.url).pathname
    const run = (pkg, args) => new Promise((ok) => {
      const t0 = Date.now()
      const p = spawn(process.execPath, [script, '--config', join(dir, 'maker', 'maker.json'), ...args], { env: { ...process.env, LEAVES_PKG: pkg }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
      const cut = setTimeout(() => p.kill('SIGTERM'), limitMs)
      p.on('exit', () => {
        clearTimeout(cut)
        const line = out.split('\n').reverse().find((l) => l.startsWith('{'))
        let v = null; try { v = JSON.parse(line) } catch {}
        ok(v && v.passes ? { ...v, wall_ms: Date.now() - t0 } : { cut: Date.now() - t0 >= limitMs, wall_ms: Date.now() - t0, error: (err || out).slice(-300) })
      })
    })
    const libs = { new: PKG, old: OLD }
    const runs = []
    // Whole passes, then passes in slices, each library in turn, the old one first and last; then
    // LEAF_MAKER_S_ROUNDS (1) rounds of one pass in slices by each, in turn.
    const rounds = Number(process.env.LEAF_MAKER_S_ROUNDS || 1)
    const plan = [['old', ['--pass-time', '3', '--slice-ms', '0']], ['new', ['--pass-time', '3', '--slice-ms', '0']], ['old', ['--pass-time', '1', '--slice-ms', '0']],
      ['new', ['--pass-time', '2', '--slice-ms', '1000']], ['old', ['--pass-time', '1', '--slice-ms', '1000']]]
    for (let k = 1; k < rounds; k++) plan.push(['new', ['--pass-time', '1', '--slice-ms', '1000']], ['old', ['--pass-time', '1', '--slice-ms', '1000']])
    for (const [lib, args] of plan) {
      const r = await run(libs[lib], args)
      runs.push({ lib, args: args.join(' '), ...r })
      console.log(at(), lib, args.join(' '), JSON.stringify(r).slice(0, 600))
    }
    const size = await new Promise((ok) => {
      const p = spawn(process.execPath, [script, '--config', join(dir, 'maker', 'maker.json'), '--size'], { env: { ...process.env, LEAVES_PKG: PKG } })
      let out = ''; p.stdout.on('data', (d) => { out += d }); p.on('exit', () => { try { ok(JSON.parse(out)) } catch { ok({ error: out.slice(-300) }) } })
    })
    console.log(at(), 'size:', JSON.stringify(size))
    const passesOf = (lib, slice) => runs.filter((r) => r.lib === lib && r.args.endsWith(' ' + slice)).flatMap((r) => r.passes || [])
    const figures = { history: shape, store: { live: made.length }, size, runs,
      whole: { new: stats(passesOf('new', 0).map((p) => p.ms)), old: stats(passesOf('old', 0).map((p) => p.ms)) },
      sliced: { new: stats(passesOf('new', 1000).map((p) => p.ms)), new_slices: stats(passesOf('new', 1000).map((p) => p.slices)),
        old: stats(passesOf('old', 1000).map((p) => p.ms)), old_cut: runs.some((r) => r.lib === 'old' && r.args.endsWith(' 1000') && r.cut) } }
    console.log('figures:', JSON.stringify(figures, null, 1))
    if (process.env.LEAF_MAKER_FIGURES) writeFileSync(process.env.LEAF_MAKER_FIGURES, JSON.stringify(figures, null, 1))
    assert.ok(figures.whole.new.n >= 3 && figures.sliced.new.n >= 2, 'this library ended its passes')
    assert.ok(figures.whole.new.p50 <= figures.whole.old.p50 * 1.1, 'whole passes no slower')
    assert.ok(figures.sliced.new.most <= 300_000, 'passes in slices within the bound: ' + figures.sliced.new.most)
    // Within a tenth: on a store whose history costs an older library little, both libraries' passes are the operator's time.
    assert.ok(figures.sliced.old.n === 0 || figures.sliced.new.p50 <= figures.sliced.old.p50 * 1.1, 'passes in slices no slower')
  } finally {
    proxy.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// The operator's capital through forty trades on one pair, both ways, from a maker whose coins are
// of a round, as the testnet's makers hold them (a board's coin counts nothing in flight: its
// forfeit pays the operator back at once). The operator's pool of each asset (`/v1/chain`: what it
// fronts for refreshes whose old coins have not come back, `in_flight`) is read every 15 s for two
// minutes before the trades, through them, and for LEAF_MAKER_AFTER_MINUTES (30) after, while the
// taker refreshes what it receives and the operator's watcher reclaims what comes back (`/settle`
// as its timers run it); the curve goes to LEAF_MAKER_CURVE (a path) as JSON. What stays in flight
// sits on nodes whose consent tree passed RECLAIM-D's 32 steps (arca #903): measured on arca
// 7eee1eae, the maker settling its own change as well changed nothing.
test('n: the operator\'s capital through forty trades from coins of a round', { skip: skipCase('n'), timeout: 10_800_000 }, async () => {
  const { H, st, lwk } = await stack()
  const [M0, M1, M2] = st.more, Y = st.x
  const names = new Map([[M0, 'M0'], [M1, 'M1'], [M2, 'M2'], [Y, 'X']])
  const name = (a) => names.get(a) || a.slice(0, 6)
  const dir = mkdtempSync(join(tmpdir(), 'maker-capital-n-'))
  const stops = []
  const makers = []
  const curve = []
  const chainUrl = st.server.replace(/\/+$/, '') + '/v1/chain'
  let phase = 'setup'
  const sample = async () => {
    try {
      const c = await getJson(chainUrl)
      const row = { t: Math.round((Date.now() - t0) / 1000), phase }
      for (const a of [M0, M1, M2, Y]) { const p = (c.pool || {})[a] || {}; row[name(a)] = { in_flight: p.in_flight, transferred: p.transferred, locked: p.locked } }
      curve.push(row)
    } catch {}
  }
  let sampling = true
  const sampler = (async () => { while (sampling) { await sample(); await sleep(15000) } })()
  stops.push(async () => { sampling = false; await sampler })
  let pumping = true
  const pumper = (async () => { let k = 0; while (pumping) { try { await H.pump(); if (++k % 3 === 0) await H.c('/settle') } catch {} await sleep(2000) } })()
  stops.push(async () => { pumping = false; await pumper })
  try {
    for (const a of [M0, M1, M2, Y]) await H.c('/fees', { asset: a, in_flight_cap: 1e15 })
    const setups = [{ label: 'A', g: M0, w: M1 }]
    // Each maker's store made first: both assets boarded and refreshed into a round, so its
    // reserve and the working coins it cuts from it are coins of a round.
    for (const s of setups) {
      s.mnemonic = lwk.Mnemonic.fromRandom(12).toString()
      s.port = await freePort()
      const pairs = [{ give: s.g, want: s.w, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: s.w, want: s.g, rate_num: '1', rate_den: '1', min_give: '10000' }]
      const cfg = makerConfig(join(dir, 'maker' + s.label), st, s.port, s.mnemonic, pairs, { instant_budget: '0.5' })
      const seed = await wallet(H, st, lwk, cfg.store_dir, s.mnemonic, [[s.g, 1500000], [s.w, 1500000]])
      const boards = (await seed.t('coins')).filter((c) => c.state === 'live' && c.kind === 'board').map((c) => c.leaf_id)
      const q = await seed.t('quote', { leaves: boards })
      await seed.t('participate', { leaves: boards, shown: q.coins })
      for (let i = 0; i < 180; i++) {
        await seed.t('sync').catch(() => {})
        const live = (await seed.t('coins')).filter((c) => c.state === 'live' && c.kind === 'batch')
        if ([s.g, s.w].every((a) => live.some((c) => c.asset === a))) break
        await sleep(1000)
      }
      console.log(at(), 'maker', s.label, 'holds', JSON.stringify((await seed.t('coins')).filter((c) => c.state === 'live').map((c) => [name(c.asset), c.kind, c.value])))
      await seed.stop()
    }
    for (const s of setups) {
      const maker = await launchMaker(H, join(dir, 'maker' + s.label), s.port, null)
      maker.url = `http://127.0.0.1:${s.port}`
      s.maker = maker; makers.push([s.label, maker])
      stops.push(() => maker.stop())
    }
    for (const s of setups) { await makerReady(H, s.maker, s.g, 300000); await makerReady(H, s.maker, s.w, 300000) }
    // Their working coins cut in a round before the trades.
    for (const s of setups) for (let i = 0; i < 300 && !logLines(s.maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    await sleep(120000)
    for (const s of setups) {
      s.T = await wallet(H, st, lwk, join(dir, 'taker' + s.label), lwk.Mnemonic.fromRandom(12).toString(), [[s.g, 800000], [s.w, 800000]])
      stops.push(() => s.T.stop())
    }
    phase = 'before'
    await sleep(120000)
    phase = 'trades'
    const runTrades = async (s) => {
      s.results = []
      for (let i = 0; i < 40; i++) {
        const [g, w] = i % 2 ? [s.w, s.g] : [s.g, s.w]
        let size = 110000 + (i % 5) * 10000
        for (let k = 0; k < 30; k++) {
          const q = ((await getJson(s.maker.url + '/v1/quotes')).quotes || []).filter((x) => x.give_asset === g && x.want_asset === w)
          const most = q.reduce((m, x) => (BigInt(x.max_give) > m ? BigInt(x.max_give) : m), 0n)
          if (most >= 10000n) { if (BigInt(size) > most) size = Number(most); break }
          await sleep(2000)
        }
        const r = await trade(s.maker, s.T.t, g, w, size, 10)
        s.results.push({ i, pair: name(g) + '->' + name(w), size, ...r })
        if (i % 2 === 1) await refreshChange(H, s.T)
      }
      await refreshChange(H, s.T)
    }
    await Promise.all(setups.map(runTrades))
    phase = 'after'
    const minutes = Number(process.env.LEAF_MAKER_AFTER_MINUTES || 30)
    for (let i = 0; i < minutes; i++) {
      await sleep(60000)
      if (i % 10 === 9) for (const s of setups) {
        const e = await explain(s.maker, s.label + ' after the trades, minute ' + (i + 1))
        console.log(at(), 'maker', s.label, 'coins by lineage', JSON.stringify((Array.isArray(e && e.coins_by_lineage) ? e.coins_by_lineage : []).map((x) => [x.lineage, name(x.asset), x.kind, x.state, x.n, x.hops_most])), 'at_risk', JSON.stringify(e && e.at_risk_decided), e && e.at_risk_from)
      }
    }
    await sample()
    for (const s of setups) {
      console.log(`maker ${s.label} said:\n` + logLines(s.maker, 0, /settling|own lineage|merging|cutting/).map((l) => l.slice(0, 200)).join('\n'))
      console.log(`maker ${s.label} trades:`, JSON.stringify(s.results.map((x) => [x.i, x.size, x.ms, x.refused ? 'refused' : 'ok'])))
    }
    const f = (r, a, k) => (r[a] && r[a][k]) || '0'
    for (const p of ['before', 'trades', 'after']) {
      const rs = curve.filter((r) => r.phase === p)
      if (!rs.length) continue
      console.log(`${p}: ${rs.length} readings; ` + ['M0', 'M1', 'M2', 'X'].map((a) => `${a} in_flight first ${f(rs[0], a, 'in_flight')} last ${f(rs[rs.length - 1], a, 'in_flight')} most ${rs.reduce((m, r) => (BigInt(f(r, a, 'in_flight')) > m ? BigInt(f(r, a, 'in_flight')) : m), 0n)}`).join('; '))
    }
    for (const s of setups) assert.equal(s.results.filter((x) => x.refused).length, 0, `maker ${s.label}: every trade completed`)
  } finally {
    if (process.env.LEAF_MAKER_CURVE) writeFileSync(process.env.LEAF_MAKER_CURVE, JSON.stringify(curve))
    for (const [label, m] of makers) await dumpMaker(m, 'n' + label)
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})
