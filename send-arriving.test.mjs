// A payment of money still arriving (received past the instant limit, until its settlement) is never
// refused in default mode: Send to a receive code and Send to an address review it at once and, on
// Send, settle it first (the library's `settle_first`) and then pay, saying "Goes through in about a
// minute" while it waits (D96). Mounted: index.html's own reviews (treeSendReview, offboardReview)
// on the real leaf wallet module (leaves.js mountLeaves), whose stand-in library holds one coin of X,
// placed as arriving.
//
//   node --test send-arriving.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountLeaves, JOINED_KEY, LeafError } from './leaves.js'
import { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, addressRoute } from './default-arca.js'

const X = '75'.repeat(32)
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }

const realSetInterval = globalThis.setInterval
globalThis.setInterval = (f, ms, ...a) => { const t = realSetInterval(f, ms, ...a); if (t && t.unref) t.unref(); return t }

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function fakeWorker (answer) {
  const w = { posted: [] }
  w.postMessage = (m) => { w.posted.push(m); queueMicrotask(() => w.onmessage({ data: answer(m) })) }
  return w
}
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

// The stand-in library: one coin of X, 2,000,000 atoms, placed as arriving (received past the
// instant limit). The payment and the offboard, and the offboard's quote, answer settle_first
// naming it until `settle_first` has put it through a round and a sync has taken the new coin in.
function library () {
  const calls = []
  let settled = false, given = false, synced = 0
  const coin = () => settled ? { leaf_id: 'c2', asset: X, value: '1999990', state: 'live' } : { leaf_id: 'c1', asset: X, value: '2000000', state: given ? 'given' : 'live' }
  const settleFirst = (cmd) => ({ kind: 'settle_first', asset: X, coins: ['c1'],
    message: `refused: the wallet's coins of asset ${X} that pay this now hold 0, short of the 500000 it takes; 2000000 more are arriving … (settle_first) … (${cmd})` })
  const answer = (cmd, args) => {
    switch (cmd) {
      case 'balance': return { arca: { [X]: { live: settled ? '1999990' : '2000000' } } }
      case 'coin_places': return { coins: [{ ...coin(), place: settled ? 'settled' : 'arriving' }] }
      case 'coins': return [coin()]
      case 'schedule': return { now: 1, due: false, next_sync_at: null }
      case 'care': return { claims: [], planned: [], cancelled: [] }
      case 'info': return { server_info: { fills: { round_interval_seconds: 60, block_seconds: 60 } } }
      case 'sync': synced++; if (given && synced >= 2) settled = true; return {}
      case 'settle_first':
        if (settled) return { settling: [], waiting: [], done: ['c1'], left: [], ready: true }
        if (!given) { given = true; synced = 0; return { settling: ['c1'], waiting: [], done: [], left: [], ready: false } }
        return { settling: [], waiting: ['c1'], done: [], left: [], ready: false }
      case 'send_quote': case 'send': case 'offboard_quote': case 'offboard':
        if (!settled) throw settleFirst(cmd)
        if (cmd === 'send') return { transfer: 't1' }
        if (cmd === 'send_quote') return { fee: '10' }
        if (cmd === 'offboard_quote') return { fee: { asset: X, amount: '300' }, gives: ['c2'], change: '1499690' }
        return { offboard: 'p1', state: 'pending', fee: { asset: X, amount: '300' }, gives: ['c2'] }
      default: return []
    }
  }
  const worker = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    calls.push(c)
    try { return { id: m.id, ok: true, value: { result: answer(c, m.args.args), start: {} } } } catch (e) { return { id: m.id, ok: false, error: e } }
  })
  return { worker, calls, settled: () => settled }
}

async function mount (t) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  let clock = 1_000_000
  const lib = library()
  const api = mountLeaves({ makeWorker: () => lib.worker, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => clock,
    sleep: async (ms) => { clock += ms }, tickMs: 3_600_000 }, null, null)
  await api.start()
  t.after(() => api.stop())
  return { api, lib }
}

// The page's own functions, on a stand-in document, with `leavesApi` the mounted module.
function page (leavesApi) {
  const modals = []
  const deps = {
    leavesApi, DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes,
    devMode: () => false,
    assetMeta: () => ({ ticker: 'XT', precision: 8 }),
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
  const names = ['onItsWay', 'settlesFirst', 'shortWords', 'noneNowWords', 'afterClose', 'waitFor', 'treeSendReview', 'offboardReview']
  // A page without onItsWay (before this change) counts nothing on its way.
  const src = names.map((n) => n === 'onItsWay' && !html.includes('function onItsWay(') ? 'function onItsWay(){ return 0n; }' : fn(n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };'
  const f = new Function(...Object.keys(deps), src)(...Object.values(deps))
  return { ...f, modals }
}

test('a payment to a receive code of money still arriving is reviewed, settles first, and is sent', { timeout: 20000 }, async (t) => {
  const { api, lib } = await mount(t)
  const p = page(api)
  assert.equal(api.leafAtoms(X), 0n, 'nothing of it is in the figure yet')
  // Before this change, refused before anything is asked: "You can send up to 0 XT this way now."
  await p.treeSendReview({ asset: X, amtS: '0.005', addr: 'request' }, () => {})
  assert.equal(p.onItsWay(X), 2_000_000n, 'it is on its way')
  const { ok, st, rows, m } = p.modals[0]
  assert.equal(rows.title, DEFAULT_WORDS.sendTitle('0.005', 'XT'))
  assert.ok(textOf(m).includes(DEFAULT_WORDS.settling), textOf(m))
  assert.ok(!/arriving|round|limit|settle/i.test(textOf(m).replace(DEFAULT_WORDS.settling, '')), 'nothing names arriving, rounds or limits: ' + textOf(m))
  await ok.onclick()
  assert.ok(st.textContent.startsWith('Sent 0.005 XT'), st.textContent)
  assert.ok(lib.settled(), 'settled first')
  const i = lib.calls.indexOf('settle_first')
  assert.ok(i > 0 && lib.calls.lastIndexOf('send') > i, 'the payment is made after the settlement: ' + lib.calls.join(','))
})

test('a payment to an address of money still arriving is reviewed, settles first, and is sent', { timeout: 20000 }, async (t) => {
  const { api, lib } = await mount(t)
  const p = page(api)
  // The address route reaches the review: what is on its way counts beside what the tree holds.
  // Before this change it found no way (null), and the payment was refused.
  assert.equal(addressRoute(500_000n, 0n, api.leafAtoms(X), 0n, p.onItsWay(X)), 'arriving')
  await p.offboardReview({ asset: X, amtS: '0.005', addr: 'tex1qaddress' }, () => {})
  const { ok, st, rows, m } = p.modals[0]
  assert.deepEqual(rows.kv, [[DEFAULT_WORDS.feeLabel, DEFAULT_WORDS.feeKeptSome]])
  assert.ok(textOf(m).includes(DEFAULT_WORDS.arrivesWithin(arrivalMinutes(120, 60))), textOf(m))
  assert.equal(lib.calls.filter((c) => c === 'settle_first').length, 0, 'the review settles nothing: only Send does')
  await ok.onclick()
  assert.ok(!/err/.test(st.className), st.className + ' ' + st.textContent)
  assert.ok(lib.settled(), 'settled first')
  const i = lib.calls.indexOf('settle_first')
  assert.ok(i > 0 && lib.calls.lastIndexOf('offboard') > i, 'the offboard is made after the settlement: ' + lib.calls.join(','))
  assert.ok(st.textContent.length > 0 && !/still arriving/i.test(st.textContent), st.textContent)
})

test('every pre-check of Send counts what is on its way', () => {
  // The address route, the vesting check before any route, and a move out of the tree.
  assert.match(html, /comingBack = \(leavesApi\.arriving\(h\)\|\|0n\) \+ onItsWay\(h\) - pendingOut\(/)
  assert.match(html, /refuseIfVesting\(h, a, sendableFor\(h\) \+ onItsWay\(h\)\)/)
  assert.match(fn('ensureOnChain'), /const can = instantAtoms\(m\.hex\) \+ onItsWay\(m\.hex\);/)
  assert.match(fn('ensureOnChain'), /if\(e && e\.kind === 'settle_first'\)\{ quotes\.push\(null\); continue; \}/)
  assert.match(fn('confidentialReview'), /instant:instantAtoms\(h\) \+ onItsWay\(h\)/)
  // Nothing refuses a payment for being still arriving in default mode.
  assert.ok(!/route === 'arriving' && !devMode\(\)\) throw/.test(html))
})

test('while a payment is arriving, Balance shows the asset as Arriving with about how long, never 0 or nothing', { timeout: 20000 }, async (t) => {
  const { api } = await mount(t)
  const p = page(api)
  // Once the library's places are read, `arriving` is 0n and the figure holds none of it: what the
  // row, the asset list, the page's syncs and the page API read is what is on its way.
  assert.equal(api.arriving(X), 0n)
  assert.equal(api.leafAtoms(X), 0n)
  assert.ok(!api.leafAssets().includes(X), 'no figure holds it')
  assert.deepEqual(api.arrivingPayments().map((x) => [x.asset, x.atoms]), [[X, 2_000_000n]])
  assert.equal(p.onItsWay(X), 2_000_000n)
  const rb = fn('renderBalance')
  assert.match(rb, /arrivingIn = \(leavesApi\.arriving\(kind\) \|\| 0n\) \+ onItsWay\(kind\);/)
  assert.match(rb, /for\(const h of onItsWayAssets\(\)\) seqKeys\.add\(h\);/)
  assert.match(rb, /if\(!alwaysShow && totalAtoms <= 0n && arrivingIn <= 0n\) return;/)
  assert.match(rb, /total: \(totalAtoms <= 0n && arrivingIn > 0n\) \? .*DEFAULT_WORDS\.arrivingFigure/)
  assert.match(rb, /DEFAULT_WORDS\.arrivingIn\(amt\(arrivingIn\), ticker\)/)
  assert.match(fn('followArriving'), /arriving \+= \(leavesApi\.arriving\(h\) \|\| 0n\) \+ onItsWay\(h\);/)
  assert.equal(DEFAULT_WORDS.arrivingIn('0.02', 'XT'), '0.02 XT arriving, in about a minute')
  assert.equal(DEFAULT_WORDS.arrivingFigure, 'Arriving')
})
