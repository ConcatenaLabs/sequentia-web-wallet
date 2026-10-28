// A fresh wallet lists BTC alone wherever it picks an asset to pay or send from; a Sequentia
// asset joins the list once the wallet holds some of it (on the chain, in the tree or on
// Lightning). No asset, tSEQ included, is listed for being the network's own (docs/DEFAULT_MODE.md).
//
//   node --test fresh-wallet-assets.test.mjs
import assert from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { heldAssetList } from './default-arca.js'
import { payAssets } from './user-composer.js'

const TSEQ = 'c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40'
const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1'
const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2) }

// The Send tab's asset list as ownedOptions draws it, for a wallet holding `bal` on the chain,
// `leaves` in the tree and `ln` on Lightning.
function sendList ({ bal = {}, leaves = {}, ln = {} } = {}) {
  const sel = { value: '', innerHTML: '', options: [], appendChild (o) { this.options.push(o) } }
  const el = () => ({})
  const meta = { [TSEQ]: 'tSEQ', [GOLD]: 'GOLD', [USDX]: 'USDX', BTC: 'BTC' }
  const run = new Function('sel', 'balObj', 'el', 'assetMeta', 'leavesApi', 'lnLastStatus', 'lnBalanceFor', 'oampBalances', 'heldAssetList',
    fn('ownedOptions') + '\nownedOptions(sel); return sel.options.map(o => o.textContent);')
  return run(sel, () => bal, el, (h) => ({ ticker: meta[h] || h }),
    { leafAssets: () => Object.keys(leaves), leafAtoms: (h) => BigInt(leaves[h] || 0) },
    { channels: Object.keys(ln).map((a) => ({ asset: a, leg: 'seq' })) }, (a) => BigInt(ln[a] || 0), {}, heldAssetList)
}

test('a fresh wallet sends from BTC alone', () => {
  assert.deepEqual(sendList(), ['BTC'])
  assert.deepEqual(sendList({ bal: { [TSEQ]: '0' } }), ['BTC'], 'an asset at 0 is not listed, tSEQ included')
})

test('an asset joins the list once the wallet holds some, wherever it is held', () => {
  assert.deepEqual(sendList({ bal: { [GOLD]: '500' } }), ['BTC', 'GOLD'])
  assert.deepEqual(sendList({ leaves: { [GOLD]: '500' } }), ['BTC', 'GOLD'], 'held in the tree')
  assert.deepEqual(sendList({ ln: { [USDX]: '7' } }), ['BTC', 'USDX'], 'held on Lightning')
  assert.deepEqual(sendList({ bal: { [TSEQ]: '1', [GOLD]: '2' } }), ['BTC', 'tSEQ', 'GOLD'], 'tSEQ only as one asset held among others')
})

test('heldAssetList: BTC first, then what is held, once each', () => {
  assert.deepEqual(heldAssetList({}), ['BTC'])
  assert.deepEqual(heldAssetList({ [GOLD]: 0n, [USDX]: 5n }, [[USDX, 3n], [GOLD, 1n]]), ['BTC', USDX, GOLD])
  assert.deepEqual(heldAssetList(null, [['BTC', 9n]]), ['BTC'])
})

test('the Trade tab pays from BTC alone in a fresh wallet, and from what is held after', () => {
  const known = ['BTC', TSEQ, GOLD, USDX]
  const name = (a) => a
  assert.deepEqual(payAssets(known, () => 0n, undefined, name), ['BTC'])
  assert.deepEqual(payAssets(known, (a) => (a === GOLD ? 5n : 0n), undefined, name), ['BTC', GOLD])
})

test('no list adds the network\'s own token by itself', () => {
  assert.ok(!/add\(POLICY_HEX\)/.test(fn('ownedOptions')), 'ownedOptions adds tSEQ unconditionally')
})
