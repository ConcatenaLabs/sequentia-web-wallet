// Watches one Lightning invoice the wallet made until it is paid, so the Receive card can turn to
// "Received" when the payment lands instead of reading "Invoice ready" forever.
//
// The hosted node lists the invoices it was paid in its history (/node/history, newest first);
// the invoice is paid once an incoming item carries its payment hash. Nothing here decides
// anything about funds: it only reads what the node says it received.
//
//   const stop = watchInvoicePaid({ history: () => lnApi.nodeHistory(nodeKey), paymentHash,
//                                   onPaid: (item) => ... })
//   stop()   // a newer invoice, or the card closed
export function paidItem (history, paymentHash) {
  const h = String(paymentHash || '').toLowerCase()
  if (!h) return null
  const items = (history && history.items) || []
  return items.find((i) => i && i.dir === 'in' && String(i.payment_hash || '').toLowerCase() === h) || null
}

export function watchInvoicePaid ({ history, paymentHash, onPaid, everyMs = 3000, forMs = 60 * 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  let stopped = false
  const until = now() + forMs
  ;(async () => {
    while (!stopped && now() < until) {
      await sleep(everyMs)
      if (stopped) return
      let item = null
      try { item = paidItem(await history(), paymentHash) } catch { /* the node is busy: ask again */ }
      if (item && !stopped) { stopped = true; onPaid(item); return }
    }
  })()
  return () => { stopped = true }
}
