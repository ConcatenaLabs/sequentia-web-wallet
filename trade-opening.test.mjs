// A trade asked while the wallet is still opening (a restore finding what it holds, web #688) waits
// for it, as a payment does, saying "Your wallet is still opening; this goes on by itself once it
// has.", and is priced once it is open. A wallet whose service does not answer says so, in the words
// a payment uses. Never "This is taking longer than usual … try again".
// The composer (user-composer.js) with index.html's own tradeOpening on a stand-in wallet, and an
// engine that, as the page's does, can price nothing while the wallet is not open.
//
//   node --test trade-opening.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountUserComposer } from './user-composer.js'
import { USER_WORDS } from './user-trade.js'
import { DEFAULT_WORDS } from './default-arca.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)
const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); return i < 0 ? null : html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }

// The page's one wait (walletOpening, which Send's payments use too), over a stand-in of its
// wallet (leaves.js): `w.open` once it has opened, `w.restoring` while it finds what it holds,
// `w.stalled` while that restore gets no answer; its cap OPEN_WAIT_MS shortened to `capMs`.
function pageOpening (w, capMs = 180000) {
  const src = [fn('findingStalled'), fn('findingOn'), fn('walletOpening')]
  if (!src[2]) return null   // a page without the wait
  const leavesApi = { isOpen: () => w.open, expected: () => true, restoring: () => !w.open && w.restoring !== false, restoreStalled: () => (w.stalled ? { since: 0 } : null) }
  return new Function('leavesApi', 'DEFAULT_WORDS', 'setTimeout', 'OPEN_WAIT_MS', src.join('\n') + '\nreturn walletOpening')(leavesApi, DEFAULT_WORDS, realSetTimeout, capMs)
}
// The engine as the page's behaves while the wallet is not open: every command of the library
// refuses ("this wallet holds no leaves"), so a quote finds only what the figure shows and is
// settled first, and settling gets nowhere; once open, it prices.
function engineOver (w) {
  const quotes = []
  return {
    quotes,
    records: () => [], estimate: async () => null, offered: async () => [], resume: async () => [], soon: () => false, spendable: async () => new Map(), drop () {},
    quote: async (q) => { quotes.push(w.open); return w.open ? { ok: true, ticket: { payAsset: X, receiveAsset: Y, amountIn: q.amount, amountOut: '300', fees: [] }, choice: {} } : { ok: false, why: 'settle-first', payAsset: X, coins: [] } },
    settle: async () => w.open,
  }
}
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

function mount (w, opening) {
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const engine = engineOver(w)
  const ui = mountUserComposer({
    root, engine, held: (a) => (a === X ? 3000000n : 0n), knownAssets: () => [X, Y], assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9,
    ...(opening ? { opening } : {}),
  })
  Object.assign(ui.state, { pay: X, get: Y, amount: '400', payChosen: true, getChosen: true })
  ui.render()
  return { ui, root, engine }
}

test('a trade asked while the wallet opens waits for it, saying so, and is priced once it is open', async () => {
  const w = { open: false, stalled: false }
  const { ui, root, engine } = mount(w, pageOpening(w))
  const done = root.querySelector('#ucReview').onclick()
  await wait(1200)
  const said = ui.state.note
  console.log('while the wallet opens, the composer says:', JSON.stringify(said), 'error:', JSON.stringify(ui.state.error))
  w.open = true
  await done
  for (let i = 0; i < 300 && !ui.state.ticket && !ui.state.error; i++) await wait(10)
  console.log('once it is open:', ui.state.ticket ? 'ticket' : 'no ticket', JSON.stringify(ui.state.error))
  assert.notEqual(ui.state.error, USER_WORDS.settleLate, '"This is taking longer than usual … try again" while the wallet was opening')
  assert.equal(said, DEFAULT_WORDS.waitOpening)
  assert.ok(ui.state.ticket, 'priced once open: ' + ui.state.error)
  assert.deepEqual(engine.quotes, [true], 'nothing is priced before the wallet is open')
  clearTimeout(ui.state.timer)
})

test('a wallet whose service does not answer says so, in a payment\'s words, and prices nothing', async () => {
  const w = { open: false, stalled: true }
  const { ui, root, engine } = mount(w, pageOpening(w))
  await root.querySelector('#ucReview').onclick()
  for (let i = 0; i < 300 && !ui.state.error; i++) await wait(10)
  assert.equal(ui.state.error, DEFAULT_WORDS.findingStalledPay)
  assert.ok(!/try again/i.test(ui.state.error))
  assert.deepEqual(engine.quotes, [])
  clearTimeout(ui.state.timer)
})

test('a wallet that neither opens nor finds what it holds: past the wait, the page\'s words, never "try again"', async () => {
  const w = { open: false, restoring: false, stalled: false }
  const { ui, root, engine } = mount(w, pageOpening(w, 1500))
  const t0 = Date.now()
  await root.querySelector('#ucReview').onclick()
  for (let i = 0; i < 300 && !ui.state.error; i++) await wait(10)
  console.log('never opened: after', Date.now() - t0, 'ms:', JSON.stringify(ui.state.error))
  assert.ok(Date.now() - t0 >= 1400, 'it waited its time first')
  assert.equal(ui.state.error, DEFAULT_WORDS.stillOpening)
  assert.ok(!/try again/i.test(ui.state.error), ui.state.error)
  assert.deepEqual(engine.quotes, [])
  clearTimeout(ui.state.timer)
})

test('the page gives the composer the one wait its payments use', () => {
  assert.match(html, /opening: walletOpening,/)
})
