#!/usr/bin/env node
// A resting order's coins are never lost from sight (web wallet #708), on a private regtest chain,
// with the page's own Swap code (swap.js), the wallet library (pkg/) and an explorer over the node
// (tooling/esplora-shim.mjs):
//
//  1. An order is placed through swap.js placeCovenant, and the page "closes" right after its funding
//     is broadcast, before the order's outpoint is written: its record holds the funding's id only.
//  2. On the next open the page finds the order's coin under the explorer's id and keeps the record.
//  3. A record whose funding was signed but never broadcast is noted absent, kept, and archived only
//     when absent again ten minutes later; never deleted.
//  4. The order's record is deleted by hand. The page lists the coin as paid to a script it holds no
//     order for; a wrong "asked for" finds nothing; the right one rebuilds the very record that was
//     deleted.
//  5. Its refund before the lock opens is forced into a block and refused (non-final); after the
//     lock opens, the page's Reclaim path takes the coins back.
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src node tooling/covenant-recovery-regtest.mjs [workdir]
//
// Needs pkg/ (the lwk_wasm build). Stops its nodes and removes the work directory it made.
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { startEsploraShim } from './esplora-shim.mjs'

const BIN = process.env.SEQUENTIA_BIN
if (!BIN) { console.log('skipped: set SEQUENTIA_BIN'); process.exit(0) }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean'   // public, test only
const COIN = 100000000
let failures = 0
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++ }
const MIN = 60_000

const dir = process.argv[2] ? (mkdirSync(process.argv[2], { recursive: true }), process.argv[2]) : mkdtempSync(join(tmpdir(), 'cov-recovery-'))
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const [p2p, rpcport, pp2p, prpc] = [await free(), await free(), await free(), await free()]
mkdirSync(join(dir, 'parent'), { recursive: true })
const parent = spawn(join(BIN, 'sequentiad'), [`-datadir=${join(dir, 'parent')}`, '-chain=regtest', `-port=${pp2p}`, `-rpcport=${prpc}`, '-listen=0', '-server',
  '-rpcuser=drive', '-rpcpassword=drive', '-disablewallet'], { stdio: 'ignore' })
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
  const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'))
  mine(101); cli('rescanblockchain')
  const policy = json('getsidechaininfo').pegged_asset
  const genesis = cli('getblockhash', '0')
  const issue = () => { const a = json('-named', 'issueasset', 'assetamount=1000', 'tokenamount=0', 'blind=false', 'fee_asset=bitcoin').asset; mine(1); return a }
  const X = issue(); const Y = issue()
  const rates = json('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN
  cli('setfeeexchangerates', JSON.stringify(rates))
  let mock = json('getblockheader', cli('getbestblockhash')).time + 60
  cli('setmocktime', String(mock)); mine(12)
  const send = (address, amount, asset) => cli('-named', 'sendtoaddress', `address=${address}`, `amount=${amount}`, `assetlabel=${asset}`, 'fee_asset_label=bitcoin')
  shim = await startEsploraShim({ rpc: { url: `http://127.0.0.1:${rpcport}/`, auth: 'drive:drive' }, port: await free() })

  // The page's wallet, in this process: the library from its bytes, the explorer at the shim.
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.WebSocket = class { constructor () { this.readyState = 3 } send () {} close () {} addEventListener () {} }
  globalThis.location = { origin: shim.url, protocol: 'http:', host: '127.0.0.1' }   // seqTipMedianTime reads <origin>/api/…
  const lwkMod = await import(join(root, 'pkg/lwk_wasm.js'))
  await lwkMod.default({ module_or_path: readFileSync(join(root, 'pkg/lwk_wasm_bg.wasm')) })
  const lwk = lwkMod
  const network = lwk.Network.regtestWithGenesis ? lwk.Network.regtestWithGenesis(new lwk.AssetId(policy), genesis) : lwk.Network.regtest(new lwk.AssetId(policy))
  const signer = new lwk.Signer(new lwk.Mnemonic(MNEMONIC), network)
  const wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, shim.url, false, 1, false)
  const sync = async () => { const u = await client.fullScan(wollet); if (u) wollet.applyUpdate(u) }
  const me = wollet.address(undefined).address().toUnconfidential().toString()
  send(me, 50, X); send(me, 1, 'bitcoin'); mine(1); await sync()

  let closeAfterBroadcast = false
  const toasts = []
  const C = {
    $: () => null, toast: (m) => { toasts.push(m); console.log('     toast: ' + m) },
    assetMeta: (h) => { const t = h === X ? 'XLOCK' : h === Y ? 'YASK' : h === policy ? 'tSEQ' : h.slice(0, 6); return { ticker: t, name: t, precision: 8 } },
    fmtAtoms: (a, p) => (Number(a) / 10 ** (p || 0)).toString(), prettyErr: (e) => String(e && e.message || e),
    wasm: lwk, network, wollet, signer, mnemonic: MNEMONIC, POLICY_HEX: policy,
    client: { fullScan: (w) => client.fullScan(w), broadcast: async (pset) => {
      const t = await client.broadcast(pset)
      if (closeAfterBroadcast) { closeAfterBroadcast = false; throw new Error('the page closed') }
      return t
    } },
    applyFee: (b) => b.feeRate(2000), withWollet: async (f) => f(), sync, noteOwnTx: () => {},
    esploraFetch: (path, opts) => fetch(shim.url + path, opts),
    feeRateFor: () => BigInt(COIN), DEFAULT_FEERATE: 2000, EXCHANGE_RATE_SCALE: COIN, SEQOB: 'http://127.0.0.1:1',
    balObj: () => wollet.balance().toJSON(), registryAssets: () => [X, Y, policy],
  }
  const swap = await import(join(root, 'swap.js'))
  const { planRefund, cancel } = await import(join(root, 'covenant-order.js'))
  const { makerPayout } = await import(join(root, 'covenant-fill-host.js'))
  const { explorerScriptHash } = await import(join(root, 'explorer-script-hash.js'))
  const SW = swap.__test__
  swap.initSwap(C)
  const PLACED = 'seqobCovenantOrders.v1'
  const records = () => JSON.parse(store.get(PLACED) || '[]')
  const writeRecords = (r) => { store.set(PLACED, JSON.stringify(r)); SW.loadPlaced() }

  // 1. Place an order, the page closing right after the funding is broadcast.
  const SELL = 10n * BigInt(COIN), RECV = 3n * BigInt(COIN) + 12345678n
  closeAfterBroadcast = true
  let placeErr = null
  try { await SW.placeCovenant(X, Y, SELL, RECV, null) } catch (e) { placeErr = String(e.message || e) }
  ok(placeErr === 'the page closed', 'the order was placed and the page closed during the broadcast: ' + placeErr)
  let rec = records()[0]
  ok(rec && rec.covTxid == null && /^[0-9a-f]{64}$/.test(rec.fundTxid || ''), 'the record holds no outpoint, only the funding id ' + (rec && rec.fundTxid))
  ok(json('getrawmempool').includes(rec.fundTxid), 'that funding is in the mempool')
  mine(1)
  const original = { ...rec }

  // 2. The next open, eleven minutes on: the coin is found under the explorer's id; the record kept.
  const id = await explorerScriptHash(rec.spkHex)
  const rev = id.match(/../g).reverse().join('')
  const asked = async (h) => (await (await fetch(`${shim.url}/scripthash/${h}/utxo`)).json()).length
  ok(await asked(id) === 1 && await asked(rev) === 0, `the explorer lists the coin under ${id.slice(0, 12)}… and nothing under the reversed id the page used to ask by`)
  rec.created = Date.now() - 11 * MIN; writeRecords([rec])
  await SW.reconcileUnfundedPlaced()
  rec = records()[0]
  const vout = json('getrawtransaction', rec.covTxid || original.fundTxid, 'true').vout.findIndex((o) => o.scriptPubKey.hex === original.spkHex)
  ok(records().length === 1 && rec.covTxid === original.fundTxid && rec.covVout === vout, `the record is kept and learns its outpoint ${rec.covTxid}:${rec.covVout}`)

  // 3. A record whose funding was signed and never broadcast: noted, kept, archived ten minutes on.
  const ghost = { ...original, offerId: 'ghost', covTxid: null, covVout: null, makerIndex: 9, spkHex: '5120' + 'ab'.repeat(32), fundTxid: 'cd'.repeat(32), created: Date.now() - 11 * MIN }
  writeRecords([rec, ghost])
  await SW.reconcileUnfundedPlaced()
  let g = records().find((r) => r.offerId === 'ghost')
  ok(g && g.absentAt > 0, 'a record whose funding is unknown by its id and its script is noted absent once, and kept')
  g.absentAt = Date.now() - 9 * MIN; writeRecords([rec, g])
  await SW.reconcileUnfundedPlaced()
  ok(records().some((r) => r.offerId === 'ghost'), 'absent again nine minutes later: still kept')
  g = records().find((r) => r.offerId === 'ghost'); g.absentAt = Date.now() - 11 * MIN; writeRecords([rec, g])
  await SW.reconcileUnfundedPlaced()
  ok(!records().some((r) => r.offerId === 'ghost') && SW.archived().some((r) => r.offerId === 'ghost'), 'absent again eleven minutes later: archived, not deleted')
  ok(toasts.some((t) => /never reached the chain/.test(t)), 'and the page says so')
  store.set('seqobCovenantOrders.archived.v1', '[]')

  // A second order, at a round price of the market then (5 XLOCK for 1.55 YASK); the relay is not
  // reached, so it is never listed.
  const SELL2 = 5n * BigInt(COIN), RECV2 = 155000000n
  await sync()
  try { await SW.placeCovenant(X, Y, SELL2, RECV2, null) } catch (e) { console.log('     (placing it: ' + String(e.message || e).slice(0, 200) + ')') }
  const second = records().find((r) => r.sellAtoms === String(SELL2))
  ok(second && second.covTxid, 'a second order rests at a round price, ' + (second && second.covTxid))
  mine(1)
  // The relay's trade log of the pair around then: XLOCK is the base, prices in YASK atoms per XLOCK atom.
  const { createServer: httpServer } = await import('node:http')
  const relay = httpServer((req, res) => {
    const now = Math.floor(Date.now() / 1000)
    if (req.url.startsWith(`/v1/market/${X}/${Y}/trades`)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ trades: [{ ts: now, price: 0.3104 }, { ts: now, price: 0.3097 }] })) }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  C.SEQOB = `http://127.0.0.1:${relay.address().port}`

  // 4. Both records deleted by hand. The page lists both coins and rebuilds the orders.
  writeRecords([])
  await sync()
  SW.askLostOrders()   // the person asks to look for an order missing from the list
  await SW.scanLostOrders(true)
  const locks = SW.lostLocks()
  ok(locks.length === 2 && locks.some((l) => l.txid === original.fundTxid && l.value === SELL) && locks.some((l) => l.txid === second.covTxid && l.value === SELL2),
    `the page lists ${locks.length} coins paid to a script it holds no order for: ${locks.map((l) => l.txid.slice(0, 12) + '…:' + l.vout + ' ' + l.value).join(', ')}`)
  const lr = locks.find((x) => x.value === SELL2), l = locks.find((x) => x.value === SELL)
  let t0 = Date.now()
  const auto = await SW.autoRecoverLostOrder(lr)
  ok(auto.rec && auto.rec.recvAtoms === String(RECV2) && auto.rec.receive === Y && auto.rec.expiry === second.expiry && auto.rec.makerIndex === second.makerIndex,
    `the order at the market's round price is found by the page itself, asking nothing (${auto.tried} candidates, ${Date.now() - t0} ms)`)
  t0 = Date.now()
  const autoOther = await SW.autoRecoverLostOrder(l)
  ok(!autoOther.rec && autoOther.complete, `the other order, not at a market price, is not (${autoOther.tried} candidates, ${Date.now() - t0} ms): the page asks`)
  t0 = Date.now()
  const wrong = (await SW.recoverLostOrder(l, Y, '3.1')).rec
  ok(wrong === null, `a wrong amount asked for finds no order (${Date.now() - t0} ms)`)
  const wrongAsset = (await SW.recoverLostOrder(l, policy, '3.12345678')).rec
  ok(wrongAsset === null, 'the right amount in another asset finds no order')
  t0 = Date.now()
  const near = await SW.recoverLostOrder(l, Y, '3.1234567', 0.0001)
  const back = near.rec
  ok(!!back, `"about 3.1234567, within 0.0001 %" rebuilds the order (${near.tried} candidates, ${Date.now() - t0} ms)`)
  relay.close()
  for (const k of ['pay', 'receive', 'sellAtoms', 'recvAtoms', 'makerIndex', 'spkHex', 'expiry', 'idsInternal'])
    ok(back && String(back[k]) === String(original[k]), `  ${k} = ${back && back[k]} (the deleted record had ${original[k]})`)
  ok(back && back.covTxid === original.fundTxid && back.covVout === vout && back.recovered === true, '  at the coin, marked recovered (never listed by itself)')
  ok(records().length === 2, 'both orders are back in Your resting orders')

  // 5. Reclaim. Before its lock opens, the refund is forced into a block and refused.
  const reclaimTx = async () => {
    const { order } = SW.orderFromPlaced(back)
    const payout = makerPayout(signer, network, back.makerIndex)
    const recipe = planRefund(order, { txid: back.covTxid, vout: back.covVout, locked: BigInt(back.sellAtoms) })
    recipe.covenantAsset = back.pay; recipe.makerKeyPath = payout.path
    return { recipe, hooks: SW.refundHooksFor({ asset: policy, atoms: 3000n }) }
  }
  ok(Number(back.expiry) >= 500000000, `the order's lock is a median time: ${back.expiry} (${new Date(back.expiry * 1000).toISOString()})`)
  {
    const { recipe, hooks } = await reclaimTx()
    const built = await hooks.buildCovenantRefundTx(recipe)
    let err = ''
    try { cli('generateblock', cli('-rpcwallet=bank', 'getnewaddress'), JSON.stringify([built.rawHex])) } catch (e) { err = String(e.stderr || e.message) }
    ok(/non-final/.test(err), 'the refund before the lock opens, forced into a block, is refused: ' + err.trim().split('\n').pop().slice(0, 160))
  }
  mock = Number(back.expiry) + 120; cli('setmocktime', String(mock)); mine(12)
  const mtp = json('getblockchaininfo').mediantime
  ok(mtp > Number(back.expiry), `the chain's median time ${mtp} has passed the lock`)
  await sync()
  const before = BigInt(wollet.balance().toJSON()[X] || 0)
  const { recipe, hooks } = await reclaimTx()
  const out = await cancel(back.offerId, { recipe, tipHeight: Number(cli('getblockcount')), tipTime: mtp, expiryLocktime: Number(back.expiry) },
    { relayCancel: async () => { throw new Error('never listed') }, ...hooks })
  ok(/^[0-9a-f]{64}$/.test(out.refundTxid || ''), 'Reclaim broadcast the refund ' + out.refundTxid)
  mine(1); await sync()
  const after = BigInt(wollet.balance().toJSON()[X] || 0)
  let spent = false; try { spent = cli('gettxout', back.covTxid, String(back.covVout)) === '' } catch { spent = true }
  ok(spent, 'the order\'s coin is spent')
  ok(after - before === SELL, `the wallet holds its ${Number(SELL) / COIN} XLOCK again (${before} -> ${after})`)
} catch (e) {
  failures++; console.log('FAIL ' + (e && e.stack || e))
} finally {
  await cleanup()
}
console.log(failures ? `FAILED: ${failures}` : 'PASS')
process.exit(failures ? 1 : 0)
