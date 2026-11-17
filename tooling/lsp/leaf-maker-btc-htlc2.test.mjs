// The BTC desk locks straight to a wallet (htlc-2) when the wallet sends a lock request and the
// operator co-signs locks; it falls back to paying the wallet's receive through the operator only
// when the library refused the lock before signing anything, never while a lock of its stands.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { btcDesk, lockRequestRefusal, operatorLocks, LOCK_SPARE_SECONDS } from './leaf-maker-btc.mjs'

const HASH = 'ab'.repeat(32)
const PRE = 'cd'.repeat(32)
const X = 'aa'.repeat(32)
function fakeNode (st) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-htlc2-'))
  const sock = path.join(dir, 'lightning-rpc')
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let req; try { req = JSON.parse(buf) } catch { return }
      const result = req.method === 'listpeerchannels' ? { channels: [{ state: 'CHANNELD_NORMAL', spendable_msat: 400000000, receivable_msat: 300000000 }] }
        : req.method === 'invoice' ? { bolt11: 'lntb1fake', payment_hash: HASH, expires_at: Math.floor(Date.now() / 1000) + 3600 }
          : req.method === 'listinvoices' ? { invoices: [st.paid ? { status: 'paid', payment_preimage: PRE, payment_hash: HASH } : { status: 'unpaid', payment_hash: HASH }] }
            : req.method === 'delinvoice' ? (st.cancelled = true, {}) : {}
      c.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })
  return new Promise((ok) => srv.listen(sock, () => ok({ sock, dir, close: () => srv.close() })))
}
const request = (over = {}) => ({ kind: 'arca-lock-request', payment_hash: HASH, asset: X, value: '50000', min_timeout: 1800000000, owner: 'k', ...over })

async function desk (st, { info = { templates: { list: ['htlc-1', 'htlc-2'] } }, htlc2 } = {}) {
  const n = await fakeNode(st)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'btcdesk-htlc2-store-'))
  const cmd = async (name, a) => {
    st.calls.push([name, a])
    if (name === 'lock_to') {
      if (st.lockRefused) { st.locks = [{ role: 'payer', hash: HASH, state: 'refused' }]; throw new Error('refused: the wallet\'s coins that cover this lock are too deep') }
      if (st.lockUnanswered) { st.locks = [{ role: 'payer', hash: HASH, state: 'locking' }]; throw new Error('the operator did not answer') }
      st.locks = [{ role: 'payer', hash: HASH, state: 'locked', leaf_id: 'L1' }]
      return { payment_hash: HASH, leaf_id: 'L1', inputs: ['c1'], change: '10' }
    }
    if (name === 'locks') return st.locks
    if (name === 'lightning_pay_quote') return { payment_hash: HASH, asset: X, amount: '50000' }
    if (name === 'lightning_pay') { st.paidThrough = true; return { ok: true } }
    if (name === 'lightning_payments' || name === 'lightning_receives') return {}
    if (name === 'lightning_receive') throw new Error('probe refused')
    throw new Error('no command ' + name)
  }
  const cfg = { store_dir: store, offer_ttl_seconds: 300,
    btc: { rpc: n.sock, keep_sats: '20000', locking_seconds: 0.2, ...(htlc2 === undefined ? {} : { htlc2 }), pairs: [{ give: X, want: 'BTC', rate_num: '1', rate_den: '1', min_give: '1000' }] } }
  const d = await btcDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map(), opInfo: () => info,
    postOp: async (p, b) => { st.opPosts.push([p, b]); return {} }, onPaid: (s, a) => { st.onPaid = a } })
  const [code, f] = await d.route('POST', '/v1/btc/firm', { give_asset: X, want_asset: 'BTC', give: '50000' }, async () => new Map([[X, 10_000_000n]]), '0')
  assert.equal(code, 200, JSON.stringify(f))
  return { d, f, done: () => { n.close(); fs.rmSync(n.dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }) } }
}
const fresh = () => ({ calls: [], locks: [], opPosts: [] })

test('the firm answer offers a lock straight to the wallet only while the operator co-signs locks and the desk allows it', async () => {
  for (const [opts, want] of [[{}, ['htlc-2']], [{ info: { templates: { list: ['htlc-1'] } } }, []], [{ info: null }, []], [{ htlc2: false }, []]]) {
    const st = fresh(); const { f, done } = await desk(st, opts)
    try { assert.deepEqual(f.lock, want, JSON.stringify(opts)) } finally { done() }
  }
  assert.equal(operatorLocks({ templates: { list: ['htlc-2'] } }), true)
})

test('a lock request locks straight to the wallet, an hour past its earliest timeout, and nothing goes through the operator', async () => {
  const st = fresh(); const { d, f, done } = await desk(st)
  try {
    const [code, r] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    assert.equal(code, 200); assert.equal(r.state, 'locked'); assert.equal(r.leg, 'htlc-2')
    const lt = st.calls.find(([n]) => n === 'lock_to')
    assert.equal(lt[1].timeout, 1800000000 + LOCK_SPARE_SECONDS)
    assert.equal(lt[1].request.payment_hash, HASH)
    assert.ok(!st.paidThrough, 'the receive through the operator is not paid')
    assert.deepEqual(st.onPaid.inputs, ['c1'], 'the coins the lock spent leave the book')
    // asked again: answers its state, locks nothing more
    const [, r2] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    assert.equal(r2.state, 'locked'); assert.equal(st.calls.filter(([n]) => n === 'lock_to').length, 1)
  } finally { done() }
})

test('a lock request not for the swap is refused, and nothing is locked', async () => {
  for (const bad of [request({ payment_hash: 'ee'.repeat(32) }), request({ value: '49999' }), request({ asset: 'bb'.repeat(32) }), request({ min_timeout: undefined }), { kind: 'other' }]) {
    const st = fresh(); const { d, f, done } = await desk(st)
    try {
      const [code] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: bad })
      assert.equal(code, 409)
      assert.ok(!st.calls.some(([n]) => n === 'lock_to' || n === 'lightning_pay'))
    } finally { done() }
  }
  assert.equal(lockRequestRefusal(request(), { hash: HASH, give_asset: X, give: '50000' }), null)
})

test('a lock the library refused before signing falls back to the receive through the operator', async () => {
  const st = fresh(); st.lockRefused = true
  const { d, f, done } = await desk(st)
  try {
    const [code, r] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    assert.equal(code, 200); assert.equal(r.leg, 'htlc-1'); assert.equal(r.state, 'locked')
    assert.ok(st.paidThrough)
    // a later ask does not try the lock again
    assert.equal(d.swaps.get(f.swap).straight_refused.includes('too deep'), true)
  } finally { done() }
})

test('a lock asked and not answered stands: no payment through the operator, ever, while the library holds it', async () => {
  const st = fresh(); st.lockUnanswered = true
  const { d, f, done } = await desk(st)
  try {
    const [, r] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    assert.equal(r.state, 'locking'); assert.equal(r.leg, 'htlc-2')
    await new Promise((ok) => setTimeout(ok, 300))   // past the locking window
    const [, r2] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    assert.equal(r2.state, 'locking'); assert.ok(!st.paidThrough, 'the standing lock is not doubled by a payment')
    await d.tick()
    assert.equal(d.swaps.get(f.swap).state, 'locking')
    // the library's sync lands it
    st.locks = [{ role: 'payer', hash: HASH, state: 'locked' }]
    await d.tick()
    assert.equal(d.swaps.get(f.swap).state, 'locked')
  } finally { done() }
})

test('a lock paid for: the preimage goes to the operator, and the swap is done once the wallet claimed', async () => {
  const st = fresh(); const { d, f, done } = await desk(st)
  try {
    await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    await d.tick()
    assert.equal(st.opPosts.length, 0, 'nothing posted before the BTC is paid')
    st.paid = true
    await d.tick()
    assert.deepEqual(st.opPosts, [['/v1/lock_preimage', { payment_hash: HASH, preimage: PRE }]])
    assert.equal(d.swaps.get(f.swap).state, 'locked')
    st.locks = [{ role: 'payer', hash: HASH, state: 'claimed' }]
    await d.tick()
    assert.equal(d.swaps.get(f.swap).state, 'done')
    assert.equal(st.opPosts.length, 1, 'posted once')
  } finally { done() }
})

test('a lock nobody paid for comes back from its timeout: the swap is void and the invoice cancelled', async () => {
  const st = fresh(); const { d, f, done } = await desk(st)
  try {
    await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x', lock: request() })
    st.locks = [{ role: 'payer', hash: HASH, state: 'refunded' }]
    await d.tick()
    assert.equal(d.swaps.get(f.swap).state, 'void')
    assert.equal(st.opPosts.length, 0)
  } finally { done() }
})

test('without a lock request the desk pays through the operator as before', async () => {
  const st = fresh(); const { d, f, done } = await desk(st)
  try {
    const [, r] = await d.route('POST', '/v1/btc/lock', { swap: f.swap, invoice: 'lnsqrt-x' })
    assert.equal(r.leg, 'htlc-1'); assert.ok(st.paidThrough)
    assert.ok(!st.calls.some(([n]) => n === 'lock_to'))
  } finally { done() }
})
