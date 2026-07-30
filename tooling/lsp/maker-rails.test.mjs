// WHAT makerRailsFromOffer FEEDS THE ROUTER, AND WHY IT IS NOT THE LITERAL RAILS.
//
// This function reports a SUBMARINE maker's BTC leg as on-chain, which is not what the
// maker literally does. That looks like a bug and was changed to the literal truth —
// which broke routing: with both sides' rails agreeing, planSettlement reports a
// happyCoincidence and chooseSettlementPath returns 'native', losing the p2p-submarine
// path that this exact shape requires.
//
// What the router means by a leg "crossing" is "the two sides settle this leg through
// different mechanisms and something must bridge them". A BTC-LN payment against an
// on-chain asset HTLC needs the submarine protocol whether or not the parties agree
// about rails, and reporting 'chain' is how that reaches the router.
//
// These tests pin the ROUTING OUTCOMES rather than the intermediate rail strings, so the
// function can be corrected properly (once planSettlement can tell "no rail conversion"
// from "no cross-network protocol") without silently changing where takes go.
//
//   node --test tooling/lsp/maker-rails.test.mjs
import assert from 'node:assert';
import test from 'node:test';
import { dispatchSubswap } from '../../subswap.js';

const ASSET = 'aa'.repeat(32);
const submarine = { rail: 'submarine', meta: { caps: { btc_ln: true, interactive: true, asset_onchain: true } } };
const onchain   = { rail: 'onchain',   meta: { caps: { btc_ln: false, interactive: false, asset_onchain: true } } };
const lnAsset   = { rail: 'ln',        meta: { caps: { btc_ln: true, interactive: true, asset_onchain: false } } };

test('BUY paying BTC-LN vs an interactive submarine maker -> P2P submarine, not a bridge', () => {
  const d = dispatchSubswap({ asset: ASSET, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: submarine });
  assert.equal(d.path, 'p2p-submarine',
    'routing this to the LSP bridge makes it speak the cross-chain courier protocol at a ' +
    'submarine maker; both sides then wait for a message the other never sends');
  assert.equal(d.ln_direction, 1);
  assert.equal(d.lnSide, 'payer');
});

test('SELL receiving BTC-LN vs a submarine maker -> P2P submarine the other way', () => {
  const d = dispatchSubswap({ asset: ASSET, side: 'sell', payRail: 'chain', recvRail: 'ln', offer: submarine });
  assert.equal(d.path, 'p2p-submarine');
  assert.equal(d.ln_direction, 0);
});

test('a NON-interactive on-chain maker still routes to the LSP bridge', () => {
  const d = dispatchSubswap({ asset: ASSET, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: onchain });
  assert.equal(d.path, 'lsp-bridge', 'this is the shape the bridge exists for');
});

test('an all-on-chain take needs neither: it settles natively', () => {
  const d = dispatchSubswap({ asset: ASSET, side: 'buy', payRail: 'chain', recvRail: 'chain', offer: onchain });
  assert.equal(d.path, 'native');
});

test('a maker resting the asset over LN is honestly disabled, not misrouted', () => {
  const d = dispatchSubswap({ asset: ASSET, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: lnAsset });
  assert.equal(d.path, 'unsupported');
  assert.match(d.reason, /on-chain asset leg/);
});
