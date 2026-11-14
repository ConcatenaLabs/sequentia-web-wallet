// What the list of trades says while a trade waits: the other side, or its settling once what it
// brings is held, with the minutes it has waited; and none of the words default mode never says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tradeStateWord, heldAlready, USER_WORDS, forbiddenIn } from './user-trade.js'
import { btcTrades, MAKER_LOCK_MS } from './user-trade-btc.js'
import { settleMinutesOf, SETTLE_LATE_MS } from './default-arca.js'

const T0 = 1793230206810, min = 60000

test('a purchase with BTC: keep the page open, then paying, then received and settling, then settled', () => {
  const r = { source: 'btc-gateway', dir: 'buy', at: T0, state: 'waiting', waitingSince: T0 + 10000, waitFirstBy: T0 + 10000 + 6 * min }
  assert.equal(tradeStateWord(r, T0 + 30000), USER_WORDS.waitingOther(6))
  assert.equal(tradeStateWord(r, T0 + 10000 + 25 * min), USER_WORDS.waitingOtherLate)
  Object.assign(r, { state: 'sent', sentAt: T0 + 26 * min, paying: true })
  assert.equal(tradeStateWord(r, T0 + 26 * min + 5000), USER_WORDS.btcPaying, 'the BTC is being paid')
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
  for (const w of [USER_WORDS.waitingOther(1), USER_WORDS.waitingOther(6), USER_WORDS.waitingOtherLate, USER_WORDS.received, USER_WORDS.minutes('Sent', 4)]) assert.deepEqual(forbiddenIn(w), [], w)
})

test('the purchase\'s wait in words: minutes, one minute, and late; no fixed figure', () => {
  assert.equal(USER_WORDS.waitingOther(6), 'Keep this page open: your BTC is paid once what you buy is held for you, within about 6 minutes. Nothing has left your wallet yet. If the page closes first, nothing is traded.')
  assert.match(USER_WORDS.waitingOther(1), /within about 1 minute\. /)
  assert.equal(USER_WORDS.waitingOtherLate, 'Keep this page open: this is taking longer than usual. Your BTC is paid once what you buy is held for you, and nothing has left your wallet yet. If the page closes first, nothing is traded.')
  for (const w of [USER_WORDS.waitingOther(3), USER_WORDS.waitingOtherLate]) assert.ok(!/2 minutes/.test(w), w)
})

// The library's `info` at the testnet's settings (rounds and blocks a minute apart, batches with no
// sweep, anchor depth 0) and at none.
const TESTNET_INFO = { anchor_depth: 0, server_info: { fills: { round_interval_seconds: 60, block_seconds: 60 }, batches: { no_sweep: true } } }

test('before the library\'s first answer, the bound is its figure for the operator\'s next round', () => {
  assert.equal(settleMinutesOf(TESTNET_INFO), 6)
  assert.equal(settleMinutesOf(null), 5)
  assert.equal(settleMinutesOf({ anchor_depth: 2, server_info: { fills: { round_interval_seconds: 600, block_seconds: 60 } } }), 43)
  // A record from before the page stored a bound: the defaults' figure from when it began waiting.
  const r = { source: 'btc-gateway', dir: 'buy', at: T0, state: 'waiting', waitingSince: T0 }
  assert.equal(tradeStateWord(r, T0 + 1000), USER_WORDS.waitingOther(5))
  assert.equal(tradeStateWord(r, T0 + 5 * min + SETTLE_LATE_MS + 1), USER_WORDS.waitingOtherLate)
})

// One purchase on btcTrades, with a stand-in library whose `lightning_receive_ready` answers in turn.
function purchase (answers, info = TESTNET_INFO) {
  let t = T0
  const recs = []
  const run = async (cmd) => {
    if (cmd === 'info') { if (info) return info; throw new Error('unreachable') }
    if (cmd === 'coins') return []
    if (cmd === 'sync') return {}
    if (cmd === 'lightning_receive') return { invoice: 'lnsq', fee: '1', value: '99' }
    if (cmd === 'lightning_receives') return { hh: { state: answers[0] && answers[0].waiting_for === 'payment' ? 'waiting' : 'locked' } }
    if (cmd === 'lightning_receive_ready') return answers.shift()
    throw new Error('no ' + cmd)
  }
  const deps = { btc: null, fetchJson: async () => ({}) }
  const T = btcTrades({ run, deps, put: (r) => { recs.push(r); return r }, log: () => {}, now: () => t, settleStep: () => {}, maxFeePpm: 1000, firmMarginMs: 1000 })
  const choice = { dir: 'buy', entry: { maker: 'http://m' }, btc: { offer: { swap: 's', invoice: 'lnbc', expires_at: 4e9 }, decoded: { payment_hash: 'hh', sats: 50, min_final_cltv: 18 },
    routeFee: 1, routeDelay: 40, receiveQuote: { asset: 'aa', amount: '100', fee: '1', value: '99', claimed: '90' }, settle: { asset: 'aa', value: '99', fee: '1' } } }
  return { T, choice, at: (ms) => { t = T0 + ms }, now: () => t }
}

test('a purchase states the library\'s wait: the maker\'s time to lock while it has not paid, then the round\'s', async () => {
  const p = purchase([
    { ready: false, waiting_for: 'payment', why: 'not paid' },
    { ready: false, waiting_for: 'round', usual_in_seconds: 300, final_in_seconds: 900 },
    { ready: false, waiting_for: 'block', usual_in_seconds: 60, final_in_seconds: 120 },
  ])
  const rec = await p.T.confirm(p.choice, { id: 'r', at: T0 })
  assert.equal(rec.state, 'waiting')
  assert.equal(rec.waitFirstBy, T0 + 6 * min, 'before the first answer: the next round at the testnet\'s settings')
  assert.equal(tradeStateWord(rec, T0 + 2000), USER_WORDS.waitingOther(6))
  // The maker has not paid in: its time to lock bounds the wait.
  p.at(30_000); await p.T.advance(rec)
  assert.deepEqual(rec.waitBy, { finalBy: T0 + MAKER_LOCK_MS, step: 'payment' })
  assert.equal(tradeStateWord(rec, p.now()), USER_WORDS.waitingOther(5))
  // Paid in: the library's usual time for the round from now.
  p.at(60_000); await p.T.advance(rec)
  assert.deepEqual(rec.waitBy, { finalBy: T0 + 60_000 + 300_000, step: 'round' })
  assert.equal(tradeStateWord(rec, p.now()), USER_WORDS.waitingOther(5))
  // The step moves on: the time stays (a slow step makes it late, not later).
  p.at(200_000); await p.T.advance(rec)
  assert.deepEqual(rec.waitBy, { finalBy: T0 + 360_000, step: 'block' })
  assert.equal(tradeStateWord(rec, T0 + 300_000), USER_WORDS.waitingOther(1))
  assert.equal(tradeStateWord(rec, T0 + 360_000 + SETTLE_LATE_MS + 1), USER_WORDS.waitingOtherLate)
})

test('an operator not read at the approval: the defaults\' bound until the library answers', async () => {
  const p = purchase([{ ready: false, waiting_for: 'round', usual_in_seconds: 1500, final_in_seconds: 1800 }], null)
  const rec = await p.T.confirm(p.choice, { id: 'r', at: T0 })
  assert.equal(rec.waitFirstBy, T0 + 5 * min)
  p.at(10_000); await p.T.advance(rec)
  assert.equal(tradeStateWord(rec, p.now()), USER_WORDS.waitingOther(25))
})
