// When a hosted node's payment under one hash is over, for a payer that must not call a payment
// failed while an attempt of it may still follow. Pure; lsp-server.mjs calls these at /node/pay and
// /node/pay-status.
//
// A node's payments under a hash are its `listsendpays` parts. CLN's `pay` makes several attempts
// within its `retry_for` (45 s here), and between two of them every part made so far can read failed;
// /node/pay's direct-hop fallback sends one more part after `pay` gave up. So a payment whose parts
// all failed is final only when no /node/pay for it is running in this process and, after a restart
// of this process, once its newest part is PAY_SETTLE_S old: past `retry_for`, `pay` starts no
// attempt, and a fallback dies with the process that ran it.

// Past CLN pay's retry_for (45 s), with room.
export const PAY_SETTLE_S = 120

// How the payments `payments` (listsendpays parts) stand: { state, preimage }. 'complete' once any
// part completed; 'pending' while any part is in flight or a /node/pay for the hash runs here
// (`active`); 'none' when there is no part; 'failed' once every part failed and the payment is over:
// the last /node/pay for it ended here after its newest part (`endedAt`, seconds), or that part is
// PAY_SETTLE_S old (`nowS`).
export function payStatusOf (payments, { active = false, endedAt = null, nowS = Date.now() / 1000, settleS = PAY_SETTLE_S } = {}) {
  const ps = Array.isArray(payments) ? payments : []
  const done = ps.find((p) => p && p.status === 'complete')
  if (done) return { state: 'complete', preimage: done.payment_preimage || null }
  if (active || ps.some((p) => p && p.status === 'pending')) return { state: 'pending', preimage: null }
  if (!ps.length) return { state: 'none', preimage: null }
  const newest = Math.max(...ps.map((p) => Number(p && p.created_at) || 0))
  if (endedAt != null && endedAt >= newest) return { state: 'failed', preimage: null }
  return { state: nowS - newest >= settleS ? 'failed' : 'pending', preimage: null }
}

// Whether a payment under the hash went out (a part in flight or completed): a /node/pay whose `pay`
// call did not answer then follows it instead of trying another way, and never answers it declined.
export function wentOut (payments) {
  return (Array.isArray(payments) ? payments : []).some((p) => p && (p.status === 'pending' || p.status === 'complete'))
}
