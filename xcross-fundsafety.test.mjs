// Headless FUND-SAFETY tests for the cross-chain courier rail (xswap.js forward
// taker, xrswap.js reverse taker, xmaker.js maker). Each one fails without the fix
// it names.
//
// The shape of the problem they cover. The asset FUNDER (forward: the maker,
// reverse: the taker) must not commit its asset until its own Sequentia node's
// anchor has reached the height at which the counterparty's BTC leg confirmed —
// otherwise the block confirming its funding commits too low an anchor, the
// claimant's gate refuses it (correctly, and permanently: anchorheight is a
// committed header field), and the asset sits locked until T_seq for nothing.
//
// Introducing that wait created three new ways to lose money, all covered here:
//   1. the wait is long, so the BTC leg can be DOUBLE-SPENT during it, and the
//      funder would then fund against a leg that no longer exists;
//   2. the wait can eat the timelock, so the funder would commit an asset with no
//      claim window left;
//   3. the funder's target was level with the claimant's height, and the claimant
//      derives that height non-atomically, so it could land one HIGHER and refuse
//      a leg that was already funded.
//
// Plus the claim-side reading of an anchor that is not known yet (null), which the
// wallet used to treat as anchor 0 — a TERMINAL "anchored before your lock" — and
// give up on, instead of waiting one more block.
//
// Run: node --test xcross-fundsafety.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ as FWD } from './xswap.js';
import { __test__ as REV } from './xrswap.js';

const big = (v) => BigInt(v);

function installEnv(anchorBody){
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.document = { getElementById: () => null };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/anchor?')) return { ok: true, json: async () => (anchorBody || { ok: true, anchor_height: 142600, anchor_status: 'ok', poscertified: true }) };
    if (u.endsWith('/anchor'))   return { ok: true, json: async () => ({ ok: true, height: 16500, anchor_status: 'ok' }) };
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

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
// REVERSE taker (the asset funder on that side).
// ===========================================================================
const ASSET = 'GOLDASSET';
const WHOLE_SEQ = 5000000n, WHOLE_BTC = 25001n;
const T_BTC = 142700, T_SEQ = 16740, CONF_H = 142600;
const R_HASH = 'ef'.repeat(32);
const R_TAKER_BTC_CLAIM = '02tbc', R_TAKER_SEQ_REFUND = '02tsr', R_MAKER_SEQ_CLAIM = '02msc', R_MAKER_BTC_REFUND = '02mbr';
const redeemOf = (h, claim, ref, lock) => `R:${h}:${claim}:${ref}:${lock}`;

// chain is a mutable model of what the taker's node reports, so a test can move
// the world underneath a wait that is deliberately unbounded in wall-clock time.
function reverseCtx(session, chain){
  const state = {
    fundCalls: [], legAnchorAsked: [],
    chain: Object.assign({
      anchorTip: CONF_H + 8, anchorOk: true,
      seqTip: T_SEQ - 400, btcTip: CONF_H,
      btcLegPresent: true, btcLegHeight: CONF_H, btcLegValue: 7500,
      legBlockAnchor: CONF_H + 8,
    }, chain || {}),
  };
  const c = state.chain;
  const C = {
    SEQOB: '/seqob',
    $: () => null, el: () => ({}),
    assetMeta: () => ({ ticker: 'GOLD', precision: 8 }),
    fmtAtoms: (v) => String(v),
    prettyErr: (e) => String((e && e.message) || e),
    toast: () => {},
    setStepStatus: () => {},
    openCourierSession: async () => session,
    anchorTipStatus: async () => ({ height: c.anchorTip, ok: c.anchorOk }),
    anchorHeightOf: async (h) => { state.legAnchorAsked.push(h); return c.legBlockAnchor; },
    seqTip: async () => c.seqTip,
    btcTip: async () => c.btcTip,
    wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeemOf(h, claim, ref, lock) },
    btcLeg: {
      claimKey: () => ({ public_key: R_TAKER_BTC_CLAIM, secret_hex: '33'.repeat(32) }),
      findFunding: async () => {
        if (!c.btcLegPresent) throw new Error('no such funding output (double-spent)');
        return { confirmed: true, height: c.btcLegHeight, vout: 0, value: c.btcLegValue };
      },
      claim: async () => 'btcclaimtxid',
    },
    seqLeg: {
      refundKey: () => ({ public_key: R_TAKER_SEQ_REFUND, secret_hex: '44'.repeat(32) }),
      fund: async (redeem, asset, amount) => { state.fundCalls.push({ redeem, asset, amount: big(amount) }); return { txid: 'seqfundtxid' }; },
      waitConf: async () => ({ vout: 0, height: 16700, block_hash: 'seqblk' }),
    },
    wollet: { address: () => ({ address: () => ({ toUnconfidential: () => ({ scriptPubkey: () => ({ bytes: () => [0x00, 0x14, 0xaa] }) }) }) }) },
  };
  return { C, state };
}

function reverseQuote(takeSeq){
  const offer = { offer_id: 'roff1', maker_pubkey: 'rmk1', offer_asset: 'BTC',
    offer_amount: String(WHOLE_BTC), want_amount: String(WHOLE_SEQ), base_amount: String(WHOLE_SEQ) };
  return { reverse: true, offer, market: { btc_asset: '', seq_asset: ASSET, name: 'BTC / GOLD' },
    seq_amount: takeSeq, btc_amount: 0n, fee_btc: 0n };
}
function reverseBtcLockedMsg(btcAmount, seqAmount){
  const legRedeem = redeemOf(R_HASH, R_TAKER_BTC_CLAIM, R_MAKER_BTC_REFUND, T_BTC);
  return { type: 'btc_leg_locked', hash_h: R_HASH, maker_seq_claim_pub: R_MAKER_SEQ_CLAIM, maker_refund_pub: R_MAKER_BTC_REFUND,
    seq_locktime: T_SEQ, btc_amount: btcAmount, seq_amount: seqAmount, fee_btc: 0,
    leg: { txid: 'mkbtc', vout: 0, amount: btcAmount, redeem_script: legRedeem, locktime: T_BTC } };
}
const TAKE = 1500000n;
const WANT_BTC = 7500n;   // floor(25001 * 1.5e6 / 5e6)

// HOLE 1. The anchor wait sits between "we verified the maker's BTC leg" and "we
// fund our asset". A single parent-chain reorg in that window lets the maker
// double-spend the input it funded with — and the taker would hand over the asset
// for a BTC HTLC that no longer exists. Re-verifying immediately before funding is
// the only thing that stops it.
test('REVERSE: the BTC leg is double-spent DURING the anchor wait — the asset is never funded', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session, failCalls } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  // Our anchor lags, so we park in the wait; while parked the maker's leg vanishes,
  // and only then does the anchor catch up.
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H - 2 });
  REV.initXrswap(C); REV.clearSwap();
  setTimeout(() => { state.chain.btcLegPresent = false; }, 30);
  setTimeout(() => { state.chain.anchorTip = CONF_H + 8; }, 70);

  await REV.driveReverse(reverseQuote(TAKE));

  assert.equal(state.fundCalls.length, 0,
    'the asset leg must NOT be funded against a BTC leg that was double-spent during the wait');
  assert.ok(failCalls.some(f => f.code === 'btc_leg_gone'), 'the maker is told why, plainly');
  const swap = REV.getSwap();
  assert.ok(!swap || !swap.seq_leg, 'no asset leg was recorded');
  REV.setTiming(null);
});

// Same class, different symptom: the leg is still there but in a DIFFERENT block.
// A fork resolution, not a theft: the outpoint, script and amount still verify at
// the new height. The old contract failed the swap here, which on a bursty parent
// chain (testnet4 re-mines the last block or two on every fork resolution) killed
// three consecutive healthy takes at the finish line. The move DOES invalidate the
// anchor precondition just satisfied, so the driver re-runs the anchor wait against
// the height the leg ACTUALLY sits at, re-verifies, and only then funds — once.
test('REVERSE: the BTC leg moves to a different block during the wait — the gate re-runs at the new height, then funds', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session, failCalls } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H - 2 });
  REV.initXrswap(C); REV.clearSwap();
  setTimeout(() => { state.chain.btcLegHeight = CONF_H + 1; }, 30);
  setTimeout(() => { state.chain.anchorTip = CONF_H + 8; }, 70);   // clears the NEW height + 1 too

  await REV.driveReverse(reverseQuote(TAKE));

  assert.equal(state.fundCalls.length, 1,
    'a re-mined leg that still verifies is funded once the anchor clears its new height');
  assert.ok(!failCalls.some(f => f.code === 'btc_leg_gone'),
    'a mere re-mine must not be reported as a dead leg');
  REV.setTiming(null);
});

// The companion bound: if the anchor never clears the NEW height before the
// timelock, the re-run gate ends at the protocol deadline — nothing is funded.
test('REVERSE: a re-mined leg whose new height the anchor never clears is not funded', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H - 2 });
  REV.initXrswap(C); REV.clearSwap();
  setTimeout(() => { state.chain.btcLegHeight = CONF_H + 3; }, 30);
  setTimeout(() => { state.chain.anchorTip = CONF_H + 1; }, 50);        // clears the OLD height only
  setTimeout(() => { state.chain.seqTip = T_SEQ - 120; }, 120);         // then the claim window runs down

  await REV.driveReverse(reverseQuote(TAKE));

  assert.equal(state.fundCalls.length, 0, 'nothing funded while the anchor sits below the re-mined height');
  REV.setTiming(null);
});

// HOLE 3. Owner ruling (Andreas, 2026-07-25): "we should let users decide if the
// wait is intolerable and they want to cancel the trade (putting the makers order
// back to rest), rather than cancel it automatically. We cannot really predict how
// long contested blocks will take to clear anyway."
//
// So no wall clock may end the wait. The ONLY automatic stop is the protocol
// deadline: the point past which a leg funded now could not be claimed before
// T_seq. This test keeps the anchor stuck forever and proves (a) the wait outlives
// any plausible flat timeout, and (b) it ends the moment the timelock says so.
test('REVERSE: the anchor wait ends at the TIMELOCK, never on a wall clock', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H - 2 });   // stuck, forever
  REV.initXrswap(C); REV.clearSwap();

  let settled = false;
  const run = REV.driveReverse(reverseQuote(TAKE)).then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 250));
  assert.equal(settled, false, 'the wait must still be running while the claim window is open');
  assert.equal(state.fundCalls.length, 0, 'and nothing is funded while it waits');

  // T_seq is 16740 and the claim window is 120 blocks: at 16620 funding is unsafe.
  state.chain.seqTip = T_SEQ - 120;
  await run;
  assert.equal(state.fundCalls.length, 0, 'the asset is never funded once the claim window has gone');
  const swap = REV.getSwap();
  assert.ok(swap && /less than 120 blocks|could not be taken in time/.test(String(swap.detail || '')),
    'the reason names the timelock, not a timeout: ' + (swap && swap.detail));
  REV.setTiming(null);
});

// HOLE 4. The maker derives our BTC-leg height from two separate reads (its tip,
// then the confirmation count). A Bitcoin block landing between them yields a
// height one HIGHER than we measured, and its gate would then refuse a leg we had
// already funded. Waiting longer is never unsafe, so the funder aims one block
// ABOVE the leg height and absorbs the race.
test('REVERSE: the funder aims ABOVE the BTC-leg height, not level with it', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  // Anchor sits EXACTLY at the leg height — which the level target accepted.
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H });
  REV.initXrswap(C); REV.clearSwap();

  let settled = false;
  const run = REV.driveReverse(reverseQuote(TAKE)).then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(settled, false, 'an anchor merely LEVEL with the BTC-leg height must not release the funding');
  assert.equal(state.fundCalls.length, 0, 'nothing funded at a level anchor');

  state.chain.anchorTip = CONF_H + 1;   // one above: now it may fund
  await run;
  assert.equal(state.fundCalls.length, 1, 'funds once the anchor clears the leg height by one');
  REV.setTiming(null);
});

// HOLE 5. The reverse asset funder had NO post-funding assertion: it read the leg
// block's anchor, shrugged a failure off with `anchor_height = 0`, and announced
// anyway. Announcing an under-anchored leg invites the maker to claim the one leg
// that can outlive its own BTC leg — the taker's money. It must withhold instead,
// and keep the T_seq refund path (seq_leg recorded) so the asset is recoverable.
test('REVERSE: an under-anchored asset leg is WITHHELD, not announced, and stays refundable', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session, sent, failCalls } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  // The node reports a caught-up tip (so we fund), but the block that actually
  // confirms the funding commits an anchor BELOW the maker's BTC leg.
  const { C, state } = reverseCtx(session, { anchorTip: CONF_H + 8, legBlockAnchor: CONF_H - 2 });
  REV.initXrswap(C); REV.clearSwap();

  await REV.driveReverse(reverseQuote(TAKE));

  assert.equal(state.fundCalls.length, 1, 'the funding did happen (the reorg landed it under-anchored)');
  assert.ok(!sent.some(m => m.type === 'seq_leg_funded'),
    'the under-anchored leg must NOT be announced to the maker');
  assert.ok(failCalls.some(f => f.code === 'seq_leg_underanchored'),
    'an honest maker is told plainly not to claim it');
  const swap = REV.getSwap();
  assert.ok(swap && swap.seq_leg && swap.seq_leg.txid,
    'the leg is still recorded, so the T_seq refund off-ramp can recover it');
  REV.stopPoll();
  REV.setTiming(null);
});

// The honest path, for contrast: a well-anchored leg IS announced, and it carries
// the block's REAL Bitcoin anchor. The old code put `conf.height` on the wire —
// the Sequentia block height, an entirely different number.
test('REVERSE: a well-anchored leg is announced with the block’s REAL Bitcoin anchor', async () => {
  installEnv();
  REV.setTiming({ anchorPollMs: 5 });
  const { session, sent, failCalls } = scriptedSession([reverseBtcLockedMsg(Number(WANT_BTC), Number(TAKE))]);
  const { C, state } = reverseCtx(session, { legBlockAnchor: CONF_H + 3 });
  REV.initXrswap(C); REV.clearSwap();

  await REV.driveReverse(reverseQuote(TAKE));

  const funded = sent.find(m => m.type === 'seq_leg_funded');
  assert.ok(funded, 'the leg was announced');
  assert.equal(funded.leg.anchor_height, CONF_H + 3,
    'anchor_height is the block’s Bitcoin anchor (not its Sequentia height 16700)');
  assert.equal(failCalls.length, 0, 'no fail note on the honest path');
  assert.equal(state.fundCalls.length, 1, 'funded exactly once');
  REV.stopPoll();   // the settle driver's interval would otherwise hold the process open
  REV.setTiming(null);
});

// ===========================================================================
// FORWARD claim gate (xswap.js): a NULL anchor means "not known yet", never 0.
// ===========================================================================
//
// HOLE 7. The LSP answers {ok:true, anchor_height:null} while the node does not
// know the leg's tx yet. Number(null) is 0 — and 0 IS finite, so the old
// Number.isFinite guard let it through as anchor 0. Anchor 0 reads as "confirmed,
// but anchored BELOW your BTC lock", the TERMINAL unsafe verdict: a leg that had
// simply not confirmed yet was condemned, and the wait gave up on the spot.
test('FORWARD: a null anchor_height means UNKNOWN (wait), never anchor 0 (terminally unsafe)', async () => {
  installEnv({ ok: true, anchor_height: null, anchor_status: 'ok' });
  FWD.setSwap({
    state: FWD.ST.SEQ_LOCKED,
    market: { seq_asset: ASSET },
    btc_leg: { txid: 'btcleg', vout: 0, height: CONF_H, amount: 25000n },
    seq_leg: { txid: 'seqleg', vout: 0, asset_id: ASSET, amount: 5000000n, block_hash: '' },
    btc_locktime: T_BTC, seq_locktime: T_SEQ,
  });

  const ev = await FWD.fetchLegAnchorEvidence();
  assert.equal(ev.anchor, -1, 'an absent anchor is reported as UNKNOWN (-1), not as 0');

  const gate = await FWD.verifyAnchorFull();
  assert.equal(gate.ok, false, 'still not claimable');
  assert.equal(gate.unconfirmed, true, 'and it takes the WAIT path…');
  assert.ok(!gate.unsafe, '…never the terminal "anchored before your lock" verdict');
  FWD.clearSwap();
});

// And the genuine unsafe case is unchanged: a real anchor BELOW the BTC-leg height
// is terminal, and no amount of waiting may soften it. This is the property the
// null fix must not have widened.
test('FORWARD: a real anchor below the BTC-leg height stays TERMINALLY unsafe', async () => {
  installEnv({ ok: true, anchor_height: CONF_H - 2, anchor_status: 'ok', poscertified: true });
  FWD.setSwap({
    state: FWD.ST.SEQ_LOCKED,
    market: { seq_asset: ASSET },
    btc_leg: { txid: 'btcleg', vout: 0, height: CONF_H, amount: 25000n },
    seq_leg: { txid: 'seqleg', vout: 0, asset_id: ASSET, amount: 5000000n, block_hash: 'blk' },
    btc_locktime: T_BTC, seq_locktime: T_SEQ,
  });

  const gate = await FWD.verifyAnchorFull();
  assert.equal(gate.ok, false, 'refused');
  assert.ok(gate.unsafe, 'and refused TERMINALLY — the leg block’s anchor is a committed header field');
  FWD.clearSwap();
});
