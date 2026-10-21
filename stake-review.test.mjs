// The Stake tab's review says what is signed: a stake, its lock and the key it pays. It
// was titled as a payment and named neither, so a person asked to approve a stake saw
// only an amount and a fee. index.html is a static page with no build step: this reads
// the handler's source, as index-free-identifiers.test.mjs does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const start = html.indexOf("$('btnStake').onclick")
const handler = html.slice(start, html.indexOf('\n});', start))

test('the stake review is titled as a stake, not a payment', () => {
  assert.ok(start > 0, 'the Stake button handler is in index.html')
  assert.match(handler, /reviewBroadcast\(pset, 'Confirm Sequentia stake'/)
  assert.doesNotMatch(handler, /'Confirm Sequentia payment'/)
})

test('the stake review names what it does, the lock and the staker key', () => {
  for (const row of ["'What it does'", "'Lock', STAKE_PERIOD_LABEL", "'Staker key', pubkey"]) assert.ok(handler.includes(row), row)
  assert.match(handler, /\{rows:\[\{atoms, hex:POLICY_HEX, ref\}\], extra, feeAssetHex:POLICY_HEX\}/)
})

test('the lock is stated as it lasts: 43,200 blocks at a block a minute, about 30 days', () => {
  assert.match(html, /const STAKE_CSV = 43200;/)
  assert.match(html, /const STAKE_PERIOD_LABEL = 'about 30 days \(43,200 blocks, the network minimum\)';/)
  assert.match(html, /const BLOCK_SECONDS = 60;/)
  assert.equal(Math.round(43200 * 60 / 86400), 30)
  assert.doesNotMatch(html, /~15 days/)
})
