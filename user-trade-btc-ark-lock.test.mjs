// Buying an asset with BTC on a lock straight from the maker (htlc-2), the BTC paid from the wallet's
// Bitcoin ark (btc-ark.js's own adapter over a worker that answers as Bark does), and from the hosted
// Lightning node's answers: a purchase whose payment is for certain not made comes back with its lock
// cleared of its paid mark (#839), never pays twice, and says what is true meanwhile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, tradeStateWord, USER_WORDS } from './user-trade.js'
import { needSeconds, PAY_SETTLE_MS } from './user-trade-btc.js'
import { mountBtcArk, arkConfig } from './btc-ark.js'
import { decodeBolt11 } from './bolt11.js'

const X = 'aa'.repeat(32)
// A Bitcoin testnet invoice of 20,000 sat, its hash the trade's.
const LNTB = 'lntb200u1p4wy0ptsp58klvvgcchzulj3kzftnj037meh8577j75uy903fsyfsupg2ld0sspp5u7vlrjpcpe8z952smk9zn6wefcsz55em92upm0lwsuf26e4hp3gsdq5v3snxgrrdpjkx6eqd9hqxqy9gcqcqz9c9qyysgqhy747ysgx623vxwyt83t875mje9s6kqn4j6flq8f24emqkwy7afhqpw92v23vewqxk8mxulxwg2cr86qyact8tks56v76tlzy45ps3gp87tptd'
const H = 'e799f1c8380e4e22d150dd8a29e9d94e202a533b2ab81dbfee8712ad66b70c51', P = 'ef'.repeat(32)
const admitted = (pay, receive) => () => ({ pairs: { chains: { g: { pairs: [{ pay, receive, sources: ['btc-gateway'] }] } } }, genesis: 'g' })

function standIn () {
  const s = { locks: [], places: { instant_limit: null }, info: { tip: { median_time: 1800000000 }, exit_delay_units: 2, server_info: { templates: { list: ['htlc-1', 'htlc-2'] }, locks: { unroll_seconds: 3600, max_seconds: 14 * 86400 }, fills: { round_interval_seconds: 60, block_seconds: 60 } } }, calls: [], posts: [], coins: [{ leaf_id: 'c1', asset: X, value: '1000000', state: 'live', expiry: 1790000000 }], receives: {}, pays: {}, ready: false,
    btcPaid: [], invoices: {}, parts: [] }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  s.lib = {
    command (cmd, a) {
      s.calls.push(cmd)
      switch (cmd) {
        case 'coins': return s.coins
        case 'plans': return { plans: [] }
        case 'sync': return {}
        case 'participations': return s.parts
        case 'lightning_pay_quote': return { payment_hash: H, asset: X, amount: s.want, fee: '200', margins: '480', spends: String(BigInt(s.want) + 680n),
          gives: ['c1'], change: String(1000000n - BigInt(s.want) - 680n) }
        case 'lightning_pay': {
          const change = String(1000000n - BigInt(s.want) - 680n)
          s.pays[H] = { state: 'paying' }; s.coins[0].state = 'spent'; s.coins.push({ leaf_id: 'chg', asset: X, value: change, state: 'live', expiry: 1790000000 })
          return { change }
        }
        case 'lightning_payments': return s.pays
        case 'lightning_post_preimage': s.posted = a.preimage; return {}
        case 'lightning_receive_quote': return { asset: X, amount: a.amount, fee: '200', value: String(BigInt(a.amount) - 200n), claim_margins: '416', claimed: String(BigInt(a.amount) - 616n) }
        case 'settle_quote': return { asset: X, value: a.value, fee: '3', after: String(BigInt(a.value) - 3n) }
        case 'lightning_receive': s.receives[a.hash] = { state: 'waiting' }; return { invoice: 'lnsqrt-x', fee: '200', value: String(BigInt(a.amount) - 200n) }
        case 'lightning_receives': return s.receives
        case 'lightning_receive_ready':
          assert.equal(a.need_seconds, needSeconds(s.delay ?? 18))
          if (s.receiveNever) { const e = new Error('refused: ' + s.receiveNever); e.kind = 'refused'; throw e }
          return s.ready ? { ready: true } : { ready: false, why: 'the received leaf\'s round is not final' }
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'received'; s.receives[a.hash].leaf = 'r1'; s.coins.push({ leaf_id: 'r1', asset: X, value: s.claimed, state: 'live' }); return {}
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        case 'info': return s.info
        case 'coin_places': return s.places
        case 'lock_request': s.lockAsked = a; s.locks.push({ role: 'payee', hash: a.hash, state: 'asked', asset: a.asset, value: a.amount }); return { kind: 'arca-lock-request', payment_hash: a.hash, asset: a.asset, value: a.amount, min_timeout: a.min_timeout, owner: 'k' }
        case 'lock_ready': {
          assert.equal(a.need_seconds, needSeconds(s.delay ?? 18))
          const l = s.locks.find((x) => x.hash === a.hash)
          if (s.lockNever) { const e = new Error('refused: ' + s.lockNever); e.kind = 'refused'; throw e }
          if (!l || l.state === 'asked') return { payment_hash: a.hash, ready: false, why: 'the lock has not come', state: 'asked' }
          return s.lockFinal ? { payment_hash: a.hash, ready: true, home_in: 99999 } : { payment_hash: a.hash, ready: false, why: 'the lock\'s rounds are not final: in_mempool' }
        }
        case 'lock_preimage': {
          const l = s.locks.find((x) => x.hash === a.hash)
          l.preimage = a.preimage; s.lockPosted = a.preimage
          if (s.claimFails) throw new Error('the operator does not answer')
          l.state = 'claimed'; l.claimed_into = ['lk1']; s.coins.push({ leaf_id: 'lk1', asset: X, value: s.claimed, state: 'live' })
          return { payment_hash: a.hash, state: 'claimed' }
        }
        case 'locks': return s.locks
        case 'lock_paid': {
          if (s.lockPaidRefuse) throw Object.assign(new Error('unknown command: lock_paid'), { kind: 'parse' })
          s.lockPaidAt = s.btcPaid.length
          const l = s.locks.find((x) => x.hash === a.hash); l.paid = true
          return { payment_hash: a.hash, paid: true }
        }
        case 'lock_unpaid': {
          if (s.unpaidSilent) throw new Error('the library did not answer in time')
          if (s.unpaidRefuse) { const e = new Error('refused: ' + s.unpaidRefuse); e.kind = 'refused'; throw e }
          const l = s.locks.find((x) => x.hash === a.hash); const was = l.paid === true; l.paid = false
          s.unpaidAt = s.btcPaid.length
          return { payment_hash: a.hash, paid: false, was_paid: was }
        }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  s.fetchJson = async (url, init) => {
    const b = init ? JSON.parse(init.body) : null
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: 'BTC', want_asset: X, rate_num: '2', rate_den: '1', min_give: '1000', max_give: '1000000' },
      { give_asset: X, want_asset: 'BTC', rate_num: '1', rate_den: '2', min_give: '1000', max_give: '1000000' }] }
    s.posts.push([url.split('/v1/btc/')[1], b])
    if (url.endsWith('/v1/btc/firm')) {
      if (b.give_asset === 'BTC') { s.want = String(BigInt(b.give) * 2n); return { swap: 's1', invoice: 'lnsqrt-x', give: b.give, want: s.want, expires_at: 4e9 } }
      return { swap: 's2', lock: s.makerLocks ?? ['htlc-2'], invoice: s.makerInvoice ?? 'lnbcrt-maker', give: b.give, want: s.makerWant ?? String((BigInt(b.give) + 1n) / 2n), expires_at: 4e9 }
    }
    return {}
  }
  s.btc = {
    balance: async () => 500000n,
    invoice: async ({ sats }) => { s.invoices[H] = { sats, status: 'unpaid' }; return { invoice: 'lnbcrt-wallet', payment_hash: H, expires_at: 4e9 } },
    decode: async () => ({ sats: s.makerSats, payment_hash: H, expires_at: 4e9, min_final_cltv: 18 }),
    invoiceStatus: async (h) => (s.invoices[h] && s.invoices[h].status === 'paid' ? { status: 'paid', preimage: P } : { status: 'unpaid' }),
    cancelInvoice: async () => {},
    pay: async ({ invoice }) => {
      if (s.paySays) { s.payTried = (s.payTried || 0) + 1; return s.paySays }
      s.btcPaid.push(invoice); return { state: 'complete', preimage: P }
    },
    payStatus: async () => (s.payStatusSays ? s.payStatusSays : s.payTried && s.afterPay ? s.afterPay : s.btcPaid.length ? { state: 'complete', preimage: P } : { state: 'none' }),
  }
  return s
}


async function bought (s, extra = {}, amount = '50000') {
  s.makerSats = s.makerSats ?? 50000n
  s.claimed = String(100000n - 616n)
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc, now: () => t, ...extra })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount })
  assert.ok(q.ok, q.why)
  const r = await eng.confirm(q.choice, q.ticket)
  return { eng, r, step: (ms) => { t += ms }, at: () => t }
}


// A worker answering as bark-wasm does (bark-wasm/src/command.rs): `pay` with `wait` answers only once
// the payment is done, `none` when Bark failed it back and dropped it; `pay_status` reads `pending`
// while Bark holds one, `none` once it holds none. `bark.next`: what the next payment does.
function barkWorker (bark) {
  const w = {
    onmessage: null,
    postMessage ({ id, op, args }) {
      let value, error
      try {
        if (op !== 'open') {
          const c = args.command
          if (c === 'info') value = { network: 'testnet4', min_board_sat: '10000', max_vtxo_sat: '5000000', max_route_delay: 218 }
          else if (c === 'balance') value = { spendable: '500000', total: '500000' }
          else if (c === 'pay_fee') value = { fee: '125', max_route_delay: 218 }
          else if (c === 'pay') { bark.pays = (bark.pays || 0) + 1; bark.holds = bark.next === 'held'; value = bark.next === 'failed-back' ? { state: 'none' } : bark.next === 'refused' ? { state: 'failed', reason: 'no route' } : bark.next === 'held' ? { state: 'pending' } : { state: 'complete', preimage: P } }
          else if (c === 'pay_status') { if (bark.unreadable) throw new Error('the wallet is busy'); value = bark.holds ? { state: 'pending' } : bark.paid ? { state: 'complete', preimage: P } : { state: 'none' } }
          else value = {}
        } else value = true
      } catch (e) { error = { message: e.message } }
      setTimeout(() => w.onmessage({ data: error ? { id, ok: false, error } : { id, ok: true, value } }), 0)
    },
    terminate () {},
  }
  return w
}

const arks = []
test.afterEach(() => { while (arks.length) arks.pop().close() })

async function onArk (bark) {
  const s = standIn()
  const ark = mountBtcArk({ makeWorker: () => barkWorker(bark), mnemonic: () => 'x', config: arkConfig({ server: 'https://s', esplora: 'https://e', network: 'testnet4' }), decode: decodeBolt11 })
  arks.push(ark)
  await ark.open()
  s.btc = ark.lightning()
  s.makerInvoice = LNTB; s.makerWant = '20000'; s.delay = 218
  const b = await bought(s, {}, '30000')
  s.locks[0].state = 'held'; s.lockFinal = true
  return { s, ark, ...b }
}

test('on the ark: a payment Bark failed back comes back with the lock\'s mark cleared, paid once', async () => {
  const bark = { next: 'failed-back' }
  const { s, ark, eng } = await onArk(bark)
  const r = await eng.advance(eng.records()[0])
  assert.equal(bark.pays, 1)
  assert.equal(r.state, 'returned', r.why)
  assert.equal(s.locks[0].paid, false, 'the library\'s mark is cleared')
  assert.ok(s.calls.indexOf('lock_paid') < s.calls.indexOf('lock_unpaid'))
  for (let i = 0; i < 3; i++) await eng.advance(eng.records()[0])
  assert.equal(bark.pays, 1, 'never paid again')
  ark.close()
})

test('on the ark: a payment Bark still holds keeps the mark; dropped later, the trade comes back, paid once', async () => {
  const bark = { next: 'held' }
  const { s, eng, step } = await onArk(bark)
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent'); assert.equal(s.locks[0].paid, true)
  assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcPaying)
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent', 'still held'); assert.equal(s.locks[0].paid, true)
  // Bark failed it back and dropped it: it reads none, and the call that made it was answered.
  bark.holds = false
  step(60_000)
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false)
  assert.equal(bark.pays, 1, 'not paid a second time')
})

test('a call to pay whose answer was lost: no payment is not taken for certain until the call can start none', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.btc.pay = async () => { s.payTried = (s.payTried || 0) + 1; throw new Error('the request timed out') }
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.markedPaid, true); assert.equal(r.payAnswered, false)
  step(PAY_SETTLE_MS - 60_000)
  r = await eng.advance(eng.records()[0])
  assert.notEqual(r.state, 'returned'); assert.equal(s.locks[0].paid, true); assert.equal(s.payTried, 1)
  step(120_000)
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false); assert.equal(s.payTried, 1)
})

test('on the ark: the clearing not answered, the next step finishes it without paying again, and the row says so', async () => {
  const bark = { next: 'failed-back' }
  const { s, ark, eng } = await onArk(bark)
  s.unpaidSilent = true
  let r = await eng.advance(eng.records()[0])
  assert.notEqual(r.state, 'returned'); assert.equal(s.locks[0].paid, true)
  assert.ok(r.ending && r.ending.notPaid, 'read as not paid')
  assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcReturning)
  s.unpaidSilent = false
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false)
  assert.equal(bark.pays, 1, 'the failed payment is not made again')
  ark.close()
})

test('on the ark: Bark unreadable while the trade comes back keeps the mark and says it checks', async () => {
  const bark = { next: 'failed-back' }
  const { s, ark, eng } = await onArk(bark)
  bark.unreadable = true
  let r = await eng.advance(eng.records()[0])
  assert.notEqual(r.state, 'returned'); assert.equal(s.locks[0].paid, true)
  assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcChecking)
  assert.ok(!s.calls.includes('lock_unpaid'), 'never cleared on a reading it could not make')
  bark.unreadable = false
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false); assert.equal(bark.pays, 1)
  ark.close()
})

test('a purchase whose payment completes while it is coming back goes on as paid', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'failed', reason: 'refused' }
  s.afterPay = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  assert.ok(r.ending, 'coming back, its payment not read for certain'); assert.equal(s.locks[0].paid, true)
  s.afterPay = { state: 'complete', preimage: P }
  r = await eng.advance(eng.records()[0])
  r = await eng.advance(eng.records()[0])
  assert.equal(r.ending, null); assert.equal(r.preimage, P)
  assert.notEqual(r.state, 'returned'); assert.equal(s.locks[0].paid, true, 'the mark stays: it was paid')
})

// The hosted node: a 403 or 'failed' answered while the payment reads in flight is not final.
test('on the hosted node: a refusal answered while the payment still reads in flight keeps the mark', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'failed', reason: 'declined' }
  s.afterPay = { state: 'pending' }
  const r = await eng.advance(eng.records()[0])
  assert.notEqual(r.state, 'returned'); assert.equal(s.locks[0].paid, true)
  assert.ok(!s.calls.includes('lock_unpaid'))
  assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcChecking)
})

test('a trade that comes back from waiting after its lock was marked paid clears the mark first', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.markedPaid, true)
  // The wallet's Lightning knows no payment; past the time a lost call may pay, the recheck finds the lock gone.
  s.payStatusSays = { state: 'none' }
  step(60_000)
  s.lockNever = 'the lock is no longer the swap\'s'
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false)
  assert.equal(s.payTried, 1)
})
