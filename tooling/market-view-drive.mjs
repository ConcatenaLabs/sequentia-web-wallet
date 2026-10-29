#!/usr/bin/env node
// Drives the Trade tab's market view (market-view.js) in headless Chromium, in default mode and
// then in developer mode, on a page this checkout serves (tooling/live-proxy.mjs) or the public one:
//
//   1. a new wallet; the Trade tab with the pair chosen (You pay, You get): the market shows its
//      pair, last price, chart, book and recent trades, and no word of USER_MODE_FORBIDDEN_WORDS;
//   2. with --await-new, it waits for a trade newer than the newest shown when it began (one made
//      meanwhile on any rail) to show at the top of the recent trades and in the last price, and
//      says how long after it began that was;
//   3. developer mode: the same pair loaded from "Browse markets"; each recent trade names its
//      rail, and the book's depth is shown by rail.
//
//   node tooling/market-view-drive.mjs <work-dir> --pay BTC --get <asset hex> [--await-new 300]
//     [--base http://127.0.0.1:8791/wallet/] [--phrase-file <file>]
//
// --phrase-file opens that wallet's phrase instead of a new wallet (in a profile of the drive's
// own), so You pay can be an asset it holds: how a trade another drive makes with that wallet is
// watched arriving in the market.
// Screenshots and the log go to <work-dir>/evidence. Needs a Chromium (CHROMIUM=…).
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const base = flag('--base', 'http://127.0.0.1:8791/wallet/')
const pay = flag('--pay', 'BTC'), get = flag('--get', null)
const awaitNew = Number(flag('--await-new', '0'))
const phraseFile = flag('--phrase-file', null)
const work = resolve(argv[0] || 'market-view-drive')
if (!get) { console.error('usage: market-view-drive.mjs <work-dir> --pay BTC --get <asset hex> [--await-new <seconds>]'); process.exit(2) }
const ev = join(work, 'evidence'); mkdirSync(ev, { recursive: true })
const note = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(join(ev, 'drive.log'), l + '\n') }
let failures = 0
const check = (what, ok, detail) => { note(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (page, sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
const pick = (page, sel, v) => page.eval(`(()=>{ const s=document.querySelector(${JSON.stringify(sel)}); if(!s) throw new Error('no ${sel}'); if(![...s.options].some(o=>o.value===${JSON.stringify(v)})) return [...s.options].map(o=>o.value); s.value=${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return true })()`)

const page = new Page(chromium(), { profile: join(work, 'profile') })
try {
  await page.open()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1500, deviceScaleFactor: 1, mobile: false })
  await page.go(base)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 300000)
  if (phraseFile) {
    const phrase = readFileSync(phraseFile, 'utf8').trim()
    await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)})`)
    await page.go('about:blank'); await sleep(1500)
    await page.go(base)
  } else {
    await click(page, '#btnCreate')
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await click(page, '#btnConfirm')
  }
  await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
  note('the wallet is open')
  // A wallet opened from its phrase holds its assets once it has joined and restored.
  if (phraseFile) {
    await click(page, '#tabs button[data-tab="receive"]')
    await page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') })()", 300000)
    note('it joined and restored')
  }

  // 1. default mode
  await click(page, '#tabs button[data-tab="swap"]')
  // What is held shows in You pay once the wallet has synced; the tab is drawn again until it does.
  await page.waitFor(`(()=>{ if([...document.querySelectorAll('#ucPay option')].some(o=>o.value===${JSON.stringify(pay)})) return true; if(!window._mvT || Date.now()-window._mvT>10000){ window._mvT=Date.now(); document.querySelector('#tabs button[data-tab="balance"]').click(); document.querySelector('#tabs button[data-tab="swap"]').click() } return false })()`, 300000)
  const p1 = await pick(page, '#ucPay', pay)
  check(`You pay ${pay}`, p1 === true, p1)
  await page.waitFor(`[...document.querySelectorAll('#ucGet option')].some(o=>o.value===${JSON.stringify(get)})`, 60000)
  check(`You get ${get.slice(0, 8)}`, (await pick(page, '#ucGet', get)) === true)
  const t0 = Date.now()
  await page.waitFor("document.querySelector('#ucMarket .mv')", 60000)
  const read = () => page.eval(`(()=>{ const m=document.querySelector('#ucMarket .mv'); if(!m) return null; const rows=[...m.querySelectorAll('.mv-trade')];
    return { pair: (m.querySelector('.mv-pair')||{}).textContent, last: (m.querySelector('#mvLast')||{}).textContent || null,
      change: (m.querySelector('#mvChange')||{}).textContent || null, note: (m.querySelector('#mvNote')||{}).textContent || null,
      chart: !!m.querySelector('.mv-chart canvas'), bid: (m.querySelector('#mvBid')||{}).textContent || null, ask: (m.querySelector('#mvAsk')||{}).textContent || null,
      trades: rows.length, newest: rows[0] ? { id: rows[0].dataset.id, text: rows[0].innerText.replace(/\\s+/g,' ') } : null,
      rails: rows.map(r=>r.dataset.rail||null).filter(Boolean), text: m.innerText } })()`)
  const m1 = await read()
  note('default mode market: ' + JSON.stringify({ ...m1, text: undefined }))
  check('the market names the pair', !!m1.pair, m1.pair)
  check('a chart, or says why not', m1.chart || !!m1.note, m1.note || 'chart')
  check('no word default mode never says', forbiddenIn(m1.text).length === 0, forbiddenIn(m1.text))
  check('no trade names its rail in default mode', m1.rails.length === 0)
  await page.screenshot(join(ev, 'default-mode-market.png'))

  // 2. a trade made meanwhile reaches the view
  if (awaitNew > 0) {
    const before = m1.newest && m1.newest.id
    note(`waiting up to ${awaitNew} s for a trade newer than ${before || 'none'}`)
    const tW = Date.now()
    let m2 = null
    while (Date.now() - tW < awaitNew * 1000) {
      m2 = await read()
      if (m2 && m2.newest && m2.newest.id !== before) break
      await sleep(1000)
    }
    const came = m2 && m2.newest && m2.newest.id !== before
    check('a new trade shows at the top of the recent trades', !!came, came ? `${m2.newest.text} (id ${m2.newest.id}), ${((Date.now() - tW) / 1000).toFixed(1)} s into the wait` : 'none came')
    if (came) {
      note('default mode market after it: ' + JSON.stringify({ ...m2, text: undefined }))
      await page.screenshot(join(ev, 'default-mode-market-new-trade.png'))
    }
  }

  // 3. developer mode
  await page.eval("(()=>{ const r=document.querySelector('#modeDeveloper'); r.checked=true; r.dispatchEvent(new Event('change')); return true })()")
  await sleep(1500)
  await click(page, '#tabs button[data-tab="swap"]')
  await page.waitFor("document.querySelector('#swMarketsBtn') && document.querySelector('#swMarketsBtn').offsetParent !== null", 60000)
  await click(page, '#swMarketsBtn')
  const row = await page.waitFor(`(()=>{ const r=[...document.querySelectorAll('.swmk-row')].find(x=>(x.dataset.base===${JSON.stringify(pay)}&&x.dataset.quote===${JSON.stringify(get)})||(x.dataset.base===${JSON.stringify(get)}&&x.dataset.quote===${JSON.stringify(pay)})); if(!r) return false; r.click(); return true })()`, 120000)
  check('developer mode: the pair loaded from Browse markets', !!row)
  await page.waitFor("document.querySelector('#swPairStats .mv')", 60000)
  await sleep(1500)
  const d = await page.eval(`(()=>{ const m=document.querySelector('#swPairStats .mv'); const rows=[...m.querySelectorAll('.mv-trade')];
    return { pair: m.querySelector('.mv-pair').textContent, last: (m.querySelector('#mvLast')||{}).textContent||null, trades: rows.length,
      rails: [...new Set(rows.map(r=>r.dataset.rail))], byRail: !![...m.querySelectorAll('.lbl')].find(l=>/Book by rail/.test(l.textContent)) } })()`)
  note('developer mode market: ' + JSON.stringify(d))
  // A trade recorded before trades carried their rail has none ("-").
  check('developer mode names the trades\' rails', d.trades === 0 || d.rails.some((r) => r && r.length), d.rails)
  await page.eval("document.querySelector('#swPairStats').scrollIntoView()")
  await page.screenshot(join(ev, 'developer-mode-market.png'))
  note(`${failures ? failures + ' check(s) failed' : 'every check passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
} catch (e) {
  note('FAIL ' + (e && e.message) + ' · console: ' + (page.console || []).slice(-6).join(' | '))
  failures++
  try { await page.screenshot(join(ev, 'failure.png')) } catch {}
} finally {
  try { await page.stop() } catch {}
}
process.exit(failures ? 1 : 0)
