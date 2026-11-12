// order-note.js: a resting order's terms, in a note the wallet writes to itself in the order's
// funding transaction (web wallet #717).
//
// A resting covenant order's terms (the asset and amount asked for, the refund lock, the maker
// key's index) are inside the covenant script's taproot commitment, which the chain shows only as
// a hash. Without them the wallet cannot rebuild the order, so it cannot take it back. The note
// puts them on the chain, encrypted to a key only the wallet's phrase gives: a restore from the
// phrase alone reads its own transactions, opens its notes and rebuilds every order exactly.
//
// The note is one data output of the funding transaction (`OP_RETURN <59 bytes>`, value 0). It is
// carried in the funding's fee asset: an asset the transaction already moves, that the node relaying
// it accepts, and that the person chose. So it adds no input and no change, and it is never the
// policy asset unless the person pays the fee in it.
//
// Format (59 bytes):
//   nonce          12 bytes, random per note
//   ciphertext     47 bytes: AES-256-CTR of the terms below, counter block = nonce ‖ 00000000
// Terms (47 bytes, big-endian integers):
//   flags           1 byte: bits 0-3 the format version (1), bit 4 set when the covenant was
//                   derived from asset ids in internal byte order (every order placed since that
//                   fix), bits 5-7 zero
//   asked asset    32 bytes: the asset asked for, display byte order (as the explorer shows it)
//   asked amount    8 bytes: atoms of the asked asset for the whole amount locked
//   lock            4 bytes: the refund's nLockTime (below 500,000,000 a height, else a time)
//   maker key       2 bytes: the index of the order's maker key (covenant-fill-host.js makerPayout)
// The asset and amount locked are the covenant output's own, explicit on the chain beside the note.
//
// The key (the same derivation in every wallet that writes or reads these notes):
//   ikm  = the 32-byte private key at m/1017'/9'/0' of the wallet's own key tree (BIP32 from the
//          phrase's seed: BIP39, or an Electrum segwit seed's own)
//   key  = HKDF-SHA256(ikm, salt = empty, info = "sequentia/resting-order-note/v1", 32 bytes)
// The path is in the web wallet's private range beside its Lightning keys (seqln-keys.js) and its
// payment-name key (lnaddr.js); the label names the key's one use.
//
// There is no authentication tag. A note is accepted only when its terms, with the locked asset
// and amount, derive the covenant's very script (covenant-recovery.js ordersFromNotes); a wrong key
// or someone else's note yields terms that derive another script, except with probability 2^-256.
//
// What an observer learns: that the transaction carries a 59-byte data output, and so, by its size,
// that this wallet probably wrote it and that the taproot output beside it is probably a resting
// order. Nothing of the terms, and nothing that links two notes: each nonce is random, so two
// orders at the same terms carry unrelated notes, and no field repeats from one note to the next.

export const NOTE_PATH = "m/1017'/9'/0'"
export const NOTE_INFO = 'sequentia/resting-order-note/v1'
export const NOTE_VERSION = 1
export const NONCE_BYTES = 12
export const TERMS_BYTES = 47
export const NOTE_BYTES = NONCE_BYTES + TERMS_BYTES   // 59
export const NOTE_SCRIPT_PREFIX = '6a3b'              // OP_RETURN, a push of 59 bytes
const IDS_INTERNAL = 0x10

const subtle = () => globalThis.crypto.subtle
const hexToBytes = (h) => { const s = String(h); const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return b }
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// The 32 bytes of the note key of the wallet whose BIP32 root is `root` (an HDKey: the page's
// btcRoot, the root of the same seed both chains derive from).
export async function noteKeyBytes (root) {
  const child = root.derive(NOTE_PATH)
  if (!child.privateKey) throw new Error('the note key needs the private key tree')
  const base = await subtle().importKey('raw', child.privateKey, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(NOTE_INFO) }, base, 256))
}

// The note key of the wallet whose BIP32 root is `root`, for sealNote and openNote.
export async function noteKey (root) {
  return subtle().importKey('raw', await noteKeyBytes(root), { name: 'AES-CTR' }, false, ['encrypt', 'decrypt'])
}

// terms { receive (display hex), recvAtoms, expiry, makerIndex, idsInternal } -> 47 bytes, or null
// when a field does not fit the format (the order then goes without a note, and the searches stay).
export function encodeTerms ({ receive, recvAtoms, expiry, makerIndex, idsInternal }) {
  const asset = String(receive || '').toLowerCase()
  const recv = BigInt(recvAtoms), lock = Number(expiry), idx = Number(makerIndex)
  if (!/^[0-9a-f]{64}$/.test(asset) || recv < 1n || recv > 0xffffffffffffffffn) return null
  if (!Number.isInteger(lock) || lock < 0 || lock > 0xffffffff || !Number.isInteger(idx) || idx < 0 || idx > 0xffff) return null
  const out = new Uint8Array(TERMS_BYTES), v = new DataView(out.buffer)
  out[0] = NOTE_VERSION | (idsInternal ? IDS_INTERNAL : 0)
  out.set(hexToBytes(asset), 1)
  v.setBigUint64(33, recv)
  v.setUint32(41, lock)
  v.setUint16(45, idx)
  return out
}

// 47 bytes -> terms, or null when they cannot be a note of this format.
export function decodeTerms (b) {
  if (!b || b.length !== TERMS_BYTES) return null
  const flags = b[0]
  if ((flags & 0x0f) !== NOTE_VERSION || (flags & ~(0x0f | IDS_INTERNAL) & 0xff)) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const recvAtoms = v.getBigUint64(33)
  if (recvAtoms < 1n) return null
  return { receive: bytesToHex(b.subarray(1, 33)), recvAtoms, expiry: v.getUint32(41), makerIndex: v.getUint16(45), idsInternal: !!(flags & IDS_INTERNAL) }
}

const ctr = (nonce) => { const c = new Uint8Array(16); c.set(nonce, 0); return { name: 'AES-CTR', counter: c, length: 32 } }

// The note of `terms` under `key`. -> 59 bytes, or null when the terms do not fit the format.
export async function sealNote (key, terms, nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
  const plain = encodeTerms(terms)
  if (!plain) return null
  if (!nonce || nonce.length !== NONCE_BYTES) throw new Error('a note nonce is 12 bytes')
  const ct = new Uint8Array(await subtle().encrypt(ctr(nonce), key, plain))
  const out = new Uint8Array(NOTE_BYTES)
  out.set(nonce, 0); out.set(ct, NONCE_BYTES)
  return out
}

// The terms in `note` (59 bytes, or the hex of them) under `key`, or null when it cannot be a note.
// Terms that decode are only a candidate: the caller keeps them only if they derive the order's script.
export async function openNote (key, note) {
  const b = typeof note === 'string' ? hexToBytes(note) : note
  if (!b || b.length !== NOTE_BYTES) return null
  const plain = new Uint8Array(await subtle().decrypt(ctr(b.subarray(0, NONCE_BYTES)), key, b.subarray(NONCE_BYTES)))
  return decodeTerms(plain)
}

// The note carried by an explorer output's script hex, or null.
export function noteOfScript (spkHex) {
  const s = String(spkHex || '').toLowerCase()
  return s.length === 2 * (2 + NOTE_BYTES) && s.startsWith(NOTE_SCRIPT_PREFIX) ? s.slice(4) : null
}
