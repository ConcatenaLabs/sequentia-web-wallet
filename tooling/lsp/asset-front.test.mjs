// BRIDGED-RAIL ASSET FRONTING — when the LSP may deliver the asset from its own
// inventory instead of making the taker wait for the maker's anchor gate.
//
// A taker paying BTC over Lightning should always be matched with the best price,
// whatever rail it rests on, and should never be slowed down by that choice. The
// bridge already holds the taker's LN instantly; fronting closes the other half by
// locking the LSP's own asset to the taker on the SAME hash H.
//
// The load-bearing rule is the one that keeps it from being a fund-loss vector:
// fronting publishes P (the taker claims OUR leg), so it must never happen while a
// BTC HTLC is funded on that same H — a maker holding nothing could then sweep it.
//
//   node --test tooling/lsp/asset-front.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { decideAssetFront } from './leg-bridge.mjs';

const ok = {
  btcHtlcFunded: false, frontWallet: 'lsp-inventory', wantAtoms: 1_000_000_000,
  inventoryAtoms: 5_000_000_000, maxAtoms: 0, claimPub: '02'.repeat(33), tSeq: 61_334,
};

test('inventory covering the leg arms the front', () => {
  const v = decideAssetFront(ok);
  assert.equal(v.armed, true);
  assert.match(v.reason, /anchor gate/);
});

test('THE INVARIANT: a funded BTC HTLC on H forbids fronting outright', () => {
  // Fronting makes the taker claim OUR leg, which publishes P. A maker that has
  // locked nothing could then spend the BTC HTLC's claim branch with that P — the
  // LSP would be out both the asset and the BTC. No amount of inventory excuses it.
  const v = decideAssetFront({ ...ok, btcHtlcFunded: true, inventoryAtoms: 1e18 });
  assert.equal(v.armed, false, 'fronting over a funded BTC HTLC is an unrecoverable loss');
  assert.match(v.reason, /sweep that BTC for free/);
});

test('short inventory declines rather than promising an instant fill', () => {
  const v = decideAssetFront({ ...ok, inventoryAtoms: ok.wantAtoms - 1 });
  assert.equal(v.armed, false);
  assert.match(v.reason, /inventory/);
});

test('an unreadable inventory reads as zero and declines', () => {
  // frontableSeqAtoms returns 0 on any node error, so this is the shape of an
  // unreachable node: decline to the slower maker path, never a false promise.
  const v = decideAssetFront({ ...ok, inventoryAtoms: 0 });
  assert.equal(v.armed, false);
});

test('no configured wallet disables fronting entirely', () => {
  const v = decideAssetFront({ ...ok, frontWallet: '' });
  assert.equal(v.armed, false);
  assert.match(v.reason, /no front wallet/);
});

test('the per-leg cap bounds how much one trade can expose', () => {
  const capped = decideAssetFront({ ...ok, maxAtoms: ok.wantAtoms - 1 });
  assert.equal(capped.armed, false);
  assert.match(capped.reason, /cap/);
  // At or under the cap it still arms, so the cap bounds rather than blocks.
  assert.equal(decideAssetFront({ ...ok, maxAtoms: ok.wantAtoms }).armed, true);
  assert.equal(decideAssetFront({ ...ok, maxAtoms: 0 }).armed, true, '0 means uncapped');
});

test('incomplete handshake terms decline — a leg is never built on a missing term', () => {
  for (const bad of [{ claimPub: '' }, { tSeq: 0 }, { wantAtoms: 0 }]) {
    const v = decideAssetFront({ ...ok, ...bad });
    assert.equal(v.armed, false, `armed on ${JSON.stringify(bad)}`);
    assert.match(v.reason, /incomplete bridge terms/);
  }
});

test('degenerate input is inert rather than throwing', () => {
  assert.equal(decideAssetFront().armed, false);
  assert.equal(decideAssetFront({}).armed, false);
});

test('the BTC-HTLC refusal outranks every other reason', () => {
  // Whatever else is wrong, a funded BTC HTLC must be the answer given — it is the
  // only one of these that is a loss rather than a slowdown.
  const v = decideAssetFront({ btcHtlcFunded: true, frontWallet: '', wantAtoms: 0, claimPub: '', tSeq: 0 });
  assert.equal(v.armed, false);
  assert.match(v.reason, /BTC HTLC is already funded/);
});

// ── THE HAND-OFF SHAPE ────────────────────────────────────────────────────────
// A fronted leg the taker cannot verify is worse than no leg at all: the LSP's
// asset is already locked on-chain and the taker refuses to claim, so the trade
// fails and the inventory is stuck until T_seq. Caught live — the first fronted
// take died on "locktime must be a positive block height" because the hand-off
// object had dropped that key.
import { frontedLegHandoff } from './leg-bridge.mjs';

const FUNDED = { txid: 'ab'.repeat(32), vout: 1, amount: 1_000_000_000,
  redeem_script: '63a820aa', t_seq: 61_171, block_hash: '' };

test('the hand-off carries every field the taker re-verifies against', () => {
  const h = frontedLegHandoff({ leg: FUNDED, asset: 'cd'.repeat(32), tSeq: 61_171 });
  // verifySeqLeg rebuilds the redeem script from H + claim key + refund key + LOCKTIME
  // and re-checks the asset and amount. Every one of these must survive the hand-off.
  for (const k of ['txid', 'vout', 'amount', 'asset', 'redeem_script', 'locktime', 'block_hash', 'anchor_height'])
    assert.ok(k in h, `hand-off dropped ${k} — the taker cannot verify the leg and will not claim it`);
  assert.equal(h.locktime, 61_171, 'the locktime is what the failure was');
  assert.equal(h.asset, 'cd'.repeat(32));
  assert.equal(h.amount, 1_000_000_000);
});

test('the locktime falls back to the session T_seq when the CLI omits it', () => {
  const h = frontedLegHandoff({ leg: { ...FUNDED, t_seq: undefined }, asset: 'cd'.repeat(32), tSeq: 61_171 });
  assert.equal(h.locktime, 61_171);
});

test('a 0-conf front hands over an empty block_hash rather than undefined', () => {
  // -no-wait returns before the funding tx is in a block. The anchor gate reads
  // block_hash; undefined would read as a missing field rather than "not yet mined".
  const h = frontedLegHandoff({ leg: FUNDED, asset: 'cd'.repeat(32), tSeq: 61_171 });
  assert.equal(h.block_hash, '');
  assert.equal(typeof h.block_hash, 'string');
});

test('a locktime that never resolves is 0, not NaN — it fails the check loudly', () => {
  const h = frontedLegHandoff({ leg: { ...FUNDED, t_seq: undefined }, asset: 'x', tSeq: 0 });
  assert.equal(h.locktime, 0, '0 trips the taker positive-height check; NaN would be murkier');
  assert.ok(!Number.isNaN(h.locktime));
});

// ── RECOUPING A FRONTED LEG ───────────────────────────────────────────────────
// A fronted job funds NO BTC HTLC, so the whole BTC recoup/refund/release decision
// has nothing to read. Before this branch existed the job never reached
// recoup-settle: the taker claimed the asset and the LSP's hold quietly expired,
// losing the fronted inventory outright — the one outcome fronting must not have.
import { nextBridgeStep } from './leg-bridge.mjs';

const FRONTED = { lnSide: 'payer', amountSat: 6000, unit: 'btc', bridge: true,
  fronted: true, assetRefundHeight: 61_500 };
const obs = (ln, extra = {}) => ({ tip: 900, onchain: null, ln, ...extra });

test('P public means the taker claimed our leg — settle the hold', () => {
  const s = nextBridgeStep(FRONTED, obs({ held: true, settled: false, preimage: 'ab'.repeat(32) }));
  assert.equal(s.action, 'recoup-settle');
  assert.match(s.reason, /fronted/);
});

test('no BTC HTLC no longer means no decision — it waits, it does not stall forever', () => {
  const s = nextBridgeStep(FRONTED, obs({ held: true, settled: false, preimage: null }), {});
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /awaiting the claim/);
});

test('an unclaimed front past T_seq reclaims the asset', () => {
  const s = nextBridgeStep(FRONTED, obs({ held: true, settled: false, preimage: null }, { assetTip: 61_500 }));
  assert.equal(s.action, 'refund-onchain', 'the asset must come back to the LSP once the claim window closes');
  assert.match(s.reason, /T_seq/);
});

test('before T_seq an unclaimed front waits rather than reclaiming early', () => {
  // Reclaiming while the taker can still legitimately claim would race its claim.
  const s = nextBridgeStep(FRONTED, obs({ held: true, settled: false, preimage: null }, { assetTip: 61_499 }));
  assert.equal(s.action, 'wait');
});

test('a settled hold is terminal for a fronted job too', () => {
  const s = nextBridgeStep(FRONTED, obs({ held: true, settled: true, preimage: 'ab'.repeat(32) }));
  assert.equal(s.action, 'done');
});

test('a NON-fronted payer leg is untouched by the fronted branch', () => {
  // The BTC-HTLC path must behave exactly as before for a normal bridged take.
  const normal = { lnSide: 'payer', amountSat: 6000, unit: 'btc', bridge: true, fronted: false };
  const s = nextBridgeStep(normal, obs({ held: true, settled: false, preimage: 'ab'.repeat(32) }));
  assert.notEqual(s.action, 'recoup-settle',
    'a non-fronted leg must still key its recoup on the BTC HTLC, not on P alone');
});

// ── THE HOLD GATE (F0/F1) ─────────────────────────────────────────────────────
// The fronted asset's only recompense is settling the taker's held BTC-LN with
// the P its claim reveals. So the hold must be WORTH the leg (F0 — holdinvoice
// marks HELD on the first HTLC regardless of amount) and must OUTLIVE the leg's
// whole claim horizon (F1 — the taker may claim as late as just before T_seq;
// a claim into a dead hold delivers the asset and recoups nothing).
import { checkAssetFrontGate, HOLD_LIFE_DEFAULTS, requiredTakerHold } from './leg-bridge.mjs';

// T_seq 240 SEQ blocks out (the honest fleet's resting delta). requiredTakerHold
// sizes the front-HTLC/hold coverage from it — reuse it so the test tracks the
// one shared sizing rather than hard-coding a second copy of the arithmetic.
const GATE = { btcTip: 90_000, seqTip: 61_000, seqRefundHeight: 61_240,
  heldAmountSat: 80_000, orderedAmountSat: 80_000 };
const REQ_BLOCKS = requiredTakerHold({ seqTip: GATE.seqTip, seqRefundHeight: GATE.seqRefundHeight }).minFinalCltvBlocks;

test('a hold that covers the price and the claim horizon arms the gate', () => {
  const v = checkAssetFrontGate({ ...GATE, incomingHtlcExpiry: GATE.btcTip + REQ_BLOCKS });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.requiredTakerBlocks, REQ_BLOCKS);
});

test('F1: a hold that cannot outlive the claim horizon refuses to front', () => {
  // One block short of the required coverage: the taker could claim the front at
  // T_seq-1, reveal P, and the hold would already be dead — asset gone, nothing
  // settled. This is THE task-critical refusal.
  const v = checkAssetFrontGate({ ...GATE, incomingHtlcExpiry: GATE.btcTip + REQ_BLOCKS - 1 });
  assert.equal(v.ok, false, 'a short hold must never be fronted against');
  assert.match(v.reason, /below the \d+ needed to stay settleable/);
  assert.match(v.reason, /nothing fronted/i);
});

test('F0: a token payment does not draw the full asset leg', () => {
  // holdinvoice marks HELD on the FIRST incoming HTLC regardless of amount.
  const v = checkAssetFrontGate({ ...GATE, incomingHtlcExpiry: GATE.btcTip + REQ_BLOCKS, heldAmountSat: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /below the ordered 80000 sat/);
});

test('unreadable facts fail closed, never front on a guess', () => {
  for (const bad of [{ btcTip: NaN }, { incomingHtlcExpiry: NaN }, { seqTip: NaN },
    { seqRefundHeight: NaN }, { heldAmountSat: NaN }, { orderedAmountSat: NaN }]) {
    const v = checkAssetFrontGate({ ...GATE, incomingHtlcExpiry: GATE.btcTip + REQ_BLOCKS, ...bad });
    assert.equal(v.ok, false, `armed on ${JSON.stringify(bad)}`);
    assert.match(v.reason, /not a finite number/);
  }
});

test('a timestamp CLTV is refused — the gate does height arithmetic', () => {
  const v = checkAssetFrontGate({ ...GATE, incomingHtlcExpiry: 500_000_001 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /UNIX TIMESTAMP/);
});

test('the T_seq min/max bound rides along via requiredTakerHold', () => {
  // A collapsed T_seq (margin-collapse / self-trade guard) must refuse the front
  // exactly as it refuses the BTC branch.
  const near = checkAssetFrontGate({ ...GATE, seqRefundHeight: GATE.seqTip + HOLD_LIFE_DEFAULTS.minTseqBlocks - 1,
    incomingHtlcExpiry: GATE.btcTip + 2016 });
  assert.equal(near.ok, false);
  assert.match(near.reason, /below the min/);
});

// ── HONEST FALLBACK FIELDS ────────────────────────────────────────────────────
// When the LSP cannot front, the job must SAY what path it is on and what the
// user is actually waiting for — never an unexplained spinner.
import { frontModeFields } from './leg-bridge.mjs';

test('insufficient inventory falls back to maker-first with honest fields', () => {
  // The task-mandated composition: the inventory gate declines, and the fields a
  // wallet surfaces say maker-first + bitcoin-confirmations, carrying the reason.
  const verdict = decideAssetFront({ ...ok, inventoryAtoms: ok.wantAtoms - 1 });
  assert.equal(verdict.armed, false);
  const f = frontModeFields(verdict);
  assert.equal(f.front_mode, 'maker-first');
  assert.equal(f.expected_wait, 'bitcoin-confirmations');
  assert.match(f.front_reason, /inventory/);
});

test('a fronted job carries no wait at all', () => {
  const f = frontModeFields({ armed: true, reason: 'covered' });
  assert.equal(f.front_mode, 'fronted');
  assert.equal(f.expected_wait, null, 'a fronted leg is claimable now — advertising a wait would be a lie');
  assert.ok(f.front_reason);
});

test('the field vocabulary is exactly what wallets key on', () => {
  // These two strings are the wire contract; a drift here silently breaks every
  // wallet that switches copy on them.
  assert.deepEqual(
    [frontModeFields({ armed: true }).front_mode, frontModeFields({ armed: false }).front_mode],
    ['fronted', 'maker-first']);
  assert.equal(frontModeFields({ armed: false }).expected_wait, 'bitcoin-confirmations');
});

// ── REPLENISH DECISION ────────────────────────────────────────────────────────
// A front drains inventory; the maker settlement completes as the LSP's OWN
// atomic take (own hash — never the taker's H, where a standing BTC HTLC would
// be sweepable once P is public). The decision to start it is pure and bounded.
import { decideReplenish } from './leg-bridge.mjs';

const REPL = { enabled: true, alreadyStarted: false, offerId: 'of1', makerPubkey: '02'.repeat(33),
  atoms: 1_000_000_000, liveCount: 0, maxConcurrent: 3 };

test('a delivered front with a live offer identity starts a replenish take', () => {
  const d = decideReplenish(REPL);
  assert.equal(d.start, true);
  assert.match(d.reason, /own hash/);
});

test('replenish never double-takes: a recorded attempt refuses another', () => {
  const d = decideReplenish({ ...REPL, alreadyStarted: true });
  assert.equal(d.start, false);
  assert.match(d.reason, /never take the offer twice/);
});

test('the concurrency cap bounds the BTC the LSP locks as principal', () => {
  assert.equal(decideReplenish({ ...REPL, liveCount: 3 }).start, false);
  assert.equal(decideReplenish({ ...REPL, liveCount: 2 }).start, true);
  assert.equal(decideReplenish({ ...REPL, maxConcurrent: 0 }).start, false, '0 disables, never unbounded');
});

test('no offer identity / nothing to restock / disabled all skip harmlessly', () => {
  for (const bad of [{ offerId: '' }, { makerPubkey: '' }, { atoms: 0 }, { enabled: false }]) {
    const d = decideReplenish({ ...REPL, ...bad });
    assert.equal(d.start, false, `started on ${JSON.stringify(bad)}`);
  }
});

test('degenerate input is inert (skip), never a throw', () => {
  assert.equal(decideReplenish().start, false);
  assert.equal(decideReplenish({}).start, false);
});
