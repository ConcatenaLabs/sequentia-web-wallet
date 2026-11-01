#!/usr/bin/env node
// What default mode shows of a vesting holding, on the public testnet (or any page with --base),
// read only: the wallet of the phrase in <work>/<name>.phrase opened in headless Chromium, its
// asset row's "<amount> <TICKER> vests on <date>" lines and the words default mode never says,
// then Send asked for <amount> of the asset to the wallet's own address, an amount that needs what
// has not vested: it must be refused with the sentence, nothing signed. After the date, the same
// wallet's figure holds the coins and the drive's `send` step spends them.
//
//   node tooling/vesting-live-check.mjs <work> <name> <TICKER> <assetHex> <amount> [--base URL]
//
// Profiles are kept under <work>/profiles/<name>, screenshots and the log under <work>/evidence;
// the phrase stays in its own file, mode 600, and is written nowhere else.
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { forbiddenIn } from '../user-trade.js'

const argv = process.argv.slice(2)
const bi = argv.indexOf('--base'); const base = bi >= 0 ? argv.splice(bi, 2)[1] : 'https://sequentiatestnet.com/wallet/'
const [workArg, name, TICKER, HEX, amount] = argv
const work = resolve(workArg); const ev = join(work, 'evidence'); mkdirSync(ev, { recursive: true })
const log = join(ev, 'drive.log')
const note = (s) => { const l = `[${new Date().toISOString()}] vesting ${name}: ${s}`; console.log(l); appendFileSync(log, l + '\n') }
let failures = 0
const check = (w, ok, d) => { note(`${ok ? 'ok  ' : 'FAIL'} ${w}${d !== undefined ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const phrase = readFileSync(join(work, name + '.phrase'), 'utf8').trim()
const page = new Page(chromium(), { profile: join(work, 'profiles', name) })
const click = (sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)

async function main () {
  await page.open()
  try {
    const me = (await page.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await page.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await page.send('Target.closeTarget', { targetId: t.targetId })
  } catch (e) { note('closing other tabs: ' + e.message) }
  await page.go(base)
  const shown = await page.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
  if (shown === 'welcome') {
    await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)})`)
    await page.go('about:blank'); await sleep(1500); await page.go(base)
  }
  await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
  await click('#tabs button[data-tab="balance"]')
  const rowExpr = `(()=>{ const r=[...document.querySelectorAll('#assetList .bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent===${JSON.stringify(TICKER)}); return r ? { total: (r.querySelector('.bt-t')||{}).innerText, vests: [...r.querySelectorAll('.bt-vests')].map(v=>v.textContent), arriving: [...r.querySelectorAll('.bt-arriving')].map(v=>v.textContent), text: r.innerText.replace(/\\s+/g,' ').trim() } : null })()`
  await page.waitFor(`(()=>{ const r=${rowExpr}; return r && r.vests.length > 0 })()`, 600000).catch(() => {})
  const row = await page.eval(rowExpr)
  check(`the ${TICKER} row shows what vests, with its date`, !!row && row.vests.length > 0 && /vests on \d{1,2} [A-Z][a-z]+ \d{4}$/.test(row.vests[0]), row)
  check('the row carries none of the words default mode never says', !!row && forbiddenIn(row.text).length === 0, row && forbiddenIn(row.text))
  await page.screenshot(join(ev, `${name}-vesting-row.png`)); note(`screenshot ${name}-vesting-row.png`)
  // Send what needs the vesting part, to the wallet's own address.
  await click('#tabs button[data-tab="receive"]'); await sleep(3000)
  const own = await page.eval("(()=>{ const t=(document.querySelector('#addr')||{}).textContent||''; const m=t.match(/tb1[02-9ac-hj-np-z]{20,}/); return m ? m[0] : '' })()")
  await click('#tabs button[data-tab="send"]'); await sleep(1500)
  await page.eval(`(()=>{ const r=document.querySelector('#recipients').children[0];
    const s=r.querySelector('.rasset'); s.value=${JSON.stringify(HEX)}; s.dispatchEvent(new Event('change'));
    const a=r.querySelector('.raddr'); a.value=${JSON.stringify(own)}; a.dispatchEvent(new Event('input'));
    const b=r.querySelector('.ramt'); b.value=${JSON.stringify(amount)}; b.dispatchEvent(new Event('input')); return true })()`)
  await click('#btnReview')
  await page.waitFor("document.querySelector('#sendErr').textContent.length > 0 || document.querySelector('.modal')", 60000).catch(() => {})
  const err = (await page.eval("document.querySelector('#sendErr').textContent")).trim()
  const modal = await page.eval("!!document.querySelector('.modal')")
  check(`Send of ${amount} ${TICKER} before the date is refused with the sentence, nothing signed`, /of this vests on \d{1,2} [A-Z][a-z]+ \d{4}, and can be used from then\. Nothing has moved\.$/.test(err) && !modal, err)
  await page.screenshot(join(ev, `${name}-send-refused.png`)); note(`screenshot ${name}-send-refused.png`)
}
main().then(async () => { await page.stop().catch(() => {}); note(`done, ${failures} failed`); process.exit(failures ? 1 : 0) },
  async (e) => { note('FAIL ' + (e && e.stack || e)); await page.stop().catch(() => {}); process.exit(1) })
