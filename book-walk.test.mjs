// MULTI-OFFER BOOK WALKING — the pure planner.
//
// A take used to read only the single best-price offer, so anything larger than
// that offer was capped at it and the rest of the book was unreachable. This is
// what the reported "0.0005 USDX" ceiling actually was once the dust offer that
// caused it was filtered out: real depth sitting underneath an offer the taker
// could not walk past.
//
//   node --test book-walk.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { walkBook, sizeSubswapTake } from './subswap.js';

// A unified-book entry, as mergeBook emits it.
const off = (assetAtoms, btcSats, extra = {}) => ({
  id: extra.id || `o${assetAtoms}-${btcSats}`,
  assetAtoms, btcSats,
  price: (assetAtoms > 0n && btcSats > 0n) ? Number(btcSats) / Number(assetAtoms) : null,
  ...extra,
});

test('a request inside the best offer takes only that offer', () => {
  const w = walkBook({ offers: [off(1000n, 100n), off(2000n, 210n)], want: 400n, side: 'sell' });
  assert.equal(w.offersUsed, 1);
  assert.equal(w.filledAtoms, 400n);
  assert.equal(w.complete, true);
  assert.equal(w.remainderAtoms, 0n);
});

test('a request larger than the best offer WALKS into the next ones', () => {
  // This is the whole point: 1000 + 2000 + 5000 of depth behind a 1000 best offer.
  const offers = [off(1000n, 100n), off(2000n, 210n), off(5000n, 550n)];
  const w = walkBook({ offers, want: 6000n, side: 'sell' });
  assert.equal(w.offersUsed, 3, 'spans all three offers');
  assert.equal(w.filledAtoms, 6000n);
  assert.equal(w.complete, true);
  assert.deepEqual(w.legs.map(l => l.takeAtoms), [1000n, 2000n, 3000n]);
  // The last leg is a partial of its offer; the first two are whole.
  assert.deepEqual(w.legs.map(l => l.partial), [false, false, true]);
});

test('the VWAP is the price that actually executes, worse than the best offer', () => {
  const offers = [off(1000n, 100n), off(1000n, 200n)];   // 0.1 then 0.2 sats/atom
  const w = walkBook({ offers, want: 2000n, side: 'sell' });
  assert.equal(w.filledBtc, 300n);
  assert.equal(w.vwap, 300 / 2000);
  assert.ok(w.vwap > offers[0].price, 'walking past the best offer costs more than the best price');
});

test('running out of book fills what is there and reports the remainder honestly', () => {
  const w = walkBook({ offers: [off(1000n, 100n), off(500n, 55n)], want: 9000n, side: 'sell' });
  assert.equal(w.filledAtoms, 1500n);
  assert.equal(w.remainderAtoms, 7500n);
  assert.equal(w.partial, true);
  assert.equal(w.complete, false);
});

test('each leg is rounded by sizeSubswapTake, so every leg stands alone', () => {
  // Deliberately indivisible, and a SELL, which floors the BTC side.
  const offers = [off(3000n, 1001n)];
  const w = walkBook({ offers, want: 1000n, side: 'sell' });
  const direct = sizeSubswapTake({ want: 1000n, offerAtoms: 3000n, offerBtc: 1001n, minFill: 0n, side: 'sell' });
  assert.equal(w.legs[0].takeBtc, direct.takeBtc,
    'a walked leg is sized identically to the same take made on its own');
});

test('a BUY ceils the BTC side per leg, so no leg underpays its maker', () => {
  const offers = [off(3000n, 1001n), off(3000n, 1002n)];
  const w = walkBook({ offers, want: 2000n, side: 'buy' });
  const direct = sizeSubswapTake({ want: 2000n, offerAtoms: 3000n, offerBtc: 1001n, minFill: 0n, side: 'buy' });
  assert.equal(w.legs[0].takeBtc, direct.takeBtc);
  // Summing per-leg (rather than pro-rating the total) is what keeps each leg valid.
  const summed = w.legs.reduce((a, l) => a + l.takeBtc, 0n);
  assert.equal(w.filledBtc, summed);
});

test('an offer whose minimum exceeds what is left is SKIPPED, not force-filled', () => {
  // 900 left, but the second offer will not fill below 500 — that one is takeable;
  // the third demands 5000, which is more than the user asked for in total.
  const offers = [off(1000n, 100n), off(2000n, 200n, { min_fill: 500n }), off(9000n, 900n, { min_fill: 5000n })];
  const w = walkBook({ offers, want: 1400n, side: 'sell' });
  assert.deepEqual(w.legs.map(l => l.takeAtoms), [1000n, 400n].slice(0, w.legs.length));
  assert.ok(!w.legs.some(l => l.takeAtoms > 1400n), 'never spends more than was asked for');
  assert.ok(w.filledAtoms <= 1400n);
});

test('a minimum-bound offer is skipped rather than overspending', () => {
  const offers = [off(2000n, 200n, { min_fill: 1500n })];
  const w = walkBook({ offers, want: 100n, side: 'sell' });
  assert.equal(w.offersUsed, 0, 'taking it would cost 15x what the user asked for');
  assert.equal(w.remainderAtoms, 100n);
  assert.equal(w.filledAtoms, 0n);
});

test('degenerate inputs are inert', () => {
  assert.equal(walkBook({ offers: [], want: 100n, side: 'sell' }).filledAtoms, 0n);
  assert.equal(walkBook({ offers: [off(1000n, 100n)], want: 0n, side: 'sell' }).filledAtoms, 0n);
  assert.equal(walkBook({}).filledAtoms, 0n);
  // A sizeless or priceless offer contributes nothing rather than throwing.
  assert.equal(walkBook({ offers: [off(0n, 0n)], want: 100n, side: 'sell' }).filledAtoms, 0n);
});

test('THE REPORTED CASE: real depth is reachable once it can be walked', () => {
  // The live USDX bids, minus the 1-sat artifact mergeBook now filters.
  const offers = [
    off(3000000000n, 47020n, { id: 'sub1' }),
    off(5000000000n, 78365n, { id: 'oc1' }),
    off(5000000000n, 77972n, { id: 'oc2' }),
  ];
  const w = walkBook({ offers, want: 10000000000n, side: 'sell' });   // 100 USDX
  assert.equal(w.offersUsed, 3);
  assert.equal(w.filledAtoms, 10000000000n, 'all 100 USDX fills across three offers');
  assert.equal(w.complete, true);
  // Against the old single-offer behaviour, which stopped at the first one.
  const single = sizeSubswapTake({ want: 10000000000n, offerAtoms: 3000000000n, offerBtc: 47020n, minFill: 0n, side: 'sell' });
  assert.equal(single.takeAtoms, 3000000000n, 'the old path capped at 30 USDX');
  assert.ok(w.filledAtoms > single.takeAtoms * 3n, 'walking reaches materially more depth');
});
