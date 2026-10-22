// The wallet's Bitcoin Lightning for user-mode BTC trades (btc-lightning.js), against a stand-in
// for the service: the hold's preimage stays the wallet's until a payment of the whole amount is
// held, and a payment is called failed only when nothing of it can still be in flight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { hostedBtcLightning } from './btc-lightning.js'
import { decodeBolt11 } from './bolt11.js'
import { withPaymentHash } from './tooling/lsp/hold-bolt11.mjs'

// BOLT 11's example invoice: 250,000 sat; re-encoded under any hash the stand-in is asked for.
const INV = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
const SATS = 250000n

function setup (over = {}) {
  const calls = []
  const mem = new Map()
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  const hold = { state: 'waiting', received_msat: 0, htlc_expiry: null, btc_tip: 100 }
  const lsp = {
    invoice: async (b) => { calls.push(['invoice', b, store.getItem('swk.btcln.holds.t')]); return { bolt11: b.bolt11 ? withPaymentHash(INV, over.otherHash || b.payment_hash) : null, payment_hash: b.payment_hash } },
    invoiceStatus: async () => ({ ...hold }),
    settle: async (b) => { calls.push(['settle', b]); hold.state = 'settled' },
    pay: async (b) => { calls.push(['pay', b]); if (over.payErr) throw over.payErr; return over.payAnswer || { paid: true, preimage: '11'.repeat(32) } },
    payStatus: async () => over.payStatus || { state: 'none' },
    payQuote: async () => ({ route_found: true, fee_msat: 1001, delay: 52 }),
  }
  const btc = hostedBtcLightning({ lsp, nodeKey: async () => 'btc:02aa', connect: async () => {}, spendable: async () => 5000000, receivable: async () => over.receivable ?? 10000000n,
    decode: (s) => decodeBolt11(s, { checksum: true }), store, tag: () => 't',
    random: (n) => new Uint8Array(randomBytes(n)), sha256: (b) => new Uint8Array(createHash('sha256').update(b).digest()), now: () => 1496314658000 })
  return { btc, calls, hold, store }
}

test('a hold under a hash of the wallet\'s, its preimage kept before the node is asked', async () => {
  const { btc, calls } = setup()
  const inv = await btc.invoice({ sats: SATS })
  const [, body, stored] = calls[0]
  assert.equal(body.payment_hash, inv.payment_hash)
  assert.equal(body.bolt11, true)
  assert.ok(!('preimage' in body), 'the node is never given the preimage to make the invoice')
  const kept = JSON.parse(stored)[inv.payment_hash]
  assert.equal(createHash('sha256').update(Buffer.from(kept.preimage, 'hex')).digest('hex'), inv.payment_hash, 'kept before the call')
  assert.equal(decodeBolt11(inv.invoice).paymentHash, inv.payment_hash)
})

test('no hold for more than the node can receive', async () => {
  const { btc, calls } = setup({ receivable: 1000n })
  await assert.rejects(btc.invoice({ sats: SATS }), /cannot receive/)
  assert.equal(calls.length, 0)
})

test('refused: a node invoice under another hash', async () => {
  const { btc } = setup({ otherHash: 'cd'.repeat(32) })
  await assert.rejects(btc.invoice({ sats: SATS }), /not the hold asked for/)
})

test('settled only when the whole amount is held with blocks to spare; never once cancelled', async () => {
  let { btc, calls, hold } = setup()
  let inv = await btc.invoice({ sats: SATS })
  assert.equal((await btc.invoiceStatus(inv.payment_hash)).status, 'unpaid')
  Object.assign(hold, { state: 'accepted', received_msat: Number(SATS) * 1000 - 1, htlc_expiry: 150 })
  assert.equal((await btc.invoiceStatus(inv.payment_hash)).status, 'unpaid', 'one msat short')
  Object.assign(hold, { received_msat: Number(SATS) * 1000, htlc_expiry: 102 })
  assert.equal((await btc.invoiceStatus(inv.payment_hash)).status, 'unpaid', 'two blocks from its expiry')
  assert.ok(!calls.some((c) => c[0] === 'settle'))
  hold.htlc_expiry = 150
  const st = await btc.invoiceStatus(inv.payment_hash)
  assert.equal(st.status, 'paid')
  assert.equal(createHash('sha256').update(Buffer.from(st.preimage, 'hex')).digest('hex'), inv.payment_hash)
  assert.equal(calls.filter((c) => c[0] === 'settle').length, 1);

  ({ btc, calls, hold } = setup())
  inv = await btc.invoice({ sats: SATS })
  await btc.cancelInvoice(inv.payment_hash)
  Object.assign(hold, { state: 'accepted', received_msat: Number(SATS) * 1000, htlc_expiry: 150 })
  assert.equal((await btc.invoiceStatus(inv.payment_hash)).status, 'expired')
  assert.ok(!calls.some((c) => c[0] === 'settle'), 'a cancelled hold is never settled')
})

test('a hold the node forgot is registered again', async () => {
  const { btc, calls, hold } = setup()
  const inv = await btc.invoice({ sats: SATS })
  hold.state = 'unknown'
  assert.equal((await btc.invoiceStatus(inv.payment_hash)).status, 'unpaid')
  const again = calls.filter((c) => c[0] === 'invoice')[1][1]
  assert.equal(again.payment_hash, inv.payment_hash)
  assert.ok(!again.bolt11 && !('preimage' in again))
})

test('a payment: capped at the ticket\'s fee; failed only when nothing can be in flight', async () => {
  const inv = withPaymentHash(INV, 'ef'.repeat(32))
  let { btc, calls } = setup()
  assert.deepEqual(await btc.payRoute(inv), { fee: 2n, delay: 52 })
  let st = await btc.pay({ invoice: inv, maxFeeSats: 2n, maxDelay: 58 })
  assert.equal(st.state, 'complete')
  const b = calls.find((c) => c[0] === 'pay')[1]
  assert.equal(b.wantHash, 'ef'.repeat(32)); assert.equal(b.maxFeeMsat, 2000n); assert.equal(b.maxCltv, 58); assert.equal(b.amountMsat, SATS * 1000n)
  const declined = Object.assign(new Error('over the daily limit'), { status: 403 });
  ({ btc } = setup({ payErr: declined }))
  assert.equal((await btc.pay({ invoice: inv })).state, 'failed')
  const gateway = Object.assign(new Error('pay: timed out'), { status: 502 });
  ({ btc } = setup({ payErr: gateway, payStatus: { state: 'pending' } }))
  assert.equal((await btc.pay({ invoice: inv })).state, 'pending', 'a 502 is not a failure');
  ({ btc } = setup({ payErr: gateway, payStatus: { state: 'complete', preimage: '22'.repeat(32) } }))
  assert.deepEqual(await btc.pay({ invoice: inv }), { state: 'complete', preimage: '22'.repeat(32) });
  ({ btc } = setup({ payErr: gateway, payStatus: { state: 'failed' } }))
  assert.equal((await btc.pay({ invoice: inv })).state, 'failed')
})
