// The maker's summary of its library commands' times (commandTimes): one line a period, every
// command with its count, median, 95th percentile, slowest and longest wait in the queue, then a
// fresh period.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandTimes } from './leaf-maker.mjs'

test('a period sums up every command, then starts again', () => {
  const t = commandTimes()
  assert.equal(t.line(), null, 'nothing ran: no line')
  for (let i = 1; i <= 20; i++) t.add('coins', i * 10, i === 7 ? 900 : 0)
  t.add('board', 1500)
  const l = t.line()
  assert.ok(l.startsWith('times '))
  const v = JSON.parse(l.slice('times '.length))
  assert.deepEqual(v.coins, { n: 20, p50: 100, p95: 190, max: 200, waited_max: 900 })
  assert.deepEqual(v.board, { n: 1, p50: 1500, p95: 1500, max: 1500, waited_max: 0 })
  assert.deepEqual(Object.keys(v), ['board', 'coins'])
  assert.equal(t.line(), null, 'the next period starts empty')
})

test('the upkeep syncs without its deposits, which run next as their own command', async () => {
  const { UPKEEP_SYNC_ARGS, SYNC_ARGS, SLOW_MS } = await import('./leaf-maker.mjs')
  assert.deepEqual(UPKEEP_SYNC_ARGS, { catch_up: false, deposits: false })
  assert.deepEqual(SYNC_ARGS, { catch_up: false }, 'one-off syncs deposit as before')
  assert.equal(SLOW_MS, 2000)
})

test('the upkeep runs its deposits after its sync, even when the sync fails', async () => {
  const { upkeepSync, UPKEEP_SYNC_ARGS, SLICE_MS } = await import('./leaf-maker.mjs')
  for (const syncFails of [false, true]) {
    const asked = [], logged = []
    const cmd = async (name, args) => { asked.push([name, args]); if (name === 'sync' && syncFails) throw new Error('the node') }
    await upkeepSync(cmd, (...a) => logged.push(a.join(' ')))
    assert.deepEqual(asked, [['sync', { ...UPKEEP_SYNC_ARGS, budget_ms: SLICE_MS }], ['deposits', { budget_ms: SLICE_MS }]])
    assert.deepEqual(logged, syncFails ? ['sync: the node'] : [])
  }
  // An older library without the command: nothing logged.
  const logged = []
  await upkeepSync(async (name) => { if (name === 'deposits') throw new Error('no command deposits') }, (...a) => logged.push(a.join(' ')))
  assert.deepEqual(logged, [])
})

test('the upkeep pass starts with upkeepSync', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./leaf-maker.mjs', import.meta.url), 'utf8')
  const pass = src.slice(src.indexOf('async function tickOnce ()'))
  assert.ok(pass.length < src.length, 'tickOnce is there')
  assert.match(pass.slice(0, 400), /\n\s+await upkeepSync\(cmd, log\)\n/, 'the pass syncs and deposits first')
})
