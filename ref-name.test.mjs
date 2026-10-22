// "Show values in" names the Sequence token by the ticker the wallet shows everywhere else (tSEQ
// on the testnet), not by the price feed's key (SEQ), and lists BTC right after USD.
//   node --test ref-name.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('}', html.indexOf('{', i)) + 1) }
const POLICY = 'cc'.repeat(32)

test('the feed key SEQ reads as the chain\'s ticker; the rest as they are', () => {
  const make = (policy) => new Function('POLICY_HEX', 'assetMeta', 'return ' + fn('refName'))(policy, (h) => ({ ticker: h === POLICY ? 'tSEQ' : 'X' }))
  const refName = make(POLICY)
  assert.equal(refName('SEQ'), 'tSEQ'); assert.equal(refName('USD'), 'USD'); assert.equal(refName('BTC'), 'BTC')
  assert.equal(make('')('SEQ'), 'SEQ', 'before the chain is known, the key itself')
  const fmtRef = new Function('refName', 'return ' + html.slice(html.indexOf('function fmtRef('), html.indexOf('\n', html.indexOf('function fmtRef('))))(refName)
  assert.match(fmtRef(12.5, 'SEQ'), /12\.5 tSEQ$/)
})

test('BTC follows USD; options, hints and the value column use the name', () => {
  const refOptions = new Function('PRICES', '_BTC_KEYS', '_btcUsd', 'return ' + fn('refOptions'))({ EURX: 1, TBTC: 60000, SEQ: 0.4 }, ['BTC', 'TBTC', 'WBTC'], () => 60000)
  assert.deepEqual(refOptions(), ['USD', 'BTC', 'EURX', 'SEQ'])
  assert.match(html, /op\.value=o; op\.textContent=refName\(o\);/)
  assert.match(html, /d\.appendChild\(el\('span','bt-ref',' '\+refName\(rv\.ref\)\)\);/)
  assert.ok(!/'enter in '\+REF\)/.test(html))
})
