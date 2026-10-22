// The leaf maker's quote ladder: what it holds of an asset it gives, quoted at several price
// levels, as a book shows depth.
//
// The maker splits what it can give now into `levels` slices, each `growth` times the one before
// (the touch smallest, size building behind it), and prices slice k `step_bps` × (k − 1) further
// from its own rate than the first. It publishes the ladder CUMULATIVELY, the shape the user-mode
// composer reads one quote at a time: quote k carries slice k's rate (the worst of slices 1..k)
// and `max_give` = slices 1..k together. A firm offer for `give` walks the slices in order, so
// it never asks more than the quote the taker sized it against: the want of a walk is at most
// ceil(give × rate of the slice it ends in), and every quote that can carry `give` has that rate
// or a worse one.
//
// Configuration (the maker's, and each pair's own to override it):
//   "ladder": { "levels": 8, "step_bps": 25, "growth": 1.25, "first": "5000000" }
// `first`, optional, is level 1's size in atoms of the asset given: each level after it is
// `growth` times larger, and the levels stop where the holding does (the last one takes what is
// left), so a trade of ordinary size crosses several levels whatever the maker holds. Without
// `first` the holding is split over the levels. Without a ladder, a pair is quoted at one
// level, as before.
//
// Per-asset settings (`coin_size`, `board_keep`): a string of atoms for every asset, or an object
// { "<asset hex>": "atoms", …, "default": "atoms" }.

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b

// The setting for one asset: the asset's own entry, else "default", else `dflt`.
export function perAsset (v, asset, dflt) {
  if (v == null) return dflt
  if (typeof v === 'object') return v[asset] ?? v.default ?? dflt
  return v
}

// The ladder a pair is quoted with: its own, else the maker's, else one level.
export function ladderOf (pair, cfg) {
  const l = (pair && pair.ladder) || (cfg && cfg.ladder) || null
  const levels = Math.max(1, Math.min(64, Math.floor(Number(l && l.levels) || 1)))
  const stepBps = Math.max(0, Math.floor(Number(l && l.step_bps) || 0))
  const growth = Math.max(1, Number(l && l.growth) || 1)
  const first = l && l.first != null && big(l.first) > 0n ? big(l.first) : null
  return { levels, stepBps, growth, first }
}

// The slices: [{ rate_num, rate_den, size }], touch first. Every slice shares the pair's
// rate_den, so a walk's want is one exact ceiling. Fewer slices than asked when `have` cannot
// give each at least `min`; none when `have` is below `min`.
export function slicesOf ({ rate_num, rate_den }, have, min, lad) {
  have = big(have); min = big(min || 1)
  if (have < min || have <= 0n) return []
  // A rate of small integers (5/4) is scaled to a numerator of at least 10^8 first, so that a
  // level's step of a few basis points is not rounded up to a whole unit of the numerator.
  let num = big(rate_num), den = big(rate_den)
  if (lad.levels > 1 && num > 0n && num < 100000000n) { const m = ceilDiv(100000000n, num); num *= m; den *= m }
  const rateAt = (k) => ceilDiv(num * BigInt(10000 + lad.stepBps * k), 10000n)
  if (lad.first) {
    // Fixed sizes from `first`, growing, as far as the holding reaches.
    const out = []
    let left = have
    for (let k = 0; k < lad.levels && left > 0n; k++) {
      let size = BigInt(Math.floor(Number(lad.first) * Math.pow(lad.growth, k)))
      if (size < min) size = min
      if (size > left || k === lad.levels - 1) size = left
      if (size < min) break
      out.push({ rate_num: rateAt(k), rate_den: den, size })
      left -= size
    }
    return out
  }
  for (let n = lad.levels; n >= 1; n--) {
    const w = Array.from({ length: n }, (_, k) => Math.pow(lad.growth, k))
    const total = w.reduce((a, b) => a + b, 0)
    // Integer slice sizes: each its share, the last taking what rounding left over.
    const sizes = []
    let used = 0n
    for (let k = 0; k < n; k++) {
      const s = k === n - 1 ? have - used : BigInt(Math.floor(Number(have) * (w[k] / total)))
      sizes.push(s); used += s
    }
    if (sizes.every((s) => s >= min) || n === 1) {
      return sizes.map((size, k) => ({ rate_num: rateAt(k), rate_den: den, size }))
    }
  }
  return []
}

// The quotes the composer reads: quote k = slice k's rate, the depth of slices 1..k.
export function ladderQuotes (give, want, slices, min) {
  const out = []
  let cum = 0n
  for (const s of slices) {
    cum += s.size
    out.push({ give_asset: give, want_asset: want, rate_num: String(s.rate_num), rate_den: String(s.rate_den), min_give: String(big(min || 1)), max_give: String(cum) })
  }
  return out
}

// What a firm offer of `give` wants: the walk of the slices, never more than give × the rate of
// the slice it ends in, rounded up. Null when the ladder does not carry `give`.
export function walkWant (slices, give) {
  give = big(give)
  if (give <= 0n || !slices.length) return null
  let left = give, acc = 0n, last = null
  const den = slices[0].rate_den
  for (const s of slices) {
    if (left <= 0n) break
    const t = left < s.size ? left : s.size
    acc += t * s.rate_num
    left -= t
    last = s
  }
  if (left > 0n) return null
  const walked = ceilDiv(acc, den)
  const bound = ceilDiv(give * last.rate_num, den)
  return { want: walked < bound ? walked : bound, rate_num: last.rate_num, rate_den: den }
}
