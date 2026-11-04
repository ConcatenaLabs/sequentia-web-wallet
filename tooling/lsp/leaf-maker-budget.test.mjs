// The maker's instant budget: the room the library reports in each asset's atoms cuts its quotes,
// and a pair cut to nothing is named so a taker says the rest comes after the next round. The
// library's refusal past the budget counts as "full", so the maker refreshes what it holds at once.
//
//   node --test tooling/lsp/leaf-maker-budget.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetRoom, capQuotes, OUT_OF_ROUND_FULL, DEFAULT_INSTANT_BUDGET } from './leaf-maker.mjs'
import { makerEntries } from './single-step-book.mjs'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32), Z = 'cc'.repeat(32)
// Gives Y for X at 4 X per 1 Y (rate_num/rate_den = atoms of X wanted per atom of Y given).
const q = (max, min = '1000', want = X) => ({ give_asset: Y, want_asset: want, rate_num: '4', rate_den: '1', min_give: min, max_give: max })

test('the default share is a tenth', () => {
  assert.equal(DEFAULT_INSTANT_BUDGET, '0.1')
})

test('no budget, or a bond that does not stand: nothing to cut by', () => {
  assert.equal(budgetRoom(null), null)
  assert.equal(budgetRoom({ state: 'bonded', instant_budget: null }), null)
  assert.equal(budgetRoom({ instant_budget: { ppm: 100000, value: '0', room: '0' } }), null)
  const quotes = [q('500000')]
  assert.deepEqual(capQuotes(quotes, null), { quotes, later: [] })
})

test('quotes are cut to the room in the asset they want, and a pair cut to nothing is named', () => {
  const room = budgetRoom({ instant_budget: { room_atoms: { [X]: '1000000', [Y]: '250000' } } })
  assert.equal(room.get(X), 1000000n)
  // Within the room (100,000 Y wants 400,000 X): as it was.
  const within = capQuotes([q('100000')], room)
  assert.deepEqual(within, { quotes: [q('100000')], later: [] })
  // 500,000 Y would want 2,000,000 X: cut to the 250,000 Y the room of 1,000,000 X buys.
  const cut = capQuotes([q('500000')], room)
  assert.equal(cut.quotes[0].max_give, '250000')
  assert.equal(cut.quotes[0].after_next_round, true)
  // A ladder: every level past the room is cut to it.
  const ladder = capQuotes([q('100000'), q('300000'), q('600000')], room)
  assert.deepEqual(ladder.quotes.map((x) => [x.max_give, !!x.after_next_round]), [['100000', false], ['250000', true], ['250000', true]])
  // No room left: the pair is named, its quotes left out.
  const none = budgetRoom({ instant_budget: { room_atoms: { [X]: '3000' } } })
  assert.deepEqual(capQuotes([q('500000'), q('900000')], none), { quotes: [], later: [{ give_asset: Y, want_asset: X }] })
  // An asset the node does not price is not cut here (the library refuses it itself).
  assert.deepEqual(capQuotes([q('500000', '1000', Z)], room).quotes, [q('500000', '1000', Z)])
})

test('a lower price of the bond lowers the room, and the quotes with it, at once', () => {
  const before = capQuotes([q('500000')], budgetRoom({ instant_budget: { room_atoms: { [X]: '1600000' } } }))
  const after = capQuotes([q('500000')], budgetRoom({ instant_budget: { room_atoms: { [X]: '600000' } } }))
  assert.deepEqual([before.quotes[0].max_give, after.quotes[0].max_give], ['400000', '150000'])
})

test('a quote cut for the budget reaches the taker as `soon`', () => {
  const es = makerEntries('m', [{ ...q('250000'), after_next_round: true }, q('100000')], { payAsset: X, receiveAsset: Y })
  assert.deepEqual(es.map((e) => !!e.soon), [true, false])
})

test('the library\'s refusal past the budget counts as full', () => {
  assert.ok(OUT_OF_ROUND_FULL.test('refused: with this payment the wallet would hold out of round 1400000 atoms of the reference unit at this node\'s rates, past its instant budget of 1000000 (100000 millionths of the bond\'s 10000000): it takes the rest after the next round, once what it holds is refreshed'))
  assert.ok(OUT_OF_ROUND_FULL.test('with this payment the wallet would hold out of round 106165 atoms of asset aa, more than the bond\'s 100'))
  assert.ok(!OUT_OF_ROUND_FULL.test('refused: the wallet holds 0 of asset aa in live coins'))
})
