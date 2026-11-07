// Ambra browser, for the reliability run's `mix` lane: the released extension unpacked and loaded in
// the lane's browser, its popup open as a tab, every step through the popup as a person takes it.
// The same calls as web.mjs. Its faucet requests leave from its service worker, which gets the
// faucet token as the web wallet's page does (cdp-page.mjs).
import { followTrade, CLOSE_MODALS, pressPrimary, LAST_STATUS } from './web.mjs'
import { pickExpr } from '../picker-drive.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PW = 'drive-password'

export class AmbraBrowser {
  constructor (browser, { name, phrase }) { Object.assign(this, { browser, name, phrase, kind: 'browser' }) }

  async open () {
    this.sw = await this.browser.target((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url))
    this.id = new URL(this.sw.url).host
    const p = this.page = await this.browser.tab(`chrome-extension://${this.id}/popup/popup.html`)
    // The tab is made before its document has loaded.
    await p.waitFor("document.readyState === 'complete' && !!document.body", 60000)
    await p.eval("document.body.style.width='380px'; true")
    const v = await p.waitFor("(()=>{ for (const id of ['vWelcome','vUnlock','vApp']) { const e=document.getElementById(id); if(e && !e.classList.contains('hide')) return id } return false })()", 120000)
    if (v === 'vWelcome') {
      if (this.phrase) {
        await p.waitFor("!!document.querySelector('#btnStartImport').onclick", 60000)
        await this.click('#btnStartImport')
        await this.set('importPhrase', this.phrase); await this.set('importPw', PW); await this.set('importPw2', PW)
        await this.click('#btnImportGo')
      } else {
        await p.waitFor("!!document.querySelector('#btnStartCreate').onclick", 60000)
        await this.click('#btnStartCreate')
        await p.waitFor("!!document.querySelector('#newPhrase').dataset.phrase")
        this.phrase = await p.eval("document.querySelector('#newPhrase').dataset.phrase")
        this.created = true
        await this.set('createPw', PW); await this.set('createPw2', PW)
        await this.click('#btnCreateGo')
      }
    } else if (v === 'vUnlock') {
      await this.set('unlockPw', PW); await this.click('#btnUnlock')
    }
    await p.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 180000)
    await this.tab('receive')
    await p.waitFor("/^bitcoin:.*sequentia=/i.test(document.querySelector('#recvDCode').innerText)", 600000)
    return this
  }

  // Every console line of the popup, the service worker and the offscreen document (where the
  // wallet's library and its upkeep run), timed, into `file`: what held an operation up.
  async logTo (file) {
    this.page.logTo(file, 'popup'); this.sw.logTo(file, 'sw')
    try { this.offscreen = (await this.browser.target((t) => t.url.startsWith(`chrome-extension://${this.id}/offscreen.html`), 30000)).logTo(file, 'offscreen') } catch {}
  }

  click (sel) { return this.page.eval(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`) }
  set (id, v) { return this.page.eval(`(()=>{ const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); return true })()`) }
  async tab (t) { await this.click(`[data-tab=${t}]`); await sleep(400) }

  async code () {
    await this.tab('receive')
    const p = this.page
    if (await p.eval("document.querySelector('#recvDAmt').value !== ''")) { await this.set('recvDAmt', ''); await sleep(1200) }
    const old = await p.eval("document.querySelector('#recvDCode').innerText")
    await this.click('#btnDNew')
    return p.waitFor(`(()=>{ const t=document.querySelector('#recvDCode').innerText.trim(); return /^bitcoin:.*sequentia=/i.test(t) && t!==${JSON.stringify(old)} ? t : false })()`, 300000)
  }

  async invoice (btc) {
    await this.tab('receive')
    await this.set('recvDAmt', String(btc))
    return this.page.waitFor("(()=>{ const t=document.querySelector('#recvDCode').innerText; const m=t.match(/[?&]lightning=([^&\\s]+)/i); return m ? decodeURIComponent(m[1]) : false })()", 120000)
  }

  async figure (tk, { quiet = false } = {}) {
    if (!quiet) { await this.tab('balance'); await sleep(800) }
    const t = await this.page.eval(`(()=>{ const r=[...document.querySelectorAll('#assetList .asset-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(tk)}); return r ? (r.querySelector('.fig')?.textContent||'') : '' })()`)
    const m = String(t).replace(/,/g, '').match(/[0-9]+(\.[0-9]+)?/)
    return m ? Number(m[0]) : 0
  }

  async send (to, tk, amount) {
    const p = this.page
    await this.tab('send')
    await p.waitFor(`[...document.querySelectorAll('#sendDAsset option')].some(o=>o.textContent.trim()===${JSON.stringify(tk)})`, 180000)
    await this.set('sendDTo', to)
    await p.eval(`(()=>{ const s=document.querySelector('#sendDAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(tk)}); s.value=o.value; s.dispatchEvent(new Event('change')); return true })()`)
    await this.set('sendDAmt', String(amount))
    await sleep(500)
    await p.eval(CLOSE_MODALS)
    await this.click('#btnDReview')
    const review = await p.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return m.innerText; const e=document.querySelector('#sendDErr').innerText; return /\\S/.test(e) ? 'ERR '+e : false })()", 120000)
    const flat = review.replace(/\s+/g, ' ').trim()
    if (review.startsWith('ERR')) return { refused: flat.slice(4) }
    const t = Date.now()
    await pressPrimary(p)
    const status = await p.waitFor(LAST_STATUS, 600000).catch(() => 'no answer in 10 min')
    const seconds = (Date.now() - t) / 1000
    await p.eval(CLOSE_MODALS).catch(() => {})
    return { review: flat, status: status.replace(/\s+/g, ' ').trim(), seconds, clickedAt: t }
  }

  async trade (pay, get, amount, ms = 1200000) {
    const p = this.page
    await this.tab('trade')
    await p.waitFor("!!document.querySelector('#ucPay')", 120000)
    const pick = async (id, tk) => {
      const sel = await p.eval(`document.querySelector('#${id}').tagName === 'SELECT'`)
      const ok = sel
        ? await p.eval(`(()=>{ const s=document.querySelector('#${id}'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(tk)}); if(!o) return false; s.value=o.value; s.dispatchEvent(new Event('change')); return true })()`)
        : await p.eval(pickExpr(id, tk))
      if (!ok) throw new Error('no ' + tk + ' in #' + id)
      await sleep(800)
    }
    await pick('ucPay', pay); await pick('ucGet', get)
    await this.set('ucAmount', String(amount))
    await p.eval(CLOSE_MODALS)
    return followTrade(p, () => this.click('#ucReview'), () => this.click('#ucConfirm'), ms)
  }

  async faucet (tk) {
    await this.tab('receive')
    const p = this.page
    await p.eval("document.querySelector('#faucetStatus').textContent=''; true")
    const t = Date.now()
    const btn = await p.eval(`(()=>{ const b=[...document.querySelectorAll('#faucetBtns [data-faucet]')].find(b=>b.dataset.faucet===${JSON.stringify(tk)} || b.textContent.trim().split(/\\s/)[0]===${JSON.stringify(tk)}); if(!b) return false; b.click(); return true })()`)
    if (!btn) return { said: 'no faucet button for ' + tk, seconds: 0 }
    // The line answers this request: a sentence naming another asset is an earlier request's late
    // word, not this one's answer.
    const said = await p.waitFor(`(()=>{ const t=document.querySelector('#faucetStatus').innerText; return /\\S/.test(t) && !/Requesting/i.test(t) && !(/^(Received|The faucet sent)/.test(t) && !t.includes(' ' + ${JSON.stringify(tk)})) ? t : false })()`, 900000).catch(() => 'no answer in 15 min')
    return { said: said.trim(), seconds: (Date.now() - t) / 1000 }
  }

  async trades () {
    await this.tab('trade'); await sleep(1500)
    return this.page.eval("[...document.querySelectorAll('#ucTrades .uc-trade')].map(r=>r.innerText.replace(/\\n+/g,' '))")
  }
}
