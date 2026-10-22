// The hold invoice's re-encoding: the node's own invoice with the hold's hash in its place, every
// other field as the node wrote it, and a checksum that verifies (the node's signinvoice decodes it).
import test from 'node:test'
import assert from 'node:assert/strict'
import { withPaymentHash } from './hold-bolt11.mjs'
import { decodeBolt11 } from '../../bolt11.js'

// BOLT 11's example invoice (2500u, `p` 0001020304…, description, one-minute expiry).
const INV = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
const H = 'ab'.repeat(32)

test('the hold\'s hash replaces the invoice\'s, and nothing else changes', () => {
  const before = decodeBolt11(INV)
  const out = withPaymentHash(INV, H)
  const after = decodeBolt11(out)
  assert.equal(after.ok, true, after.error)
  assert.equal(after.paymentHash, H)
  assert.notEqual(before.paymentHash, H)
  for (const k of ['network', 'amountMsat', 'minFinalCltv', 'timestamp', 'expiry']) assert.deepEqual(after[k], before[k], k)
  assert.equal(out.length, INV.length)
  // Only the 52 characters of `p` and the 6 of the checksum differ.
  let diff = 0; for (let i = 0; i < out.length; i++) if (out[i] !== INV[i]) diff++
  assert.ok(diff <= 58, `${diff} characters differ`)
  assert.equal(withPaymentHash(out, before.paymentHash), INV, 'the original hash puts the original invoice back')
})

test('refused: a hash that is not 32 bytes, a broken invoice', () => {
  assert.throws(() => withPaymentHash(INV, 'ab'), /32 bytes/)
  assert.throws(() => withPaymentHash(INV.slice(0, -1) + 'q', H), /checksum/)
  assert.throws(() => withPaymentHash('hello', H), /not a BOLT11/)
})
