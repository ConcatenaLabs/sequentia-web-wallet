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
  assert.match(fn('treeSendReview'), /const kv = \[\[DEFAULT_WORDS\.feeLabel, fee == null \? DEFAULT_WORDS\.feeKeptSome\s+: fee > 0n \? DEFAULT_WORDS\.feeKept\(fmtAtoms\(fee, m0\.precision\|\|0\), m0\.ticker, feeValue\) : DEFAULT_WORDS\.noFee\]\]/);
  // Refused for the channel side, the fee is read from the refusal, and its value shown beside it.
  assert.match(fn('treeSendReview'), /: freeing \? closing\.fee : null;/);
  assert.match(fn('treeSendReview'), /feeValue = feeValueStr\(r\.asset, fee\);/);
  // Below a cent it reads "< 0.01 USD", never a row of zeros.
  assert.match(fn('feeValueStr'), /if\(rv\.v < 0\.01\) return '< 0\.01 ' \+ refName\(rv\.ref\);/);
  assert.match(fn('feeValueStr'), /maximumFractionDigits:2/);
  // What leaves the wallet, the fee on top of the amount; no "the recipient gets the whole amount".
  assert.match(fn('treeSendReview'), /if\(fee != null && fee > 0n\) kv\.push\(\[DEFAULT_WORDS\.totalLabel, fmtAtoms\(atoms \+ fee, m0\.precision\|\|0\) \+ ' ' \+ m0\.ticker\]\);/);
  assert.ok(!('feeWhy' in DEFAULT_WORDS));
  assert.match(fn('treeSendReview'), /leavesApi\.sendQuote\(r\.addr\.trim\(\), atoms, r\.asset\)/);
  assert.equal(DEFAULT_WORDS.feeKept('0.00000704', 'EURX'), '0.00000704 EURX');
  assert.equal(DEFAULT_WORDS.feeKept('0.00000704', 'EURX', '< 0.01 USD'), '0.00000704 EURX (< 0.01 USD)');
  assert.ok(!/a little/i.test(DEFAULT_WORDS.feeKeptSome), 'no "a little" left to guess');
  for (const name of ['assetLightningReview', 'offboardReview'])
    assert.match(fn(name), /kv: \[\[DEFAULT_WORDS\.feeLabel, (settling \? DEFAULT_WORDS\.feeKeptSome : )?fee>0n \? fmtAtoms\(fee, m0\.precision\|\|0\) \+ ' ' \+ m0\.ticker : DEFAULT_WORDS\.noFee\]\]/, name);
  assert.ok(!/kv: fee>0n \?/.test(html), 'no review hides a zero fee');
  assert.ok(DEFAULT_WORDS.maxArkElsewhere.length > 0);
});

test('asking for more than can go once the fee is out, the review offers the most', () => {
  // Before: the channel side would cover it, but not with the fee: the review is for the most.
  assert.match(fn('treeSendReview'), /const most = closing\.most;\s+if\(most != null && most > 0n && most < atoms\) return treeSendReview\(\{\.\.\.r, amtS: fmtAtoms\(most, m0\.precision\|\|0\)\}, onDone, DEFAULT_WORDS\.feeOutOfAll\(m0\.ticker\)\);/);
  // After: refused for want of the fee, Send becomes "Send <most>", reviewed again.
  assert.match(fn('treeSendReview'), /ok\.textContent = DEFAULT_WORDS\.sendInstead\(less, m0\.ticker\);/);
  assert.match(fn('treeSendReview'), /await treeSendReview\(\{\.\.\.r, amtS: less\}, onDone, DEFAULT_WORDS\.feeOutOfAll\(m0\.ticker\)\); m\.remove\(\);/);
  assert.equal(DEFAULT_WORDS.sendInstead('0.30502601', 'EURX'), 'Send 0.30502601 EURX');
  // Never "It arrives in seconds." beside "takes about a minute".
  assert.match(fn('treeSendReview'), /say\(settling \? settleAhead\(\) : freeing \? waitLine : DEFAULT_WORDS\.sendLine\);/);
  assert.match(fn('treeSendReview'), /const instant = freeing \? sendableNow\(atoms, refused\) : null;/);
  // The channel side named plainly: no "set free", no "channel", no "Lightning".
  // The wait says why, how long by the chain, and the most that goes without it.
  assert.equal(DEFAULT_WORDS.waitBlock(DEFAULT_WORDS.aMinute, '0.15251221', 'EURX'),
    'This payment takes about a minute because it is larger than what you can send instantly, so it waits for the next block. You can send up to 0.15251221 EURX instantly. Keep this page open.')
  assert.match(DEFAULT_WORDS.waitBlock(DEFAULT_WORDS.tenMinutes, '', 'BTC'), /^This payment takes about 10 minutes because .* Keep this page open\.$/)
  assert.match(fn('waitFor'), /hex === 'BTC' \? DEFAULT_WORDS\.tenMinutes : DEFAULT_WORDS\.aMinute/)
  assert.ok(!/set free|channel|lightning/i.test(DEFAULT_WORDS.waitBlock('x', '1', 'EURX')))
})

test('the most and the fee after the wait are the library\'s, counted with the leaves the close gives back', () => {
  // The library names them (`most`, `fee`); an older one's words count only the coins live now.
  assert.match(fn('afterClose'), /let most = big\(e && e\.most\), fee = big\(e && e\.fee\);/)
  assert.match(fn('afterClose'), /if\(most == null\) most = sendableAfterFreeing\(atoms, said\);/)
  assert.match(fn('treeSendReview'), /closing = afterClose\(e, atoms, refused\);/)
  assert.match(fn('treeQuoteFor'), /const most = afterClose\(e, atoms, said\)\.most;/)
})

test('under the amount, the fee, how soon and the most, before the review', () => {
  assert.equal(DEFAULT_WORDS.hintSeconds(DEFAULT_WORDS.feeHint('0.00000432', 'EURX', '< 0.01 USD')), 'Fee 0.00000432 EURX (< 0.01 USD) · arrives in seconds')
  assert.equal(DEFAULT_WORDS.hintWait(DEFAULT_WORDS.feeHint('0.00000704', 'BTC', '< 0.01 USD'), DEFAULT_WORDS.tenMinutes, '0.15251221', 'BTC'),
    'Fee 0.00000704 BTC (< 0.01 USD) · takes about 10 minutes. Up to 0.15251221 BTC goes instantly.')
  assert.equal(DEFAULT_WORDS.sendUpTo('0.30502601', 'EURX'), 'You can send up to 0.30502601 EURX: the fee comes out of your balance.')
  assert.match(fn('treeQuoteFor'), /if\(most != null && most < atoms\) return upTo\(most\);/)
  assert.match(html, /r\.querySelector\('\.ramt'\)\.addEventListener\('input', \(\)=>\{ sendFeeResize\(\); showSendFee\(\); r\._quote\(\); \}\);/)
  // Max to a receive code in the tree is what the library would pay, its fee off what is held
  // (default-arca.js treeSendMax), the quote's own most when the library refuses otherwise.
  assert.match(html, /try\{ max = await treeSendMax\(max, \(a\)=> leavesApi\.sendQuote\(dest, a, hex\)\); \}/)
  assert.match(html, /catch\(e\)\{ const q=await treeQuoteFor\(typed, max, hex\)\.catch\(\(\)=>null\); if\(q\) max=q\.most; \}/)
});

test('nothing sendable while held by the wallet\'s own upkeep: the payment goes through after it, said only as how long', () => {
  assert.equal(DEFAULT_WORDS.settling, 'Goes through in about a minute')
  assert.equal(DEFAULT_WORDS.movingNow, undefined, 'the wallet never names its maintenance')
  assert.match(fn('noneNowWords'), /if\(arriving > 0n\) return DEFAULT_WORDS\.stillArriving\(m0\.ticker\);[\s\S]*if\(held > 0n\) return settleAhead\(\);/)
  assert.match(fn('settleAhead'), /return DEFAULT_WORDS\.goesThrough\(m\|\|1\);/)
  assert.match(fn('shortWords'), /return noneNowWords\(hex, m0\);/)
  assert.match(fn('treeQuoteFor'), /: noneNowWords\(hex, m0\) \}\);/)
  // The review of a payment whose quote waits only for a settlement goes on, saying how long, and
  // the payment waits for it (leaves.js paying); it is never refused for it.
  assert.match(fn('settlesFirst'), /if\(e && e\.kind === 'settle_first'\) return true;/)
  assert.match(fn('settlesFirst'), /return held > 0n && arriving <= 0n && \(most == null \|\| most <= 0n\);/)
  assert.match(fn('treeSendReview'), /else if\(settlesFirst\(e, atoms, r\.asset\)\)\{ settling = true;/)
  assert.match(fn('treeSendReview'), /say\(settling \? settleAhead\(\) : freeing \? waitLine : DEFAULT_WORDS\.sendLine\);/)
  assert.match(fn('treeSendReview'), /w\.why === 'settle'\) st\.innerHTML='<span class="spin"><\/span>' \+ esc\(settleLine\(\)\)/)
  assert.match(fn('settleLine'), /return settleWords\(w && w\.why === 'settle' \? w\.finalBy : null, m\);/)
})

test('care opens no channel in an asset being sent, nor in one held for under CHANNEL_MIN_USD', () => {
  assert.match(html, /const CHANNEL_MIN_USD = 10;/)
  assert.match(fn('noOpenChannelAssets'), /if\(hex && hex !== 'BTC' && \(addr \|\| amt\)\) out\.add\(hex\);/)
  assert.match(fn('noOpenChannelAssets'), /if\(usd != null && usd < CHANNEL_MIN_USD\) out\.add\(hex\);/)
  assert.match(html, /noOpenChannels: \(\)=> noOpenChannelAssets\(\),/)
})
