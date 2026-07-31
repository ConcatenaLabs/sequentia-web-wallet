// A WAITER MUST WATCH THE JOB, NOT ONLY THE INVOICE.
//
// The sub-asset BUY (pay BTC on-chain, receive the asset over Lightning) commands the
// LSP with POST /swap, which answers 202 + a job id and drives the maker's pay-by-hash
// in the background. The wallet then waited by polling ONE thing: the hold invoice on
// its own node. So when the job died seconds after that 202, nothing ever noticed —
// the invoice simply never went to `held`, and the wallet printed "Completing your
// trade …" until T_btc, hours later.
//
// Caught live on the first browser-driven on-chain→LN take: the panel span 15+ minutes
// with no console output and no relay session, and only a page RELOAD rescued it,
// because the reload path ran a one-shot job reconcile the wait loop did not have.
//
// The loop now re-reads the job every ~30s. This pins the predicate that decision rests
// on, whose whole job is to be conservative in the right direction.
//
//   node --test buy-job-liveness.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { jobIsDead } from './seqln.js';

test('a failed job is dead, and carries its reason out', () => {
  const v = jobIsDead({ ok: false, status: 'failed', error: 'no maker accepted the take' });
  assert.equal(v.dead, true);
  assert.match(v.reason, /no maker accepted/, 'the reason is what makes a stall explicable');
});

test('an interrupted job is dead — by either spelling', () => {
  // The LSP persists jobs across restarts and marks a job whose in-process driver died
  // 'interrupted' rather than 'failed'. Both mean the maker is no longer being commanded.
  assert.equal(jobIsDead({ status: 'interrupted' }).dead, true);
  assert.equal(jobIsDead({ interrupted: true }).dead, true);
});

test('ok:false alone is dead even without a status', () => {
  assert.equal(jobIsDead({ ok: false }).dead, true);
});

test('a working job is alive and volunteers no reason', () => {
  for (const status of ['pending', 'held', 'running', 'accepted']) {
    const v = jobIsDead({ ok: true, status });
    assert.equal(v.dead, false, `${status} must not be treated as dead`);
    assert.equal(v.reason, '', 'a healthy job has nothing to explain');
  }
});

test('a settled job is NOT dead — the settle path owns that, not the reviver', () => {
  // Re-commanding a maker on a job that already settled would be pure noise. The loop
  // exits on the invoice going settled/held; deadness is only about "no longer driven".
  assert.equal(jobIsDead({ ok: true, status: 'settled' }).dead, false);
});

test('THE ASYMMETRY: an unreadable body reads as ALIVE, never dead', () => {
  // Declaring a live job dead re-commands a maker that is already working. Declaring a
  // dead job alive costs one 30s tick. So anything we cannot actually read must be alive:
  // a null body, a transport blip surfaced as undefined, a status we have never seen.
  for (const body of [null, undefined, '', 0, 'failed', { status: 'something-new' }, {}]) {
    assert.equal(jobIsDead(body).dead, false, `${JSON.stringify(body)} is not evidence of death`);
  }
});

test('the string "failed" as a BODY is not a failed job', () => {
  // Guards against a future caller passing a bare status string: jobIsDead reads bodies,
  // and a string has no .status, so it must not accidentally match on its own text.
  assert.equal(jobIsDead('failed').dead, false);
});
