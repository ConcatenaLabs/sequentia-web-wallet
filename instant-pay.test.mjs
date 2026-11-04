import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCode, instantRoute, channelTotals, arrivals, fallsBack, CODE_KIND } from './instant-pay.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const hexOf = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('hex')
const code = (o) => 'request:' + hexOf({ kind: CODE_KIND, genesis_hash: 'g', operator: 'o', channels: { [A]: 'theirs' }, address: 'tb1qx', ...o })

test('a payment code is read; any other text is not', () => {
  const v = readCode(code())
  assert.equal(v.channels[A], 'theirs')
  assert.equal(v.address, 'tb1qx')
  assert.equal(readCode('tb1qsomeaddress'), null)
  assert.equal(readCode('request:' + hexOf({ kind: 'request', owner: 'k' })), null, 'a receive request is not a code')
  assert.equal(readCode('request:zz'), null)
  assert.equal(readCode(''), null)
})

const mine = (o) => ({ leaf_id: 'mine', asset: A, coin_state: 'live', final: true, pending: false, balance: '500', credit: '0', ...o })

test('instant when the code names a channel in the asset and the wallet can pay it', () => {
  const c = readCode(code())
  assert.deepEqual(instantRoute(c, A, 400n, [mine()]), { instant: true, why: null, from: 'mine', to: 'theirs' })
  assert.equal(instantRoute(c, A, 501n, [mine()]).instant, false, 'more than the channel holds')
  assert.equal(instantRoute(c, B, 1n, [mine({ asset: B })]).instant, false, 'the code names no channel in B')
  assert.equal(instantRoute(c, A, 1n, [mine({ final: false })]).instant, false, 'its round not final')
  assert.equal(instantRoute(c, A, 1n, [mine({ coin_state: 'given' })]).instant, false, 'given up in a round')
  assert.equal(instantRoute(c, A, 1n, [mine({ pending: true })]).instant, false, 'a state sent, not answered')
  assert.equal(instantRoute(c, A, 1n, [mine({ leaf_id: 'theirs' })]).instant, false, 'its own code')
  assert.equal(instantRoute(c, A, 1n, []).instant, false, 'no channel')
  assert.equal(instantRoute(null, A, 1n, [mine()]).instant, false)
})

test('the channel holding most pays', () => {
  const c = readCode(code())
  assert.equal(instantRoute(c, A, 600n, [mine({ leaf_id: 'small', balance: '100' }), mine({ leaf_id: 'big', balance: '900' })]).from, 'big')
})

test('a read of the channels shows what came in, and the totals', () => {
  const before = [mine({ credit: '100' }), mine({ leaf_id: 'other', asset: B, credit: '0', balance: '50' })]
  const after = [mine({ credit: '250', balance: '650' }), mine({ leaf_id: 'other', asset: B, credit: '0', balance: '50' })]
  assert.deepEqual(arrivals(before, after), [{ leaf_id: 'mine', asset: A, atoms: 150n }])
  assert.deepEqual(arrivals(after, after), [])
  assert.deepEqual(arrivals(before, [{ leaf_id: 'mine', error: 'unreachable' }]), [])
  const t = channelTotals(after)
  assert.equal(t.get(A), 650n)
  assert.equal(t.get(B), 50n)
})

test('a refusal falls back on the chain unless a state stands unanswered', () => {
  assert.equal(fallsBack({ kind: 'refused', message: 'not paid over a channel: …takes 10 more at most' }), true)
  assert.equal(fallsBack({ kind: 'server_refused' }), true)
  assert.equal(fallsBack({ kind: 'unreachable', message: 'channel … state 3: …' }), false)
})
