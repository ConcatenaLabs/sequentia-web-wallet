// A payment to a confidential address paid from coins in the clear, with its change in the clear,
// shows its amount and asset on the chain (#585): default mode's review says so, in the contract's
// words, and never claims more than the payment hides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_WORDS } from './default-arca.js'
import { forbiddenIn } from './user-trade.js'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const contract = readFileSync(new URL('./docs/DEFAULT_MODE.md', import.meta.url), 'utf8')

test('the review of a payment to a confidential address says what can still be worked out', () => {
  assert.equal(DEFAULT_WORDS.confidentialSeen, 'This payment’s amount and asset can still be worked out by anyone reading the chain.')
  assert.deepEqual(forbiddenIn(DEFAULT_WORDS.confidentialSeen), [])
  assert.match(html, /const seen = !devMode\(\) && rows\.some\(r=>isConfidentialAddress\(r\.addr\)\) \? \[\['', DEFAULT_WORDS\.confidentialSeen\]\] : \[\];/)
  assert.match(html, /extra:\[\.\.\.byAddressNote\(false\), \.\.\.seen\]/)
  assert.ok(contract.includes('"This payment’s amount and asset\n    can still be worked out by anyone reading the chain."'))
})
