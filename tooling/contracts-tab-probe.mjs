#!/usr/bin/env node
// The Contracts tab in the wallet itself: serve this checkout, open index.html in a
// headless Chromium, create a wallet, and check that the tab is hidden with developer
// mode off, shown with it on, and that it reads a template the kit carries and shows
// this wallet's contract key. No chain is needed (the page's backends answer 404 here);
// tooling/contracts-regtest.mjs spends on a chain.
//
//   node tooling/contracts-tab-probe.mjs [screenshot.png]
//
// Needs pkg/ built from SWK with the contract engine, and a Chromium (CHROMIUM=…).
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
const srv = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p.endsWith('/')) p += 'index.html'
  const f = join(root, p)
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
const url = await new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}/`)))
let failures = 0
const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) failures++ }
const page = new Page()
try {
  await page.open()
  await page.go(url)
  await page.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 40000)
  await page.eval("document.querySelector('#btnCreate').click()")
  await page.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
  await page.eval("document.querySelector('#btnConfirm').click()")
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 40000)
  ok(await page.eval("document.getElementById('tabContracts').classList.contains('hide')"), 'developer mode off: no Contracts tab')
  // Developer mode on, as the Settings switch sets it; then the page again.
  await page.eval("localStorage.setItem('swk.devMode','1')")
  await page.go(url)
  await page.waitFor("document.querySelector('#app') && document.querySelector('#app').offsetParent !== null", 40000)
  ok(!(await page.eval("document.getElementById('tabContracts').classList.contains('hide')")), 'developer mode on: the Contracts tab shows')
  await page.eval("document.getElementById('tabContracts').click()")
  const options = await page.eval("[...document.querySelectorAll('#contractTemplate option')].map(o=>o.textContent)")
  ok(options.length === 3 && options[2].startsWith('sequentia/faucet-drip v1'), 'the wallet lists the kit\'s templates: ' + options.join('; '))
  await page.eval("(()=>{const s=document.getElementById('contractTemplate'); s.value=s.options[2].value; document.getElementById('contractUseTemplate').click()})()")
  await page.waitFor("document.getElementById('contractTemplateOut').innerText.length > 0")
  const out = await page.eval("document.getElementById('contractTemplateOut').innerText")
  const key = (out.match(/contract key \(m\/8383h\/1h\/0h\/0\/0\): ([0-9a-f]{64})/) || [])[1]
  ok(out.includes('sequentia/faucet-drip v1') && !!key, 'it reads the template and shows this wallet\'s contract key ' + key)
  if (process.argv[2]) await page.screenshot(process.argv[2])
  const errs = page.errors.filter((e) => !/Failed to load resource|404|NetworkError|Failed to fetch|fetch/i.test(e))
  ok(errs.length === 0, 'no page errors but the backends\' absence' + (errs.length ? ': ' + errs.join(' | ') : ''))
} catch (e) { ok(false, 'the probe stopped: ' + (e.stack || e)) } finally {
  await page.stop(); if (page.dir) rmSync(page.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); srv.close()
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
