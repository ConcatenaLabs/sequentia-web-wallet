// Figures a person reads carry the locale's thousands grouping and the asset's own decimals, exact
// to the atom ("498,966.43573244 USDX", not "498966.43573244"); amount fields keep the plain form
// that parseAtoms reads back.
//   node --test fmt-amount.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8')
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2) }
const fmtAtoms = new Function('return ' + html.slice(html.indexOf('function fmtAtoms('), html.indexOf('return (neg?\'-\':\'\')+s; }', html.indexOf('function fmtAtoms(')) + 24))()
const fmtAmount = new Function('fmtAtoms', 'return ' + fn('fmtAmount'))(fmtAtoms)
const group = (n) => BigInt(n).toLocaleString()
const dec = new Intl.NumberFormat().formatToParts(1.5).find((x) => x.type === 'decimal').value

test('grouped, exact, the asset\'s own decimals', () => {
  assert.equal(fmtAmount(49896643573244n, 8), group(498966) + dec + '43573244')
  assert.equal(fmtAmount(50000000000000n, 8), group(500000), 'trailing zeros dropped')
  assert.equal(fmtAmount(499979999991783n, 10), group(49997) + dec + '9999991783')
  assert.equal(fmtAmount(1234567n, 0), group(1234567), 'an indivisible asset')
  assert.equal(fmtAmount(5n, 8), '0' + dec + '00000005')
  assert.equal(fmtAmount(-123456700000000n, 8), '-' + group(1234567))
  assert.equal(fmtAmount(2n ** 70n, 8), group(2n ** 70n / 10n ** 8n) + dec + (2n ** 70n % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, ''), 'no float rounding')
})

test('the balance table, pickers, swap balance and Lightning cards show it; fields keep fmtAtoms', () => {
  assert.match(html, /const amt=\(x\)=> known \? fmtAmount\(x, precision\)/)
  assert.match(html, /const amt=\(x\)=> known \? fmtAmount\(x, meta\.precision\)/)
  assert.match(html, /'You can receive up to '\+fmtAmount\(room, meta\.precision\)/)
  assert.match(html, /balObj, fmtAtoms, fmtAmount, parseAtoms,/)
  assert.match(swap, /return \{ b: showAmt\(a, m\.precision\), r:/)
  assert.match(swap, /'Balance ' \+ showAmt\(onchain, m\.precision\)/)
  assert.ok(!/fmtAmount/.test(fn('parseAtoms')))
})
