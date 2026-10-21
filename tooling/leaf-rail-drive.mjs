#!/usr/bin/env node
// Drives the Trade tab's leaf rail (developer mode) end to end, in two headless Chromium
// profiles (wallets A and B), against a local regtest operator and an order-book relay:
//
//   1. user mode: no Leaf choice in the composer, for a pair of two assets both wallets hold
//      as leaves;
//   2. an in-tree swap: A offers X for Y (Limit, Leaf to Leaf), B reads the offer (what it
//      gives, gets and pays) and accepts it, A completes it; both wallets' leaves move;
//   3. an order placed on the chain from leaves: B sells Y for X (Limit, pay Leaf, receive
//      On-chain), the operator's round offboards it, and B lists it on the relay;
//   4. a take from leaves: A buys part of that order (Market, Leaf to Leaf); the fill round
//      waits for A's forfeit, which A's page hands over by itself, and A gets a Y leaf.
//
// Each step is a DOM assertion and a screenshot, and every on-chain effect is checked at
// the node.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and SeqDEX's relay
// binary (`seqobd`), which this starts on a port of its own against the harness's node.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 SEQOBD=/path/to/seqobd \
//     node tooling/leaf-rail-drive.mjs <evidence-dir>
//
// Needs pkg/ (the lwk_wasm build) for the page to start, and a Chromium (CHROMIUM=…).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { startEsploraShim } from './esplora-shim.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const SEQOBD = process.env.SEQOBD
const out = resolve(process.argv[2] || join(tmpdir(), 'leaf-rail-drive-evidence'))
if (!SEQOBD) { console.error('SEQOBD must name the relay binary'); process.exit(2) }
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { console.log(s); appendFileSync(log, s + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
const rpc = (method, params = []) => ctl('/rpc', { method, params })
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

let failures = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}
async function until (what, f, ms = 120000, every = 1000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(every)
  }
}

let step = 0
const children = []
const pages = []

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
    shot: async (label) => {
      step++
      const f = join(out, `${String(step).padStart(2, '0')}-${name}-${label}.png`)
      await page.screenshot(f)
      note(`     screenshot ${f.split('/').pop()}`)
    },
    leafIdle: () => page.waitFor("!document.querySelector('.leaf-busy')", 180000),
    // The leaf wallet's balances, from the page API: { asset: total atoms } of live leaves.
    leaves: async () => {
      const b = await page.eval("window.sequentiaWallet.request({method:'getLeafBalances'})")
      // Every coin the wallet holds, whatever its standing: all states but those given up.
      const o = {}
      for (const [a, v] of Object.entries(b.leaves || {})) {
        o[a] = 0n
        for (const [st, n] of Object.entries(v.states || {})) if (!/spent|given|offered|sending/.test(st)) o[a] += BigInt(n)
      }
      w.lastBalances = b
      return o
    },
  }
  // The leaf rail's panel is busy while any of its buttons is disabled.
  w.leafRailIdle = () => page.waitFor("(()=>{const b=document.querySelector('#swLeafBox'); return !b || ![...b.querySelectorAll('button')].some(x=>x.disabled)})()", 300000)
  w.sync = async () => { await w.click('[data-tab=leaves]'); await w.leafIdle(); await w.click('#btnLeafSync'); await w.leafIdle() }
  return w
}

async function start (w, base, st, labels) {
  await w.page.open()
  // Faster leaf syncs for the drive, and the two test assets known to the registry cache, so the
  // composer offers them like any listed asset.
  await w.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=4000; try { localStorage.setItem('swk.registryCache', ${JSON.stringify(JSON.stringify(labels))}) } catch {}` })
  await w.page.go(base)
  await w.page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  await w.click('#btnCreate')
  await w.page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await w.click('#btnConfirm')
  await w.page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  await w.eval(`localStorage.setItem('swk.sequentia.assets', ${JSON.stringify(JSON.stringify(labels))})`)
  // Developer mode, then join the operator.
  await w.click('[data-tab=settings]')
  await w.eval("(()=>{const c=document.querySelector('#modeDeveloper'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()")
  await w.page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')")
  await w.click('[data-tab=leaves]')
  await w.page.waitFor("document.querySelector('#leafJoin')", 30000)
  await w.set('leafServer', base + 'operator'); await w.set('leafNodeUrl', base + 'node')
  await w.set('leafNodeUser', st.node_user); await w.set('leafNodePassword', st.node_password)
  await w.set('leafDelay', '1'); await w.set('leafMinDelay', '1')
  await w.click('#btnLeafJoin')
  await w.page.waitFor("document.querySelector('#leafRails')", 120000)
}

// An on-chain coin for the leaf wallet, then a board of `amount` of `asset`, its fee in `fee`.
async function board (w, asset, amount, fund, fee) {
  await w.click('#btnLeafAddress'); await w.leafIdle()
  const script = await w.eval("document.querySelector('#leafAddress').dataset.script")
  for (const [a, v] of fund) await ctl('/fund', { script, asset: a, amount: v })
  await ctl('/produce')
  await w.sync()
  await w.page.waitFor(`document.querySelector('#leafBoardAsset') && [...document.querySelector('#leafBoardAsset').options].some(o=>o.value==='${asset}')`, 60000)
  // Two leaf wallets on one node can meet the node's one-at-a-time UTXO scan ("Scan already in
  // progress", the library's open finding): such a refusal is asked again, nothing else is.
  for (let i = 0; ; i++) {
    await w.set('leafBoardAsset', asset); await w.set('leafBoardAmount', String(amount)); await w.set('leafBoardFee', fee)
    await w.click('#btnLeafBoard'); await w.leafIdle()
    if (await w.has('#btnLeafBoardConfirm')) {
      await w.click('#btnLeafBoardConfirm'); await w.leafIdle()
      if (await w.has('#leafBoard .leaf-result')) { note(`     ${w.name} boarded ${amount} of ${asset.slice(0, 8)}`); return }
    }
    const why = await w.text('.leaf-refusal')
    if (i < 5 && /Scan already in progress/.test(why)) { note(`     ${w.name}: board refused by the node's scan lock, asked again`); await sleep(2000); continue }
    await w.shot('board-failed')
    throw new Error(`${w.name}: the board did not go through: ${why}`)
  }
}

// The composer: the pair, Market or Limit, the amounts and each leg's rail.
async function compose (w, { pay, recv, mode, payAmt, recvAmt, payRail, recvRail, tickers }) {
  await w.click('[data-tab=swap]')
  await w.page.waitFor("document.querySelector('#swPayPick') && document.querySelector('#swPayPick').offsetParent !== null", 30000)
  for (const [side, hex] of [['#swPayPick', pay], ['#swRecvPick', recv]]) {
    const cur = await w.text(side === '#swPayPick' ? '#swPayTk' : '#swRecvTk')
    if (cur.trim() === tickers[hex]) continue
    await w.click(side)
    await w.page.waitFor("document.querySelector('.swpop input')", 10000)
    const pick = `(()=>{const b=[...document.querySelectorAll('.swpop .swopt')].find(b=>(b.querySelector('.swopt-tk')||{}).innerText?.trim().startsWith(${JSON.stringify(tickers[hex])})); if(!b) return false; b.click(); return true})()`
    let picked = await w.eval(pick)
    if (!picked) {
      // Not held: found by typing, as the picker offers every listed asset to a search.
      await w.eval(`(()=>{const i=document.querySelector('.swpop input'); i.value=${JSON.stringify(tickers[hex])}; i.dispatchEvent(new Event('input')); return true})()`)
      await sleep(300)
      picked = await w.eval(pick)
    }
    if (!picked) throw new Error(`${w.name}: ${tickers[hex]} is not offered in the picker`)
  }
  await w.page.waitFor(`document.querySelector('#swModeSeg button[data-m="${mode}"]') && !document.querySelector('#swModeSeg button[data-m="${mode}"]').disabled`, 10000)
  await w.click(`#swModeSeg button[data-m="${mode}"]`)
  if (recvAmt != null) await w.set('swRecvAmt', recvAmt)
  if (payAmt != null) await w.set('swPayAmt', payAmt)
  await sleep(500)
  if (recvAmt != null) await w.set('swRecvAmt', recvAmt)   // a Market requote may rewrite the other side
  const railBtn = (leg, r) => r === 'leaf' ? (leg === 'pay' ? '#swPayLeaf' : '#swRecvLeaf') : `#${leg === 'pay' ? 'swPayRailSeg' : 'swRecvRailSeg'} button[data-r="${r}"]`
  await w.page.waitFor(`document.querySelector('${railBtn('pay', payRail)}')`, 10000)
  await w.click(railBtn('pay', payRail))
  await w.click(railBtn('recv', recvRail))
  await w.page.waitFor("!document.querySelector('#swLeafBox').classList.contains('hide')", 10000)
}

async function main () {
  const st = await ctl('/state')
  const X = st.x, Y = st.y
  const labels = { [X]: { ticker: 'XLEAF', name: 'Drive asset X', precision: 0 }, [Y]: { ticker: 'YLEAF', name: 'Drive asset Y', precision: 0 } }
  const tickers = { [X]: 'XLEAF', [Y]: 'YLEAF' }
  note(`operator ${st.server}; node ${st.node_url}; asset X ${X} (listed for fees), asset Y ${Y} (not listed)`)

  // The relay, on a port of its own, against the harness's node, following the operator's rounds.
  const relayPort = await freePort()
  const relay = spawn(SEQOBD, [`-listen=127.0.0.1:${relayPort}`, `-node-rpc=${new URL(st.node_url).host}`, `-node-rpc-user=${st.node_user}`, `-node-rpc-pass=${st.node_password}`,
    '-watch-interval=1s', '-min-expiry=5s', `-arca-operator=${st.server}`, '-fill-anchor-depth=2'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(relay)
  const relayLog = []
  relay.stdout.on('data', (d) => relayLog.push(String(d))); relay.stderr.on('data', (d) => relayLog.push(String(d)))
  const R = `http://127.0.0.1:${relayPort}`
  await until('the relay', async () => { try { return (await fetch(`${R}/v1/markets`)).status < 500 } catch { return false } }, 30000, 500)
  note(`relay seqobd pid ${relay.pid} at ${R}`)

  // The explorer the page reads an order's output from before it lists it (its /api), over the node.
  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port: await freePort() })
  children.push({ kill: () => shim.close() })
  const srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control, '--seqob', R, '--esplora', shim.url], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(srv)
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
  note(`page ${base}`)

  const A = wallet('A'), B = wallet('B')
  await start(A, base, st, labels)
  await start(B, base, st, labels)
  // A boards X; B boards Y (its fee in X, which the node takes).
  await board(A, X, 3000000, [[X, 5000000]], X)
  await board(B, Y, 3000000, [[Y, 5000000], [X, 1000000]], X)
  await ctl('/produce'); await ctl('/bury')
  await A.sync(); await B.sync()
  await until('both boards live', async () => { await A.sync(); await B.sync(); const a = await A.leaves(), b = await B.leaves(); return (a[X] || 0n) >= 3000000n && (b[Y] || 0n) >= 3000000n }, 180000, 3000)
  const a0 = await A.leaves(), b0 = await B.leaves()
  note(`     leaves before: A ${JSON.stringify({ X: String(a0[X] || 0n), Y: String(a0[Y] || 0n) })}, B ${JSON.stringify({ X: String(b0[X] || 0n), Y: String(b0[Y] || 0n) })}`)
  await A.shot('boarded')

  // ---- 1. user mode: no Leaf choice ----
  await A.click('[data-tab=settings]')
  await A.eval("(()=>{const c=document.querySelector('#modeUser'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()")
  await A.click('[data-tab=swap]')
  await A.page.waitFor("document.querySelector('#swPayPick')")
  // In user mode the picker lists only what is held on the chain or Lightning; pick the pair by search.
  for (const [side, hex] of [['#swPayPick', X], ['#swRecvPick', Y]]) {
    await A.click(side)
    await A.page.waitFor("document.querySelector('.swpop input')", 10000)
    await A.eval(`(()=>{const i=document.querySelector('.swpop input'); i.value=${JSON.stringify(tickers[hex])}; i.dispatchEvent(new Event('input')); return true})()`)
    await sleep(300)
    await A.eval(`(()=>{const b=[...document.querySelectorAll('.swpop .swopt')].find(b=>(b.querySelector('.swopt-tk')||{}).innerText?.trim().startsWith(${JSON.stringify(tickers[hex])})); b.click(); return true})()`)
  }
  await sleep(500)
  const userRails = await A.eval("[...document.querySelectorAll('#swPayRailSeg button, #swRecvRailSeg button')].filter(b=>b.offsetParent!==null).map(b=>b.dataset.r)")
  check('user mode: the composer offers no Leaf choice, and no leaf panel', !userRails.includes('leaf') && !(await A.visible('#swLeafBox')), userRails)
  await A.shot('user-mode-no-leaf')
  await A.click('[data-tab=settings]')
  await A.eval("(()=>{const c=document.querySelector('#modeDeveloper'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()")
  await A.page.waitFor("!document.querySelector('#tabLeaves').classList.contains('hide')")

  // ---- 2. an in-tree swap: A gives 300000 X for 400000 Y ----
  await compose(A, { pay: X, recv: Y, mode: 'post', payAmt: '300000', recvAmt: '400000', payRail: 'leaf', recvRail: 'leaf', tickers })
  const devRails = await A.eval("[...document.querySelectorAll('#swPayRailSeg button, #swRecvRailSeg button')].filter(b=>b.offsetParent!==null).map(b=>b.dataset.r)")
  check('developer mode: Leaf is offered on both legs', devRails.filter((r) => r === 'leaf').length === 2, devRails)
  check('the regular Place order is hidden while a leg is on Leaf', !(await A.visible('#swReview')))
  await A.shot('swap-compose')
  await A.click('#swLeafOffer'); await A.leafRailIdle()
  await A.page.waitFor("document.querySelector('#swLeafOfferText') || document.querySelector('#swLeafBox .status.err')", 120000)
  const offerRows = await A.text('#swLeafOfferRows')
  check('the offer shows what A gives, gets and pays, with nothing signed', /You give\s*300000 XLEAF/.test(offerRows) && /You get\s*400000 YLEAF/.test(offerRows) && /You pay/.test(offerRows), offerRows)
  const offer = await A.eval("document.querySelector('#swLeafOfferText').value")
  check('A has an offer text to hand over', /^[a-z-]*offer:/.test(offer), offer.slice(0, 24) + '…')
  await A.shot('swap-offered')

  await compose(B, { pay: Y, recv: X, mode: 'take', payAmt: '400000', recvAmt: '300000', payRail: 'leaf', recvRail: 'leaf', tickers })
  await B.set('swLeafOfferIn', offer)
  await B.click('#swLeafRead'); await B.leafRailIdle()
  await B.page.waitFor("document.querySelector('#swLeafReadRows') || document.querySelector('#swLeafBox .status.err')", 120000)
  const readRows = await B.text('#swLeafReadRows')
  check('B is shown what it gets, gives and pays before it signs', /You get\s*300000 XLEAF/.test(readRows) && /You give\s*400000 YLEAF/.test(readRows) && /You pay\s*\d+ YLEAF/.test(readRows) && /The other wallet pays/.test(readRows), readRows)
  await B.shot('swap-read-approval')
  await B.click('#swLeafAcceptGo'); await B.leafRailIdle()
  await B.page.waitFor("document.querySelector('#swLeafAcceptText') || document.querySelector('#swLeafBox .status.err')", 120000)
  const accept = await B.eval("(document.querySelector('#swLeafAcceptText')||{}).value||''")
  check('B accepted, and has an acceptance to send back', /accept:/.test(accept), (await B.text('#swLeafBox .status.err')) || accept.slice(0, 24) + '…')
  await B.shot('swap-accepted')

  await A.set('swLeafAcceptIn', accept)
  await A.click('#swLeafCompleteReview'); await A.leafRailIdle()
  await A.page.waitFor("document.querySelector('#swLeafCompleteRows')", 60000)
  await A.shot('swap-complete-approval')
  const pool0 = await rpc('getrawmempool')
  await A.click('#swLeafCompleteGo'); await A.leafRailIdle()
  const done = await A.text('#swLeafBox')
  check('A completed the swap in one reassignment', /done: both assets moved in one reassignment/.test(done), done.slice(-200))
  check('node: an in-tree swap puts nothing on the chain', (await rpc('getrawmempool')).length === pool0.length)
  await A.shot('swap-done')
  await A.sync(); await B.sync()
  const a1 = await A.leaves(), b1 = await B.leaves()
  note(`     balances after the swap, as the page API answers: A ${JSON.stringify(A.lastBalances.leaves)}, B ${JSON.stringify(B.lastBalances.leaves)}`)
  note(`     leaves after the swap: A ${JSON.stringify({ X: String(a1[X] || 0n), Y: String(a1[Y] || 0n) })}, B ${JSON.stringify({ X: String(b1[X] || 0n), Y: String(b1[Y] || 0n) })}`)
  check('both balances moved: A got 400000 Y and gave 300000 X and its margins', (a1[Y] || 0n) - (a0[Y] || 0n) === 400000n && (a0[X] - a1[X]) >= 300000n && (a0[X] - a1[X]) < 302000n, { dX: String(a1[X] - a0[X]), dY: String((a1[Y] || 0n) - (a0[Y] || 0n)) })
  check('both balances moved: B got 300000 X and gave 400000 Y and its margins', (b1[X] || 0n) - (b0[X] || 0n) === 300000n && (b0[Y] - b1[Y]) >= 400000n && (b0[Y] - b1[Y]) < 402000n, { dX: String((b1[X] || 0n) - (b0[X] || 0n)), dY: String(b1[Y] - b0[Y]) })
  await B.click('[data-tab=leaves]'); await B.shot('swap-B-leaves')

  // ---- 3. B places an order on the chain from leaves: 600000 Y for 600000 X ----
  await compose(B, { pay: Y, recv: X, mode: 'post', payAmt: '600000', recvAmt: '600000', payRail: 'leaf', recvRail: 'chain', tickers })
  await B.set('swLeafMinLot', '100000')
  await B.click('#swLeafPlaceReview'); await B.leafRailIdle()
  await B.page.waitFor("document.querySelector('#swLeafPlaceRows') || document.querySelector('#swLeafBox .status.err')", 120000)
  const placeRows = await B.text('#swLeafPlaceRows')
  check('the placement shows the sale, the price, the fee and the refund before anything is signed', /Sell\s*600000 YLEAF/.test(placeRows) && /600000 XLEAF \(600000 atoms\) if filled whole/.test(placeRows) && /Fee/.test(placeRows) && /Refund/.test(placeRows), placeRows || await B.text('#swLeafBox .status.err'))
  await B.shot('place-approval')
  await B.click('#swLeafPlaceGo'); await B.leafRailIdle()
  check('B placed the order', /Placed: order/.test(await B.text('#swLeafBox')), (await B.text('#swLeafBox')).slice(-200))
  const placeRound = await until('the placement round', async () => { const r = await ctl('/build'); return r.rounds.length ? r : null }, 120000, 2000)
  note(`     placement round ${JSON.stringify(placeRound.rounds.map((r) => ({ txid: r.txid, vsize: r.vsize })))}`)
  let resting = null
  await until('the order to rest on the chain', async () => {
    await ctl('/pass'); await ctl('/produce'); await ctl('/bury')
    await B.click('[data-tab=swap]')
    if (await B.has('#swLeafOrdersRefresh')) { await B.click('#swLeafOrdersRefresh'); await B.leafRailIdle() }
    resting = await B.eval("(()=>{const r=document.querySelector('#swLeafBox [data-state=\"resting\"]'); return r ? {...r.dataset} : null})()")
    if (!resting) note('     orders now: ' + JSON.stringify(await B.eval("[...document.querySelectorAll('#swLeafBox [data-order]')].map(r=>r.dataset.state)")))
    return resting
  }, 300000, 3000)
  check('the order rests on the chain from B\'s leaves', !!resting, resting)
  await B.shot('place-resting')
  await B.click(`#swLeafList-${resting.order.slice(0, 8)}`); await B.leafRailIdle()
  check('B listed the order on the relay', /Listed on the relay at/.test(await B.text('#swLeafBox')), (await B.text('#swLeafBox')).slice(-300))
  const book = await (await fetch(`${R}/v1/market/${Y}/${X}/orderbook`)).json()
  const served = (book.offers || []).find((o) => o.covenant && `${o.covenant.covenant_txid}:${o.covenant.covenant_vout}` === resting.restsAt)
  check('the relay serves the order at the outpoint the chain shows, holding 600000', !!served && served.offer_amount === '600000', served ? { offer: served.offer_id, at: resting.restsAt } : book)
  await B.shot('place-listed')

  // ---- 4. A takes 300000 Y of it from leaves ----
  await compose(A, { pay: X, recv: Y, mode: 'take', recvAmt: '300000', payRail: 'leaf', recvRail: 'leaf', tickers })
  // While the order's own transaction is not final, the library refuses the take, before anything is signed.
  const orderTx = await rpc('getrawtransaction', [resting.restsAt.split(':')[0], true]).catch(() => ({}))
  if (!orderTx.confirmations) {
    await A.click('#swLeafTakeReview'); await A.leafRailIdle()
    const early = await A.text('#swLeafBox .status.err')
    check('a take of an order whose transaction is not final is refused in the library\'s words', /a round takes an order once its transaction is final/.test(early), early)
    await A.shot('take-refused-not-final')
  }
  await ctl('/produce'); await ctl('/bury')
  await A.click('#swLeafTakeReview'); await A.leafRailIdle()
  await A.page.waitFor("document.querySelector('#swLeafTakeRows') || document.querySelector('#swLeafBox .status.err')", 120000)
  const takeRows = await A.text('#swLeafTakeRows')
  check('the take shows the order, what A gets, gives and pays before anything is signed', takeRows.includes(resting.restsAt) && /You get\s*300000 YLEAF/.test(takeRows) && /You give\s*\d+ XLEAF/.test(takeRows) && /Operator’s fee/.test(takeRows), takeRows || await A.text('#swLeafBox .status.err'))
  await A.shot('take-approval')
  const a2 = await A.leaves()
  await A.click('#swLeafTakeGo'); await A.leafRailIdle()
  check('A took the order from leaves', /Taken \(/.test(await A.text('#swLeafBox')), (await A.text('#swLeafBox')).slice(-300))
  await A.shot('take-submitted')
  await ctl('/bury')
  const built = await until('the fill round', async () => { const r = await ctl('/build'); return r.rounds.length ? r.rounds[0] : null }, 120000, 2000)
  note(`     fill round ${built.txid} ${built.vsize} vB, fills ${JSON.stringify(built.orders || built.fills || null)}`)
  // A's page syncs by itself (every few seconds while a coin moves) and hands its forfeit over.
  await until('the fill round broadcast once A\'s forfeit is in', async () => { await ctl('/pass'); return (await rpc('getrawmempool')).includes(built.txid) }, 180000, 2000)
  const tx = await rpc('getrawtransaction', [built.txid, true])
  const [otxid, ovout] = resting.restsAt.split(':')
  check('node: the fill round spends B\'s order', tx.vin.some((i) => i.txid === otxid && i.vout === Number(ovout)), tx.vin.map((i) => `${i.txid}:${i.vout}`))
  await ctl('/produce'); await ctl('/bury')
  await until('A\'s Y leaf live', async () => { await A.sync(); const a = await A.leaves(); return (a[Y] || 0n) - (a2[Y] || 0n) === 300000n }, 180000, 3000)
  const a3 = await A.leaves()
  check('A holds 300000 more Y as a leaf, and paid X for it from leaves', (a3[Y] || 0n) - (a2[Y] || 0n) === 300000n && a3[X] < a2[X], { dX: String(a3[X] - a2[X]), dY: String((a3[Y] || 0n) - (a2[Y] || 0n)) })
  await A.click('[data-tab=leaves]'); await A.shot('take-settled')

  const errs = [...A.page.errors, ...B.page.errors].filter((e) => !/Failed to load resource|registry|404|\/api\//.test(e))
  check('no page errors from the wallet\'s own code', errs.length === 0, errs.slice(0, 5))
  writeFileSync(join(out, 'seqobd.log'), relayLog.join(''))
}

main().catch((e) => { failures++; note('FAIL ' + (e.stack || e.message)) }).finally(async () => {
  for (const p of pages) { try { await p.stop(); if (p.dir) rmSync(p.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {} }
  for (const c of children) { try { c.kill() } catch {} }
  note(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
})
