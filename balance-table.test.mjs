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

test('Lightning says what it can send and receive, "not yet" when it cannot', () => {
  const rb = fn('renderBalance');
  assert.match(rb, /const lnSendFor = \(kind\)=>\{ try \{ return BigInt\(Math\.round\(lnSendableNow\(kind\)\.units\|\|0\)\); \} catch \{ return 0n; \} \};/);
  assert.match(rb, /line\('You can send', send>0n \? amt\(send\) : 'not yet', send>0n \? null : 'none'\);/);
  assert.match(rb, /line\('You can receive', room>0n \? amt\(room\) : 'not yet', room>0n \? null : 'none'\);/);
  assert.match(rb, /'Add room to receive'/);
});

test('a channel still opening is in the balance but sends nothing yet', () => {
  const status = { channels: [
    { node_key: 'b', leg: 'btc', asset_label: 'BTC', state: 'CHANNELD_AWAITING_LOCKIN', spendable_units: 190_000_000, balance_units: 191_000_000 },
    { node_key: 'n', asset: 'aa'.repeat(32), state: 'CHANNELD_NORMAL', spendable_units: 5000 },
    { leg: 'btc', asset_label: 'BTC', state: 'CHANNELD_NORMAL', spendable_units: 7 },   // not this wallet's
  ] };
  const make = (name) => new Function('lnLastStatus', 'lnChannelAsset', 'return ' + fn(name))(status, (c) => c.asset);
  assert.deepEqual(make('lnSendableNow')('BTC'), { units: 0, channels: 0 }, 'the BTC channel is opening: nothing to send');
  assert.equal(make('lnSpendableFor')('BTC').units, 190_000_000, 'its coins still count as the wallet\'s');
  assert.equal(make('lnBalanceFor')('BTC'), 191_000_000n);
  assert.deepEqual(make('lnSendableNow')('aa'.repeat(32)), { units: 5000, channels: 1 });
  // Paying an invoice and a BTC sale ask what can be sent now.
  assert.match(fn('lnPayShortfall'), /const can=BigInt\(Math\.floor\(Number\(lnSendableNow\(hex\)\.units\|\|0\)\)\);/);
  assert.match(html, /spendable: async \(\)=> \{ try\{ await refreshLnStatus\(\); \}catch\{\} return lnSendableNow\('BTC'\)\.units; \},/);
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

test('one figure per asset in every mode; the rails and their actions in developer mode only', () => {
  const rb = fn('renderBalance');
  assert.match(rb, /list\.classList\.add\('user'\);/);
  assert.match(html, /\.btable\.user \.bt-o,\.btable\.user \.bt-l\{display:none\}/);
  // Default mode shows no rail (docs/DEFAULT_MODE.md): the bolt, the split and every move between
  // rails are developer mode's; what is arriving, staked or frozen shows in both.
  assert.match(rb, /if\(devMode\(\) && lnOn && leg\)\{\s*const bo=el\('span','bt-bolt'\+\(hasLn\?' on':''\)\);/);
  assert.match(rb, /const dm = devMode\(\);/);
  assert.match(rb, /if\(dm && \(hasLn \|\| leafAtoms>0n \|\| staked>0n\)\) blk\('On-chain', amt\(on\)\);/);
  assert.match(rb, /if\(dm && lnOn && leg && hasLn\)\{/);
  assert.match(rb, /if\(dm && leafAtoms>0n\) blk\('Leaves', amt\(leafAtoms\)\);/);
  assert.match(rb, /if\(staked>0n\) blk\('Staked', amt\(staked\)\);/);
  assert.match(rb, /DEFAULT_WORDS\.arriving\(amt\(arriving\), ticker\)/);
  // Without a channel the one action is Move to Lightning, in developer mode's details, never on the row.
  assert.match(rb, /if\(dm && lnOn && leg && !hasLn && toLn\)\{ const d=el\('div','bt-blk'\); button\(d, 'Move to Lightning'/);
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
