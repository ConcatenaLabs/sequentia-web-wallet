// A market order is gated on what the walk executes, not on the ratio of two rounded fields.
//
// Seen live on SILVR/USDX: 0.00353896 USDX for 0.00012179 SILVR at the best offer, 29.05788653
// USDX per SILVR, and Place said "Nothing is resting that crosses your price". The pay field was
// derived from the receive field and rounded to the nearest atom, which on an amount that small
// asks a hair more than the offer gives; the gate compared that ratio with a 1e-9 tolerance and
// refused, though takeMarketWalk fills from the best ask down to the slippage floor whatever the
// last atom of the preview says.
//
//   node --test swap-market-gate.test.mjs
import assert from 'node:assert';
import test from 'node:test';

const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
const { __test__: T } = await import('./swap.js');

// An ask that gives 1 SILVR (1e8 atoms) for 29.05788653 USDX.
const ASK = { offer_amount: '100000000', want_amount: '2905788653' };

test('the rounded preview no longer refuses an order the walk fills', () => {
  // receive 12179 atoms, pay derived to the nearest atom: 353896 (12179 x 29.05788653 = 353895.99)
  const byOrderPrice = T.crossableDepthAtoms([ASK], 353895n, 12179n);
  assert.equal(byOrderPrice, 0n, 'the old gate: one atom under the exact price crosses nothing');
  const floor = T.ratioRecvPerPay(ASK) * (1 - 0.15);
  assert.equal(T.crossableDepthAtoms([ASK], 353895n, 12179n, floor), 2905788653n, 'the market gate: the best ask is within the slippage floor');
});

test('asks past the slippage floor still do not count', () => {
  const worse = { offer_amount: '100000000', want_amount: '4000000000' };   // 40 USDX per SILVR, 27% worse
  const floor = T.ratioRecvPerPay(ASK) * (1 - 0.15);
  assert.equal(T.crossableDepthAtoms([ASK, worse], 1n, 1n, floor), 2905788653n);
});

test('without a floor the order price still decides (Limit previews)', () => {
  assert.equal(T.crossableDepthAtoms([ASK], 2905788653n, 100000000n), 2905788653n);
  assert.equal(T.crossableDepthAtoms([ASK], 2905788653n, 100100000n), 0n, 'asking 0.1% more than the ask gives');
});
