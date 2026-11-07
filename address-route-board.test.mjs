// A payment to an address right after the leaf wallet boarded the coins it would have paid from
// goes out of the tree, never on the chain from a coin the board spent (#574): the page's reading
// of the chain can still list that coin, and the node refuses the payment as spending it.
import assert from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { addressRoute, onchainLessBoards, boardSpent } from './default-arca.js'

test('a payment just after a board is routed with what the board left on the chain', () => {
  const t = 1_800_000_000_000
  // 5,000 OILX reached the address and was boarded whole; the page's reading still lists it.
  const rec = boardSpent(500_000_000_000n, 500_000_000_000n, t, 'ef'.repeat(32))
  const onchain = onchainLessBoards(rec, 500_000_000_000n, t + 50_000, () => false).atoms
  assert.equal(addressRoute(100_000_000n, onchain, 499_000_000_000n, 4n), 'tree')
  // Once the reading holds the board, it is read as it is.
  assert.equal(addressRoute(100_000_000n, onchainLessBoards(rec, 0n, t + 90_000, () => true).atoms, 499_000_000_000n, 4n), 'tree')
})

test('the Send tab asks for that route with the board taken off', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.match(html, /onchain = leavesApi\.onchainLessBoards\(h, onchain\)/)
  assert.match(html, /addressRoute\(a, onchain, tree, margin, comingBack\)/)
})
