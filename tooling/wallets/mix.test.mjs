// The reliability run's plan, the time each operation is held to, and its verdict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableMb, boundOf, memoryFor, plan, summarize, unfinished } from './mix.mjs'

const W = [{ name: 'w', kind: 'web' }, { name: 'b', kind: 'browser' }, { name: 'm', kind: 'mobile' }]

test('each stated time is the bound its operation is held to', () => {
  assert.equal(boundOf('Send 1 USDX? It arrives in seconds.'), 60)
  assert.equal(boundOf('It arrives after the next block, in about a minute.'), 180)
  assert.equal(boundOf('Sent 500000 EURX. It will appear on Balance once it confirms (about a minute).'), 180)
  assert.equal(boundOf('It arrives in a few minutes.'), 600)
  assert.equal(boundOf('It arrives within 10 minutes.'), 600)
  assert.equal(boundOf('It arrives in about 8 minutes.'), 960)
  assert.equal(boundOf('It arrives after a Bitcoin block.'), 3600)
  assert.equal(boundOf('Send 1 USDX?'), null)
})

test('the plan makes the records asked for, every kind, and the same plan from the same seed', () => {
  const p = plan(W, 500, 1)
  const recs = p.reduce((n, o) => n + (o.op === 'payment' ? 2 : 1), 0)
  assert.ok(recs >= 500 && recs <= 501)
  const kinds = new Set(p.map((o) => o.op + (o.how ? ':' + o.how : '')))
  for (const k of ['trade', 'faucet', 'payment:code', 'payment:invoice', 'payment:address', 'payment:closed']) assert.ok(kinds.has(k), k)
  assert.deepEqual(plan(W, 500, 1), p)
  // A closed phone is only ever the receiver, and the phone asks the faucet only for what it lacks.
  assert.ok(p.filter((o) => o.how === 'closed').every((o) => o.to === 'm' && o.from !== 'm'))
  assert.ok(p.filter((o) => o.op === 'faucet' && o.wallet === 'm').length === 4)
  // Every traded asset both ways against USDX, BTC included, in every wallet.
  for (const w of ['w', 'b', 'm']) for (const a of ['GOLD', 'BTC']) {
    assert.ok(p.some((o) => o.op === 'trade' && o.wallet === w && o.pay === 'USDX' && o.get === a), w + ' buys ' + a)
    assert.ok(p.some((o) => o.op === 'trade' && o.wallet === w && o.pay === a && o.get === 'USDX'), w + ' sells ' + a)
  }
})

test('the verdict counts within the stated time and leaves out what the drive could not do', () => {
  const s = summarize([
    { op: 'payment', kind: 'web', outcome: 'settled', within: true, seconds: 2 },
    { op: 'receive', kind: 'browser', outcome: 'settled', within: false, seconds: 90, bound: 60, said: 'x' },
    { op: 'trade', kind: 'mobile', outcome: 'refused', seconds: 9, said: 'Nobody could confirm a price for this just now.' },
    { op: 'trade', kind: 'mobile', outcome: 'failed', seconds: 0, said: 'drive: no GOLD', drive_error: true },
    { op: 'trade', kind: 'mobile', outcome: 'refused', seconds: 0, said: 'no GOLD shown to sell', drive_skip: true },
    { op: 'payment', kind: 'browser', outcome: 'failed', seconds: 602, said: 'x → no answer in 10 min', within: null }
  ])
  assert.equal(s.all.n, 4)
  assert.equal(s.all.ended, 3)
  assert.equal(s.all.timed, 2)
  assert.equal(s.all.pct, 50)
  // The refusal for no price is the wallet's: counted as missed where refusals count.
  assert.equal(s.all.refusedByWallet, 2)
  assert.equal(s.all.pctAsked, 25)
  assert.equal(s.driveErrors, 1)
  assert.equal(s.wallets.mobile.n, 1)
})

test('memory: the available figure is read, and a start waits until there is enough', async () => {
  assert.equal(availableMb('MemTotal:       32001024 kB\nMemAvailable:    9216000 kB\n'), 9000)
  assert.equal(availableMb('nothing'), null)
  const seen = [8000, 8500, 9100]; const said = []
  const a = await memoryFor(9000, (s) => said.push(s), { read: () => seen.shift(), wait: async () => {} })
  assert.equal(a, 9100)
  assert.equal(said.length, 1)
  assert.match(said[0], /8000 MB available, waiting for 9000 MB/)
})

test('a resumed run gives each payment watched when the drive stopped a line of the drive', () => {
  const lines = [
    { id: 1, op: 'payment', from: 'w', to: 'b', how: 'code', outcome: 'settled', said: 'x → Sent 1 USDX' },
    { id: 1, op: 'receive', from: 'w', to: 'b', how: 'code', outcome: 'settled' },
    { id: 2, op: 'payment', from: 'b', to: 'm', how: 'code', outcome: 'settled', said: 'x → Sent 1 USDX' },
    { id: 3, op: 'payment', from: 'm', to: 'w', how: 'code', outcome: 'refused', said: 'x → Nothing was sent' },
    { id: 4, op: 'payment', from: 'w', to: 'm', how: 'address', outcome: 'failed', said: 'x → no answer in 10 min' },
    { id: 5, op: 'trade', outcome: 'received' }
  ]
  const u = unfinished(lines)
  assert.deepEqual(u.map((l) => l.id), [2, 4])
  assert.ok(u.every((l) => l.op === 'receive' && l.drive_error === true))
  // Not counted: the verdict leaves them out.
  assert.equal(summarize([...lines, ...u]).driveErrors, 2)
})
