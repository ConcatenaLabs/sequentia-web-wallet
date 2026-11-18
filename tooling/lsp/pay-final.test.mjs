// A hosted node's payment is called failed only once no attempt of it can follow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payStatusOf, wentOut, PAY_SETTLE_S } from './pay-final.mjs'

const part = (status, created_at, extra = {}) => ({ status, created_at, ...extra })

test('complete with its preimage once any part completed; pending while any part is in flight', () => {
  assert.deepEqual(payStatusOf([part('failed', 1), part('complete', 2, { payment_preimage: 'ab' })]), { state: 'complete', preimage: 'ab' })
  assert.equal(payStatusOf([part('failed', 1), part('pending', 2)], { nowS: 1e6 }).state, 'pending')
  assert.equal(payStatusOf([], {}).state, 'none')
  assert.equal(payStatusOf(undefined).state, 'none')
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
  assert.equal(wentOut([part('complete', 2)]), true)
  assert.equal(wentOut([part('failed', 1)]), false)
  assert.equal(wentOut([]), false)
  assert.equal(wentOut(null), false)
})
