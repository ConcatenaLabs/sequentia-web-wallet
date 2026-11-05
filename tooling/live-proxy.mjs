#!/usr/bin/env node
// Serves this checkout at /wallet/ in front of the public testnet: every other path (and
// /wallet/pkg/, the kit's wasm build the public page serves) is forwarded to the testnet's own
// origin, so the page as it is in this checkout runs against the live operator, faucet, relay,
// makers and node exactly as the deployed page does, before it is deployed.
//
//   node tooling/live-proxy.mjs [--port 8791] [--origin https://sequentiatestnet.com]
//                               [--seqob-market http://127.0.0.1:19955] [--dex ../seqdex-web]
//
// --seqob-market sends the relay's market data (/seqob/v1/trades…, and each market's trades,
// candles and ticker) to a relay of your own instead, the book and everything else still to the
// testnet: how a relay change to the market view is seen on the page before it is deployed.
//
// --dex serves a checkout of the SeqDEX site (seqdex-web) at /dex/ on the same origin, as the
// testnet serves both: how the site and this page talk over their channel is seen before either
// is deployed (tooling/seqdex-bridge-drive.mjs).
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
// --log: one line per forwarded call (method, path, status, time, and the JSON-RPC method).
//
// --refuse <path prefix> (repeatable): a call whose path starts with the prefix gets no answer:
// its connection is closed unanswered, as a server that is gone closes it. `--refuse /arca`
// stands for the page's operator gone while the node, the page and everything else still
// answer, for an exit drill (default-mode-live-drive.mjs `exit`). Each refused call prints one
// line. --refuse-status 502 answers such a call with that status instead, as a front server does
// when the service behind it is down.
// --refuse-while <file>: the --refuse prefixes are refused only while that file exists, so a drive
// takes the operator away and brings it back mid-session (touch the file, then remove it), as a
// restart of the operator does.
//
// --strip-capacity: the operator's info (/arca/v1/info) is passed on without the capacity of its
// Lightning nodes or its limit on one payment over them (each node's `spendable`, `receivable`,
// `max_payment` and `payment_limit`), as an operator that publishes none answers: how the page's
// fallback for an unknown limit (SEQ_LN_FALLBACK_USD) is seen live.
//
// --cors: every answer allows any origin, and a preflight is answered here, so a wallet on
// another origin (a browser extension joined to http://127.0.0.1:<port>/arca with the node at
// /node-rpc) reaches the testnet through this proxy, and through its --refuse.
const logCalls = process.argv.includes('--log')
const seqobMarket = (arg('--seqob-market', '') || '').replace(/\/+$/, '')
const dex = arg('--dex', '') ? resolve(arg('--dex', '')) : null
const cors = process.argv.includes('--cors')
const stripCapacity = process.argv.includes('--strip-capacity')
// The info with no node's capacity in it; anything that is not that JSON passes as it came.
function withoutCapacity (buf) {
  try {
    const j = JSON.parse(buf.toString())
    const si = j.server_info || j
    const strip = (n) => { if (n && typeof n === 'object') { delete n.spendable; delete n.receivable; delete n.max_payment; delete n.payment_limit } }
    for (const a of si.assets || []) strip(a && a.lightning)
    strip(si.lightning && si.lightning.bitcoin && si.lightning.bitcoin.node)
    return Buffer.from(JSON.stringify(j))
  } catch { return buf }
}
const refuseStatus = Number(arg('--refuse-status', '0'))
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization' }
const refused = process.argv.flatMap((a, i) => a === '--refuse' && process.argv[i + 1] ? [process.argv[i + 1]] : [])
const refuseWhile = arg('--refuse-while', '')
const MARKET_DATA = /^\/seqob\/v1\/(trades(\/.*)?|market\/[^/]+\/[^/]+\/(trades|candles|ticker))$/
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

function local (path) {
  if (dex && path.startsWith('/dex/')) {
    let rel = decodeURIComponent(path.slice('/dex/'.length)) || 'index.html'
    if (rel.endsWith('/')) rel += 'index.html'
    const f = normalize(join(dex, rel))
    return f.startsWith(dex + '/') && existsSync(f) && statSync(f).isFile() ? f : null
  }
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
  if (dex && url.pathname === '/dex') { res.writeHead(302, { location: '/dex/' }); res.end(); return }
  if ((!refuseWhile || existsSync(refuseWhile)) && refused.some((p) => url.pathname === p || url.pathname.startsWith(p.replace(/\/+$/, '') + '/'))) {
    console.log(`${new Date().toISOString()} refused ${req.method} ${url.pathname}`)
    if (refuseStatus) { res.writeHead(refuseStatus, { 'content-type': 'text/plain', ...(cors ? CORS : {}) }); res.end('Bad Gateway'); return }
    req.socket.destroy()
    return
  }
  if (cors && req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
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
    const t0 = Date.now()
    const to = seqobMarket && MARKET_DATA.test(url.pathname) ? seqobMarket + url.pathname.slice('/seqob'.length) : origin + url.pathname
    const r = await fetch(to + url.search, { method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' })
    const out = {}
    r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'alt-svc', 'strict-transport-security'].includes(k)) out[k] = v })
    res.writeHead(r.status, cors ? { ...out, ...CORS } : out)
    const body = Buffer.from(await r.arrayBuffer())
    res.end(stripCapacity && r.ok && /^\/arca\/v1\/info$/.test(url.pathname) ? withoutCapacity(body) : body)
    if (logCalls) {
      let m = ''; try { const j = JSON.parse(Buffer.concat(chunks).toString()); m = Array.isArray(j) ? j.map((x) => x.method).join(',') : (j.method || '') + (j.method === 'getblockhash' ? ' ' + JSON.stringify(j.params) : '') } catch {}
      console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${r.status} ${Date.now() - t0}ms ${m}`.slice(0, 300))
    }
  } catch (e) {
    // A forward that fails after its answer began is cut off; one that failed before says why.
    try { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('live-proxy: ' + (e && e.message)) } catch {}
  }
})
server.listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${server.address().port}/wallet/` +
  (refused.length ? `, refusing ${refused.join(', ')}` : '') + (stripCapacity ? ', the operator\'s capacity left out' : '')))
