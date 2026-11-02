// What default mode keeps in the Ark, in USD: BTC up to 1000 moved there from the wallet's own
// address and up to 2000 with what it receives there; each asset 5000 and 10000. Anything more
// stays, or goes, on the chain (02/11/2026).
//
//   node --test ark-limits.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { ARK_LIMITS, arkLimits, usdAtoms, boardRoom, receiveRoom, holdExcess, MOVE_OUT_MIN_USD } from './ark-limits.js'
import { boardAmount } from './btc-ark.js'

test('the limits: 1000 and 2000 USD of BTC, 5000 and 10000 of each asset', () => {
  assert.deepEqual(ARK_LIMITS, { btc: { board: 1000, hold: 2000 }, asset: { board: 5000, hold: 10000 } })
  assert.deepEqual(arkLimits(undefined), { btc: { board: 1000, hold: 2000 }, asset: { board: 5000, hold: 10000 } })
  assert.deepEqual(arkLimits({ btc: { board: 300 } }).btc, { board: 300, hold: 2000 }, 'a figure left out keeps its default')
  assert.deepEqual(arkLimits({ asset: { board: null, hold: null } }).asset, { board: null, hold: null }, 'null: no limit')
  assert.deepEqual(arkLimits({ btc: { board: 'x', hold: -1 } }).btc, { board: 1000, hold: 2000 }, 'a figure that is not one keeps its default')
  assert.deepEqual(arkLimits({ asset: { board: 8000, hold: 6000 } }).asset, { board: 8000, hold: 8000 }, 'hold is never under board')
})

test('USD in atoms', () => {
  assert.equal(usdAtoms(1000, 100_000, 8), 1_000_000n, '1000 USD of BTC at 100000: 0.01 BTC')
  assert.equal(usdAtoms(5000, 1, 2), 500_000n, '5000 USD of a dollar token with 2 decimals')
  assert.equal(usdAtoms(10000, 0.5, 0), 20_000n)
  assert.equal(usdAtoms(1000, 0, 8), null, 'no price, no figure')
  assert.equal(usdAtoms(1000, undefined, 8), null)
})

test('the wallet moves into the Ark up to the board limit, and receives up to the hold limit', () => {
  const btc = (held, which) => ({ held, limitUsd: ARK_LIMITS.btc[which], price: 100_000, precision: 8 })
  assert.equal(boardRoom(btc(0n, 'board')), 1_000_000n, 'an empty Ark takes 1000 USD of the address\'s BTC')
  assert.equal(boardRoom(btc(400_000n, 'board')), 600_000n)
  assert.equal(boardRoom(btc(1_500_000n, 'board')), 0n, 'past 1000 USD nothing more is moved in')
  assert.equal(receiveRoom(btc(1_500_000n, 'hold')), 500_000n, 'payments still arrive up to 2000 USD')
  assert.equal(receiveRoom(btc(2_000_000n, 'hold')), 0n)
  assert.equal(boardRoom({ held: 0n, limitUsd: null, price: 1, precision: 2 }), null, 'no limit')
  assert.equal(boardRoom({ held: 0n, limitUsd: 5000, price: null, precision: 2 }), null, 'an unpriced asset has no limit')
  const usdx = (held) => ({ held, limitUsd: ARK_LIMITS.asset.board, price: 1, precision: 2 })
  assert.equal(boardRoom(usdx(0n)), 500_000n)
  assert.equal(boardRoom(usdx(499_999n)), 1n)
})

test('the part above the hold limit is moved out, when it is worth a move', () => {
  const btc = (held) => ({ held, limitUsd: 2000, price: 100_000, precision: 8 })
  assert.equal(holdExcess(btc(2_000_000n)), 0n)
  assert.equal(holdExcess(btc(2_030_000n)), 0n, `under ${MOVE_OUT_MIN_USD} USD above it stays`)
  assert.equal(holdExcess(btc(2_500_000n)), 500_000n, '500 USD above it goes to the address')
  assert.equal(holdExcess({ held: 9n ** 20n, limitUsd: null, price: 1, precision: 2 }), 0n)
  assert.equal(holdExcess({ held: 9n ** 20n, limitUsd: 10000, price: null, precision: 2 }), 0n, 'no price, no move')
})

test('a BTC board carries no more than its cap, the rest coming back as change', () => {
  const info = { min_board_sat: 10_000, max_vtxo_sat: 5_000_000 }
  const utxos = [{ value: 3_000_000n, confirmed: true }]
  assert.equal(boardAmount(utxos, info, 0n).amount, 3_000_000n - 244n, 'no cap: the coins less the fee')
  assert.equal(boardAmount(utxos, info, 0n, 2, 1_000_000n).amount, 1_000_000n)
  assert.equal(boardAmount(utxos, info, 0n, 2, 5_000n), null, 'a cap under the least board boards nothing')
})

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const leaves = readFileSync(new URL('./leaves.js', import.meta.url), 'utf8')

test('the page holds the wallet to the limits', () => {
  assert.match(html, /if\(window\.SEQ_ARK_LIMITS === undefined\) window\.SEQ_ARK_LIMITS = \{ btc: \{ board: 1000, hold: 2000 \}, asset: \{ board: 5000, hold: 10000 \} \};/)
  // BTC is boarded within the limit (a trade that asks for more gets it).
  assert.match(html, /let cap = arkRoom\('BTC', 'board'\);\r?\n  if\(cap != null && _btcArkWanted > cap\) cap = _btcArkWanted;\r?\n  if\(cap != null && cap <= 0n\) return;/)
  assert.match(html, /btcArk\.board\(\{ utxos: btcGatherUtxos, buildUnsigned: btcDrainUnsigned, broadcast: btcBroadcastHex, cap \}\)/)
  // Each asset too, by the leaf library.
  assert.match(html, /boardRoom: \(hex\)=> arkRoom\(hex, 'board'\),/)
  assert.match(leaves, /if \(room != null && room < c0\.min\) continue\r?\n      const c = room != null && room < c0\.onchain \? \{ \.\.\.c0, onchain: room \} : c0/)
  // No price yet: nothing moves in until there is one.
  assert.match(html, /if\(o\.limitUsd != null && !\(o\.price > 0\) && \(kind==='BTC' \|\| !Object\.keys\(PRICES\)\.length\)\) return 0n;/)
})

test('past the hold limit, Receive asks to be paid at the address and the rest moves out', () => {
  assert.match(html, /ark: \(btcRoom == null \|\| btcRoom > 0n\) \? \(_recvArk \|\| undefined\) : undefined,/)
  assert.match(html, /asset==='BTC' \? btcArkRoutes\(\) && \(btcRoom == null \|\| atoms <= btcRoom\) : recvAssetChoices\(\)\.includes\(asset\) && \(room\(asset\) == null \|\| atoms <= room\(asset\)\)/)
  const i = html.indexOf('async function arkHoldTick('), tick = html.slice(i, html.indexOf('\n}', i))
  assert.ok(i > 0)
  assert.match(tick, /if\(_arkOutBusy \|\| devMode\(\) \|\| !wollet\) return;/, 'never in developer mode')
  assert.match(tick, /const over = holdExcess\(\{ held: arkHeld\('BTC'\), \.\.\.arkLimitOf\('BTC', 'hold'\) \}\);/)
  assert.match(tick, /await btcArk\.send\(to, sats\)/)
  assert.match(tick, /if\(isOampAsset\(h\) \|\| under\.some\(o=>o\.asset===h\)\) continue;/, 'one move at a time per asset')
  assert.match(tick, /await leavesApi\.offboard\(\{ asset: h, amount: String\(atoms\), address, shown: q \}\)/)
  assert.match(html, /setInterval\(\(\)=>\{ arkHoldTick\(\)\.catch\(\(\)=>\{\}\); \}, 30_000\);/)
})
