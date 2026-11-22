// Choosing under You receive an asset nobody offers for what is paid says so at once, before an
// amount is typed ("There is no market for … right now."), from the offers the composer reads
// anyway (engine.offered): no request of its own. While those offers are not known yet (the
// wallet's Bitcoin side still starting: the list is `pending`), nothing is said, and they are
// asked again shortly. A restricted asset is never called marketless (its price comes another way).
//
//   node --test no-market.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mountUserComposer } from './user-composer.js'
import { USER_WORDS } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32), R = 'dd'.repeat(32)
const realSetTimeout = globalThis.setTimeout
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms))
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
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

const TK = { [X]: 'XT', [Y]: 'YT', [R]: 'RT' }
function mount (offers, { restricted = [] } = {}) {
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const asked = []
  const engine = {
    records: () => [], resume: async () => [], soon: () => false, spendable: async () => new Map(), drop () {},
    estimate: async () => ({ ok: false, why: 'not-offered' }),
    offered: async (pay) => { asked.push(pay); return offers() },
    isRestricted: (h) => restricted.includes(h),
  }
  const ui = mountUserComposer({
    root, engine, held: (a) => (a === 'BTC' ? 100000n : 0n), knownAssets: () => ['BTC', X, Y, R], assetMeta: (h) => ({ ticker: TK[h], precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, offersPendingMs: 30,
  })
  Object.assign(ui.state, { pay: 'BTC', get: Y, amount: '', payChosen: true, getChosen: true })
  ui.render()
  return { ui, root, asked }
}
const settle = async (ui, want) => { for (let i = 0; i < 200 && ui.state.note !== want; i++) await wait(5) }

test('an asset nobody offers for what is paid: said as soon as it is chosen, no amount typed', async () => {
  const { ui } = mount(() => [X])
  const want = USER_WORDS.noMarket('YT', 'BTC')
  await settle(ui, want)
  assert.equal(ui.state.note, want)
  assert.equal(want, 'There is no market for YT with BTC right now.')
})

test('an asset offered: nothing said', async () => {
  const { ui } = mount(() => [X, Y])
  await wait(200)
  assert.equal(ui.state.note, '')
})

test('offers not known yet (pending): nothing said, asked again, and said once known', async () => {
  let n = 0
  const { ui, asked } = mount(() => { n++; return n < 3 ? Object.assign([X], { pending: true }) : [X] })
  await wait(15)
  assert.equal(ui.state.note, '', 'nothing said while the offers are not known')
  await settle(ui, USER_WORDS.noMarket('YT', 'BTC'))
  assert.ok(asked.length >= 3, 'asked again while pending: ' + asked.length)
  assert.equal(ui.state.note, USER_WORDS.noMarket('YT', 'BTC'))
})

test('a restricted asset is never called marketless', async () => {
  const { ui } = mount(() => [X], { restricted: [Y] })
  await wait(200)
  assert.equal(ui.state.note, '')
})

test('offers that could not be read: nothing said', async () => {
  const { ui } = mount(() => { throw new Error('down') })
  await wait(200)
  assert.equal(ui.state.note, '')
})
