// What a Sequentia or Bitcoin node's refusal of a transaction means, in a sentence the user can act
// on. The node answers a broadcast with a reject code ("bad-txns-inputs-missingorspent", "dust",
// "min relay fee not met"), usually inside a longer message ("…returned HTTP 400: <code>"); shown as
// it is, the code says nothing to anyone who has not read validation.cpp.
//
// nodeRejectText(message) answers the sentence for the first code it finds, or null when the
// message carries none, so the caller's own handling applies. Codes that mean the transaction is
// already in the mempool or a block are not refusals and answer null. Each sentence says whether
// anything was sent and what to do next. index.html's prettyErr asks here first.

// Most specific first: several codes can share a message, and the first match wins.
const RULES = [
  [/bad-txns-inputs-missingorspent|bad-txns-spends-conflicting-tx|missing-inputs/i,
    'A coin this transaction spends has already been spent, most likely by another payment from this wallet that it had not seen yet. Nothing was sent: refresh and try again.'],
  [/txn-mempool-conflict/i,
    'A coin this transaction spends is already spent by a transaction still waiting for a block. Nothing was sent: wait for that one to confirm, or speed it up, then try again.'],
  [/bip125-replacement-disallowed/i,
    'The transaction this one would replace does not allow replacement. Nothing was sent: wait for it to confirm, or speed it up with a child payment instead.'],
  [/too-long-mempool-chain/i,
    'Too many of this wallet’s transactions are waiting in a row for a block. Nothing was sent: wait for the next block, then try again.'],
  [/non-BIP68-final|non-final/i,
    'This transaction is time-locked to a later block or time, so the network does not accept it yet. Nothing was sent: try again later.'],
  [/bad-txns-asset-frozen/i,
    'This asset is frozen by its supervisor, so it cannot move right now. Nothing was sent.'],
  [/supervision-not-active|bad-txns-supervision/i,
    'The asset’s supervision rules refuse this transfer. Nothing was sent: check the asset’s terms with its issuer.'],
  [/bad-txns-no-fee|bad-txns-multiple-fee-assets/i,
    'A transaction must pay its fee in exactly one asset. Nothing was sent: choose a single fee asset and try again.'],
  [/mempool full/i,
    'The network is too busy to take this transaction at its fee. Nothing was sent: raise the fee rate and try again.'],
  [/min relay fee not met|mempool min fee not met|insufficient fee/i,
    'The fee is too low for the network to accept, or the node does not accept that fee asset. Nothing was sent: raise the fee rate, or pay the fee in another asset, and try again.'],
  [/\bdust\b/i,
    'An amount in this transaction is too small for the network to relay. Nothing was sent: send a larger amount.'],
  [/tx-size-small/i,
    'This transaction is too small for the network to relay. Nothing was sent: send a larger amount.'],
  [/bad-txns-premature-spend-of-coinbase/i,
    'It spends a block reward that is not mature yet. Nothing was sent: try again once it has more confirmations.'],
];

// Any other reject code: still a refusal the user should see as one, never as the raw code.
const OTHER_CODE = /\b(bad-[a-z0-9-]+|txn-[a-z0-9-]+|non-mandatory-script-verify-flag|mandatory-script-verify-flag-failed|scriptpubkey|multi-op-return)\b/i;
const NOT_A_REFUSAL = /txn-already-in-mempool|txn-already-known|txn-same-nonwitness-data-in-mempool|already in (block|the mempool)/i;

export function nodeRejectText(message) {
  const m = String(message || '');
  if (!m || NOT_A_REFUSAL.test(m)) return null;
  for (const [re, text] of RULES) if (re.test(m)) return text;
  if (OTHER_CODE.test(m)) return 'The network refused this transaction, so nothing was sent. Refresh and try again; if it is refused again, the wallet’s log in the browser console has the reason.';
  return null;
}
