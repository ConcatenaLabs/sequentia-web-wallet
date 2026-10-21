// An order resting as a leaf in an operator's tree (offer member arca_resting,
// field 26): seqob.js signs and verifies it with Go's canonical bytes and
// signature where it first rests and where the relay serves it after a part fill
// rested it again at another coin (resting-offer-vectors.json, a copy of seqdex's
// daemon/internal/seqob/offer/testdata/arca_resting_offer_vectors.json). The
// locator (coin, value) is outside the signed bytes; the order id and the terms
// are inside.
//
// Run: node --test resting-offer.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normRelayOffer, bytesToHex, hexToBytes, restingOfferForPost, __test__ as seqob } from './seqob.js';

const v = JSON.parse(readFileSync(new URL('./resting-offer-vectors.json', import.meta.url)));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('rested and moved verify with Go\'s canonical bytes', () => {
  for (const name of ['rested', 'moved']){
    const o = normRelayOffer(clone(v[name]));
    assert.equal(bytesToHex(seqob.canonicalOfferBytes(o)), v.canonical_hex, name);
    assert.equal(seqob.verifyOffer(o), true, name);
  }
  const moved = normRelayOffer(clone(v.moved));
  assert.notEqual(moved.arca_resting.coin, v.rested.arca_resting.coin);
  assert.equal(moved.arca_resting.value, '300000');
});

test('a changed rate or order id does not verify', () => {
  for (const name of ['tampered_rate', 'tampered_order']){
    assert.equal(seqob.verifyOffer(normRelayOffer(clone(v[name]))), false, name);
  }
});

test('signing gives Go\'s RFC 6979 signature, and the wire form round-trips', () => {
  const o = normRelayOffer(clone(v.moved));
  delete o.maker_sig;
  seqob.signOffer(o, hexToBytes(v.maker_priv));
  assert.equal(o.maker_sig, v.rested.maker_sig);
  const wire = restingOfferForPost(o);
  assert.equal(wire.arca_resting.landed_maker, v.rested.arca_resting.landed_maker);
  assert.equal(wire.arca_resting.refund_key, v.rested.arca_resting.refund_key);
  assert.equal(o.arca_resting.landed_maker, '31'.repeat(32), 'the signed object keeps hex');
});
