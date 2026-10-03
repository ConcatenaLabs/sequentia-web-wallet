// Move a hosted node's coins of one asset to a fresh address of the node's own wallet,
// before a channel is funded from them.
//
// What a channel close paid a hosted node (the output its peer's commitment pays it, or
// what a mutual close paid it) is a close output. The node's device signs a spend of one
// only when every output pays the device's own scripts: a channel's funding output is not
// one of them, so a channel cannot be funded from a close output directly, and
// `fundchannel` would fail with the funding transaction unsigned. A spend of every coin
// to the node's own new address is signed; what it creates is an ordinary wallet coin,
// which then funds the channel (fundchannel takes it unconfirmed, minconf=0).
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
