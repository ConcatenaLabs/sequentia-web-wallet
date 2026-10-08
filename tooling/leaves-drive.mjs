#!/usr/bin/env node
// Drives the wallet's developer mode for leaves end to end, in a headless Chromium,
// against a local regtest operator: join, fund and board, receive (the mailbox read on
// sync), send, refusals in the library's own words, settle now (a refresh followed to
// its new leaf by the page's own sync), the exit drill through to a final claim, and
// the page syncing by itself when a coin's refresh window opens. Each step is a DOM
// assertion and a screenshot, and every on-chain effect is checked at the node.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and that
// repository's command-line wallet built (`arca`), which plays the counterparty.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     node tooling/leaves-drive.mjs <evidence-dir>
//
// Needs pkg/ (the lwk_wasm build) for the page to start, and a Chromium (CHROMIUM=…).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
const out = resolve(process.argv[2] || join(tmpdir(), 'leaves-drive-evidence'))
if (!cliBin) { console.error('ARCA_CLI must name the command-line wallet binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
const rpc = (method, params = []) => ctl('/rpc', { method, params })

// The counterparty: the command-line wallet, its own directory.
const cliDir = mkdtempSync(join(tmpdir(), 'leaves-drive-cli-'))
const cli = (...args) => {
  let text
  try { text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}

let failures = 0
let step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}

const page = new Page()
const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })

async function shot (name) {
  step++
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`)
  await page.screenshot(f)
  note(`     screenshot ${f.split('/').pop()}`)
}
const idle = () => page.waitFor("!document.querySelector('.leaf-busy')", 120000)
const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`)
const click = async (sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`) }
const set = (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
const coins = () => page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>({...d.dataset}))")
const syncNow = async () => { await idle(); await click('#btnLeafSync'); await idle() }

async function main () {
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  const st = await ctl('/state')
  const X = st.x
  note(`page ${base}; operator ${st.server}; node ${st.node_url}; asset X ${X} (listed for fees)`)
  cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1')
  const cliInfo = cli('info')
  // The counterparty's own leaf: an on-chain coin of X, boarded and credited.
  await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: 5000000 })
  await ctl('/produce')
  const cb = cli('board', X, '3000000')
  if (cb.error) throw new Error('the CLI wallet could not board: ' + cb.error.message)
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await new Promise((r) => setTimeout(r, 500))
  cli('sync')

  await page.open()
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.SEQ_LEAVES_TICK_MS=4000' })
  await page.go(base)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  await click('#btnCreate')
  await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await click('#btnConfirm')
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)

  // --- Developer mode is off by default, and a setting ---
  check('developer mode is off by default: no Leaves tab', await page.eval("document.querySelector('#tabLeaves').classList.contains('hide')"))
  await click('[data-tab=settings]')
  await page.eval("const c=document.querySelector('#devModeToggle'); c.checked=true; c.dispatchEvent(new Event('change'))")
  await page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')")
  check('the setting shows the Leaves tab', true)
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafJoin')", 30000)

  // --- Join ---
  await set('leafServer', base + 'operator'); await set('leafNodeUrl', base + 'node')
  await set('leafNodeUser', st.node_user); await set('leafNodePassword', st.node_password)
  await set('leafDelay', '1'); await set('leafMinDelay', '1')
  await click('#btnLeafJoin')
  await page.waitFor("document.querySelector('#leafRails')", 120000)
  const rails = await text('#leafRails')
  check('joined: the operator key is shown to compare, and equals the CLI wallet\'s pin', rails.includes(cliInfo.operator), cliInfo.operator)
  const firstRow = await page.eval("(()=>{ const r=document.querySelector('#leafRails tr[data-asset]'); return { asset: r.dataset.asset, leaves: r.querySelector('.leaf-leaves').innerText } })()")
  check('BTC is the first row, with no leaves', firstRow.asset === 'BTC' && /holds no BTC/.test(firstRow.leaves), firstRow)
  await shot('joined')

  // --- An on-chain coin, then a refused board and a board ---
  await click('#btnLeafAddress'); await idle()
  const script = await page.eval("document.querySelector('#leafAddress').dataset.script")
  const fund = await ctl('/fund', { script, asset: X, amount: 10000000 })
  await ctl('/produce')
  const fundTx = await rpc('getrawtransaction', [fund.txid, true])
  check('node: the funding transaction is in a block', fundTx.confirmations >= 1, `${fund.txid} confirmations ${fundTx.confirmations}`)
  await syncNow()
  const xRow = await text(`#leafRails tr[data-asset="${X}"] .leaf-onchain`)
  check('the on-chain rail shows the coin', xRow.includes('10000000 atoms'), xRow)

  await page.waitFor(`document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${X}')`)
  await set('leafBoardAsset', X); await set('leafBoardAmount', '500')
  await click('#btnLeafBoard'); await idle()
  let refusal = await text('.leaf-refusal')
  check('a board below the smallest leaf is refused in the library\'s words', /smallest leaf/.test(refusal), refusal)
  await shot('board-refused')

  await set('leafBoardAmount', '2000000')
  await click('#btnLeafBoard'); await idle()
  const board = JSON.parse(await page.eval("document.querySelector('#leafBoard .leaf-result').textContent"))
  check('board answered pending, with its transaction and fee in the asset boarded', board.state === 'pending' && board.txid && board.fee.asset === X, { txid: board.txid, fee: board.fee, vsize: board.vsize })
  await ctl('/produce'); await ctl('/bury')
  const boardTx = await rpc('getrawtransaction', [board.txid, true])
  check('node: the board transaction is in a block', boardTx.confirmations >= 1, `${board.txid} confirmations ${boardTx.confirmations}`)
  await syncNow()
  let cs = await coins()
  const boardCoin = cs.find((c) => c.leaf === board.leaf_id)
  check('the board is live once final, and shows its dates', boardCoin && boardCoin.state === 'live' && boardCoin.exitBy && boardCoin.refreshFrom && boardCoin.homeFrom && boardCoin.syncDailyFrom, boardCoin)
  const leafRow = await text(`#leafRails tr[data-asset="${X}"] .leaf-leaves`)
  check('the leaves rail shows the boarded value', leafRow.includes('2000000 atoms'), leafRow)
  await shot('boarded')

  // --- Receive: a request, paid by the CLI wallet, read from the mailbox on sync ---
  await set('leafRecvAsset', X)
  await click('#btnLeafReceive'); await idle()
  const request = await page.eval("document.querySelector('#leafRequest').value")
  check('a receive request is shown', request.startsWith('arca:'), request.slice(0, 24) + '…')
  await shot('receive-request')
  const mempoolBefore = await rpc('getrawmempool')
  const paid = cli('send', request, '--amount', '300000', '--asset', X)
  check('the CLI wallet paid the request', !paid.error, paid.error || paid.sent)
  check('node: an out-of-round payment puts nothing on the chain', (await rpc('getrawmempool')).length === mempoolBefore.length)
  await syncNow()
  const syncText = await text('#leafSync')
  note('     sync answered: ' + (await page.eval("(()=>{ const p=document.querySelector('#leafSync details pre'); if(!p) return ''; const v=JSON.parse(p.textContent); return JSON.stringify({ mailbox: v.mailbox, witness: v.witness, auto: document.querySelector('#leafSync').dataset.lastSyncAuto }) })()")).slice(0, 800))
  check('sync read the mailbox: one coin accepted', /Mailbox: 1 accepted/.test(syncText), syncText.match(/Mailbox:[^\n]*/)?.[0])
  cs = await coins()
  const received = cs.find((c) => c.value === '300000' && c.kind === 'transfer')
  check('the received coin is held, operator-confirmed until a round settles it', received && received.standing === 'operator-confirmed', received || cs)
  await shot('received')

  // --- Send to the CLI wallet's request; then the same request again, refused ---
  const req2 = cli('receive')
  await set('leafSendRequest', req2.request); await set('leafSendAmount', '400000'); await set('leafSendAsset', X)
  await click('#btnLeafSend'); await idle()
  const sent = JSON.parse(await page.eval("document.querySelector('#leafSend .leaf-result').textContent"))
  check('the payment was co-signed', sent.sent && sent.sent.value === '400000', sent.sent)
  const mb = cli('mailbox')
  check('the CLI wallet took the coin from its mailbox', (mb.accepted || []).some((c) => c.value === '400000'), (mb.accepted || []).map((c) => c.value))
  check('node: nothing on the chain', (await rpc('getrawmempool')).length === mempoolBefore.length)
  await shot('sent')
  await click('#btnLeafSend'); await idle()
  refusal = await text('.leaf-refusal')
  check('paying the request twice is refused in the server\'s words', /key_reused|already owns a leaf/.test(refusal), refusal)
  await shot('send-refused')

  // --- Settle now: the received coin into the next round, followed by the page itself ---
  await page.eval(`document.querySelector('[data-leaf="${received.leaf}"] [data-action=settle]').click()`); await idle()
  const quote = await text('#leafQuote')
  check('settle now shows the operator\'s fee coin by coin before anything is signed', /fee .*atoms/.test(quote), quote.split('\n').slice(1, 2).join(' '))
  await shot('settle-quote')
  await click('#btnLeafSettleConfirm'); await idle()
  const part = await text('#leafParticipations')
  check('the participation is handed over', /State\s+pending/.test(part) || /pending/.test(part), part.split('\n').slice(0, 4).join(' '))
  const round = await ctl('/round')
  check('node: the round is built and final', !!round.round, round)
  const roundTx = await rpc('getrawtransaction', [round.round, true])
  check('node: the round transaction is in a block', roundTx.confirmations >= 1, `${round.round} confirmations ${roundTx.confirmations}, ${round.vsize} vB`)
  const syncedAt = Number(await page.eval("document.querySelector('#leafSync').dataset.lastSyncAt||0"))
  await page.waitFor(`(()=>{ const p=[...document.querySelectorAll('.leaf-participation')]; return p.some(x=>/released/.test(x.innerText)) })()`, 180000)
  const auto = await page.eval(`({ at: Number(document.querySelector('#leafSync').dataset.lastSyncAt||0), auto: document.querySelector('#leafSync').dataset.lastSyncAuto })`)
  check('the page moved the participation on by itself: released', auto.at > syncedAt && auto.auto === 'true', auto)
  cs = await coins()
  const newLeaf = cs.find((c) => c.kind === 'batch' && c.state === 'live' && c.value === '300000')
  check('the new leaf is held, live, on the round', !!newLeaf, newLeaf)
  check('the coin given up is spent: no longer held', cs.some((c) => c.leaf === received.leaf && c.state === 'spent'), cs.map((c) => [c.leaf.slice(0, 8), c.state]))
  await shot('settled')

  // --- The exit drill: the new leaf, on-chain from its record alone ---
  await page.eval(`document.querySelector('[data-leaf="${newLeaf.leaf}"] [data-action=exit]').click()`); await idle()
  const exitTxids = []
  for (let i = 0; i < 12; i++) {
    const runs = await page.eval("[...document.querySelectorAll('#leafDrill .leaf-drill-run')].map(d=>d.innerText)")
    const lastRun = runs[runs.length - 1] || ''
    note(`     drill run ${runs.length}: ${lastRun.replace(/\n/g, ' | ')}`)
    for (const m of lastRun.matchAll(/broadcast (?:\S+ )?([0-9a-f]{10})…([0-9a-f]{6})/g)) exitTxids.push(m[1] + '…' + m[2])
    if (/: claimed/.test(lastRun) || /exited/.test(await text('#leafDrill'))) break
    if (/: waiting/.test(lastRun) && /BIP68|exit delay|non-BIP68-final/i.test(lastRun)) { await ctl('/advance', { seconds: 600 }) } else { await ctl('/produce') }
    await click('#btnLeafExitAgain'); await idle()
  }
  const drillText = await text('#leafDrill')
  check('the drill showed each step with its fee', /broadcast .* vB, fee /.test(drillText), exitTxids)
  await shot('exit-claimed')
  const claimLine = (drillText.match(/claim ([0-9a-f]{64})/) || [])[1]
  check('the claim was broadcast', !!claimLine, claimLine)
  await ctl('/produce'); await ctl('/bury')
  await page.waitFor(`(document.querySelector('#leafDrill')||{}).innerText?.includes('The claim is final')`, 180000)
  if (claimLine) {
    const claimTx = await rpc('getrawtransaction', [claimLine, true])
    const outs = claimTx.vout.filter((o) => o.asset === X).map((o) => o.value)
    check('node: the claim is in a block, paying the leaf in X to the wallet', claimTx.confirmations >= 1, { confirmations: claimTx.confirmations, outputs: outs })
  }
  cs = await page.eval("[...document.querySelectorAll('.leaf-coin')].map(d=>({...d.dataset}))")
  check('the drill ends final: the coin is exited', cs.some((c) => c.leaf === newLeaf.leaf && c.state === 'exited'))
  await shot('exit-final')

  // --- The schedule: an unpaid request holds it; a coin's refresh window wakes the page ---
  await set('leafRecvAsset', ''); await set('leafRecvAmount', '')
  await click('#btnLeafReceive'); await idle()
  await page.waitFor("/Receive request/.test(document.querySelector('#leafSync').innerText)", 60000)
  const sched = await text('#leafSync')
  check('the schedule names the unpaid request and why it holds sync to a day', /waiting/.test(sched) && /waits for a payment/.test(sched), sched.split('\n').filter((l) => /Why|Receive request|Next sync/.test(l)))
  await shot('schedule')
  cs = await coins()
  const live = cs.filter((c) => c.state === 'live' && c.refreshFrom)
  const now = Number(await page.eval("document.querySelector('#leafSync').dataset.now"))
  const target = Math.min(...live.map((c) => Number(c.refreshFrom)))
  note(`     live coins ${live.map((c) => c.leaf.slice(0, 8) + ' refresh_from ' + c.refreshFrom).join(', ')}; chain now ${now}`)
  const before = Number(await page.eval("document.querySelector('#leafSync').dataset.lastSyncAt||0"))
  const adv = await ctl('/advance', { seconds: target - now + 600 })
  note(`     advanced the chain's median time to ${adv.median_time}`)
  await page.waitFor(`document.querySelector('#leafParticipations') && [...document.querySelectorAll('.leaf-participation')].filter(p=>/pending/.test(p.innerText)).length>0`, 180000)
  const woke = await page.eval(`({ at: Number(document.querySelector('#leafSync').dataset.lastSyncAt||0), auto: document.querySelector('#leafSync').dataset.lastSyncAuto })`)
  check('the page synced by itself once the refresh window opened, and asked for the refresh', woke.at > before && woke.auto === 'true', woke)
  const r2 = await ctl('/round')
  check('node: the refresh round is final', !!r2.round, r2)
  await page.waitFor(`[...document.querySelectorAll('.leaf-participation')].filter(p=>/released/.test(p.innerText)).length>=2`, 180000)
  check('the page followed the refresh to its new leaf by itself', true)
  await shot('auto-refreshed')

  // --- Every refusal, in the library's words ---
  const refusals = await text('#leafRefusals')
  note('     refusals card: ' + refusals.replace(/\n/g, ' | ').slice(0, 600))
  check('no page error', page.errors.length === 0, page.errors)
}

try { await main() } catch (e) { failures++; note('FAIL ' + e.message); try { await shot('failure') } catch {} } finally {
  try { writeFileSync(join(out, 'console.log'), page.console.join('\n')) } catch {}
  await page.stop(); page.remove(); srv.kill()
  try { rmSync(cliDir, { recursive: true, force: true }) } catch {}
}
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
