// The leaf maker's rates from the price feed: a ticker is looked up as the feed spells it, so a
// BTC pair is priced from the testnet feed's `tBTC`, and in capitals otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rateFromPrices, steadyRate, JUMP_READS, priceOf, PRICE_MAX_AGE_S } from './leaf-maker.mjs'

const feed = { USDX: { price: 1 }, tBTC: { price: 80000 }, EURX: 1.12 }
const USDX = { ticker: 'USDX', precision: 8 }, BTC = { ticker: 'tBTC', precision: 8 }

test('BTC for USDX from the feed\'s tBTC: 80,000 USDX atoms a satoshi, the spread on the maker\'s side', () => {
  const r = rateFromPrices(feed, BTC, USDX, 100)
  assert.equal(Number(r.rate_num) / Number(r.rate_den), 80800)
  const back = rateFromPrices(feed, USDX, BTC, 100)
  assert.equal(back.rate_num, '1263') // ceil(1.01 / 80000 × 1e8): the maker's side
})

test('a lower-case ticker still finds a feed key in capitals; a missing price quotes nothing', () => {
  assert.ok(rateFromPrices(feed, { ticker: 'eurx', precision: 8 }, USDX, 0))
  assert.equal(rateFromPrices(feed, { ticker: 'GOLD', precision: 8 }, USDX, 0), null)
})

test('a reading far from the rate quoted now is held back until it repeats', () => {
  const jumps = new Map()
  const now = { rate_num: '400000000000', rate_den: '100000000' }      // 4,000 a unit
  const near = { rate_num: '410000000000', rate_den: '100000000' }
  const wild = { rate_num: '1972228600000000', rate_den: '100000000' } // ~4,900 times as much
  assert.equal(steadyRate('p', now, near, jumps), near, 'a small move is taken at once')
  for (let i = 1; i < JUMP_READS; i++) assert.equal(steadyRate('p', near, wild, jumps), near, `held back, reading ${i}`)
  assert.equal(steadyRate('p', near, wild, jumps), wild, 'taken once it has repeated')
  assert.equal(steadyRate('q', null, wild, jumps), wild, 'a first reading is taken')
  // One wild reading, then a sane one: the count starts again.
  steadyRate('r', now, wild, jumps)
  assert.equal(steadyRate('r', now, near, jumps), near)
  assert.equal(steadyRate('r', near, wild, jumps), near)
})

test('a price whose reading is more than ten minutes old is not quoted; a seeded one has no age', () => {
  const now = 1_800_000_000_000, s = now / 1000
  const USD = { ticker: 'USDX', precision: 8 }, GOLD = { ticker: 'GOLD', precision: 8 }
  const feed = (gold) => ({ USDX: { price: 1, as_of: s }, GOLD: gold })
  assert.ok(rateFromPrices(feed({ price: 4000, as_of: s - PRICE_MAX_AGE_S }), GOLD, USD, 30, now))
  assert.equal(rateFromPrices(feed({ price: 4000, as_of: s - PRICE_MAX_AGE_S - 1 }), GOLD, USD, 30, now), null)
  assert.equal(rateFromPrices(feed({ price: 4000, as_of: s - PRICE_MAX_AGE_S - 1 }), USD, GOLD, 30, now), null)
  assert.ok(rateFromPrices(feed({ price: 4000, as_of: s - 86400, static: true }), GOLD, USD, 30, now))
  // A feed that dates nothing is read as before.
  assert.ok(rateFromPrices(feed({ price: 4000 }), GOLD, USD, 30, now))
  assert.equal(priceOf(feed({ price: 4000, as_of: s - 3600 }), GOLD, now), null)
})
