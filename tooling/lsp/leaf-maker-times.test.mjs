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
  assert.match(pass.slice(0, 400), /\n\s+await upkeepSync\(cmd, log[,)]/, 'the pass syncs and deposits first')
})

test('a sync pass in several slices is logged with its slices, its time and its longest slice', async () => {
  const { upkeepSync } = await import('./leaf-maker.mjs')
  let left = 3
  const logged = []
  await upkeepSync(async (name) => (name === 'sync' && --left > 0 ? { more: true } : name === 'sync' ? { cost_by_step: {} } : []), (...a) => logged.push(a.join(' ')))
  assert.equal(logged.length, 1, JSON.stringify(logged))
  assert.match(logged[0], /^sync in 3 slices: \d+ ms, the longest \d+ ms$/)
  // One slice: nothing logged.
  const quiet = []
  await upkeepSync(async () => ({}), (...a) => quiet.push(a.join(' ')))
  assert.deepEqual(quiet, [])
  // On a clock of its own, with the queue's reading of how long the library ran each slice: its
  // wait in the queue is left out of the longest slice.
  let t = 0, k = 0
  const ran = {}, lines = []
  await upkeepSync(async (name) => { if (name !== 'sync') return []; t += [90000, 400, 300][k]; ran.v = [900, 400, 300][k]; return ++k < 3 ? { more: true } : {} },
    (...a) => lines.push(a.join(' ')), () => ran.v, { clock: () => t, boundMs: 1e9 })
  assert.deepEqual(lines, ['sync in 3 slices: 90700 ms, the longest 900 ms'])
})

// A library that runs one slice of 1.2 s a call, `n` slices to a pass of its sync and `d` of its
// deposits, on a clock of the test's own; each call logged.
function slicedLibrary (n, d, sliceMs = 1200) {
  const clock = { t: 0 }
  const at = { sync: 0, deposits: 0 }
  const asked = []
  const cmd = async (name, args) => {
    asked.push([name, args])
    clock.t += sliceMs
    const all = name === 'sync' ? n : d
    if (args && args.budget_ms != null && ++at[name] < all) return { more: true }
    at[name] = 0
    return name === 'sync' ? { cost_by_step: {} } : []
  }
  return { clock, cmd, asked, now: () => clock.t }
}

test('the upkeep runs at most sync_tick_ms of slices a pass, and goes on where it stopped at the next', async () => {
  const { upkeepSync, upkeepState } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(30, 5)
  const state = upkeepState(), logged = []
  const opts = { sliceMs: 1000, tickMs: 10_000, boundMs: 1e9, state, clock: L.now }
  const passes = []
  for (let i = 0; i < 10; i++) {
    const t0 = L.clock.t
    const r = await upkeepSync(L.cmd, (...a) => logged.push(a.join(' ')), null, opts)
    passes.push([r.done, L.clock.t - t0])
    // The rest of the upkeep pass, and the wait to the next.
    L.clock.t += 20_000
    if (r.done) break
  }
  // Each upkeep pass holds the rest for at most sync_tick_ms and one slice.
  for (const [, ms] of passes) assert.ok(ms <= 10_000 + 1200, JSON.stringify(passes))
  assert.deepEqual(passes.map((p) => p[0]), [false, false, false, true], JSON.stringify(passes))
  // The library was asked 30 slices of sync and 5 of deposits: one pass, cut between upkeep passes.
  assert.equal(L.asked.filter((a) => a[0] === 'sync').length, 30)
  assert.equal(L.asked.filter((a) => a[0] === 'deposits').length, 5)
  assert.ok(L.asked.every((a) => a[1].budget_ms === 1000))
  const goesOn = logged.filter((l) => l.startsWith('sync goes on at the next upkeep pass: '))
  assert.equal(goesOn.length, 3, JSON.stringify(logged))
  assert.match(goesOn[0], /^sync goes on at the next upkeep pass: 10800 ms of it in this one; 9 slices over 1 upkeep pass\(es\), 10800 ms in all, the library 10800 ms of it, the longest slice 1200 ms$/)
  const rest = logged.filter((l) => !goesOn.includes(l))
  assert.match(rest[0], /^sync in 30 slices: \d+ ms, the longest 1200 ms$/)
  assert.match(rest[1], /^deposits in 5 slices: /)
  assert.equal(rest.length, 2, JSON.stringify(logged))
  // The next upkeep pass starts a new pass.
  L.asked.length = 0
  await upkeepSync(L.cmd, () => {}, null, opts)
  assert.deepEqual(L.asked[0], ['sync', { catch_up: false, deposits: false, budget_ms: 1000 }])
})

test('a pass past its bound is logged as an error, with its figures, once past it and at its end', async () => {
  const { upkeepSync, upkeepState } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(40, 1)
  const state = upkeepState(), logged = []
  const opts = { sliceMs: 1000, tickMs: 10_000, boundMs: 60_000, state, clock: L.now }
  for (let i = 0; i < 20; i++) {
    const r = await upkeepSync(L.cmd, (...a) => logged.push(a.join(' ')), null, opts)
    L.clock.t += 20_000
    if (r.done) break
  }
  const errors = logged.filter((l) => l.startsWith('error:'))
  assert.equal(errors.length, 2, JSON.stringify(logged))
  assert.match(errors[0], /^error: the upkeep's sync is past its bound \(60000 ms\) and goes on: \d+ slices over \d+ upkeep pass\(es\), \d+ ms in all, the library \d+ ms of it, the longest slice 1200 ms$/)
  assert.match(errors[1], /^error: the upkeep's sync took longer than its bound \(60000 ms\): 41 slices over 5 upkeep pass\(es\), \d+ ms in all, the library 49200 ms of it, the longest slice 1200 ms$/)
  // Within its bound: no error.
  const quiet = []
  const M = slicedLibrary(3, 1)
  await upkeepSync(M.cmd, (...a) => quiet.push(a.join(' ')), null, { sliceMs: 1000, tickMs: 10_000, boundMs: 60_000, state: upkeepState(), clock: M.now })
  assert.ok(!quiet.some((l) => l.startsWith('error:')), JSON.stringify(quiet))
})

test('slice_ms 0 runs whole syncs: no budget, one call each', async () => {
  const { upkeepSync, upkeepState } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(30, 5)
  const r = await upkeepSync(L.cmd, () => {}, null, { sliceMs: 0, tickMs: 10_000, state: upkeepState(), clock: L.now })
  assert.equal(r.done, true)
  assert.deepEqual(L.asked, [['sync', { catch_up: false, deposits: false }], ['deposits', {}]])
})

test('a pass is given up after SLICES_MOST slices, and logged', async () => {
  const { upkeepSync, upkeepState, SLICES_MOST } = await import('./leaf-maker.mjs')
  const asked = [], logged = []
  const r = await upkeepSync(async (name, args) => { asked.push(name); return name === 'sync' ? { more: true } : [] }, (...a) => logged.push(a.join(' ')), null,
    { state: upkeepState(), boundMs: 1e9 })
  assert.equal(r.done, true)
  assert.equal(asked.filter((n) => n === 'sync').length, SLICES_MOST)
  assert.ok(logged.some((l) => l.startsWith('error: sync given up after 600 slices')), JSON.stringify(logged))
})

test('the maker reads slice_ms, sync_tick_ms and sync_pass_bound_ms from its configuration', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./leaf-maker.mjs', import.meta.url), 'utf8')
  for (const k of ['slice_ms', 'sync_tick_ms', 'sync_pass_bound_ms']) {
    assert.match(src, new RegExp('cfg\\.' + k + ' \\?\\?'), k + ' is read')
    assert.match(src.slice(0, src.indexOf('import ')), new RegExp('"' + k + '"'), k + ' is in the configuration\'s header')
  }
})
