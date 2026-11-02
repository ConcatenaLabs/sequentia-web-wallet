// What vests later (a vesting allocation): default-arca.js reads it from the leaf library's
// `claims`, says it under the figure, and refuses an action that needs it before its date.
//
//   node --test vesting.test.mjs
import assert from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_WORDS, vestingLots, vestingFor, vestingAtoms, vestingAssets, vestingShort, vestingRefusal, vestedOpen, vestedArriving, vestingLines, dateWords, CLAIMS_EVERY_MS } from './default-arca.js'
import { forbiddenIn, USER_WORDS, USER_MODE_FORBIDDEN_WORDS } from './user-trade.js'
import { plainRefusal, LeafError } from './leaves.js'

const A = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const B = 'e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13'
// 3 November 2026 00:00 and 12:00 UTC, 4 November 2026 00:00 UTC.
const NOV3 = 1793664000, NOV3_NOON = NOV3 + 43200, NOV4 = NOV3 + 86400
const claim = (o) => ({ distribution: 'dd'.repeat(32), index: 0, key: 'aa'.repeat(32), address: 'tb1q', named_as: 'address', asset: A, value: 100, state: 'vesting', leaf_id: 'll', deadline: NOV4 + 7 * 86400, expiry: null, held: null, vest: NOV3, vests: '3 November 2026', note: 'vests on 3 November 2026', ...o })

test('a date is written in words as the library writes it', () => {
  assert.equal(dateWords(NOV3), '3 November 2026')
  assert.equal(dateWords(NOV3_NOON), '3 November 2026')
  assert.equal(dateWords(NOV4), '4 November 2026')
  assert.equal(dateWords(1798761599), '31 December 2026')
  assert.equal(dateWords('nonsense'), '')
})

test('vesting claims are summed by asset and date, earliest first; nothing else counts', () => {
  const lots = vestingLots([
    claim({ value: 100 }),
    claim({ value: 50, vest: NOV3_NOON }),                  // the same day: one line
    claim({ value: 7, vest: NOV4, vests: undefined }),       // no words from the library: written here
    claim({ asset: B, value: 9, vest: NOV4, vests: '4 November 2026' }),
    claim({ state: 'claimed' }), claim({ state: 'pending' }), claim({ state: 'open', vest: null }),
    claim({ held: 'leaf' }), claim({ value: 0 }), claim({ vest: null }), null, 'x',
  ])
  assert.deepEqual(lots, [
    { asset: A, vest: NOV3, vests: '3 November 2026', atoms: '150' },
    { asset: A, vest: NOV4, vests: '4 November 2026', atoms: '7' },
    { asset: B, vest: NOV4, vests: '4 November 2026', atoms: '9' },
  ])
  assert.deepEqual(vestingFor(lots, B), [lots[2]])
  assert.equal(vestingAtoms(lots, A), 157n)
  assert.equal(vestingAtoms(lots, 'BTC'), 0n)
  assert.deepEqual(vestingAssets(lots), [A, B])
  assert.deepEqual(vestingLots(null), [])
  assert.deepEqual(vestingLots({ error: 'x' }), [])
  // It survives being kept as JSON (what the wallet shows while it opens or is offline).
  assert.deepEqual(JSON.parse(JSON.stringify(lots)), lots)
  assert.equal(CLAIMS_EVERY_MS, 120_000)
})

test('an amount that needs what has not vested is said with the date all of it can be used', () => {
  const lots = vestingLots([claim({ value: 100 }), claim({ value: 50, vest: NOV4, vests: '4 November 2026' })])
  assert.equal(vestingShort(lots, A, 30, 30), null, 'what can be spent now')
  assert.equal(vestingShort(lots, A, 10, 30), null)
  assert.deepEqual(vestingShort(lots, A, 130, 30), { atoms: 100n, vest: NOV3, vests: '3 November 2026' })
  assert.deepEqual(vestingShort(lots, A, 131, 30), { atoms: 101n, vest: NOV4, vests: '4 November 2026' }, 'needs both dates: the later')
  assert.deepEqual(vestingShort(lots, A, 180, 30), { atoms: 150n, vest: NOV4, vests: '4 November 2026' })
  assert.equal(vestingShort(lots, A, 181, 30), null, 'more than even all of it: plainly not enough')
  assert.deepEqual(vestingShort(lots, A, 1, 0), { atoms: 1n, vest: NOV3, vests: '3 November 2026' }, 'held only so')
  assert.deepEqual(vestingShort(lots, A, 1, -5), { atoms: 1n, vest: NOV3, vests: '3 November 2026' })
  assert.equal(vestingShort(lots, B, 1, 0), null, 'another asset vests nothing')
  assert.equal(vestingShort([], A, 1, 0), null)
})

test('the words: one line per date, the refusal, and none of the words default mode never says', () => {
  assert.equal(DEFAULT_WORDS.vests('100', 'ORNG', '3 November 2026'), '100 ORNG vests on 3 November 2026')
  assert.equal(DEFAULT_WORDS.vestsOn('3 November 2026'), 'Vests on 3 November 2026')
  assert.equal(DEFAULT_WORDS.notVested('100', 'ORNG', '3 November 2026'),
    '100 ORNG of this vests on 3 November 2026, and can be used from then. Nothing has moved.')
  assert.equal(USER_WORDS.notVested('5', 'ORNG', '4 November 2026'), '5 ORNG of this vests on 4 November 2026, and can be used from then. Nothing has moved.')
  for (const w of [DEFAULT_WORDS.vests('1', 'ORNG', '3 November 2026'), DEFAULT_WORDS.vestsOn('3 November 2026'),
    DEFAULT_WORDS.notVested('1', 'ORNG', '3 November 2026'), DEFAULT_WORDS.vestingRefused('3 November 2026')]) assert.deepEqual(forbiddenIn(w), [], w)
})

test('claim, distribution, lapse and locktime are words default mode never says', () => {
  for (const w of ['claim', 'distribution', 'lapse', 'locktime']) assert.ok(USER_MODE_FORBIDDEN_WORDS.includes(w), w)
  assert.deepEqual(forbiddenIn('Your claim from the distribution lapses at its locktime.'), ['claim', 'distribution', 'lapses', 'locktime'])
  assert.deepEqual(forbiddenIn('It lapsed.'), ['lapsed'])
})

test("the network's own refusal of a coin that has not vested is said with its date", () => {
  const e = new LeafError({ kind: 'refused', code: 'vesting', status: 409, message: 'leaf ab vests at median time 1793664000: nothing moves it before then' })
  assert.equal(vestingRefusal(e), 'Part of this vests on 3 November 2026, and can be used from then. Nothing has moved.')
  assert.equal(plainRefusal(e).message, 'Part of this vests on 3 November 2026, and can be used from then. Nothing has moved.')
  assert.deepEqual(forbiddenIn(vestingRefusal({ code: 'vesting', message: 'no time' })), [])
  assert.equal(vestingRefusal({ code: 'declined', message: 'vests at median time 1' }), null)
  assert.equal(vestingRefusal(null), null)
})

test('a claim whose date has passed and that is not taken up yet asks for care at once', () => {
  assert.equal(vestedOpen([claim({ state: 'open' })]), true)
  assert.equal(vestedOpen([claim({ state: 'open', held: 'leaf' })]), false)
  assert.equal(vestedOpen([claim({ state: 'open', vest: null })]), false)
  assert.equal(vestedOpen([claim({})]), false)
  assert.equal(vestedOpen(null), false)
})

test('a claim whose date has passed and that is not taken up yet stays in the figure, as arriving', () => {
  const lots = vestingLots([claim({ state: 'open', value: 40 }), claim({ state: 'open', value: 2, vest: NOV4, vests: '4 November 2026' }),
    claim({ value: 100, vest: NOV4, vests: '4 November 2026' }), claim({ state: 'open', value: 9, held: 'leaf' })])
  assert.deepEqual(lots, [
    { asset: A, vest: NOV3, vests: '3 November 2026', atoms: '42', arriving: true },
    { asset: A, vest: NOV4, vests: '4 November 2026', atoms: '100' },
  ])
  assert.equal(vestingAtoms(lots, A), 142n, 'all of it in the figure')
  assert.equal(vestedArriving(lots, A), 42n)
  assert.deepEqual(vestingLines(lots, A), [lots[1]], 'a line only for what is still to vest')
  assert.deepEqual(vestingShort(lots, A, 40, 0), { atoms: 40n, arriving: true }, 'ready in a moment')
  assert.deepEqual(vestingShort(lots, A, 42, 0), { atoms: 42n, arriving: true })
  assert.deepEqual(vestingShort(lots, A, 43, 0), { atoms: 43n, vest: NOV4, vests: '4 November 2026' })
  assert.equal(vestingShort(lots, A, 143, 0), null)
})
