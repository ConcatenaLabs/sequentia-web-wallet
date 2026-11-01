#!/usr/bin/env node
// Drives what default mode shows of a vesting allocation, in a headless Chromium, against a
// local regtest operator building batches without a sweep (the harness started with
// ARCA_OPERATOR_NO_SWEEP), the page in default mode throughout:
//
//  1. two vesting distributions (`arca distribute --vest`) from a command-line payer: one to
//     the key of the address the Receive tab shows, vesting a few minutes on; one to the key
//     the Sign tab signs a message with (another receive index) and to the staking key a
//     staker signs a site's sign-in with, vesting a day later;
//  2. before either date: the asset's row, its one figure counting both, a line for each date
//     ("<amount> ORNG vests on <date>"), and Send and Trade refused with the sentence, nothing
//     signed;
//  3. the chain's median time moved past the first date: the page takes that claim up by
//     itself, its line gone, and the coins sent to another wallet's receive code.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) with ARCA_OPERATOR_NO_SWEEP set, at its control
// address, and that repository's command-line wallet (`arca`). The wallet's phrase is read from
// PHRASE_FILE (made there, mode 600, when it does not exist yet), and never written anywhere else.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca PHRASE_FILE=/path/outside/any/repo \
//     node tooling/vesting-drive.mjs <evidence-dir>
//
// Needs pkg/ (the lwk_wasm build), leaves/pkg with the library's `claims` and vest-1, and a
// Chromium (CHROMIUM=…).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { recoverPubkey } from '../signmessage.js'
import { HDKey, mnemonicToSeedSync } from '../btc.js'
import { forbiddenIn } from '../user-trade.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
const phraseFile = process.env.PHRASE_FILE
const out = resolve(process.argv[2] || join(tmpdir(), 'vesting-drive-evidence'))
if (!cliBin || !phraseFile) { console.error('set ARCA_CLI and PHRASE_FILE'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
const work = mkdtempSync(join(tmpdir(), 'vesting-drive-'))
const wallets = {}
const cli = (name, ...args) => {
  wallets[name] = wallets[name] || join(work, 'cli-' + name)
  let text
  try { text = execFileSync(cliBin, ['--datadir', wallets[name], '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}

let failures = 0
let step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
  return ok
}
const page = new Page(undefined, { profile: join(work, 'profile') })
const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })
async function shot (name) {
  step++
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`)
  await page.screenshot(f)
  note(`     screenshot ${f.split('/').pop()}`)
}
const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`)
const click = async (sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`) }
const set = (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
const setMode = async (m) => {
  await click('[data-tab=settings]')
  await page.eval(`(()=>{const c=document.querySelector('#mode${m === 'developer' ? 'Developer' : 'User'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await page.waitFor(`document.querySelector('#tabLeaves').classList.contains('hide') === ${m !== 'developer'}`, 10000)
}
const TICKER = 'ORNG'
const balanceRow = () => page.eval(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); return r ? { total: r.querySelector('.bt-t').innerText.replace(/\\s+/g,' ').trim(), vests: [...r.querySelectorAll('.bt-vests')].map(v=>v.textContent), arriving: [...r.querySelectorAll('.bt-arriving')].map(v=>v.textContent), text: r.innerText.replace(/\\s+/g,' ').trim() } : null })()`)
const headline = () => text('#balTotal')
// The receive request a command-line wallet hands out (`receive`), as a person pastes it.
const receiveCode = (r) => String((r && r.request) || '')
const fillSend = (asset, to, amount) => page.eval(`(()=>{ const r=document.querySelector('#recipients').children[0];
  const s=r.querySelector('.rasset'); s.value=${JSON.stringify(asset)}; s.dispatchEvent(new Event('change'));
  const a=r.querySelector('.raddr'); a.value=${JSON.stringify(to)}; a.dispatchEvent(new Event('input'));
  const b=r.querySelector('.ramt'); b.value=${JSON.stringify(amount)}; b.dispatchEvent(new Event('input')); return s.value===${JSON.stringify(asset)} })()`)
const digits = (s) => BigInt(String(s || '').replace(/[^\d]/g, '') || 0)

async function main () {
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  const st = await ctl('/state')
  const X = st.x
  note(`page ${base}; operator ${st.server}; asset X ${X} shown as ${TICKER}`)
  const create = ['create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca']

  // --- The page's wallet, from the fixed test phrase ---
  await page.open()
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=3000; window.SEQ_LEAVES_CARE_MS=5000; window.SEQ_LEAVES_CLAIMS_MS=5000;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await page.go(base)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  if (!existsSync(phraseFile)) {
    await click('#btnCreate')
    const made = await page.eval('window._pending')
    writeFileSync(phraseFile, made + '\n', { mode: 0o600 })
    await click('#btnCancelCreate')
    note('     a test phrase was made and kept outside the repository (mode 600)')
  }
  await click('#btnImport')
  await set('importPhrase', readFileSync(phraseFile, 'utf8').trim())
  await click('#btnDoImport')
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  await page.eval(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: ${JSON.stringify(TICKER)}, name: 'Drive sale token', precision: 0, local: true } }))`)
  await setMode('developer')
  await click('[data-tab=leaves]')
  await page.waitFor("document.querySelector('#leafJoin')", 30000)
  await set('leafServer', base + 'operator'); await set('leafNodeUrl', base + 'node')
  await set('leafNodeUser', st.node_user); await set('leafNodePassword', st.node_password)
  await set('leafDelay', '1'); await set('leafMinDelay', '1')
  await click('#btnLeafJoin')
  await page.waitFor("document.querySelector('#leafRails')", 120000)
  check('the page wallet joined the operator', true)
  await setMode('user')

  // --- The keys: the Receive tab's, the Sign tab's (index 3), and the staking key a site's
  // sign-in names (the Sign tab's staking-key mode) ---
  const index = Number(await page.eval('(()=>{ try { return addrIndex ?? 0 } catch { return 0 } })()').catch(() => 0)) || 0
  await click('[data-tab=sign]')
  await set('keySignIndex', '3')
  const msg = 'Sign in to the drive site: nonce 4c7e'
  await set('keySignMsg', msg)
  await click('#keySignBtn')
  const keySig = await text('#keySignSig')
  const signKey = Buffer.from(recoverPubkey(msg, keySig)).toString('hex')
  await set('oampSignMode', 'staker')
  await set('oampSignChallenge', msg)
  await click('#oampSignBtn')
  const stakerSig = await text('#oampSignSig')
  const stakerKey = Buffer.from(recoverPubkey(msg, stakerSig)).toString('hex')
  check('the staking key recovered from the Sign tab\'s staker signature is the one it shows', stakerKey === (await text('#oampSignPubkey')).trim().toLowerCase(), stakerKey)
  const recvKey = Buffer.from(HDKey.fromMasterSeed(mnemonicToSeedSync(readFileSync(phraseFile, 'utf8').trim())).derive(`m/84'/1'/0'/0/${index}`).publicKey).toString('hex')
  note(`     keys: receive index ${index} ${recvKey}; Sign tab index 3 ${signKey}; staking key ${stakerKey}`)
  await click('[data-tab=balance]')

  // --- The payer (a command-line wallet) and the two distributions ---
  cli('payer', ...create)
  await ctl('/fund', { script: cli('payer', 'address').script_pubkey, asset: X, amount: 40000000 })
  await ctl('/produce')
  cli('payer', 'board', X, '30000000')
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && cli('payer', 'boards')[0]?.server?.state !== 'credited'; i++) await sleep(500)
  cli('payer', 'sync')
  // The other wallet accepts the short exit delays the browser wallet's coins carry here.
  cli('other', ...create, '--min-exit-delay-units', '1')
  const now0 = (await ctl('/advance', { seconds: 1 })).median_time
  const v1 = now0 + 600
  const v2 = now0 + 86400 + 600
  const distribute = async (name, lines, vest) => {
    const file = join(work, name + '.txt')
    writeFileSync(file, '# key amount\n' + lines.map(([k, v]) => `${k} ${v}`).join('\n') + '\n')
    const q = cli('payer', 'distribute', file, '--asset', X, '--quote')
    const d = cli('payer', 'distribute', file, '--asset', X, '--shown', String(q.fee), '--vest', String(vest), '--days', '7')
    check(`${name}: the payer distributes vesting on ${d.vests}`, d.state === 'pending' && d.vest === vest, { state: d.state, vests: d.vests, error: d.error })
    const built = await ctl('/build')
    cli('payer', 'sync')
    await ctl('/pass'); await ctl('/produce'); await ctl('/bury')
    note(`     ${name}'s round ${JSON.stringify(built).slice(0, 300)}`)
    for (let i = 0; i < 60; i++) { const s = (cli('payer', 'distributions').find((x) => x.vest === vest) || {}).state; if (s === 'released') break; await ctl('/settle'); cli('payer', 'sync'); await sleep(1000) }
    const s = cli('payer', 'distributions').find((x) => x.vest === vest)
    check(`${name} is released`, s && s.state === 'released', s && s.state)
    return d
  }
  const d1 = await distribute('first', [[recvKey, 3000000]], v1)
  const d2 = await distribute('second', [[signKey, 2000000], [stakerKey, 1500000]], v2)

  // --- 2. Before either date: the figure, a line for each date, Send and Trade refused ---
  const want1 = `3,000,000 ${TICKER} vests on ${d1.vests}`
  const want2 = `3,500,000 ${TICKER} vests on ${d2.vests}`
  await page.waitFor(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); return r && r.querySelectorAll('.bt-vests').length === 2 })()`, 180000).catch(() => {})
  const row = await balanceRow()
  check('default mode: the asset held only as what vests has its row, a line for each date', !!row && row.vests.length === 2 && row.vests[0] === want1 && row.vests[1] === want2, row)
  check('the second line counts the claims under the Sign tab\'s key and the staking key (2,000,000 + 1,500,000)', !!row && row.vests[1] === want2)
  check('the figure counts both: 6,500,000', !!row && digits(row.total) === 6500000n, row && row.total)
  check('the row carries none of the words default mode never says', !!row && forbiddenIn(row.text).length === 0, row && forbiddenIn(row.text))
  note(`     headline: ${(await headline()).replace(/\s+/g, ' ')}`)
  await shot('vesting-lines-default-mode')

  // Send: to the other wallet's receive code.
  const codeText = receiveCode(cli('other', 'receive'))
  await click('[data-tab=send]')
  await fillSend(X, codeText, '10')
  const avail = await page.eval("(()=>{ const r=document.querySelector('#recipients').children[0]; return r.innerText.replace(/\\s+/g,' ') })()")
  note(`     the send row: ${avail}`)
  await click('#btnReview')
  await page.waitFor("document.querySelector('#sendErr').textContent.length > 0 || document.querySelector('.modal')", 60000).catch(() => {})
  const sendErr = await text('#sendErr')
  check('Send before the date: refused with the sentence, nothing signed', sendErr === `10 ${TICKER} of this vests on ${d1.vests}, and can be used from then. Nothing has moved.` && !(await page.eval("!!document.querySelector('.modal')")), sendErr)
  await shot('send-refused')

  // Trade: pay ORNG for BTC.
  await click('[data-tab=swap]')
  await page.waitFor("document.querySelector('#userComposerRoot') && document.querySelector('#userComposerRoot').innerText.length > 0", 60000)
  const pick = async (id, hex) => {
    await click('#' + id)
    await page.waitFor(`!!document.querySelector('[data-hex=${JSON.stringify(hex)}]')`, 10000)
    await page.eval(`document.querySelector('[data-hex=${JSON.stringify(hex)}]').click()`)
    await sleep(500)
  }
  await pick('ucPay', X)
  await pick('ucGet', 'BTC')
  await page.eval("(()=>{ const i=document.querySelector('#ucAmount'); i.value='5'; i.dispatchEvent(new Event('input')); return true })()")
  await sleep(800)
  await click('#ucReview')
  await page.waitFor(`document.querySelector('#userComposerRoot').innerText.includes('of this vests on')`, 60000).catch(() => {})
  const tradeText = (await text('#userComposerRoot')).replace(/\s+/g, ' ')
  check('Trade before the date: refused with the sentence', tradeText.includes(`5 ${TICKER} of this vests on ${d1.vests}, and can be used from then. Nothing has moved.`), tradeText.slice(0, 600))
  await shot('trade-refused')
  await click('[data-tab=balance]')

  // --- 3. Past the first date: taken up by itself, then sent ---
  await ctl('/advance', { seconds: v1 - (await ctl('/advance', { seconds: 1 })).median_time + 3600 })
  await ctl('/produce'); await ctl('/bury')
  let after = null
  for (let i = 0; i < 90; i++) {
    after = await balanceRow()
    if (after && after.vests.length === 1 && after.arriving.length === 0 && digits(after.total) >= 6490000n) break
    if (i % 10 === 9) { await ctl('/settle') }
    await sleep(2000)
  }
  check('past the first date: the claim taken up by itself, one line left, the figure unchanged but for the take-up\'s fee', !!after && after.vests.length === 1 && after.vests[0] === want2 && digits(after.total) >= 6490000n, after)
  await shot('after-first-date')
  // What was taken up is spendable once its payment is final.
  for (let i = 0; i < 60; i++) { after = await balanceRow(); if (after && after.arriving.length === 0) break; if (i % 5 === 4) { await ctl('/settle'); await ctl('/round').catch(() => {}) } await sleep(2000) }
  note(`     the row: ${JSON.stringify(after)}`)
  const codeText2 = receiveCode(cli('other', 'receive'))
  await click('[data-tab=send]')
  await page.eval("document.querySelector('#sendErr').textContent=''")
  await fillSend(X, codeText2, '1000000')
  await click('#btnReview')
  await page.waitFor("document.querySelector('#sendErr').textContent.length > 0 || [...document.querySelectorAll('.modal button')].some(b=>b.textContent==='Send')", 60000)
  const err2 = await text('#sendErr')
  if (!err2) {
    await shot('send-review')
    await page.eval("[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Send').click()")
    await page.waitFor("[...document.querySelectorAll('.modal .status')].some(s=>/^Sent |nothing|declined|refused/i.test(s.textContent))", 120000).catch(() => {})
  }
  const sent = await page.eval("[...document.querySelectorAll('.modal .status')].map(s=>s.textContent).join(' | ')")
  check('past the date: 1,000,000 ORNG sent to another wallet\'s receive code', /^Sent 1,?000,?000 ORNG/.test(sent), err2 || sent)
  await shot('sent-after-vesting')
  let got = null
  for (let i = 0; i < 20; i++) { const mb = cli('other', 'mailbox'); if (i === 0 || i === 19) note(`     the other wallet's mailbox: ${JSON.stringify(mb).slice(0, 600)}`); got = [...((mb && mb.accepted) || []), ...((cli('other', 'coins') || []))].filter((c) => c && c.asset === X); if (got.length) break; await sleep(2000) }
  check('the other wallet holds what was sent', got.some((c) => String(c.value) === '1000000'), got.map((c) => [c.value, c.state]))
  check('no page error', page.errors.length === 0, page.errors)
}

try { await main() } catch (e) { failures++; note('FAIL ' + (e && e.stack || e)); try { await shot('failure') } catch {} } finally {
  try { writeFileSync(join(out, 'console.log'), page.console.join('\n')) } catch {}
  try { await page.stop() } catch {}
  srv.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
