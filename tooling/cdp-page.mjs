// The smallest DevTools client the browser drives here need: one headless Chromium page,
// navigate, evaluate, wait, screenshot. No dependency: Node's own WebSocket and fetch.
//
// Needs a Chromium: CHROMIUM=/path/to/chrome, or one of the usual places.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

export function chromium () {
  const c = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome')]
  return c.find((p) => p && existsSync(p))
}

// The testnet faucet pays each asset once per wallet, and never refuses our own tooling: a request
// that carries the token the box keeps for it, as `X-Faucet-Exempt`, is neither checked nor
// recorded (sequentia-faucet, "Once per wallet"). A drive reads it from FAUCET_EXEMPT_TOKEN_FILE,
// else ~/.config/sequentia/faucet-exempt.token, and adds it to its pages' requests to the live
// site's /faucet (FAUCET_ORIGIN, https://sequentiatestnet.com unless set) and to nothing else.
// Without it a drive asks the faucet as any tester does.
export function faucetToken (env = process.env) {
  const f = env.FAUCET_EXEMPT_TOKEN_FILE || join(homedir(), '.config/sequentia/faucet-exempt.token')
  try { const t = readFileSync(f, 'utf8').trim(); return t.length >= 32 ? t : null } catch { return null }
}
const FAUCET_ORIGIN = process.env.FAUCET_ORIGIN || 'https://sequentiatestnet.com'

export class Page {
  // `ext`: an unpacked extension's directory, loaded in this browser (Ambra browser beside the
  // page, for drives that use both); without it extensions are off.
  constructor (bin = chromium(), { profile, ext } = {}) {
    if (!bin) throw new Error('no Chromium found: set CHROMIUM')
    this.dir = profile ? null : mkdtempSync(join(tmpdir(), 'wallet-drive-'))
    this.profile = profile || join(this.dir, 'profile')
    this.bin = bin; this.ext = ext
    this.next = 1; this.pending = new Map(); this.errors = []; this.console = []
  }

  async open () {
    const exts = this.ext ? ['--disable-extensions-except=' + this.ext, '--load-extension=' + this.ext] : ['--disable-extensions']
    this.proc = spawn(this.bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', ...exts,
      // A wallet in a tab behind another keeps its timers: no throttling of background pages.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--window-size=1280,1800', '--remote-debugging-port=0', '--user-data-dir=' + this.profile, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] })
    const wsUrl = await new Promise((ok, no) => {
      let buf = ''
      this.proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]) })
      this.proc.on('exit', () => no(new Error('chromium exited')))
      setTimeout(() => no(new Error('chromium did not start')), 20000)
    })
    const port = new URL(wsUrl).port
    this.port = port
    let page
    for (let i = 0; i < 40 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
      if (!page) await new Promise((r) => setTimeout(r, 250))
    }
    if (!page) throw new Error('no page target')
    await this.attach(page.webSocketDebuggerUrl)
  }

  // Another tab of the same browser (the same profile, so the same origin's storage and
  // channels), driven like this one. -> a Page; its stop() closes only the tab.
  async tab (url) {
    const t = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json()
    const p = new Page(this.bin, { profile: this.profile })
    p.port = this.port; p.tabOf = this; p.targetId = t.id
    await p.attach(t.webSocketDebuggerUrl)
    return p
  }

  // A target of this browser that is not a page (an extension's service worker), driven like one:
  // eval, and the faucet token on its requests. `pick(target)` chooses it; waits up to `ms`.
  async target (pick, ms = 60000) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const t = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find(pick)
      if (t) {
        const p = new Page(this.bin, { profile: this.profile })
        p.port = this.port; p.tabOf = this; p.targetId = null; p.url = t.url
        await p.attach(t.webSocketDebuggerUrl)
        return p
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('no such target in ' + ms + ' ms')
  }

  // Every console line of this page from now on, timed and labelled, appended to `file`.
  logTo (file, label) { this.log = file; this.label = label; return this }

  async attach (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    await new Promise((ok, no) => { this.ws.onopen = ok; this.ws.onerror = no })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
      if (m.method === 'Fetch.requestPaused') {
        const q = m.params
        const headers = Object.entries(q.request.headers || {}).filter(([k]) => k.toLowerCase() !== 'x-faucet-exempt').map(([name, value]) => ({ name, value }))
        if (this.faucetToken && q.request.url.startsWith(FAUCET_ORIGIN + '/faucet')) headers.push({ name: 'X-Faucet-Exempt', value: this.faucetToken })
        this.send('Fetch.continueRequest', { requestId: q.requestId, headers }).catch(() => {})
      }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description).join(' ')
        this.console.push(m.params.type + ': ' + text)
        // A long drive keeps the last lines only; `log` (a file) keeps them all, timed.
        if (this.console.length > 2000) this.console.splice(0, 1000)
        if (this.log) try { appendFileSync(this.log, `${new Date().toISOString()} ${this.label || ''} ${m.params.type}: ${text}\n`) } catch {}
        if (m.params.type === 'error') this.errors.push(text)
      }
    }
    await this.send('Runtime.enable')
    // A worker (an extension's service worker) has no Page domain.
    await this.send('Page.enable').catch(() => {})
    this.faucetToken = faucetToken()
    if (this.faucetToken) await this.send('Fetch.enable', { patterns: [{ urlPattern: FAUCET_ORIGIN + '/faucet*', requestStage: 'Request' }] })
  }

  send (method, params = {}) {
    const id = this.next++
    return new Promise((ok, no) => {
      this.pending.set(id, (m) => m.error ? no(new Error(method + ': ' + m.error.message)) : ok(m.result))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('the page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }

  async waitFor (expr, ms = 30000) {
    const until = Date.now() + ms
    let last
    while (Date.now() < until) {
      try { last = await this.eval(expr); if (last) return last } catch (e) { last = e.message }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('waited ' + ms + 'ms for ' + expr + ' (last: ' + JSON.stringify(last) + ')')
  }

  async go (url) { await this.send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 2500)) }

  async screenshot (file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }

  // Ends Chromium and waits for it to exit, so its profile can be removed after.
  async stop () {
    if (this.tabOf) { if (this.targetId) try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`) } catch {} try { this.ws?.close() } catch {} return }
    try { this.ws?.close() } catch {}
    const p = this.proc
    if (!p || p.exitCode !== null || p.signalCode !== null) return
    const gone = new Promise((ok) => p.once('exit', ok))
    try { p.kill() } catch {}
    await Promise.race([gone, new Promise((ok) => setTimeout(ok, 10000))])
  }

  // Removes the temporary profile; call after stop() has resolved.
  remove () { if (this.dir) try { rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {} }
}
