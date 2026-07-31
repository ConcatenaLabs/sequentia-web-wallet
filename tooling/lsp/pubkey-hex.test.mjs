// PROTOBUF `bytes` REACH THE LSP BASE64-ENCODED, NOT HEX.
//
// The relay marshals its offer protobuf to JSON: a string field (maker_pubkey) stays hex,
// but a BYTES field (lightning.maker_claim_pub) becomes base64. Passing that through handed
// the wallet 'ArML4p01OwZC…' where a 33-byte hex pubkey was expected, and the sub-asset BUY
// died inside the HTLC builder with "invalid claim_pub hex: invalid hex character 114" —
// 'r', the second character of the base64.
//
//   node --test tooling/lsp/pubkey-hex.test.mjs
import assert from 'node:assert';
import test from 'node:test';

// The function under test is module-private in lsp-server.mjs (importing that file starts a
// server), so this pins the exact contract it implements. Keep the two in step.
function pubkeyHex(v) {
  const s = String(v || '');
  if (!s) return null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    const hex = Buffer.from(s, 'base64').toString('hex');
    return hex.length ? hex : null;
  } catch { return null; }
}

// The REAL value observed on the live relay, and the pubkey it actually encodes.
const B64 = 'ArML4p01OwZCVCD3kQYGV6P7Lyd2gaKWEGpkcFKsNBi4';
const HEX = Buffer.from(B64, 'base64').toString('hex');

test('a base64 protobuf bytes pubkey becomes hex', () => {
  const out = pubkeyHex(B64);
  assert.equal(out, HEX);
  assert.match(out, /^[0-9a-f]+$/, 'the result must be pure hex — the HTLC builder parses it as such');
  assert.equal(out.length, 66, 'a compressed secp256k1 pubkey is 33 bytes');
  assert.ok(out.startsWith('02') || out.startsWith('03'), 'compressed pubkeys start 02/03');
});

test('an already-hex pubkey passes through unchanged', () => {
  const hex = '02b30be29d353b06425420f791060657a3fb2f277681a2961069647052ac3418b8';
  assert.equal(pubkeyHex(hex), hex, 'correct whichever encoding the relay sends');
});

test('hex is lowercased so downstream comparisons are stable', () => {
  const up = '02B30BE29D353B06425420F791060657A3FB2F277681A2961069647052AC3418B8';
  assert.equal(pubkeyHex(up), up.toLowerCase());
});

test('an odd-length hex-looking string is treated as base64, not silently halved', () => {
  // 'abc' is hex-ish but cannot be bytes; it must not pass through as a bogus pubkey.
  assert.notEqual(pubkeyHex('abc'), 'abc');
});

test('absent input is null, never the string "undefined"', () => {
  for (const v of [null, undefined, '', 0, false]) assert.equal(pubkeyHex(v), null);
});
