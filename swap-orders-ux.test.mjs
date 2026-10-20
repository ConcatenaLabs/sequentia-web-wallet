// What the swap says while the wallet is still reading the chain, while a new order's funding is
// unconfirmed, and when an order is cancelled before its lock expires.
//
//   node --test swap-orders-ux.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (s, name) => { const i = s.indexOf('function ' + name + '('); assert.ok(i > 0, name); return s.slice(i, s.indexOf('\n}', i) + 2); };

test('no "You only hold" while the wallet is still reading the chain', () => {
  const holds = src.split('\n').filter((l) => /\$\('swErr'\)\.textContent = (?!notHeld\().*You only hold/.test(l));
  assert.equal(holds.length, 0, 'every such message goes through notHeld:\n' + holds.join('\n'));
  assert.ok((src.match(/notHeld\(/g) || []).length >= 7);
  assert.match(fn(src, 'notHeld'), /walletSyncing\(\) \? SYNC_TEXT : text/);
  assert.match(fn(src, 'balStr'), /if \(walletSyncing\(\)\) return 'Balance: reading the chain…';/);
  assert.match(fn(html, 'balanceShortText'), /return t && !_scannedOnce \? SYNCING_SPEND_TEXT : t;/);
  assert.match(html, /if\(sw && !sw\.classList\.contains\('hide'\)\) try\{ renderActiveSwap\(\); \}catch\{\}/, 'the swap repaints once the scan is done');
});

test('a block count reads as time', () => {
  const blocksAsTime = new Function('return ' + fn(src, 'blocksAsTime'))();
  assert.equal(blocksAsTime(1440), 'about 24 h');
  assert.equal(blocksAsTime(1437), 'about 23 h 57 min');
  assert.equal(blocksAsTime(42), 'about 42 min');
});

test('the relay refusing an unconfirmed funding is waited out, not shown as an error', () => {
  const seen = new Function('return ' + fn(src, 'fundingNotYetSeen'))();
  assert.ok(seen(new Error('invalid offer: liveness: covenant outpoint ab:0 is not an unspent output at the tip')));
  assert.ok(!seen(new Error('bad signature')));
  const place = src.slice(src.indexOf("onStatus && onStatus('Posting your resting order…');"));
  assert.match(place.slice(0, 1500), /if \(!fundingNotYetSeen\(e\)\) throw e;/);
  assert.match(place.slice(0, 1500), /Nothing is lost: the wallet lists it each time it opens/);
  assert.match(src, /reconcileUnfundedPlaced\(\)\.then\(listUnpostedPlaced\)/);
});

test('cancelling before the lock expires asks first, and the row says until when', () => {
  assert.match(fn(src, 'confirmDelist'), /The covenant has no earlier way back\./);
  const cancel = src.slice(src.indexOf("host.querySelectorAll('.swcancel').forEach"));
  assert.ok(cancel.indexOf('confirmDelist(rec, left)') < cancel.indexOf("b.textContent = 'Cancelling…'"));
  assert.match(src, /locked on-chain until block \$\{esc\(String\(r\.expiry\)\)\}/);
  assert.match(src, /\$\{locked \? 'Reclaim later' : 'Reclaim'\}/);
});
