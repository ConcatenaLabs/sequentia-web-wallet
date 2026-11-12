// The worker's pause through the site's hold (leaves/hold.js): a hold that keeps the request for
// the time asked is used for the whole pause; a site without one, or whose hold answers 204 at
// once (a broken or replaced route), is given up after one request, never asked back to back for
// the whole pause.
import test from 'node:test'
import assert from 'node:assert/strict'
import { holdThrough } from './leaves/hold.js'

// A clock and a site whose hold answers `status` after `holds(ms)` of the clock.
function fakeSite ({ status = 204, holds = (ms) => ms }) {
  let t = 1_000_000
  const asked = []
  class Xhr {
    open (m, url) { this.url = url }
    send () { const ms = Number(new URL(this.url, 'http://x').searchParams.get('ms')); asked.push(ms); t += holds(ms); this.status = status }
  }
  return { Xhr, now: () => t, asked, at: () => t }
}

test('a working hold is asked for the pause and kept', () => {
  const f = fakeSite({})
  const site = { url: 'https://site/node-rpc/hold' }
  const t0 = f.at()
  holdThrough(site, 2000, f)
  assert.equal(f.at() - t0, 2000)
  assert.deepEqual(f.asked, [2000])
  assert.equal(site.url, 'https://site/node-rpc/hold', 'kept for the next pause')
})

test('a hold that answers 204 at once is given up after one request: the clock from then on', () => {
  const f = fakeSite({ holds: () => 3 })
  const site = { url: 'https://site/node-rpc/hold' }
  holdThrough(site, 2000, f)
  assert.equal(f.asked.length, 1, `asked ${f.asked.length} times`)
  assert.equal(site.url, null, 'this site\'s hold is broken')
})

test('a hold cut a little short is asked again for the rest; a short pause is never judged', () => {
  const f = fakeSite({ holds: (ms) => Math.min(ms, 1500) })
  const site = { url: 'https://site/node-rpc/hold' }
  holdThrough(site, 2000, f)
  assert.deepEqual(f.asked, [2000, 500])
  assert.ok(site.url)
  const g = fakeSite({ holds: () => 1 })
  const s2 = { url: 'https://site/node-rpc/hold' }
  holdThrough(s2, 80, g)
  assert.ok(s2.url, 'a pause of 100 ms or less tells nothing of the hold')
})

test('no such path: the clock from then on; a refusal for the moment keeps the hold', () => {
  const f = fakeSite({ status: 404, holds: () => 2 })
  const site = { url: 'https://site/node-rpc/hold' }
  holdThrough(site, 2000, f)
  assert.equal(site.url, null)
  const g = fakeSite({ status: 429, holds: () => 2 })
  const s2 = { url: 'https://site/node-rpc/hold' }
  holdThrough(s2, 2000, g)
  assert.equal(g.asked.length, 1)
  assert.ok(s2.url)
})

test('a pause longer than the route holds is asked for in parts of at most 25 s; a 400 keeps the hold', () => {
  const f = fakeSite({})
  const site = { url: 'https://site/node-rpc/hold' }
  holdThrough(site, 70_000, f)
  assert.deepEqual(f.asked, [25_000, 25_000, 20_000])
  assert.ok(site.url)
  const g = fakeSite({ status: 400, holds: () => 2 })
  const s2 = { url: 'https://site/node-rpc/hold' }
  holdThrough(s2, 2000, g)
  assert.equal(g.asked.length, 1)
  assert.ok(s2.url, 'a 400 is that request\'s fault, not the site\'s')
})
