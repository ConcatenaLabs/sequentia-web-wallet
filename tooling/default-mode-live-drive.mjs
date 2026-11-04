#!/usr/bin/env node
// Drives default mode on the operator's tree (default-arca.js) in headless Chromium, against the
// public testnet, through the page this checkout serves (tooling/live-proxy.mjs) or the public
// page itself:
//
//   new    a new wallet: it joins the page's operator by itself (no step, none of the words default
//          mode never says), and Receive gives a receive code; the faucet pays it, and the asset
//          shows in the balance; its phrase is written to <work>/<name>.phrase
//   send   wallet <name> pays wallet <to>'s receive code in the tree; the time from the click to
//          the receiver's balance showing it. `send <name> @<file> <ticker> <amount>` pays the
//          code written in <file> instead (another wallet's: the arca client's `arca:` request,
//          Ambra's code), with no receiver page to watch
//   trade  wallet <name> trades in the Trade tab (default mode's composer): pay, receive, amount
//   show   wallet <name>'s balance figures and headline, written to <work>/<name>.totals.json
//   invoice  wallet <name> makes a BTC invoice on Receive for <sats>, writes it to
//          <work>/<name>.invoice, and keeps the page open until it says Received (up to an hour)
//   pay    wallet <name> pays a BTC invoice handed over by a link (`#pay?invoice=…`), as a page
//          selling something for BTC does: Send opens with it filled in, and the drive presses Pay
//          (`--paste` pastes it into Pay an invoice instead, for a page without the link)
//   restore  the phrase of <name> opened in a fresh profile; its figures compared with <name>'s
//   codes  wallet <name> hands out <n> fresh receive codes, written to <work>/<name>.codes, one a
//          line
//   sendmany  wallet <name> pays <amount> <ticker> to every code in each <file> given, one row of
//          Send each, in one payment: `sendmany A USDX 10 B.codes C.codes`
//   coins  wallet <name>'s coins in the tree as developer mode lists them (state, kind, asset,
//          value, dates), written to <work>/<name>.coins.json
//   settle wallet <name> settles every coin it holds in the tree that is not a leaf of a round (kind batch)
//          (developer mode's Settle now: the quote, then Sign and hand over), and stays open until
//          each is a live leaf of a round, up to 30 minutes; written to <work>/<name>.coins.json
//   exit   wallet <name> takes every coin it holds in the tree home in developer mode's exit
//          drill: for each, the quote (what it broadcasts and its fees), then Broadcast on these
//          fees, and what the run did, all written to <work>/<name>.exit.json. With the page
//          served by tooling/live-proxy.mjs --refuse /arca it runs with the operator gone. A coin
//          already exiting has no drill button: opening the wallet syncs it on to its claim
//
//   node tooling/default-mode-live-drive.mjs <work-dir> <step> <name> [args…]
//     [--base http://127.0.0.1:8791/wallet/]
//
// The faucet pays each asset once per wallet; with the faucet token (tooling/cdp-page.mjs,
// ~/.config/sequentia/faucet-exempt.token) the drive's requests are our own tooling's and are
// paid every time.
//
// Each step writes screenshots and timings to <work-dir>/evidence, and every check to its log.
// Profiles are kept under <work-dir>/profiles/<name>, so a wallet carries from step to step; the
// phrases are kept out of the evidence directory.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { pickExpr, rowsExpr } from './picker-drive.mjs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const base = flag('--base', 'http://127.0.0.1:8791/wallet/')
// `--to-base <url>`: `send`'s receiver opens at this page instead of --base, a wallet kept on
// another origin (one served by tooling/live-proxy.mjs, paid from the public page).
const toBase = flag('--to-base', null)
// `pay --paste`: the invoice is pasted into Pay an invoice instead of handed over by the link, for
// a page that predates the link.
const paste = argv.includes('--paste'); if (paste) argv.splice(argv.indexOf('--paste'), 1)
const [workArg, step, name, ...rest] = argv
if (!workArg || !step || !name) { console.error('usage: default-mode-live-drive.mjs <work-dir> <step> <name> [args…]'); process.exit(2) }
const work = resolve(workArg)
const ev = join(work, 'evidence'); mkdirSync(ev, { recursive: true }); mkdirSync(join(work, 'profiles'), { recursive: true })
const log = join(ev, 'drive.log')
const t0 = Date.now()
const note = (s) => { const l = `[${new Date().toISOString()}] ${step} ${name}: ${s}`; console.log(l); appendFileSync(log, l + '\n') }
let failures = 0
const check = (what, ok, detail) => { note(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failures++ }
const secs = (ms) => (ms / 1000).toFixed(1) + ' s'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pages = []
async function openWallet (who, { fresh = false, phrase = null, at = base } = {}) {
  const profile = join(work, 'profiles', who)
  const page = new Page(chromium(), { profile })
  pages.push(page)
  await page.open()
  // A browser stopped by an earlier run reopens its tabs: a wallet tab among them holds the
  // one-tab lock. Every page but this one is closed.
  try {
    const me = (await page.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await page.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await page.send('Target.closeTarget', { targetId: t.targetId })
  } catch (e) { note('closing other tabs: ' + e.message) }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=8000;
    // Served from this machine, the hosted-node service is reached through the same origin, as on the public page.
    if (location.hostname === '127.0.0.1') Object.defineProperty(window, 'SEQ_LSP_URL', { value: location.origin + '/lsp', writable: false, configurable: false })` })
  await page.go(at)
  // A wallet of an earlier step reopens from its phrase: a browser stopped by the drive may not
  // have written its storage to disk.
  if (!phrase && !fresh && existsSync(join(work, who + '.phrase'))) phrase = readFileSync(join(work, who + '.phrase'), 'utf8').trim()
  if (phrase) {
    // Only when the page has no wallet: a second load while the first holds the wallet is refused
    // as another tab.
    const shown = await page.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
    if (shown === 'welcome') {
      await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)})`)
      await page.go('about:blank'); await sleep(1500)
      await page.go(at)
    }
  } else if (fresh) {
    await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 300000)
    await click(page, '#btnCreate')
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await click(page, '#btnConfirm')
  }
  try { await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000) } catch (e) {
    note('the page shows: ' + JSON.stringify(await page.eval('document.body.innerText.slice(0, 300)').catch(() => '')) + ' console: ' + page.console.slice(-6).join(' | '))
    throw e
  }
  return page
}
const click = (page, sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
const tab = (page, t) => click(page, `#tabs button[data-tab="${t}"]`)
const shot = (page, f) => page.screenshot(join(ev, f)).then(() => note('screenshot ' + f))
// The page's visible text, for the words default mode never says.
const visibleText = (page) => page.eval("document.body.innerText")
// Balance rows as shown: ticker -> the total cell's text, and the arriving line.
const balances = (page) => page.eval(`(()=>{ const out={}; for(const r of document.querySelectorAll('.bt-row')){ const tk=r.querySelector('.tk'); if(!tk) continue;
  out[tk.textContent.trim()]={ total:(r.querySelector('.bt-t')?.innerText||'').replace(/^Total\\s*/,'').trim(), arriving:(r.querySelector('.bt-arriving')?.textContent||'') }; }
  out._headline=(document.querySelector('#totalVal')||document.querySelector('.hero .big')||{}).textContent||''; return out })()`)

async function waitJoined (page, ms = 240000) {
  // Default mode's receive code: a wallet a developer-mode step left there is put back first.
  await page.eval("(()=>{ const u=document.querySelector('#modeUser'); if(u && !u.checked){ u.checked=true; u.dispatchEvent(new Event('change')) } return true })()").catch(() => {})
  await tab(page, 'receive')
  return page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && /^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i.test(a.textContent) ? a.textContent : false })()", ms)
}

async function faucet (page, asset) {
  await tab(page, 'balance')
  const tF = Date.now()
  await click(page, `#faucetBtns button[data-faucet="${asset === 'tSEQ' ? '' : asset}"]`)
  const said = await page.waitFor("(()=>{ const t=document.querySelector('#faucetStatus')?.textContent||''; return /Received|error|refused/i.test(t) ? t : false })()", 240000)
  check(`the faucet paid ${asset} to the receive code`, /^Received/.test(said.trim()), `${said.trim()} (${secs(Date.now() - tF)} from the click)`)
  await sleep(1500)
  const bal = await balances(page)
  check(`the balance shows ${asset}`, !!bal[asset] && /[1-9]/.test(bal[asset].total), bal[asset])
  await shot(page, `${name}-faucet-${asset}.png`)
}

// Developer mode's Leaves tab, its coin list shown.
async function devLeaves (page) {
  await page.eval("(()=>{ const c=document.querySelector('#modeDeveloper'); if(!c) throw new Error('no #modeDeveloper'); c.checked=true; c.dispatchEvent(new Event('change')); return true })()")
  await page.waitFor("document.querySelector('#tabLeaves') && !document.querySelector('#tabLeaves').classList.contains('hide')", 60000)
  await click(page, '#tabLeaves')
  await page.waitFor("document.querySelector('#leafCoins')", 300000)
  // The list fills once the wallet has read its store and synced: the same answer twice, 10 s
  // apart, with a sync behind it.
  let last = null
  for (let i = 0; i < 30; i++) {
    await sleep(10000)
    const now = await page.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>d.dataset.leaf+d.dataset.state).join() + '|' + /Last sync: /.test(document.querySelector('#leavesRoot').innerText)")
    if (now === last && now.endsWith('|true')) break
    last = now
  }
}

// The coins developer mode lists, held or not, with whether each has its Exit drill button.
const listCoins = (page) => page.eval(`[...document.querySelectorAll('#leafCoins .leaf-coin')].map((d)=>({ leaf: d.dataset.leaf, state: d.dataset.state,
  kind: d.dataset.kind, asset: d.dataset.asset, value: d.dataset.value, exit_by: d.dataset.exitBy || null,
  button: !!d.querySelector('button[data-action="exit"]:not([disabled])') }))`)

async function main () {
  if (step === 'faucet') {
    const page = await openWallet(name)
    await waitJoined(page)
    await faucet(page, rest[0] || 'USDX')
    note('console: ' + page.console.filter((l) => /faucet|receive code|tree send|leaves|board/i.test(l)).slice(-12).join(' | '))
    await page.stop()
  } else if (step === 'new') {
    const page = await openWallet(name, { fresh: true })
    const tOpen = Date.now()
    const phrase = await page.eval("localStorage.getItem('swk.sequentia.mnemonic')")
    writeFileSync(join(work, name + '.phrase'), phrase + '\n', { mode: 0o600 })
    check('a new wallet opened', phrase && phrase.split(/\s+/).length >= 12)
    const code = await waitJoined(page)
    check('it joined the operator by itself; Receive gives a receive code', true, `${code.slice(0, 24)}… in ${secs(Date.now() - tOpen)} after the wallet opened`)
    await shot(page, `${name}-1-receive-code.png`)
    const words = forbiddenIn(await visibleText(page)).filter((w) => !['on-chain', 'lightning', 'channel', 'channels'].includes(w))
    check('Receive and the page around it say none of leaf, round, operator, tree…', !words.length, words)
    if (rest[0] !== 'none') await faucet(page, rest[0] || 'USDX')
    writeFileSync(join(work, name + '.code'), code)
    note('console: ' + page.console.filter((l) => /faucet|receive code|tree send|leaves|board/i.test(l)).slice(-12).join(' | '))
    await page.stop()
  } else if (step === 'send') {
    // node … send A B GOLD 1: A pays B's receive code; B's page is open throughout.
    const [to, ticker, amount] = rest
    const external = to.startsWith('@')
    let pb = null; let code; let before = { total: '0' }
    if (external) {
      code = readFileSync(to.slice(1), 'utf8').trim()
      note('paying the code in ' + to.slice(1) + ': ' + code.slice(0, 24) + '…')
    } else {
      pb = await openWallet(to, { at: toBase || base })
      const old = await waitJoined(pb)
      // A fresh code for this payment: the one shown may be paid already by an earlier run.
      if (rest[3] !== 'same' && rest[3] !== 'address') {
        await click(pb, '#btnNewAddr')
        await pb.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i.test(t) && t!==${JSON.stringify(old)} })()`, 300000)
      }
      code = await pb.eval("document.querySelector('#addr').textContent")
      // `address`: pay the address the code carries, as a sender outside the tree would be given.
      if (rest[3] === 'address') { code = decodeURIComponent(code.replace(/^bitcoin:/i, '').split('?')[0]); note('paying the address ' + code) }
      await tab(pb, 'balance')
      before = (await balances(pb))[ticker] || { total: '0' }
    }
    const pa = await openWallet(name)
    await waitJoined(pa)
    await tab(pa, 'send')
    await pa.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim()===${JSON.stringify(ticker)})`, 180000)
    await pa.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(code)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
      const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\s/)[0]===${JSON.stringify(ticker)}); if(!o) throw new Error('no option ${ticker}: '+[...s.options].map(o=>o.textContent).join(',')); s.value=o.value; s.dispatchEvent(new Event('change'));
      r.querySelector('.ramt').value=${JSON.stringify(amount)}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
    await click(pa, '#btnReview')
    const title = await pa.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
    check('the review asks to send it, in plain words', /^Send .*\?/i.test(title.trim()) && !forbiddenIn(title).length, title.replace(/\n+/g, ' | '))
    await shot(pa, `${name}-send-review.png`)
    const tClick = Date.now()
    await pa.eval("document.querySelector('.modal button.primary').click()")
    const done = await pa.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending/.test(t) ? t : false })()", 2400000).catch(async (e) => { note('still: ' + await pa.eval("document.querySelector('.modal .status')?.textContent||''") + ' console: ' + pa.console.slice(-8).join(' | ')); throw e })
    check('the sender says it is sent', /^Sent/.test(done), `${done} (${secs(Date.now() - tClick)} from the click)`)
    await shot(pa, `${name}-send-done.png`)
    if (external || !/^Sent/.test(done)) { note('console A: ' + pa.console.filter((l) => /tree send|leaves|board/i.test(l)).slice(-6).join(' | ')); return }
    const seen = await pb.waitFor(`(async()=>{ const r=[...document.querySelectorAll('.bt-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(ticker)}); const t=r?(r.querySelector('.bt-t')?.innerText||''):''; return t && t!==${JSON.stringify(before.total)} ? t : false })()`, 600000).catch(() => null)
    check(`${to} shows the ${ticker}`, !!seen, `${seen} ${secs(Date.now() - tClick)} after the click (it showed ${JSON.stringify(before.total)} before)`)
    await shot(pb, `${to}-after-send.png`)
    note('console A: ' + pa.console.filter((l) => /tree send|leaves|board/i.test(l)).slice(-6).join(' | '))
    note('console B: ' + pb.console.filter((l) => /leaves|leaf|arriv/i.test(l)).slice(-6).join(' | '))
  } else if (step === 'trade') {
    // node … trade A GOLD USDX 1
    const [pay, get, amount] = rest
    const page = await openWallet(name)
    await waitJoined(page)
    await tab(page, 'swap')
    await page.waitFor("document.querySelector('#ucPay') && document.querySelector('#userComposer').offsetParent !== null", 120000)
    const words = forbiddenIn(await page.eval("document.querySelector('section[data-panel=\"swap\"]').innerText"))
    check('the Trade tab is three inputs and a button, none of the words', !words.length, words)
    const pick = async (id, tk) => { if (!(await page.eval(pickExpr(id, tk)))) throw new Error('no ' + tk + ' in #' + id) }
    await pick('ucPay', pay); await sleep(500); await pick('ucGet', get)
    await page.eval(`(()=>{ const i=document.querySelector('#ucAmount'); i.value=${JSON.stringify(amount)}; i.dispatchEvent(new Event('input')); return true })()`)
    const tQ = Date.now()
    await click(page, '#ucReview')
    const tk = await page.waitFor("(()=>{ if(document.querySelector('#ucConfirm')) return document.querySelector('#ucTicket').innerText; const n=document.querySelector('#ucNote'); return n && n.classList.contains('err') && n.textContent ? 'ERR '+n.textContent : false })()", 300000)
    check(`a ticket for ${amount} ${pay} → ${get}`, !/^ERR/.test(tk), `${tk.replace(/\n+/g, ' | ')} (${secs(Date.now() - tQ)})`)
    await shot(page, `${name}-trade-${pay}-${get}-ticket.png`)
    if (!/^ERR/.test(tk)) {
      const tC = Date.now()
      const rows0 = await page.eval("document.querySelectorAll('#ucTrades .uc-trade').length")
      await click(page, '#ucConfirm')
      // The new trade's row: the list's first once it has one row more than before.
      await page.waitFor(`document.querySelectorAll('#ucTrades .uc-trade').length > ${rows0}`, 300000).catch(() => null)
      const sent = await page.waitFor("(()=>{ const r=document.querySelector('#ucTrades .uc-trade'); return r ? r.querySelector('.uc-state').textContent : false })()", 300000).catch(() => null)
      note(`first state ${sent} after ${secs(Date.now() - tC)}`)
      const fin = await page.waitFor("(()=>{ const r=document.querySelector('#ucTrades .uc-trade'); const t=r?r.querySelector('.uc-state').textContent:''; return /Settled|Returned/.test(t) ? t : false })()", 1200000).catch(() => null)
      check('the trade is Settled', fin === 'Settled', `${fin} ${secs(Date.now() - tC)} after Trade`)
      await shot(page, `${name}-trade-${pay}-${get}-done.png`)
    }
    note('console: ' + page.console.filter((l) => /user composer|trade|leaves/i.test(l)).slice(-8).join(' | '))
  } else if (step === 'trades') {
    // The Trade tab's list of trades, followed until each is Settled or Returned (or the wait ends).
    const page = await openWallet(name)
    await waitJoined(page)
    await tab(page, 'swap')
    const tOpen = Date.now()
    const read = () => page.eval("[...document.querySelectorAll('#ucTrades .uc-trade')].map(r=>r.innerText.replace(/\\n+/g,' '))")
    note('trades at open: ' + JSON.stringify(await read()))
    const fin = await page.waitFor("(()=>{ const r=[...document.querySelectorAll('#ucTrades .uc-trade')]; return r.length && r.every(x=>/Settled|Returned/.test(x.innerText)) ? true : false })()", Number(rest[0] || 600000)).catch(() => false)
    note(`trades after ${secs(Date.now() - tOpen)}: ${JSON.stringify(await read())}`)
    check('every trade Settled or Returned', !!fin)
    await shot(page, `${name}-trades.png`)
    const recs = await page.eval("JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith('swk.usertrade')).map(([k,v])=>{ try{ return JSON.parse(v) }catch{ return v } }))")
    writeFileSync(join(ev, `${name}-trade-records.json`), recs)
    note('console: ' + page.console.filter((l) => /user trade|user composer/i.test(l)).slice(-10).join(' | '))
  } else if (step === 'restore') {
    // node … restore A2 A: wallet A's phrase opened in a fresh profile (A2), on --base; it joins
    // by itself, restores what the tree holds of it, and shows the figures A showed (A.totals.json).
    const [from] = rest
    const phrase = readFileSync(join(work, from + '.phrase'), 'utf8').trim()
    const want = JSON.parse(readFileSync(join(ev, from + '.totals.json'), 'utf8'))
    const page = await openWallet(name, { phrase })
    const tOpen = Date.now()
    const code = await waitJoined(page, 900000)
    check('the restored wallet joined by itself; Receive gives a receive code', true, `${code.slice(0, 40)}… ${secs(Date.now() - tOpen)} after it opened`)
    await tab(page, 'balance')
    const same = (b) => Object.keys(want).filter((k) => k !== '_headline').every((k) => b[k] && b[k].total === want[k].total)
    const got = await page.waitFor(`(()=>{ const out={}; for(const r of document.querySelectorAll('.bt-row')){ const tk=r.querySelector('.tk'); if(!tk) continue; out[tk.textContent.trim()]={ total:(r.querySelector('.bt-t')?.innerText||'').replace(/^Total\\s*/,'').trim() } } ; const want=${JSON.stringify(want)}; return Object.keys(want).filter(k=>k!=='_headline').every(k=>out[k] && out[k].total===want[k].total) ? out : false })()`, 900000).catch(() => null)
    const now2 = await balances(page)
    check(`the figures are ${from}'s`, !!got && same(now2), `${secs(Date.now() - tOpen)} after it opened: ${JSON.stringify(now2)} (want ${JSON.stringify(want)})`)
    await shot(page, `${name}-restored-balance.png`)
    note('console: ' + page.console.filter((l) => /leaves|restore/i.test(l)).slice(-8).join(' | '))
  } else if (step === 'code') {
    const page = await openWallet(name)
    const tOpen = Date.now()
    const code = await waitJoined(page)
    note(`code after ${secs(Date.now() - tOpen)}`)
    writeFileSync(join(work, name + '.code'), code)
    await shot(page, `${name}-receive-code.png`)
    await page.stop()
  } else if (step === 'invoice') {
    // node … invoice A 60000
    const sats = Number(rest[0])
    if (!(sats > 0)) throw new Error('invoice needs an amount in sats')
    const page = await openWallet(name)
    await tab(page, 'receive')
    await page.waitFor("!document.querySelector('#lnRecvCard').classList.contains('hide')", 120000)
    await page.eval(`(()=>{ const i=document.querySelector('#lnRecvAmt'); i.value=${JSON.stringify((sats / 1e8).toFixed(8))}; i.dispatchEvent(new Event('input')); return true })()`)
    await click(page, '#lnRecvBtn')
    const inv = await page.waitFor("(()=>{ const t=(document.querySelector('#lnRecvBolt11')?.textContent||'').trim(); return /^ln/i.test(t) ? t : false })()", 120000)
    writeFileSync(join(work, name + '.invoice'), inv + '\n')
    check('Receive makes a BTC invoice', true, `${sats} sats, ${inv.slice(0, 24)}…`)
    await shot(page, `${name}-invoice-1.png`)
    const tR = Date.now()
    const said = await page.waitFor("(()=>{ const t=(document.querySelector('#lnRecvStatus')?.textContent||'').trim(); return /^Received/.test(t) ? t : false })()", 3600000)
    check('the invoice is paid and the BTC received', true, `${said} (${secs(Date.now() - tR)} after the invoice showed)`)
    await shot(page, `${name}-invoice-2-received.png`)
    await page.stop()
  } else if (step === 'pay') {
    // node … pay A <invoice>
    const inv = rest[0]
    if (!inv) throw new Error('pay needs an invoice')
    const page = await openWallet(name)
    if (paste) {
      await tab(page, 'send')
      await page.waitFor("!document.querySelector('#lnSendCard').classList.contains('hide')", 120000)
      await page.eval(`(()=>{ const t=document.querySelector('#lnSendBolt11'); t.value=${JSON.stringify(inv)}; t.dispatchEvent(new Event('input')); return true })()`)
    } else {
      await page.go(base + '#pay?invoice=' + encodeURIComponent(inv))
      await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
    }
    const filled = await page.waitFor(`(()=>{ const t=document.querySelector('#lnSendBolt11'); return t && t.value.trim() === ${JSON.stringify(inv)} && !document.querySelector('#lnSendCard').classList.contains('hide') ? true : false })()`, 120000)
    check(paste ? 'the invoice is in Pay an invoice' : 'the link opens Send with the invoice filled in', !!filled)
    const words = forbiddenIn(await visibleText(page)).filter((w) => !['on-chain', 'lightning', 'channel', 'channels'].includes(w))
    check('the card says none of the words default mode never says', !words.length, words)
    await shot(page, `${name}-pay-1-filled.png`)
    const tP = Date.now()
    await click(page, '#lnSendBtn')
    let said
    try {
      said = await page.waitFor("(()=>{ const t=(document.querySelector('#lnSendStatus')?.textContent||'').trim(); return /Paid|Nothing was sent|could not|refused/i.test(t) ? t : false })()", 240000)
    } catch (e) {
      said = 'no answer in 240 s; the card says: ' + (await page.eval("(document.querySelector('#lnSendStatus')?.textContent||'').trim()").catch(() => '?'))
    }
    check('the invoice is paid from the BTC balance', /^Paid/.test(said), `${said} (${secs(Date.now() - tP)} from the click)`)
    await shot(page, `${name}-pay-2-paid.png`)
    await page.stop()
  } else if (step === 'codes') {
    const page = await openWallet(name)
    let last = await waitJoined(page)
    const codes = []
    for (let i = 0; i < Number(rest[0] || 1); i++) {
      await click(page, '#btnNewAddr')
      last = await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i.test(t) && t!==${JSON.stringify(last)} ? t : false })()`, 300000)
      codes.push(last)
    }
    writeFileSync(join(work, name + '.codes'), codes.join('\n') + '\n')
    note(`${codes.length} code(s) written to ${name}.codes`)
    await page.stop()
  } else if (step === 'sendmany') {
    const [ticker, amount, ...files] = rest
    const codes = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean))
    const pa = await openWallet(name)
    await waitJoined(pa)
    await tab(pa, 'send')
    await pa.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ticker)})`, 180000)
    for (let i = 1; i < codes.length; i++) await click(pa, '#btnAddRec')
    const rows = await pa.eval(`(()=>{ const codes=${JSON.stringify(codes)}; const rs=[...document.querySelectorAll('#recipients .rec')];
      rs.forEach((r, i) => { r.querySelector('.raddr').value=codes[i]; r.querySelector('.raddr').dispatchEvent(new Event('input'));
        const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\s/)[0]===${JSON.stringify(ticker)}); if(!o) throw new Error('no ${ticker}'); s.value=o.value; s.dispatchEvent(new Event('change'));
        r.querySelector('.ramt').value=${JSON.stringify(amount)}; r.querySelector('.ramt').dispatchEvent(new Event('input')) }); return rs.length })()`)
    note(`${rows} row(s) filled for ${codes.length} code(s)`)
    await click(pa, '#btnReview')
    const title = await pa.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 300000)
    check('the review', !title.startsWith('ERR'), title.replace(/\n+/g, ' | ').slice(0, 600))
    if (!title.startsWith('ERR')) {
      const tClick = Date.now()
      await pa.eval("document.querySelector('.modal button.primary').click()")
      const done = await pa.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending/.test(t) ? t : false })()", 2400000)
      check('the sender says it is sent', /^Sent/.test(done), `${done} (${secs(Date.now() - tClick)} from the click)`)
      await sleep(30000)
    }
    await shot(pa, `${name}-sendmany.png`)
    note('console A: ' + pa.console.filter((l) => /tree send|leaves/i.test(l)).slice(-6).join(' | '))
    await pa.stop()
  } else if (step === 'settle') {
    const page = await openWallet(name)
    await devLeaves(page)
    let coins = await listCoins(page)
    note(`${coins.length} coin(s): ` + coins.map((c) => `${c.leaf.slice(0, 12)} ${c.state} ${c.kind} ${c.value}`).join('; '))
    for (const c of coins.filter((c) => c.kind !== 'batch' && c.state === 'live')) {
      const btn = `.leaf-coin[data-leaf="${c.leaf}"] button[data-action="settle"]`
      const ok = await page.waitFor(`(()=>{ const b=document.querySelector(${JSON.stringify(btn)}); return b ? (b.disabled ? false : 'ok') : 'gone' })()`, 300000).catch(() => 'still disabled')
      if (ok !== 'ok') { note(`coin ${c.leaf.slice(0, 12)}: no Settle now (${ok})`); continue }
      note(`coin ${c.leaf.slice(0, 12)}: Settle now`)
      await click(page, btn)
      const q = await page.waitFor("(()=>{ const q=document.querySelector('#leafQuote'); return q ? q.innerText : false })()", 300000).catch(() => null)
      if (!q) { check(`coin ${c.leaf.slice(0, 12)}: a settle quote`, false); continue }
      await click(page, '#btnLeafSettleConfirm')
      await page.waitFor("!document.querySelector('#leafQuote')", 300000).catch(() => null)
      note(`coin ${c.leaf.slice(0, 12)}: settle quoted (${q.replace(/\n+/g, ' | ').slice(0, 200)}) and handed over`)
      await sleep(2000)
    }
    // Done once the wallet holds as many live leaves of a round as it held coins before, and
    // nothing is in flight.
    const want = coins.filter((c) => !['spent', 'exited', 'lost', 'forfeited', 'given'].includes(c.state)).length
    const t = Date.now()
    while (Date.now() - t < 1800000) {
      coins = await listCoins(page)
      const gone = (c) => ['spent', 'exited', 'lost', 'forfeited'].includes(c.state)
      const leaves = coins.filter((c) => c.kind === 'batch' && c.state === 'live').length
      if (leaves >= want && coins.every((c) => gone(c) || (c.kind === 'batch' && c.state === 'live'))) break
      await sleep(10000)
    }
    note(`after ${secs(Date.now() - t)}: ` + coins.map((c) => `${c.leaf.slice(0, 12)} ${c.state} ${c.kind} ${c.value}`).join('; '))
    const held = coins.filter((c) => !['spent', 'exited', 'lost', 'forfeited'].includes(c.state))
    check(`every coin held is a live leaf of a round, ${want} of them`, held.length >= want && held.every((c) => c.kind === 'batch' && c.state === 'live'), `${held.length} held`)
    writeFileSync(join(work, name + '.coins.json'), JSON.stringify({ at: new Date().toISOString(), coins }, null, 1))
    await page.stop()
  } else if (step === 'coins' || step === 'exit') {
    const page = await openWallet(name)
    await devLeaves(page)
    const coins = await listCoins(page)
    note(`${coins.length} coin(s): ` + coins.map((c) => `${c.leaf.slice(0, 12)} ${c.state} ${c.kind} ${c.value}`).join('; '))
    if (step === 'coins') {
      writeFileSync(join(work, name + '.coins.json'), JSON.stringify({ at: new Date().toISOString(), coins }, null, 1))
    } else {
      const runs = []
      for (const c of coins.filter((c) => c.button)) {
        const t = Date.now()
        const before = await page.eval("document.querySelectorAll('#leafDrill .leaf-drill-run').length")
        const btn = `.leaf-coin[data-leaf="${c.leaf}"] button[data-action="exit"]`
        if (!(await page.waitFor(`(()=>{ const b=document.querySelector(${JSON.stringify(btn)}); return b ? (b.disabled ? false : 'ok') : 'gone' })()`, 600000).then((v) => v === 'ok'))) {
          runs.push({ leaf: c.leaf, result: 'no drill button any more', at: new Date().toISOString() }); continue
        }
        await click(page, btn)
        const quote = await page.waitFor(`(()=>{ const d=document.querySelector('#leafDrill'); if(!d || !d.textContent.includes(${JSON.stringify(c.leaf)})) return false;
          const q=document.querySelector('#leafExitQuote'); if(q) return q.innerText;
          const r=d.querySelectorAll('.leaf-drill-run'); return r.length > ${before} ? 'ERR ' + r[r.length-1].innerText : false })()`, 600000)
        let result
        if (quote.startsWith('ERR ')) { result = quote } else {
          const n = await page.eval("document.querySelectorAll('#leafDrill .leaf-drill-run').length")
          await page.waitFor("document.querySelector('#btnLeafExitConfirm') && !document.querySelector('#btnLeafExitConfirm').disabled", 600000)
          await click(page, '#btnLeafExitConfirm')
          result = await page.waitFor(`(()=>{ const r=document.querySelectorAll('#leafDrill .leaf-drill-run'); return r.length > ${n} ? r[r.length-1].innerText : false })()`, 900000)
        }
        const run = { leaf: c.leaf, asset: c.asset, value: c.value, state_before: c.state, quote, result, seconds: (Date.now() - t) / 1000, at: new Date().toISOString() }
        runs.push(run)
        check(`coin ${c.leaf.slice(0, 12)} (${c.value}): the exit ran`, !/refused|^ERR/i.test(result), `${result.replace(/\n+/g, ' | ')} (${secs(Date.now() - t)})`)
        writeFileSync(join(work, name + '.exit.json'), JSON.stringify({ runs }, null, 1))
      }
      const after = await listCoins(page)
      note(`after: ` + after.map((c) => `${c.leaf.slice(0, 12)} ${c.state}`).join('; '))
      writeFileSync(join(work, name + '.exit.json'), JSON.stringify({ runs, after }, null, 1))
      await shot(page, `${name}-exit.png`)
    }
    note('console: ' + page.console.filter((l) => /leaves|exit|operator|server|refus/i.test(l)).slice(-10).join(' | '))
    await page.stop()
  } else if (step === 'show') {
    const page = await openWallet(name)
    const tOpen = Date.now()
    await tab(page, 'balance')
    await sleep(Number(rest[0] || 20000))
    const bal = await balances(page)
    note(`figures ${secs(Date.now() - tOpen)} after open: ${JSON.stringify(bal)}`)
    note('console: ' + page.console.filter((l) => /faucet|receive code|tree send|leaves|board|leaf|offboard|ark|btc/i.test(l)).slice(-12).join(' | '))
    writeFileSync(join(ev, `${name}.totals.json`), JSON.stringify(bal, null, 1))
    await shot(page, `${name}-balance.png`)
    await page.stop()
  } else {
    throw new Error('no step ' + step)
  }
}

const stopAll = () => Promise.all(pages.map((p) => p.stop().catch(() => {})))
main().then(async () => { await stopAll(); note(`done in ${secs(Date.now() - t0)}, ${failures} failed`); process.exit(failures ? 1 : 0) },
  async (e) => { note('FAIL ' + (e && e.stack || e)); await stopAll(); process.exit(1) })
