// An offer's time_in_force (field 24) is part of its signed bytes, in Go and
// here. time-in-force-offer-vectors.json is a copy of seqdex's
// daemon/internal/seqob/offer/testdata/time_in_force_offer_vectors.json: an
// offer signed by Go with each value (UNSPECIFIED omitted, as proto3 omits a
// zero) verifies here through normRelayOffer and verifyOffer, with Go's
// canonical bytes; the wallet's signer makes Go's signature; an offer whose
// time_in_force was changed after signing verifies in neither.
//
// Run: node --test time-in-force-offer.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normRelayOffer, bytesToHex, hexToBytes, __test__ as seqob } from './seqob.js';

const v = JSON.parse(readFileSync(new URL('./time-in-force-offer-vectors.json', import.meta.url)));
const served = (o) => normRelayOffer(JSON.parse(JSON.stringify(o)));

test('an offer with each time_in_force verifies with Go\'s bytes and signature', () => {
  assert.equal(v.cases.length, 4);
  for (const c of v.cases){
    const o = served(c.offer);
    assert.ok(seqob.verifyOffer(o), `${c.name} must verify`);
    assert.equal(bytesToHex(seqob.canonicalOfferBytes(o)), c.canonical_hex, `${c.name}: Go's canonical bytes`);
    const again = served(c.offer);
    const want = again.maker_sig;
    delete again.maker_sig;
    seqob.signOffer(again, hexToBytes(v.maker_priv));
    assert.equal(again.maker_sig, want, `${c.name}: Go's signature`);
  }
});

test('a time_in_force changed after signing does not verify', () => {
  assert.equal(seqob.verifyOffer(served(v.tampered)), false);
});

test('an unknown time_in_force is refused, not dropped from the bytes', () => {
  const o = served(v.cases[1].offer);
  o.time_in_force = 'TIME_IN_FORCE_SOMEDAY';
  assert.throws(() => seqob.canonicalOfferBytes(o), /unknown time_in_force/);
});
