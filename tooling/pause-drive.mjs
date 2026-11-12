// The leaf wallet's pause in a real browser: the page's worker (leaves/worker.js) over the library
// in leaves/pkg (or LEAVES_PKG), asked for one 2 s pause, with the site's hold present and absent.
// Prints how long each pause took and the processor time of the browser's busiest thread over it.
//
//   node tooling/pause-drive.mjs <hold-upstream>
//
// <hold-upstream> is a node route's hold (bin/node-rpc-proxy.py in sequentia-testnet-ops, e.g.
// http://127.0.0.1:18942/hold); this drive serves the repository and forwards /node-rpc/hold to
// it, as Caddy does on the site. Exits 1 when a pause is short, or costs 50 ms of processor or more
// with the hold present. Needs a Chromium (CHROMIUM) and Linux's /proc.
import { createServer, request } from 'node:http'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Page } from './cdp-page.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = process.env.LEAVES_PKG ? resolve(process.env.LEAVES_PKG) : join(root, 'leaves', 'pkg')
const upstream = new URL(process.argv[2] || 'http://127.0.0.1:18942/hold')
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' }
let holdOn = true

const HARNESS = `<!doctype html><meta charset="utf-8"><title>pause</title><script type="module">
const w = new Worker('/leaves/worker.js', { type: 'module' })
let n = 1; const waiting = new Map()
w.onmessage = (e) => { const p = waiting.get(e.data.id); if (p) { waiting.delete(e.data.id); p(e.data) } }
const ask = (op, args) => new Promise((ok) => { const id = n++; waiting.set(id, ok); w.postMessage({ id, op, args }) })
w.postMessage({ op: 'pause', args: { url: location.origin + '/node-rpc/hold' } })
window.wait = async (ms) => { const t = performance.now(); const r = await ask('wait', { ms }); return { ok: r.ok, error: r.error, ms: performance.now() - t } }
window.ready = ask('exists', { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }).then(() => true, () => true)
</script>`

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/node-rpc/hold') {
    if (!holdOn) { res.writeHead(404); return res.end('no such path') }
    const r = request(new URL(upstream.pathname + u.search, upstream), { method: 'GET' }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
    r.on('error', () => { res.writeHead(502); res.end() }); return r.end()
  }
  if (u.pathname === '/pause.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS) }
  let f = u.pathname.startsWith('/leaves/pkg/') ? join(pkg, u.pathname.slice('/leaves/pkg/'.length)) : join(root, u.pathname)
  if (!f.startsWith(root) && !f.startsWith(pkg)) { res.writeHead(403); return res.end() }
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}`

// Processor time of every thread of the browser's processes, in ms (schedstat: nanoseconds on a core).
function threads (top) {
  const pids = [top]
  for (const p of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try { const st = readFileSync(`/proc/${p}/stat`, 'utf8'); if (pids.includes(Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]))) pids.push(Number(p)) } catch {}
  }
  const all = {}
  for (const p of pids) {
    try {
      for (const t of readdirSync(`/proc/${p}/task`)) {
        const name = readFileSync(`/proc/${p}/task/${t}/comm`, 'utf8').trim()
        all[`${p}/${t} ${name}`] = Number(readFileSync(`/proc/${p}/task/${t}/schedstat`, 'utf8').split(' ')[0]) / 1e6
      }
    } catch {}
  }
  return all
}

const page = new Page()
await page.open()
let failed = 0
try {
  await page.go(origin + "/pause.html")
  await page.eval('window.ready')
  const pid = page.proc.pid
  for (const [label, on] of [['the hold present', true], ['the hold absent (404)', false]]) {
    holdOn = on
    if (!on) { await page.go(origin + "/pause.html"); await page.eval("window.ready") }  // a fresh worker that has not met a 404 yet
    const before = threads(pid)
    const r = await page.eval('window.wait(2000)')
    const after = threads(pid)
    let top = ['', 0]
    for (const [k, v] of Object.entries(after)) { const d = v - (before[k] || 0); if (d > top[1]) top = [k.replace(/^\d+\/\d+ /, ''), d] }
    const ok = r.ok && r.ms >= 1990 && (on ? top[1] < 50 : true)
    if (!ok) failed++
    console.log(`${ok ? 'ok' : 'FAIL'}: ${label}: the pause took ${r.ms.toFixed(0)} ms; the busiest thread (${top[0]}) used ${top[1].toFixed(1)} ms of processor${r.ok ? '' : ' error: ' + JSON.stringify(r.error)}`)
  }
} finally {
  await page.stop(); server.close()
}
process.exit(failed ? 1 : 0)
