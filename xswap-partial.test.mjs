// Headless unit test for the CROSS-CHAIN COURIER PARTIAL-FILL port (xswap.js forward taker +
// xrswap.js reverse taker). Drives the real drivers through a scripted (mock) courier session with
// fake leg ops — no DOM, no relay, no chain — proving the partial-fill handshake mirrors the Go client:
//
//   FORWARD (buy asset with BTC, lift a resting ask):
//     * a PARTIAL take validates the maker's WHOLE-offer terms (ratio), NOT the slice;
//     * it funds CEIL-proportional BTC for the slice (maker's favour);
//     * XcBtcLegFunded carries seq_amount (the slice) + btc_amount (the proportional BTC) as NUMBERS;
//     * on SeqLegLocked it binds slice-vs-slice and settles;
//     * it REFUSES (never reveals the secret) if the maker locks LESS than the slice it funded;
//     * a WHOLE take is unchanged (fundBtc == the whole offer's BTC).
//
//   REVERSE (sell asset for BTC): the slice is shipped in the TermsRequest; the maker's per-lift terms
//     must carry the FLOOR-proportional BTC + the slice, bound slice-vs-slice; a mispriced partial is
//     refused with nothing spent; a correct partial funds the SEQ leg for exactly the slice.
//
// Run: node --test xswap-partial.test.mjs   (or as part of `node --test *.test.mjs`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ as FWD, initXswap } from './xswap.js';
import { __test__ as REV } from './xrswap.js';

const big = (v) => BigInt(v);

// ---- a minimal localStorage + document + fetch environment the drivers touch ----
function installEnv(){
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.document = { getElementById: () => null };
  // The forward claim path reads the leg's own anchor + the node's anchor health +
  // the leg block's quorum certification (/lsp/anchor?tx=...), and the Sequentia
  // tip (/lsp/anchor). ALL THREE conjuncts of the claim gate must hold for the
  // happy path to claim without waiting: anchor at/above the BTC-leg height,
  // anchorstatus "ok", and the block certified. (A MISSING anchor_status counts as
  // NOT ok: the gate fails closed and waits rather than assume a healthy anchor.)
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/anchor?')) return { ok: true, json: async () => ({ ok: true, anchor_height: 142600, anchor_status: 'ok', poscertified: true }) };
    if (u.endsWith('/anchor'))   return { ok: true, json: async () => ({ ok: true, height: 16500, anchor_status: 'ok' }) };
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

// A modalRows fake that AUTO-CONFIRMS: confirmLockModal sets ok.onclick and awaits the click, so the
// setter schedules the handler to fire (resolving the promise true).
function autoConfirmModal(){
  return (_opts) => {
    const m = { remove(){}, querySelector(){ return null; } };
    const ok = { textContent: '' };
    Object.defineProperty(ok, 'onclick', {
      configurable: true, get(){ return undefined; },
      set(fn){ queueMicrotask(() => { try { fn && fn(); } catch {} }); },
    });
    return { m, ok };
  };
}

// A scripted courier session: recv() returns the next scripted message iff its type matches what the
// driver asked for; send()/fail() are captured for assertions.
function scriptedSession(scripted){
  const sent = [], failCalls = [];
  let i = 0;
  const session = {
    send: async (msg) => { sent.push(msg); },
    recv: async (wantType) => {
      const m = scripted[i++];
      if (!m) throw new Error('no more scripted messages (want ' + wantType + ')');
      if (m.type !== wantType) throw new Error('driver wanted ' + wantType + ' but next scripted is ' + m.type);
      return m;
    },
    fail: async (code, message) => { failCalls.push({ code, message }); },
    close: () => {},
  };
  return { session, sent, failCalls };
}

// ===========================================================================
// Shared FORWARD fixture.
// ===========================================================================
const ASSET = 'GOLDASSET';
const WHOLE_SEQ = 5000000n, WHOLE_BTC = 25001n;   // the whole resting ask (25001 sats makes the ratio non-integer -> proves CEIL)
const T_BTC = 142700, T_SEQ = 16740, CONF_H = 142600;
const HASH = 'cd'.repeat(32), SECRET = 'ab'.repeat(32);
const SEQ_CLAIM_PUB = '02seqclaim', MAKER_BTC_CLAIM = '02mbc', MAKER_SEQ_REFUND = '02msr', BTC_REFUND_PUB = '02btcrefund';
const redeemOf = (h, claim, ref, lock) => `R:${h}:${claim}:${ref}:${lock}`;
// The SEQ leg's redeem the taker re-derives in verifyLeg: claim = our SEQ key, refund = maker, T_seq.
const FWD_SEQ_REDEEM = redeemOf(HASH, SEQ_CLAIM_PUB, MAKER_SEQ_REFUND, T_SEQ);

// TERMS NAME THE SLICE the taker asked for, not the whole resting offer — what the
// real maker sends (seqob-maker's PARTIAL quote) and what every taker now binds to.
// Called with no argument it quotes the whole offer, which is what a whole take is.
const propCeil = (whole, take, wholeSeq) => (take >= wholeSeq ? whole : (whole * take + wholeSeq - 1n) / wholeSeq);
function forwardTermsMsg(takeSeq){
  const seq = (takeSeq && takeSeq > 0n && takeSeq < WHOLE_SEQ) ? takeSeq : WHOLE_SEQ;
  const btc = propCeil(WHOLE_BTC, seq, WHOLE_SEQ);
  return { type: 'terms', btc_amount: Number(btc), seq_amount: Number(seq), fee_btc: 0,
    btc_locktime: T_BTC, seq_locktime: T_SEQ, maker_btc_claim_pub: MAKER_BTC_CLAIM, maker_refund_pub: MAKER_SEQ_REFUND };
}
function forwardSeqLockedMsg(lockedAtoms){
  return { type: 'seq_leg_locked', leg: { txid: 'seqfund', vout: 0, amount: Number(lockedAtoms), asset: ASSET,
    redeem_script: FWD_SEQ_REDEEM, locktime: T_SEQ, block_hash: 'seqblk', anchor_height: CONF_H } };
}

// Build a fresh forward fake-C wired to a given scripted session, capturing the fund + broadcast calls.
function forwardCtx(session){
  const fundCalls = [], broadcastCalls = [], toasts = [];
  const C = {
    SEQOB: '/seqob', addrIndex: undefined,
    $: () => null, el: () => ({}),
    assetMeta: () => ({ ticker: 'GOLD', precision: 8 }),
    fmtAtoms: (v) => String(v),
    prettyErr: (e) => String((e && e.message) || e),
    toast: (m) => { toasts.push(m); },
    modalRows: autoConfirmModal(),
    // A REALISTIC fee exchange rate: the neutral 1e8 (EXCHANGE_RATE_SCALE) = the asset priced 1:1 with SEQ, so
    // the min-slice dust guard's asset floor is a few atoms (fee=1000 atoms, floor=2001) — a legitimate 1.5M-atom
    // partial clears it. (A tiny stub rate would make GOLD so cheap that even a large leg prices to sub-dust; the
    // dedicated sub-dust tests below exercise the guard tripping.)
    feeRateFor: () => 1e8, DEFAULT_FEERATE: 1000, EXCHANGE_RATE_SCALE: 1e8,
    broadcastSeqTx: async (hex) => { broadcastCalls.push(hex); return 'seqclaimtxid'; },
    openCourierSession: async () => session,
    signer: { htlcKeypair: () => ({ public_key: SEQ_CLAIM_PUB, secret_hex: '11'.repeat(32) }) },
    wasm: {
      generateSwapSecret: () => ({ secret_hex: SECRET, hash_hex: HASH }),
      buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeemOf(h, claim, ref, lock),
      buildSeqHtlcClaimTx: () => 'claimhex',
    },
    btcLeg: {
      refundKey: () => ({ public_key: BTC_REFUND_PUB, secret_hex: '22'.repeat(32) }),
      fund: async (redeem, amount, onBroadcast) => {
        fundCalls.push({ redeem, amount: big(amount) });
        if (onBroadcast) onBroadcast('btcfundtxid');
        return { txid: 'btcfundtxid', vout: 0, height: CONF_H, amount: Number(amount), asset_id: '' };
      },
    },
    wollet: { address: () => ({ address: () => ({ toUnconfidential: () => ({ scriptPubkey: () => ({ bytes: () => [0x00, 0x14, 0xaa] }) }) }) }) },
  };
  return { C, fundCalls, broadcastCalls, toasts };
}

function forwardQuote(takeSeq){
  const offer = { offer_id: 'off1', maker_pubkey: 'mk1', base_amount: String(WHOLE_SEQ), want_amount: String(WHOLE_BTC) };
  return { market: { btc_asset: '', seq_asset: ASSET, name: 'BTC / GOLD' }, offer, courier: true, quote_id: 'courier',
    seq_amount: takeSeq, btc_amount: 0n, fee_btc: 0n, candidates: [] };
}

test('FORWARD partial: binds the SLICE terms, funds ceil-proportional BTC, sends the slice, binds + settles', async () => {
  installEnv();
  const takeSeq = 1500000n;
  const expectFundBtc = FWD.proportionalBtcCeil(WHOLE_BTC, takeSeq, WHOLE_SEQ);   // ceil(25001*1.5e6/5e6) = 7501
  assert.equal(expectFundBtc, 7501n, 'ceil-proportional BTC for the slice');

  const { session, sent, failCalls } = scriptedSession([forwardTermsMsg(takeSeq), forwardSeqLockedMsg(takeSeq)]);
  const { C, fundCalls, broadcastCalls } = forwardCtx(session);
  initXswap(C);
  FWD.clearSwap();

  await FWD.runForwardCourier(forwardQuote(takeSeq));

  // The maker's WHOLE-offer terms were accepted for a SLICE take (no terms-mismatch abort).
  assert.equal(failCalls.length, 0, 'no XcFail — whole-ratio terms validated for a partial');

  // The BTC leg was funded for the CEIL-proportional slice price (maker never underpaid).
  assert.equal(fundCalls.length, 1, 'funded the BTC leg exactly once');
  assert.equal(fundCalls[0].amount, expectFundBtc, 'BTC leg funded for the ceil-proportional slice price');

  // XcBtcLegFunded carries the slice + proportional BTC as JSON NUMBERS (Go uint64 rejects strings).
  const funded = sent.find(m => m.type === 'btc_leg_funded');
  assert.ok(funded, 'XcBtcLegFunded was sent');
  assert.equal(funded.seq_amount, Number(takeSeq), 'btc_leg_funded.seq_amount == takeSeq');
  assert.equal(funded.btc_amount, Number(expectFundBtc), 'btc_leg_funded.btc_amount == fundBtc');
  assert.equal(typeof funded.seq_amount, 'number', 'seq_amount is a JSON number (not a string)');
  assert.equal(typeof funded.btc_amount, 'number', 'btc_amount is a JSON number (not a string)');
  assert.equal(funded.leg.amount, Number(expectFundBtc), 'the funded BTC leg amount == fundBtc');

  // Slice-vs-slice bind held and the swap settled (secret revealed, asset claimed).
  const swap = FWD.getSwap();
  assert.equal(swap.seq_amount, takeSeq, 'SWAP.seq_amount == takeSeq (the slice)');
  assert.equal(swap.btc_amount, expectFundBtc, 'SWAP.btc_amount == fundBtc');
  assert.equal(swap.state, FWD.ST.SEQ_CLAIMED, 'forward partial settled (SEQ claimed)');
  assert.equal(broadcastCalls.length, 1, 'the claim (secret reveal) was broadcast once');
});

test('FORWARD partial: REFUSES (no secret reveal) when the maker locks LESS than the funded slice', async () => {
  installEnv();
  const takeSeq = 1500000n;
  const underLock = takeSeq - 500000n;   // maker tries to deliver less asset than the taker funded

  const { session, sent, failCalls } = scriptedSession([forwardTermsMsg(takeSeq), forwardSeqLockedMsg(underLock)]);
  const { C, fundCalls, broadcastCalls } = forwardCtx(session);
  initXswap(C);
  FWD.clearSwap();

  await FWD.runForwardCourier(forwardQuote(takeSeq));

  // The BTC leg was funded, but the under-delivering SEQ leg is refused BEFORE the irreversible reveal.
  assert.equal(fundCalls.length, 1, 'the BTC leg was funded (then the maker under-delivered)');
  assert.ok(sent.find(m => m.type === 'btc_leg_funded'), 'the taker announced its funded BTC leg');
  assert.equal(broadcastCalls.length, 0, 'the secret was NEVER revealed (no claim broadcast)');
  assert.ok(failCalls.find(f => f.code === 'seq_leg_mismatch'), 'refused with seq_leg_mismatch');

  const swap = FWD.getSwap();
  assert.equal(swap.state, FWD.ST.FAILED, 'swap marked FAILED (BTC stays refundable after T_btc)');
  assert.ok(!swap.seq_claim_txid, 'no SEQ claim tx — the taker kept its secret');
});

test('FORWARD whole take is unchanged: fundBtc == the whole offer BTC, byte-identical lift', async () => {
  installEnv();
  const takeSeq = WHOLE_SEQ;   // taking the entire offer
  const { session, sent, failCalls } = scriptedSession([forwardTermsMsg(takeSeq), forwardSeqLockedMsg(takeSeq)]);
  const { C, fundCalls, broadcastCalls } = forwardCtx(session);
  initXswap(C);
  FWD.clearSwap();

  await FWD.runForwardCourier(forwardQuote(takeSeq));

  assert.equal(failCalls.length, 0, 'no XcFail on a whole take');
  assert.equal(fundCalls[0].amount, WHOLE_BTC, 'whole take funds the whole offer BTC (no proportional rounding)');
  const funded = sent.find(m => m.type === 'btc_leg_funded');
  assert.equal(funded.seq_amount, Number(WHOLE_SEQ), 'seq_amount == the whole offer');
  assert.equal(funded.btc_amount, Number(WHOLE_BTC), 'btc_amount == the whole offer BTC');
  assert.equal(FWD.getSwap().state, FWD.ST.SEQ_CLAIMED, 'whole take settles as before');
  assert.equal(broadcastCalls.length, 1, 'claim broadcast once');
});

// ===========================================================================
// REVERSE (sell asset for BTC): ship the slice, bind FLOOR-proportional terms.
// ===========================================================================
const R_HASH = 'ef'.repeat(32);
const R_TAKER_BTC_CLAIM = '02tbc', R_TAKER_SEQ_REFUND = '02tsr', R_MAKER_SEQ_CLAIM = '02msc', R_MAKER_BTC_REFUND = '02mbr';

function reverseCtx(session){
  const rFundCalls = [], failNote = [];
  const C = {
    SEQOB: '/seqob', addrIndex: undefined,
    // The asset FUNDER's anchor precondition reads these. A caught-up, healthy
    // anchor (above the maker's BTC-leg height, which is what the funder aims at)
    // lets these partial-fill tests exercise the sizing they are about; the
    // precondition itself is pinned separately in xcross-fundsafety.test.mjs.
    anchorTipStatus: async () => ({ height: CONF_H + 8, ok: true }),
    anchorHeightOf: async () => CONF_H + 8,
    seqTip: async () => T_SEQ - 400,
    btcTip: async () => CONF_H,
    $: () => null, el: () => ({}),
    assetMeta: () => ({ ticker: 'GOLD', precision: 8 }),
    fmtAtoms: (v) => String(v),
    prettyErr: (e) => String((e && e.message) || e),
    toast: () => {},
    openCourierSession: async () => session,
    wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeemOf(h, claim, ref, lock) },
    btcLeg: {
      claimKey: () => ({ public_key: R_TAKER_BTC_CLAIM, secret_hex: '33'.repeat(32) }),
      findFunding: async () => ({ confirmed: true, height: CONF_H, vout: 0, value: 7500 }),
      claim: async () => 'btcclaimtxid',
    },
    seqLeg: {
      refundKey: () => ({ public_key: R_TAKER_SEQ_REFUND, secret_hex: '44'.repeat(32) }),
      fund: async (redeem, asset, amount) => { rFundCalls.push({ redeem, asset, amount: big(amount) }); return { txid: 'seqfundtxid' }; },
      waitConf: async () => { throw new Error('confirmation timeout (test stop)'); },
    },
    wollet: { address: () => ({ address: () => ({ toUnconfidential: () => ({ scriptPubkey: () => ({ bytes: () => [0x00, 0x14, 0xaa] }) }) }) }) },
  };
  return { C, rFundCalls, failNote };
}

// A reverse offer: offer_asset='BTC' (maker gives whole BTC), want/base = the whole asset it buys.
function reverseQuote(takeSeq){
  const offer = { offer_id: 'roff1', maker_pubkey: 'rmk1', offer_asset: 'BTC',
    offer_amount: String(WHOLE_BTC), want_amount: String(WHOLE_SEQ), base_amount: String(WHOLE_SEQ) };
  return { reverse: true, offer, market: { btc_asset: '', seq_asset: ASSET, name: 'BTC / GOLD' },
    seq_amount: takeSeq, btc_amount: 0n, fee_btc: 0n };
}
function reverseBtcLockedMsg(mkBtcAmount, mkSeqAmount, legAmount){
  const legRedeem = redeemOf(R_HASH, R_TAKER_BTC_CLAIM, R_MAKER_BTC_REFUND, T_BTC);
  return { type: 'btc_leg_locked', hash_h: R_HASH, maker_seq_claim_pub: R_MAKER_SEQ_CLAIM, maker_refund_pub: R_MAKER_BTC_REFUND,
    seq_locktime: T_SEQ, btc_amount: mkBtcAmount, seq_amount: mkSeqAmount, fee_btc: 0,
    leg: { txid: 'mkbtc', vout: 0, amount: legAmount, redeem_script: legRedeem, locktime: T_BTC } };
}

test('REVERSE partial: ships the slice in TermsRequest and funds the SEQ leg for exactly the slice', async () => {
  installEnv();
  const takeSeq = 1500000n;
  const wantBtc = REV.proportionalBtcFloor(WHOLE_BTC, takeSeq, WHOLE_SEQ);   // floor(25001*1.5e6/5e6) = 7500
  assert.equal(wantBtc, 7500n, 'floor-proportional BTC for the slice');

  // Maker prices the slice correctly (floor) and sizes to takeSeq.
  const { session, sent, failCalls } = scriptedSession([reverseBtcLockedMsg(Number(wantBtc), Number(takeSeq), Number(wantBtc))]);
  const { C, rFundCalls } = reverseCtx(session);
  REV.initXrswap(C);
  REV.clearSwap();

  // waitConf throws after fund, so driveReverse rejects — we only need to reach the fund call.
  await assert.rejects(() => REV.driveReverse(reverseQuote(takeSeq)));

  // The slice was shipped in the TermsRequest (maker sizes its BTC leg to it) as a JSON number.
  const req = sent.find(m => m.type === 'terms_request');
  assert.ok(req, 'a TermsRequest was sent');
  assert.equal(req.seq_amount, Number(takeSeq), 'TermsRequest.seq_amount == takeSeq (the slice we sell)');
  assert.equal(typeof req.seq_amount, 'number', 'seq_amount is a JSON number');
  assert.equal(failCalls.length, 0, 'no XcFail — correct floor-proportional terms accepted');

  // We funded the SEQ asset leg for EXACTLY the slice (bound slice-vs-slice), never the whole offer.
  assert.equal(rFundCalls.length, 1, 'funded the SEQ leg once');
  assert.equal(rFundCalls[0].amount, takeSeq, 'SEQ leg funded for exactly takeSeq');
  assert.equal(rFundCalls[0].asset, ASSET, 'funded the agreed asset');

  const swap = REV.getSwap();
  assert.equal(swap.seq_amount, takeSeq, 'SWAP.seq_amount == takeSeq');
  assert.equal(swap.btc_amount, wantBtc, 'SWAP.btc_amount == floor-proportional wantBtc');
});

test('REVERSE partial: REFUSES a mispriced maker (nothing spent) — over-quoted BTC for the slice', async () => {
  installEnv();
  const takeSeq = 1500000n;
  const wantBtc = REV.proportionalBtcFloor(WHOLE_BTC, takeSeq, WHOLE_SEQ);   // 7500
  const badBtc = Number(wantBtc + 1n);   // maker quotes 1 sat too much for the slice (not the floor)

  const { session, sent, failCalls } = scriptedSession([reverseBtcLockedMsg(badBtc, Number(takeSeq), badBtc)]);
  const { C, rFundCalls } = reverseCtx(session);
  REV.initXrswap(C);
  REV.clearSwap();

  await REV.driveReverse(reverseQuote(takeSeq));   // aborts internally, returns (no throw, no fund)

  // The slice was still shipped, but the mispriced terms are refused with nothing spent.
  const req = sent.find(m => m.type === 'terms_request');
  assert.equal(req.seq_amount, Number(takeSeq), 'TermsRequest still ships the slice');
  assert.ok(failCalls.find(f => f.code === 'terms_mismatch'), 'refused mispriced partial with terms_mismatch');
  assert.equal(rFundCalls.length, 0, 'the SEQ leg was NEVER funded (nothing spent)');
  assert.equal(REV.getSwap().state, REV.ST.FAILED, 'swap marked FAILED, no asset committed');
});

// ===========================================================================
// MIN-SLICE DUST GUARD (mirror of the Go daemon xminslice.go): a partial so small that, after the HTLC
// spend fee, its (Amount - Fee) claim/refund output would be sub-dust must be REFUSED PRE-LOCK, with NOTHING
// spent (no BTC leg funded, no asset leg funded, no secret revealed) — in BOTH directions. This is the ONLY
// thing between an honest maker's post-lock 'amount_too_small' reject and an unrefundable sub-dust HTLC.
// ===========================================================================
test('FORWARD sub-dust: a tiny slice is REFUSED pre-lock (amount_too_small), NOTHING funded or broadcast', async () => {
  installEnv();
  // 1000 atoms of the 5,000,000/25,001 offer prices to ceil(25001*1000/5e6) = 6 sats — far below the safe BTC
  // leg minimum (546 + 2*1000 = 2546). The guard must fail closed BEFORE lockBtcLeg.
  const takeSeq = 1000n;
  const fundBtc = FWD.proportionalBtcCeil(WHOLE_BTC, takeSeq, WHOLE_SEQ);
  assert.equal(fundBtc, 6n, 'the tiny slice prices to a 6-sat BTC leg (sub-dust)');

  // Only the Terms are scripted — the driver must abort at the dust guard, BEFORE it would fund + send the leg
  // and receive a SeqLegLocked.
  const { session, sent, failCalls } = scriptedSession([forwardTermsMsg(takeSeq)]);
  const { C, fundCalls, broadcastCalls } = forwardCtx(session);
  initXswap(C);
  FWD.clearSwap();

  await FWD.runForwardCourier(forwardQuote(takeSeq));

  assert.equal(fundCalls.length, 0, 'NO BTC leg was funded (refused pre-lock)');
  assert.equal(broadcastCalls.length, 0, 'NOTHING was broadcast (the secret was never revealed)');
  assert.ok(!sent.find(m => m.type === 'btc_leg_funded'), 'no funded-leg announcement — nothing was locked');
  assert.ok(failCalls.find(f => f.code === 'amount_too_small'), 'refused the maker with amount_too_small (the SAME code the daemon uses)');
  assert.equal(FWD.getSwap(), null, 'bounced back to the composer with nothing in flight');
});

test('FORWARD just-above-floor: a slice whose BTC leg clears the dust minimum still settles (guard not over-aggressive)', async () => {
  installEnv();
  // The smallest slice whose ceil BTC leg is >= 2546 sats: ceil(25001*take/5e6) >= 2546 => take >= 509,180.
  // 510,000 atoms -> ceil(25001*510000/5e6) = ceil(2550.102) = 2551 sats (>= 2546) and 510,000 atoms (>> 2001).
  const takeSeq = 510000n;
  const fundBtc = FWD.proportionalBtcCeil(WHOLE_BTC, takeSeq, WHOLE_SEQ);
  assert.ok(fundBtc >= 2546n, 'the slice clears the safe BTC-leg minimum');

  const { session, sent, failCalls } = scriptedSession([forwardTermsMsg(takeSeq), forwardSeqLockedMsg(takeSeq)]);
  const { C, fundCalls, broadcastCalls } = forwardCtx(session);
  initXswap(C);
  FWD.clearSwap();

  await FWD.runForwardCourier(forwardQuote(takeSeq));

  assert.equal(failCalls.length, 0, 'the guard did NOT trip on a safe slice');
  assert.equal(fundCalls.length, 1, 'the BTC leg funded once');
  assert.equal(fundCalls[0].amount, fundBtc, 'funded the ceil-proportional slice price');
  assert.equal(FWD.getSwap().state, FWD.ST.SEQ_CLAIMED, 'the safe partial settled');
  assert.equal(broadcastCalls.length, 1, 'the claim broadcast once');
});

test('REVERSE sub-dust: a tiny slice is REFUSED pre-fund, NOTHING sent or funded (session never opens)', async () => {
  installEnv();
  // 1000 atoms of the 5,000,000/25,001 offer -> floor(25001*1000/5e6) = 5 sats BTC, below the 2546 minimum.
  const takeSeq = 1000n;
  const wantBtc = REV.proportionalBtcFloor(WHOLE_BTC, takeSeq, WHOLE_SEQ);
  assert.equal(wantBtc, 5n, 'the tiny slice prices to a 5-sat BTC leg (sub-dust)');

  const { session, sent, failCalls } = scriptedSession([]);   // never used — the guard returns before any session opens
  const { C, rFundCalls } = reverseCtx(session);
  REV.initXrswap(C);
  REV.clearSwap();

  await REV.driveReverse(reverseQuote(takeSeq));   // returns (no throw): fails closed pre-fund

  assert.equal(rFundCalls.length, 0, 'the SEQ (asset) leg was NEVER funded — nothing spent');
  assert.equal(sent.length, 0, 'no TermsRequest was even sent (the guard runs before opening the session)');
  assert.equal(failCalls.length, 0, 'no maker was contacted, so no fail note was needed');
  assert.equal(REV.getSwap(), null, 'no swap record was created (nothing in flight)');
});

// ===========================================================================
// Pure proportional-price invariants (ceil for forward, floor for reverse; whole == identity).
// ===========================================================================
test('proportional price: forward CEIL, reverse FLOOR, whole take is identity', () => {
  // Non-integer ratio: forward rounds UP (maker's favour), reverse rounds DOWN (maker's favour).
  assert.equal(FWD.proportionalBtcCeil(25001n, 1500000n, 5000000n), 7501n, 'forward ceil');
  assert.equal(REV.proportionalBtcFloor(25001n, 1500000n, 5000000n), 7500n, 'reverse floor');
  // A whole take returns the whole BTC exactly, in BOTH directions (byte-identical to the pre-partial lift).
  assert.equal(FWD.proportionalBtcCeil(25001n, 5000000n, 5000000n), 25001n, 'forward whole == identity');
  assert.equal(REV.proportionalBtcFloor(25001n, 5000000n, 5000000n), 25001n, 'reverse whole == identity');
  // A take >= whole (defensive) also clamps to the whole BTC.
  assert.equal(FWD.proportionalBtcCeil(25001n, 6000000n, 5000000n), 25001n, 'forward over-whole clamps');
  assert.equal(REV.proportionalBtcFloor(25001n, 6000000n, 5000000n), 25001n, 'reverse over-whole clamps');
});
