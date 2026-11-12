// The maker never gives the last free coin of an asset it quotes to a round (sequentia-testnet-ops
// #235): whatever its upkeep settles or cuts, the coin its largest quote is sized on stays free
// while nothing else free fills a working coin's trade, and goes in a later turn; an asset's only
// free coin, due itself, is split first, so the asset stays in the book at half its quote.
//
// Each case runs the upkeep's choice (keepFree, or on a maker without it every due coin) and then
// the quote and the firm offer as the maker makes them (budgetedSpendable, slicesFor, walkWant),
// from the coins as the pass leaves them.
//
//   node --test tooling/lsp/leaf-maker-keep-free.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import * as maker from './leaf-maker.mjs'
import { walkWant } from './leaf-maker-ladder.mjs'

const { budgetedSpendable, roomNow, quotesFrom, slicesFor, workingSizes, receivedDue, settleGroups, shapeFor } = maker

// The upkeep's choice of what to give: keepFree's, or, without it, every coin due.
const choose = (coins, due, book) => (maker.keepFree ? maker.keepFree(coins, due, book) : { give: due, keep: [], split: [] })

const big = (v) => BigInt(v)
const coin = (id, value, asset, kind = 'transfer', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })
// The live box's shape at 1:1 rates (1 atom = 1 reference atom): a budget of 40,000,000, so a
// working coin of 10,000,000.
const BUDGET = 40_000_000n
const bond = (held = 0n) => ({ instant_budget: { ppm: 100000, value: String(BUDGET), held_value: String(held), room: String(BUDGET - held) } })
const rates = new Map([['X', 100_000_000n], ['U', 100_000_000n], ['G', 100_000_000n], ['S', 100_000_000n]])
const sizes = workingSizes(bond(), rates)
const pairs = ['U', 'G', 'S'].map((a) => ({ give: a, want: 'X', rate_num: '1', rate_den: '1', min_give: '10000' }))
const cfg = { pairs }
const least = maker.leastGives ? maker.leastGives(cfg) : {}

// What the maker quotes of `asset` from `coins`: the largest give of its quotes giving it.
function quoted (coins, asset) {
  const sp = new Map()
  for (const c of coins) if (c.state === 'live') sp.set(c.asset, (sp.get(c.asset) || 0n) + big(c.value))
  const spend = budgetedSpendable(sp, coins, roomNow(BUDGET, coins, rates), rates)
  return quotesFrom(pairs, spend, new Map(), 0, new Map(), cfg).filter((q) => q.give_asset === asset).reduce((m, q) => (big(q.max_give) > m ? big(q.max_give) : m), 0n)
}
// Whether a firm offer of `give` of `asset` is answered from `coins` (the maker's firmTerms).
function firm (coins, asset, give) {
  const sp = new Map()
  for (const c of coins) if (c.state === 'live') sp.set(c.asset, (sp.get(c.asset) || 0n) + big(c.value))
  const sl = slicesFor(pairs.find((p) => p.give === asset), budgetedSpendable(sp, coins, roomNow(BUDGET, coins, rates), rates), new Map(), 0, new Map(), cfg)
  return !!(sl && give >= sl.min && walkWant(sl.slices, give))
}
// The upkeep's pass past half its budget: every received coin due, the choice made, and what it
// gives is given (state `given`); a split leaves two coins of the halves in its place.
function pass (coins) {
  const due = receivedDue(coins, new Map(), 1_000_000, 600_000, { all: true })
  const book = { roomValue: roomNow(BUDGET, coins, rates), rates, sizes, least }
  const plan = choose(coins, due, book)
  const given = new Set(settleGroups(coins, plan.give, sizes).flatMap((g) => g.leaves))
  let out = coins.map((c) => (given.has(c.leaf_id) ? { ...c, state: 'given' } : c))
  for (const s of plan.split) {
    out = out.filter((c) => c.leaf_id !== s.leaf)
    out.push(coin(s.leaf + '-paid', s.pay, s.asset), coin(s.leaf + '-change', big(s.value) - big(s.pay), s.asset))
  }
  return { coins: out, plan }
}

test('a maker holding one large coin of an asset receives more of it: after its upkeep, a quote giving that asset is still answered firm', () => {
  // USDX as the box's BTC maker held it: every coin of it received, one large.
  const coins = [coin('u-large', 9_000_000, 'U'), coin('u-1', 700_000, 'U'), coin('u-2', 450_000, 'U'), coin('x1', 5_000_000, 'X', 'batch')]
  const before = quoted(coins, 'U')
  assert.equal(before, 9_000_000n, 'the quote is sized on the large coin')
  const { coins: after, plan } = pass(coins)
  assert.ok(firm(after, 'U', before), `a firm offer for the ${before} quoted is answered after the upkeep (gave ${JSON.stringify(plan.give)})`)
  assert.equal(quoted(after, 'U'), before, 'and the quote stands')
  // The rest went to the round.
  assert.deepEqual(plan.give.sort(), ['u-1', 'u-2'])
  assert.deepEqual(plan.keep, [{ leaf: 'u-large', asset: 'U' }])
})

test('the same with three assets at once, as the box\'s maker settled USDX, GOLD and SEQ in one pass', () => {
  const coins = [
    coin('u-large', 9_000_000, 'U'), coin('u-1', 700_000, 'U'), coin('u-2', 450_000, 'U'),
    coin('g-large', 6_000_000, 'G'), coin('g-1', 1_200_000, 'G'),
    coin('s-large', 8_000_000, 'S'), coin('s-1', 300_000, 'S'), coin('s-2', 100_000, 'S'),
  ]
  const before = Object.fromEntries(['U', 'G', 'S'].map((a) => [a, quoted(coins, a)]))
  const { coins: after, plan } = pass(coins)
  for (const a of ['U', 'G', 'S']) {
    assert.ok(before[a] > 0n)
    assert.ok(firm(after, a, before[a]), `${a}: the ${before[a]} quoted is answered firm after the upkeep`)
  }
  assert.deepEqual(plan.give.sort(), ['g-1', 's-1', 's-2', 'u-1', 'u-2'])
  assert.deepEqual(plan.keep.map((k) => k.leaf).sort(), ['g-large', 's-large', 'u-large'])
})

test('a maker whose only coin of an asset is itself due stays in the book with a smaller quote rather than none', () => {
  const coins = [coin('g-only', 6_000_000, 'G'), coin('x1', 5_000_000, 'X', 'batch')]
  const before = quoted(coins, 'G')
  assert.equal(before, 6_000_000n)
  const first = pass(coins)
  const q1 = quoted(first.coins, 'G')
  assert.ok(q1 > 0n, `after the upkeep it still quotes the asset (${q1})`)
  assert.ok(q1 < before, 'a smaller quote: it was split')
  assert.deepEqual(first.plan.split, [{ leaf: 'g-only', asset: 'G', value: '6000000', pay: '3000000' }])
  // The next pass gives one half to the round and keeps the other.
  const second = pass(first.coins)
  assert.equal(second.plan.give.length, 1)
  assert.equal(second.plan.keep.length, 1)
  assert.equal(quoted(second.coins, 'G'), 3_000_000n, 'the asset stays in the book at half its quote')
  // While that half is in its round, the kept half stays; once it is back, the kept half goes.
  assert.deepEqual(pass(second.coins).plan.give, [], 'not while the other half is in its round')
  const back = second.coins.filter((c) => c.state !== 'given').concat([coin('g-back', 3_000_000, 'G', 'batch')])
  const third = pass(back)
  assert.equal(third.plan.give.length, 1, 'once it is back, the kept half goes in its turn')
  assert.equal(quoted(third.coins, 'G'), 3_000_000n, 'and the coin back from the round is quoted')
})

test('the kept coin goes in its turn: once the coins back from the round fill a working coin\'s trade', () => {
  const size = sizes.get('U')
  assert.equal(size, 10_000_000n)
  // A large received coin, and working coins back from the round: it goes, the quote falls to a
  // working coin, never to none.
  const coins = [coin('u-large', 15_000_000, 'U'), coin('w1', size, 'U', 'batch'), coin('w2', size, 'U', 'batch')]
  const { coins: after, plan } = pass(coins)
  assert.deepEqual(plan.give, ['u-large'])
  assert.equal(quoted(after, 'U'), size)
  // Nothing due that matters: every due coin goes when coins not due fill the quote.
  const plenty = [coin('u-1', 700_000, 'U'), coin('w1', size, 'U', 'batch')]
  assert.deepEqual(pass(plenty).plan.give, ['u-1'])
})

test('a coin halved below the smallest quote is kept whole; one of an asset not priced is no quote to keep', () => {
  // 15,000 halves to 7,500, under the pairs' 10,000.
  const small = [coin('s-only', 15_000, 'S')]
  const p = pass(small).plan
  assert.deepEqual([p.give, p.split], [[], []])
  assert.deepEqual(p.keep, [{ leaf: 's-only', asset: 'S' }])
  // A coin of an asset the node does not price pays no quote under a budget, so settling it costs
  // the book nothing. (A coin out of round always fits the room: its spend puts nothing more out.)
  const unpriced = [coin('z-1', 50_000_000, 'Z')]
  assert.deepEqual(pass(unpriced).plan.give, ['z-1'])
})

test('a resting order\'s coin and a coin held as spent elsewhere fill no quote', () => {
  const coins = [coin('u-1', 2_000_000, 'U'), { ...coin('o-1', 9_000_000, 'U', 'batch'), template: 'order-3' }, { ...coin('e-1', 9_000_000, 'U', 'batch'), spent_elsewhere_until: 99 }]
  const p = pass(coins).plan
  assert.deepEqual(p.split.map((s) => s.leaf), ['u-1'], 'its only free coin: split, not given')
})

test('a cut is no different: the only free coin of an asset is not cut while nothing else would quote', () => {
  // A reserve coin and no working coins: shapeFor would cut it, giving the asset's only coin.
  const coins = [coin('g-reserve', 30_000_000, 'G', 'batch')]
  assert.ok(shapeFor(coins, 'G', sizes.get('G')))
  const book = { roomValue: roomNow(BUDGET, coins, rates), rates, sizes, least }
  const after = maker.bookAfter(coins, 'G', ['g-reserve'], book)
  assert.ok(after.need > 0n && after.best < after.target, 'the upkeep skips the cut this pass')
  // With a working coin free beside it, the cut goes.
  const two = [...coins, coin('w1', sizes.get('G'), 'G', 'batch')]
  const ok = maker.bookAfter(two, 'G', ['g-reserve'], { ...book, roomValue: roomNow(BUDGET, two, rates) })
  assert.ok(ok.best >= ok.target)
})
