// Ambra mobile, for the reliability run's `mix` lane: the released APK on a device (the emulator),
// every step a tap on what the screen says (adb-ui.mjs), in user mode. The same calls as web.mjs,
// plus close() and reopen(): the app sent home and its process ended, as the system ends a phone's
// app in the background, then opened again from its icon.
//
// The receive code is read as a person moves it: Copy receive code, then pasted into Send's
// Recipient field, whose text the screen gives, and cleared again.
//
//   node tooling/wallets/ambra-mobile.mjs <call> [args…]   one call, its answer printed (for trying a step)
//   RB_DEBUG=1 prints each step of send and code, and any screen read over five seconds.
import * as u from './adb-ui.mjs'

// The app's id: the released app, or AMBRA_APP for a test build installed beside it under its own id.
const APP = process.env.AMBRA_APP || 'io.sequentia.ambra'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TABS = ['Balance', 'Send', 'Receive', 'Swap', 'History', 'More']
const D = process.env.RB_DEBUG ? (s) => console.error(new Date().toISOString(), s) : () => {}
const num = (s) => { const m = String(s).replace(/,/g, '').match(/[0-9]+(\.[0-9]+)?/); return m ? Number(m[0]) : 0 }

export class AmbraMobile {
  constructor ({ name } = {}) { Object.assign(this, { name: name || 'mobile', kind: 'mobile' }) }

  // The device's log of the app's own lines (Flutter's `I flutter`), timed, into `file`, until
  // stopLog(): what held a phone's operation up (adb as adb-ui.mjs finds it).
  async logTo (file) {
    const { spawn } = await import('node:child_process')
    const { openSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { homedir } = await import('node:os')
    this.logcat = spawn(process.env.ADB || join(homedir(), 'Android/Sdk/platform-tools/adb'), ['logcat', '-v', 'time', '-T', '1', 'flutter:I', '*:S'], { stdio: ['ignore', openSync(file, 'a'), 'ignore'] })
  }
  stopLog () { try { this.logcat && this.logcat.kill() } catch {} }

  async open () {
    await this.launch()
    // The app opens where it was left: a pushed screen (the faucet) is left with Back.
    const until = Date.now() + 180000
    while (Date.now() < until) {
      const ns = await u.screen()
      if (ns.some((n) => n.say === 'Balance' && n.clickable && n.y > 2100)) return this
      // A pushed screen (the faucet) or a sheet left open (a picker) is left with Back.
      if (ns.some((n) => (n.say === 'Back' || n.say === 'Scrim') && n.clickable)) await u.back()
      await sleep(1000)
    }
    throw new Error('Ambra mobile did not open: ' + u.textOf(await u.screen()).slice(0, 300))
  }
  async launch () {
    await u.shell(`monkey -p ${APP} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`)
    await sleep(2500)
  }
  // Closed as a person closes it: swiped away from the recent apps. Its task is gone; its process
  // is ended too when the system finds it idle (`am kill`), its scheduled background pass kept.
  async close () {
    await u.shell('input keyevent KEYCODE_HOME'); await sleep(1500)
    await u.shell('input keyevent KEYCODE_APP_SWITCH'); await sleep(2500)
    await u.shell('input swipe 540 1300 540 150 250'); await sleep(2000)
    const tasks = Number((await u.shell(`dumpsys activity recents | grep -c ${APP} || true`)).trim() || 0)
    await u.shell('input keyevent KEYCODE_HOME')
    await u.shell(`am kill ${APP}`); await sleep(1500)
    const pid = (await u.shell(`pidof ${APP} || true`)).trim()
    return { killed: tasks === 0, process: pid ? 'kept for its background pass' : 'ended' }
  }
  async reopen () { const t = Date.now(); await this.open(); return (Date.now() - t) / 1000 }

  // A bottom tab, from wherever the app is: a pushed screen (the faucet) is left with Back first.
  async tab (t) {
    for (let i = 0; i < 4; i++) {
      const ns = await u.screen()
      const n = ns.find((n) => n.say === t && n.clickable && n.y > 2100)
      if (n) { await u.tapNode(n); await sleep(1200); return }
      if (ns.some((n) => (n.say === 'Back' || n.say === 'Scrim') && n.clickable)) { await u.back(); await sleep(1000); continue }
      // Not in front (sent home by a step that failed): opened again from its icon.
      if (!/io\.sequentia\.ambra/.test(await u.shell('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" || true'))) { await this.launch(); await sleep(3000); continue }
      await u.shell('input keyevent 111'); await sleep(800)
    }
    throw new Error('no tab ' + t)
  }

  async code ({ fresh = true } = {}) {
    await this.tab('Receive'); D('on Receive')
    await u.waitFor('Copy receive code', 120000, { clickable: true })
    if (fresh) { await u.tap('New code'); await sleep(3000) }
    await u.waitFor('Copy receive code', 120000, { clickable: true })
    await u.tap('Copy receive code'); await sleep(800); await u.noSnack()
    return this.pasted()
  }

  // What the clipboard holds, read from Send's Recipient field once pasted there; the field is
  // left empty.
  async pasted () {
    await this.tab('Send'); D('on Send to paste')
    const field = await this.recipientField()
    await u.tapNode(field); await sleep(300)
    await u.clearField(field)
    await u.shell(`input swipe ${field.x} ${field.y} ${field.x} ${field.y} 900`); await sleep(1200)
    D('long-pressed'); await u.tap('Paste', 10000); await sleep(1200); D('pasted')
    const f2 = await this.recipientField()
    const text = f2.say
    await u.clearField(f2); await u.shell('input keyevent 111')
    return text
  }
  async recipientField () {
    const ns = await u.screen()
    const edits = ns.filter((n) => n.edit).sort((a, b) => a.y - b.y)
    if (!edits.length) throw new Error('no Recipient field: ' + u.textOf(ns).slice(0, 200))
    return edits[0]
  }

  // Receive's "Amount in BTC" field, under New code: the screen reads its node with bounds that
  // cover the buttons above it, so it is found by tapping below New code until a field has focus.
  async amountField () {
    const nc = await u.waitFor('New code', 120000, { clickable: true })
    for (let dy = 150; dy <= 390; dy += 60) {
      await u.tapAt(540, nc.y2 + dy - 60); await sleep(700)
      if ((await u.screen()).some((n) => n.edit && n.focused)) return true
    }
    return false
  }

  async invoice (btc) {
    await this.tab('Receive')
    await u.waitFor('Copy receive code', 120000, { clickable: true })
    if (!(await this.amountField())) throw new Error('no amount field on Receive')
    await u.clearField(); await u.type(String(btc)); await u.shell('input keyevent 111')
    // The code is made again with the amount and its invoice.
    let inv = null
    for (let i = 0; i < 8 && !inv; i++) {
      await sleep(3000)
      await this.tab('Receive')
      await u.tap('Copy receive code'); await sleep(800); await u.noSnack()
      const code = await this.pasted()
      const m = code.match(/[?&]lightning=([^&\s]+)/i)
      if (m) inv = decodeURIComponent(m[1])
    }
    // The field emptied again, so the next code carries no amount.
    await this.tab('Receive')
    if (await this.amountField()) { await u.clearField(); await u.shell('input keyevent 111') }
    if (!inv) throw new Error('no invoice in the receive code')
    return inv
  }

  async figure (tk) {
    await this.tab('Balance'); await sleep(800)
    const ns = await u.screen()
    for (const n of ns) {
      const parts = n.say.split('\n')
      for (let i = 0; i < parts.length; i++) if (parts[i] === tk && parts[i + 2] != null && /^[0-9,.]+$/.test(parts[i + 2].trim())) return num(parts[i + 2])
    }
    return 0
  }

  async pickAsset (tk) {
    const ns = await u.screen()
    const pk = ns.find((n) => n.clickable && /\nbalance /.test(n.say)) || ns.find((n) => n.clickable && /balance /.test(n.say))
    if (pk && pk.say.split('\n')[0].trim() === tk) return
    await u.tapNode(pk); await sleep(1200)
    const o = await u.scrollTo(new RegExp('^' + tk + '(\\n|$)'), 6)
    if (!o) throw new Error('no ' + tk + ' to send from')
    await u.tapNode(o); await sleep(1000)
  }

  async send (to, tk, amount) {
    await this.tab('Send')
    await u.waitFor('Review & send', 60000, { clickable: true })
    await this.pickAsset(tk); D('asset picked')
    const edits = (await u.screen()).filter((n) => n.edit).sort((a, b) => a.y - b.y)
    await u.clearField(edits[0]); await u.tapNode(edits[0]); await u.type(to); await sleep(500); D('recipient typed')
    const e2 = (await u.screen()).filter((n) => n.edit).sort((a, b) => a.y - b.y)
    await u.clearField(e2[1]); await u.tapNode(e2[1]); await u.type(String(amount)); await u.shell('input keyevent 111'); await sleep(800); D('amount typed')
    await u.tap('Review & send'); D('review pressed')
    // The review sheet, or a refusal under the form.
    const r = await u.waitAny([/^Send .*\?/, 'Cancel', /try again|can't|cannot|not enough|still arriving|Enter |isn't|is not|No wallet/i], 120000)
    D('review answered: ' + r.i + ' ' + r.node.say.slice(0, 60))
    const ns = await u.screen()
    const text = u.textOf(ns)
    const sendBtn = ns.find((n) => n.clickable && n.say === 'Send' && n.y < 2100)
    if (!sendBtn) return { refused: text.replace(/\n/g, ' ').replace(/Balance Send Receive Swap History More$/, '').slice(0, 400) }
    const review = ns.filter((n) => n.y < sendBtn.y + 200 && n.y > 300 && n.say && !n.edit).map((n) => n.say).join(' | ')
    const t = Date.now()
    D('send pressed at ' + sendBtn.y)
    await u.tapNode(sendBtn)
    let status = null
    while (Date.now() - t < 600000) {
      const s = await u.screen()
      const n = s.find((n) => /^(Sent |Not sent|Nothing was sent|This couldn't|Failed|Paid)/.test(n.say))
      if (n) { status = n.say; break }
      await sleep(500)
    }
    const seconds = (Date.now() - t) / 1000
    const close = (await u.screen()).find((n) => n.clickable && /^(Close|Done|OK)$/.test(n.say))
    if (close) await u.tapNode(close)
    return { review: review.replace(/\s+/g, ' '), status: (status || 'no answer in 10 min').replace(/\s+/g, ' '), seconds, clickedAt: t }
  }

  // Swap's two sides set to pay and get, through their pickers as a person sets them.
  async sides (pay, get) {
    await this.tab('Swap')
    await u.waitFor(/^You pay: /, 60000)
    const pickSide = async (label, tk) => {
      const n = await u.scrollTo(new RegExp('^' + label + ': '), 4)
      if (!n) throw new Error('no ' + label)
      if (n.say === `${label}: ${tk}`) return
      await u.tapNode(n); await sleep(1200)
      // The picker's sheet (over a scrim), its search field under its heading: the ticker typed,
      // then its row.
      await u.waitFor('Scrim', 10000).catch(() => null)
      await sleep(800)
      // The row as the sheet first lists it (what is held first), tapped where it is drawn;
      // the search field only for a row the half-open sheet does not show.
      const first = (await u.screen()).find((n) => n.clickable && !n.edit && n.say.split('\n')[0] === tk && n.y < 2100)
      if (first) {
        await u.tapNode(first); await sleep(1500)
      } else {
        const sh = await u.screen()
        const head = sh.find((n) => n.say === label && !n.clickable)
        const f = sh.filter((n) => n.edit && (!head || n.y > head.y)).sort((a, b) => a.y - b.y)[0]
        if (f) { await u.tapNode(f); await u.type(tk); await sleep(1500) }
      }
      // The list settles after the search (the same row in the same place twice), then its row is
      // tapped, again while the sheet stays open.
      let lastY = null
      for (let i = 0; i < 8; i++) {
        await sleep(800)
        const ns = await u.screen()
        if (!ns.some((n) => n.say === 'Scrim')) break
        const o = ns.find((n) => n.clickable && !n.edit && n.say.split('\n')[0] === tk)
        if (!o) { lastY = null; continue }
        // Seen in two reads running: the search has drawn it.
        if (lastY == null) { lastY = o.y; continue }
        await u.tapNode(o); await sleep(1500); lastY = null
      }
      // The sheet closed; the page may have scrolled the side out of view.
      if (!(await u.scrollTo(`${label}: ${tk}`, 4))) { const txt = u.textOf(await u.screen()).replace(/\n/g, ' | ').slice(0, 300); if (await u.find('Scrim')) await u.back(); throw new Error('no ' + tk + ' in ' + label + ' (screen: ' + txt + ')') }
    }
    // A side cannot take the asset the other side holds: when the pay asset is the one received
    // now, You receive is set first.
    const cur = await u.scrollTo(/^You receive: /, 4)
    if (cur && cur.say === `You receive: ${pay}`) {
      // The sides' own swap button, as a person turns a trade around.
      const sw = await u.scrollTo('Swap You pay and You receive', 3)
      if (sw) { await u.tapNode(sw); await sleep(1500) }
    }
    await pickSide('You pay', pay); await pickSide('You receive', get)
    await u.scrollTo(/^You receive: /, 4)
    if (!(await u.find(`You receive: ${get}`))) await pickSide('You receive', get)
    return true
  }

  async trade (pay, get, amount, ms = 1200000) {
    await this.sides(pay, get)
    const pf = await u.scrollTo(/^You pay: /, 3)
    const f = (await u.screen()).filter((n) => n.edit && Math.abs(n.y - pf.y) < 40)[0]
    await u.clearField(f); await u.tapAt(Math.max(f.x, 700), f.y); await u.type(String(amount)); await u.shell('input keyevent 111'); await sleep(1500)
    const before = new Set((await this.tradeRows()).map((r) => r.say))
    const rv = await u.scrollTo('Review', 4)
    if (!rv) throw new Error('no Review on Swap')
    const t0 = Date.now()
    await u.tapNode(rv)
    let ticket = null; let refused = null
    while (Date.now() - t0 < 300000) {
      await u.swipeUp(); await sleep(300)
      const ns = await u.screen()
      if (ns.some((n) => n.clickable && n.say === 'Trade')) { ticket = ns.filter((n) => /^(You pay|You receive|Fees|Price)\n/.test(n.say)).map((n) => n.say.replace(/\n/g, ' ')).join(' | '); break }
      const err = ns.find((n) => /Nothing has moved|try again|can't|cannot|Nobody|not enough|ready in|No offer|no price/i.test(n.say) && !n.clickable)
      if (err) { refused = err.say.replace(/\n/g, ' '); break }
      await sleep(1000)
    }
    const priceSeconds = (Date.now() - t0) / 1000
    if (!ticket) return { refused: refused || 'no ticket in 5 min', priceSeconds }
    const tC = Date.now()
    await u.tap('Trade', 10000)
    let received = null; let final = null; const states = []; let row = null
    while (Date.now() - tC < ms) {
      const rows = await this.tradeRows()
      if (!row) row = rows.find((r) => !before.has(r.say))?.say.split('\n')[0] || null
      const cur = row && rows.find((r) => r.say.split('\n')[0] === row)
      const st = cur ? cur.say.split('\n').slice(1).join(' ') : ''
      const s = st.replace(/ \(\d+ min\)$/, '')
      if (s && states[states.length - 1] !== s) states.push(s)
      if (received == null && /^(Received|Settled)/.test(st)) received = (Date.now() - tC) / 1000
      if (/Settled|Returned|Failed|failed/.test(st)) { final = st; break }
      if (received != null && (Date.now() - tC) / 1000 > received + 30) break
      await sleep(2500)
    }
    return { ticket, priceSeconds, states, received, final, seconds: (Date.now() - tC) / 1000, confirmedAt: tC, row }
  }
  // The Swap tab's trades, each "<paid> → <got>\n<state>".
  async tradeRows () {
    for (let i = 0; i < 3; i++) {
      const ns = await u.screen()
      const rows = ns.filter((n) => / → /.test(n.say.split('\n')[0]) && n.say.includes('\n'))
      if (rows.length || !ns.some((n) => n.say === 'Review')) return rows
      await u.swipeUp(); await sleep(500)
    }
    return []
  }

  async faucet (tk) {
    await this.tab('More')
    const n = await u.scrollTo(/^Get testnet coins/, 6, 'down') || await u.scrollTo(/^Get testnet coins/, 6)
    await u.tapNode(n); await sleep(1500)
    // The buttons come once the screen has read what the faucet paid this wallet.
    let ns = []; let b = null
    for (let i = 0; i < 10; i++) {
      ns = await u.screen()
      b = ns.find((n) => n.clickable && n.say === tk)
      if (b || ns.some((n) => n.say.split('\n').includes(tk + ' received'))) break
      await sleep(1000)
    }
    const old = new Set(ns.map((n) => n.say))
    if (!b && ns.some((n) => n.say.split('\n').includes(tk + ' received'))) { await u.back(); return { said: tk + ' received (the faucet paid this wallet before)', seconds: 0, claimed: true } }
    if (!b) return { said: (ns.find((n) => /received/.test(n.say) && n.say.includes(tk))?.say || 'no faucet button for ' + tk).replace(/\n/g, ' / '), seconds: 0 }
    const t = Date.now()
    await u.tapNode(b)
    let said = 'no answer in 15 min'
    while (Date.now() - t < 900000) {
      const s = await u.screen()
      const m = s.find((n) => /^(Received |Sent |The faucet |This wallet has already|The faucet could not|Could not)/.test(n.say) && !old.has(n.say))
      if (m) { said = m.say; break }
      await sleep(700)
    }
    const seconds = (Date.now() - t) / 1000
    await u.back(); await sleep(800)
    return { said: said.replace(/\n/g, ' '), seconds }
  }

  async trades () {
    await this.tab('Swap'); await sleep(1500)
    return (await this.tradeRows()).map((r) => r.say.replace(/\n/g, ' '))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [call, ...args] = process.argv.slice(2)
  const m = new AmbraMobile()
  m[call](...args).then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(0) }, (e) => { console.error(e.stack); process.exit(1) })
}
