// A payment to a code another store of the phrase handed out (the payment name's stock keeps such
// codes, and the phrase may be open in the extension or Ambra too) is refused by this store's
// mailbox and taken in only by the library's catch-up, a step of `sync` that runs at most every
// ten minutes. The page syncs once that catch-up is due after its mailbox read refused such a
// coin, so the payment shows within seconds when the catch-up is due and within its ten minutes
// otherwise, never at the next daily sync (sequentia-extension#214, the same gap in this page).
// A payment to a code of the wallet's own made hours ago is read in developer mode too.
//   node --test catch-up-wait.test.mjs
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, JOINED_KEY, setWalletMode, requestWaits, phraseCoinRefused, caughtUpWhole, catchUpWait, catchUpSyncIn, catchUpRanAt,
  CATCH_UP_POLL_MS, CATCH_UP_WAIT_MS, CATCH_UP_EVERY_MS } from './leaves.js'

const NEVER = 'refused: a coin for owner nonce ab12, which this wallet never drew'
const OP = 'ab'.repeat(32)

test('the rules: a refused phrase coin starts the wait, a whole catch-up ends it, it lapses by itself', () => {
  assert.equal(phraseCoinRefused({ refused: [{ leaf_id: 'x', reason: NEVER }] }), true)
  assert.equal(phraseCoinRefused({ refused: [{ reason: 'refused: the record does not decode' }] }), false)
  assert.equal(caughtUpWhole({ caught_up: { restored: [], more: true } }), false)
  assert.equal(caughtUpWhole({ caught_up: { restored: [] } }), true)
  let w = catchUpWait(null, { mailbox: { refused: [{ reason: NEVER }] }, now: 1000 })
  assert.deepEqual(w, { since: 1000, syncedAt: null })
  assert.equal(catchUpSyncIn(w, 1000, null), 0, 'no catch-up seen: at once')
  assert.equal(catchUpSyncIn(w, 1000, 500), 500 + CATCH_UP_EVERY_MS - 1000, 'one seen just now: when it is due again')
  w = catchUpWait(w, { sync: { caught_up: null, mailbox: {} }, now: 2000 })
  assert.equal(catchUpSyncIn(w, 2000, null), CATCH_UP_POLL_MS)
  assert.equal(catchUpWait(w, { sync: { caught_up: { restored: [{}] } }, now: 3000 }), null)
  assert.equal(catchUpWait(w, { now: 1000 + CATCH_UP_WAIT_MS }), null, 'lapses')
  assert.equal(catchUpRanAt(5, { caught_up: { more: true } }, 9), null)
  assert.equal(catchUpRanAt(5, { caught_up: {} }, 9), 9)
  assert.equal(catchUpRanAt(5, { caught_up: null }, 9), 5)
  assert.equal(requestWaits({ now: 10000, receive_requests: [{ owner: 'k', state: 'waiting', asked_at: 2800, lapses_at: 90000 }] }), true)
  assert.equal(requestWaits({ now: 10000, receive_requests: [{ owner: 'restored', state: 'waiting', asked_at: 9000 }] }), false)
})

// The library as the page sees it: a schedule a day away, one request two hours old; `sync` runs
// the catch-up only once ten minutes have passed since the last (the library's CATCH_UP_EVERY), and
// the catch-up takes in every coin paid to another store's code; the mailbox refuses such a coin
// once (its cursor moves past it) and takes a coin paid to this store's own code.
function library () {
  const L = { lastCatchUp: null, elsewhere: [], own: [], syncs: [], mailboxReads: 0 }
  const secs = () => Math.floor(Date.now() / 1000)
  L.run = (command, args) => {
    switch (command) {
      case 'schedule': return { now: secs(), due: false, next_sync_at: secs() + 86400, why: null,
        receive_requests: [{ owner: 'k', state: 'waiting', asked_at: secs() - 7200, lapses_at: secs() + 80000 }] }
      case 'mailbox': {
        L.mailboxReads++
        const refused = L.elsewhere.filter((c) => !c.refused).map((c) => { c.refused = true; return { leaf_id: c.leaf_id, reason: NEVER } })
        return { accepted: L.own.splice(0), refused, waiting: [] }
      }
      case 'sync': {
        const mailbox = L.run('mailbox')
        let caught_up = null
        if (L.lastCatchUp == null || secs() - L.lastCatchUp >= 600) {
          L.lastCatchUp = secs()
          caught_up = { restored: L.elsewhere.splice(0).map(({ leaf_id, asset, value }) => ({ leaf_id, asset, value, kind: 'mailbox' })), given_elsewhere: [] }
        }
        L.syncs.push({ at: Date.now(), args, caughtUp: !!caught_up })
        return { mailbox, caught_up }
      }
      case 'balance': return { arca: {} }
      case 'care': return { claims: [], planned: [], cancelled: [] }
      case 'info': return {}
      default: return []
    }
  }
  return L
}

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
async function advance (ms, step = 250) {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush() }
}
const arrivedAt = (events, leaf) => (events.find((e) => e.name === 'leafArrived' && e.data.leaf_id === leaf) || {}).at

async function opened (developer) {
  const L = library()
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  if (developer) setWalletMode(store, 't', 'developer')
  const events = []
  const w = {}
  w.postMessage = (m) => {
    let value
    if (m.op === 'exists') value = true
    else if (m.op === 'open') value = {}
    else value = { result: L.run(m.args.command, m.args.args || {}), start: {} }
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
  assert.ok(L.syncs.length >= 1 && L.syncs[0].caughtUp, 'the open sync ran a catch-up')
  return { L, api, events }
}

test('user mode, idle: a payment to another store\'s code shows within seconds once the catch-up is due', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  try {
    const { L, api, events } = await opened(false)
    await advance(11 * 60_000)
    const before = L.syncs.length
    const paid = Date.now()
    L.elsewhere.push({ leaf_id: 'coin-a', asset: 'aa'.repeat(32), value: '100000000' })
    await advance(60_000)
    const at = arrivedAt(events, 'coin-a')
    console.log(`coin-a: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`)
    assert.ok(at, 'the payment showed')
    assert.ok(at - paid <= 15_000, `shown ${(at - paid) / 1000} s after it was paid`)
    assert.equal(L.syncs.length - before, 1, 'one sync took it in')
    assert.deepEqual(L.syncs.at(-1).args, { deposits: false })
    api.stop()
  } finally { mock.timers.reset() }
})

test('user mode, idle: when the catch-up ran minutes ago, the payment shows when it falls due, and the syncs stop then', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  try {
    const { L, api, events } = await opened(false)
    await advance(3 * 60_000)
    const paid = Date.now()
    const due = (L.lastCatchUp + 600) * 1000
    L.elsewhere.push({ leaf_id: 'coin-b', asset: 'bb'.repeat(32), value: '5' })
    await advance(12 * 60_000)
    const at = arrivedAt(events, 'coin-b')
    const during = L.syncs.filter((s) => s.at >= paid && (!at || s.at <= at)).length
    console.log(`coin-b: ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - due) / 1000 + ' s after the catch-up fell due' : 'not shown'}; syncs while it waited: ${during}`)
    assert.ok(at, 'the payment showed')
    assert.ok(at - due <= CATCH_UP_POLL_MS + 15_000)
    assert.ok(during <= 3, `${during} syncs while it waited`)
    assert.equal(L.syncs.filter((s) => s.at > at).length, 0, 'no sync once it is in')
    api.stop()
  } finally { mock.timers.reset() }
})

test('developer mode, idle: a payment to a code of its own two hours old is read within a tick', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  try {
    const { L, api, events } = await opened(true)
    await advance(5 * 60_000)
    const paid = Date.now()
    L.own.push({ leaf_id: 'coin-c', asset: 'cc'.repeat(32), value: '7', kind: 'mailbox' })
    await advance(2 * 60_000)
    const at = arrivedAt(events, 'coin-c')
    console.log(`coin-c: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`)
    assert.ok(at, 'the payment showed')
    assert.ok(at - paid <= 61_000)
    api.stop()
  } finally { mock.timers.reset() }
})

test('idle with nothing paid: no sync beyond the open one', async () => {
  for (const developer of [false, true]) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
    try {
      const { L, api } = await opened(developer)
      const reads0 = L.mailboxReads
      await advance(30 * 60_000)
      console.log(`${developer ? 'developer' : 'user'} mode, idle 30 min: ${L.syncs.length} sync(s), ${(L.mailboxReads - reads0) / 30} mailbox read(s) a minute`)
      assert.equal(L.syncs.length, 1)
      api.stop()
    } finally { mock.timers.reset() }
  }
})
