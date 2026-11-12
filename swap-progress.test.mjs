// A trade with BTC says each step as it goes: a pop-up while its price is made (the BTC desk can
// take up to a minute), and the steps on the trade's card once it is confirmed. The pop-up never
// holds the page. The Swap screen shows a value under each amount, and keeps only the trades that
// are open or ended while it was open (04/11/2026).
//
//   node --test swap-progress.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { tradeSteps, USER_WORDS, BTC_ONLY_FIRM_MS, forbiddenIn } from './user-trade.js'

const X = 'aa'.repeat(32)
const name = (a) => (a === 'BTC' ? 'BTC' : 'USDX')
const keys = (s) => s.map((x) => x.key)
const now = (s) => s.filter((x) => x.state === 'now').map((x) => x.key)
const done = (s) => s.filter((x) => x.state === 'done').map((x) => x.key)

test('the BTC desk is given a minute for its firm price', () => {
  assert.equal(BTC_ONLY_FIRM_MS, 60000)
})

test('selling an asset for BTC: its steps in order', () => {
  const q = (k) => tradeSteps({ quote: k, payAsset: X, receiveAsset: 'BTC', name })
  assert.deepEqual(keys(q('invoice')), ['invoice', 'firm', 'check', 'priced', 'send', 'wait-btc', 'finish', 'done'])
  assert.deepEqual(q('invoice').map((s) => s.text), [
    'Getting ready to receive your BTC', 'Asking for a firm price (this can take up to a minute)', 'Checking the price and the fees',
    'Price ready: check it and confirm', 'Sending your USDX', 'Waiting for your BTC', 'Finishing the trade', 'Done'])
  assert.deepEqual(now(q('firm')), ['firm'])
  assert.deepEqual(done(q('firm')), ['invoice'])
  const r = (o) => tradeSteps({ r: { dir: 'sell', ticket: { payAsset: X, receiveAsset: 'BTC' }, ...o }, name })
  assert.deepEqual(now(r({ state: 'confirming' })), ['send'])
  assert.deepEqual(now(r({ state: 'sent' })), ['wait-btc'])
  assert.deepEqual(now(r({ state: 'sent', btcPaid: true })), ['finish'])
  assert.deepEqual(now(r({ state: 'settled' })), [])
  assert.equal(done(r({ state: 'settled' })).length, 8)
})

test('buying an asset with BTC: its steps in order', () => {
  const q = (k) => tradeSteps({ quote: k, payAsset: 'BTC', receiveAsset: X, name })
  assert.deepEqual(keys(q('firm')), ['firm', 'check', 'priced', 'ready', 'wait-other', 'final', 'send-btc', 'take', 'finish', 'done'])
  assert.deepEqual(q('firm').map((s) => s.text), [
    'Asking for a firm price (this can take up to a minute)', 'Checking the price and the fees', 'Price ready: check it and confirm',
    'Getting ready to receive your USDX', 'Waiting for the other side to send your USDX', 'Waiting for your USDX to be confirmed on the network',
    'Sending your BTC', 'Receiving your USDX', 'Finishing the trade', 'Done'])
  const r = (o) => tradeSteps({ r: { dir: 'buy', ticket: { payAsset: 'BTC', receiveAsset: X }, ...o }, name })
  assert.deepEqual(now(r({ state: 'confirming' })), ['ready'])
  assert.deepEqual(now(r({ state: 'waiting', receiveState: 'waiting' })), ['wait-other'])
  assert.deepEqual(now(r({ state: 'waiting', receiveState: 'held' })), ['final'])
  assert.deepEqual(now(r({ state: 'sent' })), ['send-btc'])
  assert.deepEqual(now(r({ state: 'sent', preimage: 'p', receiveState: 'held' })), ['take'])
  assert.deepEqual(now(r({ state: 'sent', preimage: 'p', receiveState: 'received' })), ['finish'])
  // A trade that came back says so in one step.
  assert.deepEqual(r({ state: 'returned' }).map((s) => s.text), ['Nothing was traded: your BTC is back'])
})

test('the steps say none of the words default mode never says', () => {
  for (const k of Object.keys(USER_WORDS).filter((k) => /^step|^pricingTitle|^close/.test(k))) {
    const v = USER_WORDS[k], t = typeof v === 'function' ? v('USDX') : v
    assert.deepEqual(forbiddenIn(t), [], k + ': ' + t)
  }
})

const src = readFileSync(new URL('./user-composer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const btc = readFileSync(new URL('./user-trade-btc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fn = (s, head) => { const i = s.indexOf(head); assert.ok(i >= 0, head); return s.slice(i, s.indexOf('\n  }\n', i) + 4) }

test('the BTC desk says each step of the price as it starts', () => {
  const f = fn(btc, 'async function firm (')
  const at = (k) => f.indexOf(`step('${k}')`)
  assert.ok(at('invoice') > 0 && at('invoice') < f.indexOf('B().invoice(') && f.indexOf('B().invoice(') < at('firm'))
  assert.ok(at('firm') < f.indexOf("'/v1/btc/firm'") && f.indexOf("'/v1/btc/firm'") < at('check'))
  assert.ok(at('check') < f.indexOf("run('lightning_pay_quote'"))
})

test('the pop-up never holds the page', () => {
  const o = fn(src, 'function openProgress (')
  assert.match(o, /m\.onclick = \(e\) => \{ if \(e\.target === m\) closeProgress\(\) \}/, 'a click outside closes it')
  assert.match(o, /if \(e\.key === 'Escape'\) closeProgress\(\)/, 'Escape closes it')
  assert.match(fn(src, 'function paintProgress ('), /close\.onclick = closeProgress/, 'its Close closes it')
  // It closes by itself however the price ends.
  assert.match(fn(src, 'async function review ('), /\} finally \{ clearTimeout\(longTimer\); S\.busy = !!S\.settling; S\.pricingLong = false; closeProgress\(\); paintTicket\(\) \}/)
  assert.match(fn(src, 'function closeProgress ('), /doc\.removeEventListener\('keydown', S\.progress\.onKey\)/)
})

test('a trade with BTC shows its steps on its card', () => {
  assert.match(fn(src, 'function paintCard ('), /if \(r\.source === 'btc-gateway'\) \{\s*const steps = tradeSteps\(\{ r, name \}\)/)
})

test('the Swap screen keeps only the trades open or ended while it was open', () => {
  const p = fn(src, 'function paintTrades (')
  assert.match(p, /\.filter\(\(r\) => !ENDED\.includes\(r\.state\) \|\| endedAt\(r\) >= S\.openedAt\)/)
})

test('each amount shows its value', () => {
  assert.match(src, /payValue\.id = 'ucPayValue'/)
  assert.match(src, /recvValue\.id = 'ucRecvValue'/)
  assert.match(fn(src, 'function valueOf ('), /return ctx\.refValue\(asset, big\(atoms\)\) \|\| ''/)
})
