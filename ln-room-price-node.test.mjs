// Room to receive is priced for the wallet's own node, so the service can say before any fee that
// the room is there already ("You can already receive up to … Ask for more room than that.").
//
//   node --test ln-room-price-node.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

test('the own node: the key it reconnected under, else its channel in that asset', () => {
  const make = (legKeys, status) => new Function('_lnLegNodeKey', 'lnLastStatus', 'lnChannelAsset', 'return ' + fn('lnOwnNodeKeyFor'))(legKeys, status, (c) => c.asset);
  assert.equal(make({ [A]: 'seq:a:02aa' }, null)(A), 'seq:a:02aa');
  const st = { channels: [{ asset: B, node_key: 'seq:b:03bb' }, { asset: A, node_key: 'seq:a:02cc' }, { asset: A }] };
  assert.equal(make({}, st)(A.toUpperCase()), 'seq:a:02cc');
  assert.equal(make({}, st)('cc'.repeat(32)), undefined, 'no node yet: priced without one');
});

test('every price of room to receive names the own node', () => {
  const calls = html.match(/seqlnInboundQuote\(\{[^}]*\}\)/g) || [];
  assert.equal(calls.length, 4);
  for (const c of calls) assert.match(c, /node_key: (lnOwnNodeKeyFor\(leg\.asset\)|prov\.key)/, c);
});
