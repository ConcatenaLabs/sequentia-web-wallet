// Several covenant orders filled in one transaction, order k at input k: the
// wallet's mirror (covenant.js checkFill / buildFillTx) against seqdex's Go
// planner (daemon/pkg/covenant fills.go). covenant-fill-vectors.json is a copy
// of seqdex's pkg/covenant/testdata/fill_vectors.json: the same specs must give
// the same bytes, the same txid and the same plans on both sides, and each
// order's leaf, as checkFill reads it, must take each vector and refuse the
// layouts the Go checker refuses, for the same reason.
//
// Run: node --test covenant-fills.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFillTx, checkFill, orderFromTerms, bytesToHex } from './covenant.js';

const vectors = JSON.parse(readFileSync(new URL('./covenant-fill-vectors.json', import.meta.url))).vectors;

test('the vectors build the bytes and the txid the Go planner built', () => {
  assert.ok(vectors.length >= 2);
  for (const v of vectors){
    const r = buildFillTx(v);
    assert.equal(r.hex, v.expect.hex, v.name);
    assert.equal(r.txid, v.expect.txid, v.name);
    r.plans.forEach((p, k) => {
      const e = v.expect.plans[k];
      assert.deepEqual(
        [p.inputIndex, p.creditIndex, p.remainderIndex, p.requiredB, p.remainder, p.partial],
        [e.input_index, e.credit_index, e.remainder_index, BigInt(e.required_b), BigInt(e.remainder), e.partial], `${v.name}: take ${k}`);
      assert.deepEqual([p.inputIndex, p.creditIndex, p.remainderIndex], [k, 2 * k, 2 * k + 1]);
    });
  }
});

test('a fill at k = 1 beside another order: what each order\'s leaf reads', () => {
  for (const v of vectors){
    const r = buildFillTx(v);
    v.takes.forEach((t, k) => {
      const c = checkFill(orderFromTerms(t.terms), r.outputs, k, t.locked);
      assert.equal(c.filled, BigInt(t.filled), `${v.name}: take ${k}`);
      assert.equal(c.creditIndex, 2 * k);
      assert.equal(c.remainderIndex, 2 * k + 1);
      assert.ok(c.credited >= c.required);
    });
  }
});

// The negative cases of seqdex's TestCheckFillRefusesWhatTheLeafRefuses, on
// vector 1 (order 0 in part, order 1 whole): the same mutation, the same reason.
test('checkFill refuses what the leaf refuses, as the Go checker does', () => {
  const v = vectors[0];
  const good = buildFillTx(v).outputs;
  const o0 = orderFromTerms(v.takes[0].terms), o1 = orderFromTerms(v.takes[1].terms);
  const l0 = v.takes[0].locked, l1 = v.takes[1].locked;
  const clone = () => good.map(o => ({ ...o }));
  const cases = [
    ['credits swapped between 0 and 2', 0, o0, l0, (o) => { [o[0], o[2]] = [o[2], o[0]]; return o; }, 'does not hold the asset the order is paid in'],
    ["order 1's credit one atom short", 1, o1, l1, (o) => { o[2].value -= 1n; return o; }, 'below the ceiling price'],
    ["order 0's credit to another program", 0, o0, l0, (o) => { o[0].script = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32)); return o; }, "does not pay the maker's program"],
    ["order 1's gap in the asset it sells", 1, o1, l1, (o) => { o[3].asset = Uint8Array.from(Buffer.from(o1.assetA, 'hex')); return o; }, "does not pay the order's own script"],
    ["order 1's gap confidential", 1, o1, l1, (o) => { o[3].asset = null; return o; }, 'hides its asset'],
    ["order 0's credit confidential", 0, o0, l0, (o) => { o[0].value = null; return o; }, "hides the maker's credit"],
    ["order 0's rest to another script", 0, o0, l0, (o) => { o[1].script = o[4].script; return o; }, "does not pay the order's own script"],
    ["order 0's rest below min_lot", 0, o0, l0, (o) => { o[1].value = o0.minLot - 1n; return o; }, 'below min_lot'],
    ["order 0's rest leaves a fill below min_lot", 0, o0, l0, (o) => { o[1].value = BigInt(l0) - 1n; return o; }, 'below min_lot'],
    ['order 1 with no credit output', 1, o1, l1, (o) => o.slice(0, 2), 'no output 2'],
    ["the batch moved to order 0's rest slot", 0, o0, l0, (o) => { [o[1], o[4]] = [o[4], o[1]]; return o; }, "does not pay the order's own script"],
  ];
  for (const [name, k, order, locked, mut, want] of cases){
    checkFill(order, good, k, locked);
    assert.throws(() => checkFill(order, mut(clone()), k, locked), (e) => e.message.includes(want), name);
  }
});

test('buildFillTx fails closed as BuildFillTx does', () => {
  const v = vectors[0];
  const variant = (f) => { const s = JSON.parse(JSON.stringify(v)); f(s); return s; };
  assert.throws(() => buildFillTx(variant((s) => { s.gaps = []; })), /has no gap output/);
  assert.throws(() => buildFillTx(variant((s) => { s.gaps[1] = { asset: s.takes[1].terms.asset_a, value: 1, script: '' }; })), /holds the asset the order sells/);
  assert.throws(() => buildFillTx(variant((s) => { s.credits = [1, 0]; })), /below the ceiling price/);
  assert.throws(() => buildFillTx(variant((s) => { s.takes[1].txid = s.takes[0].txid; s.takes[1].vout = s.takes[0].vout; })), /taken twice/);
});

test('the outputs a vector builds are explicit and in place', () => {
  const r = buildFillTx(vectors[0]);
  assert.equal(bytesToHex(r.outputs[1].script), bytesToHex(r.plans[0].orderSpk), "order 0's rest pays its own script at 1");
});
