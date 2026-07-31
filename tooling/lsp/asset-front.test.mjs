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
