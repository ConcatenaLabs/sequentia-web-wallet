// SeqDEX's Simplicity order in the wallet: covenant-sim.js derives every
// golden vector of both versions of the template seqdex/order exactly as the
// compiler does (seqdex-order-2-vectors.json and seqdex-order-vectors.json,
// copies of seqdex's daemon/pkg/covenant/seqdex_order_2/ and seqdex_order/
// vectors.json), holds each version's pruned programs (seqdex-order-2-fills.json
// and seqdex-order-fills.json, copies of fills.json there) and builds a fill's
// witness from them; and seqob.js signs and verifies a Simplicity
// covenant offer with Go's canonical bytes and signature, where its maker
// funded it and where the relay served it after a partial fill
// (simplicity-offer-vectors.json, a copy of seqdex's
// daemon/internal/seqob/offer/testdata/simplicity_offer_vectors.json).
//
// Run: node --test covenant-sim.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from './btc.js';
import {
  SIM_ORDER_CMR, SIM_ORDER_TEMPLATE_HASH, SIM_ORDER_PROGRAMS, SIM_ORDER_TEMPLATES, deriveSimTerms, deriveSimOrder,
  simFillWitness, simOrderAddress, simOrderTemplate, simOrderTerms,
} from './covenant-sim.js';
import { normRelayOffer, bytesToHex, hexToBytes, __test__ as seqob } from './seqob.js';

const read = (f) => JSON.parse(readFileSync(new URL('./' + f, import.meta.url)));
const VERSIONS = {
  2: { vectors: read('seqdex-order-2-vectors.json'), fills: read('seqdex-order-2-fills.json') },
  1: { vectors: read('seqdex-order-vectors.json'), fills: read('seqdex-order-fills.json') },
};
const offers = read('simplicity-offer-vectors.json');
const ORDER = ['ASSET_A', 'ASSET_B', 'RATE_NUM', 'RATE_DEN', 'MIN_LOT', 'MAKER', 'EXPIRY', 'REFUND_KEY'];

test('the pinned roots, templates and programs are each version\'s; new orders use version 2', () => {
  assert.equal(SIM_ORDER_CMR, VERSIONS[2].fills.cmr);
  assert.equal(SIM_ORDER_TEMPLATE_HASH, VERSIONS[2].fills.template_hash);
  assert.equal(SIM_ORDER_PROGRAMS, SIM_ORDER_TEMPLATES[2].programs);
  assert.notEqual(SIM_ORDER_TEMPLATES[1].cmr, SIM_ORDER_TEMPLATES[2].cmr);
  for (const [n, { vectors, fills }] of Object.entries(VERSIONS)){
    const t = SIM_ORDER_TEMPLATES[n];
    assert.equal(t.cmr, fills.cmr, n);
    assert.equal(t.template_hash, fills.template_hash, n);
    assert.equal(vectors.template_hash, fills.template_hash, n);
    assert.equal(simOrderTemplate(fills.template_hash.toUpperCase()), t, n);
    for (const [k, p] of Object.entries(fills.paths)){
      assert.equal(t.programs[k], p.program, n + ' ' + k);
      assert.equal(t.programs[k].length / 2, p.program_bytes, n + ' ' + k);
    }
  }
  assert.equal(simOrderTemplate(undefined), SIM_ORDER_TEMPLATES[2]);
  assert.throws(() => simOrderTemplate('00'.repeat(32)), /is not seqdex\/order version 2/);
});

for (const n of [2, 1]) test(`every golden vector of version ${n}: leaves, root, key, parity, script, control block and addresses`, () => {
  const { vectors } = VERSIONS[n];
  const tmpl = SIM_ORDER_TEMPLATES[n];
  assert.ok(vectors.addresses.length >= 4);
  const seen = new Set();
  for (const v of vectors.addresses){
    const terms = hexToBytes(ORDER.map(k => v.params[k]).join(''));
    assert.equal(bytesToHex(terms), v.leaves.terms.data, v.name);
    const d = deriveSimTerms(terms, tmpl);
    assert.equal(bytesToHex(d.programLeafHash), v.leaves.order.hash, v.name);
    assert.equal(bytesToHex(d.termsLeafHash), v.leaves.terms.hash, v.name);
    assert.equal(bytesToHex(d.controlBlock), v.leaves.order.control_block, v.name);
    assert.equal(bytesToHex(d.merkleRoot), v.merkle_root, v.name);
    assert.equal(bytesToHex(d.outputKey), v.output_key, v.name);
    assert.equal(d.parity, v.output_key_parity, v.name);
    assert.equal(bytesToHex(d.spk), v.script_pubkey, v.name);
    assert.equal(simOrderAddress(d.outputKey, 'tb'), v.address['sequentia-testnet'], v.name);
    assert.equal(simOrderAddress(d.outputKey, 'ert'), v.address.elementsregtest, v.name);
    seen.add(`${v.leaves.order.hash < v.leaves.terms.hash}/${d.parity}`);
  }
  assert.equal(seen.size, 4, 'the vectors cover both branch orders and both parities');
});

for (const n of [2, 1]) test(`version ${n}: an order's terms commit its maker script by hash, and a fill's witness is the terms then PATH`, () => {
  const { vectors, fills } = VERSIONS[n];
  const o = {
    asset_a: '11'.repeat(32), asset_b: '22'.repeat(32), rate_num: '18446744073709551615', rate_den: '18446744073709551614',
    min_lot: 1, maker_script: '0014' + '33'.repeat(20), expiry_locktime: 1900000000,
    refund_key: vectors.addresses[0].params.REFUND_KEY,
    ...(n === 1 ? { template_hash: SIM_ORDER_TEMPLATES[1].template_hash } : {}),
  };
  const t = simOrderTerms(o);
  assert.equal(t.length, 156);
  assert.equal(bytesToHex(t.subarray(88, 120)), bytesToHex(sha256(hexToBytes(o.maker_script))));
  for (const partial of [true, false]){
    const w = simFillWitness(o, partial);
    assert.equal(w[0], bytesToHex(t) + (partial ? '40' : '00'));
    assert.equal(w[1], partial ? fills.paths.fill.program : fills.paths.fill_whole.program);
    assert.equal(w[2], fills.cmr);
    assert.equal(w[3], bytesToHex(deriveSimOrder(o).controlBlock));
  }
  assert.throws(() => simOrderTerms({ ...o, rate_num: 2n ** 64n }), /does not fit/);
});

const served = (name) => normRelayOffer(JSON.parse(JSON.stringify(offers[name])));

test('a Simplicity covenant offer verifies where it was funded and where the relay moved it', () => {
  const funded = served('funded'), moved = served('moved');
  assert.equal(moved.simplicity_covenant.covenant_vout, 3);
  assert.notEqual(moved.simplicity_covenant.covenant_txid, funded.simplicity_covenant.covenant_txid);
  for (const [name, o] of [['funded', funded], ['moved', moved]]){
    assert.ok(seqob.verifyOffer(o), `${name} must verify`);
    assert.equal(bytesToHex(seqob.canonicalOfferBytes(o)), offers.canonical_hex, `${name}: Go's canonical bytes`);
  }
  assert.equal(seqob.verifyOffer(served('tampered')), false);
  const again = served('moved');
  const want = again.maker_sig;
  delete again.maker_sig;
  seqob.signOffer(again, hexToBytes(offers.maker_priv));
  assert.equal(again.maker_sig, want);
  // The served terms make the order the address derivation reads: the
  // vector is a version 1 offer, as orders resting from before version 2 are.
  const st = funded.simplicity_covenant;
  assert.equal(st.template_hash, SIM_ORDER_TEMPLATES[1].template_hash);
  assert.equal(simOrderTerms(st).length, 156);
  const d1 = deriveSimOrder(st);
  assert.equal(bytesToHex(d1.programLeafHash), bytesToHex(deriveSimTerms(simOrderTerms(st), SIM_ORDER_TEMPLATES[1]).programLeafHash));
  const d2 = deriveSimOrder({ ...st, template_hash: SIM_ORDER_TEMPLATE_HASH });
  assert.notEqual(bytesToHex(d1.spk), bytesToHex(d2.spk), 'one order\'s terms under two versions are two addresses');
});
