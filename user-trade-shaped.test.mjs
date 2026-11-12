// A trade refused after the wallet paid itself the coin it gives (the library's `shaped`, arca
// #849): in default mode a trade paid from coins that leave change first pays the wallet one coin
// of exactly what it gives, and that payment's margins (`pays.shapes`, inside `pays.margins`) are
// on the ticket. Should the acceptance then be refused, that payment has moved and nothing else
// has: the trade is priced again at once into the same record, from the coin made, and those
// margins are counted once in what it paid and in its fees, never charged twice and never left off.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from './user-trade.js'
import { tradeRows } from './instant-history.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)
const SHAPES = 792n

// A stand-in library and maker. The wallet holds two coins of X; a trade from them shapes first.
// `refuseShaped` acceptances are refused after the shaping payment moved; `gone` completions are
// refused by the operator (the maker's offer gone).
function standIn ({ refuseShaped = 1, gone = 0 } = {}) {
  let coins = [{ leaf_id: 'c1', asset: X, value: '300000', state: 'live', kind: 'board' }, { leaf_id: 'c2', asset: X, value: '300000', state: 'live', kind: 'board' }]
  const swaps = new Map()
  const calls = []
  let n = 0
  const shaped = () => coins.some((c) => c.leaf_id.startsWith('shaped'))
  const shape = (need) => {
    coins.forEach((c) => { if (c.state === 'live') c.state = 'spent' })
    coins.push({ leaf_id: 'shaped' + (++n), asset: X, value: String(need), state: 'live', kind: 'transfer' })
    coins.push({ leaf_id: 'change' + n, asset: X, value: String(600000n - need - SHAPES), state: 'live', kind: 'transfer' })
  }
  const lib = {
    command (cmd, a) {
      calls.push(cmd)
      switch (cmd) {
        case 'coins': return coins.map((c) => ({ ...c }))
        case 'plans': return { plans: [] }
        case 'info': return { server_info: { depth_limit: 5 } }
        case 'swap_read': {
          const [, id, gets, gives] = a.offer.split(':')
          // Priced from the coin shaping makes: its one checkpoint margin, and the shaping payment's
          // margins until that coin is made.
          const s = shaped() ? 0n : SHAPES
          return { swap: id, gets: { asset: Y, value: gets }, gives: { asset: X, value: gives },
            pays: { asset: X, margins: String(192n + s), shapes: String(s) }, tops_up: { asset: Y, margin: '0' },
            change: { asset: X, value: '0' }, dates: { expiry: 1800000000 }, hops: 1, coins_spent: 1 }
        }
        case 'swap_accept': {
          const [, id, , gives] = a.offer.split(':')
          const needsShape = !shaped()
          if (needsShape) shape(BigInt(gives) + 192n)
          if (needsShape && refuseShaped > 0) {
            refuseShaped--
            const e = new Error(`refused: the wallet paid itself a coin of exactly what this trade gives first, which left ${SHAPES} of asset ${X} in margins`)
            e.kind = 'shaped'; e.asset = X; e.fee = String(SHAPES)
            throw e
          }
          swaps.set(id, { swap: id, role: 'taker', state: 'accepted' })
          const c = coins.find((x) => x.leaf_id.startsWith('shaped') && x.state === 'live')
          c.state = 'offered'; c.note = 'swap ' + id
          return { swap: id, accept: 'swap-accept:' + id, gets: a.shown.gets, pays: a.shown.pays }
        }
        case 'swaps': return [...swaps.values()].map((s) => ({ ...s }))
        case 'sync': return {}
        case 'swap_cancel': {
          const s = swaps.get(a.swap); s.state = 'cancelled'
          const d = coins.find((x) => x.note === 'swap ' + a.swap); d.state = 'live'; d.note = ''
          return { swap: a.swap, cancelled: true, freed: [d.leaf_id] }
        }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const offer = (give) => {
    const id = 'o' + (++n); const want = (BigInt(give) * 4n + 2n) / 3n
    return { swap: id, offer: `swap-offer:${id}:${give}:${want}`, give: String(give), want: String(want), expires_at: 4102444800 }
  }
  let goneLeft = gone
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    if (url.endsWith('/v1/firm')) return offer(b.give)
    if (url.endsWith('/v1/release')) return {}
    if (url.endsWith('/v1/accept')) {
      const s = swaps.get(b.swap)
      if (goneLeft > 0) {
        goneLeft--
        s.gone = { error: 'refused: the operator refused the swap\'s completion (409 double_spend); the offer is withdrawn', swap: b.swap, gone: true, code: 'double_spend', whose: 'maker' }
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
  return { lib, fetchJson, store, calls, coins: () => coins }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })
const feesIn = (t, a) => (t.fees || []).filter((f) => f.asset === a).reduce((s, f) => s + BigInt(f.atoms), 0n)

test('refused after its coin was made: priced again at once in the same record, the shaping margins counted once', async () => {
  const s = standIn({ refuseShaped: 1 })
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => 1_000_000 })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  assert.ok(feesIn(q.ticket, X) >= 192n + SHAPES, 'the first ticket shows the shaping margins in its fees: ' + JSON.stringify(q.ticket.fees))
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.state, 'repricing', 'never failed or returned: ' + JSON.stringify(rec))
  assert.equal(rec.shapeFees, String(SHAPES))
  const r = await eng.advance(eng.records()[0])
  assert.equal(eng.records().length, 1, 'the same record')
  assert.equal(r.id, rec.id)
  // The new ticket is priced from the coin made (no shaping now), and counts what was paid for it.
  assert.equal(BigInt(r.shapeFees ?? 0), SHAPES, 'what was paid already is kept on the record')
  assert.equal(feesIn(r.ticket, X), 192n + SHAPES, 'the fee line counts the shaping margins once: ' + JSON.stringify(r.ticket.fees))
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn) + 1n, 'what is paid is what the first ticket showed, within the price step: ' + r.ticket.amountIn)
  const done = await eng.advance(eng.records()[0])
  assert.equal(done.state, 'settled', JSON.stringify(done))
  const row = tradeRows(eng.records())[0]
  assert.equal(row.legs[0].atoms, '-' + r.ticket.amountIn, 'Activity: what was paid, the shaping margins in it')
  assert.equal(feesIn({ fees: row.fees }, X), 192n + SHAPES, 'Activity: the fees, the shaping margins in them')
})

test('accepted from a coin made first, then the maker\'s offer gone: the re-priced trade counts the shaping margins once', async () => {
  const s = standIn({ refuseShaped: 0, gone: 1 })
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => 1_000_000 })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  const rec = await eng.confirm(q.choice, q.ticket)
  assert.equal(rec.shapeFees, String(SHAPES), 'the shaping payment is paid once the acceptance is made')
  const r = await eng.advance(eng.records()[0])
  assert.equal(feesIn(r.ticket, X), 192n + SHAPES, JSON.stringify(r.ticket.fees))
  assert.ok(BigInt(r.ticket.amountIn) <= BigInt(q.ticket.amountIn) + 1n, 'not charged twice: ' + r.ticket.amountIn)
  const done = await eng.advance(eng.records()[0])
  assert.equal(done.state, 'settled', JSON.stringify(done))
})

test('refused after its coin was made, twice over: returned, naming the margins paid', async () => {
  const s = standIn({ refuseShaped: 2 })
  // The coin made is spent by the second refusal's own shaping in this stand-in: each refusal
  // leaves its margins.
  const lib = s.lib, orig = lib.command.bind(lib)
  lib.command = (cmd, a) => {
    if (cmd === 'swap_accept') s.coins().forEach((c) => { if (c.leaf_id.startsWith('shaped')) c.leaf_id = 'old-' + c.leaf_id })
    return orig(cmd, a)
  }
  const eng = createEngine({ leaves: lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => 1_000_000 })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  await eng.confirm(q.choice, q.ticket)
  const r = await eng.advance(eng.records()[0])
  assert.equal(r.state, 'returned', JSON.stringify(r))
  assert.deepEqual(r.feesPaid, [{ asset: X, atoms: String(2n * SHAPES) }])
})
