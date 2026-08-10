// MORE THAN ONE TRADE AT A TIME.
//
// The wallet held rail-crossing trades in a single localStorage slot and a single
// module-level record, so every new take was refused while one was in flight and a
// take that wedged locked the wallet out until it was cleared by hand. Nothing in the
// protocol requires that: each record carries its OWN preimage, refund key, offer and
// leg, so two trades share no state that can collide. The limit was the storage shape.
//
//   node --test multi-trade.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ } from './swap.js';

const { addSubswap, clearSubswap, activeSubswaps, subswapById, tradeSlotsFree,
        subswapTerminal, setSubswapRecord, subswapRecords, MAX_CONCURRENT_TRADES } = __test__;

function install(){
  initSwap({ assetMeta: () => ({ ticker: 'USDX', precision: 8 }), fmtAtoms: (a) => String(a),
    $: () => null, el: () => null, balObj: () => ({}), feeRates: {} });
  setSubswapRecord(null);
  for (const r of subswapRecords().slice()) clearSubswap(r);
}
const rec = (extra = {}) => ({ kind: 'lsp-payer-buy', state: 'starting', asset: 'aa'.repeat(32),
  asset_atoms: '1000', btc_sats: '10', started_ms: Date.now(), ...extra });

test('two trades can be in flight at once', () => {
  install();
  const a = addSubswap(rec()), b = addSubswap(rec());
  assert.equal(activeSubswaps().length, 2, 'a second take must not be refused by the first');
  assert.notEqual(a.id, b.id, 'each trade gets its own identity');
});

test('every record gets a distinct id, so they never alias', () => {
  install();
  const ids = new Set([addSubswap(rec()).id, addSubswap(rec()).id, addSubswap(rec()).id]);
  assert.equal(ids.size, 3);
});

test('the concurrency cap is a deliberate bound, not the storage shape', () => {
  install();
  for (let i = 0; i < MAX_CONCURRENT_TRADES; i++) {
    assert.equal(tradeSlotsFree(), true, `slot ${i} should be free`);
    addSubswap(rec());
  }
  assert.equal(tradeSlotsFree(), false, 'beyond the cap a new take is refused');
});

test('a terminal trade frees its slot', () => {
  install();
  for (let i = 0; i < MAX_CONCURRENT_TRADES; i++) addSubswap(rec());
  assert.equal(tradeSlotsFree(), false);
  activeSubswaps()[0].state = 'settled';
  assert.equal(tradeSlotsFree(), true, 'a settled trade must not keep holding a slot');
});

test('clearing one trade leaves the others untouched', () => {
  install();
  const a = addSubswap(rec()), b = addSubswap(rec()), c = addSubswap(rec());
  clearSubswap(b);
  const left = subswapRecords().map(r => r.id);
  assert.deepEqual(left, [a.id, c.id], 'Clear must drop THAT trade, not whichever was first');
  assert.ok(subswapById(a.id) && subswapById(c.id));
  assert.equal(subswapById(b.id), null);
});

test('a wedged trade no longer locks the wallet out', () => {
  install();
  // This is the reported symptom: one record stuck in 'starting' forever.
  addSubswap(rec({ state: 'starting', started_ms: 0 }));
  assert.equal(tradeSlotsFree(), true, 'a stalled trade must not block the next one');
  addSubswap(rec());
  assert.equal(activeSubswaps().length, 2);
});

test('subswapTerminal reads the record it is given, not a global', () => {
  install();
  const a = addSubswap(rec()), b = addSubswap(rec({ state: 'settled' }));
  assert.equal(subswapTerminal(a), false);
  assert.equal(subswapTerminal(b), true);
  assert.equal(subswapTerminal(null), true, 'no record is trivially terminal');
});

test('clearing without a record is a refusal, never a wipe', () => {
  // The old contract ("no arg = clear everything") is exactly how a funded sibling's recovery
  // material got erased: two resume paths meant "drop THIS dead record" and called it bare. The
  // redeem script of the wiped sibling's on-chain HTLC had no other copy (the maker's claim key
  // is random per session), so the locked asset became permanently unspendable. A falsy record
  // is now a no-op; wiping all trades would take an explicit, deliberate API.
  install();
  addSubswap(rec()); addSubswap(rec());
  clearSubswap(null);
  assert.equal(subswapRecords().length, 2, 'a bare clear must leave every record in place');
});
