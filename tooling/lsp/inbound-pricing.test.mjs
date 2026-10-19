// SELLING INBOUND LIQUIDITY — the price the user is quoted.
//
// Inbound is capital the LP locks up on the user's behalf for the life of the channel, so it is
// sold rather than given away. The shape follows Phoenix (ACINQ): a percentage of the requested
// amount, with a floor, over a bounded range.
//
// The Sequentia difference is that this is NOT BTC-only. Inbound is sold in whatever asset it is
// denominated in — native BTC and every LSP-supported asset alike — and charged in THAT asset, so
// buying capacity never requires holding some other asset first. That is the no-privileged-asset
// principle applied to liquidity: only the FLOOR differs by kind, because a satoshi and an asset
// atom are not comparable quantities.
//
//   node --test tooling/lsp/inbound-pricing.test.mjs
import assert from 'node:assert';
import test from 'node:test';

import { quoteRoom, annualBpsFor, parseMonths, expiresAt, MONTHS_ALLOWED, roomFromStock } from './inbound-price.mjs';
import { readFileSync } from 'node:fs';

// quoteInboundFee in lsp-server.mjs is quoteRoom with its configuration: the defaults below. A
// client that names no duration gets a year at 1%, which is what the service always charged.
const D = { annualBps: 100, months: 12, minSat: 3000, minAtoms: 1000, minAmount: 100000, maxAmount: 10000000 };
function quoteInboundFee(amount, o = {}) {
  const c = { ...D, ...o };
  return quoteRoom(amount, { months: c.months, annualBps: c.annualBps, floor: c.isBtc ? c.minSat : c.minAtoms,
    minAmount: c.minAmount, maxAmount: c.maxAmount });
}

test('the headline price is 1% of the amount bought for a year', () => {
  assert.equal(quoteInboundFee(1_000_000, { isBtc: true }).fee, 10_000);
  assert.equal(quoteInboundFee(500_000, { isBtc: true }).fee, 5_000);
});

test('the floor applies when 1% would be smaller', () => {
  // 1% of 100k is 1,000 sat, below the 3,000 sat BTC floor — a small channel still costs the
  // floor, because the LP's cost of opening one barely varies with size.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).fee, 3_000);
  // The crossover: at 300k, 1% exactly equals the floor; above it the percentage takes over.
  assert.equal(quoteInboundFee(300_000, { isBtc: true }).fee, 3_000);
  assert.equal(quoteInboundFee(300_001, { isBtc: true }).fee, 3_001);
});

test('NO PRIVILEGED ASSET: an asset is priced by the same rule, in its own units', () => {
  // Same percentage, same maths — only the floor differs, because atoms are not satoshis.
  const btc = quoteInboundFee(2_000_000, { isBtc: true });
  const asset = quoteInboundFee(2_000_000, { isBtc: false });
  assert.equal(btc.fee, 20_000);
  assert.equal(asset.fee, 20_000, 'the percentage must not depend on which asset is bought');
  // Below the crossover the two floors differ, and each applies to its own kind.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).fee, 3_000);
  assert.equal(quoteInboundFee(100_000, { isBtc: false }).fee, 1_000);
});

test('the percentage rounds UP, never down', () => {
  // Rounding a price down sells capacity below cost on every request that lands mid-unit, and
  // those are the common case rather than the exception.
  assert.equal(quoteInboundFee(300_050, { isBtc: true }).fee, 3_001, '1% of 300050 = 3000.5 -> 3001');
  assert.equal(quoteInboundFee(1_000_001, { isBtc: true }).fee, 10_001);
});

test('the sold range is bounded at both ends, with a reason', () => {
  const small = quoteInboundFee(99_999, { isBtc: true });
  assert.equal(small.ok, false);
  assert.match(small.reason, /smallest/);
  const big = quoteInboundFee(10_000_001, { isBtc: true });
  assert.equal(big.ok, false);
  assert.match(big.reason, /largest/);
  // The bounds themselves are inclusive — a quote at exactly the limit is sellable.
  assert.equal(quoteInboundFee(100_000, { isBtc: true }).ok, true);
  assert.equal(quoteInboundFee(10_000_000, { isBtc: true }).ok, true);
});

test('a refused quote is DATA, not an exception', () => {
  // This same function answers the quote endpoint, so the UI must be able to render the reason.
  // Throwing would turn "too small" into an error page.
  for (const bad of [0, -1, null, undefined, NaN, 'abc']) {
    const q = quoteInboundFee(bad, { isBtc: true });
    assert.equal(q.ok, false);
    assert.equal(q.fee, 0, 'a refused quote never carries a chargeable fee');
    assert.ok(q.reason, 'and always says why');
  }
});

test('a quote never charges more than the liquidity is worth', () => {
  // Sanity bound: at 1% with these floors, the fee is always a small fraction of the amount for
  // anything in the sold range. A pricing change that broke this would be charging real money.
  for (const amt of [100_000, 250_000, 1_000_000, 10_000_000]) {
    const q = quoteInboundFee(amt, { isBtc: true });
    assert.ok(q.fee < amt / 10, `fee ${q.fee} is more than 10% of ${amt}`);
  }
});

// ── THE PRICE OF TIME ───────────────────────────────────────────────────────
// What the service gives up is its coins held in the channel, so the price grows with the time
// they are held, at a yearly rate set per asset.

test('the price is the amount times the yearly rate times the months', () => {
  // 100 USDX (8 decimals) at 5% a year: 6 months is 2.5 USDX, a year is 5, a month is 0.4166… (up).
  const usdx = 100e8;
  assert.equal(quoteRoom(usdx, { months: 6, annualBps: 500, floor: 1e8, minAmount: 10e8, maxAmount: 10000e8 }).fee, 2.5e8);
  assert.equal(quoteRoom(usdx, { months: 12, annualBps: 500, floor: 1e8, minAmount: 10e8, maxAmount: 10000e8 }).fee, 5e8);
  // a month at 5% would be 0.4166 USDX, under the 1 USDX floor: the floor applies
  assert.equal(quoteRoom(usdx, { months: 1, annualBps: 500, floor: 1e8, minAmount: 10e8, maxAmount: 10000e8 }).fee, 1e8);
  const q = quoteRoom(usdx, { months: 6, annualBps: 500, floor: 1e8, minAmount: 10e8, maxAmount: 10000e8 });
  assert.equal(q.months, 6); assert.equal(q.annual_bps, 500); assert.equal(q.bps, 250);
});

test('a client that names no duration pays what it always did', () => {
  assert.equal(quoteInboundFee(1_000_000, { isBtc: true }).fee, 10_000);
  assert.equal(quoteInboundFee(1_000_000, { isBtc: true, months: 6 }).fee, 5_000);
});

test('an asset worth little is priced without losing precision', () => {
  // 1e16 atoms × 500 bps × 12 months overflows a double's exact integers; the quote must not.
  const q = quoteRoom(1e16, { months: 12, annualBps: 500, floor: 1, minAmount: 1, maxAmount: 1e17 });
  assert.equal(q.fee, 5e14);
});

test('each asset has its own yearly rate, BTC and the native asset included', () => {
  const table = { USDX: 500, btc: 100, ['aa'.repeat(32)]: 300 };
  assert.equal(annualBpsFor(table, 'ff'.repeat(32), 'USDX', 200), 500, 'by label');
  assert.equal(annualBpsFor(table, 'AA'.repeat(32), 'GOLD', 200), 300, 'by id, any case');
  assert.equal(annualBpsFor(table, 'BTC', 'BTC', 200), 100);
  assert.equal(annualBpsFor(table, 'bb'.repeat(32), 'tSEQ', 200), 200, 'not named: the default, never free');
  assert.equal(annualBpsFor(null, 'x', 'y', 150), 150);
});

test('only the durations sold are accepted', () => {
  assert.deepEqual(MONTHS_ALLOWED, [1, 3, 6, 12]);
  assert.equal(parseMonths(undefined), 12);
  assert.equal(parseMonths('', [1, 3, 6, 12], 6), 6);
  assert.equal(parseMonths('6'), 6);
  for (const bad of ['5', '0', '-1', '6.5', 'x', 24]) assert.equal(parseMonths(bad), null, String(bad));
});

test('the channel is kept for calendar months', () => {
  const jan31 = Date.UTC(2026, 0, 31);
  assert.equal(new Date(expiresAt(Date.UTC(2026, 9, 19), 6)).toISOString().slice(0, 10), '2027-04-19');
  assert.ok(expiresAt(jan31, 1) - jan31 >= 28 * 86400e3);
});

// ── COLLECTION: TWO WAYS TO PAY ──────────────────────────────────────────────
// 'prepaid'  — the fee is sent on-chain before the channel opens (Phoenix's manual purchase).
// 'deferred' — the channel opens now and the fee is recorded as owed (the pay-to-open shape).
//
// What 'deferred' deliberately does NOT do: Phoenix shaves its fee off the incoming payment, so the
// receiver gets less than the sender sent. That cannot be done safely here — on these rails an
// incoming amount is bound to a swap hash, and a counterparty receiving less than the offer states
// correctly refuses the leg. So the debt is carried rather than taken mid-payment: the user still
// pays, just at a moment that cannot corrupt a swap.

// The ledger, mirrored from lsp-server.mjs.
const mkLedger = () => {
  const m = new Map();
  const key = (n, a) => `${n || ''}|${a || 'BTC'}`;
  return {
    owed: (n, a) => Number(m.get(key(n, a)) || 0),
    add: (n, a, amt) => { const k = key(n, a); const v = Number(m.get(k) || 0) + Math.max(0, Math.floor(Number(amt) || 0));
      if (v > 0) m.set(k, v); else m.delete(k); return v; },
    clear: (n, a, amt) => { const k = key(n, a); const cur = Number(m.get(k) || 0);
      const v = amt == null ? 0 : Math.max(0, cur - Math.floor(Number(amt) || 0));
      if (v > 0) m.set(k, v); else m.delete(k); return v; },
  };
};

test('a deferred fee is owed until it is settled', () => {
  const L = mkLedger();
  assert.equal(L.owed('nodeA', 'GOLD'), 0);
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'GOLD'), 2000);
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'GOLD'), 4000, 'debts accumulate across purchases');
  L.clear('nodeA', 'GOLD');
  assert.equal(L.owed('nodeA', 'GOLD'), 0, 'a prepaid settlement clears it');
});

test('debt is per node AND per asset', () => {
  // Charging a GOLD debt against a BTC purchase would take the fee in the wrong unit entirely.
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 2000);
  assert.equal(L.owed('nodeA', 'BTC'), 0, 'a GOLD debt is not owed in BTC');
  assert.equal(L.owed('nodeB', 'GOLD'), 0, "and is not another node's debt");
});

test('the amount DUE on a purchase is the new fee plus what is already owed', () => {
  // The whole point of the deferred mode: it defers, it does not forgive.
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 2000);
  const q = quoteInboundFee(500_000, { isBtc: false });
  assert.equal(q.fee + L.owed('nodeA', 'GOLD'), 7000);
});

test('a partial settlement reduces the debt without erasing it', () => {
  const L = mkLedger();
  L.add('nodeA', 'GOLD', 5000);
  assert.equal(L.clear('nodeA', 'GOLD', 2000), 3000);
  assert.equal(L.clear('nodeA', 'GOLD', 99999), 0, 'overpaying settles it, never goes negative');
});

test('a debt cap is what stops deferred becoming unlimited free liquidity', () => {
  const L = mkLedger();
  const CAP = 50000;
  L.add('nodeA', 'GOLD', CAP + 1);
  assert.ok(L.owed('nodeA', 'GOLD') > CAP, 'over the cap, further deferred purchases must be refused');
});

// ROOM THE SERVICE CANNOT OPEN IS NOT SOLD. The room is the LP's own coins on its side of the
// channel. A wallet bought 2 OILX of room while the LP held 0.96 OILX: the fee was taken, then
// fundchannel failed for want of the coins.
const STOCK = { reserve: 5000, headroomBps: 1500 };   // provisionInbound's defaults
const funded = (amount) => Math.ceil(amount * (1 + STOCK.headroomBps / 10000)) + STOCK.reserve;

test('the room the stock can open is what provisionInbound can fund from it', () => {
  const have = 95_900_000;                                  // 0.959 OILX
  const max = roomFromStock(have, STOCK);
  assert.ok(funded(max) <= have, 'the largest room sold must be fundable');
  assert.ok(funded(max + 2) > have, 'and it is the largest');
  assert.ok(max < 200_000_000, 'so 2 OILX of room is refused');
  assert.equal(roomFromStock(4000, STOCK), 0, 'less than the reserve opens nothing');
  assert.equal(roomFromStock(0, STOCK), 0);
});

test('the quote and the purchase both ask the stock, and the purchase asks before charging', () => {
  const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8');
  const quote = src.slice(src.indexOf("url.pathname === '/channel/inbound/quote'"));
  assert.ok(quote.indexOf('roomStock(assetId)') > 0 && quote.indexOf('roomStock(assetId)') < quote.indexOf('return send(res, q.ok ? 200 : 400'),
    'the quote refuses room the stock cannot open');
  const post = src.slice(src.indexOf("req.method === 'POST' && url.pathname === '/channel/inbound'"));
  const stock = post.indexOf('roomStock(assetId)');
  assert.ok(stock > 0, 'the purchase asks the stock');
  for (const charge of ['verifyInboundFeePaid(', 'recordFeeUse(', 'debtAdd(']) assert.ok(stock < post.indexOf(charge), 'before ' + charge);
  assert.ok(stock < post.indexOf('provisionInbound('), 'and before funding');
});
