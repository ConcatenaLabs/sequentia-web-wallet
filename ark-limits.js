// How much default mode keeps where it pays in seconds (the Ark: Bitcoin's for BTC, Sequentia's
// for each asset), in USD. Three figures per kind:
//   board   what the wallet moves there by itself from its own address: BTC or an asset that
//           lands on the chain goes in until the Ark holds this much of it;
//   hold    where payments received there take it: once the Ark holds this much, everything
//           above `board` moves out to the wallet's own address in one move, so the Ark is back
//           at `board` and has room again. A wallet holds between `board` and `hold` there.
//   direct  one payment of this much or more is paid to the address straight away, never to
//           the Ark: a large payment would only be moved out again.
// BTC: 1000, 2000, 1000. Each asset: 5000, 7500, 1000.
// Receiving there never stops: a receive code keeps its instant part whatever the Ark holds.
//
// The page sets them (window.SEQ_ARK_LIMITS, the shape of ARK_LIMITS: any figure left out keeps
// its default, null for no limit). An asset the price feed does not value cannot be held to a
// figure in USD: it is boarded and kept as before.
export const ARK_LIMITS = Object.freeze({
  btc: Object.freeze({ board: 1000, hold: 2000, direct: 1000 }),
  asset: Object.freeze({ board: 5000, hold: 7500, direct: 1000 }),
})


const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const figure = (v, d) => (v === null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== undefined ? Number(v) : d))

// The limits a page set, each figure checked: { btc: { board, hold, direct }, asset: { … } }.
// `hold` is never under `board`.
export function arkLimits (page) {
  const p = page && typeof page === 'object' ? page : {}
  const one = (k) => {
    const q = p[k] && typeof p[k] === 'object' ? p[k] : {}
    const board = figure(q.board, ARK_LIMITS[k].board)
    let hold = figure(q.hold, ARK_LIMITS[k].hold)
    if (hold != null && board != null && hold < board) hold = board
    return { board, hold, direct: figure(q.direct, ARK_LIMITS[k].direct) }
  }
  return { btc: one('btc'), asset: one('asset') }
}

// `usd` dollars of an asset priced `price` USD per whole unit with `precision` decimals, in atoms
// (rounded down). -> BigInt, or null when either is not a number (no limit can be told).
export function usdAtoms (usd, price, precision) {
  const u = Number(usd), p = Number(price)
  if (!(u >= 0) || !(p > 0) || !Number.isFinite(u) || !Number.isFinite(p)) return null
  // Whole cents and a price in millionths keep the sum in integers.
  const cents = BigInt(Math.floor(u * 100)), micro = BigInt(Math.round(p * 1e6))
  if (micro <= 0n) return null
  return (cents * 10n ** BigInt(precision || 0) * 10_000n) / micro
}

// How much more of a kind the wallet moves into the Ark by itself, holding `held` atoms there
// already. -> atoms (0n at the limit), or null for no limit (none set, or the kind unpriced).
export function boardRoom ({ held, limitUsd, price, precision }) {
  if (limitUsd == null) return null
  const cap = usdAtoms(limitUsd, price, precision)
  if (cap == null) return null
  const left = cap - big(held)
  return left > 0n ? left : 0n
}

// What moves out to the wallet's own address, holding `held` atoms: once the Ark holds `hold`,
// everything above `board`, in one move (so never less than `hold - board`); else nothing.
// -> atoms.
export function moveOutAtoms ({ held, board, hold, price, precision }) {
  if (board == null || hold == null) return 0n
  const b = usdAtoms(board, price, precision), h = usdAtoms(hold, price, precision)
  if (b == null || h == null || big(held) < h) return 0n
  const over = big(held) - b
  return over > 0n ? over : 0n
}

// The USD from which one payment goes to the address rather than the Ark, or null for never.
export function directUsd ({ direct }) {
  return direct == null ? null : direct
}

// Whether a payment of `atoms` goes to the address straight away (directUsd or more).
export function goesToAddress ({ atoms, direct, price, precision }) {
  const usd = directUsd({ direct })
  if (usd == null || !(usd > 0)) return false
  const at = usdAtoms(usd, price, precision)
  return at != null && big(atoms) >= at
}
