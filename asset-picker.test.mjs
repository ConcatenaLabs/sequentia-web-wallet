// The shared asset chooser's rules (docs/DEFAULT_MODE.md, "Choosing an asset"): what shows before
// a search and after one, the order, the cap, a pasted id, and its words.
import test from 'node:test'
import assert from 'node:assert'
import { pickerMatches, pickerGroups, PICKER_WORDS } from './asset-picker.js'
import { forbiddenIn } from './user-trade.js'

const row = (hex, o = {}) => ({ hex, ticker: o.ticker || hex.toUpperCase(), name: o.name || hex + ' coin', held: false, hidden: false, offered: false, ...o })
const items = [
  row('gold', { held: true }), row('usdx', { offered: true }), row('oilx'), row('silvr', { held: true, hidden: true }),
  row('BTC', { ticker: 'BTC', name: 'Bitcoin' }), row('eurx', { offered: true, hidden: true }), row('any', { ticker: 'Any', pin: true }),
]
const hexes = (l) => l.map((r) => r.hex)

test('no search: pinned, BTC, held, offered and tradable, hidden left out', () => {
  assert.deepEqual(hexes(pickerMatches(items, '')).sort(), ['BTC', 'any', 'gold', 'usdx'].sort())
  const t = [...items, row('tsq', { tradable: true }), row('xau', { tradable: true, hidden: true })]
  assert.deepEqual(hexes(pickerMatches(t, '')).sort(), ['BTC', 'any', 'gold', 'tsq', 'usdx'].sort())
  assert.deepEqual(hexes(pickerGroups(pickerMatches(t, ''), '').groups[1][1]), ['usdx', 'tsq'], 'offered before tradable')
})

test('a search finds every asset, hidden ones included, by ticker, name or id', () => {
  assert.deepEqual(hexes(pickerMatches(items, 'silv')), ['silvr'])
  assert.deepEqual(hexes(pickerMatches(items, 'eurx coin')), ['eurx'])
  assert.deepEqual(hexes(pickerMatches(items, 'oil')), ['oilx'])
  assert.deepEqual(pickerMatches(items, 'zzz'), [])
})

test('a pasted id that matches nothing is an asset when the surface takes one', () => {
  const id = 'AB'.repeat(32)
  assert.deepEqual(pickerMatches(items, id), [], 'no paste hook: nothing')
  const m = pickerMatches(items, id, { paste: (hex) => ({ ticker: hex.slice(0, 8) + '…', name: 'Asset' }) })
  assert.equal(m.length, 1); assert.equal(m[0].hex, id.toLowerCase()); assert.equal(m[0].pasted, true)
})

test('the order: pinned, then your assets with BTC first, then the rest with what is offered first', () => {
  const { pinned, groups } = pickerGroups(pickerMatches(items, ''), '')
  assert.deepEqual(hexes(pinned), ['any'])
  assert.deepEqual(groups.map(([l, r]) => [l, hexes(r)]), [[PICKER_WORDS.yours, ['BTC', 'gold']], [PICKER_WORDS.assets, ['usdx']]])
  const all = pickerGroups(pickerMatches(items, 'x'), 'x')
  // Nothing held matches "x": one group, what the book offers first.
  assert.deepEqual(all.groups.map(([l, r]) => [l, hexes(r)]), [[PICKER_WORDS.assets, ['usdx', 'eurx', 'oilx']]])
  // With something held among the matches, the rest is "All assets".
  const mixed = pickerGroups(pickerMatches(items, 'o'), 'o')
  assert.deepEqual(mixed.groups.map(([l]) => l), [PICKER_WORDS.yours, PICKER_WORDS.all])
})

test('a long search result is capped and says how many more', () => {
  const many = Array.from({ length: 50 }, (_, i) => row('a' + i, { ticker: 'A' + i }))
  const g = pickerGroups(pickerMatches(many, 'a'), 'a', 40)
  assert.equal(g.groups[0][1].length, 40); assert.equal(g.more, 10); assert.equal(PICKER_WORDS.more(10), '+10 more · keep typing to find them.')
})

test('its words say nothing default mode never says', () => {
  for (const [k, v] of Object.entries(PICKER_WORDS)) {
    const text = typeof v === 'function' ? v(3) : v
    assert.deepEqual(forbiddenIn(text), [], k + ': ' + text)
  }
})
