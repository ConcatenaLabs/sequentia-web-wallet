// A swap receives at the wallet's usual (transparent) address unless the holder ticks the box that
// lets an offer pay a blinded address. The box starts unticked and is not "suggested": confidentiality
// is the holder's choice for each transfer.
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
    const n = { className: '', _html: '', classList: { hidden: false, toggle (_, on) { this.hidden = on } },
      set innerHTML (h) { this._html = h; this.input = { checked: /<input type="checkbox"[^>]*\bchecked\b/.test(h), onchange: null }; this.off = { classList: { hidden: /class="sub blind-off hide"/.test(h), toggle (_, on) { this.hidden = on } } } },
      get innerHTML () { return this._html },
      querySelector (sel) { return sel === 'input' ? this.input : sel === '.blind-off' ? this.off : null } };
    made.push(n); return n;
  };
  return { document: { createElement: node }, card: { querySelector: () => null, insertBefore () {} }, made };
}

test('the blinded receive starts unticked, the skip said, and the card is told so at once', () => {
  const { document, card, made } = fakeDom();
  const calls = [];
  const consent = new Function('document', 'return ' + fn('blindedConsent'))(document)(card, (on) => calls.push(on));
  assert.equal(consent.checked(), false);
  assert.deepEqual(calls, [false], 'the review paints what fills without blinded offers before any click');
  assert.equal(made[0].off.classList.hidden, false, 'the line saying those offers are skipped shows');
  assert.ok(!/suggested/i.test(fn('blindedConsent').split('function blindedConsent(')[1]), 'never called suggested');
  assert.match(fn('blindedConsent'), /<div class="sub blind-off">Unticked, the offers that can only pay a blinded address are skipped\.<\/div>/);
});

test('the market review previews the walk without blinded offers until the box is ticked', () => {
  const i = src.indexOf('async function takeCovenantWalkReview(');
  const body = src.slice(i, src.indexOf('ok.onclick', i));
  assert.match(body, /const askBlind = !blindedReceiveOk\(\);\s*let pv = walkPreview\(pay, receive, payAtoms, !askBlind\);/);
  assert.match(body, /consent = blindedConsent\(card, repaint\);/);
});

test('the single-offer review cannot be confirmed until the box is ticked', () => {
  const i = src.indexOf('async function reviewSame(');
  const body = src.slice(i, src.indexOf('ok.onclick', i));
  assert.match(body, /consent = blindedConsent\(modal\.querySelector\('\.card'\), \(on\) => \{\s*ok\.disabled = !on;/);
});

test('the help says the same', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /the swap asks before using one, with the box unticked, and skips those offers unless you tick it\./);
  assert.ok(!/with that choice suggested/.test(html));
});
