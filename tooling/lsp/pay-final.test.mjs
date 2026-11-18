// A hosted node's payment is called failed only once no attempt of it can follow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payStatusOf, wentOut, readParts, PAY_SETTLE_S } from './pay-final.mjs'

const part = (status, created_at, extra = {}) => ({ status, created_at, ...extra })

test('complete with its preimage once any part completed; pending while any part is in flight', () => {
  assert.deepEqual(payStatusOf([part('failed', 1), part('complete', 2, { payment_preimage: 'ab'.repeat(32) })]), { state: 'complete', preimage: 'ab'.repeat(32) })
  assert.equal(payStatusOf([part('failed', 1), part('pending', 2)], { nowS: 1e6 }).state, 'pending')
  assert.equal(payStatusOf([], {}).state, 'none', 'a list read empty: no payment')
})

test('every part failed between two attempts of pay: pending, not failed, while pay may still try', () => {
  // pay runs here: pending whatever its parts read, with none made yet too.
  assert.equal(payStatusOf([part('failed', 1000)], { active: true, nowS: 5000 }).state, 'pending')
  assert.equal(payStatusOf([], { active: true }).state, 'pending')
  // After a restart (nothing known here): pending until the newest part is PAY_SETTLE_S old.
  assert.equal(payStatusOf([part('failed', 1000), part('failed', 1030)], { nowS: 1030 + PAY_SETTLE_S - 1 }).state, 'pending')
  assert.equal(payStatusOf([part('failed', 1000), part('failed', 1030)], { nowS: 1030 + PAY_SETTLE_S }).state, 'failed')
  // The last /node/pay for it ended here after its newest part: failed at once.
  assert.equal(payStatusOf([part('failed', 1000)], { endedAt: 1001, nowS: 1002 }).state, 'failed')
  // ... but not when a part came after it ended (another attempt elsewhere).
  assert.equal(payStatusOf([part('failed', 1000), part('failed', 1005)], { endedAt: 1001, nowS: 1006 }).state, 'pending')
})

test('a payment that went out is followed, never declined or tried another way', () => {
  assert.equal(wentOut([part('failed', 1), part('pending', 2)]), true)
  assert.equal(wentOut([part('complete', 2, { payment_preimage: 'ab'.repeat(32) })]), true)
  assert.equal(wentOut([part('failed', 1)]), false)
  assert.equal(wentOut([]), false)
})

// Parts the LSP cannot read say nothing of the payment: never a final failure, never "went out" or
// not. The page then keeps its lock's paid mark.
test('parts it cannot read are unknown, never failed: not a list, a null part, an unknown status, no status or no time', () => {
  const unreadable = [undefined, null, {}, 'payments', 7, [null], [7], [part('mystery', 1)], [{ created_at: 1 }], [{ status: 'failed' }],
    [part('failed', 'soon')], [part('failed', 0)], [part('failed', NaN)], [part('failed', -5)], [part('complete', 1)],
    [part('complete', 1, { payment_preimage: 'xyz' })], [part('failed', 1), part('mystery', 2)], [part('failed', 1), null]]
  for (const ps of unreadable) {
    assert.equal(readParts(ps), null, JSON.stringify(ps))
    for (const opts of [{ nowS: 1e9 }, { endedAt: 1e9, nowS: 1e9 }, { active: true }]) {
      assert.equal(payStatusOf(ps, opts).state, 'unknown', JSON.stringify(ps) + ' ' + JSON.stringify(opts))
    }
    assert.equal(wentOut(ps), null, JSON.stringify(ps))
  }
  // Only parts every one of which is a known failure with its time end failed.
  assert.equal(payStatusOf([part('failed', 1), part('failed', 2)], { nowS: 1e9 }).state, 'failed')
})
