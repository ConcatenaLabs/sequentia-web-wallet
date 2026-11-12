#!/usr/bin/env node
// A resting order's note (order-note.js) on a private regtest chain, with the page's own swap.js, the
// wallet library (pkg/) and the repository's explorer shim (web wallet #717).
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src [NOTE_FEE=sold] node tooling/order-note-regtest.mjs [workdir]
//
// The node runs at default relay policy (-acceptnonstdtxn=0: standardness is enforced, as on the
// testnet), with fees accepted in XLOCK and ZFEE, not in YASK, and supervised assets active.
//
// D1  the library's data output (TxBuilder.addDataOutput) in a non-policy fee asset relays and is
//     mined; the transaction holds no policy asset; its size beside the same send without it
// D2  the same in an asset the node does not accept for fees
// D3  the same in a supervised asset, as the data output's asset and as the fee asset
// D4  (control: standardness is enforced) two data outputs are refused by relay policy
// N1  orders placed through the page carry their note in the fee asset; an order placed without one
//     costs that much less
// N2  a restore from the phrase alone (every record gone) rebuilds, exactly, an unfilled order, a
//     part-filled one at its remainder, and one the relay no longer lists, in default mode
// N3  an old order without a note is not rebuilt by notes, and the search by what was asked finds it
// N4  Reclaim takes back each of them
// N5  a page whose wallet kit has no data output places an order without a note, records it so,
//     says so once in the console; a restore finds it by the search, never by a note
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const BIN = process.env.SEQUENTIA_BIN, root = resolve(process.env.WEB_ROOT || new URL('..', import.meta.url).pathname)
const { startEsploraShim } = await import(join(root, 'tooling/esplora-shim.mjs'))
const { HDKey, mnemonicToSeedSync, secp256k1 } = await import(join(root, 'btc.js'))
const MAKER = 'exist carry drive collect lend cereal occur much tiger just involve mean'          // public, test only
const TAKER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' // public, test only
const COIN = 100000000
let failures = 0
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++ }
const dir = process.argv[2]; mkdirSync(dir, { recursive: true })
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const [p2p, rpcport, pp2p, prpc] = [await free(), await free(), await free(), await free()]
mkdirSync(join(dir, 'parent'), { recursive: true })
const parent = spawn(join(BIN, 'sequentiad'), [`-datadir=${join(dir, 'parent')}`, '-chain=regtest', `-port=${pp2p}`, `-rpcport=${prpc}`, '-listen=0', '-server',
  '-rpcuser=drive', '-rpcpassword=drive', '-disablewallet'], { stdio: 'ignore' })
console.log('parent pid ' + parent.pid)
const pcli = (...a) => execFileSync(join(BIN, 'sequentia-cli'), [`-datadir=${join(dir, 'parent')}`, '-chain=regtest', `-rpcport=${prpc}`, '-rpcuser=drive', '-rpcpassword=drive', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
for (let i = 0; ; i++) { try { pcli('getblockcount'); break } catch { if (i > 240) throw new Error('the parent did not start'); await new Promise(r => setTimeout(r, 500)) } }
pcli('generatetodescriptor', '5', JSON.parse(pcli('getdescriptorinfo', 'raw(51)')).descriptor)
writeFileSync(join(dir, 'elements.conf'), ['chain=elementsregtest', '[elementsregtest]', 'server=1', 'listen=0', `port=${p2p}`, `rpcport=${rpcport}`,
  'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', 'rpcuser=drive', 'rpcpassword=drive', 'initialfreecoins=2100000000000000', 'anyonecanspendaremine=1',
  'blindedaddresses=0', 'con_default_blinded_addresses=0', 'validatepegin=0', 'con_parent_chain_signblockscript=51', 'con_any_asset_fees=1',
  'par=1', 'txindex=1', 'fallbackfee=0.0001', 'maxtxfee=100', 'acceptnonstdtxn=0', 'supervisedassetsheight=1',
  'con_bitcoin_anchor=1', 'validateanchor=1', 'mainchainrpchost=127.0.0.1', `mainchainrpcport=${prpc}`, 'mainchainrpcuser=drive', 'mainchainrpcpassword=drive',
  'parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206', 'anchorpollinterval=1', 'anchorminconf=1', ''].join('\n'))
const node = spawn(join(BIN, 'sequentiad'), [`-datadir=${dir}`], { stdio: 'ignore' })
console.log('node pid ' + node.pid)
const cli = (...a) => execFileSync(join(BIN, 'sequentia-cli'), [`-datadir=${dir}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const json = (...a) => JSON.parse(cli(...a))
let shim = null
async function cleanup () {
  try { if (shim) await shim.close() } catch {}
  try { cli('stop') } catch { node.kill() }
  await new Promise((r) => node.exitCode !== null ? r() : node.once('exit', r))
  try { pcli('stop') } catch { parent.kill() }
  await new Promise((r) => parent.exitCode !== null ? r() : parent.once('exit', r))
  rmSync(dir, { recursive: true, force: true })
}
const xonly = (seed) => { const p = new Uint8Array(32); p[31] = seed; return Buffer.from(secp256k1.getPublicKey(p, true)).subarray(1).toString('hex') }

try {
  for (let i = 0; ; i++) { try { cli('getblockchaininfo'); break } catch { if (i > 240) throw new Error('the node did not start'); await new Promise(r => setTimeout(r, 500)) } }
  await new Promise(r => setTimeout(r, 2000))
  cli('createwallet', 'bank')
  const bankAddr = () => cli('getnewaddress')
  const mine = (n) => cli('generatetoaddress', String(n), bankAddr())
  mine(101); cli('rescanblockchain')
  const policy = json('getsidechaininfo').pegged_asset
  const genesis = cli('getblockhash', '0')
  console.log('     relay policy: acceptnonstdtxn=0 (getnetworkinfo relayfee ' + json('getnetworkinfo').relayfee + ')')
  const issue = () => { const a = json('-named', 'issueasset', 'assetamount=1000', 'tokenamount=0', 'blind=false', 'fee_asset=bitcoin').asset; mine(1); return a }
  const X = issue(); const Y = issue(); const Z = issue()
  const S = json('-named', 'issueasset', 'assetamount=1000', 'tokenamount=1', 'blind=false', 'fee_asset=bitcoin',
    'supervision=' + JSON.stringify({ operationalkey: xonly(11), recoverykey: xonly(12), pause: true })).asset
  mine(1)
  ok(json('getsupervisedassets').some((a) => a.asset === S), 'S is a supervised asset')
  const rates = json('getfeeexchangerates'); rates[X] = COIN; rates[Z] = COIN; rates[S] = COIN   // YASK is not accepted for fees
  cli('setfeeexchangerates', JSON.stringify(rates))
  let mock = json('getblockheader', cli('getbestblockhash')).time + 60
  cli('setmocktime', String(mock)); mine(12)
  const send = (address, amount, asset) => cli('-named', 'sendtoaddress', `address=${address}`, `amount=${amount}`, `assetlabel=${asset}`, 'fee_asset_label=bitcoin')
  shim = await startEsploraShim({ rpc: { url: `http://127.0.0.1:${rpcport}/`, auth: 'drive:drive' }, port: await free() })

  let store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.WebSocket = class { constructor () { this.readyState = 3 } send () {} close () {} addEventListener () {} }
  globalThis.location = { origin: shim.url, protocol: 'http:', host: '127.0.0.1' }
  const lwk = await import(join(root, 'pkg/lwk_wasm.js'))
  await lwk.default({ module_or_path: readFileSync(join(root, 'pkg/lwk_wasm_bg.wasm')) })
  const network = lwk.Network.regtestWithGenesis(new lwk.AssetId(policy), genesis)
  const signer = new lwk.Signer(new lwk.Mnemonic(MAKER), network)
  let wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const tsigner = new lwk.Signer(new lwk.Mnemonic(TAKER), network)
  const twollet = new lwk.Wollet(network, tsigner.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, shim.url, false, 1, false)
  const sync = async () => { let u = await client.fullScan(wollet); if (u) wollet.applyUpdate(u); u = await client.fullScan(twollet); if (u) twollet.applyUpdate(u) }
  const me = wollet.address(undefined).address().toUnconfidential().toString()
  const taker = twollet.address(undefined).address().toUnconfidential().toString()
  send(me, 100, X); send(me, 5, Z); send(me, 2, S); send(me, 1, Y); send(taker, 100, Y); send(taker, 1, 'bitcoin'); mine(1); await sync()
  const tick = { [X]: 'XLOCK', [Y]: 'YASK', [Z]: 'ZFEE', [S]: 'SUPV', [policy]: 'tSEQ' }

  // ---- D1..D4: the library's data output, at default relay policy
  const NOTE = new Uint8Array(59).fill(0x5a)
  const build = (dataAssets, feeAsset) => {
    let b = network.txBuilder().addExplicitRecipient(new lwk.Address(bankAddr()), 1000n, new lwk.AssetId(X))
    for (const a of dataAssets) b = b.addDataOutput(NOTE, new lwk.AssetId(a))
    b = b.feeRate(2000).feeAsset(new lwk.AssetId(feeAsset), BigInt(COIN))
    const fin = wollet.finalize(signer.sign(b.finish(wollet)))
    return fin.extractTx().toString()
  }
  const accept = (hex) => json('testmempoolaccept', JSON.stringify([hex]))[0]
  const relayAndMine = async (hex, what) => {
    const a = accept(hex)
    const txid = a.allowed ? cli('sendrawtransaction', hex) : null
    let mined = false
    if (txid) { const h = mine(1); mined = json('getrawtransaction', txid, 'true').confirmations >= 1; await sync() }
    const d = json('decoderawtransaction', hex)
    const data = d.vout.filter((o) => o.scriptPubKey.type === 'nulldata')
    const assets = new Set(d.vout.map((o) => o.asset).filter(Boolean))
    ok(a.allowed && mined, `${what}: relayed ${a.allowed ? 'yes' : 'NO (' + a['reject-reason'] + ')'}, mined ${mined ? 'yes' : 'no'}; vsize ${d.vsize}, weight ${d.weight}`)
    return { d, data, assets, txid }
  }
  // the same send without a data output, for the size it adds
  const plainHex = build([], Z)
  const plain = json('decoderawtransaction', plainHex)
  {
    const { d, data, assets } = await relayAndMine(build([Z], Z), 'D1 a data output in ZFEE, the fee in ZFEE (accepted, not the policy asset)')
    ok(data.length === 1 && data[0].value === 0 && data[0].asset === Z && data[0].scriptPubKey.hex === '6a3b' + Buffer.from(NOTE).toString('hex'),
      `    one data output: OP_RETURN of 59 bytes, value 0, asset ZFEE (its script ${data[0].scriptPubKey.hex.length / 2} bytes)`)
    ok(!assets.has(policy), `    no output in the policy asset (assets: ${[...assets].map((a) => tick[a] || a).join(', ')})`)
    const ins = d.vin.map((i) => json('getrawtransaction', i.txid, 'true').vout[i.vout].asset)
    ok(!ins.includes(policy), `    no input of the policy asset (inputs: ${ins.map((a) => tick[a] || a).join(', ')})`)
    console.log(`     size: with the data output vsize ${d.vsize} / weight ${d.weight}; the same send without it vsize ${plain.vsize} / weight ${plain.weight}: +${d.vsize - plain.vsize} vB, +${d.weight - plain.weight} WU`)
  }
  await relayAndMine(build([Y], Z), 'D2 a data output in YASK, an asset the node does not accept for fees')
  await relayAndMine(build([S], Z), 'D3 a data output in SUPV, a supervised asset')
  await relayAndMine(build([S], S), 'D3 a data output in SUPV with the fee in SUPV')
  ok(json('getsupervisedassets').some((a) => a.asset === S), '    SUPV is still supervised after both')
  {
    const a = accept(build([Z, Z], Z))
    ok(!a.allowed && /multi-op-return/.test(a['reject-reason']), `D4 (control) two data outputs are refused by relay policy: ${a['reject-reason']}`)
  }
  {
    let e = ''; try { network.txBuilder().addDataOutput(new Uint8Array(81), new lwk.AssetId(Z)) } catch (x) { e = String(x && x.message || x) }
    ok(/at most 80 bytes/.test(e), 'D4 the library refuses a data output over 80 bytes: ' + e)
  }

  // ---- N1..N4: the page's resting orders with their notes
  const keyRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(MAKER))
  const C = {
    $: () => null, toast: (m) => console.log('     toast: ' + m),
    assetMeta: (h) => ({ ticker: tick[h] || String(h).slice(0, 6), precision: 8 }),
    fmtAtoms: (a, p) => (Number(a) / 10 ** (p || 0)).toString(), prettyErr: (e) => String(e && e.message || e),
    wasm: lwk, network, wollet, signer, mnemonic: MAKER, POLICY_HEX: policy, keyRoot: () => keyRoot, devMode: () => false,
    client: { fullScan: (w) => client.fullScan(w), broadcast: (pset) => client.broadcast(pset) },
    applyFee: (b, feeHex) => (feeHex && feeHex !== policy ? b.feeRate(2000).feeAsset(new lwk.AssetId(feeHex), BigInt(COIN)) : b.feeRate(2000)),
    withWollet: async (f) => f(), sync, noteOwnTx: () => {},
    esploraFetch: (path, opts) => fetch(shim.url + path, opts),
    feeRateFor: () => BigInt(COIN), DEFAULT_FEERATE: 2000, EXCHANGE_RATE_SCALE: COIN, SEQOB: 'http://127.0.0.1:1',
    balObj: () => wollet.balance().toJSON(), get feeRates () { return { [policy]: { rate: COIN }, [X]: { rate: COIN }, [Z]: { rate: COIN } } },
  }
  const swap = await import(join(root, 'swap.js'))
  const { settleFill, planPlaceOrder, buildCovenantTerms } = await (async () => { const m = await import(join(root, 'covenant-order.js')); return { ...m, ...m.__test__ } })()
  const { makerPayout, makeCovenantHooks } = await import(join(root, 'covenant-fill-host.js'))
  const { computeRate, covenantMinLot, covenantDerivationIds } = await import(join(root, 'covenant-flow.js'))
  const { explorerScriptHash } = await import(join(root, 'explorer-script-hash.js'))
  const SW = swap.__test__
  swap.initSwap(C)
  // NOTE_FEE=sold: the fee in the asset the order sells (the page's default); otherwise in ZFEE, chosen.
  SW.setFeeState(process.env.NOTE_FEE === 'sold' ? { payAsset: X } : { payAsset: X, feeAsset: Z, feeAssetTouched: true })
  const FA = SW.feeAssetPolicy().asset || X   // fundCovenant pays in the chosen fee asset, else the asset sold
  console.log('     the page\'s fee asset for these orders: ' + (tick[FA] || FA))
  const PLACED = 'seqobCovenantOrders.v1'
  const records = () => JSON.parse(store.get(PLACED) || '[]')
  const utxosAt = async (spk) => (await (await fetch(`${shim.url}/scripthash/${await explorerScriptHash(spk)}/utxo`)).json())
  async function place (sell, recv, opts) {
    const n = records().length
    try { await SW.placeCovenant(X, Y, sell, recv, null, opts) } catch (e) { /* relay down: the record is written */ }
    const r = records()[n]
    if (!r || !r.covTxid) throw new Error('placing left no funded record')
    mine(1); await sync()
    return r
  }
  async function fill (rec, at, fillAtoms) {
    const payout = makerPayout(signer, network, rec.makerIndex)
    const { rateNum, rateDen } = computeRate(BigInt(rec.sellAtoms), BigInt(rec.recvAtoms))
    const plan = planPlaceOrder({ ...covenantDerivationIds(rec.pay, rec.receive, true), sellAtoms: BigInt(rec.sellAtoms), rateNum, rateDen,
      minLot: covenantMinLot(BigInt(rec.sellAtoms)), expiryLocktime: Number(rec.expiry), makerProg: payout.program, makerX: payout.internalKey })
    const matched = { offer_id: rec.offerId, resting_is_covenant: true, covenant: buildCovenantTerms(plan.order, at.txid, at.vout, plan.tap),
      covenant_locked: String(at.locked), fill_base_amount: String(fillAtoms) }
    const hooks = makeCovenantHooks({ wasm: lwk, wollet: twollet, network, mnemonic: TAKER, esploraFetch: C.esploraFetch, fee: { asset: policy, atoms: 20000 }, opts: {} })
    const { txid } = await settleFill(matched, hooks)
    mine(1); await sync()
    return txid
  }
  const SELL = 10n * BigInt(COIN)
  const o1 = await place(SELL, 3n * BigInt(COIN) + 12345n)          // unfilled, at an unround price
  const o2 = await place(SELL + 7n, 2n * BigInt(COIN) + 777n)       // to be filled in part
  const o3 = await place(SELL + 11n, 4n * BigInt(COIN) + 1n)        // listed once, then no longer
  const o4 = await place(SELL + 13n, 5n * BigInt(COIN), { noNote: true })   // an old order: no note
  // N5: the same page with a kit that lacks the data output (an older pkg/ on the server).
  const warned = []
  let o5
  {
    const realTx = lwk.Network.prototype.txBuilder, realWarn = console.warn
    const hide = (b) => new Proxy(b, { get: (t, k) => (k === 'addDataOutput' ? undefined : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) })
    lwk.Network.prototype.txBuilder = function () { return hide(realTx.call(this)) }
    console.warn = (...a) => { warned.push(a.join(' ')) }
    try { o5 = await place(SELL + 17n, 6n * BigInt(COIN)) } finally { lwk.Network.prototype.txBuilder = realTx; console.warn = realWarn }
  }
  const funding = (r) => json('decoderawtransaction', json('getrawtransaction', r.covTxid, 'true').hex)
  for (const [n, r] of [['o1', o1], ['o2', o2], ['o3', o3]]) {
    const d = funding(r), data = d.vout.filter((o) => o.scriptPubKey.type === 'nulldata')
    ok(r.noted && data.length === 1 && data[0].asset === FA && data[0].value === 0 && /^6a3b[0-9a-f]{118}$/.test(data[0].scriptPubKey.hex),
      `N1 ${n}'s funding carries its 59-byte note in ${tick[FA]} (the fee asset), value 0; vsize ${d.vsize}; assets ${[...new Set(d.vout.map((o) => tick[o.asset] || o.asset))].join(', ')}`)
  }
  {
    const d4 = funding(o4), d1 = funding(o1)
    ok(!o4.noted && !d4.vout.some((o) => o.scriptPubKey.type === 'nulldata'), `N1 o4 (no note) has no data output; vsize ${d4.vsize}: the note costs ${d1.vsize - d4.vsize} vB`)
    const fee = (d) => d.vout.filter((o) => o.scriptPubKey.hex === '').map((o) => `${o.value} ${tick[o.asset] || o.asset}`).join('+')
    console.log(`     funding fees: with the note ${fee(d1)}, without ${fee(d4)}`)
    // What the wallet's history reads for a funding with a note: the coins locked and the fee, no burn.
    const wt = wollet.transactions().find((t) => t.txid().toString() === o1.covTxid)
    const bal = wt ? wt.balance().toJSON() : {}
    const feeAtoms = BigInt(Math.round(d1.vout.filter((o) => o.scriptPubKey.hex === '')[0].value * COIN))
    const want = FA === X ? { [X]: -(SELL + feeAtoms) } : { [X]: -SELL, [FA]: -feeAtoms }
    ok(wt && JSON.stringify(Object.keys(bal).sort()) === JSON.stringify(Object.keys(want).sort()) && Object.entries(want).every(([a, v]) => BigInt(bal[a]) === v),
      `N1 the wallet reads o1's funding as ${Object.entries(bal).map(([a, v]) => v + ' ' + (tick[a] || a)).join(', ')}: the order and the fee, nothing for the note`)
  }
  {
    const d5 = funding(o5)
    ok(o5.noted === false && !d5.vout.some((o) => o.scriptPubKey.type === 'nulldata'), `N5 with a kit lacking the data output, o5 is placed with no note and recorded so (noted: ${o5.noted})`)
    ok(warned.filter((w) => /no data output/.test(w)).length === 1, 'N5 the console says so once: ' + (warned[0] || '(nothing)').slice(0, 120))
  }
  // o3 was listed and is no longer: on the chain it is an order like any other; its record said posted.
  { const all = records(); const r = all.find((x) => x.offerId === o3.offerId); r.posted = true; store.set(PLACED, JSON.stringify(all)); SW.loadPlaced() }
  const half = SELL / 2n
  const fill2 = await fill(o2, { txid: o2.covTxid, vout: o2.covVout, locked: SELL + 7n }, half)
  ok((await utxosAt(o2.spkHex)).length === 1, `o2 filled in part (${fill2.slice(0, 10)}); its remainder rests at the same script`)

  // ---- N2: restore from the phrase alone, in default mode
  const before = Object.fromEntries([o1, o2, o3, o4, o5].map((r) => [r.spkHex, r]))
  store = new Map()   // the site's data cleared: no record, no archive, no scan memory
  SW.loadPlaced()
  wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor()); C.wollet = wollet; await sync()
  ok(SW.placed().length === 0 && SW.archived().length === 0, 'N2 the wallet opens from its phrase with no record of any order')
  const t0 = Date.now()
  await SW.scanLostOrders(true)
  const back = SW.placed()
  console.log(`     the scan took ${Date.now() - t0} ms and put back ${back.length} order(s)`)
  for (const [n, o, rest] of [['o1', o1, SELL], ['o2', o2, SELL + 7n - half], ['o3', o3, SELL + 11n]]) {
    const r = back.find((x) => x.spkHex === o.spkHex)
    const same = r && r.recvAtoms === o.recvAtoms && r.sellAtoms === o.sellAtoms && Number(r.expiry) === Number(o.expiry) && r.makerIndex === o.makerIndex &&
      r.pay === o.pay && r.receive === o.receive && r.idsInternal === true
    ok(same && BigInt(r.restAtoms) === rest, `N2 ${n} rebuilt from its note with its exact terms (asked ${r && r.recvAtoms}, lock ${r && r.expiry}, key ${r && r.makerIndex}), resting ${r && r.restAtoms} at ${r && (r.covTxid.slice(0, 10) + ':' + r.covVout)}`)
  }
  ok(!back.some((x) => x.spkHex === o4.spkHex), 'N3 o4, placed without a note, is not rebuilt by notes')
  ok(!back.some((x) => x.spkHex === o5.spkHex), 'N5 o5 (a kit without the data output) is not rebuilt by notes')
  await SW.scanLostOrders(true)
  ok(SW.placed().length === 3, 'N2 a second scan rebuilds nothing twice (' + SW.placed().length + ' orders)')
  // A record deleted by hand after scans have read its funding (the scan's memory kept): the next scan
  // rebuilds it from the note, which is read at every scan.
  store.set(PLACED, JSON.stringify(records().filter((r) => r.spkHex !== o1.spkHex))); SW.loadPlaced()
  ok(!SW.placed().some((x) => x.spkHex === o1.spkHex), 'N2 o1\'s record deleted by hand')
  await SW.scanLostOrders(true)
  ok(SW.placed().some((x) => x.spkHex === o1.spkHex && x.recvAtoms === o1.recvAtoms) && SW.placed().length === 3, 'N2 the next scan rebuilds o1 from its note')

  // ---- N3: the old order still gets the search (developer mode, the person's answer)
  C.devMode = () => true
  SW.askLostOrders()
  await SW.scanLostOrders(true)
  const l4 = SW.lostLocks().find((l) => l.spkHex === o4.spkHex), l5 = SW.lostLocks().find((l) => l.spkHex === o5.spkHex)
  ok(!!l4 && !!l5 && SW.lostLocks().length === 2, `N3/N5 the search lists o4's and o5's coins as paid to a script without an order (${SW.lostLocks().length} listed)`)
  const found = l4 && await SW.recoverLostOrder(l4, Y, '5', 0)
  ok(found && found.rec && found.rec.makerIndex === o4.makerIndex, `N3 "I asked for 5 YASK" rebuilds o4 (${found && found.tried} candidates)`)
  const found5 = l5 && await SW.recoverLostOrder(l5, Y, '6', 0)
  ok(found5 && found5.rec && found5.rec.makerIndex === o5.makerIndex, `N5 "I asked for 6 YASK" rebuilds o5 (${found5 && found5.tried} candidates)`)

  // ---- N4: Reclaim each, once its lock opens
  const maxExp = Math.max(...[o1, o2, o3, o4, o5].map((r) => Number(r.expiry)))
  mock = maxExp + 120; cli('setmocktime', String(mock)); mine(12); await sync()
  for (const [n, o] of [['o1', o1], ['o2', o2], ['o3', o3], ['o4', o4], ['o5', o5]]) {
    const r = SW.placed().find((x) => x.spkHex === o.spkHex)
    let e = '', out = null
    try { const mtp = json('getblockchaininfo').mediantime; out = await SW.reclaimPlaced(r, { height: Number(cli('getblockcount')), medianTime: mtp }, async () => true) } catch (x) { e = String(x && x.message || x) }
    mine(1); await sync()
    const left = r ? await utxosAt(r.spkHex) : null
    ok(!e && out && out.refundTxid && left && left.length === 0, `N4 Reclaim takes back ${n} (${e ? e.slice(0, 160) : out && out.refundTxid ? out.refundTxid.slice(0, 10) : JSON.stringify(out)}); nothing rests at its script`)
  }
} catch (e) {
  failures++; console.log('FAIL ' + (e && e.stack || e))
} finally {
  await cleanup()
}
console.log(failures ? `FAILED: ${failures}` : 'PASS')
process.exit(failures ? 1 : 0)
