// The on-chain coins of a drill wallet (user-mode-wallet.mjs), in Node: the wallet kit (lwk_wasm)
// from the wallet's own phrase over the stack's esplora, as the page holds them (index.html's
// buildWollet), handed to user-onchain.js, the same code the page gives the engine for
// 'onchain-fill'.
//
// nodeOnchain({ lwk, mnemonic, esplora, policyAsset, genesis, feeRates }) ->
//   { balance, fee, take, status } (user-onchain.js) plus { sync(), address(), balances(), pending() }
//   lwk         the wallet kit's module, initialised (lwkFrom)
//   esplora     the stack's esplora base URL (esplora-shim.mjs)
//   feeRates()  -> the node's fee exchange rates ({ hex: rate }), as /feerates serves them
import { makeUserOnchain } from '../user-onchain.js'

export async function nodeOnchain ({ lwk, mnemonic, esplora, policyAsset, genesis, feeRates }) {
  const network = lwk.Network.regtestWithGenesis(new lwk.AssetId(policyAsset), genesis)
  const signer = new lwk.Signer(new lwk.Mnemonic(mnemonic), network)
  const wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, esplora, false, 4, false)
  const base = esplora.replace(/\/$/, '')
  let rates = {}
  // A scan of the wallet's coins, and the node's fee rates with it.
  async function sync () {
    const u = await client.fullScan(wollet)
    if (u) wollet.applyUpdate(u)
    try { rates = (await feeRates()) || rates } catch {}
  }
  const address = () => { const a = wollet.address(undefined).address(); return (a.toUnconfidential ? a.toUnconfidential() : a).toString() }
  const balances = () => { try { return wollet.balance().toJSON() } catch { return {} } }
  const oc = makeUserOnchain({
    wasm: lwk, wollet: () => wollet, network: () => network, mnemonic: () => mnemonic,
    esploraFetch: (path, opts) => fetch(base + path, opts), noteOwnTx: () => {},
    receiveAddress: address,
    balance: (a) => { try { return BigInt(balances()[a] || 0) } catch { return 0n } },
    feeRateFor: (a) => { const r = Number(rates[a]); if (!(r > 0)) throw new Error('no fee rate for the asset'); return BigInt(r) },
    feerate: 2000, rateScale: 100000000,
  })
  // How many of the wallet's transactions are not yet in a block: its balance is read for a
  // trade's check only when none is.
  const pending = () => { try { return wollet.transactions().filter((t) => t.height() == null).length } catch { return 0 } }
  // No scan here: the wallet scans before each quote and each balance it reads, and a scan at
  // start, slow on a loaded machine, would keep the process from answering in time.
  return { ...oc, sync, address, balances, pending }
}
