// The Trade tab is the full composer unless a page sets window.SEQ_USER_TRADE = true. The default
// is off by the repository owner's decision: turning it on by default replaced the public page's
// Trade tab with the user composer, twice. Change this test only when the owner asks for it.
//
//   node --test user-trade-switch.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('the user composer shows only on a page that asks for it', () => {
  const i = html.indexOf('function userTradeOn(');
  assert.ok(i > 0);
  const line = html.slice(i, html.indexOf('\n', i));
  const on = (w) => new Function('window', line + '\nreturn userTradeOn();')(w);
  assert.equal(on({}), false, 'unset');
  assert.equal(on({ SEQ_USER_TRADE: false }), false);
  assert.equal(on({ SEQ_USER_TRADE: 'true' }), false);
  assert.equal(on({ SEQ_USER_TRADE: 1 }), false);
  assert.equal(on({ SEQ_USER_TRADE: true }), true);
});

test('the page itself does not turn it on', () => {
  assert.ok(!/window\.SEQ_USER_TRADE\s*=\s*true/.test(html.replace(/\/\/.*$/gm, '')), 'index.html sets SEQ_USER_TRADE = true');
});
