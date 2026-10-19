// The price of room to receive over Lightning: capacity the service locks in a channel toward the
// user, for a time the user chooses.
//
//   fee = max(floor, amount × annual rate of the asset × months / 12)
//
// What the service gives up is its own coins, held in that channel for the whole time, so the price
// is the cost of that capital: it grows with the amount and with the time, at a yearly rate that
// differs by asset. A coin that earns nothing while it waits (BTC) costs less to hold than one that
// would earn elsewhere (a stablecoin lent out, a staked coin), and no asset is exempt from being
// priced: each has its own rate, the native asset included. The floor covers what a channel costs
// to open whatever its size. The service keeps the channel open for the months paid for; after
// that it may close it, which returns the user's side to them on chain.
//
// Pure: lsp-server.mjs reads the configuration and calls these.

export const MONTHS_ALLOWED = [1, 3, 6, 12];

// The yearly rate, in basis points, `table` sets for an asset: keyed by hex id or by label, case
// does not matter; `fallback` when it sets none. BTC is the key "BTC".
export function annualBpsFor(table, assetId, label, fallback) {
  if (table && typeof table === 'object') {
    const keys = [String(assetId || '').toLowerCase(), String(label || '').toLowerCase()].filter(Boolean);
    for (const [k, v] of Object.entries(table)) {
      if (!keys.includes(String(k).toLowerCase())) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return Number(fallback);
}

// The months asked for: `def` when none was given, null when the value is not one sold.
export function parseMonths(raw, allowed = MONTHS_ALLOWED, def = 12) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && allowed.includes(n) ? n : null;
}

// The quote for `amount` atoms of room for `months` at `annualBps` a year, never below `floor`,
// within [minAmount, maxAmount]. A refused amount is data ({ ok:false, reason, min, max }), not an
// exception. The product is taken in BigInt: an asset worth little has many atoms per unit.
export function quoteRoom(amount, { months, annualBps, floor, minAmount, maxAmount }) {
  const amt = Math.floor(Number(amount) || 0);
  const lo = Number(minAmount), hi = Number(maxAmount);
  if (!(amt > 0)) return { ok: false, reason: 'amount must be greater than zero', amount: 0, fee: 0 };
  if (amt < lo) return { ok: false, reason: `the smallest amount of inbound sold is ${lo}`, amount: amt, fee: 0, min: lo, max: hi };
  if (amt > hi) return { ok: false, reason: `the largest amount of inbound sold is ${hi}`, amount: amt, fee: 0, min: lo, max: hi };
  const m = Number(months), rate = Math.max(0, Math.floor(Number(annualBps) || 0));
  // Round UP: rounding a price down sells capacity below cost on every request that lands
  // mid-atom, and those are the common case.
  const num = BigInt(amt) * BigInt(rate) * BigInt(m), den = 120_000n;
  const byTime = Number((num + den - 1n) / den);
  const fee = Math.max(byTime, Number(floor));
  return { ok: true, amount: amt, fee, floor: Number(floor), min: lo, max: hi, months: m, annual_bps: rate,
    // the share of the amount this duration costs, kept for clients that show a percentage
    bps: Math.ceil((rate * m) / 12) };
}

// When the months paid for end, from `now` (ms): calendar months, so 1 is never under 28 days.
export function expiresAt(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return d.getTime();
}
