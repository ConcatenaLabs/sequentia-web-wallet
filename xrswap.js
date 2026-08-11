// ---------------------------------------------------------------------------
// SeqDEX REVERSE cross-chain (Sequentia-asset -> BTC) swap wizard.
//
// The mirror of xswap.js: there the taker BUYS an asset paying BTC; here the
// taker SELLS a Sequentia asset FOR BTC. Roles flip — the MAKER is the secret
// holder and locks the BTC leg FIRST; the taker funds the asset leg second and
// claims the BTC leg with the secret the maker reveals. The negotiation runs over
// the SeqOB order-book COURIER (xcourier.js); settlement is entirely client-side
// HTLC work. (An earlier build could also drive a stateful RFQ daemon over REST
// `/v1/xchain/reverse/*`; that rail is retired and its client code is gone.)
//
// Flow (taker = this wallet), matching XchainSwapState:
//   1. Open      OpenReverseXchainSwap{quote_id, taker_btc_claim_pub,
//                taker_seq_refund_pub} -> the maker locks the BTC leg and returns
//                {btc_leg, H, maker_seq_claim_pub, maker_btc_refund_pub, T_btc>T_seq}.
//                We REVERIFY the BTC-leg redeemScript (claim=us, refund=maker, T_btc)
//                before trusting it. State BTC_LOCKED.
//   2. Confirm   wait on OUR OWN node for the maker's BTC leg to confirm (it
//                broadcasts at 0-conf on a live network), then wait for our anchor
//                to reach that height so our asset block anchors at/above it.
//   3. Fund SEQ  buildSeqHtlcRedeemScript(H, maker_seq_claim_pub, taker_seq_refund_pub,
//                T_seq) -> send the asset to that P2SH as an EXPLICIT output, confirm,
//                capture {txid,vout}. (Real money moves here — a structured review.)
//   4. Announce  the funded asset leg goes to the maker over the courier session;
//                the maker runs the anchor gate then CLAIMS it, revealing the secret.
//   5. Reveal    read the secret OFF-CHAIN from the maker's claim (a courier
//                `secret_revealed` is only a verified fast-path hint).
//   6. Claim BTC btcLeg.claim(btc_leg, preimage) -> a testnet4 Bitcoin tx spending
//                the maker's BTC leg via the IF branch. State BTC_CLAIMED (done).
//   7. Refund    off-ramp: after T_seq, refund OUR asset leg (the ELSE/CLTV branch)
//                if the maker never claimed it.
//
// Swap state is persisted to localStorage so a reload can resume a claim or refund.
//
// Project UI rules honoured (same as xswap.js): SEQ equal standing (no privileged
// "native" hero — the asset shows by its registry ticker; BTC is the parent leg),
// reference-currency hints, and anchor-aware finality copy (never "instant").
// ---------------------------------------------------------------------------

import * as seqob from './seqob.js';
import * as xcourier from './xcourier.js';
import { sha256 } from './btc.js';

let C = null;            // injected app context (see index.html initSwapTab)
let LAST_RQUOTE = null;  // the live reverse quote for the composer's selection
let SWAP = null;         // the persisted in-flight reverse swap
let POLL = null;         // setInterval handle for the state-machine driver
let COUNTDOWN = null;    // setInterval handle for the quote-expiry countdown
let CLAIMING = false;    // re-entrancy guard for the auto BTC claim
let SETTLING = false;    // re-entrancy guard for the on-chain settle driver

const LS_KEY = 'swk.sequentia.xrswap';   // localStorage key (distinct from xswap.js)

// Transport: the SeqOB order-book COURIER, and nothing else. The legacy RFQ
// daemon rail (`/v1/xchain/reverse/*` + `/v1/xchain/swap`) is RETIRED — the
// daemon still binds :9945 but nothing routes to it, so those calls could only
// hang or 404, i.e. a trade could enter that rail and never leave. Everything
// below the transport — the client-side BTC/SEQ HTLC settlement + the
// C.btcLeg/C.seqLeg bridges — is unchanged.

// The Sequentia esplora base, same origin-relative path index.html uses (/api).
// The reverse taker reads the maker's revealed preimage OFF-CHAIN from the maker's
// asset-leg claim here, so it never has to trust a courier message to learn the
// secret (a courier 'secret_revealed' is only a verified fast-path hint).
const SEQ_ESPLORA = (typeof location !== 'undefined' ? location.origin : '') + '/api';

const bytesToHex = (a) => { let s = ''; for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s; };
const hexToBytes = (h) => { if (!h) return new Uint8Array(0); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const sha256Hex = (hex) => bytesToHex(sha256(hexToBytes(hex)));

// Stepper states — the proto enum names the grpc-gateway emits.
const ST = {
  QUOTED:      'QUOTED',                            // local-only (pre-open)
  BTC_LOCKED:  'XCHAIN_SWAP_STATE_BTC_LOCKED',
  SEQ_SUBMITTED:'XCHAIN_SWAP_STATE_SEQ_SUBMITTED',
  SEQ_CLAIMED: 'XCHAIN_SWAP_STATE_SEQ_CLAIMED',
  BTC_CLAIMED: 'XCHAIN_SWAP_STATE_BTC_CLAIMED',
  REFUNDED:    'XCHAIN_SWAP_STATE_REFUNDED',
  FAILED:      'XCHAIN_SWAP_STATE_FAILED',
};

function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
const big = v => BigInt(v == null ? 0 : v);
const num = v => (v == null ? 0 : Number(v));

// ProportionalBtc (FLOOR) — the BTC (sats) the maker PAYS a partial REVERSE taker for `take` asset atoms
// out of a whole offer of `whole` atoms priced at `wholeBtc` sats. Mirrors the Go ProportionalBtcFloor
// (daemon xdriver_subasset.go): FLOOR is the maker's favour here (the MAKER gives the BTC), and a WHOLE
// take (take >= whole) returns wholeBtc EXACTLY — byte-identical to the pre-partial whole-HTLC lift. The
// Go maker recomputes the SAME value and funds its BTC leg to it (xdriver_reverse.go:535), so both sides
// agree bit-for-bit. A floor of 0 (dust) is rejected by the caller. BigInt is arbitrary-precision.
function proportionalBtcFloor(wholeBtc, take, whole){
  wholeBtc = big(wholeBtc); take = big(take); whole = big(whole);
  if (whole <= 0n || take >= whole) return wholeBtc;
  return (wholeBtc * take) / whole;
}

// --- Minimum-slice DUST GUARD (byte-for-byte mirror of the Go daemon xminslice.go) --------------------
// A PARTIAL take that prices to a few sats (or a few atoms) is unsettleable: after the HTLC spend fee, the
// (Amount - Fee) claim/refund output is sub-dust and cannot relay or be economically claimed, so the leg
// strands and atomicity breaks. The Go reverse driver fails CLOSED below a safe minimum on BOTH sides,
// BEFORE any coin moves (xdriver_reverse.go:152 BTC-side, :216 asset-side). We mirror the SAME thresholds +
// fee basis here so a sub-dust slice is refused PRE-FUND — the reverse leg we FUND is the asset, and the BTC
// we RECEIVE is the floor leg we will CLAIM, so guard both. Constants are identical to xminslice.go.
const BTC_DUST_LIMIT = 546n;          // Bitcoin's canonical P2SH dust value (btcDustLimit)
const LEG_SPEND_FEE_FLOOR = 1000n;    // the drivers' SpendFeeSats default; a smaller fee floors up to it
const DEFAULT_SPEND_FEE_SATS = 1000n; // the driver default the maker/CLI use (xdriver_reverse.go:127-128)
// MinSafeBtcLegSats: the smallest BTC leg (sats) a partial may create = dust + 2x the per-spend fee. At the
// 1000-sat default: 546 + 2000 = 2546.
function minSafeBtcLegSats(spendFeeSats){
  let fee = big(spendFeeSats); if (fee < LEG_SPEND_FEE_FLOOR) fee = LEG_SPEND_FEE_FLOOR;
  return BTC_DUST_LIMIT + 2n * fee;
}
// minSafeAssetLeg: the smallest asset leg (atoms) a partial may create — the native spend fee converted to
// the asset's OWN atoms via the open-fee-market exchange rate (ceil(fee*1e8/rate)), then 1 atom of dust + 2x
// that fee. Without a published rate it falls back to the flat native target. C.feeRateFor THROWS when the
// asset is unpriced, so a throw is treated exactly as "no rate" (mirrors xminslice.go's SeqFeeRate fallback).
function minSafeAssetLeg(assetHex, spendFeeSats){
  let fee = big(spendFeeSats); if (fee < LEG_SPEND_FEE_FLOOR) fee = LEG_SPEND_FEE_FLOOR;
  let rate = 0n;
  try { if (C && C.feeRateFor) rate = big(C.feeRateFor(assetHex)); } catch { rate = 0n; }
  if (rate > 0n){
    const scale = big((C && C.EXCHANGE_RATE_SCALE) || 100000000);
    fee = (fee * scale + rate - 1n) / rate;   // ceil(fee*1e8/rate)
    if (fee === 0n) fee = 1n;
  }
  return 1n + 2n * fee;
}
// Reason strings (null when safe OR a whole take, which locks the whole offer and is never a partial dust
// slice). Mirror minSafeBtcErr / minSafeAssetErr.
function minSafeBtcReason(takeSeq, whole, btcLeg, spendFeeSats){
  if (big(takeSeq) >= big(whole)) return null;
  const m = minSafeBtcLegSats(spendFeeSats);
  if (big(btcLeg) < m) return `this amount prices to a ${btcLeg}-sat Bitcoin leg, below the safe minimum ${m} (dust + fee) - sell a larger amount`;
  return null;
}
function minSafeAssetReason(assetHex, takeSeq, whole, assetLeg, spendFeeSats){
  if (big(takeSeq) >= big(whole)) return null;
  const m = minSafeAssetLeg(assetHex, spendFeeSats);
  if (big(assetLeg) < m) return `this amount leaves a ${assetLeg}-atom asset leg, below the safe minimum ${m} (dust + fee) - sell a larger amount`;
  return null;
}

function normMarket(m){
  return {
    btc_asset:        pick(m, 'btc_asset', 'btcAsset') || '',
    seq_asset:        pick(m, 'seq_asset', 'seqAsset'),
    name:             pick(m, 'name') || 'BTC / Sequentia asset',
    seq_reserve:      big(pick(m, 'seq_reserve', 'seqReserve')),
    btc_reserve:      big(pick(m, 'btc_reserve', 'btcReserve')),
    price_seq_per_btc: num(pick(m, 'price_seq_per_btc', 'priceSeqPerBtc')),
  };
}
// ---- localStorage persistence ----
function saveSwap(){
  try {
    if (!SWAP){ localStorage.removeItem(LS_KEY); return; }
    // Per-stage timestamp (task 21a): the reverse flow's stage is state+phase; stamped in the
    // one save funnel every transition goes through, so the stepper can show stage elapsed.
    const stage = String(SWAP.state) + '|' + String(SWAP.phase || '');
    if (SWAP.stage_key !== stage || !SWAP.stage_since_ms){ SWAP.stage_key = stage; SWAP.stage_since_ms = Date.now(); }
    if (!SWAP.started_ms) SWAP.started_ms = Date.now();
    const ser = JSON.parse(JSON.stringify(SWAP, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    localStorage.setItem(LS_KEY, JSON.stringify(ser));
  } catch (e){ /* best-effort */ }
}
function loadSwap(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw){ SWAP = null; return; }
    const s = JSON.parse(raw);
    if (s.seq_amount != null) s.seq_amount = big(s.seq_amount);
    if (s.btc_amount != null) s.btc_amount = big(s.btc_amount);
    if (s.fee_btc != null)    s.fee_btc = big(s.fee_btc);
    if (s.btc_leg)            s.btc_leg.amount = big(s.btc_leg.amount);
    if (s.seq_leg && s.seq_leg.amount != null) s.seq_leg.amount = big(s.seq_leg.amount);
    SWAP = s;
  } catch (e){ SWAP = null; }
}
function clearSwap(){ SWAP = null; saveSwap(); }

export function initXrswap(ctx){
  C = ctx;
  // Point the order-book client at the relay base index.html injected (C.SEQOB),
  // falling back to same-origin /seqob.
  try { seqob.setSeqobBase(C.SEQOB || (C.XDEX ? C.XDEX.replace(/\/dex$/, '/seqob') : '/seqob')); } catch {}
}

// ---------------------------------------------------------------------------
// Courier offer discovery + settlement helpers.
// ---------------------------------------------------------------------------

// Direction constants mirror internal/seqob/offer/sentinel.go.
const DIR_ASSET_TO_BTC = 1;   // reverse: taker sells the asset, maker gives BTC

function offerField(o, ...names){ for (const n of names){ if (o[n] !== undefined && o[n] !== null) return o[n]; } return undefined; }

// Find a verified reverse (ASSET_TO_BTC) cross offer to sell `seqAsset` into. The
// book pair is <asset>/BTC; a reverse offer is a maker BUY of the asset (it gives
// BTC). Picks the offer paying the most BTC per asset atom; whole-HTLC (the taker
// sells the offer's full asset amount).
async function findReverseOffer(seqAsset, seqAtoms){
  // Merge BOTH pair orientations, exactly like the book RENDER (xswap.js fetchXbook): the relay keys
  // markets by EXACT base/quote order, so cross-HTLC reverse offers rest on <asset>/BTC while an SBTC
  // silent-peg covenant (or any offer resting under the flipped orientation) advertises offer_asset=BTC
  // and rests on BTC/<asset>. Fetching ONLY <asset>/BTC missed a pegged covenant that is the only reverse
  // liquidity — fetchRQuote then threw, Review was disabled, and the covenant take branch in reviewCross
  // was unreachable (the SBTC silent-peg taker loop could never complete). Dedup by maker:offer_id (a
  // maker that seeded both orientations shows once).
  const grab = async (base, quote) => {
    try { const bk = await seqob.fetchBook(base, quote); return bk.offers || bk.Offers || []; }
    catch { return []; }
  };
  const both = [...(await grab(seqAsset, 'BTC')), ...(await grab('BTC', seqAsset))];
  const seen = new Set();
  const offers = both.filter(o => {
    if (o._verified === false) return false;
    // Mirror the composer's book predicate (isReverseCrossOffer in xswap.js): a reverse offer is simply
    // one whose offer_asset is BTC (the maker gives BTC for the asset = a taker SELL). Daemon/relay-seeded
    // reverse offers carry NO cross_chain field (the maker keys/locktimes are minted per-lift), so the old
    // cross_chain.direction requirement returned null for exactly the seeded liquidity the ladder showed,
    // throwing "No one is buying this asset for BTC right now". Forward offers have want_asset==='BTC'
    // instead, so this never picks one up.
    if (offerField(o, 'offer_asset', 'offerAsset') !== 'BTC') return false;
    const id = (offerField(o, 'maker_pubkey', 'makerPubkey') || '') + ':' + (offerField(o, 'offer_id', 'offerId') || '');
    if (seen.has(id)) return false; seen.add(id);
    return true;
  });
  if (!offers.length) return null;
  const norm = (o) => {
    // reverse offer: offer_asset='BTC' (maker gives BTC), want_asset=the asset.
    const btc = big(offerField(o, 'offer_amount', 'offerAmount'));
    const asset = big(offerField(o, 'want_amount', 'wantAmount') || offerField(o, 'base_amount', 'baseAmount'));
    return { o, btc, asset, ratio: asset > 0n ? Number(btc) / Number(asset) : 0 };
  };
  const all = offers.map(norm).filter(x => x.btc > 0n && x.asset > 0n);
  if (!all.length) return null;
  const req = seqAtoms ? big(seqAtoms) : 0n;
  if (req <= 0n) return all.sort((a, b) => b.ratio - a.ratio);   // no size hint -> best price first ([0] best)
  // Whole-HTLC rail: pick the offer CLOSEST in size to the request (mirror the forward's bestForwardOffer)
  // so a small sell doesn't lift a huge offer, while staying within a price tolerance of the best rate.
  // Smallest offer that COVERS the request first, then the largest below it. Consent is still re-taken on
  // the chosen offer's exact whole-HTLC terms before any asset is funded.
  const bestRatio = all.reduce((m, x) => Math.max(m, x.ratio), 0);
  const pool0 = all.filter(x => bestRatio > 0 ? x.ratio >= bestRatio * 0.98 : true);
  const pool = pool0.length ? pool0 : all;
  const cmpAsc = (a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0);
  const covering = pool.filter(x => x.asset >= req).sort(cmpAsc);              // smallest covering first
  const below = pool.filter(x => x.asset < req).sort((a, b) => cmpAsc(b, a));  // then largest below
  return [...covering, ...below];
}

// ---- anchor precondition (asset FUNDER side) --------------------------------
// The node's LIVE anchor view + its health, from the LSP's read-only /anchor.
// This is the ADVANCING quantity (the tip's Bitcoin-anchor height), as opposed to
// a block's own committed anchor, which never moves. Returns null when unreadable
// so the caller waits rather than proceeding on an unknown anchor.
// Poll cadence for the anchor precondition. A knob, not a deadline: nothing here
// ever gives up on the clock (see fundWindowClosed). Tests shorten it.
const T = { anchorPollMs: 15 * 1000 };
// How many Sequentia blocks must still remain before T_seq for a leg funded NOW to
// be claimable by the maker in time. Mirrors the Go MinSeqFundWindow (120 blocks,
// ~1h at 30s slots) — the same window this wallet demands of the maker's terms.
const MIN_SEQ_CLAIM_WINDOW = 120;
// And on the parent chain: below this many blocks before T_btc we could no longer
// claim the maker's BTC after it reveals, so funding would be one-sided.
const MIN_BTC_CLAIM_WINDOW = 6;
async function anchorTipStatus(){
  if (C && C.anchorTipStatus) return C.anchorTipStatus();
  try {
    const base = (typeof location !== 'undefined' ? location.origin : '') + '/lsp';
    const r = await fetch(base + '/anchor', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (!j || !j.ok) return null;
    const h = (j.anchor_height != null) ? Number(j.anchor_height) : null;
    if (!Number.isFinite(h)) return null;
    // anchor_status is absent on an LSP predating the field; treat that as NOT ok
    // (fail closed) rather than assume a healthy anchor we cannot see.
    return { height: h, ok: j.anchor_status === 'ok' };
  } catch { return null; }
}

// fundWindowClosed reports why funding is no longer safe, or null while it still
// is. This is the ONLY thing allowed to end the wait below automatically. A flat
// wall-clock timeout is deliberately absent: contested blocks take as long as they
// take, and it is the USER who decides when that is intolerable (owner ruling,
// 2026-07-25) — the wallet surfaces the wait and offers to cancel the trade, it
// does not cancel it for them. A chain read that FAILS is not a verdict; it
// returns null and we keep waiting.
async function fundWindowClosed(){
  if (!SWAP) return null;
  try {
    const seqNow = await seqTipHeight();
    if (Number.isFinite(seqNow) && SWAP.seq_locktime &&
        seqNow + MIN_SEQ_CLAIM_WINDOW >= Number(SWAP.seq_locktime))
      return `the Sequentia chain has moved to block ${seqNow}, leaving less than ${MIN_SEQ_CLAIM_WINDOW} blocks before your asset refund at ${SWAP.seq_locktime} - an asset leg funded now could not be taken in time, so nothing was spent`;
  } catch {}
  try {
    const btcNow = await btcTipHeight();
    if (Number.isFinite(btcNow) && SWAP.btc_locktime &&
        btcNow + MIN_BTC_CLAIM_WINDOW >= Number(SWAP.btc_locktime))
      return `Bitcoin has reached block ${btcNow}, too close to the maker's refund at ${SWAP.btc_locktime} for you to claim the BTC afterwards - nothing was spent`;
  } catch {}
  return null;
}

// awaitAnchorReachesBtcLeg blocks until our own node's anchor has reached `target`
// with a healthy status. Returns null on success, or a reason string to abort with.
// See the call site in driveReverse for why this must happen BEFORE the asset moves
// and can never be substituted by a later re-check.
//
// `target` is the maker's BTC-leg height PLUS ONE. The maker derives that height
// from two separate reads (its tip, then the confirmation count), so a Bitcoin
// block landing between them yields a height one HIGHER than we measured — and its
// gate would then refuse a leg we had already funded. Waiting longer is never
// unsafe, so we absorb that race instead of letting it cost us the asset.
// setWaitNote is the ONLY user-visible signal during the anchor precondition, and
// it deliberately writes to THIS module's stepper. It used to call
// C.setStepStatus, which is module-private to xswap.js and is NOT in the context
// index.html passes to initXrswap — so the call was always a no-op guarded by
// `C && C.setStepStatus`, and the user watched an unexplained stall through a wait
// that is now bounded only by the timelock. The note is persisted with the swap so
// it survives a re-render, and cleared the moment the wait resolves.
function setWaitNote(msg){
  try {
    // drive_beat_ms is the LIVENESS HEARTBEAT of the take's linear driver: stamped on every
    // wait iteration so resumeFundingPhase can tell a driver that is patiently waiting from
    // one that died (renderer freeze, uncaught throw, reload) and left the record wedged.
    if (SWAP){ SWAP.wait_note = msg || ''; SWAP.drive_beat_ms = Date.now(); saveSwap(); }
    const n = C && C.$ && C.$('xrStepStatus');
    if (n) n.textContent = msg || '';
  } catch {}
}

async function awaitAnchorReachesBtcLeg(target){
  let last = null;
  for (;;){
    const st = await anchorTipStatus();
    last = st;
    if (st && st.ok && st.height >= target){ setWaitNote(''); return null; }
    const closed = await fundWindowClosed();
    if (closed){ setWaitNote(''); return closed; }
    setWaitNote(`Waiting for your Sequentia node to anchor at or above the maker's BTC lock (${target})… nothing is spent while you wait; cancel the trade if it is taking too long.`);
    await new Promise(r => setTimeout(r, T.anchorPollMs));
  }
}

// The Sequentia / Bitcoin tip heights, via the context when it supplies them
// (tests + a wallet that already caches them), else the explorers.
async function seqTipHeight(){
  if (C && C.seqTip) return Number(await C.seqTip());
  const r = await fetch(SEQ_ESPLORA + '/blocks/tip/height', { signal: AbortSignal.timeout(6000) });
  return parseInt((await r.text()).trim(), 10);
}
async function btcTipHeight(){
  if (C && C.btcTip) return Number(await C.btcTip());
  const base = (typeof location !== 'undefined' ? location.origin : '') + '/testnet4/api';
  const r = await fetch(base + '/blocks/tip/height', { signal: AbortSignal.timeout(6000) });
  return parseInt((await r.text()).trim(), 10);
}

// A Sequentia block's COMMITTED Bitcoin-anchor height (a fixed header field, unlike
// the advancing tip reading above), self-derived from the LSP's read-only /anchor.
// Returns null when unknown — the caller then treats the leg as under-anchored and
// withholds it, never as "fine".
async function anchorHeightOfBlock(blockHash){
  const ev = await legAnchorEvidence(null, blockHash);
  return ev.anchor >= 0 ? ev.anchor : null;
}

// How many times a single anchor read is retried before it counts as UNKNOWN. The
// endpoint shells out to the node per request and 502s on any hiccup; a SINGLE
// failure used to make legAnchor null, and this wallet then withheld — and
// declared under-anchored — a leg that was perfectly fine. A transient 502 must
// cost a retry, not somebody's trade.
const ANCHOR_READ_TRIES = 3;

// legAnchorEvidence resolves the anchor of the block confirming an asset leg.
//
// It prefers a TXID lookup because reading by CACHED BLOCK HASH is wrong in both
// directions, exactly as it was on the Go side: the endpoint answers for ORPHANED
// blocks too (it reads the block index, not the chain), so a cached hash keeps
// reporting a verdict about a block the network has abandoned, and a reorg that
// re-mines the leg into a BETTER-anchored block stays invisible. Asking by txid
// asks "which block confirms this leg NOW", and the answer counts only when the
// server says that block is on the ACTIVE chain.
//
// anchor is -1 for UNKNOWN, never 0 — anchor 0 reads as "confirmed but anchored
// below the BTC lock", the terminal unsafe verdict, and Number(null) === 0 is
// precisely how an absent value used to become one.
async function legAnchorEvidence(txid, blockHashFallback){
  // A context that supplies its own reader (tests, and any embedder that wired one
  // before this function existed) keeps ownership of its freshness policy, so the
  // txid-first re-derivation below is a property of the HTTP path only. What holds
  // either way: an absent anchor is UNKNOWN (-1), never 0.
  if (C && C.anchorHeightOf){
    const a = await C.anchorHeightOf(blockHashFallback);
    return { anchor: (a == null ? -1 : Number(a)), onActiveChain: a != null };
  }
  const q = txid ? ('tx=' + encodeURIComponent(txid))
          : (blockHashFallback ? ('block=' + encodeURIComponent(blockHashFallback)) : null);
  if (!q) return { anchor: -1, onActiveChain: false };
  const base = (typeof location !== 'undefined' ? location.origin : '') + '/lsp';
  for (let i = 0; i < ANCHOR_READ_TRIES; i++){
    try {
      const r = await fetch(base + '/anchor?' + q, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      if (j && j.ok){
        const h = (j.anchor_height != null) ? Number(j.anchor_height) : NaN;
        if (!Number.isFinite(h)) return { anchor: -1, onActiveChain: false };   // truthfully "not confirmed yet"
        return { anchor: h,
                 // Absent on an older LSP: only treat that as unproven when we asked
                 // by BLOCK, since a tx lookup already resolves through the node's own
                 // view of which block confirms it.
                 onActiveChain: (j.on_active_chain != null) ? !!j.on_active_chain : !!txid };
      }
    } catch {}
    if (i < ANCHOR_READ_TRIES - 1) await new Promise(r => setTimeout(r, 500));
  }
  return { anchor: -1, onActiveChain: false };
}

// Read the maker's revealed preimage OFF-CHAIN: find the tx that spent our funded
// asset leg (the maker's claim) via the Sequentia esplora, then extract the push
// whose sha256 equals the agreed hashlock H. Returns the preimage hex, or null if
// the leg is not yet spent / the preimage is not yet visible. Trust-minimising:
// the wallet learns the secret from the chain, never from a courier message alone.
async function readPreimageOnChain(seqLegTxid, vout, hashHex){
  try {
    const os = await fetch(`${SEQ_ESPLORA}/tx/${seqLegTxid}/outspend/${vout}`).then(r => r.ok ? r.json() : null);
    if (!os || !os.spent || !os.txid) return null;
    const stx = await fetch(`${SEQ_ESPLORA}/tx/${os.txid}`).then(r => r.ok ? r.json() : null);
    if (!stx) return null;
    const want = String(hashHex).toLowerCase();
    for (const vin of (stx.vin || [])){
      // Gather every data push from the P2SH scriptSig (and witness, defensively).
      const pushes = [];
      const asm = vin.scriptsig_asm || vin.scriptSig_asm || '';
      for (const tok of asm.split(/\s+/)){
        const m = /^OP_PUSHBYTES_\d+\s*$/.test(tok) ? null : (/^[0-9a-fA-F]{2,}$/.test(tok) ? tok : null);
        if (m) pushes.push(m.toLowerCase());
      }
      for (const w of (vin.witness || [])) if (/^[0-9a-fA-F]{2,}$/.test(w)) pushes.push(w.toLowerCase());
      for (const p of pushes){
        // Match ANY push whose sha256 equals H, not only 32-byte ones. The HTLC redeem has no
        // OP_SIZE guard, so a maker can claim the asset with a non-32-byte secret; gating on
        // p.length===64 meant the taker never recognised such a preimage on-chain and could not
        // claim the BTC (asset gone, BTC unclaimable). sha256(p)===H is the real, sufficient filter.
        if (sha256Hex(p) === want) return p;
      }
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Composer bridge — the symmetric composer in swap.js gets a reverse quote
// through these exports, then hands it to openReverseFromComposer().
// ---------------------------------------------------------------------------
// The order book has no separate "markets" list; a market exists iff a verified
// reverse offer rests for the asset. The composer discovers per-asset at quote
// time (fetchRQuote), so this returns an empty seed — callers tolerate it.
export async function fetchRMarkets(){ return []; }

// Quote SELLING `seqAtoms` of `seqAsset` for BTC. Over the courier there is no
// pre-quote round-trip: the price lives in the resting offer, and the load-bearing
// terms (maker keys, locktimes) are minted per-lift once the session opens. So the
// "quote" here carries the chosen OFFER and its fixed whole-HTLC amounts; the real
// terms arrive in the maker's btc_leg_locked during the lift.
export async function fetchRQuote(seqAsset, seqAtoms){
  const ranked = await findReverseOffer(seqAsset, seqAtoms);
  if (!ranked) throw new Error('No one is buying this asset for BTC right now. Try again later, or place a same-chain order.');
  const best = ranked[0];
  // T4 retry-down-book (reverse): the other reverse offers as fallbacks if the best maker doesn't
  // respond BEFORE it locks any BTC. Reverse price is BTC-per-asset (ratio), so HIGHER is better for
  // the seller; keep only offers within 2% of best's ratio (never route to a materially worse sale).
  // Each is whole-HTLC (its own size), so onOpen re-shows the confirm for the chosen fallback's terms.
  const RETRY_MAX = 3, PRICE_TOL = 0.02;
  // Each fallback is a DIFFERENT resting offer, so CLAMP its take to the SAME requested slice
  // (min(reqSlice, candidate.base)) - never the whole candidate offer, which would overshoot the user's
  // request when the primary maker times out (the composer caps the PRIMARY quote to reqSeqAtoms, but the
  // candidates rested here at their whole size). wantBtc is the FLOOR-proportional BTC the seller RECEIVES for
  // the slice at the candidate's OWN ratio (proportionalBtcFloor, the maker's favour) - mirrors the forward
  // path's min(reqSlice, base)+proportional clamp (xswap.js runForwardCourier). A no-size-hint quote
  // (reqSlice <= 0) keeps the whole offer.
  const reqSlice = seqAtoms ? big(seqAtoms) : 0n;
  const candidates = ranked.slice(1)
    .filter(x => best.ratio > 0 && x.ratio >= best.ratio * (1 - PRICE_TOL))
    .slice(0, RETRY_MAX)
    .map(x => {
      const take = (reqSlice > 0n && reqSlice < x.asset) ? reqSlice : x.asset;   // min(reqSlice, candidate.base)
      const wantBtc = proportionalBtcFloor(x.btc, take, x.asset);                // floor: the BTC the seller receives
      return { offer: x.o, seq_amount: take, btc_amount: wantBtc,
        price_seq_per_btc: wantBtc > 0n ? (Number(take) / Number(wantBtc)) : 0,
        expires_at_unix: Number(offerField(x.o, 'expires_at_unix', 'expiresAtUnix') || 0) };
    });
  return {
    reverse: true,
    offer: best.o,
    market: { btc_asset:'', seq_asset:seqAsset, name:'BTC / Sequentia asset' },
    seq_amount: best.asset,           // whole-HTLC: you sell the offer's full asset amount
    btc_amount: best.btc,             // and receive its BTC
    price_seq_per_btc: best.ratio > 0 ? (Number(best.asset) / Number(best.btc)) : 0,
    fee_btc: 0n,                       // the maker's fee is disclosed in its per-lift terms
    candidates,
    expires_at_unix: Number(offerField(best.o, 'expires_at_unix', 'expiresAtUnix') || 0),
  };
}
// Seed the wizard with a composer-supplied reverse quote and start the open step.
export function openReverseFromComposer(q){
  LAST_RQUOTE = q;
  renderStepper();
  startCountdown();
  onOpen();
}
// True when a reverse swap is persisted and not terminal.
export function hasInFlight(){
  loadSwap();
  if (!SWAP) return false;
  return ![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state);
}
// Re-render an in-flight reverse swap (the composer resumes from here on tab entry).
export function renderReverse(){
  loadSwap();
  renderStepper();
  // Resume a courier swap's on-chain tail after a reload. Pre-funding courier swaps can't
  // resume the WS session, but nothing of ours is at risk there.
  if (SWAP && SWAP.courier && ![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state)){
    if (SWAP.seq_leg){
      driveSettle();                       // asset leg confirmed: read the revealed secret + claim the BTC
    } else if (SWAP.seq_fund_txid){
      // RESUME GAP: the asset HTLC was BROADCAST (seq_fund_txid persisted) but the app died during
      // waitConf, before seq_leg was set. renderReverse used to skip this (it only checked seq_leg),
      // stranding the funded asset — the refund path also keys on seq_leg. resumeSeqLeg NEVER funds:
      // it reuses the persisted seq_fund_txid, waits for the confirmation and records the leg, then
      // settles. Now the asset is always resumable AND refundable.
      resumeSeqLeg().then(() => driveSettle()).catch(() => { /* surfaced on the stepper; the CLTV refund off-ramp appears once seq_leg is set */ });
    } else if (SWAP.seq_redeem && SWAP.taker_seq_refund_secret){
      // STRAND RECOVERY: seq_redeem was persisted the same synchronous tick BEFORE seqLeg.fund
      // broadcasts, but fund() threw after the node accepted the tx (a lost response) — so neither
      // seq_fund_txid nor seq_leg was ever set and both branches above miss it. Scan the HTLC address
      // for the already-broadcast funding output, ADOPT its txid, then resume. If nothing is found the
      // fund never landed and the record is safely abandonable — until then onAbandon keeps the
      // reclaim material. (resumeSeqLeg refuses to act without a txid, so it can never re-fund.)
      C.seqLeg.findFundingByAddress(SWAP.seq_redeem).then((f) => {
        if (f && f.txid){ SWAP.seq_fund_txid = f.txid; saveSwap(); resumeSeqLeg().then(() => driveSettle()).catch(() => {}); }
        else resumeFundingPhase();   // nothing broadcast: the take's driver died pre-fund — re-drive it
      }).catch(() => {});
    } else if (SWAP.state === ST.BTC_LOCKED && SWAP.btc_leg && SWAP.btc_leg.txid){
      // PRE-FUNDING RESUME: the maker's BTC is locked and NOTHING of ours exists yet
      // (no redeem, no broadcast). The take's linear driver is the only thing that
      // would ever fund, and it does not survive a freeze/reload — re-drive it here
      // (heartbeat-gated inside, so a live driver is never raced).
      resumeFundingPhase();
    }
  }
}

function startCountdown(){
  const { $ } = C; const el = $('xrExpiry'); if (!el) return;
  if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; }
  const tick = () => {
    if (!LAST_RQUOTE || !LAST_RQUOTE.expires_at_unix || SWAP){ el.textContent = ''; return; }
    const secs = LAST_RQUOTE.expires_at_unix - Math.floor(Date.now()/1000);
    if (secs <= 0){ el.textContent = 'Quote expired - get a fresh quote.'; el.className = 'sub err';
      if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; } return; }
    el.className = 'sub'; el.textContent = `Quote valid for ${secs}s`;
  };
  tick(); COUNTDOWN = setInterval(tick, 1000);
}

// ---- step 1: open (the maker locks the BTC leg) ----
// Recompute the BTC-leg redeemScript ourselves — it must be claimable by OUR claim
// key with the preimage and refundable by the MAKER only after T_btc. If it does
// not match, the maker's BTC leg is not the one we agreed to; never fund the asset.
async function verifyMakerBtcLeg(){
  if (!SWAP || !SWAP.btc_leg) return { ok:false, reason:'no BTC leg yet' };
  const recomputed = C.wasm.buildSeqHtlcRedeemScript(
    SWAP.hash_hex, SWAP.taker_btc_claim_pub, SWAP.maker_btc_refund_pub, SWAP.btc_locktime);
  if (String(recomputed).toLowerCase() !== String(SWAP.btc_leg.redeem_script).toLowerCase())
    return { ok:false, reason:'maker BTC-leg script does not match the agreed terms - do not fund' };
  if (SWAP.btc_leg.amount < SWAP.btc_amount)
    return { ok:false, reason:`maker locked ${SWAP.btc_leg.amount} BTC atoms, less than the agreed ${SWAP.btc_amount}` };
  if (!(SWAP.btc_locktime > SWAP.seq_locktime))
    return { ok:false, reason:'bad timeout ordering (T_btc must exceed T_seq)' };

  // T_seq FLOOR. Ordering alone is not enough: a maker can satisfy
  // T_btc > T_seq while still minting a T_seq only a few blocks above the
  // current tip. Fund into that and fundWindowClosed is true on the FIRST poll —
  // the asset is locked and immediately inside its own refund margin, so the
  // anchor precondition can never run and the trade is dead on arrival. This
  // wallet already demands MIN_SEQ_CLAIM_WINDOW of the maker's terms elsewhere;
  // it must demand it HERE too, before anything of ours is committed.
  //
  // A tip read that FAILS is not a verdict, so it does not veto the leg: the
  // funder's own fundWindowClosed re-reads the chain immediately afterwards and
  // stops there if the window really has closed.
  try {
    const tip = await seqTipHeight();
    if (Number.isFinite(tip) && SWAP.seq_locktime &&
        Number(SWAP.seq_locktime) < tip + MIN_SEQ_CLAIM_WINDOW)
      return { ok:false, reason:`the maker's asset timeout T_seq=${SWAP.seq_locktime} is only ${Number(SWAP.seq_locktime) - tip} blocks above the current Sequentia tip ${tip}; this wallet needs at least ${MIN_SEQ_CLAIM_WINDOW} to settle safely - nothing was spent` };
  } catch {}
  return { ok:true };
}

// (The old RFQ `openSwap` lived here: it POSTed /v1/xchain/reverse/open to the
// retired daemon. On the courier the maker mints the terms and locks its BTC leg
// inside the session — see driveReverse.)

async function onOpen(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  const q0 = LAST_RQUOTE;
  if (!q0){ if ($('xrswapErr')) $('xrswapErr').textContent = 'get a quote first'; return; }
  // T4 (reverse): the quoted offer, then the price-bounded fallbacks (courier only). If the best maker
  // never locks any BTC, offer the next resting offer — each with its OWN confirm (a fallback is a
  // different whole-HTLC size, so consent is re-taken, never silently switched under the seller).
  const mkQuote = (c) => ({ reverse:true, offer:c.offer, market:q0.market, seq_amount:c.seq_amount,
    btc_amount:c.btc_amount, price_seq_per_btc:c.price_seq_per_btc, fee_btc:0n, expires_at_unix:c.expires_at_unix });
  const attempts = [q0, ...((q0.candidates || []).map(mkQuote))];

  for (let i = 0; i < attempts.length; i++){
    const q = attempts[i];
    const sm = C.assetMeta(q.market.seq_asset);
    // REVIEW == EXECUTION: for a courier lift, driveReverse pays (and we CLAIM) the FLOOR-proportional BTC for
    // the slice (proportionalBtcFloor), which is what the seller actually receives — NOT the composer's
    // ceil q.btc_amount (a partial can round them apart by up to 1 sat). Show the floor here so the confirm
    // matches settlement. (RFQ has no offer; its q.btc_amount is the daemon's authoritative quote — keep it.)
    const recvBtc = q.offer
      ? proportionalBtcFloor(big(offerField(q.offer, 'offer_amount', 'offerAmount')), big(q.seq_amount),
                             big(offerField(q.offer, 'want_amount', 'wantAmount', 'base_amount', 'baseAmount')))
      : big(q.btc_amount);
    const kv = [
      ...(i > 0 ? [['Heads up', `the previous maker didn’t respond; this is the next best resting offer (${i} of ${attempts.length - 1})`]] : []),
      ['You sell', C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker],
      ['You receive', C.fmtAtoms(recvBtc, 8) + ' BTC'],
      ['How it works', 'The maker locks the BTC first. Once it confirms, your wallet locks the asset, the maker takes it by revealing a secret, and your wallet uses that secret to claim the BTC - automatically. You only confirm here.'],
      ['You commit', 'your ' + sm.ticker + ' once the maker’s BTC lock confirms - until then nothing is spent'],
      ['If the maker stalls', 'your asset is refundable after the maker’s stated Sequentia timeout (the exact block is shown once the maker locks; the wizard offers the refund then, with a countdown)'],
      ['Settlement', 'the BTC you receive is anchor-bound to Bitcoin; it can revert only if Bitcoin itself reverts'],
      // The confirmation-wait class, stated BEFORE commit (task 21c) — same as the mixed rails' Speed row.
      ['Speed', 'Waits on Bitcoin confirmations · typically 10-60+ minutes on testnet4 · safe to leave, it resumes and refunds automatically.'],
    ];
    const { m: modal, ok, st } = C.modalRows({ title: 'Sell ' + sm.ticker + ' for BTC', kv });

    // Wait for the user's Confirm or Cancel on THIS attempt.
    const go = await new Promise((resolve) => {
      ok.onclick = () => { ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Starting the swap…'; resolve(true); };
      const no = modal.querySelector('.ghost'); if (no) no.onclick = () => { modal.remove(); resolve(false); };
    });
    if (!go) return;   // user cancelled — stop the whole flow

    try {
      modal.remove();
      LAST_RQUOTE = null;
      const r = await driveReverse(q);   // auto-drives; returns 'retry' iff no maker locked (pre-lock)
      if (r === 'retry'){
        if (i < attempts.length - 1){ C.toast && C.toast('That maker didn’t respond - showing the next best offer.'); continue; }
        if (C.$('xrswapErr')) C.$('xrswapErr').textContent = `No maker responded${attempts.length > 1 ? ` (tried ${attempts.length} offers)` : ''}. Nothing was spent - try again shortly.`;
      }
      return;   // committed / settled / terminal — done
    } catch (e){
      if (modal.isConnected){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
      else { renderStepper(); if (C.$('xrswapErr')) C.$('xrswapErr').textContent = 'Swap failed: ' + C.prettyErr(e); }
      return;   // a thrown error is terminal (post-lock) — never auto-retry after a lock
    }
  }
}

// ---------------------------------------------------------------------------
// Courier auto-driver: one user confirmation, then the whole reverse handshake
// runs to settlement, updating the live stepper at each step. The COURIER carries
// only the negotiation + leg exchange; every value transfer is a client-side HTLC
// settlement (unchanged), and the revealed secret is read OFF-CHAIN, so no courier
// message is ever trusted with funds.
// ---------------------------------------------------------------------------
function setPhase(phase, detail){ if (SWAP){ SWAP.phase = phase; if (detail !== undefined) SWAP.detail = detail; saveSwap(); renderStepper(); } }

async function driveReverse(q){
  const btcClaim = C.btcLeg.claimKey();     // taker claims the maker BTC leg with the preimage
  const seqRefund = C.seqLeg.refundKey();   // taker refunds the asset leg after T_seq

  // The slice we SELL = the composer-requested amount (== the whole offer for a whole-HTLC lift). Read the
  // whole-offer amounts from the SIGNED offer we chose: a reverse offer has offer_asset='BTC'
  // (offer_amount = whole BTC the maker gives) and want/base = the whole asset it buys. Price OUR slice at
  // the offer's OWN ratio, FLOOR (the maker gives the BTC, so floor is the maker's favour) — the SAME
  // value the maker recomputes and funds its BTC leg to (xdriver_reverse.go:144,535). We SHIP the slice in
  // the TermsRequest so the maker sizes its BTC leg to it BEFORE funding (the maker funds BTC first).
  const oSeq = big(offerField(q.offer, 'want_amount', 'wantAmount', 'base_amount', 'baseAmount'));
  const oBtc = big(offerField(q.offer, 'offer_amount', 'offerAmount'));
  const takeSeq = big(q.seq_amount);
  const wantBtc = proportionalBtcFloor(oBtc, takeSeq, oSeq);
  // Fail CLOSED before opening a session (nothing spent): a non-positive/over-ask slice, or one that prices
  // to 0 sats, can't be fixed by another maker — surface it and stop rather than 'retry' down the book.
  if (oSeq <= 0n || oBtc <= 0n || takeSeq <= 0n || takeSeq > oSeq || wantBtc <= 0n){
    try { C.toast && C.toast('That sell amount does not fit this offer - nothing was spent.'); } catch {}
    return;
  }
  // MIN-SLICE DUST GUARD (mirror xminslice.go / xdriver_reverse.go:152,216): fail CLOSED, PRE-FUND, when this
  // partial's BTC leg (wantBtc, the floor BTC we will CLAIM) or the asset leg we FUND (takeSeq atoms) is
  // sub-dust AFTER the HTLC spend fee. We fund the asset FIRST here, so refuse BEFORE opening the session —
  // nothing is spent. A whole take is exempt. Like the checks above, a too-small size can't be fixed by
  // another maker, so surface it and stop (never 'retry' down the book).
  const _dust = minSafeBtcReason(takeSeq, oSeq, wantBtc, DEFAULT_SPEND_FEE_SATS)
             || minSafeAssetReason(q.market.seq_asset, takeSeq, oSeq, takeSeq, DEFAULT_SPEND_FEE_SATS);
  if (_dust){
    // Nothing of this attempt's is committed yet (no session opened, no SWAP created), so surface the reason
    // and stop — do NOT mutate any existing SWAP record here.
    if (C.$('xrswapErr')) C.$('xrswapErr').textContent = _dust + ' - nothing was spent.';
    try { C.toast && C.toast('That sell amount is too small to settle safely - nothing was spent.'); } catch {}
    return;
  }

  // 1. Open the courier session + get the maker's BTC lock. A failure HERE — the session won't open, or
  //    the maker never sends its BtcLegLocked within the fail-fast window — means NO maker committed any
  //    BTC, so return 'retry': onOpen can offer the next resting offer (T4). Once a leg IS received we
  //    are past this point and every later failure is terminal for THIS swap (the maker locked BTC; we
  //    never silently retry and strand it), handled by failAbort/return below exactly as before.
  let session;
  try { session = await (C.openCourierSession || xcourier.openCourierSession)(q.offer, takeSeq, '', {}); }
  catch { return 'retry'; }
  let locked;
  try {
    await session.send({
      type: xcourier.XcType.TermsRequest,
      taker_seq_refund_pub: seqRefund.public_key,
      taker_btc_claim_pub: btcClaim.public_key,
      // The slice we sell (the maker sizes its BTC leg to it). JSON NUMBER to match the Go uint64 field
      // (json.Unmarshal rejects a quoted string into uint64). 0/whole => the maker takes the whole offer.
      seq_amount: Number(takeSeq),
    });
    // 2. The maker locks BTC first and sends terms + the BTC leg. Fail-fast (was 60s): a live maker
    //    locks within seconds, so 30s => move to the next resting offer instead of a long stall.
    locked = await session.recv(xcourier.XcType.BtcLegLocked, 30000);
  } catch { try { session.close(); } catch {} return 'retry'; }

  try {
    const leg = locked.leg || {};
    const tBtc = num(leg.locktime) || num(locked.btc_locktime);
    const tSeq = num(locked.seq_locktime);
    const mBtcAmount = big(pick(locked, 'btc_amount', 'btcAmount'));   // the maker's quoted BTC for our slice
    const mSeqAmount = big(pick(locked, 'seq_amount', 'seqAmount'));   // the slice size the maker sized to

    // 3. Build the swap and BIND the maker's terms to the SLICE we asked for (slice-vs-slice).
    SWAP = {
      reverse: true, courier: true, state: ST.BTC_LOCKED, created: Date.now(), phase: 'opening',
      market: { btc_asset: q.market.btc_asset, seq_asset: q.market.seq_asset, name: q.market.name },
      offer_id: q.offer.offer_id || q.offer.offerId,
      maker_pubkey: q.offer.maker_pubkey || q.offer.makerPubkey,
      hash_hex: locked.hash_h,
      maker_seq_claim_pub: locked.maker_seq_claim_pub,
      maker_btc_refund_pub: locked.maker_refund_pub,
      taker_btc_claim_pub: btcClaim.public_key,
      taker_btc_claim_secret: btcClaim.secret_hex,
      taker_seq_refund_pub: seqRefund.public_key,
      taker_seq_refund_secret: seqRefund.secret_hex,
      btc_locktime: tBtc, seq_locktime: tSeq,
      seq_amount: takeSeq, btc_amount: wantBtc,
      fee_btc: big(locked.fee_btc || 0),
      btc_leg: {
        txid: leg.txid, vout: num(leg.vout), height: 0,
        redeem_script: leg.redeem_script, amount: big(leg.amount), asset_id: '',
      },
      btc_leg_height: 0,
    };
    // Reject bad terms BEFORE funding: the maker must PAY exactly the proportional BTC (floor) for our
    // slice — in the terms field AND the funded leg — and size the trade to takeSeq. Binding to
    // wantBtc/takeSeq (not the whole offer) is what makes the partial fund-safe: we deliver takeSeq of the
    // asset only against a BTC leg of exactly the proportional value (mirrors xdriver_reverse.go:182-189).
    // Then the script must recompute and the timelocks must be sane. Nothing is spent on abort.
    if (mBtcAmount !== wantBtc || big(leg.amount) !== wantBtc){ await failAbort(session, 'terms_mismatch', 'the maker did not lock the proportional BTC for your slice - nothing was spent'); return; }
    if (mSeqAmount !== takeSeq){ await failAbort(session, 'terms_mismatch', 'the maker sized the trade differently from your slice - nothing was spent'); return; }
    const v = await verifyMakerBtcLeg();
    if (!v.ok){ await failAbort(session, 'btc_leg_invalid', v.reason + ' - nothing was spent'); return; }
    setPhase('await_btc_conf');
    C.toast && C.toast('Maker locked the BTC leg - waiting for it to confirm.');

    // 4. Wait for the maker's BTC leg to confirm on our OWN node before we fund
    //    the asset (so the Sequentia leg anchors at/above it).
    let h = await waitMakerBtcConf(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script, tBtc);
    if (h == null) return;   // aborted (T_btc passed with no conf; nothing of ours spent)
    SWAP.btc_leg_height = h; SWAP.btc_leg.height = h; setPhase('funding');

    // 4b. ANCHOR PRECONDITION — we are the asset GIVER, so the MAKER's gate is the
    //     one our funding has to satisfy: the Sequentia block that confirms it must
    //     anchor at or above the maker's BTC-leg height, and that number is frozen
    //     the moment the funding confirms (it is a committed block-header field, so
    //     a wait AFTERWARDS can never clear it). Wait for our own node's LIVE anchor
    //     to get there first; anchors never go backwards along a chain, so every
    //     block extending this tip qualifies and the maker's gate passes first time.
    //     Waiting here is free — nothing of ours has moved, and if we stop the maker
    //     simply refunds its BTC after T_btc. The wait ends only at the timelock (or
    //     when the user cancels), never on a wall clock.
    // 4c (with 4b): the anchor wait and a FULL re-verify, repeated while the leg
    //     RE-MINES. The wait is bounded by the timelock, not a clock, so it can run
    //     long — and a BTC HTLC that was confirmed when we checked can be GONE by
    //     the end of it: one parent-chain reorg is all the maker needs to
    //     double-spend the input it funded with. Funding our asset against a dead
    //     BTC leg is the one-sided loss this whole gate exists to prevent, so check
    //     again immediately before we spend, and a leg that no longer verifies is a
    //     refusal. A leg that merely MOVED to a different block is NOT dead — the
    //     check just proved the same outpoint and amount at its new height (a
    //     bursty parent chain re-mines the last block or two on every fork
    //     resolution, and refusing on the move alone killed three healthy takes in
    //     a row at this exact line). The move DOES invalidate the anchor
    //     precondition, so re-run the wait against the height the leg actually
    //     sits at, then verify again — bounded by the timelock window plus a
    //     re-mine cap (the Go drivers carry the twin loop).
    for (let remines = 0; ; remines++){
      const bad = await awaitAnchorReachesBtcLeg(h + 1);
      if (bad){ await failAbort(session, 'anchor_not_caught_up', bad); return; }
      let f2 = null;
      try { f2 = await C.btcLeg.findFunding(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script); } catch { f2 = null; }
      if (!f2 || !f2.confirmed || BigInt(f2.value) < BigInt(SWAP.btc_amount)){
        await failAbort(session, 'btc_leg_gone', 'the maker’s BTC lock is no longer on chain with the agreed amount - your asset was NOT funded, nothing of yours was spent');
        return;
      }
      const closed = await fundWindowClosed();
      if (closed){ await failAbort(session, 'seq_window_closed', closed); return; }
      if (Number(f2.height) === h) break;
      if (remines >= 10){
        await failAbort(session, 'btc_leg_gone', `the maker’s BTC lock kept moving between blocks (last ${h} → ${f2.height}) - your asset was NOT funded, nothing of yours was spent`);
        return;
      }
      setWaitNote(`The maker's BTC lock moved from block ${h} to ${f2.height} (a Bitcoin fork resolution) - it still verifies, so waiting for the anchor to clear the new height…`);
      h = Number(f2.height);
      SWAP.btc_leg_height = h; SWAP.btc_leg.height = h; saveSwap();
    }

    // 5. Fund our asset leg (real money moves here — the single consent above
    //    covered it) and announce it to the maker over the courier.
    const redeem = C.wasm.buildSeqHtlcRedeemScript(SWAP.hash_hex, SWAP.maker_seq_claim_pub, SWAP.taker_seq_refund_pub, SWAP.seq_locktime);
    SWAP.seq_redeem = redeem; saveSwap();
    let fundTxid = SWAP.seq_fund_txid;
    if (!fundTxid){ fundTxid = (await C.seqLeg.fund(redeem, SWAP.market.seq_asset, SWAP.seq_amount)).txid; SWAP.seq_fund_txid = fundTxid; saveSwap(); }
    const conf = await C.seqLeg.waitConf(fundTxid, redeem);
    SWAP.seq_leg = { txid: fundTxid, vout: conf.vout, redeem_script: redeem, amount: SWAP.seq_amount, asset_id: SWAP.market.seq_asset, block_hash: conf.block_hash, height: conf.height };
    SWAP.state = ST.SEQ_SUBMITTED; setPhase('await_reveal');
    // POST-FUNDING CHECK, and an ASSERTION rather than a log line. The precondition
    // above makes this hold by construction on the honest path, but a Sequentia
    // reorg can still land our funding on a lower-anchored branch — and that is
    // exactly the leg that could outlive the maker's BTC leg, i.e. our own money.
    // If it did, do NOT invite the claim.
    //
    // What withholding buys, and what it does not: it is a COURTESY. The maker
    // minted the secret and holds our refund pubkey, so it can rebuild this redeem
    // script and find the P2SH on chain without any message from us. The real
    // defences are the precondition above (we do not fund early) and the maker's
    // own gate (it refuses on its own node's reading). What we get here is that an
    // HONEST maker is told plainly not to claim, and our T_seq refund stays clean.
    //
    // Note this also puts the leg's REAL anchor height on the wire: the old code
    // sent `anchor_height: conf.height`, which is the Sequentia block HEIGHT — a
    // completely different number from its Bitcoin anchor.
    // Re-derived from the leg's TXID (not the cached conf.block_hash) and counted
    // only when the confirming block is on the ACTIVE chain — see legAnchorEvidence.
    const ev = await legAnchorEvidence(SWAP.seq_leg ? SWAP.seq_leg.txid : null, conf.block_hash);
    const legAnchor = (ev.anchor >= 0 && ev.onActiveChain) ? ev.anchor : null;
    if (legAnchor == null || legAnchor < h){
      SWAP.detail = `your asset leg landed in Sequentia block ${conf.block_hash}, which anchors at ${legAnchor == null ? 'an unreadable height' : legAnchor} - below the maker's BTC lock at ${h}. It was NOT offered to the maker; you reclaim it after block ${SWAP.seq_locktime}.`;
      saveSwap();
      try { await session.fail('seq_leg_underanchored', 'our asset leg confirmed under-anchored; do NOT claim it (we refund it after T_seq) - refund your BTC after T_btc'); } catch {}
      renderStepper();
      if (C.$('xrswapErr')) C.$('xrswapErr').textContent = SWAP.detail;
      return;   // the refund off-ramp keys on seq_leg, which is set: the asset is recoverable
    }
    await session.send({ type: xcourier.XcType.SeqLegFunded, leg: {
      txid: SWAP.seq_leg.txid, vout: SWAP.seq_leg.vout, amount: Number(SWAP.seq_amount),
      asset: SWAP.market.seq_asset, redeem_script: redeem, locktime: SWAP.seq_locktime,
      block_hash: conf.block_hash, anchor_height: legAnchor,
    }});
    C.toast && C.toast('Asset leg funded - waiting for the maker to reveal the secret.');

    // 6. Fast path: the maker may courier a courtesy secret_revealed after it
    //    claims. Accept it only if it hashes to H (else it is worthless). The
    //    authoritative source is the on-chain read in driveSettle, so a withheld
    //    or bogus message costs us nothing.
    try {
      const rev = await session.recv(xcourier.XcType.SecretRevealed, 20000);
      if (rev && rev.preimage && sha256Hex(rev.preimage) === String(SWAP.hash_hex).toLowerCase()){ SWAP.preimage = rev.preimage; saveSwap(); }
    } catch { /* on-chain read will find it */ }
  } finally {
    session.close();
  }

  // 7. Settle on-chain (courier no longer needed): read the revealed secret from
  //    the maker's claim and claim the BTC leg. Resumable across reloads.
  driveSettle();
}

// failAbort: courier a fail note, mark the swap failed, surface it, and render.
async function failAbort(session, code, msg){
  try { await session.fail(code, msg); } catch {}
  if (SWAP){ SWAP.state = ST.FAILED; SWAP.detail = msg; saveSwap(); }
  renderStepper();
  if (C.$('xrswapErr')) C.$('xrswapErr').textContent = msg;
}

// Task 21a — block-aware conf-wait narrative, cached ~30s. Unreadable -> null, and the caller
// simply omits the block-age clause (elapsed-only) rather than fabricating a figure.
//
// The age is measured from when THIS wallet last OBSERVED the tip height change, not from the
// miner's header timestamp: testnet4 miners date headers up to ~2h in the FUTURE (the 20-minute
// min-difficulty rule rewards it), so wall-clock minus header time is routinely negative and the
// old Math.max(0, …) clamp printed a constant "0 min ago" for the whole wait. Until a change has
// been observed (the first read is a baseline, not an arrival), fall back to the header timestamp
// only when it computes to a sane [0, 180]-minute age; otherwise say nothing.
let _blkAge = { at: 0, min: null };
const _tipWatch = { height: -1, sinceMs: 0, seenChange: false };
async function btcLastBlockAgeMin(){
  if (Date.now() - _blkAge.at < 30000) return _blkAge.min;
  let min = null;
  try {
    const base = (typeof location !== 'undefined' ? location.origin : '') + '/testnet4/api';
    const r = await fetch(base + '/blocks/tip/height', { signal: AbortSignal.timeout(6000) });
    if (r.ok){
      const h = Number((await r.text()).trim());
      if (Number.isFinite(h) && h > 0){
        if (_tipWatch.height >= 0 && h > _tipWatch.height){ _tipWatch.sinceMs = Date.now(); _tipWatch.seenChange = true; }
        else if (_tipWatch.height < 0){ _tipWatch.sinceMs = Date.now(); }
        if (h > _tipWatch.height) _tipWatch.height = h;
      }
    }
    if (_tipWatch.seenChange){
      min = Math.max(0, Math.round((Date.now() - _tipWatch.sinceMs) / 60000));
    } else {
      const r2 = await fetch(base + '/blocks', { signal: AbortSignal.timeout(6000) });
      if (r2.ok){
        const arr = await r2.json();
        const ts = Array.isArray(arr) && arr[0] && Number(arr[0].timestamp);
        if (ts > 0){
          const m = Math.round((Date.now() / 1000 - ts) / 60);
          if (m >= 0 && m <= 180) min = (m || 0);   // || 0 normalises Math.round's -0
        }
      }
    }
  } catch {}
  _blkAge = { at: Date.now(), min };
  return min;
}
// waitMakerBtcConf polls our own node for the maker's BTC-leg confirmation.
// Returns the confirmation height, or null if T_btc passed first (abort — we
// never funded our asset, so nothing of ours is at risk).
async function waitMakerBtcConf(txid, redeemHex, tBtc){
  const t0 = Date.now();
  for (let i = 0; i < 600; i++){
    if (!SWAP || SWAP.state === ST.FAILED) return null;
    try { if (SWAP){ SWAP.drive_beat_ms = Date.now(); saveSwap(); } } catch {}   // liveness heartbeat (see resumeFundingPhase)
    // Live block-aware wait line (task 21a) on the stepper's status slot.
    try {
      const el = C.$('xrStepStatus');
      if (el){
        const age = await btcLastBlockAgeMin();
        const mins = Math.round((Date.now() - t0) / 60000);
        el.className = 'status';
        el.innerHTML = '<span class="spin"></span>Waiting for 1 Bitcoin confirmation of the maker’s lock · usually ~20m on testnet4'
          + (age != null ? ' · last block ' + age + ' min ago' : '')
          + (mins > 0 ? ' · ' + mins + ' min elapsed' : '');
      }
    } catch {}
    try {
      const f = await C.btcLeg.findFunding(txid, redeemHex);
      if (f && f.confirmed && f.height > 0){
        // FUND-SAFETY: verify the ACTUAL on-chain output value meets the agreed amount before we
        // fund our asset leg. verifyMakerBtcLeg only checked the maker-REPORTED btc_leg.amount; a
        // maker can report the agreed amount yet lock LESS on-chain. Since this runs BEFORE we fund,
        // an underfunded leg aborts with nothing of ours spent.
        if (BigInt(f.value) < BigInt(SWAP.btc_amount)){
          SWAP.state = ST.FAILED;
          SWAP.detail = `the maker's on-chain BTC lock (${f.value} sats) is less than the agreed ${SWAP.btc_amount} - nothing of yours was spent`;
          saveSwap(); renderStepper();
          return null;
        }
        if (SWAP.btc_leg){ SWAP.btc_leg.vout = f.vout; SWAP.btc_leg.amount = BigInt(f.value); }
        return f.height;
      }
    } catch { /* transient; keep polling */ }
    await new Promise(r => setTimeout(r, 8000));
  }
  SWAP.state = ST.FAILED; SWAP.detail = 'the maker’s BTC lock did not confirm in time - nothing of yours was spent'; saveSwap(); renderStepper();
  return null;
}

// driveSettle: the courier-independent tail. Poll for the revealed secret (fast
// path SWAP.preimage, else read it off the maker's on-chain asset-leg claim),
// then claim the BTC leg. Also the RESUME entrypoint after a reload once the
// asset leg is funded. Idempotent + re-entrancy-guarded.
async function driveSettle(){
  if (SETTLING) return;
  if (!SWAP || !SWAP.courier || !SWAP.seq_leg) return;
  if (SWAP.state === ST.BTC_CLAIMED || SWAP.state === ST.REFUNDED || SWAP.btc_claim_txid) return;
  SETTLING = true;
  stopPoll();
  POLL = setInterval(async () => {
    try {
      if (!SWAP || SWAP.btc_claim_txid || SWAP.state === ST.REFUNDED){ stopPoll(); SETTLING = false; return; }
      if (!SWAP.preimage){
        const pre = await readPreimageOnChain(SWAP.seq_leg.txid, SWAP.seq_leg.vout, SWAP.hash_hex);
        if (pre){ SWAP.preimage = pre; SWAP.state = ST.SEQ_CLAIMED; saveSwap(); renderStepper(); }
      }
      if (SWAP.preimage && !SWAP.btc_claim_txid){
        try { await claimBtc(); } catch (e){ if (C.$('xrswapErr')) C.$('xrswapErr').textContent = 'BTC claim retrying: ' + C.prettyErr(e); }
      }
      if (SWAP && SWAP.btc_claim_txid){ stopPoll(); SETTLING = false; renderStepper(); }
    } catch { /* transient; keep polling */ }
  }, 5000);
}

// ---- resume: recover an asset leg that was broadcast before a reload ----
// The COURIER funds the asset leg inline in driveReverse; this is only the
// recovery path for a wallet that died between broadcasting the funding and
// recording its confirmation. It never funds anything: it reuses the persisted
// seq_fund_txid, waits for the confirmation, records the leg (which is what the
// refund off-ramp keys on), and hands over to the on-chain settle driver.
//
// There is deliberately no re-announce: the courier session is gone and its keys
// were per-session. The maker either already saw the leg, or it did not and we
// refund after T_seq. Nothing here can be "submitted" to a daemon — that rail is
// retired.
// ---- resume: re-drive the PRE-FUNDING phase after the take's linear driver died ----
// The take runs conf-wait -> anchor gate -> fund in ONE async function armed only at
// Place time. A renderer freeze, an uncaught throw or a reload during those waits
// leaves a healthy, claimable maker lock with NOTHING driving our side: the record
// sat in BTC_LOCKED/'funding' for two hours live while the maker's settler would
// have claimed the moment we funded. Everything the funding needs was persisted at
// take time, and the announce is a courtesy (the maker rebuilds our redeem script
// itself — see the post-funding note in driveReverse), so this needs no courier.
//
// LIVENESS: only steps in when the linear driver's heartbeat (drive_beat_ms, stamped
// by every wait iteration) has been quiet for 90s — a driver that is merely waiting
// beats every poll, so the two can never race a double-fund; belt-and-braces, the
// fund is also adopt-first (findFundingByAddress) and keyed on seq_fund_txid.
let RESUMING_FUND = false;
async function resumeFundingPhase(){
  if (RESUMING_FUND) return;
  if (!SWAP || SWAP.state !== ST.BTC_LOCKED || SWAP.seq_fund_txid || SWAP.seq_leg) return;
  if (!(SWAP.btc_leg && SWAP.btc_leg.txid && SWAP.hash_hex && SWAP.maker_seq_claim_pub
        && SWAP.taker_seq_refund_pub && SWAP.seq_locktime && SWAP.market && SWAP.market.seq_asset)) return;
  const lastBeat = Math.max(Number(SWAP.drive_beat_ms || 0), Number(SWAP.stage_since_ms || 0));
  if (Date.now() - lastBeat < 90 * 1000) return;   // the take's own driver is (or may be) alive — let it drive
  RESUMING_FUND = true;
  try {
    setPhase('funding');
    // Verify the maker's lock NOW and adopt the height it ACTUALLY sits at — a
    // re-mined leg is not a dead leg (twin of the take path's re-mine loop).
    for (let remines = 0; ; remines++){
      let f = null;
      try { f = await C.btcLeg.findFunding(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script); } catch { f = null; }
      if (!f || !f.confirmed || !(Number(f.height) > 0) || BigInt(f.value) < BigInt(SWAP.btc_amount)){
        SWAP.detail = 'the maker’s BTC lock is not (or no longer) confirmed on chain with the agreed amount - nothing of yours was spent. If it never confirms, abandon this trade.';
        saveSwap(); renderStepper(); return;
      }
      const h = Number(f.height);
      SWAP.btc_leg_height = h; SWAP.btc_leg.height = h; saveSwap();
      const bad = await awaitAnchorReachesBtcLeg(h + 1);
      if (bad){ SWAP.detail = bad; saveSwap(); renderStepper(); return; }   // window closed; nothing spent
      let f2 = null;
      try { f2 = await C.btcLeg.findFunding(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script); } catch { f2 = null; }
      if (f2 && f2.confirmed && BigInt(f2.value) >= BigInt(SWAP.btc_amount) && Number(f2.height) === h) break;
      if (remines >= 10){
        SWAP.detail = 'the maker’s BTC lock keeps moving between blocks - nothing of yours was spent.';
        saveSwap(); renderStepper(); return;
      }
    }
    const closed = await fundWindowClosed();
    if (closed){ SWAP.detail = closed; saveSwap(); renderStepper(); return; }
    const redeem = SWAP.seq_redeem || C.wasm.buildSeqHtlcRedeemScript(SWAP.hash_hex, SWAP.maker_seq_claim_pub, SWAP.taker_seq_refund_pub, SWAP.seq_locktime);
    SWAP.seq_redeem = redeem; saveSwap();
    // Adopt-first: never fund what is already funded (a lost broadcast response, or
    // the dead driver got further than its record shows).
    let txid = SWAP.seq_fund_txid;
    if (!txid){ try { const found = await C.seqLeg.findFundingByAddress(redeem); if (found && found.txid) txid = found.txid; } catch {} }
    if (!txid) txid = (await C.seqLeg.fund(redeem, SWAP.market.seq_asset, SWAP.seq_amount)).txid;
    SWAP.seq_fund_txid = txid; saveSwap(); renderStepper();
    await resumeSeqLeg();     // waits the confirmation + records seq_leg (the refund off-ramp's key)
    driveSettle();            // watch for the maker's claim -> take the revealed secret -> claim the BTC
  } catch (e){
    try { console.warn('[xr] resumeFundingPhase:', e); } catch {}
    if (SWAP && !SWAP.detail){ SWAP.detail = 'resuming this trade hit an error - it will retry on the next visit: ' + (C.prettyErr ? C.prettyErr(e) : String(e)); saveSwap(); }
  } finally { RESUMING_FUND = false; try { renderStepper(); } catch {} }
}

async function resumeSeqLeg(){
  if (!SWAP) throw new Error('no in-flight swap');
  if (SWAP.seq_leg && SWAP.seq_leg.txid) return SWAP;
  const txid = SWAP.seq_fund_txid;
  if (!txid) throw new Error('nothing to resume: the asset leg was never broadcast');
  const redeem = SWAP.seq_redeem;
  if (!redeem) throw new Error('nothing to resume: the asset-leg script was not persisted');
  const conf = await C.seqLeg.waitConf(txid, redeem);
  SWAP.seq_leg = {
    txid, vout: conf.vout, redeem_script: redeem,
    amount: SWAP.seq_amount, asset_id: SWAP.market.seq_asset,
    block_hash: conf.block_hash, height: conf.height,
  };
  SWAP.state = ST.SEQ_SUBMITTED;
  saveSwap();
  return SWAP;
}

// ---- step 5/6: poll for the revealed secret, then claim the BTC leg ----
async function claimBtc(){
  if (CLAIMING) return;
  if (!SWAP || !SWAP.preimage || !SWAP.btc_leg) return;
  if (SWAP.btc_claim_txid) return;
  CLAIMING = true;
  try {
    const txid = await C.btcLeg.claim({
      txid: SWAP.btc_leg.txid, vout: SWAP.btc_leg.vout,
      amount: SWAP.btc_leg.amount, redeem_script: SWAP.btc_leg.redeem_script,
      preimage: SWAP.preimage,
    });
    SWAP.btc_claim_txid = txid;
    SWAP.state = ST.BTC_CLAIMED;
    SWAP.detail = '';
    saveSwap();
    C.toast && C.toast('BTC leg claimed - swap complete:', { href:'/testnet4/tx/'+txid, label:String(txid).slice(0,18)+'…' });
    C.sync && C.sync().catch(()=>{});   // refresh balances (we received BTC, spent the asset)
  } finally { CLAIMING = false; }
}
async function onClaimBtc(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  try { await claimBtc(); renderStepper(); }
  catch (e){ if ($('xrswapErr')) $('xrswapErr').textContent = 'BTC claim failed: ' + C.prettyErr(e); }
}

function stopPoll(){ if (POLL){ clearInterval(POLL); POLL = null; } }

// CLTV-gate the asset-leg refund by the SEQUENTIA tip: the refund tx is non-final (rejected) until the
// tip reaches seq_locktime. Disable with a live countdown until mature; enable once mature. Fail OPEN if
// the tip is unreadable (the on-chain spend still rejects a premature refund, so the user isn't blocked).
async function gateSeqRefundByCltv(btn, locktime){
  let tip = 0; try { tip = C.wollet ? Number(C.wollet.tip().height()) : 0; } catch {}
  if (!btn.isConnected) return;
  const remain = Number(locktime) - tip;
  if (!tip || remain <= 0){ btn.disabled = false; btn.title = 'Reclaim your locked asset (the refund timelock has matured).'; }
  else { btn.disabled = true; btn.title = `Refund unlocks at Sequentia block ${locktime}, about ${remain} more block${remain === 1 ? '' : 's'} away (~${remain} min).`; }
}
// ---- step 7: refund off-ramp (the asset leg, after T_seq) ----
async function onRefundSeq(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  if (!SWAP || !SWAP.seq_leg){ if ($('xrswapErr')) $('xrswapErr').textContent = 'no asset leg to refund'; return; }
  const sm = C.assetMeta(SWAP.market.seq_asset);
  const kv = [
    ['Network', '⚠ Sequentia: refunding YOUR funded asset leg via the CLTV branch'],
    ['Refund amount', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker + ' (minus the refund fee)'],
    ['Valid after', 'block ' + SWAP.seq_locktime],
    ['Note', 'Only do this if the maker stalled and never took your asset leg (otherwise the secret is already out and you should claim the BTC instead).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Refund the asset leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding the asset leg…';
    try {
      // Defence in depth: the refund is non-final until the Sequentia tip reaches seq_locktime.
      let _tip = 0; try { _tip = C.wollet ? Number(C.wollet.tip().height()) : 0; } catch {}
      if (_tip && _tip < Number(SWAP.seq_locktime)){
        st.className = 'status err';
        st.textContent = `Not yet · the refund unlocks at Sequentia block ${SWAP.seq_locktime}, about ${Number(SWAP.seq_locktime) - _tip} block(s) away.`;
        ok.disabled = false; return;
      }
      // The refund tx pays its fee IN THE LOCKED ASSET (the HTLC holds only that asset — which could be
      // tSEQ or any other issued asset). Size it as the node's ABSTRACT REFERENCE feerate expressed in
      // THIS asset via its published rate, so every asset (tSEQ included) is treated the same. A valuable
      // asset needs very few atoms; a naive flat atom count would be a huge reference-value fee the node
      // rejects ("Fee exceeds maximum ... maxfeerate").
      let fee = 1;
      try {
        const asset = SWAP.market.seq_asset;
        const rate = Number(C.feeRateFor(asset));   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
        const refFee = Math.ceil(C.DEFAULT_FEERATE * 350 / 1000);   // reference-unit fee for a ~350-vB refund tx
        fee = Math.max(1, Math.ceil(refFee * C.EXCHANGE_RATE_SCALE / rate));
      } catch {}
      { const amt = Number(SWAP.seq_amount); if (fee > Math.floor(amt/2)) fee = Math.max(1, Math.floor(amt/2)); }
      const txid = await C.seqLeg.refund({
        txid: SWAP.seq_leg.txid, vout: SWAP.seq_leg.vout, amount: SWAP.seq_amount,
        asset_id: SWAP.market.seq_asset, redeem_script: SWAP.seq_leg.redeem_script,
        locktime: SWAP.seq_locktime, refund_secret: SWAP.taker_seq_refund_secret,
        dest_spk: takerDestSpkHex(), fee,
      });
      SWAP.state = ST.REFUNDED; SWAP.seq_refund_txid = txid;
      SWAP.detail = 'asset leg refunded by you'; saveSwap();
      modal.remove(); renderStepper();
      C.toast && C.toast(`Asset leg refunded: ${String(txid).slice(0,18)}…`);
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}
// A fresh wallet receive-address scriptPubKey, unconfidential, as hex (refund dest).
function takerDestSpkHex(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const unconf = a.toUnconfidential ? a.toUnconfidential() : a;
  const bytes = unconf.scriptPubkey().bytes();
  return [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
}

function onAbandon(){
  loadSwap();
  // NEVER discard a reverse swap that still holds (or MIGHT hold) a locked ASSET leg: clearSwap()
  // drops the reclaim material (the seq_leg outpoint OR the seq_redeem + taker_seq_refund_secret needed
  // to re-derive the CLTV refund), stranding it. Key on seq_redeem, not just seq_leg: seq_redeem is
  // persisted the SAME synchronous tick BEFORE seqLeg.fund broadcasts, so if fund() throws AFTER the
  // node accepted the tx (a lost response), the asset is locked on-chain yet seq_fund_txid/seq_leg are
  // never set — the old seq_leg-only guard let Abandon delete the refund key and the maker sweep the
  // asset. renderReverse's seq_redeem recovery below resolves funded-vs-not; until then, keep the record.
  const lockedUnrefunded = !!(SWAP && ((SWAP.seq_leg && SWAP.seq_leg.txid) || (SWAP.seq_redeem && SWAP.taker_seq_refund_secret)))
    && !SWAP.btc_claim_txid && SWAP.state !== ST.REFUNDED && SWAP.state !== ST.BTC_CLAIMED;
  if (lockedUnrefunded){
    const why = 'Your asset may still be locked in this swap. Refund it (after the timeout) before clearing — otherwise the reclaim data is lost.';
    // Say it WHERE the button is, not only in a transient toast: a clicked Abandon that
    // visibly does nothing is indistinguishable from a broken button (watched live — the
    // refusal toast had already faded and the button just… sat there).
    try { const e = C.$ && C.$('xrswapErr'); if (e) e.textContent = why; } catch {}
    try { C.toast && C.toast(why); } catch {}
    return;
  }
  stopPoll(); clearSwap(); renderStepper();
  if (C.onExit) C.onExit();
}

// ---- stepper rendering ----
function badge(state){
  const map = {
    [ST.QUOTED]:       ['Quoted', 'b-out'],
    [ST.BTC_LOCKED]:   ['BTC locked', 'b-out'],
    [ST.SEQ_SUBMITTED]:['Asset submitted', 'b-out'],
    [ST.SEQ_CLAIMED]:  ['Secret revealed', 'b-in'],
    [ST.BTC_CLAIMED]:  ['Complete', 'b-in'],
    [ST.REFUNDED]:     ['Refunded', 'b-out'],
    [ST.FAILED]:       ['Failed', 'b-out'],
  };
  return map[state] || ['-', 'b-out'];
}
function renderStepper(){
  const { $, el } = C;
  const wrap = $('xrStepper'); if (!wrap) return;
  if (!SWAP){ wrap.classList.add('hide'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hide');
  wrap.innerHTML = '';

  const sm = C.assetMeta(SWAP.market.seq_asset);
  const [blabel, bcls] = badge(SWAP.state);

  // W6: once the sell finishes (BTC claimed), record a receipt in the shared completed-trade history
  // so it shows in the Active-trades card. logTrade dedups by id, so a re-render logs exactly once.
  if (SWAP.state === ST.BTC_CLAIMED && C.logTrade){
    // Enriched receipt (P5.1): cross-chain SELL — asset paid, BTC claimed. base = asset, quote = BTC.
    const xsSeqU = (() => { try { return Number(big(SWAP.seq_amount || 0)) / Math.pow(10, sm.precision || 0); } catch { return null; } })();
    const xsBtcU = (() => { try { return Number(big(SWAP.btc_amount || 0)) / 1e8; } catch { return null; } })();
    C.logTrade({ id: 'xsell:' + (SWAP.session_id || SWAP.hash_hex || SWAP.btc_claim_txid || ''),
      title: 'Sold ' + C.fmtAtoms(SWAP.seq_amount || 0, sm.precision) + ' ' + sm.ticker + ' for BTC (cross-chain)',
      status: 'complete', txid: SWAP.btc_claim_txid || null, rail: 'cross',
      pair: (sm.ticker || 'asset') + '/BTC', side: 'sell', size: xsSeqU, sizeTicker: sm.ticker || null,
      price: (xsBtcU != null && xsSeqU > 0) ? xsBtcU / xsSeqU : null,
      // Task 21b: genuine settlement -> settle card; the BTC claim tx lives on testnet4.
      card: true, parentTxids: SWAP.btc_claim_txid ? [SWAP.btc_claim_txid] : [],
      elapsed_ms: (SWAP.started_ms > 0) ? (Date.now() - SWAP.started_ms) : null });
  }

  const head = el('div','card');
  const hr = el('div','row');
  hr.appendChild(el('label','lbl', 'Cross-chain sell (asset → BTC)'));
  const b = el('span','badge ' + bcls, blabel); b.style.marginLeft = 'auto'; hr.appendChild(b);
  head.appendChild(hr);
  head.appendChild(kvRow('Selling', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker));
  head.appendChild(kvRow('Receiving', C.fmtAtoms(SWAP.btc_amount, 8) + ' BTC'));
  head.appendChild(kvRow('Timeouts', `T_btc=${SWAP.btc_locktime} · T_seq=${SWAP.seq_locktime}`));
  head.appendChild(kvRow('Hashlock H', short(SWAP.hash_hex)));
  // Per-stage progress narrative (task 21a); only while the swap is still running. Elapsed
  // reads the stamp saveSwap writes on each state/phase transition.
  if (![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state) && SWAP.stage_since_ms > 0){
    const s = Math.max(0, Math.round((Date.now() - SWAP.stage_since_ms) / 1000));
    const el2 = s < 90 ? s + 's' : Math.round(s / 60) + 'm';
    head.appendChild(kvRow('This stage', blabel + ' · ' + el2 + ' elapsed'));
  }
  wrap.appendChild(head);

  wrap.appendChild(stepOpenCard());
  wrap.appendChild(stepConfirmCard());
  wrap.appendChild(stepFundCard());
  wrap.appendChild(stepRevealCard());
  wrap.appendChild(stepClaimCard());

  // Controls.
  const ctl = el('div','card');
  const stat = el('div','status', SWAP.wait_note || ''); stat.id = 'xrStepStatus'; ctl.appendChild(stat);
  const row = el('div','row'); row.style.marginTop = '6px';
  // Refund the asset leg: offered once it is funded and the swap isn't done.
  // Refund off-ramp: only while NOT complete/refunded AND before the maker has claimed the asset. At
  // SEQ_CLAIMED the maker already took the asset leg (the secret is out), so a refund can only fail —
  // hide it (the user should claim the BTC instead). Gated on the Sequentia CLTV maturity + countdown.
  if (SWAP.seq_leg && ![ST.BTC_CLAIMED, ST.REFUNDED, ST.SEQ_CLAIMED].includes(SWAP.state)){
    const rb = el('button','danger','Refund asset leg'); rb.onclick = onRefundSeq;
    rb.disabled = true; rb.title = 'Checking the refund timelock…';
    row.appendChild(rb);
    gateSeqRefundByCltv(rb, SWAP.seq_locktime);
  }
  const ab = el('button','ghost', [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state) ? 'Clear' : 'Abandon');
  ab.onclick = onAbandon; row.appendChild(ab);
  ctl.appendChild(row);
  const err = el('div','status err',''); err.id = 'xrswapErr'; err.style.marginTop = '6px'; ctl.appendChild(err);
  wrap.appendChild(ctl);

  // Keep the driver alive across a re-render if we're mid-flight and not terminal.
  const terminal = [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state);
  if (!terminal && SWAP.seq_leg) driveSettle();   // on-chain tail; there is no daemon to poll
}

function stepOpenCard(){
  const done = !!(SWAP.btc_leg && SWAP.btc_leg.txid);
  const body = [
    C.el('div','sub','The maker locks BTC in an HTLC you can claim with the secret it will reveal, refundable by the maker only after T_btc.'),
  ];
  if (SWAP.btc_leg && SWAP.btc_leg.txid) body.push(kvRowHtml('Maker BTC lock tx', txLink(SWAP.btc_leg.txid, true)));
  if (SWAP.state === ST.FAILED) body.push(errLine(SWAP.detail || 'open failed'));
  return stepCard(1, 'Maker locks BTC', done, !done, body);
}
function stepConfirmCard(){
  const locked = !!(SWAP.btc_leg && SWAP.btc_leg.txid);
  const done = SWAP.btc_leg_height > 0;
  const body = [ C.el('div','sub','Wait for the maker’s BTC lock to confirm so your Sequentia leg can anchor at or above it.') ];
  if (done) body.push(okLine('BTC leg confirmed at parent height ' + SWAP.btc_leg_height + '.'));
  else if (locked) body.push(C.el('div','status','Waiting for the maker’s BTC lock to confirm - one Bitcoin block, usually 10–20 minutes on testnet4.'));
  return stepCard(2, 'BTC lock confirms', done, locked && !done, body);
}
function stepFundCard(){
  const ready = SWAP.btc_leg_height > 0;
  const funded = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const active = ready && !funded && ![ST.FAILED, ST.REFUNDED].includes(SWAP.state);
  const body = [ C.el('div','sub','Fund your asset in an HTLC the maker can take only by revealing the secret - which lets you claim the BTC.') ];
  if (SWAP.seq_leg && SWAP.seq_leg.txid) body.push(kvRowHtml('Asset leg tx', txLink(SWAP.seq_leg.txid, false)));
  // The wallet funds this leg by itself inside the lift (one consent, taken up
  // front), so there is no button here.
  return stepCard(3, 'Fund the asset leg', funded, active, body);
}
function stepRevealCard(){
  const submitted = SWAP.state === ST.SEQ_SUBMITTED || !!SWAP.preimage || SWAP.state === ST.SEQ_CLAIMED || SWAP.state === ST.BTC_CLAIMED;
  const done = !!SWAP.preimage;
  const body = [ C.el('div','sub','The maker runs the anchor-ordering gate, then takes your asset leg - revealing the secret on Sequentia.') ];
  if (SWAP.seq_claim_txid) body.push(kvRowHtml('Maker asset-claim tx', txLink(SWAP.seq_claim_txid, false)));
  if (SWAP.preimage) body.push(kvRow('Secret revealed', short(SWAP.preimage)));
  return stepCard(4, 'Maker reveals the secret', done, submitted && !done, body);
}
function stepClaimCard(){
  const done = SWAP.state === ST.BTC_CLAIMED || !!SWAP.btc_claim_txid;
  const canClaim = !!SWAP.preimage && !done;
  const body = [ C.el('div','sub','Claim the maker’s BTC leg with the revealed secret - completing the swap (anchor-bounded; reverts only if Bitcoin reverts).') ];
  if (SWAP.btc_claim_txid) body.push(kvRowHtml('Your BTC claim tx', txLink(SWAP.btc_claim_txid, true)));
  if (SWAP.state === ST.REFUNDED) body.push(okLine('Refunded: ' + (SWAP.detail || 'your asset leg was refunded.')));
  if (done) body.push(okLine('Swap complete - you received BTC for your asset, linked by the secret.'));
  const c = stepCard(5, 'Claim your BTC', done, canClaim, body);
  if (canClaim){
    const btn = C.el('button','primary','Claim BTC now'); btn.onclick = onClaimBtc; btn.style.marginTop = '10px'; c.appendChild(btn);
  }
  return c;
}

// ---- small DOM helpers (mirroring xswap.js) ----
function stepCard(n, title, done, active, bodyNodes){
  const c = C.el('div','card');
  const hr = C.el('div','row');
  hr.appendChild(C.el('label','lbl', `${n}. ${title}`));
  const [lbl, cls] = done ? ['Done','b-in'] : active ? ['Now','b-out'] : ['Pending','b-out'];
  const b = C.el('span','badge ' + cls, lbl); b.style.marginLeft = 'auto'; hr.appendChild(b);
  c.appendChild(hr);
  for (const node of bodyNodes) if (node) c.appendChild(node);
  return c;
}
function kvRow(k, v){ const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); d.appendChild(C.el('span','v',v)); return d; }
function kvRowHtml(k, html){ const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); const v = C.el('span','v'); v.innerHTML = html; d.appendChild(v); return d; }
function short(s){ return s ? (String(s).slice(0,10) + '…' + String(s).slice(-6)) : '-'; }
function txLink(txid, parent){
  if (!txid) return '-';
  const href = parent ? ('/testnet4/tx/' + txid) : ('/explorer/tx/' + txid);
  return `<a href="${href}" target="_blank" rel="noopener">${short(txid)}</a>`;
}
function okLine(t){ const d = C.el('div','status ok'); d.textContent = t; return d; }
function errLine(t){ const d = C.el('div','status err'); d.textContent = t; return d; }

// Test-only exports: drive the reverse pipeline headlessly (no DOM).
export const __test__ = {
  pick, normMarket, verifyMakerBtcLeg,
  // Tests need the anchor precondition to poll in milliseconds; setTiming(null)
  // restores the shipped cadence. It can never shorten the WAIT itself — only the
  // timelock (or the user) ends that.
  setTiming: (o) => { T.anchorPollMs = (o && o.anchorPollMs) || 15 * 1000; },
  // Lets a test stop the on-chain settle driver's interval so the process can exit.
  stopPoll,
  resumeSeqLeg, claimBtc,
  proportionalBtcFloor, driveReverse, initXrswap,
  getSwap: () => SWAP, setSwap: (s) => { SWAP = s; saveSwap(); },
  setQuote: (q) => { LAST_RQUOTE = q; }, getQuote: () => LAST_RQUOTE,
  loadSwap, saveSwap, clearSwap, ST,
};
