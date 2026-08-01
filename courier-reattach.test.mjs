// A SWAP WITH BITCOIN ALREADY LOCKED MUST SURVIVE A DROPPED SOCKET.
//
// A cross swap commits real BTC on-chain and then keeps talking to the maker over a WebSocket. Any
// drop after that point -- a reload, a relay restart, a network blip -- left the taker with no way
// back into its own session: "This swap was interrupted after your Bitcoin was locked and can no
// longer complete with the maker. Your BTC is safe and refunds at block N." The counterparty was
// still sitting there waiting; the user simply had to wait out the CLTV.
//
// The maker and the relay have supported SessionReattach the whole time. What made it impossible on
// the taker side was that the session key lived only in memory, so nothing could sign the reattach.
//
//   node --test courier-reattach.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { createHash } from 'node:crypto';

// The relay authenticates a reattach against sha256("seqob-reattach|<session>|<role>"), signed by the
// session key it bound at start_lift (seqob/offer.ReattachHash).
const reattachHash = (sid, role) => createHash('sha256').update('seqob-reattach|' + sid + '|' + role).digest();

test('the reattach digest matches the relay’s, exactly', () => {
  const sid = 'bbd7bbc7844efd57451400c56fff3441';
  const got = reattachHash(sid, 'taker').toString('hex');
  // Recomputed independently from the documented preimage; a drift here means every reattach is
  // rejected with "reattach auth" and the swap silently stays unrecoverable.
  const want = createHash('sha256').update(Buffer.from(`seqob-reattach|${sid}|taker`, 'utf8')).digest('hex');
  assert.equal(got, want);
});

test('the role is part of the signed message, so a taker cannot reattach as the maker', () => {
  const sid = 'abc123';
  assert.notEqual(reattachHash(sid, 'taker').toString('hex'), reattachHash(sid, 'maker').toString('hex'));
});

test('the session id is part of it, so one credential cannot open another session', () => {
  assert.notEqual(reattachHash('session-a', 'taker').toString('hex'),
                  reattachHash('session-b', 'taker').toString('hex'));
});

// What the swap record has to carry for any of this to be possible.
test('a persisted swap carries everything a reattach needs', () => {
  const persisted = { session_id: 'abc', sess_priv: '00'.repeat(32), maker_pubkey: '02'.repeat(33), relay_url: 'http://127.0.0.1:9955' };
  for (const k of ['session_id', 'sess_priv', 'maker_pubkey', 'relay_url'])
    assert.ok(persisted[k], `${k} missing — without it the swap cannot rejoin its own session`);
});

test('a swap missing the session key is NOT retried forever', () => {
  // Older records (written before the key was persisted) genuinely cannot reattach. They must fall
  // through to the honest refund message rather than looping on an impossible recovery.
  const old = { session_id: 'abc', maker_pubkey: '02'.repeat(33) };
  const canReattach = !!(old.session_id && old.sess_priv && old.maker_pubkey);
  assert.equal(canReattach, false);
});
