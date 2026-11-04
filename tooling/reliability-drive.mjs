// The user-mode reliability run: default-mode operations on the live testnet, one after another,
// each followed to its end and timed against what the wallet tells its user, in headless Chromium
// on the public page (or the page tooling/live-proxy.mjs serves).
//
//   node tooling/reliability-drive.mjs <work-dir> <lane> <A> <B> [--ops 250] [--base <url>]
//     [--asset USDX] [--pay 2] [--get GOLD] [--trade 2]
//
//   lane `pay`    A pays B, then B pays A back, in --asset: each payment is two operations, the
//                 payer's (Send, its review and "Sent") and the receiver's (the balance showing
//                 it). The review says when it arrives ("in seconds", "in a few minutes"): seconds
//                 are held to 60 s from the click to the receiver's figure, minutes to 10 min.
//   lane `trade`  A trades --trade of --asset for --get in the Trade tab, then sells what it got
//                 back: each trade one operation, from Trade to Received, Settled or Returned. A
//                 trade states no time; after 10 minutes it tells its user that settling "is
//                 taking longer than usual", so 10 min is its bound (B is not used: give "-").
//                 The lane moves on a minute after Received; the drive's `trades` step then
//                 follows every trade of the wallet to Settled or Returned.
//
// Each operation is a line of <work-dir>/reliability-<lane>.jsonl: what was asked, what the wallet
// said at each step, the outcome (settled, returned, refused, failed), the seconds it took and the
// bound it is held to. A refusal before anything moved (the review or Send saying why) is a clean
// return. Nothing is retried: a failed operation is recorded and the run goes on. The wallets are
// the drive's (default-mode-live-drive.mjs `new`), their profiles under <work-dir>/profiles.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { pickExpr } from './picker-drive.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const base = flag('--base', 'https://sequentiatestnet.com/wallet/')
const OPS = Number(flag('--ops', '250'))
const ASSET = flag('--asset', 'USDX'); const PAY = flag('--pay', '2')
const GET = flag('--get', 'GOLD'); const TRADE = flag('--trade', '2')
const [workArg, lane, A, B] = argv
if (!workArg || !lane || !A) { console.error('usage: reliability-drive.mjs <work-dir> <pay|trade> <A> <B|->'); process.exit(2) }
const work = resolve(workArg)
mkdirSync(join(work, 'evidence'), { recursive: true })
const out = join(work, `reliability-${lane}.jsonl`)
const say = (s) => console.log(`[${new Date().toISOString()}] ${lane}: ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = (o) => { appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), lane, ...o }) + '\n'); say(`#${o.n} ${o.op} ${o.outcome} ${o.seconds}s${o.within === false ? ' OVER ' + o.bound + 's' : ''} ${o.said || ''}`.slice(0, 300)) }

async function open (who) {
  const page = new Page(chromium(), { profile: join(work, 'profiles', who) })
  await page.open()
  try {
    const me = (await page.send('Target.getTargetInfo')).targetInfo.targetId
    for (const t of (await page.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.targetId !== me) await page.send('Target.closeTarget', { targetId: t.targetId })
  } catch {}
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.SEQ_LEAVES_TICK_MS=8000;' })
  await page.go(base)
  const phrase = existsSync(join(work, who + '.phrase')) ? readFileSync(join(work, who + '.phrase'), 'utf8').trim() : null
  const shown = await page.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
  if (shown === 'welcome') {
    if (!phrase) throw new Error(who + ' has no wallet and no phrase')
    await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)})`)
    await page.go('about:blank'); await sleep(1500); await page.go(base)
  }
  await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
  await tab(page, 'receive')
  await page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') })()", 300000)
  return page
}
const click = (page, sel) => page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
const tab = (page, t) => click(page, `#tabs button[data-tab="${t}"]`)
// The asset's figure in the balance, as a number (its text without separators).
const figure = async (page, tk) => {
  const t = await page.eval(`(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(tk)}); return r ? (r.querySelector('.bt-t')?.innerText||'') : '' })()`)
  const m = String(t).replace(/,/g, '').match(/[0-9]+(\.[0-9]+)?/)
  return m ? Number(m[0]) : 0
}

async function pay (n, from, to, fromName, toName) {
  const t0 = Date.now()
  await tab(to, 'receive')
  const old = await to.eval("document.querySelector('#addr').textContent")
  await click(to, '#btnNewAddr')
  const code = await to.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return /^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i.test(t) && t!==${JSON.stringify(old)} ? t : false })()`, 300000)
  await tab(to, 'balance'); await sleep(1500)
  const before = await figure(to, ASSET)
  await tab(from, 'send')
  await from.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ASSET)})`, 180000)
  await from.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(code)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
    const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ASSET)}); s.value=o.value; s.dispatchEvent(new Event('change'));
    r.querySelector('.ramt').value=${JSON.stringify(PAY)}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
  await click(from, '#btnReview')
  const review = await from.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
  const flat = review.replace(/\s+/g, ' ').trim()
  if (review.startsWith('ERR')) {
    record({ n, op: 'payment', from: fromName, to: toName, outcome: 'refused', said: flat, seconds: (Date.now() - t0) / 1000 })
    return
  }
  const bound = /in seconds/i.test(review) ? 60 : /few minutes/i.test(review) ? 600 : null
  const tClick = Date.now()
  await from.eval("document.querySelector('.modal button.primary').click()")
  const status = await from.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending/.test(t) ? t : false })()", 1800000).catch(() => 'no answer in 30 min')
  const sentS = (Date.now() - tClick) / 1000
  await from.eval("(()=>{ const m=document.querySelector('.modal'); const c=m && [...m.querySelectorAll('button')].find(b=>/close|done|ok/i.test(b.textContent)); if(c) c.click(); else if(m) m.remove(); return true })()").catch(() => {})
  if (!/^Sent/.test(status)) {
    record({ n, op: 'payment', from: fromName, to: toName, outcome: /try again|nothing|not sent|can.t/i.test(status) ? 'refused' : 'failed', said: flat + ' → ' + status, seconds: sentS, bound })
    return
  }
  record({ n, op: 'payment', from: fromName, to: toName, outcome: 'settled', said: flat + ' → ' + status, seconds: sentS, bound, within: bound ? sentS <= bound : null })
  // The receiver's figure, up to an hour.
  let seen = null
  const until = Date.now() + 3600000
  while (Date.now() < until) {
    const now = await figure(to, ASSET)
    if (now >= before + Number(PAY) - 1e-6) { seen = now; break }
    await sleep(2000)
  }
  const recvS = (Date.now() - tClick) / 1000
  record({ n: n + 1, op: 'receive', from: fromName, to: toName, outcome: seen != null ? 'settled' : 'failed', said: seen != null ? `${toName} shows ${seen} ${ASSET} (was ${before})` : `${toName} never showed it in an hour (was ${before})`, seconds: recvS, bound, within: seen != null && bound ? recvS <= bound : (seen != null ? null : false) })
}

async function trade (n, page, pay, get, amount) {
  await tab(page, 'swap')
  await page.waitFor("document.querySelector('#ucPay') && document.querySelector('#userComposer').offsetParent !== null", 120000)
  const pick = async (id, tk) => { if (!(await page.eval(pickExpr(id, tk)))) throw new Error('no ' + tk + ' in #' + id) }
  await pick('ucPay', pay); await sleep(500); await pick('ucGet', get)
  await page.eval(`(()=>{ const i=document.querySelector('#ucAmount'); i.value=${JSON.stringify(amount)}; i.dispatchEvent(new Event('input')); return true })()`)
  const t0 = Date.now()
  await click(page, '#ucReview')
  const tk = await page.waitFor("(()=>{ if(document.querySelector('#ucConfirm')) return document.querySelector('#ucTicket').innerText; const n=document.querySelector('#ucNote'); return n && n.classList.contains('err') && n.textContent ? 'ERR '+n.textContent : false })()", 300000).catch(() => 'ERR no ticket in 5 min')
  const ticket = tk.replace(/\s+/g, ' ').trim()
  const priceS = (Date.now() - t0) / 1000
  if (tk.startsWith('ERR')) { record({ n, op: 'trade', pair: `${pay}→${get}`, amount, outcome: 'refused', said: ticket, seconds: priceS, price_seconds: priceS }); return null }
  const rows0 = await page.eval("document.querySelectorAll('#ucTrades .uc-trade').length")
  const tC = Date.now()
  await click(page, '#ucConfirm')
  await page.waitFor(`document.querySelectorAll('#ucTrades .uc-trade').length > ${rows0}`, 300000).catch(() => null)
  let first = null; let got = null; let fin = null; const states = []
  const until = Date.now() + 3600000
  while (Date.now() < until) {
    const st = await page.eval("(()=>{ const r=document.querySelector('#ucTrades .uc-trade'); return r ? r.querySelector('.uc-state').textContent : '' })()").catch(() => '')
    if (st && states[states.length - 1] !== st) states.push(st)
    if (!first && st) first = (Date.now() - tC) / 1000
    if (!got && /^(Received|Settled)/.test(st)) got = (Date.now() - tC) / 1000
    if (/Settled|Returned/.test(st)) { fin = st; break }
    // Received is the trade's end for its user (what it bought is theirs to use); its settling
    // with the network goes on, and the run's last step (the drive's `trades`) follows every
    // trade to Settled or Returned.
    if (got != null && (Date.now() - tC) / 1000 > got + 60) break
    await sleep(2000)
  }
  const total = (Date.now() - tC) / 1000
  const outcome = fin === 'Settled' ? 'settled' : fin && /Returned/.test(fin) ? 'returned' : got ? 'received' : 'failed'
  const usable = got != null ? got : (outcome === 'returned' ? total : null)
  record({ n, op: 'trade', pair: `${pay}→${get}`, amount, outcome, said: ticket.slice(0, 300), states: states.map((s) => s.replace(/ \(\d+ min\)$/, '')).filter((s, i, a) => a.indexOf(s) === i),
    price_seconds: priceS, received_seconds: got, seconds: usable ?? total, settled_seconds: fin === 'Settled' ? total : null, bound: 600, within: usable != null ? usable <= 600 : false })
  return outcome
}

async function main () {
  let n = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).length : 0
  say(`starting at operation ${n + 1} of ${OPS}`)
  if (lane === 'pay') {
    const a = await open(A); const b = await open(B)
    while (n < OPS) {
      try { await pay(n + 1, a, b, A, B) } catch (e) { record({ n: n + 1, op: 'payment', from: A, to: B, outcome: 'failed', said: 'drive: ' + e.message.slice(0, 300), seconds: 0 }) }
      n = readFileSync(out, 'utf8').trim().split('\n').length
      if (n >= OPS) break
      try { await pay(n + 1, b, a, B, A) } catch (e) { record({ n: n + 1, op: 'payment', from: B, to: A, outcome: 'failed', said: 'drive: ' + e.message.slice(0, 300), seconds: 0 }) }
      n = readFileSync(out, 'utf8').trim().split('\n').length
    }
    await a.stop(); await b.stop()
  } else if (lane === 'trade') {
    const a = await open(A)
    let back = null
    while (n < OPS) {
      try {
        if (!back) { await trade(n + 1, a, ASSET, GET, TRADE); back = true } else {
          // Sell back a part of what was bought: the figure of GET shown, a tenth of it at most.
          await tab(a, 'balance'); await sleep(1500)
          const held = await figure(a, GET)
          const amt = held > 0 ? String(Number((held / 10).toPrecision(2))) : '0'
          if (Number(amt) > 0) await trade(n + 1, a, GET, ASSET, amt); else record({ n: n + 1, op: 'trade', pair: `${GET}→${ASSET}`, outcome: 'refused', said: `no ${GET} shown to sell`, seconds: 0 })
          back = null
        }
      } catch (e) { record({ n: n + 1, op: 'trade', outcome: 'failed', said: 'drive: ' + e.message.slice(0, 300), seconds: 0 }); back = null }
      n = readFileSync(out, 'utf8').trim().split('\n').length
    }
    await a.stop()
  } else throw new Error('no lane ' + lane)
}

main().then(() => process.exit(0), (e) => { say('FAIL ' + (e && e.stack || e)); process.exit(1) })
