// A trade whose coins were moved on before its settling was followed to its end (#516; ambra #203).
// The third of five trades in a row stayed "Received, settling" for good when the next trade spent
// what it brought: the trade is Settled once its settle round is final, whatever became of that
// round's new coins afterwards, and a coin the trade brought that was spent onward arrived.
//   node --test user-trade-settle-onward.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, tradeStateWord, USER_WORDS } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)
const P_UP = 'cd'.repeat(32)

// A stand-in library and maker: what the engine does with their answers.
function standIn () {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'board' }]
  const swaps = []
  const parts = []
  const plans = []
  const calls = []
  let last = null
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: plans.map((p) => ({ ...p })) }
        case 'swap_read': return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: a.offer.split(':')[2] }, pays: { asset: X, margins: '192' },
          change: { asset: X, value: String(3000000 - Number(a.offer.split(':')[2]) - 192) }, dates: { expiry: 1800000000 } }
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '3', after: String(Number(a.value) - 3) }
        case 'swap_accept': last = a.offer.split(':'); swaps.push({ swap: 's1', role: 'taker', state: 'accepted' }); coins[0].state = 'offered'; return { swap: 's1', accept: 'swap-accept:xyz' }
        case 'swaps': return swaps.map((s) => ({ ...s }))
        case 'sync': return {}
        case 'quote': return { coins: a.leaves.map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': parts.push({ participation: 'p' + parts.length, state: 'pending', new_leaves: [{ state: null }] }); return { participations: [parts[parts.length - 1]] }
        case 'participations': return parts.map((p) => ({ ...p }))
        case 'swap_cancel': { const s = swaps.find((x) => x.swap === a.swap); s.state = 'cancelled'; coins[0].state = 'live'; return { cancelled: true } }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const posts = []
  let complete = true
  let held = false
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    posts.push([url.split('/v1/')[1], b])
    // The maker holds its coin for an offer until the offer is released, a moment after it is
    // asked to, and refuses a second offer meanwhile, as leaf-maker.mjs does.
    if (url.endsWith('/v1/firm')) {
      if (held) throw new Error('the maker does not hold that much now')
      held = true
      const want = (BigInt(b.give) * 4n + 2n) / 3n; return { swap: 's1', offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) }
    }
    if (url.endsWith('/v1/release')) { await new Promise((r) => setTimeout(r, 20)); held = false; return {} }
    if (url.endsWith('/v1/accept')) {
      if (!complete) throw new Error('the maker is away')
      const s = swaps.find((x) => x.swap === 's1'); s.state = 'done'
      coins[0].state = 'spent'
      coins.push({ leaf_id: 'got', asset: Y, value: last[1], state: 'live', kind: 'transfer' }, { leaf_id: 'chg', asset: X, value: String(3000000 - Number(last[2]) - 192), state: 'live', kind: 'transfer' })
      return { state: 'done' }
    }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, calls, posts, parts, swaps, coins, plans, away: () => { complete = false } }
}

const admitted = (sources) => () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources }] } } }, genesis: 'g' })

// Trade A, sent and completed by the maker: its received coin `got` and its change `chg` are asked
// into the next round (participation p0).
async function tradeA () {
  const s = standIn()
  let t = 0
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => (t += 1000) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  await eng.confirm(q.choice, q.ticket)
  return { s, eng }
}

test('a settle round that is final settles the trade, though the next trade moved its new coin into a round that never ran', async () => {
  const { s, eng } = await tradeA()
  let r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'asked into the next round')
  // The round is final; trade B then gave its new coin to a round of its own that was dropped, and
  // the operator keeps it under its forfeit: it stays `forfeited`, and goes home by its own exit.
  s.parts[0].state = 'released'
  s.parts[0].new_leaves = [{ leaf_id: 'n0', state: 'forfeited' }, { leaf_id: 'n1', state: 'live' }]
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled', 'Settled once its round is final: ' + r.settleWhy)
  assert.equal(tradeStateWord(r), USER_WORDS.settled)
})

test('a settle round that is final settles the trade before the wallet has taken its new coin', async () => {
  const { s, eng } = await tradeA()
  await eng.advance(eng.records()[0])
  s.parts[0].state = 'released'
  s.parts[0].new_leaves = [{ leaf_id: null, state: null }]
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled', r.settleWhy)
})

test('what the trade brought, spent onward by the next trade before this one is followed, arrived: nothing of it waits', async () => {
  const { s, eng } = await tradeA()
  // Trade B takes the coin trade A brought before A's settling is looked at: it is offered in B's swap.
  s.coins.find((c) => c.leaf_id === 'got').state = 'offered'
  let r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'the change alone is asked into the next round: ' + r.settleWhy)
  assert.deepEqual(r.settle.coins, ['chg'])
  s.parts[0].state = 'released'
  s.parts[0].new_leaves = [{ leaf_id: 'n0', state: 'live' }]
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('a coin the wallet\'s own round already holds under its signed forfeit is followed through that round', async () => {
  const { s, eng } = await tradeA()
  // The wallet's upkeep gave the coin trade A brought to its own round, and signed its forfeit.
  const got = s.coins.find((c) => c.leaf_id === 'got')
  got.state = 'forfeited'
  got.note = `participation ${P_UP}: its forfeit for round ${'ef'.repeat(32)} is signed`
  s.parts.push({ participation: P_UP, state: 'forfeiting', new_leaves: [{ leaf_id: 'u0', state: null }] })
  let r = await eng.advance(eng.records()[0])
  assert.ok(r.settle && r.settle.participations.includes(P_UP), 'followed under its own round: ' + r.settleWhy)
  for (const p of s.parts) { p.state = 'released'; p.new_leaves = [{ leaf_id: 'u0', state: 'live' }] }
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})
