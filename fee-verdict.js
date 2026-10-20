import { rateText } from './fee-panel.js';

// What Send says about the fee before anything is signed, worded as Sequentia Qt's fee selector
// (src/qt/feeselectionwidget.cpp) says it, from what the nodes the wallet sends to report.
//
// feeAssetVerdict: three different things can be wrong with a fee asset and they are not the same
// warning. Worst first:
//   'no'   the nodes do not accept it: the wallet's own nodes refuse the transaction before it
//          reaches a block producer. Listed at rate 0 and not listed are the same refusal but not
//          the same mistake, so they are said differently.
//   'warn' the nodes accept it, but the wider network may not: it is not published on the Asset
//          Registry, or has no market price, the two inputs every price server builds its list
//          from. It may then confirm only in a block of a producer that accepts it, and the remedy
//          is replacing it later with the fee in another asset.
//   'ok'   nothing is wrong. Not being able to show the fee in a currency is not a problem with
//          the fee.
// No asset is exempt from these questions, the native one included.
//
// rateNote: what a typed fee rate clears, against the producer's view of the next block
// (/congestion?asset=, getmempoolcongestion converted into the fee asset's atoms per kvB).

// info: the explorer's /feeinfo entry ({ accepted_by, listed_by, nodes, registry_listed,
// market_price }) or null when the explorer has none; accepted: whether /feerates prices it (the
// rates every node the wallet sends to accepts); price: its value in the reference currency, for
// one whole unit, as text, or ''.
export function feeAssetVerdict({ ticker: t, info, accepted, price }) {
  const fi = info || null;
  const allAccept = fi ? Number(fi.accepted_by) >= Number(fi.nodes) && Number(fi.nodes) > 0 : !!accepted;
  if (!allAccept) {
    if (fi && Number(fi.accepted_by) > 0) {
      return { state: 'no', text: 'Only ' + fi.accepted_by + ' of the ' + fi.nodes + ' nodes this wallet sends to accept ' + t
        + ' for fees, and one that refuses it would drop the transaction. Pick another asset.' };
    }
    const why = fi && Number(fi.listed_by) > 0
      ? 'The nodes this wallet sends to list ' + t + ' at a rate of zero, which refuses it.'
      : t + ' is not on the fee list of the nodes this wallet sends to.';
    return { state: 'no', text: why + ' The transaction would be rejected before it reached a block producer. Pick another asset.' };
  }
  const unpublished = fi ? !fi.registry_listed : false;
  const unpriced = fi ? !(Number(fi.market_price) > 0) : !price;
  if (unpublished || unpriced) {
    const why = unpublished
      ? t + ' is not published on the Asset Registry, so the price servers other block producers run will not discover it.'
      : 'No published market price for ' + t + ', so other block producers’ price servers cannot value it.';
    return { state: 'warn', text: why + ' The nodes this wallet sends to accept it, so the payment may confirm only in a block one of their producers makes. Every send can be replaced: if it waits, replace it and pay the fee in another asset.' };
  }
  return { state: 'ok', text: 'Accepted for fees by the nodes this wallet sends to' + (price ? '; 1 ' + t + ' ' + price : '') + '. The fee is shown in both before signing.' };
}

// A rate in whole units per vByte, written out in full (no "1.4e-7").
function units(x) {
  if (!(x > 0)) return '0';
  const d = Math.min(14, Math.max(0, 2 - Math.floor(Math.log10(x))));
  return x.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// unitsPerVb: the rate typed, in whole units of the fee asset per vByte; precision and ticker of
// that asset; congestion: /congestion?asset=<it>, or null when the explorer has none. Returns null
// when there is nothing to say, else { level: 'no'|'warn'|'ok', text, block } where block means the
// network would refuse the transaction outright, so Send should not build it.
export function rateNote({ unitsPerVb, precision, ticker: t, congestion: c }) {
  if (!(unitsPerVb > 0) || !c) return null;
  const typed = unitsPerVb * Math.pow(10, precision ?? 8) * 1000;   // atoms per kvB
  const perVb = (atomsKvb) => rateText(atomsKvb, { ticker: t, precision: precision ?? 8 }, null, '');
  const floor = Number(c.mempoolminfee_asset_atoms_per_kvb), next = Number(c.next_block_min_asset_atoms_per_kvb);
  if (c.accepted === false) {
    return { level: 'no', block: true, text: 'The block producer does not accept fees in ' + t + '. Pick another fee asset.' };
  }
  if (floor > 0 && typed < floor) {
    return { level: 'no', block: true, text: 'Below ' + perVb(floor) + ' the network will not relay this transaction at all. Raise the rate, or choose Recommended.' };
  }
  const backlog = Math.max(1, Math.ceil(Number(c.backlog_blocks) || 0));
  if (c.next_block_full && next > 0) {
    if (typed < next) {
      return { level: 'warn', block: false, text: 'This clears the relay minimum, but blocks are full and the next one takes nothing below ' + perVb(next)
        + ', with about ' + backlog + ' block' + (backlog === 1 ? '' : 's') + ' of transactions waiting. Yours will wait until the queue clears.' };
    }
    return { level: 'ok', block: false, text: 'Blocks are full, with about ' + backlog + ' block' + (backlog === 1 ? '' : 's') + ' of transactions waiting. At this rate yours is ahead of them.' };
  }
  return { level: 'ok', block: false, text: 'The next block has room for it at this rate.' };
}
