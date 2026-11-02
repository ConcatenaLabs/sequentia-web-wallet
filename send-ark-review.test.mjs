// Default mode keeps an asset in the Ark. Max on Send read only the chain's coins, so for an asset
// held in the Ark it said "nothing left to send after the fee"; and a payment in the Ark showed no
// fee line at all, where the Bitcoin ark's review says "No fees" (02/11/2026).
//
//   node --test send-ark-review.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORDS } from './default-arca.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('Max for an asset paid in the Ark counts what the Ark can send', () => {
  assert.match(html, /const tree=\(!devMode\(\) && leavesApi && leavesApi\.isOpen\(\) && !isOampAsset\(hex\)\) \? \(leavesApi\.leafAtoms\(hex\)\|\|0n\) - \(leavesApi\.arriving\(hex\)\|\|0n\) : 0n;/);
  assert.match(html, /const inTree=tree > 0n && \(!typed \|\| !!leavesApi\.treeRoute\(payCodeDestination\(typed, hex\)\)\);/);
  assert.match(html, /max = \(inTree \? tree : BigInt\(availableFor\(hex\)\)\) - others;/);
  // Elsewhere it says what to do instead of "nothing left to send after the fee".
  assert.match(html, /if\(!inTree && max<=0n && tree>0n\) throw new Error\(DEFAULT_WORDS\.maxArkElsewhere\);/);
  // The chain's fee sizing runs only for the chain.
  assert.match(html, /if\(!inTree && sendFee && sendFee\.hex===hex && !isOampAsset\(hex\)\)\{/);
});

test('every payment out of the Ark shows its fee line, "No fees" when there is none', () => {
  assert.equal(DEFAULT_WORDS.feeLabel, 'Fee');
  assert.equal(DEFAULT_WORDS.noFee, 'No fees');
  assert.match(fn('treeSendReview'), /kv: \[\[DEFAULT_WORDS\.feeLabel, DEFAULT_WORDS\.noFee\]\]/);
  for (const name of ['assetLightningReview', 'offboardReview'])
    assert.match(fn(name), /kv: \[\[DEFAULT_WORDS\.feeLabel, fee>0n \? fmtAtoms\(fee, m0\.precision\|\|0\) \+ ' ' \+ m0\.ticker : DEFAULT_WORDS\.noFee\]\]/, name);
  assert.ok(!/kv: fee>0n \?/.test(html), 'no review hides a zero fee');
  assert.ok(DEFAULT_WORDS.maxArkElsewhere.length > 0);
});
