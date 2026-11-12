// restricted-composed.js through the composer's engine (user-trade.js): bitcoin buys a restricted
// asset as one trade. The first step is the engine's own bitcoin purchase, against stand-ins of the
// leaf library, a maker's BTC desk and a Bitcoin Lightning wallet (as user-trade-btc.test.mjs); the
// move of its coin out of the tree is the leaf library's offboard of named coins, against a
// stand-in that prices it as the library does (the fee taken from the coin, no change, the coin
// named or refused); the trade on the chain is the restricted trade against a stand-in policy
// server and book (as restricted-trade.test.mjs). All three on a real operator and node, signed by
// the libraries, are the regtest drive the pull request names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEngine, forbiddenIn } from './user-trade.js'
import { RESTRICTED_WORDS } from './restricted-trade.js'
import { COMPOSED_SECOND_MS, COMPOSED_RETRY_MS, MOVE_POLL_MS, isStep, claimOnce, secondId } from './restricted-composed.js'
import { tradeRows } from './instant-history.js'

const seqob = await import('./seqob.js')
const vectors = JSON.parse(fs.readFileSync(new URL('./restricted-offer-vectors.json', import.meta.url)))
const mkOffers = (active) => vectors.map((v) => { const o = JSON.parse(JSON.stringify(v)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _status: { active_amount: active } } })
const offers = mkOffers('400')
const RA = offers[0].pair.base_asset // the restricted asset
const X = offers[0].pair.quote_asset // what bitcoin buys and what buys it
const H = 'cd'.repeat(32), P = 'ef'.repeat(32)
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

// The move out of the tree as the library prices it (arca offboard.rs, whole_amount): a fixed part
// and 1,000 ppm, taken from the coin.
const moveFee = (v) => 20n + (BigInt(v) * 1000n + 999_999n) / 1_000_000n
// The BTC desk, the leaf library and the Lightning wallet (user-trade-btc.test.mjs's stand-in, the
// purchase only): 1 sat buys 2 atoms of X. The library also moves named coins out of the tree.
function standIn () {
  const s = { coins: [], receives: {}, btcPaid: [], invoices: {}, parts: [], posts: [], ready: false, offboards: [], asked: [], settleAsked: [] }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  const coin = (id) => s.coins.find((c) => c.leaf_id === id)
  s.lib = {
    command (cmd, a) {
      s.asked.push([cmd, a])
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
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'received'; s.receives[a.hash].leaf = 'r1'; s.coins.push({ leaf_id: 'r1', asset: X, value: '99384', state: 'live', hops: 9 }); return {}
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        case 'settle_first': s.settleAsked.push(a.coins); return { ready: false }
        case 'offboard_quote': {
          if (a.value != null) { const f = moveFee(a.value); return { asset: a.asset, value: a.value, amount: String(BigInt(a.value) - f), fee: { asset: a.asset, amount: String(f) }, change: '0' } }
          if (!a.coins) throw new Error('an offboard by amount: the composed trade names its coin')
          const c = coin(a.coins[0])
          if (!c || c.state !== 'live' || a.coins.length !== 1) { const e = new Error(`refused: coin ${a.coins[0]} is not a live coin`); e.kind = 'refused'; throw e }
          if (c.arriving) { const e = new Error('settle them first (settle_first)'); e.kind = 'settle_first'; e.coins = [c.leaf_id]; throw e }
          const f = s.moveFeeAt ? s.moveFeeAt(c.value) : moveFee(c.value)
          return { asset: a.asset, amount: String(BigInt(c.value) - f), fee: { asset: a.asset, amount: String(f) }, gives: [c.leaf_id], change: '0', address: a.address }
        }
        case 'offboard': {
          const q = s.lib.command('offboard_quote', { asset: a.asset, coins: a.coins, address: a.address })
          assert.deepEqual(a.shown.fee, q.fee); assert.deepEqual(a.shown.gives, q.gives)
          const c = coin(a.coins[0]); c.state = 'given'; c.note = 'offboard ob' + s.offboards.length
          const o = { offboard: 'ob' + s.offboards.length, asset: a.asset, amount: q.amount, address: a.address, state: 'waiting', coins: a.coins }
          s.offboards.push(o)
          return { offboard: o.offboard, amount: q.amount, gives: q.gives, change: '0' }
        }
        case 'offboards': return s.offboards.map((o) => ({ ...o }))
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
// The operator's round and unlock paid an offboard: its output on the chain at the wallet's address.
function paid (s, h, i = 0) {
  const o = s.offboards[i]; o.state = 'paid'; o.txid = 'a'.repeat(63) + String(i); o.vout = 1
  s.coins.find((c) => c.leaf_id === o.coins[0]).state = 'spent'
  h.chain.push({ txid: o.txid, vout: 1, asset: X, value: BigInt(o.amount) })
}

// The page's restricted host (deps.restricted), with the two offers of the vectors: the maker's
// quote (300 for 50,000,000 X) and the gated order (400, all it holds, for 800 X). Its take pays the
// asset paid from the outpoints it is given (`only`) and no other coin, as the page's host does.
function restrictedHost (over = {}) {
  const h = { takes: [], status: {}, book: offers, card: null, eligAsked: [], fee: 7n, chain: [], spent: new Set() }
  h.R = {
    available: async () => true, isRestricted: (x) => x === RA, book: async () => h.book,
    sellers: async () => [{ asset: X }], btcBuys: (x) => x === X,
    eligible: async (a, atoms) => { h.eligAsked.push(BigInt(atoms)); return typeof h.card === 'function' ? h.card(BigInt(atoms)) : h.card },
    held: async (x) => (x === X ? h.chain.filter((c) => !h.spent.has(c.txid)).reduce((n, c) => n + c.value, 0n) : 0n),
    feeAsset: async (p) => p, fee: async () => h.fee,
    name: (x) => (x === RA ? 'RSB' : x === X ? 'USDX' : x), ensure: async () => {},
    address: async () => 'tex1qwallet',
    unspent: async (op) => !h.spent.has(op.txid),
    take: async (entry, { receive, feeAsset, only, onTxid }) => {
      if (h.refuse) { const e = new Error('refused: ' + h.refuse); e.kind = 'refused'; throw e }
      const txid = String(h.takes.length + 1).padStart(64, 'f'); onTxid(txid)
      for (const o of only || []) h.spent.add(o.txid)
      h.takes.push({ entry, receive, feeAsset, only }); return { txid }
    },
    status: (txid) => h.status[txid] || 'unknown',
    ...over,
  }
  return h
}

// The engine on a clock the test moves (s.t), unless given its own.
function engine (s, h, now, more = {}) {
  s.t = s.t || 1_000_000
  return createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, btc: s.btc, restricted: h.R,
    now: now || (() => s.t), ...more })
}

// The first step: the BTC desk's purchase taken to settled (as user-trade-btc.test.mjs's). The
// composed record comes before its step in the store: it sees the step settled at the next pass,
// which `only` leaves to the test.
async function settleFirst (eng, s, only = false) {
  s.receives[H].state = 'issuing'; s.ready = true
  for (let i = 0; i < 3; i++) await eng.resume()
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  await eng.resume()
  if (!only) await eng.resume()
}
const composed = (eng) => eng.records().find((r) => r.source === 'composed')
const steps = (eng) => eng.records().filter(isStep)
const second = (eng) => steps(eng).filter((r) => r.source === 'restricted')
// The rest after the first step: the move asked, paid, then the trade on the chain.
async function moveAndTake (eng, s, h) {
  await eng.resume()
  assert.equal(s.offboards.length, 1, 'the coin the first step brought is moved out')
  paid(s, h)
  s.t += MOVE_POLL_MS
  await eng.resume()
}

test('bitcoin for a restricted asset is one ticket: the bitcoin paid, the asset received, every fee, the move out of the tree among them', async () => {
  const s = standIn(); const h = restrictedHost()
  const q = await engine(s, h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.ok(q.ok, `priced as one trade, not "${q.why}" ${q.card ? q.card.text : ''}`)
  assert.equal(q.ticket.source, 'composed')
  assert.equal(q.ticket.payAsset, 'BTC'); assert.equal(q.ticket.receiveAsset, RA)
  assert.equal(q.ticket.amountIn, '50000')
  // 50,000 sat brings a coin of 99,381 USDX (less the receive fee, the claim's margins and the
  // settle fee); its move to the chain costs 120 of it, priced before the coin exists; the trade on
  // the chain's fee of 7 is paid from the 99,261 that lands; that buys the gated order's 400 for 800.
  const mv = s.asked.find(([c, a]) => c === 'offboard_quote')
  assert.ok(mv && mv[1].value === '99381' && mv[1].expiry > 0 && !mv[1].coins, 'the move priced for the coin the purchase brings, by its value')
  assert.equal(q.ticket.amountOut, '400')
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '619' }, { asset: X, atoms: '120' }, { asset: X, atoms: '7' }])
  assert.equal(q.ticket.keep, String(99381n - 120n - 800n - 7n), 'what of USDX the rest leaves is the wallet\'s, and said')
  assert.equal(q.choice.via, X)
  // Every atom of the coin is in the ticket: paid on, a fee, or kept.
  assert.equal(800n + 619n - 619n + 120n + 7n + BigInt(q.ticket.keep), 99381n)
})

test('one confirmation: the bitcoin step; the coin it brought, alone and whole, moved out; the trade on the chain from what landed; Settled', async () => {
  const s = standIn(); const h = restrictedHost()
  // Other USDX of the person's, in the tree and on the chain: none of it moves.
  s.coins.push({ leaf_id: 'mine', asset: X, value: '500000', state: 'live' })
  h.chain.push({ txid: 'b'.repeat(64), vout: 0, asset: X, value: 70000n })
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  let r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.source, 'composed'); assert.equal(r.state, 'waiting', 'nothing of the wallet\'s has left yet')
  assert.equal(steps(eng).length, 1); assert.equal(steps(eng)[0].source, 'btc-gateway'); assert.equal(steps(eng)[0].partOf, r.id)
  await settleFirst(eng, s)
  assert.equal(steps(eng)[0].state, 'settled')
  await moveAndTake(eng, s, h)
  const ob = s.asked.filter(([c]) => c === 'offboard')
  assert.equal(ob.length, 1)
  assert.deepEqual(ob[0][1].coins, ['r1'], 'the coin the purchase brought, and no other')
  assert.equal(ob[0][1].address, 'tex1qwallet')
  assert.equal(s.coins.find((c) => c.leaf_id === 'mine').state, 'live', 'the person\'s other USDX in the tree is untouched')
  assert.equal(h.takes.length, 1, 'the trade on the chain went by itself')
  assert.equal(h.takes[0].receive, 400n); assert.equal(h.takes[0].feeAsset, X)
  assert.deepEqual(h.takes[0].only, [{ txid: s.offboards[0].txid, vout: 1, asset: X }], 'paid from what the move put on the chain alone')
  assert.ok(!h.spent.has('b'.repeat(64)), 'the person\'s other USDX on the chain is untouched')
  r = composed(eng)
  assert.equal(r.state, 'sent'); assert.equal(second(eng).length, 1)
  h.status[second(eng)[0].txid] = 'confirmed'
  await eng.resume(); await eng.resume()
  r = composed(eng)
  assert.equal(r.state, 'settled'); assert.equal(r.viaHeld, false)
  // History shows what moved (the two steps), never the composed trade a third time.
  const rows = tradeRows(eng.records())
  assert.deepEqual(rows.map((x) => x.trade.source).sort(), ['btc-gateway', 'restricted'])
})

test('a gated purchase that uses every atom the move lands still goes: the move\'s fee comes out of the coin, as the ticket priced it', async () => {
  const s = standIn(); const h = restrictedHost({ book: async () => mkOffers('1000000000') })
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.ok(q.ok, q.why)
  assert.ok(!q.ticket.keep || BigInt(q.ticket.keep) < 2n, 'the gated order takes all the USDX: ' + q.ticket.keep)
  await eng.confirm(q.choice, q.ticket)
  await settleFirst(eng, s)
  await moveAndTake(eng, s, h)
  assert.equal(h.takes.length, 1, 'taken')
  assert.ok(h.takes[0].receive >= BigInt(q.ticket.amountOut), 'at least the ticket\'s amount')
})

test('the coin the purchase brought, spent by the person before it is moved: no other coin of theirs moves, and the trade ends holding what they hold', async () => {
  const s = standIn(); const h = restrictedHost()
  s.coins.push({ leaf_id: 'mine', asset: X, value: '120000', state: 'live' })
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  await settleFirst(eng, s, true)
  const r1 = s.coins.find((c) => c.leaf_id === 'r1'); r1.state = 'spent'; r1.spent_by = 'payment'
  await eng.resume()
  const r = composed(eng)
  assert.equal(r.state, 'settled'); assert.equal(r.ended, 'via'); assert.equal(r.endWhy, 'spent')
  assert.equal(s.asked.filter(([cmd]) => cmd === 'offboard').length, 0, 'nothing moves out of the tree')
  assert.equal(h.takes.length, 0)
})

test('what the move put on the chain, spent by the person before the trade: their other coins pay nothing of it', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  // No offer at the ticket's terms when the X lands.
  h.R.book = async () => [offers[0]]
  await settleFirst(eng, s)
  await moveAndTake(eng, s, h)
  assert.equal(h.takes.length, 0)
  // The person sends that X away, and receives 120,000 USDX from elsewhere; the offer comes back.
  h.spent.add(s.offboards[0].txid)
  h.chain.push({ txid: 'c'.repeat(64), vout: 0, asset: X, value: 120000n })
  h.R.book = async () => offers
  s.t += COMPOSED_RETRY_MS
  await eng.resume()
  const r = composed(eng)
  assert.equal(h.takes.length, 0, 'the USDX from elsewhere buys nothing')
  assert.equal(r.state, 'settled'); assert.equal(r.ended, 'via'); assert.equal(r.endWhy, 'spent')
})

test('two pages of one wallet (two engines, one store) move the coin once and take the trade once', async () => {
  const s = standIn(); const h = restrictedHost()
  const a = engine(s, h); const b = engine(s, h)
  const q = await a.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await a.confirm(q.choice, q.ticket)
  await settleFirst(a, s, true)
  // A slow library: both pages pass at once.
  const slow = h.R.take
  h.R.take = async (...x) => { await new Promise((r) => setTimeout(r, 30)); return slow(...x) }
  await Promise.all([a.resume(), b.resume(), a.resume(), b.resume()])
  assert.equal(s.asked.filter(([c]) => c === 'offboard').length, 1, 'one move')
  paid(s, h); s.t += MOVE_POLL_MS
  await Promise.all([a.resume(), b.resume(), a.resume(), b.resume()])
  s.t += COMPOSED_RETRY_MS
  await Promise.all([a.resume(), b.resume()])
  assert.equal(h.takes.length, 1, 'one take')
  assert.equal(second(a).length, 1)
})

test('the claim holds across pages where the browser has Web Locks: a second holder is turned away while the first runs', async () => {
  const names = new Set()
  const locks = { request: async (name, opts, fn) => { if (names.has(name)) return fn(null); names.add(name); try { return await fn({ name }) } finally { names.delete(name) } } }
  let inside = 0; let most = 0
  const run = () => claimOnce('t1', async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 10)); inside--; return 'done' }, locks)
  const got = await Promise.all([run(), run(), run()])
  assert.equal(most, 1)
  assert.deepEqual(got.filter(Boolean), ['done'])
})

test('a day of refusals: one record of the trade on the chain, the bitcoin step kept, and the trade ends holding the X', async () => {
  const s = standIn(); const h = restrictedHost()
  // Few ended records kept: the open trade's are kept whatever their number.
  const eng = engine(s, h, null, { keepEnded: 1 })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  const c = await eng.confirm(q.choice, q.ticket)
  await settleFirst(eng, s)
  h.refuse = 'the maker refused the quote it listed'
  await moveAndTake(eng, s, h)
  for (let m = 0; m < 300; m++) { s.t += COMPOSED_RETRY_MS; await eng.resume() }
  const tries = s.t
  assert.equal(second(eng).length, 1, 'one record, whatever the tries')
  assert.equal(second(eng)[0].id, secondId(c))
  assert.ok(steps(eng).some((r) => r.source === 'btc-gateway'), 'the bitcoin step is kept')
  assert.ok(tradeRows(eng.records()).some((x) => x.trade.source === 'btc-gateway'), 'History keeps the bitcoin paid')
  s.t = tries + COMPOSED_SECOND_MS
  // Once ended, its records are bounded as any trade's: the end is read from the advance itself.
  const r = await eng.advance(composed(eng))
  assert.equal(r.state, 'settled'); assert.equal(r.ended, 'via')
})

test('never at a fee above the ticket\'s: the move waits while its fee is higher', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  // The operator's fees rose: the move waits.
  s.moveFeeAt = () => 900n
  await settleFirst(eng, s)
  assert.equal(s.asked.filter(([c]) => c === 'offboard').length, 0, 'not moved at 900 against the ticket\'s 120')
  // Back within the ticket: moved, then traded.
  s.moveFeeAt = null; s.t += COMPOSED_RETRY_MS
  await moveAndTake(eng, s, h)
  assert.equal(h.takes.length, 1)
})

test('never at a fee above the ticket\'s: the trade on the chain waits while its fee is higher', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  h.fee = 900n
  await settleFirst(eng, s)
  await moveAndTake(eng, s, h)
  s.t += COMPOSED_RETRY_MS; await eng.resume()
  assert.equal(h.takes.length, 0, 'not taken at 900 against the ticket\'s 7')
  h.fee = 7n; s.t += COMPOSED_RETRY_MS; await eng.resume()
  assert.equal(h.takes.length, 1)
})

test('the approval is asked for what the ticket brings, before the bitcoin moves', async () => {
  const s = standIn(); const h = restrictedHost()
  // The issuer approves this wallet for up to 100 atoms.
  h.card = (atoms) => (atoms > 100n ? { text: 'Only approved holders can hold RSB.', code: 'AID' } : null)
  const q = await engine(s, h).quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  assert.equal(q.ok, false); assert.equal(q.why, 'approval')
  assert.ok(h.eligAsked.includes(400n), 'asked for 400: ' + h.eligAsked)
  assert.equal(s.btcPaid.length, 0)
})

test('a buyer frozen between the steps: told what they hold, that the trade waits on their approval, and how to get it; nothing taken until approved', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  const card = { text: 'Ask Example Issuer to approve this wallet for RSB.', code: 'AID', link: { text: 'Open Example Issuer\'s page', url: 'https://example.com' } }
  h.card = card
  await settleFirst(eng, s)
  await moveAndTake(eng, s, h)
  let r = composed(eng)
  assert.equal(h.takes.length, 0)
  assert.deepEqual(r.card, card); assert.equal(r.viaHeld, true)
  assert.equal(RESTRICTED_WORDS.viaApproval('USDX', 'RSB'), 'Your bitcoin bought USDX. It buys RSB once its issuer approves this wallet; until then the USDX is yours.')
  h.card = null; s.t += COMPOSED_RETRY_MS; await eng.resume()
  r = composed(eng)
  assert.equal(h.takes.length, 1); assert.equal(r.card, null)
})

test('a coin that must go through a round before it can leave the tree: settled first, as anywhere in the wallet, then moved as it is then', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  await settleFirst(eng, s, true)
  s.coins.find((c) => c.leaf_id === 'r1').arriving = true
  await eng.resume()
  assert.deepEqual(s.settleAsked, [['r1']], 'that coin put through the next round')
  assert.equal(s.asked.filter(([c]) => c === 'offboard').length, 0)
  // The round refreshed it alone: a coin of the wallet's own in its place.
  const r1 = s.coins.find((c) => c.leaf_id === 'r1'); r1.state = 'spent'; r1.spent_by = 'participation ' + 'f'.repeat(64)
  s.parts = [{ participation: 'f'.repeat(64), state: 'released', gives: [{ leaf_id: 'r1' }], new_leaves: [{ asset: X, leaf_id: 'r2', state: 'live' }] }]
  s.coins.push({ leaf_id: 'r2', asset: X, value: '99380', state: 'live' })
  s.t += COMPOSED_RETRY_MS
  await eng.resume()
  const ob = s.asked.filter(([c]) => c === 'offboard')
  assert.equal(ob.length, 1); assert.deepEqual(ob[0][1].coins, ['r2'])
  paid(s, h); s.t += MOVE_POLL_MS; await eng.resume()
  assert.equal(h.takes.length, 1)
})

test('a coin refreshed together with others is no longer the purchase\'s alone: the trade ends holding it, and nothing of the person\'s moves', async () => {
  const s = standIn(); const h = restrictedHost()
  const eng = engine(s, h)
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: RA, amount: '50000' })
  await eng.confirm(q.choice, q.ticket)
  await settleFirst(eng, s, true)
  const r1 = s.coins.find((c) => c.leaf_id === 'r1'); r1.state = 'spent'; r1.spent_by = 'participation ' + 'e'.repeat(64)
  s.parts = [{ participation: 'e'.repeat(64), state: 'released', gives: [{ leaf_id: 'r1' }, { leaf_id: 'mine' }], new_leaves: [{ asset: X, leaf_id: 'm2', state: 'live' }] }]
  await eng.resume()
  const r = composed(eng)
  assert.equal(r.ended, 'via'); assert.equal(r.endWhy, 'merged')
  assert.equal(s.asked.filter(([c]) => c === 'offboard').length, 0)
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
  assert.equal(RESTRICTED_WORDS.viaKeep('0.5 USDX'), 'You also get 0.5 USDX.')
  for (const t of [RESTRICTED_WORDS.viaWaiting('USDX', 'RSB'), RESTRICTED_WORDS.viaHeld('USDX'), RESTRICTED_WORDS.viaKeep('0.5 USDX'), RESTRICTED_WORDS.viaApproval('USDX', 'RSB')]) {
    assert.deepEqual(forbiddenIn(t), [], t)
    assert.doesNotMatch(t, /can(no|')t be traded|not tradable|cannot trade/i, t)
  }
})

test('a restricted trade whose page closed while its move ran is followed while the move runs, never ended as not made (#697)', async () => {
  const { RESTRICTED_MOVE_MOST_MS } = await import('./user-trade.js')
  const s = standIn(); s.t = 10_000_000
  let moving = true
  const h = restrictedHost({ moving: async () => moving })
  const rec = { id: 'r1', at: s.t, source: 'restricted', state: 'confirming', entry: 'e1', movingSince: s.t,
    ticket: { payAsset: X, receiveAsset: RA, amountIn: '800', amountOut: '400', fees: [{ asset: X, atoms: '7' }], source: 'restricted' } }
  s.store.setItem('swk.usertrade.default', JSON.stringify([rec]))
  // The page opens again 20 minutes later, the move still under way: the trade is followed.
  s.t += 20 * 60_000
  const eng = engine(s, h)
  await eng.resume()
  let r = eng.records().find((x) => x.id === 'r1')
  assert.equal(r.state, 'confirming', 'a trade whose move still runs is not ended')
  // The move over and nothing traded: ended then, as nothing traded.
  moving = false
  await eng.resume()
  r = eng.records().find((x) => x.id === 'r1')
  assert.equal(r.state, 'failed'); assert.equal(r.error, 'not made'); assert.equal(r.movingSince, undefined)
  // A move followed past its longest wait ends too, whatever the library says.
  const s2 = standIn(); s2.t = 10_000_000
  s2.store.setItem('swk.usertrade.default', JSON.stringify([{ ...rec, at: s2.t, movingSince: s2.t }]))
  s2.t += RESTRICTED_MOVE_MOST_MS + 1
  const eng2 = engine(s2, restrictedHost({ moving: async () => true }))
  await eng2.resume()
  assert.equal(eng2.records().find((x) => x.id === 'r1').state, 'failed')
})
