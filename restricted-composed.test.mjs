// restricted-composed.js through the composer's engine (user-trade.js): bitcoin buys a restricted
// asset as one trade. The first step is the engine's own bitcoin purchase, against stand-ins of the
// leaf library, a maker's BTC desk and a Bitcoin Lightning wallet (as user-trade-btc.test.mjs);
// the second is the restricted trade against a stand-in policy server and book (as
// restricted-trade.test.mjs). The second step on a real node, signed by the wallet library, is the
// regtest drive the pull request names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEngine, forbiddenIn } from './user-trade.js'
import { RESTRICTED_WORDS } from './restricted-trade.js'
import { COMPOSED_SECOND_MS, COMPOSED_RETRY_MS, isStep } from './restricted-composed.js'
import { tradeRows } from './instant-history.js'

const seqob = await import('./seqob.js')
const vectors = JSON.parse(fs.readFileSync(new URL('./restricted-offer-vectors.json', import.meta.url)))
const offers = vectors.map((v) => { const o = JSON.parse(JSON.stringify(v)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _status: { active_amount: '400' } } })
const RA = offers[0].pair.base_asset // the restricted asset
const X = offers[0].pair.quote_asset // what bitcoin buys and what buys it
const H = 'cd'.repeat(32), P = 'ef'.repeat(32)
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

// The BTC desk, the leaf library and the Lightning wallet (user-trade-btc.test.mjs's stand-in, the
// purchase only): 1 sat buys 2 atoms of X.
function standIn () {
  const s = { coins: [], receives: {}, btcPaid: [], invoices: {}, parts: [], posts: [], ready: false }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  s.lib = {
    command (cmd, a) {
      switch (cmd) {
        case 'coins': return s.coins
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return s.parts
        case 'lightning_receive_quote': return { asset: X, amount: a.amount, fee: '200', value: String(BigInt(a.amount) - 200n), claim_margins: '416', claimed: String(BigInt(a.amount) - 616n) }
        case 'settle_quote': return { asset: X, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'lightning_receive': s.receives[a.hash] = { state: 'waiting' }; return { invoice: 'lnsqrt-x', fee: '200', value: String(BigInt(a.amount) - 200n) }
        case 'lightning_receives': return s.receives
        case 'lightning_receive_ready': return s.ready ? { ready: true } : { ready: false, why: 'the received leaf\'s round is not final' }
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'received'; s.receives[a.hash].leaf = 'r1'; s.coins.push({ leaf_id: 'r1', asset: X, value: '99384', state: 'live' }); return {}
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    const b = init ? JSON.parse(init.body) : null
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: X, want_asset: 'BTC', rate_num: '1', rate_den: '2', min_give: '1000', max_give: '1000000' }] }
    s.posts.push([url.split('/v1/btc/')[1], b])
    if (url.endsWith('/v1/btc/firm')) return { swap: 's2', invoice: 'lnbcrt-maker', give: b.give, want: String((BigInt(b.give) + 1n) / 2n), expires_at: 4e9 }
    return {}
  }
  s.btc = {
    balance: async () => 500000n,
    invoice: async ({ sats }) => { s.invoices[H] = { sats, status: 'unpaid' }; return { invoice: 'lnbcrt-wallet', payment_hash: H, expires_at: 4e9 } },
    decode: async () => ({ sats: 50000n, payment_hash: H, expires_at: 4e9, min_final_cltv: 18 }),
    invoiceStatus: async () => ({ status: 'unpaid' }),
    cancelInvoice: async () => {},
    pay: async ({ invoice }) => { s.btcPaid.push(invoice); return { state: 'complete', preimage: P } },
    payStatus: async () => (s.btcPaid.length ? { state: 'complete', preimage: P } : { state: 'none' }),
  }
  return s
}

// The page's restricted host (deps.restricted), with the two offers of the vectors: the maker's
// quote (300 for 50,000,000 X) and the gated order (400, all it holds, for 800 X).
function restrictedHost (over = {}) {
  const h = { held: 0n, takes: [], status: {}, book: offers, card: null }
  h.R = {
    available: async () => true, isRestricted: (x) => x === RA, book: async () => h.book,
    sellers: async () => [{ asset: X }], btcBuys: (x) => x === X, eligible: async () => h.card,
    held: async (x) => (x === X ? h.held : 0n), feeAsset: async (p) => p, fee: async () => 7n,
    name: (x) => (x === RA ? 'RSB' : x === X ? 'USDX' : x), ensure: async () => {},
    take: async (entry, { receive, feeAsset, onTxid }) => { const txid = String(h.takes.length + 1).padStart(64, 'f'); onTxid(txid); h.takes.push({ entry, receive, feeAsset }); return { txid } },
    status: (txid) => h.status[txid] || 'unknown',
    ...over,
  }
  return h
}

function engine (s, h, now) {
  return createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, btc: s.btc, restricted: h.R, ...(now ? { now } : {}) })
}

// The first step: the BTC desk's purchase taken to settled (as user-trade-btc.test.mjs's).
async function settleFirst (eng, s, h) {
  s.receives[H].state = 'issuing'; s.ready = true
  for (let i = 0; i < 3; i++) await eng.resume()
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  h.held = 99381n
  // The composed record comes before its step in the store: it sees the step settled at the next pass.
  await eng.resume(); await eng.resume()
}
const composed = (eng) => eng.records().find((r) => r.source === 'composed')
const steps = (eng) => eng.records().filter(isStep)

test('bitcoin for a restricted asset is one ticket: the bitcoin paid, the asset received, every fee', async () => {
  const s = standIn(); const h = restrictedHost()
  const q = await engine(s, h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.ok(q.ok, `priced as one trade, not "${q.why}" ${q.card ? q.card.text : ''}`)
  assert.equal(q.ticket.source, 'composed')
  assert.equal(q.ticket.payAsset, 'BTC'); assert.equal(q.ticket.receiveAsset, RA)
  assert.equal(q.ticket.amountIn, '50000')
  // 50,000 sat brings 99,381 USDX (less the receive fee, the claim's margins and the settle fee);
  // less the second step's fee of 7, that buys the gated order's 400 for 800.
  assert.equal(q.ticket.amountOut, '400')
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '619' }, { asset: X, atoms: '7' }])
  assert.equal(q.ticket.keep, String(99381n - 800n - 7n), 'what of USDX the second step leaves is the wallet\'s, and said')
  assert.equal(q.choice.via, X)
})

test('one confirmation: the bitcoin step first; the restricted step by itself once it settled; Settled', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  let r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.source, 'composed'); assert.equal(r.state, 'waiting', 'nothing of the wallet\'s has left yet')
  assert.equal(steps(eng).length, 1); assert.equal(steps(eng)[0].source, 'btc-gateway'); assert.equal(steps(eng)[0].partOf, r.id)
  await settleFirst(eng, s, h)
  assert.equal(steps(eng)[0].state, 'settled')
  r = composed(eng)
  assert.equal(h.takes.length, 1, 'the second step went by itself')
  assert.equal(h.takes[0].receive, 400n); assert.equal(h.takes[0].feeAsset, X)
  assert.equal(steps(eng).length, 2); assert.equal(steps(eng)[1].source, 'restricted')
  assert.equal(r.state, 'sent')
  h.status[steps(eng)[1].txid] = 'confirmed'
  await eng.resume(); await eng.resume()
  r = composed(eng)
  assert.equal(r.state, 'settled'); assert.equal(r.viaHeld, false)
  // History shows what moved (the two steps), never the composed trade a third time.
  const rows = tradeRows(eng.records())
  assert.deepEqual(rows.map((x) => x.trade.source).sort(), ['btc-gateway', 'restricted'])
})

test('the second step goes only at the ticket\'s terms; until then the person holds the asset bought, and is told', async () => {
  let t = 1_000_000
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h, () => t)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  // The gated order is taken by someone else: only the maker's quote is left, at 300 for 50,000,000.
  h.book = [offers[0]]
  await settleFirst(eng, s, h)
  let r = composed(eng)
  assert.equal(h.takes.length, 0, 'nothing worse than the ticket is taken')
  assert.equal(r.viaHeld, true); assert.notEqual(r.state, 'settled')
  assert.equal(RESTRICTED_WORDS.viaWaiting('USDX', 'RSB'), 'Your bitcoin bought USDX. It buys RSB by itself as soon as an offer allows; until then the USDX is yours.')
  // Asked again only after a while.
  h.book = offers
  await eng.resume()
  assert.equal(h.takes.length, 0)
  t += COMPOSED_RETRY_MS
  await eng.resume()
  assert.equal(h.takes.length, 1, 'the offer is back: the step goes by itself')
  h.status[steps(eng)[1].txid] = 'confirmed'
  t += 1000; await eng.resume(); await eng.resume()
  assert.equal(composed(eng).state, 'settled')
})

test('a second step that never can: the trade ends with the asset bought, said so, its fees only the first step\'s', async () => {
  let t = 1_000_000
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h, () => t)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  // The issuer pauses this wallet after the ticket: the second step is refused before anything moves.
  h.card = { text: 'This wallet is paused for this asset by its issuer.' }
  await settleFirst(eng, s, h)
  assert.equal(composed(eng).viaHeld, true)
  t += COMPOSED_SECOND_MS
  await eng.resume()
  const r = composed(eng)
  assert.equal(r.state, 'settled'); assert.equal(r.ended, 'via'); assert.equal(h.takes.length, 0)
  assert.deepEqual(r.firstFees, [{ asset: X, atoms: '619' }])
})

test('a first step that comes back returns the trade, with nothing taken', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  s.receives[H].state = 'failed'
  await eng.resume(); await eng.resume()
  assert.equal(composed(eng).state, 'returned'); assert.equal(h.takes.length, 0); assert.equal(s.btcPaid.length, 0)
})

test('not composed: an unapproved buyer gets the approval card; bitcoin the wallet lacks is said as for any purchase', async () => {
  const s = standIn(); const h = restrictedHost()
  h.card = { text: 'Only approved holders can hold RSB.', code: 'AID' }
  let q = await engine(s, h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.equal(q.why, 'approval')
  h.card = null
  const poor = standIn(); poor.btc.balance = async () => 0n
  q = await engine(poor, h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.equal(q.why, 'no-funds')
  // A book that sells nothing at any size the first step brings: the card naming the asset to go through.
  h.book = []
  q = await engine(standIn(), h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.equal(q.why, 'btc-route'); assert.deepEqual(q.card.choices, [X])
})

test('a ticket let go of releases its first step\'s firm offer', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  const before = s.posts.filter(([p]) => p === 'release').length
  eng.drop(q.choice)
  assert.equal(s.posts.filter(([p]) => p === 'release').length, before + 1)
})

test('the words a composed purchase uses name no rail or protocol', () => {
  for (const t of [RESTRICTED_WORDS.viaWaiting('USDX', 'RSB'), RESTRICTED_WORDS.viaHeld('USDX'), RESTRICTED_WORDS.viaKeep('0.5 USDX')]) {
    assert.deepEqual(forbiddenIn(t), [], t)
    assert.doesNotMatch(t, /can(no|')t be traded|not tradable|cannot trade/i, t)
  }
})
