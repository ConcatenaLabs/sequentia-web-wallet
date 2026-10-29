// Report a problem (problem-report.js): what leaves the wallet, and the words around it.
//   node --test problem-report.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { scrub, carriesPhrase, createErrorLog, buildReport, refusal, sendReport, sentWords, REPORT_WORDS, LIMITS } from './problem-report.js'
import { forbiddenIn } from './user-trade.js'

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

test('scrub removes addresses, keys, invoices and long hex', () => {
  const t = scrub('pay tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx failed; ' +
    'key cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy; ' +
    'xprv tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK; ' +
    'tx 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b; invoice lntb1u1pjxyz0pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq; ' +
    'blinded tsqb1qqgdh2u7x3l5w0e5c8m2ux2zftqlhlzt0j7xh4m7m8a6dnrcgzvsunpp5w9sxzxe')
  for (const leak of ['tb1qw508', 'cVt4o7', 'tprv8Z', '4a5e1e4b', 'lntb1u1', 'tsqb1qq']) assert.ok(!t.includes(leak), leak)
  assert.match(t, /pay \[address\] failed/)
  assert.equal(scrub('The trade could not be made. Nothing moved.'), 'The trade could not be made. Nothing moved.')
})

test('a description carrying three words of the phrase in order is refused', () => {
  assert.ok(carriesPhrase('my words are abandon ability able', PHRASE))
  assert.ok(carriesPhrase('Absorb, abstract; absurd!', PHRASE))
  assert.ok(!carriesPhrase('I was able to send, then the page froze', PHRASE))
  assert.ok(!carriesPhrase('abandon able ability', PHRASE), 'out of order')
  const r = buildReport({ wallet: 'web-wallet', version: 'x', mode: 'default', description: 'phrase: about above absent' })
  assert.equal(refusal(r, PHRASE), REPORT_WORDS.phrase)
  assert.equal(refusal(buildReport({ wallet: 'web-wallet', version: 'x', mode: 'default', description: '  ' }), PHRASE), REPORT_WORDS.needDescription)
  assert.equal(refusal(buildReport({ wallet: 'web-wallet', version: 'x', mode: 'default', description: 'The swap hung' }), PHRASE), null)
})

test('the error log keeps the last twenty, scrubbed, folding a repeat', () => {
  const log = createErrorLog()
  for (let i = 0; i < 25; i++) log.note('failed ' + i)
  log.note('failed 24')
  log.note(new Error('send to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx refused'))
  const l = log.list()
  assert.equal(l.length, LIMITS.errors)
  assert.equal(l[0].message, 'failed 6')
  assert.equal(l[l.length - 2].message, 'failed 24')
  assert.equal(l[l.length - 1].message, 'send to [address] refused')
})

test('the error log hears uncaught errors, rejections and console.error', () => {
  const handlers = {}
  const win = { addEventListener: (k, f) => { handlers[k] = f } }
  const seen = []
  const con = { error: (...a) => seen.push(a) }
  const log = createErrorLog()
  log.install(win, con)
  handlers.error({ error: new Error('boom') })
  handlers.unhandledrejection({ reason: new Error('nope') })
  con.error('fetch failed', { status: 502 })
  assert.deepEqual(log.list().map((e) => e.message), ['boom', 'nope', 'fetch failed {"status":502}'])
  assert.equal(seen.length, 1, 'console.error still prints')
})

test('the payload follows the intake contract and carries no address unless given', () => {
  const r = buildReport({ wallet: 'web-wallet', version: 'page of 2026-10-29', mode: 'user', description: ' x '.repeat(3000),
    accountCode: ' a1b2c3d4e5 ', errors: [{ at: '2026-10-29T12:00:00.000Z', message: 'bad tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }],
    context: { platform: 'Linux', user_agent: 'UA', network: 'testnet', empty: '' } })
  assert.deepEqual(Object.keys(r), ['v', 'wallet', 'version', 'mode', 'description', 'account_code', 'errors', 'context'])
  assert.equal(r.v, 1)
  assert.equal(r.mode, 'default')
  assert.equal(r.description.length, LIMITS.description)
  assert.equal(r.account_code, 'a1b2c3d4e5')
  assert.equal(r.errors[0].message, 'bad [address]')
  assert.deepEqual(r.context, { platform: 'Linux', user_agent: 'UA', network: 'testnet' })
  assert.ok(!('attached' in r))
  const withAddr = buildReport({ wallet: 'web-wallet', version: 'v', mode: 'developer', description: 'd', addresses: ['tb1qexample'] })
  assert.deepEqual(withAddr.attached, { addresses: ['tb1qexample'] })
  assert.equal(withAddr.mode, 'developer')
})

test('every answer of the intake is said in the wallet\'s words', async () => {
  const report = buildReport({ wallet: 'web-wallet', version: 'v', mode: 'default', description: 'd' })
  const answer = (status, body = {}) => async (url, init) => {
    assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), report)
    return { status, json: async () => body }
  }
  assert.deepEqual(await sendReport(report, { fetchImpl: answer(201, { id: 7, account: 'linked' }) }), { ok: true, id: 7, account: 'linked' })
  assert.deepEqual(await sendReport(report, { fetchImpl: answer(409) }), { ok: false, message: REPORT_WORDS.already })
  assert.deepEqual(await sendReport(report, { fetchImpl: answer(429) }), { ok: false, message: REPORT_WORDS.tooMany })
  assert.deepEqual(await sendReport(report, { fetchImpl: answer(413) }), { ok: false, message: REPORT_WORDS.tooLarge })
  assert.deepEqual(await sendReport(report, { fetchImpl: answer(500) }), { ok: false, message: REPORT_WORDS.failed })
  assert.deepEqual(await sendReport(report, { fetchImpl: async () => { throw new TypeError('Failed to fetch') } }), { ok: false, message: REPORT_WORDS.failed })
  assert.equal(sentWords({ id: 7, account: 'linked' }), 'Report sent. Its number is #7. Thank you. If it is accepted, it is credited to your Emissio account.')
  assert.equal(sentWords({ id: 8, account: 'unknown' }), 'Report sent. Its number is #8. Thank you. That account code was not found, so the report was sent without it.')
  assert.equal(sentWords({ account: 'none' }), 'Report sent. Thank you.')
})

test('the words carry no developer vocabulary', () => {
  const all = Object.values(REPORT_WORDS).map((w) => typeof w === 'function' ? w(1) : w)
  for (const w of all) assert.deepEqual(forbiddenIn(w), [], w)
  for (const w of all) assert.ok(!/[—–]/.test(w), 'no dashes: ' + w)
})
