// Default mode keeps an asset in the Ark. Max on Send read only the chain's coins, so for an asset
// held in the Ark it said "nothing left to send after the fee"; and a payment in the Ark showed no
// fee line at all, where the Bitcoin ark's review says "No fees" (02/11/2026).
//
//   node --test send-ark-review.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORDS } from './default-arca.js';
import { devRefusal, plainRefusal, LeafError, CODE_PAID_WORDS } from './leaves.js';

test('developer mode reads a paid receive code plainly, then the server\'s words', () => {
  // Seen 02/11/2026: tSEQ paid to a receive code that had already been paid in BTC.
  const raw = new LeafError({ kind: 'server_refused', code: 'key_reused', status: 409, message: 'the server refused cosign_transfer (409 key_reused): an output\'s key already owns a leaf: every leaf has a key of its own' });
  const d = devRefusal(raw);
  assert.ok(d.message.startsWith(CODE_PAID_WORDS), d.message);
  assert.ok(d.message.includes('409 key_reused'), d.message);
  assert.equal(d.code, 'key_reused');
  assert.equal(plainRefusal(raw).message, CODE_PAID_WORDS);
  // A refusal with no plain sentence stays as it is.
  const other = new LeafError({ kind: 'server_refused', code: 'nonce_used', status: 409, message: 'x' });
  assert.equal(devRefusal(other), other);
});

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
  // A payment in the tree shows the fee the library quotes for it (`send_quote`): what it keeps back
  // for its transfer, "No fees" only over a channel, and "a little" from a library that quotes none.
  assert.match(fn('treeSendReview'), /kv: \[\[DEFAULT_WORDS\.feeLabel, fee == null \? DEFAULT_WORDS\.feeKeptSome\s+: fee > 0n \? DEFAULT_WORDS\.feeKept\(fmtAtoms\(fee, m0\.precision\|\|0\), m0\.ticker, feeValue\) : DEFAULT_WORDS\.noFee\]\]/);
  // Refused for the channel side, the fee is read from the refusal, and its value shown beside it.
  assert.match(fn('treeSendReview'), /: freeing \? feeFromRefusal\(atoms, refused\) : null;/);
  assert.match(fn('treeSendReview'), /feeValue = refValueStr\(r\.asset, fee\)/);
  assert.match(fn('treeSendReview'), /if\(fee == null \|\| fee > 0n\) say\(DEFAULT_WORDS\.feeWhy\);/);
  assert.match(fn('treeSendReview'), /leavesApi\.sendQuote\(r\.addr\.trim\(\), atoms, r\.asset\)/);
  assert.equal(DEFAULT_WORDS.feeKept('0.00000704', 'EURX'), '0.00000704 EURX');
  assert.equal(DEFAULT_WORDS.feeKept('0.00000704', 'EURX', '≈ 0.000008 USD'), '0.00000704 EURX (≈ 0.000008 USD)');
  assert.ok(!/a little/i.test(DEFAULT_WORDS.feeKeptSome), 'no "a little" left to guess');
  for (const name of ['assetLightningReview', 'offboardReview'])
    assert.match(fn(name), /kv: \[\[DEFAULT_WORDS\.feeLabel, fee>0n \? fmtAtoms\(fee, m0\.precision\|\|0\) \+ ' ' \+ m0\.ticker : DEFAULT_WORDS\.noFee\]\]/, name);
  assert.ok(!/kv: fee>0n \?/.test(html), 'no review hides a zero fee');
  assert.ok(DEFAULT_WORDS.maxArkElsewhere.length > 0);
});

test('asking for more than can go once the fee is out, the review offers the most', () => {
  // Before: the channel side would cover it, but not with the fee: the review is for the most.
  assert.match(fn('treeSendReview'), /const most = sendableAfterFreeing\(atoms, refused\);\s+if\(most != null && most > 0n && most < atoms\) return treeSendReview\(\{\.\.\.r, amtS: fmtAtoms\(most, m0\.precision\|\|0\)\}, onDone, DEFAULT_WORDS\.feeOutOfAll\(m0\.ticker\)\);/);
  // After: refused for want of the fee, Send becomes "Send <most>", reviewed again.
  assert.match(fn('treeSendReview'), /ok\.textContent = DEFAULT_WORDS\.sendInstead\(less, m0\.ticker\);/);
  assert.match(fn('treeSendReview'), /await treeSendReview\(\{\.\.\.r, amtS: less\}, onDone, DEFAULT_WORDS\.feeOutOfAll\(m0\.ticker\)\); m\.remove\(\);/);
  assert.equal(DEFAULT_WORDS.sendInstead('0.30502601', 'EURX'), 'Send 0.30502601 EURX');
  // The channel side named plainly: no "set free", no "channel", no "Lightning".
  const f = DEFAULT_WORDS.freeingFirst('EURX');
  assert.match(f, /Part of your EURX is kept ready for instant payments/);
  assert.ok(!/set free|channel|lightning/i.test(f), f);
});
