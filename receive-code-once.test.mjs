// A receive code is paid once: the operator refuses a second payment to its key (409 key_reused).
// Receive kept showing a code that had been paid, while the page was closed or before its first
// read of the schedule (02/11/2026): every schedule read now says whether the kept code is still
// waiting, and the page shows a new one when it is not.
//
//   node --test receive-code-once.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountLeaves, codeOpen, JOINED_KEY, CODE_KEY, CODE_MARGIN_S } from './leaves.js'

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// A worker whose library lists `waiting()` as its unpaid receive requests, and hands out a new
// request, with a key of its own, on every `receive`.
function worker (waiting, handed) {
  const w = {}
  w.postMessage = (m) => {
    const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    if (m.op === 'exists') return reply(true)
    if (m.op === 'open') return reply({})
    const c = m.args.command
    let result = c === 'balance' ? { arca: {} } : c === 'info' ? {} : (c === 'sync' || c === 'care' || c === 'mailbox') ? {} : []
    if (c === 'schedule') result = { now: 1000, receive_requests: waiting().map((owner) => ({ owner, state: 'waiting', lapses_at: 1000 + 7 * 86_400 })) }
    if (c === 'receive') { const owner = 'k' + (++handed.n); result = { request: 'SQR1' + owner, details: { owner, until: 10_000_000 } } }
    reply({ result, start: {} })
  }
  return w
}

test('the schedule says whether a kept code is still open', () => {
  const kept = { owner: 'a', made: 100 }
  const s = (state, lapses_at = 1000 + 7 * 86_400) => ({ now: 1000, receive_requests: [{ owner: 'a', state, lapses_at }] })
  assert.equal(codeOpen(kept, s('waiting'), 200), true)
  assert.equal(codeOpen(kept, { now: 1000, receive_requests: [] }, 200), false, 'paid: it left the list')
  assert.equal(codeOpen(kept, s('lapsed'), 200), false)
  assert.equal(codeOpen(kept, s('waiting', 1000 + CODE_MARGIN_S), 200), false, 'too near its lapse')
  assert.equal(codeOpen(kept, s('waiting', null), 200), true, 'no lapse: waits until paid')
  assert.equal(codeOpen(kept, { now: 1000, receive_requests: [] }, 50), null, 'a list read before the code was handed out says nothing')
  assert.equal(codeOpen(kept, null, 200), null)
  assert.equal(codeOpen({ owner: 'a' }, { now: 1000, receive_requests: [] }, 1), false, 'a code kept before `made` is judged by any read')
})

test('a code paid while the page was closed is not shown again', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  // The code the page showed last time; it was paid since, so the library no longer waits for it.
  store.setItem(CODE_KEY + '.t', JSON.stringify({ text: 'SQR1old', owner: 'old', until: 10_000_000, made: 1 }))
  const handed = { n: 0 }, events = []
  let clock = 5000
  const api = mountLeaves({ makeWorker: () => worker(() => (handed.n ? ['k' + handed.n] : []), handed), store, walletTag: () => 't', mnemonic: () => 'abandon',
    el: () => ({}), now: () => clock, tickMs: 3_600_000, onEvent: (n, d) => events.push([n, d]) }, null, null)
  await api.start()
  assert.deepEqual(events.filter(([n]) => n === 'codeUsed'), [['codeUsed', { owner: 'old' }]], 'the page is told to draw Receive again')
  assert.equal(store.getItem(CODE_KEY + '.t'), null, 'the paid code is forgotten')
  // Receive asks for its code the quick way, as on a page just opened: a new one.
  clock += 10
  const c = await api.receiveCode({ quick: true })
  assert.equal(c.owner, 'k1')
  assert.notEqual(c.text, 'SQR1old')
  // Still waiting: the same code, at once and after the next read.
  assert.equal((await api.receiveCode({ quick: true })).owner, 'k1')
  clock += 10; await api.syncNow()
  assert.equal((await api.receiveCode({ quick: false })).owner, 'k1')
  assert.equal(events.filter(([n]) => n === 'codeUsed').length, 1, 'an open code is never dropped')
  api.stop()
})

test('a code paid while Receive is open is replaced at the next read', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const handed = { n: 0 }, paid = new Set(), events = []
  let clock = 5000
  const waiting = () => Array.from({ length: handed.n }, (_, i) => 'k' + (i + 1)).filter((k) => !paid.has(k))
  const api = mountLeaves({ makeWorker: () => worker(waiting, handed), store, walletTag: () => 't', mnemonic: () => 'abandon',
    el: () => ({}), now: () => clock, tickMs: 3_600_000, onEvent: (n, d) => events.push([n, d]) }, null, null)
  await api.start()
  clock += 10
  const c = await api.receiveCode({ quick: true })
  clock += 10; await api.syncNow()
  assert.equal((await api.receiveCode({ quick: true })).owner, c.owner, 'still waiting: the same code')
  // Paid from another wallet: the next read of the schedule no longer lists it.
  paid.add(c.owner)
  clock += 10; await api.syncNow()
  assert.deepEqual(events.filter(([n]) => n === 'codeUsed'), [['codeUsed', { owner: c.owner }]])
  const next = await api.receiveCode({ quick: true })
  assert.notEqual(next.owner, c.owner, 'Receive shows a new code')
  api.stop()
})

test('Receive draws a new code when the library says the shown one was used', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /onEvent: \(name, data\)=>\{ if\(name==='codeUsed'\)\{ _recvCode=null; _recvArk=null; _recvInv=null; _recvInvWatch\+\+; try\{ renderReceive\(\); \}catch\{\} \}/)
})
