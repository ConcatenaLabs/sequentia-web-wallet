// Headless node test for xmaker.js (the cross-chain MAKER forward driver).
// Drives RunMakerForward through a full forward settlement with a scripted taker
// (fake CourierSession) and fake leg ops (fake C), asserting the maker: sends
// per-lift terms, verifies the taker's BTC leg by re-derived redeem, locks the
// SEQ leg with claim=taker, announces it, learns the secret off-chain, and claims
// the BTC leg with that secret. No DOM, no relay, no chain. Run: node xmaker.test.mjs
import { __test__, RunMakerForward, initXmaker } from './xmaker.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++; } else console.log('ok:', m); };
const { sha256Hex, setC } = __test__;

// secret/hashlock the "taker" will use.
const secret = 'cc'.repeat(32);
const hashH = sha256Hex(secret);

// deterministic fake HTLC redeem so the maker's re-derivation is checkable.
const redeem = (h, claim, refund, lock) => `redeem:${h}:${claim}:${refund}:${lock}`;

const offer = {
  pair: { base_asset: 'GOLDHEX', quote_asset: 'BTC' },
  offer_amount: '5000000', want_amount: '25000', base_amount: '5000000',
  cross_chain: { direction: 0 },
};
const takerSeqClaimPub  = '03takerSeqClaim';
const takerBtcRefundPub = '03takerBtcRefund';

// captured calls
let fundCall = null, claimCall = null;
const fakeC = {
  SEQOB: '/seqob',
  btcTip: async () => 142500,
  seqTip: async () => 16500,                 // stays < seqLocktime (16740) so no refund path
  // Anchor model: the LIVE view (anchorTipHeight) is what the maker waits on
  // BEFORE funding, and it now aims ONE ABOVE the BTC-leg height (142600) to
  // absorb the taker's non-atomic height derivation; anchorHeightOf is the funding
  // block's own committed anchor, which it asserts on afterwards (>= 142600).
  anchorTipHeight: async () => 142601,
  anchorStatusOk: async () => true,
  anchorHeightOf: async (_h) => 142601,
  readPreimage: async (_txid, _vout, h) => (h.toLowerCase() === hashH.toLowerCase() ? secret : null),
  wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock) },
  btcLeg: {
    claimKey: () => ({ public_key: '02makerBtcClaim', secret_hex: 'aa'.repeat(32) }),
    findFunding: async (_txid, _redeem) => ({ vout: 0, value: 25000, confirmed: true, height: 142600 }),
    claim: async (args) => { claimCall = args; return 'btc_claim_txid'; },
  },
  seqLeg: {
    refundKey: () => ({ public_key: '02makerSeqRefund', secret_hex: 'bb'.repeat(32) }),
    fund: async (r, asset, amount) => { fundCall = { r, asset, amount }; return { txid: 'seq_fund_txid' }; },
    waitConf: async (_txid, _redeem) => ({ vout: 0, height: 16700, block_hash: 'seqblk' }),
    refund: async () => 'seq_refund_txid',
  },
};
initXmaker(fakeC); setC(fakeC);

// The BTC leg the taker "funded": its redeem must be the maker's re-derivation
// (claim=maker btc claim, refund=taker btc refund, T_btc = btcTip+100 = 142600).
const btcLegRedeem = redeem(hashH, '02makerBtcClaim', takerBtcRefundPub, 142600);
const scripted = [
  { type: 'terms_request' },
  { type: 'btc_leg_funded', hash_h: hashH, taker_seq_claim_pub: takerSeqClaimPub, taker_btc_refund_pub: takerBtcRefundPub,
    leg: { txid: 'taker_btc_txid', vout: 0, amount: 25000, redeem_script: btcLegRedeem, locktime: 142600, height: 142590 } },
];
let si = 0;
const sent = [];
const session = {
  send: async (m) => { sent.push(m); },
  recv: async (wantType) => {
    const m = scripted[si++];
    if (!m) throw new Error('no more scripted msgs (want ' + wantType + ')');
    if (m.type !== wantType) throw new Error(`maker asked for ${wantType} but next scripted is ${m.type}`);
    return m;
  },
  fail: async (code, message) => { sent.push({ type: 'fail', code, message }); },
  close: () => {},
};

const res = await RunMakerForward(session, { sessionId: 'sessM', offerId: 'offM', takeAmount: 5000000n }, offer);

// 1. Terms sent with the maker's per-lift claim pub + tip-derived locktimes.
const terms = sent.find(m => m.type === 'terms');
ok(terms && terms.maker_btc_claim_pub === '02makerBtcClaim' && terms.maker_refund_pub === '02makerSeqRefund', 'maker sends terms with its BTC-claim + SEQ-refund pubs');
ok(terms && terms.btc_locktime === 142600 && terms.seq_locktime === 16740, 'locktimes = tips + deltas (btc 142600, seq 16740); T_seq < T_btc');
ok(terms && terms.btc_amount === 25000 && terms.seq_amount === 5000000, 'terms carry the offer amounts');

// 2. SEQ leg funded with claim=taker, refund=maker, T_seq — the maker locks the asset.
ok(fundCall && fundCall.asset === 'GOLDHEX' && fundCall.amount === 5000000n, 'maker funds the SEQ asset leg for the offer size');
ok(fundCall && fundCall.r === redeem(hashH, takerSeqClaimPub, '02makerSeqRefund', 16740), 'SEQ leg redeem binds claim=taker, refund=maker, T_seq');

// 3. SeqLegLocked announced with the funded leg.
const locked = sent.find(m => m.type === 'seq_leg_locked');
ok(locked && locked.leg.txid === 'seq_fund_txid' && locked.leg.anchor_height === 142601,
   'maker announces seq_leg_locked carrying the leg block\'s REAL Bitcoin anchor (not its Sequentia height)');

// 4. Maker learned s and claimed the BTC leg WITH that secret -> settled.
ok(claimCall && claimCall.preimage === secret && claimCall.txid === 'taker_btc_txid', 'maker claims the taker BTC leg with the revealed secret');
ok(res && res.settled === true && res.btc_claim_txid === 'btc_claim_txid', 'RunMakerForward reports settled');

// 5. No XcFail was sent on the happy path.
ok(!sent.some(m => m.type === 'fail'), 'no XcFail on the happy path');

// ===========================================================================
// REVERSE maker: maker funds BTC first + holds the secret, verifies the taker's
// asset leg + self-derived anchor gate, then claims the asset REVEALING s.
// ===========================================================================
const { RunMakerReverse } = __test__;
const secretR = 'dd'.repeat(32);
const hashR = sha256Hex(secretR);
const offerR = {
  pair: { base_asset: 'GOLDHEX', quote_asset: 'BTC' },
  offer_asset: 'BTC', offer_amount: '25000',      // maker pays BTC
  want_asset: 'GOLDHEX', want_amount: '5000000',  // maker wants the asset
  base_amount: '5000000', cross_chain: { direction: 1 },
};
const takerSeqRefundPub = '03takerSeqRefund', takerBtcClaimPub = '03takerBtcClaim';
let rFund = null, rClaim = null;
const fakeCR = {
  SEQOB: '/seqob',
  btcTip: async () => 142500, seqTip: async () => 16500,
  anchorHeightOf: async (_h) => 142600,   // >= Hp (142600) -> gate passes
  anchorStatusOk: async () => true,
  posCertifiedOf: async (_h) => true,     // quorum-certified -> gate passes
  wasm: {
    buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock),
    generateSwapSecret: () => ({ secret_hex: secretR, hash_hex: hashR }),
  },
  signer: { htlcKeypair: () => ({ public_key: '02makerSeqClaim', secret_hex: 'ee'.repeat(32) }) },
  btcLeg: {
    refundKey: () => ({ public_key: '02makerBtcRefund', secret_hex: 'ff'.repeat(32) }),
    fund: async (r, amount, locktime, _refund) => { rFund = { r, amount, locktime }; return { txid: 'maker_btc_txid', vout: 0, height: 142600, amount }; },
    findFunding: async () => ({ confirmed: true, height: 142600 }),
    refund: async () => 'btc_refund_txid',
  },
  seqLeg: {
    waitConf: async (_txid, _redeem) => ({ vout: 0, height: 16700, block_hash: 'seqblkR' }),
    readOutput: async (_txid, _vout) => ({ value: 5000000n, asset: 'GOLDHEX' }),
    claim: async (args) => { rClaim = args; return 'seq_claim_txid'; },
  },
};
initXmaker(fakeCR); __test__.setC(fakeCR);

const scriptedR = [
  { type: 'terms_request', taker_seq_refund_pub: takerSeqRefundPub, taker_btc_claim_pub: takerBtcClaimPub },
  { type: 'seq_leg_funded', leg: { txid: 'taker_seq_txid', vout: 0, amount: 5000000, asset: 'GOLDHEX', block_hash: 'seqblkR', anchor_height: 142600 } },
];
let sriR = 0; const sentR = [];
const sessionR = {
  send: async (m) => { sentR.push(m); },
  recv: async (wantType) => { const m = scriptedR[sriR++]; if (!m) throw new Error('no more scripted (want '+wantType+')'); if (m.type !== wantType) throw new Error(`want ${wantType} got ${m.type}`); return m; },
  fail: async (code, message) => { sentR.push({ type: 'fail', code, message }); },
  close: () => {},
};
const resR = await RunMakerReverse(sessionR, { sessionId: 'sessR', offerId: 'offR', takeAmount: 5000000n }, offerR);

const btcLocked = sentR.find(m => m.type === 'btc_leg_locked');
ok(btcLocked && btcLocked.hash_h === hashR && btcLocked.maker_seq_claim_pub === '02makerSeqClaim', 'reverse: maker sends btc_leg_locked with hash + its SEQ-claim pub');
ok(btcLocked && btcLocked.seq_locktime === 16740 && btcLocked.btc_amount === 25000 && btcLocked.seq_amount === 5000000, 'reverse: btc_leg_locked carries terms (T_seq 16740, amounts)');
ok(rFund && rFund.r === redeem(hashR, takerBtcClaimPub, '02makerBtcRefund', 142600) && rFund.amount === 25000, 'reverse: maker funds BTC leg claim=taker, refund=maker, T_btc');
ok(rClaim && rClaim.claim_secret === 'ee'.repeat(32) && rClaim.secret_hex === secretR, 'reverse: maker claims the asset leg with its claim key, revealing the secret');
const revealed = sentR.find(m => m.type === 'secret_revealed');
ok(revealed && revealed.preimage === secretR, 'reverse: maker sends secret_revealed');
ok(resR && resR.settled === true && resR.seq_claim_txid === 'seq_claim_txid', 'reverse: RunMakerReverse reports settled');
ok(!sentR.some(m => m.type === 'fail'), 'reverse: no XcFail on the happy path');

// ===========================================================================
// T11 resume: on load, re-launch the on-chain settlement/refund watcher for any
// NON-terminal persisted maker swap (fund-loss safety), and clean up records that
// are terminal or never committed maker funds. Needs a localStorage shim (node has
// none, so the earlier emits were no-ops — we seed a fresh store here).
// ===========================================================================
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
};
const secretFwd = '11'.repeat(32), hashFwd = sha256Hex(secretFwd);
const secretRev = '22'.repeat(32), hashRev = sha256Hex(secretRev);
let fwdClaim = null, revRefund = null;
const fakeC3 = {
  SEQOB: '/seqob',
  btcTip: async () => 142600,   // >= the reverse btc_locktime -> refund fires immediately
  seqTip: async () => 16500,    // < the forward seq_locktime -> forward stays on the claim path
  readPreimage: async (_txid, _vout, h) => (h.toLowerCase() === hashFwd.toLowerCase() ? secretFwd : null),
  btcLeg: { claim: async (a) => { fwdClaim = a; return 'fwd_btc_claim'; },
            refund: async (a) => { revRefund = a; return 'rev_btc_refund'; } },
  seqLeg: { refund: async () => 'seq_refund' },
};
initXmaker(fakeC3); __test__.setC(fakeC3);

const seed = (o) => __test__.saveMakerSwap(o);
seed({ direction: 'forward', state: 'seq_locked', session_id: 'fwdA', offer_id: 'ofA', asset: 'GOLDHEX',
  seq_amount: '5000000', btc_amount: '25000', hash_hex: hashFwd,
  seq_leg: { txid: 'seqfund', vout: 0, amount: '5000000', asset: 'GOLDHEX', redeem_script: 'r', locktime: 16740 },
  btc_leg: { txid: 'takerbtc', vout: 0, amount: '25000', redeem_script: 'r', locktime: 142600 },
  seq_locktime: 16740, btc_locktime: 142600, maker_seq_refund: { public_key: 'x', secret_hex: 'bb'.repeat(32) } });
seed({ direction: 'reverse', state: 'seq_verified', session_id: 'revA', offer_id: 'ofR', asset: 'GOLDHEX',
  seq_amount: '5000000', btc_amount: '25000', hash_hex: hashRev, secret_hex: secretRev,
  btc_leg: { txid: 'makerbtc', vout: 0, amount: '25000', redeem_script: 'r', locktime: 142600 },
  btc_locktime: 142600, maker_btc_refund: { public_key: 'y', secret_hex: 'ff'.repeat(32) } });
seed({ direction: 'forward', state: 'settled', session_id: 'termA' });   // terminal -> dropped, not resumed
seed({ direction: 'forward', state: 'terms', session_id: 'noleg' });     // no asset locked yet -> dropped

__test__._resetResume();
const resumed = await __test__.resumeMakerSwaps(() => {});
await new Promise(r => setTimeout(r, 60));   // let the fire-and-forget watchers finish (fakes resolve immediately)

ok(resumed.length === 2, 'resume relaunches exactly the 2 fund-at-risk swaps (not terminal, not un-committed)');
ok(resumed.some(s => s.session_id === 'fwdA') && resumed.some(s => s.session_id === 'revA'), 'resume picks the forward(seq-locked) + reverse(btc-locked) records');
ok(fwdClaim && fwdClaim.preimage === secretFwd && fwdClaim.txid === 'takerbtc', 'forward resume claims the taker BTC leg with the on-chain-revealed secret (no fund loss)');
ok(revRefund && revRefund.txid === 'makerbtc', 'reverse resume refunds the maker BTC leg (safe path; never reveals s)');
ok(Object.keys(__test__.loadState()).length === 0, 'after resume all records are terminal/cleaned (settled+refunded dropped, stale removed)');

// ===========================================================================
// ANCHOR PRECONDITION (forward maker = the asset giver). The taker refuses to
// claim unless the block confirming our funding anchors at/above its BTC-leg
// height, and that value is frozen once the funding confirms — so we must not
// fund until our own anchor has reached that height. On testnet4 the committee's
// anchor routinely lags the parent tip (-anchoravoidcontested), so this is the
// normal case, not an edge case.
// ===========================================================================
{
  let anchorTip = 142598;            // 2 behind the taker's BTC leg (142600)
  let funded = false, fundedAtAnchor = null;
  const fakeC4 = {
    SEQOB: '/seqob',
    btcTip: async () => 142500, seqTip: async () => 16500,
    anchorTipHeight: async () => anchorTip,
    anchorStatusOk: async () => true,
    anchorHeightOf: async (_h) => fundedAtAnchor,   // the block commits whatever the tip was at funding
    readPreimage: async (_txid, _vout, h) => (h.toLowerCase() === hashH.toLowerCase() ? secret : null),
    wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock) },
    btcLeg: {
      claimKey: () => ({ public_key: '02makerBtcClaim', secret_hex: 'aa'.repeat(32) }),
      findFunding: async () => ({ vout: 0, value: 25000, confirmed: true, height: 142600 }),
      claim: async () => 'btc_claim_txid',
    },
    seqLeg: {
      refundKey: () => ({ public_key: '02makerSeqRefund', secret_hex: 'bb'.repeat(32) }),
      fund: async () => { funded = true; fundedAtAnchor = anchorTip; return { txid: 'seq_fund_txid' }; },
      waitConf: async () => ({ vout: 0, height: 16700, block_hash: 'seqblk' }),
      refund: async () => 'seq_refund_txid',
    },
  };
  initXmaker(fakeC4); __test__.setC(fakeC4);

  let s4i = 0; const sent4 = [];
  const scripted4 = [
    { type: 'terms_request' },
    { type: 'btc_leg_funded', hash_h: hashH, taker_seq_claim_pub: takerSeqClaimPub, taker_btc_refund_pub: takerBtcRefundPub,
      leg: { txid: 'taker_btc_txid', vout: 0, amount: 25000, redeem_script: btcLegRedeem, locktime: 142600, height: 142590 } },
  ];
  const session4 = {
    send: async (m) => { sent4.push(m); },
    recv: async (want) => { const m = scripted4[s4i++]; if (!m) throw new Error('no more scripted (want '+want+')'); return m; },
    fail: async (code, message) => { sent4.push({ type: 'fail', code, message }); },
    close: () => {},
  };

  // The committee anchors forward shortly after the BTC leg is verified. It has to
  // clear 142601, not 142600: the funder aims one ABOVE the leg height so the
  // taker's non-atomic height derivation can never refuse a leg we already locked.
  setTimeout(() => { anchorTip = 142601; }, 120);
  const run = RunMakerForward(session4, { sessionId: 'sessW', offerId: 'offW', takeAmount: 5000000n }, offer);
  // While our anchor lags, the asset must NOT move.
  await new Promise(r => setTimeout(r, 60));
  ok(!funded, 'maker does NOT fund the asset while its Bitcoin anchor is behind the taker\'s BTC leg');
  await run;
  ok(funded && fundedAtAnchor >= 142601,
     `maker funds only once its anchor clears the BTC-leg height (funded at anchor ${fundedAtAnchor}, BTC leg 142600)`);
  const locked4 = sent4.find(m => m.type === 'seq_leg_locked');
  ok(locked4 && locked4.leg.anchor_height >= 142600, 'the announced leg block anchors at/above the BTC-leg height');
  ok(!sent4.some(m => m.type === 'fail'), 'no fail note on a wait that resolved');
}

// The other half: if our anchor NEVER reaches the BTC-leg height we must abort
// with the asset unspent. Aborting is free here; funding first is not.
//
// AND the abort must come from the TIMELOCK, not from a wall clock. Owner ruling
// (Andreas, 2026-07-25): "we should let users decide if the wait is intolerable
// and they want to cancel the trade [...] We cannot really predict how long
// contested blocks will take to clear anyway." So this fixture keeps the anchor
// stuck forever and instead walks the Sequentia tip up until a leg funded now
// could no longer be claimed before T_seq (16740 − 120 = 16620). Nothing but that
// may end the wait.
{
  let funded = false;
  let seqNow = 16500;                       // < 16620: the window is still open
  const fakeC5 = {
    SEQOB: '/seqob',
    btcTip: async () => 142500, seqTip: async () => seqNow,
    anchorTipHeight: async () => 142598,   // stuck 2 behind, forever
    anchorStatusOk: async () => true,
    anchorHeightOf: async () => 142598,
    wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock) },
    btcLeg: {
      claimKey: () => ({ public_key: '02makerBtcClaim', secret_hex: 'aa'.repeat(32) }),
      findFunding: async () => ({ vout: 0, value: 25000, confirmed: true, height: 142600 }),
    },
    seqLeg: {
      refundKey: () => ({ public_key: '02makerSeqRefund', secret_hex: 'bb'.repeat(32) }),
      fund: async () => { funded = true; return { txid: 'seq_fund_txid' }; },
      waitConf: async () => ({ vout: 0, height: 16700, block_hash: 'seqblk' }),
    },
  };
  initXmaker(fakeC5); __test__.setC(fakeC5);
  __test__.setTiming({ poll: 20 });   // poll fast; there is no wall-clock deadline to shorten

  let s5i = 0; const sent5 = [];
  const scripted5 = [
    { type: 'terms_request' },
    { type: 'btc_leg_funded', hash_h: hashH, taker_seq_claim_pub: takerSeqClaimPub, taker_btc_refund_pub: takerBtcRefundPub,
      leg: { txid: 'taker_btc_txid', vout: 0, amount: 25000, redeem_script: btcLegRedeem, locktime: 142600, height: 142590 } },
  ];
  const session5 = {
    send: async (m) => { sent5.push(m); },
    recv: async (want) => { const m = scripted5[s5i++]; if (!m) throw new Error('no more scripted (want '+want+')'); return m; },
    fail: async (code, message) => { sent5.push({ type: 'fail', code, message }); },
    close: () => {},
  };
  // A maker that still honoured a flat timeout would return within ~150ms. Prove
  // it does not: it is still waiting while the claim window is open.
  const run5 = RunMakerForward(session5, { sessionId: 'sessX', offerId: 'offX', takeAmount: 5000000n }, offer);
  let done5 = false; run5.then(() => { done5 = true; });
  await new Promise(r => setTimeout(r, 300));
  ok(!done5, 'the wait does NOT end on a wall clock while the timelock still leaves a claim window');
  seqNow = 16620;   // T_seq (16740) minus the 120-block claim window: funding is now unsafe
  await run5;
  ok(!funded, 'maker funds ZERO asset when its anchor never reaches the BTC-leg height');
  ok(sent5.some(m => m.type === 'fail' && m.code === 'anchor_not_caught_up'), 'maker tells the taker why, so it can refund its BTC immediately');
  ok(!sent5.some(m => m.type === 'seq_leg_locked'), 'no asset leg was ever announced');
  __test__.setTiming(null);   // restore the shipped timings
}

// ===========================================================================
// REGRESSION: the REVERSE maker's claimant anchor gate must TERMINATE.
//
// It used to read `const deadline = nowMs() + T.anchorWait`, but T has carried no
// anchorWait since the wall-clock ruling — so the deadline was NaN, every
// `nowMs() > NaN` compared false, and the loop could never reach its own failure
// branch. A reverse maker whose gate did not pass polled every 5s FOREVER: it
// never refunded its BTC leg, never told the taker, and never surfaced anything.
//
// The bound is now the timelock. Here the gate never passes (the leg's block
// anchors below our BTC leg), so the only correct outcome is: stop once the SEQ
// chain reaches the no-reveal margin, refund the BTC, and never reveal.
{
  let seqNowR = 16500, btcNowR = 142500;
  let btcRefunded = false, seqClaimed = false;
  const statesR = [];
  const secretR2 = 'ab'.repeat(32), hashR2 = sha256Hex(secretR2);
  const ctx = {
    SEQOB: '/seqob',
    btcTip: async () => btcNowR,
    seqTip: async () => seqNowR,
    // The confirming block anchors BELOW our BTC-leg height (142600): the gate can
    // never pass, so this is exactly the case that used to spin forever.
    anchorHeightOf: async (_h) => 142000,
    anchorStatusOk: async () => true,
    posCertifiedOf: async (_h) => true,
    wasm: { buildSeqHtlcRedeemScript: (h, c2, r2, l) => redeem(h, c2, r2, l),
            generateSwapSecret: () => ({ secret_hex: secretR2, hash_hex: hashR2 }) },
    signer: { htlcKeypair: () => ({ public_key: '02makerSeqClaim2', secret_hex: 'ee'.repeat(32) }) },
    btcLeg: {
      refundKey: () => ({ public_key: '02makerBtcRefund2', secret_hex: 'ff'.repeat(32) }),
      fund: async (_r, amount) => ({ txid: 'maker_btc_txid2', vout: 0, height: 142600, amount }),
      findFunding: async () => ({ confirmed: true, height: 142600 }),
      refund: async () => { btcRefunded = true; return 'btc_refund_txid2'; },
      claimKey: () => ({ public_key: '02makerBtcClaim2', secret_hex: 'dd'.repeat(32) }),
    },
    seqLeg: {
      refundKey: () => ({ public_key: '02makerSeqRefund2', secret_hex: 'cc'.repeat(32) }),
      waitConf: async (txid) => ({ vout: 1, height: 16700, block_hash: 'seqblock2' }),
      readOutput: async () => ({ asset: 'GOLDHEX', value: 5000000n }),
      claim: async () => { seqClaimed = true; return 'seq_claim_txid2'; },
    },
  };
  setC(ctx);
  __test__.setTiming({ poll: 5 });

  const sentR2 = [];
  const scriptedR2 = [
    { type: 'terms_request', taker_seq_refund_pub: '03takerSeqRefund2', taker_btc_claim_pub: '03takerBtcClaim2', seq_amount: 5000000 },
    { type: 'seq_leg_funded', leg: { txid: 'taker_seq_txid2', vout: 1, amount: 5000000, redeem_script: 'x', locktime: 16740 } },
  ];
  let ri2 = 0;
  const sessionR2 = {
    send: async (m) => { sentR2.push(m); },
    recv: async (want) => { const m = scriptedR2[ri2++]; if (!m) throw new Error('no more scripted (want '+want+')'); return m; },
    fail: async (code, message) => { sentR2.push({ type: 'fail', code, message }); },
    close: () => {},
  };

  const runR2 = RunMakerReverse(sessionR2, { sessionId: 'sessR2', offerId: 'offR2', takeAmount: 5000000n }, offerR,
    (st) => { statesR.push(st.state); });
  let doneR2 = false; runR2.then(() => { doneR2 = true; }).catch(() => { doneR2 = true; });
  await new Promise(r => setTimeout(r, 250));
  ok(!doneR2, 'reverse gate keeps waiting while the timelock still leaves a claim window');

  // Close the claim window, and put the parent chain past T_btc (142600) so the
  // refund the gate hands off to can actually execute — otherwise this test would
  // block on the refund timelock rather than on the thing it is pinning.
  seqNowR = 16735;   // within seqClaimMargin (10) of T_seq 16740: claiming would race the refund
  btcNowR = 142700;
  await Promise.race([runR2, new Promise(r => setTimeout(r, 5000))]);
  ok(doneR2, 'reverse gate TERMINATES once the claim window closes (it used to spin on a NaN deadline)');
  ok(statesR.includes('refunding'), 'the gate hands off to the refund path instead of polling forever');
  ok(!seqClaimed, 'the secret is never revealed through a gate that did not pass');
  ok(btcRefunded, 'the maker refunds its own BTC leg instead of waiting forever');
  __test__.setTiming(null);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
