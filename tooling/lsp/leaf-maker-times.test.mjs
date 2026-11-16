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

test('the sync runs on a loop of its own, and the rest of the upkeep does not wait for it', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./leaf-maker.mjs', import.meta.url), 'utf8')
  const pass = src.slice(src.indexOf('async function tickOnce ()'))
  assert.ok(pass.length < src.length, 'tickOnce is there')
  assert.doesNotMatch(pass.slice(0, pass.indexOf('\n  }\n')), /upkeepSync|syncLoop/, 'the upkeep pass waits for no sync')
  assert.match(src, /const sync = syncLoop\(cmd, log, /, 'the maker runs the sync loop')
  assert.match(src, /setInterval\(sync, \(cfg\.sync_seconds \?\? 20\) \* 1000\)/, 'on its own timer')
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

test('the sync loop runs one pass at a time, each to its end', async () => {
  const { syncLoop } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(30, 5)
  const logged = []
  const sync = syncLoop(L.cmd, (...a) => logged.push(a.join(' ')), null, { sliceMs: 1000, boundMs: 1e9, clock: L.now })
  const first = sync()
  assert.equal(await sync(), null, 'a second start while a pass is under way does nothing')
  await first
  assert.equal(L.asked.filter((a) => a[0] === 'sync').length, 30)
  assert.equal(L.asked.filter((a) => a[0] === 'deposits').length, 5)
  assert.ok(L.asked.every((a) => a[1].budget_ms === 1000))
  assert.deepEqual(logged.slice(0, 2), ['sync in 30 slices: 36000 ms, the longest 1200 ms', 'deposits in 5 slices: 6000 ms, the longest 1200 ms'])
  // The pass's own record, from which its figures are read.
  const rec = JSON.parse(logged[2].replace(/^sync pass /, ''))
  assert.deepEqual({ n: rec.n, ms: rec.ms, slices: rec.slices, library: rec.library, longest: rec.longest }, { n: 1, ms: 42000, slices: 35, library: 42000, longest: 1200 })
  L.asked.length = 0
  await sync()
  assert.deepEqual(L.asked[0], ['sync', { catch_up: false, deposits: false, budget_ms: 1000 }], 'the next start runs a new pass')
})

test('a pass past its bound is logged as an error, with its figures, once past it and at its end', async () => {
  const { upkeepSync } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(40, 1)
  const logged = []
  await upkeepSync(L.cmd, (...a) => logged.push(a.join(' ')), null, { sliceMs: 1000, boundMs: 30_000, clock: L.now })
  const errors = logged.filter((l) => l.startsWith('error:'))
  assert.equal(errors.length, 2, JSON.stringify(logged))
  assert.equal(errors[0], 'error: the sync is past its bound (30000 ms) and goes on: 26 slices, 31200 ms in all, the library 31200 ms of it, the longest slice 1200 ms')
  assert.equal(errors[1], 'error: the sync took longer than its bound (30000 ms): 41 slices, 49200 ms in all, the library 49200 ms of it, the longest slice 1200 ms')
  // Within its bound: no error.
  const quiet = []
  const M = slicedLibrary(3, 1)
  await upkeepSync(M.cmd, (...a) => quiet.push(a.join(' ')), null, { sliceMs: 1000, boundMs: 30_000, clock: M.now })
  assert.ok(!quiet.some((l) => l.startsWith('error:')), JSON.stringify(quiet))
})

test('slice_ms 0 runs whole syncs: no budget, one call each', async () => {
  const { upkeepSync } = await import('./leaf-maker.mjs')
  const L = slicedLibrary(30, 5)
  await upkeepSync(L.cmd, () => {}, null, { sliceMs: 0, clock: L.now })
  assert.deepEqual(L.asked, [['sync', { catch_up: false, deposits: false }], ['deposits', {}]])
})

test('a pass goes on to its end however many slices it takes, and is never given up', async () => {
  const { upkeepSync } = await import('./leaf-maker.mjs')
  const asked = [], logged = []
  let n = 0
  await upkeepSync(async (name) => { asked.push(name); return name === 'sync' ? (++n < 1500 ? { more: true } : {}) : [] }, (...a) => logged.push(a.join(' ')), null, { boundMs: 1e9 })
  assert.equal(asked.filter((x) => x === 'sync').length, 1500, 'every slice of the pass, past 600')
  assert.ok(!logged.some((l) => /given up/.test(l)), JSON.stringify(logged.slice(0, 3)))
  assert.ok(logged.some((l) => l.startsWith('sync in 1500 slices')))
})

test('syncStanding: ok while a pass ended within the stale time, counted from the start before the first', async () => {
  const { syncStanding, syncStaleMs, passRecord } = await import('./leaf-maker.mjs')
  assert.equal(syncStaleMs({}), 600_000, 'twice the pass bound by default')
  assert.equal(syncStaleMs({ sync_pass_bound_ms: 100_000 }), 200_000)
  assert.equal(syncStaleMs({ sync_stale_ms: 5_000 }), 5_000)
  let t = 1_000_000
  const rec = passRecord(() => t, t)
  rec.begin()
  t += 599_000
  assert.deepEqual(syncStanding(rec.now(), 600_000, 1_000_000, t), { ok: true }, 'starting up')
  t += 2_000
  const s = syncStanding(rec.now(), 600_000, 1_000_000, t)
  assert.equal(s.ok, false)
  assert.match(s.why, /completed no sync pass in the 601 s since it started, a pass under way for 601 s/)
  rec.end()
  assert.deepEqual(syncStanding(rec.now(), 600_000, 1_000_000, t), { ok: true }, 'a pass ended: quotes again by itself')
  t += 600_001
  assert.match(syncStanding(rec.now(), 600_000, 1_000_000, t).why, /last sync pass ended 600 s ago, more than 600 s/)
})

test('upkeepDue: the upkeep waits for the library time of its last pass, not its wall time', async () => {
  const { upkeepDue } = await import('./leaf-maker.mjs')
  // A pass of 400 s wall time, 60 s of it the library's: due 60 s after its end, not 400 s.
  assert.equal(upkeepDue(1_060_000, 1_000_000, 60_000), true)
  assert.equal(upkeepDue(1_059_999, 1_000_000, 60_000), false)
})

test('the maker wires its standing into /health, its quotes and its firm offers, and starts its upkeep by the bound', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./leaf-maker.mjs', import.meta.url), 'utf8')
  assert.match(src, /p === '\/health'[^\n]*stoppedNow\(\) \? \{ ok: false, why: stoppedNow\(\) \}/, '/health says ok: false with why')
  const quotes = src.slice(src.indexOf("p === '/v1/quotes'"))
  assert.match(quotes.slice(0, 400), /const stopped = stoppedNow\(\)\s+if \(stopped\) return send\(res, 200, \{[^}]*quotes: \[\], stopped \}/, 'quotes empty with stopped')
  const firm = src.slice(src.indexOf("if (p === '/v1/firm' || p === '/v1/btc/firm') {"))
  assert.match(firm.slice(0, 300), /if \(stopped\) return send\(res, 503, \{ error: stopped, stopped: true \}\)/, 'firm offers refused with why')
  assert.match(src, /setTimeout\(\(\) => startUpkeep\(`error: the first sync pass has not ended within \$\{boundMs\} ms/, 'the upkeep starts by the bound')
  assert.match(src, /if \(busy \|\| !upkeepDue\(Date\.now\(\), passEnd, passLibrary\)\) return/, 'paced by library time')
  assert.doesNotMatch(src, /passTook/)
  assert.match(src.slice(0, src.indexOf('import ')), /"sync_stale_ms"/, 'sync_stale_ms in the header')
})

test('the maker reads slice_ms and sync_pass_bound_ms from its configuration', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./leaf-maker.mjs', import.meta.url), 'utf8')
  for (const k of ['slice_ms', 'sync_pass_bound_ms']) {
    assert.match(src, new RegExp('cfg\\.' + k + ' \\?\\?'), k + ' is read')
    assert.match(src.slice(0, src.indexOf('import ')), new RegExp('"' + k + '"'), k + ' is in the configuration\'s header')
  }
  assert.doesNotMatch(src, /sync_tick_ms/)
})

test('passRecord: passes, their longest, the longest gap between two ends, and the time since the last', async () => {
  const { passRecord, syncLoop } = await import('./leaf-maker.mjs')
  let now = 1000
  const r = passRecord(() => now, now)
  assert.deepEqual(r.now(), { passes: 0, last_start: null, last_end: null, last_ms: null, longest_ms: 0, longest_gap_ms: 0, ago_ms: 0, under_way_ms: null })
  now = 5000; r.begin(); now = 8000
  assert.equal(r.now().under_way_ms, 3000, 'a pass under way says how long it has run')
  r.end()
  now = 30000; r.begin(); now = 31000; r.end()
  now = 40000
  assert.deepEqual(r.now(), { passes: 2, last_start: 30000, last_end: 31000, last_ms: 1000, longest_ms: 3000, longest_gap_ms: 23000, ago_ms: 9000, under_way_ms: null })
  // The sync loop keeps one when given it: a pass whose sync answered counts, one whose sync threw does not.
  const rec = passRecord()
  await syncLoop(async (name) => (name === 'sync' ? {} : []), () => {}, null, { sliceMs: 0, record: rec })()
  assert.equal(rec.now().passes, 1)
  const logged = []
  await syncLoop(async () => { throw new Error('down') }, (...a) => logged.push(a.join(' ')), null, { sliceMs: 0, record: rec })()
  assert.equal(rec.now().passes, 1, 'a failed pass is not counted')
  assert.equal(rec.now().under_way_ms, null)
  assert.ok(logged.some((l) => l.startsWith('sync pass failed')), JSON.stringify(logged))
})

test('a maker whose every sync fails goes stale and stops quoting', async () => {
  const { syncLoop, passRecord, syncStanding } = await import('./leaf-maker.mjs')
  let t = 1_000_000
  const since = t
  const rec = passRecord(() => t, since)
  const run = syncLoop(async (name) => { if (name === 'sync') throw new Error('the operator cannot be reached'); return [] }, () => {}, null,
    { sliceMs: 1000, record: rec, clock: () => t })
  // A failing sync every 20 s for 800 s.
  for (let k = 0; k < 40; k++) { await run(); t += 20_000 }
  assert.equal(rec.now().passes, 0)
  const st = syncStanding(rec.now(), 600_000, since, t)
  assert.equal(st.ok, false, 'not ok after 800 s of failed syncs')
  assert.match(st.why, /completed no sync pass in the 800 s since it started/)
})
