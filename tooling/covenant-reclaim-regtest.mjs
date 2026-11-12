#!/usr/bin/env node
// A resting order's Reclaim, its fills and the lost-order scan on a private regtest chain, with the
// page's own swap.js, the wallet library (pkg/) and the repository's explorer shim (the review of
// web wallet #714 found P1, P2, P3 and P5 failing; each is a check here).
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src node tooling/covenant-reclaim-regtest.mjs [workdir]
//
// P1  a funded order whose record goes missing AFTER a lost-order scan ran while it was recorded
//     is listed by the next scan (the "It was an order" way back).
// P2  Reclaim of a partially filled order takes back its remainder (the record's own path).
// P3  a fully filled order is not offered for Reclaim, and Reclaim on it says something true.
// P4  the refund leaf itself enforces the lock: a refund signed with an earlier nLockTime, forced
//     into a block, is refused by the script (not only by the transaction's own finality).
// P5  Reclaim works for a wallet holding the locked asset and other accepted fee assets but no
//     policy asset (no privileged asset: the fee is never silently the policy asset).
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const BIN = process.env.SEQUENTIA_BIN, root = resolve(process.env.WEB_ROOT || new URL('..', import.meta.url).pathname)
const { startEsploraShim } = await import(join(root, 'tooling/esplora-shim.mjs'))
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
  'par=1', 'txindex=1', 'fallbackfee=0.0001', 'maxtxfee=100',
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

try {
  for (let i = 0; ; i++) { try { cli('getblockchaininfo'); break } catch { if (i > 240) throw new Error('the node did not start'); await new Promise(r => setTimeout(r, 500)) } }
  await new Promise(r => setTimeout(r, 2000))
  cli('createwallet', 'bank')
  const bankAddr = () => cli('getnewaddress')
  const mine = (n) => cli('generatetoaddress', String(n), bankAddr())
  mine(101); cli('rescanblockchain')
  const policy = json('getsidechaininfo').pegged_asset
  const genesis = cli('getblockhash', '0')
  const issue = () => { const a = json('-named', 'issueasset', 'assetamount=1000', 'tokenamount=0', 'blind=false', 'fee_asset=bitcoin').asset; mine(1); return a }
  const X = issue(); const Y = issue(); const Z = issue()
  const rates = json('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN; rates[Z] = COIN
  cli('setfeeexchangerates', JSON.stringify(rates))
  let mock = json('getblockheader', cli('getbestblockhash')).time + 60
  cli('setmocktime', String(mock)); mine(12)
  const send = (address, amount, asset) => cli('-named', 'sendtoaddress', `address=${address}`, `amount=${amount}`, `assetlabel=${asset}`, 'fee_asset_label=bitcoin')
  shim = await startEsploraShim({ rpc: { url: `http://127.0.0.1:${rpcport}/`, auth: 'drive:drive' }, port: await free() })

  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.WebSocket = class { constructor () { this.readyState = 3 } send () {} close () {} addEventListener () {} }
  globalThis.location = { origin: shim.url, protocol: 'http:', host: '127.0.0.1' }
  const lwk = await import(join(root, 'pkg/lwk_wasm.js'))
  await lwk.default({ module_or_path: readFileSync(join(root, 'pkg/lwk_wasm_bg.wasm')) })
  const network = lwk.Network.regtestWithGenesis ? lwk.Network.regtestWithGenesis(new lwk.AssetId(policy), genesis) : lwk.Network.regtest(new lwk.AssetId(policy))
  const signer = new lwk.Signer(new lwk.Mnemonic(MAKER), network)
  const wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const tsigner = new lwk.Signer(new lwk.Mnemonic(TAKER), network)
  const twollet = new lwk.Wollet(network, tsigner.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, shim.url, false, 1, false)
  const sync = async () => { let u = await client.fullScan(wollet); if (u) wollet.applyUpdate(u); u = await client.fullScan(twollet); if (u) twollet.applyUpdate(u) }
  const me = wollet.address(undefined).address().toUnconfidential().toString()
  const taker = twollet.address(undefined).address().toUnconfidential().toString()
  send(me, 100, X); send(me, 5, Z); send(me, 1, 'bitcoin'); send(taker, 100, Y); send(taker, 1, 'bitcoin'); mine(1); await sync()

  const C = {
    $: () => null, toast: (m) => console.log('     toast: ' + m),
    assetMeta: (h) => ({ ticker: h === X ? 'XLOCK' : h === Y ? 'YASK' : h === Z ? 'ZFEE' : h === policy ? 'tSEQ' : h.slice(0, 6), precision: 8 }),
    fmtAtoms: (a, p) => (Number(a) / 10 ** (p || 0)).toString(), prettyErr: (e) => String(e && e.message || e),
    wasm: lwk, network, wollet, signer, mnemonic: MAKER, POLICY_HEX: policy,
    client: { fullScan: (w) => client.fullScan(w), broadcast: (pset) => client.broadcast(pset) },
    applyFee: (b) => b.feeRate(2000), withWollet: async (f) => f(), sync, noteOwnTx: () => {},
    esploraFetch: (path, opts) => fetch(shim.url + path, opts),
    feeRateFor: () => BigInt(COIN), DEFAULT_FEERATE: 2000, EXCHANGE_RATE_SCALE: COIN, SEQOB: 'http://127.0.0.1:1',
    balObj: () => wollet.balance().toJSON(), get feeRates () { return { [policy]: { rate: COIN }, [X]: { rate: COIN }, [Z]: { rate: COIN } } },
  }
  const swap = await import(join(root, 'swap.js'))
  const { planRefund, cancel, settleFill, planPlaceOrder, buildCovenantTerms } = await (async () => {
    const m = await import(join(root, 'covenant-order.js')); return { ...m, ...m.__test__ }
  })()
  const { makerPayout, makeCovenantHooks } = await import(join(root, 'covenant-fill-host.js'))
  const { computeRate, covenantMinLot, covenantDerivationIds } = await import(join(root, 'covenant-flow.js'))
  const { explorerScriptHash } = await import(join(root, 'explorer-script-hash.js'))
  const SW = swap.__test__
  swap.initSwap(C)
  const PLACED = 'seqobCovenantOrders.v1', CHECKED = 'seqobCovenantScan.v1'
  const records = () => JSON.parse(store.get(PLACED) || '[]')
  const writeRecords = (r) => { store.set(PLACED, JSON.stringify(r)); SW.loadPlaced() }
  const utxosAt = async (spk) => (await (await fetch(`${shim.url}/scripthash/${await explorerScriptHash(spk)}/utxo`)).json())

  // Place an order through the page; the relay is unreachable, so placeCovenant throws after the
  // record holds its outpoint (as on a page whose relay is down).
  async function place (sell, recv) {
    const n = records().length
    try { await SW.placeCovenant(X, Y, sell, recv, null) } catch (e) { /* relay down: the record is written */ }
    const r = records()[n]
    if (!r || !r.covTxid) throw new Error('placing left no funded record')
    mine(1); await sync()
    return r
  }
  // The taker fills `fill` atoms of the order in `rec` at its current coin (txid:vout, locked).
  async function fill (rec, at, fillAtoms) {
    const payout = makerPayout(signer, network, rec.makerIndex)
    const { rateNum, rateDen } = computeRate(BigInt(rec.sellAtoms), BigInt(rec.recvAtoms))
    const plan = planPlaceOrder({ ...covenantDerivationIds(rec.pay, rec.receive, true), sellAtoms: BigInt(rec.sellAtoms), rateNum, rateDen,
      minLot: covenantMinLot(BigInt(rec.sellAtoms)), expiryLocktime: Number(rec.expiry), makerProg: payout.program, makerX: payout.internalKey })
    const matched = { offer_id: rec.offerId, resting_is_covenant: true, covenant: buildCovenantTerms(plan.order, at.txid, at.vout, plan.tap),
      covenant_locked: String(at.locked), fill_base_amount: String(fillAtoms) }
    const hooks = makeCovenantHooks({ wasm: lwk, wollet: twollet, network, mnemonic: TAKER, esploraFetch: C.esploraFetch,
      fee: { asset: policy, atoms: 20000 }, opts: {} })
    const { txid } = await settleFill(matched, hooks)
    mine(1); await sync()
    return txid
  }
  // The page's Reclaim (swap.js reclaimPlaced, what the Reclaim button runs), the fee confirmed.
  const fees = []
  async function reclaim (rec) {
    const mtp = json('getblockchaininfo').mediantime
    const out = await SW.reclaimPlaced(rec, { height: Number(cli('getblockcount')), medianTime: mtp }, async (fee) => { fees.push(fee); return true })
    if (out.done) throw new Error('filled: nothing is left to take back')
    return out
  }
  const errOf = async (f) => { try { await f(); return '' } catch (e) { return String(e && e.message || e) } }

  const SELL = 10n * BigInt(COIN)
  const o1 = await place(SELL, 3n * BigInt(COIN))          // to be partially filled
  const o2 = await place(SELL + 7n, 2n * BigInt(COIN))     // to be filled whole
  const o3 = await place(SELL + 11n, 4n * BigInt(COIN))    // the lock probe, then reclaim without the policy asset
  const o4 = await place(SELL + 13n, 5n * BigInt(COIN))    // record lost after a scan
  console.log(`     orders at ${[o1, o2, o3, o4].map((r) => r.covTxid.slice(0, 10) + ':' + r.covVout).join(' ')}`)

  // ---- P1: a record lost after a scan ran while it was recorded
  SW.askLostOrders()   // the person asked to look for an order missing from the list
  await SW.scanLostOrders(true)
  const checked = new Set(JSON.parse(store.get(CHECKED) || '[]'))
  ok(SW.lostLocks().length === 0, 'with every record in place the scan lists nothing')
  console.log(`     the scan marked as checked: ${[o1, o2, o3, o4].map((r) => checked.has(r.covTxid) ? 'yes' : 'no').join(' ')} (funding of o1..o4)`)
  writeRecords(records().filter((r) => r.offerId !== o4.offerId))
  await SW.scanLostOrders(true)
  ok(SW.lostLocks().some((l) => l.txid === o4.covTxid), 'P1 an order whose record went missing after a scan is listed by the next scan')
  store.set(CHECKED, '[]')
  await SW.scanLostOrders(true)
  ok(SW.lostLocks().some((l) => l.txid === o4.covTxid), '    (control) with the scan\'s checked list cleared, the same coin is listed')
  writeRecords(records().concat([o4]))

  // ---- P4: the refund leaf enforces the lock (before any lock opens)
  {
    const { order } = SW.orderFromPlaced(o3)
    const payout = makerPayout(signer, network, o3.makerIndex)
    const recipe = planRefund(order, { txid: o3.covTxid, vout: o3.covVout, locked: BigInt(o3.sellAtoms) })
    recipe.covenantAsset = o3.pay; recipe.makerKeyPath = payout.path
    const mtp = json('getblockchaininfo').mediantime
    const early = { ...recipe, expiryLocktime: mtp - 3600 }   // nLockTime final now; the leaf's CLTV still says o3.expiry
    let built = null, err = ''
    try { built = await SW.refundHooksFor().buildCovenantRefundTx(early) } catch (e) { err = 'build: ' + (e.message || e) }
    if (built) { try { cli('generateblock', bankAddr(), JSON.stringify([built.rawHex])); err = 'ACCEPTED' } catch (e) { err = String(e.stderr || e.message).trim().split('\n').pop() } }
    ok(/locktime|Locktime/i.test(err) && !/non-final/.test(err), 'P4 a refund with an earlier nLockTime, forced into a block, is refused by the leaf: ' + err.slice(0, 200))
  }

  // ---- P2/P3: fills
  const half = SELL / 2n
  const fill1 = await fill(o1, { txid: o1.covTxid, vout: o1.covVout, locked: SELL }, half)
  const rem = (await utxosAt(o1.spkHex))
  ok(rem.length === 1 && rem[0].txid === fill1 && BigInt(rem[0].value) === SELL - half, `o1 half filled (${fill1.slice(0, 10)}); its remainder ${rem.map((u) => u.value).join(',')} rests at the same script`)
  const fill2 = await fill(o2, { txid: o2.covTxid, vout: o2.covVout, locked: SELL + 7n }, SELL + 7n)
  ok((await utxosAt(o2.spkHex)).length === 0, `o2 filled whole (${fill2.slice(0, 10)}); nothing rests at its script`)
  const r1 = SW.placed().find((r) => r.offerId === o1.offerId), r2 = o2
  console.log(`     o1's record after the fill: covTxid ${r1.covTxid.slice(0, 10)}:${r1.covVout} sellAtoms ${r1.sellAtoms}`)

  // open every lock
  const maxExp = Math.max(...[o1, o2, o3, o4].map((r) => Number(r.expiry)))
  mock = maxExp + 120; cli('setmocktime', String(mock)); mine(12); await sync()

  // P3: the page's Your resting orders filter (renderMyOrders localReclaim, relay listing nothing)
  await SW.followPlacedCoins()
  const offered = records().filter((r) => r.covTxid != null && !r._orphan).map((r) => r.offerId)
  ok(!offered.includes(o2.offerId), 'P3 a fully filled order is not offered for Reclaim (offered: ' + offered.map((id) => [o1, o2, o3, o4].findIndex((o) => o.offerId === id) + 1).map((n) => 'o' + n).join(',') + ')')
  const e2 = await errOf(async () => { const mtp = json('getblockchaininfo').mediantime; const out = await SW.reclaimPlaced(r2, { height: Number(cli('getblockcount')), medianTime: mtp }, async () => true); if (!out.done) throw new Error('not read as filled: ' + JSON.stringify(out)) })
  ok(!e2, 'P3 Reclaim on the filled o2 reads it as filled, and moves nothing')
  console.log('     Reclaim on the filled o2 says: ' + (e2 || 'no error').slice(0, 200))

  // P2: Reclaim of the partially filled o1 through its record
  const xBefore = BigInt(wollet.balance().toJSON()[X] || 0)
  const e1 = await errOf(async () => { const out = await reclaim(r1); if (!out.refundTxid) throw new Error('no refund: ' + JSON.stringify(out)) })
  mine(1); await sync()
  const xAfter = BigInt(wollet.balance().toJSON()[X] || 0)
  const f1 = fees[fees.length - 1], feeX = f1 && f1.asset === X ? BigInt(f1.atoms) : 0n
  ok(!e1 && xAfter - xBefore === SELL - half - feeX, `P2 Reclaim of the partially filled o1 takes back its remainder ${SELL - half}, less its fee ${feeX} out of those coins (got ${xAfter - xBefore}; ${e1 ? 'error: ' + e1.slice(0, 160) : 'no error'})`)
  ok((await utxosAt(o1.spkHex)).length === 0, '    and nothing rests in the covenant any more')

  // ---- P5: Reclaim without the policy asset
  {
    const b = network.txBuilder().drainLbtcWallet().drainLbtcTo(new lwk.Address(bankAddr())).feeRate(2000)
    const pset = b.finish(wollet); const fin = wollet.finalize(signer.sign(pset)); await client.broadcast(fin)
    mine(1); await sync()
    const bal = wollet.balance().toJSON()
    console.log(`     maker wallet now holds: tSEQ ${bal[policy] || 0}, XLOCK ${bal[X] || 0}, ZFEE ${bal[Z] || 0} (ZFEE and XLOCK accepted for fees at 1:1)`)
    const r3 = SW.placed().find((r) => r.offerId === o3.offerId)
    const e3 = await errOf(async () => { const out = await reclaim(r3); if (!out.refundTxid) throw new Error('no refund: ' + JSON.stringify(out)) })
    ok(!e3, 'P5 Reclaim works for a wallet holding no policy asset: ' + (e3 ? e3.slice(0, 200) : 'refunded'))
    const f = fees[fees.length - 1]
    ok(f && f.asset !== policy, `    its fee, shown before it was confirmed: ${f && f.atoms} of ${f && (f.asset === X ? 'XLOCK (out of the coins coming back)' : f.asset === Z ? 'ZFEE' : f.asset)}`)
  }
} catch (e) {
  failures++; console.log('FAIL ' + (e && e.stack || e))
} finally {
  await cleanup()
}
console.log(failures ? `FAILED: ${failures}` : 'PASS')
process.exit(failures ? 1 : 0)
