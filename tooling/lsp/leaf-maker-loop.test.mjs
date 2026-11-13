// A maker whose coins are shaped makes no refresh while nobody trades (web wallet #783). Its
// working-coin size is worked out from the budget and the node's rates at every pass and moves by a
// few atoms a minute; the cut (shapeFor) and the merge (coinsToMerge) read one rule of what a coin
// is beside that size (coinShape), so a coin cut at last minute's size stays a working coin, a cut
// leaves no crumb and is never made for a few atoms, and a merge takes only crumbs: neither takes
// what the other made.
//
//   node --test tooling/lsp/leaf-maker-loop.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as M from './leaf-maker.mjs'

const { shapeFor, coinsToMerge, mergeMost, WORKING_COUNT } = M
const coin = (id, value, kind = 'batch', asset = 'A', state = 'live') => ({ leaf_id: id, asset, value: String(value), kind, state })
// The sizes the testnet's BTC desk maker logged over an hour, a reading a minute or so.
const SERIES = JSON.parse(readFileSync(new URL('./leaf-maker-sizes-series.json', import.meta.url), 'utf8'))

test('a coin cut at last minute\'s size stays a working coin while the size moves a little', () => {
  // OILX, two readings two minutes apart on the testnet: the size fell by 5,448,991 atoms.
  const before = 8_282_084_513n, now = 8_276_635_522n
  const coins = [...Array.from({ length: WORKING_COUNT }, (_, k) => coin('w' + k, before)), coin('r', 40n * before)]
  assert.equal(shapeFor(coins, 'A', now), null, 'four coins of the size before are four working coins')
  // SEQ, two atoms down.
  const s0 = 4_166_666_666_666n
  const seq = [...Array.from({ length: WORKING_COUNT }, (_, k) => coin('s' + k, s0)), coin('r', 20n * s0)]
  assert.equal(shapeFor(seq, 'A', s0 - 2n), null)
  // The size up by a few atoms: the same.
  assert.equal(shapeFor(seq, 'A', s0 + 2n), null)
  // A real move reshapes: the size down by half, a coin of the old size is a reserve again, cut into
  // one working coin and a rest of at least half one.
  const half = s0 / 2n
  const s = shapeFor(seq, 'A', half)
  assert.ok(s && s.pieces >= 1, JSON.stringify(s))
})

test('a cut leaves no crumb and is not made for a few atoms', () => {
  const u = 1_000_000_000n
  const three = Array.from({ length: 1 }, (_, k) => coin('w' + k, u))
  // Three working coins missing, the smallest reserve 3.2 of them: three pieces would leave a rest
  // of 0.2 (a crumb the merges would take); two leave 1.2, a working coin of its own.
  const s = shapeFor([...three, coin('r', 32n * u / 10n)], 'A', u)
  assert.deepEqual(s, { leaf: 'r', piece: String(u), pieces: 2 })
  // A coin a few atoms over the size is a working coin: nothing is cut for a missing atom.
  assert.equal(shapeFor([coin('a', u), coin('b', u), coin('c', u), coin('d', u + 3n)], 'A', u), null)
  // Not even with every other working coin missing: it holds no working coin and a rest worth
  // holding beside it once the refresh's fee is paid.
  assert.equal(shapeFor([coin('d', u + u / 2n)], 'A', u), null)
  // A coin of one and a half working coins and the fee, cut, leaves half one at least.
  const r = shapeFor([coin('d', 152n * u / 100n)], 'A', u)
  assert.deepEqual(r, { leaf: 'd', piece: String(u), pieces: 1 })
  // The floor is never below the asset's smallest quote (`least`): a rest under it quotes nothing.
  assert.equal(shapeFor([coin('d', 2n * u)], 'A', u, new Map(), Date.now(), String(12n * u / 10n)), null)
  assert.equal(shapeFor([coin('d', 23n * u / 10n)], 'A', u, new Map(), Date.now(), String(12n * u / 10n)).pieces, 1)
})

test('a merge takes crumbs only, never a working coin a cut made', () => {
  const u = 1_000_000_000n
  // Past the cap of 8: four working coins, two of them the halves the library makes of a piece and a
  // rest below its smallest leaf, three larger reserves, and two crumbs. A half and the two crumbs
  // fit under a working coin together; the half is left.
  const coins = [coin('w1', u), coin('w2', u), coin('h1', u / 2n + 7n), coin('h2', u / 2n + 6n),
    coin('r1', 5n * u), coin('r2', 6n * u), coin('r3', 7n * u), coin('c1', u / 10n), coin('c2', u / 5n)]
  const m = coinsToMerge(coins, 'A', 8, [], null, mergeMost({}, 'A', u), u)
  assert.deepEqual([...m].sort(), ['c1', 'c2'])
  // No crumbs: nothing is merged, however far past the cap.
  assert.deepEqual(coinsToMerge(coins.filter((c) => !c.leaf_id.startsWith('c')), 'A', 4, [], null, mergeMost({}, 'A', u), u), [])
  // Without a working size (no budget), as before: the smallest coins under `most`.
  assert.ok(coinsToMerge(coins, 'A', 8).includes('h2'))
})

test('the rule both read: crumb, working coin or reserve', () => {
  const u = 1_000n
  assert.equal(M.coinShape(499n, u), 'crumb')
  assert.equal(M.coinShape(500n, u), 'working')
  assert.equal(M.coinShape(1_500n, u), 'working', 'one working coin and half one, less the fee, is not two')
  assert.equal(M.coinShape(1_516n, u), 'reserve')
  assert.equal(M.cutFloor(u), 500n)
  assert.equal(M.cutFloor(u, '700'), 700n)
})

// The library's refresh in pieces (arca bark/src/arca/round.rs pieces_of): `count` leaves of
// `piece` while the value lasts and one of the rest; a rest below the smallest leaf is split with
// the last piece into two halves. The fee: FEE_PPM of what is given up.
const FEE_PPM = 1_000n, MIN_LEAF = 1_000n
const fee = (v) => (v * FEE_PPM + 999_999n) / 1_000_000n
function piecesOf (value, piece, count) {
  const n = value / piece < BigInt(count) ? value / piece : BigInt(count)
  if (n === 0n) return [value]
  const rest = value - n * piece
  const out = Array.from({ length: Number(n) }, () => piece)
  if (rest >= MIN_LEAF) out.push(rest)
  else if (rest > 0n) { out.pop(); const t = piece + rest; out.push(t - t / 2n, t / 2n) }
  return out
}
// One pass of the maker's upkeep over its coins (as leaf-maker.mjs runs it: the merges past the
// cap, then a cut an asset), the rounds done before the next pass. -> { coins, cuts, merges }.
function pass (coins, sizes, cap, next) {
  let cuts = 0, merges = 0
  const gone = new Set(), made = []
  for (const [a, u] of sizes) {
    const live = coins.filter((c) => c.asset === a && c.state === 'live')
    if (live.length > cap) {
      const m = coinsToMerge(coins, a, cap, [], null, mergeMost({}, a, u), u)
      if (m.length >= 2) {
        merges++
        const v = live.filter((c) => m.includes(c.leaf_id)).reduce((s, c) => s + BigInt(c.value), 0n)
        for (const id of m) gone.add(id)
        made.push(coin(next(), v - fee(v), 'batch', a))
      }
    }
    const s = shapeFor(coins, a, u)
    if (s && !gone.has(s.leaf)) {
      cuts++
      const v = BigInt(coins.find((c) => c.leaf_id === s.leaf).value)
      gone.add(s.leaf)
      for (const p of piecesOf(v - fee(v), BigInt(s.piece), s.pieces)) made.push(coin(next(), p, 'batch', a))
    }
  }
  return { coins: [...coins.filter((c) => !gone.has(c.leaf_id)), ...made], cuts, merges }
}

test('the testnet\'s hour of sizes, nobody trading: no cut and no merge once the coins are shaped', () => {
  let n = 0
  const next = () => 'n' + (n++)
  const assets = Object.keys(SERIES.sizes)
  const at = (k) => new Map(assets.map((a) => [a, BigInt(SERIES.sizes[a][k])]))
  // Each asset starts as one coin of forty working coins, shaped at the first reading's size.
  let coins = assets.map((a) => coin(next(), 40n * BigInt(SERIES.sizes[a][0]), 'batch', a))
  for (let i = 0; i < 20; i++) {
    const r = pass(coins, at(0), 8, next)
    coins = r.coins
    if (!r.cuts && !r.merges) break
  }
  for (const a of assets) {
    const u = BigInt(SERIES.sizes[a][0])
    assert.ok(coins.filter((c) => c.asset === a && BigInt(c.value) <= u && 2n * BigInt(c.value) >= u).length >= WORKING_COUNT, a + ' shaped')
  }
  // Then every reading of the hour, one pass each.
  let cuts = 0, merges = 0
  const by = []
  for (let k = 1; k < SERIES.at.length; k++) {
    const r = pass(coins, at(k), 8, next)
    coins = r.coins; cuts += r.cuts; merges += r.merges
    if (r.cuts || r.merges) by.push(`${SERIES.at[k]}: ${r.cuts} cuts, ${r.merges} merges`)
  }
  console.log(`${SERIES.at.length - 1} passes over the testnet's sizes: ${cuts} cuts, ${merges} merges` + (by.length ? '\n' + by.slice(0, 10).join('\n') : ''))
  assert.equal(cuts, 0)
  assert.equal(merges, 0)
})

test('a cut makes the missing working coins and a feeder from the smallest reserve that holds them, and waits for a coin the operator cannot take on', () => {
  const u = 1_000_000_000n
  // One working coin: three missing, and WORKING_FEEDER more, from the smallest reserve that holds
  // all seven and half one: 8u, not the 3u one (two pieces) nor the 1000u one.
  const coins = [coin('w', u), coin('small', 3n * u), coin('feeder', 8n * u), coin('huge', 1000n * u)]
  assert.deepEqual(shapeFor(coins, 'A', u), { leaf: 'feeder', piece: String(u), pieces: 3 + M.WORKING_FEEDER })
  // None holds them all: the smallest reserve, cut into what it holds.
  assert.deepEqual(shapeFor([coin('w', u), coin('small', 3n * u)], 'A', u), { leaf: 'small', piece: String(u), pieces: 2 })
  // The operator's headroom in the asset (of an asset it caps) takes at most 0.9 x 5u = 4.5u: the
  // 8u coin waits, and says so.
  const w = shapeFor(coins, 'A', u, new Map(), Date.now(), null, new Map([['A', 5n * u]]))
  assert.deepEqual(w, { waits: true, leaf: 'feeder', value: String(8n * u), headroom: String(5n * u) })
  // An asset the operator does not cap is not bounded.
  assert.equal(shapeFor(coins, 'A', u, new Map(), Date.now(), null, new Map([['B', 1n]])).leaf, 'feeder')
  // The feeder's pieces are working coins of a round, each at most a working coin: a swap paying
  // from one puts no more out of round than any working coin, and none is a coin out of round that
  // the library pays from first (arca #892).
  assert.equal(M.coinShape(u, u), 'working')
})
