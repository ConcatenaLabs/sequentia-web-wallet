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
