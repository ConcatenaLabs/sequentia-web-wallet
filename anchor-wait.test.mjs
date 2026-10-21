// A swap whose maker waits on Sequentia's Bitcoin anchor says so, instead of "Could not reach the
// maker": 21/10/2026, testnet4 split from 157183, anchor held at 157182, BTC lock at 157217.
//
//   node --test anchor-wait.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./xswap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}', i) + 2); };
const anchorWaitText = new Function('return ' + fn('anchorWaitText'))();

test('a contested testnet4 is named as the reason', () => {
  const t = anchorWaitText({ anchor: 157182, lockHeight: 157217, contestedFrom: 157183 });
  assert.match(t, /testnet4 has split into competing chains from block 157183/);
  assert.match(t, /its anchor stays at 157182/);
  assert.match(t, /not the maker/);
});

test('an anchor merely behind says the two heights; one caught up says nothing', () => {
  assert.equal(anchorWaitText({ anchor: 157215, lockHeight: 157217, contestedFrom: null }),
    'The maker locks the asset once Sequentia anchors a Bitcoin block after your lock: Sequentia anchors block 157215, your lock is at 157217.');
  assert.equal(anchorWaitText({ anchor: 157217, lockHeight: 157217, contestedFrom: 157183 }), null);
  assert.equal(anchorWaitText({ anchor: 0, lockHeight: 157217, contestedFrom: null }), null);
  assert.equal(anchorWaitText({ anchor: 157182, lockHeight: -1, contestedFrom: null }), null);
});

test('both places that wait on the maker ask the anchor first', () => {
  const stranded = src.slice(src.indexOf('if (!marginGone){'));
  assert.ok(stranded.indexOf('await anchorWait()') < stranded.indexOf('Could not reach the maker just now'));
  assert.match(fn('startSeqLockNarrative'), /const why = mins >= 3 \? await anchorWait\(\)/);
  assert.match(fn('anchorWait'), /get\('\/lsp\/anchor'\), get\('\/testnet4\/forks'\)/);
});
