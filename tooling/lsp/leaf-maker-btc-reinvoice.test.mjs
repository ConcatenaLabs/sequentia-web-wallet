// The BTC desk makes its invoice under a preimage it keeps, and gives a wallet whose purchase waited
// past the invoice a new one under the same hash, for the same amount; only for a locked swap.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { btcDesk } from './leaf-maker-btc.mjs'

const X = 'aa'.repeat(32)
function fakeNode (calls, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-reinv-'))
  const sock = path.join(dir, 'lightning-rpc')
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      calls.push([req.method, req.params])
      const p = req.params || {}
      let result = {}
      if (req.method === 'listpeerchannels') result = { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
      if (req.method === 'invoice') {
        const hash = createHash('sha256').update(Buffer.from(p.preimage, 'hex')).digest('hex')
        state.n++
        state.inv = { bolt11: 'lntb1inv' + state.n, hash, sats: p.amount_msat / 1000, expires_at: Math.floor(Date.now() / 1000) + (state.short ? 60 : p.expiry) }
        result = { bolt11: state.inv.bolt11, payment_hash: hash, expires_at: state.inv.expires_at }
      }
      if (req.method === 'decode') result = { valid: true, amount_msat: state.inv.sats * 1000, payment_hash: state.inv.hash, created_at: state.inv.expires_at - 3600, expiry: 3600, min_final_cltv_expiry: 18 }
      if (req.method === 'listinvoices') result = { invoices: [{ label: 'l' + state.n, status: state.paid ? 'paid' : 'expired' }] }
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, close: () => srv.close() })))
}

test('a locked swap whose invoice runs out is given a new one under the same hash; an unlocked one is not', async () => {
  const calls = [], state = { n: 0, short: true }
  const n = await fakeNode(calls, state)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-reinv-store-'))
  const cmd = async (name) => {
    if (name === 'lightning_pay_quote') return { payment_hash: state.inv.hash, asset: X, amount: '50000' }
    if (name === 'lightning_pay') return { ok: true }
    if (name === 'lightning_payments' || name === 'lightning_receives') return {}
    throw new Error('no operator here')
  }
  try {
    const cfg = { store_dir: store, offer_ttl_seconds: 300, btc: { rpc: n.sock, keep_sats: '20000', pairs: [{ give: X, want: 'BTC', rate_num: '1', rate_den: '1', min_give: '1000' }] } }
    const desk = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map() })
    const [code, f] = await desk.route('POST', '/v1/btc/firm', { give_asset: X, want_asset: 'BTC', give: '50000' }, async () => new Map([[X, 10_000_000n]]), '0')
    assert.equal(code, 200, JSON.stringify(f))
    const first = calls.find(([m]) => m === 'invoice')[1]
    assert.match(first.preimage, /^[0-9a-f]{64}$/, 'the invoice is under a preimage the desk keeps')
    const hash = state.inv.hash
    assert.equal((await desk.route('POST', '/v1/btc/invoice', { swap: f.swap }))[0], 409, 'not before the desk has locked')
    assert.equal((await desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqt-wallet' }))[1].state, 'locked')
    const [c2, r2] = await desk.route('POST', '/v1/btc/invoice', { swap: f.swap })
    assert.equal(c2, 200, JSON.stringify(r2))
    assert.equal(r2.invoice, 'lntb1inv2')
    assert.ok(calls.some(([m, p]) => m === 'delinvoice' && p.status === 'expired'), 'the run-out invoice is dropped first')
    const second = calls.filter(([m]) => m === 'invoice')[1][1]
    assert.equal(second.preimage, first.preimage); assert.equal(state.inv.hash, hash); assert.equal(second.amount_msat, first.amount_msat)
    state.inv.expires_at = Math.floor(Date.now() / 1000) + 3600
    // An invoice with time to run is answered as it is.
    const [, r3] = await desk.route('POST', '/v1/btc/invoice', { swap: f.swap })
    assert.equal(r3.invoice, 'lntb1inv2')
  } finally { n.close() }
})
