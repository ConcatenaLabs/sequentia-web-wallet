// A run of small trades never empties the maker's book. Twelve trades of 10 USDX each way within
// ten minutes, against a maker with the testnet's instant budget and the six assets its BTC maker
// gives; every quote read in between offers every asset.
//
// Each trade is paid as the library pays it (bark/src/arca/pay.rs fit_order: the smallest coin
// that pays it and its margins alone, a coin already out of round first): the coin is spent, its change is out of
// round, and what the taker pays comes in out of round. The upkeep runs between trades as the
// maker's does: past half its budget out of round every received coin is due, keepFree chooses,
// and what it gives is in a round for three minutes (a round that stuck, as arca #868), then comes
// back cut into working coins.
//
//   node --test tooling/lsp/leaf-maker-small-trades.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { workingSizes, budgetedSpendable, roomNow, receivedDue, keepFree, settleGroups, pastHalfBudget, leastGives } from './leaf-maker.mjs'

// The live box on 2026-11-12: an instant budget of $175,035.58 (1 reference atom = $1e-8), and
// its node's rates (reference atoms per 1e8 atoms), read from the maker's working-coin sizes.
const BUDGET = 17_503_558_000_000n
const RATES = new Map([['USDX', 100_040_000n], ['GOLD', 388_000_000_000n], ['SEQ', 17_500_000n], ['EURX', 110_700_000n], ['OILX', 8_690_000_000n], ['SILVR', 5_023_000_000n]])
const ASSETS = [...RATES.keys()]
const TEN_USDX = 1_000_000_000n
const MARGIN = 2000n
const atomsWorth = (asset, ref) => (ref * 100_000_000n) / RATES.get(asset)
const pairs = ASSETS.flatMap((a) => ASSETS.filter((b) => b !== a).map((b) => ({ give: a, want: b, rate_num: '1', rate_den: '1', min_give: String(atomsWorth(a, 100_000_000n)) })))
const least = leastGives({ pairs })

function maker () {
  const bond = { instant_budget: { value: String(BUDGET), held_value: '0' } }
  const sizes = workingSizes(bond, RATES, ASSETS.length)
  let n = 0
  const id = (p) => p + '-' + (n++)
  const coins = []
  for (const a of ASSETS) {
    // Four working coins of each and a reserve worth ten quarter-budgets, all of a round.
    for (let i = 0; i < 4; i++) coins.push({ leaf_id: id(a + '-w'), asset: a, value: String(sizes.get(a)), kind: 'batch', state: 'live' })
    coins.push({ leaf_id: id(a + '-r'), asset: a, value: String(atomsWorth(a, BUDGET / 4n * 10n)), kind: 'batch', state: 'live' })
  }
  return { coins, sizes, id, rounds: [], seen: new Map() }
}
const held = (m) => BUDGET - roomNow(BUDGET, m.coins, RATES)
// What the maker quotes of each asset now: what a firm offer of it can pay.
function offered (m) {
  const sp = new Map()
  for (const c of m.coins) if (c.state === 'live') sp.set(c.asset, (sp.get(c.asset) || 0n) + BigInt(c.value))
  return budgetedSpendable(sp, m.coins, roomNow(BUDGET, m.coins, RATES), RATES)
}
// The maker gives `give` of `asset` and receives `inWorth` reference atoms of `want` (none for BTC).
function trade (m, asset, give, want) {
  // The coin pays the trade and its margins (the maker's fee_margin of 2000 atoms covers them).
  const can = (c) => c.asset === asset && c.state === 'live' && BigInt(c.value) >= give + MARGIN
  const out = m.coins.filter((c) => can(c) && (c.kind === 'transfer' || c.kind === 'fill')).sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1))
  const fresh = m.coins.filter((c) => can(c) && !(c.kind === 'transfer' || c.kind === 'fill')).sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1))
  const c = out[0] || fresh[0]
  assert.ok(c, `a coin of ${asset} pays ${give}`)
  m.coins.splice(m.coins.indexOf(c), 1)
  const change = BigInt(c.value) - give
  if (change > 0n) m.coins.push({ leaf_id: m.id(asset + '-chg'), asset, value: String(change), kind: 'transfer', state: 'live' })
  if (want !== 'BTC') m.coins.push({ leaf_id: m.id(want + '-in'), asset: want, value: String(atomsWorth(want, atomsWorth('USDX', 0n) + (TEN_USDX * RATES.get('USDX')) / 100_000_000n)), kind: 'transfer', state: 'live' })
}
// The upkeep's pass at `t` (ms): rounds whose three minutes are up come back cut into working
// coins; then the received coins due go to a round, as keepFree chooses.
function upkeep (m, t) {
  for (const r of m.rounds.filter((x) => t >= x.until)) {
    m.rounds.splice(m.rounds.indexOf(r), 1)
    for (const id of r.leaves) { const c = m.coins.find((x) => x.leaf_id === id); m.coins.splice(m.coins.indexOf(c), 1) }
    let left = r.value
    const piece = m.sizes.get(r.asset)
    while (left > 0n) { const v = left > piece ? piece : left; m.coins.push({ leaf_id: m.id(r.asset + '-back'), asset: r.asset, value: String(v), kind: 'batch', state: 'live' }); left -= v }
  }
  const half = pastHalfBudget({ instant_budget: { value: String(BUDGET), held_value: String(held(m)) } })
  const due = receivedDue(m.coins, m.seen, t, 600_000, { all: half })
  const plan = keepFree(m.coins, due, { roomValue: roomNow(BUDGET, m.coins, RATES), rates: RATES, sizes: m.sizes, least })
  for (const g of settleGroups(m.coins, plan.give, m.sizes)) {
    let value = 0n
    for (const id of g.leaves) { const c = m.coins.find((x) => x.leaf_id === id); c.state = 'given'; value += BigInt(c.value); m.seen.delete(id) }
    m.rounds.push({ asset: g.asset, leaves: g.leaves, value, until: t + 180_000 })
  }
  return { half, plan }
}

test('twelve trades of 10 USDX each way within ten minutes: every quote read in between offers every asset', () => {
  const m = maker()
  const others = ['GOLD', 'SEQ', 'BTC', 'EURX', 'OILX', 'SILVR']
  const lines = []
  let t = 0, halves = 0
  const read = (what) => {
    const o = offered(m)
    const none = ASSETS.filter((a) => (o.get(a) || 0n) < BigInt(least[a]))
    lines.push(`${(t / 1000).toFixed(0)} s ${what}: held out of round ${(Number(held(m)) / 1e8).toFixed(0)} of ${(Number(BUDGET) / 1e8).toFixed(0)}` + (none.length ? `; offers none of ${none.join(', ')}` : ''))
    return none
  }
  const gaps = []
  for (let i = 0; i < 12; i++) {
    const x = others[i % others.length]
    // The maker sells 10 USDX for x, then buys 10 USDX with x (gives x worth 10 USDX).
    for (const [give, want] of [['USDX', x], [x, 'USDX']]) {
      if (give === 'BTC') continue
      const amount = give === 'USDX' ? TEN_USDX : atomsWorth(give, (TEN_USDX * RATES.get('USDX')) / 100_000_000n)
      const before = read(`before ${give} for ${want}`)
      if (before.length) gaps.push(lines[lines.length - 1])
      assert.ok((offered(m).get(give) || 0n) >= amount, `trade ${i + 1}: the maker offers the ${amount} of ${give} asked\n` + lines.join('\n'))
      trade(m, give, amount, want === 'BTC' ? 'BTC' : want)
      t += 12_500   // 24 trades in five minutes, each pass of the upkeep in between
      const u = upkeep(m, t)
      if (u.half) halves++
      const after = read(`after ${give} for ${want}`)
      if (after.length) gaps.push(lines[lines.length - 1])
    }
  }
  // Then five minutes more of passes, through the rounds.
  for (let k = 0; k < 15; k++) { t += 20_000; upkeep(m, t); const none = read('pass'); if (none.length) gaps.push(lines[lines.length - 1]) }
  assert.deepEqual(gaps, [], 'every reading offers every asset:\n' + lines.join('\n'))
  assert.ok(held(m) * 2n <= BUDGET || halves > 0)
})
