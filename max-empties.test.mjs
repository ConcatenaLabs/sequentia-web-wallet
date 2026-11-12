// Max empties the coins: the person's figure is all-in. After Max the amount field, the ticket's
// You pay and what leaves the wallet are one number, the fees in it, and nothing stays; where one
// trade cannot take all of it, the amount is what goes and the ticket names what stays.
// The engine and the composer are the real ones; the library is a stand-in that chooses coins and
// refuses as the leaf library does (each coin keeps its value less a checkpoint margin; at most 16
// coins a payment, largest first; change none or at least the operator's smallest leaf; a refusal
// for want of funds carries `most`, `all` and `live`), and the maker prices as the real one does
// (it wants ceil(give x rate_num / rate_den)).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, USER_WORDS } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)
const M = 192n, LEAF = 1000n

function standIn ({ values, hops = 1, settleFee = '3', rate = [4n, 3n], figures = true }) {
  const coins = values.map((v, i) => ({ leaf_id: 'c' + i, asset: X, value: String(v), state: 'live', kind: 'board' }))
  const live = values.reduce((n, v) => n + BigInt(v), 0n)
  const order = values.map(BigInt).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 16)
  const keptOf = (k) => order.slice(0, k).reduce((n, v) => n + v - M, 0n)
  const allK = keptOf(order.length)
  const refuse = (message, extra = {}) => {
    const e = new Error(message)
    Object.assign(e, { kind: 'refused', asset: X }, figures ? { most: String(allK - LEAF), all: String(allK), ...extra } : {})
    throw e
  }
  const reads = []
  const lib = {
    command (cmd, a) {
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_read': {
          const [, give, want] = a.offer.split(':').map((v, i) => (i ? BigInt(v) : v))
          reads.push(want)
          for (let k = 1; k <= order.length; k++) {
            const ch = keptOf(k) - want
            if (ch < 0n || (ch > 0n && ch < LEAF)) continue
            return { swap: 's-' + give, gets: { asset: Y, value: String(give) }, gives: { asset: X, value: String(want) }, pays: { asset: X, margins: String(BigInt(k) * M) },
              change: ch > 0n ? { asset: X, value: String(ch) } : null, dates: { expiry: 1800000000 }, hops }
          }
          if (want > allK) refuse(`refused: the wallet holds ${live} of asset ${X} in live coins, and paying ${want} takes ${want + BigInt(order.length) * M} with the margins its transactions leave for their fees`, { live: String(live) })
          refuse(`refused: the change would be below the operator's smallest leaf in asset ${X} (${LEAF} atoms): pay a little less, or that much more`)
        }
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: settleFee, after: String(BigInt(a.value) - BigInt(settleFee)) }
        case 'swap_cancel': return { cancelled: true }
        case 'swaps': return []
        case 'sync': return {}
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const [num, den] = rate
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(num), rate_den: String(den), max_give: '50000000', min_give: '1000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    if (url.endsWith('/v1/firm')) { const want = (BigInt(b.give) * num + den - 1n) / den; return { swap: 's-' + b.give, offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) } }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, live, allK, reads, n: order.length }
}
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s) => { let t = 0; return createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => (t += 1000), held: () => s.live }) }
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? String(v) : v))
const feesIn = (k, a) => k.fees.filter((f) => f.asset === a).reduce((n, f) => n + BigInt(f.atoms), 0n)

// The engine alone, asked for the whole balance.
for (const [label, opts] of [
  ['one coin, the fees in the asset paid', { values: [1000000] }],
  ['one coin, a fee in the other asset too (the coin received is settled)', { values: [1000000], hops: null }],
  ['three coins', { values: [500000, 300000, 200000] }],
  ['three coins at 3:1, where the maker\'s want moves by 3', { values: [500000, 300002, 200000], rate: [3n, 1n] }],
]) {
  test(`the whole balance asked: the trade empties the coins (${label})`, async () => {
    const s = standIn(opts)
    const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: String(s.live) })
    assert.ok(q.ok, J(q))
    const t = q.choice.terms
    assert.equal(t.change, null, 'change stays: ' + J(t))
    assert.equal(t.gives.value, String(s.allK))
    assert.equal(q.ticket.amountIn, String(s.live), 'You pay is not the whole balance')
    assert.equal(feesIn(q.ticket, X), BigInt(s.n) * M, 'the margins are the fees in the asset paid')
    if (opts.hops === null) assert.equal(feesIn(q.ticket, Y), 3n)
  })
}

test('no give of the maker pays exactly what the coins keep: the trade goes, leaving at least the smallest leaf', async () => {
  // 999,808 kept, at 3:1 the maker wants a multiple of 3: no give pays it exactly.
  const s = standIn({ values: [1000000], rate: [3n, 1n] })
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: String(s.live) })
  assert.ok(q.ok, J(q))
  const ch = BigInt(q.choice.terms.change.value)
  assert.ok(ch >= LEAF, 'change ' + ch)
  assert.equal(BigInt(q.ticket.amountIn) + ch, s.live, 'You pay and what stays are the balance')
})

test('an amount less than the coins keep is not made larger', async () => {
  const s = standIn({ values: [1000000] })
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: '500000' })
  assert.ok(q.ok, J(q))
  assert.ok(BigInt(q.ticket.amountIn) <= 500000n, q.ticket.amountIn)
  assert.ok(BigInt(q.choice.terms.change.value) >= 499000n)
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


const fmtA = (a, p) => { a = BigInt(a); if (!p) return String(a); const s = a.toString().padStart(p + 1, '0'); return s.slice(0, -p) + '.' + s.slice(-p) }
const parseA = (t, p) => { const [w, f = ''] = String(t).split('.'); return BigInt(w + (f + '0'.repeat(p)).slice(0, p)) }

async function max (s, precision, engine) {
  const eng = engine || engineOf(s)
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine: eng, held: (a) => (a === X ? s.live : 0n), knownAssets: () => ['BTC', X, Y],
    assetMeta: (h) => ({ ticker: h === X ? 'XT' : h === Y ? 'YT' : 'BTC', precision }),
    fmtAtoms: fmtA, parseAtoms: parseA, admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50,
  })
  ui.render(); Object.assign(ui.state, { pay: X, get: Y, getChosen: true }); ui.render()
  root.querySelector('#ucMax').onclick()
  await root.querySelector('#ucReview').onclick()
  clearTimeout(ui.state.timer); clearTimeout(ui.state.estTimer); clearInterval(ui.state.refresh)
  const k = ui.state.ticket
  assert.ok(k, ui.state.error)
  const stays = root.querySelector('#ucStays')
  return { k, field: root.querySelector('#ucAmount').value, youPay: root.querySelector('#ucIn').textContent, stays: stays && stays.textContent, change: ui.state.choice.terms.change }
}

for (const precision of [8, 2]) {
  test(`Max: the field, You pay and what leaves are the balance, nothing stays (precision ${precision})`, async () => {
    for (const values of [[1000000], [500000, 300000, 200000]]) {
      const s = standIn({ values })
      const r = await max(s, precision)
      assert.equal(r.field, fmtA(s.live, precision))
      assert.equal(r.k.amountIn, String(s.live))
      assert.ok(r.youPay.includes(fmtA(s.live, precision)), r.youPay)
      assert.equal(r.change, null)
      assert.equal(r.stays, null)
    }
  })

  test(`Max over 17 coins: one trade takes 16, the field is what it pays, the 17th is named as staying (precision ${precision})`, async () => {
    const values = Array.from({ length: 17 }, (_, i) => 100000 + i * 1000)
    const s = standIn({ values })
    const r = await max(s, precision)
    const paid = s.allK + 16n * M
    assert.equal(r.k.amountIn, String(paid))
    assert.equal(r.field, fmtA(paid, precision))
    assert.equal(r.change, null)
    assert.equal(r.stays, USER_WORDS.stays(fmtA(100000n, precision) + ' XT'))
  })

  test(`Max where no offer pays exactly the rest: the field is what goes, and what stays is named (precision ${precision})`, async () => {
    const s = standIn({ values: [1000000], rate: [3n, 1n] })
    const r = await max(s, precision)
    const left = s.live - BigInt(r.k.amountIn)
    assert.ok(left >= LEAF)
    assert.equal(r.field, fmtA(BigInt(r.k.amountIn), precision))
    assert.equal(r.stays, USER_WORDS.stays(fmtA(left, precision) + ' XT'))
  })

  test(`Max with a library that gives no figures: the terms it reads show the coins whole, and the trade empties them (precision ${precision})`, async () => {
    const s = standIn({ values: [1000000], figures: false })
    const r = await max(s, precision)
    assert.equal(r.k.amountIn, String(s.live))
    assert.equal(r.field, fmtA(s.live, precision))
    assert.equal(r.change, null)
    assert.equal(r.stays, null)
  })
}
