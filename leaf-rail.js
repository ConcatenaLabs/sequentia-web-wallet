// The composer's leaf rail (developer mode).
//
// In developer mode, when this wallet has joined a leaf operator, the Trade tab's "Pay from"
// and "Receive to" choices gain "Leaf" for a pair of two Sequentia assets. What a leaf choice
// settles by is decided by the settlement router (tooling/lsp/settlement-router.mjs), never
// here, and only three shapes exist:
//
//   Market, pay Leaf, receive Leaf  a take from leaves of an on-chain order: the operator's
//                                   round spends the order, pays its maker on the chain and
//                                   gives this wallet a leaf. The order is the best one the
//                                   unified book (tooling/lsp/unified-book.mjs) marks as one
//                                   the round can take (caps.leaf_take). Beside it: accepting
//                                   another wallet's in-tree swap offer, pasted in.
//   Limit, pay Leaf, receive Leaf   an in-tree swap offered to another wallet that holds
//                                   leaves: one reassignment in the tree, offered, accepted
//                                   and completed, the texts passed between the two wallets.
//   Limit, pay Leaf, receive        an order placed on the chain from leaves: the operator's
//   On-chain                        round pays exactly the order's amount into its address,
//                                   where it rests with the wallet offline; the wallet lists
//                                   it on the relay once it rests.
//
// BTC is never a leaf. A pair with BTC in it shows Leaf on the asset's side only while BTC's side
// is on Ark (ark-rail.js): that trade is the Ark rail's to settle, and this panel stays out of it. Every amount, fee, date and
// refusal on this rail is the leaf library's (leaves/worker.js runs it), shown in its own words
// before anything is signed; nothing about a leaf is computed in this file. User mode shows
// none of it.

import { planSettlement, chooseSettlementPath, leafExecution } from './tooling/lsp/settlement-router.mjs';
import { buildUnifiedBook, bestFor } from './tooling/lsp/unified-book.mjs';

export const LEAF_WORDS = Object.freeze({
  button: 'Leaf',
  btc: 'BTC is never a leaf: it settles over Lightning, on the chain or in the Ark. Choose Ark for BTC to settle the asset in leaves.',
  join: 'Join a leaf operator in the Leaves tab to pay from leaves.',
  payToo: 'A trade that gives you a leaf is paid from leaves: choose Leaf to pay from too.',
  marketChain: 'A take from leaves gives you a leaf: choose Leaf to receive to, or Limit to place an order on the chain from your leaves.',
  ln: 'A leaf settles with Lightning only through the operator’s gateway, which this composer does not run: choose Leaf or On-chain on both sides.',
});

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } };

// ---------------------------------------------------------------------------
// Pure decisions (tested in leaf-rail.test.mjs)
// ---------------------------------------------------------------------------

// Whether the Leaf choice is offered at all: developer mode, an operator joined, and a pair of
// two Sequentia assets.
export function leafRailOffered({ dev, joined, payAsset, receiveAsset, payRail, recvRail }) {
  if (!dev) return { offered: false, why: null };
  if (!payAsset || !receiveAsset || payAsset === receiveAsset) return { offered: false, why: null };
  if (payAsset === 'BTC' || receiveAsset === 'BTC') {
    if ((payAsset === 'BTC' ? payRail : recvRail) !== 'ark') return { offered: false, why: LEAF_WORDS.btc };
    if (!joined) return { offered: true, usable: false, why: LEAF_WORDS.join };
    return { offered: true, usable: true, why: null };
  }
  if (!joined) return { offered: true, usable: false, why: LEAF_WORDS.join };
  return { offered: true, usable: true, why: null };
}

// What the composer's choices settle as on the leaf rail, by the router. `base`/`quote` are the
// pair's canonical sides; the wallet is the taker.
// -> { kind: 'none'|'take'|'swap'|'place'|'refused', why?, plan?, path? }
export function leafShape({ payAsset, receiveAsset, payRail, recvRail, mode, base, quote }) {
  if (payRail !== 'leaf' && recvRail !== 'leaf') return { kind: 'none' };
  // BTC on Ark: the Ark rail's trade (ark-rail.js), not this panel's.
  if ((payAsset === 'BTC' && payRail === 'ark') || (receiveAsset === 'BTC' && recvRail === 'ark')) return { kind: 'none' };
  if (payAsset === 'BTC' || receiveAsset === 'BTC') return { kind: 'refused', why: LEAF_WORDS.btc };
  if (!payRail || !recvRail) return { kind: 'pending' };
  if (payRail === 'ln' || recvRail === 'ln') return { kind: 'refused', why: LEAF_WORDS.ln };
  if (payRail !== 'leaf') return { kind: 'refused', why: LEAF_WORDS.payToo };
  // The wallet buys the base when it receives it.
  const buys = receiveAsset === base;
  const me = { btcRail: payRail, assetRail: recvRail };
  const meAsSeller = { assetRail: payRail, btcRail: recvRail };
  if (recvRail === 'chain') {
    // Paying from leaves and receiving on the chain is no trade against a counterparty: it is
    // an order of the wallet's own, offboarded onto the chain, which rests there as an ordinary
    // on-chain order (filled later by anyone, on the chain or from leaves).
    if (mode !== 'post') return { kind: 'refused', why: LEAF_WORDS.marketChain };
    return { kind: 'place' };
  }
  // pay Leaf, receive Leaf.
  const leaves = { btcRail: 'leaf', assetRail: 'leaf' };
  if (mode === 'post') {
    const m = buys ? { asset: base, quote, buyer: me, seller: { assetRail: 'leaf', btcRail: 'leaf' }, takerSide: 'buy' }
      : { asset: base, quote, buyer: leaves, seller: meAsSeller, takerSide: 'sell' };
    const plan = planSettlement(m);
    return { kind: 'swap', plan, path: chooseSettlementPath(m).path, commands: leafExecution(plan) };
  }
  const chain = { btcRail: 'chain', assetRail: 'chain' };
  const m = buys ? { asset: base, quote, buyer: me, seller: { assetRail: 'chain', btcRail: 'chain' }, takerSide: 'buy' }
    : { asset: base, quote, buyer: chain, seller: meAsSeller, takerSide: 'sell' };
  const plan = planSettlement(m);
  return { kind: 'take', plan, side: buys ? 'buy' : 'sell', match: m, commands: leafExecution(plan) };
}

// The order a take from leaves fills: of the relay's offers for the pair (both orientations),
// those that sell what the wallet receives for what it pays, classified by the unified book;
// the best price among those the round can take (caps.leaf_take). `amount` (atoms of the asset
// received) prefers an order holding at least that much. -> { offer, entry, path } or null.
export function bestLeafOrder(offers, { payAsset, receiveAsset, base, quote, amount }) {
  const mine = (offers || []).filter((o) => o && o._verified !== false
    && (o.offer_asset ?? o.offerAsset) === receiveAsset && (o.want_asset ?? o.wantAsset) === payAsset);
  const book = buildUnifiedBook(mine, { quote });
  const side = receiveAsset === base ? 'buy' : 'sell';
  const takeable = (list) => list.filter((e) => e.meta && e.meta.caps && e.meta.caps.leaf_take);
  const leafBook = { asks: takeable(book.asks), bids: takeable(book.bids) };
  const list = side === 'buy' ? leafBook.asks : leafBook.bids;
  const want = big(amount);
  const holding = want > 0n ? list.filter((e) => big(e.assetAtoms) >= want) : list;
  const entry = holding[0] || bestFor(leafBook, side) || null;
  if (!entry) return null;
  const chain = { btcRail: 'chain', assetRail: 'chain' }, leaves = { btcRail: 'leaf', assetRail: 'leaf' };
  const match = side === 'buy' ? { asset: base, quote, buyer: leaves, seller: { assetRail: 'chain', btcRail: 'chain' } }
    : { asset: base, quote, buyer: chain, seller: { assetRail: 'leaf', btcRail: 'leaf' } };
  return { offer: entry.raw, entry, path: chooseSettlementPath(match, entry.meta).path };
}

// An order's rate from the two amounts the composer holds: `want` of the wanted asset for
// `amount` sold, reduced.
export function orderRate(amount, want) {
  let a = big(amount), b = big(want);
  if (a <= 0n || b <= 0n) throw new Error('both amounts must be above zero');
  const gcd = (x, y) => { while (y) [x, y] = [y, x % y]; return x; };
  const g = gcd(b, a);
  return { rate_num: String(b / g), rate_den: String(a / g) };
}

// The rows an approval shows, from the library's answers. `fmt(asset, atoms)` names an amount.
export function takeRows(q, fmt, op) {
  const rows = [
    ['Order', `${q.order} (on the chain; the wallet found it on its own node, unspent and final)`],
    ['You receive', `${fmt(q.asset_a, q.filled)} as a leaf, in the round’s batch, once the round is final`],
    ['You give', `${fmt(q.asset_b, q.gives)}: the price and the operator’s fee, from your leaves`],
    ['Price', `${fmt(q.asset_b, q.price)}, paid on the chain to the order’s maker`],
    ['Operator’s fee', `${fmt(q.asset_b, q.fee)} (its schedule for this asset)`],
    ['Order after the fill', big(q.remainder) > 0n ? `${fmt(q.asset_a, q.remainder)} rests again on the chain, under the same terms` : 'filled whole'],
  ];
  if (q.pays_itself_first) rows.push(['First', `no single leaf holds exactly ${fmt(q.asset_b, q.gives)}: the wallet first pays itself one out of round`]);
  const win = op && op.forfeit_window_seconds;
  rows.push(['Your part', `once the operator builds the round, this wallet hands over the forfeit of the coin it gives, within ${win != null ? Math.round(win / 60) + ' minutes' : 'the operator’s window'}. Keep this page open until then. If it does not come in time, the take is voided and the coin is yours again.`]);
  return rows;
}

export function swapReadRows(r, fmt, when) {
  const d = r.dates || {};
  const rows = [
    ['You receive', `${fmt(r.gets.asset, r.gets.value)} as a leaf, in one reassignment both wallets sign and the operator co-signs`],
    ['You give', `${fmt(r.gives.asset, r.gives.value)} from your leaves`],
    ['You pay', `${fmt(r.pays.asset, r.pays.margins)}: the margins your coins leave for the transfer’s fees`],
    ['The other wallet pays', `${fmt(r.maker_pays.asset, r.maker_pays.margin)} as the reassignment’s margin`],
    ['Change', big(r.change && r.change.value) > 0n ? `${fmt(r.change.asset, r.change.value)} back as a leaf` : 'none'],
    ['Coins spent', String(r.coins_spent)],
  ];
  if (d.exit_deadline != null) rows.push(['Dates', `the coins you get rest on every coin the swap spends: take them on the chain by ${when(d.exit_deadline)} at the latest${d.rests_on_board ? ' (one rests on a board)' : ''}`]);
  return rows;
}

export function swapOfferRows(o, fmt) {
  return [
    ['You give', `${fmt(o.gives.asset, o.gives.value)} from your leaves`],
    ['You receive', `${fmt(o.gets.asset, o.gets.value)} as a leaf`],
    ['You pay', `${fmt(o.pays.asset, o.pays.margin)} as the reassignment’s margin, and ${fmt(o.pays.asset, o.pays.margins)} the margins your coins leave`],
    ['Your coins', 'held for this offer, signed for nothing, until it completes or you cancel it'],
  ];
}

export function placeRows(q, args, fmt, when) {
  const fee = q.fee || {};
  return [
    ['Sell', fmt(args.sell, args.amount)],
    ['For', `${fmt(args.want, q.full_price)} if filled whole; ${args.rate_num} of it for every ${args.rate_den} sold, each fill rounded up`],
    ['Smallest fill', fmt(args.sell, q.min_lot ?? args.min_lot ?? args.amount)],
    ['Paid to', String(q.credits_to || 'the order’s own key')],
    ['Fee', `${fmt(fee.asset || args.sell, fee.amount)} (the coins’ refresh ${fee.refresh ?? '?'}, the offboard ${fee.offboard ?? '?'}, the unlock margin ${fee.unlock_margin ?? '?'})`],
    ['Change', q.change && big(q.change) > 0n ? `${fmt(args.sell, q.change)} back as a leaf` : 'none'],
    ['Refund', `what rests unfilled can be taken back from ${when(Number(q.expiry_locktime ?? args.expiry))} (median time), and not before`],
  ];
}

// An order of the library's `orders`, as the relay lists it once it rests (the parameters of
// covenant-order.js's postExisting). Null unless it rests. The library gives the terms in the
// relay's form, byte fields in base64; `normTerms` turns them into the hex the wallet's covenant
// code reads.
export function postParams(o, offerId, orderFromTerms, normTerms = (ct) => ct) {
  if (!o || o.state !== 'resting' || !o.relay || !o.rests_at) return null;
  const ct = normTerms(JSON.parse(JSON.stringify(o.relay)));
  const order = orderFromTerms(ct);
  const [txid, vout] = String(o.rests_at).split(':');
  return {
    assetA: order.assetA, assetB: order.assetB,
    sellAtoms: BigInt(o.holds), rateNum: order.rateNum, rateDen: order.rateDen, minLot: order.minLot,
    expiryLocktime: order.expiryLocktime, makerProg: order.makerProg, makerX: order.makerX,
    ...(order.internalKey ? { internalKey: order.internalKey } : {}),
    txid, vout: Number(vout), offerId,
  };
}

// How long the relay lists an order: until its refund opens, at most a week, less a minute.
export function offerTtl(nowUnix, expiryLocktime, maxSecs = 7 * 86400) {
  const untilRefund = Number(expiryLocktime) >= 500000000 ? Number(expiryLocktime) - nowUnix - 60 : maxSecs;
  return Math.max(60, Math.min(maxSecs - 60, untilRefund));
}

// ---------------------------------------------------------------------------
// The panel in the composer
// ---------------------------------------------------------------------------

const SWAPS_KEY = 'swk.leafrail.swaps';     // + '.' + tag: what this wallet's own offers pay
const ORDERS_KEY = 'swk.leafrail.orders';   // + '.' + tag: this wallet's orders placed here

// ctx: { $, el, store, walletTag(), leaves (the Leaves tab's api), dev(), assetMeta, fmtAtoms,
//   parseAtoms, composer() -> { payAsset, receiveAsset, payRail, recvRail, mode, base, quote,
//   payText, recvText }, setRail(leg, r), fetchBook(base, quote), relayPost: { postExisting,
//   orderFromCovenantTerms, postCovenantOffer(offer, priv), fetchOutput(txid, vout), offerKey(orderId) } }
export function mountLeafRail(ctx) {
  const { el } = ctx;
  const S = { shape: { kind: 'none' }, busy: false, step: null, error: null, note: null, order: null, quote: null, read: null,
    offer: null, take: null, accept: null, placed: null, form: {} };
  const tag = () => { try { return ctx.walletTag() } catch { return 'default' } };
  const joined = () => !!(ctx.leaves && ctx.leaves.isOpen && ctx.leaves.isOpen());
  const tick = (h) => { try { const m = ctx.assetMeta(h); return (m && m.ticker && m.ticker !== '?') ? m.ticker : h.slice(0, 8) } catch { return String(h).slice(0, 8) } };
  const prec = (h) => { try { return ctx.assetMeta(h).precision ?? 0 } catch { return 0 } };
  const fmt = (h, atoms) => `${ctx.fmtAtoms(big(atoms), prec(h))} ${tick(h)} (${big(atoms)} atoms)`;
  const when = (t) => (typeof t === 'number' && t > 0) ? new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : String(t);
  const keyed = (k) => k + '.' + tag();
  const readJSON = (k, d) => { try { return JSON.parse(ctx.store.getItem(keyed(k)) || 'null') ?? d } catch { return d } };
  const writeJSON = (k, v) => { try { ctx.store.setItem(keyed(k), JSON.stringify(v)) } catch {} };
  const run = (cmd, args) => ctx.leaves.command(cmd, args || {});

  function box() { return ctx.$('swLeafBox') }
  function regular(show) {
    // The composer's own placement controls belong to the on-chain and Lightning rails: while a
    // leg is on Leaf they are hidden (index.html's .swleaf-on rules), so nothing of theirs shows
    // or runs on a leaf choice, whatever the composer's own painters set on them meanwhile.
    try { document.body.classList.toggle('swleaf-on', !show) } catch {}
  }

  // The Leaf buttons in both rail choosers, shown only where the rail is offered.
  function paintButtons(c) {
    const off = leafRailOffered({ dev: ctx.dev(), joined: joined(), payAsset: c.payAsset, receiveAsset: c.receiveAsset, payRail: c.payRail, recvRail: c.recvRail });
    for (const [id, leg] of [['swPayRailSeg', 'pay'], ['swRecvRailSeg', 'recv']]) {
      const seg = ctx.$(id); if (!seg) continue;
      // BTC's own side never shows Leaf, Ark or not.
      const legOff = (leg === 'pay' ? c.payAsset : c.receiveAsset) === 'BTC' ? { offered: false } : off;
      let b = seg.querySelector('button[data-r="leaf"]');
      if (!b) {
        b = el('button', '', LEAF_WORDS.button); b.type = 'button'; b.dataset.r = 'leaf'; b.id = leg === 'pay' ? 'swPayLeaf' : 'swRecvLeaf';
        b.onclick = (ev) => {
          ev.stopPropagation();
          const now = ctx.composer();
          const o = leafRailOffered({ dev: ctx.dev(), joined: joined(), payAsset: now.payAsset, receiveAsset: now.receiveAsset, payRail: now.payRail, recvRail: now.recvRail });
          if (!o.usable) { showWhy(o.why); return }
          ctx.setRail(leg, 'leaf');
        };
        seg.appendChild(b);
      }
      b.classList.toggle('hide', !legOff.offered);
      b.style.display = legOff.offered ? '' : 'none';
      b.classList.toggle('off', legOff.offered && !legOff.usable);
      b.title = legOff.why || 'Settle this leg with leaves of the operator’s tree';
      b.classList.toggle('on', (leg === 'pay' ? c.payRail : c.recvRail) === 'leaf');
    }
    // A Leaf choice the rail no longer offers (user mode, BTC in the pair off Ark) is dropped.
    if (!off.offered || !off.usable) {
      if (c.payRail === 'leaf') ctx.setRail('pay', null);
      if (c.recvRail === 'leaf') ctx.setRail('recv', null);
    }
  }

  function showWhy(why) {
    const note = ctx.$('swRailNote'); if (!note || !why) return;
    note.classList.remove('hide'); note.textContent = why;
  }

  // Called by the composer whenever it repaints its rails.
  function paint() {
    const c = ctx.composer();
    paintButtons(c);
    const c2 = ctx.composer();
    const shape = leafShape(c2);
    const changed = shape.kind !== S.shape.kind || c2.payAsset !== S.pay || c2.receiveAsset !== S.recv;
    S.shape = shape; S.pay = c2.payAsset; S.recv = c2.receiveAsset;
    if (changed) { S.step = null; S.error = null; S.note = null; S.quote = null; S.read = null; S.order = null; S.place = null; S.completing = null; S.swaps = null; S.orders = null }
    const b = box(); if (!b) return;
    const on = shape.kind !== 'none';
    b.classList.toggle('hide', !on);
    regular(!on);
    if (on) render();
  }

  function render() {
    const b = box(); if (!b) return;
    b.innerHTML = '';
    const sh = S.shape;
    const head = el('div', 'swleaf-head');
    head.appendChild(el('span', 'swsec-lab', 'Leaves'));
    head.appendChild(el('span', 'sub', sh.kind === 'take' ? 'a take from leaves, in the operator’s round'
      : sh.kind === 'swap' ? 'an in-tree swap with another wallet'
        : sh.kind === 'place' ? 'an order placed on the chain from leaves' : ''));
    b.appendChild(head);
    if (sh.kind === 'pending') { b.appendChild(el('div', 'sub', 'Choose how the other side settles.')); return }
    if (sh.kind === 'refused') { b.appendChild(el('div', 'status err', sh.why)); return }
    if (sh.kind === 'take') renderTake(b);
    if (sh.kind === 'swap') renderSwapOffer(b);
    if (sh.kind === 'place') renderPlace(b);
    if (sh.kind === 'take' || sh.kind === 'swap') renderSwapAccept(b);
    renderSwaps(b);
    if (S.error) b.appendChild(errBox(S.error));
    if (S.note) b.appendChild(el('div', 'status', S.note));
  }

  function errBox(e) {
    const d = el('div', 'status err leaf-refusal', e.message || String(e));
    if (e.kind || e.code) d.appendChild(el('div', 'sub', [e.kind, e.code, e.status].filter(Boolean).join(' · ')));
    return d;
  }
  function rowsBox(rows, id) {
    const d = el('div', 'swleaf-rows'); if (id) d.id = id;
    for (const [k, v] of rows) { const r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v', v)); d.appendChild(r) }
    return d;
  }
  function btn(text, id, f, cls) { const x = el('button', cls || '', text); x.type = 'button'; x.id = id; x.disabled = S.busy; x.onclick = f; return x }
  function area(id, ph) {
    const t = el('textarea', 'mono'); t.id = id; t.rows = 3; t.placeholder = ph; t.style.width = '100%';
    if (S.form[id] != null) t.value = S.form[id];
    t.oninput = () => { S.form[id] = t.value };
    return t;
  }
  function textOut(id, text) {
    const t = el('textarea', 'mono'); t.id = id; t.rows = 3; t.readOnly = true; t.value = text; t.style.width = '100%';
    const wrap = el('div'); wrap.appendChild(t);
    const c = btn('Copy', id + 'Copy', () => { try { navigator.clipboard.writeText(text) } catch {} t.select() }, 'ghost');
    wrap.appendChild(c);
    return wrap;
  }
  async function step(name, f) {
    S.busy = true; S.error = null; S.note = null; render();
    try { await f() } catch (e) { S.error = e; console.warn('[leaf rail] ' + name + ':', e && e.message) }
    finally { S.busy = false; S.swaps = null; render() }
  }
  const atomsOf = (asset, text) => ctx.parseAtoms(String(text || '').trim(), prec(asset));

  // ---- a take from leaves ----
  function renderTake(b) {
    const c = ctx.composer();
    b.appendChild(el('p', 'sub', `Fills the best on-chain order the operator’s round can take, selling ${tick(c.receiveAsset)} for ${tick(c.payAsset)}. Enter what you receive.`));
    if (!S.quote) {
      b.appendChild(btn('Review the take', 'swLeafTakeReview', () => step('take quote', async () => {
        const amount = atomsOf(c.receiveAsset, c.recvText);
        if (!(amount > 0n)) throw new Error('Enter how much you receive.');
        const offers = await ctx.fetchBook(c.base, c.quote);
        const best = bestLeafOrder(offers, { ...c, amount: String(amount) });
        if (!best) throw new Error(`No on-chain order of ${tick(c.receiveAsset)} for ${tick(c.payAsset)} rests that the operator’s round can take.`);
        if (best.path !== 'leaf-take') throw new Error('The best order cannot be taken from leaves.');
        // The library reads the order as the relay serves it (its byte fields in base64).
        const q = await run('take_quote', { order: best.offer._relayJson || best.offer, amount: String(amount) });
        const info = await run('info');
        const fills = (info && info.server_info && info.server_info.fills) || {};
        S.order = best; S.quote = q; S.op = { operator: info.operator, forfeit_window_seconds: fills.forfeit_window_seconds };
      }), 'primary'));
      return;
    }
    const q = S.quote;
    b.appendChild(rowsBox([...takeRows(q, fmt, S.op), ['Operator', String(S.op.operator || '?')]], 'swLeafTakeRows'));
    b.appendChild(el('div', 'sub', 'The fill is final once the round’s block is certified and its Bitcoin anchor buried; if Bitcoin reorganises below it, so does Sequentia, and the fill is undone until the round is mined again. The take goes ahead only on what is shown.'));
    const row = el('div', 'row');
    row.appendChild(btn('Take it', 'swLeafTakeGo', () => step('take', async () => {
      const r = await run('take', { order: S.order.offer._relayJson || S.order.offer, amount: q.filled, shown: q });
      S.take = r; S.quote = null;
      S.note = `Taken (${String(r.take).slice(0, 12)}…): the forfeit goes in at the wallet’s next sync once the operator builds the round; the leaf comes once the round is final. Follow it in the Leaves tab.`;
      try { ctx.leaves.syncNow && ctx.leaves.syncNow() } catch {}
    }), 'primary'));
    row.appendChild(btn('Cancel', 'swLeafTakeCancel', () => { S.quote = null; render() }, 'ghost'));
    b.appendChild(row);
  }

  // ---- an in-tree swap: the offer and its completion ----
  function renderSwapOffer(b) {
    const c = ctx.composer();
    b.appendChild(el('p', 'sub', `Offers ${tick(c.payAsset)} for ${tick(c.receiveAsset)} to another wallet that holds leaves of this operator, at the two amounts above. Nothing is signed until the other wallet accepts and you complete it.`));
    b.appendChild(btn('Make the offer', 'swLeafOffer', () => step('swap offer', async () => {
      const give = atomsOf(c.payAsset, c.payText), want = atomsOf(c.receiveAsset, c.recvText);
      if (!(give > 0n && want > 0n)) throw new Error('Enter both amounts: what you give and what you want.');
      const o = await run('swap_offer', { give_asset: c.payAsset, give: String(give), want_asset: c.receiveAsset, want: String(want) });
      const kept = readJSON(SWAPS_KEY, {});
      kept[o.swap] = { gives: o.gives, gets: o.gets, pays: o.pays, at: Date.now() };
      writeJSON(SWAPS_KEY, kept);
      S.offer = o;
    }), 'primary'));
    if (S.offer) {
      b.appendChild(rowsBox(swapOfferRows(S.offer, fmt), 'swLeafOfferRows'));
      b.appendChild(el('div', 'sub', 'Give this offer to the other wallet. It answers with an acceptance, which you paste below to complete the swap.'));
      b.appendChild(textOut('swLeafOfferText', S.offer.offer));
    }
    b.appendChild(el('label', 'lbl', 'Complete a swap you offered'));
    b.appendChild(area('swLeafAcceptIn', 'Paste the other wallet’s acceptance'));
    if (!S.completing) {
      b.appendChild(btn('Review the completion', 'swLeafCompleteReview', () => step('swap completion', async () => {
        const text = String(S.form.swLeafAcceptIn || '').trim();
        if (!text) throw new Error('Paste the acceptance first.');
        const list = await run('swaps');
        const open = (list || []).filter((s) => s.role === 'maker' && s.state === 'open');
        if (!open.length) throw new Error('This wallet has no open offer to complete.');
        // Which offer it completes is the library's to check; the panel shows what that offer
        // gives, gets and pays, kept from the library's own answer when it was made.
        const kept = readJSON(SWAPS_KEY, {});
        S.completing = { text, open, kept };
      }), 'primary'));
    } else {
      const { open, kept } = S.completing;
      for (const s of open) {
        const k = kept[s.swap];
        b.appendChild(rowsBox([['Offer', s.swap.slice(0, 16) + '…'], ['You give', fmt(s.gives.asset, s.gives.value)], ['You receive', fmt(s.gets.asset, s.gets.value) + ' as a leaf'],
          ['You pay', k && k.pays ? `${fmt(k.pays.asset, k.pays.margin)} margin and ${fmt(k.pays.asset, k.pays.margins)} of your coins’ margins` : 'the margins shown when the offer was made']], 'swLeafCompleteRows'));
      }
      b.appendChild(el('div', 'sub', 'Completing signs your side of the reassignment the acceptance carries; the wallet checks that it keeps your coins and outputs exactly as offered, and the operator co-signs it.'));
      const row = el('div', 'row');
      row.appendChild(btn('Complete the swap', 'swLeafCompleteGo', () => step('swap complete', async () => {
        const r = await run('swap_complete', { accept: S.completing.text });
        S.completing = null; S.form.swLeafAcceptIn = ''; S.offer = null;
        S.note = `Swap ${String(r.swap).slice(0, 12)}… done: both assets moved in one reassignment.`;
      }), 'primary'));
      row.appendChild(btn('Cancel', 'swLeafCompleteCancel', () => { S.completing = null; render() }, 'ghost'));
      b.appendChild(row);
    }
  }

  // ---- accepting another wallet's offer ----
  function renderSwapAccept(b) {
    b.appendChild(el('label', 'lbl', 'Accept another wallet’s swap offer'));
    b.appendChild(area('swLeafOfferIn', 'Paste the offer'));
    if (!S.read) {
      b.appendChild(btn('Read the offer', 'swLeafRead', () => step('swap read', async () => {
        const text = String(S.form.swLeafOfferIn || '').trim();
        if (!text) throw new Error('Paste the offer first.');
        S.read = { text, terms: await run('swap_read', { offer: text }) };
      })));
      if (S.accept) {
        b.appendChild(el('div', 'sub', 'Send this acceptance back to the wallet that offered: it completes the swap, and your new leaf arrives at your next sync.'));
        b.appendChild(textOut('swLeafAcceptText', S.accept.accept));
      }
      return;
    }
    b.appendChild(rowsBox(swapReadRows(S.read.terms, fmt, when), 'swLeafReadRows'));
    const row = el('div', 'row');
    row.appendChild(btn('Accept', 'swLeafAcceptGo', () => step('swap accept', async () => {
      const r = await run('swap_accept', { offer: S.read.text, shown: S.read.terms });
      S.accept = r; S.read = null; S.form.swLeafOfferIn = '';
    }), 'primary'));
    row.appendChild(btn('Cancel', 'swLeafReadCancel', () => { S.read = null; render() }, 'ghost'));
    b.appendChild(row);
  }

  function renderSwaps(b) {
    if (!S.swaps) { S.swaps = []; refreshSwaps(); }
    const live = (S.swaps || []).filter((s) => s.state === 'open' || s.state === 'accepted');
    if (!live.length) return;
    b.appendChild(el('label', 'lbl', 'Your swaps in progress'));
    for (const s of live) {
      const r = el('div', 'kv');
      r.appendChild(el('span', 'k', `${s.role === 'maker' ? 'offered' : 'accepted'} · ${s.state}`));
      r.appendChild(el('span', 'v', `give ${fmt(s.gives.asset, s.gives.value)}, get ${fmt(s.gets.asset, s.gets.value)}`));
      r.appendChild(btn('Cancel', 'swLeafSwapCancel-' + s.swap.slice(0, 8), () => step('swap cancel', async () => {
        const c = await run('swap_cancel', { swap: s.swap });
        S.note = c.note || (c.cancelled ? 'Cancelled: its coins are free again.' : 'Not cancelled.');
        await refreshSwaps();
      }), 'ghost'));
      b.appendChild(r);
    }
  }
  async function refreshSwaps() {
    try { S.swaps = (await run('swaps')) || [] } catch { S.swaps = [] }
    if (S.shape.kind !== 'none') render();
  }

  // ---- an order placed on the chain from leaves ----
  function renderPlace(b) {
    const c = ctx.composer();
    b.appendChild(el('p', 'sub', `Places an order selling ${tick(c.payAsset)} for ${tick(c.receiveAsset)} on the chain, out of your leaves: it rests there with you offline, anyone fills it, and what it is paid lands on the chain under the order’s key. It is cancelled only by its refund, after its date.`));
    if (!S.place) {
      const lot = el('input', 'mono'); lot.id = 'swLeafMinLot'; lot.placeholder = `Smallest fill, in ${tick(c.payAsset)} (a tenth of the order unless set)`
      if (S.form.swLeafMinLot != null) lot.value = S.form.swLeafMinLot
      lot.oninput = () => { S.form.swLeafMinLot = lot.value }
      b.appendChild(lot);
      b.appendChild(btn('Review the order', 'swLeafPlaceReview', () => step('order quote', async () => {
        const amount = atomsOf(c.payAsset, c.payText), want = atomsOf(c.receiveAsset, c.recvText);
        const args = { sell: c.payAsset, want: c.receiveAsset, amount: String(amount), ...orderRate(amount, want) };
        // Every resting order fills in part: the smallest fill is the user's, a tenth of it unless set.
        const lot = String(S.form.swLeafMinLot || '').trim();
        args.min_lot = lot ? String(atomsOf(c.payAsset, lot)) : String(amount / 10n > 0n ? amount / 10n : 1n);
        const sch = await run('schedule');
        args.expiry = String(Number(sch.now) + 86400);
        S.place = { args, quote: await run('order_quote', args) };
      }), 'primary'));
    } else {
      b.appendChild(rowsBox(placeRows(S.place.quote, S.place.args, fmt, when), 'swLeafPlaceRows'));
      const row = el('div', 'row');
      row.appendChild(btn('Place it', 'swLeafPlaceGo', () => step('order place', async () => {
        const r = await run('order_place', { ...S.place.args, shown: S.place.quote });
        const kept = readJSON(ORDERS_KEY, {});
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
        kept[r.order] = { offer_id: id, at: Date.now() };
        writeJSON(ORDERS_KEY, kept);
        S.place = null; S.orders = null;
        S.note = `Placed: order ${String(r.order).slice(0, 12)}… rests once the operator’s round is final; list it below then.`;
      }), 'primary'));
      row.appendChild(btn('Cancel', 'swLeafPlaceCancel', () => { S.place = null; render() }, 'ghost'));
      b.appendChild(row);
    }
    renderOrders(b);
  }
  function renderOrders(b) {
    const kept = readJSON(ORDERS_KEY, {});
    if (!Object.keys(kept).length) return;
    if (!S.orders) { S.orders = []; run('orders').then((o) => { S.orders = o || []; render() }).catch(() => {}) }
    b.appendChild(el('label', 'lbl', 'Your orders placed from leaves'));
    // A sync first: it hands over what the order's round asks of the wallet and learns where the
    // round stands; then the library reads each order from the chain.
    b.appendChild(btn('Sync and refresh', 'swLeafOrdersRefresh', () => step('orders', async () => { await run('sync'); S.orders = (await run('orders')) || [] }), 'ghost'));
    for (const o of S.orders) {
      const rec = kept[o.order]; if (!rec) continue;
      const r = el('div', 'kv'); r.dataset.order = o.order; r.dataset.state = o.state || ''; r.dataset.restsAt = o.rests_at || ''; r.dataset.listed = rec.listed || ''
      r.appendChild(el('span', 'k', `${o.state}${o.rests_at ? ' at ' + o.rests_at : ''}`));
      r.appendChild(el('span', 'v', rec.listed ? `listed (${rec.listed})` : (o.note || '')));
      if (o.state === 'resting' && !rec.listed) r.appendChild(btn('List it on the relay', 'swLeafList-' + o.order.slice(0, 8), () => step('list order', () => listOrder(o, rec)), 'ghost'));
      b.appendChild(r);
    }
  }
  async function listOrder(o, rec) {
    const P = ctx.relayPost;
    const p = postParams(o, rec.offer_id, P.orderFromCovenantTerms, P.normTerms);
    if (!p) throw new Error('The order does not rest yet.');
    const now = Math.floor(Date.now() / 1000);
    const { priv, pub } = await P.offerKey(o.order);
    const res = await P.postExisting({ ...p, nowUnix: now, ttlSecs: offerTtl(now, p.expiryLocktime), makerPubkey: pub },
      { fetchOutput: P.fetchOutput, postCovenantOffer: (offer) => P.postCovenantOffer(offer, priv) });
    const kept = readJSON(ORDERS_KEY, {});
    kept[o.order] = { ...rec, listed: o.rests_at, relay_expires: Number(res.offer.expires_at_unix) };
    writeJSON(ORDERS_KEY, kept);
    S.note = `Listed on the relay at ${o.rests_at}.`;
    S.orders = null;
  }

  // What the wallet holds of an asset as leaves, for the composer's picker: developer mode only.
  function atoms(hex) { if (!ctx.dev() || !joined() || !ctx.leaves.leafAtoms) return 0n; return ctx.leaves.leafAtoms(hex) || 0n }

  return { paint, render, atoms, state: S, refreshSwaps };
}
