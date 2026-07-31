// SELLING INBOUND LIQUIDITY — the price the user is quoted.
//
// Inbound is capital the LP locks up on the user's behalf for the life of the channel, so it is
// sold rather than given away. The shape follows Phoenix (ACINQ): a percentage of the requested
// amount, with a floor, over a bounded range.
//
// The Sequentia difference is that this is NOT BTC-only. Inbound is sold in whatever asset it is
// denominated in — native BTC and every LSP-supported asset alike — and charged in THAT asset, so
// buying capacity never requires holding some other asset first. That is the no-privileged-asset
// principle applied to liquidity: only the FLOOR differs by kind, because a satoshi and an asset
// atom are not comparable quantities.
//
//   node --test tooling/lsp/inbound-pricing.test.mjs
import assert from 'node:assert';
import test from 'node:test';

// quoteInboundFee, mirrored from lsp-server.mjs (which reads its defaults from CFG).
const D = { bps: 100, minSat: 3000, minAtoms: 1000, minAmount: 100000, maxAmount: 10000000 };
function quoteInboundFee(amount, o = {}) {
  const c = { ...D, ...o };
  const amt = Math.floor(Number(amount) || 0);
  const floor = c.isBtc ? c.minSat : c.minAtoms;
  if (!(amt > 0)) return { ok: false, reason: 'amount must be greater than zero', amount: 0, fee: 0 };
  if (amt < c.minAmount) return { ok: false, reason: `the smallest amount of inbound sold is ${c.minAmount}`, amount: amt, fee: 0 };
  if (amt > c.maxAmount) return { ok: false, reason: `the largest amount of inbound sold is ${c.maxAmount}`, amount: amt, fee: 0 };
  const pct = Math.ceil((amt * c.bps) / 10000);
  return { ok: true, amount: amt, fee: Math.max(pct, floor), bps: c.bps, floor };
}

test('the headline price is 1% of the amount bought', () => {
  assert.equal(quoteInboundFee(1_000_000, { isBtc: true }).fee, 10_000);
  assert.equal(quoteInboundFee(500_000, { isBtc: true }).fee, 5_000);
});

test('the floor applies when 1% would be smaller', () => {
  // 1% of 100k is 1,000 sat, below the 3,000 sat BTC floor — a small channel still costs the
  // floor, because the LP's cost of opening one barely varies with size.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).fee, 3_000);
  // The crossover: at 300k, 1% exactly equals the floor; above it the percentage takes over.
  assert.equal(quoteInboundFee(300_000, { isBtc: true }).fee, 3_000);
  assert.equal(quoteInboundFee(300_001, { isBtc: true }).fee, 3_001);
});

test('NO PRIVILEGED ASSET: an asset is priced by the same rule, in its own units', () => {
  // Same percentage, same maths — only the floor differs, because atoms are not satoshis.
  const btc = quoteInboundFee(2_000_000, { isBtc: true });
  const asset = quoteInboundFee(2_000_000, { isBtc: false });
  assert.equal(btc.fee, 20_000);
  assert.equal(asset.fee, 20_000, 'the percentage must not depend on which asset is bought');
  // Below the crossover the two floors differ, and each applies to its own kind.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).fee, 3_000);
  assert.equal(quoteInboundFee(100_000, { isBtc: false }).fee, 1_000);
});

test('the percentage rounds UP, never down', () => {
  // Rounding a price down sells capacity below cost on every request that lands mid-unit, and
  // those are the common case rather than the exception.
  assert.equal(quoteInboundFee(300_050, { isBtc: true }).fee, 3_001, '1% of 300050 = 3000.5 -> 3001');
  assert.equal(quoteInboundFee(1_000_001, { isBtc: true }).fee, 10_001);
});

test('the sold range is bounded at both ends, with a reason', () => {
  const small = quoteInboundFee(99_999, { isBtc: true });
  assert.equal(small.ok, false);
  assert.match(small.reason, /smallest/);
  const big = quoteInboundFee(10_000_001, { isBtc: true });
  assert.equal(big.ok, false);
  assert.match(big.reason, /largest/);
  // The bounds themselves are inclusive — a quote at exactly the limit is sellable.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).ok, true);
  assert.equal(quoteInboundFee(10_000_000, { isBtc: true }).ok, true);
});

test('a refused quote is DATA, not an exception', () => {
  // This same function answers the quote endpoint, so the UI must be able to render the reason.
  // Throwing would turn "too small" into an error page.
  for (const bad of [0, -1, null, undefined, NaN, 'abc']) {
    const q = quoteInboundFee(bad, { isBtc: true });
    assert.equal(q.ok, false);
    assert.equal(q.fee, 0, 'a refused quote never carries a chargeable fee');
    assert.ok(q.reason, 'and always says why');
  }
});

test('a quote never charges more than the liquidity is worth', () => {
  // Sanity bound: at 1% with these floors, the fee is always a small fraction of the amount for
  // anything in the sold range. A pricing change that broke this would be charging real money.
  for (const amt of [100_000, 250_000, 1_000_000, 10_000_000]) {
    const q = quoteInboundFee(amt, { isBtc: true });
    assert.ok(q.fee < amt / 10, `fee ${q.fee} is more than 10% of ${amt}`);
  }
});
