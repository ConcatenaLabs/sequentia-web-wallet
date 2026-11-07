// History's rows for what the Bitcoin ark wallet paid and was paid (btc-ark.js).
//
// BTC in default mode lives in a Bark wallet, and a payment in the ark or over Lightning into it has
// no transaction of the wallet's own on the chain, so neither the chain's history nor the page's log
// of the operator's tree (instant-history.js) has it. Bark keeps its own record of every change to
// its balance, its movements (`history`): this module turns them into History's rows, in the shape
// instant-history.js gives its own, so they sort into the one list by time. The record is the
// wallet's: it is read again whenever History is drawn, and it is the same on every device and
// after a restore. Display only: nothing is paid or chosen from it.
//
// Not every movement is a payment:
//   - a board takes the wallet's own BTC from its address into the ark, and an exit takes it back
//     out to the chain: the chain's history already shows that BTC;
//   - a round renews coins the wallet already holds;
//   - a Lightning payment under a hash a trade or the move from the wallet's own channel used is
//     part of that trade or move, which has its own row (`skipHashes`).
// What is left is a payment received ('in') or sent ('out'), with the amount that reached the other
// side and the fee the wallet paid apart.

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

const NOT_PAYMENTS = new Set(['bark.board', 'bark.exit', 'bark.round'])

// The payment hash of a Lightning movement, lower case, or ''.
function hashOf (m) {
  const h = m && m.metadata && m.metadata.payment_hash
  return typeof h === 'string' ? h.toLowerCase() : ''
}

function msOf (t) {
  const n = Date.parse(t || '')
  return Number.isFinite(n) ? n : 0
}

// movements: Bark's `history` answer. skipHashes: payment hashes whose movement belongs to a row
// shown elsewhere. -> rows { kind, at, legs: [{ asset: 'BTC', atoms }], fee?, ark, pending? }.
export function arkMovementRows (movements, { skipHashes = [] } = {}) {
  const skip = new Set([...skipHashes].filter(Boolean).map((h) => String(h).toLowerCase()))
  const rows = []
  for (const m of Array.isArray(movements) ? movements : []) {
    if (!m || typeof m !== 'object') continue
    const sub = (m.subsystem && m.subsystem.name) || ''
    if (NOT_PAYMENTS.has(sub)) continue
    if (m.status === 'canceled') continue
    const h = hashOf(m)
    if (h && skip.has(h)) continue
    const eff = big(m.effective_balance)
    if (eff === 0n) continue   // nothing moved: an invoice not paid, a payment that came back
    const fee = big(m.offchain_fee)
    const at = msOf(m.time && m.time.created_at)
    const row = { kind: eff > 0n ? 'in' : 'out', at, ark: String(m.id ?? '') }
    if (eff > 0n) row.legs = [{ asset: 'BTC', atoms: String(eff) }]
    else {
      // What reached the other side: the recipients Bark names, or what left less the fee.
      const sent = (Array.isArray(m.sent_to) ? m.sent_to : []).reduce((s, d) => s + big(d && d.amount), 0n)
      const gone = -eff
      const atoms = sent > 0n && sent <= gone ? sent : (gone > fee ? gone - fee : gone)
      row.legs = [{ asset: 'BTC', atoms: String(atoms) }]
      const paid = gone - atoms
      if (paid > 0n) row.fee = { asset: 'BTC', atoms: String(paid) }
    }
    if (m.status === 'pending') row.pending = true
    rows.push(row)
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0))
}

// What of the record the page keeps between visits, so History shows the ark's payments at once,
// before the ark wallet opens: the movements that can be payments, the newest `keep`, without the
// coin lists. -> a list arkMovementRows reads as it reads the wallet's answer.
export function keptMovements (movements, keep = 200) {
  const out = []
  for (const m of Array.isArray(movements) ? movements : []) {
    if (!m || typeof m !== 'object') continue
    if (NOT_PAYMENTS.has((m.subsystem && m.subsystem.name) || '') || big(m.effective_balance) === 0n) continue
    const h = hashOf(m)
    out.push({ id: m.id, status: m.status, subsystem: m.subsystem, metadata: h ? { payment_hash: h } : {},
      effective_balance: m.effective_balance, offchain_fee: m.offchain_fee,
      sent_to: (Array.isArray(m.sent_to) ? m.sent_to : []).map((d) => ({ amount: d && d.amount })),
      time: { created_at: m.time && m.time.created_at } })
  }
  return out.sort((a, b) => msOf(b.time.created_at) - msOf(a.time.created_at)).slice(0, keep)
}

export const __test__ = { NOT_PAYMENTS, hashOf }
