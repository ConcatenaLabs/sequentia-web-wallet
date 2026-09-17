// A PHASE WITH NO WORDS LEAVES THE PREVIOUS LINE LYING ON THE SCREEN.
//
// The Move-to-Lightning progress line is driven by the LSP's job status. Both callers used to
// hold their own copy of the phase->text map and to speak ONLY when the map had an entry:
//
//     onProgress: (e) => { if (phaseCopy[e.phase]) say(phaseCopy[e.phase]); }
//
// Neither copy covered `syncing` or `connecting`, which runChannelOpen reports between the
// deposit and the channel. So a job parked in `syncing` — the node is up but not answering,
// typically because it is waiting on this device's signer — left the previous line untouched:
// the wallet went on saying "Waiting for the deposit to confirm on-chain..." for the full hour
// of the server's watch. On the testnet that line sat there while the deposit had confirmed in
// the very next block and the thing that actually needed the user was their own wallet.
//
// So these pin the two properties that keep that from recurring:
//   1. EVERY phase the server or the client can emit has words. Read out of lsp-server.mjs and
//      seqln.js, so adding a phase on either side without copy FAILS HERE rather than shipping
//      a frozen line.
//   2. An unrecognised phase still moves the line. Vague beats stale.
//
//   node --test move-phase-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The shipped implementation, not a mirror of it: a copy in here could drift exactly the way
// the two phaseCopy maps did.
function loadPhaseCopy() {
  const html = read('./index.html');
  const a = html.indexOf('const LN_MOVE_PHASE = {');
  const b = html.indexOf('const _lnReconnectedLegs', a);
  assert.ok(a > 0 && b > a, 'LN_MOVE_PHASE / lnMovePhaseCopy not found in index.html');
  return new Function(html.slice(a, b) + '\nreturn { LN_MOVE_PHASE, lnMovePhaseCopy };')();
}

// Every phase runChannelOpen can report, plus the status a fresh job starts at.
function serverPhases() {
  const src = read('./tooling/lsp/lsp-server.mjs');
  const a = src.indexOf('async function runChannelOpen(job)');
  const b = src.indexOf('function startChannelOpen(body)', a);
  assert.ok(a > 0 && b > a, 'runChannelOpen not found in lsp-server.mjs');
  const worker = src.slice(a, b);
  const out = new Set();
  for (const m of worker.matchAll(/job\.status\s*=\s*'([a-z_]+)'/g)) out.add(m[1]);
  // startChannelOpen seeds the job (and its reply to the wallet) with this one.
  const seed = src.slice(b).match(/status:\s*'([a-z_]+)'/);
  if (seed) out.add(seed[1]);
  return out;
}

// Every phase the wallet's own fundChannel emits, over and above the job statuses it echoes.
function clientPhases() {
  const src = read('./seqln.js');
  const a = src.indexOf('export async function fundChannel(');
  const b = src.indexOf('export async function resumeFundChannel(', a);
  assert.ok(a > 0 && b > a, 'fundChannel not found in seqln.js');
  const out = new Set();
  for (const m of src.slice(a, b).matchAll(/emit\('([a-z-]+)'/g)) out.add(m[1]);
  return out;
}

// `failed` is deliberately silent: fundChannel reports it and then throws, and the thrown error
// carries the real reason — generic copy here would replace it for the instant before the catch.
const SILENT = new Set(['failed']);

test('every phase the server can report has words', () => {
  const { lnMovePhaseCopy } = loadPhaseCopy();
  const phases = [...serverPhases()];
  assert.ok(phases.length >= 6, `expected to find the worker's phases, got ${phases.join()}`);
  for (const p of phases) {
    if (SILENT.has(p)) continue;
    const copy = lnMovePhaseCopy(p);
    assert.ok(typeof copy === 'string' && copy.length > 10,
      `phase '${p}' has no copy — the progress line would keep showing the previous phase`);
  }
});

test('every phase the wallet emits has words', () => {
  const { lnMovePhaseCopy } = loadPhaseCopy();
  for (const p of clientPhases()) {
    if (SILENT.has(p)) continue;
    const copy = lnMovePhaseCopy(p);
    assert.ok(typeof copy === 'string' && copy.length > 10, `phase '${p}' has no copy`);
  }
});

test("the syncing line points at the wallet, not at the chain", () => {
  const { lnMovePhaseCopy } = loadPhaseCopy();
  const copy = lnMovePhaseCopy('syncing');
  // The whole point: this is the phase that used to masquerade as "waiting for the chain".
  assert.match(copy, /wallet open/i);
  assert.doesNotMatch(copy, /confirm on-chain/i);
});

test('an unrecognised phase still moves the line', () => {
  const { lnMovePhaseCopy } = loadPhaseCopy();
  const copy = lnMovePhaseCopy('some_future_phase');
  assert.ok(typeof copy === 'string' && copy.includes('some_future_phase'),
    'an unknown phase must say something rather than leave the last line in place');
});

test('nothing to say leaves the line alone', () => {
  const { lnMovePhaseCopy } = loadPhaseCopy();
  for (const v of ['', null, undefined, 'failed']) assert.equal(lnMovePhaseCopy(v), null);
});
