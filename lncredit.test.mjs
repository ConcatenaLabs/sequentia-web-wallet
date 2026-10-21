// Credit notes a hosted node's provider signed while the device was away: the wallet keeps the
// latest of each channel, never drops one, and says in plain words what it owes.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeCreditStore, supersedes, creditLines, CREDIT_KEY } from './lncredit.js';

const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1';
const LABEL = 'seq:' + GOLD + ':02' + 'ab'.repeat(32);
const OTHER = 'seq:' + GOLD + ':03' + 'cd'.repeat(32);
const note = (credit, h, preimage = null, channelId = '11'.repeat(32)) => ({
  peerId: '03' + 'cd'.repeat(32), dbid: 4, channelId, fundingTxid: 'aa'.repeat(32), fundingOutnum: 0,
  credit, paymentHash: h.repeat(32), signature: '5e'.repeat(64), preimage,
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('the latest note of each channel is kept, a superseded one never replaces it', () => {
  const st = memStorage();
  const s = makeCreditStore(st);
  assert.equal(s.record(LABEL, [note(20000000, '01', '0a'.repeat(32))]), true);
  assert.equal(s.record(LABEL, [note(45000000, '02')]), true);
  assert.equal(s.notes()[LABEL][0].credit, '45000000');
  assert.equal(s.notes()[LABEL][0].preimage, null);
  // The same note with its preimage now known.
  assert.equal(s.record(LABEL, [note(45000000, '02', '0b'.repeat(32))]), true);
  assert.equal(s.notes()[LABEL][0].preimage, '0b'.repeat(32));
  // A superseded note, or the same one again, changes nothing.
  assert.equal(s.record(LABEL, [note(20000000, '01', '0a'.repeat(32))]), false);
  assert.equal(s.record(LABEL, [note(45000000, '02', '0b'.repeat(32))]), false);
  // A note of the same credit for another payment does not replace the one held.
  assert.equal(s.record(LABEL, [note(45000000, '03', '0c'.repeat(32))]), false);
  assert.equal(s.notes()[LABEL][0].paymentHash, '02'.repeat(32));
  // The device forgetting the channel (an empty report) drops nothing.
  assert.equal(s.record(LABEL, []), false);
  assert.equal(s.notes()[LABEL].length, 1);
  // Kept across a reload, per node and per channel.
  assert.equal(s.record(OTHER, [note(5, '04', null, '22'.repeat(32))]), true);
  const t = makeCreditStore(st);
  assert.deepEqual(Object.keys(t.notes()).sort(), [LABEL, OTHER].sort());
  assert.ok(JSON.parse(st.m.get(CREDIT_KEY))[LABEL]['11'.repeat(32)].signature);
});

test('a malformed note or store is ignored', () => {
  const st = memStorage();
  st.setItem(CREDIT_KEY, '{not json');
  const s = makeCreditStore(st);
  assert.deepEqual(s.notes(), {});
  assert.equal(s.record(LABEL, [null, { credit: 5 }, { channelId: 'ab', credit: 'x' }]), false);
  assert.equal(s.record(LABEL, [note('18446744073709551615', '05')]), true);
  assert.equal(s.notes()[LABEL][0].credit, '18446744073709551615');
});

test('supersedes compares credit as an integer', () => {
  assert.equal(supersedes(note(10, '01'), note(9, '01')), true);
  assert.equal(supersedes(note('100', '01'), note(99, '01')), true);
  assert.equal(supersedes(note(9, '01'), note(10, '01')), false);
  assert.equal(supersedes(note(10, '01'), undefined), true);
});

test('the wallet says what is owed in plain words', () => {
  const fmt = (a) => (Number(a) / 1e8).toFixed(2);
  const lines = creditLines({ notes: [note(45000000, '02', '0b'.repeat(32))], ticker: 'GOLD', amountText: fmt });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /owes you 0\.45 GOLD, paid to you while your device was away/);
  assert.match(lines[0], /closing the channel pays it to you, and it cannot take it back/);
  const pending = creditLines({ notes: [note(45000000, '02')], ticker: 'GOLD', amountText: fmt });
  assert.match(pending[0], /becomes yours once the payment it was made for is complete/);
  assert.equal(creditLines({ notes: [], ticker: 'GOLD' }), null);
  assert.equal(creditLines({ notes: [note(0, '02')], ticker: 'GOLD' }), null);
  // No protocol words in the default copy.
  assert.doesNotMatch(lines[0] + pending[0], /note|CLAIM|preimage|commitment|leaf/i);
});
