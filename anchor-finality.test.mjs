// FINALITY MUST MEAN WHAT THE UI SAYS IT MEANS.
//
// The wallet tells the user: "Appears immediately, final in ~1 block · reverts only if
// Bitcoin reverts." That is the chain's actual model — a Sequentia block is final the
// moment it exists and names a Bitcoin block.
//
// The code did not implement it. anchorDepthVerdict read
//
//   const min = Math.max(2, Number(minAnchorDepth || 0) || 3);
//
// which cannot express the two values that matter: `0 || 3` turns an explicit 0 into 3,
// and the floor of 2 makes 1 unreachable. EVERY offer on the live book advertises
// min_anchor_depth: 0, so the wallet silently overrode every maker and waited 3 BITCOIN
// blocks — roughly half an hour — while the composer promised ~1 block.
//
// Depth counts BITCOIN blocks burying the SEQ block's anchor. Requiring extra burial
// protects against nothing but a Bitcoin reorg, which is the one risk the model already
// states plainly and accepts.
//
//   node --test anchor-finality.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { anchorDepthVerdict } from './subswap.js';

test('THE BUG: an explicit 0 must not become 3', () => {
  const v = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 900000, minAnchorDepth: 0 });
  assert.equal(v.ok, true, 'a 0-depth offer settles on Sequentia finality alone');
  assert.equal(v.zeroConf, true);
  assert.match(v.reason, /reverts only if Bitcoin reverts/);
});

test('an absent/nullish depth also means 0 — that is the default makers advertise', () => {
  for (const d of [undefined, null, '', NaN, -1]) {
    const v = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 900000, minAnchorDepth: d });
    assert.equal(v.ok, true, `depth ${String(d)} must not impose a wait`);
  }
});

test('a depth of 1 is reachable — the old floor of 2 made it impossible', () => {
  const tooShallow = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 899999, minAnchorDepth: 1 });
  assert.equal(tooShallow.ok, false, 'not yet anchored deeply enough');
  const justEnough = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 900000, minAnchorDepth: 1 });
  assert.equal(justEnough.ok, true, 'depth 1 = the anchor block itself');
  assert.equal(justEnough.depth, 1);
});

test('an offer that genuinely WANTS burial still gets it', () => {
  const shallow = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 900001, minAnchorDepth: 6 });
  assert.equal(shallow.ok, false);
  assert.equal(shallow.depth, 2);
  assert.match(shallow.reason, /< required 6/);
  const deep = anchorDepthVerdict({ anchorHeight: 900000, btcTip: 900005, minAnchorDepth: 6 });
  assert.equal(deep.ok, true);
  assert.equal(deep.depth, 6);
});

test('the 0-conf value cap still short-circuits, unchanged', () => {
  const v = anchorDepthVerdict({ anchorHeight: null, btcTip: null, minAnchorDepth: 6,
    legAtoms: 1000n, max0ConfAtoms: 5000 });
  assert.equal(v.ok, true);
  assert.equal(v.zeroConf, true);
  assert.match(v.reason, /0-conf front/);
});

test('a REQUESTED burial still fails closed on unreadable chain state', () => {
  // Only when the offer actually asked for depth: with no anchor height there is
  // nothing to measure, and guessing would defeat the gate the maker asked for.
  const noAnchor = anchorDepthVerdict({ anchorHeight: null, btcTip: 900000, minAnchorDepth: 3 });
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.reason, /not Bitcoin-anchored/);
  const noTip = anchorDepthVerdict({ anchorHeight: 900000, btcTip: null, minAnchorDepth: 3 });
  assert.equal(noTip.ok, false);
  assert.match(noTip.reason, /Bitcoin tip is unreadable/);
});
