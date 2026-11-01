// The maker's answers (a firm offer, an acceptance, a swap's state) run ahead of its upkeep, and ask
// the library for the re-check of the coins only; the upkeep's commands ask for the whole re-check.
//
//   node --test tooling/lsp/leaf-maker-answer.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { commandArgs } from './leaf-maker.mjs'

test('a command answering a taker re-checks the coins only; the upkeep\'s re-check everything', () => {
  assert.deepEqual(commandArgs({ give_asset: 'a', give: '5' }, true), { give_asset: 'a', give: '5', recheck: 'coins' })
  assert.deepEqual(commandArgs(undefined, true), { recheck: 'coins' })
  assert.deepEqual(commandArgs({ leaves: ['x'] }, false), { leaves: ['x'] })
  assert.deepEqual(commandArgs(undefined, false), {})
})

test('received coins are refreshed after their rest, at once on a start, and all at once when the bond is full', async () => {
  const { receivedDue, OUT_OF_ROUND_FULL } = await import('./leaf-maker.mjs')
  const coins = [
    { leaf_id: 'r1', kind: 'transfer', state: 'live' },
    { leaf_id: 'r2', kind: 'transfer', state: 'live' },
    { leaf_id: 'b1', kind: 'board', state: 'live' },
    { leaf_id: 'g1', kind: 'transfer', state: 'given' },
  ]
  const rest = 600000
  // A pass after a start: what it already holds is due at once.
  let seen = new Map()
  assert.deepEqual(receivedDue(coins, seen, 1e9, rest, { first: true }), ['r1', 'r2'])
  // A coin first seen later rests first.
  seen = new Map()
  assert.deepEqual(receivedDue(coins, seen, 1e9, rest), [])
  assert.deepEqual(receivedDue(coins, seen, 1e9 + rest - 1, rest), [])
  assert.deepEqual(receivedDue(coins, seen, 1e9 + rest + 1, rest), ['r1', 'r2'])
  // An offer refused for what is held out of round: every received coin now.
  seen = new Map()
  assert.deepEqual(receivedDue(coins, seen, 1e9, rest, { all: true }), ['r1', 'r2'])
  const why = 'refused: with this payment the wallet would hold out of round 106169746177161 atoms of the reference unit at this node\'s rates, more than the bond\'s 100000000000000: a double-sign would pay the operator more than its bond costs it; have coins refreshed in a round first'
  assert.ok(OUT_OF_ROUND_FULL.test(why))
  assert.ok(!OUT_OF_ROUND_FULL.test('refused: the wallet holds 0 of asset aa in live coins'))
})
