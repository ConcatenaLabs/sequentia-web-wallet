// The page's host for restricted-trade.js: the wallet's coins and keys, the asset's policy
// server, the chain's explorer and the relay's courier. It decides nothing about a trade; it
// reads, builds and signs what restricted-trade.js asks for.
//
// ctx: {
//   policyBase(url) -> the base URL to reach a policy server at (the page's same-origin proxy for
//                      its own policy server), or null when the page cannot reach it
//   aid()           -> the wallet's account id at the policy server
//   utxos()         -> the wallet's explicit coins on the chain: [{ txid, vout, asset, value,
//                      scriptPubkey, chain, index }]
//   keyOrigin()     -> { fingerprint, path: [u32], pubkey(chain, index) -> 33-byte hex }
//   sign(psetB64)   -> the finalized transaction's hex (the wallet library: Pset, addDetails,
//                      Signer.sign, Wollet.finalize)
//   enclaveSighash(txHex, input, prevouts, leaf, control) -> 32-byte hex (the wallet library's)
//   signDigest(hex32) -> a BIP340 signature by the wallet's enclave key (openampSignSighash)
//   receiveScript() -> the wallet's script for what a trade pays it
//   scriptOf(address) -> the script of an address
//   feeAtoms(asset, vbytes) -> the fee in that asset at the wallet's rate (throws when the
//                      network takes no fee in it)
//   esplora(path)   -> the parsed JSON of the chain explorer's answer, throwing on HTTP errors
//   courier(offer, amount) -> a courier session to the offer's maker (xcourier.js's
//                      openCourierSession): { send, recv, fail, close }
//   gatedScript(terms) -> the script a gated order's terms build, or null (optional)
//   fetchJson(url, init) -> parsed JSON, throwing an Error whose message is the server's
//   now()           -> seconds
// }

import { buildTx, psetOf, readTx } from './restricted-trade.js'
import { sha256 } from './btc.js'
import { bytesToHex, hexToBytes } from './seqob.js'

// The explorer's id of a script: its SHA-256, reversed.
export const scriptHash = (script) => bytesToHex(sha256(hexToBytes(script)).reverse())

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const key = (c) => `${c.txid}:${c.vout}`

export function makeRestrictedHost (ctx) {
  // Coins handed to a trade under way are not handed to another.
  const held = new Set()
  const policies = new Map()
  let only = null

  function policy (url) {
    const base = ctx.policyBase(url)
    if (!base) { const e = new Error('refused: the asset\'s policy server is not one this wallet reaches'); e.kind = 'refused'; throw e }
    if (policies.has(base)) return policies.get(base)
    const get = (p) => ctx.fetchJson(base + p)
    const post = (p, body) => ctx.fetchJson(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const enclaves = new Map()
    const p = {
      asset: (id) => get('/v1/assets/' + encodeURIComponent(id)),
      address: (aid, asset) => {
        const k = aid + '|' + asset
        if (!enclaves.has(k)) enclaves.set(k, get(`/v1/users/${encodeURIComponent(aid)}/address?asset=${encodeURIComponent(asset)}`).catch((e) => { enclaves.delete(k); throw e }))
        return enclaves.get(k)
      },
      enclaveScript: async (aid, asset) => String((await p.address(aid, asset)).script_pubkey).toLowerCase(),
      eligibility: ({ asset, aid, atoms, from }) => get(`/v1/eligibility?asset=${encodeURIComponent(asset)}&aid=${encodeURIComponent(aid)}` +
        (atoms ? `&atoms=${encodeURIComponent(String(atoms))}` : '') + (from ? `&from=${encodeURIComponent(from)}` : '')),
      balance: (aid, asset) => get(`/v1/users/${encodeURIComponent(aid)}/balance?asset=${encodeURIComponent(asset)}`),
      check: async (body) => { const r = await post('/v1/check', body); if (r && r.ok === false) { const e = new Error('refused: ' + (r.reason || r.error || 'the policy server refused the trade')); e.kind = 'refused'; throw e } return r },
      cosign: (body) => post('/v1/cosign', body),
    }
    policies.set(base, p)
    return p
  }

  async function coinAt ({ txid, vout }) {
    const tx = await ctx.esplora(`/tx/${txid}`)
    const o = tx && tx.vout && tx.vout[vout]
    if (!o || o.value == null || !o.asset) throw new Error(`${txid}:${vout} is not an explicit coin`)
    const sp = await ctx.esplora(`/tx/${txid}/outspend/${vout}`)
    if (sp && sp.spent) throw new Error(`${txid}:${vout} is spent`)
    return { txid, vout: Number(vout), asset: String(o.asset).toLowerCase(), value: big(o.value), script: String(o.scriptpubkey).toLowerCase() }
  }

  const host = {
    policy,
    aid: () => ctx.aid(),
    // At the policy server `url` (null: the page's own).
    async enclave (asset, url = null) {
      const a = await policy(url).address(ctx.aid(), asset)
      return { script: String(a.script_pubkey).toLowerCase(), leaf: a.transfer_leaf, control: a.transfer_control }
    },
    // The coins at the wallet's enclave, from the chain (the policy server counts them only).
    async enclaveCoins (asset, url = null) {
      const e = await host.enclave(asset, url)
      const us = (await ctx.esplora(`/scripthash/${scriptHash(e.script)}/utxo`)) || []
      const out = []
      for (const u of us) { const o = { txid: u.txid, vout: Number(u.vout) }; if (held.has(key(o))) continue; try { const c = await coinAt(o); if (c.asset === asset) out.push(c) } catch {} }
      return out
    },
    // The trade pays the asset of these outpoints from them alone (a composed purchase's second
    // step: what its move put on the chain), never from another coin of that asset.
    // `ops`: [{ txid, vout, asset }].
    onlyFrom (ops) { only = (ops || []).length ? { asset: ops[0].asset, keys: new Set(ops.map(key)) } : null },
    async walletCoins (asset, atoms) {
      const want = big(atoms)
      const pinned = only && only.asset === asset ? only.keys : null
      const cs = (await ctx.utxos()).filter((u) => u.asset === asset && !held.has(key(u)) && (!pinned || pinned.has(key(u))))
        .sort((a, b) => (big(b.value) > big(a.value) ? 1 : -1))
      const pick = []; let sum = 0n
      for (const c of cs) { if (sum >= want) break; pick.push(c); sum += big(c.value) }
      if (sum < want) { const e = new Error('refused: not enough on hand to pay'); e.kind = 'refused'; e.short = { asset, atoms: String(want - sum) }; throw e }
      for (const c of pick) held.add(key(c))
      return pick.map((c) => ({ txid: c.txid, vout: c.vout, asset: c.asset, value: big(c.value), script: String(c.scriptPubkey).toLowerCase(), chain: c.chain, index: c.index }))
    },
    async walletOwns () { return new Set((await ctx.utxos()).map(key)) },
    async coinsAt (ops) { const out = []; for (const o of ops) out.push(await coinAt(o)); return out },
    newScript: async () => ctx.receiveScript(),
    scriptOf: async (address) => ctx.scriptOf(address),
    feeAtoms: async (asset, vbytes) => big(ctx.feeAtoms(asset, vbytes)),
    build: async (inputs, outputs) => buildTx(inputs, outputs),
    // The wallet's own inputs, each with its key's origin, signed by the wallet library.
    async signWallet (hex, coins) {
      const ko = ctx.keyOrigin()
      const mine = new Map((await ctx.utxos()).map((u) => [key(u), u]))
      const der = coins.map((c) => {
        const u = mine.get(key(c))
        return u ? { pubkey: ko.pubkey(u.chain, u.index), fingerprint: ko.fingerprint, path: [...ko.path, u.chain, u.index] } : null
      })
      return ctx.sign(psetOf(hex, coins, der))
    },
    async signEnclave (hex, coins, ins, enclave) {
      const prevouts = coins.map((c) => ({ asset: c.asset, value: Number(c.value), script: c.script }))
      const sigs = {}
      for (const i of ins) sigs[String(i)] = ctx.signDigest(ctx.enclaveSighash(hex, i, prevouts, enclave.leaf, enclave.control))
      return sigs
    },
    signDigest: async (d) => ctx.signDigest(d),
    courier: async (entry) => ctx.courier(entry.raw, big(entry.raw.base_amount || entry.raw.baseAmount)),
    gatedScript: ctx.gatedScript ? async (terms) => ctx.gatedScript(terms) : null,
    now: () => ctx.now(),
    // The chain tip's median time, from the explorer's latest blocks (its block time where the
    // explorer gives no median).
    async chainTime () {
      const bs = await ctx.esplora('/blocks')
      const b = Array.isArray(bs) ? bs[0] : null
      return b ? Number(b.mediantime ?? b.timestamp) || 0 : 0
    },
    // The coins a trade held, given back when it ends without spending them.
    release (coins) { for (const c of coins || []) held.delete(key(c)) },
    releaseAll () { held.clear(); only = null },
    // A transaction's state on the chain: 'confirmed' once in a block, 'pending' while the
    // explorer holds it unconfirmed, 'unknown' otherwise.
    async status (txid) {
      try { const s = await ctx.esplora(`/tx/${txid}/status`); return s && s.confirmed ? 'confirmed' : 'pending' } catch { return 'unknown' }
    },
    readTx,
  }
  return host
}
