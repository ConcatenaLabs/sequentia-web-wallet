// PARTIAL FILLS on the pure-LN rail (xpln), LSP side.
//
// The Go protocol has carried asset-side slices end-to-end for a while
// (seqob-cli xpln -take-asset-msat: "the BTC side is derived from the signed
// offer's ratio and required exactly"; the maker re-rests the remainder) — the
// LSP was the layer that never passed the slice through. These two helpers are
// that pass-through, kept pure so tooling/lsp/pureln-partial.test.mjs can pin
// them without booting the server.
//
//   • takeAssetMsatArgs(take_atoms) -> the extra xpln argv for a requested slice.
//   • partialFields(out)            -> the response fields for a PARTIAL settle.

// The wallet's wire unit for the slice is the ASSET's own atoms (integer,
// `take_atoms` in the POST /swap body); xpln wants msat, so the flag value is
// take_atoms * 1000 — computed in BigInt, because a max-supply slice
// (2.1e15 atoms) times 1000 exceeds 2^53 and a Number multiply would silently
// round the amount xpln is told to take. 0 / absent = the whole offer: the argv
// stays byte-identical to the classic lift.
export function takeAssetMsatArgs(take_atoms) {
  if (take_atoms == null || take_atoms === 0) return { ok: true, args: [] };
  const n = Number(take_atoms);
  if (!Number.isSafeInteger(n) || n < 0) {
    return { ok: false, error: 'take_atoms must be a non-negative integer (the asset-side slice, in the asset\'s own atoms)' };
  }
  if (n === 0) return { ok: true, args: [] };
  return { ok: true, args: ['-take-asset-msat', (BigInt(n) * 1000n).toString()] };
}

// xpln reports a partial settle on its own line after the SETTLED line:
//   "  PARTIAL fill: X of the offer's Y atoms; Z remain resting"
// Parse it into response fields so the wallet learns the remainder stayed on the
// book. A whole fill prints no such line -> {} (the response shape is unchanged).
export function partialFields(out) {
  const m = String(out || '').match(/PARTIAL fill:\s*(\d+) of the offer's (\d+) atoms;\s*(\d+) remain resting/i);
  if (!m) return {};
  return { partial: true, remaining_atoms: Number(m[3]) };
}
