// The Balance tab as one table, the same in every mode: one figure per asset and its value, and a
// tap on a row opens its details (on-chain, Lightning with what it can send and receive, leaves,
// staked, the actions, the asset's id and Hide).
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
  assert.equal((html.match(/(appendChild\(|const row = )balRow\(\{/g) || []).length, 3, 'assets, hidden assets and restricted assets');
  assert.ok(!/'asset-row arow2'/.test(html), 'no row is left in the old layout');
});

test('Lightning says what it can send and receive, "not yet" when it cannot receive', () => {
  const rb = fn('renderBalance');
  assert.match(rb, /line\('You can send', amt\(lnSendFor\(kind\)\)\);/);
  assert.match(rb, /line\('You can receive', room>0n \? amt\(room\) : 'not yet', room>0n \? null : 'none'\);/);
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

test('one view in every mode: one figure per asset, its parts and actions one tap away', () => {
  const rb = fn('renderBalance');
  assert.ok(!/devMode\(\)|userMode/.test(rb), 'the balance does not change with the mode');
  assert.match(rb, /list\.classList\.add\('user'\);/);
  assert.match(html, /\.btable\.user \.bt-o,\.btable\.user \.bt-l\{display:none\}/);
  // A bolt beside the ticker: yellow with a channel, grey without.
  assert.match(rb, /const bo=el\('span','bt-bolt'\+\(hasLn\?' on':''\)\);/);
  // The details: each part only when it says something, then the asset's id and Hide.
  assert.match(rb, /if\(hasLn \|\| leafAtoms>0n \|\| staked>0n\) blk\('On-chain', amt\(on\)\);/);
  assert.match(rb, /if\(leafAtoms>0n\) blk\('Leaves', amt\(leafAtoms\)\);/);
  assert.match(rb, /if\(staked>0n\) blk\('Staked', amt\(staked\)\);/);
  // Without a channel the one action is Move to Lightning, inside the details, never on the row.
  assert.match(rb, /if\(lnOn && leg && !hasLn && toLn\)\{ const d=el\('div','bt-blk'\); button\(d, 'Move to Lightning'/);
  assert.match(rb, /nameNode:nameEl, foot:sub, movable,/);
  assert.match(rb, /el\('button','ghost','Hide asset from list'\)/);
  // A tap on the row only opens or closes the details.
  assert.match(rb, /if\(ev\.target\.closest\('a,button,\.bt-det'\)\) return;/);
  const hd = new Function('el', 'priceOf', 'REF', 'return ' + fn('balHeader'))(
    (t, c, x) => ({ t, c, x, kids: [], appendChild(k) { this.kids.push(k); } }), () => 1, 'USD');
  assert.deepEqual(hd().kids.map(k => k.x), ['Asset', 'Balance', 'Value']);
});

test('staked tokens count in the figure and the headline, each stake once', () => {
  const rb = fn('renderBalance');
  assert.match(rb, /const totalAtoms = on \+ lnAtoms \+ leafAtoms \+ staked;/);
  assert.match(rb, /addToTotal\(h, BigInt\(b\[h\]\|\|0n\) \+ ln \+ leafFor\(h\) \+ stakedFor\(h\), ln\)/);
  assert.match(rb, /const totalOf=\(h\)=> BigInt\(b\[h\]\|\|0n\) \+ \(lnOn\?lnAtomsFor\(h\):0n\) \+ leafFor\(h\) \+ stakedFor\(h\);/);
  const stakes = [
    { txid: 'a', atoms: '4000000000000' },                       // not read yet: its bond
    { txid: 'b', atoms: '5000000000000' },                       // bonded
    { txid: 'c', atoms: '6000000000000' },                       // unbonding: the unbonding output
    { txid: 'd', atoms: '7000000000000' },                       // claimed: back in the wallet
    { txid: 'e', atoms: '8000000000000' },                       // spent some other way
  ];
  const states = new Map([
    ['b', { state: 'bonded', stake: { value: '5000000000000' } }],
    ['c', { state: 'unbonding', stake: { value: '6000000000000' }, unbonding: { value: '5999999990000' } }],
    ['d', { state: 'claimed' }], ['e', { state: 'left' }],
  ]);
  const staked = new Function('localStorage', 'STAKES', 'STAKE_STATES', 'DELEG', 'return ' + fn('stakedAtoms'))(
    { getItem: () => JSON.stringify(stakes) }, 'k', states, { atoms: '100000' });
  assert.equal(staked(), 4000000000000n + 5000000000000n + 5999999990000n + 100000n);
});
