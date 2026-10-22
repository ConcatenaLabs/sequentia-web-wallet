// Abandon on a buy with BTC (xswap.js). The record of a buy holds the only key that refunds its
// BTC leg, and only one buy with BTC can be in flight, so Abandon decides both whether the BTC
// stays recoverable and whether the next buy can start:
//   - BTC locked, no asset leg: the only action left is the refund at T_btc, so Abandon parks
//     the record (the sweeper refunds it) and frees the slot. It used to refuse with a toast,
//     leaving the trade active and every other buy with BTC blocked until the timelock.
//   - BTC locked and the maker's asset leg on-chain: claiming finishes the trade, so it stays.
//   - nothing locked: the record goes.
//
// Run: node --test xswap-abandon.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.document = { getElementById: () => null };

const { __test__: FWD, initXswap } = await import('./xswap.js');
const { ST } = FWD;

function ctx(){
  const toasts = [], exits = [], err = { textContent: '' };
  const C = {
    $: (id) => (id === 'xswapErr' ? err : null),
    el: () => ({}),
    toast: (m) => toasts.push(m),
    onExit: () => exits.push(1),
  };
  initXswap(C);
  return { toasts, exits, err };
}

function lockedSwap(extra = {}){
  return {
    state: ST.PENDING, courier: true, btc_locktime: 157507,
    btc_leg: { txid: 'aa'.repeat(32), vout: 0, amount: '25000' },
    btc_redeem_script: '63' + '00'.repeat(40), btc_refund_secret: '11'.repeat(32),
    ...extra,
  };
}

test('BTC locked with no asset leg: Abandon parks it and frees the slot', () => {
  store.clear();
  const { toasts, exits } = ctx();
  FWD.setSwap(lockedSwap());
  FWD.onAbandon();
  assert.equal(FWD.getSwap(), null, 'the slot is free');
  const parked = FWD.listParked();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].btc_leg.txid, 'aa'.repeat(32));
  assert.equal(parked[0].btc_redeem_script, '63' + '00'.repeat(40), 'the reclaim material went with it');
  assert.equal(parked[0].btc_refund_secret, '11'.repeat(32));
  assert.match(toasts.at(-1), /Parked\. The BTC refunds itself at block 157507/);
  assert.equal(exits.length, 1, 'back to the composer');
});

test('a failed trade with BTC locked parks the same way', () => {
  store.clear();
  ctx();
  FWD.setSwap(lockedSwap({ state: ST.FAILED }));
  FWD.onAbandon();
  assert.equal(FWD.getSwap(), null);
  assert.equal(FWD.listParked().length, 1);
});

test('the maker\'s asset leg on-chain: Abandon keeps the trade and says why where the button is', () => {
  store.clear();
  const { toasts, exits, err } = ctx();
  FWD.setSwap(lockedSwap({ state: ST.SEQ_LOCKED, seq_leg: { txid: 'bb'.repeat(32), vout: 1 } }));
  FWD.onAbandon();
  assert.ok(FWD.getSwap(), 'the record holding the claim stays');
  assert.equal(FWD.listParked().length, 0, 'a claim is never parked');
  assert.match(err.textContent, /cannot be abandoned: the maker has locked the asset/);
  assert.match(err.textContent, /block 157507/);
  assert.equal(toasts.length, 1);
  assert.equal(exits.length, 0);
});

test('nothing locked: Abandon clears the record', () => {
  store.clear();
  const { exits } = ctx();
  FWD.setSwap({ state: ST.QUOTED, btc_locktime: 0 });
  FWD.onAbandon();
  assert.equal(FWD.getSwap(), null);
  assert.equal(FWD.listParked().length, 0);
  assert.equal(exits.length, 1);
});
