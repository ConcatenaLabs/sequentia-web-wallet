// site-orders.js: a site's orders mapped onto the user composer's engine and the leaf library's
// placement, against fakes; the engine and the library are driven live by the browser drives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSiteOrders, readParams, readOptions, restTerms, meetsLimit, SITE_WORDS, ORDER_FEATURES } from './site-orders.js'
import { forbiddenIn, USER_WORDS } from './user-trade.js'

const B = 'bb'.repeat(32), Q = 'cc'.repeat(32)
const meta = (h) => (h === B ? { ticker: 'GOLD', precision: 8 } : { ticker: 'USDX', precision: 8 })
const fmtAtoms = (a, p) => { const s = a.toString().padStart(p + 1, '0'); return p ? s.slice(0, -p) + '.' + s.slice(-p) : s }
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }

// A book that sells GOLD at 4000 USDX each and buys it at 3900.
function fakeEngine () {
  const E = { quotes: [], dropped: [], recs: [] }
  E.quote = async ({ payAsset, receiveAsset, amount }) => {
    E.quotes.push({ payAsset, amount: BigInt(amount) })
    const have = 10n ** 12n
    const pay = BigInt(amount) < have ? BigInt(amount) : have
    const out = payAsset === Q ? pay / 4000n : pay * 3900n
    const ticket = { payAsset, receiveAsset, amountIn: String(pay), amountOut: String(out), fees: [{ asset: payAsset, atoms: '10' }] }
    return { ok: true, ticket, choice: { pay } }
  }
  // The makers' published prices: what paying for `receive` takes.
  E.estimate = async ({ payAsset, receive }) => (E.noEstimate ? { ok: false, why: 'too-small' }
    : { ok: true, pay: String(payAsset === Q ? BigInt(receive) * 4000n : (BigInt(receive) + 3899n) / 3900n), receive: String(receive), short: null })
  E.drop = (c) => E.dropped.push(c)
  E.confirm = async (choice, ticket) => { const r = { id: 'r' + E.recs.length, state: 'sent', ticket }; E.recs.push(r); return r }
  E.records = () => E.recs
  E.advance = async (r) => r
  return E
}
function fakeLeaves () {
  const calls = []
  return { calls, command: async (c, a) => { calls.push([c, a]); if (c === 'schedule') return { now: 1000 }
    if (c === 'order_quote') return { fee: { asset: a.sell, amount: '25' }, full_price: '999', min_lot: a.min_lot, expiry_locktime: 87400 }
    if (c === 'order_place') return { order: 'o1', state: 'waiting' }
    if (c === 'orders') return [{ order: 'o1', state: 'resting', holds: '60000000', refund_from: 87400, rests_at: 't:0' }]
    if (c === 'order_refund') return { refund: 'rf' }
    throw new Error('no ' + c) } }
}

test('every word a site\'s order shows is a default-mode word', () => {
  const all = Object.values(SITE_WORDS).map((w) => (typeof w === 'function' ? w('GOLD') : w)).join(' | ')
  assert.deepEqual(forbiddenIn(all), [])
})

test('params: a market of two assets, a side, an amount; a limit needs its price', () => {
  assert.throws(() => readParams({ type: 'x' }), /type/)
  assert.throws(() => readParams({ type: 'limit', base: B, quote: Q, side: 'buy', amount: '5' }), /price/)
  assert.throws(() => readParams({ type: 'market', base: B, quote: B, side: 'buy', amount: '5' }), /differ/)
  assert.equal(readParams({ type: 'market', base: B, quote: 'BTC', side: 'sell', amount: '5' }).quote, 'BTC')
})

test('rest terms and the limit check: the price is quote atoms per whole base unit', () => {
  const U = 10n ** 8n
  const sell = { side: 'sell', base: B, quote: Q, amount: 2n * U, price: 4100n * U }
  assert.deepEqual(restTerms(sell, U), { sell: B, want: Q, amount: 2n * U, rate_num: 4100n, rate_den: 1n })
  const buy = { side: 'buy', base: B, quote: Q, amount: U / 2n, price: 3950n * U }
  assert.deepEqual(restTerms(buy, U), { sell: Q, want: B, amount: 1975n * U, rate_num: 1n, rate_den: 3950n })
  assert.deepEqual(restTerms({ ...sell, price: 12345n }, U), { sell: B, want: Q, amount: 2n * U, rate_num: 2469n, rate_den: 20000000n })
  assert.equal(meetsLimit(sell, { amountIn: String(2n * U), amountOut: String(7800n * U) }, U), false)
  assert.equal(meetsLimit({ ...sell, price: 3900n * U }, { amountIn: String(2n * U), amountOut: String(7800n * U) }, U), true)
  assert.equal(meetsLimit(buy, { amountIn: String(2000n * U), amountOut: String(U / 2n) }, U), false)
  assert.equal(meetsLimit({ ...buy, price: 4000n * U }, { amountIn: String(2000n * U), amountOut: String(U / 2n) }, U), true)
})

test('a market buy is priced from the published prices and asked firm once, for its own size', async () => {
  const E = fakeEngine(), L = fakeLeaves()
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem(), tag: () => 't' })
  const q = await S.quote({ type: 'market', base: B, quote: Q, side: 'buy', amount: String(10n ** 8n) }, 'https://s/dex/')
  assert.equal(q.kind, 'take')
  assert.deepEqual(E.quotes.map((x) => x.amount), [4000n * 10n ** 8n], 'one firm offer, for 1 GOLD at 4000, never for all the wallet holds')
  assert.equal(E.dropped.length, 0)
})

test('a market buy is sized from a first price, shown, and settled as one trade', async () => {
  const E = fakeEngine(), L = fakeLeaves()
  // No published price to be had: a first firm price for all the wallet can pay sizes it.
  E.noEstimate = true
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem(), tag: () => 't' })
  const q = await S.quote({ type: 'market', base: B, quote: Q, side: 'buy', amount: String(10n ** 8n) }, 'https://s/dex/')
  assert.equal(q.kind, 'take')
  assert.equal(E.quotes.length, 2)
  assert.equal(E.quotes[1].amount, 4000n * 10n ** 8n)   // 1 GOLD at 4000
  assert.equal(E.dropped.length, 1)
  const words = JSON.stringify(q.display)
  assert.deepEqual(forbiddenIn(words), [])
  assert.match(words, /Asked by/)
  const r = await S.confirm(q.id)
  assert.equal(r.filled, 1); assert.equal(r.got, String(10n ** 8n))
  const o = await S.orders('https://s/dex/')
  assert.equal(o.trades.length, 1); assert.equal(o.trades[0].state, 'sent')
  assert.deepEqual(o.trades[0].fills, [{ txid: r.trade, base: String(10n ** 8n), quote: String(4000n * 10n ** 8n), state: 'sent' }])
  assert.deepEqual((await S.orders('https://other/')).trades, [])
  await assert.rejects(S.confirm(q.id), /no longer current/)
})

test('a trade is "received" as soon as the maker completed it, with the wallet\'s own words', async () => {
  const E = fakeEngine(), L = fakeLeaves()
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem(), tag: () => 't' })
  const q = await S.quote({ type: 'market', base: B, quote: Q, side: 'buy', amount: String(10n ** 8n) }, 'https://s/dex/')
  const r = await S.confirm(q.id)
  // The swap the maker completed: what it brings is the wallet's, only its settling is left.
  Object.assign(E.recs[0], { source: 'leaf-maker', swapState: 'done', sentAt: Date.now() })
  let o = await S.orders('https://s/dex/')
  assert.equal(o.trades[0].state, 'received')
  assert.equal(o.trades[0].note, USER_WORDS.received)
  // Still settling a quarter of an hour on: said to be slow, never "Sent".
  Object.assign(E.recs[0], { sentAt: Date.now() - 15 * 60000, settleState: ['released', 'pending'] })
  o = await S.orders('https://s/dex/')
  assert.equal(o.trades[0].state, 'received')
  assert.match(o.trades[0].note, /taking longer than usual/)
  assert.deepEqual(forbiddenIn(o.trades[0].note), [])
  assert.ok(r.trade)
})

test('a limit order away from the book rests from leaves, listed once it rests, taken back only after its date', async () => {
  const E = fakeEngine(), L = fakeLeaves()
  const listed = []
  let t = 1000 * 1000
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem(), tag: () => 't', now: () => t, list: async (o, rec) => { listed.push([o.order, rec.offer_id]); return { relay_expires: 5 } } })
  const U = 10n ** 8n
  const q = await S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U) }, 'https://s/dex/')
  assert.equal(q.kind, 'rest')
  assert.equal(E.dropped.length, 1)   // the price that did not meet the limit is let go
  assert.deepEqual(forbiddenIn(JSON.stringify(q.display)), [])
  const qa = L.calls.find((c) => c[0] === 'order_quote')[1]
  assert.deepEqual([qa.sell, qa.want, qa.amount, qa.rate_num, qa.rate_den, qa.expiry], [B, Q, String(U), '4200', '1', '87400'])
  const r = await S.confirm(q.id)
  assert.equal(r.order, 'o1'); assert.equal(r.filled, 0)
  assert.equal(L.calls.find((c) => c[0] === 'order_place')[1].shown.full_price, '999')
  await S.follow()
  assert.equal(listed.length, 1)
  await S.follow()
  assert.equal(listed.length, 1)
  const o = (await S.orders('https://s/dex/')).orders[0]
  assert.equal(o.state, 'filling'); assert.equal(o.filled, String(U - 60000000n)); assert.equal(o.can_take_back, false)
  await assert.rejects(S.quoteCancel({ order: 'o1' }, 'https://s/dex/'), /can be taken back from 1970-01-02 00:16 UTC/)
  t = 90000 * 1000
  const c = await S.quoteCancel({ order: 'o1' }, 'https://s/dex/')
  assert.deepEqual(await S.confirmCancel(c.id), { order: 'o1', txid: 'rf' })
  await assert.rejects(S.quoteCancel({ order: 'o1' }, 'https://x/'), /no such order/)
})

test('a market order nobody offers is refused in plain words, and a limit against BTC only trades', async () => {
  const E = fakeEngine(); E.quote = async () => ({ ok: false, why: 'not-offered' })
  const S = makeSiteOrders({ engine: E, leaves: fakeLeaves(), assetMeta: meta, fmtAtoms, store: mem() })
  await assert.rejects(S.quote({ type: 'market', base: B, quote: Q, side: 'sell', amount: '5' }, 'o'), /Not offered right now: nobody offers USDX for GOLD/)
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: 'BTC', side: 'sell', amount: '5', price: '9' }, 'o'), new RegExp(SITE_WORDS.priceNotMet))
})

test('an order whose coins are still arriving is refused in plain words', async () => {
  const L = fakeLeaves(); const inner = L.command
  L.command = async (c, a) => { if (c === 'order_quote') throw new Error("refused: the wallet's live coins of asset " + B + ' hold 0 and the order of 5 and its fee need 9'); return inner(c, a) }
  const S = makeSiteOrders({ engine: fakeEngine(), leaves: L, assetMeta: meta, fmtAtoms, store: mem() })
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: '5', price: String(9000n * 10n ** 8n) }, 'o'), /Not enough GOLD is ready to place this order yet/)
  assert.deepEqual(forbiddenIn(SITE_WORDS.notReady('GOLD')), [])
})

test('options: a limit order\'s four, refused on a market order and post only beside rest: false', () => {
  const L = { type: 'limit', base: B, quote: Q, side: 'sell', amount: '5', price: '9' }
  assert.deepEqual(readOptions(L, 'limit'), { postOnly: false, rest: true, minFill: null, takeBackAfter: null })
  assert.deepEqual(readParams({ ...L, post_only: true, min_fill: '2', take_back_after: 3600 }).opts, { postOnly: true, rest: true, minFill: 2n, takeBackAfter: 3600 })
  assert.equal(readParams({ ...L, rest: false }).opts.rest, false)
  assert.throws(() => readParams({ ...L, type: 'market', price: undefined, post_only: true }), /post_only: options of a limit order/)
  assert.throws(() => readParams({ ...L, post_only: true, rest: false }), /cannot be asked together/)
  assert.throws(() => readParams({ ...L, post_only: 'yes' }), /post_only must be true or false/)
  assert.throws(() => readParams({ ...L, min_fill: '0' }), /min_fill must be a positive/)
  assert.throws(() => readParams({ ...L, take_back_after: 60 }), /from 3600 \(an hour\) to 604800 \(a week\)/)
  assert.throws(() => readParams({ ...L, take_back_after: 604801 }), /a week/)
  assert.deepEqual([...ORDER_FEATURES], ['order-post-only', 'order-no-rest', 'order-min-fill', 'order-take-back-after'])
  for (const w of [SITE_WORDS.wouldTrade, SITE_WORDS.neverRests, SITE_WORDS.minFillTooBig]) assert.deepEqual(forbiddenIn(w), [])
})

test('post only: refused before any approval when it would trade, rests when it would not', async () => {
  const U = 10n ** 8n
  const E = fakeEngine(), L = fakeLeaves()
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem() })
  // The book buys at 3900: a sale at 3800 would trade.
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(3800n * U), post_only: true }, 'o'), new RegExp(SITE_WORDS.wouldTrade))
  assert.equal(E.dropped.length, 1)
  assert.equal(L.calls.some((c) => c[0] === 'order_quote'), false)
  const q = await S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U), post_only: true }, 'o')
  assert.equal(q.kind, 'rest')
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: 'BTC', side: 'sell', amount: '5', price: '9', post_only: true }, 'o'), new RegExp(SITE_WORDS.neverRests))
})

test('rest: false trades when the book meets the price and places nothing when it does not', async () => {
  const U = 10n ** 8n
  const E = fakeEngine(), L = fakeLeaves()
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: meta, fmtAtoms, store: mem() })
  const q = await S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(3800n * U), rest: false }, 'o')
  assert.equal(q.kind, 'take')
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U), rest: false }, 'o'), new RegExp(SITE_WORDS.priceNotMet))
  assert.equal(L.calls.some((c) => c[0] === 'order_quote'), false)
})

test('min_fill sets the resting order\'s smallest fill, at the price for a purchase; take_back_after its refund', async () => {
  const U = 10n ** 8n
  const L = fakeLeaves()
  const S = makeSiteOrders({ engine: fakeEngine(), leaves: L, assetMeta: meta, fmtAtoms, store: mem() })
  await S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(2n * U), price: String(4200n * U), min_fill: String(U / 4n), take_back_after: 604800 }, 'o')
  let a = L.calls.filter((c) => c[0] === 'order_quote').pop()[1]
  assert.deepEqual([a.min_lot, a.expiry], [String(U / 4n), String(1000 + 604800)])
  // A purchase of 1 GOLD at 3800 sells 3800 USDX; a smallest fill of 0.25 GOLD is 950 USDX.
  await S.quote({ type: 'limit', base: B, quote: Q, side: 'buy', amount: String(U), price: String(3800n * U), min_fill: String(U / 4n) }, 'o')
  a = L.calls.filter((c) => c[0] === 'order_quote').pop()[1]
  assert.deepEqual([a.sell, a.amount, a.min_lot, a.expiry], [Q, String(3800n * U), String(950n * U), String(1000 + 86400)])
  await assert.rejects(S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U), min_fill: String(2n * U) }, 'o'), new RegExp(SITE_WORDS.minFillTooBig))
})

test('take_back_after shorter than the operator allows becomes the earliest it names, and the approval shows it', async () => {
  const U = 10n ** 8n
  const L = fakeLeaves(); const inner = L.command
  L.command = async (c, a) => {
    if (c === 'order_quote' && Number(a.expiry) < 1000 + 21600) { L.calls.push([c, { ...a }]); throw new Error('refused: the order would be refundable from median time ' + a.expiry + ', and the operator takes no take of an order refundable within 21600 s: name an expiry of at least 23800 (the chain\'s median time is 1000)') }
    if (c === 'order_quote') { L.calls.push([c, { ...a }]); return { fee: { asset: a.sell, amount: '25' }, full_price: '999', min_lot: a.min_lot, expiry_locktime: Number(a.expiry) } }
    return inner(c, a)
  }
  const S = makeSiteOrders({ engine: fakeEngine(), leaves: L, assetMeta: meta, fmtAtoms, store: mem() })
  const q = await S.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U), take_back_after: 3600 }, 'o')
  const asks = L.calls.filter((c) => c[0] === 'order_quote').map((c) => c[1].expiry)
  assert.deepEqual(asks, ['4600', '23800'])
  assert.match(JSON.stringify(q.display), /1970-01-01 06:36 UTC/)
  // Without the option asked, the same refusal is not worked around.
  const L2 = fakeLeaves(); L2.command = async (c, a) => { if (c === 'order_quote') throw new Error('refused: name an expiry of at least 99999999'); return c === 'schedule' ? { now: 1000 } : null }
  const S2 = makeSiteOrders({ engine: fakeEngine(), leaves: L2, assetMeta: meta, fmtAtoms, store: mem() })
  await assert.rejects(S2.quote({ type: 'limit', base: B, quote: Q, side: 'sell', amount: String(U), price: String(4200n * U) }, 'o'), new RegExp(SITE_WORDS.cannotRest))
})
