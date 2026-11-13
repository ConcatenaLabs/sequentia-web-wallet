// The maker never gives the last free coin of an asset it quotes to a round (sequentia-testnet-ops
// #235), against the real leaf wallet library (LEAVES_PKG, or the page's leaves/pkg), the real
// maker (leaf-maker.mjs in a process of its own) and a real operator.
//
// The maker gives three assets, M0, M1 and M2, for X, and X for each. A taker buys some of each,
// so every coin the maker holds of them is the change of a swap, a coin it received; then it sells
// the maker M0 and M1 twice each. Its upkeep settles what it received once it has rested: M0 and
// M1 keep their large coin free and settle the rest, M2, whose only coin is due, is kept (never split
// by a payment to itself).
// Through the passes and the rounds, every one of the three stays quoted, and a firm offer of what
// was quoted before the upkeep is answered.
//
// It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs) running
// with three more assets listed for fees (ARCA_OPERATOR_MORE_ASSETS=3), its control address in
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm (../../pkg or LWK_PKG); it skips itself otherwise:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test tooling/lsp/leaf-maker-keep-free-library.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { leafLibraryThread } from '../leaf-node.mjs'
import { harness, startMaker, makerReady, freePort, sleep, lwkFrom } from '../user-mode-stack.mjs'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('../../leaves/pkg', import.meta.url).pathname
const LWK = process.env.LWK_PKG || new URL('../../pkg', import.meta.url).pathname
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package'
    : !existsSync(join(LWK, 'lwk_wasm_bg.wasm')) ? 'needs the wallet kit (LWK_PKG)' : false

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const most = (qs, give) => (qs || []).filter((q) => q.give_asset === give).reduce((m, q) => (BigInt(q.max_give) > m ? BigInt(q.max_give) : m), 0n)

test('every asset the maker quotes stays quoted through its upkeep, and what it quoted is answered firm', { skip, timeout: 2_400_000 }, async () => {
  const H = harness(CONTROL)
  let st = await H.state()
  assert.ok(st.more && st.more.length >= 3, 'the harness serves three more assets listed for fees (ARCA_OPERATOR_MORE_ASSETS=3)')
  if (!st.bond) { await H.c('/bond_post', { amount: 50000000 }); st = await H.state() }
  const X = st.x, [M0, M1, M2] = st.more
  const Ms = [M0, M1, M2]
  const dir = mkdtempSync(join(tmpdir(), 'maker-keep-free-'))
  const stops = []
  try {
    const lwk = await lwkFrom(LWK)
    const pairs = Ms.flatMap((m) => [{ give: m, want: X, rate_num: '1', rate_den: '1', min_give: '10000' }, { give: X, want: m, rate_num: '1', rate_den: '1', min_give: '10000' }])
    // One coin of each M boarded, 300,000 (and of X), settled a minute after it is received, so
    // that what it holds out of round stays under half its budget and the rest decides.
    const maker = await startMaker(H, st, join(dir, 'maker'), { pairs, fund: [...Ms.map((m) => [m, 400000]), [X, 700000]],
      port: await freePort(), lwk, settleSeconds: 60, coinSize: '300000', syncSeconds: 3, exitDelayUnits: 1 })
    stops.push(() => maker.stop())
    for (const m of Ms) await makerReady(H, maker, m, 300000)
    await H.c('/fund_server', { asset: X, amount: 200000000 })
    for (const m of Ms) await H.c('/fund_server', { asset: m, amount: 200000000 })
    await H.produce()
    let pumping = true
    const pump = (async () => { while (pumping) { try { await H.pump() } catch {} await sleep(2000) } })()
    stops.push(async () => { pumping = false; await pump })

    // The taker: X and each M boarded.
    const config = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 1, min_exit_delay_units: 1 }
    const lib = await leafLibraryThread(join(dir, 'taker')); stops.push(() => lib.stop())
    const T = await lib.create(lwk.Mnemonic.fromRandom(12).toString(), config)
    const t = (c, a = {}) => T.command(c, a)
    const addr = await t('address')
    for (const a of [X, ...Ms]) await H.fund(addr.script_pubkey, a, 1500000)
    await H.produce()
    for (const a of [X, ...Ms]) {
      for (let i = 0; ; i++) {
        try { await t('sync'); const q = await t('board_quote', { asset: a, amount: '1200000', fee_asset: a }); await t('board', { asset: a, amount: '1200000', fee_asset: a, shown: q.fee }); break }
        catch (e) { if (i > 30) throw e; await H.produce(); await sleep(1000) }
      }
    }
    for (let i = 0; i < 90; i++) {
      await H.produce(); await H.bury(); await t('sync')
      const live = new Set((await t('coins')).filter((c) => c.state === 'live').map((c) => c.asset))
      if ([X, ...Ms].every((a) => live.has(a))) break
      await sleep(1000)
    }
    // A trade with the maker, which gives `give` of `give_asset`.
    const trade = async (give_asset, want_asset, give) => {
      for (let i = 0; ; i++) {
        const f = await post(maker.url + '/v1/firm', { give_asset, want_asset, give: String(give) })
        if (f.status === 200) {
          const read = await t('swap_read', { offer: f.body.offer })
          const acc = await t('swap_accept', { offer: f.body.offer, shown: read })
          const done = await post(maker.url + '/v1/accept', { swap: f.body.swap, accept: acc.accept })
          assert.equal(done.status, 200, JSON.stringify(done.body))
          await t('mailbox').catch(() => {})
          return f.body
        }
        assert.ok(i < 60, `the maker gives ${give} of ${give_asset.slice(0, 8)}: ${JSON.stringify(f.body)}`)
        await sleep(2000)
      }
    }
    // Every coin of each M the maker holds becomes the change of a swap.
    for (const m of Ms) await trade(m, X, 30000)
    // M0 and M1: received twice more each, from the taker selling them.
    for (const m of [M0, M1]) { await trade(X, m, 20000); await trade(X, m, 15000) }
    await sleep(3000)
    // From here on (a firm offer leaves the maker's reading stale until it reads its coins again,
    // so the trades above are not watched), each M quoted at every reading, once a second; and when the maker's log first
    // shows a settle of M0 or M1, what it quotes of that asset then is asked firm at once.
    const lowest = Object.fromEntries(Ms.map((m) => [m, null]))
    const firmAfter = new Map()
    const zeros = []
    let watching = true, readings = 0
    const said = maker.log.length
    const logSince = () => maker.log.slice(said).join('').split('\n')
    const watch = (async () => {
      while (watching) {
        try {
          const qs = (await (await fetch(maker.url + '/v1/quotes')).json()).quotes
          readings++
          for (const m of Ms) { const v = most(qs, m); if (lowest[m] == null || v < lowest[m]) lowest[m] = v; if (v === 0n && zeros.length < 10) zeros.push(new Date().toISOString() + ' ' + m.slice(0, 8) + ' unquoted') }
          for (const m of [M0, M1]) {
            if (firmAfter.has(m) || !logSince().some((l) => /settling \d+ received coins of/.test(l) && l.includes(m))) continue
            const give = most(qs, m)
            const f = give > 0n ? await post(maker.url + '/v1/firm', { give_asset: m, want_asset: X, give: String(give) }) : { status: 0, body: 'nothing quoted' }
            firmAfter.set(m, { give, status: f.status, body: f.body })
            // The offer holds the coin until it is released: the readings resume once it is not
            // open, and the maker has read its coins again, so they measure the upkeep, not this.
            if (f.status === 200) {
              await post(maker.url + '/v1/release', { swap: f.body.swap })
              for (let i = 0; i < 30; i++) { const s = await (await fetch(maker.url + '/v1/swap/' + f.body.swap)).json(); if (s.state !== 'open') break; await sleep(1000) }
              await sleep(3000)
            }
          }
        } catch {}
        await sleep(1000)
      }
    })()
    stops.push(async () => { watching = false; await watch })
    // The upkeep settles each once it has rested; then 90 s more, through the rounds.
    const settled = (m) => logSince().some((l) => /settling \d+ received coins of/.test(l) && l.includes(m))
    const kept = (m) => logSince().some((l) => /keeps out of its round/.test(l) && l.includes(m.slice(0, 12)))
    const split = () => logSince().some((l) => /splitting|split:/.test(l))
    for (let i = 0; i < 360 && !(settled(M0) && settled(M1) && (settled(M2) || kept(M2))); i++) await sleep(1000)
    await sleep(90_000)
    watching = false; await watch
    const upkeep = logSince().filter((l) => /settling|keeps out|splitting|split:/.test(l))
    console.log('the upkeep:\n' + upkeep.map((l) => l.slice(0, 300)).join('\n'))
    console.log('lowest quote in', readings, 'readings:', JSON.stringify(Object.fromEntries(Ms.map((m) => [m.slice(0, 8), String(lowest[m])]))))
    if (zeros.length) console.log('unquoted readings:\n' + zeros.join('\n') + '\nthe maker then:\n' + logSince().filter((l) => zeros.some((z) => Math.abs(Date.parse(l.slice(0, 24)) - Date.parse(z.slice(0, 24))) < 8000)).map((l) => l.slice(0, 260)).join('\n'))
    console.log('firm at the settle:', JSON.stringify([...firmAfter].map(([m, f]) => [m.slice(0, 8), String(f.give), f.status, f.status === 200 ? 'ok' : f.body])))
    for (const m of [M0, M1]) assert.ok(settled(m), `the upkeep settled what it received of ${m.slice(0, 8)}`)
    for (const m of Ms) assert.ok(lowest[m] > 0n, `${m.slice(0, 8)} quoted at every reading through the upkeep (lowest ${lowest[m]})`)
    for (const m of [M0, M1]) {
      const f = firmAfter.get(m)
      assert.ok(f && f.status === 200, `${m.slice(0, 8)}: what it quoted as it settled is answered firm: ${JSON.stringify(f && f.body)}`)
    }
    // M2, whose only coin was due: kept and quoted, never split by a payment to itself.
    assert.ok(kept(M2) || settled(M2), 'M2\'s only coin was kept, or settled whole')
    assert.ok(!split(), 'no coin split by a payment to itself')
  } finally {
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})
