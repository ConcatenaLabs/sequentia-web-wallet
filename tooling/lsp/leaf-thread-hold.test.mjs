// The leaf library's thread runs a `first` command ahead of the queue, and while it is held
// (a taker is about to ask for a firm offer) it starts no other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextJob } from '../leaf-node.mjs'

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

// Fair turns: right after a first command, the oldest command that is not first runs before the
// next first one, held or not. A stream of takers' commands then costs the sync's next slice one
// taker command's wait at most, never the whole stream (web #795).
test('after a first command, a waiting ordinary command takes its turn, held or not', () => {
  const q = [{ id: 1, name: 'sync' }, { id: 2, name: 'swap_offer', first: true }, { id: 3, name: 'swap_offer', first: true }]
  assert.equal(nextJob(q, 1000, 0, true), 0, 'the slice after a first command')
  assert.equal(nextJob(q, 1000, 5000, true), 0, 'held too')
  assert.equal(nextJob(q, 1000, 0, false), 1, 'after an ordinary command, first goes ahead')
  assert.equal(nextJob([{ id: 2, first: true }], 1000, 0, true), 0, 'no ordinary command waits: the first runs')
})

test('a steady stream of first commands lets every queued slice run, one between two of them', async () => {
  const { libraryQueue } = await import('../leaf-node.mjs')
  const ran = []
  const q = libraryQueue(async (job) => { ran.push(job.args.name); await new Promise((r) => setTimeout(r, 2)); return { ok: true, value: null } })
  const slices = [], firms = []
  // A taker command queued ahead and three more queued behind it, all before any slice.
  firms.push(q.call('command', { name: 'firm' }, true))
  for (let i = 0; i < 3; i++) slices.push(q.call('command', { name: 'slice' }))
  for (let i = 0; i < 6; i++) firms.push(q.call('command', { name: 'firm' }, true))
  await Promise.all([...slices, ...firms])
  // Never two takers' commands in a row while a slice waits.
  assert.deepEqual(ran.slice(0, 6), ['firm', 'slice', 'firm', 'slice', 'firm', 'slice'])
  assert.equal(ran.length, 10)
})
