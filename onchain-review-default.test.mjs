// Default mode's review of a payment of an asset from the wallet's own coins on the chain is the
// contract's ("Send <amount> <TICKER>?", To, Fee, when it arrives, Send), never the developer
// review with the network, the fee asset and "Confirm & sign" (Ambra mobile #241, the web wallet
// alike).   node --test onchain-review-default.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = html.slice(html.indexOf('async function reviewBroadcast('), html.indexOf('// ---------- OpenAMP restricted-asset transfer'))

test('the review is the contract\'s in default mode', () => {
  assert.match(fn, /const plain = review && review\.plain && Array\.isArray\(review\.rows\) && !devMode\(\) \? review\.plain : null;/)
  assert.match(fn, /title = DEFAULT_WORDS\.sendTitle\(plain\.amt, plain\.ticker\);/)
  // The network line is developer mode's only.
  assert.match(fn, /else kv\.push\(\['Network', 'Sequentia testnet'\]\);/)
  assert.match(fn, /if\(plain\) ok\.textContent = DEFAULT_WORDS\.send;/)
  assert.match(fn, /st\.textContent = DEFAULT_WORDS\.sentBlock\(plain\.amt, plain\.ticker\);/)
  // Both on-chain asset payments of the Send tab ask for it.
  assert.equal((html.match(/reviewBroadcast\(pset, 'Confirm Sequentia payment', reset, [^\n]*plain[}:]/g) || []).length, 2)
})

test('its words', () => {
  assert.equal(DEFAULT_WORDS.sentBlock('1', 'OILX'), 'Sent 1 OILX. It arrives after the next block, in about a minute.')
  assert.deepEqual(forbiddenIn(DEFAULT_WORDS.sentBlock('1', 'OILX')), [])
})
