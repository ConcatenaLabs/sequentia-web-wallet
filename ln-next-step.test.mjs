// Lightning dead ends: with nothing (or too little) of an asset on Lightning, paying an invoice says
// so at once with the step that fixes it, instead of bringing the node online and failing ten
// seconds later with "no route"; and the Receive card says what to do and offers the step (Move to
// Lightning, or Add room to receive) in every mode, instead of only "you cannot".
//   node --test ln-next-step.test.mjs
import assert from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { decodeBolt11 } from './bolt11.js'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fn = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i > 0, name); return html.slice(i, html.indexOf('\n}', i) + 2) }

const USDX = 'aa'.repeat(32), GOLD = 'bb'.repeat(32)
function world ({ status, onchain = {}, btc = 0n, rates = { [USDX]: 1 }, spend = {}, opening = {}, onLn = {} }) {
  const calls = []
  const env = {
    seqlnState: () => ({ deployed: true }), lnLastStatus: status, btcBalance: btc,
    feeRateEntry: (h) => (rates[h] ? { rate: rates[h] } : null),
    balObj: () => Object.fromEntries(Object.entries(onchain).map(([k, v]) => [k, String(v)])),
    lnOnLightning: (h) => !!onLn[h], lnOpeningFor: (h) => !!opening[h],
    lnSpendableFor: (h) => ({ units: spend[h] || 0 }),
    lnLegFor: (h) => ({ asset: h }),
    moveToLightningDialog: (leg) => calls.push(['move', leg.asset ?? leg.kind]),
    lnReceiveRoomDialog: (leg) => calls.push(['room', leg.asset]),
    assetMeta: (h) => ({ ticker: h === USDX ? 'USDX' : h === GOLD ? 'GOLD' : 'BTC', precision: h === GOLD ? 0 : 8 }),
    fmtAtoms: (a, p) => (Number(a) / 10 ** p).toString(), decodeBolt11,
  }
  const names = Object.keys(env)
  const make = new Function(...names, [fn('lnStepFor'), fn('lnPayShortfall'), fn('lnRecvAdvice')].join('\n') +
    '; return { lnStepFor, lnPayShortfall, lnRecvAdvice };')
  return { ...make(...names.map((n) => env[n])), calls }
}
const STATUS = { channels: [], funding: { btc: true } }

test('paying from an asset with nothing on Lightning offers Move to Lightning at once', () => {
  const w = world({ status: STATUS, onchain: { [USDX]: 500n * 10n ** 8n } })
  const r = w.lnPayShortfall(USDX, 'not-an-invoice')
  assert.equal(r.text, 'You have no USDX on Lightning to pay this from. Move some USDX to Lightning first; it takes about two minutes.')
  assert.equal(r.step.label, 'Move to Lightning'); r.step.go(); assert.deepEqual(w.calls, [['move', USDX]])
})

test('BTC with none anywhere: the sentence, no button; with BTC on-chain: Move to Lightning', () => {
  let r = world({ status: STATUS }).lnPayShortfall('BTC', 'x')
  assert.equal(r.text, 'You have no BTC on Lightning to pay this from.'); assert.equal(r.step, null)
  const w = world({ status: STATUS, btc: 50000n })
  r = w.lnPayShortfall('BTC', 'x'); assert.equal(r.step.label, 'Move to Lightning'); r.step.go(); assert.deepEqual(w.calls, [['move', 'BTC']])
})

test('enough on Lightning pays; too little says how much; opening says when; unknown status refuses nothing', () => {
  // A real Sequentia invoice for 3 USDX would be decoded; an undecodable one checks only that something is there.
  assert.equal(world({ status: STATUS, spend: { [USDX]: 1000 } }).lnPayShortfall(USDX, 'x'), null)
  assert.equal(world({ status: null }).lnPayShortfall(USDX, 'x'), null)
  assert.match(world({ status: STATUS, opening: { [USDX]: true } }).lnPayShortfall(USDX, 'x').text, /ready to pay in about a minute/)
  const src = fn('lnPayShortfall')
  assert.match(src, /'You can pay up to '\+fmtAtoms\(can, prec\)\+' '\+t\+' over Lightning now; this invoice asks for '/)
})

test('receiving: Move to Lightning when not on Lightning, Add room when it is, on-chain otherwise', () => {
  let w = world({ status: STATUS, onchain: { [USDX]: 10n } })
  let a = w.lnRecvAdvice(USDX)
  assert.match(a.text, /^To receive USDX over Lightning, move some USDX to Lightning first/); assert.equal(a.step.label, 'Move to Lightning')
  w = world({ status: STATUS, onLn: { [USDX]: true } })
  a = w.lnRecvAdvice(USDX); assert.equal(a.step.label, 'Add room to receive'); a.step.go(); assert.deepEqual(w.calls, [['room', USDX]])
  a = world({ status: STATUS, onchain: { [GOLD]: 5n } }).lnRecvAdvice(GOLD)   // not priced for fees: nothing to move
  assert.equal(a.text, 'You cannot receive GOLD over Lightning now. Receive it on-chain with your address above.'); assert.equal(a.step, null)
  assert.equal(world({ status: STATUS }).lnStepFor('BTC', { receive: true }), null, 'a service that sells no room in BTC: no step')
  // A service that sells it: Add room to receive, with no BTC channel of the wallet's own first.
  w = world({ status: { channels: [], funding: { btc: true, btc_room: true } } })
  a = w.lnRecvAdvice('BTC'); assert.equal(a.step.label, 'Add room to receive'); a.step.go(); assert.deepEqual(w.calls, [['room', 'BTC']])
  assert.equal(a.text, 'To receive BTC over Lightning, add room to receive first; it is ready in about a block.')
})

test('the cards use them, in every mode', () => {
  const room = fn('lnPaintRecvRoom')
  assert.ok(!/devMode\(\)/.test(room), 'the Receive card no longer differs by mode')
  assert.match(room, /lnSayStep\(box, a\.text, a\.step\)/)
  const i = html.indexOf('if (sendBtn) sendBtn.onclick'); const send = html.slice(i, html.indexOf('\n  };', i))
  assert.ok(send.indexOf('lnPayShortfall(asset, bolt11)') < send.indexOf('lnConnectLeg('), 'checked before the node is brought online')
  assert.match(send, /No Lightning route to the person you are paying had room for this amount/)
  assert.ok(!/different offer/.test(send))
})
