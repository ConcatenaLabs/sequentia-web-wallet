// name-stock.js: which addresses the codes a wallet leaves with its payment name use, and the
// property that matters: whatever the payers and the wallet do, a restore from the phrase alone
// finds every payment made to any code the service ever handed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStockIndices, planTopUp, STOCK_SIZE, STOCK_MARGIN_S } from './name-stock.js';
import { RECEIVE_GAP } from './receive-index.js';

test('new codes take addresses inside the window, never one in use, the never-used first', () => {
  assert.deepEqual(pickStockIndices(3, { nextUnused: 0 }), [0, 1, 2]);
  assert.deepEqual(pickStockIndices(3, { nextUnused: 5, held: [5, 7] }), [6, 8, 9]);
  // Handed out before: last, the longest ago first.
  assert.deepEqual(pickStockIndices(3, { nextUnused: 0, held: [], handed: [0, 1, 2, 3], gap: 5 }), [4, 0, 1]);
  // A full window gives fewer, never one past it.
  const all = pickStockIndices(50, { nextUnused: 10, held: [12] });
  assert.equal(all.length, RECEIVE_GAP - 1);
  assert.ok(all.every((i) => i >= 10 && i < 10 + RECEIVE_GAP && i !== 12));
  assert.deepEqual(pickStockIndices(0, { nextUnused: 0 }), []);
});

test('a top-up: what was handed out, what is near its lapse, how many to make', () => {
  const now = 1_000_000;
  const mine = { a: { index: 1, until: now + 3 * 86400 }, b: { index: 2, until: now + 60 }, c: { index: 3, until: null }, d: { index: 4 } };
  const p = planTopUp({ mine, held: ['a', 'b', 'c', 'x'], nowS: now, size: 10 });
  assert.deepEqual(p.served, ['d']);
  assert.deepEqual(p.drop, ['b'], 'its request lapses within the margin');
  assert.deepEqual(p.keep, ['a', 'c']);
  assert.equal(p.make, 10 - 2 - 1, 'a code another copy of the wallet left counts');
  assert.equal(planTopUp({ mine: {}, held: [], nowS: now }).make, STOCK_SIZE);
  assert.ok(STOCK_MARGIN_S >= 3600);
});

// A scan from the phrase alone, as the kit's and the Bitcoin scan run: batches of the gap, on while
// a batch holds a payment. -> the highest index it reads.
function scanReach (paid, gap = RECEIVE_GAP) {
  let start = 0;
  for (;;) {
    let any = false;
    for (let i = start; i < start + gap; i++) if (paid.has(i)) any = true;
    start += gap;
    if (!any) return start - 1;
  }
}

test('after any lookups, payments, top-ups and closed spells, a restore finds every payment', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let handedTotal = 0, reusedTotal = 0, maxSeen = 0;
  for (let run = 0; run < 300; run++) {
    // The chain's truth, and what the wallet has seen of it (only while open).
    const paid = new Set();
    let seenNext = 0;
    // The service: the stock in order, and the last code handed out.
    let stock = [], last = null;
    // The wallet's record.
    const rec = { mine: {}, handed: [] };
    let shown = 0, open = true, ids = 0;
    const everHanded = new Set();
    const topUp = () => {
      const plan = planTopUp({ mine: rec.mine, held: stock.map((c) => c.id), nowS: 0, size: STOCK_SIZE });
      for (const id of plan.served) { rec.handed.push(rec.mine[id].index); delete rec.mine[id]; }
      const held = [...Object.values(rec.mine).map((c) => c.index), shown];
      for (const index of pickStockIndices(plan.make, { nextUnused: seenNext, held, handed: rec.handed })) {
        const id = `c${ids++}`;
        rec.mine[id] = { index, until: null };
        stock.push({ id, index });
      }
    };
    topUp();
    for (let step = 0; step < 400; step++) {
      const r = rnd();
      if (r < 0.05) open = !open;                          // the wallet opens or closes
      else if (r < 0.55) {                                 // a payer looks the name up
        let c = stock.shift();
        if (c) last = c; else { c = last; if (c) reusedTotal++; }
        if (c) {
          everHanded.add(c.index); handedTotal++;
          if (rnd() < 0.4) paid.add(c.index);              // and pays it, now or never
        }
      } else if (r < 0.65) {                               // the wallet's own screen moves on
        shown = Math.max(seenNext, shown + 1); if (shown >= seenNext + RECEIVE_GAP) shown = seenNext;
      } else if (r < 0.7) paid.add(shown);                 // a payment to the full code on screen
      if (open) {
        // An open wallet syncs (sees what was paid) and tops its stock up.
        for (const i of paid) seenNext = Math.max(seenNext, i + 1);
        if (shown < seenNext) shown = seenNext;
        topUp();
      }
      for (const c of stock) maxSeen = Math.max(maxSeen, c.index - seenNext);
    }
    // Every code ever handed out may be paid later, after the wallet is gone: each must be within
    // reach of a scan that knows only the payments made so far, plus that one.
    for (const i of everHanded) assert.ok(i <= scanReach(new Set([...paid, i])), `address ${i} found after a restore (run ${run})`);
    for (const i of paid) assert.ok(i <= scanReach(paid), `payment at ${i} found (run ${run})`);
  }
  assert.ok(maxSeen < RECEIVE_GAP, 'no stocked code ever sat past the window');
  assert.ok(reusedTotal > 0 && handedTotal > 1000, `the runs reach empty stocks (${reusedTotal} reused of ${handedTotal})`);
});
