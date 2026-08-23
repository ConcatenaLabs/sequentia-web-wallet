// The FILL leaf's signed-64-bit bound, checked client-side BEFORE funding.
//
// Regression: the covenant seeder funded 71 orders on-chain whose offers the relay
// then rejected with "locked N * rate_num M + rate_den-1 overflows the FILL leaf's
// signed 64-bit arithmetic" — the coins were already locked. computeRate reduces
// only by gcd, which does nothing for near-coprime amounts, so the wallet must
// gate on the same bound the Go planners use (pkg/covenant/order.go).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRate, leafProductFits, MAX_LEAF_PRODUCT } from './covenant-flow.js';

test('a near-coprime large order is refused (the exact live failure)', () => {
  // Straight from the relay's rejection: locked 14318443701, rate_num 1842500000.
  const sell = 14318443701n, recv = 14318443701n * 1842500000n / 1000000n;
  const { rateNum, rateDen } = computeRate(sell, recv);
  assert.equal(leafProductFits(sell, rateNum, rateDen), false,
    'an order whose leaf product exceeds 2^63-1 must be refused before funding');
});

test('snapping both legs to a shared granularity makes it fit', () => {
  // The seeder's fix: round both legs so gcd >= the granularity, shrinking rateNum.
  const g = 100000n;
  const sell = (14318443701n / g) * g, recv = (26381717471n / g) * g;
  const { rateNum, rateDen } = computeRate(sell, recv);
  assert.equal(leafProductFits(sell, rateNum, rateDen), true);
});

test('ordinary orders still pass, and the bound is exactly MaxInt64', () => {
  const { rateNum, rateDen } = computeRate(100000000n, 45000000n);
  assert.equal(leafProductFits(100000000n, rateNum, rateDen), true);
  assert.equal(MAX_LEAF_PRODUCT, 9223372036854775807n);
  assert.equal(leafProductFits(MAX_LEAF_PRODUCT, 1n, 1n), true);
  assert.equal(leafProductFits(MAX_LEAF_PRODUCT, 2n, 1n), false);
  assert.equal(leafProductFits(1n, 0n, 1n), false, 'a zero rate is not a valid order');
});
