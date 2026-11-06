// The page API: the wallet's mode and its leaf rail, for code running in the wallet's
// own pages, in the shape the browser extension's provider serves to sites
// (`window.sequentia`, its doc/PROVIDER.md). docs/PAGE_API.md describes every method.
//
// On the wallet's page: `window.sequentiaWallet`, with `request({ method, params })`,
// `on(event, fn)` and `removeListener(event, fn)`. Another page of the wallet's origin
// reads the mode, and hears it change, over the BroadcastChannel `sequentia-wallet`; a site of
// the origin (SeqDEX) that its owner connects here trades through this page over the same channel,
// each order shown in this page's dialog first (the extension's doc/PAIRING.md).
//
// The mode and the leaf rail follow the provider's rules: the mode reads silently; the
// leaf methods answer in developer mode only; a receive request, a payment, a board and
// an exit each wait for the user's approval in the wallet's own dialog, which shows what
// will be signed, and the board's and the exit's fees as the library quotes them before
// anything is signed. The library goes ahead only on the fees shown. Nothing about a
// leaf is decided here: every answer and refusal is the library's (leaves.js and its
// worker).

import { readRequest, planSend, leafBalancesAnswer } from './leaf-request.js'
import { ORDER_FEATURES } from './site-orders.js'
import { describeTransparent } from './pset-bytes.js'

export const CHANNEL = 'sequentia-wallet'
export const NOT_DEVELOPER = 'leaves are a developer-mode rail: turn developer mode on in the wallet’s Settings'
export const NOT_JOINED = 'this wallet has not joined a leaf operator: join one in the wallet’s Leaves tab'
export const METHODS = ['getCapabilities', 'getWalletMode', 'getLeafBalances', 'getLeafAddress', 'requestLeafReceive',
  'sendLeaves', 'boardLeaves', 'exitLeaf']
export const EVENTS = ['modeChanged', 'leafArrived', 'leafSyncDue']
export const PROVIDER = 'sequentia-web-wallet'
// What a site of this origin may ask over the channel (docs/PAGE_API.md).
export const SITE_METHODS = ['getCapabilities', 'getWalletMode', 'connect', 'getAccounts', 'getBalances', 'placeOrder', 'getOrders', 'cancelOrder', 'signMessage']
// What a site that builds its own transactions may also ask (a lending site: Pignus), served by a
// wallet page that can sign them: its network, its address and coins on the chain, a transaction
// the site composed signed behind this page's dialog, the broadcast, and coins moved onto the
// chain for such a transaction.
export const PSET_METHODS = ['getNetwork', 'getAddress', 'getUtxos', 'signPset', 'broadcast', 'prepareCoins']
// The sites of this origin, named in the dialogs by the path they are served at, with what their
// connection is for.
const SITE_NAMES = [
  [/\/dex\//, 'SeqDEX', 'to ask you to trade. Each trade is shown here for you to approve.'],
  [/\/emissio\//, 'Emissio', 'to ask you to trade. Each trade is shown here for you to approve.'],
  [/\/lending\//, 'Pignus', 'to ask you to sign what you borrow, lend and repay there. Each transaction is shown here for you to approve.'],
]
const siteEntry = (page) => SITE_NAMES.find(([re]) => re.test(page)) || [null, 'This site', 'to ask you to approve what you do there. Each request is shown here for you to approve.']
const siteName = (page) => siteEntry(page)[1]
// The words of a site's transaction in this page's dialog (docs/DEFAULT_MODE.md, Connect).
export const PSET_WORDS = Object.freeze({
  title: (name) => 'Sign a transaction for ' + name + '?',
  text: (name) => name + ' built this transaction. This is what it does to your wallet; approve it only if it is what you asked for there.',
  youPay: 'You pay',
  youReceive: 'You receive',
  fee: 'Network fee',
  feeNotYours: ', paid by the transaction, not from your coins',
  askedBy: 'Asked by',
  nothingOfYours: 'this wallet holds none of the inputs in that transaction',
  unreadable: 'this wallet cannot read that transaction, so it signs nothing',
  blinded: 'that transaction spends a confidential coin of this wallet; a site’s transaction spends coins in the clear only',
  moveTitle: (name) => 'Get coins ready for ' + name + '?',
  moveText: (name) => name + ' needs coins on the chain for what you asked there. The wallet moves them to your own address; they stay yours, and only the fee for the move is paid.',
  move: 'Moves',
  moveFee: 'Fee for the move',
})
// What a message to sign may hold: one line of text a person can read whole in the dialog. Control
// characters, line breaks and the marks that reorder text are refused, so what is shown is what is
// signed.
export const MESSAGE_MAX = 1000
const MESSAGE_BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/

const HEX64 = /^[0-9a-f]{64}$/

// ctx:
//   leaves      the Leaves module's api (mode, isOpen, command, address)
//   el          builds a node; text is set as text, never markup
//   assetMeta(hex) -> { ticker, precision }
//   fmtAtoms(atoms, precision) -> a decimal string
//   win         the window (sequentiaWallet is set on it); optional
//   doc         the document the dialog is shown in; optional (win.document)
//   confirm(display) -> Promise<boolean>; optional (the wallet's dialog)
//   channel     a BroadcastChannel-like; optional (made from win)
//   site        what a site of this origin may reach once its owner connects it; optional:
//               { unlocked() -> bool, account() -> { network, address }, balances() -> getBalances'
//               answer, orders (site-orders.js makeSiteOrders), attention() (bring this page forward),
//               signMessage(message) -> { address, signature } (the Sign tab's signature, by the key
//               of the address account() names) }
export function mountPageApi (ctx) {
  const { leaves } = ctx
  const listeners = new Map()
  const doc = ctx.doc || (ctx.win && ctx.win.document)
  const confirm = ctx.confirm || ((d) => dialog(doc, ctx.el, d))

  const emit = (event, data) => {
    for (const fn of listeners.get(event) || []) { try { fn(data) } catch {} }
  }

  const asset = (hex) => {
    let m = {}; try { m = ctx.assetMeta(hex) || {} } catch {}
    return m.ticker && m.ticker !== '?' && !/…$/.test(m.ticker) ? m.ticker + ' (' + hex + ')' : hex
  }
  const amount = (atoms, hex) => {
    if (atoms == null || !hex) return String(atoms ?? '')
    let m = {}; try { m = ctx.assetMeta(hex) || {} } catch {}
    const t = m.ticker && m.ticker !== '?' ? m.ticker : hex.slice(0, 12) + '…'
    return ctx.fmtAtoms(BigInt(atoms), m.precision || 0) + ' ' + t + ' (' + atoms + ' atoms)'
  }
  const optHex = (v, what) => {
    if (v == null || v === '') return null
    const h = String(v).toLowerCase()
    if (!HEX64.test(h)) throw new Error(what + ' must be a 64-hex asset id')
    return h
  }
  const optAtoms = (v) => {
    if (v == null || v === '') return null
    const s = String(v)
    if (!/^\d+$/.test(s) || BigInt(s) <= 0n) throw new Error('amount must be a positive number of atoms')
    return s
  }

  function requireLeaves () {
    if (leaves.mode() !== 'developer') throw new Error(NOT_DEVELOPER)
    if (!leaves.isOpen()) throw new Error(NOT_JOINED)
  }
  async function approved (display) {
    if (!(await confirm(display))) throw new Error('the user rejected the request')
  }

  async function handle (method, params = {}) {
    switch (method) {
      case 'getCapabilities':
        return { provider: PROVIDER, methods: METHODS, events: EVENTS, features: ['leaves'] }

      case 'getWalletMode':
        return { mode: leaves.mode() }

      case 'getLeafBalances': {
        requireLeaves()
        const balance = await leaves.command('balance')
        const schedule = await leaves.command('schedule').catch(() => null)
        return leafBalancesAnswer(balance, schedule)
      }

      case 'getLeafAddress':
        requireLeaves()
        return await leaves.address()

      case 'requestLeafReceive': {
        const a = optHex(params.asset, 'asset')
        const n = optAtoms(params.amount)
        requireLeaves()
        await approved({
          title: 'Hand out a receive request for leaves?',
          text: 'A single-use receive request: a payer pays it out of round, with no transaction. The payment arrives in the wallet’s mailbox, which the wallet reads while it runs.',
          rows: [['Asset', a ? asset(a) : 'any (the payer names it)'], ['Amount', n != null ? (a ? amount(n, a) : n + ' atoms') : 'any (the payer names it)']],
        })
        const args = {}
        if (a) args.asset = a
        if (n != null) args.amount = n
        return await leaves.command('receive', args)
      }

      case 'sendLeaves': {
        const text = String(params.request ?? '')
        if (!text) throw new Error('request is required')
        requireLeaves()
        const req = readRequest(text)
        const info = await leaves.command('info')
        const plan = planSend(req, { asset: params.asset, amount: params.amount }, info)
        const rows = [['Asset', asset(plan.asset)], ['You send', amount(plan.amount, plan.asset)],
          ['Receiver’s leaf key', plan.owner], ['Receiver’s mailbox', plan.mailbox]]
        if (plan.until != null) rows.push(['Request lapses', new Date(plan.until * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') + ' (median time)'])
        await approved({
          title: 'Pay from your leaves?',
          text: 'A payment of a receive request from your leaves, out of round: no transaction, and nothing paid to the operator. The coins spent keep a margin of the same asset for the fees of taking them on-chain.',
          rows,
        })
        return await leaves.command('send', { request: text, asset: plan.asset, amount: plan.amount })
      }

      case 'boardLeaves': {
        const a = optHex(params.asset, 'asset')
        if (!a) throw new Error('asset must be a 64-hex asset id')
        const n = optAtoms(params.amount)
        if (n == null) throw new Error('amount must be a positive number of atoms')
        const fee = optHex(params.fee_asset, 'fee_asset')
        requireLeaves()
        const args = { asset: a, amount: n }
        if (fee) args.fee_asset = fee
        const q = await leaves.command('board_quote', args)
        await approved({
          title: 'Board a coin into your leaves?',
          text: 'One transaction from the leaf wallet’s on-chain coins to the operator’s tree. The coin is a leaf once the transaction is final.',
          rows: [['Asset', asset(a)], ['Amount boarded', amount(n, a)],
            ['Fee', amount(q.fee.amount, q.fee.asset) + ' (the node’s floor now, in the fee asset’s own atoms)'],
            ['Transaction', q.vsize + ' vB, spending ' + q.inputs + ' coin(s)']],
          detail: 'The board goes ahead only on the fee shown. If it has changed by the time the wallet signs, nothing is signed and the page hears why.',
        })
        return await leaves.command('board', { ...args, shown: q.fee })
      }

      case 'exitLeaf': {
        const leafId = String(params.leaf_id ?? '')
        if (!leafId) throw new Error('leaf_id is required')
        const fee = optHex(params.fee_asset, 'fee_asset')
        requireLeaves()
        const args = { leaf_id: leafId }
        if (fee) args.fee_asset = fee
        const q = await leaves.command('exit_quote', args)
        const rows = [['Leaf', leafId], ['Coin', amount(q.value, q.asset)]]
        ;(q.steps || []).forEach((st, i) => rows.push(['Transaction ' + (i + 1), st.vsize + ' vB, fee ' +
          ((st.fee || []).map((f) => amount(f.amount, f.asset)).join(' + ') || 'none') + ', paid from ' + st.paid_by]))
        if (!(q.steps || []).length) rows.push(['Now', 'nothing to broadcast before the claim'])
        const c = q.claim || {}
        rows.push(['Claim, later', c.error ? c.error : 'fee about ' + ((c.fee || []).map((f) => amount(f.amount, f.asset)).join(' + ') || 'none') +
          ' at the floor when it is made' + (c.pays ? ', paying ' + amount(c.pays, q.asset) + ' to this wallet' : '')])
        if (q.exit_delay_seconds != null) rows.push(['Exit delay', Math.round(q.exit_delay_seconds / 360) / 10 + ' h after the leaf’s transaction is in a block'])
        await approved({
          title: 'Take a leaf home on-chain?',
          text: 'The leaf is taken home by this wallet alone, without the operator: the transactions of its path now, then, once its exit delay has run, the claim to one of this wallet’s addresses. The wallet carries the exit on by itself until the claim is final.',
          rows,
          detail: 'Fees are each asset’s own atoms at the node’s floor now. The path is broadcast only on the fees shown; if they have changed, nothing is broadcast and the page hears why.',
        })
        const run = { leaf_id: leafId, shown: q.unroll || {} }
        if (q.fee_asset) run.fee_asset = q.fee_asset
        return await leaves.command('exit', run)
      }

      default:
        throw new Error('unknown method: ' + method)
    }
  }

  const api = {
    isSequentiaWallet: true,
    request: ({ method, params } = {}) => handle(String(method || ''), params || {}),
    on (event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return api },
    removeListener (event, fn) { const s = listeners.get(event); if (s) s.delete(fn); return api },
  }
  if (ctx.win) ctx.win.sequentiaWallet = api

  // Other pages of the wallet's origin (docs/PAGE_API.md, "Sites of this origin"): every page
  // reads the mode; a site that says hello and is approved by its owner here trades through this
  // wallet page (its account, balances and orders), each action behind this page's dialog.
  let channel = ctx.channel || null
  if (!channel && ctx.win && typeof ctx.win.BroadcastChannel === 'function') channel = new ctx.win.BroadcastChannel(CHANNEL)
  const walletId = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  const connected = new Set()   // the pages approved by this wallet page, while it is open
  if (channel) {
    channel.onmessage = (ev) => {
      const m = (ev && ev.data) || {}
      if (m.type === 'hello' && m.from) {
        channel.postMessage({ type: 'here', to: m.from, wallet: walletId, provider: PROVIDER, mode: leaves.mode() })
        return
      }
      if (m.type !== 'request') return
      const reply = (ok, v) => channel.postMessage({ type: 'answer', id: m.id, to: m.from, wallet: walletId, ok, ...(ok ? { result: v } : { error: v }) })
      if (!m.wallet) {
        if (m.method === 'getWalletMode') reply(true, { mode: leaves.mode() })
        else reply(false, 'only getWalletMode is served to the wallet’s other pages; the leaf methods are on the wallet’s page (window.sequentiaWallet)')
        return
      }
      if (m.wallet !== walletId) return
      siteRequest(String(m.page || ''), String(m.method || ''), m.params || {})
        .then((v) => reply(true, v), (e) => reply(false, (e && e.message) || String(e)))
    }
  }

  // A site's request over the channel: the provider protocol's market methods (the extension's
  // doc/PROVIDER.md), served while this page is open and the wallet unlocked.
  let queue = Promise.resolve()
  const oneAtATime = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p }
  async function siteRequest (page, method, params) {
    const site = ctx.site
    if (!site) throw new Error('this wallet page serves no site')
    const pageKey = page.replace(/[?#].*$/, '')
    const isConnected = () => connected.has(pageKey)
    switch (method) {
      case 'getCapabilities': {
        const psets = typeof site.signPset === 'function'
        return { provider: PROVIDER, methods: psets ? [...SITE_METHODS, ...PSET_METHODS] : SITE_METHODS, events: ['accountsChanged', 'modeChanged'],
          features: ['orders', 'balances-total', 'sign-message', ...(psets ? ['pset-site-built', 'prepare-coins'] : []), ...ORDER_FEATURES] }
      }
      case 'getWalletMode':
        return { mode: leaves.mode() }
      case 'getNetwork':
        if (typeof site.network !== 'function') break
        return site.network()
      case 'getAccounts':
        return { accounts: isConnected() && site.unlocked() ? [site.account()] : [] }
      case 'connect':
        if (!site.unlocked()) throw new Error('the wallet is locked; unlock it in its own page first')
        if (isConnected()) return site.account()
        return oneAtATime(async () => {
          site.attention && site.attention()
          await approved({ title: 'Connect ' + siteName(pageKey) + '?', text: siteName(pageKey) + ' wants to see your address and balances, and ' + siteEntry(pageKey)[2], rows: [['Site', pageKey]] })
          connected.add(pageKey)
          return site.account()
        })
      case 'signMessage': {
        // Its own dialog is the approval, so it needs no connection first: it shows the site, the
        // exact message and the address, and a signed message proves control of the address and
        // nothing else (the "Bitcoin Signed Message" hash is no transaction's).
        const message = params.message
        if (typeof message !== 'string' || !message.trim()) throw new Error('message is required')
        if (message.length > MESSAGE_MAX || MESSAGE_BAD.test(message)) throw new Error('message must be one line of text of at most ' + MESSAGE_MAX + ' characters')
        if (!site.unlocked()) throw new Error('the wallet is locked; unlock it in its own page first')
        if (typeof site.signMessage !== 'function') throw new Error('this wallet page does not sign messages')
        return oneAtATime(async () => {
          site.attention && site.attention()
          const name = siteName(pageKey)
          await approved({ title: 'Sign a message for ' + name + '?', text: 'This proves the wallet is yours. It moves no coins.',
            rows: [['Site', pageKey], ['Message', message], ['Signed by', site.account().address]] })
          return await site.signMessage(message)
        })
      }
    }
    if (!isConnected()) throw new Error('this site is not connected; call connect first')
    if (!site.unlocked()) throw new Error('the wallet is locked; unlock it in its own page first')
    switch (method) {
      case 'getBalances':
        return await site.balances()
      case 'getOrders':
        site.orders.follow().catch(() => {})
        return await site.orders.orders(pageKey)
      case 'placeOrder':
        return oneAtATime(async () => {
          const q = await site.orders.quote(params, pageKey)
          site.attention && site.attention()
          if (!(await confirm(q.display))) { site.orders.drop(q.id); throw new Error('the user rejected the request') }
          return await site.orders.confirm(q.id)
        })
      case 'cancelOrder':
        return oneAtATime(async () => {
          const q = await site.orders.quoteCancel(params, pageKey)
          site.attention && site.attention()
          if (!(await confirm(q.display))) throw new Error('the user rejected the request')
          return await site.orders.confirmCancel(q.id)
        })
    }
    if (typeof site.signPset !== 'function') throw new Error('unknown method: ' + method)
    switch (method) {
      case 'getAddress':
        return await site.address()
      case 'getUtxos': {
        const a = params.asset == null || params.asset === '' ? null : String(params.asset).toLowerCase()
        if (a !== null && !HEX64.test(a)) throw new Error('asset must be a 64-hex asset id')
        const utxos = await site.utxos()
        return { utxos: a ? utxos.filter((u) => u.asset === a) : utxos }
      }
      case 'signPset': {
        const pset = String(params.pset ?? '')
        if (!pset) throw new Error('pset is required')
        return oneAtATime(async () => {
          const d = readPset(pset)
          site.attention && site.attention()
          const name = siteName(pageKey)
          await approved({ title: PSET_WORDS.title(name), text: PSET_WORDS.text(name), rows: psetRows(d, pageKey) })
          return { pset: await site.signPset(pset) }
        })
      }
      case 'broadcast': {
        if (params.chain === 'bitcoin') throw new Error('this wallet page broadcasts Sequentia transactions only')
        const pset = params.pset == null ? null : String(params.pset)
        const hex = params.hex == null ? null : String(params.hex)
        if (!pset && !(hex && /^[0-9a-fA-F]+$/.test(hex))) throw new Error('pset or hex is required')
        return await site.broadcast(pset ? { pset } : { hex })
      }
      case 'prepareCoins': {
        const coins = readCoins(params.coins)
        return oneAtATime(async () => {
          const short = await site.shortOnChain(coins)
          if (!short.length) return { moved: [] }
          site.attention && site.attention()
          const name = siteName(pageKey)
          await approved({ title: PSET_WORDS.moveTitle(name), text: PSET_WORDS.moveText(name),
            rows: [...short.flatMap((c) => [[PSET_WORDS.move, plain(c.atoms, c.asset)], ...(c.fee ? [[PSET_WORDS.moveFee, plain(c.fee.atoms, c.fee.asset)]] : [])]), [PSET_WORDS.askedBy, pageKey]] })
          await site.prepareCoins(coins, name)
          return { moved: short.map((c) => ({ asset: c.asset, amount: String(c.atoms) })) }
        })
      }
    }
    throw new Error('unknown method: ' + method)
  }

  // An amount as default mode writes it: the asset's own decimals and its ticker, never atoms.
  function plain (atoms, hex) {
    let m = {}; try { m = ctx.assetMeta(hex) || {} } catch {}
    const t = m.ticker && m.ticker !== '?' ? m.ticker : String(hex).slice(0, 12) + '…'
    return ctx.fmtAtoms(BigInt(atoms), m.precision ?? 8) + ' ' + t
  }
  // What a site's transaction does to this wallet: read from its bytes once the wallet's own key
  // origins are on it (the site cannot know them), so a covenant's transparent transaction reads.
  function readPset (b64) {
    let t
    try { t = describeTransparent(ctx.site.detailed(b64)) } catch { throw new Error(PSET_WORDS.unreadable) }
    if (t.inputs.some((i) => i.mine && i.blinded)) throw new Error(PSET_WORDS.blinded)
    if (!t.inputs.some((i) => i.mine)) throw new Error(PSET_WORDS.nothingOfYours)
    if (t.outputs.some((o) => o.atoms == null || o.asset == null)) throw new Error(PSET_WORDS.unreadable)
    return t
  }
  // You pay and You receive are what moves between this wallet and others; the fee is its own row,
  // taken out of what you pay when your coins pay it.
  function psetRows (t, pageKey) {
    const rows = []
    const d = { ...t.deltas }
    const fee = t.fee != null && t.feeAsset ? t.fee : null
    const yoursPaysFee = fee != null && (d[t.feeAsset] || 0n) <= -fee
    if (yoursPaysFee) d[t.feeAsset] += fee
    const deltas = Object.entries(d).filter(([, v]) => v !== 0n)
    for (const [h, v] of deltas) if (v < 0n) rows.push([PSET_WORDS.youPay, plain(-v, h)])
    for (const [h, v] of deltas) if (v > 0n) rows.push([PSET_WORDS.youReceive, plain(v, h)])
    if (fee != null) rows.push([PSET_WORDS.fee, plain(fee, t.feeAsset) + (yoursPaysFee ? '' : PSET_WORDS.feeNotYours)])
    rows.push([PSET_WORDS.askedBy, pageKey])
    return rows
  }
  function readCoins (coins) {
    if (!Array.isArray(coins) || !coins.length) throw new Error('coins must be a list of { asset, amount }')
    return coins.map((c) => {
      const asset = String((c && c.asset) || '').toLowerCase()
      if (!HEX64.test(asset)) throw new Error('asset must be a 64-hex asset id')
      const s = String((c && c.amount) ?? '')
      if (!/^\d+$/.test(s) || BigInt(s) <= 0n) throw new Error('amount must be a positive number of atoms')
      return { asset, atoms: BigInt(s) }
    })
  }

  return {
    api,
    request: api.request,
    modeChanged (mode) {
      emit('modeChanged', { mode })
      if (channel) try { channel.postMessage({ type: 'event', event: 'modeChanged', data: { mode }, wallet: walletId }) } catch {}
    },
    // The wallet was locked or another one opened: every site connected here hears it.
    accountsChanged () {
      connected.clear()
      if (channel) try { channel.postMessage({ type: 'event', event: 'accountsChanged', data: { accounts: [] }, wallet: walletId }) } catch {}
    },
    // The leaf events reach the page in developer mode only.
    leafEvent (name, data) { if (EVENTS.includes(name) && name !== 'modeChanged' && leaves.mode() === 'developer') emit(name, data) },
  }
}

// The wallet's approval dialog for a page API request: what will be done, row by row,
// and Approve or Reject. Resolves true on Approve.
export function dialog (doc, el, d) {
  return new Promise((resolve) => {
    const m = el('div', 'modal'); m.id = 'pageApiApproval'
    const c = el('div', 'card')
    c.appendChild(el('label', 'lbl', d.title || 'Approve?'))
    if (d.text) c.appendChild(el('p', 'sub', d.text))
    for (const [k, v] of d.rows || []) {
      const r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v mono-inline', String(v))); c.appendChild(r)
    }
    if (d.detail) c.appendChild(el('p', 'sub', d.detail))
    const row = el('div', 'row'); row.style.marginTop = '14px'
    const ok = el('button', 'primary', 'Approve'); ok.id = 'pageApiApprove'
    const no = el('button', 'ghost', 'Reject'); no.id = 'pageApiReject'
    row.appendChild(ok); row.appendChild(no); c.appendChild(row)
    m.appendChild(c); doc.body.appendChild(m)
    ok.onclick = () => { m.remove(); resolve(true) }
    no.onclick = () => { m.remove(); resolve(false) }
  })
}
