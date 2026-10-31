// The user-mode composer: its words, its cost line and pickers, and its engine against a stand-in
// library and maker (the book and the router: tooling/lsp/single-step-book.test.mjs). The engine against the real library and operator is
// tooling/user-mode-drill.mjs; the page is tooling/user-mode-drive.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tradeStateWord, USER_WORDS, USER_MODE_FORBIDDEN_WORDS, forbiddenIn, costLine, pickerOrder, spendableFrom, createEngine, shortBy, SHARED_VIEW_READS, worthFirming } from './user-trade.js'

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

test('no sentence the composer shows names an empty asset', () => {
  // A refusal said with nothing chosen under You receive once read " for BTC is not offered.".
  const src = readFileSync(new URL('./user-composer.js', import.meta.url), 'utf8')
  const empty = [...src.matchAll(/USER_WORDS\.\w+\(\s*(?:''|""|``)/g)].map((m) => m[0])
  assert.deepEqual(empty, [], 'a USER_WORDS sentence is given an empty name')
  assert.equal(USER_WORDS.nothingOffered('BTC'), 'Not offered right now: nobody offers anything for BTC.')
  assert.deepEqual(forbiddenIn(USER_WORDS.nothingOffered('BTC')), [])
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

test('engine: a swap whose coins are far from the operator\'s limit is done the moment the maker completes it, no round asked', async () => {
  const s = standIn()
  // The library counts the swap's hops (1 here) and the operator allows 5.
  const lib = { command (cmd, a) {
    if (cmd === 'info') return { server_info: { depth_limit: 5 } }
    const v = s.lib.command(cmd, a)
    return cmd === 'swap_read' ? { ...v, hops: 1 } : v
  } }
  let t = 0
  const eng = createEngine({ leaves: lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => (t += 1000) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.amountOut, q.choice.terms.gets.value, 'what the swap gives, no settle fee taken off')
  assert.ok(!s.calls.includes('settle_quote'), 'no settling priced')
  await eng.confirm(q.choice, q.ticket)
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled', 'settled once the maker completed the swap')
  assert.ok(!s.calls.includes('participate'), 'no round asked')
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
  // Held where no source can pay from it now (on the chain, waiting to be boarded): not ready, and
  // the wallet is asked to make it ready; never "you have none".
  const asked = []
  const q = await createEngine({ ...base, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), held: () => 50000000000000n, prepare: (a) => asked.push(a) })
    .quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.deepEqual([q.why, q.held, asked], ['not-ready', '50000000000000', [X]])
  assert.deepEqual(forbiddenIn(USER_WORDS.notReady('USDX')), [])
  // Held by an order placed from it (the coin given to the round that makes the order): busy, not
  // "the next Bitcoin blocks".
  s.coins[0].state = 'given'
  const b = await createEngine({ ...base, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), held: () => 3000000n })
    .quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(b.why, 'busy')
  assert.deepEqual(forbiddenIn(USER_WORDS.busy('GOLD')), [])
  // Live, but kept by an open offline-refresh plan, which only a round ends: the wallet is asked to
  // free it in its next round, and the person is told so, never "held by an order".
  s.coins[0].state = 'live'
  s.plans.push({ plan_id: 'p1', coin: 'c1', state: 'open' })
  const freed = []
  const f = await createEngine({ ...base, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), held: () => 3000000n, release: (a, l) => freed.push([a, l]) })
    .quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.deepEqual([f.why, freed], ['freeing', [[X, ['c1']]]])
  assert.deepEqual(forbiddenIn(USER_WORDS.freeing('GOLD')), [])
  // A page without a release keeps the older answer.
  const g = await createEngine({ ...base, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), held: () => 3000000n })
    .quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(g.why, 'busy')
})

test('engine: what can be received for an asset is what the book offers on an admitted pair, held or not', async () => {
  const s = standIn()
  s.coins[0].state = 'spent'   // nothing held: the picker still lists what is offered
  const pairs = { chains: { g: { pairs: [
    { pay: X, receive: Y, sources: ['leaf-maker'] },        // the maker quotes Y for X
    { pay: X, receive: Z, sources: ['covenant-round'] },    // admitted, but no order now
    { pay: X, receive: 'BTC', sources: ['btc-gateway'] },   // no Bitcoin Lightning in this wallet
    { pay: Y, receive: X, sources: ['leaf-maker'] },        // another pay asset
  ] } } }
  const fetchJson = async (url) => url.endsWith('/v1/quotes')
    ? { quotes: [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' },
      { give_asset: 'BTC', want_asset: X, rate_num: '1', rate_den: '1', max_give: '1000000', min_give: '10000' }] }
    : s.fetchJson(url)
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], relayBook: async () => [], admitted: () => ({ pairs, genesis: 'g' }) })
  assert.deepEqual(await eng.offered(X), [Y])
  const withBtc = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], relayBook: async () => [], admitted: () => ({ pairs, genesis: 'g' }), btc: { balance: () => 0n } })
  assert.deepEqual((await withBtc.offered(X)).sort(), ['BTC', Y].sort())
  assert.deepEqual(await createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => [], relayBook: async () => [], admitted: () => ({ pairs, genesis: 'g' }) }).offered(X), [], 'no maker, no order: nothing offered')
})

test('engine: a maker quoting levels of one pair is asked for one firm offer, at the level that gives the most', async () => {
  const s = standIn()
  const levels = [
    { give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '100000', min_give: '10000' },   // best rate, shallow
    { give_asset: Y, want_asset: X, rate_num: '5', rate_den: '3', max_give: '1000000', min_give: '10000' },  // deeper, worse
    { give_asset: Y, want_asset: X, rate_num: '6', rate_den: '3', max_give: '2000000', min_give: '10000' },
  ]
  const fetchJson = async (url, init) => url.endsWith('/v1/quotes') ? { quotes: levels } : s.fetchJson(url, init)
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  // 400,000 at 5/3 gives 240,000, more than the first level's 100,000 cap or 200,000 at 6/3.
  assert.deepEqual(s.posts.filter(([p]) => p === 'firm').map(([, b]) => b.give), ['240000'], 'one firm offer, at the deeper level')
})

test('engine: a site\'s probe of all the wallet can pay asks the maker for no more than that', async () => {
  // The maker quotes up to 1,000,000 YT but holds 500,000 now; the wallet holds 600,000 XT, which
  // buys 450,000 YT. A site prices a purchase with a large probe amount.
  const s = standIn()
  s.coins[0].value = '600000'
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/firm') && BigInt(JSON.parse(init.body).give) > 500000n) throw new Error('the maker does not hold that much now')
    return s.fetchJson(url, init)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), sleep: async () => {} })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: String(10n ** 18n) })
  assert.ok(q.ok, q.why)
  const asked = s.posts.filter(([p]) => p === 'firm').map(([, b]) => BigInt(b.give))
  assert.ok(asked[0] <= 450000n, `first firm offer sized on what the wallet holds, not the level: ${asked}`)
  assert.ok(BigInt(q.ticket.amountIn) <= 600000n, q.ticket.amountIn)
})

test('engine: a maker that holds less than it quotes is asked for half', async () => {
  const s = standIn()
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/firm') && BigInt(JSON.parse(init.body).give) > 200000n) throw new Error('the maker does not hold that much now')
    return s.fetchJson(url, init)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), sleep: async () => {} })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  assert.ok(BigInt(q.ticket.amountOut) <= 200000n, q.ticket.amountOut)
})

test('engine: offered, but no firm offer comes: said so, after one more try, never "too small"', async () => {
  const s = standIn()
  let firms = 0
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/firm')) { firms++; throw new Error('the maker is busy') }
    return s.fetchJson(url, init)
  }
  let slept = 0
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), sleep: async () => { slept++ } })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(q.ok, false)
  assert.equal(q.why, 'no-firm-offer')
  assert.equal(firms, 2, 'asked once more after a pause')
  assert.equal(slept, 1)
  assert.deepEqual(forbiddenIn(USER_WORDS.noFirmOffer), [])
})

test('engine: an entry far off the price feed is never shown or taken', async () => {
  const s = standIn()
  // One level at the feed's price (4/3 XT per YT), one ~4,900 times off.
  const levels = [
    { give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '100000', min_give: '10000' },
    { give_asset: Y, want_asset: X, rate_num: '4', rate_den: '14700', max_give: '100000000', min_give: '10000' },
  ]
  const fetchJson = async (url, init) => url.endsWith('/v1/quotes') ? { quotes: levels } : s.fetchJson(url, init)
  // The feed: an atom of XT is worth 3/4 of an atom of YT.
  const fairRate = (pay, receive) => (pay === X && receive === Y ? 0.75 : null)
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), fairRate, sleep: async () => {} })
  const e = await eng.estimate({ payAsset: X, receiveAsset: Y, pay: '40000' })
  assert.ok(e.ok, e.why)
  assert.equal(e.receive, '30000', 'priced at the feed\'s level, not the one 4,900 times off')
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '40000' })
  assert.ok(q.ok, q.why)
  assert.ok(BigInt(q.ticket.amountOut) <= 30000n, q.ticket.amountOut)
})

test('engine: the two amounts, estimated either way round, with no firm offer asked', async () => {
  const s = standIn()
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => 0 })
  // The maker gives Y for X at 4 X per 3 Y, up to 1,000,000 Y.
  const a = await eng.estimate({ payAsset: X, receiveAsset: Y, pay: '400000' })
  assert.deepEqual([a.ok, a.pay, a.receive, a.short], [true, '400000', '300000', null])
  const b = await eng.estimate({ payAsset: X, receiveAsset: Y, receive: '300000' })
  assert.deepEqual([b.ok, b.pay, b.receive, b.short], [true, '400000', '300000', null])
  const c = await eng.estimate({ payAsset: X, receiveAsset: Y, receive: '2000000' })
  assert.deepEqual([c.ok, c.receive, c.pay], [true, '1000000', '1333334'], 'more than the book fills: what it can')
  assert.deepEqual(c.short, { pay: '1333334', receive: '1000000' })
  const d = await eng.estimate({ payAsset: X, receiveAsset: Y, pay: '4000000' })
  assert.equal(d.receive, '1000000'); assert.ok(d.short, 'paying more than the book takes says how much it can')
  assert.equal((await eng.estimate({ payAsset: X, receiveAsset: Y, pay: '0' })).why, 'too-small')
  assert.ok(!s.posts.some(([p]) => p === 'firm'), 'no maker was asked for a firm offer')
  assert.equal((await createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: () => ({ pairs: { chains: {} }, genesis: 'g' }), store: s.store }).estimate({ payAsset: X, receiveAsset: Y, pay: '1' })).why, 'not-listed')
})

test('shortBy: what a payment the library refused for want of funds is short by', () => {
  assert.equal(shortBy('the wallet holds 19826249492 of asset 2a51 in live coins, and paying 19826249492 takes 19826251492 with the margins its transactions leave for their fees'), 2000n)
  assert.equal(shortBy("the change would be below the operator's smallest leaf in asset 2a51 (1000000 atoms): pay a little less, or that much more"), 1000000n)
  assert.equal(shortBy('the maker is away'), 0n)
})

test('engine: a firm offer the wallet cannot pay with its margins is asked again for less', async () => {
  const s = standIn()
  const command = s.lib.command.bind(s.lib)
  let refused = 0
  s.lib.command = (cmd, a) => {
    if (cmd === 'swap_read' && !refused++) throw new Error('the wallet holds 3000000 of asset x in live coins, and paying 2999000 takes 3000192 with the margins its transactions leave for their fees')
    return command(cmd, a)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store })
  // A site's probe: far more than the wallet holds, so the first firm offer is sized on all of it.
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '1000000000000000000' })
  assert.ok(q.ok, q.why)
  const firms = s.posts.filter(([p]) => p === 'firm').map(([, b]) => BigInt(b.give))
  assert.ok(firms.length >= 2 && firms[1] < firms[0], `asked again for less: ${firms}`)
  assert.ok(s.posts.some(([p]) => p === 'release'), 'the refused offer is released')
})

test('engine: the page is told when a trade moves on, so it reads the balance again', async () => {
  const s = standIn()
  const told = []
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, changed: (r) => told.push(r.state) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  await eng.confirm(q.choice, q.ticket)
  await eng.advance(eng.records()[0])
  assert.ok(told.length >= 1, 'told once the swap is done')
  const n = told.length
  await eng.advance(eng.records()[0])   // nothing new: not told again
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  await eng.advance(eng.records()[0])
  assert.equal(told[told.length - 1], 'settled')
  assert.ok(told.length > n)
})

test('engine: trades moving on together share one sync, and none runs again within ten seconds', async () => {
  const s = standIn()
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  await eng.confirm(q.choice, q.ticket)
  const syncs = () => s.calls.filter((c) => c === 'sync').length
  const before = syncs()
  await Promise.all([eng.advance(eng.records()[0]), eng.advance(eng.records()[0])])
  await eng.advance(eng.records()[0])
  assert.equal(syncs() - before, 1, 'one sync for passes within ten seconds')
  t += 10_001
  await eng.advance(eng.records()[0])
  assert.equal(syncs() - before, 2, 'and another once ten seconds have passed')
})

test('engine: its reads share the view a moment old; what takes a coin or signs never asks to', async () => {
  const s = standIn()
  const command = s.lib.command.bind(s.lib)
  const asked = []
  s.lib.command = (cmd, a) => { asked.push([cmd, !!(a && a.shared_view)]); return command(cmd, a) }
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  await eng.confirm(q.choice, q.ticket)
  for (const [cmd, shared] of asked) assert.equal(shared, SHARED_VIEW_READS.has(cmd), cmd)
  assert.ok(asked.some(([c, sh]) => c === 'coins' && sh), 'a read shares the view')
  assert.ok(asked.some(([c, sh]) => c === 'swap_accept' && !sh), 'the acceptance, which signs, looks first')
})

test('worthFirming: a slow source is asked for firm terms only when it could be chosen', () => {
  const ind = (l) => l.map(([source, receive]) => ({ e: { source }, receive }))
  const pick = (l) => worthFirming(ind(l)).map((x) => x.e.source + ':' + x.receive)
  assert.deepEqual(pick([['covenant-round', 10040n], ['leaf-maker', 10000n], ['leaf-resting', 9990n]]), ['leaf-maker:10000', 'leaf-resting:9990'])
  assert.deepEqual(pick([['covenant-round', 10060n], ['leaf-maker', 10000n]]), ['covenant-round:10060', 'leaf-maker:10000'])
  assert.deepEqual(pick([['covenant-round', 300n], ['onchain-fill', 200n]]), ['covenant-round:300', 'onchain-fill:200'])
})

test('a purchase of BTC whose payment is made reads "Paid. Your BTC is on its way."', () => {
  const r = { source: 'btc-gateway', dir: 'sell', state: 'sent', sentAt: 1000, at: 1000 }
  assert.equal(tradeStateWord(r, 1000), USER_WORDS.btcOnItsWay)
  assert.deepEqual(forbiddenIn(USER_WORDS.btcOnItsWay), [])
  assert.equal(tradeStateWord({ ...r, btcPaid: true }, 1000), USER_WORDS.receivedSettling)
})

test('engine: no trade is moved on while a person waits on a quote', async () => {
  const s = standIn()
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  await eng.confirm(q.choice, q.ticket)
  const rec = eng.records()[0]
  const command = s.lib.command.bind(s.lib)
  let release
  const gate = new Promise((r) => { release = r })
  let synced = 0
  s.lib.command = (cmd, a) => { if (cmd === 'sync') synced++; return command(cmd, a) }
  // A quote held open (its maker slow to answer): an advance meanwhile does nothing.
  const fetchJson = s.fetchJson
  s.fetchJson = async (url, init) => { if (String(url).endsWith('/v1/quotes')) await gate; return fetchJson(url, init) }
  const eng2 = createEngine({ leaves: s.lib, fetchJson: (u, i) => s.fetchJson(u, i), makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store })
  const pending = eng2.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  await new Promise((r) => setTimeout(r, 20))
  const r1 = await eng2.advance(rec)
  assert.equal(synced, 0, 'no sync while the quote waits')
  assert.equal(r1, rec)
  release(); await pending
  await eng2.advance(eng2.records()[0])
  assert.ok(synced >= 1, 'the trade moves on at the next pass')
})

test('engine: a maker slower than the quote\'s deadline is left out, and its late offer let go of (#363)', async () => {
  const s = standIn()
  const released = []
  const fetchJson = async (url, init) => {
    if (url.startsWith('http://slow')) {
      // Quotes a better price, then takes longer to firm it than the quote waits.
      if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '1', rate_den: '1', max_give: '1000000', min_give: '10000' }] }
      if (url.endsWith('/v1/firm')) { await new Promise((r) => setTimeout(r, 300)); const b = JSON.parse(init.body); return { swap: 'slow1', offer: `swap-offer:${b.give}:${b.give}`, give: b.give, want: b.give } }
      if (url.endsWith('/v1/release')) { released.push(JSON.parse(init.body).swap); return {} }
    }
    return s.fetchJson(url, init)
  }
  const eng = createEngine({ leaves: s.lib, fetchJson, store: s.store, makers: () => ['http://slow', 'http://m'], admitted: admitted(['leaf-maker']), quoteFirmMs: 100 })
  const t0 = Date.now()
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const took = Date.now() - t0
  assert.ok(q.ok, q.why)
  assert.equal(q.choice.entry.maker, 'http://m', 'the ticket is the source that answered in time')
  assert.ok(took < 250, `the quote waited ${took} ms, not the slow maker's 300`)
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual(released, ['slow1'], 'the late offer is released')
})

test('engine: a quote holds the wallet\'s upkeep for its whole length (#363)', async () => {
  const s = standIn()
  let held = 0, maxHeld = 0
  const leaves = { ...s.lib, command: (c, a) => s.lib.command(c, a), hold: async (f) => { held++; maxHeld = Math.max(maxHeld, held); try { return await f() } finally { held-- } } }
  const fetchJson = async (url, init) => { if (url.endsWith('/v1/firm')) assert.equal(held, 1, 'held while the maker answers'); return s.fetchJson(url, init) }
  const eng = createEngine({ leaves, fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']) })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  assert.equal(maxHeld, 1)
  assert.equal(held, 0, 'let go once the quote is answered')
})

test('engine: an amount that would trade, paid from coins mostly not ready yet, is said so, never "too small" (#363)', async () => {
  const s = standIn()
  s.coins[0].value = '5000'          // ready now: too little for the maker's least
  s.coins.push({ leaf_id: 'c2', asset: X, value: '2000000', state: 'pending', kind: 'board' })
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), store: s.store })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(q.ok, false)
  assert.equal(q.why, 'part-ready')
  assert.equal(q.ready, '5000')
  assert.deepEqual(forbiddenIn(USER_WORDS.partReady('0.00005 XT', 'XT')), [])
})

test('engine: at anchor depth 0 a coin not ready yet is on its way; a coin a reorganisation took back is being redone', async () => {
  const s = standIn()
  const base = { leaves: s.lib, fetchJson: s.fetchJson, store: s.store, makers: () => ['http://m'], admitted: admitted(['leaf-maker']), held: () => 3000000n }
  // A coin received a moment ago, its block not yet certified.
  s.coins[0].state = 'pending'
  const q0 = await createEngine({ ...base, anchorDepth: () => 0 }).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.deepEqual([q0.why, q0.soon], ['not-ready', true])
  assert.equal(USER_WORDS.notReady('USDX', q0.soon), 'Your USDX is on its way: it is ready to trade in a minute or two. Nothing has moved.')
  // An operator that also waits for Bitcoin blocks, or a library that has not said: the Bitcoin words.
  for (const anchorDepth of [() => 2, () => null, undefined]) {
    const q = await createEngine({ ...base, anchorDepth }).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
    assert.deepEqual([q.why, q.soon], ['not-ready', false])
    assert.match(USER_WORDS.notReady('USDX', q.soon), /next Bitcoin blocks settle it/)
  }
  // Spendable once, then out of the chain with its Bitcoin block: being redone, never a loss.
  s.coins[0].redoing = true
  const r = await createEngine({ ...base, anchorDepth: () => 0 }).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(r.why, 'redoing')
  assert.equal(USER_WORDS.redoing('USDX'), 'Your USDX is being redone after a Bitcoin reorganisation: it is still yours, and ready to trade again once that settles. Nothing has moved.')
  // The person's words hold none of default mode's forbidden words.
  for (const w of [USER_WORDS.notReady('USDX', true), USER_WORDS.partReady('0.01 USDX', 'USDX', true), USER_WORDS.freeing('GOLD', true),
    USER_WORDS.redoing('USDX'), USER_WORDS.receivedSoon]) assert.deepEqual(forbiddenIn(w), [], w)
  assert.equal(USER_WORDS.partReady('0.0149 USDX', 'USDX', true), 'Only 0.0149 USDX of your USDX can be traded now, too little for any offer: the rest is on its way, ready in a minute or two. Nothing has moved.')
})

test('a trade whose coins are held settles in a minute or two at anchor depth 0', () => {
  const T0 = 1_000_000
  const r = { source: 'leaf-maker', state: 'sent', sentAt: T0, swapState: 'done' }
  assert.equal(tradeStateWord(r, T0 + 30000, true), USER_WORDS.receivedSoon)
  assert.equal(tradeStateWord(r, T0 + 3 * 60000, true), 'Received. Settled in a minute or two. (3 min)')
  assert.equal(tradeStateWord(r, T0 + 30000), USER_WORDS.receivedSettling)
})
