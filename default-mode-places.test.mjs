// Default mode on ordinary coins (docs/DEFAULT_MODE.md, Balance, Trade, History): the figure is
// what the wallet can trade or send now, read from the library's `coin_places`; what is not yet the
// wallet's is in History alone; no channel is opened, named or kept; a settled trade can be undone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careArgs, arrivingByAsset, arrivingCoins, channelsToClose, instantLimitArgs, DEFAULT_INSTANT_LIMIT, refreshLeaves, requireExitArgs, exitSwitch, EXIT_SEEN_KEY } from './leaves.js'
import { arrivingRows, arrivingCause, boardMinutes, roundMinutes, causeWhen, statedSeconds, DEFAULT_WORDS } from './default-arca.js'
import { tradeRows } from './instant-history.js'
import { tradeStateWord, USER_WORDS, undoneOf } from './user-trade.js'
import { mountLeaves, JOINED_KEY, setWalletMode, returnClaims } from './leaves.js'

const X = '75'.repeat(32)
const Y = '7f'.repeat(32)

const places = { coins: [
  { leaf_id: 'a1', asset: X, value: '400000', state: 'live', place: 'counted' },
  { leaf_id: 'a2', asset: X, value: '1500000', state: 'live', place: 'arriving' },
  { leaf_id: 'a3', asset: Y, value: '700', state: 'pending', place: 'arriving' },
  { leaf_id: 'a4', asset: X, value: '900', state: 'exiting', place: 'arriving' },
  { leaf_id: 'a5', asset: Y, value: '5000', state: 'live', place: 'proceeds' },
  { leaf_id: 'a6', asset: Y, value: '8000', state: 'given', place: 'settled' },
] }

test('the instant limit is 500 dollars in default mode and none in developer mode', () => {
  assert.equal(DEFAULT_INSTANT_LIMIT, '50000000000', '500 dollars in atoms of a hundred-millionth of a dollar')
  assert.deepEqual(instantLimitArgs(false), { value: '50000000000' })
  assert.deepEqual(instantLimitArgs(true), { value: 'off' })
})

test('what is arriving, by asset: arriving coins, pending ones and those coming back; nothing else', () => {
  const m = arrivingByAsset(places)
  assert.equal(m.get(X), 1_500_900n)
  assert.equal(m.get(Y), 700n)
  assert.deepEqual(arrivingCoins(places).map((c) => c.leaf_id), ['a2', 'a3', 'a4'])
  assert.equal(arrivingByAsset(null).size, 0, 'a library without coin_places takes nothing out')
})

test('History rows for what is arriving: one each, a coming-back one in days, none a received row shows', () => {
  const rows = arrivingRows(arrivingCoins(places), ['a3'])
  assert.deepEqual(rows.map((r) => [r.leaf, r.kind, r.when]), [
    ['a2', 'arriving', DEFAULT_WORDS.arrivingSoon], ['a4', 'coming_back', DEFAULT_WORDS.comingBackWhen]])
  assert.equal(DEFAULT_WORDS.takingLonger.includes('longer'), true)
  assert.equal(DEFAULT_WORDS.arrivingSoon, 'about a minute')
  const shown = [DEFAULT_WORDS.rowArriving, DEFAULT_WORDS.rowComingBack, DEFAULT_WORDS.arrivingSoon, DEFAULT_WORDS.comingBackWhen,
    USER_WORDS.undone].join(' ')
  for (const w of ['limit', 'round', 'coin', 'channel', 'leaf', 'rail']) assert.ok(!new RegExp('\\b' + w).test(shown), `no "${w}" in what default mode says`)
})

test('default mode opens no channel and closes the live ones; developer mode keeps them', () => {
  assert.deepEqual(careArgs(21, false, ['a'], false), { channels: false, scan: 21 })
  assert.deepEqual(careArgs(21, false, ['a'], true), { channels: true, scan: 21, no_open: ['a'] })
  const chans = [{ leaf_id: 'c1', coin_state: 'live' }, { leaf_id: 'c2', coin_state: 'given' }, { leaf_id: null, coin_state: 'live' }]
  assert.deepEqual(channelsToClose(chans), ['c1'])
})

test('a settled trade is undone the moment the library says it is dead, however late, and says so again once back', () => {
  const ticket = { payAsset: X, receiveAsset: Y, amountIn: '300000', amountOut: '400000', fees: [] }
  const settled = { id: 't', ticket, state: 'settled', settledAt: 1, sentAt: 1, swap: 's' }
  assert.equal(undoneOf(settled, 'done'), null, 'a swap done is left as it is')
  const dead = undoneOf(settled, 'returning')
  assert.equal(dead.state, 'undone')
  assert.equal(dead.undoneBack, false)
  assert.equal(tradeStateWord(dead), USER_WORDS.undone)
  assert.match(USER_WORDS.undone, /coming back to you, within about two days/)
  // The row: what was paid, coming back; what it was to bring is gone from it.
  assert.deepEqual(tradeRows([dead])[0].legs, [{ asset: X, atoms: '-300000' }])
  assert.equal(undoneOf(dead, 'returning'), null, 'nothing changes while it comes back')
  const back = undoneOf(dead, 'returned')
  assert.equal(back.undoneBack, true)
  assert.equal(tradeStateWord(back), USER_WORDS.undoneBack)
  assert.deepEqual(tradeRows([back])[0].legs, [], 'home: nothing moved')
  assert.equal(undoneOf({ ...settled, settledAt: 1 }, 'returned').state, 'undone', 'found home at once, months later: undone and back')
  // The library's return says when the coin can be claimed home: the row states those hours.
  const t = 1_800_000_000_000
  const timed = undoneOf(settled, 'returning', { claim_from: String(t / 1000 + 5 * 3600) })
  assert.equal(tradeStateWord(timed, t), USER_WORDS.undoneWithin(6))
  assert.match(USER_WORDS.undoneWithin(6), /within about 6 hours/)
})

test('each arriving line states the time true for its cause, and says once it is past it', () => {
  assert.equal(arrivingCause({ state: 'live' }), 'round')
  assert.equal(arrivingCause({ state: 'pending', kind: 'board' }), 'board')
  assert.equal(arrivingCause({ deposit: true }), 'board')
  assert.equal(arrivingCause({ state: 'exiting' }), 'return')
  assert.equal(boardMinutes(0), 5, 'a board final at certification: about five minutes')
  assert.equal(boardMinutes(2), 25, 'two Bitcoin blocks of burial')
  const coins = [{ leaf_id: 'r', asset: X, atoms: 1n, state: 'live' }, { leaf_id: 'b', asset: X, atoms: 2n, state: 'pending', kind: 'board' },
    { leaf_id: 'e', asset: X, atoms: 3n, state: 'exiting' }, { leaf_id: 'chain:t:0', asset: X, atoms: 4n, deposit: true }]
  const t0 = 1_000_000
  const fresh = arrivingRows(coins, [], { firstSeen: { r: t0, b: t0, e: t0, 'chain:t:0': t0 }, nowMs: t0 + 60_000, boardMin: 25 })
  assert.deepEqual(fresh.map((r) => r.when), [DEFAULT_WORDS.arrivingSoon, DEFAULT_WORDS.boardWhen(25), DEFAULT_WORDS.comingBackWhen, DEFAULT_WORDS.boardWhen(25)])
  assert.equal(DEFAULT_WORDS.boardWhen(25), 'usually within 25 minutes')
  const later = arrivingRows(coins, [], { firstSeen: { r: t0, b: t0, e: t0, 'chain:t:0': t0 }, nowMs: t0 + statedSeconds('board', 25) * 1000 + 1, boardMin: 25 })
  assert.deepEqual(later.map((r) => r.late), [true, true, false, true], 'past its time: a round after three minutes, a board after its minutes')
  assert.equal(later[0].when, DEFAULT_WORDS.takingLonger)
})

// The figure, coin by coin, as the wallet builds it from the library: balance.held (less its own
// coins on the chain) less every coin coin_places places as arriving.
function figureWorker (balance, places) {
  const w = {}
  w.postMessage = (m) => {
    const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    if (m.op === 'exists') return reply(true)
    if (m.op === 'open') return reply({})
    const c = m.args.command
    const result = c === 'balance' ? balance : c === 'coin_places' ? places : c === 'schedule' ? { now: 1 } : c === 'info' ? {}
      : (c === 'sync' || c === 'care' || c === 'mailbox' || c === 'instant_limit') ? {} : []
    reply({ result, start: {} })
  }
  return w
}
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

test('the figure is held less what is arriving, coin by coin; developer mode shows all of it', async () => {
  // X: 400 counted, 1,500 past the limit, 800 settled and given to the wallet's own refresh, 900
  // coming home, a channel whose side is 300; 50 of X on the chain at the wallet's keys.
  const balance = { held: { [X]: String(400 + 1500 + 800 + 900 + 300 + 50), [Y]: '5000' }, sequentia_onchain: { [X]: '50' },
    arca: { [X]: { live: '2200', given: '800', exiting: '900' }, [Y]: { live: '5000' } } }
  const places = { coins: [
    { leaf_id: 'c', asset: X, value: '400', state: 'live', place: 'counted', kind: 'transfer' },
    { leaf_id: 'a', asset: X, value: '1500', state: 'live', place: 'arriving', kind: 'transfer' },
    { leaf_id: 'g', asset: X, value: '800', state: 'given', place: 'settled', kind: 'batch' },
    { leaf_id: 'e', asset: X, value: '900', state: 'exiting', place: 'arriving', kind: 'transfer' },
    { leaf_id: 'ch', asset: X, value: '300', state: 'live', place: 'arriving', kind: 'batch', channel: true },
    { leaf_id: 'p', asset: Y, value: '5000', state: 'live', place: 'proceeds', kind: 'transfer' },
  ] }
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const api = mountLeaves({ makeWorker: () => figureWorker(balance, places), store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}),
    now: () => 1000, tickMs: 3_600_000 }, null, null)
  await api.start()
  await api.syncNow()
  assert.equal(api.leafAtoms(X), 1200n, '400 counted and 800 being refreshed: what the wallet can trade or send, its own refresh included')
  assert.equal(api.leafAtoms(Y), 5000n, 'what a trade brought is in the figure')
  assert.equal(api.arriving(X), 0n, 'nothing of the figure is arriving')
  assert.deepEqual(api.arrivingPayments().map((a) => [a.leaf_id, a.atoms]), [['a', 1500n], ['e', 900n], ['ch', 300n]])
  setWalletMode(store, 't', 'developer')
  assert.equal(api.leafAtoms(X), 3900n, 'developer mode: everything held')
  api.stop()
})

test('the arriving rule refreshes the arriving coins alone; any other rule, every received coin', () => {
  assert.deepEqual(refreshLeaves({ needed: true, reasons: [{ rule: 'arriving', coins: ['a2', 'a3'] }] }), ['a2', 'a3'])
  assert.equal(refreshLeaves({ needed: true, reasons: [{ rule: 'arriving', coins: ['a2'] }, { rule: 'idle' }] }), null)
  assert.equal(refreshLeaves({ needed: true, reasons: [{ rule: 'exposure' }] }), null)
  assert.equal(refreshLeaves(null), null)
})

test('a channel the wallet is closing is coming back, at its side alone, in about a minute', () => {
  const p = { coins: [{ leaf_id: 'ch', asset: X, value: '3400000', state: 'live', place: 'arriving', channel: true }] }
  const rows = arrivingRows(arrivingCoins(p))
  assert.deepEqual(rows.map((r) => [r.kind, r.atoms, r.when]), [['coming_back', 3_400_000n, DEFAULT_WORDS.arrivingSoon]])
})

test('a payment while the wallet\'s own refresh is in a round waits for that round, then goes ahead by itself', async () => {
  let roundDone = false
  const sent = []
  const w = {}
  w.postMessage = (m) => {
    const ok = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    const no = (error) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: false, error } }))
    if (m.op === 'exists') return ok(true)
    if (m.op === 'open') return ok({})
    const c = m.args.command
    if (c === 'send') {
      sent.push(roundDone)
      if (!roundDone) return no({ kind: 'refused', message: 'the wallet holds 0 of asset X in live coins' })
      return ok({ result: { sent: { asset: X, value: '5' } }, start: {} })
    }
    // A sync after the payment was refused: the round is final by then.
    if (c === 'sync') { if (sent.length) roundDone = true; return ok({ result: {}, start: {} }) }
    const coins = roundDone ? [{ leaf_id: 'g', asset: X, value: '900', state: 'spent' }, { leaf_id: 'n', asset: X, value: '900', state: 'live' }]
      : [{ leaf_id: 'g', asset: X, value: '900', state: 'forfeited' }]
    const result = c === 'coins' ? coins : c === 'balance' ? { held: { [X]: '900' } } : c === 'schedule' ? { now: 1 } : c === 'info' ? {}
      : (c === 'care' || c === 'mailbox' || c === 'instant_limit') ? {} : []
    return ok({ result, start: {} })
  }
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1000,
    tickMs: 3_600_000, sleep: () => Promise.resolve() }, null, null)
  await api.start()
  const seen = []
  const v = await api.command('send', { request: 'request:00', amount: '5', asset: X }, { onWait: () => {} })
    .finally(() => { seen.push(api.releasing()) })
  assert.deepEqual(sent, [false, true], 'refused once while the refresh was in its round, then asked again after it')
  assert.deepEqual(v.sent, { asset: X, value: '5' })
  assert.equal(api.releasing(), null)
  api.stop()
})

test('a round\'s time follows the operator\'s finality rule, as a board\'s does', () => {
  assert.equal(roundMinutes(0), 1)
  assert.equal(causeWhen('round', 5, roundMinutes(0)), 'about a minute')
  assert.equal(roundMinutes(2), 25, 'two Bitcoin blocks of burial: a minute and twenty, rounded up to five')
  assert.equal(causeWhen('round', 25, roundMinutes(2)), 'usually within 25 minutes')
  assert.equal(statedSeconds('round', 25, roundMinutes(2)), 25 * 60)
  assert.equal(DEFAULT_WORDS.waitRound(causeWhen('round', 5, 1)), 'Your money is being moved: this goes ahead by itself (about a minute).')
  const rows = arrivingRows([{ leaf_id: 'r', asset: X, atoms: 1n, state: 'live' }], [], { roundMin: roundMinutes(2) })
  assert.equal(rows[0].when, 'usually within 25 minutes')
})

test('a payment waiting for the wallet\'s own round that fails goes ahead at once, its coins live again', async () => {
  let failed = false
  const sent = []
  let syncs = 0
  const w = {}
  w.postMessage = (m) => {
    const ok = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    const no = (error) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: false, error } }))
    if (m.op === 'exists') return ok(true)
    if (m.op === 'open') return ok({})
    const c = m.args.command
    if (c === 'send') {
      sent.push(failed)
      if (!failed) return no({ kind: 'refused', message: 'the wallet holds 0 of asset X in live coins' })
      return ok({ result: { sent: { asset: X, value: '5' } }, start: {} })
    }
    // The round is dropped: the refresh is voided and its coin is live again, unspent.
    if (c === 'sync') { if (sent.length) { syncs++; failed = true } return ok({ result: {}, start: {} }) }
    const coins = [{ leaf_id: 'g', asset: X, value: '900', state: failed ? 'live' : 'forfeited' }]
    const result = c === 'coins' ? coins : c === 'balance' ? { held: { [X]: '900' } } : c === 'schedule' ? { now: 1 } : c === 'info' ? {}
      : (c === 'care' || c === 'mailbox' || c === 'instant_limit') ? {} : []
    return ok({ result, start: {} })
  }
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let clock = 1000
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    tickMs: 3_600_000, sleep: async (ms) => { clock += ms } }, null, null)
  await api.start()
  const v = await api.command('send', { request: 'request:00', amount: '5', asset: X })
  assert.deepEqual(sent, [false, true], 'asked again as soon as the coin is live again')
  assert.equal(syncs, 1, 'one read of the wallet, not hours of them')
  assert.ok(clock - 1000 < 60_000, 'no long wait: ' + (clock - 1000) + ' ms')
  assert.deepEqual(v.sent, { asset: X, value: '5' })
  api.stop()
})

test('a payment refused for another reason does not wait for the round', async () => {
  const sent = []
  const w = {}
  w.postMessage = (m) => {
    const ok = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: true, value } }))
    const no = (error) => Promise.resolve().then(() => w.onmessage({ data: { id: m.id, ok: false, error } }))
    if (m.op === 'exists') return ok(true)
    if (m.op === 'open') return ok({})
    const c = m.args.command
    if (c === 'send') { sent.push(1); return no({ kind: 'refused', message: 'the receive request lapsed' }) }
    const result = c === 'coins' ? [{ leaf_id: 'g', asset: X, value: '900', state: 'forfeited' }] : c === 'schedule' ? { now: 1 } : c === 'info' ? {}
      : c === 'balance' ? { held: { [X]: '900' } } : (c === 'sync' || c === 'care' || c === 'mailbox' || c === 'instant_limit') ? {} : []
    return ok({ result, start: {} })
  }
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1000,
    tickMs: 3_600_000, sleep: () => Promise.resolve() }, null, null)
  await api.start()
  await assert.rejects(api.command('send', { request: 'request:00', amount: '5', asset: X }), /lapsed/)
  assert.equal(sent.length, 1)
  api.stop()
})

test('a coin coming home says the hours the library gives for its claim, a trade of this page\'s or not', () => {
  const swaps = [
    { swap: null, role: null, state: 'returning', return: { coins: [{ leaf_id: 'e', claim_from: '2000000000' }, { leaf_id: 'u' }] } },
    { swap: 's1', state: 'returned', return: { coins: [{ leaf_id: 'old', claim_from: '1' }] } },
  ]
  const claims = returnClaims(swaps)
  assert.deepEqual(claims, { e: 2_000_000_000 }, 'a coin whose time is not known yet is left out; one home already too')
  const nowMs = 2_000_000_000_000 - 3 * 3_600_000
  const rows = arrivingRows([{ leaf_id: 'e', asset: X, atoms: 9n, state: 'exiting', claimFrom: claims.e }, { leaf_id: 'u', asset: X, atoms: 1n, state: 'exiting' }], [], { nowMs })
  assert.deepEqual(rows.map((r) => r.when), [DEFAULT_WORDS.comingBackWithin(4), DEFAULT_WORDS.comingBackWhen])
  const late = arrivingRows([{ leaf_id: 'e', asset: X, atoms: 9n, state: 'exiting', claimFrom: claims.e }], [], { nowMs: 2_000_000_000_000 + 3_600_000 })
  assert.equal(late[0].when, DEFAULT_WORDS.takingLonger)
})

test('default mode asks every trade for the exit only once its operator offers it; before, it trades as it always has', () => {
  assert.deepEqual(requireExitArgs(false, { server_info: { checkpoint_exit: true } }), { on: true })
  assert.deepEqual(requireExitArgs(false, { server_info: {} }), { on: false }, 'an operator without the exit: trades as before, nothing refused')
  assert.deepEqual(requireExitArgs(false, null), { on: false })
  assert.deepEqual(requireExitArgs(true, { server_info: { checkpoint_exit: true } }), { on: false }, 'developer mode: its own choice, off')
  assert.equal(USER_WORDS.notYet, 'This trade isn\'t available right now. It usually is again within a few minutes. Nothing moved.')
  assert.ok(!/try again/i.test(USER_WORDS.notYet), 'the wait in the words, never an instruction to repeat it (#755)')
  for (const w of ['exit', 'checkpoint', 'maker', 'operator', 'coin', 'round']) assert.ok(!new RegExp('\\b' + w).test(USER_WORDS.notYet), w)
})

test('the exit switch follows the operator\'s info as read again, and an outage never turns it off', () => {
  const offers = { server_info: { checkpoint_exit: true } }
  const not = { server_info: { checkpoint_exit: false } }
  const gone = { server_info: { unreachable: 'connection refused' } }
  assert.deepEqual(exitSwitch(false, not, null), { on: false }, 'first set: what the operator says')
  assert.equal(exitSwitch(false, not, JSON.stringify({ on: false })), null, 'unchanged: nothing to set')
  assert.deepEqual(exitSwitch(false, offers, JSON.stringify({ on: false })), { on: true }, 'the operator begins offering it: on')
  assert.equal(exitSwitch(false, gone, JSON.stringify({ on: true })), null, 'the operator cannot be reached: left on')
  assert.equal(exitSwitch(false, {}, JSON.stringify({ on: true })), null, 'no answer of the operator: left on')
  assert.deepEqual(exitSwitch(true, gone, JSON.stringify({ on: true })), { on: false }, 'developer mode: off whatever the operator says')
  // Once the operator has offered it, nothing it says turns it off in default mode (W3).
  assert.equal(exitSwitch(false, not, JSON.stringify({ on: true }), true), null, 'offered once: an answer without it leaves it on')
  assert.equal(exitSwitch(false, { server_info: {} }, JSON.stringify({ on: true }), true), null, 'an older operator without the field: left on')
  assert.deepEqual(exitSwitch(false, not, null, true), { on: true }, 'a reload after it was offered: on, whatever the operator now says')
  assert.deepEqual(exitSwitch(false, not, JSON.stringify({ on: false }), true), { on: true }, 'back from developer mode: on again')
  assert.equal(exitSwitch(false, not, JSON.stringify({ on: true })), null, 'never turned off in default mode')
})

test('an open page sets the exit on once its operator begins offering it, and keeps it on through an outage', async () => {
  const m = new Map()
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
  store.setItem(JOINED_KEY + '.t', '1')
  let si = { checkpoint_exit: false }
  const set = []
  const w = {}
  w.postMessage = (msg) => {
    const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: msg.id, ok: true, value } }))
    if (msg.op === 'exists') return reply(true)
    if (msg.op === 'open') return reply({})
    const c = msg.args.command
    if (c === 'require_checkpoint_exit') set.push(msg.args.args.on)
    const result = c === 'info' ? { operator: 'k', server_info: si } : c === 'schedule' ? { now: 1 } : c === 'balance' ? {}
      : (c === 'sync' || c === 'care' || c === 'mailbox' || c === 'instant_limit' || c === 'require_checkpoint_exit' || c === 'claims') ? {} : []
    reply({ result, start: {} })
  }
  const clock = { t: 1_000_000 }
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock.t, tickMs: 3_600_000,
    careEveryMs: 60_000, log: () => {} }, null, null)
  try {
  await api.start()
  assert.deepEqual(set, [false], 'opened before the operator offers the exit: off')
  await api.syncNow()
  assert.deepEqual(set, [false], 'the same answer: nothing set again')
  si = { checkpoint_exit: true }
  clock.t += 61_000
  await api.syncNow()
  assert.deepEqual(set, [false, true], 'the operator now offers it: set on without a reload')
  si = { unreachable: 'connection refused' }
  clock.t += 61_000
  await api.syncNow()
  assert.deepEqual(set, [false, true], 'an outage leaves it on')
  si = { checkpoint_exit: false }
  clock.t += 61_000
  await api.syncNow()
  assert.deepEqual(set, [false, true], 'the operator stops offering it: left on (W3)')
  si = {}
  clock.t += 61_000
  await api.syncNow()
  assert.deepEqual(set, [false, true], 'an answer without the field: left on')
  } finally { api.stop() }
})

test('a page opened again after the operator offered the exit sets it on, even when the operator no longer offers it', async () => {
  const m = new Map()
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
  store.setItem(JOINED_KEY + '.t', '1')
  store.setItem(EXIT_SEEN_KEY + '.t.k', '1')
  const set = []
  const w = {}
  w.postMessage = (msg) => {
    const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: msg.id, ok: true, value } }))
    if (msg.op === 'exists') return reply(true)
    if (msg.op === 'open') return reply({})
    const c = msg.args.command
    if (c === 'require_checkpoint_exit') set.push(msg.args.args.on)
    const result = c === 'info' ? { operator: 'k', server_info: { checkpoint_exit: false } } : c === 'schedule' ? { now: 1 } : c === 'balance' ? {}
      : (c === 'sync' || c === 'care' || c === 'mailbox' || c === 'instant_limit' || c === 'require_checkpoint_exit' || c === 'claims') ? {} : []
    reply({ result, start: {} })
  }
  const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1_000_000, tickMs: 3_600_000,
    careEveryMs: 60_000, log: () => {} }, null, null)
  try {
    await api.start()
    assert.deepEqual(set, [true], 'seen before: on at open, although the operator now says it does not offer it')
  } finally { api.stop() }
})

test('the kept fact belongs to the wallet and its operator: another operator\'s, or a developer-mode answer, counts for nothing', async () => {
  const K = 'a'.repeat(64)
  const mount = async (seed, pinOp, offers) => {
    const m = new Map(seed)
    const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
    store.setItem(JOINED_KEY + '.t', '1')
    const set = []
    const w = {}
    w.postMessage = (msg) => {
      const reply = (value) => Promise.resolve().then(() => w.onmessage({ data: { id: msg.id, ok: true, value } }))
      if (msg.op === 'exists') return reply(true)
      if (msg.op === 'open') return reply({})
      const c = msg.args.command
      if (c === 'require_checkpoint_exit') set.push(msg.args.args.on)
      const result = c === 'info' ? { operator: K, server_info: { checkpoint_exit: offers } } : c === 'schedule' ? { now: 1 } : c === 'balance' ? {}
        : (c === 'sync' || c === 'care' || c === 'mailbox' || c === 'instant_limit' || c === 'require_checkpoint_exit' || c === 'claims') ? {} : []
      reply({ result, start: {} })
    }
    const pinned = pinOp ? () => ({ server: 'https://op.example/arca', node_url: 'https://op.example/node', operator: pinOp }) : undefined
    const api = mountLeaves({ makeWorker: () => w, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => 1_000_000, tickMs: 3_600_000,
      careEveryMs: 60_000, log: () => {}, pinned }, null, null)
    try { await api.start() } finally { api.stop() }
    return { set, m }
  }
  let r = await mount([[EXIT_SEEN_KEY + '.t', '1']], null, false)
  assert.deepEqual(r.set, [false], 'a fact kept without its operator counts for nothing')
  r = await mount([[EXIT_SEEN_KEY + '.t.' + 'c'.repeat(64), '1']], null, false)
  assert.deepEqual(r.set, [false], 'seen under another operator: nothing carried to this one')
  r = await mount([], 'b'.repeat(64), true)
  r = await mount([...r.m], 'b'.repeat(64), false)
  assert.deepEqual(r.set, [false], 'an answer that is not the pinned operator\'s kept nothing: opened again, off')
  r = await mount([], K, true)
  assert.equal(r.m.get(EXIT_SEEN_KEY + '.t.' + K), '1', 'the pinned operator offering it: kept for it')
  assert.deepEqual(r.set, [true])
})
