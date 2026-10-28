// node-history.mjs: a hosted node's own record of what it received and paid over Lightning,
// for GET /node/history.
//
// A node is paid in three ways and pays in one, and each leaves its record in a different place:
//
//   - a plain invoice paid to it (a Receive-tab invoice, the incoming leg of a pure-Lightning take,
//     which the taker mints on its own preimage): `listinvoices`, status `paid`;
//   - a hold (holdinvoice-seq) it settled (the asset a sub-asset buy brings in, a BTC sale's hold):
//     not an invoice, so `listinvoices` never lists it. The plugin's datastore entry
//     [holdinvoice-seq, hash] says it was settled and in which asset; bookkeeper's `invoice` credit
//     under that hash says when and how much arrived; `listhtlcs` gives the amount when bookkeeper
//     has nothing (only once the hold is settled: listhtlcs names no outcome, and a failed HTLC
//     reads exactly like a fulfilled one);
//   - a payment it made, by BOLT11 (`pay`) or by bare hash (`sendpay`, the pay leg of a pure-Lightning
//     take and of a sub-asset sell): `listpays`, status `complete`.
//
// The wallet also keeps a swap note on the node (datastore [seqwallet-swap, hash], written through
// POST /node/swap-note when a swap settles): what the swap paid and received on both legs, including
// a leg that settled on-chain, which no Lightning record can name. It is the wallet's own account,
// read back on any device; it never makes a movement exist that the node did not record.
//
// Every item carries the node's asset, the amount in msat of that asset, the direction, the time in
// seconds, the payment hash and a description. Nothing secret leaves: no preimage, no label.

export const HOLD_STORE = 'holdinvoice-seq';
export const NOTE_STORE = 'seqwallet-swap';
const HEX64 = /^[0-9a-f]{64}$/;

const msat = (x) => {
  if (x == null) return 0;
  const n = parseInt(String(x), 10);   // older nodes answer "1000msat"
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const hashOf = (x) => { const h = String(x || '').toLowerCase(); return HEX64.test(h) ? h : null; };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
// A datastore entry's key is [store, hash]; its value a JSON string (or, from older nodes, hex).
function storeEntries(ds, store) {
  const out = new Map();
  for (const d of (ds && ds.datastore) || []) {
    const k = d && d.key;
    if (!Array.isArray(k) || k[0] !== store || k.length !== 2) continue;
    const h = hashOf(k[1]); if (!h) continue;
    let v = d.string != null ? parse(d.string) : null;
    if (!v && d.hex) { try { v = parse(Buffer.from(d.hex, 'hex').toString('utf8')); } catch {} }
    if (v && typeof v === 'object') out.set(h, v);
  }
  return out;
}

// The swap note, cleaned to the fields the wallet may show: each leg an asset (64-hex or 'btc'), an
// amount in that asset's atoms, and whether it moved over Lightning or on-chain; a short title.
export function cleanNote(n) {
  if (!n || typeof n !== 'object') return null;
  const leg = (l) => {
    if (!l || typeof l !== 'object') return null;
    const a = String(l.asset || '').toLowerCase();
    const asset = a === 'btc' ? 'btc' : (HEX64.test(a) ? a : null);
    const atoms = /^[0-9]{1,30}$/.test(String(l.atoms ?? '')) ? String(l.atoms) : null;
    if (!asset || !atoms) return null;
    return { asset, atoms, rail: l.rail === 'chain' ? 'chain' : 'ln' };
  };
  const pay = leg(n.pay), recv = leg(n.recv);
  if (!pay || !recv) return null;
  const title = String(n.title || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
  const at = Number(n.at) > 0 ? Math.floor(Number(n.at)) : 0;
  return { pay, recv, title, at };
}

// From the raw RPC answers to the items, newest first. `asset` is the node's own asset ('btc' for a
// Bitcoin node), used when a record does not name one.
export function nodeHistoryItems({ invoices, pays, holds, htlcs, events, notes, asset = null } = {}) {
  const items = [], seen = new Set();
  const push = (it) => {
    const k = it.payment_hash + ':' + it.dir;
    if (seen.has(k)) return;
    seen.add(k); items.push(it);
  };
  const noteMap = storeEntries(notes, NOTE_STORE);
  const note = (h) => cleanNote(noteMap.get(h));
  const nodeAsset = asset ? String(asset).toLowerCase() : null;

  for (const i of (invoices && invoices.invoices) || []) {
    const h = hashOf(i && i.payment_hash);
    if (!h || i.status !== 'paid') continue;
    push({ dir: 'in', kind: 'invoice', amount_msat: msat(i.amount_received_msat ?? i.amount_msat),
      at: Number(i.paid_at || 0), payment_hash: h, description: String(i.description || ''),
      asset: String(i.asset || nodeAsset || '').toLowerCase() || null, note: note(h) });
  }

  // Bookkeeper's incoming payments by hash: the time and amount of a settled hold.
  const credits = new Map();
  for (const e of (events && events.events) || []) {
    if (!e || e.type !== 'channel' || e.tag !== 'invoice') continue;
    const h = hashOf(e.payment_id); if (!h) continue;
    const c = msat(e.credit_msat); if (!c) continue;
    const prev = credits.get(h) || { msat: 0, at: 0 };
    credits.set(h, { msat: prev.msat + c, at: Math.max(prev.at, Number(e.timestamp || 0)) });
  }
  const htlcIn = new Map();
  for (const x of (htlcs && htlcs.htlcs) || []) {
    if (!x || x.direction !== 'in') continue;
    const h = hashOf(x.payment_hash); if (!h) continue;
    htlcIn.set(h, (htlcIn.get(h) || 0) + msat(x.amount_msat));
  }
  for (const [h, v] of storeEntries(holds, HOLD_STORE)) {
    if (v.state !== 'settled') continue;
    const c = credits.get(h);
    const amount = (c && c.msat) || htlcIn.get(h) || msat(v.amount_msat);
    push({ dir: 'in', kind: 'hold', amount_msat: amount, at: (c && c.at) || 0, payment_hash: h,
      description: String(v.description || ''), asset: String(v.asset || nodeAsset || '').toLowerCase() || null,
      note: note(h) });
  }

  for (const p of (pays && pays.pays) || []) {
    const h = hashOf(p && p.payment_hash);
    if (!h || p.status !== 'complete') continue;
    const amount = msat(p.amount_msat), sent = msat(p.amount_sent_msat);
    push({ dir: 'out', kind: 'pay', amount_msat: amount || sent, fee_msat: (amount && sent > amount) ? sent - amount : 0,
      at: Number(p.completed_at || p.created_at || 0), payment_hash: h, description: String(p.description || ''),
      asset: nodeAsset, note: note(h) });
  }
  items.sort((a, b) => b.at - a.at);
  return items;
}

// Ask the node. `call(method, kv)` answers lightning-cli's JSON for `-k method kv...`. A record a
// node cannot give (an older node without bookkeeper, a datastore it never wrote) is read as empty,
// so one missing source never hides the others; the sources it could not read are named.
export async function readNodeHistory(call, { asset = null, limit = 100 } = {}) {
  const missing = [];
  const get = (method, kv, empty) => call(method, kv).catch(() => { missing.push(method); return empty; });
  const [invoices, pays, holds, htlcs, events, notes] = await Promise.all([
    get('listinvoices', [], { invoices: [] }),
    get('listpays', [], { pays: [] }),
    get('listdatastore', [`key=${JSON.stringify([HOLD_STORE])}`], { datastore: [] }),
    get('listhtlcs', [], { htlcs: [] }),
    get('bkpr-listaccountevents', [], { events: [] }),
    get('listdatastore', [`key=${JSON.stringify([NOTE_STORE])}`], { datastore: [] }),
  ]);
  const items = nodeHistoryItems({ invoices, pays, holds, htlcs, events, notes, asset });
  return { items: items.slice(0, limit), unread: missing };
}
