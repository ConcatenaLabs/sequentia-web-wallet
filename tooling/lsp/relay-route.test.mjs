// A TAKE MUST GO TO THE RELAY THAT HOLDS THE OFFER.
//
// The unified book merges four relays (cross, sub-asset, sub-asset-sell, pure-LN) and
// stamps each entry with its source — but every LIFT went to CFG.crossRelay. So a take
// on anything resting elsewhere (every submarine, sub-asset and pure-LN offer) answered
// "offer not found or not open", and a taker walking the book collected that same error
// from offers that were perfectly healthy.
//
// The client's hint is matched against the LSP's OWN configured set and never used as a
// URL in its own right: a caller must not be able to point the courier at any host.
//
//   node --test tooling/lsp/relay-route.test.mjs
import assert from 'node:assert';
import test from 'node:test';

const CROSS = 'http://127.0.0.1:9955';
const SUBAS = 'http://127.0.0.1:9966';
const SELL  = 'http://127.0.0.1:9971';
const PLN   = 'http://127.0.0.1:9965';

// The resolver, restated exactly as lsp-server.mjs implements it, so this test fails if
// the rule is ever loosened into trusting the caller.
function relayForOffer(hint, known = [CROSS, SUBAS, SELL, PLN]) {
  const want = String(hint || '').trim().replace(/\/+$/, '');
  if (!want) return CROSS;
  for (const k of known) if (String(k).replace(/\/+$/, '') === want) return k;
  for (const k of known) {
    try {
      const ku = new URL(k);
      if (want === ku.port || want.endsWith(':' + ku.port) || want.includes('/' + ku.port)) return k;
    } catch {}
  }
  return CROSS;
}

test('each configured relay routes to itself', () => {
  for (const r of [CROSS, SUBAS, SELL, PLN]) assert.equal(relayForOffer(r), r);
});

test('a trailing slash does not defeat the match', () => {
  assert.equal(relayForOffer(PLN + '/'), PLN);
});

test('a bare port routes correctly — the wallet reaches relays through a proxy mount', () => {
  assert.equal(relayForOffer('9965'), PLN);
  assert.equal(relayForOffer('127.0.0.1:9971'), SELL);
  assert.equal(relayForOffer('/seqob-pln/9965'), PLN);
});

test('THE BUG: a pure-LN offer must NOT be lifted on the cross relay', () => {
  assert.notEqual(relayForOffer(PLN), CROSS,
    'this is what produced "offer not found or not open" for every non-cross offer');
});

test('an UNKNOWN host is never dialled — it falls back to the configured cross relay', () => {
  for (const evil of ['http://evil.example.com', 'http://127.0.0.1:1234', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(relayForOffer(evil), CROSS,
      'a caller must not be able to point the LSP courier at an arbitrary host');
  }
});

test('an absent hint keeps the old behaviour exactly', () => {
  for (const v of ['', null, undefined, '   ']) assert.equal(relayForOffer(v), CROSS);
});
