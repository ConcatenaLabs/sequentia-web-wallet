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
//   offered, and what it received settles in parts within the headroom.
// - Depth: forty trades in a row on one pair, both ways. Every trade's change is a coin of the
//   maker's own lineage, a reassignment deeper each time; the maker quotes throughout and the
//   operator refuses none of its offers for depth.
//
// The book is read once a second (/v1/quotes) and the maker's explain answer (/v1/explain) at each
// step. It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs)
// with three more assets listed for fees (ARCA_OPERATOR_MORE_ASSETS=3) and the control paths that
// set an asset's in-flight cap and the bond's instant budget, its control address in
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm (../../pkg or LWK_PKG); it skips itself otherwise.
// LEAF_MAKER_CASES (a, c, d; every one when unset) picks the cases.
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test tooling/lsp/leaf-maker-headroom-library.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { leafLibraryThread } from '../leaf-node.mjs'
import { harness, launchMaker, makerReady, freePort, sleep, lwkFrom } from '../user-mode-stack.mjs'

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

async function stack () {
  const H = harness(CONTROL)
  let st = await H.state()
  assert.ok(st.more && st.more.length >= 3, 'the harness serves three more assets (ARCA_OPERATOR_MORE_ASSETS=3)')
  if (!st.bond) {
    await H.c('/bond_post', { amount: BOND, instant_budget_fraction: 0.5 }); st = await H.state()
    // The operator funds its rounds from its own coins of each asset.
    for (const a of [st.x, ...st.more]) await H.c('/fund_server', { asset: a, amount: 200000000 })
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
async function wallet (H, st, lwk, dir, mnemonic, boards) {
  const config = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 1, min_exit_delay_units: 1 }
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

// A taker's own change, refreshed into a round: every sale pays from its change (the library pays
// from a coin out of round first), a reassignment deeper each time, and past the operator's depth
// limit it pays no more ("more are at the operator's depth limit"). -> when none is left.
async function refreshChange (H, W) {
  await W.t('sync').catch(() => {})
  const ch = (await W.t('coins')).filter((c) => c.state === 'live' && (c.kind === 'transfer' || c.kind === 'fill')).map((c) => c.leaf_id)
  if (!ch.length) return
  try { const q = await W.t('quote', { leaves: ch }); await W.t('participate', { leaves: ch, shown: q.coins }) } catch (e) { console.log(at(), 'taker refresh:', e.message); return }
  for (let i = 0; i < 120; i++) {
    await H.pump().catch(() => {}); await W.t('sync').catch(() => {})
    if (!(await W.t('coins')).some((c) => c.state === 'live' && (c.kind === 'transfer' || c.kind === 'fill'))) return
    await sleep(1000)
  }
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
      waiting_for_headroom: e.waiting_for_headroom, kept: e.kept_out_of_settle }))
    return e
  } catch (x) { console.log(at(), 'explain', label + ': none (' + x.message + ')'); return null }
}
const pumpLoop = (H) => {
  let on = true
  const run = (async () => { while (on) { try { await H.pump() } catch {} await sleep(2000) } })()
  return async () => { on = false; await run }
}
// A trade with the maker: the taker asks a firm offer of `give` of `give_asset`, takes it, and the
// maker completes it. -> the firm answer's time, ms.
async function trade (maker, t, give_asset, want_asset, give, tries = 60) {
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
      return { ms, refusals: i }
    }
    if (i >= tries) return { ms, refused: f.body, refusals: i }
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
    await makerReady(H, maker, X, 120000)
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
    for (const a of [M, N, X]) await makerReady(H, maker, a, 120000)
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
    // A received coin larger than 0.9 of the headroom: the cap set again at 100,000, the taker pays
    // 120,000 M1 in one trade.
    await makeInFlight(H, st, T, R, M)
    await headroom(H, st, M, 100000)
    await sleep(65000)
    await refreshChange(H, T)
    const big = await trade(maker, T.t, X, M, 120000, 5)
    console.log(at(), 'the maker buys 120,000 M1 in one trade:', JSON.stringify(big))
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
    const maker = await launchMaker(H, join(dir, 'maker'), port, [[M, 500000], [X, 500000]])
    makerOf = maker
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    for (const a of [M, X]) await makerReady(H, maker, a, 120000)
    for (let i = 0; i < 180 && !logLines(maker, 0, /cutting a coin/).length; i++) await sleep(1000)
    await sleep(60000)
    const book = watchBook(maker, [[M, X], [X, M]], name)
    stops.push(() => book.stop())
    const T = await wallet(H, st, lwk, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 800000], [M, 800000]])
    stops.push(() => T.stop())
    const results = []
    for (let i = 0; i < 40; i++) {
      const [g, w] = i % 2 ? [X, M] : [M, X]
      const r = await trade(maker, T.t, g, w, 11000 + (i % 5) * 1000, 10)
      results.push({ i, pair: name(g) + '->' + name(w), ...r })
      // The taker's change, refreshed every other trade: this case is the maker's depth, not its.
      if (i % 2 === 1) await refreshChange(H, T)
      if (i % 5 === 4) {
        const e = await explain(maker, 'after trade ' + (i + 1))
        const hops = ((e && e.coins_by_lineage) || []).map((x) => [x.lineage, x.asset, x.kind, x.state, x.n, x.hops_most])
        console.log(at(), 'hops by lineage after trade', i + 1, JSON.stringify(hops))
      }
    }
    for (let i = 0; i < 5; i++) { await sleep(60000); await explain(maker, 'after the trades, minute ' + (i + 1)) }
    const r = await book.stop()
    const depth = logLines(maker, 0, /depth/i)
    const lines = logLines(maker, 0, /settling|own lineage|merging|cutting|offers no|depth/)
    console.log('the maker said:\n' + lines.map((l) => l.slice(0, 300)).join('\n'))
    console.log('trades:', JSON.stringify(results.map((x) => [x.i, x.pair, x.ms, x.refusals, x.refused ? JSON.stringify(x.refused).slice(0, 200) : 'ok'])))
    console.log('the book:', JSON.stringify(r))
    assert.equal(results.filter((x) => x.refused).length, 0, 'every trade was offered and completed')
    assert.equal(depth.length, 0, 'no depth refusal: ' + depth.join('\n'))
    for (const [k, s] of Object.entries(r.pairs)) assert.equal(s.off, 0, `${k} offered at every reading (${s.off} of ${s.on + s.off} not, at ${s.offAt.join(' ')})`)
  } finally {
    await dumpMaker(makerOf, 'd')
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})
