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
