// The user composer's fill of an order resting in the operator's tree, against stand-ins of the
// leaf library and the relay: the ticket from the library's quote, the fill on the terms shown,
// one new quote when the order moved, and Settled only once the relay's fill record is final
// and the coins the fill brought are settled in a final round.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32), OP = 'ab'.repeat(32), ORDER = 'cd'.repeat(32)
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-resting'] }] } } }, genesis: 'g' })

function standIn ({ moved = false, movedPrice = null } = {}) {
  const s = { coins: [{ leaf_id: 'c1', asset: X, value: '2000000', state: 'live', expiry: 1800000000 }], parts: [], fills: [], calls: [], moved }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  const quote = (amount, coin) => ({ order: ORDER, coin, rests: '600000', filled: amount, gets: { asset: Y, amount }, paid: String(BigInt(amount) * 2n),
    fee: { asset: X, amount: '300' }, change: String(2000000n - BigInt(amount) * 2n - 300n - 200n), remainder: null, gives: ['c1'],
    served: { order: ORDER, expiry: 1790000000 } })
  s.lib = {
    command (cmd, a) {
      s.calls.push(cmd)
      switch (cmd) {
        case 'info': return { operator: OP }
        case 'coins': return s.coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return s.parts.map((p) => ({ ...p }))
        case 'order_fill_resting_quote': {
          const q = quote(a.amount, s.atCoin || 'coin-1')
          if (movedPrice && s.atCoin === 'coin-2') q.paid = movedPrice
          return q
        }
        case 'order_fill_resting':
          if (s.moved && a.shown.coin === 'coin-1') { s.moved = false; s.atCoin = 'coin-2'; const e = new Error('refused: order_moved'); e.code = 'order_moved'; throw e }
          s.shownCoin = a.shown.coin
          s.coins[0].state = 'spent'
          s.coins.push({ leaf_id: 'got', asset: Y, value: a.amount, state: 'live', expiry: 1790000000 },
            { leaf_id: 'chg', asset: X, value: a.shown.change, state: 'live', expiry: 1790000000 })
          return { order: ORDER, filled: a.amount, paid: a.shown.paid, fee: '300', change: a.shown.change, gives: ['c1'], answer: { transfer_id: 'tr1', coins: [] } }
        case 'settle_quote': assert.equal(a.expiry, 1790000000, 'the coins it brings expire with the earliest of the order\'s and the wallet\'s'); return { asset: a.asset, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'quote': return { coins: a.leaves.map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.relayBook = async () => [{ offer_asset: Y, want_asset: X, _verified: true, _status: { active_amount: '600000' },
    resting_leaf: { operator_key: OP, order_id: ORDER, asset_a: Y, asset_b: X, rate_num: '2', rate_den: '1', min_lot: '10000', value: '600000' } }]
  s.relayFills = async () => s.fills
  return s
}
const engineOf = (s) => createEngine({ leaves: s.lib, fetchJson: async () => ({}), makers: () => [], relayBook: s.relayBook, relayFills: s.relayFills, admitted, store: s.store })

test('a resting order filled from the ticket the library quoted, Settled once the relay and the round call it final', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'leaf-resting')
  // The fill sized down until the price, the fee of 300, margins of 200 and the change's settle
  // fee of 3 fit what is paid; what it gets less its own settle fee of 3.
  const filled = BigInt(q.choice.quote.filled)
  assert.ok(BigInt(q.ticket.amountIn) <= 400503n)
  assert.equal(q.ticket.amountIn, String(filled * 2n + 503n)); assert.equal(q.ticket.amountOut, String(filled - 3n))
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '503' }, { asset: Y, atoms: '3' }])
  let r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'sent'); assert.equal(r.transfer, 'tr1')
  r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'the coins it brought are asked into the next round')
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent', 'not Settled before the relay records the fill final')
  s.fills.push({ txid: 'tr1', state: 'final', taker: { via: 'operator_tree' } })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('an order that moved is filled at its new coin only on the same terms', async () => {
  const s = standIn({ moved: true })
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  const r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'sent'); assert.equal(s.shownCoin, 'coin-2'); assert.equal(r.movedFrom, 'coin-1')
  const s2 = standIn({ moved: true, movedPrice: '400002' })
  const e2 = engineOf(s2)
  const q2 = await e2.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  await assert.rejects(e2.confirm(q2.choice, q2.ticket), (e) => e.code === 'lapsed', 'a new price is shown again, never taken')
  assert.equal(s2.coins[0].state, 'live')
})

test('an order of another operator is not offered', async () => {
  const s = standIn()
  s.lib.command = ((orig) => (cmd, a) => (cmd === 'info' ? { operator: 'ef'.repeat(32) } : orig(cmd, a)))(s.lib.command)
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.equal(q.why, 'not-offered')
})

test('a fill that did not answer is followed, not called failed: the library may still complete it', async () => {
  const s = standIn()
  const orig = s.lib.command.bind(s.lib)
  let once = true
  s.lib.command = (cmd, a) => {
    if (cmd === 'order_fill_resting' && once) { once = false; orig(cmd, a); const e = new Error('cannot reach the operator: order_fill'); e.kind = 'unreachable'; throw e }
    return orig(cmd, a)
  }
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  const r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'confirming'); assert.equal(r.uncertain, true)
  const r2 = await eng.advance(eng.records()[0])
  assert.equal(r2.state, 'sent', 'the coin it brought is found: the fill went through')
  // One refused outright is failed at once: nothing moved.
  const s3 = standIn()
  const o3 = s3.lib.command.bind(s3.lib)
  s3.lib.command = (cmd, a) => { if (cmd === 'order_fill_resting') { const e = new Error('refused: the order is filled'); e.kind = 'server_refused'; throw e } return o3(cmd, a) }
  const e3 = engineOf(s3)
  const q3 = await e3.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  await assert.rejects(e3.confirm(q3.choice, q3.ticket), /refused/)
  assert.equal(e3.records()[0].state, 'failed')
})

test('a resting fill the wallet\'s eligible coins cannot pay in full is sized to what they hold', async () => {
  const s = standIn()
  const orig = s.lib.command.bind(s.lib)
  // Only 300,000 of the wallet's coins are no older than the order's.
  s.lib.command = (cmd, a) => {
    if (cmd === 'order_fill_resting_quote') {
      const takes = BigInt(a.amount) * 2n + 500n
      if (takes > 300000n) throw new Error(`refused: the outputs take ${takes} of asset ${X}, more than the 300000 the inputs hold`)
    }
    return orig(cmd, a)
  }
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'leaf-resting')
  assert.ok(BigInt(q.choice.quote.filled) * 2n + 500n <= 300000n, 'the fill fits what the eligible coins hold')
  assert.ok(BigInt(q.choice.quote.filled) > 100000n, 'and is not sized down further than that')
})

test('orders that cannot be filled make way for the next one: the engine does not stop at three', async () => {
  const s = standIn()
  const ids = ['01', '02', '03', '04'].map((x) => x.repeat(32))
  const order = (id, num) => ({ offer_asset: Y, want_asset: X, _verified: true, _status: { active_amount: '600000' },
    resting_leaf: { operator_key: OP, order_id: id, asset_a: Y, asset_b: X, rate_num: num, rate_den: '10', min_lot: '10000', value: '600000' } })
  // Four orders at a better price than the fifth, each refused by the library.
  s.relayBook = async () => [...ids.map((id) => order(id, '19')), order(ORDER, '20')]
  const orig = s.lib.command.bind(s.lib)
  s.lib.command = (cmd, a) => { if (cmd === 'order_fill_resting_quote' && ids.includes(a.order)) throw new Error('refused: the order is filled'); return orig(cmd, a) }
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.ok(q.ok, q.why)
  assert.equal(q.choice.id, ORDER)
})

test('coins expiring before the resting order\'s are refreshed for the trade, never "nobody could confirm"', async () => {
  const s = standIn()
  s.coins[0].expiry = 1700000000
  const quoteOf = s.lib.command.bind(s.lib)
  s.lib.command = (cmd, a) => {
    if (cmd === 'order_fill_resting_quote') { s.calls.push(cmd); throw new Error(`refused: the wallet's live coins of asset ${X} that expire no earlier than the order's coin (median time 1790000000) keep 0 past their checkpoints; the fill of 10 costs 20 and its fee, with change of none or at least 1000`) }
    return quoteOf(cmd, a)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson: async () => ({}), makers: () => [], relayBook: s.relayBook, relayFills: s.relayFills, admitted, store: s.store, anchorDepth: () => 0 })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.deepEqual([q.ok, q.why, q.soon], [false, 'readying', true])
  assert.deepEqual(s.parts.length, 1, 'the old coin given up in the next round')
  assert.ok(s.calls.includes('participate'))
  // Asked again while that round runs: still getting ready, nothing asked twice.
  const n = s.calls.filter((c) => c === 'participate').length
  assert.equal((await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })).why, 'readying')
  assert.equal(s.calls.filter((c) => c === 'participate').length, n)
})

test('a coin new enough for the order is never refreshed for it', async () => {
  const s = standIn()
  const quoteOf = s.lib.command.bind(s.lib)
  s.lib.command = (cmd, a) => {
    if (cmd === 'order_fill_resting_quote') { s.calls.push(cmd); throw new Error(`refused: the wallet's live coins of asset ${X} that expire no earlier than the order's coin (median time 1790000000) keep 0 past their checkpoints`) }
    return quoteOf(cmd, a)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson: async () => ({}), makers: () => [], relayBook: s.relayBook, relayFills: s.relayFills, admitted, store: s.store })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400503' })
  assert.equal(q.why, 'no-firm-offer', 'its coin (expiry 1800000000) is not older than the order\'s: nothing to refresh')
  assert.ok(!s.calls.includes('participate'))
})
