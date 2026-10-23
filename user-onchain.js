// The user composer's on-chain wallet, for transparent covenant orders taken on the chain
// ('onchain-fill'): the page's own coins pay the order in one FILL transaction, with no operator
// and no leaves. This is the engine's `deps.onchain` (user-trade.js); covenant-order.js plans and
// checks the FILL against the coin on the chain, covenant-fill-host.js selects the coins, signs and
// broadcasts.
//
// ctx: { wasm, wollet(), network(), mnemonic(), esploraFetch(path), noteOwnTx, receiveAddress(),
//        balance(asset) -> atoms the page can spend on the chain now,
//        feeRateFor(asset) -> the asset's fee rate (throws when the node takes no fee in it),
//        feerate -> the reference fee rate in sat/kvB, rateScale -> the rates' scale }
import { makeCovenantHooks } from './covenant-fill-host.js'
import { settleFill } from './covenant-order.js'

// What one FILL weighs, for its fee: the same estimate the developer composer's take uses.
export const EST_FILL_VSIZE = 1500n

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const display = (h) => String(h || '').toLowerCase().match(/../g).reverse().join('')

// What a failed broadcast means: the FILL is out when the node already holds it ({ txid }); the
// node's refusal of it is a refusal, nothing moved ({ error } of kind 'refused'); anything else
// (the esplora not answering) leaves it unknown ({ error } as it came).
export function broadcastAnswer (e, txid) {
  const m = String((e && e.message) || e)
  if (txid && /already in (the )?mempool|txn-already-known|txn-already-in-mempool|already known/i.test(m)) return { txid }
  if (/^broadcast failed:/.test(m)) { const x = new Error('refused: the node took no FILL: ' + m.slice('broadcast failed:'.length).trim()); x.kind = 'refused'; return { error: x } }
  return { error: e }
}

export function makeUserOnchain (ctx) {
  // One FILL's network fee, in the asset paid for the order: the covenant-fill host pays the fee
  // in that asset, and the order's own asset never. An asset the node takes no fee in cannot pay
  // a FILL, and the order is not offered that way.
  function fee (payAsset) {
    const rate = big(ctx.feeRateFor(payAsset))
    if (rate <= 0n) throw new Error('no fee rate for the asset paid')
    const reference = (big(ctx.feerate) * EST_FILL_VSIZE) / 1000n
    return { asset: payAsset, atoms: ceilDiv(reference * big(ctx.rateScale), rate) }
  }

  // The FILL at the fee the ticket showed (`shown`), never another.
  async function take (matched, { fee: shown, onTxid } = {}) {
    const ct = matched.covenant || matched.Covenant || {}
    const pay = display(ct.asset_b || ct.assetB)
    const f = shown && shown.asset === pay ? { asset: pay, atoms: big(shown.atoms) } : fee(pay)
    const hooks = makeCovenantHooks({
      wasm: ctx.wasm, wollet: ctx.wollet(), network: ctx.network(), mnemonic: ctx.mnemonic(),
      esploraFetch: ctx.esploraFetch, noteOwnTx: ctx.noteOwnTx, receiveAddress: ctx.receiveAddress,
      fee: { asset: f.asset, atoms: f.atoms },
    })
    // The FILL's txid is recorded before it is broadcast, so a broadcast that does not answer is
    // looked for on the chain rather than taken for failed.
    const build = hooks.buildCovenantFillTx
    let txid = null
    hooks.buildCovenantFillTx = async (recipe) => {
      const built = await build(recipe)
      if (built && built.txid) { txid = String(built.txid); if (onTxid) { try { onTxid(txid) } catch {} } }
      return built
    }
    // A FILL the node refuses moved nothing: the trade is a refusal, not a step that did not
    // answer (an order another taker filled first is the usual one). A FILL the node already
    // holds was broadcast.
    const broadcast = hooks.broadcast
    hooks.broadcast = async (rawHex) => {
      try { return await broadcast(rawHex) } catch (e) {
        const v = broadcastAnswer(e, txid)
        if (v.txid) return v.txid
        throw v.error
      }
    }
    const r = await settleFill(matched, hooks)
    return { txid: r.txid }
  }

  // Where a FILL stands: final once it is in a block (a block of this chain is final as soon as it
  // is certified; only a Bitcoin reorganisation undoes it), pending in the mempool, unknown when the
  // node has not heard of it.
  async function status (txid) {
    let res
    try { res = await ctx.esploraFetch(`/tx/${txid}/status`) } catch { return 'unknown' }
    if (!res || !res.ok) return 'unknown'
    const s = await res.json().catch(() => null)
    if (!s) return 'unknown'
    return s.confirmed ? 'final' : 'pending'
  }

  return { balance: (asset) => ctx.balance(asset), fee, take, status }
}
