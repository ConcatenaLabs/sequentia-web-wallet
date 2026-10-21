// A trade that waits on a Bitcoin block says so, the same way everywhere, with how long ago the
// last testnet4 block was found.
//
//   node --test btc-wait.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { T4_WAIT, T4_WAIT_SHORT, blockAgeText, testnet4BlockAge, __test__ } from './btc-wait.js';

test('the wait is one Bitcoin block, and the trade is safe to leave', () => {
  for (const t of [T4_WAIT, T4_WAIT_SHORT]) {
    assert.match(t, /one Bitcoin block · about 10 minutes/);
    assert.doesNotMatch(t, /hours/, 'a slow testnet4 is said only when it is slow (blockAgeText)');
  }
  assert.match(T4_WAIT, /You can close the wallet/);
  assert.ok(T4_WAIT.length < 180, 'kept short: ' + T4_WAIT.length);
});

test('the age of the last block reads as a person would say it', () => {
  assert.equal(blockAgeText(30), 'The last testnet4 block was found less than a minute ago.');
  assert.equal(blockAgeText(12 * 60), 'The last testnet4 block was found 12 min ago.');
  assert.equal(blockAgeText(80 * 60), 'The last testnet4 block was found 1 h 20 min ago: testnet4 is slow right now, so this can take a while longer.');
  assert.equal(blockAgeText(120 * 60), 'The last testnet4 block was found 2 h ago: testnet4 is slow right now, so this can take a while longer.');
  assert.equal(blockAgeText(null), '');
});

test('the age is read from the tip block, once a minute at most', async () => {
  __test__.reset();
  const now = Date.parse('2026-10-20T12:00:00Z');
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.endsWith('/blocks/tip/hash')) return { text: async () => 'ab'.repeat(32) };
    return { json: async () => ({ timestamp: (now - 25 * 60_000) / 1000 }) };
  };
  assert.equal(await testnet4BlockAge({ fetchImpl, now }), 25 * 60);
  assert.equal(await testnet4BlockAge({ fetchImpl, now: now + 30_000 }), 25 * 60 + 30);
  assert.equal(calls, 2, 'the second read came from the cache');
  __test__.reset();
  assert.equal(await testnet4BlockAge({ fetchImpl: async () => { throw new Error('down'); }, now }), null);
});

test('no screen promises "10-60 minutes" any more', () => {
  for (const f of ['swap.js', 'xswap.js', 'xrswap.js']) {
    const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    assert.ok(!/10-60\+ minutes|10–20 minutes/.test(src), f);
    assert.match(src, /from '\.\/btc-wait\.js'/, f);
  }
});
