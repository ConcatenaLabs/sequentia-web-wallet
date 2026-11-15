// A taker's firm offer is answered within a second or two while the maker's upkeep syncs (web
// #659). The library runs one command at a time and a command that has started runs to its end, so
// the upkeep asks for its sync and its deposits in slices (`budget_ms`), and a firm offer, queued
// first, runs between two slices.
//
// The library here is a simulation on the real queue (leaf-node.mjs libraryQueue): a sync of the
// steps the box's maker logged at 03:57:52Z on 2026-11-13 ("slow sync 14037 ms": refresh 4,408 ms,
// schedule 2,269 ms, home 1,883 ms, participations 904 ms, and the rest), each step made of items
// of at most half a second (one request of the operator or the node), and a `deposits` of 61
// requests (17,472 ms at 04:03:10Z). A library given `budget_ms` stops at the first item past it
// and answers `more: true`; without it, the whole command runs in one call, as before. Times are
// a tenth of the box's.
//
//   node --test tooling/lsp/leaf-maker-answer-while-busy.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryQueue } from '../leaf-node.mjs'
import * as maker from './leaf-maker.mjs'
const { upkeepSync } = maker
const SLICE_MS = maker.SLICE_MS ?? 1000

const SCALE = 10   // box milliseconds per simulated millisecond
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The box's sync, step by step (ms), cut into items of at most 500 ms.
const SYNC_STEPS = [['witness', 150], ['held', 120], ['mailbox', 300], ['participations', 904], ['refresh', 4408], ['forfeits', 200],
  ['home', 1883], ['exits', 300], ['schedule', 2269], ['other', 3500]]
const items = (steps) => steps.flatMap(([n, ms]) => { const k = Math.ceil(ms / 500); return Array.from({ length: k }, () => ms / k) })
const SYNC_ITEMS = items(SYNC_STEPS)
const DEPOSIT_ITEMS = items([['deposits', 17472]])

function simulatedLibrary () {
  const cursor = { sync: 0, deposits: 0 }
  const ran = []
  const run = async (job) => {
    const { name, args } = job.args
    ran.push(name)
    if (name === 'sync' || name === 'deposits') {
      const all = name === 'sync' ? SYNC_ITEMS : DEPOSIT_ITEMS
      const budget = args && args.budget_ms != null ? Number(args.budget_ms) : null
      let spent = 0
      while (cursor[name] < all.length) {
        await sleep(all[cursor[name]] / SCALE); spent += all[cursor[name]]; cursor[name]++
        if (budget != null && spent >= budget && cursor[name] < all.length) return { ok: true, value: { more: true } }
      }
      cursor[name] = 0
      return { ok: true, value: name === 'sync' ? { cost_by_step: {} } : [] }
    }
    if (name === 'swap_offer') { await sleep(800 / SCALE); return { ok: true, value: { swap: 's1' } } }
    return { ok: true, value: {} }
  }
  const q = libraryQueue(run)
  const cmd = (name, args, first = false) => q.call('command', { name, args }, first)
  return { cmd, ran }
}

test('a firm offer asked while the upkeep syncs is answered within a second or two, not after the sync', async () => {
  const L = simulatedLibrary()
  const upkeep = upkeepSync(L.cmd, () => {})
  const waits = []
  // Firm offers asked at points through the sync and through the deposits after it.
  for (const at of [500, 3000, 6000, 9000, 12000, 16000, 22000, 28000]) {
    await sleep(at / SCALE - (waits.length ? [500, 3000, 6000, 9000, 12000, 16000, 22000, 28000][waits.length - 1] / SCALE : 0))
    const t0 = Date.now()
    await L.cmd('swap_offer', { give: '1' }, true)
    waits.push((Date.now() - t0) * SCALE)
  }
  await upkeep
  const most = Math.max(...waits)
  // At most one slice (a second), one item past it (half a second) and the offer itself (0.8 s),
  // with the timers' slack.
  assert.ok(most <= SLICE_MS + 500 + 800 + 700, `the longest firm answer took ${most} ms (box time): ${waits.join(', ')}`)
  assert.ok(L.ran.filter((n) => n === 'sync').length > 1, 'the sync ran in slices')
  assert.ok(L.ran.filter((n) => n === 'deposits').length > 1, 'the deposits ran in slices')
})

test('the upkeep still ends its sync and its deposits, slice after slice', async () => {
  const L = simulatedLibrary()
  await upkeepSync(L.cmd, () => {})
  const syncs = L.ran.filter((n) => n === 'sync').length, deps = L.ran.filter((n) => n === 'deposits').length
  assert.ok(syncs >= 8 && syncs <= 20, 'about one slice a second of a 14 s sync: ' + syncs)
  assert.ok(deps >= 10 && deps <= 20, 'and of 17 s of deposits: ' + deps)
})

test('a library without slices runs each command in one call, as before', async () => {
  const asked = []
  await upkeepSync(async (name, args) => { asked.push([name, args]); return name === 'sync' ? { cost_by_step: {} } : [] }, () => {})
  assert.deepEqual(asked.map((a) => a[0]), ['sync', 'deposits'])
  assert.equal(asked[0][1].budget_ms, SLICE_MS)
})

test('the rest of the upkeep, on its own timer, waits for one slice of the sync at most', async () => {
  const L = simulatedLibrary()
  const waits = []
  let syncing = true
  const sync = upkeepSync(L.cmd, () => {}).finally(() => { syncing = false })
  // The rest of the upkeep: its commands one after another, as tickOnce runs them, queued normally.
  while (syncing) {
    const t0 = Date.now()
    await L.cmd('coins', {})
    waits.push((Date.now() - t0) * SCALE)
  }
  await sync
  assert.ok(waits.length >= 8, 'the upkeep ran its commands while the sync ran: ' + waits.length)
  // One slice (a second) and the item past it (half a second), with the timers' slack.
  assert.ok(Math.max(...waits) <= SLICE_MS + 500 + 700, `an upkeep command waited ${Math.max(...waits)} ms (box time): ${waits.join(', ')}`)
})
