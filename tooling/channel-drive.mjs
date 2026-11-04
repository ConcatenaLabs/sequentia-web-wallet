#!/usr/bin/env node
// Drives payments that arrive at once between two web wallets in default mode, each in its own
// headless Chromium on its own origin, against a local regtest operator that makes channel
// leaves (the operator repository's bark-cli/tests/arca_operator_for_browsers.rs, run with
// ARCA_OPERATOR_CHANNELS):
//
//  1. two new wallets join the page's operator by themselves; a command-line payer pays each
//     one's receive code; `care` opens a channel in each by itself, in the next round;
//  2. both pages opened again on the page's own schedule; A pays B's receive code three times and
//     B pays A's three times, in the Send tab: each "Sent", each in the receiver's figure in under
//     a second from the tap on Send, no block made meanwhile, every figure right;
//  3. A pays B more than B's channel can take: the same review and "Sent", paid as any payment
//     to a receive code, B's figure moves, neither channel moved;
//  4. B's browser closed, A pays B's code: B's figure shows it when B opens again;
//  5. default mode's screens say none of the words it never says;
//  6. developer mode: A closes its channel into a round, B takes its channel home on the chain.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca node tooling/channel-drive.mjs <evidence-dir>
//
// with ARCA_OPERATOR_CHANNELS at 1000000 (at most 1900000: A's channel must hold more than B's
// can take, for step 3).
//
// Needs pkg/ (the lwk_wasm build), leaves/pkg with the library's channel routing, and a
// Chromium (CHROMIUM=…).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'
import { expandRequest } from '../pay-code.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
if (!cliBin) { console.error('ARCA_CLI must name the command-line wallet binary'); process.exit(2) }
const out = resolve(process.argv[2] || join(tmpdir(), 'channel-drive-evidence'))
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(log, l + '\n') }
const TICKER = 'XCH'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}

let failures = 0
let step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}

const work = mkdtempSync(join(tmpdir(), 'channel-drive-'))
const cliDir = join(work, 'cli-payer')
const cli = (...args) => {
  let text
  try { text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}
const servers = []
function serve () {
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })
  servers.push(srv)
  return new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
}

// The processes of a browser on `profile` (this run's own temporary directory), by their command
// lines; a stopped browser's helpers can outlive it for a moment and keep the page's lock.
function onProfile (profile) {
  const out = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try { if (readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').includes(`--user-data-dir=${profile}`)) out.push(Number(d)) } catch {}
  }
  return out
}
async function stopBrowser (w) {
  await w.page.stop()
  for (let i = 0; i < 60 && (onProfile(w.profile).length || existsSync(join(w.profile, 'SingletonLock'))); i++) await sleep(500)
  for (const pid of onProfile(w.profile)) { try { process.kill(pid) } catch {} }
  await sleep(500)
}

const wallets = []
function wallet (name, base, operator) {
  const w = { name, base, operator, profile: join(work, 'profile-' + name) }
  wallets.push(w)
  w.page = new Page(undefined, { profile: w.profile })
  w.eval = (js) => w.page.eval(js)
  w.click = (sel) => w.page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
  w.tab = (t) => w.click(`#tabs button[data-tab="${t}"]`)
  w.shot = async (what) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${name}-${what}.png`); await w.page.screenshot(f); note(`     screenshot ${f.split('/').pop()}`) }
  // The asset's one figure on the Balance tab, as a number (the drive's asset has no decimals).
  w.figure = async () => {
    const t = await w.eval(`(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent.trim()===${JSON.stringify(TICKER)}); return r ? (r.querySelector('.bt-t')||{}).innerText||'' : '' })()`)
    const m = String(t).replace(/^Total\s*/, '').replace(/[,\s]/g, '').match(/\d+/)
    return m ? Number(m[0]) : 0
  }
  w.channels = () => w.eval('(window.__leavesApi && window.__leavesApi.channels()) || []')
  w.code = async () => {
    await w.tab('receive')
    return w.page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && /^bitcoin:/i.test(a.textContent) ? a.textContent : false })()", 240000)
  }
  return w
}

// `fast`: the schedule read every 3 s and care every 4 s, so the wallets join and open their
// channels within the drive; without it the page's own schedule, as a person's page runs.
async function open (w, fresh, fast = false) {
  await w.page.open()
  // A browser killed on this profile restores its last tab when it starts again, and that tab
  // holds the page's one-tab lock: every page but the one driven is closed.
  for (const t of await (await fetch(`http://127.0.0.1:${w.page.port}/json`)).json()) {
    if (t.type === 'page' && t.webSocketDebuggerUrl !== w.page.ws.url) { try { await fetch(`http://127.0.0.1:${w.page.port}/json/close/${t.id}`) } catch {} }
  }
  await w.page.send('Network.enable')
  await w.page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await w.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${fast ? 'window.SEQ_LEAVES_TICK_MS=3000; window.SEQ_LEAVES_CARE_MS=4000;' : ''} window.SEQ_TEST_HOOKS=true;
    window.SEQ_ARCA = { server: location.origin + '/operator', node_url: location.origin + '/node', operator: ${JSON.stringify(w.operator)} };
    window.SEQ_BTC_ARK = null;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await w.page.go(w.base)
  // A browser just stopped on this profile can hold the page's one-tab lock for a moment after
  // its process is gone: the page then says the wallet is open in another tab, and is loaded again.
  for (let i = 0; i < 10 && !fresh; i++) {
    const other = await w.page.waitFor("(()=>{ const t=document.body.innerText; if(/open in another tab/i.test(t)) return 'other'; const a=document.querySelector('#app'); return a && getComputedStyle(a).display !== 'none' ? 'open' : false })()", 120000).catch(() => 'neither')
    if (other !== 'other') break
    note(`     ${w.name}'s page found the wallet open in another tab (the browser just stopped); loaded again`)
    await sleep(3000)
    await w.page.go(w.base)
  }
  if (fresh) {
    await w.page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 120000)
    await w.click('#btnCreate')
    await w.page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await w.click('#btnConfirm')
  }
  await w.page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 120000)
    .catch(async (e) => { note(`     ${w.name}'s page: ` + JSON.stringify(String(await w.eval('document.body.innerText')).slice(0, 400))); throw e })
}

// The Sequentia request a receive code carries, in the library's spelling (a code carries it short
// when it can): what the command-line payer pays, and what names the receiver's channels.
let opInfo = null
const sequentiaPart = (code) => {
  const v = decodeURIComponent((code.split('?')[1] || '').split('&').find((p) => /^sequentia=/i.test(p)).slice('sequentia='.length))
  return expandRequest(v.toLowerCase().startsWith('sqr1') ? v.toLowerCase() : v, opInfo) || v
}

// A pays B's receive code in the Send tab, as a person does: the code, the asset, the amount,
// Review, Send. B, open, notes when its figure first reads `expectB`.
async function pay (a, b, amount, expectB) {
  const code = await b.code()
  await b.tab('balance')
  await b.eval(`(()=>{ window.__seen = null; const t=setInterval(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent.trim()===${JSON.stringify(TICKER)}); const v=r ? Number((((r.querySelector('.bt-t')||{}).innerText||'').replace(/^Total\\s*/,'').replace(/[,\\s]/g,'').match(/\\d+/)||[0])[0]) : 0; if(v===${expectB}){ window.__seen=Date.now(); clearInterval(t) } }, 20); return true })()`)
  return sendTo(a, code, amount)
}
async function sendTo (a, code, amount) {
  await a.tab('send')
  await a.page.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(TICKER)})`, 120000)
  await a.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(code)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
    const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(TICKER)}); s.value=o.value; s.dispatchEvent(new Event('change'));
    r.querySelector('.ramt').value=${JSON.stringify(String(amount))}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
  await a.click('#btnReview')
  const review = await a.page.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
  const t0 = await a.eval("(()=>{ const t=Date.now(); document.querySelector('.modal button.primary').click(); return t })()")
  const done = await a.page.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending/.test(t) ? t : false })()", 300000)
    .catch(async (e) => { note('     still: ' + JSON.stringify(await a.eval("({ status: document.querySelector('.modal .status')?.textContent, modal: document.querySelector('.modal')?.innerText, busy: window.__leavesApi.state.busy, asked: window.__leavesApi.state.asked, queued: window.__leavesApi.state.queued })")) + ' console: ' + a.page.console.slice(-10).join(' | ')); throw e })
  const tDone = await a.eval('Date.now()')
  await a.eval("(()=>{ for(const m of document.querySelectorAll('.modal')) m.remove(); return true })()")
  return { review: review.replace(/\s+/g, ' '), done, t0, sentMs: tDone - t0 }
}

async function main () {
  const st = await ctl('/state')
  const X = st.x
  const A = wallet('A', await serve(), null); const B = wallet('B', await serve(), null)
  const info = await (await fetch(A.base + 'operator/v1/info')).json()
  A.operator = B.operator = info.operator
  opInfo = { operator: info.operator, genesis_hash: st.genesis_hash }
  const capacity = (info.assets.find((a) => a.asset === X) || {}).channels
  check('the operator makes channel leaves of the drive\'s asset', !!capacity, capacity)
  note(`pages A ${A.base}, B ${B.base}; operator ${info.operator}; asset ${X}`)

  // The payer, with leaves of X to pay the two receive codes.
  cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca')
  await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: 30000000 })
  await ctl('/produce')
  cli('board', X, '20000000')
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await sleep(500)
  cli('sync')

  for (const w of [A, B]) {
    await open(w, true, true)
    await w.eval(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: '${TICKER}', name: 'Drive asset', precision: 0, local: true } }))`)
    const code = await w.code()
    check(`${w.name} joined the operator by itself; Receive gives a receive code`, /sequentia=/.test(code), code.slice(0, 40) + '…')
    const p = cli('send', sequentiaPart(code), '--asset', X, '--amount', '4000000')
    check(`the payer paid ${w.name}'s receive code 4000000`, p.route === 'leaf' && !p.error, p.error || p.route)
  }
  for (const w of [A, B]) await w.page.waitFor('(window.__leavesApi && window.__leavesApi.state.participations || []).some(p=>p.state==="pending")', 300000)
  note('     each wallet\'s care asked for a channel in the next round')
  const r1 = await ctl('/round')
  note(`     the round: ${JSON.stringify(r1)}`)
  for (const w of [A, B]) await w.page.waitFor('(window.__leavesApi && window.__leavesApi.channels() || []).some(c=>c.coin_state==="live" && c.final)', 300000)
  const [ca, cb] = [(await A.channels()).find((c) => c.coin_state === 'live'), (await B.channels()).find((c) => c.coin_state === 'live')]
  check('each wallet opened a channel by itself, in default mode', !!ca && !!cb, { A: [ca.leaf_id, ca.balance, ca.operator_side], B: [cb.leaf_id, cb.balance, cb.operator_side] })
  // Both pages opened again on the page's own schedule (care every ten minutes), as a person's
  // page runs: the payments below meet what a person's would.
  for (const w of [A, B]) {
    await stopBrowser(w)
    w.page = new Page(undefined, { profile: w.profile })
    await open(w, false)
    await w.page.waitFor('(window.__leavesApi && window.__leavesApi.channels() || []).some(c=>c.coin_state==="live" && c.final)', 300000)
  }
  // What a page does once at open (its sync, then care after twenty quiet seconds) is done first.
  for (const w of [A, B]) await w.page.waitFor('!!(window.__leavesApi && window.__leavesApi.state.lastCare)', 120000).catch(() => note(`     ${w.name}: no care at open within two minutes`))
  note('     both pages opened again on their own schedule')
  for (const w of [A, B]) { await w.tab('balance'); await sleep(1500) }
  let fa = await A.figure(); let fb = await B.figure()
  check('each figure is what the wallet was paid, less the round\'s fee at most', fa <= 4000000 && fa > 3990000 && fb <= 4000000 && fb > 3990000, { A: fa, B: fb })
  await A.shot('balance-channel-open')
  const code0 = await B.code(); await B.shot('receive-code')
  check('B\'s receive code names its channel', sequentiaPart(code0) && JSON.stringify(JSON.parse(Buffer.from(sequentiaPart(code0).split(':')[1], 'hex').toString())).includes(cb.leaf_id))

  // --- Three payments each way ---
  const h0 = (await ctl('/state')).tip
  const times = []
  for (const [p, r, amt] of [[A, B, 100000], [B, A, 70000], [A, B, 25000], [B, A, 40000], [A, B, 5000], [B, A, 15000]]) {
    const wantP = (p === A ? fa : fb) - amt
    const wantR = (r === A ? fa : fb) + amt
    const t = await pay(p, r, amt, wantR)
    await r.page.waitFor('window.__seen !== null', 10000).catch(() => {})
    const seen = await r.eval('window.__seen')
    await p.tab('balance'); await sleep(300)
    const gotP = await p.figure(); const gotR = await r.figure()
    if (p === A) { fa = gotP; fb = gotR } else { fb = gotP; fa = gotR }
    const ms = seen ? seen - t.t0 : null
    times.push(ms)
    check(`${p.name} pays ${r.name} ${amt}: Sent, received in under a second, both figures right`,
      /^Sent/.test(t.done) && ms !== null && ms < 1000 && gotP === wantP && gotR === wantR && !forbiddenIn(t.review).length,
      { review: t.review, done: t.done, sent_ms: t.sentMs, received_ms: ms, payer: [gotP, wantP], receiver: [gotR, wantR] })
  }
  await A.shot('balance-after-six'); await B.shot('balance-after-six')
  const h1 = (await ctl('/state')).tip
  check('no round between: no block made while the six payments went', h1 === h0, { before: h0, after: h1 })
  note(`     received in (ms from Send): ${JSON.stringify(times)}`)

  // --- A payment B's channel cannot take: paid as any other payment to a receive code ---
  // Past the operator's side of B's channel, the operator refuses it with nothing standing, and
  // the library pays the code's leaf instead; the person sees the same review and "Sent".
  {
    const chB = (await B.channels()).find((c) => c.coin_state === 'live')
    const chA = (await A.channels()).find((c) => c.coin_state === 'live')
    const amt = Number(chB.operator_side) + 50000
    note(`     B's channel takes ${chB.operator_side} more at most; A's channel holds ${chA.balance}; A pays B ${amt}`)
    const t = await pay(A, B, amt, fb + amt)
    await B.page.waitFor('window.__seen !== null', 120000).catch(() => {})
    const seen = await B.eval('window.__seen')
    await A.tab('balance'); await sleep(300)
    const gotA = await A.figure(); const gotB = await B.figure()
    const chA2 = (await A.channels()).find((c) => c.leaf_id === chA.leaf_id)
    const chB2 = (await B.channels()).find((c) => c.leaf_id === chB.leaf_id)
    check('a payment B\'s channel cannot take is paid as any other: Sent, the same review, B\'s figure moves, neither channel moved',
      /^Sent/.test(t.done) && !forbiddenIn(t.review).length && gotB === fb + amt && gotA <= fa - amt && fa - amt - gotA < 5000 &&
        chA2.balance === chA.balance && chB2.credit === chB.credit,
      { review: t.review, done: t.done, received_ms: seen ? seen - t.t0 : null, payer: [gotA, fa - amt], receiver: [gotB, fb + amt],
        channel_a: [chA.balance, chA2.balance], channel_b_credit: [chB.credit, chB2.credit] })
    fa = gotA; fb = gotB
  }

  // --- B closed while A pays it ---
  const codeB = await B.code()
  await stopBrowser(B)
  note('     B\'s browser is closed')
  const t = await sendTo(A, codeB, 33000)
  await A.tab('balance'); await sleep(300)
  fa -= 33000
  check('A paid B while B was closed', /^Sent/.test(t.done) && (await A.figure()) === fa, { done: t.done, a: await A.figure(), want: fa })
  B.page = new Page(undefined, { profile: B.profile })
  await open(B, false)
  await B.tab('balance')
  await B.page.waitFor(`(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent.trim()===${JSON.stringify(TICKER)}); return r && Number((((r.querySelector('.bt-t')||{}).innerText||'').replace(/^Total\\s*/,'').replace(/[,\\s]/g,'').match(/\\d+/)||[0])[0])===${fb + 33000} })()`, 240000).catch(() => {})
  const fbAfter = await B.figure()
  check('B, opened again, shows the payment made while it was closed', fbAfter === fb + 33000, { b: fbAfter, want: fb + 33000 })
  fb = fbAfter
  await B.shot('balance-after-offline-payment')

  // --- The words default mode never says ---
  for (const w of [A, B]) {
    const parts = []
    for (const tb of ['balance', 'send', 'receive']) { await w.tab(tb); await sleep(400); parts.push(await w.eval("(document.querySelector('section:not(.hide)[data-panel]')||document.body).innerText")) }
    const words = forbiddenIn(parts.join('\n'))
    check(`${w.name}: default mode's Balance, Send and Receive say none of the words`, !words.length, words)
  }

  // --- Developer mode: A closes into a round, B takes its channel home on the chain ---
  const toDev = async (w) => {
    await w.tab('settings')
    await w.eval("(()=>{const c=document.querySelector('#modeDeveloper'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()")
    await w.page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')", 10000)
    await w.tab('leaves')
    await w.page.waitFor("document.querySelector('#leafChannels .leaf-channel')", 120000)
  }
  const idle = (w) => w.page.waitFor("!document.querySelector('.leaf-busy')", 300000)
  await toDev(A)
  await A.shot('channels-developer-mode')
  await A.eval("document.querySelector('#leafChannels .leaf-channel[data-state=live] [data-action=close]').click()")
  await A.page.waitFor("document.querySelector('#btnLeafSettleConfirm')", 120000)
  await A.click('#btnLeafSettleConfirm')
  await idle(A)
  const r2 = await ctl('/round')
  note(`     A's close: round ${JSON.stringify(r2)}`)
  await A.page.waitFor('!(window.__leavesApi.channels()||[]).some(c=>c.coin_state==="live")', 300000).catch(() => {})
  await A.page.waitFor("[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live')", 300000).catch(() => {})
  const coinsA = await A.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>({...d.dataset}))")
  await A.tab('balance'); await sleep(1000)
  const faClosed = await A.figure()
  check('A closed its channel into a round: its figure less the round\'s fee at most', faClosed <= fa && fa - faClosed < 20000 && !(await A.channels()).some((c) => c.coin_state === 'live'),
    { before: fa, after: faClosed, coins: coinsA.map((c) => [c.leaf, c.state, c.value]) })
  await A.shot('balance-after-close')

  await toDev(B)
  const bLeaf = (await B.channels()).find((c) => c.coin_state === 'live').leaf_id
  // A channel's settle pays its fee from a coin of the wallet's on the chain, in any accepted
  // asset; default mode boards every such coin, so B is given one here, in developer mode.
  for (let i = 0; i < 5; i++) {
    await idle(B)
    await B.click('#btnLeafAddress')
    if (await B.page.waitFor("document.querySelector('#leafAddress')", 20000).then(() => true, () => false)) break
  }
  await ctl('/fund', { script: await B.eval("document.querySelector('#leafAddress').dataset.script"), asset: X, amount: 1000000 })
  await ctl('/produce'); await ctl('/bury')
  // Each run's answer is the library's (`channel_exit`); once the coin is home it leaves the
  // Channels card, and its state in the coins says so.
  let last = ''
  for (let i = 0; i < 25; i++) {
    const row = await B.eval(`!!document.querySelector('#leafChannels .leaf-channel[data-leaf=${JSON.stringify(bLeaf)}] [data-action=exit]')`)
    if (row) {
      await B.eval(`document.querySelector('#leafChannels .leaf-channel[data-leaf=${JSON.stringify(bLeaf)}] [data-action=exit]').click()`)
      await idle(B)
    }
    last = await B.eval(`(()=>{ const S=window.__leavesApi.state; const e=S.error; if(e && e.what==='channel_exit') return 'refused: ' + e.e.message;
      const v=(S.channelExit && S.channelExit.leaf===${JSON.stringify(bLeaf)} && S.channelExit.value) || {};
      const c=(S.coins||[]).find(x=>x.leaf_id===${JSON.stringify(bLeaf)});
      return 'exit: ' + (v.state||'') + (v.next ? ' · next: ' + v.next : '') + (v.error ? ' · ' + v.error : '') + ' · coin ' + (c ? c.state : 'gone') })()`)
    note(`     B's exit, run ${i + 1}: ${last}`)
    if (/coin exited/.test(last)) break
    if (/waiting/.test(last)) await ctl('/advance', { seconds: 200000 })
    await ctl('/produce'); await ctl('/bury')
    if (!row) await sleep(3000)
  }
  check('B took its channel home on the chain alone', /coin exited/.test(last), last)
  await B.shot('channel-exit-developer-mode')
  check('no page error', wallets.every((w) => !w.page.errors.length), wallets.map((w) => w.page.errors))
}

try { await main() } catch (e) { failures++; note('FAIL ' + (e.stack || e.message)) } finally {
  for (const w of wallets) { try { writeFileSync(join(out, `console-${w.name}.log`), w.page.console.join('\n')) } catch {} try { await w.page.stop() } catch {} }
  for (const s of servers) s.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
