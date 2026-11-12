// A maker that answers 200 {state: 'done'} to the acceptance but never completes it (RV41 P8 on
// web #692): the acceptance stays signed and completable at the maker's choice, so the page still
// takes its coins back in bounded time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, MAKER_COMPLETE_MS } from './user-trade.js'

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32)

function standIn () {
  const coins = [{ leaf_id: 'c1', asset: X, value: '3000000', state: 'live', kind: 'transfer' }]
  const swaps = new Map()
  const calls = []
  let n = 0
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
          const c = coins.find((x) => x.state === 'live'); c.state = 'offered'; c.note = 'swap ' + id
          return { swap: id, accept: 'swap-accept:' + id }
        }
        case 'swaps': return [...swaps.values()].map((s) => ({ ...s }))
        case 'sync': case 'mailbox': return {}
        case 'swap_cancel': {
          const s = swaps.get(a.swap); s.state = 'cancelled'
          const d = coins.find((x) => x.note === 'swap ' + a.swap); d.state = 'live'; d.note = ''
          return { swap: a.swap, cancelled: true, respent: [] }
        }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  const fetchJson = async (url, init) => {
    if (url.endsWith('/v1/quotes')) return { quotes: [{ give_asset: Y, want_asset: X, rate_num: '4', rate_den: '3', max_give: '1000000', min_give: '10000' }] }
    const b = init && init.body ? JSON.parse(init.body) : {}
    if (url.endsWith('/v1/firm')) { const id = 'o' + (++n); const want = (BigInt(b.give) * 4n + 2n) / 3n; return { swap: id, offer: `swap-offer:${id}:${b.give}:${want}`, give: String(b.give), want: String(want), expires_at: 4102444800 } }
    if (url.endsWith('/v1/release')) return {}
    // The maker says done and completes nothing: it holds the signed acceptance.
    if (url.endsWith('/v1/accept')) return { swap: b.swap, state: 'done' }
    return {}
  }
  const store = { m: {}, getItem (k) { return this.m[k] ?? null }, setItem (k, v) { this.m[k] = v } }
  return { lib, fetchJson, store, calls, swaps, coins }
}

const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker'] }] } } }, genesis: 'g' })

test('P8: a maker that says done and never completes: the page takes its coins back in bounded time', async () => {
  const s = standIn()
  let t = 1_000_000
  const eng = createEngine({ leaves: s.lib, fetchJson: s.fetchJson, makers: () => ['http://m'], admitted, store: s.store, now: () => t })
  const q = await eng.quote({ payAsset: X, receiveAsset: Y, amount: '400000' })
  assert.ok(q.ok, q.why)
  const rec = await eng.confirm(q.choice, q.ticket)
  console.log('P8 after confirm:', rec.state, 'makerDone', rec.makerDone)
  let r = rec
  for (let h = 0; h < 48; h++) { t += 3_600_000; r = await eng.advance(eng.records()[0]) }
  console.log('P8 after 48 hours:', r.state, 'swap', [...s.swaps.values()].map((x) => x.state), 'coins', s.coins.map((c) => c.state),
    'swap_cancel called', s.calls.includes('swap_cancel'), 'MAKER_COMPLETE_MS', MAKER_COMPLETE_MS)
  assert.ok(s.calls.includes('swap_cancel'), 'the coins signed into an acceptance the maker never completed are taken back')
})
