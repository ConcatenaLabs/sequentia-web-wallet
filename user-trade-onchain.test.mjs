// The user composer's fill of a transparent covenant order on the chain ('onchain-fill'), from
// the wallet's own on-chain coins, against stand-ins of the relay and the page's on-chain wallet:
// the ticket from the FILL's own amounts and one fill's network fee, the FILL built from the
// terms shown, Settled once it is final, Returned when it never reaches the chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, UNCERTAIN_MS } from './user-trade.js'
import { planPlaceOrder, buildCovenantTerms } from './covenant-order.js'

const X = 'aa'.repeat(31) + '01', Y = 'bb'.repeat(31) + '02'
const rev = (h) => h.match(/../g).reverse().join('')
// An order selling 1,000,000 of Y for X at 4 X per 3 Y, placed as the page places one.
const params = { assetA: rev(Y), assetB: rev(X), sellAtoms: 1000000n, rateNum: 4n, rateDen: 3n, minLot: 10000n,
  expiryLocktime: 1900000000, makerProg: '11'.repeat(32), makerX: '22'.repeat(32) }
const plan = planPlaceOrder(params)
const terms = buildCovenantTerms(plan.order, 'cd'.repeat(32), 0, plan.tap)
const offer = { offer_id: 'o1', offer_asset: Y, want_asset: X, offer_amount: '1000000', covenant: terms, _verified: true, _status: { active_amount: '1000000' } }

function standIn ({ onchainX = 2000000n, feeAsset = X, feeAtoms = 50n } = {}) {
  const s = { taken: [], status: 'pending', t: 0, store: { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } } }
  s.engine = createEngine({
    leaves: { command (cmd) { if (cmd === 'coins') return []; if (cmd === 'plans') return { plans: [] }; throw new Error('no leaves') } },
    fetchJson: async () => ({}), makers: () => [], relayBook: async () => [offer], store: s.store, now: () => s.t,
    admitted: () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['onchain-fill'] }] } } }, genesis: 'g' }),
    onchain: {
      balance: (a) => (a === X ? onchainX : 0n),
      fee: () => ({ asset: feeAsset, atoms: feeAtoms }),
      take: async (matched, { onTxid }) => { s.taken.push(matched); onTxid('f1'.repeat(32)); return { txid: 'f1'.repeat(32) } },
      status: () => s.status,
    },
  })
  return s
}

test('a covenant order taken on the chain from on-chain coins: the FILL\'s own price, one fee, Settled once final', async () => {
  const s = standIn()
  const q = await s.engine.quote({ payAsset: X, receiveAsset: Y, amount: '400050' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'onchain-fill')
  // 400,000 of X at 4 per 3 buys 300,000 of Y; the fee of 50 is paid in X as well.
  assert.equal(q.ticket.amountOut, '300000')
  assert.equal(q.ticket.amountIn, '400050')
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '50' }])
  let r = await s.engine.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'sent'); assert.equal(r.txid, 'f1'.repeat(32))
  assert.equal(s.taken[0].fill_base_amount, '300000', 'the FILL is built for the amount shown')
  s.status = 'confirmed'
  r = await s.engine.advance(s.engine.records()[0])
  assert.equal(r.state, 'sent', 'not Settled while the FILL is not final')
  s.status = 'final'
  r = await s.engine.advance(s.engine.records()[0])
  assert.equal(r.state, 'settled')
})

test('a fee in another asset is shown in that asset, the price alone in what is paid', async () => {
  const Z = 'cc'.repeat(32)
  const s = standIn({ feeAsset: Z, feeAtoms: 7n })
  const q = await s.engine.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.amountIn, '400000'); assert.equal(q.ticket.amountOut, '300000')
  assert.deepEqual(q.ticket.fees, [{ asset: Z, atoms: '7' }])
})

test('nothing on the chain and no leaves: no funds; a FILL the chain never takes is Returned after the wait', async () => {
  assert.equal((await standIn({ onchainX: 0n }).engine.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })).why, 'no-funds')
  const s = standIn()
  const q = await s.engine.quote({ payAsset: X, receiveAsset: Y, amount: '400050' })
  await s.engine.confirm(q.choice, q.ticket)
  s.status = 'unknown'
  let r = await s.engine.advance(s.engine.records()[0])
  assert.equal(r.state, 'sent', 'looked for a while')
  s.t += UNCERTAIN_MS
  r = await s.engine.advance(s.engine.records()[0])
  assert.equal(r.state, 'returned')
})

test('an order whose covenant sells another asset than it is listed for is not taken', async () => {
  const s = standIn()
  const wrong = { ...offer, offer_asset: X, want_asset: Y }
  s.engine = createEngine({ leaves: { command (c) { if (c === 'coins') return []; if (c === 'plans') return { plans: [] }; throw new Error('x') } },
    fetchJson: async () => ({}), makers: () => [], relayBook: async () => [wrong], store: s.store, now: () => 0,
    admitted: () => ({ pairs: { chains: { g: { pairs: [{ pay: Y, receive: X, sources: ['onchain-fill'] }] } } }, genesis: 'g' }),
    onchain: { balance: () => 2000000n, fee: () => ({ asset: Y, atoms: 50n }), take: async () => { throw new Error('must not take') }, status: () => 'unknown' } })
  const q = await s.engine.quote({ payAsset: Y, receiveAsset: X, amount: '400000' })
  assert.equal(q.ok, false)
})

test('the router plans an on-chain fill as one native step, and the book lists every covenant order', async () => {
  const { planSingleStep } = await import('./tooling/lsp/settlement-router.mjs')
  const { onchainFillEntries } = await import('./tooling/lsp/single-step-book.mjs')
  const p = planSingleStep('onchain-fill', { payAsset: X, receiveAsset: Y })
  assert.equal(p.path, 'native'); assert.deepEqual(p.commands, ['covenant_fill'])
  assert.throws(() => planSingleStep('onchain-fill', { payAsset: 'BTC', receiveAsset: Y }), /no BTC/)
  const es = onchainFillEntries([offer, { ...offer, _verified: false }, { ...offer, covenant: null }], { payAsset: X, receiveAsset: Y })
  assert.equal(es.length, 1); assert.equal(es[0].source, 'onchain-fill'); assert.equal(es[0].maxReceive, 1000000n)
})

test('the page\'s on-chain wallet: a FILL\'s fee in the asset paid at the node\'s rate, and where a FILL stands', async () => {
  const { makeUserOnchain, EST_FILL_VSIZE } = await import('./user-onchain.js')
  const answers = { a: { confirmed: true }, b: { confirmed: false } }
  const oc = makeUserOnchain({
    feeRateFor: (a) => { if (a !== X) throw new Error('no fee rate'); return 50000000n }, feerate: 2000, rateScale: 100000000,
    balance: () => 7n,
    esploraFetch: async (path) => { const id = path.split('/')[2]; return answers[id] ? { ok: true, json: async () => answers[id] } : { ok: false } },
  })
  // 2,000 sat/kvB × 1,500 vB = 3,000 reference atoms, at half a reference unit per atom of X: 6,000.
  assert.equal(EST_FILL_VSIZE, 1500n)
  assert.deepEqual(oc.fee(X), { asset: X, atoms: 6000n })
  assert.throws(() => oc.fee(Y), /no fee rate/, 'an asset the node takes no fee in cannot pay a FILL')
  assert.equal(await oc.status('a'), 'final'); assert.equal(await oc.status('b'), 'pending'); assert.equal(await oc.status('c'), 'unknown')
  assert.equal(oc.balance(X), 7n)
})

test('a FILL the node refuses is a refusal (nothing moved), one it already holds is out, anything else unknown', async () => {
  const { broadcastAnswer } = await import('./user-onchain.js')
  const refused = broadcastAnswer(new Error('broadcast failed: sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'), 'ab')
  assert.equal(refused.error.kind, 'refused'); assert.match(refused.error.message, /^refused: the node took no FILL: .*missingorspent/)
  assert.deepEqual(broadcastAnswer(new Error('broadcast failed: txn-already-in-mempool'), 'ab'), { txid: 'ab' })
  const away = new Error('fetch failed')
  assert.equal(broadcastAnswer(away, 'ab').error, away, 'an esplora that does not answer leaves it unknown')
  // The engine fails a refused FILL at once: nothing to follow.
  const s = standIn()
  const eng = createEngine({ leaves: { command (cmd) { if (cmd === 'coins') return []; if (cmd === 'plans') return { plans: [] }; throw new Error('no leaves') } },
    fetchJson: async () => ({}), makers: () => [], relayBook: async () => [offer], store: s.store,
    admitted: () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['onchain-fill'] }] } } }, genesis: 'g' }),
    onchain: { balance: () => 2000000n, fee: () => ({ asset: X, atoms: 50n }), status: () => 'unknown',
      take: async (m, { onTxid }) => { onTxid('ab'); throw refused.error } } })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400050' })
  await assert.rejects(eng.confirm(q.choice, q.ticket), /refused/)
  assert.equal(eng.records()[0].state, 'failed')
})

test('an esplora that fails for itself is not the node refusing the FILL', async () => {
  const { broadcastAnswer } = await import('./user-onchain.js')
  const e = new Error('broadcast failed: Block height out of range')
  assert.equal(broadcastAnswer(e, 'ab').error, e, 'left unknown, followed on the chain')
  assert.equal(broadcastAnswer(new Error('broadcast failed: sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}'), 'ab').error.kind, 'refused')
})
