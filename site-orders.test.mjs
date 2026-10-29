// site-orders.js: a site's orders mapped onto the user composer's engine and the leaf library's
// placement, against fakes; the engine and the library are driven live by the browser drives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSiteOrders, readParams, restTerms, meetsLimit, SITE_WORDS } from './site-orders.js'
import { forbiddenIn } from './user-trade.js'

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

test('a market buy is sized from a first price, shown, and settled as one trade', async () => {
  const E = fakeEngine(), L = fakeLeaves()
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
