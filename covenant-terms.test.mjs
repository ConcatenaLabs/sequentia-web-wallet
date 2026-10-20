// The tapscript FILL leaf reads its terms as signed 64-bit numbers, so a
// rate_num, rate_den or min_lot of 2^63 or more is negative there and the order
// fills for any credit. covenant-terms-vectors.json is a copy of seqdex's
// daemon/pkg/covenant/testdata/terms_bound_vectors.json: every term below 2^63
// builds Go's leaf bytes here, and a term at 2^63 or more is refused here as
// in Go, named, by the builder and so by every order this wallet derives.
//
// Run: node --test covenant-terms.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFillLeaf, checkLeafTerms, deriveTaptree, bytesToHex } from './covenant.js';

const v = JSON.parse(readFileSync(new URL('./covenant-terms-vectors.json', import.meta.url)));

test('every case of the vector: Go\'s leaf below 2^63, the named refusal at or above it', () => {
  const named = new Set();
  for (const c of v.cases){
    const build = () => buildFillLeaf(v.asset_a, v.asset_b, BigInt(c.rate_num), BigInt(c.rate_den), BigInt(c.min_lot), v.maker_prog);
    if (!c.refused){
      assert.equal(bytesToHex(build()), c.fill_leaf, c.name);
      checkLeafTerms(c.rate_num, c.rate_den, c.min_lot);
      continue;
    }
    named.add(c.refused);
    for (const f of [build, () => checkLeafTerms(c.rate_num, c.rate_den, c.min_lot)]){
      assert.throws(f, (e) => e.message.startsWith(c.refused + ' ') && /2\^63 or more/.test(e.message) &&
        /Simplicity order \(seqdex\/order/.test(e.message), c.name);
    }
  }
  assert.equal(named.size, 3);
});

test('an order the wallet derives with such a term is refused, not placed', () => {
  const order = { assetA: v.asset_a, assetB: v.asset_b, rateNum: 18446744073709551615n, rateDen: 1n, minLot: 1n,
    makerProg: v.maker_prog, makerVer: 1, expiryLocktime: 600, makerX: v.asset_a };
  assert.throws(() => deriveTaptree(order), /rate_num 18446744073709551615 is 2\^63 or more/);
});
