#!/usr/bin/env node
// One phrase, every component of its balance, read by the page on a private regtest chain:
// on-chain coins, leaves boarded into a local operator's tree, a Lightning channel, and the
// Sequence token staked under both locks a Sequentia wallet bonds with (the height lock this
// page uses and the time lock Ambra uses). The drive puts each component there, then reads the
// page's one figure per asset and its headline in user mode, and writes them to
// <evidence-dir>/totals.json, so the same phrase can be read by the other wallets and compared.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) at its control address. Lightning is a
// status served by this drive in the shape the LSP serves it (one channel of the wallet's own
// asset node): the page's figure reads only that status, so the drive checks the counting,
// not a channel.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 node tooling/total-drive.mjs <evidence-dir> [mnemonic]
//
// With TOTAL_DRIVE_READ_ONLY=<a totals.json of an earlier run> and that run's phrase, it puts
// nothing on the chain: it opens the phrase in a fresh browser, joins the operator (which
// restores the phrase's leaves), and checks the page shows the figures and headline recorded
// there.
//
// Needs pkg/ (the lwk_wasm build, which this drive also loads in Node to bond the stakes) and
// a Chromium (CHROMIUM=…).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { startEsploraShim } from './esplora-shim.mjs'
import init, * as lwk from '../pkg/lwk_wasm.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const out = resolve(process.argv[2] || join(tmpdir(), 'total-drive-evidence'))
// A fresh phrase unless one is named (TOTAL_DRIVE_PHRASE_FILE, if set, receives it, for the other
// wallets to open the same phrase; it is kept out of the evidence directory):
// the chain is private and throwaway. The published test phrase is the harness's own.
let MNEMONIC = process.argv[3] || null
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }
let failures = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}
const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
const rpc = (method, params = []) => ctl('/rpc', { method, params })
const cleanup = []
const readOnly = process.env.TOTAL_DRIVE_READ_ONLY ? JSON.parse(readFileSync(process.env.TOTAL_DRIVE_READ_ONLY, 'utf8')) : null

// The amounts each component holds.
const ONCHAIN_X = 5_000_000n
const BOARD_X = 2_000_000n
const LN_X = 700_000n
const STAKE_H = 4_000_000_000_000n          // 40,000 tSEQ under the height lock
const STAKE_T = 4_100_000_000_000n          // 41,000 tSEQ under the time lock
const HEIGHT_CSV = 43200
const TIME_CSV = (1 << 22) | 2532

// The Lightning status the page reads: one channel of the wallet's own asset node, asked for by
// the node keys the page derives from the phrase.
function lspStub (X) {
  const srv = createServer((req, res) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' }
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end() }
    const u = new URL(req.url, 'http://x')
    if (!lspStub.seen) { lspStub.seen = true; note(`     the page asked the Lightning status: ${req.method} ${u.pathname}`) }
    if (u.pathname === '/status') {
      const nodes = (u.searchParams.get('nodes') || '').split(',').filter(Boolean)
      // A channel of a node of the wallet's own (the LSP marks those with their node key); the page
      // asks with the keys it derives, or none before it has derived them.
      const channels = [{ node_key: nodes[nodes.length - 1] || '02' + 'ab'.repeat(32), asset: X, asset_label: 'XTOT', leg: 'asset', state: 'CHANNELD_NORMAL',
        balance_units: Number(LN_X), spendable_units: Number(LN_X) - 7000, receivable_units: 0, short_channel_id: '1x1x0' }]
      res.writeHead(200, h); return res.end(JSON.stringify({ ok: true, channels, nodes: nodes.map((k) => ({ node_key: k, up: true })) }))
    }
    res.writeHead(404, h); res.end('{}')
  })
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` })))
}

async function main () {
  await init({ module_or_path: readFileSync(join(here, '..', 'pkg', 'lwk_wasm_bg.wasm')) })
  if (!MNEMONIC) MNEMONIC = lwk.Mnemonic.fromRandom(12).toString()
  const st = await ctl('/state')
  const X = st.x
  const policy = (await rpc('getsidechaininfo')).pegged_asset
  const genesis = st.genesis_hash
  const port = await new Promise((ok) => { const t = tcpServer(); t.listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => ok(n)) }) })
  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port })
  const shimUrl = shim.url
  const lsp = await lspStub(X)
  const prices = join(out, 'prices.json')
  writeFileSync(prices, JSON.stringify({ SEQ: { price: 0.5 }, XTOT: { price: 0.01 }, tBTC: { price: 60000 } }))
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control, '--esplora', shimUrl, '--prices', prices], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanup.push(() => srv.kill(), () => lsp.srv.close(), () => shim.close())
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  note(`page ${base}; esplora shim ${shimUrl}; Lightning status ${lsp.url}; asset X ${X}; policy asset ${policy}`)

  // --- The phrase's wallet in Node (the kit, as the page builds it) ---
  const network = lwk.Network.regtestWithGenesis(new lwk.AssetId(policy), genesis)
  const signer = new lwk.Signer(new lwk.Mnemonic(MNEMONIC), network)
  const wollet = new lwk.Wollet(network, signer.wpkhSlip77Descriptor())
  const client = new lwk.EsploraClient(network, shimUrl, false, 1, false)
  const syncW = async () => { const u = await client.fullScan(wollet); if (u) wollet.applyUpdate(u) }
  const addr = wollet.address(0).address().toUnconfidential().toString()
  const spk = wollet.address(0).address().scriptPubkey().toString()
  note(`     the phrase's first address ${addr}`)

  // --- On-chain: X, and the Sequence token to stake from ---
  const bonds = []
  let onchainPolicy = 0n
  if (!readOnly) {
  await ctl('/fund', { script: spk, asset: X, amount: Number(ONCHAIN_X) })
  await ctl('/fund', { script: spk, asset: policy, amount: Number(STAKE_H + STAKE_T + 10_000_000n) })
  await ctl('/produce')
  await syncW()

  // --- Staked under both locks: bonded by the kit in Node, as the page and as Ambra bond ---
  const pub = signer.stakerPublicKey()
  for (const [csv, atoms] of [[HEIGHT_CSV, STAKE_H], [TIME_CSV, STAKE_T]]) {
    const pset = network.txBuilder().addStakeOutput(pub, csv, atoms).feeRate(2000).finish(wollet)
    const tx = wollet.finalize(signer.sign(pset)).extractTx()
    const id = (await client.broadcastTx(tx)).toString()
    try { wollet.applyTransaction(tx) } catch {}
    bonds.push(id)
    await ctl('/produce')
    await syncW()
  }
  check('two stakes bonded, one under each lock', bonds.length === 2, bonds)
  onchainPolicy = BigInt(wollet.balance().toJSON()[policy] || 0)
  }

  // --- The page: the phrase opened, on the private chain ---
  const page = new Page()
  cleanup.unshift(() => page.stop(), () => writeFileSync(join(out, 'console.log'), page.console.join('\n')))
  await page.open()
  // Nothing of the public testnet is reached from this drive.
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*', '*mempool.space*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.SEQ_DEV_CHAIN = ${JSON.stringify({ policyAsset: policy, genesis, recordsV2Height: 1 })};
    // The page's own config block names the testnet's LSP; these stay as set here.
    for (const [k, v] of Object.entries({ SEQ_LSP_URL: ${JSON.stringify(lsp.url)}, SEQ_LSP_TOKEN: 'drive', SEQ_LSP_WS_ASSET: 'ws://127.0.0.1:9/',
      SEQ_LSP_HOST_PUBKEY_ASSET: '02${'11'.repeat(32)}', SEQ_LSP_WS_BTC: undefined, SEQ_LSP_HOST_PUBKEY_BTC: undefined }))
      Object.defineProperty(window, k, { value: v, writable: false, configurable: false });
    window.SEQ_LEAVES_TICK_MS = 3000;
    try { if (!localStorage.getItem('swk.sequentia.mnemonic')) {
      localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(MNEMONIC)});
      localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: 'XTOT', name: 'Drive asset', precision: 0, local: true },
        ${JSON.stringify(policy)}: { ticker: 'tSEQ', name: 'Sequence', precision: 8, local: true } }));
    } } catch {}` })
  await page.go(base)
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 90000)
  const click = (sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const set = (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
  const setMode = async (m) => {
    await click('[data-tab=settings]')
    await page.eval(`(()=>{const c=document.querySelector('#mode${m === 'developer' ? 'Developer' : 'User'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
    await page.waitFor(`document.querySelector('#tabLeaves').classList.contains('hide') === ${m !== 'developer'}`, 10000)
  }

  // --- Leaves: joined and boarded in developer mode ---
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafJoin')", 30000)
  await set('leafServer', base + 'operator'); await set('leafNodeUrl', base + 'node')
  await set('leafNodeUser', st.node_user); await set('leafNodePassword', st.node_password)
  await set('leafDelay', '1'); await set('leafMinDelay', '1')
  await click('#btnLeafJoin')
  await page.waitFor("document.querySelector('#leafRails')", 120000)
  if (readOnly) {
    // Joined: the leaves this phrase holds with the operator are restored, nothing is boarded.
    await page.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live')`, 180000).catch(() => {})
    const restored = await page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].filter(d=>d.dataset.state==='live').map(d=>d.dataset.value)")
    check('joining restored the phrase\'s leaves', restored.length > 0, restored)
    await setMode('user')
    await click('[data-tab=balance]')
    const want = Object.fromEntries(readOnly.rows.map((r) => [r.tk, r.total]))
    await page.waitFor(`(()=>{ const w=${JSON.stringify(want)}; const rows=[...document.querySelectorAll('#assetList .bt-row')]; return Object.entries(w).every(([tk,t])=>rows.some(r=>r.querySelector('.tk') && r.querySelector('.tk').textContent===tk && r.querySelector('.bt-t').innerText.replace(/\\s+/g,' ').trim()===t)) })()`, 180000).catch(() => {})
    const rows = await page.eval(`[...document.querySelectorAll('#assetList .bt-row')].map(r=>({ tk: (r.querySelector('.tk')||{}).textContent, total: r.querySelector('.bt-t').innerText.replace(/\s+/g,' ').trim() }))`)
    for (const r of rows) r.total = r.total.replace(/\s+/g, ' ')
    const headline = await page.eval("(document.querySelector('#balTotal .bal-total-amt')||{}).innerText")
    note('     rows: ' + JSON.stringify(rows) + '; headline ' + headline)
    check('a fresh browser shows the same figures as the run that built them', JSON.stringify(rows) === JSON.stringify(readOnly.rows), { now: rows, then: readOnly.rows })
    check('and the same headline', headline === readOnly.headline, { now: headline, then: readOnly.headline })
    await page.screenshot(join(out, '02-fresh-browser-same-totals.png'))
    return
  }
  // The coin to board, paid to an address the leaf wallet shows (the same keys as the page's
  // wallet, read from its own node).
  await page.waitFor("document.querySelector('#btnLeafAddress') && !document.querySelector('#btnLeafAddress').disabled", 120000)
  await click('#btnLeafAddress')
  await page.waitFor("document.querySelector('#leafAddress') && document.querySelector('#leafAddress').dataset.script", 120000)
  const leafScript = await page.eval("document.querySelector('#leafAddress').dataset.script")
  await ctl('/fund', { script: leafScript, asset: X, amount: Number(BOARD_X + 100_000n) })
  await ctl('/produce')
  await page.eval("document.querySelector('#btnLeafSync').click()"); await page.waitFor("!document.querySelector('.leaf-busy')", 120000)
  await page.waitFor(`document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${X}')`, 120000)
  await set('leafBoardAsset', X); await set('leafBoardAmount', String(BOARD_X))
  await click('#btnLeafBoard'); await page.waitFor("!document.querySelector('.leaf-busy')", 120000)
  await page.waitFor("document.querySelector('#btnLeafBoardConfirm') || document.querySelector('.leaf-refusal')", 60000)
  const refused = await page.eval("(document.querySelector('.leaf-refusal')||{}).innerText||''")
  if (refused) throw new Error('the board was refused: ' + refused)
  await click('#btnLeafBoardConfirm'); await page.waitFor("!document.querySelector('.leaf-busy')", 120000)
  const board = JSON.parse(await page.eval("document.querySelector('#leafBoard .leaf-result').textContent"))
  check('boarded from the page', !!board.txid, { txid: board.txid, fee: board.fee })
  await ctl('/produce'); await ctl('/bury')
  await page.eval("document.querySelector('#btnLeafSync').click()")
  await page.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live')`, 180000)
  await setMode('user')
  await click('[data-tab=balance]')
  await page.eval("document.querySelector('#btnSync') && document.querySelector('#btnSync').click()")
  // The stakes are found from the chain by the Stake tab's scan, which a sync runs.
  // What the board left on-chain of its coin (its change, less its fee in X), plus the rest.
  const want = { X: ONCHAIN_X + 100_000n - BigInt(board.fee && board.fee.asset === X ? board.fee.amount : 0) + BOARD_X + LN_X }
  await page.waitFor(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='XTOT'); return r && /\\b${want.X}\\b/.test(r.querySelector('.bt-t').innerText) })()`, 180000).catch(() => {})
  const rows = await page.eval(`[...document.querySelectorAll('#assetList .bt-row')].map(r=>({ tk: (r.querySelector('.tk')||{}).textContent, total: r.querySelector('.bt-t').innerText.replace(/\\s+/g,' ').trim() }))`)
  const headline = await page.eval("(document.querySelector('#balTotal .bal-total-amt')||{}).innerText")
  note('     rows: ' + JSON.stringify(rows) + '; headline ' + headline)
  note('     Lightning status line: ' + await page.eval("(document.querySelector('#lnBalStatus')||{}).innerText||''"))
  const xRow = rows.find((r) => r.tk === 'XTOT')
  check('XTOT\'s one figure counts on-chain, leaves and Lightning', xRow && xRow.total.replace(/[^\d]/g, '') === String(want.X), { row: xRow, want: String(want.X) })
  const sRow = rows.find((r) => r.tk === 'tSEQ')
  const wantSeq = onchainPolicy + STAKE_H + STAKE_T
  const fmt8 = (a) => { const s = (a / 100000000n).toString(), f = (a % 100000000n).toString().padStart(8, '0').replace(/0+$/, ''); return f ? s + '.' + f : s }
  check('tSEQ\'s one figure counts what is on-chain and both stakes', sRow && sRow.total.replace(/[^\d.]/g, '') === fmt8(wantSeq), { row: sRow, want: fmt8(wantSeq) })
  await page.eval("(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent==='XTOT'); r && r.click(); return true })()")
  await page.screenshot(join(out, '01-user-mode-totals.png'))
  if (process.env.TOTAL_DRIVE_PHRASE_FILE) writeFileSync(process.env.TOTAL_DRIVE_PHRASE_FILE, MNEMONIC + '\n', { mode: 0o600 })
  writeFileSync(join(out, 'totals.json'), JSON.stringify({ mnemonic_first_address: addr, rows, headline, want: { X: String(want.X), staked: String(STAKE_H + STAKE_T), onchainPolicy: String(onchainPolicy) } }, null, 1))
  check('no page error', page.errors.length === 0, page.errors)
}

try { await main() } catch (e) { failures++; note('FAIL ' + (e.stack || e.message)) } finally { for (const f of cleanup) { try { await f() } catch {} } }
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
