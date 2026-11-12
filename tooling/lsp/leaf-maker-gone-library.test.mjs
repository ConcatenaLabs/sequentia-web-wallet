// The leaf maker's answer to an acceptance whose completion the operator refuses, against the real
// leaf wallet library (LEAVES_PKG, or the page's leaves/pkg, run by tooling/leaf-node.mjs), the real
// maker (leaf-maker.mjs in a process of its own) and a real operator (web wallet #685).
//
// One phrase on two devices, as on the testnet on 2026-11-12: device A gives a coin it received
// to a round; device B, which has not caught up since, still counts that coin and accepts a firm
// offer with it. The operator refuses the maker's completion. The maker answers at once that the
// offer is gone, naming the taker's coin, with a new offer at the same price; a second hand-over
// gets the same answer. B's cancel ends with the truth (the dead coin not counted, the round's
// coin held, nothing respent), and B takes the new offer with the coins it holds.
//
// The library is LEAVES_PKG's build when named (the threads read it from the environment).
// It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs) running
// with one more asset listed for fees (ARCA_OPERATOR_MORE_ASSETS=1), its control address in
// SEQ_LEAF_HARNESS, and the wallet kit's lwk_wasm (../../pkg or LWK_PKG); it skips itself otherwise:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test tooling/lsp/leaf-maker-gone-library.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
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

test('a refused completion is answered at once: the offer is gone, a new one at the same price, and the taker ends with the truth', { skip, timeout: 1_800_000 }, async () => {
  const H = harness(CONTROL)
  let st = await H.state()
  assert.ok(st.more && st.more.length, 'the harness serves one more asset listed for fees (ARCA_OPERATOR_MORE_ASSETS=1)')
  if (!st.bond) { await H.c('/bond_post', { amount: 50000000 }); st = await H.state() }
  const X = st.x, Y = st.more[0]
  const dir = mkdtempSync(join(tmpdir(), 'maker-gone-'))
  const stops = []
  try {
    const lwk = await lwkFrom(LWK)
    // The maker gives Y for X.
    const maker = await startMaker(H, st, join(dir, 'maker'), { pairs: [{ give: Y, want: X, rate_num: '4', rate_den: '5', min_give: '10000' }],
      fund: [[Y, 6000000], [X, 2000000]], port: await freePort(), lwk, settleSeconds: 600, syncSeconds: 5, coinSize: 2000000, exitDelayUnits: 1 })
    stops.push(() => maker.stop())
    await makerReady(H, maker, Y)
    // What the trade below takes, quoted.
    for (let t = 0; ; t++) {
      const qs = (await (await fetch(maker.url + '/v1/quotes')).json()).quotes || []
      if (qs.some((x) => x.give_asset === Y && BigInt(x.max_give) >= 1248000n)) break
      assert.ok(t < 300, 'the maker quotes 1,248,000 Y within ten minutes')
      await H.produce(); await H.bury(); await sleep(2000)
    }
    await H.c('/fund_server', { asset: X, amount: 200000000 }); await H.c('/fund_server', { asset: Y, amount: 200000000 }); await H.produce()
    let pumping = true
    const pump = (async () => { while (pumping) { try { await H.pump() } catch {} await sleep(2000) } })()
    stops.push(async () => { pumping = false; await pump })

    // One phrase, two devices, each its own store.
    const mnemonic = lwk.Mnemonic.fromRandom(12).toString()
    const config = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password, exit_delay_units: 1, min_exit_delay_units: 1 }
    const libA = await leafLibraryThread(join(dir, 'a')); stops.push(() => libA.stop())
    const A = await libA.create(mnemonic, config)
    const run = (w) => (c, a = {}) => w.command(c, a)
    const a = run(A)
    const addr = await a('address')
    await H.fund(addr.script_pubkey, X, 2150000); await H.fund(addr.script_pubkey, X, 1000000); await H.produce()
    for (let t = 0; ; t++) {
      try { await a('sync'); const q = await a('board_quote', { asset: X, amount: '2050000', fee_asset: X }); await a('board', { asset: X, amount: '2050000', fee_asset: X, shown: q.fee }); break }
      catch (e) { if (t > 30) throw e; await H.produce(); await sleep(1000) }
    }
    for (let t = 0; t < 60; t++) { await H.produce(); await H.bury(); await a('sync'); if ((await a('coins')).some((c) => c.asset === X && c.state === 'live')) break; await sleep(1000) }
    // A received coin, out of round: A pays itself nearly all it boarded, so the change is too
    // small to pay the trade below and the trade takes the received coin.
    const req = await a('receive', { asset: X, amount: '2000000' })
    await a('send', { request: req.request, amount: '2000000' })
    let got = null
    for (let t = 0; t < 60 && !got; t++) { await a('sync'); got = (await a('coins')).find((c) => c.asset === X && c.kind === 'transfer' && c.state === 'live' && c.value === '2000000'); if (!got) await sleep(1000) }
    assert.ok(got, 'A holds the coin it received')

    const libB = await leafLibraryThread(join(dir, 'b')); stops.push(() => libB.stop())
    const B = await libB.create(mnemonic, config)
    const b = run(B)
    await b('restore'); await b('sync')
    const liveB = async () => (await b('coins')).filter((c) => c.asset === X && c.state === 'live').map((c) => c.leaf_id)
    assert.ok((await liveB()).includes(got.leaf_id), 'B holds the received coin too')

    // A gives it to a round; the round is final, and A holds its new coin.
    const q = await a('quote', { leaves: [got.leaf_id] })
    await a('participate', { leaves: [got.leaf_id], shown: q.coins })
    let fresh = null
    for (let t = 0; t < 120 && !fresh; t++) {
      await a('sync')
      const ps = await a('participations')
      if (ps.some((p) => p.state === 'released')) fresh = (await a('coins')).find((c) => c.asset === X && c.kind === 'batch' && c.state === 'live')
      if (!fresh) await sleep(2000)
    }
    assert.ok(fresh, 'the round is released and A holds its coin')
    assert.ok((await liveB()).includes(got.leaf_id), 'B, not caught up, still counts the coin given to the round')

    // B takes a firm offer with that coin: 1,248,000 Y for 998,400 X.
    const firm = await post(maker.url + '/v1/firm', { give_asset: Y, want_asset: X, give: '1248000' })
    assert.equal(firm.status, 200, JSON.stringify(firm.body))
    const read = await b('swap_read', { offer: firm.body.offer })
    const acc = await b('swap_accept', { offer: firm.body.offer, shown: read })
    assert.ok((await b('coins')).some((c) => c.leaf_id === got.leaf_id && c.state === 'offered'), 'the acceptance names the coin given to the round')
    const t0 = Date.now()
    const ans = await post(maker.url + '/v1/accept', { swap: firm.body.swap, accept: acc.accept })
    const took = Date.now() - t0
    console.log('the maker answered in', took, 'ms:', JSON.stringify(ans.body).slice(0, 400))
    assert.equal(ans.status, 409)
    assert.equal(ans.body.gone, true, 'the offer is gone')
    assert.equal(ans.body.whose, 'taker', 'the coin the operator refused is the taker\'s')
    assert.equal(ans.body.coin, got.leaf_id)
    assert.ok(ans.body.offer && ans.body.offer.swap && ans.body.offer.swap !== firm.body.swap, 'a new offer comes with it')
    assert.equal(ans.body.offer.give, firm.body.give, 'at the same give')
    assert.equal(ans.body.offer.want, firm.body.want, 'and the same want')
    assert.ok(took < 15000, `answered in ${took} ms`)
    const again = await post(maker.url + '/v1/accept', { swap: firm.body.swap, accept: acc.accept })
    assert.equal(again.status, 409)
    assert.deepEqual(again.body, ans.body, 'handed over again, the same answer')

    // B cancels: it catches up at once, and ends with the truth, nothing respent.
    const c = await b('swap_cancel', { swap: firm.body.swap })
    console.log('B cancel:', JSON.stringify(c).slice(0, 400))
    assert.equal(c.cancelled, true, JSON.stringify(c))
    assert.deepEqual(c.spent_elsewhere, [got.leaf_id])
    assert.equal(c.respent, undefined, 'nothing respent')
    const live = await liveB()
    assert.ok(!live.includes(got.leaf_id), 'the coin given to the round is no longer counted')
    assert.ok(live.includes(fresh.leaf_id), 'B holds the round\'s coin')

    // B takes the new offer, at the same price, with the coins it holds.
    const read2 = await b('swap_read', { offer: ans.body.offer.offer })
    assert.deepEqual([read2.gets, read2.gives], [read.gets, read.gives], 'the same terms')
    const acc2 = await b('swap_accept', { offer: ans.body.offer.offer, shown: read2 })
    const done = await post(maker.url + '/v1/accept', { swap: ans.body.offer.swap, accept: acc2.accept })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.state, 'done')
    for (let t = 0; t < 30; t++) { await b('mailbox'); if ((await b('swaps')).find((s) => s.swap === ans.body.offer.swap)?.state === 'done') break; await sleep(1000) }
    assert.equal((await b('swaps')).find((s) => s.swap === ans.body.offer.swap).state, 'done', 'the trade is done once')
    assert.equal((await b('swaps')).find((s) => s.swap === firm.body.swap).state, 'cancelled')
  } finally {
    for (const s of stops.reverse()) { try { await s() } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
})
