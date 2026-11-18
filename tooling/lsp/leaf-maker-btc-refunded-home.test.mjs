// A BTC desk lock the library took home on the chain (its refund final: the lock's coin `exited`)
// never reads `returned` in the payment record, which only an out-of-round refund sets. The desk
// ends such a swap (void) and cancels its Bitcoin invoice, as for a lock returned out of round
// (web #833). A lock still standing, or paid, is left alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { btcDesk } from './leaf-maker-btc.mjs'

const HASH = 'ab'.repeat(32), X = 'aa'.repeat(32), LEAF = 'cd'.repeat(32)
function fakeNode (calls, inv = { status: 'unpaid' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-home-'))
  const sock = path.join(dir, 'lightning-rpc')
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      calls.push(req.method)
      const result = req.method === 'listpeerchannels' ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
        : req.method === 'invoice' ? { bolt11: 'lntb1fake', payment_hash: HASH, expires_at: Math.floor(Date.now() / 1000) + 3600 }
          : req.method === 'listinvoices' ? { invoices: [{ status: inv.status, payment_hash: HASH, ...(inv.status === 'paid' ? { payment_preimage: 'ef'.repeat(32) } : {}) }] } : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, dir, close: () => srv.close() })))
}

async function lockedDesk (coinState, inv) {
  const calls = [], coinsArgs = []
  const n = await fakeNode(calls, inv)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-home-store-'))
  const cmd = async (name, args) => {
    if (name === 'lightning_pay_quote') return { payment_hash: HASH, asset: X, amount: '50000' }
    if (name === 'lightning_pay') return { ok: true }
    if (name === 'lightning_payments') return { [HASH]: { state: 'paying', htlc_leaf_id: LEAF } }
    if (name === 'lightning_receives') return {}
    if (name === 'locks') return []
    if (name === 'coins') { coinsArgs.push(args); return [{ leaf_id: LEAF, state: coinState.v, asset: X }] }
    throw new Error('no operator here')
  }
  const cfg = { store_dir: store, offer_ttl_seconds: 300,
    btc: { rpc: n.sock, keep_sats: '20000', pairs: [{ give: X, want: 'BTC', rate_num: '1', rate_den: '1', min_give: '1000' }] } }
  const desk = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map() })
  const [code, f] = await desk.route('POST', '/v1/btc/firm', { give_asset: X, want_asset: 'BTC', give: '50000' }, async () => new Map([[X, 10_000_000n]]), '0')
  assert.equal(code, 200, JSON.stringify(f))
  const [c2, r2] = await desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lntb1wallet' })
  assert.equal(c2, 200); assert.equal(r2.state, 'locked')
  return { desk, swap: f.swap, calls, coinsArgs, done: () => { n.close(); fs.rmSync(n.dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }) } }
}

test('a lock whose coin came home on the chain ends the swap and cancels its invoice', async () => {
  const coinState = { v: 'paying' }
  const L = await lockedDesk(coinState)
  try {
    await L.desk.tick()
    assert.equal(L.desk.swaps.get(L.swap).state, 'locked', 'a standing lock stays locked')
    coinState.v = 'exited'
    await L.desk.tick()
    assert.equal(L.desk.swaps.get(L.swap).state, 'void')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(L.calls.includes('delinvoice'), 'the Bitcoin invoice is cancelled: ' + L.calls.join(','))
    assert.ok(L.coinsArgs.length > 0 && L.coinsArgs.every((a) => a && a.brief === true), 'the desk reads the brief coin listing: ' + JSON.stringify(L.coinsArgs))
  } finally { L.done() }
})

test('a lock taken home while its Bitcoin invoice is paid is never voided', async () => {
  const coinState = { v: 'exited' }
  const L = await lockedDesk(coinState, { status: 'paid' })
  try {
    await L.desk.tick()
    assert.notEqual(L.desk.swaps.get(L.swap).state, 'void', 'a sale the desk owes stays visible')
    assert.ok(!L.calls.includes('delinvoice'), 'a paid invoice is not cancelled: ' + L.calls.join(','))
  } finally { L.done() }
})
