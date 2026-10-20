#!/usr/bin/env node
// Drives developer mode's Contracts tab (contracts.js) in headless Chromium through a
// Pignus version 2 loan on a private regtest chain: the take of an offer, which opens
// a vault this wallet borrows under; a top-up; a repayment in part. Each request is
// written by hand in the tab with "Fund it from this wallet" ticked, so the wallet
// adds its own coins and the change; the kit's contract engine checks every wallet
// input against the wallet's own record (synced from the chain), runs the program,
// and the approval screen shows the five points, every input by what it is, the
// vault the take opens and the wallet's balance change. Each spend is signed from
// that screen and confirms. Refused in the tab, in the engine's words: a wallet input
// said to be in another asset than the wallet's record of it. (SWK's
// lwk_contracts/tests/vault_regtest.rs makes the same spends natively, with a
// liquidation spending the oracle's beacon coin, and forces the negatives into
// blocks.)
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src node tooling/contracts-vault-regtest.mjs [evidence-dir]
//
// Needs pkg/ built from SWK with the contract engine's wallet inputs, and a Chromium
// (CHROMIUM=…). The chain is anchored to a regtest parent chain run by the same binary,
// since the kit reads Sequentia's anchored block headers. The drive serves this
// checkout and, behind the same origin, an Esplora API over the node
// (tooling/esplora-shim.mjs). Every directory it makes is removed at
// the end.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { Page } from './cdp-page.mjs'
import { startEsploraShim } from './esplora-shim.mjs'

const BIN = process.env.SEQUENTIA_BIN
if (!BIN) { console.log('skipped: set SEQUENTIA_BIN'); process.exit(0) }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = process.argv[2] || null
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })

// A public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean'
const OFFER_T = '4e999cdc9efa1186c0876ce9ebcc8e6dac60c10885bfb2cb5dce9489840084e7'
const VAULT_T = '6b17869c4e2abe782fe3d8a3ece4865b8f0aa483028b1d0a815e6bcb4e8939ac'
const COIN = 100000000
const LOT = 10 * COIN; const DEBT = 1050000000; const COLLATERAL = 10 * COIN; const FEE = 2000
const hexw = (n, w) => BigInt(n).toString(16).padStart(2 * w, '0')
const rev = (h) => Buffer.from(h, 'hex').reverse().toString('hex')
const sha = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const log = []
let failures = 0
const ok = (cond, what) => { log.push((cond ? 'ok   ' : 'FAIL ') + what); console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++ }

const dir = mkdtempSync(join(tmpdir(), 'wallet-vault-'))
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const [p2p, rpcport, pp2p, prpc] = [await free(), await free(), await free(), await free()]
// The parent chain: the kit reads Sequentia's block headers, which carry a Bitcoin
// anchor, so the chain is anchored to a regtest parent (the same binary, in Bitcoin mode).
mkdirSync(join(dir, 'parent'))
const parent = spawn(join(BIN, 'sequentiad'), [`-datadir=${join(dir, 'parent')}`, '-chain=regtest', `-port=${pp2p}`, `-rpcport=${prpc}`, '-listen=0', '-server',
  '-rpcuser=drive', '-rpcpassword=drive', '-disablewallet'], { stdio: 'ignore' })
const pcli = (...a) => execFileSync(join(BIN, 'sequentia-cli'), [`-datadir=${join(dir, 'parent')}`, '-chain=regtest', `-rpcport=${prpc}`, '-rpcuser=drive', '-rpcpassword=drive', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
for (let i = 0; ; i++) { try { pcli('getblockcount'); break } catch { if (i > 240) throw new Error('the parent did not start'); await new Promise(r => setTimeout(r, 500)) } }
pcli('generatetodescriptor', '5', JSON.parse(pcli('getdescriptorinfo', 'raw(51)')).descriptor)
writeFileSync(join(dir, 'elements.conf'), ['chain=elementsregtest', '[elementsregtest]', 'server=1', 'listen=0', `port=${p2p}`, `rpcport=${rpcport}`,
  'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', 'rpcuser=drive', 'rpcpassword=drive', 'initialfreecoins=2100000000000000', 'anyonecanspendaremine=1',
  'blindedaddresses=0', 'con_default_blinded_addresses=0', 'validatepegin=0', 'con_parent_chain_signblockscript=51', 'con_any_asset_fees=1',
  'evbparams=simplicity:-1:::', 'par=1', 'txindex=1', 'fallbackfee=0.0001', 'maxtxfee=100',
  'con_bitcoin_anchor=1', 'validateanchor=1', 'mainchainrpchost=127.0.0.1', `mainchainrpcport=${prpc}`, 'mainchainrpcuser=drive', 'mainchainrpcpassword=drive',
  'parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206', 'anchorpollinterval=1', 'anchorminconf=1', ''].join('\n'))
const node = spawn(join(BIN, 'sequentiad'), [`-datadir=${dir}`], { stdio: 'ignore' })
const cli = (...a) => execFileSync(join(BIN, 'sequentia-cli'), [`-datadir=${dir}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const json = (...a) => JSON.parse(cli(...a))

let page = null; let server = null; let shim = null
async function cleanup () {
  try { if (page) { await page.stop(); page.remove() } } catch {}
  try { if (server) server.close() } catch {}
  try { if (shim) await shim.close() } catch {}
  try { cli('stop') } catch { node.kill() }
  await new Promise((r) => node.exitCode !== null ? r() : node.once('exit', r))
  try { pcli('stop') } catch { parent.kill() }
  await new Promise((r) => parent.exitCode !== null ? r() : parent.once('exit', r))
  rmSync(dir, { recursive: true, force: true })
}

try {
  for (let i = 0; ; i++) { try { cli('getblockchaininfo'); break } catch { if (i > 240) throw new Error('the node did not start'); await new Promise(r => setTimeout(r, 500)) } }
  await new Promise(r => setTimeout(r, 2000))   // the anchor watcher's first look at the parent
  cli('createwallet', 'lender')
  const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'))
  mine(101); cli('rescanblockchain')
  const policy = json('getsidechaininfo').pegged_asset
  const genesis = cli('getblockhash', '0')
  const issue = () => { const a = json('-named', 'issueasset', 'assetamount=1000', 'tokenamount=0', 'blind=false', 'fee_asset=bitcoin').asset; mine(1); return a }
  const X = issue(); const Y = issue()
  const rates = json('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN
  cli('setfeeexchangerates', JSON.stringify(rates))
  cli('setmocktime', String(json('getblockheader', cli('getbestblockhash')).time + 60)); mine(12)
  const mtp = () => json('getblockchaininfo').mediantime
  const send = (address, amount, asset) => cli('-named', 'sendtoaddress', `address=${address}`, `amount=${amount}`, `assetlabel=${asset}`, 'fee_asset_label=bitcoin')

  shim = await startEsploraShim({ rpc: { url: `http://127.0.0.1:${rpcport}/`, auth: 'drive:drive' }, port: await free() })
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }
  server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname
    try {
      if (p.startsWith('/api/')) {
        const body = await new Promise((r) => { let b = ''; req.on('data', d => { b += d }); req.on('end', () => r(b)) })
        const r = await fetch(shim.url + p, { method: req.method, body: req.method === 'POST' ? body : undefined })
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'text/plain' }); return res.end(Buffer.from(await r.arrayBuffer()))
      }
      if (p.startsWith('/registry/')) { res.writeHead(404); return res.end('no registry here') }
      const f = join(root, decodeURIComponent(p))
      if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found') }
      res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
    } catch (e) { res.writeHead(500); res.end(String(e.message || e)) }
  })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  const origin = `http://127.0.0.1:${port}`

  page = new Page()
  await page.open()
  const assets = { [X]: { ticker: 'XCOL', precision: 8 }, [Y]: { ticker: 'YDEBT', precision: 8 }, [policy]: { ticker: 'tSEQ', precision: 8 } }
  await page.go(`${origin}/tooling/contracts-harness.html?` + new URLSearchParams({ policy, genesis, mnemonic: MNEMONIC, assets: JSON.stringify(assets) }))
  await page.waitFor('window.__ready === true', 60000)
  const text = (id) => page.eval(`(document.getElementById(${JSON.stringify(id)})||{}).innerText||''`)
  const click = async (id) => { await page.eval(`document.getElementById(${JSON.stringify(id)}).click()`); await new Promise(r => setTimeout(r, 300)) }
  const set = (id, v) => page.eval(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); return true})()`)
  const tick = (id, on) => page.eval(`(()=>{const b=document.getElementById(${JSON.stringify(id)}); b.checked=${on}; b.dispatchEvent(new Event('change')); return true})()`)
  const idle = (id) => page.waitFor(`!document.getElementById(${JSON.stringify(id)}).disabled`, 120000)
  const shot = async (name) => { if (EVIDENCE) await page.screenshot(join(EVIDENCE, name)) }

  // This wallet, funded at its own address, and synced.
  const receive = await page.eval('window.__wallet.receive')
  const meSpk = json('getaddressinfo', receive).scriptPubKey
  send(receive, 15, X); send(receive, 3, X); send(receive, 4, Y); mine(1)
  await page.eval('window.__sync()')
  const held = JSON.parse(await page.eval('window.__coins()'))
  ok(held.length === 3 && held.every((c) => c.key_path.startsWith('m/84h/') && !c.confidential), 'the wallet synced from the chain; its own record holds 3 explicit coins with their keys: ' + held.map((c) => c.key_path).join(', '))

  // The offer's terms.
  const lenderSpk = json('getaddressinfo', cli('getnewaddress', '', 'bech32')).scriptPubKey
  const now = mtp()
  const base = { COLL: rev(X), DEBT_ASSET: rev(Y), ORACLE: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', BEACON_ASSET: rev(policy), PRECISION: '08',
    LIQ_BP: hexw(12000, 4), TARGET_BP: hexw(15000, 4), BONUS_BP: hexw(10500, 4), MATURITY: hexw(now + 4 * 3600, 4), RECOVER_AFTER: hexw(now + 8 * 3600, 4), LENDER: sha(lenderSpk) }
  const offerInstance = { instance: 2, template_hash: OFFER_T, genesis, slots: {}, params: { ...base, LOT: hexw(LOT, 8), DEBT: hexw(DEBT, 8), COLLATERAL: hexw(COLLATERAL, 8), EXPIRY: hexw(now + 2 * 3600, 4) } }
  const vaultInstance = (debt, last) => ({ instance: 2, template_hash: VAULT_T, genesis, params: { ...base, BORROWER: sha(meSpk) }, slots: { DEBT_OUT: hexw(debt, 8), LAST_TIME: hexw(last, 4) } })

  // Opens a template, an instance, finds its coins and chooses a path.
  async function contract (hash, instance, path) {
    await set('contractTemplate', hash); await click('contractUseTemplate')
    await set('contractInstance', JSON.stringify(instance)); await click('contractRecompute'); await idle('contractRecompute')
    const out = await text('contractInstanceOut')
    const address = (out.match(/address (\S+)/) || [])[1]; const script = (out.match(/script ([0-9a-f]+)/) || [])[1]
    return { address, script, find: async () => { await click('contractFindCoins'); await idle('contractFindCoins'); await set('contractPath', path) } }
  }
  // Reviews a request written by hand, funded from the wallet; returns the screen.
  async function review (req) {
    await tick('contractByHand', true); await tick('contractFund', true)
    await set('contractRequest', JSON.stringify(req))
    await click('contractReview'); await idle('contractReview')
    return { err: await text('contractError'), screen: await text('contractApproval') }
  }
  async function signed (label) {
    await click('contractSign'); await page.waitFor("document.getElementById('contractDone').textContent.startsWith('Broadcast')", 60000)
    const txid = (await text('contractDone')).replace('Broadcast ', '').trim()
    mine(1)
    const conf = json('getrawtransaction', txid, 'true')
    ok(conf.confirmations >= 1, `${label}: ${txid} confirmed in a block, ${conf.vsize} vB`)
    await page.eval('window.__sync()')
    return conf
  }
  const fivePoints = (label, screen, extra) => {
    for (const want of ['Sign this contract spend?', '1. Known template', '2. Output recomputed', '3. Program run', 'ran against the final transaction',
      '4. Shown', 'it signs digest', '5. Contract key', 'takes no signature, so no contract key signs', 'What it spends', 'this wallet\'s coin',
      'Your balance change', ...extra]) ok(screen.toLowerCase().includes(want.toLowerCase()), `${label}: the approval shows "${want}"`)
  }

  // ---- the take ----
  const o = await contract(OFFER_T, offerInstance, 'take')
  ok(o.address && json('getaddressinfo', o.address).scriptPubKey === o.script, `the offer's address ${o.address} is the node's for its script`)
  send(o.address, 2 * LOT / COIN, Y); mine(1)
  await o.find()
  const ocoin = await page.eval('JSON.stringify(window.__contracts.state.coins[0].coin)').then(JSON.parse)
  const last = mtp() - 1
  const vault0 = vaultInstance(DEBT, last)
  const v0 = await contract(VAULT_T, vault0, 'top_up')
  const vaultScript0 = v0.script
  await contract(OFFER_T, offerInstance, 'take').then((c) => c.find())
  let r = await review({ path: 'take', inputs: [{ is: 'contract' }], lock_time: last, outputs: [
    { to: 'open', script: vaultScript0, asset: X, amount: COLLATERAL, open: vault0 },
    { to: 'contract', script: o.script, asset: Y, amount: ocoin.amount - LOT },
    { to: 'wallet', address: receive, asset: Y, amount: LOT - FEE },
    { to: 'fee', asset: Y, amount: FEE }], spender: { PATH: 'Left(0x' + sha(meSpk) + ')' } })
  ok(!r.err, 'the take is prepared' + (r.err ? ': ' + r.err : ''))
  fivePoints('take', r.screen, ['pignus/offer', 'Output 0 opens a contract', 'opens pignus/vault v2', 'SHA-256 of this wallet\'s script', '-10.00000000 XCOL', '9.99998000 YDEBT'])
  await shot('vault-01-take-approval.png')
  const take = await signed('the take')
  ok(take.vout[0].scriptPubKey.hex === vaultScript0, 'the take opened the vault this wallet borrows under')

  // ---- the top-up ----
  const v = await contract(VAULT_T, vault0, 'top_up'); await v.find()
  const vcoin = await page.eval('JSON.stringify(window.__contracts.state.coins[0].coin)').then(JSON.parse)
  r = await review({ path: 'top_up', inputs: [{ is: 'contract' }], outputs: [
    { to: 'contract', script: vaultScript0, asset: X, amount: vcoin.amount + COIN }, { to: 'fee', asset: X, amount: FEE }], spender: { PATH: 'Left(Right(()))' } })
  ok(!r.err, 'the top-up is prepared' + (r.err ? ': ' + r.err : ''))
  fivePoints('top-up', r.screen, ['pignus/vault', 'The contract', '1.00000000 XCOL'])
  await shot('vault-02-topup-approval.png')
  await signed('the top-up')

  // ---- refused: a wallet input said to be in another asset ----
  const v2 = await contract(VAULT_T, vault0, 'repay'); await v2.find()
  const vcoin2 = await page.eval('JSON.stringify(window.__contracts.state.coins[0].coin)').then(JSON.parse)
  const recorded = JSON.parse(await page.eval('window.__coins()'))
  const y = recorded.find((c) => c.asset === Y)
  const vault1 = vaultInstance(DEBT - 2 * COIN, last)
  const vs1 = (await contract(VAULT_T, vault1, 'repay')).script
  await contract(VAULT_T, vault0, 'repay').then((c) => c.find())
  const repay = (inputs) => ({ path: 'repay', inputs, outputs: [
    { to: 'contract', script: vs1, asset: X, amount: vcoin2.amount }, { to: 'pay', script: lenderSpk, asset: Y, amount: 2 * COIN }, { to: 'fee', asset: Y, amount: FEE }],
  spender: { PATH: 'Left(Left(()))' }, next_slots: vault1.slots })
  r = await review(repay([{ is: 'contract' }, { is: 'wallet', txid: y.txid, vout: y.vout, asset: X, amount: y.amount }]))
  ok(r.err.includes('so it is not spent as shown'), 'a wallet input said to be in another asset is refused, no approval: ' + r.err)
  await shot('vault-03-refused-asset.png')

  // ---- the repayment, in part ----
  r = await review(repay([{ is: 'contract' }]))
  ok(!r.err, 'the repayment is prepared' + (r.err ? ': ' + r.err : ''))
  fivePoints('repay', r.screen, ['pignus/vault', 'Pays output 1', '2.00000000 YDEBT'])
  await shot('vault-04-repay-approval.png')
  const rep = await signed('the repayment')
  ok(rep.vout[0].scriptPubKey.hex === vs1 && rep.vout[1].scriptPubKey.hex === lenderSpk, 'the successor owes the rest and the lender is paid')
  ok(page.errors.length === 0, 'no page errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''))
} catch (e) {
  ok(false, 'the drive stopped: ' + (e.stack || e)); if (process.env.SHIM_LOG && shim) console.log(shim.log.slice(-15).join('\n'))
} finally {
  if (EVIDENCE) writeFileSync(join(EVIDENCE, 'contracts-vault-drive.log'), log.join('\n') + '\n')
  await cleanup()
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
