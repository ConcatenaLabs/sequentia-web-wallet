// One pass of the resting desk against stubbed library commands and a stubbed relay: an order the
// feed's mid moved through is cancelled; a new level that would cross the book's best bid is not
// rested, one clear of it is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { restDesk } from './leaf-maker-rest.mjs'

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
