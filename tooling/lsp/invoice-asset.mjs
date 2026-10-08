// invoice-asset.mjs — the asset rules the LSP applies when a hosted node makes or pays a BOLT11
// invoice. Pure; lsp-server.mjs calls these at /node/receive, /node/invoice and /node/pay.
//
// An invoice on a Sequentia network names the asset it is paid in (its `a` field). The node pays one
// only in that asset and refuses `pay asset=` naming another, so a hosted node, which holds exactly
// one asset, can pay only invoices in its own. The LSP checks that before it asks the node, so the
// user hears which asset the invoice wants instead of a routing error.
//
// When a hosted node makes an invoice, the node refuses an asset in which it has no channel open or
// opening unless told `allow_unfunded=true`: an invoice nobody could pay. A hosted node's inbound
// channel is the LSP's to open, and the wallet asks for it just before the invoice (POST
// /channel/inbound); that open can still be in hand when the invoice is made, so the LSP makes it
// with `allow_unfunded=true` and the channel follows.
import { decodeBolt11 } from '../../bolt11.js';

const HEX64 = /^[0-9a-f]{64}$/i;

// The asset a hosted node record holds: its Sequentia asset id (lowercase), or null for a Bitcoin node.
export function hostedNodeAsset(rec) {
  if (!rec || (rec.chain || 'seq') === 'btc') return null;
  return HEX64.test(String(rec.asset_id || '')) ? String(rec.asset_id).toLowerCase() : null;
}

// The asset an invoice is paid in: what the node's `decode` reports, else what the invoice's own `a`
// field reads (a node that predates the field reports none). null for a Bitcoin invoice.
export function invoiceAsset(decoded, bolt11) {
  const a = decoded && decoded.asset ? String(decoded.asset).toLowerCase() : null;
  if (a) return a;
  const d = decodeBolt11(bolt11, { checksum: false });
  return d.ok ? d.asset : null;
}

// Whether a hosted node may pay this invoice: { ok: true } or { ok: false, error } (answered 400,
// before anything is sent). label(id) names an asset for the user.
export function payAssetVerdict({ rec, decoded, bolt11, label = (x) => x }) {
  const nodeAsset = hostedNodeAsset(rec);
  const want = invoiceAsset(decoded, bolt11);
  const btcNode = (rec && rec.chain) === 'btc';
  if (btcNode) {
    if (want) return { ok: false, error: `this invoice is paid in ${label(want)} on Sequentia; your Bitcoin Lightning node cannot pay it` };
    return { ok: true };
  }
  if (!want) {
    const d = decodeBolt11(bolt11, { checksum: false });
    if (d.ok && d.chain === 'btc') return { ok: false, error: `this is a Bitcoin invoice; pay it from your Bitcoin Lightning node, not your ${label(nodeAsset)} one` };
    return { ok: true };   // the node decoded it and named no asset (it predates the field); it judges
  }
  if (want !== nodeAsset) {
    return { ok: false, error: `this invoice is paid in ${label(want)}; your hosted node holds ${label(nodeAsset)}. Pay it from your ${label(want)} Lightning node.` };
  }
  return { ok: true };
}

// The keyword arguments a hosted Sequentia node's `invoice` takes beyond amount, label and
// description: its asset, and allow_unfunded=true (the LSP opens the inbound channel). A Bitcoin
// node names no asset.
export function hostedInvoiceArgs(rec) {
  const a = hostedNodeAsset(rec);
  return a ? [`asset=${a}`, 'allow_unfunded=true'] : [];
}
