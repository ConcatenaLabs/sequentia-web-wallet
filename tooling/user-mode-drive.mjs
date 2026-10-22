#!/usr/bin/env node
// Drives the Trade tab in user mode (user-composer.js) end to end in headless Chromium, against
// a local regtest operator, SeqDEX's relay, a live leaf maker and a transparent covenant order:
//
//   1. user mode shows the user composer and nothing of developer mode's; both pickers list BTC
//      first; no word of USER_MODE_FORBIDDEN_WORDS shows anywhere on the tab;
//   2. a trade settled in the tree: the maker's quote is the best, so the trade is an in-tree
//      swap; the ticket shows what you pay, what you get and the fees; "Sent", then "Settled";
//   3. a take of an on-chain covenant order: the maker stops, so the order is the best; the same
//      three lines, "Sent", "Settled", and the order rests again on the chain with less;
//   4. a pair with no one-step liquidity is not offered, in plain words;
//   5. developer mode is as before: the composer with every rail, the Leaf choice, no user
//      composer.
//
// Each step is a DOM assertion and a screenshot; every effect is checked at the library, the
// relay or the node.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd \
//     node tooling/user-mode-drive.mjs <evidence-dir> [--pairs user-mode/pairs.json]
//
// --pairs names the admitted pairs (the drill's list for this chain). Without it the drive admits
// its own two pairs and says so. Needs pkg/ (the lwk_wasm build) and a Chromium (CHROMIUM=…).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { startEsploraShim } from './esplora-shim.mjs'
import { harness, startRelay, placeOrder, startMaker, makerReady, freePort, sleep, lwkFrom } from './user-mode-stack.mjs'
import { USER_MODE_FORBIDDEN_WORDS, forbiddenIn } from '../user-trade.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const SEQOBD = process.env.SEQOBD
const out = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(tmpdir(), 'user-mode-drive-evidence'))
const pairsArg = (() => { const i = process.argv.indexOf('--pairs'); return i > 0 ? process.argv[i + 1] : null })()
if (!SEQOBD) { console.error('SEQOBD must name the relay binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const T0 = Date.now(); const note = (s) => { s = ((Date.now() - T0) / 1000).toFixed(0).padStart(5) + 's ' + s; console.log(s); appendFileSync(log, s + '\n') }

let failures = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}
async function until (what, f, ms = 180000, every = 1000) {
  const end = Date.now() + ms
  for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(every) }
}

const H = harness(control)
const children = []
const pages = []
let step = 0

function wallet (name) {
  const page = new Page()
  pages.push(page)
  const w = {
    name, page,
    eval: (js) => page.eval(js),
    text: (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`),
    has: (sel) => page.eval(`!!document.querySelector(${JSON.stringify(sel)})`),
    visible: (sel) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return !!(e && e.offsetParent !== null)})()`),
    click: (sel) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no ${sel.replace(/'/g, '')}'); e.click(); return true})()`),
    set: (id, v) => page.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true})()`),
    shot: async (label) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${name}-${label}.png`); await page.screenshot(f); note(`     screenshot ${f.split('/').pop()}`) },
    leafIdle: () => page.waitFor("!document.querySelector('.leaf-busy')", 180000),
    mode: async (m) => {
      await w.click('[data-tab=settings]')
      await w.eval(`(()=>{const c=document.querySelector('#mode${m === 'user' ? 'User' : 'Developer'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
      await sleep(300)
    },
    // The trade records the composer keeps (user-trade.js), newest last.
    trades: () => page.eval("(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('swk.usertrade.')); return k ? JSON.parse(localStorage.getItem(k)) : []})()"),
  }
  w.sync = async () => { await w.click('[data-tab=leaves]'); await w.leafIdle(); await w.click('#btnLeafSync'); await w.leafIdle() }
  return w
}

async function start (w, base, st, labels, init) {
  await w.page.open()
  await w.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${init}; try { localStorage.setItem('swk.registryCache', ${JSON.stringify(JSON.stringify(labels))}) } catch {}` })
  await w.page.go(base)
  await w.page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  await w.click('#btnCreate')
  await w.page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await w.click('#btnConfirm')
  await w.page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  await w.eval(`localStorage.setItem('swk.sequentia.assets', ${JSON.stringify(JSON.stringify(labels))})`)
  // Joining an operator and boarding are developer mode's; the trades below are user mode's.
  await w.mode('developer')
  await w.page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')")
  await w.click('[data-tab=leaves]')
  await w.page.waitFor("document.querySelector('#leafJoin')", 30000)
  await w.set('leafServer', base + 'operator'); await w.set('leafNodeUrl', base + 'node')
  await w.set('leafNodeUser', st.node_user); await w.set('leafNodePassword', st.node_password)
  await w.set('leafDelay', '1'); await w.set('leafMinDelay', '1')
  await w.click('#btnLeafJoin')
  await w.page.waitFor("document.querySelector('#leafRails')", 120000)
}

async function board (w, asset, amount, fund, fee) {
  // The tab's own sync can draw over the address before it is read: ask until it is seen.
  const script = await until(`${w.name}'s leaf address`, async () => {
    await w.leafIdle(); await w.click('#btnLeafAddress'); await w.leafIdle()
    return w.eval("(document.querySelector('#leafAddress')||{dataset:{}}).dataset.script || null")
  }, 60000, 200)
  for (const [a, v] of fund) await H.fund(script, a, v)
  await H.produce()
  const shown = `document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${asset}')`
  await until(`${w.name}'s on-chain coin`, async () => { await w.sync(); return w.eval(shown) }, 180000, 3000)
  for (let i = 0; ; i++) {
    await w.set('leafBoardAsset', asset); await w.set('leafBoardAmount', String(amount)); await w.set('leafBoardFee', fee)
    await w.click('#btnLeafBoard'); await w.leafIdle()
    if (await w.has('#btnLeafBoardConfirm')) { await w.click('#btnLeafBoardConfirm'); await w.leafIdle(); if (await w.has('#leafBoard .leaf-result')) return }
    const why = await w.text('.leaf-refusal')
    if (i < 5 && /Scan already in progress/.test(why)) { await sleep(2000); continue }
    throw new Error(`${w.name}: the board did not go through: ${why}`)
  }
}

// The Trade tab's visible words, checked against the list.
async function wordsCheck (w, label) {
  const text = await w.eval("(()=>{const s=document.querySelector('section[data-panel=\"swap\"]'); return s ? s.innerText : ''})()")
  const found = forbiddenIn(text)
  check(`${label}: no rail or developer word on the Trade tab`, found.length === 0, found.length ? found : `${text.length} characters checked against ${USER_MODE_FORBIDDEN_WORDS.length} words`)
  appendFileSync(join(out, 'user-mode-text.txt'), `--- ${label}\n${text}\n`)
}

async function pick (w, id, hex) { await w.set(id, hex); await sleep(200) }

// Review, then the ticket's three lines.
async function review (w, pay, get, amount) {
  await w.click('[data-tab=swap]')
  await w.page.waitFor("document.querySelector('#ucPay') && document.querySelector('#ucPay').offsetParent !== null", 30000)
  await pick(w, 'ucPay', pay); await pick(w, 'ucGet', get)
  await w.set('ucAmount', amount)
  await w.click('#ucReview')
  await w.page.waitFor("document.querySelector('#ucConfirm') || (document.querySelector('#ucNote') && document.querySelector('#ucNote').innerText.trim() && !document.querySelector('#ucReview').disabled)", 240000)
  return { in: await w.text('#ucIn'), out: await w.text('#ucOut'), cost: await w.text('#ucCost'), note: await w.text('#ucNote') }
}

async function main () {
  const st = await H.state()
  const X = st.x, Y = st.y
  const labels = { [X]: { ticker: 'XLEAF', name: 'Drive asset X', precision: 0 }, [Y]: { ticker: 'YLEAF', name: 'Drive asset Y', precision: 0 } }
  note(`operator ${st.server}; node ${st.node_url}; chain ${st.genesis_hash}; asset X ${X}, asset Y ${Y}`)
  const lwk = await lwkFrom()
  const relay = await startRelay(SEQOBD, st, await freePort())
  children.push(relay.proc)
  note(`relay seqobd pid ${relay.proc.pid} at ${relay.url}`)
  // The maker gives Y for X at 5 X per 4 Y; the covenant order sells Y at 4 X per 3 Y. The
  // maker's price is the better one, so the first trade goes to it.
  const maker = await startMaker(H, st, join(out, 'maker'), { pairs: [{ give: Y, want: X, rate_num: '5', rate_den: '4', min_give: '10000' }], fund: [[Y, 2000000], [X, 1000000]], port: await freePort(), lwk })
  children.push(maker.proc)
  note(`leaf maker pid ${maker.proc.pid} at ${maker.url}`)
  const order = await placeOrder(H, relay.url, { assetA: Y, assetB: X, sell: 600000, rateNum: 4, rateDen: 3, minLot: 10000 })
  note(`covenant order at ${order.at}, listed ${order.posted.status}`)
  await makerReady(H, maker, Y)

  const pairs = pairsArg ? JSON.parse(readFileSync(pairsArg, 'utf8'))
    : { chains: { [st.genesis_hash]: { pairs: [{ pay: X, receive: Y, sources: ['leaf-maker', 'covenant-round'] }, { pay: Y, receive: X, sources: ['leaf-maker', 'covenant-round'] }] } } }
  note(pairsArg ? `pairs admitted by ${pairsArg}` : 'pairs: the drive admits X→Y and Y→X itself (no drill list given)')
  writeFileSync(join(out, 'pairs-used.json'), JSON.stringify(pairs, null, 2))

  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port: await freePort() })
  children.push({ kill: () => shim.close() })
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control, '--seqob', relay.url, '--esplora', shim.url, '--maker', maker.url], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(srv)
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  note(`page ${base}`)
  const init = `window.SEQ_SEQOB_URL=${JSON.stringify(base + 'seqob')}; window.SEQ_LEAF_MAKERS=[${JSON.stringify(base + 'leafmaker')}]; window.SEQ_USER_MODE_PAIRS=${JSON.stringify('data:application/json,' + encodeURIComponent(JSON.stringify(pairs)))}`

  const A = wallet('A')
  await start(A, base, st, labels, init)
  await board(A, X, 3000000, [[X, 5000000]], X)
  await H.produce(); await H.bury()
  await until('A\'s board live', async () => { await A.sync(); return /3000000/.test(await A.text('#leafRails')) }, 180000, 3000)
  await A.shot('boarded-developer-mode')

  // The operator's clock: the drive runs it while it waits on "Settled".
  let pumping = false
  const pump = setInterval(async () => { if (pumping) return; pumping = true; try { await H.pump() } catch {} finally { pumping = false } }, 2500)

  // ---- 1. user mode: the user composer, BTC first, no rail word ----
  await A.mode('user')
  await A.click('[data-tab=swap]')
  await A.page.waitFor("document.querySelector('#ucPay') && document.querySelector('#ucPay').offsetParent !== null", 30000)
  check('user mode: the Trade tab is the user composer', await A.visible('#userComposer') && !(await A.visible('#swComposer')))
  const firsts = await A.eval("[document.querySelector('#ucPay').options[0].value, document.querySelector('#ucGet').options[0].value]")
  check('both pickers list BTC first', firsts[0] === 'BTC' && firsts[1] === 'BTC', firsts)
  await wordsCheck(A, 'user mode, empty')
  await A.shot('user-mode-composer')

  // ---- 2. a trade settled in the tree ----
  const t1 = await review(A, X, Y, '400000')
  check('the ticket shows what you pay, what you get and the fees, and nothing else', /You pay\s*\d+ XLEAF/.test(t1.in) && /You get\s*\d+ YLEAF/.test(t1.out) && /^(Fees .* included above|No fees)$/.test(t1.cost.trim()), t1)
  await wordsCheck(A, 'user mode, the in-tree ticket')
  await A.shot('ticket-in-tree')
  await A.click('#ucConfirm')
  const r1 = await until('the first trade sent', async () => { const r = (await A.trades()).slice(-1)[0]; return r && r.state !== 'confirming' ? r : null }, 120000)
  check('the trade went to the maker\'s in-tree swap (the most received)', r1 && r1.source === 'leaf-maker', r1 && r1.source)
  const sent1 = await until('"Sent" shown', async () => { const t = await A.text(`#ucTrades [data-trade="${r1.id}"]`); return /Sent|Settled/.test(t) ? t : null }, 120000).catch(() => '')
  check('"Sent" once the wallet handed its side over', /Sent|Settled/.test(sent1), sent1)
  await A.shot('in-tree-sent')
  await until('the in-tree trade Settled', async () => /Settled/.test(await A.text(`#ucTrades [data-trade="${r1.id}"]`)), 300000, 2000)
  const r1s = (await A.trades()).slice(-1)[0]
  check('"Settled" once the round that settles the coins it got is final', r1s.state === 'settled' && !!r1s.settle, { state: r1s.state, settle: r1s.settle })
  await wordsCheck(A, 'user mode, the in-tree trade settled')
  await A.shot('in-tree-settled')

  // ---- 3. a take of an on-chain covenant order ----
  await maker.stop()
  note('     the maker stopped: its quotes are gone from the book')
  const before = await H.outputValue(...order.at.split(':').map((x, i) => (i ? Number(x) : x)))
  const t2 = await review(A, X, Y, '300000')
  check('the ticket for the order shows the same three lines', /You pay\s*\d+ XLEAF/.test(t2.in) && /You get\s*\d+ YLEAF/.test(t2.out) && /^(Fees .* included above|No fees)$/.test(t2.cost.trim()), t2)
  await A.shot('ticket-covenant-order')
  await A.click('#ucConfirm')
  const r2 = await until('the second trade sent', async () => { const l = await A.trades(); const r = l[l.length - 1]; return l.length >= 2 && r.state !== 'confirming' ? r : null }, 120000)
  check('the trade went to a covenant order, taken in the operator\'s round', r2.source === 'covenant-round' && /^[0-9a-f]{64}:\d+$/.test(r2.order || ''), { source: r2.source, order: r2.order })
  await A.shot('covenant-sent')
  const sent2 = await until('"Sent" shown', async () => { const t = await A.text(`#ucTrades [data-trade="${r2.id}"]`); return /Sent|Settled/.test(t) ? t : null }, 120000).catch(() => '')
  check('"Sent" for the take', /Sent|Settled/.test(sent2), sent2)
  await until('the take Settled', async () => /Settled/.test(await A.text(`#ucTrades [data-trade="${r2.id}"]`)), 300000, 2000)
  await A.shot('covenant-settled')
  const fill = await until('the relay\'s fill record final', async () => {
    const fills = await (await fetch(`${relay.url}/v1/market/${Y}/${X}/fills`)).json().catch(() => ({}))
    const f = (fills.fills || []).find((x) => x.spent === order.at)
    return f && /final/.test(JSON.stringify(f)) ? f : null
  }, 120000, 2000).catch(() => null)
  check('the relay records the fill of the order by the round, final', !!fill && /final/.test(JSON.stringify(fill)), fill ? { txid: fill.txid, state: fill.state || fill.status } : 'no record')
  check('the order\'s first output is spent and it rests again with less', before === '600000' && !(await H.outputValue(order.at.split(':')[0], Number(order.at.split(':')[1]))), { before })

  // ---- 4. not offered ----
  const t3 = await review(A, Y, X, '10000')
  check('a pair nobody fills in one step is not offered, in plain words', /Not offered right now: nobody offers XLEAF for YLEAF in one step\./.test(t3.note) && !(await A.has('#ucConfirm')), t3.note)
  await wordsCheck(A, 'user mode, not offered')
  await A.shot('not-offered')
  await pick(A, 'ucPay', X); await pick(A, 'ucGet', 'BTC'); await A.set('ucAmount', '10000'); await A.click('#ucReview')
  await A.page.waitFor("document.querySelector('#ucNote').innerText.trim() && !document.querySelector('#ucReview').disabled", 60000)
  const t4 = await A.text('#ucNote')
  check('BTC for an asset with no admitted one-step route is not offered', /BTC for XLEAF is not offered\.|Not offered right now/.test(t4), t4)
  await A.shot('btc-not-offered')

  // ---- 5. developer mode as before ----
  await A.mode('developer')
  await A.click('[data-tab=swap]')
  await A.page.waitFor("document.querySelector('#swPayPick') && document.querySelector('#swPayPick').offsetParent !== null", 30000)
  check('developer mode: the composer with its rails, and no user composer', await A.visible('#swComposer') && await A.visible('#swPayPick') && !(await A.visible('#userComposer')))
  await A.shot('developer-mode-composer')
  clearInterval(pump)
  const bal = await A.eval("window.sequentiaWallet.request({method:'getLeafBalances'})")
  note(`     A's leaves at the end (developer mode's page API): ${JSON.stringify(bal.leaves)}`)
  writeFileSync(join(out, 'page-console.log'), (A.page.console || []).map(String).join('\n'))
  const errs = [...A.page.errors].filter((e) => !/Failed to load resource|registry|404|\/api\//.test(e))
  check('no page errors from the wallet\'s own code', errs.length === 0, errs.slice(0, 5))
  writeFileSync(join(out, 'seqobd.log'), relay.log.join(''))
  writeFileSync(join(out, 'maker.log'), maker.log.join(''))
}

main().catch(async (e) => {
  failures++; note('FAIL ' + (e.stack || e.message))
  for (const p of pages) { try { await p.screenshot(join(out, `failure-${pages.indexOf(p)}.png`)); note('     page errors: ' + JSON.stringify(p.errors.slice(-10))); note('     console: ' + JSON.stringify((p.console || []).filter((l) => /user trade|user composer|leaf/.test(String(l))).slice(-30))) } catch {} }
}).finally(async () => {
  for (const p of pages) { try { await p.stop(); if (p.dir) rmSync(p.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} }
  for (const c of children) { try { c.kill() } catch {} }
  note(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
})
