// A Reclaim whose refund never reaches a block brings its order back (web wallet #722, review
// RV45 R5). Reclaim puts the order's record away when it broadcasts the refund; a refund dropped
// from the mempool (a node restarted without it, a fee no longer accepted) leaves the coin resting
// at the order's script. The page then restores the record, in default mode too (#725), so Reclaim
// is there again. A refund just sent is given time for the explorer to see it spend the coin.
//
//   node --test covenant-reclaim-restore.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const REC = JSON.parse(readFileSync(new URL('./tooling/fixtures/explorer-scripthash-answer.json', import.meta.url), 'utf8'))
const COIN = REC.utxo[REC.forward][0]
const MIN = 60_000
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
globalThis.WebSocket = class { constructor () { this.readyState = 0 } send () {} close () {} addEventListener () {} }
const { initSwap, __test__: SW } = await import('./swap.js')
const answer = (v, status = 200) => ({ ok: status === 200, status, json: async () => v, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) })
let utxo = REC.utxo
initSwap({
  $: () => null, toast: () => {}, assetMeta: () => ({ ticker: 'X', precision: 8 }), fmtAtoms: String,
  wasm: {}, signer: {}, network: {}, SEQOB: 'http://127.0.0.1:9', devMode: () => false,
  wollet: { tip: () => ({ height: () => 100 }), transactions: () => [] },
  esploraFetch: async (path) => {
    const m = path.match(/^\/scripthash\/([0-9a-f]{64})\/(utxo|txs)$/)
    if (m) return answer(m[2] === 'utxo' ? (utxo[m[1]] || []) : [])
    return answer('Transaction not found', 404)
  },
})
const reclaimed = (ago) => ({ offerId: 'o1', spkHex: REC.script, pay: COIN.asset, receive: 'bb'.repeat(32), sellAtoms: String(COIN.value),
  recvAtoms: '9', makerIndex: 0, expiry: 1794552000, posted: false, idsInternal: true, covTxid: COIN.txid, covVout: COIN.vout,
  refundTxid: 'cc'.repeat(32), archivedAt: Date.now() - ago, archivedWhy: 'reclaimed' })
const archive = (list) => { store.set('seqobCovenantOrders.v1', '[]'); store.set('seqobCovenantOrders.archived.v1', JSON.stringify(list)); SW.loadPlaced() }

test('a refund just sent is given time: its order is not brought back at once', async () => {
  archive([reclaimed(1 * MIN)])
  assert.equal(await SW.restoreArchived(), 0)
  assert.equal(SW.placed().length, 0)
})

test('a refund that never reached a block brings the order back, in default mode, with its coin', async () => {
  archive([reclaimed(10 * MIN)])
  await SW.scanLostOrders(true)
  const placed = SW.placed()
  assert.equal(placed.length, 1, 'the order is in Your resting orders again')
  assert.equal(placed[0].covTxid, COIN.txid)
  assert.equal(placed[0].restAtoms, String(COIN.value))
  assert.equal(placed[0].archivedWhy, undefined)
  assert.equal(placed[0].refundTxid, undefined)
  assert.equal(SW.archived().length, 0)
})

test('a refund in a block leaves nothing at the script: the order stays put away', async () => {
  utxo = {}
  archive([reclaimed(10 * MIN)])
  assert.equal(await SW.restoreArchived(), 0)
  assert.equal(SW.archived().length, 1)
  utxo = REC.utxo
})

test('a stranger\'s coin at the script brings nothing back (web wallet #723)', async () => {
  utxo = { [REC.forward]: [{ ...COIN, asset: 'ee'.repeat(32) }] }
  archive([reclaimed(10 * MIN)])
  assert.equal(await SW.restoreArchived(), 0)
  utxo = REC.utxo
})
