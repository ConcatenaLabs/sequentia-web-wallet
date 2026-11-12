// order-note.js and covenant-recovery.js ordersFromNotes: a resting order's terms in a note the wallet
// writes to itself, and the order rebuilt from it alone (web wallet #717).
import test from 'node:test'
import assert from 'node:assert/strict'
import { HDKey, mnemonicToSeedSync, secp256k1 } from './btc.js'
import { noteKey, noteKeyBytes, sealNote, openNote, encodeTerms, decodeTerms, noteOfScript, NOTE_BYTES, NOTE_PATH, NOTE_INFO } from './order-note.js'
import { ordersFromNotes } from './covenant-recovery.js'
import { planPlaceOrder } from './covenant-order.js'
import { computeRate, covenantMinLot, covenantDerivationIds, orderExpiryTime } from './covenant-flow.js'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' // public, test only
const OTHER = 'exist carry drive collect lend cereal occur much tiger just involve mean'                       // public, test only
const root = (p) => HDKey.fromMasterSeed(mnemonicToSeedSync(p))
const hex = (b) => Buffer.from(b).toString('hex')
const ids = (k) => Array.from({ length: 32 }, (_, i) => ((k + i) & 255).toString(16).padStart(2, '0')).join('')
const A = ids(0x10), B = ids(0x80)
const TERMS = { receive: B, recvAtoms: 9_000_000n, expiry: orderExpiryTime(1794465000), makerIndex: 3, idsInternal: true }

// The vector another wallet (the extension, Ambra mobile) reproduces: the key of the phrase above,
// and the note of TERMS under a fixed nonce.
const VECTOR = {
  path: "m/1017'/9'/0'", info: 'sequentia/resting-order-note/v1',
  key: 'bc8917af3bac27072007449509536b32f3fa880a51f028de07230c8b99055227',
  nonce: '000102030405060708090a0b',
  note: '000102030405060708090a0bd565364d37716fb0bea8364b714dc8e29536f36bafcb12dcec3c4e69cf5e0903d95560de5d1ace26969232e32ceba9',
}

test('the key: HKDF-SHA256 of the key at m/1017\'/9\'/0\', labelled, one per phrase', async () => {
  assert.equal(NOTE_PATH, VECTOR.path); assert.equal(NOTE_INFO, VECTOR.info)
  const k = await noteKeyBytes(root(PHRASE))
  assert.equal(k.length, 32)
  // The same derivation by hand: WebCrypto's HKDF over the child's private key.
  const child = root(PHRASE).derive(NOTE_PATH)
  const base = await crypto.subtle.importKey('raw', child.privateKey, 'HKDF', false, ['deriveBits'])
  const byHand = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(NOTE_INFO) }, base, 256))
  assert.equal(hex(k), hex(byHand))
  assert.notEqual(hex(k), hex(child.privateKey), 'the label makes a key of its own, never the path\'s key itself')
  assert.notEqual(hex(k), hex(await noteKeyBytes(root(OTHER))))
  assert.equal(hex(k), VECTOR.key)
})

test('a note is 59 bytes and opens to its terms; a fixed nonce gives the vector', async () => {
  const key = await noteKey(root(PHRASE))
  const nonce = Uint8Array.from(Buffer.from(VECTOR.nonce, 'hex'))
  const note = await sealNote(key, TERMS, nonce)
  assert.equal(note.length, NOTE_BYTES); assert.equal(NOTE_BYTES, 59)
  assert.equal(hex(note.subarray(0, 12)), VECTOR.nonce, 'the nonce is stored in the clear')
  assert.equal(hex(note), VECTOR.note)
  // AES-256-CTR by hand, counter block = nonce ‖ 00000000.
  const raw = await crypto.subtle.importKey('raw', Buffer.from(VECTOR.key, 'hex'), 'AES-CTR', false, ['encrypt'])
  const ctr = new Uint8Array(16); ctr.set(nonce)
  const byHand = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: ctr, length: 32 }, raw, encodeTerms(TERMS)))
  assert.equal(hex(note.subarray(12)), hex(byHand))
  const back = await openNote(key, note)
  assert.deepEqual(back, TERMS)
  assert.deepEqual(await openNote(key, hex(note)), TERMS, 'from the explorer\'s hex as well')
})

test('the terms layout: flags, asset, amount, lock, key index', () => {
  const t = encodeTerms(TERMS)
  assert.equal(t.length, 47)
  assert.equal(t[0], 0x11, 'version 1, internal byte order')
  assert.equal(hex(t.subarray(1, 33)), B)
  assert.equal(hex(t.subarray(33, 41)), '0000000000895440')
  assert.equal(Buffer.from(t.subarray(41, 45)).readUInt32BE(0), TERMS.expiry)
  assert.equal(hex(t.subarray(45, 47)), '0003')
  assert.equal(encodeTerms({ ...TERMS, idsInternal: false })[0], 0x01)
  // What does not fit goes without a note (the searches stay for it).
  assert.equal(encodeTerms({ ...TERMS, makerIndex: 65536 }), null)
  assert.equal(encodeTerms({ ...TERMS, receive: 'BTC' }), null)
  assert.equal(encodeTerms({ ...TERMS, recvAtoms: 0n }), null)
  assert.equal(encodeTerms({ ...TERMS, expiry: 2 ** 32 }), null)
  // Another version, or a flag bit this format does not know, is not a note.
  const v2 = Uint8Array.from(t); v2[0] = 0x12
  assert.equal(decodeTerms(v2), null)
  const extra = Uint8Array.from(t); extra[0] = 0x31
  assert.equal(decodeTerms(extra), null)
})

test('two orders at the same terms carry unrelated notes', async () => {
  const key = await noteKey(root(PHRASE))
  const a = await sealNote(key, TERMS), b = await sealNote(key, TERMS)
  assert.notEqual(hex(a), hex(b))
  assert.notEqual(hex(a.subarray(0, 12)), hex(b.subarray(0, 12)))
  let same = 0; for (let i = 12; i < 59; i++) if (a[i] === b[i]) same++
  assert.ok(same < 10, `ciphertexts share ${same} of 47 bytes`)
})

test('another wallet\'s key opens a note to nothing usable', async () => {
  const note = await sealNote(await noteKey(root(PHRASE)), TERMS)
  const other = await openNote(await noteKey(root(OTHER)), note)
  assert.ok(other === null || JSON.stringify(other, (k, v) => typeof v === 'bigint' ? String(v) : v) !== JSON.stringify(TERMS, (k, v) => typeof v === 'bigint' ? String(v) : v))
})

test('a note is read only from a 59-byte data output', () => {
  const n = 'ab'.repeat(59)
  assert.equal(noteOfScript('6a3b' + n), n)
  assert.equal(noteOfScript('6a3a' + 'ab'.repeat(58)), null)
  assert.equal(noteOfScript('6a3b' + n + '00'), null)
  assert.equal(noteOfScript('5120' + 'ab'.repeat(32)), null)
  assert.equal(noteOfScript(''), null)
})

// --- ordersFromNotes: covenant scripts built as the page builds them -----------------------------------
const makerKeys = (n) => Array.from({ length: n }, (_, i) => {
  const priv = new Uint8Array(32); priv[31] = i + 7
  const x = Buffer.from(secp256k1.getPublicKey(priv, true)).subarray(1).toString('hex')
  return { index: i, program: x, internalKey: x }
})
function plan ({ sell, recv, index, expiry, receive = B }) {
  const m = makerKeys(index + 1)[index]
  const { rateNum, rateDen } = computeRate(sell, recv)
  return planPlaceOrder({ ...covenantDerivationIds(A, receive, true), sellAtoms: sell, rateNum, rateDen,
    minLot: covenantMinLot(sell), expiryLocktime: expiry, makerProg: m.program, makerX: m.internalKey })
}
const out = (spk, value, asset = A) => ({ scriptpubkey: spk, value, asset })

test('a funding with a note rebuilds its order exactly; nothing else is taken for one', async () => {
  const key = await noteKey(root(PHRASE)), open = (n) => openNote(key, n)
  const p1 = plan({ sell: 100_00000000n, recv: 9_000_000n, index: 3, expiry: TERMS.expiry })
  const p2 = plan({ sell: 5_00000000n, recv: 7_000n, index: 4, expiry: TERMS.expiry + 60 })
  const n1 = hex(await sealNote(key, TERMS))
  const n2 = hex(await sealNote(key, { ...TERMS, recvAtoms: 7_000n, expiry: TERMS.expiry + 60, makerIndex: 4 }))
  const wrong = hex(await sealNote(await noteKey(root(OTHER)), TERMS))
  const elsewhere = plan({ sell: 100_00000000n, recv: 9_000_001n, index: 3, expiry: TERMS.expiry })
  const txs = {
    // the order, its change and the note
    f1: { txid: 'f1', vout: [out('0014' + '11'.repeat(20), 5), out(p1.spkHex, 100_00000000), out('6a3b' + n1, 0, B)] },
    // a note of this wallet beside a taproot output its terms do not derive (someone's address)
    f2: { txid: 'f2', vout: [out(elsewhere.spkHex, 100_00000000), out('6a3b' + n1, 0)] },
    // the order of another wallet's key, and a note under that key
    f3: { txid: 'f3', vout: [out(p1.spkHex, 100_00000000), out('6a3b' + wrong, 0)] },
    // no note
    f4: { txid: 'f4', vout: [out(p2.spkHex, 5_00000000), out('0014' + '22'.repeat(20), 1)] },
    // the second order
    f5: { txid: 'f5', vout: [out(p2.spkHex, 5_00000000), out('6a3b' + n2, 0)] },
  }
  const io = { ownSpends: async () => Object.keys(txs).map((txid) => ({ txid })), get: async (p) => txs[p.split('/')[2]] || null }
  const seen = new Set(), checked = { has: (t) => seen.has(t), add: (t) => seen.add(t) }
  const makerAt = (i) => makerKeys(i + 1)[i]
  const recs = await ordersFromNotes(io, { open, makerAt, known: new Set(), checked })
  assert.deepEqual(recs.map((r) => r.fundTxid), ['f1', 'f5'])
  const [r1, r2] = recs
  assert.equal(r1.spkHex, p1.spkHex); assert.equal(r1.covTxid, 'f1'); assert.equal(r1.covVout, 1)
  assert.equal(r1.sellAtoms, '10000000000'); assert.equal(r1.recvAtoms, '9000000'); assert.equal(r1.receive, B); assert.equal(r1.pay, A)
  assert.equal(r1.makerIndex, 3); assert.equal(r1.expiry, TERMS.expiry); assert.equal(r1.idsInternal, true); assert.equal(r1.fromNote, true)
  assert.equal(r2.makerIndex, 4); assert.equal(r2.recvAtoms, '7000')
  assert.deepEqual([...seen], ['f4'], 'only a transaction without a note is never read again')
  // An order the records hold is not rebuilt twice.
  const again = await ordersFromNotes(io, { open, makerAt, known: new Set([p1.spkHex, p2.spkHex]), checked })
  assert.deepEqual(again, [])
  // Its record deleted by hand after that scan: the next scan rebuilds it from the note.
  const third = await ordersFromNotes(io, { open, makerAt, known: new Set([p2.spkHex]), checked })
  assert.deepEqual(third.map((r) => r.fundTxid), ['f1'])
  assert.equal(third[0].spkHex, p1.spkHex)
  // A read that fails skips its transaction only: what was found is kept, and it is read again next time.
  let fails = 1
  const flaky = { ownSpends: io.ownSpends, get: async (p) => { if (p.includes('f3') && fails-- > 0) throw new Error('503'); return io.get(p) } }
  const seen2 = new Set(), checked2 = { has: (t) => seen2.has(t), add: (t) => seen2.add(t) }
  const part = await ordersFromNotes(flaky, { open, makerAt, known: new Set(), checked: checked2 })
  assert.deepEqual(part.map((r) => r.fundTxid), ['f1', 'f5'], 'both orders found despite the failed read')
  assert.ok(!seen2.has('f3'), 'the transaction whose read failed is left to be read again')
})
