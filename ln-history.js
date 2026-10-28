// ln-history.js: the History's Lightning card, as rows. No DOM, no fetch.
//
// The rows come from the wallet's own hosted nodes (GET /node/history, one answer per node): every
// payment a node received or made, with its asset, amount, time and payment hash. A swap moves under
// one hash on both legs, so the legs of one hash are one row: "Swapped 10 USDX for 9.2 EURX over
// Lightning", both amounts shown. A swap whose other leg settled on-chain (a sub-asset buy or sell, a
// bridged leg) is named by the swap note the wallet left on the node when it settled (the note's pay and
// recv), so it reads the same on any device that opens the wallet. A leg with no partner, no note and
// no trade in the log is a plain payment row; one hash is never two rows.
//
// The browser's trade log (lnTradeHistory in swap.js) only adds to a row the node already gives: the
// trade's own title and the leg that settled on-chain, when no note says it. A trade with no settled
// leg on any node (in flight, refunded, failed, or its node not answering now) is shown from the log
// alone, marked with its status.

import { sha256 } from './btc.js';

const HEX64 = /^[0-9a-f]{64}$/;
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

// The payment hash a trade of the log settled under: recorded on it, the hash of the preimage it
// kept, or carried in its id ('buy:', 'sell:', 'bridge:' + hash; a pure-Lightning take's 'ln:' id
// holds the preimage when the service answered no hash, which the preimage case reads first).
export function tradeHash(t) {
  if (!t) return null;
  const h = String(t.payment_hash || '').toLowerCase();
  if (HEX64.test(h)) return h;
  const p = String(t.preimage || '').toLowerCase();
  if (HEX64.test(p)) { try { return toHex(sha256(fromHex(p))); } catch {} }
  const m = /^(?:ln|buy|sell|bridge):([0-9a-f]{64})$/i.exec(String(t.id || ''));
  if (m) return m[1].toLowerCase();
  return null;
}

const atomsOf = (x) => { try { return BigInt(String(x)); } catch { return null; } };
const legOf = (l, dir, from) => {
  if (!l) return null;
  const a = String(l.asset || '').toLowerCase();
  const asset = a === 'btc' ? 'btc' : (HEX64.test(a) ? a : null);
  const atoms = atomsOf(l.atoms);
  if (!asset || atoms == null || atoms <= 0n) return null;
  return { dir, asset, atoms, rail: l.rail === 'chain' ? 'chain' : 'ln', from };
};

// nodes: [{ asset: 'btc' | <hex>, items: [/node/history item] }]; trades: the log's Lightning trades.
// Returns rows, newest first: { kind: 'swap'|'in'|'out', hash, at (ms), title, legs: [{ dir, asset,
// atoms (BigInt), rail, from: 'node'|'note'|'log' }], fee: { asset, atoms } | null, status, logOnly }.
export function lnHistoryRows({ nodes = [], trades = [] } = {}) {
  const groups = new Map();
  for (const n of nodes) {
    const nodeAsset = n && n.asset ? String(n.asset).toLowerCase() : null;
    for (const it of (n && n.items) || []) {
      const h = String((it && it.payment_hash) || '').toLowerCase();
      if (!HEX64.test(h) || (it.dir !== 'in' && it.dir !== 'out')) continue;
      const g = groups.get(h) || { items: [], note: null };
      const asset = String(it.asset || nodeAsset || '').toLowerCase() || null;
      // The same movement listed twice (one node asked twice) is one leg.
      if (!g.items.some((x) => x.dir === it.dir && x.asset === asset)) g.items.push({ ...it, asset });
      if (!g.note && it.note) g.note = it.note;
      groups.set(h, g);
    }
  }
  const byHash = new Map();
  for (const t of trades) { const h = tradeHash(t); if (h && !byHash.has(h)) byHash.set(h, t); }

  const rows = [];
  for (const [hash, g] of groups) {
    const t = byHash.get(hash) || null;
    const legs = [];
    let fee = null;
    for (const it of g.items) {
      const atoms = BigInt(Math.floor(Number(it.amount_msat || 0) / 1000));
      if (!it.asset || atoms <= 0n) continue;
      legs.push({ dir: it.dir, asset: it.asset, atoms, rail: 'ln', from: 'node' });
      if (it.dir === 'out' && Number(it.fee_msat) >= 1000) fee = { asset: it.asset, atoms: BigInt(Math.floor(Number(it.fee_msat) / 1000)) };
    }
    if (!legs.length) continue;
    // The other leg of a swap, when no node of the wallet holds it: from the note, else the log.
    for (const [src, rec] of [['note', g.note], ['log', t]]) {
      if (!rec) continue;
      for (const [dir, l] of [['out', rec.pay], ['in', rec.recv]]) {
        if (legs.some((x) => x.dir === dir)) continue;
        const leg = legOf(l, dir, src);
        if (leg) legs.push(leg);
      }
    }
    const isSwap = legs.some((l) => l.dir === 'out') && legs.some((l) => l.dir === 'in');
    const atS = Math.max(0, ...g.items.map((i) => Number(i.at || 0)));
    const at = atS > 0 ? atS * 1000 : ((g.note && g.note.at) ? g.note.at * 1000 : ((t && (t.ts || t.at)) || 0));
    const desc = (g.items.find((i) => i.description) || {}).description || '';
    if (isSwap) {
      rows.push({ kind: 'swap', hash, at, legs: legs.sort((a, b) => (a.dir === 'out' ? -1 : 1) - (b.dir === 'out' ? -1 : 1)),
        title: (g.note && g.note.title) || (t && t.title) || '', fee, status: '', logOnly: false });
    } else {
      const l = legs[0];
      rows.push({ kind: l.dir, hash, at, legs: [l], title: desc, fee, status: '', logOnly: false });
    }
  }
  // A trade of the log that no node shows a settled leg for: from the log alone, never twice.
  const shown = new Set(groups.keys());
  for (const t of trades) {
    const h = tradeHash(t);
    if (h && shown.has(h)) continue;
    if (h) shown.add(h);
    const legs = [legOf(t.pay, 'out', 'log'), legOf(t.recv, 'in', 'log')].filter(Boolean);
    rows.push({ kind: 'swap', hash: h, at: t.ts || t.at || 0, legs, title: t.title || '', fee: null,
      status: t.status || '', logOnly: true });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

// One line naming the swap from its legs: "Swapped 10 USDX for 9.2 EURX", and in developer mode
// (`dev`) "… over Lightning" when both legs are Lightning. fmt(leg) -> "10 USDX".
export function swapLine(row, fmt, dev = false) {
  const pay = row.legs.filter((l) => l.dir === 'out'), recv = row.legs.filter((l) => l.dir === 'in');
  if (!pay.length || !recv.length) return row.title || 'Swap';
  const s = 'Swapped ' + pay.map(fmt).join(' + ') + ' for ' + recv.map(fmt).join(' + ');
  return (dev && row.legs.every((l) => l.rail === 'ln')) ? s + ' over Lightning' : s;
}
// A plain row's line when the node gave no description: "Received" / "Sent" in default mode.
export function plainLine(row, dev = false) {
  if (row.title) return row.title;
  return row.kind === 'in' ? (dev ? 'Received over Lightning' : 'Received') : (dev ? 'Paid over Lightning' : 'Sent');
}
// Where each leg settled, for the line under it: "BTC on-chain · GOLD over Lightning".
export function railLine(row, tickerOf) {
  if (row.legs.every((l) => l.rail === 'ln')) return '';
  return row.legs.map((l) => tickerOf(l.asset) + (l.rail === 'chain' ? ' on-chain' : ' over Lightning')).join(' · ');
}

export const __test__ = { legOf };
