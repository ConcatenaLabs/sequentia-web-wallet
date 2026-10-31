import test from 'node:test'
import assert from 'node:assert/strict'
import { dueNow, markRaised, raiseRate, childFee, btcChildPlan, STUCK_BLOCKS, MAX_RAISES, SPEED_WORDS } from './speed-up.js'
import { USER_MODE_FORBIDDEN_WORDS } from './user-trade.js'

test('a transaction is due once it has waited STUCK_BLOCKS blocks, and again as long after each raise', () => {
  const book = {}
  assert.deepEqual(dueNow(book, ['a'], 100), [], 'first seen')
  assert.deepEqual(dueNow(book, ['a'], 100 + STUCK_BLOCKS - 1), [])
  assert.deepEqual(dueNow(book, ['a'], 100 + STUCK_BLOCKS), ['a'])
  markRaised(book, 'a', 102)
  assert.deepEqual(dueNow(book, ['a'], 103), [], 'just raised')
  assert.deepEqual(dueNow(book, ['a'], 104), ['a'])
  for (let i = 1; i < MAX_RAISES; i++) markRaised(book, 'a', 104)
  assert.deepEqual(dueNow(book, ['a'], 200), [], 'raised as often as it is raised')
  assert.deepEqual(dueNow(book, [], 201), [], 'a mined transaction leaves the book')
  assert.deepEqual(Object.keys(book), [])
})

test('the rate doubles at each raise', () => {
  assert.equal(raiseRate(1, 0), 2)
  assert.equal(raiseRate(1, 3), 16)
})

test('a child pays for the pair, never less than its own share', () => {
  // 200 vB parent paying 200 at 1/vB; 110 vB child; the pair at 4/vB = 1240, less 200.
  assert.equal(childFee({ parentVsize: 200, parentFee: 200, childVsize: 110, rate: 4 }), 1040n)
  // A parent that pays more than the target already: the child pays its own share.
  assert.equal(childFee({ parentVsize: 200, parentFee: 5000, childVsize: 110, rate: 4 }), 440n)
})

test('a Bitcoin child spends the handle, and another coin only when the handle cannot pay', () => {
  const vsizeOf = (n) => Math.ceil(10.75 + 68 * n + 31)
  const one = btcChildPlan({ handles: [{ txid: 'p', vout: 1, value: 50_000 }], extra: [{ txid: 'c', vout: 0, value: 9_000 }],
    parentVsize: 141, parentFee: 141, rate: 4, vsizeOf, dust: 294 })
  assert.equal(one.inputs.length, 1)
  assert.equal(one.change + one.fee, 50_000n)
  const two = btcChildPlan({ handles: [{ txid: 'p', vout: 1, value: 600 }], extra: [{ txid: 'c', vout: 0, value: 9_000 }],
    parentVsize: 141, parentFee: 141, rate: 4, vsizeOf, dust: 294 })
  assert.equal(two.inputs.length, 2, 'a second input pays')
  assert.throws(() => btcChildPlan({ handles: [], parentVsize: 1, parentFee: 1, rate: 1, vsizeOf, dust: 294 }), /Nothing in this transaction/)
  assert.throws(() => btcChildPlan({ handles: [{ txid: 'p', vout: 1, value: 300 }], parentVsize: 141, parentFee: 0, rate: 50, vsizeOf, dust: 294 }),
    /too little BTC/)
})

test('the words default mode shows use none of its forbidden words', () => {
  for (const s of Object.values(SPEED_WORDS)) {
    for (const w of USER_MODE_FORBIDDEN_WORDS) assert.ok(!new RegExp('\\b' + w + '\\b', 'i').test(s), `"${s}" says "${w}"`)
  }
})

test('user mode refreshes what it receives only where the page turns it on', async () => {
  const { refreshReceivedOn } = await import('./leaves.js')
  globalThis.window = globalThis.window || {}
  delete globalThis.window.SEQ_REFRESH_RECEIVED
  assert.equal(refreshReceivedOn(), false, 'off by default')
  globalThis.window.SEQ_REFRESH_RECEIVED = true
  assert.equal(refreshReceivedOn(), true)
  delete globalThis.window.SEQ_REFRESH_RECEIVED
})
