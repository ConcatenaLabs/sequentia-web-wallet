// The composer's trade records are bounded: a list grown past the bound still saves, an unfinished
// trade's record is never dropped, and a store with no room refuses the trade before anything is
// signed. The store stands in for localStorage, which throws once its quota is reached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from './user-trade.js'

const { createEngine } = engine
// The bounds as the engine states them (200 ended trades, 1 MB), so a run against an engine without
// them fails on what it does, not on its imports.
const KEEP_ENDED = engine.KEEP_ENDED ?? 200, KEEP_BYTES = engine.KEEP_BYTES ?? 1_000_000

const KEY = 'swk.usertrade.default'
const SIGNING = ['transfer', 'swap_offer', 'swap_accept', 'swap_complete', 'participate', 'order_fill_resting', 'order_place', 'offboard', 'take']

// A store holding at most `quota` characters in all, as localStorage does; `kept` is what it
// holds before the engine starts (written while there was room).
function quotaStore (quota, kept = {}) {
  const mem = new Map(Object.entries(kept))
  return {
    mem,
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      let used = 0
      for (const [kk, vv] of mem) if (kk !== k) used += kk.length + vv.length
      if (used + k.length + v.length > quota) { const e = new Error('QuotaExceededError: the quota has been exceeded'); e.name = 'QuotaExceededError'; throw e }
      mem.set(k, v)
    },
  }
}
const ended = (i, pad = 4000) => ({ id: `old-${i}`, at: 1000 + i, state: 'settled', ticket: { note: 'x'.repeat(pad) } })
const open = (id) => ({ id, at: 999, state: 'sent', ticket: { note: 'still moving' } })

// An engine whose library refuses nothing it is asked and records each command: a trade from an
// unknown source fails at its first step, after its record is written.
function engineOver (store) {
  const calls = []
  const leaves = { command (cmd) { calls.push(cmd); if (cmd === 'info') return { operator: 'ab'.repeat(32) }; return [] } }
  const eng = createEngine({ leaves, fetchJson: async () => ({}), makers: () => [], relayBook: async () => [], relayFills: async () => [],
    admitted: () => ({ pairs: {}, genesis: 'g' }), store })
  return { eng, calls }
}
const choice = { source: 'none-such' }
const ticket = { payAsset: 'aa'.repeat(32), receiveAsset: 'bb'.repeat(32), pay: '1', receive: '1' }
const saved = (store) => JSON.parse(store.mem.get(KEY))

test('a list grown past the bound still saves, with the newest ended trades and the new one', async () => {
  // 600 ended trades of about 4 kB: 2.4 MB, written while the store had room for it.
  const list = Array.from({ length: 600 }, (_, i) => ended(i))
  const store = quotaStore(2_500_000, { [KEY]: JSON.stringify(list) })
  const { eng } = engineOver(store)
  await eng.confirm(choice, ticket).catch(() => {})
  const after = saved(store)
  const ids = after.map((r) => r.id)
  assert.ok(ids.some((id) => !id.startsWith('old-')), 'the new trade\'s record is kept')
  const endedKept = after.filter((r) => r.state === 'settled')
  assert.ok(endedKept.length <= KEEP_ENDED, `at most ${KEEP_ENDED} ended trades kept, not ${endedKept.length}`)
  assert.ok(JSON.stringify(after).length <= KEEP_BYTES + 10_000, 'within the byte bound')
  assert.equal(endedKept.at(-1).id, 'old-599', 'the newest ended trade stays')
  assert.ok(!ids.includes('old-0'), 'the oldest goes first')
})

test('an unfinished trade\'s record survives the trim, however old', async () => {
  const list = [open('oldest-open'), ...Array.from({ length: 400 }, (_, i) => ended(i, 100)), open('newer-open')]
  const store = quotaStore(10_000_000, { [KEY]: JSON.stringify(list) })
  const { eng } = engineOver(store)
  await eng.confirm(choice, ticket).catch(() => {})
  const after = saved(store)
  const ids = after.map((r) => r.id)
  assert.ok(ids.includes('oldest-open') && ids.includes('newer-open'), 'both unfinished trades kept')
  assert.equal(after.filter((r) => r.state === 'settled').length, KEEP_ENDED, 'the ended ones trimmed to the bound')
  assert.equal(ids[0], 'oldest-open', 'the order is kept')
})

test('a store with no room refuses the trade before anything is signed, in plain words', async () => {
  // Room for the unfinished trade already there and nothing more.
  const kept = { [KEY]: JSON.stringify([open('moving')]) }
  const store = quotaStore(KEY.length + kept[KEY].length + 10, kept)
  const { eng, calls } = engineOver(store)
  await assert.rejects(eng.confirm(choice, ticket), (e) => {
    assert.equal(e.code, 'storage-full')
    assert.match(e.message, /Nothing was signed/)
    return true
  })
  assert.deepEqual(calls.filter((c) => SIGNING.includes(c)), [], 'no command that signs was asked')
  assert.deepEqual(saved(store).map((r) => r.id), ['moving'], 'the unfinished trade\'s record is untouched')
})
