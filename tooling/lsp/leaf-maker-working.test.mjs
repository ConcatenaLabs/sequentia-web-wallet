// A maker's working coins fit its budget (D94). A swap pays from one coin, and that coin's whole worth
// is then out of round until the next round; so the maker keeps coins of each asset it gives worth at
// most a quarter of its instant budget, cuts larger ones inside a round, merges none above that size,
// settles once it holds half its budget out of round, and shows no price it would then refuse.
//
//   node --test tooling/lsp/leaf-maker-working.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { workingSizes, shapeFor, budgetedSpendable, pastHalfBudget, settleGroups, mergeMost, coinsToMerge, capQuotes, quotesFrom, budgetRoom,
  WORKING_COUNT } from './leaf-maker.mjs'

const coin = (id, value, asset = 'G', kind = 'batch', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })

// The live box on 2026-11-07 (leaf-maker-btc): a bond of $1,750,355.80 (1 reference atom = $1e-8), an
// instant budget of 100000 millionths, so $175,035.58; GOLD at $4,075 a coin (rate 4075e8 reference
// atoms per 1e8 atoms); tSEQ at $0.175 (rate 17.5e6). Its smallest GOLD coin was $560,121, its tSEQ
// coins 1,069,280 tSEQ ($187,124) each.
const BUDGET = 17_503_558_000_000n
const bond = (held = 0n) => ({ instant_budget: { ppm: 100000, value: String(BUDGET), held_value: String(held), room: String(BUDGET - held) } })
const rates = new Map([['G', 407_500_000_000n], ['T', 17_500_000n], ['U', 100_000_000n]])
const GOLD_560K = 13_745_300_000n          // 137.453 GOLD ≈ $560,121
const TSEQ_COIN = 106_928_000_000_000n      // 1,069,280 tSEQ ≈ $187,124

test('a working coin is a quarter of the budget, in each asset at the node\'s rates, never a fixed number of atoms', () => {
  const s = workingSizes(bond(), rates)
  // $43,758.895 of each.
  assert.equal(s.get('U'), BUDGET / 4n * 100_000_000n / 100_000_000n)
  assert.equal(s.get('G'), (BUDGET / 4n) * 100_000_000n / 407_500_000_000n)
  assert.equal(s.get('T'), (BUDGET / 4n) * 100_000_000n / 17_500_000n)
  // The live coins that broke the budget are all above it.
  assert.ok(GOLD_560K > s.get('G'))
  assert.ok(TSEQ_COIN > s.get('T'))
  // The price doubles: the size in atoms halves, the worth stays a quarter of the budget.
  const s2 = workingSizes(bond(), new Map([['G', 815_000_000_000n]]))
  assert.equal(s2.get('G'), (BUDGET / 4n) * 100_000_000n / 815_000_000_000n)
  // No budget set: no size, the maker does as before.
  assert.equal(workingSizes({ instant_budget: null }, rates).size, 0)
})

test('the smallest reserve coin is cut into the working coins missing, one cut at a time', () => {
  const size = workingSizes(bond(), rates).get('G')
  // The box's GOLD: no coin at a working size; its smallest is the $560k coin.
  const coins = [coin('g1', GOLD_560K), coin('g2', 14_370_000_000n), coin('g3', 159_950_000_000n), coin('t1', TSEQ_COIN, 'T')]
  assert.deepEqual(shapeFor(coins, 'G', size), { leaf: 'g1', piece: String(size), pieces: WORKING_COUNT })
  // Two working coins already: two more.
  const two = [...coins, coin('w1', size), coin('w2', 1000n)]
  assert.equal(shapeFor(two, 'G', size).pieces, 2)
  // Four: nothing to cut.
  assert.equal(shapeFor([...two, coin('w3', size), coin('w4', size)], 'G', size), null)
  // While the coin an earlier cut gave up is still held, no second cut.
  assert.equal(shapeFor([...coins.slice(1), { ...coins[0], state: 'given' }], 'G', size, 'g1'), null)
  // Once it is spent (gone from the held coins), the next cut may run.
  assert.equal(shapeFor(coins.slice(1), 'G', size, 'g1').leaf, 'g2')
  // A coin received out of round (settling takes it) and a resting order's coin are never cut.
  assert.equal(shapeFor([coin('r', GOLD_560K, 'G', 'transfer'), { ...coin('o', GOLD_560K), template: 'order-3' }], 'G', size), null)
  // No size known: no cut.
  assert.equal(shapeFor(coins, 'G', null), null)
})

test('a quote gives at most the largest coin whose whole worth fits the room left', () => {
  const size = workingSizes(bond(), rates).get('G')
  const coins = [coin('g1', GOLD_560K), coin('w1', size), coin('w2', size / 2n), coin('u1', 5_000_000_000_000n, 'U')]
  const sp = new Map([['G', GOLD_560K + size + size / 2n], ['U', 5_000_000_000_000n]])
  // Room for the whole budget: the working coin, not the $560k coin (which would put $560k out of round).
  let out = budgetedSpendable(sp, coins, BUDGET, rates)
  assert.equal(out.get('G'), size)
  // $50k of USDX fits $175k of room.
  assert.equal(out.get('U'), 5_000_000_000_000n)
  // Room for less than a working coin: the half one.
  out = budgetedSpendable(sp, coins, size * 407_500_000_000n / 100_000_000n - 1n, rates)
  assert.equal(out.get('G'), size / 2n)
  // No room: nothing quoted of the asset, so no price shown that the maker would refuse.
  out = budgetedSpendable(sp, coins, 0n, rates)
  assert.equal(out.get('G'), 0n)
  assert.equal(quotesFrom([{ give: 'G', want: 'U', rate_num: '1', rate_den: '1', min_give: '1' }], out, new Map(), 0).length, 0)
  // No budget: as before.
  assert.equal(budgetedSpendable(sp, coins, null, rates), sp)
})

test('the box\'s refusal is not reproduced: a quote sized this way never passes the budget', () => {
  // The library refuses when held + the whole coin paid from (change and what comes in) passes the
  // budget. Every coin a quote may pay from fits the room, so held + its worth <= the budget.
  const size = workingSizes(bond(), rates).get('G')
  const coins = [coin('g1', GOLD_560K), coin('w1', size), coin('w2', size)]
  for (const held of [0n, BUDGET / 4n, BUDGET / 2n, BUDGET - 1n]) {
    const sp = budgetedSpendable(new Map([['G', GOLD_560K + 2n * size]]), coins, BUDGET - held, rates)
    const g = sp.get('G')
    const paidFrom = coins.filter((c) => BigInt(c.value) >= g && g > 0n).map((c) => BigInt(c.value)).sort((a, b) => (a < b ? -1 : 1))[0] || 0n
    assert.ok(held + paidFrom * 407_500_000_000n / 100_000_000n <= BUDGET, `held ${held}: gives ${g} from ${paidFrom}`)
  }
  // Without the bound (as on the box), the $560k coin is what a GOLD sale reaches once the working
  // coins are gone, and the refusal follows: 56012283375553 > 17503558000000.
  assert.ok(GOLD_560K * 407_500_000_000n / 100_000_000n > BUDGET)
})

test('past half its budget out of round, it settles at once', () => {
  assert.equal(pastHalfBudget(bond(BUDGET / 2n)), false)
  assert.equal(pastHalfBudget(bond(BUDGET / 2n + 1n)), true)
  assert.equal(pastHalfBudget({}), false)
})

test('settling cuts each asset into working coins, one participation an asset', () => {
  const sizes = new Map([['G', 100n], ['U', 50n]])
  const coins = [coin('a', 300, 'G', 'transfer'), coin('b', 20, 'U', 'transfer'), coin('c', 30, 'G', 'transfer'), coin('d', 9, 'X', 'transfer')]
  assert.deepEqual(settleGroups(coins, ['a', 'b', 'c', 'd'], sizes), [
    { asset: 'G', leaves: ['a', 'c'], piece: '100' },
    { asset: 'U', leaves: ['b'], piece: '50' },
    { asset: 'X', leaves: ['d'], piece: null },
  ])
})

test('no merge builds a coin above a working coin', () => {
  // merge_max_coins x coin_size would allow 4 x 66,769 tSEQ; the working size is the lower bound.
  const cfg = { merge_max_coins: 4, coin_size: '6676929330769' }
  assert.equal(mergeMost(cfg, 'T', 1_000n), 1_000n)
  assert.equal(mergeMost(cfg, 'T', 10n ** 18n), 4n * 6_676_929_330_769n)
  assert.equal(mergeMost({}, 'T', 1_000n), 1_000n)
  assert.equal(mergeMost({}, 'T'), null)
  const many = Array.from({ length: 40 }, (_, i) => coin('m' + i, 300, 'T'))
  const merged = coinsToMerge(many, 'T', 32, [], null, mergeMost({}, 'T', 1_000n))
  assert.equal(merged.length, 3, 'three coins of 300 fit under 1,000')
})

test('the room cut and the coin cut agree with what the library will take in', () => {
  // capQuotes still cuts by what comes in; budgetedSpendable by the coin paid from. Both apply.
  const room = budgetRoom({ instant_budget: { room_atoms: { U: '1000' } } })
  const q = capQuotes([{ give_asset: 'G', want_asset: 'U', rate_num: '2', rate_den: '1', min_give: '1', max_give: '900' }], room)
  assert.equal(q.quotes[0].max_give, '500')
})
