// A BLACKLIST THAT NEVER FORGETS EMPTIES THE ORDER BOOK.
//
// An offer whose handshake failed with nothing funded is kept out of the plan so a retry does not pick
// it straight back. That was permanent for the session — and almost nothing that lands an offer there
// is permanent. A cross maker serves ONE lift at a time and answers "busy" to everyone else for a few
// seconds; that offer was then struck out for the rest of the session.
//
// With a fleet where every maker is briefly busy in turn, the book emptied itself: a wallet facing 24
// live GOLD offers ended up with nothing it would take and reported "This trade could not be placed
// right now" against a full order book. Each individual refusal was truthful; remembering them forever
// was the bug.
//
//   node --test dead-offers.test.mjs
import assert from 'node:assert';
import test from 'node:test';

const DEAD_TTL_MS = 5 * 60 * 1000;
const DEAD_TTL_TRANSIENT_MS = 45 * 1000;
const transientRefusal = (why) =>
  /\bbusy\b|another lift is in flight|draining|shutting down for a re-quote|try again in a moment/i
    .test(String(why || ''));

// The blacklist, with an injectable clock so expiry is testable without waiting.
function mkDead(now = () => Date.now()) {
  const until = new Map();
  return {
    mark(id, why) { if (id) until.set(id, now() + (transientRefusal(why) ? DEAD_TTL_TRANSIENT_MS : DEAD_TTL_MS)); },
    clear() { until.clear(); },
    has(id) {
      const t = until.get(id);
      if (t == null) return false;
      if (now() >= t) { until.delete(id); return false; }
      return true;
    },
  };
}

test('THE BUG: a maker that was merely busy comes back', () => {
  let t = 1_000_000;
  const dead = mkDead(() => t);
  dead.mark('offer-1', 'peer failed the lift: busy another lift is in flight (whole-HTLC, one at a time)');
  assert.equal(dead.has('offer-1'), true, 'skipped right now, which is correct');
  t += DEAD_TTL_TRANSIENT_MS + 1;
  assert.equal(dead.has('offer-1'), false, 'and takeable again a minute later — the maker freed itself');
});

test('a structural failure is remembered much longer', () => {
  let t = 1_000_000;
  const dead = mkDead(() => t);
  dead.mark('offer-2', 'needs an unknown path, this trade is on lsp-bridge');
  t += DEAD_TTL_TRANSIENT_MS + 1;
  assert.equal(dead.has('offer-2'), true, 'still skipped: it was never a momentary condition');
  t += DEAD_TTL_MS;
  assert.equal(dead.has('offer-2'), false, 'but not immortal — offers re-post under new ids anyway');
});

test('every wording the makers actually use reads as transient', () => {
  // These are the refusals seen on the wire; a new phrasing that slips through only costs a longer
  // skip, which is why the default is the SAFE direction.
  for (const why of [
    'peer failed the lift: busy another lift is in flight (whole-HTLC, one at a time)',
    'refused: draining — this maker is shutting down for a re-quote; retry on another offer',
    'Nothing was spent - try again in a moment.',
  ]) assert.equal(transientRefusal(why), true, why);
});

test('a real mismatch is NOT mistaken for busyness', () => {
  for (const why of [
    'the maker quoted 5 GOLD, not the 8 GOLD we asked to take',
    'bad locktime ordering (T_btc must exceed T_seq)',
    'below_min_fill: take 100 is below this offer\'s min_fill 1000',
    '',
    undefined,
  ]) assert.equal(transientRefusal(why), false, String(why));
});

test('the book does not empty out when every maker takes a turn being busy', () => {
  // The exact shape of the live failure: a fleet of offers, each refusing once while occupied.
  let t = 1_000_000;
  const dead = mkDead(() => t);
  const book = Array.from({ length: 24 }, (_, i) => `offer-${i}`);
  for (const id of book) dead.mark(id, 'busy another lift is in flight');
  assert.equal(book.filter((id) => !dead.has(id)).length, 0, 'momentarily, nothing is takeable');
  t += DEAD_TTL_TRANSIENT_MS + 1;
  assert.equal(book.filter((id) => !dead.has(id)).length, 24, 'and then the whole book is back');
});

test('clear() still wipes it outright', () => {
  const dead = mkDead();
  dead.mark('offer-9', 'busy');
  dead.clear();
  assert.equal(dead.has('offer-9'), false);
});
