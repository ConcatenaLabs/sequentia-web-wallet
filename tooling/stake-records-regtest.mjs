#!/usr/bin/env node
// Run the wallet's stake record flows (stake-records.js, the module the page
// uses) against a real sequentiad: bond, join a pool, find the record, move,
// leave, unbond and claim, each transaction confirmed in a block.
//
//   SEQUENTIAD=/path/to/sequentiad node tooling/stake-records-regtest.mjs [workdir]
//
// Two chains, each a fresh proof-of-stake elementsregtest started the way
// SWK's lwk_wollet/tests/sequentia_stake_records.rs starts one:
//
//  * records from block one (every new chain): join, find, a join finished
//    after its tab "closed" between the two broadcasts, move, leave, unbond,
//    a premature claim refused, claim;
//  * the signature changing at a fork height: a record paid for by wallet
//    coins below it (the old way, still live after the fork) found through the
//    wallet's history, a move signed the legacy way, a spend built for one side
//    of the height rebuilt when a block crosses it, a leave signed the
//    second-generation way above it, and the old way of creating a record
//    refused there.
//
// The wallet half is the page's own: the lwk_wasm build in pkg/ (built with
// --target web, loaded here from its bytes), an EsploraClient scanning the
// chain, and stake-records.js. The explorer is a small Esplora shim answering
// from the node's RPC, in this process.
//
// The chain is anchored, as the testnet is: a second node plays the parent
// chain (an elementsregtest without proof of stake, mined with
// generatetodescriptor), and every Sequentia block commits to one of its block
// headers. That is what makes the headers the wallet's scan decodes the
// testnet's shape, and it is what the unbonding depth is counted in, so the
// claim waits on the parent chain exactly as it does on the testnet.
//
// Needs pkg/ (the lwk_wasm build). Stops its nodes and deletes their data.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { secp256k1, sha256 } from '../btc.js'
import init, * as lwk from '../pkg/lwk_wasm.js'
import * as SR from '../stake-records.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const EXE = process.env.SEQUENTIAD || 'sequentiad'
const WORK = process.argv[2] || mkdtempSync(join(tmpdir(), 'stake-records-'))
mkdirSync(WORK, { recursive: true })

const COIN = 100_000_000n
const UNBONDING = 5        // the chain's unbonding period, blocks: the bond's csv
const UNBOND_DEPTH = 3     // parent-chain blocks an unbonding output waits before its claim
const FEE_RATE = 2000      // the page's DEFAULT_FEERATE, atoms per 1000 vbytes
// A published test mnemonic: the wallet holds nothing outside these runs.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let failures = 0
const log = (...a) => console.log(...a)
function check(cond, what) {
  if (cond) log('  ok   ' + what)
  else { failures++; log('  FAIL ' + what) }
}
async function refused(p, re, what) {
  try { await p; failures++; log('  FAIL ' + what + ': accepted') }
  catch (e) {
    const m = String(e?.message ?? e)
    if (re.test(m)) log('  ok   ' + what + ': ' + m.slice(0, 160))
    else { failures++; log('  FAIL ' + what + ': refused for another reason: ' + m.slice(0, 300)) }
  }
}

// ------------------------------------------------------------------ keys
const hex = (b) => Buffer.from(b).toString('hex')
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58check(payload) {
  const d = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest()
  const b = Buffer.concat([payload, d.subarray(0, 4)])
  let n = BigInt('0x' + b.toString('hex')), s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const x of b) { if (x === 0) s = '1' + s; else break }
  return s
}
function randomKey() {
  const sk = randomBytes(32)
  return { wif: base58check(Buffer.concat([Buffer.from([0xef]), sk, Buffer.from([1])])),
           pub: hex(secp256k1.getPublicKey(sk, true)) }
}

// ------------------------------------------------------------------ node
// A port nothing is listening on, from the OS.
function freePort() {
  return new Promise((ok) => { const s = tcpServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
}
class Node {
  constructor(name, chainArgs) {
    this.dir = join(WORK, name); rmSync(this.dir, { recursive: true, force: true }); mkdirSync(this.dir, { recursive: true })
    this.chainArgs = chainArgs
  }
  async start(extra = []) {
    this.port = await freePort()
    const args = ['-chain=elementsregtest', '-datadir=' + this.dir, '-rpcport=' + this.port, '-port=' + await freePort(),
      '-listen=0', '-server', '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet', '-txindex=1',
      '-par=1', '-persistmempool=0', ...this.chainArgs(), ...extra]
    this.proc = spawn(EXE, args, { stdio: 'ignore' })
    this.exited = new Promise((ok) => this.proc.on('exit', ok))
    for (let i = 0; i < 300; i++) {
      try { await this.rpc('getblockcount'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
    }
    throw new Error('sequentiad did not answer; see ' + join(this.dir, 'elementsregtest', 'debug.log'))
  }
  async stop() {
    try { await this.rpc('stop') } catch {}
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 30000))])
    try { this.proc.kill() } catch {}
  }
  async rpc(method, ...params) {
    const r = await fetch('http://127.0.0.1:' + this.port + '/', {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
    return j.result
  }
  async tip() { return this.rpc('getblockcount') }
  async produce(wif) {
    const r = await this.rpc('generateposblock', wif)
    const b = await this.rpc('getblock', r.hash, 1)
    return { height: b.height, tx: b.tx }
  }
}

// The parent chain: its own node, mined to an anyone-can-spend script.
async function parentChain(name) {
  const node = new Node(name + '-parent', () => ['-validatepegin=0', '-initialfreecoins=0', '-con_blocksubsidy=5000000000',
    '-anyonecanspendaremine=1', '-signblockscript=51'])
  await node.start()
  node.genesis = await node.rpc('getblockhash', 0)
  node.mine = async (n = 1) => { await node.rpc('generatetodescriptor', n, 'raw(51)') }
  await node.mine(5)
  return node
}

// Mine `n` parent blocks and give the Sequentia node time to see them (it
// polls its parent every second), so the next block it produces anchors there.
async function advanceParent(parent, n = 1) {
  await parent.mine(n)
  await new Promise((r) => setTimeout(r, 1500))
}

function chainArgs(producerPub, parent, extra = []) {
  return () => ['-con_pos=1', '-posvrf=1', '-posslotinterval=1', '-signblockscript=51', '-initialfreecoins=2100000000000000',
    '-anyonecanspendaremine=0', '-con_blocksubsidy=0', '-con_connect_genesis_outputs=1', '-validatepegin=0',
    '-con_default_blinded_addresses=0', `-posunbonding=${UNBONDING}`, `-posunbonddepth=${UNBOND_DEPTH}`,
    '-pospayoutnotice=3', `-staker=${producerPub}:${COIN}`,
    '-con_bitcoin_anchor=1', '-validateanchor=1', '-anchorpollinterval=1', '-anchorminconf=1',
    '-mainchainrpchost=127.0.0.1', `-mainchainrpcport=${parent.port}`, '-mainchainrpcuser=u', '-mainchainrpcpassword=p',
    `-parentgenesisblockhash=${parent.genesis}`, ...extra]
}

// ------------------------------------------------------------------ Esplora shim
// The subset of the Esplora API the wallet's scan and stake-records.js read,
// answered from the node's RPC. Re-indexed whenever the tip or mempool moves.
function shim(node) {
  const blocks = new Map()          // hash -> getblock verbosity 2
  let cache = null
  const atoms = (v) => v == null ? undefined : Math.round(v * 1e8)
  async function index() {
    const best = await node.rpc('getbestblockhash')
    const pool = await node.rpc('getrawmempool')
    const key = best + ':' + pool.join(',')
    if (cache && cache.key === key) return cache
    const height = await node.rpc('getblockcount')
    const txs = new Map(), order = []
    for (let h = 0; h <= height; h++) {
      const hash = await node.rpc('getblockhash', h)
      if (!blocks.has(hash)) blocks.set(hash, await node.rpc('getblock', hash, 2))
      const b = blocks.get(hash)
      for (const t of b.tx) { txs.set(t.txid, { t, status: { confirmed: true, block_height: h, block_hash: hash, block_time: b.time } }); order.push(t.txid) }
    }
    for (const id of pool) {
      try { const t = await node.rpc('getrawtransaction', id, true); txs.set(id, { t, status: { confirmed: false } }); order.push(id) } catch {}
    }
    const byScript = new Map(), byAddr = new Map(), spends = new Map()
    const note = (m, k, id) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id) }
    for (const id of order) {
      const { t } = txs.get(id)
      t.vout.forEach((o) => {
        const spk = o.scriptPubKey.hex
        note(byScript, createHash('sha256').update(Buffer.from(spk, 'hex')).digest('hex'), id)
        if (o.scriptPubKey.address) note(byAddr, o.scriptPubKey.address, id)
      })
      for (const i of t.vin) {
        if (i.coinbase || !i.txid) continue
        spends.set(i.txid + ':' + i.vout, { txid: id, vin: t.vin.indexOf(i) })
        const prev = txs.get(i.txid)
        if (prev) {
          const o = prev.t.vout[i.vout]
          note(byScript, createHash('sha256').update(Buffer.from(o.scriptPubKey.hex, 'hex')).digest('hex'), id)
          if (o.scriptPubKey.address) note(byAddr, o.scriptPubKey.address, id)
        }
      }
    }
    cache = { key, best, height, txs, order, byScript, byAddr, spends }
    return cache
  }
  function esploraTx(c, id) {
    const { t, status } = c.txs.get(id)
    const out = (o) => ({ scriptpubkey: o.scriptPubKey.hex, scriptpubkey_address: o.scriptPubKey.address, value: atoms(o.value), asset: o.asset })
    return {
      txid: id, status,
      vin: t.vin.map((i) => i.coinbase ? { is_coinbase: true } : {
        txid: i.txid, vout: i.vout, is_coinbase: false,
        prevout: c.txs.has(i.txid) ? out(c.txs.get(i.txid).t.vout[i.vout]) : null }),
      vout: t.vout.map(out),
    }
  }
  // Newest first, mempool before confirmed, as Esplora lists them.
  function history(c, ids) {
    const list = c.order.filter((id) => ids && ids.has(id)).reverse()
    return list.map((id) => esploraTx(c, id))
  }
  async function handle(req, body) {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/api/, '')
    if (process.env.SHIM_LOG) log("    shim " + req.method + " " + p)
    if (req.method === 'POST' && p === '/tx') {
      try { return [200, await node.rpc('sendrawtransaction', body.trim())] }
      catch (e) { return [400, 'sendrawtransaction RPC error: ' + e.message] }
    }
    const c = await index()
    let m
    if (p === '/blocks/tip/height') return [200, String(c.height)]
    if (p === '/blocks/tip/hash') return [200, c.best]
    if ((m = p.match(/^\/block-height\/(\d+)$/))) return [200, await node.rpc('getblockhash', Number(m[1]))]
    if ((m = p.match(/^\/block\/([0-9a-f]{64})\/header$/))) return [200, await node.rpc('getblockheader', m[1], false)]
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})$/))) return c.txs.has(m[1]) ? [200, esploraTx(c, m[1])] : [404, 'Transaction not found']
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return c.txs.has(m[1]) ? [200, c.txs.get(m[1]).status] : [404, 'Transaction not found']
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) return c.txs.has(m[1]) ? [200, c.txs.get(m[1]).t.hex] : [404, 'Transaction not found']
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/raw$/))) return c.txs.has(m[1]) ? [200, Buffer.from(c.txs.get(m[1]).t.hex, 'hex')] : [404, 'Transaction not found']
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) {
      const s = c.spends.get(m[1] + ':' + m[2])
      return [200, s ? { spent: true, txid: s.txid, vin: s.vin, status: c.txs.get(s.txid).status } : { spent: false }]
    }
    if ((m = p.match(/^\/address\/([^/]+)\/txs$/))) return [200, history(c, c.byAddr.get(m[1]))]
    if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/txs$/))) return [200, history(c, c.byScript.get(m[1])).slice(0, 25)]
    if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/txs\/chain\/([0-9a-f]{64})$/))) {
      const all = history(c, c.byScript.get(m[1])).filter((t) => t.status.confirmed)
      const at = all.findIndex((t) => t.txid === m[2])
      return [200, at < 0 ? [] : all.slice(at + 1, at + 26)]
    }
    if ((m = p.match(/^\/scripthash\/([0-9a-f]{64})\/utxo$/))) {
      const out = []
      for (const id of c.byScript.get(m[1]) || []) {
        const { t, status } = c.txs.get(id)
        t.vout.forEach((o, n) => {
          if (createHash('sha256').update(Buffer.from(o.scriptPubKey.hex, 'hex')).digest('hex') !== m[1]) return
          if (c.spends.has(id + ':' + n)) return
          out.push({ txid: id, vout: n, value: atoms(o.value), asset: o.asset, status })
        })
      }
      return [200, out]
    }
    return [404, 'not in this shim: ' + p]
  }
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', async () => {
      try {
        const [code, val] = await handle(req, body)
        const isBuf = Buffer.isBuffer(val)
        res.writeHead(code, { 'Content-Type': isBuf ? 'application/octet-stream' : typeof val === 'string' ? 'text/plain' : 'application/json',
          'Access-Control-Allow-Origin': '*' })
        res.end(isBuf || typeof val === 'string' ? val : JSON.stringify(val))
      } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)) }
    })
  })
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/api` })))
}

// ------------------------------------------------------------------ the wallet
// The page's wallet, as index.html builds it: a signer and a Wollet on the
// slip77 wpkh descriptor, an EsploraClient, and broadcasts that teach the
// wollet what it spent.
async function wallet(node, esploraUrl) {
  const policy = (await node.rpc('getsidechaininfo')).pegged_asset
  const genesis = await node.rpc('getblockhash', 0)
  const network = lwk.Network.regtestWithGenesis(new lwk.AssetId(policy), genesis)
  const signer = new lwk.Signer(new lwk.Mnemonic(MNEMONIC), network)
  const wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, esploraUrl, false, 1, false)
  const W = { network, signer, wollet, client, policy, store: new Map() }
  W.sync = async () => { const u = await client.fullScan(wollet); if (u) wollet.applyUpdate(u) }
  W.broadcast = async (rawHex) => {
    const tx = new lwk.Transaction(rawHex)
    const t = await client.broadcastTx(tx)
    try { wollet.applyTransaction(tx) } catch {}
    return t.toString()
  }
  W.address = () => wollet.address(undefined).address().toUnconfidential().toString()
  const storage = {
    getItem: (k) => W.store.has(k) ? W.store.get(k) : null,
    setItem: (k, v) => W.store.set(k, String(v)),
    removeItem: (k) => W.store.delete(k),
  }
  W.ctx = (over = {}) => ({
    lwk, network,
    mnemonic: () => MNEMONIC,
    stakerPublicKey: () => signer.stakerPublicKey(),
    stakerScript: () => '0014' + hex(createHash('ripemd160').update(sha256(Buffer.from(signer.stakerPublicKey(), 'hex'))).digest()),
    esplora: (path) => fetch(esploraUrl + path),
    broadcast: W.broadcast,
    signAuthorization: async (pubkey, atoms) => {
      const pset = network.txBuilder().addRecordAuthorization(pubkey, atoms).feeRate(FEE_RATE).finish(wollet)
      const tx = wollet.finalize(signer.sign(pset)).extractTx()
      return { hex: tx.toString(), txid: tx.txid().toString(), fee: BigInt(tx.fee(network.policyAsset())) }
    },
    walletTxs: () => wollet.transactions().map((t) => ({ txid: t.txid().toString(), hex: t.tx().toString(), height: t.height() ?? null })),
    tipHeight: () => node.tip(),
    recordsV2Height: 1,
    feeRate: FEE_RATE,
    hints: () => [[], []],
    anchorHeightOf: async (hash) => (await node.rpc('getblockheader', hash)).anchorheight,
    spendAnchorHeight: async () => (await node.rpc('getblockheader', await node.rpc('getbestblockhash'))).anchorheight,
    unbondDepth: UNBOND_DEPTH,
    store: storage,
    stakesKey: 'swk.sequentia.stakes',
    ...over,
  })
  return W
}

// Fund the wallet from the genesis output (anyone-can-spend), while the node
// still accepts non-standard transactions; then it is restarted on its
// default relay policy, under which everything after must relay.
async function fund(node, W, producer) {
  await node.produce(producer.wif)
  const g = await node.rpc('getblock', await node.rpc('getblockhash', 0), 2)
  let src = null
  for (const t of g.tx) t.vout.forEach((o, n) => { if (!src && o.scriptPubKey.hex === '51' && o.value > 0) src = { txid: t.txid, vout: n, value: o.value } })
  const a0 = W.wollet.address(0).address().toUnconfidential().toString()
  const a1 = W.wollet.address(1).address().toUnconfidential().toString()
  const raw = await node.rpc('createrawtransaction', [{ txid: src.txid, vout: src.vout }],
    [{ [a0]: 1000 }, { [a1]: Number((src.value - 1000 - 0.001).toFixed(8)) }, { fee: 0.001 }])
  const id = await node.rpc('sendrawtransaction', raw)
  const b = await node.produce(producer.wif)
  if (!b.tx.includes(id)) throw new Error('funding not mined')
  await node.stop(); await node.start()
  await W.sync()
}

async function vsize(node, txid) { return (await node.rpc('getrawtransaction', txid, true)).vsize }
async function inBlock(node, producer, ids, what) {
  const b = await node.produce(producer.wif)
  const all = ids.every((id) => b.tx.includes(id))
  check(all, `${what}: ${ids.join(' + ')} in block ${b.height}`)
  return b.height
}

// The page's bond: TxBuilder.addStakeOutput on the wallet's PSET path.
async function bond(node, W, producer, atoms) {
  const pub = W.signer.stakerPublicKey()
  const pset = W.network.txBuilder().addStakeOutput(pub, UNBONDING, atoms).feeRate(FEE_RATE).finish(W.wollet)
  const tx = W.wollet.finalize(W.signer.sign(pset)).extractTx()
  const txid = await W.broadcast(tx.toString())
  const ctx = W.ctx()
  const stakes = JSON.parse(ctx.store.getItem(ctx.stakesKey) || '[]')
  stakes.push({ pubkey: pub, csv: UNBONDING, period: 'test', atoms: atoms.toString(), txid, time: Date.now() })
  ctx.store.setItem(ctx.stakesKey, JSON.stringify(stakes))
  await inBlock(node, producer, [txid], 'bond')
  return txid
}

// ------------------------------------------------------------------ run 1
async function recordsFromBlockOne() {
  log('\n== records from block one ==')
  const producer = randomKey()
  const parent = await parentChain('block-one')
  const node = new Node('block-one', chainArgs(producer.pub, parent))
  await node.start(['-acceptnonstdtxn=1'])
  const { srv, url } = await shim(node)
  try {
    const W = await wallet(node, url)
    await fund(node, W, producer)
    const me = W.signer.stakerPublicKey()
    const P = randomKey().pub, Q = randomKey().pub
    const sizes = {}

    const bondTxid = await bond(node, W, producer, 50n * COIN)
    check(JSON.stringify((await node.rpc('getstakerinfo', false, true))[me]) === JSON.stringify(Number(50n * COIN)), 'node counts the bond as stake')

    // --- join: the authorising payment and the record, mined together
    const ctx = W.ctx()
    await refused(SR.prepareJoin(W.ctx({ tipHeight: async () => 0 }), P), /could not read the chain tip/, 'join with no chain tip is refused')
    const p = await SR.prepareJoin(ctx, P)
    const j = await SR.commitJoin(ctx, p)
    check(j.authTxid === p.authTxid && j.createTxid === p.createTxid, 'both broadcast as built')
    await inBlock(node, producer, [j.authTxid, j.createTxid], 'join (payment + record)')
    sizes.authorization = await vsize(node, j.authTxid); sizes.create = await vsize(node, j.createTxid)
    check((await node.rpc('getdelegationinfo'))[me] === P, 'node: delegated to P')
    check(await SR.resumeJoin(ctx) === 'confirmed', 'the join in flight is retired once confirmed')
    await W.sync()

    // --- find it with nothing to probe: only the staking key's P2WPKH history
    let d = await SR.findDelegation(W.ctx({ hints: () => [[], []] }))
    check(d && d.signer === P && d.txid === j.createTxid && d.confirmed, 'found through the staking key history, no hints, no board')

    // --- move
    await refused(SR.buildMove(W.ctx({ tipHeight: async () => 0 }), d, Q), /could not read the chain tip/, 'move with no chain tip is refused')
    const mv = await SR.buildMove(ctx, d, Q)
    check(mv.signing === 'segwitV0', 'move signed ' + mv.signing)
    await W.broadcast(mv.rawHex)
    await inBlock(node, producer, [mv.txid], 'move')
    sizes.move = await vsize(node, mv.txid)
    check((await node.rpc('getdelegationinfo'))[me] === Q, 'node: delegated to Q')
    d = await SR.findDelegation(W.ctx({ hints: () => [[Q], []] }))
    check(d && d.signer === Q && d.txid === mv.txid, 'the moved record is found by the probe for Q')
    const none = await SR.findDelegation(W.ctx({ hints: () => [[], []] }))
    check(none === null, 'with no signer to probe, the spent record from the key history is not taken for live')

    // --- leave
    const lv = await SR.buildLeave(ctx, d, W.address())
    check(lv.signing === 'segwitV0', 'leave signed ' + lv.signing)
    await W.broadcast(lv.rawHex)
    await inBlock(node, producer, [lv.txid], 'leave')
    sizes.leave = await vsize(node, lv.txid)
    check(!(me in (await node.rpc('getdelegationinfo'))), 'node: no delegation')
    check(await SR.findDelegation(W.ctx({ hints: () => [[P, Q], []] })) === null, 'nothing live after leaving')
    await W.sync()

    // --- a join whose tab closed between its two broadcasts
    const p2 = await SR.prepareJoin(ctx, P)
    ctx.store.setItem(SR.PENDING_JOIN_KEY, JSON.stringify({ signer: P, authHex: p2.authHex, authTxid: p2.authTxid,
      createHex: p2.createHex, createTxid: p2.createTxid, time: Date.now() }))
    await W.broadcast(p2.authHex)                   // ... and the tab closes here
    d = await SR.findDelegation(W.ctx({ hints: () => [[], []] }))
    check(d === null, 'a stored record no node has seen is not shown as a delegation')
    check(await SR.resumeJoin(ctx) === 'rebroadcast', 'reload: the record is broadcast')
    d = await SR.findDelegation(W.ctx({ hints: () => [[], []] }))
    check(d && d.txid === p2.createTxid && d.signer === P && !d.confirmed, 'then shown, waiting to confirm')
    await inBlock(node, producer, [p2.authTxid, p2.createTxid], 'resumed join')
    check((await node.rpc('getdelegationinfo'))[me] === P, 'node: delegated to P again')
    const lv2 = await SR.buildLeave(ctx, await SR.findDelegation(ctx), W.address())
    await W.broadcast(lv2.rawHex)
    await inBlock(node, producer, [lv2.txid], 'leave again')
    await W.sync()

    // --- unbond
    const entry = () => JSON.parse(ctx.store.getItem(ctx.stakesKey))[0]
    let s = await SR.stakeState(ctx, entry(), await node.tip())
    log('  stake state: ' + s.state + (s.maturesAt ? ' (matures at ' + s.maturesAt + ')' : ''))
    while (s.state === 'bonded') { await node.produce(producer.wif); s = await SR.stakeState(ctx, entry(), await node.tip()) }
    check(s.state === 'unbondable', 'stake unbondable at tip ' + await node.tip())
    const ub = await SR.buildUnbond(ctx, s)
    check(ub.signing === 'segwitV0', 'unbond signed ' + ub.signing)
    const ubTxid = await SR.broadcastStep(ctx, bondTxid, 'unbond', ub)
    const ubHeight = await inBlock(node, producer, [ubTxid], 'unbond')
    sizes.unbond = await vsize(node, ubTxid)
    check(!(me in (await node.rpc('getstakerinfo', false, true))), 'node: no longer staked')
    s = await SR.stakeState(ctx, entry(), await node.tip())
    const ubAnchor = (await node.rpc('getblockheader', await node.rpc('getblockhash', ubHeight))).anchorheight
    check(s.state === 'unbonding' && s.claimableAt === ubAnchor + UNBOND_DEPTH, `unbonding: unbond anchored at parent ${ubAnchor}, claimable once the tip is anchored at ${s.claimableAt}`)

    // --- a claim before the depth: the module will not build it, and the node refuses it
    await refused(SR.buildClaim(ctx, s, W.address()), /cannot be claimed yet/, 'claim before the depth, wallet')
    const early = await SR.buildClaim(ctx, { ...s, state: 'claimable' }, W.address())
    await refused(W.broadcast(early.rawHex), /bad-unbond-premature/, 'claim before the depth, node')

    while (s.state === 'unbonding') {
      await advanceParent(parent); await node.produce(producer.wif)
      s = await SR.stakeState(ctx, entry(), await node.tip())
      log(`  parent advanced: tip anchored at ${s.spendAnchor}, claimable at ${s.claimableAt}: ${s.state}`)
    }
    check(s.state === 'claimable', 'claimable at tip ' + await node.tip())
    const cl = await SR.buildClaim(ctx, s, W.address())
    check(cl.signing === 'segwitV0', 'claim signed ' + cl.signing)
    const clTxid = await SR.broadcastStep(ctx, bondTxid, 'claim', cl)
    await inBlock(node, producer, [clTxid], 'claim')
    sizes.claim = await vsize(node, clTxid)
    s = await SR.stakeState(ctx, entry(), await node.tip())
    check(s.state === 'claimed', 'stake state claimed')
    await W.sync()
    const u = W.wollet.utxos().find((x) => x.outpoint().txid().toString() === clTxid)
    check(!!u, 'the claimed coins are in the wallet')

    log('  measured vsize: ' + JSON.stringify(sizes) + '  budget: ' + JSON.stringify(SR.VBYTES))
    for (const k of ['create', 'move', 'leave', 'unbond', 'claim'])
      check(sizes[k] <= SR.VBYTES[k], `${k} ${sizes[k]} vB within its fee budget of ${SR.VBYTES[k]}`)
  } finally { srv.close(); await node.stop(); await parent.stop() }
}

// ------------------------------------------------------------------ run 2
async function acrossTheForkHeight() {
  const FORK = 20
  log(`\n== the signature changing at height ${FORK} ==`)
  const producer = randomKey()
  const parent = await parentChain('fork')
  const node = new Node('fork', chainArgs(producer.pub, parent, [`-posrecordsv2height=${FORK}`, `-poshardeningheight=${FORK}`]))
  await node.start(['-acceptnonstdtxn=1'])
  const { srv, url } = await shim(node)
  try {
    const W = await wallet(node, url)
    await fund(node, W, producer)
    const me = W.signer.stakerPublicKey()
    const P = randomKey().pub, Q = randomKey().pub
    const ctx = W.ctx({ recordsV2Height: FORK, hints: () => [[P, Q], []] })

    // A record paid for by wallet coins, as wallets made them before the fork.
    const old = W.wollet.finalize(W.signer.sign(W.network.txBuilder().addDelegationOutput(me, P, SR.RECORD_ATOMS).feeRate(FEE_RATE).finish(W.wollet))).extractTx()
    const oldTxid = await W.broadcast(old.toString())
    await inBlock(node, producer, [oldTxid], `record from wallet coins at height ${await node.tip() + 1}`)
    let d = await SR.findDelegation(W.ctx({ recordsV2Height: FORK, hints: () => [[], []] }))
    check(d && d.txid === oldTxid && d.signer === P, 'found through the wallet history, no hints, no board')
    const mv = await SR.buildMove(ctx, d, Q)
    check(mv.signing === 'legacy', `move built at tip ${await node.tip()} signed ${mv.signing}`)
    await W.broadcast(mv.rawHex)
    await inBlock(node, producer, [mv.txid], 'legacy move')

    while (await node.tip() < FORK - 2) await node.produce(producer.wif)
    d = await SR.findDelegation(ctx)

    // Built at FORK-2 for block FORK-1: the legacy signature.
    const stale = await SR.buildLeave(ctx, d, W.address())
    check(stale.signing === 'legacy', `leave built at tip ${await node.tip()} signed legacy`)

    // The module reads the tip again after building; a block that crosses the
    // height in between makes it build again.
    let calls = 0
    const crossing = W.ctx({ recordsV2Height: FORK, tipHeight: async () => {
      calls++
      if (calls === 2) await node.produce(producer.wif)   // a block arrives while the spend is being built
      return node.tip()
    } })
    const fresh = await SR.buildLeave(crossing, d, W.address())
    check(fresh.signing === 'segwitV0' && calls >= 3, `rebuilt after a block crossed the height: ${fresh.signing}, tip read ${calls} times`)

    // At FORK-1 the next block is FORK, where the legacy signature is refused.
    check(await node.tip() === FORK - 1, 'tip at ' + (FORK - 1))
    await refused(W.broadcast(stale.rawHex), /Signature must be zero|script-verify/, `the legacy spend built a block earlier, at tip ${FORK - 1}`)
    await W.broadcast(fresh.rawHex)
    await inBlock(node, producer, [fresh.txid], 'second-generation leave')
    check(!(me in (await node.rpc('getdelegationinfo'))), 'node: no delegation')

    // Past the fork, wallet coins alone no longer make a record.
    await W.sync()
    const late = W.wollet.finalize(W.signer.sign(W.network.txBuilder().addDelegationOutput(me, P, SR.RECORD_ATOMS).feeRate(FEE_RATE).finish(W.wollet))).extractTx()
    await refused(W.broadcast(late.toString()), /bad-delegation-unauthorized/, 'a record from wallet coins after the fork')
  } finally { srv.close(); await node.stop(); await parent.stop() }
}

await init({ module_or_path: readFileSync(join(root, 'pkg/lwk_wasm_bg.wasm')) })
try {
  await recordsFromBlockOne()
  await acrossTheForkHeight()
} catch (e) { failures++; log('FAIL (aborted): ' + (e?.stack ?? e)) }
if (!process.argv[2]) rmSync(WORK, { recursive: true, force: true })
log(failures ? `\n${failures} failure(s)` : '\nall passed')
process.exit(failures ? 1 : 0)
