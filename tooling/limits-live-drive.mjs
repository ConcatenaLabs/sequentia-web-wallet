#!/usr/bin/env node
// Drives default mode's payment limits (ark-limits.js, asset-lightning.js) in headless Chromium,
// against the public testnet, through the page this checkout serves (tooling/live-proxy.mjs): the
// Bitcoin ark held to its band (a board back up to `board` below a quarter of it, a move down to
// `board` at `hold`, a payment of `direct` or more to the address), BTC to an address paid from the
// address first, and a payment over Lightning held to the limit the operator publishes, with the
// fallback in USD when it publishes none (live-proxy.mjs --strip-capacity).
//
//   new    <name>                         a new wallet; it joins by itself; phrase kept in <work>
//   faucet <name> <ticker>…               the faucet pays each, from the Balance tab's buttons
//   watch  <name> <minutes>               the page left open: where BTC is held every 15 s, every
//                                         move the page logs and every transaction it broadcasts
//   code   <name> <ticker> [amount]       Receive with that asset and amount: the code, and whether
//                                         it carries an invoice; written to <work>/<name>.code
//   foreign <name> <ticker> <amount>      a code as a wallet of another operator gives it: this
//                                         wallet's address and an invoice of its operator for the
//                                         amount, asked of the library directly (the page's
//                                         checks do not apply to it), and no `sequentia` part; written
//                                         to <work>/<name>.foreign
//   invoice <name> <BTC amount>           Receive's invoice card: what it says, and the invoice if any
//   payinv <name> <invoice|@file>        Pay an invoice with a bare invoice: pressed (it pays at once)
//   read   <name> <kind>                  the leaf library's own records of that kind (diagnosis)
//   pay    <name> <code|@file> <ticker> <amount> [send]
//                                         Send's review for that payment (what it says, where it
//                                         goes); with `send`, pressed, and what it said after
//
//   node tooling/limits-live-drive.mjs <work-dir> <step> <name> [args…]
//     [--base http://127.0.0.1:8791/wallet/] [--limits '{"btc":{"board":15,"hold":30,"direct":15}}']
//     [--fallback 1500] [--no-ark]
//
// --limits and --fallback set window.SEQ_ARK_LIMITS and SEQ_LN_FALLBACK_USD before the page runs. `new` keeps them for the wallet (<work>/<name>.limits.json),
// and every later step of that wallet runs with them unless it names others: a wallet whose figures
// changed between steps would move coins by the other figures.
//
// The page runs with SEQ_TEST_HOOKS, which only lets the drive read where BTC is held
// (window.__btcHeld) while the page stays in default mode. Coins come from the testnet faucet only
// (its token, tooling/cdp-page.mjs). Each step appends to <work>/evidence/limits.log and writes
// <work>/evidence/<name>-<step>-<n>.json with what the page said and every POST it made.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'
import { readPayCode, buildPayCode } from '../pay-code.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const base = flag('--base', 'http://127.0.0.1:8791/wallet/')
const limitsArg = flag('--limits', null), fallbackArg = flag('--fallback', null)
// --no-ark: the page runs without the Bitcoin ark (SEQ_BTC_ARK = null), so BTC stays on the chain:
// the faucet then pays the wallet's address, which is how a drive wallet gets BTC on the chain.
const noArk = argv.includes('--no-ark'); if (noArk) argv.splice(argv.indexOf('--no-ark'), 1)
const [workArg, step, name, ...rest] = argv
if (!workArg || !step || !name) { console.error('usage: limits-live-drive.mjs <work-dir> <step> <name> [args…]'); process.exit(2) }
const work = resolve(workArg)
const ev = join(work, 'evidence'); mkdirSync(ev, { recursive: true }); mkdirSync(join(work, 'profiles'), { recursive: true })
const log = join(ev, 'limits.log')
const note = (s) => { const l = `[${new Date().toISOString()}] ${step} ${name}: ${s}`; console.log(l); appendFileSync(log, l + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = { step, name, args: rest, at: new Date().toISOString(), said: [], posts: [], console: [], held: [] }
const save = () => { let n = 1; while (existsSync(join(ev, `${name}-${step}-${n}.json`))) n++; writeFileSync(join(ev, `${name}-${step}-${n}.json`), JSON.stringify(record, null, 1)); note(`evidence ${name}-${step}-${n}.json`) }

// The figures this wallet runs with: named now, else kept from `new`.
const keptFile = join(work, name + '.limits.json')
const kept = existsSync(keptFile) ? JSON.parse(readFileSync(keptFile, 'utf8')) : {}
const figures = {
  limits: limitsArg ? JSON.parse(limitsArg) : kept.limits,
  fallback: fallbackArg != null ? Number(fallbackArg) : kept.fallback,
}
if (step === 'new') writeFileSync(keptFile, JSON.stringify(figures))
record.figures = figures

const MOVES = /\[ark limit\]|\[btc ark\]|board|offboard|\[receive code\]|lightning|route|\[leaves\] (pay|send)/i

// Every browser this run opened, stopped at the end whatever happened: a step that fails must not
// leave its Chromium running.
const opened = []
async function openWallet ({ fresh = false } = {}) {
  const page = new Page(chromium(), { profile: join(work, 'profiles', name) })
  opened.push(page)
  await page.open()
  note('browser pid ' + page.proc.pid)
  try {
    const me = (await page.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await page.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await page.send('Target.closeTarget', { targetId: t.targetId })
  } catch {}
  const set = [
    'window.SEQ_LEAVES_TICK_MS=8000', 'window.SEQ_TEST_HOOKS=true',
    figures.limits ? `window.SEQ_ARK_LIMITS=${JSON.stringify(figures.limits)}` : '',
    figures.fallback != null ? `window.SEQ_LN_FALLBACK_USD=${JSON.stringify(figures.fallback)}` : '',
    noArk ? 'window.SEQ_BTC_ARK=null' : '',
    "if (location.hostname === '127.0.0.1') Object.defineProperty(window, 'SEQ_LSP_URL', { value: location.origin + '/lsp', writable: false, configurable: false })",
  ].filter(Boolean).join(';\n')
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: set })
  // Every POST the page or its workers make: where to, the JSON-RPC method, and the answer of a
  // broadcast (the txid).
  const reqs = new Map()
  const prev = page.ws.onmessage
  page.ws.onmessage = (e) => {
    prev(e)
    const m = JSON.parse(e.data)
    // A worker (the leaf library's, the Bitcoin ark's) is a target of its own: its requests are
    // seen once its session has the network domain on.
    if (m.method === 'Target.attachedToTarget') {
      page.ws.send(JSON.stringify({ id: 1e6 + page.next++, sessionId: m.params.sessionId, method: 'Network.enable', params: { maxPostDataSize: 65536 } }))
      page.ws.send(JSON.stringify({ id: 1e6 + page.next++, sessionId: m.params.sessionId, method: 'Runtime.enable', params: {} }))
    }
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST') {
      const u = new URL(m.params.request.url)
      let rpc = ''; try { const j = JSON.parse(m.params.request.postData || ''); rpc = Array.isArray(j) ? j.map((x) => x.method).join(',') : (j.method || '') } catch {}
      const p = { t: new Date().toISOString(), path: u.pathname, rpc }
      if (m.sessionId) p.worker = true
      record.posts.push(p); reqs.set(m.params.requestId, { p, sessionId: m.sessionId })
    }
    if (m.method === 'Network.loadingFinished' && reqs.has(m.params.requestId)) {
      const { p, sessionId } = reqs.get(m.params.requestId); reqs.delete(m.params.requestId)
      if (/\/tx$|node-rpc|offboard|board|send|pay|lightning/i.test(p.path + p.rpc)) {
        const id = 1e6 + page.next++
        page.pending.set(id, (r) => { if (r.result) p.answer = String(r.result.body).slice(0, 300) })
        page.ws.send(JSON.stringify({ id, sessionId, method: 'Network.getResponseBody', params: { requestId: m.params.requestId } }))
      }
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description).join(' ')
      if (MOVES.test(text)) { const l = new Date().toISOString() + ' ' + text.slice(0, 400); record.console.push(l); if (/\[ark limit\]|\[btc ark\] board/.test(text)) note('page: ' + text.slice(0, 300)) }
    }
  }
  await page.send('Network.enable', { maxPostDataSize: 65536 })
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
  await page.go(base)
  const phraseFile = join(work, name + '.phrase')
  if (!fresh && existsSync(phraseFile)) {
    const shown = await page.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
    if (shown === 'welcome') {
      await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(readFileSync(phraseFile, 'utf8').trim())})`)
      await page.go('about:blank'); await sleep(1500); await page.go(base)
    }
  } else if (fresh) {
    await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 300000)
    await click(page, '#btnCreate')
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await click(page, '#btnConfirm')
  }
  await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
  return page
}
const click = (page, sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
const tab = (page, t) => click(page, `#tabs button[data-tab="${t}"]`)
const shot = (page, f) => page.screenshot(join(ev, f)).then(() => note('screenshot ' + f))
const held = (page) => page.eval('window.__btcHeld || null')
const balances = (page) => page.eval(`(()=>{ const out={}; for(const r of document.querySelectorAll('.bt-row')){ const tk=r.querySelector('.tk'); if(!tk) continue;
  out[tk.textContent.trim()]=(r.querySelector('.bt-t')?.innerText||'').replace(/^Total\\s*/,'').trim(); }
  out._headline=(document.querySelector('#totalVal')||{}).textContent||''; return out })()`)
const snap = async (page, why) => { const s = { t: new Date().toISOString(), why, held: await held(page).catch(() => null), balances: await balances(page).catch(() => null) }; record.held.push(s); return s }
const words = async (page, sel = 'body') => forbiddenIn(await page.eval(`document.querySelector(${JSON.stringify(sel)}).innerText`)).filter((w) => !['on-chain', 'lightning', 'channel', 'channels'].includes(w))

async function waitJoined (page, ms = 300000) {
  await page.eval("(()=>{ const u=document.querySelector('#modeUser'); if(u && !u.checked){ u.checked=true; u.dispatchEvent(new Event('change')) } return true })()").catch(() => {})
  await tab(page, 'receive')
  return page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && /^bitcoin:/i.test(a.textContent) ? a.textContent : false })()", ms)
}
// The BTC figures read once the ark has opened and said its balance.
const arkOpen = (page, ms = 300000) => page.waitFor("(()=>{ const h=window.__btcHeld; return h && h.ark !== null ? h : false })()", ms)
// Receive's code once it has stopped changing for `quiet` ms (an invoice is asked for after the
// amount is typed, and the code is drawn again when it comes).
async function steadyCode (page, quiet = 10000, ms = 180000) {
  const until = Date.now() + ms
  let last = null, since = Date.now()
  while (Date.now() < until) {
    const now = await page.eval("document.querySelector('#addr').textContent")
    if (now !== last) { last = now; since = Date.now() } else if (Date.now() - since >= quiet && /^bitcoin:/i.test(now)) return now
    await sleep(1000)
  }
  return last
}
async function pickRecv (page, ticker) {
  return page.eval(`(()=>{ const s=document.querySelector('#recvAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(ticker)}); if(!o) return 'no '+${JSON.stringify(ticker)}+' among '+[...s.options].map(o=>o.textContent).join(','); s.value=o.value; s.dispatchEvent(new Event('change')); return true })()`)
}
const summarize = (code) => { const c = readPayCode(code) || {}; return { address: c.address, amount: c.amount, lightning: !!c.lightning, ark: !!c.ark, sequentia: !!c.sequentia } }

async function main () {
  if (step === 'new') {
    const page = await openWallet({ fresh: true })
    const phrase = await page.eval("localStorage.getItem('swk.sequentia.mnemonic')")
    writeFileSync(join(work, name + '.phrase'), phrase + '\n', { mode: 0o600 })
    const code = await waitJoined(page)
    record.said.push({ receive: summarize(code) })
    note('joined; receive code ' + JSON.stringify(summarize(code)))
    await arkOpen(page).catch(() => note('the Bitcoin ark did not open within 5 minutes'))
    await snap(page, 'new')
    await page.stop()
  } else if (step === 'faucet') {
    const page = await openWallet()
    await waitJoined(page)
    for (const tk of rest) {
      await tab(page, 'balance')
      await page.eval("document.querySelector('#faucetStatus') && (document.querySelector('#faucetStatus').textContent='')")
      await click(page, `#faucetBtns button[data-faucet="${tk === 'tSEQ' ? '' : tk}"]`)
      const said = await page.waitFor("(()=>{ const t=document.querySelector('#faucetStatus')?.textContent||''; return /Received|faucet sent|error|refused|already|wait/i.test(t) ? t : false })()", 300000).catch((e) => 'no answer: ' + e.message.slice(0, 120))
      record.said.push({ faucet: tk, said: said.trim() })
      note(`faucet ${tk}: ${said.trim()}`)
      await sleep(2000)
    }
    await snap(page, 'after faucet')
    await shot(page, `${name}-faucet.png`)
    await page.stop()
  } else if (step === 'watch') {
    const mins = Number(rest[0] || 10)
    const page = await openWallet()
    await waitJoined(page)
    await tab(page, 'balance')
    await arkOpen(page).catch(() => {})
    const until = Date.now() + mins * 60000
    let last = ''
    while (Date.now() < until) {
      const s = await snap(page, 'watch')
      const k = JSON.stringify([s.held, s.balances && s.balances.BTC])
      if (k !== last) { note('held ' + JSON.stringify(s.held) + ' BTC row ' + JSON.stringify(s.balances && s.balances.BTC)); last = k }
      await sleep(15000)
    }
    record.words = await words(page)
    note('words default mode never says, on Balance: ' + JSON.stringify(record.words))
    await shot(page, `${name}-watch.png`)
    await page.stop()
  } else if (step === 'code') {
    const [ticker, amount] = rest
    const page = await openWallet()
    await waitJoined(page)
    if (ticker) { const ok = await pickRecv(page, ticker); if (ok !== true) throw new Error(ok) }
    await page.eval(`(()=>{ const i=document.querySelector('#recvAmt'); i.value=${JSON.stringify(amount || '')}; i.dispatchEvent(new Event('input')); return true })()`)
    const code = await steadyCode(page)
    writeFileSync(join(work, name + '.code'), code)
    const tip = await page.eval("[...document.querySelectorAll('section[data-panel=\"receive\"] .muted, #recvTip, #recvNote')].map(e=>e.innerText).filter(Boolean).join(' | ')").catch(() => '')
    record.said.push({ ticker, amount, code: summarize(code), tip })
    note(`Receive ${amount || ''} ${ticker || ''}: ${JSON.stringify(summarize(code))}`)
    record.words = await words(page, 'section[data-panel="receive"]').catch(() => null)
    await shot(page, `${name}-code-${ticker || 'none'}-${amount || 0}.png`)
    await page.stop()
  } else if (step === 'foreign') {
    const [ticker, amount] = rest
    const page = await openWallet()
    const code = await waitJoined(page)
    const c = readPayCode(code)
    await page.waitFor('window.__leavesApi && window.__leavesApi.isOpen()', 300000)
    const hex = await page.eval(`(()=>{ const s=document.querySelector('#recvAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(ticker)}); return o ? o.value : null })()`)
    if (!hex) throw new Error('the operator receives no ' + ticker + ' over Lightning')
    const prec = 8
    const atoms = String(BigInt(Math.round(Number(amount) * 10 ** prec)))
    const inv = await page.eval(`window.__leavesApi.command('lightning_receive', { asset: ${JSON.stringify(hex)}, amount: ${JSON.stringify(atoms)}, description: 'Receive' }).then(r=>r.invoice)`)
    const foreign = buildPayCode({ address: c.address, lightning: inv })
    writeFileSync(join(work, name + '.foreign'), foreign)
    record.said.push({ foreign: summarize(foreign), ticker, amount, atoms })
    note(`a code as another operator's wallet gives it: ${JSON.stringify(summarize(foreign))}, ${amount} ${ticker}`)
    await page.stop()
  } else if (step === 'pay') {
    const [to, ticker, amount, go] = rest
    const code = to.startsWith('@') ? readFileSync(join(work, to.slice(1)), 'utf8').trim() : to
    const page = await openWallet()
    await waitJoined(page)
    if (ticker === 'BTC') await arkOpen(page).catch(() => {})
    await snap(page, 'before')
    await tab(page, 'send')
    await page.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ticker)})`, 300000)
    await page.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(code)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
      const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ticker)}); s.value=o.value; s.dispatchEvent(new Event('change'));
      r.querySelector('.ramt').value=${JSON.stringify(amount)}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
    await sleep(1500)
    await click(page, '#btnReview')
    const review = await page.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m && m.innerText.trim()) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 180000)
    record.said.push({ review })
    record.reviewWords = forbiddenIn(review)
    note('review: ' + review.replace(/\n+/g, ' | '))
    await shot(page, `${name}-pay-${ticker}-${amount}-review.png`)
    if (go === 'send' && !/^ERR/.test(review)) {
      const t = Date.now()
      await page.eval("document.querySelector('.modal button.primary').click()")
      const done = await page.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; if(t && !/Sending|Moving|Paying|Waiting/i.test(t)) return t; const m=document.querySelector('.modal'); return m ? false : 'the review closed' })()", 900000).catch((e) => 'still: ' + e.message.slice(-200))
      record.said.push({ after: done, seconds: (Date.now() - t) / 1000 })
      note(`after Send (${((Date.now() - t) / 1000).toFixed(1)} s): ${done.replace(/\n+/g, ' | ')}`)
      // A second sentence (a payment that came back, an offer of the address) is read too.
      const modal = await page.eval("document.querySelector('.modal')?.innerText || ''")
      if (modal) record.said.push({ modal })
      await shot(page, `${name}-pay-${ticker}-${amount}-after.png`)
      await sleep(20000)
      await snap(page, 'after')
    } else {
      await page.eval("(()=>{ const b=[...document.querySelectorAll('.modal button')].find(b=>/Cancel/.test(b.textContent)); if(b) b.click(); return true })()").catch(() => {})
    }
    await page.stop()
  } else if (step === 'invoice') {
    // Receive's invoice card for BTC: `invoice <name> <BTC amount>`; what it says, and the invoice
    // if it made one.
    const page = await openWallet()
    await waitJoined(page)
    await arkOpen(page).catch(() => {})
    await page.waitFor("!document.querySelector('#lnRecvCard').classList.contains('hide')", 180000)
    await page.eval(`(()=>{ const i=document.querySelector('#lnRecvAmt'); i.value=${JSON.stringify(rest[0])}; i.dispatchEvent(new Event('input')); return true })()`)
    await click(page, '#lnRecvBtn')
    const said = await page.waitFor("(()=>{ const s=document.querySelector('#lnRecvStatus'); const t=(s&&s.textContent||'').trim(); const i=(document.querySelector('#lnRecvBolt11')?.textContent||'').trim(); return (/^ln/i.test(i) || (t && !/…$/.test(t))) ? JSON.stringify({ status: t, invoice: i }) : false })()", 120000)
    const j = JSON.parse(said)
    record.said.push({ amount: rest[0], status: j.status, invoice: j.invoice ? j.invoice.slice(0, 40) + '…' : null })
    note(`invoice card, ${rest[0]} BTC: ${j.status}; ${j.invoice ? 'an invoice: ' + j.invoice.slice(0, 30) + '…' : 'no invoice'}`)
    await shot(page, `${name}-invoice-${rest[0]}.png`)
    await page.stop()
  } else if (step === 'payinv') {
    // Send's Pay an invoice card with a bare invoice (`payinv <name> <invoice|@file>`): it is
    // pressed, and default mode pays at once (it has no review); what the card says.
    const inv = rest[0].startsWith('@') ? readFileSync(join(work, rest[0].slice(1)), 'utf8').trim() : rest[0]
    const page = await openWallet()
    await waitJoined(page)
    await arkOpen(page).catch(() => {})
    await tab(page, 'send')
    await page.waitFor("!document.querySelector('#lnSendCard').classList.contains('hide')", 180000)
    await page.eval(`(()=>{ const t=document.querySelector('#lnSendBolt11'); t.value=${JSON.stringify(inv)}; t.dispatchEvent(new Event('input')); return true })()`)
    await click(page, '#lnSendBtn')
    const said = await page.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m && m.innerText.trim()) return m.innerText; const s=document.querySelector('#lnSendStatus'); const t=(s&&s.textContent||'').trim(); return t && !/…$/.test(t) ? 'STATUS '+t : false })()", 300000).catch(async () => 'still: ' + await page.eval("document.querySelector('#lnSendStatus')?.textContent || ''"))
    record.said.push({ invoice: inv.slice(0, 30) + '…', said })
    note('Pay an invoice says: ' + said.replace(/\n+/g, ' | '))
    await shot(page, `${name}-payinv.png`)
    await page.eval("(()=>{ const b=[...document.querySelectorAll('.modal button')].find(b=>/Cancel/.test(b.textContent)); if(b) b.click(); return true })()").catch(() => {})
    await page.stop()
  } else if (step === 'read') {
    // What the leaf library holds for this wallet: `read <name> <own-kind>` (lightning_receives,
    // lightning_payments, …), after the wallet opened and synced.
    const page = await openWallet()
    await waitJoined(page)
    await page.waitFor('window.__leavesApi && window.__leavesApi.isOpen()', 300000)
    await sleep(Number(rest[1] || 30000))
    const got = await page.eval(`window.__leavesApi.own(${JSON.stringify(rest[0])}, {}).then(r=>JSON.stringify(r))`).catch((e) => 'refused: ' + e.message)
    record.said.push({ own: rest[0], got: String(got).slice(0, 20000) })
    note(rest[0] + ': ' + String(got).slice(0, 1500))
    await snap(page, 'read')
    note('balances ' + JSON.stringify(record.held.at(-1).balances))
    await page.stop()
  } else throw new Error('no step ' + step)
}

const stopAll = () => Promise.all(opened.map((p) => p.stop().catch(() => {})))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll().finally(() => process.exit(130)) })
main().then(async () => { save(); await stopAll(); process.exit(0) },
  async (e) => { note('FAILED: ' + (e && e.stack || e)); try { save() } catch {} await stopAll(); process.exit(1) })
