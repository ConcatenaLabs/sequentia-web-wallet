// btc-ark.js: routes, figures, the board's amount, and the composer's deps.btc on the ark,
// against a stand-in worker that answers as the wallet does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arkConfig, routeOf, destination, arkFigures, boardAmount, mountBtcArk, BOARD_MARGIN_SATS, BTC_WORDS, exitNoteOf, fmtBtc } from './btc-ark.js'
import { decodeBolt11 } from './bolt11.js'
import { forbiddenIn } from './user-trade.js'

// A testnet invoice for 20,000 sat (made by Bark on the testnet4 ark).
const LNTB = 'lntb200u1p4wy0ptsp58klvvgcchzulj3kzftnj037meh8577j75uy903fsyfsupg2ld0sspp5u7vlrjpcpe8z952smk9zn6wefcsz55em92upm0lwsuf26e4hp3gsdq5v3snxgrrdpjkx6eqd9hqxqy9gcqcqz9c9qyysgqhy747ysgx623vxwyt83t875mje9s6kqn4j6flq8f24emqkwy7afhqpw92v23vewqxk8mxulxwg2cr86qyact8tks56v76tlzy45ps3gp87tptd'
const ARK = 'tark1pnglpcr3zqqpqrp6tlztdfmchlyn76tqvxhg8xguspymp8hg4f0jf445aq3yz4p3zqypejs78mq2ctzc8rzmdcclka7j4fe273dlxs87ud70zv3kxdzvl9nq3ywvye'
const TB1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

test("default mode's BTC words say none of the words default mode never says", () => {
  const extra = ['ark', 'vtxo', 'board', 'offboard', 'sat', 'sats', 'round', 'node', 'room']
  for (const [k, v] of Object.entries(BTC_WORDS)) {
    const text = typeof v === 'function' ? v('0.0001', '0.00001') : v
    assert.deepEqual(forbiddenIn(text), [], k + ': ' + text)
    for (const w of extra) assert.ok(!new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(text), k + ' says ' + w)
  }
})

test('the page names its ark or none', () => {
  assert.deepEqual(arkConfig({ server: 'https://x.test/', esplora: 'https://x.test/testnet4/api', network: 'testnet4' }),
    { server: 'https://x.test', esplora: 'https://x.test/testnet4/api', network: 'testnet4' })
  assert.equal(arkConfig(null), null)
  assert.equal(arkConfig({ server: 'x', esplora: 'https://e', network: 'testnet4' }), null)
  assert.equal(arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet3' }), null)
})

test('a destination names its route', () => {
  assert.equal(routeOf(LNTB, decodeBolt11), 'invoice')
  assert.equal(routeOf('lightning:' + LNTB, decodeBolt11), 'invoice')
  assert.equal(routeOf(ARK, decodeBolt11), 'ark')
  assert.equal(routeOf(TB1, decodeBolt11), 'chain')
  assert.equal(routeOf('', decodeBolt11), null)
  assert.equal(routeOf('hello', decodeBolt11), null)
  assert.equal(routeOf('lntbgarbage', decodeBolt11), null)   // does not decode
  // The one receive code: BTC goes to its Ark address, else to its address.
  assert.deepEqual(destination(`bitcoin:${TB1}?ark=${ARK}&sequentia=x:00`, decodeBolt11), { route: 'ark', dest: ARK })
  assert.deepEqual(destination(`bitcoin:${TB1}?sequentia=x:00`, decodeBolt11), { route: 'chain', dest: TB1 })
  assert.equal(destination('bitcoin:' + TB1 + '?req-pj=x', decodeBolt11), null)
})

test('one figure: what the ark holds, spendable or on its way', () => {
  const f = arkFigures({ spendable: '9765', pending_board: '99670', claimable_lightning_receive: '0', pending_in_round: '10', total: '109445' })
  assert.deepEqual(f, { total: 109445n, spendable: 9765n, arriving: 99680n })
  assert.deepEqual(arkFigures(null), { total: 0n, spendable: 0n, arriving: 0n })
})

test('a board leaves the funding fee and the ark fee, and keeps to the ark bounds', () => {
  const info = { min_board_sat: '10000', max_vtxo_sat: '5000000' }
  // 200,000 sat in one coin: fee (10.75 + 68 + 43 -> 122 vB) x 2 = 244.
  assert.deepEqual(boardAmount([{ value: 200000, confirmed: true }], info, 330n), { amount: 199756n, chainFee: 244n, inputs: 1 })
  // Unconfirmed coins are not boarded.
  assert.equal(boardAmount([{ value: 200000, confirmed: false }], info, 330n), null)
  // Too little to clear the least board plus its fee and the margin.
  const least = 10000n + 330n + BOARD_MARGIN_SATS + 244n
  assert.equal(boardAmount([{ value: Number(least) - 1, confirmed: true }], info, 330n), null)
  assert.ok(boardAmount([{ value: Number(least), confirmed: true }], info, 330n))
  // More than one coin may hold: the most the ark takes.
  assert.equal(boardAmount([{ value: 9000000, confirmed: true }], info, 330n).amount, 5000000n)
})

// A stand-in worker: answers 'open' and each command from `answers`, recording what it was asked.
function standIn (answers) {
  const asked = []
  const w = {
    onmessage: null,
    postMessage ({ id, op, args }) {
      asked.push({ op, ...(args.command ? { command: args.command, args: args.args } : {}) })
      let value, error
      try { value = op === 'open' ? true : answers[args.command](args.args) } catch (e) { error = { message: e.message } }
      setTimeout(() => w.onmessage({ data: error ? { id, ok: false, error } : { id, ok: true, value } }), 0)
    },
    terminate () {},
  }
  return { w, asked }
}

const INFO = { network: 'testnet4', min_board_sat: '10000', max_vtxo_sat: '5000000', max_route_delay: 218 }

test('sends go where the destination says, priced by the wallet first', async () => {
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '50000', total: '50000' }),
    send_fee: () => ({ fee: '0' }),
    send: (a) => ({ sent: a.sats, fee: '0' }),
    pay_fee: () => ({ fee: '200', max_route_delay: 218 }),
    pay: (a) => ({ state: 'complete', preimage: 'ab'.repeat(32), max: a.max_fee_sats }),
    offboard_fee: () => ({ fee: '900' }),
    offboard: () => ({ txid: 'cd'.repeat(32) }),
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  assert.equal(ark.figures().spendable, 50000n)
  const a = await ark.send(ARK, 5000n)
  assert.equal(a.route, 'ark'); assert.equal(a.sent, '5000')
  const b = await ark.send(LNTB)
  assert.equal(b.route, 'invoice'); assert.equal(b.state, 'complete'); assert.equal(b.max, '200')   // the fee quoted is the most it may cost
  const c = await ark.send(TB1, 10000n)
  assert.equal(c.route, 'chain'); assert.equal(c.txid, 'cd'.repeat(32))
  // Too little in the ark: refused before anything is asked to move.
  const n = asked.filter((x) => x.command === 'send' || x.command === 'pay' || x.command === 'offboard').length
  await assert.rejects(ark.send(TB1, 60000n), /not enough here/)
  assert.equal(asked.filter((x) => x.command === 'send' || x.command === 'pay' || x.command === 'offboard').length, n)
  ark.close()
})

test("Max: what the ark can pay a destination, its fee taken off", async () => {
  const { w } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '50000', total: '50000' }),
    send_fee: () => ({ fee: '0' }),
    // A fee that grows with the amount: 1% plus 500.
    offboard_fee: (a) => ({ fee: String(Math.ceil(Number(a.sats) / 100) + 500) }),
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  try {
    assert.equal(await ark.max(ARK), 50000n)
    const m = await ark.max(TB1)
    const q = await ark.quote(TB1, m)
    assert.ok(!q.short, 'the most Max offers can be sent')
    assert.ok(50000n - m - q.fee < 2n, 'and nothing is left behind')
    // A code is paid at its Ark part; an invoice names its own amount.
    assert.equal(await ark.max('bitcoin:' + TB1 + '?ark=' + ARK), 50000n)
    assert.equal(await ark.max(LNTB), null)
  } finally { ark.close() }
})

test('a board: the server cosigns before the page signs and sends the funding', async () => {
  const order = []
  const { w } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '0', total: '0' }),
    board_address: (a) => { order.push('address'); return { address: 'tb1pboard', key_index: 7, expiry_height: 160000, fee: '330', asked: a.sats } },
    board_psbt: (a) => { order.push('cosign:' + a.psbt + ':' + a.key_index + ':' + a.expiry_height); return { funding_txid: 'ee'.repeat(32), amount: '199426' } },
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  const chain = {
    utxos: async () => [{ value: 200000n, confirmed: true }, { value: 5000n, confirmed: false }],
    buildUnsigned: async (address, sats) => { order.push('build:' + address + ':' + sats); return { psbtHex: '70736274ff', finish: () => { order.push('sign'); return { hex: '0200' } } } },
    broadcast: async (hex) => { order.push('broadcast:' + hex); return 'ee'.repeat(32) },
  }
  const r = await ark.board(chain)
  assert.equal(r.txid, 'ee'.repeat(32))
  assert.deepEqual(order, ['address', 'build:tb1pboard:199756', 'cosign:70736274ff:7:160000', 'sign', 'broadcast:0200'])
  // Nothing confirmed: nothing boarded.
  const none = await ark.board({ ...chain, utxos: async () => [{ value: 200000n, confirmed: false }] })
  assert.equal(none, null)
  ark.close()
})

test('a refused cosign signs nothing', async () => {
  let signed = false
  const { w } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '0', total: '0' }),
    board_address: () => ({ address: 'tb1pboard', key_index: 1, expiry_height: 1, fee: '330' }),
    board_psbt: () => { throw new Error('error requesting board cosign') },
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  await assert.rejects(ark.board({
    utxos: async () => [{ value: 200000n, confirmed: true }],
    buildUnsigned: async () => ({ psbtHex: '00', finish: () => { signed = true; return { hex: '00' } } }),
    broadcast: async () => { throw new Error('never') },
  }), /board cosign/)
  assert.equal(signed, false)
  ark.close()
})

test("the composer's deps.btc on the ark: pay within the ticket's fee and lock, statuses mapped", async () => {
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '30000', total: '30000' }),
    pay_fee: () => ({ fee: '125', max_route_delay: 218 }),
    pay: (a) => ({ state: 'complete', preimage: 'aa'.repeat(32) }),
    pay_status: () => ({ state: 'none' }),
    invoice: (a) => ({ invoice: LNTB, payment_hash: 'e799f1c8380e4e22d150dd8a29e9d94e202a533b2ab81dbfee8712ad66b70c51', expires_at: 1 }),
    receive_status: () => ({ state: 'paid', preimage: 'bb'.repeat(32) }),
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  assert.equal(ark.lightning(), null)   // not before the wallet is open
  await ark.open()
  const btc = ark.lightning()
  assert.equal(await btc.balance(), 30000n)
  assert.deepEqual(await btc.payRoute(LNTB), { fee: 125n, delay: 218 })
  const d = await btc.decode(LNTB)
  assert.equal(d.sats, 20000n)
  assert.deepEqual(await btc.pay({ invoice: LNTB, maxFeeSats: 125n, maxDelay: 224 }), { state: 'complete', preimage: 'aa'.repeat(32) })
  const p = asked.find((x) => x.command === 'pay')
  assert.deepEqual(p.args, { invoice: LNTB, max_fee_sats: '125', max_delay: 224, wait: true })
  assert.deepEqual(await btc.payStatus('00'), { state: 'none' })
  assert.deepEqual(await btc.invoiceStatus('00'), { status: 'paid', preimage: 'bb'.repeat(32) })
  ark.close()
})

test("a store made before another device boarded takes in the phrase's coins from the server at open", async () => {
  let held = '0'
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: held, total: held }),
    // The server's recovery mailbox holds a coin another wallet of the phrase boarded.
    catch_up: () => { held = '299426'; return { recovered: ['ab'.repeat(32) + ':0'], recovered_sat: '299426', spent_elsewhere: [], failed: [], complete: true } },
  })
  const changes = []
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }),
    decode: decodeBolt11, onChange: (f) => changes.push(f.spendable) })
  await ark.open()
  assert.equal(ark.figures().spendable, 0n, 'the store alone knows nothing of it')
  for (let i = 0; i < 20 && ark.figures().spendable === 0n; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(ark.figures().spendable, 299426n, 'the figure shows the coin once the server is asked')
  assert.deepEqual(asked.filter((x) => x.command).map((x) => x.command).slice(0, 4), ['info', 'balance', 'catch_up', 'balance'])
  assert.deepEqual(changes, [299426n])
  ark.close()
})

test('a wallet whose package has no catch_up opens as before', async () => {
  const { w } = standIn({ info: () => INFO, balance: () => ({ spendable: '7', total: '7' }) })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ark.figures().spendable, 7n)
  ark.close()
})

// A coin of the Bitcoin ark left past its expiry is swept by the server, which takes it in a round
// later only by its own choice: the wallet renews the coins that are due by itself, at open and
// after each sync. (This stand-in has
// no schedule_refreshes, as a package built before it: the refresh runs all the same.)
test('the coins near their expiry are renewed by the wallet itself: at open, and once at a time', async () => {
  let due = 2
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '1000', total: '1000' }),
    catch_up: () => ({ recovered: [], recovered_sat: '0', spent_elsewhere: [], failed: [], complete: true }),
    refresh: () => { const n = due; due = 0; return { refreshed: n } },
  })
  const logs = []
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11, log: (...a) => logs.push(a.join(' ')) })
  await ark.open()
  for (let i = 0; i < 40 && !asked.some((x) => x.command === 'refresh'); i++) await new Promise((r) => setTimeout(r, 5))
  const order = asked.filter((x) => x.command).map((x) => x.command)
  assert.ok(order.indexOf('refresh') > order.indexOf('catch_up'), 'renewed after the catch-up at open: ' + order.join(','))
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(logs.some((l) => /renewed 2 coin\(s\) near their expiry/.test(l)), logs.join(' | '))
  // Two asks at once: one refresh.
  const before = asked.filter((x) => x.command === 'refresh').length
  await Promise.all([ark.renewDue(), ark.renewDue()])
  assert.equal(asked.filter((x) => x.command === 'refresh').length, before + 1)
  ark.close()
})

// The renewal of each coin is scheduled with the server, so it runs with the page closed: at open
// (and after each sync), before the wallet's own refresh of what is due and not scheduled.
test('a renewal the server runs by itself is scheduled for each coin, before the refresh', async (t) => {
  let fresh = 3
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '1000', total: '1000' }),
    catch_up: () => ({ recovered: [], recovered_sat: '0', spent_elsewhere: [], failed: [], complete: true }),
    schedule_refreshes: () => { const n = fresh; fresh = 0; return { scheduled: n ? [{ height: 1944, vtxos: ['a', 'b'], amount: '700' }, { height: 2001, vtxos: ['c'], amount: '300' }] : [] } },
    refresh: () => ({ refreshed: 0 }),
  })
  const logs = []
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11, log: (...a) => logs.push(a.join(' ')) })
  t.after(() => ark.close())
  await ark.open()
  for (let i = 0; i < 40 && !asked.some((x) => x.command === 'refresh'); i++) await new Promise((r) => setTimeout(r, 5))
  const order = asked.filter((x) => x.command).map((x) => x.command)
  assert.ok(order.indexOf('schedule_refreshes') > order.indexOf('catch_up'), order.join(','))
  assert.ok(order.indexOf('refresh') > order.indexOf('schedule_refreshes'), order.join(','))
  assert.ok(logs.some((l) => /renewal scheduled for 3 coin\(s\), heights 1944,2001/.test(l)), logs.join(' | '))
  // Nothing new to schedule: nothing logged, the refresh still asked.
  const count = (c) => asked.filter((x) => x.command === c).length
  await ark.renewDue()   // the pass at open, if it is still running
  const s0 = count('schedule_refreshes'), r0 = count('refresh'), n = logs.length
  await ark.renewDue()
  assert.equal(count('schedule_refreshes'), s0 + 1)
  assert.equal(count('refresh'), r0 + 1)
  assert.ok(!logs.slice(n).some((l) => /renewal scheduled/.test(l)))
})

// #376: a payment the payee holds read "Paid" at once, and stayed so when it came back.
test('an invoice the payee holds is pending until they take it, and comes back when they do not', async () => {
  const states = { pay: 'pending', status: ['pending', 'pending', 'none'] }
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '50000', total: '50000' }),
    pay_fee: () => ({ fee: '77', max_route_delay: 218 }),
    pay: () => ({ state: states.pay, fee: '77', amount: '500' }),
    pay_status: (a) => ({ state: states.status.shift() || 'none', hash: a.hash }),
  })
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  await ark.open()
  const r = await ark.send(LNTB)
  assert.equal(r.state, 'pending', 'held by the payee: not paid')
  assert.match(r.hash, /^[0-9a-f]{64}$/)
  const out = await ark.payOutcome(r.hash, { everyMs: 1 })
  assert.equal(out.state, 'came-back')
  assert.equal(asked.filter((x) => x.command === 'pay_status').length, 3)
  assert.ok(asked.filter((x) => x.command === 'pay_status').every((x) => x.args.drive === true && x.args.hash === r.hash))
  states.status = ['pending', 'complete']
  const done = await ark.payOutcome(r.hash, { everyMs: 1 })
  assert.equal(done.state, 'complete')
  assert.deepEqual(forbiddenIn(BTC_WORDS.payWaiting), [])
  assert.deepEqual(forbiddenIn(BTC_WORDS.payCameBack), [])
  ark.close()
})

// #501: a coin leaves the ark alone only by the wallet's one rule (exit_auto), and default mode
// says what happened and what it cost, in its own words.
test('what default mode says about BTC leaving alone', () => {
  assert.equal(exitNoteOf({ action: 'none', ark: 'answering', progress: null }), null)
  assert.equal(exitNoteOf({ action: 'none', ark: 'unreachable', not_worth: [] }), null)
  assert.equal(fmtBtc(209340n), '0.0020934')
  assert.equal(fmtBtc(100000000n), '1')
  const started = exitNoteOf({ action: 'started', ark: 'unreachable', started: { amount: '209340', cost: '8695' }, progress: { pending: 3 } })
  assert.equal(started.kind, 'started')
  assert.equal(started.text, BTC_WORDS.exitStarted('0.0020934', '0.00008695'))
  assert.equal(exitNoteOf({ action: 'none', ark: 'unreachable', progress: { pending: 1, exits: [{ state: 'waiting_out_its_delay' }] } }, { pendingSats: 98250n }).text, BTC_WORDS.exitMoving('0.0009825'))
  // Before the wallet counts it as leaving, the amount the start priced is said.
  assert.equal(exitNoteOf({ action: 'none', ark: 'unreachable', progress: { exits: [{ state: 'on_its_way' }] } }, { lastAmount: '159840' }).text, BTC_WORDS.exitMoving('0.0015984'))
  // A claim already sent is not 'moving': what arrived is said instead.
  assert.equal(exitNoteOf({ action: 'none', ark: 'unreachable', progress: { pending: 1, exits: [{ state: 'claiming' }] } }, { pendingSats: 98250n }), null)
  const arrived = exitNoteOf({ action: 'none', ark: 'unreachable', progress: { pending: 0, claimed: { amount: '98250' } } }, { lastCost: '8695' })
  assert.equal(arrived.kind, 'arrived'); assert.match(arrived.text, /0\.0009825 BTC arrived at your Bitcoin address.*about 0\.00008695 BTC/)
  const needs = exitNoteOf({ action: 'cannot_start', ark: 'refused', amount: '99670', needed: '1382', available: '0' })
  assert.equal(needs.text, BTC_WORDS.exitNeedsFees('0.0009967', '0.00001382'))
  const small = exitNoteOf({ action: 'none', ark: 'unreachable', not_worth: [{ amount: '2000' }] })
  assert.equal(small.text, BTC_WORDS.exitNotWorth('0.00002'))
  // While the ark answers, a coin too small to leave alone says nothing.
  assert.equal(exitNoteOf({ action: 'none', ark: 'answering', not_worth: [{ amount: '2000' }] }), null)
})

test('the wallet asks its one rule at open and holds what arrives at the address while a coin leaves', async (t) => {
  const { w, asked } = standIn({
    info: () => INFO,
    balance: () => ({ spendable: '0', pending_exit: '209340', total: '209340' }),
    catch_up: () => ({ recovered: [], recovered_sat: '0', spent_elsewhere: [], failed: [], complete: true }),
    schedule_refreshes: () => { throw new Error('the server cannot be reached') },
    refresh: () => { throw new Error('the server cannot be reached') },
    exit_auto: () => ({ action: 'started', ark: 'unreachable', not_worth: [], started: { started: ['a:0'], amount: '209340', cost: '8695' }, progress: { pending: 1 } }),
    exit_estimate: () => ({ coins: [] }),
  })
  const kept = new Map()
  const ark = mountBtcArk({ makeWorker: () => w, mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11,
    store: { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, v) } })
  t.after(() => ark.close())
  await ark.open()
  for (let i = 0; i < 60 && !ark.exitNote(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(asked.some((x) => x.command === 'exit_auto'))
  assert.equal(ark.exitNote(), BTC_WORDS.exitStarted('0.0020934', '0.00008695'))
  assert.equal(ark.exitHolds(), true)
  assert.equal(kept.get('btcArk.exitCost'), '8695')
  // Asked again at once: not before its time.
  const n = asked.filter((x) => x.command === 'exit_auto').length
  await ark.exitCheck()
  assert.equal(asked.filter((x) => x.command === 'exit_auto').length, n)
})
