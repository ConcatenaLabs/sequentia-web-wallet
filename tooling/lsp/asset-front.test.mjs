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
