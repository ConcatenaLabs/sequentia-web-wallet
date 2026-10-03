// The consolidation before funding a channel from a hosted node's coins: what it asks the
// node for, in which asset, and that a refusal surfaces rather than being swallowed.
import { test } from 'node:test';
import assert from 'node:assert';
import { consolidateToOwn } from './consolidate.mjs';

const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1';

function fakeNode(withdrawResult) {
  const calls = [];
  const call = async (method, args, rpc) => {
    calls.push({ method, args, rpc });
    if (method === 'newaddr') return { bech32: 'tb1qown' };
    if (method === 'withdraw') {
      if (withdrawResult instanceof Error) throw withdrawResult;
      return withdrawResult;
    }
    throw new Error('unexpected ' + method);
  };
  return { calls, call };
}

test('a Sequentia node sends every coin of the asset to its own new address, the fee in the asset', async () => {
  const n = fakeNode({ txid: 'ab'.repeat(32) });
  const r = await consolidateToOwn({ call: n.call, rpc: '/x/lightning-rpc', chain: 'seq', assetId: GOLD });
  assert.deepEqual(r, { txid: 'ab'.repeat(32), address: 'tb1qown' });
  assert.deepEqual(n.calls.map((c) => c.method), ['newaddr', 'withdraw']);
  assert.deepEqual(n.calls[1].args, ['destination=tb1qown', 'satoshi=all', 'minconf=0', `asset=${GOLD}`]);
  assert.ok(n.calls.every((c) => c.rpc === '/x/lightning-rpc'));
});

test('a Bitcoin node names no asset', async () => {
  const n = fakeNode({ txid: 'cd'.repeat(32) });
  await consolidateToOwn({ call: n.call, rpc: '/b/lightning-rpc', chain: 'btc', assetId: null });
  assert.deepEqual(n.calls[1].args, ['destination=tb1qown', 'satoshi=all', 'minconf=0']);
});

test('a Sequentia node without an asset id is refused before anything is asked of it', async () => {
  const n = fakeNode({ txid: 'ef'.repeat(32) });
  await assert.rejects(consolidateToOwn({ call: n.call, rpc: '/x', chain: 'seq', assetId: '' }), /asset id is required/);
  assert.equal(n.calls.filter((c) => c.method === 'withdraw').length, 0);
});

test("the device's refusal is the job's error", async () => {
  const n = fakeNode(new Error('withdraw: Signed PSBT not finalizeable: the signer did not sign every input'));
  await assert.rejects(consolidateToOwn({ call: n.call, rpc: '/x', chain: 'seq', assetId: GOLD }), /not finalizeable/);
});
