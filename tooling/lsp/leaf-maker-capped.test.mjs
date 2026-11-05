// A maker takes in no asset the operator refreshes no more of now (its info shows as much of it in
// flight as its cap): a coin of it received out of round would stay out of round, count against the
// maker's instant budget the whole time, and past the budget hold every other pair back. It keeps
// giving that asset and trading every other pair.
//
//   node --test tooling/lsp/leaf-maker-capped.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { cappedAssets, withoutCapped, cappedRefusal } from './leaf-maker.mjs'

const S = 'c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40'
const U = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const G = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1'

test('an asset at or past its in-flight cap is capped; one under it, or with no cap, is not', () => {
  // The operator's /v1/info as the testnet served it on 2026-11-05: tSEQ over its cap.
  const info = { operator: 'ab', assets: [
    { asset: U, fundable: '12695321040121588' },
    { asset: S, fundable: '5144064452622', in_flight: '4440427943015152', in_flight_cap: '4395572007484306' },
    { asset: G, fundable: '3231217360371', in_flight: '10', in_flight_cap: '11' },
  ] }
  assert.deepEqual([...cappedAssets(info)], [S])
  assert.deepEqual([...cappedAssets({ server_info: info })], [S], 'the library\'s `info` answer reads the same')
  assert.ok(cappedAssets({ assets: [{ asset: G, in_flight: '11', in_flight_cap: '11' }] }).has(G), 'at the cap is capped')
  assert.equal(cappedAssets({ assets: [{ asset: G, in_flight: 'x', in_flight_cap: '11' }] }).size, 0, 'a figure it cannot read caps nothing')
  assert.equal(cappedAssets(null).size, 0)
  assert.equal(cappedAssets({}).size, 0)
})

test('quotes that want a capped asset are left out; quotes that give it stay', () => {
  const q = (give, want) => ({ give_asset: give, want_asset: want, rate_num: '1', rate_den: '1', min_give: '1', max_give: '100' })
  const quotes = [q(S, U), q(U, S), q(G, U), q('BTC', S), q(S, 'BTC')]
  const later = [{ give_asset: U, want_asset: S }, { give_asset: U, want_asset: G }]
  const out = withoutCapped(quotes, later, new Set([S]))
  assert.deepEqual(out.quotes.map((x) => x.give_asset + '>' + x.want_asset), [S + '>' + U, G + '>' + U, S + '>BTC'])
  assert.deepEqual(out.later, [{ give_asset: U, want_asset: G }], 'not named for after the next round either: the cap does not free then')
  assert.deepEqual(withoutCapped(quotes, later, new Set()), { quotes, later }, 'nothing capped: as they were')
})

test('the refusal names the asset and says why, and is not one a taker retries smaller', () => {
  const e = cappedRefusal('SEQ')
  assert.match(e, /takes no SEQ now/)
  assert.match(e, /out of round/)
  // user-trade.js halves and asks again on these; a capped asset is refused at any size.
  assert.doesNotMatch(e, /does not hold that much|after its next round/)
})
