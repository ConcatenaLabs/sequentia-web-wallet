// btc-ark-history.js: History's rows from the Bitcoin ark wallet's own record of its movements.
import test from 'node:test'
import assert from 'node:assert/strict'
import { arkMovementRows, keptMovements } from './btc-ark-history.js'
import { instantRows } from './instant-history.js'

const H = 'ab'.repeat(32), T = 'cd'.repeat(32)
const mv = (id, name, kind, eff, extra = {}) => ({
  id, status: 'successful', subsystem: { name, kind }, metadata: {},
  intended_balance: eff, effective_balance: eff, offchain_fee: 0, sent_to: [], received_on: [],
  input_vtxos: [], output_vtxos: [], exited_vtxos: [],
  time: { created_at: '2026-11-07T10:00:0' + id + '+01:00', updated_at: '2026-11-07T10:00:0' + id + '+01:00', completed_at: null },
  ...extra,
})

test('a payment received in the ark is a row, newest first', () => {
  const rows = arkMovementRows([
    mv(1, 'bark.arkoor', 'receive', 100000),
    mv(2, 'bark.lightning_receive', 'receive', 50000, { metadata: { payment_hash: H } }),
  ])
  assert.deepEqual(rows.map((r) => [r.kind, r.legs[0].asset, r.legs[0].atoms, r.ark]), [['in', 'BTC', '50000', '2'], ['in', 'BTC', '100000', '1']])
  assert.ok(rows[0].at > rows[1].at && rows[1].at === Date.parse('2026-11-07T10:00:01+01:00'))
})

test('a payment sent says what reached the other side, and the fee apart', () => {
  const [a, b, c] = arkMovementRows([
    mv(1, 'bark.arkoor', 'send', -20000, { sent_to: [{ destination: 'ark1x', amount: 20000 }] }),
    mv(2, 'bark.lightning_send', 'send', -30150, { offchain_fee: 150, sent_to: [{ destination: 'lntb', amount: 30000 }] }),
    mv(3, 'bark.offboard', 'offboard', -41000, { offchain_fee: 1000 }),
  ])
  assert.deepEqual([c.kind, c.legs[0].atoms, c.fee], ['out', '20000', undefined], 'no fee: none shown')
  assert.deepEqual([b.legs[0].atoms, b.fee], ['30000', { asset: 'BTC', atoms: '150' }])
  assert.deepEqual([a.legs[0].atoms, a.fee], ['40000', { asset: 'BTC', atoms: '1000' }], 'no recipient named: what left less the fee')
})

test('boards, exits and renewals are no payments; nor is what moved nothing', () => {
  const rows = arkMovementRows([
    mv(1, 'bark.board', 'board', 150000),
    mv(2, 'bark.exit', 'start', -10000),
    mv(3, 'bark.round', 'refresh', -300),
    mv(4, 'bark.lightning_receive', 'receive', 0, { status: 'pending' }),
    mv(5, 'bark.lightning_send', 'send', 0, { status: 'failed' }),
    mv(6, 'bark.arkoor', 'send', -500, { status: 'canceled' }),
  ])
  assert.deepEqual(rows, [])
})

test('a Lightning payment of a trade or of the move from the wallet\'s own channel has no row of its own', () => {
  const rows = arkMovementRows([
    mv(1, 'bark.lightning_send', 'send', -1000, { metadata: { payment_hash: H } }),
    mv(2, 'bark.lightning_receive', 'receive', 2000, { metadata: { payment_hash: T } }),
    mv(3, 'bark.lightning_receive', 'receive', 3000, { metadata: { payment_hash: 'ef'.repeat(32) } }),
  ], { skipHashes: [H.toUpperCase(), T, null] })
  assert.deepEqual(rows.map((r) => r.ark), ['3'])
})

test('a payment still on its way says so', () => {
  const [r] = arkMovementRows([mv(1, 'bark.lightning_send', 'send', -1000, { status: 'pending' })])
  assert.equal(r.pending, true)
})

test('the rows sort into History\'s one list with the page\'s own', () => {
  const ark = arkMovementRows([mv(1, 'bark.arkoor', 'receive', 100000)])
  const log = [{ kind: 'in', at: Date.parse('2026-11-01T00:00:00Z'), leaf: 'l', legs: [{ asset: 'aa'.repeat(32), atoms: '10' }] }]
  assert.deepEqual(instantRows([...log, ...ark], []).map((r) => r.legs[0].asset), ['BTC', 'aa'.repeat(32)])
})

test('what the page keeps between visits gives the same rows, without renewals or coin lists', () => {
  const all = [
    mv(1, 'bark.arkoor', 'receive', 100000, { output_vtxos: ['v1'] }),
    mv(2, 'bark.round', 'refresh', -300),
    mv(3, 'bark.lightning_send', 'send', -30150, { offchain_fee: 150, sent_to: [{ destination: 'lntb', amount: 30000 }], metadata: { payment_hash: H, htlc_vtxos: ['v2'] } }),
  ]
  const kept = keptMovements(all)
  assert.deepEqual(kept.map((m) => m.id), [3, 1])
  assert.ok(!JSON.stringify(kept).includes('v1') && !JSON.stringify(kept).includes('v2') && !JSON.stringify(kept).includes('lntb'))
  assert.deepEqual(arkMovementRows(kept), arkMovementRows(all))
  assert.deepEqual(arkMovementRows(kept, { skipHashes: [H] }).map((r) => r.ark), ['1'])
  assert.equal(keptMovements(all, 1).length, 1)
})

test('an answer that is not a list is no rows', () => {
  assert.deepEqual(arkMovementRows(null), [])
  assert.deepEqual(arkMovementRows({ error: 'x' }), [])
})
