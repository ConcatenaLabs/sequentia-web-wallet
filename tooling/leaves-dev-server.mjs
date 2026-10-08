#!/usr/bin/env node
// Serves this checkout, and puts a local operator and its node behind the same origin,
// so the wallet's developer mode can be driven against a regtest operator on this
// machine with nothing else in between:
//
//   /operator/…  -> the operator's server (its /v1/ calls)
//   /node        -> the node's JSON-RPC (the wallet's chain source)
//
// The operator is the one the operator repository's test harness keeps running for a
// browser (bark-cli/tests/arca_operator_for_browsers.rs); this server reads where its
// server and node are from that harness's control address.
//
//   node tooling/leaves-dev-server.mjs [--control 127.0.0.1:18640] [--port 0]
//
// It prints one line, `serving <url>`, once it listens. Nothing here is used by the
// deployed wallet.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const control = arg('--control', process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640')
const port = Number(arg('--port', '0'))

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

async function state () {
  const r = await fetch(`http://${control}/state`)
  if (!r.ok) throw new Error('the operator harness answered ' + r.status)
  return r.json()
}

function body (req) {
  return new Promise((ok, no) => {
    const parts = []
    req.on('data', (d) => parts.push(d))
    req.on('end', () => ok(Buffer.concat(parts)))
    req.on('error', no)
  })
}

async function proxy (req, res, target) {
  const headers = {}
  for (const h of ['content-type', 'authorization']) if (req.headers[h]) headers[h] = req.headers[h]
  const b = req.method === 'GET' ? undefined : await body(req)
  try {
    const r = await fetch(target, { method: req.method, headers, body: b })
    const out = Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' })
    res.end(out)
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('the proxy could not reach ' + target + ': ' + e.message)
  }
}

const srv = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let p = decodeURIComponent(url.pathname)
  try {
    if (p.startsWith('/operator/')) {
      const s = await state()
      return proxy(req, res, s.server.replace(/\/$/, '') + p.slice('/operator'.length) + url.search)
    }
    if (p === '/node' || p === '/node/') {
      const s = await state()
      return proxy(req, res, s.node_url)
    }
  } catch (e) {
    res.writeHead(502); res.end(String(e.message)); return
  }
  if (p.endsWith('/')) p += 'index.html'
  const f = join(root, p)
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
srv.listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${srv.address().port}/`))
