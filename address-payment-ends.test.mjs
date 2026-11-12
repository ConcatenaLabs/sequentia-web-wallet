// A payment to an address out of the tree is "Sent" only once the leaf library says it is made, and
// one that ended without being made is said so, once (web wallet #604); a payment whose coins are
// still arriving is refused as arriving, with when, never as "Not enough" (web wallet #607).
//   node --test address-payment-ends.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DEFAULT_WORDS, offboardStage, offboardEnds, offboardNewsText, offboardOutcome, shortAddress, addressRoute } from './default-arca.js'
import { noteSent, addressPayments, setStages, untoldEnds, markTold, pendingOut, instantLog } from './instant-history.js'
import { USER_MODE_FORBIDDEN_WORDS } from './user-trade.js'

const A = '4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f'
const ADDR = 'tb1q68apqvgwpsnewuwvtjy2xra4g3phq23quqzedu'
const ID = 'c21516a41cd39b103984ca3403ca8fe14bc430ea1ce72ccc0828b9df4e4e2934'
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }

test('only unlocking and paid are made; waiting and in_round are not, nor anything unknown', () => {
  assert.equal(offboardStage('waiting'), 'pending')
  assert.equal(offboardStage('in_round'), 'pending')
  assert.equal(offboardStage('unlocking'), 'made')
  assert.equal(offboardStage('paid'), 'made')
  assert.equal(offboardStage('not_made'), 'not_made')
  assert.equal(offboardStage('reclaimed'), 'reclaimed')
  assert.equal(offboardStage(undefined), 'pending')
  assert.equal(offboardStage('something new'), 'pending')
})

test('the answer to Send is "Sending", never "Sent", until the payment is made', () => {
  const o = offboardOutcome({ offboard: ID, state: 'pending', round_within_seconds: 60 }, '1', 'OILX', 10, 60)
  assert.doesNotMatch(o.text, /^Sent/)
  assert.equal(o.text, 'Sending 1 OILX. Keep this page open until it is sent.')
  assert.equal(DEFAULT_WORDS.sentLater('1', 'OILX', o.minutes), 'Sent 1 OILX. It arrives within 15 minutes.')
})

test('the live case: a payment whose page closed 7 s after Send ends not made, and is said once', () => {
  const s = mem()
  noteSent(s, 'w', { asset: A, atoms: 100000000n, later: true, offboard: ID, address: ADDR }, 1000)
  assert.equal(addressPayments(s, 'w').length, 1)
  assert.equal(addressPayments(s, 'w')[0].stage, 'pending')
  // Asked, then waiting: nothing to say.
  let r = offboardEnds(addressPayments(s, 'w'), [{ offboard: ID, state: 'waiting', address: ADDR, asset: A, amount: '100000000' }])
  assert.equal(r.stages.get(ID), 'pending'); assert.deepEqual(r.news, [])
  setStages(s, 'w', r.stages)
  assert.deepEqual(untoldEnds(s, 'w'), [])
  // The library's answer read on the testnet for that payment (RX1 p3).
  const live = JSON.parse('[{"address":"tb1q68apqvgwpsnewuwvtjy2xra4g3phq23quqzedu","amount":"100000000","asset":"4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f","offboard":"c21516a41cd39b103984ca3403ca8fe14bc430ea1ce72ccc0828b9df4e4e2934","script":"0014d1fa10310e0c279771cc5c88a30fb54443702a20","state":"not_made"}]')
  r = offboardEnds(addressPayments(s, 'w'), live)
  assert.equal(r.stages.get(ID), 'not_made')
  assert.equal(r.news.length, 1)
  assert.equal(setStages(s, 'w', r.stages), true)
  const ends = untoldEnds(s, 'w')
  assert.equal(ends.length, 1)
  assert.equal(offboardNewsText({ address: ends[0].address, stage: ends[0].stage }, '1', 'OILX'),
    'Your payment of 1 OILX to tb1q68apqvgwps…zedu was not made: nothing left your wallet. Send it again.')
  // Read again: never news twice, and gone from Balance once OK is pressed.
  r = offboardEnds(addressPayments(s, 'w'), live)
  assert.deepEqual(r.news, [])
  assert.equal(markTold(s, 'w', ID), true)
  assert.deepEqual(untoldEnds(s, 'w'), [])
  assert.equal(instantLog(s, 'w')[0].stage, 'not_made')
})

test('made stays made, and a payment that was made is never said to be unmade by a lagging read', () => {
  const s = mem()
  noteSent(s, 'w', { asset: A, atoms: 5n, later: true, offboard: ID, address: ADDR }, 1000)
  let r = offboardEnds(addressPayments(s, 'w'), [{ offboard: ID, state: 'unlocking' }])
  assert.equal(r.stages.get(ID), 'made'); setStages(s, 'w', r.stages)
  r = offboardEnds(addressPayments(s, 'w'), [{ offboard: ID, state: 'in_round' }])
  assert.equal(r.stages.get(ID), 'made')
  r = offboardEnds(addressPayments(s, 'w'), [])
  assert.equal(r.stages.get(ID), 'made')
  assert.deepEqual(untoldEnds(s, 'w'), [])
})

test('a payment taken back after it was made says it did not arrive', () => {
  const s = mem()
  noteSent(s, 'w', { asset: A, atoms: 5n, later: true, offboard: ID, address: ADDR }, 1000)
  const r = offboardEnds(addressPayments(s, 'w'), [{ offboard: ID, state: 'reclaimed', address: ADDR }])
  assert.equal(r.news[0].stage, 'reclaimed'); setStages(s, 'w', r.stages)
  assert.match(offboardNewsText(untoldEnds(s, 'w')[0], '5', 'GOLD'), /did not arrive\. Report a problem/)
})

test('a payment written down before ids were kept is left as it was', () => {
  const s = mem()
  noteSent(s, 'w', { asset: A, atoms: 5n, later: true }, 1000)
  assert.deepEqual(addressPayments(s, 'w'), [])
  assert.equal(instantLog(s, 'w')[0].stage, undefined)
})

test('what is still arriving pays an address later, and is said so with when (#607)', () => {
  // The live case: 5,001 OILX held in one coin given up to the payment before, nothing on the chain.
  assert.equal(addressRoute(100000000n, 0n, 0n, 0n, 500000000000n), 'arriving')
  // Only what comes back counts: nothing arriving is still not enough.
  assert.equal(addressRoute(100000000n, 0n, 0n, 0n, 0n), null)
  assert.equal(addressRoute(100000000n, 0n, 50000000n, 0n, 10000000n), null)
  // What can be spent now still pays first.
  assert.equal(addressRoute(5n, 0n, 5n, 0n, 100n), 'tree')
  assert.equal(addressRoute(5n, 10n, 0n, 0n, 100n), 'chain')
  assert.equal(DEFAULT_WORDS.stillArrivingWithin('OILX', 10), 'Part of this OILX is still arriving: it can be sent within 10 minutes.')
  assert.equal(DEFAULT_WORDS.stillArrivingWithin('OILX', null), 'Part of this OILX is still arriving: try again in a moment.')
  // What a payment still on its way gives up comes back only as its change.
  const s = mem()
  noteSent(s, 'w', { asset: A, atoms: 100000000n, fee: { asset: A, atoms: 3000n }, later: true, offboard: ID, address: ADDR }, 1000)
  assert.equal(pendingOut(s, 'w', A), 100003000n)
  setStages(s, 'w', new Map([[ID, 'made']]))
  assert.equal(pendingOut(s, 'w', A), 0n)
})

test('every new sentence is plain', () => {
  const said = [DEFAULT_WORDS.sendingLater('1', 'OILX'), DEFAULT_WORDS.sentLater('1', 'OILX', 10), DEFAULT_WORDS.notMade('1', 'OILX', 'tb1q…'),
    DEFAULT_WORDS.notArrived('1', 'OILX', 'tb1q…'), DEFAULT_WORDS.rowNotMade, DEFAULT_WORDS.rowNotMadeSub, DEFAULT_WORDS.rowNotArrived,
    DEFAULT_WORDS.newsOk, DEFAULT_WORDS.stillArrivingWithin('OILX', 10)].join(' ')
  for (const w of USER_MODE_FORBIDDEN_WORDS) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(said), w)
  assert.equal(shortAddress(ADDR), 'tb1q68apqvgwps…zedu')
})

test('the page says "Sent" for a payment to an address only from the stage the library gives it', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  const i = html.indexOf('async function offboardReview(')
  const body = html.slice(i, html.indexOf('\nasync function ', i + 10))
  // "Sent" only on 'made', and the record keeps the library's id and the address.
  assert.match(body, /if\(stage==='made'\)\{ st\.className='status ok'; st\.textContent = DEFAULT_WORDS\.sentLater\(/)
  assert.equal((body.match(/DEFAULT_WORDS\.sentLater\(/g) || []).length, 1)
  assert.match(body, /later: true, offboard: id, address/)
  // An unmade end is followed while the page is open, and told on Balance.
  assert.match(html, /setInterval\(\(\)=>\{ followAddressPayments\(\)\.catch/)
  assert.match(html, /try\{ renderNewsCard\(list\); \}catch/)
  // And #607: the arriving route never refuses for want of what is still arriving.
  // Coins still arriving are settled first and the payment goes (send-arriving.test.mjs); a library
  // that answers that plainly gets when it can go, never "can't be sent".
  assert.match(html, /if\(route !== 'tree' && !\(route === 'arriving' && !devMode\(\)\)\) continue;/)
  assert.match(html, /throw new Error\(DEFAULT_WORDS\.stillArrivingWithin\(m0\.ticker, arrivalMinutes\(/)
})
