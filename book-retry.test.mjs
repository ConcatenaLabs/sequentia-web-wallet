// RETRY DOWN THE BOOK — one dead maker must not fail every take on the pair.
//
// A resting offer can outlive the maker process serving it: the relay keeps the offer
// until expiry, so a dead maker sits at top-of-book answering every lift with "offer
// has a lift in progress". The bridged path had no way to look past it, so EVERY take
// on that pair failed instantly until the offer expired. The on-chain cross path has
// had this retry for a while (xswap.js T4); the bridged path never got it.
//
//   node --test book-retry.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { bestFor } from './tooling/lsp/unified-book.mjs';
import { initSwap, __test__ as SW } from './swap.js';

const ask = (id, sats) => ({ id, assetAtoms: 5000000000, btcSats: sats, price: sats / 5000000000 });
const BOOK = { asks: [ask('dead', 78219), ask('live1', 78414), ask('live2', 78608)],
               bids: [ask('deadbid', 700), ask('livebid', 690)] };

test('with no skip set, bestFor is unchanged', () => {
  assert.equal(bestFor(BOOK, 'buy').id, 'dead');
  assert.equal(bestFor(BOOK, 'sell').id, 'deadbid');
  assert.equal(bestFor(BOOK, 'nonsense'), null);
});

test('a skipped offer is passed over for the next best PRICE, not skipped to the end', () => {
  assert.equal(bestFor(BOOK, 'buy', new Set(['dead'])).id, 'live1');
  assert.equal(bestFor(BOOK, 'buy', new Set(['dead', 'live1'])).id, 'live2');
  assert.equal(bestFor(BOOK, 'sell', new Set(['deadbid'])).id, 'livebid');
});

test('skipping the whole side yields null rather than a dead offer', () => {
  assert.equal(bestFor(BOOK, 'buy', new Set(['dead', 'live1', 'live2'])), null);
});

test('an empty side is still null with a skip set', () => {
  assert.equal(bestFor({ asks: [], bids: [] }, 'buy', new Set(['x'])), null);
});

// ---------------------------------------------------------------------------
// WHICH failures may be retried. This is a whitelist on purpose: retrying is only
// SAFE where nothing was funded, and only USEFUL where the fault is the maker's.
// ---------------------------------------------------------------------------
function install(){
  initSwap({ assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: String,
    $: () => null, el: () => null, balObj: () => ({}), feeRates: {} });
  SW.clearDeadOffers();
}

test('maker-side and relay-side failures are retryable — nothing was funded', () => {
  install();
  for (const why of [
    'forward maker handshake failed (nothing funded): relay: offer has a lift in progress; retry when it frees',
    'forward maker handshake failed (nothing funded): relay: offer not found or not open',
    'maker wants 78219 BTC sats, above the offered 6248 — refuse',
    'maker delivers 100 asset atoms, below the offered 400000000 — refuse',
    'take 5 is below this offer\'s min_fill 162748182',
    'another lift is in flight (whole-HTLC, one at a time)',
    'offer already filled; awaiting re-quote',
    'the request timed out - nothing of yours was committed',
  ]) assert.equal(SW.retryableHandshakeFailure(why), true, `should retry: ${why}`);
});

test('OUR OWN malformed request is NOT retryable — it fails identically on every offer', () => {
  install();
  // Walking the book on our own bug burns the whole book and then reports the LAST
  // maker's error instead of the real cause.
  for (const why of [
    'payer bridge needs hash_h (H = SHA256(P); the TAKER mints P) — fail closed',
    'payer bridge needs taker_seq_claim_pub — fail closed',
    'payer bridge needs offer_id + maker_pubkey to lift the forward maker',
    'payer bridge needs btc_sats > 0 to bound the price the LSP funds',
    'BTC on-chain backend (SUBAS_BTC_RPC + SUBAS_BTC_WALLET) not configured',
    'payer bridge REFUSED — the LSP\'s BTC node cannot read a non-wallet maker claim',
  ]) assert.equal(SW.retryableHandshakeFailure(why), false, `must NOT retry: ${why}`);
});

test('an unrecognised failure is NOT retried — the whitelist fails closed', () => {
  install();
  assert.equal(SW.retryableHandshakeFailure('something nobody has seen before'), false);
  assert.equal(SW.retryableHandshakeFailure(''), false);
  assert.equal(SW.retryableHandshakeFailure(null), false);
});

test('a dead offer is remembered so a retry does not pick it straight back', () => {
  install();
  assert.equal(SW.deadOffers().size, 0);
  SW.markOfferDead('dead');
  assert.equal(SW.deadOffers().has('dead'), true);
  assert.equal(bestFor(BOOK, 'buy', SW.deadOffers()).id, 'live1');
  SW.clearDeadOffers();
  assert.equal(bestFor(BOOK, 'buy', SW.deadOffers()).id, 'dead');
});

test('marking a null/empty id is inert', () => {
  install();
  SW.markOfferDead(null); SW.markOfferDead('');
  assert.equal(SW.deadOffers().size, 0);
});

// The retry must live on the driver the composer ACTUALLY uses.
//
// It was first wired into driveBridged (the BRIDGE record's driver) while the live
// BTC-LN -> asset-on-chain path runs through driveLspPayerBridge on the SUBSWAP
// record — so it was inert for the exact flow it was written for. Both drivers now
// carry it, and both are entered only where nothing was funded.
test('both pre-commitment failure paths are guarded by the same whitelist', () => {
  install();
  const why = 'payer bridge: the forward-maker handshake failed: forward maker handshake failed '
            + '(nothing funded): relay: offer has a lift in progress; retry when it frees';
  assert.equal(SW.retryableHandshakeFailure(why), true,
    'the LIVE payer-bridge failure string must be recognised, wrapping and all');
});

test('the live p2p courier failure is retryable too', () => {
  install();
  assert.equal(SW.retryableHandshakeFailure('relay: offer not found or not open'), true);
});

test('a commitment-stage failure string is not treated as retryable by accident', () => {
  install();
  // Nothing in the whitelist should match a failure that happens AFTER funding; the
  // callers also gate on preimage/leg, so this is belt and braces.
  assert.equal(SW.retryableHandshakeFailure('asset claim broadcast rejected'), false);
  assert.equal(SW.retryableHandshakeFailure('hold invoice already settled'), false);
});

// THE MOST COMMON REAL FAILURE, which the first whitelist missed entirely.
//
// A resting offer outlives the maker process that posted it — the relay holds it until
// expiry — so lifting a dead maker's offer produces no refusal at all, just silence
// until the terms wait expires. That is the case the retry exists for, and
// "terms never arrived" matched nothing, so a live trade sat in 'confirming' while
// Sequentia blocks went by.
test('a maker that is simply GONE is retryable', () => {
  install();
  for (const why of [
    'payer bridge: the forward-maker terms never arrived (nothing committed)',
    'relay did not accept the lift',
    'could not reach the order-book relay',
  ]) assert.equal(SW.retryableHandshakeFailure(why), true, `should retry: ${why}`);
});
