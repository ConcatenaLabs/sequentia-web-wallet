// One wait-and-go path (#565): a trade whose coins wait only for a round is answered at once with a
// ticket the person can accept (the book's price now, the least it goes for after its fees, and the
// wait the library gives), on the Trade tab and in a site's order alike. Accepting it writes one
// trade that waits for the coins and goes by itself at that price or better, or comes back with
// nothing traded; never "could not be made", never "try again". All on the real engine, with a
// stand-in library whose round is held until the test lets it through.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, tradeStateWord, forbiddenIn } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'
import { makeSiteOrders } from './site-orders.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)

const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

// The wait the library reads for the coins: at most 300 s, usually 120 s, the next round.
const WAIT = { final_in_seconds: 300, usual_in_seconds: 120, waiting_for: 'round' }
function settleFirst (coins) {
  const e = new Error('refused: the wallet\'s coins of asset ' + X + ' … settle them first (settle_first) …, usually within 120 s and at most 300 s')
  Object.assign(e, { kind: 'settle_first', asset: X, coins }, WAIT)
  return e
}

// The wallet's one coin of X (`c1`) is too deep to give part of: `swap_read` answers settle_first
// naming it. `settle_first` gives it up once; its round goes through only once the test calls
// `through()`, and the next sync then brings the round's coin `c2`, which trades.
function standIn ({ rateNum = 4n, rateDen = 3n, refreshFee = 0n } = {}) {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'transfer', hops: 3 }]
  const swaps = [], calls = [], settleAsks = []
  let open = false, last = null
  const deep = () => coins.some((c) => c.leaf_id === 'c1' && c.state !== 'spent')
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_read':
          if (deep()) throw settleFirst(['c1'])
          return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: a.offer.split(':')[2] }, pays: { asset: X, margins: '192' },
            change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } }
        case 'swap_accept':
          if (deep()) throw settleFirst(['c1'])
          last = a.offer.split(':'); swaps.push({ swap: 's1', role: 'taker', state: 'accepted' })
          return { swap: 's1', accept: 'swap-accept:xyz' }
        case 'swaps': return swaps.map((s) => ({ ...s }))
        case 'settle_first': {
          settleAsks.push(a)
          const c1 = coins.find((c) => c.leaf_id === 'c1')
          if (c1.state === 'live') { c1.state = 'given'; return { settling: ['c1'], waiting: [], done: [], left: [], ready: false, ...WAIT } }
          if (c1.state === 'given') return { settling: [], waiting: ['c1'], done: [], left: [], ready: false, ...WAIT }
          return { settling: [], waiting: [], done: ['c1'], left: [], ready: true }
        }
        case 'sync': {
          const c1 = coins.find((c) => c.leaf_id === 'c1')
          if (open && c1.state === 'given') { c1.state = 'spent'; coins.push({ leaf_id: 'c2', asset: X, value: '2999990', state: 'live', kind: 'leaf', hops: 0 }) }
          return {}
        }
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '0', after: a.value }
        // The operator's refresh, read only: free unless the test charges for it.
        case 'quote': return { coins: a.leaves.map((l) => ({ leaf_id: l, fee: String(refreshFee) })) }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const posts = []
  let held = false
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(rateNum), rate_den: String(rateDen), max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    posts.push([url.split('/v1/')[1], b])
    if (url.endsWith('/v1/firm')) {
      if (held) throw new Error('the maker does not hold that much now')
      held = true
      const want = (BigInt(b.give) * rateNum + rateDen - 1n) / rateDen
      return { swap: 's1', offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) }
    }
    if (url.endsWith('/v1/release')) { held = false; return {} }
    if (url.endsWith('/v1/accept')) {
      held = false
      const s = swaps.find((x) => x.swap === 's1'); s.state = 'done'
      coins.push({ leaf_id: 'got', asset: Y, value: last[1], state: 'live', kind: 'transfer' })
      return { state: 'done' }
    }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, calls, posts, settleAsks, coins, through () { open = true }, setRate (n, d) { rateNum = n; rateDen = d } }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store,
  sleep: () => wait(1), quoteFirmMs: 2000, ...extra })
// Advances the one trade until it ends (or `n` tries), as the page's follow does.
async function until (eng, id, ok, n = 60) {
  let r = eng.records().find((x) => x.id === id)
  for (let i = 0; i < n && !ok(r); i++) { await wait(5); r = await eng.advance(eng.records().find((x) => x.id === id)) }
  return r
}

// 400,000 X at 4 X for 3 Y: the book gives 300,000 Y; the least it goes for, after its fees, 297,000.
const A = '400000', ABOUT = '300000', LEAST = '297000'

test('engine: coins that wait for a round are answered with a ticket to accept now: the price, the least, the true wait', { timeout: 20_000 }, async () => {
  const s = standIn()
  // The page's clock: the engine syncs at most every ten seconds, so each follow below is ten
  // seconds after the one before.
  let clock = Date.now()
  const eng = engineOf(s, { now: () => clock })
  const t0 = clock
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
  assert.equal(q.ok, true, 'a ticket, never settle-first left to the caller: ' + JSON.stringify(q))
  assert.equal(q.ticket.indicative, true)
  assert.equal(q.ticket.amountIn, A)
  assert.equal(q.ticket.about, ABOUT, 'the book\'s price now')
  assert.equal(q.ticket.amountOut, LEAST, 'the least it goes for')
  assert.ok(q.ticket.finalBy === t0 + 120_000, 'the library\'s own usual wait: ' + (q.ticket.finalBy - t0))
  assert.deepEqual(s.settleAsks, [], 'a price request gives nothing to a round')
  assert.ok(!s.calls.includes('swap_accept'), 'nothing traded before the person accepts')
  assert.equal(tradeStateWord({ state: 'settling', finalBy: q.ticket.finalBy }, clock), USER_WORDS.goesThrough(2))
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.deepEqual(s.settleAsks.map((a) => a.coins), [['c1']], 'accepted: the coins the library named go into the next round')
  assert.equal(rec.state, 'settling', 'one trade, waiting for its coins')
  assert.equal(rec.accepted.amountOut, LEAST)
  // Still in its round: it waits, saying so, and nothing is traded.
  clock += 11_000
  let r = await eng.advance(rec)
  assert.equal(r.state, 'settling')
  assert.equal(tradeStateWord(r, clock), USER_WORDS.goesThrough(2), 'it says how long, counting down')
  assert.ok(!s.calls.includes('swap_accept'))
  s.through()
  for (let i = 0; i < 60 && r.state !== 'settled'; i++) { clock += 11_000; await wait(5); r = await eng.advance(eng.records()[0]) }
  assert.equal(r.state, 'settled', JSON.stringify(r))
  assert.equal(r.id, rec.id, 'the same trade, never a second one')
  assert.equal(eng.records().length, 1)
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(LEAST), 'at the price accepted or better: ' + r.ticket.amountOut)
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(A))
  assert.equal(s.calls.filter((c) => c === 'swap_accept').length, 1, 'accepted once')
})

test('engine: a waiting trade whose price moved past the least accepted comes back with nothing traded and the new price', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
  const rec = await eng.confirm(q.choice, q.ticket)
  s.setRate(5n, 3n)   // 400,000 X now gives 240,000 Y
  s.through()
  const r = await until(eng, rec.id, (x) => ['settled', 'returned', 'failed'].includes(x.state))
  assert.equal(r.state, 'returned')
  assert.equal(r.whyKind, 'moved')
  assert.ok(r.newTicket && BigInt(r.newTicket.amountOut) < BigInt(LEAST), 'the new price comes back with it')
  assert.ok(!s.calls.includes('swap_accept'), 'nothing traded')
  assert.equal(tradeStateWord(r), USER_WORDS.returnedMoved)
})

function fakeDoc () {
  const byId = new Map()
  function mk (tag) {
    const e = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, _id: '', _text: '', className: '',
      value: '', disabled: false, type: '', title: '', options: [], selectedIndex: 0,
      get id () { return this._id }, set id (v) { this._id = v; byId.set(v, this) },
      get textContent () { return this._text + this.children.map((c) => c.textContent).join('') }, set textContent (v) { this._text = String(v); this.children = [] },
      set innerHTML (v) { this._text = ''; this.children = [] }, get innerHTML () { return '' },
      appendChild (c) { this.children.push(c); c.parentNode = this; return c },
      append (...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(mk('span'), { textContent: c }) : c) },
      insertBefore (c) { return this.appendChild(c) }, removeChild (c) { this.children = this.children.filter((x) => x !== c) }, remove () { if (this.parentNode) this.parentNode.removeChild(this) },
      replaceChildren (...cs) { this.children = []; this.append(...cs) },
      replaceWith (n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children[i] = n; n.parentNode = p },
      setAttribute (k, v) { this.attrs[k] = v; if (k === 'id') this.id = v }, getAttribute (k) { return this.attrs[k] ?? null }, removeAttribute (k) { delete this.attrs[k] },
      addEventListener () {}, removeEventListener () {}, focus () {}, blur () {}, scrollIntoView () {},
      classList: { _s: new Set(), add (...c) { c.forEach((x) => this._s.add(x)) }, remove (...c) { c.forEach((x) => this._s.delete(x)) }, toggle (c, on) { if (on ?? !this._s.has(c)) this._s.add(c); else this._s.delete(c) }, contains (c) { return this._s.has(c) } },
      querySelector (sel) {
        if (sel.startsWith('#')) { const f = (n) => { if (n._id === sel.slice(1)) return n; for (const c of n.children) { const r = f(c); if (r) return r } return null }; return f(this) }
        return null
      },
      querySelectorAll () { return [] }, closest () { return null }, getBoundingClientRect () { return { width: 0, height: 0, top: 0, left: 0 } },
    }
    e.ownerDocument = doc
    return e
  }
  const doc = { createElement: mk, createTextNode: (t) => Object.assign(mk('#text'), { textContent: t }), addEventListener () {}, removeEventListener () {}, body: null }
  doc.body = mk('body')
  return doc
}


const composerOf = (eng, root, extra = {}) => mountUserComposer({
  root, engine: eng, held: (a) => (a === X ? 3000000n : 0n), knownAssets: () => [X, Y], assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }),
  fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
  session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50, ...extra })

test('Trade tab: Review shows the price and the wait at once; one Trade, and it goes by itself', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = composerOf(eng, root)
  Object.assign(ui.state, { pay: X, get: Y, amount: A, payChosen: true, getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  // The round has not gone through: the person still reads a ticket, with what it waits for.
  assert.ok(ui.state.ticket, 'a ticket while the coins wait for their round: ' + (ui.state.error || ui.state.note))
  assert.equal(root.querySelector('#ucOut').textContent, USER_WORDS.amountOut + USER_WORDS.about + ' ' + ABOUT + ' YT')
  assert.equal(root.querySelector('#ucCost').textContent, USER_WORDS.atLeast(LEAST + ' YT'))
  assert.equal(root.querySelector('#ucWait').textContent, USER_WORDS.goesThrough(2))
  assert.equal(ui.state.error, '')
  assert.ok(!s.calls.includes('swap_accept'))
  await root.querySelector('#ucConfirm').onclick()
  for (let i = 0; i < 50 && !eng.records().length; i++) await wait(5)
  const rec = eng.records()[0]
  assert.equal(rec.state, 'settling', 'accepted: one trade waiting for its coins')
  assert.equal(ui.state.ticket, null, 'the composer is free for the next trade')
  s.through()
  const r = await until(eng, rec.id, (x) => x.state === 'settled')
  assert.equal(r.state, 'settled', JSON.stringify(r))
  assert.equal(eng.records().length, 1)
  clearTimeout(ui.state.timer)
})

const meta = (h) => (h === X ? { ticker: 'XT', precision: 0 } : { ticker: 'YT', precision: 0 })
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }

test('SeqDEX: an order whose coins wait for a round is shown with the price and the wait, answered under way, and goes by itself', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
    fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000 })
  const origin = 'https://dex.example/'
  const q = await S.quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, origin)
  assert.equal(q.kind, 'take', 'an approval, never "could not be made"')
  const rows = Object.fromEntries(q.display.rows.map(([k, v], i) => [k || 'row' + i, v]))
  assert.equal(rows[USER_WORDS.amountIn], A + ' XT')
  assert.equal(rows[USER_WORDS.amountOut], USER_WORDS.about + ' ' + ABOUT + ' YT', 'the book\'s price now')
  const said = q.display.rows.map(([, v]) => v)
  assert.ok(said.includes(USER_WORDS.atLeast(LEAST + ' YT')), 'the least it goes for: ' + JSON.stringify(said))
  assert.ok(said.includes(USER_WORDS.goesThrough(2)), 'the true wait: ' + JSON.stringify(said))
  assert.ok(!s.calls.includes('swap_accept'))
  const a = await S.confirm(q.id)
  assert.equal(a.filled, 0, 'never a fill before it is one')
  assert.equal(a.under_way, 1)
  assert.equal(a.state, 'sending')
  let o = await S.orders(origin)
  assert.equal(o.trades.length, 1)
  assert.equal(o.trades[0].note, USER_WORDS.goesThrough(2))
  s.through()
  const r = await until(eng, a.trade, (x) => x.state === 'settled')
  assert.equal(r.state, 'settled', JSON.stringify(r))
  o = await S.orders(origin)
  assert.equal(o.trades[0].state, 'settled')
})

test('SeqDEX: a limit order the book meets now, waiting for its coins, goes only at the limit or better', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  // XT with two decimals, so a price is YT atoms per 100 XT atoms.
  const fmt2 = (a, p) => (p ? (Number(a) / 10 ** p).toFixed(p) : String(a))
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } },
    assetMeta: (h) => (h === X ? { ticker: 'XT', precision: 2 } : { ticker: 'YT', precision: 0 }), fmtAtoms: fmt2, store: mem(), tag: () => 't', answerMs: 1000 })
  // Sell 400,000 XT atoms for at least 75 YT atoms per 100 (300,000 in all): the book gives just
  // that now, more than the 297,000 a market order would go for.
  const q = await S.quote({ type: 'limit', base: X, quote: Y, side: 'sell', amount: A, price: '75' }, 'o')
  assert.equal(q.kind, 'take')
  const said = q.display.rows.map(([, v]) => v)
  assert.ok(said.includes(USER_WORDS.atLeast(ABOUT + ' YT')), 'the limit raises the least: ' + JSON.stringify(said))
  const a = await S.confirm(q.id)
  assert.equal(eng.records().find((r) => r.id === a.trade).accepted.amountOut, ABOUT, 'held to the limit')
})

test('the words of a ticket that waits name no rail, never "try again", never "could not be made"', () => {
  for (const w of [USER_WORDS.atLeast('5 XT'), USER_WORDS.goesThrough(2), USER_WORDS.goesThrough(1), USER_WORDS.returnedMoved]) {
    assert.deepEqual(forbiddenIn(w), [], w)
    assert.ok(!/try again|could not be made/i.test(w), w)
  }
})

test('SeqDEX: a site\'s quote the person rejects leaves every coin where it was; nothing went into a round', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
    fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000 })
  const before = JSON.stringify(s.coins)
  for (let i = 0; i < 3; i++) {
    const q = await S.quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'https://dex.example/')
    assert.equal(q.kind, 'take')
    S.drop(q.id)
  }
  assert.equal(JSON.stringify(s.coins), before, 'every coin where it was')
  assert.deepEqual(s.settleAsks, [], 'nothing asked into a round')
  assert.ok(!s.calls.some((c) => ['settle_first', 'participate', 'swap_accept'].includes(c)), s.calls.join(','))
  assert.equal(eng.records().length, 0)
})

test('an operator that charges for the refresh: its fee is in the ticket accepted, on both surfaces', { timeout: 20_000 }, async () => {
  const s = standIn({ refreshFee: 500n })
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
  assert.ok(q.ok && q.ticket.indicative, JSON.stringify(q))
  assert.deepEqual(q.ticket.fees, [{ asset: X, atoms: '500' }], 'the refresh\'s fee, in the asset paid')
  // The price of what is left once the fee is paid: 399,500 X at 4 for 3 is 299,625 Y; less a hundredth.
  assert.equal(q.ticket.about, '299625')
  assert.equal(q.ticket.amountOut, '296628')
  assert.deepEqual(s.settleAsks, [])
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
    fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000 })
  const site = await S.quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'o')
  assert.ok(site.display.rows.some(([k, v]) => k === USER_WORDS.fees && /500 XT/.test(v)), JSON.stringify(site.display.rows))
  S.drop(site.id)
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = composerOf(eng, root)
  Object.assign(ui.state, { pay: X, get: Y, amount: A, payChosen: true, getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  assert.match(root.querySelector('#ucFees').textContent, /500 XT/)
  clearTimeout(ui.state.timer)
})

test('two tabs of one wallet: one moves a waiting trade on at a time, from the record as stored; it is accepted once, never written back (RV53 W1)', { timeout: 30_000 }, async () => {
  const s = standIn()
  let clock = Date.now()
  const tabA = engineOf(s, { now: () => clock })
  // Tab B shares the store and the library; its settle_first answers late, from before the round.
  let release = null
  const libB = { command (cmd, a) {
    if (cmd === 'settle_first' && !release) return new Promise((ok) => { release = () => ok({ settling: [], waiting: ['c1'], done: [], left: [], ready: false, ...WAIT }) })
    return s.lib.command(cmd, a)
  } }
  const tabB = engineOf({ ...s, lib: libB }, { now: () => clock })
  const of = (t, id) => t.records().find((r) => r.id === id)
  const accepts = () => s.calls.filter((c) => c === 'swap_accept').length
  const q = await tabA.quote({ payAsset: X, receiveAsset: Y, amount: A })
  const rec = await tabA.confirm(q.choice, q.ticket)
  clock += 11_000
  const bFollow = tabB.advance(of(tabB, rec.id))
  await wait(5)
  s.through()
  // While tab B moves it on, tab A leaves it be.
  for (let i = 0; i < 5; i++) { clock += 11_000; await wait(5); await tabA.advance(of(tabA, rec.id)) }
  assert.equal(accepts(), 0, 'nothing accepted while the other tab holds the trade')
  release()
  await bFollow
  for (let i = 0; i < 40 && of(tabA, rec.id).state !== 'settled'; i++) {
    clock += 11_000; await wait(5)
    for (const t of [tabA, tabB]) { const x = of(t, rec.id); if (x && !['settled', 'returned', 'failed'].includes(x.state)) await t.advance(x) }
  }
  const end = of(tabA, rec.id)
  assert.equal(end.state, 'settled', JSON.stringify(end))
  for (let i = 0; i < 10; i++) { clock += 11_000; await wait(5); for (const t of [tabA, tabB]) await t.advance(of(t, rec.id)) }
  assert.equal(accepts(), 1, 'accepted once')
  assert.equal(of(tabA, rec.id).state, 'settled', 'never written back')
  assert.equal(tabA.records().length, 1)
})

// #770: a trade accepted as waiting is followed by the page's own follow of its trades, and nothing
// else: no test hand advancing it. The page had opened with nothing open, so its follow was at rest
// when the site's trade was approved. The page's clock runs a hundred times faster than the test's,
// so the library's minutes are the test's tenths of a second.
const fast = () => { const t0 = Date.now(); return () => t0 + (Date.now() - t0) * 100 }
async function settles (eng, id, ms = 8000) {
  const t = Date.now()
  let r = eng.records().find((x) => x.id === id)
  while (Date.now() - t < ms && r && !['settled', 'returned', 'failed'].includes(r.state)) { await wait(20); r = eng.records().find((x) => x.id === id) }
  return r
}
const rowOf = (root, id) => (root.querySelector('#ucTrades') || { children: [] }).children.find((c) => c.dataset && c.dataset.trade === id) || null

for (const side of ['buy', 'sell']) {
  test(`#770: a site's market ${side} accepted as waiting has a row from its approval and goes by itself, with the page's follow at rest before it`, { timeout: 20_000 }, async () => {
    const s = standIn()
    const eng = engineOf(s, { now: fast() })
    const doc = fakeDoc()
    const root = doc.createElement('div')
    const ui = composerOf(eng, root, { followMs: 10, followSlowMs: 10 })
    ui.render()
    await ui.follow()
    const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
      fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000, followTrades: () => ui.follow(),
      busy: (on) => { ui.state.busy = !!on } })
    const origin = 'https://dex.example/'
    // A purchase of the base (YT) paid in the quote asset (XT), or a sale of the base (XT).
    const params = side === 'buy' ? { type: 'market', base: Y, quote: X, side: 'buy', amount: ABOUT } : { type: 'market', base: X, quote: Y, side: 'sell', amount: A }
    const q = await S.quote(params, origin)
    assert.equal(q.kind, 'take')
    assert.ok(q.display.rows.some(([, v]) => /^Goes through within about \d minutes$/.test(v)), JSON.stringify(q.display.rows))
    const a = await S.confirm(q.id)
    assert.equal(a.under_way, 1)
    for (let i = 0; i < 50 && !rowOf(root, a.trade); i++) await wait(10)
    const row = rowOf(root, a.trade)
    s.through()
    const r = await settles(eng, a.trade)
    clearTimeout(ui.state.timer)
    assert.ok(row, 'a row on the Trade tab from the approval')
    assert.equal(r.state, 'settled', 'it went by itself once its coins were through: ' + JSON.stringify(r && { state: r.state, error: r.error }))
    assert.equal((await S.orders(origin)).trades[0].state, 'settled', 'and the site is told so')
  })
}

// The page as the wallet's index.html builds it: the site's orders wake the Trade tab's follow.
const pageOf = (s, k = 100) => {
  const t0 = Date.now()
  const eng = engineOf(s, { now: () => t0 + (Date.now() - t0) * k })
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = composerOf(eng, root, { followMs: 10, followSlowMs: 10 })
  ui.render()
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
    fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000, followTrades: () => ui.follow(), busy: (on) => { ui.state.busy = !!on } })
  return { eng, root, ui, S, clock: () => t0 + (Date.now() - t0) * k }
}

test('#770: a waited Trade-tab trade ends by the page\'s follow alone', { timeout: 20_000 }, async () => {
  const s = standIn()
  const { eng, root, ui } = pageOf(s)
  await ui.follow()
  Object.assign(ui.state, { pay: X, get: Y, amount: A, payChosen: true, getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  await root.querySelector('#ucConfirm').onclick()
  for (let i = 0; i < 50 && !eng.records().length; i++) await wait(10)
  const id = eng.records()[0].id
  assert.ok(rowOf(root, id), 'its row')
  s.through()
  const r = await settles(eng, id)
  clearTimeout(ui.state.timer)
  assert.equal(r.state, 'settled', JSON.stringify(r && r.state))
})

test('#770: a waited site trade whose coins never come through says it takes longer, then comes back within its bound with nothing traded, on its row and to the site', { timeout: 30_000 }, async () => {
  // Every clock of the page at the same pace (the Trade tab and the site's answers read Date.now).
  const realNow = Date.now, t0 = realNow()
  Date.now = () => t0 + (realNow() - t0) * 200
  try {
  const s = standIn()
  const { eng, root, ui, S, clock } = pageOf(s, 1)
  await ui.follow()
  const origin = 'https://dex.example/'
  const q = await S.quote({ type: 'market', base: Y, quote: X, side: 'buy', amount: ABOUT }, origin)
  const a = await S.confirm(q.id)
  const since = clock()
  const words = new Set(), notes = new Set()
  let r = eng.records().find((x) => x.id === a.trade)
  for (let i = 0; i < 1000 && r.state === 'settling'; i++) {
    await wait(10)
    r = eng.records().find((x) => x.id === a.trade)
    const row = rowOf(root, a.trade)
    if (row) words.add(row.children[1].textContent)
    notes.add((await S.orders(origin)).trades[0].note)
  }
  const ended = clock()
  clearTimeout(ui.state.timer)
  assert.equal(r.state, 'returned', JSON.stringify(r.state))
  assert.equal(r.whyKind, 'late')
  // The bound: twice the most the library said (300 s), and two minutes, at least ten minutes.
  assert.ok(ended - since <= 12 * 60_000 + 60_000, 'within its bound: ' + Math.round((ended - since) / 1000) + ' s')
  assert.ok(words.has(USER_WORDS.goesThroughLate), 'the row said it takes longer: ' + [...words].join(' | '))
  assert.ok(notes.has(USER_WORDS.goesThroughLate), 'and so did the site: ' + [...notes].join(' | '))
  const end = (await S.orders(origin)).trades[0]
  assert.equal(end.state, 'failed')
  assert.equal(end.note, USER_WORDS.returnedLate)
  assert.ok(!s.calls.includes('swap_accept'), 'nothing traded')
  } finally { Date.now = realNow }
})

test('#770: a waited site trade whose coins went elsewhere comes back saying so, with nothing traded', { timeout: 20_000 }, async () => {
  const s = standIn()
  const { eng, ui, S } = pageOf(s)
  await ui.follow()
  const origin = 'https://dex.example/'
  const q = await S.quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, origin)
  const a = await S.confirm(q.id)
  // Another device of the wallet spent the coin: through, and nothing of X is left.
  s.coins.find((c) => c.leaf_id === 'c1').state = 'spent'
  const r = await settles(eng, a.trade)
  clearTimeout(ui.state.timer)
  assert.equal(r.state, 'returned', JSON.stringify(r && { state: r.state, error: r.error }))
  assert.equal(r.whyKind, 'gone', r.error)
  assert.equal((await S.orders(origin)).trades[0].note, USER_WORDS.returnedGone)
  assert.ok(!s.calls.includes('swap_accept'), 'nothing traded')
})

test('#770: a site\'s follow wakes the page\'s follow while a site trade is open, and moves none itself', { timeout: 20_000 }, async () => {
  const s = standIn()
  const eng = engineOf(s)
  let woken = 0
  const S = makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
    fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000, followTrades: () => { woken++ } })
  await S.follow()
  assert.equal(woken, 0, 'nothing open: nothing woken')
  const q = await S.quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'o')
  await S.confirm(q.id)
  await wait(10)
  assert.equal(woken, 1, 'woken once the trade is written')
  const asks = s.settleAsks.length
  await S.follow()
  assert.equal(woken, 2, 'and at each follow while it is open')
  assert.equal(s.settleAsks.length, asks, 'the site\'s follow moved nothing itself')
})

test('#770: the words of a returned waited trade name no rail', () => {
  for (const w of [USER_WORDS.returnedLate, USER_WORDS.returnedGone]) {
    assert.deepEqual(forbiddenIn(w), [], w)
    assert.ok(!/try again|could not be made/i.test(w), w)
  }
  assert.equal(tradeStateWord({ state: 'returned', whyKind: 'late' }), USER_WORDS.returnedLate)
  assert.equal(tradeStateWord({ state: 'returned', whyKind: 'gone' }), USER_WORDS.returnedGone)
})
