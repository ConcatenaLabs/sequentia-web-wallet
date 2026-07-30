// AN UNSIZED TAKE MUST BE REFUSED, NOT SILENTLY GROWN TO THE WHOLE OFFER.
//
// startLspPayerBridge built its order as
//
//   asset_atoms: String(disp.takeAtoms || disp.offer.assetAtoms || 0)
//   btc_sats:    String(disp.takeBtc   || disp.offer.btcSats   || 0)
//
// so whenever the sized take was missing or zero, the wallet fell back to the ENTIRE
// resting offer. Observed live: the composer quoted 4 USDX for 6279 sats and the record
// that got built asked for 78558 sats — the whole 50 USDX offer, 12.5x the order, behind
// a review screen still showing 4 USDX. It only failed to execute because a later step
// happened to break.
//
// "If I do not know the size, buy everything" is never the right default for an order.
//
//   node --test sized-take.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ as SW } from './swap.js';

function install(){
  initSwap({ assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: String,
    $: () => null, el: () => null, balObj: () => ({}), feeRates: {} });
}

const WHOLE = { assetAtoms: 5000000000n, btcSats: 78558n, id: 'o1', maker: 'm1' };

test('a properly sized take passes through untouched', () => {
  install();
  const s = SW.sizedTake({ takeAtoms: 400000000n, takeBtc: 6279n, offer: WHOLE });
  assert.equal(s.atoms, 400000000n);
  assert.equal(s.btc, 6279n);
});

test('THE BUG: a missing size must THROW, not become the whole offer', () => {
  install();
  for (const disp of [
    { offer: WHOLE },                                   // no take at all
    { takeAtoms: 0n, takeBtc: 0n, offer: WHOLE },       // zeroed
    { takeAtoms: 400000000n, offer: WHOLE },            // half-sized: atoms only
    { takeBtc: 6279n, offer: WHOLE },                   // half-sized: btc only
    { takeAtoms: 400000000n, takeBtc: 0n, offer: WHOLE },
  ]) {
    assert.throws(() => SW.sizedTake(disp), /could not be sized/,
      `must refuse rather than silently order ${WHOLE.assetAtoms} atoms`);
  }
});

test('the refusal never returns the offer size by any path', () => {
  install();
  for (const disp of [{ offer: WHOLE }, { takeAtoms: 0n, takeBtc: 0n, offer: WHOLE }]) {
    let out = null;
    try { out = SW.sizedTake(disp); } catch { /* expected */ }
    assert.equal(out, null, 'a bad size must yield nothing at all');
  }
});

test('a degenerate disp is refused rather than throwing something unreadable', () => {
  install();
  assert.throws(() => SW.sizedTake(null), /could not be sized/);
  assert.throws(() => SW.sizedTake({}), /could not be sized/);
});
