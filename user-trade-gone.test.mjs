// A maker that answers "the offer is gone" (the operator refused its completion, web wallet #685):
// the trade takes its coins back at once and is priced again for what the person accepted, going
// ahead in the same record only at that price or better, the maker's own offer made in its place
// taken first; otherwise it comes back with the words it has. Never the two minutes' wait for an
// answer that cannot change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, tradeStateWord } from './user-trade.js'
import { tradeRows } from './instant-history.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)

// A stand-in library and maker. The maker's first completion is refused by the operator: it
// answers 409 gone, with an offer made in its place at `again` (null: none), and later asks of the
// same acceptance get the same answer.
function standIn ({ again = 'same', rateNum = 4n, always = false, respend = 0n, whose = 'taker', unknown = 0, refusals = 1 } = {}) {
  const coins = [{ leaf_id: 'dead', asset: X, value: '3000000', state: 'live', kind: 'transfer' }]
  const swaps = new Map()
  const calls = []
  const posts = []
  let n = 0
  let refusedOnce = false
  let refusedN = 0
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'swap_read': {
          const [, id, gets, gives] = a.offer.split(':')
          return { swap: id, gets: { asset: Y, value: gets }, gives: { asset: X, value: gives }, pays: { asset: X, margins: '192' },
            change: { asset: X, value: '1000' }, dates: { expiry: 1800000000 }, hops: 1 }
        }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_accept': {
          const [, id] = a.offer.split(':')
          swaps.set(id, { swap: id, role: 'taker', state: 'accepted' })
          // The first acceptance names the coin a second device gave to a round; later ones the coin
          // that replaced it, which the cancel's catch-up brought.
          const c = coins.find((x) => x.state === 'live')
          c.state = 'offered'; c.note = 'swap ' + id
          return { swap: id, accept: 'swap-accept:' + id }
        }
        case 'swaps': return [...swaps.values()].map((s) => ({ ...s }))
        case 'sync': return {}
        case 'swap_cancel': {
          const s = swaps.get(a.swap)
          // The answer to the cancel's respend has not come: the library does not know yet.
          if (unknown > 0) { unknown--; return { swap: a.swap, cancelled: false, acceptance_stands: true, unknown: true } }
          s.state = 'cancelled'
          // The library's cancel: the respend is refused for the dead coin, the wallet catches up
          // (the dead coin spent, the round's coin taken), and the acceptance is cancelled.
          const d = coins.find((x) => x.note === 'swap ' + a.swap)
          // The maker's coin was refused: the taker's own coin is respent to a fresh one of its own,
          // which leaves the transfer's margins.
          if (respend > 0n) {
            const v = BigInt(d.value) - respend
            d.state = 'spent'
            coins.push({ leaf_id: 'self' + (++n), asset: X, value: String(v), state: 'live', kind: 'transfer' })
            return { swap: a.swap, cancelled: true, respent: [d.leaf_id] }
          }
          d.state = 'spent'
          coins.push({ leaf_id: 'round' + (++n), asset: X, value: '3000000', state: 'live', kind: 'batch' })
          return { swap: a.swap, cancelled: true, spent_elsewhere: [d.leaf_id], freed: [] }
        }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const made = new Map()
  // A maker that quotes nothing for a while (reading its coins again after a trade).
  const silent = { on: false }
  const offer = (give, rn = 4n) => {
    const id = 'o' + (++n); const want = (BigInt(give) * rn + 2n) / 3n
    const o = { swap: id, offer: `swap-offer:${id}:${give}:${want}`, give: String(give), want: String(want), expires_at: 4102444800 }
    made.set(id, o)
    return o
  }
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: String(rateNum), rate_den: '3', max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    posts.push([url.split('/v1/')[1], b])
    if (url.endsWith('/v1/firm')) return offer(b.give, posts.filter(([p]) => p === 'firm').length > 1 ? rateNum + (again === 'worse' ? 1n : 0n) : 4n)
    if (url.endsWith('/v1/release')) return {}
    if (url.endsWith('/v1/accept')) {
      const s = swaps.get(b.swap)
      if (!refusedOnce || refusedN < refusals || s.gone || always) {
        if (!s.gone) refusedN++
        refusedOnce = refusedN >= refusals
        if (!s.gone) {
          const first = made.get(b.swap)
          s.gone = { error: 'refused: the operator refused the swap\'s completion (409 double_spend): leaf dead… is already spent; the offer is withdrawn',
            swap: b.swap, gone: true, code: 'double_spend', whose, coin: 'dead', ...(again === 'same' ? { offer: offer(first.give) } : {}) }
        }
        const e = new Error(s.gone.error); e.status = 409; e.body = s.gone; throw e
      }
      s.state = 'done'
      coins.find((x) => x.note === 'swap ' + b.swap).state = 'spent'
      coins.push({ leaf_id: 'got-' + b.swap, asset: Y, value: '1', state: 'live', kind: 'transfer' })
      return { swap: b.swap, state: 'done' }
    }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson: async (u, i) => (silent.on && u.endsWith('/v1/quotes') ? { quotes: [] } : fetchJson(u, i)), store, calls, posts, swaps, coins, silent,
    markRefused: () => { refusedOnce = true; refusedN = refusals } }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })

test('a gone offer: the coins come back at once and the maker\'s offer made in its place completes the trade in the same record', async () => {
  const s = standIn({ again: 'same' })
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'sent')
  assert.equal(rec.gone && rec.gone.whose, 'taker', 'the first hand-over\'s answer is read')
  const firms = s.posts.filter(([p]) => p === 'firm').length
  const r = await eng.advance(eng.records()[0])
  // The clock stood still: acted on at once, not after the two minutes the engine gives a maker.
  assert.equal(t - rec.sentAt, 0)
  assert.ok(s.calls.includes('swap_cancel'), 'the dead acceptance is cancelled')
  assert.equal(s.posts.filter(([p]) => p === 'firm').length, firms, 'the offer made in its place is taken, no new one asked')
  assert.equal(eng.records().length, 1, 'one record: the trade is never made twice')
  assert.equal(r.id, rec.id)
  assert.notEqual(r.swap, rec.swap, 'it goes ahead on the new offer')
  assert.deepEqual(r.gave.map((g) => g.swap), [rec.swap])
  assert.ok(BigInt(r.ticket.amountOut) >= BigInt(q.ticket.amountOut) && BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn), 'no worse than the ticket')
  const done = await eng.advance(eng.records()[0])
  assert.equal(done.state, 'settled', JSON.stringify(done))
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 1, 'exactly one swap done')
})

test('a gone offer with no offer in its place, and the maker now asking more: returned with words, at once', async () => {
  const s = standIn({ again: 'worse' })
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng.confirm(q.choice, q.ticket)
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned', JSON.stringify(r))
  assert.equal(r.whyKind, 'moved', 'said as a price that moved')
  assert.equal(t - rec.sentAt, 0, 'at once: the clock stood still')
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 0, 'nothing traded')
  assert.ok(!s.posts.some(([p, b]) => p === 'accept' && b.swap !== rec.swap), 'no other offer was accepted')
})

test('a maker whose offers are gone again and again: the trade comes back with words after three, never asking on and on', async () => {
  const s = standIn({ again: 'same', always: true })
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  await eng.confirm(q.choice, q.ticket)
  let r = null
  for (let i = 0; i < 6; i++) r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned', JSON.stringify(r))
  assert.equal(r.gave.length, 3)
  assert.notEqual(r.whyKind, 'moved', 'not said as a price that moved: it may not have')
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 0, 'nothing traded')
  assert.ok(s.posts.some(([p]) => p === 'release'), 'the last offer made in place of a gone one is let go of')
})

test('a maker that answers done after the wait: the trade settles, its coins never taken back', async () => {
  const s = standIn({ again: 'same' })
  let t = 1_000_000
  // The maker is away at the confirmation (no answer), and completes later, after the two minutes.
  const real = s.fetchJson
  let away = true
  const eng2 = createEngine({ leaves: s.lib, fetchJson: async (u, i) => { if (away && u.endsWith('/v1/accept')) throw new Error('fetch failed'); return real(u, i) },
    makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q2 = await eng2.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng2.confirm(q2.choice, q2.ticket)
  assert.equal(rec.state, 'sent')
  t += 130_000
  away = false
  // The stand-in completes an acceptance on its second hand-over only when it refused the first:
  // mark it refused-once already so this hand-over completes, answering done.
  s.markRefused()
  const r = await eng2.advance(eng2.records().find((x) => x.id === rec.id))
  assert.ok(!s.calls.includes('swap_cancel'), 'no cancel after a done answer')
  assert.equal(r.state, 'settled', JSON.stringify(r))
})

test('a gone offer whose cancel respent the coins: the re-priced trade counts the respend\'s margins in what it paid and in its fees', async () => {
  const s = standIn({ again: 'same', respend: 500n, whose: 'maker' })
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.gone && rec.gone.whose, 'maker')
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.cancelFees, '500', 'the respend left 500')
  const fees = (r.ticket.fees || []).filter((f) => f.asset === X).reduce((n, f) => n + BigInt(f.atoms), 0n)
  const before = (q.ticket.fees || []).filter((f) => f.asset === X).reduce((n, f) => n + BigInt(f.atoms), 0n)
  assert.equal(fees, before + 500n, 'the fee line counts the respend\'s margins: ' + JSON.stringify(r.ticket.fees))
  assert.equal(BigInt(r.ticket.amountIn), BigInt(r.accepted.amountIn) + 500n, 'what is paid counts them too, so the fees are included in it')
  const done = await eng.advance(eng.records()[0])
  assert.equal(done.state, 'settled', JSON.stringify(done))
})

test('a gone offer whose earlier cancel left the coins sending: the respend\'s margins are still counted', async () => {
  const s = standIn({ again: 'same', respend: 700n, whose: 'maker' })
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  await eng.confirm(q.choice, q.ticket)
  // An earlier cancel's respend went unanswered: the coin waits for it.
  s.coins.find((c) => c.state === 'offered').state = 'sending'
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.cancelFees, '700', JSON.stringify(r))
})

test('a gone offer with no offer in its place while the maker quotes nothing: asked again, not returned, and goes ahead once it quotes', async () => {
  const s = standIn({ again: 'none' })
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng.confirm(q.choice, q.ticket)
  s.silent.on = true
  t += 10_000
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'repricing', 'a maker quoting nothing this moment is asked again: ' + JSON.stringify(r))
  t += 20_000
  s.silent.on = false
  let r2 = r
  for (let i = 0; i < 3 && r2.state !== 'settled'; i++) { t += 5_000; r2 = await eng.advance(eng.records()[0]) }
  assert.equal(r2.state, 'settled', JSON.stringify(r2))
  assert.equal(r2.id, rec.id)
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 1, 'exactly one swap done')
})

test('a cancel whose answer has not come: the trade waits, says so in words, and is never traded again until it is known', async () => {
  const s = standIn({ again: 'same', unknown: 2 })
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng.confirm(q.choice, q.ticket)
  let r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'sent', JSON.stringify(r))
  assert.equal(r.swap, rec.swap, 'not traded again')
  t += 60_000
  assert.equal(tradeStateWord(r, t), 'Sent, waiting for an answer: nothing more is needed from you (1 min)')
  r = await eng.advance(eng.records()[0])
  assert.equal(r.swap, rec.swap, 'still not traded again')
  r = await eng.advance(eng.records()[0])
  assert.notEqual(r.swap, rec.swap, 'once the cancel is known, priced again')
  assert.ok(!r.awaiting)
  const done = await eng.advance(eng.records()[0])
  assert.equal(done.state, 'settled', JSON.stringify(done))
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 1, 'exactly one swap done')
})

// An undone trade's history row shows what was paid coming back: the swap's own amount, never the
// respend margins a cancel left (they are spent, and counted in the record's ticket once it was
// priced again). Whether the margins came before the ticket of the trade that settled (one gone) or
// over two gones of the same record, the row is the last swap's amount.
for (const gones of [1, 2]) {
  test(`an undone trade after ${gones} gone offer(s) with respends: its row shows the swap's amount coming back, not the margins`, async () => {
    const s = standIn({ again: 'same', respend: 500n, whose: 'maker', refusals: gones })
    const t = 1_000_000
    const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
    const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
    await eng.confirm(q.choice, q.ticket)
    let r = null
    for (let i = 0; i < 6 && (!r || r.state !== 'settled'); i++) r = await eng.advance(eng.records()[0])
    assert.equal(r.state, 'settled', JSON.stringify(r))
    assert.equal(r.gave.length, gones)
    assert.equal(r.cancelFees, String(500n * BigInt(gones)))
    assert.equal(BigInt(r.ticket.amountIn), BigInt(q.ticket.amountIn) + 500n * BigInt(gones), 'the ticket counts every respend once')
    // The swap that settled is dead (a rollback of its anchor): the trade is undone.
    s.swaps.get(r.swap).state = 'returning'
    await eng.resume()
    const u = eng.records()[0]
    assert.equal(u.state, 'undone')
    const row = tradeRows([u])[0]
    assert.deepEqual(row.legs, [{ asset: X, atoms: '-' + q.ticket.amountIn }], 'what comes back is the swap\'s amount')
  })
}

test('an acceptance refused before it is signed, its coin spent elsewhere, is priced again into the same record (#710)', async () => {
  // The wallet shapes its coin first by paying itself; the operator refuses that payment because a
  // second device gave the coin to a round. The library catches up: the coin is spent, the round's
  // coin held. The trade is priced again, as a maker's gone offer is, not returned.
  const s = standIn({ refusals: 0 })
  const DEAD = 'd0'.repeat(32)
  s.coins[0].leaf_id = DEAD
  s.markRefused()
  const lib = s.lib.command.bind(s.lib)
  let once = false
  s.lib.command = (cmd, a) => {
    if (cmd === 'swap_accept' && !once) {
      once = true
      s.coins[0].state = 'spent'
      s.coins.push({ leaf_id: 'roundcoin', asset: X, value: '3000000', state: 'live', kind: 'batch' })
      const e = new Error(`refused: the server refused cosign_transfer (409 double_spend): leaf ${DEAD} is already spent: the server co-signs one spend of a leaf`)
      e.kind = 'server_refused'; throw e
    }
    return lib(cmd, a)
  }
  const t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'repricing', 'not returned: priced again')
  assert.equal(rec.gave.length, 1)
  assert.ok(s.posts.some(([p, b]) => p === 'release' && b.swap === q.choice.offer.swap), 'the refused offer is let go of')
  let r = await eng.advance(eng.records()[0])
  assert.equal(eng.records().length, 1, 'one record')
  assert.equal(r.state, 'sent', JSON.stringify(r))
  r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'settled', JSON.stringify(r))
  assert.equal([...s.swaps.values()].filter((x) => x.state === 'done').length, 1, 'exactly one swap done')
  assert.equal(tradeStateWord(r), tradeStateWord({ state: 'settled' }))
})
