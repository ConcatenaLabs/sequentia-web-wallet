// A payment a person waits on answers as soon as the library has sent it: the wallet's read of what
// it holds afterwards (balance, coins and the rest) follows the answer, in one shared look at the
// chain, instead of holding "Sent" behind a read per command (sequentia-web-wallet#541).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLeaves, JOINED_KEY } from './leaves.js'

const X = '75'.repeat(32)
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// A worker that logs every command it is asked, with its arguments, and answers each at once.
function worker (asked) {
  const w = {}
  w.postMessage = (m) => {
    const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    if (m.op === 'exists') return reply(true)
    if (m.op === 'open') return reply({})
    const c = m.args.command
    asked.push({ c, args: m.args.args || {} })
    const result = c === 'balance' ? { arca: { [X]: { spendable: '1000' } } } : c === 'schedule' ? { now: 1 }
      : c === 'send' ? { route: 'channel', sent: { asset: X, value: '5' } } : (c === 'info' || c === 'sync' || c === 'care' || c === 'mailbox') ? {} : []
    reply({ result, start: {} })
  }
  return w
}

test('a payment answers before the wallet reads itself again, and that read shares one look', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const asked = []
  const api = mountLeaves({ makeWorker: () => worker(asked), store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  await api.start()
  asked.length = 0
  const v = await api.payCode('code', 5n, X)
  assert.equal(v.route, 'channel')
  const at = asked.findIndex((a) => a.c === 'send')
  assert.ok(at >= 0, 'the payment was asked')
  assert.deepEqual(asked.slice(at + 1).map((a) => a.c), [], 'nothing more was read before the payment answered')
  // The read follows on its own, every command of it in the look the first made.
  for (let i = 0; i < 50 && !asked.some((a) => a.c === 'channels'); i++) await new Promise((r) => setTimeout(r, 10))
  const after = asked.slice(at + 1)
  assert.deepEqual(after.map((a) => a.c).slice(0, 6), ['balance', 'coins', 'participations', 'schedule', 'refusals', 'channels'])
  assert.ok(after.every((a) => a.args.shared_view === true), 'each read shares the look')
  assert.equal(api.leafAtoms(X), 1000n, 'and the figure is the library\'s again')
  api.stop()
})
