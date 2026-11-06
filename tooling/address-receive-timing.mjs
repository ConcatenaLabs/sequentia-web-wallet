// Where the minutes of a payment to an address go: default-mode payments from one wallet to
// another wallet's bare address on the live testnet, each followed from Send to the receiver's
// figure, step by step, in one headless Chromium (the web wallet's page and Ambra browser's popup
// as two tabs, as the reliability run's `mix` lane opens them).
//
//   node tooling/address-receive-timing.mjs <work-dir> <kind:name> <kind:name> --ext <unpacked
//     Ambra browser> [--phrases <dir>] [--asset OILX] [--amount 1] [--count 1] [--both]
//
// The first wallet pays the second (`--both`: then the second the first, in turn), `--count`
// times; `--burst k` makes each turn k payments to the same address, one right after another.
// Each turn is a line of <work-dir>/address-timing.jsonl with the seconds from the first click on
// Send to each step, as each is seen:
//   sent        each payer's "Sent …" line
//   chain       each transaction paying the address: in the explorer (mempool), in a block, and
//               its output spent again (board: the receiver taking it in)
//   arriving    the receiver's balance row naming something as arriving (developer mode's line)
//   levels      the second the receiver's figure first held 1, 2, … of the payments
//   dips        each reading after that below a level already held: the coin vanished
// and the receiver's (and payer's) own log lines about chain, boards and offboards. The watch goes
// on `--after` minutes (8) past the last level, to catch a dip while the coin is boarded.
// Nothing is retried; a step not seen in `--minutes` (60) is left out of the line.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Page, chromium } from './cdp-page.mjs'
import { WebWallet } from './wallets/web.mjs'
import { AmbraBrowser } from './wallets/ambra-browser.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const bool = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true }
const EXT = flag('--ext', null); const PHRASES = flag('--phrases', null)
const ASSET = flag('--asset', 'OILX'); const AMOUNT = flag('--amount', '1')
const ROUNDS = Number(flag('--count', '1')); const MINUTES = Number(flag('--minutes', '60'))
const BURST = Number(flag('--burst', '1')); const AFTER = Number(flag('--after', '8'))
const BASE = flag('--base', 'https://sequentiatestnet.com/wallet/')
const API = flag('--api', 'https://sequentiatestnet.com/api')
const BOTH = bool('--both')
// `--close-payer M`: the payer's page is closed once it says Sent, and opened again after M minutes
// (a web wallet payer only): what the receiver sees while the payer is away.
const CLOSE_PAYER = Number(flag('--close-payer', '0'))
// `--fund`: a wallet holding less than three payments of the asset asks the faucet for it first
// (its phrase is written to --phrases before that).
const FUND = bool('--fund')
const [workArg, specA, specB] = argv
if (!workArg || !specA || !specB) { console.error('usage: address-receive-timing.mjs <work-dir> <kind:name> <kind:name> [--ext dir]'); process.exit(2) }
const work = resolve(workArg); mkdirSync(work, { recursive: true })
const phrases = PHRASES ? resolve(PHRASES) : work
const out = join(work, 'address-timing.jsonl')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (s) => console.log(`[${new Date().toISOString()}] ${s}`)
const phraseOf = (name) => { const f = join(phrases, name + '.phrase'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : null }

// The lines worth keeping from a wallet's console: its chain, its boards, what arrives.
const WORTH = /board|on the chain|offboard|arriv|leafArrived|onchain|sync took|\[leaves\] (sync|balance)/i

async function json (url) { try { const r = await fetch(url); return r.ok ? await r.json() : null } catch { return null } }

const browser = new Page(chromium(), { profile: join(work, 'profile'), ext: EXT ? resolve(EXT) : undefined })
await browser.open()
writeFileSync(join(work, 'browser.pid'), String(browser.proc.pid))
const make = (spec) => {
  const [kind, name] = spec.split(':')
  if (kind === 'web') return new WebWallet(browser, { name, base: BASE, phrase: phraseOf(name) })
  if (kind === 'browser') return new AmbraBrowser(browser, { name, phrase: phraseOf(name) })
  throw new Error('no wallet kind ' + kind)
}
const A = make(specA); const B = make(specB)
try {
  for (const w of [A, B]) {
    await w.open()
    if (w.created && w.phrase) writeFileSync(join(phrases, w.name + '.phrase'), w.phrase + '\n', { mode: 0o600 })
    // Ambra browser's leaf wallet runs in its offscreen document: its console is read there.
    if (w.kind === 'browser') w.logPage = await browser.target((t) => /offscreen\.html/.test(t.url), 60000).catch(() => null)
    say(`${w.kind} ${w.name} open`)
    if (FUND && (await w.figure(ASSET)) < 3 * Number(AMOUNT)) {
      const f = await w.faucet(ASSET)
      say(`${w.name} faucet ${ASSET}: ${f.said} (${f.seconds} s)`)
      const t = Date.now()
      while (Date.now() - t < 900000 && (await w.figure(ASSET)) < 3 * Number(AMOUNT)) await sleep(10000)
      say(`${w.name} holds ${await w.figure(ASSET)} ${ASSET}`)
    }
  }
  const logOf = (w) => (w.logPage || w.page).console
  const arrivingLine = (w) => w.kind === 'web'
    ? `(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(ASSET)}); return r ? [...r.querySelectorAll('.bt-arriving,.bt-moving')].map(e=>e.textContent).join(' | ') : '' })()`
    : `(()=>{ const r=[...document.querySelectorAll('#assetList .asset-row')].find(r=>r.querySelector('.tk')?.textContent.trim()===${JSON.stringify(ASSET)}); return r ? (r.innerText.match(/[^\\n]*arriving[^\\n]*/i)||[''])[0] : '' })()`
  for (let i = 0; i < ROUNDS * (BOTH ? 2 : 1); i++) {
    const [from, to] = BOTH && i % 2 ? [B, A] : [A, B]
    const code = await to.code()
    const addr = decodeURIComponent(code.replace(/^bitcoin:/i, '').split('?')[0]).toLowerCase()
    const known = new Set(((await json(`${API}/address/${addr}/txs`)) || []).map((t) => t.txid))
    const before = await to.figure(ASSET)
    const log0 = logOf(to).length; const plog0 = logOf(from).length
    // `--burst k`: k payments one after another, each sent as soon as the one before says Sent.
    const sends = []
    for (let k = 0; k < BURST; k++) {
      say(`${from.name} pays ${AMOUNT} ${ASSET} to ${to.name}'s address (figure ${before}) ${k + 1}/${BURST}`)
      const s = await from.send(addr, ASSET, AMOUNT)
      sends.push(s)
      if (s.refused) { say('refused: ' + s.refused); break }
    }
    const paid = sends.filter((s) => !s.refused).length
    let closedAt = null; let reopened = null
    if (CLOSE_PAYER && paid && from.kind === 'web') { await from.page.go('about:blank'); closedAt = Date.now(); say(`${from.name}'s page closed`) }
    if (!paid) { appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), from: from.name, to: to.name, refused: sends[0].refused }) + '\n'); continue }
    const t0 = sends[0].clickedAt || Date.now()
    const at = () => Math.round((Date.now() - t0) / 100) / 10
    const steps = { sent: sends.map((s) => Math.round(((s.clickedAt || t0) - t0) / 100) / 10 + s.seconds) }
    const levels = []   // the second the figure first held 1, 2, … of the payments
    const dips = []     // a reading below a level already reached: [second, figure]
    const logs = []; const plogs = []; let seenLog = log0; let seenPlog = plog0
    const seen = new Set(); const chainTx = []
    let doneAt = null
    while (Date.now() - t0 < MINUTES * 60000 && (doneAt == null || Date.now() - doneAt < AFTER * 60000)) {
      // Every transaction paying the address since Send, and whether its output is spent again.
      const txs = await json(`${API}/address/${addr}/txs`)
      for (const tx of Array.isArray(txs) ? txs : []) {
        if (known.has(tx.txid)) continue
        const vout = (tx.vout || []).findIndex((o) => o.scriptpubkey_address === addr)
        if (vout < 0) continue
        let e = chainTx.find((x) => x.txid === tx.txid)
        if (!e) { e = { txid: tx.txid, mempool: at() }; chainTx.push(e) }
        if (tx.status && tx.status.confirmed && e.block == null) e.block = at()
        if (e.board == null) { const os = await json(`${API}/tx/${tx.txid}/outspend/${vout}`); if (os && os.spent) { e.board = at(); e.board_txid = os.txid } }
      }
      const line = await to.page.eval(arrivingLine(to)).catch(() => '')
      if (line && steps.arriving == null) { steps.arriving = at(); steps.arriving_said = line }
      const f = await to.figure(ASSET, { quiet: true }).catch(() => null)
      if (f != null) {
        const n = Math.floor((f - before) / Number(AMOUNT) + 0.1)
        while (levels.length < Math.min(n, paid)) levels.push(at())
        if (levels.length && f < before + levels.length * Number(AMOUNT) - 0.1 * Number(AMOUNT)) dips.push([at(), f])
        if (levels.length >= paid && doneAt == null) doneAt = Date.now()
      }
      if (closedAt && reopened == null && Date.now() - closedAt > CLOSE_PAYER * 60000) {
        reopened = at(); say(`${from.name}'s page opened again`)
        await from.page.go(BASE)
        await from.page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 300000).catch(() => {})
      }
      const c = logOf(to)
      for (; seenLog < c.length; seenLog++) if (WORTH.test(c[seenLog])) logs.push([at(), c[seenLog].slice(0, 300)])
      const pc = logOf(from)
      for (; seenPlog < pc.length; seenPlog++) if (/offboard|forfeit|sync|slow|^(error|warning):/i.test(pc[seenPlog])) plogs.push([at(), pc[seenPlog].slice(0, 200)])
      await sleep(5000)
    }
    steps.chain = chainTx; steps.levels = levels; steps.dips = dips
    if (closedAt) { steps.payer_closed = Math.round((closedAt - t0) / 100) / 10; steps.payer_reopened = reopened }
    const line = { at: new Date().toISOString(), from: `${from.kind}:${from.name}`, to: `${to.kind}:${to.name}`, asset: ASSET, amount: AMOUNT, burst: paid, addr,
      review: sends[0].review, status: sends.map((s) => s.status || s.refused), steps, before, logs, payer_logs: plogs }
    appendFileSync(out, JSON.stringify(line) + '\n')
    say(`${from.name} → ${to.name}: levels ${JSON.stringify(levels)} dips ${dips.length} chain ${JSON.stringify(chainTx.map((e) => [e.mempool, e.block, e.board]))}`)
  }
} finally {
  await browser.stop()
}
