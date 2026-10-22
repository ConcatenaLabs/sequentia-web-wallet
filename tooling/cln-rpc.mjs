// A Lightning node's JSON-RPC over its socket (Core Lightning's `lightning-rpc`), for Node
// tooling: the leaf maker's Bitcoin Lightning node, and a drill wallet's. Not loaded by a page.
//
//   const rpc = clnRpc('/path/to/regtest/lightning-rpc'); await rpc('getinfo')
//   const btc = clnBitcoinWallet(rpc)   // what user-trade.js's BTC trades need of a Bitcoin
//                                       // Lightning wallet (deps.btc)
import { connect } from 'node:net'

let ids = 0

// One call per connection: the node answers it and the socket is closed.
export function clnRpc (socket, { timeoutMs = 120_000 } = {}) {
  return (method, params = {}) => new Promise((resolve, reject) => {
    const s = connect(socket)
    const id = ++ids
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)) }, timeoutMs)
    s.on('connect', () => s.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
    s.on('data', (d) => {
      buf += d.toString()
      let v
      try { v = JSON.parse(buf) } catch { return }
      clearTimeout(t); s.end()
      if (v.error) { const e = new Error(`${method}: ${v.error.message || JSON.stringify(v.error)}`); e.code = v.error.code; e.data = v.error.data; reject(e) } else resolve(v.result)
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

const msatOf = (v) => {
  if (v == null) return 0n
  if (typeof v === 'object' && v.msat != null) return BigInt(v.msat)
  return BigInt(String(v).replace(/msat$/, ''))
}

// A Bitcoin Lightning wallet on a node: what it can pay, an invoice, a payment, and how each
// stands. Amounts in satoshis (BigInt), times in seconds.
export function clnBitcoinWallet (rpc) {
  return {
    // What its channels can send now.
    async balance () {
      const r = await rpc('listpeerchannels')
      return (r.channels || []).filter((c) => c.state === 'CHANNELD_NORMAL').reduce((n, c) => n + msatOf(c.spendable_msat), 0n) / 1000n
    },
    async invoice ({ sats, description = 'trade', expiry = 3600 }) {
      const label = `trade-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
      const r = await rpc('invoice', { amount_msat: Number(sats) * 1000, label, description, expiry })
      return { invoice: r.bolt11, payment_hash: r.payment_hash, expires_at: r.expires_at, label }
    },
    async decode (invoice) {
      const d = await rpc('decode', { string: invoice })
      if (!d.valid) throw new Error('the invoice does not decode')
      return { sats: msatOf(d.amount_msat) / 1000n, msat: msatOf(d.amount_msat), payment_hash: d.payment_hash, expires_at: Number(d.created_at) + Number(d.expiry),
        min_final_cltv: Number(d.min_final_cltv_expiry ?? 18), payee: d.payee, currency: d.currency, routes: d.routes || [] }
    },
    // An invoice of its own: 'paid' (with the preimage), 'unpaid' or 'expired'.
    async invoiceStatus (hash) {
      const r = await rpc('listinvoices', { payment_hash: hash })
      const i = (r.invoices || [])[0]
      if (!i) return { status: 'unknown' }
      return { status: i.status, preimage: i.payment_preimage || null }
    },
    async cancelInvoice (hash) {
      const r = await rpc('listinvoices', { payment_hash: hash })
      const i = (r.invoices || [])[0]
      if (i && i.status === 'unpaid') await rpc('delinvoice', { label: i.label, status: 'unpaid' }).catch(() => {})
    },
    // Pays an invoice, at most `maxFeeSats` in routing fees and `maxDelay` blocks of lock.
    // -> { state: 'complete', preimage, fee } | { state: 'pending' } | { state: 'failed', reason }
    async pay ({ invoice, maxFeeSats = 0n, maxDelay }) {
      try {
        const r = await rpc('pay', { bolt11: invoice, maxfee: Number(maxFeeSats) * 1000, ...(maxDelay ? { maxdelay: maxDelay } : {}), retry_for: 60 })
        if (r.status === 'complete') return { state: 'complete', preimage: r.payment_preimage, fee: (msatOf(r.amount_sent_msat) - msatOf(r.amount_msat)) / 1000n }
        return { state: r.status === 'pending' ? 'pending' : 'failed', reason: r.status }
      } catch (e) {
        // A payment the node may still make is followed by its status, never paid again.
        const st = await this.payStatus((await this.decode(invoice)).payment_hash).catch(() => null)
        if (st && st.state !== 'failed') return st
        return { state: 'failed', reason: e.message }
      }
    },
    // The route a payment of the invoice would take now: { fee (sats, rounded up), delay (blocks,
    // the whole lock) }.
    // A payee behind a private channel (a hosted node) is reached through its invoice's route hint:
    // a route to the hint's first node, then the hint's hops at their fees and deltas.
    async payRoute (invoice) {
      const d = await this.decode(invoice)
      const viaGraph = await rpc('getroute', { id: d.payee, amount_msat: Number(d.msat), riskfactor: 10, cltv: d.min_final_cltv }).catch(() => null)
      const hop = viaGraph && (viaGraph.route || [])[0]
      if (hop) return { fee: (msatOf(hop.amount_msat) - d.msat + 999n) / 1000n, delay: Number(hop.delay) }
      let best = null
      for (const hint of d.routes || []) {
        // Walk the hint backwards from the payee: what each hop must be handed, and the lock.
        let amt = d.msat, cltv = d.min_final_cltv
        for (const h of [...hint].reverse()) {
          amt += BigInt(h.fee_base_msat ?? 0) + (amt * BigInt(h.fee_proportional_millionths ?? 0) + 999999n) / 1000000n
          cltv += Number(h.cltv_expiry_delta ?? 0)
        }
        const entry = hint[0] && hint[0].pubkey
        if (!entry) continue
        const r = entry === (await rpc('getinfo')).id ? { route: [{ amount_msat: amt, delay: cltv }] }
          : await rpc('getroute', { id: entry, amount_msat: Number(amt), riskfactor: 10, cltv }).catch(() => null)
        const h0 = r && (r.route || [])[0]
        if (!h0) continue
        const cand = { fee: (msatOf(h0.amount_msat) - d.msat + 999n) / 1000n, delay: Number(h0.delay) }
        if (!best || cand.fee < best.fee) best = cand
      }
      if (!best) throw new Error('no route to the payee now')
      return best
    },
    async payStatus (hash) {
      const r = await rpc('listpays', { payment_hash: hash })
      const ps = r.pays || []
      if (!ps.length) return { state: 'none' }
      const done = ps.find((p) => p.status === 'complete')
      if (done) return { state: 'complete', preimage: done.preimage }
      if (ps.some((p) => p.status === 'pending')) return { state: 'pending' }
      return { state: 'failed' }
    },
  }
}
