// A channel on the user's hosted node funded straight from the wallet, in ONE transaction.
//
// The other way to fund it (POST /channel/open) is two transactions: the wallet pays the node's
// own address, then the node's `fundchannel` spends that coin into the channel, and the user pays
// two fees and waits for both. Here the node never holds the coins:
//
//   1. POST /channel/start    `fundchannel_start` on the node: the 2-of-2 script and its address.
//   2. The wallet builds and blinds a transaction paying exactly the channel's amount, in the
//      channel's asset, to that address, in the clear. It does NOT sign it.
//   3. POST /channel/complete the unsigned transaction. This module checks it (below), then
//      `fundchannel_complete`: the peer signs the node's first commitment, the way back, while no
//      coin has moved yet. The answer carries the funding txid.
//   4. The wallet signs, checks the signed transaction's txid is that one, and broadcasts.
//      Anything going wrong before the broadcast: POST /channel/cancel, and nothing moved.
//
// On Elements the txid is fixed once the transaction is blinded (signatures go in the witness),
// which is why the transaction must be blinded before step 3 and why no output may still be
// waiting to be blinded. `fundchannel_complete` checks the script and that the inputs are segwit,
// but has no way to check an Elements output's amount and does not (seqln
// tests/sequentia/test_external_funding.py): a funding output worth less than the channel would get
// commitments that cannot spend it. So the amount and the asset are checked here, from the node's
// own decoding of the transaction, and again in the wallet before it signs.
//
// Pure functions only: the RPC calls live in lsp-server.mjs.

const BASE = 100_000_000; // decodepsbt reports every asset's amount in units of 1e-8

// Atoms from decodepsbt's amount, a JSON number with at most 8 decimals.
export function amountAtoms(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * BASE);
}

// Why `decoded` (the node's `decodepsbt` of the wallet's transaction) must not fund a channel of
// `atoms` of `asset` to `script`, or null when it may. `asset` is a display-order id, as
// decodepsbt prints them.
export function fundingProblem(decoded, { script, atoms, asset }) {
  const outs = (decoded && Array.isArray(decoded.outputs)) ? decoded.outputs : null;
  if (!outs) return 'the transaction could not be read';
  const want = String(script || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(want)) return 'the channel has no funding script';
  const toChannel = outs.filter((o) => String((o.script && o.script.hex) || '').toLowerCase() === want);
  if (toChannel.length === 0) return 'the transaction does not pay the channel';
  if (toChannel.length > 1) return 'the transaction pays the channel more than once';
  const o = toChannel[0];
  if (o.value_commitment || o.asset_commitment || o.blinding_pubkey) {
    return 'the payment to the channel is confidential; it must be in the clear';
  }
  if (String(o.asset || '').toLowerCase() !== String(asset || '').toLowerCase()) {
    return `the payment to the channel is in another asset (${o.asset || 'none'})`;
  }
  const got = amountAtoms(o.amount);
  if (got !== Number(atoms)) {
    return `the payment to the channel is ${got} atoms, not the channel's ${atoms}`;
  }
  // An output still waiting to be blinded would change the txid after the node has its
  // commitments for this one.
  if (outs.some((x) => x.blinding_pubkey && !x.value_commitment)) {
    return 'the transaction is not blinded yet';
  }
  return null;
}

// The same for a Bitcoin channel, from bitcoind's `decodepsbt` (a PSBT v0: the unsigned
// transaction is in `tx`, amounts in BTC). Bitcoin has no confidential outputs and CLN checks a
// Bitcoin funding output's amount itself; checked here too, so both chains answer alike.
export function btcFundingProblem(decoded, { script, sats }) {
  const outs = decoded && decoded.tx && Array.isArray(decoded.tx.vout) ? decoded.tx.vout : null;
  if (!outs) return 'the transaction could not be read';
  const want = String(script || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(want)) return 'the channel has no funding script';
  const toChannel = outs.filter((o) => String((o.scriptPubKey && o.scriptPubKey.hex) || '').toLowerCase() === want);
  if (toChannel.length === 0) return 'the transaction does not pay the channel';
  if (toChannel.length > 1) return 'the transaction pays the channel more than once';
  const got = amountAtoms(toChannel[0].value);
  if (got !== Number(sats)) return `the payment to the channel is ${got} sats, not the channel's ${sats}`;
  return null;
}

// The funding txid the node recorded for the channel `fundchannel_complete` answered for.
export function fundingTxidOf(channels, channelId) {
  const id = String(channelId || '').toLowerCase();
  const c = (channels || []).find((x) => String(x.channel_id || '').toLowerCase() === id);
  const txid = c && (c.funding_txid || (c.funding && c.funding.txid));
  return /^[0-9a-f]{64}$/i.test(txid || '') ? String(txid).toLowerCase() : null;
}
