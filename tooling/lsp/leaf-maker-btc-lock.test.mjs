// The BTC desk pays a wallet's receive once, and a payment that never completes cannot leave the
// swap 'locked' and unpaid: it is 'locking' while the library pays, and offered again after the
// locking window, so the wallet's next lock pays it.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { btcDesk } from './leaf-maker-btc.mjs'

const HASH = 'ab'.repeat(32)
function fakeNode () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-lock-'))
  const sock = path.join(dir, 'lightning-rpc')
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      const result = req.method === 'listpeerchannels' ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
        : req.method === 'invoice' ? { bolt11: 'lntb1fake', payment_hash: HASH, expires_at: Math.floor(Date.now() / 1000) + 3600 } : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, dir, close: () => srv.close() })))
}

const X = 'aa'.repeat(32)
test('a payment that never completes is offered again, and the next lock pays it once', async () => {
  const n = await fakeNode()
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-lock-store-'))
  let pays = 0, hang = true, first = null
  const hung = []
  const cmd = async (name) => {
    if (name === 'lightning_pay_quote') return { payment_hash: HASH, asset: X, amount: '50000' }
    if (name === 'lightning_pay') { pays++; if (hang) return new Promise((ok, no) => hung.push(no)); return { ok: true } }
    if (name === 'lightning_payments' || name === 'lightning_receives') return {}
    throw new Error('no operator here')
  }
  try {
    const cfg = { store_dir: store, offer_ttl_seconds: 300,
      btc: { rpc: n.sock, keep_sats: '20000', locking_seconds: 0.2, pairs: [{ give: X, want: 'BTC', rate_num: '1', rate_den: '1', min_give: '1000' }] } }
    const desk = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map() })
    const [code, f] = await desk.route('POST', '/v1/btc/firm', { give_asset: X, want_asset: 'BTC', give: '50000' }, async () => new Map([[X, 10_000_000n]]), '0')
    assert.equal(code, 200, JSON.stringify(f))
    // the first lock's payment never returns
    first = desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lntb1wallet' }).catch(() => null)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(desk.swaps.get(f.swap).state, 'locking')
    // a lock asked meanwhile pays nothing more
    assert.deepEqual((await desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lntb1wallet' }))[1].state, 'locking')
    assert.equal(pays, 1)
    // past the window, with no payment recorded, the next lock pays it
    await new Promise((r) => setTimeout(r, 300))
    hang = false
    const [c2, r2] = await desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lntb1wallet' })
    assert.equal(c2, 200); assert.equal(r2.state, 'locked'); assert.equal(pays, 2)
    // locked now: another lock pays nothing
    assert.equal((await desk.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lntb1wallet' }))[1].state, 'locked')
    assert.equal(pays, 2)
    // the first, hung payment failing now changes nothing: the swap stays locked
    for (const no of hung.splice(0)) no(new Error('the first payment failed late'))
    await first
    assert.equal(desk.swaps.get(f.swap).state, 'locked')
  } finally { for (const no of hung) no(new Error('the test is over')); await first; n.close(); fs.rmSync(n.dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }) }
})
