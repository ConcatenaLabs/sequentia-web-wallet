// A payment that settles first is written down while it waits (pending-sends.js), so a page closed
// meanwhile makes it when the wallet is next open: once, and only one that signed nothing yet. And
// the words of that wait carry its true time (default-arca.js settleMinutes, settleWords;
// user-trade.js settleBound).
import assert from 'node:assert/strict'
import test from 'node:test'
import { putPending, dropPending, stageWriter, takePending, pendingSends, samePending, pendingEnds, noteEnd, markEndTold, PENDING_MOST_MS } from './pending-sends.js'
import { readFileSync } from 'node:fs'
import { arrivalMinutes } from './default-arca.js'
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
  assert.equal(settleMinutes(60, 60, 0, true, 3), 5, 'an operator that publishes 3 s passes: (60 + 3 + 60 + 120 + 9) / 60, up')
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

test('a payment made after the page reopened is shown while it waits, its end is said once, and the same payment asked again is warned of (W1)', () => {
  const store = memStore(), t0 = 1_800_000_000_000
  const rec = { id: 'w', kind: 'address', asset: 'x', atoms: '500', to: 'tb1qdest', at: t0, state: 'asking' }
  stageWriter(store, 't', rec)('waiting')
  assert.ok(samePending(store, 't', { asset: 'x', atoms: '500', to: 'tb1qdest' }), 'the same payment while the first waits')
  assert.equal(samePending(store, 't', { asset: 'x', atoms: '501', to: 'tb1qdest' }), null)
  // One the page closed while asking, one lapsed: each noted as an end to say.
  putPending(store, 't', { id: 'a', kind: 'code', asset: 'x', atoms: '7', to: 'arca:…', at: t0, state: 'asking' })
  putPending(store, 't', { id: 'l', kind: 'code', asset: 'x', atoms: '9', to: 'arca:…', at: t0 - PENDING_MOST_MS - 1, state: 'waiting' })
  takePending(store, 't', t0 + 1000)
  assert.deepEqual(pendingEnds(store, 't').map((e) => [e.id, e.why]), [['a', 'unknown'], ['l', 'lapsed']])
  // A resumed one refused: noted too; each told once, then gone.
  noteEnd(store, 't', rec, 'refused')
  assert.equal(pendingEnds(store, 't').length, 3)
  for (const e of pendingEnds(store, 't')) markEndTold(store, 't', e.id)
  assert.deepEqual(pendingEnds(store, 't'), [])
  assert.equal(DEFAULT_WORDS.pendingNotSent('5', 'USDX'), '5 USDX was not sent: nothing left your wallet.')
  assert.match(DEFAULT_WORDS.pendingMaybeSent('5', 'USDX'), /may have gone before the page closed: check Activity before sending it again/)
  assert.equal(DEFAULT_WORDS.sameOnItsWay, 'The same payment is already on its way: sending this pays it twice.')
  // The page: a waiting payment is an Activity row ("Sending", pending), the ends are on Balance's
  // card with OK, and both reviews say when the same payment is on its way.
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /pendingSends\(localStorage, walletTag\(\)\)\.map\(p=> \(\{ kind:'out', at:p\.at, legs:\[\{ asset:p\.asset, atoms:String\(p\.atoms\) \}\], pending:true, waitingSend:true \}\)\)/)
  assert.match(html, /r\.waitingSend \? DEFAULT_WORDS\.rowSending/)
  assert.match(html, /e\.why === 'unknown' \? DEFAULT_WORDS\.pendingMaybeSent\(amount, mm\.ticker\) : DEFAULT_WORDS\.pendingNotSent\(amount, mm\.ticker\)/)
  assert.match(html, /try\{ noteEnd\(localStorage, tag, rec, 'refused'\); \}catch\{\}/)
  assert.equal((html.match(/const same = sameOnItsWay\(/g) || []).length, 2, 'both reviews')
})

test('the address review counts the settle and the whole way after it (W2), and no wait promises what may not come (W3, W4)', () => {
  // The testnet: the settle usually 6 minutes, the address path 15; the review says at least their sum.
  const settle = settleMinutes(60, 60, 0, true)
  const said = arrivalMinutes(settle * 60 + 60, 60)
  assert.ok(said >= settle + arrivalMinutes(60, 60), `${said} >= ${settle} + ${arrivalMinutes(60, 60)}`)
  assert.equal(said, 25)
  assert.match(DEFAULT_WORDS.goesThroughLate, /or nothing is sent$/)
  assert.match(USER_WORDS.goesThroughLate, /or is returned with nothing traded$/)
  assert.ok(!/settle_first|[0-9a-f]{64}/.test(DEFAULT_WORDS.settleGaveUp), DEFAULT_WORDS.settleGaveUp)
  const leaves = readFileSync(new URL('./leaves.js', import.meta.url), 'utf8')
  assert.equal((leaves.match(/message: DEFAULT_WORDS\.settleGaveUp/g) || []).length, 2, 'past the tries and past the longest wait, in words')
})
