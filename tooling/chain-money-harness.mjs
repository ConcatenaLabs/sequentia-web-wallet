// Helpers of the chain-money-cases-*.test.mjs files: the harness, the leaf library in Node, the page's
// own functions over leaves.js, and a fresh wallet per case. One process holds at most five leaf
// wallets open, so the cases are split across files.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountLeaves, JOINED_KEY } from '../leaves.js'
import * as arca from '../default-arca.js'
const { DEFAULT_WORDS, sendableNow, offboardOutcome, arrivalMinutes, addressRoute, codeRoute, codeMost, boardMinutes } = arca
import { readPayCode, buildPayCode } from '../pay-code.js'

// Amounts are BigInts: the cases' log lines print them as strings.
// eslint-disable-next-line no-extend-native
if (!BigInt.prototype.toJSON) BigInt.prototype.toJSON = function () { return this.toString() }

export const CONTROL = process.env.SEQ_LEAF_HARNESS
export const PKG = process.env.LEAVES_PKG || new URL('../leaves/pkg', import.meta.url).pathname
export const skip = !process.env.LWK_PKG ? 'needs LWK_PKG (fresh phrases)' : !CONTROL ? 'needs the operator harness: SEQ_LEAF_HARNESS=<its control address>'
  : !existsSync(join(PKG, 'leaf_wallet_bg.wasm')) ? 'needs the leaf wallet package in leaves/pkg' : false

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const has = (name) => new RegExp('\\n(async )?function ' + name + '\\(').test(html)
const fn = (name) => { const i = html.search(new RegExp('\\n(async )?function ' + name + '\\(')); assert.ok(i > 0, name); return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2) }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function harness (control) {
  const c = async (path, body) => {
    const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
    return j
  }
  return { state: () => c('/state'), fund: (script, asset, amount) => c('/fund', { script, asset, amount: Number(amount) }),
    produce: () => c('/produce'), bury: () => c('/bury'), round: () => c('/round', {}), rpc: (method, params = []) => c('/rpc', { method, params }) }
}
export function memStore () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
// The page's worker (leaves/worker.js) over the library in this process: the same messages, the
// same answers, a refusal in the library's own words. `asked` lists every command, and its refusal.
export function libraryWorker (lib, opened) {
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
export function node (tag, cls, text) {
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
export const textOf = (n) => [n.textContent, ...n.children.map(textOf)].filter(Boolean).join('\n')

// index.html's own functions, on a stand-in document, with `leavesApi` the mounted module and
// `chain` the wallet's coins on the chain as the page reads them (asset -> atoms).
export function page (leavesApi, ticker, chain, opts = {}) {
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
export async function send (H, modal, { rounds = true } = {}) {
  let done = false
  const pump = (async () => { while (!done) { try { await H.produce(); await H.bury(); if (rounds) await H.round() } catch {} await sleep(2500) } })()
  const said = []
  const watch = setInterval(() => { const s = modal.st.textContent; if (s && said[said.length - 1] !== s) said.push(s) }, 200)
  const t0 = Date.now()
  try { await modal.ok.onclick() } finally { done = true; clearInterval(watch); await pump }
  const s = modal.st.textContent; if (s && said[said.length - 1] !== s) said.push(s)
  return { said, ms: Date.now() - t0, status: modal.st }
}


export const heldX = (W, X) => {
  const b = W.command('balance')
  const tree = Object.values((b.arca || {})[X] || {}).reduce((n, v) => n + BigInt(v), 0n)
  return { tree, chain: BigInt(((b.sequentia_onchain || {})[X]) || 0) }
}


// The common start of each case file: the harness, the library in this process, the payee B, and
// `wallet(label)`, a fresh wallet (a new random phrase) as the page holds it.
export async function setup (t) {
  const lwkMod = await import('./user-mode-stack.mjs').then((m) => m.lwkFrom(process.env.LWK_PKG))
  const fresh = () => lwkMod.Mnemonic.fromRandom(12).toString()
  const H = harness(CONTROL)
  const st = await H.state()
  const X = st.x
  const cfg = { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password }
  const dir = mkdtempSync(join(process.env.SF6_TMP || tmpdir(), 'chain-cases-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.LEAVES_PKG = PKG
  const { leafLibrary } = await import('./leaf-node.mjs')
  const lib = await leafLibrary(join(dir, 'store'))
  const B = lib.create(fresh(), cfg)
  const bHolds = (a = X) => { B.command('sync'); try { B.command('mailbox') } catch {} return BigInt(((B.command('balance').held) || {})[a] || 0) }
  const info = B.command('info')
  console.log('operator: anchor depth', info.anchor_depth, '; assets', JSON.stringify((info.server_info.assets || []).map((a) => ({ asset: a.asset.slice(0, 8), min_leaf: a.min_leaf }))))
  const minX = BigInt((info.server_info.assets.find((a) => a.asset === X) || {}).min_leaf || 0)

  let n = 0
  // The library holds only a few wallets open at once: each case closes the ones before it.
  const opened = []
  const release = () => { for (const o of opened.splice(0)) { try { o.api.stop() } catch {} try { o.W.close() } catch {} } }
  t.after(release)
  async function wallet (phrase = fresh(), { library = lib, W: given = null, store = null, tag = null, oamp = [] } = {}) {
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
      const script = W.command('address').script_pubkey
      const r = await H.fund(script, asset, atoms)
      r.script = script
      chain[asset] = (chain[asset] || 0n) + BigInt(atoms)
      if (block) { await H.produce(); await H.bury() }
      return r
    }
    opened.push({ api, W })
    return { W, api, worker, chain, paid, store: s, tag: tg, p: page(api, 'X', chain, { oamp }) }
  }
  const moved = (A) => A.worker.asked.filter((c) => /^(board|send|offboard|settle_first)(:|$)/.test(c))

  return { H, st, X, cfg, dir, lib, B, bHolds, info, minX, wallet, release, moved, fresh }
}
