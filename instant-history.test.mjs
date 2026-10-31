// instant-history.js: History's rows for payments made and received in seconds, and for trades.
import test from 'node:test'
import assert from 'node:assert/strict'
import { noteArrival, noteSent, instantLog, instantRows, tradeRows } from './instant-history.js'

const U = 'aa'.repeat(32), G = 'bb'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

test('a coin received is one row, once, and a board of the wallet\'s own coin is none', () => {
  const s = memStore()
  assert.equal(noteArrival(s, 't', { leaf_id: 'l1', asset: U, value: '500', kind: 'transfer' }, 1000), true)
  assert.equal(noteArrival(s, 't', { leaf_id: 'l1', asset: U, value: '500', kind: 'transfer' }, 2000), false, 'the same coin again')
  assert.equal(noteArrival(s, 't', { asset: U, value: '7', kind: 'board' }, 3000), false)
  assert.equal(noteArrival(s, 't', { leaf_id: 'l2', asset: 'xyz', value: '7' }, 3000), false)
  assert.equal(noteArrival(s, 'u', { leaf_id: 'l1', asset: U, value: '500' }, 3000), true, 'kept per wallet')
  assert.deepEqual(instantLog(s, 't').map((r) => [r.kind, r.legs[0].atoms]), [['in', '500']])
})

test('a payment sent is a row with its fee, and the newest row comes first', () => {
  const s = memStore()
  noteArrival(s, 't', { leaf_id: 'l1', asset: U, value: '500' }, 1000)
  noteSent(s, 't', { asset: U, atoms: 10n }, 2000)
  noteSent(s, 't', { asset: U, atoms: 20n, fee: { asset: U, atoms: 3n }, later: true }, 3000)
  noteSent(s, 't', { asset: U, atoms: 0n }, 4000)
  const rows = instantRows(instantLog(s, 't'), [])
  assert.deepEqual(rows.map((r) => [r.kind, r.legs[0].atoms, r.fee ? r.fee.atoms : null, !!r.later]), [['out', '20', '3', true], ['out', '10', null, false], ['in', '500', null, false]])
})

test('a trade is one row; the coin it brought in is not also a payment received', () => {
  const trade = { id: 'x', at: 5000, sentAt: 5200, state: 'settled', ticket: { payAsset: U, receiveAsset: G, amountIn: '10000', amountOut: '2557', fees: [{ asset: U, atoms: '0' }] } }
  const log = [
    { kind: 'in', at: 1000, leaf: 'faucet', legs: [{ asset: U, atoms: '500000' }] },
    { kind: 'in', at: 9000, leaf: 'proceeds', legs: [{ asset: G, atoms: '2557' }] },
    { kind: 'in', at: 9500, leaf: 'gift', legs: [{ asset: G, atoms: '2557' }] },
  ]
  const rows = instantRows(log, [trade])
  assert.deepEqual(rows.map((r) => r.kind + ':' + (r.leaf || r.trade.id)), ['in:gift', 'swap:x', 'in:faucet'], 'one arrival matched one trade; a second coin of the same amount is a payment')
  const swap = rows[1]
  assert.deepEqual(swap.legs, [{ asset: U, atoms: '-10000' }, { asset: G, atoms: '2557' }])
  assert.deepEqual(swap.fees, [], 'a zero fee is no fee')
})

test('only trades that moved something have a row', () => {
  const t = (state, extra = {}) => ({ id: state, at: 1, state, ticket: { payAsset: U, receiveAsset: G, amountIn: '1', amountOut: '2', fees: [] }, ...extra })
  const rows = tradeRows([t('confirming'), t('failed'), t('returned'), t('sent'), t('waiting'), t('settled'), t('returned', { id: 'paid', feesPaid: [{ asset: U, atoms: '5' }] }), t('confirming', { id: 'unsure', uncertain: true }), { state: 'sent' }])
  assert.deepEqual(rows.map((r) => r.trade.id + ':' + r.kind), ['sent:swap', 'waiting:swap', 'settled:swap', 'paid:returned', 'unsure:swap'])
})
