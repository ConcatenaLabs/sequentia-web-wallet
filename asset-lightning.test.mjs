// asset-lightning.js: whether an asset sent to a receive code of another operator goes over
// Lightning or to the code's address. The invoices are built here, with a valid checksum and a zero
// signature (the rule never checks the signature: the operator's node does, before paying).
//   node --test asset-lightning.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assetLightningRoute, lightningLimitUsd, lockFits, usdValue, operatorLeg, receivableAssets, receiveState, isRouteRefusal,
  DEFAULT_LIMIT_USD, HOP_CLTV_BLOCKS } from './asset-lightning.js'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function toGroups (hex) { const out = []; let acc = 0, bits = 0; for (let i = 0; i < hex.length; i += 2) { acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31) } acc &= (1 << bits) - 1 } if (bits) out.push((acc << (5 - bits)) & 31); return out }
function intGroups (n, len) { const g = []; for (let i = 0; i < len; i++) { g.unshift(n % 32); n = Math.floor(n / 32) } return g }
function polymod (v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = (((c & 0x1ffffff) << 5) ^ x) >>> 0; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c = (c ^ G[i]) >>> 0 } return c }
// An invoice on Sequentia testnet: `amount` the human part's amount ('1' is 10^11 msat, one unit of an
// asset of 8 decimals), made at `timestamp`, lapsing `expiry` seconds later, asking `cltv` blocks.
function invoice ({ amount = '1', asset = USDX, timestamp = 1_000_000, expiry = 3600, cltv = 5790 } = {}) {
  const hrp = 'lntsqt' + amount
  const g = intGroups(timestamp, 7)
  for (const [type, groups] of [[1, toGroups('11'.repeat(32))], [29, toGroups(asset)], [24, intGroups(cltv, 3)], [6, intGroups(expiry, 4)]]) g.push(type, groups.length >> 5, groups.length & 31, ...groups)
  for (let i = 0; i < 104; i++) g.push(0)
  const pre = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31))
  const pm = polymod(pre.concat(g, [0, 0, 0, 0, 0, 0])) ^ 1
  for (let i = 0; i < 6; i++) g.push((pm >>> (5 * (5 - i))) & 31)
  return hrp + '1' + g.map((x) => CS[x]).join('')
}

const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const GOLD = 'c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40'
const SUPERVISED = '9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa'
const UNIT = 100_000_000n
// The leaf library's `info`, as the public testnet's operators publish it.
function info ({ spendable = '979998623', state = 'up', timeout = 777600 } = {}) {
  const node = { state, network: 'sequentia-testnet', channels: 1, spendable, receivable: '980000000', receives: true }
  return { server_info: {
    assets: [{ asset: USDX, lightning: node }, { asset: GOLD, lightning: node }, { asset: SUPERVISED, lightning: null, supervised: {} }],
    lightning: { send: { operator_delay_units: 36, owner_delay_units: 72, timeout_seconds: timeout },
      receive: { operator_delay_units: 36, window_seconds: 21600, invoice_expiry_seconds: 3600, block_seconds: 60, internal_gap_seconds: 43632 } },
  } }
}
const NOW = 1_000_100
const route = (o) => assetLightningRoute({ invoice: invoice(o.inv), asset: USDX, atoms: UNIT, precision: 8, usd: 1, limitUsd: 1000, info: info(), nowSeconds: NOW, ...o })

test('a payment within the limit, of the invoice\'s asset and amount, goes over Lightning', () => {
  const r = route({})
  assert.equal(r.route, 'lightning')
  assert.equal(r.invoice, invoice())
  // Upper case, as a receive code carries it: the same invoice.
  assert.equal(route({ invoice: invoice().toUpperCase() }).route, 'lightning')
})

test('the limit is in USD, not in units of the asset', () => {
  // 5 units of an asset at 1 USD: 5 USD, well within 1,000.
  assert.equal(route({ inv: { amount: '5' }, atoms: 5n * UNIT }).route, 'lightning')
  // One unit of GOLD at 3,907 USD: over 1,000, so the address, though it is a single unit.
  const gold = assetLightningRoute({ invoice: invoice({ asset: GOLD }), asset: GOLD, atoms: UNIT, precision: 8, usd: 3907, limitUsd: 1000, info: info(), nowSeconds: NOW })
  assert.deepEqual(gold, { route: 'address', why: 'limit' })
  // A tenth of a unit of GOLD (390.7 USD) goes over Lightning.
  const tenth = assetLightningRoute({ invoice: invoice({ asset: GOLD, amount: '100m' }), asset: GOLD, atoms: UNIT / 10n, precision: 8, usd: 3907, limitUsd: 1000, info: info(), nowSeconds: NOW })
  assert.equal(tenth.route, 'lightning')
  // Exactly at the limit is within it.
  assert.equal(route({ inv: { amount: '5' }, atoms: 5n * UNIT, usd: 200 }).route, 'lightning')
  assert.deepEqual(route({ inv: { amount: '5' }, atoms: 5n * UNIT, usd: 200.01 }), { route: 'address', why: 'limit' })
  // No limit: every amount the operator can carry.
  assert.equal(route({ usd: 1e9, limitUsd: null }).route, 'lightning')
  // Not valued by the price feed: it cannot be held to the limit, so the address.
  assert.deepEqual(route({ usd: null }), { route: 'address', why: 'unpriced' })
  assert.equal(route({ usd: null, limitUsd: null }).route, 'lightning')
})

test('the page sets the limit; unset, it is the default', () => {
  assert.equal(lightningLimitUsd(undefined), DEFAULT_LIMIT_USD)
  assert.equal(lightningLimitUsd(250), 250)
  assert.equal(lightningLimitUsd('250'), 250)
  assert.equal(lightningLimitUsd(0), 0)
  assert.equal(lightningLimitUsd(null), null)
  assert.equal(lightningLimitUsd('lots'), DEFAULT_LIMIT_USD)
  assert.equal(lightningLimitUsd(-5), DEFAULT_LIMIT_USD)
  assert.equal(usdValue(150_000_000n, 8, 2), 3)
  assert.equal(usdValue(1n, 0, 0), null)
})

test('an invoice that is not for this payment is passed over', () => {
  assert.deepEqual(route({ inv: { asset: GOLD } }), { route: 'address', why: 'none' }, 'another asset')
  assert.deepEqual(route({ inv: { amount: '2' } }), { route: 'address', why: 'amount' }, 'another amount')
  assert.deepEqual(route({ inv: { timestamp: NOW - 3590, expiry: 3600 } }), { route: 'address', why: 'expired' }, 'lapsing within a minute')
  assert.deepEqual(route({ invoice: null }), { route: 'address', why: 'none' })
  assert.deepEqual(route({ invoice: 'lntb10u1pfoo' }), { route: 'address', why: 'none' })
  assert.deepEqual(route({ info: null }), { route: 'address', why: 'none' }, 'a wallet that holds nothing with an operator')
  // A Bitcoin invoice never pays an asset.
  const btc = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
  assert.deepEqual(route({ invoice: btc }), { route: 'address', why: 'none' })
})

test('the payer\'s operator must be able to carry it', () => {
  assert.deepEqual(route({ info: info({ state: 'down' }) }), { route: 'address', why: 'unavailable' })
  // The public testnet's second operator: 9.79998623 USDX spendable in its one channel.
  assert.deepEqual(route({ inv: { amount: '10' }, atoms: 10n * UNIT, info: info() }), { route: 'address', why: 'liquidity' })
  assert.equal(route({ inv: { amount: '9' }, atoms: 9n * UNIT, info: info() }).route, 'lightning')
  const noLeg = { server_info: { ...info().server_info, assets: [{ asset: USDX, lightning: null }] } }
  assert.deepEqual(route({ info: noLeg }), { route: 'address', why: 'unavailable' })
  const sup = assetLightningRoute({ invoice: invoice({ asset: SUPERVISED }), asset: SUPERVISED, atoms: UNIT, precision: 8, usd: 1, limitUsd: 1000, info: info(), nowSeconds: NOW })
  assert.deepEqual(sup, { route: 'address', why: 'unavailable' })
})

test('the lock: an Ark invoice\'s final lock fits what the operator lets its node lock, with a hop to spare', () => {
  // The bundle's window for a payment (ARCA_SEND_TIMEOUT, nine days) and its invoices' final lock
  // (about 5,790 blocks at the specification's exit delays), a minute a block. arcad lets its node
  // lock a payment for (777,600 + 600 - 21,600) / 2 / 60 = 6,305 blocks.
  const direct = lockFits(5790, 60, 777600, 0), hop = lockFits(5790, 60, 777600, 1)
  assert.equal(direct.bound, 6305)
  assert.ok(direct.fits && hop.fits)
  assert.equal(hop.needs, 5790 + HOP_CLTV_BLOCKS)
  // Two nodes between the operators still fit at the rule's 144 blocks each; four do not.
  assert.equal(lockFits(5790, 60, 777600, 2).fits, true)
  assert.equal(lockFits(5790, 60, 777600, 4).fits, false)
  // A four-day window (enough for a payment inside one operator) does not carry it.
  assert.equal(lockFits(5790, 60, 4 * 86400).fits, false)
  // A final lock past the bound does not fit, nor does an operator that publishes no window.
  assert.equal(lockFits(6200, 60, 777600).fits, false)
  assert.equal(lockFits(5790, 60, null).fits, false)
  assert.deepEqual(route({ inv: { cltv: 6200 } }), { route: 'address', why: 'lock' })
  assert.deepEqual(route({ info: info({ timeout: 3600 }) }), { route: 'address', why: 'lock' })
})

test('the operator\'s facts and the receive side', () => {
  const leg = operatorLeg(info(), USDX)
  assert.equal(leg.node.state, 'up'); assert.equal(leg.timeoutSeconds, 777600); assert.equal(leg.blockSeconds, 60)
  assert.deepEqual(receivableAssets(info()), [USDX, GOLD], 'never a supervised asset')
  assert.deepEqual(receivableAssets(info({ state: 'down' })), [])
  assert.deepEqual(receivableAssets(null), [])
  assert.equal(receiveState({ state: 'waiting', expires_at: 200 }, 100), 'open')
  assert.equal(receiveState({ state: 'waiting', expires_at: 50 }, 100), 'gone')
  assert.equal(receiveState({ state: 'issuing' }, 100), 'paid')
  assert.equal(receiveState({ state: 'received' }, 100), 'paid')
  assert.equal(receiveState({ state: 'failed' }, 100), 'gone')
  assert.equal(receiveState(undefined, 100), 'gone')
})

test('which refusals mean the way cannot carry it', () => {
  for (const s of ['no route to the payee', 'the payment failed: temporary_channel_failure', 'the operator\'s Lightning node in asset ab is down: x',
    'insufficient capacity']) assert.ok(isRouteRefusal(new Error(s)), s)
  for (const s of ['the wallet holds too little of asset ab', 'the invoice has expired']) assert.ok(!isRouteRefusal(new Error(s)), s)
})

test('the words are plain, and the page wires the rule into Send and Receive', () => {
  for (const w of [DEFAULT_WORDS.byAddressAbove('1,000'), DEFAULT_WORDS.byAddressNoWay, DEFAULT_WORDS.lnOnItsWay, DEFAULT_WORDS.lnNotThrough,
    DEFAULT_WORDS.lnCameBack, DEFAULT_WORDS.toAddress, DEFAULT_WORDS.amountHint]) assert.deepEqual(forbiddenIn(w), [], w)
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /window\.SEQ_ASSET_LN_MAX_USD === undefined\) window\.SEQ_ASSET_LN_MAX_USD = 1000;/)
  assert.match(html, /const d = payCodeRoute\(r\.addr, r\.asset, atoms\);/)
  assert.match(html, /if\(await assetLightningReview\(r, reset, again\)\) return;/)
  assert.match(html, /leavesApi\.command\('lightning_pay', \{ invoice: r\.addr, asset: r\.asset, shown: q \}\)/)
  assert.match(html, /leavesApi\.command\('lightning_receive', \{ asset, amount: String\(atoms\), description: 'Receive' \}\)/)
  // The tree first: a code of the payer's own operator never goes over Lightning.
  const i = html.indexOf('function payCodeRoute('), body = html.slice(i, html.indexOf('\n}', i))
  assert.ok(body.indexOf('leavesApi.treeRoute(full)') < body.indexOf('assetLightningRoute('))
})
