// The leaf maker's quote ladder: depth at several levels, published cumulatively, and a firm
// offer that never asks more than the quote a taker sized it against.
import test from 'node:test'
import assert from 'node:assert/strict'
import { perAsset, ladderOf, slicesOf, ladderQuotes, walkWant } from './leaf-maker-ladder.mjs'
import { quotesFrom } from './leaf-maker.mjs'

const ceilDiv = (a, b) => (a + b - 1n) / b
const LAD = { levels: 8, stepBps: 25, growth: 1.25 }
const RATE = { rate_num: '89250000', rate_den: '100000000' } // 0.8925 want atoms a give atom

test('eight slices, the touch smallest, sizes growing, every atom held quoted once, rates rising', () => {
  const s = slicesOf(RATE, 1_000_000_000n, 1_000_000n, LAD)
  assert.equal(s.length, 8)
  assert.equal(s.reduce((n, x) => n + x.size, 0n), 1_000_000_000n)
  for (let k = 1; k < 8; k++) {
    assert.ok(s[k].size > s[k - 1].size, 'sizes grow')
    assert.ok(s[k].rate_num > s[k - 1].rate_num, 'each level further from the touch')
    assert.equal(s[k].rate_den, s[0].rate_den, 'one denominator')
  }
  assert.equal(s[0].rate_num, 89250000n)
  assert.equal(s[7].rate_num, ceilDiv(89250000n * 10175n, 10000n)) // 7 × 25 bps further
})

test('published cumulatively: quote k has level k\'s rate and the depth of levels 1..k', () => {
  const s = slicesOf(RATE, 1_000_000_000n, 1_000_000n, LAD)
  const q = ladderQuotes('aa', 'bb', s, 1_000_000n)
  assert.equal(q.length, 8)
  let cum = 0n
  q.forEach((x, k) => {
    cum += s[k].size
    assert.equal(x.max_give, String(cum)); assert.equal(x.rate_num, String(s[k].rate_num)); assert.equal(x.min_give, '1000000')
    assert.equal(x.give_asset, 'aa'); assert.equal(x.want_asset, 'bb')
  })
  assert.equal(q[7].max_give, '1000000000')
})

test('a firm walk never asks more than any quote that carries its size, and never less than the touch', () => {
  const s = slicesOf(RATE, 987_654_321n, 1_000n, LAD)
  const q = ladderQuotes('aa', 'bb', s, 1_000n)
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
  for (let i = 0; i < 2000; i++) {
    const give = BigInt(1000 + (rnd() % 987_653_000))
    const w = walkWant(s, give)
    assert.ok(w, 'carried')
    for (const x of q) {
      if (BigInt(x.max_give) < give) continue
      // what the composer reads off quote x for this size
      assert.ok(w.want <= ceilDiv(give * BigInt(x.rate_num), BigInt(x.rate_den)), `give ${give}: walk ${w.want} over quote ${x.rate_num}`)
    }
    assert.ok(w.want >= ceilDiv(give * s[0].rate_num, s[0].rate_den), 'at least the touch')
  }
  assert.equal(walkWant(s, 987_654_322n), null, 'more than the ladder holds')
  assert.equal(walkWant(s, 0n), null)
})

test('fewer levels when the holding cannot give each its minimum; none below the minimum', () => {
  const s = slicesOf(RATE, 5_000_000n, 1_000_000n, LAD)
  assert.ok(s.length >= 1 && s.length < 8)
  assert.ok(s.every((x) => x.size >= 1_000_000n))
  assert.equal(s.reduce((n, x) => n + x.size, 0n), 5_000_000n)
  assert.deepEqual(slicesOf(RATE, 999_999n, 1_000_000n, LAD), [])
})

test('without a ladder a pair is one quote of all it holds, as before', () => {
  const pairs = [{ give: 'a'.repeat(64), want: 'b'.repeat(64), rate_num: '2', rate_den: '1', min_give: '10' }]
  const sp = new Map([['a'.repeat(64), 1000n]])
  assert.deepEqual(quotesFrom(pairs, sp, new Map(), '100'), [{ give_asset: 'a'.repeat(64), want_asset: 'b'.repeat(64), rate_num: '2', rate_den: '1', min_give: '10', max_give: '900' }])
  const laddered = quotesFrom(pairs, new Map([['a'.repeat(64), 1_000_100n]]), new Map(), '100', new Map(), { ladder: { levels: 8, step_bps: 25, growth: 1.25 } })
  assert.equal(laddered.length, 8)
  assert.equal(laddered[7].max_give, '1000000')
  // a pair's own ladder wins over the maker's
  assert.equal(quotesFrom([{ ...pairs[0], ladder: { levels: 3 } }], new Map([['a'.repeat(64), 1_000_100n]]), new Map(), '100', new Map(), { ladder: { levels: 8 } }).length, 3)
})

test('per-asset settings: the asset\'s own, else default, else the old value; a string for every asset', () => {
  assert.equal(perAsset({ aa: '5', default: '7' }, 'aa', '1'), '5')
  assert.equal(perAsset({ aa: '5', default: '7' }, 'bb', '1'), '7')
  assert.equal(perAsset({ aa: '5' }, 'bb', '1'), '1')
  assert.equal(perAsset('9', 'bb', '1'), '9')
  assert.equal(perAsset(undefined, 'bb', '1'), '1')
  assert.deepEqual(ladderOf({}, null), { levels: 1, stepBps: 0, growth: 1 })
})
