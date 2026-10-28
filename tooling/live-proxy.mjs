#!/usr/bin/env node
// Serves this checkout at /wallet/ in front of the public testnet: every other path (and
// /wallet/pkg/, the kit's wasm build the public page serves) is forwarded to the testnet's own
// origin, so the page as it is in this checkout runs against the live operator, faucet, relay,
// makers and node exactly as the deployed page does, before it is deployed.
//
//   node tooling/live-proxy.mjs [--port 8791] [--origin https://sequentiatestnet.com]
//
// It prints one line, `serving <url>`, once it listens. Nothing here is used by the deployed
// wallet. The browser sees one origin (http://127.0.0.1:<port>), a secure context, so the
// page's worker, its storage and its same-origin calls behave as they do on the public page.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, dirname, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const port = Number(arg('--port', '8791'))
const origin = arg('--origin', 'https://sequentiatestnet.com').replace(/\/+$/, '')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

function local (path) {
  if (!path.startsWith('/wallet/') || path.startsWith('/wallet/pkg/')) return null
  let rel = decodeURIComponent(path.slice('/wallet/'.length)) || 'index.html'
  if (rel.endsWith('/')) rel += 'index.html'
  const f = normalize(join(root, rel))
  if (!f.startsWith(root + '/') || !existsSync(f) || !statSync(f).isFile()) return null
  return f
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/wallet') { res.writeHead(302, { location: '/wallet/' }); res.end(); return }
  const f = local(url.pathname)
  if (f) {
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(f))
    return
  }
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'origin', 'referer', 'accept-encoding', 'content-length'].includes(k)) continue
      headers[k] = v
    }
    const r = await fetch(origin + url.pathname + url.search, { method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' })
    const out = {}
    r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'alt-svc', 'strict-transport-security'].includes(k)) out[k] = v })
    res.writeHead(r.status, out)
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    // A forward that fails after its answer began is cut off; one that failed before says why.
    try { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('live-proxy: ' + (e && e.message)) } catch {}
  }
})
server.listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${server.address().port}/wallet/`))
