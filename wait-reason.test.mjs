// Why an unconfirmed transaction is still waiting: each cause named, with what to do about it.
//
//   node --test wait-reason.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { waitReasons } from './wait-reason.js';

// 0.0000014 OILX paid by a 140 vB transaction: 1 atom/vB, 1,000 atoms/kvB.
const FEE = { atoms: 140, ticker: 'OILX', precision: 8 };
const QUIET = { backlog_blocks: 0.2, next_block_full: false, accepted: true,
  mempoolminfee_asset_atoms_per_kvb: 100, next_block_min_asset_atoms_per_kvb: 100 };

test('nothing wrong says so', () => {
  const [line, ...rest] = waitReasons({ fee: FEE, vsize: 140, feeInfo: { accepted_by: 2, nodes: 2 }, congestion: QUIET });
  assert.equal(rest.length, 0);
  assert.match(line, /Nothing is holding it back/);
});

test('a fee asset only some nodes accept', () => {
  const lines = waitReasons({ fee: FEE, vsize: 140, feeInfo: { accepted_by: 1, nodes: 2 }, congestion: QUIET });
  assert.match(lines[0], /only 1 of the 2 nodes/);
  assert.match(lines[0], /Replace it and pay the fee in another asset/);
});

test('a fee asset the producer refuses', () => {
  const lines = waitReasons({ fee: FEE, vsize: 140, feeInfo: null, congestion: { ...QUIET, accepted: false } });
  assert.match(lines.join(' '), /producer does not accept fees in OILX/);
});

test('full blocks and a rate under the next block', () => {
  const cong = { ...QUIET, next_block_full: true, backlog_blocks: 3.4, next_block_min_asset_atoms_per_kvb: 5000 };
  const lines = waitReasons({ fee: FEE, vsize: 140, feeInfo: { accepted_by: 2, nodes: 2 }, congestion: cong });
  assert.equal(lines.length, 1);
  // 1,000 atoms/kvB of an 8-decimal asset is 0.00000001 per vB; 5,000 is 0.00000005.
  assert.match(lines[0], /It pays 0\.00000001 OILX\/vB; blocks are full and the next one takes nothing below 0\.00000005 OILX\/vB, with about 4 blocks/);
  assert.match(lines[0], /Speed it up/);
});

test('full blocks but a rate that makes the next block', () => {
  const cong = { ...QUIET, next_block_full: true, backlog_blocks: 3, next_block_min_asset_atoms_per_kvb: 500 };
  assert.match(waitReasons({ fee: FEE, vsize: 140, congestion: cong })[0], /Nothing is holding it back/);
});

test('under the mempool floor', () => {
  const cong = { ...QUIET, mempoolminfee_asset_atoms_per_kvb: 2000 };
  assert.match(waitReasons({ fee: FEE, vsize: 140, congestion: cong })[0], /under the 0\.00000002 OILX\/vB the mempool now requires, so nodes may drop it/);
});

test('a payment someone else paid for', () => {
  assert.match(waitReasons({ fee: null, vsize: 140, congestion: { ...QUIET, next_block_full: true, backlog_blocks: 1 } })[0],
    /about 1 block of transactions waiting\. Its sender can speed it up/);
});

test('no explorer answer is said as such, not as "nothing wrong"', () => {
  assert.match(waitReasons({ fee: FEE, vsize: 140, congestion: null })[0], /did not say how busy/);
  assert.match(waitReasons()[0], /did not say how busy/);
});

test('the page uses it', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /import \{ waitReasons \} from '\.\/wait-reason\.js';/);
  assert.match(html, /return waitReasons\(\{/);
});
