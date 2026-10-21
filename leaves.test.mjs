// leaves.js: what the library's answers mean for the screens, and the worker client.
// The library itself is driven in a browser by tooling/leaves-drive.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { syncDecision, leafBalances, receiveAssets, faucetAssets, faucetRequestBody, railRows, heldCoins, inFlight, nextAskMs, when, exitSteps, LeafClient, LeafError,
  devModeOn, walletMode, setWalletMode, joinedOperator, MODE_KEY, LEGACY_DEV_MODE_KEY, MODE_WORDS } from './leaves.js'

const X = '75'.repeat(32)
const Y = '7f'.repeat(32)

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

test('the mode is user by default, and kept for each wallet', () => {
  const s = memStore()
  assert.equal(walletMode(s, 'aaaaaaaa'), 'user')
  assert.equal(devModeOn(s, 'aaaaaaaa'), false)
  setWalletMode(s, 'aaaaaaaa', 'developer')
  assert.equal(s.getItem(MODE_KEY + '.aaaaaaaa'), 'developer')
  assert.equal(devModeOn(s, 'aaaaaaaa'), true)
  assert.equal(walletMode(s, 'bbbbbbbb'), 'user', 'another wallet keeps its own mode')
  setWalletMode(s, 'aaaaaaaa', 'user')
  assert.equal(devModeOn(s, 'aaaaaaaa'), false)
  assert.throws(() => setWalletMode(s, 'aaaaaaaa', 'expert'), /'developer' or 'user'/)
  assert.equal(walletMode({ getItem () { throw new Error('blocked') } }, 'aaaaaaaa'), 'user', 'storage that throws reads as user mode')
  assert.equal(joinedOperator(s, 'aaaaaaaa'), false)
})

test('the one setting kept before modes were kept per wallet becomes the first reader\'s, once', () => {
  const s = memStore()
  s.setItem(LEGACY_DEV_MODE_KEY, '1')
  assert.equal(walletMode(s, 'cccccccc'), 'developer')
  assert.equal(s.getItem(LEGACY_DEV_MODE_KEY), null)
  assert.equal(walletMode(s, 'dddddddd'), 'user')
  assert.equal(walletMode(s, 'cccccccc'), 'developer')
})

test('the mode\'s words are the ones every Sequentia wallet uses', () => {
  assert.deepEqual({ ...MODE_WORDS }, {
    title: 'Mode',
    user: 'User mode',
    userLine: 'One figure per asset, and the wallet chooses how value moves.',
    developer: 'Developer mode',
    developerLine: 'Every rail by name, side by side (on-chain, leaves and Lightning), each with its balance and its manual controls, and the developer tools.',
    note: 'Kept for this wallet. Sites that ask the wallet for its mode follow it.',
  })
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
  for (const s of ['pending', 'sending', 'offered', 'given', 'forfeited', 'exiting']) assert.equal(inFlight([{ state: s }], []), true, s)
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

test('the page syncs when the time the schedule first gave arrives, though the schedule moves it on and is not due', () => {
  // A coin given to a refresh: every read says next_sync_at = now + 3600, due false.
  let d = syncDecision({ now: 1000, next_sync_at: 4600, due: false }, null, false)
  assert.deepEqual(d, { sync: false, why: null, held: 4600 })
  d = syncDecision({ now: 2000, next_sync_at: 5600, due: false }, d.held, false)
  assert.deepEqual(d, { sync: false, why: null, held: 4600 }, 'the time first given is held, not the one read now')
  d = syncDecision({ now: 4600, next_sync_at: 8200, due: false }, d.held, false)
  assert.deepEqual(d, { sync: true, why: 'time', held: null })
  assert.deepEqual(syncDecision({ now: 1, next_sync_at: 9, due: true }, 5, false), { sync: true, why: 'schedule', held: null })
  assert.deepEqual(syncDecision({ now: 1, next_sync_at: 9, due: false }, null, true), { sync: true, why: 'moving', held: null })
  assert.deepEqual(syncDecision({ now: 1, next_sync_at: null, due: false }, null, false), { sync: false, why: null, held: null })
})

test('a receive request offers the operator\'s assets, then other assets held in leaves', () => {
  const U = '2a'.repeat(32), E = 'e3'.repeat(32), T = 'c8'.repeat(32), Z = '5f'.repeat(32)
  const info = { server_info: { assets: [{ asset: U, min_leaf: '1000000' }, { asset: E, min_leaf: '1000000' }] } }
  // a fresh wallet: nothing held anywhere, the operator's assets are still offered
  assert.deepEqual(receiveAssets(info, leafBalances(null)), [U, E])
  // on-chain coins of an asset the operator does not serve are not offered; leaves of one are
  const held = leafBalances({ arca: { [Z]: { live: '5' } }, sequentia_onchain: { [T]: '100', [U]: '7' } })
  assert.deepEqual(receiveAssets(info, held), [U, E, Z])
  // the operator's list could not be read: every asset the leaf wallet holds, as before
  assert.deepEqual(receiveAssets({ server_info: { unreachable: 'timeout' } }, held).sort(), [T, U, Z].sort())
  assert.deepEqual(receiveAssets(null, leafBalances(null)), [])
})

test('the faucet is asked for the asset a request names, or one the operator serves, by its label', () => {
  const U = '2a'.repeat(32), E = 'e3'.repeat(32)
  const info = { server_info: { assets: [{ asset: U }, { asset: E }] } }
  assert.deepEqual(faucetAssets(info, U), [U])
  assert.deepEqual(faucetAssets(info, null), [U, E])
  assert.deepEqual(faucetAssets({ server_info: { unreachable: 'x' } }, null), [])
  assert.deepEqual(faucetRequestBody('request:7b22', 'USDX'), { request: 'request:7b22', asset: 'USDX' })
  // the Sequence token is the faucet's request with no asset named
  assert.deepEqual(faucetRequestBody('request:7b22', 'tSEQ'), { request: 'request:7b22' })
  assert.equal('address' in faucetRequestBody('request:7b22', 'EURX'), false)
})
