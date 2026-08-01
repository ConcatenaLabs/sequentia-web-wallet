// Per-trade sell records (spec §7): a "finish this one before starting another" gate is
// only legitimate for an order holding the SAME funds — and every sub-asset sell holds
// ITS OWN preimage + HTLC. These pin the fix for the live wedge: a stale 'claiming' sell
// blocked every later sell until its CLTV, hours away. Run:
//   node --test sells-concurrent.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__, hasSellInFlight } from './swap.js';

const T = __test__;

function install(){
  initSwap({
    assetMeta: () => ({ ticker: 'GOLD', precision: 8 }),
    balObj: () => ({}), fmtAtoms: (a) => String(a), refValueStr: () => '',
    $: () => null, el: () => null,
  });
  T.setSells([]);
}

test('two sells coexist as independent records', () => {
  install();
  const a = T.addSell({ state: 'claiming', ticker: 'GOLD', preimage: 'aa', btc_htlc: {} });
  const b = T.addSell({ state: 'paying', ticker: 'GOLD', swap_nonce: 'bb' });
  assert.equal(T.activeSells().length, 2);
  assert.notEqual(a.id, b.id, 'each sell gets its own id');
  T.clearSell(a);
  assert.equal(T.activeSells().length, 1, 'clearing one record leaves the other live');
  assert.equal(T.activeSells()[0].swap_nonce, 'bb');
});

test('a stuck (claiming/errored) sell does NOT block the next sell', () => {
  install();
  T.addSell({ state: 'claiming', ticker: 'GOLD', preimage: 'aa', btc_htlc: {}, error: 'transient' });
  // The old single-key gate refused here. Now only the SHARED ceiling bounds it:
  // one active sell leaves slots free (ceiling is 3).
  assert.equal(T.buySlotsFree(), true, 'one stuck sell leaves the shared concurrency ceiling open');
  assert.equal(hasSellInFlight(), true, 'the stuck sell still reads as in flight (copy/diagnostics)');
});

test('terminal sells free their slot; the ceiling counts live sells', () => {
  install();
  T.addSell({ state: 'failed', ticker: 'GOLD' });
  T.addSell({ state: 'done', ticker: 'GOLD' });
  assert.equal(T.activeSells().length, 0, 'failed/done are terminal');
  assert.equal(hasSellInFlight(), false);
  for (let i = 0; i < 99; i++) T.addSell({ state: 'claiming', ticker: 'GOLD' });
  assert.equal(T.buySlotsFree(), true, 'the backstop sits far above any human trading pattern');
  T.addSell({ state: 'claiming', ticker: 'GOLD' });
  assert.equal(T.buySlotsFree(), false, 'the runaway backstop still exists (a trade-spawning bug cannot lock funds without bound)');
});
