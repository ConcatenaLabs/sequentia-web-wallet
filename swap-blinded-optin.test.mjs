// A swap receives at the wallet's usual (transparent) address unless the holder ticks the box to
// receive at a blinded address. An interactive maker's offer is one offer among the others: it fills
// with the box unticked, paying the usual address in the clear. The box starts unticked, is never
// "suggested", and changes only how a fill pays the wallet, never what fills.
//
//   node --test swap-blinded-optin.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
const fn = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}', i) + 2); };

// A stand-in for the few DOM calls blindedConsent makes: it reads back the markup it was given.
function fakeDom () {
  const made = [];
  const node = () => {
    const n = { className: '', _html: '',
      set innerHTML (h) { this._html = h; this.input = { checked: /<input type="checkbox"[^>]*\bchecked\b/.test(h) } },
      get innerHTML () { return this._html },
      querySelector (sel) { return sel === 'input' ? this.input : null } };
    made.push(n); return n;
  };
  return { document: { createElement: node }, card: { querySelector: () => null, insertBefore () {} }, made };
}

test('the blinded receive starts unticked, is never suggested, and says what unticked means', () => {
  const { document, card, made } = fakeDom();
  const consent = new Function('document', 'return ' + fn('blindedConsent'))(document)(card);
  assert.equal(consent.checked(), false);
  const html = made[0].innerHTML;
  assert.ok(!/suggested/i.test(html), 'never called suggested');
  assert.match(html, /Unticked, you receive at your usual address and the amount and asset are public on chain/);
  assert.ok(!/can only pay a blinded address|are skipped/.test(html), 'no offer is said to need a blinded address');
});

test('the market walk takes interactive offers whether or not the box is ticked', () => {
  const preview = fn('walkPreview');
  assert.match(preview, /function walkPreview\(pay, receive, payAtoms\)/);
  assert.ok(!/filter\(isCovenantOffer\)/.test(preview), 'the preview does not drop interactive offers');
  const i = src.indexOf('export async function takeMarketWalk(');
  const walk = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!/filter\(isCovenantOffer\)/.test(walk), 'the walk does not drop interactive offers');
  assert.match(walk, /liftOffer\(\{ \.\.\.q, blindReceive: blindOk \}/, 'a lift receives blinded only when the holder chose it');
});

test('the reviews can be confirmed with the box unticked', () => {
  const i = src.indexOf('async function takeCovenantWalkReview(');
  const market = src.slice(i, src.indexOf('ok.onclick', i));
  assert.match(market, /if \(askBlind && pv\.interactive\) consent = blindedConsent\(modal\.querySelector\('\.card'\)\);/);
  assert.ok(!/ok\.disabled/.test(market), 'the market review is not disabled by the box');
  const j = src.indexOf('async function reviewSame(');
  const single = src.slice(j, src.indexOf('ok.onclick', j));
  assert.ok(!/ok\.disabled/.test(single), 'the single-offer review is not disabled by the box');
});

test('a lift receives at the usual address unless the holder chose blinded', () => {
  const lift = fn('liftOffer');
  assert.match(lift, /const receiveAddr = \(q\.confidential \|\| q\.blindReceive \|\| _confidentialReceive \|\| isConfBook\(\)\) \? _raw : \(_raw\.toUnconfidential \? _raw\.toUnconfidential\(\) : _raw\);/);
});

test('the help says the same', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /Unticked, it pays your usual address in the clear, like any transfer\./);
  assert.ok(!/so they can only pay a blinded address/.test(html));
  assert.match(html, /transparent receive spends only explicit coins/);
});
