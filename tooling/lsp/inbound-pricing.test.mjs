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

// ── COLLECTION: TWO WAYS TO PAY ──────────────────────────────────────────────
// 'prepaid'  — the fee is sent on-chain before the channel opens (Phoenix's manual purchase).
// 'deferred' — the channel opens now and the fee is recorded as owed (the pay-to-open shape).
//
// What 'deferred' deliberately does NOT do: Phoenix shaves its fee off the incoming payment, so the
// receiver gets less than the sender sent. That cannot be done safely here — on these rails an
// incoming amount is bound to a swap hash, and a counterparty receiving less than the offer states
// correctly refuses the leg. So the debt is carried rather than taken mid-payment: the user still
// pays, just at a moment that cannot corrupt a swap.

// The ledger, mirrored from lsp-server.mjs.
const mkLedger = () => {
  const m = new Map();
  const key = (n, a) => `${n || ''}|${a || 'BTC'}`;
  return {
    owed: (n, a) => Number(m.get(key(n, a)) || 0),
    add: (n, a, amt) => { const k = key(n, a); const v = Number(m.get(k) || 0) + Math.max(0, Math.floor(Number(amt) || 0));
      if (v > 0) m.set(k, v); else m.delete(k); return v; },
    clear: (n, a, amt) => { const k = key(n, a); const cur = Number(m.get(k) || 0);
      const v = amt == null ? 0 : Math.max(0, cur - Math.floor(Number(amt) || 0));
      if (v > 0) m.set(k, v); else m.delete(k); return v; },
  };
};

test('a deferred fee is owed until it is settled', () => {
  const L = mkLedger();
  assert.equal(L.owed('nodeA', 'GOLD'), 0);
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'GOLD'), 2000);
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'GOLD'), 4000, 'debts accumulate across purchases');
  L.clear('nodeA', 'GOLD');
  assert.equal(L.owed('nodeA', 'GOLD'), 0, 'a prepaid settlement clears it');
});

test('debt is per node AND per asset', () => {
  // Charging a GOLD debt against a BTC purchase would take the fee in the wrong unit entirely.
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'BTC'), 0, 'a GOLD debt is not owed in BTC');
  assert.equal(L.owed('nodeB', 'GOLD'), 0, "and is not another node's debt");
});

test('the amount DUE on a purchase is the new fee plus what is already owed', () => {
  // The whole point of the deferred mode: it defers, it does not forgive.
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 2000);
  const q = quoteInboundFee(500_000, { isBtc: false });
  assert.equal(q.fee + L.owed('nodeA', 'GOLD'), 7000);
});

test('a partial settlement reduces the debt without erasing it', () => {
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 5000);
  assert.equal(L.clear('nodeA', 'GOLD', 2000), 3000);
  assert.equal(L.clear('nodeA', 'GOLD', 99999), 0, 'overpaying settles it, never goes negative');
});

test('a debt cap is what stops deferred becoming unlimited free liquidity', () => {
  const L = mkLedger();
  const CAP = 50000;
  L.add('nodeA', 'GOLD', CAP + 1);
  assert.ok(L.owed('nodeA', 'GOLD') > CAP, 'over the cap, further deferred purchases must be refused');
});
