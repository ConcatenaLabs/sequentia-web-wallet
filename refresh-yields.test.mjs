// Upkeep yields to the person (D95): what the wallet received is refreshed in a round only when the
// library's rule says so (`refresh_needed`: a coin one reassignment short of the limit, more than
// half of what the wallet may hold out of round over every asset, a coin near its expiry, or the
// person gone two minutes). The page asks it on a timer of its own and at once on every receipt,
// and counts the idle time; nothing else has to run the upkeep for a coin that arrives later.
//   node --test refresh-yields.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, refreshNeededArgs, JOINED_KEY, MODE_KEY, REFRESH_IDLE_MS } from './leaves.js'

test('the idle seconds the page hands the library', () => {
  assert.deepEqual(refreshNeededArgs(10_000, 5_000, 130_000), { idle_seconds: 120 })
  assert.deepEqual(refreshNeededArgs(0, 50_000, 60_000), { idle_seconds: 10 })
  assert.deepEqual(refreshNeededArgs(70_000, 0, 60_000), { idle_seconds: 0 })
})

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function fakeWorker (answer) {
  const w = { posted: [] }
  w.postMessage = (m) => { w.posted.push(m); queueMicrotask(() => w.onmessage({ data: answer(m) })) }
  return w
}

// A wallet whose library holds a received coin from `arrivesAt` (ms of the fake clock) and needs a
// refresh by its idle rule, or at once with `deep`. `withRule: false` stands for a library without
// `refresh_needed`. The page's timer asks every 200 ms of real time; the upkeep is never nudged.
async function mounted ({ arrivesAt = 0, deep = false, withRule = true } = {}) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  store.setItem(MODE_KEY + '.t', 'user')
  const clock = { t: 1_000_000 }
  const runs = []
  let given = false
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    const a = m.args.args || {}
    runs.push([c, a, clock.t])
    // Once given up in a refresh the coin is no longer a live received coin: nothing more is needed.
    const held = clock.t >= 1_000_000 + arrivesAt && !given
    if (c === 'refresh_received') given = true
    if (c === 'refresh_needed') {
      if (!withRule) return { id: m.id, ok: false, error: { kind: 'parse', message: 'no command refresh_needed' } }
      const reasons = !held ? [] : deep ? [{ rule: 'depth' }] : a.idle_seconds >= 120 ? [{ rule: 'idle' }] : []
      return { id: m.id, ok: true, value: { result: { needed: reasons.length > 0, reasons }, start: {} } }
    }
    const result = c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'balance' ? { arca: { a: { live: held ? '100' : '0' } } }
      : c === 'info' ? { operator: 'ee'.repeat(32), server_info: { assets: [], depth_limit: 5 } }
      : c === 'refresh_received' ? { refreshed: ['r1'] }
      : c === 'care' ? { claims: [], planned: [], cancelled: [], not_yet_planned: 0 }
      : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock.t,
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: 'ee'.repeat(32) }), tickMs: 3_600_000, mailboxPollMs: 3_600_000,
    refreshNeedMs: 200 }, null, null)
  await api.start()
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  return { api, runs, clock, wait }
}
const count = (runs, c) => runs.filter(([x]) => x === c).length

test('a coin arriving after open, the person active, waits; left alone two minutes, it is refreshed, with no upkeep nudged', async () => {
  const { api, runs, clock, wait } = await mounted({ arrivesAt: 130_000 })
  try {
    // The person asks something every 30 s of the clock, past the coin's arrival.
    for (let i = 0; i < 8; i++) {
      clock.t += 30_000
      await api.command('balance', {})
      await wait(500)
    }
    assert.ok(count(runs, 'refresh_needed') >= 4, 'the rule is asked on the page\'s own timer: ' + count(runs, 'refresh_needed'))
    assert.equal(count(runs, 'refresh_received'), 0, 'nothing given up while the person is active')
    // Left alone past REFRESH_IDLE_MS: the timer asks again and the library says idle.
    clock.t += REFRESH_IDLE_MS + 1000
    await wait(800)
    assert.equal(count(runs, 'refresh_received'), 1, runs.map(([c]) => c).join(','))
    const asked = runs.filter(([c]) => c === 'refresh_needed').pop()
    assert.ok(asked[1].idle_seconds >= 120, JSON.stringify(asked[1]))
  } finally { api.stop() }
})

test('a coin the library needs refreshed now (one hop from the limit) goes at once, the person busy or not', async () => {
  const { api, runs, clock, wait } = await mounted({ arrivesAt: 60_000, deep: true })
  try {
    clock.t += 60_000
    await api.command('balance', {})
    await wait(800)
    assert.equal(count(runs, 'refresh_received'), 1, runs.map(([c]) => c).join(','))
  } finally { api.stop() }
})

test('a library without the rule: refreshed on the pace alone, as before', async () => {
  const { api, runs, wait } = await mounted({ withRule: false })
  try {
    await wait(800)
    assert.ok(count(runs, 'refresh_received') >= 1, runs.map(([c]) => c).join(','))
  } finally { api.stop() }
})
