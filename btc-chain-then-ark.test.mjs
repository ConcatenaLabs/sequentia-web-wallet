// BTC to an address is paid from the wallet's own Bitcoin address first, and from what it holds
// for instant payments (the Bitcoin ark) only for what that does not cover: paying an address out
// of the ark has a fee of its own. When neither covers a payment alone, the two pay it together
// (02/11/2026).
//
//   node --test btc-chain-then-ark.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { splitPay, BTC_WORDS } from './btc-ark.js'
import { forbiddenIn } from './user-trade.js'

test('a payment is split between where it is paid from first and second', () => {
  assert.deepEqual(splitPay(1000n, 5000n, 0n, 294n), [1000n, 0n], 'the first covers it')
  assert.deepEqual(splitPay(8000n, 5000n, 9000n, 294n), [5000n, 3000n], 'all of the first, the rest from the second')
  assert.deepEqual(splitPay(5100n, 5000n, 9000n, 294n), [4806n, 294n], 'the second part is never dust')
  assert.deepEqual(splitPay(8000n, 0n, 9000n, 294n), [0n, 8000n], 'nothing first: all from the second')
  assert.deepEqual(splitPay(500n, 200n, 9000n, 294n), [0n, 500n], 'a first part under dust is left out')
  assert.equal(splitPay(15000n, 5000n, 9000n, 294n), null, 'the two together fall short')
  assert.equal(splitPay(0n, 5000n, 9000n), null)
})

test('the words of a payment in two parts say none of the words default mode never says', () => {
  const extra = ['ark', 'vtxo', 'board', 'offboard', 'sat', 'sats', 'round', 'node', 'room']
  for (const k of ['fromAddress', 'fromInstant', 'inTwo', 'sentPart']) {
    const v = BTC_WORDS[k], text = typeof v === 'function' ? v('0.0001', 'why') : v
    assert.deepEqual(forbiddenIn(text), [], k)
    for (const w of extra) assert.ok(!new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(text), k + ' says ' + w)
  }
})

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.indexOf('async function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2) }

test('an address is paid from the Bitcoin address first, in both modes', () => {
  const r = fn('btcArkSendReview')
  assert.match(r, /if\(route === 'chain' && sats <= chainCap\) return false;/)
  assert.ok(!/devMode\(\)/.test(r), 'the order is the same in developer mode')
  assert.match(r, /const parts = splitPay\(sats, chainCap, arkCap, BTC_DUST\);/)
  // A receive code is paid in seconds from the ark first; its address only for what that lacks.
  assert.match(r, /const parts = chainAddr \? splitPay\(sats, arkCap, chainCap, BTC_DUST\) : null;/)
  assert.match(html, /if\(await btcArkSendReview\(btcRows\[0\], reset, sendFee \? sendFee\.perKvb\/1000 : 0\)\) return;/)
})

test('a payment in two parts is reviewed whole, and the ark pays only once the other part is signed', () => {
  const s = fn('btcSplitReview')
  assert.match(s, /\[BTC_WORDS\.fromAddress, /)
  assert.match(s, /\[BTC_WORDS\.fromInstant, /)
  const built = s.indexOf('await btcBuildTx('), click = s.indexOf('ok.onclick'), ark = s.indexOf('await btcArk.send(arkTo, ark)'), bc = s.indexOf('await btcBroadcastHex(built.hex)')
  assert.ok(built > 0 && built < click && click < ark && ark < bc, 'signed before Send, the ark pays, then the broadcast')
  assert.match(s, /_btcSentAt = Date\.now\(\);\r?\n  const built/, 'no board takes the coins meanwhile')
  // Max is what the two can send together.
  assert.match(html, /max = route==='ark' && !\/\^bitcoin:\/i\.test\(typed\) \? a : \(max>0n \? max : 0n\) \+ a;/)
})
