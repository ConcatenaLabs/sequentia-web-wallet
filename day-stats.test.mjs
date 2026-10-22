// The pair's "24h" line uses only the last 24 hours. With no trade in that window it says so and
// when the last trade was, instead of showing a months-old candle as "24h +0.00%, vol 8 tSEQ".
//   node --test day-stats.test.mjs
import assert from 'node:assert'
import test from 'node:test'

const _ls = new Map()
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) }
const { __test__: T } = await import('./swap.js')
const NOW = 1_800_000_000, H = 3600, D = 86400
const candle = (t, o, c, h, l, v) => ({ t, o, c, h, l, v })

test('old candles give no 24-hour figures, only the last trade and when', () => {
  const d = T.dayStats([candle(NOW - 96 * D, 0.37, 0.375, 0.376, 0.37, '5000'), candle(NOW - 70 * D, 0.38, 0.3834228, 0.3834228, 0.3834228, '800000000')], NOW)
  assert.equal(d.inDay, false); assert.equal(d.last, 0.3834228); assert.equal(d.lastT, NOW - 70 * D)
  assert.equal(d.changePct, null); assert.equal(d.vol, 0n); assert.equal(d.hi, null)
  assert.equal(T.agoText(d.lastT, NOW), '70 days')
})

test('within the day: range, volume and change of that day only', () => {
  const d = T.dayStats([candle(NOW - 3 * D, 1, 1, 9, 0.1, '999'), candle(NOW - 5 * H, 0.40, 0.41, 0.42, 0.39, '10'), candle(NOW - H, 0.41, 0.44, 0.45, 0.41, '5')], NOW)
  assert.equal(d.inDay, true); assert.equal(d.hi, 0.45); assert.equal(d.lo, 0.39); assert.equal(d.vol, 15n)
  assert.equal(d.changePct.toFixed(2), '10.00'); assert.deepEqual(d.pts, [0.41, 0.44])
})

test('ago reads in whole units', () => {
  assert.equal(T.agoText(NOW - 1 * D, NOW), '1 day'); assert.equal(T.agoText(NOW - 5 * H - 59, NOW), '5 hours'); assert.equal(T.agoText(NOW - 30, NOW), '1 minute')
})
