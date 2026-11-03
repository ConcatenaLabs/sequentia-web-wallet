// History is one list: every source's rows newest first, each with what hangs under it, a filter for
// one asset that keeps every row involving it, and one line when there is nothing, never while a
// history is still being read. Values under a cent read "<0.01".
//
//   node --test history-order.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

// A minimal DOM: the sources' lists, their rows (a row with a time and assets, or something under the
// row before it), the filter and the three lines.
function node (tag, attrs = {}) {
  const cls = new Set(attrs.cls || [])
  return { tag, dataset: { ...(attrs.data || {}) }, style: {}, text: attrs.text || '', children: [], options: [],
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c) }, contains: (c) => cls.has(c), add: (c) => cls.add(c) },
    get hidden () { return cls.has('hide') }, get off () { return cls.has('hist-off') } }
}
function dom (lists) {
  const srcs = lists.map((rows) => { const l = node('div'); l.children = rows; return l })
  const all = { querySelectorAll: () => srcs }
  const sel = node('select'); sel.value = ''
  Object.defineProperty(sel, 'innerHTML', { set () { sel.options = [] } })
  sel.appendChild = (o) => sel.options.push(o)
  const byId = { histAll: all, histAsset: sel, histEmptyCard: node('div', { cls: ['hide'] }), histNoneFor: node('div', { cls: ['hide'] }), histLoading: node('div', { cls: ['hide'] }) }
  return { $: (id) => byId[id], sel, byId }
}
const row = (ts, assets, text) => node('div', { data: { ts: String(ts), assets: assets.join(',') }, text })
const under = (text) => node('div', { text })
const meta = (h) => ({ ticker: { BTC: 'BTC', o: 'OILX', u: 'USDX' }[h] || h, precision: 8 })
function run (lists, { chosen = '', counts = { seq: 1, btc: 1 } } = {}) {
  const d = dom(lists)
  const el = (tag, cls, text) => ({ tag, text, value: '' })
  const store = { getItem: () => chosen, setItem: () => {} }
  const order = new Function('$', 'el', 'assetMeta', 'walletTag', 'localStorage', '_histCounts', 'orderHistorySoon',
    'let _histAsset = null;\n' + fn('histAssetChosen') + fn('orderHistory') + 'orderHistory(); return d => d;')
  order(d.$, el, meta, () => 't', store, counts, () => {})
  const seen = lists.flat().filter((n) => !n.off).sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((n) => n.text)
  return { seen, d }
}

test('every source\'s rows in one list, newest first, each with what hangs under it', () => {
  const btc = [row(3000, ['BTC'], 'btc in'), under('btc in details')]
  const seq = [row(5000, ['o', 'BTC'], 'swap'), row(1000, ['u'], 'usdx out'), under('usdx details')]
  const ln = [row(Number.MAX_SAFE_INTEGER, ['u'], 'waiting')]
  const { seen } = run([btc, seq, ln])
  assert.deepEqual(seen, ['waiting', 'swap', 'btc in', 'btc in details', 'usdx out', 'usdx details'])
})

test('one asset keeps every row that involves it, a swap under both of its assets', () => {
  const lists = () => [[row(3000, ['BTC'], 'btc in')], [row(5000, ['o', 'BTC'], 'swap'), row(1000, ['u'], 'usdx out'), under('usdx details')]]
  assert.deepEqual(run(lists(), { chosen: 'BTC' }).seen, ['swap', 'btc in'])
  assert.deepEqual(run(lists(), { chosen: 'o' }).seen, ['swap'])
  assert.deepEqual(run(lists(), { chosen: 'u' }).seen, ['usdx out', 'usdx details'])
  const { d } = run(lists(), { chosen: 'BTC' })
  assert.deepEqual(d.sel.options.map((o) => o.text), ['All assets', 'BTC', 'OILX', 'USDX'], 'BTC first, then by ticker')
})

test('one line when there is nothing, never while a history is being read', () => {
  assert.equal(run([[], []], { counts: { seq: 0, btc: 0 } }).d.byId.histEmptyCard.hidden, false)
  const reading = run([[], []], { counts: { seq: null, btc: 0 } }).d.byId
  assert.equal(reading.histEmptyCard.hidden, true, 'an unread history is not called empty')
  assert.equal(reading.histLoading.hidden, false)
  const none = run([[row(1, ['u'], 'usdx')]], { chosen: 'o' }).d.byId.histNoneFor
  assert.equal(none.hidden, false, 'an asset with no rows says so')
})

test('a value under a cent reads "<0.01"', () => {
  const histValue = new Function('refValue', 'refName', fn('histValue') + 'return histValue;')
  const v = (val, ref = 'USD') => histValue(() => (val == null ? null : { v: val, ref }), (r) => r)('x', 1n)
  assert.equal(v(0.004), '<0.01 USD')
  assert.equal(v(0.000000004, 'BTC'), '<0.00000001 BTC')
  assert.equal(v(null), '', 'an unpriced asset shows no value')
  assert.match(v(19.234), /^19[.,]23 USD$/)
})
