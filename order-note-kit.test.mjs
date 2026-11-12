// swap.js kitWritesNotes: a page served with a wallet kit that has no data output places resting
// orders without a note and records them so (web wallet #717, review RV47).
import test from 'node:test'
import assert from 'node:assert/strict'

const mem = new Map()
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { kitWritesNotes } = await import('./swap.js')

test('a kit without the data output is told apart, and said so once', () => {
  const said = []
  const old = { txBuilder: () => ({ addExplicitRecipient () {}, free () {} }) }
  const kit = { txBuilder: () => ({ addExplicitRecipient () {}, addDataOutput () {}, free () {} }) }
  assert.equal(kitWritesNotes(old, (m) => said.push(m)), false)
  assert.equal(kitWritesNotes(old, (m) => said.push(m)), false)
  assert.equal(said.length, 1, 'once')
  assert.match(said[0], /no data output/)
  assert.equal(kitWritesNotes(kit, (m) => said.push(m)), true)
  assert.equal(kitWritesNotes({ txBuilder: () => { throw new Error('no network') } }, () => {}), false)
})
