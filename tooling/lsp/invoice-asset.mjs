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

// The keyword arguments a hosted node's `invoice` takes beyond amount, label and description.
// A Sequentia node names its asset, with allow_unfunded=true (the LSP opens the inbound channel);
// a Bitcoin node names no asset. Both pass exposeprivatechannels=true: the room to receive the LSP
// sells is an unannounced channel, and a node with a channel flagged for announcement leaves every
// unannounced one out of its route hints. Its own channels are not announced yet (or wait on the
// anchor's burial), so the invoice carried no hint at all and no other wallet's node could reach
// it. The node's only peer is the LSP, so the hint tells a payer nothing the LSP does not route.
export function hostedInvoiceArgs(rec) {
  const a = hostedNodeAsset(rec);
  const btc = !!rec && rec.chain === 'btc';
  if (!a && !btc) return [];
  return [...(a ? [`asset=${a}`, 'allow_unfunded=true'] : []), 'exposeprivatechannels=true'];
}

// Why a hosted node's payment found no way to the payee, for the page to say in words: the
// payee's invoice offers no way in (no route hint, and the payee is in no gossip the payer has)
// is 'payee_cannot_receive': the payee has no room to receive this amount over Lightning yet.
// Any other failure to find a route is 'no_route'. Anything else is null (the error says it).
export function payFailureReason({ decoded, error }) {
  const m = String(error || '');
  const hints = decoded && Array.isArray(decoded.routes) ? decoded.routes.length : 0;
  if (/not reachable directly and all routehints were unusable/i.test(m) && hints === 0) return 'payee_cannot_receive';
  if (/no route|route not found|failed to find a route|routehints were unusable|not reachable|WIRE_UNKNOWN_NEXT_PEER/i.test(m)) return 'no_route';
  return null;
}
