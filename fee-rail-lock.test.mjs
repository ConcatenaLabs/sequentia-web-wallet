// Fee-selector RAIL LOCK (§6). The reported regression was that the fee picker
// stayed live on rails where the fee asset is not the user's to choose: the
// cross and mixed paths hardcoded paintFee('BTC', …) for DISPLAY only, so the
// label said BTC while the picker still offered a Sequentia asset, and a stale
// S.feeAsset survived a rail change because nothing forced it.
//
// The fix is one authority, feeAssetPolicy(), that every consumer reads. These
// tests pin its three rules and the forcing behaviour.
//
// swap.js reaches the DOM through an injected context, so the module is driven
// here through its __test__ surface with a minimal fake context. Run:
//   node --test fee-rail-lock.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { initSwap, __test__ } from './swap.js';

const { feeAssetPolicy, feeAssetOptions, acceptedFee, setFeeState } = __test__;

const POLICY_HEX = 'pp'.repeat(32);          // tSEQ stand-in
const GOLD = 'aa'.repeat(32), OILX = 'bb'.repeat(32);
const META = {
  [POLICY_HEX]: { ticker: 'tSEQ', precision: 8 },
  [GOLD]: { ticker: 'GOLD', precision: 8 },
  [OILX]: { ticker: 'OILX', precision: 8 },
  BTC: { ticker: 'BTC', precision: 8 },
};

// Balances and the node's published rate table are the two inputs rule 3 reads.
let BAL = {}, RATES = {};

function install(){
  initSwap({
    POLICY_HEX,
    assetMeta: (h) => META[h] || { ticker: String(h).slice(0, 6), precision: 8 },
    get feeRates(){ return RATES; },
    balObj: () => BAL,
    fmtAtoms: (a) => String(a),
    refValueStr: () => '',
    $: () => null,
    el: () => null,
  });
}

const priced = (...hexes) => Object.fromEntries(hexes.map(h => [h, { rate: 100000000 }]));

test('rule 1: paying BTC on-chain LOCKS the fee to BTC', () => {
  install();
  BAL = { [GOLD]: 5000n, [POLICY_HEX]: 9000n };
  RATES = priced(GOLD, POLICY_HEX);
  setFeeState({ payAsset: 'BTC', payRail: 'chain', feeAsset: GOLD, feeAssetTouched: true });

  const pol = feeAssetPolicy();
  assert.equal(pol.locked, true, 'a Bitcoin network fee is not the user’s to choose');
  assert.equal(pol.asset, 'BTC');
  assert.deepEqual(pol.options, [], 'nothing to offer, so the picker must be DISABLED not merely empty');
});

test('rule 1 overrides a stale manual pick made on another rail', () => {
  install();
  BAL = { [GOLD]: 5000n };
  RATES = priced(GOLD);
  // The user picked GOLD while paying an asset, then switched to paying BTC.
  setFeeState({ payAsset: 'BTC', payRail: 'chain', feeAsset: GOLD, feeAssetTouched: true });
  assert.equal(feeAssetPolicy().asset, 'BTC',
    'the stale pick must not survive the rail that invalidated it');
});

test('rule 2: paying over Lightning LOCKS the fee to the asset being paid', () => {
  install();
  BAL = { [GOLD]: 5000n, [OILX]: 7000n };
  RATES = priced(GOLD, OILX);
  setFeeState({ payAsset: GOLD, payRail: 'ln', feeAsset: OILX, feeAssetTouched: true });

  const pol = feeAssetPolicy();
  assert.equal(pol.locked, true);
  assert.equal(pol.asset, GOLD, 'a routing fee is paid in the routed asset');
  assert.deepEqual(pol.options, []);
});

test('rule 2 covers BTC over Lightning too (an LN fee, not a Bitcoin network fee)', () => {
  install();
  BAL = { [GOLD]: 5000n };
  RATES = priced(GOLD);
  setFeeState({ payAsset: 'BTC', payRail: 'ln', feeAsset: null, feeAssetTouched: false });

  const pol = feeAssetPolicy();
  assert.equal(pol.locked, true);
  assert.equal(pol.asset, 'BTC');
  assert.match(pol.note, /Lightning/, 'the reason shown must name the rail, not the chain');
});

test('rule 3: paying an on-chain Sequentia asset opens the fee market', () => {
  install();
  BAL = { [GOLD]: 5000n, [OILX]: 7000n, [POLICY_HEX]: 9000n };
  RATES = priced(GOLD, OILX, POLICY_HEX);
  setFeeState({ payAsset: GOLD, payRail: 'chain', feeAsset: null, feeAssetTouched: false });

  const pol = feeAssetPolicy();
  assert.equal(pol.locked, false);
  const hexes = pol.options.map(o => o.hex);
  assert.deepEqual(hexes.slice().sort(), [GOLD, OILX, POLICY_HEX].sort(),
    'every priced asset you hold is offered');
  assert.equal(hexes[0], GOLD, 'the asset you are paying with is listed first');
  assert.equal(pol.asset, GOLD, 'and is the natural default');
});

test('rule 3: BTC never appears — it is not a Sequentia-issued asset', () => {
  install();
  BAL = { [GOLD]: 5000n, BTC: 100000n };
  RATES = { ...priced(GOLD), BTC: { rate: 100000000 } };   // even if something prices it
  setFeeState({ payAsset: GOLD, payRail: 'chain', feeAsset: null, feeAssetTouched: false });

  assert.equal(acceptedFee('BTC'), false);
  assert.ok(!feeAssetOptions().some(o => o.hex === 'BTC'),
    'no Sequentia fee can be denominated in BTC');
});

test('rule 3: an asset you do not hold is not offered', () => {
  install();
  BAL = { [GOLD]: 5000n, [OILX]: 0n };
  RATES = priced(GOLD, OILX, POLICY_HEX);
  setFeeState({ payAsset: GOLD, payRail: 'chain', feeAsset: null, feeAssetTouched: false });

  const hexes = feeAssetOptions().map(o => o.hex);
  assert.ok(!hexes.includes(OILX), 'a zero balance cannot pay a fee');
  assert.ok(!hexes.includes(POLICY_HEX), 'and tSEQ earns no exemption from that');
});

test('tSEQ is one row among equals: unpriced by the node means not offered', () => {
  install();
  BAL = { [GOLD]: 5000n, [POLICY_HEX]: 9000n };
  RATES = priced(GOLD);              // the feed omits the policy asset
  setFeeState({ payAsset: GOLD, payRail: 'chain', feeAsset: null, feeAssetTouched: false });

  // This tracks the node: since the 1:1 fallback for an UNLISTED policy asset was
  // removed, an unlisted tSEQ is refused like any other unlisted asset. Offering
  // it here would produce a "min relay fee not met" rejection at broadcast.
  assert.equal(acceptedFee(POLICY_HEX), false, 'no privileged fallback for the policy asset');
  assert.ok(!feeAssetOptions().some(o => o.hex === POLICY_HEX));
});

test('a manual pick is honoured while it stays on offer, and dropped when it does not', () => {
  install();
  BAL = { [GOLD]: 5000n, [OILX]: 7000n };
  RATES = priced(GOLD, OILX);
  setFeeState({ payAsset: GOLD, payRail: 'chain', feeAsset: OILX, feeAssetTouched: true });
  assert.equal(feeAssetPolicy().asset, OILX, 'the user’s choice wins while it is valid');

  RATES = priced(GOLD);              // the node stops pricing OILX mid-session
  assert.equal(feeAssetPolicy().asset, GOLD,
    'an invalidated pick falls back to the policy rather than being paid in an unaccepted asset');
});

test('no pay asset yet: nothing is locked and nothing is claimed', () => {
  install();
  BAL = {}; RATES = {};
  setFeeState({ payAsset: null, payRail: null, feeAsset: null, feeAssetTouched: false });
  const pol = feeAssetPolicy();
  assert.equal(pol.locked, false);
  assert.equal(pol.asset, null);
});
