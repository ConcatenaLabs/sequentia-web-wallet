// Default (user) mode carries no developer vocabulary (the default-mode rule): the wording a
// newcomer reads on Balance, Send, Receive, Swap, History, Mix and Settings is plain, and the
// developer details sit behind .dev-only, which shows only while body.devmode is set. The live
// check is a headless drive of every default-mode tab against the word list; this pins the source.
//   node --test default-mode-words.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8')
const fee = readFileSync(new URL('./fee-panel.js', import.meta.url), 'utf8')

test('developer details are .dev-only, and .dev-only shows only in developer mode', () => {
  assert.match(html, /body:not\(\.devmode\) \.dev-only\{display:none !important\}/)
  assert.match(html, /function applyModeClass\(\)\{\s*document\.body\.classList\.toggle\('devmode', devMode\(\)\);/)
  assert.match(html, /onModeChange: \(m\)=>\{ const on = m==='developer'; applyModeClass\(\);/)
  assert.match(html, /<button class="ghost dev-only" id="btnXpub">/)
  assert.match(html, /<div class="rec hide dev-only" id="xpubReveal">/)
  assert.match(html, /<div class="card dev-only">\s*<label class="lbl">Backend<\/label>/)
  assert.match(html, /<div class="kv dev-only"><span class="k">Your staker key<\/span>/)
  assert.match(swap, /seg\.classList\.toggle\('dev-only', !isConfBook\(\)\);/)
})

test('the words a newcomer reads', () => {
  for (const gone of ['powered by SWK', 'SWK on GitHub', 'paid into your hosted node', 'Your hosted node pays the invoice',
    'not parent-chain BTC', 'Parent-chain BTC on the shared', 'enclave ledger. Give', 'Show confidential', 'Refresh rounds',
    'blinded commitment', 'bridged to SBTC', 'delegator(s)', 'of its share']) assert.ok(!html.includes(gone), gone)
  for (const gone of ["'Settlement'", 'consensus rejects any underpay', 'Consensus rejects any underpay', 'a maker who completes the swap and blinds',
    'how settlement works']) assert.ok(!swap.includes(gone), gone)
  assert.ok(!/<span class="swsec-lab">How it settles<\/span>/.test(html))
  assert.match(html, /el\.textContent = dev \? '⚡ LN '\+activeChannels\+' ch' : '⚡ Lightning';/)
  assert.match(html, /'Paid ✓' \+ \(r\.preimage && devMode\(\) \?/)
  assert.match(swap, /const names = \['Assets', 'Amount', 'Payment', 'Place'\];/)
  assert.match(fee, /'confirms in about ' \+/)
  assert.ok(!/' target'\)/.test(fee), 'no "10 minutes target"')
})

test('the Move to Lightning dialog speaks plainly in default mode', () => {
  const i = html.indexOf('function moveToLightningDialog('); const body = html.slice(i, html.indexOf('\n}', i))
  assert.match(body, /const lines = devMode\(\)/)
  const plain = body.slice(body.indexOf(': [\'Your wallet moves'), body.indexOf('for(const t of lines)'))
  for (const w of ['channel', 'hosted node', 'way back', 'on-chain']) assert.ok(!plain.includes(w), w)
})
