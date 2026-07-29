// SEQUENTIAL WALK EXECUTION — the ordering and accounting rules.
//
// A walked take fills across several offers, and each rail-crossing leg is an
// interactive HTLC session with its own preimage, refund key and funded leg. The
// legs therefore run ONE AT A TIME. These tests pin the rules that decide how much
// of a user's order actually fills, and what is claimed when it does not all fill.
//
//   node --test walk-exec.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ } from './swap.js';

const { beginWalk, advanceWalk, stopWalk, walkState, setWalkState, walkTerminal, hasWalkInFlight, clearWalk } = __test__;

const ASSET = 'aa'.repeat(32);

function install(){
  initSwap({
    assetMeta: () => ({ ticker: 'USDX', precision: 8 }),
    fmtAtoms: (a) => String(a),
    $: () => null, el: () => null,
    balObj: () => ({}), feeRates: {},
  });
  setWalkState(null);
}

const leg = (atoms, sats, id) => ({ offer: { id, maker: 'm' + id, rail: 'submarine' },
  takeAtoms: BigInt(atoms), takeBtc: BigInt(sats), partial: false });

const plan = (legs, remainder = 0n) => ({
  side: 'sell',
  walk: {
    legs, offersUsed: legs.length,
    filledAtoms: legs.reduce((a, l) => a + l.takeAtoms, 0n),
    filledBtc: legs.reduce((a, l) => a + l.takeBtc, 0n),
    remainderAtoms: remainder, complete: remainder === 0n, partial: remainder > 0n,
  },
});

test('a single-leg take is NOT orchestrated as a walk', () => {
  install();
  const started = beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a')]));
  assert.equal(started, false, 'one offer needs no ordering');
  assert.equal(walkState(), null);
});

test('a multi-leg take begins a walk holding every leg in price order', () => {
  install();
  const started = beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a'), leg(2000, 210, 'b'), leg(3000, 330, 'c')]));
  assert.equal(started, true);
  const w = walkState();
  assert.equal(w.legs.length, 3);
  assert.deepEqual(w.legs.map(l => l.offer_id), ['a', 'b', 'c']);
  assert.equal(w.legIndex, 0, 'starts at the first leg');
  assert.equal(w.filledAtoms, '0', 'nothing is counted as filled before a leg settles');
  assert.equal(hasWalkInFlight(), true);
});

test('each settled leg is accounted, and the walk ends after the last one', () => {
  install();
  beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a'), leg(2000, 210, 'b')]));

  assert.equal(advanceWalk(), true, 'a leg remains after the first settles');
  assert.equal(walkState().filledAtoms, '1000');
  assert.equal(walkState().filledBtc, '100');
  assert.equal(walkState().legIndex, 1);

  assert.equal(advanceWalk(), false, 'no leg remains after the last');
  assert.equal(walkState().filledAtoms, '3000', 'both legs counted');
  assert.equal(walkState().filledBtc, '310');
  assert.equal(walkState().state, 'done');
  assert.equal(walkTerminal(), true);
});

test('a FAILED leg stops the walk — the remainder is never re-routed silently', () => {
  install();
  beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a'), leg(2000, 210, 'b'), leg(3000, 330, 'c')]));
  advanceWalk();                       // leg 'a' settled
  stopWalk('the second leg failed');

  const w = walkState();
  assert.equal(w.state, 'stopped');
  assert.equal(w.filledAtoms, '1000', 'only the leg that actually settled is counted');
  assert.equal(w.legIndex, 1, 'it stops AT the failed leg, it does not skip past it');
  assert.equal(walkTerminal(), true, 'a stopped walk is terminal — it never resumes into the next offer');
  assert.match(w.detail, /failed/);
});

test('the accounting never claims more than the legs that settled', () => {
  install();
  beginWalk({ seqAsset: ASSET }, plan([leg(500, 50, 'a'), leg(700, 77, 'b'), leg(900, 99, 'c')], 4000n));
  advanceWalk(); advanceWalk();        // two of three legs
  const w = walkState();
  assert.equal(w.filledAtoms, '1200');
  assert.ok(BigInt(w.filledAtoms) < BigInt(w.plannedAtoms),
    'a part-filled walk must not report the planned total as filled');
  assert.equal(w.remainderAtoms, '4000', 'what the book could never fill stays stated separately');
});

test('a completed walk is terminal and clearable, so it cannot wedge the guard', () => {
  install();
  beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a'), leg(1000, 105, 'b')]));
  advanceWalk(); advanceWalk();
  assert.equal(hasWalkInFlight(), false, 'a finished walk does not block the next trade');
  clearWalk();
  assert.equal(walkState(), null);
});

test('advancing a terminal walk is inert', () => {
  install();
  beginWalk({ seqAsset: ASSET }, plan([leg(1000, 100, 'a')].concat([leg(1000, 100, 'b')])));
  advanceWalk(); advanceWalk();
  const before = JSON.stringify(walkState());
  assert.equal(advanceWalk(), false);
  assert.equal(JSON.stringify(walkState()), before, 'no double-counting past the end');
});

test('a degenerate plan does not begin a walk', () => {
  install();
  assert.equal(beginWalk({ seqAsset: ASSET }, null), false);
  assert.equal(beginWalk({ seqAsset: ASSET }, {}), false);
  assert.equal(beginWalk({ seqAsset: ASSET }, plan([])), false);
  assert.equal(walkState(), null);
});
