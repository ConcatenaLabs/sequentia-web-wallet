// The web wallet, for the reliability run's `mix` lane (tooling/reliability-drive.mjs): a page of
// the browser the lane opens, in default mode, every step as a person takes it. Each wallet kind
// (this, ambra-browser.mjs, ambra-mobile.mjs) answers the same calls:
//
//   open()                       the wallet shown, joined, its receive code on screen
//   code()                       a fresh receive code (New code), as the wallet shows it
//   invoice(btc)                 a BTC invoice for the amount: the receive code's `lightning=` part
//   figure(ticker)               the asset's figure in the balance, as a number
//   send(to, ticker, amount)     Send, its review, Send: -> { review, status, seconds } or { refused }
//   trade(pay, get, amount, ms)  Trade: -> { ticket, priceSeconds, states, received, final, seconds }
//   faucet(ticker)               the faucet's button: -> { said, seconds }
//   trades()                     every trade's state as its list shows it
import { pickExpr } from '../picker-drive.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CODE_RE = "/^(bitcoin:|[A-Za-z0-9-]+:[0-9a-f]{40,})/i"

export class WebWallet {
  constructor (browser, { name, base, phrase }) { Object.assign(this, { browser, name, base, phrase, kind: 'web' }) }

  async open () {
    const page = this.page = await this.browser.tab('about:blank')
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.SEQ_LEAVES_TICK_MS=8000;' })
    await page.go(this.base)
    const shown = await page.waitFor("(()=>{ const v=(id)=>{ const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none' }; return v('app') ? 'app' : (v('welcome') ? 'welcome' : false) })()", 300000)
    if (shown === 'welcome' && !this.phrase) {
      await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 300000)
      await this.click('#btnCreate')
      await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
      await this.click('#btnConfirm')
      await page.waitFor("!!localStorage.getItem('swk.sequentia.mnemonic')", 60000)
      this.phrase = await page.eval("localStorage.getItem('swk.sequentia.mnemonic')"); this.created = true
    } else if (shown === 'welcome') {
      await page.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(this.phrase)})`)
      await page.go('about:blank'); await sleep(1500); await page.go(this.base)
    }
    await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000)
    await page.eval("(()=>{ const u=document.querySelector('#modeUser'); if(u && !u.checked){ u.checked=true; u.dispatchEvent(new Event('change')) } return true })()").catch(() => {})
    await this.tab('receive')
    await page.waitFor(`(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && ${CODE_RE}.test(a.textContent) })()`, 600000)
    return this
  }

  click (sel) { return this.page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`) }
  tab (t) { return this.click(`#tabs button[data-tab="${t}"]`) }

  async code () {
    await this.tab('receive')
    const p = this.page
    await p.eval("(()=>{ const i=document.querySelector('#recvAmt'); if(i && i.value){ i.value=''; i.dispatchEvent(new Event('input')) } return true })()")
    const old = await p.eval("document.querySelector('#addr').textContent")
    await this.click('#btnNewAddr')
    return p.waitFor(`(()=>{ const t=document.querySelector('#addr').textContent; return ${CODE_RE}.test(t) && t!==${JSON.stringify(old)} && /sequentia=/i.test(t) ? t : false })()`, 300000)
  }

  async invoice (btc) {
    await this.tab('receive')
    const p = this.page
    await p.eval(`(()=>{ const s=document.querySelector('#recvAsset'); if(s && s.value!=='BTC' && [...s.options].some(o=>o.value==='BTC')){ s.value='BTC'; s.dispatchEvent(new Event('change')) }
      const i=document.querySelector('#recvAmt'); i.value=${JSON.stringify(String(btc))}; i.dispatchEvent(new Event('input')); return true })()`)
    const code = await p.waitFor("(()=>{ const t=document.querySelector('#addr').textContent; const m=t.match(/[?&]lightning=([^&]+)/i); return m ? decodeURIComponent(m[1]) : false })()", 120000)
    return code
  }

  // `quiet`: read from the balance as drawn, without opening its tab (for a watch beside a step).
  async figure (tk, { quiet = false } = {}) {
    if (!quiet) { await this.tab('balance'); await sleep(800) }
    const t = await this.page.eval(`(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(tk)}); return r ? (r.querySelector('.bt-t')?.innerText||'') : '' })()`)
    const m = String(t).replace(/,/g, '').match(/[0-9]+(\.[0-9]+)?/)
    return m ? Number(m[0]) : 0
  }

  async send (to, tk, amount) {
    const p = this.page
    await this.tab('send')
    await p.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(tk)})`, 180000)
    await p.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(to)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
      const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(tk)}); s.value=o.value; s.dispatchEvent(new Event('change'));
      r.querySelector('.ramt').value=${JSON.stringify(String(amount))}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
    await sleep(700)
    await p.eval(CLOSE_MODALS)
    await this.click('#btnReview')
    const review = await p.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
    const flat = review.replace(/\s+/g, ' ').trim()
    if (review.startsWith('ERR')) return { refused: flat.slice(4) }
    const t = Date.now()
    await pressPrimary(p)
    const status = await p.waitFor(LAST_STATUS, 1800000).catch(() => 'no answer in 30 min')
    const seconds = (Date.now() - t) / 1000
    await p.eval("(()=>{ const m=document.querySelector('.modal'); const c=m && [...m.querySelectorAll('button')].find(b=>/close|done|ok/i.test(b.textContent)); if(c) c.click(); else if(m) m.remove(); return true })()").catch(() => {})
    return { review: flat, status: status.replace(/\s+/g, ' ').trim(), seconds, clickedAt: t }
  }

  async trade (pay, get, amount, ms = 1200000) {
    const p = this.page
    await this.tab('swap')
    await p.waitFor("document.querySelector('#ucPay') && document.querySelector('#userComposer').offsetParent !== null", 120000)
    const pick = async (id, tk) => { if (!(await p.eval(pickExpr(id, tk)))) throw new Error('no ' + tk + ' in #' + id) }
    await pick('ucPay', pay); await sleep(500); await pick('ucGet', get)
    await p.eval(`(()=>{ const i=document.querySelector('#ucAmount'); i.value=${JSON.stringify(String(amount))}; i.dispatchEvent(new Event('input')); return true })()`)
    await p.eval(CLOSE_MODALS)
    return followTrade(p, () => this.click('#ucReview'), () => this.click('#ucConfirm'), ms)
  }

  async faucet (tk) {
    await this.tab('balance')
    const p = this.page
    await p.eval("(()=>{ const s=document.querySelector('#faucetStatus'); if(s) s.textContent=''; return true })()")
    const t = Date.now()
    await this.click(`#faucetBtns button[data-faucet="${tk === 'tSEQ' ? '' : tk}"]`)
    const said = await p.waitFor("(()=>{ const t=document.querySelector('#faucetStatus')?.textContent||''; return /^\s*Received|It arrives after|error|refused|could not|already/i.test(t) ? t : false })()", 900000).catch(() => 'no answer in 15 min')
    return { said: said.trim(), seconds: (Date.now() - t) / 1000 }
  }

  async trades () {
    await this.tab('swap'); await sleep(1500)
    return this.page.eval("[...document.querySelectorAll('#ucTrades .uc-trade')].map(r=>r.innerText.replace(/\\n+/g,' '))")
  }
}

// A modal left on screen by an earlier step (a trade's "Trade complete", a sent payment's) is
// closed with its own Done or Close, as a person closes it, before the next step opens one.
export const CLOSE_MODALS = "(()=>{ for (const m of [...document.querySelectorAll('.modal')]) { const c=[...m.querySelectorAll('button')].find(b=>/^(Done|Close|OK)$/i.test(b.textContent.trim())); if(c) c.click(); else m.remove() } return true })()"
// The review's Send, pressed once its button is ready: the modal can be drawn again as the review
// fills in, so a press on the first one may never reach the payment. Pressed again only while the
// newest modal shows no status and its button is still on. -> once the payment is under way.
export async function pressPrimary (p) {
  for (let i = 0; i < 60; i++) {
    const r = await p.eval(`(()=>{ const ms=[...document.querySelectorAll('.modal')]; const m=ms[ms.length-1]; if(!m) return 'gone'; const st=m.querySelector('.status'); if(st && st.textContent.trim()) return 'started'; const b=m.querySelector('button.primary'); if(!b) return 'wait'; if(b.disabled) return i ? 'started' : 'wait'; b.click(); return 'clicked' })()`)
    if (r === 'started' || r === 'gone') return r
    await sleep(r === 'clicked' ? 2000 : 500)
  }
  throw new Error('the review\'s Send never took the press')
}
const LAST_STATUS = "(()=>{ const ms=[...document.querySelectorAll('.modal')]; const st=ms.length ? ms[ms.length-1].querySelector('.status') : null; const t=st?st.textContent:''; return t && !/Sending|On its way|Paying/i.test(t) ? t : false })()"
export { LAST_STATUS }

// Review, the ticket, Trade, then the new row followed: to Received (the trade's end for its user:
// what it bought is theirs to use), Settled or Returned, for at most `ms`. Shared by the web wallet
// and Ambra browser, whose Trade tab is the web wallet's own composer.
export async function followTrade (p, review, confirm, ms) {
  const t0 = Date.now()
  await review()
  const tk = await p.waitFor("(()=>{ if(document.querySelector('#ucConfirm')) return document.querySelector('#ucTicket').innerText; const n=document.querySelector('#ucNote'); return n && n.classList.contains('err') && n.textContent ? 'ERR '+n.textContent : false })()", 300000).catch(() => 'ERR no ticket in 5 min')
  const ticket = tk.replace(/\s+/g, ' ').trim()
  const priceSeconds = (Date.now() - t0) / 1000
  if (tk.startsWith('ERR')) return { refused: ticket.slice(4), priceSeconds }
  const rows0 = await p.eval("document.querySelectorAll('#ucTrades .uc-trade').length")
  const tC = Date.now()
  await confirm()
  await p.waitFor(`document.querySelectorAll('#ucTrades .uc-trade').length > ${rows0}`, 300000).catch(() => null)
  let received = null; let final = null; const states = []
  while (Date.now() - tC < ms) {
    const st = await p.eval("(()=>{ const r=document.querySelector('#ucTrades .uc-trade'); return r ? r.querySelector('.uc-state').textContent : '' })()").catch(() => '')
    const s = st.replace(/ \(\d+ min\)$/, '')
    if (s && states[states.length - 1] !== s) states.push(s)
    if (received == null && /^(Received|Settled)/.test(st)) received = (Date.now() - tC) / 1000
    if (/Settled|Returned|Failed|failed/.test(st)) { final = st; break }
    if (received != null && (Date.now() - tC) / 1000 > received + 30) break
    await sleep(2000)
  }
  return { ticket, priceSeconds, states, received, final, seconds: (Date.now() - tC) / 1000, confirmedAt: tC }
}
