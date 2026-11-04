// node --test tooling/wallet-upkeep.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpkeep, UPKEEP_SYNC_MS, UPKEEP_REFRESH_MS } from './wallet-upkeep.mjs'

test('a wallet left running syncs every minute and refreshes what it received every two', async () => {
  let t = 1_000_000
  const calls = []
  const answers = { sync: { refresh: [{ leaf_id: 'aa', state: 'pending' }] }, refresh_received: { refreshed: ['bb'], left: [] } }
  const u = createUpkeep({ command: async (name) => { calls.push([t, name]); return answers[name] }, now: () => t })
  await u.tick()
  assert.deepEqual(calls, [[1_000_000, 'sync'], [1_000_000, 'refresh_received']], 'both at the first tick')
  assert.deepEqual(u.state.sync, { at: 1_000_000, refresh: 1 })
  assert.deepEqual(u.state.refresh, { at: 1_000_000, refreshed: 1, left: 0 })
  t += 15_000; await u.tick()
  assert.equal(calls.length, 2, 'nothing again within the minute')
  t = 1_000_000 + UPKEEP_SYNC_MS; await u.tick()
  assert.deepEqual(calls.slice(2), [[t, 'sync']], 'a sync a minute later, no refresh yet')
  t = 1_000_000 + UPKEEP_REFRESH_MS; await u.tick()
  assert.deepEqual(calls.slice(3), [[t, 'sync'], [t, 'refresh_received']], 'both again two minutes later')
})

test('a refusal is kept and asked again at its next turn', async () => {
  let t = 0
  let fail = true
  const u = createUpkeep({ command: async (name) => { if (fail) throw new Error(`${name} refused`); return {} }, now: () => t })
  await u.tick()
  assert.equal(u.state.sync.error, 'sync refused')
  assert.equal(u.state.refresh.error, 'refresh_received refused')
  fail = false
  t = UPKEEP_REFRESH_MS; await u.tick()
  assert.deepEqual(u.state.sync, { at: t, refresh: 0 })
  assert.deepEqual(u.state.refresh, { at: t, refreshed: 0, left: 0 })
})
