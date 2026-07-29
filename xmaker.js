// ---------------------------------------------------------------------------
// xmaker.js — CROSS-CHAIN (BTC <-> Sequentia asset) MAKER for the SeqOB order
// book. This is the piece that lets the WALLET self-start a cross market: post a
// signed cross offer, listen on the courier for a taker's lift, and run the
// maker side of the HTLC settlement. It is the inverse of the taker drivers
// (xswap.js forward-taker, xrswap.js reverse-taker) and mirrors the Go
// seqob-maker (cmd/seqob-maker + internal/seqob/client/xdriver*.go).
//
// FORWARD (this file's first direction, offer side = SELL, cross direction 0 =
// BTC_TO_ASSET): the maker SELLS a Sequentia asset for BTC. A taker BUYS it,
// paying BTC. Funding order: the TAKER funds the BTC leg first; the MAKER then
// locks the asset leg; the TAKER claims the asset (revealing the secret s); the
// MAKER claims the BTC leg with s. The anchor gate is the TAKER's concern here
// (the maker only attaches the advisory anchor height). Refund-on-stall: the
// maker reclaims its asset leg after the (shorter) SEQ locktime.
//
// Interactivity: a cross-chain HTLC is inherently interactive — the wallet must
// stay open to settle a lift. Bitcoin has no covenants, so this holds regardless
// of Simplicity (which could only make the Sequentia leg non-interactive). The
// UI surfaces this honestly.
//
// All HTLC settlement reuses the existing wallet leg bridges (C.btcLeg /
// C.seqLeg) and the HTLC-script wasm binding — only the maker ORCHESTRATION and
// the courier LISTEN (openMakerListener) are new.
// ---------------------------------------------------------------------------

import { XcType, openMakerListener } from './xcourier.js';
import * as seqob from './seqob.js';
import { sha256, secp256k1 } from './btc.js';
import { bytesToHex, hexToBytes } from './seqob.js';

// The maker identity key — the SAME per-browser key swap.js uses (localStorage
// 'seqobMakerKey'), so same-chain and cross offers share one maker pubkey. It
// signs offers + derives the per-lift E2E courier key; it is NOT a fund key.
function makerPriv(){
  let h = (typeof localStorage !== 'undefined') && localStorage.getItem('seqobMakerKey');
  if (!h || !/^[0-9a-f]{64}$/.test(h)){
    const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a);
    h = [...a].map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem('seqobMakerKey', h); } catch {}
  }
  return hexToBytes(h);
}
function makerPubHex(){ return bytesToHex(secp256k1.getPublicKey(makerPriv(), true)); }

let C = null;                       // injected app context (see index.html initXmaker)
const LIVE = new Map();             // offer_id -> { listener, offer, sessions:Map }
const LS_KEY = 'swk.sequentia.xmaker';   // persisted maker sessions (resume/refund watch)

const BTC_ESPLORA = () => (typeof location !== 'undefined' ? location.origin : '') + '/testnet4/api';
const SEQ_ESPLORA = () => (typeof location !== 'undefined' ? location.origin : '') + '/api';

const sha256Hex = (hex) => bytesToHex(sha256(hexToBytes(hex)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const big = (v) => BigInt(v == null ? 0 : v);

// Timing knobs (mirror the Go XcTiming, cmd/seqob-maker). These are per-STEP
// courier/RPC budgets, NOT swap deadlines.
//
// There is deliberately no `anchorWait`. The asset funder's anchor precondition
// below is bounded by the TIMELOCK — the point past which a leg funded now could
// no longer be claimed — and by the user, never by a wall clock. Owner ruling
// (Andreas, 2026-07-25): "we should let users decide if the wait is intolerable
// and they want to cancel the trade (putting the makers order back to rest),
// rather than cancel it automatically. We cannot really predict how long
// contested blocks will take to clear anyway."
const T = { poll: 5000, termsReqWait: 120000, btcFundWait: 2*60*60*1000, seqLockWait: 60*60*1000,
            minBtcConf: 1, seqClaimMargin: 10,
            // SEQ blocks that must still remain before T_seq for a leg funded now
            // to be claimable in time (mirrors the Go MinSeqClaimWindow), and the
            // parent-chain equivalent before T_btc for our own BTC claim.
            minSeqClaimWindow: 120, minBtcClaimWindow: 12 };

const ANCHOR_BASE = () => (typeof location !== 'undefined' ? location.origin : '');

// The xcourier wire carries amounts as JSON numbers (the Go peer's struct is `uint64`, no `,string`
// tag, so it rejects a JSON string). That caps a JS-sent amount at 2^53-1 atoms without silent
// precision loss. Rather than emit a lossy number that the taker later rejects with a confusing
// "quoted X, not Y" mismatch, refuse LOUDLY up front. (>2^53 atoms is ~90M units of an 8-dp asset —
// far beyond any testnet leg; lifting this ceiling needs a coordinated `,string`-tag wire change.)
function wireAmt(x, label){
  const b = (typeof x === 'bigint') ? x : BigInt(x);
  if (b > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} (${b} atoms) exceeds the cross-chain rail's safe amount limit (2^53-1); split the trade into smaller lifts`);
  return Number(b);
}
// A Sequentia block's Bitcoin-anchor height + the node's anchor status, SELF-DERIVED
// via the explorer's read-only /anchor endpoints (context-overridable for tests).
async function anchorHeightOf(blockHash){
  if (C && C.anchorHeightOf) return C.anchorHeightOf(blockHash);
  const a = await fetch(ANCHOR_BASE() + '/anchor/' + blockHash).then(r => r.ok ? r.json() : null);
  return a && a.anchorheight != null ? Number(a.anchorheight) : null;
}

// How many times a single anchor read is retried before the caller treats it as
// UNKNOWN. The endpoint shells out to the node per request and 502s on any
// hiccup; one transient failure used to make the anchor null, and the wallet then
// withheld a leg that was perfectly fine. Unknown must cost a retry, not a trade.
const ANCHOR_READ_TRIES = 3;

// legAnchorEvidence is the CLAIMANT's read of the block that confirms an asset
// leg. It exists because reading by CACHED BLOCK HASH is unsafe in two directions
// at once — the same defect the Go gate fixed:
//
//   - the anchor endpoint answers for ORPHANED blocks too (it reads the block
//     index, not the chain), so a cached hash keeps returning a verdict about a
//     block the network has abandoned;
//   - a Sequentia reorg that re-mines the leg into a BETTER-anchored block stays
//     invisible, so we would refuse a leg that is now perfectly fine.
//
// So the lookup is by TXID — "which block confirms this leg NOW" — and its answer
// counts only when the server confirms that block is on the ACTIVE chain. The
// block hash is a fallback for the pre-confirmation window alone.
//
// Returns { anchor, statusOk, certified, onActiveChain }. anchor is -1 for
// UNKNOWN (unconfirmed, unreadable, or off-chain), never 0: anchor 0 reads as
// "confirmed but anchored BELOW your BTC lock", the TERMINAL unsafe verdict, and
// mapping an absent value onto it condemns a leg that had merely not confirmed
// yet. Number(null) === 0 is exactly how that bug arises, so null is caught first.
async function legAnchorEvidence(txid, blockHashFallback){
  if (C && C.legAnchorEvidence) return C.legAnchorEvidence(txid, blockHashFallback);
  // A context that already supplies the individual readers (tests, and any
  // embedder that wired them before this function existed) composes into the same
  // shape. Such a context owns its own freshness policy, so the txid-first
  // re-derivation below is a property of the HTTP path only; an absent anchor is
  // still UNKNOWN (-1) rather than 0, which is the distinction that matters.
  if (C && C.anchorHeightOf){
    const a = await C.anchorHeightOf(blockHashFallback);
    const okStatus = C.anchorStatusOk ? await C.anchorStatusOk() : false;
    const cert = C.posCertifiedOf ? await C.posCertifiedOf(blockHashFallback) : null;
    return { anchor: (a == null ? -1 : Number(a)), statusOk: !!okStatus,
             certified: cert, onActiveChain: a != null };
  }
  const q = txid ? ('tx=' + encodeURIComponent(txid))
          : (blockHashFallback ? ('block=' + encodeURIComponent(blockHashFallback)) : null);
  if (!q) return { anchor: -1, statusOk: false, certified: null, onActiveChain: false };
  for (let i = 0; i < ANCHOR_READ_TRIES; i++){
    try {
      const j = await fetch(ANCHOR_BASE() + '/anchor?' + q, { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok ? r.json() : null);
      const raw = (j && j.anchor_height != null) ? Number(j.anchor_height) : NaN;
      if (j && j.ok && Number.isFinite(raw)){
        return {
          anchor: raw,
          statusOk: j.anchor_status === 'ok',   // absent counts as NOT ok: never assume health we cannot see
          certified: (j.poscertified != null) ? !!j.poscertified : null,   // null = node predates the field
          // Absent on an older LSP. Treat that as unproven only when we asked by
          // BLOCK; a tx lookup already resolves through the node's own view of
          // which block confirms it.
          onActiveChain: (j.on_active_chain != null) ? !!j.on_active_chain : !!txid,
        };
      }
      // A well-formed "not confirmed yet" is not a transport failure: it is the
      // truth, and the caller must wait rather than burn retries on it.
      if (j && j.ok) return { anchor: -1, statusOk: false, certified: null, onActiveChain: false };
    } catch {}
    if (i < ANCHOR_READ_TRIES - 1) await sleep(500);
  }
  return { anchor: -1, statusOk: false, certified: null, onActiveChain: false };
}

// claimWindowClosed is fundWindowClosed's counterpart for the CLAIMANT: it reports
// why a claim can no longer land, or null while it still can. Same rule — a chain
// read that FAILS is not a verdict, so it returns null and we keep waiting. Past
// this point claiming would race the counterparty's refund, so waiting longer
// cannot produce a usable result and this is where the gate stops.
async function claimWindowClosed(seqLocktime){
  try {
    const s = await seqTip();
    if (Number.isFinite(s) && seqLocktime && s + T.seqClaimMargin >= Number(seqLocktime))
      return `the Sequentia chain reached block ${s}, within ${T.seqClaimMargin} blocks of the asset refund at ${seqLocktime}; a claim made now could race that refund`;
  } catch {}
  return null;
}

// canceled reports whether the user asked to stop. Every wait in this module that
// holds nothing of ours — or holds only refundable positions — polls it, so the UI
// can wire a cancel button with no further refactor. Owner ruling: the USER decides
// a wait is intolerable, never a wall clock.
function canceled(signal){ return !!(signal && signal.aborted); }

async function anchorStatusOk(){
  if (C && C.anchorStatusOk) return C.anchorStatusOk();
  const s = await fetch(ANCHOR_BASE() + '/anchorstatus').then(r => r.ok ? r.json() : null);
  return !!(s && (s.anchorstatus === 'ok' || s.anchorStatus === 'ok'));
}
// The node's LIVE anchor view: the Bitcoin height the Sequentia TIP currently
// anchors to. Unlike anchorHeightOf (a fixed per-block header commitment) this
// ADVANCES, which is what makes it usable as a precondition to wait on before
// funding an asset leg. Returns null when unreadable (the caller then WAITS).
async function anchorTipHeight(){
  if (C && C.anchorTipHeight) return C.anchorTipHeight();
  const s = await fetch(ANCHOR_BASE() + '/anchorstatus').then(r => r.ok ? r.json() : null);
  const h = s && (s.anchorheight != null ? s.anchorheight : s.anchorHeight);
  return h != null ? Number(h) : null;
}

// ANCHOR PRECONDITION — run by whichever side FUNDS the asset leg, BEFORE it
// funds. The claimant will refuse to claim unless the block that confirms our
// funding commits anchorheight >= the BTC-leg height, and once that block exists
// its anchor is immutable (a committed header field), so a wait AFTER funding can
// never clear it. Waiting for our own anchor to reach the BTC-leg height first
// makes the claimant's gate pass by construction: anchors are monotone
// non-decreasing along a chain, so every block extending this tip qualifies.
//
// Waiting here is free (nothing is committed, aborting costs nothing). This does
// NOT relax the claimant's gate, and must never be "replaced" by having the
// claimant consult a later/burying block: reorg invalidation propagates to
// descendants, never to ancestors, so a burying block's anchor says nothing about
// whether the FUNDING output survives.
//
// HOW LONG IT WAITS: until the TIMELOCK says a leg funded now could no longer be
// claimed (fundWindowClosed), or the caller cancels — never a wall-clock constant.
// `target` already carries the +1 slack the caller adds; see the call site.
// Returns null on success, or a reason string to abort with.
async function awaitAnchorReachesBtcLeg(target, ctx, onWait){
  let announced = false;
  for (;;){
    let ah = null, okStatus = false;
    try { ah = await anchorTipHeight(); } catch {}
    try { okStatus = await anchorStatusOk(); } catch {}
    if (ah != null && okStatus && ah >= target) return null;
    const closed = await fundWindowClosed(ctx);
    if (closed) return closed;
    if (!announced){ announced = true; try { onWait && onWait(ah, target); } catch {} }
    await sleep(T.poll);
  }
}

// fundWindowClosed reports why funding is no longer safe, or null while it still
// is. This is the ONLY automatic stop the anchor wait has. A chain read that FAILS
// is not a verdict — it returns null and we keep waiting, because a wait we cannot
// measure is not a wait we may cancel on the user's behalf.
async function fundWindowClosed({ seqLocktime, btcLocktime }){
  try {
    const s = await seqTip();
    if (Number.isFinite(s) && seqLocktime && s + T.minSeqClaimWindow >= Number(seqLocktime))
      return `the Sequentia chain reached block ${s}, leaving under ${T.minSeqClaimWindow} blocks before the asset refund at ${seqLocktime}; a leg locked now could not be claimed in time, so nothing was locked`;
  } catch {}
  try {
    const b = await btcTip();
    if (Number.isFinite(b) && btcLocktime && b + T.minBtcClaimWindow >= Number(btcLocktime))
      return `Bitcoin reached block ${b}, too close to the taker's BTC refund at ${btcLocktime} for us to claim afterwards; nothing was locked`;
  } catch {}
  return null;
}
// Whether a Sequentia block is quorum-certified (immediately final). Returns
// null when the node/endpoint predates the poscertified field (feature-detect:
// the caller then keeps anchor-only, matching the daemon's VerifySeqLegSafe).
async function posCertifiedOf(blockHash){
  if (C && C.posCertifiedOf) return C.posCertifiedOf(blockHash);
  const a = await fetch(ANCHOR_BASE() + '/anchor/' + blockHash).then(r => r.ok ? r.json() : null);
  return (a && a.poscertified != null) ? !!a.poscertified : null;
}

export function initXmaker(ctx){ C = ctx; if (C && C.SEQOB && seqob.setSeqobBase) seqob.setSeqobBase(C.SEQOB); }

async function tipHeight(base){
  const r = await fetch(base + '/blocks/tip/height');
  if (!r.ok) throw new Error('esplora tip ' + r.status);
  return parseInt((await r.text()).trim(), 10);
}
// Chain tips + the on-chain preimage read go through the context when it provides
// them (used by tests + lets the wallet supply a cached height), else esplora.
const btcTip = () => (C && C.btcTip) ? C.btcTip() : tipHeight(BTC_ESPLORA());
const seqTip = () => (C && C.seqTip) ? C.seqTip() : tipHeight(SEQ_ESPLORA());

// Read the secret s off the tx that SPENT the SEQ leg (the taker's claim). The
// claim scriptSig/witness carries the 32-byte preimage whose sha256 == H.
async function readPreimageOnChain(seqLegTxid, vout, hashHex){
  if (C && C.readPreimage) return C.readPreimage(seqLegTxid, vout, hashHex);
  try {
    const os = await fetch(`${SEQ_ESPLORA()}/tx/${seqLegTxid}/outspend/${vout}`).then(r => r.ok ? r.json() : null);
    if (!os || !os.spent || !os.txid) return null;
    const stx = await fetch(`${SEQ_ESPLORA()}/tx/${os.txid}`).then(r => r.ok ? r.json() : null);
    if (!stx) return null;
    const want = String(hashHex).toLowerCase();
    for (const vin of (stx.vin || [])){
      const pushes = [];
      const asm = vin.scriptsig_asm || vin.scriptSig_asm || '';
      for (const tok of asm.split(/\s+/)) if (/^[0-9a-fA-F]{2,}$/.test(tok)) pushes.push(tok.toLowerCase());
      for (const w of (vin.witness || [])) if (/^[0-9a-fA-F]{2,}$/.test(w)) pushes.push(w.toLowerCase());
      for (const p of pushes) if (p.length === 64 && sha256Hex(p) === want) return p;
    }
  } catch {}
  return null;
}

// --- persistence (best-effort; a maker settling while online is the norm, but
// persisting lets a reload resume the claim/refund watch). BigInt -> string. ---
function loadState(){ try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } }
function saveMakerSwap(st){
  try { const all = loadState(); all[st.session_id] = st; localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
}
function dropMakerSwap(sid){ try { const all = loadState(); delete all[sid]; localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {} }

// T11 (fund-loss safety): on load, rehydrate persisted maker swaps and re-launch the ON-CHAIN
// settlement/refund watcher for any that are not terminal. Closing the tab mid-settlement is
// otherwise a silent fund-loss risk. Both watchers re-read chain state, so relaunching is
// idempotent-safe. Returns the resumed snapshots so the composer can surface recovery UI.
let _resumed = false;
export async function resumeMakerSwaps(onState){
  if (_resumed) return [];             // launch the watchers at most once per page load
  _resumed = true;
  const all = loadState();
  const resumed = [];
  for (const st of Object.values(all)){
    if (!st || !st.state || !st.session_id) continue;
    if (st.state === 'settled' || st.state === 'refunded'){ dropMakerSwap(st.session_id); continue; }   // terminal: clean up the stale record
    if (st.direction === 'forward'){
      // FORWARD: the maker LOCKED its asset leg (step 6). If the taker claims it (revealing s) the
      // maker MUST claim the BTC leg or lose the asset for nothing — settleMakerForward does exactly
      // that (else refunds the asset after T_seq). Nothing is at risk before the asset is locked.
      if (!st.seq_leg){ dropMakerSwap(st.session_id); continue; }
      resumed.push(st);
      settleMakerForward(st, onState).catch(e => { try { onState && onState({ ...st, resume_error: (e && e.message) || String(e) }); } catch {} });
    } else if (st.direction === 'reverse'){
      // REVERSE: the maker LOCKED its BTC leg first and holds the secret. On resume take the SAFE
      // path — recover the BTC via refundReverseBtc, which NEVER reveals s. It refunds after T_btc;
      // if the taker already claimed with a revealed s the refund simply can't spend the spent output
      // (no funds lost). TODO(browser-verify): a fuller resume could instead COMPLETE a still-live
      // reverse buy (re-run the anchor gate + asset claim from st.secret_hex/st.seq_leg), but that
      // tangles with the untestable anchor gate, so resume conservatively refunds.
      if (!st.btc_leg){ dropMakerSwap(st.session_id); continue; }
      if (st.seq_claim_txid){ dropMakerSwap(st.session_id); continue; }   // we already revealed/claimed the asset: nothing to refund
      resumed.push(st);
      refundReverseBtc(st, onState, st.refund_reason || 'resumed after a reload; recovering your BTC').catch(e => { try { onState && onState({ ...st, resume_error: (e && e.message) || String(e) }); } catch {} });
    }
  }
  return resumed;
}

// ---------------------------------------------------------------------------
// Offer builder: a signed FORWARD (SELL asset for BTC) cross offer. Mirrors the
// Go buildCrossOffer (cmd/seqob-maker/main.go): pair base=asset, quote="BTC";
// offer_amount = asset given, want_amount = BTC wanted; cross_chain terms carry
// the DIRECTION and advisory maker fields (the real per-lift keys are minted at
// settle time). direction 0 = DirBTCToAsset = SELL.
// ---------------------------------------------------------------------------
export function buildForwardCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }){
  const now = Math.floor(nowUnix());
  const makerPub = makerPubHex();
  const offer = {
    offer_id: randHex16(),
    schema_version: 1,
    pair: { base_asset: assetHex, quote_asset: 'BTC' },
    offer_asset: assetHex, offer_amount: String(assetAtoms),
    want_asset: 'BTC',     want_amount: String(btcSats),
    base_amount: String(assetAtoms),
    allow_partial: false,                 // cross lifts are whole-HTLC
    created_at_unix: now,
    expires_at_unix: now + (expirySecs || 3600),
    min_anchor_depth: minAnchorDepth || 0,
    cross_chain: {
      btc_sentinel: 'BTC',
      maker_recv_address: recvAddr || '',
      maker_claim_pub: makerPub,          // advisory; real keys minted per-lift
      maker_refund_pub: makerPub,
      maker_leg_locktime: 144,
      direction: 0,                        // SELL: taker pays BTC, receives the asset
    },
  };
  return seqob.signOffer(offer, makerPriv());
}

// ---------------------------------------------------------------------------
// FORWARD maker settlement driver. Runs for ONE lift over an established
// CourierSession. `offer` is the resting offer the taker lifted.
// ---------------------------------------------------------------------------
export async function RunMakerForward(session, lift, offer, onState, signal){
  const emit = (st) => { saveMakerSwap(st); try { onState && onState(st); } catch {} };
  const assetHex   = offer.pair.base_asset || offer.pair.baseAsset;
  const seqAmount  = big(offer.offer_amount || offer.offerAmount);   // asset atoms the maker gives
  const btcAmount  = big(offer.want_amount  || offer.wantAmount);    // sats the maker wants
  const baseAmount = big(offer.base_amount  || offer.baseAmount);

  // whole-HTLC: the lift must take the full resting size (mirror the daemon guard).
  if (lift.takeAmount !== baseAmount){ await session.fail('bad_take', 'cross lifts are whole-HTLC (take the full offer)'); return; }

  // 1. recv terms_request
  await session.recv(XcType.TermsRequest, T.termsReqWait);

  // 2. maker keys (the wallet's fixed HTLC keys; single-lift-at-a-time makes reuse
  //    across sequential lifts safe) + locktimes from the live chain tips.
  const makerBtcClaim  = C.btcLeg.claimKey();     // {public_key, secret_hex} — maker claims BTC with this
  const makerSeqRefund = C.seqLeg.refundKey();    // {public_key, secret_hex} — maker refunds the asset with this
  const btcLocktime = (await btcTip()) + 100;     // BtcLocktimeDelta (~16h parent blocks)
  const seqLocktime = (await seqTip()) + 240;     // SeqLocktimeDelta (~2h SEQ slots); T_seq < T_btc

  const st = {
    direction: 'forward', state: 'terms',
    offer_id: lift.offerId, session_id: lift.sessionId, asset: assetHex,
    seq_amount: seqAmount.toString(), btc_amount: btcAmount.toString(),
    maker_btc_claim: makerBtcClaim, maker_seq_refund: makerSeqRefund,
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
  };
  emit(st);   // persist keys/locktimes BEFORE anything moves

  // 3. send terms
  await session.send({
    type: XcType.Terms,
    maker_btc_claim_pub: makerBtcClaim.public_key,
    maker_refund_pub:    makerSeqRefund.public_key,   // forward: maker_refund_pub is the SEQ refund
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
    btc_amount: wireAmt(btcAmount, 'BTC leg amount'), seq_amount: wireAmt(seqAmount, 'asset leg amount'), fee_btc: 0,
  });

  // 4. recv btc_leg_funded (taker funded BTC first)
  const bf = await session.recv(XcType.BtcLegFunded, T.btcFundWait);
  const hashH             = bf.hash_h || bf.hashH;
  const takerSeqClaimPub  = bf.taker_seq_claim_pub || bf.takerSeqClaimPub;
  const takerBtcRefundPub = bf.taker_btc_refund_pub || bf.takerBtcRefundPub;
  const bleg = bf.leg;
  if (!hashH || !takerSeqClaimPub || !takerBtcRefundPub || !bleg){ await session.fail('bad_funded', 'incomplete btc_leg_funded'); return; }
  if (big(bleg.amount) !== btcAmount){ await session.fail('bad_amount', 'btc leg amount != offer'); return; }

  // 5. verify the taker's BTC leg: re-derive the redeem (claim=maker, refund=taker,
  //    T_btc) byte-for-byte, then confirm the P2SH is funded with btc_amount.
  const btcRedeem = C.wasm.buildSeqHtlcRedeemScript(hashH, makerBtcClaim.public_key, takerBtcRefundPub, btcLocktime);
  if (String(btcRedeem).toLowerCase() !== String(bleg.redeem_script || bleg.redeemScript).toLowerCase()){
    await session.fail('bad_script', 'btc redeem script mismatch'); return;
  }
  let f = null; const deadline = nowMs() + T.seqLockWait;
  for (;;){
    try { f = await C.btcLeg.findFunding(bleg.txid, btcRedeem); } catch { f = null; }
    if (f && f.confirmed && big(f.value) === btcAmount) break;
    if (nowMs() > deadline){ await session.fail('btc_unconfirmed', 'taker BTC leg did not confirm in time'); return; }
    await sleep(T.poll);
  }
  st.hash_hex = hashH; st.taker_seq_claim_pub = takerSeqClaimPub; st.taker_btc_refund_pub = takerBtcRefundPub;
  st.btc_leg = { txid: bleg.txid, vout: f.vout, amount: btcAmount.toString(), redeem_script: btcRedeem, locktime: btcLocktime, height: f.height };
  st.state = 'btc_verified'; emit(st);

  // 5b. ANCHOR PRECONDITION — the taker's gate, honoured BEFORE our asset moves.
  //     The taker refuses to claim unless the block confirming our funding anchors
  //     at/above its BTC-leg height, and that value is frozen the moment the
  //     funding confirms. So wait for OUR anchor to reach it first; every block
  //     extending that tip then satisfies the taker's gate by construction.
  //     Aborting here is clean: nothing of ours has moved and the taker refunds
  //     its BTC after T_btc.
  //
  //     We aim ONE BLOCK ABOVE the leg height. The taker derives that height from
  //     two separate reads (its tip, then the confirmation count), so a Bitcoin
  //     block landing between them yields a height one HIGHER than we measured —
  //     and its gate would then refuse a leg we had already locked. Waiting longer
  //     is never unsafe, so we absorb the race rather than lose the asset to it.
  //     The taker's own reported height can only RAISE the bar, never lower it.
  const btcLegH = Math.max(Number(f.height), Number(bleg.height || 0));
  {
    const bad = await awaitAnchorReachesBtcLeg(btcLegH + 1, { seqLocktime, btcLocktime }, (ah, hp) => {
      st.anchor_wait = `waiting for our Sequentia anchor (${ah}) to reach ${hp} before locking the asset - nothing is locked while we wait`;
      emit(st);
    });
    if (bad){
      await session.fail('anchor_not_caught_up', 'our anchor has not reached your BTC leg; asset leg not funded');
      st.state = 'failed'; st.detail = bad; emit(st);
      return;
    }
    if (st.anchor_wait){ delete st.anchor_wait; emit(st); }
  }

  // 5c. RE-VERIFY THE TAKER'S BTC LEG. The wait above is bounded by the timelock,
  //     not by a clock, so it can run a long time — and a BTC HTLC that was
  //     confirmed when we checked it can be GONE by the end: one parent-chain
  //     reorg is all the taker needs to double-spend the input it funded with.
  //     Locking our asset against a dead BTC leg buys us nothing and costs us the
  //     asset until T_seq, so verify it again immediately before we lock. A leg
  //     that moved to a different height also invalidates the precondition we just
  //     satisfied, so that is a refusal too.
  {
    let f2 = null;
    try { f2 = await C.btcLeg.findFunding(bleg.txid, btcRedeem); } catch { f2 = null; }
    if (!f2 || !f2.confirmed || big(f2.value) !== btcAmount){
      await session.fail('btc_leg_gone', 'your BTC leg no longer verifies; asset leg not funded');
      st.state = 'failed';
      st.detail = 'the taker’s BTC lock is no longer on chain with the agreed amount - the asset leg was NOT locked, nothing of ours was spent';
      emit(st);
      return;
    }
    if (Number(f2.height) !== Number(f.height)){
      await session.fail('btc_leg_gone', 'your BTC leg moved to a different block; asset leg not funded');
      st.state = 'failed';
      st.detail = `the taker’s BTC lock moved from block ${f.height} to ${f2.height} (a Bitcoin reorg) - the asset leg was NOT locked`;
      emit(st);
      return;
    }
    const closed = await fundWindowClosed({ seqLocktime, btcLocktime });
    if (closed){
      await session.fail('seq_window_closed', 'the asset leg’s claim window has run down; asset leg not funded');
      st.state = 'failed'; st.detail = closed; emit(st);
      return;
    }
  }

  // 6. lock the SEQ asset leg (claim = taker, refund = maker, T_seq)
  const seqRedeem = C.wasm.buildSeqHtlcRedeemScript(hashH, takerSeqClaimPub, makerSeqRefund.public_key, seqLocktime);
  const funded = await C.seqLeg.fund(seqRedeem, assetHex, seqAmount);   // -> { txid }
  st.seq_fund_txid = funded.txid; emit(st);
  const conf = await C.seqLeg.waitConf(funded.txid, seqRedeem);         // -> { vout, height, block_hash }
  // POST-FUNDING CHECK: read the anchor the confirming block actually committed.
  // The precondition makes this hold by construction on the honest path, but a
  // Sequentia reorg can still land the funding on a lower-anchored branch — the
  // one case where our asset leg could outlive the taker's BTC leg — and then we
  // must not invite the claim. We keep the leg and refund it after T_seq. (This is
  // also the leg's REAL anchor height, which is what belongs on the wire; the
  // Sequentia block height is a different number.)
  //
  // WHAT WITHHOLDING BUYS, AND WHAT IT DOES NOT. It is a COURTESY, not a
  // guarantee: the taker minted the secret and holds our refund pubkey, so it can
  // rebuild this exact redeem script and find its P2SH on chain without any
  // message from us. Withholding only spares an HONEST taker a doomed claim, and
  // tells it plainly (via the fail note) not to try. The ACTUAL defence is the
  // PRE-FUNDING precondition in 5b — we do not commit the asset until our anchor
  // has passed the BTC-leg height — plus the taker's own claim gate, which refuses
  // the leg on its own node's reading. Never read this branch as "the taker cannot
  // claim now".
  let legAnchor = null;
  try { legAnchor = await anchorHeightOf(conf.block_hash); } catch {}
  st.seq_leg = { txid: funded.txid, vout: conf.vout, amount: seqAmount.toString(), asset: assetHex,
                 redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash,
                 anchor_height: legAnchor, seq_height: conf.height };
  st.state = 'seq_locked'; emit(st);
  if (legAnchor == null || legAnchor < btcLegH){
    try {
      await session.fail('seq_leg_underanchored',
        'our asset leg confirmed under-anchored; do NOT claim it (we refund it after T_seq) - refund your BTC after T_btc');
    } catch {}
    st.detail = `asset leg block ${conf.block_hash} anchors at ${legAnchor}, below the BTC-leg height ${btcLegH}; not announcing it - it will be refunded after T_seq`;
    emit(st);
    return await settleMakerForward(st, onState);   // watch/refund only; an honest taker will not claim it
  }

  // 7. announce seq_leg_locked (courtesy; the leg is on-chain regardless)
  try {
    await session.send({ type: XcType.SeqLegLocked, leg: {
      txid: funded.txid, vout: conf.vout, amount: Number(seqAmount), asset: assetHex,
      redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash, anchor_height: legAnchor,
    }});
  } catch {}

  // 8. on-chain settle (no further courier dependency): watch for the taker's SEQ
  //    claim -> learn s -> claim the BTC leg with s. Refund the asset after T_seq.
  return await settleMakerForward(st, onState);
}

// The on-chain tail of a forward maker swap; also the resume entrypoint.
export async function settleMakerForward(st, onState){
  const emit = (s) => { saveMakerSwap(s); try { onState && onState(s); } catch {} };
  for (;;){
    // (a) did the taker claim the SEQ leg (revealing s)?
    const s = await readPreimageOnChain(st.seq_leg.txid, st.seq_leg.vout, st.hash_hex);
    if (s && sha256Hex(s) === String(st.hash_hex).toLowerCase()){
      st.secret_hex = s; st.state = 'secret_learned'; emit(st);
      const claimTxid = await C.btcLeg.claim({
        txid: st.btc_leg.txid, vout: st.btc_leg.vout, amount: Number(big(st.btc_leg.amount)),
        redeem_script: st.btc_leg.redeem_script, preimage: s,
      });
      st.btc_claim_txid = claimTxid; st.state = 'settled'; emit(st);
      dropMakerSwap(st.session_id);
      return { settled: true, btc_claim_txid: claimTxid };
    }
    // (b) refund branch: after T_seq the maker reclaims its own asset leg.
    let tip = 0; try { tip = await seqTip(); } catch {}
    if (tip && tip >= st.seq_locktime){
      const dest = C.seqLeg.refundDestSpk ? await C.seqLeg.refundDestSpk() : undefined;
      const refundTxid = await C.seqLeg.refund({
        txid: st.seq_leg.txid, vout: st.seq_leg.vout, amount: Number(big(st.seq_leg.amount)),
        asset_id: st.asset, redeem_script: st.seq_leg.redeem_script, locktime: st.seq_locktime,
        refund_secret: st.maker_seq_refund.secret_hex, dest_spk: dest, fee: 0,
      });
      st.seq_refund_txid = refundTxid; st.state = 'refunded'; emit(st);
      dropMakerSwap(st.session_id);
      return { settled: false, refunded: true, seq_refund_txid: refundTxid };
    }
    await sleep(15000);
  }
}

// ---------------------------------------------------------------------------
// Post a forward cross offer and serve lifts. Returns a handle:
//   { offer, close(), activeCount(), onState }  — close() stops listening +
//   removes the resting offer's lift route (the offer only rests while open).
// onState(cb) registers a settlement-progress callback for the UI stepper.
// ---------------------------------------------------------------------------
export async function startForwardMaker({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }, onState){
  const offer = buildForwardCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr });
  // One controller per resting offer. Aborting it is the USER's exit from a wait
  // that the protocol would otherwise let run to the timelock — the owner ruled
  // out any automatic cancel, so this is the only thing that ends a healthy but
  // slow gate early. Cancelling is safe wherever it is polled: those waits hold
  // nothing of ours, or hold only refundable positions.
  const ctl = new AbortController();
  const rec = { offer, listener: null, ctl };
  const listener = await openMakerListener(offer, makerPriv(), async (session, lift) => {
    try { await RunMakerForward(session, lift, offer, onState, ctl.signal); }
    catch (e){ try { await session.fail('maker_error', (e && e.message) || String(e)); } catch {} throw e; }
  });
  rec.listener = listener;
  LIVE.set(offer.offer_id, rec);
  return {
    offer,
    close: () => { try { listener.close(); } catch {} LIVE.delete(offer.offer_id); },
    cancel: () => { try { ctl.abort(); } catch {} },
    activeCount: () => listener.activeCount(),
  };
}

export function liveMakerOffers(){ return [...LIVE.values()].map(r => r.offer); }

// cancelMakerLift is the user's "stop this trade" for a resting maker. Owner
// ruling (Andreas 2026-07-25): the USER decides a wait is intolerable, and
// cancelling must put the maker's order BACK TO REST rather than retire it — so
// the listener is deliberately left open and only the in-flight lift is aborted.
// A fresh controller replaces the spent one so the next lift is cancellable too.
export function cancelMakerLift(offerId){
  const rec = LIVE.get(offerId);
  if (!rec || !rec.ctl) return false;
  try { rec.ctl.abort(); } catch {}
  rec.ctl = new AbortController();
  return true;
}

// ===========================================================================
// REVERSE maker (offer side = BUY, cross direction 1 = ASSET_TO_BTC): the maker
// BUYS a Sequentia asset with BTC. A taker SELLS it for BTC. Funding order: the
// MAKER funds the BTC leg first and HOLDS THE SECRET; the taker funds the asset
// leg; the maker runs the anchor gate on its OWN self-derived view (never the
// taker's claim), then claims the asset REVEALING s; the taker claims the BTC
// with s. Refund-on-stall: the maker reclaims its BTC after the (longer) T_btc.
// Because it holds the secret, the anchor gate here is SELF-DERIVED and mandatory.
// ===========================================================================
export function buildReverseCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }){
  const now = Math.floor(nowUnix());
  const makerPub = makerPubHex();
  const offer = {
    offer_id: randHex16(), schema_version: 1,
    pair: { base_asset: assetHex, quote_asset: 'BTC' },
    offer_asset: 'BTC',     offer_amount: String(btcSats),      // maker gives BTC
    want_asset: assetHex,   want_amount: String(assetAtoms),    // maker wants the asset
    base_amount: String(assetAtoms),
    allow_partial: false, created_at_unix: now, expires_at_unix: now + (expirySecs || 3600),
    min_anchor_depth: minAnchorDepth || 0,
    cross_chain: {
      btc_sentinel: 'BTC', maker_recv_address: recvAddr || '',
      maker_claim_pub: makerPub, maker_refund_pub: makerPub, maker_leg_locktime: 144,
      direction: 1,   // BUY: taker pays the asset, receives BTC
    },
  };
  return seqob.signOffer(offer, makerPriv());
}

export async function RunMakerReverse(session, lift, offer, onState, signal){
  const emit = (st) => { saveMakerSwap(st); try { onState && onState(st); } catch {} };
  const assetHex   = offer.pair.base_asset || offer.pair.baseAsset;
  const seqAmount  = big(offer.want_amount  || offer.wantAmount);    // asset atoms the maker BUYS
  const btcAmount  = big(offer.offer_amount || offer.offerAmount);   // sats the maker PAYS
  const baseAmount = big(offer.base_amount  || offer.baseAmount);
  if (lift.takeAmount !== baseAmount){ await session.fail('bad_take', 'cross lifts are whole-HTLC'); return; }

  // 1. recv terms_request — BOTH taker keys are required (the BTC HTLC's claim
  //    branch pays the taker; the SEQ HTLC's refund branch pays the taker).
  const tr = await session.recv(XcType.TermsRequest, T.termsReqWait);
  const takerSeqRefundPub = tr.taker_seq_refund_pub || tr.takerSeqRefundPub;
  const takerBtcClaimPub  = tr.taker_btc_claim_pub  || tr.takerBtcClaimPub;
  if (!takerSeqRefundPub || !takerBtcClaimPub){ await session.fail('bad_terms_req', 'terms_request missing taker keys'); return; }

  // 2. mint the secret (the maker holds it) + keys + locktimes. PERSIST FIRST —
  //    the secret is the crown jewel; it must survive a reload before any coins move.
  const sec = C.wasm.generateSwapSecret();          // {secret_hex, hash_hex}
  const makerSeqClaim  = C.signer.htlcKeypair();    // maker claims the asset with this (reveals s)
  const makerBtcRefund = C.btcLeg.refundKey();      // maker refunds its BTC leg with this
  const btcLocktime = (await btcTip()) + 100;
  const seqLocktime = (await seqTip()) + 240;       // T_seq < T_btc
  const st = {
    direction: 'reverse', state: 'terms', offer_id: lift.offerId, session_id: lift.sessionId, asset: assetHex,
    seq_amount: seqAmount.toString(), btc_amount: btcAmount.toString(),
    hash_hex: sec.hash_hex, secret_hex: sec.secret_hex,
    maker_seq_claim: makerSeqClaim, maker_btc_refund: makerBtcRefund,
    taker_seq_refund_pub: takerSeqRefundPub, taker_btc_claim_pub: takerBtcClaimPub,
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
  };
  emit(st);

  // 3. LockBTCLeg FIRST — maker funds BTC: claim=taker, refund=maker, T_btc.
  const btcRedeem = C.wasm.buildSeqHtlcRedeemScript(sec.hash_hex, takerBtcClaimPub, makerBtcRefund.public_key, btcLocktime);
  const funded = await C.btcLeg.fund(btcRedeem, Number(btcAmount), btcLocktime, makerBtcRefund);   // {txid,vout,height,amount}
  st.btc_leg = { txid: funded.txid, vout: funded.vout, amount: btcAmount.toString(), redeem_script: btcRedeem, locktime: btcLocktime, height: funded.height || 0 };
  st.state = 'btc_locked'; emit(st);

  // 4. send btc_leg_locked (the terms ride here). Announce failure is FATAL — the
  //    BTC is already locked, so on any error the maker just refunds after T_btc.
  try {
    await session.send({ type: XcType.BtcLegLocked, hash_h: sec.hash_hex,
      maker_seq_claim_pub: makerSeqClaim.public_key, maker_refund_pub: makerBtcRefund.public_key,
      seq_locktime: seqLocktime, btc_amount: wireAmt(btcAmount, 'BTC leg amount'), seq_amount: wireAmt(seqAmount, 'asset leg amount'), fee_btc: 0,
      leg: { txid: funded.txid, vout: funded.vout, amount: wireAmt(btcAmount, 'BTC leg amount'), redeem_script: btcRedeem, locktime: btcLocktime } });
  } catch (e){ return await refundReverseBtc(st, onState, 'could not announce btc_leg_locked: ' + (e.message||e)); }

  // 5. recv seq_leg_funded (the taker funds the asset leg against our BTC lock).
  let sf;
  try { sf = await session.recv(XcType.SeqLegFunded, T.btcFundWait); }
  catch (e){ return await refundReverseBtc(st, onState, 'taker never funded the asset leg: ' + (e.message||e)); }
  const sleg = sf.leg;
  if (!sleg || !sleg.txid){ return await refundReverseBtc(st, onState, 'seq_leg_funded had no leg'); }

  // 6. Verify the taker's SEQ leg on-chain: re-derive the redeem (claim=maker,
  //    refund=taker, T_seq), self-derive the funding vout/block (never trust the
  //    courier), and value-bind (asset + >= agreed amount) so a dust/wrong-asset
  //    leg can't trick us into revealing s.
  const seqRedeem = C.wasm.buildSeqHtlcRedeemScript(sec.hash_hex, makerSeqClaim.public_key, takerSeqRefundPub, seqLocktime);
  let conf; try { conf = await C.seqLeg.waitConf(sleg.txid, seqRedeem); }
  catch (e){ return await refundReverseBtc(st, onState, 'taker asset leg did not confirm: ' + (e.message||e)); }
  const out = C.seqLeg.readOutput ? await C.seqLeg.readOutput(sleg.txid, conf.vout) : null;
  if (!out){ return await refundReverseBtc(st, onState, 'could not read the taker asset leg output (blinded/unreadable) - not revealing'); }
  if (out.asset !== assetHex){ await session.fail('bad_asset', 'taker locked the wrong asset'); return await refundReverseBtc(st, onState, 'taker locked the wrong asset'); }
  if (out.value < seqAmount){ await session.fail('bad_amount', 'taker locked less than agreed'); return await refundReverseBtc(st, onState, 'taker locked less than agreed'); }
  st.seq_leg = { txid: sleg.txid, vout: conf.vout, amount: seqAmount.toString(), asset: assetHex, redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash, seq_height: conf.height };
  st.state = 'seq_verified'; emit(st);

  // 7. measure our OWN BTC-leg confirmation height Hp.
  let hp = Number(st.btc_leg.height) || 0;
  if (!hp){ try { const f = await C.btcLeg.findFunding(st.btc_leg.txid, btcRedeem); if (f && f.confirmed) hp = Number(f.height); } catch {} }
  if (!hp){ return await refundReverseBtc(st, onState, 'our BTC leg has not confirmed; not revealing'); }

  // 8. ANCHOR GATE (self-derived, mandatory): the taker's asset block must anchor
  //    at a Bitcoin height >= our BTC-leg height, and the node's anchor status ok,
  //    so a Bitcoin reorg that could undo our BTC lock also undoes the asset leg.
  // Also require QUORUM CERTIFICATION of the asset block (in addition to the
  // anchor ordering), mirroring the daemon's VerifySeqLegSafe. Feature-detected:
  // certNull (field absent on an un-upgraded node) keeps anchor-only. This adds NO
  // min-anchor-DEPTH wait — the anchor axis stays 0-conf by design.
  //
  // HOW LONG IT WAITS. By the TIMELOCK and the user, never by a clock. This loop
  // previously read `nowMs() + T.anchorWait`, but T has deliberately carried no
  // anchorWait since the wall-clock ruling — so the deadline was NaN, every
  // `nowMs() > NaN` was false, and this gate could never terminate: it polled
  // every 5s forever and never reached its own failure branch. It now stops
  // exactly where a claim stops being useful (the no-reveal margin below), or
  // when the user cancels. Waiting costs nothing here: the secret is unrevealed
  // and our BTC leg stays refundable at T_btc.
  //
  // The evidence is re-derived from the leg's TXID on every pass, and only counted
  // when its confirming block is on the ACTIVE chain — a cached block hash would
  // keep answering for an orphan (see legAnchorEvidence).
  for (;;){
    if (canceled(signal))
      return await refundReverseBtc(st, onState, 'you cancelled while waiting for the anchor gate; nothing was revealed');
    const ev = await legAnchorEvidence(sleg.txid, conf.block_hash);
    // cert === null (field absent on an un-upgraded node) or true passes; false blocks.
    if (ev.onActiveChain && ev.anchor >= hp && ev.statusOk && ev.certified !== false) break;
    const closed = await claimWindowClosed(seqLocktime);
    if (closed)
      return await refundReverseBtc(st, onState,
        `anchor gate never passed (anchor ${ev.anchor < 0 ? 'unknown' : ev.anchor} vs BTC ${hp}, status ok=${ev.statusOk}, ` +
        `quorum-certified=${ev.certified}, on active chain=${ev.onActiveChain}); ${closed}; not revealing`);
    await sleep(T.poll);
  }

  // 9. no-reveal margin: never reveal so close to T_seq that our claim could miss
  //    its window (leaving s leaked with the asset already refundable to the taker).
  if ((await seqTip()) + T.seqClaimMargin >= seqLocktime){
    return await refundReverseBtc(st, onState, 'too close to the asset locktime; not revealing');
  }

  // 10. claim the asset leg — REVEALS s on-chain.
  const claimTxid = await C.seqLeg.claim({
    txid: st.seq_leg.txid, vout: st.seq_leg.vout, amount: Number(seqAmount),
    asset_id: assetHex, redeem_script: seqRedeem, claim_secret: makerSeqClaim.secret_hex, secret_hex: sec.secret_hex,
  });
  st.seq_claim_txid = claimTxid; st.state = 'settled'; emit(st);

  // 11. courtesy secret_revealed (the taker also reads s off our claim scriptSig).
  try { await session.send({ type: XcType.SecretRevealed, preimage: sec.secret_hex }); } catch {}
  dropMakerSwap(st.session_id);
  return { settled: true, seq_claim_txid: claimTxid };
}

// Refund the maker's BTC leg after T_btc (the reverse stall path). Safe because
// s is never revealed on any path that reaches here; T_seq < T_btc, so the taker's
// asset refund window is already open by the time our BTC refund is spendable.
async function refundReverseBtc(st, onState, reason){
  const emit = (s) => { saveMakerSwap(s); try { onState && onState(s); } catch {} };
  st.refund_reason = reason; st.state = 'refunding'; emit(st);
  for (;;){
    let tip = 0; try { tip = await btcTip(); } catch {}
    if (tip && tip >= st.btc_locktime){
      const txid = await C.btcLeg.refund({
        txid: st.btc_leg.txid, vout: st.btc_leg.vout, amount: Number(big(st.btc_leg.amount)),
        redeem_script: st.btc_leg.redeem_script, locktime: st.btc_locktime,
      });
      st.btc_refund_txid = txid; st.state = 'refunded'; emit(st); dropMakerSwap(st.session_id);
      return { settled: false, refunded: true, btc_refund_txid: txid, reason };
    }
    await sleep(30000);
  }
}

export async function startReverseMaker({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }, onState){
  const offer = buildReverseCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr });
  const ctl = new AbortController();   // see startForwardMaker: the user's exit from a slow gate
  const listener = await openMakerListener(offer, makerPriv(), async (session, lift) => {
    try { await RunMakerReverse(session, lift, offer, onState, ctl.signal); }
    catch (e){ try { await session.fail('maker_error', (e && e.message) || String(e)); } catch {} throw e; }
  });
  LIVE.set(offer.offer_id, { offer, listener, ctl });
  return { offer, close: () => { try { listener.close(); } catch {} LIVE.delete(offer.offer_id); },
           cancel: () => { try { ctl.abort(); } catch {} },
           activeCount: () => listener.activeCount() };
}

// --- small utils (no Date.now-in-tests concern; browser only) ---
function nowUnix(){ return Math.floor(Date.now() / 1000); }
function nowMs(){ return Date.now(); }
function randHex16(){ const a = new Uint8Array(8); (crypto || window.crypto).getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2,'0')).join(''); }

// Tests need the anchor precondition to time out in milliseconds rather than the
// shipped 45 minutes; setTiming(null) restores the shipped values.
const T_DEFAULTS = { ...T };
function setTiming(o){ Object.assign(T, o ? o : T_DEFAULTS); }

export const __test__ = { RunMakerForward, settleMakerForward, buildForwardCrossOffer, RunMakerReverse, buildReverseCrossOffer, readPreimageOnChain, sha256Hex, setC: (c) => { C = c; },
  setTiming, resumeMakerSwaps, loadState, saveMakerSwap, dropMakerSwap, _resetResume: () => { _resumed = false; } };
