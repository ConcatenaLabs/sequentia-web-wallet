// A resting order's coins are never lost from sight (web wallet #708).
//
//  * The page finds the order's output under the id the explorer answers by (the recorded answer
//    in tooling/fixtures/explorer-scripthash-answer.json), and keeps the record.
//  * A record is put away only when two different reads agree its funding never landed, twice,
//    ten minutes apart; a read that fails decides nothing.
//  * An order whose record is gone is rebuilt from what the person asked for in return, and only
//    when the terms derive the coin's very script.
//
//   node --test covenant-recovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { locateFunding, applyLocate, findUnrecordedLocks, expiryCandidates, rebuildOrder, recvCandidates,
  FUNDING_GRACE_MS, ABSENT_RECHECK_MS } from './covenant-recovery.js'
import { planPlaceOrder } from './covenant-order.js'
import { computeRate, covenantMinLot, covenantDerivationIds, orderExpiryTime } from './covenant-flow.js'
import { secp256k1 } from './btc.js'

const REC = JSON.parse(readFileSync(new URL('./tooling/fixtures/explorer-scripthash-answer.json', import.meta.url), 'utf8'))
const COIN = REC.utxo[REC.forward][0]
const MIN = 60_000

// An explorer answering exactly as the recorded one: the coin under the id as computed, nothing
// under the reversed id. `extra` adds answers; a path in `fail` answers 500.
function explorer (extra = {}, fail = []) {
  const asked = []
  const get = async (path) => {
    asked.push(path)
    if (fail.some((f) => path.includes(f))) throw new Error('explorer 500 for ' + path)
    if (path in extra) return extra[path]
    const m = path.match(/^\/scripthash\/([0-9a-f]{64})\/(utxo|txs)$/)
    if (m) return m[2] === 'utxo' ? (REC.utxo[m[1]] || []) : []
    return null
  }
  return { get, asked }
}
const record = (o = {}) => ({ offerId: 'o1', spkHex: REC.script, sellAtoms: String(COIN.value), covTxid: null, covVout: null,
  created: Date.now() - 11 * MIN, ...o })

test('a record without its outpoint finds the coin under the explorer\'s id, never the reversed one', async () => {
  const ex = explorer()
  const res = await locateFunding(record(), ex)
  assert.deepEqual(res, { found: { txid: COIN.txid, vout: COIN.vout } })
  assert.ok(ex.asked.includes(`/scripthash/${REC.forward}/utxo`))
  assert.ok(!ex.asked.some((p) => p.includes(REC.reversed)), 'the reversed id is never asked')
  const rec = record()
  assert.equal(applyLocate(rec, res), 'found')
  assert.equal(rec.covTxid, COIN.txid)
})

test('an order already filled or taken back is found in the script\'s history, not put away', async () => {
  const spent = { txid: 'ab'.repeat(32), vout: [{ scriptpubkey: '0014' + '00'.repeat(20) }, { scriptpubkey: REC.script }] }
  const ex = explorer({ [`/scripthash/${REC.forward}/utxo`]: [], [`/scripthash/${REC.forward}/txs`]: [spent] })
  assert.deepEqual(await locateFunding(record(), ex), { found: { txid: spent.txid, vout: 1 } })
})

test('one empty answer is never enough: the funding by its id, then a second look ten minutes on', async () => {
  const fund = 'cd'.repeat(32)
  const empty = { [`/scripthash/${REC.forward}/utxo`]: [] }
  // Young: nothing is decided.
  assert.deepEqual(await locateFunding(record({ fundTxid: fund, created: Date.now() - 2 * MIN }), explorer(empty)), { wait: 'young' })
  // The funding is in the mempool: found by its id though the script's index has not caught up.
  const inPool = explorer({ ...empty, [`/tx/${fund}/status`]: { confirmed: false }, [`/tx/${fund}`]: { txid: fund, vout: [{ scriptpubkey: REC.script }] } })
  assert.deepEqual(await locateFunding(record({ fundTxid: fund }), inPool), { found: { txid: fund, vout: 0 } })
  // Unknown by its id too: absent, noted once, put away only when absent again ten minutes later.
  const gone = explorer(empty)
  const rec = record({ fundTxid: fund })
  const t0 = Date.now()
  const res = await locateFunding(rec, gone, t0)
  assert.deepEqual(res, { absent: true })
  assert.ok(gone.asked.includes(`/tx/${fund}/status`), 'the second read is the funding by its id')
  assert.equal(applyLocate(rec, res, t0), 'noted')
  assert.equal(applyLocate(rec, res, t0 + ABSENT_RECHECK_MS - 1), 'wait')
  assert.equal(applyLocate(rec, res, t0 + ABSENT_RECHECK_MS), 'archive')
  // A later sighting clears the note.
  assert.equal(applyLocate(rec, { found: { txid: fund, vout: 0 } }), 'found')
  assert.equal(rec.absentAt, undefined)
})

test('a read that fails decides nothing', async () => {
  await assert.rejects(() => locateFunding(record(), explorer({}, ['/utxo'])))
  await assert.rejects(() => locateFunding(record({ fundTxid: 'cd'.repeat(32) }), explorer({ [`/scripthash/${REC.forward}/utxo`]: [] }, ['/status'])))
})

test('a record older than the funding id asks the wallet\'s own history instead', async () => {
  const empty = { [`/scripthash/${REC.forward}/utxo`]: [] }
  const ex = explorer(empty)
  ex.ownPayment = async () => ({ txid: 'ef'.repeat(32), vout: 2 })
  assert.deepEqual(await locateFunding(record(), ex), { found: { txid: 'ef'.repeat(32), vout: 2 } })
  ex.ownPayment = async () => null
  assert.deepEqual(await locateFunding(record(), ex), { absent: true })
  ex.ownPayment = async () => { throw new Error('wallet not synced') }
  await assert.rejects(() => locateFunding(record(), ex))
  delete ex.ownPayment
  assert.deepEqual(await locateFunding(record(), ex), { wait: 'no second read' })
})

// --- taking back an order whose record is gone ------------------------------------------------------
// Asset ids that read differently byte-reversed, as real ones do.
const ids = (k) => Array.from({ length: 32 }, (_, i) => ((k + i) & 255).toString(16).padStart(2, '0')).join('')
const A = ids(0x10), B = ids(0x80)
const makerKeys = (n) => Array.from({ length: n }, (_, i) => {
  const priv = new Uint8Array(32); priv[31] = i + 7
  const x = Buffer.from(secp256k1.getPublicKey(priv, true)).subarray(1).toString('hex')
  return { index: i, program: x, internalKey: x }
})
function placedOrder ({ sell, recv, index, expiry, idsInternal = true }) {
  const m = makerKeys(index + 1)[index]
  const { rateNum, rateDen } = computeRate(sell, recv)
  return planPlaceOrder({ ...covenantDerivationIds(A, B, idsInternal), sellAtoms: sell, rateNum, rateDen,
    minLot: covenantMinLot(sell), expiryLocktime: expiry, makerProg: m.program, makerX: m.internalKey })
}

test('an order is rebuilt from what the person asked for, only when it derives the coin\'s script', async () => {
  const expiry = orderExpiryTime(1794465000)
  const plan = placedOrder({ sell: 100_00000000n, recv: 9_000_000n, index: 3, expiry })
  const lock = { txid: '11'.repeat(32), vout: 0, spkHex: plan.spkHex, asset: A, value: 100_00000000n }
  const args = { lock, receive: [B], makers: makerKeys(8), expiries: [orderExpiryTime(1794464900), expiry, 209100 + 1440] }
  const rec = await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.09', 8) })
  assert.ok(rec, 'found')
  assert.equal(rec.makerIndex, 3); assert.equal(rec.expiry, expiry); assert.equal(rec.recvAtoms, '9000000')
  assert.equal(rec.sellAtoms, '10000000000'); assert.equal(rec.pay, A); assert.equal(rec.receive, B)
  assert.equal(rec.covTxid, lock.txid); assert.equal(rec.idsInternal, true); assert.equal(rec.recovered, true)
  // A price typed in the composer can round the amount an atom either way.
  assert.ok(await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.09000001', 8) }))
  // Any other amount, asset, key or lock derives another script: nothing is offered to sign.
  assert.equal(await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.091', 8) }), null)
  assert.equal(await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.09', 8), receive: ['c3'.repeat(32)] }), null)
  assert.equal(await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.09', 8), makers: makerKeys(3) }), null)
  assert.equal(await rebuildOrder({ ...args, recvAtoms: recvCandidates('0.09', 8), expiries: [expiry + 1] }), null)
})

test('an order placed before the asset byte-order fix is rebuilt in its own generation', async () => {
  const expiry = 209100 + 1440
  const plan = placedOrder({ sell: 5000n, recv: 7n, index: 0, expiry, idsInternal: false })
  const lock = { txid: '22'.repeat(32), vout: 1, spkHex: plan.spkHex, asset: A, value: 5000n }
  const rec = await rebuildOrder({ lock, receive: [B], recvAtoms: [7n], makers: makerKeys(2), expiries: [expiry] })
  assert.equal(rec.idsInternal, false)
})

test('the locks an order can carry: a day after the median time of the blocks below its funding, or a day of blocks', async () => {
  const chain = { '/blocks/tip/height': 500 }
  for (let h = 1; h <= 500; h++) { chain[`/block-height/${h}`] = 'h' + h; chain[`/block/h${h}`] = { mediantime: 1794400000 + 60 * h } }
  const ex = await expiryCandidates({ get: async (p) => chain[p] ?? null }, 400)
  assert.ok(ex.includes(orderExpiryTime(1794400000 + 60 * 399)), 'the block just below')
  assert.ok(ex.includes(orderExpiryTime(1794400000 + 60 * 385)), 'fifteen blocks below')
  assert.ok(!ex.includes(orderExpiryTime(1794400000 + 60 * 400)), 'never the funding\'s own block')
  assert.ok(ex.includes(399 + 1440) && ex.includes(340 + 1440))
  const pending = await expiryCandidates({ get: async (p) => chain[p] ?? null }, null)
  assert.ok(pending.includes(orderExpiryTime(1794400000 + 60 * 500)), 'not in a block yet: from the tip')
})

test('the wallet lists what it paid to a taproot script it holds no record of, and that is still there', async () => {
  const p2tr = (b) => '5120' + b.repeat(32)
  const txs = {
    '/tx/t1': { txid: 't1', status: { confirmed: true, block_height: 10, block_time: 1794400000 }, vout: [
      { scriptpubkey: p2tr('01'), value: 5, asset: A }, { scriptpubkey: '0014' + '02'.repeat(20), value: 1, asset: A }, { scriptpubkey: '', value: 1, asset: A }] },
    '/tx/t2': { txid: 't2', status: { confirmed: true, block_height: 11 }, vout: [{ scriptpubkey: p2tr('03'), value: 6, asset: B }] },
    '/tx/t3': { txid: 't3', status: { confirmed: true, block_height: 12 }, vout: [{ scriptpubkey: p2tr('04'), value: 7, asset: B }] },
    '/tx/t4': { txid: 't4', status: { confirmed: true, block_height: 13 }, vout: [{ scriptpubkey: p2tr('05'), value: null, asset: null }] },
    '/tx/t2/outspend/0': { spent: true },
  }
  const seen = new Set()
  const io = { get: async (p) => txs[p] ?? (p.includes('/outspend/') ? { spent: false } : null), ownSpends: async () => ['t1', 't2', 't3', 't4'].map((txid) => ({ txid })) }
  const locks = await findUnrecordedLocks(io, { known: new Set([p2tr('04')]), checked: { has: (t) => seen.has(t), add: (t) => seen.add(t) } })
  assert.deepEqual(locks.map((l) => [l.txid, l.vout, l.value, l.height]), [['t1', 0, 5n, 10]])
  assert.deepEqual([...seen].sort(), ['t2', 't3', 't4'], 'a transaction with nothing left is not read again')
})

test('what the person asked for, in atoms', () => {
  assert.deepEqual(recvCandidates('0.09', 8), [9000000n, 8999999n, 9000001n])
  assert.deepEqual(recvCandidates('1,000', 2), [100000n, 99999n, 100001n])
  assert.deepEqual(recvCandidates('0.123', 2), [])
  assert.deepEqual(recvCandidates('abc', 8), [])
  assert.deepEqual(recvCandidates('', 8), [])
})
