#!/usr/bin/env node
// Drives payments that arrive at once (instant-pay.js) between two web wallets, each in its
// own headless Chromium on its own origin, against a local regtest operator that makes
// channel leaves (the harness with ARCA_OPERATOR_CHANNELS):
//
//  1. each page joins the operator and boards an on-chain coin (developer mode), then, in
//     user mode, `care` opens a channel by itself in the next round;
//  2. in user mode, A pays B's payment code (B's Receive tab) three times and B pays A's three
//     times: each Settled in the payer's review, each in the receiver's figure in under a
//     second, no round between, every figure right at every step;
//  3. B's browser closed, A pays B: B's figure shows it when B opens again;
//  4. user mode's screens carry no developer word;
//  5. developer mode: A closes its channel into a round (a plain leaf of its side), and B
//     exits its channel alone on the chain, home in its on-chain coins.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) with ARCA_OPERATOR_CHANNELS set, at its
// control address. Needs pkg/ (the lwk_wasm build), leaves/pkg with the library's channel
// commands, and a Chromium (CHROMIUM=…).
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 node tooling/channel-drive.mjs <evidence-dir>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const out = resolve(process.argv[2] || join(tmpdir(), 'channel-drive-evidence'))
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }
const TICKER = 'XCH'
const BOARD = 4_000_000

export const DEVELOPER_WORDS = ['leaf', 'leaves', 'round', 'plan', 'claim', 'distribution', 'expiry', 'operator', 'forfeit',
  'covenant', 'anchor', 'atoms', 'unroll', 'refresh', 'csv', 'channel', 'note', 'fold', 'state']

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

const pages = []
const work = mkdtempSync(join(tmpdir(), 'channel-drive-'))
const servers = []
function serve () {
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })
  servers.push(srv)
  return new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
}

// One wallet: its page, its origin, its profile.
function wallet (name, base) {
  const w = { name, base, profile: join(work, 'profile-' + name) }
  pages.push(w)
  w.page = new Page(undefined, { profile: w.profile })
  w.eval = (js) => w.page.eval(js)
  w.click = (sel) => w.page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`)
  w.set = (id, v) => w.page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`)
  w.idle = () => w.page.waitFor("!document.querySelector('.leaf-busy')", 180000)
  w.shot = async (what) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${name}-${what}.png`); await w.page.screenshot(f); note(`     screenshot ${f.split('/').pop()}`) }
  w.mode = async (m) => {
    await w.click('[data-tab=settings]')
    await w.eval(`(()=>{const c=document.querySelector('#mode${m === 'developer' ? 'Developer' : 'User'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
    await w.page.waitFor(`document.querySelector('#tabLeaves').classList.contains('hide') === ${m !== 'developer'}`, 10000)
  }
  // The asset's one figure (the row's total), as the page shows it, in atoms (precision 0).
  w.figure = async () => {
    const t = await w.eval(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); return r ? r.querySelector('.bt-t').innerText : '' })()`)
    const m = String(t).replace(/[,\s]/g, '').match(/\d+/)
    return m ? Number(m[0]) : 0
  }
  // The library's own view, read from the page (developer mode's data, read in either mode).
  w.channels = () => w.eval("(window.__leavesApi && window.__leavesApi.channels()) || []")
  return w
}

async function open (w, fresh) {
  await w.page.open()
  await w.page.send('Network.enable')
  await w.page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await w.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=3000; window.SEQ_LEAVES_CARE_MS=4000; window.SEQ_TEST_HOOKS=true;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await w.page.go(w.base)
  if (fresh) {
    await w.page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
    await w.click('#btnCreate')
    await w.page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await w.click('#btnConfirm')
  }
  await w.page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
}

// Joins the operator and boards a coin, in developer mode; back in user mode.
async function setUp (w, st) {
  await w.eval(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(st.x)}: { ticker: '${TICKER}', name: 'Drive asset', precision: 0, local: true } }))`)
  await w.mode('developer')
  await w.click('[data-tab=leaves]')
  await w.page.waitFor("document.querySelector('#leafJoin')", 60000)
  await w.set('leafServer', w.base + 'operator'); await w.set('leafNodeUrl', w.base + 'node')
  await w.set('leafNodeUser', st.node_user); await w.set('leafNodePassword', st.node_password)
  await w.set('leafDelay', '1'); await w.set('leafMinDelay', '1')
  await w.click('#btnLeafJoin')
  await w.page.waitFor("document.querySelector('#leafRails')", 180000)
  await w.idle()
  await w.click('#btnLeafAddress')
  await w.page.waitFor("document.querySelector('#leafAddress')", 60000)
  const script = await w.eval("document.querySelector('#leafAddress').dataset.script")
  await ctl('/fund', { script, asset: st.x, amount: BOARD + 1_000_000 })
  await ctl('/produce')
  await w.idle()
  await w.click('#btnLeafSync')
  await w.page.waitFor(`[...document.querySelectorAll('#leafBoardAsset option')].some(o=>o.value===${JSON.stringify(st.x)})`, 120000)
  await w.set('leafBoardAsset', st.x); await w.set('leafBoardAmount', BOARD)
  await w.click('#btnLeafBoard')
  await w.page.waitFor("document.querySelector('#btnLeafBoardConfirm')", 120000)
  await w.click('#btnLeafBoardConfirm')
  await w.idle()
  await ctl('/produce'); await ctl('/bury')
}

const now = () => Date.now()

// A pays B's payment code `amount` in user mode, through the Send tab: the payer's review,
// Confirm, Settled; the time from Confirm to B's figure moving.
async function pay (a, b, amount, expectB) {
  await b.click('[data-tab=receive]')
  await b.page.waitFor("!document.querySelector('#recvInstantCard').classList.contains('hide')", 60000)
  const code = await b.eval("document.querySelector('#recvInstant').textContent")
  // B records when its figure first reads what it should.
  await b.click('[data-tab=balance]')
  await b.eval(`(()=>{ window.__seen = null; const want=${expectB}; const t=setInterval(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); const v=r ? Number(r.querySelector('.bt-t').innerText.replace(/[,\\s]/g,'').match(/\\d+/)||[0])[0] : 0; if(v===want){ window.__seen=Date.now(); clearInterval(t) } }, 20); return true })()`)
  await a.click('[data-tab=send]')
  await a.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); const i=r.querySelector('.raddr'); i.value=${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); return true })()`)
  await a.page.waitFor(`[...document.querySelectorAll('#recipients .rasset option')].some(o=>o.textContent===${JSON.stringify(TICKER)})`, 30000)
  await a.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); const s=r.querySelector('.rasset'); s.value=[...s.options].find(o=>o.textContent===${JSON.stringify(TICKER)}).value; s.dispatchEvent(new Event('change')); const m=r.querySelector('.ramt'); m.value=${JSON.stringify(String(amount))}; m.dispatchEvent(new Event('input')); return true })()`)
  await a.click('#btnReview')
  await a.page.waitFor("[...document.querySelectorAll('.modal .lbl')].some(l=>l.textContent==='Confirm payment')", 30000)
  const review = await a.eval("document.querySelector('.modal .card').innerText.replace(/\\s+/g,' ')")
  const t0 = await a.eval("(()=>{ const ok=document.querySelector('.modal .primary'); const t=Date.now(); ok.click(); return t })()")
  await a.page.waitFor("document.querySelector('#instantState') && document.querySelector('#instantState').textContent==='Settled'", 60000)
  const settled = await a.eval('Date.now()')
  await a.eval("(()=>{ const m=document.querySelector('.modal'); if(m) m.remove(); return true })()")
  await b.page.waitFor('window.__seen !== null', 15000).catch(() => {})
  const seen = await b.eval('window.__seen')
  return { review, settledMs: settled - t0, receivedMs: seen ? seen - t0 : null }
}

async function main () {
  const st = await ctl('/state')
  note(`operator ${st.server}; node ${st.node_url}; asset X ${st.x}`)
  const A = wallet('A', await serve())
  const B = wallet('B', await serve())
  note(`pages: A ${A.base}, B ${B.base}`)
  for (const w of [A, B]) { await open(w, true); await setUp(w, st) }
  // The boards credited, the coins live; care (user mode) opens the channels.
  for (const w of [A, B]) {
    await w.page.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.state==='live')`, 240000)
    await w.mode('user')
    await w.click('[data-tab=balance]')
  }
  // care runs every few seconds here: each wallet's channel participation stands.
  const roundBefore = await ctl('/state')
  for (const w of [A, B]) await w.page.waitFor("(window.__leavesApi && window.__leavesApi.state.participations || []).some(p=>p.state==='pending' || p.state==='accepted')", 240000)
  const r1 = await ctl('/round')
  note(`     the round that opens both channels: ${JSON.stringify(r1)}`)
  for (const w of [A, B]) await w.page.waitFor("(window.__leavesApi && window.__leavesApi.channels() || []).some(c=>c.coin_state==='live' && c.final)", 240000)
  const [ca, cb] = [(await A.channels())[0], (await B.channels())[0]]
  check('each wallet opened a channel by itself (care, user mode)', !!ca && !!cb, { A: ca && [ca.leaf_id, ca.balance, ca.operator_side], B: cb && [cb.leaf_id, cb.balance, cb.operator_side] })
  await new Promise((r) => setTimeout(r, 2000))
  let fa = await A.figure(); let fb = await B.figure()
  note(`     figures: A ${fa}, B ${fb}`)
  await A.shot('balance-user-mode-channel-open'); await B.click('[data-tab=receive]'); await B.shot('receive-user-mode-code')
  const rounds0 = (await ctl('/rpc', { method: 'getblockcount', params: [] }))

  // --- Three payments each way, user mode ---
  const amounts = [[A, B, 100000], [B, A, 70000], [A, B, 25000], [B, A, 40000], [A, B, 5000], [B, A, 15000]]
  const times = []
  for (const [p, r, amt] of amounts) {
    const expectP = (p === A ? fa : fb) - amt
    const expectR = (r === A ? fa : fb) + amt
    const t = await pay(p, r, amt, expectR)
    await p.click('[data-tab=balance]')
    await p.page.waitFor(`(async()=>true)()`)
    const gotP = await p.figure(); const gotR = await r.figure()
    if (p === A) { fa = gotP; fb = gotR } else { fb = gotP; fa = gotR }
    times.push(t.receivedMs)
    check(`${p.name} pays ${r.name} ${amt}: Settled, ${r.name} sees it in under a second, both figures right`,
      /arrives\s*at once/i.test(t.review) && t.receivedMs !== null && t.receivedMs < 1000 && gotP === expectP && gotR === expectR,
      { review: t.review, settled_ms: t.settledMs, received_ms: t.receivedMs, payer: [gotP, expectP], receiver: [gotR, expectR] })
  }
  await A.shot('balance-after-six'); await B.shot('balance-after-six')
  const rounds1 = (await ctl('/rpc', { method: 'getblockcount', params: [] }))
  check('no round between: no block made while the six payments went', rounds1 === rounds0, { before: rounds0, after: rounds1 })
  note(`     received in (ms): ${JSON.stringify(times)}`)

  // --- B offline ---
  await B.click('[data-tab=receive]')
  const codeB = await B.eval("document.querySelector('#recvInstant').textContent")
  await B.page.stop()
  for (let i = 0; i < 60 && existsSync(join(B.profile, 'SingletonLock')); i++) await new Promise((r) => setTimeout(r, 500))
  note('     B\'s browser is closed')
  await A.click('[data-tab=send]')
  await A.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); const i=r.querySelector('.raddr'); i.value=${JSON.stringify(codeB)}; i.dispatchEvent(new Event('input')); const s=r.querySelector('.rasset'); s.value=[...s.options].find(o=>o.textContent===${JSON.stringify(TICKER)}).value; s.dispatchEvent(new Event('change')); const m=r.querySelector('.ramt'); m.value='33000'; m.dispatchEvent(new Event('input')); return true })()`)
  await A.click('#btnReview')
  await A.page.waitFor("[...document.querySelectorAll('.modal .lbl')].some(l=>l.textContent==='Confirm payment')", 30000)
  await A.eval("document.querySelector('.modal .primary').click()")
  await A.page.waitFor("document.querySelector('#instantState') && document.querySelector('#instantState').textContent==='Settled'", 60000)
  await A.eval("(()=>{ const m=document.querySelector('.modal'); if(m) m.remove(); return true })()")
  await A.click('[data-tab=balance]')
  fa -= 33000
  check('A paid B while B was closed: Settled for A', (await A.figure()) === fa, { a: await A.figure(), want: fa })
  B.page = new Page(undefined, { profile: B.profile })
  await open(B, false)
  await B.click('[data-tab=balance]')
  await B.page.waitFor(`(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); return r && Number(r.querySelector('.bt-t').innerText.replace(/[,\\s]/g,'').match(/\\d+/)||[0])[0]===${fb + 33000} })()`, 180000).catch(() => {})
  const fbAfter = await B.figure()
  check('B, opened again, shows the payment made while it was closed', fbAfter === fb + 33000, { b: fbAfter, want: fb + 33000 })
  fb = fbAfter
  await B.shot('balance-after-offline-payment')

  // --- User mode carries no developer word ---
  for (const w of [A, B]) {
    const parts = []
    for (const t of ['balance', 'send', 'receive']) { await w.click(`[data-tab=${t}]`); await new Promise((r) => setTimeout(r, 400)); parts.push(await w.eval("(document.querySelector('section:not(.hide)[data-panel]')||document.body).innerText")) }
    const words = DEVELOPER_WORDS.filter((x) => new RegExp(`\\b${x}\\b`, 'i').test(parts.join('\n').replace(/^Refresh$/gm, '')))
    check(`${w.name}: user mode's Balance, Send and Receive carry no developer word`, words.length === 0, words)
  }

  // --- A closes into a round; B exits alone ---
  await A.mode('developer'); await A.click('[data-tab=leaves]')
  await A.page.waitFor("document.querySelector('#leafChannels .leaf-channel')", 60000)
  await A.shot('channels-developer-mode')
  const aSide = Number((await A.channels())[0].balance)
  await A.eval("document.querySelector('#leafChannels .leaf-channel [data-action=close]').click()")
  await A.page.waitFor("document.querySelector('#btnLeafSettleConfirm')", 120000)
  await A.click('#btnLeafSettleConfirm')
  await A.idle()
  const r2 = await ctl('/round')
  note(`     A's close: round ${JSON.stringify(r2)}`)
  await A.page.waitFor("!(window.__leavesApi.channels()||[]).some(c=>c.coin_state==='live')", 240000).catch(() => {})
  await A.click('#btnLeafSync'); await A.idle()
  const coinsA = await A.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>({...d.dataset}))")
  await A.mode('user'); await A.click('[data-tab=balance]')
  await new Promise((r) => setTimeout(r, 1500))
  const faClosed = await A.figure()
  check('A closed its channel into a round: a plain leaf of its side, its figure less the round\'s fee at most',
    faClosed <= fa && fa - faClosed < 20000 && coinsA.some((c) => c.state === 'live'), { side: aSide, before: fa, after: faClosed, coins: coinsA.map((c) => [c.leaf, c.state, c.value]) })
  await A.shot('balance-after-close')

  await B.mode('developer'); await B.click('[data-tab=leaves]')
  await B.page.waitFor("document.querySelector('#leafChannels .leaf-channel')", 60000)
  const bChannel = (await B.channels()).find((c) => c.coin_state === 'live')
  let last = null
  for (let i = 0; i < 20; i++) {
    await B.eval(`document.querySelector('#leafChannels .leaf-channel[data-leaf=${JSON.stringify(bChannel.leaf_id)}] [data-action=exit]').click()`)
    await B.idle()
    last = await B.eval("(document.querySelector('#leafChannelExit')||{}).textContent||''")
    note(`     B's exit, run ${i + 1}: ${last}`)
    if (/exit: exited/.test(last)) break
    if (/waiting/.test(last)) await ctl('/advance', { seconds: 900 })
    await ctl('/produce'); await ctl('/bury')
  }
  check('B exited its channel alone on the chain', /exit: exited/.test(last), last)
  await B.shot('channel-exit-developer-mode')
  check('no page error', A.page.errors.length === 0 && B.page.errors.length === 0, [...A.page.errors, ...B.page.errors])
}

try { await main() } catch (e) { failures++; note('FAIL ' + (e.stack || e.message)) } finally {
  for (const p of pages) { try { writeFileSync(join(out, `console-${p.name}.log`), p.page.console.join('\n')) } catch {} try { await p.page.stop() } catch {} }
  for (const s of servers) s.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
note(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
