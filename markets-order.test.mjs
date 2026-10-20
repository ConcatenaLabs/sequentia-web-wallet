// The Markets list reads the pairs most likely to have depth first, so the bitcoin book is not the
// last thing to load, and a reissuance token is not offered as a market.
//
//   node --test markets-order.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}', i) + 2); };

test('bitcoin pairs load first, then pairs of verified assets, then the rest', () => {
  const verified = new Set(['usdx', 'oilx']);
  const loadPriority = new Function('C', 'return ' + fn('loadPriority'))({ assetVerified: (h) => verified.has(h) });
  const pairs = [{ base: 'x1', quote: 'x2' }, { base: 'usdx', quote: 'x1' }, { base: 'oilx', quote: 'BTC' }, { base: 'usdx', quote: 'oilx' }];
  const order = pairs.map((p, i) => ({ p, i, w: loadPriority(p) })).sort((a, b) => b.w - a.w || a.i - b.i).map(x => x.p.base + '/' + x.p.quote);
  assert.deepEqual(order, ['oilx/BTC', 'usdx/oilx', 'usdx/x1', 'x1/x2']);
});

test('the overview loads in that order and re-sorts as depth arrives', () => {
  const r = fn('renderMarketsOverview');
  assert.match(r, /\.sort\(\(a, b\) => b\.w - a\.w \|\| a\.i - b\.i\)/);
  assert.match(r, /await _pool\(order, 6,/);
  assert.match(r, /if \(bk && bk\.count > 0 && !resort\) resort = setTimeout/);
});

test('a reissuance token is not a market asset', () => {
  assert.match(fn('startableAssets'), /if \(meta\.token_of\) continue;/);
});
