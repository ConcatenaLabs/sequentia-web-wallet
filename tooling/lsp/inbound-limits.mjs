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

// What the LP funds to sell `amount` atoms of room to receive: the amount plus the share CLN holds
// back as reserve and commitment fees, plus a flat margin. provisionInbound funds exactly this.
export function inboundFundAtoms(amount, { headroomBps, reserve }) {
  return Math.ceil(Number(amount) * (1 + Number(headroomBps) / 10000)) + Number(reserve);
}

// The most room to receive `available` atoms of the LP can fund, the inverse of inboundFundAtoms.
export function inboundRoomFundable(available, { headroomBps, reserve }) {
  const net = Number(available) - Number(reserve);
  if (!(net > 0)) return 0;
  let room = Math.floor(net / (1 + Number(headroomBps) / 10000));
  while (room > 0 && inboundFundAtoms(room, { headroomBps, reserve }) > available) room--;
  return room;
}

// The LP's free on-chain atoms of `assetId` in a CLN listfunds answer: confirmed and unreserved
// outputs only, the ones fundchannel spends. The policy asset rides untagged, so untagged outputs
// count under `policyHex`.
export function lpFreeAtoms(listfunds, assetId, policyHex = '') {
  const want = String(assetId || '').toLowerCase();
  let atoms = 0;
  for (const o of (listfunds && listfunds.outputs) || []) {
    if (o.status !== 'confirmed' || o.reserved) continue;
    const a = String(o.asset || '').toLowerCase() || String(policyHex || '').toLowerCase();
    if (a !== want) continue;
    atoms += Math.round(Number(o.amount_msat ?? 0) / 1000);
  }
  return atoms;
}

// Room the user's node already has from the LP, enough for `needMsat`: a channel that is open
// (CHANNELD_NORMAL), else one still opening for that much (AWAITING_LOCKIN and the like; a channel
// closing or closed, CLOSINGD_* and AWAITING_UNILATERAL included, is not room). `channels` is the
// user node's listpeerchannels. One rule for the quote and the open: the quote refuses before any
// fee is paid for room the open would not add.
// Returns { channel, pending } or null.
export function roomAlreadyThere(channels, lpId, needMsat) {
  const from = (channels || []).filter((c) => lpId && c.peer_id === lpId && Number(c.receivable_msat || 0) >= needMsat);
  const ready = from.find((c) => c.state === 'CHANNELD_NORMAL');
  if (ready) return { channel: ready, pending: false };
  const opening = from.find((c) => c.state !== 'CHANNELD_NORMAL' && !/CLOS|ONCHAIN|UNILATERAL|FUNDING_SPEND/i.test(String(c.state || '')));
  return opening ? { channel: opening, pending: true } : null;
}

// A prepaid fee this node paid for room in `assetId` whose channel the service has not opened yet
// (the LP was short of the asset, or the purchase never got that far): { fee_txid, amount, months },
// the largest such, or null. The quote hands it back, so a wallet uses that fee instead of paying
// again, whatever device or address it buys from: the record a wallet keeps lives in one browser's
// storage only, and two fees for one 500 USDX room were paid that way.
export function paidWaitingFee(fees, nodeKey, assetId) {
  const asset = String(assetId || '').toLowerCase();
  let best = null;
  for (const [txid, u] of (fees instanceof Map ? fees : new Map(Object.entries(fees || {})))) {
    if (!u || u.opened_at || String(u.node_key || '') !== String(nodeKey || '') || String(u.asset || '').toLowerCase() !== asset) continue;
    if (!best || Number(u.amount) > best.amount) best = { fee_txid: txid, amount: Number(u.amount), months: u.months ?? null };
  }
  return best;
}

// What a fee transaction paid the LP in `assetId`, in atoms, read from a CLN listfunds answer that
// lists spent outputs too: the LP may already have spent the fee (funding a channel, say) by the time
// the wallet asks for its room, and a fee spent is still a fee paid. The policy asset rides untagged,
// so untagged outputs count under `policyHex`, as in lpFreeAtoms.
export function feePaidAtoms(listfunds, txid, assetId, policyHex = '') {
  const want = String(txid || '').toLowerCase(), asset = String(assetId || '').toLowerCase();
  let atoms = 0;
  for (const o of (listfunds && listfunds.outputs) || []) {
    if (String(o.txid || '').toLowerCase() !== want) continue;
    const a = String(o.asset || o.asset_id || '').toLowerCase() || String(policyHex || '').toLowerCase();
    if (a !== asset) continue;
    atoms += Math.floor(Number(o.amount_msat != null ? Number(o.amount_msat) / 1000 : (o.value || 0)));
  }
  return atoms;
}

// A room's price moves with the asset's exchange rate, and a fee is paid at the price quoted to the
// node before it paid, then seen by the service only once it confirms, or days later when the wallet
// comes back. Charging today's price instead refused a fee paid in full a few hours earlier, forever:
// 2.573 tSEQ paid for 100 tSEQ of room, then 2.722 asked once the rate fell (21/10/2026).
//
// The lowest price quoted to this node for this asset and term, for at least this much room, within
// `holdMs`; null when there is none. `held` is a list of { node_key, asset, amount, months, due, at }.
export function heldFeeDue(held, { nodeKey, assetId, amount, months, now = Date.now(), holdMs }) {
  const asset = String(assetId || '').toLowerCase();
  let best = null;
  for (const h of held || []) {
    if (!h || String(h.node_key || '') !== String(nodeKey || '') || String(h.asset || '').toLowerCase() !== asset) continue;
    if (Number(h.months) !== Number(months) || Number(h.amount) < Number(amount) || !(now - Number(h.at) <= holdMs)) continue;
    if (best == null || Number(h.due) < best) best = Number(h.due);
  }
  return best;
}

// The least a fee payment may be to pay `due` today, or `heldDue` as quoted earlier: the lower of the
// two, less `toleranceBps` for a fee paid at a price the service no longer holds (quoted elsewhere,
// or before quotes were held), so a rate that moved a little does not turn a paid fee into a debt.
export function feeDueAccepted(due, heldDue, toleranceBps = 0) {
  const base = heldDue == null ? Number(due) : Math.min(Number(due), Number(heldDue));
  return Math.ceil(base * (10000 - Math.max(0, Number(toleranceBps) || 0)) / 10000);
}
