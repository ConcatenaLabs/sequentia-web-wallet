// A maker whose coins are shaped makes no refresh while nobody trades, against the real leaf wallet
// library (LEAVES_PKG, or the page's leaves/pkg), the real maker (leaf-maker.mjs in a process of
// its own) and a real operator (web wallet #783).
//
// The maker gives three assets with a budget and the box's cap of eight coins an asset, boards them
// and shapes its coins. Then its node's rates move a minute at a time as the testnet's did (the
// working-coin sizes the testnet's BTC desk maker logged over an hour, leaf-maker-sizes-series.json,
// each asset's rate set so that its size moves by the same ratio), for LOOP_MINUTES (30) with nobody
// trading: it makes no cut and no merge. Then a taker trades with it, and every cut and merge it
// makes after is counted against the trades.
//
// It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs) with
// three more assets listed for fees (ARCA_OPERATOR_MORE_ASSETS=3), its control address in
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm (../../pkg or LWK_PKG); it skips itself otherwise.
// LEAF_MAKER_LOG (a path prefix) keeps the maker's log.
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test --test-timeout=10800000 tooling/lsp/leaf-maker-loop-library.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { leafLibraryThread } from '../leaf-node.mjs'
import { harness, launchMaker, makerReady, freePort, sleep, lwkFrom } from '../user-mode-stack.mjs'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('../../leaves/pkg', import.meta.url).pathname
const LWK = process.env.LWK_PKG || new URL('../../pkg', import.meta.url).pathname
const MINUTES = Number(process.env.LOOP_MINUTES || 30)
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package'
    : !existsSync(join(LWK, 'lwk_wasm_bg.wasm')) ? 'needs the wallet kit (LWK_PKG)' : false
const SERIES = JSON.parse(readFileSync(new URL('./leaf-maker-sizes-series.json', import.meta.url), 'utf8'))

const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(0) + 's'
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(30000) })).json()

// A wallet of the leaf library on the harness, `boards` ([asset, atoms]) boarded.
async function wallet (H, st, dir, mnemonic, boards) {
  const config = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 1, min_exit_delay_units: 1 }
  const lib = await leafLibraryThread(dir)
  const W = await lib.create(mnemonic, config)
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
  return { t, stop: () => lib.stop() }
}

// A trade: the taker asks a firm offer of `give` of `give_asset`, takes it, the maker completes it.
async function trade (maker, t, give_asset, want_asset, give, tries = 30) {
  for (let i = 0; ; i++) {
    const f = await post(maker.url + '/v1/firm', { give_asset, want_asset, give: String(give) })
    if (f.status === 200) {
      const read = await t('swap_read', { offer: f.body.offer })
      const acc = await t('swap_accept', { offer: f.body.offer, shown: read })
      const done = await post(maker.url + '/v1/accept', { swap: f.body.swap, accept: acc.accept })
      assert.equal(done.status, 200, JSON.stringify(done.body))
      await t('mailbox').catch(() => {})
      return { refusals: i }
    }
    if (i >= tries) return { refused: f.body, refusals: i }
    await sleep(2000)
  }
}

const pumpLoop = (H) => {
  let on = true
  const run = (async () => { while (on) { try { await H.pump() } catch {} await sleep(2000) } })()
  return async () => { on = false; await run }
}
const lines = (maker, from, re) => maker.log.slice(from).join('').split('\n').filter((l) => re.test(l))
const RESHAPE = /cutting a coin|merging \d+ coins/

test('a shaped maker makes no cut and no merge while nobody trades, as rates move as the testnet\'s do', { skip, timeout: 3 * 3_600_000 }, async () => {
  const H = harness(CONTROL)
  let st = await H.state()
  assert.ok(st.more && st.more.length >= 3, 'the harness serves three more assets (ARCA_OPERATOR_MORE_ASSETS=3)')
  if (!st.bond) {
    await H.c('/bond_post', { amount: 5_000_000, instant_budget_fraction: 0.5 }); st = await H.state()
    for (const a of [st.x, ...st.more]) await H.c('/fund_server', { asset: a, amount: 200000000 })
    await H.produce(); await H.bury()
  }
  const info = await getJson(st.server.replace(/\/+$/, '') + '/v1/info')
  console.log(at(), 'operator: finality', JSON.stringify(info.finality ?? null), 'depth_limit', info.depth_limit, 'checkpoint_exit', info.checkpoint_exit)
  const lwk = await lwkFrom(LWK)
  const X = st.x, A = st.more[0], B = st.more[1]
  const name = (a) => (a === X ? 'X' : a === A ? 'M0' : a === B ? 'M1' : a.slice(0, 6))
  // Each asset's rate follows one of the testnet's series: its size moves by the same ratio.
  const follows = new Map([[X, 'GOLD'], [A, 'OILX'], [B, 'EURX']])
  const base = await H.rpc('getfeeexchangerates')
  const ratesAt = (k) => {
    const r = { ...base }
    for (const [a, s] of follows) {
      const v = SERIES.sizes[s]
      r[a] = Number((BigInt(base[a]) * BigInt(v[0])) / BigInt(v[k % v.length]))
    }
    return r
  }
  const dir = mkdtempSync(join(tmpdir(), 'maker-loop-'))
  const stops = []
  let maker = null
  try {
    const port = await freePort()
    const pairs = []
    for (const g of [X, A, B]) for (const w of [X, A, B]) if (g !== w) pairs.push({ give: g, want: w, rate_num: '1', rate_den: '1', min_give: '10000' })
    const mdir = join(dir, 'maker')
    mkdirSync(mdir, { recursive: true })
    writeFileSync(join(mdir, 'mnemonic'), lwk.Mnemonic.fromRandom(12).toString(), { mode: 0o600 })
    // The box's BTC desk: at most eight live coins an asset, its budget share the operator's 0.5.
    const cfg = { wallet: 'leaf-maker-regtest', mnemonic_file: join(mdir, 'mnemonic'), store_dir: join(mdir, 'store'), listen: `127.0.0.1:${port}`,
      operator: { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password },
      exit_delay_units: 1, min_exit_delay_units: 1, pairs, fee_margin: '2000', sync_seconds: 3, settle_seconds: 60, offer_ttl_seconds: 300,
      board_keep: '100000', instant_budget: '0.5', max_coins: 8 }
    writeFileSync(join(mdir, 'maker.json'), JSON.stringify(cfg, null, 2))
    await H.rpc('setfeeexchangerates', [ratesAt(0), false])
    maker = await launchMaker(H, mdir, port, [[X, 2_000_000], [A, 2_000_000], [B, 2_000_000]])
    stops.push(() => maker.stop())
    const stopPump = pumpLoop(H); stops.push(stopPump)
    for (const a of [X, A, B]) await makerReady(H, maker, a, 300000)
    // Shaped: boarded, cut and merged until it says nothing of either for three minutes.
    let quiet = Date.now(), seen = 0
    for (const end = Date.now() + 40 * 60_000; Date.now() < end && Date.now() - quiet < 180_000;) {
      const n = lines(maker, 0, /boarded|cutting a coin|merging \d+ coins|settling/).length
      if (n !== seen) { seen = n; quiet = Date.now() }
      await sleep(5000)
    }
    console.log(at(), 'shaped after', seen, 'boards, cuts, merges and settles:\n' + lines(maker, 0, /working coins of at most|boarded|cutting a coin|merging \d+ coins|settling/).map((l) => l.slice(0, 220)).join('\n'))
    assert.ok(Date.now() - quiet >= 180_000, 'the maker shaped its coins within forty minutes')
    // Nobody trades; the rates move a reading a minute.
    const from = maker.log.length
    for (let k = 1; k <= MINUTES; k++) {
      await H.rpc('setfeeexchangerates', [ratesAt(k), false])
      await sleep(60_000)
      if (k % 5 === 0) console.log(at(), `minute ${k}: ${lines(maker, from, RESHAPE).length} cuts and merges so far`)
    }
    const quietLines = lines(maker, from, RESHAPE)
    const sizes = lines(maker, from, /working coins of at most/)
    console.log(at(), `${MINUTES} minutes, nobody trading: ${sizes.length} new working-coin sizes, ` +
      `${quietLines.filter((l) => /cutting/.test(l)).length} cuts, ${quietLines.filter((l) => /merging/.test(l)).length} merges` +
      (quietLines.length ? '\n' + quietLines.map((l) => l.slice(0, 220)).join('\n') : ''))
    console.log(sizes.slice(0, 5).map((l) => l.slice(0, 220)).join('\n'))
    assert.ok(sizes.length >= MINUTES / 2, 'the working-coin size moved as the rates did')
    assert.deepEqual(quietLines, [], 'no cut and no merge while nobody trades')
    // Then trades: every refresh after them counted against them.
    const T = await wallet(H, st, join(dir, 'taker'), lwk.Mnemonic.fromRandom(12).toString(), [[X, 600000], [A, 600000], [B, 600000]])
    stops.push(() => T.stop())
    const from2 = maker.log.length
    const done = []
    const plan = [[A, X, 40000], [X, B, 60000], [B, A, 30000], [A, B, 50000], [X, A, 20000], [B, X, 45000]]
    for (const [g, w, v] of plan) {
      const r = await trade(maker, T.t, g, w, v)
      done.push({ pair: name(g) + '->' + name(w), give: v, ...r })
      console.log(at(), 'trade', name(g), 'for', name(w), v, JSON.stringify(r))
      await H.rpc('setfeeexchangerates', [ratesAt(MINUTES + done.length), false])
      await sleep(30_000)
    }
    for (let k = 1; k <= 10; k++) { await H.rpc('setfeeexchangerates', [ratesAt(MINUTES + plan.length + k), false]); await sleep(60_000) }
    const traded = done.filter((d) => !d.refused).length
    const after = lines(maker, from2, /cutting a coin|merging \d+ coins|settling \d+/)
    const count = (re) => after.filter((l) => re.test(l)).length
    console.log(at(), `${traded} trades, then ten minutes: ${count(/settling/)} settles, ${count(/cutting/)} cuts, ${count(/merging/)} merges\n` + after.map((l) => l.slice(0, 220)).join('\n'))
    assert.equal(traded, plan.length, 'every trade completed: ' + JSON.stringify(done))
    // A trade spends one working coin of the asset given: at most one cut each to replace it, and
    // at most one merge each of the crumbs its change and settles left.
    assert.ok(count(/cutting/) <= traded, `at most a cut a trade (${count(/cutting/)} for ${traded})`)
    assert.ok(count(/merging/) <= traded, `at most a merge a trade (${count(/merging/)} for ${traded})`)
  } finally {
    if (process.env.LEAF_MAKER_LOG && maker) writeFileSync(process.env.LEAF_MAKER_LOG + '.log', maker.log.join(''))
    try { await H.rpc('setfeeexchangerates', [ratesAt(0), false]) } catch {}
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})
