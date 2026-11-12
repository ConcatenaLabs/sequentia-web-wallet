// The page keeps a resting order's record when the order's coins are on the chain (web wallet #708):
// swap.js on a wallet open, with the explorer answering exactly as the testnet's did
// (tooling/fixtures/explorer-scripthash-answer.json: the coin under the script's SHA-256 as
// computed, nothing under the byte-reversed id).
//
//   node --test covenant-record-kept.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const REC = JSON.parse(readFileSync(new URL('./tooling/fixtures/explorer-scripthash-answer.json', import.meta.url), 'utf8'))
const COIN = REC.utxo[REC.forward][0]
const MIN = 60_000
const record = (o = {}) => ({ offerId: 'o1', spkHex: REC.script, sellAtoms: String(COIN.value), covTxid: null, covVout: null,
  created: Date.now() - 11 * MIN, ...o })

// swap.js on a wallet open, with the explorer answering as recorded: the record of an order whose
// page closed before the funding's outpoint was written keeps its coins in sight. Before #708's fix
// the page asked under the reversed id, read the empty list as "never funded" and dropped the record.
test('the page keeps the record and learns its outpoint (fails before #708)', async () => {
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.WebSocket = class { constructor () { this.readyState = 0 } send () {} close () {} addEventListener () {} }
  const { initSwap, resumeCovenantOrders } = await import('./swap.js')
  const answer = (v, status = 200) => ({ ok: status === 200, status, json: async () => v, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) })
  initSwap({
    $: () => null, toast: () => {}, assetMeta: () => ({ ticker: 'X', precision: 8 }), fmtAtoms: String,
    wasm: {}, signer: {}, network: {}, SEQOB: 'http://127.0.0.1:9',
    wollet: { tip: () => ({ height: () => 100 }), transactions: () => [] },
    esploraFetch: async (path) => {
      const m = path.match(/^\/scripthash\/([0-9a-f]{64})\/(utxo|txs)$/)
      if (m) return answer(m[2] === 'utxo' ? (REC.utxo[m[1]] || []) : [])
      return answer('Transaction not found', 404)
    },
  })
  store.set('seqobCovenantOrders.v1', JSON.stringify([{ ...record(), pay: 'aa'.repeat(32), receive: 'bb'.repeat(32), recvAtoms: '9', makerIndex: 0, expiry: 1794552000, posted: false, idsInternal: true }]))
  resumeCovenantOrders()
  let placed
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10))
    placed = JSON.parse(store.get('seqobCovenantOrders.v1') || '[]')
    if (!placed.length || placed[0].covTxid) break
  }
  assert.equal(placed.length, 1, 'the record of an order whose coins are on the chain is kept')
  assert.equal(placed[0].covTxid, COIN.txid)
  assert.equal(placed[0].covVout, COIN.vout)
})
