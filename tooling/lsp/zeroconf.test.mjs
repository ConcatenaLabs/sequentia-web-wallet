// Room to receive BTC usable at once (zero-conf from the service's LP only) and its fee paid over
// Lightning: the pure parts in zeroconf.mjs, and where lsp-server.mjs and provision.mjs use them.
//
//   node --test tooling/lsp/zeroconf.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { zeroconfConfigLines, ensureConfigLines, zeroconfRunning, roomFeeLabel, parseRoomFeeLabel, roomFeePaid } from './zeroconf.mjs';

const LP = '03d97ee79d253e6c307544b69d53394b70bd0ce94b1021d9f9e2e223c10ce8b891';
const PLUG = '/root/sequentia/sequentia-web-wallet/tooling/lsp/zeroconf-from-lp.py';

test('the plugin is named for one LP id, and for nothing when either is missing', () => {
  assert.deepEqual(zeroconfConfigLines(PLUG, LP), [`plugin=${PLUG}`, `zeroconf-peer=${LP}`]);
  assert.deepEqual(zeroconfConfigLines(PLUG, LP.toUpperCase()), [`plugin=${PLUG}`, `zeroconf-peer=${LP}`]);
  assert.deepEqual(zeroconfConfigLines('', LP), []);
  assert.deepEqual(zeroconfConfigLines(PLUG, ''), []);
  assert.deepEqual(zeroconfConfigLines(PLUG, 'not-a-node-id'), []);
});

test('boot lines are added once, and a changed LP id replaces the old one', () => {
  const base = 'addr=127.0.0.1:9928\nfunding-confirms=1\nplugin=/x/holdinvoice.py\n';
  const once = ensureConfigLines(base, zeroconfConfigLines(PLUG, LP));
  assert.equal(once, base + `plugin=${PLUG}\nzeroconf-peer=${LP}\n`);
  assert.equal(ensureConfigLines(once, zeroconfConfigLines(PLUG, LP)), once, 'a second boot changes nothing');
  const other = '02' + 'ab'.repeat(32);
  const moved = ensureConfigLines(once, zeroconfConfigLines(PLUG, other));
  assert.equal(moved.match(/zeroconf-peer=/g).length, 1);
  assert.match(moved, new RegExp(`zeroconf-peer=${other}`));
  assert.match(moved, /plugin=\/x\/holdinvoice\.py/, 'other plugins stay');
  assert.match(ensureConfigLines('a=1', ['b=2']), /^a=1\nb=2\n$/);
});

test('a running plugin is found by path or by file name, an inactive one is not', () => {
  assert.equal(zeroconfRunning({ plugins: [{ name: PLUG, active: true }] }, PLUG), true);
  assert.equal(zeroconfRunning({ plugins: [{ name: '/other/dir/zeroconf-from-lp.py', active: true }] }, PLUG), true);
  assert.equal(zeroconfRunning({ plugins: [{ name: PLUG, active: false }] }, PLUG), false);
  assert.equal(zeroconfRunning({ plugins: [{ name: '/x/holdinvoice.py', active: true }] }, PLUG), false);
  assert.equal(zeroconfRunning(null, PLUG), false);
});

const NODE = 'btc:02' + 'cd'.repeat(32);
const H = 'ef'.repeat(32);
const inv = (o) => ({ invoices: [{ payment_hash: H, label: roomFeeLabel(NODE, 'BTC', 1), status: 'paid', amount_received_msat: 3_000_000, ...o }] });

test('a room-fee label names the node and the asset, and reads back', () => {
  assert.deepEqual(parseRoomFeeLabel(roomFeeLabel(NODE.toUpperCase(), 'BTC', 7)), { nodeKey: NODE, assetId: 'BTC', at: 7 });
  assert.equal(parseRoomFeeLabel('swap|' + NODE + '|BTC|7'), null);
  assert.equal(parseRoomFeeLabel('room-fee|a|b'), null);
});

test('only a paid room-fee invoice of this node and asset clears its debt, by what was received', () => {
  assert.deepEqual(roomFeePaid(inv({}), { nodeKey: NODE, assetId: 'BTC', paymentHash: H }), { paid: true, sat: 3000, label: roomFeeLabel(NODE, 'BTC', 1) });
  assert.equal(roomFeePaid(inv({ status: 'unpaid' }), { nodeKey: NODE, assetId: 'BTC', paymentHash: H }).paid, false);
  assert.equal(roomFeePaid(inv({}), { nodeKey: 'btc:03' + 'cd'.repeat(32), assetId: 'BTC', paymentHash: H }).paid, false, "another node's fee");
  assert.equal(roomFeePaid(inv({ label: 'swap-123' }), { nodeKey: NODE, assetId: 'BTC', paymentHash: H }).paid, false, 'not a room fee');
  assert.equal(roomFeePaid(inv({}), { nodeKey: NODE, assetId: 'BTC', paymentHash: '00'.repeat(32) }).paid, false, 'no such invoice');
  assert.equal(roomFeePaid(inv({}), { nodeKey: NODE, assetId: 'BTC', paymentHash: 'zz' }).paid, false);
  assert.equal(roomFeePaid(inv({ amount_received_msat: 2_999_999 }), { nodeKey: NODE, assetId: 'BTC', paymentHash: H }).sat, 2999, 'never rounded up');
});

const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8');
const prov = readFileSync(new URL('./provision.mjs', import.meta.url), 'utf8');
const between = (s, from, to) => { const i = s.indexOf(from); assert.ok(i > 0, from); return s.slice(i, s.indexOf(to, i)); };

test('a BTC room is opened only after the zero-conf plugin is asked for, toward the LP id alone', () => {
  const p = between(src, 'async function provisionInbound(', '\n}\n');
  const ask = p.indexOf('if (lp.isBtc) await ensureZeroconf(userRpc, lpId);'), fund = p.indexOf("lnrpc('fundchannel'");
  assert.ok(ask > 0 && fund > ask);
  const ens = between(src, 'async function ensureZeroconf(', '\n}\n');
  assert.match(ens, /`zeroconf-peer=\$\{lpId\}`/);
  assert.match(ens, /if \(zeroconfRunning\(pl, CFG\.zeroconfPlugin\)\) return true;/);
  assert.match(src, /bootLines: zeroconfConfigLines\(CFG\.zeroconfPlugin, \(CFG\.channelPeerBtcProvisioned \|\| ''\)\.split\('@'\)\[0\]\)/);
  assert.match(between(prov, 'function bootNode(', '\n  }\n'), /ensureConfigLines\(c, chainCfg\.bootLines\)/);
});

test('the fee is invoiced by the BTC LP and cleared once per payment, by the LP\'s own invoice', () => {
  const h = between(src, "url.pathname === '/channel/inbound/settle'", "url.pathname === '/channel/close'");
  assert.match(h, /CFG\.inboundBtcLpRpc/);
  assert.match(h, /inboundFees\.get\('ln:' \+/);
  assert.match(h, /roomFeePaid\(li, \{ nodeKey, assetId, paymentHash: body\.payment_hash \}\)/);
  assert.ok(h.indexOf("recordFeeUse('ln:'") < h.indexOf('debtClear(nodeKey, assetId, v.sat)'));
  assert.doesNotMatch(h, /CFG\.subasLpRpc/);
});
