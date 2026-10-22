// The leaf maker's rates from the price feed: a ticker is looked up as the feed spells it, so a
// BTC pair is priced from the testnet feed's `tBTC`, and in capitals otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rateFromPrices } from './leaf-maker.mjs'

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
