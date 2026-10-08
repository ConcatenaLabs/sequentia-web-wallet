// invoice-asset.mjs: which invoices a hosted node may pay, and what its own invoices name.
import { test } from 'node:test';
import assert from 'node:assert';
import { payAssetVerdict, hostedInvoiceArgs, hostedNodeAsset, invoiceAsset } from './invoice-asset.mjs';

const GOLD = 'd024f89a8119d84ecf31fcabc87bc94e2b7d7966bc47dfb76b6237e75f2defdb';
const SILV = 'ab'.repeat(32);
// An invoice SeqLN made on sequentia-regtest, in GOLD.
const GOLD_INV = 'lnsqrt2500u1p4vw55msp5ff8xy2dtczxuhsjctsn57f7f496jkz434hkp9jkq89rgem6zwnxspp53xx98drfa537svcqkhhhtl8tee729wsn20z86s32mmml9mdtgz3qdq2wejkxar0wgap56qj03x5pr8vyane3lj4us77ffc4h67txh3raldmtvgm7whedaldsxqyjw5qcqz959qxpqysgqhe48tu4zx3q0c0v0wfj23zndyyhw5m09npxgjs3v7etjm0kh3lhrxmj4ny0hkhsrw5xcd2jf76dacmfsshqykdcvyy4y37klh3x023cp8756dq';
const BTC_INV = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const goldNode = { chain: 'seq', asset_id: GOLD.toUpperCase() };
const silvNode = { chain: 'seq', asset_id: SILV };
const btcNode = { chain: 'btc' };
const label = (x) => (x === GOLD ? 'GOLD' : x === SILV ? 'SILV' : String(x));

test('a hosted node pays only invoices in its own asset', () => {
  assert.deepStrictEqual(payAssetVerdict({ rec: goldNode, decoded: { asset: GOLD }, bolt11: GOLD_INV, label }), { ok: true });
  const v = payAssetVerdict({ rec: silvNode, decoded: { asset: GOLD }, bolt11: GOLD_INV, label });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'this invoice is paid in GOLD; your hosted node holds SILV. Pay it from your GOLD Lightning node.');
});

test('a node that reports no asset: the invoice\'s own `a` field decides', () => {
  assert.equal(invoiceAsset({}, GOLD_INV), GOLD);
  assert.equal(payAssetVerdict({ rec: silvNode, decoded: {}, bolt11: GOLD_INV, label }).ok, false);
  assert.equal(payAssetVerdict({ rec: goldNode, decoded: {}, bolt11: GOLD_INV, label }).ok, true);
});

test('Bitcoin invoices go to the Bitcoin node, Sequentia ones never do', () => {
  assert.deepStrictEqual(payAssetVerdict({ rec: btcNode, decoded: {}, bolt11: BTC_INV, label }), { ok: true });
  assert.match(payAssetVerdict({ rec: btcNode, decoded: { asset: GOLD }, bolt11: GOLD_INV, label }).error, /paid in GOLD on Sequentia/);
  assert.match(payAssetVerdict({ rec: goldNode, decoded: {}, bolt11: BTC_INV, label }).error, /this is a Bitcoin invoice/);
});

test('a hosted Sequentia node\'s invoices name its asset and allow the channel to follow', () => {
  assert.equal(hostedNodeAsset(goldNode), GOLD);
  assert.deepStrictEqual(hostedInvoiceArgs(goldNode), [`asset=${GOLD}`, 'allow_unfunded=true']);
  assert.deepStrictEqual(hostedInvoiceArgs(btcNode), []);
  assert.deepStrictEqual(hostedInvoiceArgs({ chain: 'seq', asset_id: 'nothex' }), []);
});
