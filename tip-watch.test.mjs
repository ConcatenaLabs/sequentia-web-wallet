// tip-watch.js: a sync when either chain has a new block, nothing otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tipsMoved, mergeTips, watchTips } from './tip-watch.js'

test('the first look records the tips and asks for nothing', () => {
  assert.equal(tipsMoved(null, { seq: 10, btc: 5 }), false)
})

test('a new block on either chain is news; the same tips are not', () => {
  assert.equal(tipsMoved({ seq: 10, btc: 5 }, { seq: 11, btc: 5 }), true)
  assert.equal(tipsMoved({ seq: 10, btc: 5 }, { seq: 10, btc: 6 }), true)
  assert.equal(tipsMoved({ seq: 10, btc: 5 }, { seq: 10, btc: 5 }), false)
})

test('a tip that could not be read is no news, and the last known one is kept', () => {
  assert.equal(tipsMoved({ seq: 10, btc: 5 }, { seq: null, btc: 5 }), false)
  assert.deepEqual(mergeTips({ seq: 10, btc: 5 }, { seq: null, btc: 6 }), { seq: 10, btc: 6 })
  // the explorer was down at the first look: the next readable tip is a baseline, not a move
  assert.equal(tipsMoved(mergeTips(null, { seq: null, btc: null }), { seq: 12, btc: 5 }), false)
})

// A clock the test advances by hand.
function clock () {
  let t = 0, seq = 0
  const timers = new Map()
  return {
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { at: t + ms, f }); return id },
    clearTimer: (id) => timers.delete(id),
    async tick (ms) {
      t += ms
      for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); await x.f() }
    }
  }
}
const settle = () => new Promise((r) => setImmediate(r))

test('the watcher syncs once per new block and not while the page is hidden', async () => {
  const c = clock()
  const tips = { seq: 100, btc: 50 }
  let syncs = 0, reads = 0, hidden = false, onVis = null
  const w = watchTips({
    readTips: async () => { reads++; return { ...tips } },
    onMove: async () => { syncs++ },
    visible: () => !hidden,
    everyMs: 30_000,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onVisible: (f) => { onVis = f }
  })
  await settle()
  assert.equal(syncs, 0, 'the first look is a baseline')
  await c.tick(30_000); await settle()
  assert.equal(syncs, 0, 'no block, no sync')
  tips.seq = 101
  await c.tick(30_000); await settle()
  assert.equal(syncs, 1, 'a Sequentia block: one sync')
  tips.btc = 51
  await c.tick(30_000); await settle()
  assert.equal(syncs, 2, 'a testnet4 block: one sync')
  hidden = true
  const before = reads
  tips.seq = 102
  await c.tick(30_000); await settle()
  assert.equal(reads, before, 'nothing is read while hidden')
  hidden = false
  onVis(); await settle()
  assert.equal(syncs, 3, 'becoming visible looks at once and catches the block it missed')
  w.stop()
  tips.seq = 103
  await c.tick(60_000); await settle()
  assert.equal(syncs, 3, 'stopped: no more syncs')
})

test('a failing read or sync does not stop the watch', async () => {
  const c = clock()
  let n = 0, syncs = 0
  watchTips({
    readTips: async () => { n++; if (n === 2) throw new Error('offline'); return { seq: n, btc: 1 } },
    onMove: async () => { syncs++; throw new Error('scan failed') },
    everyMs: 1000,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer
  })
  await settle()
  for (let i = 0; i < 3; i++) { await c.tick(1000); await settle() }
  assert.ok(syncs >= 2, 'still syncing after a failed read and failed syncs: ' + syncs)
})
