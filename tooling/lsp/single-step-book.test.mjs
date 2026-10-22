// The single-step book (single-step-book.mjs) and the router's single-step entry
// (settlement-router.mjs planSingleStep): what user mode trades against, how a candidate is sized
// and chosen, which pairs are admitted, and that nothing but a single-step source is planned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makerEntries, covenantRoundEntries, restingEntries, sizeEntry, chooseCandidate, admittedSources, admittedReceives, SOURCE_PARTIES } from './single-step-book.mjs'
import { planSingleStep, SINGLE_STEP_SOURCES } from './settlement-router.mjs'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)

test('the book: a maker quotes what it gives; an order the round can take; nothing else', () => {
  const q = [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' },
    { give_asset: X, want_asset: Y, rate_num: '1', rate_den: '1', max_give: '5', min_give: '1' }]
  const m = makerEntries('http://m', q, { payAsset: X, receiveAsset: Y })
  assert.equal(m.length, 1)
  assert.equal(m[0].source, 'leaf-maker')
  const cov = (extra) => ({ offer_id: 'o1', offer_asset: Y, want_asset: X, offer_amount: '600000', want_amount: '800000', base_amount: '600000', _verified: true,
    covenant: { covenant_txid: 'ab'.repeat(32), covenant_vout: 0, rate_num: '4', rate_den: '3', min_lot: '10000' }, ...extra })
  assert.equal(covenantRoundEntries([cov()], { payAsset: X, receiveAsset: Y }).length, 1)
  assert.equal(covenantRoundEntries([cov({ confidential: true })], { payAsset: X, receiveAsset: Y }).length, 0, 'a blinded order is not taken from leaves')
  assert.equal(covenantRoundEntries([cov({ _verified: false })], { payAsset: X, receiveAsset: Y }).length, 0, 'an unverified offer never enters')
  assert.equal(covenantRoundEntries([{ ...cov(), covenant: undefined, lightning: { ln_direction: 1 } }], { payAsset: X, receiveAsset: Y }).length, 0, 'a submarine offer stays out')
})

test('sizing: the price rounded against the taker, the lot rules of an order', () => {
  const e = { rateNum: 4n, rateDen: 3n, maxReceive: 600000n, minReceive: 10000n, lot: 10000n }
  assert.deepEqual(sizeEntry(e, 400000n), { receive: 300000n, pay: 400000n })
  assert.deepEqual(sizeEntry(e, 400001n), { receive: 300000n, pay: 400000n })
  // Not whole and leaving less than the lot resting: it leaves the lot.
  assert.deepEqual(sizeEntry(e, 795000n), { receive: 590000n, pay: 786667n })
  assert.equal(sizeEntry(e, 100n), null)
  assert.deepEqual(sizeEntry(e, 10_000_000n).receive, 600000n)
})

test('the choice: the most received, then the fewest parties, then the lower id', () => {
  const c = chooseCandidate([{ source: 'leaf-maker', id: 'b', receive: 300n }, { source: 'covenant-round', id: 'z', receive: 300n }, { source: 'leaf-maker', id: 'a', receive: 299n }])
  assert.equal(c.source, 'covenant-round')
  assert.equal(chooseCandidate([{ source: 'leaf-maker', id: 'b', receive: 301n }, { source: 'covenant-round', id: 'a', receive: 300n }]).id, 'b')
  assert.equal(chooseCandidate([{ source: 'leaf-maker', id: 'b', receive: 5n }, { source: 'leaf-maker', id: 'a', receive: 5n }]).id, 'a')
  assert.equal(chooseCandidate([]), null)
  assert.ok(SOURCE_PARTIES['onchain-fill'] < SOURCE_PARTIES['covenant-round'] && SOURCE_PARTIES['covenant-round'] < SOURCE_PARTIES['leaf-maker'])
})

test('the router names one settlement per source and refuses any other', () => {
  assert.equal(planSingleStep('leaf-maker', { payAsset: X, receiveAsset: Y }).path, 'leaf-swap')
  assert.equal(planSingleStep('covenant-round', { payAsset: X, receiveAsset: Y, caps: { leaf_take: true } }).path, 'leaf-take')
  assert.throws(() => planSingleStep('covenant-round', { payAsset: X, receiveAsset: Y, caps: { leaf_take: false } }), /does not settle in one step/)
  for (const s of ['submarine', 'lsp-bridge', 'pureln', 'native']) assert.throws(() => planSingleStep(s, { payAsset: X, receiveAsset: Y }), /not a single-step source/)
  assert.deepEqual(Object.keys(SINGLE_STEP_SOURCES).sort(), ['btc-gateway', 'covenant-round', 'leaf-maker', 'leaf-resting'])
})

test('a BTC trade is one hash-lock: BTC over Lightning, the asset in the tree, and never a leaf of BTC', () => {
  const sell = planSingleStep('btc-gateway', { payAsset: X, receiveAsset: 'BTC' })
  assert.equal(sell.path, 'leaf-ln')
  assert.equal(sell.plan.btcLeg.rail, 'ln'); assert.equal(sell.plan.assetLeg.rail, 'leaf'); assert.equal(sell.plan.btcLeg.bridge, false)
  assert.equal(sell.plan.atomic.sharedPreimage, true); assert.equal(sell.plan.leaf.hashBy, 'btc-receiver')
  assert.deepEqual(sell.commands, ['lightning_pay_quote', 'lightning_pay', 'lightning_post_preimage', 'sync'])
  const buy = planSingleStep('btc-gateway', { payAsset: 'BTC', receiveAsset: X })
  assert.equal(buy.plan.takerSide, 'buy')
  assert.ok(buy.commands.includes('lightning_receive_ready'), 'the BTC is paid only once the leaf is held')
  assert.throws(() => planSingleStep('btc-gateway', { payAsset: X, receiveAsset: Y }), /names one asset besides BTC|BTC/)
  assert.throws(() => planSingleStep('leaf-maker', { payAsset: X, receiveAsset: 'BTC' }), /BTC is never a leaf/)
  assert.throws(() => planSingleStep('covenant-round', { payAsset: 'BTC', receiveAsset: X, caps: { leaf_take: true } }), /BTC is never a leaf/)
  // A maker's quote with BTC on one side is a BTC entry; any other an in-tree one.
  const es = makerEntries('m', [{ give_asset: 'BTC', want_asset: X, rate_num: '2', rate_den: '1', max_give: '100', min_give: '1' },
    { give_asset: Y, want_asset: X, rate_num: '1', rate_den: '1', max_give: '100', min_give: '1' }], { payAsset: X, receiveAsset: 'BTC' })
  assert.deepEqual(es.map((e) => e.source), ['btc-gateway'])
})

test('a pair is offered only as the drill admitted it, on its chain', () => {
  const pairs = { chains: { g1: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }, { pay: Y, receive: X, sources: [] }] } } }
  assert.deepEqual(admittedSources(pairs, 'g1', X, Y), ['leaf-maker'])
  assert.deepEqual(admittedSources(pairs, 'g1', Y, X), [])
  assert.deepEqual(admittedSources(pairs, 'g2', X, Y), [])
  assert.deepEqual(admittedReceives(pairs, 'g1', X), [Y])
  assert.deepEqual(admittedReceives(pairs, 'g1', Y), [])
  const shipped = JSON.parse(readFileSync(new URL('../../user-mode/pairs.json', import.meta.url), 'utf8'))
  assert.ok(shipped && typeof shipped.chains === 'object', 'user-mode/pairs.json is the list the page reads')
})

test('an order resting in the tree: only the joined operator\'s, sized at the relay\'s live size, one transfer', () => {
  const op = 'ab'.repeat(32)
  const rest = (o) => ({ offer_asset: Y, want_asset: X, _verified: true, _status: { active_amount: '400000' },
    resting_leaf: { operator_key: op, order_id: 'cd'.repeat(32), asset_a: Y, asset_b: X, rate_num: '2', rate_den: '1', min_lot: '10000', value: '600000', ...o } })
  const es = restingEntries([rest({}), rest({ operator_key: 'ef'.repeat(32) }), { ...rest({}), _verified: false }, rest({ asset_a: X, asset_b: Y })], { payAsset: X, receiveAsset: Y, operator: op })
  assert.equal(es.length, 1)
  assert.equal(es[0].source, 'leaf-resting'); assert.equal(es[0].id, 'cd'.repeat(32))
  assert.equal(es[0].maxReceive, 400000n, 'the relay\'s live size, not the signed one'); assert.equal(es[0].lot, 10000n)
  // A fill leaves nothing or at least a lot, as a covenant order's does.
  assert.deepEqual(sizeEntry(es[0], 785000n), { receive: 390000n, pay: 780000n })
  assert.deepEqual(restingEntries([rest({})], { payAsset: X, receiveAsset: Y, operator: null }), [], 'no operator joined, nothing to fill')
  const p = planSingleStep('leaf-resting', { payAsset: X, receiveAsset: Y })
  assert.equal(p.path, 'leaf-fill-resting'); assert.equal(p.plan.leaf.shape, 'resting')
  assert.deepEqual(p.commands, ['order_fill_resting_quote', 'order_fill_resting'])
  assert.throws(() => planSingleStep('leaf-resting', { payAsset: 'BTC', receiveAsset: Y }), /BTC is never a leaf/)
  assert.equal(SOURCE_PARTIES['leaf-resting'], 1, 'the operator is the one party left to act')
})
