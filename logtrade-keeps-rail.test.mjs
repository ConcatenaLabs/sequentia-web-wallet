// logTrade: an upgrade (a buy refunded, a buy settled) replaces the row's title and status and keeps
// what it does not restate (the rail, the payment hash, both legs), so the History's Lightning card
// still finds a refunded buy; the in-flight buy row carries its rail from the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.document = { body: { appendChild() {} }, activeElement: null, querySelector: () => null, getElementById: () => null };
const swap = await import('./swap.js');

const H = 'de'.repeat(32), GOLD = 'ab'.repeat(32);
const row = () => swap.lnTradeHistory().find((t) => t.id === 'buy:' + H);

test('the in-flight buy row is a Lightning trade with its hash and legs', () => {
  swap.logTrade({ id: 'buy:' + H, title: 'Buying GOLD with BTC', status: 'BTC locked', rail: 'sub-asset', payment_hash: H,
    pay: { asset: 'btc', atoms: '1500', rail: 'chain' }, recv: { asset: GOLD, atoms: '1000', rail: 'ln' } });
  const r = row();
  assert.ok(r, 'listed among the Lightning trades');
  assert.equal(r.rail, 'sub-asset');
  assert.equal(r.payment_hash, H);
  assert.deepEqual(r.pay, { asset: 'btc', atoms: '1500', rail: 'chain' });
});

test('a refund upgrade keeps the rail, the hash and the legs', () => {
  swap.logTrade({ id: 'buy:' + H, title: 'Buy refunded (GOLD)', status: 'BTC refunded', txid: 'f'.repeat(64), upgrade: true });
  const r = row();
  assert.equal(r.title, 'Buy refunded (GOLD)');
  assert.equal(r.status, 'BTC refunded');
  assert.equal(r.rail, 'sub-asset');
  assert.equal(r.payment_hash, H);
  assert.deepEqual(r.recv, { asset: GOLD, atoms: '1000', rail: 'ln' });
  assert.equal(swap.lnTradeHistory().filter((t) => t.id === 'buy:' + H).length, 1);
});

test('an upgrade that restates a field replaces it', () => {
  swap.logTrade({ id: 'buy:' + H, title: 'Bought GOLD with BTC', status: 'asset received', upgrade: true,
    recv: { asset: GOLD, atoms: '999', rail: 'ln' } });
  assert.deepEqual(row().recv, { asset: GOLD, atoms: '999', rail: 'ln' });
  assert.equal(row().rail, 'sub-asset');
});

test('a pure-Lightning take answered without a hash is logged under the hash of its preimage', async () => {
  const { sha256 } = await import('./btc.js');
  const P = '0f'.repeat(32);
  const want = Array.from(sha256(Uint8Array.from(Buffer.from(P, 'hex'))), (b) => b.toString(16).padStart(2, '0')).join('');
  swap.logTrade({ id: 'ln:' + P, title: 'Sold tSEQ for USDX over Lightning', status: 'settled', rail: 'ln', preimage: P });
  assert.equal(swap.lnTradeHistory().find((t) => t.id === 'ln:' + P).payment_hash, want);
});
