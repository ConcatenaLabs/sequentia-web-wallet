// The Trade tab follows the mode, by the repository owner's decision ("Simple composer in default
// mode, full composer in dev mode"): the user composer when developer mode is off, the full
// composer when it is on. A page that sets window.SEQ_USER_TRADE = false keeps the full composer in
// both modes. Change this test only when the owner asks for it.
//
//   node --test user-trade-switch.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// Which composer the Trade tab shows, as applyTradeMode decides it: 'user' or 'full'.
function shown (devMode, w) {
  const i = html.indexOf('function userTradeOn(');
  assert.ok(i > 0, 'index.html defines userTradeOn');
  const line = html.slice(i, html.indexOf('\n', i));
  const a = html.indexOf('function applyTradeMode(');
  const rule = html.slice(a, html.indexOf('\n}', a)).match(/const user = ([^;]+);/);
  assert.ok(rule, 'applyTradeMode decides the composer in one expression');
  return new Function('window', 'devMode', line + '\nreturn (' + rule[1] + ') ? "user" : "full";')(w, () => devMode);
}

test('default mode shows the user composer, developer mode the full one', () => {
  assert.equal(shown(false, {}), 'user', 'default mode, page sets nothing');
  assert.equal(shown(true, {}), 'full', 'developer mode, page sets nothing');
  assert.equal(shown(false, { SEQ_USER_TRADE: true }), 'user');
  assert.equal(shown(true, { SEQ_USER_TRADE: true }), 'full', 'developer mode is always the full composer');
});

test('a page that sets SEQ_USER_TRADE = false keeps the full composer in both modes', () => {
  assert.equal(shown(false, { SEQ_USER_TRADE: false }), 'full');
  assert.equal(shown(true, { SEQ_USER_TRADE: false }), 'full');
});

test('the mode change redraws the Trade tab', () => {
  assert.ok(/onModeChange:[^\n]*applyTradeMode\(\)/.test(html), 'switching the mode applies the rule at once');
});

test('the page itself sets no override', () => {
  assert.ok(!/window\.SEQ_USER_TRADE\s*=(?!=)/.test(html.replace(/\/\/.*$/gm, '')), 'index.html sets SEQ_USER_TRADE');
});
