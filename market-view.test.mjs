// The market view (market-view.js): its words in default mode, the figures it reads from the
// relay's trades and candles, and that only developer mode names a rail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKET_WORDS, MARKET_DEV_WORDS, RANGES, dayOf, seriesOf, unitPrice, flipTrade, candlesOf, bookOf, marketHtml, readMarket, RAIL_NAMES } from './market-view.js'
import { forbiddenIn } from './user-trade.js'

const words = (o) => Object.values(o).flatMap((v) => typeof v === 'function' ? [v('1 GOLD', '3 hours')] : typeof v === 'object' ? words(v) : [v])
const G = '1'.repeat(64), U = '2'.repeat(64)
const meta = (h) => (h === G ? { ticker: 'GOLD', precision: 8 } : { ticker: 'USDX', precision: 2 })
const fmtAtoms = (a, p) => (Number(a) / 10 ** p).toString()
const now = 1_800_000_000

test('default mode words name no rail', () => {
  for (const w of words(MARKET_WORDS)) assert.deepEqual(forbiddenIn(w), [], w)
  assert.ok(words(MARKET_DEV_WORDS).some((w) => forbiddenIn(w).length), 'the developer words are the ones that name rails')
})

test('a price in atoms reads in whole units', () => {
  // 1 GOLD (1e8 atoms) for 4,500 USDX cents (45.00 USDX): 4500/1e8 atoms per atom.
  assert.equal(unitPrice(4500 / 1e8, 8, 2), 45)
})

test('the last 24 hours, and none', () => {
  const t = [{ ts: now - 90000, p: 40, size: 5 }, { ts: now - 3600, p: 44, size: 10 }, { ts: now - 60, p: 46.2, size: 1 }]
  const d = dayOf(t, now)
  assert.equal(d.inDay, true); assert.equal(d.last, 46.2); assert.equal(d.hi, 46.2); assert.equal(d.lo, 44); assert.equal(d.vol, 11n)
  assert.equal(Number(d.changePct.toFixed(2)), 5)
  const old = dayOf([{ ts: now - 200000, p: 40, size: 1 }], now)
  assert.equal(old.inDay, false); assert.equal(old.last, 40)
})

test('the chart carries the last price into the range and up to now', () => {
  const r = RANGES[0]
  const c = [{ t: now - 2 * 86400, c: 40 }, { t: now - 3600, o: 41, h: 42, l: 41, c: 42 }]
  const s = seriesOf(c, r, now)
  assert.deepEqual(s.pts.map((x) => x.p), [40, 42, 42])
  assert.equal(s.pts[0].t, now - r.span); assert.equal(s.pts[2].t, now); assert.equal(s.inRange, 1)
  assert.deepEqual(seriesOf([], r, now).pts, [])
})

test('the other direction of an old relay is turned round', () => {
  const t = flipTrade({ ts: 1, price: 0.5, size: 100, quote_size: 50, side: 'buy' })
  assert.deepEqual([t.price, t.size, t.quote_size, t.side], [2, 50, 100, 'sell'])
  assert.deepEqual(candlesOf([{ ts: 10, price: 1, size: 2 }, { ts: 70, price: 3, size: 1 }, { ts: 900, price: 2, size: 1 }], 900).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]), [[0, 1, 3, 1, 3, 3], [900, 2, 2, 2, 2, 1]])
})

test('the book from both orientations, by rail', () => {
  const offers = [
    { maker_pubkey: 'a', offer_id: '1', offer_asset: G, want_asset: U, offer_amount: '100000000', want_amount: '4600', covenant: {} },
    { maker_pubkey: 'b', offer_id: '2', offer_asset: U, want_asset: G, offer_amount: '8800', want_amount: '200000000', resting_leaf: {} },
    { maker_pubkey: 'b', offer_id: '2', offer_asset: U, want_asset: G, offer_amount: '8800', want_amount: '200000000', resting_leaf: {} },
  ]
  const b = bookOf(offers, G, U, 8, 2, now)
  assert.equal(b.ask, 46); assert.equal(b.bid, 44); assert.equal(b.askDepth, 1); assert.equal(b.bidDepth, 2)
  assert.deepEqual(Object.keys(b.byRail).sort(), ['leaf-resting', 'onchain-fill'])
})

const market = {
  trades: [{ ts: now - 30, price: 4600 / 1e8, size: 50000000, quote_size: 2300, side: 'buy', rail: 'leaf-maker', id: 'x' }],
  candles: [{ t: now - 900, o: 4600 / 1e8, h: 4600 / 1e8, l: 4600 / 1e8, c: 4600 / 1e8, v: 50000000 }],
  offers: [], range: RANGES[0], ticker: {},
}

test('default mode shows the market and no rail; developer mode names it', () => {
  const user = marketHtml(market, { meta, fmtAtoms, dev: false, base: G, quote: U, now })
  assert.match(user, /GOLD \/ USDX/); assert.match(user, /id="mvLast">46</); assert.match(user, /\+0\.00%/)
  assert.match(user, /Nobody is buying or selling right now/)
  assert.match(user, /data-mv-chart/)
  assert.match(user, /Charts by TradingView Lightweight Charts™/)
  assert.match(user, /href="https:\/\/www\.tradingview\.com\/"/)
  const text = user.replace(/<[^>]+>/g, ' ')
  assert.deepEqual(forbiddenIn(text), [], text)
  assert.doesNotMatch(user, /data-rail/)
  const dev = marketHtml(market, { meta, fmtAtoms, dev: true, base: G, quote: U, now })
  assert.match(dev, /data-rail="leaf-maker"/); assert.match(dev, new RegExp(RAIL_NAMES['leaf-maker']))
})

test('a pair with no trades says so', () => {
  const html = marketHtml({ trades: [], candles: [], offers: [], range: RANGES[0] }, { meta, fmtAtoms, base: G, quote: U, now })
  assert.match(html, /No trades yet/); assert.doesNotMatch(html, /mv-chart/)
  const old = marketHtml({ trades: [{ ts: now - 3 * 86400, price: 4000 / 1e8, size: 1e8 }], candles: [{ t: now - 3 * 86400, o: 4e-5, h: 4e-5, l: 4e-5, c: 4e-5 }], offers: [], range: RANGES[0] }, { meta, fmtAtoms, base: G, quote: U, now })
  assert.match(old, /No trades in the last 24 hours · Last trade 40 USDX, 3 days ago/)
})

test('readMarket reads one direction from a relay with a ticker, both from one without', async () => {
  const calls = []
  const fake = (withTicker) => async (url) => {
    calls.push(url)
    const ok = (j) => ({ ok: true, json: async () => j })
    if (url.endsWith('/ticker')) return withTicker ? ok({ last: 1 }) : { ok: false }
    if (url.includes('/trades')) return ok({ trades: url.includes(`/${G}/${U}/`) ? [{ ts: 5, price: 2, size: 10, quote_size: 20, side: 'buy' }] : [{ ts: 9, price: 0.25, size: 8, quote_size: 32, side: 'buy' }] })
    if (url.includes('/candles')) return ok({ candles: [] })
    return ok({ offers: [] })
  }
  const a = await readMarket('http://r', G, U, '1D', fake(true))
  assert.equal(a.trades.length, 1)
  const b = await readMarket('http://r', G, U, '1D', fake(false))
  assert.deepEqual(b.trades.map((t) => [t.ts, t.price, t.size, t.side]), [[5, 2, 10, 'buy'], [9, 4, 32, 'sell']])
  assert.equal(b.candles.length, 1)
})
