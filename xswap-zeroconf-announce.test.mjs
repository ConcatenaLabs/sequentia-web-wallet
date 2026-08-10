// The 0-conf courier announce (xswap.js): the taker hands the maker its outpoint at broadcast and
// lets the maker's own -min-btc-conf policy decide, instead of gating the announce on a 25-minute
// single-confirmation wait that routinely outlived a slow testnet4 block and killed healthy swaps.
// Two invariants must hold around that change, mirrored here the same way fund-zeroconf.test.mjs
// mirrors the fund() branch (the originals live in closures that need the injected C context):
//
//   1. verifyAnchor NEVER passes while our own BTC lock is unmined (height <= 0). The ordering
//      check is "asset-leg anchor >= our lock's mined height"; with height 0 every anchor >= 0
//      would read an UNCONFIRMED lock as deeply buried and wave the claim through.
//   2. btcLastBlockAgeMin never fabricates an age from testnet4's future-dated miner timestamps:
//      before a tip change has been OBSERVED, a header timestamp outside [0, 180] minutes yields
//      null (clause omitted), not a clamped 0.
//
//   node --test xswap-zeroconf-announce.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirror of verifyAnchor's decision core (xswap.js). Keep byte-for-byte in step with the source.
function verifyAnchorCore(legAnchor, btcLegHeight){
  const a = Number(legAnchor);
  const bh = Number(btcLegHeight);
  if (!(bh > 0)) return { ok: false, unconfirmed: true, why: 'own lock unmined' };
  if (!Number.isFinite(a) || a < 0) return { ok: false, unconfirmed: true, why: 'leg not anchored' };
  if (!(a >= bh)) return { ok: false, unsafe: true, why: 'anchored before lock' };
  return { ok: true };
}

test('an unmined own BTC lock (height 0/null/NaN) can NEVER pass the anchor gate', () => {
  for (const bh of [0, null, undefined, NaN, -1]){
    for (const anchor of [0, 1, 147802, 1e9]){
      const v = verifyAnchorCore(anchor, bh);
      assert.equal(v.ok, false, `anchor=${anchor} bh=${bh} must not pass`);
      // And it must be the WAIT verdict, not the terminal-unsafe one: the height arrives later.
      assert.equal(!!v.unconfirmed, true, `anchor=${anchor} bh=${bh} must wait, not condemn`);
    }
  }
});

test('a mined lock still enforces the ordering exactly as before', () => {
  assert.equal(verifyAnchorCore(147810, 147802).ok, true);
  assert.equal(verifyAnchorCore(147802, 147802).ok, true);             // equality passes (>=)
  assert.equal(verifyAnchorCore(147801, 147802).unsafe, true);         // anchored before lock
  assert.equal(verifyAnchorCore(-1, 147802).unconfirmed, true);        // leg not yet anchored
});

// Mirror of btcLastBlockAgeMin's fallback decision (xswap.js/xrswap.js): given no observed tip
// change yet, only a sane [0, 180]-minute header age may be shown; anything else is null.
function fallbackAgeMin(nowSec, headerTs){
  if (!(headerTs > 0)) return null;
  const min = Math.round((nowSec - headerTs) / 60);
  return (min >= 0 && min <= 180) ? (min || 0) : null;   // || 0 normalises Math.round's -0
}

test('future-dated miner timestamps yield NULL, never a clamped 0', () => {
  const now = 1786386097;
  // Live testnet4 sample from the session: every recent tip header was dated ahead of wall clock.
  for (const ts of [now + 7162, now + 5961, now + 1427, now + 226]){
    assert.equal(fallbackAgeMin(now, ts), null);
  }
  // Sub-minute future skew is measurement noise, not a timewarp: "just now" (0) is the honest
  // answer, and it must be a plain 0, not Math.round's -0.
  assert.ok(Object.is(fallbackAgeMin(now, now + 1), 0));
});

test('sane header ages pass through; stale ones are omitted too', () => {
  const now = 1786386097;
  assert.equal(fallbackAgeMin(now, now - 120), 2);           // 2 min ago
  assert.equal(fallbackAgeMin(now, now - 3600), 60);         // an hour ago
  assert.equal(fallbackAgeMin(now, now - 11000), null);      // ~3h: outside the sane window
  assert.equal(fallbackAgeMin(now, 0), null);                // unreadable
});

test('observed-tip age is measured from the change, and only after one was seen', () => {
  // Mirror of the _tipWatch update rule.
  const w = { height: -1, sinceMs: 0, seenChange: false };
  const observe = (h, nowMs) => {
    if (Number.isFinite(h) && h > 0){
      if (w.height >= 0 && h > w.height){ w.sinceMs = nowMs; w.seenChange = true; }
      else if (w.height < 0){ w.sinceMs = nowMs; }
      if (h > w.height) w.height = h;
    }
    return w.seenChange ? Math.max(0, Math.round((nowMs - w.sinceMs) / 60000)) : null;
  };
  assert.equal(observe(147805, 0), null);                    // baseline read: not an arrival
  assert.equal(observe(147805, 10 * 60000), null);           // no change yet: still nothing to claim
  assert.equal(observe(147806, 12 * 60000), 0);              // the change IS the arrival: 0 min ago
  assert.equal(observe(147806, 42 * 60000), 30);             // and it ages from that moment
});
