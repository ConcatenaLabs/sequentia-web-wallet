// pay-code.js: the one receive code, written and read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayCode, readPayCode, compactRequest, expandRequest, readShortRequest, libraryRequest, bech32mEncode, bech32mDecode } from './pay-code.js'

const TB1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
// Bark's testnet ark address, as the Bitcoin ark gives one (131 characters, bech32m).
const ARK = bech32mEncode('tark', Array.from({ length: 76 }, (_, i) => (i * 7) & 255))
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex')
const h = (c, n) => c.repeat(2 * n)
const INFO = { operator: 'ab'.repeat(32), genesis_hash: 'cd'.repeat(32) }
// A receive request as the leaf library spells it (`receive` in bark/src/arca/pay.rs).
const REQ = { kind: 'request', genesis_hash: INFO.genesis_hash, operator: INFO.operator, owner: h('1', 32),
  owner_nonce: h('2', 32), mailbox: h('3', 32), exit_delay_units: 4096, until: 1793350000, landing: h('4', 20), template: 'vtxo-2' }
const LIB = 'arca:' + hexOf(JSON.stringify(REQ))

test('bech32m: what is written is read back; a changed character is not', () => {
  const s = bech32mEncode('sqr', [0, 1, 2, 255, 128])
  assert.deepEqual(Array.from(bech32mDecode(s).bytes), [0, 1, 2, 255, 128])
  assert.deepEqual(Array.from(bech32mDecode(s.toUpperCase()).bytes), [0, 1, 2, 255, 128])
  const bad = s.slice(0, -1) + (s.endsWith('q') ? 'p' : 'q')
  assert.equal(bech32mDecode(bad), null)
  // BIP350's own test vector.
  assert.ok(bech32mDecode('a1lqfn3a'))
})

test('the receive request goes short, and the payer on its operator gets the library\'s request back', () => {
  const short = compactRequest(LIB)
  assert.match(short, /^sqr1[02-9ac-hj-np-z]+$/)
  assert.ok(short.length < 240, `short form ${short.length} chars`)
  assert.ok(LIB.length > 2.5 * short.length, `library ${LIB.length} vs short ${short.length}`)
  const back = expandRequest(short, INFO)
  assert.deepEqual(libraryRequest(back), REQ)
  // Upper case, as the picture holds it, is the same request.
  assert.deepEqual(libraryRequest(expandRequest(short.toUpperCase(), INFO)), REQ)
})

test('a short request is never paid on another operator or chain', () => {
  const short = compactRequest(LIB)
  assert.equal(expandRequest(short, { ...INFO, operator: 'ef'.repeat(32) }), null)
  assert.equal(expandRequest(short, { ...INFO, genesis_hash: '00'.repeat(32) }), null)
  assert.equal(expandRequest(short, null), null)
  // The library's own spelling is checked the same way.
  assert.equal(expandRequest(LIB, INFO), LIB)
  assert.equal(expandRequest(LIB, { ...INFO, operator: 'ef'.repeat(32) }), null)
})

test('every optional field travels: asset, value, channels; a request with anything else stays as it is', () => {
  const full = { ...REQ, asset: h('5', 32), value: '18446744073709551615', channels: { [h('6', 32)]: h('7', 32), [h('8', 32)]: h('9', 32) } }
  const s = compactRequest('arca:' + hexOf(JSON.stringify(full)))
  assert.deepEqual(libraryRequest(expandRequest(s, INFO)), full)
  const plain = { ...REQ }; delete plain.landing; delete plain.template
  assert.deepEqual(libraryRequest(expandRequest(compactRequest('arca:' + hexOf(JSON.stringify(plain))), INFO)), plain)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, something_new: 1 }))), null)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, until: undefined }))), null)
  assert.equal(compactRequest('arca:' + hexOf(JSON.stringify({ ...REQ, channels: { [h('6', 32)]: '12:0' } }))), null)
  // A short form cut or padded is not read.
  const d = bech32mDecode(compactRequest(LIB))
  assert.equal(readShortRequest(bech32mEncode('sqr', Array.from(d.bytes).slice(0, -1))), null)
  assert.equal(readShortRequest(bech32mEncode('sqr', [...d.bytes, 0])), null)
  assert.equal(readShortRequest(bech32mEncode('xyz', Array.from(d.bytes))), null)
})

test('the code is upper case wherever a QR code can hold it so; read back in lower case', () => {
  const code = buildPayCode({ address: TB1, ark: ARK, sequentia: LIB })
  const short = compactRequest(LIB)
  assert.equal(code, `BITCOIN:${TB1.toUpperCase()}?ark=${ARK.toUpperCase()}&sequentia=${short.toUpperCase()}`)
  const r = readPayCode(code)
  assert.equal(r.address, TB1); assert.equal(r.ark, ARK); assert.equal(r.sequentia, short)
  assert.deepEqual(libraryRequest(expandRequest(r.sequentia, INFO)), REQ)
  assert.deepEqual(r.other, {})
  // Everything outside the separators is QR alphanumeric (0-9 A-Z $%*+-./: and space).
  for (const part of code.split(/[?&=]/)) assert.match(part, /^[0-9A-Z $%*+\-./:a-z]*$/)
  assert.ok(code.length < 450, `code ${code.length} chars`)
})

test('a code made before the short form is still read and paid', () => {
  const old = `bitcoin:${TB1}?ark=${ARK}&sequentia=${LIB}`
  const r = readPayCode(old)
  assert.equal(r.address, TB1); assert.equal(r.ark, ARK); assert.equal(r.sequentia, LIB)
  assert.equal(expandRequest(r.sequentia, INFO), LIB)
})

test('an invoice is upper case in the code and lower case read back', () => {
  const inv = 'lntb20u1pjexample' // not a real invoice: kept as it is
  assert.match(buildPayCode({ address: TB1, lightning: inv }), /lightning=lntb20u1pjexample/)
  const real = bech32mEncode('lntb', [1, 2, 3]) // any checksummed bech32 part is upper-cased
  assert.match(buildPayCode({ address: TB1, lightning: real }), new RegExp('lightning=' + real.toUpperCase()))
  assert.equal(readPayCode(buildPayCode({ address: TB1, lightning: real })).lightning, real)
})

test('a plain address is a plain bitcoin: request', () => {
  assert.equal(buildPayCode({ address: TB1 }), 'BITCOIN:' + TB1.toUpperCase())
  assert.equal(readPayCode('bitcoin:' + TB1).address, TB1)
  assert.equal(readPayCode('BITCOIN:' + TB1.toUpperCase()).address, TB1)
  // A base58 address is never changed in case.
  assert.equal(buildPayCode({ address: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' }), 'BITCOIN:mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')
})

test('values that need it are escaped and read back whole', () => {
  const code = buildPayCode({ address: TB1, label: 'Ana & Bo', message: 'rent 50%', sequentia: 'x:y z' })
  assert.match(code, /label=Ana%20%26%20Bo/)
  assert.match(code, /message=rent%2050%25/)
  const r = readPayCode(code)
  assert.equal(r.label, 'Ana & Bo'); assert.equal(r.message, 'rent 50%'); assert.equal(r.sequentia, 'x:y z')
})

test('other parameters are kept; an unknown required one is refused', () => {
  const r = readPayCode(`bitcoin:${TB1}?pj=https://x.test/pj&amount=0.001`)
  assert.equal(r.amount, '0.001'); assert.deepEqual(r.other, { pj: 'https://x.test/pj' })
  assert.throws(() => readPayCode(`bitcoin:${TB1}?req-pj=https://x.test/pj`), /cannot do \(pj\)/)
  // A known one marked required is honoured.
  assert.equal(readPayCode(`bitcoin:${TB1}?req-ark=${ARK}`).ark, ARK)
})

test('what is not a request, or names nothing to pay, is not read', () => {
  assert.equal(readPayCode(TB1), null)
  assert.equal(readPayCode(LIB), null)
  assert.equal(readPayCode(''), null)
  assert.throws(() => readPayCode('bitcoin:?label=x'), /no way to pay/)
  assert.throws(() => readPayCode(`bitcoin:${TB1}?ark=a&ark=b`), /twice/)
  assert.throws(() => buildPayCode({ ark: ARK }), /address/)
})

test('an address-less request with an ark address is read (BIP321 allows an empty path)', () => {
  const r = readPayCode('bitcoin:?ark=' + ARK)
  assert.equal(r.address, null); assert.equal(r.ark, ARK)
})
