// A node's refusal of a transaction reads as a sentence, never as its reject code.
//
//   node --test node-reject.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { nodeRejectText, shortfallText } from './node-reject.js';

// As they reach the wallet: the explorer's broadcast answer, Esplora's, and the node's RPC error.
const SEEN = {
  'http://localhost:8080/api/tx returned HTTP 400: bad-txns-inputs-missingorspent': /already been spent/,
  'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 100 < 141"}': /fee is too low/,
  'sendrawtransaction RPC error: {"code":-26,"message":"mempool min fee not met"}': /fee is too low/,
  'insufficient fee, rejecting replacement 7f3a…; new feerate 0.00001 <= old feerate 0.00001': /fee is too low/,
  'HTTP 400: txn-mempool-conflict': /waiting for a block/,
  'HTTP 400: too-long-mempool-chain, too many unconfirmed ancestors [limit: 25]': /in a row/,
  'HTTP 400: non-final': /time-locked/,
  'HTTP 400: non-BIP68-final': /time-locked/,
  'HTTP 400: dust': /too small/,
  'HTTP 400: bad-txns-asset-frozen, frozen by its supervisor': /frozen/,
  'HTTP 400: bad-txns-supervision-declaration': /supervision rules/,
  'HTTP 400: bad-txns-multiple-fee-assets': /exactly one asset/,
  'HTTP 400: bip125-replacement-disallowed': /does not allow replacement/,
  'HTTP 400: bad-txns-in-belowout, value in (0.1) < value out (0.2)': /network refused this transaction/,
};

test('every reject code reaching the wallet has a sentence', () => {
  for (const [raw, want] of Object.entries(SEEN)) {
    const out = nodeRejectText(raw);
    assert.ok(out, 'no sentence for: ' + raw);
    assert.match(out, want, raw);
  }
});

test('a sentence never quotes the code, and says what happened to the money', () => {
  for (const raw of Object.keys(SEEN)) {
    const out = nodeRejectText(raw);
    assert.ok(!/bad-|txn-|non-final|BIP|HTTP|RPC|\{/.test(out), 'leaked: ' + out);
    assert.match(out, /Nothing was sent|nothing was sent/, out);
  }
});

test('the most specific code wins', () => {
  // The broadcast of a payment whose inputs another transaction took: the conflict, not the fee.
  assert.match(nodeRejectText('bad-txns-inputs-missingorspent; also min relay fee not met'), /already been spent/);
});

test('a transaction the network already has is not a refusal', () => {
  for (const raw of ['HTTP 400: txn-already-in-mempool', 'txn-already-known', 'Transaction already in block chain']) {
    assert.equal(nodeRejectText(raw), null, raw);
  }
});

test('a message without a reject code is left to the caller', () => {
  for (const raw of ['Your wallet is locked; unlock it and try again.', 'timed out', '', null, undefined]) {
    assert.equal(nodeRejectText(raw), null, String(raw));
  }
});

test('the page asks here before anything else', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /import \{ nodeRejectText, shortfallText \} from '\.\/node-reject\.js';/);
  const body = html.slice(html.indexOf('function prettyErr(e){'));
  const first = body.indexOf('nodeRejectText(m)'), other = body.indexOf('if(/');
  assert.ok(first > 0 && first < other, 'prettyErr must consult nodeRejectText before its own rules');
});

const META = (h) => h.startsWith('e396') ? { ticker: 'EURX', precision: 8 } : { ticker: 'USDX', precision: 8 };

test('a shortfall is said in the asset, not in atoms and ids', () => {
  const t = shortfallText('Insufficient funds: missing 702 units for asset e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13', META);
  assert.equal(t, 'Not enough EURX: 0.00000702 EURX short, counting the network fee when it is paid in EURX. Lower the amount, or pay the fee in another asset.');
});

test('coins at blinded outputs that an order cannot take are named, with the way out', () => {
  const t = shortfallText('insufficient transparent 2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de: need 999998663, have 0 (a further 49999999999065 is held in confidential outputs, which an on-chain covenant fill cannot spend; send it to yourself at a transparent address first)', META);
  assert.match(t, /you hold 0 USDX that way; the other 499999.99999065 USDX is at blinded outputs\. Send it to yourself/);
  assert.equal(shortfallText('something else', META), null);
});
