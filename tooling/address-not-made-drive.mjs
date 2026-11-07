// What a default-mode wallet says of a payment to an address paid out of what it holds for instant
// payments, on the live testnet, as a person meets it:
//   1. a payment followed with the wallet open reads "Sending …" and then "Sent …", never "Sent"
//      before the leaf library has made it;
//   2. a payment asked right after it, while its change is still arriving, is refused as still
//      arriving, with when ("it can be sent within <N> minutes"), never as not enough;
//   3. a payment whose wallet is closed while it reads "Sending" is never made, and the wallet,
//      opened again, says so once on Balance ("Your payment of … was not made: nothing left your
//      wallet. Send it again.", OK), its History row reads "Not sent", the figure is whole, and
//      nothing reached the address.
//
//   node tooling/address-not-made-drive.mjs <work-dir> <payer kind:name> <receiver web:name>
//     [--ext <unpacked Ambra browser>] [--phrases <dir>] [--base <page url>] [--asset OILX]
//     [--amount 1] [--away 12] [--steps 1,2,3]
//
// The payer is `web` (this page, at --base) or `browser` (Ambra browser, --ext); the receiver is a
// web wallet, whose address is paid. "Closed" is the page left (web) or the whole browser ended
// (Ambra browser, whose leaf wallet goes on with its popup closed), and opened again after
// `--away` minutes. A payer holding less than three payments asks the faucet first. Each step is a
// line of <work-dir>/not-made.jsonl, with screenshots beside it.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { WebWallet, CLOSE_MODALS, pressPrimary } from './wallets/web.mjs'
import { AmbraBrowser } from './wallets/ambra-browser.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const EXT = flag('--ext', null); const PHRASES = flag('--phrases', null)
const BASE = flag('--base', 'https://sequentiatestnet.com/wallet/')
const API = flag('--api', 'https://sequentiatestnet.com/api')
const ASSET = flag('--asset', 'OILX'); const AMOUNT = flag('--amount', '1')
const AWAY = Number(flag('--away', '12'))
const STEPS = new Set(flag('--steps', '1,2,3').split(',').map(Number))
const [workArg, payerSpec, recvSpec] = argv
if (!workArg || !payerSpec || !recvSpec) { console.error('usage: address-not-made-drive.mjs <work-dir> <payer kind:name> <receiver web:name>'); process.exit(2) }
const work = resolve(workArg); mkdirSync(work, { recursive: true })
const phrases = PHRASES ? resolve(PHRASES) : work
const out = join(work, 'not-made.jsonl')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (s) => console.log(`[${new Date().toISOString()}] ${s}`)
const note = (o) => { appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); say(JSON.stringify(o)) }
const phraseOf = (name) => { const f = join(phrases, name + '.phrase'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : null }
const keep = (w) => { if (w.created && w.phrase) writeFileSync(join(phrases, w.name + '.phrase'), w.phrase + '\n', { mode: 0o600 }) }
async function json (url) { try { const r = await fetch(url); return r.ok ? await r.json() : null } catch { return null } }

const [pKind, pName] = payerSpec.split(':'); const [, rName] = recvSpec.split(':')
const recvBrowser = new Page(chromium(), { profile: join(work, 'profile-' + rName) })
await recvBrowser.open()
writeFileSync(join(work, 'browser-' + rName + '.pid'), String(recvBrowser.proc.pid))
let payBrowser = null
const openPayerBrowser = async () => {
  payBrowser = new Page(chromium(), { profile: join(work, 'profile-' + pName), ext: pKind === 'browser' ? resolve(EXT) : undefined })
  await payBrowser.open()
  writeFileSync(join(work, 'browser-' + pName + '.pid'), String(payBrowser.proc.pid))
  return payBrowser
}
const makePayer = () => (pKind === 'web' ? new WebWallet(payBrowser, { name: pName, base: BASE, phrase: phraseOf(pName) }) : new AmbraBrowser(payBrowser, { name: pName, phrase: phraseOf(pName) }))

// The newest modal's text and status, and the send form's refusal.
const MODAL = "(()=>{ const ms=[...document.querySelectorAll('.modal')]; const m=ms[ms.length-1]; if(!m) return null; const st=m.querySelector('.status'); return { text: m.innerText.replace(/\\s+/g,' ').trim(), status: st ? st.textContent.trim() : '' } })()"
async function review (w, to) {
  const p = w.page
  if (w.kind === 'web') {
    await w.tab('send')
    await p.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ASSET)})`, 180000)
    await p.eval(CLOSE_MODALS)
    await p.eval(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(to)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
      const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(ASSET)}); s.value=o.value; s.dispatchEvent(new Event('change'));
      r.querySelector('.ramt').value=${JSON.stringify(String(AMOUNT))}; r.querySelector('.ramt').dispatchEvent(new Event('input')); document.getElementById('sendErr').textContent=''; return true })()`)
    await sleep(700)
    await w.click('#btnReview')
    const r = await p.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return 'M '+m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
    return r.startsWith('ERR') ? { refused: r.slice(4).trim() } : { review: r.slice(2).replace(/\s+/g, ' ').trim() }
  }
  await w.tab('send')
  await p.eval(CLOSE_MODALS)
  await w.set('sendDTo', to); await w.set('sendDAmt', String(AMOUNT))
  await p.eval(`(()=>{ const s=document.getElementById('sendDAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(ASSET)}); if(o){ s.value=o.value; s.dispatchEvent(new Event('change')) } document.getElementById('sendDErr').textContent=''; return !!o })()`)
  await w.click('#btnDReview')
  const r = await p.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m) return 'M '+m.innerText; const e=document.getElementById('sendDErr'); return e && e.classList.contains('err') && e.textContent ? 'ERR '+e.textContent : false })()", 300000)
  return r.startsWith('ERR') ? { refused: r.slice(4).trim() } : { review: r.slice(2).replace(/\s+/g, ' ').trim() }
}
const statusNow = (w) => w.page.eval(MODAL).then((m) => (m ? m.status : '')).catch(() => '')

let payer; let receiver
try {
  receiver = await new WebWallet(recvBrowser, { name: rName, base: BASE, phrase: phraseOf(rName) }).open(); keep(receiver)
  await openPayerBrowser(); payer = await makePayer().open(); keep(payer)
  say(`payer ${payer.kind}:${payer.name}, receiver web:${receiver.name} open`)
  if ((await payer.figure(ASSET)) < 3 * Number(AMOUNT)) {
    const f = await payer.faucet(ASSET); say(`faucet: ${f.said}`)
    const t = Date.now(); while (Date.now() - t < 900000 && (await payer.figure(ASSET)) < 3 * Number(AMOUNT)) await sleep(10000)
  }
  const code = await receiver.code()
  const addr = decodeURIComponent(code.replace(/^bitcoin:/i, '').split('?')[0]).toLowerCase()
  const paidAt = async () => (((await json(`${API}/address/${addr}/txs`)) || []).length)
  note({ step: 0, payer: payer.name, receiver: receiver.name, address: addr, figure: await payer.figure(ASSET), txs: await paidAt() })

  if (STEPS.has(1)) {
    // 1: followed with the wallet open.
    const r = await review(payer, addr)
    if (r.refused) note({ step: 1, refused: r.refused })
    else {
      const t0 = Date.now(); await pressPrimary(payer.page)
      const seen = []; let last = ''
      while (Date.now() - t0 < 900000) {
        const s = await statusNow(payer)
        if (s && s !== last) { last = s; seen.push({ s, at: (Date.now() - t0) / 1000 }); if (/^Sending \d/.test(s)) await payer.page.screenshot(join(work, `1-${payer.name}-sending.png`)) }
        if (/^Sent |not made|did not arrive|went wrong|Failed/i.test(s)) break
        await sleep(1000)
      }
      await payer.page.screenshot(join(work, `1-${payer.name}-sent.png`))
      note({ step: 1, review: r.review, statuses: seen })
      await payer.page.eval(CLOSE_MODALS)
    }
  }

  if (STEPS.has(3)) {
    // 3 (with 2 inside it): a payment, the wallet closed while it reads "Sending".
    const before = await payer.figure(ASSET); const txs = await paidAt()
    let r = await review(payer, addr)
    for (let i = 0; r.refused && i < 20; i++) { say('waiting to pay: ' + r.refused); await sleep(30000); r = await review(payer, addr) }
    if (r.refused) throw new Error('step 3 refused: ' + r.refused)
    const t0 = Date.now(); await pressPrimary(payer.page)
    const sending = await payer.page.waitFor(`(${MODAL}||{}).status && /^Sending \\d|^Sent|went wrong/.test((${MODAL}).status) ? (${MODAL}).status : false`, 120000)
    note({ step: 3, review: r.review, said: sending, at: (Date.now() - t0) / 1000 })
    if (STEPS.has(2)) {
      // 2: the next payment while that one's change is arriving.
      await payer.page.eval(CLOSE_MODALS)
      const r2 = await review(payer, addr)
      await payer.page.screenshot(join(work, `2-${payer.name}-arriving.png`))
      note({ step: 2, at: (Date.now() - t0) / 1000, ...r2 })
      await payer.page.eval(CLOSE_MODALS)
    }
    if (payer.kind === 'web') await payer.page.go('about:blank'); else await payBrowser.stop()
    note({ step: 3, closed: (Date.now() - t0) / 1000 })
    await sleep(AWAY * 60000)
    note({ step: 3, address_txs_before: txs, address_txs_now: await paidAt() })
    if (payer.kind === 'web') { await payer.page.go(BASE); payer = await makePayer().open() } else { await openPayerBrowser(); payer = await makePayer().open() }
    await payer.tab('balance')
    const card = await payer.page.waitFor("(()=>{ const c=document.getElementById('newsCard'); return c && !c.classList.contains('hide') && c.innerText.trim() ? c.innerText.replace(/\\s+/g,' ').trim() : false })()", 900000).catch((e) => 'NO CARD: ' + e.message)
    await payer.page.screenshot(join(work, `3-${payer.name}-balance-card.png`))
    const after = await payer.figure(ASSET, { quiet: true })
    let row = null
    if (payer.kind === 'web') {
      await payer.tab('history'); await sleep(2500)
      row = await payer.page.eval("(()=>{ const r=[...document.querySelectorAll('.item.instant')].find(i=>/Not sent|Did not arrive/.test(i.innerText)); return r ? r.innerText.replace(/\\s+/g,' ').trim() : null })()")
      await payer.page.screenshot(join(work, `3-${payer.name}-history.png`))
      await payer.tab('balance'); await sleep(800)
    }
    note({ step: 3, card, history_row: row, figure_before: before, figure_after: after, address_txs_now: await paidAt() })
    // OK: said once.
    await payer.page.eval("(()=>{ const b=document.querySelector('#newsCard button'); if(b) b.click(); return !!b })()")
    await sleep(3000)
    const gone = await payer.page.eval("document.getElementById('newsCard').classList.contains('hide')")
    note({ step: 3, ok_pressed_card_gone: gone })
  }
} catch (e) {
  note({ error: String(e && e.stack || e) })
  process.exitCode = 1
} finally {
  await recvBrowser.stop().catch(() => {}); if (payBrowser) await payBrowser.stop().catch(() => {})
}
