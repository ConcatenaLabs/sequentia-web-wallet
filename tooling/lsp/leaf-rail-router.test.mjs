// The leaf rail in the settlement router and the unified book: which shapes a leaf settles,
// which it refuses, and which offers the book marks as takeable from leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSettlement, planLeg, chooseSettlementPath, planExecutionName, leafExecution, settlementPlanForSide } from './settlement-router.mjs';
import { classifyRelayOffer, buildUnifiedBook } from './unified-book.mjs';

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32);
const leaves = { btcRail: 'leaf', assetRail: 'leaf' };
const chain = { btcRail: 'chain', assetRail: 'chain' };
const sellerOf = (r) => ({ assetRail: r.assetRail, btcRail: r.btcRail });

test('a leg with a leaf on both ends settles in the tree; with the chain on one end, in a round', () => {
  assert.deepEqual(planLeg('asset', 'leaf', 'leaf', false),
    { unit: 'asset', rail: 'leaf', method: 'in-tree', bridge: false, lnSide: null, jitInbound: false });
  assert.deepEqual(planLeg('asset', 'chain', 'leaf', false),
    { unit: 'asset', rail: 'round', method: 'round', bridge: false, lnSide: null, jitInbound: false, leafSide: 'receiver' });
  assert.equal(planLeg('btc', 'leaf', 'chain', false).leafSide, 'payer');
  assert.throws(() => planLeg('asset', 'leaf', 'ln', false), /operator's gateway/);
  assert.throws(() => planLeg('asset', 'ln', 'leaf', false), /operator's gateway/);
  assert.throws(() => planLeg('asset', 'leaf', 'satellite', false), /must be 'ln', 'chain' or 'leaf'/);
});

test('two wallets on leaves: one in-tree swap, no preimage, no LSP', () => {
  const m = { asset: X, quote: Y, buyer: leaves, seller: sellerOf(leaves), takerSide: 'buy' };
  const p = planSettlement(m);
  assert.equal(p.leaf.shape, 'in-tree');
  assert.equal(p.btcLeg.method, 'in-tree');
  assert.equal(p.assetLeg.method, 'in-tree');
  assert.deepEqual(p.atomic, { sharedPreimage: false, oneTransaction: true, lspCoordinates: false });
  assert.deepEqual(p.steps.map((s) => s.op), ['swap-offer', 'swap-accept', 'swap-complete']);
  assert.deepEqual(chooseSettlementPath(m, {}), { path: 'leaf-swap', ln_direction: null, lnSide: null });
  assert.equal(planExecutionName('buy', p), null, 'no LSP binary settles a leaf plan');
  assert.deepEqual(leafExecution(p), ['swap_offer', 'swap_read', 'swap_accept', 'swap_complete']);
});

test('a taker on leaves against an on-chain order: a take in a round, only where the round can spend it', () => {
  for (const side of ['buy', 'sell']) {
    const m = side === 'buy'
      ? { asset: X, quote: Y, buyer: leaves, seller: sellerOf(chain), takerSide: 'buy' }
      : { asset: X, quote: Y, buyer: chain, seller: sellerOf(leaves), takerSide: 'sell' };
    const p = planSettlement(m);
    assert.equal(p.leaf.shape, 'round');
    assert.equal(p.leaf.leafParty, side === 'buy' ? 'buyer' : 'seller');
    assert.equal(p.btcLeg.method, 'round');
    assert.equal(p.assetLeg.method, 'round');
    assert.deepEqual(chooseSettlementPath(m, { caps: { leaf_take: true } }).path, 'leaf-take');
    const no = chooseSettlementPath(m, { caps: { leaf_take: false, interactive: true, btc_ln: true } });
    assert.equal(no.path, null, 'never routed to the LSP or a submarine instead');
    assert.match(no.reason, /cannot be taken from leaves/);
    assert.deepEqual(leafExecution(p), ['take_quote', 'take']);
    assert.equal(planExecutionName(side, p), null);
  }
});

test('shapes with a leaf and no construction are refused, not planned', () => {
  // BTC is never a leaf: a BTC pair (no quote, or quote BTC) has no leaf rail.
  assert.throws(() => planSettlement({ asset: X, buyer: leaves, seller: sellerOf(leaves) }), /BTC is never a leaf/);
  assert.throws(() => planSettlement({ asset: X, quote: 'BTC', buyer: leaves, seller: sellerOf(chain) }), /BTC is never a leaf/);
  // The LSP's taker-mirrored plan names no quote: a leaf there is refused, so the LSP refuses it.
  assert.throws(() => settlementPlanForSide('buy', 'leaf', 'leaf'), /BTC is never a leaf/);
  // A party with a leaf on one leg only.
  assert.throws(() => planSettlement({ asset: X, quote: Y, buyer: { btcRail: 'leaf', assetRail: 'chain' }, seller: sellerOf(chain) }),
    /on both legs, or on neither/);
  // Leaves against Lightning.
  assert.throws(() => planSettlement({ asset: X, quote: Y, buyer: leaves, seller: { assetRail: 'ln', btcRail: 'ln' } }),
    /with an on-chain order/);
  assert.throws(() => planSettlement({ asset: X, quote: Y, buyer: leaves, seller: { assetRail: 'chain', btcRail: 'ln' } }),
    /with an on-chain order/);
});

test('the shapes without a leaf plan as they did', () => {
  const p = planSettlement({ asset: X, buyer: chain, seller: sellerOf(chain) });
  assert.equal(p.leaf, undefined);
  assert.equal(chooseSettlementPath({ asset: X, buyer: chain, seller: sellerOf(chain) }).path, 'native');
  assert.equal(planExecutionName('buy', settlementPlanForSide('buy', 'ln', 'chain')), 'xsubbuy');
});

test('the unified book marks the transparent covenant orders a leaf can take', () => {
  const cov = { offer_id: 'c1', offer_asset: X, want_asset: Y, offer_amount: '600000', want_amount: '1200000',
    covenant: { asset_a: 'x', asset_b: 'y' } };
  const e = classifyRelayOffer(cov, { quote: Y });
  assert.equal(e.side, 'ask');
  assert.equal(e.meta.covenant, true);
  assert.equal(e.meta.caps.leaf_take, true);
  assert.equal(e.meta.caps.interactive, false);
  const conf = classifyRelayOffer({ ...cov, offer_id: 'c2', confidential: true }, { quote: Y });
  assert.equal(conf.meta.caps.leaf_take, false, 'a blinded order hides what the round must pay');
  const intent = classifyRelayOffer({ ...cov, offer_id: 'i1', covenant: undefined }, { quote: Y });
  assert.equal(intent.meta.caps.leaf_take, false, 'a plain intent needs its maker live on the chain');
  assert.equal(intent.meta.caps.interactive, true);
  const sim = classifyRelayOffer({ ...cov, offer_id: 's1', covenant: undefined, simplicity_covenant: { asset_a: 'x' } }, { quote: Y });
  assert.equal(sim.meta.caps.leaf_take, false, 'the round fills no Simplicity order');
  // The BTC families carry no leaf capability at all.
  assert.equal(classifyRelayOffer({ offer_id: 'b', want_asset: 'BTC', offer_asset: X, offer_amount: '1000', want_amount: '500' }).meta.caps.leaf_take, undefined);
  // In the merged book the flag rides along, so a taker on leaves reads it from the best offer.
  const book = buildUnifiedBook([cov, { ...cov, offer_id: 'c3', want_amount: '1100000', covenant: undefined }], { quote: Y });
  assert.deepEqual(book.asks.map((o) => [o.id, o.meta.caps.leaf_take]), [['c3', false], ['c1', true]]);
});
