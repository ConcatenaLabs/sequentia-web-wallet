// What default mode keeps in the Bitcoin ark, in USD: it rests at 1500, refilled from the wallet's
// own address only below a quarter of it; payments received take it up to 3000, and then all above
// 1500 moves to the address in one move. One payment of 1500 or more goes to the address straight
// away. Sequentia's Ark has no figures (02/11/2026, reworked 03/11 and 05/11/2026).
//
//   node --test ark-limits.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { ARK_LIMITS, arkLimits, usdAtoms, boardRoom, moveOutAtoms, directUsd, goesToAddress, REFILL_BELOW } from './ark-limits.js'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'
import { boardAmount } from './btc-ark.js'

test('the limits: 1500, 3000 and 1500 USD of BTC; none for Sequentia\'s assets', () => {
  const all = { btc: { board: 1500, hold: 3000, direct: 1500 }, asset: { board: null, hold: null, direct: null } }
  assert.deepEqual(ARK_LIMITS, all)
  assert.deepEqual(arkLimits(undefined), all)
  assert.equal(REFILL_BELOW, 0.25)
  assert.deepEqual(arkLimits({ btc: { board: 300 } }).btc, { board: 300, hold: 3000, direct: 1500 }, 'a figure left out keeps its default')
  assert.deepEqual(arkLimits({ btc: { board: null, hold: null, direct: null } }).btc, { board: null, hold: null, direct: null }, 'null: no limit')
  assert.deepEqual(arkLimits({ btc: { board: 'x', hold: -1 } }).btc, { board: 1500, hold: 3000, direct: 1500 }, 'a figure that is not one keeps its default')
  assert.deepEqual(arkLimits({ btc: { board: 8000, hold: 6000 } }).btc, { board: 8000, hold: 8000, direct: 1500 }, 'hold is never under board')
})

test('USD in atoms', () => {
  assert.equal(usdAtoms(1000, 100_000, 8), 1_000_000n, '1000 USD of BTC at 100000: 0.01 BTC')
  assert.equal(usdAtoms(5000, 1, 2), 500_000n, '5000 USD of a dollar token with 2 decimals')
  assert.equal(usdAtoms(10000, 0.5, 0), 20_000n)
  assert.equal(usdAtoms(1000, 0, 8), null, 'no price, no figure')
  assert.equal(usdAtoms(1000, undefined, 8), null)
})

test('the wallet refills the ark only below a quarter of its resting level, in one move', () => {
  const btc = (held) => ({ held, limitUsd: ARK_LIMITS.btc.board, price: 100_000, precision: 8 })
  assert.equal(boardRoom(btc(0n)), 1_500_000n, 'an empty ark takes 1500 USD of the address\'s BTC')
  assert.equal(boardRoom(btc(374_000n)), 1_126_000n, 'under 375 USD: back up to 1500 in one move')
  assert.equal(boardRoom(btc(375_000n)), 0n, 'from 375 USD on, nothing is moved in')
  assert.equal(boardRoom(btc(1_000_000n)), 0n)
  assert.equal(boardRoom(btc(2_000_000n)), 0n)
  assert.equal(boardRoom({ held: 0n, limitUsd: ARK_LIMITS.asset.board, price: 1, precision: 2 }), null, 'Sequentia: no limit')
  assert.equal(boardRoom({ held: 0n, limitUsd: 5000, price: null, precision: 2 }), null, 'an unpriced kind has no limit')
})

test('at the ceiling everything above the resting level moves out, in one move', () => {
  const btc = (held) => ({ held, ...ARK_LIMITS.btc, price: 100_000, precision: 8 })
  assert.equal(moveOutAtoms(btc(2_999_999n)), 0n, 'under 3000 USD it all stays')
  assert.equal(moveOutAtoms(btc(3_000_000n)), 1_500_000n, 'at 3000 USD, 1500 moves: the ark is back at 1500')
  assert.equal(moveOutAtoms(btc(4_400_000n)), 2_900_000n, 'all above 1500, in one move')
  assert.equal(moveOutAtoms({ held: 9n ** 20n, ...ARK_LIMITS.asset, price: 1, precision: 2 }), 0n, 'Sequentia: nothing moves out')
  assert.equal(moveOutAtoms({ held: 9n ** 20n, board: 1500, hold: 3000, price: null, precision: 8 }), 0n, 'no price, no move')
})

test('one BTC payment of 1500 USD or more goes to the address straight away; none on Sequentia', () => {
  assert.equal(directUsd(ARK_LIMITS.btc), 1500)
  assert.equal(directUsd(ARK_LIMITS.asset), null)
  const btc = (atoms) => ({ atoms, ...ARK_LIMITS.btc, price: 100_000, precision: 8 })
  assert.equal(goesToAddress(btc(1_499_999n)), false, 'under 1500 USD: the ark')
  assert.equal(goesToAddress(btc(1_500_000n)), true, '1500 USD: the address')
  assert.equal(goesToAddress({ atoms: 9n ** 20n, ...ARK_LIMITS.asset, price: 1, precision: 2 }), false, 'Sequentia: never')
  const w = DEFAULT_WORDS.byAddressLarge('1,500')
  assert.equal(w, 'A payment of 1,500 USD or more goes to the address.')
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
  assert.match(html, /if\(window\.SEQ_ARK_LIMITS === undefined\) window\.SEQ_ARK_LIMITS = \{ btc: \{ board: 1500, hold: 3000, direct: 1500 \}, asset: \{ board: null, hold: null, direct: null \} \};/)
  // BTC is boarded within the limit (a trade that asks for more gets it).
  assert.match(html, /let cap = arkRoom\('BTC'\);\r?\n  if\(cap != null && _btcArkWanted > cap\) cap = _btcArkWanted;\r?\n  if\(cap != null && cap <= 0n\) return;/)
  assert.match(html, /btcArk\.board\(\{ utxos: btcGatherUtxos, buildUnsigned: btcDrainUnsigned, cap,\s+broadcast: async \(hex\)=>\{ const t = await btcBroadcastHex\(hex\);/)
  // Each asset too, by the leaf library.
  assert.match(html, /boardRoom: \(hex\)=> arkRoom\(hex\),/)
  assert.match(leaves, /if \(room != null && room < c0\.min\) continue\r?\n      const c = room != null && room < c0\.onchain \? \{ \.\.\.c0, onchain: room \} : c0/)
  // No price yet: nothing moves in until there is one.
  assert.match(html, /if\(o\.limitUsd != null && !\(o\.price > 0\) && \(kind==='BTC' \|\| !Object\.keys\(PRICES\)\.length\)\) return 0n;/)
})

test('Receive keeps its instant part; the hold limit moves the rest out; a large payment goes to the address', () => {
  // Below `direct` the code keeps its Ark part; at `direct` or more it carries the address alone, so
  // a wallet that is not this one pays the address too.
  assert.match(html, /lightning: inv \? inv\.invoice : undefined, ark: large \? undefined : \(_recvArk \|\| undefined\), sequentia: _recvCode\.text \}\);/)
  assert.ok(!/btcRoom/.test(html), 'Receive never drops the Ark part for a smaller amount')
  // Receive's invoice card holds to the same two rules as the code.
  const card = html.slice(html.indexOf('if (btcArkRoutes()){\n      // The receive code'), html.indexOf('try { await btcArkReceive(amt, st, out); }'))
  assert.match(card, /const large = arkDirectWhy\('BTC', BigInt\(amt\)\);\n      if \(large\)\{ [^\n]*DEFAULT_WORDS\.giveCode; return; \}/)
  assert.match(card, /if \(!lnFits\('BTC', 'in', BigInt\(amt\)\)\)\{ [^\n]*DEFAULT_WORDS\.invoiceNoWay; return; \}/)
  // An amount that goes to the address carries no invoice.
  assert.match(html, /const large = atoms>0n && !!arkDirectWhy\(asset, atoms\);\r?\n(?:  \/\/[^\n]*\n)?  const can = atoms>0n && !large && /)
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

test('the FAQ explains the limits with the figures the wallet uses', () => {
  for (const id of ['faq-limits-why', 'faq-limits-seq', 'faq-limits-ln', 'faq-limits-btc', 'faq-limits-why-not-balance']) {
    assert.match(html, new RegExp(`<details id="${id}">`), id)
  }
  const faq = html.slice(html.indexOf('<details id="faq-limits-why">'), html.indexOf('<section data-panel="settings"'))
  const usd = (n) => n.toLocaleString('en-US')
  const { board, hold, direct } = ARK_LIMITS.btc
  assert.ok(faq.includes(`under ${usd(direct)} USD lands in the ark`), 'D')
  assert.ok(faq.includes(`When the ark reaches ${usd(hold)} USD, the wallet moves everything above ${usd(board)}`), 'H and L')
  assert.ok(faq.includes(`drops under ${usd(board * REFILL_BELOW)} USD`), 'the refill')
  assert.ok(faq.includes('at most 10% of what the operator'), 'the Lightning share')
  assert.ok(faq.includes('the limit is 1,500 USD a payment'), 'the fallback')
})
