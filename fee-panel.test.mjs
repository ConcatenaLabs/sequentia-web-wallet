// The arithmetic behind the fee section: the four fields (total and rate, in the asset and in the
// reference currency) must agree whichever one is typed, and no asset's decimals are named after
// another's.
//
//   node --test fee-panel.test.mjs
import assert from 'node:assert';
import test from 'node:test';

import { __test__, RATE_BYTES } from './fee-panel.js';
const { rateUnits, rateText, totalFromPerKvb, perKvbFromTotal, unitsToAtoms, atomsToUnits, fmtRefNum, refToAtoms, atomsToRef, btcEstimateFor } = __test__;

test('a rate and the total it comes to round-trip, rounding the total up', () => {
  assert.equal(totalFromPerKvb(100, 250), 25);
  assert.equal(totalFromPerKvb(101, 250), 26);           // 25.25 atoms: never pay under the rate
  assert.equal(perKvbFromTotal(25, 250), 100);
  assert.equal(totalFromPerKvb(100, null), 0);
  assert.equal(perKvbFromTotal(0, 250), 0);
});

test('units are the asset’s own: eight decimals for USDX, none for an indivisible asset', () => {
  assert.equal(atomsToUnits(100, 8), '0.000001');
  assert.equal(atomsToUnits(100.2, 8), '0.00000101');     // atoms round up
  assert.equal(atomsToUnits(7, 0), '7');
  assert.equal(atomsToUnits(0, 8), '0');
  assert.equal(unitsToAtoms('0.000001', 8), 100);
});

test('the reference-currency fields convert through the price of one whole unit', () => {
  // GOLD at 4157.10 USD: 0.00001 GOLD is 0.041571 USD
  assert.ok(Math.abs(atomsToRef(1000, 4157.1, 8) - 0.041571) < 1e-12);
  assert.ok(Math.abs(refToAtoms(0.041571, 4157.1, 8) - 1000) < 1e-6);
  assert.equal(refToAtoms(1, 0, 8), 0);                   // no price: nothing to convert
  assert.equal(atomsToRef(1000, null, 8), null);
});

test('small reference values are written out, never in exponent notation', () => {
  assert.equal(fmtRefNum(0.00000114), '0.00000114');
  assert.equal(fmtRefNum(12.345), '12.35');
  assert.equal(fmtRefNum(0), '0');
  assert.doesNotMatch(fmtRefNum(1.2e-9), /e/);
});

test('a rate is said per bytes in the fee asset, never in satoshis', () => {
  const t = rateText(100, { ticker: 'USDX', precision: 8 }, 1, 'USD');
  assert.equal(t, rateUnits(100, 8) + ' USDX per ' + RATE_BYTES + ' bytes (≈ ' + fmtRefNum(100 * RATE_BYTES / 1000 / 1e8) + ' USD)');
  assert.doesNotMatch(t, /sat|vB/);
  assert.doesNotMatch(rateText(100, { ticker: 'OILX', precision: 8 }, null, 'USD'), /≈/);
});

test('Bitcoin’s recommendation takes the nearest target at least as patient', () => {
  const est = { 1: 12, 3: 6, 6: 4, 144: 1 };
  assert.equal(btcEstimateFor(est, 1), 12);
  assert.equal(btcEstimateFor(est, 2), 6);                // no 2-block estimate: the 3-block one
  assert.equal(btcEstimateFor(est, 12), 1);
  assert.equal(btcEstimateFor({ 144: 1, 504: 1 }, 1), 1); // testnet4 today
  assert.equal(btcEstimateFor({}, 1), null);
  assert.equal(btcEstimateFor(null, 1), null);
});

test('a rate per 100 bytes keeps the tenth of an atom an indivisible asset needs', () => {
  assert.equal(RATE_BYTES, 100);
  assert.equal(rateUnits(100, 8), '0.0000001');     // 100 atoms per 1000 bytes: 10 per 100
  assert.equal(rateUnits(1, 0), '0.1');             // one unit per 1000 bytes, not "0"
  assert.equal(rateUnits(15, 0), '1.5');
  assert.equal(rateUnits(1, 8), '0.000000001');
  assert.equal(rateUnits(0, 8), '0');
});
