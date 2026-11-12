// A payment that settles first is written down while it waits (pending-sends.js), so a page closed
// meanwhile makes it when the wallet is next open: once, and only one that signed nothing yet. And
// the words of that wait carry its true time (default-arca.js settleMinutes, settleWords;
// user-trade.js settleBound).
import assert from 'node:assert/strict'
import test from 'node:test'
import { putPending, dropPending, stageWriter, takePending, pendingSends, PENDING_MOST_MS } from './pending-sends.js'
import { DEFAULT_WORDS, settleMinutes, settleWords, nextFinalBy, SETTLE_LATE_MS } from './default-arca.js'
import { USER_WORDS, settleBound, SETTLE_MOST_MS, tradeStateWord, forbiddenIn } from './user-trade.js'

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

test('a payment waiting when the page closed is made at the next open; one being asked is never asked again', () => {
  const store = memStore(), t0 = 1_800_000_000_000
  const a = { id: 'a', kind: 'code', asset: 'x', atoms: '5', to: 'arca:…', at: t0, state: 'asking' }
  const b = { id: 'b', kind: 'address', asset: 'x', atoms: '7', to: 'tb1q…', at: t0, state: 'asking' }
  const c = { id: 'c', kind: 'code', asset: 'x', atoms: '9', to: 'arca:…', at: t0 - PENDING_MOST_MS - 1, state: 'waiting' }
  const sa = stageWriter(store, 't', a), sb = stageWriter(store, 't', b)
  sa('asking'); sa('waiting')   // the library answered settle_first: nothing signed, it waits
  sb('asking')                  // the page closed while the library was asked
  putPending(store, 't', c)
  assert.deepEqual(pendingSends(store, 't').map((r) => [r.id, r.state]), [['a', 'waiting'], ['b', 'asking'], ['c', 'waiting']])
  const got = takePending(store, 't', t0 + 60_000)
  assert.deepEqual(got.resume.map((r) => r.id), ['a'], 'only the one that signed nothing is asked again')
  assert.deepEqual(got.dropped.map((r) => [r.id, r.why]), [['b', 'asking'], ['c', 'lapsed']])
  assert.deepEqual(pendingSends(store, 't').map((r) => r.id), ['a'], 'the resumed one stays written down until it ends')
  // Resumed: asked (it may sign now), then made: gone.
  const again = stageWriter(store, 't', got.resume[0])
  again('asking')
  assert.equal(pendingSends(store, 't')[0].state, 'asking')
  // A page that opens again meanwhile never asks it a second time.
  assert.deepEqual(takePending(store, 't', t0 + 120_000).resume, [])
  dropPending(store, 't', 'a')
  assert.deepEqual(pendingSends(store, 't'), [])
  assert.deepEqual(pendingSends(store, 'other'), [], 'kept per wallet')
})

test('the wait is said in its true minutes, never "try again"', () => {
  assert.equal(settleMinutes(60, 60, 0, true), 6, 'the testnet: rounds held for their forfeits, rounds and blocks a minute apart')
  assert.equal(settleMinutes(60, 60, 0), 5, 'rounds not held')
  assert.equal(settleMinutes(60, 60, 2), 25, 'two Bitcoin blocks more at depth 2')
  assert.equal(settleMinutes(null, null, null), 5)
  assert.equal(settleMinutes(60, 60, 0, true, 3), 5, 'an operator that publishes 3 s passes: (60 + 3 + 60 + 120 + 6) / 60, up')
  assert.equal(DEFAULT_WORDS.goesThrough(1), 'Goes through in about a minute')
  assert.equal(DEFAULT_WORDS.goesThrough(3), 'Goes through within about 3 minutes')
  const now = 1_800_000_000_000
  assert.equal(settleWords(null, 6, now), 'Goes through within about 6 minutes', 'before the library has said: the operator\'s numbers')
  assert.equal(settleWords(now + 50_000, 3, now), 'Goes through in about a minute', 'what the library said, counted down')
  assert.equal(settleWords(now + 170_000, 3, now), 'Goes through within about 3 minutes')
  assert.equal(settleWords(now - 1000, 3, now), 'Goes through in about a minute', 'just past it: still about a minute')
  assert.equal(settleWords(now - SETTLE_LATE_MS - 1, 3, now), DEFAULT_WORDS.goesThroughLate)
  for (const w of [DEFAULT_WORDS.goesThrough(3), DEFAULT_WORDS.goesThroughLate, USER_WORDS.goesThrough(3), USER_WORDS.goesThroughLate, USER_WORDS.settleLate]) {
    assert.ok(!/try again|went wrong/i.test(w), w)
    assert.deepEqual(forbiddenIn(w), [], w)
  }
})

test('a trade settling first waits as long as the library says, twice over with a margin, and says the time left', () => {
  assert.equal(settleBound(null), SETTLE_MOST_MS)
  assert.equal(settleBound(60), SETTLE_MOST_MS, 'the testnet\'s minute: the ten minutes stand')
  assert.equal(settleBound(1380), 2 * 1380 * 1000 + 120_000, 'depth 2: longer than ten minutes')
  const now = 1_800_000_000_000
  assert.equal(tradeStateWord({ state: 'settling', at: now }, now), USER_WORDS.settling)
  assert.equal(tradeStateWord({ state: 'settling', at: now, finalBy: now + 150_000 }, now), 'Goes through within about 3 minutes')
  assert.equal(tradeStateWord({ state: 'settling', at: now, finalBy: now - 200_000 }, now), USER_WORDS.goesThroughLate)
})

test('the time told stays while the step waited for stands or moves on, and is set again only when it goes back', () => {
  const t = 1_800_000_000_000
  let w = nextFinalBy(null, { ready: false, final_in_seconds: 900, usual_in_seconds: 180, waiting_for: 'round' }, t)
  assert.deepEqual(w, { finalBy: t + 180_000, step: 'round' }, 'counted to what it usually takes, not the most')
  w = nextFinalBy(w, { ready: false, final_in_seconds: 840, usual_in_seconds: 240, waiting_for: 'forfeits' }, t + 50_000)
  assert.equal(w.finalBy, t + 180_000, 'a round held for forfeits moves on: the time told stands')
  w = nextFinalBy(w, { ready: false, final_in_seconds: 120, waiting_for: 'block' }, t + 70_000)
  assert.equal(w.finalBy, t + 180_000, 'moving on keeps the time told')
  // An operator slow to release: the library answers a minute each time, and the time told stands,
  // so the words come to "Taking longer than usual".
  for (const dt of [200_000, 300_000, 400_000]) w = nextFinalBy(w, { ready: false, final_in_seconds: 60, waiting_for: 'release' }, t + dt)
  assert.equal(w.finalBy, t + 180_000)
  assert.equal(settleWords(w.finalBy, 3, t + 400_000), DEFAULT_WORDS.goesThroughLate)
  // A rollback sends it back to its block: a new time.
  w = nextFinalBy(w, { ready: false, final_in_seconds: 120, waiting_for: 'block' }, t + 410_000)
  assert.deepEqual(w, { finalBy: t + 530_000, step: 'block' })
  assert.equal(nextFinalBy(w, { ready: true }, t + 600_000), w)
})
