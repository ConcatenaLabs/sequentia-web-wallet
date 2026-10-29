#!/usr/bin/env node
// Drives the SeqDEX site trading through this web wallet over their channel (wallet-api.js,
// site-orders.js; the extension's doc/PAIRING.md "Same origin") in headless Chromium: the wallet
// in one tab, the site in another tab of the same browser, both served on one origin by
// tooling/live-proxy.mjs with --dex <seqdex-web checkout>, in front of the public testnet.
//
//   node tooling/live-proxy.mjs --dex ../seqdex-web &
//   node tooling/default-mode-live-drive.mjs <work> new A EURX      # a wallet holding EURX
//   node tooling/seqdex-bridge-drive.mjs <work> A [--base http://127.0.0.1:8791] [--pair EURX-USDX]
//        [--sell 1] [--limit-x 20] [--follow-min 0]
//
// The site connects through its chooser ("Sequentia web wallet"), and the wallet's own dialog
// shows the connection, then each order: a market sale declined in the wallet (nothing moves),
// the same sale approved (one trade), and a limit sale far above the book, which rests. With
// --follow-min, the drive then waits that long for the rested order to be listed on the relay.
// Screenshots and every check go to <work>/evidence/bridge-*.
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const base = flag('--base', 'http://127.0.0.1:8791')
const pair = flag('--pair', 'EURX-USDX')
const sellAmount = flag('--sell', '1')
const limitX = Number(flag('--limit-x', '20'))
const followMin = Number(flag('--follow-min', '0'))
const limitPrice = flag('--limit-price', null)   // with it, the market steps are left out
const ordersOnly = argv.includes('--orders-only') ? (argv.splice(argv.indexOf('--orders-only'), 1), true) : false   // connect and read Your orders only
const [workArg, name] = argv
if (!workArg || !name) { console.error('usage: seqdex-bridge-drive.mjs <work-dir> <wallet name> [flags]'); process.exit(2) }
const work = resolve(workArg)
const ev = join(work, 'evidence'); mkdirSync(ev, { recursive: true })
const log = join(ev, 'bridge.log')
const note = (s) => { const l = `[${new Date().toISOString()}] bridge ${name}: ${s}`; console.log(l); appendFileSync(log, l + '\n') }
let failures = 0
const check = (what, ok, detail) => { note(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failures++; return ok }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secs = (ms) => (ms / 1000).toFixed(1) + ' s'
let n = 0
const shot = (page, f) => page.screenshot(join(ev, `bridge-${String(++n).padStart(2, '0')}-${f}.png`)).then(() => note(`screenshot bridge-${String(n).padStart(2, '0')}-${f}.png`))
const click = (page, sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
const setVal = (page, id, v) => page.eval(`(()=>{ const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); return true })()`)

// The wallet's dialog for a site's request: its text, checked; then Approve or Reject.
let sitePage = null
async function dialog (wallet, what, expect, decide) {
  // The dialog, or the site's word that the wallet refused before showing one.
  const t0 = Date.now()
  let text = null
  while (!text) {
    text = await wallet.eval("(()=>{ const m=document.querySelector('#pageApiApproval'); return m ? m.innerText : null })()").catch(() => null)
    if (text) break
    const err = sitePage ? await sitePage.eval("(()=>{ const s=document.querySelector('#fStatus'); return s && s.classList.contains('err') ? s.textContent : (document.querySelector('#connectWarning')||{}).textContent || null })()").catch(() => null) : null
    if (err && what !== 'connect') throw new Error(`the wallet refused ${what} before any dialog: ${err}`)
    if (Date.now() - t0 > 900000) throw new Error('no dialog for ' + what + ' in 15 min')
    await sleep(1000)
  }
  const flat = text.replace(/\n+/g, ' | ')
  const miss = expect.filter((re) => !re.test(text))
  check(`the wallet shows ${what}`, !miss.length, miss.length ? { missing: miss.map(String), text: flat } : flat)
  check(`${what}: none of the words default mode never says`, !forbiddenIn(text).length, forbiddenIn(text))
  await shot(wallet, `wallet-${what.replace(/\W+/g, '-')}-${decide ? 'approve' : 'reject'}`)
  await click(wallet, decide ? '#pageApiApprove' : '#pageApiReject')
  return text
}

async function siteStatus (site, ms = 900000) {
  return await site.waitFor("(()=>{ const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok') || s.classList.contains('err')) ? (s.classList.contains('ok') ? 'ok: ' : 'err: ') + s.textContent : false })()", ms)
}
async function placeOrder (site, { type, side, amount, price }) {
  await click(site, '#type-' + type); await sleep(300)
  await click(site, '#side-' + side); await sleep(300)
  if (price != null) await setVal(site, 'fPrice', price)
  // The ticket's amounts are You pay and You receive: a sale pays the base, a buy receives it.
  await setVal(site, side === 'sell' ? 'fPay' : 'fReceive', amount)
  await click(site, '#fGo')
}
// Your orders, as the pair's page shows them: its Open orders tab, then its Trades tab.
async function ordersShown (site) {
  const rows = async (tab) => { await click(site, `#ordTabs button[data-o="${tab}"]`); await sleep(2500); return site.eval("[...document.querySelectorAll('#ordersBox tbody tr')].map((d)=>d.innerText.replace(/\\s+/g,' ')).slice(0,8)") }
  const open = await rows('trades').then(() => rows('open'))
  const history = await rows('trades')
  await click(site, '#ordTabs button[data-o="open"]')
  return { open, history }
}

async function main () {
  const profile = join(work, 'profiles', name)
  if (!existsSync(profile)) throw new Error('no wallet ' + name + ' under ' + work + ': run default-mode-live-drive.mjs new first')
  const wallet = new Page(chromium(), { profile })
  walletPage = wallet
  await wallet.open()
  try {
    const me = (await wallet.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await wallet.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await wallet.send('Target.closeTarget', { targetId: t.targetId })
  } catch {}
  await wallet.send('Page.addScriptToEvaluateOnNewDocument', { source: "if (location.hostname === '127.0.0.1') Object.defineProperty(window, 'SEQ_LSP_URL', { value: location.origin + '/lsp', writable: false, configurable: false })" })
  await wallet.go(base + '/wallet/')
  const shown = await wallet.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
  if (shown === 'welcome') {
    const phrase = readFileSync(join(work, name + '.phrase'), 'utf8').trim()
    await wallet.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)})`)
    await wallet.go('about:blank'); await sleep(1500); await wallet.go(base + '/wallet/')
    await wallet.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
  }
  // Joined: Receive shows the receive code.
  await click(wallet, '#tabs button[data-tab="receive"]')
  await wallet.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') })()", 300000)
  await click(wallet, '#tabs button[data-tab="balance"]')
  note('the wallet page is open and joined')

  const site = await wallet.tab(base + `/dex/index.html?pair=${pair}&view=default`)
  sitePage = site
  await site.send('Runtime.enable'); await site.send('Page.enable')
  await site.waitFor("document.querySelector('#btnConnect') && document.querySelector('#fGo')", 120000)
  await click(site, '#btnConnect')
  const row = await site.waitFor("(()=>{ const r=document.querySelector('#connectMenu [data-connector=\"webwallet\"]'); return r ? r.innerText.replace(/\\s+/g,' ') : false })()", 30000)
  check('the site\'s chooser lists the web wallet, ready', /Sequentia web wallet.*Ready/.test(row), row)
  const menu = await site.eval("document.querySelector('#connectMenu').innerText.replace(/\\s+/g,' ')")
  note('chooser: ' + menu)
  await shot(site, 'site-chooser')
  // Connect: declined first, then approved.
  await click(site, '#connectMenu [data-connector="webwallet"]')
  await dialog(wallet, 'connect', [/Connect SeqDEX\?/i, /\/dex\//], false)
  const warn = await site.waitFor("(()=>{ const w=document.querySelector('#connectWarning'); return w ? w.textContent : false })()", 30000)
  check('a declined connection: the site says so and holds no account', /rejected/.test(warn) && !(await site.eval("document.querySelector('#btnConnect').classList.contains('ok')")), warn)
  await click(site, '#btnConnect'); await sleep(800)
  await click(site, '#connectMenu [data-connector="webwallet"]')
  await dialog(wallet, 'connect', [/Connect SeqDEX\?/i], true)
  const conn = await site.waitFor("(()=>{ const b=document.querySelector('#btnConnect'); return b && b.classList.contains('ok') ? b.innerText : false })()", 60000)
  check('the site is connected to the web wallet', /Connected/.test(conn), conn.replace(/\s+/g, ' '))
  await sleep(3000)
  await click(site, '#side-sell'); await sleep(2000)
  const bal = await site.eval("document.querySelector('#fBal').innerText.replace(/\\s+/g,' ')")
  check('the site shows the wallet\'s balances, its leaves counted', /[1-9]/.test(bal), bal)
  await shot(site, 'site-connected')

  const [baseTk] = pair.split('-')
  let ticket = ''
  let st = ''
  if (ordersOnly) {
    await sleep(8000)
    check('Your orders, as the site reads them from the wallet', true, await ordersShown(site))
    await shot(site, 'site-orders')
  } else {
  if (!limitPrice) {
  // A market sale, declined in the wallet: nothing moves.
  let t0 = Date.now()
  await placeOrder(site, { type: 'market', side: 'sell', amount: sellAmount })
  await dialog(wallet, 'trade', [/Trade\?/i, /You pay/, new RegExp(sellAmount + ' ' + baseTk), /You get/, /Fees|No fees/, /Asked by/], false)
  st = await siteStatus(site)
  check('the declined trade: the site says the wallet refused it', /^err: .*rejected/.test(st), st)
  // The same sale, approved.
  t0 = Date.now()
  await placeOrder(site, { type: 'market', side: 'sell', amount: sellAmount })
  ticket = await dialog(wallet, 'trade', [/Trade\?/i, /You pay/, /You get/, /Asked by/], true)
  note('priced and shown in ' + secs(Date.now() - t0))
  st = await siteStatus(site)
  check('the approved trade: the site says it traded', /^ok: Traded with 1 order/.test(st), st)
  await shot(site, 'site-traded')
  await sleep(4000)
  check('the trade is under Your orders', true, await ordersShown(site))

  }
  // A limit sale far above the book: it rests.
  const ask = await site.eval("(()=>{ const t=(id)=>(document.getElementById(id)||{innerText:''}).innerText.replace(/\\s+/g,' '); return ('asks ' + t('asks')).slice(-200) + ' | bids ' + t('bids').slice(0,200) })()")
  note('book: ' + ask)
  const m = String(ticket).match(/You get[^\d]*([\d.,]+)/)
  const got = m ? Number(m[1].replace(/,/g, '')) : 1
  const price = limitPrice || String(Math.max(1, Math.round((got / Number(sellAmount)) * limitX)))
  await placeOrder(site, { type: 'limit', side: 'sell', amount: sellAmount, price })
  await dialog(wallet, 'place-order', [/Place an order\?/i, /You sell/, /Price/, /What is left can be taken back from/, /Asked by/], true)
  st = await siteStatus(site)
  check('the limit order: the site says it is on the book', /^ok: Your order is on the book/.test(st), st)
  await sleep(4000)
  const o = await ordersShown(site)
  check('the order is open under Your orders', o.open.length >= 1, o)
  await shot(site, 'site-order-placed')
  }

  if (followMin > 0) {
    const until = Date.now() + followMin * 60000
    let last = null
    while (Date.now() < until) {
      await sleep(30000)
      last = await ordersShown(site).catch(() => null)
      if (last && last.open.some((x) => /\b0%/.test(x))) break
    }
    check('the order rests on the book (listed)', !!(last && last.open.some((x) => /\b0%/.test(x))), last)
    await shot(site, 'site-order-resting')
  }
  const errs = [...wallet.errors, ...site.errors].filter((e) => !/favicon|ERR_/.test(e))
  check('no error in either page\'s console', !errs.length, errs.slice(0, 6))
  note('wallet console (site orders): ' + wallet.console.filter((l) => /site orders|user trade|order_/i.test(l)).slice(-12).join(' | '))
  // The pages' storage is written to disk before the browser stops.
  await site.stop(); await wallet.go('about:blank'); await sleep(3000); await wallet.stop()
  note(`done, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}
let walletPage = null
main().catch((e) => {
  note('FAIL ' + (e && e.stack || e))
  if (walletPage) note('wallet console: ' + walletPage.console.filter((l) => /site orders|order_|refused|error/i.test(l)).slice(-30).join(' | '))
  Promise.resolve(walletPage && walletPage.stop()).finally(() => process.exit(1))
})
