// The BTC desk pays a BTC purchase on the operator's acceptance of the wallet's payment within its
// owner's caps, and otherwise once the leaf it received is held for good.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { btcDesk } from './leaf-maker-btc.mjs'

const HASH = 'cd'.repeat(32)
const X = 'aa'.repeat(32)
function fakeNode (paid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-early-'))
  const sock = path.join(dir, 'lightning-rpc')
  const now = () => Math.floor(Date.now() / 1000)
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      const m = req.method
      const result = m === 'listpeerchannels' ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
        : m === 'decode' ? { valid: true, amount_msat: 12000000, payment_hash: HASH, created_at: now(), expiry: 7200, min_final_cltv_expiry: 18, payee: '02'.padEnd(66, '1'), routes: [] }
        : m === 'getroute' ? { route: [{ amount_msat: 12001000, delay: 40 }] }
        : m === 'listpays' ? { pays: paid.length ? [{ status: 'complete', preimage: 'ee'.repeat(32), amount_sent_msat: 12001000, amount_msat: 12000000 }] : [] }
        : m === 'pay' ? (paid.push(req.params.bolt11), { status: 'complete', payment_preimage: 'ee'.repeat(32), amount_sent_msat: 12001000, amount_msat: 12000000 })
        : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, close: () => srv.close() })))
}

async function run (btcCaps, holdSeconds) {
  const paid = []
  const n = await fakeNode(paid)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-early-store-'))
  const asked = []
  const cmd = async (name, a) => {
    asked.push(name)
    if (name === 'lightning_receive') return { invoice: 'lnsq1operator', payment_hash: HASH }
    if (name === 'lightning_receives') return { [HASH]: { state: 'issuing', timeout: Math.floor(Date.now() / 1000) + holdSeconds } }
    if (name === 'lightning_receive_ready') return { ready: false, why: 'the received leaf\'s round has not come' }
    if (name === 'lightning_payments') return {}
    if (name === 'lightning_receive_preimage') return {}
    throw new Error('no operator here: ' + name)
  }
  try {
    const cfg = { store_dir: store, offer_ttl_seconds: 300,
      btc: { rpc: n.sock, keep_sats: '20000', ...btcCaps, pairs: [{ give: 'BTC', want: X, rate_num: '1', rate_den: '1', min_give: '1000' }] } }
    const desk = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map() })
    const [code, f] = await desk.route('POST', '/v1/btc/firm', { give_asset: 'BTC', want_asset: X, give: '12000', invoice: 'lntb1wallet' },
      async () => new Map([[X, 10_000_000n]]), '0')
    assert.equal(code, 200, JSON.stringify(f))
    await desk.tick()
    return { paid, asked, state: desk.swaps.get(f.swap).state }
  } finally { n.close() }
}

test('within the caps a BTC purchase is paid on the operator\'s acceptance', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 24 * 3600)
  assert.equal(r.paid.length, 1, 'the wallet\'s invoice is paid')
  assert.ok(!r.asked.includes('lightning_receive_ready'), 'without waiting for the leaf')
  assert.notEqual(r.state, 'offered')
})

test('without caps (the default) the desk waits for the leaf held for good', async () => {
  const r = await run({}, 24 * 3600)
  assert.equal(r.paid.length, 0)
  assert.ok(r.asked.includes('lightning_receive_ready'))
  assert.equal(r.state, 'offered')
})

test('a hold of the operator\'s that would not outlast the BTC route is not paid ahead', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 60)
  assert.equal(r.paid.length, 0)
  assert.equal(r.state, 'offered')
})
