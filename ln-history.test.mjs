// ln-history.js: one row per payment hash, both legs of a swap in it, the trade log only naming a row
// the nodes give. The node items come from the records of real SeqLN nodes (tooling/lsp/testdata/
// node-history-regtest.json) read by the LSP's own reader, so the two modules are held together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeHistoryItems } from './tooling/lsp/node-history.mjs';
import { lnHistoryRows, tradeHash, swapLine, railLine, plainLine } from './ln-history.js';
import { sha256 } from './btc.js';

const fx = JSON.parse(readFileSync(new URL('./tooling/lsp/testdata/node-history-regtest.json', import.meta.url)));
const H = fx.hashes;
const nodeOf = (n, asset, notes) => {
  const d = fx.nodes[n];
  return { asset, items: nodeHistoryItems({ invoices: d.listinvoices, pays: d.listpays, holds: d.listdatastore,
    htlcs: d.listhtlcs, events: d['bkpr-listaccountevents'], notes, asset }) };
};
const gold = nodeOf('l1_gold_user', fx.gold), silv = nodeOf('l3_silv_user', fx.silv);
const T = { [fx.gold]: 'GOLD', [fx.silv]: 'SILV', btc: 'BTC' };
const fmt = (l) => String(Number(l.atoms) / 1e8) + ' ' + T[l.asset];
const rowOf = (rows, h) => { const r = rows.filter((x) => x.hash === h); assert.equal(r.length, 1, 'one row for ' + h.slice(0, 8)); return r[0]; };

test('a pure-Lightning swap on the two nodes is ONE row with both amounts, without any log', () => {
  const rows = lnHistoryRows({ nodes: [gold, silv], trades: [] });
  const r = rowOf(rows, H.pureln);
  assert.equal(r.kind, 'swap');
  assert.equal(swapLine(r, fmt, true), 'Swapped 0.05 GOLD for 0.07 SILV over Lightning');
  assert.equal(swapLine(r, fmt), 'Swapped 0.05 GOLD for 0.07 SILV', 'default mode names no rail');
  assert.equal(railLine(r, (a) => T[a]), '');
  assert.ok(r.at > 0 && !r.logOnly);
});

test('every hash once: 3 node movements on each node, the pure-LN hash shared, 5 rows', () => {
  const rows = lnHistoryRows({ nodes: [gold, silv], trades: [] });
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((r) => r.hash)).size, 5);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['in', 'in', 'out', 'out', 'swap']);
});

test('the log trade of a swap the nodes show adds its title and is not listed again', () => {
  const trade = { id: 'ln:' + H.pureln, title: 'Sold GOLD for SILV over Lightning', status: 'settled', rail: 'ln', at: 1 };
  const rows = lnHistoryRows({ nodes: [gold, silv], trades: [trade] });
  assert.equal(rows.length, 5);
  assert.equal(rowOf(rows, H.pureln).title, 'Sold GOLD for SILV over Lightning');
});

test('a sub-asset buy: the hold receipt and the note on the node make the swap row on any device', () => {
  const note = { pay: { asset: 'btc', atoms: '12345', rail: 'chain' }, recv: { asset: fx.silv, atoms: '3000000', rail: 'ln' }, title: 'Bought SILV with BTC' };
  const withNote = nodeOf('l3_silv_user', fx.silv, { datastore: [{ key: ['seqwallet-swap', H.subbuy], string: JSON.stringify(note) }] });
  const r = rowOf(lnHistoryRows({ nodes: [gold, withNote], trades: [] }), H.subbuy);
  assert.equal(r.kind, 'swap');
  assert.equal(r.title, 'Bought SILV with BTC');
  assert.deepEqual(r.legs.map((l) => [l.dir, l.asset, String(l.atoms), l.rail, l.from]),
    [['out', 'btc', '12345', 'chain', 'note'], ['in', fx.silv, '3000000', 'ln', 'node']]);
  assert.equal(swapLine(r, fmt), 'Swapped 0.00012345 BTC for 0.03 SILV');
  assert.equal(railLine(r, (a) => T[a]), 'BTC on-chain · SILV over Lightning');
});

test('the received amount is the node\'s, even when the note or the log says another', () => {
  const trade = { id: 'buy:' + H.subbuy, title: 'Bought SILV with BTC', rail: 'sub-asset', pay: { asset: 'btc', atoms: '500', rail: 'chain' }, recv: { asset: fx.silv, atoms: '1', rail: 'ln' } };
  const r = rowOf(lnHistoryRows({ nodes: [silv], trades: [trade] }), H.subbuy);
  assert.equal(String(r.legs.find((l) => l.dir === 'in').atoms), '3000000');
  assert.equal(String(r.legs.find((l) => l.dir === 'out').atoms), '500');
  assert.equal(r.legs.find((l) => l.dir === 'out').from, 'log');
});

test('a sell: the bare-hash pay leg and the log\'s on-chain claim are one row', () => {
  const trade = { id: 'sell:' + H.subsell, title: 'Sold GOLD for BTC', rail: 'sub-asset', status: 'BTC claimed',
    pay: { asset: fx.gold, atoms: '2000000', rail: 'ln' }, recv: { asset: 'btc', atoms: '777', rail: 'chain' } };
  const rows = lnHistoryRows({ nodes: [gold, silv], trades: [trade] });
  const r = rowOf(rows, H.subsell);
  assert.equal(swapLine(r, fmt), 'Swapped 0.02 GOLD for 0.00000777 BTC');
  assert.equal(rows.length, 5);
});

test('a leg with no partner, note or trade is one plain row', () => {
  const rows = lnHistoryRows({ nodes: [silv], trades: [] });
  const r = rowOf(rows, H.pureln);
  assert.equal(r.kind, 'in');
  assert.equal(r.legs.length, 1);
  assert.equal(r.title, 'pureln swap');
  assert.equal(rowOf(rows, H.subbuy).kind, 'in');
});

test('a trade no node has settled is shown from the log alone, once', () => {
  const h = 'aa'.repeat(32);
  const trades = [{ id: 'buy:' + h, title: 'Buying GOLD with BTC', status: 'BTC locked', rail: 'sub-asset', at: Date.now() },
    { id: 'buy:' + h, title: 'dup', rail: 'sub-asset', at: 1 }];
  const rows = lnHistoryRows({ nodes: [gold], trades });
  const r = rowOf(rows, h);
  assert.ok(r.logOnly);
  assert.equal(r.status, 'BTC locked');
  assert.equal(rows[0].hash, h, 'newest first');
});

test('the same node asked twice is one leg, not a swap with itself', () => {
  const rows = lnHistoryRows({ nodes: [gold, gold], trades: [] });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.kind === 'out' && r.legs.length === 1));
});

test('tradeHash: recorded, in the id, or from the preimage', () => {
  const h = 'bb'.repeat(32);
  assert.equal(tradeHash({ payment_hash: h.toUpperCase() }), h);
  assert.equal(tradeHash({ id: 'bridge:' + h }), h);
  const p = 'cc'.repeat(32);
  const ph = Array.from(sha256(Uint8Array.from(Buffer.from(p, 'hex'))), (b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(tradeHash({ id: 'mx:1', preimage: p }), ph);
  assert.equal(tradeHash({ id: 'ln:' + p, preimage: p }), ph, 'an ln: id holding the preimage is not the hash');
  assert.equal(tradeHash({ id: 'covfill:x' }), null);
});

test('plain rows: the node\'s description, else Received / Sent (developer mode says over Lightning)', () => {
  assert.equal(plainLine({ kind: 'in', title: '' }), 'Received');
  assert.equal(plainLine({ kind: 'out', title: '' }), 'Sent');
  assert.equal(plainLine({ kind: 'out', title: '' }, true), 'Paid over Lightning');
  assert.equal(plainLine({ kind: 'in', title: 'coffee' }), 'coffee');
});
