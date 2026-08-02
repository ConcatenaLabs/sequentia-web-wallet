// PARTIAL FILLS on the pure-LN rail — the LSP's slice pass-through.
//
// The Go protocol supports asset-side slices end-to-end (xpln -take-asset-msat;
// the maker re-rests the remainder); the LSP was the layer that never passed the
// slice. These tests pin the two pure pieces runSwap now uses:
//   • takeAssetMsatArgs: the POST /swap `take_atoms` (asset atoms) -> the exact
//     xpln argv, msat = atoms*1000 in BigInt (a Number multiply rounds above 2^53).
//     0/absent = the whole offer, argv byte-identical to the classic lift.
//   • partialFields: xpln's "PARTIAL fill: ..." line -> {partial, remaining_atoms}
//     in the response; a whole fill adds nothing.
//
//   node --test tooling/lsp/pureln-partial.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { takeAssetMsatArgs, partialFields } from './pureln-partial.mjs';

test('absent / null / 0 take_atoms -> no extra args (the whole-offer argv is unchanged)', () => {
  for (const v of [undefined, null, 0]) {
    const r = takeAssetMsatArgs(v);
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, [], `take_atoms=${v} must add nothing`);
  }
});

test('a positive slice becomes -take-asset-msat with atoms*1000', () => {
  const r = takeAssetMsatArgs(400);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['-take-asset-msat', '400000']);
});

test('the msat conversion is BigInt-exact at max-supply scale', () => {
  // 2^53-1 atoms: the largest JSON-safe integer. *1000 exceeds 2^53, where a
  // Number multiply silently rounds to a multiple of 1024 — the slice xpln is
  // told to take would then not be the slice the wallet priced.
  const atoms = Number.MAX_SAFE_INTEGER;   // 9007199254740991
  const r = takeAssetMsatArgs(atoms);
  assert.equal(r.ok, true);
  assert.equal(r.args[0], '-take-asset-msat');
  assert.equal(r.args[1], (BigInt(atoms) * 1000n).toString());
  assert.equal(r.args[1], '9007199254740991000');
});

test('a non-integer / negative / junk take_atoms fails closed', () => {
  for (const v of [-1, 1.5, 'abc', NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    const r = takeAssetMsatArgs(v);
    assert.equal(r.ok, false, `take_atoms=${v} must be refused`);
    assert.match(r.error, /take_atoms/);
  }
});

test('the PARTIAL line parses into {partial:true, remaining_atoms}', () => {
  const out = [
    'PURE-LN SWAP SETTLED: bought 400 ' + 'aa'.repeat(32) + ' for 200 BTC sats over Lightning; preimage ' + 'cd'.repeat(32),
    "  PARTIAL fill: 400 of the offer's 1000 atoms; 600 remain resting",
  ].join('\n');
  assert.deepEqual(partialFields(out), { partial: true, remaining_atoms: 600 });
});

test('a whole fill (no PARTIAL line) adds no fields — the response shape is unchanged', () => {
  const out = 'PURE-LN SWAP SETTLED: sold 1000 ' + 'aa'.repeat(32) + ' for 500 BTC sats over Lightning; preimage ' + 'cd'.repeat(32);
  assert.deepEqual(partialFields(out), {});
  assert.deepEqual(partialFields(''), {});
  assert.deepEqual(partialFields(null), {});
});
