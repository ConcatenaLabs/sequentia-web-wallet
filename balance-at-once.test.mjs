// What the Balance tab shows before the leaf library has opened (#392), and a payment the faucet
// says it made before the library has taken it in (#401).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, JOINED_KEY, BALANCE_KEY } from './leaves.js'

const X = '75'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// A worker whose library holds `held` of X, answering after `gate` resolves.
function worker (held, gate = Promise.resolve()) {
  const w = {}
  w.postMessage = (m) => {
    const reply = (value) => gate.then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    if (m.op === 'exists') return reply(true)
    if (m.op === 'open') return reply({})
    const c = m.args.command
    const result = c === 'balance' ? { arca: { [X]: { spendable: String(held()) } } } : c === 'schedule' ? { now: 1 } : c === 'info' ? {} : (c === 'sync' || c === 'care' || c === 'mailbox') ? {} : []
    reply({ result, start: {} })
  }
  return w
}

test('a reload shows the balance the library last gave this wallet until it gives one again', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let open; const gate = new Promise((r) => { open = r })
  const api = mountLeaves({ makeWorker: () => worker(() => 700n, gate), store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  assert.equal(api.leafAtoms(X), 0n, 'nothing kept yet: nothing shown')
  assert.equal(api.expected(), true, 'a joined wallet has a balance to read')
  const started = api.start(); open(); await started
  assert.equal(api.balanceRead(), true)
  assert.equal(api.leafAtoms(X), 700n)
  assert.ok(store.getItem(BALANCE_KEY + '.t'), 'the balance is kept for this wallet')
  api.stop()
  // The page reloads: the library has not answered yet, the figure is the kept one.
  const again = mountLeaves({ makeWorker: () => worker(() => 700n, new Promise(() => {})), store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  assert.equal(again.balanceRead(), false, 'the kept figure is not the library\'s answer')
  assert.equal(again.leafAtoms(X), 700n, 'the reload opens on the figure it closed on')
  assert.deepEqual(again.leafAssets(), [X])
  // Another wallet in this browser never shows it.
  const other = mountLeaves({ makeWorker: () => worker(() => 0n, new Promise(() => {})), store, walletTag: () => 'u', mnemonic: () => 'zoo', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  assert.equal(other.leafAtoms(X), 0n)
  assert.equal(other.expected(), false)
})

test('a payment the faucet made is arriving at once, and counted once when it lands', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let held = 0n, clock = 1000
  const api = mountLeaves({ makeWorker: () => worker(() => held), store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock, tickMs: 3_600_000 }, null, null)
  await api.start()
  api.expect(X, '500')
  assert.equal(api.leafAtoms(X), 500n, 'in the figure the moment the faucet says it paid')
  assert.equal(api.arriving(X), 500n, 'and said as arriving')
  assert.deepEqual(api.leafAssets(), [X], 'the asset has its row')
  held = 500n; await api.syncNow()
  assert.equal(api.leafAtoms(X), 500n, 'once the library holds it, it is counted once')
  api.expect(X, '20')
  clock += 121000
  assert.equal(api.leafAtoms(X), 500n, 'an expectation the library never met lapses after two minutes')
  api.expect('nothex', '5'); api.expect(X, '0')
  assert.equal(api.leafAtoms(X), 500n, 'nothing but an asset and an amount is expected')
  api.stop()
})
