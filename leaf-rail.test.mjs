// The composer's leaf rail: when "Leaf" is offered, what each choice settles as, which order a
// take from leaves fills, and that the approval rows show the library's own numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leafRailOffered, leafShape, bestLeafOrder, orderRate, takeRows, swapReadRows, swapOfferRows, placeRows, postParams, offerTtl, LEAF_WORDS } from './leaf-rail.js';

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32);
const pair = { payAsset: Y, receiveAsset: X, base: X, quote: Y };   // buying X with Y

test('Leaf is offered only in developer mode, for two Sequentia assets', () => {
  assert.equal(leafRailOffered({ dev: false, joined: true, payAsset: Y, receiveAsset: X }).offered, false, 'user mode: absent');
  assert.deepEqual(leafRailOffered({ dev: true, joined: true, payAsset: Y, receiveAsset: X }), { offered: true, usable: true, why: null });
  const btc = leafRailOffered({ dev: true, joined: true, payAsset: 'BTC', receiveAsset: X });
  assert.equal(btc.offered, false);
  assert.equal(btc.why, LEAF_WORDS.btc);
  assert.equal(leafRailOffered({ dev: true, joined: true, payAsset: X, receiveAsset: 'BTC' }).offered, false);
  const nj = leafRailOffered({ dev: true, joined: false, payAsset: Y, receiveAsset: X });
  assert.deepEqual([nj.offered, nj.usable, nj.why], [true, false, LEAF_WORDS.join]);
  assert.equal(leafRailOffered({ dev: true, joined: true, payAsset: Y, receiveAsset: null }).offered, false);
});

test('each choice settles as the router plans it', () => {
  assert.equal(leafShape({ ...pair, payRail: 'chain', recvRail: 'ln', mode: 'take' }).kind, 'none');
  assert.equal(leafShape({ ...pair, payRail: 'leaf', recvRail: null, mode: 'take' }).kind, 'pending');
  const take = leafShape({ ...pair, payRail: 'leaf', recvRail: 'leaf', mode: 'take' });
  assert.equal(take.kind, 'take');
  assert.equal(take.side, 'buy');
  assert.equal(take.plan.leaf.shape, 'round');
  assert.deepEqual(take.commands, ['take_quote', 'take']);
  const sell = leafShape({ payAsset: X, receiveAsset: Y, base: X, quote: Y, payRail: 'leaf', recvRail: 'leaf', mode: 'take' });
  assert.equal(sell.side, 'sell');
  assert.equal(sell.plan.leaf.leafParty, 'seller');
  const swap = leafShape({ ...pair, payRail: 'leaf', recvRail: 'leaf', mode: 'post' });
  assert.equal(swap.kind, 'swap');
  assert.equal(swap.path, 'leaf-swap');
  assert.deepEqual(swap.commands, ['swap_offer', 'swap_read', 'swap_accept', 'swap_complete']);
  assert.equal(leafShape({ ...pair, payRail: 'leaf', recvRail: 'chain', mode: 'post' }).kind, 'place');
  const r = (s) => leafShape({ ...pair, ...s });
  assert.deepEqual(r({ payRail: 'leaf', recvRail: 'chain', mode: 'take' }), { kind: 'refused', why: LEAF_WORDS.marketChain });
  assert.deepEqual(r({ payRail: 'chain', recvRail: 'leaf', mode: 'take' }), { kind: 'refused', why: LEAF_WORDS.payToo });
  assert.deepEqual(r({ payRail: 'leaf', recvRail: 'ln', mode: 'take' }), { kind: 'refused', why: LEAF_WORDS.ln });
  assert.deepEqual(leafShape({ payAsset: 'BTC', receiveAsset: X, base: X, quote: 'BTC', payRail: 'leaf', recvRail: 'leaf', mode: 'take' }),
    { kind: 'refused', why: LEAF_WORDS.btc });
});

test('a take fills the best order the round can take, never a plain intent or a blinded one', () => {
  const cov = (id, offer, want, extra) => ({ offer_id: id, offer_asset: X, want_asset: Y, offer_amount: String(offer), want_amount: String(want),
    covenant: { asset_a: 'x' }, _verified: true, ...extra });
  const offers = [
    cov('cheap-intent', 1000000, 900000, { covenant: undefined }),            // best price, but needs its maker live on the chain
    cov('cheap-blind', 1000000, 950000, { confidential: true }),
    cov('small', 200000, 200000),                                              // best covenant price, too small for 300000
    cov('ok', 600000, 1200000),
    cov('dear', 5000000, 20000000),
    cov('forged', 5000000, 100, { _verified: false }),
    { ...cov('other-way', 600000, 1200000), offer_asset: Y, want_asset: X },
  ];
  const best = bestLeafOrder(offers, { ...pair, amount: '300000' });
  assert.equal(best.offer.offer_id, 'ok');
  assert.equal(best.path, 'leaf-take');
  assert.equal(bestLeafOrder(offers, { ...pair, amount: '100000' }).offer.offer_id, 'small');
  assert.equal(bestLeafOrder(offers, { ...pair, amount: '9000000' }).offer.offer_id, 'small', 'none holds that much: the best price');
  assert.equal(bestLeafOrder(offers.filter((o) => !o.covenant || o.confidential), { ...pair, amount: '1' }), null);
  // Selling X for Y reads the other side of the book.
  const bids = [{ offer_id: 'bid', offer_asset: Y, want_asset: X, offer_amount: '500000', want_amount: '250000', covenant: { a: 1 } }];
  const s = bestLeafOrder(bids, { payAsset: X, receiveAsset: Y, base: X, quote: Y, amount: '100' });
  assert.equal(s.offer.offer_id, 'bid');
  assert.equal(s.path, 'leaf-take');
});

test('an order’s rate is the two amounts, reduced', () => {
  assert.deepEqual(orderRate(600000n, 1200000n), { rate_num: '2', rate_den: '1' });
  assert.deepEqual(orderRate(300000n, 100000n), { rate_num: '1', rate_den: '3' });
  assert.throws(() => orderRate(0n, 5n), /above zero/);
});

const fmt = (a, v) => `${v} ${a === X ? 'X' : 'Y'}`;
test('the approvals show the library’s numbers, as it gave them', () => {
  const q = { order: 'ab:0', asset_a: X, asset_b: Y, filled: '300000', gives: '601000', price: '600000', fee: '1000', remainder: '300000', pays_itself_first: true };
  const rows = Object.fromEntries(takeRows(q, fmt, { forfeit_window_seconds: 600 }));
  assert.match(rows['You get'], /^300000 X as a leaf/);
  assert.match(rows['You give'], /^601000 Y/);
  assert.match(rows['Operator’s fee'], /^1000 Y/);
  assert.match(rows['Order after the fill'], /^300000 X rests again/);
  assert.match(rows['First'], /pays itself/);
  assert.match(rows['Your part'], /within 10 minutes/);
  const read = { gets: { asset: X, value: '300000' }, gives: { asset: Y, value: '400000' }, pays: { asset: Y, margins: '12' },
    maker_pays: { asset: X, margin: '30' }, change: { asset: Y, value: '2599988' }, coins_spent: 1, dates: { exit_deadline: 1800000000 } };
  const rr = Object.fromEntries(swapReadRows(read, fmt, (t) => 'T' + t));
  assert.match(rr['You get'], /^300000 X as a leaf/);
  assert.match(rr['You give'], /^400000 Y/);
  assert.match(rr['You pay'], /^12 Y/);
  assert.match(rr['The other wallet pays'], /^30 X/);
  assert.match(rr['Change'], /^2599988 Y/);
  assert.match(rr['Dates'], /T1800000000/);
  const off = Object.fromEntries(swapOfferRows({ gives: { asset: X, value: '300000' }, gets: { asset: Y, value: '400000' }, pays: { asset: X, margin: '30', margins: '10' } }, fmt));
  assert.match(off['You pay'], /^30 X .* 10 X/);
  const pr = Object.fromEntries(placeRows({ full_price: '1200000', fee: { asset: X, amount: '92', refresh: 0, offboard: 0, unlock_margin: 92 }, change: '0', expiry_locktime: 1800000000 },
    { sell: X, want: Y, amount: '600000', rate_num: '2', rate_den: '1' }, fmt, (t) => 'T' + t));
  assert.match(pr['For'], /^1200000 Y if filled whole; 2 of it for every 1 sold/);
  assert.match(pr['Fee'], /^92 X/);
  assert.match(pr['Refund'], /T1800000000/);
});

test('an order is listed only once it rests, for no longer than until its refund', () => {
  assert.equal(postParams({ state: 'unlocking' }, 'id', () => ({})), null);
  const p = postParams({ state: 'resting', relay: { a: 1 }, rests_at: 'ff:0', holds: '600000' }, 'id1',
    () => ({ assetA: 'a', assetB: 'b', rateNum: 2n, rateDen: 1n, minLot: 1n, expiryLocktime: 1800000000, makerProg: 'p', makerX: 'x' }));
  assert.deepEqual([p.txid, p.vout, p.sellAtoms, p.offerId], ['ff', 0, 600000n, 'id1']);
  // The terms reach the covenant code as normTerms leaves them (the relay's base64 made hex).
  let seen = null
  postParams({ state: 'resting', relay: { internal_key: 'AAAA' }, rests_at: 'ff:0', holds: '1' }, 'id', (ct) => { seen = ct; return { rateNum: 1n, rateDen: 1n } },
    (ct) => ({ ...ct, internal_key: '000000' }))
  assert.equal(seen.internal_key, '000000')
  assert.equal(offerTtl(1799990000, 1800000000), 10000 - 60);
  assert.equal(offerTtl(1700000000, 1800000000), 7 * 86400 - 60);
});

test('the page wires the leaf rail beside the composer, and the composer never runs a Leaf leg', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="swLeafBox"/);
  assert.match(html, /get leafRail\(\)\{ return leafRailApi; \}/);
  const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
  assert.match(swap, /if \(S\.payRail === 'leaf' \|\| S\.recvRail === 'leaf'\) return;/, 'onReview never places on a Leaf leg');
  assert.match(swap, /if \(cur === 'leaf'\) continue;/, 'autoRails never overrides a Leaf choice');
  assert.match(swap, /if \(r === 'leaf'\) return;   \/\/ painted by the leaf rail/);
});
