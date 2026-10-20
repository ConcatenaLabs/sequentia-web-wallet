// A covenant offer verifies after the relay moves its outpoint. The relay's
// watcher re-points a resting covenant order at (txid, 2k+1) when a fill, an
// operator's round among them, rests it again; the maker is offline and does
// not sign again, so the outpoint is outside the signed bytes, in Go and here.
// covenant-offer-vectors.json is a copy of seqdex's
// daemon/internal/seqob/offer/testdata/covenant_offer_vectors.json: offers in
// the relay's wire form, signed by Go where the maker funded the order and
// served again at (round txid, 3). Both verify here, through the same path the
// wallet reads a served book with (normRelayOffer, then verifyOffer), with the
// canonical bytes Go computed; the wallet's signer makes Go's signature; a
// changed term verifies in neither.
//
// Run: node --test covenant-offer-move.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normRelayOffer, bytesToHex, hexToBytes, __test__ as seqob } from './seqob.js';

const v = JSON.parse(readFileSync(new URL('./covenant-offer-vectors.json', import.meta.url)));
const served = (name) => normRelayOffer(JSON.parse(JSON.stringify(v[name])));

test('the offer verifies where it was funded and where the round rested it again', () => {
  const funded = served('funded'), moved = served('moved');
  assert.equal(moved.covenant.covenant_vout, 3);
  assert.notEqual(moved.covenant.covenant_txid, funded.covenant.covenant_txid);
  for (const [name, o] of [['funded', funded], ['moved', moved]]){
    assert.ok(seqob.verifyOffer(o), `${name} must verify`);
    assert.equal(bytesToHex(seqob.canonicalOfferBytes(o)), v.canonical_hex, `${name}: Go's canonical bytes`);
  }
});

test('a changed term does not verify', () => {
  assert.equal(seqob.verifyOffer(served('tampered')), false);
});

test("the wallet's signer makes Go's signature over the moved offer", () => {
  const moved = served('moved');
  const want = moved.maker_sig;
  delete moved.maker_sig;
  seqob.signOffer(moved, hexToBytes(v.maker_priv));
  assert.equal(moved.maker_sig, want);
  assert.equal(moved.maker_pubkey, served('funded').maker_pubkey);
});
