// The LP refill's plan: which assets it tops up, by how much, and every reason it holds back.
import { test } from 'node:test';
import assert from 'node:assert';
import { planRefills, unitsString, pendingAssets, inventoryAtoms } from './lp-refill.mjs';

const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1';
const EURX = 'e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13';
const USDX = 'aa'.repeat(32);
const U = 1e8;
const MIN = 60000;

const cfg = { lowRef: null, targetRef: 20000, maxRef: 25000, keepRef: 5000, cooldownMs: 30 * MIN };

function stats(assets) {
  return { ok: true, terms: { low_ref: 1000 }, assets };
}
const row = (asset, ticker, price, free_ref, sellable_ref) => ({ asset, ticker, price_ref: price, free_ref, sellable_ref });

test('an asset under the low line is topped up to the target, an asset above it is left alone', () => {
  const s = stats([row(GOLD, 'GOLD', 4000, 200, 170), row(USDX, 'USDX', 1, 10000, 8700)]);
  const { sends, skips } = planRefills({ stats: s, inventory: { [GOLD]: 50 * U }, pending: new Set(), last: {}, now: 1e12, cfg });
  assert.deepEqual(skips, []);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].asset, GOLD);
  // (20000 - 200) / 4000 = 4.95 GOLD
  assert.equal(sends[0].atoms, Math.floor(4.95 * U));
});

test('one refill never sends more than the cap', () => {
  const s = stats([row(EURX, 'EURX', 1, 0, 0)]);
  const { sends } = planRefills({ stats: s, inventory: { [EURX]: 1e6 * U }, pending: new Set(), last: {}, now: 1e12,
    cfg: { ...cfg, targetRef: 100000 } });
  assert.equal(sends[0].atoms, 25000 * U);
});

test('the inventory keeps its floor, and an inventory at its floor sends nothing', () => {
  const s = stats([row(EURX, 'EURX', 1, 0, 0)]);
  const some = planRefills({ stats: s, inventory: { [EURX]: 8000 * U }, pending: new Set(), last: {}, now: 1e12, cfg });
  assert.equal(some.sends[0].atoms, 3000 * U);
  const none = planRefills({ stats: s, inventory: { [EURX]: 5000 * U }, pending: new Set(), last: {}, now: 1e12, cfg });
  assert.equal(none.sends.length, 0);
  assert.match(none.skips[0].reason, /floor/);
});

test('an unconfirmed coin on the LP node holds the refill back', () => {
  const s = stats([row(GOLD, 'GOLD', 4000, 200, 170)]);
  const r = planRefills({ stats: s, inventory: { [GOLD]: 50 * U }, pending: new Set([GOLD]), last: {}, now: 1e12, cfg });
  assert.equal(r.sends.length, 0);
  assert.match(r.skips[0].reason, /unconfirmed/);
});

test('a refill inside the cooldown holds the next one back, and one after it does not', () => {
  const s = stats([row(GOLD, 'GOLD', 4000, 200, 170)]);
  const now = 1e12;
  const early = planRefills({ stats: s, inventory: { [GOLD]: 50 * U }, pending: new Set(), last: { [GOLD]: now - 10 * MIN }, now, cfg });
  assert.equal(early.sends.length, 0);
  assert.match(early.skips[0].reason, /10 min ago/);
  const late = planRefills({ stats: s, inventory: { [GOLD]: 50 * U }, pending: new Set(), last: { [GOLD]: now - 31 * MIN }, now, cfg });
  assert.equal(late.sends.length, 1);
});

test('an unpriced asset is never sized, and the low line can be set by hand', () => {
  const s = stats([row(GOLD, 'GOLD', null, 0, null), row(EURX, 'EURX', 1, 3000, 2500)]);
  const def = planRefills({ stats: s, inventory: { [EURX]: 1e6 * U }, pending: new Set(), last: {}, now: 1e12, cfg });
  assert.deepEqual(def, { sends: [], skips: [] });
  const hand = planRefills({ stats: s, inventory: { [EURX]: 1e6 * U }, pending: new Set(), last: {}, now: 1e12, cfg: { ...cfg, lowRef: 5000 } });
  assert.equal(hand.sends[0].atoms, 17000 * U);
});

test('amounts are written in whole units with eight decimals', () => {
  assert.equal(unitsString(495000000), '4.95000000');
  assert.equal(unitsString(1), '0.00000001');
  assert.equal(unitsString(11500000000000), '115000.00000000');
  assert.throws(() => unitsString(0));
});

test('pending and inventory are read per asset, reserved and assetless coins aside', () => {
  const lf = { outputs: [
    { asset: GOLD.toUpperCase(), status: 'unconfirmed' },
    { asset: EURX, status: 'confirmed' },
    { asset: USDX, status: 'unconfirmed', reserved: true },
  ] };
  assert.deepEqual([...pendingAssets(lf)], [GOLD]);
  assert.deepEqual(inventoryAtoms([{ asset: GOLD, amount: 1.5 }, { asset: GOLD, amount: 0.25 }, { amount: 3 }]), { [GOLD]: 1.75 * U });
});
