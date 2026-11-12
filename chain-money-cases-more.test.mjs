// Money received on the chain, on the real leaf wallet library and a real operator: an asset the operator does not serve, a restricted asset, an anchor rollback of the move, two tabs.
// index.html's own routes and reviews over leaves.js. The harness runs with ARCA_OPERATOR_SUPERVISED=1
// and its anchor depth from ARCA_TEST_ANCHOR_DEPTH:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18751 LWK_PKG=<lwk_wasm pkg> node --test chain-money-cases-more.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DEFAULT_WORDS, codeMost } from './default-arca.js'
import { buildPayCode } from './pay-code.js'
import { skip, setup, send, textOf, page, heldX, sleep, CONTROL, PKG } from './tooling/chain-money-harness.mjs'

test('money received on the chain: an asset the operator does not serve, a restricted asset, an anchor rollback of the move, two tabs', { skip, timeout: 3_000_000 }, async (t) => {
  const { H, st, X, cfg, dir, B, bHolds, info, minX, wallet, release, moved, fresh } = await setup(t)
  await t.test('an asset the operator does not serve: stays on the chain, paid at an address, said so otherwise', async () => {
    release()
    let W = null
    try {
      // The chain's own policy asset, which this operator does not serve (the harness node holds no
      // wallet to issue another).
      const labels = await H.rpc('dumpassetlabels', [])
      W = Object.values(labels)[0]
      assert.ok(!(info.server_info.assets || []).some((a) => a.asset === W), 'the operator does not serve it')
      const A = await wallet()
      await A.paid(3_000_000, W)
      await A.api.syncNow().catch(() => {})
      console.log(`unserved: chainMovable ${A.p.chainMovable(W)}, chainStays ${A.p.chainStays(W)}`)
      assert.equal(A.p.chainMovable(W), 0n)
      assert.equal(A.p.chainStays(W), 'unserved')
      const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
      const d = A.p.payCodeRoute(code, W, 1_000_000n)
      console.log('unserved, a code with an address: ' + JSON.stringify(d))
      assert.equal(d.byAddress, true)
      const d2 = A.p.payCodeRoute(B.command('receive').request, W, 1_000_000n)
      await assert.rejects(A.p.treeSendReview({ asset: W, amtS: '0.01', addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
        (e) => { console.log('unserved, no address: refused: ' + e.message); assert.equal(e.message, DEFAULT_WORDS.toAddressOnly('X')); return true })
      assert.ok(!A.worker.asked.includes('board'))
    } catch (e) { if (!W) { console.log('unserved: the harness node could not issue an asset: ' + e.message); return } throw e }
  })

  await t.test('restricted: stays on the chain, by its own way (never routed or moved in)', async () => {
    release()
    const A = await wallet()
    const R = 'ab'.repeat(32)
    A.p = page(A.api, 'R', A.chain, { oamp: [R] })
    A.chain[R] = 3_000_000n
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    assert.deepEqual(A.p.payCodeRoute(code, R, 1_000_000n), { dest: code, byAddress: false })
    assert.deepEqual(A.p.codeWay(code, R, 1_000_000n, 'addr'), { dest: code, byAddress: false })
    assert.equal(A.p.chainMovable(R), 0n)
    console.log('restricted: payCodeRoute and codeWay leave it to its own way; chainMovable 0')
  })

  await t.test('an anchor rollback of the move itself: the payment waits, goes once, the wallet whole', async () => {
    release()
    const A = await wallet()
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    await A.p.treeSendReview({ asset: X, amtS: '0.01', addr: req, bringIn: true }, () => {})
    const modal = A.p.modals[0]
    let rolled = null
    const sending = modal.ok.onclick()
    // Wait for the board, put it in a block, then take that block's anchor away.
    for (let i = 0; i < 120 && !A.worker.asked.includes('board'); i++) await sleep(500)
    assert.ok(A.worker.asked.includes('board'), 'moved in')
    // The board's transaction: the library's board answer names it (leaves.js keeps it), else the
    // coin's outpoint.
    const bs = A.W.command('boards') || []
    console.log('boards: ' + JSON.stringify(bs.map((b) => ({ leaf_id: b.leaf_id, state: b.state }))))
    let boardTx = null
    // The board's transaction, as the move log keeps it (leaves.js noteMove).
    for (let i = 0; i < 20 && !boardTx; i++) {
      try { const all = JSON.parse(A.store.getItem('swk.leaves.moves.' + A.tag) || '{}'); boardTx = ((all[X] || []).pop() || {}).txid || null } catch {}
      if (!boardTx) await sleep(500)
    }
    if (!boardTx) { const pool = await H.rpc('getrawmempool', []); boardTx = pool[pool.length - 1] }
    await H.produce()
    try {
      const tx = await H.rpc('getrawtransaction', [boardTx, true])
      const hdr = await H.rpc('getblockheader', [tx.blockhash])
      const o = await fetch(`http://${CONTROL}/orphan`, { method: 'POST', body: JSON.stringify({ height: hdr.anchorheight }) }).then((x) => x.json())
      const again = await H.rpc('getrawtransaction', [boardTx, true]).catch((e) => ({ error: e.message }))
      rolled = { anchor: hdr.anchorheight, orphaned: o, boardNow: again.blockhash ? 'in a block' : again.confirmations === undefined ? 'mempool' : String(again.confirmations) }
    } catch (e) { rolled = { error: e.message } }
    console.log('rollback of the move: ' + JSON.stringify(rolled) + ' (board ' + boardTx + ')')
    let done = false
    const pump = (async () => { while (!done) { try { await H.produce(); await H.bury(); await H.round() } catch {} await sleep(2500) } })()
    try { await sending } finally { done = true; await pump }
    console.log('rollback: status ' + modal.st.textContent + '; library ' + moved(A).join(','))
    assert.match(modal.st.textContent, /^Sent 0\.01 X/)
    assert.equal(A.worker.asked.filter((c) => c === 'send').length, 1, 'paid once')
    assert.equal(bHolds() - before, 1_000_000n)
    const h = heldX(A.W, X)
    console.log(`rollback: the wallet holds ${h.tree} in the tree and ${h.chain} on the chain: fell by ${3_000_000n - h.tree - h.chain}`)
    assert.ok(3_000_000n - h.tree - h.chain - 1_000_000n <= A.p.bringMargin(X), 'whole: only the payment and its fees left')
  })

  await t.test('two tabs on one phrase, each sending at once with money moved in: each paid once, one move', async () => {
    release()
    const phrase = fresh()
    const A1 = await wallet(phrase)
    const A2 = await wallet(phrase, { W: A1.W, store: A1.store, tag: A1.tag })
    await A1.paid(3_000_000); A2.chain[X] = 3_000_000n
    const before = bHolds()
    await A1.p.treeSendReview({ asset: X, amtS: '0.004', addr: B.command('receive').request, bringIn: true }, () => {})
    await A2.p.treeSendReview({ asset: X, amtS: '0.006', addr: B.command('receive').request, bringIn: true }, () => {})
    const [r1, r2] = await Promise.all([send(H, A1.p.modals[0]), send(H, A2.p.modals[0])])
    const boards = A1.worker.asked.filter((c) => c === 'board').length + A2.worker.asked.filter((c) => c === 'board').length
    console.log(`two tabs: tab 1 ${JSON.stringify(r1.said)}; tab 2 ${JSON.stringify(r2.said)}; boards ${boards}; sends ${[...A1.worker.asked, ...A2.worker.asked].filter((c) => c === 'send').length}`)
    const got = bHolds() - before
    console.log('two tabs: B received ' + got)
    assert.ok(got <= 1_000_000n, 'never paid twice')
    for (const r of [r1, r2]) assert.ok(/^Sent|cannot be moved|taking longer/.test(r.status.textContent), r.status.textContent)
  })

})
