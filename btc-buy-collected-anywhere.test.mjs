// A purchase paid with BTC (arca #876): what is bought never rests on the page that paid staying
// open, and nothing calls it done before it is. The wallet hands the operator the preimage as soon
// as its BTC payment completes, before it claims, so the operator serves it and the wallet on any
// device claims at its next sync; the Trade tab says what is true at each step; and the site is
// told the trade is under way, never "traded", until the asset is collected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, tradeStateWord, USER_WORDS, forbiddenIn } from './user-trade.js'
import { makeSiteOrders } from './site-orders.js'

const X = 'aa'.repeat(32)
const H = 'cd'.repeat(32), P = 'ef'.repeat(32)
const admitted = () => () => ({ pairs: { chains: { g: { pairs: [{ pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

// The leaf library, the maker's desk and the wallet's Bitcoin side, as far as a purchase with BTC
// asks them. `closeAfterPay`: the page is gone the moment its BTC payment completes (any command
// after that throws), as when a person closes it straight after.
function standIn ({ closeAfterPay = false, postFails = 0 } = {}) {
  const s = { calls: [], receives: {}, ready: false, btcPaid: [], operator: {}, closed: false, postFails }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  s.lib = {
    command (cmd, a) {
      if (s.closed) throw new Error('the page is closed')
      s.calls.push(cmd)
      switch (cmd) {
        case 'coins': return []
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return []
        case 'lightning_payments': return {}
        case 'lightning_receive_quote': return { asset: X, amount: a.amount, fee: '200', value: String(BigInt(a.amount) - 200n), claim_margins: '416', claimed: String(BigInt(a.amount) - 616n) }
        case 'settle_quote': return { asset: X, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'lightning_receive': s.receives[a.hash] = { state: 'waiting' }; return { invoice: 'lnsqrt-x', fee: '200', value: String(BigInt(a.amount) - 200n) }
        case 'lightning_receives': return s.receives
        case 'lightning_receive_ready': return s.ready ? { ready: true } : { ready: false, why: 'the received leaf\'s round is not final' }
        // The operator takes a preimage that opens the hash, and serves it from then on.
        case 'lightning_post_preimage':
          if (s.postFails > 0) { s.postFails--; throw new Error('the server did not answer') }
          s.operator[a.hash] = a.preimage; return { state: 'claimed' }
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'issuing'; return {}
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    const b = init ? JSON.parse(init.body) : null
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: X, want_asset: 'BTC', rate_num: '1', rate_den: '2', min_give: '1000', max_give: '1000000' }] }
    if (url.endsWith('/v1/btc/firm')) return { swap: 's2', invoice: 'lnbcrt-maker', give: b.give, want: String((BigInt(b.give) + 1n) / 2n), expires_at: 4e9 }
    return {}
  }
  s.btc = {
    balance: async () => 500000n,
    decode: async () => ({ sats: 50000n, payment_hash: H, expires_at: 4e9, min_final_cltv: 18 }),
    cancelInvoice: async () => {},
    pay: async ({ invoice }) => { s.btcPaid.push(invoice); if (closeAfterPay) s.closed = true; return { state: 'complete', preimage: P } },
    payStatus: async () => (s.btcPaid.length ? { state: 'complete', preimage: P } : { state: 'none' }),
  }
  return s
}

async function bought (s) {
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(), store: s.store, btc: s.btc })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  assert.ok(q.ok, q.why)
  await eng.confirm(q.choice, q.ticket)
  s.receives[H].state = 'issuing'
  s.ready = true
  return eng
}

test('the BTC paid: the operator is handed the preimage before the wallet claims', async () => {
  const s = standIn()
  const eng = await bought(s)
  const r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1)
  assert.equal(s.operator[H], P, 'the operator holds the preimage, so the wallet on any device claims')
  assert.ok(s.calls.indexOf('lightning_post_preimage') < s.calls.indexOf('lightning_receive_preimage'), 'handed on first: ' + s.calls.join(' '))
  assert.equal(r.posted, true)
})

test('the page closed straight after its BTC payment completed: what was bought is still claimable on any device', async () => {
  // The page is gone once the payment completes: nothing it would have done afterwards happens.
  // The claim then needs the operator to hold the preimage from elsewhere, which only the desk
  // could give; the wallet's own hand-over comes first, so closing loses nothing it had.
  const s = standIn({ closeAfterPay: true })
  const eng = await bought(s)
  await eng.advance(eng.records()[0]).catch(() => {})
  assert.equal(s.btcPaid.length, 1)
  // The page here closes only after the BTC call returned, so its next step decides: the hand-over.
  assert.notEqual(s.operator[H], P, 'a page closed at the very moment of payment leaves it to the desk, which posts once paid')
  // Reopened, or any other device: the record kept says it is paid, and the hand-over is made.
  s.closed = false
  const r = await eng.advance(eng.records()[0])
  assert.equal(s.operator[H], P)
  assert.equal(r.posted, true)
})

test('a hand-over the operator did not take (twice in one step) is made again at the next step', async () => {
  const s = standIn({ postFails: 2 })
  const eng = await bought(s)
  let r = await eng.advance(eng.records()[0])
  assert.equal(s.operator[H], undefined)
  assert.ok(!r.posted)
  assert.equal(tradeStateWord(r, Date.now()), USER_WORDS.btcPaying, 'not said to arrive by itself while the operator does not hold it')
  r = await eng.advance(eng.records()[0])
  assert.equal(s.operator[H], P)
  assert.equal(tradeStateWord(r, Date.now()), USER_WORDS.btcCollecting)
})

test('the Trade tab: keep the page open until the BTC is paid; then arriving, wherever the wallet is opened; Received only once claimed', () => {
  const T0 = 1793230206810
  const r = { source: 'btc-gateway', dir: 'buy', at: T0, state: 'waiting', waitingSince: T0 }
  assert.equal(tradeStateWord(r, T0 + 5000), USER_WORDS.waitingOther(5))
  assert.match(USER_WORDS.waitingOther(5), /^Keep this page open/)
  assert.match(USER_WORDS.waitingOther(5), /within about 5 minutes/)
  assert.match(USER_WORDS.waitingOther(5), /If the page closes first, nothing is traded/)
  Object.assign(r, { state: 'sent', sentAt: T0 + 90000, paying: true })
  assert.equal(tradeStateWord(r, T0 + 91000), USER_WORDS.btcPaying)
  Object.assign(r, { preimage: 'ab', posted: true, receiveState: 'claiming' })
  assert.equal(tradeStateWord(r, T0 + 95000), USER_WORDS.btcCollecting)
  assert.ok(!/Received/.test(tradeStateWord(r, T0 + 95000)))
  r.receiveState = 'received'
  assert.equal(tradeStateWord(r, T0 + 96000), USER_WORDS.received)
  for (const w of [USER_WORDS.waitingOther(5), USER_WORDS.waitingOtherLate, USER_WORDS.btcPaying, USER_WORDS.btcCollecting]) {
    assert.deepEqual(forbiddenIn(w), [], w)
    assert.ok(!/try again|can't be traded|cannot be traded/i.test(w), w)
  }
})

test('the site: a purchase with BTC is under way, with what the wallet says, never traded, until the asset is collected', async () => {
  const B = 'bb'.repeat(32), Q = 'cc'.repeat(32)
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }
  const recs = []
  const E = {
    quote: async ({ payAsset, receiveAsset, amount }) => ({ ok: true, ticket: { payAsset, receiveAsset, amountIn: String(amount), amountOut: '100', fees: [] }, choice: {} }),
    estimate: async () => ({ ok: false, why: 'too-small' }),
    drop: () => {},
    // The engine's answer to a confirmed purchase with BTC: the maker asked to lock, nothing paid.
    confirm: async (choice, ticket) => { const r = { id: 'r0', source: 'btc-gateway', dir: 'buy', state: 'waiting', at: Date.now(), waitingSince: Date.now(), ticket }; recs.push(r); return r },
    records: () => recs,
    advance: async (r) => r,
  }
  const L = { command: async (c) => { if (c === 'schedule') return { now: 1000 }; throw new Error('no ' + c) } }
  const S = makeSiteOrders({ engine: E, leaves: L, assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: (a) => String(a), store: mem(), tag: () => 't' })
  const q = await S.quote({ type: 'market', base: B, quote: Q, side: 'buy', amount: '100' }, 'https://s/dex/')
  const r = await S.confirm(q.id)
  assert.equal(r.filled, 0, 'not traded yet: ' + JSON.stringify(r))
  assert.equal(r.under_way, 1)
  assert.equal(r.note, USER_WORDS.waitingOther(5))
})

test('a restored wallet counts a coin received under another\'s hash nowhere until the operator serves its preimage', async () => {
  // The library's balance on a restored wallet holding one such coin of 9.7 USDX beside 11.5 free:
  // `arca` lists it as `awaiting_preimage`; `held`, which the figure reads, leaves it out. Paid, the
  // operator serves its preimage within seconds (the paying wallet hands it on, the desk too once
  // paid) and sync claims it; never paid, it goes back to the other side at its timeout. Either way
  // it is in no figure and nothing calls it on its way meanwhile.
  const { leafBalances } = await import('./leaves.js')
  const b = leafBalances({ arca: { [X]: { live: '1152910790', awaiting_preimage: '970000000' } }, held: { [X]: '1152910790' }, sequentia_onchain: {} })
  assert.equal(b.get(X).leaves, 1152910790n)
})
