// The swap composer on the Lightning rails (21/10/2026, USDX/tSEQ): both amounts show what the
// Lightning offer fills, and a pair with no maker for one side over Lightning says so, instead of
// sending the user from one mixed setting to the other and back.
//
//   node --test swap-rails-advice.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}', i) + 2); };

const note = (offers, supported = true) => new Function('subassetOffers', 'subAssetMixedSupported', 'return ' + fn('mixedSameNote'))(
  () => offers, () => supported);

test('quote over Lightning: the other mixed setting is named only when a maker rests for it', () => {
  const buyLnPay = { payIsBtc: true, payRail: 'ln', recvRail: 'chain', seqAsset: 't' };
  assert.equal(note([])(buyLnPay, 'buy', 'u', 'USDX', 'tSEQ'),
    'No offer on tSEQ/USDX settles with one side over Lightning · set both sides on-chain, or both over Lightning, to trade now.');
  assert.match(note([{ offer_id: 'x' }])(buyLnPay, 'buy', 'u', 'USDX', 'tSEQ'), /put USDX on-chain \(and tSEQ over Lightning\), or set both sides/);
  assert.match(note([{ offer_id: 'x' }], false)(buyLnPay, 'buy', 'u', 'USDX', 'tSEQ'), /^No offer on tSEQ\/USDX/);
});

test('base over Lightning without a maker for it: both sides the same way, never the other mixed setting', () => {
  const t = note([])({ payIsBtc: true, payRail: 'chain', recvRail: 'ln', seqAsset: 't' }, 'buy', 'u', 'USDX', 'tSEQ');
  assert.equal(t, 'No offer on tSEQ/USDX settles with tSEQ over Lightning and USDX on-chain right now · set both sides on-chain, or both over Lightning, to trade now.');
  const mixed = src.slice(src.indexOf('async function requoteMixed('));
  assert.match(mixed, /\? mixedSameNote\(route, side, qHex, qtk, \(metaOf\(route\.seqAsset\) \|\| \{\}\)\.ticker \|\| 'the base asset'\)\n      : payerBridgeDisabledNote\(route\);/);
});

test('Lightning to Lightning paints both amounts to what the offer fills', () => {
  const ln = fn('requoteLn');
  assert.match(ln, /setNativeField\(\$\('swPayAmt'\), buy \? qStr : aStr, buy \? qHex : route\.seqAsset\);/);
  assert.match(ln, /setNativeField\(\$\('swRecvAmt'\), buy \? aStr : qStr, buy \? route\.seqAsset : qHex\);/);
  assert.ok(ln.indexOf('setNativeField($(\'swPayAmt\')') < ln.indexOf("$('swRate').innerHTML = takeAtoms != null"));
  assert.match(ln, /limited to that — it is all this offer has right now/);
});
