#!/usr/bin/env node
// Prove the Sign tab's staking-key mode from the outside: open the wallet in a
// headless Chromium, create a wallet, sign a message with the staking key, and
// recover a public key from the signature the way any verifier (a node's
// verifymessage, Levo's sign-in) does. It has to be the staking key the tab
// shows, or a site that reads stake would credit the wrong key.
//
//   node tooling/sign-tab-probe.mjs                # serves this checkout itself
//   node tooling/sign-tab-probe.mjs https://sequentiatestnet.com/wallet/
//
// Needs a Chromium: CHROMIUM=/path/to/chrome, or one of the usual places.
// The checkout needs pkg/ (the lwk_wasm build) when it serves itself.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { secp256k1, sha256 } from '../btc.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function chromium() {
  const c = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome')]
  return c.find((p) => p && existsSync(p))
}

// A static server for the checkout, so the probe runs with no other process.
function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p.endsWith('/')) p += 'index.html'
    const f = join(root, p)
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  })
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/` })))
}

// The Bitcoin signed-message digest: sha256d(varstr(magic) || varstr(message)).
function varstr(b) {
  const n = b.length
  const len = n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, n >> 8] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
  return new Uint8Array([...len, ...b])
}
function messageHash(text) {
  const enc = new TextEncoder()
  const payload = new Uint8Array([...varstr(enc.encode('Bitcoin Signed Message:\n')), ...varstr(enc.encode(text))])
  return sha256(sha256(payload))
}
function recover(text, sigB64) {
  const sig = Uint8Array.from(Buffer.from(sigB64, 'base64'))
  if (sig.length !== 65) throw new Error('a recoverable signature is 65 bytes; this one is ' + sig.length)
  const header = sig[0]
  if (header < 27 || header > 34) throw new Error('header byte ' + header + ' is not one a message signature has')
  const rec = (header - 27) & 3
  const s = secp256k1.Signature.fromBytes(sig.slice(1)).addRecoveryBit(rec)
  const point = s.recoverPublicKey(messageHash(text))
  const bytes = point.toBytes ? point.toBytes(true) : point.toRawBytes(true)
  return Buffer.from(bytes).toString('hex')
}

// The smallest DevTools client this needs: one page, evaluate, wait.
class Page {
  constructor(bin) {
    this.dir = mkdtempSync(join(tmpdir(), 'wallet-probe-'))
    this.proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
      '--window-size=1280,1600', '--remote-debugging-port=0', '--user-data-dir=' + join(this.dir, 'profile'), 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    this.next = 1; this.pending = new Map(); this.errors = []
  }
  async open() {
    const wsUrl = await new Promise((ok, no) => {
      let buf = ''
      this.proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]) })
      this.proc.on('exit', () => no(new Error('chromium exited')))
      setTimeout(() => no(new Error('chromium did not start')), 20000)
    })
    const port = new URL(wsUrl).port
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    const page = targets.find((t) => t.type === 'page')
    this.ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((ok, no) => { this.ws.onopen = ok; this.ws.onerror = no })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text)
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(m.params.args.map((a) => a.value || a.description).join(' '))
    }
    await this.send('Runtime.enable'); await this.send('Page.enable')
  }
  send(method, params = {}) {
    const id = this.next++
    return new Promise((ok, no) => { this.pending.set(id, (m) => m.error ? no(new Error(m.error.message)) : ok(m.result)); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('the page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  async waitFor(expr, ms = 30000) {
    const until = Date.now() + ms
    while (Date.now() < until) { if (await this.eval(expr)) return; await new Promise((r) => setTimeout(r, 250)) }
    throw new Error('waited ' + ms + 'ms for ' + expr)
  }
  async go(url) { await this.send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 2500)) }
  stop() { try { this.ws?.close() } catch {} this.proc.kill() }
}

async function main() {
  const bin = chromium()
  if (!bin) { console.error('no chromium found; set CHROMIUM=/path/to/chrome'); return 2 }
  let base = process.argv[2], srv
  if (!base) { ({ srv, url: base } = await serve()) }
  const page = new Page(bin)
  const failed = []
  try {
    await page.open()
    await page.go(base)
    await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 40000)
    await page.eval("document.querySelector('#btnCreate').click()")
    await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await page.eval("document.querySelector('#btnConfirm').click()")
    await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 40000)
    await page.eval("document.querySelector('[data-tab=\"sign\"]').click()")
    await page.eval("const s=document.querySelector('#oampSignMode'); s.value='staker'; s.dispatchEvent(new Event('change'))")
    const message = 'Sign in to a launchpad\nnonce: 0123456789abcdef\nThis authorises no payment.'
    await page.eval(`const t=document.querySelector('#oampSignChallenge'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, ${JSON.stringify(message)}); t.dispatchEvent(new Event('input',{bubbles:true}))`)
    await page.eval("document.querySelector('#oampSignBtn').click()")
    await page.waitFor("document.querySelector('#oampSignSig').textContent.length > 20 || document.querySelector('#oampSignErr').textContent.length > 0")
    const err = await page.eval("document.querySelector('#oampSignErr').textContent")
    if (err) failed.push('the tab refused: ' + err)
    const sig = await page.eval("document.querySelector('#oampSignSig').textContent")
    const shown = await page.eval("document.querySelector('#oampSignPubkey').textContent")
    const staker = await page.eval("signer && signer.stakerPublicKey ? signer.stakerPublicKey() : ''").catch(() => '')
    const hidden = await page.eval("document.querySelector('#oampSignAidRow').classList.contains('hide')")
    let recovered = ''
    try { recovered = recover(message, sig) } catch (e) { failed.push('the signature does not read as a message signature: ' + e.message) }
    if (recovered && recovered !== shown) failed.push(`the signature recovers to ${recovered.slice(0, 12)}…, the tab shows ${shown.slice(0, 12)}…`)
    if (staker && staker !== shown) failed.push('the key the tab shows is not the staking key')
    if (!hidden) failed.push('the OpenAMP account id is shown for a staking-key signature')
    if (page.errors.length) failed.push('console errors: ' + page.errors.slice(0, 2).join(' | '))
    console.log(`staking key ${shown.slice(0, 16)}… signs; a verifier recovers ${recovered ? recovered.slice(0, 16) + '…' : 'nothing'}`)
  } catch (e) {
    failed.push(e.message)
  } finally {
    page.stop(); srv?.close()
  }
  for (const f of failed) console.log('FAIL', f)
  console.log(`${failed.length ? 'not ok' : 'ok'}: the Sign tab's staking-key signature is the staking key's`)
  return failed.length ? 1 : 0
}
process.exit(await main())
