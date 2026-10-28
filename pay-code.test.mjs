// pay-code.js: the one receive code, written and read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayCode, readPayCode } from './pay-code.js'

const TB1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const ARK = 'tark1pnglpcr3zqqptxh5f9uabcdefgh'
// A Sequentia receive request: a word, a colon, hex.
const SEQ = 'sequentia:7b226b696e64223a2272657175657374227d'

test('written and read back, every part in its place', () => {
  const code = buildPayCode({ address: TB1, ark: ARK, sequentia: SEQ })
  assert.equal(code, `bitcoin:${TB1}?ark=${ARK}&sequentia=${SEQ}`)
  const r = readPayCode(code)
  assert.equal(r.address, TB1); assert.equal(r.ark, ARK); assert.equal(r.sequentia, SEQ)
  assert.deepEqual(r.other, {})
})

test('a plain address is a plain bitcoin: request', () => {
  assert.equal(buildPayCode({ address: TB1 }), 'bitcoin:' + TB1)
  assert.equal(readPayCode('bitcoin:' + TB1).address, TB1)
  assert.equal(readPayCode('BITCOIN:' + TB1.toUpperCase()).address, TB1.toUpperCase())
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
  assert.equal(readPayCode(SEQ), null)
  assert.equal(readPayCode(''), null)
  assert.throws(() => readPayCode('bitcoin:?label=x'), /no way to pay/)
  assert.throws(() => readPayCode(`bitcoin:${TB1}?ark=a&ark=b`), /twice/)
  assert.throws(() => buildPayCode({ ark: ARK }), /address/)
})

test('an address-less request with an ark address is read (BIP321 allows an empty path)', () => {
  const r = readPayCode('bitcoin:?ark=' + ARK)
  assert.equal(r.address, null); assert.equal(r.ark, ARK)
})
