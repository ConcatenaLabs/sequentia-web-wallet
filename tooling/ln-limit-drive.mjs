#!/usr/bin/env node
// Drives the operator's limit on one payment over Lightning, in a headless Chromium, against a
// local regtest operator that publishes it (the operator repository's
// bark-cli/tests/arca_operator_for_browsers.rs, run with ARCA_OPERATOR_LIGHTNING): its info names,
// for its node in the drive's asset, the most one payment may move out of the tree and into it
// (`max_payment`), and the page reads it and holds no share of its own.
//
//  1. a new wallet joins in default mode; a command-line payer pays its receive code;
//  2. Receive at the limit: the receive code carries an invoice; one atom over: no invoice, the
//     code pays the address;
//  3. Send to a code of a wallet elsewhere (an address and an invoice of the operator's peer node)
//     at the limit: the review says it arrives in seconds, and it is paid over Lightning;
//  4. the same one atom over the limit: the page pays the code's address, not Lightning (on this
//     harness the payment to the address is not completed: the page reads addresses with the
//     testnet's parameters and the harness chain is regtest);
//  5. the leaf library asked straight for that payment, and for an invoice one atom over: the
//     operator refuses both, in words.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca node tooling/ln-limit-drive.mjs <evidence-dir>
//
// Needs pkg/ (the lwk_wasm build), leaves/pkg, and a Chromium (CHROMIUM=…).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'
import { clnRpc } from './cln-rpc.mjs'
import { readPayCode, buildPayCode, expandRequest } from '../pay-code.js'
import { btc } from '../btc.js'

const here = dirname(fileURLToPath(import.meta.url))
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640'
const cliBin = process.env.ARCA_CLI
if (!cliBin) { console.error('ARCA_CLI must name the command-line wallet binary'); process.exit(2) }
const out = resolve(process.argv[2] || join(tmpdir(), 'ln-limit-drive-evidence'))
mkdirSync(out, { recursive: true })
const log = join(out, 'drive.log')
writeFileSync(log, '')
const note = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(log, l + '\n') }
const TICKER = 'XCH'
// The peer node keeps every invoice: this run's labels are its own.
const RUN = '-' + Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`)
  return j
}
let failures = 0, step = 0
function check (name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  if (!ok) failures++
}
const work = mkdtempSync(join(tmpdir(), 'ln-limit-drive-'))
const cliDir = join(work, 'cli-payer')
const cli = (...args) => {
  let text
  try { text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { text = e.stdout.toString() }
  return JSON.parse(text)
}
const summarize = (code) => { const c = readPayCode(code) || {}; return { address: c.address, amount: c.amount, lightning: !!c.lightning, sequentia: !!c.sequentia } }

let srv = null
function serve () {
  srv = spawn(process.execPath, [join(here, 'leaves-dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]) }))
}

async function main () {
  const st = await ctl('/state')
  if (!st.lightning) throw new Error('the harness runs without ARCA_OPERATOR_LIGHTNING')
  const X = st.x
  const base = await serve()
  const info = await (await fetch(base + 'operator/v1/info')).json()
  const leg = (info.assets.find((a) => a.asset === X) || {}).lightning || {}
  const S = BigInt(leg.max_payment.send), R = BigInt(leg.max_payment.receive)
  check('the operator publishes its limit on one payment over its node in the asset', leg.state === 'up' && S > 0n && R > 0n,
    { spendable: leg.spendable, receivable: leg.receivable, max_payment: leg.max_payment, payment_limit: leg.payment_limit })
  const peer = clnRpc(st.x_lightning.peer.rpc)

  // 1. The page's wallet, and X for it from the payer.
  cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca')
  await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: Number(S) * 4 })
  // The operator's pool in X: its cap on receives held and not yet claimed is a tenth of it, so a
  // receive at the limit meets that cap only past ten times the limit.
  await ctl('/fund_server', { asset: X, amount: Number(R) * 20 })
  await ctl('/produce')
  cli('board', X, String(S * 3n + 2_000_000n))
  await ctl('/produce'); await ctl('/bury')
  for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await sleep(500)
  cli('sync')
  const page = new Page(undefined, { profile: join(work, 'profile') })
  const ev = (js) => page.eval(js)
  const click = (sel) => ev(`(()=>{ const b=document.querySelector(${JSON.stringify(sel)}); if(!b) throw new Error('no ${sel}'); b.click(); return true })()`)
  const tab = (t) => click(`#tabs button[data-tab="${t}"]`)
  const shot = async (what) => { step++; const f = join(out, `${String(step).padStart(2, '0')}-${what}.png`); await page.screenshot(f); note(`     screenshot ${f.split('/').pop()}`) }
  await page.open()
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*sequentiatestnet.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.SEQ_LEAVES_TICK_MS=3000; window.SEQ_TEST_HOOKS=true;
    window.SEQ_ARCA = { server: location.origin + '/operator', node_url: location.origin + '/node', operator: ${JSON.stringify(info.operator)} };
    window.SEQ_BTC_ARK = null;
    for (const k of ['SEQ_LSP_URL', 'SEQ_LSP_TOKEN', 'SEQ_LSP_WS_ASSET', 'SEQ_LSP_HOST_PUBKEY_ASSET', 'SEQ_LSP_WS_BTC', 'SEQ_LSP_HOST_PUBKEY_BTC'])
      Object.defineProperty(window, k, { value: k === 'SEQ_LSP_URL' ? location.origin + '/lsp' : undefined, writable: false, configurable: false })` })
  await page.go(base)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 120000)
  await click('#btnCreate')
  await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await click('#btnConfirm')
  await page.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 120000)
  await ev(`localStorage.setItem('swk.sequentia.assets', JSON.stringify({ ${JSON.stringify(X)}: { ticker: '${TICKER}', name: 'Drive asset', precision: 0, local: true } }))`)
  await tab('receive')
  const code0 = await page.waitFor("(()=>{ const a=document.querySelector('#addr'); return a && a.classList.contains('recv-code') && /^bitcoin:/i.test(a.textContent) ? a.textContent : false })()", 240000)
  const seq = decodeURIComponent((code0.split('?')[1] || '').split('&').find((p) => /^sequentia=/i.test(p)).slice('sequentia='.length))
  const full = expandRequest(seq.toLowerCase().startsWith('sqr1') ? seq.toLowerCase() : seq, { operator: info.operator, genesis_hash: st.genesis_hash }) || seq
  const paid = cli('send', full, '--asset', X, '--amount', String(S * 3n))
  check('the payer paid the page\'s receive code', !paid.error, paid.error || paid.route)
  const figure = async () => {
    const t = await ev(`(()=>{ const r=[...document.querySelectorAll('.bt-row')].find(x=>x.querySelector('.tk') && x.querySelector('.tk').textContent.trim()===${JSON.stringify(TICKER)}); return r ? (r.querySelector('.bt-t')||{}).innerText||'' : '' })()`)
    const m = String(t).replace(/^Total\s*/, '').replace(/[,\s]/g, '').match(/\d+/)
    return m ? BigInt(m[0]) : 0n
  }
  await tab('balance')
  let fig = 0n
  for (let i = 0; i < 180 && fig < S * 3n - 100_000n; i++) { await sleep(1000); fig = await figure() }
  check('the page holds what it was paid', fig >= S * 3n - 100_000n, String(fig))
  await tab('balance'); await sleep(1500); await shot('balance')

  // 2. Receive: an invoice at the limit, none one atom over.
  await tab('receive')
  const recv = async (atoms) => {
    await ev(`(()=>{ const s=document.querySelector('#recvAsset'); const o=[...s.options].find(o=>o.textContent.trim()===${JSON.stringify(TICKER)}); s.value=o.value; s.dispatchEvent(new Event('change')); const i=document.querySelector('#recvAmt'); i.value=${JSON.stringify(String(atoms))}; i.dispatchEvent(new Event('input')); return true })()`)
    let last = null, since = Date.now()
    for (const until = Date.now() + 120000; Date.now() < until;) {
      const now = await ev("document.querySelector('#addr').textContent")
      if (now !== last) { last = now; since = Date.now() } else if (Date.now() - since >= 8000 && /^bitcoin:/i.test(now)) break
      await sleep(1000)
    }
    return last
  }
  const atR = await recv(R)
  check(`Receive ${R} (the operator's limit into the tree): the code carries an invoice`, summarize(atR).lightning,
    { code: summarize(atR), console: page.console.filter((l) => /receive code/.test(l)).slice(-3) })
  await shot('receive-at-limit')
  const overR = await recv(R + 1n)
  check(`Receive ${R + 1n} (one atom over): no invoice, the code pays the address`, !summarize(overR).lightning && !!summarize(overR).address, summarize(overR))
  await shot('receive-over-limit')

  // 3 and 4. Send to a wallet elsewhere: an address, and an invoice of the operator's peer node.
  // An address of a wallet elsewhere (the command-line payer's), as the page spells it: the harness
  // chain prints bcrt1, the page's testnet parameters tb1, for the same script.
  const destSpk = cli('address').script_pubkey
  const dest = btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(Buffer.from(destSpk, 'hex')))
  const sendTo = async (atoms, label) => {
    const inv = await peer('invoice', { amount_msat: (atoms * 1000n).toString(), label: label + RUN, description: label, asset: X })
    const code = buildPayCode({ address: dest, lightning: inv.bolt11 })
    await tab('send')
    await page.waitFor(`[...document.querySelectorAll('#recipients .rec .rasset option')].some(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(TICKER)})`, 120000)
    await ev(`(()=>{ const r=document.querySelector('#recipients .rec'); r.querySelector('.raddr').value=${JSON.stringify(code)}; r.querySelector('.raddr').dispatchEvent(new Event('input'));
      const s=r.querySelector('.rasset'); const o=[...s.options].find(o=>o.textContent.trim().split(/\\s/)[0]===${JSON.stringify(TICKER)}); s.value=o.value; s.dispatchEvent(new Event('change'));
      r.querySelector('.ramt').value=${JSON.stringify(String(atoms))}; r.querySelector('.ramt').dispatchEvent(new Event('input')); return true })()`)
    await sleep(1500)
    await click('#btnReview')
    const review = await page.waitFor("(()=>{ const m=document.querySelector('.modal'); if(m && m.innerText.trim()) return m.innerText; const e=document.querySelector('#sendErr')?.textContent; return e ? 'ERR '+e : false })()", 120000)
    await shot(label + '-review')
    if (/^ERR/.test(review)) return { inv, review: review.replace(/\s+/g, ' '), console: page.console.filter((l) => /offboard|leaves|route/i.test(l)).slice(-5) }
    await ev("(()=>{ document.querySelector('.modal button.primary').click(); return true })()")
    return { inv, review: review.replace(/\s+/g, ' ') }
  }
  const at = await sendTo(S, 'send-at-limit')
  check(`Send ${S} (the operator's limit out of the tree): the review says it arrives in seconds`, /arrives in seconds/i.test(at.review) && !/address/i.test(at.review), at.review)
  let st1 = null
  for (let i = 0; i < 120; i++) { st1 = (await peer('listinvoices', { label: 'send-at-limit' + RUN })).invoices[0]; if (st1.status === 'paid') break; await sleep(1000) }
  check('paid over Lightning: the peer\'s invoice is paid in full', st1.status === 'paid' && BigInt(st1.amount_received_msat) === S * 1000n, { status: st1.status, received_msat: st1.amount_received_msat })
  await page.waitFor("(()=>{ const st=document.querySelector('.modal .status'); const t=st?st.textContent:''; return t && !/Sending/.test(t) ? t : false })()", 120000).then((t) => note('     the page said: ' + t)).catch(() => {})
  await shot('send-at-limit-done')
  await ev("(()=>{ for(const m of document.querySelectorAll('.modal')) m.remove(); return true })()")

  const over = await sendTo(S + 1n, 'send-over-limit')
  // The address route: the review offers the address, or (on this harness) the page asked the
  // library for the payment to the address and the library refused the address's spelling: the
  // page reads addresses with the testnet's parameters (tb1), and the harness chain is regtest
  // (bcrt1), so a payment to an address is not completed here.
  const toAddress = /address/i.test(over.review) && !/^ERR/.test(over.review)
  const askedAddress = /^ERR/.test(over.review) && (over.console || []).some((l) => /\[offboard\] quote/.test(l) && l.includes(dest))
  check(`Send ${S + 1n} (one atom over): the page pays the address, not Lightning`, toAddress || askedAddress,
    { review: over.review, console: (over.console || []).filter((l) => /offboard/.test(l)) })
  if (askedAddress) note('     the payment to the address is not completed on this harness (tb1 on the page, bcrt1 on its chain): not run')
  if (toAddress) {
    await sleep(5000)
    for (let i = 0; i < 6; i++) { const r = await ctl('/round'); note('     round: ' + JSON.stringify(r)); await sleep(4000) }
    const scan = await ctl('/rpc', { method: 'scantxoutset', params: ['start', [`raw(${destSpk})`]] })
    const there = (scan.unspents || []).filter((u) => u.asset === X).reduce((a, u) => a + BigInt(Math.round(Number(u.amount) * 1e8)), 0n)
    check(`paid on the chain: the address holds ${S + 1n} of the asset`, there === S + 1n, String(there))
  }
  const peerOver = (await peer('listinvoices', { label: 'send-over-limit' + RUN })).invoices[0]
  check('nothing went over Lightning for it', peerOver.status !== 'paid', peerOver.status)
  await ev("(()=>{ for(const m of document.querySelectorAll('.modal')) m.remove(); return true })()")

  // 5. Asked straight of the leaf library: the operator refuses both, in words.
  // The node's capacity moved with the payments above: the limit as the operator publishes it now.
  const now = ((await (await fetch(base + 'operator/v1/info')).json()).assets.find((a) => a.asset === X) || {}).lightning.max_payment
  const S2 = BigInt(now.send), R2 = BigInt(now.receive)
  note(`     the operator's limit now: ${JSON.stringify(now)}`)
  const inv2 = await peer('invoice', { amount_msat: ((S2 + 1n) * 1000n).toString(), label: 'forced-over' + RUN, description: 'forced', asset: X })
  const forcedPay = await ev(`window.__leavesApi.command('lightning_pay', { invoice: ${JSON.stringify(inv2.bolt11)}, asset: ${JSON.stringify(X)} }).then(r=>'PAID '+JSON.stringify(r), e=>'REFUSED '+(e && (e.message || e.reason) || e))`)
  check('lightning_pay one atom over, asked of the library: the operator refuses it', /^REFUSED/.test(forcedPay) && /above the most one payment over Lightning may move out of the tree/.test(forcedPay), forcedPay)
  const forcedRecv = await ev(`window.__leavesApi.command('lightning_receive', { asset: ${JSON.stringify(X)}, amount: ${JSON.stringify(String(R2 + 1n))}, description: 'forced' }).then(r=>'MADE '+JSON.stringify(r).slice(0, 80), e=>'REFUSED '+(e && (e.message || e.reason) || e))`)
  check('lightning_receive one atom over, asked of the library: no invoice', /^REFUSED/.test(forcedRecv) && /above the most/.test(forcedRecv), forcedRecv)
  await page.stop()
}

main().then(() => { note(failures ? `${failures} check(s) FAILED` : 'every check passed'); srv && srv.kill(); process.exit(failures ? 1 : 0) },
  (e) => { note('the drive stopped: ' + (e && e.stack || e)); srv && srv.kill(); process.exit(1) })
