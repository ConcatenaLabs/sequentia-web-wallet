// A trade or a payment of coins the balance shows, which waits only for a round (the library's
// `settle_first`), settles them first and goes: the engine (user-trade.js), the composer mounted on
// a small stand-in document (user-composer.js), and the page's payments (leaves.js `paying`).

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createEngine, USER_WORDS, tradeStateWord, forbiddenIn } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'
import { refreshLeaves, shapeCoins } from './leaves.js'
import { DEFAULT_WORDS } from './default-arca.js'

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
function standIn ({ deepAt = 'read', rateNum = 4n, rateDen = 3n } = {}) {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'transfer', hops: 3 }]
  const swaps = []
  const calls = []
  const settleAsks = []
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
          last = a.offer.split(':'); swaps.push({ swap: 's1', role: 'taker', state: 'accepted' })
          return { swap: 's1', accept: 'swap-accept:xyz' }
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
  return { lib, fetchJson, store, calls, posts, settleAsks, coins, swaps, setRate (n, d) { rateNum = n; rateDen = d } }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store,
  sleep: async () => {}, quoteFirmMs: 2000, ...extra })

test('the words of settling first name no rail and no part of a balance', () => {
  for (const w of [USER_WORDS.settling, USER_WORDS.settleLate, USER_WORDS.returnedMoved, DEFAULT_WORDS.arrivingIn('5', 'USDX'), DEFAULT_WORDS.arrivingFigure]) {
    assert.deepEqual(forbiddenIn(w), [], w)
    assert.ok(!/can be traded now|only \S+ of your/i.test(w), w)
  }
  assert.equal(USER_WORDS.settling, 'Goes through in about a minute')
  // The answer that named a part of a balance is no longer given by the engine (only kept for
  // developer surfaces that name the cause).
  assert.ok(!/why: 'part-ready'[^\n]*\n[^\n]*\n/.test(''))
})

test('engine: a quote whose coins wait for a round is a ticket to accept now; the coins go into a round once it is accepted, and it goes once through', async () => {
  const s = standIn({ deepAt: 'read' })
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(q.ok, true, 'never "nobody could confirm a price" for coins the balance shows: ' + q.why)
  assert.equal(q.ticket.indicative, true)
  assert.deepEqual(q.choice.coins, ['c1'])
  assert.deepEqual(s.settleAsks, [], 'a price request gives nothing to a round')
  assert.ok(s.posts.some(([p]) => p === 'release'), 'the maker\'s firm offer is let go of')
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.deepEqual(s.settleAsks, [{ coins: ['c1'] }], 'accepted: the coins the library named go into the next round')
  assert.equal(rec.state, 'settling')
  let r = rec
  for (let i = 0; i < 8 && r.state !== 'settled'; i++) r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled', JSON.stringify(r))
  assert.ok(s.calls.indexOf('sync') > s.calls.indexOf('settle_first'), 'the round is looked for before it is called through')
})

test('engine: part of what the balance shows waiting for a round is a ticket to wait and go, never "Only X of your Y"', async () => {
  const s = standIn({ deepAt: 'none' })
  // 100,000 live, the rest given up in a refresh that the wallet's own round runs.
  s.coins[0].value = '100000'
  s.coins.push({ leaf_id: 'r1', asset: X, value: '2900000', state: 'given', kind: 'transfer' })
  const eng = engineOf(s, { held: () => 3000000n })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.equal(q.ok, true, JSON.stringify(q, (k, v) => typeof v === 'bigint' ? String(v) : v))
  assert.equal(q.ticket.indicative, true)
  assert.deepEqual(s.settleAsks, [], 'a price request gives nothing to a round')
  await eng.confirm(q.choice, q.ticket)
  assert.deepEqual(s.settleAsks, [{ asset: X }], 'the engine names no coins: the library settles what of the asset waits')
})

async function confirmedWhileDeep (s, eng) {
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  return { q, rec }
}

test('engine: a confirmation answered settle_first keeps the trade, settles, and goes ahead by itself within the price accepted', async () => {
  const s = standIn({ deepAt: 'accept' })
  const eng = engineOf(s)
  const { q, rec } = await confirmedWhileDeep(s, eng)
  assert.equal(rec.state, 'settling')
  assert.equal(tradeStateWord(rec), USER_WORDS.settling)
  assert.deepEqual(rec.settleCoins, ['c1'])
  assert.ok(s.posts.filter(([p]) => p === 'release').length >= 1, 'the firm offer accepted is let go of while the coins settle')
  // Moved on as the page follows its trades: waits, then is through, priced again and confirmed.
  let r = rec
  for (let i = 0; i < 6 && r.state === 'settling'; i++) r = await eng.advance(eng.records().find((x) => x.id === rec.id))
  assert.equal(r.state, 'sent', JSON.stringify(r))
  assert.equal(r.id, rec.id, 'the same trade, never made twice')
  assert.equal(eng.records().length, 1)
  assert.deepEqual(r.accepted, q.ticket, 'the price the person accepted is kept with it')
  assert.ok(BigInt(r.ticket.amountOut) * 10000n >= BigInt(q.ticket.amountOut) * 9900n)
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('engine: a settled-first trade whose price moved past the bound is returned, with words', async () => {
  const s = standIn({ deepAt: 'accept' })
  const eng = engineOf(s)
  const { rec } = await confirmedWhileDeep(s, eng)
  assert.equal(rec.state, 'settling')
  s.setRate(5n, 3n)   // a quarter more to pay for each Y
  let r = rec
  for (let i = 0; i < 6 && r.state === 'settling'; i++) r = await eng.advance(eng.records().find((x) => x.id === rec.id))
  assert.equal(r.state, 'returned', JSON.stringify(r))
  assert.equal(r.whyKind, 'moved')
  assert.equal(tradeStateWord(r), USER_WORDS.returnedMoved)
  assert.ok(!s.calls.slice(s.calls.lastIndexOf('settle_first')).includes('swap_accept'), 'nothing was accepted at the moved price')
})

test('engine: a page closed while a trade settles first finds it again, and it completes once', async () => {
  const s = standIn({ deepAt: 'accept' })
  const first = engineOf(s)
  const { rec } = await confirmedWhileDeep(s, first)
  assert.equal(rec.state, 'settling')
  // The page is closed and opened again: a new engine over the same store.
  const second = engineOf(s)
  let out = await second.resume()
  for (let i = 0; i < 6 && out.some((r) => r.state === 'settling'); i++) out = await second.resume()
  const recs = second.records()
  assert.equal(recs.length, 1, 'never made twice')
  assert.ok(['sent', 'settled'].includes(recs[0].state), JSON.stringify(recs[0]))
  assert.equal(s.swaps.length, 1, 'one acceptance')
})

test('the library\'s shape rule is settled on its own, never by the refresh of what was received', () => {
  const v = { needed: true, reasons: [{ rule: 'arriving', coins: ['a1'] }, { rule: 'shape', coins: ['d1', 'd2'] }] }
  assert.deepEqual(refreshLeaves(v), ['a1'])
  assert.deepEqual(shapeCoins(v), ['d1', 'd2'])
  assert.deepEqual(shapeCoins({ needed: true, reasons: [{ rule: 'idle' }] }), [])
})

// ---- the composer, mounted on a small stand-in document ----
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

test('composer: a trade answered settle-first shows its ticket and how long at once; one Trade, and it completes by itself', async () => {
  const s = standIn({ deepAt: 'read' })
  const eng = engineOf(s)
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine: eng, held: (a) => (a === X ? 3000000n : 0n), knownAssets: () => [X, Y], assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50,
  })
  Object.assign(ui.state, { pay: X, get: Y, amount: '400000', payChosen: true, getChosen: true })
  try { ui.render() } catch (e) { assert.fail('the composer renders on the stand-in document: ' + e.stack) }
  await root.querySelector('#ucReview').onclick()
  assert.ok(ui.state.ticket && ui.state.ticket.indicative, 'a ticket at once: ' + (ui.state.error || ui.state.note))
  assert.equal(root.querySelector('#ucWait').textContent, USER_WORDS.settling, 'how long, in the words of settling')
  assert.equal(ui.state.error, '')
  assert.ok(!s.calls.includes('swap_accept'), 'nothing is traded before the person accepts')
  await root.querySelector('#ucConfirm').onclick()
  for (let i = 0; i < 50 && !eng.records().length; i++) await wait(10)
  // The composer's own follow may be moving the trade on: an advance asked meanwhile answers the
  // record as stored (one advance of a record at a time), so it is asked until the trade ends.
  let r = await eng.advance(eng.records()[0])
  for (let i = 0; i < 50 && r.state !== 'settled'; i++) { await wait(10); r = await eng.advance(eng.records()[0]) }
  assert.equal(r.state, 'settled', JSON.stringify(r))
  assert.equal(eng.records().length, 1)
})

test('composer: two follows asked at once run one after the other, never side by side (RV38 W1)', async () => {
  let running = 0, most = 0, calls = 0
  const open = [{ id: 'r1', state: 'settling', at: Date.now() }]
  const engine = {
    records: () => open, quote: async () => ({ ok: false, why: 'no-funds' }), estimate: async () => null, offered: async () => [],
    resume: async () => { calls++; running++; most = Math.max(most, running); await wait(20); running--; return [] },
    soon: () => false, spendable: async () => new Map(),
  }
  const doc = fakeDoc()
  const ui = mountUserComposer({
    root: doc.createElement('div'), engine, held: () => 0n, knownAssets: () => [X, Y], assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9,
  })
  await Promise.all([ui.follow(), ui.follow(), ui.follow()])
  for (let i = 0; i < 20 && running; i++) await wait(10)
  assert.equal(most, 1, 'resumed side by side')
  assert.equal(calls, 2, 'the follows asked meanwhile run once more after it, together')
  clearTimeout(ui.state.timer)
})

test('composer: money still arriving can be traded: its asset is offered to pay, and the trade settles first, then goes (D96)', async () => {
  // The wallet's figure holds nothing yet; 3,000,000 X is on its way (a payment past the instant
  // limit). The library's coin c1 must be settled before it can be traded.
  const s = standIn({ deepAt: 'read' })
  const eng = engineOf(s, { held: (a) => (a === X ? 3000000n : 0n) })   // the page's engine counts what is on its way
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine: eng, held: () => 0n, onItsWay: (a) => (a === X ? 3000000n : 0n), knownAssets: () => ['BTC', X, Y],
    assetMeta: (h) => ({ ticker: h === X ? 'XT' : h === Y ? 'YT' : 'BTC', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50,
  })
  ui.render()
  assert.equal(ui.state.pay, X, 'what is on its way is offered to pay, first when nothing else is held')
  assert.equal(root.querySelector('#ucHaveLine').textContent, 'balance 0 XT \u00b7 3000000 XT arriving, in about a minute')
  root.querySelector('#ucMax').onclick()
  assert.equal(ui.state.amount, '3000000', 'Max fills what can be traded: the balance and what is on its way')
  Object.assign(ui.state, { get: Y, amount: '400000', getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  for (let i = 0; i < 50 && !ui.state.ticket; i++) await wait(10)
  assert.ok(ui.state.ticket, 'priced once settled: ' + (ui.state.error || ui.state.note))
  assert.equal(s.settleAsks.length, 0, 'nothing settled before the person accepts')
  await root.querySelector('#ucConfirm').onclick()
  for (let i = 0; i < 50 && !eng.records().length; i++) await wait(10)
  assert.ok(s.settleAsks.length > 0, 'accepted: settled first')
  let r = await eng.advance(eng.records()[0])
  for (let i = 0; i < 50 && r.state !== 'settled'; i++) { await wait(10); r = await eng.advance(eng.records()[0]) }
  assert.equal(r.state, 'settled', JSON.stringify(r))
  clearTimeout(ui.state.timer)
  // The page wires it: the engine's figure counts what is on its way, the composer lists it.
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /held: \(a\)=> userHeld\(a\) \+ onItsWay\(a\),/)
  assert.match(html, /onItsWay: \(a\)=> onItsWay\(a\),/)
})
