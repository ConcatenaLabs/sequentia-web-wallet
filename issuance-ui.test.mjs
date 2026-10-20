// Issuing an asset: the form says what its choices mean, and what was typed is how the wallet shows
// the asset and its reissuance token afterwards.
//
//   node --test issuance-ui.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('a label is saved even when what is handed to it carries a BigInt', () => {
  // The issuance label used to be the whole meta, amounts included: JSON.stringify threw, after the
  // broadcast, and the asset was left unnamed, its registry entry never sent.
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const LBL = 'lbl', labels = () => JSON.parse(localStorage.getItem(LBL) || '{}');
  const saveLabel = new Function('localStorage', 'LBL', 'labels', 'return ' + fn('saveLabel'))(localStorage, LBL, labels);
  saveLabel('aa', { ticker: 'MYT', precision: 2, amount: 100000n });
  assert.deepEqual(labels().aa, { ticker: 'MYT', precision: 2, amount: '100000' });
});

test('the issuance label is the name, ticker and decimal places, and the token gets its own', () => {
  const i = html.indexOf("$('btnIssue').onclick");
  const done = html.slice(i, html.indexOf("$('btnReissue').onclick"));
  assert.match(done, /saveLabel\(assetId, \{ ticker: meta\.ticker, name: meta\.name \|\| meta\.ticker, precision: meta\.precision/);
  assert.match(done, /saveLabel\(meta\.tokenId, \{ ticker: meta\.ticker\+'-RT', name: 'Reissuance token of '\+meta\.ticker, precision: 8, token_of: assetId \}\)/);
  assert.ok(!/saveLabel\(assetId, meta\)/.test(done));
});

test('reissuable is a yes or no, and yes is one whole token, never dust', () => {
  assert.match(html, /<select id="isReissuable">/);
  assert.ok(!/id="isTokens"/.test(html), 'no free token count');
  const b = fn('buildIssuePset');
  assert.match(b, /\$\('isReissuable'\)\.value==='yes' \? REISSUANCE_TOKEN_ATOMS : 0n/);
  assert.match(html, /const REISSUANCE_TOKEN_ATOMS = 100_000_000n;/);
  assert.match(b, /issuanceToken\?\.\(\)/, 'the token id is read off the issuance input');
});

test('the decimal places are explained as they are chosen', () => {
  const h = fn('issueHints');
  assert.match(h, /the smallest amount of '\+tk\+' anyone can hold or send is/);
  assert.match(h, /This cannot be changed after issuing\./);
  assert.match(h, /nobody, you included, can issue more/);
});

test('a reissuance token is marked in the balance, with the way to use it', () => {
  const i = html.indexOf('if(tokenOf(h)){');
  assert.ok(i > 0);
  const row = html.slice(i, i + 800);
  assert.match(row, /'reissuance token'/);
  assert.match(row, /'Issue more '\+om\.ticker/);
  assert.match(fn('fillReissuePick'), /tokenOf\(h\)/);
});

test('reissue and burn say what they do, not "payment"', () => {
  const i = html.indexOf("$('btnReissue').onclick");
  const body = html.slice(i, html.indexOf("$('btnReveal').onclick"));
  assert.match(body, /'Issue more '\+m\.ticker/);
  assert.match(body, /'Burn '\+m\.ticker/);
  assert.match(body, /this cannot be undone/);
  assert.ok(!/Confirm Sequentia payment/.test(body));
  assert.equal((body.match(/Choose the asset, or paste its 64-character id\./g) || []).length, 2);
});
