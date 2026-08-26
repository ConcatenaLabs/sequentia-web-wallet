// The vectors here were produced by the node itself:
//
//   sequentia-cli signmessagewithprivkey <wif> <message>
//   sequentia-cli verifymessage <address> <signature> <message>   -> true
//
// so a mismatch means the wallet has stopped producing signatures sequentiad (or
// Bitcoin Core, which shares the format) accepts. The keys come from the standard
// BIP39 test phrase — the same one seqln.test.mjs uses — so nothing secret is in
// this file.
import { test } from 'node:test';
import assert from 'node:assert';
import { HDKey, mnemonicToSeedSync, btc } from './btc.js';
import { signMessage, messageHash, recoverPubkey, verifyAddress, verifyMessage } from './signmessage.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const key = i => HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive(`m/84'/1'/0'/0/${i}`);
const NET = btc.TEST_NETWORK;

const SHORT = {
  node: key(0),
  message: 'sequentia web wallet classic signing',
  address: 'mzYpQmSAGYWWyTLiLGbGaG8T3rHdjNcV11',
  signature: 'IPqYE4yB1g2PC2I9Yflw3yWl7Y8uJ83t/9TmuLwsRe1DV1zOey2HU8AVAeSMI8IT5VCP2gCMn8z8eMFk3WyWNVo=',
};
// 363 bytes: past the 252-byte boundary where the length prefix stops being one byte,
// and non-ASCII, so the message is measured in BYTES rather than characters.
const LONG = {
  node: key(1),
  message: 'ü '.repeat(120) + 'end',
  address: 'mqhB5Q36hdgWv2hLhyDk79zzi7MxjRYfHn',
  signature: 'ILot/sycI3Gn3LUfG8xeqiNA9xTgsmESgBUb/pAvHK7tX6aairgmDfOet5dYyA/FhtWnEfLNthmENUuyS7i5wJY=',
};

for (const [name, v] of Object.entries({ short: SHORT, long: LONG })) {
  test(`${name} message: the signature the node produces`, () => {
    assert.strictEqual(signMessage(v.node.privateKey, v.message), v.signature);
  });
  test(`${name} message: the address the node verifies against`, () => {
    assert.strictEqual(verifyAddress(v.node.publicKey, NET), v.address);
    assert.ok(verifyMessage(v.message, v.signature, v.address, NET));
  });
}

test('the message hash is 32 bytes and covers the message', () => {
  const a = messageHash('one'), b = messageHash('two');
  assert.strictEqual(a.length, 32);
  assert.notDeepStrictEqual(a, b);
});

test('the signing key is recovered from the signature alone', () => {
  const pub = recoverPubkey(SHORT.message, SHORT.signature);
  assert.deepStrictEqual(pub, SHORT.node.publicKey);
});

test('a signature does not carry over to another message, key or address', () => {
  assert.ok(!verifyMessage(SHORT.message + '!', SHORT.signature, SHORT.address, NET), 'edited message');
  assert.ok(!verifyMessage(SHORT.message, LONG.signature, SHORT.address, NET), 'other key');
  assert.ok(!verifyMessage(SHORT.message, SHORT.signature, LONG.address, NET), 'other address');
});

test('malformed input is rejected rather than thrown at the caller', () => {
  for (const bad of ['', 'not base64 at all!!', btoa('too short'), btoa('x'.repeat(65))]) {
    assert.strictEqual(verifyMessage(SHORT.message, bad, SHORT.address, NET), false, bad.slice(0, 12));
  }
});
