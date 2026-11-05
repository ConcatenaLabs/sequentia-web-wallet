// One payment over Lightning is held to the limit the operator publishes for its node, per asset
// and direction (`max_payment` in its info: by default a tenth of what the node can carry, less what
// it keeps for swaps). The operator enforces it; the wallet reads it and pays on the chain above it.
// It holds no share of its own. An operator that publishes none: the page's fallback in USD.
//
//   node --test ln-capacity.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { lnMaxPayment, fitsMax, assetLightningRoute } from './asset-lightning.js'
import * as al from './asset-lightning.js'

const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
// The operator's info as arcad publishes it: each node's capacity and the limit it sets from it.
const info = { server_info: {
  assets: [{ asset: USDX, lightning: { state: 'up', channels: 4, spendable: '2688516826484', receivable: '2254603160348',
    max_payment: { send: '268851682648', receive: '225460316034' }, payment_limit: { share_ppm: 100000, reserve: '0' } } }],
  lightning: { bitcoin: { node: { state: 'up', channels: 4, spendable: '208639990', receivable: '88526452',
    max_payment: { send: '10863999', receive: '3852645' }, payment_limit: { share_ppm: 100000, reserve: '50000000' } } },
  send: { timeout_seconds: 777600 }, receive: { block_seconds: 60 } },
} }
// An operator that publishes its capacity and no limit.
const bare = JSON.parse(JSON.stringify(info))
delete bare.server_info.assets[0].lightning.max_payment
delete bare.server_info.lightning.bitcoin.node.max_payment

test('the limit is the operator’s, read per asset and direction', () => {
  assert.equal(lnMaxPayment(info, USDX, 'out'), 268851682648n)
  assert.equal(lnMaxPayment(info, USDX, 'in'), 225460316034n)
  assert.equal(lnMaxPayment(info, 'BTC', 'out'), 10863999n)
  assert.equal(lnMaxPayment(info, 'BTC', 'in'), 3852645n)
  assert.equal(lnMaxPayment(info, 'ff'.repeat(32), 'out'), null, 'no node: nothing published')
  assert.equal(lnMaxPayment(bare, USDX, 'out'), null, 'no limit published')
  assert.equal(lnMaxPayment(bare, 'BTC', 'in'), null)
  assert.equal(fitsMax(3852645n, 3852645n), true, 'at the limit')
  assert.equal(fitsMax(3852646n, 3852645n), false, 'one atom over')
  assert.equal(fitsMax(9n ** 30n, null), true, 'none published: the page’s fallback decides')
  // The wallet keeps no share of its own.
  for (const k of ['CAPACITY_SHARE', 'lnCapacityShare', 'fitsCapacity', 'lnCapacity']) assert.equal(al[k], undefined, k)
})

test('an asset paid to another operator over Lightning: above the operator’s limit it goes to the address', () => {
  const src = readFileSync(new URL('./asset-lightning.js', import.meta.url), 'utf8')
  assert.match(src, /if \(leg\.node\.spendable != null && big\(leg\.node\.spendable\) < big\(atoms\)\) return \{ route: 'address', why: 'liquidity' \}\r?\n  if \(!fitsMax\(atoms, lnMaxPayment\(info, asset, 'out'\)\)\) return \{ route: 'address', why: 'capacity' \}/)
  assert.equal(assetLightningRoute({ invoice: null, info }).why, 'none')
})

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

test('the page holds every Lightning payment to the operator’s limit, both ways', () => {
  assert.doesNotMatch(html, /SEQ_LN_CAPACITY_SHARE/)
  assert.match(html, /function lnFits\(kind, dir, atoms\)\{/)
  // BTC to a receive code: its invoice only when it fits, else its address.
  assert.match(html, /if\(c\.lightning && btcArkRoutes\(\) && lnFits\('BTC', 'out', atoms\)\) return \{ dest: c\.lightning, byAddress: false \};/)
  assert.match(html, /if\(c\.lightning && btcArkRoutes\(\) && c\.address\) return \{ dest: c\.address, byAddress: true, why: DEFAULT_WORDS\.byAddressNoWay \};/)
  assert.match(html, /capacity: \(\)=> DEFAULT_WORDS\.byAddressNoWay,/)
  // No limit published: a fallback in USD, never no limit.
  assert.match(html, /if\(window\.SEQ_LN_FALLBACK_USD === undefined\) window\.SEQ_LN_FALLBACK_USD = 1500;/)
  assert.match(html, /if\(max == null\) return lnFallbackFits\(kind, atoms\);/)
  assert.match(html, /return fitsMax\(atoms, max\);/)
  assert.match(html, /const limitUsd = lnMaxKnown\(asset, 'out'\) == null \? lightningLimitUsd\(window\.SEQ_LN_FALLBACK_USD\) : lightningLimitUsd\(window\.SEQ_ASSET_LN_MAX_USD\);/)
  // No request when paying: the info the library already holds.
  assert.match(html, /function lnMaxKnown\(kind, dir\)\{\r?\n  let info = null; try\{ info = leavesApi && leavesApi\.isOpen\(\) \? leavesApi\.info\(\) : null; \}catch\{\}/)
  // Receive makes an invoice only for an amount the operator takes in.
  assert.match(html, /const can = atoms>0n && !large && lnFits\(asset, 'in', atoms\) && /)
})
