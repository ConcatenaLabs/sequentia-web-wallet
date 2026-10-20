// SeqDEX's Simplicity order in the wallet: covenant-sim.js derives every
// golden vector of the template seqdex/order exactly as the compiler does
// (seqdex-order-vectors.json, a copy of seqdex's
// daemon/pkg/covenant/seqdex_order/vectors.json), holds the template's pruned
// programs (seqdex-order-fills.json, a copy of fills.json there) and builds a
// fill's witness from them; and seqob.js signs and verifies a Simplicity
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
  SIM_ORDER_CMR, SIM_ORDER_TEMPLATE_HASH, SIM_ORDER_PROGRAMS, deriveSimTerms, deriveSimOrder,
  simFillWitness, simOrderAddress, simOrderTerms,
} from './covenant-sim.js';
import { normRelayOffer, bytesToHex, hexToBytes, __test__ as seqob } from './seqob.js';

const read = (f) => JSON.parse(readFileSync(new URL('./' + f, import.meta.url)));
const vectors = read('seqdex-order-vectors.json');
const fills = read('seqdex-order-fills.json');
const offers = read('simplicity-offer-vectors.json');
const ORDER = ['ASSET_A', 'ASSET_B', 'RATE_NUM', 'RATE_DEN', 'MIN_LOT', 'MAKER', 'EXPIRY', 'REFUND_KEY'];

test('the pinned root, template and programs are the template\'s', () => {
  assert.equal(SIM_ORDER_CMR, fills.cmr);
  assert.equal(SIM_ORDER_TEMPLATE_HASH, fills.template_hash);
  assert.equal(vectors.template_hash, fills.template_hash);
  for (const [k, p] of Object.entries(fills.paths)){
    assert.equal(SIM_ORDER_PROGRAMS[k], p.program, k);
    assert.equal(SIM_ORDER_PROGRAMS[k].length / 2, p.program_bytes, k);
  }
});

test('every golden vector: leaves, root, key, parity, script, control block and addresses', () => {
  assert.ok(vectors.addresses.length >= 4);
  const seen = new Set();
  for (const v of vectors.addresses){
    const terms = hexToBytes(ORDER.map(k => v.params[k]).join(''));
    assert.equal(bytesToHex(terms), v.leaves.terms.data, v.name);
    const d = deriveSimTerms(terms);
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

test('an order\'s terms commit its maker script by hash, and a fill\'s witness is the terms then PATH', () => {
  const o = {
    asset_a: '11'.repeat(32), asset_b: '22'.repeat(32), rate_num: '18446744073709551615', rate_den: '18446744073709551614',
    min_lot: 1, maker_script: '0014' + '33'.repeat(20), expiry_locktime: 1900000000,
    refund_key: vectors.addresses[0].params.REFUND_KEY,
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
  // The served terms make the order the address derivation reads.
  const st = funded.simplicity_covenant;
  assert.equal(st.template_hash, SIM_ORDER_TEMPLATE_HASH);
  assert.equal(simOrderTerms(st).length, 156);
});
