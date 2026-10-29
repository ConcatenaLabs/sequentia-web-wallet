// The user composer takes a covenant order in the operator's round only for what the operator says
// its round can pay now (its server's `fundable` for the asset the person pays, which the round
// pays the order's maker from the operator's own coins): sized down to it, skipped when it covers
// no lot, and taken whole when the server says nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from './user-trade.js'

// A covenant order from the live relay: USDX for GOLD at 10453/40312500, a lot of 0.129 USDX.
const ORDER = {"offer_id": "40f6f691eb28d54bbdb259c5ea1cb004", "schema_version": 1, "pair": {"base_asset": "2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de", "quote_asset": "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1", "confidential": false}, "trade_dir": "TRADE_DIR_SELL", "base_amount": "12900000000", "offer_amount": "12900000000", "offer_asset": "2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de", "want_amount": "3344960", "want_asset": "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1", "allow_partial": true, "min_fill": "0", "created_at_unix": "1793211315", "expires_at_unix": "1793812515", "maker_pubkey": "032c2662dd2b05e030d66175ff5caa523858cd7a0c818ed1c688180c0eb91ae9b8", "fee_asset_hint": "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1", "min_anchor_depth": 0, "maker_ln_node_pubkey": "", "ln_connect_hints": [], "time_in_force": "TIME_IN_FORCE_UNSPECIFIED", "confidential": false, "covenant": {"covenant_txid": "a687199813d64ad2f4810a736b9d16b69de51c4033d7b2729da39a5f68da63f4", "covenant_vout": 1, "asset_a": "deb9044d8fa54b848820dd7d71150dc1c0ba65cd6e76a7ca606a5eda3955512a", "asset_b": "a171ccd2a7aa7bb82797145d25e1df951031c63ad9877f8d9fb59d2192910f3a", "rate_num": "10453", "rate_den": "40312500", "maker_prog": "Bh3AimkLt84D3Opw7x0fxSFEusvnOrssGRPFSXo8Qaw=", "maker_prog_ver": 1, "min_lot": "12900000", "expiry_locktime": 229390, "maker_x": "Bh3AimkLt84D3Opw7x0fxSFEusvnOrssGRPFSXo8Qaw=", "internal_key": "UJKbdMGgSVS3i0tgNel6XgeKWg8o7JbVR7/ums6AOsA=", "merkle_path": ["BwmQVbgZ+DphaIAp4eoDn5ovpOPZtJENPJkC+YPAk10="]}}
const USDX = ORDER.offer_asset, GOLD = ORDER.want_asset
const price = (r) => (BigInt(r) * 10453n + 40312500n - 1n) / 40312500n

function standIn (fundable) {
  const s = { takes: [] }
  const mem = new Map()
  s.store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  s.lib = {
    command (cmd, a) {
      switch (cmd) {
        case 'info': return { operator: 'ab'.repeat(32), server_info: { assets: [{ asset: GOLD, ...(fundable == null ? {} : { fundable: String(fundable) }) }, { asset: USDX, fundable: '0' }] } }
        case 'coins': return [{ leaf_id: 'c1', asset: GOLD, value: '5000000', state: 'live', expiry: 1800000000 }]
        case 'plans': return { plans: [] }
        case 'take_quote': {
          s.takes.push(a.amount)
          const p = price(a.amount)
          return { filled: a.amount, gives: String(p + 16n), spends: String(p + 16n), fee: '16' }
        }
        default: throw new Error('no command ' + cmd)
      }
    },
  }
  return s
}
const admitted = () => ({ pairs: { chains: { g: { pairs: [{ pay: GOLD, receive: USDX, sources: ['covenant-round'] }] } } }, genesis: 'g' })
const engineOf = (s) => createEngine({ leaves: s.lib, fetchJson: async () => ({}), makers: () => [], admitted, store: s.store,
  relayBook: async () => [{ ...ORDER, _verified: true, _status: { active_amount: ORDER.offer_amount } }] })

test('a server that says nothing of what it can fund: the order is taken whole', async () => {
  const s = standIn(null)
  const q = await engineOf(s).quote({ payAsset: GOLD, receiveAsset: USDX, amount: '3344976' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'covenant-round')
  assert.equal(s.takes[0], ORDER.offer_amount)
})

test('an operator that can pay part of it: the take is sized to what it can pay', async () => {
  const s = standIn(1000000)
  const q = await engineOf(s).quote({ payAsset: GOLD, receiveAsset: USDX, amount: '3344976' })
  assert.ok(q.ok, q.why)
  assert.equal(q.ticket.source, 'covenant-round')
  assert.ok(s.takes.length && s.takes.every((r) => price(r) <= 1000000n), JSON.stringify(s.takes))
  assert.ok(BigInt(q.ticket.amountOut) < BigInt(ORDER.offer_amount) && BigInt(q.ticket.amountOut) > 0n, q.ticket.amountOut)
})

test('an operator that cannot pay a lot (DA1: it could spend 1463 GOLD): the order is not offered', async () => {
  const s = standIn(1463)
  const q = await engineOf(s).quote({ payAsset: GOLD, receiveAsset: USDX, amount: '3344976' })
  assert.ok(!q.ok, 'no ticket')
  assert.deepEqual(s.takes, [], 'the library is never asked for the take')
})
