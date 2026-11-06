// receive-index.js: New code moves to an address not shown before, and every address handed out is
// found by a scan from the phrase alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextReceiveIndex, shownReceiveIndex, RECEIVE_GAP } from './receive-index.js'

test('New code moves on from the address shown, from the first unused, and cycles within the gap', () => {
  assert.equal(nextReceiveIndex(null, 0), 0)
  assert.equal(nextReceiveIndex(0, 0), 1)
  assert.equal(nextReceiveIndex(3, 0), 4)
  // An address paid since: the next is past it.
  assert.equal(nextReceiveIndex(3, 7), 7)
  assert.equal(nextReceiveIndex(RECEIVE_GAP - 2, 0), RECEIVE_GAP - 1)
  assert.equal(nextReceiveIndex(RECEIVE_GAP - 1, 0), 0, 'back to the first unused, never past the gap')
  assert.equal(nextReceiveIndex(24, 5), 5)
  // Twenty presses show twenty different addresses.
  let i = 0; const seen = new Set([i])
  for (let k = 1; k < RECEIVE_GAP; k++) { i = nextReceiveIndex(i, 0); seen.add(i) }
  assert.equal(seen.size, RECEIVE_GAP)
})

test('the index kept from before is shown again while it is unused and within the gap', () => {
  assert.equal(shownReceiveIndex(null, 4), 4)
  assert.equal(shownReceiveIndex(9, 4), 9)
  assert.equal(shownReceiveIndex(3, 4), 4, 'paid since')
  assert.equal(shownReceiveIndex(4 + RECEIVE_GAP, 4), 4, 'past the gap')
  assert.equal(shownReceiveIndex('x', 4), 4)
})

// A scan from the phrase alone, as the kit's and the Bitcoin scan run: batches of the gap, on while
// a batch holds a payment. -> the highest index it reads.
function scanReach (paid, gap = RECEIVE_GAP) {
  let start = 0
  for (;;) {
    let any = false
    for (let i = start; i < start + gap; i++) if (paid.has(i)) any = true
    start += gap
    if (!any) return start - 1
  }
}

test('after any presses and payments, a restore finds every address a code showed', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let run = 0; run < 200; run++) {
    const paid = new Set(); const shown = new Set()
    let nextUnused = 0, i = shownReceiveIndex(null, 0)
    shown.add(i)
    for (let step = 0; step < 300; step++) {
      if (rnd() < 0.15) { paid.add(i); nextUnused = Math.max(nextUnused, i + 1); i = shownReceiveIndex(i, nextUnused) } else i = nextReceiveIndex(i, nextUnused)
      shown.add(i)
    }
    // Any of the addresses shown may be paid later, after the wallet is gone: each must be within
    // reach of a scan that knows only the payments made so far, plus that one.
    for (const s of shown) assert.ok(s <= scanReach(new Set([...paid, s])), `address ${s} found after a restore (run ${run})`)
  }
})
