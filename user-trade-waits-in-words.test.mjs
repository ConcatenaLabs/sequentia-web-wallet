// A trade paid partly from coins that wait for a round and partly from money moved in from the
// chain names the later of the two waits on its ticket and keeps the bound it named (#756); the
// Trade tab never names a balance of 0 the person does not see (#757), asks again by itself when
// no one confirmed a price in time (#755), and offers a returned trade's price now (#758). The
// engine and the composer on a stand-in library whose tree coin is too deep to pay from until a
// round refreshes it, beside money on the chain, at the testnet's wait (at most 900 s, usually 360 s).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngine, USER_WORDS, tradeStateWord, settlingBy, forbiddenIn } from './user-trade.js'
import { mountUserComposer, READY_RETRY_MS } from './user-composer.js'

const X = 'aa'.repeat(31) + '01', Y = 'bb'.repeat(31) + '02'
const realSetTimeout = globalThis.setTimeout
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}
const WAIT = { final_in_seconds: 900, usual_in_seconds: 360, waiting_for: 'round' }
const refused = (m, kind = 'refused') => Object.assign(new Error('refused: ' + m), { kind })
const settleFirst = (coins) => Object.assign(new Error('refused: … settle them first (settle_first) …, usually within 360 s and at most 900 s'),
  { kind: 'settle_first', asset: X, coins }, WAIT)

// The tree holds t1 (`tree` atoms, three reassignments from a round: too deep to pay from); the
// chain holds `onchain`. The board's coin b1 is pending until `credit()`; the round taking t1 goes
// through at `through()`, and the next sync brings t2.
function standIn ({ tree = 200_000n, onchain = 300_000n, rateNum = 4n, rateDen = 3n, stays = null, frozen = 0n } = {}) {
  const s = { coins: [{ leaf_id: 't1', asset: X, value: String(tree), state: 'live', kind: 'transfer', hops: 3 }], accepts: [], brings: 0, swaps: [],
    chain: onchain, t: 1_000_000, open: false, settleAsks: [] }
  const c = (id) => s.coins.find((x) => x.leaf_id === id)
  const liveValue = () => s.coins.filter((x) => x.asset === X && x.state === 'live').reduce((n, x) => n + BigInt(x.value), 0n)
  const waitingValue = () => s.coins.filter((x) => x.asset === X && (x.state === 'pending' || x.state === 'given')).reduce((n, x) => n + BigInt(x.value), 0n)
  const deep = () => c('t1') && c('t1').state === 'live'
  const spendCheck = (give) => {
    const live = liveValue()
    const shallow = live - (deep() ? BigInt(c('t1').value) : 0n)
    if (shallow >= give) return
    // Covered once what waits (the deep coin, the pending board, the round's coin) is through: settle first.
    if (live + waitingValue() >= give) throw settleFirst([...(deep() ? ['t1'] : []), ...s.coins.filter((x) => x.state === 'pending').map((x) => x.leaf_id)])
    throw refused('the wallet holds ' + shallow + ' of asset ' + X + ' in live coins')
  }
  s.lib = {
    command (cmd, a) {
      switch (cmd) {
        case 'coins': return s.coins.map((x) => ({ ...x }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'participations': return []
        case 'swaps': return s.swaps.map((x) => ({ ...x }))
        case 'sync':
          if (s.open && c('t1') && c('t1').state === 'given') { c('t1').state = 'spent'; s.coins.push({ leaf_id: 't2', asset: X, value: String(BigInt(c('t1').value) - 10n), state: 'live', kind: 'leaf', hops: 0 }) }
          return {}
        case 'settle_first': {
          s.settleAsks.push({ at: s.t, a })
          const t1 = c('t1'), b1 = c('b1')
          const settling = []
          if (t1 && t1.state === 'live') { t1.state = 'given'; settling.push('t1') }
          const waiting = [...(t1 && t1.state === 'given' && !settling.length ? ['t1'] : []), ...(b1 && b1.state === 'pending' ? ['b1'] : [])]
          if (settling.length || (t1 && t1.state === 'given')) return { settling, waiting, done: [], left: [], ready: false, ...WAIT }
          if (b1 && b1.state === 'pending') return { settling: [], waiting, done: [], left: [], ready: false }
          return { settling: [], waiting: [], done: [], left: [], ready: true }
        }
        case 'quote': return { coins: a.leaves.map((l) => ({ leaf_id: l, fee: '0' })) }
        case 'swap_read': {
          const give = BigInt(a.offer.split(':')[2])
          spendCheck(give)
          return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: String(give) }, pays: { asset: X, margins: '192' },
            change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } }
        }
        case 'swap_accept': {
          spendCheck(BigInt(a.offer.split(':')[2]))
          s.accepts.push({ at: s.t, offer: a.offer }); s.swaps.push({ swap: 's' + s.accepts.length, role: 'taker', state: 'accepted' })
          return { swap: 's' + s.accepts.length, accept: 'swap-accept:xyz' }
        }
        case 'settle_quote': return { asset: a.asset, value: a.value, fee: '0', after: a.value }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(rateNum), rate_den: String(rateDen), max_give: '5000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    if (url.endsWith('/v1/firm')) {
      const want = (BigInt(b.give) * rateNum + rateDen - 1n) / rateDen
      return { swap: 's1', offer: `swap-offer:${b.give}:${want}`, give: b.give, want: String(want) }
    }
    if (url.endsWith('/v1/accept')) { for (const x of s.swaps) x.state = 'done'; return { state: 'done' } }
    return {}
  }
  s.store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  s.bringIn = async (asset, want) => {
    s.brings++
    if (stays) return { refused: stays }
    if (asset !== X || c('b1') || s.chain <= 0n) return c('b1') ? { already: true } : null
    s.coins.push({ leaf_id: 'b1', asset: X, value: String(s.chain - 39n), state: 'pending', kind: 'board' })
    s.chain = 0n; s.movedAt = s.t
    return { boarded: { fee: '39' } }
  }
  s.movedFees = (asset, since) => (asset === X && s.movedAt != null && s.movedAt >= since ? 39n : 0n)
  s.credit = () => { c('b1').state = 'live' }
  s.through = () => { s.open = true }
  s.held = () => s.chain + s.coins.filter((x) => x.asset === X && x.state !== 'spent').reduce((n, x) => n + BigInt(x.value), 0n)
  s.chainDep = () => ({ atoms: s.chain, movable: stays || frozen >= s.chain ? 0n : s.chain - frozen, margin: 2000n, minutes: 5,
    ...(stays ? { stays } : {}), ...(frozen ? { frozen } : {}) })
  return s
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const engineOf = (s, extra = {}) => createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store,
  sleep: async () => {}, quoteFirmMs: 2000, now: () => s.t, held: s.held, chain: s.chainDep, bringIn: s.bringIn, movedFees: s.movedFees, ...extra })
const recOf = (eng, id) => eng.records().find((x) => x.id === id)
const ENDED = ['settled', 'returned', 'failed', 'undone']
const clean = (w) => { assert.ok(!/try again|could not/i.test(String(w)), String(w)); assert.deepEqual(forbiddenIn(w), [], String(w)) }

function fakeDoc () {
  const byId = new Map()
  function mk (tag) {
    const e = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, _id: '', _text: '', className: '', value: '', disabled: false, type: '', title: '', options: [], selectedIndex: 0,
      get id () { return this._id }, set id (v) { this._id = v; byId.set(v, this) },
      get textContent () { return this._text + this.children.map((c) => c.textContent).join('') }, set textContent (v) { this._text = String(v); this.children = [] },
      set innerHTML (v) { this._text = ''; this.children = [] }, get innerHTML () { return '' },
      get isConnected () { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body },
      appendChild (c) { this.children.push(c); c.parentNode = this; return c },
      append (...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(mk('span'), { textContent: c }) : c) },
      insertBefore (c) { return this.appendChild(c) }, removeChild (c) { this.children = this.children.filter((x) => x !== c) }, remove () { if (this.parentNode) this.parentNode.removeChild(this) },
      replaceChildren (...cs) { this.children = []; this.append(...cs) }, replaceWith (n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children[i] = n; n.parentNode = p },
      setAttribute (k, v) { this.attrs[k] = v; if (k === 'id') this.id = v }, getAttribute (k) { return this.attrs[k] ?? null }, removeAttribute (k) { delete this.attrs[k] },
      addEventListener () {}, removeEventListener () {}, focus () {}, blur () {}, scrollIntoView () {},
      classList: { _s: new Set(), add (...c) { c.forEach((x) => this._s.add(x)) }, remove (...c) { c.forEach((x) => this._s.delete(x)) }, toggle (c, on) { if (on ?? !this._s.has(c)) this._s.add(c); else this._s.delete(c) }, contains (c) { return this._s.has(c) } },
      querySelector (sel) {
        const hit = sel.startsWith('#') ? (n) => n._id === sel.slice(1) : sel.startsWith('.') ? (n) => String(n.className).split(/\s+/).includes(sel.slice(1)) : null
        if (!hit) return null
        const f = (n) => { if (hit(n)) return n; for (const c of n.children) { const r = f(c); if (r) return r } return null }; return f(this)
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


test('a trade paid partly from coins that wait for a round and partly from the chain names the later wait, and keeps the bound it named (#756)', async () => {
  const s = standIn()
  const eng = engineOf(s)
  const t0 = s.t
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, 'a ticket: ' + q.why)
  assert.equal(q.choice.source, 'bring-in')
  // The round's usual 360 s is longer than the move's 5 minutes: the ticket says 6.
  assert.equal(q.ticket.bringIn, 6, 'the later of the two waits: ' + JSON.stringify(q.ticket))
  assert.equal(s.settleAsks.length, 0, 'nothing given to a round before the person accepts')
  const rec = await eng.confirm(q.choice, q.ticket)
  const bound = recOf(eng, rec.id).settleMost
  let r = rec; const words = []
  for (let i = 0; i < 80 && !ENDED.includes(r.state) && r.state !== 'sent'; i++) {
    s.t += 30_000
    if (s.t - t0 >= 60_000 && s.coins.find((x) => x.leaf_id === 'b1')) s.credit()
    if (s.t - t0 >= 360_000) s.through()
    r = await eng.advance(recOf(eng, rec.id))
    const w = tradeStateWord(r, s.t); if (words[words.length - 1] !== w) words.push(w)
  }
  words.forEach(clean)
  assert.equal(words[0], USER_WORDS.bringIn(6), 'the first words say what the ticket said: ' + JSON.stringify(words))
  assert.equal(recOf(eng, rec.id).settleMost, bound, 'the bound fixed when it was confirmed, never grown while it waits')
  assert.ok(['sent', 'settled'].includes(r.state), r.state)
  assert.ok((s.t - t0) / 1000 <= 6 * 60 + 120, 'it went within the time named: ' + (s.t - t0) / 1000)
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut))
})

test('a trade paid from the tree and the chain with nothing waiting for a round keeps the move\'s minutes', async () => {
  const s = standIn()
  s.lib.command = ((inner) => (cmd, a) => {
    if (cmd === 'swap_read') { const give = BigInt(a.offer.split(':')[2]); return { swap: 's1', gets: { asset: Y, value: a.offer.split(':')[1] }, gives: { asset: X, value: String(give) }, pays: { asset: X, margins: '192' }, change: { asset: X, value: '1000' }, hops: 1, dates: { expiry: 1800000000 } } }
    return inner(cmd, a)
  })(s.lib.command.bind(s.lib))
  const q = await engineOf(s).quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok && q.choice.source === 'bring-in', q.why)
  assert.equal(q.ticket.bringIn, 5)
})

function mount (engine, held = 500000n) {
  const doc = fakeDoc(); const root = doc.createElement('div')
  const ui = mountUserComposer({ root, engine, held: () => held, knownAssets: () => [X, Y], assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }),
    fmtAtoms: (a) => String(a), parseAtoms: (t) => BigInt(t), admittedReceives: () => [Y], market: null, refValue: () => null,
    session: null, notify: () => {}, links: () => ({}), openHistory: () => {}, followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50 })
  Object.assign(ui.state, { pay: X, get: Y, amount: '400000', payChosen: true, getChosen: true })
  ui.render()
  return { doc, root, ui }
}
const find = (n, f) => { if (f(n)) return n; for (const c of n.children || []) { const r = find(c, f); if (r) return r } return null }

test('more than the balance is said against the balance the person sees, never 0 (#757)', async () => {
  const s = standIn(); const real = engineOf(s)
  const { root, ui } = mount({ ...real, quote: async () => ({ ok: false, why: 'part-ready', soon: true }) }, 200900n)
  await root.querySelector('#ucReview').onclick()
  assert.equal(ui.state.error, USER_WORDS.moreThanHeld('200900 XT'))
  clearTimeout(ui.state.timer)
})

test('no one confirming a price in time, or the wallet busy: the Trade tab asks again by itself, as its words say (#755)', async () => {
  for (const why of ['no-firm-offer', 'wallet-busy']) {
    const s = standIn(); const real = engineOf(s); let asked = 0
    const timers = []
    const orig = globalThis.setTimeout
    globalThis.setTimeout = (f, ms, ...a) => { if (ms === READY_RETRY_MS) { timers.push(f); return 0 } return orig(f, ms, ...a) }
    try {
      const { root, ui } = mount({ ...real, quote: async () => { asked++; return { ok: false, why } } })
      await root.querySelector('#ucReview').onclick()
      assert.equal(ui.state.error, why === 'no-firm-offer' ? USER_WORDS.noFirmOffer : USER_WORDS.walletBusy)
      assert.ok(/by itself/.test(ui.state.error) && !/try again/i.test(ui.state.error), ui.state.error)
      assert.equal(timers.length, 1, why + ': the price is asked again by itself')
      await timers[0](); await new Promise((r) => realSetTimeout(r, 10))
      assert.equal(asked, 2, why + ': asked again')
      clearTimeout(ui.state.timer)
    } finally { globalThis.setTimeout = orig }
  }
})

test('a trade that came back because the price moved shows the price now, and takes it from its card (#758)', async () => {
  const s = standIn(); const real = engineOf(s); const quotes = []
  const rec = { id: 'r1', at: s.t, state: 'returned', whyKind: 'moved', returnedAt: Date.now() + 1000, source: 'leaf-maker',
    ticket: { payAsset: X, receiveAsset: Y, amountIn: '400000', amountOut: '297000', fees: [] },
    newTicket: { payAsset: X, receiveAsset: Y, amountIn: '400000', amountOut: '239883', fees: [] } }
  const { doc, root, ui } = mount({ ...real, records: () => [rec], quote: async (a) => { quotes.push(a); return { ok: false, why: 'not-offered' } } })
  ui.render()
  const row = find(root, (n) => n.dataset && n.dataset.trade === 'r1')
  assert.ok(row, 'the returned trade is listed')
  row.onclick()
  const price = doc.body.querySelector('#ucNewPrice')
  assert.ok(price, 'the price now is shown on its card')
  assert.match(price.textContent, /400000 XT → 239883 YT/)
  doc.body.querySelector('#ucTakeNewPrice').onclick()
  await new Promise((r) => realSetTimeout(r, 10))
  assert.equal(quotes.length, 1, 'firm terms asked for it, as Review does')
  assert.deepEqual([quotes[0].payAsset, quotes[0].receiveAsset, quotes[0].amount], [X, Y, '400000'])
  for (const w of [USER_WORDS.priceNow, USER_WORDS.takeNewPrice]) assert.deepEqual(forbiddenIn(w), [], w)
  clearTimeout(ui.state.timer)
})
