// default-arca.js: the route a payment takes, the pinned operator, what is arriving, and the
// board of coins that land on the chain.
//
//   node --test default-arca.test.mjs
import assert from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_WORDS, arrivalMinutes, addressRoute, pinnedOperator, checkPinned, parseReceiveCode, treeRoute, arrivingAtoms, boardCandidates,
  boardValue, boardAll } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const OP = 'b6f4c5924ad81947658cf85bb93d9267efc54c7fcb2e4577e8c954c68fa087bb'
const GEN = 'ddd11d54c87a2bd94400fd31ce05d8e1110bb4b78e7103f738342086fc4ea92e'
const A = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const B = 'e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13'
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex')
const code = (o, prefix = 'request') => `${prefix}:${hexOf(JSON.stringify(o))}`
const req = (o = {}) => ({ kind: 'request', genesis_hash: GEN, operator: OP, owner: 'aa'.repeat(32), owner_nonce: 'bb'.repeat(32), mailbox: 'cc'.repeat(32), exit_delay_units: 253, until: 1795000000, ...o })
const info = { operator: OP, genesis_hash: GEN, server_info: { assets: [{ asset: A, min_leaf: '1000000' }, { asset: B, min_leaf: '10000' }] } }

test('every word default mode shows is free of the words it never says', () => {
  const words = Object.values(DEFAULT_WORDS).map((w) => typeof w === 'function' ? w('1.5', 'USDX') : w)
  for (const w of words) assert.deepEqual(forbiddenIn(w), [], w)
})

test('the page names an operator only with a server, a node and a key', () => {
  assert.deepEqual(pinnedOperator({ server: 'https://x/arca/', node_url: 'https://x/node-rpc', operator: OP }),
    { server: 'https://x/arca', node_url: 'https://x/node-rpc', operator: OP })
  assert.equal(pinnedOperator(null), null)
  assert.equal(pinnedOperator(undefined), null)
  assert.equal(pinnedOperator({ server: 'https://x/arca', node_url: 'https://x/n', operator: 'nothex' }), null)
  assert.equal(pinnedOperator({ server: 'x/arca', node_url: 'https://x/n', operator: OP }), null)
  assert.equal(pinnedOperator({ server: 'https://x/arca', operator: OP }), null)
})

test('a server or wallet showing another key is refused', () => {
  const p = pinnedOperator({ server: 'https://x/arca', node_url: 'https://x/n', operator: OP })
  assert.doesNotThrow(() => checkPinned(OP, p))
  assert.throws(() => checkPinned('00'.repeat(32), p), /not the pinned/)
  assert.throws(() => checkPinned(undefined, p), /none, not the pinned/)
  assert.throws(() => checkPinned(OP, null), /no operator is pinned/)
})

test('a receive code is read whatever its prefix; anything else is not one', () => {
  assert.equal(parseReceiveCode(code(req())).owner, 'aa'.repeat(32))
  assert.equal(parseReceiveCode(code(req(), 'arca')).operator, OP)
  assert.ok(parseReceiveCode('  ' + code(req()) + '\n'))
  assert.ok(parseReceiveCode(code({ arca_request: 1, operator: OP })), 'an older wallet\'s request')
  assert.equal(parseReceiveCode(code({ kind: 'swap-offer', operator: OP })), null)
  assert.equal(parseReceiveCode('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), null)
  assert.equal(parseReceiveCode('lntb1500n1pj9'), null)
  assert.equal(parseReceiveCode('request:zz'), null)
  assert.equal(parseReceiveCode('request:abc'), null, 'odd hex')
  assert.equal(parseReceiveCode(':' + hexOf('{}')), null)
  assert.equal(parseReceiveCode('re quest:' + hexOf(JSON.stringify(req()))), null)
  assert.equal(parseReceiveCode(''), null)
  assert.equal(parseReceiveCode(null), null)
})

test('a code goes in the tree only for this wallet\'s operator and chain', () => {
  assert.ok(treeRoute(code(req()), info))
  assert.equal(treeRoute(code(req({ operator: '00'.repeat(32) })), info), null, 'another operator')
  assert.equal(treeRoute(code(req({ genesis_hash: '11'.repeat(32) })), info), null, 'another chain')
  assert.equal(treeRoute(code(req()), null), null, 'no leaf wallet open')
  assert.equal(treeRoute(code(req()), { operator: OP }), null, 'a wallet that knows no chain')
  assert.equal(treeRoute('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', info), null)
})

test('arriving is what the balance holds pending', () => {
  const bal = { arca: { [A]: { pending: '5000000', live: '2000000' }, [B]: { 'operator-confirmed': '7' } } }
  assert.equal(arrivingAtoms(bal, A), 5000000n)
  assert.equal(arrivingAtoms(bal, B), 0n)
  assert.equal(arrivingAtoms(null, A), 0n)
})

test('what is boarded: served assets on the chain at the smallest leaf or more, frozen coins left', () => {
  const bal = { sequentia_onchain: { [A]: '999999', [B]: '50000', ['ff'.repeat(32)]: '9999999' } }
  assert.deepEqual(boardCandidates(bal, info), [{ asset: B, onchain: 50000n, min: 10000n }])
  assert.deepEqual(boardCandidates({ sequentia_onchain: { [A]: '3000000' }, sequentia_onchain_frozen: { [A]: '2500000' } }, info), [])
  assert.deepEqual(boardCandidates({ sequentia_onchain: { [A]: '3000000' } }, null), [], 'no operator list, nothing served')
  assert.equal(boardValue(50000n, 300n, 10000n), 49700n)
  assert.equal(boardValue(10200n, 300n, 10000n), null)
})

test('a board carries what is left after its own fee, signed on the fee quoted for it', async () => {
  const calls = []
  // A fee of 300 for one coin, 450 once the amount needs two.
  const run = async (cmd, a) => {
    calls.push([cmd, a])
    const fee = BigInt(a.amount) > 30000n ? 450n : 300n
    if (cmd === 'board_quote') return { fee: { asset: B, amount: String(fee) } }
    if (cmd === 'board') return { leaf_id: 'x', value: a.amount, shown: a.shown }
  }
  const v = await boardAll(run, { asset: B, onchain: 50000n, min: 10000n })
  assert.equal(v.value, '49550')
  assert.deepEqual(v.shown, { asset: B, amount: '450' })
  assert.deepEqual(calls.map(([c, a]) => `${c} ${a.amount}`), ['board_quote 10000', 'board_quote 49700', 'board_quote 49550', 'board 49550'])
})

test('nothing is boarded when the fee leaves less than the smallest leaf, or is in another asset', async () => {
  const run = async (cmd, a) => { if (cmd === 'board_quote') return { fee: { asset: B, amount: '500' } }; throw new Error('no board expected') }
  assert.equal(await boardAll(run, { asset: B, onchain: 10400n, min: 10000n }), null)
  const other = async (cmd) => { if (cmd === 'board_quote') return { fee: { asset: A, amount: '5' } }; throw new Error('no board expected') }
  assert.equal(await boardAll(other, { asset: B, onchain: 50000n, min: 10000n }), null)
})

test('a library that refuses the board is not asked to sign', async () => {
  const run = async (cmd) => { if (cmd === 'board_quote') throw new Error('the node does not accept the asset for fees'); throw new Error('signed') }
  await assert.rejects(boardAll(run, { asset: B, onchain: 50000n, min: 10000n }), /does not accept/)
})

test('an address is paid on the chain while the chain covers it, else out of the tree', () => {
  assert.equal(addressRoute(5n, 10n, 0n), 'chain')
  assert.equal(addressRoute(5n, 4n, 5n), 'tree')
  assert.equal(addressRoute(5n, 4n, 4n), null)
  assert.equal(addressRoute(5n, 0n, 0n), null)
})

test('the arrival time is the operator\'s interval in whole minutes, or none', () => {
  assert.equal(arrivalMinutes(600), 10)
  assert.equal(arrivalMinutes(61), 2)
  assert.equal(arrivalMinutes(5), 1)
  assert.equal(arrivalMinutes(null), null)
  assert.equal(arrivalMinutes(0), null)
  assert.equal(DEFAULT_WORDS.arrivesWithin(10), 'It arrives in about 10 minutes.')
  assert.equal(DEFAULT_WORDS.arrivesWithin(1), 'It arrives in a few minutes.')
  assert.equal(DEFAULT_WORDS.sentLater('1', 'GOLD', 1), 'Sent 1 GOLD. It arrives in a few minutes.')
  assert.equal(DEFAULT_WORDS.arrivesWithin(null), 'It arrives shortly.')
})
