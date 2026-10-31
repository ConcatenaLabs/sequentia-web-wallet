// The balance opens on the last known Lightning part: the wallet keeps its own channels from each
// /status and reads them only until the service answers again, and only for the balance.
//
//   node --test ln-kept-status.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };
const ASSET = 'aa'.repeat(32);

function wallet () {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const make = new Function('localStorage', 'wolletKey', 'lnChannelAsset',
    'let lnLastStatus = null;' + fn('lnKeptKey') + fn('lnKeepStatus') + fn('lnKeptChannels') + fn('lnBalanceFor')
    + 'return { keep: (st) => { lnLastStatus = lnKeepStatus(st) }, restart: () => { lnLastStatus = null }, balance: lnBalanceFor, store: localStorage };');
  return { make: () => make(localStorage, () => 'w1', (c) => c.asset), store };
}

test('after a reload the balance holds the last known Lightning part until /status answers', () => {
  const w = wallet();
  const page = w.make();
  assert.equal(page.balance(ASSET), 0n, 'nothing known yet');
  page.keep({ channels: [
    { node_key: 'n', state: 'CHANNELD_NORMAL', asset: ASSET, balance_units: 2499975000 },
    { node_key: 'n', state: 'CHANNELD_NORMAL', asset: ASSET, balance_units: 200000000 },
    { state: 'CHANNELD_NORMAL', asset: ASSET, balance_units: 7 },   // not this wallet's: not kept
  ] });
  assert.equal(page.balance(ASSET), 2699975000n);
  const reloaded = w.make();   // a new page: lnLastStatus is null until the first /status
  assert.equal(reloaded.balance(ASSET), 2699975000n);
  reloaded.keep({ channels: [] });   // the service answers: its answer wins, even when empty
  assert.equal(reloaded.balance(ASSET), 0n);
  assert.equal(w.make().balance(ASSET), 0n, 'and is what the next reload starts from');
});

test('only the balance reads the kept channels; every /status is kept', () => {
  for (const name of ['lnSpendableFor', 'lnSendableNow', 'lnReceivableFor']) assert.ok(!fn(name).includes('lnKeptChannels'), name);
  assert.equal((html.match(/lnLastStatus = await seqlnGetStatus\(\)/g) || []).length, 0);
  assert.equal((html.match(/lnLastStatus = lnKeepStatus\(await seqlnGetStatus\(\)\)/g) || []).length, 4);
});

test('the balance row reads the kept part before Lightning is wired up', () => {
  assert.match(fn('renderBalance'), /const lnAtoms = \(lnOn \|\| !lnLastStatus\) \? lnAtomsFor\(kind\) : 0n;/);
});
