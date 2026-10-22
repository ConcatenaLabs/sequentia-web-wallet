// The wallet's Bitcoin Lightning, as the user-mode composer's BTC trades ask for it (deps.btc of
// user-trade.js; the calls are listed in user-trade-btc.js). It drives the wallet's own hosted
// Bitcoin node through the service's API (seqln.js), the node keyless and every signature the
// device's.
//
// The invoice it makes for a trade is a hold under a hash of the wallet's own: the preimage is
// drawn here, kept in the wallet's store before anything is asked of the node, and given to the
// node only to settle a payment already held there for the whole amount. Neither the hosted node
// nor the service hosting it learns it first, so neither can hand it to the other side of a trade
// before that side has paid. A payment out is the node's `pay`, its routing fee capped at the
// one the ticket showed, and is called failed only when the node says no attempt is left in
// flight.
//
// lsp: { invoice(body), invoiceStatus({node_key, payment_hash}), settle({node_key, payment_hash,
//   preimage}), pay(body), payStatus({node_key, payment_hash}), payQuote({node_key, bolt11}) }
//   — seqln.js's seqlnNodeInvoice, seqlnInvoiceStatus, seqlnNodeSettle, seqlnNodePay,
//   seqlnNodePayStatus, seqlnNodePayQuote.
// nodeKey(), connect()  the node's registry key, and bringing the node and its signer up (both
//   may be awaited each call; connect should be cheap once up).
// spendable()           sats the node's channels can send now.
// receivable()          sats they can receive now (optional): a hold for more is not made.
// decode(bolt11)        bolt11.js decodeBolt11.
// store, tag            getItem/setItem, and the wallet's tag (the holds' preimages, kept per wallet).
// random(n), sha256(bytes) -> Uint8Array; now() -> ms.

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// A payment held under a hold is settled only while its HTLC has at least this many blocks left.
export const SETTLE_MARGIN_BLOCKS = 3
// What the hold asks the payer to leave on the final hop (blocks), and how long its invoice runs.
export const HOLD_EXPIRY_SECONDS = 3600
export const HOLDS_KEY = 'swk.btcln.holds'

export function hostedBtcLightning ({ lsp, nodeKey, connect, spendable, receivable, decode, store, tag, random, sha256, now = () => Date.now(), log = () => {} }) {
  const key = () => HOLDS_KEY + '.' + (tag ? tag() : 'default')
  const holds = () => { try { return JSON.parse(store.getItem(key()) || '{}') } catch { return {} } }
  const keep = (h, rec) => { const all = holds(); all[h] = rec; store.setItem(key(), JSON.stringify(all)) }
  const node = async () => { await connect(); return nodeKey() }

  function read (invoice) {
    const d = decode(invoice)
    if (!d || !d.ok) throw new Error((d && d.error) || 'the invoice does not decode')
    if (d.chain !== 'btc') throw new Error('the invoice is not a Bitcoin invoice')
    if (d.amountMsat == null) throw new Error('the invoice names no amount')
    return { sats: d.amountMsat / 1000n, msat: d.amountMsat, payment_hash: d.paymentHash, expires_at: d.timestamp + d.expiry, min_final_cltv: d.minFinalCltv }
  }

  return {
    async balance () { return big(await spendable()) },

    // A hold for `sats` under a new hash of the wallet's: { invoice, payment_hash, expires_at }.
    async invoice ({ sats, description = 'trade', expiry = HOLD_EXPIRY_SECONDS }) {
      // The node is brought up first (a wallet's first BTC trade provisions it), then asked how
      // much it can take: a payment it has no room for would only fail at the payer, the wallet's
      // side locked meanwhile.
      const node_key = await node()
      if (receivable && big(await receivable()) < big(sats)) throw new Error('the node cannot receive that much now')
      const preimage = random(32)
      const h = hex(await sha256(preimage))
      // Kept before the node is asked: a hold whose preimage the wallet lost could never be settled.
      keep(h, { preimage: hex(preimage), sats: String(sats), at: now() })
      const r = await lsp.invoice({ node_key, amount: Number(sats), payment_hash: h, bolt11: true, expiry, description })
      if (!r || !r.bolt11) throw new Error('the node made no invoice for the hold')
      const d = read(r.bolt11)
      if (d.payment_hash !== h || d.sats !== big(sats)) throw new Error('the node\'s invoice is not the hold asked for')
      keep(h, { ...holds()[h], invoice: r.bolt11, expires_at: d.expires_at })
      return { invoice: r.bolt11, payment_hash: h, expires_at: d.expires_at }
    },

    async decode (invoice) { return read(invoice) },

    // A hold of the wallet's: 'paid' (with its preimage), 'unpaid', 'expired' or 'unknown'. A
    // payment held for the whole amount, with time left to settle, is settled here.
    async invoiceStatus (hash) {
      const rec = holds()[hash]
      if (!rec) return { status: 'unknown' }
      if (rec.settled) return { status: 'paid', preimage: rec.preimage }
      if (rec.cancelled) return { status: 'expired' }
      const node_key = await node()
      const st = await lsp.invoiceStatus({ node_key, payment_hash: hash })
      if (st.state === 'settled') { keep(hash, { ...rec, settled: true }); return { status: 'paid', preimage: rec.preimage } }
      if (st.state === 'accepted') {
        const whole = st.received_msat != null && big(st.received_msat) >= big(rec.sats) * 1000n
        const room = st.htlc_expiry != null && st.btc_tip != null && Number(st.htlc_expiry) - Number(st.btc_tip) >= SETTLE_MARGIN_BLOCKS
        if (!whole || !room) { log('[btc lightning] a held payment is not settled:', !whole ? 'it is short of the amount' : 'too close to its expiry'); return { status: 'unpaid' } }
        await lsp.settle({ node_key, payment_hash: hash, preimage: rec.preimage })
        keep(hash, { ...rec, settled: true })
        return { status: 'paid', preimage: rec.preimage }
      }
      if (st.state === 'cancelled') return { status: 'expired' }
      if (rec.expires_at && now() / 1000 > rec.expires_at) return { status: 'expired' }
      if (st.state === 'unknown') {
        // The node forgot the hold (its plugin keeps holds in memory, and the node restarted): a
        // payment arriving now would be failed back, so the hold is registered again.
        await lsp.invoice({ node_key, amount: Number(rec.sats), payment_hash: hash }).catch((e) => log('[btc lightning] hold again:', e.message))
      }
      return { status: 'unpaid' }
    },

    // A hold of a trade that will not happen is never settled.
    async cancelInvoice (hash) {
      const rec = holds()[hash]
      if (rec && !rec.settled) keep(hash, { ...rec, cancelled: true })
    },

    // Pays an invoice, at most `maxFeeSats` in routing fees and `maxDelay` blocks of lock.
    // -> { state: 'complete', preimage } | { state: 'pending' } | { state: 'failed', reason }
    async pay ({ invoice, maxFeeSats = 0n, maxDelay }) {
      const d = read(invoice)
      const node_key = await node()
      let r
      try {
        r = await lsp.pay({ node_key, bolt11: invoice, wantHash: d.payment_hash, amountMsat: d.msat, minFinalCltv: d.min_final_cltv,
          ...(maxDelay ? { maxCltv: maxDelay } : {}), maxFeeMsat: big(maxFeeSats) * 1000n })
      } catch (e) {
        // Refused before anything was sent: a check of the invoice, or the device declining it.
        if (e && (e.status === 400 || e.status === 403)) return { state: 'failed', reason: e.message }
        // Anything else may have left a payment in flight: the node's own record decides.
        return this.payStatus(d.payment_hash)
      }
      if (r && r.paid && r.preimage) return { state: 'complete', preimage: r.preimage }
      return this.payStatus(d.payment_hash)
    },

    async payStatus (hash) {
      const node_key = await node()
      let st
      try { st = await lsp.payStatus({ node_key, payment_hash: hash }) } catch (e) { log('[btc lightning] pay status:', e.message); return { state: 'pending' } }
      if (st.state === 'complete' && st.preimage) return { state: 'complete', preimage: st.preimage }
      if (st.state === 'failed') return { state: 'failed', reason: 'no route paid it' }
      if (st.state === 'none') return { state: 'none' }
      return { state: 'pending' }
    },

    // The route a payment of the invoice would take now: its routing fee in sats (rounded up) and
    // its whole lock in blocks, the final delta included.
    async payRoute (invoice) {
      const node_key = await node()
      const q = await lsp.payQuote({ node_key, bolt11: invoice })
      if (!q || !q.route_found || q.fee_msat == null) throw new Error('no route to the payee now')
      return { fee: (big(q.fee_msat) + 999n) / 1000n, delay: Number(q.delay) }
    },
    async payFee (invoice) { return (await this.payRoute(invoice)).fee },
  }
}
