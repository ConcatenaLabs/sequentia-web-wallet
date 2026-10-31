// lightning-to-ark.js: the move of a wallet's own Lightning balances to the Ark, as Ambra makes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { amountToMove, withinAllowance, allowanceAtoms, channelLockedIn, payingNode, lightningLegs, minLeaves,
  receivesUnderWay, movingOf, channelPart, closeVerdict, isLimitRefusal, mountLightningToArk, MIN_MOVE_SATS,
  RETRY_MS, LIMIT_WAIT_MS, SIGNER_UNVALUED_ATOMS } from './lightning-to-ark.js'
import { DEFAULT_WORDS } from './default-arca.js'
import { USER_MODE_FORBIDDEN_WORDS } from './user-trade.js'

const USDX = 'c8eccacf0953'.padEnd(64, '0')
const kindOf = (c) => (c.leg === 'btc' ? 'BTC' : c.asset)
const btcCh = (o = {}) => ({ node_key: 'btc:aa', leg: 'btc', asset_label: 'BTC', state: 'CHANNELD_NORMAL', owner: 'channeld', short_channel_id: '1x1x0', spendable_units: 100000, balance_units: 101000, ...o })
const usdxCh = (o = {}) => ({ node_key: 'seq:usdx:bb', leg: USDX, asset: USDX, state: 'CHANNELD_NORMAL', owner: 'channeld', short_channel_id: '2x1x0', spendable_units: 5_000_000_000, balance_units: 5_050_000_000, ...o })
const info = { server_info: { assets: [
  { asset: USDX, min_leaf: '2700301', lightning: { state: 'up', receives: true } },
  { asset: 'ee'.repeat(32), min_leaf: '1', supervised: { landing_allowance: '4' } },
  { asset: 'dd'.repeat(32), min_leaf: '1', lightning: { state: 'down', receives: true } },
] } }

test('the words are the contract\'s, and none is forbidden in default mode', () => {
  const s = DEFAULT_WORDS.moving('0.001', 'BTC')
  assert.equal(s, 'Moving 0.001 BTC so it can be sent in seconds.')
  for (const w of USER_MODE_FORBIDDEN_WORDS) assert.ok(!new RegExp(`\\b${w}`, 'i').test(s), w)
})

test('a move leaves the routing fee in the channel, and is held to nine tenths of the day\'s limit', () => {
  assert.equal(amountToMove(100000n), 100000n - 1000n - 10n)
  assert.equal(amountToMove(5000n), null)                // below the least worth moving
  assert.equal(amountToMove(3_000_000n, 2_700_301n), 2_969_990n)
  assert.equal(amountToMove(2_700_000n, 2_700_301n), null)  // below the smallest leaf
  assert.equal(withinAllowance(99_000n, null), 99_000n)   // no limit
  assert.equal(withinAllowance(99_000n, 50_000n), 45_000n)
  assert.equal(withinAllowance(99_000n, 5_000n), null)    // what is left moves another day
  assert.equal(withinAllowance(null, 1n), null)
})

test('the daily limit is the signer\'s: own, default, reference at the rate, none', () => {
  assert.equal(allowanceAtoms({ reference: null }, 'btc', 7n), null)     // the page's default: no limit
  assert.equal(allowanceAtoms({ assets: { btc: 123 } }, 'btc', 7n), 123n)
  assert.equal(allowanceAtoms({ assets: { btc: null }, default: 5 }, 'btc'), null)
  assert.equal(allowanceAtoms({ default: 5 }, USDX), 5n)
  // 1,000 reference units at a BTC price of 100,000: 1,000,000 sats.
  assert.equal(allowanceAtoms({}, 'btc', 100_000n * 100_000_000n), 1_000_000n)
  assert.equal(allowanceAtoms({ reference: 50n * 100_000_000n, rates: { [USDX]: 100_000_000 } }, USDX), 5_000_000_000n)
  assert.equal(allowanceAtoms({}, USDX, null), SIGNER_UNVALUED_ATOMS)
  assert.ok(isLimitRefusal(new Error('Your device declined this payment: over the daily limit')))
  assert.ok(!isLimitRefusal(new Error('no route')))
})

test('only a channel locked in, with its daemon, pays; the node that can pay most is chosen', () => {
  assert.ok(channelLockedIn(btcCh()))
  assert.ok(!channelLockedIn(btcCh({ state: 'CHANNELD_AWAITING_LOCKIN' })))
  assert.ok(!channelLockedIn(btcCh({ owner: null })))
  assert.ok(channelLockedIn({ state: 'CHANNELD_NORMAL' }))   // a status that does not report the owner
  const n = payingNode([btcCh(), btcCh({ node_key: 'btc:cc', spendable_units: 200000 }), btcCh({ node_key: 'btc:dd', spendable_units: 900000, state: 'CHANNELD_AWAITING_LOCKIN' }),
    { ...btcCh(), node_key: undefined, spendable_units: 9e9 }, usdxCh()], 'BTC', kindOf)
  assert.equal(n.node_key, 'btc:cc')
  assert.equal(n.spendable, 200000n)
  assert.equal(payingNode([usdxCh({ state: 'CHANNELD_AWAITING_LOCKIN' })], USDX, kindOf), null)
})

test('the assets moved are those the operator receives over Lightning, never a supervised one', () => {
  assert.deepEqual(lightningLegs(info), [USDX])
  assert.equal(minLeaves(info).get(USDX), 2_700_301n)
  assert.deepEqual(lightningLegs(null), [])
})

test('what is moving: paid from the channel, not lapsed, until its leaf is the wallet\'s', () => {
  const t = 1_800_000_000_000
  const r = { h1: { asset: USDX, state: 'waiting', amount: '100', value: '99', expires_at: t / 1000 + 600 },
    h2: { asset: USDX, state: 'waiting', amount: '7', value: '6', expires_at: t / 1000 - 1 },
    h3: { asset: USDX, state: 'issuing', amount: '50', value: '49' }, h4: { asset: USDX, state: 'waiting', amount: '5', value: '4' } }
  assert.deepEqual([...movingOf(r, [], new Set(['h1', 'h2', 'h3']), t)], [[USDX, 150n]])
  assert.deepEqual([...movingOf(r, [{ state: 'receiving', asset: USDX, value: '49' }], new Set(['h1', 'h3']), t)], [[USDX, 100n]])
  assert.ok(receivesUnderWay(r, USDX, t))
  assert.ok(!receivesUnderWay({ h2: r.h2 }, USDX, t))
  assert.ok(!receivesUnderWay({ h1: r.h1 }, USDX, t, new Set(['h1'])))
  assert.equal(channelPart(100n, null, null), 100n)
  assert.equal(channelPart(1000n, 990n, 1000n), 1000n)   // read before it left: never counted twice
  assert.equal(channelPart(10n, 990n, 1000n), 1000n)     // read after
  assert.equal(channelPart(0n, 990n, 1000n), 1000n)      // a status that missed the node: no dip
  assert.equal(channelPart(10n, 990n, null), 1000n)
})

test('an emptied channel closes when cheap and safe, else says why it stays', () => {
  const c = btcCh({ spendable_units: 0, balance_units: 1010 })
  assert.deepEqual(closeVerdict({ channel: c, left: 1010n, spendable: 0n, fee: 200n, moved: true }), { close: true, why: null })
  assert.match(closeVerdict({ channel: c, left: 1010n, spendable: 0n, fee: 200n, moved: false }).why, /no move/)
  assert.match(closeVerdict({ channel: c, left: 1010n, spendable: 0n, fee: 200n, moved: true, moving: true }).why, /on its way/)
  assert.match(closeVerdict({ channel: c, left: 1010n, spendable: 0n, fee: 600n, moved: true }).why, /cost too much/)
  assert.match(closeVerdict({ channel: c, left: 1010n, spendable: 0n, fee: null, moved: true }).why, /cannot be priced/)
  assert.match(closeVerdict({ channel: btcCh(), left: 101000n, spendable: 100000n, fee: 200n, moved: true }).why, /enough to move/)
  assert.match(closeVerdict({ channel: { ...c, state: 'CHANNELD_AWAITING_LOCKIN' }, left: 1010n, spendable: 0n, fee: 1n, moved: true }).why, /not open/)
})

// A page on fakes: the channels, the node, the ark and the leaf wallet.
function page (o = {}) {
  let t = 1_800_000_000_000
  const store = new Map()
  const W = {
    t: () => t, advance: (ms) => { t += ms },
    channels: o.channels || [btcCh(), usdxCh()],
    dev: false, busy: false, paid: [], closes: [], logs: [], changes: 0, received: 'paid', payState: 'none',
    payImpl: o.payImpl || (async () => ({ paid: true })),
    receives: {}, coins: [],
  }
  const deps = {
    dev: () => W.dev, personBusy: () => W.busy, channels: () => W.channels, kindOf,
    refreshChannels: async () => { if (o.afterPay) o.afterPay(W) },
    connect: async (k) => (k === 'BTC' ? 'btc:aa' : 'seq:usdx:bb'),
    pay: async (p) => {
      W.paid.push(p)
      const r = await W.payImpl(p)
      // The operator holds what was paid until the leaf's round.
      for (const v of Object.values(W.receives)) if (p.bolt11 === 'lnsq' + v.amount) v.state = 'issuing'
      return r
    },
    payStatus: async () => ({ state: W.payState }),
    ark: { isOpen: () => true, invoice: async (sats) => ({ invoice: 'lntb' + sats, payment_hash: 'hb' + sats, expires_at: t / 1000 + 600 }), received: async () => ({ state: W.received }), refresh: async () => {} },
    leaves: {
      isOpen: () => true, info: () => info, coins: () => W.coins, refresh: () => {},
      run: async (cmd, args) => {
        if (cmd === 'lightning_receives') return W.receives
        if (cmd === 'lightning_receive_quote') { if (o.quoteRefuses) throw new Error(o.quoteRefuses); return { value: args.amount } }
        if (cmd === 'lightning_receive') { const h = 'ha' + args.amount; W.receives[h] = { asset: args.asset, state: 'waiting', amount: args.amount, value: String(BigInt(args.amount) - 1n), expires_at: t / 1000 + 600 }; return { invoice: 'lnsq' + args.amount, payment_hash: h, value: W.receives[h].value, fee: '1' } }
        throw new Error('unknown ' + cmd)
      },
    },
    allowance: async () => (o.allowance === undefined ? null : o.allowance),
    closeFee: async () => (o.closeFee === undefined ? 200n : o.closeFee),
    close: async (p) => { W.closes.push(p); return { closing_txid: 'cc'.repeat(32), type: 'mutual' } },
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, tag: () => 'w1',
    onChange: () => { W.changes++ }, log: (...a) => W.logs.push(a.join(' ')), now: () => t, sleep: async (ms) => { t += ms },
  }
  W.m = mountLightningToArk(deps)
  W.deps = deps
  W.store = store
  return W
}

test('BTC: the channel pays an invoice of the wallet\'s own ark, and the figure holds while it moves', async () => {
  const W = page({ payImpl: async function () { return { paid: true } } })
  let seen = null
  W.payImpl = async () => { seen = { moving: W.m.movingBtc(), part: W.m.channelPart('BTC', 101000n) }; return { paid: true } }
  await W.m.tick()
  assert.equal(W.paid.length, 1)
  assert.deepEqual(W.paid[0], { node_key: 'btc:aa', bolt11: 'lntb98990' })
  assert.deepEqual(seen, { moving: 98990n, part: 101000n })   // the figure: the channel's, never more
  assert.equal(W.m.movingBtc(), null)                       // received in the ark: nothing moving
  assert.ok(W.m.ownHashes().has('hb98990'))
  // Not looked at again before RETRY_MS.
  await W.m.tick(); assert.equal(W.paid.length, 1)
})

test('BTC: a refused payment moves nothing, and is tried again later', async () => {
  const W = page({ payImpl: async () => { throw new Error('no route') } })
  W.received = 'waiting'
  await W.m.tick()
  assert.equal(W.paid.length, 1)
  assert.equal(W.m.movingBtc(), null)
  assert.ok(W.logs.some((l) => /BTC not moved now: no route/.test(l)))
  W.advance(RETRY_MS + 1)
  await W.m.tick()
  assert.equal(W.paid.length, 2)
})

test('BTC: a payment over the daily limit waits hours, not minutes', async () => {
  const W = page({ payImpl: async () => { throw new Error('Your device declined this payment') } })
  W.received = 'waiting'
  await W.m.tick()
  W.advance(RETRY_MS + 1); await W.m.tick(); assert.equal(W.paid.length, 1)
  W.advance(LIMIT_WAIT_MS); await W.m.tick(); assert.equal(W.paid.length, 2)
})

test('BTC: held to the limit, never in developer mode, never while a person uses the wallet, never from a channel opening', async () => {
  const W = page({ allowance: 50_000n })
  W.dev = true; await W.m.tick(); assert.equal(W.paid.length, 0)
  W.dev = false; W.busy = true; await W.m.tick(); assert.equal(W.paid.length, 0)
  W.busy = false
  W.channels = [btcCh({ state: 'CHANNELD_AWAITING_LOCKIN' })]; await W.m.tick(); assert.equal(W.paid.length, 0)
  W.channels = [btcCh()]; await W.m.tick()
  assert.equal(W.paid[0].bolt11, 'lntb45000')
})

test('BTC: a move cut short by a reload is followed again, and shown as moving meanwhile', async () => {
  const W = page()
  W.received = 'waiting'; W.payState = 'pending'
  W.payImpl = () => new Promise(() => {})   // the page closes while the payment is on its way
  const t = W.m.tick()
  await new Promise((r) => setImmediate(r))
  assert.equal(W.m.movingBtc(), 98990n)
  // A new page on the same store finds it.
  const W2 = page()
  for (const [k, v] of W.store) W2.store.set(k, v)
  assert.equal(W2.m.movingBtc(), 98990n)
  W2.received = 'paid'
  await W2.m.tick()
  assert.equal(W2.m.movingBtc(), null)
  assert.equal(W2.paid.length, 0)   // nothing paid twice
  void t
})

test('assets: the channel pays the leaf wallet\'s Lightning receive; moving until its leaf is the wallet\'s', async () => {
  const W = page({ channels: [usdxCh()] })
  await W.m.tickAssets()
  assert.equal(W.paid.length, 1)
  const amount = 5_000_000_000n - 50_000_000n - 10n
  assert.deepEqual(W.paid[0], { node_key: 'seq:usdx:bb', bolt11: 'lnsq' + amount })
  assert.equal(W.m.moving(USDX), amount)
  // The channel read after the payment left it: the figure is unchanged.
  assert.equal(W.m.channelPart(USDX, 100_000_010n), 5_050_000_000n)
  assert.equal(W.m.channelPart(USDX, 5_050_000_000n), 5_050_000_000n)   // read before it left
  // Another tick does not pay a second time while the first is under way.
  W.advance(RETRY_MS); await W.m.tickAssets(); assert.equal(W.paid.length, 1)
  // The leaf arrives: nothing is moving, and the emptied channel is closed.
  W.coins = [{ state: 'receiving', asset: USDX, value: String(amount - 1n) }]
  W.channels = [usdxCh({ spendable_units: 0, balance_units: 50_000_010 })]
  await W.m.tickAssets()
  assert.equal(W.m.moving(USDX), null)
  assert.equal(W.closes.length, 1)
  assert.equal(W.closes[0].channel.short_channel_id, '2x1x0')
})

test('assets: a payment refused before it left gives its receive up', async () => {
  const W = page({ channels: [usdxCh()], payImpl: async () => { throw new Error('no route') } })
  W.payState = 'failed'
  await W.m.tickAssets()
  assert.equal(W.paid.length, 1)
  assert.equal(W.m.moving(USDX), null)
  // The receive is given up: not under way, so a later tick asks again.
  W.advance(RETRY_MS + 1)
  await W.m.tickAssets()
  assert.equal(W.paid.length, 2)
})

test('assets: a payment the service stopped waiting for is still on its way', async () => {
  const W = page({ channels: [usdxCh()], payImpl: async () => { throw new Error('the request timed out') } })
  W.payState = 'pending'
  await W.m.tickAssets()
  assert.ok(W.m.moving(USDX) > 0n)
})

test('assets: too little to reach the smallest leaf moves nothing; a refused quote moves nothing', async () => {
  const W = page({ channels: [usdxCh({ spendable_units: 2_000_000 })] })
  await W.m.tickAssets()
  assert.equal(W.paid.length, 0)
  const W2 = page({ channels: [usdxCh()], quoteRefuses: 'the operator does not receive this much' })
  await W2.m.tickAssets()
  assert.equal(W2.paid.length, 0)
  assert.ok(W2.logs.some((l) => /not moved now: the operator/.test(l)))
})

test('a channel never moved from is never closed; a costly close is not made and says why', async () => {
  const W = page({ channels: [usdxCh({ spendable_units: 0, balance_units: 1000 })] })
  await W.m.tickAssets()
  assert.equal(W.closes.length, 0)
  assert.match(W.m.closeWhy('2x1x0'), /no move/)
  const W2 = page({ channels: [btcCh()], closeFee: 600n })
  await W2.m.tick()
  W2.channels = [btcCh({ spendable_units: 0, balance_units: 1010 })]
  W2.advance(RETRY_MS + 1)
  await W2.m.tick()
  assert.equal(W2.closes.length, 0)
  assert.match(W2.m.closeWhy('1x1x0'), /cost too much/)
})

test('MIN_MOVE_SATS is Ambra\'s', () => { assert.equal(MIN_MOVE_SATS, 5000n) })

test('assets: what is moving is shown again at once after a reload', async () => {
  const W = page({ channels: [usdxCh()] })
  await W.m.tickAssets()
  const m = W.m.moving(USDX)
  assert.ok(m > 0n)
  const W2 = page({ channels: [usdxCh({ spendable_units: 0, balance_units: 100_000_010 })] })
  for (const [k, v] of W.store) W2.store.set(k, v)
  const again = mountLightningToArk({ ...W2.m.state.deps, store: { getItem: (k) => W2.store.get(k) ?? null, setItem: (k, v) => W2.store.set(k, v) }, tag: () => 'w1', now: () => 1_800_000_000_000, kindOf })
  assert.equal(again.moving(USDX), m)
  assert.equal(again.channelPart(USDX, 100_000_010n), 5_050_000_000n)
})

test('what an emptied channel\'s close pays stays in the figure until the wallet\'s own scan counts it', async () => {
  const W = page({ channels: [usdxCh()] })
  let seen = false
  W.m = mountLightningToArk({ ...W.deps, seen: async () => seen })
  await W.m.tickAssets()
  W.coins = [{ state: 'receiving', asset: USDX, value: String(5_000_000_000n - 50_000_000n - 10n - 1n) }]
  W.channels = [usdxCh({ spendable_units: 0, balance_units: 50_000_010 })]
  await W.m.tickAssets()
  assert.equal(W.closes.length, 1)
  // The channel has left the status; its 50,000,010 atoms are on their way to the address.
  W.channels = []
  assert.equal(W.m.channelPart(USDX, 0n), 50_000_010n)
  await W.m.checkClosed()
  assert.equal(W.m.channelPart(USDX, 0n), 50_000_010n, 'not counted on the chain yet')
  seen = true
  await W.m.checkClosed()
  assert.equal(W.m.channelPart(USDX, 0n), 0n, 'the chain counts it now: never twice')
})

test('without a way to tell, a close\'s payment is not held (never counted twice)', async () => {
  const W = page({ channels: [usdxCh()] })
  await W.m.tickAssets()
  W.coins = [{ state: 'receiving', asset: USDX, value: String(5_000_000_000n - 50_000_000n - 10n - 1n) }]
  W.channels = [usdxCh({ spendable_units: 0, balance_units: 50_000_010 })]
  await W.m.tickAssets()
  assert.equal(W.closes.length, 1)
  assert.equal(W.m.channelPart(USDX, 0n), 0n)
})
