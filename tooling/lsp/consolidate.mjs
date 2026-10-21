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

// The value, in base units, of what a consolidation left on the node: its outputs of the asset,
// read back from the node's own wallet (withdraw records them as it broadcasts).
export async function consolidatedUnits({ call, rpc, chain, assetId, txid }) {
  const lf = await call('listfunds', [], rpc);
  const units = (lf && lf.outputs || [])
    .filter((o) => o.txid === txid && (chain !== 'seq' || String(o.asset || '').toLowerCase() === String(assetId).toLowerCase()))
    .reduce((s, o) => s + Math.floor(parseInt(String(o.amount_msat), 10) / 1000), 0);
  if (!(units > 0)) throw new Error(`the consolidation ${txid} left no coin the node can see`);
  return units;
}

// Fund a channel from the node's coins: with `consolidate`, consolidateToOwn first; then
// connect to the routing peer and fundchannel `amount` (in the asset, named, on Sequentia),
// spending unconfirmed coins (minconf=0). A refusal at either step is the job's error, and the
// funding is never asked for after a consolidation that failed.
//
// The consolidation pays its own fee out of the coins, so `amount` — sized by the caller from
// the coins before it — can no longer be met. After a consolidation the channel is at most the
// consolidated coin less `feeReserve`, which the funding transaction needs for its own fee.
//
//   fund(args) -> fundchannel's result; connect() -> resolves once the peer is connected;
//   onStatus(status): 'consolidating', 'connecting', 'opening'.
//
// Returns { consolidate_txid, funding_txid, channel_id, amount }.
export async function fundFromNode({ consolidate, call, fund, connect, rpc, chain, assetId, peerId, amount, feeReserve = 0, onStatus }) {
  const status = (s) => { try { onStatus && onStatus(s); } catch {} };
  let consolidateTxid = null;
  if (consolidate) {
    status('consolidating');
    consolidateTxid = (await consolidateToOwn({ call, rpc, chain, assetId })).txid;
    const units = await consolidatedUnits({ call, rpc, chain, assetId, txid: consolidateTxid });
    const room = units - feeReserve;
    if (!(room > 0)) throw new Error(`the consolidated coin (${units}) does not cover the funding fee reserve (${feeReserve})`);
    amount = Math.min(amount, room);
  }
  status('connecting');
  await connect();
  status('opening');
  const args = [`id=${peerId}`, `amount=${amount}`, 'announce=true', 'minconf=0'];
  if (chain === 'seq' && assetId) args.push(`asset=${assetId}`);
  const fc = await fund(args);
  return { consolidate_txid: consolidateTxid, funding_txid: fc.txid || (fc.txids && fc.txids[0]) || null,
    channel_id: fc.channel_id || null, amount };
}
