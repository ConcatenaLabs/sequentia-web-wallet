// A trade that settles first goes ahead once, and only at the price the person accepted or better;
// an amount above the balance is said at once. The engine (user-trade.js) on a stand-in library and
// maker whose one coin of X must be settled before it can be traded.
//
//   node --test settle-first-once.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, tradeStateWord } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)

// The composer's own timers (its follow of open trades, its price estimates) never keep this file
// running once its tests are done.
const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

// The library's refusal as the page's worker hands it on (leaves.js LeafError carries these fields).
function settleFirst (coins) {
  const e = new Error('refused: the wallet\'s coins of asset ' + X + ' … settle them first (settle_first)')
  e.kind = 'settle_first'; e.asset = X; e.coins = coins
  return e
}

// A stand-in library and maker. The wallet's one coin of X (`c1`) is too deep for part of it to
// be traded until a round settles it: `swap_read` (at the quote) or `swap_accept` (at the
// confirmation, with `deepAt: 'accept'`) answers settle_first naming it; `settle_first` gives it up
// once, and is ready after the next sync; the round gives the wallet `c2`, which trades.
function standIn ({ deepAt = 'read', rateNum = 4n, rateDen = 3n, maxGive = 1000000n } = {}) {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'transfer', hops: 3 }]
  const swaps = []
  const calls = []
  const settleAsks = []
  const accepts = []
  let given = false, synced = false, last = null
  const deep = () => coins.some((c) => c.leaf_id === 'c1' && c.state !== 'spent')
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_read':
          if (deepAt === 'read' && deep()) throw settleFirst(['c1'])
          return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: a.offer.split(':')[2] }, pays: { asset: X, margins: '192' },
            change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } }
        case 'swap_accept':
          if (deep()) throw settleFirst(['c1'])
          last = a.offer.split(':'); accepts.push(a.offer); swaps.push({ swap: 's' + accepts.length, role: 'taker', state: 'accepted' })
          return { swap: 's' + accepts.length, accept: 'swap-accept:xyz' }
        case 'swaps': return swaps.map((s) => ({ ...s }))
        case 'settle_first': {
          settleAsks.push(a)
          if (!given) { given = true; synced = false; coins[0].state = 'given'; return { settling: ['c1'], waiting: [], done: [], left: [], ready: false } }
          if (!synced) return { settling: [], waiting: ['c1'], done: [], left: [], ready: false }
          return { settling: [], waiting: [], done: ['c1'], left: [], ready: true }
        }
        case 'sync':
          if (given && coins[0].state === 'given') {
            coins[0].state = 'spent'
            coins.push({ leaf_id: 'c2', asset: X, value: '2999990', state: 'live', kind: 'leaf', hops: 0 })
          }
          synced = true
          return {}
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '0', after: a.value }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const posts = []
  let held = false
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(rateNum), rate_den: String(rateDen), max_give: String(maxGive), min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    posts.push([url.split('/v1/')[1], b])
    if (url.endsWith('/v1/firm')) {
            const want = (BigInt(b.give) * rateNum + rateDen - 1n) / rateDen
      return { swap: 's1', offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) }
    }
    if (url.endsWith('/v1/release')) { held = false; return {} }
    if (url.endsWith('/v1/accept')) {
      held = false
      for (const s of swaps) s.state = 'done'
      coins.push({ leaf_id: 'got', asset: Y, value: last[1], state: 'live', kind: 'transfer' })
      return { state: 'done' }
    }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, calls, posts, settleAsks, coins, swaps, accepts, setRate (n, d) { rateNum = n; rateDen = d }, setMaxGive (m) { maxGive = m } }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store,
  sleep: async () => {}, quoteFirmMs: 2000, ...extra })


async function settlingTrade (s, eng) {
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'settling')
  // First follow: the coin is given up in the next round; not ready yet.
  const r1 = await eng.advance(eng.records().find((x) => x.id === rec.id))
  assert.equal(r1.state, 'settling')
  return { q, rec }
}

test('W1: two follows of one settling trade, overlapping once its coins are through, accept it once', async () => {
  const s = standIn({ deepAt: 'accept' })
  const eng = engineOf(s)
  const { rec } = await settlingTrade(s, eng)
  const r = eng.records().find((x) => x.id === rec.id)
  // The composer's timer follow and a second follow (the Trade tab shown again: applyTradeMode,
  // or the follow after another confirmation) both move the open trades on.
  const out = await Promise.all([eng.resume(), eng.resume()])
  console.log('accepts:', s.accepts.length, 'records:', eng.records().map((x) => x.state).join(','), 'firm posts:', s.posts.filter(([p]) => p === 'firm').length)
  assert.equal(s.accepts.length, 1, 'accepted ' + s.accepts.length + ' times for one trade the person confirmed once')
})

test('W2: a settled-first trade goes ahead only at the ticket the person accepted or better; otherwise it comes back', async () => {
  const s = standIn({ deepAt: 'accept', rateNum: 400n, rateDen: 300n })
  const eng = engineOf(s)
  const { q, rec } = await settlingTrade(s, eng)
  s.setRate(400n * 1009n, 300n * 1000n)   // 0.9 % more to pay for each Y
  let r = eng.records().find((x) => x.id === rec.id)
  for (let i = 0; i < 6 && r.state === 'settling'; i++) r = await eng.advance(eng.records().find((x) => x.id === rec.id))
  console.log('accepted amountOut', q.ticket.amountOut, 'amountIn', q.ticket.amountIn, '-> went ahead with amountOut', r.ticket.amountOut, 'amountIn', r.ticket.amountIn, 'state', r.state)
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut), 'received ' + r.ticket.amountOut + ' where the person accepted ' + q.ticket.amountOut)
  // Moved by under 1%: it comes back, with the words, and nothing is accepted.
  assert.equal(r.state, 'returned', JSON.stringify(r))
  assert.equal(tradeStateWord(r), USER_WORDS.returnedMoved)
  assert.equal(s.accepts.length, 0)
})

test('W1b: the same overlap when the wallet holds only the one coin: the second acceptance is refused, and the trade that went through reads as', async () => {
  const s = standIn({ deepAt: 'accept' })
  const orig = s.lib.command.bind(s.lib)
  // The real library: the coin the first acceptance gives is offered, so a second finds no live coin.
  s.lib.command = (cmd, a) => {
    if (cmd === 'swap_accept' && s.accepts.length >= 1) { const e = new Error("refused: the wallet's coins of asset " + X + ' that a swap can spend hold 0, short of the 400000 it takes'); e.kind = 'refused'; throw e }
    return orig(cmd, a)
  }
  const eng = engineOf(s)
  const { rec } = await settlingTrade(s, eng)
  await Promise.all([eng.resume(), eng.resume()])
  const r = eng.records().find((x) => x.id === rec.id)
  console.log('accepts:', s.accepts.length, 'swaps in library:', JSON.stringify(s.swaps), 'record state:', r.state, 'word:', tradeStateWord(r), 'error:', r.error)
  for (let i = 0; i < 3; i++) await eng.resume()
  const r2 = eng.records().find((x) => x.id === rec.id)
  console.log('after more follows: record state:', r2.state, 'word:', tradeStateWord(r2))
  assert.notEqual(r2.state, 'failed', 'the trade went through (' + s.swaps.length + ' swap) and the record says failed')
})

test('W4: more than the balance shows, part of it in a round: never "taking longer", always "more than your"', async () => {
  const s = standIn({ deepAt: 'none' })
  s.coins[0].value = '100000'
  s.coins.push({ leaf_id: 'r1', asset: X, value: '2900000', state: 'given', kind: 'transfer' })
  const eng = engineOf(s, { held: () => 3000000n })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '5000000' })
  console.log('W4 ask 5,000,000 of a balance of 3,000,000 ->', q.why)
  assert.notEqual(q.why, 'settle-first', 'an amount above the balance is settled first, then retried, then "This is taking longer than usual"')
  assert.deepEqual([q.why, q.ready], ['part-ready', '3000000'], 'said at once: "That is more than your 3000000 …"')
  assert.equal(USER_WORDS.moreThanHeld('3000000 XT'), 'That is more than your 3000000 XT.')
})

test('W2b: a ticket the maker capped below the amount typed goes ahead at the ticket\'s size, never the whole amount typed', async () => {
  const s = standIn({ deepAt: 'accept', maxGive: 150000n })
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'settling')
  s.setMaxGive(1000000n)   // the maker's book is deeper by the time the coins are through
  let r = eng.records().find((x) => x.id === rec.id)
  for (let i = 0; i < 6 && r.state === 'settling'; i++) r = await eng.advance(eng.records().find((x) => x.id === rec.id))
  console.log('W2b ticket: pay', q.ticket.amountIn, 'receive', q.ticket.amountOut, 'asked', q.ticket.asked, '-> state', r.state, 'pay', r.ticket.amountIn, 'receive', r.ticket.amountOut)
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn) + (BigInt(q.ticket.amountIn) + BigInt(q.ticket.amountOut) - 1n) / BigInt(q.ticket.amountOut),
    'paid ' + r.ticket.amountIn + ' where the ticket the person confirmed said ' + q.ticket.amountIn)
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut))
  assert.equal(r.state, 'sent', 'it goes, at the ticket\'s size and price')
})
