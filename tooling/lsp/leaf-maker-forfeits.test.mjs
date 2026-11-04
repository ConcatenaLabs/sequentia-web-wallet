// The maker's forfeit pass: `hand_over_forfeits` ahead of the library's queue, one at a time,
// refusals logged, and a library without the command passed over in silence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { forfeitPass, FORFEIT_SECONDS } from './leaf-maker.mjs'

test('the pass asks the library ahead of its queue, well inside the operator\'s ten-minute window', async () => {
  const calls = []
  const pass = forfeitPass(async (name, args, first) => { calls.push([name, args, first]); return { held: [{ participation: 'p1', state: 'forfeiting' }] } }, () => {})
  const r = await pass()
  assert.deepEqual(calls, [['hand_over_forfeits', {}, true]])
  assert.equal(r.held[0].state, 'forfeiting')
  assert.ok(FORFEIT_SECONDS * 4 <= 600)
})

test('a pass never overlaps the one still running', async () => {
  let release
  let n = 0
  const pass = forfeitPass(async () => { n++; await new Promise((r) => { release = r }); return { held: [] } }, () => {})
  const first = pass()
  assert.equal(await pass(), null)
  release()
  await first
  assert.equal(n, 1)
  const third = pass()
  release()
  await third
  assert.equal(n, 2)
})

test('a refusal is logged with its participation; an older library is passed over in silence', async () => {
  const logged = []
  const log = (...a) => logged.push(a.join(' '))
  await forfeitPass(async () => ({ held: [{ participation: 'p2', state: 'issued', refused: 'the round pays another leaf' }] }), log)()
  assert.deepEqual(logged, ['forfeits: p2 the round pays another leaf'])
  logged.length = 0
  await forfeitPass(async () => { throw new Error('refused: no command hand_over_forfeits') }, log)()
  assert.deepEqual(logged, [])
  await forfeitPass(async () => { throw new Error('unreachable: the operator did not answer') }, log)()
  assert.deepEqual(logged, ['forfeits: unreachable: the operator did not answer'])
})
