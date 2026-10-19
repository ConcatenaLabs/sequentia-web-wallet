// How much inbound capacity in an asset the LSP sells, and its smallest fee, sized by what the asset
// is worth rather than by its atoms.
//
// The limits used to be atom counts shared with Bitcoin: 100,000 to 10,000,000 and a 1,000-atom
// fee floor. For BTC that is 0.001 to 0.1 BTC. For an asset with eight decimals it is 0.001 to 0.1
// of the asset: a tenth of a USDX of capacity to receive, and a fee floor worth nothing. So an
// asset's limits are set in the reference unit of the node's fee exchange rates (the unit the
// wallet shows values in) and turned into the asset's atoms through its rate.
//
// The rate R of an asset is the reference value of one whole unit of it, times 1e8
// (getfeeexchangerates): `atoms` of the asset are worth atoms * R / 1e8 reference atoms, and a
// reference unit is 1e8 reference atoms. Pure: the RPC call lives in lsp-server.mjs.

const SCALE = 100_000_000;

// The rate the node's table gives `assetId`, keyed by id or by label; null when it gives none.
export function rateOf(rates, assetId, label) {
  if (!rates || typeof rates !== 'object') return null;
  const id = String(assetId || '').toLowerCase();
  for (const [k, v] of Object.entries(rates)) {
    const key = String(k).toLowerCase();
    if (key === id || (label && key === String(label).toLowerCase())) {
      const r = Number(v);
      return Number.isFinite(r) && r > 0 ? r : null;
    }
  }
  return null;
}

// The inbound limits of an asset with rate `rate`, in its own atoms: { minAmount, maxAmount,
// minAtoms } (minAtoms is the fee floor), from limits in reference atoms. Null without a rate,
// for the caller to keep its atom limits.
export function assetInboundLimits(rate, { refMin, refMax, refFeeFloor }) {
  const r = Number(rate);
  if (!(Number.isFinite(r) && r > 0)) return null;
  const atoms = (ref, round) => Math.max(1, round((Number(ref) * SCALE) / r));
  return {
    minAmount: atoms(refMin, Math.ceil),
    maxAmount: atoms(refMax, Math.floor),
    minAtoms: atoms(refFeeFloor, Math.ceil),
  };
}

// A prepaid fee pays for one purchase. The service records which purchase each fee transaction
// paid for (`prior`: { node_key, asset, amount }) and accepts the same transaction again only to
// retry that purchase, the same node and asset for no more capacity: a wallet retries while the
// channel is opening. Anything else is a second purchase on one payment. Returns the reason to
// refuse, or null.
export function feeReuseProblem(prior, { nodeKey, assetId, amount }) {
  if (!prior) return null;
  const same = String(prior.node_key || '') === String(nodeKey || '')
    && String(prior.asset || '').toLowerCase() === String(assetId || '').toLowerCase()
    && Number(amount) <= Number(prior.amount);
  return same ? null : 'that fee payment already paid for another purchase';
}
