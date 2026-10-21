// The device's daily Lightning payment limit, in the reference unit.
//
// The device signer approves a payment only within what its limit leaves for the day. Its default
// is one value in the reference unit (the unit the node's fee exchange rates are quoted in, the
// price feed's US dollar on the testnet), 1,000 a day, held in each asset at that asset's rate, so
// it is worth the same in every asset and privileges none. The device needs the rates; the wallet
// gives them from its own feeds (/feerates, and /prices for Bitcoin, which the node's table does
// not list), never from the hosted node.

export const LN_DAILY_LIMIT_REFERENCE = 1000;

// The rates the device converts its limit at: { <asset id>: rate, btc: rate }, each in the node's
// convention (reference atoms per 10^8 atoms). `rateOf(hex)` is the node's published rate for an
// asset (or nothing); `btcUsd` Bitcoin's price in the reference unit.
export function lnRatesFor(hexes, rateOf, btcUsd) {
  const out = {};
  for (const h of new Set(hexes || [])) {
    if (!/^[0-9a-f]{64}$/i.test(String(h))) continue;
    const r = Number(rateOf(h));
    if (Number.isSafeInteger(r) && r > 0) out[String(h).toLowerCase()] = r;
  }
  const b = Number(btcUsd);
  if (Number.isFinite(b) && b > 0) out.btc = Math.round(b * 1e8);
  return out;
}

// The plain words for a payment the device declined over its limit, or null for any other failure.
export function lnLimitRefusal(message, reference = LN_DAILY_LIMIT_REFERENCE) {
  if (!/Your device declined|invoice was declined/i.test(String(message || ''))) return null;
  return 'This payment is over the daily limit your device sets for Lightning payments (about '
    + Number(reference).toLocaleString('en-US') + ' USD a day). Nothing was sent.';
}
