// A faucet payment to the receive code is taken in by a mailbox read, never a whole sync, so the
// wallet says Received within seconds of the faucet's answer (sequentia-faucet#25).
//   node --test faucet-take-in.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountLeaves, JOINED_KEY, CODE_KEY, TAKE_IN_MS } from './leaves.js'

const X = '750627c5778222a49fc785933f4636964f010092b460b9bd16bf8c424e14366f'
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function fakeWorker (answer) {
  const w = { posted: [] }
  w.postMessage = (m) => { w.posted.push(m); queueMicrotask(() => w.onmessage({ data: answer(m) })) }
  return w
}
// A joined wallet whose mailbox holds the faucet's coin from the `arrivesAt`-th read on.
async function wallet ({ arrivesAt = 1, clock = { t: 1_000_000 } } = {}) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const runs = []
  let reads = 0
  let held = 0n
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    runs.push(c)
    let result = []
    if (c === 'mailbox') {
      reads++
      result = reads === arrivesAt ? { accepted: [{ leaf_id: 'f1', asset: X, value: '500', kind: 'mailbox' }] } : { accepted: [] }
      if (reads === arrivesAt) held += 500n
    } else if (c === 'balance') result = { arca: { [X]: { live: String(held) } } }
    else if (c === 'schedule') result = { now: 1, due: false, next_sync_at: null }
    else if (c === 'care') result = { claims: [], planned: [], cancelled: [] }
    else if (c === 'sync') result = { mailbox: { accepted: [] }, schedule: { now: 1 } }
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const events = []
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)) }, onEvent: (n, d) => events.push([n, d]), tickMs: 3_600_000, mailboxPollMs: 3_600_000 }, null, null)
  await api.start()
  return { api, runs, events, store, clock }
}

test('the faucet\'s coin is taken in by a mailbox read, the balance read again, and no sync', async () => {
  const { api, runs, events, clock } = await wallet({ arrivesAt: 1 })
  const from = runs.length
  const since = clock.t
  const t0 = clock.t
  assert.equal(await api.takeIn({ asset: X.toUpperCase(), since }), true)
  const after = runs.slice(from)
  assert.deepEqual(after.slice(0, 2), ['mailbox', 'balance'], after.join(','))
  assert.ok(!after.includes('sync'), 'no sync: ' + after.join(','))
  assert.equal(clock.t - t0, 0, 'no wait when the first read finds it')
  assert.equal(api.leafAtoms(X), 500n)
  assert.ok(events.some((e) => e[0] === 'leafArrived' && e[1].asset === X))
  api.stop()
})

test('it reads again every two seconds until the coin is there', async () => {
  const { api, runs, clock } = await wallet({ arrivesAt: 3 })
  const from = runs.length
  const t0 = clock.t
  assert.equal(await api.takeIn({ asset: X, since: t0 }), true)
  assert.deepEqual(runs.slice(from).filter((c) => c === 'mailbox').length, 3)
  assert.equal(clock.t - t0, 4000)
  api.stop()
})

test('a coin some other read took in since the click counts, with no read of its own', async () => {
  const { api, runs, clock } = await wallet({ arrivesAt: 1 })
  const since = clock.t
  // The wallet's own sync (or the mailbox watch) took it in first.
  await api.takeIn({ asset: X, since: since - 1 })
  const from = runs.length
  assert.equal(await api.takeIn({ asset: X, since }), true)
  assert.ok(!runs.slice(from).includes('mailbox'))
  api.stop()
})

test('a coin that does not come in TAKE_IN_MS is left to the wallet: false, nothing else asked', async () => {
  const { api, runs, clock } = await wallet({ arrivesAt: 1e9 })
  const from = runs.length
  const t0 = clock.t
  assert.equal(await api.takeIn({ asset: X, since: t0 }), false)
  assert.ok(clock.t - t0 >= TAKE_IN_MS && clock.t - t0 < TAKE_IN_MS + 3000, String(clock.t - t0))
  assert.ok(runs.slice(from).every((c) => c === 'mailbox'), runs.slice(from).join(','))
  assert.equal(TAKE_IN_MS, 45_000)
  api.stop()
})

test('a paid receive code is forgotten, so the next one shown is new', async () => {
  const { api, store } = await wallet()
  store.setItem(CODE_KEY + '.t', JSON.stringify({ text: 'arca:00', owner: 'o1', until: 9e9 }))
  api.forgetCode('o2')
  assert.ok(store.getItem(CODE_KEY + '.t'), 'another owner\'s code is kept')
  api.forgetCode('o1')
  assert.equal(store.getItem(CODE_KEY + '.t'), null)
  api.stop()
})

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const i = html.indexOf('async function requestFaucet('); const body = html.slice(i, html.indexOf('\n}', i))
const leafPart = body.slice(body.indexOf("if(!devMode() && leavesApi"), body.indexOf('// Fund the NON-confidential'))

test('the page: the kept code at once, the coin taken in, never a sync, never the address because the faucet is busy', () => {
  assert.match(leafPart, /code=await leavesApi\.receiveCode\(\{quick\}\);/)
  assert.match(leafPart, /let code, j, quick=true;/)
  assert.ok(!/syncNow/.test(leafPart), 'no full sync on the faucet path')
  assert.match(leafPart, /const got=await leavesApi\.takeIn\(\{ asset: hex, since: asked \}\);/)
  assert.match(leafPart, /if\(got\) \$\('faucetStatus'\)\.textContent=DEFAULT_WORDS\.faucetReceived\(what\);/)
  assert.match(leafPart, /else \{ \$\('faucetStatus'\)\.textContent=DEFAULT_WORDS\.faucetOnItsWay\(what\); _faucetWaiting=\{ hex, what \}; \}/)
  // Busy: the faucet's own words, and no second try at the address.
  assert.match(leafPart, /if\(e\.alreadyPaid \|\| e\.reason==='busy'\)\{[^}]*textContent=e\.message; markFaucet\(\); return; \}/)
  // A kept code refused: a new one, once.
  assert.match(leafPart, /if\(quick && e\.status===400\)\{ leavesApi\.forgetCode\(code\.owner\); quick=false; continue; \}/)
  assert.match(leafPart, /leavesApi\.forgetCode\(code\.owner\); _recvCode=null;/)
  // The line says Received when a later read takes it in.
  assert.match(html, /try\{ faucetArrived\(data\); \}catch\{\}/)
  assert.match(html, /e\.status=r\.status; e\.reason=j\.reason\|\|null;/)
})
