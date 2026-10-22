// The leaf maker's resting desk: its ladder sizes, each order's whole-atom price, when an order is
// repriced, and the relay offer that lists it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { restSizes, restTerms, offPrice, restOffer } from './leaf-maker-rest.mjs'

test('a resting ladder: level k is first × growth^k atoms of what is given', () => {
  assert.deepEqual(restSizes({ ladder: { levels: 4, growth: 1.4, first: '300000' } }, null), [300000n, 420000n, 587999n, 823199n])
  assert.deepEqual(restSizes({ ladder: { levels: 3 } }, null), [], 'no first level, no ladder')
})

test("an order's price is a whole number of atoms, step_bps a level further from the rate", () => {
  const t0 = restTerms(300000n, { rate_num: '47', rate_den: '40' }, 25, 0)
  assert.equal(t0.want, 352500n); assert.equal(t0.rate_num, 352500n); assert.equal(t0.rate_den, 300000n)
  const t3 = restTerms(823199n, { rate_num: '47', rate_den: '40' }, 25, 3)
  assert.equal(t3.want, 974514n, 'ceil(823199 × 47/40 × 1.0075)')
  assert.equal((t3.amount * t3.rate_num) % t3.rate_den, 0n)
})

test('an order is repriced only past reprice_bps', () => {
  const rec = { rate_num: '352500', rate_den: '300000' }
  assert.equal(offPrice(rec, { rate_num: '47', rate_den: '40' }, 300), false)
  assert.equal(offPrice(rec, { rate_num: '50', rate_den: '40' }, 300), true)
})

test('the relay offer of a resting order: its signed amount, the coin it rests at now, a listing before its delist time', () => {
  const now = 1_800_000_000
  const rec = { offer_id: 'aa'.repeat(16), amount: '300000' }
  const served = { order: 'bb'.repeat(32), asset: 'cc'.repeat(32), coin: 'dd'.repeat(32), value: '120000', expiry: now + 30 * 86400,
    terms: { asset_b: 'ee'.repeat(32), rate_num: '352500', rate_den: '300000', min_lot: '3000', maker: 'ff'.repeat(32), expiry: now + 7 * 86400, refund_key: '11'.repeat(32) } }
  const o = restOffer(rec, served, { server: 'http://op', operator: '22'.repeat(32) }, now, 21600)
  assert.equal(o.offer_amount, '300000'); assert.equal(o.want_amount, '352500')
  assert.equal(o.resting_leaf.coin, served.coin); assert.equal(o.resting_leaf.value, '120000')
  assert.ok(Number(o.expires_at_unix) <= now + 7 * 86400 - 21600)
  assert.equal(restOffer(rec, { ...served, terms: { ...served.terms, expiry: now + 21600 + 300 } }, { server: 's', operator: 'o' }, now, 21600), null, 'too near its delist time')
})
