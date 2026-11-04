#!/usr/bin/env node
// The faucet card, once per wallet, in the wallet itself: serve this checkout with a real
// sequentia-faucet behind /faucet (its node CLI a stand-in, so no coins move, its ledger in a
// fresh directory, each request forwarded as the site's front door does), open index.html in a
// headless Chromium, and check that the wallet sends its id, that a button whose asset the wallet
// has received says so and is off, after a reload too, that a refusal is the faucet's own
// sentence, and that another wallet is paid. No chain is needed.
//
//   FAUCET_DIR=/path/to/sequentia-faucet node tooling/faucet-once-probe.mjs [screenshot.png]
//
// Needs pkg/ (the lwk_wasm build), a checkout of sequentia-faucet with `npm ci` run in it, and a
// Chromium (CHROMIUM=…).
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ID0 = '0dc441add97a52d9e9f9254c6d6a7aaf530c1cca887a08d9b188cb3a6b196803'   // faucet-wallet.test.mjs
const FAUCET_DIR = process.env.FAUCET_DIR
if (!FAUCET_DIR || !existsSync(join(FAUCET_DIR, 'server.js'))) { console.error('FAUCET_DIR must name a sequentia-faucet checkout'); process.exit(2) }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'faucet-once-probe-'))
const cli = join(work, 'cli')
writeFileSync(cli, '#!/bin/sh\ncase "$*" in *getbalance*) echo 0; exit 0;; esac\necho ' + 'cd'.repeat(32) + '\n', { mode: 0o755 })
const fport = await new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const faucet = spawn(process.execPath, [join(FAUCET_DIR, 'server.js')], {
  env: { PATH: process.env.PATH, FAUCET_PORT: String(fport), FAUCET_CLI: cli, FAUCET_DATADIR: '/nowhere', FAUCET_LEDGER: join(work, 'claims.jsonl') },
  stdio: ['ignore', 'pipe', 'inherit']
})
await new Promise((ok, no) => { faucet.stdout.on('data', (d) => { if (String(d).includes('listening')) ok() }); faucet.once('exit', (c) => no(new Error('the faucet exited ' + c))) })

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
const posted = []
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/faucet' || u.pathname.startsWith('/faucet/')) {
    // The front door: strip /faucet, and forward the client's address.
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method === 'POST') { try { posted.push(JSON.parse(body)) } catch {} }
      const up = httpRequest({ host: '127.0.0.1', port: fport, method: req.method, path: (u.pathname.slice(7) || '/') + u.search,
        headers: { 'content-type': req.headers['content-type'] || 'application/json', 'x-forwarded-for': '198.51.100.' + (posted.length + 1) } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
      up.on('error', (e) => { res.writeHead(502); res.end(e.message) })
      up.end(body)
    })
    return
  }
  let p = decodeURIComponent(u.pathname)
  if (p.endsWith('/')) p += 'index.html'
  const f = join(root, p)
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
const url = await new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}/`)))
let failures = 0
const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) failures++ }
const page = new Page()
const button = (a) => page.eval(`(()=>{const b=document.querySelector('#faucetBtns button[data-faucet="${a}"]'); return b ? { text: b.textContent, off: b.disabled } : null})()`)
const status = () => page.eval("document.getElementById('faucetStatus').textContent")
const appUp = "document.querySelector('#app') && document.querySelector('#app').offsetParent !== null"
try {
  await page.open()
  await page.go(url)
  await page.waitFor("document.querySelector('#btnImport') && document.querySelector('#btnImport').offsetParent !== null", 40000)
  await page.eval("document.querySelector('#btnImport').click()")
  await page.eval(`document.getElementById('importPhrase').value=${JSON.stringify(PHRASE)}; document.getElementById('btnDoImport').click()`)
  await page.waitFor(appUp, 40000)
  ok(/once per wallet/.test(await page.eval("document.querySelector('#faucetBtns').parentElement.innerText")), 'the card says the faucet pays each asset once per wallet')
  ok(JSON.stringify(await button('USDX')) === JSON.stringify({ text: 'USDX', off: false }), 'a fresh wallet: USDX is offered')

  await page.eval("document.querySelector('#faucetBtns button[data-faucet=\"USDX\"]').click()")
  await page.waitFor("/Sent|error|already/i.test(document.getElementById('faucetStatus').textContent)", 20000)
  ok(/^Sent 500,000 USDX/.test(await status()), 'USDX is paid: ' + (await status()))
  ok(posted.length === 1 && posted[0].wallet === ID0 && posted[0].asset === 'USDX', 'the request carries the wallet\'s id: ' + JSON.stringify(posted[0]))
  ok(JSON.stringify(await button('USDX')) === JSON.stringify({ text: 'USDX received', off: true }), 'USDX now reads "USDX received" and is off: ' + JSON.stringify(await button('USDX')))
  ok(JSON.stringify(await button('EURX')) === JSON.stringify({ text: 'EURX', off: false }), 'EURX is still offered')
  if (process.argv[2]) await page.screenshot(process.argv[2])

  // A reload reads what the wallet has received from the faucet, without asking for a payout.
  await page.go(url)
  await page.waitFor(appUp, 40000)
  await page.waitFor("document.querySelector('#faucetBtns button[data-faucet=\"USDX\"]').disabled", 15000).catch(() => {})
  ok(JSON.stringify(await button('USDX')) === JSON.stringify({ text: 'USDX received', off: true }), 'after a reload: "USDX received", off')
  ok(posted.length === 1, 'the reload asked for no payout')

  // Should the wallet ask again (the button forced on), the faucet's own sentence is what it shows.
  await page.eval("(()=>{const b=document.querySelector('#faucetBtns button[data-faucet=\"USDX\"]'); b.disabled=false; b.click()})()")
  await page.waitFor("/already/i.test(document.getElementById('faucetStatus').textContent)", 20000).catch(() => {})
  ok(await status() === 'This wallet has already received its USDX from the faucet. The faucet pays each asset once per wallet. To get more, trade for it in the wallet.', 'a second request is refused in plain words: ' + (await status()))
  ok(posted.length === 2 && posted[1].wallet === ID0, 'it was one request, with the id')

  // Another wallet is paid.
  await page.eval("localStorage.clear()")
  await page.go(url)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 40000)
  await page.eval("document.querySelector('#btnCreate').click()")
  await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await page.eval("document.querySelector('#btnConfirm').click()")
  await page.waitFor(appUp, 40000)
  ok(JSON.stringify(await button('USDX')) === JSON.stringify({ text: 'USDX', off: false }), 'another wallet: USDX is offered')
  await page.eval("document.querySelector('#faucetBtns button[data-faucet=\"USDX\"]').click()")
  await page.waitFor("/Sent|error|already/i.test(document.getElementById('faucetStatus').textContent)", 20000)
  ok(/^Sent 500,000 USDX/.test(await status()) && /^[0-9a-f]{64}$/.test(posted[2].wallet) && posted[2].wallet !== ID0, 'and paid, under its own id: ' + (await status()))
  const errs = page.errors.filter((e) => !/Failed to load resource|404|NetworkError|Failed to fetch|fetch|esplora|websocket/i.test(e))
  ok(errs.length === 0, 'no page errors but the backends\' absence' + (errs.length ? ': ' + errs.slice(0, 5).join(' | ') : ''))
} catch (e) { ok(false, 'the probe stopped: ' + (e.stack || e)) } finally {
  await page.stop(); if (page.dir) rmSync(page.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  srv.close(); faucet.kill(); rmSync(work, { recursive: true, force: true })
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
