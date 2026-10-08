#!/usr/bin/env node
// Drives developer mode's Contracts tab (contracts.js) in headless Chromium against a
// private regtest chain: a faucet drip covenant whose faucet key is this wallet's
// contract key. The page recomputes the covenant's address, finds its coin, and
// prepares a drip; the approval screen shows the template, the path, the parameters
// by role and the wallet's balance change, and the drip is signed from that screen and
// confirms. Then the screen shows, in the engine's words, a second drip asked for
// before the interval, a drip above the tier, and a request whose successor is not the
// covenant, each refused before anything is signed. (lwk_contracts' own regtest test
// in SWK forces each of these into a block.)
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src node tooling/contracts-regtest.mjs [evidence-dir]
//
// Needs pkg/ built from SWK with the contract engine, and a Chromium (CHROMIUM=…). It
// serves this checkout and, behind the same origin, the Esplora calls the tab makes
// (/api/…, answered from the node's RPC) and a registry index naming the covenant's
// template (/registry/…, as the registry lists a verified template). Every directory
// it makes is removed at the end.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { Page } from './cdp-page.mjs'

const BIN = process.env.SEQUENTIA_BIN
if (!BIN) { console.log('skipped: set SEQUENTIA_BIN'); process.exit(0) }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = process.argv[2] || null
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })

// A public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean'
const TREASURY_KEY = '561012804a5e7c56565fe7a04c58b7ad2209699c1cf683e0a2a1367a42d7483c'
const DRIP = '12986f202fbfb850f7699c5d5188f261f276de6c7038142f0a28bbb672b5af34'
const COIN = 100000000n
const hexw = (n, w) => BigInt(n).toString(16).padStart(w, '0')
const log = []
let failures = 0
const ok = (cond, what) => { log.push((cond ? 'ok   ' : 'FAIL ') + what); console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++ }

const dir = mkdtempSync(join(tmpdir(), 'wallet-contracts-'))
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const [p2p, rpcport] = [await free(), await free()]
writeFileSync(join(dir, 'elements.conf'), ['chain=elementsregtest', '[elementsregtest]', 'server=1', 'listen=0', `port=${p2p}`, `rpcport=${rpcport}`,
  'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', 'rpcuser=drive', 'rpcpassword=drive', 'initialfreecoins=2100000000000000', 'anyonecanspendaremine=1',
  'blindedaddresses=0', 'con_default_blinded_addresses=0', 'validatepegin=0', 'con_parent_chain_signblockscript=51', 'con_any_asset_fees=1',
  'evbparams=simplicity:-1:::', 'par=1', 'txindex=1', 'fallbackfee=0.0001', 'maxtxfee=100', ''].join('\n'))
const node = spawn(join(BIN, 'sequentiad'), [`-datadir=${dir}`], { stdio: 'ignore' })
const cli = (...a) => execFileSync(join(BIN, 'sequentia-cli'), [`-datadir=${dir}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const json = (...a) => JSON.parse(cli(...a))
async function rpc (method, params = []) {
  const r = await fetch(`http://127.0.0.1:${rpcport}/`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('drive:drive').toString('base64') }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) })
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result
}

let page = null; let server = null
async function cleanup () {
  try { if (page) { await page.stop(); if (page.dir) rmSync(page.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } } catch {}
  try { if (server) server.close() } catch {}
  try { cli('stop') } catch { node.kill() }
  await new Promise((r) => node.exitCode !== null ? r() : node.once('exit', r))
  rmSync(dir, { recursive: true, force: true })
}

try {
  for (let i = 0; ; i++) { try { cli('getblockchaininfo'); break } catch { if (i > 240) throw new Error('the node did not start'); await new Promise(r => setTimeout(r, 500)) } }
  cli('createwallet', 'treasury')
  const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'))
  mine(101); cli('rescanblockchain')
  cli('-named', 'sendtoaddress', `address=${cli('getnewaddress')}`, 'amount=1000000', 'fee_asset_label=bitcoin'); mine(1)
  const policy = json('getsidechaininfo').pegged_asset
  const genesis = cli('getblockhash', '0')
  const advance = (secs) => { const t = json('getblockheader', cli('getbestblockhash')).time; cli('setmocktime', String(t + secs + 60)); mine(12) }

  // The page's backends, behind one origin.
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }
  const registryIndex = { leaves: { '5251ec00d9799dbcdb31da4534f25ef9960321f195e2e24ef7125c46f24b972a': [[DRIP, 'sequentia/faucet-drip', 1, 'drip', 'drip']] }, scripts: {} }
  server = createServer(async (req, res) => {
    const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body) }
    const u = new URL(req.url, 'http://x'); const p = u.pathname; let m
    try {
      if (p === '/registry/contracts/index.minimal.json') return send(200, JSON.stringify(registryIndex), 'application/json')
      if (p.startsWith('/api/')) {
        const a = p.slice(4)
        if (req.method === 'POST' && a === '/tx') {
          const body = await new Promise((ok) => { let b = ''; req.on('data', d => { b += d }); req.on('end', () => ok(b)) })
          try { return send(200, await rpc('sendrawtransaction', [body.trim()])) } catch (e) { return send(400, 'sendrawtransaction RPC error: ' + e.message) }
        }
        if (a === '/blocks/tip/hash') return send(200, await rpc('getbestblockhash'))
        if ((m = a.match(/^\/block\/([0-9a-f]{64})$/))) { const h = await rpc('getblockheader', [m[1]]); return send(200, JSON.stringify({ id: h.hash, height: h.height, mediantime: h.mediantime, timestamp: h.time }), 'application/json') }
        if ((m = a.match(/^\/block-height\/(\d+)$/))) return send(200, await rpc('getblockhash', [Number(m[1])]))
        if ((m = a.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
          const t = await rpc('getrawtransaction', [m[1], true])
          if (!t.blockhash) return send(200, JSON.stringify({ confirmed: false }), 'application/json')
          const h = await rpc('getblockheader', [t.blockhash])
          return send(200, JSON.stringify({ confirmed: true, block_height: h.height, block_hash: h.hash }), 'application/json')
        }
        if ((m = a.match(/^\/address\/([^/]+)\/utxo$/))) {
          const s = await rpc('scantxoutset', ['start', [`addr(${m[1]})`]])
          return send(200, JSON.stringify(s.unspents.map(x => ({ txid: x.txid, vout: x.vout, value: Math.round(x.amount * 1e8), asset: x.asset, status: { confirmed: x.height > 0, block_height: x.height } }))), 'application/json')
        }
        return send(404, 'not served here')
      }
      const f = join(root, decodeURIComponent(p))
      if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) return send(404, 'not found')
      return send(200, readFileSync(f), types[extname(f)] || 'application/octet-stream')
    } catch (e) { return send(500, String(e.message || e)) }
  })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  const origin = `http://127.0.0.1:${port}`

  page = new Page()
  await page.open()
  const assets = { [policy]: { ticker: 'tSEQ', precision: 8 } }
  await page.go(`${origin}/tooling/contracts-harness.html?` + new URLSearchParams({ policy, genesis, mnemonic: MNEMONIC, assets: JSON.stringify(assets) }))
  await page.waitFor('window.__ready === true', 60000)
  const text = (id) => page.eval(`(document.getElementById(${JSON.stringify(id)})||{}).innerText||''`)
  const click = async (id) => { await page.eval(`document.getElementById(${JSON.stringify(id)}).click()`); await new Promise(r => setTimeout(r, 300)) }
  const set = (id, v) => page.eval(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); return true})()`)
  const idle = (id) => page.waitFor(`!document.getElementById(${JSON.stringify(id)}).disabled`, 120000)
  const shot = async (name) => { if (EVIDENCE) await page.screenshot(join(EVIDENCE, name)) }

  // The template, from the kit.
  await set('contractTemplate', DRIP); await click('contractUseTemplate')
  ok((await text('contractTemplateOut')).includes('sequentia/faucet-drip v1'), 'the kit\'s faucet drip template is read and described')
  const walletKey = await page.eval("window.__wallet.signer.xonlyPublicKeyAt(\"m/8383h/1h/0h/0/0\")")
  ok((await text('contractTemplateOut')).includes(walletKey), 'the page shows this wallet\'s contract key, ' + walletKey)

  // The instance: this wallet's contract key is the faucet key.
  const params = { ASSET: Buffer.from(policy, 'hex').reverse().toString('hex'), FAUCET_KEY: walletKey, TREASURY_KEY, INTERVAL: '0001', FEE_CAP: hexw(100000, 16), RECOVERY_DELAY: hexw((1 << 22) | 2, 8) }
  const tiers = [1000000n, 500n, 100000n, 200n, 10000n, 20n, 2n].map(n => n * COIN)
  ;['TIER1_FLOOR', 'TIER1_MAX', 'TIER2_FLOOR', 'TIER2_MAX', 'TIER3_FLOOR', 'TIER3_MAX', 'TIER4_MAX'].forEach((k, i) => { params[k] = hexw(tiers[i], 16) })
  await set('contractInstance', JSON.stringify({ instance: 2, template_hash: DRIP, params, slots: {}, genesis }, null, 1))
  await click('contractRecompute'); await idle('contractRecompute')
  const out = await text('contractInstanceOut')
  const address = (out.match(/address (\S+)/) || [])[1]
  const script = (out.match(/script ([0-9a-f]+)/) || [])[1]
  ok(address && json('getaddressinfo', address).scriptPubKey === script, `the page's address ${address} is the node's for script ${script}`)

  // The treasury funds it; the interval passes.
  const fund = cli('-named', 'sendtoaddress', `address=${address}`, 'amount=2000000', 'fee_asset_label=bitcoin'); mine(1)
  await click('contractFindCoins'); await idle('contractFindCoins')
  ok((await page.eval("document.getElementById('contractCoin').options.length")) === 1, 'the page finds the covenant\'s coin ' + fund.slice(0, 16) + '…')
  await set('contractPath', 'drip')
  ok(!(await page.eval("document.getElementById('contractDripForm').classList.contains('hide')")), 'the drip form shows for the drip path')
  const receive = await page.eval('window.__wallet.receive')
  ok((await page.eval("document.getElementById('contractDripTo').value")) === receive, 'the drip pays this wallet by default: ' + receive)

  // Too early: refused before signing, in the engine's words.
  await set('contractDripAmount', String(500n * COIN)); await set('contractDripRate', '1000')
  await click('contractReview'); await idle('contractReview')
  let err = await text('contractError')
  ok(err.includes('non-BIP68-final') && (await page.eval("document.getElementById('contractApproval').classList.contains('hide')")), 'a drip before the interval is refused, no approval shown: ' + err)
  await shot('contracts-01-too-early.png')

  // The drip: the approval screen, then signed from it.
  advance(512)
  await click('contractReview'); await idle('contractReview')
  err = await text('contractError')
  ok(!err, 'the drip is prepared' + (err ? ': ' + err : ''))
  const screen = await text('contractApproval')
  for (const want of ['Sign this contract spend?', 'sequentia/faucet-drip v1 (registered)', 'drip (simplicity leaf drip)', 'the holder of FAUCET_KEY',
    'Dripped asset [asset]', 'tSEQ (' + policy + ')', 'Faucet key [pubkey]', 'this wallet\'s contract key, m/8383h/1h/0h/0/0',
    'Tier 1: a drip pays at most [amount]', '500.00000000 tSEQ', 'Recovery delay [sequence]', '2 × 512 s = 1024 s',
    'Your balance change', 'This wallet', '-500.00000', 'Network fee', 'the program ran against the final transaction', 'is this wallet\'s contract key at m/8383h/1h/0h/0/0']) {
    ok(screen.toLowerCase().includes(want.toLowerCase()), 'the approval shows: ' + want)
  }
  await shot('contracts-02-approval.png')
  const shownDigest = (screen.match(/it signs digest ([0-9a-f]{64})/) || [])[1]
  ok(!!shownDigest, 'the approval shows the digest it signs: ' + shownDigest)
  await click('contractSign'); await page.waitFor("document.getElementById('contractDone').textContent.startsWith('Broadcast')", 60000)
  const txid = (await text('contractDone')).replace('Broadcast ', '').trim()
  mine(1)
  const conf = json('getrawtransaction', txid, 'true')
  ok(conf.confirmations >= 1, `the drip ${txid} confirmed in a block, ${conf.vsize} vB`)
  const paid = conf.vout.find(o => o.scriptPubKey && o.scriptPubKey.address === receive)
  ok(paid && Math.round(paid.value * 1e8) === Number(500n * COIN), 'it paid this wallet 500 tSEQ')
  await shot('contracts-03-broadcast.png')

  // A second drip at once: refused before signing.
  await click('contractFindCoins'); await idle('contractFindCoins')
  await click('contractReview'); await idle('contractReview')
  err = await text('contractError')
  ok(err.includes('non-BIP68-final'), 'a second drip before the interval is refused: ' + err)
  advance(512)
  // Above the tier.
  await set('contractDripAmount', String(500n * COIN + 1n))
  await click('contractReview'); await idle('contractReview')
  err = await text('contractError')
  ok(err.includes('is above the 50000000000 a reserve'), 'a drip above the tier is refused: ' + err)
  await shot('contracts-04-above-tier.png')
  // A successor that is not the covenant, written by hand.
  const coin = await page.eval('JSON.stringify(window.__contracts.state.coins[0].coin)')
  await page.eval("(()=>{const b=document.getElementById('contractByHand'); b.checked=true; b.dispatchEvent(new Event('change'))})()")
  const c = JSON.parse(coin)
  const req = { path: 'drip', coin: c, sequence: (1 << 22) | 1, outputs: [
    { to: 'contract', address: receive, asset: c.asset, amount: c.amount - Number(500n * COIN) - 600 },
    { to: 'pay', address: receive, asset: c.asset, amount: Number(500n * COIN) },
    { to: 'fee', asset: c.asset, amount: 600 }] }
  await set('contractRequest', JSON.stringify(req))
  await click('contractReview'); await idle('contractReview')
  err = await text('contractError')
  ok(err.includes('is said to return to the contract, but pays the script'), 'a successor that is not the covenant is refused: ' + err)
  req.outputs[0].to = 'pay'
  await set('contractRequest', JSON.stringify(req))
  await click('contractReview'); await idle('contractReview')
  err = await text('contractError')
  ok(err.includes('the contract\'s program refuses this transaction') && err.includes('the check that fails is'), 'the same, named as a payment, is refused by the program run: ' + err)
  await shot('contracts-05-wrong-successor.png')
  ok(page.errors.length === 0, 'no page errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''))
} catch (e) {
  ok(false, 'the drive stopped: ' + (e.stack || e))
} finally {
  if (EVIDENCE) writeFileSync(join(EVIDENCE, 'contracts-drive.log'), log.join('\n') + '\n')
  await cleanup()
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
