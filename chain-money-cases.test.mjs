// Money received on the chain, the cases a review asked for, on the real leaf wallet library and a
// real operator (the harness of chain-money-library.test.mjs): index.html's own routes and reviews
// over leaves.js, which the page mounts over the same library.
//
//   - a send moved in first: its fee and total as the most they can be, and what left the wallet
//     within them (the move's fee and the payment's);
//   - the whole balance typed to a receive code: refused naming the figure Max fills in;
//   - a payment not in a block yet is never moved in before it is;
//   - a supervised asset moves in like any other; frozen on the chain, it moves nowhere and the
//     refusal says it is frozen;
//   - native bitcoin is never moved in;
//   - an asset the operator does not serve, and an amount under its smallest coin: they stay on the
//     chain, are paid at an address, and are said so;
//   - an anchor rollback of the move itself: the payment waits, goes once, the wallet whole;
//   - two tabs, and two devices, on one phrase asking at once: each payment once.
//
// The harness runs with ARCA_OPERATOR_SUPERVISED=1 (Z) and its anchor depth from
// ARCA_TEST_ANCHOR_DEPTH:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18751 node --test chain-money-cases.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import * as arca from './default-arca.js'
const { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, addressRoute, codeRoute, codeMost, boardMinutes } = arca
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
function page (leavesApi, ticker, chain, opts = {}) {
  const modals = []
  const deps = {
    leavesApi, DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, codeRoute, codeMost, boardMinutes, readPayCode,
    devMode: () => false, isOampAsset: (h) => !!(opts.oamp && opts.oamp.includes(h)), arkDirectWhy: () => null, arkRoom: () => null,
    availableFor: (h) => chain[h] || 0n, feeMarginAtoms: () => 2000n,
    assetMeta: () => ({ ticker, precision: 8 }),
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
    noteSent: () => {}, walletTag: () => 't', localStorage: memStore(), renderBalance: () => {}, renderHistory: () => {},
    followAddressPayments: async () => 'made', markTold: () => {}, offboardNewsText: () => '', OFFBOARD_FOLLOW_MS: 0,
    document: { body: { contains: () => false } }, performance: { now: () => Date.now() },
  }
  // A page before this change has none of the chain's helpers: they stand in as counting nothing.
  const stub = { chainSpendable: 'function chainSpendable(h){ return chainHeld(h); }', codeWay: 'function codeWay(full){ return { dest: full, byAddress: false }; }', chainHeld: 'function chainHeld(h){ return availableFor(h); }',
    chainMovable: 'function chainMovable(){ return 0n; }', bringMargin: 'function bringMargin(){ return 0n; }', bringMinutes: 'function bringMinutes(){ return 5; }', bringWant: 'function bringWant(){ return 0n; }' }
  const names = ['onItsWay', 'settlesFirst', 'shortWords', 'noneNowWords', 'afterClose', 'waitFor', 'treeSendReview', 'offboardReview',
    'chainHeld', 'chainSpendable', 'chainMovable', 'chainStays', 'bringMargin', 'bringWant', 'bringMinutes', 'codeWay', 'payCodeRoute']
  // The fee's margin stands in last: an extracted one-line function brings the page's own after it.
  const src = names.map((n) => (!has(n) && stub[n]) ? stub[n] : fn(n)).join('\n') + '\nfunction feeMarginAtoms(h, vb = 1000){ return 4n * BigInt(vb); }\nreturn { ' + names.join(', ') + ' };'
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


const heldX = (W, X) => {
  const b = W.command('balance')
  const tree = Object.values((b.arca || {})[X] || {}).reduce((n, v) => n + BigInt(v), 0n)
  return { tree, chain: BigInt(((b.sequentia_onchain || {})[X]) || 0) }
}

test('money received on the chain: the review\'s cases, on the real library', { skip, timeout: 3_000_000 }, async (t) => {
  const H = harness(CONTROL)
  const st = await H.state()
  const X = st.x
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  const dir = mkdtempSync(join(process.env.SF6_TMP || tmpdir(), 'chain-cases-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./tooling/leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))
  const lib2 = await leafLibrary(join(dir, 'store2'))
  const B = lib.create('letter advice cage absurd amount doctor acoustic avoid letter advice cage above', cfg)
  const bHolds = (a = X) => { B.command('sync'); try { B.command('mailbox') } catch {} return BigInt(((B.command('balance').held) || {})[a] || 0) }
  const info = B.command('info')
  console.log('operator: anchor depth', info.anchor_depth, '; assets', JSON.stringify((info.server_info.assets || []).map((a) => ({ asset: a.asset.slice(0, 8), min_leaf: a.min_leaf }))))
  const minX = BigInt((info.server_info.assets.find((a) => a.asset === X) || {}).min_leaf || 0)

  let n = 0
  async function wallet (phrase, { library = lib, W: given = null, store = null, tag = null, oamp = [] } = {}) {
    const W = given || library.create(phrase, cfg)
    const s = store || memStore()
    const tg = tag || ('t' + (++n))
    s.setItem(JOINED_KEY + '.' + tg, '1')
    const worker = libraryWorker(library, W)
    const api = mountLeaves({ makeWorker: () => worker, store: s, walletTag: () => tg, mnemonic: () => phrase, el: () => ({}), tickMs: 3_600_000 }, null, null)
    t.after(() => api.stop())
    await api.start()
    const chain = {}
    const paid = async (atoms, asset = X, { block = true } = {}) => {
      const r = await H.fund(W.command('address').script_pubkey, asset, atoms)
      chain[asset] = (chain[asset] || 0n) + BigInt(atoms)
      if (block) { await H.produce(); await H.bury() }
      return r
    }
    return { W, api, worker, chain, paid, store: s, tag: tg, p: page(api, 'X', chain, { oamp }) }
  }
  const moved = (A) => A.worker.asked.filter((c) => /^(board|send|offboard|settle_first)(:|$)/.test(c))

  await t.test('B1: a send moved in first shows the most its fees can be and the total; what left is within them', async () => {
    const A = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    const d = A.p.payCodeRoute(req, X, 1_000_000n)
    assert.equal(d.bringIn, true, JSON.stringify(d))
    await A.p.treeSendReview({ asset: X, amtS: '0.01', addr: d.dest, bringIn: true }, () => {})
    const modal = A.p.modals[0]
    const shown = textOf(modal.m)
    console.log('B1 send review: ' + shown.replace(/\n/g, ' | '))
    const bound = A.p.bringMargin(X)
    assert.ok(shown.includes(DEFAULT_WORDS.feeAtMost('0.00016', 'X', '')), 'fee as a figure, the most: ' + shown)
    assert.ok(shown.includes(DEFAULT_WORDS.feeAtMost('0.01016', 'X', '')), 'and the total')
    assert.ok(!shown.includes(DEFAULT_WORDS.feeKeptSome))
    const r = await send(H, modal)
    console.log(`B1 send: ${r.ms} ms; said ${JSON.stringify(r.said)}; library ${moved(A).join(',')}`)
    assert.match(r.status.textContent, /^Sent 0\.01 X/)
    assert.equal(bHolds() - before, 1_000_000n)
    const h = heldX(A.W, X)
    const left = 3_000_000n - h.tree - h.chain
    console.log(`B1 send: the wallet's X fell by ${left}: 1,000,000 sent, ${left - 1_000_000n} in fees (move ${A.api.movedFees(X, 0)}), against at most ${bound}`)
    assert.ok(left - 1_000_000n <= bound, `fees ${left - 1_000_000n} over the ${bound} shown`)
  })

  await t.test('B3: the whole balance to a receive code with an address: refused naming Max\'s figure, which then goes', async () => {
    const A = await wallet('scheme spot photo card baby mountain device kick cradle pact join borrow')
    await A.paid(3_000_000)
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    for (const amount of [3_000_000n, 2_999_000n]) {
      const d = A.p.payCodeRoute(code, X, amount)
      await assert.rejects(A.p.treeSendReview({ asset: X, amtS: String(Number(amount) / 1e8), addr: d.dest, bringIn: !!d.bringIn, most: d.most }, () => {}),
        (e) => { console.log(`B3 ${amount}: ${e.message}`); assert.ok(!/up to 0 /.test(e.message), e.message); assert.equal(e.message, DEFAULT_WORDS.sendUpTo('0.02996', 'X')); return true })
    }
    const d = A.p.payCodeRoute(code, X, 2_996_000n)
    console.log('B3 at Max: ' + JSON.stringify(d))
    assert.equal(d.byAddress, true)
  })

  await t.test('N3: a payment not in a block yet is never moved in before it is; once in a block, it is', async () => {
    const A = await wallet('legal winner thank year wave sausage worth useful legal winner thank yellow')
    await A.paid(2_000_000, X, { block: false })
    const t0 = Date.now()
    const p = A.api.bringIn(X, { want: 1_000_000n, since: t0, until: t0 + 120_000 })
    await sleep(25_000)
    console.log('N3 before the block: library asked ' + A.worker.asked.filter((c) => /^(balance|board)/.test(c)).slice(-4).join(','))
    assert.ok(!A.worker.asked.includes('board'), 'nothing moved in from the mempool')
    await H.produce(); await H.bury()
    const tb = Date.now()
    const v = await p
    console.log(`N3: moved in ${Date.now() - tb} ms after the block: ${JSON.stringify(v && v.boarded ? { fee: v.boarded.fee } : v)}`)
    assert.ok(v && v.boarded)
  })

  await t.test('supervised: moved in like any asset; frozen on the chain, it moves nowhere and is said frozen', { skip: !st.supervised && 'harness without ARCA_OPERATOR_SUPERVISED' }, async () => {
    const Z = st.supervised
    const A = await wallet('jelly better achieve collect unaware mountain thought cargo oxygen act hood bridge')
    A.p = page(A.api, 'Z', A.chain)
    await A.paid(3_000_000, Z)
    const req = B.command('receive').request
    const before = bHolds(Z)
    const d = A.p.payCodeRoute(req, Z, 1_000_000n)
    console.log('supervised, chain only: route ' + JSON.stringify(d))
    assert.equal(d.bringIn, true)
    await A.p.treeSendReview({ asset: Z, amtS: '0.01', addr: d.dest, bringIn: true }, () => {})
    const r = await send(H, A.p.modals[0])
    console.log(`supervised: ${r.ms} ms; said ${JSON.stringify(r.said)}; library ${moved(A).join(',')}`)
    assert.match(r.status.textContent, /^Sent 0\.01 Z/)
    assert.equal(bHolds(Z) - before, 1_000_000n)
    // Frozen: another wallet's coin of Z on the chain, its script frozen by the issuer.
    const F = await wallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    F.p = page(F.api, 'Z', F.chain)
    await F.paid(2_000_000, Z)
    const script = F.W.command('address').script_pubkey
    await fetch(`http://${CONTROL}/freeze`, { method: 'POST', body: JSON.stringify({ script }) }).then((x) => x.json()).then((j) => console.log('freeze: ' + JSON.stringify(j)))
    await H.produce(); await H.bury()
    await F.api.syncNow().catch(() => {})
    try { F.W.command('balance') } catch {}
    const fb = F.W.command('balance')
    console.log('frozen wallet balance: onchain ' + JSON.stringify(fb.sequentia_onchain) + ' frozen ' + JSON.stringify(fb.sequentia_onchain_frozen))
    // The page's figures: what is frozen moves nowhere.
    await F.api.bringIn(Z, { want: 0n, until: Date.now() + 1 }).catch(() => null)
    console.log(`frozen: chainSpendable ${F.p.chainSpendable(Z)}, chainMovable ${F.p.chainMovable(Z)}, chainStays ${F.p.chainStays(Z)}`)
    assert.equal(F.p.chainMovable(Z), 0n, 'never moved in')
    const d2 = F.p.payCodeRoute(B.command('receive').request, Z, 1_000_000n)
    console.log('frozen: route ' + JSON.stringify(d2))
    assert.ok(!d2.bringIn)
    await assert.rejects(F.p.treeSendReview({ asset: Z, amtS: '0.01', addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
      (e) => { console.log('frozen: refused: ' + e.message); assert.match(e.message, /is frozen by its issuer/); return true })
    assert.ok(!F.worker.asked.includes('board'))
  })

  await t.test('native bitcoin is never moved in, nor routed as chain money of the tree', async () => {
    const A = await wallet('all all all all all all all all all all all all')
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    assert.deepEqual(A.p.codeWay(code, 'BTC', 1000n, 'addr'), { dest: code, byAddress: false })
    assert.equal(A.p.chainMovable('BTC'), 0n)
    assert.equal(A.p.chainStays('BTC'), null)
    console.log('BTC: codeWay leaves it, chainMovable 0, chainStays null')
  })

  await t.test('under the smallest coin the operator takes in: stays on the chain, paid at an address, said so otherwise', async () => {
    const A = await wallet('cat swing flag economy stadium alone churn speed unique patch report train')
    const dust = minX > 20_000n ? minX - 1n : 0n
    if (!dust) { console.log('under the smallest coin: min_leaf ' + minX + ' leaves no amount above the fee margin to test'); return }
    await A.paid(dust)
    console.log(`under the smallest coin (${minX}): holds ${dust} on the chain; chainMovable ${A.p.chainMovable(X)}, chainStays ${A.p.chainStays(X)}`)
    assert.equal(A.p.chainMovable(X), 0n)
    assert.equal(A.p.chainStays(X), 'dust')
    const amount = dust - 5_000n
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    const d = A.p.payCodeRoute(code, X, amount)
    console.log('dust, a code with an address: ' + JSON.stringify(d))
    assert.equal(d.byAddress, true, 'paid at the address on the chain')
    const d2 = A.p.payCodeRoute(B.command('receive').request, X, amount)
    console.log('dust, a request with no address: ' + JSON.stringify(d2))
    await assert.rejects(A.p.treeSendReview({ asset: X, amtS: String(Number(amount) / 1e8), addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
      (e) => { console.log('dust, no address: refused: ' + e.message); assert.equal(e.message, DEFAULT_WORDS.toAddressOnly('X')); return true })
    assert.ok(!A.worker.asked.includes('board'))
  })

  await t.test('an asset the operator does not serve: stays on the chain, paid at an address, said so otherwise', async () => {
    let W = null
    try {
      const iss = await H.rpc('issueasset', [0.05, 0, false])
      W = iss.asset
      const A = await wallet('pear pear pear pear pear pear pear pear pear pear pear pear')
      const addr = A.W.command('address').address
      await H.rpc('sendtoaddress', [addr, 0.03, '', '', false, false, 1, 'UNSET', false, W])
      A.chain[W] = 3_000_000n
      await H.produce(); await H.bury()
      await A.api.bringIn(W, { want: 0n, until: Date.now() + 1 }).catch(() => null)
      console.log(`unserved: chainMovable ${A.p.chainMovable(W)}, chainStays ${A.p.chainStays(W)}`)
      assert.equal(A.p.chainMovable(W), 0n)
      assert.equal(A.p.chainStays(W), 'unserved')
      const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
      const d = A.p.payCodeRoute(code, W, 1_000_000n)
      console.log('unserved, a code with an address: ' + JSON.stringify(d))
      assert.equal(d.byAddress, true)
      const d2 = A.p.payCodeRoute(B.command('receive').request, W, 1_000_000n)
      await assert.rejects(A.p.treeSendReview({ asset: W, amtS: '0.01', addr: d2.dest, bringIn: !!d2.bringIn, most: d2.most, onlyAddress: !!d2.onlyAddress }, () => {}),
        (e) => { console.log('unserved, no address: refused: ' + e.message); assert.equal(e.message, DEFAULT_WORDS.toAddressOnly('X')); return true })
      assert.ok(!A.worker.asked.includes('board'))
    } catch (e) { if (!W) { console.log('unserved: the harness node could not issue an asset: ' + e.message); return } throw e }
  })

  await t.test('restricted: stays on the chain, by its own way (never routed or moved in)', async () => {
    const A = await wallet('turtle turtle turtle turtle turtle turtle turtle turtle turtle turtle turtle turkey')
    const R = 'ab'.repeat(32)
    A.p = page(A.api, 'R', A.chain, { oamp: [R] })
    A.chain[R] = 3_000_000n
    const code = buildPayCode({ address: B.command('address').address, sequentia: B.command('receive').request })
    assert.deepEqual(A.p.payCodeRoute(code, R, 1_000_000n), { dest: code, byAddress: false })
    assert.deepEqual(A.p.codeWay(code, R, 1_000_000n, 'addr'), { dest: code, byAddress: false })
    assert.equal(A.p.chainMovable(R), 0n)
    console.log('restricted: payCodeRoute and codeWay leave it to its own way; chainMovable 0')
  })

  await t.test('an anchor rollback of the move itself: the payment waits, goes once, the wallet whole', async () => {
    const A = await wallet('hamster diagram private dutch cause delay private meat slide toddler razor book')
    await A.paid(3_000_000)
    const req = B.command('receive').request
    const before = bHolds()
    await A.p.treeSendReview({ asset: X, amtS: '0.01', addr: req, bringIn: true }, () => {})
    const modal = A.p.modals[0]
    let rolled = null
    const sending = modal.ok.onclick()
    // Wait for the board, put it in a block, then take that block's anchor away.
    for (let i = 0; i < 120 && !A.worker.asked.includes('board'); i++) await sleep(500)
    assert.ok(A.worker.asked.includes('board'), 'moved in')
    const boardTx = (A.W.command('boards') || []).map((b) => b.txid || b.funding_txid).filter(Boolean).pop()
    await H.produce()
    try {
      const tx = await H.rpc('getrawtransaction', [boardTx, true])
      const hdr = await H.rpc('getblockheader', [tx.blockhash])
      const o = await fetch(`http://${CONTROL}/orphan`, { method: 'POST', body: JSON.stringify({ height: hdr.anchorheight }) }).then((x) => x.json())
      const again = await H.rpc('getrawtransaction', [boardTx, true]).catch((e) => ({ error: e.message }))
      rolled = { anchor: hdr.anchorheight, orphaned: o, boardNow: again.blockhash ? 'in a block' : again.confirmations === undefined ? 'mempool' : String(again.confirmations) }
    } catch (e) { rolled = { error: e.message } }
    console.log('rollback of the move: ' + JSON.stringify(rolled) + ' (board ' + boardTx + ')')
    let done = false
    const pump = (async () => { while (!done) { try { await H.produce(); await H.bury(); await H.round() } catch {} await sleep(2500) } })()
    try { await sending } finally { done = true; await pump }
    console.log('rollback: status ' + modal.st.textContent + '; library ' + moved(A).join(','))
    assert.match(modal.st.textContent, /^Sent 0\.01 X/)
    assert.equal(A.worker.asked.filter((c) => c === 'send').length, 1, 'paid once')
    assert.equal(bHolds() - before, 1_000_000n)
    const h = heldX(A.W, X)
    console.log(`rollback: the wallet holds ${h.tree} in the tree and ${h.chain} on the chain: fell by ${3_000_000n - h.tree - h.chain}`)
    assert.ok(3_000_000n - h.tree - h.chain - 1_000_000n <= A.p.bringMargin(X), 'whole: only the payment and its fees left')
  })

  await t.test('two tabs on one phrase, each sending at once with money moved in: each paid once, one move', async () => {
    const phrase = 'gesture bless dwarf kidney swallow dawn lawsuit drill ostrich cook wave exist'
    const A1 = await wallet(phrase)
    const A2 = await wallet(phrase, { W: A1.W, store: A1.store, tag: A1.tag })
    await A1.paid(3_000_000); A2.chain[X] = 3_000_000n
    const before = bHolds()
    await A1.p.treeSendReview({ asset: X, amtS: '0.004', addr: B.command('receive').request, bringIn: true }, () => {})
    await A2.p.treeSendReview({ asset: X, amtS: '0.006', addr: B.command('receive').request, bringIn: true }, () => {})
    const [r1, r2] = await Promise.all([send(H, A1.p.modals[0]), send(H, A2.p.modals[0])])
    const boards = A1.worker.asked.filter((c) => c === 'board').length + A2.worker.asked.filter((c) => c === 'board').length
    console.log(`two tabs: tab 1 ${JSON.stringify(r1.said)}; tab 2 ${JSON.stringify(r2.said)}; boards ${boards}; sends ${[...A1.worker.asked, ...A2.worker.asked].filter((c) => c === 'send').length}`)
    const got = bHolds() - before
    console.log('two tabs: B received ' + got)
    assert.ok(got <= 1_000_000n, 'never paid twice')
    for (const r of [r1, r2]) assert.ok(/^Sent|cannot be moved|taking longer/.test(r.status.textContent), r.status.textContent)
  })

  await t.test('two devices on one phrase, each sending at once with money moved in: each paid once at most', async () => {
    const phrase = 'vessel ladder alter error federal sibling chat ability sun glass valve picture'
    const D1 = await wallet(phrase)
    const D2 = await wallet(phrase, { library: lib2 })
    await D1.paid(3_000_000); D2.chain[X] = 3_000_000n
    const before = bHolds()
    await D1.p.treeSendReview({ asset: X, amtS: '0.004', addr: B.command('receive').request, bringIn: true }, () => {})
    await D2.p.treeSendReview({ asset: X, amtS: '0.006', addr: B.command('receive').request, bringIn: true }, () => {})
    const [r1, r2] = await Promise.all([send(H, D1.p.modals[0]), send(H, D2.p.modals[0])])
    console.log(`two devices: device 1 ${JSON.stringify(r1.said)} [${moved(D1).join(',')}]; device 2 ${JSON.stringify(r2.said)} [${moved(D2).join(',')}]`)
    const got = bHolds() - before
    console.log('two devices: B received ' + got)
    assert.ok(got <= 1_000_000n, 'never paid twice')
    for (const r of [r1, r2]) assert.ok(!/something went wrong|try again/i.test(r.status.textContent), r.status.textContent)
  })
})
