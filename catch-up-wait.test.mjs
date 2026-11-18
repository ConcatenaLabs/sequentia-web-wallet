// A payment to a code another store of the phrase handed out (the payment name's stock keeps such
// codes, and the phrase may be open in the extension or Ambra too) is refused by this store's
// mailbox and taken in only by the library's catch-up, a step of `sync` that runs at most once
// every ten minutes of median time and reads only what the operator has settled. The page keeps
// the refused coins and syncs whenever that catch-up is open by the library's own clock, until it
// holds each one, so the payment shows within seconds when the catch-up is open and within its ten
// minutes otherwise, never at the next daily sync (sequentia-extension#214, the same gap in this
// page); without holding the rest of its upkeep back, without spinning when the node does not
// answer, and bounded. A payment to a code of the wallet's own made hours ago is read in developer
// mode too. The extension's test/catch-up-wait.test.mjs runs the same cases against its host.
//   node --test catch-up-wait.test.mjs
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, JOINED_KEY, setWalletMode, requestWaits, phraseCoinsRefused, catchUpWait, catchUpAfterSync, catchUpHeld, catchUpAttempt,
  catchUpGate, catchUpSyncIn, CATCH_UP_RETRY_MS, CATCH_UP_TRIES, CATCH_UP_EVERY_S, REQUEST_HOLDS_S } from './leaves.js'

const NEVER = 'refused: a coin for owner nonce ab12, which this wallet never drew'
const OP = 'ab'.repeat(32)
const refusal = (id) => ({ refused: [{ leaf_id: id, reason: NEVER }] })

test('the rules, as the extension\'s: kept until held, counted catch-ups, every attempt counted, the gate in median time', () => {
  assert.deepEqual(phraseCoinsRefused({ refused: [{ leaf_id: 'x', reason: NEVER }, { leaf_id: 'y', reason: 'refused: other' }] }), ['x'])
  let w = catchUpWait(null, { mailbox: refusal('x'), now: 1000 })
  let r = catchUpAfterSync(w, { sync: { caught_up: { restored: [{ leaf_id: 'other' }] } }, now: 5000 })
  assert.deepEqual(r.arrived, [])
  assert.deepEqual(r.wait.pending, ['x'])
  assert.equal(r.wait.tries, 1)
  assert.equal(catchUpHeld(r.wait, [{ leaf_id: 'x', asset: 'a', value: '7', state: 'live' }], 6000).wait, null)
  r = catchUpAfterSync(null, { sync: { mailbox: refusal('z'), caught_up: { restored: [{ leaf_id: 'z', asset: 'a', value: '3' }] } }, now: 1 })
  assert.deepEqual(r.arrived.map((c) => c.leaf_id), ['z'])
  w = catchUpAttempt(catchUpWait(null, { mailbox: refusal('x'), now: 0 }), 10)
  assert.equal(catchUpSyncIn(w, { now: 10 }), CATCH_UP_RETRY_MS)
  assert.equal(catchUpGate(null, { caught_up: { restored: [] }, schedule: { now: 1000 } }, 900), 1000 + CATCH_UP_EVERY_S)
  const s = (q) => ({ now: 10_000_000, receive_requests: [{ owner: 'k', state: 'waiting', ...q }] })
  assert.equal(requestWaits(s({ asked_at: 10_000_000 - 7200, lapses_at: null })), true)
  assert.equal(requestWaits(s({ asked_at: 10_000_000 - REQUEST_HOLDS_S - 1, lapses_at: null })), false)
})

// The library as the page sees it. Its median time (`now`) runs at `rate` of the wall clock. A
// schedule a day away unless `dueAt`; one request (`request`, by default two hours old). `sync`
// runs the catch-up only once CATCH_UP_EVERY_S of median time have passed since the last, and the
// catch-up takes in every coin paid to another store's code that the operator has settled
// (`settleMs` after it was paid; `never` never), plus `change`, coins the other store made itself.
// The mailbox refuses such a coin once (its cursor moves past it) and takes a coin paid to this
// store's own code. `down`: 'schedule', 'sync' or 'both' throw, as when the node does not answer.
function library ({ rate = 1, request = null, lastCatchUpAgo = null } = {}) {
  const t0 = Date.now()
  const L = { calls: [], lastCatchUp: null, elsewhere: [], own: [], change: [], syncs: [], mailboxReads: 0, scheduleReads: [], dueAt: null, settleMs: 0, down: null }
  const secs = () => Math.floor(t0 / 1000 + (Date.now() - t0) * rate / 1000)
  if (lastCatchUpAgo != null) L.lastCatchUp = secs() - lastCatchUpAgo
  L.run = (command, args) => {
    L.calls.push({ at: Date.now(), command })
    if (L.down && (L.down === 'both' || L.down === command) && (command === 'schedule' || command === 'sync')) throw new Error('the node does not answer')
    switch (command) {
      case 'schedule': {
        L.scheduleReads.push(Date.now())
        const due = L.dueAt != null && Date.now() >= L.dueAt
        return { now: secs(), due, next_sync_at: due ? secs() : secs() + 86400, why: null,
          receive_requests: [request ? request(secs()) : { owner: 'k', state: 'waiting', asked_at: secs() - 7200, lapses_at: secs() + 80000 }] }
      }
      case 'mailbox': {
        L.mailboxReads++
        const refused = L.elsewhere.filter((c) => !c.refused).map((c) => { c.refused = true; return { leaf_id: c.leaf_id, reason: NEVER } })
        return { accepted: L.own.splice(0), refused, waiting: [] }
      }
      case 'sync': {
        const mailbox = L.run('mailbox')
        let caught_up = null
        if (L.lastCatchUp == null || secs() - L.lastCatchUp >= CATCH_UP_EVERY_S) {
          L.lastCatchUp = secs()
          const ripe = L.elsewhere.filter((c) => !c.never && Date.now() - c.paidAt >= L.settleMs)
          L.elsewhere = L.elsewhere.filter((c) => !ripe.includes(c))
          caught_up = { restored: [...ripe, ...L.change.splice(0)].map(({ leaf_id, asset, value }) => ({ leaf_id, asset, value, kind: 'mailbox' })), given_elsewhere: [] }
        }
        if (L.dueAt != null && Date.now() >= L.dueAt) L.dueAt = null
        L.syncs.push({ at: Date.now(), args, caughtUp: !!caught_up })
        return { mailbox, caught_up, schedule: { now: secs() } }
      }
      case 'balance': return { arca: {} }
      case 'care': return { claims: [], planned: [], cancelled: [] }
      case 'info': return {}
      default: return []
    }
  }
  L.pay = (leaf_id, extra = {}) => L.elsewhere.push({ leaf_id, asset: 'bb'.repeat(32), value: '5', paidAt: Date.now(), ...extra })
  return L
}

function memStore (m = new Map()) {
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
async function advance (ms, step = 250) {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush() }
}
const arrivedAt = (events, leaf) => (events.find((e) => e.name === 'leafArrived' && e.data.leaf_id === leaf) || {}).at
const arrivals = (events) => events.filter((e) => e.name === 'leafArrived').map((e) => e.data.leaf_id)

async function opened (developer, { lib = {}, store = null, L = null } = {}) {
  L = L || library(lib)
  if (!store) {
    store = memStore()
    store.setItem(JOINED_KEY + '.t', '1')
    if (developer) setWalletMode(store, 't', 'developer')
  }
  const events = []
  const w = {}
  w.postMessage = (m) => {
    // `L.hold`: the next call of that command answers only when the test calls `L.release()`.
    if (L.hold && m.args && m.args.command === L.hold) {
      L.hold = null
      L.release = () => { L.release = null; w.postMessage(m) }
      return
    }
    let value
    if (m.op === 'exists') value = true
    else if (m.op === 'open') value = {}
    else {
      try { value = { result: L.run(m.args.command, m.args.args || {}), start: {} } } catch (e) {
        queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: false, error: { message: String(e.message) } } })); return
      }
    }
    queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
  }
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: OP }), serverInfo: async () => ({ operator: OP }),
    onEvent: (name, data) => events.push({ at: Date.now(), name, data }), careEveryMs: 3_600_000 }, null, null)
  let done = false
  api.start().then(() => { done = true }, (e) => { done = e })
  for (let i = 0; i < 400 && !done; i++) await advance(250)
  assert.equal(done, true, 'the wallet opened')
  await advance(30_000)
  assert.ok(L.syncs.length >= 1, 'the open sync ran')
  return { L, api, events, store }
}
function timed (f) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
    try { await f() } finally { mock.timers.reset() }
  }
}
const after = (L, t) => L.syncs.filter((s) => s.at > t)

test('user mode, idle: a payment to another store\'s code shows within seconds once the catch-up is open', timed(async () => {
  const { L, api, events } = await opened(false)
  await advance(11 * 60_000)
  const paid = Date.now(); const n = L.syncs.length
  L.pay('coin-a')
  await advance(60_000)
  const at = arrivedAt(events, 'coin-a')
  console.log(`coin-a: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid; ${L.syncs.length - n} sync(s)`)
  assert.ok(at && at - paid <= 15_000)
  assert.equal(L.syncs.length - n, 1)
  assert.deepEqual(L.syncs.at(-1).args, { deposits: false })
  api.stop()
}))

test('user mode, idle: paid minutes after a catch-up, it shows when the library\'s catch-up opens, with one sync', timed(async () => {
  const { L, api, events } = await opened(false)
  await advance(3 * 60_000)
  const paid = Date.now()
  const opens = (L.lastCatchUp + CATCH_UP_EVERY_S) * 1000
  L.pay('coin-b')
  await advance(12 * 60_000)
  const at = arrivedAt(events, 'coin-b')
  const during = after(L, paid).filter((s) => !at || s.at <= at).length
  console.log(`coin-b: ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - opens) / 1000 + ' s after the catch-up opened' : 'not shown'}; syncs while it waited: ${during}`)
  assert.ok(at && at - opens <= 61_000)
  assert.ok(during <= 2, `${during} syncs`)
  assert.equal(after(L, at).length, 0)
  api.stop()
}))

test('M1: a refusal read by the mailbox watch never pushes the next ask back', timed(async () => {
  const { L, api } = await opened(false)
  await advance(3 * 60_000)
  const paid = Date.now()
  L.pay('coin-x')
  L.dueAt = paid + 20_000
  await advance(7 * 60_000)
  const first = after(L, paid)[0]
  console.log(`M1: schedule due at +20 s; first sync after the refusal at +${first ? (first.at - paid) / 1000 : '-'} s`)
  assert.ok(first && first.at - (paid + 20_000) <= 61_000)
  assert.deepEqual(first.args, {}, 'the schedule\'s own sync, whole')
  api.stop()
}))

test('M2: with the node down during a wait, the page asks at its cadence, not without pause', timed(async () => {
  for (const down of ['both', 'sync', 'schedule']) {
    const { L, api } = await opened(false)
    await advance(11 * 60_000)
    L.down = down
    const n = L.calls.length
    L.pay('coin-d-' + down)
    await advance(5 * 60_000, 100)
    const calls = L.calls.slice(n).filter((c) => c.command === 'schedule' || c.command === 'sync')
    console.log(`M2 (${down} throws): ${calls.length} schedule/sync calls in 5 min`)
    const syncs = calls.filter((c) => c.command === 'sync')
    assert.ok(syncs.length <= 6, `${syncs.length} sync attempts in 5 min`)
    assert.ok(syncs.every((c, i) => i === 0 || c.at - syncs[i - 1].at >= CATCH_UP_RETRY_MS), 'a minute at least between two attempts')
    assert.ok(calls.length <= 15, `${calls.length} calls in 5 min`)
    L.down = null
    api.stop()
  }
}))

test('M3: a catch-up that ends whole before the operator settled the coin does not end the wait', timed(async () => {
  const { L, api, events } = await opened(false)
  L.settleMs = 20_000
  await advance(11 * 60_000)
  const paid = Date.now()
  L.pay('coin-t')
  await advance(25 * 60_000)
  const at = arrivedAt(events, 'coin-t')
  const during = after(L, paid).filter((s) => !at || s.at <= at).length
  console.log(`M3: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`)
  assert.ok(at && at - paid <= 11 * 60_000)
  assert.ok(during <= 3)
  assert.equal(after(L, at).length, 0)
  api.stop()
}))

test('M3: a coin no catch-up ever brings ends the wait after the stated number of catch-ups, then nothing more', timed(async () => {
  const { L, api, events } = await opened(false)
  await advance(11 * 60_000)
  const paid = Date.now()
  L.pay('coin-n', { never: true })
  await advance(3 * 3600_000, 1000)
  const syncs = after(L, paid)
  const last = syncs.at(-1)
  console.log(`M3 cap: ${syncs.length} syncs, ${syncs.filter((s) => s.caughtUp).length} with a catch-up, the last at +${last ? Math.round((last.at - paid) / 60_000) : '-'} min`)
  assert.equal(syncs.filter((s) => s.caughtUp).length, CATCH_UP_TRIES)
  assert.ok(syncs.length <= CATCH_UP_TRIES + 2)
  assert.ok(!arrivals(events).includes('coin-n'))
  api.stop()
}))

test('L1: opened again a minute after a catch-up, the page knows when the next opens and syncs once for it', timed(async () => {
  const first = await opened(false)
  first.api.stop()
  await advance(60_000)
  const { L, api, events } = await opened(false, { store: first.store, L: first.L })
  const paid = Date.now(); const n = L.syncs.length
  const opens = (L.lastCatchUp + CATCH_UP_EVERY_S) * 1000
  L.pay('coin-r')
  await advance(15 * 60_000)
  const at = arrivedAt(events, 'coin-r')
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length
  console.log(`L1 reopen: shown ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - opens) / 1000 + ' s after the catch-up opened' : 'never'}; syncs while it waited: ${during}`)
  assert.ok(at && at - opens <= 61_000)
  assert.ok(during <= 2, `${during} syncs`)
  api.stop()
}))

test('L1: opened with no record of the last catch-up, a minute after one: no burst of syncs', timed(async () => {
  const { L, api, events } = await opened(false, { lib: { lastCatchUpAgo: 60 } })
  const paid = Date.now(); const n = L.syncs.length
  L.pay('coin-q')
  await advance(15 * 60_000)
  const at = arrivedAt(events, 'coin-q')
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length
  console.log(`L1 no record: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`)
  assert.ok(at && at - paid <= 11 * 60_000)
  assert.ok(during <= 6, `${during} syncs`)
  api.stop()
}))

test('L1: on a chain whose median time runs at half speed, the wait follows the library\'s clock and ends with the coin', timed(async () => {
  const { L, api, events } = await opened(false, { lib: { rate: 0.5 } })
  const paid = Date.now(); const n = L.syncs.length
  L.pay('coin-s')
  await advance(40 * 60_000, 500)
  const at = arrivedAt(events, 'coin-s')
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length
  console.log(`L1 half speed: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`)
  assert.ok(at)
  assert.ok(during <= 2, `${during} syncs`)
  api.stop()
}))

test('L2 and L3: a payment refused and restored by a sync someone asked is announced; another store\'s own coins are not', timed(async () => {
  const { L, api, events } = await opened(false)
  await advance(11 * 60_000)
  L.pay('coin-f')
  L.change.push({ leaf_id: 'change-of-the-other-store', asset: 'cc'.repeat(32), value: '1' })
  // A sync asked by a module of the page (the trade composer's), through the leaf rail's `pay`.
  const p = api.pay('sync', {})
  await advance(1000)
  await p
  assert.equal(L.syncs.at(-1).caughtUp, true)
  assert.ok(arrivals(events).includes('coin-f'), 'announced')
  assert.ok(!arrivals(events).includes('change-of-the-other-store'), 'not announced')
  api.stop()
}))

test('developer mode, idle: a payment to a code of its own two hours old is read within a tick', timed(async () => {
  const { L, api, events } = await opened(true)
  await advance(5 * 60_000)
  const paid = Date.now()
  L.own.push({ leaf_id: 'coin-c', asset: 'cc'.repeat(32), value: '7', kind: 'mailbox' })
  await advance(2 * 60_000)
  const at = arrivedAt(events, 'coin-c')
  console.log(`coin-c: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`)
  assert.ok(at && at - paid <= 61_000)
  api.stop()
}))

test('developer mode: a request with no lapse date is read for the life of a request, not for ever', timed(async () => {
  for (const [age, reads] of [[7200, true], [REQUEST_HOLDS_S + 60, false]]) {
    const { L, api } = await opened(true, { lib: { request: (now) => ({ owner: 'k', state: 'waiting', asked_at: now - age, lapses_at: null }) } })
    const m = L.mailboxReads
    await advance(10 * 60_000)
    console.log(`no lapse date, ${Math.round(age / 86400)} d old: ${L.mailboxReads - m} mailbox read(s) in 10 min`)
    assert.equal(L.mailboxReads - m > 0, reads)
    api.stop()
  }
}))

test('idle with nothing paid: no sync beyond the open one', timed(async () => {
  for (const developer of [false, true]) {
    const { L, api } = await opened(developer)
    const reads0 = L.mailboxReads
    await advance(30 * 60_000)
    console.log(`${developer ? 'developer' : 'user'} mode, idle 30 min: ${L.syncs.length} sync(s), ${(L.mailboxReads - reads0) / 30} mailbox read(s) a minute`)
    assert.equal(L.syncs.length, 1)
    api.stop()
  }
}))

test('stopped while a catch-up wait has a schedule read or a sync under way: nothing more is asked', timed(async () => {
  for (const held of ['schedule', 'sync']) {
    const { L, api } = await opened(false)
    await advance(11 * 60_000)
    L.hold = held
    L.pay('coin-stop-' + held)
    for (let i = 0; i < 400 && !L.release; i++) await advance(250)
    assert.ok(L.release, `a ${held} is under way`)
    api.stop()
    const n = L.calls.length
    L.release()
    await advance(3 * 60_000)
    const more = L.calls.slice(n).map((c) => c.command)
    console.log(`stopped with a ${held} under way: ${more.length} call(s) after it returned: ${more.join(', ')}`)
    // The fake library's sync reads the mailbox inside it, as the real one does.
    assert.deepEqual(more, held === 'sync' ? ['sync', 'mailbox'] : ['schedule'], 'only the call under way, nothing after it')
  }
}))
