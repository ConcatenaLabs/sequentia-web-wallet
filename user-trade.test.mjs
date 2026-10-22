// The user-mode composer: its words, its cost line and pickers, and its engine against a stand-in
// library and maker (the book and the router: tooling/lsp/single-step-book.test.mjs). The engine against the real library and operator is
// tooling/user-mode-drill.mjs; the page is tooling/user-mode-drive.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { USER_WORDS, USER_MODE_FORBIDDEN_WORDS, forbiddenIn, costLine, pickerOrder, spendableFrom, createEngine } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32), Z = 'cc'.repeat(32)
const fmt = (a, n) => `${n} ${a === X ? 'XT' : a === Y ? 'YT' : 'BTC'}`

test('no string the user composer can show names a rail or developer word', () => {
  const samples = Object.values(USER_WORDS).map((v) => (typeof v === 'function' ? v('YT', 'XT') : v))
  for (const s of samples) assert.deepEqual(forbiddenIn(s), [], s)
  // The composer module itself spells every visible word through USER_WORDS.
  const src = readFileSync(new URL('./user-composer.js', import.meta.url), 'utf8')
  const literals = [...src.matchAll(/el\('[^']*',\s*(?:'[^']*'|null),\s*'([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(literals, [], 'every word is a USER_WORDS entry')
})

test('the word list catches rail words as words', () => {
  assert.deepEqual(forbiddenIn('Paid from your leaves in the next round'), ['round', 'leaves'])
  assert.deepEqual(forbiddenIn('Surrounded, relayed'), [])
  assert.ok(USER_MODE_FORBIDDEN_WORDS.includes('operator'))
  assert.deepEqual(forbiddenIn('on-chain'), ['on-chain'])
})

test('the cost line: every fee in its own asset, the asset paid first, the price never', () => {
  assert.equal(costLine([{ asset: X, atoms: '536' }], fmt, X), 'Fees 536 XT, included above')
  assert.equal(costLine([{ asset: Y, atoms: '12' }, { asset: X, atoms: '536' }, { asset: X, atoms: '4' }], fmt, X), 'Fees 540 XT and 12 YT, included above')
  assert.equal(costLine([{ asset: X, atoms: '0' }], fmt, X), 'No fees')
})

test('both pickers list BTC first, then what is held, then the rest', () => {
  const held = (a) => (a === Y ? 5n : 0n)
  assert.deepEqual(pickerOrder([Z, Y, X], held, (a) => a), ['BTC', Y, X, Z])
  assert.deepEqual(pickerOrder(['BTC', X], () => 0n), ['BTC', X])
})

test('what the library can pay now leaves out coins an offline-refresh plan names', () => {
  const coins = [{ leaf_id: 'a', asset: X, value: '100', state: 'live' }, { leaf_id: 'b', asset: X, value: '50', state: 'live' },
    { leaf_id: 'c', asset: X, value: '7', state: 'offered' }, { leaf_id: 'd', asset: Y, value: '9', state: 'live' }]
  const m = spendableFrom(coins, { plans: [{ coin: 'b', state: 'open' }, { coin: 'd', state: 'done' }] })
  assert.equal(m.get(X), 100n)
  assert.equal(m.get(Y), 9n)
})






// A stand-in library and maker: what the engine does with their answers.
function standIn () {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'board' }]
  const swaps = []
  const parts = []
  const calls = []
  let last = null
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
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
  return { lib, fetchJson, store, calls, posts, parts, swaps, coins, away: () => { complete = false } }
}

const admitted = (sources) => () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources }] } } }, genesis: 'g' })

test('engine: an in-tree trade from ticket to Settled, the ticket the library\'s own numbers', async () => {
  const s = standIn()
  let t = 0
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => (t += 1000) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  // 400,000 would spend 400,000 plus 192 of margins: sized down to fit what is paid.
  assert.ok(BigInt(q.ticket.amountIn) <= 400000n, q.ticket.amountIn)
  assert.equal(q.ticket.amountOut, String(BigInt(q.choice.terms.gets.value) - 3n), 'what is received, less its settle fee')
  assert.ok(s.posts.some(([p]) => p === 'release'), 'the firm offer that did not fit is released')
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'sent')
  let r = await eng.advance(eng.records()[0])
  assert.ok(r.settle, 'the received coin and the change are asked into the next round')
  assert.equal(r.settle.coins.length, 2)
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('engine: a maker that never completes: the swap is cancelled and the coin comes back, no action asked', async () => {
  const s = standIn()
  s.away()
  let t = 0
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '200000' })
  await eng.confirm(q.choice, q.ticket)
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent', 'still waiting inside the window')
  t += 10 * 60 * 1000
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned')
  assert.equal(s.coins[0].state, 'live')
})

test('engine: not listed, not offered, no funds', async () => {
  const s = standIn()
  const base = { leaves: s.lib, fetchJson: s.fetchJson, store: s.store }
  assert.equal((await createEngine({ ...base, makers: () => ['http://m'], admitted: () => ({ pairs: { chains: {} }, genesis: 'g' }) }).quote({ payAsset: X, receiveAsset: Y, amount: '1' })).why, 'not-listed')
  assert.equal((await createEngine({ ...base, makers: () => [], admitted: admitted(['leaf-maker']) }).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })).why, 'not-offered')
  s.coins[0].state = 'spent'
  assert.equal((await createEngine({ ...base, makers: () => ['http://m'], admitted: admitted(['leaf-maker']) }).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })).why, 'no-funds')
})
