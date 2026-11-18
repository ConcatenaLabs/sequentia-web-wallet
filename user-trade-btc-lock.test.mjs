// Buying an asset with BTC on a lock straight from the maker (htlc-2): the wallet asks for the lock
// beside the receive through the operator, pays its BTC once the lock is held (no round waited for),
// claims with lock_preimage, and falls back to the receive whenever the lock is not the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, tradeStateWord, USER_WORDS } from './user-trade.js'
import { needSeconds, lockMinTimeout, lockFits, operatorLocks, MAKER_LOCK_MS, LOCK_WAIT_MS, LOCK_SPARE_SECONDS } from './user-trade-btc.js'

const X = 'aa'.repeat(32)
const H = 'cd'.repeat(32), P = 'ef'.repeat(32)
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
          assert.equal(a.need_seconds, needSeconds(18))
          if (s.receiveNever) { const e = new Error('refused: ' + s.receiveNever); e.kind = 'refused'; throw e }
          return s.ready ? { ready: true } : { ready: false, why: 'the received leaf\'s round is not final' }
        case 'lightning_receive_preimage': s.receives[a.hash].preimage = a.preimage; s.receives[a.hash].state = 'received'; s.receives[a.hash].leaf = 'r1'; s.coins.push({ leaf_id: 'r1', asset: X, value: s.claimed, state: 'live' }); return {}
        case 'quote': return { coins: (a.leaves || []).map((l) => ({ leaf_id: l, fee: '3' })) }
        case 'participate': s.parts = a.leaves.map((l, i) => ({ participation: 'p' + i, state: 'pending' })); return { participations: s.parts }
        case 'info': return s.info
        case 'coin_places': return s.places
        case 'lock_request': s.lockAsked = a; s.locks.push({ role: 'payee', hash: a.hash, state: 'asked', asset: a.asset, value: a.amount }); return { kind: 'arca-lock-request', payment_hash: a.hash, asset: a.asset, value: a.amount, min_timeout: a.min_timeout, owner: 'k' }
        case 'lock_ready': {
          assert.equal(a.need_seconds, needSeconds(18))
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
      return { swap: 's2', lock: s.makerLocks ?? ['htlc-2'], invoice: 'lnbcrt-maker', give: b.give, want: String((BigInt(b.give) + 1n) / 2n), expires_at: 4e9 }
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
    payStatus: async () => (s.payStatusSays ? s.payStatusSays : s.btcPaid.length ? { state: 'complete', preimage: P } : { state: 'none' }),
  }
  return s
}


async function bought (s, extra = {}) {
  s.makerSats = 50000n
  s.claimed = String(100000n - 616n)
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted: admitted('BTC', X), store: s.store, btc: s.btc, now: () => t, ...extra })
  const q = await eng.quote({ payAsset: 'BTC', receiveAsset: X, amount: '50000' })
  assert.ok(q.ok, q.why)
  const r = await eng.confirm(q.choice, q.ticket)
  return { eng, r, step: (ms) => { t += ms }, at: () => t }
}

test('the earliest timeout: the payment\'s need, the exit delay, twice the unroll, ten minutes and the slack past the median', () => {
  const info = { tip: { median_time: 1000 }, exit_delay_units: 2, server_info: { locks: { unroll_seconds: 3600, max_seconds: 14 * 86400 } } }
  assert.equal(lockMinTimeout(info, 10000, 5), 1000 + 10000 + 1024 + 7200 + 600 + 1800)
  // past the operator's furthest with the maker's spare hour: none
  assert.equal(lockMinTimeout({ ...info, server_info: { locks: { max_seconds: 20000 } } }, 10000, 5), null)
  assert.equal(lockMinTimeout({ ...info, server_info: { locks: { max_seconds: 10000 + 1024 + 7200 + 600 + 1800 + LOCK_SPARE_SECONDS } } }, 10000, 5) != null, true)
})

test('a lock fits nine tenths of the instant room; no limit, always; no rate, never', () => {
  assert.equal(lockFits({ instant_limit: null }, null), true)
  assert.equal(lockFits({ instant_limit: { room: '1000' } }, 900n), true)
  assert.equal(lockFits({ instant_limit: { room: '1000' } }, 901n), false)
  assert.equal(lockFits({ instant_limit: { room: '1000' } }, null), false)
  assert.equal(operatorLocks({ templates: { list: ['htlc-2'] } }), true)
  assert.equal(operatorLocks({ templates: { list: ['htlc-1'] } }), false)
  assert.equal(operatorLocks(null), false)
})

test('buying with BTC on a lock: asked beside the receive, the BTC paid once the lock is held, claimed with lock_preimage, settled', async () => {
  const s = standIn()
  const { eng, r: r0, at } = await bought(s)
  assert.equal(r0.state, 'waiting')
  assert.equal(eng.records()[0].leg, 'htlc-2')
  assert.equal(s.lockAsked.amount, '100000', 'the lock is for what the maker gives')
  assert.equal(s.lockAsked.min_timeout, 1800000000 + needSeconds(18) + 1024 + 7200 + 600 + 1800)
  const lockPost = s.posts.find(([p]) => p === 'lock')
  assert.ok(lockPost[1].lock && lockPost[1].lock.kind === 'arca-lock-request' && lockPost[1].invoice === 'lnsqrt-x', 'the maker gets the lock request and the receive\'s invoice')
  // the stated wait is the maker's lock, not a round
  assert.equal(eng.records()[0].waitFirstBy, at() + LOCK_WAIT_MS)
  assert.equal(tradeStateWord(eng.records()[0], at()), USER_WORDS.waitingOther(1))
  // the maker locks: the lock is held at once (its coins' rounds final), and the BTC is paid
  s.locks[0].state = 'held'; s.lockFinal = true
  let r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1, 'paid with no round in between')
  assert.equal(r.preimage, P)
  assert.equal(s.lockPosted, P, 'the preimage goes to lock_preimage, which claims')
  assert.ok(!s.calls.includes('lightning_receive_preimage'), 'the receive through the operator is not claimed')
  assert.ok(!s.calls.includes('lightning_receive_ready'), 'no round of a received leaf is waited for')
  r = await eng.advance(eng.records()[0])
  assert.equal(r.receiveState, 'received')
  assert.equal(r.settleTargets[0].leaf_id, 'lk1', 'the claimed coin is the one settled')
  s.parts.forEach((p) => { p.state = 'released'; p.new_leaves = [{ state: 'live' }] })
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled')
})

test('buying with BTC on a lock: the lock come but its coins\' round not final yet waits a round at most, nothing paid', async () => {
  const s = standIn()
  const { eng, at } = await bought(s)
  s.locks[0].state = 'held'
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'waiting'); assert.equal(s.btcPaid.length, 0)
  assert.equal(r.receiveState, 'held')
  assert.equal(r.waitBy.step, 'round')
  assert.ok(r.waitBy.finalBy > at() && r.waitBy.finalBy <= at() + 10 * 60_000)
})

test('buying with BTC: a maker that locks through the operator instead is followed that way, its leaf\'s round waited for', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.receives[H].state = 'issuing'
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.leg, 'htlc-1'); assert.equal(r.state, 'waiting'); assert.equal(s.btcPaid.length, 0)
  s.ready = true
  r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1)
  assert.ok(s.calls.includes('lightning_receive_preimage'), 'claimed as a receive')
  assert.equal(s.lockPosted, undefined)
})

test('buying with BTC: no lock asked when the maker offers none, the operator co-signs none, or it would not fit the instant room', async () => {
  for (const set of [(s) => { s.makerLocks = [] }, (s) => { s.info.server_info.templates.list = ['htlc-1'] },
    (s) => { s.places = { instant_limit: { room: '10' } } }]) {
    const s = standIn(); set(s)
    const { eng } = await bought(s, { refAtoms: () => 100000n })
    assert.equal(s.lockAsked, undefined)
    assert.notEqual(eng.records()[0].leg, 'htlc-2')
    const lockPost = s.posts.find(([p]) => p === 'lock')
    assert.equal(lockPost[1].lock, undefined)
    assert.ok(eng.records()[0].waitFirstBy - eng.records()[0].waitingSince > LOCK_WAIT_MS, 'the stated wait is a round\'s')
  }
})

test('buying with BTC on a lock: a maker that never locks is given up on after the wait, nothing paid', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'waiting'); assert.equal(r.waitBy.step, 'payment')
  step(MAKER_LOCK_MS)
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.btcPaid.length, 0)
  assert.ok(s.posts.some(([p]) => p === 'release'))
})

test('buying with BTC on a lock the library refuses (past its home date, spent elsewhere): returned, nothing paid', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockNever = 'the lock under hash … is being taken on the chain'
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.btcPaid.length, 0)
})

test('buying with BTC on a lock: a claim that fails is handed on again, and the row reads collecting meanwhile', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true; s.claimFails = true
  let r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1); assert.equal(r.posted, undefined)
  assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcPaying)
  s.claimFails = false
  r = await eng.advance(eng.records()[0])
  assert.equal(r.posted, true); assert.equal(r.receiveState, 'received')
  assert.equal(s.btcPaid.length, 1, 'paid once')
})

// KR69 high 2 (arca #962): the lock marked paid before the BTC goes out.
test('buying with BTC on a lock: the library marks the lock paid before the BTC goes out', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1)
  assert.equal(s.lockPaidAt, 0, 'lock_paid ran with no BTC paid yet')
  assert.equal(s.locks[0].paid, true)
  assert.equal(eng.records()[0].markedPaid, true)
  assert.ok(s.calls.indexOf('lock_paid') < s.calls.lastIndexOf('lock_preimage'))
})

test('buying with BTC on a lock: a library that cannot mark the lock paid never sees the BTC paid', async () => {
  const s = standIn(); s.lockPaidRefuse = true
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  const r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 0, 'nothing paid')
  assert.equal(r.state, 'returned')
  assert.match(r.why, /could not mark its lock paid/)
})

// RV84 F3 (#832): a purchase resumed long after it was found ready is checked again before paying.
test('buying with BTC on a lock: resumed an hour after it was found ready, a lock no longer held is not paid for', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  // The wallet's Lightning does not answer: its payment reads as pending, nothing goes out.
  s.payStatusSays = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent'); assert.equal(s.btcPaid.length, 0)
  // An hour later the service answers (no payment), and the lock is past what the payment needs.
  step(3600_000); s.payStatusSays = null
  s.lockNever = 'the lock under hash … must start home in 900 s, and the other side can take 32400 s'
  r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 0, 'not paid')
  assert.equal(r.state, 'returned')
})

test('buying with BTC through the operator: resumed after a pause, a leaf not held any more sends the trade back to waiting, unpaid', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  s.receives[H].state = 'issuing'
  await eng.advance(eng.records()[0])
  s.ready = true; s.payStatusSays = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent'); assert.equal(r.leg, 'htlc-1'); assert.equal(s.btcPaid.length, 0)
  step(600_000); s.payStatusSays = null; s.ready = false
  r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 0, 'not paid')
  assert.equal(r.state, 'waiting')
  s.ready = true
  r = await eng.advance(eng.records()[0])
  assert.equal(s.btcPaid.length, 1, 'paid once it is held again')
})

// #839 (arca #969): a lock marked paid whose BTC payment then fails for good loses the
// mark before the trade comes back, so the wallet never takes it on the chain at its home date.
test('buying with BTC on a lock: a payment refused before it went out clears the lock\'s paid mark, then the trade comes back', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'failed', reason: 'refused before anything was sent' }
  const r = await eng.advance(eng.records()[0])
  assert.equal(s.payTried, 1); assert.equal(s.btcPaid.length, 0, 'nothing paid')
  assert.equal(r.state, 'returned'); assert.match(r.why, /refused before anything was sent/)
  assert.ok(s.calls.indexOf('lock_paid') < s.calls.indexOf('lock_unpaid'), 'marked before the payment, cleared after its failure')
  assert.equal(s.locks[0].paid, false, 'the library\'s mark is cleared')
  assert.equal(r.markedPaid, false)
})

test('buying with BTC on a lock: a payment failed back later (read on a later step) clears the mark too', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  s.payStatusSays = { state: 'pending' }
  assert.equal(r.state, 'sent'); assert.equal(r.markedPaid, true)
  assert.ok(!s.calls.includes('lock_unpaid'), 'in flight: the mark stays')
  s.payStatusSays = { state: 'failed', reason: 'no route paid it' }
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false); assert.equal(r.markedPaid, false)
  assert.equal(s.payTried, 1, 'paid once, never again')
})

test('buying with BTC on a lock: a payment in flight or of unknown state keeps the mark, and the row reads as today', async () => {
  const s = standIn()
  const { eng, step } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'pending' }
  let r = await eng.advance(eng.records()[0])
  s.payStatusSays = { state: 'pending' }
  for (let i = 0; i < 3; i++) { step(60_000); r = await eng.advance(eng.records()[0]) }
  assert.equal(r.state, 'sent'); assert.equal(tradeStateWord(r, r.sentAt), USER_WORDS.btcPaying)
  assert.equal(s.locks[0].paid, true); assert.equal(r.markedPaid, true)
  assert.ok(!s.calls.includes('lock_unpaid'))
})

test('buying with BTC on a lock: a library that does not answer the clearing is asked again, and only then the trade comes back', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'failed', reason: 'refused' }
  s.unpaidSilent = true
  let r = await eng.advance(eng.records()[0])
  s.payStatusSays = { state: 'failed', reason: 'refused' }
  assert.equal(r.markedPaid, true)
  assert.notEqual(r.state, 'returned', 'not back while the lock is marked'); assert.equal(s.locks[0].paid, true)
  s.unpaidSilent = false
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, false)
  assert.equal(s.payTried, 1, 'the failed payment is not made again')
})

test('buying with BTC on a lock: a library that refuses the clearing (the preimage known) leaves the mark; the trade still comes back', async () => {
  const s = standIn()
  const { eng } = await bought(s)
  s.locks[0].state = 'held'; s.lockFinal = true
  s.paySays = { state: 'failed', reason: 'refused' }
  s.unpaidRefuse = 'the preimage of hash … is known: the payment went through, and the lock is claimed with it'
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned'); assert.equal(s.locks[0].paid, true, 'the mark stays')
  assert.match(r.unmarkRefused, /preimage/)
})

test('buying with BTC through the operator: a failed payment asks nothing of the locks', async () => {
  const s = standIn(); s.makerLocks = []
  const { eng } = await bought(s)
  s.receives[H].state = 'issuing'
  await eng.advance(eng.records()[0])
  s.ready = true; s.paySays = { state: 'failed', reason: 'refused' }
  const r = await eng.advance(eng.records()[0])
  assert.notEqual(r.leg, 'htlc-2'); assert.equal(r.state, 'returned'); assert.equal(s.payTried, 1)
  assert.ok(!s.calls.includes('lock_paid') && !s.calls.includes('lock_unpaid'))
})
