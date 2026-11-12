// Send to an address of money still arriving, against the real leaf wallet library (leaves/pkg,
// run in Node by tooling/leaf-node.mjs) and a real operator: index.html's own offboardReview on
// leaves.js, which the page mounts over the same library. The money is a payment received past
// the wallet's instant limit, so the library places it as arriving and answers `settle_first` for
// an offboard from it (arca #797). The page reviews it at once and, on Send, settles it first and
// then makes the offboard, saying "Goes through in about a minute" meanwhile (D96).
//
// It needs the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs) running,
// its control address in SEQ_LEAF_HARNESS, and skips itself otherwise:
//
//   SEQ_LEAF_HARNESS=127.0.0.1:18640 node --test send-arriving-library.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from './leaves.js'
import { settleWords } from './default-arca.js'
import { stageWriter, dropPending } from './pending-sends.js'
import { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, addressRoute } from './default-arca.js'

const CONTROL = process.env.SEQ_LEAF_HARNESS
const PKG = process.env.LEAVES_PKG || new URL('./leaves/pkg', import.meta.url).pathname
const skip = !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package in leaves/pkg' : false

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The harness's control address (tooling/user-mode-stack.mjs harness(), the calls this test needs).
function harness (control) {
  const c = async (path, body) => {
    const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
    return j
  }
  return {
    state: () => c('/state'), fund: (script, asset, amount) => c('/fund', { script, asset, amount: Number(amount) }),
    produce: () => c('/produce'), bury: () => c('/bury'), round: () => c('/round', {}), bond: () => c('/bond_post', {}),
    rpc: (method, params = []) => c('/rpc', { method, params }),
  }
}

function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// The page's worker (leaves/worker.js) over the library in this process: the same messages, the
// same answers, a refusal in the library's own words.
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
    } catch (e) { reply = { id, ok: false, error: { ...e, kind: e.kind || 'error', message: e.message } } }   // the library's whole refusal, as worker.js passes it
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

// index.html's own functions, on a stand-in document, with `leavesApi` the mounted module.
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

test('W5: a send to an address of money still arriving, on the real library: reviewed at once, settled first, then made', { skip, timeout: 900_000 }, async (t) => {
  const H = harness(CONTROL)
  const st = await H.state()
  const X = st.x
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  try { await H.bond() } catch (e) { if (!/bond/.test(e.message)) throw e }   // an instant limit means something only under a bond
  const dir = mkdtempSync(join(tmpdir(), 'w5-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./tooling/leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))

  // S, the sender: 4,000,000 X boarded, paid from the chain.
  const S = lib.create('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', cfg)
  const sa = S.command('address')
  await H.fund(sa.script_pubkey, X, 7_000_000)
  await H.fund(S.command('address').script_pubkey, X, 3_000_000)
  await H.produce()
  S.command('sync')
  const q = S.command('board_quote', { asset: X, amount: '4000000', fee_asset: X })
  S.command('board', { asset: X, amount: '4000000', fee_asset: X, shown: q.fee })
  await H.produce(); await H.bury()
  for (let i = 0; i < 60; i++) {
    S.command('sync')
    if ((S.command('boards') || []).every((b) => b.server && b.server.state === 'credited')) break
    await H.produce(); await sleep(1000)
  }

  // A, the payee, as the page holds it: created, joined, its instant limit worth 1,000,000 X.
  const A = lib.create('legal winner thank year wave sausage worth useful legal winner thank yellow', cfg)
  const rate = BigInt((await H.rpc('getfeeexchangerates'))[X] || 100_000_000)
  const store = memStore()
  store.setItem(JOINED_KEY + '.t', '1')
  const worker = libraryWorker(lib, A)
  const api = mountLeaves({ makeWorker: () => worker, store, walletTag: () => 't', mnemonic: () => 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    el: () => ({}), tickMs: 3_600_000 }, null, null)
  t.after(() => api.stop())
  await api.start()
  await api.command('instant_limit', { value: String(1_000_000n * rate / 100_000_000n) })

  // S pays A 2,000,000 X, past A's limit: arriving.
  const req = A.command('receive').request
  S.command('send', { request: req, amount: '2000000', asset: X })
  A.command('mailbox')
  const places = A.command('coin_places')
  assert.ok((places.coins || []).some((c) => c.place === 'arriving' && String(c.value) === '2000000'), 'the payment is arriving: ' + JSON.stringify(places))
  await api.syncNow()

  const p = page(api, 'X')
  assert.equal(api.leafAtoms(X), 0n, 'nothing of it is in the figure yet')
  assert.equal(p.onItsWay(X), 2_000_000n, 'it is on its way')
  const to = S.command('address').address   // an address on the chain, of another wallet
  assert.equal(addressRoute(500_000n, 0n, api.leafAtoms(X), 0n, p.onItsWay(X)), 'arriving')

  // Review: at once, no refusal, nothing settled yet.
  await p.offboardReview({ asset: X, amtS: '0.005', addr: to }, () => {})
  const { ok, st: status, m } = p.modals[0]
  assert.ok(!/still arriving|up to 0/i.test(textOf(m)), textOf(m))
  // Send: the library answers settle_first, the page settles, the operator's rounds go by, and the
  // offboard is made. The harness builds a round only when asked: asked every few seconds here.
  let sent = false
  const pump = (async () => { while (!sent) { try { await H.round() } catch {} await sleep(3000) } })()
  const tSend = Date.now()
  const said = []
  const watch = setInterval(() => { const s = status.textContent; if (s && said[said.length - 1] !== s) said.push(s) }, 200)
  try { await ok.onclick() } finally { sent = true; clearInterval(watch); await pump }
  console.log(`W5: Send to the end of the page's part: ${Date.now() - tSend} ms; the status said: ${JSON.stringify(said)}; finally: ${status.className} ${status.textContent}`)
  assert.ok(!/err/.test(status.className), status.className + ' ' + status.textContent)
  assert.ok(said.some((s) => /Goes through (in about a minute|within about \d+ minutes)/.test(s)), 'it said how long it takes: ' + JSON.stringify(said))
  // The library was asked to settle first, then for the offboard, in that order.
  // The library refused the offboard with settle_first (nothing signed), the page settled the coin,
  // and the offboard asked again went.
  const asked = worker.asked.filter((c) => /^(settle_first|offboard)(:|$)/.test(c))
  console.log('W5: the library was asked ' + asked.join(', '))
  assert.equal(asked[0], 'offboard:settle_first', 'the offboard first answers settle_first: ' + asked.join(','))
  assert.ok(asked.indexOf('settle_first') > 0 && asked.lastIndexOf('offboard') > asked.indexOf('settle_first'), 'settled, then the offboard went: ' + asked.join(','))
  let offboards = A.command('offboards')
  assert.ok(Array.isArray(offboards) && offboards.some((o) => o.state && o.state !== 'not_made'), 'the offboard is made: ' + JSON.stringify(offboards))
  // Its round goes by: the payment reaches the address on the chain.
  const tRound = Date.now()
  let paid = null
  for (let i = 0; i < 40 && !paid; i++) {
    try { await H.round() } catch {}
    A.command('sync')
    offboards = A.command('offboards')
    const o = offboards.find((x) => x.address === to)
    try { await H.produce() } catch {}
    if (o && o.txid) {
      const tx = await H.rpc('getrawtransaction', [o.txid, true]).catch(() => null)
      const out = tx && (tx.confirmations || 0) >= 1 ? tx.vout.find((v) => v.scriptPubKey.hex === o.script && Math.round(v.value * 1e8) === 500000 && v.asset === X) : null
      if (out) paid = { txid: o.txid, amount: out.value, confirmations: tx.confirmations }
    }
    if (!paid) await sleep(1500)
    if (o && i % 5 === 0) console.log(`W5: offboard ${o.state} after ${Date.now() - tRound} ms`)
  }
  console.log('W5: offboards ' + JSON.stringify(offboards.map((o) => [o.offboard.slice(0, 8), o.amount, o.state])) + `; on the chain: ${paid ? paid.txid + ' pays the address ' + Math.round(paid.amount * 1e8) + ' X, ' + paid.confirmations + ' confirmation(s)' : 'not yet'}, ${Date.now() - tRound} ms after the page's part`)
  assert.ok(paid, 'the 500,000 X reached the address on the chain')
  const settled = A.command('coin_places').coins || []
  console.log('W5: coins after ' + JSON.stringify(settled.map((c) => [c.leaf_id.slice(0, 8), c.value, c.state, c.place])))
})
