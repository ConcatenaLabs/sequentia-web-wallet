// arca #879, the page's side: the page promises money on its way, and a time for it, only from the
// wallet library's own answer (a `settle_first` refusal: its coins and its wait). While a restore
// still checks the wallet's history it promises nothing; a ticket with no wait from the library
// names no time; a part of a balance is never said to be on its way; and a trade that waits asks
// the other side for a firm offer once its coins are through, not at every follow.
// All on the real engine, composer and site orders, with a stand-in library and maker.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, tradeStateWord, forbiddenIn, REPRICE_AGAIN_MS } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'
import { makeSiteOrders } from './site-orders.js'
import { refusalWords } from './ark-rail.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)
const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

const WAIT = { final_in_seconds: 300, usual_in_seconds: 120, waiting_for: 'round' }
function settleFirstError (coins) {
  const e = new Error('refused: the wallet\'s coins of asset ' + X + ' … settle them first (settle_first) …, usually within 120 s and at most 300 s')
  Object.assign(e, { kind: 'settle_first', asset: X, coins }, WAIT)
  return e
}

// The wallet's coin of X, `c1`:
//  - 'deep': live, too deep to give part of: swap_read refuses with settle_first and the library's wait;
//  - 'given': in a refresh of the wallet's own, not live: the engine finds nothing payable (no wait);
//  - 'live': payable now.
// `stuck`: the library's two answers disagree, as in a restore's history window: settle_first says
// the coins are through while every quote is refused for them.
function standIn ({ coin = 'deep', stuck = false } = {}) {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: coin === 'given' ? 'given' : 'live', kind: 'transfer', hops: coin === 'deep' ? 3 : 0 }]
  const calls = [], posts = []
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_read':
          if (stuck || coin === 'deep') throw settleFirstError(['c1'])
          return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: a.offer.split(':')[2] }, pays: { asset: X, margins: '0' },
            change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } }
        case 'swaps': return []
        case 'settle_first': return stuck ? { settling: [], waiting: [], done: ['c1'], left: [], ready: true } : { settling: [], waiting: ['c1'], done: [], left: [], ready: false, ...WAIT }
        case 'sync': return {}
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '0', after: a.value }
        case 'quote': return { coins: a.leaves.map((l) => ({ leaf_id: l, fee: '0' })) }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    posts.push(url.split('/v1/')[1])
    if (url.endsWith('/v1/firm')) return { swap: 's' + posts.length, offer: `swap-offer:${b.give}:${(BigInt(b.give) * 4n + 2n) / 3n}`, give: b.give, want: String((BigInt(b.give) * 4n + 2n) / 3n) }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, calls, posts, coins }
}
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store,
  sleep: () => wait(1), quoteFirmMs: 500, held: (a) => (a === X ? 3000000n : 0n), ...extra })
const meta = (h) => (h === X ? { ticker: 'XT', precision: 0 } : { ticker: 'YT', precision: 0 })
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }
const siteOf = (eng) => makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
  fmtAtoms: (a) => String(a), store: mem(), tag: () => 't', answerMs: 1000 })
const A = '400000'
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))

test('while a restore checks the wallet\'s history, a trade that would wait on money on its way is not ticketed: it says the wallet is being restored, and nothing moves', { timeout: 20_000 }, async () => {
  for (const coin of ['deep', 'given']) {
    const s = standIn({ coin })
    let restoring = true
    const eng = engineOf(s, { restoring: () => restoring })
    const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
    assert.deepEqual(q, { ok: false, why: 'restoring' }, coin)
    // On a site: the same words, and nothing moved.
    await assert.rejects(siteOf(eng).quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'o'), (e) => e.message === USER_WORDS.restoring)
    // In developer mode's Ark rail: the same words.
    assert.equal(refusalWords({ ...q, payAsset: X, receiveAsset: Y }, (h) => meta(h).ticker, (h, a) => a + ' ' + meta(h).ticker), USER_WORDS.restoring)
    assert.ok(!s.calls.includes('settle_first'), 'nothing given to a round')
    assert.equal(eng.records().length, 0)
    // The restore done: the ticket to wait and go, as before.
    restoring = false
    const q2 = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
    assert.ok(q2.ok && q2.ticket.indicative, coin + ': ' + J(q2))
  }
  // Coins payable now are priced during a restore all the same: nothing waits on history.
  const s = standIn({ coin: 'live' })
  const q = await engineOf(s, { restoring: () => true }).quote({ payAsset: X, receiveAsset: Y, amount: A })
  assert.ok(q.ok && !q.ticket.indicative, J(q))
})

test('the Trade tab, while restoring, says the wallet is being restored', { timeout: 20_000 }, async () => {
  const s = standIn({ coin: 'deep' })
  const eng = engineOf(s, { restoring: () => true })
  const { root, ui } = composer(eng)
  Object.assign(ui.state, { pay: X, get: Y, amount: A, payChosen: true, getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  assert.equal(ui.state.ticket, null)
  assert.equal(ui.state.error, USER_WORDS.restoring)
  clearTimeout(ui.state.timer)
})

test('a ticket with no wait from the wallet names no time, on the Trade tab and on a site; with the library\'s wait it counts down from it', { timeout: 20_000 }, async () => {
  const s = standIn({ coin: 'given' })
  const eng = engineOf(s)
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
  assert.ok(q.ok && q.ticket.indicative && q.ticket.finalBy == null, J(q))
  const site = await siteOf(eng).quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'o')
  const said = site.display.rows.map(([, v]) => v)
  assert.ok(said.includes(USER_WORDS.settling), JSON.stringify(said))
  assert.ok(!said.some((v) => /minute/.test(v)), 'no time promised: ' + JSON.stringify(said))
  const { root, ui } = composer(eng)
  Object.assign(ui.state, { pay: X, get: Y, amount: A, payChosen: true, getChosen: true })
  ui.render()
  await root.querySelector('#ucReview').onclick()
  assert.equal(root.querySelector('#ucWait').textContent, USER_WORDS.settling)
  clearTimeout(ui.state.timer)
  assert.equal(tradeStateWord({ state: 'settling', settleSince: Date.now() - 600_000 }), USER_WORDS.settling, 'the row promises no time either')
  // With the library's wait: within about its minutes.
  const d = await siteOf(engineOf(standIn({ coin: 'deep' }))).quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: A }, 'o')
  assert.ok(d.display.rows.some(([, v]) => v === USER_WORDS.goesThrough(2)), JSON.stringify(d.display.rows))
})

test('a site\'s order for more than the wallet holds is said so, never "the rest is on its way"', { timeout: 20_000 }, async () => {
  const s = standIn({ coin: 'live' })
  const eng = engineOf(s)
  await assert.rejects(siteOf(eng).quote({ type: 'market', base: X, quote: Y, side: 'sell', amount: '5000000' }, 'o'), (e) => {
    assert.equal(e.message, USER_WORDS.moreThanHeld('3000000 XT'))
    return true
  })
  assert.equal(refusalWords({ ok: false, why: 'part-ready', ready: '3000000', payAsset: X, receiveAsset: Y }, (h) => meta(h).ticker, (h, a) => a + ' ' + meta(h).ticker), USER_WORDS.moreThanHeld('3000000 XT'))
  assert.equal(USER_WORDS.partReady, undefined)
})

test('a waiting trade the library calls through while every price is refused for its coins asks the other side once per refusal\'s wait, not at every follow; its row counts down to that wait and says when it passes', { timeout: 30_000 }, async () => {
  const s = standIn({ coin: 'deep' })
  let clock = Date.now()
  const eng = engineOf(s, { now: () => clock })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: A })
  assert.ok(q.ok && q.ticket.indicative, J(q))
  // The coins are now "through" by settle_first's word, while each price is refused for them.
  const rec = await eng.confirm(q.choice, q.ticket)
  Object.assign(s, {})
  s.lib.command = ((orig) => (cmd, a) => cmd === 'settle_first' ? { settling: [], waiting: [], done: ['c1'], left: [], ready: true } : orig(cmd, a))(s.lib.command)
  const firms = () => s.posts.filter((p) => p === 'firm').length
  const before = firms()
  // Followed every five seconds for 75 seconds, as the page's follows do.
  let r = rec
  const words = []
  for (let t = 0; t < 75_000; t += 5000) {
    clock += 5000
    r = await eng.advance(eng.records().find((x) => x.id === rec.id))
    words.push(tradeStateWord(r, clock))
  }
  assert.equal(r.state, 'settling', JSON.stringify(r.state))
  const asked = firms() - before
  assert.ok(asked >= 1 && asked <= 2, 'the other side asked once per refusal\'s wait (120 s), not every five seconds: ' + asked)
  assert.ok(r.finalBy != null, 'the refusal\'s wait is the trade\'s time')
  // Past that time by two minutes, the row says it takes longer, never the old time.
  clock = r.finalBy + 121_000
  assert.equal(tradeStateWord(r, clock), USER_WORDS.goesThroughLate)
  assert.ok(REPRICE_AGAIN_MS >= 30_000)
})

test('the new words name no rail and promise no time', () => {
  for (const w of [USER_WORDS.restoring, USER_WORDS.settling]) {
    assert.deepEqual(forbiddenIn(w), [], w)
    assert.ok(!/minute|seconds?/.test(w), w)
  }
})

function fakeDoc () {
  function mk (tag) {
    const e = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, _id: '', _text: '', className: '',
      value: '', disabled: false, type: '', title: '', options: [], selectedIndex: 0,
      get id () { return this._id }, set id (v) { this._id = v },
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
function composer (eng) {
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine: eng, held: (a) => (a === X ? 3000000n : 0n), knownAssets: () => [X, Y], assetMeta: meta,
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50 })
  return { root, ui }
}
