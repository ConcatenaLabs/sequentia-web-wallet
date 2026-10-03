// The note about a hosted node's coins outside a channel and about the channels its device
// found in an older device's store: built from what the node reports, dismissed for good when the
// user dismisses it, one open at a time, nothing opened unasked, and the copy the wallet uses.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { makeNoteStore, channelFate, noteFor, openRequest, makeOpenGuard, outpointOf } from './lnupgrade.js';

const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1';
const LABEL = 'seq:' + GOLD + ':02' + 'ab'.repeat(32);
const chan = (t, n = 0) => ({ peerId: '03' + 'cd'.repeat(32), dbid: 4, fundingTxid: t.repeat(32), fundingOutnum: n, fundingSats: 10000000 });
const A = chan('aa'), B = chan('bb', 1), C = chan('cc');
const nodeWith = (states, onchainMsat = 0) => ({ node_up: true, onchain_msat: onchainMsat,
  channel_states: states.map(([c, state]) => ({ funding_txid: c.fundingTxid, funding_outnum: c.fundingOutnum, state })) });

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('a channel is closed only when the node reports it on chain or no longer lists it', () => {
  const node = nodeWith([[A, 'ONCHAIN'], [B, 'CHANNELD_NORMAL']]);
  assert.equal(channelFate(A, node), 'closed');
  assert.equal(channelFate(C, node), 'closed');            // the node no longer lists it
  assert.equal(channelFate(B, node), 'open');
  assert.equal(channelFate(A, nodeWith([[A, 'AWAITING_UNILATERAL']])), 'closing');
  assert.equal(channelFate(A, nodeWith([[A, 'FUNDING_SPEND_SEEN']])), 'closing');
  assert.equal(channelFate(A, nodeWith([[A, 'CLOSINGD_COMPLETE']])), 'stuck');
  assert.equal(channelFate(A, nodeWith([[A, 'CHANNELD_AWAITING_LOCKIN']])), 'open');
  // While the node does not answer, or answers without its channel list, nothing is known.
  assert.equal(channelFate(A, null), 'unknown');
  assert.equal(channelFate(A, { node_up: false, onchain_msat: 0, channel_states: [] }), 'unknown');
  assert.equal(channelFate(A, { node_up: true, onchain_msat: 0 }), 'unknown');
});

test('the note describes each old channel as the node reports it, and says nothing while the node is silent', () => {
  const n = noteFor({ label: LABEL, ticker: 'GOLD', channels: [A, B, C],
    node: nodeWith([[A, 'ONCHAIN'], [B, 'CLOSINGD_COMPLETE']], 3_000_000_000), amountText: '0.03' });
  assert.deepEqual(n.paragraphs, [
    'Your 3 GOLD Lightning channels from before the Lightning service\'s upgrade are not carried over: your device signs no step of them.',
    '2 of them are closed.',
    'One of them has a close that was agreed before the upgrade and never reached the chain; its balance stays in it.',
    '0.03 GOLD is on chain at your GOLD Lightning node\'s own address, not in a channel. Your device moves it only to your node\'s own addresses or into a channel.',
  ]);
  assert.equal(n.canOpen, true);
  // An open channel is called open, never closed; with no coins on chain there is no button.
  const o = noteFor({ label: LABEL, ticker: 'GOLD', channels: [B], node: nodeWith([[B, 'CHANNELD_NORMAL']]) });
  assert.deepEqual(o.paragraphs, ['Your GOLD Lightning channel from before the Lightning service\'s upgrade is not carried over: your device signs no step of it. It is still open and moves no payments: your device signs none of its steps.']);
  assert.equal(o.canOpen, false);
  // The node does not answer: nothing about its channels, and no button.
  assert.equal(noteFor({ label: LABEL, ticker: 'GOLD', channels: [A, B], node: null }), null);
  assert.equal(noteFor({ label: LABEL, ticker: 'GOLD', channels: [A], node: { node_up: false, onchain_msat: 0 } }), null);
});

test('coins on the node outside a channel are announced with what the device does with them', () => {
  const n = noteFor({ label: 'btc:02' + 'ef'.repeat(32), ticker: 'BTC', channels: [], node: nodeWith([], 120_000_000), amountText: '0.0012' });
  assert.deepEqual(n.paragraphs, ['0.0012 BTC is on chain at your BTC Lightning node\'s own address, not in a channel. Your device moves it only to your node\'s own addresses or into a channel.']);
  assert.equal(n.canOpen, true);
  assert.equal(noteFor({ label: LABEL, ticker: 'GOLD', channels: [], node: nodeWith([], 0) }), null);
});

test('the copy names the Lightning service, never a network upgrade, and never doubles a word', () => {
  const cases = [
    noteFor({ label: LABEL, ticker: '', channels: [A, B], node: nodeWith([[A, 'ONCHAIN'], [B, 'AWAITING_UNILATERAL']], 5), amountText: '0.00000005' }),
    noteFor({ label: LABEL, ticker: 'GOLD', channels: [A], node: nodeWith([], 5), amountText: '1' }),
  ];
  for (const n of cases) {
    for (const p of n.paragraphs) {
      assert.doesNotMatch(p, /network upgrade/i, p);
      assert.doesNotMatch(p, /\b(\w+) \1\b/i, p);
      assert.doesNotMatch(p, /held by your own keys/i, p);
      assert.doesNotMatch(p, /back on chain/i, p);
    }
  }
  assert.match(cases[0].paragraphs[0], /^Your 2 Lightning channels from before the Lightning service's upgrade/);
  // The page's own text, and this module's, follow the same rules.
  for (const f of ['./index.html', './lnupgrade.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /network upgrade/i, f);
    assert.doesNotMatch(src, /Lightning Lightning/, f);
  }
});

test('a dismissed note stays dismissed when the device reports its channels again', () => {
  const store = makeNoteStore(memStorage());
  assert.equal(store.record(LABEL, [A, B]), true);
  assert.equal(store.record(LABEL, [A, B]), false);         // the SDK repeats it after each restore
  assert.deepEqual(store.channels()[LABEL], [A, B]);
  store.dismiss(LABEL, { channels: [A] });
  assert.deepEqual(store.channels()[LABEL], [B]);
  store.dismiss(LABEL, { onchainMsat: 5000 });
  assert.equal(store.channels()[LABEL], undefined);
  assert.equal(store.record(LABEL, [A, B]), false, 'a restore brings no dismissed channel back');
  assert.deepEqual(store.channels(), {});
  assert.equal(store.record(LABEL, [C]), true, 'a channel not yet seen is new');
  // The line about idle coins stays dismissed while the amount is the same.
  assert.equal(store.idleDismissed(LABEL, 5000), true);
  assert.equal(store.idleDismissed(LABEL, 6000), false);
  assert.equal(noteFor({ label: LABEL, ticker: 'GOLD', channels: [], node: nodeWith([], 5000), amountText: 'x', idleDismissed: true }), null);
  assert.equal(outpointOf(A), 'aa'.repeat(32) + ':0');
});

test('"Open a new channel" asks for a channel funded from the node\'s own coins, consolidated first', () => {
  const node = nodeWith([], 3_000_000_000);
  assert.deepEqual(openRequest(LABEL, node), { chain: 'seq', amount: 3_000_000, node: LABEL, consolidate: true, asset: GOLD });
  const btc = 'btc:02' + 'ef'.repeat(32);
  assert.deepEqual(openRequest(btc, node), { chain: 'btc', amount: 3_000_000, node: btc, consolidate: true });
});

test('one open at a time per node: the button shows it running until it ends', () => {
  const g = makeOpenGuard();
  assert.equal(g.start(LABEL, 'Opening…'), true);
  assert.equal(g.start(LABEL, 'Opening…'), false, 'a second click starts nothing');
  g.progress(LABEL, 'Moving the coins on your Lightning node to its own address first…');
  const n = noteFor({ label: LABEL, ticker: 'GOLD', node: nodeWith([], 5), amountText: '1', opening: g.text(LABEL) });
  assert.equal(n.opening, 'Moving the coins on your Lightning node to its own address first…');
  g.end(LABEL);
  assert.equal(g.text(LABEL), null);
  assert.equal(g.start(LABEL), true);
});

test('the page opens a channel from a node\'s coins only when the user asks', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const fn = (name) => {
    const at = html.indexOf('async function ' + name + '(');
    assert.ok(at >= 0, name);
    const end = html.indexOf('\n}\n', at);
    return html.slice(at, end);
  };
  // The reconnect sweep reads what a node holds; it never funds a channel.
  assert.doesNotMatch(fn('reconnectOwnNodes'), /resumeFundChannel|fundChannel\(/);
  // The button's handler funds through openRequest (consolidate) and holds the guard.
  const open = fn('openAfterUpgrade');
  assert.match(open, /resumeFundChannel\(\{ \.\.\.openRequest\(label, info\)/);
  assert.match(open, /_lnOpenGuard\.start\(label/);
  assert.match(open, /_lnOpenGuard\.end\(label\)/);
});
