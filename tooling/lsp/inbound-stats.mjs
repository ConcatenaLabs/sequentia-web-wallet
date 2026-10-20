// What the room-to-receive service holds, has sold and has turned away, in aggregate: the public
// GET /stats/inbound behind sequentiatestnet.com/liquidity. Pure: lsp-server.mjs reads the LP node
// (listfunds, listpeerchannels), the fee exchange rates and its own sale and refusal logs, and hands
// them here. Nothing identifying leaves: no node key, channel id, txid or address is in the answer.
//
// Values in the reference unit come from the same getfeeexchangerates the service prices limits
// with: `atoms` of an asset with rate R are worth atoms * R / 1e8 reference atoms, 1e8 to the unit.

import { inboundRoomFundable, lpFreeAtoms } from './inbound-limits.mjs';

const SCALE = 1e8;
const DAY = 86_400_000;

// Reference units `atoms` of an asset with rate `rate` are worth; null without a rate.
export function refOf(atoms, rate) {
  const r = Number(rate);
  return r > 0 ? Number(atoms) * r / SCALE / SCALE : null;
}

// Out: less sellable than the smallest sale, nothing can be sold. Low: under `lowRef`. Else ok.
export function stockStatus(sellableRef, { minRef, lowRef }) {
  if (sellableRef == null) return 'unpriced';
  if (sellableRef < minRef) return 'out';
  if (sellableRef < lowRef) return 'low';
  return 'ok';
}

// The LP's coins locked in the channels it opened toward wallets (the room it sold), per asset:
// opener local, not closing, its own side. The policy asset rides untagged.
export function lockedByAsset(peerchannels, policyHex = '') {
  const out = {};
  for (const c of (peerchannels && peerchannels.channels) || []) {
    if (c.opener !== 'local') continue;
    const st = String(c.state || '');
    if (!(st.startsWith('CHANNELD') || st === 'DUALOPEND_AWAITING_LOCKIN')) continue;
    const a = String(c.channel_asset || c.asset || '').toLowerCase() || String(policyHex || '').toLowerCase();
    if (!a) continue;
    const e = out[a] || (out[a] = { atoms: 0, channels: 0 });
    e.atoms += Math.round(Number(c.to_us_msat ?? 0) / 1000);
    e.channels += 1;
  }
  return out;
}

// The assets to report: everything the LP holds or has locked.
function assetsOf(listfunds, locked, policyHex) {
  const s = new Set(Object.keys(locked));
  for (const o of (listfunds && listfunds.outputs) || []) {
    const a = String(o.asset || '').toLowerCase() || String(policyHex || '').toLowerCase();
    if (a) s.add(a);
  }
  return [...s];
}

// Sales: one log line per channel the service actually opened ({ at, asset, room, months, fee,
// mode, rate, expires_at }). Fees per asset (all time and 30 days, atoms and reference value at the
// rate of the day of the sale), and fees per day over the last 30 days in the reference unit.
export function summarizeSales(sales, now) {
  const by = {}, days = new Array(30).fill(0);
  const start = Math.floor(now / DAY) * DAY - 29 * DAY;
  for (const s of sales || []) {
    const a = String(s.asset || '').toLowerCase(); if (!a) continue;
    const e = by[a] || (by[a] = { purchases: 0, fee_atoms: 0, fee_ref: 0, purchases_30d: 0, fee_atoms_30d: 0, fee_ref_30d: 0, expiring_30d: 0 });
    const ref = refOf(s.fee || 0, s.rate) || 0;
    e.purchases += 1; e.fee_atoms += Number(s.fee) || 0; e.fee_ref += ref;
    if (s.at >= now - 30 * DAY) { e.purchases_30d += 1; e.fee_atoms_30d += Number(s.fee) || 0; e.fee_ref_30d += ref; }
    if (s.expires_at > now && s.expires_at <= now + 30 * DAY) e.expiring_30d += 1;
    const d = Math.floor((s.at - start) / DAY);
    if (d >= 0 && d < 30) days[d] += ref;
  }
  return { by, fees_by_day: days.map((v, i) => ({ day: new Date(start + i * DAY).toISOString().slice(0, 10), fee_ref: v })) };
}

// Refusals for lack of stock over the last 7 days ({ at, asset, room, rate }), per asset.
export function summarizeRefused(refused, now) {
  const by = {};
  for (const r of refused || []) {
    if (!(r.at >= now - 7 * DAY)) continue;
    const a = String(r.asset || '').toLowerCase(); if (!a) continue;
    const e = by[a] || (by[a] = { refused: 0, room_atoms: 0, room_ref: 0, largest_ref: 0 });
    const ref = refOf(r.room || 0, r.rate) || 0;
    e.refused += 1; e.room_atoms += Number(r.room) || 0; e.room_ref += ref; e.largest_ref = Math.max(e.largest_ref, ref);
  }
  return by;
}

// The price list in the reference unit: fee = max(floor, room × yearly rate × months / 12).
export function priceList({ rooms, months, annualBps, floorRef }) {
  return rooms.map((room) => ({ room_ref: room, by_months: months.map((m) => {
    const fee = Math.max(floorRef, room * annualBps / 10000 * m / 12);
    return { months: m, fee_ref: fee, yearly_yield: fee / room * 12 / m };
  }) }));
}

// The whole answer. `rates` is getfeeexchangerates, `label(hex)` an asset's ticker, `debts` the
// deferred fees still owed per asset in atoms, `cfg` the service's terms.
export function buildInboundStats({ listfunds, peerchannels, rates, label, policyHex, sales, refused, debts, now, cfg }) {
  const k = { headroomBps: cfg.headroomBps, reserve: cfg.reserve };
  const locked = lockedByAsset(peerchannels, policyHex);
  const sold = summarizeSales(sales, now), turned = summarizeRefused(refused, now);
  // getfeeexchangerates keys an asset by id or label, and the policy asset as "bitcoin".
  const pol = String(policyHex || '').toLowerCase();
  const rateFor = (a) => {
    const names = [a, label(a), a === pol ? 'bitcoin' : null].filter(Boolean).map((x) => String(x).toLowerCase());
    for (const [key, v] of Object.entries(rates || {})) if (names.includes(key.toLowerCase())) return Number(v) > 0 ? Number(v) : null;
    return null;
  };
  const assets = assetsOf(listfunds, locked, policyHex).map((a) => {
    const rate = rateFor(a);
    const free = lpFreeAtoms(listfunds, a, policyHex);
    const sellable = inboundRoomFundable(free, k);
    const lk = locked[a] || { atoms: 0, channels: 0 };
    const s = sold.by[a] || {}, r = turned[a] || null;
    const sellableRef = refOf(sellable, rate);
    return {
      asset: a, ticker: label(a) || a.slice(0, 8), price_ref: rate ? rate / SCALE : null,
      free_atoms: free, free_ref: refOf(free, rate),
      sellable_atoms: sellable, sellable_ref: sellableRef, room_cap_ref: cfg.maxRef,
      locked_atoms: lk.atoms, locked_ref: refOf(lk.atoms, rate), channels: lk.channels,
      utilization: (lk.atoms + free) > 0 ? lk.atoms / (lk.atoms + free) : 0,
      status: stockStatus(sellableRef, { minRef: cfg.minRef, lowRef: cfg.lowRef }),
      expiring_30d: s.expiring_30d || 0,
      purchases: s.purchases || 0, fees_ref: s.fee_ref || 0,
      purchases_30d: s.purchases_30d || 0, fees_30d_ref: s.fee_ref_30d || 0,
      yield_on_locked: lk.atoms > 0 && rate ? (s.fee_ref_30d || 0) * 12 / refOf(lk.atoms, rate) : null,
      debts_open_ref: refOf((debts && debts[a]) || 0, rate) || 0,
      refused_7d: r,
    };
  }).sort((x, y) => (y.free_ref || 0) - (x.free_ref || 0));
  const sum = (f) => assets.reduce((t, a) => t + (a[f] || 0), 0);
  const freeRef = sum('free_ref'), lockedRef = sum('locked_ref');
  return {
    ok: true, at: new Date(now).toISOString(),
    totals: {
      free_ref: freeRef, locked_ref: lockedRef, channels: sum('channels'),
      utilization: (freeRef + lockedRef) > 0 ? lockedRef / (freeRef + lockedRef) : 0,
      fees_ref: sum('fees_ref'), fees_30d_ref: sum('fees_30d_ref'), purchases: sum('purchases'), purchases_30d: sum('purchases_30d'),
      yield_on_all_capital: (freeRef + lockedRef) > 0 ? sum('fees_30d_ref') * 12 / (freeRef + lockedRef) : null,
      debts_open_ref: sum('debts_open_ref'),
    },
    assets,
    fees_by_day: sold.fees_by_day,
    terms: {
      min_room_ref: cfg.minRef, max_room_ref: cfg.maxRef, fee_floor_ref: cfg.floorRef, months: cfg.months,
      headroom_bps: cfg.headroomBps, reserve_atoms: cfg.reserve, low_ref: cfg.lowRef, default_annual_bps: cfg.annualBps,
    },
    price_list: priceList({ rooms: [10, 100, 1000, 10000].filter((r) => r >= cfg.minRef && r <= cfg.maxRef), months: cfg.months, annualBps: cfg.annualBps, floorRef: cfg.floorRef }),
  };
}
