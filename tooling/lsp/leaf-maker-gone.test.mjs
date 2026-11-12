// An acceptance whose completion the operator refuses is answered at once that the offer is gone,
// with whose coin the operator named and the offer made in its place (web wallet #685). Live,
// 2026-11-12: the taker's coin had been given to a round by its second device; the maker's library
// released its own coins and left the swap open, and every hand-over of the same acceptance for
// the next 163 s was refused "coin … is live now, not held for the swap".
import test from 'node:test'
import assert from 'node:assert/strict'
import { completionRefused, goneAnswer, againWant, notOpenAnswer } from './leaf-maker.mjs'

test('a refusal of the operator is a refused completion; the operator not reached is not', () => {
  assert.equal(completionRefused({ kind: 'swap_refused', message: 'refused: the operator refused the swap\'s completion' }), true)
  // A library that leaves the offer open answers the server's refusal as it is.
  assert.equal(completionRefused({ kind: 'server_refused', code: 'double_spend', message: 'the server refused cosign_transfer (409 double_spend)' }), true)
  // The request stands and may still be co-signed: the offer is not gone.
  assert.equal(completionRefused({ kind: 'unreachable', message: 'cannot reach the server' }), false)
  // The maker's own coin is still sending a completion posted before: not gone either.
  assert.equal(completionRefused({ kind: 'refused', message: 'refused: coin ab is sending now, not held for the swap' }), false)
  assert.equal(completionRefused(null), false)
})

test('the gone answer names whose coin, and carries the offer made in its place', () => {
  const e = { kind: 'swap_refused', code: 'double_spend', whose: 'taker', coin: 'c0'.repeat(32), message: 'refused: …' }
  const again = { swap: 'ee'.repeat(32), offer: 'arca-offer:…', give: '511116118', want: '9999992', expires_at: 1794500000 }
  assert.deepEqual(goneAnswer('aa'.repeat(32), e, again), { error: 'refused: …', swap: 'aa'.repeat(32), gone: true, code: 'double_spend',
    whose: 'taker', coin: 'c0'.repeat(32), offer: again })
  const none = goneAnswer('aa'.repeat(32), { kind: 'server_refused', code: 'margin', message: 'm' }, null)
  assert.equal(none.gone, true)
  assert.equal(none.whose, null)
  assert.equal('offer' in none, false, 'no offer when the maker cannot make one')
})

test('the offer made in place of a gone one asks the live price, and only when that asks no more than before', () => {
  // The live price asks less: the taker gets the better price.
  assert.equal(againWant('9999992', '9999000'), 9999000n)
  assert.equal(againWant('9999992', '9999992'), 9999992n)
  // The price moved against the taker since: no offer, so a refused acceptance never holds a
  // stale price; the taker asks for a new one.
  assert.equal(againWant('9999992', '10000001'), null)
  // The maker cannot price it now (it does not hold that much, the asset is capped, no room).
  assert.equal(againWant('9999992', null), null)
})

test('a swap not open here and never refused is not called gone: it may have been co-signed', () => {
  // The maker cancelled it at its lapse, its completion's answer lost and taken by a later sync:
  // a wallet that re-priced on "gone" would trade twice.
  const a = notOpenAnswer('cancelled')
  assert.equal(a.gone, undefined)
  assert.equal(a.state, 'cancelled')
  assert.equal(notOpenAnswer(undefined).gone, undefined)
})
