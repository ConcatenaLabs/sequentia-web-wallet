// The upkeep keeps a person's coins away from the operator's depth limit without ever putting all of
// an asset into a round at once (arca's `refresh_needed`: `give_up`, `kept_back`, and the rule `shape`
// with `spread` and `max_fee_ppm`). The library decides which coins go; the page follows it exactly.
//   node --test upkeep-keeps-coins.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, shapeSettleArgs, receivedRefreshAsked, JOINED_KEY, MODE_KEY } from './leaves.js'

test('the settle the rule `shape` asks for: its coins, cut into a few, at no more than its fee bound', () => {
  assert.equal(shapeSettleArgs({ reasons: [{ rule: 'idle' }] }), null)
  assert.deepEqual(shapeSettleArgs({ reasons: [{ rule: 'shape', coins: ['d1', 'd2'], spread: true, max_fee_ppm: 0 }] }),
    { coins: ['d1', 'd2'], spread: true, max_fee_ppm: 0 })
  // A library that names them only when the person is away gives no bound: the wallet's own applies.
  assert.deepEqual(shapeSettleArgs({ reasons: [{ rule: 'shape', coins: ['d1'] }] }), { coins: ['d1'] })
  assert.equal(receivedRefreshAsked({ reasons: [{ rule: 'shape', coins: ['d1'] }] }), false, 'only shape: nothing received goes')
  assert.equal(receivedRefreshAsked({ reasons: [{ rule: 'shape', coins: ['d1'] }, { rule: 'exposure' }] }), true)
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

// A wallet whose library answers `refresh_needed` with `needed` (once; nothing after a refresh).
async function mounted (needed) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  store.setItem(MODE_KEY + '.t', 'user')
  const runs = []
  let done = false
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    const a = m.args.args || {}
    runs.push([c, a])
    if (c === 'refresh_received' || c === 'settle_first') done = true
    const result = c === 'refresh_needed' ? (done ? { needed: false, reasons: [] } : needed)
      : c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'balance' ? { arca: {} }
      : c === 'info' ? { operator: 'ee'.repeat(32), server_info: { assets: [], depth_limit: 5 } }
      : c === 'refresh_received' ? { refreshed: a.leaves || ['all'] }
      : c === 'settle_first' ? { settling: a.coins || [], waiting: [], done: [], left: [], ready: false }
      : c === 'care' ? { claims: [], planned: [], cancelled: [], not_yet_planned: 0 }
      : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: 'ee'.repeat(32) }), tickMs: 3_600_000, mailboxPollMs: 3_600_000,
    refreshNeedMs: 200 }, null, null)
  await api.start()
  await new Promise((r) => setTimeout(r, 900))
  api.stop()
  return runs
}
const of = (runs, c) => runs.filter(([x]) => x === c).map(([, a]) => a)

test('a coin with no room left goes into a round cut into a few, and nothing received goes with it', async () => {
  const runs = await mounted({ needed: true, reasons: [{ rule: 'shape', coins: ['deep'], spread: true, max_fee_ppm: 0 }], give_up: [], kept_back: [] })
  assert.deepEqual(of(runs, 'settle_first'), [{ coins: ['deep'], spread: true, max_fee_ppm: 0 }])
  assert.deepEqual(of(runs, 'refresh_received'), [], 'what was received still pays at once: ' + runs.map(([c]) => c).join(','))
})

test('the received coins that go are those the library names, one of each asset kept back', async () => {
  const runs = await mounted({ needed: true, reasons: [{ rule: 'exposure' }], give_up: ['r1'], kept_back: ['r2'] })
  assert.deepEqual(of(runs, 'refresh_received'), [{ leaves: ['r1'] }])
})

test('nothing goes when the library keeps back every coin it named', async () => {
  const runs = await mounted({ needed: true, reasons: [{ rule: 'idle' }], give_up: [], kept_back: ['only'] })
  assert.deepEqual(of(runs, 'refresh_received'), [])
  assert.deepEqual(of(runs, 'settle_first'), [])
})

test('an older library (no `give_up`) is refreshed as before', async () => {
  const runs = await mounted({ needed: true, reasons: [{ rule: 'exposure' }] })
  assert.deepEqual(of(runs, 'refresh_received'), [{}])
})
