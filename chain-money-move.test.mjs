// Money held on the chain moved in because a person's payment or trade needs it (leaves.js bringIn),
// and the reviews that pay with it (index.html treeSendReview, codeWay), on the real leaf wallet
// module over a stand-in library that holds coins of X on the chain:
//   - each asker is answered on its own terms (`want`, `until`, `since`, `stop`), one board at a time;
//   - it never boards within a minute of the page's own on-chain payment (`onchainQuiet`);
//   - a board the library refuses is answered at once, never asked again for minutes;
//   - while it waits, the wallet's reads are not held as a person's ask, and it ends when the asker
//     no longer waits;
//   - a send moved in first shows the most its fees can be and the total, pays only within them, and
//     shows the payment again with its fee when it would cost more;
//   - the whole balance typed to a receive code is refused naming what Max fills in, never "up to 0".
//
//   node --test chain-money-move.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import { DEFAULT_WORDS, sendableNow, codeRoute, codeMost, boardMinutes } from './default-arca.js'

const X = '75'.repeat(32)
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }

for (const k of ['setInterval']) {
  const orig = globalThis[k]
  globalThis[k] = (f, ms, ...a) => { const t = orig(f, ms, ...a); if (t && t.unref) t.unref(); return t }
}

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function fakeWorker (answer) {
  const w = { posted: [] }
  w.postMessage = (m) => { w.posted.push(m); queueMicrotask(() => w.onmessage({ data: answer(m) })) }
  return w
}

// The stand-in library: `chain` atoms of X on the chain the library reads (in a block); a board takes
// all of it less a fee of 39 into a pending coin. `refuse`: board_quote refuses with that message.
function library () {
  const L = { chain: 0n, pending: 0n, live: 0n, calls: [], refuse: null, sendFee: 10n, boards: 0 }
  const answer = (cmd, a) => {
    switch (cmd) {
      case 'balance': return { arca: { [X]: { live: String(L.live), pending: String(L.pending) } }, sequentia_onchain: L.chain > 0n ? { [X]: String(L.chain) } : {} }
      case 'info': return { server_info: { assets: [{ asset: X, min_leaf: '1000' }], fills: { round_interval_seconds: 60, block_seconds: 60 } } }
      case 'coin_places': return { coins: [] }
      case 'coins': return []
      case 'schedule': return { now: 1, due: false, next_sync_at: null }
      case 'care': return { claims: [], planned: [], cancelled: [] }
      case 'board_quote':
        if (L.refuse) { const e = new Error(L.refuse); e.kind = 'refused'; throw e }
        return { fee: { asset: X, amount: '39' } }
      case 'board': {
        const v = BigInt(a.amount)
        if (v + 39n > L.chain) { const e = new Error('refused: not that much on the chain'); e.kind = 'refused'; throw e }
        L.chain -= v + 39n; L.pending += v; L.boards++
        return { board: 'b' + L.boards, txid: 'ab'.repeat(32), value: String(v) }
      }
      case 'settle_first': if (L.pending > 0n) { L.live += L.pending; L.pending = 0n } return { settling: [], waiting: [], done: [], left: [], ready: true }
      case 'send_quote': return { fee: String(L.sendFee) }
      case 'send': L.live -= BigInt(a.amount) + L.sendFee; return { transfer: 't1' }
      case 'sync': return {}
      default: return []
    }
  }
  L.worker = fakeWorker((m) => {
    if (m.op === 'exists') return { id: m.id, ok: true, value: true }
    if (m.op === 'open') return { id: m.id, ok: true, value: {} }
    const c = m.args.command
    L.calls.push(c)
    try { return { id: m.id, ok: true, value: { result: answer(c, m.args.args), start: {} } } } catch (e) { return { id: m.id, ok: false, error: { message: e.message, kind: e.kind } } }
  })
  return L
}

async function mount (t, extra = {}) {
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const C = { t: 1_000_000 }
  const lib = library()
  const api = mountLeaves({ makeWorker: () => lib.worker, store, walletTag: () => 't', mnemonic: () => 'abandon', el: () => ({}), now: () => C.t,
    sleep: async (ms) => { C.t += ms; await new Promise((r) => setImmediate(r)) }, tickMs: 3_600_000, ...extra }, null, null)
  await api.start()
  t.after(() => api.stop())
  return { api, lib, C }
}
const boarded = (lib) => lib.calls.filter((c) => c === 'board').length

test('N1: never moved in within a minute of the page\'s own payment on the chain; then at once', async (t) => {
  let quiet = true
  const { api, lib, C } = await mount(t, { onchainQuiet: () => quiet })
  lib.chain = 3_000_000n
  const p = api.bringIn(X, { want: 1_000_000n, until: C.t + 300_000 })
  for (let i = 0; i < 20 && C.t < 1_000_000 + 50_000; i++) await new Promise((r) => setImmediate(r))
  assert.equal(boarded(lib), 0, 'nothing boarded while the page\'s own payment may still spend the coins')
  quiet = false
  const v = await p
  assert.ok(v && v.boarded, JSON.stringify(v))
  assert.equal(boarded(lib), 1)
  assert.equal(v.boarded.fee, '39', 'the move\'s fee is in its answer')
  assert.equal(api.movedFees(X, 0), 39n)
})

test('N2: a board the library refuses is answered at once, never asked again for minutes', async (t) => {
  const { api, lib, C } = await mount(t)
  lib.chain = 3_000_000n; lib.refuse = 'refused: the operator does not serve this asset now'
  const t0 = C.t
  const v = await api.bringIn(X, { want: 1_000_000n, until: C.t + 300_000 })
  assert.deepEqual(Object.keys(v || {}), ['refused'], JSON.stringify(v))
  assert.ok(C.t - t0 < 10_000, `answered after ${C.t - t0} ms, not after the whole wait`)
  assert.equal(lib.calls.filter((c) => c === 'board_quote').length, 1, 'asked once')
})

test('N2: the wait it keeps is the wait asked (the words\' minutes), and nothing there ends it with null', async (t) => {
  const { api, C } = await mount(t)
  const t0 = C.t
  const v = await api.bringIn(X, { want: 1_000_000n, until: C.t + boardMinutes(0) * 60_000 })
  assert.equal(v, null)
  assert.ok(C.t - t0 >= boardMinutes(0) * 60_000 && C.t - t0 <= boardMinutes(0) * 60_000 + 10_000, `waited ${C.t - t0} ms`)
})

test('B2: while it waits it does not hold the wallet as a person\'s ask, and it ends once the asker no longer waits', async (t) => {
  const { api, lib, C } = await mount(t)
  let stop = false
  const t0 = C.t
  const p = api.bringIn(X, { want: 1_000_000n, until: C.t + 600_000, stop: () => stop })
  let busySeen = 0
  for (let i = 0; i < 30; i++) { await new Promise((r) => setImmediate(r)); if (api.personBusy()) busySeen++ }
  assert.equal(busySeen, 0, 'the mailbox and the upkeep\'s reads are not held back by the wait')
  assert.equal(api.bringing(), true)
  stop = true
  assert.equal(await p, null)
  assert.ok(C.t - t0 < 600_000, 'ended when told, not at the end of the wait')
  assert.equal(api.bringing(), false)
  assert.equal(boarded(lib), 0)
})

test('B2: with nothing left on the chain and a move made since the ask, it ends at once: { already }', async (t) => {
  const { api, lib, C } = await mount(t)
  lib.chain = 3_000_000n
  const since = C.t
  assert.ok((await api.bringIn(X, { want: 400_000n, since, until: C.t + 300_000 })).boarded)
  const t1 = C.t
  const again = await api.bringIn(X, { want: 400_000n, since, until: C.t + 300_000 })
  assert.deepEqual(again, { already: true })
  assert.ok(C.t - t1 < 10_000, 'answered at once')
  assert.equal(boarded(lib), 1)
})

test('N4: a second asker is answered on its own terms: its own want, not the first one\'s move', async (t) => {
  const { api, lib, C } = await mount(t)
  lib.chain = 1_000_000n
  const since = C.t
  const a = api.bringIn(X, { want: 500_000n, since, until: C.t + 300_000 })
  const b = api.bringIn(X, { want: 2_500_000n, since, until: C.t + 300_000 })
  const va = await a
  assert.ok(va && va.boarded, JSON.stringify(va))
  // The first move took 1,000,000 off the chain; the second asker needs 2,500,000: it waits for more.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.equal(boarded(lib), 1)
  lib.chain = 1_600_000n   // a second payment reaches the chain (in a block)
  const vb = await b
  assert.ok(vb && vb.boarded, 'moved in once the rest of what it needs is there: ' + JSON.stringify(vb))
  assert.equal(boarded(lib), 2)
})

// ---- the page's reviews ----
function node (tag, cls, text) {
  const n = { tag, className: cls || '', children: [], style: {}, textContent: text == null ? '' : String(text), disabled: false, onclick: null,
    classList: { add () {}, remove () {}, toggle () {} } }
  n.appendChild = (c) => { n.children.push(c); return c }
  n.insertBefore = (c) => { n.children.push(c); return c }
  n.querySelector = (sel) => { const all = []; const walk = (x) => { all.push(x); x.children.forEach(walk) }; walk(n)
    const want = sel.split(' ').pop(); const [tg, cl] = want.split('.')
    return all.slice(1).find((x) => (!tg || x.tag === tg) && (!cl || String(x.className).split(' ').includes(cl))) || null }
  n.remove = () => { n.removed = true }
  Object.defineProperty(n, 'innerHTML', { set (v) { n.children = []; n.textContent = String(v).replace(/<[^>]*>/g, '') }, get () { return n.textContent } })
  return n
}
const textOf = (n) => [n.textContent, ...n.children.map(textOf)].filter(Boolean).join('\n')

function page (leavesApi, at) {
  const modals = []
  const deps = {
    leavesApi, DEFAULT_WORDS, sendableNow, codeRoute, codeMost,
    devMode: () => false, isOampAsset: () => false,
    assetMeta: () => ({ ticker: 'XT', precision: 8 }),
    parseAtoms: (s, p) => BigInt(Math.round(Number(s) * 10 ** p)),
    fmtAtoms: (a, p) => (Number(a) / 10 ** p).toFixed(p).replace(/\.?0+$/, ''),
    frozenSentence: (a, t) => `${a} ${t} is frozen by its issuer: it can't be sent until the issuer lifts the freeze.`, esc: (s) => String(s), feeValueStr: () => '', prettyErr: (e) => String(e?.message ?? e), roundMinutes: () => 1, causeWhen: () => 'about a minute', statedSeconds: () => 60,
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
    noteSent: () => {}, walletTag: () => 't', localStorage: memStore(), renderBalance: () => {},
    performance: { now: () => Date.now() }, waitFor: () => 'about a minute',
    onItsWay: () => 0n, settlesFirst: () => false, shortWords: (e) => String(e?.message ?? e), afterClose: () => ({}),
    chainHeld: () => at.chain, chainSpendable: () => at.chain, chainMovable: () => at.movable, feeMarginAtoms: () => at.margin, bringMargin: () => at.bound,
    bringWant: (h, atoms) => atoms + at.bound, bringMinutes: () => 5,
  }
  const names = ['codeWay', 'treeSendReview']
  const src = names.map(fn).join('\n') + '\nreturn { ' + names.join(', ') + ' };'
  const f = new Function(...Object.keys(deps), src)(...Object.values(deps))
  return { ...f, modals }
}

test('B1: a send moved in first shows the most its fees can be and the total, then pays within them', async (t) => {
  const { api, lib } = await mount(t)
  lib.chain = 3_000_000n
  const p = page(api, { chain: 3_000_000n, movable: 3_000_000n, margin: 2_000n, bound: 16_000n })
  const d = p.codeWay('request', X, 1_000_000n, null)
  assert.deepEqual(d, { dest: 'request', byAddress: false, bringIn: true })
  await p.treeSendReview({ asset: X, amtS: '0.01', addr: 'request', bringIn: true }, () => {})
  const { ok, st, m } = p.modals[0]
  const text = textOf(m)
  console.log('review:', text.replace(/\n/g, ' | '))
  assert.ok(text.includes(DEFAULT_WORDS.feeAtMost('0.00016', 'XT', '')), 'the fee is a figure: the most it can be')
  assert.ok(text.includes(DEFAULT_WORDS.totalLabel) && text.includes(DEFAULT_WORDS.feeAtMost('0.01016', 'XT', '')), 'and the total')
  assert.ok(!text.includes(DEFAULT_WORDS.feeKeptSome), 'never "A small part of what you send" for a move')
  assert.ok(text.includes(DEFAULT_WORDS.bringIn(5)))
  await ok.onclick()
  console.log('status:', st.textContent, '| library:', lib.calls.filter((c) => /board|send|settle/.test(c)).join(','))
  assert.equal(st.className, 'status ok', st.textContent)
  assert.ok(lib.calls.includes('send'))
  // What left the wallet: the amount, the move's 39 and the payment's 10, within the 16,000 shown.
  assert.equal(3_000_000n - lib.chain - lib.live - lib.pending, 1_000_000n + 39n + 10n)
})

test('B1: a send whose fee once moved in is more than the review showed is not sent; it is shown again with its fee', async (t) => {
  const { api, lib } = await mount(t)
  lib.chain = 3_000_000n; lib.sendFee = 20_000n
  const p = page(api, { chain: 3_000_000n, movable: 3_000_000n, margin: 2_000n, bound: 16_000n })
  await p.treeSendReview({ asset: X, amtS: '0.01', addr: 'request', bringIn: true }, () => {})
  await p.modals[0].ok.onclick()
  assert.ok(!lib.calls.includes('send'), 'nothing is sent over the fee shown')
  assert.equal(p.modals.length, 2, 'the payment is shown again')
  const again = textOf(p.modals[1].m)
  console.log('shown again:', again.replace(/\n/g, ' | '))
  assert.ok(again.includes(DEFAULT_WORDS.feeMoved))
  assert.ok(again.includes('0.0002 XT'), 'with the fee as it is now')
  assert.ok(!/try again|something went wrong/i.test(again))
})

test('B3: the whole balance typed to a receive code is refused naming what Max fills in, never "up to 0"', async (t) => {
  const { api } = await mount(t)
  const at = { chain: 3_000_000n, movable: 3_000_000n, margin: 2_000n, bound: 16_000n }
  const p = page(api, at)
  const most = codeMost({ tree: 0n, onItsWay: 0n, ...at, moveMargin: at.bound, address: true })
  assert.equal(most, 2_998_000n)
  for (const amount of [3_000_000n, 2_999_000n]) {
    const d = p.codeWay('request', X, amount, 'tb1qaddress')
    assert.equal(d.most, most, JSON.stringify(d, (k, v) => typeof v === 'bigint' ? String(v) : v))
    await assert.rejects(p.treeSendReview({ asset: X, amtS: String(Number(amount) / 1e8), addr: d.dest, bringIn: !!d.bringIn, most: d.most }, () => {}),
      (e) => { console.log(String(amount), '->', e.message); assert.equal(e.message, DEFAULT_WORDS.sendUpTo('0.02998', 'XT')); return true })
  }
  // At Max's figure it goes, on the chain at the code's address.
  assert.deepEqual(p.codeWay('request', X, most, 'tb1qaddress'), { dest: 'tb1qaddress', byAddress: true })
  // Max fills in the same figure.
  assert.match(fn('fillMax'), /const best=codeMost\(\{ tree, onItsWay: onItsWay\(hex\), chain: onChain, movable: chainMovable\(hex\), margin: feeMarginAtoms\(hex\), moveMargin: bringMargin\(hex\), address: !!\(c && c\.address\) \}\);/)
})
