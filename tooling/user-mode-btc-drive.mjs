#!/usr/bin/env node
// Drives the user-mode composer's BTC trades end to end in headless Chromium, the page's Bitcoin
// Lightning being its own hosted node: keyless, run by the hosted-node service
// (tooling/lsp/lsp-server.mjs) and co-signed by the page's device signer over the service's
// websocket, as on the testnet.
//
//   1. the page joins a local regtest operator and boards XLEAF (developer mode), then in user
//      mode asks for a BTC price: its first ask brings its Bitcoin node up at the service;
//   2. the service's node opens a channel to it (half of it the wallet's), as room to receive
//      bought from the service does;
//   3. XLEAF for BTC: "Sent", then "Settled"; the wallet's hold was settled by the page only once
//      the maker's payment was held there for the whole amount;
//   4. BTC for XLEAF: "Sent", then "Settled"; the page paid the maker's invoice through the
//      service's node, its fee capped at the ticket's;
//   5. an abandoned trade: XLEAF for BTC with the maker gone once the wallet's side is locked; the
//      wallet's payment comes back when its time runs out ("Returned"), the hold is never settled
//      and no BTC moved: both sides are as they were, less the fees named.
//
// Each step is a DOM assertion and a screenshot; every effect is checked at the library, the
// nodes or the service.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQLN_DIR=/path/to/seqln SEQUENTIA_DIR=/path/to/Sequentia \
//     node tooling/user-mode-btc-drive.mjs <evidence-dir>
//
// The harness must run with ARCA_OPERATOR_LIGHTNING=1 and ARCA_OPERATOR_BTC_LIGHTNING=1: its hub
// is the service's routing node, and the one other Bitcoin node is the maker's own, with a
// channel to the hub both ways. SEQLN_DIR is a SeqLN build with the keyless hsmd proxy, the
// hold-invoice plugin and the signer's websocket relay. Needs pkg/ and a Chromium (CHROMIUM=…).
import { spawn } from 'node:child_process'
import { pickExpr, rowsExpr } from './picker-drive.mjs'
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { startEsploraShim } from './esplora-shim.mjs'
import { clnRpc } from './cln-rpc.mjs'
import { harness, startMaker, makerReady, freePort, sleep, lwkFrom } from './user-mode-stack.mjs'
import { USER_MODE_FORBIDDEN_WORDS, forbiddenIn } from '../user-trade.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const SEQLN = process.env.SEQLN_DIR
const SEQUENTIA = process.env.SEQUENTIA_DIR
const out = resolve(process.argv[2] || join(tmpdir(), 'user-mode-btc-drive-evidence'))
if (!SEQLN || !SEQUENTIA) { console.error('SEQLN_DIR must name a SeqLN build and SEQUENTIA_DIR a Sequentia build'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const T0 = Date.now(); const note = (s) => { s = ((Date.now() - T0) / 1000).toFixed(0).padStart(5) + 's ' + s; console.log(s); appendFileSync(log, s + '\n') }

let failures = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail, (k, v) => (typeof v === 'bigint' ? String(v) : v))) : ''}`)
  if (!ok) failures++
}
async function until (what, f, ms = 180000, every = 1000) {
  const end = Date.now() + ms
  for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(every) }
}

const H = harness(control)
const children = []
const pages = []
let step = 0

function wallet (name) {
  const page = new Page()
  pages.push(page)
  const w = {
    name, page,
    eval: (js) => page.eval(js),
    text: (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`),
    has: (sel) => page.eval(`!!document.querySelector(${JSON.stringify(sel)})`),
    visible: (sel) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return !!(e && e.offsetParent !== null)})()`),
    click: (sel) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no ${sel.replace(/'/g, '')}'); e.click(); return true})()`),
    set: (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true})()`),
    shot: async (label) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${name}-${label}.png`); await page.screenshot(f); note(`     screenshot ${f.split('/').pop()}`) },
    leafIdle: () => page.waitFor("!document.querySelector('.leaf-busy')", 180000),
    mode: async (m) => {
      await w.click('[data-tab=settings]')
      await w.eval(`(()=>{const c=document.querySelector('#mode${m === 'user' ? 'User' : 'Developer'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
      await sleep(300)
    },
    trades: () => page.eval("(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('swk.usertrade.')); return k ? JSON.parse(localStorage.getItem(k)) : []})()"),
    holds: () => page.eval("(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('swk.btcln.holds.')); return k ? JSON.parse(localStorage.getItem(k)) : {}})()"),
  }
  w.sync = async () => { await w.click('[data-tab=leaves]'); await w.leafIdle(); await w.click('#btnLeafSync'); await w.leafIdle() }
  return w
}

async function start (w, base, st, labels, init) {
  await w.page.open()
  await w.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${init}; try { localStorage.setItem('swk.registryCache', ${JSON.stringify(JSON.stringify(labels))}) } catch {}` })
  await w.page.go(base)
  await w.page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  await w.click('#btnCreate')
  await w.page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await w.click('#btnConfirm')
  await w.page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  await w.eval(`localStorage.setItem('swk.sequentia.assets', ${JSON.stringify(JSON.stringify(labels))})`)
  await w.mode('developer')
  await w.page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')")
  await w.click('[data-tab=leaves]')
  await w.page.waitFor("document.querySelector('#leafJoin')", 30000)
  await w.set('leafServer', base + 'operator'); await w.set('leafNodeUrl', base + 'node')
  await w.set('leafNodeUser', st.node_user); await w.set('leafNodePassword', st.node_password)
  // A payment over Lightning needs an exit delay longer than the operator's two units for it.
  await w.set('leafDelay', '3'); await w.set('leafMinDelay', '3')
  await w.click('#btnLeafJoin')
  await w.page.waitFor("document.querySelector('#leafRails')", 120000)
}

async function board (w, asset, amount, fund, fee) {
  const script = await until(`${w.name}'s leaf address`, async () => {
    await w.leafIdle(); await w.click('#btnLeafAddress'); await w.leafIdle()
    return w.eval("(document.querySelector('#leafAddress')||{dataset:{}}).dataset.script || null")
  }, 60000, 200)
  for (const [a, v] of fund) await H.fund(script, a, v)
  await H.produce()
  const shown = `document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${asset}')`
  await until(`${w.name}'s on-chain coin`, async () => { await w.sync(); return w.eval(shown) }, 180000, 3000)
  for (let i = 0; ; i++) {
    await w.set('leafBoardAsset', asset); await w.set('leafBoardAmount', String(amount)); await w.set('leafBoardFee', fee)
    await w.click('#btnLeafBoard'); await w.leafIdle()
    if (await w.has('#btnLeafBoardConfirm')) { await w.click('#btnLeafBoardConfirm'); await w.leafIdle(); if (await w.has('#leafBoard .leaf-result')) return }
    const why = await w.text('.leaf-refusal')
    if (i < 30 && /Scan already in progress/.test(why)) { await sleep(3000); continue }
    throw new Error(`${w.name}: the board did not go through: ${why}`)
  }
}

async function wordsCheck (w, label) {
  const text = await w.eval("(()=>{const s=document.querySelector('section[data-panel=\"swap\"]'); return s ? s.innerText : ''})()")
  const found = forbiddenIn(text)
  check(`${label}: no rail or developer word on the Trade tab`, found.length === 0, found.length ? found : `${text.length} characters checked against ${USER_MODE_FORBIDDEN_WORDS.length} words`)
  appendFileSync(join(out, 'user-mode-text.txt'), `--- ${label}\n${text}\n`)
}

async function pick (w, id, hex) { if (!(await w.eval(pickExpr(id, hex)))) throw new Error('no ' + hex + ' in #' + id); await sleep(200) }
async function review (w, pay, get, amount) {
  await w.click('[data-tab=swap]')
  await w.page.waitFor("document.querySelector('#ucPay') && document.querySelector('#ucPay').offsetParent !== null", 30000)
  await pick(w, 'ucPay', pay); await pick(w, 'ucGet', get)
  await w.set('ucAmount', amount)
  await w.click('#ucReview')
  await w.page.waitFor("document.querySelector('#ucConfirm') || (document.querySelector('#ucNote') && document.querySelector('#ucNote').innerText.trim() && !document.querySelector('#ucReview').disabled)", 300000)
  return { in: await w.text('#ucIn'), out: await w.text('#ucOut'), cost: await w.text('#ucCost'), note: await w.text('#ucNote') }
}

async function main () {
  const st = await H.state()
  if (!st.btc_lightning || !(st.btc_lightning.wallets || []).length) throw new Error('the harness runs no Bitcoin side (ARCA_OPERATOR_BTC_LIGHTNING=1)')
  const X = st.x
  const labels = { [X]: { ticker: 'XLEAF', name: 'Drive asset X', precision: 0 } }
  const hub = clnRpc(st.btc_lightning.hub)
  const makerNode = clnRpc(st.btc_lightning.wallets[0])
  note(`operator ${st.server}; chain ${st.genesis_hash}; asset X ${X}`)
  const hubInfo = await hub('getinfo')
  const makerInfo = await makerNode('getinfo')
  const conf = await hub('listconfigs')
  const cv = (k) => { const c = (conf.configs || {})[k] || {}; return c.value_int ?? c.value_str ?? conf[k] }
  const btcRpcPort = cv('bitcoin-rpcport')
  // bitcoin-cli reads the laptop's own bitcoin.conf unless it is pointed at the chain's datadir, as
  // the harness's nodes are: the service's nodes get a bitcoin-cli that is.
  const btcCli = join(out, 'bitcoin-cli')
  writeFileSync(btcCli, `#!/bin/sh\nexec ${process.env.BITCOIN_CLI || '/usr/local/bin/bitcoin-cli'} -datadir=${cv('bitcoin-datadir')} "$@"\n`, { mode: 0o755 })
  note(`service hub ${hubInfo.id.slice(0, 16)}…, maker's node ${makerInfo.id.slice(0, 16)}…, bitcoind rpc port ${btcRpcPort}`)

  // ---- the hosted-node service, provisioning keyless Bitcoin nodes ----
  const lspPort = await freePort()
  const nodeUrl = new URL(st.node_url)
  const prov = join(out, 'prov'); mkdirSync(prov, { recursive: true })
  const lspEnv = {
    ...process.env, LSP_PORT: String(lspPort), LSP_TOKEN: 'drive-token', LNCLI: join(SEQLN, 'cli/lightning-cli'), SEQOB_CLI: '/bin/true', GOLD: X,
    HOSTED_ASSET_RPC: st.btc_lightning.hub, HOSTED_BTC_RPC: st.btc_lightning.hub, CHANNEL_PEER_BTC: hubInfo.id,
    PROV_DIR: prov, LIGHTNINGD: join(SEQLN, 'lightningd/lightningd'), HSMD_PROXY: join(SEQLN, 'lightningd/lightning_hsmd_proxy'),
    WS_RELAY: join(SEQLN, 'contrib/seqln-signer/wasm/relay/seqln-ws-relay.mjs'), SEQLN_HOLDINVOICE_PLUGIN: join(SEQLN, 'contrib/holdinvoice-seq/holdinvoice.py'),
    ELEMENTS_CLI: join(SEQUENTIA, 'src/sequentia-cli'), SEQ_RPC_PORT: nodeUrl.port, SEQ_RPC_USER: st.node_user, SEQ_RPC_PASS: st.node_password,
    BTC_RPC_PORT: String(btcRpcPort), BTC_RPC_USER: 'arca', BTC_RPC_PASS: 'arca', BTC_CLI: btcCli, BTC_NETWORK: 'regtest', BTC_FEERATE: '1000',
    PROV_ADDR_BASE: '62500', PROV_SIGNER_BASE: '62550', PROV_WS_BASE: '62600',
  }
  const lsp = spawn(process.execPath, [join(here, 'lsp', 'lsp-server.mjs')], { env: lspEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(lsp)
  lsp.stdout.on('data', (d) => appendFileSync(join(out, 'lsp.log'), d)); lsp.stderr.on('data', (d) => appendFileSync(join(out, 'lsp.log'), d))
  const LSP = `http://127.0.0.1:${lspPort}`
  const lspGet = async (p) => { const r = await fetch(LSP + p, { headers: { authorization: 'Bearer drive-token' } }); return r.json() }
  await until('the service up', async () => { try { return (await fetch(LSP + '/health')).ok } catch { return false } }, 60000, 500)
  note(`hosted-node service pid ${lsp.pid} at ${LSP}`)

  // ---- the maker: leaves of X, and a BTC desk on its own node ----
  const lwk = await lwkFrom()
  const btcDesk = { rpc: st.btc_lightning.wallets[0], keep_sats: '200000', invoice_seconds: 3600, max_route_fee_sats: '1000',
    pairs: [{ give: 'BTC', want: X, rate_num: '21', rate_den: '10', min_give: '5000' }, { give: X, want: 'BTC', rate_num: '11', rate_den: '20', min_give: '10000' }] }
  const maker = await startMaker(H, st, join(out, 'maker'), { pairs: [{ give: X, want: st.y, rate_num: '1', rate_den: '1', min_give: '10000' }], fund: [[X, 20000000]],
    port: await freePort(), lwk, settleSeconds: 20, syncSeconds: 3, exitDelayUnits: 3, coinSize: 4000000, btc: btcDesk })
  children.push(maker.proc)
  note(`leaf maker pid ${maker.proc.pid} at ${maker.url}`)
  const pumpUntil = async (what, f, ms) => until(what, async () => { await H.pump().catch(() => {}); return f() }, ms, 2500)
  const quotes = await pumpUntil('the maker quoting both ways', async () => { try { const q = await (await fetch(maker.url + '/v1/quotes')).json(); const l = q.quotes || []; return l.some((x) => x.give_asset === X && x.want_asset === 'BTC') && l.some((x) => x.give_asset === 'BTC' && x.want_asset === X) ? l : null } catch { return null } }, 300000)
  note(`     the maker quotes ${JSON.stringify(quotes)}`)

  const pairs = { chains: { [st.genesis_hash]: { pairs: [{ pay: X, receive: 'BTC', sources: ['btc-gateway'] }, { pay: 'BTC', receive: X, sources: ['btc-gateway'] }] } } }
  writeFileSync(join(out, 'pairs-used.json'), JSON.stringify(pairs, null, 2))
  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port: await freePort() })
  children.push({ kill: () => shim.close() })
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control, '--esplora', shim.url, '--maker', maker.url, '--lsp', LSP], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(srv)
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  note(`page ${base}`)
  // The service's shared node is not the wallet's; its websocket globals only mark the service as
  // there. The wallet's own node is reached through the service's websocket router.
  const init = [`window.SEQ_USER_TRADE=true`, `window.SEQ_LEAF_MAKERS=[${JSON.stringify(base + 'leafmaker')}]`,
    `window.SEQ_USER_MODE_PAIRS=${JSON.stringify('data:application/json,' + encodeURIComponent(JSON.stringify(pairs)))}`,
    // The page sets the live service's globals itself: these are fixed before it runs, so it
    // reaches only this drive's service, and no shared node of the live one.
    `for (const [k, v] of Object.entries(${JSON.stringify({ SEQ_LSP_URL: base + 'lsp', SEQ_LSP_TOKEN: 'drive-token', SEQ_LSP_WS_BASE: 'ws://127.0.0.1:' + lspPort,
      SEQ_LSP_WS_BTC: 'ws://127.0.0.1:9/none', SEQ_LSP_HOST_PUBKEY_BTC: '02' + '11'.repeat(32), SEQ_LSP_WS_ASSET: '', SEQ_LSP_HOST_PUBKEY_ASSET: '' })})) Object.defineProperty(window, k, { get: () => v, set: () => {}, configurable: false })`].join('; ')

  const A = wallet('A')
  await start(A, base, st, labels, init)
  await board(A, X, 3000000, [[X, 5000000]], X)
  await H.produce(); await H.bury()
  await until('A\'s board live', async () => { await A.sync(); return /3000000/.test(await A.text('#leafRails')) }, 180000, 3000)
  await A.shot('boarded-developer-mode')

  let pumping = false, pumpOn = true
  const pump = setInterval(async () => { if (pumping || !pumpOn) return; pumping = true; try { await H.pump() } catch {} finally { pumping = false } }, 2500)

  // ---- 1. user mode: the first BTC ask brings the wallet's Bitcoin node up ----
  await A.mode('user')
  await A.click('[data-tab=swap]')
  await A.page.waitFor("document.querySelector('#ucPay') && document.querySelector('#ucPay').offsetParent !== null", 30000)
  const firsts = [(await A.eval(rowsExpr('ucPay')))[0], (await A.eval(rowsExpr('ucGet')))[0]]
  check('both pickers list BTC first', firsts[0] === 'BTC' && firsts[1] === 'BTC', firsts)
  await wordsCheck(A, 'user mode, empty')
  const t0 = await review(A, X, 'BTC', '100000')
  note(`     before the wallet's node has a channel: ${JSON.stringify(t0)}`)
  const mine = await until('the wallet\'s own Bitcoin node at the service', async () => { const l = await lspGet('/node/list'); return (l.nodes || []).find((n) => n.chain === 'btc' && n.node_id) || null }, 120000, 2000)
  note(`     the page's Bitcoin node ${mine.key} (${mine.node_id.slice(0, 16)}…), keyless, its signer the page's`)
  const reg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(prov, 'registry.json'), 'utf8')))
  const rec = reg.nodes[mine.key]
  check('the node has no secret of its own: its hsmd is the proxy to the page\'s signer', !!rec && !(await import('node:fs').then((fs) => fs.existsSync(join(rec.dir, 'regtest', 'hsm_secret')))), { dir: rec && rec.dir })

  // ---- 2. room to receive and to pay: a channel from the service's node, half of it pushed ----
  await hub('connect', { id: `${mine.node_id}@127.0.0.1:${rec.addrPort}` })
  await hub('fundchannel', { id: mine.node_id, amount: 4000000, push_msat: 2000000000, announce: true })
  await H.c('/btc_mine', { blocks: 6 })
  await until('the channel to the wallet\'s node in CHANNELD_NORMAL', async () => {
    const c = await hub('listpeerchannels', { id: mine.node_id }); return (c.channels || []).some((x) => x.state === 'CHANNELD_NORMAL')
  }, 120000, 2000)
  await H.c('/btc_mine', { blocks: 6 })
  await sleep(5000)
  await A.click('#btnSync')
  await until('the page counts its BTC in Lightning', async () => { await A.click('#btnSync').catch(() => {}); return /BTC/.test(await A.text('#ucHave')) && !/^0 BTC/.test((await A.text('#ucHave')).trim()) }, 120000, 4000).catch(() => null)
  note(`     the wallet's BTC figure: ${await A.text('#ucHave')}`)

  const hubBefore = (await hub('listpeerchannels', { id: mine.node_id })).channels.find((x) => x.state === 'CHANNELD_NORMAL')
  // ---- 3. XLEAF for BTC ----
  const t1 = await until('a ticket for XLEAF to BTC', async () => { const t = await review(A, X, 'BTC', '400000'); return (await A.has('#ucConfirm')) ? t : (note('     ' + t.note), null) }, 300000, 5000)
  check('the ticket: what you pay, what you get, the fees', /You pay\s*[\d.,]+ XLEAF/.test(t1.in) && /You get\s*[\d.,]+ BTC/.test(t1.out) && /^(Fees .* included above|No fees)$/.test(t1.cost.trim()), t1)
  await wordsCheck(A, 'user mode, XLEAF for BTC ticket')
  await A.shot('ticket-x-for-btc')
  await A.click('#ucConfirm')
  const r1 = await until('the sale sent', async () => { const r = (await A.trades()).slice(-1)[0]; return r && r.state !== 'confirming' ? r : null }, 120000)
  check('the trade is the maker\'s BTC desk, under the wallet\'s own hash', r1.source === 'btc-gateway' && r1.dir === 'sell' && !!(await A.holds())[r1.hash], { source: r1.source, dir: r1.dir, hash: r1.hash })
  await until('"Sent"', async () => /Sent|Settled/.test(await A.text(`#ucTrades [data-trade="${r1.id}"]`)), 120000).catch(() => {})
  await A.shot('x-for-btc-sent')
  await until('the sale Settled', async () => /Settled/.test(await A.text(`#ucTrades [data-trade="${r1.id}"]`)), 400000, 2000)
  const r1s = (await A.trades()).find((r) => r.id === r1.id)
  const h1 = (await A.holds())[r1.hash]
  const inv1 = await lspGet(`/node/invoice-status?node=${encodeURIComponent(mine.key)}&payment_hash=${r1.hash}`)
  check('"Settled": the hold settled by the page once the whole amount was held', r1s.state === 'settled' && h1.settled === true && inv1.state === 'settled' && Number(inv1.received_msat) >= Number(r1.sats) * 1000, { state: r1s.state, hold: inv1 })
  const makerPay = (await makerNode('listpays', { payment_hash: r1.hash })).pays || []
  check('the maker paid the wallet\'s hold through the service\'s node, and learnt the preimage then', makerPay.some((p) => p.status === 'complete'), makerPay.map((p) => ({ status: p.status, amount_msat: p.amount_msat })))
  await A.shot('x-for-btc-settled')
  await wordsCheck(A, 'user mode, XLEAF for BTC settled')
  const hubAfter1 = (await hub('listpeerchannels', { id: mine.node_id })).channels.find((x) => x.state === 'CHANNELD_NORMAL')
  note(`     the hub's side of the wallet's channel: ${hubBefore.to_us_msat} -> ${hubAfter1.to_us_msat}`)

  // ---- 4. BTC for XLEAF ----
  const t2 = await until('a ticket for BTC to XLEAF', async () => { const t = await review(A, 'BTC', X, '0.0005'); return (await A.has('#ucConfirm')) ? t : (note('     ' + t.note), null) }, 300000, 5000)
  check('the ticket: what you pay, what you get, the fees', /You pay\s*[\d.,]+ BTC/.test(t2.in) && /You get\s*[\d.,]+ XLEAF/.test(t2.out) && /^(Fees .* included above|No fees)$/.test(t2.cost.trim()), t2)
  await wordsCheck(A, 'user mode, BTC for XLEAF ticket')
  await A.shot('ticket-btc-for-x')
  await A.click('#ucConfirm')
  const r2 = await until('the purchase under way', async () => { const l = await A.trades(); const r = l[l.length - 1]; return l.length >= 2 && r.state !== 'confirming' ? r : null }, 120000)
  check('the trade is the maker\'s BTC desk, under the maker\'s hash', r2.source === 'btc-gateway' && r2.dir === 'buy' && !(await A.holds())[r2.hash], { source: r2.source, dir: r2.dir, routeFee: r2.routeFee, routeDelay: r2.routeDelay })
  await until('"Sent"', async () => /Sent|Settled/.test(await A.text(`#ucTrades [data-trade="${r2.id}"]`)), 300000, 2000).catch(() => {})
  await A.shot('btc-for-x-sent')
  await until('the purchase Settled', async () => /Settled/.test(await A.text(`#ucTrades [data-trade="${r2.id}"]`)), 400000, 2000)
  const r2s = (await A.trades()).find((r) => r.id === r2.id)
  const ps2 = await lspGet(`/node/pay-status?node=${encodeURIComponent(mine.key)}&payment_hash=${r2.hash}`)
  const mi2 = ((await makerNode('listinvoices', { payment_hash: r2.hash })).invoices || [])[0] || {}
  check('"Settled": the page paid the maker\'s invoice from its node, and claimed with the preimage it learnt', r2s.state === 'settled' && ps2.state === 'complete' && mi2.status === 'paid' && r2s.preimage === ps2.preimage,
    { state: r2s.state, pay: ps2.state, makerInvoice: mi2.status, amount: mi2.amount_received_msat })
  await A.shot('btc-for-x-settled')
  await wordsCheck(A, 'user mode, BTC for XLEAF settled')

  // ---- 5. an abandoned trade: the maker goes once the wallet's side is locked ----
  pumpOn = false; while (pumping) await sleep(200)
  const coinsBefore = await A.eval("window.sequentiaWallet.request({method:'getLeafBalances'})").catch(() => null)
  const t3 = await until('a ticket for the abandoned sale', async () => { const t = await review(A, X, 'BTC', '200000'); return (await A.has('#ucConfirm')) ? t : (note('     ' + t.note), null) }, 300000, 5000)
  await A.click('#ucConfirm')
  const r3 = await until('the abandoned sale sent', async () => { const l = await A.trades(); const r = l[l.length - 1]; return l.length >= 3 && r.state !== 'confirming' ? r : null }, 120000)
  await maker.stop()
  note(`     the maker stopped with the wallet's side locked (${r3.state}); ticket ${JSON.stringify(t3)}`)
  await A.shot('abandoned-sent')
  pumpOn = true
  // The wallet's payment out of the tree times out four to eight days on: the chain's clock moves.
  for (let i = 0; i < 10; i++) {
    await H.advance(86400)
    await H.pump().catch(() => {})
    const r = (await A.trades()).find((x) => x.id === r3.id)
    if (r && r.state === 'returned') break
    await A.sync().catch(() => {})
    await A.click('[data-tab=swap]').catch(() => {})
    await sleep(5000)
  }
  await until('the abandoned sale Returned', async () => { await H.pump().catch(() => {}); return /Returned/.test(await A.text(`#ucTrades [data-trade="${r3.id}"]`)) }, 600000, 5000)
  const r3s = (await A.trades()).find((r) => r.id === r3.id)
  const h3 = (await A.holds())[r3.hash]
  const inv3 = await lspGet(`/node/invoice-status?node=${encodeURIComponent(mine.key)}&payment_hash=${r3.hash}`)
  const mp3 = (await makerNode('listpays', { payment_hash: r3.hash })).pays || []
  check('"Returned": the wallet\'s payment came back, the hold was never settled, no BTC moved', r3s.state === 'returned' && !h3.settled && inv3.state !== 'settled' && !mp3.some((p) => p.status === 'complete'),
    { state: r3s.state, fees: r3s.feesPaid, hold: inv3.state, makerPays: mp3.length })
  const coinsAfter = await A.eval("window.sequentiaWallet.request({method:'getLeafBalances'})").catch(() => null)
  note(`     leaves before ${JSON.stringify(coinsBefore && coinsBefore.leaves)} after ${JSON.stringify(coinsAfter && coinsAfter.leaves)}`)
  await A.shot('abandoned-returned')
  await wordsCheck(A, 'user mode, the abandoned sale returned')
  clearInterval(pump)
  writeFileSync(join(out, 'page-console.log'), (A.page.console || []).map(String).join('\n'))
  writeFileSync(join(out, 'maker.log'), maker.log.join(''))
  const errs = [...A.page.errors].filter((e) => !/Failed to load resource|registry|404|\/api\/|ws:\/\/127\.0\.0\.1:9\//.test(e))
  check('no page errors from the wallet\'s own code', errs.length === 0, errs.slice(0, 5))
}

main().catch(async (e) => {
  failures++; note('FAIL ' + (e.stack || e.message))
  for (const p of pages) { try { writeFileSync(join(out, `failure-console-${pages.indexOf(p)}.log`), [...(p.console || []), ...(p.errors || [])].map(String).join('\n')) } catch {} }
  for (const p of pages) { try { await p.screenshot(join(out, `failure-${pages.indexOf(p)}.png`)); note('     page errors: ' + JSON.stringify(p.errors.slice(-10))); note('     console: ' + JSON.stringify((p.console || []).filter((l) => /user trade|btc lightning|ln\]|seqln/.test(String(l))).slice(-40))) } catch {} }
}).finally(async () => {
  // The service's nodes run on after it: each stopped by its own directory, and its relay by its port.
  try {
    const fs = await import('node:fs')
    const reg = JSON.parse(fs.readFileSync(join(out, 'prov', 'registry.json'), 'utf8'))
    for (const rec of Object.values(reg.nodes || {})) {
      for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { continue }
        const argv = cmd.split(' ')
        if (argv.includes('--lightning-dir=' + rec.dir) || (cmd.includes('seqln-ws-relay') && argv.includes(String(rec.ws_port)))) { try { process.kill(Number(pid), 'SIGTERM'); note(`     stopped ${pid} (${argv[0].split('/').pop()} of ${rec.key})`) } catch {} }
      }
    }
  } catch {}
  for (const p of pages) { try { await p.stop(); if (p.dir) rmSync(p.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} }
  for (const c of children) { try { c.kill() } catch {} }
  note(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
})
