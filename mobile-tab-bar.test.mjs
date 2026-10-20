// On a phone the menu is a bar fixed to the bottom of the screen, which steps aside while the
// keyboard is up and never covers the page's last line or the iPhone home indicator.
//
//   node --test mobile-tab-bar.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const phone = html.slice(html.indexOf('/* Phones: the menu is a bar fixed to the bottom'), html.indexOf('@media (max-width:480px)'));

test('the bar is fixed at the bottom on phones only', () => {
  assert.match(phone, /\.tabs\{position:fixed;left:0;right:0;bottom:0;/);
  assert.match(html, /\.tico\{display:none;/, 'no icons on a wide screen');
  assert.match(phone, /\.tabs \.tico\{display:block\}/);
  assert.match(phone, /\.tabs > button\.hide\{display:none\}/, 'hidden tabs take no slot');
});

test('it clears the home indicator and leaves room under the page', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(phone, /env\(safe-area-inset-bottom\)/);
  assert.match(phone, /body\{padding-bottom:calc\(68px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(phone, /\.more-list\{top:auto;bottom:calc\(100% \+ 10px\)/, 'More opens upward');
});

test('it hides while the keyboard is up', () => {
  assert.match(phone, /body\.typing \.tabs\{display:none\}/);
  assert.match(html, /document\.addEventListener\('focusin'/);
  assert.match(html, /window\.visualViewport\.addEventListener\('resize', sync\)/);
  assert.match(html, /vv\.height < window\.innerHeight \* 0\.75/);
});

test('the swap steps stay on one line and the flip button clears the balance', () => {
  assert.match(phone, /\.swguide\{flex-wrap:nowrap;/);
  assert.match(phone, /#swPayPane\{padding-bottom:30px\}/);
  assert.match(phone, /#swPayPane \+ \.swflip-wrap \+ \.swpane\{padding-top:30px\}/);
  assert.match(html, /@media \(max-width:360px\)\{\n    \.swguide \.gs\.done \.gn\{display:none\}/);
  const swap = readFileSync(new URL('./swap.js', import.meta.url), 'utf8');
  assert.match(swap, /<b>\$\{k < step \? '✓' : k\}<\/b><span class="gn">\$\{n\}<\/span>/);
});
