// A purchase paid with BTC has its row from the approval, on the Trade tab and for a site, and its
// card follows it to its end (#774). Its BTC is paid once what it buys is held for the wallet; a
// second purchase asked meanwhile, when nobody offers it, is told why and priced again by itself;
// a page reloaded between the approval and the payment shows the row and goes on. All on the real
// engine, composer and site orders, with stand-ins of the leaf library, the BTC desk and the
// wallet's Bitcoin Lightning.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, forbiddenIn } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'
import { makeSiteOrders } from './site-orders.js'
import { MAKER_LOCK_MS } from './user-trade-btc.js'

const X = 'aa'.repeat(32)
const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

// The library, the desk and the Bitcoin Lightning wallet. Each firm offer is under its own hash.
// `s.deskHolds`: the desk offers nothing while a purchase of this wallet is unpaid (its coins are
// held for it), as the testnet's desk did on 2026-11-13. `s.ready`: what the wallet bought is held
// for good, so its BTC can be paid.
function standIn () {
  const s = { calls: [], posts: [], coins: [], receives: {}, parts: [], btcPaid: [], ready: false, deskHolds: false, n: 0, firms: {} }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) }
  s.mem = mem
  const unpaid = () => Object.values(s.firms).some((f) => !f.paid && !f.released)
  s.lib = {
    command (cmd, a) {
      s.calls.push(cmd)
      switch (cmd) {
        case 'coins': return s.coins
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return s.parts
        case 'lightning_receive_quote': return { asset: X, amount: a.amount, fee: '200', value: String(BigInt(a.amount) - 200n), claim_margins: '416', claimed: String(BigInt(a.amount) - 616n) }
        case 'settle_quote': return { asset: X, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'lightning_receive': s.receives[a.hash] = { state: 'waiting' }; return { invoice: 'lnsqrt-' + a.hash.slice(0, 4), fee: '200', value: String(BigInt(a.amount) - 200n) }
        case 'lightning_receives': return s.receives
        case 'lightning_receive_ready': return s.ready ? { ready: true } : { ready: false, why: 'not final yet' }
        case 'lightning_post_preimage': return {}
        case 'lightning_receive_preimage': {
          const r = s.receives[a.hash]; r.preimage = a.preimage; r.state = 'received'; r.leaf = 'r-' + a.hash.slice(0, 4)
          s.coins.push({ leaf_id: r.leaf, asset: X, value: '99384', state: 'live' }); return {}
        }
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': { const p = (a.leaves || []).map((l) => ({ participation: 'p-' + l, state: 'released', new_leaves: [{ state: 'live' }] })); s.parts.push(...p); return { participations: p } }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    const b = init && init.body ? JSON.parse(init.body) : null
    if (url.endsWith('/v1/quotes')) {
      if (s.deskHolds && unpaid()) return { quotes: [] }
      return { quotes: [{ give_asset: X, want_asset: 'BTC', rate_num: '1', rate_den: '2', min_give: '1000', max_give: '1000000' }] }
    }
    s.posts.push([url.split('/v1/btc/')[1], b])
    if (url.endsWith('/v1/btc/firm')) {
      const h = String(++s.n).padStart(2, '0').repeat(32)
      s.firms[h] = { swap: 'sw' + s.n, sats: (BigInt(b.give) + 1n) / 2n }
      return { swap: 'sw' + s.n, invoice: 'lnbcrt-' + h, give: b.give, want: String(s.firms[h].sats), expires_at: 4e9 }
    }
    if (url.endsWith('/v1/btc/release')) { for (const f of Object.values(s.firms)) if (f.swap === b.swap) f.released = true; return {} }
    if (url.endsWith('/v1/btc/lock')) return {}
    return {}
  }
  const hashOf = (inv) => inv.slice('lnbcrt-'.length)
  s.btc = {
    balance: async () => 500000n,
    decode: async (inv) => ({ sats: s.firms[hashOf(inv)].sats, payment_hash: hashOf(inv), expires_at: 4e9, min_final_cltv: 18 }),
    cancelInvoice: async () => {},
    pay: async ({ invoice }) => { s.btcPaid.push(invoice); s.firms[hashOf(invoice)].paid = true; return { state: 'complete', preimage: 'ef'.repeat(32) } },
    payStatus: async (h) => (s.firms[h] && s.firms[h].paid ? { state: 'complete', preimage: 'ef'.repeat(32) } : { state: 'none' }),
  }
  return s
}
// The page before a reload: once closed, nothing of it runs any more.
const closable = (s) => {
  const page = { closed: false }
  const gone = () => { throw new Error('the page is closed') }
  page.lib = { command: (c, a) => (page.closed ? gone() : s.lib.command(c, a)) }
  page.fetchJson = (u, i) => (page.closed ? Promise.reject(new Error('the page is closed')) : s.fetchJson(u, i))
  page.btc = Object.fromEntries(Object.entries(s.btc).map(([k, f]) => [k, (...a) => (page.closed ? Promise.reject(new Error('the page is closed')) : f(...a))]))
  return page
}
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, btc: s.btc,
  sleep: () => wait(1), quoteFirmMs: 2000, btcOnlyFirmMs: 2000, ...extra })

function fakeDoc () {
  const byId = new Map()
  function mk (tag) {
    const e = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, _id: '', _text: '', className: '', isConnected: true,
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
        const ok = sel.startsWith('#') ? (n) => n._id === sel.slice(1) : sel.startsWith('.') ? (n) => String(n.className || '').split(/\s+/).includes(sel.slice(1)) : () => false
        const f = (n) => { if (ok(n)) return n; for (const c of n.children) { const r = f(c); if (r) return r } return null }
        return f(this)
      },
      querySelectorAll () { return [] }, closest () { return null }, getBoundingClientRect () { return { width: 0, height: 0, top: 0, left: 0 } },
    }
    return e
  }
  const doc = { createElement: mk, createTextNode: (t) => Object.assign(mk('#text'), { textContent: t }), addEventListener () {}, removeEventListener () {}, body: null }
  doc.body = mk('body')
  return doc
}
globalThis.document = fakeDoc()
const doc = globalThis.document

const composerOf = (eng) => {
  const root = doc.createElement('div')
  const ui = mountUserComposer({ root, engine: eng, held: (a) => (a === 'BTC' ? 500000n : 0n), knownAssets: () => ['BTC', X],
    assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'BTC', precision: 0 }), fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t),
    admittedReceives: () => [X], market: null, refValue: () => null, session: null, notify: () => {}, links: () => [], openHistory: () => {},
    followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50 })
  Object.assign(ui.state, { pay: 'BTC', get: X, amount: '50000', payChosen: true, getChosen: true })
  ui.render()
  return { ui, root }
}
// The Trade tab's rows: [id, state, words].
const rows = (root) => {
  const out = []
  const f = (n) => { if (n.dataset && n.dataset.trade) out.push([n.dataset.trade, n.dataset.state, n.children.map((c) => c.textContent)[1]]); n.children.forEach(f) }
  f(root.querySelector('#ucTrades'))
  return out
}
// The trade card over the page, and its status line.
const card = () => doc.body.children.find((c) => /uc-card-modal/.test(c.className)) || null
const cardState = () => { const c = card(); const s = c && c.querySelector('.uc-card-state'); return s ? s.textContent : null }
const button = (n, text) => { if (n.tagName === 'BUTTON' && n.textContent === text) return n; for (const c of n.children) { const r = button(c, text); if (r) return r } return null }
const closeCards = () => { for (const c of [...doc.body.children]) c.remove() }

// Follows as the page does (one pass of the Trade tab's follow), `n` times or until `ok`.
async function follow (ui, ok, n = 20) { for (let i = 0; i < n; i++) { await ui.follow(); if (ok && ok()) return true; await wait(2) } return false }

test('Trade tab: a purchase paid with BTC has its row from the approval, its card follows it, and Done closes the card', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  await root.querySelector('#ucReview').onclick()
  assert.ok(ui.state.ticket, 'a ticket: ' + ui.state.error)
  await root.querySelector('#ucConfirm').onclick()
  let r = rows(root)
  assert.equal(r.length, 1, 'a row from the approval')
  assert.equal(r[0][2], USER_WORDS.waitingOther)
  assert.equal(cardState(), USER_WORDS.waitingOther, 'the card says the same')
  assert.equal(s.btcPaid.length, 0, 'no BTC before what it buys is held')
  s.ready = true
  assert.ok(await follow(ui, () => /^Received/.test(rows(root)[0][2])), 'received: ' + JSON.stringify(rows(root)))
  assert.equal(s.btcPaid.length, 1, 'its BTC paid once')
  assert.match(cardState(), /^Received/, 'the card followed it, not stuck at its first step')
  assert.ok(await follow(ui, () => rows(root)[0][1] === 'settled'), 'settled: ' + JSON.stringify(rows(root)))
  assert.equal(cardState(), USER_WORDS.settled)
  button(card(), USER_WORDS.done).onclick()
  assert.equal(card(), null, 'Done closes the card')
  assert.equal(rows(root).length, 1, 'the row stays')
  clearTimeout(ui.state.timer)
})

test('Trade tab: Done closes the card while the purchase still waits, and the row goes on under it', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  await root.querySelector('#ucReview').onclick()
  await root.querySelector('#ucConfirm').onclick()
  assert.ok(card(), 'the card opens')
  button(card(), USER_WORDS.done).onclick()
  assert.equal(card(), null)
  assert.equal(rows(root)[0][2], USER_WORDS.waitingOther)
  clearTimeout(ui.state.timer)
})

const meta = (h) => (h === X ? { ticker: 'XT', precision: 0 } : { ticker: 'BTC', precision: 0 })
const siteOf = (eng, ui) => makeSiteOrders({ engine: eng, leaves: { command: async () => { throw new Error('nothing rests here') } }, assetMeta: meta,
  fmtAtoms: (a) => String(a), store: { m: new Map(), getItem (k) { return this.m.get(k) ?? null }, setItem (k, v) { this.m.set(k, v) } }, tag: () => 't',
  answerMs: 1000, followTrades: () => ui.follow() })

test('a site\'s purchase paid with BTC: its row on the Trade tab from the approval, and the site told each step in the same words', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  const site = siteOf(eng, ui)
  const origin = 'https://dex.example/'
  const q = await site.quote({ type: 'market', base: X, quote: 'BTC', side: 'buy', amount: '90000' }, origin)
  assert.equal(q.kind, 'take', JSON.stringify(q))
  const a = await site.confirm(q.id)
  assert.equal(a.under_way, 1); assert.equal(a.note, USER_WORDS.waitingOther, 'the site is told to keep the page open')
  await wait(5)
  assert.equal(rows(root).length, 1, 'its row on the Trade tab from the approval')
  assert.equal(rows(root)[0][2], USER_WORDS.waitingOther)
  let o = await site.orders(origin)
  assert.equal(o.trades[0].note, USER_WORDS.waitingOther)
  s.ready = true
  assert.ok(await follow(ui, () => rows(root)[0][1] === 'settled'), JSON.stringify(rows(root)))
  assert.equal(s.btcPaid.length, 1)
  o = await site.orders(origin)
  assert.equal(o.trades[0].state, 'settled')
  clearTimeout(ui.state.timer)
})

test('two purchases paid with BTC in a row: the second, asked while the desk holds the first, is told why and priced by itself once the first is paid', { timeout: 60_000 }, async () => {
  closeCards()
  const s = standIn()
  s.deskHolds = true
  let t = Date.now()
  const eng = engineOf(s, { now: () => t })
  const { ui, root } = composerOf(eng)
  await root.querySelector('#ucReview').onclick()
  await root.querySelector('#ucConfirm').onclick()
  assert.equal(rows(root).length, 1)
  closeCards()
  // The Trade tab: said plainly, never "it takes a moment".
  Object.assign(ui.state, { amount: '50000' })
  await root.querySelector('#ucReview').onclick()
  assert.equal(ui.state.ticket, null)
  assert.equal(ui.state.error, USER_WORDS.btcAhead)
  assert.deepEqual(forbiddenIn(USER_WORDS.btcAhead), [])
  // A site: the same words.
  const site = siteOf(eng, ui)
  await assert.rejects(site.quote({ type: 'market', base: X, quote: 'BTC', side: 'buy', amount: '90000' }, 'o'), (e) => e.message === USER_WORDS.btcAhead)
  // The first is paid: the second is priced, and goes.
  s.ready = true
  assert.ok(await follow(ui, () => s.btcPaid.length === 1), 'the first is paid')
  // The Trade tab prices it again by itself (READY_RETRY_MS later), as here.
  t += 20_000
  await root.querySelector('#ucReview').onclick()
  assert.ok(ui.state.ticket, 'priced once the first is paid: ' + ui.state.error)
  await root.querySelector('#ucConfirm').onclick()
  assert.equal(rows(root).length, 2, 'both rows')
  assert.ok(await follow(ui, () => rows(root).every((x) => x[1] === 'settled'), 40), JSON.stringify(rows(root)))
  assert.equal(s.btcPaid.length, 2, 'each BTC paid once')
  clearTimeout(ui.state.timer)
})

test('a page reloaded between the approval and the payment: the row is there at once, and the purchase goes on', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  const page = closable(s)
  const first = composerOf(engineOf(s, { leaves: page.lib, fetchJson: page.fetchJson, btc: page.btc }))
  await first.root.querySelector('#ucReview').onclick()
  await first.root.querySelector('#ucConfirm').onclick()
  clearTimeout(first.ui.state.timer)
  page.closed = true
  closeCards()
  // The page again, on the same store.
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  assert.equal(rows(root).length, 1, 'the row is there when the page opens')
  assert.equal(rows(root)[0][2], USER_WORDS.waitingOther)
  s.ready = true
  assert.ok(await follow(ui, () => rows(root)[0][1] === 'settled'), JSON.stringify(rows(root)))
  assert.equal(s.btcPaid.length, 1)
  clearTimeout(ui.state.timer)
})

test('a page reloaded after the desk never paid in: the row says it came back, nothing paid', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  let t = Date.now()
  const page = closable(s)
  const first = composerOf(engineOf(s, { leaves: page.lib, fetchJson: page.fetchJson, btc: page.btc, now: () => t }))
  await first.root.querySelector('#ucReview').onclick()
  await first.root.querySelector('#ucConfirm').onclick()
  clearTimeout(first.ui.state.timer)
  page.closed = true
  closeCards()
  t += MAKER_LOCK_MS + 1000
  const { ui, root } = composerOf(engineOf(s, { now: () => t }))
  assert.equal(rows(root).length, 1)
  assert.ok(await follow(ui, () => rows(root)[0][1] === 'returned'), JSON.stringify(rows(root)))
  assert.equal(rows(root)[0][2], USER_WORDS.returned)
  assert.equal(s.btcPaid.length, 0, 'no BTC paid')
  clearTimeout(ui.state.timer)
})

test('a wallet with a long coin history keeps every trade: only an unfinished trade holds the coin list, an ended one none (#776)', { timeout: 60_000 }, async () => {
  closeCards()
  const s = standIn()
  // Weeks of trades: 3,000 coins spent, exited or lost, and two live ones.
  for (let i = 0; i < 3000; i++) s.coins.push({ leaf_id: i.toString(16).padStart(64, '0'), asset: X, value: '1', state: ['spent', 'exited', 'lost'][i % 3] })
  s.coins.push({ leaf_id: 'f1'.repeat(32), asset: X, value: '5', state: 'live' }, { leaf_id: 'f2'.repeat(32), asset: X, value: '5', state: 'given' })
  s.ready = true
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  const befores = []
  for (let i = 0; i < 12; i++) {
    ui.state.amount = '50000'
    await root.querySelector('#ucReview').onclick()
    assert.ok(ui.state.ticket, ui.state.error)
    await root.querySelector('#ucConfirm').onclick()
    closeCards()
    const open = eng.records().find((r) => r.state !== 'settled')
    befores.push(open.before)
    assert.ok(await follow(ui, () => eng.records().every((r) => r.state === 'settled')), JSON.stringify(rows(root)))
  }
  const recs = eng.records()
  assert.equal(recs.length, 12, 'every trade kept')
  // Spent coins included: the library can make a spent or lost coin live again.
  assert.ok(befores.every((b) => b.length >= 3002 && b.includes('0'.repeat(64))), 'an unfinished trade keeps every coin: ' + befores.map((b) => b.length))
  assert.ok(recs.every((r) => !r.before), 'an ended one keeps none')
  assert.equal(rows(root).length, 8, 'the Trade tab lists the newest eight ended trades')
  assert.ok(s.store.getItem('swk.usertrade.default').length < 100_000, 'the store stays small once its trades end')
  clearTimeout(ui.state.timer)
})

test('a store written with the whole coin history in every record is made lean at its next write, and keeps every trade from then (#776)', { timeout: 30_000 }, async () => {
  closeCards()
  const s = standIn()
  s.ready = true
  const history = Array.from({ length: 1575 }, (_, i) => i.toString(16).padStart(64, '0'))
  // Eight ended trades as the testnet's trader kept them: about 110 KB each, the store near its bound.
  const fat = Array.from({ length: 8 }, (_, i) => ({ id: `${1000 + i}-fat`, at: Date.now() - 1000, source: 'leaf-maker', state: 'settled', settledAt: Date.now() - 500,
    ticket: { payAsset: X, receiveAsset: 'BTC', amountIn: '1', amountOut: '1', fees: [] }, before: history }))
  s.store.setItem('swk.usertrade.default', JSON.stringify(fat))
  assert.ok(s.store.getItem('swk.usertrade.default').length > 800_000, 'as the testnet trader\'s store: ' + s.store.getItem('swk.usertrade.default').length)
  const eng = engineOf(s)
  const { ui, root } = composerOf(eng)
  await root.querySelector('#ucReview').onclick()
  await root.querySelector('#ucConfirm').onclick()
  closeCards()
  const recs = eng.records()
  assert.equal(recs.length, 9, 'no earlier trade dropped for room')
  assert.ok(recs.filter((r) => r.state === 'settled').every((r) => !r.before), 'ended records keep no coin list')
  assert.ok(s.store.getItem('swk.usertrade.default').length < 20_000, 'lean: ' + s.store.getItem('swk.usertrade.default').length)
  assert.ok(await follow(ui, () => eng.records().every((r) => r.state === 'settled')))
  clearTimeout(ui.state.timer)
})
