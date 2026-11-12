// Money received on the chain, on the real leaf wallet library and a real operator: a supervised asset and its frozen coins, native bitcoin, an amount under the smallest coin.
// index.html's own routes and reviews over leaves.js. The harness runs with ARCA_OPERATOR_SUPERVISED=1
// and its anchor depth from ARCA_TEST_ANCHOR_DEPTH:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18751 LWK_PKG=<lwk_wasm pkg> node --test chain-money-cases-kinds.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DEFAULT_WORDS, codeMost } from './default-arca.js'
import { buildPayCode } from './pay-code.js'
import { skip, setup, send, textOf, page, heldX, sleep, CONTROL, PKG } from './tooling/chain-money-harness.mjs'

test('money received on the chain: a supervised asset and its frozen coins, native bitcoin, an amount under the smallest coin', { skip, timeout: 3_000_000 }, async (t) => {
  const { H, st, X, cfg, dir, B, bHolds, info, minX, wallet, release, moved, fresh } = await setup(t)
  await t.test('supervised: moved in like any asset; frozen on the chain, it moves nowhere and is said frozen', { skip: !st.supervised && 'harness without ARCA_OPERATOR_SUPERVISED' }, async () => {
    release()
    const Z = st.supervised
    const A = await wallet()
    A.p = page(A.api, 'Z', A.chain)
    await A.paid(3_000_000, Z)
    const req = B.command('receive').request
    const before = bHolds(Z)
    const d = A.p.payCodeRoute(req, Z, 1_000_000n)
    console.log('supervised, chain only: route ' + JSON.stringify(d))
    assert.equal(d.bringIn, true)
    await A.p.treeSendReview({ asset: Z, amtS: '0.01', addr: d.dest, bringIn: true }, () => {})
    const r = await send(H, A.p.modals[0])
    console.log(`supervised: ${r.ms} ms; said ${JSON.stringify(r.said)}; library ${moved(A).join(',')}`)
    assert.match(r.status.textContent, /^Sent 0\.01 Z/)
    assert.equal(bHolds(Z) - before, 1_000_000n)
    // Frozen: another wallet's coin of Z on the chain, its script frozen by the issuer.
    const F = await wallet()
    F.p = page(F.api, 'Z', F.chain)
    const { script } = await F.paid(2_000_000, Z)
    await fetch(`http://${CONTROL}/freeze`, { method: 'POST', body: JSON.stringify({ script }) }).then((x) => x.json()).then((j) => console.log('freeze: ' + JSON.stringify(j)))
    await H.produce(); await H.bury()
    await F.api.syncNow().catch(() => {})
    try { F.W.command('balance') } catch {}
    const fb = F.W.command('balance')
    console.log('frozen wallet balance: onchain ' + JSON.stringify(fb.sequentia_onchain) + ' frozen ' + JSON.stringify(fb.sequentia_onchain_frozen))
    // The page's figures (its reading of the library's balance): what is frozen moves nowhere.
    await F.api.syncNow().catch(() => {})
    console.log(`frozen: chainSpendable ${F.p.chainSpendable(Z)}, chainMovable ${F.p.chainMovable(Z)}, chainStays ${F.p.chainStays(Z)}`)
    assert.equal(F.p.chainMovable(Z), 0n, 'never moved in')
    const d2 = F.p.payCodeRoute(B.command('receive').request, Z, 1_000_000n)
    console.log('frozen: route ' + JSON.stringify(d2))
    assert.ok(!d2.bringIn)
    await assert.rejects(F.p.treeSendReview({ asset: Z, amtS: '0.01', addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
      (e) => { console.log('frozen: refused: ' + e.message); assert.match(e.message, /is frozen by its issuer/); return true })
    assert.ok(!F.worker.asked.includes('board'))
  })

  await t.test('native bitcoin is never moved in, nor routed as chain money of the tree', async () => {
    release()
    const A = await wallet()
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    assert.deepEqual(A.p.codeWay(code, 'BTC', 1000n, 'addr'), { dest: code, byAddress: false })
    assert.equal(A.p.chainMovable('BTC'), 0n)
    assert.equal(A.p.chainStays('BTC'), null)
    console.log('BTC: codeWay leaves it, chainMovable 0, chainStays null')
  })

  await t.test('under the smallest coin the operator takes in: stays on the chain, paid at an address, said so otherwise', async () => {
    release()
    const A = await wallet()
    const dust = minX > 20_000n ? minX - 1n : 0n
    if (!dust) { console.log('under the smallest coin: min_leaf ' + minX + ' leaves no amount above the fee margin to test'); return }
    await A.paid(dust)
    console.log(`under the smallest coin (${minX}): holds ${dust} on the chain; chainMovable ${A.p.chainMovable(X)}, chainStays ${A.p.chainStays(X)}`)
    assert.equal(A.p.chainMovable(X), 0n)
    assert.equal(A.p.chainStays(X), 'dust')
    const amount = dust - 5_000n
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    const d = A.p.payCodeRoute(code, X, amount)
    console.log('dust, a code with an address: ' + JSON.stringify(d))
    assert.equal(d.byAddress, true, 'paid at the address on the chain')
    const d2 = A.p.payCodeRoute(B.command('receive').request, X, amount)
    console.log('dust, a request with no address: ' + JSON.stringify(d2))
    await assert.rejects(A.p.treeSendReview({ asset: X, amtS: String(Number(amount) / 1e8), addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
      (e) => { console.log('dust, no address: refused: ' + e.message); assert.equal(e.message, DEFAULT_WORDS.toAddressOnly('X')); return true })
    assert.ok(!A.worker.asked.includes('board'))
  })

})
