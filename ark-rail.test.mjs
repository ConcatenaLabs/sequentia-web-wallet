// The composer's Ark rail: when "Ark" is offered, what a choice settles as, and which of the
// engine's records it follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arkRailOffered, arkShape, arkRecords, refusalWords, ARK_WORDS } from './ark-rail.js';
import { USER_WORDS } from './user-trade.js';

const X = 'aa'.repeat(32);

test('Ark is offered on the BTC side only, in developer mode', () => {
  const o = (a) => arkRailOffered({ dev: true, open: true, spendable: 195453n, ...a });
  assert.equal(o({ dev: false, payAsset: 'BTC', receiveAsset: X, leg: 'pay' }).offered, false, 'user mode: absent');
  assert.deepEqual(o({ payAsset: 'BTC', receiveAsset: X, leg: 'pay' }), { offered: true, usable: true, why: null });
  assert.equal(o({ payAsset: 'BTC', receiveAsset: X, leg: 'recv' }).offered, false, 'the asset side has no Ark');
  assert.deepEqual(o({ payAsset: X, receiveAsset: 'BTC', leg: 'recv' }), { offered: true, usable: true, why: null });
  assert.equal(o({ payAsset: X, receiveAsset: 'aa'.repeat(31) + 'bb', leg: 'pay' }).offered, false, 'no BTC in the pair');
  // Paying needs something in the ark; receiving does not.
  assert.deepEqual(o({ payAsset: 'BTC', receiveAsset: X, leg: 'pay', spendable: 0n }), { offered: true, usable: false, why: ARK_WORDS.empty });
  assert.equal(o({ payAsset: X, receiveAsset: 'BTC', leg: 'recv', spendable: 0n }).usable, true);
  assert.deepEqual(o({ payAsset: 'BTC', receiveAsset: X, leg: 'pay', open: false }), { offered: true, usable: false, why: ARK_WORDS.closed });
});

test('an Ark choice is a market trade against leaves', () => {
  const s = (a) => arkShape({ payAsset: 'BTC', receiveAsset: X, mode: 'take', ...a });
  assert.equal(s({ payRail: 'chain', recvRail: 'chain' }).kind, 'none');
  assert.equal(s({ payRail: 'ark', recvRail: null }).kind, 'pending');
  assert.deepEqual(s({ payRail: 'ark', recvRail: 'chain' }), { kind: 'refused', why: ARK_WORDS.leafToo });
  assert.deepEqual(s({ payRail: 'ark', recvRail: 'leaf', mode: 'post' }), { kind: 'refused', why: ARK_WORDS.market });
  assert.deepEqual(s({ payRail: 'ark', recvRail: 'leaf' }), { kind: 'trade', side: 'buy' });
  assert.deepEqual(arkShape({ payAsset: X, receiveAsset: 'BTC', payRail: 'leaf', recvRail: 'ark', mode: 'take' }), { kind: 'trade', side: 'sell' });
  assert.equal(arkShape({ payAsset: X, receiveAsset: 'bb'.repeat(32), payRail: 'leaf', recvRail: 'leaf', mode: 'take' }).kind, 'none');
});

test('the panel follows the trades with BTC on one side, newest first', () => {
  const r = (id, pay, get) => ({ id, ticket: { payAsset: pay, receiveAsset: get } });
  const got = arkRecords([r('1', 'BTC', X), r('2', X, 'bb'.repeat(32)), { id: '3' }, r('4', X, 'BTC')]);
  assert.deepEqual(got.map((x) => x.id), ['4', '1']);
});

test('the page wires the Ark rail beside the composer, and its engine pays BTC in the ark', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="swArkBox"/);
  assert.match(html, /body\.swark-on #swReview,[^{]*#swConfWrap[^{]*\{display:none !important\}/, 'the composer\'s controls hide while a leg is on Ark');
  assert.match(html, /get arkRail\(\)\{ return arkRailApi; \}/);
  assert.match(html, /get btc\(\)\{ return btcArkPays\(\) \? btcArk\.lightning\(\) : userBtcLightning\(\); \}/, 'one BTC wallet for every trade while the ark is open');
  const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
  assert.match(swap, /if \(C && C\.arkRail\) try \{ C\.arkRail\.paint\(\); \}/, 'every rail repaint paints the Ark rail');
});

test('a refusal is said in the words of the user composer', () => {
  const name = (h) => (h === 'BTC' ? 'BTC' : 'USDX'), amt = (h, a) => String(a);
  assert.equal(refusalWords({ why: 'not-listed', payAsset: X, receiveAsset: 'BTC' }, name, amt), USER_WORDS.notListed('BTC', 'USDX'));
  assert.equal(refusalWords({ why: 'no-funds', payAsset: 'BTC', receiveAsset: X }, name, amt), USER_WORDS.noFunds('BTC'));
  assert.equal(refusalWords({ why: 'something-new', payAsset: X, receiveAsset: 'BTC' }, name, amt), USER_WORDS.notOffered('BTC', 'USDX'));
});
