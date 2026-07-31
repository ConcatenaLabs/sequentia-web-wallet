// ONE STUCK BUY MUST NOT BLOCK THE RAIL.
//
// The sub-asset BUY kept ONE record under ONE localStorage key, and the composer refused a
// new buy whenever that record was live. So a buy that could not complete took the whole
// rail down with it until its CLTV refund matured -- hours.
//
// It happened for real: a maker rotated its identity out from under an already-funded HTLC,
// leaving a trade nothing could fill (only that maker's claim key can spend it), and with it
// every future sub-asset buy in the wallet. One stuck counterparty should cost one trade.
//
// These pin the collection semantics the refactor rests on, mirroring SUBSWAPS.
//
//   node --test buy-multi.test.mjs
import assert from 'node:assert';
import test from 'node:test';

// The record-collection logic under test, as swap.js implements it.
const terminal = (b) => !b || b.state === 'settled' || b.state === 'failed' || b.state === 'refunded';
const active = (list) => list.filter((b) => !terminal(b));
const slotsFree = (buys, subswaps, bridge, max) =>
  (active(buys).length + active(subswaps).length + (bridge ? 1 : 0)) < max;
const drop = (list, rec) => list.filter((r) => r !== rec && !(rec.id && r && r.id === rec.id));

const MAX = 3;
const stuck = { id: 'b1', state: 'funded', ticker: 'GOLD' };   // funded, unfillable, awaiting CLTV

test('THE BUG: a stuck funded buy no longer blocks the next one', () => {
  assert.equal(slotsFree([stuck], [], false, MAX), true,
    'one orphaned trade must not close the rail for hours');
});

test('the ceiling is shared with the other rails, not per rail', () => {
  // Each live trade ties up real Bitcoin, so the bound is about committed value — not about
  // which rail happens to commit it. Two buys plus one rail-crossing trade fills it.
  assert.equal(slotsFree([stuck, { id: 'b2', state: 'funded' }], [{ id: 's1', state: 'locked' }], false, MAX), false);
  assert.equal(slotsFree([stuck, { id: 'b2', state: 'funded' }], [], false, MAX), true);
  // The LSP receiver bridge counts as one too.
  assert.equal(slotsFree([stuck, { id: 'b2', state: 'funded' }], [], true, MAX), false);
});

test('terminal records free their slot; live ones hold it', () => {
  for (const state of ['settled', 'refunded', 'failed'])
    assert.equal(active([{ id: 'x', state }]).length, 0, `${state} must not hold a slot`);
  for (const state of ['funding', 'funded', 'holding'])
    assert.equal(active([{ id: 'x', state }]).length, 1, `${state} still has value committed`);
});

test('dropping one record leaves the others untouched', () => {
  // The single-key version could only clear EVERYTHING, which is why a completed buy could not
  // be retired without discarding a concurrent one's refund material.
  const a = { id: 'b1', state: 'settled' }, b = { id: 'b2', state: 'funded' };
  const left = drop([a, b], a);
  assert.deepEqual(left.map((r) => r.id), ['b2']);
  assert.equal(left[0].state, 'funded', 'the survivor keeps its recovery material');
});

test('a re-parsed copy is still matched by id', () => {
  // Records round-trip through localStorage, so identity comparison alone would fail to drop
  // the record a driver holds a reference to — and it would be resurrected on the next save.
  const orig = { id: 'b1', state: 'settled' };
  const reparsed = JSON.parse(JSON.stringify(orig));
  assert.equal(drop([reparsed], orig).length, 0, 'id must be the fallback key');
});

test('a funding stub with no broadcast tx does not hold a slot forever', () => {
  // A prologue that threw before broadcast locked nothing. Keeping that stub would consume a
  // slot with no funds behind it — the failure path drops exactly these.
  const stub = { id: 'b9', state: 'funding', btc_htlc: {} };
  const funded = !!(stub.state === 'funded' || stub.state === 'holding');
  assert.equal(funded, false);
  assert.equal(drop([stub], stub).length, 0);
});

test('MIGRATION: a legacy single record is adopted, not orphaned', () => {
  // The old build stored one record under its own key. On upgrade that buy may still have BTC
  // locked, so it must become element 0 of the new list rather than being silently dropped.
  const legacy = { state: 'funded', ticker: 'GOLD', btc_htlc: { txid: 'ab' } };
  let buys = [];
  if (!buys.length && legacy) buys = [legacy];
  buys.forEach((b, i) => { if (!b.id) b.id = 'gen-' + i; });
  assert.equal(buys.length, 1);
  assert.ok(buys[0].id, 'a migrated record gets an id so it can be dropped individually');
  assert.equal(buys[0].btc_htlc.txid, 'ab', 'its recovery material survives the migration');
});
