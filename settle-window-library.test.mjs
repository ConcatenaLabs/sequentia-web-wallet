// Settle first at the testnet's pace, against the real leaf wallet library (leaves/pkg, run in Node
// by tooling/leaf-node.mjs) and a real operator (the operator repository's harness,
// bark-cli/tests/arca_operator_for_browsers.rs). On the testnet the operator broadcasts a round
// about once a minute and the round's block comes up to a minute later; a coin that came out of a
// settling round can be spent only once that round is final. The harness builds a round only when
// asked, so this file paces it as the testnet does: a round every SF_ROUND_S seconds (60), its
// block SF_BLOCK_LAG_S seconds after it (45). SF_PACE=at-once makes each round final in the call
// that builds it instead (the harness's `/round`), as earlier proofs ran.
//
// Two cases, each money still arriving (a payment past the wallet's instant limit):
//   1. a trade asked at once, through the composer and the engine (user-composer.js,
//      user-trade.js), from a maker that is a second real wallet;
//   2. a send to an address, through index.html's own offboardReview on leaves.js.
// Each must end in the trade or the send made, never "try again" or "Something went wrong".
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test settle-window-library.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import { settleWords } from './default-arca.js'
import { stageWriter, dropPending } from './pending-sends.js'
import { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes } from './default-arca.js'
import { createEngine, USER_WORDS } from './user-trade.js'
import { mountUserComposer } from './user-composer.js'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('./leaves/pkg', import.meta.url).pathname
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package in leaves/pkg' : false
const ROUND_S = Number(process.env.SF_ROUND_S || 60)
const BLOCK_LAG_S = Number(process.env.SF_BLOCK_LAG_S || 45)
const AT_ONCE = process.env.SF_PACE === 'at-once'
const pace = AT_ONCE ? 'each round final as it is built' : `a round every ${ROUND_S} s, its block ${BLOCK_LAG_S} s later`

const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms))
// The composer's own timers never keep this file running once its tests are done.
for (const k of ['setTimeout', 'setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

function harness (control) {
  const c = async (path, body) => {
    const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
    return j
  }
  return {
    state: () => c('/state'), fund: (script, asset, amount) => c('/fund', { script, asset, amount: Number(amount) }),
    produce: () => c('/produce'), bury: () => c('/bury'), round: () => c('/round', {}), build: () => c('/build', {}), pass: () => c('/pass', {}), bond: () => c('/bond_post', {}),
    rpc: (method, params = []) => c('/rpc', { method, params }),
  }
}

// The operator's clock, as the testnet runs it (or at once). -> stop()
function clock (H, log) {
  let on = true
  const run = (async () => {
    while (on) {
      if (AT_ONCE) { try { await H.round() } catch {} await sleep(3000); continue }
      const t0 = Date.now()
      let built = []
      try { built = (await H.build()).rounds || [] } catch (e) { log('build: ' + e.message) }
      if (built.length) log(`round(s) built: ${built.map((b) => b.txid.slice(0, 8)).join(', ')}`)
      // The operator's passes, every few seconds: a round held for its participants' forfeits goes
      // out in the first pass after the last of them is in.
      while (on && Date.now() - t0 < BLOCK_LAG_S * 1000) { try { await H.pass() } catch {} await sleep(5000) }
      try { await H.bury() } catch (e) { log('block: ' + e.message) }
      if (built.length) log('a block made and buried')
      while (on && Date.now() - t0 < ROUND_S * 1000) { try { await H.pass() } catch {} await sleep(5000) }
    }
  })()
  return async () => { on = false; await run }
}

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

// A wallet boarded with `amounts` ({asset: atoms}), fees in X.
async function boarded (H, lib, phrase, cfg, X, amounts) {
  const W = lib.create(phrase, cfg)
  for (const [a, v] of Object.entries(amounts)) await H.fund(W.command('address').script_pubkey, a, v + 3_000_000)
  await H.fund(W.command('address').script_pubkey, X, 3_000_000)
  await H.produce()
  W.command('sync')
  for (const [a, v] of Object.entries(amounts)) {
    const q = W.command('board_quote', { asset: a, amount: String(v), fee_asset: X })
    W.command('board', { asset: a, amount: String(v), fee_asset: X, shown: q.fee })
  }
  await H.produce(); await H.bury()
  for (let i = 0; i < 60; i++) {
    W.command('sync')
    if ((W.command('boards') || []).every((b) => b.server && b.server.state === 'credited')) break
    await H.produce(); await sleep(1000)
  }
  return W
}

// A, the payee: joined, its instant limit worth 1,000,000 X, paid 2,000,000 X by S: arriving.
async function arrivingPayee (H, lib, cfg, X, S, phrase) {
  const A = lib.create(phrase, cfg)
  const rate = BigInt((await H.rpc('getfeeexchangerates'))[X] || 100_000_000)
  A.command('instant_limit', { value: String(1_000_000n * rate / 100_000_000n) })
  const req = A.command('receive').request
  S.command('send', { request: req, amount: '2000000', asset: X })
  A.command('mailbox')
  const places = A.command('coin_places')
  assert.ok((places.coins || []).some((c) => c.place === 'arriving' && String(c.value) === '2000000'), 'the payment is arriving: ' + JSON.stringify(places))
  return A
}

async function setup (t, tag) {
  // The page's own timers are unreferenced below: this keeps the test running while it waits.
  const keep = realSetInterval(() => {}, 1000)
  t.after(() => clearInterval(keep))
  const H = harness(CONTROL)
  const st = await H.state()
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  try { await H.bond() } catch (e) { if (!/bond/.test(e.message)) throw e }
  const dir = mkdtempSync(join(tmpdir(), tag + '-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./tooling/leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))
  return { H, st, cfg, lib, X: st.x, Y: st.y }
}

// --- 1. A trade of money still arriving, asked at once -------------------------------------------

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

// A maker in front of wallet C, speaking the maker's HTTP the engine asks (quotes, firm, release,
// accept), each answered by C's library: it gives Y for X at 4 Y for 5 X.
function makerOf (C, X, Y) {
  const asked = []
  const fetchJson = async (url, init) => {
    const b = init && init.body ? JSON.parse(init.body) : {}
    const call = url.split('/v1/')[1]
    asked.push(call)
    if (call === 'quotes') return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '5', rate_den: '4', max_give: '1000000', min_give: '10000' }] }
    if (call === 'firm') {
      const want = (BigInt(b.give) * 5n + 3n) / 4n
      const o = C.command('swap_offer', { give_asset: Y, give: String(b.give), want_asset: X, want: String(want) })
      return { swap: o.swap, offer: o.offer, give: String(b.give), want: String(want) }
    }
    if (call === 'release') { try { C.command('swap_cancel', { swap: b.swap }) } catch {} return {} }
    if (call === 'accept') { C.command('swap_complete', { accept: b.accept }); return { state: 'done' } }
    return {}
  }
  return { fetchJson, asked }
}

test(`a trade of money still arriving, asked at once, waits for its coin and goes (${pace})`, { skip, timeout: 1_200_000 }, async (t) => {
  const { H, cfg, lib, X, Y } = await setup(t, 'sfw-trade')
  const S = await boarded(H, lib, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', cfg, X, { [X]: 4_000_000 })
  const C = await boarded(H, lib, 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', cfg, X, { [Y]: 2_000_000 })
  const A = await arrivingPayee(H, lib, cfg, X, S, 'legal winner thank year wave sausage worth useful legal winner thank yellow')
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
  const t0 = Date.now()
  const lines = []
  const maker = makerOf(C, X, Y)
  const store = memStore()
  const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
  const eng = createEngine({ leaves: { command: (c, a) => A.command(c, a) }, fetchJson: maker.fetchJson, makers: () => ['http://m'], admitted, store,
    held: (a) => (a === X ? 2_000_000n : 0n), log: (...a) => lines.push(a.join(' ')) })
  const doc = fakeDoc()
  const root = doc.createElement('div')
  const ui = mountUserComposer({
    root, engine: eng, held: () => 0n, onItsWay: (a) => (a === X ? 2_000_000n : 0n), knownAssets: () => [X, Y],
    assetMeta: (h) => ({ ticker: h === X ? 'XT' : 'YT', precision: 0 }), fmtAtoms: (a) => String(a), parseAtoms: (s) => BigInt(s),
    admittedReceives: () => [Y], market: null, refValue: () => null, session: null, notify: () => {}, links: () => ({}), openHistory: () => {},
    followMs: 1e9, followSlowMs: 1e9, confirmShownMs: 50,
  })
  Object.assign(ui.state, { pay: X, get: Y, amount: '500000', payChosen: true, getChosen: true })
  ui.render()
  const stop = clock(H, log)
  const said = []
  const watch = setInterval(() => { const s = [ui.state.note, ui.state.error].filter(Boolean).join(' | '); if (s && said[said.length - 1] !== s) { said.push(s); log('the ticket says: ' + s) } }, 200)
  let ticketAt = null, outcome = null, priced = false, error = ''
  try {
    const tReview = Date.now()
    await root.querySelector('#ucReview').onclick()
    for (let i = 0; i < 1800 && !ui.state.ticket && !ui.state.error; i++) await sleep(500)
    ticketAt = (Date.now() - tReview) / 1000
    priced = !!ui.state.ticket; error = ui.state.error
    log(`after Review: ${ui.state.ticket ? 'the ticket' : 'ERR ' + ui.state.error} at ${ticketAt.toFixed(1)} s`)
    if (ui.state.ticket) {
      await root.querySelector('#ucConfirm').onclick()
      for (let i = 0; i < 100 && !eng.records().length; i++) await sleep(100)
      let r = eng.records()[0]
      for (let i = 0; i < 600 && r && !['settled', 'sent', 'returned'].includes(r.state); i++) { await sleep(500); r = await eng.advance(eng.records()[0]) }
      outcome = r && r.state
      log(`the trade: ${outcome} at ${((Date.now() - tReview) / 1000).toFixed(1)} s after Review`)
    }
  } finally { clearInterval(watch); await stop() }
  console.log('engine log (settle and swap lines): ' + lines.filter((l) => /settle|swap_read|swap_accept/.test(l)).slice(-12).join(' | '))
  assert.ok(!said.some((s) => /try again|went wrong/i.test(s)), 'never "try again": ' + JSON.stringify(said))
  assert.ok(priced, `the trade is priced once its coin is through: ${error}`)
  assert.ok(['sent', 'settled'].includes(outcome), 'the trade goes: ' + outcome)
})

// --- 2. A send to an address of money still arriving -----------------------------------------------

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }
function node (tag, cls, text) {
  const n = { tag, className: cls || '', children: [], style: {}, textContent: text == null ? '' : String(text), disabled: false, onclick: null,
    classList: { add () {}, remove () {}, toggle () {} } }
  n.appendChild = (c) => { n.children.push(c); return c }
  n.insertBefore = (c) => { n.children.push(c); return c }
  n.querySelector = (sel) => { const all = []; const walk = (x) => { all.push(x); x.children.forEach(walk) }; walk(n)
    const want = sel.split(' ').pop(); const [tg, cl] = want.split('.')
    return all.slice(1).find((x) => (!tg || x.tag === tg) && (!cl || String(x.className).split(' ').includes(cl))) || null }
  n.remove = () => {}
  Object.defineProperty(n, 'innerHTML', { set (v) { n.children = []; n.textContent = String(v).replace(/<[^>]*>/g, '') }, get () { return n.textContent } })
  return n
}
const textOf = (n) => [n.textContent, ...n.children.map(textOf)].filter(Boolean).join('\n')
function libraryWorker (lib, opened) {
  let wallet = opened
  const w = { asked: [] }
  w.postMessage = ({ id, op, args = {} }) => setImmediate(() => {
    let reply
    try {
      const value = op === 'exists' ? lib.exists(args.mnemonic)
        : op === 'open' ? (wallet = wallet || lib.open(args.mnemonic, args.nodePassword), true)
          : op === 'run' ? (() => {
            try { const v = wallet.run(String(args.command), args.args || {}); w.asked.push(String(args.command)); return v } catch (e) { w.asked.push(args.command + ':' + (e.kind || 'error')); throw e }
          })()
            : (() => { throw new Error('no operation ' + op) })()
      reply = { id, ok: true, value }
    } catch (e) { reply = { id, ok: false, error: { ...e, kind: e.kind || 'error', message: e.message } } }
    w.onmessage({ data: reply })
  })
  return w
}
function page (leavesApi, ticker) {
  const modals = []
  const deps = {
    leavesApi, DEFAULT_WORDS, settleWords, stageWriter, dropPending, sendableNow, offboardOutcome, arrivalMinutes,
    devMode: () => false,
    assetMeta: () => ({ ticker, precision: 8 }),
    parseAtoms: (s, p) => BigInt(Math.round(Number(s) * 10 ** p)),
    fmtAtoms: (a, p) => (Number(a) / 10 ** p).toFixed(p).replace(/\.?0+$/, ''),
    esc: (s) => String(s), feeValueStr: () => '', prettyErr: (e) => String(e?.message ?? e), roundMinutes: () => 1, causeWhen: () => 'about a minute', statedSeconds: () => 60,
    el: node,
    modalRows: (rows) => {
      const m = node('div', 'modal'); const c = m.appendChild(node('div', 'card'))
      c.appendChild(node('label', 'lbl', rows.title))
      for (const [k, v] of rows.kv) { const d = c.appendChild(node('div', 'kv')); d.appendChild(node('span', 'k', k)); d.appendChild(node('span', 'v', v)) }
      const row = c.appendChild(node('div', 'row')); const ok = row.appendChild(node('button', 'primary', 'Confirm & sign')); row.appendChild(node('button', 'ghost', 'Cancel'))
      const st = c.appendChild(node('div', 'status'))
      modals.push({ m, ok, st, rows })
      return { m, ok, st }
    },
    noteSent: () => {}, walletTag: () => 't', localStorage: memStore(), renderBalance: () => {}, renderHistory: () => {},
    followAddressPayments: async () => 'made', markTold: () => {}, offboardNewsText: () => '', OFFBOARD_FOLLOW_MS: 0,
    document: { body: { contains: () => false } }, performance: { now: () => Date.now() },
  }
  const names = ['settleAhead', 'settleLine', 'onItsWay', 'settlesFirst', 'shortWords', 'noneNowWords', 'afterClose', 'waitFor', 'treeSendReview', 'offboardReview']
  const src = names.map(fn).join('\n') + '\nreturn { ' + names.join(', ') + ' };'
  const f = new Function(...Object.keys(deps), src)(...Object.values(deps))
  return { ...f, modals }
}

test(`a send to an address of money still arriving waits for its coin and goes (${pace})`, { skip, timeout: 1_200_000 }, async (t) => {
  const { H, cfg, lib, X } = await setup(t, 'sfw-send')
  const S = await boarded(H, lib, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', cfg, X, { [X]: 4_000_000 })
  const phrase = 'scheme spot photo card baby mountain device kick cradle pact join borrow'
  const A = lib.create(phrase, cfg)
  const t0 = Date.now()
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const worker = libraryWorker(lib, A)
  const api = mountLeaves({ makeWorker: () => worker, store, walletTag: () => 't', mnemonic: () => phrase, el: () => ({}), tickMs: 3_600_000 }, null, null)
  t.after(() => api.stop())
  await api.start()
  // The page's instant limit is set once it runs (as send-arriving-library.test.mjs W5 does), then
  // S pays A past it: the payment is arriving.
  const rate = BigInt((await H.rpc('getfeeexchangerates'))[X] || 100_000_000)
  await api.command('instant_limit', { value: String(1_000_000n * rate / 100_000_000n) })
  S.command('send', { request: A.command('receive').request, amount: '2000000', asset: X })
  A.command('mailbox')
  const placed = A.command('coin_places')
  assert.ok((placed.coins || []).some((c) => c.place === 'arriving' && String(c.value) === '2000000'), 'the payment is arriving: ' + JSON.stringify(placed.coins))
  await api.syncNow()
  const p = page(api, 'X')
  const to = S.command('address').address
  await p.offboardReview({ asset: X, amtS: '0.005', addr: to }, () => {})
  const { ok, st: status, m } = p.modals[0]
  log('review: ' + textOf(m).replace(/\n/g, ' '))
  const stop = clock(H, log)
  const said = []
  const watch = setInterval(() => { const s = status.textContent; if (s && said[said.length - 1] !== s) { said.push(s); log('the status says: ' + s) } }, 200)
  const tSend = Date.now()
  try { await ok.onclick() } finally { clearInterval(watch); await stop() }
  log(`Send to the end of the page's part: ${((Date.now() - tSend) / 1000).toFixed(1)} s; finally: ${status.className} ${status.textContent}`)
  console.log('the library was asked: ' + worker.asked.filter((c) => /^(settle_first|offboard)(:|$)/.test(c)).join(', '))
  assert.ok(!said.some((s) => /try again|went wrong/i.test(s)), 'never "try again": ' + JSON.stringify(said))
  assert.ok(!/err/.test(status.className), status.className + ' ' + status.textContent)
  const offboards = A.command('offboards')
  assert.ok(Array.isArray(offboards) && offboards.some((o) => o.address === to && o.state && o.state !== 'not_made'), 'the offboard is made: ' + JSON.stringify(offboards))
})
