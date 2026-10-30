// The BTC desk pays before the asset it received is final only within its owner's caps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mayPayUnfinal } from './leaf-maker-btc.mjs'

test('a BTC purchase is paid before the asset is final only within both caps, never by default', () => {
  const now = 1_800_000_000_000
  const caps = { unfinal_max_sats: '50000', unfinal_total_sats: '500000', unfinal_window_seconds: 7200 }
  const s = { give: '12749' }
  assert.equal(mayPayUnfinal({}, [], s, now), false, 'off unless the desk is configured')
  assert.equal(mayPayUnfinal(caps, [], s, now), true)
  assert.equal(mayPayUnfinal(caps, [], { give: '50001' }, now), false, 'above the per-swap cap')
  const paid = (give, ago) => ({ give: String(give), unfinal: true, unfinal_at: now - ago * 1000, state: 'done' })
  assert.equal(mayPayUnfinal(caps, [paid(490000, 60)], s, now), false, 'above the total with what is out')
  assert.equal(mayPayUnfinal(caps, [paid(480000, 60)], s, now), true)
  assert.equal(mayPayUnfinal(caps, [paid(490000, 7201)], s, now), true, 'a payment past the window no longer counts')
  assert.equal(mayPayUnfinal(caps, [{ ...paid(490000, 60), state: 'void' }], s, now), true, 'nor one voided')
})
