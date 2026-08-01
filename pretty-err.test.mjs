// A FAILURE WE UNDERSTAND MUST NOT READ AS "SOMETHING WENT WRONG".
//
// prettyErr collapses any message containing protocol machinery to a safe default, which is a
// real safeguard: it stops an unanticipated error from leaking settlement internals into the UI.
// But it was also swallowing the failures we DO understand. A pure-LN swap that failed because
// the counterparty's node rejected the payment reported "Something went wrong - please try
// again", and the only way to learn the actual cause was to read a console warning.
//
// These pin the named translations: each says WHAT happened and WHAT to do, and none of them
// leaks the machinery that made the catch-all necessary in the first place.
//
//   node --test pretty-err.test.mjs
import assert from 'node:assert';
import test from 'node:test';

// prettyErr's classification, mirrored from index.html.
const PRETTY_MACHINERY = /\b(rpc|hsmd|wasm|htlc|redeem|scriptpubkey|psbt|sendpay|waitsendpay|WIRE_[A-Z_]+|preimage|txid|vout|cltv|msat)\b/i;
const looksPlain = (m) => /^[A-Z0-9]/.test(m) && m.length < 300 && !/[{}<>]/.test(m);
function prettyErr(m) {
  if (/must be confidential|NotConfidentialAddress/i.test(m))
    return 'This swap has to pay you to a blinded address. Turn on "Receive this swap confidentially" and place it again - nothing was sent.';
  if (/redeem ?script mismatch|does not match quote/i.test(m))
    return 'The other side of this trade changed before it completed, so it was refused rather than paid to the wrong party. Nothing was sent; anything already locked is returned automatically.';
  if (/WIRE_INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS|unknown payment|payment_hash.*unknown/i.test(m))
    return 'The other side did not recognise this payment, so nothing was sent. Their offer has probably expired - reload the book and try again.';
  if (/WIRE_TEMPORARY_NODE_FAILURE|temporary_node_failure|temporary channel failure|WIRE_TEMPORARY_CHANNEL_FAILURE/i.test(m))
    return 'The other side’s Lightning node could not accept the payment just now, so nothing was sent. This usually clears on its own - try again, or take a different offer.';
  if (/no route|route not found|failed to find a route|WIRE_UNKNOWN_NEXT_PEER/i.test(m))
    return 'No Lightning route to the other side had room for this amount, so nothing was sent. Try a smaller amount or a different offer.';
  if (/no verified .*offer found|offer (is )?(gone|expired|no longer)|unliftable|maker is not connected|cannot be lifted/i.test(m))
    return 'The other side of that offer has gone offline, so it can no longer be filled - reload the market and take a current one.';
  if (/insufficient (funds|balance|capacity)|not enough (funds|liquidity)/i.test(m))
    return 'There is not enough balance or Lightning capacity to complete this at the size requested. Try a smaller amount.';
  if (/lightning-rpc|connection refused|ECONNREFUSED/i.test(m))
    return 'Your Lightning node is not reachable right now, so nothing was sent. Reopen the wallet to reconnect it, then try again.';
  if (/timed? ?out|timeout|deadline exceeded/i.test(m))
    return 'This took too long to complete and was stopped, so nothing was committed. Try again.';
  if (PRETTY_MACHINERY.test(m) || !looksPlain(m)) return 'Something went wrong - please try again.';
  return m;
}

// The exact strings this session produced, verbatim from the wire.
const REAL = {
  'pure-LN swap ended: pay hold: taker pay hold: waitsendpay: waitsendpay: rpc error 204: failed: WIRE_TEMPORARY_NODE_FAILURE (reply from remote)':
    /could not accept the payment just now/,
  'peer failed the cross-chain lift: btc_leg_invalid: xchain: taker BTC leg invalid (does not match quote): redeemScript mismatch (want 63a820.., got 63a820..)':
    /other side of this trade changed/,
  'error: no verified sub-asset offer found to buy 3a0f9192 with on-chain BTC':
    /no longer be filled|no longer on the book/,
  // The same-chain covenant fill's own wording for a departed maker, which reached the user as the
  // bare default while the console held the real sentence.
  'relay: maker is not connected; this offer cannot be lifted right now':
    /gone offline/,
  // The same-chain swap builder requires a blinded receive output; transparent is the wallet default,
  // so this is ordinary — and it surfaced as the bare Rust error, hiding a one-click fix.
  'Could not fill against the resting orders: Address must be confidential':
    /blinded address/,
  'inbound provisioning failed: getinfo: lightning-cli: Connecting to \'lightning-rpc\': Connection refused':
    /Lightning node is not reachable/,
};

test('every real failure this session produced now has a named message', () => {
  for (const [raw, expect] of Object.entries(REAL)) {
    const out = prettyErr(raw);
    assert.match(out, expect, `not translated: ${raw.slice(0, 60)}`);
    assert.notEqual(out, 'Something went wrong - please try again.');
  }
});

test('a named message never leaks the machinery that produced it', () => {
  // The whole reason the catch-all exists. A translation that quoted the raw error would
  // reintroduce exactly the leak it guards against.
  for (const raw of Object.keys(REAL)) {
    const out = prettyErr(raw);
    assert.ok(!PRETTY_MACHINERY.test(out), `leaked machinery: ${out}`);
    assert.ok(!/0x|63a820|WIRE_/.test(out), `leaked internals: ${out}`);
  }
});

test('every named message says what to do next', () => {
  for (const raw of Object.keys(REAL)) {
    assert.match(prettyErr(raw), /try again|reload|Reopen|smaller|different offer|returned automatically|place it again/i,
      'a failure the user cannot act on is only half-reported');
  }
});

test('the safety net still catches what we do NOT understand', () => {
  assert.equal(prettyErr('hsmd rejected: psbt vout cltv nonsense'), 'Something went wrong - please try again.');
  assert.equal(prettyErr('{"code":-32601}'), 'Something went wrong - please try again.');
});

test('a plain sentence still passes through untouched', () => {
  const plain = 'Your wallet is locked; unlock it and try again.';
  assert.equal(prettyErr(plain), plain);
});

test('the MOST SPECIFIC cause wins when a message carries several', () => {
  // A cross-chain refusal arrives as one long string that also mentions a route and a timeout.
  // Reporting "no route" for a counterparty swap would send the user to fix the wrong thing.
  const mixed = 'peer failed: redeemScript mismatch; also no route found; timed out';
  assert.match(prettyErr(mixed), /other side of this trade changed/);
});
