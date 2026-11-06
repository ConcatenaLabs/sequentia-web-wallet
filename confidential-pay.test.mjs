import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feeMarginAtoms, bucketAtoms, confidentialPlan, ownShare } from './confidential-pay.js'

const U = 100000000n // one unit of an asset of 8 decimals
const M = 4000n // the fee margin at a rate of 1e8

test('the fee margin: twice 1,000 vB at 2 per vB, in the asset\'s own atoms', () => {
  assert.equal(feeMarginAtoms(100000000n), 4000n)
  assert.equal(feeMarginAtoms(10000000000n), 40n)
  assert.equal(feeMarginAtoms(300000000n), 1334n)
  assert.throws(() => feeMarginAtoms(0n))
})

test('the round amount: the smallest power of ten above the need, at least one unit', () => {
  assert.equal(bucketAtoms(1n, 8), U)
  assert.equal(bucketAtoms(U + 8000n, 8), 10n * U)
  assert.equal(bucketAtoms(10n * U, 8), 10n * U)
  assert.equal(bucketAtoms(37n * U, 8), 100n * U)
  assert.equal(bucketAtoms(3n, 0), 10n)
})

test('instant holdings: a round amount moves out, never the payment\'s own', () => {
  // 1 USDX from 500,000 held for instant payments: 10 USDX move, not 1.00004.
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: 0n, instant: 500000n * U, minLeaf: 1000000n }), { move: 10n * U, hides: true })
  // Holding less than the round amount: all of it.
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: 0n, instant: 3n * U, minLeaf: 1000000n }), { move: 3n * U, hides: true })
  // What the chain holds counts toward the round amount.
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: 4n * U, instant: 100n * U }), { move: 0n, hides: true })
  assert.deepEqual(confidentialPlan({ amount: 5n * U, margin: M, onchain: 4n * U, instant: 100n * U }), { move: 6n * U, hides: true })
})

test('too little beside the payment: paid, and said that the amount shows; too little in all: refused', () => {
  // Exactly the payment and its fee, nothing more anywhere.
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: U + M, instant: 0n }), { move: 0n, hides: false })
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: 0n, instant: U + M }), { move: U + M, hides: false })
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: 0n, instant: U }), { short: M })
  // Less than the operator's least coin cannot be moved.
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: U, instant: 10n * U, minLeaf: 1000000n }), { move: 9n * U, hides: true })
  assert.deepEqual(confidentialPlan({ amount: U, margin: M, onchain: U + M, instant: 100n, minLeaf: 1000000n }), { move: 0n, hides: false })
})

test('the wallet\'s own output takes the rest, or nothing when that could not hide the amount', () => {
  assert.equal(ownShare({ amount: U, margin: M, onchain: 10n * U }), 9n * U - M)
  assert.equal(ownShare({ amount: U, margin: M, onchain: U + 2n * M }), M)
  assert.equal(ownShare({ amount: U, margin: M, onchain: U + 2n * M - 1n }), 0n)
})

test('on the chain the amount cannot be worked out: two outputs share what the inputs hold', () => {
  // Inputs 10 USDX in the clear, a fee f and a small change c in the clear; the payment and the
  // wallet's own output are both blinded. Every split of the rest fits the chain alike.
  const inputs = 10n * U, f = 517n, own = ownShare({ amount: U, margin: M, onchain: inputs })
  const c = inputs - U - own - f
  assert.ok(own > 0n && c >= 0n)
  const visible = inputs - f - c // all anyone reading the chain learns: payment + own
  for (const guess of [1n, U / 2n, U, 5n * U, visible - 1n]) assert.ok(guess > 0n && guess < visible)
})
