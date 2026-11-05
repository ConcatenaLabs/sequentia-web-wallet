// One payment over Lightning may use at most a share of the operator's live capacity in its asset
// and direction (10% by default): its channels are shared by every user's payments and by the BTC
// legs of swaps, and one large payment would drain them for everyone. Above it, the payment goes
// on the chain. It replaces the fixed 1,000 USD figure (05/11/2026).
//
//   node --test ln-capacity.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CAPACITY_SHARE, lnCapacityShare, fitsCapacity, lnCapacity, assetLightningRoute } from './asset-lightning.js'

const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
// The operator's info as the live testnet publishes it (05/11/2026).
const info = { server_info: {
  assets: [{ asset: USDX, lightning: { state: 'up', channels: 4, spendable: '2688516826484', receivable: '2254603160348' } }],
  lightning: { bitcoin: { node: { state: 'up', channels: 4, spendable: '208639990', receivable: '88526452' } },
    send: { timeout_seconds: 777600 }, receive: { block_seconds: 60 } },
} }

test('the share: 10% unless the page names another', () => {
  assert.equal(CAPACITY_SHARE, 0.10)
  assert.equal(lnCapacityShare(undefined), 0.10)
  assert.equal(lnCapacityShare(0.2), 0.2)
  assert.equal(lnCapacityShare(null), null, 'null: no cap')
  assert.equal(lnCapacityShare(0), 0.10, 'not a share: the default')
  assert.equal(lnCapacityShare(2), 0.10)
})

test('a payment fits a share of the capacity in its direction', () => {
  assert.equal(lnCapacity(info, USDX, 'out'), 2688516826484n)
  assert.equal(lnCapacity(info, USDX, 'in'), 2254603160348n)
  assert.equal(lnCapacity(info, 'BTC', 'out'), 208639990n)
  assert.equal(lnCapacity(info, 'BTC', 'in'), 88526452n)
  assert.equal(lnCapacity(info, 'ff'.repeat(32), 'out'), null, 'no node: nothing known')
  // 10% of 88,526,452 sats received: 8,852,645.
  assert.equal(fitsCapacity(8_852_645n, 88526452n, 0.10), true)
  assert.equal(fitsCapacity(8_852_646n, 88526452n, 0.10), false)
  assert.equal(fitsCapacity(9n ** 30n, null, 0.10), true, 'a capacity not published holds nothing back')
  assert.equal(fitsCapacity(9n ** 30n, 1n, null), true, 'no share: no cap')
})

test('an asset paid to another operator over Lightning: more than its share goes to the address', () => {
  // An invoice is not needed to see the order of the checks: the capacity check sits right after
  // the liquidity one, and says 'capacity'.
  const src = readFileSync(new URL('./asset-lightning.js', import.meta.url), 'utf8')
  assert.match(src, /if \(leg\.node\.spendable != null && big\(leg\.node\.spendable\) < big\(atoms\)\) return \{ route: 'address', why: 'liquidity' \}\r?\n  if \(!fitsCapacity\(atoms, leg\.node\.spendable, capacityShare\)\) return \{ route: 'address', why: 'capacity' \}/)
  assert.equal(assetLightningRoute({ invoice: null, info }).why, 'none')
})

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

test('the page holds every Lightning payment to the capacity, both ways', () => {
  assert.match(html, /function lnFits\(kind, dir, atoms\)\{/)
  // BTC to a receive code: its invoice only when it fits, else its address.
  assert.match(html, /if\(c\.lightning && btcArkRoutes\(\) && lnFits\('BTC', 'out', atoms\)\) return \{ dest: c\.lightning, byAddress: false \};/)
  assert.match(html, /if\(c\.lightning && btcArkRoutes\(\) && c\.address\) return \{ dest: c\.address, byAddress: true, why: DEFAULT_WORDS\.byAddressNoWay \};/)
  // An asset to another operator: the rule's capacity check, at the page's share.
  assert.match(html, /capacityShare: lnCapacityShare\(window\.SEQ_LN_CAPACITY_SHARE\) \}\);/)
  assert.match(html, /capacity: \(\)=> DEFAULT_WORDS\.byAddressNoWay,/)
  // Receive makes an invoice only for an amount the channels can take in.
  assert.match(html, /const can = atoms>0n && !large && lnFits\(asset, 'in', atoms\) && /)
})
