// The composer's Ark rail (developer mode).
//
// In developer mode, with the wallet's Bitcoin ark open (btc-ark.js), the Trade tab's "Pay from"
// and "Receive to" choices gain "Ark" on the BTC side of a pair of BTC and a Sequentia asset. An
// Ark choice settles as the user composer's BTC trade does (user-trade-btc.js): the BTC moves over
// the ark's Lightning gateway and the asset in leaves of the operator's tree, under one hash, with
// a maker's BTC desk. The asset's side is therefore always Leaf, and choosing Ark sets it. It is a
// market trade: Limit has no Ark choice.
//
// Every amount, fee and refusal is the engine's (user-trade.js), which asks the leaf library and
// the ark wallet; nothing is priced in this file. User mode shows none of it: there the user
// composer pays and is paid BTC in the ark already.

import { tradeStateWord, USER_WORDS } from './user-trade.js'

export const ARK_WORDS = Object.freeze({
  button: 'Ark',
  closed: 'The Bitcoin ark is not open in this wallet yet.',
  empty: 'You have no BTC in the Ark to pay with.',
  leafToo: 'An Ark trade settles the asset in leaves: choose Leaf for the other side.',
  market: 'An Ark trade is a market trade: choose Market.',
  inArk: 'Your BTC is in the Ark: choose Ark, or move it on-chain first.',
  notArk: 'The best offer for this pair is not an Ark trade.',
})

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// ---------------------------------------------------------------------------
// Pure decisions (tested in ark-rail.test.mjs)
// ---------------------------------------------------------------------------

// Whether a leg shows the Ark choice: developer mode, a pair of BTC and another asset, and the
// leg being BTC's. Paying from the ark needs something in it.
export function arkRailOffered ({ dev, open, payAsset, receiveAsset, leg, spendable }) {
  if (!dev || !payAsset || !receiveAsset || payAsset === receiveAsset) return { offered: false, why: null }
  if ((leg === 'pay' ? payAsset : receiveAsset) !== 'BTC') return { offered: false, why: null }
  if (!open) return { offered: true, usable: false, why: ARK_WORDS.closed }
  if (leg === 'pay' && !(big(spendable) > 0n)) return { offered: true, usable: false, why: ARK_WORDS.empty }
  return { offered: true, usable: true, why: null }
}

// What the composer's choices settle as on the Ark rail.
// -> { kind: 'none' | 'pending' | 'refused' | 'trade', why?, side? ('buy': BTC paid, 'sell': BTC received) }
export function arkShape ({ payAsset, receiveAsset, payRail, recvRail, mode }) {
  const btcLeg = payAsset === 'BTC' ? 'pay' : receiveAsset === 'BTC' ? 'recv' : null
  if (!btcLeg) return { kind: 'none' }
  const btcRail = btcLeg === 'pay' ? payRail : recvRail
  const other = btcLeg === 'pay' ? recvRail : payRail
  if (btcRail !== 'ark') return { kind: 'none' }
  if (mode === 'post') return { kind: 'refused', why: ARK_WORDS.market }
  if (!other) return { kind: 'pending' }
  if (other !== 'leaf') return { kind: 'refused', why: ARK_WORDS.leafToo }
  return { kind: 'trade', side: btcLeg === 'pay' ? 'buy' : 'sell' }
}

// Why the engine priced nothing, in the words the user composer says it in.
export function refusalWords (q, name, amt) {
  const W = USER_WORDS, p = name(q.payAsset), g = name(q.receiveAsset)
  switch (q.why) {
    case 'vesting': return W.notVested(amt(q.payAsset, q.atoms), p, q.vests)
    case 'no-funds': return W.noFunds(p)
    case 'not-ready': return W.notReady(p, q.soon)
    case 'redoing': return W.redoing(p)
    case 'busy': return W.busy(p)
    case 'freeing': return W.freeing(p, q.soon)
    case 'readying': return W.readying(p, q.soon)
    case 'part-ready': return W.partReady(amt(q.payAsset, q.ready), p, q.soon)
    case 'too-small': return W.tooSmall
    case 'no-firm-offer': return W.noFirmOffer
    case 'not-listed': return W.notListed(g, p)
    default: return W.notOffered(g, p)
  }
}

// The engine's records of trades with BTC on one side, newest first.
export function arkRecords (records) {
  return (records || []).filter((r) => r && r.ticket && (r.ticket.payAsset === 'BTC' || r.ticket.receiveAsset === 'BTC')).slice().reverse()
}

// ---------------------------------------------------------------------------
// The buttons and the panel in the composer
// ---------------------------------------------------------------------------

// ctx: { $, el, dev(), open() -> the ark is open, spendable() -> sats the ark can pay now,
//   engine() -> the user-trade engine (its deps.btc is the ark whenever the ark is open),
//   composer() -> { payAsset, receiveAsset, payRail, recvRail, mode, payText }, setRail(leg, r),
//   leafUsable() -> the leaf wallet is joined, assetMeta, fmtAtoms, parseAtoms }
export function mountArkRail (ctx) {
  const { el } = ctx
  const S = { shape: { kind: 'none' }, busy: false, error: null, note: null, ticket: null, choice: null, timer: null }
  const tick = (h) => { if (h === 'BTC') return 'BTC'; try { const m = ctx.assetMeta(h); return (m && m.ticker && m.ticker !== '?') ? m.ticker : h.slice(0, 8) } catch { return String(h).slice(0, 8) } }
  const prec = (h) => { if (h === 'BTC') return 8; try { return ctx.assetMeta(h).precision ?? 0 } catch { return 0 } }
  const fmt = (h, atoms) => `${ctx.fmtAtoms(big(atoms), prec(h))} ${tick(h)}`
  const open = () => { try { return !!ctx.open() } catch { return false } }
  const spendable = () => { try { return open() ? big(ctx.spendable()) : 0n } catch { return 0n } }
  const offeredFor = (c, leg) => arkRailOffered({ dev: ctx.dev(), open: open(), payAsset: c.payAsset, receiveAsset: c.receiveAsset, leg, spendable: spendable() })

  function box () { return ctx.$('swArkBox') }
  function regular (show) {
    // While a leg is on Ark the composer's own placement controls are hidden (index.html's
    // .swark-on rules), as they are for Leaf.
    try { document.body.classList.toggle('swark-on', !show) } catch {}
  }
  function showWhy (why) {
    const note = ctx.$('swRailNote'); if (!note || !why) return
    note.classList.remove('hide'); note.textContent = why
  }

  function paintButtons (c) {
    for (const [id, leg] of [['swPayRailSeg', 'pay'], ['swRecvRailSeg', 'recv']]) {
      const seg = ctx.$(id); if (!seg) continue
      const off = offeredFor(c, leg)
      let b = seg.querySelector('button[data-r="ark"]')
      if (!b) {
        b = el('button', '', ARK_WORDS.button); b.type = 'button'; b.dataset.r = 'ark'; b.id = leg === 'pay' ? 'swPayArk' : 'swRecvArk'
        b.onclick = (ev) => {
          ev.stopPropagation()
          const now = ctx.composer()
          const o = offeredFor(now, leg)
          if (!o.usable) { showWhy(o.why); return }
          ctx.setRail(leg, 'ark')
          // The asset's side settles in leaves: set it too, when the leaf wallet can.
          const other = leg === 'pay' ? 'recv' : 'pay'
          if ((other === 'pay' ? now.payRail : now.recvRail) !== 'leaf' && ctx.leafUsable()) ctx.setRail(other, 'leaf')
          paint()
        }
        seg.appendChild(b)
      }
      b.style.display = off.offered ? '' : 'none'
      b.classList.toggle('off', off.offered && !off.usable)
      b.title = off.why || 'Settle BTC in the Bitcoin ark, over its Lightning gateway'
      b.classList.toggle('on', (leg === 'pay' ? c.payRail : c.recvRail) === 'ark')
      // An Ark choice the leg no longer offers (another asset, user mode, the ark emptied) is dropped.
      if (!off.offered || !off.usable) if ((leg === 'pay' ? c.payRail : c.recvRail) === 'ark') ctx.setRail(leg, null)
    }
  }

  // Called by the composer whenever it repaints its rails.
  function paint () {
    paintButtons(ctx.composer())
    const c = ctx.composer()
    const shape = arkShape(c)
    if (shape.kind !== S.shape.kind || c.payAsset !== S.pay || c.receiveAsset !== S.recv) { drop(); S.error = null; S.note = null }
    S.shape = shape; S.pay = c.payAsset; S.recv = c.receiveAsset
    const b = box(); if (!b) return
    const on = shape.kind !== 'none'
    b.classList.toggle('hide', !on)
    regular(!on)
    if (on) { render(); follow() }
  }

  function drop () {
    if (S.choice) { try { ctx.engine().drop(S.choice) } catch {} }
    S.ticket = null; S.choice = null
  }

  function btn (text, id, f, cls) { const x = el('button', cls || '', text); x.type = 'button'; x.id = id; x.disabled = S.busy; x.onclick = f; return x }
  function rows (list, id) {
    const d = el('div', 'swleaf-rows'); if (id) d.id = id
    for (const [k, v] of list) { const r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v', v)); d.appendChild(r) }
    return d
  }

  function render () {
    const b = box(); if (!b) return
    b.innerHTML = ''
    const sh = S.shape
    const head = el('div', 'swleaf-head')
    head.appendChild(el('span', 'swsec-lab', 'Ark'))
    head.appendChild(el('span', 'sub', 'BTC over the Bitcoin ark’s Lightning gateway, the asset in leaves, under one hash'))
    b.appendChild(head)
    b.appendChild(el('div', 'sub', `In the Ark: ${fmt('BTC', spendable())} spendable`))
    if (sh.kind === 'pending') b.appendChild(el('div', 'sub', 'Choose Leaf for the asset’s side.'))
    else if (sh.kind === 'refused') b.appendChild(el('div', 'status err', sh.why))
    else if (sh.kind === 'trade') renderTrade(b)
    if (S.error) b.appendChild(el('div', 'status err', S.error))
    if (S.note) b.appendChild(el('div', 'status', S.note))
    renderTrades(b)
  }

  function renderTrade (b) {
    const c = ctx.composer()
    if (!S.ticket) {
      b.appendChild(el('p', 'sub', `A market trade of ${tick(c.payAsset)} for ${tick(c.receiveAsset)} with a maker’s BTC desk. Enter what you pay.`))
      b.appendChild(btn('Review the trade', 'swArkReview', review, 'primary'))
      return
    }
    const t = S.ticket
    const fees = (t.fees || []).map((f) => fmt(f.asset, f.atoms)).join(' + ') || 'none'
    b.appendChild(rows([
      ['You pay', fmt(t.payAsset, t.amountIn) + (t.payAsset === 'BTC' ? ' from the Ark' : ' from your leaves')],
      ['You receive', fmt(t.receiveAsset, t.amountOut) + (t.receiveAsset === 'BTC' ? ' into the Ark' : ' as a leaf')],
      ['Fees', fees],
      ['Source', String(t.source)],
    ], 'swArkTicket'))
    b.appendChild(el('div', 'sub', t.payAsset === 'BTC'
      ? 'The maker’s leaf is paid to you under the maker’s hash first; the Ark pays its invoice only once that leaf is held for good. Keep this page open until then.'
      : 'Your Ark makes the invoice; your leaf pays the maker under its hash, and the maker’s BTC releases it. Keep this page open until it settles.'))
    const row = el('div', 'row')
    row.appendChild(btn('Trade', 'swArkGo', confirm, 'primary'))
    row.appendChild(btn('Cancel', 'swArkCancel', () => { drop(); render() }, 'ghost'))
    b.appendChild(row)
  }

  async function review () {
    const c = ctx.composer()
    S.error = null; S.note = null
    let atoms = 0n
    try { atoms = big(ctx.parseAtoms(String(c.payText || '').trim(), prec(c.payAsset))) } catch {}
    if (!(atoms > 0n)) { S.error = 'Enter how much you pay.'; render(); return }
    S.busy = true; render()
    try {
      const q = await ctx.engine().quote({ payAsset: c.payAsset, receiveAsset: c.receiveAsset, amount: String(atoms) })
      if (!q.ok) S.error = refusalWords({ ...q, payAsset: c.payAsset, receiveAsset: c.receiveAsset }, tick, fmt)
      else if (q.ticket.source !== 'btc-gateway') { ctx.engine().drop(q.choice); S.error = ARK_WORDS.notArk }
      else { S.ticket = q.ticket; S.choice = q.choice }
    } catch (e) { S.error = (e && e.message) || String(e) } finally { S.busy = false; render() }
  }

  async function confirm () {
    if (!S.choice) return
    S.busy = true; render()
    const choice = S.choice, ticket = S.ticket
    S.choice = null; S.ticket = null
    try {
      ctx.engine().confirm(choice, ticket).catch((e) => { S.error = (e && e.message) || String(e); render() }).finally(() => follow())
      S.note = 'Sent: it moves on below.'
    } finally { S.busy = false; render(); follow() }
  }

  function renderTrades (b) {
    let recs = []
    try { recs = arkRecords(ctx.engine().records()).slice(0, 8) } catch {}
    if (!recs.length) return
    b.appendChild(el('label', 'lbl', 'Your trades with BTC'))
    for (const r of recs) {
      const d = el('div', 'kv'); d.dataset.trade = r.id; d.dataset.state = r.state
      d.appendChild(el('span', 'k', `${fmt(r.ticket.payAsset, r.ticket.amountIn)} → ${fmt(r.ticket.receiveAsset, r.ticket.amountOut)}`))
      d.appendChild(el('span', 'v', tradeStateWord(r) || r.state))
      b.appendChild(d)
    }
  }

  // Open trades are moved on every few seconds while the panel shows.
  function follow () {
    clearTimeout(S.timer)
    let openRecs = []
    try { openRecs = arkRecords(ctx.engine().records()).filter((r) => !['settled', 'returned', 'failed'].includes(r.state)) } catch {}
    if (!openRecs.length || S.shape.kind === 'none') return
    S.timer = setTimeout(async () => {
      if (!S.busy) { try { await ctx.engine().resume() } catch (e) { console.warn('[ark rail] resume:', e && e.message) } }
      if (S.shape.kind !== 'none' && !S.ticket) render()
      follow()
    }, 5000)
  }

  // What the wallet can pay from the ark, for the composer's balance line and picker: developer
  // mode only (the figure in user mode is the one balance).
  function atoms (hex) { return hex === 'BTC' && ctx.dev() ? spendable() : 0n }

  return { paint, atoms, state: S }
}
