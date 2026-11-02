// How much default mode keeps where it pays in seconds (the Ark: Bitcoin's for BTC, Sequentia's
// for each asset), in USD. Two figures per kind:
//   board   what the wallet moves there by itself from its own address: BTC or an asset that
//           lands on the chain goes in until the Ark holds this much of it;
//   hold    what the Ark may hold once payments arrive there too: past it, the part above is
//           moved out to the wallet's own address, and Receive stops asking to be paid there.
// So a wallet starts with up to `board` there, receives up to `hold`, and everything else stays,
// or goes, on the chain.
//
// The page sets them (window.SEQ_ARK_LIMITS, the shape of ARK_LIMITS: any figure left out keeps
// its default, null for no limit). An asset the price feed does not value cannot be held to a
// figure in USD: it is boarded and kept as before.
export const ARK_LIMITS = Object.freeze({
  btc: Object.freeze({ board: 1000, hold: 2000 }),
  asset: Object.freeze({ board: 5000, hold: 10000 }),
})

// A move out of the Ark costs a fee of its own, so the wallet consolidates: the part above `hold`
// stays there until it is worth at least this much, and then all of it moves at once.
export const MOVE_OUT_MIN_USD = 1000

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const figure = (v, d) => (v === null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== undefined ? Number(v) : d))

// The limits a page set, each figure checked: { btc: { board, hold }, asset: { board, hold } }.
// `hold` is never under `board`.
export function arkLimits (page) {
  const p = page && typeof page === 'object' ? page : {}
  const one = (k) => {
    const q = p[k] && typeof p[k] === 'object' ? p[k] : {}
    const board = figure(q.board, ARK_LIMITS[k].board)
    let hold = figure(q.hold, ARK_LIMITS[k].hold)
    if (hold != null && board != null && hold < board) hold = board
    return { board, hold }
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

// How much more the Ark may take in payments, holding `held` atoms. Same answer as boardRoom.
export function receiveRoom ({ held, limitUsd, price, precision }) {
  return boardRoom({ held, limitUsd, price, precision })
}

// The part above the `hold` limit, to move out to the wallet's own address: worth at least
// MOVE_OUT_MIN_USD, else 0n (a move costs a fee of its own). -> atoms.
export function holdExcess ({ held, limitUsd, price, precision, minUsd = MOVE_OUT_MIN_USD }) {
  if (limitUsd == null) return 0n
  const cap = usdAtoms(limitUsd, price, precision), least = usdAtoms(minUsd, price, precision)
  if (cap == null || least == null) return 0n
  const over = big(held) - cap
  return over > 0n && over >= least ? over : 0n
}
