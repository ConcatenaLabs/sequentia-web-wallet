// The composer (user-composer.js) on a small stand-in document, for a pair with a restricted
// asset: a quote answered with a card (the approval card, or the asset to go through) shows the
// card and never settles anything; a quote answered settle-first for the asset that pays for a
// restricted asset settles it, then prices the trade again by itself. And a pair offered a moment
// ago that nobody offers now is asked again for as long as the engine says so, then said plainly.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { mountUserComposer, READY_TRIES } from './user-composer.js'
import { USER_WORDS, OFFERED_AGAIN_EVERY_MS } from './user-trade.js'

const X = 'aa'.repeat(32) // what pays
const R = 'bb'.repeat(32) // the restricted asset

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

// A scripted engine: each quote takes the next answer; settle is recorded.
function scripted (answers) {
  const seen = { quotes: [], settles: [] }
  const engine = {
    quote: async (a) => { seen.quotes.push(a); return answers.shift() || { ok: false, why: 'not-offered' } },
    estimate: async () => ({ ok: false, why: 'restricted' }), offered: async () => [R], records: () => [], resume: async () => [],
    settle: async (a) => { seen.settles.push(a); return true }, drop: () => {}, confirm: async () => { throw new Error('not here') },
    advance: async (r) => r, soon: () => false, spendable: async () => new Map(),
  }
  return { engine, seen }
}
function mount (engine) {
  const doc = fakeDoc(); const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine, held: (a) => (a === X ? 3000000n : 0n), knownAssets: () => [X, R], assetMeta: (h) => ({ ticker: h === X ? 'USDX' : 'RSB', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [R], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => [], openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50,
  })
  Object.assign(ui.state, { pay: X, get: R, amount: '400000', payChosen: true, getChosen: true })
  ui.render()
  return { ui, root }
}

test('composer: a quote answered with a card shows the card and never settles anything', async () => {
  const card = { text: 'Only approved holders can hold RSB.', code: 'AID', choices: [] }
  // The approval card, and an answer carrying a card whatever its reason: the card is what is shown.
  for (const answer of [{ ok: false, why: 'approval', card }, { ok: false, why: 'settle-first', payAsset: X, coins: [], card }]) {
    const { engine, seen } = scripted([answer])
    const { ui, root } = mount(engine)
    await root.querySelector('#ucReview').onclick()
    await wait(20)
    assert.equal(ui.state.answer, card, 'the card is shown')
    assert.deepEqual(seen.settles, [], 'nothing is settled for a card')
    assert.equal(seen.quotes.length, 1, 'priced once')
    assert.ok(root.querySelector('#ucCard'), 'the card is painted')
  }
})

test('composer: a restricted trade whose payment waits for a round shows the engine\'s ticket to wait and go; Trade accepts it', async () => {
  // The engine answers what pays waiting for a round with a ticket to accept now (its one
  // wait-and-go path): the price, the least it goes for, and the wait. The composer shows it and
  // hands Trade back to the engine; it settles nothing of its own.
  const finalBy = Date.now() + 150_000
  const ticket = { payAsset: X, receiveAsset: R, amountIn: '800', amountOut: '396', about: '400', fees: [], source: 'settling', asked: '800', indicative: true, finalBy }
  const choice = { source: 'settling', payAsset: X, coins: ['c1'] }
  const { engine, seen } = scripted([{ ok: true, ticket, choice }])
  const confirmed = []
  engine.confirm = async (c, t) => { confirmed.push([c, t]); return { id: 'r1', state: 'settling', ticket: t, finalBy } }
  const { ui, root } = mount(engine)
  await root.querySelector('#ucReview').onclick()
  assert.equal(seen.quotes.length, 1)
  assert.equal(seen.settles.length, 0, 'the composer settles nothing itself')
  assert.equal(ui.state.ticket, ticket)
  assert.equal(root.querySelector('#ucOut').textContent, USER_WORDS.amountOut + USER_WORDS.about + ' 400 RSB')
  assert.equal(root.querySelector('#ucCost').textContent, USER_WORDS.atLeast('396 RSB'))
  assert.equal(root.querySelector('#ucWait').textContent, USER_WORDS.goesThrough(3))
  await root.querySelector('#ucConfirm').onclick()
  assert.deepEqual(confirmed, [[choice, ticket]], 'Trade is the engine\'s confirmation of that ticket')
})

test('composer: a pair offered a moment ago is asked again until the engine stops saying so, then said plainly', async () => {
  // The engine answers `again` for longer than READY_TRIES asks (its own window, OFFERED_AGAIN_MS,
  // bounds it), then plainly that nobody offers it. The words end on that, never on "it takes a
  // moment" with nothing asking any more (RV46's F4 on #711).
  const n = READY_TRIES + 6
  const answers = [...Array.from({ length: n }, () => ({ ok: false, why: 'not-offered', again: true })), { ok: false, why: 'not-offered' }]
  const { engine, seen } = scripted(answers)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { ui, root } = mount(engine)
    await root.querySelector('#ucReview').onclick()
    for (let i = 0; i < 3 * n && seen.quotes.length <= n; i++) {
      mock.timers.tick(OFFERED_AGAIN_EVERY_MS)
      for (let k = 0; k < 20; k++) await Promise.resolve()
    }
    assert.equal(seen.quotes.length, n + 1, 'asked again for as long as the engine said `again`')
    assert.equal(ui.state.error, USER_WORDS.notOffered('RSB', 'USDX'), 'the last words say nobody offers it')
  } finally { mock.timers.reset() }
})
