// Inbound limits for an asset follow what it is worth: the same reference value in every asset.
// And a prepaid fee pays for one purchase.
import { test } from 'node:test';
import assert from 'node:assert';
import { rateOf, assetInboundLimits, feeReuseProblem, inboundFundAtoms, inboundRoomFundable, lpFreeAtoms, paidWaitingFee } from './inbound-limits.mjs';

const USDX = '1f'.repeat(32), TSEQ = 'c8'.repeat(32), GOLD = '3a'.repeat(32);
// Reference limits: 10 to 10,000 reference units, a fee of at least 1 (in reference atoms, 1e8 a unit).
const REF = { refMin: 10e8, refMax: 10_000e8, refFeeFloor: 1e8 };

test('an asset worth one reference unit gets the limits in its own units', () => {
  // 1 USDX = 1 reference unit (R = 1e8): 10 to 10,000 USDX, a fee of at least 1 USDX.
  assert.deepEqual(assetInboundLimits(1e8, REF), { minAmount: 10e8, maxAmount: 10_000e8, minAtoms: 1e8 });
});

test('a cheaper asset needs more of it for the same value, a dearer one less', () => {
  // tSEQ at 0.37: 10 reference units is about 27.03 tSEQ.
  const t = assetInboundLimits(0.37e8, REF);
  assert.equal(t.minAmount, Math.ceil(10e8 * 1e8 / 0.37e8));
  assert.ok(t.minAmount > 27e8 && t.minAmount < 27.1e8);
  // GOLD at 4,000: 10 reference units is 0.0025 GOLD.
  const g = assetInboundLimits(4000e8, REF);
  assert.deepEqual(g, { minAmount: 250_000, maxAmount: 250_000_000, minAtoms: 25_000 });
});

test('no rate, no asset limits: the caller keeps its atom limits', () => {
  assert.equal(assetInboundLimits(null, REF), null);
  assert.equal(assetInboundLimits(0, REF), null);
  assert.equal(assetInboundLimits(-5, REF), null);
  assert.equal(assetInboundLimits(NaN, REF), null);
});

test('limits never fall below one atom', () => {
  assert.deepEqual(assetInboundLimits(1e30, REF), { minAmount: 1, maxAmount: 1, minAtoms: 1 });
});

test('the rate is read by id or by label, in any case', () => {
  const rates = { [USDX]: 100000000, tSEQ: 37000000, gold: '400000000000' };
  assert.equal(rateOf(rates, USDX.toUpperCase()), 1e8);
  assert.equal(rateOf(rates, TSEQ, 'tSEQ'), 0.37e8);
  assert.equal(rateOf(rates, GOLD, 'GOLD'), 4000e8);
  assert.equal(rateOf(rates, '99'.repeat(32), 'NOPE'), null);
  assert.equal(rateOf({ [USDX]: 0 }, USDX), null);
  assert.equal(rateOf(null, USDX), null);
});


test('a fee transaction pays for one purchase, and may only be used again to retry it', () => {
  const prior = { node_key: 'seq:a:02aa', asset: USDX, amount: 5_000_000 };
  const req = (o) => ({ nodeKey: 'seq:a:02aa', assetId: USDX, amount: 5_000_000, ...o });
  assert.equal(feeReuseProblem(null, req({})), null);                          // first use
  assert.equal(feeReuseProblem(prior, req({})), null);                         // the same purchase, retried
  assert.equal(feeReuseProblem(prior, req({ assetId: USDX.toUpperCase() })), null);
  assert.equal(feeReuseProblem(prior, req({ amount: 1_000_000 })), null);      // less than it paid for
  assert.match(feeReuseProblem(prior, req({ amount: 5_000_001 })), /already paid/);
  assert.match(feeReuseProblem(prior, req({ nodeKey: 'seq:a:02bb' })), /already paid/);
  assert.match(feeReuseProblem(prior, req({ assetId: TSEQ })), /already paid/);
});

test('room is sold only as far as the LP can fund it', () => {
  const k = { headroomBps: 1500, reserve: 5000 };
  // 500 USDX of room is funded with 575 USDX + 5000 atoms: the channel of the 20/10 failure.
  assert.equal(inboundFundAtoms(500e8, k), 57_500_005_000);
  assert.equal(inboundRoomFundable(57_500_005_000, k), 500e8);
  assert.equal(inboundRoomFundable(57_500_004_999, k), 500e8 - 1);
  assert.ok(inboundFundAtoms(inboundRoomFundable(109_969_946, k), k) <= 109_969_946);
  assert.equal(inboundRoomFundable(5000, k), 0);
  assert.equal(inboundRoomFundable(0, k), 0);
});

test('the LP counts only its confirmed, unreserved outputs of the asset', () => {
  const lf = { outputs: [
    { status: 'confirmed', asset: USDX, amount_msat: 100e8 * 1000 },
    { status: 'confirmed', asset: USDX.toUpperCase(), amount_msat: 1e8 * 1000 },
    { status: 'unconfirmed', asset: USDX, amount_msat: 50e8 * 1000 },
    { status: 'confirmed', asset: USDX, amount_msat: 7e8 * 1000, reserved: true },
    { status: 'confirmed', asset: GOLD, amount_msat: 9e8 * 1000 },
    { status: 'confirmed', amount_msat: 3e8 * 1000 },                          // the policy asset, untagged
  ] };
  assert.equal(lpFreeAtoms(lf, USDX), 101e8);
  assert.equal(lpFreeAtoms(lf, TSEQ, TSEQ), 3e8);
  assert.equal(lpFreeAtoms(lf, TSEQ), 0);
  assert.equal(lpFreeAtoms(null, USDX), 0);
});

test('a fee paid for room never opened is found for that node and asset, and an opened one is not', () => {
  const fees = new Map(Object.entries({
    aa: { node_key: 'n1', asset: USDX, amount: 500e8, months: 1 },
    bb: { node_key: 'n1', asset: USDX.toUpperCase(), amount: 600e8, months: 3 },
    cc: { node_key: 'n1', asset: USDX, amount: 900e8, opened_at: 1 },
    dd: { node_key: 'n2', asset: USDX, amount: 999e8 },
    ee: { node_key: 'n1', asset: GOLD, amount: 999e8 },
  }));
  assert.deepEqual(paidWaitingFee(fees, 'n1', USDX), { fee_txid: 'bb', amount: 600e8, months: 3 });
  assert.equal(paidWaitingFee(fees, 'n3', USDX), null);
  assert.deepEqual(paidWaitingFee(Object.fromEntries(fees), 'n2', USDX), { fee_txid: 'dd', amount: 999e8, months: null });
});
