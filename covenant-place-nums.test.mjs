// The wallet places only NUMS-keyed covenant orders. Any other internal key is
// a key path that takes the order back from under a taker, which takers and the
// relay (seqdex's validator) refuse; planPlaceOrder, and so place() and
// postExisting(), refuse it before anything is funded or posted. An order a
// record already holds under another key still derives, so its coin can be
// reclaimed.
//
// Run: node --test covenant-place-nums.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPlaceOrder, place, planRefund } from './covenant-order.js';
import { NUMS, bytesToHex } from './covenant.js';

const K = '69cd707cce2525b0abd85a5fa32c4d55d6c5c7fc88ae95963fd7cc30821ceea7';
const params = { assetA: 'a1'.repeat(32), assetB: 'b2'.repeat(32), sellAtoms: 1000000, rateNum: 3, rateDen: 2, minLot: 1000,
  expiryLocktime: 1900000000, makerProg: K, makerX: K };

test('an order under the NUMS key, given or by default, is planned', () => {
  const a = planPlaceOrder(params), b = planPlaceOrder({ ...params, internalKey: bytesToHex(NUMS) });
  assert.equal(a.spkHex, b.spkHex);
});

test('an order under any other internal key is refused before anything is funded', async () => {
  assert.throws(() => planPlaceOrder({ ...params, internalKey: K }), /is not the NUMS point: it is a key path/);
  let funded = false;
  await assert.rejects(place({ ...params, internalKey: K }, {
    spkToAddress: async () => 'x', fundToAddress: async () => { funded = true; return { txid: '00'.repeat(32), vout: 0 }; },
    postCovenantOffer: async () => ({}),
  }), /not the NUMS point/);
  assert.equal(funded, false);
});

test('a recorded order under another key still derives its refund', () => {
  const order = { assetA: params.assetA, assetB: params.assetB, rateNum: 3n, rateDen: 2n, minLot: 1000n, makerProg: K, makerVer: 1,
    expiryLocktime: 1900000000, makerX: K, internalKey: K };
  const r = planRefund(order, { txid: '00'.repeat(32), vout: 0, locked: 1000000 });
  assert.equal(bytesToHex(r.tap.internalKey), K);
});
