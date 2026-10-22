// A market review with nothing on the book within reach shows dashes, says why, and cannot be
// confirmed: on the testnet it opened as "-" / "-" / "-" with Confirm enabled, and Confirm failed.
//
//   node --test swap-empty-review.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');

test('an empty market review cannot be confirmed and says why', () => {
  const i = src.indexOf('async function takeCovenantWalkReview(');
  const body = src.slice(i, src.indexOf('ok.onclick', i));
  assert.match(body, /\] : \[\['You pay', '-'\], \['You receive', '-'\], \['Price', '-'\]\];/);
  assert.match(body, /if \(pv\.paid <= 0n\)\{ ok\.disabled = true; st\.className = 'status err'; st\.textContent = 'Nothing on the book can fill this now\. Try again in a minute, or switch to Limit to rest an order at your price\.'; \}/);
  assert.ok(body.indexOf('if (pv.paid <= 0n)') > body.indexOf("C.modalRows({ title: 'Review market order'"), 'after the review is built');
});
