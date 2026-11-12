// Money received on the chain, on the real leaf wallet library and a real operator: a send moved in first (B1), the whole balance to a code (B3), a payment not in a block yet (N3).
// index.html's own routes and reviews over leaves.js. The harness runs with ARCA_OPERATOR_SUPERVISED=1
// and its anchor depth from ARCA_TEST_ANCHOR_DEPTH:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18751 LWK_PKG=<lwk_wasm pkg> node --test chain-money-cases-sends.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DEFAULT_WORDS, codeMost } from './default-arca.js'
import { buildPayCode } from './pay-code.js'
import { skip, setup, send, textOf, page, heldX, sleep, CONTROL, PKG } from './tooling/chain-money-harness.mjs'

test('money received on the chain: a send moved in first (B1), the whole balance to a code (B3), a payment not in a block yet (N3)', { skip, timeout: 3_000_000 }, async (t) => {
  const { H, st, X, cfg, dir, B, bHolds, info, minX, wallet, release, moved, fresh } = await setup(t)
  await t.test('B1: a send moved in first shows the most its fees can be and the total; what left is within them', async () => {
    release()
    const A = await wallet()
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    const d = A.p.payCodeRoute(req, X, 1_000_000n)
    assert.equal(d.bringIn, true, JSON.stringify(d))
    await A.p.treeSendReview({ asset: X, amtS: '0.01', addr: d.dest, bringIn: true }, () => {})
    const modal = A.p.modals[0]
    const shown = textOf(modal.m)
    console.log('B1 send review: ' + shown.replace(/\n/g, ' | '))
    const bound = A.p.bringMargin(X)
    assert.ok(shown.includes(DEFAULT_WORDS.feeAtMost('0.00016', 'X', '')), 'fee as a figure, the most: ' + shown)
    assert.ok(shown.includes(DEFAULT_WORDS.feeAtMost('0.01016', 'X', '')), 'and the total')
    assert.ok(!shown.includes(DEFAULT_WORDS.feeKeptSome))
    const r = await send(H, modal)
    console.log(`B1 send: ${r.ms} ms; said ${JSON.stringify(r.said)}; library ${moved(A).join(',')}`)
    assert.match(r.status.textContent, /^Sent 0\.01 X/)
    assert.equal(bHolds() - before, 1_000_000n)
    const h = heldX(A.W, X)
    const left = 3_000_000n - h.tree - h.chain
    console.log(`B1 send: the wallet's X fell by ${left}: 1,000,000 sent, ${left - 1_000_000n} in fees (move ${A.api.movedFees(X, 0)}), against at most ${bound}`)
    assert.ok(left - 1_000_000n <= bound, `fees ${left - 1_000_000n} over the ${bound} shown`)
  })

  await t.test('B3: the whole balance to a receive code with an address: refused naming Max\'s figure, which then goes', async () => {
    release()
    const A = await wallet()
    await A.paid(3_000_000)
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    for (const amount of [3_000_000n, 2_999_000n]) {
      const d = A.p.payCodeRoute(code, X, amount)
      await assert.rejects(A.p.treeSendReview({ asset: X, amtS: String(Number(amount) / 1e8), addr: d.dest, bringIn: !!d.bringIn, most: d.most }, () => {}),
        (e) => { console.log(`B3 ${amount}: ${e.message}`); assert.ok(!/up to 0 /.test(e.message), e.message); assert.equal(e.message, DEFAULT_WORDS.sendUpTo('0.02996', 'X')); return true })
    }
    const d = A.p.payCodeRoute(code, X, 2_996_000n)
    console.log('B3 at Max: ' + JSON.stringify(d))
    assert.equal(d.byAddress, true)
  })

  await t.test('N3: a payment not in a block yet is never moved in before it is; once in a block, it is', async () => {
    release()
    const A = await wallet()
    await A.paid(2_000_000, X, { block: false })
    const t0 = Date.now()
    const p = A.api.bringIn(X, { want: 1_000_000n, since: t0, until: t0 + 120_000 })
    await sleep(25_000)
    console.log('N3 before the block: library asked ' + A.worker.asked.filter((c) => /^(balance|board)/.test(c)).slice(-4).join(','))
    assert.ok(!A.worker.asked.includes('board'), 'nothing moved in from the mempool')
    await H.produce(); await H.bury()
    const tb = Date.now()
    const v = await p
    console.log(`N3: moved in ${Date.now() - tb} ms after the block: ${JSON.stringify(v && v.boarded ? { fee: v.boarded.fee } : v)}`)
    assert.ok(v && v.boarded)
  })

})
