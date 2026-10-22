// The user composer's BTC trades against stand-ins of the leaf library, a maker's BTC desk and a
// Bitcoin Lightning wallet: the order of the one hash-lock, and what a ticket counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from './user-trade.js'
import { MAKER_LOCK_MS, needSeconds } from './user-trade-btc.js'

const X = 'aa'.repeat(32)
const H = 'cd'.repeat(32), P = 'ef'.repeat(32)
const admitted = (pay, receive) => () => ({ pairs: { chains: { g: { pairs: [{ pay, receive, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

function standIn () {
  const s = { calls: [], posts: [], coins: [{ leaf_id: 'c1', asset: X, value: '1000000', state: 'live', expiry: 1790000000 }], receives: {}, pays: {}, ready: false,
    btcPaid: [], invoices: {}, parts: [] }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  s.lib = {
    command (cmd, a) {
      s.calls.push(cmd)
      switch (cmd) {
        case 'coins': return s.coins
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return s.parts
        case 'lightning_pay_quote': return { payment_hash: H, asset: X, amount: s.want, fee: '200', margins: '480', spends: String(BigInt(s.want) + 680n),
          gives: ['c1'], change: String(1000000n - BigInt(s.want) - 680n) }
        case 'lightning_pay': {
          const change = String(1000000n - BigInt(s.want) - 680n)
          s.pays[H] = { state: 'paying' }; s.coins[0].state = 'spent'; s.coins.push({ leaf_id: 'chg', asset: X, value: change, state: 'live', expiry: 1790000000 })
          return { change }
        }
        case 'lightning_payments': return s.pays
        case 'lightning_post_preimage': s.posted = a.preimage; return {}
        case 'lightning_receive_quote': return { asset: X, amount: a.amount, fee: '200', value: String(BigInt(a.amount) - 200n), claim_margins: '416', claimed: String(BigInt(a.amount) - 616n) }
        case 'settle_quote': return { asset: X, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'lightning_receive': s.receives[a.hash] = { state: 'waiting' }; return { invoice: 'lnsqrt-x', fee: '200', value: String(BigInt(a.amount) - 200n) }
        case 'lightning_receives': return s.receives
        case 'lightning_receive_ready':
          assert.equal(a.need_seconds, needSeconds(18))
          return s.ready ? { ready: true } : { ready: false, why: 'the received leaf\'s round is not final' }
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'received'; s.coins.push({ leaf_id: 'r1', asset: X, value: s.claimed, state: 'live' }); return {}
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    const b = init ? JSON.parse(init.body) : null
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: 'BTC', want_asset: X, rate_num: '2', rate_den: '1', min_give: '1000', max_give: '1000000' },
      { give_asset: X, want_asset: 'BTC', rate_num: '1', rate_den: '2', min_give: '1000', max_give: '1000000' }] }
    s.posts.push([url.split('/v1/btc/')[1], b])
    if (url.endsWith('/v1/btc/firm')) {
      if (b.give_asset === 'BTC') { s.want = String(BigInt(b.give) * 2n); return { swap: 's1', invoice: 'lnsqrt-x', give: b.give, want: s.want, expires_at: 4e9 } }
      return { swap: 's2', invoice: 'lnbcrt-maker', give: b.give, want: String((BigInt(b.give) + 1n) / 2n), expires_at: 4e9 }
    }
    return {}
  }
  s.btc = {
    balance: async () => 500000n,
    invoice: async ({ sats }) => { s.invoices[H] = { sats, status: 'unpaid' }; return { invoice: 'lnbcrt-wallet', payment_hash: H, expires_at: 4e9 } },
    decode: async () => ({ sats: s.makerSats, payment_hash: H, expires_at: 4e9, min_final_cltv: 18 }),
    invoiceStatus: async (h) => (s.invoices[h] && s.invoices[h].status === 'paid' ? { status: 'paid', preimage: P } : { status: 'unpaid' }),
    cancelInvoice: async () => {},
    pay: async ({ invoice }) => { s.btcPaid.push(invoice); return { state: 'complete', preimage: P } },
    payStatus: async () => (s.btcPaid.length ? { state: 'complete', preimage: P } : { state: 'none' }),
  }
  return s
}

test('selling for BTC: the wallet\'s hash, its leaf pays first, and the preimage goes to the operator once the BTC came', async () => {
  const s = standIn()
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(X, 'BTC'), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: X, receiveAsset: 'BTC', amount: '200680' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'btc-gateway')
  // 100,340 sat would take 200,680, 680 of fees and 3 to settle the change: sized down to fit.
  assert.equal(q.ticket.amountIn, '200677', 'what leaves the wallet in all: the amount, the fee, the margins and the change\'s settle')
  assert.equal(q.ticket.amountOut, '99997')
  assert.ok(s.posts.some(([p]) => p === 'release'), 'the firm offer that did not fit is released')
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '683' }])
  const firm = s.posts.filter(([p]) => p === 'firm').pop()[1]
  assert.equal(firm.invoice, 'lnbcrt-wallet', 'the maker receives under the wallet\'s own hash')
  let r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'sent')
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent', 'nothing settled before the BTC comes')
  s.invoices[H].status = 'paid'
  r = await eng.advance(eng.records()[0])
  assert.equal(s.posted, P, 'the preimage is handed to the operator, so the wallet\'s payment settles')
  assert.equal(r.state, 'sent')
  s.pays[H].state = 'paid'
  r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'the change the payment left is asked into the next round')
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('buying with BTC: the maker\'s hash, its leaf first, and the BTC paid only once the wallet\'s leaf is held for good', async () => {
  const s = standIn()
  s.makerSats = 50000n
  s.claimed = String(100000n - 616n)
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.amountIn, '50000')
  assert.equal(q.ticket.amountOut, String(100000n - 616n - 3n), 'the amount less the receive fee, the claim\'s margins and the settle fee')
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '619' }])
  let r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'waiting', 'nothing of the wallet\'s has left yet')
  assert.ok(s.posts.some(([p, b]) => p === 'lock' && b.invoice === 'lnsqrt-x'), 'the maker is asked to lock first')
  s.receives[H].state = 'issuing'
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'waiting'); assert.equal(s.btcPaid.length, 0, 'no BTC before the leaf is final')
  s.ready = true
  r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1)
  assert.equal(r.preimage, P)
  r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'the claimed coin goes into the next round')
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('buying with BTC: a maker that never locks leaves nothing moved', async () => {
  const s = standIn()
  s.makerSats = 50000n
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  s.receives[H].state = 'failed'
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.btcPaid.length, 0)
})

test('a wallet with no Bitcoin Lightning is offered no BTC trade', async () => {
  const s = standIn()
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: null })
  assert.equal((await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })).why, 'no-funds')
  const e2 = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(X, 'BTC'), store: s.store, btc: null })
  assert.equal((await e2.quote({ payAsset: X, receiveAsset: 'BTC', amount: '50000' })).why, 'not-offered')
})

test('buying with BTC: a maker that refuses to lock at first leaves the trade under way, not returned', async () => {
  const s = standIn()
  s.makerSats = 50000n
  s.claimed = String(100000n - 616n)
  let refuse = true, locks = 0
  const fetchJson = s.fetchJson
  s.fetchJson = async (url, init) => {
    if (url.endsWith('/v1/btc/lock')) locks++
    if (url.endsWith('/v1/btc/lock') && refuse) { refuse = false; throw new Error('refused: the payment\'s spends changed since it was shown') }
    return fetchJson(url, init)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  const r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'waiting', 'the receive is asked: the trade is under way')
  await eng.advance(eng.records()[0])
  assert.equal(locks, 2, 'the lock is asked for again as the trade is followed')
})

test('buying with BTC: an operator that does not answer the readiness check is asked again; only a refusal returns the trade', async () => {
  const s = standIn()
  s.makerSats = 50000n
  const orig = s.lib.command.bind(s.lib)
  let mode = 'unreachable'
  s.lib.command = (cmd, a) => {
    if (cmd === 'lightning_receive_ready' && mode) {
      const e = new Error(mode === 'refused' ? 'refused: the leaf must start home in 10 s' : 'cannot reach the operator: info'); e.kind = mode; throw e
    }
    return orig(cmd, a)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  s.receives[H].state = 'issuing'
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'waiting', 'an operator that did not answer is asked again')
  mode = 'refused'
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.btcPaid.length, 0)
})

test('buying with BTC: a maker that never pays its side in is given up on after the wait, nothing paid', async () => {
  const s = standIn()
  s.makerSats = 50000n
  let t = 1_000_000
  const posts = []
  const fetchJson = s.fetchJson
  s.fetchJson = async (url, init) => { posts.push(url.split('/v1/')[1]); return fetchJson(url, init) }
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc, now: () => t })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  // The maker answers the lock and never pays: the receive stays waiting.
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'waiting')
  t += MAKER_LOCK_MS
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.btcPaid.length, 0, 'no BTC paid')
  assert.ok(posts.includes('btc/release'), 'the maker is told to let its offer go')
})
