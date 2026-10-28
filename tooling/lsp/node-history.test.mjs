// node-history.mjs against the records of real SeqLN nodes (testdata/node-history-regtest.json: three
// regtest nodes with holdinvoice-seq, a pure-Lightning take, a sub-asset buy and sell, a plain pay and
// receive, and a cancelled, an unpaid and an unsettled hold; preimages removed), and the edges around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeHistoryItems, readNodeHistory, cleanNote, HOLD_STORE, NOTE_STORE } from './node-history.mjs';

const fx = JSON.parse(readFileSync(new URL('./testdata/node-history-regtest.json', import.meta.url)));
const H = fx.hashes;
const fromNode = (n, asset, extra = {}) => {
  const d = fx.nodes[n];
  return nodeHistoryItems({ invoices: d.listinvoices, pays: d.listpays, holds: d.listdatastore, htlcs: d.listhtlcs,
    events: d['bkpr-listaccountevents'], asset, ...extra });
};
const key = (items) => items.map((i) => [i.payment_hash, i.dir, i.kind, i.amount_msat]);

test('the GOLD node: both bare-hash pays and the plain pay, nothing failed', () => {
  const items = fromNode('l1_gold_user', fx.gold);
  assert.deepEqual(new Set(key(items).map(JSON.stringify)), new Set([
    [H.pureln, 'out', 'pay', 5_000_000_000], [H.subsell, 'out', 'pay', 2_000_000_000], [H.plainout, 'out', 'pay', 1_000_000_000],
  ].map(JSON.stringify)));
  for (const i of items) { assert.equal(i.asset, fx.gold); assert.ok(i.at > 0); }
});

test('the SILV node: the pure-Lightning receive, the hold receipt and the plain receive; no unsettled hold', () => {
  const items = fromNode('l3_silv_user', fx.silv);
  const by = new Map(items.map((i) => [i.payment_hash, i]));
  assert.equal(items.length, 3);
  assert.equal(by.get(H.pureln).kind, 'invoice');
  assert.equal(by.get(H.pureln).amount_msat, 7_000_000_000);
  const hold = by.get(H.subbuy);
  assert.equal(hold.kind, 'hold'); assert.equal(hold.dir, 'in');
  assert.equal(hold.amount_msat, 3_000_000_000); assert.equal(hold.asset, fx.silv); assert.ok(hold.at > 0);
  assert.equal(by.get(H.plainin).amount_msat, 1_500_000_000);
  for (const h of [H.neg_hold_unpaid, H.neg_hold_unsettled, H.neg_failed_out]) assert.ok(!by.has(h));
});

test('no preimage, label or bolt11 in an item', () => {
  for (const n of ['l1_gold_user', 'l3_silv_user'])
    for (const i of fromNode(n, null)) for (const k of Object.keys(i)) assert.ok(!/preimage|label|bolt11|secret/.test(k), k);
});

test('a settled hold without bookkeeper: the amount from listhtlcs, the time unknown (0)', () => {
  const items = fromNode('l3_silv_user', fx.silv, { events: { events: [] } });
  const hold = items.find((i) => i.payment_hash === H.subbuy);
  assert.equal(hold.amount_msat, 3_000_000_000);
  assert.equal(hold.at, 0);
});

test('a settled hold seen by nothing else: the registered amount', () => {
  const h = 'ab'.repeat(32);
  const items = nodeHistoryItems({ holds: { datastore: [{ key: [HOLD_STORE, h], string: JSON.stringify({ state: 'settled', amount_msat: 4000, asset: 'cd'.repeat(32) }) }] } });
  assert.deepEqual(key(items), [[h, 'in', 'hold', 4000]]);
});

test('older answers: "1000msat" amounts and a datastore entry in hex only', () => {
  const h = 'ef'.repeat(32);
  const hex = Buffer.from(JSON.stringify({ state: 'settled', amount_msat: 9000 })).toString('hex');
  const items = nodeHistoryItems({ invoices: { invoices: [{ status: 'paid', payment_hash: '12'.repeat(32), amount_received_msat: '2000msat', paid_at: 5 }] },
    holds: { datastore: [{ key: [HOLD_STORE, h], hex }] }, asset: 'btc' });
  assert.deepEqual(key(items).sort(), [['12'.repeat(32), 'in', 'invoice', 2000], [h, 'in', 'hold', 9000]].sort());
  assert.ok(items.every((i) => i.asset === 'btc'));
});

test('a paid invoice and a settled hold under one hash are one movement, not two', () => {
  const h = '34'.repeat(32);
  const items = nodeHistoryItems({ invoices: { invoices: [{ status: 'paid', payment_hash: h, amount_received_msat: 5000, paid_at: 7 }] },
    holds: { datastore: [{ key: [HOLD_STORE, h], string: JSON.stringify({ state: 'settled', amount_msat: 5000 }) }] } });
  assert.equal(items.length, 1);
});

test('a pay sent with fees: amount delivered, fee apart', () => {
  const h = '56'.repeat(32);
  const [it] = nodeHistoryItems({ pays: { pays: [{ status: 'complete', payment_hash: h, amount_msat: 1000, amount_sent_msat: 1010, completed_at: 3 }] } });
  assert.equal(it.amount_msat, 1000); assert.equal(it.fee_msat, 10);
});

test('the swap note rides on its hash; a malformed note is dropped', () => {
  const note = { pay: { asset: 'btc', atoms: '1500', rail: 'chain' }, recv: { asset: fx.silv, atoms: '30000000' }, title: 'Bought\nSILV' };
  const notes = { datastore: [
    { key: [NOTE_STORE, H.subbuy], string: JSON.stringify(note) },
    { key: [NOTE_STORE, H.plainin], string: JSON.stringify({ pay: { asset: 'nope', atoms: '1' }, recv: note.recv }) },
  ] };
  const items = fromNode('l3_silv_user', fx.silv, { notes });
  const by = new Map(items.map((i) => [i.payment_hash, i]));
  assert.deepEqual(by.get(H.subbuy).note, { pay: { asset: 'btc', atoms: '1500', rail: 'chain' }, recv: { asset: fx.silv, atoms: '30000000', rail: 'ln' }, title: 'Bought SILV', at: 0 });
  assert.equal(by.get(H.plainin).note, null);
  assert.equal(by.get(H.pureln).note, null);
});

test('cleanNote refuses what is not a two-legged swap', () => {
  assert.equal(cleanNote(null), null);
  assert.equal(cleanNote({ pay: { asset: 'btc', atoms: '1' } }), null);
  assert.equal(cleanNote({ pay: { asset: 'btc', atoms: '-1' }, recv: { asset: 'btc', atoms: '1' } }), null);
  assert.equal(cleanNote({ pay: { asset: 'btc', atoms: '1' }, recv: { asset: 'btc', atoms: '1' }, title: 'x'.repeat(500) }).title.length, 120);
});

test('readNodeHistory: a record the node cannot give is named, the rest still read', async () => {
  const d = fx.nodes.l3_silv_user;
  const call = async (m, kv) => {
    if (m === 'bkpr-listaccountevents') throw new Error('Unknown command');
    if (m === 'listdatastore') return kv[0].includes(NOTE_STORE) ? { datastore: [] } : d.listdatastore;
    return { listinvoices: d.listinvoices, listpays: d.listpays, listhtlcs: d.listhtlcs }[m];
  };
  const r = await readNodeHistory(call, { asset: fx.silv });
  assert.deepEqual(r.unread, ['bkpr-listaccountevents']);
  assert.equal(r.items.length, 3);
  assert.ok(r.items.some((i) => i.kind === 'hold' && i.amount_msat === 3_000_000_000));
});
