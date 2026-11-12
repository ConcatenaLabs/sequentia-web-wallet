// Money received on the chain is spent at once, whichever way completes soonest, against the real
// leaf wallet library (leaves/pkg, run in Node by tooling/leaf-node.mjs) and a real operator:
// index.html's own payCodeRoute, treeSendReview and offboardReview on leaves.js, which the page
// mounts over the same library.
//
//   - a receive code naming an address, the wallet holding the asset only on the chain: paid at the
//     code's address on the chain, never refused ("You can send up to 0");
//   - a receive request with no address: the money is moved in first (a board, as a person asked),
//     and the payment goes once it is final, the review saying how long;
//   - an amount that needs both what the tree holds and what the chain holds: one payment, the
//     chain's part moved in first;
//   - an address, with the same mixed holdings: one payment out of the tree, the chain's part moved
//     in first.
//
// The page's own reading of the chain (its LWK wallet, which node tests do not load) is stood in for
// by the amount the harness paid to the wallet's address; everything the library decides is the
// library's. It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs)
// running, its control address in SEQ_LEAF_HARNESS, and skips itself otherwise:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test chain-money-library.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, addressRoute, codeRoute, boardMinutes } from './default-arca.js'
import { readPayCode, buildPayCode } from './pay-code.js'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('./leaves/pkg', import.meta.url).pathname
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package in leaves/pkg' : false

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const has = (name) => new RegExp('\\n(async )?function ' + name + '\\(').test(html)
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function harness (control) {
  const c = async (path, body) => {
    const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
    return j
  }
  return { state: () => c('/state'), fund: (script, asset, amount) => c('/fund', { script, asset, amount: Number(amount) }),
    produce: () => c('/produce'), bury: () => c('/bury'), round: () => c('/round', {}), rpc: (method, params = []) => c('/rpc', { method, params }) }
}
function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// The page's worker (leaves/worker.js) over the library in this process: the same messages, the
// same answers, a refusal in the library's own words. `asked` lists every command, and its refusal.
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

// index.html's own functions, on a stand-in document, with `leavesApi` the mounted module and
// `chain` the wallet's coins on the chain as the page reads them (asset -> atoms).
function page (leavesApi, ticker, chain) {
  const modals = []
  const deps = {
    leavesApi, DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, codeRoute, boardMinutes, readPayCode,
    devMode: () => false, isOampAsset: () => false, arkDirectWhy: () => null, arkRoom: () => null,
    availableFor: (h) => chain[h] || 0n, feeMarginAtoms: () => 2000n,
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
  // A page before this change has none of the chain's helpers: they stand in as counting nothing.
  const stub = { codeWay: 'function codeWay(full){ return { dest: full, byAddress: false }; }', chainHeld: 'function chainHeld(h){ return availableFor(h); }',
    chainMovable: 'function chainMovable(){ return 0n; }', bringMargin: 'function bringMargin(){ return 0n; }', bringMinutes: 'function bringMinutes(){ return 5; }', bringWant: 'function bringWant(){ return 0n; }' }
  const names = ['onItsWay', 'settlesFirst', 'shortWords', 'noneNowWords', 'afterClose', 'waitFor', 'treeSendReview', 'offboardReview',
    'chainHeld', 'chainMovable', 'bringMargin', 'bringWant', 'bringMinutes', 'codeWay', 'payCodeRoute']
  // The fee's margin stands in last: an extracted one-line function brings the page's own after it.
  const src = names.map((n) => (!has(n) && stub[n]) ? stub[n] : fn(n)).join('\n') + '\nfunction feeMarginAtoms(){ return 2000n; }\nreturn { ' + names.join(', ') + ' };'
  const f = new Function(...Object.keys(deps), src)(...Object.values(deps))
  return { ...f, modals }
}

// Sends the review's Send, the operator's chain moving meanwhile (a block and its anchor buried every
// few seconds, a round built), and collects every line the status showed.
async function send (H, modal, { rounds = true } = {}) {
  let done = false
  const pump = (async () => { while (!done) { try { await H.produce(); await H.bury(); if (rounds) await H.round() } catch {} await sleep(2500) } })()
  const said = []
  const watch = setInterval(() => { const s = modal.st.textContent; if (s && said[said.length - 1] !== s) said.push(s) }, 200)
  const t0 = Date.now()
  try { await modal.ok.onclick() } finally { done = true; clearInterval(watch); await pump }
  const s = modal.st.textContent; if (s && said[said.length - 1] !== s) said.push(s)
  return { said, ms: Date.now() - t0, status: modal.st }
}

test('money received on the chain is sent at once, on the real library', { skip, timeout: 1_800_000 }, async (t) => {
  const H = harness(CONTROL)
  const st = await H.state()
  const X = st.x
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  const dir = mkdtempSync(join(tmpdir(), 'chain-money-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./tooling/leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))
  // B, the payee: a wallet of the same operator.
  const B = lib.create('letter advice cage absurd amount doctor acoustic avoid letter advice cage above', cfg)
  const bHolds = () => { B.command('sync'); try { B.command('mailbox') } catch {} return BigInt(((B.command('balance').held) || {})[X] || 0) }

  // A wallet as the page holds it: created, joined, mounted over the library; `chain` is what the
  // page reads of its coins on the chain.
  let n = 0
  async function wallet (phrase) {
    const W = lib.create(phrase, cfg)
    const store = memStore()
    store.setItem(JOINED_KEY + '.t' + (++n), '1')
    const worker = libraryWorker(lib, W)
    const tag = 't' + n
    const api = mountLeaves({ makeWorker: () => worker, store, walletTag: () => tag, mnemonic: () => phrase, el: () => ({}), tickMs: 3_600_000 }, null, null)
    t.after(() => api.stop())
    await api.start()
    const chain = {}
    // Paid on the chain by someone else: the page sees it at once (in the mempool).
    const paid = async (atoms) => { await H.fund(W.command('address').script_pubkey, X, atoms); chain[X] = (chain[X] || 0n) + BigInt(atoms) }
    return { W, api, worker, chain, paid, p: page(api, 'X', chain) }
  }

  await t.test('a receive code with an address, the money only on the chain: paid at the address', async () => {
    const A = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const code = buildPayCode({ address: B.command('address').address, sequentia: req })
    const d = A.p.payCodeRoute(code, X, 1_000_000n)
    console.log('code with address, chain only: route', JSON.stringify(d))
    assert.equal(d.byAddress, true, 'paid at the address: ' + JSON.stringify(d))
    assert.equal(d.dest, readPayCode(code).address)
  })

  await t.test('a receive request with no address, the money only on the chain: moved in first, then paid', async () => {
    const A = await wallet('scheme spot photo card baby mountain device kick cradle pact join borrow')
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    const d = A.p.payCodeRoute(req, X, 1_000_000n)
    assert.equal(d.bringIn, true, 'moved in first: ' + JSON.stringify(d))
    await A.p.treeSendReview({ asset: X, amtS: '0.01', addr: d.dest, bringIn: d.bringIn }, () => {})
    const modal = A.p.modals[0]
    const shown = textOf(modal.m)
    console.log('request, chain only: review\n' + shown)
    assert.ok(!/up to 0|still arriving/i.test(shown), shown)
    assert.ok(shown.includes(DEFAULT_WORDS.bringIn(boardMinutes(A.api.anchorDepth()))), 'the review says how long: ' + shown)
    const r = await send(H, modal)
    console.log(`request, chain only: Send to the end in ${r.ms} ms; the status said ${JSON.stringify(r.said)}`)
    assert.ok(!/err/.test(r.status.className), r.status.textContent)
    assert.match(r.status.textContent, /^Sent 0\.01 X/)
    const asked = A.worker.asked.filter((c) => /^(board|send)(:|$)/.test(c))
    console.log('request, chain only: the library was asked ' + asked.join(', '))
    assert.equal(asked[0], 'board', 'moved in first: ' + asked.join(','))
    assert.equal(asked.filter((c) => c === 'send').length, 1, 'paid once: ' + asked.join(','))
    assert.equal(bHolds() - before, 1_000_000n, 'B holds the payment')
  })

  await t.test('an amount that needs the tree and the chain: one payment, the chain part moved in first', async () => {
    const A = await wallet('legal winner thank year wave sausage worth useful legal winner thank yellow')
    // 1,500,000 in the tree (boarded and final), then 2,000,000 paid on the chain.
    await H.fund(A.W.command('address').script_pubkey, X, 1_500_000); await H.produce()
    A.W.command('sync')
    const q = A.W.command('board_quote', { asset: X, amount: '1490000' })
    A.W.command('board', { asset: X, amount: '1490000', shown: q.fee })
    for (let i = 0; i < 60; i++) {
      await H.produce(); await H.bury(); A.W.command('sync')
      if ((A.W.command('boards') || []).every((b) => b.server && b.server.state === 'credited')) break
      await sleep(1000)
    }
    await A.api.syncNow()
    assert.equal(A.api.leafAtoms(X), 1_490_000n, 'the tree holds 1,490,000')
    await A.paid(2_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    const d = A.p.payCodeRoute(buildPayCode({ address: B.command('address').address, sequentia: req }), X, 2_500_000n)
    console.log('mixed, to a code: route', JSON.stringify(d))
    assert.equal(d.bringIn, true, 'neither part alone covers it: moved in first ' + JSON.stringify(d))
    await A.p.treeSendReview({ asset: X, amtS: '0.025', addr: d.dest, bringIn: d.bringIn }, () => {})
    const modal = A.p.modals[0]
    assert.ok(!/up to/i.test(textOf(modal.m)), textOf(modal.m))
    const r = await send(H, modal)
    console.log(`mixed, to a code: Send to the end in ${r.ms} ms; the status said ${JSON.stringify(r.said)}`)
    assert.match(r.status.textContent, /^Sent 0\.025 X/)
    assert.equal(bHolds() - before, 2_500_000n, 'B holds the whole payment')
  })

  await t.test('an address, with the same mixed holdings: one payment out of the tree, the chain part moved in first', async () => {
    const A = await wallet('jelly better achieve collect unaware mountain thought cargo oxygen act hood bridge')
    await H.fund(A.W.command('address').script_pubkey, X, 1_500_000); await H.produce()
    A.W.command('sync')
    const q = A.W.command('board_quote', { asset: X, amount: '1490000' })
    A.W.command('board', { asset: X, amount: '1490000', shown: q.fee })
    for (let i = 0; i < 60; i++) {
      await H.produce(); await H.bury(); A.W.command('sync')
      if ((A.W.command('boards') || []).every((b) => b.server && b.server.state === 'credited')) break
      await sleep(1000)
    }
    await A.api.syncNow()
    await A.paid(2_000_000)
    const to = B.command('address').address
    const tree = A.api.leafAtoms(X)
    const route = addressRoute(2_500_000n, A.p.chainHeld(X), tree, 2000n, A.p.onItsWay(X), A.p.chainMovable(X), A.p.bringMargin(X))
    console.log('mixed, to an address: route', route)
    assert.equal(route, 'bring-in')
    await A.p.offboardReview({ asset: X, amtS: '0.025', addr: to, bringIn: true }, () => {})
    const modal = A.p.modals[0]
    console.log('mixed, to an address: review\n' + textOf(modal.m))
    const r = await send(H, modal, { rounds: true })
    console.log(`mixed, to an address: Send to the page's part in ${r.ms} ms; the status said ${JSON.stringify(r.said)}`)
    assert.ok(!/err/.test(r.status.className), r.status.textContent)
    const asked = A.worker.asked.filter((c) => /^(board|offboard|settle_first)(:|$)/.test(c))
    console.log('mixed, to an address: the library was asked ' + asked.join(', '))
    assert.equal(asked[0], 'board', 'moved in first')
    const offboards = A.W.command('offboards')
    assert.ok(offboards.some((o) => o.address === to && String(o.amount) === '2500000' && o.state !== 'not_made'), 'the offboard of 2,500,000 is made: ' + JSON.stringify(offboards))
  })
})
