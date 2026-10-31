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
function fakeNode (paid, failedAt = 0, payError = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-early-'))
  const sock = path.join(dir, 'lightning-rpc')
  const now = () => Math.floor(Date.now() / 1000)
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      const m = req.method
      // A payment the destination refuses is recorded failed, as the node records it.
      if (payError && m === 'pay') { failedAt = now(); return c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 203, message: payError } })) }
      const result = m === 'listpeerchannels' ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
        : m === 'decode' ? { valid: true, amount_msat: 12000000, payment_hash: HASH, created_at: now(), expiry: 7200, min_final_cltv_expiry: 18, payee: '02'.padEnd(66, '1'), routes: [] }
        : m === 'getroute' ? { route: [{ amount_msat: 12001000, delay: 40 }] }
        : m === 'listpays' ? { pays: [...(failedAt ? [{ status: 'failed', created_at: failedAt }] : []),
          ...(paid.length ? [{ status: 'complete', preimage: 'ee'.repeat(32), amount_sent_msat: 12001000, amount_msat: 12000000, created_at: now() }] : [])] }
        : m === 'pay' ? (paid.push(req.params.bolt11), { status: 'complete', payment_preimage: 'ee'.repeat(32), amount_sent_msat: 12001000, amount_msat: 12000000 })
        : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, close: () => srv.close() })))
}

async function run (btcCaps, holdSeconds, fast = null, failedAt = 0, payError = null) {
  const paid = []
  const n = await fakeNode(paid, failedAt, payError)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-early-store-'))
  const asked = []
  const cmd = async (name, a) => {
    asked.push(name)
    if (name === 'lightning_receive') return { invoice: 'lnsq1operator', payment_hash: HASH }
    if (name === 'lightning_receives') return { [HASH]: fast ? { state: 'waiting' } : { state: 'issuing', timeout: Math.floor(Date.now() / 1000) + holdSeconds } }
    if (name === 'lightning_receive_ready') return { ready: false, why: 'the received leaf\'s round has not come' }
    if (name === 'lightning_payments') return {}
    if (name === 'lightning_receive_preimage') return {}
    throw new Error('no operator here: ' + name)
  }
  try {
    const cfg = { store_dir: store, offer_ttl_seconds: 300,
      btc: { rpc: n.sock, keep_sats: '20000', ...btcCaps, pairs: [{ give: 'BTC', want: X, rate_num: '1', rate_den: '1', min_give: '1000' }] } }
    // `fast`: what the operator answers on the hash, read by `stepNow` without the library (whose
    // record still says waiting: no sync since).
    const lookup = fast && (async (h) => (h === HASH ? { state: fast, timeout: Math.floor(Date.now() / 1000) + holdSeconds } : null))
    const desk = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map(), lookup })
    const [code, f] = await desk.route('POST', '/v1/btc/firm', { give_asset: 'BTC', want_asset: X, give: '12000', invoice: 'lntb1wallet' },
      async () => new Map([[X, 10_000_000n]]), '0')
    assert.equal(code, 200, JSON.stringify(f))
    asked.length = 0
    await (fast ? desk.stepNow() : desk.tick())
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

test('between the upkeep\'s passes, a purchase the operator accepted is paid within the caps, without the library', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 24 * 3600, 'accepted')
  assert.equal(r.paid.length, 1, 'the wallet\'s invoice is paid')
  assert.ok(!r.asked.includes('lightning_receives') && !r.asked.includes('lightning_receive_ready') && !r.asked.includes('sync'), r.asked.join())
  assert.equal(r.state, 'claiming')
})

test('between the passes, nothing is paid before the operator accepts, or outside the caps', async () => {
  for (const [caps, said] of [[{ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 'open'], [{}, 'accepted']]) {
    const r = await run(caps, 24 * 3600, said)
    assert.equal(r.paid.length, 0, JSON.stringify(caps) + ' ' + said)
    assert.equal(r.state, 'offered')
    assert.deepEqual(r.asked, [], 'the library is not asked')
  }
})

test('a BTC payment that failed before (the wallet away to take it) is paid again, not taken for a new failure', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 24 * 3600, 'accepted', Math.floor(Date.now() / 1000) - 600)
  assert.equal(r.paid.length, 1, 'paid again')
  assert.equal(r.state, 'claiming')
})

test('a wallet invoice its node no longer knows voids the swap: it is not paid again', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 24 * 3600, 'accepted', 0,
    "Destination said it doesn't know invoice: incorrect_or_unknown_payment_details")
  assert.equal(r.state, 'void')
})

test('a payment that failed otherwise is offered again', async () => {
  const r = await run({ unfinal_max_sats: '50000', unfinal_total_sats: '500000' }, 24 * 3600, 'accepted', 0, 'Ran out of routes to try')
  assert.equal(r.state, 'offered')
})
