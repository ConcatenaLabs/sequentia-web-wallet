// A market review never shows "up to 0": where nothing within reach of the best price can fill,
// its figures are dashes with the reason beneath; and when an offer it counted on cannot be taken
// and nothing else can fill, the review closes, says nothing was filled, and keeps the order in
// the form (requote) rather than stay open over zeros with a Confirm that fails again at once.
//
//   node --test swap-walk-review-failed.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const i = src.indexOf('async function takeCovenantWalkReview(');
const body = src.slice(i, src.indexOf('\nasync function placeCovenantReview(', i));

test('the review rows read a dash, never zero, when nothing fills', () => {
  const r = body.slice(body.indexOf('const rows = (p) =>'), body.indexOf('const kv = ['));
  // Evaluate the real rows() with stand-ins for the formatting helpers.
  const rows = new Function('pay', 'receive', 'amtRow', 'refSuffix', 'ratePerPayToLine',
    r + '; return rows;')('P', 'R', (a, n) => n + ' ' + a, () => '', () => ({ str: 'rate' }));
  assert.deepEqual(rows({ paid: 0n, got: 0n }).map(x => x[1]), ['-', '-', '-']);
  assert.deepEqual(rows({ paid: 10n, got: 26n }).map(x => x[1]), ['up to 10 P', '~26 R', 'Market · rate']);
});

test('a failed take with nothing else in reach closes the review and keeps the order', () => {
  const c = body.slice(body.indexOf('if (e && e.repriced){'));
  const close = c.slice(0, c.indexOf('const before = pv.got'));
  assert.match(close, /if \(!\(e\.repriced\.paid > 0n\)\)\{\s*modal\.remove\(\);/);
  assert.match(close, /Nothing was filled and nothing left this wallet\. Your order is still in the form/);
  assert.match(close, /requote\(\)/);
  assert.ok(!/resetComposer\(\)/.test(close), 'the typed order is not cleared');
  // The repaint path runs only with something to fill, and its Confirm is enabled.
  const repaint = c.slice(c.indexOf('const before = pv.got'), c.indexOf('return;', c.indexOf('const before = pv.got')));
  assert.match(repaint, /ok\.disabled = false;/);
  assert.ok(!/st.textContent = [^;]*nothing within reach of the best price can fill now/.test(c), 'no status over zeros');
});
