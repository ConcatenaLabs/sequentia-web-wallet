// What default mode keeps in the Ark, in USD: BTC up to 1000 moved there from the wallet's own
// address; payments received take it to 2000, and then all above 1000 moves to the address, so
// the Ark holds between 1000 and 1999. One payment of 1000 or more goes to the address straight
// away. Each asset 5000 and 7500, back to 5000 at 7500; 1000 or more to the address straight away
// there too (02/11/2026, reworked 03/11/2026).
//
//   node --test ark-limits.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { ARK_LIMITS, arkLimits, usdAtoms, boardRoom, moveOutAtoms, directUsd, goesToAddress } from './ark-limits.js'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'
import { boardAmount } from './btc-ark.js'

test('the limits: 1000, 2000 and 1000 USD of BTC; 5000, 7500 and 1000 of each asset', () => {
  const all = { btc: { board: 1000, hold: 2000, direct: 1000 }, asset: { board: 5000, hold: 7500, direct: 1000 } }
  assert.deepEqual(ARK_LIMITS, all)
  assert.deepEqual(arkLimits(undefined), all)
  assert.deepEqual(arkLimits({ btc: { board: 300 } }).btc, { board: 300, hold: 2000, direct: 1000 }, 'a figure left out keeps its default')
  assert.deepEqual(arkLimits({ asset: { board: null, hold: null, direct: null } }).asset, { board: null, hold: null, direct: null }, 'null: no limit')
  assert.deepEqual(arkLimits({ btc: { board: 'x', hold: -1 } }).btc, { board: 1000, hold: 2000, direct: 1000 }, 'a figure that is not one keeps its default')
  assert.deepEqual(arkLimits({ asset: { board: 8000, hold: 6000 } }).asset, { board: 8000, hold: 8000, direct: 1000 }, 'hold is never under board')
})

test('USD in atoms', () => {
  assert.equal(usdAtoms(1000, 100_000, 8), 1_000_000n, '1000 USD of BTC at 100000: 0.01 BTC')
  assert.equal(usdAtoms(5000, 1, 2), 500_000n, '5000 USD of a dollar token with 2 decimals')
  assert.equal(usdAtoms(10000, 0.5, 0), 20_000n)
  assert.equal(usdAtoms(1000, 0, 8), null, 'no price, no figure')
  assert.equal(usdAtoms(1000, undefined, 8), null)
})

test('the wallet moves into the Ark up to the board limit', () => {
  const btc = (held, which) => ({ held, limitUsd: ARK_LIMITS.btc[which], price: 100_000, precision: 8 })
  assert.equal(boardRoom(btc(0n, 'board')), 1_000_000n, 'an empty Ark takes 1000 USD of the address\'s BTC')
  assert.equal(boardRoom(btc(400_000n, 'board')), 600_000n)
  assert.equal(boardRoom(btc(1_500_000n, 'board')), 0n, 'past 1000 USD nothing more is moved in')
  assert.equal(boardRoom({ held: 0n, limitUsd: null, price: 1, precision: 2 }), null, 'no limit')
  assert.equal(boardRoom({ held: 0n, limitUsd: 5000, price: null, precision: 2 }), null, 'an unpriced asset has no limit')
  const usdx = (held) => ({ held, limitUsd: ARK_LIMITS.asset.board, price: 1, precision: 2 })
  assert.equal(boardRoom(usdx(0n)), 500_000n)
  assert.equal(boardRoom(usdx(499_999n)), 1n)
})

test('at the hold limit everything above the board limit moves out, in one move', () => {
  const btc = (held) => ({ held, board: 1000, hold: 2000, price: 100_000, precision: 8 })
  assert.equal(moveOutAtoms(btc(1_999_999n)), 0n, 'under 2000 USD it all stays')
  assert.equal(moveOutAtoms(btc(2_000_000n)), 1_000_000n, 'at 2000 USD, 1000 moves: the Ark is back at 1000')
  assert.equal(moveOutAtoms(btc(2_700_000n)), 1_700_000n, 'all above 1000, never less than 1000')
  const usdx = (held) => ({ held, ...ARK_LIMITS.asset, price: 1, precision: 2 })
  assert.equal(moveOutAtoms(usdx(749_999n)), 0n)
  assert.equal(moveOutAtoms(usdx(750_000n)), 250_000n, 'an asset: 7500 held, 2500 moves, back to 5000')
  assert.equal(moveOutAtoms({ held: 9n ** 20n, board: null, hold: 7500, price: 1, precision: 2 }), 0n)
  assert.equal(moveOutAtoms({ held: 9n ** 20n, board: 5000, hold: 7500, price: null, precision: 2 }), 0n, 'no price, no move')
})

test('one payment of 1000 USD or more goes to the address straight away, on both chains', () => {
  assert.equal(directUsd(ARK_LIMITS.btc), 1000)
  assert.equal(directUsd(ARK_LIMITS.asset), 1000)
  assert.equal(directUsd({ direct: null }), null)
  const btc = (atoms) => ({ atoms, ...ARK_LIMITS.btc, price: 100_000, precision: 8 })
  assert.equal(goesToAddress(btc(999_999n)), false, 'under 1000 USD: the Ark')
  assert.equal(goesToAddress(btc(1_000_000n)), true, '1000 USD: the address')
  const usdx = (atoms) => ({ atoms, ...ARK_LIMITS.asset, price: 1, precision: 2 })
  assert.equal(goesToAddress(usdx(99_999n)), false)
  assert.equal(goesToAddress(usdx(100_000n)), true, '1000 USDX: the address')
  assert.equal(goesToAddress({ atoms: 9n ** 20n, ...ARK_LIMITS.asset, price: null, precision: 2 }), false, 'unpriced: never')
  const w = DEFAULT_WORDS.byAddressLarge('1,000')
  assert.equal(w, 'A payment of 1,000 USD or more goes to the address.')
  assert.deepEqual(forbiddenIn(w), [])
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
  assert.match(html, /if\(window\.SEQ_ARK_LIMITS === undefined\) window\.SEQ_ARK_LIMITS = \{ btc: \{ board: 1000, hold: 2000, direct: 1000 \}, asset: \{ board: 5000, hold: 7500, direct: 1000 \} \};/)
  // BTC is boarded within the limit (a trade that asks for more gets it).
  assert.match(html, /let cap = arkRoom\('BTC'\);\r?\n  if\(cap != null && _btcArkWanted > cap\) cap = _btcArkWanted;\r?\n  if\(cap != null && cap <= 0n\) return;/)
  assert.match(html, /btcArk\.board\(\{ utxos: btcGatherUtxos, buildUnsigned: btcDrainUnsigned, broadcast: btcBroadcastHex, cap \}\)/)
  // Each asset too, by the leaf library.
  assert.match(html, /boardRoom: \(hex\)=> arkRoom\(hex\),/)
  assert.match(leaves, /if \(room != null && room < c0\.min\) continue\r?\n      const c = room != null && room < c0\.onchain \? \{ \.\.\.c0, onchain: room \} : c0/)
  // No price yet: nothing moves in until there is one.
  assert.match(html, /if\(o\.limitUsd != null && !\(o\.price > 0\) && \(kind==='BTC' \|\| !Object\.keys\(PRICES\)\.length\)\) return 0n;/)
})

test('Receive keeps its instant part; the hold limit moves the rest out; a large payment goes to the address', () => {
  assert.match(html, /lightning: inv \? inv\.invoice : undefined, ark: _recvArk \|\| undefined, sequentia: _recvCode\.text \}\);/)
  assert.ok(!/btcRoom/.test(html), 'Receive never drops the Ark part')
  // An amount that goes to the address carries no invoice.
  assert.match(html, /const large = atoms>0n && !!arkDirectWhy\(asset, atoms\);\r?\n  const can = atoms>0n && !large && /)
  // The payer sends one payment of the difference or more to the code's address.
  const r = html.slice(html.indexOf('function payCodeRoute('), html.indexOf('function payCodeDestination('))
  assert.match(r, /if\(c\.address && !isOampAsset\(asset\)\)\{ const why = arkDirectWhy\(asset, atoms\); if\(why\) return \{ dest: c\.address, byAddress: true, why \}; \}/)
  assert.ok(r.indexOf('arkDirectWhy') < r.indexOf("if(asset === 'BTC')"), 'before any instant route')
  assert.match(html, /let atoms=null; if\(!isOampAsset\(r\.asset\)\)\{ try\{ atoms=parseAtoms\(r\.amtS, r\.asset==='BTC' \? 8 : sendPrecision\(r\.asset\)\); \}catch\{\} \}/, 'BTC too')
  assert.match(html, /function arkDirectWhy\(kind, atoms\)\{\r?\n  if\(devMode\(\) \|\| atoms == null\) return null;/, 'default mode only')
  const i = html.indexOf('async function arkHoldTick('), tick = html.slice(i, html.indexOf('\n}', i))
  assert.ok(i > 0)
  assert.match(tick, /if\(_arkOutBusy \|\| devMode\(\) \|\| !wollet\) return;/, 'never in developer mode')
  assert.match(tick, /const over = moveOutAtoms\(\{ held: arkHeld\('BTC'\), \.\.\.arkLimitsOf\('BTC'\) \}\);/)
  assert.match(tick, /await btcArk\.send\(to, sats\)/)
  assert.match(tick, /const over = moveOutAtoms\(\{ held: arkHeld\(h\), \.\.\.arkLimitsOf\(h\) \}\);/)
  assert.match(tick, /if\(isOampAsset\(h\) \|\| under\.some\(o=>o\.asset===h\)\) continue;/, 'one move at a time per asset')
  assert.match(tick, /await leavesApi\.offboard\(\{ asset: h, amount: String\(atoms\), address, shown: q \}\)/)
  assert.match(html, /setInterval\(\(\)=>\{ arkHoldTick\(\)\.catch\(\(\)=>\{\}\); \}, 30_000\);/)
})
