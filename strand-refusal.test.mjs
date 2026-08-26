// Whether a failed stranded-deposit recovery is retried decides whether the node stays
// usable at all. A refusal by this device's own signer is not transient: the same deposit
// produces the same commitment and the same refusal, and every attempt costs the node its
// signer session, because lightningd drops the connection when a signer says no. Retrying
// it on each reconnect sweep left an asset node with its signer torn down every twelve
// seconds — no invoice, no payment, no channel, for hours.
//
// index.html is one module in a page, so the classifier is mirrored here rather than
// imported; the test exists to pin the SHAPE of the messages that must never be retried,
// including the exact one seen live.
import { test } from 'node:test';
import assert from 'node:assert';

function isSignerRefusal(e) {
  const m = (e && (e.message || e)) ? String(e.message || e) : '';
  return /refus|policy|not a channel|non-channel/i.test(m);
}

test('the refusal seen live is never retried', () => {
  assert.ok(isSignerRefusal(new Error(
    'the signer REFUSED SIGN_COMMITMENT_TX — SIGN_COMMITMENT_TX refused: output 0 pays to a '
    + 'non-channel script (value 50000, script 001491fa92b4e295724da0d8f688271f49b6c1d91e72)')));
});

test('other ways the device says no are caught too', () => {
  for (const m of [
    'SIGN_COMMITMENT_TX refused: output 0 pays to a non-channel script',
    'signer policy rejected this request',
    'refused: output is not a channel output',
  ]) assert.ok(isSignerRefusal(new Error(m)), m);
});

test('a transient failure stays retryable', () => {
  for (const m of [
    'network error',
    'HTTP 502',
    'your Lightning node is still preparing (booting + syncing); try again in a moment',
    'fetch failed',
    'timed out',
  ]) assert.ok(!isSignerRefusal(new Error(m)), m);
});

test('a missing or malformed error is treated as transient, not as a permanent block', () => {
  for (const e of [null, undefined, {}, '']) assert.strictEqual(isSignerRefusal(e), false);
});
