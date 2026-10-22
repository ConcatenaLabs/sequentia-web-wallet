// An invoice under a payment hash the node does not hold the preimage of.
//
// A hold (holdinvoice-seq) takes HTLCs under a hash the device registered, and its preimage stays
// on the device until the device settles: the hosted node, and so the service hosting it, never
// learns it first. The plugin makes no BOLT11 of its own, since a node signs an invoice only for a
// hash it made. So the service makes an ordinary invoice of the node's own first (its amount,
// expiry, final delta, route hints and features as the node writes them, under a throwaway hash),
// deletes it, puts the hold's hash in its place (`withPaymentHash`), and has the node sign the
// result (`signinvoice`, which signs a BOLT11 without saving it or knowing a preimage). An HTLC
// under the hash is then taken by the plugin before the node looks for an invoice, so the payment
// secret the throwaway invoice carried is never checked.
//
// No I/O: the BOLT11 data part as five-bit groups, the `p` field (type 1, 52 groups) replaced, the
// checksum computed again. The signature's groups are left as they were; the node's `signinvoice`
// ignores them and writes its own.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function polymod (values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0
  }
  return chk
}
const expand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]

function hexToGroups (hex) {
  const out = []
  let acc = 0, bits = 0
  for (const b of Buffer.from(hex, 'hex')) {
    acc = (acc << 8) | b; bits += 8
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31) }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

// The same invoice with `paymentHash` (32-byte hex) as its `p` field and a valid checksum.
export function withPaymentHash (bolt11, paymentHash) {
  if (!/^[0-9a-f]{64}$/i.test(String(paymentHash || ''))) throw new Error('a payment hash is 32 bytes of hex')
  const s = String(bolt11 || '').trim().toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 1) throw new Error('not a BOLT11 invoice')
  const hrp = s.slice(0, sep)
  const vals = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c))
  if (vals.some((v) => v < 0) || vals.length < 7 + 104 + 6) throw new Error('not a BOLT11 invoice')
  if (polymod(expand(hrp).concat(vals)) !== 1) throw new Error('the invoice checksum does not verify')
  const data = vals.slice(0, vals.length - 6)
  const end = data.length - 104
  const groups = hexToGroups(paymentHash.toLowerCase())
  let i = 7, done = false
  while (i + 3 <= end) {
    const type = data[i], len = (data[i + 1] << 5) | data[i + 2]
    if (i + 3 + len > end) break
    if (type === 1 && len === 52) {
      if (done) throw new Error('the invoice carries two payment hashes')
      data.splice(i + 3, 52, ...groups); done = true
    }
    i += 3 + len
  }
  if (!done) throw new Error('the invoice carries no payment hash')
  const mod = polymod(expand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1
  const chk = [0, 1, 2, 3, 4, 5].map((k) => (mod >> (5 * (5 - k))) & 31)
  return hrp + '1' + data.concat(chk).map((v) => CHARSET[v]).join('')
}
