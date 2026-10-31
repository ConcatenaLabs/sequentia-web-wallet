// What the list of trades says while a trade waits: the other side, or its settling once what it
// brings is held, with the minutes it has waited; and none of the words default mode never says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tradeStateWord, heldAlready, USER_WORDS, forbiddenIn } from './user-trade.js'

const T0 = 1793230206810, min = 60000

test('a purchase with BTC: waiting for the other side, then sent, then received and settling, then settled', () => {
  const r = { source: 'btc-gateway', dir: 'buy', at: T0, state: 'waiting', waitingSince: T0 + 10000 }
  assert.equal(tradeStateWord(r, T0 + 30000), USER_WORDS.waitingOther)
  assert.equal(tradeStateWord(r, T0 + 10000 + 25 * min), 'Waiting for the other side. Nothing has left your wallet yet. (25 min)')
  Object.assign(r, { state: 'sent', sentAt: T0 + 26 * min, paying: true })
  assert.equal(tradeStateWord(r, T0 + 26 * min + 5000), 'Sent', 'the BTC is being paid')
  Object.assign(r, { preimage: 'ab', receiveState: 'received' })
  assert.ok(heldAlready(r))
  assert.equal(tradeStateWord(r, T0 + 26 * min + 30000), USER_WORDS.received)
  assert.equal(tradeStateWord(r, T0 + 76 * min), 'Received, settling (50 min)')
  r.state = 'settled'
  assert.equal(tradeStateWord(r, T0 + 90 * min), 'Settled')
})

test('a swap and a take are held once done or released; a sale once its BTC came', () => {
  assert.ok(heldAlready({ source: 'leaf-maker', swapState: 'done' }))
  assert.ok(!heldAlready({ source: 'leaf-maker', swapState: 'accepted' }))
  assert.ok(heldAlready({ source: 'covenant-round', takeState: 'released' }))
  assert.ok(!heldAlready({ source: 'covenant-round', takeState: 'issued' }))
  assert.ok(heldAlready({ source: 'btc-gateway', dir: 'sell', btcPaid: true }))
  assert.equal(tradeStateWord({ source: 'covenant-round', state: 'sent', sentAt: T0, takeState: 'issued' }, T0 + 3 * min), 'Sent (3 min)')
  assert.equal(tradeStateWord({ state: 'returned' }), USER_WORDS.returned)
})

test('the waiting words say none of the words default mode never says', () => {
  for (const w of [USER_WORDS.waitingOther, USER_WORDS.received, USER_WORDS.minutes('Sent', 4)]) assert.deepEqual(forbiddenIn(w), [], w)
})
