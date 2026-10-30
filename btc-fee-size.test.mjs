// A Bitcoin send's fee is sized from its outputs' real scripts. Counting every output as P2WPKH
// made a payment to a tb1p address 12 vB larger than the wallet paid for: at testnet4's
// 1 sat/vB estimate it paid 141 sat for 153 vB (0.92 sat/vB) and the node refused it (30/10/2026).
//
//   node --test btc-fee-size.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { btc, secp256k1 } from './btc.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };
const btcOutVbytes = new Function('btc', 'return ' + fn('btcOutVbytes'))(btc);
const btcVbytes = new Function('btcOutVbytes', 'return ' + fn('btcVbytes'))(btcOutVbytes);

const key = (b) => new Uint8Array(32).fill(b);
const p2wpkh = (b) => btc.p2wpkh(secp256k1.getPublicKey(key(b), true), btc.TEST_NETWORK);
const P2TR = 'tb1p2nw78yd4dwc4sfmuq0kann5lpu7hn60snahzwv5zx0xff4uzejmsput5ml';   // the one refused
const P2WPKH = p2wpkh(2).address;

test('each output counts its own script', () => {
  assert.equal(btcOutVbytes(P2WPKH), 31);
  assert.equal(btcOutVbytes(P2TR), 43);
  assert.equal(btcOutVbytes(''), 43);            // not typed yet: the largest
  assert.equal(btcOutVbytes('not an address'), 43);
});

test('the count form is the old P2WPKH-only size', () => {
  assert.equal(btcVbytes(1, 2), 141);
  assert.equal(btcVbytes(1, [P2WPKH, null]), 141);
  assert.equal(btcVbytes(1, [P2TR, null]), 153);
});

// Signs real transactions and checks the estimate never falls under what the node will measure.
function signed(nin, dests, change) {
  const tx = new btc.Transaction();
  const own = p2wpkh(1);
  for (let i = 0; i < nin; i++) tx.addInput({ txid: new Uint8Array(32).fill(i + 1), index: 0, witnessUtxo: { script: own.script, amount: 100_000_000n } });
  for (const a of dests) tx.addOutputAddress(a, 10_000_000n, btc.TEST_NETWORK);
  if (change) tx.addOutputAddress(P2WPKH, 1_000_000n, btc.TEST_NETWORK);
  tx.sign(key(1)); tx.finalize();
  return tx.vsize;
}

test('the estimate covers the signed transaction', () => {
  for (const nin of [1, 2, 5]) for (const dests of [[P2WPKH], [P2TR], [P2TR, P2WPKH], [P2TR, P2TR, P2TR]]) for (const change of [true, false]) {
    const est = btcVbytes(nin, change ? [...dests, null] : dests);
    const real = signed(nin, dests, change);
    assert.ok(est >= real, `${nin} in, ${dests.length} out, change ${change}: estimated ${est} < signed ${real}`);
    assert.ok(est - real <= nin, `${nin} in: estimated ${est}, signed ${real}, more than a vbyte per input over`);
  }
});

test('at 1 sat/vB the screenshot case now pays at least 1 sat/vB', () => {
  const real = signed(1, [P2TR], true);
  const fee = Math.ceil(btcVbytes(1, [P2TR, null]) * 1);
  assert.equal(real, 153);
  assert.ok(fee / real >= 1, `${fee} sat for ${real} vB`);
});

test('a BTC build never goes under the relay minimum; Sequentia fees keep their own path', () => {
  assert.match(html, /const BTC_MIN_FEERATE = 1;/);
  assert.match(fn('btcBuildTx'), /feeRate = Math\.max\(Number\(feeRate\) \|\| BTC_DEFAULT_FEERATE, BTC_MIN_FEERATE\);/);
  // The floor is BTC's alone: a Sequentia asset's rate is in its own atoms per kvB and keeps
  // the node's mempool minimum for that asset, not a sat/vB.
  const rec = fn('recommendFee');
  assert.match(rec, /if\(sat>0\) return \{ perKvb: Math\.max\(BTC_MIN_FEERATE, sat\)\*1000 \};/);
  assert.match(rec, /if\(a>0\) return \{ perKvb: Math\.max\(a, floor\) \};/);
  assert.equal((rec.match(/BTC_MIN_FEERATE/g) || []).length, 1);
});
