// The Balance tab as one table: every asset in the same five cells (asset, on-chain, Lightning with
// what it can send and receive, total, value in the right-hand column), one card per asset on a
// phone with Lightning on the left and on-chain on the right.
//
//   node --test balance-table.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('every row has the same cells, value last', () => {
  assert.match(fn('balRow'), /cell\('bt-a', null, a\); cell\('bt-o', 'On-chain', onchain\); cell\('bt-l', 'Lightning', ln\); cell\('bt-t', 'Total', total\); cell\('bt-u', null, value\);/);
  const rb = fn('renderBalance');
  assert.match(rb, /list\.appendChild\(balHeader\(\)\);/);
  assert.equal((html.match(/appendChild\(balRow\(\{/g) || []).length, 3, 'assets, hidden assets and restricted assets');
  assert.ok(!/'asset-row arow2'/.test(html), 'no row is left in the old layout');
});

test('Lightning says what it can send and receive, "not yet" when it cannot receive', () => {
  const rb = fn('renderBalance');
  assert.match(rb, /line\('can send', amt\(lnSendFor\(kind\)\)\);/);
  assert.match(rb, /line\('can receive', room>0n \? amt\(room\) : 'not yet', room>0n \? null : 'none'\);/);
  assert.match(rb, /'Add room to receive'/);
});

test('the Lightning balance is the channel share, what can be sent its fallback', () => {
  const units = new Function('lnLastStatus', 'lnChannelAsset', 'return ' + fn('lnBalanceFor'))(
    { channels: [
      { node_key: 'n', state: 'CHANNELD_NORMAL', asset: 'aa', balance_units: 100, spendable_units: 90 },
      { node_key: 'n', state: 'CHANNELD_NORMAL', asset: 'aa', spendable_units: 40 },
      { state: 'CHANNELD_NORMAL', asset: 'aa', balance_units: 7 },                       // not this wallet's
      { node_key: 'n', state: 'CLOSINGD_COMPLETE', asset: 'aa', balance_units: 9 },
    ] }, (c) => c.asset);
  assert.equal(units('aa'), 140n);
  const lsp = readFileSync(new URL('./tooling/lsp/lsp-server.mjs', import.meta.url), 'utf8');
  assert.match(lsp, /spendable_units: spendable, receivable_units: receivable, balance_units: balance,/);
});

test('a phone shows one card per asset, Lightning left and on-chain right', () => {
  const css = html.slice(html.indexOf('@media (max-width:640px){\n    .bt-hd{display:none}'));
  assert.match(css, /grid-template-areas:"a u" "t t" "l o" "x x"/);
  assert.match(css, /border-radius:14px/);
  assert.match(css, /\.bt-o\{grid-area:o;text-align:right\}/);
});
