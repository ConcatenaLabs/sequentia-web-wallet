// leaves.js: what the library's answers mean for the screens, and the worker client.
// The library itself is driven in a browser by tooling/leaves-drive.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { issuerAssets, bondRefusal, BOND_WORDS, DECLINED_WORDS, supervisedAssets, frozenAtoms, frozenSentence, plainRefusal, servedPairs, careDue, careSummary, careArgs, releaseDone, plannedCoins, PLAN_EVERY_ROUND_LEAF, mountLeaves, CARE_EVERY_MS, JOINED_KEY, syncDecision, leafBalances, receiveAssets, faucetAssets, faucetRequestBody, railRows, heldCoins, inFlight, nextAskMs, when, exitSteps, LeafClient, LeafError,
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

test('care runs at the first chance, then at most every ten minutes', () => {
  assert.equal(CARE_EVERY_MS, 600_000)
  assert.equal(careDue(null, 5), true)
  assert.equal(careDue(1_000, 1_000 + 599_999), false)
  assert.equal(careDue(1_000, 1_000 + 600_000), true)
})

test('what care did, counted', () => {
  const v = { claims: [{ claim: 'd:0', leaf_id: 'l1', value: '5', taken_up: {} }, { claim: 'd:1', state: 'pending', note: 'not open' },
    { claim: 'd:2', leaf_id: 'l2', held: true, error: 'unreachable' }],
  planned: [{ coin: 'c1', plan_id: 'p1', fee: '0' }, { coin: 'c2', error: 'out_of_bounds' }],
  cancelled: [{ plan_id: 'p0', state: 'cancelled' }], refreshing: [{ coin: 'c3', participation: 'pp', state: 'pending' }, { coin: 'c4', error: 'fee' }],
  not_yet_planned: 3 }
  assert.deepEqual(careSummary(v), { taken: 1, held: 1, planned: 1, unplanned: 1, cancelled: 1, refreshing: 1, later: 3 })
  assert.deepEqual(careSummary(null), { taken: 0, held: 0, planned: 0, unplanned: 0, cancelled: 0, refreshing: 0, later: 0 })
})

test('a joined wallet in user mode runs care when it opens, with the kit\'s scan, and re-reads its balance after a claim', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let clock = 1_000_000
  const runs = []
  let changes = 0
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    runs.push(m.args.command === 'care' ? ['care', m.args.args] : m.args.command)
    const result = m.args.command === 'care'
      ? { claims: [{ claim: 'd:0', leaf_id: 'l1', value: '7', taken_up: { txid: 'x' } }], planned: [], cancelled: [], not_yet_planned: 0 }
      : m.args.command === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : m.args.command === 'balance' ? { arca: {} } : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const events = []
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    claimScan: () => 47, onChange: () => { changes++ }, onEvent: (n, d) => events.push([n, d]), tickMs: 3_600_000 }, null, null)
  await api.start()
  const care = runs.filter((r) => Array.isArray(r) && r[0] === 'care')
  assert.deepEqual(care, [['care', { plan_within: PLAN_EVERY_ROUND_LEAF, scan: 47 }]])
  // The claim taken up: the balance read again, and the page told.
  assert.ok(runs.lastIndexOf('balance') > runs.findIndex((r) => Array.isArray(r)), 'balance re-read after care')
  assert.ok(changes >= 2)
  assert.deepEqual(events.find((e) => e[0] === 'leafArrived'), ['leafArrived', { leaf_id: 'l1', value: '7', kind: 'claim' }])
  api.stop && api.stop()
})

test('care plans every leaf of a round: its arguments', () => {
  assert.equal(PLAN_EVERY_ROUND_LEAF, 4294967295)
  assert.deepEqual(careArgs(), { plan_within: 4294967295 })
  assert.deepEqual(careArgs(21), { plan_within: 4294967295, scan: 21 })
})

test('a release is done once no coin it gave up is still live or in its round', () => {
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'given' }], ['a']), false)
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'forfeited' }, { leaf_id: 'n', state: 'live' }], ['a']), false)
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'spent' }, { leaf_id: 'n', state: 'live' }], ['a']), true)
  assert.equal(releaseDone([], ['a']), true, 'a coin gone from the list is done with')
})

test('the planned coins are the current coins of open and stopped plans', () => {
  const m = plannedCoins([
    { plan_id: 'p1', state: 'open', coin: 'c1', steps: [{ state: 'waiting' }] },
    { plan_id: 'p2', state: 'open', coin: 'c2', steps: [{ state: 'done', leaf_id: 's1' }, { state: 'waiting' }] },
    { plan_id: 'p3', state: 'cancelled', coin: 'c3', steps: [] },
    { plan_id: 'p4', state: 'stopped', coin: 'c4', steps: [] },
  ])
  assert.deepEqual([...m.keys()].sort(), ['c1', 'c4', 's1'])
  assert.equal(m.get('s1').plan_id, 'p2')
})

test('a payment the planned coins cover is made through the next round, by itself', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let clock = 1_000_000
  const runs = []
  let sends = 0
  let synced = 0
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    runs.push(c === 'plan_release' ? ['plan_release', m.args.args] : c)
    if (c === 'send') {
      sends++
      if (sends === 1) return { id: m.id, ok: false, error: { kind: 'planned', asset: X, release: ['big'], message: 'refused: the wallet holds 0 of asset … in live coins' } }
      return { id: m.id, ok: true, value: { result: { transfer: 't1' }, start: {} } }
    }
    if (c === 'sync') synced++
    const result = c === 'coins' ? [{ leaf_id: 'big', state: synced >= 3 ? 'spent' : 'given' }, { leaf_id: 'new', state: synced >= 3 ? 'live' : 'pending' }]
      : c === 'plan_release' ? { plans: [{ coin: 'big', plan_id: 'p' }], participations: [{ state: 'pending' }] }
      : c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'care' ? { claims: [], planned: [], cancelled: [] }
      : c === 'balance' ? { arca: {} } : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    sleep: async (ms) => { clock += ms }, tickMs: 3_600_000 }, null, null)
  await api.start()
  const before = synced
  const v = await api.pay('send', { request: 'r', amount: '500000', asset: X })
  assert.deepEqual(v, { transfer: 't1' })
  assert.deepEqual(runs.find((r) => Array.isArray(r) && r[0] === 'plan_release'), ['plan_release', { leaves: ['big'] }])
  assert.equal(sends, 2, 'asked again once')
  assert.ok(synced - before >= 2, 'synced until the round freed the coin')
  assert.equal(api.state.releasing, null)
  // Any other refusal is the library's, untouched.
  const w2 = fakeWorker((m) => m.op === 'exists' ? { id: m.id, ok: true, value: true } : m.op === 'open' ? { id: m.id, ok: true, value: {} }
    : m.args.command === 'send' ? { id: m.id, ok: false, error: { kind: 'refused', message: 'refused: no' } }
      : { id: m.id, ok: true, value: { result: m.args.command === 'schedule' ? { now: 1 } : m.args.command === 'balance' ? {} : [], start: {} } })
  const api2 = mountLeaves({ makeWorker: () => w2, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock, tickMs: 3_600_000 }, null, null)
  await api2.start()
  await assert.rejects(api2.pay('send', { request: 'r' }), (e) => e.kind === 'refused' && e.message === 'refused: no')
  api.stop(); api2.stop()
})

test('a release that never frees its coins gives up in plain words, having paid nothing', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let clock = 1_000_000
  let sends = 0
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    if (c === 'send') { sends++; return { id: m.id, ok: false, error: { kind: 'planned', asset: X, release: ['big'], message: 'short' } } }
    const result = c === 'coins' ? [{ leaf_id: 'big', state: 'given' }] : c === 'schedule' ? { now: 1 } : c === 'balance' ? {} : c === 'care' ? {} : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    sleep: async (ms) => { clock += ms }, tickMs: 3_600_000 }, null, null)
  await api.start()
  await assert.rejects(api.pay('send', { request: 'r' }), /did not free the coins this payment needs in time; nothing was paid/)
  assert.equal(sends, 1)
  api.stop()
})

test('supervised assets are the ones the operator serves with a landing allowance', () => {
  const info = { server_info: { assets: [{ asset: X }, { asset: Y, supervised: { landing_allowance: '100' } }] } }
  assert.deepEqual(supervisedAssets(info), [Y])
  assert.deepEqual(supervisedAssets(null), [])
})

test('what is frozen counts frozen and paused leaves and frozen on-chain coins, nothing else', () => {
  const coins = [
    { leaf_id: 'a', asset: Y, value: '1000', state: 'live', frozen: { frozen: true, paused: false } },
    { leaf_id: 'b', asset: Y, value: '20', state: 'live', frozen: { frozen: false, paused: true } },
    { leaf_id: 'c', asset: Y, value: '300', state: 'live', frozen: { frozen: false, paused: false } },
    { leaf_id: 'd', asset: Y, value: '4000', state: 'spent', frozen: { frozen: true } },
    { leaf_id: 'e', asset: X, value: '5', state: 'live' },
  ]
  const m = frozenAtoms(coins, { sequentia_onchain_frozen: { [Y]: '700' } })
  assert.equal(m.get(Y), 1720n)
  assert.equal(m.get(X), undefined)
  assert.equal(frozenSentence('17.2', 'USDC.e'), "17.2 USDC.e is frozen by its issuer: it can't be sent until the issuer lifts the freeze.")
})

test('user mode says a frozen refusal plainly, and leaves every other refusal as it is', () => {
  const f = plainRefusal(new LeafError({ kind: 'server_refused', code: 'frozen', status: 409, message: 'the server refused cosign_transfer (409 frozen): …' }))
  assert.equal(f.message, 'This asset is frozen by its issuer for this wallet: nothing was sent.')
  const g = plainRefusal(new LeafError({ kind: 'refused', message: 'refused: the issuer has frozen this coin\'s landing' }))
  assert.match(g.message, /frozen by its issuer/)
  const o = new LeafError({ kind: 'refused', message: 'refused: no' })
  assert.equal(plainRefusal(o), o)
})

test('a payment the operator declines reads plainly in user mode and keeps its code', () => {
  const e = new LeafError({ kind: 'server_refused', code: 'declined', status: 422, message: 'the server refused cosign_transfer (422 declined): the signer: the signer declined: policy: …' })
  const p = plainRefusal(e)
  assert.equal(p.message, 'This payment was declined; nothing was sent.')
  assert.equal(p.message, DECLINED_WORDS)
  assert.equal(p.code, 'declined')
  assert.equal(p.status, 422)
  // An operator not reached is no refusal: said as it is.
  const u = new LeafError({ kind: 'unreachable', message: 'cosign_transfer: the server answered 503 signer_unavailable: …' })
  assert.equal(plainRefusal(u), u)
  for (const w of ['leaf', 'signer', 'operator', 'round', 'tree']) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(DECLINED_WORDS), w)
})

test('a pair with a supervised asset keeps only the in-tree swap', () => {
  const pairs = { chains: { g: { pairs: [
    { pay: X, receive: Y, sources: ['leaf-maker', 'covenant-round', 'leaf-resting'] },
    { pay: 'BTC', receive: Y, sources: ['btc-gateway'] },
    { pay: X, receive: 'BTC', sources: ['btc-gateway'] },
  ] } } }
  const s = servedPairs(pairs, [Y])
  assert.deepEqual(s.chains.g.pairs.map((p) => p.sources), [['leaf-maker'], [], ['btc-gateway']])
  assert.equal(servedPairs(pairs, []), pairs)
})

test('a refusal of the bond reads plainly in user mode', () => {
  for (const m of ['refused: the operator\'s bond is missing: it was seen bonded …', 'refused: the operator\'s bond is noticed …', 'refused: more than the bond\'s 5000000 …']) {
    const e = new LeafError({ kind: 'refused', message: m })
    assert.equal(bondRefusal(e), true)
    assert.equal(plainRefusal(e).message, BOND_WORDS.refused)
  }
  assert.equal(bondRefusal(new LeafError({ kind: 'refused', message: 'refused: no' })), false)
  for (const w of ['leaf', 'operator', 'round', 'tree']) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(BOND_WORDS.refused), w)
})

test('the bond is read and watched at care\'s pace, in either mode', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const runs = []
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    runs.push(m.args.command)
    const c = m.args.command
    const result = c === 'bond' ? { state: 'bonded', required: true } : c === 'watch_bond' ? { state: 'bonded', slashed: [], evidence: { lines: 2 } }
      : c === 'schedule' ? { now: 1 } : c === 'balance' ? {} : c === 'care' ? {} : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  await api.start()
  assert.ok(runs.indexOf('bond') > runs.indexOf('care') && runs.indexOf('watch_bond') > runs.indexOf('bond'), runs.join(' '))
  assert.equal(api.state.bond.state, 'bonded')
  assert.equal(api.state.lastWatch.value.evidence.lines, 2)
  api.stop()
})

test('a payment asked while the wallet keeps itself goes first: the bond\'s watch waits for it', async () => {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const runs = []
  let api, paid, releaseSend
  const answer = (m) => {
    const c = m.args.command
    const result = c === 'bond' ? { state: 'bonded' } : c === 'watch_bond' ? { state: 'bonded', slashed: [] }
      : c === 'schedule' ? { now: 1 } : c === 'balance' ? {} : c === 'care' ? {} : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  }
  const w = { posted: [] }
  w.postMessage = (m) => {
    w.posted.push(m)
    if (m.op === 'exists') return queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, value: true } }))
    if (m.op === 'open') return queueMicrotask(() => w.onmessage({ data: { id: m.id, ok: true, value: {} } }))
    const c = m.args.command
    runs.push(c)
    // The composer pays while care runs; the payment's answer takes its time.
    if (c === 'care') paid = api.pay('send', { request: 'r', amount: '1', asset: X })
    if (c === 'send') { releaseSend = () => w.onmessage({ data: { id: m.id, ok: true, value: { result: { transfer: 't' }, start: {} } } }); return }
    queueMicrotask(() => w.onmessage({ data: answer(m) }))
  }
  api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1, tickMs: 3_600_000 }, null, null)
  try {
    await api.start()
    assert.ok(runs.indexOf('care') > runs.indexOf('sync'), 'care after the opening sync: ' + runs.join(' '))
    assert.ok(runs.includes('send'), runs.join(' '))
    assert.ok(!runs.includes('watch_bond'), 'the watch waits while the payment is out: ' + runs.join(' '))
    releaseSend()
    assert.deepEqual(await paid, { transfer: 't' })
    for (let i = 0; i < 100 && !runs.includes('watch_bond'); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(runs.indexOf('watch_bond') > runs.indexOf('send'), 'then the watch: ' + runs.join(' '))
    assert.equal(api.state.lastWatch.value.state, 'bonded')
  } finally { api.stop() }
})

test('issuer-operated assets are the ones the operator serves with an issuer entry', () => {
  const info = { server_info: { assets: [{ asset: X, issuer: { limiter: 'l' } }, { asset: Y }] } }
  assert.deepEqual(issuerAssets(info), [X])
  assert.deepEqual(issuerAssets({}), [])
})

test('a leaf whose exit landed counts once: the library\'s held, less its on-chain coins', () => {
  // A 2,000,000 leaf exiting with its claim out (1,999,976 on the chain at the landing), 300,000 live.
  const b = leafBalances({ held: { [Y]: '2299976' }, arca: { [Y]: { exiting: '2000000', live: '300000' } }, sequentia_onchain: { [Y]: '1999976' } })
  assert.equal(b.get(Y).leaves, 300000n)
  assert.equal(b.get(Y).onchain, 1999976n)
  assert.deepEqual(b.get(Y).states, { exiting: 2000000n, live: 300000n }, 'developer mode still lists every state')
  const coins = [{ leaf_id: 'e', asset: Y, value: '2000000', state: 'exiting', note: 'claimed by f1fc…', frozen: { frozen: true } },
    { leaf_id: 'l', asset: Y, value: '300000', state: 'live', frozen: { frozen: true } }]
  assert.equal(frozenAtoms(coins, { sequentia_onchain_frozen: { [Y]: '1999976' } }).get(Y), 2299976n)
})

// The owner's 500,000 USDX that default mode never boarded: the leaf wallet reads its on-chain
// coins by a gap past the last key it handed out or saw holding an unspent coin, so a coin at a
// key past that (keys used and spent before it looked) is invisible to it. Default mode hands it
// keys until its window covers every key the page handed out, then boards what it now sees.
test('default mode: the leaf wallet is handed keys up to the page\'s receive index, then boards the coin there', async () => {
  const store = memStore()
  const G = 'ab'.repeat(32)
  let taken = 0
  const runs = []
  const w = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    runs.push(c)
    // The library's window: keys 0 .. taken+19. The coin sits at key 30.
    const sees = taken + 20 > 30
    const result = c === 'address' ? (taken++, { address: 'k' + (taken - 1) })
      : c === 'info' ? { operator: 'ee'.repeat(32), server_info: { assets: [{ asset: G, min_leaf: '1000' }] } }
      : c === 'schedule' ? { now: 1, due: false, next_sync_at: null }
      : c === 'balance' ? { arca: {}, sequentia_onchain: sees ? { [G]: '5000000' } : {} }
      : c === 'board_quote' ? { fee: { asset: G, amount: '84' } }
      : c === 'board' ? { value: m.args.args.amount }
      : c === 'care' ? { claims: [], planned: [], cancelled: [], not_yet_planned: 0 } : []
    return { id: m.id, ok: true, value: { result, start: {} } }
  })
  let clock = 1000
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    pinned: () => ({ server: 'https://op', node_url: 'https://node', operator: 'ee'.repeat(32) }), claimScan: () => 30 + 20, tickMs: 3_600_000 }, null, null)
  store.setItem('swk.leaves.joined.t', '1')
  try {
  await api.start()
  clock += 120_000
  api.boardSoon()
  await new Promise((r) => setTimeout(r, 3500))
  assert.equal(taken, 30, 'handed the keys up to the receive index')
  assert.ok(runs.lastIndexOf('address') < runs.indexOf('board'), 'keys first, then the board')
  assert.ok(runs.includes('board'), 'the coin now seen is boarded')
  // Once handed, not again.
  clock += 120_000
  api.boardSoon()
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(taken, 30)
  } finally { api.stop && api.stop() }
})
