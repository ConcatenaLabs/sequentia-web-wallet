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
//   receive  wallet <name>'s Receive in default mode, part by part: New code moves the code to a new
//          address; with a payment name chosen (`am5…`, or the name given) a code without an amount
//          carries the name's LNURL-pay, which the service answers; an amount in BTC, and in an asset
//          the operator receives over Lightning, carries an invoice instead; the Confidential switch
//          gives the confidential address alone, says what stays public, and is off again once
//          Receive is left. A screenshot of each, and none of the words default mode never says.
//          A name the wallet did not hold before is removed at the end unless `keep` follows
//          (`receive A keep`), and one it held is removed with `release`; `--name <name>` chooses
//          the name
//   name   wallet <name>'s payment name as its receive QR, paid by wallet <payer> while <name> is
//          closed: `name B A [USDX]` with the page served by tooling/live-proxy.mjs --lnaddr <dir>
//          --lnaddr-forge <file>, and the same <dir> and <file> given here (`--lnaddr-dir`,
//          `--forge`). B chooses a name (or keeps its own), its QR holds the name alone, and its stock
//          of signed codes fills; B closes; A pays the name twice (each a different signed code from
//          the stock, in seconds), is refused a code whose address the service swapped and one under
//          a key of the service's own, and pays the address of the stocked code at the highest index
//          on the chain; B opens again, its stock fills up again, and its figures are written for
//          `restore` (<work>/evidence/B.totals.json)
//   coins  wallet <name>'s coins in the tree as developer mode lists them (state, kind, asset,
//          value, dates), written to <work>/<name>.coins.json
//   settle wallet <name> settles every coin it holds in the tree that is not a leaf of a round (kind batch)
//          (developer mode's Settle now: the quote, then Sign and hand over), and stays open until
//          each is a live leaf of a round, up to 30 minutes; written to <work>/<name>.coins.json
//   home   wallet <name> takes every coin it holds in the tree home in default mode: with the operator
//          unreachable, Balance's Take my coins home, the review, then Take them home; what each
//          said and every transaction broadcast, written to <work>/<name>.home.json
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
// `receive --name <name>`: the payment name the step chooses, when the wallet holds none.
const nameArg = flag('--name', null)
// `name`: the local name service's directory and the file that makes it forge a lookup.
const lnaddrDir = flag('--lnaddr-dir', null)
const forgeFile = flag('--forge', null)
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
  // A wallet with a payment name shows the name: its full code is one tap away.
  return page.waitFor("(()=>{ const f=document.querySelector('#btnRecvFull'); if(f && !f.classList.contains('hide') && f.textContent==='Show full code') f.click(); const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && /^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i.test(a.textContent) ? a.textContent : false })()", ms)
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
      note('the code paid carries ' + (['ark', 'sequentia', 'lightning', 'amount'].filter((k) => new RegExp('[?&]' + k + '=', 'i').test(code)).map((k) => k === 'lightning' && /[?&]lightning=LNURL1/i.test(code) ? 'lightning (a payment name)' : k).join(', ') || 'the address alone'))
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
    const title = await pa.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e && !/^Moving |cannot be moved out of the Ark yet/.test(e) ? 'ERR '+e : false })()", 1500000)
    // A payment on the chain (an address the wallet's coins there cover, a confidential address)
    // has the chain's own review.
    const chainReview = /^Confirm Sequentia payment/i.test(title.trim())
    check('the review asks to send it, in plain words', (/^Send .*\?/i.test(title.trim()) || chainReview) && !forbiddenIn(title).length, title.replace(/\n+/g, ' | '))
    if (/^ERR/.test(title.trim())) { note('console A: ' + pa.console.slice(-8).join(' | ')); return }
    await shot(pa, `${name}-send-review.png`)
    const tClick = Date.now()
    await pa.eval("document.querySelector('.modal button.primary').click()")
    const done = await pa.waitFor("(()=>{ if(document.querySelector('.modal .sent-title')) return 'Sent ' + (document.querySelector('.modal .kv .v.mono')?.textContent||''); const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending|Signing|Checking/.test(t) ? t : false })()", 2400000).catch(async (e) => { note('still: ' + await pa.eval("document.querySelector('.modal .status')?.textContent||''") + ' console: ' + pa.console.slice(-8).join(' | ')); throw e })
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
      const done = await pa.waitFor("(()=>{ if(document.querySelector('.modal .sent-title')) return 'Sent ' + (document.querySelector('.modal .kv .v.mono')?.textContent||''); const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending|Signing|Checking/.test(t) ? t : false })()", 2400000)
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
  } else if (step === 'home') {
    // Default mode's own way home: with the operator unreachable (the page served by
    // tooling/live-proxy.mjs --refuse /arca), Balance shows one card and Take my coins home; the
    // review, then Take them home. What each said, and every transaction the library broadcast (its
    // `[leaves] home:` lines), are written to <work>/<name>.home.json.
    const page = await openWallet(name)
    await page.eval("(()=>{ const c=document.querySelector('#modeUser'); if(c && !c.checked){ c.checked=true; c.dispatchEvent(new Event('change')) } return true })()")
    await tab(page, 'balance')
    const t = Date.now()
    const card = await page.waitFor("(()=>{ const b=document.querySelector('#btnTakeHome'); return b && b.offsetParent !== null ? document.querySelector('#homeCard').innerText : false })()", 900000)
    note(`the card shows ${secs(Date.now() - t)} after open: ${card.replace(/\n+/g, ' | ')}`)
    const words = forbiddenIn(card)
    check('the card says none of leaf, round, operator, tree, exit…', !words.length, words)
    await shot(page, `${name}-home-1-card.png`)
    await click(page, '#btnTakeHome')
    const review = await page.waitFor("(()=>{ const m=document.querySelector('.modal'); if(!m) return false; const ok=document.querySelector('#btnTakeHomeConfirm'); const st=m.querySelector('.status'); return (ok && !ok.disabled) || (st && /err/.test(st.className)) ? m.innerText : false })()", 900000)
    note('review: ' + review.replace(/\n+/g, ' | '))
    check('the review says none of the words default mode never says', !forbiddenIn(review).length, forbiddenIn(review))
    await shot(page, `${name}-home-2-review.png`)
    const out = { card, review }
    if (await page.eval("!!(document.querySelector('#btnTakeHomeConfirm') && !document.querySelector('#btnTakeHomeConfirm').disabled)")) {
      const t2 = Date.now()
      await click(page, '#btnTakeHomeConfirm')
      out.result = await page.waitFor("(()=>{ const m=document.querySelector('.modal'); const ok=document.querySelector('#btnTakeHomeConfirm'); return m && ok && ok.classList.contains('hide') ? m.innerText : false })()", 1800000)
      note(`result in ${secs(Date.now() - t2)}: ${out.result.replace(/\n+/g, ' | ')}`)
      check('every coin is on its way home', /on its way to your own address/.test(out.result) && !/cannot be taken home/.test(out.result), out.result.replace(/\n+/g, ' | '))
      await shot(page, `${name}-home-3-sent.png`)
      await click(page, '.modal button.ghost')
      await sleep(3000)
      out.after = await page.eval("document.querySelector('#homeCard') ? document.querySelector('#homeCard').innerText : ''")
      note('card after: ' + out.after.replace(/\n+/g, ' | '))
      await shot(page, `${name}-home-4-balance.png`)
    } else check('the review offers to take the coins home', false, review)
    out.broadcast = page.console.filter((l) => /\[leaves\] home:/.test(l))
    for (const l of out.broadcast) note(l)
    writeFileSync(join(work, name + '.home.json'), JSON.stringify(out, null, 1))
    note('console: ' + page.console.filter((l) => /leaves|home|operator|refus/i.test(l)).slice(-10).join(' | '))
    await page.stop()
  } else if (step === 'receive') {
    const keep = rest[0]
    const page = await openWallet(name)
    await waitJoined(page)
    const codeNow = () => page.eval("document.querySelector('#addr').textContent")
    const isCode = "/^bitcoin:/i.test(document.querySelector('#addr').textContent)"
    const addrOf = (c) => c.replace(/^bitcoin:/i, '').split('?')[0].toLowerCase()
    const param = (c, k) => { const m = new RegExp('[?&]' + k + '=([^&]*)', 'i').exec(c); return m ? decodeURIComponent(m[1]) : null }
    // The picture read back with the page's own QR reader: what it holds, and its version (size).
    const qrRead = () => page.eval(`(async()=>{ const img=document.querySelector('#qr'); if(!img.getAttribute('src')) return null; if(!img.complete) await new Promise(r=>img.onload=r);
      const c=document.createElement('canvas'); const k=Math.max(1, Math.ceil(600/img.naturalWidth)); c.width=img.naturalWidth*k+80; c.height=img.naturalHeight*k+80; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height); x.imageSmoothingEnabled=false; x.drawImage(img,40,40,img.naturalWidth*k,img.naturalHeight*k);
      const d=x.getImageData(0,0,c.width,c.height); const r=window.jsQR(d.data,d.width,d.height); return r ? { data: r.data, version: r.version } : { data: null } })()`)
    const qrCheck = async (what) => { const q = await qrRead(); const c = await codeNow(); check(`${what}: the picture reads back as the code`, !!q && q.data === c, q && { version: q.version, chars: c.length }) }
    const noWords = async (what) => { const w = forbiddenIn(await visibleText(page)).filter((x) => !['on-chain', 'lightning', 'channel', 'channels'].includes(x)); check(what + ': none of the words default mode never says', !w.length, w) }
    // 1. The code, and New code.
    const c1 = await page.waitFor(`${isCode} ? document.querySelector('#addr').textContent : false`, 300000)
    check('Receive shows the code; the Confidential switch is under it, off', await page.eval("!document.querySelector('#recvConfRow').classList.contains('hide') && !document.querySelector('#recvConfChk').checked && document.querySelector('#recvConfLbl').textContent==='Confidential'"), await page.eval("document.querySelector('#recvConfTip').textContent"))
    await shot(page, `${name}-receive-1-code.png`)
    await qrCheck('the code')
    await click(page, '#btnNewAddr')
    const c2 = await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^bitcoin:/i.test(t) && t!==${JSON.stringify(c1)} ? t : false })()`, 300000)
    check('New code moves the code to a new address', addrOf(c2) !== addrOf(c1) && /^tb1/.test(addrOf(c2)), `${addrOf(c1)} -> ${addrOf(c2)}`)
    check('and makes its other parts new', param(c2, 'sequentia') !== param(c1, 'sequentia'))
    await shot(page, `${name}-receive-2-new-code.png`)
    const addrs = new Set([addrOf(c1), addrOf(c2)])
    for (let i = 0; i < 3; i++) { const was = await codeNow(); await click(page, '#btnNewAddr'); addrs.add(addrOf(await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^bitcoin:/i.test(t) && t!==${JSON.stringify(was)} ? t : false })()`, 300000))) }
    check('five codes, five addresses', addrs.size === 5, [...addrs])
    // The address moved to is the one shown again after a reload, while it is unused.
    const last = addrOf(await codeNow())
    await page.go(base); await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
    const again = addrOf(await waitJoined(page))
    check('after a reload the code shows the same address', again === last, `${last} -> ${again}`)
    // 2. A payment name: the code without an amount carries its LNURL-pay.
    let named = await page.eval("document.querySelector('#nameAddr').textContent")
    const held = !!named
    if (!named) {
      const want = nameArg || ('am5' + Math.random().toString(36).slice(2, 9))
      await page.waitFor("document.querySelector('#btnNameChoose') && document.querySelector('#btnNameChoose').offsetParent !== null", 120000)
      await click(page, '#btnNameChoose')
      await page.eval(`(()=>{ const i=document.querySelector('#nameInput'); i.value=${JSON.stringify(want)}; return true })()`)
      await click(page, '#btnNameSave')
      named = await page.waitFor("(()=>{ const t=document.querySelector('#nameAddr').textContent; const s=document.querySelector('#nameStatus').textContent; return t || (s ? 'ERR '+s : false) })()", 120000)
    }
    check('the wallet holds a payment name', /@/.test(named), named)
    // With a name, Receive shows the name: the picture holds it alone, in lower case.
    const nameView = await page.waitFor(`(()=>{ const a=document.querySelector('#addr').textContent; return a===${JSON.stringify(named)} && !document.querySelector('#btnRecvFull').classList.contains('hide') ? a : false })()`, 120000).catch(() => null)
    check('Receive shows the name, with Show full code beside it', !!nameView, nameView)
    { const q = await qrRead(); check('the picture reads back as the name alone', !!q && q.data === named.toLowerCase(), q && { data: q.data, version: q.version }) }
    check('under the name: lookups are public, in plain words', await page.eval("!document.querySelector('#recvNamePublic').classList.contains('hide') && document.querySelector('#recvNamePublic').textContent"), await page.eval("document.querySelector('#recvNamePublic').textContent"))
    check('no New code with the name shown', await page.eval("document.querySelector('#btnNewAddr').classList.contains('hide')"))
    await shot(page, `${name}-receive-3a-name-qr.png`)
    await noWords('Receive showing the name')
    await click(page, '#btnRecvFull')
    const c3 = await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /[?&]lightning=LNURL1/.test(t) ? t : false })()`, 120000).catch(() => null)
    check('without an amount the code carries the name\'s LNURL-pay', !!c3, c3 && param(c3, 'lightning').slice(0, 24) + '…')
    if (c3) {
      const { lnurlDecode } = await import('../pay-code.js')
      const url = lnurlDecode(param(c3, 'lightning'))
      const n = named.split('@')[0]
      check('it is the name\'s own LNURL-pay', url === `https://${named.split('@')[1]}/.well-known/lnurlp/${n}`, url)
      const pr = await fetch(url).then((r) => r.json()).catch((e) => ({ error: e.message }))
      check('which the service answers with a pay request', pr.tag === 'payRequest' && typeof pr.callback === 'string', { tag: pr.tag, minSendable: pr.minSendable, maxSendable: pr.maxSendable, error: pr.reason || pr.error })
      // A Lightning wallet scanning the code asks the callback for an amount of its choosing: the
      // open wallet makes the invoice for exactly it.
      if (pr.callback) {
        const want = 2000n * 1000n
        const cb = await fetch(pr.callback + (pr.callback.includes('?') ? '&' : '?') + 'amount=' + want).then((r) => r.json()).catch((e) => ({ error: e.message }))
        const { decodeBolt11 } = await import('../bolt11.js')
        const d = cb.pr ? decodeBolt11(cb.pr) : null
        check('a Lightning wallet paying it gets an invoice for the amount it chose, from this wallet', !!d && d.ok && d.chain === 'btc' && BigInt(d.amountMsat) === want, cb.pr ? cb.pr.slice(0, 24) + '…' : cb)
      }
      note(`code with the name: ${c3.length} characters`)
      writeFileSync(join(work, name + '.code'), c3)
    }
    await shot(page, `${name}-receive-3-name.png`)
    await qrCheck('the code with the name')
    await noWords('Receive with a name')
    // 3. An amount: an invoice, not the name.
    const setAmount = (v, asset = 'BTC') => page.eval(`(()=>{ const s=document.querySelector('#recvAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(asset)}); if(!o) return 'no '+${JSON.stringify(asset)}+': '+[...s.options].map(o=>o.textContent).join(','); s.value=o.value; s.dispatchEvent(new Event('change')); const i=document.querySelector('#recvAmt'); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return true })()`)
    await setAmount('0.0002')
    const c4 = await page.waitFor("(()=>{ const t=document.querySelector('#addr').textContent; return /[?&]lightning=LNTB/i.test(t) ? t : false })()", 120000).catch(() => null)
    check('an amount in BTC: the code names it and carries an invoice, not the name', !!c4 && param(c4, 'amount') === '0.0002' && !/LNURL1/.test(c4), c4 && { amount: param(c4, 'amount'), lightning: param(c4, 'lightning').slice(0, 16) + '…' })
    await shot(page, `${name}-receive-4-amount-btc.png`)
    await qrCheck('the code with an amount in BTC')
    const assets = await page.eval("[...document.querySelector('#recvAsset').options].map(o=>o.textContent.trim())")
    note('the amount\'s menu: ' + assets.join(', '))
    const asset = assets.find((a) => a !== 'BTC')
    if (asset) {
      const r = await setAmount('1', asset)
      if (r !== true) note(r)
      const c5 = await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /[?&]lightning=/i.test(t) && !/LNURL1/.test(t) && !/[?&]amount=/.test(t) && t!==${JSON.stringify(c4)} ? t : false })()`, 180000).catch(() => null)
      check(`an amount in ${asset}: the code carries its invoice in the asset, and no BTC amount`, !!c5, c5 && param(c5, 'lightning').slice(0, 16) + '…')
      await shot(page, `${name}-receive-5-amount-${asset}.png`)
      await qrCheck(`the code with an amount in ${asset}`)
    } else note('the operator receives no asset over Lightning now: no asset in the menu')
    await setAmount('')
    await page.waitFor("/[?&]lightning=LNURL1/.test(document.querySelector('#addr').textContent)", 120000).catch(() => null)
    // 4. Confidential.
    await page.eval("(()=>{ const c=document.querySelector('#recvConfChk'); c.checked=true; c.dispatchEvent(new Event('change')); return true })()")
    const cc = await codeNow()
    check('Confidential on: the code is the confidential address alone', /^tsqb1[0-9a-z]+$/.test(cc), cc.slice(0, 20) + '…')
    const shown = await page.eval("({ note: document.querySelector('#recvConfNote').textContent, noteShown: !document.querySelector('#recvConfNote').classList.contains('hide'), amount: !document.querySelector('#recvAmtRow').classList.contains('hide'), qr: !!document.querySelector('#qr').getAttribute('src') })")
    check('it says what stays public, shows no amount, and has its picture', shown.noteShown && /BTC is never confidential/.test(shown.note) && !shown.amount && shown.qr, shown)
    await shot(page, `${name}-receive-6-confidential.png`)
    writeFileSync(join(work, name + '.confidential-code'), cc)
    await qrCheck('the confidential code')
    await noWords('Receive, Confidential on')
    await click(page, '#btnNewAddr')
    const cc2 = await page.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^tsqb1/.test(t) && t!==${JSON.stringify(cc)} ? t : false })()`, 60000).catch(() => null)
    check('New code moves the confidential code to a new address too', !!cc2)
    await tab(page, 'balance'); await sleep(300); await tab(page, 'receive')
    const back = await page.waitFor(`${isCode} || document.querySelector('#addr').textContent===${JSON.stringify(named)} ? document.querySelector('#addr').textContent : false`, 120000).catch(() => null)
    check('leaving Receive shows the name again', back === named, back)
    check('leaving Receive turns Confidential off again', !!back && !(await page.eval("document.querySelector('#recvConfChk').checked")))
    await shot(page, `${name}-receive-7-back.png`)
    if (keep !== 'keep' && (!held || keep === 'release')) {
      await click(page, '#btnNameRemove')
      await page.waitFor(`${isCode}`, 120000).catch(() => null)
      await page.waitFor("!document.querySelector('#nameAddr').textContent", 60000).catch(() => null)
      const c7 = await codeNow()
      check('with the name removed, the code carries no LNURL-pay', !/LNURL1/.test(c7))
    }
    await page.stop()
  } else if (step === 'name') {
    const [payer, ticker = 'USDX'] = rest
    if (!lnaddrDir || !forgeFile) throw new Error('name needs --lnaddr-dir and --forge (tooling/live-proxy.mjs --lnaddr, --lnaddr-forge)')
    const { readPayCode } = await import('../pay-code.js')
    const { NAME_WORDS } = await import('../lnaddr.js')
    const { STOCK_SIZE } = await import('../name-stock.js')
    const { RECEIVE_GAP } = await import('../receive-index.js')
    const store = () => { try { return JSON.parse(readFileSync(join(lnaddrDir, 'lnaddr-names.json'), 'utf8')).names || {} } catch { return {} } }
    const held = (n) => ((store()[n] || {}).stock || [])
    const waitStock = async (n, want, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (held(n).length >= want) return held(n).length; await sleep(2000) } return held(n).length }
    // 1. B: the name, its QR, its stock.
    const pb = await openWallet(name)
    await waitJoined(pb)
    await tab(pb, 'balance'); await tab(pb, 'receive')
    let named = await pb.waitFor("document.querySelector('#nameBox') && !document.querySelector('#nameBox').classList.contains('hide') ? (document.querySelector('#nameAddr').textContent || 'none') : false", 120000)
    if (named === 'none') {
      const want = nameArg || ('pn1' + Math.random().toString(36).slice(2, 9))
      await click(pb, '#btnNameChoose')
      await pb.eval(`(()=>{ const i=document.querySelector('#nameInput'); i.value=${JSON.stringify(want)}; return true })()`)
      await click(pb, '#btnNameSave')
      named = await pb.waitFor("(()=>{ const t=document.querySelector('#nameAddr').textContent; const s=document.querySelector('#nameStatus').textContent; return t || (s ? 'ERR '+s : false) })()", 120000)
    }
    const n = named.split('@')[0]
    writeFileSync(join(work, name + '.name'), named + '\n')
    check('B holds a payment name', /@/.test(named), named)
    const nv = await pb.waitFor(`document.querySelector('#addr').textContent===${JSON.stringify(named)} ? true : false`, 60000).catch(() => false)
    const q = await pb.eval(`(async()=>{ const img=document.querySelector('#qr'); if(!img.getAttribute('src')) return null; if(!img.complete) await new Promise(r=>img.onload=r);
      const c=document.createElement('canvas'); const k=Math.max(1, Math.ceil(600/img.naturalWidth)); c.width=img.naturalWidth*k+80; c.height=img.naturalHeight*k+80; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height); x.imageSmoothingEnabled=false; x.drawImage(img,40,40,img.naturalWidth*k,img.naturalHeight*k);
      const d=x.getImageData(0,0,c.width,c.height); const r=window.jsQR(d.data,d.width,d.height); return r ? { data: r.data, version: r.version } : { data: null } })()`)
    check('Receive shows the name, and the picture holds the name alone', nv && !!q && q.data === named, q)
    await shot(pb, `${name}-name-1-qr.png`)
    const tS = Date.now()
    const got = await waitStock(n, STOCK_SIZE, 600000)
    check(`B left ${STOCK_SIZE} signed codes with the service`, got >= STOCK_SIZE, `${got} in ${secs(Date.now() - tS)}`)
    const mine = await pb.eval(`(()=>{ const k=Object.keys(localStorage).find(k=>k.startsWith('swk.lnaddr.stock.')); return k ? JSON.parse(localStorage.getItem(k)) : null })()`)
    const idx = Object.values((mine && mine.mine) || {}).map((c) => c.index).sort((a, b) => a - b)
    const nextUnused = await pb.eval('(()=>{ try{ return unifiedNextUnused() }catch{ return null } })()').catch(() => null)
    check('every stocked code is at an address inside the twenty a restore reads past the last one paid', idx.length >= STOCK_SIZE && idx.every((i) => i >= 0 && i < (nextUnused ?? 0) + RECEIVE_GAP), { indices: idx, nextUnused })
    // The code at the highest index: its address is paid on the chain later.
    const top = Object.entries((mine && mine.mine) || {}).sort((a, b) => b[1].index - a[1].index)[0]
    const topCode = (held(n).find((c) => c.id === (top && top[0])) || {}).code
    const topAddr = topCode ? readPayCode(topCode).address : null
    note(`highest stocked index ${top && top[1].index}: ${topAddr}`)
    await click(pb, '#btnRecvFull'); await sleep(800)
    await shot(pb, `${name}-name-2-full-code.png`)
    await click(pb, '#btnRecvFull')
    await pb.stop(); pages.splice(pages.indexOf(pb), 1)
    note('B is closed')
    // 2. A pays the name, twice, while B is closed.
    const pa = await openWallet(payer)
    await waitJoined(pa)
    const send = async (dest, amount, what) => {
      await tab(pa, 'send')
      await pa.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim()===${JSON.stringify(ticker)})`, 180000)
      await pa.eval(`(()=>{ document.querySelector('#sendErr').textContent=''; const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(dest)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
        const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\s/)[0]===${JSON.stringify(ticker)}); s.value=o.value; s.dispatchEvent(new Event('change'));
        r.querySelector('.ramt').value=${JSON.stringify(amount)}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
      const before = held(n).length
      await click(pa, '#btnReview')
      const title = await pa.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e && !/^Moving /.test(e) ? 'ERR '+e : false })()", 600000)
      if (/^ERR /.test(title)) return { refused: title.slice(4), before }
      await shot(pa, `${payer}-name-${what}-review.png`)
      const tClick = Date.now()
      await pa.eval("document.querySelector('.modal button.primary').click()")
      const done = await pa.waitFor("(()=>{ if(document.querySelector('.modal .sent-title')) return 'Sent ' + (document.querySelector('.modal .kv .v.mono')?.textContent||''); const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending|Signing|Checking/.test(t) ? t : false })()", 2400000)
      const all = await pa.eval("document.querySelector('.modal')?.innerText||''")
      await shot(pa, `${payer}-name-${what}-done.png`)
      await pa.eval("(()=>{ const b=[...document.querySelectorAll('.modal button')].find(b=>/close|done|ok/i.test(b.textContent)); if(b) b.click(); else document.querySelector('.modal')?.remove(); return true })()").catch(() => {})
      return { done, all, ms: Date.now() - tClick, title, before }
    }
    for (const k of [1, 2]) {
      const r = await send(named, '1', `pay${k}`)
      check(`A pays ${named} (${k}) while B is closed`, !!r.done && /^Sent/.test(r.done) && /in seconds/.test(r.title), r.refused || `${r.done.trim().slice(0, 60)} (${secs(r.ms)} from the click)`)
      check(`  it took one code from the stock`, held(n).length === r.before - 1, `${r.before} -> ${held(n).length}`)
    }
    // 3. A service broken into: the address swapped, then a key of its own.
    writeFileSync(forgeFile, 'address\n')
    let r = await send(named, '1', 'forged')
    check('a code whose address the service swapped is refused, nothing sent', r.refused === NAME_WORDS.unsigned, r.refused || r.done)
    await shot(pa, `${payer}-name-forged-refused.png`)
    writeFileSync(forgeFile, 'key\n')
    r = await send(named, '1', 'forged-key')
    check('a code under a key of the service\'s own is refused: A paid this name before', r.refused === NAME_WORDS.changed, r.refused || r.done)
    await shot(pa, `${payer}-name-forged-key-refused.png`)
    const { unlinkSync } = await import('node:fs'); unlinkSync(forgeFile)
    // 4. The address of the stocked code at the highest index, paid on the chain.
    if (topAddr) {
      r = await send(topAddr, '1', 'address')
      check(`A pays the address of the highest stocked code (${topAddr}) on the chain`, !!r.done && /^Sent/.test(r.done), r.refused || r.done)
    } else check('the highest stocked code\'s address was read', false)
    await pa.stop(); pages.splice(pages.indexOf(pa), 1)
    // 5. B opens again: its stock fills up again, and it shows what it was paid.
    const left = held(n).length
    const pb2 = await openWallet(name)
    await waitJoined(pb2)
    const t2 = Date.now()
    const again = await waitStock(n, STOCK_SIZE, 600000)
    check('B, open again, fills its stock up again', again >= STOCK_SIZE, `${left} -> ${again} in ${secs(Date.now() - t2)}`)
    await tab(pb2, 'balance')
    note('B waits for the payment on the chain to arrive (up to 20 minutes)')
    const tB = Date.now()
    let figs = await balances(pb2)
    for (;;) { figs = await balances(pb2); if ((figs[ticker] && /^[0-9.,]+/.test(figs[ticker].total) && parseFloat(figs[ticker].total.replace(/,/g, '')) >= 3 && !figs[ticker].arriving) || Date.now() - tB > 1200000) break; await sleep(15000) }
    check(`B shows the ${ticker} paid to its name and its address`, !!figs[ticker] && parseFloat(figs[ticker].total.replace(/,/g, '')) >= 3, figs[ticker])
    writeFileSync(join(ev, name + '.totals.json'), JSON.stringify(figs, null, 2))
    await shot(pb2, `${name}-name-3-balance.png`)
    note('console B: ' + pb2.console.filter((l) => /lnaddr|leaves|board/i.test(l)).slice(-8).join(' | '))
  } else if (step === 'namescreen') {
    // node … namescreen B: wallet B's Receive with its payment name, as the owner sees it: the name
    // view (said once), Show full code, and back. Screenshots only, and the checks that go with them.
    const page = await openWallet(name)
    await waitJoined(page)
    await tab(page, 'balance'); await tab(page, 'receive')
    const named = await page.waitFor("(()=>{ const t=document.querySelector('#nameAddr').textContent; return t && document.querySelector('#addr').textContent===t ? t : false })()", 120000).catch(() => null)
    check('Receive shows the name', !!named, named)
    const once = await page.eval("[...document.querySelectorAll('section[data-panel=\"receive\"] *')].filter(e=>e.children.length===0 && e.offsetParent!==null && e.textContent.trim()===document.querySelector('#addr').textContent).length")
    check('the name is said once', once === 1, once)
    check('Remove name is a quiet link at the foot', await page.eval("document.querySelector('#btnNameRemove').classList.contains('quiet') && document.querySelector('#btnNameRemove').offsetParent!==null"))
    const w = forbiddenIn(await visibleText(page)).filter((x) => !['on-chain', 'lightning', 'channel', 'channels'].includes(x))
    check('none of the words default mode never says', !w.length, w)
    await shot(page, `${name}-namescreen-1-name.png`)
    await click(page, '#btnRecvFull'); await sleep(1000)
    await shot(page, `${name}-namescreen-2-full-code.png`)
    await click(page, '#btnRecvFull'); await sleep(500)
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
