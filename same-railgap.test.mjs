// Mixed same-chain routing (spec §"The user's two choices" + §5): an asset<->asset pair
// with BOTH rails chosen and DIFFERENT routes to the MIXED pipeline — the sub-asset
// construction with the pair's QUOTE asset standing in BTC's structural place (one
// asset-LN HTLC + one on-chain HTLC on the quote asset, bound by one preimage) — and
// NEVER falls through to 'same' (the pure on-chain covenant route), which would settle
// on a rail the user did not choose. Run:
//   node --test same-railgap.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ } from './swap.js';

const { composerRoute, setFeeState } = __test__;

const GOLD = 'aa'.repeat(32);   // ranks as a generic base asset
const USDX = 'cc'.repeat(32);   // ranks as a numeraire (quote) via its ticker

function install(){
  initSwap({
    assetMeta: (h) => (h === USDX ? { ticker: 'USDX', precision: 8 } : { ticker: 'GOLD', precision: 8 }),
    balObj: () => ({}),
    fmtAtoms: (a) => String(a),
    refValueStr: () => '',
    $: () => null,
    el: () => null,
  });
}

test('pay=LN + receive=on-chain on an asset<->asset pair routes MIXED, never on-chain', () => {
  // The user pays the BASE (GOLD) over Lightning and receives the QUOTE (USDX) on-chain:
  // a SELL of the base in the mixed pipeline (payIsBtc=false: not paying the quote side).
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'ln', recvRail: 'chain' });
  const r = composerRoute(GOLD, USDX);
  assert.equal(r.kind, 'mixed', 'a mixed same-chain shape routes through the mixed pipeline');
  assert.equal(r.mixedSame, true);
  assert.equal(r.seqAsset, GOLD, 'base = the non-numeraire');
  assert.equal(r.quoteAsset, USDX, 'quote = the numeraire, standing in BTC\'s structural place');
  assert.equal(r.payIsBtc, false, 'paying the base = a SELL');
  assert.equal(r.payRail, 'ln');
  assert.equal(r.recvRail, 'chain');
});

test('the mirror (pay=on-chain quote + receive=LN base) is a BUY in the same pipeline', () => {
  install();
  setFeeState({ payAsset: USDX, receiveAsset: GOLD, payRail: 'chain', recvRail: 'ln' });
  const r = composerRoute(USDX, GOLD);
  assert.equal(r.kind, 'mixed');
  assert.equal(r.mixedSame, true);
  assert.equal(r.seqAsset, GOLD);
  assert.equal(r.quoteAsset, USDX);
  assert.equal(r.payIsBtc, true, 'paying the quote side = a BUY of the base');
});

test('both legs on-chain still routes to the covenant book', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'chain', recvRail: 'chain' });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same');
});

test('unselected rails route to the book (placement is gated elsewhere, spec §6.5)', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: null, recvRail: null });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same');
});

test('one rail chosen, one not: still the book (the CTA gate owns incompleteness)', () => {
  install();
  setFeeState({ payAsset: GOLD, receiveAsset: USDX, payRail: 'ln', recvRail: null });
  assert.equal(composerRoute(GOLD, USDX).kind, 'same');
});
