// History's rows for what the wallet pays and is paid in seconds, and for its trades.
//
// The chain's history comes from the wollet. A payment made or received in the operator's tree,
// and a trade of the Trade tab's composer, has no transaction of the wallet's own on the chain, so
// the page writes each one down as it happens, per wallet:
//   - a payment received: what the leaf wallet's mailbox accepted (leaves.js `leafArrived`), one
//     row per coin, kept once by its leaf id;
//   - a payment sent: to a receive code (`payCode`) or to an address out of the tree (`offboard`);
//   - a trade: the composer's own record (user-trade.js), read where it is kept, never copied.
// A coin a trade brought in arrives in the mailbox too: it is the trade's, so it is left out of the
// received rows. Display only: nothing is paid or chosen from this log.
export const INSTANT_HIST_KEY = 'swk.instantHist'   // + '.' + the wallet's tag
const KEEP = 200
// A coin that arrived within this long of a trade whose received amount it equals is the trade's.
const TRADE_REACH_MS = 6 * 60 * 60 * 1000

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const key = (tag) => INSTANT_HIST_KEY + '.' + (tag || 'default')

export function instantLog (store, tag) {
  try { const v = JSON.parse(store.getItem(key(tag)) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function save (store, tag, list) {
  try { store.setItem(key(tag), JSON.stringify(list.slice(-KEEP))) } catch {}
}

// A coin the mailbox accepted. Boards (the wallet's own coins from the chain, which the chain's
// history already shows) are not payments; claims and transfers are.
export function noteArrival (store, tag, coin, at = Date.now()) {
  if (!coin || !/^[0-9a-f]{64}$/.test(String(coin.asset || '')) || !(big(coin.value) > 0n)) return false
  if (coin.kind === 'board') return false
  const list = instantLog(store, tag)
  if (coin.leaf_id && list.some((r) => r.leaf === coin.leaf_id)) return false
  list.push({ kind: 'in', at, leaf: coin.leaf_id || null, legs: [{ asset: coin.asset, atoms: String(big(coin.value)) }] })
  save(store, tag, list)
  return true
}

// A payment this wallet made: `asset`, `atoms`, its `fee` ({asset, atoms}) when it paid one, and
// whether it waits for the operator's next settlement (`later`).
export function noteSent (store, tag, { asset, atoms, fee = null, later = false }, at = Date.now()) {
  if (!asset || !(big(atoms) > 0n)) return false
  const list = instantLog(store, tag)
  const row = { kind: 'out', at, legs: [{ asset, atoms: String(big(atoms)) }] }
  if (fee && big(fee.atoms) > 0n) row.fee = { asset: fee.asset || asset, atoms: String(big(fee.atoms)) }
  if (later) row.later = true
  list.push(row)
  save(store, tag, list)
  return true
}

// The composer's trades that moved something: every one sent, waiting or settled, and one
// returned that paid fees. A ticket never confirmed, or one that failed or came back whole, moved
// nothing and has no row.
export function tradeRows (records) {
  const out = []
  for (const r of records || []) {
    const t = r && r.ticket
    if (!t || !t.payAsset || !t.receiveAsset) continue
    const at = Number(r.sentAt || r.at) || 0
    if (['sent', 'waiting', 'settled'].includes(r.state) || (r.state === 'confirming' && r.uncertain)) {
      out.push({ kind: 'swap', at, trade: r, legs: [{ asset: t.payAsset, atoms: '-' + String(big(t.amountIn)) }, { asset: t.receiveAsset, atoms: String(big(t.amountOut)) }],
        fees: (t.fees || []).filter((f) => big(f.atoms) > 0n) })
    } else if (r.state === 'returned' && (r.feesPaid || []).length) {
      out.push({ kind: 'returned', at, trade: r, legs: [], fees: r.feesPaid.filter((f) => big(f.atoms) > 0n) })
    }
  }
  return out
}

// Every row, newest first: the log's payments and the composer's trades, without a received coin
// that was a trade's.
export function instantRows (log, records) {
  const trades = tradeRows(records)
  const claimed = new Set()
  const ofTrade = (r) => {
    if (r.kind !== 'in' || r.legs.length !== 1) return false
    const l = r.legs[0]
    const i = trades.findIndex((t, k) => !claimed.has(k) && t.kind === 'swap' && t.legs[1].asset === l.asset && t.legs[1].atoms === l.atoms &&
      r.at >= t.at - 60000 && r.at - t.at <= TRADE_REACH_MS)
    if (i < 0) return false
    claimed.add(i); return true
  }
  const rows = [...(log || []).filter((r) => r && Array.isArray(r.legs) && !ofTrade(r)), ...trades]
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0))
}

export const __test__ = { key, TRADE_REACH_MS }
