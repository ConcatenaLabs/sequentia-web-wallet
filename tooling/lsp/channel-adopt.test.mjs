// A Move to Lightning adopts a channel only while it is opening and the node holds no new
// deposit; a second move to a node whose channel is open funds a new channel (issue #329).
import { test } from 'node:test';
import assert from 'node:assert';
import { adoptableChannel } from './channel-adopt.mjs';

const ch = (state, txid, opener = 'local') => ({ state, funding_txid: txid, opener });

test('a second move to a node whose channel is open funds a new one', () => {
  assert.equal(adoptableChannel([ch('CHANNELD_NORMAL', 'aa')]), null);
  assert.equal(adoptableChannel([ch('CHANNELD_NORMAL', 'aa')], { depositWaiting: true }), null);
  assert.equal(adoptableChannel([ch('CHANNELD_NORMAL', 'aa'), ch('ONCHAIN', 'bb')]), null);
});

test('a retry while the first funding locks in adopts that channel', () => {
  const c = ch('CHANNELD_AWAITING_LOCKIN', 'bb');
  assert.equal(adoptableChannel([ch('CHANNELD_NORMAL', 'aa'), c]), c);
  assert.equal(adoptableChannel([ch('OPENINGD', 'cc')]).funding_txid, 'cc');
  assert.equal(adoptableChannel([ch('DUALOPEND_AWAITING_LOCKIN', 'dd')]).funding_txid, 'dd');
});

test('a new deposit sent while the first channel locks in funds a second channel', () => {
  assert.equal(adoptableChannel([ch('CHANNELD_AWAITING_LOCKIN', 'bb')], { depositWaiting: true }), null);
});

test('a channel the service opened toward the node holds none of the user\'s coins', () => {
  assert.equal(adoptableChannel([ch('CHANNELD_AWAITING_LOCKIN', 'ee', 'remote')]), null);
});

test('no channels, or none answered', () => {
  assert.equal(adoptableChannel([]), null);
  assert.equal(adoptableChannel(undefined), null);
});
