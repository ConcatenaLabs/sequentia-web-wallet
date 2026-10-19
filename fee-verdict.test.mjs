// What Send says about a fee asset and a typed fee rate, worded as Sequentia Qt says it.
//
//   node --test fee-verdict.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { feeAssetVerdict, rateNote } from './fee-verdict.js';

const ALL = { accepted_by: 2, listed_by: 2, nodes: 2, registry_listed: true, market_price: 0.098 };

test('accepted, published and priced: green, with the price', () => {
  const v = feeAssetVerdict({ ticker: 'OILX', info: ALL, accepted: true, price: '≈ 0.098 USD' });
  assert.equal(v.state, 'ok');
  assert.match(v.text, /1 OILX ≈ 0\.098 USD/);
});

test('not listed and listed at zero are the same refusal, said differently', () => {
  const none = feeAssetVerdict({ ticker: 'GOLD', info: { ...ALL, accepted_by: 0, listed_by: 0 } });
  const zero = feeAssetVerdict({ ticker: 'GOLD', info: { ...ALL, accepted_by: 0, listed_by: 2 } });
  assert.equal(none.state, 'no'); assert.equal(zero.state, 'no');
  assert.match(none.text, /not on the fee list/);
  assert.match(zero.text, /at a rate of zero, which refuses it/);
  for (const v of [none, zero]) assert.match(v.text, /rejected before it reached a block producer\. Pick another asset/);
});

test('accepted by some of the nodes is not enough', () => {
  const v = feeAssetVerdict({ ticker: 'EURX', info: { ...ALL, accepted_by: 1 } });
  assert.equal(v.state, 'no');
  assert.match(v.text, /Only 1 of the 2 nodes/);
});

test('unpublished or unpriced: amber, with the remedy', () => {
  const unpub = feeAssetVerdict({ ticker: 'NEWT', info: { ...ALL, registry_listed: false } });
  const unpriced = feeAssetVerdict({ ticker: 'NEWT', info: { ...ALL, market_price: null } });
  assert.equal(unpub.state, 'warn'); assert.equal(unpriced.state, 'warn');
  assert.match(unpub.text, /not published on the Asset Registry/);
  assert.match(unpriced.text, /No published market price for NEWT/);
  for (const v of [unpub, unpriced]) assert.match(v.text, /replace it and pay the fee in another asset/);
});

test('the native asset answers the same questions', () => {
  assert.equal(feeAssetVerdict({ ticker: 'tSEQ', info: { ...ALL, registry_listed: false } }).state, 'warn');
});

test('without /feeinfo it falls back to the rates the nodes publish', () => {
  assert.equal(feeAssetVerdict({ ticker: 'OILX', info: null, accepted: true, price: '≈ 0.1 USD' }).state, 'ok');
  assert.equal(feeAssetVerdict({ ticker: 'OILX', info: null, accepted: true, price: '' }).state, 'warn');
  assert.equal(feeAssetVerdict({ ticker: 'OILX', info: null, accepted: false }).state, 'no');
});

// OILX, 8 decimals; the producer's view converted into OILX atoms per kvB.
const C = { accepted: true, backlog_blocks: 0.3, next_block_full: false,
  mempoolminfee_asset_atoms_per_kvb: 1000, next_block_min_asset_atoms_per_kvb: 1000 };
const note = (unitsPerVb, c) => rateNote({ unitsPerVb, precision: 8, ticker: 'OILX', congestion: c });

test('under the relay floor: refused, and Send does not build it', () => {
  const n = note(0.000000005, C);   // 500 atoms/kvB < 1000
  assert.equal(n.level, 'no'); assert.equal(n.block, true);
  assert.match(n.text, /Below 0\.00000001 OILX\/vB the network will not relay this transaction at all/);
});

test('full blocks: under the next block it waits, above it is ahead', () => {
  const full = { ...C, next_block_full: true, backlog_blocks: 2.2, next_block_min_asset_atoms_per_kvb: 5000 };
  const under = note(0.00000002, full), over = note(0.0000001, full);
  assert.equal(under.level, 'warn'); assert.equal(under.block, false);
  assert.match(under.text, /next one takes nothing below 0\.00000005 OILX\/vB, with about 3 blocks/);
  assert.equal(over.level, 'ok');
  assert.match(over.text, /At this rate yours is ahead of them/);
});

test('a producer that refuses the asset blocks the send', () => {
  const n = note(0.0000001, { ...C, accepted: false });
  assert.equal(n.block, true); assert.match(n.text, /does not accept fees in OILX/);
});

test('nothing to say without a rate or an explorer answer', () => {
  assert.equal(note(0, C), null); assert.equal(note(NaN, C), null); assert.equal(note(0.0000001, null), null);
  assert.match(note(0.0000001, C).text, /next block has room/);
});

test('the page uses both, and Send refuses what would be refused', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /import \{ feeAssetVerdict, rateNote \} from '\.\/fee-verdict\.js';/);
  assert.match(html, /const rn=await feeRateVerdict\(\); if\(rn && rn\.block\) throw new Error\(rn\.text\);/);
});
