// Room to receive the node already has is not sold again. The quote refuses it before any fee is
// paid, a fee paid anyway stays the node's for the next room, and the wallet says so plainly.
//
// The case it comes from, on the testnet: a wallet with three open channels from the LP (room
// 1.00002, 33.92487622 and 45.53987639 USDX) asked for 10 USDX more. The quote priced it, the wallet
// paid the 1 USDX fee, and the open answered already_had_inbound: nothing opened, the fee kept.
//
//   node --test tooling/lsp/inbound-room-there.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { roomAlreadyThere } from './inbound-limits.mjs';

const LP = '02a0ad1bac8a1266';
const USDX = 100_000_000; // asset sats per USDX
const chan = (scid, state, room, peer = LP) => ({ peer_id: peer, short_channel_id: scid, state, receivable_msat: room * 1000 });
const testnet = [
  chan('181016x1x0', 'CHANNELD_NORMAL', 100_002_000),
  chan('181017x1x0', 'CHANNELD_NORMAL', 3_392_487_622),
  chan('181028x1x0', 'CHANNELD_NORMAL', 4_553_987_639),
];

test('room one open channel already has is there', () => {
  const r = roomAlreadyThere(testnet, LP, 10 * USDX * 1000);
  assert.equal(r.pending, false);
  assert.ok(['181017x1x0', '181028x1x0'].includes(r.channel.short_channel_id));
});

test('room above what any one channel has is not there, so it is sold', () => {
  assert.equal(roomAlreadyThere(testnet, LP, 90 * USDX * 1000), null);
});

test('room opening is there, pending; closing channels and other peers are not', () => {
  const r = roomAlreadyThere([chan('-', 'CHANNELD_AWAITING_LOCKIN', 10_246_487_639)], LP, 90 * USDX * 1000);
  assert.deepEqual([r.pending, r.channel.state], [true, 'CHANNELD_AWAITING_LOCKIN']);
  assert.equal(roomAlreadyThere([chan('x', 'AWAITING_UNILATERAL', 10_246_487_639)], LP, USDX * 1000), null);
  assert.equal(roomAlreadyThere([chan('x', 'CLOSINGD_COMPLETE', 10_246_487_639)], LP, USDX * 1000), null);
  assert.equal(roomAlreadyThere([chan('x', 'CHANNELD_NORMAL', 10_246_487_639, '03ffff')], LP, USDX * 1000), null);
  assert.equal(roomAlreadyThere(testnet, '', USDX * 1000), null, 'no LP configured: nothing is there');
});

const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8');
const between = (from, to) => { const i = src.indexOf(from); assert.ok(i > 0, from); return src.slice(i, src.indexOf(to, i)); };

test('the quote refuses room that is there before it names a fee or an address', () => {
  const quote = between("url.pathname === '/channel/inbound/quote'", "url.pathname === '/channel/inbound')");
  const check = quote.indexOf('await inboundRoomThere(nodeKey, assetId, q.amount)');
  assert.ok(check > 0, 'the quote asks the node');
  assert.match(quote, /if \(there\) q = \{ \.\.\.q, ok: false, already_have_room: true, pending: there\.pending,/);
  // A refused quote asks for nothing: no fee due, no address to pay, no held price.
  assert.ok(quote.indexOf('holdQuote(') > check && quote.indexOf('inboundFeeAddress(assetId)') > check);
  // The same for room in BTC ('BTC' is its asset here).
  assert.match(quote, /if \(q\.ok && nodeKey\) holdQuote/);
  assert.match(quote, /if \(q\.ok\) \{ try \{ payTo = await inboundFeeAddress\(assetId\)/);
  assert.match(quote, /due_now: q\.ok \? q\.fee \+ owed : 0,/);
});

test('the open and the quote use one rule', () => {
  const prov = between('async function provisionInbound(', '\n}\n');
  assert.match(prov, /const there = roomAlreadyThere\(pc\.channels, lpId, need\);/);
  const there = between('async function inboundRoomThere(', '\n}\n');
  assert.match(there, /return roomAlreadyThere\(pc\.channels, lpId, amount \* 1000\);/);
});

test('a fee paid for room that was there stays the node\'s, and is not charged', () => {
  const post = between("url.pathname === '/channel/inbound')", "url.pathname === '/channel/close'");
  assert.match(post, /if \(mode === 'prepaid' && body\.fee_txid && !r\.already_had_inbound\) markFeeOpened\(/);
  assert.match(post, /fee_charged: mode === 'prepaid' && !r\.already_had_inbound \? due : 0,/);
});

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2); };

test('the wallet says it plainly, pays nothing, and a move goes ahead without the room', () => {
  const short = new Function('fmtAtoms', 'return ' + fn('lnRoomShortText'))((a, d) => (Number(a) / 10 ** d).toString());
  assert.equal(short({ ok: false, already_have_room: true, pending: false, receivable: 4_553_987_639 }, 'USDX', 8),
    'You can already receive up to 45.53987639 USDX over Lightning in one channel. Ask for more room than that.');
  assert.equal(short({ ok: false, already_have_room: true, pending: true, receivable: 10_246_487_639 }, 'USDX', 8),
    'Room to receive this much USDX is already opening to you; it is ready in about a minute.');
  // The room dialog stops at the quote, before the fee is sent, and its refusal ends "Nothing was paid."
  const i = html.indexOf('const q=await seqlnInboundQuote({ asset: leg.asset, amount: Number(last.atoms), node_key: prov.key');
  const dlg = html.slice(i, html.indexOf('lnSendDeposit(', i));
  assert.match(dlg, /if\(!q\.ok\) throw Object\.assign\(new Error\(lnRoomShortText\(q, tk, prec\)[^\n]*\{ body: q \}\);/);
  // The move: room already there is said, and the move funds its channel without buying room.
  const j = html.indexOf('const q=await seqlnInboundQuote({ asset: leg.asset, amount: Number(room.atoms), node_key: prov.key');
  const mv = html.slice(j, html.indexOf('const res = await lnFundChannel(', j));
  assert.match(mv, /if\(!q\.ok && q\.already_have_room\) say\(lnRoomShortText\(q, leg\.ticker, leg\.precision\)\);\s*else \{/);
});
