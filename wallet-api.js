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

export const CHANNEL = 'sequentia-wallet'
export const NOT_DEVELOPER = 'leaves are a developer-mode rail: turn developer mode on in the wallet’s Settings'
export const NOT_JOINED = 'this wallet has not joined a leaf operator: join one in the wallet’s Leaves tab'
export const METHODS = ['getCapabilities', 'getWalletMode', 'getLeafBalances', 'getLeafAddress', 'requestLeafReceive',
  'sendLeaves', 'boardLeaves', 'exitLeaf']
export const EVENTS = ['modeChanged', 'leafArrived', 'leafSyncDue']
export const PROVIDER = 'sequentia-web-wallet'
// What a site of this origin may ask over the channel (docs/PAGE_API.md).
export const SITE_METHODS = ['getCapabilities', 'getWalletMode', 'connect', 'getAccounts', 'getBalances', 'placeOrder', 'getOrders', 'cancelOrder']
const siteName = (page) => (/\/dex\//.test(page) ? 'SeqDEX' : 'This site')

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
//               answer, orders (site-orders.js makeSiteOrders), attention() (bring this page forward) }
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
      case 'getCapabilities':
        return { provider: PROVIDER, methods: SITE_METHODS, events: ['accountsChanged', 'modeChanged'], features: ['orders', 'balances-total'] }
      case 'getWalletMode':
        return { mode: leaves.mode() }
      case 'getAccounts':
        return { accounts: isConnected() && site.unlocked() ? [site.account()] : [] }
      case 'connect':
        if (!site.unlocked()) throw new Error('the wallet is locked; unlock it in its own page first')
        if (isConnected()) return site.account()
        return oneAtATime(async () => {
          site.attention && site.attention()
          await approved({ title: 'Connect ' + siteName(pageKey) + '?', text: siteName(pageKey) + ' wants to see your address and balances, and to ask you to trade. Each trade is shown here for you to approve.', rows: [['Site', pageKey]] })
          connected.add(pageKey)
          return site.account()
        })
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
      default:
        throw new Error('unknown method: ' + method)
    }
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
