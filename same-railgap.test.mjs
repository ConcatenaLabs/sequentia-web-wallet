// The mixed same-chain shape FAILS CLOSED (spec §"The user's two choices" + §5).
//
// The rails are two independent per-order preferences, four combinations, all first-class —
// including on an asset<->asset pair, where a mixed shape settles P2P as one asset-LN HTLC plus
// one on-chain HTLC bound by a single preimage. The offer protocol cannot yet EXPRESS a per-leg
// rail on a same-chain pair (LightningTerms hard-codes the Lightning leg as BTC), so until it
// can, findRoute must return a shape the composer refuses WITH A NAMED REASON — never 'same',
// the pure on-chain route, which would silently settle on a rail the user did not choose.
// (The regression this pins: setRail used to COUPLE the rails on a same-chain pair, and after
// the coupling was removed the mixed selection fell straight through to 'same'.) Run:
//   node --test same-railgap.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ } from './swap.js';

const { composerRoute, setFeeState } = __test__;

const GOLD = 'aa'.repeat(32), USDX = 'cc'.repeat(32);

function install(){
  initSwap({
    assetMeta: (h) => ({ ticker: String(h).slice(0, 4), precision: 8 }),
    balObj: () => ({}),
    fmtAtoms: (a) => String(a),
    refValueStr: () => '',
    $: () => null,
    el: () => null,
  });
}

test('pay=LN + receive=on-chain on an asset<->asset pair fails CLOSED, never routes on-chain', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'ln', recvRail: 'chain' });
  const r = composerRoute(GOLD, USDX);
  assert.equal(r.kind, 'same-railgap', 'a mixed same-chain shape must refuse by name, not fall through');
  assert.equal(r.payRail, 'ln');
  assert.equal(r.recvRail, 'chain');
});

test('the mirror (pay=on-chain + receive=LN) fails closed the same way', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'chain', recvRail: 'ln' });
  const r = composerRoute(GOLD, USDX);
  assert.equal(r.kind, 'same-railgap');
  assert.equal(r.payRail, 'chain');
  assert.equal(r.recvRail, 'ln');
});

test('both legs on-chain still routes to the covenant book', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'chain', recvRail: 'chain' });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same');
});

test('unselected rails route to the book (placement is gated elsewhere, spec §6.5)', () => {
  // No rail chosen yet: the book must still render (it is rail-blind); setReviewEnabled
  // refuses placement until BOTH rails are chosen, so 'same' here cannot mis-settle.
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: null, recvRail: null });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same');
});

test('one rail chosen, one not: still the book, not a refusal (the CTA gate owns incompleteness)', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'ln', recvRail: null });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same',
    'an incomplete selection is "not chosen yet", not a mixed shape — the place gate blocks it');
});
