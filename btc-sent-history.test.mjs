// A Bitcoin payment shows in History the moment it is sent, and its review keeps an address from
// squeezing the amount into one character per line.
//
//   node --test btc-sent-history.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('a sent payment is remembered until the explorer lists it', () => {
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const env = 'const BTC_PENDING_KEY="k";' + fn('btcPendingSends') + fn('saveBtcPending') + fn('noteBtcSent') + 'return { btcPendingSends, noteBtcSent };';
  const { btcPendingSends, noteBtcSent } = new Function('localStorage', env)(localStorage);
  noteBtcSent('aa', -540772n);
  noteBtcSent('aa', -1n);
  assert.deepEqual(btcPendingSends().map((p) => [p.txid, p.delta]), [['aa', '-1']], 'one row per txid');
  store.set('k', JSON.stringify([{ txid: 'old', delta: '-1', at: Date.now() - 4 * 86_400_000 }]));
  assert.equal(btcPendingSends().length, 0, 'forgotten after three days');
});

test('History draws them first and drops them once listed', () => {
  assert.match(fn('drawBtcRows'), /btcPendingSends\(\)\.filter\(p=>!known\.has\(p\.txid\)\)/);
  assert.match(html, /just sent, the explorer has not listed it yet/);
  assert.match(fn('renderBtcHistory'), /const left=p\.filter\(x=>!seenIds\.has\(x\.txid\)\)/);
  const send = html.slice(html.indexOf("const r=await fetch(`${T4_API}/tx`, {method:'POST', body:built.hex});"));
  assert.ok(send.indexOf('noteBtcSent(txt, -gone)') < send.indexOf('showSent('), 'remembered before the card shows');
  assert.match(send.slice(0, 1500), /historyAt:'btcHistList'/);
});

test('a review row lets a long key wrap and keeps room for the value', () => {
  assert.match(html, /\.kv \.k\{color:var\(--dim\);flex:0 0 auto;max-width:calc\(62% - 14px\);overflow-wrap:anywhere\}/);
  assert.match(html, /\.kv \.v\{text-align:right;overflow-wrap:anywhere;min-width:min\(9\.5em,38%\);flex:1 1 auto;/);
});
