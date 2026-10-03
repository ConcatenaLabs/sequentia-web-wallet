// Move a hosted node's coins of one asset to a fresh address of the node's own wallet, and
// fund a channel from them.
//
// A hosted node's device moves the node's coins only to the node's own addresses or into a
// channel the node opens. A channel funded from the node's coins (an interrupted deposit, or
// what a channel's close paid the node) is funded in two steps, each one the device signs: every
// coin of the asset goes to a new address of the node's own (consolidateToOwn), and the funding
// spends that coin (fundchannel takes it unconfirmed, minconf=0).
//
//   call(method, keywordArgs, rpc) -> result   (the LSP's lnrpcKw: lightning-cli -k)
//
// Returns { txid, address }.
export async function consolidateToOwn({ call, rpc, chain, assetId }) {
  const na = await call('newaddr', ['addresstype=bech32'], rpc);
  const address = na.bech32 || na.address || na.p2tr;
  if (!address) throw new Error('newaddr gave no address');
  const args = [`destination=${address}`, 'satoshi=all', 'minconf=0'];
  // On Sequentia the coins and the fee are in the channel's asset, named: never an
  // implicit other asset. A Bitcoin node has one asset.
  if (chain === 'seq') {
    if (!/^[0-9a-f]{64}$/i.test(String(assetId || ''))) throw new Error('a Sequentia asset id is required');
    args.push(`asset=${assetId}`);
  }
  const w = await call('withdraw', args, rpc);
  if (!w || !w.txid) throw new Error('withdraw gave no txid');
  return { txid: w.txid, address };
}

// Fund a channel from the node's coins: with `consolidate`, consolidateToOwn first; then
// connect to the routing peer and fundchannel `amount` (in the asset, named, on Sequentia),
// spending unconfirmed coins (minconf=0). A refusal at either step is the job's error, and the
// funding is never asked for after a consolidation that failed.
//
//   fund(args) -> fundchannel's result; connect() -> resolves once the peer is connected;
//   onStatus(status): 'consolidating', 'connecting', 'opening'.
//
// Returns { consolidate_txid, funding_txid, channel_id }.
export async function fundFromNode({ consolidate, call, fund, connect, rpc, chain, assetId, peerId, amount, onStatus }) {
  const status = (s) => { try { onStatus && onStatus(s); } catch {} };
  let consolidateTxid = null;
  if (consolidate) {
    status('consolidating');
    consolidateTxid = (await consolidateToOwn({ call, rpc, chain, assetId })).txid;
  }
  status('connecting');
  await connect();
  status('opening');
  const args = [`id=${peerId}`, `amount=${amount}`, 'announce=true', 'minconf=0'];
  if (chain === 'seq' && assetId) args.push(`asset=${assetId}`);
  const fc = await fund(args);
  return { consolidate_txid: consolidateTxid, funding_txid: fc.txid || (fc.txids && fc.txids[0]) || null,
    channel_id: fc.channel_id || null };
}
