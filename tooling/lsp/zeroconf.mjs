// Room to receive BTC that is usable at once, and its fee paid over Lightning.
//
// A hosted BTC node takes a channel once its funding has a block (`funding-confirms=1`), so room
// the service opens during a trade used to wait for a testnet4 block. zeroconf-from-lp.py, next to
// this file, makes the node accept a zero-confirmation channel from one peer only: the service's
// BTC LP (INBOUND_BTC_LP_RPC, CHANNEL_PEER_BTC_PROVISIONED). Until that funding has a block the
// node trusts the service not to double-spend it; no other peer is trusted that way.
//
// The plugin reaches a node two ways: a new BTC node's config names it (provision.mjs, `extra`),
// a node already running is given it by `plugin start` before the LP opens room to it, and every
// boot writes it into the config (`bootLines`) so it survives a restart.
//
// The fee for room opened during a trade is the deferred debt /channel/inbound records. Once the
// trade has paid the user, the wallet pays that debt over Lightning: the LP invoices it under a label
// naming the node and the asset, and the debt is cleared by what the LP's own invoice says was paid.
//
// Pure: lsp-server.mjs and provision.mjs do the I/O.

export const ROOM_FEE_LABEL_PREFIX = 'room-fee';

// The config lines that load the plugin for `peerId`, or none when either is missing.
export function zeroconfConfigLines(pluginPath, peerId) {
  const p = String(pluginPath || '').trim(), id = String(peerId || '').trim().toLowerCase();
  if (!p || !/^0[23][0-9a-f]{64}$/.test(id)) return [];
  return [`plugin=${p}`, `zeroconf-peer=${id}`];
}

// `text` (a lightningd config) with each of `lines` present: a `plugin=` line is added when that
// exact line is missing; any other `key=value` replaces the line with that key, or is appended.
export function ensureConfigLines(text, lines) {
  let out = String(text || '');
  if (out && !out.endsWith('\n')) out += '\n';
  for (const line of lines || []) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const rows = out.split('\n');
    if (key === 'plugin') {
      if (!rows.includes(line)) out += line + '\n';
      continue;
    }
    const at = rows.findIndex((r) => r.startsWith(key + '='));
    if (at >= 0) { rows[at] = line; out = rows.join('\n'); }
    else out += line + '\n';
  }
  return out;
}

// Whether `plugin list` shows the plugin at `pluginPath` running.
export function zeroconfRunning(pluginList, pluginPath) {
  const want = String(pluginPath || '');
  const base = want.split('/').pop();
  return ((pluginList && pluginList.plugins) || []).some((p) => {
    const n = String((p && p.name) || '');
    return p && p.active !== false && (n === want || (base && n.split('/').pop() === base));
  });
}

// The LP's invoice label for a room fee: the node and the asset it is owed for, and when.
export function roomFeeLabel(nodeKey, assetId, now) {
  return [ROOM_FEE_LABEL_PREFIX, String(nodeKey || '').toLowerCase(), String(assetId || 'BTC'), Number(now) || 0].join('|');
}
export function parseRoomFeeLabel(label) {
  const parts = String(label || '').split('|');
  if (parts.length !== 4 || parts[0] !== ROOM_FEE_LABEL_PREFIX) return null;
  return { nodeKey: parts[1], assetId: parts[2], at: Number(parts[3]) || 0 };
}

// What the LP's `listinvoices` says of a room-fee payment under `paymentHash`: paid for this node
// and asset, and how many sat. Anything else (unpaid, another node's label, another asset, a label
// that is not a room fee) clears nothing.
export function roomFeePaid(listinvoices, { nodeKey, assetId, paymentHash }) {
  const h = String(paymentHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return { paid: false, reason: 'payment_hash must be 32 bytes of hex' };
  const inv = ((listinvoices && listinvoices.invoices) || []).find((x) => String((x && x.payment_hash) || '').toLowerCase() === h);
  if (!inv) return { paid: false, reason: 'the service has no room-fee invoice under that hash' };
  const lab = parseRoomFeeLabel(inv.label);
  if (!lab || lab.nodeKey !== String(nodeKey || '').toLowerCase() || lab.assetId !== String(assetId || 'BTC')) {
    return { paid: false, reason: 'that invoice is not a room fee for this node' };
  }
  if (inv.status !== 'paid') return { paid: false, reason: `that invoice is ${inv.status || 'not paid'}` };
  const msat = Number(inv.amount_received_msat ?? inv.amount_msat ?? 0);
  return { paid: true, sat: Math.floor(msat / 1000), label: inv.label };
}
