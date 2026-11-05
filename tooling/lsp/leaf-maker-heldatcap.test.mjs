// What the maker holds out of round that the operator's cap holds back stops only that asset's
// pairs (web wallet #502). The live case of 2026-11-05: leaf-maker-btc held one 2,876,837 tSEQ coin
// out of round with tSEQ at 43,173,795 in flight against a cap of 43,955,720, its own share a tenth
// of a bond worth 1,752,120.9 reference units, so its budget (175,212) was full and every in-tree
// pair was named for after the next round.
import test from 'node:test'
import assert from 'node:assert/strict'
import { heldAtCap, budgetPpm, shareText, budgetRoom } from './leaf-maker.mjs'

const SEQ = 'c8'.repeat(32), USDX = '2a'.repeat(32), GOLD = '3a'.repeat(32)
const C = 100_000_000n
const info = { assets: [
  { asset: SEQ, in_flight: String(43_173_795n * C), in_flight_cap: String(43_955_720n * C) },
  { asset: USDX, in_flight: String(1_000n * C), in_flight_cap: String(5_000_000n * C) },
  { asset: GOLD },
] }
const bondValue = 175_212_090_000_000n   // 1,752,120.9 reference units
const rates = new Map([[SEQ, 17_500_000n], [USDX, 100_000_000n]])   // tSEQ $0.175, USDX $1

// What the library does with the share it is given: budget = ppm of the bond, room = budget less
// what is held, in each asset at its rate (bark/src/arca/bond.rs, Budget).
function libraryRoom (ppm, held) {
  const value = bondValue * BigInt(ppm) / 1_000_000n
  let h = 0n
  for (const x of held) h += big(x.value) * rates.get(x.asset) / C
  const r = value > h ? value - h : 0n
  return budgetRoom({ instant_budget: { room_atoms: Object.fromEntries([...rates].map(([a, rt]) => [a, String(r * C / rt)])) } })
}
const big = (v) => BigInt(v)

test('a coin whose refresh would pass the cap is held back; one within it is not', () => {
  const held = [{ asset: SEQ, value: String(2_876_837n * C) }, { asset: USDX, value: String(500n * C) }]
  const stuck = heldAtCap(held, info)
  assert.deepEqual([...stuck], [[SEQ, 2_876_837n * C]])
  assert.equal(heldAtCap([{ asset: SEQ, value: String(700_000n * C) }], info).size, 0, '43.87M stays under the 43.96M cap')
  assert.equal(heldAtCap([{ asset: GOLD, value: '5' }], info).size, 0, 'an asset with no cap is never held back')
  assert.equal(heldAtCap(held, { server_info: info }).size, 1, 'the info as the library wraps it')
})

test('before: the held-back tSEQ fills the budget and no other pair has room; after: the other pairs keep theirs', () => {
  const held = [{ asset: SEQ, value: String(2_876_837n * C) }]
  // Before the change the share stayed at a tenth.
  const before = libraryRoom(100_000, held)
  assert.equal(before.get(USDX), 0n, 'nothing in any pair: the failure of #502')
  // After: the share widens by what the held-back coin is worth.
  const ppm = budgetPpm(100_000, heldAtCap(held, info), rates, bondValue)
  assert.equal(ppm, 100_000 + 287_336)
  assert.equal(shareText(ppm), '0.387336')
  const after = libraryRoom(ppm, held)
  // The room the other pairs trade in is what a tenth leaves with nothing held back.
  const fresh = libraryRoom(100_000, [])
  assert.ok(after.get(USDX) >= fresh.get(USDX) && after.get(USDX) - fresh.get(USDX) < 2n * C, `${after.get(USDX)} against ${fresh.get(USDX)}`)
})

test('nothing held back, an unpriced asset, or no bond: the configured share', () => {
  assert.equal(budgetPpm(100_000, new Map(), rates, bondValue), 100_000)
  assert.equal(budgetPpm(100_000, new Map([[GOLD, 5n * C]]), rates, bondValue), 100_000)
  assert.equal(budgetPpm(100_000, new Map([[SEQ, C]]), rates, 0n), 100_000)
  assert.equal(budgetPpm(900_000, new Map([[SEQ, 43_000_000n * C]]), rates, bondValue), 1_000_000, 'never past the whole bond')
})

// Live, 2026-11-05 19:45Z: tSEQ fell under its cap, the widening went at once, and while the coin's
// refresh still waited for the next round its 3.8M tSEQ filled the tenth: 30 pairs deferred.
import { heldBack } from './leaf-maker.mjs'
test('what the cap held back stays held back until it is refreshed, not until the cap frees', () => {
  const coin = [{ asset: SEQ, value: String(3_800_152n * C) }]
  const prev = heldAtCap(coin, info)                         // at the cap: held back
  assert.equal(prev.size, 1)
  const freed = { assets: [{ asset: SEQ, in_flight: String(38_240_000n * C), in_flight_cap: info.assets[0].in_flight_cap }] }
  assert.equal(heldAtCap(coin, freed).size, 0, 'the cap freed: heldAtCap alone lets go (the gap)')
  const still = heldBack(prev, heldAtCap(coin, freed), coin)
  assert.deepEqual([...still], [[SEQ, 3_800_152n * C]], 'still out of round: still held back')
  assert.equal(heldBack(still, new Map(), []).size, 0, 'refreshed: let go')
  assert.equal(heldBack(still, new Map(), [{ asset: SEQ, value: String(100n * C) }]).size, 0, 'mostly refreshed: let go')
  assert.equal(heldBack(new Map(), new Map(), coin).size, 0, 'never held back: nothing')
})
test('coins taken in after the cap freed are not added to what is held back', () => {
  const prev = new Map([[SEQ, 3_800_152n * C]])
  const more = heldBack(prev, new Map(), [{ asset: SEQ, value: String(5_000_000n * C) }])
  assert.deepEqual([...more], [[SEQ, 3_800_152n * C]])
})

// Live, 2026-11-05 20:01Z: the makers restarted after tSEQ fell under its cap; the held-back coin
// was forgotten and leaf-maker-btc refused a firm at its base tenth.
import { heldBackFrom, heldBackText } from './leaf-maker.mjs'
test('what is held back survives a restart through the store', () => {
  const m = new Map([[SEQ, 3_800_095n * C]])
  const again = heldBackFrom(heldBackText(m))
  assert.deepEqual([...again], [...m])
  const coin = [{ asset: SEQ, value: String(3_800_095n * C) }]
  const freed = { assets: [{ asset: SEQ, in_flight: '0', in_flight_cap: info.assets[0].in_flight_cap }] }
  assert.equal(heldBack(again, heldAtCap(coin, freed), coin).size, 1, 'after the restart it is still held back')
  assert.equal(heldBackFrom(null).size, 0)
  assert.equal(heldBackFrom('not json').size, 0)
  assert.equal(heldBackFrom('{"x":"1","' + SEQ + '":"-5"}').size, 0, 'nothing but asset ids and atom counts')
})
