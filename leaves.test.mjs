// leaves.js: what the library's answers mean for the screens, and the worker client.
// The library itself is driven in a browser by tooling/leaves-drive.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { leafBalances, railRows, heldCoins, inFlight, nextAskMs, when, exitSteps, LeafClient, LeafError,
  devModeOn, setDevMode, DEV_MODE_KEY } from './leaves.js'

const X = '75'.repeat(32)
const Y = '7f'.repeat(32)

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

test('developer mode is off by default, and one setting', () => {
  const s = memStore()
  assert.equal(devModeOn(s), false)
  setDevMode(s, true)
  assert.equal(s.getItem(DEV_MODE_KEY), '1')
  assert.equal(devModeOn(s), true)
  setDevMode(s, false)
  assert.equal(devModeOn(s), false)
  assert.equal(devModeOn({ getItem () { throw new Error('blocked') } }), false, 'storage that throws reads as off')
})

test('leaf balances add up every state, and keep on-chain apart', () => {
  const b = leafBalances({ arca: { [X]: { live: '2000000', 'operator-confirmed': '300000' } }, sequentia_onchain: { [X]: '7999970', [Y]: '5' } })
  assert.equal(b.get(X).leaves, 2300000n)
  assert.deepEqual(b.get(X).states, { live: 2000000n, 'operator-confirmed': 300000n })
  assert.equal(b.get(X).onchain, 7999970n)
  assert.equal(b.get(Y).leaves, 0n)
  assert.equal(b.get(Y).onchain, 5n)
  assert.equal(leafBalances(null).size, 0)
})

test('the rails table: BTC first and always, with no leaves; then assets by ticker; empty ones left out', () => {
  const balances = leafBalances({ arca: { [Y]: { live: '10' } }, sequentia_onchain: { [X]: '0' } })
  const ln = { BTC: 7n, [X]: 3n }
  const rows = railRows({ balances, btcOnchain: 0n, lnFor: (k) => ln[k] || 0n, tickerOf: (h) => (h === X ? 'AAA' : 'ZZZ') })
  assert.deepEqual(rows.map((r) => r.kind), ['BTC', X, Y])
  assert.equal(rows[0].leaves, null, 'a tree on Sequentia holds no BTC')
  assert.equal(rows[0].lightning, 7n)
  assert.equal(rows[1].lightning, 3n, 'an asset on Lightning alone still has its row')
  const fresh = railRows({ balances: new Map() })
  assert.deepEqual(fresh.map((r) => r.kind), ['BTC'], 'a fresh wallet shows one row, BTC at 0')
  assert.equal(fresh[0].onchain, 0n)
})

test('held coins and what sync must follow now', () => {
  const coins = [{ state: 'live' }, { state: 'spent' }, { state: 'exited' }, { state: 'lost' }, { state: 'given' }]
  assert.deepEqual(heldCoins(coins).map((c) => c.state), ['live', 'given'])
  assert.equal(inFlight([{ state: 'live' }], []), false)
  for (const s of ['pending', 'sending', 'given', 'forfeited', 'exiting']) assert.equal(inFlight([{ state: s }], []), true, s)
  assert.equal(inFlight([], [{ state: 'pending', released: false }]), true)
  assert.equal(inFlight([], [{ state: 'released', released: true }]), false)
  assert.equal(inFlight([], [{ state: 'void' }]), false)
})

test('the page asks on the schedule: now when due, at its time when near, otherwise on the next tick', () => {
  assert.equal(nextAskMs({ due: true, now: 100, next_sync_at: 50 }, 60000), 0)
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: 130 }, 60000), 30000)
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: 100 + 86400 }, 60000), 60000)
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: null }, 60000), 60000, 'nothing held: the tick')
  assert.equal(nextAskMs(null, 5000), 5000)
})

test('a median time for people', () => {
  assert.equal(when(1793579502), '2026-11-02 00:31:42 UTC')
  assert.equal(when(1793579502, 1793579502 - 2 * 86400 - 3600), '2026-11-02 00:31:42 UTC (in 2 d 1 h)')
  assert.equal(when(100, 100 + 7200 + 120), '1970-01-01 00:01:40 UTC (2 h 2 min ago)')
  assert.equal(when(null), '—')
})

test('the steps of an exit, with their fees', () => {
  const steps = exitSteps({ state: 'unrolling', broadcast: [
    { txid: 'aa', vsize: 258, fee: [{ asset: X, amount: '104' }] },
    { txid: 'bb', vsize: 234, fee: { asset: X, amount: 96 } },
    { txid: 'cc', vsize: 200 },
  ] })
  assert.deepEqual(steps.map((s) => [s.txid, s.vsize, s.fees.map((f) => f.amount)]), [['aa', 258, ['104']], ['bb', 234, ['96']], ['cc', 200, []]])
  assert.deepEqual(exitSteps({ state: 'waiting' }), [])
})

function fakeWorker (answer) {
  const w = { posted: [] }
  w.postMessage = (m) => { w.posted.push(m); queueMicrotask(() => w.onmessage({ data: answer(m) })) }
  return w
}

test('the worker client: answers by id, and a refusal in the library\'s words', async () => {
  const w = fakeWorker((m) => m.op === 'run' && m.args.command === 'send'
    ? { id: m.id, ok: false, error: { kind: 'server_refused', code: 'key_reused', status: 409, message: 'the server refused cosign_transfer (409 key_reused): an output\'s key already owns a leaf' } }
    : { id: m.id, ok: true, value: { result: { echo: m.args.command }, start: {} } })
  const c = new LeafClient(() => w)
  const [a, b] = await Promise.all([c.run('coins'), c.run('balance')])
  assert.deepEqual([a.result.echo, b.result.echo], ['coins', 'balance'])
  await assert.rejects(c.run('send', { request: 'x' }), (e) => e instanceof LeafError && e.kind === 'server_refused' && e.code === 'key_reused' &&
    e.status === 409 && e.message.startsWith('the server refused cosign_transfer'))
  assert.deepEqual(w.posted.map((m) => m.op), ['run', 'run', 'run'])
})

test('a worker that fails to start fails every call, saying so', async () => {
  const w = { postMessage () {} }
  const c = new LeafClient(() => w)
  const p = c.exists('abandon')
  w.onerror({ message: 'module not found' })
  await assert.rejects(p, /could not start: module not found/)
  await assert.rejects(c.run('coins'), /could not start/)
})
