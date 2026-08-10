// ---------------------------------------------------------------------------
// SeqDEX swap — the symmetric "Pay -> Receive" composer (Phase 6d-3 reframe).
//
// ONE composer replaces the old market/BUY-SELL form: "You pay [amt][asset]" on
// top, a circular flip (the signature) in the middle, "You receive [amt][asset]"
// below. Both asset fields are visually EQUAL — there is no base/quote and no
// privileged/native asset in the UI. Buying vs selling is just which asset sits
// on top; the flip inverts pay<->receive and re-quotes.
//
// Routing is automatic from the chosen assets, so the composer is the single
// entry point for BOTH swap kinds:
//   • both sides Sequentia assets -> SAME-CHAIN atomic swap (this module's
//     propose -> sign -> complete path, unchanged from 6d-1).
//   • either side is BTC (the parent/testnet4 asset) -> CROSS-CHAIN HTLC wizard
//     (xswap.js: quote -> lock BTC -> propose -> anchor gate -> claim -> poll).
//
// The proven same-chain backend internals are preserved verbatim:
//   - dexPost to /v1/markets|market/price|trade/preview|trade/propose|trade/complete
//   - the SwapRequest via Wollet.seqdexSwapRequest(...)
//   - sign = new Pset -> addDetails(wollet) -> Signer.sign -> stripBip32 -> complete
//     (with the self-broadcast fallback). stripBip32 + the signing sequence are
//     untouched.
//
// Project UI rules honoured (all five, see the composer code):
//  • Buy AND sell of ALL assets, symmetric — the flip is the only direction control.
//  • SEQ/tSEQ equal standing — just one searchable row in the asset pickers.
//  • Open fee market — a first-class fee-asset selector, valued in native-equiv + ref.
//  • Reference currency — every amount (pay/receive/fee/rate) carries an "≈ <ref>" value.
//  • Anchor-aware finality — "settles in ~1 block · anchor-bound to Bitcoin"; never "instant".
// ---------------------------------------------------------------------------

import * as seqob from './seqob.js';
import { secp256k1 } from './btc.js';
// The byte-exact passive-CLOB covenant stack: place a funded resting order that
// fills permissionlessly (even while the wallet is offline), and settle an inbound
// match as the taker. Everything routes through these; no crypto is hand-rolled here.
import { planPlaceOrder, buildCovenantTerms, settleFill as covSettleFill, planRefund as covPlanRefund, cancel as covCancel } from './covenant-order.js';
import { verifyAgainstSPK as covVerifyAgainstSPK } from './covenant.js';
import { makeCovenantHooks, makerPayout } from './covenant-fill-host.js';
import { computeRate, orderExpiry, deriveOtherField, buildCovenantOffer, fillRestSplit } from './covenant-flow.js';
// HONEST per-asset Lightning-rail gating (offer LN only with a real usable channel).
import { railAvailability } from './ln-rail.js';
// Pure predicate only — LSP *transport* still reaches this module solely through the injected `L`
// handle. This reads an already-fetched job body and says whether it is still being driven.
import { jobIsDead } from './seqln.js';
// The mixed-rail (submarine) swap state machine + localStorage resume (fund-safety:
// an in-flight on-chain HTLC leg must survive a reload so it can be refunded).
import * as sub from './submarine.js';
// The SBTC bridge client (the silent peg for resting on-chain-BTC LIMIT orders). Allocates
// peg-in/peg-out addresses only; the wallet's own signed sends move the funds. See sbtc.js.
import * as sbtc from './sbtc.js';
// RAIL-BLIND TAKE routing (pure, browser-safe — no node built-ins): pick the best-price offer across
// rails (bestFor), build the settlement match (matchFromTake), and when the best offer's rail CROSSES
// the taker's, drive the LSP bridge (/swap {bridge:true}) instead of dead-ending on "no maker for your
// rail". ONE source of truth with the LSP + the pure driver (tooling/lsp/*).
import { planSettlement, chooseSettlementPath } from './tooling/lsp/settlement-router.mjs';
import { bestFor } from './tooling/lsp/unified-book.mjs';
import { matchFromTake, makerRailsFromOffer, describeBridge, bridgedTakeSupported } from './tooling/lsp/bridge-driver.mjs';
// P2P SUBMARINE taker client (both directions) + the LSP payer leg-bridge client (the buy fallback). The
// rail-crossing matrix settles PEER-TO-PEER whenever the maker is interactive + can accept BTC-LN, and the
// LSP leg-bridge ONLY on a genuine mismatch (an on-chain-only / passive maker). See subswap.js.
import { runTakerReverseSubmarine, runTakerSubmarine, runLspPayerBridge, claimReverseSeqLeg, resumeReversePay, dispatchSubswap, sizeSubswapTake, walkBook, verifySeqLeg as verifySubswapSeqLeg } from './subswap.js';

let C = null;            // injected app context (see index.html initSwapTab)
// The order-book client, indirected so headless tests can script the relay (REST + WS)
// without a network. Production code never reassigns it; __test__.setSeqobClient overlays
// fetchBook/openRelay with doubles while everything else stays the real module.
let OB = seqob;
let X = null;            // the cross-chain route handle ({ openFromComposer, renderXswap, hasInFlight })
let L = null;            // the Lightning (LSP) route handle ({ available, swap, status, finalityCopy })
let MARKETS = [];        // legacy RFQ markets (kept only to seed the picker; routing is order-book)
let XMARKETS = [];       // cross-chain: [{ btc_asset, seq_asset, ... }] (BTC<->asset)
let LAST_QUOTE = null;   // the priced/oriented same-chain legs for the current composer state
let BOOK = { offers: [], pair: null };   // the resting offers for the selected same-chain pair
let XBOOK = { offers: [], seqAsset: null, payIsBtc: true };   // resting cross offers for the selected BTC<->asset pair
let UBOOK = null;   // the UNIFIED book (on-chain + LN merged, rail-tagged) for the pair, from the LSP /book/unified
let XMAKE = null;   // the wallet's OWN live resting cross offer (maker) + its settlement state, if any
// D2 (T13): per-order fill progress from the relay's order_status stream — { offer_id: {active, status} }
// where `active` is the remaining base atoms after any partial fills. Populated live via onCovOrderStatus
// while the wallet is open; renderMyOrders shows "~N% filled" when active < the order's base amount.
const _ordStatus = {};
// Trades the user DISMISSED this session (kept live + resumable, just not force-shown). Gated in
// renderSwap so a dismissed swap returns to the composer instead of bouncing straight back to its
// stepper; the "Active trades" card (renderInFlightCard) reopens any of them. Session-only: a reload
// clears it, so an in-flight trade force-shows again on load (fund-safety: never silently lost).
const _dismissed = new Set();
// A persistent log of the user's OWN completed trades (P5.1): every settle path the wallet drives
// records one durable receipt so the terminal has a real trade HISTORY, not just live status. Kept
// PER-WALLET (histKey) so one browser holding several wallets never blends their fills, deduped by a
// per-trade id, capped at a long tail, and exportable (CSV/JSON). Summaries + the user's own
// txids/preimage only (no signing keys) — safe to persist locally and hand back to the user.
const HIST_KEY = 'swk.dex.history';   // legacy/global key; folded into the active wallet's key on first read
const HIST_CAP = 400;                 // durable tail (the old 15-row cap lost history); the view slices for display
// A stable per-wallet suffix from the wallet descriptor (FNV-1a -> 8 hex). Falls back to the maker id,
// then 'default', when no wallet/context is wired yet — so a call before openWallet never throws.
function walletTag(){
  let src = null;
  try { src = (C && C.wollet && C.wollet.descriptor) ? C.wollet.descriptor().toString() : null; } catch {}
  if (!src){ try { src = makerPubHex(); } catch {} }
  if (!src) return 'default';
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < src.length; i++){ h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function histKey(){ return HIST_KEY + '.' + walletTag(); }
function loadHist(){
  try {
    const k = histKey();
    let raw = localStorage.getItem(k);
    // One-time migration: fold the pre-P5.1 global history into the first wallet that loads (guarded so
    // it never duplicates across wallets), so upgrading a live wallet doesn't drop its recent trades.
    if (raw == null && !localStorage.getItem('swk.dex.history.migrated')){
      const legacy = localStorage.getItem(HIST_KEY);
      if (legacy != null) localStorage.setItem(k, legacy);
      try { localStorage.setItem('swk.dex.history.migrated', '1'); } catch {}
      raw = legacy;
    }
    return JSON.parse(raw || '[]') || [];
  } catch { return []; }
}
function saveHist(h){ try { localStorage.setItem(histKey(), JSON.stringify(h.slice(0, HIST_CAP))); } catch {} }
// ---------------------------------------------------------------------------
// Hidden assets (F2). Hiding is VISUAL DECLUTTERING ONLY: a hidden asset keeps its
// full standing everywhere that matters — it still counts toward the reference-currency
// headline total, still trades, and is still FOUND by ticker search or a pasted id in
// the asset pickers. It just leaves the default balance list + default picker rows.
// Persisted per wallet (same fingerprint idiom as the trade history key), so one
// browser holding several wallets never blends their hidden sets. Native BTC (the
// parent-chain first-class asset) can never be hidden.
// ---------------------------------------------------------------------------
const HIDDEN_KEY = 'swk.hidden';
function hiddenKey(){ return HIDDEN_KEY + '.' + walletTag(); }
export function hiddenAssets(){
  try { return new Set(JSON.parse(localStorage.getItem(hiddenKey()) || '[]')); } catch { return new Set(); }
}
export function isAssetHidden(hex){ return !!hex && hex !== 'BTC' && hiddenAssets().has(hex); }
export function setAssetHidden(hex, on){
  if (!hex || hex === 'BTC') return;   // BTC is the parent chain: always visible, never hideable
  const s = hiddenAssets();
  if (on) s.add(hex); else s.delete(hex);
  try { localStorage.setItem(hiddenKey(), JSON.stringify([...s])); } catch {}
}
// Split a balance-list key set into the visible main list and the collapsed hidden
// section. A hidden asset whose TOTAL is zero appears in neither (the balance list
// already elides zero rows, and an invisible zero row has nothing to unhide toward
// — it comes back by itself the moment it holds a balance again, still hidden).
// totalAtomsOf(hex) -> the row's combined total (on-chain + Lightning), as the
// balance renderer computes it; BTC is never partitioned out.
export function partitionHidden(keys, totalAtomsOf){
  const s = hiddenAssets(), visible = [], hidden = [];
  for (const h of keys || []){
    if (h !== 'BTC' && s.has(h)){
      if (big(totalAtomsOf ? totalAtomsOf(h) : 1n) > 0n) hidden.push(h);
    } else visible.push(h);
  }
  return { visible, hidden };
}
// Derive the pair label, side (buy/sell of the pair's base), price (quote per base) and base size for a
// receipt from the trade's pay/receive assets + atom amounts. Pure/display; used to enrich logTrade.
function tradeMeta(pay, receive, payAtoms, recvAtoms){
  try {
    if (!pay || !receive) return {};
    const { base, quote } = canonicalPair(pay, receive);
    const bm = metaOf(base), qm = metaOf(quote);
    const baseIsReceive = (base === receive);
    const baseAtoms  = big(baseIsReceive ? recvAtoms : payAtoms);
    const quoteAtoms = big(baseIsReceive ? payAtoms  : recvAtoms);
    const baseU  = Number(baseAtoms)  / Math.pow(10, bm.precision || 0);
    const quoteU = Number(quoteAtoms) / Math.pow(10, qm.precision || 0);
    return { pair: bm.ticker + '/' + qm.ticker, side: baseIsReceive ? 'buy' : 'sell',
             price: baseU > 0 ? quoteU / baseU : null, size: baseU || null, sizeTicker: bm.ticker };
  } catch { return {}; }
}
export function logTrade(e){
  if (!e || !e.id) return;
  try {
    const h = loadHist();
    const prevIdx = h.findIndex(x => x.id === e.id);
    // Once per trade — UNLESS the caller marks an UPGRADE. A settle path re-logs the SAME id
    // to replace its fund-time row (e.g. 'EURX locked' -> 'Bought GOLD with EURX'); the plain
    // dedupe silently dropped that second write, so a settled buy sat in the history forever
    // as '<QUOTE> locked' (task 19b, seen live on the quote-shape sub-asset BUY).
    if (prevIdx >= 0 && !e.upgrade) return;
    const prev = prevIdx >= 0 ? h.splice(prevIdx, 1)[0] : null;
    // A byte-identical re-log is the resume tick re-running an already-terminal path, not a new
    // transition: keep the row fresh but never re-pop the settle card (it re-appeared over the
    // composer minutes after every settle, swallowing clicks).
    const identicalRelog = !!(prev && prev.status === (e.status || '') && prev.title === (e.title || ''));
    const at = (prev && prev.at) || e.at || Date.now();
    h.unshift({
      id: e.id, title: e.title || '', status: e.status || '',
      txid: e.txid || (Array.isArray(e.txids) && e.txids[0]) || (prev && prev.txid) || null, at, ts: e.ts || (prev && prev.ts) || at,
      // Enriched, durable receipt fields (all optional; a path that can't supply one leaves it blank —
      // honest, not fabricated). pair/side/price/size/fee/rail feed the "Your trades" view + the export.
      pair: e.pair || null, side: e.side || null,
      price: (e.price != null && isFinite(e.price)) ? e.price : null,
      size: (e.size != null) ? e.size : null, sizeTicker: e.sizeTicker || null,
      fee: (e.fee != null) ? e.fee : null, feeTicker: e.feeTicker || null,
      rail: e.rail || null, preimage: e.preimage || null,
      txids: Array.isArray(e.txids) ? e.txids.filter(Boolean).slice(0, 12) : (e.txid ? [e.txid] : []),
    });
    saveHist(h);
    try { renderInFlightCard(); } catch {}   // surface the new receipt in the trades view immediately
    // Settle card (task 21b): a caller that marks a genuine settlement gets the one-shot
    // completion card. Opt-in by flag — the fund-time and refund rows must never pop one.
    if (e.card && !identicalRelog){ try { showSettleCard(h[0], e); } catch {} }
  } catch {}
}
// P5.1 — export the user's durable trade history as CSV or JSON (a file they keep). Reads the SAME
// per-wallet records the view renders; purely local (no network), only the user's own txids/preimage.
function exportTrades(fmt){
  const h = loadHist();
  if (!h.length){ try { C.toast && C.toast('No trades to export yet.'); } catch {} return; }
  const iso = (ms) => { try { return new Date(ms).toISOString(); } catch { return ''; } };
  let blob, name;
  if (fmt === 'json'){
    blob = new Blob([JSON.stringify(h, null, 2)], { type: 'application/json' });
    name = 'sequentia-trades.json';
  } else {
    const cols = ['time', 'pair', 'side', 'price', 'size', 'size_asset', 'fee', 'fee_asset', 'settles', 'status', 'txids'];
    const cell = (v) => { const s = (v == null ? '' : String(v)); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.join(',')];
    for (const e of h) lines.push([iso(e.ts || e.at), e.pair, e.side, e.price, e.size, e.sizeTicker, e.fee, e.feeTicker, railLabel(e.rail), e.status, (e.txids || []).join(' ')].map(cell).join(','));
    blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    name = 'sequentia-trades.csv';
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 4000);
  } catch (err){ try { C.toast && C.toast('Export failed: ' + (err && err.message || err)); } catch {} }
}

// --- Per-trade progress narrative (task 21a) --------------------------------------
// Typical stage durations: honest rough figures for THIS deployment (an LN hop is seconds, a
// Sequentia block ~1 minute, a testnet4 Bitcoin block 10-60+ minutes), keyed by the record
// states the drivers actually set. Absent key = no honest figure; show elapsed alone.
const STAGE_TYPICAL_S = {
  starting: 15, 'awaiting-lock': 90, verifying: 10, verified: 120, 'anchor-wait': 120,
  paying: 15, held: 120, confirming: 1800, claiming: 90, funding: 30, settling: 90,
  funded: 90, holding: 15,
};
function fmtDur(ms){
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 90) return s + 's';
  const m = Math.round(s / 60); if (m < 90) return m + 'm';
  return (Math.round(m / 6) / 10) + 'h';
}
// "· usually ~Ns · Ms elapsed", appended to a record's status line. Reads the stage timestamp
// the save funnels stamp (stampStages), so no driver has to remember to set it.
function stageNarrative(rec){
  if (!rec) return '';
  const t = STAGE_TYPICAL_S[rec.state];
  let out = '';
  if (t) out += ' · usually ~' + (t < 90 ? t + 's' : Math.round(t / 60) + 'm');
  if (rec.stage_since_ms > 0) out += ' · ' + fmtDur(Date.now() - rec.stage_since_ms) + ' elapsed';
  return out;
}
let _narrTick = null;   // the slow elapsed-refresh timer (renderInFlightCard)
// Stamp stage_since_ms on every state TRANSITION, persisted with the record. Lives in the save
// funnels — the one path every transition already goes through — so it cannot be forgotten.
function stampStages(arr){
  for (const r of (arr || [])){
    if (!r) continue;
    if (r.stage_state !== r.state || !r.stage_since_ms){ r.stage_state = r.state; r.stage_since_ms = Date.now(); }
  }
}

// --- Settle card (task 21b) --------------------------------------------------------
// ONE dismissable completion card when a trade genuinely settles, rendered from the SAME
// receipt logTrade persists: both legs in their own tickers, short linked txids / preimage,
// total elapsed when the caller knows it. The history row stays as before — this is a
// surface, not a second record. Opt-in via logTrade's `card` flag (fund-time and refund
// rows must never pop one). DOM-only; headless harnesses without document no-op.
let _settleCard = null;
function showSettleCard(row, e){
  if (typeof document === 'undefined' || !document.body || !C || !C.el) return;
  try { if (_settleCard) _settleCard.remove(); } catch {}
  _settleCard = null;
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Trade complete'));
  const kv = (k, v) => { const d = C.el('div','kv'); d.appendChild(C.el('span','k',k));
    if (typeof v === 'string') d.appendChild(C.el('span','v',v)); else d.appendChild(v);
    card.appendChild(d); };
  kv('Trade', row.title || row.pair || 'Trade');
  // Both legs in their own tickers when the receipt carries them: size/sizeTicker is the
  // base leg; price × size re-derives the quote leg in the pair's own quote ticker.
  if (row.size != null && row.sizeTicker)
    kv(row.side === 'sell' ? 'You paid' : 'You received', trim(Number(row.size)) + ' ' + row.sizeTicker);
  const qt = (row.pair && row.pair.indexOf('/') > 0) ? row.pair.split('/')[1] : null;
  if (row.price != null && row.size != null && qt)
    kv(row.side === 'sell' ? 'You received' : 'You paid', trim(Number(row.price) * Number(row.size)) + ' ' + qt);
  // Short, linked txids (the existing txLink idiom: Sequentia txs on /explorer, parent-chain
  // txs on /testnet4 — the caller names which of its txids are parent-chain).
  const parent = new Set(((e && e.parentTxids) || []).map(String));
  for (const t of (row.txids || [])){
    const v = C.el('span','v mono');
    const a = C.el('a','', String(t).slice(0, 18) + '…');
    a.href = (parent.has(String(t)) ? '/testnet4/tx/' : '/explorer/tx/') + t;
    a.target = '_blank'; a.rel = 'noopener';
    v.appendChild(a); kv('Transaction', v);
  }
  if (row.preimage) kv('Preimage', String(row.preimage).slice(0, 18) + '…');
  if (e && Number(e.elapsed_ms) > 0) kv('Total time', fmtDur(e.elapsed_ms));
  const act = C.el('div','row'); act.style.marginTop = '12px';
  const close = C.el('button','primary','Close');
  close.onclick = () => { try { modal.remove(); } catch {} _settleCard = null; };
  act.appendChild(close); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  modal.onclick = (ev) => { if (ev.target === modal){ try { modal.remove(); } catch {} _settleCard = null; } };
  _settleCard = modal;
}

// A terminal-failure detail the user can actually act on: the reassurance sentence PLUS the
// translated reason. Hiding the reason in the console ("technical detail stays in the console")
// turned every distinct failure - maker busy, no route, refused terms - into the same opaque
// sentence, which is exactly the discarded-reason bug class this wallet keeps re-fixing.
function failDetail(e){
  const base = 'This trade could not be completed - your funds are safe.';
  try {
    const why = e ? String(C.prettyErr ? C.prettyErr(e) : (e.message || e)) : '';
    return why ? (base + ' Reason: ' + why) : base;
  } catch { return base; }
}

// Same-chain DEX swaps receive TRANSPARENTLY by default (principle #6: transparent-by-default);
// the user can OPT IN to a confidential (blinded) receive. The opt-in is SESSION-scoped, never
// persisted: the control's own copy promises "off by default", and an earlier build that latched
// a single tick into localStorage forever turned one opt-in into a permanent silent default —
// and quietly filled the wallet with blinded UTXOs that the all-explicit covenant paths cannot
// spend. Purge that legacy key so old profiles come back to the documented default.
let _confidentialReceive = false;
try { localStorage.removeItem('swk.dex.confidentialReceive'); } catch {}
export function setConfidentialReceive(on){ _confidentialReceive = !!on; }
export function confidentialReceive(){ return _confidentialReceive; }
// This wallet's own receive address for a same-chain DEX credit/refund: transparent (toUnconfidential)
// by DEFAULT, blinded only when the user opted in. Was previously blinded unconditionally (a #6 bug).
function covReceiveAddr(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  return (_confidentialReceive ? a : (a.toUnconfidential ? a.toUnconfidential() : a)).toString();
}

// ---------------------------------------------------------------------------
// Book namespace: Unblinded (transparent, default, live) vs Blinded (confidential).
// ---------------------------------------------------------------------------
// The Swap tab reads from + posts to ONE of two DISTINCT relay books. Transparent
// is the default (principle #6: transparent-by-default); the user opts into the
// blinded book with the toggle. The blinded book is a SEPARATE namespace on the
// relay (?confidential=1 / a signed confidential=true tag on the offer) that
// matches confidential-vs-confidential only, so BOTH swap legs blind on-chain and
// the public swap ratio never leaks a confidential amount. Persisted wallet-wide.
let _book = 'public';
try { _book = localStorage.getItem('swk.dex.book') === 'confidential' ? 'confidential' : 'public'; } catch {}
function isConfBook(){ return _book === 'confidential'; }
export function dexBook(){ return _book; }
function persistBook(){ try { localStorage.setItem('swk.dex.book', _book); } catch {} }

// blech32 charset (same symbol table as bech32; blech32 differs only in its 12-char
// checksum, which we do not need to verify — the address is minted by our own wasm).
const _B32_CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function _convertBits(data, from, to){
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data){ acc = (acc << from) | v; bits += from; while (bits >= to){ bits -= to; out.push((acc >> bits) & maxv); } }
  return out;   // pad=false: leftover bits are dropped (correct for decode)
}
// Extract the 33-byte confidential blinding pubkey (hex) embedded in a blech32
// confidential (tsqb1…/sqb1…) address. Returns '' if the address is not blech32 or
// cannot be parsed; the caller still sets the signed confidential tag, so a failed
// extraction never mis-routes the book (the relay can also recover the key from the
// blech32 recv address itself). blech32 data = [witver] + convertbits(blinding_pub(33)
// || witness_program, 8, 5) + checksum(12); we drop the 12-char checksum + witver
// symbol, convert 5->8, and take the first 33 bytes.
function blindingPubFromAddr(addr){
  try {
    const s = String(addr).toLowerCase();
    const pos = s.lastIndexOf('1');
    if (pos < 1) return '';
    const vals = [];
    for (const ch of s.slice(pos + 1)){ const d = _B32_CS.indexOf(ch); if (d < 0) return ''; vals.push(d); }
    if (vals.length < 12 + 1) return '';
    const payload5 = vals.slice(1, vals.length - 12);   // drop witver symbol + 12-char checksum
    const bytes = _convertBits(payload5, 5, 8);
    if (bytes.length < 33) return '';
    return bytes.slice(0, 33).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}
// This wallet's own BLINDED (blech32) receive address + its blinding pubkey, for a
// confidential-book offer/lift. Both legs must blind, so a confidential offer always
// publishes the blinded form (never toUnconfidential).
function blindedReceive(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const addr = a.toString();
  return { address: addr, blindingPub: blindingPubFromAddr(addr) };
}

// The wallet's SeqOB MAKER identity: a stable per-browser key that signs resting
// offers + doubles as the E2E session key. It is NOT a fund key (funds move via the
// on-chain co-sign with the wallet's real keys), so persisting it locally is safe.
function makerPriv(){
  let h = (typeof localStorage !== 'undefined') && localStorage.getItem('seqobMakerKey');
  if (!h || !/^[0-9a-f]{64}$/.test(h)){
    const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a);
    h = [...a].map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem('seqobMakerKey', h); } catch {}
  }
  return seqob.hexToBytes(h);
}
function makerPubHex(){ return seqob.bytesToHex(secp256k1.getPublicKey(makerPriv(), true)); }
const EST_SWAP_VSIZE = 1500n;   // explicit same-chain swap fee estimate (vbytes)

// Composer state. payAsset/receiveAsset are asset hexes (or 'BTC' for the parent leg).
const S = {
  payAsset: null, receiveAsset: null,
  edited: 'pay',          // which side the user last typed ('pay' | 'receive')
  feeAsset: null,         // chosen fee asset hex (defaults to POLICY_HEX)
  quoting: false,
  // TWO independent settlement PREFERENCES the user sets per order: how they PAY and how
  // they RECEIVE, each 'ln' (Lightning) or 'chain' (on-chain). RAIL-BLIND MODEL (spec §5):
  // these NEVER touch the book or matching — the book matches on price/asset/size only.
  // They are honored at settlement per leg (P2P when both sides agree, else the atomic
  // seqob-bridge). They start NULL — there is NO default (spec §6.5): an order cannot be
  // placed until both are chosen, on EVERY pair (same-chain assets can move over SeqLN too).
  payRail: null, recvRail: null,
  // MARKET = walk the book at the best executable price, partial-fill what's there, cancel
  // any remainder (taker). LIMIT = rest a signed order at YOUR price until crossed (maker);
  // the two amounts are independent, their ratio is the price. Always available on every
  // pair (spec §4/§6.3). Default MARKET; the toggle never disappears.
  mode: 'take',
  // KEEP RESTING WHILE OFFLINE (spec §5 / SBTC design §5). Relevant ONLY for an on-chain-BTC-pay
  // LIMIT order: ON -> silently peg the maker's BTC to SBTC and rest it in a covenant (survives
  // the wallet going offline), peg back out to real BTC on fill; OFF -> a native-BTC HTLC (needs
  // the wallet online). Default ON. Market orders and any Lightning leg IGNORE this — pure native
  // BTC. The placement path reads keepResting only when payingBtcOnChain(route) && S.mode==='post'.
  keepResting: true,
};
let INSTANT = {};    // ticker -> { spendable, receivable } atoms (best-effort from the LSP /status)
let LAST_MID = null; // { price, cross, base, quote } for the current pair — feeds the pair bar + cost line
// The last rendered book AGGREGATED into price LEVELS (best-first per side), in the SAME display frame
// as the ladder (base/quote from pairDir). Feeds the MARKET-mode price field's sweep-estimate (VWAP) +
// slippage bound (paintPriceField/sweepEstimate). Each level: { price (quote per base), size (base
// units), sizeAtoms }. Set by renderBook (same-chain) + renderXBook (cross); staleness is checked by
// comparing base/quote against the current pairDir so a mid-flip never yields a wrong-frame estimate.
let LAST_LADDER = null;

// ---- canonical price direction (C1) ----------------------------------------------------------------
// A pair is priced ONE way — "1 base = N quote" (quote per base) — no matter which side the user is
// paying, so the book / pair bar / rate line / trades / modal never disagree. base/quote are chosen by
// a fixed quote-RANK: the numeraire (BTC, then fiat stables, then the Sequence token, then commodities)
// is the QUOTE, so a pair reads the same whether you buy or sell. The pair-bar flip toggle (S.priceFlip)
// swaps the DISPLAY only.
function _quoteRank(hex){
  if (hex === 'BTC') return 1000;
  const t = String((C.assetMeta(hex) || {}).ticker || '').toUpperCase();
  // ONLY genuine units of account are numeraires (quotes): BTC + the fiat stablecoins. The Sequence
  // token (SEQ/tSEQ) is NOT a numeraire — it's just another issued asset with EQUAL standing (Principle 3),
  // so it sits in the same generic "base" tier as the commodities and any unknown asset, tiebroken by id.
  const r = { USDX:900, EURX:890, FEEUSD:880, USDT:870, USDC:865, USD:860 };
  return (t in r) ? r[t] : 400;
}
// {base, quote} for an UNORDERED pair — the higher-rank asset is the QUOTE (numeraire). Deterministic
// (a rank tie falls back to the asset id) so a pair's direction never flips with the buy/sell side.
function canonicalPair(a, b){
  if (!a || !b) return { base: a || b, quote: b || a };
  const ra = _quoteRank(a), rb = _quoteRank(b);
  if (ra !== rb) return ra > rb ? { base: b, quote: a } : { base: a, quote: b };
  return String(a) < String(b) ? { base: a, quote: b } : { base: b, quote: a };
}
// The pair's DISPLAY direction, honouring the user's flip toggle.
function pairDir(a, b){
  const d = canonicalPair(a, b);
  return S.priceFlip ? { base: d.quote, quote: d.base } : d;
}
// Format "1 base = N quote" from a RECEIVE-per-PAY scalar (what the composer/quote paths natively have).
// qpb (quote per base) = the receive-per-pay rate when base==pay, else its inverse.
function ratePerPayToLine(pay, receive, recvPerPay){
  const { base, quote } = pairDir(pay, receive);
  const bm = metaOf(base), qm = metaOf(quote);
  const qpb = (base === pay) ? recvPerPay : (recvPerPay > 0 ? 1 / recvPerPay : 0);
  return { base, quote, bt: bm.ticker, qt: qm.ticker, qpb, str: `1 ${bm.ticker} = ${fmtPrice(qpb)} ${qm.ticker}` };
}
// "1 base = N quote" for a concrete trade of payU pay -> recvU receive (DISPLAY units). null if no amounts.
function priceLineStr(pay, receive, payU, recvU){
  if (!(payU > 0 && recvU > 0)) return null;
  return ratePerPayToLine(pay, receive, recvU / payU).str;
}
// The last LSP /status channel snapshot + provisioned-node state — the GROUND TRUTH the
// composer gates the Lightning rail on (a real per-asset channel, NOT "LSP configured").
// Refreshed by refreshInstant(); read synchronously by findRoute/updateRails.
let LNSTATUS = { channels: [], funding: null };
let LNPROV = {};     // provisionedState(): assetHexLower -> { connected, phase }
// P3.5 — the LSP-advertised 0-conf front ceiling on the BTC leg, in SATS (the SINGLE source of truth for
// frontCapAtoms). null until the first /status read; frontCapAtoms falls back to the box default then.
let MAX0CONF_SATS = null;
// P3.2 — the LSP-advertised bridge capability (which rail-crossing shapes it settles). Informational: the
// wallet's own pre-Review check uses the SHARED pure predicate (bridgedTakeSupported), so a stale/absent
// value never lets it promise an unsupported bridge.
let BRIDGECAPS = null;
// P5.4a — shared terminal constants: ONE source of truth so the market-slippage bound, the covenant
// min-lot copy, the front cap, and the dust floor track the backend instead of being independent
// literals here. Seeded with the historical defaults so nothing breaks before the first /status read
// (or if /status is unreachable / an older LSP omits the block); refreshInstant() overlays whatever the
// LSP advertises in st.constants. marketSlip feeds BOTH the walk floor and the displayed slippage bound
// (they can't disagree); frontCapSats mirrors mixed_max_0conf_sats. minLotBps is DISPLAY-ONLY — the
// covenant leaf bakes its min-lot at placement + re-derives it at fill, so covenantMinLot() stays a
// consensus-frozen constant and MUST NOT read this mutable value (a drift would strand a resting order).
const CONFIG = { marketSlip: 0.15, minLotBps: 10, frontCapSats: null, dustSats: 546 };
// Overlay the LSP /status `constants` block onto CONFIG, validating each field so a garbage/absent value
// leaves the safe default in place. Called from refreshInstant with the parsed /status.
function applyStatusConstants(st){
  const c = st && st.constants;
  if (!c || typeof c !== 'object') return;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ms = num(c.market_slip);   if (ms != null && ms > 0 && ms < 1) CONFIG.marketSlip = ms;
  const mb = num(c.min_lot_bps);   if (mb != null && mb >= 0) CONFIG.minLotBps = mb;
  const ds = num(c.dust_sats);     if (ds != null && ds >= 0) CONFIG.dustSats = ds;
  const fc = num(c.front_cap_sats);
  if (fc != null && fc >= 0){ CONFIG.frontCapSats = fc; if (MAX0CONF_SATS == null) MAX0CONF_SATS = fc; }
}
let MIXED = null;    // the in-flight mixed-rail (submarine) swap (persisted; see submarine.js)
const MIXED_KEY = 'swk.sequentia.submarine';   // localStorage key for the in-flight submarine swap

const TRADE_TYPE = { BUY: 0, SELL: 1 };   // seqdex.v1 TradeType enum

// POST <DEX>/v1/... as JSON; returns parsed JSON (or throws a useful message).
async function dexPost(path, body){
  const r = await fetch(C.DEX + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) {
    const msg = (j && (j.message || j.error)) || j._raw || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j;
}

const big = v => BigInt(v == null ? 0 : v);

// grpc-gateway emits camelCase but accepts either case; read a field by either name.
function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
function normMarket(m){
  const mk = pick(m, 'market') || m;
  return { base_asset: pick(mk, 'base_asset', 'baseAsset'),
           quote_asset: pick(mk, 'quote_asset', 'quoteAsset') };
}

// ---------------------------------------------------------------------------
// init / render
// ---------------------------------------------------------------------------
export function initSwap(ctx){
  C = ctx;
  X = ctx.xroute || null;     // cross-chain bridge wired in index.html (see initSwapTab)
  L = ctx.ln || null;         // Lightning (LSP) bridge wired in index.html (see initSwapTab)
  seqob.setSeqobBase(C.SEQOB || '/seqob');   // the order-book relay (same-origin proxy)
  const { $ } = C;
  if ($('swReview') && !$('swReview')._wired){
    $('swReview')._wired = true;
    $('swFlip').onclick  = onFlip;
    $('swMax').onclick   = onMax;
    $('swReview').onclick = onReview;
    $('swPayPick').onclick  = () => openPicker('pay');
    $('swRecvPick').onclick = () => openPicker('receive');
    $('swFeePick').onclick  = openFeePicker;
    // Two independent rail choosers (Pay from / Receive to), shown only for a
    // BTC<->asset pair when the on-device signer is live (see updateRails).
    wireRailSeg('swPayRailSeg', 'pay');
    wireRailSeg('swRecvRailSeg', 'recv');
    // Take / Post chooser (switching to Post unlinks the two amount fields).
    wireModeSeg();
    // The dedicated price field (§6.4): editable in Limit (drives the derived amount), read-only in Market.
    wirePriceInput();
    // Unblinded / Blinded book toggle (switches which relay namespace we read + post to).
    wireBookSeg();
    // P5.2 — markets overview (pair discovery) toggle.
    if ($('swMarketsBtn')) $('swMarketsBtn').onclick = toggleMarketsView;
    if ($('swXBack')) $('swXBack').onclick = () => { if (X && X.hasInFlight && X.hasInFlight()) _dismissed.add('cross'); showCross(false); renderSwap(); };
    if ($('swRBack')) $('swRBack').onclick = () => { if (X && X.hasReverseInFlight && X.hasReverseInFlight()) _dismissed.add('reverse'); showReverse(false); renderSwap(); };
    // Live re-quote as the user types. The edited side is the "fixed" leg; the
    // other side is quoted. Debounced so we don't hammer the daemon per keystroke.
    wireAmount($('swPayAmt'), 'pay');
    wireAmount($('swRecvAmt'), 'receive');
    // Reference-currency hints under each amount, valued in that side's asset.
    // Keep the returned updaters so we can re-value the hints when the asset (not
    // the typed value) changes, WITHOUT dispatching a synthetic 'input' (which
    // would falsely re-arm the requote/edited-side logic above).
    _payHint  = C.attachRefHint($('swPayAmt'),  () => S.payAsset || '');
    _recvHint = C.attachRefHint($('swRecvAmt'), () => S.receiveAsset || '');
  }
}
let _payHint = null, _recvHint = null;

let _quoteTimer = null;
function wireAmount(input, side){
  input.addEventListener('input', () => {
    S.edited = side;
    input._userTyped = true;   // this side now holds USER input — never overwrite it
    // TAKE mode: the two amounts are LINKED (one price), so editing this side makes the OTHER
    // side a derived value again — clear its user-typed flag so a requote can refresh it. POST/
    // limit mode: both amounts are independent user input (their ratio IS the limit price), so
    // leave the other side's flag alone. This is what lets a fresh keystroke on one side win
    // AND still re-derive the other, without ever stomping a value the user actually typed.
    if (S.mode !== 'post'){
      const other = side === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
      if (other) other._userTyped = false;
    }
    // P2.6 price-field interplay ("respect whichever the user is actively typing"):
    //  • TAKE: the price is a read-only sweep readout — never a user value; clear its flag so it repaints.
    //  • LIMIT with a user-set price: this amount is the SIZE anchor -> derive the OTHER amount from the
    //    held price (so typing a size after a price fills the total, and the price is NOT wiped).
    //  • LIMIT with no user price: the two amounts define the price -> paintPriceField reads their ratio.
    const _pf = C.$('swPriceAmt');
    const priceHeld = (S.mode === 'post') && !!(_pf && _pf._userTyped);
    if (S.mode !== 'post' && _pf) _pf._userTyped = false;
    LAST_QUOTE = null;
    setReviewEnabled(false);
    // Instant auto-fill: derive the other leg NOW from the last-known book price (no network), so it
    // fills as you type instead of after the debounce + fetch. TAKE only (LIMIT's two sides are the
    // user's own independent price). The debounced requote below then refreshes the book and finalizes
    // the quote — this is just a snappy preview that the requote corrects if the book moved.
    if (S.mode !== 'post' && _composeBest && _composeBest.pay === S.payAsset && _composeBest.receive === S.receiveAsset && _composeBest.best){
      try { applyComposeDerivation(S.payAsset, S.receiveAsset, _composeBest.best); } catch {}
    } else if (priceHeld){
      try { applyPriceEdit(); } catch {}   // LIMIT: size × held price -> the other amount (price preserved)
    }
    try { paintPriceField(); } catch {}   // snappy price readout as you type (requote repaints it too)
    clearTimeout(_quoteTimer);
    _quoteTimer = setTimeout(() => requote().catch(()=>{}), 220);
  });
}
// The last book best-price (receive-per-pay), cached per pair by requoteSame so a keystroke can
// derive the opposite leg instantly (see wireAmount) without waiting for the debounced re-fetch.
let _composeBest = null;
// Programmatically set a field's value and mark it NOT user-typed (so the other
// side's derivation may overwrite this one; the user's own input is protected).
function setDerived(input, value){ if (!input) return; input.value = value; input._userTyped = false; }
// THE anti-clobber invariant (user keystrokes always beat derived values): write a DERIVED value
// into a field ONLY if the user has not typed there and is not editing it right now. Every seed/
// quote/derivation write across ALL rails (same-chain, cross, LN, mixed) MUST go through this — a
// raw `el.value = …` guarded on document.activeElement alone silently overwrote a value the user
// typed the instant the field lost focus (the observed "my typed amount didn't stick" bug).
function writeDerived(el, value){
  if (!el) return;
  if (el._userTyped) return;                   // user's own input — never overwrite
  if (document.activeElement === el) return;   // don't fight the field being edited right now
  el.value = value;                            // remains _userTyped=false: still a derived value
}
// Clear a DERIVED field (same invariant): never wipe a value the user typed or is editing.
function clearDerived(el){
  if (!el) return;
  if (el._userTyped || document.activeElement === el) return;
  el.value = '';
}
// Apply the anti-clobber compose rule: derive the field the user did NOT edit from
// the book's best price, WITHOUT clearing or overwriting anything the user typed.
// The empty-market case (no price) leaves both fields exactly as typed — this is
// the fix for the first-order bug where linked fields wiped each other.
function applyComposeDerivation(pay, receive, price){
  const payEl = C.$('swPayAmt'), recvEl = C.$('swRecvAmt');
  const editedEl = S.edited === 'pay' ? payEl : recvEl;
  const otherEl  = S.edited === 'pay' ? recvEl : payEl;
  const editedAsset = S.edited === 'pay' ? pay : receive;
  const otherAsset  = S.edited === 'pay' ? receive : pay;
  if (document.activeElement === otherEl) return;   // never fight the field being typed in
  // Derive across the two fields even when one/both are in ref-currency (USD) input mode. Read the
  // edited field in NATIVE units (fieldUnits converts a USD number back to native via the asset's ref
  // price), derive the other field's native value from the book price, and write it back HONORING the
  // other field's display mode (converting native->ref when it shows USD). The old early-return in ref
  // mode was the bug where switching an input to USD stopped the auto-fill entirely.
  const r = deriveOtherField({
    edited: S.edited, editedVal: fieldUnits(editedEl, editedAsset),
    otherUserTyped: !!otherEl._userTyped, price,
  });
  if (!r) return;                                    // no derivation -> leave both fields untouched
  const meta = C.assetMeta(otherAsset);
  const otherAtoms = C.parseAtoms(String(trim(r.value)), meta.precision || 0);
  if (otherEl._refMode && C.refValue){
    const rv = C.refValue(otherAsset, otherAtoms);   // native -> ref number for a USD-mode field
    setDerived(otherEl, rv ? String(trim(rv.v)) : C.fmtAtoms(otherAtoms, meta.precision || 0));
  } else {
    setDerived(otherEl, C.fmtAtoms(otherAtoms, meta.precision || 0));
  }
  paintRefHints();
}

// ---------------------------------------------------------------------------
// P2.6 — the dedicated PRICE field (§6.4): an always-present control whose CONTENTS
// change with mode (editable "your price" in Limit; a read-only sweep estimate in
// Market), never its presence. Price is quote-per-base in the ladder's display frame
// (pairDir), so it reads identically to the ladder Price column and a clicked level.
// ---------------------------------------------------------------------------
// Write `units` (NATIVE asset units, a number) into an amount field, HONORING its ⇄ ref-currency
// display mode (native vs USD), same as applyComposeDerivation. markTyped=false marks it a derived
// value (overwritable); true marks it the user's own input. Used when the PRICE field drives an amount.
function writeAmountUnits(el, asset, units, markTyped){
  if (!el) return;
  const meta = C.assetMeta(asset);
  const atoms = C.parseAtoms(String(trim(units)), meta.precision || 0);
  if (el._refMode && C.refValue){
    const rv = C.refValue(asset, atoms);
    el.value = rv ? String(trim(rv.v)) : C.fmtAtoms(atoms, meta.precision || 0);
  } else {
    el.value = C.fmtAtoms(atoms, meta.precision || 0);
  }
  el._userTyped = !!markTyped;
}
// The price field's numeric value (quote per base), or 0 if empty/invalid.
function priceFieldUnits(){
  const el = C.$('swPriceAmt'); if (!el) return 0;
  const v = parseFloat((el.value || '').trim());
  return (v > 0 && isFinite(v)) ? v : 0;
}
// Set the price field's displayed value. userTyped=false marks it a derived readout (a later paint may
// refresh it); true marks it the user's own limit price (paint preserves it until an amount is edited).
function setPriceFieldValue(price, userTyped){
  const el = C.$('swPriceAmt'); if (!el) return;
  el.value = (price > 0 && isFinite(price)) ? String(trim(price)) : '';
  el._userTyped = !!userTyped;
}
function setPriceHint(txt){ const h = C.$('swPriceHint'); if (h) h.textContent = txt || ''; }
// Quote-per-base price implied by the two current amount fields (0 if either is unset).
function currentAmountsPrice(){
  const pay = S.payAsset, receive = S.receiveAsset; if (!(pay && receive)) return 0;
  const payU = fieldUnits(C.$('swPayAmt'), pay), recvU = fieldUnits(C.$('swRecvAmt'), receive);
  if (!(payU > 0 && recvU > 0)) return 0;
  return ratePerPayToLine(pay, receive, recvU / payU).qpb;
}
// The book's inside price (the mid) in the current display frame, for the Limit placeholder / Market
// fallback. LAST_MID.price is already quote-per-base in the rendered frame.
function insidePrice(){ return (LAST_MID && LAST_MID.price > 0 && isFinite(LAST_MID.price)) ? LAST_MID.price : 0; }

// The user edited the PRICE field (Limit only): keep the last-typed amount (S.edited) as the size anchor
// and derive the OTHER amount = size × price. Mirrors deriveOtherField's receive-per-pay math, but the
// price field is the driver here (so it deliberately OVERWRITES the derived side, marking it not-typed).
function applyPriceEdit(){
  const pay = S.payAsset, receive = S.receiveAsset; if (!(pay && receive)) return;
  const price = priceFieldUnits(); if (!(price > 0)) return;
  const { base } = pairDir(pay, receive);
  const recvPerPay = (base === pay) ? price : 1 / price;   // receive-per-pay from quote-per-base
  const anchorSide = S.edited === 'receive' ? 'receive' : 'pay';
  const anchorEl = anchorSide === 'pay' ? C.$('swPayAmt') : C.$('swRecvAmt');
  const otherEl  = anchorSide === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  const anchorAsset = anchorSide === 'pay' ? pay : receive;
  const otherAsset  = anchorSide === 'pay' ? receive : pay;
  const anchorUnits = fieldUnits(anchorEl, anchorAsset);
  if (!(anchorUnits > 0)) return;                          // no size yet -> the price stands as the user's limit
  const otherUnits = anchorSide === 'pay' ? anchorUnits * recvPerPay : anchorUnits / recvPerPay;
  if (!(otherUnits > 0) || !isFinite(otherUnits)) return;
  writeAmountUnits(otherEl, otherAsset, otherUnits, false);
  paintRefHints();
}

// Walk the current book's aggregated LEVELS (LAST_LADDER, best-first) to estimate a MARKET sweep for the
// order's base size: VWAP + worst level touched. null when the book/frame is stale or empty. Buying the
// base sweeps ASKS (lowest first); selling sweeps BIDS (highest first). No size -> just the inside price.
function sweepEstimate(){
  const pay = S.payAsset, receive = S.receiveAsset;
  if (!(pay && receive) || !LAST_LADDER) return null;
  const { base } = pairDir(pay, receive);
  if (LAST_LADDER.base !== base) return null;              // ladder rendered in a different frame -> stale
  const buyingBase = (base === receive);                   // you RECEIVE the base => you are buying it
  const levels = (buyingBase ? LAST_LADDER.asks : LAST_LADDER.bids) || [];
  if (!levels.length) return null;
  const best = levels[0].price;
  const baseEl = (base === pay) ? C.$('swPayAmt') : C.$('swRecvAmt');
  const wantBase = fieldUnits(baseEl, base);
  if (!(wantBase > 0)) return { vwap: best, worst: best, best, partial: false };
  let remaining = wantBase, totBase = 0, totQuote = 0, worst = best;
  for (const lv of levels){
    if (remaining <= 0) break;
    const take = Math.min(remaining, lv.size);
    totBase += take; totQuote += take * lv.price; worst = lv.price; remaining -= take;
  }
  if (!(totBase > 0)) return { vwap: best, worst: best, best, partial: false };
  return { vwap: totQuote / totBase, worst, best, partial: remaining > totBase * 1e-9 };
}
// The Market-mode slippage bound line from a sweep estimate.
function slippageHint(est){
  if (!est || !(est.best > 0)) return '';
  if (est.partial) return 'Market · sweeps the book; your size exceeds the resting depth (the remainder cancels).';
  const slipPct = Math.abs(est.worst / est.best - 1) * 100;
  if (slipPct < 0.05) return 'Market · fills at the inside price.';
  return `Market · est. up to ${slipPct.toFixed(slipPct < 1 ? 2 : 1)}% slippage (to ${trim(est.worst)}).`;
}

// Paint the price field for the current pair + mode (§6.4). Presence is constant once a pair is chosen;
// only the contents change. LIMIT: editable, seeded with the inside price, showing the ratio of the two
// amounts unless the user is actively typing a price. MARKET: read-only, the effective sweep price +
// a slippage bound. Never fights a field the user is editing (skips the active price input).
function paintPriceField(){
  const el = C.$('swPriceAmt'); if (!el) return;
  const row = C.$('swPriceRow');
  const pay = S.payAsset, receive = S.receiveAsset;
  const show = !!(pay && receive);
  if (row) row.classList.toggle('hide', !show);
  if (!show){ el.value = ''; el._userTyped = false; setPriceHint(''); return; }
  const { base, quote } = pairDir(pay, receive);
  const bm = metaOf(base), qm = metaOf(quote);
  const unit = C.$('swPriceUnit'); if (unit) unit.textContent = `${bm.ticker}/${qm.ticker}`;
  if (document.activeElement === el) return;               // don't overwrite the field being typed in
  if (S.mode === 'post'){
    el.readOnly = false; el.disabled = false; el.removeAttribute('title');
    const inside = insidePrice();
    el.placeholder = inside > 0 ? String(trim(inside)) : '0.0';
    if (!el._userTyped){                                    // amounts drive the price unless the user typed it
      const p = currentAmountsPrice();
      el.value = p > 0 ? String(trim(p)) : '';
    }
    setPriceHint('');
  } else {
    // MARKET: the price is not the user's to set — show the effective price of what will execute, plus a
    // slippage bound walked from the book depth (where we have a ladder for it).
    el.readOnly = true; el.disabled = true; el._userTyped = false;
    el.title = 'Market orders fill at the best available price · switch to Limit to set your own.';
    const eff = currentAmountsPrice();
    const est = sweepEstimate();
    const shown = eff > 0 ? eff : (est ? est.vwap : insidePrice());
    el.value = shown > 0 ? String(trim(shown)) : '';
    setPriceHint(est ? slippageHint(est) : (shown > 0 ? 'Market · fills at the best available price now.' : ''));
  }
}
function wirePriceInput(){
  const el = C.$('swPriceAmt'); if (!el || el._wired) return; el._wired = true;
  el.addEventListener('input', () => {
    if (S.mode !== 'post') return;                          // read-only in Market (guarded; also disabled)
    el._userTyped = true;
    applyPriceEdit();
    LAST_QUOTE = null; setReviewEnabled(false);
    clearTimeout(_quoteTimer);
    _quoteTimer = setTimeout(() => requote().catch(()=>{}), 220);
  });
}

// P2.7 — collapse per-offer ladder rows into price LEVELS: one row per distinct price with size (and
// exact atoms) SUMMED, so a thick level of many small offers is ONE row and the N best LEVELS (not the
// N best offers) show with cumulative depth. Rows: { price, size, sizeAtoms?, take?, mine? }. Prices are
// keyed at 10 dp so float dust never splits a level. `take` marks the liftable (clickable) side.
function aggregateLevels(rows){
  const byKey = new Map();
  for (const r of (rows || [])){
    if (!(r.price > 0 && r.size > 0)) continue;
    const key = r.price.toFixed(10);
    let lv = byKey.get(key);
    if (!lv){ lv = { price: r.price, size: 0, sizeAtoms: 0n, take: false, mine: false }; byKey.set(key, lv); }
    lv.size += r.size;
    if (r.sizeAtoms != null){ try { lv.sizeAtoms += BigInt(r.sizeAtoms); } catch {} }
    if (r.take) lv.take = true;
    if (r.mine) lv.mine = true;
  }
  return [...byKey.values()];
}
// Click a book LEVEL: seed the composer with that level's price + its aggregated size, then derive the
// other amount. The base-side amount takes the EXACT summed atoms (no float-trim precision loss); the
// price field takes the level price; the quote side derives from base × price. requote refines/validates.
function seedFromLevel(price, sizeAtoms){
  const pay = S.payAsset, receive = S.receiveAsset; if (!(pay && receive)) return;
  const { base, quote } = pairDir(pay, receive);
  const baseIsPay = (base === pay);
  const baseEl  = baseIsPay ? C.$('swPayAmt') : C.$('swRecvAmt');
  const otherEl = baseIsPay ? C.$('swRecvAmt') : C.$('swPayAmt');
  const bm = metaOf(base);
  S.edited = baseIsPay ? 'pay' : 'receive';
  const atoms = (() => { try { return BigInt(sizeAtoms); } catch { return 0n; } })();
  if (atoms > 0n){ setNativeField(baseEl, C.fmtAtoms(atoms, bm.precision || 0), base); baseEl._userTyped = true; }
  // In LIMIT the clicked price is HELD (adjusting size later keeps it); in MARKET the price field is a
  // read-only sweep readout, so requote/paintPriceField overwrites it regardless of this flag.
  if (price > 0) setPriceFieldValue(price, S.mode === 'post');
  const sizeUnits = Number(atoms) / Math.pow(10, bm.precision || 0);
  if (sizeUnits > 0 && price > 0) writeAmountUnits(otherEl, quote, sizeUnits * price, false);   // quote = base × (quote/base)
  paintRefHints();
  LAST_QUOTE = null; setReviewEnabled(false);
  requote().catch(()=>{});
}

// Re-render the whole composer for the current wallet/markets/state.
// B3/D4 (live market data): the order book itself now streams over a WS (startLiveBook) — the ladder
// and the cost-vs-mid line tick in real time as offers appear/expire, and the header shows "· live".
// This 15s timer is the fallback + the READ-ONLY surfaces the stream doesn't carry: recent trades +
// 24h stats, refreshed only when a pair is chosen. It (and the live stream) DELIBERATELY do
// NOT auto-requote the composer — that would risk moving an amount the user is reading or about to
// place; the terms-verify abort already guards a stale price at execution time (B3), so the composer
// stays put while everything around it stays live.
let _liveTimer = null;
function startLiveData(){
  if (_liveTimer) return;
  _liveTimer = setInterval(() => {
    try {
      const sw = C.$('swBook'); if (!sw || sw.offsetParent === null) return;   // Swap tab not visible
      if (S.payAsset && S.receiveAsset){ renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{}); }
    } catch {}
  }, 15000);
}

// First-open composer default (native-BTC-at-top): open with BTC in the pay slot and
// receive empty. One-time per page load — after the user clears/changes it we never snap
// back. SEQ is never defaulted (no privileged coin); receive is left on "Select asset".
let _composerDefaulted = false;
export async function renderSwap(){
  if (!C.wollet) return;
  startLiveData();
  stopLiveBook();   // drop any prior pair's live stream; requoteSame re-subscribes for the selected pair
  // Prune stale dismissals: once a kind's trade has ended, its flag must not suppress a future one.
  if (!hasMixedInFlight()) _dismissed.delete('mixed');
  if (!(X && X.hasInFlight && X.hasInFlight())) _dismissed.delete('cross');
  if (!(X && X.hasReverseInFlight && X.hasReverseInFlight())) _dismissed.delete('reverse');
  // In-flight swaps NEVER hijack the tab (spec §7): the composer stays up and every in-flight/pending
  // trade lives in the COMPACT "Active trades" card (renderInFlightCard) beside it, so you keep trading
  // while they settle — essential for rapid/HFT use. The full-screen stepper is opt-in: the card's
  // "View" button reopens it for detail or a refund off-ramp. (This replaces the old auto-takeover that
  // jumped into a mixed/cross/reverse stepper on entry and owned the whole tab.)
  showCross(false); showReverse(false); showMixed(false);
  const _bh = C.$('swBook'); if (_bh) _bh.innerHTML = '';   // cleared; requote re-renders for the selected pair
  renderInFlightCard();   // any dismissed / background in-flight trade, reopenable
  renderMyOrders();
  await loadMarkets();
  // Validate the persisted pair (drop anything no longer tradable); we do NOT force a default pair —
  // the composer leads, and the user picks pay/receive, which brings up that pair's detail above.
  ensureDefaults();
  if (!_composerDefaulted){
    _composerDefaulted = true;
    // Default PAY to native BTC (parent-chain asset, top of the dropdowns) and leave RECEIVE
    // empty — only when nothing is already selected and BTC is startable in this book.
    if (!S.payAsset && !S.receiveAsset && startableAssets().includes('BTC')) S.payAsset = 'BTC';
  }
  renderFeePicker();
  paintPanes();
  renderPairBar();
  refreshInstant();   // best-effort instant/on-chain split from the LSP /status (non-blocking)
  await requote().catch(()=>{});
}

function showCross(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (cw) cw.classList.toggle('hide', !on);
  if (on && rw) rw.classList.add('hide');     // forward + reverse hosts are mutually exclusive
  if (comp) comp.classList.toggle('hide', on);
  // "Back to composer" is now a DISMISS (the swap keeps running + the Active-trades card reopens
  // it), so it's shown whenever the cross host is open — including with a swap in flight.
  const back = C.$('swXBack');
  if (back) back.classList.toggle('hide', !on);
}
// Reverse (asset -> BTC) wizard host, symmetric with showCross.
function showReverse(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (rw) rw.classList.toggle('hide', !on);
  if (on && cw) cw.classList.add('hide');
  if (comp) comp.classList.toggle('hide', on);
  // Symmetric with showCross: reveal "Back to composer" whenever the reverse host is open,
  // including with a sell in flight (it's a DISMISS — the swap keeps running).
  const back = C.$('swRBack');
  if (back) back.classList.toggle('hide', !on);
}

// ---------------------------------------------------------------------------
// markets discovery (same-chain pairs + cross-chain BTC<->asset pairs)
// ---------------------------------------------------------------------------
async function loadMarkets(){
  const status = C.$('swStatus');
  if (status){ status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading markets…'; }
  // Same-chain markets.
  try {
    const resp = await dexPost('/v1/markets', {});
    MARKETS = (Array.isArray(resp.markets) ? resp.markets : []).map(m => ({
      market: normMarket(m), fee: pick(m, 'fee') || {},
    }));
  } catch (e){ MARKETS = []; }
  // Cross-chain markets (BTC <-> asset). Best-effort; absence just hides BTC routes.
  XMARKETS = (X && X.markets) ? await X.markets().catch(()=>[]) : [];
  if (status) status.textContent = '';
  C.$('swErr').textContent = '';
}

// Assets the composer can START from (either side, before the other is chosen):
// everything the user OWNS (so the wallet's own assets are always selectable, even
// before a market has loaded), plus every asset quoted by some market, plus BTC if a
// cross-chain market exists. findRoute() still gates an actual swap on a real market,
// so an owned-but-unmarketed asset is offered but routes to "No market".
function startableAssets(){
  const set = new Set();
  const bal = C.balObj() || {};
  for (const h of Object.keys(bal)){ if (big(bal[h]) > 0n) set.add(h); }   // what you hold
  // Every registry/known asset: the order book lets you trade (or start) ANY pair,
  // not just ones with a pre-existing market.
  if (C.registryAssets){ for (const h of C.registryAssets()){ if (h && h !== 'BTC') set.add(h); } }
  for (const m of MARKETS){ set.add(m.market.base_asset); set.add(m.market.quote_asset); }
  for (const xm of XMARKETS){ set.add('BTC'); set.add(xm.seq_asset); }
  // The blinded book is Sequentia-only: BTC lives on the parent chain, which has no
  // confidential transactions, so a BTC leg cannot blind. Drop it from the picker.
  if (isConfBook()) set.delete('BTC');
  // Dedup by resolved ticker. Reissued assets leave STALE ids behind: an old id may
  // resolve to the SAME ticker as the current one (making the asset appear twice), or
  // to a metadata-less "Asset" (dust of a long-dead id). Keep ONE id per ticker,
  // preferring the id the current registry knows, then a held id; and drop unresolved
  // ids that are not actually held.
  const reg = new Set(C.registryAssets ? C.registryAssets() : []);
  const held = h => { try { return big(bal[h] || 0n) > 0n; } catch { return false; } };
  const byKey = new Map();
  for (const h of set){
    if (h === 'BTC'){ byKey.set('BTC', 'BTC'); continue; }
    const meta = (C.assetMeta && C.assetMeta(h)) || {};
    const resolved = meta.name && meta.name !== 'Asset';
    if (!resolved && !held(h)) continue;                  // stale dust of an old id, no metadata: hide it
    const key = resolved ? meta.ticker : h;               // group resolved by ticker; keep unresolved-but-held unique
    const cur = byKey.get(key);
    if (!cur){ byKey.set(key, h); continue; }
    if ((reg.has(h) && !reg.has(cur)) || (held(h) && !held(cur))) byKey.set(key, h);   // prefer registry-known, then held
  }
  const out = [...byKey.values()];
  // F1 paste-an-id: an asset id the user explicitly pasted + picked stays selectable for the
  // session even with no registry entry and no balance — otherwise the resolved/held dedup
  // above drops it and ensureDefaults would silently clear the user's own pick.
  for (const h of PASTED){ if (!out.includes(h)) out.push(h); }
  return out;
}
// Session set of asset ids the user pasted into a picker search box and PICKED (F1).
// Registered by the popover on selection; read by startableAssets so the pick survives
// validation. Session-only on purpose: an id that was never traded needs no persistence,
// and one that WAS traded persists through the trade history/balances instead.
const PASTED = new Set();
function notePasted(hex){ try { PASTED.add(String(hex).toLowerCase()); } catch {} }

// ---------------------------------------------------------------------------
// P5.2 — markets overview (pair discovery)
// ---------------------------------------------------------------------------
// A browsable list of every tradeable pair with liquidity signals (last price, 24h change, spread,
// depth) sourced from the SAME relay endpoints the pair stats already use (/candles, /orderbook), so a
// user finds pairs WITH resting depth instead of picking a possibly-empty one. Clicking a row loads the
// pair into the composer. Read-only: it never funds, quotes, or touches the settlement path.
let _marketsOpen = false, _mkReq = 0;
function overviewPairs(){
  const out = [], seen = new Set();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const { base, quote } = canonicalPair(a, b);
    const k = base + '|' + quote; if (seen.has(k)) return; seen.add(k);
    out.push({ base, quote });
  };
  // SAME-CHAIN: every distinct pair of the known Sequentia assets (registry + held + any market asset,
  // deduped by ticker via startableAssets). The legacy /v1/markets source is DEAD (returns 405), so the
  // pair universe comes from the registry/known assets, not that endpoint — every market shows, and the
  // per-row depth signal reveals which have resting liquidity.
  const seqAssets = startableAssets().filter(h => h && h !== 'BTC');
  for (let i = 0; i < seqAssets.length; i++)
    for (let j = i + 1; j < seqAssets.length; j++) add(seqAssets[i], seqAssets[j]);
  // Legacy same-chain markets, if any still load (harmless + deduped).
  for (const m of MARKETS) add(m.market.base_asset, m.market.quote_asset);
  // CROSS: BTC <-> each asset that has a cross market.
  for (const xm of XMARKETS) add('BTC', xm.seq_asset);
  return out;
}
// Bounded-concurrency pool so the overview loads ~N pairs without firing every relay request at once.
async function _pool(items, n, fn){
  const q = items.slice(), workers = [];
  for (let i = 0; i < Math.min(n, q.length); i++) workers.push((async () => { while (q.length){ const it = q.shift(); try { await fn(it); } catch {} } })());
  await Promise.all(workers);
}
// Best bid/ask, spread, mid, offer count + base-side depth for a pair, from BOTH book orientations. Each
// offer self-describes its offer/want asset, so we classify ask (gives base) vs bid (gives quote) directly.
async function bookSignals(base, quote){
  const [b1, b2] = await Promise.all([
    OB.fetchBook(base, quote).catch(() => ({ offers: [] })),
    OB.fetchBook(quote, base).catch(() => ({ offers: [] })),
  ]);
  const bm = metaOf(base), qm = metaOf(quote);
  const toU = (a, p) => Number(big(a)) / Math.pow(10, p || 0);
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set(); let bestAsk = null, bestBid = null, count = 0, baseDepth = 0;
  for (const o of [...(b1.offers || []), ...(b2.offers || [])]){
    if (o._verified === false) continue;                                        // untrusted relay row
    const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); if (exp && exp <= now) continue;
    const id = (o.maker_pubkey || o.makerPubkey) + ':' + (o.offer_id || o.offerId); if (seen.has(id)) continue; seen.add(id);
    const oa = o.offer_asset || o.offerAsset, wa = o.want_asset || o.wantAsset;
    let baseA, quoteA, isAsk;
    if (oa === base && wa === quote){ baseA = big(o.offer_amount || o.offerAmount); quoteA = big(o.want_amount || o.wantAmount); isAsk = true; }
    else if (oa === quote && wa === base){ baseA = big(o.want_amount || o.wantAmount); quoteA = big(o.offer_amount || o.offerAmount); isAsk = false; }
    else continue;
    const baseU = toU(baseA, bm.precision), quoteU = toU(quoteA, qm.precision);
    if (!(baseU > 0 && quoteU > 0)) continue;
    const price = quoteU / baseU; count++; baseDepth += baseU;
    if (isAsk){ if (bestAsk == null || price < bestAsk) bestAsk = price; }
    else { if (bestBid == null || price > bestBid) bestBid = price; }
  }
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  return { count, baseDepth, bestAsk, bestBid, spread, mid };
}
// 24h last / change% / volume for a pair, from /candles — the SAME one-canonical-direction handling as
// renderPairStats (query the pair's direction, else the inverse and invert each candle).
async function candleSignals(base, quote){
  const fetchDir = async (b, q) => {
    try {
      const r = await fetch(seqob.seqobBase() + '/v1/market/' + encodeURIComponent(b) + '/' + encodeURIComponent(q) + '/candles?interval=3600&limit=48', { cache: 'no-store' });
      if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.candles) ? j.candles : [];
    } catch { return []; }
  };
  let inv = false, candles = await fetchDir(base, quote);
  if (!candles.length){ const alt = await fetchDir(quote, base); if (alt.length){ candles = alt; inv = true; } }
  if (!candles.length) return null;
  const ivn = (x) => { const n = Number(x); return n > 0 ? 1 / n : 0; };
  const cN = candles.map(c => inv ? { t: c.t, o: ivn(c.o), c: ivn(c.c), v: c.v } : { t: c.t, o: Number(c.o), c: Number(c.c), v: c.v });
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const win = cN.filter(c => (c.t || 0) >= cutoff), use = win.length ? win : cN.slice(-1);
  let vol = 0n; for (const c of use) vol += big(String(c.v || 0));
  const first = use[0], last = use[use.length - 1];
  const changePct = (first && first.o > 0) ? ((last.c - first.o) / first.o * 100) : null;
  return { last: last.c, changePct, vol };
}
function _mkRowId(p){ return 'mk_' + (p.base + '_' + p.quote).replace(/[^a-zA-Z0-9]/g, ''); }
function patchMarketRow(id, p, bk, cd){
  const tr = document.getElementById(id); if (!tr) return;
  const bm = metaOf(p.base), qm = metaOf(p.quote);
  const last = (cd && cd.last != null && isFinite(cd.last)) ? cd.last : (bk && bk.mid != null ? bk.mid : null);
  const chg = (cd && cd.changePct != null && isFinite(cd.changePct)) ? cd.changePct : null;
  const hasDepth = !!(bk && bk.count > 0);
  const dot = tr.querySelector('.swmk-dot'); if (dot) dot.className = 'swmk-dot ' + (hasDepth ? 'on' : 'off');
  tr.classList.toggle('nodepth', !hasDepth);
  const setCell = (cls, html) => { const c = tr.querySelector(cls); if (c) c.innerHTML = html; };
  setCell('.mk-last', last != null ? `<span class="mono">${esc(fmtPrice(last))}</span> <span class="sub">${esc(qm.ticker)}</span>` : '<span class="sub">-</span>');
  setCell('.mk-chg', chg != null ? `<b style="color:${chg >= 0 ? '#3ddc84' : 'var(--amber2)'}">${(chg >= 0 ? '+' : '') + chg.toFixed(2)}%</b>` : '<span class="sub">-</span>');
  setCell('.mk-spread', (bk && bk.spread != null && bk.mid > 0) ? `<span class="sub">${(bk.spread / bk.mid * 100).toFixed(2)}%</span>` : '<span class="sub">-</span>');
  setCell('.mk-depth', hasDepth ? `<span class="mono">${esc(trim(bk.baseDepth))}</span> <span class="sub">${esc(bm.ticker)}</span>` : '<span class="sub">no resting depth</span>');
  tr._depth = hasDepth ? 1 : 0; tr._vol = (cd && cd.vol != null) ? Number(cd.vol) : 0;
}
function reorderMarketRows(host){
  const tbody = host.querySelector('tbody'); if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr')];
  rows.sort((a, b) => (b._depth || 0) - (a._depth || 0) || (b._vol || 0) - (a._vol || 0));   // pairs WITH depth first, then by 24h volume
  for (const r of rows) tbody.appendChild(r);
}
function wireMarketsView(host){
  host.querySelectorAll('.swmk-close').forEach(b => b.onclick = () => hideMarketsView());
  host.querySelectorAll('.swmk-row').forEach(tr => tr.onclick = () => onSelectMarket(tr.dataset.base, tr.dataset.quote));
}
// Load the clicked pair into the composer: pay the QUOTE, receive the BASE ("buy the base"); the user can
// flip in the composer. Falls back to the other orientation if that one isn't startable in this book.
function onSelectMarket(base, quote){
  const startable = startableAssets();
  let pay = quote, receive = base;
  if (!(startable.includes(pay) && startable.includes(receive)) && startable.includes(base) && startable.includes(quote)){ pay = base; receive = quote; }
  selectPairInComposer(pay, receive);
}
function selectPairInComposer(pay, receive){
  S.payAsset = pay; S.receiveAsset = receive;
  S.payRail = null; S.recvRail = null;                     // no default rail for the new pair (user must pick)
  S.feeAsset = null; S.feeAssetTouched = false; S.priceFlip = false;
  { const pe = C.$('swPriceAmt'); if (pe){ pe._userTyped = false; pe.value = ''; } }
  resetComposer();                                         // clear both amount fields for the new pair
  hideMarketsView();
  paintPanes();
  requote().catch(() => {});
}
function hideMarketsView(){ _marketsOpen = false; const v = C.$('swMarketsView'); if (v) v.classList.add('hide'); const b = C.$('swMarketsBtn'); if (b) b.textContent = 'Browse markets'; }
function toggleMarketsView(){ _marketsOpen ? hideMarketsView() : showMarketsView(); }
function showMarketsView(){ _marketsOpen = true; const b = C.$('swMarketsBtn'); if (b) b.textContent = 'Hide markets'; renderMarketsOverview().catch(() => {}); }
async function renderMarketsOverview(){
  const host = C.$('swMarketsView'); if (!host) return;
  host.classList.remove('hide');
  if (!MARKETS.length && !XMARKETS.length){ try { await loadMarkets(); } catch {} }
  const pairs = overviewPairs();
  const req = ++_mkReq;
  const head = `<div class="swmk-head"><span class="lbl">Markets</span>`
    + `<span class="sub">${pairs.length} pair${pairs.length === 1 ? '' : 's'} · click one to load it into the composer</span>`
    + `<button type="button" class="ghost swmk-close" style="margin-left:auto">Close</button></div>`;
  if (!pairs.length){ host.innerHTML = head + '<div style="padding:12px"><span class="sub">No markets are listed right now.</span></div>'; wireMarketsView(host); return; }
  const skeleton = pairs.map(p => {
    const bm = metaOf(p.base), qm = metaOf(p.quote);
    return `<tr class="swmk-row" id="${_mkRowId(p)}" data-base="${esc(p.base)}" data-quote="${esc(p.quote)}">`
      + `<td><span class="swmk-dot off"></span>${esc(bm.ticker)}/${esc(qm.ticker)}</td>`
      + `<td class="mk-last sub">…</td><td class="mk-chg sub">…</td><td class="mk-spread sub">…</td><td class="mk-depth sub">…</td></tr>`;
  }).join('');
  host.innerHTML = head + `<div class="swmk-scroll"><table class="swmk-tbl">`
    + `<thead><tr><th>Pair</th><th>Last</th><th>24h</th><th>Spread</th><th>Depth</th></tr></thead>`
    + `<tbody>${skeleton}</tbody></table></div>`;
  wireMarketsView(host);
  await _pool(pairs, 4, async (p) => {
    const [bk, cd] = await Promise.all([bookSignals(p.base, p.quote).catch(() => null), candleSignals(p.base, p.quote).catch(() => null)]);
    if (req !== _mkReq) return;                             // superseded by a newer open/refresh
    patchMarketRow(_mkRowId(p), p, bk, cd);
  });
  if (req === _mkReq) reorderMarketRows(host);
}

// Assets that have a market with `other` (the already-chosen side). If `other` is
// null, every tradable asset is a candidate. This is how the pickers only offer a
// counter-asset that actually trades against the chosen one.
function counterpartsOf(other){
  if (!other) return startableAssets();
  const set = new Set();
  if (other === 'BTC'){
    // Cross-chain order book: BTC pairs with ANY Sequentia asset. The pair may have
    // no resting cross offers yet, in which case its book shows empty (a maker must
    // post one) — but every asset is selectable, not just ones with a live market.
    for (const h of startableAssets()){ if (h !== 'BTC') set.add(h); }
  } else {
    // Same-chain: any OTHER Sequentia asset is a valid counterpart (the pair may
    // have no resting offers yet — then it's startable). BTC is a valid cross-chain
    // counterpart on the transparent book only (the blinded book is Sequentia-only).
    for (const h of startableAssets()){ if (h !== other && h !== 'BTC') set.add(h); }
    if (!isConfBook()) set.add('BTC');
  }
  return [...set];
}

// Is (pay, receive) a routable pair? Same-chain if both are Sequentia assets with
// a market; cross-chain if exactly one side is BTC and the BTC<->asset market exists.
function findRoute(pay, receive){
  if (!pay || !receive || pay === receive) return null;
  if (pay === 'BTC' && receive === 'BTC') return null;   // BTC<->BTC is not a market
  const btcPair = (pay === 'BTC') !== (receive === 'BTC');   // exactly one side is BTC
  if (btcPair){
    const seqAsset = pay === 'BTC' ? receive : pay;
    const payIsBtc = pay === 'BTC';
    const xm = XMARKETS.find(m => m.seq_asset === seqAsset) || null;
    // When LN isn't deployed there is no rail choice: both legs are on-chain, so an
    // LN-unconfigured wallet always takes the proven cross route (independent of any
    // stale rail state). Gate on lnDeployed() (own-node capable), NOT lnAvailable()
    // (shared hub connected): the mixed/pure-LN legs below run on the user's OWN nodes,
    // and the per-leg ra.payLn/recvLn.ok checks already require a real usable channel —
    // so a disconnected shared hub must not force a funded own channel back to on-chain.
    const ln = lnDeployed();
    // HONEST gating: a leg may sit on 'ln' ONLY when THAT asset (or BTC) has a real,
    // usable channel with the liquidity the leg's direction needs — never merely
    // "LSP configured". Any 'ln' leg without a channel is downgraded to 'chain' here,
    // so a stale rail state can never silently route into a dead LN path.
    const ra = ln ? railAvail(pay, receive) : null;
    // Rail-agnostic (Stage 3): HONOR a chosen LN pay-leg even without a channel yet — review opens +
    // funds it inline on Place-order (reviewMixed/reviewLn provisioning), so "pay from Lightning" is a
    // preference, not gated on pre-existing liquidity. (No longer downgraded to 'chain' on !payLn.ok.)
    // Pay-over-LN: a BTC pay-leg (a BUY) is funded inline on Place-order, so honor it unconditionally.
    // Paying the ASSET over LN (a sub-asset SELL) instead LIFTS a resting sub-asset sell offer — there
    // is no inline funding — so honor it only when such an offer exists (sellCapable) or the user has a
    // real pay channel; otherwise degrade to the on-chain cross rail (which supports POSTING). Without
    // this, an LN best-bid the auto-select picked but that has no takeable sub-asset offer (source
    // mismatch, or the fire-and-forget sub-asset book not yet loaded) strands the user: requoteMixed
    // disables Review and a mixed route isn't postable, so BOTH Review and Post are off.
    // A sub-asset SELL (pay asset over LN, receive BTC on-chain) LIFTS a resting sell offer, so it needs
    // one to exist (sellCapable) — an outbound channel alone is necessary but NOT sufficient. Only the
    // pure-LN sell (recv=ln too) is serviceable by the pay channel itself. Without this split, having a
    // funded pay-channel but no resting offer left the mixed sell on 'ln' -> requoteMixed disables Review
    // and mixed isn't postable = dead-end. Degrade to the postable cross rail instead.
    // RAIL-BLIND (rip the maker-existence gate): a chosen LN pay-asset leg is HONORED whenever LN is
    // deployed, even with no same-rail resting sell — the LSP bridge lifts a cross offer (onReview's
    // rail-blind take routes it to the bridge driver), so rail is a pure preference, not a gate. The old
    // sellCapable/payLn pre-block is kept only as a fallback signal for when the bridge is unavailable.
    const paySellServiceable = payIsBtc || ln || sellCapable(seqAsset) || (ra && ra.payLn.ok && S.recvRail === 'ln');
    const p = (ln && S.payRail === 'ln' && paySellServiceable) ? 'ln' : 'chain';
    // Receiving over LN normally needs a real inbound channel on that asset — EXCEPT the
    // sub-asset BUY (pay BTC on-chain, receive the asset over LN). There the LSP JIT-provisions
    // the user's inbound asset liquidity as part of the buy (provisionInbound), so recv=ln is
    // honoured with no pre-existing channel; every OTHER 'ln' recv leg still needs ra.recvLn.ok.
    // RAIL-BLIND (rip the maker-existence gate): a chosen LN RECEIVE leg is honored whenever LN is
    // deployed — the LSP JIT-provisions inbound (provisionInbound) and/or bridges a cross offer, so no
    // pre-existing channel or same-rail maker is required. subAssetBuyRecvLn kept as a fallback signal.
    const subAssetBuyRecvLn = ln && payIsBtc && S.payRail === 'chain'
      && S.recvRail === 'ln' && subassetCapable(receive);
    const r = (ln && S.recvRail === 'ln' && (ra.recvLn.ok || subAssetBuyRecvLn || lnDeployed())) ? 'ln' : 'chain';
    // ln + ln -> the proven pure-LN LSP route (non-custodial, keys on device).
    // Offered only when BOTH legs have a real usable channel.
    if (p === 'ln' && r === 'ln')
      return { kind: 'ln', seqAsset, payIsBtc, xm, payRail: p, recvRail: r };
    // chain + chain -> the proven on-chain cross-chain HTLC order book. ANY
    // BTC<->asset pair is routable (the book may be empty; a maker posts one).
    if (p === 'chain' && r === 'chain')
      return { kind: 'cross', seqAsset, xm, payIsBtc, payRail: p, recvRail: r };
    // MIXED (one leg LN, one on-chain): a submarine swap. reviewMixed dispatches to
    // the LSP's POST /swap (payRail/recvRail) -> seqob-cli xsubbuy/xsublift. The one
    // deployed shape is asset-on-chain <-> BTC-Lightning; the mirror combo fails
    // closed there with an honest message.
    return { kind: 'mixed', seqAsset, xm, payIsBtc, payRail: p, recvRail: r };
  }
  // Same-chain asset<->asset can also settle over PURE Lightning (two asset-LN HTLCs bound by one
  // preimage) — instant, exactly like asset<->BTC pure-LN, with the counter (quote) asset taking BTC's
  // structural place. Route there when BOTH legs are set to Lightning + LN is deployed. requoteLn checks
  // the REAL <base>/<quote> pure-LN book; reviewLn provisions both channels inline. No pure-LN liquidity
  // -> requoteLn says so honestly and the user can switch either rail to on-chain (the covenant book).
  if (lnDeployed() && S.payRail === 'ln' && S.recvRail === 'ln'){
    const cp = canonicalPair(pay, receive);   // base = the market's base asset; quote = the numeraire side
    return { kind: 'ln', assetAsset: true, seqAsset: cp.base, quoteAsset: cp.quote,
      payIsBtc: pay === cp.quote,             // "paying the quote" is the structural analog of paying BTC (= a BUY of the base)
      payRail: 'ln', recvRail: 'ln' };
  }
  // MIXED same-chain (one leg Lightning, one on-chain): a first-class combination per the spec, settled
  // P2P as one asset-LN HTLC + one on-chain HTLC bound by one preimage — the sub-asset construction
  // with the QUOTE asset standing in BTC's structural place (no privileged unit; the LSP bridges a leg
  // only when that leg's two SIDES disagree). Routed through the SAME 'mixed' pipeline as the BTC
  // shapes, marked mixedSame so every consumer knows the on-chain leg is the QUOTE ASSET on the
  // Sequentia chain: "payIsBtc" keeps its structural meaning of "paying the QUOTE side" (a BUY of the
  // base). The orientations whose LIGHTNING leg is the quote (the submarine mirror) are not wired yet;
  // requoteMixed refuses those by name — never a fall-through to 'same'.
  if (S.payRail && S.recvRail && S.payRail !== S.recvRail){
    const cp = canonicalPair(pay, receive);
    return { kind: 'mixed', mixedSame: true, seqAsset: cp.base, quoteAsset: cp.quote,
      payIsBtc: pay === cp.quote, xm: null, payRail: S.payRail, recvRail: S.recvRail };
  }
  // Same-chain order book: ANY two distinct Sequentia assets form a market. It may
  // have no resting offers yet, in which case the user can start it by posting one.
  return { kind: 'same', pay, receive };
}
function lnAvailable(){ return !!(L && L.available && L.available()); }
// LN is DEPLOYED (LSP + node config present) but the SHARED hub isn't necessarily connected. The
// sub-asset rails use the user's OWN node, so they gate on this, not lnAvailable() (see the bridge).
function lnDeployed(){ return !!(L && L.deployed ? L.deployed() : (L && L.available && L.available())); }

// The composer deliberately opens with NO pair preselected — both sides sit on
// "Select asset" so no asset (least of all SEQ) is implied as a default. Here we
// only VALIDATE the current state (e.g. after markets reload) and drop stale picks.
function ensureDefaults(){
  const startable = startableAssets();
  if (S.payAsset && !startable.includes(S.payAsset)) S.payAsset = null;
  if (S.receiveAsset && (S.receiveAsset === S.payAsset ||
      (S.payAsset && !counterpartsOf(S.payAsset).includes(S.receiveAsset)))){
    S.receiveAsset = null;
  }
  // No hardcoded fee asset: defaultFeeAsset() (chosen lazily at quote time) prefers
  // the asset you're already paying with. Drop a stale/unaccepted fee pick.
  if (S.feeAsset && !acceptedFee(S.feeAsset)) S.feeAsset = null;
}

// ---------------------------------------------------------------------------
// pane painting
// ---------------------------------------------------------------------------
function tk(hex){ return hex ? C.assetMeta(hex).ticker : 'Select'; }
// Precision/ticker for BTC, the one parent-chain asset, so it formats like any other.
// An id NOBODY can name (not in the registry, user labels, or built-in defaults) comes back
// from assetMeta as the generic placeholder {ticker:'<8-hex>…', name:'Asset', precision:0}.
// Precision 0 would mis-scale every typed amount by 1e8, which made a pasted unknown id
// effectively untradeable. F1 makes it TRADEABLE instead: keep the id-prefix ticker but
// quote/trade at the chain-native precision 8 (the books are keyed by raw hex, so quoting
// needs no registry presence — only a sane amount scale). The placeholder is recognized by
// its exact construction (id-prefix ticker + generic name), so a real registry/labeled
// asset with precision 0 is never touched.
function metaOf(hex){
  if (hex === 'BTC') return { ticker: 'BTC', precision: 8 };
  const m = C.assetMeta(hex);
  if (m && m.name === 'Asset' && !m.precision && typeof hex === 'string'
      && m.ticker === hex.slice(0, 8) + '…')
    return { ...m, precision: 8 };
  return m;
}
function balAtoms(hex){
  if (!hex) return 0n;
  if (hex === 'BTC') return big(C.btcBalance || 0);   // parent-chain balance, shown like any other
  const b = C.balObj(); return big(b[hex] || 0);
}
function balStr(hex){
  if (!hex) return '';
  const m = metaOf(hex);
  const onchain = balAtoms(hex), instant = instantAtomsFor(hex);
  let s = 'Balance ' + C.fmtAtoms(onchain, m.precision) + ' ' + m.ticker + ' on-chain';
  if (instant > 0n) s += ' · ' + C.fmtAtoms(instant, m.precision) + ' Lightning';
  return s;
}

// --- instant (in-channel / Lightning) balances, best-effort from the LSP /status ---
function atomsOf(x){
  if (x == null) return 0n;
  if (typeof x === 'bigint') return x;
  try { return BigInt(x); } catch { return BigInt(Math.trunc(Number(x) || 0)); }
}
function instantAtomsFor(hex){
  const t = metaOf(hex).ticker;
  const e = INSTANT[t];
  return e ? atomsOf(e.spendable) : 0n;
}
// Refresh the instant/on-chain split from the LSP /status. Best-effort: if LN is
// unconfigured, the call fails, or the shape is unknown, instant stays 0 and nothing
// breaks (the wallet's known on-chain figure is always shown).
// TODO(instant-balance units): the LSP's *_units fields are treated as the asset's
// atoms here; confirm the unit convention when the LSP /status contract firms up.
async function refreshInstant(){
  INSTANT = {};
  LNSTATUS = { channels: [], funding: null };
  LNPROV = (L && L.provisioned) ? (L.provisioned() || {}) : {};
  // Read /status whenever we CAN (L.status exists) — NOT gated on L.available(). available() means
  // "the shared rail's BTC+asset hub nodes are both serving", but the wallet's OWN provisioned
  // channels are real regardless; gating on it left INSTANT empty (composer "0 Lightning") whenever
  // a shared leg wasn't up, which also broke the pay-from-Lightning amount check for own channels.
  if (!(L && L.status)) return;
  try {
    const st = await L.status();
    const chans = (st && (st.channels || st.channel_balances)) || [];
    LNSTATUS = { channels: chans, funding: (st && st.funding) || null, frontable: (st && st.frontable) || null };   // ground truth for rail gating (own channels + LSP-frontable inventory)
    // P3.5/P3.2 — capture the LSP-advertised 0-conf cap (sats) + bridge capability so the composer is a
    // single source of truth with the box config, not a hard-coded default. Absent on an older LSP -> the
    // frontCapAtoms box default and the shared pure capability predicate still apply.
    MAX0CONF_SATS = (st && Number.isFinite(Number(st.mixed_max_0conf_sats))) ? Number(st.mixed_max_0conf_sats) : MAX0CONF_SATS;
    BRIDGECAPS = (st && st.bridge) || BRIDGECAPS;
    applyStatusConstants(st);   // P5.4a — overlay shared constants (market_slip/min_lot_bps/front_cap/dust)
    for (const c of chans){
      if (!c.node_key) continue;   // ONLY the wallet's own channels count as its Lightning balance
                                   // (never shared/demo) — consistent with the Balance tab + railAvail
      // Key by the RESOLVED ticker (what instantAtomsFor looks up), not the raw channel label: the
      // LSP labels a channel with a TRUNCATED hex when it can't resolve the asset's ticker (e.g.
      // "2a515539…" for USDX), so keying by asset_label put the balance under a key nothing reads,
      // and the composer showed "0 Lightning" for a funded channel. Resolve the full asset hex →
      // metaOf().ticker to match, exactly like the Balance card matches on c.asset.
      const isBtc = (c.leg === 'btc' || c.asset_label === 'BTC' || c.chain === 'btc');   // mirror channelMatches' 3-way BTC test
      let t;
      if (isBtc) t = 'BTC';
      else {
        const hex = (typeof c.asset === 'string' && /^[0-9a-f]{64}$/i.test(c.asset)) ? c.asset.toLowerCase() : null;
        t = hex ? metaOf(hex).ticker : (c.asset_label || c.asset || c.ticker);
      }
      if (!t) continue;
      INSTANT[t] = {
        spendable: (c.spendable_units ?? c.spendable ?? 0),
        receivable: (c.receivable_units ?? c.receivable ?? 0),
      };
    }
  } catch { INSTANT = {}; LNSTATUS = { channels: [], funding: null }; }
  try { paintPanes(); } catch {}
}

// --- per-asset Lightning-rail gating (ln-rail.js) ---------------------------------
// The composer's leg descriptor for the gating helpers: 'BTC' for the parent leg, else
// { hex, ticker } so a channel can be matched by asset id OR its ticker label.
function railTarget(hexOrBtc){ return hexOrBtc === 'BTC' ? 'BTC' : { hex: hexOrBtc, ticker: metaOf(hexOrBtc).ticker }; }
// The live per-leg LN verdict for the current pay/receive legs (real channel liquidity,
// direction-aware). Safe to call any time; reads the last /status snapshot synchronously.
function railAvail(payHex, receiveHex){
  return railAvailability({
    channels: LNSTATUS.channels || [], provisioned: LNPROV, frontable: LNSTATUS.frontable || null,
    payTarget: railTarget(payHex), recvTarget: railTarget(receiveHex),
  });
}

// --- balance chips: per-asset Lightning vs on-chain split ---
function iconClass(hex){ return hex === 'BTC' ? 'btc' : (hex === C.POLICY_HEX ? 'seq' : 'asset'); }
function iconGlyph(hex, m){
  if (hex === 'BTC') return '₿';
  return (m.ticker || '?').slice(0, 1).toUpperCase();
}
// (The old "holdings chips" strip was removed: its host #swChips never existed in the DOM, so
// renderChips/chipHtml/onChipPick were dead code — and chipHtml's icon styling gave the policy asset a
// privileged look, a latent equal-standing violation. The asset dropdown's "Your assets" group is the
// holdings surface now, and it treats every asset the same.)

// --- pair bar: the selected market + last price (derived from the book mid) ---
function renderPairBar(){
  const host = C.$('swPairBar'); if (!host) return;
  if (!S.payAsset || !S.receiveAsset){ host.innerHTML = ''; host.classList.add('hide'); return; }
  host.classList.remove('hide');
  // The flip toggle inverts the SAME-CHAIN ladder's frame; the cross ladder (renderXBook) is fixed to
  // "1 asset = N BTC" and can't honour it — so hide the toggle on cross pairs and never leave a stale
  // flip applied there (C-3).
  const isCross = S.payAsset === 'BTC' || S.receiveAsset === 'BTC';
  if (isCross) S.priceFlip = false;
  const { base, quote } = pairDir(S.payAsset, S.receiveAsset);
  const bm = metaOf(base), qm = metaOf(quote);
  // LAST_MID.price is quote-per-base in the SAME frame the book just rendered (pairDir already applied),
  // so use it only when its base matches the current display base. Labelled "mid" — it IS the book mid,
  // not a last trade (a real last price needs the durable trade log; until then, don't call it "last").
  let midStr = '-';
  if (LAST_MID && LAST_MID.price != null && isFinite(LAST_MID.price) && LAST_MID.price > 0 && LAST_MID.base === base){
    midStr = `${fmtPrice(LAST_MID.price)} ${qm.ticker}`;
  }
  host.innerHTML = `<div class="swpairsel">${esc(bm.ticker)} <span class="swpair-car">/</span> ${esc(qm.ticker)}`
    + (isCross ? '' : ` <button type="button" class="swpairflip" id="swPairFlip" title="Flip price direction" aria-label="Flip price direction"`
      + ` style="background:none;border:0;color:var(--dim);cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;margin-left:5px;border-radius:5px">&#8645;</button>`)
    + `</div>`
    + `<div class="swpair-last">mid <b class="mono">${esc(midStr)}</b></div>`;
  const fb = C.$('swPairFlip');
  if (fb) fb.onclick = (e) => {
    e.stopPropagation();
    S.priceFlip = !S.priceFlip;                                  // swap the DISPLAY direction only
    { const pe = C.$('swPriceAmt'); if (pe) { pe._userTyped = false; pe.value = ''; } }  // a held limit price is meaningless in the flipped frame -> re-placeholder from the new inside price (paintPriceField)
    renderPairBar();                                             // instant heading flip
    requote().catch(()=>{});                                     // re-render book + rate line in the new frame
    renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{});   // keep the feed/stats in step
  };
}
// The reference value of ONE unit of an asset (for the ladder's mid line).
function oneUnitRefStr(hex){
  const m = metaOf(hex); const one = 10n ** BigInt(m.precision || 0);
  return C.refValueStr(hex, one) || '';
}

function paintPanes(){
  const { $ } = C;
  $('swPayTk').textContent  = tk(S.payAsset);
  $('swRecvTk').textContent = tk(S.receiveAsset);
  $('swPayBal').textContent  = balStr(S.payAsset);
  $('swRecvBal').textContent = balStr(S.receiveAsset);
  // Max only makes sense for an owned Sequentia asset on the pay side.
  $('swMax').style.display = (S.payAsset && S.payAsset !== 'BTC' && balAtoms(S.payAsset) > 0n) ? '' : 'none';
  paintRefHints();
  paintRouteLine();
  updateRails();
  paintModeSeg();
  paintPriceField();   // §6.4: keep the price field's presence in lockstep with the pair (contents refresh on requote)
  paintBookSeg();
  paintConfControl();
  paintOfflineToggle();
  // One CTA. When a pair is chosen but the settlement rails aren't both set, the CTA prompts for them
  // (and setReviewEnabled keeps it disabled) — no order can be placed on an unstated settlement choice.
  const cta = $('swReview');
  if (cta){
    const needRails = !!(S.payAsset && S.receiveAsset) && !(S.payRail && S.recvRail);
    cta.textContent = needRails ? 'Choose how you pay & receive' : 'Place order';
    if (needRails) cta.disabled = true;
  }
}

// The opt-in confidential-RECEIVE control shows ONLY when you are receiving a Sequentia-issued asset
// ON-CHAIN — a blinded (confidential) address is a Sequentia on-chain concept. So it is HIDDEN when:
// no receive asset is chosen yet; the received leg is BTC (the parent chain has no confidential
// transactions); the received leg is over LIGHTNING (there is no on-chain address to blind); or the
// Blinded book is active (both legs already blind by construction, so a per-swap opt-in is redundant).
function paintConfControl(){
  const wrap = C.$('swConfWrap'); if (!wrap) return;
  const route = (S.payAsset && S.receiveAsset) ? findRoute(S.payAsset, S.receiveAsset) : null;
  const recvOverLn = !!(route && route.recvRail === 'ln');
  // A wizard/stepper owning the tab hides the composer — the opt-in belongs to COMPOSING a
  // swap, so it must never float above an in-flight or failed trade view.
  const comp = C.$('swComposer');
  const wizardOwns = !!(comp && comp.classList.contains('hide'));
  const hide = wizardOwns || !S.receiveAsset || S.receiveAsset === 'BTC' || isConfBook() || recvOverLn;
  wrap.style.display = hide ? 'none' : 'flex';
  // Re-sync the checkbox from the (session-scoped) state on every paint, like the offline
  // toggle does — the one-time initSwapTab sync left a stale tick visible for a whole session.
  const chk = C.$('swConfChk');
  if (chk && chk.checked !== confidentialReceive()) chk.checked = confidentialReceive();
}

// TRUE when the user is PAYING real Bitcoin ON-CHAIN (as opposed to over Lightning, or paying a
// Sequentia asset). The "keep resting while offline" peg is relevant ONLY for this pay leg.
function payingBtcOnChain(){ return S.payAsset === 'BTC' && S.payRail === 'chain'; }

// The "Keep resting while offline" opt-out (spec §5, SBTC design §5). It is the ONE place SBTC
// touches the DEX, and it appears in exactly one situation: paying on-chain BTC AND a LIMIT
// (resting) order. In every other case (market orders, any Lightning leg, or paying an asset) it
// is HIDDEN and irrelevant — those are pure native BTC. Default ON; the placement path reads
// S.keepResting only when payingBtcOnChain() && S.mode === 'post'.
function paintOfflineToggle(){
  const wrap = C.$('swOfflineWrap'); if (!wrap) return;
  const comp = C.$('swComposer');
  const wizardOwns = !!(comp && comp.classList.contains('hide'));
  const show = !wizardOwns && payingBtcOnChain() && S.mode === 'post';
  wrap.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const chk = C.$('swOfflineChk');
  if (chk){
    chk.checked = !!S.keepResting;
    if (!chk._wired){ chk._wired = true; chk.onchange = () => { S.keepResting = !!chk.checked; }; }
  }
}

// --- Unblinded / Blinded book toggle -------------------------------------------
function wireBookSeg(){
  const seg = C.$('swBookSeg'); if (!seg || seg._wired) return; seg._wired = true;
  seg.querySelectorAll('button[data-book]').forEach(b => b.onclick = () => setBook(b.dataset.book));
}
function paintBookSeg(){
  const seg = C.$('swBookSeg'); if (!seg) return;
  seg.querySelectorAll('button[data-book]').forEach(b => b.classList.toggle('on', b.dataset.book === _book));
  const note = C.$('swBookNote');
  if (note) note.textContent = isConfBook()
    ? 'Blinded book: both sides settle confidentially (amounts and assets hidden on-chain). Sequentia assets only.'
    : 'Unblinded book: transparent settlement, the default. Bitcoin pairs trade here.';
}
// Switch the active book namespace. Distinct order sets: the desk reloads from the
// selected namespace and posts into it. Blinded is Sequentia-only, so a BTC pick is
// dropped on the way in.
function setBook(next){
  next = next === 'confidential' ? 'confidential' : 'public';
  if (next === _book){ paintBookSeg(); return; }
  _book = next; persistBook();
  if (isConfBook()){
    if (S.payAsset === 'BTC') S.payAsset = null;
    if (S.receiveAsset === 'BTC') S.receiveAsset = null;
  }
  // Fresh namespace: drop the stale book/quote and re-derive defaults + pickers.
  BOOK = { offers: [], pair: null };
  LAST_QUOTE = null; setReviewEnabled(false);
  S.payRail = null; S.recvRail = null;   // rails are unselected until the user picks (no default)
  ensureDefaults();
  paintPanes();
  requote().catch(()=>{});
}

// ---------------------------------------------------------------------------
// Take / Post (lift the book vs. rest a limit order at your own price)
// ---------------------------------------------------------------------------
// A route can be POSTED only when the wallet already has an offer-post path for it:
// same-chain (postOfferReview -> seqob.signOffer/postOffer) and cross-chain
// (postCrossOfferReview -> X.makerStart/makerStartReverse). LN + mixed rails are
// taker-only (LP fixed terms / submarine), so they stay in Take.
function postSupported(route){ return !!route && (route.kind === 'same' || route.kind === 'cross'); }
// Market is the default order type; the Market/Limit toggle is always shown and the user switches
// freely. No auto-override (kept as a no-op reconciler so existing callers stay valid).
function applyAutoMode(bookLen, route){
  // Market is the default; the user switches to Limit to rest at their own price. No auto-override:
  // the Market/Limit toggle is available on every pair and never disappears. (args kept for callers.)
  paintModeSeg();
}
function wireModeSeg(){
  const seg = C.$('swModeSeg'); if (!seg || seg._wired) return; seg._wired = true;
  seg.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => { if (!b.disabled) setMode(b.dataset.m); });
}
// Market / Limit is a first-class control on EVERY pair (spec §4/§6.3): MARKET walks the book at the
// best executable price now (partial-filling what's there); LIMIT rests a signed order at YOUR price.
// The toggle never disappears once a pair is chosen — no per-rail hiding.
function paintModeSeg(){
  if (!C) return;
  const wrap = C.$('swModeWrap'), seg = C.$('swModeSeg');
  const show = !!(S.payAsset && S.receiveAsset);
  if (wrap) wrap.classList.toggle('hide', !show);
  if (seg) seg.querySelectorAll('button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  const hint = C.$('swModeHint');
  if (hint){
    hint.classList.toggle('hide', !show);
    if (show){
      if (S.mode === 'post'){
        // P2.5: a Limit order must REST at the user's price, never silently take. Where a route can rest
        // durably (same-chain covenant CLOB + durable cross), say so; on a rail that CANNOT rest offline
        // (pure-LN / mixed submarine) be honest that Limit needs an on-chain leg instead of implying a rest.
        const route = findRoute(S.payAsset, S.receiveAsset);
        hint.textContent = postSupported(route)
          ? 'Set your price (or an amount) — the order fills what crosses now and rests the remainder at your price. Switch to Market to fill now.'
          : 'Limit rests at your price only on-chain (the Lightning rail can’t rest while your wallet is closed) · set both sides on-chain to rest a durable limit.';
      } else {
        hint.textContent = 'Type an amount; the other fills at the best price. Switch to Limit to set your own.';
      }
    }
  }
}
// Switch mode by hand. Market re-links the fields (requote re-derives the opposite at the book price);
// Limit leaves both fields independent (their ratio is the price).
function setMode(m){
  if (m !== 'take' && m !== 'post') return;
  S.mode = m;
  LAST_QUOTE = null; setReviewEnabled(false);
  paintModeSeg();
  paintPriceField();   // flip the price field editable<->read-only immediately (requote repaints its value)
  requote().catch(()=>{});
}

// Rail choosers (Pay via / Receive via) for EVERY pair (spec §5). RAIL-BLIND: the rails are
// SETTLEMENT preferences, never a route selector or a book filter. They start UNSELECTED — there
// is NO default (spec §6.5) — and an order cannot be placed until BOTH are chosen (gated in
// paintPanes). We never auto-select or force a rail; we only surface an honest LN-readiness note
// for a leg the user actually set to Lightning. Shown for same-chain pairs too: a Sequentia asset
// can settle over SeqLN, so "pay/receive over Lightning" is a real choice on every pair.
function updateRails(){
  const box = C.$('swRailPicks'); if (!box) return;
  const pay = S.payAsset, receive = S.receiveAsset;
  if (!(pay && receive && pay !== receive)){ box.classList.add('hide'); renderRailNote(null); return; }
  box.classList.remove('hide');
  // Probe the sub-asset book (async, cached) so the LN-readiness note reflects live liquidity.
  if (pay === 'BTC' || receive === 'BTC'){ try { refreshSubassetBook(pay === 'BTC' ? receive : pay); } catch {} }
  else { // mixed same-chain: the base/<quote> sub-asset book (quote = the pair's numeraire)
    try { const cp = canonicalPair(pay, receive); refreshSubassetBook(cp.base, cp.quote); } catch {}
  }
  const ra = lnDeployed() ? railAvail(pay, receive) : null;
  paintRailSegs(ra);
  renderRailNote(ra);
}
// An honest inline note under the rail choosers when the Lightning option is NOT
// offerable for a leg (no channel / wrong-side liquidity): says why + links to
// Move-to-Lightning. Cleared when both legs' LN options are live (or LN is off).
function renderRailNote(ra){
  const note = C.$('swRailNote'); if (!note) return;
  // Only nag about a missing/insufficient Lightning channel for a leg the user is ACTUALLY
  // routing over Lightning. A leg switched back to on-chain needs no channel, so its note
  // must clear (this is the fix for the note persisting after flipping a leg to on-chain).
  // Only the legs the user is actually routing over Lightning; ln-rail.js now factors in LSP-frontable
  // liquidity, so a leg is one of: ready(own channel) | fronted(LSP fronts it) | provisionable(no data
  // -> assume inline) | add(own channel short) | unfrontable(genuinely unavailable). Surface honestly.
  const legs = [];
  if (ra && S.payRail  === 'ln' && ra.payLn)  legs.push(ra.payLn);
  if (ra && S.recvRail === 'ln' && ra.recvLn) legs.push(ra.recvLn);
  const unavail = legs.find(l => l.unfrontable);            // real blocker: no channel + LSP can't front -> LN disabled
  const addliq  = legs.find(l => !l.ok && l.cta === 'add'); // own channel exists but lacks this side
  const provis  = legs.find(l => l.provisionable);          // no own channel but provisionable -> opened/fronted for you
  const pick = unavail || addliq || provis;
  if (!pick){ note.innerHTML = ''; note.classList.add('hide'); return; }
  note.classList.remove('hide');
  const nm = esc(pick.name || 'this asset');
  let html, withBtn = true, btnLabel = esc(pick.ctaLabel || 'Set it up now');
  if (pick === unavail){
    html = `<span>Lightning isn't available for ${nm} right now · ${esc(pick.hint || 'use on-chain instead.')}</span>`;
  } else if (pick === addliq){
    html = `<span>${esc(pick.reason)} ${esc(pick.hint || '')}</span>`; btnLabel = esc(pick.ctaLabel || 'Add liquidity');
  } else {
    // provisionable: a channel is arranged for you when you place the order, JIT + 0-conf (near-instant).
    // Per-leg: a PAY leg opens spendable capacity from YOUR balance; a RECEIVE leg is fronted by the
    // service (inbound). Optional "Set it up now" shortcut to the Balance tab.
    // F-R2 honesty: in a CROSS swap (BTC on one leg) the rail is a preference — findRoute routes this leg
    // over Lightning only when a Lightning COUNTERPARTY is resting (sell_available for a pay-asset leg,
    // buy_available for a recv-asset leg) and otherwise bridges to the on-chain book at the SAME price. So
    // don't promise Lightning unconditionally when no LN counterparty is known; state the on-chain fallback.
    const legAsset = pick.direction === 'pay' ? S.payAsset : S.receiveAsset;
    const crossFallback = (S.payAsset === 'BTC' || S.receiveAsset === 'BTC')
      && !(pick.direction === 'pay' ? sellCapable(legAsset) : subassetCapable(legAsset));
    if (crossFallback){
      html = `<span>Settles over Lightning when possible, otherwise on-chain - same price, nothing to set up.</span>`;
    } else {
      html = `<span>Lightning is set up for you when you place the order · near-instant, nothing to set up.</span>`;
    }
  }
  note.innerHTML = html + (withBtn ? ` <button type="button" class="swfix" id="swRailMove">${btnLabel}</button>` : '');
  const b = C.$('swRailMove');
  if (b) b.onclick = () => { if (C.gotoLightning) C.gotoLightning(); else try { C.toast('Set up Lightning from the Balance tab.'); } catch {} };
}
// DYNAMIC sub-asset rail availability from the order book (L.book) — NO hardcoded maker
// list. The sub-asset relays are a permissionless signed-intent book, so a rail is offered
// only when REAL resting counterparty liquidity exists, for ANY asset (a deployed maker is
// just seed liquidity, one offer among many). `buy_available` = someone rests an offer
// paying the asset over LN (a BTC-on-chain BUYER can take it → the sub-asset BUY rail);
// `sell_available` = someone rests an offer locking BTC on-chain (an asset-over-LN SELLER
// can take it → the sub-asset SELL rail). Populated by refreshSubassetBook(); railSupported
// reads it synchronously, so the toggle lights once the async probe lands.
const SUBASSET_BOOK = {};   // assetHexLower -> { sell_available, buy_available, sell_offers, buy_offers, ts }
function subassetCapable(seqAssetHex){ const e = seqAssetHex && SUBASSET_BOOK[seqAssetHex.toLowerCase()]; return !!(e && e.buy_available); }
function sellCapable(seqAssetHex){ const e = seqAssetHex && SUBASSET_BOOK[seqAssetHex.toLowerCase()]; return !!(e && e.sell_available); }
function subassetOffers(seqAssetHex, dir, quoteHex){
  const k = seqAssetHex && (seqAssetHex.toLowerCase() + '|' + String(quoteHex || 'BTC').toLowerCase());
  const e = k && SUBASSET_BOOK[k];
  return (e && (dir === 'sell' ? e.sell_offers : e.buy_offers)) || [];
}
let _bookInflight = {};
async function refreshSubassetBook(seqAssetHex, quoteHex){
  if (!seqAssetHex || seqAssetHex === 'BTC' || !(L && L.book && lnDeployed())) return;
  // Cache per PAIR: a mixed same-chain book (quote = a real asset) must never
  // shadow the BTC book for the same base, or vice versa.
  const k = seqAssetHex.toLowerCase() + '|' + String(quoteHex || 'BTC').toLowerCase();
  const prev = SUBASSET_BOOK[k];
  if (prev && (Date.now() - prev.ts) < 15000) return;   // ~15s cache
  if (_bookInflight[k]) return; _bookInflight[k] = true;
  try {
    const b = await L.book(seqAssetHex, quoteHex);
    const wasSell = !!(prev && prev.sell_available), wasBuy = !!(prev && prev.buy_available);
    SUBASSET_BOOK[k] = { sell_available: !!b.sell_available, buy_available: !!b.buy_available,
      sell_offers: b.sell_offers || [], buy_offers: b.buy_offers || [], ts: Date.now() };
    // If availability flipped, re-gate + repaint the rails so the toggle tracks live liquidity.
    if (wasSell !== !!b.sell_available || wasBuy !== !!b.buy_available){ try { updateRails(); } catch {} }
  } catch { SUBASSET_BOOK[k] = { sell_available:false, buy_available:false, sell_offers:[], buy_offers:[], ts: Date.now() }; }
  finally { _bookInflight[k] = false; }
}
// FUND-SAFETY RECONFIRM (the stale-cap fund mismatch): ONE live relay read immediately before
// the irreversible fund, bypassing every wallet-side cache. The reviewed offer must still rest
// with its economic terms unchanged (same id, same asset_amount/btc_sats, same claim key); a
// maker that re-priced between review and Confirm is refused HERE, where nothing is lost,
// instead of by the maker's exact-amount check AFTER the on-chain lock (which strands the
// funds until the CLTV refund). Any inability to confirm — offer gone, price fields changed,
// relay unreadable — fails closed with the same honest message.
const OFFER_CHANGED_MSG = 'The offer changed while you reviewed · re-quote and try again.';
async function reconfirmSubassetOffer(seqAssetHex, dir, quoteHex, reviewed){
  const stale = () => new Error(OFFER_CHANGED_MSG);
  if (!reviewed) throw stale();
  if (!(L && L.book)) throw stale();
  let b = null;
  try { b = await L.book(seqAssetHex, quoteHex || undefined); } catch { throw stale(); }
  const list = (b && (dir === 'sell' ? b.sell_offers : b.buy_offers)) || [];
  // Fold the fresh read into the composer's cache so the re-quote after a refusal starts current.
  try {
    const k = seqAssetHex.toLowerCase() + '|' + String(quoteHex || 'BTC').toLowerCase();
    SUBASSET_BOOK[k] = { sell_available: !!b.sell_available, buy_available: !!b.buy_available,
      sell_offers: b.sell_offers || [], buy_offers: b.buy_offers || [], ts: Date.now() };
  } catch {}
  const id = String(reviewed.offer_id || reviewed.offerId || '');
  const live = id ? (list.find(o => String(o.offer_id || o.offerId || '') === id) || null) : null;
  if (!live) throw stale();
  if (String(live.asset_amount) !== String(reviewed.asset_amount)
    || String(live.btc_sats) !== String(reviewed.btc_sats)) throw stale();
  const lc = String(live.maker_claim_pub || live.maker_claim_pubkey || '').toLowerCase();
  const rc = String(reviewed.maker_claim_pub || reviewed.maker_claim_pubkey || '').toLowerCase();
  if (lc !== rc) throw stale();
  return live;
}

// Is (payRail, recvRail) a rail combination with a backend for the current pair? Both
// legs the same (pure-LN or fully on-chain) always work. Two mixed shapes exist:
//   - asset-on-chain <-> BTC-Lightning (the submarine) — always available; and
//   - asset-over-Lightning + BTC-on-chain (the sub-asset MIRROR) — a BUY only, and only
//     for a pair that actually has a sub-asset maker (subassetCapable), else it fails
//     closed at the LSP, so it must not be selectable.
function railSupported(p, r){
  // Rail-agnostic matching (Stage 3): a rail is a SETTLEMENT PREFERENCE, not a matching gate.
  // Any mixed combo is selectable whenever Lightning is deployed; the settlement router decides
  // the settlement + bridges on Place-order, and fails closed CLEANLY (refundable) if a leg can't
  // be honored. We no longer pre-block on a live maker (subassetCapable/sellCapable) — the unified
  // book already shows the liquidity, and gating the rail on it re-introduced the very
  // rail distinction the merged book erases. (p === r is always fine: pure-LN / pure-on-chain.)
  return (p === r) || lnDeployed();
}
function wireRailSeg(id, leg){
  const seg = C.$(id); if (!seg || seg._wired) return; seg._wired = true;
  // Guard on b.disabled at click time so a greyed (unsupported) combo can't be picked.
  seg.querySelectorAll('button[data-r]').forEach(b => b.onclick = () => { if (!b.disabled) setRail(leg, b.dataset.r); });
}
function paintRailSegs(ra){
  ra = ra || railAvail(S.payAsset, S.receiveAsset);
  const badTip = 'This way of paying isn’t available for this pair yet.';
  const paint = (id, leg) => { const seg = C.$(id); if (!seg) return;
    const cur = leg === 'pay' ? S.payRail : S.recvRail;
    const legLn = leg === 'pay' ? ra.payLn : ra.recvLn;   // real per-asset LN verdict for this leg
    seg.querySelectorAll('button[data-r]').forEach(b => {
      const r = b.dataset.r;
      b.classList.toggle('on', r === cur);
      // The Lightning button is now SELECTABLE even without a channel: if the leg has no channel yet,
      // one is opened for you INLINE on Place-order (see reviewLn / renderRailNote). Only the
      // undeployed mixed shape (asset over LN + BTC on-chain) stays disabled. A no-channel LN pick
      // gets an informative title (not disabled). On-chain is always available.
      let bad = false, tip = '';
      // The BLINDED book settles both legs confidentially, which is an ON-CHAIN (Pedersen-committed)
      // construction: there is no confidential Lightning rail, and requoteLn never consults isConfBook() —
      // it prices off the TRANSPARENT pure-LN relay. Leaving this button live let a user who explicitly
      // opted into confidentiality be quoted and settled transparently with nothing said. Fail closed on
      // the control, with the real reason, instead of silently dropping the namespace they chose.
      if (r === 'ln' && isConfBook()){
        b.disabled = true;
        b.title = 'The blinded book settles confidentially on-chain · Lightning cannot hide amounts, so switch to the Unblinded book to settle over Lightning.';
        return;
      }
      const p2 = leg === 'pay' ? r : S.payRail;
      const r2 = leg === 'pay' ? S.recvRail : r;
      if (r !== 'chain' && !railSupported(p2, r2)){ bad = true;
        // Distinguish "no maker for this shape at all" from "a sub-asset maker exists but
        // you have no inbound Lightning liquidity to receive the asset" — the latter is the
        // sub-asset buy case, and saying "no maker" there would be wrong.
        const subAssetNoInbound = leg === 'recv' && S.payAsset === 'BTC' && p2 === 'chain'
          && subassetCapable(S.receiveAsset);
        tip = subAssetNoInbound
          ? `Receiving ${C.assetMeta(S.receiveAsset).ticker} over Lightning isn’t available yet · for now, receive it on-chain.`
          : badTip;
      }
      else if (r === 'ln' && legLn.unfrontable){
        // Honest gating: the user has no channel AND the LSP genuinely can't front this leg (no
        // inventory) -> Lightning can't work here, so disable it and point to on-chain.
        bad = true; tip = legLn.hint || `Lightning isn't available for ${legLn.name} right now · use on-chain.`; }
      else if (r === 'ln' && !legLn.ok){ tip = legLn.cta === 'add'
        ? (legLn.reason + (legLn.hint ? ' ' + legLn.hint : ''))
        : 'Lightning is set up for you when you place the order.'; }
      b.disabled = bad;
      if (tip) b.title = tip; else b.removeAttribute('title');   // informative title even when selectable
    }); };
  paint('swPayRailSeg', 'pay');
  paint('swRecvRailSeg', 'recv');
}
// Set ONE leg's settlement rail (leg = 'pay' | 'recv'). Rail-blind model: the choice is a
// SETTLEMENT preference only — it never re-selects a route or reshapes the book. It does gate
// placement (both rails must be chosen) and drive the honest LN-readiness note + fee freeze.
function setRail(leg, r){
  const cur = leg === 'pay' ? S.payRail : S.recvRail;
  if (cur === r) return;
  if (leg === 'pay') S.payRail = r; else S.recvRail = r;
  // THE FOUR COMBINATIONS ARE ALL FIRST-CLASS, INCLUDING ON A SAME-CHAIN PAIR.
  //
  // The spec (seqdex-terminal-spec.md §"The user's two choices") is explicit: every order carries TWO
  // INDEPENDENT settlement preferences, "four combinations, all valid, all first-class", and "there is
  // no 'the system picks the rail'" — the user states a preference and the backend honours it.
  //
  // This used to COUPLE the rails on an asset<->asset pair, on the reasoning that such a swap settles as
  // one Sequentia transaction so it "cannot" be split. That is true only of the fully-on-chain primitive:
  // with a Lightning leg the swap is two HTLCs bound by ONE preimage (the proven submarine construction,
  // with the counter asset in BTC's structural place), settled PEER-TO-PEER against a counterparty whose
  // per-leg choices complement. The LSP is NOT implied by a mixed order — it bridges a leg only when the
  // two SIDES of that leg disagree, and separately fronts liquidity; nothing else. The coupling silently
  // overwrote a leg the user had just chosen and removed two of the four combinations outright, so it is
  // gone.
  //
  // The rails are now independent for every pair. Until the offer protocol can EXPRESS a per-leg rail on
  // a same-chain pair (LightningTerms hard-codes the Lightning leg as BTC), the mixed same-chain shape
  // has nothing to rest or match against, so findRoute fails CLOSED with a named reason ('same-railgap')
  // — never the old silent overwrite, and never a fall-through to a rail the user did not choose.
  LAST_QUOTE = null; setReviewEnabled(false);
  // A rail change can invalidate the fee asset outright (chain -> LN locks it to
  // the pay asset; BTC on-chain locks it to BTC). Drop the manual pick so the
  // policy re-decides from scratch rather than a stale choice surviving.
  S.feeAsset = null; S.feeAssetTouched = false;
  const ra = lnDeployed() ? railAvail(S.payAsset, S.receiveAsset) : null;
  paintRailSegs(ra);
  try { renderRailNote(ra); } catch {}   // refresh/clear the LN-channel note for the newly-selected rail
  try { renderFeePicker(); } catch {}   // reflect the pay-from-Lightning fee freeze immediately
  try { paintConfControl(); } catch {}  // the confidential-receive toggle depends on the receive rail (on-chain only)
  try { paintPanes(); } catch {}        // re-evaluate the place-CTA gate (both rails now required)
  requote().catch(()=>{});
}
function paintRefHints(){
  // Re-value the "≈ <ref>" hints against the current asset + typed amount. The
  // updaters read S.payAsset/S.receiveAsset live through their assetFn closures,
  // so calling them directly (not via a synthetic 'input') refreshes the hint
  // without re-arming the edited-side requote logic.
  try { _payHint && _payHint(); } catch {}
  try { _recvHint && _recvHint(); } catch {}
}

// The route line: rate ("1 tSEQ = 0.38 USDX · SeqDEX maker") + route label.
function paintRouteLine(){
  const { $ } = C;
  const route = findRoute(S.payAsset, S.receiveAsset);
  if (!S.payAsset || !S.receiveAsset){
    if (S.payAsset && !S.receiveAsset){
      const cps = counterpartsOf(S.payAsset);
      $('swRate').textContent = cps.length
        ? 'Choose what to receive.'
        : 'No markets trade against ' + tk(S.payAsset) + ' yet.';
    } else {
      $('swRate').textContent = 'Pick two assets to see a rate.';
    }
    $('swRoute').textContent = ''; return;
  }
  if (!route){
    $('swRate').textContent = 'No market between ' + tk(S.payAsset) + ' and ' + tk(S.receiveAsset) + '.';
    $('swRoute').textContent = '';
    return;
  }
  // The settlement rail is INVISIBLE to the user (it never changes which liquidity exists), so a BTC<->asset
  // pair shows only the plain direction — never a "Mixed rails" / "Cross-chain" / rail label. Same-chain
  // asset<->asset keeps a plain "order book" hint.
  $('swRoute').textContent =
      (route.kind === 'mixed' || route.kind === 'cross' || (route.kind === 'ln' && !route.assetAsset))
        ? (route.payIsBtc ? `Buy ${tk(S.receiveAsset)} with Bitcoin` : `Sell ${tk(S.payAsset)} for Bitcoin`)
    : 'Order book';
  // The rate line is filled by the quote (showQuote / showXRate); a placeholder until then.
  if (!LAST_QUOTE){ const _d = pairDir(S.payAsset, S.receiveAsset); $('swRate').textContent = '1 ' + tk(_d.base) + ' = … ' + tk(_d.quote); }
}

// ---------------------------------------------------------------------------
// flip + max
// ---------------------------------------------------------------------------
function onFlip(){
  const f = C.$('swFlip');
  f.classList.toggle('spun');
  // Swap assets AND amounts; keep the user's intent by flipping which side was edited.
  // Amount policy (task 20): the typed amount RIDES WITH ITS ASSET to the other field —
  // "I was buying 50 GOLD, now I'm selling 50 GOLD" keeps the number meaningful, where
  // keeping the number in place would silently re-denominate it in the other asset.
  [S.payAsset, S.receiveAsset] = [S.receiveAsset, S.payAsset];
  const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
  [pa.value, ra.value] = [ra.value, pa.value];
  [pa._userTyped, ra._userTyped] = [ra._userTyped, pa._userTyped];   // keep the anti-clobber flags with their values
  [pa._refMode, ra._refMode] = [ra._refMode, pa._refMode];           // ref-input mode rides with its value too
  // Flip the per-leg rails WITH the legs (the pay-leg rail follows the asset that is now the pay leg).
  // They stay whatever the user chose (or null if unchosen) — no auto-default.
  [S.payRail, S.recvRail] = [S.recvRail, S.payRail];
  S.edited = S.edited === 'pay' ? 'receive' : 'pay';
  S.feeAsset = null; S.feeAssetTouched = false;   // fee default re-follows the flipped pay asset (D2/C-11)
  LAST_QUOTE = null; setReviewEnabled(false);
  paintPanes();
  requote().catch(()=>{});
}
function onMax(){
  if (!S.payAsset || S.payAsset === 'BTC') return;
  const m = C.assetMeta(S.payAsset);
  let maxAtoms = balAtoms(S.payAsset);
  // Leave headroom for the network fee when it's paid in the SAME asset you're spending — otherwise
  // "Max" spends the whole balance and leaves nothing to cover the fee, so the order fails (C4).
  const feeAsset = feeAssetPolicy().asset;
  if (feeAsset === S.payAsset){ const fee = covFeeAtoms(feeAsset); if (maxAtoms > fee) maxAtoms -= fee; }
  // Max is an explicit user amount, and it HONOURS the field's entry mode: a field
  // showing USD gets the USD equivalent of the max, not a raw asset number relabelled
  // as dollars. Kicking the field out of ref mode here was the same override that
  // made the toggle feel like it would not stay put.
  setNativeField(C.$('swPayAmt'), C.fmtAtoms(maxAtoms, m.precision), S.payAsset);
  C.$('swPayAmt')._userTyped = true;
  S.edited = 'pay'; LAST_QUOTE = null; setReviewEnabled(false);
  paintRefHints();
  requote().catch(()=>{});
}

// ---------------------------------------------------------------------------
// quoting — fills the opposite amount + the rate/fee lines
// ---------------------------------------------------------------------------
// The amount actually typed (honouring the shared ⇄ ref-input mode), as a string.
function typedAmount(side){
  const input = side === 'pay' ? C.$('swPayAmt') : C.$('swRecvAmt');
  const hex = side === 'pay' ? S.payAsset : S.receiveAsset;
  return C.assetAmountOf ? C.assetAmountOf(input, hex) : (input.value || '').trim();
}

async function requote(){
  const { $ } = C;
  $('swErr').textContent = '';
  LAST_MID = null;
  paintRouteLine();
  // RAIL-BLIND: the rails NEVER change the book, the matching, or the quoted price. They are the user's
  // settlement preference (set by hand, no default). So requote does not touch S.payRail/S.recvRail at
  // all — it fetches the ONE book for the pair and quotes the market/limit against it, rail-blind.
  const route = findRoute(S.payAsset, S.receiveAsset);
  renderTiming(route);   // timing banner reflects the pair
  paintModeSeg();
  if (!route){ setReviewEnabled(false); clearOpposite(); clearBook(); paintCostLine(); stopLiveBook(); return; }
  const amtStr = typedAmount(S.edited);
  // Do NOT bail on an empty amount: the quote functions fetch and RENDER the ONE
  // order book first (so it is visible the moment a pair is chosen, on EVERY rail),
  // then quote only if an amount is present.
  try {
    // Only the same-chain path has the live WS book; other rails render XBOOK/UBOOK, so tear the
    // same-chain stream down when routing away (else a stale subscription keeps patching a hidden BOOK).
    if (route.kind === 'ln')         { if (!route.assetAsset) stopLiveBook(); await requoteLn(route, amtStr); }  // asset<->asset LN: keep the same-chain book live (one ladder on every rail); asset<->BTC LN uses the cross book, so drop the same-chain stream
    else if (route.kind === 'cross') { stopLiveBook(); await requoteCross(route, amtStr); }
    else if (route.kind === 'mixed') { if (!route.mixedSame) stopLiveBook(); await requoteMixed(route, amtStr); }  // mixed SAME-CHAIN keeps the pair's one ladder + stream; only the BTC-paired shapes leave it
    else                             await requoteSame(route, amtStr);
  } finally {
    try { paintCostLine(); } catch {}   // E2: the one cost line, after any rail quotes
    try { paintPriceField(); } catch {}  // P2.6: the always-present price field, after the book + quote render
    // D5/D3: refresh the recent-trades feed + 24h stats only when the PAIR changes (not per keystroke).
    try {
      const pk = (S.payAsset && S.receiveAsset) ? (S.payAsset + '|' + S.receiveAsset) : null;
      if (pk !== _tradesPair){
        _tradesPair = pk;
        if (pk){ renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{}); }
        else { const h = C.$('swTrades'); if (h) h.innerHTML = ''; const s = C.$('swPairStats'); if (s) s.innerHTML = ''; }
      }
    } catch {}
  }
}
function clearBook(){ renderBookPlaceholder(); renderPairBar(); }
// E2: ONE honest cost line. A taker always crosses the spread, so surface that as a positive
// magnitude vs the book mid (direction-safe — avoids a confusing "above/below" that flips between
// buy and sell): the price you take NOW vs resting an order at mid. Only in take mode with a live
// mid + both amounts; cleared otherwise. The network fee (in the reference currency) is already
// shown on the fee row, so this line is specifically the spread/immediacy cost the rate line hides.
function paintCostLine(){
  const el = C.$('swCost'); if (!el) return;
  el.textContent = ''; el.title = ''; el.style.color = '';
  if (S.mode === 'post') return;                              // limit order: you set the price
  if (!LAST_QUOTE || !LAST_MID || !(LAST_MID.price > 0)) return;
  if (LAST_MID.oneSided) return;   // only one side of the book exists: "mid" is just top-of-book, so a "% vs mid" would be fake (C-4)
  const payV = fieldUnits(C.$('swPayAmt'), S.payAsset), recvV = fieldUnits(C.$('swRecvAmt'), S.receiveAsset);
  if (!(payV > 0 && recvV > 0)) return;
  const cross = !!LAST_MID.cross, payIsBtc = S.payAsset === 'BTC';
  // Effective execution price in the SAME units as the mid (quote per base, in the frame the book was
  // rendered in). The taker BUYS the base when they RECEIVE it (base === receiveAsset; for cross that's
  // paying BTC): buying wants a LOWER quote-per-base, selling wants a higher one — so the improvement
  // direction follows the side, never mislabelling a favourable price as a "cost".
  const buyingBase = cross ? payIsBtc : (LAST_MID.base === S.receiveAsset);
  const eff = buyingBase ? (payV / recvV) : (recvV / payV);
  const mid = LAST_MID.price;
  if (!(eff > 0 && mid > 0) || !isFinite(eff)) return;
  const betterWhenLower = buyingBase;
  const rawPct = (eff / mid - 1) * 100;                    // + ⇒ effective above mid
  const improvePct = betterWhenLower ? -rawPct : rawPct;   // + ⇒ better for the taker
  const mag = Math.abs(improvePct);
  if (mag < 0.05){ el.textContent = 'at the mid price'; return; }
  // Never HIDE a large deviation (C4): a big number is real price impact from your size walking a thin
  // book — exactly when the taker most needs to see it. Escalate the wording instead of suppressing.
  if (improvePct > 0){
    el.style.color = '#3ddc84';
    el.textContent = `≈ ${mag.toFixed(mag < 1 ? 2 : 1)}% better than mid`;
    el.title = `You take at ~${trim(eff)} vs the ${trim(mid)} mid · better than resting at the mid price.`;
  } else {
    el.style.color = 'var(--amber2)';
    const label = mag > 8 ? 'price impact (thin book) vs mid' : 'spread cost vs mid';
    el.textContent = `≈ ${mag.toFixed(mag < 1 ? 2 : 1)}% ${label}`;
    el.title = `You take at ~${trim(eff)} vs the ${trim(mid)} mid · the cost of filling now (your size walks the book past the best price) instead of resting at the mid.`;
  }
}
// Before a pair is chosen the composer (the pay/receive selectors) IS the surface: the book area stays
// EMPTY so the selectors are the first thing you see, and the pair's detail (book / trades / stats)
// fills in ABOVE them once both assets are picked. When a pair IS chosen but has no resting orders yet,
// show a muted "order book" stand-in rather than a blank void.
function renderBookPlaceholder(){
  const host = C.$('swBook'); if (!host) return;
  if (!S.payAsset || !S.receiveAsset){ host.innerHTML = ''; return; }   // no pair → the composer leads
  host.innerHTML = `<div class="swladder"><div class="swladder-head">`
    + `<span class="sub" style="color:var(--txt);font-weight:650">Order book</span><span class="sub"></span></div>`
    + `<div class="swladder-empty">No resting orders for this pair yet.</div></div>`;
}

function clearOpposite(){
  const other = S.edited === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  clearDerived(other);   // never stomp a value the user typed or is editing on the OTHER side
}
function setReviewEnabled(on){
  const b = C.$('swReview'); if (!b) return;
  // RAIL-BLIND gate (spec §6.5): never enable placement until BOTH settlement rails are chosen — there
  // is NO default. A ready quote is necessary but not sufficient. paintPanes labels the CTA to prompt.
  const railsChosen = !!(S.payRail && S.recvRail);
  b.disabled = !(on && railsChosen);
  // Every error site disables the CTA, so an enabled Place beside an error banner means the
  // banner is stale (a past attempt's failure) — clear it the moment placement becomes possible.
  if (!b.disabled){ const e = C.$('swErr'); if (e) e.textContent = ''; }
}

// Build BOOK (asks/bids split by trade direction, expiry- and signature-filtered, best-price-first)
// from a flat offer list, then render the ladder. Shared by the REST quote path (requoteSame) and
// the live WS book (startLiveBook) so both produce a byte-identical book from the same offers. The
// relay keys markets by exact base/quote order, so a caller passes BOTH orientations' offers merged;
// this dedups by maker:offer_id. Returns the liftable (ask) side for the caller's quote math.
function applyOffersToBook(allOffers, pay, receive){
  const now = Math.floor(Date.now()/1000);
  const notExpired = (o) => { const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); return !(exp && exp <= now); };
  const seen = new Set(), liftable = [], otherSide = [];
  for (const o of (allOffers || [])){
    const id = (o.maker_pubkey||o.makerPubkey)+':'+(o.offer_id||o.offerId);
    if (seen.has(id)) continue; seen.add(id);
    if (o._verified === false) continue;                       // untrusted relay: skip forged rows
    if (!notExpired(o)) continue;
    const oa = o.offer_asset||o.offerAsset, wa = o.want_asset||o.wantAsset;
    if (oa === receive && wa === pay) liftable.push(o);
    else if (oa === pay && wa === receive) otherSide.push(o);
  }
  liftable.sort((a,bb)=> ratioRecvPerPay(bb) - ratioRecvPerPay(a));  // best price first
  BOOK = { pair:{ base_asset: receive, quote_asset: pay }, offers: liftable, otherOffers: otherSide };
  renderBook(pay, receive);
  return liftable;
}

// --- live book (D4): push, not poll — under the UNION discipline ---
// After the REST snapshot renders, subscribe to the relay's WS stream for the selected same-chain
// pair so the ladder ticks in real time as offers appear/expire. The relay sends a `public_book`
// snapshot per subscribed market, then `public_order_created` / `public_order_removed` deltas.
//
// THE COLLAPSE BUG THIS REPLACES: the old rebuild REPLACED the rendered book with the live map's
// contents, and requoteSame REPLACED it with the REST fetch — two sources that genuinely disagree
// (the relay's REST orderbook is liftable-filtered; its WS snapshot is not — a relay-side split),
// so whichever painted LAST won, and the ladder flip-flopped between a 2-offer and a 42-offer
// book depending on the path taken (the pair-bar price flip re-ran the REST paint with no fresh
// snapshot to heal it, so it stuck). Now NOTHING replaces: every render draws the UNION of the
// live map, the REST baseline and the LSP unified families (renderSameUnion), with:
//   • per-market snapshot receipt (lb.snaps): a public_book REPLACES only its own market's rows
//     in the live map, and a market whose snapshot never arrived is re-subscribed (bounded);
//   • tombstones (lb.tombs): a WS removal also suppresses the REST/unified copy of that offer,
//     so a cancel can't be resurrected by a stale baseline;
//   • the relay's own liveness rule mirrored client-side (collectSameOffers): a PLAIN
//     interactive offer that the liftable-filtered REST baseline does not list, and that is
//     past the relay's ghost grace, is unfillable and is not advertised.
// The stream key is ORIENTATION-INDEPENDENT (both orientations are always subscribed), so the
// pay/receive flip and the price-direction flip reuse the live stream instead of tearing it down
// — every path renders through the same union and can never regress below it.
// Display-only: rebuilds re-render the BOOK ladder but never touch the composer or re-derive
// amounts (B1). Transparent book only (the stream doesn't carry the blinded namespace).
let _liveBook = null;   // { relay, key, pay, receive, offers: Map, snaps: Set, tombs: Map, ... }
// setTimeout that never keeps a headless (node) process alive: the live-book timers are
// housekeeping, not work the host must wait for. No-op difference in the browser.
function _bgTimeout(fn, ms){ const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; }
function _liveKey(pay, receive){ return [String(pay), String(receive)].sort().join('␟'); }
function _liveOid(o){ return (o.maker_pubkey||o.makerPubkey)+':'+(o.offer_id||o.offerId); }
function _marketKey(pair){ return pair ? String(pair.base_asset||pair.baseAsset||'') + '/' + String(pair.quote_asset||pair.quoteAsset||'') : null; }
const _samePair = (pay, receive) => !!(pay && receive) &&
  ((S.payAsset === pay && S.receiveAsset === receive) || (S.payAsset === receive && S.receiveAsset === pay));
// True when the live WS book is currently connected for the pair on screen — drives the "· live"
// header hint so a user can tell the ladder is streaming, not a stale poll snapshot.
function liveBookOn(){ return !!(_liveBook && _liveBook.connected && _samePair(_liveBook.pay, _liveBook.receive)); }
function stopLiveBook(){
  const lb = _liveBook;
  if (!lb) return;
  _liveBook = null;   // null FIRST, so a pending onClose sees itself superseded and does NOT reconnect
  if (lb.timer)      { try { clearTimeout(lb.timer); } catch {} }
  if (lb.retryTimer) { try { clearTimeout(lb.retryTimer); } catch {} }
  if (lb.snapTimer)  { try { clearTimeout(lb.snapTimer); } catch {} }
  try { lb.relay && lb.relay.close(); } catch {}
}
function startLiveBook(pay, receive){
  if (!pay || !receive) return;
  const key = _liveKey(pay, receive);
  if (_liveBook && _liveBook.key === key) return;   // already streaming this pair (no reopen on keystrokes/flips)
  stopLiveBook();
  const offers = new Map();
  const lb = { relay: null, key, pay, receive, offers,
    snaps: new Set(),        // market keys ('base/quote') whose snapshot has arrived since (re)connect
    tombs: new Map(),        // oid -> ts(ms) of WS removals; suppresses stale REST/unified copies
    snapRetries: 0,
    timer: null, retryTimer: null, snapTimer: null, connected: false };
  const markets = [{ base_asset: receive, quote_asset: pay }, { base_asset: pay, quote_asset: receive }];
  const marketKeys = markets.map(_marketKey);
  // Live only while THIS pair is still the selected transparent-book pair and the tab is visible.
  const stillLive = () => {
    if (_liveBook !== lb || isConfBook()) return false;
    if (!_samePair(pay, receive)) return false;
    const host = C.$('swBook'); return !!(host && host.offsetParent !== null);
  };
  // Coalesce bursts (a maker re-post is a remove+create pair; the covenant book has dozens of rows)
  // into at most ~3 re-renders/sec, and only when this pair is still live. Renders the UNION in the
  // CURRENT composer orientation (never the closure's — the pay/receive flip keeps this stream).
  // After the ladder re-renders (which recomputes LAST_MID), repaint the cost-vs-mid line (T6).
  const rebuild = () => { lb.timer = null; if (!stillLive()) return; renderSameUnion(S.payAsset, S.receiveAsset); try { paintCostLine(); } catch {} };
  lb._rebuild = rebuild;   // test seam: flush without waiting out the coalesce timer
  const schedule = () => { if (!lb.timer) lb.timer = _bgTimeout(rebuild, 300); };
  // A market whose snapshot hasn't arrived is NOT authoritative in the live map — and it may be a
  // relay that dropped one of the two subscriptions (seen after relay restarts). Re-request the
  // missing market a bounded number of times; the union render keeps the REST baseline visible
  // meanwhile, so a lost snapshot degrades to "no live ticks for that orientation", never a collapse.
  const checkSnapshots = () => {
    lb.snapTimer = null;
    if (!stillLive() || !lb.connected) return;
    const missing = markets.filter((m, i) => !lb.snaps.has(marketKeys[i]));
    if (!missing.length || lb.snapRetries >= 3) return;
    lb.snapRetries++;
    for (const m of missing){ try { lb.relay && lb.relay.subscribe(m); } catch {} }
    lb.snapTimer = _bgTimeout(checkSnapshots, 4000);
  };
  const scheduleSnapCheck = () => { if (!lb.snapTimer) lb.snapTimer = _bgTimeout(checkSnapshots, 4000); };
  // Retry a failed/dropped connection with a bounded 3s backoff, but only while this pair is still on
  // screen. Used by BOTH onError (the WS never opened) and onClose (it dropped) — the retryTimer guard
  // dedups the two. Without the onError retry, a WS that never connects would leave the ladder frozen at
  // the initial REST snapshot with no live updates (there is no separate book poll fallback).
  const scheduleReconnect = () => {
    lb.connected = false;
    if (_liveBook !== lb || lb.retryTimer || !stillLive()) return;
    lb.retryTimer = _bgTimeout(() => { lb.retryTimer = null; if (stillLive()) connect(); }, 3000);
  };
  // A relay client that cannot even be CONSTRUCTED (no WebSocket in this host, bad URL) must
  // degrade exactly like a dropped connection: the union render keeps the REST baseline up and
  // the bounded backoff retries — never an exception up the requote path.
  const connect = () => { try { lb.relay = openLiveRelay(); } catch { scheduleReconnect(); } };
  const openLiveRelay = () => OB.openRelay(
      markets,
      {
        // Fresh snapshots incoming: reset the map AND the per-market receipts. onBook schedules the
        // render (a schedule() here could rebuild a blank map — the union render tolerates it, but
        // there is nothing to draw yet that the baseline doesn't already show).
        onOpen: () => { offers.clear(); lb.snaps.clear(); lb.snapRetries = 0; lb.connected = true; scheduleSnapCheck(); },
        onBook: (b) => {
          const mk = _marketKey(b && b.pair);
          if (mk){
            // A snapshot is authoritative FOR ITS OWN MARKET: drop that market's previous rows
            // (a resubscribe must not leave ghosts from the earlier snapshot), then insert.
            for (const [oid, o] of [...offers]){ if (_marketKey(o.pair||o.Pair) === mk) offers.delete(oid); }
            lb.snaps.add(mk);
          }
          for (const o of (b.offers||[])) offers.set(_liveOid(o), o);
          schedule();
        },
        onOfferCreated: (o) => { const oid = _liveOid(o); offers.set(oid, o); lb.tombs.delete(oid); schedule(); },
        onOfferRemoved: (r) => {
          const oid = _liveOid(r);
          offers.delete(oid);
          lb.tombs.set(oid, Date.now());
          // Prune: tombstones only need to outlive the REST baseline they suppress (~one requote).
          if (lb.tombs.size > 500){ const cut = Date.now() - 600000; for (const [k, ts] of lb.tombs){ if (ts < cut) lb.tombs.delete(k); } }
          schedule();
        },
        onError: scheduleReconnect,
        onClose: scheduleReconnect,   // relay restarted / dropped: reconnect while this pair is still on-screen
      });
  _liveBook = lb;
  connect();
}

// --- same-chain book sources: ONE union, whatever painted last -------------------------------
// SAMEBOOK holds the non-stream sources for the selected same-chain pair:
//   rest    — the relay's REST orderbook, BOTH orientations (the relay's liftable-filtered,
//             honest view: a plain interactive offer only appears while its maker's courier is
//             connected — server.go liftableOffers);
//   unified — the LSP unified book's rows for the pair (pure-LN / sub-asset / submarine
//             families + any same-chain rows the LSP merged), mapped into relay-offer shape.
// The WS live map (startLiveBook) is the third source. EVERY ladder paint goes through
// renderSameUnion, which draws the union of all three — so no path can regress the ladder
// below what the others know, and the flip / selector / rail paths render identical content.
let SAMEBOOK = null;   // { key, rest: Map<oid, offer>, restTs, restErr, unified: [] }
// Mirror of the relay's needsLiveMaker (server.go): filling a PLAIN same-chain offer requires
// its maker's live courier; covenant/lightning/cross offers settle without one.
function offerNeedsLiveMaker(o){
  return !(o.covenant || o.Covenant || o.lightning || o.Lightning || o.cross_chain || o.crossChain);
}
const GHOST_GRACE_SECS = 90;   // mirror of the relay's ghostGraceSecs (submit-then-connect gap)
// The union, honestly filtered. Live-map rows come first (freshest copy wins the dedupe), then
// the REST baseline (minus WS-tombstoned rows), then the unified families. The liveness rule:
// a plain interactive offer in the WS map that the FRESH liftable-filtered REST baseline does
// not list — and that is past the relay's ghost grace — has no maker to co-sign it (the relay's
// WS snapshot is unfiltered; its REST book is not — a relay-side split, reported upstream), so
// advertising it would quote depth nobody can fill. With no fresh REST baseline (relay REST
// unreachable), the WS content is the best truth we have and is kept whole.
function collectSameOffers(pay, receive){
  const key = _liveKey(pay, receive);
  const sb = (SAMEBOOK && SAMEBOOK.key === key) ? SAMEBOOK : null;
  const lb = (_liveBook && _liveBook.key === key) ? _liveBook : null;
  const restFresh = !!(sb && !sb.restErr && (Date.now() - sb.restTs) < 60000);
  const nowS = Math.floor(Date.now()/1000);
  const out = [];
  if (lb){
    for (const o of lb.offers.values()){
      if (restFresh && offerNeedsLiveMaker(o) && !sb.rest.has(_liveOid(o))){
        const created = Number(o.created_at_unix || o.createdAtUnix || 0);
        if (!(created && (nowS - created) < GHOST_GRACE_SECS)) continue;   // ghost: unfillable, don't advertise
      }
      out.push(o);
    }
  }
  const tombs = lb ? lb.tombs : null;
  if (sb){
    for (const [oid, o] of sb.rest){ if (tombs && tombs.has(oid)) continue; out.push(o); }
    for (const o of sb.unified){ if (tombs && tombs.has(_liveOid(o))) continue; out.push(o); }
  }
  return out;
}
// The ONE ladder paint for a same-chain pair. Returns the liftable side (display rows included;
// callers that EXECUTE filter to what their path can settle — see takeMarketWalk / requoteSame).
function renderSameUnion(pay, receive){
  return applyOffersToBook(collectSameOffers(pay, receive), pay, receive);
}
// Map the LSP unified book's entries into relay-offer-shaped rows for the pair ladder.
//   • An entry whose raw offer IS a same-chain relay offer for this pair is pushed as that raw
//     offer (signature re-verified after the protojson byte-field fixup): it is directly
//     executable and dedupes against the relay/WS copies by maker:offer_id.
//   • The LN families (pure-LN / sub-asset / submarine) become DISPLAY rows (_displayOnly) in
//     the same base/quote frame: the ladder shows them rail-blind; the match includes them only
//     through the shared executability predicates (sameChainRowExecutable) — shown, never
//     silently taken.
function unifiedSameRows(ub, cp){
  const rows = [];
  for (const side of ['asks', 'bids']){
    const isAsk = side === 'asks';
    for (const e of (ub[side] || [])){
      if (!e || !(Number(e.assetAtoms) > 0) || !(Number(e.btcSats) > 0)) continue;
      const raw = e.raw || null;
      const oa = raw && (raw.offer_asset ?? raw.offerAsset), wa = raw && (raw.want_asset ?? raw.wantAsset);
      const sameChainRaw = raw && !(raw.lightning || raw.Lightning)
        && ((oa === cp.base && wa === cp.quote) || (oa === cp.quote && wa === cp.base));
      if (sameChainRaw){
        const o = seqob.normRelayOffer({ ...raw });
        o._verified = (o.maker_sig || o.makerSig) ? seqob.verifyOffer(o) : true;
        rows.push(o);
        continue;
      }
      rows.push({
        offer_id: e.id || ('unified:' + side + ':' + rows.length),
        maker_pubkey: e.maker || 'unified',
        offer_asset: isAsk ? cp.base : cp.quote, want_asset: isAsk ? cp.quote : cp.base,
        offer_amount: String(isAsk ? e.assetAtoms : e.btcSats), want_amount: String(isAsk ? e.btcSats : e.assetAtoms),
        base_amount: String(e.assetAtoms),
        pair: { base_asset: cp.base, quote_asset: cp.quote },
        expires_at_unix: e.expires || 0,
        _verified: true, _displayOnly: true, _rail: e.rail, _entry: e,
      });
    }
  }
  return rows;
}
// Can THIS chain/chain same-pair take settle a given ladder row? Direct same-chain rows: yes —
// the covenant walk / interactive lift executes them. LN-family display rows: only when the SAME
// shared predicates every other rail uses (planSettlement happy-coincidence / bridgedTakeSupported)
// accept the crossing for chain/chain rails, with the LSP in the loop — the match must never
// select a row that Review would then refuse (offer-then-refuse). The maker's per-leg rails come
// from the unified entry's own family, in the asset-paired convention (the quote asset stands in
// BTC's structural place).
const _unifiedMakerRails = {
  pureln:    { makerAssetRail: 'ln',    makerBtcRail: 'ln'    },   // both legs Lightning
  submarine: { makerAssetRail: 'chain', makerBtcRail: 'ln'    },   // asset on-chain, quote over LN
  ln:        { makerAssetRail: 'ln',    makerBtcRail: 'chain' },   // sub-asset: asset over LN, quote on-chain
  onchain:   { makerAssetRail: 'chain', makerBtcRail: 'chain' },
};
function sameChainRowExecutable(o, cp, pay){
  if (!o) return false;
  if (!o._displayOnly) return true;
  const e = o._entry; if (!e) return false;
  if (!(L && L.swap)) return false;   // a bridged settlement needs the LSP in the value path
  try {
    const mr = _unifiedMakerRails[e.rail]; if (!mr) return false;
    const side = (pay === cp.quote) ? 'buy' : 'sell';
    const t = { asset: cp.base, side, payRail: 'chain', recvRail: 'chain',
      makerBtcRail: mr.makerBtcRail, makerAssetRail: mr.makerAssetRail,
      takerAssetInbound: false, takerBtcInbound: false };
    return planSettlement(matchFromTake(t)).happyCoincidence || bridgedTakeSupported(t);
  } catch { return false; }
}
// Load + render the same-chain pair's ONE book: REST both orientations + the LSP unified
// families, then the union paint, then the live stream. EVERY rail path for a same-chain pair
// goes through here (requoteSame; requoteLn asset<->asset; requoteMixed mixed same-chain), so
// the rail selection can never change the ladder's content. `stillCurrent` lets the caller
// abandon a superseded load before it paints (the pair changed mid-fetch).
async function loadSameBook(pay, receive, stillCurrent){
  const conf = isConfBook();
  let reachErr = null;
  const bookOpts = { confidential: conf };   // read the selected namespace
  const safeBook = async (a, b) => {
    try { return await OB.fetchBook(a, b, bookOpts); }
    catch (e){ if (/HTTP\s*4\d\d/.test(e.message||'')) return { offers: [] };   // 4xx: empty/unknown market
               reachErr = e; return { offers: [] }; }                            // network/5xx: unreachable
  };
  const cp = canonicalPair(pay, receive);
  const [b1, b2, ub] = await Promise.all([
    safeBook(receive, pay), safeBook(pay, receive),
    // The unified families are transparent-book only, and absent without an LSP — never fatal.
    conf ? Promise.resolve(null) : getUnifiedBook(cp.base, cp.quote).catch(() => null),
  ]);
  if (stillCurrent && !stillCurrent()) return null;
  const rest = new Map();
  for (const o of [...(b1.offers || []), ...(b2.offers || [])]) rest.set(_liveOid(o), o);
  let unified = [];
  if (ub){
    UBOOK = { seqAsset: cp.base, quote: ub.quote || cp.quote, asks: ub.asks || [], bids: ub.bids || [] };
    unified = unifiedSameRows(UBOOK, cp);
  } else if (!conf){
    UBOOK = null;   // no unified feed for this pair right now — never leave a stale one for the planners
  }
  SAMEBOOK = { key: _liveKey(pay, receive), rest, restTs: Date.now(), restErr: reachErr, unified };
  const liftable = renderSameUnion(pay, receive);
  // Keep the book live: after the REST snapshot, subscribe to the relay's push stream so the
  // ladder ticks as offers appear/expire. Transparent book only; the confidential book (which
  // the WS stream doesn't carry) tears the stream down instead.
  if (conf) stopLiveBook(); else startLiveBook(pay, receive);
  return { liftable, reachErr };
}

// --- same-chain: the unified PLACE-ORDER path (passive-CLOB covenant) ---
// Every same-chain order is "Place order": the two amount fields are the user's own
// limit (their ratio IS the price), and Place funds a self-enforcing covenant that
// rests on-chain and fills whenever it is crossed — even while the wallet is closed.
// The book still renders on the left (any resting orders); clicking a level seeds
// the fields. There is NO take-vs-post distinction — the matcher crosses the order.
let _reqSameGen = 0;   // supersession guard: a newer requoteSame invalidates an older one's in-flight book fetch
async function requoteSame(route, amtStr){
  const { $ } = C;
  const pay = route.pay, receive = route.receive;
  const myGen = ++_reqSameGen;
  const status = $('swStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the order book…';
  $('swErr').textContent = '';
  try {
    S.feeAsset = feeAssetPolicy().asset;   // forced: the policy is the only authority
    // ONE book for the pair: REST both orientations + the live WS union + the LSP unified
    // families, loaded and painted by the SHARED loader every rail path uses (loadSameBook), so
    // the price flip / pair re-select / rail switch all render identical content. T7: a 4xx is
    // "no such market yet" (genuinely empty); a network/5xx means the relay is UNREACHABLE —
    // never conflate the two, or an outage looks like an empty book and invites posting into
    // the void. Supersession: if a newer requoteSame started while the fetches were in flight,
    // loadSameBook bails before painting — the newer call owns the render + the subscription.
    const loaded = await loadSameBook(pay, receive, () => myGen === _reqSameGen);
    if (!loaded) return;
    const { liftable, reachErr } = loaded;
    // MATCH SET (rail-blind matching with honest executability): the ladder SHOWS every family,
    // but the market/limit match prices only rows this take can actually settle — the directly
    // liftable same-chain rows, plus any LN-family row the SHARED bridge predicates accept
    // (sameChainRowExecutable). A non-executable row is shown, never silently matched.
    const cpm = canonicalPair(pay, receive);
    const matchable = liftable.filter(o => sameChainRowExecutable(o, cpm, pay));

    // T7: relay unreachable AND nothing to show — say so and let the user retry.
    if (reachErr && !liftable.length){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Order book unreachable - retry.';
      $('swRoute').textContent = '';
      $('swErr').textContent = 'Could not reach the order-book relay (' + (reachErr.message || reachErr) + '). Check your connection and try again (re-enter the amount to retry).';
      return;
    }
    status.textContent = '';

    // MARKET (default): fill the empty side from the book's best EXECUTABLE price, WITHOUT wiping
    // user input. LIMIT (S.mode==='post'): the two fields are independent — the user sets their own
    // price, so we never auto-derive. (Empty market: best is null -> no derivation either way.)
    // The derivation prices from the MATCHABLE set: quoting a display-only row's price would
    // promise a fill the settle path cannot deliver (the ladder still shows it).
    const best = bestReceivePerPay(matchable, pay, receive);
    _composeBest = { pay, receive, best };   // cache for the instant per-keystroke auto-fill (wireAmount)
    if (S.mode === 'take') applyComposeDerivation(pay, receive, best);
    paintPlaceRate(pay, receive, best, liftable.length);
    S.feeAsset = feeAssetPolicy().asset;   // forced, so a stale pick cannot survive a rail change
    paintFee(S.feeAsset, S.feeAsset ? covFeeAtoms(S.feeAsset) : null);   // compose-time estimate in the chosen fee asset, not "-"
    setFinality('same');

    // Enable Place order once BOTH amounts are set and the pay leg is affordable.
    const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
    const payAtoms  = fieldAtoms($('swPayAmt'), pay);
    const recvAtoms = fieldAtoms($('swRecvAmt'), receive);
    if (payAtoms <= 0n || recvAtoms <= 0n){ LAST_QUOTE = null; setReviewEnabled(false); return; }
    // Affordability: the pay leg AND the funding fee must both be covered. The covenant funding fee is
    // paid in the chosen fee asset (C-1), so when that's the pay asset the balance must cover BOTH; when
    // it's a different asset, that asset must separately cover the fee (C-2).
    // The fee asset comes from the ONE authority, so the gate can never test an
    // asset the picker would not actually let the user pay in.
    const _feeAsset = feeAssetPolicy().asset;
    const _feeAtoms = _feeAsset ? covFeeAtoms(_feeAsset) : 0n;
    if (payAtoms + (_feeAsset === pay ? _feeAtoms : 0n) > balAtoms(pay)){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swErr').textContent = _feeAsset === pay
        ? `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker} · not enough for the amount plus the fee.`
        : `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker}.`;
      return;
    }
    if (_feeAsset && _feeAsset !== pay && _feeAtoms > balAtoms(_feeAsset)){
      LAST_QUOTE = null; setReviewEnabled(false);
      const _fm = C.assetMeta(_feeAsset);
      $('swErr').textContent = `You need about ${C.fmtAtoms(_feeAtoms, _fm.precision)} ${_fm.ticker} for the fee, but hold ${C.fmtAtoms(balAtoms(_feeAsset), _fm.precision)}.`;
      return;
    }
    if (isConfBook()){
      // The BLINDED book rides the INTERACTIVE co-sign rail (seqob.lift for a taker,
      // seqob.postOffer for a maker) — NEVER the covenant rail: a covenant FILL leaf
      // introspects EXPLICIT output amounts, which CT (Pedersen-committed amounts)
      // cannot satisfy. Lift a crossable blinded offer if one rests; otherwise rest a
      // blinded offer (both legs blind to each party's blinding pubkey).
      const editedAsset = S.edited === 'pay' ? pay : receive;
      const editedAtoms = S.edited === 'pay' ? payAtoms : recvAtoms;
      if (matchable.length){
        const q = executableQuote(matchable[0], pay, receive, editedAsset, editedAtoms);
        q.confidential = true;
        if (q.amountP > balAtoms(pay)){
          LAST_QUOTE = null; setReviewEnabled(false);
          $('swErr').textContent = `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker}.`;
          return;
        }
        LAST_QUOTE = q;
      } else {
        LAST_QUOTE = { kind:'same', startMarket:true, post:true, confidential:true, pay, receive };
      }
      setReviewEnabled(true);
      return;
    }
    if (S.mode === 'take'){
      // MARKET (spec line 177): a market order is a TAKER — WALK the book now and never rest a
      // remainder. Best-price-first ACROSS families: when the best MATCHABLE row is an LN-family
      // maker (a display row the shared bridge predicates accepted), the take routes through the
      // SAME mixed pipeline every other rail uses — review == execution, one book, one match.
      // The covenant walk below stays the executor for the direct same-chain rows.
      const direct = matchable.filter(o => !o._displayOnly);
      const bestBridged = matchable.find(o => o._displayOnly) || null;   // matchable keeps best-price-first order
      const bestDirect = direct[0] || null;
      if (bestBridged && (!bestDirect || ratioRecvPerPay(bestBridged) > ratioRecvPerPay(bestDirect))){
        LAST_QUOTE = { kind: 'mixed',
          route: { kind: 'mixed', mixedSame: true, seqAsset: cpm.base, quoteAsset: cpm.quote,
                   payIsBtc: pay === cpm.quote, xm: null, payRail: 'chain', recvRail: 'chain' },
          seqAsset: cpm.base, payIsBtc: pay === cpm.quote, payRail: 'chain', recvRail: 'chain' };
        setReviewEnabled(true);
        return;
      }
      // Route to the walk when something DIRECTLY liftable crosses the price; otherwise say so
      // plainly (no silent rest). crossableDepthAtoms measures the resting depth that meets the
      // order price — over the rows the walk can actually fill, never the display-only families.
      const depth = crossableDepthAtoms(direct, payAtoms, recvAtoms);
      if (depth <= 0n){
        LAST_QUOTE = null; setReviewEnabled(false);
        $('swErr').textContent = `Nothing is resting that crosses your price for ${rm.ticker}/${pm.ticker}. A market order only fills against resting orders · switch to Limit to rest an order at your price.`;
        return;
      }
      LAST_QUOTE = { kind:'same', takeMkt:true, pay, receive, payAtoms, recvAtoms };
      setReviewEnabled(true);
      return;
    }
    // LIMIT (post): rest a covenant at the user's price (offline-liftable passive CLOB).
    LAST_QUOTE = { kind:'same', place:true, pay, receive, payAtoms, recvAtoms };
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Order book: ' + C.prettyErr(e);
    setReviewEnabled(false);
  }
}

// The rate + route lines for the place-order composer.
function paintPlaceRate(pay, receive, best, bookLen){
  const { $ } = C;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payV = fieldUnits($('swPayAmt'), pay), recvV = fieldUnits($('swRecvAmt'), receive);
  const yourPrice = (payV > 0 && recvV > 0) ? recvV / payV : 0;
  // Display "1 base = N quote" (canonical direction); the crossing test stays in native receive-per-pay.
  const yourLine = yourPrice > 0 ? ratePerPayToLine(pay, receive, yourPrice).str : null;
  const bestQ = best ? ratePerPayToLine(pay, receive, best).qpb : 0;
  if (S.mode === 'post'){
    // LIMIT: the user's own price. Compare to the book so they know if/when it crosses.
    if (yourPrice > 0){
      let s = `Limit · ${yourLine}`;
      if (best) s += yourPrice <= best ? ` · crosses now (best ${fmtPrice(bestQ)})` : ` · rests until crossed (best ${fmtPrice(bestQ)})`;
      $('swRate').textContent = s;
    } else {
      $('swRate').textContent = 'Limit · set both amounts; their ratio is your price.';
    }
  } else {
    // MARKET: fill at the best executable offer.
    if (yourPrice > 0 && best){
      // If the order is bigger than the resting depth at this price, it fills what's there now and
      // rests the remainder as a limit — surface that split.
      const split = marketFillSplit(fieldAtoms($('swPayAmt'), pay), fieldAtoms($('swRecvAmt'), receive));
      let s = `Market · ${yourLine} (best offer)`;
      if (split) s += ` · fills ~${trim(Number(split.fill)/Math.pow(10, pm.precision||0))} ${pm.ticker} now, ~${trim(Number(split.rest)/Math.pow(10, pm.precision||0))} rests`;
      $('swRate').textContent = s;
    } else if (best){
      $('swRate').textContent = `Market · fills at ${ratePerPayToLine(pay, receive, best).str} · set an amount.`;
    } else {
      $('swRate').textContent = bookLen
        ? 'No crossable offers yet · set both amounts to rest an order (their ratio is your price).'
        : 'No resting orders yet · set both amounts to place the first order.';
    }
  }
  $('swRoute').textContent = bookLen ? 'Order book · place a resting order' : 'Order book · be the first';
}

// Best RECEIVE-per-PAY price from the crossable asks, in DISPLAY units.
function bestReceivePerPay(offers, pay, receive){
  const pm = metaOf(pay), rm = metaOf(receive);
  let best = 0;
  for (const o of (offers||[])){
    // ORIENTATION GUARD: price ONLY a row that actually pays out the RECEIVE asset and takes
    // the PAY asset. The caller's side-filtering normally guarantees this, but during a partial
    // book load (REST unreachable, unified families mid-update) a wrong-direction row can reach
    // this pool — and pricing it INVERTS the derivation: on a GOLD->EURX sell the composer
    // derived receive = pay x (1/3846) and painted a dust amount, silently disabling Place.
    // A row that names its legs and names them wrong is skipped; a legacy row without leg
    // assets keeps the old behavior (the caller's filtering is all it ever had).
    const oa = o.offer_asset ?? o.offerAsset, wa = o.want_asset ?? o.wantAsset;
    if ((oa && oa !== receive) || (wa && wa !== pay)) continue;
    const recvU = Number(big(o.offer_amount||o.offerAmount)) / Math.pow(10, rm.precision||0);
    const payU  = Number(big(o.want_amount ||o.wantAmount )) / Math.pow(10, pm.precision||0);
    if (payU > 0){ const p = recvU/payU; if (p > best) best = p; }
  }
  return best || null;
}
function safeAtoms(str, prec){ try { return C.parseAtoms((str||'').trim(), prec); } catch { return 0n; } }

// THE amount a field actually MEANS, in the asset's atoms. When the ⇄ toggle put the
// field in reference-currency (USD) input mode, its raw text is a USD number, NOT native
// units — C.assetAmountOf converts it back to the exact asset amount string (the same one
// the ⇄ hint shows). Reading `el.value` raw in USD mode was the bug where "10 USD" became
// "10 BTC" (470,159 EURX for a $6 buy). Every compose/quote/review/place atoms-read MUST
// go through this, never safeAtoms(el.value, …) directly on a user-facing amount field.
function fieldAtoms(el, hex){
  if (!el) return 0n;
  const prec = C.assetMeta(hex).precision || 0;
  let s;
  try { s = C.assetAmountOf(el, hex); } catch { s = null; }
  if (s == null) s = el._refMode ? '' : (el.value || '');   // fail safe: never treat a USD number as native
  return safeAtoms(s, prec);
}
// numVal that honors ref mode: the field's numeric value in ASSET units (for affordability
// display / >0 checks). In USD mode the raw number is meaningless as an asset amount.
function fieldUnits(el, hex){ const a = fieldAtoms(el, hex); const prec = C.assetMeta(hex).precision || 0; return Number(a) / Math.pow(10, prec); }

// Write a fixed amount into a field the user cannot change (the maker's exact terms).
//
// It must NOT drag the field out of ⇄ reference-currency mode. It used to, and that
// was the bug where switching the pay field to USD and typing flipped it straight
// back to BTC: renderMixedTake pins both legs on EVERY requote, so each keystroke
// re-entered this and cleared _refMode under the user's cursor. The entry mode is
// the user's choice and persists until they change it.
//
// What the old code was right to worry about is the LABEL: writing a native number
// into a field displaying USD would mislabel it, and a later fieldAtoms read would
// convert it a second time. So instead of leaving ref mode, CONVERT into it — the
// same thing applyComposeDerivation does — and only fall back to clearing the mode
// when the conversion is genuinely unavailable (no reference price for the asset).
function setNativeField(el, str, hex){
  if (!el) return;
  // ⚠ NEVER FIGHT THE FIELD BEING TYPED IN.
  //
  // renderMixedTake pins BOTH legs on every requote, and a requote fires on every
  // keystroke. Without this guard the composer overwrites the input under the
  // user's cursor mid-number: typing "100" gets caught at "10" and replaced with
  // the sized take, and in reference-currency mode the replacement is the
  // round-tripped value (10 USD -> atoms -> 9.99996818 USD), so even a completed
  // number visibly rewrites itself.
  //
  // applyComposeDerivation has always had this rule ("never fight the field being
  // typed in") for the OTHER leg; the pin needs it too. The field settles to the
  // canonical value on the next requote after focus leaves.
  if (typeof document !== 'undefined' && document.activeElement === el) return;
  // Nor rewrite a value that already means the same thing. A user-typed amount and
  // its canonical rendering can differ by rounding noise alone (10 vs 9.99996818);
  // replacing one with the other changes nothing and looks like the app arguing.
  if (hex && sameAmount(el, str, hex)) return;
  el._userTyped = false;
  if (el._refMode){
    const rv = refOfNativeStr(hex, str);
    if (rv != null){ el.value = rv; return; }        // stays in USD, shows the USD equivalent
    el._refMode = false;                             // unpriced: the mode cannot be honoured
    try { paintRefHints(); } catch {}
  }
  el.value = str;
}

// Whether a field already holds `str` in substance — same atoms once parsed,
// whatever its display mode. Used so a pin never replaces a value with an
// equivalent one that merely renders differently.
function sameAmount(el, str, hex){
  try {
    const prec = C.assetMeta(hex).precision || 0;
    const want = C.parseAtoms(String(str), prec);
    const have = fieldAtoms(el, hex);
    return want === have;
  } catch { return false; }
}

// A native amount string -> its reference-currency (USD) number, or null when the
// asset has no reference price. Used to honour a field's display mode instead of
// overriding it.
function refOfNativeStr(hex, str){
  try {
    if (!hex || !C.refValue || !C.parseAtoms) return null;
    const prec = C.assetMeta(hex).precision || 0;
    const atoms = C.parseAtoms(String(str), prec);
    const rv = C.refValue(hex, atoms);
    return (rv && rv.v != null) ? String(trim(rv.v)) : null;
  } catch { return null; }
}

// PAY-atoms of resting book depth that meets the order's price right now — the amount a Market
// order can fill immediately (asks giving >= the order's receive-per-pay). Anything above this
// depth is the remainder that rests. `offers` are the crossable asks (BOOK.offers), each offering
// `offer_amount` of RECEIVE for `want_amount` of PAY. A best-effort preview; the matcher does the
// actual crossing at fill time.
function crossableDepthAtoms(offers, orderPayAtoms, orderRecvAtoms){
  const op = Number(orderPayAtoms), or = Number(orderRecvAtoms);
  const orderPrice = op > 0 ? or / op : 0;               // receive per pay the order is willing to accept
  let d = 0n;
  for (const o of (offers || [])){
    const recvU = Number(big(o.offer_amount || o.offerAmount || 0));
    const payU  = Number(big(o.want_amount  || o.wantAmount  || 0));
    if (payU <= 0) continue;
    if (recvU / payU + 1e-9 >= orderPrice) d += big(o.want_amount || o.wantAmount || 0);   // ask meets the price
  }
  return d;
}
// The Market fill/rest preview for an order of `payAtoms` against the current book: how much fills
// now vs rests as a limit. null when nothing rests (full fill) or nothing crosses (whole thing rests).
function marketFillSplit(payAtoms, recvAtoms){
  // Depth over the rows the walk can actually fill — a display-only (LN-family) row on the
  // ladder must not inflate the "fills now" preview.
  const depth = crossableDepthAtoms(((BOOK && BOOK.offers) || []).filter(o => !o._displayOnly), payAtoms, recvAtoms);
  const pay = BigInt(payAtoms);
  const fill = depth > pay ? pay : depth;                // can't fill more than the order
  const rest = pay - fill;
  if (fill <= 0n || rest <= 0n) return null;             // full fill or no crossable liquidity -> no split to show
  return { fill, rest };
}

// POST mode (same-chain): the two amount fields are the user's OWN limit — their ratio
// IS the price. We do NOT touch either field (no book-derived fill) and route Review to
// postOfferReview (seqob.signOffer + seqob.postOffer), the proven offer-post path. The
// book (with any resting rows) still renders on the left; this rests a new order into it.
function postModeSame(pay, receive){
  const { $ } = C;
  S.feeAsset = feeAssetPolicy().asset;   // forced: the policy is the only authority
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const pv = fieldUnits($('swPayAmt'), pay), rv = fieldUnits($('swRecvAmt'), receive);
  const hasBook = !!(BOOK.offers && BOOK.offers.length);
  LAST_QUOTE = { kind:'same', startMarket:true, post:true, pay, receive };
  if (pv > 0 && rv > 0){
    $('swRate').textContent = `Your price · ${ratePerPayToLine(pay, receive, rv/pv).str} · Post to rest this offer.`;
  } else {
    $('swRate').textContent = hasBook
      ? `Set both amounts · their ratio is your limit price · then Post a resting offer.`
      : `No resting offers yet · set both amounts (their ratio is your price) to post the first order.`;
  }
  $('swRoute').textContent = hasBook ? 'Order book · post a limit order' : 'Order book · be the first';
  paintFee(S.feeAsset, covFeeAtoms(S.feeAsset));   // compose-time estimate in the chosen fee asset, not "-"
  setFinality('same');
  setReviewEnabled(pv > 0 && rv > 0);
}

function ratioRecvPerPay(o){
  const off = Number(o.offer_amount || o.offerAmount || 0), want = Number(o.want_amount || o.wantAmount || 0);
  return want > 0 ? off/want : 0;
}
function ceilDiv(a, b){ return (a + b - 1n) / b; }

// T14: best ask/bid, mid, spread (all in PAY per 1 RECEIVE, the conventional "price of receive") and
// total takeable depth (in RECEIVE units), from the two book sides — whichever the data allows. Any
// side may be absent, in which case its figure is null. sideA = offers we can take (give RECEIVE,
// want PAY); sideB = the opposite side (give PAY, want RECEIVE).
// TODO(browser-verify): the per-row price still reads RECEIVE-per-PAY while this summary reads
// PAY-per-RECEIVE (conventional). Both are explicitly labelled; confirm they read clearly together.
function bookStats(sideA, sideB, payMeta, recvMeta){
  const toPay  = a => Number(a)/Math.pow(10, payMeta.precision||0);
  const toRecv = a => Number(a)/Math.pow(10, recvMeta.precision||0);
  let bestAsk = Infinity, bestBid = 0, depthRecv = 0;
  for (const o of (sideA||[])){
    const off = toRecv(big(o.offer_amount||o.offerAmount)), want = toPay(big(o.want_amount||o.wantAmount));
    if (off > 0){ depthRecv += off; const p = want/off; if (p > 0 && p < bestAsk) bestAsk = p; }   // cheapest ask
  }
  for (const o of (sideB||[])){
    const off = toPay(big(o.offer_amount||o.offerAmount)), want = toRecv(big(o.want_amount||o.wantAmount));
    if (want > 0){ const p = off/want; if (p > bestBid) bestBid = p; }                              // highest bid
  }
  const hasAsk = isFinite(bestAsk) && bestAsk > 0, hasBid = bestBid > 0;
  return { bestAsk: hasAsk?bestAsk:null, bestBid: hasBid?bestBid:null,
           mid: (hasAsk&&hasBid)?(bestAsk+bestBid)/2:null, spread:(hasAsk&&hasBid)?(bestAsk-bestBid):null, depthRecv };
}

// Executable legs against ONE resting offer, using the daemon's exact proRata:
//   recv = floor(offer_amount * take / base),  pay = ceil(want_amount * take / base)
// with `take` in BASE atoms. The user's typed amount selects `take`; the executed
// amounts are the authoritative proRata, capped at the offer's size (single-offer fill).
function executableQuote(o, payAsset, receiveAsset, editedAsset, typedAtoms){
  const baseAsset = o.pair ? (o.pair.base_asset||o.pair.baseAsset) : (o.base_asset||o.baseAsset);
  const baseAmt = big(o.base_amount||o.baseAmount), offerAmt = big(o.offer_amount||o.offerAmount), wantAmt = big(o.want_amount||o.wantAmount);
  let take;
  if (editedAsset === baseAsset)       take = typedAtoms;
  else if (baseAsset === receiveAsset) take = wantAmt > 0n ? (typedAtoms * baseAmt) / wantAmt : 0n;   // typed the pay leg
  else                                 take = offerAmt > 0n ? ceilDiv(typedAtoms * baseAmt, offerAmt) : 0n; // typed the receive leg
  if (take < 1n) take = 1n;
  if (take > baseAmt) take = baseAmt;
  const recv = (offerAmt * take) / baseAmt;
  const pay  = ceilDiv(wantAmt * take, baseAmt);
  const feeAsset = feeAssetPolicy().asset;
  // Open-fee-market fee: the native policy fee (in tSEQ-sats) converted into the chosen
  // fee asset via its published exchange rate — fee_atoms = ceil(native_fee_sats * SCALE / rate),
  // so a more valuable asset pays FEWER atoms. NOTE feeRateFor() is the exchange RATE, not a fee
  // amount; the old `feeRateFor * vsize` produced an absurd fee (e.g. ~29,526 USDX) that broke funding.
  let feeAmount = 0n, feeRate = BigInt(C.EXCHANGE_RATE_SCALE);
  try {
    feeRate = C.feeRateFor(feeAsset);   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
    const nativeFeeSats = (BigInt(C.DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;   // sat/kvB * vbytes / 1000
    feeAmount = ceilDiv(nativeFeeSats * BigInt(C.EXCHANGE_RATE_SCALE), feeRate);
  } catch {}
  return { kind:'same', offer:o, takeBase:take,
    assetP: payAsset, amountP: pay, assetR: receiveAsset, amountR: recv,
    feeAsset, feeAmount, feeRate, capped: take >= baseAmt };
}

function paintEmptyRate(pay, receive, n){
  const { $ } = C;
  $('swRate').textContent = n
    ? `${n} resting offer${n>1?'s':''} for ${C.assetMeta(receive).ticker} - enter an amount.`
    : `No resting offers for ${C.assetMeta(receive).ticker}/${C.assetMeta(pay).ticker} yet - enter an amount to start this market.`;
  $('swRoute').textContent = 'Order book';
  setFinality('same');
}

// Derive pay/receive legs (the proven 6d-1 mapping).
// SELL base: send base (typed), receive quote (previewed). BUY base: receive base, send quote.
function orientLegs(m, side, baseAtoms, p){
  const base = m.market.base_asset, quote = m.market.quote_asset;
  const counterAmt = big(pick(p, 'amount') || 0);
  const counterAsset = pick(p, 'asset') || quote;
  if (side === 'BUY')
    return { assetP: counterAsset, amountP: counterAmt, assetR: base, amountR: baseAtoms };
  return { assetP: base, amountP: baseAtoms, assetR: counterAsset, amountR: counterAmt };
}

// Fill the opposite amount field + the rate/fee lines from LAST_QUOTE.
function paintQuoteSame(){
  const { $ } = C; const q = LAST_QUOTE; if (!q) return;
  // assetP/amountP is what we PAY; assetR/amountR is what we RECEIVE.
  const pm = C.assetMeta(q.assetP), rm = C.assetMeta(q.assetR);
  // Write the side we did NOT edit (writeDerived guarantees the user's typed field is never stomped).
  if (S.edited === 'pay'){
    writeDerived($('swRecvAmt'), C.fmtAtoms(q.amountR, rm.precision));
  } else {
    writeDerived($('swPayAmt'), C.fmtAtoms(q.amountP, pm.precision));
  }
  paintRefHints();
  // Rate line: 1 PAY = X RECEIVE (derived from the two legs; direction-agnostic).
  const payU  = Number(q.amountP) / Math.pow(10, pm.precision || 0);
  const recvU = Number(q.amountR) / Math.pow(10, rm.precision || 0);
  if (payU > 0){
    const r = recvU / payU;
    $('swRate').textContent = `1 ${pm.ticker} = ${trim(r)} ${rm.ticker} · order book`;
  }
  paintFee(q.feeAsset, q.feeAmount);
  setFinality('same');
}

// Fetch + render the ONE (cross) order book for a BTC<->asset pair. Called on EVERY
// rail (ln / cross / mixed) so the book is never blank and looks identical — there is
// no on-chain/LN distinction in the book UI. Returns { offers, unreachable }.
// Cached unified-book fetch (rail-blind matching). ONE fetch per pair per ~12s; both the composer's
// rail auto-selection (requote) and the book render (loadBtcBook) read it. Returns the raw LSP
// payload ({ asks, bids, best_ask, best_bid, ... }) or null.
let _ubookCache = { key: null, ts: 0, book: null };
let _lastBookError = null;
async function getUnifiedBook(seqAsset, quoteAsset){
  if (!seqAsset || seqAsset === 'BTC') return null;
  // Key the cache by the PAIR, not the base asset: EURX/BTC and EURX/OILX are
  // different markets and must not share a cached book.
  const qk = (quoteAsset && quoteAsset !== 'BTC') ? quoteAsset : 'BTC';
  const key = seqAsset + '/' + qk;
  if (_ubookCache.key === key && (Date.now() - _ubookCache.ts) < 12000) return _ubookCache.book;
  let book = null;
  try {
    if (L && L.unifiedBook){
      const u = await L.unifiedBook(seqAsset, qk === 'BTC' ? undefined : qk);
      if (u && u.ok) book = u;
      else console.warn('[book] unified book returned no data:', u && u.error);
    } else {
      console.warn('[book] no unifiedBook capability wired');
    }
  } catch (e){
    // Recorded, not swallowed: this is the exact call whose silent failure looked
    // like an empty book while the relay-backed book rendered fine.
    console.warn('[book] unified book fetch failed:', e);
    _lastBookError = (e && e.message) || String(e);
  }
  _ubookCache = { key, ts: Date.now(), book };
  return book;
}
async function loadBtcBook(route){
  const seqAsset = route.seqAsset;
  let book = { forward: [], reverse: [], unreachable: false };
  if (X && X.book) book = await X.book(seqAsset).catch(() => ({ forward: [], reverse: [], unreachable: true }));
  const forward = book.forward || [], reverse = book.reverse || [];
  const offers = route.payIsBtc ? forward : reverse;   // the takeable side for this direction (quote + fill)
  XBOOK = { seqAsset, payIsBtc: route.payIsBtc, offers, forward, reverse };
  // Stage 2 (rail-agnostic display): fetch the UNIFIED book (on-chain + LN merged, rail-tagged) and
  // render THAT — the user sees ALL resting liquidity and a real price whichever rail carries it,
  // never "no maker for your rail". Falls back to the on-chain-only cross book if the LSP is
  // unreachable. The proven on-chain take path (XBOOK) is unchanged; an LN row seeds the amount and
  // the composer requotes on the user's rail (the LSP bridges / fails closed cleanly on take).
  const ub = await getUnifiedBook(seqAsset, ((route.assetAsset || route.mixedSame) && route.quoteAsset) ? route.quoteAsset : 'BTC');
  const unified = ub ? { asks: ub.asks || [], bids: ub.bids || [] } : null;
  UBOOK = unified ? { seqAsset, quote: (ub && ub.quote) || 'BTC', ...unified } : null;
  renderXBook(seqAsset, route.payIsBtc, forward, reverse, unified,
    ((route.assetAsset || route.mixedSame) && route.quoteAsset) ? route.quoteAsset : 'BTC');
  return { offers, unreachable: book.unreachable };
}
function numVal(el){ return parseFloat((((el && el.value) || '')).replace(/,/g, '')) || 0; }
// Best-effort self-correcting fill for the LN / mixed rails: derive the field the
// user did NOT edit from the best resting offer's price, so the composer is never
// half-empty. The authoritative amounts still come from the settle response (LN) or
// the daemon quote (cross); this is display only, and never stomps an active field.
// Format a UNIT amount to a string rounded to the asset's own precision (MED-4): a value
// written back into an amount field must never carry more decimals than the asset supports,
// or parseAtoms() throws on submit and the trade becomes un-postable. Mirrors fmtAtoms.
function fmtUnits(units, prec){ return C.fmtAtoms(BigInt(Math.round(units * Math.pow(10, prec))), prec); }
function deriveXOpposite(route){
  try {
    const o = (XBOOK.offers || [])[0]; if (!o) return;
    const am = C.assetMeta(route.seqAsset);
    const aprec = am.precision || 0;
    const { asset, btc } = xOfferAmts(o, route.payIsBtc);
    const assetU = Number(big(asset)) / Math.pow(10, aprec), btcU = Number(big(btc)) / 1e8;
    if (!(assetU > 0 && btcU > 0)) return;
    const btcPerAsset = btcU / assetU;
    const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
    const btcIsPay = (S.payAsset === 'BTC');
    if (S.edited === 'pay'){
      const v = numVal(pa); if (!(v > 0)) return;
      const other = btcIsPay ? (v / btcPerAsset) : (v * btcPerAsset);
      // derived leg is the RECEIVE side: the asset when BTC is paid, otherwise BTC (8dp).
      writeDerived(ra, fmtUnits(other, btcIsPay ? aprec : 8));
    } else {
      const v = numVal(ra); if (!(v > 0)) return;
      const other = btcIsPay ? (v * btcPerAsset) : (v / btcPerAsset);
      // derived leg is the PAY side: BTC when BTC is paid, otherwise the asset.
      writeDerived(pa, fmtUnits(other, btcIsPay ? 8 : aprec));
    }
    paintRefHints();
  } catch {}
}

// --- RAIL-BLIND take preview (BTC<->asset) --------------------------------------
// ONE order book per market, matched RAIL-BLIND on {asset,price,size,side}. The rail a user picks ONLY
// selects the (invisible) settlement path; it NEVER changes which liquidity exists or the fill. Every
// resting offer is partial-fillable down to its min_fill. This shared preview paints the SAME matched
// offer + fill for ANY rail combo, so the Lightning-pay branch shows exactly what the on-chain branch does.

// BTC (units) per 1 asset unit, from a whole offer's atoms — for the plain "1 GOLD = X BTC" price line.
function btcPerAssetUnits(assetAtoms, btcAtoms, aprec){
  const a = Number(assetAtoms) / Math.pow(10, aprec || 0), b = Number(btcAtoms) / 1e8;
  return a > 0 ? b / a : 0;
}
// The asset amount (in the asset's own atoms) the user wants, from whichever leg they edited — read the
// asset leg directly, else convert the typed BTC at the offer's price (mirrors requoteCross's editedIsSeq).
function wantAssetAtomsFor(route, offerAtoms, offerBtc){
  const seqAsset = route.seqAsset;
  const editedEl = S.edited === 'pay' ? C.$('swPayAmt') : C.$('swRecvAmt');
  const editedHex = S.edited === 'pay' ? S.payAsset : S.receiveAsset;
  if (editedHex === seqAsset) return fieldAtoms(editedEl, seqAsset);
  const qHex = (route.mixedSame && route.quoteAsset) ? route.quoteAsset : 'BTC';
  const btcAtoms = fieldAtoms(editedEl, qHex);
  return (btcAtoms > 0n && offerBtc > 0n) ? (btcAtoms * BigInt(offerAtoms)) / BigInt(offerBtc) : 0n;
}
// One-tap "Use minimum": accept the offer's minimum fill (a real placeable take) and re-quote so Place enables.
function useMinimumFill(route, sz){
  const buy = route.payIsBtc;
  const assetEl = buy ? C.$('swRecvAmt') : C.$('swPayAmt');
  const am = C.assetMeta(route.seqAsset) || {};
  // AUTHORITATIVE WRITE (task 19a). setNativeField has two guards that can silently eat this
  // explicit user action: it skips a still-focused field ("never fight the field being typed
  // in" — the click can land while the amount field still holds focus), and in ⇄ reference-
  // currency mode it round-trips the amount through the reference price, which can come back
  // BELOW the minimum and re-block Place with the same message the user just acted on. The
  // clicked minimum is stated in the asset's own units, so write exactly that, in native mode.
  try { if (typeof document !== 'undefined' && document.activeElement === assetEl && assetEl.blur) assetEl.blur(); } catch {}
  if (assetEl._refMode){ assetEl._refMode = false; try { paintRefHints(); } catch {} }
  assetEl.value = C.fmtAtoms(BigInt(sz.minAtoms || 0), am.precision || 0);
  assetEl._userTyped = true;
  S.edited = buy ? 'receive' : 'pay';
  requote().catch(()=>{});
}
// Paint the rail-blind take for a BTC<->asset market order + return the sizing decision. `plan` is
// { side, offerAtoms, offerBtc, minFill } sourced from the unified rail-blind book (or the shape's own
// settlement book). Guarantees pay & receive stay CONSISTENT (both reflect a real placeable take), shows
// the true minimum when the request is below it, and NEVER prints partial-impossible / whole-only vocab.
function renderMixedTake(route, plan){
  const { $ } = C;
  const am = C.assetMeta(route.seqAsset) || {};
  const tk = am.ticker || 'asset', aprec = am.precision || 0;
  // The QUOTE leg: BTC for the cross shapes; the pair's quote ASSET for the mixed
  // same-chain shape (it stands in BTC's structural place, ticker + precision too).
  const qHex = (route.mixedSame && route.quoteAsset) ? route.quoteAsset : 'BTC';
  const qm = qHex === 'BTC' ? { ticker: 'BTC', precision: 8 } : (C.assetMeta(qHex) || {});
  const qtk = qm.ticker || 'quote', qprec = (qm.precision == null ? 8 : qm.precision);
  const buy = plan.side === 'buy';
  const offerAtoms = BigInt(plan.offerAtoms || 0), offerBtc = BigInt(plan.offerBtc || 0);
  const want = wantAssetAtomsFor(route, offerAtoms, offerBtc);
  const sz = sizeSubswapTake({ want, offerAtoms, offerBtc, minFill: BigInt(plan.minFill || 0), side: plan.side });
  const assetStr = C.fmtAtoms(sz.takeAtoms, aprec), btcStr = C.fmtAtoms(sz.takeBtc, qprec);
  const minAssetStr = C.fmtAtoms(sz.minAtoms, aprec), minBtcStr = C.fmtAtoms(sz.minBtc, qprec);
  const priceU = btcPerAssetUnits(offerAtoms, offerBtc, aprec);
  const payEl = $('swPayAmt'), recvEl = $('swRecvAmt');
  const [payStr, recvStr] = buy ? [btcStr, assetStr] : [assetStr, btcStr];
  $('swRoute').textContent = '';   // the settlement path is invisible — no rail label
  // ROUTING HONESTY (owner ruling): when the ONLY candidates for this mixed take settle
  // through the maker-first bridge — a Bitcoin-confirmation wait, with no fast maker resting —
  // the quote line itself carries the slow class, so the user knows BEFORE typing an amount
  // (the review repeats it before Confirm). Never shown when a Sequentia-speed maker serves it.
  const slowNote = (plan.slowOnly ? ' · waits on Bitcoin confirmations — typically 10-60+ minutes on testnet4' : '')
    + (plan.betterOtherRails ? ' · a better price rests on rails this selection cannot settle (switch the Lightning leg to take it)' : '');
  // NO amount typed yet: show the plain price and wait for an amount.
  if (want <= 0n){
    $('swRate').textContent = priceU > 0 ? `1 ${tk} = ${trim(priceU)} ${qtk}${slowNote}` : `${tk} / ${qtk}${slowNote}`;
    return { ...sz, hasAmount: false };
  }
  // Paint BOTH legs to the sized take so pay & receive can NEVER disagree.
  // Pass each leg's ASSET so a field showing USD keeps showing USD (see setNativeField).
  const payHex = buy ? qHex : route.seqAsset, recvHex = buy ? route.seqAsset : qHex;
  setNativeField(payEl, payStr, payHex); setNativeField(recvEl, recvStr, recvHex);
  if (sz.belowMin){
    // Below this offer's minimum: show the true minimum plainly + a one-tap to use it, and BLOCK Place right
    // here (the caller also fails closed). Pay & receive were painted to the minimum above, so they agree.
    setReviewEnabled(false);
    const msg = `The smallest amount you can ${buy ? 'buy' : 'sell'} here is ${minAssetStr} ${tk} (${minBtcStr} ${qtk}).`;
    $('swRate').innerHTML = esc(msg) + ` <a href="#" class="swusemin" style="text-decoration:underline;cursor:pointer">Use minimum</a>`;
    // DELEGATED click (task 19a): the handler lives on the PERSISTENT #swRate element, not on
    // the anchor — every repaint (requote per keystroke, background book refresh) destroys and
    // recreates the anchor, so a per-anchor onclick could be gone by the time the click lands.
    // Each belowMin paint only swaps the stored action; the wiring survives all repaints.
    const rateEl = $('swRate');
    rateEl._useMin = () => useMinimumFill(route, sz);
    if (!rateEl._useMinWired){
      rateEl._useMinWired = true;
      rateEl.onclick = (e) => {
        const hit = e && e.target && e.target.closest && e.target.closest('.swusemin');
        if (!hit) return;
        if (e.preventDefault) e.preventDefault();
        if (rateEl._useMin) rateEl._useMin();
      };
    }
    return { ...sz, hasAmount: true };
  }
  // IOC truth: a market take reads only this single best-price offer, so a request larger than it fills THIS
  // offer and the remainder does NOT walk to further offers right now (multi-offer walk is a separate follow-up).
  // THE AGGREGATE WALK, when the plan carries one. Showing a single offer's size for a
  // request that spans several is what made a large order look silently truncated: the
  // number in the field was real, it just was not the whole fill. State what actually
  // executes — the total, the price across all of it, and any genuine remainder.
  const w = plan.walk;
  if (w && w.offersUsed > 1 && w.filledAtoms > 0n){
    const wAsset = C.fmtAtoms(w.filledAtoms, aprec), wBtc = C.fmtAtoms(w.filledBtc, qprec);
    const [wPay, wRecv] = buy ? [wBtc, wAsset] : [wAsset, wBtc];
    setNativeField(payEl, wPay, payHex); setNativeField(recvEl, wRecv, recvHex);
    const across = ` · across ${w.offersUsed} offers`;
    // The remainder is what the book cannot fill at any price right now, which is a
    // different statement from "we capped you at one offer" and must not read the same.
    const restNote = w.remainderAtoms > 0n
      ? ` · ${C.fmtAtoms(w.remainderAtoms, aprec)} ${tk} of your order cannot fill right now`
      : '';
    $('swRate').textContent = buy
      ? `${wBtc} ${qtk} → ${wAsset} ${tk}${across}${restNote}${slowNote}`
      : `${wAsset} ${tk} → ${wBtc} ${qtk}${across}${restNote}${slowNote}`;
    return { ...sz, takeAtoms: w.filledAtoms, takeBtc: w.filledBtc,
             walk: w, hasAmount: true, capped: false, partial: w.partial };
  }
  // Say plainly that the amount was LIMITED, and by how much. The old note explained
  // the mechanism ("fills the best resting offer") without naming the number, so a
  // request cut down by orders of magnitude read as the app quietly overwriting the
  // field — which is exactly how it was reported.
  const capNote = sz.capped
    ? ` · limited to ${buy ? btcStr + ' ' + qtk : assetStr + ' ' + tk} — that is all this offer has right now`
    : '';
  $('swRate').textContent = buy
    ? `${btcStr} ${qtk} → ${assetStr} ${tk}${capNote}${slowNote}`
    : `${assetStr} ${tk} → ${btcStr} ${qtk}${capNote}${slowNote}`;
  return { ...sz, hasAmount: true };
}

// --- MIXED rails (one leg LN, one on-chain), RAIL-BLIND -------------------------
// Priced from the ONE unified rail-blind book (bridgedTakePlan) for the submarine shapes, and from the
// shape's own settlement book for the sub-asset shapes — but the DISPLAY (matched offer + fill, partial /
// minimum handling, plain wording) is identical, so the composer looks the same on every rail. The rail
// combo only picks the (invisible) settlement path (native / P2P submarine / LSP payer or receiver bridge).
async function requoteMixed(route, amtStr){
  const { $ } = C;
  $('swStatus').textContent = ''; $('swErr').textContent = '';
  // Mixed SAME-CHAIN pairs render the pair's ONE ladder via the same loader as chain/chain
  // (union of the same-chain relay book + live stream + unified families; sets UBOOK for the
  // plan below) — the BTC-paired shapes keep the cross ladder (loadBtcBook/renderXBook).
  if (route.mixedSame) await loadSameBook(S.payAsset, S.receiveAsset);
  else await loadBtcBook(route);   // loads the on-chain cross book AND the unified rail-blind book (UBOOK)

  // LIMIT: a resting order at YOUR price stays live while your wallet is closed only on-chain. Point there;
  // the "keep resting while offline" opt-in (with its custody-risk disclosure) surfaces only for a BTC-pay
  // on-chain limit, via the offline toggle — never here.
  if (S.mode === 'post'){
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swRoute').textContent = '';
    $('swRate').textContent = `To keep an order resting at your price while your wallet is closed, set both sides on-chain.`;
    paintFee('BTC', null, null);
    renderTiming(route);
    return;
  }

  const buy = !!route.payIsBtc;
  const side = buy ? 'buy' : 'sell';
  const feeNote = 'You trade at the price shown · your funds stay in your control until it completes.';
  // The BTC leg's rail decides the settlement FAMILY (invisible to the user):
  //   • BTC over Lightning  -> submarine / LSP-bridge family: read the ONE rail-blind unified book
  //     (bridgedTakePlan), so the fill is IDENTICAL to the on-chain branch.
  //   • BTC on-chain (asset over LN) -> sub-asset family: lift a resting sub-asset offer (its own book).
  const btcLeg = buy ? route.payRail : route.recvRail;
  const isSubmarine = (btcLeg === 'ln');
  const qHex = (route.mixedSame && route.quoteAsset) ? route.quoteAsset : 'BTC';
  const qtk = qHex === 'BTC' ? 'BTC' : ((C.assetMeta(qHex) || {}).ticker || 'the quote asset');

  if (isSubmarine && route.mixedSame){
    // Mixed same-chain with the QUOTE leg over Lightning (the submarine mirror with an
    // issued asset in BTC's place) is not settled by this build yet. Name it and the
    // remedy — the OTHER mixed orientation of the same pair is fully wired.
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swRoute').textContent = '';
    const btk = (metaOf(route.seqAsset) || {}).ticker || 'the base asset';
    $('swRate').textContent = `Paying or receiving ${qtk} over Lightning on this pair is not settled by this build yet · put ${qtk} on-chain (and ${btk} over Lightning) to trade now.`;
    paintFee(qHex, null, null);
    renderTiming(route);
    return;
  }

  if (isSubmarine){
    // RAIL-BLIND: match the ONE unified book on {asset,price,size,side}; the rail only selects the invisible
    // settlement path. Show the SAME matched offer + fill the on-chain branch shows.
    const bp = bridgedTakePlan(route);
    if (!bp || !bp.offer){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swRoute').textContent = '';
      $('swRate').textContent = 'No offers resting here yet.';
      // A DERIVED amount from an earlier (different-route) quote must not sit in the
      // untouched field looking like a live quote for THIS route - clear it (never a
      // user-typed value; clearDerived refuses those by contract).
      clearDerived(S.edited === 'pay' ? $('swRecvAmt') : $('swPayAmt'));
      paintFee('BTC', null, null);
      renderTiming(route);
      return;
    }
    const raw = bp.offer.raw || {};
    const dec = renderMixedTake(route, { side, offerAtoms: bp.offer.assetAtoms, offerBtc: bp.offer.btcSats,
      minFill: offerMinFill(bp.offer, raw),
      // ONLY-slow-candidates note (owner ruling): when nothing at Sequentia speed can fill this
      // take, the quote line states the Bitcoin-confirmation class BEFORE an amount is typed.
      slowOnly: bp.speedClass === 'slow' && !bp.fastAvailable,
      betterOtherRails: !!bp.betterOtherRails });
    // GENUINE fail-closed (the invisible settlement can't carry this crossing in THIS build). Not a rail /
    // liquidity message — the SAME shared predicate onReview uses (bridgedTakeSupported), so Review is never
    // offered then refused. A happy coincidence (native) or a supported crossing passes.
    //
    // This is a PERMANENT property of the crossing, not a passing condition: the matched offer rests its
    // ASSET over Lightning, so the asset leg crosses rails too and there is no single on-chain asset HTLC to
    // bind. "try again shortly" invited the user to wait for something that will never change. It is also
    // refused BEFORE the fee + timing copy is painted: rendering "Instant. Your on-chain payment is fronted;
    // you receive final GOLD now" and then refusing on the next line states two contradictory things at once.
    if (bp.crosses && !bp.supported){
      LAST_QUOTE = null; setReviewEnabled(false);
      clearTiming(); paintFee('BTC', null, null);
      const tk2 = (metaOf(route.seqAsset) || {}).ticker || 'that asset';
      $('swErr').textContent = buy
        ? `The best ${tk2} offer delivers over Lightning, and this wallet cannot turn that into an on-chain receipt. Switch Receive to Lightning to take it · trying again later will not change this.`
        : `The best ${tk2} offer settles over Lightning, and this wallet cannot pay it from your on-chain balance. Switch Pay to Lightning to take it · trying again later will not change this.`;
      return;
    }
    paintFee('BTC', null, feeNote);
    renderTiming(route);
    // PAYER LEG-BRIDGE capability gate (spec §4 — kill offer-then-refuse): a BUY that crosses to an
    // on-chain-only maker settles via the LSP payer bridge, which needs the bare-hash hold (L.bridgeHold) +
    // hold pay (L.nodePayHash). Gate Place on the SAME condition reviewLspPayerBridge enforces, so Review
    // never enables a Place that reviewLspPayerBridge then refuses. A peer-to-peer submarine maker
    // (bp.submarine) settles without those, so it is not gated here.
    if (buy && bp.crosses && bp.supported && !bp.submarine && !(L && L.swap && L.bridgeHold && L.nodePayHash)){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swErr').textContent = payerBridgeDisabledNote();
      return;
    }
    // Paying BTC over your OWN Lightning needs spendable BTC in Lightning (a genuine capability gate — the
    // settlement bridge does not open your outbound channel). The fill stays shown; only Place is gated.
    if (buy && route.payRail === 'ln' && !railAvail('BTC', route.seqAsset).payLn.ok){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swErr').textContent = 'You will need Bitcoin in Lightning to pay this way · move it to Lightning first (Balance tab), then take this offer.';
      return;
    }
    if (dec.belowMin || !dec.hasAmount){ LAST_QUOTE = null; setReviewEnabled(false); return; }   // block Place until met / an amount is entered
    LAST_QUOTE = { kind: 'mixed', route, seqAsset: route.seqAsset, payIsBtc: buy,
      payRail: route.payRail, recvRail: route.recvRail };
    setReviewEnabled(true);
    return;
  }

  // SUB-ASSET (asset over LN, BTC on-chain): the SAME rail-blind DISPLAY as the submarine branch — match +
  // fill from the ONE unified book (bridgedTakePlan/UBOOK), so chain/chain and chain/ln render an IDENTICAL
  // matched offer + fill for the same market + size. Only the invisible settlement path (a resting sub-asset
  // offer) differs, and it gates ONLY Place. Fall back to the sub-asset book only when the unified book has
  // no offer for the pair.
  const bp = bridgedTakePlan(route);
  // The SETTLEMENT handle MUST be the SAME offer whose fill is DISPLAYED — never a different sub-asset offer at a
  // different price (that showed one price and delivered another: "50 GOLD for 500000 sats" but received 25).
  // subassetOffers merges the same relay reads the unified book does, so when the unified best (bp.offer) is a
  // sub-asset / LN-leg offer it is present here BY ID; when the best is an on-chain / submarine maker the
  // sub-asset (asset-over-LN) path cannot deliver, there is NO matching sub-asset offer to lift.
  let offerAtoms, offerBtc, minFill, matchedSub = null;
  if (bp && bp.offer){
    const raw = bp.offer.raw || {};
    offerAtoms = bp.offer.assetAtoms; offerBtc = bp.offer.btcSats;
    minFill = offerMinFill(bp.offer, raw);
    const oid = String(bp.offer.id || '');
    matchedSub = oid ? (subassetOffers(route.seqAsset, side, qHex).find(o => String(o.offer_id || o.offerId || '') === oid) || null) : null;
    // ONE SNAPSHOT (the stale-cap fund mismatch): the unified book (~12s cache) and the
    // sub-asset book (~15s cache) refresh independently, so the SAME offer id can carry
    // two different prices at once. The display used the unified copy while startBuy
    // funded from the sub-asset copy — a fresh 6507-sat quote funded 6536 stale sats and
    // the maker's exact-amount check refused AFTER the on-chain lock (stranded to CLTV).
    // The settlement handle is matchedSub, so matchedSub's OWN price fields must feed the
    // display too — quote and fund are then byte-for-byte the same snapshot, and the live
    // pre-fund re-read in startBuy decides whether that snapshot is still current.
    if (matchedSub){
      offerAtoms = matchedSub.asset_amount; offerBtc = matchedSub.btc_sats;
      minFill = BigInt(matchedSub.min_fill || matchedSub.minFill || 0);
    }
    // "NO SUB-ASSET COUNTERPART" IS NOT "NO LIQUIDITY ON THIS RAIL".
    //
    // The rail-blind best is whatever is cheapest across all four rails, and this path can
    // only lift a SUB-ASSET offer (asset delivered over Lightning). When the best happens to
    // be an on-chain or submarine maker there is no matching sub-asset offer by id, and this
    // used to disable Place with the generic "could not be placed right now" — refusing a
    // trade the sub-asset book could genuinely fill, one level down, with no reason given.
    //
    // Same shape, and same remedy, as the forward-cross branch: prefer the rail-blind best,
    // and when it cannot be settled HERE re-quote against the best offer that can, DISPLAYING
    // that one — so the displayed offer stays the offer lifted. No sub-asset offer at all
    // still falls through to the honest refusal below.
    if (!matchedSub){
      const sub = subassetOffers(route.seqAsset, side, qHex)[0] || null;
      if (sub){
        matchedSub = sub;
        offerAtoms = sub.asset_amount; offerBtc = sub.btc_sats;
        minFill = BigInt(sub.min_fill || sub.minFill || 0);
      }
    }
  } else {
    // Unified feed has NO offer for this pair -> fall back to the sub-asset book for BOTH the display AND the
    // settlement (consistent: the displayed offer IS the one lifted).
    const subOffer = subassetOffers(route.seqAsset, side, qHex)[0] || null;
    if (!subOffer){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swRoute').textContent = '';
      $('swRate').textContent = 'No offers resting here yet.';
      clearDerived(S.edited === 'pay' ? $('swRecvAmt') : $('swPayAmt'));   // same stale-derivation guard as above
      paintFee(qHex, null, null);
      renderTiming(route);
      return;
    }
    matchedSub = subOffer;
    offerAtoms = subOffer.asset_amount; offerBtc = subOffer.btc_sats;
    minFill = BigInt(subOffer.min_fill || subOffer.minFill || 0);
  }
  const dec = renderMixedTake(route, { side, offerAtoms, offerBtc, minFill });
  paintFee(qHex, null, feeNote);
  renderTiming(route);
  if (dec.belowMin || !dec.hasAmount){ LAST_QUOTE = null; setReviewEnabled(false); return; }
  // GATE ONLY PLACE on sub-asset SETTLEABILITY (mirrors requoteCross's show-fill-then-gate-Place): the
  // (invisible) sub-asset settlement lifts a resting sub-asset offer for the pair, and it MUST be the SAME offer
  // the DISPLAY priced (matchedSub, by id). When the unified best is an on-chain / submarine maker the sub-asset
  // path cannot deliver over LN, there is no matching sub-asset offer to lift — show the SAME fill but DISABLE
  // Place with the shared plain note (never lift a DIFFERENT offer than shown, never give rail advice).
  if (!matchedSub){
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swErr').textContent = payerBridgeDisabledNote();
    return;
  }
  // A MATCH IS NOT A CAPABILITY. The re-quote above can now FIND a sub-asset offer when the
  // rail-blind best is not one — but this build settles that shape through startBuy, which
  // needs wasm HTLC helpers and an LSP invoice/settle client it does not ship. Enabling
  // Place here produced a priced, confirmable trade that then died with "this trade isn't
  // available in this build": an offer-then-refuse, and worse than the refusal it replaced.
  // Gate on the executor's OWN predicate and say what is actually missing.
  const supported = route.mixedSame ? subAssetMixedSupported() : subAssetBuySupported();
  if (!supported){
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swErr').textContent = route.mixedSame
      ? `Trading ${(C.assetMeta(route.seqAsset) || {}).ticker || 'this pair'} with one leg over Lightning is not settled by this build yet · set both legs the same way to trade now.`
      : subAssetBuyUnsupportedNote((C.assetMeta(route.seqAsset) || {}).ticker);
    return;
  }
  LAST_QUOTE = { kind: 'mixed', route, seqAsset: route.seqAsset, payIsBtc: buy,
    payRail: route.payRail, recvRail: route.recvRail,
    // Carry the SIZED take from the DISPLAYED unified book as the AUTHORITATIVE fill, so startBuy/startSell lift
    // EXACTLY what was shown (never re-derive off a different offer's ratio) — Review == execution for a partial.
    takeBtcSats: String(dec.takeBtc), takeAssetAtoms: String(dec.takeAtoms),
    // The settlement handle is the sub-asset offer that IS the displayed unified offer (matched by id).
    [buy ? 'buyOffer' : 'sellOffer']: matchedSub };
  setReviewEnabled(true);
}

// --- cross-chain quote (GetXchainQuote) ---
// POST mode (cross-chain BTC<->asset): the fields are the user's OWN price. Review posts a
// resting cross offer via the maker path (postCrossOfferReview -> X.makerStart/makerStartReverse).
// reverse = pay BTC (post a BID: buy the asset with BTC); forward = pay the asset (post an ASK:
// sell the asset for BTC) — mirroring the "be the first" branch in requoteCross.
function postModeCross(route){
  const { $ } = C;
  const am = C.assetMeta(route.seqAsset);
  const reverse = !!route.payIsBtc;
  const start = reverse ? (X && X.makerStartReverse) : (X && X.makerStart);
  if (!start){
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swRate').textContent = `Posting a ${am.ticker}/BTC offer isn’t available in this build.`;
    $('swRoute').textContent = '';
    setFinality('cross');
    return;
  }
  LAST_QUOTE = { kind:'cross-make', reverse, assetHex: route.seqAsset };
  const both = fieldUnits($('swPayAmt'), S.payAsset) > 0 && fieldUnits($('swRecvAmt'), S.receiveAsset) > 0;
  $('swRate').textContent = both
    ? `Your price · ${reverse ? `buy ${am.ticker} with Bitcoin` : `sell ${am.ticker} for Bitcoin`} · Post to rest this offer.`
    : `Set both amounts (the ${am.ticker} and the Bitcoin) · their ratio is your price · then Post.`;
  $('swRoute').textContent = reverse ? `Post an offer to buy ${am.ticker} with Bitcoin` : `Post an offer to sell ${am.ticker} for Bitcoin`;
  setFinality('cross');
  setReviewEnabled(both);
}

let _reqCrossGen = 0;   // supersession guard: a newer requoteCross invalidates an older one's in-flight book fetch
async function requoteCross(route, amtStr){
  const { $ } = C;
  const myGen = ++_reqCrossGen;
  // What this function actually needs is the cross BOOK. (It used to probe X.quote,
  // which no longer exists as a separate capability now the RFQ rail is gone.)
  if (!X || !X.book){ $('swErr').textContent = 'This trade isn’t available right now - try again shortly.'; setReviewEnabled(false); return; }
  const seqAsset = route.seqAsset;
  const am = C.assetMeta(seqAsset);
  const seqPrec = am.precision || 0;
  const dirLabel = route.payIsBtc ? `Buy ${am.ticker} with Bitcoin` : `Sell ${am.ticker} for Bitcoin`;
  const status = $('swStatus'); status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the order book…';
  $('swErr').textContent = '';
  try {
    // Fetch + render the ONE (cross) order book for this pair, then pick the side
    // that matches the taker's direction: buy asset with BTC = forward offers; sell
    // asset for BTC = reverse offers. "No offers" is not an error — it renders an
    // empty book (cross markets need a maker with BTC reserves, so unlike a
    // same-chain pair the wallet can't self-start one yet).
    const { offers, unreachable } = await loadBtcBook(route);
    // Supersession (as requoteSame does): if a newer quote started while our book fetch was in
    // flight, bail. Rendering now would paint an OLDER quote's error + disabled Place over the
    // newer one's enabled Place, which reads exactly like a stale error latching the button.
    if (myGen !== _reqCrossGen) return;

    // ONE BOOK, rail-blind: the on-chain-pay (chain/chain) buy + its mirror sell match the SAME unified book
    // and show the SAME renderMixedTake preview the Lightning-pay (submarine) combo uses — identical matched
    // offer, takeAtoms/takeBtc, price and partial/min_fill handling. The rail combo ONLY selects the invisible
    // settlement dispatch (chain/chain -> the on-chain courier, below in reviewCross). bridgedTakePlan is
    // rail-blind, so the fill never differs per rail.
    let bp = bridgedTakePlan(route);
    // "NO SETTLEABLE MATCH ON THIS RAIL" IS NOT "NO LIQUIDITY". This composer settles through the
    // on-chain courier (reviewCross -> xswap/xrswap), which speaks the cross relay's HTLC handshake
    // and can lift ONE kind of offer: a plain on-chain cross offer (rail 'onchain'). Two live
    // failures came from matching rail-blind and then ignoring that:
    //   • a SUB-ASSET best ask (asset leg over Lightning, rail 'ln') made bp.crosses true, so the
    //     composer refused the whole trade ("could not be placed right now") while on-chain offers
    //     rested one level down — a priced order the user could not place, and no reason why;
    //   • a SUBMARINE best ask looked like a HAPPY COINCIDENCE — makerRailsFromOffer reports a
    //     submarine maker's legs as on-chain BY DESIGN, which is what routes the LN-taker shapes —
    //     so Place was ENABLED and the courier then lifted an offer the cross relay does not hold
    //     ("relay: offer not found or not open"): exactly the offer-then-refuse this file forbids.
    // So prefer the rail-blind best, and when it is not liftable HERE re-plan against the best
    // offer that is, DISPLAYING that one — the displayed offer stays the one lifted. Nothing
    // liftable at all still fails closed at the gate below.
    //
    // Honest about what this is: rail-aware offer selection, which rail-blind matching says the
    // bridge should make unnecessary. It is a stopgap that prefers a settleable offer over a
    // refusal, not the end state. The end state is a bridge that settles the crossing, at which
    // point the best-priced offer is takeable here and this fallback stops firing.
    const courierLiftable = (o) => !!o && o.rail === 'onchain';
    if (bp && bp.offer && !courierLiftable(bp.offer)){
      const nat = bridgedTakePlan(route, null, null, courierLiftable);
      if (nat && nat.offer) bp = nat;
    }
    const haveUnified = !!(bp && bp.offer);

    // T7: relay unreachable AND nothing to show on EITHER book — offer a retry, never invite first-maker.
    if (_railsUnset && (offers.length || haveUnified || !unreachable)){
      // Same as below: missing a rail choice must never read as a broken connection.
      status.textContent = ''; LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Choose how you pay & receive to see the price.';
      $('swRoute').textContent = dirLabel;
      $('swErr').textContent = '';
      return;
    }
    if (unreachable && !offers.length && !haveUnified){
      status.textContent = ''; clearOpposite(); LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Could not load the order book · retry.';
      $('swRoute').textContent = '';
      $('swErr').textContent = 'Could not reach the order book right now. Check your connection and try again (re-enter the amount to retry).';
      return;
    }

    // Take vs Post (Post defaults for an empty book). In Post mode the fields are the user's own price;
    // Review posts a resting cross offer via the maker (postCrossOfferReview).
    applyAutoMode((offers.length || (haveUnified ? 1 : 0)), route);
    if (S.mode === 'post'){ status.textContent = ''; return postModeCross(route); }

    // === UNIFIED MATCH + PREVIEW (the ONE rail-blind book) ===================================
    // SPEC §1/§2 — ONE book, matched RAIL-BLIND: the on-chain-pay preview renders the SAME matched offer + fill
    // the Lightning-pay (submarine) combo shows. The DISPLAY never depends on the invisible settlement path;
    // only Place is gated on whether THIS on-chain courier can settle the matched offer. The matched offer
    // carries offer_id/maker_pubkey/amounts from the same cross relay, so the courier can lift exactly it
    // (settlement is UNCHANGED — see reviewCross). This mirrors requoteMixed's show-fill-then-block-Place.
    if (haveUnified){
      status.textContent = '';
      const raw = bp.offer.raw || {};
      const side = route.payIsBtc ? 'buy' : 'sell';
      // ALWAYS render the SAME matched offer + fill (the identical rail-blind preview both rails show). The
      // display is never gated on the settlement path — the gates below (capability + affordability) touch ONLY Place.
      const dec = renderMixedTake(route, { side, offerAtoms: bp.offer.assetAtoms, offerBtc: bp.offer.btcSats,
        minFill: offerMinFill(bp.offer, raw) });
      // IDENTICAL fee row + finality reassurance to the submarine combo, so the two look the same.
      paintFee('BTC', null, 'You trade at the price shown · your funds stay in your control until it completes.');
      renderTiming(route);
      if (!dec.hasAmount){ LAST_QUOTE = null; setReviewEnabled(false); return; }   // book + price shown; wait for an amount
      if (dec.belowMin){ LAST_QUOTE = null; setReviewEnabled(false); return; }      // renderMixedTake showed the minimum + blocked Place
      // GATE ONLY PLACE (spec §4 — never offer-then-refuse; never match a DIFFERENT offer per rail). The
      // on-chain courier lifts ONLY a happy-coincidence match: an on-chain maker whose asset leg is on-chain
      // (!bp.crosses). When the best offer rests its asset over Lightning (bp.crosses), THIS courier cannot lift
      // it — show the SAME fill but DISABLE Place with the shared plain note. NEVER silently fall through to a
      // different XBOOK offer, NEVER give rail advice; the user sees the true best match, told plainly it can't
      // be placed right now (mirrors requoteMixed's submarine-crosses block).
      // !courierLiftable is the check bp.crosses was standing in for, and it is the one that is
      // actually true: a submarine / pure-LN maker is NOT a happy coincidence for an on-chain taker
      // (its BTC leg is Lightning; only makerRailsFromOffer's deliberate 'chain' made it look like
      // one), so bp.crosses alone let that shape reach an enabled Place it could never execute.
      if (bp.crosses || !courierLiftable(bp.offer)){
        LAST_QUOTE = null; setReviewEnabled(false);
        $('swErr').textContent = payerBridgeDisabledNote();
        return;
      }
      const takeAtoms = BigInt(dec.takeAtoms || 0), takeBtc = BigInt(dec.takeBtc || 0);
      // AFFORDABILITY (mirrors the fallback below): gate Review on the amount actually committed (the sized
      // take), with a little BTC headroom for the on-chain funding fee when paying BTC.
      const _payAtoms = route.payIsBtc ? takeBtc : takeAtoms;
      const _payBal   = balAtoms(route.payIsBtc ? 'BTC' : seqAsset);
      const _payNeed  = route.payIsBtc ? (_payAtoms + 1000n) : _payAtoms;
      if (_payNeed > _payBal){
        $('swErr').textContent = `You only hold ${C.fmtAtoms(_payBal, route.payIsBtc ? 8 : seqPrec)} ${route.payIsBtc ? 'BTC' : am.ticker}${route.payIsBtc ? ' (an on-chain fee is also needed)' : ''} · reduce the amount.`;
        LAST_QUOTE = null; setReviewEnabled(false);
        return;
      }
      // Build the courier settlement quote from the SAME matched offer + sized take. reviewCross hands this
      // straight to X.openFromComposer / X.openReverseFromComposer UNCHANGED — the courier lifts THIS offer.
      const offerObj = { ...raw, offer_id: bp.offer.id || raw.offer_id || raw.offerId,
        maker_pubkey: bp.offer.maker || raw.maker_pubkey || raw.makerPubkey };
      const market = (typeof XMARKETS !== 'undefined' && XMARKETS.find(m => m.seq_asset === seqAsset)) ||
        { btc_asset: '', seq_asset: seqAsset, name: 'BTC / ' + am.ticker, price_seq_per_btc: 0 };
      const xq = { reverse: !route.payIsBtc, market, offer: offerObj, courier: true, quote_id: 'courier',
        seq_amount: takeAtoms, btc_amount: takeBtc, fee_btc: 0n,
        price_seq_per_btc: takeBtc > 0n ? Number(takeAtoms) / Number(takeBtc) : 0,
        candidates: [], maker_btc_claim_pub: '', maker_seq_refund_pub: '', btc_locktime: 0, seq_locktime: 0,
        expires_at_unix: Number(raw.expires_at_unix || raw.expiresAtUnix || 0) };
      LAST_QUOTE = { kind: 'cross', unified: true, reverse: !route.payIsBtc, route, seqAsset, xq,
        offer: bp.offer, takeAtoms: String(takeAtoms), takeBtc: String(takeBtc), partial: dec.partial,
        // A market take on the unified book is IOC-capped to the matched offer (renderMixedTake states the
        // capped remainder honestly) — there is no separate resting remainder here.
        remainderSeqAtoms: 0n, fillSeqAtoms: String(takeAtoms) };
      setReviewEnabled(true);
      return;
    }

    // === NO UNIFIED MATCH ===================================================
    // There used to be a FALLBACK here: re-quote against the on-chain cross book
    // via X.quote. It is gone, and deliberately.
    //
    // Two reasons. First, it could route a trade onto a rail that cannot complete:
    // X.quote's non-courier branch spoke to the retired RFQ daemon, which still
    // binds :9945 but has no route to it. Second, it carried the whole-offer
    // OVERSHOOT branch (wholeOffer / "more than you entered"), which contradicts
    // the rule that every resting offer is partially fillable — a user asking for
    // 1 GOLD could be shown, and then charged for, the maker's whole 50.
    //
    // So: a genuinely unreachable book says so plainly and disables Place. What
    // remains below is the honest EMPTY case — no offers on either feed — where
    // posting your own price is a real capability, not a dead end.
    if (!offers.length){
      status.textContent = ''; clearOpposite(); setFinality('cross');
      if (!route.payIsBtc && X && X.makerStart){
        // SELL asset for BTC with no resting bid: self-start via the FORWARD maker
        // (the wallet holds the asset, locks it, claims the taker's BTC).
        LAST_QUOTE = { kind: 'cross-make', reverse: false, assetHex: seqAsset };
        $('swRate').textContent = `No offers resting here yet · set a price and Review to post your own.`;
        $('swRoute').textContent = dirLabel;
        setReviewEnabled(true);
      } else if (route.payIsBtc && X && X.makerStartReverse){
        // BUY asset with BTC with no resting ask: self-start (the wallet funds a BTC bid, holds the
        // secret, claims the counterparty's asset). Posting your own price is a real capability, not a dead end.
        LAST_QUOTE = { kind: 'cross-make', reverse: true, assetHex: seqAsset };
        $('swRate').textContent = `No offers resting here yet · set a price and Review to post your own.`;
        $('swRoute').textContent = dirLabel;
        setReviewEnabled(true);
      } else {
        LAST_QUOTE = null; setReviewEnabled(false);
        $('swRate').textContent = `No offers resting here yet.`;
        $('swRoute').textContent = dirLabel;
      }
      return;
    }

    // Offers rest on the on-chain cross book but the UNIFIED feed gave us no match:
    // the one book we match against is unreachable. Say so and stop. We do NOT
    // re-match against the raw cross book here — that was the old fallback, and it
    // both routed to a retired rail and overshot the user's amount to the maker's
    // whole offer. A trade we cannot price honestly is a trade we do not offer.
    status.textContent = ''; clearOpposite(); LAST_QUOTE = null; setReviewEnabled(false);
    $('swRate').textContent = 'Could not load the order book · retry.';
    $('swRoute').textContent = dirLabel;
    // ⚠ RAILS NOT CHOSEN IS NOT AN ERROR. This branch used to report it as
    // "could not reach the order book · check your connection", which is simply
    // false: the book had loaded (it is on screen, with offers), the feed was fine,
    // and the only thing missing was the user's own choice of how to pay and
    // receive. The composer already knows this — its own button reads "Choose how
    // you pay & receive" at the same moment — so telling the user their connection
    // is broken sends them to debug a network that was never at fault.
    if (_railsUnset){
      status.textContent = ''; LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Choose how you pay & receive to see the price.';
      $('swRoute').textContent = dirLabel;
      $('swErr').textContent = '';
      setFinality('cross');
      return;
    }
    // A genuine failure: name the failing side. "Could not reach the order book" was
    // true but useless when the visible book had loaded fine and it was the matching
    // feed that failed.
    const why = _lastBookError ? ' (' + _lastBookError + ')' : (_lastPlanError ? ' (' + _lastPlanError + ')' : '');
    $('swErr').textContent = 'Offers are resting, but the matching feed could not be reached' + why +
      '. Check your connection and try again (re-enter the amount to retry).';
    setFinality('cross');
    return;
  } catch (e){
    status.textContent = '';
    // Route the message through prettyErr as a plain literal; don't double-prefix a message that already
    // reads as a full sentence (so 'Could not load the order book right now.' renders once, cleanly).
    const msg = C.prettyErr(e);
    $('swErr').textContent = /^could not load/i.test(msg) ? msg : ('Could not load the order book: ' + msg);
    setReviewEnabled(false);
  }
}

// Asset/BTC atom amounts of a cross offer, per taker direction. Forward (dir 0):
// base_amount = the asset, want_amount = BTC. Reverse (dir 1): offer_amount = BTC,
// want_amount (or base_amount) = the asset.
function xOfferAmts(o, payIsBtc){
  const ba = big(o.base_amount||o.baseAmount), wa = big(o.want_amount||o.wantAmount), of = big(o.offer_amount||o.offerAmount);
  return payIsBtc ? { asset: ba, btc: wa } : { asset: (wa || ba), btc: of };
}

// Cross-chain order book (resting cross offers for one BTC<->asset pair + direction),
// rendered as the SAME ladder as the same-chain book — no rail distinction, orders
// look identical. Buying asset with BTC => the offers are ASKS you can take; selling
// asset for BTC => they are BIDS you can take. Prices are BTC per asset unit.
function renderXBook(seqAsset, payIsBtc, forward, reverse, unified, quoteHex){
  const host = C.$('swBook'); if (!host) return;
  const am = C.assetMeta(seqAsset);
  // The QUOTE leg's identity: BTC for the cross pairs; a real asset for the mixed
  // same-chain pairs (ticker + ladder keys follow it — never a hard-coded 'BTC').
  const qHex = (quoteHex && String(quoteHex).toUpperCase() !== 'BTC') ? quoteHex : 'BTC';
  const qTk = qHex === 'BTC' ? 'BTC' : ((C.assetMeta(qHex) || {}).ticker || 'quote');
  forward = forward || []; reverse = reverse || [];
  let asks, bids, n;
  const useUnified = !!(unified && ((unified.asks && unified.asks.length) || (unified.bids && unified.bids.length)));
  if (useUnified){
    // MERGED book (Stage 2): on-chain + LN offers, each row tagged with its rail, priced BTC/asset in
    // whole units and sorted like the on-chain book. Clicking a level seeds the asset size
    // (rail-agnostic); the composer requotes on the user's chosen rail (the LSP bridges on take).
    const uRow = (o) => {
      const atoms = big(o.assetAtoms);
      const assetU = Number(atoms) / Math.pow(10, am.precision || 0);
      const btcU = Number(big(o.btcSats)) / 1e8;
      return { price: assetU > 0 ? btcU / assetU : 0, size: assetU, sizeAtoms: atoms, rail: o.rail };
    };
    asks = (unified.asks || []).map(uRow).filter(r => r.price > 0 && r.size > 0);
    bids = (unified.bids || []).map(uRow).filter(r => r.price > 0 && r.size > 0);
    n = (unified.asks || []).length + (unified.bids || []).length;
  } else {
    // On-chain-only fallback (LSP unreachable). asks = forward offers (someone SELLS the asset for
    // BTC), bids = reverse offers (someone BUYS the asset with BTC). Priced BTC/asset by each offer's
    // OWN direction, not the user's side.
    const toRow = (o, dirIsBtc) => {
      const { asset, btc } = xOfferAmts(o, dirIsBtc);
      const assetU = Number(big(asset)) / Math.pow(10, am.precision || 0), btcU = Number(big(btc)) / 1e8;
      return { price: assetU > 0 ? btcU / assetU : 0, size: assetU, sizeAtoms: big(asset) };
    };
    asks = forward.map((o) => toRow(o, true)).filter(r => r.price > 0 && r.size > 0);
    bids = reverse.map((o) => toRow(o, false)).filter(r => r.price > 0 && r.size > 0);
    n = forward.length + reverse.length;
  }
  // The clickable side is the one takeable in the user's current direction (buy asset with BTC -> asks;
  // sell asset for BTC -> bids). Tag it so aggregateLevels carries the flag onto the levels.
  const takeAsk = !!payIsBtc;
  asks.forEach(r => { r.take = takeAsk; });
  bids.forEach(r => { r.take = !takeAsk; });
  // P2.7: aggregate offers at the same price into ONE level per side (size + exact atoms summed), so a
  // thick level of many small offers is ONE row and the Sum column is cumulative over LEVELS.
  asks = aggregateLevels(asks);
  bids = aggregateLevels(bids);
  asks.sort((a, b) => a.price - b.price);
  { let c = 0; const t = asks.reduce((s, r) => s + r.size, 0) || 1; asks.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  // Stash the FULL aggregated levels (best-first) for the Market-mode price field's sweep estimate.
  LAST_LADDER = { base: seqAsset, quote: qHex, asks: asks.slice(), bids: bids.slice() };
  // Click-to-seed the takeable side's LEVELS: the level price + its aggregated size (exact atoms).
  const wireX = (r) => { if (r.take) r.onClick = () => seedFromLevel(r.price, r.sizeAtoms); };
  asks.forEach(wireX); bids.forEach(wireX);
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  LAST_MID = { price: mid, cross: true, base: seqAsset, quote: qHex, oneSided: !(bestAsk != null && bestBid != null) };
  renderLadder(host, {
    asks: asks.slice(0, 8).reverse(), bids: bids.slice(0, 8), mid, spread,   // 8 BEST (lowest) asks, shown high->low near the mid
    priceLabel: `(${am.ticker}/${qTk})`, sizeLabel: am.ticker,
    refMidStr: oneUnitRefStr(seqAsset),
    headTitle: 'Order book', headSub: `${n} offer${n === 1 ? '' : 's'}`,
    emptyMsg: 'No offers resting here yet.',
  });
  renderPairBar();
}

// The shared ladder: asks (red, high->low) · mid · bids (green, high->low), with a
// cumulative-depth bar per row. Rows whose item carries an onClick are clickable
// (click-a-level-to-price); the rest are display-only depth. ONE renderer for both
// the same-chain and cross-chain books, so orders look identical on every rail.
function renderLadder(host, o){
  if (!host) return;
  const rowHtml = (cls, r, i) => {
    const clk = typeof r.onClick === 'function';
    const w = Math.max(2, Math.min(100, Math.round((r.frac || 0) * 100)));
    return `<button type="button" class="swlrow ${cls}${clk ? '' : ' noclick'}${r.mine ? ' mine' : ''}" data-side="${cls}" data-i="${i}"${r.mine ? ' title="Your resting order"' : ''}${clk ? '' : ' tabindex="-1"'}>
      <span>${r.mine ? '<i class="swlyou">you</i>' : ''}${esc(fmtPrice(r.price))}</span><span>${esc(fmtGroup(r.size))}</span><span>${esc(fmtGroup(r.cum != null ? r.cum : r.size))}</span>
      <i class="swldepth" style="width:${w}%"></i></button>`;
  };
  const asks = o.asks || [], bids = o.bids || [];
  const asksHtml = asks.map((r, i) => rowHtml('ask', r, i)).join('');
  const bidsHtml = bids.map((r, i) => rowHtml('bid', r, i)).join('');
  const hasRows = asks.length || bids.length;
  const cols = `<div class="swladder-cols"><span>Price ${esc(o.priceLabel || '')}</span><span>Size${o.sizeLabel ? ' (' + esc(o.sizeLabel) + ')' : ''}</span><span>Sum</span></div>`;
  const midHtml = hasRows
    ? `<div class="swlmid"><b>${o.mid != null ? esc(fmtPrice(o.mid)) : '-'}</b> <span class="sp">${o.spread != null ? 'spread ' + esc(fmtPrice(o.spread)) + ' · mid' : 'best price'}</span> <span>${esc(o.refMidStr || '')}</span></div>`
    : '';
  const empty = hasRows ? '' : `<div class="swladder-empty">${esc(o.emptyMsg || 'No resting offers yet.')}</div>`;
  host.innerHTML = `<div class="swladder">
    <div class="swladder-head"><span class="sub" style="color:var(--txt);font-weight:650">${esc(o.headTitle || 'Order book')}</span><span class="sub">${esc(o.headSub || '')}</span></div>
    ${cols}${asksHtml}${midHtml}${bidsHtml}${empty}</div>`;
  host.querySelectorAll('.swlrow').forEach(b => {
    const side = b.dataset.side, i = +b.dataset.i;
    const r = (side === 'ask' ? asks : bids)[i];
    if (!r || typeof r.onClick !== 'function') return;
    b.onclick = () => { r.onClick(); host.querySelectorAll('.swlrow').forEach(x => x.classList.remove('picked')); b.classList.add('picked'); };
  });
  renderMyOrders();
}

function paintQuoteCross(){
  const { $ } = C; const q = LAST_QUOTE; if (!q || q.kind !== 'cross') return;
  const sm = C.assetMeta(q.seqAsset);
  // Show the user's requested amount. A courier take is now CAPPED to the request (never a whole-offer
  // overshoot), so the requested amount IS what the courier lifts — the panes match what actually locks.
  const reqSeq = q.requestedSeqAtoms != null ? BigInt(q.requestedSeqAtoms) : big(q.xq.seq_amount);
  const reqBtc = q.requestedBtcAtoms != null ? BigInt(q.requestedBtcAtoms) : big(q.xq.btc_amount);
  const seqStr = C.fmtAtoms(reqSeq, sm.precision);
  const btcStr = C.fmtAtoms(reqBtc, 8);
  // Map BTC<->asset onto pay/receive panes (whichever the user has on each side).
  const btcIsPay = (S.payAsset === 'BTC');
  if (btcIsPay){
    writeDerived($('swPayAmt'),  btcStr);
    writeDerived($('swRecvAmt'), seqStr);
  } else {
    writeDerived($('swPayAmt'),  seqStr);
    writeDerived($('swRecvAmt'), btcStr);
  }
  paintRefHints();
  const seqUnits = Number(reqSeq) / Math.pow(10, sm.precision || 0);
  const btcUnits = Number(reqBtc) / 1e8;
  let line = seqUnits > 0 ? `1 ${sm.ticker} = ${trim(btcUnits / seqUnits)} BTC` : '';
  // Market order bigger than the maker's depth: a MARKET cross order is IOC — it fills what the book
  // crosses now and CANCELS the rest (it never rests it; that is the Limit path). Say so honestly so the
  // composer preview matches what reviewCross executes (spec §6: Review == execution).
  const rem = q.remainderSeqAtoms != null ? BigInt(q.remainderSeqAtoms) : 0n;
  if (rem > 0n){
    const fillU = Number(BigInt(q.fillSeqAtoms)) / Math.pow(10, sm.precision || 0);
    const restU = Number(rem) / Math.pow(10, sm.precision || 0);
    line += ` · fills ~${trim(fillU)} ${sm.ticker} now, ~${trim(restU)} won’t fill (not rested)`;
  }
  $('swRate').textContent = line;
  // The trading fee is set in BTC by the maker at lift time (no open fee-asset market on the BTC leg). The
  // courier quote does not know it up front, so never show a misleading "0 BTC".
  if (!q.xq.fee_btc || big(q.xq.fee_btc) === 0n)
    paintFee('BTC', null, 'Trading fee set when the trade is placed · added to the Bitcoin you lock.');
  else
    paintFee('BTC', q.xq.fee_btc, 'Trading fee, paid in Bitcoin.');
  setFinality('cross');
}

// ---------------------------------------------------------------------------
// fee market (open: pay the network fee in any asset the node prices)
// ---------------------------------------------------------------------------
function paintFee(feeAssetHex, feeAtoms, noteOverride){
  const { $ } = C;
  // ONE authority (feeAssetPolicy) decides both the asset and whether the user may
  // change it. paintFee used to re-derive the lock rules here while the picker
  // derived its own, which is how the display could say BTC while the picker still
  // offered a Sequentia asset.
  const pol = feeAssetPolicy();
  if (pol.locked){
    feeAssetHex = pol.asset;
    S.feeAsset = pol.asset;          // FORCED: a stale pick must never outlive the lock
    S.feeAssetTouched = false;
  } else if (pol.asset){
    // Unlocked, but the offered set may have changed under a stale pick.
    feeAssetHex = pol.asset;
    S.feeAsset = pol.asset;
  }
  const fm = C.assetMeta(feeAssetHex);
  $('swFeeTk').textContent = fm.ticker;
  $('swFeeAmt').textContent = (feeAtoms != null) ? (C.fmtAtoms(feeAtoms, fm.precision) + ' ' + fm.ticker) : '-';
  const ref = (feeAtoms != null) ? (C.refValueStr(feeAssetHex, feeAtoms) || '') : '';
  $('swFeeRef').textContent = ref;
  $('swFeeNote').textContent = noteOverride || pol.note;
  // Also locked for the cross / LN / mixed quotes: their cost is the LP spread or
  // the BTC-leg fee baked into the rate, not a taker-funded open-market fee.
  const quoteLocked = !!(LAST_QUOTE && (LAST_QUOTE.kind === 'cross' || LAST_QUOTE.kind === 'ln' || LAST_QUOTE.kind === 'mixed'));
  // DISABLED, not merely emptied: an enabled picker with nothing behind it reads
  // as a broken control, and an enabled picker on a locked rail is the regression.
  const noFee = pol.locked || quoteLocked || !pol.options.length;
  $('swFeePick').disabled = !!noFee;
  $('swFeePick').style.opacity = noFee ? '.5' : '';
  if (pol.why) $('swFeePick').title = pol.why;
  else if (noFee) $('swFeePick').title = 'The fee asset is set by how this trade settles.';
  else $('swFeePick').removeAttribute('title');
}

// An asset is acceptable for fees if, and only if, the node publishes a rate for
// it. BTC is never one: it is not a Sequentia-issued asset, so no Sequentia fee
// can be denominated in it.
//
// The policy asset used to be hardcoded as always-accepted here, on the reasoning
// that the protocol accepted it natively. That stopped being true: the node's
// ConvertAmountToValue no longer falls back to 1:1 for an UNLISTED policy asset
// (no asset is the reference unit), so an unlisted tSEQ is refused exactly like
// any other unlisted asset. Keeping the privilege here would offer the user a fee
// asset the mempool then rejects with a generic "min relay fee not met". The
// whitelist is now the whole truth on both sides.
function acceptedFee(hex){
  if (!hex || hex === 'BTC') return false;
  const r = C.feeRates || {};
  const e = r[hex] || r[C.assetMeta(hex).ticker];   // feeRates is keyed by ticker, not asset hex
  return !!(e && e.rate > 0);
}
const feeVal = (h) => Number(big((C.balObj()||{})[h] || 0)) / Math.pow(10, C.assetMeta(h).precision || 0);

// ---------------------------------------------------------------------------
// feeAssetPolicy — THE single authority on which asset pays the fee.
// ---------------------------------------------------------------------------
// Every consumer (the picker, defaultFeeAsset, paintFee, the affordability gates
// and the review modals) reads this one function, because the previous split
// between them is what produced the reported regression: the DISPLAY was locked
// to BTC on the cross and mixed paths while the PICKER stayed live, so a user
// could select a Sequentia asset for a fee that is only payable in BTC, and a
// stale S.feeAsset survived a rail change because nothing forced it.
//
// The rule has three cases and one authority:
//
//   1. Paying BTC ON-CHAIN     -> LOCKED to BTC. This is a Bitcoin network fee
//      (sat/vB) on the parent chain. It cannot be denominated in a Sequentia
//      asset, whatever the picker used to allow.
//   2. Paying over LIGHTNING   -> LOCKED to the asset being paid, BTC-LN
//      included. An LN fee is a routing fee, and routing fees are paid in the
//      asset being routed.
//   3. Paying an ON-CHAIN SEQUENTIA ASSET -> the open fee market. Any on-chain
//      Sequentia asset the node prices AND you actually hold. tSEQ is one row
//      among equals with no privileged position, and BTC never appears: it is
//      not a Sequentia-issued asset.
//
// `locked` means the user has no choice, so the picker must be DISABLED rather
// than merely emptied — an enabled-but-empty control reads as a broken app.
function feeAssetPolicy(){
  const payAsset = S.payAsset;
  if (!payAsset)
    return { locked: false, asset: null, options: [],
             note: 'Pay the fee in any asset the network prices.' };

  // Rule 2 first: the rail decides before the asset does, so BTC-over-Lightning
  // is a Lightning fee in BTC, not a Bitcoin network fee.
  if (S.payRail === 'ln'){
    const tk = C.assetMeta(payAsset).ticker;
    return { locked: true, asset: payAsset, options: [],
             note: `In ${tk} · the asset you pay over Lightning.`,
             why: `Paying over Lightning · the fee is in ${tk}, the asset you pay.` };
  }
  // Rule 1.
  if (payAsset === 'BTC')
    return { locked: true, asset: 'BTC', options: [],
             note: 'In BTC · the Bitcoin network fee.',
             why: 'Paying Bitcoin on-chain · the fee is the Bitcoin network fee, payable only in BTC.' };

  // Rule 3: the open fee market.
  const options = feeAssetOptions();
  const valid = new Set(options.map(o => o.hex));
  // A pick only survives while it is still on offer. This is what stops a stale
  // S.feeAsset from outliving the rail or pay-asset change that invalidated it.
  const chosen = (S.feeAssetTouched && S.feeAsset && valid.has(S.feeAsset))
    ? S.feeAsset
    : preferredFeeAsset(options);
  return { locked: false, asset: chosen, options,
           note: 'Pay the fee in any asset the network prices.' };
}

// preferredFeeAsset picks the opening default from the offered set: the asset you
// are already paying with (the most natural source, and neutral — no privileged
// asset), else the largest holding. It never invents an asset outside the list,
// which is what the old tSEQ fallback did.
function preferredFeeAsset(options){
  if (!options.length) return null;
  const hexes = options.map(o => o.hex);
  if (S.payAsset && hexes.includes(S.payAsset)) return S.payAsset;
  return hexes.slice().sort((a, b) => feeVal(b) - feeVal(a))[0];
}

// Default fee asset: whatever the one authority says.
function defaultFeeAsset(){ return feeAssetPolicy().asset; }

// The rule-3 candidate list: on-chain Sequentia assets the node prices AND you
// hold a positive balance of. Holding none of an asset makes it unpayable, and
// offering an unpayable row is the same class of defect as leaving the picker
// live on a locked rail. Every entry is treated identically — no asset is flagged
// as a "default", and tSEQ earns its row only by being priced and held.
function feeAssetOptions(){
  const seen = new Set(), out = [];
  const bal = C.balObj() || {};
  const add = (hex) => {
    if (!hex || seen.has(hex) || !acceptedFee(hex)) return;
    if (big(bal[hex] || 0) <= 0n) return;
    seen.add(hex); out.push({ hex, ticker: C.assetMeta(hex).ticker });
  };
  add(S.payAsset);   // listed first: the most natural fee source
  Object.keys(bal).forEach(add);
  return out;
}
function renderFeePicker(){
  const pol = feeAssetPolicy();
  // Force the state to agree with the policy on every render, so a rail or
  // pay-asset change can never leave a stale pick behind.
  if (pol.asset && S.feeAsset !== pol.asset){ S.feeAsset = pol.asset; }
  if (pol.locked) S.feeAssetTouched = false;
  C.$('swFeeTk').textContent = pol.asset ? C.assetMeta(pol.asset).ticker : '-';
  const pick = C.$('swFeePick');
  if (pick){
    const noFee = pol.locked || !pol.options.length;
    pick.disabled = !!noFee;
    pick.style.opacity = noFee ? '.5' : '';
    if (pol.why) pick.title = pol.why; else pick.removeAttribute('title');
  }
}
function openFeePicker(){
  if (C.$('swFeePick').disabled) return;
  const pol = feeAssetPolicy();
  if (pol.locked || !pol.options.length) return;   // belt and braces: never open a locked picker
  const opts = pol.options;
  popover(C.$('swFeePick'), opts.map(o => ({
    hex: o.hex, ticker: o.ticker, name: feeAssetSubline(o.hex), bal: balLine(o.hex), enabled: true,
  })), (hex) => {
    S.feeAsset = hex; S.feeAssetTouched = true; renderFeePicker();
    LAST_QUOTE = null; setReviewEnabled(false);
    requote().catch(()=>{});
  });
}
function feeAssetSubline(hex){
  if (hex === S.payAsset) return 'The asset you’re paying with';
  return 'Accepted for fees';
}

// ---------------------------------------------------------------------------
// honest, actionable timing banner (keyed off the RECEIVE leg)
// ---------------------------------------------------------------------------
// The LP instant-front CAP (how much on-chain PAY the LP will front so you receive on Lightning NOW), in
// BTC atoms (= sats). SINGLE SOURCE OF TRUTH order (P3.5): an explicit operator override
// (window.SEQ_LSP_FRONT_CAP, BTC units) wins; else the LSP /status advertises it in SATS
// (mixed_max_0conf_sats, captured in MAX0CONF_SATS) so the composer tracks the box's real MIXED_MAX_0CONF
// with no hard-coded drift; else the box default. Compared against the BTC leg of the trade in BTC atoms.
function frontCapAtoms(){
  const w = (typeof window !== 'undefined') ? window : {};
  const c = w.SEQ_LSP_FRONT_CAP;
  if (c != null){ try { return C.parseAtoms(String(c), 8); } catch {} }
  if (MAX0CONF_SATS != null && Number.isFinite(MAX0CONF_SATS) && MAX0CONF_SATS >= 0) return BigInt(Math.floor(MAX0CONF_SATS));
  return 200000n;   // 0.002 BTC — the box default until /status is read (matches the live LSP MIXED_MAX_0CONF)
}
// The BTC leg amount of the current composer state, in BTC atoms (the on-chain PAY
// exposure the CAP governs). Exactly one side of a BTC pair is BTC.
function btcLegAtoms(){
  const btcIsPay = (S.payAsset === 'BTC');
  const v = ((btcIsPay ? C.$('swPayAmt') : C.$('swRecvAmt')).value || '').trim();
  try { return C.parseAtoms(v, 8); } catch { return 0n; }
}
// The ASSET leg amount of the current composer state, in the asset's OWN atoms — the size the user
// actually wants to trade (P3.1: size the bridged take to THIS, never the whole resting offer). On a BUY
// (payIsBtc) the asset is the RECEIVE field; on a SELL it is the PAY field.
function assetLegAtoms(route){
  const assetIsPay = !route.payIsBtc;
  const v = ((assetIsPay ? C.$('swPayAmt') : C.$('swRecvAmt')).value || '').trim();
  const am = C.assetMeta(route.seqAsset) || {};
  try { return C.parseAtoms(v, am.precision || 0); } catch { return 0n; }
}
// testnet4 on-chain payment confirmation estimate (the pay leg must confirm before an
// over-CAP LN front settles). Overridable via window.SEQ_ONCHAIN_CONF = { n, t }.
function onchainConf(){
  const w = (typeof window !== 'undefined') ? window : {};
  const o = w.SEQ_ONCHAIN_CONF;
  return (o && o.n) ? { n: o.n, t: o.t || '~10 min' } : { n: 1, t: '~10 min' };
}
// asset units per BTC unit, from the best resting offer (for expressing the CAP in the
// pay asset's own units when paying an asset). 0 if unknown.
function assetPerBtc(route){
  const o = (XBOOK.offers || [])[0]; if (!o) return 0;
  const am = C.assetMeta(route.seqAsset);
  const { asset, btc } = xOfferAmts(o, route.payIsBtc);
  const assetU = Number(big(asset)) / Math.pow(10, am.precision || 0), btcU = Number(big(btc)) / 1e8;
  return btcU > 0 ? assetU / btcU : 0;
}
// The CAP expressed in the PAY asset's own units (BTC when paying BTC; the asset when
// paying the asset, converted via the best-offer price; falls back to BTC if unknown).
function capDisplay(route){
  const cap = frontCapAtoms();
  if (route.payIsBtc) return C.fmtAtoms(cap, 8) + ' BTC';
  const r = assetPerBtc(route);
  if (r > 0){
    const am = C.assetMeta(route.seqAsset);
    const capAssetUnits = (Number(cap) / 1e8) * r;
    const capAssetAtoms = BigInt(Math.round(capAssetUnits * Math.pow(10, am.precision || 0)));
    return C.fmtAtoms(capAssetAtoms, am.precision || 0) + ' ' + am.ticker;
  }
  return C.fmtAtoms(cap, 8) + ' BTC';
}
// Anchor-honest wording reused across the on-chain-receipt cases.
const ANCHOR_FINAL = 'reverts only if Bitcoin reverts';

// Render the timing banner for the current route. The matrix is keyed off the RECEIVE
// leg (an on-chain RECEIPT is never made instant by the CAP; the CAP only fronts an
// on-chain PAYMENT). The inline "fix" links flip a leg to Lightning.
// Take the timing/settlement line off the screen entirely. A crossing that is about to be
// REFUSED must not first be described as instant and final: settlement copy above a refusal
// is a promise the composer is one line away from breaking. clearTiming is the counterpart
// of renderTiming, which restores the element on every path that really has timing to state.
function clearTiming(){
  const el = C.$('swTiming'), ic = C.$('swTimingIcon'), tx = C.$('swTimingText');
  if (!el || !tx) return;
  el.style.display = 'none'; el.className = 'swtiming';
  if (ic) ic.textContent = ''; tx.innerHTML = '';
}
function renderTiming(route){
  const el = C.$('swTiming'), ic = C.$('swTimingIcon'), tx = C.$('swTimingText');
  if (!el || !tx) return;
  el.style.display = '';   // undo a previous clearTiming (a refused crossing hides this line)
  const wireFix = () => { el.querySelectorAll('.swfix').forEach(s => s.onclick = () => setRail(s.dataset.fix, 'ln')); };
  const ln = lnAvailable();
  // Only offer a "switch this leg to Lightning" fix when that leg has a REAL usable
  // channel — otherwise the link would be a dead no-op (the rail stays on-chain).
  const ra = ln ? railAvail(S.payAsset, S.receiveAsset) : { payLn: { ok: false }, recvLn: { ok: false } };
  if (!route){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '•';
    tx.innerHTML = 'Pick two assets to see how settlement works.';
    return;
  }
  if (route.kind === 'same'){
    // Same-chain atomic swap: on-chain receipt (no LN option here), anchor-bound.
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    tx.innerHTML = `Appears immediately, final in <b>~1 block</b> · ${ANCHOR_FINAL}.`;
    return;
  }
  // BTC pair: the exact 4-case matrix keyed off the receive leg.
  const pr = route.payRail, rr = route.recvRail;
  const tk = esc(C.assetMeta(route.seqAsset).ticker);
  if (rr === 'ln' && pr === 'ln'){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '✓';
    tx.innerHTML = '<b>Instant &amp; final</b> · both sides on Lightning, nothing on-chain to revert.';
  } else if (rr === 'ln' && pr === 'chain' && btcLegAtoms() <= frontCapAtoms()){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '✓';
    tx.innerHTML = `<b>Instant.</b> Your on-chain payment is fronted; you receive final ${tk} now.`;
  } else if (rr === 'ln' && pr === 'chain'){
    const { n, t } = onchainConf();
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    // The "pay from Lightning" fix only helps when the PAY leg has a usable channel.
    const canFixPay = ra.payLn.ok;
    tx.innerHTML = `<b>~${n} confirmation${n > 1 ? 's' : ''} (${esc(t)}):</b> your on-chain payment must confirm first. `
      + (canFixPay ? `Settle instantly by <span class="swfix" data-fix="pay">paying from Lightning</span>, or trade under ${esc(capDisplay(route))}.`
                   : `Trade under ${esc(capDisplay(route))} to be fronted instantly.`);
    if (canFixPay) wireFix();
  } else {   // rr === 'chain' (any pay rail): on-chain receipt, inherent — CAP can't make it instant
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    // Offer "switch Receive to Lightning" only when the RECEIVE leg has a usable channel.
    const canFixRecv = ra.recvLn.ok;
    tx.innerHTML = `Appears immediately, final in <b>~1 block</b> · ${ANCHOR_FINAL}.`
      + (canFixRecv ? ` To receive instantly &amp; finally, <span class="swfix" data-fix="recv">switch Receive to Lightning</span>.` : '');
    if (canFixRecv) wireFix();
  }
}
// Back-compat shim: older call sites pass a kind string; the banner now derives its
// state from the live route + rails, so the argument is ignored.
function setFinality(_kind){ renderTiming(findRoute(S.payAsset, S.receiveAsset)); }

// ---------------------------------------------------------------------------
// asset picker popover (searchable; ticker · balance · ≈ ref)
// ---------------------------------------------------------------------------
function balLine(hex){
  if (!hex) return { b:'', r:'' };
  const a = balAtoms(hex), m = metaOf(hex);
  return { b: C.fmtAtoms(a, m.precision) + ' ' + m.ticker, r: C.refValueStr(hex, a) || '' };
}

// The candidate rows for one side's picker. Candidate set: assets that trade against the
// OTHER side (or all tradable if the other side is unset) — this is what enforces "only
// offer a counter-asset that trades". Each row is flagged held (a positive balance
// ON-CHAIN OR LIGHTNING — a fully-moved asset is still yours) and hidden (F2), which is
// what pickerMatches keys the default-vs-search visibility on. Split out of openPicker
// so the headless harness drives the REAL candidate construction.
function pickerCandidates(side){
  const other = side === 'pay' ? S.receiveAsset : S.payAsset;
  const candidates = counterpartsOf(other);
  const cur = side === 'pay' ? S.payAsset : S.receiveAsset;
  // Your HELD assets first (carrying the on-chain/Lightning split that used to be on the top
  // cards), then every other tradable asset — so a registry of thousands stays navigable via the
  // search box. This dropdown is what replaces the removed cards.
  const list = candidates.map(hex => {
    const held = balAtoms(hex) > 0n || instantAtomsFor(hex) > 0n;
    return {
      hex, ticker: metaOf(hex).ticker, name: pickerName(hex), bal: balLine(hex),
      held, split: held ? heldSplitStr(hex) : '',
      hidden: isAssetHidden(hex),
      enabled: hex !== cur,
    };
  });
  list.sort((a, b) => (b.held ? 1 : 0) - (a.held ? 1 : 0) || a.ticker.localeCompare(b.ticker));
  // The OPPOSITE side's asset used to be silently OMITTED here, so reversing a pair took a
  // three-step dance through a neutral asset. Show it instead — first, visually distinct,
  // with an explicit swap-sides affordance; picking it flips the whole pair (onFlip).
  if (other){
    list.unshift({ hex: other, ticker: (metaOf(other) || {}).ticker || 'asset',
      name: pickerName(other), bal: balLine(other), held: false,
      split: '<span class="z">on the other side · tap to swap sides</span>',
      enabled: true, cls: 'swopt-other', pin: true });
  }
  return { list, other };
}

function openPicker(side){
  const { list, other } = pickerCandidates(side);
  const anchor = side === 'pay' ? C.$('swPayPick') : C.$('swRecvPick');
  popover(anchor, list, (hex) => {
    // The opposite side's asset = the swap-sides affordance: flip the whole pair (assets,
    // amounts, rails) rather than setting both sides to the same asset.
    if (hex === other){ onFlip(); return; }
    if (side === 'pay') S.payAsset = hex; else S.receiveAsset = hex;
    // If the new selection collides with the other side, clear the other side.
    if (S.payAsset && S.payAsset === S.receiveAsset){
      if (side === 'pay') S.receiveAsset = null; else S.payAsset = null;
    }
    // If the other side no longer trades against the new pick, clear it.
    const o = side === 'pay' ? S.receiveAsset : S.payAsset;
    if (o && !counterpartsOf(hex).includes(o)){ if (side === 'pay') S.receiveAsset = null; else S.payAsset = null; }
    S.payRail = null; S.recvRail = null;   // rails reset to unselected for the new pair (no default; user must pick)
    S.feeAsset = null; S.feeAssetTouched = false; S.priceFlip = false;   // fee default re-follows the new pay asset; a manual pick + display flip are per-pair, not global (D2/C-11)
    { const pe = C.$('swPriceAmt'); if (pe) { pe._userTyped = false; pe.value = ''; } }  // clear a held limit price on asset change (new frame -> re-placeholder from the new inside price)
    LAST_QUOTE = null; setReviewEnabled(false);
    paintPanes();
    requote().catch(()=>{});
  });
}
function pickerName(hex){ if (hex === 'BTC') return 'Bitcoin testnet4'; return C.assetMeta(hex).name || 'Asset'; }
// The on-chain/Lightning split for a held asset — the info that used to be on the top cards,
// now shown inline under a held asset's name in the dropdown. HTML (the ⚡ part gets the amber .z).
function heldSplitStr(hex){
  const m = metaOf(hex), instant = instantAtomsFor(hex), onchain = balAtoms(hex);
  return `<span class="z">${C.fmtAtoms(instant, m.precision)} Lightning</span> · ${C.fmtAtoms(onchain, m.precision)} on-chain`;
}

// Which rows a picker query shows (F1) — pure over the candidate rows, so the headless
// harness pins it.
// EMPTY query: only assets you HOLD (on-chain or Lightning) plus native BTC — the
// parent-chain asset stays first-class in the picker even at 0 — minus hidden assets
// (F2, Balance-tab hide). Pinned rows (the other side's tap-to-swap affordance) always
// show. The registry tail is reachable by typing, never rendered eagerly.
// TYPED query: search EVERY candidate (full registry, hidden assets included) by
// ticker, name, or id. A 64-hex query that matches nothing known is still an asset id:
// synthesize a selectable row for it (metaOf resolves registry metadata when known,
// otherwise the id-prefix ticker at precision 8), marked pasted so the pick is
// registered for the session (notePasted) and survives composer validation.
function pickerMatches(items, q){
  q = (q || '').trim();
  if (!q) return items.filter(it => it.pin || it.hex === 'BTC' || (it.held && !it.hidden));
  const ql = q.toLowerCase();
  const match = items.filter(it => (it.ticker + ' ' + (it.name || '') + ' ' + it.hex).toLowerCase().includes(ql));
  if (!match.length && /^[0-9a-fA-F]{64}$/.test(q)){
    const hex = ql;   // asset ids are canonically lowercase hex
    const m = metaOf(hex) || {};
    match.push({ hex, ticker: m.ticker || hex.slice(0, 8) + '…', name: m.name || 'Asset',
      bal: balLine(hex), held: false, split: '', hidden: false, enabled: true, pasted: true });
  }
  return match;
}

// A lightweight searchable popover anchored under `anchorEl`. `items` are
// { hex, ticker, name, bal:{b,r}, enabled }. onPick(hex) is called on selection.
let _pop = null;
function popover(anchorEl, items, onPick){
  closePopover();
  const { el } = C;
  anchorEl.setAttribute('aria-expanded', 'true');
  const pop = el('div','swpop'); pop.setAttribute('role','listbox');
  const sb = el('div','swpop-search'); const inp = el('input'); inp.placeholder = 'Search assets'; inp.setAttribute('aria-label','Search assets');
  sb.appendChild(inp); pop.appendChild(sb);
  const listEl = el('div','swpop-list'); pop.appendChild(listEl);
  document.body.appendChild(pop);
  // Position under the anchor, clamped to viewport.
  const r = anchorEl.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 40) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';

  const ALL_CAP = 40;   // don't render a whole (potentially huge) registry eagerly — search finds the rest
  let kbdIdx = -1, shown = [], optEls = [];
  const rowFor = (it) => {
    const b = el('button','swopt' + (it.cls ? ' ' + it.cls : '')); b.type = 'button'; b.setAttribute('role','option');
    if (!it.enabled){ b.disabled = true; }
    const t = el('span','swopt-tk', it.ticker);
    // E1: verified ✓ / unregistered ⚠ trust badge next to the ticker (same signal as the Balance list).
    try { const tb = C.trustBadge && C.trustBadge(it.hex); if (tb) t.appendChild(tb); } catch {}
    const mid = el('div','swopt-mid'); mid.appendChild(el('div','swopt-name', it.name || ''));
    if (it.split){ const sp = el('div','swopt-split'); sp.innerHTML = it.split; mid.appendChild(sp); }
    const bal = el('div','swopt-bal');
    if (it.bal && it.bal.b) bal.appendChild(el('div','b', it.bal.b));
    if (it.bal && it.bal.r) bal.appendChild(el('div','r', it.bal.r));
    b.appendChild(t); b.appendChild(mid); b.appendChild(bal);
    b.onclick = () => { if (it.enabled){ pickItem(it); } };
    return b;
  };
  // One selection path for click + Enter: a pasted-id row is registered for the session
  // (notePasted) so startableAssets keeps offering it and ensureDefaults never drops it.
  const pickItem = (it) => { if (it.pasted) notePasted(it.hex); onPick(it.hex); closePopover(); };
  const draw = (q) => {
    listEl.innerHTML = ''; kbdIdx = -1; shown = []; optEls = [];
    const match = pickerMatches(items, q);
    if (!match.length){ listEl.appendChild(el('div','swopt-empty','No matching assets.')); return; }
    // PINNED rows first (the other side's asset · tap-to-swap-sides), then your held assets,
    // then everything else. The "All assets" tail is capped until you search, so a registry
    // of thousands never renders thousands of rows.
    const pinned = match.filter(it => it.pin);
    for (const it of pinned){
      const b = rowFor(it); const idx = shown.length;
      b.onmouseenter = () => { kbdIdx = idx; markKbd(); };
      listEl.appendChild(b); shown.push(it); optEls.push(b);
    }
    const held = match.filter(it => it.held && !it.pin), all = match.filter(it => !it.held && !it.pin);
    const capped = q && all.length > ALL_CAP;
    const groups = [];
    if (held.length) groups.push(['Your assets', held]);
    // Default view: the non-held tail is just BTC (and never the registry), so it is
    // labeled plain 'Assets'; under a search the tail really is the registry sweep.
    if (all.length) groups.push([(q && held.length) ? 'All assets' : 'Assets', capped ? all.slice(0, ALL_CAP) : all]);
    for (const [label, arr] of groups){
      listEl.appendChild(el('div','swopt-grp', label));
      for (const it of arr){
        const b = rowFor(it); const idx = shown.length;
        b.onmouseenter = () => { kbdIdx = idx; markKbd(); };
        listEl.appendChild(b); shown.push(it); optEls.push(b);
      }
    }
    if (capped) listEl.appendChild(el('div','swopt-more', `+${all.length - ALL_CAP} more · keep typing to find them.`));
    // The default view holds only your assets + BTC: say how to reach everything else.
    if (!q) listEl.appendChild(el('div','swopt-more','Type to search every registry asset, or paste an asset id.'));
  };
  const markKbd = () => {
    optEls.forEach((c,i)=>c.classList.toggle('kbd', i===kbdIdx));
    const cur = optEls[kbdIdx]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block:'nearest' });
  };
  inp.addEventListener('input', () => draw(inp.value.trim()));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown'){ e.preventDefault(); kbdIdx = Math.min(shown.length-1, kbdIdx+1); markKbd(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); kbdIdx = Math.max(0, kbdIdx-1); markKbd(); }
    else if (e.key === 'Enter'){ e.preventDefault(); const it = shown[kbdIdx] || shown[0]; if (it && it.enabled){ pickItem(it); } }
    else if (e.key === 'Escape'){ closePopover(); anchorEl.focus(); }
  });
  draw('');
  setTimeout(() => inp.focus(), 0);
  _pop = { pop, anchorEl, onDoc:(ev)=>{ if (!pop.contains(ev.target) && ev.target !== anchorEl) closePopover(); } };
  setTimeout(() => document.addEventListener('mousedown', _pop.onDoc), 0);
}
function closePopover(){
  if (!_pop) return;
  document.removeEventListener('mousedown', _pop.onDoc);
  _pop.anchorEl.setAttribute('aria-expanded', 'false');
  _pop.pop.remove(); _pop = null;
}

// ---------------------------------------------------------------------------
// Review -> route to same-chain swap OR cross-chain wizard
// ---------------------------------------------------------------------------
// ===========================================================================
// RAIL-BLIND BRIDGED TAKE (wallet side of a genuine rail crossing).
//
// The offer's EFFECTIVE minimum fill, in asset atoms.
//
// An offer with allow_partial:false is whole-or-nothing, which the unified book
// normalises to a min_fill of the full size (see mk() in unified-book.mjs). Reading
// raw.min_fill directly bypasses that normalisation and silently re-introduces the
// bug it exists to prevent — an indivisible offer sized as if it were divisible, which
// the maker answers by locking the WHOLE offer against a partial take.
function offerMinFill(entry, raw){
  if (entry && entry.minFill != null) return BigInt(entry.minFill);
  if (raw && (raw.allow_partial === false || raw.allowPartial === false))
    return BigInt(raw.base_amount ?? raw.baseAmount ?? raw.offer_amount ?? 0);
  return BigInt((raw && (raw.min_fill ?? raw.minFill)) || 0);
}

// The take is rail-BLIND: pick the best-PRICE resting offer (bestFor over the unified book), regardless
// of the taker's rail toggle, then build the settlement match from the TAKER's chosen rails + the
// OFFER's rails (matchFromTake). Coincide -> the existing native review/execute (the LSP is NOT in the
// value path). CROSS -> the LSP bridges the mismatched leg(s) on one shared preimage (POST /swap
// {bridge:true}). Rail is a pure preference, never a matching gate: an on-chain taker can lift an LN
// maker's offer and vice versa, and the driver + nextBridgeStep keep every front recoup-secured.
// ===========================================================================
const BRIDGE_KEY = 'swk.sequentia.bridge';
let BRIDGE = null;
try { BRIDGE = JSON.parse(localStorage.getItem(BRIDGE_KEY) || 'null'); } catch { BRIDGE = null; }
function saveBridge(){
  try { stampStages([BRIDGE]); } catch {}
  try { localStorage.setItem(BRIDGE_KEY, JSON.stringify(BRIDGE)); } catch {}
  try { renderInFlightCard(); } catch {}   // see saveSubswap: every transition must be visible
}
function clearBridge(){ BRIDGE = null; try { localStorage.removeItem(BRIDGE_KEY); } catch {} try { renderInFlightCard(); } catch {} }
function bridgeTerminal(){ return !BRIDGE || BRIDGE.state === 'settled' || BRIDGE.state === 'failed'; }
export function hasBridgeInFlight(){ return !!BRIDGE && !bridgeTerminal(); }
let _bridgeStarting = false;

// The rail-blind take plan for a BTC<->asset route: the best-price offer (rail-blind), the settlement
// match (taker rails + offer rails), and whether it CROSSES. Returns null when there is no unified book /
// no resting offer -> the caller uses the existing native/post path. Pure + defensive: any failure
// returns null so the take falls back to the proven native path, never dead-ends or throws.
// Offers whose handshake already failed with NOTHING funded. Kept out of the plan so a retry does not
// pick the same dead offer straight back.
//
// THE BLACKLIST EXPIRES, because almost nothing that puts an offer here is permanent. A maker serving
// one lift at a time answers "busy" to everyone else — for a few seconds — and the offer was then
// struck out for the REST OF THE SESSION. With a fleet where every maker is briefly busy in turn, the
// book emptied itself: a wallet facing 24 live GOLD offers ended up with nothing it would take and
// said "This trade could not be placed right now" against a full order book. The refusal was even
// truthful about each individual attempt; the memory of it was the bug.
//
// So entries carry an expiry, and a refusal that is obviously momentary gets a short one. A genuinely
// structural mismatch (an offer this trade's settlement path cannot use at all) still gets the long
// TTL — it will not become usable within a session, but it is not immortal either, because offers are
// re-posted under new ids anyway and a stale grudge against a rotated fleet helps nobody.
const DEAD_TTL_MS = 5 * 60 * 1000;          // structural: long enough to stop a retry loop
const DEAD_TTL_TRANSIENT_MS = 45 * 1000;    // "busy" / "draining": the maker frees itself in seconds
let _deadUntil = new Map();                 // offer id -> epoch ms at which it is takeable again
function markOfferDead(id, why){
  if (!id) return;
  _deadUntil.set(id, Date.now() + (transientRefusal(why) ? DEAD_TTL_TRANSIENT_MS : DEAD_TTL_MS));
}
function clearDeadOffers(){ _deadUntil = new Map(); }
// A refusal that says the counterparty is momentarily occupied, not that this offer is unusable.
function transientRefusal(why){
  return /\bbusy\b|another lift is in flight|draining|shutting down for a re-quote|try again in a moment/i
    .test(String(why || ''));
}
// Set-shaped view for the planner (bestFor takes something with .has), with expiry applied on read so
// a lapsed entry disappears without anyone having to sweep it.
const _deadOffers = {
  has(id){
    const until = _deadUntil.get(id);
    if (until == null) return false;
    if (Date.now() >= until){ _deadUntil.delete(id); return false; }
    return true;
  },
  get size(){ let n = 0; for (const id of [..._deadUntil.keys()]) if (this.has(id)) n++; return n; },
};

// --- SPEED-AWARE SELECTION (routing honesty; owner ruling) -------------------------------
// A taker paying BTC over Lightning must NEVER wait on Bitcoin confirmations to receive the
// asset they bought when a maker that settles at Sequentia speed rests at the same price.
// These two strings are the ONE copy for the settlement class, shared by the reviews and the
// drive-time status so they can never drift apart.
const SPEED_FAST_NOTE = 'Settles at Sequentia speed · typically about a minute.';
const SPEED_SLOW_NOTE = 'Waits on Bitcoin confirmations · typically 10-60+ minutes on testnet4 · safe to leave — it resumes and refunds automatically.';

// Does taking THIS offer, on THESE taker rails, settle at Sequentia speed? An offer served
// natively (the sub-asset shapes) or by a P2P submarine (an interactive maker on the matching
// rails) settles in ~a minute (0-conf-tolerant); an offer that needs the LSP leg-bridge runs
// the maker-first pipeline, which waits on testnet4 confirmations (tens of minutes to hours).
// CONSTRAINT: this reads the SAME authorities the settlement dispatch reads
// (makerRailsFromOffer + chooseSettlementPath), so the speed class can never disagree with
// the path that actually executes. Selection/label input ONLY — never a settlement decision.
function offerSettlesFast(offer, { asset, side, payRail, recvRail }){
  try {
    const { makerBtcRail, makerAssetRail } = makerRailsFromOffer(offer);
    const disp = chooseSettlementPath(matchFromTake({ asset, side, payRail, recvRail,
      makerBtcRail, makerAssetRail, takerAssetInbound: false, takerBtcInbound: false }),
      (offer && offer.meta) || {});
    return disp.path === 'native' || disp.path === 'p2p-submarine';
  } catch { return false; }
}

// The legs a take of `want` would EXECUTE against one offer — sized by sizeSubswapTake, the
// ONE sizing authority (identical ceil-on-buy / floor-on-sell rounding the take itself uses;
// never a different rounding). No amount typed (want<=0) compares the offer's own whole legs
// (exact integers, no rounding at all).
function executedLegsFor(offer, side, want){
  const oa = BigInt(offer.assetAtoms || 0), ob = BigInt(offer.btcSats || 0);
  if (want > 0n){
    const sz = sizeSubswapTake({ want, offerAtoms: oa, offerBtc: ob,
      minFill: offerMinFill(offer, offer.raw || {}), side });
    if (sz.takeAtoms > 0n && sz.takeBtc > 0n) return { atoms: sz.takeAtoms, btc: sz.takeBtc };
  }
  return { atoms: oa, btc: ob };
}

// Is the BRIDGED (slow) offer's price STRICTLY better than the native (fast) one's, on the
// EXECUTED amounts? Cross-multiplied BigInt (no float, no re-rounding): on a BUY the taker
// pays the BTC leg, so strictly better = strictly fewer sats per executed atom; on a SELL
// the taker receives it, so strictly better = strictly more. A TIE on the executed amounts
// is NOT strictly better — the native maker wins it.
function bridgedBeatsExecuted(bridged, native, side, want){
  const b = executedLegsFor(bridged, side, want), n = executedLegsFor(native, side, want);
  if (!(b.atoms > 0n && n.atoms > 0n)) return false;
  return side === 'buy' ? (b.btc * n.atoms < n.btc * b.atoms)
                        : (b.btc * n.atoms > n.btc * b.atoms);
}

// rails: optional { payRail, recvRail } override. A RESUMED or RETRIED take must plan
// against the rails of the order as PLACED, not whatever the composer holds now —
// resetComposer() clears S the moment the user confirms, so anything re-planning later
// found the rails unset and gave up. The record carries them; pass them in.
// `only` (optional) narrows the book to the offers ONE settlement path can actually lift. Matching
// stays rail-blind by default; a caller passes this ONLY when it would otherwise have to REFUSE a
// trade the book can genuinely fill, and it must then DISPLAY the offer this picked — so the
// invariant that the displayed offer IS the one lifted still holds exactly.
function bridgedTakePlan(route, rails, wantAtoms, only){
  try {
    if (!route || !route.seqAsset) return null;
    const payRail = (rails && rails.payRail) || S.payRail;
    const recvRail = (rails && rails.recvRail) || S.recvRail;
    // Rails not chosen yet is a NORMAL composer state, not a failure. It is recorded
    // distinctly because the caller must not report it as a network problem — see
    // the fall-through in requoteCross.
    if (!payRail || !recvRail){ _lastPlanError = null; _railsUnset = true; return null; }
    _railsUnset = false;
    // Asset-paired markets are served now: /book/unified takes a ?quote asset, so
    // EURX/OILX has a unified book like every BTC pair. The cached book must be for
    // the SAME pair — matching only on the base asset would hand an EURX/OILX route
    // the EURX/BTC book.
    const wantQuote = ((route.assetAsset || route.mixedSame) && route.quoteAsset) ? route.quoteAsset : 'BTC';
    const book = (UBOOK && UBOOK.seqAsset === route.seqAsset && (UBOOK.quote || 'BTC') === wantQuote) ? UBOOK : null;
    if (!book) return null;
    const side = route.payIsBtc ? 'buy' : 'sell';                     // buy = pay BTC / receive asset; sell = pay asset / receive BTC
    const pool = only
      ? { asks: (book.asks || []).filter(only), bids: (book.bids || []).filter(only) }
      : { asks: book.asks || [], bids: book.bids || [] };
    // The user's requested size, HOISTED above selection: the speed-aware preference below
    // compares candidates on the EXECUTED amounts, which need the want. wantAtoms when the
    // caller has it (a retry / resume works from the RECORD; the composer input it would
    // otherwise read has already been cleared by resetComposer, which reads as 0 — and a 0
    // want used to size to the WHOLE offer).
    const want = (wantAtoms != null) ? BigInt(wantAtoms) : assetLegAtoms(route);
    let offer = bestFor(pool, side, _deadOffers);
    if (!offer || !(offer.price > 0)) return null;
    // === EXECUTABILITY BEFORE PRICE (mixed takes only) ====================================
    // An offer whose crossing this build cannot settle for THESE rails (e.g. an asset-over-LN
    // maker matched by a receive-on-chain taker) is not a candidate at any price — letting it
    // win the price sort turned the whole take into a refusal while a perfectly executable
    // maker rested one row down (seen live). Executability is decided by the SAME predicates
    // Review enforces (planSettlement happy-coincidence / bridgedTakeSupported), so nothing
    // is selected here and refused later. When a better-priced unexecutable offer is passed
    // over, the quote line says so instead of silently hiding the price.
    const mixedSel = payRail !== recvRail;
    const executableFor = (o) => {
      try {
        const { makerBtcRail: mb, makerAssetRail: ma } = makerRailsFromOffer(o);
        const t = { asset: route.seqAsset, side, payRail, recvRail,
          makerBtcRail: mb, makerAssetRail: ma, takerAssetInbound: false, takerBtcInbound: false };
        return planSettlement(matchFromTake(t)).happyCoincidence || bridgedTakeSupported(t);
      } catch { return false; }
    };
    let betterOtherRails = false;
    if (mixedSel && !executableFor(offer)){
      const passedOver = offer;
      const sideList = side === 'buy' ? (pool.asks || []) : (pool.bids || []);
      let alt = null;
      for (const o of sideList){
        if (!o || !(o.price > 0)) continue;
        if (o.id && _deadOffers.has(o.id)) continue;
        if (!executableFor(o)) continue;
        if (want > 0n){
          const szo = sizeSubswapTake({ want, offerAtoms: BigInt(o.assetAtoms || 0),
            offerBtc: BigInt(o.btcSats || 0), minFill: offerMinFill(o, o.raw || {}), side });
          if (szo.belowMin || !(szo.takeAtoms > 0n)) continue;
        }
        alt = o; break;
      }
      if (alt){
        // No price battle across executability: the executable maker IS the market for this
        // rail selection. Note when the passed-over price was strictly better on the amounts
        // this take would execute.
        betterOtherRails = bridgedBeatsExecuted(passedOver, alt, side, want);
        offer = alt;
      }
      // No executable candidate at all: keep the original pick so the existing honest
      // refusal downstream names the rails to switch — that message is still the truth.
    }
    // === SPEED-AWARE SELECTION PREFERENCE (mixed takes only; owner ruling) ================
    // When both a native-fast candidate (Sequentia speed) and a bridged-slow one (the LSP
    // maker-first pipeline: a Bitcoin-confirmation wait) can fill this take, prefer the
    // NATIVE maker whenever its price is EQUAL OR BETTER; a bridged offer is chosen over a
    // native one ONLY for a STRICTLY better price — compared on the EXECUTED amounts via the
    // same proportional math the take uses (bridgedBeatsExecuted), never a different rounding.
    // Selection only: settlement dispatch, fund-safety and the displayed==lifted invariant are
    // untouched (the review/execute paths re-derive the same deterministic pick from the same
    // book, so nothing resorts mid-flow after review). Applies only to the MIXED shapes
    // (payRail !== recvRail) — the same-rail routes never enter the bridge for speed reasons.
    const mixedTake = payRail !== recvRail;
    const speedOf = (o) => offerSettlesFast(o, { asset: route.seqAsset, side, payRail, recvRail });
    let speedFast = mixedTake ? speedOf(offer) : null;
    let fastAvailable = !!speedFast;
    if (mixedTake && !speedFast){
      // The book is price-sorted, so the FIRST usable fast candidate is the best-priced one.
      // A fast candidate that cannot fill the executed take (below its own minimum for this
      // want) is not a candidate at all and is passed over.
      const sideList = side === 'buy' ? (pool.asks || []) : (pool.bids || []);
      let alt = null;
      for (const o of sideList){
        if (!o || !(o.price > 0)) continue;
        if (o.id && _deadOffers.has(o.id)) continue;
        if (!speedOf(o)) continue;
        if (want > 0n){
          const szo = sizeSubswapTake({ want, offerAtoms: BigInt(o.assetAtoms || 0),
            offerBtc: BigInt(o.btcSats || 0), minFill: offerMinFill(o, o.raw || {}), side });
          if (szo.belowMin || !(szo.takeAtoms > 0n)) continue;
        }
        alt = o; break;
      }
      if (alt){
        fastAvailable = true;
        if (!bridgedBeatsExecuted(offer, alt, side, want)){ offer = alt; speedFast = true; }
      }
    }
    const { makerBtcRail, makerAssetRail } = makerRailsFromOffer(offer);
    const take = { asset: route.seqAsset, side, payRail, recvRail,
      makerBtcRail, makerAssetRail, takerAssetInbound: false, takerBtcInbound: false };   // false => the LSP JIT-provisions (always safe)
    const match = matchFromTake(take);
    const plan = planSettlement(match);
    const crosses = !plan.happyCoincidence;
    // P3.2 — CAPABILITY PRE-CHECK. A crossing that the LSP's bridge does NOT settle (any shape but the ONE
    // wired: taker-sells-asset / receives-BTC-over-LN vs an on-chain reverse maker) must NOT be promised as
    // a bridge in Review — the SHARED pure predicate (identical to the LSP's /swap admission) decides, so
    // there is never a Review that fails post-confirm. Unsupported -> bridged:false, so onReview FALLS BACK
    // to the native/on-chain path at the same price (never a dead-end promise).
    const supported = crosses && bridgedTakeSupported(take);
    // SUBMARINE = a P2P submarine settlement (an interactive maker that accepts BTC-LN). This selects the
    // settlement PATH only — it is INVISIBLE to the user and NEVER changes the matched offer or the fill.
    // An offer is partial-fillable down to its EFFECTIVE min_fill; a whole-offer-only maker
    // (allow_partial:false) has an effective minimum of the FULL size. See offerMinFill.
    const submarine = crosses && chooseSettlementPath(match, (offer && offer.meta) || {}).path === 'p2p-submarine';
    // SIZE THE TAKE to the USER's composer amount, RAIL-BLIND, via the SHARED sizeSubswapTake authority
    // (subswap.js) so every entry point (on-chain preview, LN preview, P2P submarine review, LSP payer/receiver
    // bridge review) agrees on takeAtoms/takeBtc. An offer is partial-fillable down to its EFFECTIVE minimum,
    // which for a whole-offer-only maker (allow_partial:false) is the FULL size — see offerMinFill. A request
    // below the minimum returns the MINIMUM (belowMin) so pay & receive never disagree. BTC is CEIL'd
    // (the maker is never underpaid). The LSP + maker re-verify every amount and fail closed on any mismatch.
    const offerAtoms = BigInt(offer.assetAtoms || 0), offerBtc = BigInt(offer.btcSats || 0);
    const raw = offer.raw || {};
    const sz = sizeSubswapTake({ want, offerAtoms, offerBtc, minFill: offerMinFill(offer, raw), side });
    // THE WALK. The single-offer sizing above stays as the per-leg authority and the
    // fallback; this plans the FULL fill across the book in price order, so a request
    // larger than the best offer reaches the depth behind it instead of being capped
    // at the top of the book.
    //
    // Only offers this shape can actually settle are walked: matching is price-first
    // across the whole book, but a leg still has to be settleable, and promising a
    // fill we cannot execute is the offer-then-refuse failure. Same-rail-as-best is
    // the honest filter today — a walk that silently changed settlement path halfway
    // would be a different trade than the one reviewed.
    const sideOffers = (side === 'buy' ? (pool.asks || []) : (pool.bids || []))
      .filter(o => o && o.price > 0 && o.rail === offer.rail);
    const walk = walkBook({ offers: sideOffers, want, side });
    return { side, offer, match, plan, describe: describeBridge(match), bridged: crosses && supported,
      crosses, supported, betterOtherRails, makerBtcRail, makerAssetRail, submarine,
      takeAtoms: sz.takeAtoms, takeBtc: sz.takeBtc, want, partial: sz.partial,
      belowMin: sz.belowMin, minAtoms: sz.minAtoms, minBtc: sz.minBtc, capped: sz.capped,
      walk, offers: sideOffers,
      // Speed class of the CHOSEN offer for these rails (mixed takes only; null otherwise),
      // and whether ANY fast candidate could fill this take — the quote-line note fires only
      // when the ONLY candidates are bridged-slow (speedClass 'slow' + !fastAvailable).
      speedClass: mixedTake ? (speedFast ? 'fast' : 'slow') : null,
      fastAvailable: mixedTake ? fastAvailable : null,
      overshoot: false, wholeOnly: false };
  } catch (e){
    // NEVER swallow this silently. A bare catch here made a node outage, an
    // unreachable LSP and a genuine planning bug all present identically as
    // "could not reach the order book", which cost real diagnosis time. The
    // return value stays null (callers fall back honestly), but the reason is
    // recorded so the next failure is one console line instead of a bisect.
    console.warn('[book] take plan failed:', e);
    _lastPlanError = (e && e.message) || String(e);
    return null;
  }
}
// The last reason bridgedTakePlan bailed, for the composer's diagnostics.
let _lastPlanError = null;
// Set when the ONLY thing missing is the user's rail choice.
let _railsUnset = false;

async function reviewBridged(route, bp){
  const { $ } = C;
  if (!L || !L.swap){ $('swErr').textContent = 'This trade could not be placed right now - try again shortly.'; return; }
  // IN-FLIGHT GUARD: block on BOTH a bridge AND a P2P subswap in flight — two concurrent rail-crossings can't
  // start (a p2p subswap in flight blocks a receiver-bridge sell, and vice-versa; each recovers via ONE key).
  try { reapStalledCrossings(); } catch {}
  // Ask the LSP before refusing. A record whose job the LSP has already failed must
  // never block a new trade — that turned one dead take into a wallet that refused
  // every subsequent one, with the user told to finish something that could not be
  // finished. Awaited (not fire-and-forget) so the very first press re-checks.
  try { await reconcileJobStatus(true); } catch {}
  if (!tradeSlotsFree()){ $('swErr').textContent = inFlightBlockMessage(); return; }
  const am = C.assetMeta(route.seqAsset) || {};
  const aprec = am.precision || 0, tk = am.ticker || 'asset';
  // P3.1 — FORMATTED units, never raw atoms/sats, and the SIZED take (bp.takeAtoms/takeBtc), never the
  // whole resting offer. A partial fill of a larger offer is stated so the Review == what executes (§6).
  // Review states what EXECUTES. With a walk that is the aggregate across legs, not
  // the best offer's numbers — a Review that names one offer for a fill spanning
  // several would not match what happens.
  const w = bp.walk && bp.walk.offersUsed > 1 && bp.walk.filledAtoms > 0n ? bp.walk : null;
  const takeAtoms = BigInt((w ? w.filledAtoms : bp.takeAtoms) || 0);
  const takeBtcAtoms = BigInt((w ? w.filledBtc : bp.takeBtc) || 0);
  const takeAssetStr = C.fmtAtoms(takeAtoms, aprec) + ' ' + tk;
  const takeBtcStr = C.fmtAtoms(takeBtcAtoms, 8) + ' BTC';
  const offerAssetStr = C.fmtAtoms(BigInt(bp.offer.assetAtoms || 0), aprec) + ' ' + tk;
  const pricing = bp.side === 'buy'
    ? `Pay ${takeBtcStr}, receive ${takeAssetStr}.`
    : `Sell ${takeAssetStr}, receive ${takeBtcStr}.`;
  const partialNote = w
    ? ` Filled across ${w.offersUsed} resting offers, best price first.` +
      (w.remainderAtoms > 0n ? ` ${C.fmtAtoms(w.remainderAtoms, aprec)} ${tk} cannot fill right now and will not be rested.` : '')
    : (bp.partial ? ` Partial fill of a larger resting offer (${offerAssetStr}).` : '');
  // The Review shows ONLY the user's own legs (what they pay / receive) + a plain reassurance — never any of
  // the settlement machinery that carries the trade to completion.
  const kv = [
    ['Direction', bp.side === 'buy' ? `Buy ${tk} with Bitcoin` : `Sell ${tk} for Bitcoin`],
    ['You trade', `${pricing}${partialNote}`],
    ['Your funds', 'Your funds stay in your control until this completes.'],
    // ROUTING HONESTY (owner ruling): the receiver leg-bridge also runs the maker-first
    // pipeline (the LSP fronts only after the on-chain BTC leg it recoups from confirms on
    // testnet4) — the class is stated BEFORE Confirm, always.
    ['Speed', SPEED_SLOW_NOTE],
  ];
  // Below-minimum guard (defense-in-depth; the composer already blocks Place): the request is under this
  // offer's minimum fill, so show the true minimum plainly and BLOCK Place — never lift more than asked.
  if (bp.belowMin){
    const minStr = C.fmtAtoms(BigInt(bp.minAtoms || 0), aprec) + ' ' + tk;
    const minBtcStr = C.fmtAtoms(BigInt(bp.minBtc || 0), 8) + ' BTC';
    kv.splice(2, 0, ['Smallest amount', `The smallest amount you can ${bp.side === 'buy' ? 'buy' : 'sell'} here is ${minStr} (${minBtcStr}).`]);
  }
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  if (bp.belowMin){
    ok.disabled = true; ok.textContent = 'Enter at least the minimum';
    if (st) st.textContent = 'Increase the amount to the minimum shown, then place the order.';
    return;
  }
  // Capture the rails BEFORE resetComposer blanks S — the record needs the rails of the
  // order as PLACED, and everything that re-plans later (resume, retry) reads them from it.
  ok.onclick = async () => { const rails = { payRail: S.payRail, recvRail: S.recvRail };
    modal.remove(); resetComposer(); await startBridged(route, bp, rails); };
}

// Persist BEFORE the /swap POST (persist-before-broadcast): a lost 202 + retry (or a restart) re-POSTs
// with the SAME swap_nonce, which the LSP dedupes to ONE job — never a second funded HTLC.
async function startBridged(route, bp, rails){
  if (_bridgeStarting || !tradeSlotsFree()){ try { C.toast && C.toast(inFlightBlockMessage()); } catch {} return; }
  _bridgeStarting = true;
  try {
    const asset = route.seqAsset;
    const swap_nonce = newSwapNonce();
    // P3.1 — persist the SIZED take (bp.takeAtoms/takeBtc), never the whole offer, so the /swap body,
    // the maker handshake bind, and any resume all use the user's requested size (§2.4).
    BRIDGE = { state: 'starting', swap_nonce, asset, side: bp.side,
      payRail: (rails && rails.payRail) || S.payRail, recvRail: (rails && rails.recvRail) || S.recvRail,
      maker_btc_rail: bp.makerBtcRail, maker_asset_rail: bp.makerAssetRail,
      btc_sats: String(bp.takeBtc), asset_atoms: String(bp.takeAtoms), partial: !!bp.partial,
      offer_id: bp.offer.id || null, maker_pubkey: bp.offer.maker || null, offer_attempts: 1, started_ms: Date.now() };
    // W2 FRONT-BEFORE-FUND — mint the taker's OWN asset-refund key NOW (self-custody): only its PUBKEY goes
    // to the LSP (in the /swap handshake, so the maker binds it); the SECRET never leaves the device and is
    // what refunds the asset at T_seq if the swap stalls. Deterministic (the canonical HTLC key), so a
    // resume re-derives the same key.
    try { const rk = C.seqLeg.refundKey(); BRIDGE.taker_seq_refund_pub = rk.public_key; BRIDGE.taker_seq_refund_secret = rk.secret_hex; } catch {}
    saveBridge();
    // Taker node keys for the LN legs / JIT (device-cosigned; the LSP never holds the keys).
    try { BRIDGE.node_key = await L.assetNodeKey(asset); } catch {}
    try { BRIDGE.btc_node_key = await L.btcNodeKey(); } catch {}
    saveBridge();
    const r = await L.swap(bridgeSwapBody(BRIDGE));
    applyBridgeStatus(r || {}); saveBridge();
    if (!bridgeTerminal()) driveBridged();
    else if (BRIDGE.state === 'settled'){ try { C.toast('Swap settled.'); } catch {} try { await C.sync(); } catch {} }
  } catch (e){
    console.warn('[bridge] start error:', e);   // technical detail stays in the console; the UI shows only a plain sentence
    // A thrown /swap that already handed back a job handle stays drivable (each leg is refundable at its
    // timeout); with no handle it is a clean failure (nothing funded).
    if (BRIDGE && (BRIDGE.poll || BRIDGE.job_id)){ BRIDGE.detail = 'This trade could not be completed - your funds are safe.'; saveBridge(); driveBridged(); }
    else { BRIDGE = { ...(BRIDGE || {}), state: 'failed', detail: 'This trade could not be completed - your funds are safe.' }; saveBridge(); }
  } finally { _bridgeStarting = false; }
}

// Is this handshake failure one where the LSP provably funded NOTHING, and where a
// DIFFERENT maker could plausibly succeed?
//
// Deliberately a whitelist, not a blacklist. Retrying is only safe where nothing moved,
// and only USEFUL where the fault is the maker's or the relay's — a malformed request
// of ours (missing hash_h, no btc_sats bound) fails identically against every offer, so
// walking the book would just burn the whole book on our own bug and report the last
// maker's error instead of the real one.
const RETRYABLE_HANDSHAKE = [
  /lift in progress/i,          // the relay still holds a session for a maker that is gone
  /offer not found or not open/i,
  /offer already filled/i,
  /another lift is in flight/i,
  /min_fill/i,                  // below THIS offer's minimum; another may have a lower one
  /maker wants .* above the offered/i,
  /maker delivers .* below the offered/i,
  /timed out|timeout/i,         // an unresponsive maker; nothing was funded
  /never arrived|no response|did not respond/i,   // a maker that is simply GONE — see below
  /relay did not accept the lift/i,
  /could not reach the order-book relay/i,
  /handshake failed/i,          // generic maker-side failure, still pre-fund
];
// NOTE ON "never arrived": this is the single most common real-world failure, and the
// first version of this whitelist missed it — so the case it most needed to cover fell
// straight through. A resting offer outlives the maker process that posted it (the
// relay holds it until expiry), so lifting a dead maker's offer produces no refusal at
// all, just silence until the terms wait expires. That is a maker that is GONE, nothing
// was funded, and the next offer is very likely fine.
function retryableHandshakeFailure(why){
  const w = String(why || '');
  // Never retry when the LSP told us the request itself was unusable.
  if (/needs hash_h|needs taker_seq_claim_pub|needs offer_id|needs btc_sats|not configured|REFUSED/i.test(w)) return false;
  return RETRYABLE_HANDSHAKE.some(re => re.test(w));
}

const BRIDGE_MAX_OFFER_ATTEMPTS = 4;

// Move a pre-commitment bridge onto the next-best offer, re-pricing for THAT offer.
// Returns true if a retry was started. The amounts are recomputed from the new offer
// rather than carried over: each offer has its own price, and the maker's bind check
// refuses on any mismatch.
function advanceBridgeToNextOffer(b, why){
  try {
    if (!b || b.fronted || b.relayed || b.seq_redeem) return false;   // never past commitment
    const attempts = Number(b.offer_attempts || 1);
    if (attempts >= BRIDGE_MAX_OFFER_ATTEMPTS) return false;
    markOfferDead(b.offer_id, why);
    // Rebuild the route from the RECORD, not from composer state: the user may have
    // retyped the composer since placing this order, and re-planning against whatever
    // is on screen now would quietly retry a DIFFERENT trade than the one they placed.
    const route = { seqAsset: b.asset, payIsBtc: b.side === 'buy' };
    // bridgedTakePlan reads the rails from composer state, so only retry while those
    // still match the order as placed. If they have moved on, fail plainly instead of
    // silently re-pricing on rails the user did not choose for this trade.
    const bp = bridgedTakePlan(route, { payRail: b.payRail, recvRail: b.recvRail }, BigInt(b.asset_atoms || 0));
    if (!bp || !bp.offer || !bp.offer.id || bp.offer.id === b.offer_id) return false;
    if (!(BigInt(bp.takeAtoms || 0) > 0n) || !(BigInt(bp.takeBtc || 0) > 0n)) return false;
    console.warn('[bridge] retrying on the next offer (' + bp.offer.id + ') after:', why);
    const keep = { swap_nonce: newSwapNonce(), asset: b.asset, side: b.side,
      payRail: b.payRail, recvRail: b.recvRail,
      taker_seq_refund_pub: b.taker_seq_refund_pub, taker_seq_refund_secret: b.taker_seq_refund_secret,
      node_key: b.node_key, btc_node_key: b.btc_node_key, started_ms: b.started_ms };
    BRIDGE = { ...keep, state: 'starting',
      maker_btc_rail: bp.makerBtcRail, maker_asset_rail: bp.makerAssetRail,
      btc_sats: String(bp.takeBtc), asset_atoms: String(bp.takeAtoms), partial: !!bp.partial,
      offer_id: bp.offer.id, maker_pubkey: bp.offer.maker || null,
      offer_attempts: attempts + 1,
      detail: 'Finding another maker for this trade…' };
    saveBridge();
    // Fresh handshake against the new maker; driveBridged re-enters from the top.
    (async () => {
      try {
        const r = await L.swap(bridgeSwapBody(BRIDGE));
        applyBridgeStatus(r || {}); saveBridge();
        if (!bridgeTerminal()) driveBridged();
      } catch (e){
        console.warn('[bridge] retry start error:', e);
        if (BRIDGE && !bridgeTerminal()){
          BRIDGE.state = 'failed';
          BRIDGE.detail = 'This trade could not be placed right now - try again shortly.';
          saveBridge();
        }
      }
    })();
    return true;
  } catch (e){ console.warn('[bridge] retry planning error:', e); return false; }
}

// The exact bridged-take /swap body — ONE builder so start + resume send byte-identical requests (so the
// swap_nonce idempotency holds on a resume re-POST). taker_seq_refund_pub is the taker's OWN asset-refund
// KEY (pubkey only) — the maker binds it at handshake and the taker later funds its asset HTLC refundable
// to it. Byte-identical across start + resume (the key is deterministic + persisted).
function bridgeSwapBody(b){
  return { side: b.side, asset: b.asset, amount: b.asset_atoms, bridge: true,
    payRail: b.payRail, recvRail: b.recvRail, maker_btc_rail: b.maker_btc_rail, maker_asset_rail: b.maker_asset_rail,
    btc_sats: b.btc_sats, asset_atoms: b.asset_atoms, offer_id: b.offer_id, maker_pubkey: b.maker_pubkey,
    node_key: b.node_key, btc_node_key: b.btc_node_key, taker_asset_inbound: false, taker_btc_inbound: false,
    taker_seq_refund_pub: b.taker_seq_refund_pub, swap_nonce: b.swap_nonce };
}
function applyBridgeStatus(r){
  if (!BRIDGE) return;
  if (r.job_id) BRIDGE.job_id = r.job_id;
  if (r.poll) BRIDGE.poll = r.poll;
  if (r.settlement_plan) BRIDGE.settlement_plan = r.settlement_plan;
  if (r.status === 'settled' || r.settled){
    const wasSettled = BRIDGE.state === 'settled';
    BRIDGE.state = 'settled';
    // RECORD THE TRADE. A bridged take moved real value and then left no trace: the LSP log showed the
    // full cycle ("fronted asset leg CLAIMED by the taker — P read on-chain; settling our held invoice")
    // while the wallet's history stayed exactly as it was. A settled trade the user cannot see in their
    // own history is indistinguishable from one that never happened. Keyed on the swap hash so a
    // re-poll upgrades the same row rather than appending a duplicate.
    if (!wasSettled){
      try {
        const bm = metaOf(BRIDGE.asset) || {};
        const aprec = bm.precision || 0;
        const assetU = Number(big(BRIDGE.asset_atoms || 0)) / Math.pow(10, aprec);
        const btcU = Number(big(BRIDGE.btc_sats || 0)) / 1e8;
        const sell = BRIDGE.side === 'sell';
        logTrade({ id: 'bridge:' + (BRIDGE.hash_h || BRIDGE.job_id || BRIDGE.swap_nonce || ''),
          title: (sell ? 'Sold ' : 'Bought ') + (bm.ticker || 'asset') + (sell ? ' for BTC' : ' with BTC'),
          status: 'settled', rail: 'bridged', pair: (bm.ticker || 'asset') + '/BTC',
          side: sell ? 'sell' : 'buy', size: assetU || null, sizeTicker: bm.ticker || null,
          price: (assetU > 0) ? btcU / assetU : null,
          card: true,   // task 21b: genuine settlement -> settle card
          elapsed_ms: (BRIDGE.started_ms > 0) ? (Date.now() - BRIDGE.started_ms) : null });
      } catch {}
    }
  }
  else if (r.status === 'failed' || (r.ok === false && !(r.poll || r.job_id))){ BRIDGE.state = 'failed'; if (r.error || r.reason){ try { console.warn('[bridge] failure detail:', r.error || r.reason); } catch {} } BRIDGE.detail = failDetail(r.error || r.reason); }
  else if (BRIDGE.state === 'starting') BRIDGE.state = 'confirming';
}

// ===========================================================================
// W2 FRONT-BEFORE-FUND — the wallet driver for a bridged SELL (taker sells the asset, receives BTC over
// Lightning). The LSP fronts the taker's BTC-LN hold BEFORE the taker exposes any asset, so a declined or
// undriven front strands NOTHING (the taker funds its asset only after it is guaranteed payment).
//
//   0. POST /swap {bridge:true, taker_seq_refund_pub}                (handshake; persist-before-broadcast)
//   1. poll GET /swap/<id> -> learn H + maker asset-claim pub + T_seq (bridge_terms)
//   2. register a HODL hold on H at our OWN BTC-LN node (recv_node_id) — nothing exposed yet
//   3. POST /bridge/front (hold-ready) -> the LSP fronts as soon as its recoup is secured
//   4. poll GET /swap/<id> until status 'fronted' AND our hold is 'accepted' (verified on OUR node)
//   5. ONLY THEN fund our OWN asset HTLC self-custody (claim=maker-with-P, refund=us-after-T_seq)
//   6. POST /bridge/asset -> the LSP relays it (it REJECTS unless already fronted)
//   7. read P off the maker's on-chain claim (trustless), verify sha256(P)==H, settle our hold -> receive BTC
//
// Every step is idempotent + persisted, so a reload re-enters at the right step. Each internal poll is
// bounded and returns to the re-drive scheduler, so long anchor-gated waits never block a single call.
// ===========================================================================
let _bridgePoll = null;
let _bridgeDriving = false;
const bsleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pre-front budget: nothing of the taker's is committed before the front, so if the LSP never fronts
// within this (the maker BTC HTLC never confirms, or the locktime gate refuses), give up NO-LOSS.
const BRIDGE_FRONT_TIMEOUT_MS = 45 * 60 * 1000;

async function driveBridged(){
  if (!BRIDGE || bridgeTerminal() || _bridgeDriving) return;
  if (!(L && L.swap && L.swapStatus)){ clearTimeout(_bridgePoll); _bridgePoll = setTimeout(driveBridged, 15000); return; }
  _bridgeDriving = true;
  try { await bridgedSteps(); }
  catch (e){ console.warn('[bridge] drive error:', e); if (BRIDGE && !bridgeTerminal()){ BRIDGE.detail = failDetail(e); saveBridge(); } }
  finally { _bridgeDriving = false; }
  if (BRIDGE && bridgeTerminal()){
    if (BRIDGE.state === 'settled'){
      clearDeadOffers();   // the book is evidently working; stop carrying old exclusions
      try { C.toast('Swap settled · you received Bitcoin over Lightning.'); } catch {} try { await C.sync(); } catch {} }
  } else if (BRIDGE){
    clearTimeout(_bridgePoll); _bridgePoll = setTimeout(driveBridged, 8000);   // self-heal a transient gap / advance a long wait
  }
}

async function bridgedSteps(){
  const b = BRIDGE, asset = b.asset;
  const status = () => L.swapStatus(b.poll || b.job_id).catch(() => null);

  // 0. Ensure the handshake job exists (nonce idempotency dedupes a lost 202 to ONE job — never a 2nd HTLC).
  if (!b.job_id){
    const r = await L.swap(bridgeSwapBody(b)); applyBridgeStatus(r || {}); saveBridge();
    if (bridgeTerminal() || !b.job_id) return;
  }

  // 1. Learn H + the maker's asset-claim terms + T_seq from the LSP handshake (bridge_terms).
  if (!b.hash_h){
    for (let i = 0; i < 40 && !b.hash_h; i++){
      const j = await status();
      if (j && j.bridge_terms && j.bridge_terms.hash_h){
        const t = j.bridge_terms;
        b.hash_h = String(t.hash_h).toLowerCase(); b.maker_seq_claim_pub = t.maker_seq_claim_pub;
        b.seq_locktime = Number(t.seq_locktime); b.seq_amount = String(t.seq_amount ?? b.asset_atoms);
        b.btc_amount = String(t.btc_amount ?? b.btc_sats); b.btc_htlc_txid = t.btc_htlc_txid || null;
        // W2 HOLD-LIFE vs T_seq — the LSP sized (and bounded) how long our BTC-LN hold must stay settleable
        // (hold_expiry_secs) and how much CLTV runway the front HTLC needs (hold_min_final_cltv), from T_seq +
        // the live seq tip. We mint the hold with that expiry (step 2) and hand the CLTV to /bridge/front (step
        // 3) so our hold cannot lapse before the maker's latest asset claim (which would strand us — dead hold,
        // asset gone). seq_tip is the tip these were sized against.
        b.hold_expiry_secs = Number(t.hold_expiry_secs) || 0; b.hold_min_final_cltv = Number(t.hold_min_final_cltv) || 0;
        b.seq_tip = Number(t.seq_tip) || 0;
        b.state = 'confirming'; saveBridge(); break;
      }
      if (j && (j.status === 'failed' || (j.bridgeHandshake && j.bridgeHandshake.ok === false))){
        const why = String((j.bridgeHandshake && j.bridgeHandshake.error) || j.error || '');
        console.warn('[bridge] handshake failed:', why);
        // RETRY DOWN THE BOOK. This branch is reached only BEFORE anything is funded —
        // the LSP says so explicitly ("fail closed (nothing funded)") — so taking a
        // different offer here risks nothing of the user's.
        //
        // It matters because a resting offer can outlive the maker process serving it:
        // the relay keeps the offer until expiry, so a dead maker sits at top-of-book
        // refusing every lift, and with no way past it EVERY take on that pair failed
        // instantly until it expired. The on-chain cross path has had this retry
        // (xswap.js T4); the bridged path never got it.
        if (retryableHandshakeFailure(why) && advanceBridgeToNextOffer(b, why)) return;
        b.state = 'failed'; b.detail = 'This trade could not be placed right now - try again shortly.'; saveBridge(); return;
      }
      await bsleep(3000);
    }
    if (!b.hash_h) return;   // still confirming -> the scheduler re-enters
  }

  // 2. Register a HODL hold on H at our OWN BTC-LN node so the LSP's front lands HELD; capture recv_node_id.
  //    Nothing of ours is exposed by this (an unused hold just expires). Bring the BTC node online + best-
  //    effort inbound first (we RECEIVE BTC over Lightning).
  if (!b.recv_node_id){
    // FUND-SAFETY (hold-life vs T_seq): mint the hold with an expiry that keeps it SETTLEABLE until strictly
    // AFTER the maker's latest possible asset claim (T_seq) + reorg/settle margin. The LSP sized + bounded this
    // from T_seq at handshake (bridge_terms.hold_expiry_secs). If it is absent or non-positive we have no safe
    // hold life -> FAIL CLOSED (nothing of ours is exposed yet: an under-sized hold would let the maker wait
    // for it to lapse, then reveal P and take the asset while our dead hold collects nothing).
    if (!(Number(b.hold_expiry_secs) > 0)){ b.state = 'failed'; b.detail = 'This trade could not be placed right now - try again shortly.'; saveBridge(); return; }
    if (L.connectBtcNode){ const prov = await L.connectBtcNode(); if (!(prov && prov.connected)) throw new Error('This trade could not be placed right now - try again shortly.'); }
    if (L.channelInbound){ try { await L.channelInbound({ node_key: b.btc_node_key, amount: Number(b.btc_amount) }); } catch {} }
    const inv = await L.nodeInvoice({ node_key: b.btc_node_key, amount: Number(b.btc_amount), payment_hash: b.hash_h, expiry: Math.ceil(Number(b.hold_expiry_secs)) });
    if (!(inv && inv.node_id)) throw new Error('This trade could not be placed right now - try again shortly.');
    b.recv_node_id = inv.node_id; saveBridge();
  }

  // 3. Arm the LSP front (hold-ready). Idempotent — a re-post just re-affirms the node id. Hand the front HTLC
  //    min-final-CLTV so the CLTV carrying the LSP's payment also spans the hold life to T_seq (FIX 1/3).
  if (!b.front_armed){
    const r = await L.bridgeFront({ job_id: b.job_id, recv_node_id: b.recv_node_id, recv_min_final_cltv: Number(b.hold_min_final_cltv) || undefined });
    if (!(r && r.ok)){ console.warn('[bridge] front-arm refused:', (r && r.error) || 'unknown'); throw new Error('This trade could not be placed right now - try again shortly.'); }
    b.front_armed = true; saveBridge();
  }

  // 4. WAIT for the LSP to actually front: status 'fronted' AND our OWN hold is 'accepted' (we verify on our
  //    node, never trusting the status alone). Only when BOTH hold do we expose the asset. Pre-front budget:
  //    if it never fronts (maker BTC HTLC never confirms / locktime gate refuses), give up NO-LOSS.
  if (!b.fronted){
    for (let i = 0; i < 40 && !b.fronted; i++){
      const j = await status();
      if (j && (j.status === 'settled' || j.settled)){ b.fronted = true; b.state = 'fronted'; saveBridge(); break; }
      if (j && j.status === 'failed'){ console.warn('[bridge] front failed:', j.error); b.state = 'failed'; b.detail = failDetail(j.error); saveBridge(); return; }
      const fronted = j && (j.status === 'fronted');
      let held = false;
      try { const s = await L.invoiceStatus({ node_key: b.btc_node_key, payment_hash: b.hash_h }); held = !!(s && (s.held || s.settled)); } catch {}
      if (fronted && held){ b.fronted = true; b.state = 'fronted'; saveBridge(); break; }
      if (Date.now() - (b.started_ms || 0) > BRIDGE_FRONT_TIMEOUT_MS){ b.state = 'failed'; b.detail = 'This trade could not be completed - your funds are safe.'; saveBridge(); return; }
      await bsleep(3000);
    }
    if (!b.fronted) return;   // not fronted yet -> the scheduler re-enters (still within budget)
  }

  // 4.5 FUND-SAFETY — verify the ACTUAL committed front HTLC CLTV covers T_seq (never trust the value we
  //     REQUESTED). The LSP routes our front by BARE HASH; getroute may commit a SHORTER final CLTV than we
  //     asked for (route ceilings / intermediate policy). Before exposing ANY asset, read the real incoming
  //     hold-HTLC expiry (block height) off OUR OWN node (via the LSP's invoice-status, which surfaces it from
  //     listhtlcs) and require its wall-clock runway to reach past the maker's LATEST asset claim (T_seq) +
  //     reorg/settle margin. If it is short (or unreadable), FAIL CLOSED — nothing of ours is exposed yet, so
  //     refusing is no-loss; an under-covered front would let the maker wait for it to lapse then claim our
  //     asset (dead hold, asset gone). The independent requirement is sized here from T_seq with the SAME
  //     constants leg-bridge.js HOLD_LIFE_DEFAULTS uses (seq 90s/block slow, front 150s/block FAST, reorg 2h,
  //     settle 30m, +6 CLTV margin), and we also demand at least the LSP-committed hold_min_final_cltv.
  if (!b.front_cltv_ok){
    let s = null; try { s = await L.invoiceStatus({ node_key: b.btc_node_key, payment_hash: b.hash_h }); } catch {}
    const inCltv = Number(s && s.htlc_expiry), btcTip = Number(s && s.btc_tip);
    if (!(Number.isFinite(inCltv) && Number.isFinite(btcTip))){
      b.state = 'failed'; b.detail = 'This trade could not be completed - your funds are safe.'; saveBridge(); return;
    }
    const actualCltvBlocks = inCltv - btcTip;
    // Independent requirement from T_seq (a stale handshake tip only makes the window LARGER = more conservative);
    // if the tip is somehow absent, fall back to the LSP-committed hold_min_final_cltv (still an actual-vs-committed
    // check, never blind trust). We demand the MAX of our own sizing and the LSP's committed runway.
    const haveTip = Number(b.seq_tip) > 0;
    const seqBlocks = haveTip ? Math.max(0, Number(b.seq_locktime) - Number(b.seq_tip)) : 0;
    const requiredSecs = seqBlocks * 90 + 7200 + 1800;   // HOLD_LIFE_DEFAULTS: seq 90s/block, reorg 2h, settle 30m
    const requiredBlocks = Math.max(haveTip ? Math.ceil(requiredSecs / 150) + 6 : 0, Number(b.hold_min_final_cltv) || 0);
    if (!(requiredBlocks > 0) || !(actualCltvBlocks >= requiredBlocks)){
      b.state = 'failed'; b.detail = 'This trade could not be completed - your funds are safe.'; saveBridge(); return;
    }
    b.front_cltv_ok = true; saveBridge();
  }

  // 5. NOW fund our OWN asset HTLC self-custody (claim=maker-with-P, refund=us-after-T_seq) — the asset is
  //    exposed only AFTER the front, so a failure here strands nothing beyond a refundable-at-T_seq HTLC.
  if (!(b.seq_leg && b.seq_leg.txid)){
    await fundBridgedAssetLeg();
    if (!(b.seq_leg && b.seq_leg.txid)) return;
  }

  // 6. Hand the FUNDED asset leg to the LSP -> it relays to the maker (it REJECTS unless already fronted).
  if (!b.relayed){
    const r = await L.bridgeAsset({ job_id: b.job_id, recv_node_id: b.recv_node_id,
      taker_seq_leg: { txid: b.seq_leg.txid, vout: b.seq_leg.vout, amount: b.seq_leg.amount,
        redeem_script: b.seq_leg.redeem_script, locktime: b.seq_locktime, asset, block_hash: b.seq_leg.block_hash || null } });
    if (!(r && r.ok)){ try { console.warn('[bridge] relay refused:', (r && r.error) || 'unknown'); } catch {} throw new Error('This trade could not be completed - your funds are safe.'); }
    b.relayed = true; b.state = 'relaying'; saveBridge();
  }

  // 7. Settle: read P off the maker's on-chain claim (trustless), verify sha256(P)==H, settle our hold ->
  //    receive the BTC over Lightning. P is also surfaced by the LSP (public_preimage) as a fallback.
  await settleBridged();
}

// Fund the asset HTLC (claim=maker-with-P, refund=us-after-T_seq) — the SAME construction the native
// cross-chain reverse flow (xrswap.js/fundSeq) uses (C.seqLeg + buildSeqHtlcRedeemScript). Persist-before-
// broadcast: the redeem + refund key are persisted BEFORE the funding tx, so a lost broadcast never strands
// the asset (findFundingByAddress recovers the outpoint on the next drive).
async function fundBridgedAssetLeg(){
  const b = BRIDGE;
  if (!(C.seqLeg && C.seqLeg.fund && C.seqLeg.waitConf && C.seqLeg.findFundingByAddress && C.wasm && C.wasm.buildSeqHtlcRedeemScript))
    throw new Error('This trade isn’t available in this build.');
  if (!b.taker_seq_refund_pub){ const rk = C.seqLeg.refundKey(); b.taker_seq_refund_pub = rk.public_key; b.taker_seq_refund_secret = rk.secret_hex; saveBridge(); }
  const redeem = C.wasm.buildSeqHtlcRedeemScript(b.hash_h, b.maker_seq_claim_pub, b.taker_seq_refund_pub, b.seq_locktime);
  b.seq_redeem = redeem; b.state = 'funding_asset'; saveBridge();   // persist reclaim material BEFORE broadcasting
  let txid = b.seq_fund_txid;
  if (!txid){
    const found = await C.seqLeg.findFundingByAddress(redeem).catch(() => null);   // strand-recovery for a lost broadcast
    txid = (found && found.txid) ? found.txid : (await C.seqLeg.fund(redeem, b.asset, BigInt(b.seq_amount))).txid;
    b.seq_fund_txid = txid; saveBridge();
  }
  const conf = await C.seqLeg.waitConf(txid, redeem);
  b.seq_leg = { txid, vout: conf.vout, redeem_script: redeem, amount: String(b.seq_amount),
    asset_id: b.asset, block_hash: conf.block_hash, height: conf.height };
  b.state = 'asset_funded'; saveBridge();
}

// Read P (trustless, off the maker's on-chain claim; LSP public_preimage as a fallback), verify sha256(P)==H,
// then settle our already-fronted hold with P -> we receive the BTC over Lightning. Bounded per call; the
// scheduler re-enters for the anchor-gated wait. On a resume where the LSP already recouped, short-circuit.
async function settleBridged(){
  const b = BRIDGE;
  if (b.state === 'relaying' || b.state === 'asset_funded') { b.state = 'settling'; saveBridge(); }
  const wantH = String(b.hash_h).toLowerCase();
  if (!b.preimage){
    for (let i = 0; i < 24 && !b.preimage; i++){
      const j = await L.swapStatus(b.poll || b.job_id).catch(() => null);
      if (j && (j.status === 'settled' || j.settled)){ /* the LSP recouped; still settle our hold below if needed */ }
      // Trustless: read P off our asset HTLC's on-chain spend (the maker's claim).
      let p = null;
      try { if (C.seqLeg.readSpendPreimage && b.seq_leg) p = await C.seqLeg.readSpendPreimage(b.seq_leg.txid, b.seq_leg.vout, wantH); } catch {}
      // Fallback: the LSP surfaces the on-chain-public P.
      if (!p && j){ const cand = j.public_preimage || j.relay_preimage || j.preimage; if (cand && await sha256HexHex(cand) === wantH) p = String(cand).toLowerCase(); }
      if (p && await sha256HexHex(p) === wantH){ b.preimage = String(p).toLowerCase(); saveBridge(); break; }
      await bsleep(5000);
    }
    if (!b.preimage) return;   // the maker has not claimed yet -> the scheduler re-enters
  }
  // Settle our BTC-LN hold with P (idempotent; a re-settle on an already-settled hold is a no-op) -> BTC in.
  try { await L.nodeSettle({ node_key: b.btc_node_key, payment_hash: b.hash_h, preimage: b.preimage }); } catch {}
  // Confirm receipt: our hold reads 'settled' (WE got the BTC). The LSP's own recoup is its concern, not ours.
  try { const s = await L.invoiceStatus({ node_key: b.btc_node_key, payment_hash: b.hash_h }); if (s && s.settled){ b.state = 'settled'; saveBridge(); return; } } catch {}
  const j = await L.swapStatus(b.poll || b.job_id).catch(() => null);
  if (j && (j.status === 'settled' || j.settled)){ b.state = 'settled'; saveBridge(); return; }
  // We have P and issued the settle; treat as settled (we hold P and the BTC HTLC is ours to collect).
  b.state = 'settled'; saveBridge();
}

// sha256 over a hex string -> hex (browser subtle crypto). Used to verify sha256(P)==H before settling.
async function sha256HexHex(hex){
  if (!/^[0-9a-fA-F]+$/.test(String(hex || '')) || String(hex).length % 2) return '';
  const bytes = new Uint8Array(String(hex).match(/.{2}/g).map((x) => parseInt(x, 16)));
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Resume a persisted bridged take on load: re-enter the driver, which re-derives the current step from the
// persisted BRIDGE and continues (re-POST is nonce-idempotent; every value-move step is guarded). Never
// funds twice; never re-exposes an asset before the front.
export async function resumeBridged(){
  if (!BRIDGE || bridgeTerminal()) return;
  driveBridged();
}

// ===========================================================================
// RAIL-CROSSING SETTLEMENT DISPATCH — P2P-first, LSP-fallback, BOTH directions.
// ---------------------------------------------------------------------------
// The rail crossing is always on the BTC leg (the asset leg is Sequentia on-chain). Its lnSide names who is
// on Lightning: 'payer' = the BUYER pays BTC over LN (a BUY), 'receiver' = the SELLER receives BTC over LN
// (a SELL). settlementDispatch reads the matched best-price offer's signed capability signals (unified-book
// meta.caps) and routes via the SHARED chooseSettlementPath:
//   • interactive maker that accepts BTC-LN -> a DIRECT peer-to-peer submarine (no LSP in the value path):
//     runTakerReverseSubmarine for a BUY (ln_direction 1), runTakerSubmarine for a SELL (ln_direction 0).
//   • else (on-chain-only / passive covenant) -> the LSP leg-bridge terminates the LN end (payer bridge for
//     a BUY via POST /bridge/hold; the existing receiver bridge, startBridged, for a SELL).
// Returns { path:'native'|'p2p-submarine'|'lsp-bridge', ln_direction, lnSide, offer, ...bp }, or null when
// there is no unified book / no resting offer (the caller then honest-disables Review for a shape that
// REQUIRES the bridge, never falling through to a doomed native submarine/422). PURE + defensive.
function settlementDispatch(route){
  try {
    const bp = bridgedTakePlan(route);
    if (!bp || !bp.offer) return null;
    const side = route.payIsBtc ? 'buy' : 'sell';
    const disp = chooseSettlementPath(bp.match, (bp.offer && bp.offer.meta) || {});
    let path = disp.path;
    // OFFER-THEN-REFUSE: a p2p-submarine / lsp-bridge whose crossing shape the LSP can't settle (the best
    // offer rests its asset over Lightning, so the asset leg ALSO crosses — no single on-chain asset HTLC)
    // is honest-disabled here as 'unsupported', never routed to a doomed native submarine / startMixed.
    // bp.supported == crossingShapeSupported (the shared authority, identical to the LSP's own admission).
    if ((path === 'p2p-submarine' || path === 'lsp-bridge') && !bp.supported) path = 'unsupported';
    return { ...bp, side, path, ln_direction: disp.ln_direction, lnSide: disp.lnSide };
  } catch { return null; }
}

// payerBridgeDisabledNote — the SINGLE honest-disable authority for the LSP PAYER leg-bridge (a rail-crossing
// BUY paying BTC over Lightning to an on-chain-only maker). That path needs the LSP to ISSUE a BTC-LN HOLD
// invoice on the taker's H, which the seqln node cannot yet mint (runLspPayerBridge also fails closed with
// ZERO exposure if ever reached). Until that node capability lands this shape must NEVER reach an enabled
// Place (offer-then-refuse), so EVERY entry point (requoteMixed, onReview, reviewMixed) surfaces THIS note and
// disables Review — one message, one gate, no path where a priced+enabled "Bridged buy" is offered then refused.
function payerBridgeDisabledNote(){
  // A genuine cannot-execute (this build lacks the capability to place this trade). Plain human reason — NO rail,
  // NO bridge/counterparty machinery, NO rail advice (the user must never be shown any of that).
  return 'This trade could not be placed right now - try again shortly.';
}

// --- chain read helpers (anchor depth + tips), same endpoints the wallet's watchers use ------------------
async function anchorHeightOf(blockHash){
  if (!blockHash) return null;
  try { const a = await fetch(location.origin + '/anchor/' + blockHash).then(r => r.ok ? r.json() : null); return a && a.anchorheight != null ? Number(a.anchorheight) : null; } catch { return null; }
}
async function btcTipHeight(){ try { const t = await fetch(location.origin + '/testnet4/api/blocks/tip/height').then(r => r.ok ? r.text() : null); return t != null ? parseInt(t.trim(), 10) : null; } catch { return null; } }
async function seqTipHeight(){ try { const t = await fetch(location.origin + '/api/blocks/tip/height').then(r => r.ok ? r.text() : null); return t != null ? parseInt(t.trim(), 10) : null; } catch { return null; } }
function randomSecretHex(){ const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }

// The subswap taker deps built from the wallet's own C.seqLeg / C.wasm primitives + the LSP `L` bridge. The
// SEQ-leg claim/fund/read + the anchor gate are the SAME primitives the native cross-chain flow uses; the
// BTC-LN pay/receive rides the user's OWN hosted BTC node (device-cosigned, the LSP never holds the key).
// max0ConfAtoms:0 => the taker ALWAYS waits the asset HTLC anchor-buries before its irreversible act
// (never fronts a Bitcoin-reorg risk to obtain P) — fund-safety over instant.
function subCommonDeps(){
  return {
    seqClaimKey: C.seqLeg.refundKey(),
    buildRedeem: (h, c, r, l) => C.wasm.buildSeqHtlcRedeemScript(h, c, r, l),
    htlcSpkHex: (redeem) => C.seqLeg.htlcSpkHex(redeem),
    readOutput: (txid, vout) => C.seqLeg.readOutput(txid, vout),
    // CONFIRMED-FUNDING + TXID-BOUND BLOCK: bind the anchor block to the ACTUAL funding txid's confirmed
    // status (never the maker-supplied leg.block_hash); verifySeqLeg / waitAnchorBuried fail closed unless the
    // funding tx is CONFIRMED — so a maker cannot pass a fake/mempool leg.
    txStatus: (txid) => C.seqLeg.txStatus(txid),
    anchorHeightOf: (bh) => anchorHeightOf(bh),
    btcTip: () => btcTipHeight(),
    seqTip: () => seqTipHeight(),
    sha256Hex: (hex) => sha256HexHex(hex),
    claimSeq: (p) => C.seqLeg.claim(p),
    // THE OFFER decides how much Bitcoin burial it wants, and 0 is the default every
    // maker on the book actually advertises. A hardcoded 3 here overrode all of them and
    // made a trade wait ~3 Bitcoin blocks — half an hour — behind copy promising
    // "final in ~1 block". A Sequentia block is final once it names a Bitcoin block; it
    // reverts only if Bitcoin reverts, and extra burial guards against nothing else.
    // Callers that hold the offer pass its figure; this is the floor for the ones that
    // do not, and the floor is what the makers ask for.
    minAnchorDepth: 0,
    max0ConfAtoms: 0,
  };
}

// The anchor burial THIS record's counterparty asked for. Persisted at take time from
// the offer, so a resumed trade honours the same figure the user agreed to rather than
// a constant compiled into the wallet.
function recordAnchorDepth(b){
  const n = Number(b && (b.min_anchor_depth ?? b.minAnchorDepth));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
// Bring the user's OWN hosted BTC-LN node online + return its node key (the counterpart of the asset node);
// the taker PAYS or RECEIVES BTC over Lightning through it. Idempotent (re-attaches without re-funding).
async function ensureBtcNodeKey(){
  if (L && L.connectBtcNode){ const p = await L.connectBtcNode(); if (!(p && p.connected)) throw new Error('Could not bring your Bitcoin Lightning node online · reopen the wallet and try again.'); }
  return await L.btcNodeKey();
}

// ===========================================================================
// P2P SUBMARINE + LSP PAYER BRIDGE — persisted, resumable taker driver.
// One localStorage record at a time (whole-HTLC): the asset leg is a real time-locked commitment, so an
// in-flight swap MUST survive a reload (else a crash between the irreversible act and the claim, or before a
// T_seq refund, strands funds). Fund-safety: P + the verified leg are persisted BEFORE the claim.
// ===========================================================================
// MORE THAN ONE TRADE AT A TIME.
//
// This was a single localStorage slot and a single module-level record, so the wallet
// could only ever hold one rail-crossing trade — every new take was refused while one
// was in flight, and a take that wedged locked the wallet out until it was cleared by
// hand. Nothing about the protocol needs that: each record already carries its OWN
// preimage, refund key, offer and leg, so two trades share no state that could collide.
// The limit was the storage shape, not the settlement.
//
// Records are now a LIST. Each gets an `id` at creation and is driven independently,
// so a stalled trade no longer blocks the next one and the Active-trades view shows
// them all. The legacy single-record slot is migrated on first load, so a trade that
// was in flight across the upgrade is preserved rather than orphaned with its funds.
const SUBSWAP_KEY = 'swk.sequentia.subswap';     // legacy single slot (read once, then migrated)
const SUBSWAPS_KEY = 'swk.sequentia.subswaps';
// ── Multi-tab safety for the per-trade stores ──────────────────────────────
// Each open wallet tab holds its own in-memory array and used to WRITE IT BLINDLY, so two
// tabs (e.g. one restored by the browser session) alternately erased each other's records —
// a funded trade's on-disk recovery material vanished whenever the tab that never saw it
// wrote last (seen live: three funded buys on disk collapsing to one, ~every 30s). A save
// now MERGES: disk records whose id this tab has never seen are preserved, records this tab
// knows win by id, and records this tab deliberately cleared (tombstoned) stay dead — so a
// settle/clear in one tab cannot resurrect from a sibling. Tombstones are per-tab and
// session-long; on the next load every tab boots from the union.
function mergedStoreSave(key, arr, tombstones){
  let disk = [];
  try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); if (Array.isArray(raw)) disk = raw.filter(Boolean); } catch {}
  const mine = new Set(arr.map((r) => r && r.id).filter(Boolean));
  const keep = disk.filter((r) => r && r.id && !mine.has(r.id) && !(tombstones && tombstones.has(r.id)));
  try { localStorage.setItem(key, JSON.stringify(arr.concat(keep))); } catch {}
}
const _subswapTombstones = new Set(), _buyTombstones = new Set(), _sellTombstones = new Set();
function newTradeId(){ return 'sw-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
let SUBSWAPS = [];
try {
  const raw = JSON.parse(localStorage.getItem(SUBSWAPS_KEY) || 'null');
  if (Array.isArray(raw)) SUBSWAPS = raw.filter(Boolean);
} catch { SUBSWAPS = []; }
if (!SUBSWAPS.length){
  try { const one = JSON.parse(localStorage.getItem(SUBSWAP_KEY) || 'null'); if (one) SUBSWAPS = [one]; } catch {}
}
for (const r of SUBSWAPS) if (r && !r.id) r.id = newTradeId();
function saveSubswap(){
  try { stampStages(SUBSWAPS); } catch {}
  try { mergedStoreSave(SUBSWAPS_KEY, SUBSWAPS, _subswapTombstones); } catch {}
  try { localStorage.removeItem(SUBSWAP_KEY); } catch {}
  // Surface EVERY transition. These rails have no process view of their own, so
  // without this the trade ran invisibly and a stall was indistinguishable from the
  // app having ignored the button press. renderInFlightCard no-ops when its host is
  // absent, so this is safe from any context.
  try { renderInFlightCard(); } catch {}
}
function addSubswap(rec){ rec.id = rec.id || newTradeId(); SUBSWAPS.push(rec); saveSubswap(); return rec; }
// Drop ONE record (by identity, falling back to id so a re-parsed copy still matches).
function clearSubswap(rec){
  if (!rec){ for (const r of SUBSWAPS) if (r && r.id) _subswapTombstones.add(r.id); SUBSWAPS = []; saveSubswap(); return; }
  if (rec.id) _subswapTombstones.add(rec.id);
  SUBSWAPS = SUBSWAPS.filter((r) => r !== rec && !(rec.id && r && r.id === rec.id));
  saveSubswap();
}
function subswapTerminal(b){ return !b || b.state === 'settled' || b.state === 'failed' || b.state === 'refunded'; }
function activeSubswaps(){ return SUBSWAPS.filter((r) => !subswapTerminal(r)); }
function subswapById(id){ return SUBSWAPS.find((r) => r && r.id === id) || null; }
export function hasSubswapInFlight(){ return activeSubswaps().length > 0; }
// NOT a product limit — a runaway backstop. Concurrent rail-crossing trades are
// independent per-record state machines and there is no principled ceiling on how many
// a trader may run; this bound exists only so a bug that spawns trades in a loop
// cannot lock funds without bound. Set far above any human trading pattern.
const MAX_CONCURRENT_TRADES = 100;
function tradeSlotsFree(){ return (activeSubswaps().length + (hasBridgeInFlight() ? 1 : 0)) < MAX_CONCURRENT_TRADES; }

// A plain-English status for the Active trades row. These records used to surface
// nothing at all, so a stall was indistinguishable from an app that had ignored the
// button press.
// It must say WHAT IT IS WAITING FOR. Every state the p2p buy driver actually passes
// through was missing here, so the two waits that take minutes each showed either the
// step before them ('starting · contacting the other side', for four minutes, after the
// other side had answered and locked) or a raw internal word ('verified') that tells the
// user nothing. The anchor-burial wait in particular is the one moment the wallet is
// deliberately holding the user's Bitcoin back, and it must say so.
function subswapStatusLine(b){
  const base = (() => {
    switch (b && b.state){
      case 'starting':      return 'starting · contacting the other side';
      case 'awaiting-lock': return 'the other side is locking your asset on-chain · this takes a block';
      case 'verifying':     return 'checking the asset is locked to your key';
      case 'verified':
      case 'anchor-wait':   return 'waiting for the asset lock to be confirmed and anchored in Bitcoin · your payment is held back until it is';
      case 'paying':        return 'paying over Lightning';
      case 'held':          return 'your Bitcoin is committed over Lightning · waiting for the asset';
      case 'confirming':    return 'waiting for the asset leg to confirm on-chain';
      case 'claiming':      return 'claiming your asset on-chain (automatic)';
      case 'funding':       return 'funding your asset leg';
      case 'settling':      return 'waiting for the other side to pay you over Lightning';
      case 'failed':        return 'this trade could not be completed · your funds are safe';
      default:              return String((b && b.state) || 'in progress');
    }
  })();
  // DRIVE-TIME SPEED CLASS (owner ruling): while an LSP payer-bridge buy waits on the maker
  // leg, say WHICH pipeline it is in. front_mode/expected_wait are read TOLERANTLY off the
  // LSP job response (a parallel LSP change adds asset-side fronting: 'inventory' = the LSP
  // fronts the asset now — fast; 'maker-first' = waits on Bitcoin confirmations — slow);
  // ABSENT fields mean the current maker-first behavior (slow). Label only, never a
  // settlement decision.
  if (b && b.kind === 'lsp-payer-buy' && (b.state === 'held' || b.state === 'confirming')){
    if (b.front_mode === 'inventory') return base + ' · fronted from inventory — typically about a minute';
    const wait = b.expected_wait ? 'expected wait ' + String(b.expected_wait) : 'typically 10-60+ minutes on testnet4';
    return base + ' · waits on Bitcoin confirmations — ' + wait + ' · safe to leave, resumes + refunds automatically';
  }
  return base;
}

// Whether the local record may be FORGOTTEN. Safe exactly while nothing of the
// user's is both committed and dependent on this record to recover:
//   - a terminal 'failed' record is always clearable (nothing is outstanding);
//   - a record that has not reached the point of committing value is clearable;
//   - a record holding a preimage AND a funded leg is NOT — that material is what
//     claims or refunds the position, so forgetting it could strand funds.
function subswapClearable(b){
  if (!b) return false;
  if (b.state === 'failed') return true;
  if (b.preimage && b.leg && b.leg.txid) return false;      // recovery material: keep it
  if (b.state === 'held') return false;                      // BTC committed; the driver must resolve it
  // 'confirming' with no asset leg means the handshake round is still open: the
  // /swap job exists but the hold has NOT been reported held, so nothing of the
  // user's is committed. Those records used to be unclearable, which is how one
  // dead take locked the wallet out of every future trade with no way forward. A
  // record that holds nothing must never be a trap.
  if (b.state === 'confirming' && !(b.leg && b.leg.txid)) return true;
  // 'awaiting-lock' is the window this record USED to spend in 'starting' (the maker is
  // locking; the taker has committed nothing and holds nothing to recover). Naming the
  // wait must not quietly take the Clear button away from it.
  return b.state === 'starting' || b.state === 'awaiting-lock';
}
function bridgeClearable(b){
  if (!b) return false;
  if (b.state === 'failed') return true;
  if (b.job_id || b.poll) return false;                      // the LSP holds a job; let the driver finish
  return b.state === 'starting';
}
// Driving is now PER RECORD: one stalled trade must not stop another from being
// driven, which a single module-level flag guaranteed.
const _drivingIds = new Set();
function isDriving(rec){ return !!(rec && rec.id && _drivingIds.has(rec.id)); }
// How long a rail-crossing take may sit in 'starting' before it is treated as failed.
// Generous enough for a slow LSP round-trip and a JIT channel, short enough that a
// wedged record does not outlive the user's patience.
const SUBSWAP_START_STALL_MS = 3 * 60 * 1000;

// Reap a rail-crossing record wedged in 'starting'.
//
// This is the fix for the reported "even a few minutes later" symptom: a start that
// died before committing anything left the record non-terminal forever, and because
// hasSubswapInFlight/hasBridgeInFlight are what gate every new trade, the user was
// locked out with nothing on screen to explain it or clear it.
//
// Called from the composer render AND from the in-flight guards, so it resolves both
// when the user comes back to look and when they try again. Only ever touches a
// record with nothing committed — see subswapClearable/bridgeClearable for the same
// reasoning applied to the Clear button.
// What is actually blocking a new trade, and what the user can do about it. The old
// text named "Active trades" and stopped there, which is no help when the blocking
// record is one that can simply be cleared.
function inFlightBlockMessage(){
  const sub = activeSubswaps()[0] || null;
  const b = sub || (BRIDGE && !bridgeTerminal() ? BRIDGE : null);
  const clearable = sub ? subswapClearable(b) : bridgeClearable(b);
  const base = `You already have ${MAX_CONCURRENT_TRADES} trades in progress · see Active trades`;
  return clearable
    ? base + '. Nothing of yours is committed to it, so you can Clear it there and start this one.'
    : base + '. Finish or reclaim it before starting another.';
}

// Reconcile a persisted rail-crossing record against the LSP's own view of its job.
//
// The drivers already abort on a failed job — but only while the driver is RUNNING.
// A reload (or a closed tab) kills it, and the record then sits in whatever state it
// last persisted. That is how a take whose job the LSP had already failed kept
// showing "waiting for the asset leg to confirm on-chain" for many blocks: nothing
// asked the LSP again.
//
// Fire-and-forget from the composer render. Only ever moves a record to `failed`,
// and only when the LSP says the job failed AND nothing of ours is committed (no
// preimage-plus-leg to recover), so it can never discard recovery material.
let _jobCheckAt = 0;
// A BRIDGE record is safe to auto-fail only BEFORE the taker commits anything.
// The bridge order is starting -> confirming -> fronted -> relaying -> funding_asset
// -> asset_funded -> settling -> settled, and nothing of ours has moved before
// 'fronted': no hold minted, no asset funded, no preimage revealed. Past that point
// the running driver owns the record and reconciling behind its back could mark a
// trade dead that still has value in flight, so we leave it strictly alone.
function bridgePreCommitment(b){
  if (!b) return false;
  if (b.state !== 'starting' && b.state !== 'confirming') return false;
  return !(b.fronted || b.relayed || b.seq_redeem || b.hold_settled || b.taker_seq_leg);
}

async function reconcileJobStatus(force){
  try {
    // BOTH records, because the reported stall was a BRIDGE and this only ever read
    // SUBSWAP. 'confirming' is not even a subswap state — so for the rail that
    // actually got stuck, the reconciler was inspecting the wrong object entirely
    // and would have found nothing however well it read the job.
    // Every subswap record is reconciled, not just the first: with a list, a failed
    // job on trade #2 must not be invisible because trade #1 is still healthy.
    for (const r of activeSubswaps()) await reconcileOne(r, false, force);
    const b = bridgePreCommitment(BRIDGE) ? BRIDGE : null;
    if (b) await reconcileOne(b, true, force);
  } catch {}
}

async function reconcileOne(b, isBridge, force){
  try {
    if (!b || (isBridge ? bridgeTerminal() : subswapTerminal(b)) || !(b.job_id || b.poll)) return;
    if (!isBridge && b.preimage && b.leg && b.leg.txid) return;      // committed: the driver owns it
    if (!force && Date.now() - _jobCheckAt < 15000) return;   // at most one probe per 15s when idle
    _jobCheckAt = Date.now();
    // jobStatusRaw, NOT jobStatus: lspFetch rejects on ok:false, and a FAILED job
    // answers ok:false — so the probe that most needs to see a failure was the one
    // that threw. Every reconcile attempt was silently swallowed by its own catch,
    // which is why a record the LSP had already failed kept reporting "confirming".
    const read = (L && (L.jobStatusRaw || L.jobStatus)) || null;
    if (!read) { console.warn('[subswap] no job-status capability wired; cannot reconcile'); return; }
    let j = null;
    try { j = await read(b.poll || b.job_id); }
    catch (e) { console.warn('[subswap] job-status probe failed:', e); return; }
    if (!j || j.status !== 'failed') return;
    // Re-check the LIVE record, not the snapshot: the await above yields, and the
    // driver may have advanced or replaced it while the probe was in flight.
    const now = isBridge ? BRIDGE : subswapById(b.id);
    if (!now || now.job_id !== b.job_id) return;
    if (isBridge ? (bridgeTerminal() || !bridgePreCommitment(now)) : subswapTerminal(now)) return;
    now.state = 'failed';
    now.detail = 'This trade could not be completed - your funds are safe.' +
      (j.error ? ' (' + String(j.error).slice(0, 160) + ')' : '');
    if (isBridge) saveBridge(); else saveSubswap();
  } catch {}
}

function reapStalledCrossings(){
  const now = Date.now();
  try {
    for (const r of activeSubswaps()){
      if (r.state === 'starting' && r.started_ms &&
          now - r.started_ms > SUBSWAP_START_STALL_MS && !r.preimage && !r.job_id){
        r.state = 'failed';
        r.detail = 'This trade never got started · nothing of yours was committed. You can try again.';
        saveSubswap();
      }
    }
  } catch {}
  try {
    if (BRIDGE && BRIDGE.state === 'starting' && BRIDGE.started_ms &&
        now - BRIDGE.started_ms > SUBSWAP_START_STALL_MS && !BRIDGE.job_id && !BRIDGE.poll){
      BRIDGE = { ...BRIDGE, state: 'failed',
        detail: 'This trade never got started · nothing of yours was committed. You can try again.' };
      saveBridge();
    }
  } catch {}
}

// Review a rail-crossing take that settles PEER-TO-PEER (no LSP in the value path, so no bridge fee). Both
// directions. The Review states the EXACT whole-HTLC amounts + the single-T_seq fund-safety story.
async function reviewSubmarineP2P(route, disp){
  const { $ } = C;
  try { reapStalledCrossings(); } catch {}
  // Ask the LSP before refusing. A record whose job the LSP has already failed must
  // never block a new trade — that turned one dead take into a wallet that refused
  // every subsequent one, with the user told to finish something that could not be
  // finished. Awaited (not fire-and-forget) so the very first press re-checks.
  try { await reconcileJobStatus(true); } catch {}
  if (!tradeSlotsFree()){ $('swErr').textContent = inFlightBlockMessage(); return; }
  if (!(L && L.btcNodeKey && L.nodePay)){ $('swErr').textContent = 'This trade could not be placed right now - try again shortly.'; return; }
  const am = C.assetMeta(route.seqAsset) || {}; const tk = am.ticker || 'asset', aprec = am.precision || 0;
  const buy = disp.ln_direction === 1;
  // BUY BTC-LN OUTBOUND CHECK: a P2P submarine BUY pays BTC over the taker's OWN Lightning and does NOT
  // JIT-provision a channel like the LSP bridge. Require REAL spendable BTC-LN outbound (a funded BTC channel);
  // else honest-disable (move BTC to Lightning first) — never enable Place for a buy the taker can't pay.
  if (buy){
    const pv = railAvail('BTC', route.seqAsset).payLn;
    if (!pv.ok){
      $('swErr').textContent = 'You will need Bitcoin in Lightning to pay this way · move it to Lightning first (Balance tab), then take this offer.';
      return;
    }
  }
  // P3.1 — the SIZED take (disp.takeAtoms/takeBtc), never the whole resting offer, so Review == what executes.
  const assetStr = C.fmtAtoms(BigInt(disp.takeAtoms || 0), aprec) + ' ' + tk;
  const btcStr = C.fmtAtoms(BigInt(disp.takeBtc || 0), 8) + ' BTC';
  const offerAssetStr = C.fmtAtoms(BigInt(disp.offer.assetAtoms || 0), aprec) + ' ' + tk;
  const partialNote = disp.partial ? ` Partial fill of a larger resting offer (${offerAssetStr}).` : '';
  // The Review shows ONLY the user's own legs (what they pay / receive) + a plain reassurance — never any of
  // the settlement machinery that carries the trade to completion.
  // ROUTING HONESTY (owner ruling): every mixed-take review states the expected settlement
  // class BEFORE Confirm. A P2P submarine is an interactive maker on the matching rails —
  // Sequentia speed, never a Bitcoin-confirmation wait.
  const kv = buy ? [
    ['Direction', 'Buy ' + tk + ' with Bitcoin over Lightning'],
    ['You trade', 'Pay ' + btcStr + ', receive ' + assetStr + '.' + partialNote],
    ['Your funds', 'Your funds stay in your control until this completes.'],
    ['Speed', SPEED_FAST_NOTE],
  ] : [
    ['Direction', 'Sell ' + tk + ' for Bitcoin over Lightning'],
    ['You trade', 'Sell ' + assetStr + ', receive ' + btcStr + '.' + partialNote],
    ['Your funds', 'Your funds stay in your control until this completes.'],
    ['Speed', SPEED_FAST_NOTE],
  ];
  // Below-minimum guard (defense-in-depth; the composer already blocks Place): the request is under this
  // offer's minimum fill. Show the true minimum plainly and BLOCK Place — every offer is partial-fillable
  // down to its minimum, so this is a "too small", never a "whole-offer-only".
  if (disp.belowMin){
    const minStr = C.fmtAtoms(BigInt(disp.minAtoms || 0), aprec) + ' ' + tk;
    const minBtcStr = C.fmtAtoms(BigInt(disp.minBtc || 0), 8) + ' BTC';
    kv.splice(2, 0, ['Smallest amount', `The smallest amount you can ${buy ? 'buy' : 'sell'} here is ${minStr} (${minBtcStr}).`]);
  }
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  if (disp.belowMin){
    ok.disabled = true; ok.textContent = 'Enter at least the minimum';
    if (st) st.textContent = 'Increase the amount to the minimum shown, then place the order.';
    return;
  }
  ok.onclick = async () => { modal.remove(); resetComposer(); await startSubswapP2P(route, disp); };
}

// ===========================================================================
// SEQUENTIAL WALK EXECUTION
// ---------------------------------------------------------------------------
// A walked take fills across several offers. Each rail-crossing leg is an
// INTERACTIVE HTLC session with its own preimage, refund key and funded leg, so
// the legs are run ONE AT A TIME: leg N settles (or fails) before leg N+1 starts.
//
// Why sequential rather than parallel. Only one leg's recovery material is ever
// live, so a crash or a stall leaves exactly one position to resolve rather than
// several; the existing in-flight guard and Active trades row keep working
// unchanged; and the per-leg settlement code — the proven part — is reused
// verbatim rather than being threaded with a leg index. This orchestrator adds
// ordering and accounting, nothing else.
//
// A leg that FAILS stops the walk. It never silently continues to the next offer:
// the user agreed to a fill at a stated aggregate, and quietly re-routing the
// remainder at a worse price would be a different trade. The partial that did fill
// is reported as what it is.
const WALK_KEY = 'swk.sequentia.walk';
let WALK = null;
try { WALK = JSON.parse(localStorage.getItem(WALK_KEY) || 'null'); } catch { WALK = null; }
function saveWalk(){
  try { localStorage.setItem(WALK_KEY, JSON.stringify(WALK)); } catch {}
  try { renderInFlightCard(); } catch {}
}
function clearWalk(){ WALK = null; try { localStorage.removeItem(WALK_KEY); } catch {} try { renderInFlightCard(); } catch {} }
function walkTerminal(){ return !WALK || WALK.state === 'done' || WALK.state === 'stopped'; }
export function hasWalkInFlight(){ return !!WALK && !walkTerminal(); }

// Begin a multi-leg walk. `legs` are the planner's, in price order.
function beginWalk(route, bp){
  const w = bp && bp.walk;
  if (!w || w.offersUsed <= 1 || !(w.filledAtoms > 0n)) return false;   // a single leg needs no orchestration
  WALK = {
    asset: route.seqAsset, side: bp.side,
    legs: w.legs.map(l => ({
      offer_id: (l.offer && l.offer.id) || null,
      maker_pubkey: (l.offer && l.offer.maker) || null,
      rail: (l.offer && l.offer.rail) || null,
      relayUrl: (l.offer && l.offer.relayUrl) || null,
      takeAtoms: String(l.takeAtoms), takeBtc: String(l.takeBtc),
    })),
    legIndex: 0, filledAtoms: '0', filledBtc: '0',
    plannedAtoms: String(w.filledAtoms), plannedBtc: String(w.filledBtc),
    remainderAtoms: String(w.remainderAtoms || 0n),
    state: 'running', started_ms: Date.now(),
  };
  saveWalk();
  return true;
}

// Record a settled leg and report whether another remains.
function advanceWalk(){
  if (!WALK || walkTerminal()) return false;
  const leg = WALK.legs[WALK.legIndex];
  if (leg){
    WALK.filledAtoms = String(BigInt(WALK.filledAtoms || 0) + BigInt(leg.takeAtoms || 0));
    WALK.filledBtc = String(BigInt(WALK.filledBtc || 0) + BigInt(leg.takeBtc || 0));
  }
  WALK.legIndex += 1;
  if (WALK.legIndex >= WALK.legs.length){ WALK.state = 'done'; saveWalk(); return false; }
  saveWalk();
  return true;
}

// Stop the walk without pretending the rest filled.
function stopWalk(reason){
  if (!WALK) return;
  WALK.state = 'stopped';
  WALK.detail = reason || 'This trade stopped part-way · the part that filled is yours.';
  saveWalk();
}

// A one-line account of a walk, for the Active trades row.
function walkStatusLine(w){
  if (!w) return '';
  const am = metaOf(w.asset); const prec = am.precision || 0;
  const filled = C.fmtAtoms(BigInt(w.filledAtoms || 0), prec);
  const planned = C.fmtAtoms(BigInt(w.plannedAtoms || 0), prec);
  const n = w.legs ? w.legs.length : 0;
  if (w.state === 'done') return `filled ${filled} of ${planned} ${am.ticker || ''} across ${n} offers`;
  if (w.state === 'stopped') return w.detail || `stopped after ${filled} ${am.ticker || ''}`;
  return `offer ${Math.min(w.legIndex + 1, n)} of ${n} · ${filled} ${am.ticker || ''} filled so far`;
}

async function startSubswapP2P(route, disp){
  if (!tradeSlotsFree()){ try { C.toast && C.toast(inFlightBlockMessage()); } catch {} return; }
  if (disp.belowMin){ try { C.toast && C.toast('That amount is below the smallest this offer can fill · increase it to the minimum shown.'); } catch {} return; }   // fail closed — never place a below-minimum take
  const buy = disp.ln_direction === 1;
  // A multi-offer request becomes a WALK: the legs run one at a time through this
  // very function, so the settlement path below is unchanged and only the ordering
  // is new. beginWalk returns false for a single-leg take, which then behaves
  // exactly as before.
  const walking = beginWalk(route, disp);
  const leg = walking ? WALK.legs[0] : null;
  // P3.1 — persist the SIZED take (disp.takeAtoms/takeBtc), never the whole offer, so the courier bind, the
  // expect{atoms,msat} the driver gates on, and any resume all use the user's requested size (§2.4).
  const rec = addSubswap({ kind: buy ? 'p2p-buy' : 'p2p-sell', state: 'starting', asset: route.seqAsset,
    offer_id: (leg ? leg.offer_id : disp.offer.id) || null,
    maker_pubkey: (leg ? leg.maker_pubkey : disp.offer.maker) || null,
    // The relay holding this offer — the courier must open there, not on the default.
    relay_url: (leg && leg.relayUrl) || disp.offer.relayUrl || null,
    asset_atoms: String(leg ? leg.takeAtoms : (disp.takeAtoms || 0)),
    btc_sats: String(leg ? leg.takeBtc : (disp.takeBtc || 0)),
    partial: !!disp.partial, walk: !!walking,
    ln_direction: disp.ln_direction, started_ms: Date.now() });
  if (walking) try { C.toast && C.toast(`Filling across ${WALK.legs.length} offers · follow it under Active trades.`); } catch {}
  driveSubswap(rec);
}

// Start the walk's NEXT leg through the same per-leg path that settled the last one.
// Called only after a leg reaches 'settled', so at most one leg is ever live.
async function runNextWalkLeg(){
  if (!WALK || walkTerminal()) return;
  const leg = WALK.legs[WALK.legIndex];
  if (!leg){ WALK.state = 'done'; saveWalk(); return; }
  const buy = WALK.side === 'buy';
  const rec = addSubswap({ kind: buy ? 'p2p-buy' : 'p2p-sell', state: 'starting', asset: WALK.asset,
    offer_id: leg.offer_id, maker_pubkey: leg.maker_pubkey, relay_url: leg.relayUrl || null,
    asset_atoms: String(leg.takeAtoms), btc_sats: String(leg.takeBtc),
    partial: true, walk: true,
    ln_direction: buy ? 1 : 0, started_ms: Date.now() });
  await driveSubswap(rec);
}

// After a leg finishes, either run the next one or close the walk out honestly.
async function onWalkLegFinished(settled){
  if (!WALK || walkTerminal()) return;
  if (!settled){
    stopWalk('This trade stopped part-way · the part that filled is yours, and the rest was not started.');
    try { C.toast && C.toast('Trade stopped part-way · see Active trades.'); } catch {}
    return;
  }
  if (advanceWalk()) await runNextWalkLeg();
  else {
    try { C.toast && C.toast(walkStatusLine(WALK)); } catch {}
    try { await C.sync(); } catch {}
  }
}

// Drive the persisted subswap to completion (self-heals a transient gap; toasts on settle). Whole flow runs
// in one live courier session; the RESUME-critical state (learned P + verified leg for a buy) is persisted
// via the driver's onPaid before the claim, so a crash re-claims on the next boot (see resumeSubswap).
async function driveSubswap(rec){
  const b0 = rec || activeSubswaps().find((r) => r.kind === 'p2p-buy' || r.kind === 'p2p-sell');
  if (!b0 || subswapTerminal(b0) || isDriving(b0)) return;
  // ONLY the peer-to-peer kinds. Both drivers act on the same SUBSWAP record and
  // neither checked whose it was, so whichever ran first drove the other's trade with
  // the wrong protocol semantics — a p2p-buy got driven as a payer bridge and died on
  // "the maker never locked the asset leg" while the maker had in fact locked it and
  // was waiting to be paid.
  if (b0.kind !== 'p2p-buy' && b0.kind !== 'p2p-sell') return;
  _drivingIds.add(b0.id);
  const b = b0, asset = b.asset;
  try {
    if (b.kind === 'p2p-buy'){
      const deps = { ...subCommonDeps(),
        offer: { offer_id: b.offer_id, maker_pubkey: b.maker_pubkey, relayUrl: b.relay_url || null }, takeAtoms: BigInt(b.asset_atoms),
        expect: { asset, atoms: BigInt(b.asset_atoms), msat: BigInt(b.btc_sats) * 1000n },
        payInvoice: async (bolt11, opts) => {
          const node_key = await ensureBtcNodeKey();
          // Thread wantHash(H)+amountMsat+maxCltv into /node/pay so the node can bind the payment_hash + amount
          // (mirror the Go PayInvoice(bolt11,wantHash,amountMsat)) AND cap the route's total CLTV delay to the
          // hold-safe ceiling — so a masqueraded hold fails back (refunds us) early. Client-side gates stay primary.
          const r = await L.nodePay({ node_key, bolt11, wantHash: opts && opts.wantHash, amountMsat: opts && opts.amountMsat, maxCltv: opts && opts.maxCltv });
          if (!(r && r.preimage)){ console.warn('[subswap] BTC-LN pay returned no preimage'); throw new Error('This trade could not be completed - your funds are safe.'); }
          return r.preimage;
        },
        // The two LONG waits have no end-of-step callback of their own, so the record used
        // to describe the step BEFORE the wait it was actually in. onStage names the wait.
        onStage: (s) => {
          if (s !== 'awaiting-lock' && s !== 'anchor-wait') return;
          b.state = s; b.stage_since_ms = Date.now(); saveSubswap();
        },
        onLocked: () => { b.state = 'verifying'; saveSubswap(); },
        onVerified: () => { b.state = 'verified'; saveSubswap(); },
        // CRASH GAP: persist the leg outpoint + bolt11 + H + the 'paying' marker BEFORE the irreversible pay,
        // so resumeSubswap can RE-QUERY the node for a settled payment on H (idempotent) and recover P + claim
        // — never silently dropping a record that may already have paid.
        onAboutToPay: (info) => { b.leg = info.leg; b.hash_h = info.hash_h; b.bolt11 = info.bolt11; b.state = 'paying'; saveSubswap(); },
        onPaid: (preimage, leg) => { b.preimage = preimage; b.leg = leg; b.state = 'claiming'; saveSubswap(); },
        onClaimed: (txid) => { b.seq_claim_txid = txid; b.state = 'settled'; saveSubswap(); },
      };
      await runTakerReverseSubmarine(deps);
    } else if (b.kind === 'p2p-sell'){
      const node_key = await ensureBtcNodeKey();
      b.btc_node_key = node_key; saveSubswap();
      const deps = { ...subCommonDeps(),
        offer: { offer_id: b.offer_id, maker_pubkey: b.maker_pubkey, relayUrl: b.relay_url || null }, takeAtoms: BigInt(b.asset_atoms),
        seqRefundKey: C.seqLeg.refundKey(),
        expect: { asset, atoms: BigInt(b.asset_atoms), msat: BigInt(b.btc_sats) * 1000n },
        randomSecret: () => randomSecretHex(),
        fundSeq: async ({ redeemHex, asset: a, atoms }) => {
          const found = await C.seqLeg.findFundingByAddress(redeemHex).catch(() => null);
          const txid = (found && found.txid) ? found.txid : (await C.seqLeg.fund(redeemHex, a, BigInt(atoms))).txid;
          const conf = await C.seqLeg.waitConf(txid, redeemHex);
          return { txid, vout: conf.vout, block_hash: conf.block_hash, height: conf.height };
        },
        mintHold: async ({ hashH, preimage, msat, expirySecs }) => {
          const sats = Math.ceil(Number(msat) / 1000);
          try { if (L.channelInbound) await L.channelInbound({ node_key, amount: sats }); } catch {}
          // Pass P so the node can mint a PLAIN bolt11 that auto-settles on payment (RunMakerSubmarine needs
          // Bolt11 != ''); the settle-with-P loop remains the HODL fallback if the node returns no bolt11.
          const inv = await L.nodeInvoice({ node_key, amount: sats, payment_hash: hashH, preimage, expiry: expirySecs });
          if (!(inv && inv.node_id)){ console.warn('[subswap] could not register the BTC-LN invoice'); throw new Error('This trade could not be completed - your funds are safe.'); }
          return { node_id: inv.node_id, bolt11: inv.bolt11 || null };
        },
        invoiceStatus: (p) => L.invoiceStatus({ node_key, payment_hash: p.hashH }).then((s) => ({ held: !!(s && (s.held || s.settled)), settled: !!(s && s.settled) })).catch(() => ({})),
        settleHold: (p) => L.nodeSettle({ node_key, payment_hash: p.hashH, preimage: p.preimage }),
        // SELL PERSIST-BEFORE-FUND (fund-loss): persist H/P/redeem + the intended leg (redeem/asset/amount/
        // locktime) + the refund secret + the BTC node key BEFORE fundSeq broadcasts the asset HTLC, so a reload
        // during the ~12min waitConf recovers everything and resumeSubswap re-derives the funding — never a
        // funded-but-unpersisted asset. state 'funding' is what resumeSubswap's recovery branch matches.
        onAboutToFund: (info) => { b.hash_h = info.hash_h; b.preimage = info.preimage; b.seq_locktime = info.seq_locktime;
          b.refund_secret = info.refund_secret; b.btc_node_key = node_key;
          b.leg = { redeem_script: info.redeem, asset: info.asset, amount: info.atoms, locktime: info.seq_locktime };
          b.state = 'funding'; saveSubswap(); },
        onFunded: (rec) => { b.leg = rec.leg; b.hash_h = rec.hash_h; b.preimage = rec.preimage; b.seq_locktime = rec.seq_locktime; b.refund_secret = rec.refund_secret; b.state = 'settling'; saveSubswap(); },
        onSettled: () => { b.state = 'settled'; saveSubswap(); },
      };
      const r = await runTakerSubmarine(deps);
      if (r && !r.ok && r.refundable){ b.state = 'settling'; saveSubswap(); }   // unpaid -> keep the leg for a T_seq refund
    }
  } catch (e){
    console.warn('[subswap] drive error:', e);   // technical detail stays in the console; the UI shows only a plain sentence
    // A failure AFTER learning P (buy) or funding the asset (sell) stays RESUMABLE (the claim/refund off-ramp
    // is still live); a failure before anything is committed is a clean terminal failure (nothing lost).
    if (b.preimage || (b.leg && b.leg.txid)){ b.detail = failDetail(e); if (b.state === 'starting' || b.state === 'verifying' || b.state === 'paying') b.state = b.preimage ? 'claiming' : b.state; saveSubswap(); }
    else { b.state = 'failed'; b.detail = failDetail(e); saveSubswap(); }
  } finally { _drivingIds.delete(b.id); }
  const settled = b.state === 'settled';
  // A WALK leg reports to the orchestrator instead of announcing itself: the user
  // agreed to one aggregate fill, so N per-leg "swap settled" toasts would misstate
  // what happened. A failed leg STOPS the walk — the remainder is never silently
  // re-routed to another offer at a price the user did not agree to.
  if (b.walk && hasWalkInFlight()){
    try { await C.sync(); } catch {}
    await onWalkLegFinished(settled);
    return;
  }
  if (settled){ try { C.toast(b.kind === 'p2p-buy' ? 'Swap settled · the asset is yours.' : 'Swap settled · you received Bitcoin over Lightning.'); } catch {} try { await C.sync(); } catch {} }
}

// Review the LSP PAYER leg-bridge — the BUY fallback vs an on-chain-only maker. The taker mints H (holds P),
// the LSP issues a BTC-LN hold on H and originates the on-chain BTC HTLC to the maker; the taker verifies the
// maker's relayed asset leg (claim=my key on H, anchor-buried) then claims with P self-custody.
async function reviewLspPayerBridge(route, disp){
  const { $ } = C;
  const am = C.assetMeta(route.seqAsset) || {}; const tk = am.ticker || 'asset', aprec = am.precision || 0;
  try { reapStalledCrossings(); } catch {}
  // Ask the LSP before refusing. A record whose job the LSP has already failed must
  // never block a new trade — that turned one dead take into a wallet that refused
  // every subsequent one, with the user told to finish something that could not be
  // finished. Awaited (not fire-and-forget) so the very first press re-checks.
  try { await reconcileJobStatus(true); } catch {}
  if (!tradeSlotsFree()){ $('swErr').textContent = inFlightBlockMessage(); return; }
  // FAIL CLOSED (the ONLY surviving honest-disable): without the LSP payer-bridge hold + bare-hash pay this
  // shape has no settlement path, so refuse rather than offer-then-refuse. payerBridgeDisabledNote is the note.
  if (!(L && L.swap && L.bridgeHold && L.nodePayHash)){ $('swErr').textContent = payerBridgeDisabledNote(tk); return; }
  // Paying BTC over the taker's OWN Lightning needs funded BTC-LN outbound: the bridge only JIT-provisions the
  // maker's on-chain BTC HTLC, NOT a channel for the buyer. Honest-disable up front, never enable Place.
  if (!railAvail('BTC', route.seqAsset).payLn.ok){ $('swErr').textContent = 'You will need Bitcoin in Lightning to pay this way · move it to Lightning first (Balance tab), then take this offer.'; return; }
  // Below-minimum: the request is under this offer's minimum fill — fail closed, never place a below-min take.
  if (disp.belowMin){ const minStr = C.fmtAtoms(BigInt(disp.minAtoms || 0), aprec) + ' ' + tk; const minBtcStr = C.fmtAtoms(BigInt(disp.minBtc || 0), 8) + ' BTC'; $('swErr').textContent = `The smallest amount you can buy here is ${minStr} (${minBtcStr}) · increase the amount to at least that.`; return; }
  // The review must state the SIZED take. Falling back to the whole offer here would
  // print one number while the order carried another.
  // A REFUSAL BELONGS ON THE ERROR LINE, NOT ONLY IN A TOAST.
  //
  // This bailed with a toast alone, so Place order did nothing visible and left no trace: no review
  // sheet, an empty error line, and a notification the user may never have been looking at. Watched
  // it happen live on the LN-pay/on-chain-receive rail — Place clicked, nothing whatsoever, and the
  // only way to find out why was to read the source. Say it where every other refusal on this screen
  // is said, and keep the toast for the case where the composer has scrolled out of view.
  let _rv;
  try { _rv = sizedTake(disp); }
  catch (e) {
    const why = C.prettyErr(e);
    $('swErr').textContent = `This trade could not be sized, so nothing was placed: ${why}`;
    try { C.toast && C.toast('This trade could not be sized - nothing was placed.'); } catch {}
    try { console.warn('[payer-bridge] sizedTake failed:', e); } catch {}
    return;
  }
  const assetStr = C.fmtAtoms(_rv.atoms, aprec) + ' ' + tk;
  const btcStr = C.fmtAtoms(_rv.btc, 8) + ' BTC';
  // The Review shows ONLY the user's own legs (what they pay / receive) + a plain reassurance — never any of
  // the settlement machinery that carries the trade to completion.
  // ROUTING HONESTY (owner ruling): the payer bridge runs the maker-first pipeline, which
  // waits on testnet4 confirmations — this class is stated HERE, before Confirm, always.
  // The composer only routes here when this offer's price strictly beats every maker that
  // could serve the take at Sequentia speed, or when no such maker rests (bridgedTakePlan's
  // speed-aware selection); the review still owes the user the timescale.
  const kv = [
    ['Direction', 'Buy ' + tk + ' with Bitcoin over Lightning'],
    ['You trade', 'Pay ' + btcStr + ', receive ' + assetStr + '.'],
    ['Your funds', 'Your funds stay in your control until this completes.'],
    ['Speed', SPEED_SLOW_NOTE],
  ];
  const { m: modal, ok } = C.modalRows({ title: 'Review swap', kv });
  // Rails captured BEFORE the reset; see startBridged.
  ok.onclick = async () => { const rails = { payRail: S.payRail, recvRail: S.recvRail };
    modal.remove(); resetComposer(); await startLspPayerBridge(route, disp, rails); };
}

// Move a PRE-COMMITMENT payer-bridge onto the next-best offer. Same contract as
// advanceBridgeToNextOffer, for the driver the composer actually uses: it is entered
// only where nothing was funded, rebuilds the route from the RECORD (never from
// composer state, which the user may have retyped), and re-prices for the new offer
// because each one carries its own price and the maker binds on exact amounts.
function advanceSubswapToNextOffer(b, why){
  try {
    // PRE-COMMITMENT for THIS rail, which is not "has no preimage".
    //
    // An LSP-payer buy mints P locally BEFORE the handshake even starts (self-custody:
    // the taker owns the secret). So b.preimage is set from the first moment and means
    // nothing about commitment — testing it here made the retry bail instantly on every
    // single attempt, which is why a trade blocked by "offer has a lift in progress"
    // stayed dead at attempt 1 with live offers beside it.
    //
    // Nothing of the user's has moved until the BTC-LN hold is actually held or the
    // asset leg is funded. While the record is still 'starting' the handshake has not
    // even produced terms, so there is nothing to lose by trying another maker.
    if (!b) return false;
    // COMMITMENT IS A FACT ABOUT VALUE, NOT ABOUT THE STATE LABEL.
    //
    // Gating on state === 'starting' was still wrong: the record moves to 'confirming'
    // as soon as the job is posted, which is long before anything of the user's moves —
    // the hold is not minted until AFTER the maker's asset leg has been verified. So the
    // guard blocked every real retry just as surely as the preimage test did.
    //
    // These three are the actual markers that value has moved. The caller has already
    // established that the failure itself is one the LSP reports as "nothing funded"
    // (retryableHandshakeFailure), so this is the second, independent check.
    if (b.leg && b.leg.txid) return false;                 // maker's asset leg recorded
    if (b.bolt11 || b.hold_paid || b.held) return false;   // BTC-LN hold minted / paid
    // AND THE STATE ITSELF. 'held' means the hold is PAID — the guard above looked for a
    // `held` FIELD and missed the `state === 'held'` that the driver actually sets, so a
    // record whose Bitcoin was already committed got retried onto another offer,
    // abandoning the paid hold. Only the two states before any value moves may retry:
    // 'starting' (nothing posted) and 'confirming' (job posted, hold not yet minted).
    if (b.state !== 'starting' && b.state !== 'confirming') return false;
    const attempts = Number(b.offer_attempts || 1);
    if (attempts >= BRIDGE_MAX_OFFER_ATTEMPTS) return false;
    markOfferDead(b.offer_id, why);
    // The RECORD's rails, full stop. Comparing against S was wrong twice over: the
    // composer is already reset by the time any trade is running, so the check either
    // compared two blanks or refused outright — and a blank S then made the planner
    // itself bail on "rails unset", which is why no retry ever actually happened.
    const bp = bridgedTakePlan({ seqAsset: b.asset, payIsBtc: true },
      { payRail: b.payRail, recvRail: b.recvRail }, BigInt(b.asset_atoms || 0));
    if (!bp || !bp.offer || !bp.offer.id || bp.offer.id === b.offer_id) return false;
    if (!(BigInt(bp.takeAtoms || 0) > 0n) || !(BigInt(bp.takeBtc || 0) > 0n)) return false;
    // THE REPLACEMENT MUST SUIT THIS DRIVER.
    //
    // The retry re-uses the record's `kind`, which fixes which driver keeps running. If
    // the next-best offer needs a DIFFERENT settlement path, carrying the old kind over
    // points the wrong protocol at it: a payer-bridge retry that landed on a submarine
    // offer sent the cross-chain courier's XcTermsRequest to a maker waiting for
    // XcSubTermsRequest, and both sides waited for a message the other would never send
    // until the handshake timed out. Observed live.
    //
    // Rather than switch drivers mid-record, skip an offer this driver cannot settle and
    // let the next round consider the one after it.
    const nextDisp = dispatchSubswap({ asset: b.asset, side: 'buy',
      payRail: b.payRail, recvRail: b.recvRail, offer: bp.offer });
    const wantPath = (b.kind === 'lsp-payer-buy') ? 'lsp-bridge' : 'p2p-submarine';
    if (!nextDisp || nextDisp.path !== wantPath){
      console.warn('[subswap] skipping ' + bp.offer.id + ': needs ' +
        ((nextDisp && nextDisp.path) || 'an unknown path') + ', this trade is on ' + wantPath);
      // Mark the CANDIDATE dead (not the record's own offer, which is already dead), so
      // the next pass cannot pick it again — otherwise this recurses forever on it.
      markOfferDead(bp.offer.id);
      return advanceSubswapToNextOffer(b, why);
    }
    console.warn('[subswap] retrying on the next offer (' + bp.offer.id + ') after:', why);
    const rec = addSubswap({ kind: b.kind, state: 'starting', asset: b.asset,
      payRail: b.payRail, recvRail: b.recvRail,
      offer_id: bp.offer.id, maker_pubkey: bp.offer.maker || null,
      relay_url: bp.offer.relayUrl || null,
      asset_atoms: String(bp.takeAtoms || 0), btc_sats: String(bp.takeBtc || 0),
      offer_attempts: attempts + 1,
      detail: 'Finding another maker for this trade…',
      started_ms: Date.now() });
    driveLspPayerBridge(rec);
    return true;
  } catch (e){ console.warn('[subswap] retry planning error:', e); return false; }
}

// The SIZED take, or a refusal. Never the whole offer.
//
// These read `disp.takeAtoms || disp.offer.assetAtoms` — so whenever the sized take was
// missing or zero, the wallet silently fell back to the ENTIRE resting offer. A user who
// asked for 4 USDX got a 50 USDX order built behind a review screen that still said 4,
// and the only reason it did not execute was that a later step happened to fail.
//
// "If I do not know the size, buy everything" is never the right default for an order.
// A missing size is a bug in the caller, and it must surface as one.
function sizedTake(disp){
  const atoms = BigInt((disp && disp.takeAtoms) || 0);
  const btc = BigInt((disp && disp.takeBtc) || 0);
  if (!(atoms > 0n) || !(btc > 0n))
    throw new Error('this trade could not be sized - nothing was placed');
  return { atoms, btc };
}

async function startLspPayerBridge(route, disp, rails){
  if (!tradeSlotsFree()){ try { C.toast && C.toast(inFlightBlockMessage()); } catch {} return; }
  let sized;
  try { sized = sizedTake(disp); }
  catch (e){ console.warn('[subswap] refusing to place an unsized take:', e); try { C.toast && C.toast('This trade could not be sized - nothing was placed.'); } catch {} return; }
  const rec = addSubswap({ kind: 'lsp-payer-buy', state: 'starting', asset: route.seqAsset,
    offer_id: disp.offer.id || null, maker_pubkey: disp.offer.maker || null,
    relay_url: disp.offer.relayUrl || null,
    asset_atoms: String(sized.atoms), btc_sats: String(sized.btc),
    payRail: (rails && rails.payRail) || S.payRail, recvRail: (rails && rails.recvRail) || S.recvRail, offer_attempts: 1,
    min_anchor_depth: Number((disp.offer.raw && (disp.offer.raw.min_anchor_depth ?? disp.offer.raw.minAnchorDepth)) || 0) || 0,
    started_ms: Date.now() });
  // Say something IMMEDIATELY. resetComposer() has just cleared the form, so without
  // this the press produced no feedback whatsoever and the trade began invisibly.
  try { C.toast && C.toast('Trade started · follow it under Active trades.'); } catch {}
  driveLspPayerBridge(rec);
}

async function driveLspPayerBridge(rec){
  const b0 = rec || activeSubswaps().find((r) => r.kind === 'lsp-payer-buy');
  if (!b0 || subswapTerminal(b0) || isDriving(b0)) return;
  // ONLY the LSP payer-bridge kind — see the note in driveSubswap.
  if (b0.kind !== 'lsp-payer-buy') return;
  // STALL WATCHDOG. Nothing here is committed while the record is still 'starting',
  // so a start that never got past it is a failure, not a position — and leaving it
  // non-terminal wedged every future trade behind the in-flight guard with no way to
  // see or clear it. Fail it honestly instead, which also makes it clearable.
  try {
    if (b0.state === 'starting' && b0.started_ms &&
        Date.now() - b0.started_ms > SUBSWAP_START_STALL_MS){
      b0.state = 'failed';
      b0.detail = 'This trade never got started · nothing of yours was committed. You can try again.';
      saveSubswap();
      return;
    }
  } catch {}
  _drivingIds.add(b0.id);
  const b = b0, asset = b.asset;
  try {
    const deps = { ...subCommonDeps(),
      asset, assetAtoms: BigInt(b.asset_atoms), btcSats: BigInt(b.btc_sats),
      offer: { id: b.offer_id, maker: b.maker_pubkey, relayUrl: b.relay_url || null },
      randomSecret: () => randomSecretHex(),
      lspSwap: (body) => L.swap(body),
      lspSwapStatus: (jobId) => L.swapStatus(jobId),
      lspBridgeHold: (p) => L.bridgeHold(p),
      payHold: async ({ node_id, bolt11, hashH, minFinalCltv, maxCltv, amountMsat, connectHints }) => {
        const node_key = await ensureBtcNodeKey();
        // Pay the LSP's hold BY BARE HASH: our OWN hosted BTC-LN node commits an HTLC to node_id on H with a
        // final-hop CLTV >= minFinalCltv. It lands HELD at the LSP (never captured) and settles only when the LSP
        // recoups with P read from our on-chain asset claim (which we reveal only after verifying the asset in
        // our key). Mirror of the receiver-bridge / sub-asset bare-hash sendpay. The seqln holdinvoice mints no
        // bolt11; if a future fork returns one, pay it (it encodes the destination). The client-side
        // hold-hash/overpay/CLTV pre-pay gates in runLspPayerBridge are the primary guard.
        if (node_id && L.nodePayHash){
          const r = await L.nodePayHash({ node_key, node_id, hash: hashH, amount_msat: amountMsat, min_final_cltv: minFinalCltv, max_cltv: maxCltv, connect_hints: connectHints || undefined });
          if (!(r && (r.committed || r.status === 'pending' || r.status === 'complete'))){
            console.warn('[subswap] BTC-LN hold payment did not commit (nothing captured)');
            throw new Error('This trade could not be completed - your funds are safe.');
          }
          return null;   // we hold P self-custody; this HELD payment yields no new secret
        }
        if (bolt11){
          const r = await L.nodePay({ node_key, bolt11, wantHash: hashH, amountMsat, minFinalCltv, maxCltv });
          if (!(r && (r.paid || r.preimage))){ console.warn('[subswap] BTC-LN hold payment did not go through'); throw new Error('This trade could not be completed - your funds are safe.'); }
          return r.preimage || null;
        }
        console.warn('[subswap] no BTC-LN target returned for the hold payment');
        throw new Error('This trade could not be completed - your funds are safe.');
      },
      persist: (rec) => { b.hash_h = rec.hash_h; b.preimage = rec.preimage; b.job_id = rec.job_id || b.job_id; b.poll = rec.poll || b.poll; if (rec.leg) b.leg = rec.leg;
        // Speed-class signal (label only): carried onto the record so subswapStatusLine can
        // state the true pipeline while the trade runs. Absent = maker-first (slow).
        if (rec.front_mode != null) b.front_mode = rec.front_mode;
        if (rec.expected_wait != null) b.expected_wait = rec.expected_wait;
        b.state = rec.state || b.state; saveSubswap(); },
      onPaid: (preimage, leg) => { b.preimage = preimage; b.leg = leg; b.state = 'claiming'; saveSubswap(); },
      onClaimed: (txid) => { b.seq_claim_txid = txid; b.state = 'settled'; saveSubswap(); },
    };
    await runLspPayerBridge(deps);
  } catch (e){
    console.warn('[subswap] payer-bridge drive error:', e);   // technical detail stays in the console; the UI shows only a plain sentence
    if (b.preimage && b.leg && b.leg.txid){ b.detail = failDetail(e); b.state = 'claiming'; saveSubswap(); }
    else {
      // PRE-COMMITMENT: no preimage and no funded leg, so nothing of the user's moved
      // and a different maker may simply work. This is the LIVE payer-bridge path — the
      // driver the composer actually uses for BTC-LN -> asset-on-chain.
      const why = String((e && e.message) || e || '');
      _drivingIds.delete(b.id);                    // the retry re-enters this driver
      if (retryableHandshakeFailure(why) && advanceSubswapToNextOffer(b, why)) return;
      b.state = 'failed'; b.detail = 'This trade could not be completed - your funds are safe.'; saveSubswap();
    }
  } finally { _drivingIds.delete(b.id); }
  if (b.state === 'settled'){ try { C.toast('Swap settled · the asset is yours.'); } catch {} try { await C.sync(); } catch {} }
}

// Resume a persisted subswap on load. FUND-SAFETY: for a BUY that already learned P + verified the leg
// (state 'claiming') the claim is re-driven idempotently (a crash between the irreversible act and the claim
// never strands the asset). A p2p-sell whose maker never paid is refunded after T_seq. Terminal records are
// dropped. A p2p-buy/lsp-buy still pre-payment cannot resume its live courier session (nothing was
// committed) — it is dropped so it never re-shows.
export async function resumeSubswap(){
  // Every persisted record resumes on its own. With a single slot only one trade could
  // ever be recovered after a reload; the rest were simply lost along with whatever
  // they had committed.
  for (const r of SUBSWAPS.slice()) await resumeOneSubswap(r);
}
async function resumeOneSubswap(b){
  if (!b) return;
  if (subswapTerminal(b)){ clearSubswap(b); return; }
  // (A) A BUY that already learned P + verified the leg (state 'claiming'): re-claim idempotently (a crash
  //     between the irreversible act and the claim must never strand the asset — we hold P).
  if ((b.kind === 'p2p-buy' || b.kind === 'lsp-payer-buy') && b.preimage && b.leg && b.leg.txid){
    try { await claimReverseSeqLeg({ preimage: b.preimage, leg: b.leg, asset: b.asset },
      // CLAIM-WINDOW GATE: an LSP-payer buy still holds the secret self-custody, so claiming is what FIRST reveals
      // it — gate the window (never reveal it if the asset can no longer be claimed before its timeout). A p2p buy
      // ALREADY revealed the secret by PAYING its invoice, so it must always re-claim to recover its asset (no gate).
      { seqClaimKey: C.seqLeg.refundKey(), claimSeq: (p) => C.seqLeg.claim(p),
        seqTip: () => seqTipHeight(), claimMargin: 120, claimWindowGate: (b.kind === 'lsp-payer-buy') });
      b.state = 'settled'; b.seq_claim_txid = b.seq_claim_txid || 'resumed'; saveSubswap(); try { C.toast('Swap settled · the asset is yours.'); } catch {} try { await C.sync(); } catch {} }
    catch (e){ console.warn('[subswap] resume claim error:', e); b.detail = 'Completing your trade - your funds are safe.'; saveSubswap(); }   // leave RESUMABLE; a retry re-claims (we hold P)
    return;
  }
  // (B) CRASH GAP — a reverse-submarine BUY that persisted its leg + bolt11 + H BEFORE the (irreversible) pay
  //     but crashed before learning P (state 'paying'). It MAY have paid, so it must NEVER be silently dropped:
  //     re-query the node for the settled payment on H (idempotent re-pay returns the cached preimage), verify
  //     sha256(P)==H, then claim. Guarded by the claim window (past T_seq we do NOT re-pay). Not recovered ->
  //     keep resumable (a retry re-queries next boot).
  if (b.kind === 'p2p-buy' && b.state === 'paying' && b.leg && b.leg.txid && b.bolt11 && !b.preimage){
    try {
      const node_key = await ensureBtcNodeKey();
      const r = await resumeReversePay({ hash_h: b.hash_h, bolt11: b.bolt11, asset: b.asset, leg: b.leg }, {
        payInvoice: async (bolt11, opts) => { const rr = await L.nodePay({ node_key, bolt11, wantHash: opts && opts.wantHash }).catch(() => null); return rr && rr.preimage ? rr.preimage : null; },
        sha256Hex: (hex) => sha256HexHex(hex), seqClaimKey: C.seqLeg.refundKey(), claimSeq: (p) => C.seqLeg.claim(p),
        seqTip: () => seqTipHeight(), claimMargin: 120,
      });
      if (r.ok && r.recovered){ b.preimage = r.preimage; b.seq_claim_txid = r.seqClaimTxid; b.state = 'settled'; saveSubswap(); try { C.toast('Swap settled · your payment settled and the asset is yours.'); } catch {} try { await C.sync(); } catch {} }
      else { console.warn('[subswap] resume reverse-pay:', r.reason); b.detail = 'Completing your trade · re-checking your Lightning payment.'; saveSubswap(); }   // NEVER dropped
    } catch (e){ console.warn('[subswap] resume error:', e); b.detail = 'Completing your trade - your funds are safe.'; saveSubswap(); }
    return;
  }
  // (C) An LSP PAYER-bridge BUY whose hold is HELD (P self-custody, persisted early) but the maker's asset leg
  //     had not yet arrived (state 'held'/'confirming'): re-poll the LSP for the relayed leg, VERIFY it binds
  //     MY key on H + anchor-buried, then claim with P. Never dropped (the hold may be HELD — only a verified
  //     asset-in-our-key claim reveals P and lets the LSP recoup).
  if (b.kind === 'lsp-payer-buy' && b.preimage && (b.job_id || b.poll) && !(b.leg && b.leg.txid) && (b.state === 'held' || b.state === 'confirming')){
    try {
      const j = await L.swapStatus(b.poll || b.job_id).catch(() => null);
      const terms = j && j.bridge_terms;
      const ml = j && (j.maker_seq_leg || (terms && terms.maker_seq_leg));
      if (ml && ml.txid && terms){
        const claimKey = C.seqLeg.refundKey();
        const v = await verifySubswapSeqLeg({
          hashH: b.hash_h, myClaimPub: claimKey.public_key, makerRefundPub: terms.maker_seq_refund_pub,
          leg: { txid: ml.txid, vout: ml.vout, amount: ml.amount, asset: ml.asset || b.asset, redeem_script: ml.redeem_script, locktime: ml.locktime, block_hash: ml.block_hash },
          expectAsset: b.asset, expectAtoms: BigInt(b.asset_atoms), expectLocktime: Number(terms.seq_locktime) || ml.locktime,
          minAnchorDepth: recordAnchorDepth(b), max0ConfAtoms: 0,
        }, { ...subCommonDeps(), anchorHeightOf: (bh) => anchorHeightOf(bh || ml.block_hash) });
        if (v.ok){
          const leg = { txid: ml.txid, vout: ml.vout, amount: String(ml.amount), asset: b.asset, redeem_script: v.redeem, locktime: Number(terms.seq_locktime) || ml.locktime };
          b.leg = leg; b.state = 'claiming'; saveSubswap();
          // CLAIM-WINDOW GATE (bare-P LSP-payer resume): never reveal the secret if the asset can no longer be
          // claimed strictly before its timeout — else the LSP could settle its HELD Bitcoin while the maker refunds.
          await claimReverseSeqLeg({ preimage: b.preimage, leg, asset: b.asset },
            { seqClaimKey: claimKey, claimSeq: (p) => C.seqLeg.claim(p), seqTip: () => seqTipHeight(), claimMargin: 120, claimWindowGate: true });
          b.state = 'settled'; b.seq_claim_txid = b.seq_claim_txid || 'resumed'; saveSubswap(); try { C.toast('Swap settled · the asset is yours.'); } catch {} try { await C.sync(); } catch {}
        }
      }
      // else: the maker's asset leg has not locked yet -> keep resumable (NEVER dropped).
    } catch (e){ console.warn('[subswap] resume error:', e); b.detail = 'Completing your trade - your funds are safe.'; saveSubswap(); }
    return;
  }
  // (D0) CRASH GAP (SELL fund-loss) — a p2p-sell that PERSISTED P/H/redeem + the intended leg BEFORE it
  //      broadcast the asset HTLC (state 'funding'/'starting') but crashed during the ~12min waitConf. The
  //      asset MAY be funded on-chain, so this record must NEVER be dropped: re-derive the funding outpoint
  //      from the persisted redeem (idempotent — findFundingByAddress), and once found continue to settle/
  //      refund via (D). Still un-findable (broadcast lost / never sent) -> keep resumable (retry next boot).
  if (b.kind === 'p2p-sell' && b.preimage && b.hash_h && b.leg && b.leg.redeem_script && !b.leg.txid){
    try {
      // Bind the funding outpoint from the persisted redeem. Use the STRICT reader so we can tell a genuine
      // "no HTLC output anywhere (confirmed or mempool)" from a transient read error — esplora /utxo includes
      // mempool, so a definitive empty means NOTHING was ever committed.
      let found = null, definitivelyEmpty = false;
      if (C.seqLeg.findFundingByAddressStrict){
        try { const res = await C.seqLeg.findFundingByAddressStrict(b.leg.redeem_script); found = res && res.found; definitivelyEmpty = !found; }
        catch { found = null; definitivelyEmpty = false; }   // read error -> NOT definitive -> keep resumable
      } else {
        found = await C.seqLeg.findFundingByAddress(b.leg.redeem_script).catch(() => null);   // lenient: never treat as definitive
      }
      if (found && found.txid){
        let conf = null; try { conf = await C.seqLeg.waitConf(found.txid, b.leg.redeem_script); } catch {}
        b.leg = { ...b.leg, txid: found.txid, vout: (conf && conf.vout != null) ? conf.vout : (found.vout || 0),
          block_hash: (conf && conf.block_hash) || b.leg.block_hash || null, height: (conf && conf.height) || b.leg.height || null };
        b.state = 'settling'; saveSubswap();
        return resumeSubswap();   // continue at (D): re-check the hold -> settle with P, else refund after T_seq
      }
      // NEVER-CONFIRMED / NEVER-BROADCAST (item 5): the strict read DEFINITIVELY found no HTLC output on-chain
      // OR in the mempool. So the fund tx never broadcast (fundSeq threw before broadcast) or was evicted — NO
      // asset was ever locked, and the live courier session is gone so this swap can no longer complete. Treat
      // it as PRE-COMMITMENT and DROP it cleanly: no dangling 'funding' record wedging the rail, and no
      // double-fund (nothing to fund; fundSeq is idempotent regardless). A transient/unreadable state is NOT
      // definitive -> keep it resumable and retry next boot (never a false drop of a real funded leg).
      if (definitivelyEmpty){ clearSubswap(); return; }
      b.detail = 'Completing your trade · waiting for the asset to appear on-chain.'; saveSubswap();   // NEVER dropped on an unreadable/transient read
    } catch (e){ console.warn('[subswap] resume error:', e); b.detail = 'Completing your trade - your funds are safe.'; saveSubswap(); }
    return;
  }
  // (D) A SELL whose asset HTLC is funded (state 'settling'): FIRST re-check the invoice — if the maker's
  //     payment is HELD, settle it with P to CAPTURE the BTC (and reveal P so the maker claims the asset);
  //     only if it never paid AND T_seq has passed do we reclaim the asset via its CLTV branch. Never a loss.
  if (b.kind === 'p2p-sell' && b.leg && b.leg.txid && b.state === 'settling'){
    try {
      const node_key = b.btc_node_key || await ensureBtcNodeKey();
      let s = null; try { s = await L.invoiceStatus({ node_key, payment_hash: b.hash_h }); } catch {}
      if (s && s.settled){ b.state = 'settled'; saveSubswap(); try { C.toast('Swap settled · you received Bitcoin over Lightning.'); } catch {} try { await C.sync(); } catch {} return; }
      if (s && s.held && b.preimage){
        await L.nodeSettle({ node_key, payment_hash: b.hash_h, preimage: b.preimage });   // capture BTC + reveal P
        b.state = 'settled'; saveSubswap(); try { C.toast('Swap settled · you received Bitcoin over Lightning.'); } catch {} try { await C.sync(); } catch {} return;
      }
      // Not paid: reclaim the asset via its CLTV branch after T_seq (idempotent — a pre-timeout attempt just
      // fails and stays resumable). Nothing else of ours was ever committed.
      const tip = await seqTipHeight();
      if (tip != null && Number(tip) >= Number(b.seq_locktime || 0) && C.seqLeg.refund){
        // FUND-SAFETY: pass a REAL dest_spk (the wallet's OWN script) — the Rust buildSeqHtlcRefundTx requires
        // a String (null throws) — and let seqLeg.refund compute a real any-asset fee (fee:0 -> derived from
        // the asset's published rate), never a bogus 1-atom underpay the mempool would reject.
        await C.seqLeg.refund({ txid: b.leg.txid, vout: b.leg.vout, amount: b.leg.amount, asset_id: b.asset,
          redeem_script: b.leg.redeem_script, locktime: b.seq_locktime, refund_secret: b.refund_secret,
          dest_spk: (C.seqLeg.ownDestSpk ? C.seqLeg.ownDestSpk() : undefined), fee: 0 });
        b.state = 'refunded'; saveSubswap(); try { C.toast('Swap refunded · your asset is back.'); } catch {} try { await C.sync(); } catch {}
      }
    } catch (e){ console.warn('[subswap] resume error:', e); b.detail = 'Completing your trade - your funds are safe.'; saveSubswap(); }
    return;
  }
  // Pre-commitment (no P, no funded leg, no in-flight payment): the live session cannot be resumed and nothing
  // was committed — drop it. (A 'paying' buy / 'held' payer-bridge / funded sell are all handled above and are
  // NEVER reached here, so a record that may have moved value is never silently dropped.)
  clearSubswap();
}

// ONE review sheet at a time (task 19c): a double-click on Review stacked two identical
// modals, each Confirm firing its own trade. Two guards, because the review functions await
// (quotes, provisioning) BEFORE their modal exists: the sentinel covers the opening window,
// the DOM check covers an already-open modal — which the second click focuses, never stacks.
let _reviewOpening = false;
async function onReview(){
  const { $ } = C;
  if (_reviewOpening) return;
  if (typeof document !== 'undefined' && document.querySelector){
    const open = document.querySelector('.modal');
    if (open){ try { if (open.focus) open.focus(); } catch {} return; }
  }
  _reviewOpening = true;
  try { return await _onReviewInner(); }
  finally { _reviewOpening = false; }
}
async function _onReviewInner(){
  const { $ } = C; $('swErr').textContent = '';
  const q = LAST_QUOTE;
  if (!q){ $('swErr').textContent = 'Enter an amount to get a quote first.'; return; }
  // RAIL-BLIND TAKE: before the rail-specific native dispatch, route the BEST-price offer across rails by its
  // signed capabilities (settlementDispatch -> chooseSettlementPath). P2P submarine (both directions) when the
  // maker is interactive + accepts BTC-LN; the LSP leg-bridge (payer for a BUY, receiver for a SELL) on a
  // genuine mismatch. A happy coincidence (native) falls through to the proven native path below. NO
  // offer-then-refuse: a shape that REQUIRES the bridge with an empty book honest-disables here, never
  // falling through to reviewMixed/startMixed (a doomed inline-channel submarine / 422).
  if (q.kind === 'cross' || q.kind === 'mixed' || q.kind === 'ln'){
    const route = q.route || { seqAsset: q.seqAsset, payIsBtc: q.payIsBtc, assetAsset: q.assetAsset };
    const disp = settlementDispatch(route);
    // The taker's ACTUAL submarine rail shapes: a BUY paying BTC over LN + receiving the asset on-chain, or a
    // SELL paying the asset on-chain + receiving BTC over LN. The P2P submarine + the LSP payer bridge only
    // apply when the taker really holds the LN leg for that direction (so a pure-LN taker is never re-routed
    // to an on-chain-receive submarine). The receiver leg-bridge (a SELL) stays exactly as before.
    const pr = route.payRail || S.payRail, rr = route.recvRail || S.recvRail;
    const buySubShape  = !!route.payIsBtc && pr === 'ln' && rr === 'chain';
    const sellSubShape = !route.payIsBtc && pr === 'chain' && rr === 'ln';
    // A submarine shape (BUY pay-BTC-over-LN / receive asset on-chain, or SELL pay-asset-on-chain / receive
    // BTC-over-LN) is settled PEER-TO-PEER or via the LSP leg-bridge — it has NO native/inline-channel path.
    // Route EVERY such shape here and RETURN in every branch: it must NEVER fall through to reviewMixed/
    // startMixed (a doomed inline-channel submarine / 422) or offer-then-refuse.
    if (buySubShape || sellSubShape){
      // Empty rail-blind book -> the ONLY empty-liquidity message (no rail / counterparty vocab).
      if (!disp || !disp.offer){
        $('swErr').textContent = 'No offers resting here yet.';
        return;
      }
      // The best offer rests its ASSET over Lightning, so this crossing has no on-chain asset leg to settle
      // (dispatch -> 'unsupported'). Honest-disable, never misroute into a doomed submarine.
      if (disp.path === 'unsupported'){
        $('swErr').textContent = `This trade could not be placed right now - try again shortly.`;
        return;
      }
      if (disp.path === 'p2p-submarine') return reviewSubmarineP2P(route, disp);   // DIRECT peer-to-peer (both directions)
      if (disp.path === 'lsp-bridge'){
        // BUY fallback vs an on-chain-only / passive maker: the LSP bridges the taker's BTC-LN <-> the maker's
        // on-chain BTC HTLC on ONE shared secret. ENABLED now the taker pays the LSP's hold by BARE HASH (the
        // seqln holdinvoice mints no bolt11) — reviewLspPayerBridge -> startLspPayerBridge -> the bare-hash
        // driver. reviewLspPayerBridge fails closed (payerBridgeDisabledNote) if the LSP returns no usable target.
        if (disp.lnSide === 'payer' && buySubShape && disp.bridged && disp.supported) return reviewLspPayerBridge(route, disp);
        // SELL via the existing receiver leg-bridge — ONLY when the LSP actually settles this crossing shape.
        if (disp.lnSide === 'receiver' && sellSubShape && disp.bridged && disp.supported) return reviewBridged(route, disp);
        // Any other lsp-bridge shape here (e.g. no supported receiver bridge) -> honest-disable, never startMixed.
        $('swErr').textContent = `This trade could not be placed right now - try again shortly.`;
        return;
      }
      // path === 'native' for a declared sub-shape means no routable settlement -> genuine fail-closed.
      $('swErr').textContent = 'This trade could not be placed right now - try again shortly.';
      return;
    }
  }
  if (q.kind === 'cross-make'){
    // BUY-with-BTC LIMIT + "keep resting while offline" ON -> the SBTC silent peg: rest as a covenant
    // that survives the wallet closing (spec §5). `reverse` = BUY the asset with BTC (the only side
    // that PAYS BTC). Everything else (SELL for BTC, toggle OFF, or no SBTC on this network) stays on
    // the interactive HTLC maker path.
    if (q.reverse && S.keepResting && payingBtcOnChain() && sbtcAssetId()) return postPeggedBtcReview(q);
    return postCrossOfferReview(q);
  }
  if (q.kind === 'ln') return reviewLn(q);
  if (q.kind === 'mixed') return reviewMixed(q);
  if (q.kind === 'cross') return reviewCross(q);
  if (q.kind === 'same' && q.takeMkt) return takeCovenantWalkReview(q);   // MARKET: walk the book, never rest
  if (q.kind === 'same' && q.place) return placeCovenantReview(q);        // LIMIT: rest a covenant
  return reviewSame(q);
}

// ===========================================================================
// Passive-CLOB covenant resting orders (the same-chain "Place order" path)
// ---------------------------------------------------------------------------
// Placing funds a byte-exact covenant UTXO and rests a signed offer on the relay;
// the order fills whenever it is crossed (by an online taker or the settler),
// permissionlessly, EVEN WHILE THIS WALLET IS OFFLINE — consensus rejects any
// underpay or redirect. When THIS wallet is the taker of an inbound match, it
// verifies the recipe trustlessly and broadcasts the FILL itself.
// ===========================================================================
let COMPANION = null;      // the `eltr` taproot Wollet that WATCHES + spends maker credits
let COVRELAY = null;       // the persistent openRelay handle (matched / order_status)
let PLACED = [];           // this wallet's covenant orders (persisted for cancel + resume)
const PLACED_KEY = 'seqobCovenantOrders.v1';

function loadPlaced(){ try { PLACED = JSON.parse(localStorage.getItem(PLACED_KEY) || '[]') || []; } catch { PLACED = []; } }
function savePlaced(){ try { localStorage.setItem(PLACED_KEY, JSON.stringify(PLACED)); } catch {} }
function nextMakerIndex(){
  let mx = -1; for (const r of PLACED){ if (typeof r.makerIndex === 'number' && r.makerIndex > mx) mx = r.makerIndex; }
  return mx + 1;   // a fresh taproot payout per order, so credits never collide
}

// The companion Wollet: the primary wallet is wpkh (BIP84) and does not track the
// taproot maker-credit payouts, so a second `eltr` (BIP86) Wollet watches them. It
// MUST be registered + scanned so a maker actually sees the funds it is paid.
function ensureCompanion(){
  if (COMPANION) return COMPANION;
  try { COMPANION = new C.wasm.Wollet(C.network, C.signer.covenantMakerDescriptor()); }
  catch { COMPANION = null; }
  return COMPANION;
}
async function scanCompanion(){
  const w = ensureCompanion(); if (!w) return;
  try { const u = await C.client.fullScan(w); if (u) w.applyUpdate(u); } catch {}
}

async function esplora(path, opts){ return C.esploraFetch(path, opts); }

// Fund a covenant spk: send `atoms` of asset A to the covenant address as an
// explicit output (the proven TxBuilder -> sign -> finalize -> broadcast path),
// then resolve the covenant vout by matching the spk on the broadcast tx.
async function fundCovenant(covAddr, spkHex, assetHex, atoms, feeAsset){
  const addr = new C.wasm.Address(covAddr);
  // C-1: pay the funding fee in the CHOSEN fee asset (open fee market), not silently in tSEQ. applyFee
  // prices any asset — tSEQ included — from the feed, so the fee the user is shown ("Fee paid in: X") is
  // the fee actually charged. Falls back to the pay asset if no fee asset was resolved.
  const b = C.network.txBuilder().addExplicitRecipient(addr, BigInt(atoms), new C.wasm.AssetId(assetHex));
  const pset = C.applyFee(b, feeAsset || assetHex).finish(C.wollet);
  const signed = C.signer.sign(pset);
  const finalized = C.wollet.finalize(signed);
  const t = await C.client.broadcast(finalized);
  try { C.wollet.applyTransaction(finalized); } catch {}   // spend-tracking: the scan is minutes stale
  const txid = (t && t.toString) ? t.toString() : String(t);
  const vout = await resolveVout(txid, spkHex);
  return { txid, vout };
}
async function resolveVout(txid, spkHex){
  const spk = (spkHex||'').toLowerCase();
  for (let i=0;i<20;i++){
    try {
      const res = await esplora(`/tx/${txid}`);
      if (res && res.ok){ const tx = await res.json();
        for (let v=0; v<(tx.vout||[]).length; v++){ if ((tx.vout[v].scriptpubkey||'').toLowerCase() === spk) return v; } }
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return 0;   // best-effort fallback; the taker's FILL re-verifies the spk before spending
}

// place: derive the covenant, get the maker payout (register the companion wollet
// so the credit is watchable), fund it on-chain, then sign + post the resting offer.
// The partial-fill dust floor for a placed order: the smallest lot a taker may fill AND the
// smallest remainder that may re-rest (planFill rejects a fill leaving a smaller remainder as
// dust-griefing). ~0.1% of the order (min 1 atom) — fine-grained enough that a market order fills
// almost all of the available book, coarse enough that no dust remainder is ever left.
// FUND-SAFETY: this divisor is CONSENSUS-FROZEN and must NOT read CONFIG.minLotBps. The value is baked
// into the covenant's fill leaf (→ merkle root → tweaked key) at placement and re-derived here at fill;
// the resting record does not store it. If it tracked a mutable /status value, a min-lot change between
// place and fill would compute a different leaf and strand the order. CONFIG.minLotBps is display-only.
function covenantMinLot(sellAtoms){ const s = BigInt(sellAtoms); const f = s / 1000n; return f > 0n ? f : 1n; }

// BYTE ORDER — the one covenant conversion boundary. The wallet/UI/registry/relay-pair domain
// speaks DISPLAY hex asset ids (reversed, like txids); the covenant leaf + CovenantTerms speak
// INTERNAL byte order (as on-chain introspection returns them — the relay convention: pair =
// display, terms = internal; see seqdex watcher.go reverseHex / covfill.go displayHex).
function revHex(h){ return (String(h || '').match(/../g) || []).reverse().join(''); }

// The asset ids a covenant's taptree is derived from, for a given record generation.
//   idsInternal true  (every NEW record) -> flip the DISPLAY ids to INTERNAL byte order, so the
//     leaf bakes the ids consensus introspection actually compares — the seeder-proven derivation.
//   idsInternal false (LEGACY records, no marker) -> keep the DISPLAY ids: those covenants were
//     funded against a display-order-derived spk (the old bug), and their cancel/REFUND must
//     re-derive the SAME bug-compatible taptree or the locked funds become unreclaimable.
// Records persist DISPLAY ids (rec.pay/rec.receive) in both generations; only the derivation flips.
function covenantDerivationIds(payDisplay, receiveDisplay, idsInternal){
  return idsInternal ? { assetA: revHex(payDisplay), assetB: revHex(receiveDisplay) }
                     : { assetA: payDisplay, assetB: receiveDisplay };
}

async function placeCovenant(pay, receive, payAtoms, recvAtoms, onStatus, opts){
  opts = opts || {};
  const tip = C.wollet.tip().height();
  const { rateNum, rateDen } = computeRate(payAtoms, recvAtoms);
  const idx = nextMakerIndex();
  const payout = makerPayout(C.signer, C.network, idx);   // { program, spkHex, address, internalKey, descriptor }
  ensureCompanion();                                      // so this wallet SEES the credit it is paid
  const minLot = covenantMinLot(payAtoms);                // PARTIAL-fillable (was all-or-nothing minLot==sell)
  const params = {
    // pay/receive arrive as DISPLAY hex (the UI/wallet domain); planPlaceOrder's contract is
    // INTERNAL-order ids (they are baked into the fill leaf that on-chain introspection compares),
    // so convert here — the boundary. Everything else in this function stays DISPLAY.
    ...covenantDerivationIds(pay, receive, true),
    sellAtoms: BigInt(payAtoms),
    rateNum, rateDen, minLot,                             // a taker may fill any lot >= minLot; the covenant re-rests the remainder
    expiryLocktime: orderExpiry(tip),
    makerProg: payout.program,                            // the taproot payout the FILL credits
    makerX: payout.internalKey,                           // wallet-derived x-only REFUND authoriser
  };
  const plan = planPlaceOrder(params);
  const covAddr = C.wasm.scriptToAddress(plan.spkHex, C.network);
  // FUND-SAFETY (persist-BEFORE-broadcast): fundCovenant broadcasts the on-chain funding tx and then
  // polls ~30s to resolve the vout. A tab close/crash/reload in that window would lock asset A in a
  // covenant with NO local record — permanently stranded, because the reclaim needs makerIndex +
  // sellAtoms/recvAtoms + expiry + spkHex to re-derive the refund taptree. So persist the full reclaim
  // material NOW, with covTxid null; resumeCovenantOrders locates the outpoint by spkHex on the next
  // load if we die mid-broadcast. offerId is minted here (deterministic, no dependence on the funded tx).
  const offerId = seqob.randHex(16);
  const rec = {
    offerId, pay, receive,
    sellAtoms: String(payAtoms), recvAtoms: String(recvAtoms),
    makerIndex: idx, covTxid: null, covVout: null, spkHex: plan.spkHex,
    expiry: params.expiryLocktime, created: Date.now(), posted: false,
    // GENERATION MARKER (fund safety): this covenant's taptree was derived from INTERNAL-order
    // asset ids (the fix). A record WITHOUT this marker predates the fix — its spk was derived
    // from DISPLAY-order ids, and every re-derivation (repost/cancel/refund) must reproduce that
    // bug-compatible taptree via covenantDerivationIds(.., .., false). Never migrate old records.
    idsInternal: true,
    // SBTC silent peg: the covenant locks `pay` (SBTC) but was ADVERTISED as `advertiseOfferAssetAs`
    // (BTC). Tag it so the cancel/refund path knows to peg the reclaimed SBTC back OUT to real BTC
    // (the user paid BTC and expects BTC back). Absent for ordinary same-chain orders.
    ...(opts.advertiseOfferAssetAs ? { pegged: true, advertiseAs: opts.advertiseOfferAssetAs } : {}),
  };
  PLACED.push(rec); savePlaced();
  onStatus && onStatus('Funding the order on-chain…');
  const { txid, vout } = await fundCovenant(covAddr, plan.spkHex, pay, payAtoms, feeAssetPolicy().asset);
  rec.covTxid = txid; rec.covVout = vout; savePlaced();   // outpoint known -> reclaim is fully self-contained
  const covenant = buildCovenantTerms(plan.order, txid, vout, plan.tap);
  const offer = buildCovenantOffer({
    assetA: pay, assetB: receive, sellAtoms: BigInt(payAtoms), recvAtoms: BigInt(recvAtoms),
    covenant, makerPubkey: makerPubHex(), recvAddress: payout.address, offerId,
    allowPartial: true, minLot,                           // fill what crosses now; the covenant's remainder rests on
    advertiseOfferAssetAs: opts.advertiseOfferAssetAs,     // SBTC peg: advertise BTC while the covenant locks SBTC
  });
  onStatus && onStatus('Posting your resting order…');
  await seqob.postCovenantOffer(offer, makerPriv());
  rec.posted = true; savePlaced();   // the relay accepted it; it is now a live resting order
  ensureCovenantRelay();   // watch for a match so we can settle / reflect a fill
  return rec;
}

// ---------------------------------------------------------------------------
// SBTC silent peg — rest an on-chain-BTC LIMIT order while the wallet is offline
// ---------------------------------------------------------------------------
// The ONE place SBTC touches the DEX (spec §5, sbtc-peg-design.md). Used ONLY for BUY-with-BTC LIMIT
// orders with "keep resting while offline" ON. Everything else (market orders, any Lightning leg,
// selling an asset for BTC) stays pure native BTC on the interactive cross rail.

// The SBTC asset id, resolved from the registry (ticker SBTC), or null if the bridge asset isn't
// registered on this network — then the silent peg is simply unavailable and we fall back to native.
function sbtcAssetId(){
  try { return sbtc.resolveSbtcAsset((C.registryAssets && C.registryAssets()) || [], (h) => (C.assetMeta(h) || {}).ticker); }
  catch { return null; }
}

// Persisted pending peg-ins so a BUY-with-BTC resting order survives the wallet closing during the
// (multi-block) peg-in wait and resumes to post its covenant on reopen. FUND-SAFETY: the bridge
// credits SBTC to `seqAddr` regardless of this wallet, so a crash never loses funds — worst case the
// user simply holds SBTC to reconcile, and resumePegIns finishes the covenant post next load.
const PEGPENDING_KEY = 'swk.sequentia.pegpending';
function loadPegPending(){ try { return JSON.parse(localStorage.getItem(PEGPENDING_KEY) || '[]'); } catch { return []; } }
function savePegPending(list){ try { localStorage.setItem(PEGPENDING_KEY, JSON.stringify(list)); } catch {} }
function upsertPegPending(rec){ const l = loadPegPending().filter((r) => r.id !== rec.id); l.push(rec); savePegPending(l); }
function dropPegPending(id){ savePegPending(loadPegPending().filter((r) => r.id !== id)); }

// Poll THIS wallet's SBTC balance until it has risen by >= `amount` (the bridge minted the peg-in).
// Generous timeout: a peg-in needs BTC confirmations. The caller shows a waiting status; on timeout
// the funds are safe (SBTC will still arrive) and the order can be re-opened once credited.
async function awaitSbtcCredit(sbtcHex, before, amount, timeoutMs){
  const deadline = Date.now() + (timeoutMs || 45 * 60 * 1000);
  while (Date.now() < deadline){
    try { if (C.refreshBalances) await C.refreshBalances(); } catch {}
    if (balAtoms(sbtcHex) - before >= amount) return true;
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('Your Bitcoin is safe; your balance will update shortly. Re-open the order once it does.');
}

// Maker flow: peg the maker's real BTC IN to SBTC, then rest that SBTC in a covenant ADVERTISED as a
// BTC offer on the asset/BTC market (advertiseOfferAssetAs='BTC') so BTC takers find + fill it (and
// peg out to real BTC). btcSats = BTC paid; assetHex/assetAtoms = the asset + amount wanted.
async function placePeggedBtcCovenant(assetHex, btcSats, assetAtoms, onStatus){
  const sbtcHex = sbtcAssetId();
  if (!sbtcHex) throw new Error('Offline-resting BTC orders aren’t available on this network. Turn off “keep resting while offline” to place this order.');
  if (BigInt(btcSats) <= 0n || BigInt(assetAtoms) <= 0n) throw new Error('Enter both the BTC you pay and the amount you want.');
  const haveBtc = balAtoms('BTC');
  if (BigInt(btcSats) > haveBtc) throw new Error(`You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`);

  // A fresh TRANSPARENT Sequentia address of THIS wallet to receive the minted SBTC (principle #6).
  const seqAddrRaw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const seqAddr = (seqAddrRaw.toUnconfidential ? seqAddrRaw.toUnconfidential() : seqAddrRaw).toString();

  onStatus && onStatus('Setting up your order …');
  const depositAddr = await sbtc.requestPegIn(seqAddr);

  // Persist the intent BEFORE broadcasting the BTC deposit, so a crash after broadcast can resume.
  const rec = { id: seqob.randHex(8), seqAddr, depositAddr, btcSats: String(btcSats),
                assetHex, assetAtoms: String(assetAtoms), sbtcHex, btcTxid: null,
                beforeSbtc: String(balAtoms(sbtcHex)), phase: 'depositing', created: Date.now() };
  upsertPegPending(rec);

  onStatus && onStatus('Sending your Bitcoin …');
  await C.btcLeg.payAddress(depositAddr, Number(btcSats), (txid) => {
    rec.btcTxid = txid; rec.phase = 'minting'; upsertPegPending(rec);
  });

  onStatus && onStatus('Setting up your order …');
  await awaitSbtcCredit(sbtcHex, BigInt(rec.beforeSbtc), BigInt(btcSats));

  onStatus && onStatus('Resting your order…');
  const posted = await placeCovenant(sbtcHex, assetHex, BigInt(btcSats), BigInt(assetAtoms), onStatus,
    { advertiseOfferAssetAs: 'BTC' });
  dropPegPending(rec.id);   // peg-in complete + order resting
  return posted;
}

// Resume any peg-in that was mid-flight when the wallet last closed: if its SBTC has since been
// credited, finish by posting the covenant; otherwise leave it pending (it will credit and resume
// later). Called on load, alongside resumeCovenantOrders. Never re-sends BTC (idempotent by record).
export async function resumePegIns(){
  for (const rec of loadPegPending()){
    try {
      if (!rec.btcTxid) { dropPegPending(rec.id); continue; }   // never broadcast; nothing pegged in
      const have = balAtoms(rec.sbtcHex) - BigInt(rec.beforeSbtc || '0');
      if (have < BigInt(rec.btcSats)) continue;                 // not yet credited; leave it pending
      await placeCovenant(rec.sbtcHex, rec.assetHex, BigInt(rec.btcSats), BigInt(rec.assetAtoms), null,
        { advertiseOfferAssetAs: 'BTC' });
      dropPegPending(rec.id);
    } catch (e){ /* leave pending; a later load retries */ }
  }
}

// TAKER path: fill a resting pegged-BTC covenant (a bid advertised as BTC, locking SBTC) by posting a
// crossing order over the covenant relay WS. The relay matches it against the covenant and hands us
// the terms; onCovMatched settles the fill (we pay `assetHex`, receive SBTC) and then pegs the SBTC
// out to real BTC. assetHex/assetAtoms = what we pay; btcSats = the BTC we're buying.
async function takePeggedCovenant(assetHex, assetAtoms, btcSats, onStatus){
  if (BigInt(assetAtoms) <= 0n || BigInt(btcSats) <= 0n) throw new Error('Enter both amounts.');
  const m = C.assetMeta(assetHex);
  const have = balAtoms(assetHex);
  if (BigInt(assetAtoms) > have) throw new Error(`You only hold ${C.fmtAtoms(have, m.precision)} ${m.ticker}.`);
  // Watch the covenant's market (BTC/asset shelf) so onCovMatched fires + settles when we cross it.
  if (!EXTRA_COV_MARKETS.some((x) => x.base_asset === 'BTC' && x.quote_asset === assetHex))
    EXTRA_COV_MARKETS.push({ base_asset: 'BTC', quote_asset: assetHex });
  ensureCovenantRelay();
  const raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const recvAddr = (raw.toUnconfidential ? raw.toUnconfidential() : raw).toString();
  const now = Math.floor(Date.now() / 1000);
  // BUY base=BTC with quote=asset on the BTC/asset shelf — the counter-side of the covenant's SELL of
  // BTC (validator BUY: offer_asset==quote, want_asset==base, want_amount==base_amount).
  const offer = {
    offer_id: seqob.randHex(16), schema_version: 1,
    pair: { base_asset: 'BTC', quote_asset: assetHex },
    trade_dir: 2,                                    // BUY
    base_amount: String(btcSats),
    offer_amount: String(assetAtoms), offer_asset: assetHex,
    want_amount: String(btcSats),  want_asset: 'BTC',
    allow_partial: true,
    created_at_unix: String(now), expires_at_unix: String(now + 3600),
    fee_asset_hint: assetHex,
    same_chain: { maker_recv_address: recvAddr },    // for any resting remainder
  };
  seqob.signOffer(offer, makerPriv());
  onStatus && onStatus('Posting your order to cross the resting bid…');
  await postToCovRelay(offer);
  return { offerId: offer.offer_id };
}

// Post an offer over the covenant relay WS (so a resulting match routes back to onCovMatched). Waits
// briefly for the WS to open. Reuses the shared COVRELAY (already carrying the onMatched -> settle +
// peg-out wiring); the market must already be subscribed (takePeggedCovenant adds it).
async function postToCovRelay(offer){
  ensureCovenantRelay();
  if (!COVRELAY) throw new Error('order-book relay unavailable');
  const ws = COVRELAY.ws;
  if (!(ws && ws.readyState === 1)){
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the order-book relay did not open in time')), 8000);
      const tick = () => {
        if (ws && ws.readyState === 1){ clearTimeout(t); resolve(); }
        else if (!ws || ws.readyState >= 2){ clearTimeout(t); reject(new Error('relay connection closed')); }
        else setTimeout(tick, 150);
      };
      tick();
    });
  }
  COVRELAY.post(offer);
}

// Send `atoms` of a Sequentia asset to `toAddr` (a plain transfer; fee in the chosen fee asset).
// Used by the taker peg-OUT to hand the just-received SBTC back to the bridge.
async function sendSeqAsset(toAddr, assetHex, atoms){
  const addr = new C.wasm.Address(toAddr);
  const b = C.network.txBuilder().addExplicitRecipient(addr, BigInt(atoms), new C.wasm.AssetId(assetHex));
  const pset = C.applyFee(b, feeAssetPolicy().asset).finish(C.wollet);
  const signed = C.signer.sign(pset);
  const finalized = C.wollet.finalize(signed);
  const t = await C.client.broadcast(finalized);
  try { C.wollet.applyTransaction(finalized); } catch {}   // spend-tracking: the scan is minutes stale
  return (t && t.toString) ? t.toString() : String(t);
}

// Peg the taker's just-received SBTC back OUT to real BTC. When a taker fills a covenant that was
// ADVERTISED as BTC (the SBTC silent peg), the on-chain fill pays them in SBTC — but they were buying
// BTC, so the wallet immediately redeems it: ask the bridge for a peg-out address bound to a wallet
// BTC address, send the SBTC there, and the bridge releases real BTC. Best-effort + safe: on any
// failure the user simply holds redeemable SBTC (never lost). `atoms` = the SBTC just received.
async function pegOutReceivedSbtc(atoms){
  if (BigInt(atoms) <= 0n) return;
  const btcDest = C.btcLeg && C.btcLeg.receiveAddress ? C.btcLeg.receiveAddress() : null;
  if (!btcDest) throw new Error('no BTC address to redeem to');
  const sbtcAddr = await sbtc.requestPegOut(btcDest);
  await sendSeqAsset(sbtcAddr, sbtcAssetId(), BigInt(atoms));
  try { C.toast && C.toast('Returning your Bitcoin …'); } catch {}
}

// TRUE if an inbound covenant match paid us in SBTC for what we were buying as BTC — i.e. we lifted a
// silent-peg bid (advertised BTC, locks SBTC) and must peg the SBTC out. Distinguished from a genuine
// SBTC trade (where the market itself is SBTC/…, so the advertised pair carries no BTC sentinel).
function isPeggedFillToRedeem(m){
  const ct = m.covenant || m.Covenant || {};
  const gotAsset = String(ct.asset_a || ct.assetA || '').toLowerCase();
  const sbtcHex = (sbtcAssetId() || '').toLowerCase();
  // ct.asset_a is INTERNAL byte order (CovenantTerms convention); the registry's SBTC id is
  // DISPLAY hex — compare in the terms' order.
  if (!sbtcHex || gotAsset !== revHex(sbtcHex)) return false;   // we didn't receive SBTC
  const pair = m.pair || m.Pair || {};
  const advertisedBtc = String(pair.base_asset || pair.baseAsset || '') === 'BTC'
    || String(pair.quote_asset || pair.quoteAsset || '') === 'BTC';
  return advertisedBtc;                                          // received SBTC on a BTC-advertised market -> redeem
}

// W5 — SBTC MIS-SELL BINDING. A BTC-advertised covenant is treated as a pegged-BTC (SBTC silent-peg) bid:
// filling it pays the taker in SBTC that the wallet then auto-redeems to real BTC. That promise is ONLY
// sound if the covenant actually LOCKS SBTC. A malicious maker can rest a covenant that locks a WORTHLESS
// asset while advertising the row on a BTC market; a taker who fills it pays real EURX/GOLD and receives
// junk. So before quoting/taking such a row we REQUIRE covenant.asset_a to be exactly the given asset id.
// Pure (no C/sbtc dependency) so it is unit-testable; the live callers pass sbtcAssetId().
export function covenantLocksAsset(offer, expectedAssetHex){
  const ct = (offer && (offer.covenant || offer.Covenant)) || {};
  const locked = String(ct.asset_a || ct.assetA || '').toLowerCase();
  const want = String(expectedAssetHex || '').toLowerCase();
  return !!want && locked === want;                              // empty/absent expected id -> false (fail closed)
}
// TRUE iff a BTC-advertised covenant genuinely locks SBTC (so it is safe to fill as a pegged-BTC bid and
// auto-redeem the received SBTC to real BTC). Returns false when SBTC is unavailable on this network — a
// covenant can then never be mis-sold as pegged BTC.
// covenant.asset_a in the offer's terms is INTERNAL byte order; the registry id is DISPLAY —
// hand the guard the expected id in the terms' own order (empty stays empty: fail closed).
function peggedCovenantLocksSbtc(offer){ const s = sbtcAssetId(); return covenantLocksAsset(offer, s ? revHex(s) : s); }

// SBTC peg-OUT resume (F-FS3). pegOutReceivedSbtc broadcasts (sendSeqAsset), so a failure can leave the
// received SBTC un-redeemed with no follow-up — the old "auto-redeem will retry" toast promised a retry
// that did not exist. Persist the pending amount and retry it ONCE on next load, guarded by the LIVE SBTC
// balance so a strand (broadcast-then-throw) can never double-send: if the balance no longer covers the
// amount, the SBTC already left, so skip. One-shot (cleared up front) so a mid-retry reload can't re-fire.
const PEGOUT_PENDING_KEY = 'swk.sequentia.pegoutpending';
function loadPegOutPending(){ try { return JSON.parse(localStorage.getItem(PEGOUT_PENDING_KEY) || '[]'); } catch { return []; } }
function savePegOutPending(list){ try { localStorage.setItem(PEGOUT_PENDING_KEY, JSON.stringify(list)); } catch {} }
function recordPendingPegOut(atoms){
  try { const l = loadPegOutPending(); l.push({ id: 'po:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), atoms: String(atoms) }); savePegOutPending(l); } catch {}
}
export async function resumePegOuts(){
  const list = loadPegOutPending();
  if (!list.length) return;
  savePegOutPending([]);                                          // one-shot: clear up front so a reload mid-retry can't double-fire
  const sbtcHex = (sbtcAssetId() || '').toLowerCase();
  for (const rec of list){
    try {
      const atoms = BigInt(rec.atoms || 0);
      if (atoms <= 0n) continue;
      try { if (C.refreshBalances) await C.refreshBalances(); } catch {}
      if (!sbtcHex || balAtoms(sbtcHex) < atoms) continue;        // already redeemed/spent -> never double-send
      await pegOutReceivedSbtc(atoms); await C.sync();
    } catch { /* still redeemable from the Balance tab; not re-queued, to avoid an unbounded double-send loop */ }
  }
  try { renderSwap(); } catch {}
}

// The taker FILL hooks for an inbound match: the credit asset is asset B, so the fee
// is paid in B too (never asset A — the covenant-fill host rejects that). Amounts are
// coin-selected from THIS wallet's own B + fee UTXOs by the wasm assembler.
function fillHooksFor(matched){
  const ct = matched.covenant || matched.Covenant || {};
  // CovenantTerms carry INTERNAL-order ids; the fee/wallet domain (feeRateFor, coin selection,
  // wasm AssetId) speaks DISPLAY hex — flip at the boundary.
  const assetB = revHex(String(ct.asset_b || ct.assetB || '').toLowerCase());
  const feeAsset = assetB || C.POLICY_HEX;
  return makeCovenantHooks({
    wasm: C.wasm, wollet: C.wollet, network: C.network, mnemonic: C.mnemonic,
    esploraFetch: C.esploraFetch,
    receiveAddress: covReceiveAddr,   // transparent by default (#6); blinded only if the user opted in
    fee: { asset: feeAsset, atoms: covFeeAtoms(feeAsset) },
    onStatus: (m) => { try { C.toast && C.toast(m); } catch {} },
  });
}
// A network-fee estimate in the given fee asset (open fee market): the native policy
// fee converted via the asset's published exchange rate (a valuable asset pays fewer).
function covFeeAtoms(feeAsset){
  try {
    const rate = C.feeRateFor(feeAsset);   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
    const nativeFeeSats = (BigInt(C.DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;
    return ceilDiv(nativeFeeSats * BigInt(C.EXCHANGE_RATE_SCALE), rate);
  } catch { return 1000n; }
}
// The same-chain covenant fee in the fee asset's HUMAN units (for a trade-history receipt). Best-effort.
function covFeeUnits(feeAsset){
  try { return Number(covFeeAtoms(feeAsset)) / Math.pow(10, C.assetMeta(feeAsset).precision || 0); }
  catch { return null; }
}

// Reconstruct the exact covenant Order a local PLACED record placed, so its
// scriptPubKey / taptree re-derive byte-identically for the REFUND reclaim. Throws
// if the re-derived spk does not match the funded one (a corrupt/foreign record).
function orderFromPlaced(rec){
  const payout = makerPayout(C.signer, C.network, rec.makerIndex);
  const { rateNum, rateDen } = computeRate(BigInt(rec.sellAtoms), BigInt(rec.recvAtoms));
  const order = {
    // BYTE ORDER (fund safety): derive with the record's OWN generation. New records
    // (rec.idsInternal) baked INTERNAL-order ids into the funded taptree; legacy records baked
    // DISPLAY-order ids (the old bug) and their REFUND must re-derive that same taptree —
    // "fixing" a legacy record here would strand its locked coins forever.
    ...covenantDerivationIds(rec.pay, rec.receive, !!rec.idsInternal),
    // minLot MUST equal what placeCovenant committed into the funded covenant
    // (covenantMinLot(sellAtoms) = sellAtoms/1000), NOT the all-or-nothing sellAtoms:
    // minLot is pushed into the fill leaf, which sets the merkle root, the tweaked
    // output key/spk AND the refund control block's sibling hash. The old
    // BigInt(rec.sellAtoms) re-derived a DIFFERENT taptree, so every cancel/refund
    // built a consensus-invalid taproot spend and the locked asset was unreclaimable.
    rateNum, rateDen, minLot: covenantMinLot(BigInt(rec.sellAtoms)),
    makerProg: payout.program, makerVer: 1,
    expiryLocktime: Number(rec.expiry), makerX: payout.internalKey,
  };
  // The promised guard (was missing): re-derive the spk and refuse to build a refund
  // against a record whose taptree does not reproduce the funded covenant. verifyAgainstSPK
  // throws loudly on a mismatch — better than silently broadcasting a consensus-invalid spend.
  if (rec.spkHex) covVerifyAgainstSPK(order, rec.spkHex);
  return { order, payout };
}

// The maker REFUND hooks: reclaim an expired covenant's locked asset A. The fee is
// paid in the policy asset (universally accepted) from the wallet's own coins; the
// covenant asset A is never the fee asset here, so the reclaimed A is returned whole.
function refundHooksFor(){
  const feeAsset = C.POLICY_HEX;
  return makeCovenantHooks({
    wasm: C.wasm, wollet: C.wollet, network: C.network, mnemonic: C.mnemonic,
    esploraFetch: C.esploraFetch,
    receiveAddress: covReceiveAddr,   // transparent by default (#6); blinded only if the user opted in
    fee: { asset: feeAsset, atoms: covFeeAtoms(feeAsset) },
    onStatus: (m) => { try { C.toast && C.toast(m); } catch {} },
  });
}

// The persistent relay watcher over every market this wallet has a resting order on.
// onMatched -> this wallet is the taker: verify + FILL + broadcast. onOrderStatus ->
// our resting order was filled by someone else: rescan so the credit shows up.
// Extra markets the covenant relay must also watch even without a resting order of ours on them:
// when we are the TAKER crossing someone's covenant (e.g. lifting a pegged-BTC bid), we must be
// subscribed so onCovMatched fires and we settle the fill. Added by takePeggedCovenant.
let EXTRA_COV_MARKETS = [];
function covMarkets(){
  const seen = new Set(), out = [];
  const add = (base, quote) => { const k = base+'/'+quote; if (!seen.has(k)){ seen.add(k); out.push({ base_asset: base, quote_asset: quote }); } };
  for (const r of PLACED){ add(r.pay, r.receive); }
  for (const m of EXTRA_COV_MARKETS){ add(m.base_asset, m.quote_asset); }
  return out;
}
function ensureCovenantRelay(){
  const markets = covMarkets();
  if (!markets.length){ if (COVRELAY){ COVRELAY.close(); COVRELAY = null; } return; }
  if (COVRELAY){ for (const m of markets) COVRELAY.subscribe(m); return; }
  COVRELAY = seqob.openRelay(markets, {
    onMatched: (m) => { onCovMatched(m).catch(()=>{}); },
    onOrderStatus: (s) => { onCovOrderStatus(s).catch(()=>{}); },
    onError: () => {},
  });
}
async function onCovMatched(m){
  // Only settle covenant matches (interactive same-chain lifts go through seqob.lift).
  const isCov = m.resting_is_covenant === true || m.restingIsCovenant === true
    || m.resting_is_covenant === 'true' || m.restingIsCovenant === 'true';
  if (!isCov) return;
  try {
    C.toast && C.toast('Order matched · settling the fill on-chain…');
    const { txid } = await covSettleFill(m, fillHooksFor(m));
    C.toast && C.toast('Fill settled.',
      txid ? { href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…' } : undefined);
    await C.sync(); await scanCompanion(); try { renderSwap(); } catch {}
    // SBTC silent peg (taker side): if this fill paid us SBTC on a BTC-advertised market, we were
    // buying real BTC — peg the received SBTC back OUT. Best-effort: on failure we simply hold
    // redeemable SBTC (fund-safe). The amount received is the covenant fill's base (asset_a) amount.
    if (isPeggedFillToRedeem(m)){
      const got = BigInt(m.fill_base_amount || m.fillBaseAmount || m.covenant_locked || m.covenantLocked || 0);
      try { await pegOutReceivedSbtc(got); await C.sync(); try { renderSwap(); } catch {} }
      catch (e){ recordPendingPegOut(got); try { C.toast && C.toast('Your Bitcoin is safe · we couldn\'t finish returning it just now, and we\'ll retry automatically next time you open the wallet.'); } catch {} }
    }
  } catch (e){ try { C.toast && C.toast('Fill could not settle: ' + C.prettyErr(e)); } catch {} }
}
async function onCovOrderStatus(s){
  // A resting order of ours moved (likely filled by a taker/settler): record the remaining size so
  // renderMyOrders can show per-order fill progress (D2/T13), rescan the companion wollet (which holds
  // the credit) + the primary, and refresh the UI.
  try {
    const id = s.offer_id || s.offerId;
    if (id) _ordStatus[id] = { active: big(s.active_amount || s.activeAmount || 0), status: s.status || '' };
  } catch {}
  await scanCompanion(); try { await C.sync(); } catch {}
  try { renderSwap(); } catch {}
}

// Called on wallet open: rehydrate placed orders + resume watching for fills. The
// covenant rests ON-CHAIN, so a fill can happen while the tab was closed; on reopen
// we rescan so any credit already received is reflected, and re-arm the watcher.
export function resumeCovenantOrders(){
  loadPlaced();
  ensureCompanion();
  scanCompanion().catch(()=>{});
  reconcileUnfundedPlaced().catch(()=>{});   // recover any record that died mid-broadcast
  if (PLACED.length){ ensureCovenantRelay(); }
}

// A record persisted BEFORE the funding broadcast (covTxid null) whose tab died in
// the resolve window: locate the covenant outpoint by its spkHex on-chain and fill in
// txid/vout so the reclaim path is whole. If nothing is found after a grace period past
// creation, the broadcast almost certainly never landed (nothing was spent) — drop it so
// it doesn't linger as a fake resting order. Esplora indexes by scripthash = sha256(spk)
// reversed; /scripthash/:h/utxo returns the funded outpoints.
async function reconcileUnfundedPlaced(){
  let changed = false;
  for (const rec of PLACED){
    if (rec.covTxid || !rec.spkHex) continue;
    try {
      const sh = await scripthashOf(rec.spkHex);
      const res = await esplora(`/scripthash/${sh}/utxo`);
      const utxos = (res && res.ok) ? await res.json() : [];
      if (Array.isArray(utxos) && utxos.length){
        // The covenant output is the one paying exactly this spk; take the first.
        rec.covTxid = utxos[0].txid; rec.covVout = utxos[0].vout; changed = true;
      } else if (Date.now() - (rec.created||0) > 10 * 60 * 1000){
        rec._orphan = true; changed = true;   // 10 min, no on-chain output -> the funding tx never landed
      }
    } catch { /* transient esplora error; retry on the next resume */ }
  }
  if (changed){
    const before = PLACED.length;
    for (let i = PLACED.length - 1; i >= 0; i--) if (PLACED[i]._orphan) PLACED.splice(i, 1);
    savePlaced();
    if (PLACED.length !== before) { try { C.toast && C.toast('Cleared an order whose funding never confirmed (nothing was spent).'); } catch {} }
  }
}

// scripthash = SHA-256 of the raw scriptPubKey bytes, BYTE-REVERSED (Esplora/Electrum convention).
async function scripthashOf(spkHex){
  const bytes = new Uint8Array((spkHex.match(/../g) || []).map(h => parseInt(h, 16)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  digest.reverse();
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===========================================================================
// MARKET take — WALK the book (spec line 177: a market order is a TAKER)
// ---------------------------------------------------------------------------
// A market order crosses the resting offers that meet its price, best price first,
// and NEVER rests a remainder (that is the maker's LIMIT path). The same-chain book
// holds TWO kinds of resting liquidity and the walk fills BOTH:
//   • covenant offers (funded, self-enforcing, offline) → settleFill DIRECTLY from
//     the covenant's own terms (no maker round-trip, no relay match, nothing that
//     could itself rest); the pay per fill is planFill'd from the committed rate, so
//     it is consensus-exact (on-chain rejects any underpay/redirect).
//   • interactive maker offers (the seqob-maker fleet; the LIVE fillable depth) →
//     seqob.lift, co-signed by the online maker.
// executableQuote maps our remaining PAY budget onto each offer's own orientation +
// rounding, so amounts are exact and a single fill never over-takes the offer. The
// unfilled budget simply does not fill — a market order leaves NOTHING resting.
// Slippage is bounded: stop walking once an ask is worse than the market-slip below best. The bound
// lives in CONFIG.marketSlip (P5.4a — one source of truth, /status-overridable, default 0.15) so the
// walk floor here and the slippage line the composer shows (slippageHint) can never disagree.
async function takeMarketWalk(pay, receive, payAtoms, recvAtoms, onStatus){
  payAtoms = BigInt(payAtoms);
  // Re-fetch BOTH orientations so we cross the CURRENT resting offers, not a stale compose
  // snapshot — refreshed INTO the shared baseline so the walk renders the same union ladder as
  // every other path (the old direct applyOffersToBook repainted the book with the REST subset
  // alone, mid-walk: the same collapse the union discipline removes).
  const [b1, b2] = await Promise.all([
    OB.fetchBook(receive, pay, { confidential: false }).catch(() => ({ offers: [] })),
    OB.fetchBook(pay, receive, { confidential: false }).catch(() => ({ offers: [] })),
  ]);
  {
    const rest = new Map();
    for (const o of [...(b1.offers || []), ...(b2.offers || [])]) rest.set(_liveOid(o), o);
    const key = _liveKey(pay, receive);
    const prev = (SAMEBOOK && SAMEBOOK.key === key) ? SAMEBOOK : null;
    SAMEBOOK = { key, rest, restTs: Date.now(), restErr: null, unified: prev ? prev.unified : [] };
  }
  const mine = (makerPubHex() || '').toLowerCase();
  // Execute only what THIS walk can settle: the direct same-chain rows (covenant or interactive
  // lift). Display-only families stay on the ladder but are never crossed here.
  const asks = renderSameUnion(pay, receive)
    .filter((o) => !o._displayOnly)
    .filter((o) => String(o.maker_pubkey || o.makerPubkey || '').toLowerCase() !== mine);   // never self-fill
  if (!asks.length) throw new Error('No resting orders are on the book to fill right now. Switch to Limit to rest an order.');
  const bestPrice = Number(big(asks[0].offer_amount || asks[0].offerAmount || 0)) / Number(big(asks[0].want_amount || asks[0].wantAmount || 1));
  const floor = bestPrice * (1 - CONFIG.marketSlip);   // receive-per-pay we refuse to go below
  let paidPay = 0n, gotRecv = 0n; const txids = []; const seen = new Set(); let idx = 0, lastErr = null;
  for (const o of asks){
    if (paidPay >= payAtoms) break;
    const oid = String(o.offer_id || o.offerId || '');
    if (oid && seen.has(oid)) continue; if (oid) seen.add(oid);
    const oRecv = big(o.offer_amount || o.offerAmount || 0);   // asset A offered = what we RECEIVE
    const oPay  = big(o.want_amount  || o.wantAmount  || 0);   // asset B wanted  = what we PAY
    if (oPay <= 0n || oRecv <= 0n) continue;
    if (Number(oRecv) / Number(oPay) + 1e-9 < floor) break;    // asks are best-first: once past the slippage floor, stop
    const payLeft = payAtoms - paidPay;
    const typedPay = payLeft < oPay ? payLeft : oPay;          // take at most this offer's full pay, bounded by the budget
    if (typedPay <= 0n) break;
    // executableQuote turns our pay budget into this offer's exact take (base atoms) + the pay/recv it costs,
    // in the offer's own base/quote orientation. It caps the take at the offer's size, so one fill never over-lifts.
    const q = executableQuote(o, pay, receive, pay, typedPay);
    if (q.takeBase <= 0n || q.amountR <= 0n || q.amountP <= 0n) continue;
    idx++; onStatus && onStatus(`Filling against resting order ${idx}…`);
    // A single offer failing (a covenant just taken by someone else, or an interactive maker gone
    // offline) must NOT abort the whole market order — skip it and walk on. Nothing is committed for a
    // failed fill (covSettleFill/lift either broadcast atomically or throw), so skipping strands nothing.
    try {
      let txid;
      if (o.covenant || o.Covenant){
        // fill_base_amount is in asset A (what we RECEIVE) = q.amountR; covenant_locked is the offer's full asset-A.
        const synth = { resting_is_covenant: true, covenant: (o.covenant || o.Covenant),
          covenant_locked: String(oRecv), fill_base_amount: String(q.amountR), offer_id: oid, pair: o.pair };
        ({ txid } = await covSettleFill(synth, fillHooksFor(synth)));
      } else {
        // Interactive maker offer: co-sign lift q.takeBase of the base with the online maker.
        txid = await liftOffer(q, onStatus);
      }
      txids.push(txid);
      paidPay += q.amountP; gotRecv += q.amountR;
      try { await C.sync(); } catch {}   // reflect the spent UTXOs before the next fill
    } catch (e){ lastErr = e; /* skip this offer, try the next crossable one */ }
  }
  if (!txids.length) throw new Error(lastErr
    ? ('Could not fill against the resting orders: ' + C.prettyErr(lastErr))
    : 'Nothing on the book crossed your price. Switch to Limit to rest an order at your price.');
  return { txids, paidPay, gotRecv, full: paidPay >= payAtoms };
}

// Review a MARKET order (same-chain): confirm, then walk the book.
async function takeCovenantWalkReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive, payAtoms = BigInt(q.payAtoms), recvAtoms = BigInt(q.recvAtoms);
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const feeAsset = feeAssetPolicy().asset;
  const kv = [
    ['You pay', 'up to ' + amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You receive', '~' + amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payAtoms > 0n ? 'Market · ' + ratePerPayToLine(pay, receive, Number(recvAtoms) / Number(payAtoms)).str : '-'],
    ['Network fee', amtRow(feeAsset, covFeeAtoms(feeAsset)) + '  (estimate, per fill)'],
    ['How it fills', `Walks the order book now and fills what crosses your price, best price first. Any part that can't fill is NOT rested — a market order never leaves a resting order behind (switch to Limit for that). Each fill settles on-chain; consensus rejects any underpay or redirect.`],
    ['Finality', 'Each fill settles in ~1 block · reverts only if Bitcoin reverts.'],
    ['Settlement', 'Each fill settles in full or not at all.'],
  ];
  // CTA stays modalRows' default 'Confirm & sign' (task 19c): every rail's review sheet uses
  // one confirm label; the old 'Place market order' override made this one modal read
  // differently for no reason.
  const { m: modal, ok, st } = C.modalRows({ title: 'Review market order', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Walking the order book…';
    try {
      const res = await takeMarketWalk(pay, receive, payAtoms, recvAtoms,
        (msg) => { st.innerHTML = '<span class="spin"></span>' + esc(msg); });
      modal.remove();
      // ONE receipt for the whole market order (the actual paid/received totals across every level it
      // swept), keyed by the first fill txid, carrying all fill txids — a per-txid row would repeat the
      // full size N times and mislead the export. Enriched with the pair/side/price/size (P5.1).
      logTrade({ id: 'covfill:' + (res.txids[0] || Date.now()), title: 'Swapped ' + pm.ticker + ' for ' + rm.ticker,
        status: 'settled', txid: res.txids[0] || null, txids: res.txids, rail: 'chain',
        fee: covFeeUnits(feeAsset), feeTicker: C.assetMeta(feeAsset).ticker,
        card: true,   // task 21b: genuine settlement -> settle card
        ...tradeMeta(pay, receive, res.paidPay, res.gotRecv) });
      const gotStr = C.fmtAtoms(res.gotRecv, rm.precision);
      if (res.full)
        C.toast(`Market order filled · received ${gotStr} ${rm.ticker}.`,
          res.txids[0] ? { href: '/explorer/tx/' + res.txids[0], label: String(res.txids[0]).slice(0, 18) + '…' } : undefined);
      else
        C.toast(`Filled what the book had · received ${gotStr} ${rm.ticker}. The rest did not fill (thin book) and was NOT rested — switch to Limit to rest an order.`);
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not fill: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

async function placeCovenantReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive, payAtoms = q.payAtoms, recvAtoms = q.recvAtoms;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const isMarket = S.mode !== 'post';
  const feeAsset = feeAssetPolicy().asset;
  const feeAtoms = covFeeAtoms(feeAsset);
  const kv = [
    ['You pay', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You receive', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? `${isMarket ? 'Market · ' : 'Limit · '}${ratePerPayToLine(pay, receive, recvU/payU).str}` : '-'],
    ['Network fee', amtRow(feeAsset, feeAtoms) + refSuffix(feeAsset, feeAtoms) + '  (estimate)'],
    ['Fee paid in', C.assetMeta(feeAsset).ticker],
    ['How it fills', isMarket
      ? `Fills against the order book now at your price or better. If your order is larger than what's resting, the filled part settles on-chain and the unfilled remainder keeps resting at the same price until it's crossed · even while this wallet is closed. Consensus rejects any underpay or redirect.`
      : `Rests on-chain at your price and fills · fully or partially · whenever someone crosses it, even while this wallet is closed. A partial fill settles that part and leaves the rest resting. Consensus rejects any underpay or redirect.`],
    ['You can close the wallet', `The order rests on-chain; when it fills you are credited to a payout address only this wallet controls. Reopen any time to see it.`],
    ['If it does not fill', `Cancel any time to delist it. After the order expires the locked ${pm.ticker} is reclaimable on-chain.`],
    ['Finality', 'Settles in ~1 block · reverts only if Bitcoin reverts.'],
  ];
  // Market order bigger than the resting book at this price: show the fill-now / rest split honestly.
  const split = isMarket ? marketFillSplit(payAtoms, recvAtoms) : null;
  if (split) kv.splice(3, 0, ['Now / resting',
    `About ${C.fmtAtoms(split.fill, pm.precision)} ${pm.ticker} fills now against the book; the remaining ${C.fmtAtoms(split.rest, pm.precision)} ${pm.ticker} rests at your price until it's crossed.`]);
  // CTA stays modalRows' default 'Confirm & sign' (task 19c): one confirm label on every rail.
  const { m: modal, ok, st } = C.modalRows({ title: 'Place order', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Funding the order on-chain…';
    try {
      const rec = await placeCovenant(pay, receive, payAtoms, recvAtoms,
        (msg) => { st.innerHTML = '<span class="spin"></span>' + esc(msg); });
      modal.remove();
      C.toast('Order placed · resting on-chain; it fills when matched, even offline.',
        rec.covTxid ? { href:'/explorer/tx/'+rec.covTxid, label:String(rec.covTxid).slice(0,18)+'…' } : undefined);
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not place order: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Mixed rails (one leg LN, one on-chain) — a SUBMARINE swap: the asset leg is an
// anchored on-chain HTLC, the BTC leg is Lightning, bound by one preimage. The LSP's
// POST /swap (payRail/recvRail) dispatches to seqob-cli xsubbuy/xsublift. Only the
// asset-on-chain <-> BTC-Lightning combos are deployed; the mirror combo (asset over
// LN + BTC on-chain) needs a BTC-on-chain HTLC submarine that is not built yet, so it
// fails closed with an honest message. Anchor-gated: the receive is NOT instant-final
// (that is the pure-LN rail) — it settles once the on-chain leg buries under Bitcoin.
async function reviewMixed(q){
  const { $ } = C;
  if (!L || !L.swap){ $('swErr').textContent = 'This way of trading is unavailable in this build.'; return; }
  // FUND-SAFETY (see reviewCross): the submarine (MIXED), the sub-asset BUY (BUY) and the sub-asset
  // SELL (SELL) each persist their on-chain HTLC leg under a SINGLE localStorage key, recoverable only
  // via Refund — so starting a second of the SAME kind overwrites and strands it. The per-kind guard is
  // below, once we know which shape this is (the earlier mixed-only guard missed buy + sell).
  const am = C.assetMeta(q.seqAsset);
  const side = q.payIsBtc ? 'buy' : 'sell';            // buy the asset (pay BTC) / sell it (pay the asset)
  // Which leg is the ASSET, which is BTC.
  const assetLeg = q.payIsBtc ? q.recvRail : q.payRail;
  const btcLeg   = q.payIsBtc ? q.payRail : q.recvRail;
  // DEFENCE-IN-DEPTH (kill offer-then-refuse): a BUY paying BTC over Lightning to receive the asset on-chain
  // has NO custodial-submarine settlement here — it settles PEER-TO-PEER (interactive maker) or via the LSP
  // PAYER leg-bridge. It must NEVER reach the inline BTC-LN channel provisioning + startMixed below. onReview
  // already routes it via settlementDispatch; this re-dispatches if ever reached directly, and fails closed
  // (no channel opened) when no maker can settle it.
  if (side === 'buy' && btcLeg === 'ln' && assetLeg === 'chain'){
    const route = q.route || { seqAsset: q.seqAsset, payIsBtc: true, payRail: 'ln', recvRail: 'chain' };
    const disp = settlementDispatch(route);
    if (disp && disp.path === 'p2p-submarine') return reviewSubmarineP2P(route, disp);
    // PAYER leg-bridge (on-chain-only / passive maker): the LSP bridges the taker's BTC-LN <-> the maker's
    // on-chain BTC HTLC on ONE shared secret. ENABLED now the taker pays the LSP's hold by BARE HASH — route to
    // reviewLspPayerBridge (which fails closed with payerBridgeDisabledNote if the LSP returns no usable target).
    if (disp && disp.path === 'lsp-bridge' && disp.lnSide === 'payer' && disp.bridged && disp.supported) return reviewLspPayerBridge(route, disp);
    $('swErr').textContent = (!disp || !disp.offer) ? 'No offers resting here yet.' : 'This trade could not be placed right now - try again shortly.';
    return;
  }
  // Two mixed shapes settle: the submarine (asset on-chain + BTC-LN), and its MIRROR the
  // sub-asset (asset over LN + BTC on-chain) — a BUY only, gated to pairs with a maker.
  const isSubAsset = (side === 'buy' && assetLeg === 'ln' && btcLeg === 'chain');
  // Sub-asset SELL: pay the asset over Lightning, receive BTC in an on-chain HTLC the wallet
  // claims with the maker-revealed preimage. Gated on live sell-side book liquidity.
  const isSubAssetSell = (side === 'sell' && assetLeg === 'ln' && btcLeg === 'chain');
  const isSubmarine = (assetLeg === 'chain' && btcLeg === 'ln');
  // Per-kind in-flight guard (fund-safety): the rails whose recovery handle is still a SINGLE key
  // refuse a second swap of the same kind, because a second record would overwrite it.
  //
  // Sub-asset BUY and SELL are NOT of that kind any more — both key their records per trade, so
  // they are bounded by the shared concurrency ceiling instead (spec §7: a blanket
  // finish-this-first gate is only legitimate for an order holding the SAME funds, and every
  // sell holds its own preimage + HTLC). The single-key sell used to sit here, which meant one
  // stuck claim wedged the whole sell rail.
  if (isSubmarine && hasMixedInFlight()){
    $('swErr').textContent = 'You already have a swap of this kind in progress. Finish or refund it first (open it under Active trades) before starting another.';
    return;
  }
  if ((isSubAsset || isSubAssetSell) && !buySlotsFree()){ $('swErr').textContent = inFlightBlockMessage(); return; }
  // Rail-agnostic (Stage 3): don't pre-block on a live maker (subassetCapable/sellCapable) — the
  // rail is a settlement preference. Any recognized mixed shape proceeds; the settlement router
  // decides + bridges on Place-order and fails closed CLEANLY (refundable) if there's no
  // counterparty. Only a genuinely unrecognized combo (should not reach here) is refused.
  if (!(isSubmarine || isSubAsset || isSubAssetSell)){
    $('swErr').textContent = `This trade could not be placed right now - try again shortly.`;
    return;
  }
  // Inline channel provisioning (mirrors reviewLn): if the user PAYS a leg over Lightning
  // but has no usable channel for it, OPEN + FUND it now via the same non-custodial
  // provision+fund flow, then continue — fulfilling paintRailSegs' "one is opened for you
  // when you place the order" promise (the rail lights up like the asset Move-to-Lightning
  // flow). Fails CLOSED before any swap/HTLC step; never half-executes.
  if (q.payRail === 'ln' && L && L.provisionChannel){
    let ra0 = railAvail(S.payAsset, S.receiveAsset);
    if (!ra0.payLn.ok){
      const pm = metaOf(S.payAsset);
      const chain = S.payAsset === 'BTC' ? 'btc' : 'seq';
      const atoms = fieldAtoms(C.$('swPayAmt'), S.payAsset);
      if (atoms <= 0n){ $('swErr').textContent = 'Enter an amount so the Lightning channel can be sized.'; return; }
      try {
        $('swErr').textContent = '';
        await L.provisionChannel({ chain, asset: chain === 'seq' ? S.payAsset : undefined, ticker: pm.ticker,
          amount: Number(atoms), onProgress: (t) => { $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>' + t; } });
        LNSTATUS = await L.status();
        $('swStatus').textContent = '';
      } catch (e){
        $('swStatus').textContent = '';
        $('swErr').textContent = 'Could not open your Lightning channel: ' + C.prettyErr(e);
        return;
      }
      if (!railAvail(S.payAsset, S.receiveAsset).payLn.ok){
        $('swErr').textContent = 'Your Lightning channel opened but is not ready to trade yet · please try again in a moment.';
        return;
      }
    }
  }
  const amount = fieldUnits($('swPayAmt'), S.payAsset) || null;
  // The quote leg's NAME: Bitcoin for the cross shapes, the quote asset's ticker for
  // the mixed same-chain shape (it stands in BTC's structural place, words included).
  const mixedQ = (q.route && q.route.mixedSame && q.route.quoteAsset) || null;
  const qName = mixedQ ? ((C.assetMeta(mixedQ) || {}).ticker || 'the quote asset') : 'Bitcoin';
  const qTick = mixedQ ? ((C.assetMeta(mixedQ) || {}).ticker || 'quote') : 'BTC';
  const qPrec = mixedQ ? ((C.assetMeta(mixedQ) || {}).precision ?? 8) : 8;
  const dir = isSubAsset
    ? `Buy ${am.ticker} with ${qName} on-chain · receive ${am.ticker} over Lightning`
    : isSubAssetSell
    ? `Sell ${am.ticker} over Lightning · receive ${qName} on-chain`
    : (side === 'buy'
      ? `Buy ${am.ticker} with ${qName} over Lightning · receive ${am.ticker} on-chain`
      : `Sell ${am.ticker} on-chain · receive ${qName} over Lightning`);
  // The Review shows ONLY the user's own legs (what they pay / receive, via `dir`) + a plain reassurance —
  // never any of the settlement machinery that carries the trade to completion. The Pricing row states the
  // REAL (possibly partial) fill terms from the sized take the composer carried — never "the whole offer".
  const aprec = am.precision || 0;
  const takeA = q.takeAssetAtoms != null ? BigInt(q.takeAssetAtoms) : null;
  const takeB = q.takeBtcSats != null ? BigInt(q.takeBtcSats) : null;
  const pricingRow = (takeA != null && takeB != null)
    ? `Best resting offer · ${C.fmtAtoms(takeA, aprec)} ${am.ticker} for ${C.fmtAtoms(takeB, qPrec)} ${qTick}`
    : 'Best resting offer at its posted price';
  const kv = [
    ['Direction', dir],
    ['Pricing', pricingRow],
    ['Your funds', 'Your funds stay in your control until this completes.'],
    // ROUTING HONESTY (owner ruling): every shape that reaches THIS review settles natively
    // (sub-asset / submarine — an interactive maker on the matching rails) at Sequentia speed;
    // the bridged shapes were re-routed to their own reviews above, which state the slow class.
    ['Speed', SPEED_FAST_NOTE],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  ok.onclick = async () => {
    modal.remove();
    resetComposer();
    if (isSubAssetSell){
      // Sub-asset SELL: pay the asset over LN, then CLAIM the maker's BTC HTLC on-chain with the
      // revealed preimage (device claim key via the wasm's xchainBtcClaim). Persisted/resumable —
      // the claim is the fund step and must survive a reload. Carry the DISPLAYED fill (takeAssetAtoms/
      // takeBtcSats) as authoritative so the economic gate + the defense-in-depth price check use exactly
      // what the composer showed (never re-priced off a different offer's ratio).
      await startSell({ asset: q.seqAsset, amount, offer: q.sellOffer || null,
        quoteAsset: (q.route && q.route.mixedSame && q.route.quoteAsset) || null,
        expectedBtcSats: q.takeBtcSats, expectedAssetAtoms: q.takeAssetAtoms });
      return;
    }
    if (isSubAsset){
      // Sub-asset BUY: pay BTC in an on-chain HTLC, receive the asset over Lightning, bound by one
      // preimage the DEVICE owns. Persisted/resumable — the BTC HTLC is funded BEFORE /swap. Lift the SAME
      // offer whose fill was DISPLAYED (q.buyOffer, matched by id in requoteMixed) and carry the DISPLAYED
      // fill (takeAssetAtoms/takeBtcSats) as authoritative — startBuy lifts exactly it, never re-deriving the
      // fill off this offer's ratio (which showed 50 GOLD but delivered 25 when the offer differed).
      const qQuote = (q.route && q.route.mixedSame && q.route.quoteAsset) || null;
      // ONLY the reviewed offer object, threaded byte-for-byte. The old fallback re-read
      // subassetOffers()[0] AT CONFIRM TIME — a different snapshot than the one reviewed,
      // which is the stale-cap fund-mismatch class. No reviewed offer -> startBuy refuses
      // honestly before anything is funded.
      const buyOffer = q.buyOffer || null;
      await startBuy({ asset: q.seqAsset, amount, offer: buyOffer, quoteAsset: qQuote,
        expectedAssetAtoms: q.takeAssetAtoms, expectedBtcSats: q.takeBtcSats });
      return;
    }
    // Hand off to the persisted, RESUMABLE submarine stepper. The on-chain HTLC leg
    // must survive a page reload (it is only recoverable via its CLTV timeout otherwise),
    // so from here the swap lives in localStorage + the trade-process view, not a modal.
    await startMixed({ side, asset: q.seqAsset, amount, payRail: q.payRail, recvRail: q.recvRail, payIsBtc: q.payIsBtc });
  };
}

// ===========================================================================
// Sub-asset SELL flow — pay the asset over Lightning, then CLAIM the counterparty's BTC HTLC
// on-chain with the maker-revealed preimage, using the device CLAIM key. FUND-CRITICAL: the
// on-chain claim is built by the wasm's xchainBtcClaim (the audited legacy-P2SH spend that
// mirrors the proven xchainBtcRefund) — never hand-rolled here. Flow: xchainBtcClaimPubkey ->
// /swap {side:sell, node_key, btc_claim_pub, offer_id?} -> {settled, preimage, btc_htlc} ->
// VERIFY the returned redeem_script by rebuilding it via xchainBtcHtlc -> xchainBtcClaim ->
// broadcast. Persisted/resumable (the claim is the fund step, must survive a reload).
// [Finalized + testnet-verified once xchainBtcClaim lands in the wasm — stubbed until then so
//  the rail is gated honestly and never half-executes a real BTC claim.]
// PER-TRADE sell records (mirror of BUYS, and of the spec's §7 rule: a "finish this one
// before starting another" gate is only ever legitimate for an order holding the SAME
// funds — and every sell holds ITS OWN preimage + HTLC, nothing shared). The old
// single-key SELL meant one stuck claim wedged the whole sell rail for hours; records
// are now keyed per trade, dropped individually, bounded by the shared concurrency
// ceiling. The legacy single-record key is migrated on load so an in-flight sell from
// the old build is not orphaned by the upgrade.
const SELL_KEY = 'swk.subasset.sell';      // legacy single-record key (migrated, then removed)
const SELLS_KEY = 'swk.subasset.sells';
let SELLS = [];
try {
  const raw = JSON.parse(localStorage.getItem(SELLS_KEY) || 'null');
  if (Array.isArray(raw)) SELLS = raw.filter(Boolean);
} catch { SELLS = []; }
if (!SELLS.length){
  try { const one = JSON.parse(localStorage.getItem(SELL_KEY) || 'null'); if (one) SELLS = [one]; } catch {}
}
for (const s of SELLS) if (s && !s.id) s.id = newTradeId();
// A fresh 32-byte random hex idempotency key for a sub-asset sell (same CSPRNG the maker key uses).
// The wallet persists it in the 'paying' record BEFORE the asset-paying /swap, and re-sends the SAME
// value on recovery so the LSP returns the already-settled result rather than re-paying the asset.
function newSwapNonce(){ const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2,'0')).join(''); }
// After this long, a still-'paying' record can't complete (any unsettled Lightning payment has
// auto-returned past its own timeout), so resumeSell clears it rather than re-attempting forever.
const SELL_PAYING_TTL_MS = 24 * 60 * 60 * 1000;
// Synchronous in-flight sentinel (mirror of _buyStarting): a record only becomes visible to the
// slot check AFTER the LN-pay prologue, so without this two rapid starts could both pass it. It
// bounds CONCURRENT STARTS, not the number of live sells.
let _sellStarting = false;
function saveSells(){
  try { stampStages(SELLS); } catch {}
  try { mergedStoreSave(SELLS_KEY, SELLS, _sellTombstones); } catch {}
  try { localStorage.removeItem(SELL_KEY); } catch {}
  try { renderInFlightCard(); } catch {}
}
function addSell(rec){ rec.id = rec.id || newTradeId(); SELLS.push(rec); saveSells(); return rec; }
// Drop ONE record (by identity, falling back to id so a re-parsed copy still matches).
function clearSell(rec){
  if (!rec){ for (const r of SELLS) if (r && r.id) _sellTombstones.add(r.id); SELLS = []; saveSells(); return; }
  if (rec.id) _sellTombstones.add(rec.id);
  SELLS = SELLS.filter((r) => r !== rec && !(rec.id && r && r.id === rec.id));
  saveSells();
}
function sellTerminal(s){ return !s || s.state === 'done' || s.state === 'failed'; }
function activeSells(){ return SELLS.filter((s) => !sellTerminal(s)); }
// True while ANY sell is starting or live — kept for the composer's rail copy; it no longer
// BLOCKS a second sell (the shared concurrency ceiling does the bounding).
export function hasSellInFlight(){ return !!(_sellStarting || activeSells().length); }

async function startSell(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  // Bound CONCURRENT sells by the shared ceiling (per-trade records; nothing to overwrite).
  // _sellStarting still serialises the pre-pay prologue so two rapid starts cannot race it.
  if (_sellStarting || !buySlotsFree()){ if (C.toast) C.toast(inFlightBlockMessage()); return; }
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Selling ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  // The sell is persisted + resumable (resumeSell re-attempts on reload), so this modal is a
  // progress view, not a lock: closing it never cancels the swap, and a second sell stays blocked
  // by hasSellInFlight. Dismissable from the start via the button and a backdrop click; the label
  // firms to "Close" once it settles (W5).
  const closeBtn = C.el('button','ghost','Run in background'); closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.textContent = 'Close'; };
  // Set true the instant BEFORE the asset-paying L.swap. In the catch it separates a LOST RESPONSE
  // (network error after we may have paid -> keep the 'paying' record for recovery) from a pre-pay or
  // definitive-rejection error (asset NOT paid -> discard it so it neither blocks nor re-runs).
  let paidCallStarted = false;
  let rec = null;
  try {
    _sellStarting = true;   // serialise the pre-pay prologue (TOCTOU on the slot check)
    if (!(L && L.swap && L.assetNodeKey)) throw new Error('Lightning isn’t available in this build.');
    // Mixed same-chain: the claim leg is the QUOTE asset on the Sequentia chain (C.seqLeg);
    // the BTC shapes keep C.btcLeg. One capability check per leg family.
    const qh = params.quoteAsset || null;
    const qtk = qh ? ((C.assetMeta(qh) || {}).ticker || 'quote') : 'BTC';
    if (qh){
      if (!(C.seqLeg && C.seqLeg.claim && C.seqLeg.claimKey && C.seqLeg.readOutput)) throw new Error('This trade isn’t available in this build.');
    } else if (!(C.btcLeg && C.btcLeg.claim && C.btcLeg.claimKey && C.btcLeg.verifyClaimable)) throw new Error('This trade isn’t available in this build.');
    say('Preparing your sell…');
    const btc_claim_pub = (qh ? C.seqLeg.claimKey() : C.btcLeg.claimKey()).public_key;   // the device claim key; only we can claim
    const node_key = await L.assetNodeKey(asset);           // our own hosted asset node pays over LN
    const offer = params.offer || null;
    // FUND-SAFETY: this rail pays the asset over Lightning and can only compare the maker's returned BTC
    // HTLC against the quote AFTER that (irrevocable) payment. Never pay without a resting offer's
    // btc_sats to compare against — otherwise expected_btc falls back to 0, the shortfall gate in
    // claimSell is skipped entirely, and a maker handing back a dust HTLC goes completely unwarned. This
    // makes the economic gate reliable; verifying the BTC HTLC BEFORE paying needs a 2-phase LSP
    // handshake (the atomic flow reveals the preimage only after the pay), tracked as an LSP change.
    // Price the economic gate against what actually FILLS: the composer's SIZED take (params.expectedBtcSats,
    // the floor-proportional BTC a SELL receives for a partial), falling back to the whole offer's btc_sats.
    // Using the whole offer for a partial would false-warn "shortfall" on a correct proportional fill.
    const expectedBtc = Number((params.expectedBtcSats != null ? params.expectedBtcSats : (offer && offer.btc_sats)) || 0);
    if (!(expectedBtc > 0)) throw new Error('This sell has no resting offer to price against · refresh the order book and pick an offer, so what you will receive is known before you pay the asset.');
    // DEFENSE-IN-DEPTH: the offer we are about to lift MUST be the SAME (price) as the one whose fill was
    // DISPLAYED. A SELL RECEIVES BTC, so the maker's FLOOR-proportional BTC for the displayed asset fill must
    // match the displayed BTC within 1 sat of rounding; a material disagreement means a different-priced offer
    // than shown — refuse BEFORE paying the asset (never receive one price while shown another).
    if (params.expectedAssetAtoms != null && offer && offer.asset_amount != null && offer.btc_sats != null){
      const ea = BigInt(params.expectedAssetAtoms), oa = BigInt(offer.asset_amount), ob = BigInt(offer.btc_sats);
      if (ea > 0n && oa > 0n){
        const need = (ob * ea) / oa;   // floor: the maker's favour on a SELL (matches proportionalBtcFloor)
        const eb = BigInt(expectedBtc);
        const gap = eb > need ? eb - need : need - eb;
        if (ea > oa || gap > 1n) throw new Error('This trade’s price changed · reopen the order book and try again.');
      }
    }
    // Bring our asset LN node's device signer ONLINE — a per-user node isn't auto-connected on
    // load, and the LSP needs it serving to command the pay. Idempotent (re-attaches, no re-fund).
    if (L.connectNode){
      say('Completing your trade …');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not reach Lightning right now · reopen the wallet and try again.');
    }
    // FUND-SAFETY: the asset is paid INSIDE L.swap. Persist a PENDING ('paying') record carrying a
    // fresh swap_nonce + everything needed to RE-CALL /swap, BEFORE that call. If the response is lost
    // after the LSP already paid the asset, resumeSell() re-calls with this SAME nonce and the LSP
    // returns the settled {preimage, btc_htlc} idempotently (it never re-pays for a stored nonce).
    const swap_nonce = newSwapNonce();
    rec = addSell({ state: 'paying', swap_nonce, asset, ticker: am.ticker, amount: params.amount ?? null,
      quote_asset: qh || undefined,   // mixed same-chain: the claim leg's REAL asset (absent = BTC)
      started_ms: Date.now(),         // total-elapsed anchor for the progress narrative + settle card
      node_key, btc_claim_pub, offer, ts: Date.now() });
    // Pay the asset over Lightning (LSP drives the hold-invoice pay from our node; device co-signs).
    // On settle the maker reveals the preimage, returned here WITH the BTC HTLC terms — the LSP
    // never claims (no claim key) and we claim on-chain ourselves.
    say('Paying ' + am.ticker + ' over Lightning…');
    paidCallStarted = true;   // from here a lost response means the asset MAY be paid -> keep for recovery
    const resp = await L.swap({ side: 'sell', asset, node_key, btc_claim_pub, amount: params.amount,
      // PARTIAL FILL (review == execution): the sized atoms the review displayed ARE the trade.
      // Without this the LSP's CLI lifted the WHOLE offer while the sheet showed a slice.
      asset_amount: params.expectedAssetAtoms != null ? String(params.expectedAssetAtoms) : undefined,
      quote_asset: qh || undefined,
      // State the rails EXPLICITLY (asset over Lightning, BTC on-chain) so the LSP routes this to
      // the sub-asset sell (xsubas-sell) rather than defaulting omitted rails to pure-LN (xpln).
      payRail: 'ln', recvRail: 'chain',
      offer_id: offer && offer.offer_id, maker_pubkey: offer && offer.maker_pubkey,
      swap_nonce });
    if (!(resp && resp.settled && resp.preimage && resp.btc_htlc)){ if (resp && resp.error){ try { console.warn('[sell] swap did not settle:', resp.error); } catch {} } throw new Error('This trade could not be completed - your funds are safe.'); }
    const H = resp.btc_htlc;
    // Persist BEFORE the on-chain claim: the asset is now paid, so the BTC claim is the fund step
    // and MUST survive a reload — resumeSell() re-attempts it from here. Mutate (never replace)
    // so the record keeps its id.
    Object.assign(rec, { state: 'claiming', preimage: resp.preimage, hash_h: resp.hash_h, btc_htlc: H,
      expected_btc: expectedBtc, ts: mixedTip() }); saveSells();
    say('Completing your trade …');
    await claimSell(rec);   // verify + claim; updates the record + st
    say('Done · you paid ' + am.ticker + ' over Lightning and received your ' + qtk + ' (' + String(rec.claim_txid || '').slice(0,16) + '…).', 'ok');
    done();
    try { await C.sync(); } catch {}
    clearSell(rec);
  } catch (e){
    // Was the asset possibly paid? Only if we reached L.swap AND the failure was a LOST RESPONSE — a
    // network/fetch error (surfaced as a TypeError; the LSP may already have settled). A DEFINITIVE
    // rejection (a completed round-trip returning ok:false, thrown as a plain Error by lspFetch) means
    // the sub-asset sell never settled, so NO asset was paid. Keep the 'paying' record only in the
    // lost-response case (resumeSell recovers via its nonce); else discard it so it neither blocks a
    // future sell nor triggers a surprise re-run.
    const msg = String((e && e.message) || '');
    const lostResponse = paidCallStarted && ((e instanceof TypeError) || (e && e.name === 'AbortError')
      || /failed to fetch|networkerror|network error|network request failed|load failed|fetch failed|connection|timed? ?out|timeout/i.test(msg));
    if (rec && rec.state === 'paying' && !lostResponse) clearSell(rec);   // definitive failure / pre-pay error: nothing was paid
    const recoverable = !!(rec && SELLS.includes(rec) && (rec.state === 'claiming' || rec.state === 'paying'));
    say('Failed: ' + C.prettyErr(e) + (recoverable ? ' · your funds are safe; reopen the wallet to complete this sell.' : ''), 'err');
    done();
  } finally {
    _sellStarting = false;   // hand off to the per-record state guard
  }
}
// Verify the maker's BTC HTLC binds our claim key + H, then claim it on-chain with the preimage.
// Idempotent-ish: a duplicate claim of an already-spent HTLC just errors, which we surface.
async function claimSell(SELL){
  const H = SELL.btc_htlc;
  // ECONOMIC gate: the maker's returned BTC HTLC must be worth at least what we were QUOTED (offer.btc_sats).
  // verifyClaimable only checks the HTLC's on-chain value equals what the LSP reported — NOT that it meets
  // the quote — so a shortchanging/buggy counterparty could hand back a dust HTLC after we already paid the
  // asset over LN. We STILL claim (recovering the dust beats letting the maker refund it), but surface the
  // shortfall loudly instead of reporting a clean success. (Proper prevention needs verifying the BTC HTLC
  // BEFORE paying the asset — an LSP/flow change tracked separately.)
  try {
    const got = BigInt(String(H.amount || 0)), want = BigInt(String(SELL.expected_btc || 0));
    if (want > 0n && got < want) {
      SELL.shortfall = { got: String(got), want: String(want) }; saveSells();
      const wtk = SELL.quote_asset ? ((C.assetMeta(SELL.quote_asset) || {}).ticker || 'quote') : 'BTC';
      C.toast && C.toast(`Warning: you are receiving only ${C.fmtAtoms(got, 8)} ${wtk}, less than the quoted ${C.fmtAtoms(want, 8)} ${wtk} · taking it anyway.`, { level: 'warn' });
    }
  } catch {}
  let claimTxid;
  if (SELL.quote_asset){
    // Mixed same-chain: verify the funded output pays P2SH(redeem) in the QUOTE asset for the
    // reported amount (readOutput is explicit-only, so a blinded/absent output fails closed),
    // then claim via the wallet's Sequentia HTLC spender (fee paid in the claimed asset).
    // A READ FAILURE IS NOT A MISMATCH. readOutput returns null for a tx the
    // explorer has not indexed YET (the claim runs seconds after the maker
    // settles), and reporting that as "the lock does not match" both lies about
    // a perfectly good HTLC and makes the failure look permanent — the record
    // then sits at 'claiming' with a wrong reason. Separate the two: an
    // unreadable output is TRANSIENT (retried on the next resume), a real
    // disagreement is fatal.
    const out = await C.seqLeg.readOutput(H.txid, H.vout);
    if (!out) throw new Error('Could not read the counterparty’s on-chain lock yet · retrying automatically.');
    const wantSpk = C.seqLeg.htlcSpkHex(H.redeem_script).toLowerCase();
    if (String(out.spk || '').toLowerCase() !== wantSpk)
      throw new Error('The counterparty’s on-chain lock does not match this trade · not claiming.');
    if (String(out.asset || '').toLowerCase() !== String(SELL.quote_asset).toLowerCase())
      throw new Error('The counterparty’s on-chain lock is in the wrong asset · not claiming.');
    if (BigInt(out.value) !== BigInt(String(H.amount || 0)))
      throw new Error('The counterparty’s on-chain lock has the wrong amount · not claiming.');
    claimTxid = await C.seqLeg.claim({ txid: H.txid, vout: H.vout, amount: H.amount, asset_id: SELL.quote_asset,
      redeem_script: H.redeem_script, claim_secret: C.seqLeg.claimKey().secret_hex, secret_hex: SELL.preimage });
  } else {
    await C.btcLeg.verifyClaimable({ redeem_script: H.redeem_script, hash_h: SELL.hash_h,
      claim_pub: H.taker_claim_pubkey, maker_refund_pub: H.maker_refund_pubkey, t_btc: H.t_btc,
      preimage: SELL.preimage, txid: H.txid, vout: H.vout, amount: H.amount });
    claimTxid = await C.btcLeg.claim({ txid: H.txid, vout: H.vout, amount: H.amount, redeem_script: H.redeem_script, preimage: SELL.preimage });
  }
  SELL.state = 'done'; SELL.claim_txid = (claimTxid && claimTxid.toString) ? claimTxid.toString() : String(claimTxid); saveSells();
  // Enriched receipt (P5.1): sub-asset SELL = asset paid over LN, BTC claimed on-chain. base = the asset,
  // quote = BTC; size = asset units sold, price = BTC received per asset unit.
  const sellQtk = SELL.quote_asset ? ((C.assetMeta(SELL.quote_asset) || {}).ticker || 'quote') : 'BTC';
  const sellBtcU = (() => { try { return Number(big(H.amount || 0)) / 1e8; } catch { return null; } })();
  logTrade({ id: 'sell:' + (SELL.hash_h || SELL.claim_txid || ''), title: 'Sold ' + SELL.ticker + ' for ' + sellQtk,
    status: sellQtk + ' claimed', txid: SELL.claim_txid, rail: 'sub-asset', preimage: SELL.preimage || null,
    pair: (SELL.ticker || 'asset') + '/' + sellQtk, side: 'sell', sizeTicker: SELL.ticker || null,
    size: (SELL.amount != null ? Number(SELL.amount) : null),
    price: (sellBtcU != null && Number(SELL.amount) > 0) ? sellBtcU / Number(SELL.amount) : null,
    // Task 21b: a genuine settlement -> settle card. The claim tx is on-chain: testnet4 for
    // the BTC shape, Sequentia for the quote-asset shape.
    card: true, parentTxids: (!SELL.quote_asset && SELL.claim_txid) ? [SELL.claim_txid] : [],
    elapsed_ms: (SELL.started_ms > 0) ? (Date.now() - SELL.started_ms) : null });
}
// On wallet load: if a sell paid the asset but its BTC claim never confirmed, re-attempt the
// claim (the preimage + HTLC terms are persisted). This is the fund-recovery path.
const _resumingSells = new Set();
export async function resumeSell(){
  await Promise.all(activeSells().map((r) => resumeOneSell(r)));
}
async function resumeOneSell(SELL){
  if (!SELL) return;
  if (_resumingSells.has(SELL.id)) return;   // already being driven by an earlier call
  _resumingSells.add(SELL.id);
  try {
    await driveResumeSell(SELL);
  } finally { _resumingSells.delete(SELL.id); }
}
async function driveResumeSell(SELL){
  if (!SELL) return;
  // (A) Asset paid + response received: SELL holds the preimage + HTLC -> re-attempt the on-chain
  //     claim (the FUND step). The original recovery path, unchanged.
  if (SELL.state === 'claiming' && SELL.preimage && SELL.btc_htlc){
    try {
      await claimSell(SELL);
      try { C.toast && C.toast('Recovered your sell · you received your funds (' + String(SELL.claim_txid||'').slice(0,16) + '…).'); } catch {}
      try { await C.sync(); } catch {}
      clearSell(SELL);
    } catch (e){
      // The claim failed. Record WHY (so the Active-trades row can SHOW it instead of a silent
      // 'claiming' spinner), and decide whether it's terminal: if the HTLC outpoint is already SPENT
      // on-chain (the maker reclaimed it after its CLTV — the classic "wallet stayed closed too long"
      // case), the claim can NEVER succeed, so mark it terminal so it STOPS wedging every future sell.
      // Otherwise keep 'claiming' for a Retry (transient, or the timelock not yet mature).
      SELL.error = C.prettyErr(e); saveSells();
      try {
        const H = SELL.btc_htlc;
        const spendChecker = SELL.quote_asset ? (C.seqLeg && C.seqLeg.outspend) : (C.btcLeg && C.btcLeg.outspend);
        if (H && H.txid != null && H.vout != null && spendChecker){
          const os = await (SELL.quote_asset ? C.seqLeg : C.btcLeg).outspend(H.txid, H.vout);
          if (os.known && os.spent){
            SELL.state = 'failed';
            SELL.error = 'This trade is already resolved · your balance is up to date, and you can clear this.';
            saveSells();
            try { await C.sync(); } catch {}
          }
        }
      } catch { /* spend-check best-effort; leave as retryable */ }
      try { renderInFlightCard(); } catch {}   // surface the error + a Retry/Clear off-ramp
    }
    return;
  }
  // (B) Asset MAY have been paid but the /swap response was LOST (a network blip after the LSP
  //     settled): SELL is at 'paying' with a nonce but no preimage. RE-CALL /swap with the SAME
  //     nonce — the LSP returns the already-settled {preimage, btc_htlc} idempotently (it never
  //     re-pays for a stored nonce), then we claim as usual. This closes the fund-loss window.
  if (SELL.state === 'paying' && SELL.swap_nonce && !SELL.preimage){
    // FUND-SAFETY: NEVER clear on the TTL before an idempotent recovery re-call. The old code
    // cleared any old 'paying' record assuming "unsettled -> auto-returned" — but a payment that
    // DID settle and only lost its response left the asset spent and the BTC owed; clearing it
    // abandoned that BTC. So re-call FIRST; only clear once the LSP confirms the payment did not
    // settle. If the service is unavailable, keep the record (retry next load) regardless of age.
    if (!(L && L.swap && L.assetNodeKey)) return;                                             // service unavailable in this build; retry next load
    if (SELL.quote_asset ? !(C.seqLeg && C.seqLeg.claim && C.seqLeg.claimKey)
                         : !(C.btcLeg && C.btcLeg.claim && C.btcLeg.claimKey && C.btcLeg.verifyClaimable)) return;
    try {
      const asset = SELL.asset, offer = SELL.offer || null;
      const btc_claim_pub = (SELL.quote_asset ? C.seqLeg.claimKey() : C.btcLeg.claimKey()).public_key;     // re-derived the SAME way startSell does
      const node_key = await L.assetNodeKey(asset);
      if (L.connectNode){ const prov = await L.connectNode(asset); if (!(prov && prov.connected)) return; }
      const resp = await L.swap({ side: 'sell', asset, node_key, btc_claim_pub, amount: SELL.amount,
        quote_asset: SELL.quote_asset || undefined,
        payRail: 'ln', recvRail: 'chain',
        offer_id: offer && offer.offer_id, maker_pubkey: offer && offer.maker_pubkey,
        swap_nonce: SELL.swap_nonce });
      if (!(resp && resp.settled && resp.preimage && resp.btc_htlc)){
        // Confirmed NOT settled. Only now is a TTL clear safe: past the Lightning leg's own timeout
        // an unsettled asset payment has auto-returned, so this record can never complete. Within the
        // TTL, keep it for a later retry.
        if (SELL.ts && (Date.now() - SELL.ts) > SELL_PAYING_TTL_MS){ clearSell(SELL); try { C.toast && C.toast('A sell that never completed has expired · any Lightning payment has been returned.'); } catch {} }
        return;
      }
      Object.assign(SELL, { state: 'claiming', ticker: SELL.ticker || ((C.assetMeta(asset)||{}).ticker || ''),
        preimage: resp.preimage, hash_h: resp.hash_h, btc_htlc: resp.btc_htlc,
        expected_btc: Number((offer && offer.btc_sats) || SELL.expected_btc || 0),
        ts: mixedTip() }); saveSells();
      await claimSell(SELL);
      try { C.toast && C.toast('Recovered your sell · you received your funds (' + String(SELL.claim_txid||'').slice(0,16) + '…).'); } catch {}
      try { await C.sync(); } catch {}
      clearSell(SELL);
    } catch (e){ /* leave the 'paying' record; its nonce keeps recovery idempotent on the next load */ }
    return;
  }
}
// ===========================================================================
// Sub-asset BUY flow — the MIRROR of the sub-asset SELL, roles flipped. The taker pays BTC in an
// ON-CHAIN HTLC and receives the asset over LIGHTNING, bound by ONE preimage the DEVICE owns.
// The device generates P/H, registers a HODL invoice on H at its OWN hosted asset node (no
// bolt11 — the maker pays H BY HASH), FUNDS a BTC HTLC on H (maker claims with P, device refunds
// after T_btc), then commands the LSP to drive the maker's pay-by-hash. Once the asset payment is
// HELD at the device's node, the device SETTLES with P — releasing the asset to itself AND
// revealing P so the maker claims the BTC. FUND-CRITICAL: the BTC HTLC is locked BEFORE /swap, so
// BUY is persisted+resumable; resumeBuy() settles (asset in) once held, or refunds the BTC after
// T_btc. INVARIANT: the LSP/maker are BLIND to P until the device settles; the maker claims BTC
// with its identity key (seqdex 2152f33). BUY and SELL stay on SEPARATE books (ln_direction 5 vs 4).
// ONE RECORD PER BUY, not one record for the wallet.
//
// This was a single localStorage key holding a single record, so a buy that could not complete blocked
// the ENTIRE rail until its CLTV refund matured — hours. That happened for real: a maker rotated its
// identity out from under a funded HTLC, leaving a trade nothing could fill, and with it every future
// sub-asset buy in that wallet. One stuck counterparty should cost one trade, not the rail.
//
// Same shape as SUBSWAPS (the rail-crossing trades): an array persisted under one key, records carrying
// their own id, terminal ones dropped individually. The legacy single-record key is migrated on load so
// an in-flight buy from the old build is not orphaned by the upgrade.
const BUY_KEY = 'swk.subasset.buy';        // legacy single-record key (migrated, then removed)
const BUYS_KEY = 'swk.subasset.buys';
let BUYS = [];
try {
  const raw = JSON.parse(localStorage.getItem(BUYS_KEY) || 'null');
  if (Array.isArray(raw)) BUYS = raw.filter(Boolean);
} catch { BUYS = []; }
if (!BUYS.length){
  try { const one = JSON.parse(localStorage.getItem(BUY_KEY) || 'null'); if (one) BUYS = [one]; } catch {}
}
for (const b of BUYS) if (b && !b.id) b.id = newTradeId();
// RESCUE ADOPTION: 'swk.rescue.buys' is a side-channel for recovery records (a funded HTLC whose
// primary record was lost — e.g. erased by a sibling tab running pre-merge code). Nothing else ever
// writes this key, so it survives any clobber of the primary store; every boot re-adopts what it has
// not seen (by id/hash) and drops entries that have gone terminal. Idempotent by design.
try {
  const rescue = JSON.parse(localStorage.getItem('swk.rescue.buys') || 'null');
  if (Array.isArray(rescue)){
    const live = [];
    for (const r of rescue){
      if (!r || !(r.btc_htlc && r.btc_htlc.txid)) continue;
      if (r.state === 'settled' || r.state === 'refunded' || r.state === 'failed') continue;
      live.push(r);
      const seen = BUYS.some((b) => b && ((r.id && b.id === r.id) || (r.hash_h && b.hash_h === r.hash_h)));
      if (!seen){ if (!r.id) r.id = newTradeId(); BUYS.push(r); }
    }
    localStorage.setItem('swk.rescue.buys', JSON.stringify(live));
  }
} catch {}
// Synchronous in-flight sentinel (mirror of _sellStarting). A record only reaches 'funded' AFTER the
// pre-fund prologue, so without this two rapid starts could both pass the slot check and fund two BTC
// HTLCs for one slot. It bounds CONCURRENT STARTS, not the number of live buys.
let _buyStarting = false;
function saveBuys(){
  try { stampStages(BUYS); } catch {}
  try { mergedStoreSave(BUYS_KEY, BUYS, _buyTombstones); } catch {}
  try { localStorage.removeItem(BUY_KEY); } catch {}
  try { renderInFlightCard(); } catch {}
}
function addBuy(rec){ rec.id = rec.id || newTradeId(); BUYS.push(rec); saveBuys(); return rec; }
// Drop ONE record (by identity, falling back to id so a re-parsed copy still matches).
function clearBuy(rec){
  if (!rec){ for (const r of BUYS) if (r && r.id) _buyTombstones.add(r.id); BUYS = []; saveBuys(); return; }
  if (rec.id) _buyTombstones.add(rec.id);
  BUYS = BUYS.filter((r) => r !== rec && !(rec.id && r && r.id === rec.id));
  // Retire any rescue copy of this record: the trade is terminal, so the side-channel must not
  // resurrect it on the next boot.
  try {
    const rescue = JSON.parse(localStorage.getItem('swk.rescue.buys') || 'null');
    if (Array.isArray(rescue))
      localStorage.setItem('swk.rescue.buys', JSON.stringify(rescue.filter((r) =>
        r && !(rec.id && r.id === rec.id) && !(rec.hash_h && r.hash_h === rec.hash_h))));
  } catch {}
  saveBuys();
}
function buyTerminal(b){ return !b || b.state === 'settled' || b.state === 'failed' || b.state === 'refunded'; }
function activeBuys(){ return BUYS.filter((b) => !buyTerminal(b)); }
// Buys count against the SAME global ceiling as the other rails: each one ties up real Bitcoin while
// it runs, so the bound is about committed value, not about which rail happens to commit it.
function buySlotsFree(){ return (activeBuys().length + activeSells().length + activeSubswaps().length + (hasBridgeInFlight() ? 1 : 0)) < MAX_CONCURRENT_TRADES; }
// True while a buy is starting or has FUNDED its BTC HTLC but is not yet settled/refunded — the BTC is
// locked, so the record must survive a reload (resumeBuy settles on hold, or refunds after T_btc).
export function hasBuyInFlight(){ return !!(_buyStarting || activeBuys().length); }
// T_btc safety delta over the current BTC tip (parent-chain blocks), matching the maker's
// BtcLocktimeDelta so the refund branch matures well after the swap should have settled.
const BUY_CLTV_DELTA = 100;

// CAN THIS BUILD ACTUALLY EXECUTE A SUB-ASSET BUY (pay BTC on-chain, receive the asset
// over Lightning)? These are startBuy's OWN prerequisites, named once so the composer
// gates Place on exactly what the executor requires.
//
// It must be one predicate, not two lists that drift: enabling Place while startBuy
// would throw is an offer-then-refuse — the user gets a priced, confirmable trade and a
// dead end. That is precisely what happened when the composer learned to re-quote onto a
// sub-asset offer: it could now FIND one, and still could not settle it, because this
// build ships neither the wasm HTLC helpers nor the LSP invoice/settle client.
function subAssetBuySupported(){
  return !!(L && L.swap && L.assetNodeKey && L.nodeInvoice && L.invoiceStatus && L.nodeSettle
    && C.btcLeg && C.btcLeg.fund && C.btcLeg.refund && C.btcLeg.refundKey && C.btcLeg.tipHeight
    && C.wasm && C.wasm.generateSwapSecret && C.wasm.buildSeqHtlcRedeemScript);
}
// What to SAY when it is not. Names the rail and the one thing that resolves it, instead
// of "try again shortly" — this is a build capability, not a transient condition.
function subAssetBuyUnsupportedNote(tk){
  return `Receiving ${tk || 'this asset'} over Lightning while paying Bitcoin on-chain is not settled by this build yet · switch your receive leg to on-chain to take this offer now.`;
}
// CAN THIS BUILD EXECUTE A MIXED SAME-CHAIN SWAP (one leg over Lightning, the on-chain
// leg an issued asset)? The seqLeg twin of subAssetBuySupported: the BUY funds/refunds a
// Sequentia HTLC on the quote asset; the SELL claims one. One predicate, gating Place on
// exactly what the executors require.
function subAssetMixedSupported(){
  return !!(L && L.swap && L.assetNodeKey && L.nodeInvoice && L.invoiceStatus && L.nodeSettle
    && C.seqLeg && C.seqLeg.fund && C.seqLeg.refund && C.seqLeg.refundKey && C.seqLeg.claim
    && C.seqLeg.findFundingByAddress
    && C.wasm && C.wasm.generateSwapSecret && C.wasm.buildSeqHtlcRedeemScript);
}
async function startBuy(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  const offer = params.offer || null;
  // Mixed same-chain: the on-chain leg is THIS issued asset (the pair's quote) on the
  // Sequentia chain via C.seqLeg, instead of Bitcoin via C.btcLeg. Everything else —
  // the HODL invoice, the preimage discipline, the LSP job — is identical.
  const qh = params.quoteAsset || null;
  const qm = qh ? (C.assetMeta(qh) || {}) : { ticker: 'BTC', precision: 8 };
  const qtk = qm.ticker || 'quote';
  // Bound CONCURRENT buys against the same ceiling as every other rail, rather than allowing exactly
  // one ever. _buyStarting still serialises the pre-fund prologue so two rapid starts cannot both pass
  // this check and fund two HTLCs for one slot.
  if (_buyStarting || !buySlotsFree()){ if (C.toast) C.toast(inFlightBlockMessage()); return; }
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Buying ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  // Persisted + resumable (resumeBuy settles on hold / refunds the BTC after its timeout on reload),
  // so this modal is a progress view, not a lock: closing it never cancels the buy, and a second buy
  // stays blocked by hasBuyInFlight. Dismissable from the start; label firms to "Close" on settle (W5).
  const closeBtn = C.el('button','ghost','Run in background'); closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.textContent = 'Close'; };
  let b = null;            // THIS buy's record; created at persist-before-broadcast
  try {
    _buyStarting = true;   // serialise the pre-fund prologue so two starts cannot share one slot (TOCTOU)
    // One predicate, shared with the composer's Place gate (see subAssetBuySupported), so
    // Review can never enable a Place this then refuses.
    if (qh ? !subAssetMixedSupported() : !subAssetBuySupported()) throw new Error(subAssetBuyUnsupportedNote(am && am.ticker));
    const makerClaimPub = offer && (offer.maker_claim_pub || offer.maker_claim_pubkey);
    if (!offer || !makerClaimPub) throw new Error('No resting ' + am.ticker + ' buy offer right now · try again shortly.');
    say('Preparing your buy…');
    // 1. DEVICE generates the secret. Only we ever hold P until WE settle.
    const sec = C.wasm.generateSwapSecret();            // { secret_hex, hash_hex }
    const H = sec.hash_hex, P = sec.secret_hex;
    const node_key = await L.assetNodeKey(asset);       // our OWN hosted asset node RECEIVES the asset over LN
    const wholeAsset = Number(offer.asset_amount), wholeBtc = Number(offer.btc_sats);
    let assetAtoms = wholeAsset, btcSats = wholeBtc;
    // AUTHORITATIVE FILL (fund-safety): the composer carries the EXACT sized take it DISPLAYED
    // (expectedAssetAtoms / expectedBtcSats). Lift PRECISELY that — never re-derive the fill from this offer's
    // ratio. Re-deriving against a DIFFERENT offer than displayed showed "50 GOLD for 500000 sats" but delivered
    // 25 GOLD; carrying the shown fill makes settlement == what the user saw.
    const wantAtoms = (params.expectedAssetAtoms != null && Number(params.expectedAssetAtoms) > 0) ? BigInt(params.expectedAssetAtoms) : 0n;
    const wantBtc   = (params.expectedBtcSats   != null && Number(params.expectedBtcSats)   > 0) ? BigInt(params.expectedBtcSats)   : 0n;
    if (wantAtoms > 0n && wantBtc > 0n){
      assetAtoms = Number(wantAtoms); btcSats = Number(wantBtc);
      // DEFENSE-IN-DEPTH: the offer we are about to lift MUST be the SAME (price) as the one displayed. Re-derive
      // the maker's ceil-proportional BTC need for the authoritative asset fill from THIS offer's ratio; if it
      // disagrees with the carried BTC by more than 1 sat of rounding (or the fill exceeds the offer), we would
      // be paying against a DIFFERENT-priced offer than shown — refuse before locking any Bitcoin.
      const bW = BigInt(wholeAsset), bB = BigInt(wholeBtc);
      const need = bW > 0n ? ceilDiv(bB * wantAtoms, bW) : 0n;
      const gap = wantBtc > need ? wantBtc - need : need - wantBtc;
      if (bW <= 0n || wantAtoms > bW || gap > 1n)
        throw new Error('This trade’s price changed · reopen the order book and try again.');
    } else {
      // Legacy fallback (no carried fill): T8 partial — if the user entered LESS BTC than the offer's full
      // price, take a proportional slice. BigInt, NOT float: the price must EXACTLY equal the maker's integer
      // ProportionalBtc(ceil). A float multiply overflows 2^53 for large offers and diverged by +1 in ~0.6% of
      // cases, so the maker would reject AFTER the BTC HTLC is funded → stranded until the CLTV refund.
      // assetAtoms = floor slice of the entered BTC; btcSats = ceil(wholeBtc*assetAtoms/wholeAsset).
      const reqBtcSats = (params.amount != null && Number(params.amount) > 0) ? Math.round(Number(params.amount) * 1e8) : 0;
      if (reqBtcSats > 0 && reqBtcSats < wholeBtc){
        const bW = BigInt(wholeAsset), bB = BigInt(wholeBtc);
        let a = (bW * BigInt(reqBtcSats)) / bB;   // floor
        if (a < 1n) a = 1n;
        assetAtoms = Number(a);
        btcSats = Number(ceilDiv(bB * a, bW));
      }
    }
    // Bring our asset LN node's device signer ONLINE so it can register + settle the HODL invoice.
    // NAME EACH STEP. These three awaits are unbounded LSP round-trips, and they all used to print the
    // SAME 'Completing your trade …', so a hang in any of them was indistinguishable from the others —
    // the user (and we) could not tell whether the node, the channel or the invoice was stuck.
    if (L.connectNode){
      say('Connecting your Lightning node …');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not reach Lightning right now · reopen the wallet and try again.');
    }
    // Ensure inbound asset liquidity so the maker can pay us over LN (JIT 0-conf; idempotent, best-effort).
    if (L.channelInbound){ say('Preparing Lightning to receive ' + am.ticker + ' …'); try { await L.channelInbound({ node_key, asset, amount: assetAtoms }); } catch {} }
    // 2. Register a HODL invoice on H at our OWN node (NO bolt11; the maker pays H BY HASH). Device keeps P.
    say('Registering your Lightning invoice …');
    const inv = await L.nodeInvoice({ node_key, asset, amount: assetAtoms, payment_hash: H });
    if (!(inv && (inv.payment_hash || inv.hodl))) throw new Error('This trade could not be completed - your funds are safe.');
    // 3. Build + FUND the BTC HTLC on H: maker claims with P, device refunds after T_btc (the PROVEN
    //    xswap.js:689-695 engine, roles flipped). T_btc = max(offer.onchain_cltv, tip + delta).
    const refund = qh ? C.seqLeg.refundKey() : C.btcLeg.refundKey();   // device refund key; only we can refund
    const tip = qh ? await seqTipHeight() : await C.btcLeg.tipHeight();
    const T_btc = Math.max(Number(offer.onchain_cltv || 0), tip + BUY_CLTV_DELTA);
    const redeem = C.wasm.buildSeqHtlcRedeemScript(H, makerClaimPub, refund.public_key, T_btc);
    // LIVE-BOOK RECONFIRM, immediately before the irreversible fund: the reviewed offer must
    // still rest byte-for-byte on its economic terms. Refusing here loses nothing (only the
    // hold invoice on our own node, which simply expires); funding a stale copy strands the
    // locked funds until the CLTV refund when the maker refuses the mismatched amount.
    say('Re-checking the offer …');
    await reconfirmSubassetOffer(asset, 'buy', qh, offer);
    // PERSIST-BEFORE-BROADCAST (fund-safety): the funding tx below locks BTC and then BLOCKS for a
    // confirmation (minutes). H is random (NOT HD-derivable) and the redeem script embeds it, so losing
    // it before the txid is captured strands the BTC with no refund. Persist the recovery material as
    // 'funding' NOW, capture the txid via onBroadcast (BEFORE the confirmation wait), and advance to
    // 'funded' only once the outpoint is known. resumeBuy recovers a 'funding' record by its txid.
    b = addBuy({ state: 'funding', asset, ticker: am.ticker, preimage: P, hash_h: H, node_key,
      started_ms: Date.now(),         // total-elapsed anchor for the progress narrative + settle card
      quote_asset: qh || undefined,   // mixed same-chain: the on-chain leg's REAL asset (absent = BTC)
      btc_htlc: { redeem_script: redeem, cltv: T_btc, amount: btcSats, maker_claim_pub: makerClaimPub, taker_refund_pub: refund.public_key },
      t_btc: T_btc, asset_amount: assetAtoms, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey, ts: mixedTip() });
    say(qh ? ('Locking your ' + qtk + ' …') : 'Locking your Bitcoin …');
    // 0-CONF HAND-OFF: do NOT block on a Bitcoin confirmation here. This rail delivers the asset over
    // Lightning, so waiting for a block before even commanding the maker gave the trade Bitcoin's
    // latency for no protocol reason — the exact "why am I waiting for a Bitcoin confirmation?" this
    // rail exists to avoid. The maker carries the 0-conf risk and advertises its own policy, so it
    // makes that call on the outpoint we hand it. The CLTV refund path is unchanged.
    let funded;
    if (qh){
      // Sequentia HTLC on the quote asset (0-conf hand-off identical to the BTC leg): fund via the
      // wallet's own tx builder, persist the txid the moment it exists, then locate the HTLC vout
      // (esplora includes mempool UTXOs, so this resolves at 0-conf).
      const r = await C.seqLeg.fund(redeem, qh, btcSats);
      if (b && b.btc_htlc){ b.btc_htlc.txid = String(r.txid); saveBuys(); }
      const f = await C.seqLeg.findFundingByAddress(redeem);
      funded = { txid: String(r.txid), vout: f && f.txid === String(r.txid) ? f.vout : (f ? f.vout : 0) };
    } else {
      funded = await C.btcLeg.fund(redeem, btcSats, (txid) => { if (b && b.btc_htlc){ b.btc_htlc.txid = String(txid); saveBuys(); } }, { waitConf: false });
    }
    b.btc_htlc.txid = String(funded.txid); b.btc_htlc.vout = funded.vout; b.state = 'funded'; saveBuys();
    const btc_htlc = b.btc_htlc;   // { txid, vout, amount, redeem_script, cltv, ... } for the /swap call
    logTrade({ id: 'buy:' + H, title: 'Buying ' + am.ticker + ' with ' + qtk, status: qtk + ' locked' });
    // 4. Command the LSP to drive the maker's pay-by-hash (ASYNC job -> 202 { job_id, poll, held:false }).
    say('Waiting for your trade to settle …');
    const job = await L.swap({ side: 'buy', hodl: true, asset, node_key, payment_hash: H, asset_amount: assetAtoms,
      quote_asset: qh || undefined,
      payRail: 'chain', recvRail: 'ln', btc_htlc, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey });
    b.job_id = job && (job.job_id || job.jobId); b.poll = job && job.poll; saveBuys();
    // 5. Wait for the maker's asset payment to arrive HELD, then DEVICE-SETTLE with P (or refund after T_btc).
    say('Waiting for your trade to settle …');
    await driveBuy(b, say);
    if (b.state === 'settled'){ say('Done · your ' + qtk + ' bought ' + am.ticker + ', received over Lightning.', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(b); }
    else if (b.state === 'refunded'){ say('This trade didn’t complete in time · your Bitcoin has been returned (' + String(b.refund_txid||'').slice(0,16) + '…).', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(b); }
    else { done(); }
  } catch (e){
    // If the BTC HTLC was already funded, KEEP the record for settle/refund on reload — never lose it.
    // If the prologue threw before funding, drop the stub so it does not hold a slot forever.
    const funded = !!(b && (b.state === 'funded' || b.state === 'holding'));
    say('Failed: ' + C.prettyErr(e) + (funded ? ' · your Bitcoin is still locked; reopen the wallet to finish or refund it.' : ''), 'err');
    if (b && !funded && !b.btc_htlc?.txid) clearBuy(b);
    done();
  } finally {
    _buyStarting = false;   // hand off to the per-record state guard
  }
}
// Poll the HODL invoice on our node until the maker's asset payment is HELD, then device-settle with
// P (releases the asset to us AND reveals P so the maker claims the BTC), then best-effort confirm the
// LSP job settled. Bounded by T_btc: if the asset never holds before the BTC HTLC times out, refund
// the BTC (the ONLY loss-avoiding path). Shared by startBuy and resumeBuy. Mutates + persists BUY.
async function driveBuy(b, say){
  say = say || (() => {});
  const H = b.hash_h, node_key = b.node_key;
  // Enriched receipt (P5.1): sub-asset BUY = BTC paid on-chain, asset received over LN. base = asset,
  // quote = BTC; size = asset units bought, price = BTC paid per asset unit (best-effort from the HTLC).
  // Shared by BOTH terminal-success paths (settle-now and already-settled) so a completed trade is
  // never left showing its fund-time 'BTC locked' row. Same id as that row, so it upgrades in place.
  const buyReceipt = () => {
    const buyAssetU = (() => { try { return Number(big(b.asset_amount || 0)) / Math.pow(10, (metaOf(b.asset) || {}).precision || 0); } catch { return null; } })();
    const buyBtcU = (() => { try { return Number(big((b.btc_htlc && (b.btc_htlc.amount || b.btc_htlc.btc_sats)) || 0)) / 1e8; } catch { return null; } })();
    logTrade({ id: 'buy:' + H, title: 'Bought ' + b.ticker + ' with ' + (b.quote_asset ? ((C.assetMeta(b.quote_asset) || {}).ticker || 'quote') : 'BTC'), status: 'asset received',
      rail: 'sub-asset', preimage: b.preimage || null, pair: (b.ticker || 'asset') + '/' + (b.quote_asset ? ((C.assetMeta(b.quote_asset) || {}).ticker || 'quote') : 'BTC'), side: 'buy',
      size: buyAssetU, sizeTicker: b.ticker || null,
      price: (buyBtcU != null && buyAssetU > 0) ? buyBtcU / buyAssetU : null,
      // Task 19b: UPGRADE the fund-time '<QUOTE> locked' row in place (same id) — for the BTC
      // shape and the quote shape alike. Task 21b: this is a genuine settlement -> settle card,
      // with the funding txid linked on its own chain (testnet4 for the BTC shape).
      upgrade: true, card: true,
      txids: (b.btc_htlc && b.btc_htlc.txid) ? [b.btc_htlc.txid] : [],
      parentTxids: (!b.quote_asset && b.btc_htlc && b.btc_htlc.txid) ? [b.btc_htlc.txid] : [],
      elapsed_ms: (b.started_ms > 0) ? (Date.now() - b.started_ms) : null });
  };
  // Reconcile a dropped/interrupted LSP job. The LSP now PERSISTS jobs, so a restart no longer 404s
  // ours — it reloads the job and, because the in-process driver died with the old process, marks it
  // 'interrupted'. Either signal (404/gone, 'failed', or 'interrupted') means the maker's pay-by-hash
  // is no longer being driven, so drop the stale id and let the re-issue below re-command the maker.
  // Safe to repeat: the on-chain HTLC is already funded and the hosted node's hold invoice on H can
  // only be paid once, so a duplicate command is idempotent. (Skipped on a fresh startBuy, whose
  // job_id points at a live job.)
  // Read the job's liveness. jobStatusRaw, NOT jobStatus: lspFetch rejects on ok:false, so a FAILED
  // job answers with an exception and the caller that most needs the reason gets none. Returns
  // { alive, reason } — a transport error reads as alive (we cannot conclude a job died from a
  // network blip; the refund guard is the real backstop).
  const jobAlive = async () => {
    const read = (L && (L.jobStatusRaw || L.jobStatus)) || null;
    if (!b.job_id || !read) return { alive: true, reason: '' };
    try {
      const v = jobIsDead(await read(b.poll || ('/swap/' + b.job_id)));
      return { alive: !v.dead, reason: v.reason };
    } catch { return { alive: true, reason: '' }; }   // transport-only: inconclusive, keep waiting
  };
  // Drop a dead job and re-command the maker. The LSP now PERSISTS jobs, so a restart no longer 404s
  // ours — it reloads the job and, because the in-process driver died with the old process, marks it
  // 'interrupted'. Either signal (404/gone, 'failed', or 'interrupted') means the maker's pay-by-hash
  // is no longer being driven. Safe to repeat: the on-chain HTLC is already funded and the hosted
  // node's hold invoice on H can only be paid once, so a duplicate command is idempotent.
  let revivals = 0, lastReason = '';
  const reviveJob = async () => {
    const { alive, reason } = await jobAlive();
    if (alive) return false;
    if (reason) lastReason = reason;
    b.job_id = null; b.poll = null; saveBuys();
    if (!b.btc_htlc) return false;
    revivals++;
    try {
      // DROP THE OFFER ID, KEEP THE MAKER. Resting offers expire and re-post under new ids every few
      // minutes, so by the time a job needs reviving the quoted id is usually gone and re-commanding
      // it fails identically forever ('no verified sub-asset offer found') while the book holds a
      // perfectly good offer from the same maker.
      //
      // The MAKER, though, is not interchangeable: its claim key is baked into the funded HTLC's
      // redeem script, so only that maker can ever claim the BTC. Re-matching to a different one is
      // refused — correctly — with 'redeemScript mismatch', the two scripts differing in exactly that
      // one field. So a revival asks for the same maker's CURRENT offer, whatever it is now.
      const job = await L.swap({ side: 'buy', hodl: true, asset: b.asset, node_key, payment_hash: H,
        asset_amount: b.asset_amount, quote_asset: b.quote_asset || undefined,
        payRail: 'chain', recvRail: 'ln', btc_htlc: b.btc_htlc,
        maker_pubkey: b.maker_pubkey });
      b.job_id = job && (job.job_id || job.jobId); b.poll = job && job.poll; saveBuys();
      return true;
    } catch (e){ lastReason = String((e && e.message) || lastReason || ''); return false; }
    // never rethrow — the refund guard below is what actually protects the funds
  };
  await reviveJob();
  // Resume-after-crash-before-swap: funded the BTC but never got a job id at all. Same reasoning as
  // the revival above — this runs long after the quote, so the originally-named offer is usually gone,
  // while the maker must stay pinned because the funded HTLC carries its claim key.
  if (!b.job_id && b.btc_htlc){
    try {
      const job = await L.swap({ side: 'buy', hodl: true, asset: b.asset, node_key, payment_hash: H,
        asset_amount: b.asset_amount, quote_asset: b.quote_asset || undefined,
        payRail: 'chain', recvRail: 'ln', btc_htlc: b.btc_htlc,
        maker_pubkey: b.maker_pubkey });
      b.job_id = job && (job.job_id || job.jobId); b.poll = job && job.poll; saveBuys();
    } catch {}   // never mind — the refund guard below still protects the funds
  }
  let tick = 0;
  for (;;){
    // RECONCILE THE JOB, NOT ONLY THE INVOICE. This loop used to poll invoice-status alone, so a job
    // that died moments after its 202 left the wallet printing 'Completing your trade …' until T_btc —
    // hours of silence for a failure the LSP already knew about, rescuable only by reloading the page
    // (which ran the one-shot reconcile above). Caught live on the first on-chain→LN take. Re-check
    // every ~30s: cheap next to a 6s invoice poll, and it turns a silent stall into either a revived
    // job or an honest reason.
    if (tick && tick % 5 === 0){
      const revived = await reviveJob();
      if (revived) say('Re-sending your order to the seller …' + (revivals > 1 ? ' (attempt ' + revivals + ')' : ''));
      else if (lastReason && !b.job_id)
        // The job is dead AND could not be re-commanded. Say so, with the reason and the block at which
        // the Bitcoin comes back on its own, rather than an indefinite reassuring spinner.
        say('The seller isn’t responding · ' + C.prettyErr(new Error(lastReason))
          + (b.t_btc ? ' · your ' + (b.quote_asset ? ((C.assetMeta(b.quote_asset) || {}).ticker || 'funds') : 'Bitcoin') + ' returns automatically at block ' + b.t_btc + ' if this doesn’t complete.' : ''));
    }
    tick++;
    let tip = 0; try { tip = b.quote_asset ? await seqTipHeight() : await C.btcLeg.tipHeight(); } catch {}
    const status = await L.invoiceStatus({ node_key, payment_hash: H }).catch(() => null);
    // ALREADY SETTLED. Reached when the hold was settled outside this loop (a resume, or a second
    // driver instance that won the race). The trade is COMPLETE, so it needs the same receipt the
    // held-branch writes — without this the history kept the fund-time row, and a trade that had
    // actually delivered the asset was listed forever as 'BTC locked'. Seen live: a settled GOLD buy
    // sat in the log as pending next to an identical one that had gone through the held branch.
    if (status && status.settled){ b.state = 'settled'; saveBuys(); buyReceipt(); return; }
    if (status && status.held){
      b.state = 'holding'; saveBuys();
      say('Payment received · completing your trade …');
      await L.nodeSettle({ node_key, payment_hash: H, preimage: b.preimage });   // 5. device-settle
      b.state = 'settled'; saveBuys();
      buyReceipt();
      // 6. best-effort: confirm the maker claimed the BTC (job settled). Non-fatal.
      if (L.jobStatus && (b.poll || b.job_id)){ try { const j = await L.jobStatus(b.poll || ('/swap/' + b.job_id)); if (j && j.status) { b.detail = j.status; saveBuys(); } } catch {} }
      return;
    }
    if (tip && b.t_btc && tip >= b.t_btc){ say('This trade didn’t complete in time · returning your Bitcoin …'); await refundBuy(b); return; }   // 7. refund branch
    await new Promise(r => setTimeout(r, 6000));
  }
}
// Refund the funded BTC HTLC via its CLTV branch after T_btc (a real on-chain reclaim). Terminal.
async function refundBuy(b){
  const H = b.btc_htlc;
  let txid;
  if (b.quote_asset){
    // Mixed same-chain: reclaim the quote-asset HTLC on the Sequentia chain via its CLTV branch.
    txid = await C.seqLeg.refund({ txid: H.txid, vout: H.vout, amount: H.amount, asset_id: b.quote_asset,
      redeem_script: H.redeem_script, locktime: b.t_btc,
      refund_secret: C.seqLeg.refundKey().secret_hex });
  } else {
    txid = await C.btcLeg.refund({ txid: H.txid, vout: H.vout, amount: H.amount, redeem_script: H.redeem_script, locktime: b.t_btc });
  }
  b.state = 'refunded'; b.refund_txid = (txid && txid.toString) ? txid.toString() : String(txid); saveBuys();
  const qtk2 = b.quote_asset ? ((C.assetMeta(b.quote_asset) || {}).ticker || 'funds') : 'BTC';
  // upgrade: replace the fund-time '<QUOTE> locked' row (same id) — a refunded buy must not
  // read as still locked. No settle card: a refund is not a settlement.
  logTrade({ id: 'buy:' + (b.hash_h || ''), title: 'Buy refunded (' + b.ticker + ')', status: qtk2 + ' refunded', txid: b.refund_txid, upgrade: true });
}
// On wallet load: if a buy funded its BTC HTLC but never completed, resume it — settle if the asset
// is now held, or refund the BTC once past T_btc. The fund-recovery path (mirrors resumeSell).
// Every active record is resumed INDEPENDENTLY and CONCURRENTLY: one stuck counterparty must not hold
// up another trade's settle or refund, which is the whole point of keying these per buy.
const _resumingBuys = new Set();
export async function resumeBuy(){
  await Promise.all(activeBuys().map((b) => resumeOneBuy(b)));
}
async function resumeOneBuy(b){
  if (!b || !b.preimage || !b.btc_htlc) return;
  if (_resumingBuys.has(b.id)) return;   // already being driven by an earlier call
  _resumingBuys.add(b.id);
  try {
    // A 'funding' record died between persist-before-broadcast and confirmation. If onBroadcast captured
    // the txid, the BTC is locked -> recover the outpoint and advance to 'funded'. If no txid was ever
    // captured, the funding never broadcast (nothing locked) -> drop the stub.
    if (b.state === 'funding'){
      if (!b.btc_htlc.txid){ clearBuy(b); return; }
      if (b.btc_htlc.vout == null){
        try {
          const f = b.quote_asset
            ? await C.seqLeg.findFundingByAddress(b.btc_htlc.redeem_script)
            : await C.btcLeg.findFunding(b.btc_htlc.txid, b.btc_htlc.redeem_script);
          if (f && f.vout != null){ b.btc_htlc.vout = f.vout; b.state = 'funded'; saveBuys(); }
          else return;   // not indexed yet; retry next load — the BTC stays refundable at T_btc
        } catch { return; }
      } else { b.state = 'funded'; saveBuys(); }
    }
    if (!(b.state === 'funded' || b.state === 'holding')) return;
    // BRING THE DEVICE SIGNER ONLINE FIRST. The user's asset node is KEYLESS: it only runs while the
    // device signer is attached, and a reload detaches it. driveBuy went straight to re-commanding the
    // LSP, which then could not reach the node at all — every retry died on
    // "inbound provisioning failed: lightning-rpc: Connection refused", forever, on a trade whose
    // Bitcoin was already locked. startBuy has always done this; the resume path simply never did.
    //
    // Best-effort: if it fails, driveBuy still runs and the refund guard still protects the funds.
    if (L && L.connectNode && b.asset){ try { await L.connectNode(b.asset); } catch {} }
    await driveBuy(b);
    if (b.state === 'settled'){ try { C.toast && C.toast('Recovered your buy · ' + b.ticker + ' received over Lightning.'); } catch {} try { await C.sync(); } catch {} clearBuy(b); }
    else if (b.state === 'refunded'){ try { C.toast && C.toast('Your buy timed out · Bitcoin refunded on-chain (' + String(b.refund_txid||'').slice(0,16) + '…).'); } catch {} try { await C.sync(); } catch {} clearBuy(b); }
  } catch (e){ /* leave persisted; the BTC is still refundable at T_btc — retried when the user re-enters Swap */ }
  finally { _resumingBuys.delete(b.id); }
}
// ===========================================================================
// Mixed-rail (submarine) swap — PERSISTED + RESUMABLE trade-process view.
// The asset leg is an anchored on-chain HTLC; if the swap stalls the ONLY recovery is
// to refund that HTLC after its CLTV timeout. So (like the cross-chain wizard) the
// in-flight swap is persisted to localStorage and resumed on load, with a live "Refund
// BTC leg" off-ramp — never a fire-and-forget modal that a refresh strands.
// ===========================================================================
function saveMixed(){ try { stampStages([MIXED]); } catch {} try { sub.saveSwap(localStorage, MIXED_KEY, MIXED); } catch {} }
function clearMixed(){ MIXED = null; try { sub.clearSwap(localStorage, MIXED_KEY); } catch {} }
// True while a submarine swap is persisted and NOT terminal — the composer resumes the
// stepper (instead of the composer) on tab entry, exactly like the cross-chain wizards.
export function hasMixedInFlight(){ return !!MIXED && !sub.isTerminal(MIXED); }
// The Sequentia tip height, against which the asset-leg HTLC's CLTV refund locktime is
// judged (the asset HTLC is on Sequentia; its refund matures at that height).
function mixedTip(){ try { return C.wollet ? C.wollet.tip().height() : 0; } catch { return 0; } }

// Start (and drive) a submarine swap: persist a live record FIRST (so a refresh mid-call
// still resumes), show the stepper, then command the LSP and fold the result back in.
let _mixedStarting = false;
async function startMixed(params){
  // Synchronous double-start guard: two confirmed reviews (double-tap / a second Review before the
  // first awaits) would each overwrite MIXED — the single-key handle to a funded submarine HTLC leg —
  // stranding the first. hasMixedInFlight covers a persisted swap; _mixedStarting covers the window
  // before the first newSwap persists.
  if (_mixedStarting || hasMixedInFlight()){ try { C.toast && C.toast('A swap is already in progress · finish or refund it first under Active trades.'); } catch {} return; }
  _mixedStarting = true;
  try {
    MIXED = sub.newSwap(params);
    // Idempotency key (fund-safety): the LSP dedupes a same-nonce re-POST to ONE submarine HTLC, so a
    // lost /swap response + a retry (or a restart-then-resume) never funds a second on-chain leg. Persist
    // it in the record and re-send the SAME value on any resume.
    MIXED.swap_nonce = MIXED.swap_nonce || newSwapNonce();
    saveMixed();
    showMixed(true); renderMixedSwap();
    const r = await L.swap({ side: params.side, asset: params.asset, amount: params.amount,
      payRail: params.payRail, recvRail: params.recvRail, swap_nonce: MIXED.swap_nonce });
    MIXED = sub.applyStatus(MIXED, r || {}); saveMixed();
    renderMixedSwap();
    if (!sub.isTerminal(MIXED)) pollMixed();
    else if (MIXED.state === sub.ST.SETTLED){
      try { C.toast('Swap settled.'); } catch {}
      try { await C.sync(); } catch {}
    }
  } catch (e){
    console.warn('[swap] mixed start error:', e);   // technical detail stays in the console; the UI shows only a plain sentence
    // A thrown swap: if an on-chain HTLC leg exists it stays SETTLING (refundable at its
    // timeout); with no leg to reclaim it is a clean failure.
    if (MIXED && MIXED.htlc){ MIXED = { ...MIXED, detail: 'Completing your trade - your funds are safe.' }; saveMixed(); pollMixed(); }
    else { MIXED = sub.markFailed(MIXED, 'This trade could not be completed - your funds are safe.'); saveMixed(); }
    renderMixedSwap();
  } finally {
    _mixedStarting = false;
  }
}

// Poll the LSP for the swap's progress until terminal (best-effort: needs L.swapStatus).
let _mixedPoll = null;
function pollMixed(){
  // Poll the LSP JOB handle (poll path / job_id captured from the 202), NOT MIXED.id (a LOCAL id from
  // newSwap that the LSP never knew). Without a handle there is no async job to poll — a sub-0-conf
  // submarine already answered synchronously and is terminal, so there is nothing to do.
  const pollRef = MIXED && (MIXED.poll || MIXED.job_id);
  if (!MIXED || sub.isTerminal(MIXED) || !(L && L.swapStatus) || !pollRef) return;
  clearTimeout(_mixedPoll);
  _mixedPoll = setTimeout(async () => {
    if (!MIXED || sub.isTerminal(MIXED)) return;
    try {
      const r = await L.swapStatus(MIXED.poll || MIXED.job_id);
      MIXED = sub.applyStatus(MIXED, r || {}); saveMixed(); renderMixedSwap();
      if (MIXED.state === sub.ST.SETTLED){ try { await C.sync(); } catch {} }
    } catch {}
    if (!sub.isTerminal(MIXED)) pollMixed();
  }, 8000);
}

// Show/hide the submarine stepper (mutually exclusive with the composer + the other
// wizard hosts), mirroring showCross/showReverse.
function showMixed(on){
  const mw = C.$('swapMixedWrap'), cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (mw) mw.classList.toggle('hide', !on);
  if (on){ if (cw) cw.classList.add('hide'); if (rw) rw.classList.add('hide'); }
  if (comp) comp.classList.toggle('hide', on);
}

// The trade-process view for the in-flight submarine swap: the phase, the on-chain HTLC
// leg, a "Refund BTC leg" off-ramp (live once the HTLC's CLTV timeout is buried), and an
// Abandon/Clear. Rendered on start AND on resume-after-reload.
function renderMixedSwap(){
  const host = C.$('swMixedStepper'); if (!host || !MIXED) return;
  const am = metaOf(MIXED.asset);
  const terminal = sub.isTerminal(MIXED);
  const tip = mixedTip();
  const refundable = sub.isRefundable(MIXED, tip);
  if (terminal) logTrade({ id: 'mx:' + (MIXED.id || MIXED.ts || (MIXED.htlc && MIXED.htlc.refund_locktime) || ''),
    title: (MIXED.side === 'buy' ? 'Bought ' : 'Sold ') + metaOf(MIXED.asset).ticker, status: MIXED.state,
    rail: 'submarine', pair: metaOf(MIXED.asset).ticker + '/BTC', side: MIXED.side === 'buy' ? 'buy' : 'sell',
    preimage: (MIXED.state === sub.ST.SETTLED ? (MIXED.preimage || null) : null),
    size: (MIXED.amount != null ? Number(MIXED.amount) / Math.pow(10, metaOf(MIXED.asset).precision || 0) : null),
    sizeTicker: metaOf(MIXED.asset).ticker,
    // Task 21b: only a genuinely SETTLED submarine gets the settle card (failed/refunded do not).
    card: MIXED.state === sub.ST.SETTLED,
    elapsed_ms: (MIXED.state === sub.ST.SETTLED && MIXED.started_ms > 0) ? (Date.now() - MIXED.started_ms) : null });
  const phase = {
    [sub.ST.SETTLING]:  'Completing your trade · confirming on Bitcoin.',
    [sub.ST.REFUNDING]: 'Refunding your trade…',
    [sub.ST.REFUNDED]:  'Refund sent · your funds return once it confirms.',
    [sub.ST.SETTLED]:   'Settled · reverts only if Bitcoin reverts.',
    [sub.ST.FAILED]:    MIXED.htlc ? 'Could not complete · refund below to get your funds back.' : 'Could not complete · nothing was spent.',
  }[MIXED.state] || MIXED.state;
  const dir = MIXED.side === 'buy'
    ? `Buy ${esc(am.ticker)} with BTC over Lightning · receive ${esc(am.ticker)} on-chain`
    : `Sell ${esc(am.ticker)} on-chain · receive BTC over Lightning`;
  const lock = MIXED.htlc && MIXED.htlc.refund_locktime;
  const legLine = MIXED.htlc
    ? (refundable
        ? `Your funds are past their refund time (block ${lock}) · you can get them back now.`
        : `Your funds can be refunded after block ${lock}${tip ? ` (currently at ${tip})` : ''}.`)
    : (MIXED.state === sub.ST.FAILED
        ? 'The trade did not start · nothing was funded, so there is nothing to get back.'
        : 'This trade completes on its own · nothing for you to do here.');
  // ALWAYS show the failure/progress detail — hiding it on terminal states left users
  // staring at a bare "Failed" with the actual reason discarded.
  const detail = MIXED.detail ? ' · ' + esc(MIXED.detail) : '';
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${dir}</span>
      <span class="sub">${esc(phase)}</span></div>
    <div class="swbook-row"><span class="sub">${esc(legLine)}${detail}</span></div>
    <div class="swbook-row" id="swMixedBtns"></div></div>`;
  const btns = C.$('swMixedBtns');
  // Only offer the reclaim button when a REAL refund mechanism exists (L.refund). Without it the
  // button used to broadcast nothing yet mark the swap REFUNDED — a fake success that told the user
  // their BTC was coming back while it stayed locked. When the LSP owns the on-chain leg, its own
  // driver reclaims after the CLTV timeout; we say so instead of offering a button we can't honour.
  const canRefund = !!(L && L.refund);
  if (MIXED.htlc && !terminal && MIXED.state !== sub.ST.REFUNDING){
    if (canRefund){
      const rb = C.el('button', 'danger', 'Reclaim your funds'); rb.id = 'swMixedRefund';
      rb.disabled = !refundable;
      if (!refundable) rb.title = `These funds can only be refunded after block ${lock}.`;
      rb.onclick = onRefundMixed;
      btns.appendChild(rb);
    } else {
      const note = C.el('span', 'sub');
      note.textContent = `Your funds are refunded automatically after block ${lock} - nothing to do here.`;
      btns.appendChild(note);
    }
  }
  const done = terminal;
  const clr = C.el('button', 'ghost', done ? 'Clear' : 'Dismiss');
  clr.onclick = () => {
    // Dismiss only HIDES a live swap (it keeps recovering + resumes; the Active-trades card
    // reopens it); Clear drops a terminal one. The _dismissed flag stops renderSwap from
    // bouncing straight back to this stepper.
    if (done) clearMixed(); else _dismissed.add('mixed');
    showMixed(false); renderSwap();
  };
  btns.appendChild(clr);
}

// Refund the on-chain HTLC leg after its CLTV timeout (a real on-chain reclaim). Mirrors
// xswap.js onRefundBtc: mark refunding, broadcast via the refund hook, mark refunded.
async function onRefundMixed(){
  if (!MIXED || !MIXED.htlc){ return; }
  if (!sub.isRefundable(MIXED, mixedTip())){
    try { C.toast('This trade can’t be refunded yet · its timeout has not passed.'); } catch {}
    return;
  }
  const kv = [
    ['Refunding', '⚠ Refunding your Bitcoin back to your wallet.'],
    ['Refund amount', (MIXED.htlc.amount != null ? MIXED.htlc.amount + ' base units' : 'the locked amount') + ' (minus the refund fee)'],
    ['After this', 'Your trade ends here (refunded).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Refund your trade', kv });
  ok.onclick = async () => {
    // NEVER fake a refund: without a real broadcast mechanism, a "refund" that returns no txid must
    // NOT mark the swap REFUNDED (that told the user their BTC was reclaimed while it stayed locked).
    if (!(L && L.refund)){
      st.className = 'status err';
      st.textContent = 'This build can’t refund from the wallet · your funds are refunded automatically after their timeout.';
      return;
    }
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding your trade…';
    MIXED = sub.markRefunding(MIXED); saveMixed(); renderMixedSwap();
    try {
      const txid = await L.refund({ id: MIXED.id, htlc: MIXED.htlc });
      if (!txid) throw new Error('the refund did not return a transaction id (nothing was broadcast)');
      MIXED = sub.markRefunded(MIXED, txid); saveMixed();
      modal.remove();
      C.toast(`Refunded: ${String(txid).slice(0, 18)}…`);
      try { await C.sync(); } catch {}
      renderMixedSwap();
    } catch (e){
      console.warn('[swap] mixed refund error:', e);   // technical detail stays in the console
      // Refund failed: revert to SETTLING so the off-ramp stays available to retry.
      MIXED = { ...MIXED, state: sub.ST.SETTLING }; saveMixed();
      st.className = 'status err'; st.textContent = 'Could not refund right now · please try again.'; ok.disabled = false;
      renderMixedSwap();
    }
  };
}

// On wallet open: rehydrate any non-terminal submarine swap so its trade-process view +
// Refund off-ramp come back after a reload (fund-safety). Mirrors resumeCrossMakers.
export function resumeMixedSwap(){
  MIXED = sub.resume(localStorage, MIXED_KEY);
  if (!MIXED) return;
  try { showMixed(true); renderMixedSwap(); } catch {}
  if (!sub.isTerminal(MIXED)) pollMixed();
  if (C.toast) try { C.toast('Resuming an interrupted swap · you can refund it here if it stalls.'); } catch {}
}

// Start a CROSS market from the wallet: post a signed forward cross offer (SELL
// the asset for BTC) and serve lifts over the courier (the maker HTLC runs in
// xmaker.js via the X.makerStart bridge). Unlike same-chain, cross settlement is
// interactive: the wallet must stay open to settle a lift (Bitcoin has no
// covenants). The offer rests only while the listener is open.
async function postCrossOfferReview(q){
  const { $ } = C;
  const reverse = !!q.reverse;   // reverse = BUY the asset with BTC; else SELL the asset for BTC
  const start = reverse ? (X && X.makerStartReverse) : (X && X.makerStart);
  if (!X || !start){ $('swErr').textContent = 'This trade could not be placed right now - try again shortly.'; return; }
  const assetHex = q.assetHex;
  const am = C.assetMeta(assetHex);
  // SELL: pay = asset, receive = BTC.  BUY: pay = BTC, receive = asset.
  let assetAtoms, btcSats;
  try {
    if (reverse){
      btcSats    = fieldAtoms($('swPayAmt'), 'BTC');
      assetAtoms = fieldAtoms($('swRecvAmt'), assetHex);
    } else {
      assetAtoms = fieldAtoms($('swPayAmt'), assetHex);
      btcSats    = fieldAtoms($('swRecvAmt'), 'BTC');
    }
    if (assetAtoms <= 0n || btcSats <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both amounts - the ${am.ticker} and the BTC.`; return; }
  if (reverse){
    const haveBtc = balAtoms('BTC');
    if (btcSats > haveBtc){ $('swErr').textContent = `You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`; return; }
  } else {
    const onc = balAtoms(assetHex), lnHeld = instantAtomsFor(assetHex);
    if (assetAtoms > onc){
      // A resting CROSS offer locks the asset in an ON-CHAIN HTLC, so it needs on-chain funds. If the
      // only reason for the shortfall is that the asset sits in Lightning, say that plainly rather than
      // a bare "you only hold" that reads wrong when a Lightning balance is visible.
      $('swErr').textContent = (lnHeld > 0n && (onc + lnHeld) >= assetAtoms)
        ? `You’ll need this ${am.ticker} on-chain to post this order · ${C.fmtAtoms(lnHeld, am.precision)} ${am.ticker} of yours is in Lightning and only ${C.fmtAtoms(onc, am.precision)} is on-chain. Move some ${am.ticker} back on-chain to post it.`
        : `You only hold ${C.fmtAtoms(onc, am.precision)} ${am.ticker}.`;
      return;
    }
  }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = reverse ? [
    ['Posting', `A resting CROSS bid · you post an offer others can take in the ${am.ticker}/BTC market`],
    ['You pay', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['You buy', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['Keep this tab open', 'Your wallet must stay open for this offer to stay active · closing it takes the offer down. Nothing is at risk (anything pending is returned automatically).'],
    ['Your funds', 'Your funds stay in your control until this completes.'],
  ] : [
    ['Posting', `A resting CROSS offer · you post an offer others can take in the ${am.ticker}/BTC market`],
    ['You sell', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['You want', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['Keep this tab open', 'Your wallet must stay open for this offer to stay active · closing it takes the offer down. Nothing is at risk.'],
    ['Your funds', 'Your funds stay in your control until this completes.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: reverse ? 'Buy with BTC - start this market' : 'Sell for BTC - start this market', kv });
  if (ok) ok.textContent = reverse ? 'Post cross bid' : 'Post cross offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const recvAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
      const handle = await start({ assetHex, assetAtoms, btcSats, expirySecs: 3600, recvAddr }, onCrossMakeState);
      XMAKE = { handle, assetHex, assetAtoms, btcSats, reverse, offerId: handle.offer.offer_id, state: 'resting' };
      modal.remove();
      C.toast('Cross offer posted - live in the order book. Keep this tab open to settle.');
      resetComposer();
      renderXMake();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not post: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Review + confirm for a BUY-with-BTC LIMIT order that rests via the SBTC silent peg (keepResting ON).
// Mirrors postCrossOfferReview's reverse (bid) modal, but on confirm pegs the BTC in and rests an SBTC
// covenant advertised as BTC (placePeggedBtcCovenant) instead of the interactive, wallet-must-stay-open
// HTLC maker. This is the ONLY place the peg is entered from the composer.
async function postPeggedBtcReview(q){
  const { $ } = C;
  const assetHex = q.assetHex;
  const am = C.assetMeta(assetHex);
  let btcSats, assetAtoms;
  try {
    btcSats    = fieldAtoms($('swPayAmt'), 'BTC');
    assetAtoms = fieldAtoms($('swRecvAmt'), assetHex);
    if (btcSats <= 0n || assetAtoms <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both the BTC and the ${am.ticker}.`; return; }
  const haveBtc = balAtoms('BTC');
  if (btcSats > haveBtc){ $('swErr').textContent = `You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`; return; }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = [
    ['Posting', `A resting BID that stays live while you're offline · you post an offer others can take in the ${am.ticker}/BTC market`],
    ['You pay', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['You buy', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it rests', `Your Bitcoin rests as an offer that stays live even while your wallet is closed. When it fills, you receive the ${am.ticker}.`],
    // CONSCIOUS OPT-IN (spec §5): keeping an order working while you are offline needs the peg — surface its
    // custody risk plainly, right here, as the ONE place SBTC appears (nowhere else in the composer).
    ['⚠ Custody risk', 'To keep this order working while you are offline, your Bitcoin is held as pegged Bitcoin by an operator group, which adds custody risk a normal order does not have. Continue?'],
    ['If it cancels', 'Cancel anytime — your funds return to you as regular BTC.'],
    ['Heads up', 'This needs a few Bitcoin confirmations before the bid goes live; you can close the wallet and it resumes.'],
    ['Finality', 'Reverts only if Bitcoin reverts.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Buy with BTC — rest this bid offline', kv });
  if (ok) ok.textContent = 'Rest this bid';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Resting your bid…';
    try {
      await placePeggedBtcCovenant(assetHex, btcSats, assetAtoms, (m) => { st.innerHTML = '<span class="spin"></span>' + esc(m); });
      modal.remove();
      C.toast('Your BTC bid is resting — it stays live even if you close the wallet.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not place: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Review + confirm for filling a resting pegged-BTC covenant bid (taker sells the asset for BTC). On
// confirm we post a crossing order (takePeggedCovenant); the relay matches it, we settle the covenant
// fill on-chain (receiving SBTC), and the SBTC is auto-redeemed to real BTC — all handled by
// onCovMatched. `offer` is the resting covenant we detected in the reverse book.
async function takePeggedCovenantReview(q, offer){
  const { $ } = C;
  // W5 (defense-in-depth): never quote or fill a BTC-advertised covenant that does not actually LOCK
  // SBTC — otherwise the taker pays a real asset and receives a worthless one advertised as BTC. Fail
  // closed even if a caller reached here without the selection-point check.
  if (!peggedCovenantLocksSbtc(offer)){
    $('swErr').textContent = 'This BTC order can’t be filled safely · refusing to fill it (you could pay a real asset and receive nothing of value).';
    return;
  }
  const assetHex = q.seqAsset;
  const am = C.assetMeta(assetHex);
  let assetAtoms, btcSats;
  try {
    assetAtoms = fieldAtoms($('swPayAmt'), assetHex);
    btcSats    = fieldAtoms($('swRecvAmt'), 'BTC');
    if (assetAtoms <= 0n || btcSats <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both the ${am.ticker} and the BTC.`; return; }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = [
    ['Filling', `A resting BTC bid — you sell ${am.ticker} for BTC`],
    ['You pay', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['You receive', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it settles', 'You fill this on-chain and receive Bitcoin.'],
    ['Finality', 'Reverts only if Bitcoin reverts.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: `Sell ${am.ticker} for BTC`, kv });
  if (ok) ok.textContent = 'Fill bid';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Crossing the bid…';
    try {
      await takePeggedCovenant(assetHex, assetAtoms, btcSats, (msg) => { st.innerHTML = '<span class="spin"></span>' + esc(msg); });
      modal.remove();
      C.toast('Order posted to cross the bid; settlement and BTC redemption happen automatically.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not fill: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Settlement-progress callback for a live wallet-made cross offer (drives the
// resting-order panel through lift -> lock -> settled).
function onCrossMakeState(mst){
  if (!XMAKE) return;
  XMAKE.state = mst.state; XMAKE.detail = mst;
  renderXMake();
}

// Render the wallet's live resting cross order + its settlement progress.
function renderXMake(){
  const host = C.$('swMyOrders'); if (!host) return;
  if (!XMAKE){ return; }   // leave same-chain "your orders" render intact when no cross make
  const am = C.assetMeta(XMAKE.assetHex);
  const phases = XMAKE.reverse ? {
    resting:'Resting - waiting to be filled', terms:'Someone is filling your order…', btc_locked:'Waiting for your trade to settle…',
    seq_verified:'Completing your trade…', settled:'Settled - you bought the asset for BTC',
    refunding:'Returning your BTC…', refunded:'Refunded - your BTC is back',
  } : {
    resting:'Resting - waiting to be filled', terms:'Someone is filling your order…', btc_verified:'Completing your trade…',
    seq_locked:'Waiting for your trade to settle…', secret_learned:'Completing your trade…',
    settled:'Settled - you sold the asset for BTC', refunded:'Refunded - your asset is back',
  };
  const label = phases[XMAKE.state] || XMAKE.state;
  const done = XMAKE.state === 'settled' || XMAKE.state === 'refunded';
  if (done){
    // Enriched receipt (P5.1): resting cross order settled/refunded. base = asset, quote = BTC. reverse
    // = the wallet BOUGHT the asset for BTC (a bid); else it SOLD the asset. price only on a real settle.
    const xmAssetU = (() => { try { return Number(big(XMAKE.assetAtoms || 0)) / Math.pow(10, am.precision || 0); } catch { return null; } })();
    const xmBtcU = (() => { try { return Number(big(XMAKE.btcSats || 0)) / 1e8; } catch { return null; } })();
    logTrade({ id: 'xm:' + (XMAKE.offerId || ''),
      title: (XMAKE.reverse ? 'Sold ' : 'Bought ') + (C.assetMeta(XMAKE.assetHex).ticker || 'asset'), status: XMAKE.state,
      rail: 'cross', pair: (am.ticker || 'asset') + '/BTC', side: XMAKE.reverse ? 'buy' : 'sell',
      size: xmAssetU, sizeTicker: am.ticker || null,
      price: (XMAKE.state === 'settled' && xmBtcU != null && xmAssetU > 0) ? xmBtcU / xmAssetU : null });
  }
  const headline = XMAKE.reverse
    ? `Your resting cross bid · buy ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`
    : `Your resting cross offer · sell ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`;
  const resumed = !!XMAKE.resumed;
  const note = resumed
    ? 'Recovering an interrupted swap. It continues in the background; keep this tab open until it settles or refunds.'
    : 'Keep this tab open to settle.';
  const btnLabel = done ? 'Clear' : (resumed ? 'Dismiss' : 'Cancel offer');
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${esc(headline)}</span>
      <span class="sub">${esc(label)}</span></div>
    <div class="swbook-row"><span class="sub">${esc(note)}</span>
      <button type="button" class="ghost" id="swXMakeCancel">${esc(btnLabel)}</button></div></div>`;
  const btn = C.$('swXMakeCancel');
  if (btn) btn.onclick = () => {
    // A resumed swap has no live listener/offer to close — Dismiss only hides the panel; the
    // background settlement/refund watcher (xmaker) keeps running and drops its record when terminal.
    if (!resumed){ try { XMAKE.handle && XMAKE.handle.close(); } catch {} }
    XMAKE = null; host.innerHTML = '';
    C.toast(resumed ? 'Hidden. The swap keeps recovering in the background.' : 'Cross offer removed.');
    renderSwap();
  };
}

// T11: on load, re-launch any interrupted cross-maker settlement/refund watcher that xmaker.js
// persisted (fund-loss safety), and surface the recovering swap in the resting-order panel. The
// watcher runs regardless of the active tab; here we only mirror its progress into the UI.
export function resumeCrossMakers(){
  if (!X || !X.resumeMakers) return;
  const onState = (st) => {
    if (!st) return;
    const reverse = st.direction === 'reverse';
    // Map the persisted maker record onto the panel's shape (there is no live `handle` on resume).
    XMAKE = { resumed: true, handle: null, assetHex: st.asset,
      assetAtoms: big(st.seq_amount || 0), btcSats: big(st.btc_amount || 0),
      reverse, offerId: st.offer_id, session_id: st.session_id, state: st.state, detail: st };
    try { renderXMake(); } catch {}
  };
  Promise.resolve(X.resumeMakers(onState)).then((list) => {
    if (Array.isArray(list) && list.length && C.toast)
      C.toast('Recovering ' + list.length + ' interrupted trade' + (list.length>1?'s':'') + ' - keep this tab open until it settles or refunds.');
  }).catch(() => {});
}

async function reviewSame(q){
  const { $ } = C;
  if (q.startMarket) return postOfferReview(q);   // no resting liquidity -> start the market
  const fm = C.assetMeta(q.feeAsset);
  const kv = [
    ['Network', 'Sequentia (testnet) · a trade on the order book, not a Bitcoin payment'],
    ...(q.confidential ? [['Privacy', 'Blinded book · your trade settles confidentially; amounts and assets are hidden on-chain.']] : []),
    ['You pay', amtRow(q.assetP, q.amountP) + refSuffix(q.assetP, q.amountP)],
    ['You receive', amtRow(q.assetR, q.amountR) + refSuffix(q.assetR, q.amountR)],
    ['Network fee', amtRow(q.feeAsset, q.feeAmount) + '  (estimate)'],
    ['Fee paid in', fm.ticker],
    ['Finality', 'Settles in ~1 block · reverts only if Bitcoin reverts.'],
    ['Settlement', 'Settles in full or not at all.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Opening lift…';
    try {
      const txid = await liftOffer(q, st);
      modal.remove();
      // Receipt into the persistent history so the Active-trades card is a record, not just live
      // status — same-chain taker lifts were the one completed flow that never logged one (W6).
      logTrade({ id: 'lift:' + txid,
        title: 'Swapped ' + C.assetMeta(q.assetP).ticker + ' for ' + C.assetMeta(q.assetR).ticker,
        status: 'settled', txid, rail: 'chain',
        fee: (q.feeAmount != null ? Number(big(q.feeAmount)) / Math.pow(10, C.assetMeta(q.feeAsset).precision || 0) : null),
        feeTicker: q.feeAsset ? C.assetMeta(q.feeAsset).ticker : null,
        ...tradeMeta(q.assetP, q.assetR, q.amountP, q.amountR) });
      C.toast('Swap settled (reverts only if Bitcoin reverts):', {href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…'});
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Cross-chain: hand the priced quote to the right wizard and show its stepper.
async function reviewCross(q){
  const { $ } = C;
  if (!X){ $('swErr').textContent = 'This trade could not be placed right now - try again shortly.'; return; }
  // FUND-SAFETY: one cross swap per direction at a time. An in-flight swap — even one dismissed to the
  // Active-trades tray — holds a locked BTC leg / HTLC persisted under a single localStorage key;
  // starting another would OVERWRITE it and strand those funds (no way left to claim or refund). Require
  // finishing or refunding the current one first. (Concurrent same-rail swaps would need a keyed-per-swap
  // persistence store + independent resume — a separate, carefully-verified change; this guard closes
  // the strand hole safely in the meantime.)
  if (q.reverse ? (X.hasReverseInFlight && X.hasReverseInFlight()) : (X.hasInFlight && X.hasInFlight())){
    $('swErr').textContent = 'You already have a trade in progress. Finish or refund it first (open it under Active trades) before starting another.';
    return;
  }
  // The wizards below speak the cross relay's on-chain HTLC handshake and nothing else. A quote
  // carrying a sub-asset / submarine / pure-LN offer opens a session the maker never answers (or,
  // against the relay that does not hold it, "offer not found or not open") and dead-ends the take.
  // The composer no longer builds one; refuse here too rather than trust that it never will.
  if (q.unified && q.offer && q.offer.rail !== 'onchain'){
    $('swErr').textContent = payerBridgeDisabledNote();
    return;
  }
  // Market order bigger than the best maker's depth: a MARKET order on a cross/BTC pair is IOC (spec
  // §4/§10 closed decision) — fill what the book crosses now (the HTLC wizard / covenant path below)
  // and CANCEL the rest. A market order NEVER rests a remainder; resting is the LIMIT path (post mode →
  // postModeCross). This mirrors the same-chain takeMarketWalk, which fills-then-cancels and says "NOT
  // rested". Post nothing here, leave zero resting state — only tell the user what won't fill.
  const rem = q.remainderSeqAtoms != null ? BigInt(q.remainderSeqAtoms) : 0n;
  if (rem > 0n){
    const sm = C.assetMeta(q.seqAsset);
    C.toast(`Filling ~${C.fmtAtoms(BigInt(q.fillSeqAtoms), sm.precision)} ${sm.ticker} now; the remaining ~${C.fmtAtoms(rem, sm.precision)} ${sm.ticker} can’t fill from the book and was NOT rested — a market order never rests (switch to Limit to rest an order).`);
  }
  if (q.reverse){
    // A pegged-BTC covenant bid (advertised as BTC, locking SBTC) among the reverse offers settles as
    // a COVENANT, not an HTLC — cross it and peg out (spec §5) rather than the xrswap wizard. Detected
    // by the presence of covenant settlement terms on the best takeable reverse offer. On the unified path
    // that is the matched offer's raw payload; on the XBOOK fallback it is the best on-chain reverse offer.
    const best = (q.unified && q.offer && q.offer.raw) || (XBOOK.offers || [])[0];
    if (best && (best.covenant || best.Covenant)){
      // W5: only a covenant that genuinely LOCKS SBTC is a pegged-BTC bid we can fill safely (and
      // auto-redeem to BTC). A BTC-advertised covenant locking any OTHER asset is a mis-sell trap — you
      // would pay a real asset and receive junk. Refuse the row (do not quote/take it).
      if (!peggedCovenantLocksSbtc(best)){
        $('swErr').textContent = 'This resting BTC order can’t be filled safely · it does not lock what it should. Refusing to fill it.';
        return;
      }
      return takePeggedCovenantReview(q, best);
    }
    // Reverse (sell asset for BTC): the xrswap.js wizard takes over (its own review
    // modals, leg verification, fund/claim/poll, and localStorage resume).
    if (!X.openReverseFromComposer){ $('swErr').textContent = 'Selling an asset for BTC is unavailable in this build.'; return; }
    showReverse(true);
    X.openReverseFromComposer(q.xq);   // the FILLABLE portion
    return;
  }
  // Forward (pay BTC, receive asset): the xswap.js wizard takes over.
  if (!X.openFromComposer){ $('swErr').textContent = 'This trade could not be placed right now - try again shortly.'; return; }
  showCross(true);
  X.openFromComposer(q.xq);   // seeds LAST_XQUOTE in xswap.js + renders the lock step (the FILLABLE portion)
}

// --- Instant Lightning (pure-LN) rail -------------------------------------
// A resting LN offer is taken at the LP's fixed terms (§8.6: dynamic per-lift
// pricing is a later refinement), so there is no per-keystroke quote round-trip
// here — we render the rail + the honest (final) finality and enable Review. The
// actual amounts come back in the settle response.

// PARTIAL-FILL pricing for the pure-LN rail — the EXACT mirror of the Go taker
// (seqdex xdriver_pureln.go RunTakerPureLN): the taker names an asset-side slice
// and the quote (BTC / counter-asset) side is derived from the SIGNED offer's
// ratio at msat granularity,
//   msat = offerQuoteMsat * takeMsat / offerAssetMsat
//        = offerQuoteAtoms * takeAtoms * 1000 / offerAssetAtoms   (the *1000s cancel)
// rounded DOWN when the taker GIVES the quote side (BUY pays BTC:
// ProportionalBtcFloor — a partial never overpays the offer's exact ratio) and
// UP when the taker RECEIVES it (SELL: ProportionalBtc — a partial never
// underpays the maker). BigInt throughout: the product overflows 2^53 at
// realistic sizes. quoteAtoms = msat/1000 floored, which is exactly what the
// driver reports settled (FilledBtcMsat/1000) — so the numbers on the review
// sheet are the numbers on the wire. A slice whose quote side prices to 0 atoms
// is DUST: the Go driver refuses 0 msat, and we refuse the (slightly wider)
// 0-atom case client-side BEFORE any POST, because a sheet saying "You pay 0"
// would lie in the other direction. take >= the offer collapses to the whole
// offer (the classic lift, exactly as the Go clamps it).
function plnSliceQuote(side, takeAtoms, offerAssetAtoms, offerQuoteAtoms){
  const take = big(takeAtoms), oa = big(offerAssetAtoms), oq = big(offerQuoteAtoms);
  if (take <= 0n || oa <= 0n || oq <= 0n) return null;
  if (take >= oa) return { whole: true, takeAtoms: oa, quoteAtoms: oq, quoteMsat: oq * 1000n, dust: oq <= 0n };
  const num = oq * take * 1000n;
  const msat = side === 'sell' ? (num + oa - 1n) / oa : num / oa;   // sell RECEIVES the quote -> ceil; buy GIVES it -> floor
  const quoteAtoms = msat / 1000n;
  return { whole: false, takeAtoms: take, quoteAtoms, quoteMsat: msat, dust: quoteAtoms <= 0n };
}

// The EXACT wire body for a pure-LN take — one builder shared by Review's confirm
// so the sheet and the POST can never drift (review == execution). take_atoms
// (the asset-side slice, atoms) rides only when a partial was priced; a
// whole-offer body stays byte-identical to before (the LSP treats absent as
// "lift the whole offer").
function plnSwapBody(q, node_key, counter_node_key){
  return { side: q.side, asset: q.seqAsset, amount: q.amount,
    quote_asset: q.assetAsset ? q.quoteAsset : undefined,   // asset<->asset: the real counter asset (BTC implied otherwise)
    node_key, counter_node_key,
    // PIN the exact offer the user reviewed: the LSP forwards offer_id/maker_pubkey
    // to xpln so it lifts THIS resting offer, not a relay-arbitrary one.
    offer_id: (q.lnOffer && q.lnOffer.offer_id) || undefined,
    maker_pubkey: (q.lnOffer && q.lnOffer.maker_pubkey) || undefined,
    take_atoms: q.takeAtoms != null ? Number(q.takeAtoms) : undefined };
}

async function requoteLn(route, amtStr){
  const { $ } = C;
  // The counter (quote) leg: BTC for asset<->BTC pure-LN, else the REAL quote asset for asset<->asset.
  const qm = route.assetAsset ? C.assetMeta(route.quoteAsset) : { ticker: 'BTC', precision: 8 };
  const qtk = qm.ticker;
  // ONE book: the SAME resting on-chain book shows on the Lightning rail too — no rail distinction in the
  // book UI. For asset<->BTC that's the cross (XBOOK) book; asset<->asset has no BTC leg, so skip it (the
  // same-chain covenant book already rendered when the pair was picked).
  if (!route.assetAsset){ await loadBtcBook(route); deriveXOpposite(route); }
  else {
    // Asset<->asset over pure LN: the pair's ONE ladder (same source + paint as chain/chain —
    // loadSameBook renders the union of the same-chain relay book, the live stream and the LSP
    // unified families, and sets UBOOK for the quote/plan below). Rail selection never changes
    // the ladder's content.
    await loadSameBook(S.payAsset, S.receiveAsset);
  }
  const side = route.payIsBtc ? 'buy' : 'sell';
  const am = C.assetMeta(route.seqAsset);
  const aprec = am.precision || 0;
  $('swRoute').textContent = route.payIsBtc ? `Buy ${am.ticker} with ${qtk}` : `Sell ${am.ticker} for ${qtk}`;
  $('swStatus').textContent = ''; $('swErr').textContent = '';
  renderTiming(route);
  // P2.5: LIMIT on the Lightning rail. A pure-LN offer cannot rest durably while the maker is offline,
  // and this wallet has no online-LN-rest path — so NEVER silently lift the whole offer at the maker's
  // price when the user asked to REST at their own price (the old behavior: the toggle showed Limit but
  // the quote was still a whole-offer market take). Gate honestly + point at the covenant path (an
  // on-chain leg), which DOES rest a durable limit. Invariant: selecting Limit never market-executes.
  if (S.mode === 'post'){
    LAST_QUOTE = null; setReviewEnabled(false);
    paintFee(route.quoteAsset || 'BTC', null, null);
    $('swRate').textContent = `To keep an order resting at your price while your wallet is closed, set both sides on-chain.`;
    return;
  }
  // BTC<->asset: quote from the UNIFIED book like every other rail.
  //
  // This path used to read the pure-LN relay's OWN book (/lnbook) even for a
  // BTC-paired market, which meant an ln/ln user could be shown a different match
  // than a chain/chain user for the SAME pair — the last place a rail quoted from
  // its own book rather than the one book. Pure-LN offers are in the unified book
  // now (the relay is merged and classifyRelayOffer handles ln_direction 2/3), and
  // the reason this could not move earlier is gone: xpln had no partial fill, and
  // now it does.
  //
  // asset<->asset keeps /lnbook below, because the unified book does not cover
  // asset-paired markets at all (it queries <asset>/BTC). That is a real gap and is
  // tracked separately; quoting those from a book that has no such market would be
  // worse than quoting them from the relay that does.
  // BTC<->asset: take the offers from the UNIFIED book, not the pure-LN relay's own.
  //
  // This path used to read /lnbook even for a BTC-paired market, so an ln/ln user
  // could be shown a different match than a chain/chain user for the SAME pair — the
  // last place a rail quoted from its own book rather than the one book. Pure-LN
  // offers are in the unified book now (the relay is merged and classifyRelayOffer
  // handles ln_direction 2/3).
  //
  // ONE BOOK DOES NOT MEAN EVERY OFFER IS TAKEABLE ON EVERY RAIL. Matching is
  // price-first across the whole book; what a given shape can SETTLE is a separate
  // question the settlement router answers. With both of this taker's legs over
  // Lightning and no bridge in the value path, the offers it can settle natively are
  // the pure-LN ones — so the unified book is the source of truth for price and
  // identity, and settleability filters which of its entries this shape may lift.
  // Quoting an offer we cannot settle is the "offer-then-refuse" failure, and
  // quoting from a different book is the inconsistency; this avoids both.
  //
  // asset<->asset keeps /lnbook below: the unified book does not cover asset-paired
  // markets at all (it queries <asset>/BTC). That gap is tracked separately.
  let lnOffers = null;
  if (!route.assetAsset && UBOOK && UBOOK.seqAsset === route.seqAsset){
    const book = { asks: UBOOK.asks || [], bids: UBOOK.bids || [] };
    const settleable = (side === 'buy' ? book.asks : book.bids)
      .filter(o => o && o.rail === 'pureln' && Number(o.assetAtoms) > 0 && Number(o.btcSats) > 0);
    if (settleable.length){
      lnOffers = settleable.map(o => ({
        assetAtoms: String(o.assetAtoms), btcAtoms: String(o.btcSats),
        offer_id: o.id || null, maker_pubkey: o.maker || null,
        minFill: (o.raw && (o.raw.min_fill ?? o.raw.minFill)) || 0,
      }));
    }
  }
  // Price + PIN the chosen offer so Review shows what will move and the settle lifts
  // exactly THAT offer, never a relay-arbitrary one. Preferred source is the unified
  // book above; /lnbook is the fallback for asset<->asset (which the unified book does
  // not cover) and for a BTC pair whose pure-LN liquidity the merge has not picked up.
  let lnOffer = null;
  if (lnOffers && lnOffers.length){
    lnOffer = lnOffers[0];   // already price-ordered by mergeBook (asks ascending, bids descending)
  }
  if (!lnOffer && L && L.lnBook){
    try {
      const lb = await L.lnBook(route.seqAsset, route.quoteAsset);   // quoteAsset undefined for asset<->BTC
      const best = ((side === 'buy' ? lb.buy_offers : lb.sell_offers) || [])[0];
      if (best && Number(best.asset_amount) > 0 && Number(best.btc_sats) > 0)
        lnOffer = { assetAtoms: String(best.asset_amount), btcAtoms: String(best.btc_sats),
          offer_id: best.offer_id || null, maker_pubkey: best.maker_pubkey || null };
    } catch { /* LSP unreachable / older LSP without /lnbook -> treat as no pure-LN liquidity (honest) */ }
  }
  if (!lnOffer){
    LAST_QUOTE = null; setReviewEnabled(false);
    paintFee(route.quoteAsset || 'BTC', null, null);
    // asset<->asset over Lightning KEEPS the same-chain covenant ladder on screen (requote deliberately
    // does not stopLiveBook for this route), so a bare "No offers resting here yet." flatly contradicts the
    // resting orders the user can see and hides the one thing that would fix it. Name the real cause: this
    // pair has no LIGHTNING liquidity, the visible orders rest ON-CHAIN, and both sides on-chain trades them.
    $('swRate').textContent = route.assetAsset
      ? `No Lightning offers for ${am.ticker}/${qtk} yet · the orders shown in the book rest on-chain · set both sides to On-chain to trade them.`
      : `No offers resting here yet.`;
    return;
  }
  // PARTIAL FILL SIZING (the Go slice rail, now threaded end-to-end): the TYPED
  // amount is the take when it is under the offer — takeAtoms = min(typed, offer).
  // Read the typed leg in its OWN atoms (fieldAtoms honours ref-input mode); a
  // quote-side entry converts to asset atoms at the offer's exact ratio, floored,
  // so the slice never takes more than the typed quote amount pays for.
  const offerAtoms = big(lnOffer.assetAtoms), offerQuote = big(lnOffer.btcAtoms);
  const editedEl = S.edited === 'pay' ? $('swPayAmt') : $('swRecvAmt');
  const editedHex = S.edited === 'pay' ? S.payAsset : S.receiveAsset;
  const qHex = route.assetAsset ? route.quoteAsset : 'BTC';
  let typedRaw = 0n, typedAtoms = 0n;
  if (editedHex === route.seqAsset){ typedRaw = typedAtoms = fieldAtoms(editedEl, route.seqAsset); }
  else {
    typedRaw = fieldAtoms(editedEl, qHex);
    if (typedRaw > 0n && offerQuote > 0n) typedAtoms = (typedRaw * offerAtoms) / offerQuote;
  }
  const slice = typedAtoms > 0n ? plnSliceQuote(side, typedAtoms, offerAtoms, offerQuote) : null;
  if ((typedRaw > 0n && typedAtoms <= 0n) || (slice && slice.dust)){
    // DUST: the slice prices to 0 on one side (the Go driver refuses it as
    // "prices to 0 msat"). Refuse HERE, before any POST, with the way out.
    LAST_QUOTE = null; setReviewEnabled(false);
    paintFee(route.quoteAsset || 'BTC', null, null);
    $('swRate').textContent = `That amount is too small to fill from this offer · the ${typedAtoms <= 0n ? am.ticker : qtk} side would round to 0 · enter a larger amount.`;
    return;
  }
  // null takeAtoms = the WHOLE offer (no amount typed, or typed >= the offer —
  // the offer is all there is, exactly the pre-slice behavior).
  const takeAtoms = (slice && !slice.whole) ? slice.takeAtoms : null;
  LAST_QUOTE = { kind: 'ln', side, seqAsset: route.seqAsset, payIsBtc: route.payIsBtc,
    assetAsset: route.assetAsset, quoteAsset: route.quoteAsset,
    amount: amtStr ? parseFloat(amtStr) : null, lnOffer,
    takeAtoms, sliceQuoteAtoms: takeAtoms != null ? slice.quoteAtoms : null };
  paintFee(route.quoteAsset || 'BTC', null, 'You trade at the price shown · the rate already includes the fee.');
  const qprec = qm.precision || 0;
  const assetStr = C.fmtAtoms(offerAtoms, aprec), btcStr = C.fmtAtoms(offerQuote, qprec);
  $('swRate').innerHTML = takeAtoms != null
    ? `${C.fmtAtoms(takeAtoms, aprec)} ${am.ticker} for ${C.fmtAtoms(slice.quoteAtoms, qprec)} ${qtk} · part of the best resting offer (${assetStr} ${am.ticker}) · the remainder stays on the book`
    : `${assetStr} ${am.ticker} for ${btcStr} ${qtk} · best resting offer`;
  setReviewEnabled(true);   // LP fixed terms (proven path) — Review is offerable
}

// Execute the pure-LN swap through the LSP (the device co-signs the hosted node's
// commitment updates over the wss link during the call). Honest finality: pure-LN
// is the one state we may call final.
async function reviewLn(q){
  const { $ } = C;
  if (!L || !L.swap){ $('swErr').textContent = 'The Lightning route is unavailable in this build.'; return; }
  // Defense-in-depth: never proceed on a pure-LN swap without a real usable channel on
  // BOTH legs (findRoute already gates this; this catches a stale quote). Fail CLOSED
  // with a clear message + a route to Move-to-Lightning — never a silent flash.
  let ra = railAvail(S.payAsset, S.receiveAsset);
  // SELF-CUSTODY (Phoenix-style, LSP-supported): this swap runs on the USER's OWN per-asset Lightning
  // nodes (see node_key/counter_node_key at L.swap below), and the device co-signs every commitment over
  // the wss link during the call — the keys never leave the device. So BOTH node signers must be ONLINE
  // first, EVEN when the channels already exist (a per-user node's signer is not auto-connected on load).
  // connectNode is idempotent (re-attaches without re-funding). BTC legs connect via their own provision
  // flow, so this only pre-connects the Sequentia-asset legs.
  if (L.connectNode){
    try {
      if (S.payAsset !== 'BTC')     await L.connectNode(S.payAsset);
      if (S.receiveAsset !== 'BTC') await L.connectNode(S.receiveAsset);
    } catch (e){ $('swErr').textContent = 'Could not bring your Lightning node signer online: ' + (e && e.message || e); return; }
  }
  // === JIT INBOUND FOR THE ASSET RECEIVE LEG ==============================================
  // WHICH OF THE TWO THIS IMPLEMENTS: we PROVISION. Refusal is kept only for the cases where
  // provisioning genuinely does not exist, and then it names the leg, the shortfall and the way out —
  // never "try again shortly". Provisioning is right here because the entry point is already built and
  // proven end-to-end: L.channelInbound() (index.html:3028 -> seqlnChannelInbound, seqln.js:436) ->
  // POST /channel/inbound (lsp-server.mjs) -> provisionInbound(), which has the LP open a 0-conf asset
  // channel TOWARD the user's own node. The sub-asset HODL BUY already calls exactly this before its
  // maker pays (see the L.channelInbound call in the buy flow); the pure-LN take was the one
  // asset-receive path that never did.
  //
  // WHY IT WAS NEVER REQUESTED: the readiness verdict is AMOUNT-BLIND. ln-rail.js legOption() marks a
  // 'recv' leg ok as soon as one active own channel has ANY room at all (`enough = l.receivable > 0n`),
  // so a taker holding a stale or nearly-exhausted asset channel satisfies ra.pureLnOk, the whole
  // `if (!ra.pureLnOk)` block below is skipped, and nothing is provisioned. The maker then registers its
  // hold on H and its pay of the FULL offer size finds the invoice routehint unusable:
  //   "Destination <taker asset node> is not reachable directly and all routehints were unusable."
  // We deliberately do NOT make ln-rail.js amount-aware — it also drives composer copy for every rail —
  // we make the SETTLEMENT decision size-correct here, the one place the pinned offer is known.
  //
  // SIZE FROM WHAT WILL EXECUTE: the priced SLICE when one was quoted (q.takeAtoms
  // rides to the LSP as take_atoms and xpln fills exactly that), else the WHOLE
  // pinned offer (the classic lift) — so the inbound covers the leg that actually
  // moves, never more. provisionInbound is idempotent (already_had_inbound when
  // >= amount is already receivable from the LP), so running it on every take
  // is safe and is a no-op when the room is already there.
  const _offR = q.lnOffer || null;
  const _execAsset = q.takeAtoms != null ? big(q.takeAtoms) : (_offR ? big(_offR.assetAtoms) : 0n);
  const _execQuote = q.takeAtoms != null ? big(q.sliceQuoteAtoms) : (_offR ? big(_offR.btcAtoms) : 0n);
  const _payWant  = _offR ? (q.side === 'buy' ? _execQuote : _execAsset) : 0n;
  const _recvWant = _offR ? (q.side === 'buy' ? _execAsset : _execQuote) : 0n;
  if (S.receiveAsset !== 'BTC'){
    const rm = metaOf(S.receiveAsset);
    const want = _recvWant > 0n ? _recvWant : safeAtoms($('swRecvAmt').value, rm.precision || 0);
    if (want <= 0n){
      $('swErr').textContent = 'This offer no longer has a size to receive · reload the book and take it again.';
      return;
    }
    if (!L.channelInbound || !L.assetNodeKey){
      $('swErr').textContent = `This build cannot request inbound ${rm.ticker} Lightning liquidity, so the maker would have no route to pay you · set your receive leg to on-chain to take this offer.`;
      return;
    }
    try {
      $('swStatus').className = 'status';
      $('swStatus').innerHTML = `<span class="spin"></span>Making room to receive ${C.fmtAtoms(want, rm.precision || 0)} ${rm.ticker} over Lightning…`;
      const recvNodeKey = await L.assetNodeKey(S.receiveAsset);
      await L.channelInbound({ node_key: recvNodeKey, asset: S.receiveAsset, amount: Number(want) });
      $('swStatus').textContent = '';
    } catch (e){
      $('swStatus').textContent = '';
      $('swErr').textContent = `Your ${rm.ticker} Lightning node has no room to receive ${C.fmtAtoms(want, rm.precision || 0)} ${rm.ticker}, and the service could not open it: ${(e && e.message) || e} · take this offer with your receive leg on-chain, or take a smaller offer.`;
      return;
    }
    LNSTATUS = await L.status().catch(() => LNSTATUS);   // the fresh inbound must be visible to railAvail below
    ra = railAvail(S.payAsset, S.receiveAsset);
    // ONE PAYMENT, ONE CHANNEL. channelInbound can report success because the TOTAL receivable across
    // channels now covers the offer, but this leg settles as a single HTLC and nothing here splits it.
    // Without this check the take proceeded and died at the maker with "no direct channel ... with >=
    // N msat spendable", which the user never saw. Seen live: 1.5M atoms receivable across eight GOLD
    // channels, largest 185,640, against a 200,000 offer.
    const rl = ra.recvLn && ra.recvLn.liquidity;
    if (rl && rl.maxReceivable != null && rl.maxReceivable < _recvWant){
      $('swErr').textContent = `This offer pays you ${C.fmtAtoms(_recvWant, rm.precision || 0)} ${rm.ticker} in one Lightning payment, and your largest ${rm.ticker} channel can receive ${C.fmtAtoms(rl.maxReceivable, rm.precision || 0)} · take a smaller offer, or receive ${rm.ticker} on-chain.`;
      return;
    }
  } else if (_recvWant > 0n && ra.recvLn.ok && ra.recvLn.liquidity && (ra.recvLn.liquidity.maxReceivable ?? ra.recvLn.liquidity.receivable) < _recvWant){
    // asset<->BTC SELL: we RECEIVE BTC over Lightning. provisionInbound is asset-only by construction
    // (it funds an asset channel from the LP's asset inventory), so there is nothing to provision on this
    // leg — REFUSE SPECIFICALLY rather than let the maker fail to route into a too-small channel.
    $('swErr').textContent = `Your largest BTC Lightning channel can receive ${C.fmtAtoms(ra.recvLn.liquidity.maxReceivable ?? ra.recvLn.liquidity.receivable, 8)} BTC in one payment and this offer pays you ${C.fmtAtoms(_recvWant, 8)} BTC · receive BTC on-chain instead, or take a smaller offer.`;
    return;
  }
  if (!ra.pureLnOk){
    // No usable channel on one/both legs. Instead of BLOCKING and sending the user to the Balance tab,
    // OPEN the missing channel(s) INLINE on the user's OWN nodes, then continue. Per-leg DIRECTION matters:
    // the PAY leg needs spendable OUTBOUND capacity (provisionChannel funds it from the user's balance);
    // the RECEIVE leg needs INBOUND capacity the user CANNOT self-fund — the LSP FRONTS it toward the
    // user's node (channelInbound). The old code opened OUTBOUND for both, so a channel-less receive leg
    // got capacity it could never receive over. Honest, bounded progress; a clear failure — never a hang.
    if (!L.provisionChannel){ $('swErr').textContent = 'Opening a channel is unavailable in this build · open one from the Balance tab first.'; return; }
    // Size from the EXECUTED legs whenever we have them (_payWant/_recvWant: the priced slice when one
    // was quoted, else the whole pinned offer) — that is what must fit through the channel. The typed
    // field is only a fallback for a quote with no pinned offer.
    const sizeLeg = (hexOrBtc, amtEl, wantAtoms) => {
      const m = metaOf(hexOrBtc);
      const atoms = (wantAtoms && wantAtoms > 0n) ? wantAtoms : safeAtoms(C.$(amtEl).value, m.precision || 0);
      if (atoms <= 0n) throw new Error('Enter an amount so the Lightning channel can be sized.');
      return { m, atoms };
    };
    const provPayOutbound = async (hexOrBtc, amtEl, wantAtoms) => {   // PAY leg: spendable OUTBOUND from the user's balance
      const { m, atoms } = sizeLeg(hexOrBtc, amtEl, wantAtoms);
      const chain = hexOrBtc === 'BTC' ? 'btc' : 'seq';
      await L.provisionChannel({ chain, asset: chain === 'seq' ? hexOrBtc : undefined, ticker: m.ticker,
        amount: Number(atoms), onProgress: (t) => { $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>' + t; } });
    };
    const provRecvInbound = async (hexOrBtc, amtEl, wantAtoms) => {   // RECEIVE leg: the LSP FRONTS inbound to the user's OWN node
      const { m, atoms } = sizeLeg(hexOrBtc, amtEl, wantAtoms);
      if (hexOrBtc === 'BTC' || !L.channelInbound || !L.assetNodeKey){
        // BTC-inbound fronting isn't wired (the LSP fronts asset inbound only). Fall back to the outbound
        // provision so the leg still comes up on the user's node — self-custody holds; the LP just can't
        // pre-fill BTC inbound here (asset<->BTC receive-BTC is the pre-existing limitation).
        await provPayOutbound(hexOrBtc, amtEl); return;
      }
      $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>Fronting inbound ' + m.ticker + ' Lightning liquidity to your node…';
      const nodeKey = await L.assetNodeKey(hexOrBtc);
      await L.channelInbound({ node_key: nodeKey, asset: hexOrBtc, amount: Number(atoms) });
    };
    try {
      $('swErr').textContent = '';
      if (!ra.payLn.ok)  await provPayOutbound(S.payAsset,     'swPayAmt',  _payWant);
      if (!ra.recvLn.ok) await provRecvInbound(S.receiveAsset, 'swRecvAmt', _recvWant);
      LNSTATUS = await L.status();   // refresh so railAvail sees the freshly-opened channel(s)
      $('swStatus').textContent = '';
    } catch (e){
      $('swStatus').textContent = '';
      $('swErr').textContent = 'Could not open your Lightning channel: ' + (e && e.message || e);
      return;
    }
    ra = railAvail(S.payAsset, S.receiveAsset);
    if (!ra.pureLnOk){
      // NEVER a generic "try again shortly": name the leg and quote the exact reason ln-rail.js reports,
      // plus the on-chain way to take this same offer.
      const bad = !ra.payLn.ok ? ra.payLn : ra.recvLn;
      const why = [bad.reason || `${bad.name} Lightning is not ready to trade.`, bad.hint || ''].filter(Boolean).join(' ');
      $('swErr').textContent = `${why} · take this offer with your ${bad.direction === 'pay' ? 'pay' : 'receive'} leg on-chain instead.`;
      return;
    }
  }
  const am = C.assetMeta(q.seqAsset);
  const aprec = am.precision || 0;
  // Counter (quote) leg: BTC for asset<->BTC pure-LN, else the REAL quote asset for asset<->asset.
  const qm = q.assetAsset ? C.assetMeta(q.quoteAsset) : { ticker: 'BTC', precision: 8 };
  const qtk = qm.ticker, qprec = qm.precision || 0;
  const dir = q.side === 'buy' ? `Buy ${am.ticker} with ${qtk}` : `Sell ${am.ticker} for ${qtk}`;
  // The amounts that actually move: the priced SLICE when one was quoted (they now
  // EQUAL execution — take_atoms goes on the wire below and xpln fills exactly
  // that), else the whole offer. Review == execution: these are the numbers the
  // settle response will echo back.
  const off = q.lnOffer || null;
  const assetStr = off ? (C.fmtAtoms(_execAsset, aprec) + ' ' + am.ticker) : null;
  const btcStr = off ? (C.fmtAtoms(_execQuote, qprec) + ' ' + qtk) : null;
  const payStr = off ? (q.side === 'buy' ? btcStr : assetStr) : null;
  const recvStr = off ? (q.side === 'buy' ? assetStr : btcStr) : null;
  const kv = [
    ['Route', 'Instant over Lightning · non-custodial, your keys stay on this device'],
    ['Direction', dir],
  ];
  if (payStr){ kv.push(['You pay', payStr], ['You receive', recvStr]); }
  kv.push(
    ['Pricing', 'Fills against the best resting Lightning offer · any remainder stays on the book · the rate includes the spread (no separate network fee)'],
    ['Finality', L.finalityCopy ? L.finalityCopy() : 'Instant and final · pure Lightning, nothing on-chain to revert.'],
    ['If it stalls', 'Nothing moves · if it stalls, your funds are returned automatically.'],
  );
  // Loud mismatch warning — ONLY for the whole-offer-cap case (q.takeAtoms == null
  // with an amount typed means typed >= the offer: the offer is all there is). A
  // priced slice needs no warning: it EQUALS what the user typed.
  if (off && q.amount > 0 && q.takeAtoms == null){
    const execUnits = q.side === 'buy' ? (Number(big(off.btcAtoms)) / Math.pow(10, qprec)) : (Number(big(off.assetAtoms)) / Math.pow(10, aprec));
    if (execUnits > 0 && Math.abs(execUnits - q.amount) / execUnits > 0.05)
      kv.push(['⚠ Note', `This fills ${q.side === 'buy' ? btcStr : assetStr} (the resting offer's size), which differs from the ${C.fmtAtoms(BigInt(Math.round(q.amount * Math.pow(10, q.side === 'buy' ? qprec : aprec))), q.side === 'buy' ? qprec : aprec)} ${q.side === 'buy' ? qtk : am.ticker} you entered.`]);
  }
  const { m: modal, ok, st } = C.modalRows({ title: 'Review Lightning swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Settling over Lightning…';
    try {
      // SELF-CUSTODY: name the user's OWN per-asset nodes so the LSP drives the swap on THEM (the device
      // co-signs over the wss link), not on the LSP's shared node. node_key = the base <asset> node;
      // counter_node_key = the <quote_asset> node for asset<->asset, or the user's BTC node for asset<->BTC.
      const baseNodeKey = L.assetNodeKey ? await L.assetNodeKey(q.seqAsset) : undefined;
      const counterNodeKey = q.assetAsset
        ? (L.assetNodeKey ? await L.assetNodeKey(q.quoteAsset) : undefined)
        : (L.btcNodeKey ? await L.btcNodeKey() : undefined);
      // ONE builder for the wire body (plnSwapBody): it pins the exact reviewed
      // offer AND carries take_atoms when a slice was priced, so the sheet above
      // and the POST can never drift (review == execution).
      const r = await L.swap(plnSwapBody(q, baseNodeKey, counterNodeKey));
      const bm = C.assetMeta(r.asset || q.seqAsset);
      // Quote ticker for the receipt: the wallet's own asset metadata, never the LSP's echoed label —
      // the LSP may not know a ticker and then echoes the raw hex id, which must never reach the UI.
      const qtkR = qtk || r.quote_asset_label || 'BTC';
      // Format the settled amount into human units (fmtAtoms), never raw atoms: base uses the asset
      // precision (aprec), quote uses the counter-leg precision (qprec = BTC's 8 or the quote asset's).
      const got = (r.direction === 'sold') ? `${C.fmtAtoms(big(r.quote_amount), qprec)} ${qtkR}`
        : `${C.fmtAtoms(big(r.base_amount), aprec)} ${bm.ticker}`;
      modal.remove();
      // Receipt into the persistent history (W6); no on-chain txid on this rail, so key by the
      // payment hash. Drop the raw preimage from the toast — it is protocol jargon, not user info (C-7).
      // Enriched receipt (P5.1): no on-chain txid on this rail, so the payment hash is the id + we keep
      // the preimage the user's own settlement revealed (their proof of the swap). base = the asset leg,
      // quote = BTC (or the counter asset); price = quote per base from the settled leg amounts.
      const lnBaseU  = Number(big(r.base_amount || 0))  / Math.pow(10, aprec || 0);
      const lnQuoteU = Number(big(r.quote_amount || 0)) / Math.pow(10, qprec || 0);
      logTrade({ id: 'ln:' + (r.hash_h || r.preimage || Date.now()),
        title: (r.direction === 'sold' ? 'Sold ' + bm.ticker + ' for ' + qtkR : 'Bought ' + bm.ticker + ' with ' + qtkR) + ' over Lightning',
        status: 'settled', rail: 'ln', preimage: r.preimage || null,
        pair: bm.ticker + '/' + qtkR, side: (r.direction === 'sold') ? 'sell' : 'buy',
        price: lnBaseU > 0 ? lnQuoteU / lnBaseU : null, size: lnBaseU || null, sizeTicker: bm.ticker,
        card: true });   // task 21b: genuine settlement -> settle card
      C.toast(`Lightning swap settled and final: received ${got}.`);
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

function resetComposer(){
  const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
  pa.value = ''; ra.value = ''; pa._userTyped = false; ra._userTyped = false;
  LAST_QUOTE = null; setReviewEnabled(false);
}

function amtRow(hex, atoms){ const m = C.assetMeta(hex); return C.fmtAtoms(atoms, m.precision) + ' ' + m.ticker; }
function refSuffix(hex, atoms){ const r = C.refValueStr(hex, atoms); return r ? ('  ('+r+')') : ''; }
function trim(n){
  if (!isFinite(n)) return '-';
  const r = Math.round(n * 1e8) / 1e8;
  if (r === 0) return '0';
  // Never emit scientific notation: Number.toString() switches to "1e-7" below 1e-6, which reads wrong
  // in the UI and, if written into an amount field, makes parseAtoms() throw. Render fixed to 8dp (BTC
  // precision, the finest we quote) and strip trailing zeros.
  let s = r.toFixed(8);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
// Group the integer part of an already-formatted number string with thousands separators.
function _group(s){ const neg = s[0] === '-'; if (neg) s = s.slice(1); const [i, f] = s.split('.'); const ig = i.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg ? '-' : '') + (f ? ig + '.' + f : ig); }
// Size/amount for DISPLAY: trim()'s precision + thousands separators. NEVER write this into an input.
function fmtGroup(n){ return _group(trim(n)); }
// PRICE for DISPLAY: magnitude-appropriate precision (a ~2350 price doesn't need 8dp) + separators.
function fmtPrice(n){
  if (!isFinite(n)) return '-';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-8) return (n < 0 ? '-' : '') + '<0.00000001';   // nonzero but below 8dp resolution — never show a real price as "0" (e.g. a cheap asset priced in BTC)
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  let s = (Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp)).toFixed(dp);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return _group(s);
}

// ---------------------------------------------------------------------------
// build -> propose -> sign (add_details + strip bip32) -> complete  (UNCHANGED)
// ---------------------------------------------------------------------------
// Lift a resting offer to settlement over the SeqOB courier. The two wasm-bound
// steps are passed as hooks; seqob.js owns the WS + E2E + protobuf transport.
// The taker builds its half (seqdexSwapRequest), the maker co-signs over the
// relay, then the taker signs + self-broadcasts (the proven 6d-1 finalize path)
// and couriers the SwapComplete receipt back.
async function liftOffer(q, onStatusArg){
  const { wasm } = C;
  // Receive TRANSPARENTLY by default (principle #6: transparent-by-default). Only a confidential
  // swap (q.confidential — the opt-in Confidential sub-tab) receives to the blinded blech32 address;
  // everywhere else the received amount is explicit, like the Receive tab and the cross-chain wizards.
  const _raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  // Blinded receive when: the offer is a confidential-book lift (q.confidential), the
  // wallet-wide opt-in is on, OR the Blinded book is active (both legs MUST blind, so a
  // transparent taker output would leak the amount via the swap ratio).
  const receiveAddr = (q.confidential || _confidentialReceive || isConfBook()) ? _raw : (_raw.toUnconfidential ? _raw.toUnconfidential() : _raw);
  const buildRequest = async () => {
    const sreq = C.wollet.seqdexSwapRequest(
      new wasm.AssetId(q.assetP), q.amountP,
      new wasm.AssetId(q.assetR), q.amountR,
      receiveAddr,
      new wasm.AssetId(q.feeAsset), q.feeAmount, q.feeRate,
    );
    return sreq.toJson();
  };
  const finalizeAccept = async (acc) => {
    const pset = new wasm.Pset(acc.transaction);
    pset.addDetails(C.wollet);
    const signed = C.signer.sign(pset);
    const strippedB64 = stripBip32(signed.toString());
    const finalPset = new wasm.Pset(strippedB64);
    const finalized = C.wollet.finalize(finalPset);
    const txid = await C.client.broadcast(finalized);
    try { C.wollet.applyTransaction(finalized); } catch {}   // spend-tracking: the scan is minutes stale
    return { transaction: strippedB64, txid: (txid && txid.toString) ? txid.toString() : String(txid) };
  };
  // onStatus may be a DOM status element (legacy reviewSame call) or a plain callback (the market walk).
  const onStatus = (typeof onStatusArg === 'function')
    ? onStatusArg
    : (msg) => { if (onStatusArg) onStatusArg.innerHTML = '<span class="spin"></span>' + msg; };
  return seqob.lift(q.offer, q.takeBase, q.feeAsset, { buildRequest, finalizeAccept, onStatus });
}

// Start a market: post the user's desired trade as a resting offer (they become
// the maker — give `pay`, want `receive`). Honest about filling: it needs the
// maker online to co-sign, which is a follow-up; the offer rests + is cancellable.
async function postOfferReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive;
  let payAtoms, recvAtoms;
  try {
    payAtoms = fieldAtoms($('swPayAmt'), pay);
    recvAtoms = fieldAtoms($('swRecvAmt'), receive);
    if (payAtoms <= 0n || recvAtoms <= 0n) throw 0;
  } catch { $('swErr').textContent = 'Enter both amounts - what you give and what you want - to start a market.'; return; }
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const kv = [
    ['Posting', 'A resting offer · you post an offer others can take in this market'],
    ...((q.confidential || isConfBook()) ? [['Privacy', 'Blinded book · your offer rests and fills confidentially; amounts and assets are hidden on-chain.']] : []),
    ['You give', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You want', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? ratePerPayToLine(pay, receive, recvU/payU).str : '-'],
    ['Filling', 'Someone can fill it from the other side. This needs your wallet open to complete; for now the offer rests publicly and you can cancel it anytime.'],
    ['Expires', 'In 1 hour (re-post to refresh).'],
    ['Finality', 'Settles in ~1 block · reverts only if Bitcoin reverts.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Start this market', kv });
  if (ok) ok.textContent = 'Post offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const conf = !!q.confidential || isConfBook();
      // Transparent book: publish the transparent recv address (principle #6). Blinded
      // book: publish the BLINDED (blech32) recv address + its blinding pubkey so the
      // counterparty can add a blinded output for this leg — both legs blind on-chain.
      let sameChain;
      if (conf){
        const br = blindedReceive();
        sameChain = { maker_recv_address: br.address, maker_blinding_pub: br.blindingPub };
      } else {
        // Transparent (toUnconfidential) by DEFAULT (principle #6), matching covReceiveAddr.
        const raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
        const t = raw.toUnconfidential ? raw.toUnconfidential() : raw;
        sameChain = { maker_recv_address: t.toString() };
      }
      const now = Math.floor(Date.now()/1000);
      const offer = {
        offer_id: seqob.randHex(16), schema_version: 1,
        pair: { base_asset: pay, quote_asset: receive },
        trade_dir: 1,                       // SELL: maker gives base (= pay)
        base_amount: payAtoms.toString(), offer_amount: payAtoms.toString(), offer_asset: pay,
        want_amount: recvAtoms.toString(), want_asset: receive,
        allow_partial: true,
        created_at_unix: String(now), expires_at_unix: String(now + 3600),
        fee_asset_hint: S.feeAsset || pay,
        confidential: conf,                 // signed book-namespace tag (field 19)
        same_chain: sameChain,
      };
      seqob.signOffer(offer, makerPriv());
      await seqob.postOffer(offer);
      modal.remove();
      C.toast('Offer posted - your market is live in the order book.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not post: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// order-book rendering (resting offers + your own orders)
// ---------------------------------------------------------------------------
function short(s){ s = s || ''; return s.length > 14 ? s.slice(0,8) + '…' + s.slice(-4) : s; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Same-chain SeqOB book, rendered as the shared ladder. Prices are PAY per 1 RECEIVE
// (the conventional quote, matching the mid). ASKS are the offers we can take (give
// pay, get receive) · clickable to lift; BIDS are the opposite side (display-only
// depth, since the taker can't lift them).
// D5: recent-trades feed for the active pair, backed by seqobd's /trades (T1). Resting offers use ONE
// canonical base/quote per market, so exactly one direction has data — query the composer's direction
// first, fall back to the inverse, and display whichever has trades (never merge — the two are
// inverse-priced). Compact: price (quote/base) · size (base) · time-ago. Empty ⇒ no section (honest).
let _tradesPair = null, _tradesReq = 0;
async function renderRecentTrades(){
  const host = C.$('swTrades'); if (!host) return;
  const pay = S.payAsset, recv = S.receiveAsset;
  if (!pay || !recv){ host.innerHTML = ''; return; }
  const req = ++_tradesReq;
  const fetchDir = async (base, quote) => {
    try {
      const r = await fetch(seqob.seqobBase() + '/v1/market/' + encodeURIComponent(base) + '/' + encodeURIComponent(quote) + '/trades?limit=30', { cache: 'no-store' });
      if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.trades) ? j.trades : [];
    } catch { return []; }
  };
  // ONE canonical base/quote per pair ("1 base = N quote") — query that direction, else the inverse and
  // invert its prices, so the feed reads the SAME way as the book + rate line.
  const canon = pairDir(pay, recv);
  let sizeAsset = canon.base, inv = false, trades = await fetchDir(canon.base, canon.quote);
  if (!trades.length){ const alt = await fetchDir(canon.quote, canon.base); if (alt.length){ trades = alt; inv = true; sizeAsset = canon.quote; } }
  if (req !== _tradesReq) return;                 // superseded by a newer pair
  if (!trades.length){ host.innerHTML = ''; return; }
  trades.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const bm = C.assetMeta(canon.base), qm = C.assetMeta(canon.quote), sm = C.assetMeta(sizeAsset);
  const px = (t) => { const p = Number(t.price); return (p > 0 && inv) ? 1 / p : p; };   // quote per canonical base
  const nowS = Math.floor(Date.now() / 1000);
  const ago = (ts) => { const s = Math.max(0, nowS - (ts || 0)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s/60) + 'm' : s < 86400 ? Math.floor(s/3600) + 'h' : Math.floor(s/86400) + 'd'; };
  const row = (t) => '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 10px;font-size:12px">'
    + '<span class="mono">' + trim(px(t)) + '</span>'
    + '<span class="mono sub">' + esc(C.fmtAtoms(big(String(t.size || 0)), sm.precision || 0)) + ' ' + esc(sm.ticker) + '</span>'
    + '<span class="sub" style="min-width:30px;text-align:right">' + ago(t.ts) + '</span></div>';
  host.innerHTML = '<div class="swladder" style="margin-top:8px"><div class="swladder-head">'
    + '<span class="sub" style="color:var(--txt);font-weight:650">Recent trades</span>'
    + '<span class="sub">price ' + esc(bm.ticker) + '/' + esc(qm.ticker) + '</span></div>'
    + trades.slice(0, 30).map(row).join('') + '</div>';
}

// D3: 24h stats + a mini sparkline for the active pair, from seqobd /candles (T1). Same
// one-canonical-direction handling as the trades feed. Sparse on testnet (renders whatever exists);
// richer as trades accumulate. Cleared when no pair / no candle data.
let _statsPair = null, _statsReq = 0;
async function renderPairStats(){
  const host = C.$('swPairStats'); if (!host) return;
  const pay = S.payAsset, recv = S.receiveAsset;
  if (!pay || !recv){ host.innerHTML = ''; return; }
  const req = ++_statsReq;
  const fetchDir = async (base, quote) => {
    try {
      const r = await fetch(seqob.seqobBase() + '/v1/market/' + encodeURIComponent(base) + '/' + encodeURIComponent(quote) + '/candles?interval=3600&limit=48', { cache: 'no-store' });
      if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.candles) ? j.candles : [];
    } catch { return []; }
  };
  const canon = pairDir(pay, recv);
  let sizeAsset = canon.base, inv = false, candles = await fetchDir(canon.base, canon.quote);
  if (!candles.length){ const alt = await fetchDir(canon.quote, canon.base); if (alt.length){ candles = alt; inv = true; sizeAsset = canon.quote; } }
  if (req !== _statsReq) return;
  if (!candles.length){ host.innerHTML = ''; return; }
  // Normalise every candle to the canonical quote-per-base frame; inverting an inverse-direction feed
  // swaps each candle's high and low. vol stays in the candle's own (size) asset.
  const iv = (x) => { const n = Number(x); return (n > 0) ? 1 / n : 0; };
  const cN = candles.map(c => inv
    ? { t: c.t, o: iv(c.o), c: iv(c.c), h: iv(c.l), l: iv(c.h), v: c.v }
    : { t: c.t, o: Number(c.o), c: Number(c.c), h: Number(c.h), l: Number(c.l), v: c.v });
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const win = cN.filter(c => (c.t || 0) >= cutoff);
  const use = win.length ? win : cN.slice(-1);   // nothing in 24h → show the latest as a flat point
  let hi = -Infinity, lo = Infinity, vol = 0n;
  for (const c of use){ if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; vol += big(String(c.v || 0)); }
  const first = use[0], lastc = use[use.length - 1];
  const changePct = (first && first.o > 0) ? ((lastc.c - first.o) / first.o * 100) : 0;
  const bm = C.assetMeta(sizeAsset);
  const pts = use.map(c => c.c).filter(isFinite);
  const up = changePct >= 0, col = up ? '#3ddc84' : 'var(--amber2)';
  let spark = '';
  if (pts.length >= 2){
    const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1, W = 84, H = 20;
    const d = pts.map((p, i) => (i / (pts.length - 1) * W).toFixed(1) + ',' + (H - (p - min) / rng * H).toFixed(1)).join(' ');
    spark = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="vertical-align:middle"><polyline points="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.5"/></svg>';
  }
  const chg = (up ? '+' : '') + changePct.toFixed(2) + '%';
  host.innerHTML = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:4px 2px;font-size:12px" class="sub">'
    + spark
    + '<span>24h <b style="color:' + col + '">' + chg + '</b></span>'
    + (hi > -Infinity ? '<span>H <span class="mono">' + trim(hi) + '</span></span><span>L <span class="mono">' + trim(lo) + '</span></span>' : '')
    + '<span>vol <span class="mono">' + esc(C.fmtAtoms(vol, bm.precision || 0)) + '</span> ' + esc(bm.ticker) + '</span>'
    + '</div>';
}

function renderBook(pay, receive){
  const host = C.$('swBook'); if (!host) return;
  const { base, quote } = pairDir(pay, receive);
  const bm = C.assetMeta(base), qm = C.assetMeta(quote);
  const toU = (a, p) => Number(big(a)) / Math.pow(10, p || 0);
  const MY = (typeof makerPubHex === 'function') ? makerPubHex() : null;   // this wallet's own maker id
  const isMine = (o) => !!(MY && (o.maker_pubkey || o.makerPubkey) === MY);
  // Every offer, mapped into the FIXED base/quote frame: price = quote per base ("1 base = N quote"),
  // size in base units. An offer that GIVES the base is selling base (an ASK); giving quote is a BID.
  // `take` marks the liftable side (only BOOK.offers can be lifted) — it flips with buy/sell, not display.
  const classify = (o, offerAsset, take) => {
    const offerIsBase = (offerAsset === base);
    const baseA  = big(offerIsBase ? (o.offer_amount || o.offerAmount) : (o.want_amount || o.wantAmount));
    const quoteA = big(offerIsBase ? (o.want_amount || o.wantAmount)  : (o.offer_amount || o.offerAmount));
    const baseU = toU(baseA, bm.precision), quoteU = toU(quoteA, qm.precision);
    return { price: baseU > 0 ? quoteU / baseU : 0, size: baseU, sizeAtoms: baseA, isAsk: offerIsBase, take,
             mine: isMine(o) };
  };
  const rows = [
    ...(BOOK.offers || []).map(o => classify(o, receive, true)),     // give receive, want pay — liftable
    ...(BOOK.otherOffers || []).map(o => classify(o, pay, false)),   // give pay, want receive — the other side
  ].filter(r => r.price > 0 && r.size > 0);
  // P2.7: AGGREGATE offers at the same price into ONE level per side (size summed) — two makers at the
  // same price are one row, and the depth column (Sum) is cumulative over LEVELS, not over offers, so a
  // thick level can't crowd out real depth. A level keeps the exact summed atoms for precise click-seed.
  let asks = aggregateLevels(rows.filter(r => r.isAsk));
  let bids = aggregateLevels(rows.filter(r => !r.isAsk));
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  // cumulate from the mid outward over LEVELS; display asks high->low, bids high->low
  asks.sort((a, b) => a.price - b.price);
  { let c = 0; const t = asks.reduce((s, r) => s + r.size, 0) || 1; asks.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  // Stash the FULL aggregated levels (best-first) for the Market-mode price field's sweep estimate.
  LAST_LADDER = { base, quote, asks: asks.slice(), bids: bids.slice() };
  // Show the 8 best LEVELS NEAREST the mid per side: asks is sorted ascending, so slice the 8 LOWEST then
  // reverse for the high->low display (best ask sits right above the mid); bids are already best-first.
  asks = asks.slice(0, 8); asks.reverse(); bids = bids.slice(0, 8);
  // Only the liftable side's LEVELS are clickable — seed the composer with the level's price + its
  // aggregated size (P2.7: click-to-seed preserved, now level-based).
  const wire = (r) => { if (r.take) r.onClick = () => seedFromLevel(r.price, r.sizeAtoms); };
  asks.forEach(wire); bids.forEach(wire);
  LAST_MID = { price: mid, cross: false, base, quote, oneSided: !(bestAsk != null && bestBid != null) };
  renderLadder(host, {
    asks, bids, mid, spread,
    priceLabel: `(${bm.ticker}/${qm.ticker})`, sizeLabel: bm.ticker,
    refMidStr: oneUnitRefStr(base),
    headTitle: 'Order book', headSub: `${(BOOK.offers || []).length} offer${(BOOK.offers || []).length === 1 ? '' : 's'}${liveBookOn() ? ' · live' : ''}`,
    emptyMsg: 'No resting offers - enter an amount and Review to start this market.',
  });
  renderPairBar();
}

// The companion (eltr / BIP86 taproot) wollet's balance — the maker credits this
// wallet has been PAID when its resting covenant orders filled. The primary wpkh
// wallet does not track taproot receives, so this is where a maker SEES its proceeds.
export function covenantCreditBalance(){
  try { return (COMPANION && COMPANION.balance) ? COMPANION.balance().toJSON() : {}; }
  catch { return {}; }
}
export async function scanCovenantCompanion(){ await scanCompanion(); }
// The "credits received" block: proceeds paid into the taproot payout when a resting
// order filled (possibly while the wallet was closed). Sweeping them into the main
// wpkh balance is a follow-up; here the maker at least SEES them (task requirement).
function creditsHtml(){
  const bal = covenantCreditBalance();
  const rows = Object.keys(bal).filter(h => big(bal[h]) > 0n).map(h => {
    const m = C.assetMeta(h);
    return `<div class="swbook-row"><span class="mono">received ${esc(C.fmtAtoms(big(bal[h]), m.precision))} ${esc(m.ticker)}</span>
      <span class="sub">${esc(C.refValueStr(h, big(bal[h])) || '')}</span></div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="swbook"><div class="swbook-head"><span class="lbl">Order credits received</span>
      <span class="sub">paid into a payout only this wallet controls</span></div>${rows}</div>`;
}
// ---------------------------------------------------------------------------
// P5.3 — needs-action notifications
// ---------------------------------------------------------------------------
// Surface the states a user MUST act on — a refund window opening, a fill while the tab is elsewhere, a
// resting order nearing expiry — with an in-app toast AND (when the tab is hidden + permission granted) a
// browser Notification, so a needs-action state is never left silently. Read-only signalling: no funds move.
let _notifyAsked = false;
function ensureNotifyPermission(){
  try {
    if (typeof Notification === 'undefined' || _notifyAsked) return;
    _notifyAsked = true;
    if (Notification.permission === 'default') { const p = Notification.requestPermission(); if (p && p.catch) p.catch(() => {}); }
  } catch {}
}
// Toast, plus a browser Notification when the tab is HIDDEN and permission is granted (a foreground toast
// suffices when the tab is visible). `link` matches C.toast's {href,label} shape.
function notify(text, link, opts){
  try { C.toast && C.toast(text, link); } catch {}
  try {
    if (typeof document !== 'undefined' && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted'){
      const n = new Notification('Sequentia', { body: text, tag: (opts && opts.tag) || undefined });
      n.onclick = () => { try { window.focus(); } catch {} try { n.close(); } catch {} };
    }
  } catch {}
}
// One notification per distinct needs-action TRANSITION (keyed) so a state that stays actionable across
// re-renders nags exactly once (persisted so a reload doesn't re-nag the same still-open window).
let _needActed = null;
function _loadNeedActed(){ if (_needActed) return _needActed; try { _needActed = new Set(JSON.parse(localStorage.getItem('swk.dex.needacted.v1') || '[]')); } catch { _needActed = new Set(); } return _needActed; }
function _notifiedOnce(key, text, link, opts){ const s = _loadNeedActed(); if (s.has(key)) return false; s.add(key); try { localStorage.setItem('swk.dex.needacted.v1', JSON.stringify([...s].slice(-200))); } catch {} notify(text, link, opts); return true; }
// (a) Refund/reclaim windows that have OPENED on an in-flight swap the wallet drives — nag once. A stalled
// submarine / sub-asset swap whose timeout passed needs the user to reclaim; both have clean predicates.
function checkRefundWindows(){
  ensureNotifyPermission();
  try {
    if (MIXED && !sub.isTerminal(MIXED) && sub.isRefundable(MIXED, mixedTip())){
      const am = metaOf(MIXED.asset);
      _notifiedOnce('refund:mx:' + (MIXED.id || MIXED.ts || (MIXED.htlc && MIXED.htlc.refund_locktime) || ''),
        `A ${am.ticker} trade didn’t complete - you can reclaim your funds in Active trades.`, undefined, { tag: 'refund-mx' });
    }
  } catch {}
  try {
    if (SELL && (SELL.state === 'failed' || SELL.error) && SELL.btc_htlc){
      _notifiedOnce('refund:sell:' + (SELL.hash_h || SELL.claim_txid || ''),
        `A sell of ${SELL.ticker || 'an asset'} for BTC needs your attention · reclaim it under Active trades.`, undefined, { tag: 'refund-sell' });
    }
  } catch {}
}
// (c) A resting relay order nearing its bounded TTL — warn once + surface a Re-post action (see
// renderMyOrders). Keyed by offer id + the exact expiry so each TTL window nags exactly once.
const RESTING_EXPIRY_WARN_S = 300;   // 5 min before the relay evicts
function checkRestingExpiry(orders){
  ensureNotifyPermission();
  const now = Math.floor(Date.now() / 1000);
  for (const o of (orders || [])){
    const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0);
    if (!exp) continue;
    const left = exp - now;
    if (left > 0 && left <= RESTING_EXPIRY_WARN_S){
      const give = C.assetMeta(o.offer_asset || o.offerAsset), want = C.assetMeta(o.want_asset || o.wantAsset);
      _notifiedOnce('expiry:' + (o.offer_id || o.offerId || '') + ':' + exp,
        `A resting order (give ${give.ticker} · want ${want.ticker}) expires in ~${Math.max(1, Math.round(left / 60))} min. Re-post it to keep it live.`, undefined, { tag: 'expiry' });
    }
  }
}
// True when a relay order is within the warn window (drives the row badge + Re-post button).
function isNearExpiry(o){ const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); if (!exp) return false; const left = exp - Math.floor(Date.now() / 1000); return left > 0 && left <= RESTING_EXPIRY_WARN_S; }
// Re-post an already-funded covenant order to the relay to refresh its TTL. NO funds move: it re-derives
// the SAME covenant offer (guarded to match the funded spk) and re-sends it, exactly like placeCovenant's
// post step. Refuses if the re-derivation doesn't reproduce the funded output (never posts a mismatch).
async function repostCovenantOrder(rec){
  if (!rec || rec.covTxid == null) throw new Error('this order is not funded on-chain');
  const payout = makerPayout(C.signer, C.network, rec.makerIndex);
  const { rateNum, rateDen } = computeRate(BigInt(rec.sellAtoms), BigInt(rec.recvAtoms));
  const minLot = covenantMinLot(BigInt(rec.sellAtoms));
  const plan = planPlaceOrder({
    // rec.pay/rec.receive are DISPLAY hex; derive with the record's OWN generation byte order
    // (internal for new records, display for legacy pre-fix ones) so the spk guard below matches.
    ...covenantDerivationIds(rec.pay, rec.receive, !!rec.idsInternal),
    sellAtoms: BigInt(rec.sellAtoms),
    rateNum, rateDen, minLot, expiryLocktime: Number(rec.expiry),
    makerProg: payout.program, makerX: payout.internalKey,
  });
  if (rec.spkHex && plan.spkHex !== rec.spkHex) throw new Error('This order could not be re-posted - please try again.');
  const covenant = buildCovenantTerms(plan.order, rec.covTxid, rec.covVout, plan.tap);
  const offer = buildCovenantOffer({
    assetA: rec.pay, assetB: rec.receive, sellAtoms: BigInt(rec.sellAtoms), recvAtoms: BigInt(rec.recvAtoms),
    covenant, makerPubkey: makerPubHex(), recvAddress: payout.address, offerId: rec.offerId,
    allowPartial: true, minLot, advertiseOfferAssetAs: rec.pegged ? rec.advertiseAs : undefined,
  });
  await seqob.postCovenantOffer(offer, makerPriv());
  rec.posted = true; savePlaced();
  ensureCovenantRelay();
}
// E3: notify when a RESTING order fills — including one that filled while the wallet was CLOSED.
// The maker-credit balance is the fill signal (a covenant fill pays a payout only this wallet
// controls). Persist the last-seen balance across sessions; any per-asset INCREASE is a fill, so
// notify the delta. The very first observation just baselines (no toast). Cheap + idempotent, so it's
// safe to call on every renderMyOrders (live fills via onCovOrderStatus, and on reopen via resume).
// P5.3: routed through notify() so a fill while the tab is ELSEWHERE also raises a browser Notification.
let _seenCredits = undefined;
function notifyNewCredits(){
  let bal; try { bal = covenantCreditBalance(); } catch { return; }
  const cur = {}; for (const h of Object.keys(bal || {})){ const v = big(bal[h]); if (v > 0n) cur[h] = v.toString(); }
  if (_seenCredits === undefined){ try { _seenCredits = JSON.parse(localStorage.getItem('swk.seenCredits.v1') || 'null'); } catch { _seenCredits = null; } }
  if (_seenCredits == null){ _seenCredits = cur; try { localStorage.setItem('swk.seenCredits.v1', JSON.stringify(cur)); } catch {} return; }
  for (const h of Object.keys(cur)){
    const now = big(cur[h]), was = big(_seenCredits[h] || '0');
    if (now > was){
      const m = C.assetMeta(h);
      try { notify(`Your resting order filled · received ${C.fmtAtoms(now - was, m.precision)} ${m.ticker}.`, undefined, { tag: 'fill' }); } catch {}
    }
  }
  _seenCredits = cur; try { localStorage.setItem('swk.seenCredits.v1', JSON.stringify(cur)); } catch {}
}

// P5.1 — "Your trades" history view. Collapsed to the latest few; expandable to the full durable log.
let _histExpanded = false;
// Plain, user-facing settlement label for a trade record — the user never sees the internal rail
// name (submarine/sub-asset/bridged/cross). Every value maps to one of three plain phrases; an
// unknown value falls back to the safe generic rather than leaking a raw rail token.
const _RAIL_LABEL = { chain: 'On-chain', ln: 'Lightning', cross: 'On-chain', submarine: 'Lightning + on-chain', 'sub-asset': 'Lightning + on-chain', bridged: 'Lightning + on-chain' };
function railLabel(r){ return (r && _RAIL_LABEL[r]) || 'On-chain'; }
// One history row: the structured pair/side/price/size line when the receipt carries it, else the
// legacy title. Escapes every field (receipts hold user/relay strings). No secrets beyond the user's own.
function fmtHistRow(e){
  const when = e.at ? new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let main;
  if (e.pair){
    const side = e.side ? `<b class="${e.side === 'buy' ? 'hist-buy' : 'hist-sell'}">${esc(e.side.toUpperCase())}</b> ` : '';
    const px = (e.price != null && isFinite(e.price)) ? ` @ ${esc(trim(e.price))}` : '';
    const sz = (e.size != null) ? ` · ${esc(trim(Number(e.size)))}${e.sizeTicker ? ' ' + esc(e.sizeTicker) : ''}` : '';
    const rail = e.rail ? ` · ${esc(railLabel(e.rail))}` : '';
    main = `${side}${esc(e.pair)}${px}${sz}${rail} · ${esc(e.status || '')}`;
  } else {
    main = `${esc(e.title || '')} · ${esc(e.status || '')}`;
  }
  const ref = e.txid ? `<span class="sub mono" title="${esc(String(e.txid))}">${esc(String(e.txid).slice(0, 12))}…</span>`
    : (e.preimage ? `<span class="sub">Lightning</span>` : '');
  return `<div class="swbook-row myorder"><span class="mono">${main}</span>`
    + `<span class="sub" style="min-width:90px;text-align:right">${esc(when)}</span>${ref}</div>`;
}
// The unified "Active trades" card: every in-flight swap (submarine, sub-asset sell, cross-chain),
// so a DISMISSED one is never lost — each row reopens its process view (clearing the dismiss). A
// trade that may need an on-chain action (refundable / claiming) is flagged so leaving it is a
// deliberate, informed choice. Rendered in the composer (above your resting orders).
function renderInFlightCard(){
  const host = C.$('swInFlight'); if (!host) return;
  // Live elapsed (task 21a): the card re-renders on every record save; this slow tick keeps
  // the "· Ns elapsed" figures honest between transitions. One timer, page-lifetime.
  if (!_narrTick && typeof setInterval === 'function'){
    _narrTick = setInterval(() => { try { renderInFlightCard(); } catch {} }, 30000);
    if (_narrTick && _narrTick.unref) _narrTick.unref();   // node (headless tests): never hold the process open
  }
  try { checkRefundWindows(); } catch {}   // P5.3 — nag once when a refund/reclaim window opens
  try { reapStalledCrossings(); } catch {}   // a wedged record self-heals when you come back to look
  try { reconcileJobStatus(); } catch {}     // ...and so does one the LSP has already failed
  const rows = [];
  if (hasMixedInFlight()){
    const am = metaOf(MIXED.asset);
    const need = sub.isRefundable(MIXED, mixedTip());
    rows.push({ view: 'mixed', need,
      title: (MIXED.side === 'buy' ? 'Buy ' : 'Sell ') + esc(am.ticker),
      status: (need ? 'refundable now' : String(MIXED.state)) + stageNarrative(MIXED) });
  }
  // Gate on the OBJECT, not just the predicate: hasSell/BuyInFlight() also returns true off the
  // synchronous _sellStarting/_buyStarting sentinel DURING the pre-fund prologue, before SELL/BUY is
  // assigned — a bare predicate check here would deref null. The prologue has nothing to show in this
  // card anyway (the progress modal covers it); the row appears once the record exists.
  // Show the sell row while it is genuinely in flight, AND when it has stopped with an error — a
  // terminal 'failed' (the maker reclaimed the BTC) or a transient claim error. Without this a stuck
  // sell either silently wedged the rail (old bug: 'claiming' forever, no message) or, once terminal,
  // vanished with no explanation. A failed sell offers Clear (safe: the HTLC is resolved on-chain); a
  // transient one offers Retry.
  // ONE ROW PER SELL (live, errored, or terminally failed) — per-trade records, same shape
  // as the buys below. A failed sell offers Clear (safe: its HTLC is resolved on-chain); a
  // transient error offers Retry. A stuck one never blocks new sells any more.
  for (const sr of SELLS){
    if (!sr) continue;
    if (sellTerminal(sr) && sr.state !== 'failed' && !sr.error) continue;
    const failed = sr.state === 'failed';
    const qtk = sr.quote_asset ? ((C.assetMeta(sr.quote_asset) || {}).ticker || 'quote') : 'BTC';
    const status = failed
      ? (sr.error || 'This sell could not be completed.')
      : (sr.error ? (sr.error + ' · will retry') : 'claiming your ' + qtk + ' on-chain (automatic)');
    // Clear is offered whenever forgetting the record cannot strand funds: a terminal
    // 'failed', OR a 'paying' record with NO preimage — nothing claimable exists yet,
    // and its idempotent nonce means a re-place can never double-pay. Without this, a
    // definitively-unsettled sell occupied a concurrency slot for the whole 24h TTL
    // with no off-ramp (mirrors subswapClearable's nothing-committed rule).
    const clearable = failed || (sr.state === 'paying' && !sr.preimage);
    rows.push({ view: null, need: !failed, id: sr.id, title: 'Sell ' + esc(sr.ticker) + ' for ' + esc(qtk),
      status: status + (failed ? '' : stageNarrative(sr)),
      action: clearable ? 'clear-sell' : (sr.error ? 'retry-sell' : null) });
  }
  // ONE ROW PER LIVE BUY. This rendered a single row from a single global, so a second concurrent buy
  // was invisible here — and an invisible trade with Bitcoin locked in it is exactly what this card
  // exists to prevent.
  for (const b of activeBuys()){
    rows.push({ view: null, need: true, title: 'Buy ' + esc(b.ticker || 'asset') + ' with BTC',
      status: (b.state === 'holding' ? 'ready · confirm from your wallet to receive' : 'paid with Bitcoin · receiving the asset over Lightning')
        + stageNarrative(b) });
  }
  // RAIL-CROSSING records (SUBSWAP: peer-to-peer submarine + the LSP payer bridge;
  // BRIDGE: the LSP receiver bridge). These were MISSING from this card, which is
  // the bug behind "nothing appeared to have happened": they are the ONLY two
  // record types that block a new trade (hasSubswapInFlight / hasBridgeInFlight),
  // they have no process view of their own, and with no row here they ran — or
  // stalled — completely invisibly. A user could then neither see the trade nor
  // start another, and the error pointed them at a card that never showed it.
  //
  // A stalled one offers Clear. That is safe by construction on these rails: every
  // leg is refundable at its own timelock, and clearing only forgets the wallet's
  // local record. It is offered ONLY while nothing of the user's is committed and
  // unrecoverable — see subswapClearable — so the button can never strand funds.
  if (WALK && !walkTerminal()){
    const am = metaOf(WALK.asset);
    rows.push({ view: null, need: true,
      title: (WALK.side === 'buy' ? 'Buy ' : 'Sell ') + esc(am.ticker || 'asset') + ' across several offers',
      status: walkStatusLine(WALK) });
  }
  if (WALK && WALK.state === 'stopped'){
    rows.push({ view: null, need: false,
      title: (WALK.side === 'buy' ? 'Buy ' : 'Sell ') + esc(metaOf(WALK.asset).ticker || 'asset'),
      status: walkStatusLine(WALK), action: 'clear-walk' });
  }
  for (const S1 of SUBSWAPS){
    if (!S1 || (subswapTerminal(S1) && S1.state !== 'failed')) continue;
    const am = metaOf(S1.asset);
    const buying = S1.kind === 'p2p-buy' || S1.kind === 'lsp-payer-buy';
    rows.push({ id: S1.id, view: null, need: S1.state !== 'failed',
      title: (buying ? 'Buy ' : 'Sell ') + esc(am.ticker || 'asset') + (buying ? ' with Bitcoin' : ' for Bitcoin'),
      status: (S1.detail || subswapStatusLine(S1)) + (S1.state === 'failed' ? '' : stageNarrative(S1)),
      action: subswapClearable(S1) ? 'clear-subswap' : null });
  }
  if (BRIDGE && (hasBridgeInFlight() || BRIDGE.state === 'failed')){
    const am = metaOf(BRIDGE.asset);
    rows.push({ view: null, need: BRIDGE.state !== 'failed',
      title: (BRIDGE.side === 'buy' ? 'Buy ' : 'Sell ') + esc(am.ticker || 'asset'),
      status: (BRIDGE.detail || ('' + (BRIDGE.state || 'in progress')))
        + (BRIDGE.state === 'failed' ? '' : stageNarrative(BRIDGE)),
      action: bridgeClearable(BRIDGE) ? 'clear-bridge' : null });
  }
  if (X && X.hasInFlight && X.hasInFlight()){
    rows.push({ view: 'cross', need: true, title: 'Buy asset with BTC', status: 'in progress' });
  }
  if (X && X.hasReverseInFlight && X.hasReverseInFlight()){
    rows.push({ view: 'reverse', need: true, title: 'Sell asset for BTC', status: 'in progress' });
  }
  // Parked refund-only cross records: the trade slot is free, but the user should still see the
  // pending refund (it broadcasts itself at maturity; nothing to click, nothing blocked).
  if (X && X.listParked){
    for (const p of X.listParked()){
      if (!p || !p.btc_leg) continue;
      rows.push({ view: null, need: false, title: 'Buy asset with BTC · parked',
        status: p.btc_refund_txid ? 'BTC refunded' : ('BTC refunds itself at block ' + p.btc_locktime) });
    }
  }
  const hist = loadHist();
  if (!rows.length && !hist.length){ host.innerHTML = ''; return; }
  let html = '';
  if (rows.length){
    html += `<div class="swbook"><div class="swbook-head">
        <span class="lbl">Active trades</span><span class="sub">running in the background · reopen anytime</span></div>`
      + rows.map(r => `<div class="swbook-row${r.need ? ' needsact' : ''}">
          <span class="mono">${r.title} · ${esc(r.status)}${r.need ? ' <b class="actneed">action may be needed</b>' : ''}</span>
          ${r.view ? `<button type="button" class="ghost swviewtrade" data-view="${r.view}">View</button>`
            : r.action === 'clear-sell' ? `<button type="button" class="ghost swclearsell" data-id="${esc(r.id || '')}">Clear</button>`
            : r.action === 'retry-sell' ? `<button type="button" class="ghost swretrysell" data-id="${esc(r.id || '')}">Retry</button>`
            : r.action === 'clear-walk' ? `<button type="button" class="ghost swclearwalk" title="Dismiss this finished walk. The part that filled is already yours.">Clear</button>`
            : r.action === 'clear-subswap' ? `<button type="button" class="ghost swclearsub" data-id="${esc(r.id || '')}" title="Forget this stalled trade so you can start another. Nothing of yours is committed.">Clear</button>`
            : r.action === 'clear-bridge' ? `<button type="button" class="ghost swclearbridge" title="Forget this stalled trade so you can start another. Nothing of yours is committed.">Clear</button>`
            : '<span class="sub">automatic</span>'}
        </div>`).join('')
      + `</div>`;
  }
  if (hist.length){
    const shown = _histExpanded ? hist : hist.slice(0, 6);
    const more = hist.length - shown.length;
    html += `<div class="swbook"><div class="swbook-head">
        <span class="lbl">Your trades</span>
        <span class="sub" style="display:flex;gap:8px;align-items:center;margin-left:auto">
          <span>${hist.length} trade${hist.length === 1 ? '' : 's'}</span>
          <button type="button" class="ghost swexport" data-fmt="csv" title="Download your trade history as CSV">Export CSV</button>
          <button type="button" class="ghost swexport" data-fmt="json" title="Download your trade history as JSON">JSON</button>
        </span></div>`
      + shown.map(fmtHistRow).join('')
      + (more > 0 ? `<div class="swbook-row"><button type="button" class="ghost swhistmore" style="width:100%">Show ${more} more</button></div>`
                  : (_histExpanded && hist.length > 6 ? `<div class="swbook-row"><button type="button" class="ghost swhistless" style="width:100%">Show fewer</button></div>` : ''))
      + `</div>`;
  }
  host.innerHTML = html;
  // P5.1 — export + expand controls for the trade history.
  host.querySelectorAll('.swexport').forEach(b => b.onclick = () => exportTrades(b.dataset.fmt));
  host.querySelectorAll('.swhistmore').forEach(b => b.onclick = () => { _histExpanded = true; renderInFlightCard(); });
  host.querySelectorAll('.swhistless').forEach(b => b.onclick = () => { _histExpanded = false; renderInFlightCard(); });
  // Clear a terminally-failed sub-asset sell: its BTC HTLC is already resolved on-chain, so removing
  // the record loses no funds and unblocks the sell rail. Retry re-drives resumeSell for a transient one.
  host.querySelectorAll('.swclearsell').forEach(b => b.onclick = () => {
    const rec = SELLS.find((r) => r && r.id === b.dataset.id) || null;
    clearSell(rec); try { renderInFlightCard(); } catch {} try { updateRails(); } catch {}
  });
  host.querySelectorAll('.swclearwalk').forEach(b => b.onclick = () => {
    clearWalk(); try { renderInFlightCard(); } catch {}
  });
  host.querySelectorAll('.swclearsub').forEach(b => b.onclick = () => {
    // Clear THIS trade. With several in flight, a button that dropped "the" record
    // would silently discard whichever one happened to be first.
    clearSubswap(subswapById(b.dataset.id) || null);
    try { renderInFlightCard(); } catch {} try { updateRails(); } catch {}
    try { setReviewEnabled(false); requote().catch(()=>{}); } catch {}
  });
  host.querySelectorAll('.swclearbridge').forEach(b => b.onclick = () => {
    clearBridge(); try { renderInFlightCard(); } catch {} try { updateRails(); } catch {}
    try { setReviewEnabled(false); requote().catch(()=>{}); } catch {}
  });
  host.querySelectorAll('.swretrysell').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Retrying…';
    const rec = SELLS.find((r) => r && r.id === b.dataset.id) || null;
    try { if (rec){ rec.error = null; saveSells(); await resumeOneSell(rec); } } catch {}
    try { renderInFlightCard(); } catch {}
  });
  host.querySelectorAll('.swviewtrade').forEach(b => b.onclick = () => {
    const v = b.dataset.view; _dismissed.delete(v);
    if (v === 'mixed'){ showMixed(true); renderMixedSwap(); }
    else if (v === 'cross'){ showCross(true); if (X && X.renderXswap) X.renderXswap(); }
    else if (v === 'reverse'){ showReverse(true); if (X && X.renderReverse) X.renderReverse(); }
  });
}

async function renderMyOrders(){
  const host = C.$('swMyOrders'); if (!host) return;
  if (XMAKE) return renderXMake();   // a live wallet cross offer owns this panel

  const credits = creditsHtml();     // maker proceeds from filled resting orders
  notifyNewCredits();                // E3: toast any newly-filled resting order (incl. filled-while-away)

  let orders = [];
  // On a fetch error, leave whatever is already rendered rather than blanking the panel (a transient
  // relay blip should not make your resting orders vanish from the UI).
  try { orders = await seqob.fetchMyOrders(makerPubHex()); } catch { if (credits) host.innerHTML = credits; return; }
  // D2/T13: prune fill-progress for orders no longer resting, so a stale entry can't paint a wrong
  // "~N% filled" if the relay ever re-uses an offer_id.
  const relayIds = new Set(orders.map(o => o.offer_id || o.offerId));
  { for (const k of Object.keys(_ordStatus)) if (!relayIds.has(k)) delete _ordStatus[k]; }
  try { checkRestingExpiry(orders); } catch {}   // P5.3 — nag once when a resting order nears its TTL
  // LOCAL reclaim rows: covenant orders THIS wallet funded on-chain that the relay no longer
  // lists (its offer TTL is far shorter than the ~24h on-chain lock) but whose locked asset is
  // still reclaimable via the CLTV refund. Without these the reclaim UI vanished with the relay
  // listing and the funds became unreachable through the wallet.
  const localReclaim = PLACED.filter(r => r.covTxid != null && !relayIds.has(r.offerId) && !r._orphan);
  const localRows = localReclaim.map(r => {
    const give = C.assetMeta(r.pay);
    return `<div class="swbook-row myorder">
      <span class="mono">give ${esc(C.fmtAtoms(BigInt(r.sellAtoms), give.precision))} ${esc(give.ticker)} · funded on-chain (delisted from the relay)</span>
      <button type="button" class="ghost swcancel" data-id="${esc(r.offerId)}">Reclaim</button></div>`;
  }).join('');
  if (!orders.length && !localRows){ host.innerHTML = credits; return; }
  const rows = orders.map(o => {
    const give = C.assetMeta(o.offer_asset||o.offerAsset), want = C.assetMeta(o.want_asset||o.wantAsset);
    const isCov = !!(o.covenant || o.Covenant);
    // D2/T13: per-order fill progress. active_amount (remaining base atoms) < base_amount ⇒ partially
    // filled; show ~N% done. Only when we've seen an order_status for it (live, this session).
    const id = o.offer_id||o.offerId;
    const base = big(o.base_amount||o.baseAmount||0);
    const stat = _ordStatus[id];
    let fillHint = '';
    if (stat && base > 0n && stat.active >= 0n && stat.active < base){
      const pct = Number((base - stat.active) * 100n / base);
      fillHint = pct >= 100 ? ' · <span style="color:#3ddc84">filled</span>' : ` · <span style="color:#3ddc84">~${pct}% filled</span>`;
    }
    // P5.3 — a resting order within its TTL warn window: flag it + offer a Re-post (refresh the relay
    // listing) for a covenant order this wallet funded (repost re-sends the SAME signed offer, no funds move).
    const near = isNearExpiry(o);
    const hasRec = PLACED.some(r => r.offerId === id && r.covTxid != null);
    const expBadge = near ? ' · <b class="actneed">expiring soon</b>' : '';
    const repostBtn = (near && hasRec) ? `<button type="button" class="ghost swrepost" data-id="${esc(id)}">Re-post</button>` : '';
    return `<div class="swbook-row myorder${near ? ' needsact' : ''}">
      <span class="mono">give ${esc(C.fmtAtoms(big(o.offer_amount||o.offerAmount), give.precision))} ${esc(give.ticker)} · want ${esc(C.fmtAtoms(big(o.want_amount||o.wantAmount), want.precision))} ${esc(want.ticker)}${isCov ? ' · resting on-chain' : ''}${fillHint}${expBadge}</span>
      <span>${repostBtn}<button type="button" class="ghost swcancel" data-id="${esc(id)}">Cancel</button></span></div>`;
  }).join('');
  host.innerHTML = credits + `<div class="swbook"><div class="swbook-head"><span class="lbl">Your resting orders</span>
      <span class="sub">funded on-chain · fill whenever matched, even offline</span></div>${rows}${localRows}</div>`;
  // P5.3 — Re-post a near-expiry covenant order to refresh its relay TTL (no funds move; re-sends the offer).
  host.querySelectorAll('.swrepost').forEach(b => b.onclick = async () => {
    b.disabled = true; const label = b.textContent; b.textContent = 'Re-posting…';
    const rec = PLACED.find(r => r.offerId === b.dataset.id && r.covTxid != null);
    try {
      if (!rec) throw new Error('no funded record for this order');
      await repostCovenantOrder(rec);
      try { C.toast && C.toast('Order re-posted · its listing is live again.'); } catch {}
      try { renderMyOrders(); } catch {}
    } catch (e){ b.disabled = false; b.textContent = label; try { C.toast && C.toast('Re-post failed: ' + C.prettyErr(e)); } catch {} }
  });
  host.querySelectorAll('.swcancel').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Cancelling…';
    const id = b.dataset.id;
    const rec = PLACED.find(r => (r.offerId === id));
    try {
      // A funded covenant's locked asset is reclaimable on-chain only via the CLTV
      // REFUND leaf: once expired (tip >= expiry) broadcast the reclaim; before that
      // delist + tell the maker when the funds become reclaimable. A non-covenant
      // (no local funded record) just delists on the relay.
      if (rec && rec.covTxid != null){
        const { order } = orderFromPlaced(rec);
        const payout = makerPayout(C.signer, C.network, rec.makerIndex);
        const recipe = covPlanRefund(order, { txid: rec.covTxid, vout: rec.covVout, locked: BigInt(rec.sellAtoms) });
        // planRefund copies order.assetA into covenantAsset — INTERNAL byte order for a new
        // (idsInternal) record. The refund host seam (wasm AssetId::from_str + fee-vs-covenant
        // asset comparison) speaks DISPLAY hex, and rec.pay is display in BOTH generations, so
        // hand it the display id explicitly. (Legacy records: order.assetA == rec.pay, a no-op.)
        recipe.covenantAsset = rec.pay;
        recipe.makerKeyPath = payout.path;   // m/86'/coin'/0'/0/index — the leaf's key
        const tipHeight = C.wollet.tip().height();
        const out = await covCancel(id, { recipe, tipHeight, expiryLocktime: Number(rec.expiry) },
          { relayCancel: async (offerId) => seqob.signAndCancel(offerId, makerPriv()), ...refundHooksFor() });
        if (out.refundTxid){
          C.toast('Order cancelled · reclaimed on-chain (' + String(out.refundTxid).slice(0,12) + '…).');
          // SBTC silent peg: the reclaimed asset is SBTC, but the maker paid BTC and expects BTC back.
          // Redeem it (best-effort; on failure the user simply holds redeemable SBTC — fund-safe).
          if (rec.pegged){ try { await C.sync(); await pegOutReceivedSbtc(BigInt(rec.sellAtoms)); } catch { recordPendingPegOut(BigInt(rec.sellAtoms)); } }
        } else if (out.reclaimable){
          const meta = C.assetMeta(rec.pay);
          C.toast('Order delisted. The locked ' + esc(meta.ticker) + ' is reclaimable on-chain after block ' + out.reclaimable.afterHeight + '.');
        }
      } else {
        await seqob.signAndCancel(id, makerPriv());
      }
      // Drop the local record only once the funds are back (or there were none to
      // reclaim); keep it while still-locked so a later Cancel can reclaim at expiry.
      const stillLocked = rec && rec.covTxid != null && C.wollet.tip().height() < Number(rec.expiry);
      if (!stillLocked){
        const before = PLACED.length;
        PLACED = PLACED.filter(r => r.offerId !== id);
        if (PLACED.length !== before){ savePlaced(); ensureCovenantRelay(); }
      }
      renderSwap();
    }
    catch (e){ b.disabled = false; b.textContent = 'Cancel'; C.toast('Cancel failed: ' + C.prettyErr(e)); }
  });
}

// ---------------------------------------------------------------------------
// PSET bip32 / global-xpub stripper.  (UNCHANGED - verified byte-exact.)
// ---------------------------------------------------------------------------
function b64ToBytes(b64){
  const bin = atob(b64.trim()); const a = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64(a){
  let s=''; for (let i=0;i<a.length;i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function stripBip32(b64){
  const b = b64ToBytes(b64);
  const magic = [0x70,0x73,0x65,0x74,0xff];
  for (let i=0;i<5;i++) if (b[i]!==magic[i]) throw new Error('not a PSET');
  let i = 5;
  const out = [0x70,0x73,0x65,0x74,0xff];
  const rdVarint = () => {
    const x = b[i++];
    if (x < 0xfd) return x;
    if (x === 0xfd){ const v = b[i] | (b[i+1]<<8); i+=2; return v; }
    if (x === 0xfe){ const v = (b[i] | (b[i+1]<<8) | (b[i+2]<<16) | (b[i+3]<<24))>>>0; i+=4; return v; }
    let v = 0; for (let k=0;k<8;k++) v += b[i+k] * Math.pow(2, 8*k); i+=8; return v;
  };
  const emitVarint = (v) => {
    if (v < 0xfd) out.push(v);
    else if (v <= 0xffff){ out.push(0xfd, v & 0xff, (v>>8)&0xff); }
    else if (v <= 0xffffffff){ out.push(0xfe, v&0xff, (v>>8)&0xff, (v>>16)&0xff, (v>>>24)&0xff); }
    else { out.push(0xff); for (let k=0;k<8;k++){ out.push(Math.floor(v/Math.pow(2,8*k))&0xff); } }
  };
  const copyMap = (dropTypes) => {
    while (true){
      const klen = rdVarint();
      if (klen === 0){ out.push(0x00); break; }
      const keyStart = i; const keyType = b[i];
      i += klen;
      const vlen = rdVarint();
      const valStart = i; i += vlen;
      if (dropTypes.has(keyType)) continue;
      emitVarint(klen); for (let k=keyStart;k<keyStart+klen;k++) out.push(b[k]);
      emitVarint(vlen); for (let k=valStart;k<valStart+vlen;k++) out.push(b[k]);
    }
  };
  let inCount = 0, outCount = 0;
  { let j = 5;
    const pv = () => { const x = b[j++];
      if (x<0xfd) return x;
      if (x===0xfd){ const v=b[j]|(b[j+1]<<8); j+=2; return v; }
      if (x===0xfe){ const v=(b[j]|(b[j+1]<<8)|(b[j+2]<<16)|(b[j+3]<<24))>>>0; j+=4; return v; }
      let v=0; for (let k=0;k<8;k++) v+=b[j+k]*Math.pow(2,8*k); j+=8; return v; };
    while (true){
      const kl = pv(); if (kl===0) break;
      const kt = b[j]; j += kl;
      const vl = pv(); const vs = j; j += vl;
      if (kt === 0x04){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); inCount = v; }
      if (kt === 0x05){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); outCount = v; }
    }
  }
  copyMap(new Set([0x01]));
  for (let n=0;n<inCount;n++) copyMap(new Set([0x06]));
  for (let n=0;n<outCount;n++) copyMap(new Set([0x02]));
  return bytesToB64(Uint8Array.from(out));
}

// Test-only exports: drive the REAL same-chain pipeline + the composer mapping
// from a headless harness, no DOM. Adds composerRoute for the reframe's mapping.
export const __test__ = { stripBip32, dexPost, feeAssetPolicy, feeAssetOptions, acceptedFee, defaultFeeAsset, setFeeState: (o) => Object.assign(S, o),
  // Walk orchestration, exposed so the SEQUENCING can be tested without a courier,
  // an LSP or a chain: these are the ordering + accounting rules, and they are what
  // decide how much of a user's order actually fills.
  walkState: () => WALK,
  setWalkState: (w) => { WALK = w; },
  beginWalk, advanceWalk, stopWalk, walkStatusLine, walkTerminal, hasWalkInFlight, clearWalk,
  setMarkets: (m) => { MARKETS = m; },
  // XMARKETS in the composer are the snake_case shape xswap.js's normMarket emits
  // (and that C.xroute.markets() returns). Normalize camelCase test fixtures to match.
  setXMarkets: (m) => { XMARKETS = (m||[]).map(x => ({
    btc_asset: x.btc_asset ?? x.btcAsset ?? '',
    seq_asset: x.seq_asset ?? x.seqAsset,
    name: x.name || 'BTC / Sequentia asset',
    price_seq_per_btc: x.price_seq_per_btc ?? x.priceSeqPerBtc ?? 0,
  })); },
  orientLegs, pick,
  // Reframe: given (payAsset, receiveAsset) over the loaded markets, return the
  // route the composer would take ({kind:'same', side, market} | {kind:'cross', ...} | null).
  composerRoute: (pay, receive) => findRoute(pay, receive),
  counterpartsOf, startableAssets, allTradableAssets: startableAssets,
  // F1/F2 — asset picker default-vs-search visibility, paste-an-id tradability, and the
  // hidden-asset store, exposed so the REAL candidate construction + filtering are pinned
  // headlessly (no popover DOM needed).
  pickerCandidates, pickerMatches, metaOf, notePasted, pastedIds: () => PASTED,
  hiddenAssets, setAssetHidden, isAssetHidden, partitionHidden, ensureDefaults,
  acceptedFee, defaultFeeAsset,
  // Take/Post + rail-combo helpers, for headless verification of the composer's gating.
  postSupported, railSupported, applyAutoMode,
  // W5 — the SBTC mis-sell binding: a BTC-advertised covenant is only fillable as pegged BTC if it LOCKS SBTC.
  covenantLocksAsset,
  // Covenant byte-order boundary: display<->internal id flip + the per-record-generation
  // derivation ids (new records internal, legacy display — the refund-compatibility contract).
  revHex, covenantDerivationIds,
  // RAIL-BLIND take + markets overview, for headless verification of the composer's rail-blindness.
  bridgedTakePlan, overviewPairs, renderMixedTake, bestReceivePerPay,
  // Speed-aware selection (routing honesty): the class predicate + the executed-amount price
  // comparison, exposed so the "native wins ties / bridged only on strictly better" rule and
  // its rounding discipline are pinned headlessly. subswapStatusLine for the drive-time label.
  offerSettlesFast, bridgedBeatsExecuted, subswapStatusLine,
  // Job reconciliation: a record the LSP has already failed must mark itself failed
  // rather than sit in flight blocking every subsequent trade. Exposed with both
  // record slots so the BRIDGE path (the one that actually stalled) is testable.
  reconcileJobStatus,
  bridgePreCommitment,
  // Retry-down-the-book: a handshake that failed with NOTHING funded should move to the
  // next offer rather than killing the trade, so one dead maker cannot fail every take.
  retryableHandshakeFailure, markOfferDead, clearDeadOffers,
  deadOffers: () => _deadOffers,
  // Per-trade sell records (the wedge-the-rail fix): exposed so the concurrency
  // semantics — a stuck sell never blocks the next one — are pinned headlessly.
  sells: () => SELLS,
  setSells: (arr) => { SELLS = Array.isArray(arr) ? arr : []; },
  addSell, clearSell, sellTerminal, activeSells, buySlotsFree,
  railsUnset: () => _railsUnset,
  advanceSubswapToNextOffer,
  sizedTake,
  setSubswapRecord: (r) => { SUBSWAPS = r ? [Object.assign({ id: newTradeId() }, r)] : []; },
  setBridgeRecord: (r) => { BRIDGE = r; },
  subswapRecord: () => SUBSWAPS[0] || null,
  subswapRecords: () => SUBSWAPS,
  addSubswap, clearSubswap, activeSubswaps, subswapById, tradeSlotsFree, subswapTerminal,
  MAX_CONCURRENT_TRADES,
  bridgeRecord: () => BRIDGE,
  setUnifiedBook: (seqAsset, book) => { UBOOK = book ? { seqAsset, asks: book.asks || [], bids: book.bids || [] } : null; },
  // Drive the FULL composer requote for the cross (chain/chain) + mixed (sub-asset) branches, so a headless
  // test can prove they render the SAME rail-blind preview (both source the offer/fill from bridgedTakePlan).
  requoteMixed, requoteCross, requoteLn,
  // Pure-LN partial fills: the slice pricing (the exact Go-rounding mirror) + the
  // wire-body builder, so review==execution is pinned headlessly.
  plnSliceQuote, plnSwapBody,
  setSubassetBook: (hex, entry, quote) => { const k = String(hex).toLowerCase() + '|' + String(quote || 'BTC').toLowerCase(); if (entry == null) delete SUBASSET_BOOK[k]; else SUBASSET_BOOK[k] = entry; },
  // The priced/oriented quote the composer carries into Review -> startBuy/startSell. A headless test reads it to
  // prove the settlement handle (buyOffer/sellOffer) + the authoritative fill (takeAssetAtoms/takeBtcSats) are
  // exactly what the composer DISPLAYED (the sub-asset settle-offer must be the SAME id it showed).
  lastQuote: () => LAST_QUOTE,
  subassetOffers, payerBridgeDisabledNote,
  // Stale-cap fund-safety (task 19/JOB1): the full BUY executor + its record store, so the
  // "quote == fund, byte-for-byte" and "mutated book at Confirm refuses pre-fund" invariants
  // are pinned headlessly against the REAL startBuy (not a re-implementation).
  startBuy, reconfirmSubassetOffer,
  buys: () => BUYS, clearBuys: () => { BUYS = []; },
  // Progress narrative (task 21a), for headless verification of stamps + composition.
  stageNarrative, stampStages, fmtDur,
  // Same-chain ONE-book union discipline (the ladder-collapse fix): the shared loader, the union
  // collector/paint, the live-stream state, and a client seam so a headless test can script the
  // relay (REST + WS) without a network. flushLiveBook fires a pending coalesced rebuild NOW.
  setSeqobClient: (o) => { OB = o ? { ...seqob, ...o } : seqob; },
  requoteSame, loadSameBook, renderSameUnion, collectSameOffers, unifiedSameRows,
  sameChainRowExecutable, crossableDepthAtoms, marketFillSplit, applyOffersToBook,
  startLiveBook, stopLiveBook,
  liveBook: () => _liveBook,
  sameBook: () => SAMEBOOK,
  book: () => BOOK,
  flushLiveBook: () => { const lb = _liveBook; if (!lb) return; if (lb.timer){ try { clearTimeout(lb.timer); } catch {} lb.timer = null; } if (lb._rebuild) lb._rebuild(); },
  GHOST_GRACE_SECS,
  state: S,
};
