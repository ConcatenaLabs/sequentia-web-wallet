// What the leaf maker asks of its library, which runs one command at a time: a firm offer waits for
// the command running when it comes, so the upkeep's commands read only what the maker uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HELD_COINS, swapsArgs, swapStates } from './leaf-maker.mjs'
import { restDesk, restingArgs, RESTING_PER_READ } from './leaf-maker-rest.mjs'

const G = 'aa'.repeat(32), W = 'bb'.repeat(32)

test('the maker reads the coins it holds, each as the store holds it', () => {
  assert.deepEqual({ ...HELD_COINS }, { held: true, brief: true })
})

test('a swap is followed by its id, and one the library does not know has no state', () => {
  assert.deepEqual(swapsArgs(['s1', 's2']), { swaps: ['s1', 's2'] })
  const st = swapStates([{ swap: 's1', state: 'open' }, { swap: 's9', state: 'done' }], ['s1', 's2'])
  assert.equal(st.get('s1'), 'open')
  assert.equal(st.get('s2'), null)
  // A library without the argument answers every swap: the same reading finds the ones asked.
  assert.equal(swapStates([{ swap: 's0', state: 'done' }, { swap: 's2', state: 'cancelled' }], ['s2']).get('s2'), 'cancelled')
})

test('the resting desk follows its orders by their ids, a read of the operator a command, never every order it rested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rest-desk-'))
  const now = Math.floor(Date.now() / 1000)
  // 100 orders followed, and one just rested whose order id the library's store has since learnt.
  const recs = Array.from({ length: 100 }, (_, i) => ({ slot: `${G}:${W}#${i}`, rested_by: 'r' + i, order: 'o' + i, offer_id: 'f' + i, amount: '1000', rate_num: '1000', rate_den: '1000', at: now }))
  recs.push({ slot: `${G}:${W}#new`, rested_by: 'rn', order: null, offer_id: 'fn', amount: '1000', rate_num: '1000', rate_den: '1000', at: now })
  writeFileSync(join(dir, 'rest-orders.json'), JSON.stringify(recs))
  const calls = []
  const cmd = async (name, args) => {
    calls.push([name, args])
    if (name === 'info') return { server: 'http://op', operator: 'k', server_info: {} }
    if (name === 'order_resting') {
      return { orders: [{ rested_by: 'rn', order: 'on', state: 'published' }],
        others: (args.orders || []).map((o) => ({ order: o, state: 'resting', value: '1000', coin: 'c-' + o, asset: G, terms: { asset_b: W, rate_num: '1000', rate_den: '1000', min_lot: '10', expiry: 9e9 } })) }
    }
    return {}
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ offers: [], best_bid: 0 }))
  try {
    const cfg = { store_dir: dir, prices: { spread_bps: 0 }, rest: { relay: 'http://relay', interval_seconds: 0, max_new_per_pass: 0,
      pairs: [{ give: G, want: W, rate_num: '1000', rate_den: '1000', ladder: { levels: 1, first: '1000' } }] } }
    const desk = await restDesk({ cfg, cmd, log: () => {}, liveRates: () => new Map(), spendable: async () => new Map() })
    const changed = await desk.tick()
    const reads = calls.filter((c) => c[0] === 'order_resting').map((c) => c[1])
    assert.ok(reads.every((a) => a.brief === true), 'every read leaves the desk\'s own to the store')
    assert.ok(reads.every((a) => a.orders.length <= RESTING_PER_READ))
    assert.equal(reads.length, Math.ceil(101 / RESTING_PER_READ), 'the 101 orders in as few commands as the bound allows')
    assert.deepEqual(new Set(reads.flatMap((a) => a.orders)), new Set([...recs.slice(0, 100).map((r) => r.order), 'on']), 'each followed order asked once, the new one by the id the store gave it')
    assert.equal(desk.records().find((r) => r.rested_by === 'rn').order, 'on')
    assert.equal(changed, false, 'nothing rested or cancelled')
  } finally { globalThis.fetch = realFetch }
  assert.deepEqual(restingArgs(['a']), { orders: ['a'], brief: true })
})
