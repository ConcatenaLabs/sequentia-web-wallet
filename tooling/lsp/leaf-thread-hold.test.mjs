// The leaf library's thread runs a `first` command ahead of the queue, and while it is held
// (a taker is about to ask for a firm offer) it starts no other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextJob, nextWake } from '../leaf-node.mjs'

test('first goes ahead; a held queue starts only first commands; the hold ends', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3, first: true }]
  assert.equal(nextJob(q, 1000), 2)
  assert.equal(nextJob(q, 1000, 5000), 2, 'a firm offer runs while the queue is held')
  const upkeep = [{ id: 1 }, { id: 2 }]
  assert.equal(nextJob(upkeep, 1000, 5000), -1, 'the upkeep waits while held')
  assert.equal(nextJob(upkeep, 6000, 5000), 0, 'and runs once the hold ends')
  assert.equal(nextJob([], 6000), -1)
})

// A release answers at once and queues its cancel first; a firm the taker asks next queues first
// too, behind it: the cancel frees the offer's coins before that firm runs, ahead of the upkeep.
test('first commands keep their order: a release cancel runs before the next firm', () => {
  const q = [{ id: 1, name: 'sync' }, { id: 2, name: 'swap_cancel', first: true }, { id: 3, name: 'balance' }, { id: 4, name: 'swap_offer', first: true }]
  const order = []
  while (q.length) { const i = nextJob(q, 1000, 0); order.push(q.splice(i, 1)[0].name) }
  assert.deepEqual(order, ['swap_cancel', 'swap_offer', 'sync', 'balance'])
})

// Turns: a command that is not first runs ahead of the next first one only once it has waited
// `turnMs` since it was queued, held or not; before that every first command goes ahead of it.
test('a waiting ordinary command takes its turn only after it has waited turnMs, held or not', () => {
  const q = [{ id: 1, name: 'sync', queued: 0 }, { id: 2, name: 'swap_offer', first: true, queued: 500 }, { id: 3, name: 'coins', first: true, queued: 600 }]
  assert.equal(nextJob(q, 1000, 0, 10_000), 1, 'a person\'s command goes ahead of a slice that has waited 1 s')
  assert.equal(nextJob(q, 9_999, 0, 10_000), 1, 'and of one that has waited just under its turn')
  assert.equal(nextJob(q, 10_000, 0, 10_000), 0, 'the slice runs once it has waited its turn')
  assert.equal(nextJob(q, 10_000, 50_000, 10_000), 0, 'held too')
  assert.equal(nextJob([{ id: 1, queued: 0 }], 10_000, 50_000, 10_000), 0, 'a held queue moves on a turn')
  assert.equal(nextJob([{ id: 1, queued: 0 }], 9_000, 50_000, 10_000), -1, 'and waits before it')
  assert.equal(nextWake([{ id: 1, queued: 0 }], 9_000, 50_000, 10_000), 1_000, 'woken at the turn')
  assert.equal(nextWake([{ id: 1, queued: 0 }], 9_000, 9_500, 10_000), 500, 'or at the hold\'s end, sooner')
})

// A firm offer is several commands one after another (the room, the coins, the plans, the offer).
// With a sync whose slices are queued again as each ends, none of them may wait for a slice: the
// offer waits for the slice under way when it is asked, at most, and for no other.
test('a firm offer of several commands waits for no slice but the one under way', async () => {
  const { libraryQueue } = await import('../leaf-node.mjs')
  const SLICE = 40, OWN = 2
  const ran = []
  const q = libraryQueue(async (job) => { ran.push(job.args.name); await new Promise((r) => setTimeout(r, job.args.name === 'slice' ? SLICE : OWN)); return { ok: true, value: null } })
  let syncing = true
  const sync = (async () => { while (syncing) await q.call('command', { name: 'slice' }) })()
  await new Promise((r) => setTimeout(r, 10))   // a slice under way
  const t0 = Date.now()
  for (const name of ['bond', 'coins', 'plans', 'swap_offer']) await q.call('command', { name }, true)
  const took = Date.now() - t0
  syncing = false; await sync
  const at = ran.indexOf('bond')
  assert.deepEqual(ran.slice(at, at + 4), ['bond', 'coins', 'plans', 'swap_offer'], 'no slice between the offer\'s commands: ' + ran.join(' '))
  assert.ok(took < SLICE + 4 * OWN + 30, 'the offer took one slice\'s wait at most: ' + took + ' ms')
})

// A steady stream of takers' commands still lets the sync move: a slice that has waited its turn
// runs ahead of the next one.
test('a steady stream of first commands lets a slice run every turn', async () => {
  const { libraryQueue } = await import('../leaf-node.mjs')
  const ran = []
  const q = libraryQueue(async (job) => { ran.push(job.args.name); await new Promise((r) => setTimeout(r, 5)); return { ok: true, value: null } }, { turnMs: 30 })
  let taking = true
  const takers = (async () => { while (taking) await Promise.all([q.call('command', { name: 'firm' }, true), q.call('command', { name: 'firm' }, true)]) })()
  const t0 = Date.now()
  for (let i = 0; i < 3; i++) await q.call('command', { name: 'slice' })
  const took = Date.now() - t0
  taking = false; await takers
  assert.equal(ran.filter((n) => n === 'slice').length, 3)
  assert.ok(took < 3 * (30 + 15) + 60, 'each slice ran within about its turn: ' + took + ' ms')
})

// The hold after a quote read keeps the rest of the upkeep back, not the sync's slices (queued
// `unheld`); the short hold after a person's command keeps both back for their next command.
test('a held queue still runs unheld jobs; the follow-on hold keeps every job', () => {
  const q = [{ id: 1, name: 'merge', queued: 0 }, { id: 2, name: 'slice', unheld: true, queued: 0 }]
  assert.equal(nextJob(q, 1000, 50_000, 10_000), 1, 'the slice runs through a hold')
  assert.equal(nextJob(q, 1000, 0, 10_000), 0, 'unheld, the oldest runs')
  assert.equal(nextJob(q, 1000, 50_000, 10_000, 1200), -1, 'nothing just after a person\'s command')
  assert.equal(nextWake(q, 1000, 50_000, 10_000, 1200), 200, 'woken when the follow-on hold ends')
  assert.equal(nextJob([{ id: 3, first: true }, ...q], 1000, 50_000, 10_000, 1200), 0, 'their next command runs at once')
})

// A job may name its own turn (a sync pass late on its bound).
test('a job\'s own turnMs takes the place of the queue\'s', () => {
  const q = [{ id: 1, name: 'slice', queued: 0, turnMs: 2000 }, { id: 2, name: 'firm', first: true, queued: 100 }]
  assert.equal(nextJob(q, 1999, 0, 10_000), 1, 'the takers first before its turn')
  assert.equal(nextJob(q, 2000, 0, 10_000), 0, 'the slice at its own turn')
  assert.equal(nextWake([q[0]], 500, 9000, 10_000), 1500, 'woken at its own turn')
})
