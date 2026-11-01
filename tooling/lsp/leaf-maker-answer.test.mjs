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
