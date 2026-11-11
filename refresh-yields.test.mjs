// Upkeep yields to the person (D95): what the wallet received is refreshed in a round only when that
// is needed now (a coin one payment short of the operator's limit, or past half of what the wallet
// may hold out of round) or once the person has left the wallet alone two minutes. Coins given up
// in a round are not spendable until it is final, so idle upkeep never takes them mid-trade.
//   node --test refresh-yields.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, refreshNeeded, JOINED_KEY, MODE_KEY, REFRESH_IDLE_MS } from './leaves.js'

const coin = (o) => ({ leaf_id: 'r1', asset: 'a', kind: 'transfer', state: 'live', value: '100', hops: 1, ...o })

test('a refresh is needed now only for a coin at the limit or past half of what the wallet may hold', () => {
  assert.equal(refreshNeeded([coin()], 5, null), null)
  assert.match(refreshNeeded([coin({ hops: 4 })], 5, null), /limit/)
  assert.equal(refreshNeeded([coin({ hops: 4, kind: 'batch' })], 5, null), null, 'a coin of a round needs no refresh to be paid on')
  assert.equal(refreshNeeded([], 5, { instant_budget: { value: '10', held_value: '9' } }), null, 'nothing received: nothing to refresh')
  assert.match(refreshNeeded([coin()], 5, { instant_budget: { value: '10', held_value: '6' } }), /half its instant budget/)
  assert.equal(refreshNeeded([coin()], 5, { instant_budget: { value: '10', held_value: '5' } }), null)
  const bond = (held) => ({ asset: 'b', value: '1000', out_of_round: [{ asset: 'b', value: String(held) }], instant_budget: null })
  assert.match(refreshNeeded([coin()], 5, bond(501)), /bond covers/)
  assert.equal(refreshNeeded([coin()], 5, bond(500)), null)
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

async function mounted ({ hops = 1 } = {}) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  store.setItem(MODE_KEY + '.t', 'user')
  const runs = []
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    runs.push(c)
    const result = c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'balance' ? { arca: { a: { live: '100' } } }
      : c === 'coins' ? [coin({ hops })]
      : c === 'info' ? { operator: 'ee'.repeat(32), server_info: { assets: [], depth_limit: 5 } }
      : c === 'bond' ? { asset: 'b', value: '1000', out_of_round: [{ asset: 'a', value: '100' }], instant_budget: null }
      : c === 'refresh_received' ? { refreshed: ['r1'] }
      : c === 'care' ? { claims: [], planned: [], cancelled: [], not_yet_planned: 0 }
      : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const clock = { t: 1000 }
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock.t,
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: 'ee'.repeat(32) }), tickMs: 3_600_000, mailboxPollMs: 3_600_000 }, null, null)
  await api.start()
  const turn = async (ms) => { clock.t += ms; api.boardSoon(); await new Promise((r) => setTimeout(r, 2600)) }
  return { api, runs, turn, clock }
}

test('a received coin waits while the person uses the wallet, and is refreshed once they leave it alone', async () => {
  const { api, runs, turn } = await mounted()
  try {
    // The person asks something every 30 s: no refresh.
    for (let i = 0; i < 4; i++) {
      await api.command('balance', {})
      await turn(30_000)
    }
    assert.equal(runs.filter((c) => c === 'refresh_received').length, 0, runs.join(','))
    // Left alone two minutes: refreshed.
    await turn(REFRESH_IDLE_MS + 1000)
    assert.equal(runs.filter((c) => c === 'refresh_received').length, 1, runs.join(','))
  } finally { api.stop() }
})

test('a coin one payment short of the limit is refreshed at once, the person busy or not', async () => {
  const { api, runs, turn } = await mounted({ hops: 4 })
  try {
    await api.command('balance', {})
    // The upkeep's own pause after a person's command (MAILBOX_QUIET_MS) still applies; the
    // refresh does not wait the two idle minutes.
    await turn(25_000)
    assert.equal(runs.filter((c) => c === 'refresh_received').length, 1, runs.join(','))
  } finally { api.stop() }
})
