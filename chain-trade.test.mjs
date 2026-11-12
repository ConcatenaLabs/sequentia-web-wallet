// A trade paid with money the wallet holds on the chain (a payment received there a moment ago):
// taken by an order on the chain at once when a book offers one for the pair and the whole amount;
// otherwise priced at once, the ticket saying how long it takes, and, once confirmed, the money is
// moved in first and the trade goes ahead by itself at the ticket's price or better (user-trade.js
// bringPlan, bringInTicket, advanceSettling). Never "try again".
//
// The engine on a stand-in library, maker and chain. The library behaves as the real one does
// (chain-money-library.test.mjs shows it): it reads no coin on the chain; after the move in, the
// board's coin is pending, `settle_first` waits on it until it is final, and a swap pays from it then.
//
//   node --test chain-trade.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, tradeStateWord } from './user-trade.js'
import { planPlaceOrder, buildCovenantTerms } from './covenant-order.js'

const X = 'aa'.repeat(31) + '01', Y = 'bb'.repeat(31) + '02'
const rev = (h) => h.match(/../g).reverse().join('')

const realSetTimeout = globalThis.setTimeout
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}
const tick = () => new Promise((r) => realSetTimeout(r, 0))

function settleFirst (coins) {
  const e = new Error('refused: the wallet\'s coins of asset ' + X + ' that pay this now hold 0 … not final yet … settle them first (settle_first)')
  e.kind = 'settle_first'; e.asset = X; e.coins = coins
  return e
}

// The wallet holds `onchain` of X on the chain and nothing in the tree. `bringIn` boards it (less a
// fee of 39): a pending coin, final once `credit()` is called; `rollBack()` makes it pending again,
// as an anchor rollback does. The maker sells Y for X at rateNum/rateDen X per Y.
function standIn ({ onchain = 3000000n, rateNum = 4n, rateDen = 3n } = {}) {
  const s = { coins: [], accepts: [], brings: 0, posts: [], swaps: [], chain: onchain, rateNum, rateDen, t: 1_000_000 }
  const board = () => s.coins.find((c) => c.leaf_id === 'b1')
  s.lib = {
    command (cmd, a) {
      switch (cmd) {
        case 'coins': return s.coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'participations': return []
        case 'swaps': return s.swaps.map((x) => ({ ...x }))
        case 'sync': return {}
        case 'settle_first': {
          const b = board()
          if (b && b.state === 'pending') return { settling: [], waiting: ['b1'], done: [], left: [], ready: false }
          return { settling: [], waiting: [], done: [], left: [], ready: true }
        }
        case 'swap_read':
          if (board() && board().state === 'pending') throw settleFirst(['b1'])
          if (!board()) { const e = new Error('refused: the wallet holds 0 of asset ' + X + ' in live coins'); e.kind = 'refused'; throw e }
          return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: a.offer.split(':')[2] }, pays: { asset: X, margins: '192' },
            change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } }
        case 'swap_accept': {
          if (!board() || board().state === 'pending') throw settleFirst(['b1'])
          s.accepts.push(a.offer); s.swaps.push({ swap: 's' + s.accepts.length, role: 'taker', state: 'accepted' })
          return { swap: 's' + s.accepts.length, accept: 'swap-accept:xyz' }
        }
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '0', after: a.value }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(s.rateNum), rate_den: String(s.rateDen), max_give: '5000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    s.posts.push(url.split('/v1/')[1])
    if (url.endsWith('/v1/firm')) {
      const want = (BigInt(b.give) * s.rateNum + s.rateDen - 1n) / s.rateDen
      return { swap: 's1', offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) }
    }
    if (url.endsWith('/v1/accept')) { for (const x of s.swaps) x.state = 'done'; return { state: 'done' } }
    return {}
  }
  s.store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  s.wants = []
  s.bringIn = async (asset, want) => {
    s.brings++; s.wants.push(want)
    if (asset !== X || board() || s.chain <= 0n) return board() ? { already: true } : null
    s.coins.push({ leaf_id: 'b1', asset: X, value: String(s.chain - 39n), state: 'pending', kind: 'board' })
    s.chain = 0n
    return { boarded: true }
  }
  s.credit = () => { board().state = 'live' }
  s.rollBack = () => { board().state = 'pending' }
  // What the page tells the engine: the balance (the chain, and what the tree holds), and the chain.
  s.held = () => s.chain + s.coins.filter((c) => c.asset === X).reduce((n, c) => n + BigInt(c.value), 0n)
  s.chainDep = () => ({ atoms: s.chain, movable: s.chain, margin: 2000n, minutes: 5 })
  return s
}

const admitted = (sources = ['leaf-maker']) => () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(), store: s.store,
  sleep: async () => {}, quoteFirmMs: 2000, now: () => s.t, held: s.held, chain: s.chainDep, bringIn: s.bringIn, ...extra })

async function confirmed (s, eng, amount = '400000') {
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount })
  assert.ok(q.ok, 'priced at once, not ' + q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  return { q, rec }
}
const recOf = (eng, rec) => eng.records().find((x) => x.id === rec.id)

test('money only on the chain, no order on the chain: priced at once, the ticket says how long, never "try again"', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  console.log('quote of 400,000 X held only on the chain ->', q.ok ? JSON.stringify(q.ticket) : q.why)
  assert.notEqual(q.why, 'settle-first', 'settled first (nothing to settle), then "This is taking longer than usual … try again"')
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.bringIn, 5, 'the ticket says it goes through within about 5 minutes')
  assert.equal(USER_WORDS.bringIn(q.ticket.bringIn), 'Goes through within about 5 minutes')
  assert.equal(q.ticket.amountIn, '400000')
  assert.equal(q.ticket.amountOut, '298500', 'at the maker\'s price, 4 X per 3 Y, for what is paid less 2,000 kept for the fees')
  assert.equal(s.brings, 0, 'nothing is moved before the person confirms')
})

test('confirmed: moved in once, the trade waits, then goes ahead once at the ticket\'s price', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const { q, rec } = await confirmed(s, eng)
  assert.equal(rec.state, 'settling')
  assert.equal(tradeStateWord(rec, s.t), 'Goes through within about 5 minutes')
  await tick()
  assert.equal(s.brings, 1, 'the money is moved in when the trade is confirmed')
  assert.equal(s.wants[0], 402000n, 'once the chain holds what it pays and the 2,000 kept for the fees')
  // Not final yet: the trade waits, and asks for nothing.
  for (let i = 0; i < 3; i++) { s.t += 30_000; assert.equal((await eng.advance(recOf(eng, rec))).state, 'settling') }
  assert.equal(s.accepts.length, 0)
  s.credit()
  s.t += 30_000
  const r = await eng.advance(recOf(eng, rec))
  console.log('after the move in is final:', r.state, 'pay', r.ticket.amountIn, 'receive', r.ticket.amountOut, 'accepts', s.accepts.length)
  assert.equal(r.state, 'sent')
  assert.equal(s.accepts.length, 1)
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut))
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn) + 2n)
})

test('two follows overlapping once the money is in accept the trade once', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const { rec } = await confirmed(s, eng)
  await eng.advance(recOf(eng, rec))
  s.credit()
  await Promise.all([eng.resume(), eng.resume(), eng.advance(recOf(eng, rec))])
  for (let i = 0; i < 3; i++) await eng.resume()
  console.log('overlapping follows: accepts', s.accepts.length, 'records', eng.records().map((x) => x.state).join(','))
  assert.equal(s.accepts.length, 1)
  assert.equal(eng.records().length, 1)
})

test('a price that moved while the money came in: returned with the words, nothing traded', async () => {
  const s = standIn({ rateNum: 400n, rateDen: 300n })
  const eng = engineOf(s)
  const { rec } = await confirmed(s, eng)
  s.rateNum = 400n * 1009n; s.rateDen = 300n * 1000n
  s.credit()
  let r = recOf(eng, rec)
  for (let i = 0; i < 4 && r.state === 'settling'; i++) { s.t += 30_000; r = await eng.advance(recOf(eng, rec)) }
  assert.equal(r.state, 'returned')
  assert.equal(tradeStateWord(r), USER_WORDS.returnedMoved)
  assert.equal(s.accepts.length, 0)
  assert.equal(s.held(), 3000000n - 39n, 'the money is the wallet\'s, in the tree now, less the move\'s fee')
})

test('an anchor rollback while it waits: the moved coin is pending again; the trade waits and goes once, the wallet whole', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const { rec } = await confirmed(s, eng)
  s.credit(); s.rollBack()
  for (let i = 0; i < 3; i++) { s.t += 30_000; assert.equal((await eng.advance(recOf(eng, rec))).state, 'settling') }
  assert.equal(s.accepts.length, 0, 'nothing is accepted from a coin that is not final')
  assert.equal(s.held(), 3000000n - 39n, 'still held, counted once')
  s.credit()
  s.t += 30_000
  assert.equal((await eng.advance(recOf(eng, rec))).state, 'sent')
  assert.equal(s.accepts.length, 1)
})

test('the money never comes in within the wait: returned, nothing traded, never accepted', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const { rec } = await confirmed(s, eng)
  s.t += 16 * 60_000
  const r = await eng.advance(recOf(eng, rec))
  assert.equal(r.state, 'returned')
  assert.equal(r.whyKind, 'late')
  assert.equal(s.accepts.length, 0)
})

test('an order on the chain that takes the whole amount: taken at once from the chain, nothing moved in', async () => {
  const params = { assetA: rev(Y), assetB: rev(X), sellAtoms: 1000000n, rateNum: 4n, rateDen: 3n, minLot: 10000n,
    expiryLocktime: 1900000000, makerProg: '11'.repeat(32), makerX: '22'.repeat(32) }
  const plan = planPlaceOrder(params)
  const terms = buildCovenantTerms(plan.order, 'cd'.repeat(32), 0, plan.tap)
  const offer = { offer_id: 'o1', offer_asset: Y, want_asset: X, offer_amount: '1000000', covenant: terms, _verified: true, _status: { active_amount: '1000000' } }
  const s = standIn()
  const taken = []
  const eng = engineOf(s, { admitted: admitted(['leaf-maker', 'onchain-fill']), relayBook: async () => [offer],
    onchain: { balance: () => s.chain, fee: () => ({ asset: X, atoms: 50n }), take: async (m, { onTxid }) => { taken.push(m); onTxid('f1'.repeat(32)); return { txid: 'f1'.repeat(32) } }, status: () => 'pending' } })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400050' })
  console.log('with an order on the chain ->', q.ok ? q.ticket.source + ' ' + q.ticket.amountOut : q.why)
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'onchain-fill')
  assert.equal(q.ticket.bringIn, undefined)
  const r = await eng.confirm(q.choice, q.ticket)
  assert.equal(r.state, 'sent')
  assert.equal(taken.length, 1)
  assert.equal(s.brings, 0)
})

test('more than the balance: said at once, nothing moved in', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '5000000' })
  assert.deepEqual([q.ok, q.why], [false, 'part-ready'])
  assert.equal(s.brings, 0)
})
