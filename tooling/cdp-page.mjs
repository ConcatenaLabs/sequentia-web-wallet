// The smallest DevTools client the browser drives here need: one headless Chromium page,
// navigate, evaluate, wait, screenshot. No dependency: Node's own WebSocket and fetch.
//
// Needs a Chromium: CHROMIUM=/path/to/chrome, or one of the usual places.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

export function chromium () {
  const c = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome')]
  return c.find((p) => p && existsSync(p))
}

export class Page {
  constructor (bin = chromium(), { profile } = {}) {
    if (!bin) throw new Error('no Chromium found: set CHROMIUM')
    this.dir = profile ? null : mkdtempSync(join(tmpdir(), 'wallet-drive-'))
    this.profile = profile || join(this.dir, 'profile')
    this.bin = bin
    this.next = 1; this.pending = new Map(); this.errors = []; this.console = []
  }

  async open () {
    this.proc = spawn(this.bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
      '--window-size=1280,1800', '--remote-debugging-port=0', '--user-data-dir=' + this.profile, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] })
    const wsUrl = await new Promise((ok, no) => {
      let buf = ''
      this.proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]) })
      this.proc.on('exit', () => no(new Error('chromium exited')))
      setTimeout(() => no(new Error('chromium did not start')), 20000)
    })
    const port = new URL(wsUrl).port
    let page
    for (let i = 0; i < 40 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
      if (!page) await new Promise((r) => setTimeout(r, 250))
    }
    if (!page) throw new Error('no page target')
    this.ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((ok, no) => { this.ws.onopen = ok; this.ws.onerror = no })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description).join(' ')
        this.console.push(m.params.type + ': ' + text)
        if (m.params.type === 'error') this.errors.push(text)
      }
    }
    await this.send('Runtime.enable'); await this.send('Page.enable')
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

  stop () {
    try { this.ws?.close() } catch {}
    try { this.proc?.kill() } catch {}
  }

  remove () { if (this.dir) try { rmSync(this.dir, { recursive: true, force: true }) } catch {} }
}
