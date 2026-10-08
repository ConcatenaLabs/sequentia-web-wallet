// LEAVES: the wallet's developer mode for coins held as leaves of an operator's tree.
//
// Developer mode is one setting, off by default. When it is on, the Leaves tab shows
// every rail side by side and lets each step be taken by hand: the balance per rail
// (on-chain, leaves, Lightning) for every asset, boarding an on-chain coin into the
// operator's tree, a receive request and a payment to one, the mailbox (read by sync),
// "settle now" (a refresh into the next round, followed to its new leaf), and the exit
// drill (one leaf taken on-chain by the wallet alone, every step and fee shown, until
// its claim is final). Every leaf shows its dates and the schedule sync keeps for it,
// and the wallet syncs by itself on that schedule while the page is open.
//
// Nothing about a leaf is computed here. The operator wallet library runs in a
// dedicated worker (leaves/worker.js, its wasm in leaves/pkg): every script, record,
// check, store write, fee and refusal is the library's. This module asks it, shows what
// it answers, and shows every refusal in the library's own words.
//
// Everything outside the worker is injected, so the module runs under Node with a fake
// worker (leaves.test.mjs).
//
// ctx:
//   makeWorker()        -> a Worker-like object (postMessage, onmessage, onerror)
//   store               localStorage-alike
//   mnemonic()          the wallet's phrase
//   el(tag, cls, text)  builds a node; text is set as text, never markup
//   assetMeta(hex)      -> { ticker, precision }
//   fmtAtoms(atoms, precision) -> a decimal string
//   refValueStr(key, atoms) -> '≈ $1.23' or ''   (key 'BTC' or an asset hex)
//   btcOnchain()        -> BigInt sats on the Bitcoin side
//   lnFor(kind)         -> BigInt atoms on Lightning ('BTC' or an asset hex)
//   onChange()          called when leaf balances change (the Balance tab re-renders)
//   now()               optional clock, ms
//   tickMs              optional: how often the schedule is read (default 60 s)

export const DEV_MODE_KEY = 'swk.devMode'
export const NODE_PASSWORD_KEY = 'swk.leaves.nodePassword'
export const TICK_MS = 60_000

export function devModeOn (store) {
  try { return store.getItem(DEV_MODE_KEY) === '1' } catch { return false }
}

export function setDevMode (store, on) {
  try { if (on) store.setItem(DEV_MODE_KEY, '1'); else store.removeItem(DEV_MODE_KEY) } catch {}
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

// A refusal from the library: its kind, and its message in its own words.
export class LeafError extends Error {
  constructor (e) {
    super(e && e.message ? e.message : String(e))
    this.kind = (e && e.kind) || 'error'
    this.code = e && e.code
    this.status = e && e.status
  }
}

export class LeafClient {
  constructor (makeWorker) {
    this.worker = makeWorker()
    this.next = 1
    this.pending = new Map()
    this.worker.onmessage = (ev) => {
      const m = ev.data || {}
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.ok(m.value); else p.no(new LeafError(m.error))
    }
    this.worker.onerror = (ev) => {
      const err = new LeafError({ kind: 'worker', message: 'the leaf wallet could not start: ' + ((ev && ev.message) || 'the worker failed') })
      for (const p of this.pending.values()) p.no(err)
      this.pending.clear()
      this.failed = err
    }
  }

  call (op, args = {}) {
    if (this.failed) return Promise.reject(this.failed)
    const id = this.next++
    return new Promise((ok, no) => {
      this.pending.set(id, { ok, no })
      this.worker.postMessage({ id, op, args })
    })
  }

  exists (mnemonic) { return this.call('exists', { mnemonic }) }
  create (mnemonic, config) { return this.call('create', { mnemonic, config }) }
  open (mnemonic, nodePassword) { return this.call('open', { mnemonic, nodePassword }) }
  // -> { result, start }
  run (command, args = {}) { return this.call('run', { command, args }) }
}

// ---------------------------------------------------------------------------
// What the library's answers mean for the screens (pure; tested)
// ---------------------------------------------------------------------------

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The library's balance: per asset, leaf atoms by state, and on-chain atoms.
// -> Map(asset -> { leaves, states: { state: BigInt }, onchain })
export function leafBalances (balance) {
  const out = new Map()
  const row = (a) => { if (!out.has(a)) out.set(a, { leaves: 0n, states: {}, onchain: 0n }); return out.get(a) }
  for (const [a, states] of Object.entries((balance && balance.arca) || {})) {
    const r = row(a)
    for (const [s, v] of Object.entries(states || {})) { r.states[s] = (r.states[s] || 0n) + big(v); r.leaves += big(v) }
  }
  for (const [a, v] of Object.entries((balance && balance.sequentia_onchain) || {})) row(a).onchain += big(v)
  return out
}

// The rails table: BTC first and always (it is the other chain, and a tree on this
// chain holds none), then every Sequentia asset held on any rail, in ticker order.
export function railRows ({ balances, btcOnchain = 0n, lnFor = () => 0n, tickerOf = (h) => h, lnAssets = [] }) {
  const rows = [{ kind: 'BTC', onchain: big(btcOnchain), leaves: null, states: {}, lightning: big(lnFor('BTC')) }]
  const keys = new Set([...balances.keys(), ...lnAssets])
  const seq = []
  for (const h of keys) {
    const b = balances.get(h) || { leaves: 0n, states: {}, onchain: 0n }
    const lightning = big(lnFor(h))
    if (b.leaves + b.onchain + lightning <= 0n) continue
    seq.push({ kind: h, onchain: b.onchain, leaves: b.leaves, states: b.states, lightning })
  }
  seq.sort((x, y) => String(tickerOf(x.kind)).localeCompare(String(tickerOf(y.kind))))
  return rows.concat(seq)
}

// States in which a coin is still the wallet's business.
const HELD = new Set(['pending', 'live', 'offered', 'sending', 'given', 'forfeited', 'exiting'])
export function heldCoins (coins) { return (coins || []).filter((c) => HELD.has(c.state)) }

// Whether something is moving that sync must follow now, whatever the schedule says:
// a coin pending, being sent, given to a participation, under a forfeit or on its way
// out, or a participation not yet done.
const DONE_PARTICIPATION = new Set(['released', 'void', 'expired', 'refused'])
export function inFlight (coins, participations) {
  if ((coins || []).some((c) => ['pending', 'sending', 'given', 'forfeited', 'exiting'].includes(c.state))) return true
  return (participations || []).some((p) => !DONE_PARTICIPATION.has(p.state) && !p.released)
}

// When the page next asks: the schedule's own time when it is near, otherwise the
// next tick. A schedule that is due is due now.
export function nextAskMs (schedule, tickMs = TICK_MS) {
  if (!schedule) return tickMs
  if (schedule.due) return 0
  const next = schedule.next_sync_at
  const now = schedule.now
  if (typeof next !== 'number' || typeof now !== 'number') return tickMs
  return Math.max(0, Math.min(tickMs, (next - now) * 1000))
}

// A median time for people: the UTC date and how far it is from the chain's now.
export function when (t, now) {
  if (typeof t !== 'number') return '—'
  const iso = new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  if (typeof now !== 'number') return iso
  const d = t - now
  const abs = Math.abs(d)
  const span = abs >= 86400 ? `${Math.floor(abs / 86400)} d ${Math.floor((abs % 86400) / 3600)} h`
    : abs >= 3600 ? `${Math.floor(abs / 3600)} h ${Math.floor((abs % 3600) / 60)} min`
      : `${Math.floor(abs / 60)} min`
  return `${iso} (${d >= 0 ? 'in ' + span : span + ' ago'})`
}

// The steps of one exit answer, for the drill's log.
export function exitSteps (answer) {
  return ((answer && answer.broadcast) || []).map((s) => ({
    txid: s.txid,
    what: s.step || s.kind || s.what || '',
    vsize: s.vsize,
    fees: (Array.isArray(s.fee) ? s.fee : (s.fee ? [s.fee] : [])).map((f) => ({ asset: f.asset, amount: String(f.amount ?? '') })),
  }))
}

// ---------------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------------

export function mountLeaves (ctx, root, settingsRoot) {
  const { el } = ctx
  const now = ctx.now || (() => Date.now())
  const tickMs = ctx.tickMs || TICK_MS
  const S = { client: null, open: false, busy: false, balance: null, coins: [], participations: [], schedule: null,
    refusals: [], last: null, drill: null, quote: null, timer: null, showHistory: false, error: null, info: null, form: {} }
  // What is typed into a form survives a re-render (sync re-renders the panels by itself).
  const bind = (node) => {
    if (S.form[node.id] != null) node.value = S.form[node.id]
    const keep = () => { S.form[node.id] = node.value }
    node.addEventListener('input', keep); node.addEventListener('change', keep)
    return node
  }
  const val = (id) => String(S.form[id] ?? '').trim()

  const tick = (h) => { try { return ctx.assetMeta(h).ticker || h.slice(0, 8) } catch { return h.slice(0, 8) } }
  const prec = (h) => { try { return ctx.assetMeta(h).precision ?? 0 } catch { return 0 } }
  const amt = (h, atoms) => {
    const a = big(atoms)
    const ref = ctx.refValueStr ? ctx.refValueStr(h, a) : ''
    return `${ctx.fmtAtoms(a, prec(h))} ${tick(h)} (${a} atoms)${ref ? ' ' + ref : ''}`
  }
  const short = (s) => (s && s.length > 20) ? s.slice(0, 10) + '…' + s.slice(-6) : (s || '')
  const kv = (k, v) => { const r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); const s = el('span', 'v mono-inline'); if (v && typeof v === 'object' && v.nodeType) s.appendChild(v); else s.textContent = String(v ?? ''); r.appendChild(s); return r }
  const card = (title) => { const c = el('div', 'card'); c.appendChild(el('label', 'lbl', title)); return c }
  const button = (text, onclick, cls) => { const b = el('button', cls || '', text); b.onclick = onclick; return b }
  const errBox = (e) => {
    const box = el('div', 'status err leaf-refusal')
    box.textContent = e.message
    if (e.kind || e.code) box.appendChild(el('div', 'sub', [e.kind, e.code, e.status].filter(Boolean).join(' · ')))
    return box
  }

  // ---- talking to the library ----
  // One action at a time: a click while sync runs waits for it rather than being lost.
  async function act (what, f) {
    S.queued = (S.queued || 0) + 1
    if (S.busy) render()
    while (S.busy) await new Promise((r) => setTimeout(r, 100))
    S.queued--
    S.busy = true; S.error = null; render()
    try {
      const v = await f()
      S.last = { what, value: v }
      return v
    } catch (e) {
      S.error = { what, e }
      throw e
    } finally {
      try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e }
      S.busy = false
      render()
    }
  }

  async function run (command, args) {
    const v = await S.client.run(command, args)
    if (v && v.start && v.start.witness && v.start.witness.error) S.startNote = v.start.witness.error.message
    else if (v && v.start && v.start.recheck && v.start.recheck.error) S.startNote = v.start.recheck.error.message
    else S.startNote = null
    if (v && v.start && v.start.recheck && Array.isArray(v.start.recheck.changes) && v.start.recheck.changes.length) S.recheckNote = v.start.recheck
    return v.result
  }

  async function reload () {
    if (!S.open) return
    const [b, c, p, s, r] = [await run('balance'), await run('coins'), await run('participations'), await run('schedule'), await run('refusals')]
    S.balance = b; S.coins = c || []; S.participations = p || []; S.schedule = s; S.refusals = r || []
    if (ctx.onChange) try { ctx.onChange() } catch {}
  }

  async function start () {
    if (!S.client) S.client = new LeafClient(ctx.makeWorker)
    const m = ctx.mnemonic()
    const has = await S.client.exists(m)
    if (!has) { S.open = false; render(); return }
    let pw = null; try { pw = ctx.store.getItem(NODE_PASSWORD_KEY) } catch {}
    await S.client.open(m, pw || undefined)
    S.open = true
    S.info = await run('info')
    await reload()
    schedule()
  }

  // ---- the schedule: sync by itself while the page is open ----
  function schedule () {
    clearTimeout(S.timer)
    if (!S.open) return
    const wait = inFlight(S.coins, S.participations) ? Math.min(tickMs, 30_000) : nextAskMs(S.schedule, tickMs)
    S.nextAsk = now() + wait
    S.timer = setTimeout(autoSync, wait)
    render()
  }

  async function autoSync () {
    if (!S.open) return
    if (S.busy) { S.timer = setTimeout(autoSync, 5000); return }
    try {
      const s = await run('schedule')
      S.schedule = s
      if ((s.due || inFlight(S.coins, S.participations)) && !S.busy) {
        S.busy = true; render()
        try {
          const v = await run('sync')
          S.lastSync = { at: now(), value: v, auto: true }
        } catch (e) { S.lastSync = { at: now(), error: e, auto: true } }
        try { await reload(); S.reloadError = null } catch (e) { S.reloadError = e } finally { S.busy = false }
      }
    } catch (e) { S.lastSync = { at: now(), error: e, auto: true } }
    schedule()
  }

  async function syncNow () {
    try {
      await act('sync', async () => {
        try {
          const v = await run('sync')
          S.lastSync = { at: now(), value: v, auto: false }
          return v
        } catch (e) { S.lastSync = { at: now(), error: e, auto: false }; throw e }
      })
    } catch {}
    schedule()
  }

  // ---- render ----
  function render () {
    if (settingsRoot) renderSettings()
    if (!root) return
    root.innerHTML = ''
    if (!devModeOn(ctx.store)) {
      root.appendChild(el('div', 'muted', 'Developer mode is off. Turn it on in Settings to work with leaves.'))
      return
    }
    if (!S.open) { renderJoin(); return }
    if (S.busy || S.queued) root.appendChild(el('div', 'status leaf-busy', 'Working…'))
    if (S.error) { const c = card('Refused: ' + S.error.what); c.appendChild(errBox(S.error.e)); root.appendChild(c) }
    if (S.reloadError) { const c = card('Could not read the wallet'); c.appendChild(errBox(S.reloadError)); root.appendChild(c) }
    if (S.startNote) { const c = card('At the start of the last command'); c.appendChild(el('div', 'warn', S.startNote)); root.appendChild(c) }
    renderRails(); renderBoard(); renderReceive(); renderSend(); renderSync(); renderCoins(); renderDrill(); renderParticipations(); renderRefusals()
  }

  function renderJoin () {
    const c = card('Join an operator')
    c.id = 'leafJoin'
    c.appendChild(el('p', 'sub', 'The wallet keeps leaves against one operator. It pins the operator\'s key and the node\'s chain when it joins, and refuses any server that names another. The node must validate its anchors (-validateanchor) and keep a transaction index (-txindex).'))
    const f = (id, label, ph, type) => { const d = el('div', 'field'); d.appendChild(el('label', 'lbl', label)); const i = el('input'); i.id = id; i.placeholder = ph || ''; if (type) i.type = type; bind(i); d.appendChild(i); c.appendChild(d); return i }
    f('leafServer', 'Operator server URL', 'https://…/operator')
    f('leafNodeUrl', 'Node JSON-RPC URL', 'https://…/node')
    f('leafNodeUser', 'Node RPC user (optional)', '')
    f('leafNodePassword', 'Node RPC password (optional)', '', 'password')
    f('leafDelay', 'Exit delay asked, in 512-second units (optional)', 'the library\'s default: 36 hours')
    f('leafMinDelay', 'Least exit delay accepted, in 512-second units (optional)', 'the library\'s default: 36 hours')
    const go = button('Join', async () => {
      const v = val
      const config = { server: v('leafServer'), node_url: v('leafNodeUrl') }
      if (v('leafNodeUser')) config.node_user = v('leafNodeUser')
      if (v('leafNodePassword')) config.node_password = v('leafNodePassword')
      if (v('leafDelay')) config.exit_delay_units = v('leafDelay')
      if (v('leafMinDelay')) config.min_exit_delay_units = v('leafMinDelay')
      try {
        await act('join', async () => {
          if (!S.client) S.client = new LeafClient(ctx.makeWorker)
          const info = await S.client.create(ctx.mnemonic(), config)
          try { if (config.node_password) ctx.store.setItem(NODE_PASSWORD_KEY, config.node_password); else ctx.store.removeItem(NODE_PASSWORD_KEY) } catch {}
          S.open = true
          S.joined = info.result
          S.info = info.result
          return info
        })
        schedule()
      } catch {}
    }, 'primary')
    go.id = 'btnLeafJoin'
    const row = el('div', 'row'); row.style.marginTop = '12px'; row.appendChild(go); c.appendChild(row)
    if (S.error) c.appendChild(errBox(S.error.e))
    root.appendChild(c)
  }

  function renderRails () {
    const c = card('Balances per rail')
    c.id = 'leafRails'
    if (S.joined) {
      c.appendChild(el('div', 'warn', `Compare the operator key ${S.joined.operator} with the one the operator publishes through a channel you trust: the wallet has pinned it, and refuses any server that names another.`))
    }
    const balances = leafBalances(S.balance)
    let lnAssets = []; try { lnAssets = ctx.lnAssets ? ctx.lnAssets() : [] } catch {}
    const rows = railRows({ balances, btcOnchain: ctx.btcOnchain(), lnFor: ctx.lnFor, tickerOf: tick, lnAssets })
    const t = el('table', 'leaf-rails')
    const head = el('tr'); for (const h of ['Asset', 'On-chain', 'Leaves', 'Lightning']) head.appendChild(el('th', null, h)); t.appendChild(head)
    for (const r of rows) {
      const tr = el('tr'); tr.dataset.asset = r.kind
      const key = r.kind
      const fmt = (v) => key === 'BTC' ? `${ctx.fmtAtoms(v, 8)} BTC (${v} sat)` : amt(key, v)
      tr.appendChild(el('td', null, key === 'BTC' ? 'BTC' : tick(key)))
      tr.appendChild(el('td', 'leaf-onchain', fmt(r.onchain)))
      const lt = el('td', 'leaf-leaves')
      if (r.leaves === null) lt.textContent = 'none: a tree on Sequentia holds no BTC'
      else {
        lt.appendChild(el('div', null, fmt(r.leaves)))
        for (const [s, v] of Object.entries(r.states)) lt.appendChild(el('div', 'sub', `${s}: ${v} atoms`))
      }
      tr.appendChild(lt)
      tr.appendChild(el('td', 'leaf-ln', fmt(r.lightning)))
      t.appendChild(tr)
    }
    c.appendChild(t)
    c.appendChild(el('p', 'sub', 'On-chain is what the leaf wallet reads from its node. A coin received out of round and not yet refreshed is operator-confirmed: it relies on the operator and its sender not colluding until a round settles it. A round is final once its block is certified and its Bitcoin anchor is buried two blocks.'))
    root.appendChild(c)
  }

  function assetSelect (id, assets, emptyLabel) {
    const s = el('select'); s.id = id
    if (emptyLabel != null) { const o = el('option', null, emptyLabel); o.value = ''; s.appendChild(o) }
    for (const a of assets) { const o = el('option', null, `${tick(a)} · ${short(a)}`); o.value = a; s.appendChild(o) }
    bind(s)
    if (S.form[id] == null) S.form[id] = s.value
    return s
  }

  function field (c, label, node) { const d = el('div', 'field'); d.appendChild(el('label', 'lbl', label)); d.appendChild(node); c.appendChild(d); return node }

  function resultBox (what) {
    if (!S.last || S.last.what !== what) return null
    const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(S.last.value, null, 1); return pre
  }

  function renderBoard () {
    const c = card('Board')
    c.id = 'leafBoard'
    c.appendChild(el('p', 'sub', 'Brings an on-chain coin into the operator\'s tree. The operator registers the board before it is broadcast, so a refused board spends nothing; the coin is spendable once the board is final. The fee is paid in the asset boarded unless another is named.'))
    const onchain = [...leafBalances(S.balance).entries()].filter(([, v]) => v.onchain > 0n).map(([a]) => a)
    const all = [...new Set([...onchain, ...leafBalances(S.balance).keys()])]
    field(c, 'Asset', assetSelect('leafBoardAsset', onchain))
    const a = el('input'); a.id = 'leafBoardAmount'; field(c, 'Amount, in atoms', bind(a))
    field(c, 'Fee asset', assetSelect('leafBoardFee', all, 'the asset boarded'))
    const b = button('Board', () => {
      const args = { asset: val('leafBoardAsset'), amount: val('leafBoardAmount'), fee_asset: val('leafBoardFee') || null }
      act('board', () => run('board', args)).catch(() => {})
    }, 'primary')
    b.id = 'btnLeafBoard'; b.disabled = S.busy
    const ad = button('Show an on-chain address', () => act('address', () => run('address')).catch(() => {}), 'ghost')
    ad.id = 'btnLeafAddress'; ad.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); r.appendChild(ad); c.appendChild(r)
    if (S.last && S.last.what === 'address') {
      const a2 = el('div', 'mono'); a2.id = 'leafAddress'; a2.textContent = S.last.value.address || ''
      a2.dataset.script = S.last.value.script_pubkey || ''
      c.appendChild(el('div', 'sub', 'An address of this wallet on the leaf wallet\'s chain, the same key as the wallet\'s own addresses: pay it to have a coin to board, or a fee coin for an exit.'))
      c.appendChild(a2)
    }
    const out = resultBox('board'); if (out) c.appendChild(out)
    root.appendChild(c)
  }

  function renderReceive () {
    const c = card('Receive')
    c.id = 'leafReceive'
    c.appendChild(el('p', 'sub', 'A single-use receive request: a fresh key, this wallet\'s mailbox and the exit delay asked for. The payment arrives in the mailbox, which sync reads.'))
    const assets = [...leafBalances(S.balance).keys()]
    field(c, 'Asset (optional)', assetSelect('leafRecvAsset', assets, 'any'))
    const a = el('input'); a.id = 'leafRecvAmount'; field(c, 'Amount, in atoms (optional)', bind(a))
    const b = button('Make a receive request', () => {
      const args = { asset: val('leafRecvAsset') || null, amount: val('leafRecvAmount') || null }
      act('receive', () => run('receive', args)).catch(() => {})
    })
    b.id = 'btnLeafReceive'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    if (S.last && S.last.what === 'receive') {
      const t = el('textarea', 'mono'); t.id = 'leafRequest'; t.rows = 4; t.readOnly = true; t.value = S.last.value.request || ''
      c.appendChild(t)
    }
    root.appendChild(c)
  }

  function renderSend () {
    const c = card('Send to a receive request')
    c.id = 'leafSend'
    c.appendChild(el('p', 'sub', 'Pays a receive request out of round: coins of the asset, those furthest from their exit date first, each into a checkpoint, then the reassignment into the receiver\'s leaf and the change. No asset is a default.'))
    const t = el('textarea', 'mono'); t.id = 'leafSendRequest'; t.rows = 3; field(c, 'Receive request', bind(t))
    const assets = [...leafBalances(S.balance).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a)
    field(c, 'Asset', assetSelect('leafSendAsset', assets, 'the request\'s'))
    const a = el('input'); a.id = 'leafSendAmount'; field(c, 'Amount, in atoms', bind(a))
    const b = button('Send', () => {
      const args = { request: val('leafSendRequest'), amount: val('leafSendAmount') || null, asset: val('leafSendAsset') || null }
      act('send', () => run('send', args)).catch(() => {})
    }, 'primary')
    b.id = 'btnLeafSend'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    const out = resultBox('send'); if (out) c.appendChild(out)
    root.appendChild(c)
  }

  function renderSync () {
    const c = card('Sync and schedule')
    c.id = 'leafSync'
    const s = S.schedule || {}
    c.dataset.now = String(s.now ?? ''); c.dataset.next = String(s.next_sync_at ?? ''); c.dataset.due = String(!!s.due)
    if (S.lastSync) { c.dataset.lastSyncAt = String(S.lastSync.at); c.dataset.lastSyncAuto = String(!!S.lastSync.auto) }
    c.appendChild(kv('Chain time (median)', when(s.now)))
    c.appendChild(kv('Next sync the schedule asks for', s.next_sync_at == null ? 'none: nothing held off the chain, nothing awaited' : when(s.next_sync_at, s.now)))
    c.appendChild(kv('Due now', s.due ? 'yes' : 'no'))
    if (s.why) c.appendChild(kv('Why', s.why))
    if (S.nextAsk) c.appendChild(kv('This page asks again', new Date(S.nextAsk).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')))
    for (const rq of s.receive_requests || []) {
      c.appendChild(kv('Receive request ' + short(rq.owner || ''), `${rq.state}; handed out ${when(rq.asked_at, s.now)}; ${rq.state === 'lapsed' ? 'lapsed ' + when(rq.lapsed_at, s.now) : 'lapses ' + when(rq.lapses_at, s.now)}`))
    }
    const b = button('Sync now', () => syncNow()); b.id = 'btnLeafSync'; b.disabled = S.busy
    const r = el('div', 'row'); r.style.marginTop = '12px'; r.appendChild(b); c.appendChild(r)
    if (S.lastSync) {
      const ls = S.lastSync
      c.appendChild(el('div', 'sub', `Last sync: ${new Date(ls.at).toISOString()} (${ls.auto ? 'by itself, on the schedule' : 'asked here'})`))
      if (ls.error) c.appendChild(errBox(ls.error))
      else {
        const v = ls.value || {}
        const mb = v.mailbox || {}
        const sum = el('div', 'leaf-sync-summary')
        sum.appendChild(el('div', null, `Mailbox: ${(mb.accepted || []).length} accepted, ${(mb.refused || []).length} refused, ${(mb.waiting || []).length} waiting`))
        for (const a of mb.accepted || []) sum.appendChild(el('div', 'sub', `accepted ${short(a.leaf_id)}: ${amt(a.asset, a.value)}, ${a.state}${a.note ? '; ' + a.note : ''}`))
        for (const a of mb.refused || []) sum.appendChild(el('div', 'sub leaf-refusal', `refused: ${a.reason || JSON.stringify(a)}`))
        for (const p of v.participations || []) sum.appendChild(el('div', 'sub', `participation ${short(p.participation)}: ${p.state}${p.note ? '; ' + p.note : ''}`))
        for (const e of v.exits || []) sum.appendChild(el('div', 'sub', `exit ${short(e.leaf_id)}: ${e.state}${e.next ? '; ' + e.next : ''}${e.error ? '; ' + e.error : ''}`))
        c.appendChild(sum)
        const pre = el('pre', 'mono leaf-result'); pre.textContent = JSON.stringify(v, null, 1)
        const d = el('details'); d.appendChild(el('summary', 'sub', 'What sync answered')); d.appendChild(pre); c.appendChild(d)
      }
    }
    root.appendChild(c)
  }

  async function settle (leaves) {
    try {
      const q = await act('quote', () => run('quote', { leaves }))
      S.quote = { leaves, coins: q.coins }
      render()
    } catch {}
  }

  async function confirmSettle () {
    const q = S.quote
    if (!q) return
    try {
      await act('participate', () => run('participate', { leaves: q.leaves, shown: q.coins }))
      S.quote = null
    } catch {}
    schedule()
  }

  async function drill (leafId, feeAsset) {
    S.drill = S.drill && S.drill.leaf === leafId ? S.drill : { leaf: leafId, runs: [] }
    try {
      const v = await act('exit', () => run('exit', { leaf_id: leafId, fee_asset: feeAsset || null }))
      S.drill.runs.push({ at: now(), value: v })
    } catch (e) { S.drill.runs.push({ at: now(), error: e }) }
    schedule()
    render()
  }

  function coinCard (co, s) {
    const d = el('div', 'leaf-coin'); d.dataset.leaf = co.leaf_id; d.dataset.state = co.state
    d.dataset.kind = co.kind || ''; d.dataset.asset = co.asset || ''; d.dataset.value = String(co.value ?? '')
    if (co.standing) d.dataset.standing = co.standing
    for (const k of ['expiry', 'exit_deadline', 'sync_daily_from', 'refresh_from', 'home_from', 'exit_by']) if (co[k] != null) d.dataset[k.replace(/_(\w)/g, (_, x) => x.toUpperCase())] = String(co[k])
    const head = el('div', 'arow-head')
    head.appendChild(el('span', 'tk', tick(co.asset)))
    head.appendChild(el('span', 'grow mono-inline', short(co.leaf_id)))
    head.appendChild(el('span', 'amt', amt(co.asset, co.value)))
    d.appendChild(head)
    d.appendChild(kv('State', co.standing && co.standing !== co.state ? `${co.state} (${co.standing})` : co.state))
    d.appendChild(kv('Kind', co.kind + (co.rests_on_board ? ', rests on a board' : '')))
    d.appendChild(kv('Expiry', when(co.expiry, s.now)))
    d.appendChild(kv('Exit deadline', when(co.exit_deadline, s.now)))
    for (const [k, label] of [['sync_daily_from', 'Synced daily from'], ['refresh_from', 'Refreshed from (the free window)'], ['home_from', 'Taken home from'], ['exit_by', 'Exit by']]) {
      if (co[k] != null) d.appendChild(kv(label, when(co[k], s.now)))
    }
    if (co.exit_fee) d.appendChild(kv('Exit fee coin', [co.exit_fee.fee_coin, co.exit_fee.note].filter(Boolean).join(': ')))
    if (co.note) d.appendChild(el('div', 'sub', co.note))
    if (co.spent_by) d.appendChild(kv('Spent by', co.spent_by))
    if (HELD.has(co.state) && co.state !== 'exiting') {
      const r = el('div', 'row'); r.style.marginTop = '8px'
      const st = button('Settle now', () => settle([co.leaf_id])); st.dataset.action = 'settle'; st.disabled = S.busy || co.state !== 'live'
      const ex = button('Exit drill', () => drill(co.leaf_id)); ex.dataset.action = 'exit'; ex.disabled = S.busy
      ex.className = 'danger'
      r.appendChild(st); r.appendChild(ex); d.appendChild(r)
    }
    return d
  }

  function renderCoins () {
    const c = card('Leaves and their dates')
    c.id = 'leafCoins'
    const s = S.schedule || {}
    const held = heldCoins(S.coins)
    if (!held.length) c.appendChild(el('div', 'muted', 'No leaves held.'))
    for (const co of held) c.appendChild(coinCard(co, s))
    if (S.quote) {
      const q = el('div', 'warn leaf-quote')
      q.id = 'leafQuote'
      q.appendChild(el('div', null, 'Settle now: each coin is given up for one new leaf in the next round, under a fresh key. The operator\'s fee, coin by coin, before anything is signed:'))
      for (const qc of S.quote.coins || []) q.appendChild(el('div', 'sub', `${short(qc.leaf_id)}: fee ${amt(qc.asset, qc.fee)}, ${qc.ppm} ppm of ${qc.value} (the wallet's bound ${qc.bound_ppm} ppm)`))
      const r = el('div', 'row'); r.style.marginTop = '8px'
      const ok = button('Sign and hand over', () => confirmSettle(), 'primary'); ok.id = 'btnLeafSettleConfirm'
      const no = button('Cancel', () => { S.quote = null; render() }, 'ghost')
      r.appendChild(ok); r.appendChild(no); q.appendChild(r)
      c.appendChild(q)
    }
    const others = (S.coins || []).filter((x) => !HELD.has(x.state))
    if (others.length) {
      const d = el('details'); d.appendChild(el('summary', 'sub', `${others.length} coin(s) no longer held (spent, exited, lost)`))
      for (const co of others) d.appendChild(coinCard(co, s))
      c.appendChild(d)
    }
    root.appendChild(c)
  }

  function renderDrill () {
    if (!S.drill) return
    const c = card('Exit drill')
    c.id = 'leafDrill'
    const coin = (S.coins || []).find((x) => x.leaf_id === S.drill.leaf)
    c.appendChild(el('p', 'sub', 'The leaf is taken on-chain from its record alone, without the operator: each node of its path, then, once the exit delay has run, the claim to one of this wallet\'s addresses. Each run goes as far as the chain allows; run it again, or let sync move it on, until the claim is final.'))
    c.appendChild(kv('Leaf', S.drill.leaf))
    c.appendChild(kv('Its state now', coin ? coin.state : 'unknown'))
    if (coin && coin.state === 'exited') c.appendChild(el('div', 'status ok leaf-final', 'The claim is final: the coin is on-chain, in this wallet.'))
    S.drill.runs.forEach((r, i) => {
      const d = el('div', 'leaf-drill-run'); d.dataset.run = String(i)
      if (r.error) { d.appendChild(el('div', null, `Run ${i + 1}: refused`)); d.appendChild(errBox(r.error)) } else {
        const v = r.value || {}
        d.appendChild(el('div', null, `Run ${i + 1}: ${v.state}`))
        for (const st of exitSteps(v)) d.appendChild(el('div', 'sub', `broadcast ${st.what ? st.what + ' ' : ''}${short(st.txid)}, ${st.vsize} vB, fee ${st.fees.map((f) => amt(f.asset, f.amount)).join(' + ') || 'none'}`))
        if (v.claim) d.appendChild(el('div', 'sub', `claim ${typeof v.claim === 'string' ? v.claim : v.claim.txid}`))
        if (v.next) d.appendChild(el('div', 'sub', 'next: ' + v.next))
        if (v.error) d.appendChild(el('div', 'sub leaf-refusal', v.error))
        if (v.note) d.appendChild(el('div', 'sub', v.note))
      }
      c.appendChild(d)
    })
    if (!coin || coin.state !== 'exited') {
      const b = button('Run the exit again', () => drill(S.drill.leaf)); b.id = 'btnLeafExitAgain'; b.disabled = S.busy
      const r = el('div', 'row'); r.style.marginTop = '8px'; r.appendChild(b); c.appendChild(r)
    }
    root.appendChild(c)
  }

  function renderParticipations () {
    const c = card('Participations')
    c.id = 'leafParticipations'
    if (!(S.participations || []).length) c.appendChild(el('div', 'muted', 'None.'))
    for (const p of S.participations || []) {
      const d = el('div', 'leaf-participation'); d.dataset.state = p.state
      d.appendChild(kv('Participation', short(p.participation)))
      d.appendChild(kv('State', p.state + (p.released && p.state !== 'released' ? ', released' : '')))
      if (p.round) d.appendChild(kv('Round', p.round))
      for (const g of p.gives || []) d.appendChild(el('div', 'sub', `gives ${short(g.leaf_id)} (${g.state})`))
      for (const n of p.new_leaves || []) d.appendChild(el('div', 'sub', `new leaf ${n.leaf_id ? short(n.leaf_id) : 'not yet held'}: ${amt(n.asset, n.value)}${n.state ? ' (' + n.state + ')' : ''}`))
      c.appendChild(d)
    }
    root.appendChild(c)
  }

  function renderRefusals () {
    const c = card('Refusals')
    c.id = 'leafRefusals'
    c.appendChild(el('p', 'sub', 'Every refusal the leaf wallet made, in its own words.'))
    const list = Array.isArray(S.refusals) ? S.refusals : (S.refusals && S.refusals.refusals) || []
    if (!list.length) c.appendChild(el('div', 'muted', 'None.'))
    for (const r of list.slice(-50).reverse()) c.appendChild(el('div', 'sub leaf-refusal', `${r.at ? new Date((r.at > 1e12 ? r.at : r.at * 1000)).toISOString() + ' ' : ''}${r.what ? r.what + ': ' : ''}${r.reason || r.message || JSON.stringify(r)}`))
    root.appendChild(c)
  }

  function renderSettings () {
    settingsRoot.innerHTML = ''
    const c = card('Developer mode')
    c.appendChild(el('p', 'sub', 'Shows every rail and every step by hand: the balance per rail, coins held as leaves of an operator\'s tree, boarding, receive requests, payments, settle now and the exit drill. Off by default.'))
    const lab = el('label', 'row'); lab.style.gap = '8px'
    const cb = el('input'); cb.type = 'checkbox'; cb.id = 'devModeToggle'; cb.style.width = 'auto'; cb.checked = devModeOn(ctx.store)
    cb.onchange = async () => {
      setDevMode(ctx.store, cb.checked)
      if (ctx.onModeChange) try { ctx.onModeChange(cb.checked) } catch {}
      if (cb.checked) { try { await start() } catch (e) { S.error = { what: 'open', e } } } else { clearTimeout(S.timer) }
      render()
    }
    lab.appendChild(cb); lab.appendChild(el('span', null, 'Developer mode'))
    c.appendChild(lab)
    if (S.open && S.info) {
      c.appendChild(kv('Operator server', S.info.server))
      c.appendChild(kv('Operator key (pinned)', S.info.operator))
      c.appendChild(kv('Node', S.info.node))
      c.appendChild(kv('Chain', `${S.info.chain} · ${short(S.info.genesis_hash)}`))
      c.appendChild(kv('Mailbox key', S.info.mailbox_key))
      if (S.info.keepers && S.info.keepers.note) c.appendChild(el('div', 'sub', S.info.keepers.note))
    }
    settingsRoot.appendChild(c)
  }

  const api = {
    state: S,
    render,
    start: async () => { try { await start() } catch (e) { S.error = { what: 'open', e }; render() } },
    // Leaf atoms of an asset, for the Balance tab's rows and headline total.
    leafAtoms: (hex) => { const b = leafBalances(S.balance).get(hex); return b ? b.leaves : 0n },
    leafAssets: () => [...leafBalances(S.balance).entries()].filter(([, v]) => v.leaves > 0n).map(([a]) => a),
    syncNow,
    stop: () => clearTimeout(S.timer),
  }
  render()
  return api
}
