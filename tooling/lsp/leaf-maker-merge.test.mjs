// The maker keeps a bounded number of coins of an asset: past its cap it merges the smallest.
//
//   node --test tooling/lsp/leaf-maker-merge.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { coinsToMerge, MAX_COINS, MERGE_PER_PASS } from './leaf-maker.mjs'

const coin = (id, value, kind = 'board', asset = 'a', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })

test('under the cap nothing is merged; over it the smallest, enough to reach the cap', () => {
  const few = Array.from({ length: MAX_COINS }, (_, k) => coin('c' + k, 100 + k))
  assert.deepEqual(coinsToMerge(few, 'a', MAX_COINS), [])
  const many = [...few, coin('x1', 5), coin('x2', 7), coin('t', 1, 'transfer'), coin('o', 1, 'board', 'b'), coin('g', 1, 'board', 'a', 'given')]
  // 35 live coins of a, cap 32: four merged into one leaves 32; never a coin received, another
  // asset's or one not live.
  assert.deepEqual(coinsToMerge(many, 'a', MAX_COINS), ['x1', 'x2', 'c0', 'c1'])
  assert.deepEqual(coinsToMerge(many, 'a', MAX_COINS, ['x1']), ['x2', 'c0', 'c1', 'c2'])
})

test('a store of thousands is merged MERGE_PER_PASS a pass', () => {
  const lots = Array.from({ length: 4052 }, (_, k) => coin('c' + k, 2500000000000))
  const m = coinsToMerge(lots, 'a', MAX_COINS)
  assert.equal(m.length, MERGE_PER_PASS)
  assert.equal(new Set(m).size, m.length)
})
