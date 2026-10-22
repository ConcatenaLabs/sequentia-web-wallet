#!/usr/bin/env node
// Drives developer mode's Swap tab (swap.js) in headless Chromium against a live interactive maker
// on a private regtest chain (interactive-maker-stack.mjs): SeqDEX's wallet daemon and its
// order-book maker resting an offer to sell 1,000 of the Sequence token at 0.37 USDX each and
// co-signing each lift over the relay's courier, as the testnet's makers do.
//
// A wallet holding 1,000 USDX in the clear buys tSEQ with 37 USDX at market, on the Unblinded book:
//
//   honest    the market order fills: one swap transaction in a block, the wallet gets exactly
//             100 tSEQ and pays 37 USDX and its fee, and the maker gets exactly 37 USDX. With
//             the review's box unticked every output paying the wallet is at its usual address
//             in the clear; ticked, the maker blinds the one that pays it;
//   blinded-coins  the wallet's USDX sits at its blinded address: with the box unticked the
//             order is refused before anything is sent, saying why, and nothing moves;
//   shortpay  the maker answers with a swap that pays the wallet one atom less (and keeps it);
//   blind     the maker answers with the output that pays the wallet blinded to a key of its own.
//
// Against a hostile maker (SEQOB_MAKER built from a seqdex checkout with tooling/hostile-maker.patch
// applied; the drive runs it with SEQOB_HOSTILE set to the mode) the
// wallet must refuse before signing, say so, and nothing may move. `--tick` ticks the review's
// "Also take offers that pay a blinded address" box first; without it the review is left as it
// opens. Each step is a DOM assertion and a screenshot; every effect is checked at the node.
//
//   SEQUENTIA_BIN=/path/to/Sequentia/src SEQOBD=… OCEAND=… SEQOB_MAKER=… SEQOB_OCTL=… \
//     node tooling/interactive-maker-drive.mjs [honest|shortpay|blind] [--tick] [evidence-dir]
//
// Needs pkg/ (the lwk_wasm build) and a Chromium (CHROMIUM=…). Every directory it makes is
// removed at the end, every process it starts is stopped by its PID.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Page } from './cdp-page.mjs'
import { startChain, startInteractiveMaker, startBackends } from './interactive-maker-stack.mjs'

const { SEQUENTIA_BIN, SEQOBD, OCEAND, SEQOB_MAKER, SEQOB_OCTL } = process.env
if (!SEQUENTIA_BIN || !SEQOBD || !OCEAND || !SEQOB_MAKER || !SEQOB_OCTL) { console.log('skipped: set SEQUENTIA_BIN, SEQOBD, OCEAND, SEQOB_MAKER and SEQOB_OCTL'); process.exit(0) }
const args = process.argv.slice(2)
const MODES = ['honest', 'shortpay', 'blind', 'blinded-coins']
const MODE = args.find((a) => MODES.includes(a)) || 'honest'
const TICK = args.includes('--tick')
const EVIDENCE = args.find((a) => !a.startsWith('--') && !MODES.includes(a)) || null
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const tag = `${MODE}${TICK ? '-tick' : ''}`
const work = mkdtempSync(join(tmpdir(), 'wallet-interactive-'))
const COIN = 100000000n
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0, step = 0
const note = (s) => { console.log(`[${tag}] ` + s); if (EVIDENCE) appendFileSync(join(EVIDENCE, `web-interactive-${tag}.log`), s + '\n') }
const check = (what, cond, detail = '') => { note(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); if (!cond) failures++ }

let chain = null, maker = null, be = null, page = null
try {
  chain = await startChain({ sequentiad: join(SEQUENTIA_BIN, 'sequentiad'), seqobd: SEQOBD, work, log: note, nodeArgs: ['-blockfilterindex=1'] })
  const SEQ = chain.policy, Y = chain.Y
  maker = await startInteractiveMaker({ chain, oceand: OCEAND, seqobMaker: SEQOB_MAKER, seqobOctl: SEQOB_OCTL, work,
    give: { asset: SEQ, atoms: 1000n * COIN }, want: { asset: Y, atoms: 370n * COIN }, fund: [{ asset: Y, amount: 1 }],
    env: ['shortpay', 'blind'].includes(MODE) ? { SEQOB_HOSTILE: MODE } : {}, log: note })
  const assets = { [SEQ]: ['tSEQ', 'Sequence (test)', 8], [Y]: ['USDX', 'Dollar (test)', 8] }
  be = await startBackends({ chain, assets, prices: { USDX: 1, tSEQ: 0.37, tBTC: 84200 } })
  note(`the page and its backends at ${be.url}`)

  page = new Page(); await page.open()
  const ev = (js) => page.eval(js)
  const shot = async (label) => { if (!EVIDENCE) return; step++; await page.screenshot(join(EVIDENCE, `web-interactive-${tag}-${String(step).padStart(2, '0')}-${label}.png`)) }
  const labels = Object.fromEntries(Object.entries(assets).map(([k, [t, n, p]]) => [k, { ticker: t, name: n, precision: p }]))
  const init = `window.SEQ_DEV_CHAIN = ${JSON.stringify({ policyAsset: SEQ, genesis: chain.genesis, recordsV2Height: null })}`
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${init}; try { localStorage.setItem('swk.registryCache', ${JSON.stringify(JSON.stringify(labels))}) } catch {}` })
  await page.go(be.url)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 60000)
  await ev("document.querySelector('#btnCreate').click()")
  await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await ev("document.querySelector('#btnConfirm').click()")
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 60000)
  await ev("document.querySelector('[data-tab=receive]').click()")
  const addr = await page.waitFor("(()=>{const t=document.getElementById('addr').innerText; return /^ert1/.test(t) ? t : ''})()", 30000)
  note(`the wallet's address ${addr}`)
  let fundTo = addr
  if (MODE === 'blinded-coins') {
    await ev("document.getElementById('btnConf').click()")
    fundTo = await page.waitFor("(()=>{const t=document.getElementById('addr').innerText; return /^el1/.test(t) ? t : ''})()", 30000)
    await ev("document.getElementById('btnConf').click()")
    note(`funded at the wallet's blinded address ${fundTo}`)
  }
  await chain.fund(fundTo, Y, 1000); await chain.mine(1)

  // The coins the node sees at the wallet's address, by asset (explicit outputs only).
  const held = async () => {
    const s = await chain.call('scantxoutset', ['start', [`addr(${addr})`]])
    const by = {}
    for (const u of s.unspents) if (u.asset) by[u.asset] = (by[u.asset] || 0n) + BigInt(Math.round(u.amount * 1e8))
    return by
  }

  // The Balance tab shows the funding once the page's sync has it.
  await ev("document.querySelector('[data-tab=balance]').click()")
  for (let until = Date.now() + 240000; !(await ev("/Dollar \\(test\\)\\s+1,?000\\s+USDX/.test(document.querySelector('#app').innerText)"));) {
    if (Date.now() > until) throw new Error('the page never showed the funding')
    await ev("(()=>{const b=document.getElementById('btnSync'); if (b && !b.disabled) b.click()})()")
    await sleep(5000)
  }

  // Developer mode's Swap tab, the Unblinded book as it opens: pay USDX, receive tSEQ.
  await ev("document.querySelector('[data-tab=settings]').click(); (()=>{const c=document.querySelector('#modeDeveloper'); c.checked=true; c.dispatchEvent(new Event('change'))})()")
  await sleep(500)
  await ev("document.querySelector('[data-tab=swap]').click()")
  await page.waitFor("document.querySelector('#swPayPick') && document.querySelector('#swPayPick').offsetParent !== null", 30000)
  // The page's own sync shows the funding before the picker offers USDX: open the picker, look,
  // close it, until the row shows the 1,000 on-chain.
  for (let until = Date.now() + 180000; ;) {
    await ev("document.querySelector('#swPayPick').click()")
    await sleep(800)
    if (await ev("(()=>{const r=[...document.querySelectorAll('.swpop .swopt')].find(e=>e.innerText.startsWith('USDX') && /1,?000 on-chain/.test(e.innerText)); if(r){r.click(); return true} return false})()")) break
    await ev("document.querySelector('#swPayPick').click()")
    if (Date.now() > until) throw new Error('the picker never offered the 1,000 USDX: ' + await ev("[...document.querySelectorAll('.swpop .swopt')].map(e=>e.innerText.replace(/\\n/g,' | ')).join(' // ')"))
    await sleep(3000)
  }
  await ev("document.querySelector('#swRecvPick').click()")
  await ev("(()=>{const i=document.querySelector('.swpop input'); i.value='tSEQ'; i.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await sleep(500)
  await ev("[...document.querySelectorAll('.swpop .swopt')].find(e=>e.innerText.startsWith('tSEQ')).click()")
  await page.waitFor("/1,000/.test((document.getElementById('swBook')||{}).innerText||'')", 60000)
  check('the Unblinded book is the one shown', await ev("/Unblinded book: transparent settlement, the default/.test(document.body.innerText)"))
  check('the maker\'s offer is on the book: 1,000 tSEQ at 0.37', await ev("/0\\.37[\\s\\S]*1,000/.test(document.getElementById('swBook').innerText)"))
  check('the confidential-receive box under the composer is unticked', await ev("!document.getElementById('swConfChk').checked"))
  await ev("(()=>{const e=document.getElementById('swPayAmt'); e.focus(); e.value='37'; e._userTyped=true; e.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await page.waitFor("document.getElementById('swRecvAmt').value === '100' && !document.getElementById('swReview').disabled", 30000)
  await shot('composer')
  const before = await held()
  const m0 = await maker.balance()

  // The review, as it opens.
  await ev("document.getElementById('swReview').click()")
  await page.waitFor("[...document.querySelectorAll('button')].some(b=>/Confirm & sign/.test(b.innerText))", 30000)
  await sleep(500)
  const review = await ev("(()=>{const c=[...document.querySelectorAll('.card')].find(c=>/Review market order/i.test(c.innerText)); return c ? c.innerText : ''})()")
  note('review:\n    ' + review.replace(/\n+/g, '\n    '))
  const box = await ev("!!document.querySelector('.blind-ask input')")
  if (box) check('the blinded-address box opens unticked', await ev("!document.querySelector('.blind-ask input').checked"))
  if (TICK) {
    check('the review asks about a blinded address', box)
    await ev("(()=>{const c=document.querySelector('.blind-ask input'); c.checked=true; c.dispatchEvent(new Event('change'))})()")
    await sleep(500)
  }
  await shot('review')
  const confirmOk = await ev("!([...document.querySelectorAll('button')].find(b=>/Confirm & sign/.test(b.innerText)).disabled)")
  check('the review can be confirmed', confirmOk, confirmOk ? '' : await ev("(document.querySelector('.card .status.err')||{}).innerText||''"))
  const pays = /You pay\s+up to 37 USDX/.test(review) || /You pay\s+up to 37 USDX/.test(await ev("(()=>{const c=[...document.querySelectorAll('.card')].find(c=>/Review market order/i.test(c.innerText)); return c ? c.innerText : ''})()"))
  check('the review shows the 37 USDX paid', pays)
  if (!confirmOk) throw new Error('the review cannot be confirmed')

  await ev("[...document.querySelectorAll('button')].find(b=>/Confirm & sign/.test(b.innerText)).click()")
  // The outcome: a toast for a fill, or the review's status for a refusal.
  const outcome = await page.waitFor(`(()=>{
    const t=[...document.querySelectorAll('.toast')].map(e=>e.innerText).join(' | ');
    if (/Market order filled|Filled what the book had|Filled part/.test(t)) return 'filled: ' + t;
    if (/could not be taken|Nothing was filled|signed nothing/.test(t)) return 'refused: ' + t;
    const c=[...document.querySelectorAll('.card')].find(c=>/Review market order/i.test(c.innerText));
    const st=c && c.querySelector('.status'); const s=st ? st.innerText : '';
    if (st && /err/.test(st.className) && s.trim()) return 'refused: ' + s;
    if (/book moved|could not be taken|Could not fill|signed nothing/.test(s)) return 'refused: ' + s;
    return '';
  })()`, 180000)
  note('outcome: ' + outcome)
  await shot('outcome')
  await chain.mine(1)
  await sleep(1500)
  const after = await held()
  const dS = (after[SEQ] || 0n) - (before[SEQ] || 0n), dY = (before[Y] || 0n) - (after[Y] || 0n)
  note(`the node sees at the wallet's address: ${dS >= 0n ? '+' : ''}${dS} tSEQ atoms, -${dY} USDX atoms in the clear`)
  // What the page itself counts, blinded coins included, after its next sync.
  await ev("document.querySelector('[data-tab=balance]').click()")
  let figures = ''
  for (let i = 0; i < 12; i++) {
    await ev("(()=>{const b=document.getElementById('btnSync'); if (b && !b.disabled) b.click()})()")
    await sleep(5000)
    figures = await ev("(()=>{const t=document.querySelector('#app').innerText; const m=(re)=>((t.match(re)||[])[1]||'0'); return 'tSEQ ' + m(/Sequence[^\\n]*\\n\\s*([0-9.,]+)\\s*\\n\\s*tSEQ/) + ', USDX ' + m(/Dollar \\(test\\)\\s*\\n\\s*([0-9.,]+)\\s*\\n\\s*USDX/)})()")
    if (MODE === 'honest' || !/tSEQ 0,/.test(figures)) break
  }
  note(`the page's own figures after the trade: ${figures}`)
  await shot('balance')

  if (MODE === 'blinded-coins') {
    check('refused before anything was sent, saying why', outcome.startsWith('refused') && /held at a blinded address/.test(outcome), outcome)
    check('nothing moved', /tSEQ 0,/.test(figures) && /USDX 1,000$/.test(figures), figures)
  } else if (MODE === 'honest') {
    check('the market order filled', outcome.startsWith('filled'))
    const txid = (outcome.match(/([0-9a-f]{18})…/) || [])[1]
    const blocks = await chain.call('getblockcount')
    const b = await chain.call('getblock', [await chain.call('getblockhash', [blocks]), 2])
    const tx = b.tx.find((t) => txid && t.txid.startsWith(txid)) || b.tx.find((t) => t.vin.length > 1)
    check('the swap is in a block', !!tx, tx ? tx.txid : '')
    if (tx) {
      for (const o of tx.vout) note(`  out ${o.n}: ${o.value != null ? o.value + ' ' + String(o.asset).slice(0, 8) + ' in the clear' : 'blinded'} -> ${o.scriptPubKey.address || o.scriptPubKey.type || 'fee'}`)
      if (EVIDENCE) writeFileSync(join(EVIDENCE, `web-interactive-${tag}-tx.json`), JSON.stringify(tx, null, 1))
      // The swap pays a fresh address of the wallet: the one its receive output (100 tSEQ) pays.
      const atoms = (o) => BigInt(Math.round(o.value * 1e8))
      const rcv = tx.vout.find((o) => o.asset === SEQ && o.value != null && atoms(o) === 100n * COIN)
      const at = rcv && rcv.scriptPubKey.address
      const mine = at ? tx.vout.filter((o) => o.scriptPubKey && o.scriptPubKey.address === at) : []
      if (!TICK) {
        check('the 100 tSEQ are paid in the clear at an unblinded address of the wallet', !!rcv && (await chain.call('getaddressinfo', [at])).iswitness, at || '')
        check('every output paying the wallet is there, in the clear: the tSEQ and the USDX change', mine.length >= 2 && mine.every((o) => o.value != null && o.asset), `${mine.length} outputs`)
        const change = mine.filter((o) => o.asset === Y).reduce((t, o) => t + atoms(o), 0n)
        const paid = 1000n * COIN - change
        check('37 USDX and a fee under 0.01 USDX paid', paid > 37n * COIN && paid < 37n * COIN + COIN / 100n, String(paid))
      } else {
        check('ticked: the output paying the tSEQ is blinded', tx.vout.some((o) => o.value == null) && dS === 0n, String(dS))
      }
    }
    check('the page counts 100 tSEQ', /tSEQ 100,/.test(figures), figures)
    let m1
    for (let i = 0; i < 60; i++) { m1 = await maker.balance(); if ((m1[Y]?.total || 0n) > (m0[Y]?.total || 0n)) break; await sleep(500) }
    const mY = (m1[Y]?.total || 0n) - (m0[Y]?.total || 0n), mS = (m0[SEQ]?.total || 0n) - (m1[SEQ]?.total || 0n)
    note(`the maker's wallet: +${mY} USDX atoms, -${mS} tSEQ atoms`)
    check('the maker got exactly the 37 USDX its offer asks for 100 tSEQ', mY === 37n * COIN)
    check('the maker gave exactly 100 tSEQ', mS === 100n * COIN)
    globalThis.__tx = tx; globalThis.__dS = dS; globalThis.__dY = dY
  } else {
    check(`the ${MODE} maker's swap was not signed: refused in words`, outcome.startsWith('refused') && /signed nothing/.test(outcome), outcome)
    check('nothing moved: no tSEQ received', dS === 0n, String(dS))
    check('nothing moved: no USDX paid', dY === 0n, String(dY))
  }
  if (EVIDENCE) writeFileSync(join(EVIDENCE, `web-interactive-${tag}-backends.log`), be.log.join('\n') + '\n')
} catch (e) {
  failures++; note('FAIL ' + (e && e.stack || e))
  try { if (EVIDENCE && page) await page.screenshot(join(EVIDENCE, `web-interactive-${tag}-failure.png`)) } catch {}
} finally {
  try { if (page) { await page.stop(); page.remove() } } catch {}
  try { await be?.close() } catch {}
  try { await maker?.stop() } catch {}
  try { await chain?.stop() } catch {}
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
note(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
