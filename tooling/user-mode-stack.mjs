// The regtest stack the user-mode drive (user-mode-drive.mjs) and drill (user-mode-drill.mjs)
// run against: the operator repository's harness (bark-cli/tests/arca_operator_for_browsers.rs)
// at its control address, SeqDEX's relay (seqobd) following the operator's rounds, a live leaf
// maker (lsp/leaf-maker.mjs), and transparent covenant orders placed with this wallet's own
// covenant code. Node only; nothing here is used by the deployed wallet.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as seqob from '../seqob.js'
import { planPlaceOrder, postExisting } from '../covenant-order.js'
import { secp256k1, schnorr } from '../btc.js'

const here = dirname(fileURLToPath(import.meta.url))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const hex = (b) => Buffer.from(b).toString('hex')
const rev = (h) => h.match(/../g).reverse().join('')

// The harness's control address.
export function harness (control) {
  const c = async (path, body) => {
    const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
    return j
  }
  const rpc = (method, params = []) => c('/rpc', { method, params })
  return {
    c, rpc,
    state: () => c('/state'),
    fund: (script, asset, amount) => c('/fund', { script, asset, amount: Number(amount) }),
    produce: () => c('/produce'),
    bury: () => c('/bury'),
    build: () => c('/build'),
    pass: () => c('/pass'),
    restart: () => c('/restart'),
    orphan: (height) => c('/orphan', { height }),
    advance: (seconds) => c('/advance', { seconds }),
    // A script's hex, from an address the node's chain knows.
    scriptOf: async (address) => (await rpc('validateaddress', [address])).scriptPubKey,
    // One pass of the operator's clock: rounds built, forfeits awaited (a wallet hands them over
    // at its sync), the held rounds sent, a block, the anchor buried.
    pump: async () => { const b = await c('/build'); await c('/pass'); await c('/produce'); await c('/bury'); return b },
    outputValue: async (txid, vout) => {
      try { const t = await rpc('getrawtransaction', [txid, true]); const o = t.vout[vout]; if (!o) return null
        const spent = await rpc('gettxout', [txid, vout, true]); if (!spent) return null
        return String(Math.round(o.value * 1e8)) } catch { return null }
    },
  }
}

// SeqDEX's relay against the harness's node, following the operator's rounds.
export async function startRelay (bin, st, port) {
  const relay = spawn(bin, [`-listen=127.0.0.1:${port}`, `-node-rpc=${new URL(st.node_url).host}`, `-node-rpc-user=${st.node_user}`, `-node-rpc-pass=${st.node_password}`,
    '-watch-interval=1s', '-min-expiry=5s', `-arca-operator=${st.server}`, '-fill-anchor-depth=2'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const log = []
  relay.stderr.on('data', (d) => { log.push(String(d)); if (log.length > 4000) log.splice(0, 1000) })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/v1/markets')).status < 500) break } catch {} await sleep(300) }
  return { proc: relay, url, log }
}

// The relay's offers for a pair, both orientations, as the page reads them (checked, with the
// relay's own JSON kept for the leaf library).
export function relayBook (base) {
  return async (pay, receive) => {
    const get = async (b, q) => {
      const r = await fetch(`${base}/v1/market/${b}/${q}/orderbook`)
      if (!r.ok) return []
      const j = await r.json()
      // statuses[i] is the order status of offers[i]: what it can be filled for now.
      return (j.offers || []).map((o, i) => { const raw = JSON.parse(JSON.stringify(o)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _relayJson: raw, _status: (j.statuses || [])[i] || null } })
    }
    return [...await get(receive, pay), ...await get(pay, receive)]
  }
}

// A transparent covenant order selling `sell` atoms of `assetA` for `assetB` at rateNum/rateDen,
// funded from the harness's coins, buried, and listed on the relay.
export async function placeOrder (H, relayUrl, { assetA, assetB, sell, rateNum, rateDen, minLot, ttl = 7 * 86400 }) {
  seqob.setSeqobBase(relayUrl)
  const mpriv = randomBytes(32); const mx = hex(schnorr.getPublicKey(mpriv))
  const tip = await H.rpc('getblockchaininfo')
  const params = { assetA: rev(assetA), assetB: rev(assetB), sellAtoms: BigInt(sell), rateNum: BigInt(rateNum), rateDen: BigInt(rateDen), minLot: BigInt(minLot),
    expiryLocktime: tip.mediantime + 30 * 86400, makerProg: mx, makerX: mx }
  const plan = planPlaceOrder(params)
  const f = await H.fund(plan.spkHex, assetA, sell)
  const tx = await H.rpc('getrawtransaction', [f.txid, true])
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.hex === plan.spkHex)
  await H.produce(); await H.bury()
  const opriv = randomBytes(32)
  const posted = await postExisting({ ...params, txid: f.txid, vout, offerId: hex(randomBytes(16)), nowUnix: Math.floor(Date.now() / 1000), ttlSecs: ttl, makerPubkey: hex(secp256k1.getPublicKey(opriv, true)) },
    { fetchOutput: async (txid, n) => { const t = await H.rpc('getrawtransaction', [txid, true]); const o = t.vout[n]; return { scriptPubKey: o.scriptPubKey.hex, asset: o.asset, value: String(Math.round(o.value * 1e8)) } },
      postCovenantOffer: (offer) => seqob.postCovenantOffer(offer, opriv) })
  return { at: `${f.txid}:${vout}`, offer: posted.offer, posted: posted.posted }
}

// A live leaf maker in its own process and store, funded with `fund` ([asset, atoms]) on the
// chain, which it boards itself. -> { proc, url, address, stop() }
export async function startMaker (H, st, dir, { pairs, fund, port, lwk, settleSeconds = 30, syncSeconds = 3, ttl = 300, exitDelayUnits = 1, coinSize = null, btc = null }) {
  mkdirSync(dir, { recursive: true })
  const mnemonicFile = join(dir, 'mnemonic')
  writeFileSync(mnemonicFile, lwk.Mnemonic.fromRandom(12).toString(), { mode: 0o600 })
  // A store of its own each run: the library's store holds a few wallets only.
  const cfg = { wallet: 'leaf-maker-regtest', mnemonic_file: mnemonicFile, store_dir: join(dir, 'store-' + Date.now()), listen: `127.0.0.1:${port}`,
    operator: { server: st.server, node_url: st.node_url, node_user: st.node_user, node_password: st.node_password },
    ...(exitDelayUnits ? { exit_delay_units: exitDelayUnits, min_exit_delay_units: exitDelayUnits } : {}),
    pairs, fee_margin: '2000', sync_seconds: syncSeconds, settle_seconds: settleSeconds, offer_ttl_seconds: ttl, board_keep: '100000',
    ...(coinSize ? { coin_size: String(coinSize) } : {}), ...(btc ? { btc } : {}) }
  writeFileSync(join(dir, 'maker.json'), JSON.stringify(cfg, null, 2))
  return launchMaker(H, dir, port, fund)
}

export async function launchMaker (H, dir, port, fund) {
  const proc = spawn(process.execPath, [join(here, 'lsp', 'leaf-maker.mjs'), '--config', join(dir, 'maker.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  const address = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('the maker did not start: ' + log.join(''))), 60000)
    proc.stdout.on('data', (d) => { log.push(String(d)); const m = String(d).match(/on-chain address (\S+)/); if (m) { clearTimeout(t); ok(m[1]) } })
    proc.stderr.on('data', (d) => log.push(String(d)))
  })
  const url = `http://127.0.0.1:${port}`
  if (fund && fund.length) {
    const script = await H.scriptOf(address)
    for (const [a, v] of fund) await H.fund(script, a, v)
    await H.produce()
  }
  return { proc, url, address, log, dir, port, stop: () => new Promise((ok) => { if (proc.exitCode != null) return ok(); proc.once('exit', ok); proc.kill('SIGTERM') }) }
}

// The leaf maker's quotes, once it has boarded what it gives.
export async function makerReady (H, maker, give, ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    try { const q = await (await fetch(maker.url + '/v1/quotes')).json(); if ((q.quotes || []).some((x) => x.give_asset === give)) return q } catch {}
    if (Date.now() > end) throw new Error('the maker never quoted: ' + maker.log.slice(-5).join(''))
    await H.produce(); await H.bury(); await sleep(2000)
  }
}

// The wallet kit's lwk_wasm build, for drawing phrases: ../pkg, or LWK_PKG where a checkout has none.
export function lwkFrom (pkgDir = process.env.LWK_PKG || join(here, '..', 'pkg')) {
  return import(join(pkgDir, 'lwk_wasm.js')).then((m) => { m.initSync({ module: readFileSync(join(pkgDir, 'lwk_wasm_bg.wasm')) }); return m })
}
