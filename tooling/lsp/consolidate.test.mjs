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

// fundFromNode: what the LSP's channel-open job does with the node's coins.
import { fundFromNode } from './consolidate.mjs';
import { readFileSync } from 'node:fs';

function fundingNode() {
  const calls = [];
  const call = async (method, args, rpc) => {
    calls.push({ method, args, rpc });
    if (method === 'newaddr') return { bech32: 'tb1qown' };
    if (method === 'withdraw') return { txid: '11'.repeat(32) };
    throw new Error('unexpected ' + method);
  };
  const connect = async () => { calls.push({ method: 'connect' }); };
  const fund = async (args) => { calls.push({ method: 'fundchannel', args }); return { txid: '22'.repeat(32), channel_id: '33'.repeat(32) }; };
  return { calls, call, connect, fund };
}

test('with consolidate, the coins move to the node\'s own address before the channel is funded from them', async () => {
  const n = fundingNode();
  const statuses = [];
  const r = await fundFromNode({ consolidate: true, call: n.call, fund: n.fund, connect: n.connect, rpc: '/x',
    chain: 'seq', assetId: GOLD, peerId: '02' + 'aa'.repeat(32), amount: 2980000, onStatus: (s) => statuses.push(s) });
  assert.deepEqual(n.calls.map((c) => c.method), ['newaddr', 'withdraw', 'connect', 'fundchannel']);
  assert.deepEqual(n.calls[1].args, ['destination=tb1qown', 'satoshi=all', 'minconf=0', `asset=${GOLD}`]);
  assert.deepEqual(n.calls[3].args, [`id=02${'aa'.repeat(32)}`, 'amount=2980000', 'announce=true', 'minconf=0', `asset=${GOLD}`]);
  assert.deepEqual(statuses, ['consolidating', 'connecting', 'opening']);
  assert.deepEqual(r, { consolidate_txid: '11'.repeat(32), funding_txid: '22'.repeat(32), channel_id: '33'.repeat(32) });
});

test('without consolidate, the channel is funded from the coins as they are', async () => {
  const n = fundingNode();
  const r = await fundFromNode({ consolidate: false, call: n.call, fund: n.fund, connect: n.connect, rpc: '/b',
    chain: 'btc', assetId: null, peerId: '03' + 'bb'.repeat(32), amount: 50000 });
  assert.deepEqual(n.calls.map((c) => c.method), ['connect', 'fundchannel']);
  assert.deepEqual(n.calls[1].args, [`id=03${'bb'.repeat(32)}`, 'amount=50000', 'announce=true', 'minconf=0']);
  assert.equal(r.consolidate_txid, null);
});

test('a refused consolidation fails the job before any funding is asked for', async () => {
  const n = fundingNode();
  const call = async (m, a, r) => {
    if (m === 'withdraw') throw new Error('withdraw: Signed PSBT not finalizeable');
    return n.call(m, a, r);
  };
  await assert.rejects(fundFromNode({ consolidate: true, call, fund: n.fund, connect: n.connect, rpc: '/x',
    chain: 'seq', assetId: GOLD, peerId: '02' + 'aa'.repeat(32), amount: 1 }), /not finalizeable/);
  assert.equal(n.calls.filter((c) => c.method === 'fundchannel' || c.method === 'connect').length, 0);
});

test('the LSP\'s channel-open job takes `consolidate` from the request and funds through fundFromNode', () => {
  const src = readFileSync(new URL('./lsp-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /consolidate: body\.consolidate === true,/);
  assert.match(src, /await fundFromNode\(\{\s*consolidate: job\.consolidate,/);
  // fundchannel is asked only through fundFromNode in the channel-open job.
  const job = src.slice(src.indexOf('async function runChannelOpen'), src.indexOf('function startChannelOpen'));
  assert.equal((job.match(/'fundchannel'/g) || []).length, 1);
});
