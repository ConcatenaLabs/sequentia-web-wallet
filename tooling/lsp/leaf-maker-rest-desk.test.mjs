// One pass of the resting desk against stubbed library commands and a stubbed relay: an order the
// feed's mid moved through is cancelled; a new level that would cross the book's best bid is not
// rested, one clear of it is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { restDesk, restUpkeep } from './leaf-maker-rest.mjs'

const G = 'aa'.repeat(32), W = 'bb'.repeat(32)

test('a pass cancels an order the mid moved through and never rests a level through the best bid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rest-desk-'))
  // one order resting at 1.003 want per give (slot level 0), recorded by an earlier pass
  writeFileSync(join(dir, 'rest-orders.json'), JSON.stringify([{ slot: `${G}:${W}#0`, rested_by: 'r0', order: 'o0', offer_id: 'f0', amount: '1000', rate_num: '1003', rate_den: '1000', at: Math.floor(Date.now() / 1000) }]))
  const calls = []
  const cmd = async (name, args) => {
    calls.push([name, args])
    if (name === 'info') return { server: 'http://op', operator: 'k', server_info: {} }
    if (name === 'order_resting') return args && args.orders ? { others: [{ order: 'o0', state: 'resting', value: '1000', coin: 'c0', asset: G, terms: { asset_b: W, rate_num: '1003', rate_den: '1000', min_lot: '10', expiry: 9e9 } }] } : { orders: [{ rested_by: 'r0', order: 'o0' }] }
    if (name === 'order_rest') return { order: 'r' + calls.length }
    return {}
  }
  const bids = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/ticker')) { bids.push(u); return new Response(JSON.stringify({ best_bid: 1.0035 })) } // someone bids 1.0035
    return new Response(JSON.stringify({ offers: [] }))
  }
  try {
    const cfg = { store_dir: dir, prices: { spread_bps: 0 }, rest: { relay: 'http://relay', interval_seconds: 0, guard_bps: 10, max_new_per_pass: 6,
      pairs: [{ give: G, want: W, price: true, ladder: { levels: 3, step_bps: 25, growth: 1, first: '1000' } }] } }
    // the feed has moved: mid 1.002, so the order at 1.003 is within 10 bps of it
    const rates = new Map([[`${G}:${W}`, { rate_num: '1002', rate_den: '1000' }]])
    const desk = await restDesk({ cfg, cmd, log: () => {}, liveRates: () => rates, spendable: async () => new Map([[G, 10n ** 9n]]) })
    await desk.tick()
    const names = calls.map((c) => c[0])
    assert.ok(names.includes('order_cancel_resting'), 'the stale order is cancelled')
    assert.equal(desk.records().find((r) => r.order === 'o0').done, 'repriced')
    // level 0 at 1.002 is under the bid 1.0035; levels 1 and 2 (1.005, 1.008 in whole atoms) are clear of it
    const rested = calls.filter((c) => c[0] === 'order_rest').map((c) => Number(c[1].rate_num) / Number(c[1].rate_den))
    assert.deepEqual(rested, [1.005, 1.008], 'levels 1 and 2 rested, level 0 not')
    assert.ok(rested.every((x) => x > 1.0035 * 1.001), 'every rested level is clear of the best bid')
    assert.equal(bids.length, 1, 'the ticker is read once a pair')
  } finally { globalThis.fetch = realFetch }
})

// Seen live: a cancel costs the order's coin a fee (2,368 atoms of tSEQ), so a level rested again at
// its full size could not be paid from its own cancelled coin, and the library took the maker's
// largest coin instead, whose change the operator fronted again beside the resting order.
test('a repriced level is rested again at what its cancelled coin came back with', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rest-desk-'))
  writeFileSync(join(dir, 'rest-orders.json'), JSON.stringify([{ slot: `${G}:${W}#0`, rested_by: 'r0', order: 'o0', offer_id: 'f0', amount: '28625282061', rate_num: '1100', rate_den: '1000', at: Math.floor(Date.now() / 1000) }]))
  const calls = []
  const cmd = async (name, args) => {
    calls.push([name, args])
    if (name === 'info') return { server: 'http://op', operator: 'k', server_info: {} }
    if (name === 'order_resting') return args && args.orders ? { others: [{ order: 'o0', state: 'resting', value: '28625282061', coin: 'c0', asset: G, terms: { asset_b: W, rate_num: '1100', rate_den: '1000', min_lot: '10', expiry: 9e9 } }] } : { orders: [{ rested_by: 'r0', order: 'o0' }] }
    if (name === 'order_cancel_resting_quote') return { coin: 'c0', holds: '28625282061', fee: { amount: '2368' }, gets: { amount: String(28625282061 - 2368) } }
    if (name === 'order_rest') return { order: 'r' + calls.length }
    return {}
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/ticker') ? { best_bid: 0 } : { offers: [] }))
  try {
    const cfg = { store_dir: dir, prices: { spread_bps: 0 }, rest: { relay: 'http://relay', interval_seconds: 0, guard_bps: 10, reprice_bps: 300, max_new_per_pass: 6,
      pairs: [{ give: G, want: W, price: true, ladder: { levels: 2, step_bps: 25, growth: 1.3, first: '28625282061' } }] } }
    // the feed moved 10 %: the order is repriced (cancelled) on this pass and rested on the next
    const rates = new Map([[`${G}:${W}`, { rate_num: '1000', rate_den: '1000' }]])
    const desk = await restDesk({ cfg, cmd, log: () => {}, liveRates: () => rates, spendable: async () => new Map([[G, 10n ** 15n]]) })
    await desk.tick()
    assert.equal(desk.records().find((r) => r.order === 'o0').done, 'repriced')
    const rests = calls.filter((c) => c[0] === 'order_rest').map((c) => c[1].amount)
    // level 0 at its coin's value, level 1 (never cancelled) at its full size
    assert.deepEqual(rests, [String(28625282061 - 2368), String(Math.floor(28625282061 * 1.3))])
    await desk.tick()
    assert.equal(calls.filter((c) => c[0] === 'order_rest').length, 2, 'the cancelled coin is used once')
  } finally { globalThis.fetch = realFetch }
})

// arca #908: an order the operator holds at its depth limit could be neither filled, cancelled nor
// refreshed. The desk refreshes an order before it gets there, and never asks for a cancel its depth
// no longer allows.
test('the upkeep refreshes an order near the depth limit or out of fills, and cancels only what it can', () => {
  const at = (hops, state = 'resting') => ({ state, hops })
  const o = { depthLimit: 5, refreshKeeps: true }
  assert.equal(restUpkeep(at(0), o), null, 'a fresh order is left alone')
  assert.equal(restUpkeep(at(2), o), null, 'three short of the limit')
  assert.equal(restUpkeep(at(3), o), 'refresh', 'within two reassignments of the limit')
  assert.equal(restUpkeep(at(1, 'exhausted'), o), 'refresh', 'its four fills used')
  assert.equal(restUpkeep(at(3), { ...o, wantsCancel: true }), 'cancel', 'a cancel it can take goes first')
  assert.equal(restUpkeep(at(5), { ...o, wantsCancel: true }), 'refresh', 'at the limit: refreshed, cancelled on a later pass')
  assert.equal(restUpkeep(at(4), { ...o, wantsCancel: true }), 'cancel', 'one short of the limit: the cancel lands at it')
  assert.equal(restUpkeep(at(5), { depthLimit: 5, refreshKeeps: false, wantsCancel: true }), null, 'an older operator: nothing it can do')
  assert.equal(restUpkeep(at(1, 'exhausted'), { depthLimit: 5 }), 'cancel', 'an older operator: an exhausted order is cancelled')
  assert.equal(restUpkeep(at(0, 'refreshing'), o), null)
  assert.equal(restUpkeep(at(3), { refreshKeeps: true }), null, 'no depth limit published')
})

test('a pass refreshes the order stuck at the limit instead of asking for a cancel, and leaves a refresh under way alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rest-desk-'))
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(join(dir, 'rest-orders.json'), JSON.stringify([
    { slot: `${G}:${W}#0`, rested_by: 'r0', order: 'o0', offer_id: 'f0', amount: '1000', rate_num: '1100', rate_den: '1000', at: now },
    { slot: `${G}:${W}#1`, rested_by: 'r1', order: 'o1', offer_id: 'f1', amount: '1000', rate_num: '1100', rate_den: '1000', at: now },
  ]))
  const calls = []
  const terms = { asset_b: W, rate_num: '1100', rate_den: '1000', min_lot: '10', expiry: 9e9 }
  const cmd = async (name, args) => {
    calls.push([name, args])
    if (name === 'info') return { server: 'http://op', operator: 'k', server_info: { depth_limit: 5, fills: { refresh_keeps_order: true } } }
    if (name === 'order_resting') {
      // o0 is the testnet's: five reassignments deep, off the feed's price; o1's refresh is under way,
      // its old coin read as cancelled by the operator until the new one is published
      // the library's answer: its own orders as its store holds them, and the operator's view of those asked
      return { orders: [{ rested_by: 'r0', order: 'o0', state: 'published' }, { rested_by: 'r1', order: 'o1', state: 'refreshing' }],
        others: [{ order: 'o0', state: 'resting', hops: 5, whole_only: true, value: '1000', coin: 'c0', asset: G, terms },
          { order: 'o1', state: 'cancelled', hops: 1, value: '1000', coin: 'c1', asset: G, terms }] }
    }
    if (name === 'order_refresh_resting_quote') return { coin: 'c0', fee: { amount: '0' }, gives: ['c0'] }
    if (name === 'order_refresh_resting') return { state: 'refreshing' }
    return {}
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/ticker') ? { best_bid: 0 } : { offers: [] }))
  try {
    const cfg = { store_dir: dir, prices: { spread_bps: 0 }, rest: { relay: 'http://relay', interval_seconds: 0, guard_bps: 10, reprice_bps: 300, max_new_per_pass: 0,
      pairs: [{ give: G, want: W, price: true, ladder: { levels: 2, step_bps: 25, growth: 1, first: '1000' } }] } }
    const rates = new Map([[`${G}:${W}`, { rate_num: '1000', rate_den: '1000' }]])
    const desk = await restDesk({ cfg, cmd, log: () => {}, liveRates: () => rates, spendable: async () => new Map([[G, 10n ** 9n]]) })
    await desk.tick()
    const names = calls.map((c) => c[0])
    assert.ok(!names.includes('order_cancel_resting'), 'no cancel of an order at the limit')
    assert.deepEqual(calls.filter((c) => c[0] === 'order_refresh_resting').map((c) => c[1].order), ['o0'], 'o0 refreshed, as quoted')
    assert.equal(calls.find((c) => c[0] === 'order_refresh_resting')[1].shown.coin, 'c0')
    assert.equal(desk.records().find((r) => r.order === 'o0').done, undefined, 'o0 is still the level\'s order')
    assert.equal(desk.records().find((r) => r.order === 'o1').done, undefined, 'o1, mid-refresh, is not taken for cancelled')
  } finally { globalThis.fetch = realFetch }
})
