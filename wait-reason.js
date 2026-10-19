// Why an unconfirmed transaction is still waiting, from what the nodes the wallet sends to say about
// it. index.html gathers the facts (the transaction's fee and size, the explorer's /feeinfo and
// /congestion?asset=) and shows the lines this returns, under "Why it is waiting" in a History
// row's details. Each line says what can be done about it.
//
// waitReasons({ fee, vsize, feeInfo, congestion }):
//   fee         { atoms, ticker, precision } the transaction paid, or null when this wallet did not pay it
//   vsize       its virtual size in vBytes, or 0 when unknown
//   feeInfo     /feeinfo's entry for the fee asset ({ accepted_by, nodes }), or null
//   congestion  /congestion?asset=<fee asset> (getmempoolcongestion), or null when the explorer has none

// A small rate written out in full (no "1.4e-7"), three significant digits.
function units(x) {
  if (!(x > 0)) return '0';
  const d = Math.min(14, Math.max(0, 2 - Math.floor(Math.log10(x))));
  return x.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function waitReasons({ fee, vsize, feeInfo, congestion } = {}) {
  const lines = [];
  const cong = congestion || null;
  const backlog = cong ? Math.max(1, Math.ceil(Number(cong.backlog_blocks) || 0)) : 0;
  if (fee && Number(fee.atoms) > 0) {
    const tk = fee.ticker, prec = fee.precision ?? 8;
    if (feeInfo && Number(feeInfo.accepted_by) < Number(feeInfo.nodes)) {
      lines.push('It pays its fee in ' + tk + ', which only ' + feeInfo.accepted_by + ' of the ' + feeInfo.nodes
        + ' nodes this wallet sends to accept, so it confirms only in a block one of them produces. Replace it and pay the fee in another asset to make it travel.');
    }
    if (cong && cong.accepted === false) {
      lines.push('The block producer does not accept fees in ' + tk + '. Replace it and pay the fee in an asset the producer accepts.');
    }
    if (vsize > 0 && cong) {
      const atomsKvb = Number(fee.atoms) * 1000 / vsize;
      const perVb = (a) => units(a / 1000 / Math.pow(10, prec)) + ' ' + tk + '/vB';
      const floor = Number(cong.mempoolminfee_asset_atoms_per_kvb), next = Number(cong.next_block_min_asset_atoms_per_kvb);
      if (floor > 0 && atomsKvb < floor) {
        lines.push('It pays ' + perVb(atomsKvb) + ', under the ' + perVb(floor) + ' the mempool now requires, so nodes may drop it. Speed it up.');
      } else if (cong.next_block_full && next > 0 && atomsKvb < next) {
        lines.push('It pays ' + perVb(atomsKvb) + '; blocks are full and the next one takes nothing below ' + perVb(next)
          + ', with about ' + backlog + ' block' + (backlog === 1 ? '' : 's') + ' of transactions waiting. Speed it up, or wait for the queue to clear.');
      }
    }
  } else if (cong && cong.next_block_full) {
    lines.push('Blocks are full, with about ' + backlog + ' block' + (backlog === 1 ? '' : 's')
      + ' of transactions waiting. Its sender can speed it up, and so can you, with Speed up.');
  }
  if (!lines.length) {
    lines.push(cong
      ? 'Nothing is holding it back: its fee is enough for the next block and the nodes accept its fee asset. It should confirm within a block or two.'
      : 'Waiting for a block. The explorer did not say how busy the network is, so the wallet cannot tell more.');
  }
  return lines;
}
