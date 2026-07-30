// A WHOLE-OFFER-ONLY OFFER MUST NOT BE SIZED AS A PARTIAL.
//
// The wallet was built on an explicit assumption: "every offer is partial-fillable
// down to its min_fill — there is NO indivisible / whole-offer-only offer" (spec §2,
// restated in subswap.js and swap.js). That assumption is false. A maker advertises
// allow_partial:false for a whole-HTLC lift, and the submarine fleet does exactly
// that — while nothing in the wallet ever read the field.
//
// So the composer sized an 8% slice of an indivisible offer, the maker locked the
// WHOLE offer, and the take died on
//   "reverse submarine: asset leg amount 5000000000 != offer 400000000"
// AFTER the maker had already committed its leg.
//
//   node --test indivisible-offer.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { classifyRelayOffer, mergeBook } from './tooling/lsp/unified-book.mjs';
import { walkBook } from './subswap.js';

const ASSET = 'aa'.repeat(32);
const WHOLE = 5_000_000_000;

// The live submarine shape: ln_direction 1 (asset on-chain + BTC-LN), whole-offer-only.
// ln_direction lives under `lightning`, exactly as the relay emits it.
const submarine = (over = {}) => ({
  offer_id: 'sub1', maker_pubkey: '02'.repeat(33),
  lightning: { ln_direction: 1, maker_ln_node_pubkey: '03'.repeat(33) },
  base_amount: String(WHOLE), offer_amount: String(WHOLE),
  want_amount: '78329', min_fill: '0', allow_partial: false,
  pair: { base_asset: ASSET, quote_asset: 'BTC' }, ...over,
});

test('allow_partial:false becomes an effective min_fill of the FULL size', () => {
  const e = classifyRelayOffer(submarine());
  assert.ok(e, 'the offer still classifies');
  assert.equal(e.indivisible, true);
  assert.equal(Number(e.minFill), WHOLE,
    'a min_fill of 0 on an indivisible offer is a lie the taker acts on');
});

test('allow_partial:true keeps the maker\'s own advertised min_fill', () => {
  const e = classifyRelayOffer(submarine({ allow_partial: true, min_fill: '162748182' }));
  assert.equal(e.indivisible, false);
  assert.equal(Number(e.minFill), 162748182);
});

test('an offer with no allow_partial field is treated as divisible, as before', () => {
  const o = submarine(); delete o.allow_partial;
  const e = classifyRelayOffer(o);
  assert.equal(e.indivisible, false);
  assert.equal(Number(e.minFill), 0);
});

test('THE REPORTED FAILURE: a partial request SKIPS an indivisible offer', () => {
  // 4 USDX wanted out of a 50 USDX whole-only offer. Taking it would lock 50.
  const e = classifyRelayOffer(submarine());
  const w = walkBook({ offers: [e], want: 400_000_000n, side: 'buy' });
  assert.equal(w.offersUsed, 0, 'it must be passed over, not force-filled');
  assert.equal(w.filledAtoms, 0n);
  assert.equal(w.remainderAtoms, 400_000_000n, 'and the shortfall is stated honestly');
});

test('a WHOLE request still takes an indivisible offer', () => {
  const e = classifyRelayOffer(submarine());
  const w = walkBook({ offers: [e], want: BigInt(WHOLE), side: 'buy' });
  assert.equal(w.offersUsed, 1);
  assert.equal(w.filledAtoms, BigInt(WHOLE));
  assert.equal(w.legs[0].partial, false, 'taken whole, exactly as the maker requires');
});

test('the walk routes AROUND an indivisible offer to a divisible one behind it', () => {
  // This is what makes the book usable again: a whole-only offer at the top of the
  // book no longer blocks every partial take on the pair.
  const whole = classifyRelayOffer(submarine({ offer_id: 'whole', want_amount: '78000' }));
  const divis = classifyRelayOffer(submarine({ offer_id: 'divis', want_amount: '78500',
    allow_partial: true, min_fill: '1000' }));
  const book = mergeBook([whole, divis]);
  const w = walkBook({ offers: book.asks, want: 400_000_000n, side: 'buy' });
  assert.equal(w.filledAtoms, 400_000_000n, 'the partial fills against the divisible offer');
  assert.equal(w.legs[0].offer.id, 'divis', 'even though it is the WORSE price');
});
