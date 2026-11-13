// The maker's book is kept while it reads its coins again or reshapes them (web #659): between two
// readings it offers from what it knows it holds (knownCoins), less what its trades took and what it
// gave to a round; and a desk never deadlocks on an asset the operator caps (withinHeadroom,
// intakeStopped).
//
//   node --test tooling/lsp/leaf-maker-book-kept.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { knownCoins, madeBy, leavesOf, budgetHeld, roomNow, budgetedSpendable, headroomOf, intakeStopped, withinHeadroom, lineageSummary, UNREAD } from './leaf-maker.mjs'
import { spendableFrom } from '../../user-trade.js'

const G = 'aa'.repeat(32), U = 'bb'.repeat(32), S = 'cc'.repeat(32)
const rates = new Map([[G, 100_000_000n], [U, 100_000_000n], [S, 100_000_000n]])
const coin = (id, asset, value, kind = 'batch', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })

test('a firm offer holds its coins in the book until the next reading, and the rest stays offered', () => {
  const coins = [coin('g1', G, 1000), coin('g2', G, 800), coin('u1', U, 5000)]
  const changes = [{ at: 20, kind: 'offered', leaves: ['g1'], id: 's1' }]
  const v = knownCoins(coins, changes, 10)
  assert.equal(v.find((c) => c.leaf_id === 'g1').state, 'offered')
  const sp = spendableFrom(v, { plans: [] })
  assert.equal(sp.get(G), 800n, 'g2 still offered')
  // The room counts the offered round coin; the other still fits.
  const room = roomNow(10_000n, v, rates)
  assert.equal(room, 9000n)
  assert.equal(budgetedSpendable(sp, v, room, rates).get(G), 800n)
})

test('a completed trade leaves its coins out and counts its change and what it was paid, until read', () => {
  const coins = [coin('g1', G, 1000, 'batch', 'offered'), coin('g2', G, 800)]
  const changes = [{ at: 20, kind: 'done', leaves: ['g1'], id: 's1', made: [{ asset: U, value: '900' }, { asset: G, value: '100' }] }]
  const v = knownCoins(coins, changes, 10)
  assert.ok(!v.some((c) => c.leaf_id === 'g1'))
  const unread = v.filter((c) => c.state === UNREAD)
  assert.equal(unread.length, 2)
  assert.equal(spendableFrom(v, { plans: [] }).get(G), 800n, 'the change is not quoted before it is read')
  assert.equal(roomNow(10_000n, v, rates), 9000n, 'what the trade made counts against the room (900 + 100)')
  // A reading made after the trade already has it: nothing counted twice.
  const after = [coin('g2', G, 800), coin('c1', G, 100, 'transfer'), coin('r1', U, 900, 'transfer')]
  assert.deepEqual(knownCoins(after, changes, 10), after)
  // A change older than the reading is in it.
  assert.deepEqual(knownCoins(coins, changes, 30), coins)
})

test('coins given to a round leave the book at once', () => {
  const coins = [coin('g1', G, 1000), coin('g2', G, 800, 'transfer')]
  const v = knownCoins(coins, [{ at: 20, kind: 'given', leaves: ['g1', 'g2'] }], 10)
  assert.deepEqual(v.map((c) => c.state), ['given', 'given'])
  assert.equal(spendableFrom(v, { plans: [] }).get(G), undefined)
})

test('the library\'s answers name the coins and what a trade makes', () => {
  const o = { swap: 's', details: { inputs: [{ leaf_id: 'g1' }, { leaf_id: 'g2' }], outputs: [{ asset: U, value: '900' }, { asset: G, value: '50' }] } }
  assert.deepEqual(leavesOf(o), ['g1', 'g2'])
  assert.deepEqual(madeBy(o, U, 900n), [{ asset: U, value: '900' }, { asset: G, value: '50' }])
  assert.deepEqual(madeBy({ swap: 's' }, U, 900n), [{ asset: U, value: '900' }], 'an older library: what the offer asked')
  assert.deepEqual(leavesOf({ inputs: ['x'] }), ['x'], 'lightning_pay names its inputs')
  assert.deepEqual(leavesOf(null), [])
})

test('what fills the budget is summed by asset, kind and state', () => {
  const coins = [coin('r1', S, 5000, 'transfer'), coin('r2', S, 3000, 'transfer', 'given'), coin('b1', G, 700), coin('o1', G, 400, 'batch', 'offered')]
  const h = budgetHeld(coins, rates, (a) => (a === S ? 'SEQ' : 'GOLD'))
  assert.deepEqual(h.map((e) => [e.asset, e.kind, e.state, e.n, e.atoms]), [['SEQ', 'transfer', 'live', 1, '5000'], ['SEQ', 'transfer', 'given', 1, '3000'], ['GOLD', 'batch', 'offered', 1, '400']])
  const l = lineageSummary({ coins: [{ lineage: 'received', asset: S, kind: 'transfer', state: 'live', value: '5' }, { lineage: 'received', asset: S, kind: 'transfer', state: 'live', value: '7' }, { lineage: 'own', asset: S, kind: 'batch', state: 'spent', value: '9' }] })
  assert.deepEqual(l, [{ lineage: 'received', asset: S, kind: 'transfer', state: 'live', n: 2, atoms: '12' }])
})

// The box at 04:13Z on 2026-11-13: the operator's SEQ in flight 4.147e15 of a cap of 4.396e15, and the
// BTC desk holding 5.33e14 atoms of SEQ out of round.
const INFO = { assets: [{ asset: S, in_flight: '4146809801173023', in_flight_cap: '4395572007484306' }, { asset: G }] }

test('received coins of a capped asset settle in parts the operator can take on, the smallest first', () => {
  const room = headroomOf(INFO)
  assert.equal(room.get(S), 248762206311283n)
  assert.ok(!room.has(G))
  const coins = [coin('a', S, 200_000_000_000_000, 'transfer'), coin('b', S, 150_000_000_000_000, 'transfer'), coin('c', S, 183_445_400_305_576, 'transfer'), coin('g', G, 5, 'transfer')]
  const r = withinHeadroom([{ asset: S, leaves: ['a', 'b', 'c'], piece: null }, { asset: G, leaves: ['g'], piece: null }], coins, room)
  // 0.9 of the headroom is 223,885,985,680,154: the smallest, b, fits; b + c does not.
  assert.deepEqual(r.groups, [{ asset: S, leaves: ['b'], piece: null }, { asset: G, leaves: ['g'], piece: null }])
  assert.deepEqual(r.waiting, [{ asset: S, leaves: ['c', 'a'] }])
  // All of them at once (as before) is more than the operator takes on: it is held back and withdrawn.
  assert.ok(200_000_000_000_000n + 150_000_000_000_000n + 183_445_400_305_576n > room.get(S))
})

test('the maker takes in no more of an asset than the operator can take on of what it holds already', () => {
  assert.deepEqual([...intakeStopped(INFO, [{ asset: S, value: '533445400305576' }])], [S])
  assert.deepEqual([...intakeStopped(INFO, [{ asset: S, value: '1000' }])], [], 'a little held: it still takes SEQ in')
  assert.deepEqual([...intakeStopped({ assets: [{ asset: S, in_flight: '10', in_flight_cap: '10' }] }, [])], [S], 'a full cap, as before')
  assert.deepEqual([...intakeStopped(INFO, null)], [])
})
