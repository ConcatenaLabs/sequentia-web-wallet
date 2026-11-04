// The maker keeps a bounded number of coins of an asset: past its cap it merges boards first, then
// the smallest coins of a round, down to three quarters of the cap, and never merges its own merged
// coin again and again.
//
//   node --test tooling/lsp/leaf-maker-merge.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { coinsToMerge, MAX_COINS, MERGE_PER_PASS, MERGE_TO } from './leaf-maker.mjs'

const coin = (id, value, kind = 'batch', asset = 'a', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })

test('under the cap nothing is merged; over it boards first, then the smallest, down to three quarters of the cap', () => {
  const few = Array.from({ length: MAX_COINS }, (_, k) => coin('c' + k, 100 + k))
  assert.deepEqual(coinsToMerge(few, 'a', MAX_COINS), [])
  const many = [...few, coin('x1', 5), coin('b1', 900, 'board'), coin('t', 1, 'transfer'), coin('o', 1, 'batch', 'b'), coin('g', 1, 'batch', 'a', 'given')]
  // 35 live coins of a, cap 32: merged down to 24, so 12 into one; never a coin received, another
  // asset's or one not live; the board first, whatever its size.
  const m = coinsToMerge(many, 'a', MAX_COINS)
  assert.equal(m.length, 35 - Math.floor(MAX_COINS * MERGE_TO) + 1)
  assert.deepEqual(m.slice(0, 4), ['b1', 'x1', 'c0', 'c1'])
  assert.ok(!m.includes('t') && !m.includes('o') && !m.includes('g'))
  assert.deepEqual(coinsToMerge(many, 'a', MAX_COINS, ['x1']).slice(0, 3), ['b1', 'c0', 'c1'])
})

test('a store of thousands is merged MERGE_PER_PASS a pass', () => {
  const lots = Array.from({ length: 4052 }, (_, k) => coin('c' + k, 2500000000000))
  const m = coinsToMerge(lots, 'a', MAX_COINS)
  assert.equal(m.length, MERGE_PER_PASS)
  assert.equal(new Set(m).size, m.length)
})

// Seen live: a maker boarding one coin of its coin size a pass merged it with its last merge's coin
// each time, so every merge gave up in a round all it had boarded so far (22k, 44k, ... 580k).
test('a merge\'s own coin, above the coin size, is not merged again while under twice the cap', () => {
  const SIZE = 22327n
  const big = Array.from({ length: 31 }, (_, k) => coin('big' + k, 10_000_000 + k))
  const acc = coin('acc', String(SIZE * 9n))
  // A board arrives and one received coin is settled into a coin of a round: 33 live.
  const now = [...big, acc, coin('board', String(SIZE), 'board'), coin('settled', '5000')]
  const m = coinsToMerge(now, 'a', MAX_COINS, [], String(SIZE))
  assert.deepEqual(m, ['board', 'settled'])
  // Only the accumulator and big coins besides one small one: nothing to merge, nothing fronted.
  assert.deepEqual(coinsToMerge([...big, acc, coin('one', '100')], 'a', MAX_COINS, [], String(SIZE)), [])
  // At twice the cap the bound is a store's size again: the smallest coins of all, as few as bring
  // the count back under it.
  const flood = Array.from({ length: 2 * MAX_COINS }, (_, k) => coin('f' + k, 10_000_000 + k))
  assert.deepEqual(coinsToMerge(flood, 'a', MAX_COINS, [], String(SIZE)), Array.from({ length: MAX_COINS / 4 + 1 }, (_, k) => 'f' + k))
})

// The fronting a maker's merges cause, boarding one coin a pass for 60 passes into 31 large coins:
// with the old rule (the two smallest at every coin past the cap) the merges gave up the growing
// merge coin each time; with this one they give up only boards and small coins.
for (const CAP of [8, MAX_COINS]) test(`boarding sixty coins at a cap of ${CAP} fronts little, not a growing merge coin`, () => {
  const SIZE = 22327n
  const run = (pick, boardCap) => {
    let coins = [...Array.from({ length: CAP - 1 }, (_, k) => coin('big' + k, 10_000_000_000n + BigInt(k))), coin('acc', String(SIZE))]
    let fronted = 0n, n = 0, boarded = 0
    for (let i = 0; i < 60; i++) {
      if (coins.length < boardCap) { coins.push(coin('board' + i, String(SIZE), 'board')); boarded++ }
      const m = pick(coins)
      if (m.length >= 2) {
        const given = coins.filter((c) => m.includes(c.leaf_id))
        fronted += given.filter((c) => c.kind !== 'board').reduce((s, c) => s + BigInt(c.value), 0n)
        coins = coins.filter((c) => !m.includes(c.leaf_id))
        coins.push(coin('merge' + (n++), String(given.reduce((s, c) => s + BigInt(c.value), 0n))))
      }
    }
    return { fronted, boarded }
  }
  const old = (coins) => {
    const live = coins.filter((c) => c.state === 'live')
    if (live.length <= CAP) return []
    return live.filter((c) => c.kind !== 'transfer').sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1))
      .slice(0, Math.min(MERGE_PER_PASS, live.length - CAP + 1)).map((c) => c.leaf_id)
  }
  // Live, the old rule boarded at every pass (its count held received coins too) and merged at once.
  const before = run(old, Infinity), after = run((coins) => coinsToMerge(coins, 'a', CAP, [], String(SIZE)), 2 * CAP)
  console.log(`cap ${CAP}, 60 passes boarding coins of ${SIZE}: the old rule boarded ${before.boarded} and its merges fronted ${before.fronted}; ` +
    `this one boarded ${after.boarded} and fronted ${after.fronted}`)
  // Every coin is boarded either way; the old rule fronted the growing merge coin at every board.
  assert.equal(after.boarded, 60)
  assert.equal(before.boarded, 60)
  assert.ok(before.fronted > 25n * 60n * SIZE, String(before.fronted))
  assert.ok(after.fronted <= 60n * SIZE * 2n, String(after.fronted))
})
