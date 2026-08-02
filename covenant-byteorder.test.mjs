// BYTE-ORDER regression tests for the covenant PLACE path (and the fill host seam).
//
// THE BUG: placeCovenant fed planPlaceOrder the DISPLAY-hex asset ids the UI holds, but the
// covenant leaf bakes the ids in INTERNAL byte order (what on-chain introspection compares, and
// what the relay convention requires in CovenantTerms: pair = display, terms = internal). A
// display-order leaf derives an spk the relay watcher (Go expectFromTerms), the settler, and
// consensus itself can never match — every wallet-placed covenant was unfillable/ghost-held.
//
// These tests pin, against the SAME Go/Python golden vector as covenant.test.mjs
// (seqdex/daemon/pkg/covenant/leaf_test.go fixedOrder: asset_a = bytes 0..31,
// asset_b = bytes 32..63, rate 3/7, min_lot 5e8, maker_prog 0x11*32, expiry 400,
// maker_x 0x22*32, NUMS internal key):
//   (a) the place path fed DISPLAY ids now derives the INTERNAL-order golden spk, and the
//       CovenantTerms it posts carry internal-order asset_a/asset_b (the seeder's proven idiom);
//   (b) a LEGACY record (no idsInternal marker) still re-derives the OLD display-order taptree
//       byte-for-byte — its refund/cancel depends on reproducing the buggy derivation;
//   (c) a NEW record (idsInternal: true) re-derives the internal-order spk;
//   (d) the fill host seam flips the recipe's internal-order ids to DISPLAY for coin selection +
//       the wasm assembler, without touching the consensus leaf/control-block bytes.
//
// Run: node covenant-byteorder.test.mjs

import { planPlaceOrder, buildCovenantTerms, planFillFromMatched, __test__ as covOrderTest } from './covenant-order.js';
import { bytesToHex } from './covenant.js';
import { makeCovenantHooks, revHexStr } from './covenant-fill-host.js';

// swap.js reads `localStorage` at module load; a no-op shim is all the import needs.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { __test__: swapTest } = await import('./swap.js');
const { revHex, covenantDerivationIds, covenantLocksAsset } = swapTest;

let fails = 0;
function check(name, got, want){
  if (got !== want){ fails++; console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
}
function ok(name, cond, msg){ if (cond) console.log(`ok   ${name}`); else { fails++; console.error(`FAIL ${name}: ${msg||''}`); } }

// --- the golden fixture, in BOTH byte orders --------------------------------
const A_INTERNAL = bytesToHex(Uint8Array.from({length:32},(_,i)=>i));      // leaf_test.go asset_a
const B_INTERNAL = bytesToHex(Uint8Array.from({length:32},(_,i)=>32+i));   // leaf_test.go asset_b
const A_DISPLAY = revHex(A_INTERNAL);   // what the UI/wallet/registry hold
const B_DISPLAY = revHex(B_INTERNAL);
// The Go golden spk (leaf_test.go, pinned by covenant.test.mjs) — derived from INTERNAL ids.
const GOLD_SPK = '5120b22544534c99090050a06eece12231a2321f4144661ab3964408d5780821afaa';
// The spk the OLD buggy place path derived (same fixture, DISPLAY-order ids). Pinned so the
// legacy refund derivation can never drift: legacy covenants were FUNDED against this spk.
const LEGACY_SPK = '5120a341bed2f0f11047494999730a05c06e2fac29576638aa6b95e4b4267d77468b';

const FIXED = { sellAtoms: 90n*100000000n, rateNum: 3n, rateDen: 7n, minLot: 500000000n,
                expiryLocktime: 400, makerProg: '11'.repeat(32), makerX: '22'.repeat(32) };

// --- revHex is a byte reversal (involution, txid convention) ----------------
check('revhex_reverses', revHex('001122'), '221100');
check('revhex_involution', revHex(revHex(A_DISPLAY)), A_DISPLAY);
check('revhex_matches_host_copy', revHexStr(A_INTERNAL), revHex(A_INTERNAL));

// --- (a) place path: DISPLAY ids in -> INTERNAL golden derivation out -------
{
  // Exactly what placeCovenant now builds: display ids through the conversion boundary.
  const plan = planPlaceOrder({ ...covenantDerivationIds(A_DISPLAY, B_DISPLAY, true), ...FIXED });
  check('place_display_in_golden_spk_out', plan.spkHex, GOLD_SPK);

  // Byte-identical to the seeder's proven idiom: internal ids fed directly.
  const seeder = planPlaceOrder({ assetA: A_INTERNAL, assetB: B_INTERNAL, ...FIXED });
  check('place_equals_seeder_derivation', plan.spkHex, seeder.spkHex);
  check('place_fill_leaf_equals_seeder', bytesToHex(plan.tap.fillLeaf), bytesToHex(seeder.tap.fillLeaf));
  check('place_ctrl_block_equals_seeder', bytesToHex(plan.tap.controlBlock), bytesToHex(seeder.tap.controlBlock));

  // The CovenantTerms the wallet posts now carry INTERNAL-order ids (the relay contract the Go
  // watcher reverseHex()es back to display).
  const ct = buildCovenantTerms(plan.order, 'ab'.repeat(32), 0, plan.tap);
  check('terms_asset_a_internal', ct.asset_a, A_INTERNAL);
  check('terms_asset_b_internal', ct.asset_b, B_INTERNAL);
  check('terms_asset_a_is_rev_of_display', ct.asset_a, revHex(A_DISPLAY));
}

// --- (b) LEGACY record (no marker): bug-compatible display-order derivation --
{
  const rec = { pay: A_DISPLAY, receive: B_DISPLAY };   // pre-fix record shape: no idsInternal
  const ids = covenantDerivationIds(rec.pay, rec.receive, !!rec.idsInternal);
  check('legacy_ids_stay_display_a', ids.assetA, A_DISPLAY);
  check('legacy_ids_stay_display_b', ids.assetB, B_DISPLAY);
  const plan = planPlaceOrder({ ...ids, ...FIXED });
  check('legacy_rec_rederives_old_spk', plan.spkHex, LEGACY_SPK);
  // The refund recipe (what cancel/reclaim broadcasts against) re-derives the SAME prevout spk.
  const refund = covOrderTest.planRefund(plan.order, { txid: 'cd'.repeat(32), vout: 0, locked: FIXED.sellAtoms });
  check('legacy_refund_spk_unchanged', refund.covenantSpkHex, LEGACY_SPK);
}

// --- (c) NEW record (idsInternal: true): internal-order derivation ----------
{
  const rec = { pay: A_DISPLAY, receive: B_DISPLAY, idsInternal: true };
  const plan = planPlaceOrder({ ...covenantDerivationIds(rec.pay, rec.receive, !!rec.idsInternal), ...FIXED });
  check('new_rec_rederives_internal_spk', plan.spkHex, GOLD_SPK);
  const refund = covOrderTest.planRefund(plan.order, { txid: 'cd'.repeat(32), vout: 0, locked: FIXED.sellAtoms });
  check('new_refund_spk_internal', refund.covenantSpkHex, GOLD_SPK);
  // ...and the two generations really are different covenants (the whole point of the marker).
  ok('generations_differ', GOLD_SPK !== LEGACY_SPK, 'legacy and internal derivations must differ');
}

// --- W5 guard convention: expected id passed in the terms' (internal) order --
{
  // Mirrors peggedCovenantLocksSbtc/isPeggedFillToRedeem: terms internal, registry display.
  check('locks_guard_internal_order', String(covenantLocksAsset({ covenant: { asset_a: A_INTERNAL } }, revHex(A_DISPLAY))), 'true');
  check('locks_guard_rejects_display_mixup', String(covenantLocksAsset({ covenant: { asset_a: A_INTERNAL } }, A_DISPLAY)), 'false');
}

// --- (d) fill host seam: internal recipe ids -> DISPLAY wasm/coin-selection --
{
  // End-to-end: relay CovenantTerms (internal, as the seeder posts) -> planFillFromMatched ->
  // makeCovenantHooks.buildCovenantFillTx. The wallet's UTXOs and the wasm assembler speak
  // DISPLAY hex; the consensus leaf/control-block bytes must pass through untouched.
  const plan = planPlaceOrder({ assetA: A_INTERNAL, assetB: B_INTERNAL, ...FIXED });
  const ct = buildCovenantTerms(plan.order, 'ab'.repeat(32), 1, plan.tap);
  const matched = { offer_id: 'o1', resting_is_covenant: true, covenant: ct,
                    covenant_locked: String(FIXED.sellAtoms), fill_base_amount: String(FIXED.sellAtoms) };
  const recipe = planFillFromMatched(matched, plan.spkHex);
  check('recipe_credit_asset_internal', recipe.creditAsset, B_INTERNAL);   // recipe stays terms-order

  const FEE_DISPLAY = 'cc'.repeat(32);
  const mkUtxo = (assetDisp, value, txid, vout, idx) => ({
    unblinded: () => ({ asset: () => ({ toString: () => assetDisp }), value: () => value }),
    outpoint: () => ({ txid: () => ({ toString: () => txid }), vout: () => vout }),
    scriptPubkey: () => ({ toString: () => '0014' + 'ab'.repeat(20) }),
    extInt: () => 'External',
    wildcardIndex: () => idx,
  });
  let captured = null;
  const hooks = makeCovenantHooks({
    wasm: { buildCovenantFillTx: (full) => { captured = full; return { rawHex: 'aa', txid: 't' }; } },
    wollet: { utxos: () => [ mkUtxo(B_DISPLAY, 10n**12n, '11'.repeat(32), 0, 0),
                             mkUtxo(FEE_DISPLAY, 10n**9n, '22'.repeat(32), 1, 1) ],
              address: () => ({ address: () => ({ toString: () => 'addr' }) }) },
    network: null, mnemonic: 'x', esploraFetch: async () => { throw new Error('unused'); },
    receiveAddress: () => 'addr', fee: { asset: FEE_DISPLAY, atoms: 1000n },
  });
  await hooks.buildCovenantFillTx(recipe);
  ok('seam_called_wasm', captured !== null, 'wasm assembler must be called');
  check('seam_credit_asset_display', captured.creditAsset, B_DISPLAY);
  check('seam_covenant_asset_display', captured.covenantAsset, A_DISPLAY);
  check('seam_funding_selected_by_display', String(captured.takerFundingUtxos.length), '2');
  ok('seam_funds_credit_in_display', captured.takerFundingUtxos.some(u => u.asset === B_DISPLAY), 'credit funded from display-keyed utxos');
  ok('seam_funds_fee_in_display', captured.takerFundingUtxos.some(u => u.asset === FEE_DISPLAY), 'fee funded from display-keyed utxos');
  // NO double reversal: the consensus bytes are the golden ones, untouched.
  check('seam_leaf_untouched', captured.fillLeafHex, bytesToHex(plan.tap.fillLeaf));
  check('seam_ctrl_untouched', captured.controlBlockHex, bytesToHex(plan.tap.controlBlock));
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
